// Saved settings contain routing policy only. Credentials stay in macOS Keychain.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { endpointURL, isLoopbackHost } = require('./analysis-providers');
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const providers = {
  transcription: ['disabled', 'local-qwen', 'local-mimo', 'local-whisper', 'stt-api', 'imported-transcript'],
  vision: ['disabled', 'chatgpt-plan', 'openai-compatible', 'anthropic-api', 'claude-agent-sdk', 'local-service'],
  summary: ['disabled', 'chatgpt-plan', 'openai-compatible', 'anthropic-api', 'claude-agent-sdk', 'local-service']
};
function remote(config) {
  if (['chatgpt-plan', 'claude-agent-sdk'].includes(config.provider)) return true;
  if (!['stt-api', 'openai-compatible', 'anthropic-api'].includes(config.provider)) return false;
  const url = endpointURL(config.endpoint, config.provider === 'stt-api' ? 'openai-compatible' : config.provider);
  return !isLoopbackHost(url.hostname);
}
function validateSettings(input) {
  if (!input || input.schemaVersion !== 1 || !['local-only', 'selected-remote-allowed'].includes(input.networkPolicy)) throw fail('Save valid Analysis settings before starting.');
  if (input.manualAnalysisStart !== true || input.pauseDuringRecording !== true || input.automaticFallback !== false) throw fail('Analysis requires manual start, recording priority, and no automatic provider fallback.');
  const value = { schemaVersion: 1, tasks: {}, networkPolicy: input.networkPolicy, uploads: {}, manualAnalysisStart: true, pauseDuringRecording: true, automaticFallback: false };
  for (const name of ['images', 'audio', 'transcriptsAndNotes', 'contextDocuments']) value.uploads[name] = input.uploads?.[name] === true;
  for (const [task, choices] of Object.entries(providers)) {
    const raw = input.tasks?.[task];
    if (!raw || !choices.includes(raw.provider)) throw fail(`Choose a supported ${task} provider in Settings → Analysis.`);
    const config = { task, provider: raw.provider, endpoint: String(raw.endpoint || '').trim(), model: String(raw.model || '').trim(), authentication: raw.authentication || 'none' };
    if (config.model.length > 1024 || config.endpoint.length > 2048 || /[\x00-\x1f\x7f]/.test(config.model + config.endpoint)) throw fail('Invalid analysis model or endpoint.');
    let auth = ['none'];
    if (config.provider === 'chatgpt-plan') auth = ['subscription-oauth-token'];
    else if (config.provider === 'claude-agent-sdk') auth = ['claude-code-oauth-token', 'api-key'];
    else if (config.provider === 'anthropic-api') auth = ['api-key'];
    else if (['stt-api', 'openai-compatible', 'local-service'].includes(config.provider)) auth = ['none', 'api-key'];
    if (!auth.includes(config.authentication)) throw fail(`The selected authentication is unsupported for ${task}. Save its settings again.`);
    if (['disabled', 'local-qwen', 'local-mimo', 'local-whisper', 'imported-transcript', 'chatgpt-plan', 'claude-agent-sdk'].includes(config.provider)) {
      if (config.endpoint) throw fail(`${task}: this provider does not use an endpoint.`);
    } else { endpointURL(config.endpoint, config.provider === 'stt-api' ? 'openai-compatible' : config.provider); }
    if (!['disabled', 'imported-transcript'].includes(config.provider) && !config.model) throw fail(`Select a ${task} model.`);
    // All fields passed below are explicitly copied; credential-like extras in
    // settings are never persisted to jobs or forwarded to a child process.
    value.tasks[task] = config;
  }
  return value;
}
function loadSettings(dataDirectory) {
  const file = path.join(dataDirectory, 'settings', 'analysis-preferences.json');
  if (!fs.existsSync(file)) throw fail('Open Settings → Analysis, choose providers, and save your preferences.');
  if (fs.statSync(file).size > 65536) throw fail('Analysis settings are too large.');
  let input; try { input = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('Analysis settings could not be read. Save them again.'); }
  return validateSettings(input);
}
const revision = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function authorize(config, settings, kinds) {
  if (!remote(config)) return;
  if (settings.networkPolicy !== 'selected-remote-allowed') throw fail('Enable selected remote providers in Settings → Analysis before using this model.');
  for (const kind of kinds) if (!settings.uploads[kind]) throw fail(`Allow ${kind === 'transcriptsAndNotes' ? 'transcripts and notes' : kind === 'contextDocuments' ? 'context documents' : kind} in Settings → Analysis before sending them to this provider.`);
}
function readCredential({ config, dataDirectory, signal, operation = 'read', binary = path.resolve(__dirname, '../../../MacOS/MeetingArchive'), spawnProcess = spawn }) {
  if (!['api-key', 'claude-code-oauth-token'].includes(config.authentication)) return Promise.resolve(operation === 'status' ? { stored: false, required: false } : undefined);
  if (!fs.existsSync(binary)) return Promise.reject(fail('The credential helper is missing. Install the complete MinuteShelf app.'));
  return new Promise((resolve, reject) => {
    let output = '', closed = false;
    const child = spawnProcess(binary, ['--credential-helper'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    const finish = (error, value) => { if (closed) return; closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill('SIGKILL'); finish(fail('Credential read cancelled.')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail('Keychain did not respond. Unlock it and save the credential again in Settings → Analysis.')); }, 10000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(fail('The credential helper could not start. Reinstall the complete app.')));
    child.stderr.on('data', () => {}); // Never echo native process output into HTTP/logs.
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 16384) { child.kill('SIGKILL'); finish(fail('Invalid credential helper response.')); } });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code !== 0) {
        let errorCode; try { errorCode = JSON.parse(output).error?.code; } catch {} output = '';
        const task = { vision:'Screen understanding', summary:'Meeting summaries', transcription:'Speech recognition' }[config.task] || 'This task';
        const messages = {
          credential_missing: `${task}: no credential is saved for this provider and authentication. Save it in Settings → Analysis.`,
          keychain_authorization_required: `${task}: the saved credential needs Keychain authorization for this app version. Unlock your login Keychain and choose Authorize Access in Settings → Analysis.`,
          keychain_unavailable: `${task}: Keychain is unavailable. Unlock your login Keychain, then check access in Settings → Analysis.`,
          keychain_cancelled: `${task}: Keychain authorization was cancelled. The saved credential was preserved.`,
          credential_helper_trust: 'The credential helper could not be trusted. Reinstall the complete MinuteShelf app.',
          credential_invalid: `${task}: the saved credential has an invalid format. Save a replacement in Settings → Analysis.`
        };
        const error = fail(messages[errorCode] || `${task}: the credential helper could not read the saved credential. Check Keychain access in Settings → Analysis.`);
        error.code = Object.hasOwn(messages, errorCode) ? errorCode : 'credential_read'; return finish(error);
      }
      try {
        const value = JSON.parse(output); output = '';
        if (operation === 'status') { if (typeof value.stored !== 'boolean' || typeof value.readable !== 'boolean') throw new Error(); return finish(null, { stored: value.stored, readable: value.readable, required: true }); }
        if (typeof value.key !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(value.key)) throw new Error();
        finish(null, value.key);
      } catch { finish(fail('Invalid credential helper response.')); }
    });
    child.stdin.end(JSON.stringify({ operation, dataDirectory, task: config.task, provider: config.provider, endpoint: config.endpoint, authentication: config.authentication }));
    if (signal?.aborted) abort();
  });
}
module.exports = { validateSettings, loadSettings, revision, authorize, remote, readCredential };
