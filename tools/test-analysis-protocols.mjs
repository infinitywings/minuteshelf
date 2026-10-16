// Real native runtimes, synthetic loopback model servers. Never use saved
// accounts, real API keys, or meeting content. macOS denies external networking.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { JSONProcess, configArguments, minimalEnvironment } = require('../server/codex-analysis');
const { generateClaude, locateClaude } = require('../server/claude-analysis');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = 'synthetic-not-a-real-credential';
const policy = '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))';
const localSpawn = (executable, args, options) => spawn('/usr/bin/sandbox-exec', ['-p', policy, executable, ...args], options);
if (process.platform !== 'darwin') throw new Error('Protocol smoke tests require the macOS native runtime and network sandbox.');

async function fixture(handler) {
  const calls = [], server = http.createServer(async (request, response) => {
    const pieces = []; let size = 0;
    try {
      for await (const piece of request) { size += piece.length; if (size > 2 * 1024 * 1024) throw new Error('Synthetic request too large.'); pieces.push(piece); }
      const text = Buffer.concat(pieces).toString('utf8'); const body = text ? JSON.parse(text) : {};
      const call = { path: request.url, body, usesFakeBearer: request.headers.authorization === `Bearer ${key}`, usesFakeAPIKey: request.headers['x-api-key'] === key };
      calls.push(call); handler(call, response);
    } catch { response.writeHead(500); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function sse(response, events) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
async function codex() {
  const executable = path.join(project, '.build/vendor/codex/bin/codex');
  const lock = JSON.parse(await fs.readFile(path.join(project, 'tools/codex-runtime.lock.json'), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex'), lock.binarySha256, 'Use the verified pinned Codex runtime.');
  const server = await fixture((call, response) => {
    if (call.path !== '/v1/responses') { response.writeHead(404); return response.end('{}'); }
    const message = { type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic Codex summary.', annotations: [] }] };
    sse(response, [
      { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, item_id: message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, item_id: message.id, content_index: 0, delta: message.content[0].text },
      { type: 'response.output_text.done', output_index: 0, item_id: message.id, content_index: 0, text: message.content[0].text },
      { type: 'response.content_part.done', output_index: 0, item_id: message.id, content_index: 0, part: message.content[0] },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]);
  });
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'meeting-codex-protocol-'));
  const home = path.join(temporary, 'codex'); await fs.mkdir(home, { mode: 0o700 }); let runtime;
  try {
    const cached = path.join(home, 'plugins/cache/synthetic/example/1.0.0/.codex-plugin');
    await fs.mkdir(cached, { recursive:true });
    await fs.writeFile(path.join(cached, 'plugin.json'), JSON.stringify({ name:'synthetic', description:'CACHE_INSTRUCTIONS_MUST_NOT_LOAD' }));
    const args = ['app-server', '--listen', 'stdio://', ...configArguments(), '-c', 'features.enable_request_compression=false',
      '-c', 'model_providers.fixture.name="Local synthetic fixture"', '-c', `model_providers.fixture.base_url="${server.url}/v1"`,
      '-c', 'model_providers.fixture.env_key="FIXTURE_CREDENTIAL"', '-c', 'model_providers.fixture.wire_api="responses"',
      '-c', 'model_providers.fixture.requires_openai_auth=false', '-c', 'model_providers.fixture.supports_websockets=false'];
    runtime = new JSONProcess(executable, args, { cwd: temporary, env: { ...minimalEnvironment(temporary, home), FIXTURE_CREDENTIAL: key } }, { spawnImpl: localSpawn, timeoutMs: 25000 });
    const messages = []; let finish, reject;
    const completed = new Promise((yes, no) => { finish = yes; reject = no; }); completed.catch(() => {});
    runtime.on('failure', reject);
    runtime.on('message', event => {
      if (event.method && event.id !== undefined) return reject(new Error('No server approvals or tool calls are permitted.'));
      if (event.method === 'item/completed' && event.params?.item?.type === 'agentMessage') messages.push(event.params.item.text);
      if (event.method === 'turn/completed') { if (event.params.turn.status !== 'completed') reject(new Error('Synthetic Codex turn failed.')); else finish(); }
    });
    await runtime.request('initialize', { clientInfo: { name: 'meeting_archive_protocol_test', title: 'Synthetic local fixture', version: '0.1.6' }, capabilities: { experimentalApi: false } }); runtime.send({ method: 'initialized' });
    const effective = await runtime.request('config/read', { includeLayers:false, cwd:temporary });
    for (const name of ['plugins','remote_plugin','hooks','apps','shell_tool','unified_exec']) assert.equal(effective.config.features[name],false);
    const thread = await runtime.request('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'fixture', cwd: temporary, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: 'Summarize supplied synthetic text only. No tools.' });
    assert.equal(thread.thread.ephemeral, true); assert.equal(thread.sandbox.type, 'readOnly'); assert.equal(thread.approvalPolicy, 'never'); assert.deepEqual(thread.instructionSources, []);
    await runtime.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'A synthetic meeting agreed to test the app.' }], sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    await completed; assert.equal(messages.at(-1), 'Synthetic Codex summary.');
    const inference = server.calls.filter(call => call.path === '/v1/responses'); assert.equal(inference.length, 1); assert.equal(inference[0].usesFakeBearer, true); assert.equal(inference[0].body.tools?.length || 0, 0);
    assert(!JSON.stringify(inference[0].body).includes('CACHE_INSTRUCTIONS_MUST_NOT_LOAD'));
    console.log('PASS Codex: actual stdio + local Responses SSE, isolated ephemeral thread, zero tools, synthetic credential only.');
  } finally { await runtime?.dispose(); await server.close(); await fs.rm(temporary, { recursive: true, force: true }); }
}
async function claude(authentication) {
  const executable = await locateClaude();
  const server = await fixture((call, response) => {
    if (call.path.includes('count_tokens')) { response.setHeader('Content-Type', 'application/json'); return response.end('{"input_tokens":10}'); }
    if (!call.path.startsWith('/v1/messages')) { response.writeHead(404); return response.end('{}'); }
    sse(response, [
      { type: 'message_start', message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic Claude summary.' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
    ]);
  });
  try {
    const result = await generateClaude({ config: { provider: 'claude-agent-sdk', model: 'sonnet', authentication }, system: 'Summarize supplied text only.', prompt: 'A synthetic meeting agreed to test the app.', key, executable, timeoutMs: 30000,
      spawnImpl: (file, args, options) => localSpawn(file, args, { ...options, env: { ...options.env, ANTHROPIC_BASE_URL: server.url } }) });
    assert.equal(result.text, 'Synthetic Claude summary.');
    const inference = server.calls.filter(call => call.path.startsWith('/v1/messages') && !call.path.includes('count_tokens')); assert.equal(inference.length, 1); assert.deepEqual(inference[0].body.tools, []);
    assert.equal(inference[0].usesFakeBearer, authentication === 'claude-code-oauth-token'); assert.equal(inference[0].usesFakeAPIKey, authentication === 'api-key');
    console.log(`PASS Claude ${authentication}: signed native CLI + local Messages SSE, zero tools, correct synthetic credential route.`);
  } finally { await server.close(); }
}
await codex();
await claude('api-key');
await claude('claude-code-oauth-token');
