const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { JSONProcess } = require('./codex-analysis');
const execute = promisify(execFile);
const fail = (message, code = 'analysis_provider') => Object.assign(new Error(message), { code });
const REQUIREMENT = 'anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"';
async function locateClaude({ executable, verifySignature = true, execFileImpl = execute } = {}) {
  const candidates = executable ? [executable] : [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const candidate of candidates) {
    let file;
    try { file = await fs.realpath(candidate); await fs.access(file, 1); } catch { continue; }
    if (verifySignature) {
      try { await execFileImpl('/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + REQUIREMENT, file], { timeout: 10000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } }); }
      catch { throw fail('Claude Code signature could not be verified. Install its official native CLI.'); }
    }
    return file;
  }
  throw fail('Install the official Claude Code native CLI to use this connector.');
}
function claudeArguments(model, systemFile) {
  return ['--safe-mode', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--setting-sources=', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--disallowedTools', '*', '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk',
    '--model', model, '--system-prompt-file', systemFile, '--max-turns', '1'];
}
async function generateClaude({ config, system, prompt, images = [], key, signal, timeoutMs = 180000,
  executable, verifySignature = true, execFileImpl = execute, spawnImpl = spawn }) {
  if (!['api-key', 'claude-code-oauth-token'].includes(config.authentication)) throw fail('Choose a Claude Code OAuth token or API key in Settings.', 'provider_auth');
  if (typeof key !== 'string' || !key.trim() || key.length > 16384 || /[\x00-\x20\x7f]/.test(key)) throw fail('Save your Claude credential in Settings before starting analysis.', 'provider_auth');
  if (signal?.aborted) throw fail('Analysis cancelled.', 'aborted');
  const file = await locateClaude({ executable, verifySignature, execFileImpl });
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'meeting-claude-analysis-'));
  let process;
  try {
    await fs.chmod(directory, 0o700);
    const env = { HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, 'config'), TMPDIR: directory,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    const version = await execFileImpl(file, ['--version'], { cwd: directory, env, timeout: 10000, maxBuffer: 128, signal });
    const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6}) \(Claude Code\)\s*$/.exec(version.stdout || '');
    const numbers = match?.slice(1).map(Number);
    if (!numbers || numbers[0] < 2 || numbers[0] === 2 && (numbers[1] < 1 || numbers[1] === 1 && numbers[2] < 178)) throw fail('Update Claude Code to version 2.1.178 or later before analysis.');
    env[config.authentication === 'claude-code-oauth-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
    // Never put a key, token, transcript, or prompt in command-line arguments.
    const systemFile = path.join(directory, 'system.txt'); await fs.writeFile(systemFile, system, { mode: 0o600, flag: 'wx' });
    const argumentsList = claudeArguments(config.model, systemFile);
    if (config.authentication === 'api-key') argumentsList.unshift('--bare');
    process = new JSONProcess(file, argumentsList, { cwd: directory, env }, { spawnImpl, signal, timeoutMs });
    const initializeID = 'meeting-claude-initialize'; let initialized = false;
    const completed = new Promise((resolve, reject) => {
      process.on('failure', reject);
      process.on('message', message => {
        if (message.type === 'control_request') {
          try { process.send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Meeting analysis does not permit tools or approvals.' } }); } catch {}
          process.reject(fail('Claude Code requested a tool or permission. Meeting analysis allows supplied content only.')); return;
        }
        if (message.type === 'control_response' && message.response?.request_id === initializeID) {
          if (initialized || message.response.subtype !== 'success') return reject(fail('Claude Code could not initialize analysis.'));
          initialized = true;
          process.send({ type: 'user', session_id: '', message: { role: 'user', content: [
            ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })), { type: 'text', text: prompt }], }, parent_tool_use_id: null });
          return;
        }
        if (message.type === 'system' && message.subtype === 'init' && (message.tools?.length || message.mcp_servers?.length)) return reject(fail('Claude Code did not disable its tools. Analysis was stopped.'));
        if (message.type === 'assistant' && message.message?.content?.some(block => block.type === 'tool_use')) return reject(fail('Claude Code attempted an unsupported tool action.'));
        if (message.type !== 'result') return;
        if (!initialized || message.is_error || message.subtype !== 'success') return reject(fail('Claude Code did not complete analysis. Check the saved credential, model access, and quota.'));
        if (typeof message.result !== 'string' || !message.result.trim() || Buffer.byteLength(message.result) > 2 * 1024 * 1024) return reject(fail('Claude Code returned no usable text.'));
        const usage = {};
        for (const name of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) if (Number.isSafeInteger(message.usage?.[name]) && message.usage[name] >= 0) usage[name] = message.usage[name];
        resolve({ text: message.result, usage, provider: 'claude-agent-sdk', model: config.model });
      });
    });
    completed.catch(() => {});
    process.send({ type: 'control_request', request_id: initializeID, request: { subtype: 'initialize', hooks: {}, agents: {}, skills: [] } });
    return await completed;
  } catch (error) {
    if (signal?.aborted) throw fail('Analysis cancelled.', 'aborted');
    if (error?.code === 'analysis_provider' || error?.code?.startsWith('provider_') || error?.code === 'aborted') throw error;
    throw fail('Claude Code could not run. Check the native CLI installation and saved credential.');
  } finally { if (process) await process.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}
module.exports = { generateClaude, locateClaude, claudeArguments };
