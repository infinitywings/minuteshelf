const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ArchiveStore } = require('../server/archive-store');
const { SessionManager } = require('../server/archive-session');
const { createRecorderServer } = require('../server/index');
const { defaults } = require('../server/archive-config');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-permissions-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new ArchiveStore(dataDir), sessions = new SessionManager(store, defaults);
  return { dataDir, store, sessions };
}
const granted = { screenRecording: 'granted', microphone: 'granted', systemAudio: 'uses-screen-recording', accessibility: 'not-required' };

test('permission commands request only explicit scopes and settings use a fixed allowlist', async t => {
  const { sessions } = fixture(t), calls = [];
  sessions.native = async (...args) => { calls.push(args); return granted; };
  await sessions.permissions();
  await sessions.requestPermissions({ screen: true });
  await sessions.requestPermissions({ microphone: true });
  await sessions.openPermissionSettings('microphone');
  assert.deepEqual(calls.map(call => call[0]), [
    ['permissions'], ['request-permissions', '--screen'], ['request-permissions', '--mic'], ['open-settings', '--permission', 'microphone']
  ]);
  assert.equal(calls[1][1], 120000);
  for (const value of [null, [], {}, { screen: false }, { screen: 'true' }, { screen: true, accessibility: true }]) {
    assert.throws(() => sessions.requestPermissions(value));
  }
  for (const value of ['accessibility', 'https://example.com', '../screen', undefined]) assert.throws(() => sessions.openPermissionSettings(value));
  assert.equal(calls.length, 4);
});

test('recording permission preflight skips granted scopes and never requests unselected microphone', async t => {
  const { sessions } = fixture(t), requests = [];
  sessions.permissions = async () => ({ ...granted, microphone: 'not-determined' });
  sessions.requestPermissions = async scope => { requests.push(scope); return granted; };
  await sessions.ensurePermissions(false);
  assert.deepEqual(requests, []);
  await sessions.ensurePermissions(true);
  assert.deepEqual(requests, [{ screen: false, microphone: true }]);
  sessions.permissions = async () => ({ ...granted, screenRecording: 'not-granted', microphone: 'denied' });
  await sessions.ensurePermissions(false);
  assert.deepEqual(requests[1], { screen: true, microphone: false });
});

test('denied permission blocks start before archive creation and permits a later retry', async t => {
  const { sessions, store } = fixture(t);
  const denied = { ...granted, screenRecording: 'not-granted' };
  sessions.permissions = async () => denied;
  sessions.requestPermissions = async () => denied;
  let sourcesCalled = false;
  sessions.sources = async () => { sourcesCalled = true; throw new Error('sources reached after permission'); };
  sessions.previews.set('preview', { windowID: 7, expires: Date.now() + 10000 });
  const input = { previewID: 'preview', confirmed: true, windowID: 7, fps: 15, microphone: false, systemAudio: true };
  await assert.rejects(sessions.start(input), error => error.statusCode === 403 && /System Settings/.test(error.message));
  assert.equal(sourcesCalled, false); assert.deepEqual(store.ids(), []); assert.equal(sessions.starting, false);
  sessions.permissions = async () => granted;
  await assert.rejects(sessions.start(input), /sources reached/);
  assert.equal(sourcesCalled, true); assert.deepEqual(store.ids(), []);
});

test('permission HTTP actions require authentication and reject hostile origins', async t => {
  const { dataDir, store, sessions } = fixture(t), calls = [];
  sessions.native = async args => { calls.push(args); return granted; };
  const runtime = createRecorderServer({ dataDir, store, sessions, config: defaults, token: 'permission-test' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => runtime.server.close(resolve)));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const headers = { Authorization: 'Bearer permission-test', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/permissions`)).status, 401);
  assert.equal((await fetch(`${base}/api/permissions/request`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{"screen":true}' })).status, 403);
  assert.equal(calls.length, 0);
  assert.deepEqual(await (await fetch(`${base}/api/permissions`, { headers })).json(), granted);
  assert.deepEqual(calls, [['permissions']]);
  const request = await fetch(`${base}/api/permissions/request`, { method: 'POST', headers, body: '{"microphone":true}' });
  assert.equal(request.status, 200);
  assert.deepEqual(calls.at(-1), ['request-permissions', '--mic']);
  assert.equal((await fetch(`${base}/api/permissions/request`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/permissions/settings`, { method: 'POST', headers, body: '{"permission":"accessibility"}' })).status, 400);
  assert.equal(calls.length, 2);
});

test('a preview that expires during system permission prompts cannot start capture', async t => {
  const { sessions, store } = fixture(t), preview = { windowID: 7, expires: Date.now() + 10000 };
  sessions.previews.set('preview', preview);
  sessions.permissions = async () => ({ ...granted, screenRecording: 'not-granted' });
  sessions.requestPermissions = async () => { preview.expires = Date.now() - 1; return granted; };
  sessions.sources = async () => ({ windows: [{ id: 7 }], microphones: [] });
  await assert.rejects(sessions.start({ previewID: 'preview', confirmed: true, windowID: 7, fps: 15, microphone: false, systemAudio: true }), /preview expired/);
  assert.deepEqual(store.ids(), []); assert.equal(sessions.starting, false);
});
