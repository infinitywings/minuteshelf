const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const http = require('node:http');
const { ArchiveStore, atomicWrite } = require('../server/archive-store');
const { createRecorderServer } = require('../server/index');
const { defaults } = require('../server/archive-config');

async function desktop(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-desktop-'));
  const child = spawn(process.execPath, [path.join(__dirname, '../tools/desktop-server.js')], {
    env: { ...process.env, MEETING_DATA: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  const messages = [], waiters = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const value = JSON.parse(line);
    if (waiters.length) waiters.shift()(value); else messages.push(value);
  });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Desktop response timeout: ${diagnostics}`)), 5000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    lines.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const ready = await next();
  return { child, directory, ready, next, exited };
}

test('desktop entry uses an authenticated random loopback origin, packages the logo and exits cleanly', async t => {
  const { child, directory, ready, next, exited } = await desktop(t);
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(new URL(ready.url).port, String(ready.port));
  assert.equal(ready.token.length, 64);
  assert.equal(ready.nodeVersion, process.version);
  assert.equal(ready.nodeExecPath, process.execPath);
  assert.equal((await fetch(ready.url + 'api/status')).status, 401);
  const status = await (await fetch(ready.url + 'api/status', { headers: { Authorization: `Bearer ${ready.token}` } })).json();
  assert.equal(status.archivePath, path.join(directory, 'meetings'));
  assert.deepEqual(status.active, []);
  const logo = await fetch(ready.url + 'brand/meeting-archive-mark.png');
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), fs.readFileSync(path.join(__dirname, '../web/brand/meeting-archive-mark.png')));
  assert.equal((await fetch(ready.url + 'brand/other.png')).status, 404);
  child.stdin.write('{"command":"shutdown","path":"/tmp"}\n');
  assert.deepEqual(await next(), { event: 'error', error: 'invalid-command' });
  child.stdin.write('{"command":"shutdown"}\n');
  assert.deepEqual(await next(), { event: 'shutdown', ok: true });
  assert.deepEqual(await exited, [0, null]);
});

test('desktop shutdown refuses active recording; leaves the independent recorder status untouched', async t => {
  const { child, directory, ready, next, exited } = await desktop(t);
  const store = new ArchiveStore(directory);
  const m = store.create({ window: { id: 1, title: 'Synthetic' } }, defaults.recording, 'Synthetic quit guard');
  const statusFile = path.join(store.raw(m.id), 'capture-status.json');
  const active = JSON.stringify({ state: 'recording', pid: process.pid, updatedAt: new Date().toISOString() });
  atomicWrite(statusFile, active);
  child.stdin.write('{"command":"shutdown"}\n');
  assert.deepEqual(await next(), { event: 'shutdown', ok: false, error: 'recording-active' });
  assert.equal(fs.readFileSync(statusFile, 'utf8'), active);
  assert.equal((await fetch(ready.url)).status, 200);
  atomicWrite(statusFile, JSON.stringify({ state: 'stopped', pid: process.pid }));
  child.stdin.write('{"command":"shutdown"}\n');
  assert.deepEqual(await next(), { event: 'shutdown', ok: true });
  assert.deepEqual(await exited, [0, null]);
});

test('a record request arriving across desktop shutdown cannot spawn a new recorder', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-quit-race-'));
  let starts = 0;
  const runtime = createRecorderServer({ dataDir: directory, token: 'test', sessions: {
    binary: '/not-used', start: async () => { starts++; return {}; }
  } });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => runtime.server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = http.request({ host: '127.0.0.1', port: runtime.server.address().port, path: '/api/record/start', method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' } });
  const response = new Promise((resolve, reject) => { request.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); request.on('error', reject); });
  request.write('{');
  runtime.server.shuttingDown = true;
  request.end('}');
  assert.equal(await response, 503);
  assert.equal(starts, 0);
});
