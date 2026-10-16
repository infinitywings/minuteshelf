const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { generate, transcribeAPI, endpointURL } = require('../server/analysis-providers');
const { generateCodex, managedCodexHome } = require('../server/codex-analysis');
const { generateClaude } = require('../server/claude-analysis');
const { readCredential } = require('../server/analysis-settings');

const base = { provider: 'anthropic-api', endpoint: '', model: 'test-model', authentication: 'api-key' };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function temporary(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-provider-test-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
function fakeSpawn(onMessage, capture = {}) {
  return (executable, args, options) => {
    Object.assign(capture, { executable, args, options, calls: [], killed: false });
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    let buffer = '';
    const send = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin.on('data', chunk => {
      buffer += chunk.toString(); let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); capture.calls.push(value);
        queueMicrotask(() => onMessage(value, send, child));
      }
    });
    child.kill = () => { capture.killed = true; queueMicrotask(() => child.emit('close', 0)); return true; };
    return child;
  };
}
function codexResponder(variation) {
  return (m, send) => {
    const response = result => send({ id: m.id, result });
    if (m.method === 'initialize') response({});
    if (m.method === 'account/read') response({ account: { type: 'chatgpt' } });
    if (m.method === 'config/read') response({ config: { features: { plugins:variation === 'plugins-enabled', remote_plugin:false, hooks:false, apps:false, shell_tool:false, unified_exec:false } } });
    if (m.method === 'thread/start') response({ thread: { id: 'thread-1', ephemeral: true }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', instructionSources: [] });
    if (m.method === 'turn/start') {
      response({ turn: { id: 'turn-1' } });
      if (variation === 'hang') return;
      if (variation === 'tool') return send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } });
      if (variation === 'tool-item') return send({ method: 'item/started', params: { threadId: 'thread-1', item: { type: 'commandExecution', command: 'cat private' } } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'commentary', id: 'comment', text: 'Working...' } } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', id: 'answer', text: 'Final summary.' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: variation === 'failed' ? 'failed' : 'completed', items: [] } } });
    }
  };
}
test('Anthropic sends text and archive images without tools and returns filtered usage', async t => {
  const root = await temporary(t); const file = path.join(root, 'frame.png'); await fs.writeFile(file, 'image-bytes');
  let request;
  const result = await generate({ config: base, system: 'rules', prompt: 'meeting', images: [{ path: file, mimeType: 'image/png' }], dataDirectory: root, key: 'test-secret', fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) }; return json({ content: [{ type: 'text', text: 'Summary' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2, secret: 'never-retain' } });
  } });
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages'); assert.equal(request.options.headers['x-api-key'], 'test-secret');
  assert.equal(request.options.redirect, 'manual'); assert.equal(request.body.messages[0].content[0].source.type, 'base64');
  assert.equal(request.body.tools, undefined); assert.equal(request.body.system, 'rules'); assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2 });
});
test('API keys are required only for selected authentication', async () => {
  await assert.rejects(generate({ config: base, prompt: 'x' }), /Save an API key/);
  let headers;
  await generate({ config: { provider: 'openai-compatible', endpoint: 'http://127.0.0.1:9999/v1', model: 'local', authentication: 'none' }, prompt: 'x', fetchImpl: async (_u, options) => { headers = options.headers; return json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }); } });
  assert.equal(headers.Authorization, undefined);
});
test('compatible endpoints use chat completions and multimodal data URLs', async t => {
  const root = await temporary(t); const file = path.join(root, 'frame.png'); await fs.writeFile(file, 'image'); let body;
  await generate({ config: { ...base, provider: 'openai-compatible', endpoint: 'https://provider.example/v1' }, dataDirectory: root, key: 'key', prompt: 'x', images: [{ path: file, mimeType: 'image/png' }], fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return json({ choices: [{ message: { content: 'ok' } }] }); } });
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/); assert.equal(body.tools, undefined);
});
test('local Ollama uses images and unloads after request', async () => {
  let body;
  await generate({ config: { provider: 'local-service', endpoint: 'http://localhost:11434', model: 'local', authentication: 'none' }, prompt: 'x', fetchImpl: async (url, options) => {
    assert.equal(url, 'http://localhost:11434/api/chat'); body = JSON.parse(options.body); return json({ done: true, message: { content: 'ok' }, eval_count: 3 });
  } });
  assert.equal(body.keep_alive, 0); assert.equal(body.stream, false);
});
test('endpoint validation rejects remote HTTP and embedded secrets', () => {
  for (const url of ['http://example.com/v1', 'https://user:pass@example.com', 'https://example.com?key=secret', 'file:///tmp/model', 'https://example.com/#secret']) assert.throws(() => endpointURL(url, 'openai-compatible'));
  assert.throws(() => endpointURL('https://cloud.example', 'local-service'));
  assert.equal(endpointURL('http://[::1]:8000/v1', 'openai-compatible').pathname, '/v1/chat/completions');
});
test('redirect/error bodies and transport exceptions never echo credentials', async () => {
  for (const status of [302, 401, 403, 429, 500]) {
    await assert.rejects(generate({ config: base, prompt: 'x', key: 'top-secret', fetchImpl: async () => new Response('top-secret', { status, headers: { location: 'https://attacker.example' } }) }), error => !error.message.includes('top-secret'));
  }
  await assert.rejects(generate({ config: base, prompt: 'x', key: 'top-secret', fetchImpl: async () => { throw new Error('top-secret'); } }), /could not be reached/);
});
test('HTTP truncation, tool output, and response oversize fail rather than save partial summaries', async () => {
  for (const value of [ { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }, { content: [{ type: 'tool_use', name: 'shell' }] } ]) await assert.rejects(generate({ config: base, prompt: 'x', key: 'key', fetchImpl: async () => json(value) }));
  await assert.rejects(generate({ config: base, prompt: 'x', key: 'key', fetchImpl: async () => new Response('x', { headers: { 'content-length': '9999999' } }) }), /size limit/);
});
test('HTTP cancellation and timeout abort the in-flight request', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('transport abort secret')), { once: true }));
  const control = new AbortController(); const pending = generate({ config: base, prompt: 'x', key: 'key', signal: control.signal, fetchImpl }); setTimeout(() => control.abort(), 10);
  await assert.rejects(pending, error => error.code === 'aborted');
  await assert.rejects(generate({ config: base, prompt: 'x', key: 'key', timeoutMs: 10, fetchImpl }), error => error.code === 'provider_timeout');
});
test('images outside archive, including escaping symlinks, never reach a provider', async t => {
  const root = await temporary(t), outside = await temporary(t); await fs.writeFile(path.join(outside, 'private.png'), 'private');
  await fs.symlink(path.join(outside, 'private.png'), path.join(root, 'link.png'));
  let called = false;
  for (const file of [path.join(outside, 'private.png'), path.join(root, 'link.png')]) await assert.rejects(generate({ config: base, key: 'key', prompt: 'x', dataDirectory: root, images: [{ path: file, mimeType: 'image/png' }], fetchImpl: async () => { called = true; } }), /belong to this archive/);
  assert.equal(called, false);
});
test('Codex shares only managed Keychain scope, disables tools, sends data images and final output', async t => {
  const root = await temporary(t); const capture = {};
  const result = await generateCodex({ config: { model: 'test-model' }, system: 'Analyze supplied evidence.', prompt: 'private meeting', images: [{ mimeType: 'image/png', data: 'ZmFrZQ==' }], dataDirectory: root, spawnImpl: fakeSpawn(codexResponder(), capture) });
  assert.equal(result.text, 'Final summary.'); assert.equal(capture.options.env.CODEX_HOME, path.join(await fs.realpath(root), 'connections/codex'));
  assert.equal(capture.options.env.HOME, os.homedir(), 'Keychain must use the same account home as sign-in');
  assert.notEqual(capture.options.cwd, os.homedir()); assert.equal(capture.options.env.TMPDIR, capture.options.cwd);
  assert.equal(capture.options.env.OPENAI_API_KEY, undefined); assert.equal(capture.options.env.HTTPS_PROXY, undefined);
  assert.ok(capture.args.includes('features.shell_tool=false')); assert.ok(capture.args.includes('features.hooks=false'));
  const thread = capture.calls.find(value => value.method === 'thread/start'); assert.equal(thread.params.ephemeral, true); assert.equal(thread.params.sandbox, 'read-only');
  const turn = capture.calls.find(value => value.method === 'turn/start'); assert.equal(turn.params.input[1].type, 'image'); assert.match(turn.params.input[1].url, /^data:image/);
  assert.equal(capture.killed, true); await assert.rejects(fs.stat(capture.options.cwd), { code: 'ENOENT' });
});
test('Codex denies tool/approval requests and tool lifecycle events', async t => {
  for (const kind of ['tool', 'tool-item']) {
    const root = await temporary(t), capture = {};
    await assert.rejects(generateCodex({ config: { model: 'test-model' }, system: '', prompt: 'x', dataDirectory: root, spawnImpl: fakeSpawn(codexResponder(kind), capture) }), /tool/);
    assert.equal(capture.killed, true);
    if (kind === 'tool') assert.equal(capture.calls.find(value => value.id === 'approval-1').error.code, -32601);
  }
});
test('Codex failed turns and cancellation never return completion', async t => {
  const root = await temporary(t);
  await assert.rejects(generateCodex({ config: { model: 'test-model' }, system: '', prompt: 'x', dataDirectory: root, spawnImpl: fakeSpawn(codexResponder('failed')) }), /did not complete/);
  const capture = {}, control = new AbortController();
  const pending = generateCodex({ config: { model: 'test-model' }, system: '', prompt: 'x', dataDirectory: root, signal: control.signal, spawnImpl: fakeSpawn(codexResponder('hang'), capture) });
  setTimeout(() => control.abort(), 20); await assert.rejects(pending, error => error.code === 'aborted'); assert.equal(capture.killed, true);
});
test('managed Codex rejects symlink storage and custom configuration', async t => {
  const root = await temporary(t); const managed = await managedCodexHome(root); await fs.writeFile(path.join(managed, 'config.toml'), 'malicious');
  await assert.rejects(managedCodexHome(root), /custom configuration/);
  const root2 = await temporary(t), outside = await temporary(t); await fs.symlink(outside, path.join(root2, 'connections'));
  await assert.rejects(managedCodexHome(root2), /private local folder/);
});
test('Codex accepts inert remote plugin caches without loading tools or changing cached files', async t => {
  const root = await temporary(t), home = await managedCodexHome(root), capture = {};
  const file = path.join(home, 'plugins/cache/remote/example/1.0.0/plugin.json');
  await fs.mkdir(path.dirname(file), { recursive:true }); await fs.writeFile(file, '{"name":"synthetic cached plugin"}');
  const before = await fs.readFile(file);
  await generateCodex({ config:{model:'test-model'}, system:'', prompt:'synthetic', dataDirectory:root, spawnImpl:fakeSpawn(codexResponder(),capture) });
  assert(capture.args.includes('features.plugins=false')); assert(capture.args.includes('features.remote_plugin=false'));
  assert.deepEqual(await fs.readFile(file), before);
  await fs.writeFile(path.join(home,'plugins/custom-config.json'), '{}');
  await assert.rejects(managedCodexHome(root), /unsupported configuration/);
});
test('Codex rejects redirected plugin caches and active plugins before sending meeting input', async t => {
  const root = await temporary(t), home = await managedCodexHome(root), outside = await temporary(t);
  await fs.mkdir(path.join(home,'plugins')); await fs.symlink(outside,path.join(home,'plugins/cache'));
  await assert.rejects(managedCodexHome(root), /unsupported configuration/);
  const capture = {};
  await assert.rejects(generateCodex({config:{model:'test-model'},system:'',prompt:'private',dataDirectory:await temporary(t),spawnImpl:fakeSpawn(codexResponder('plugins-enabled'),capture)}), /did not disable/);
  assert(!capture.calls.some(call=>call.method==='turn/start'));
});
test('credential errors distinguish missing items from authorization failures without forwarding helper output', async () => {
  for (const [code, pattern] of [['credential_missing',/no credential is saved/],['keychain_authorization_required',/Authorize Access/],['keychain_unavailable',/Keychain is unavailable/],['untrusted-secret',/could not read/]]) {
    const spawnProcess = (_binary, arguments_) => {
      assert.deepEqual(arguments_, ['--credential-helper'], 'Background reads must use the main application credential mode');
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write(JSON.stringify({error:{code,message:'do-not-echo-secret'}}));child.stderr.write('do-not-echo-secret');child.emit('close',1);}));return child;
    };
    await assert.rejects(readCredential({config:{task:'vision',provider:'claude-agent-sdk',authentication:'claude-code-oauth-token',endpoint:''},dataDirectory:'/synthetic',binary:process.execPath,spawnProcess}),error=>pattern.test(error.message)&&error.message.startsWith('Screen understanding:')&&!error.message.includes('do-not-echo-secret')&&!error.message.includes('untrusted-secret'));
  }
});
test('Claude OAuth uses only child environment; initializes with no tools and supplies images', async t => {
  const root = await temporary(t); const executable = path.join(root, 'claude'); await fs.writeFile(executable, '', { mode: 0o700 }); const capture = {};
  const result = await generateClaude({ config: { model: 'sonnet', authentication: 'claude-code-oauth-token' }, system: 'system', prompt: 'private text', images: [{ mimeType: 'image/png', data: 'ZmFrZQ==' }], key: 'oauth-test-token', executable, verifySignature: false,
    execFileImpl: async () => ({ stdout: '2.1.178 (Claude Code)\n' }), spawnImpl: fakeSpawn((value, send) => {
      if (value.type === 'control_request') send({ type: 'control_response', response: { request_id: value.request_id, subtype: 'success', response: {} } });
      if (value.type === 'user') { send({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }); send({ type: 'result', subtype: 'success', is_error: false, result: 'Claude summary.', usage: { input_tokens: 4 } }); }
    }, capture) });
  assert.equal(result.text, 'Claude summary.'); assert.equal(capture.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-test-token'); assert.equal(capture.options.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(!capture.args.join(' ').includes('oauth-test-token')); assert.ok(!capture.args.join(' ').includes('private text')); assert.ok(!capture.args.includes('--bare')); assert.ok(capture.args.includes('--safe-mode'));
  assert.equal(capture.calls[1].message.content[0].source.data, 'ZmFrZQ=='); assert.equal(capture.killed, true); await assert.rejects(fs.stat(capture.options.cwd), { code: 'ENOENT' });
});
test('Claude tool callbacks are denied, errors are sanitized, old runtimes rejected', async t => {
  const root = await temporary(t); const executable = path.join(root, 'claude'); await fs.writeFile(executable, '', { mode: 0o700 });
  const options = { config: { model: 'sonnet', authentication: 'api-key' }, system: '', prompt: 'x', key: 'secret', executable, verifySignature: false, execFileImpl: async () => ({ stdout: '2.1.178 (Claude Code)\n' }) };
  await assert.rejects(generateClaude({ ...options, spawnImpl: fakeSpawn((m, send) => { if (m.type === 'control_request') send({ type: 'control_request', request_id: 'tool', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }); }) }), /tool/);
  await assert.rejects(generateClaude({ ...options, execFileImpl: async () => ({ stdout: '2.0.0 (Claude Code)' }) }), /Update Claude Code/);
});
test('dedicated STT preserves source, discontinuities and per-chunk timestamp offsets', async t => {
  const root = await temporary(t), run = path.join(root, 'run'); await fs.mkdir(run); await fs.writeFile(path.join(run, 'chunk.wav'), Buffer.alloc(100));
  const chunks = [{ path: 'chunk.wav', source: 'system', startMs: 12000, endMs: 15000 }, { path: 'chunk.wav', source: 'microphone', startMs: 23000, endMs: 26000 }];
  let count = 0;
  const value = await transcribeAPI({ config: { provider: 'stt-api', endpoint: 'http://127.0.0.1:9000/v1', model: 'whisper-1', authentication: 'api-key' }, audio: chunks, runDirectory: run, dataDirectory: root, key: 'test-key', fetchImpl: async (url, options) => {
    count++; assert.equal(url, 'http://127.0.0.1:9000/v1/audio/transcriptions'); assert.equal(options.redirect, 'manual');
    assert.equal(options.body.get('model'), 'whisper-1'); assert.equal(options.body.get('response_format'), 'verbose_json'); assert.equal(options.body.get('file').size, 100);
    return json({ text: '中英文 mixed', language: 'zh', segments: [{ start: 0.2, end: 1.4, text: '中英文 mixed' }] });
  } });
  assert.equal(count, 2); assert.deepEqual(value.segments.map(s => [s.source, s.startMs, s.endMs, s.speaker]), [['system', 12200, 13400, null], ['microphone', 23200, 24400, null]]);
  assert.equal(value.raw.length, 2); assert.equal(value.segments[0].timing, 'asr-estimate');
});
test('text-only STT explicitly reports coarse timing and accepts full transcription URL', async t => {
  const root = await temporary(t), run = path.join(root, 'run'); await fs.mkdir(run); await fs.writeFile(path.join(run, 'chunk.wav'), Buffer.alloc(100));
  const result = await transcribeAPI({ config: { provider: 'stt-api', endpoint: 'https://provider.example/v1/audio/transcriptions', model: 'gpt-4o-transcribe', authentication: 'none' }, audio: [{ path: 'chunk.wav', source: 'system', startMs: 5000, endMs: 6000 }], runDirectory: run, dataDirectory: root, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://provider.example/v1/audio/transcriptions'); assert.equal(options.body.get('response_format'), 'json'); return json({ text: 'Hello.' });
  } });
  assert.equal(result.segments[0].startMs, 5000); assert.equal(result.segments[0].timing, 'chunk-boundary'); assert.ok(result.uncertainties.length);
});
test('STT rejects invalid timing and escaping files before upload', async t => {
  const root = await temporary(t), run = path.join(root, 'run'); await fs.mkdir(run); await fs.writeFile(path.join(run, 'chunk.wav'), Buffer.alloc(100));
  const settings = { config: { provider: 'stt-api', endpoint: 'http://127.0.0.1:9000/v1', model: 'whisper-1', authentication: 'none' }, audio: [{ path: 'chunk.wav', source: 'system', startMs: 1000, endMs: 2000 }], runDirectory: run, dataDirectory: root };
  await assert.rejects(transcribeAPI({ ...settings, fetchImpl: async () => json({ segments: [{ start: 0, end: 30, text: 'wrong' }] }) }), /outside the audio chunk/);
  const outside = await temporary(t); await fs.writeFile(path.join(outside, 'private.wav'), Buffer.alloc(100)); await fs.symlink(path.join(outside, 'private.wav'), path.join(run, 'escape.wav'));
  let called = false;
  await assert.rejects(transcribeAPI({ ...settings, audio: [{ ...settings.audio[0], path: 'escape.wav' }], fetchImpl: async () => { called = true; } }), /outside the current analysis run/);
  assert.equal(called, false);
});
