const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ArchiveStore } = require('../server/archive-store');
const { SessionManager, captureTarget } = require('../server/archive-session');
const { defaults } = require('../server/archive-config');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-selection-'));
  const store = new ArchiveStore(root), sessions = new SessionManager(store, defaults);
  sessions.permissions = async () => ({ screenRecording:'granted', microphone:'granted' });
  sessions.sources = async () => ({ windows:[{ id:7, app:'Fixture', title:'Document' }], displays:[{ id:7, name:'Synthetic display' }], microphones:[] });
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  return { root, store, sessions };
}
const input = (target, previewID) => ({ target, previewID, confirmed:true, microphone:false, systemAudio:false, fps:15 });

test('capture targets reject ambiguity, invalid kinds and non-uint32 IDs', () => {
  assert.deepEqual(captureTarget({ windowID:7 }), { kind:'window', id:7 });
  assert.deepEqual(captureTarget(7), { kind:'window', id:7 });
  assert.deepEqual(captureTarget({ target:{ kind:'display', id:7 } }), { kind:'display', id:7 });
  for (const value of [null, {}, { displayID:7 }, { windowID:7, displayID:7 },
    { target:{ kind:'display', id:7 }, windowID:7 }, { target:{ kind:'window', id:7 }, displayID:7 },
    { target:{ kind:'display', id:'7' } }, { target:{ kind:'screen', id:7 } },
    { target:{ kind:'display', id:0 } }, { target:{ kind:'display', id:2 ** 32 } },
    { target:{ kind:'display', id:7, fallback:true } }]) assert.throws(() => captureTarget(value));
});

test('window and display previews with the same numeric ID never authorize each other', async t => {
  const { sessions, store } = fixture(t), calls = [];
  sessions.native = async args => { calls.push(args); return { jpeg:'fixture' }; };
  const window = await sessions.preview({ windowID:7 });
  const display = await sessions.preview({ target:{ kind:'display', id:7 } });
  assert.deepEqual(calls, [['preview','--window','7'], ['preview','--display','7']]);
  await assert.rejects(sessions.start(input({ kind:'display', id:7 }, window.previewID)), /fresh preview/);
  await assert.rejects(sessions.start(input({ kind:'window', id:7 }, display.previewID)), /fresh preview/);
  await assert.rejects(sessions.start({ ...input(display.target, display.previewID), confirmed:false }), /fresh preview/);
  assert.deepEqual(store.ids(), []);
});

test('an expired or disconnected display fails before creating an archive or substituting a window', async t => {
  const { sessions, store } = fixture(t);
  sessions.native = async () => ({ jpeg:'fixture' });
  const display = await sessions.preview({ target:{ kind:'display', id:7 } });
  sessions.sources = async () => ({ windows:[{ id:7 }], displays:[], microphones:[] });
  await assert.rejects(sessions.start(input(display.target, display.previewID)), /display is no longer available/);
  sessions.previews.get(display.previewID).expires = 0;
  await assert.rejects(sessions.start(input(display.target, display.previewID)), /fresh preview/);
  assert.deepEqual(store.ids(), []);
});

test('explicit display start reaches only --display and preserves its selection in the archive', async t => {
  const { root, store, sessions } = fixture(t);
  // A generated child records command-line metadata only, never SCK or audio.
  const stub = path.join(root, 'capture-stub');
  fs.writeFileSync(stub, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), raw = args[args.indexOf('--dir') + 1];
fs.writeFileSync(path.join(raw, 'received-arguments.json'), JSON.stringify(args));
fs.writeFileSync(path.join(raw, 'capture-status.json'), JSON.stringify({pid:process.pid,hostID:'selection-stub',state:'recording',updatedAt:new Date().toISOString()}));
setTimeout(() => {}, 10000);
`, { mode:0o700 });
  sessions.binary = stub; sessions.native = async () => ({ jpeg:'fixture' });
  const preview = await sessions.preview({ target:{ kind:'display', id:7 } });
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} } });
  const manifest = await sessions.start(input(preview.target, preview.previewID));
  pid = manifest.capture.pid;
  assert.deepEqual(manifest.selection.target, { kind:'display', id:7 });
  assert.deepEqual(manifest.selection.display, { id:7, name:'Synthetic display' });
  assert.equal(manifest.selection.window, undefined);
  const args = JSON.parse(fs.readFileSync(path.join(store.raw(manifest.id), 'received-arguments.json')));
  assert.equal(args[args.indexOf('--display') + 1], '7');
  assert(!args.includes('--window') && !args.includes('--mic') && !args.includes('--system-audio'));
});
