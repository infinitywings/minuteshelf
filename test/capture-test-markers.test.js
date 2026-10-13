const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const tool = import(pathToFileURL(path.resolve(__dirname, '../tools/mark-capture-test.mjs')));

function fixture(t, status = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-marker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'raw/control/inbox'), { recursive: true });
  fs.mkdirSync(path.join(root, 'raw/control/results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'raw/capture_events.jsonl'), '');
  fs.writeFileSync(path.join(root, 'raw/capture-status.json'), JSON.stringify({ state: 'recording',
    pid: process.pid, updatedAt: new Date().toISOString(), ...status }));
  return root;
}

test('a bookmark is confirmed only by the native receipt and matching event PTS', async t => {
  const root = fixture(t), { markCaptureTest } = await tool;
  const timer = setInterval(() => {
    const inbox = path.join(root, 'raw/control/inbox');
    for (const name of fs.readdirSync(inbox).filter(name => name.endsWith('.json'))) {
      const command = JSON.parse(fs.readFileSync(path.join(inbox, name)));
      assert.deepEqual(Object.keys(command).sort(), ['command', 'id', 'text']);
      assert.equal(command.command, 'bookmark');
      assert.equal(command.text, 'TEST:W1:show-meeting:before');
      fs.appendFileSync(path.join(root, 'raw/capture_events.jsonl'), JSON.stringify({ event: 'bookmark',
        id: command.id, text: command.text, pts: { seconds: 12345.25 } }) + '\n');
      fs.writeFileSync(path.join(root, 'raw/control/results', name), JSON.stringify({ ok: true }));
      fs.unlinkSync(path.join(inbox, name));
    }
  }, 10);
  t.after(() => clearInterval(timer));
  const result = await markCaptureTest(root, 'W1', 'show-meeting', 'before');
  assert.equal(result.acknowledged, true); assert.equal(result.hostSeconds, 12345.25);
  assert.equal(fs.readdirSync(path.join(root, 'raw/control/results')).length, 1);
});

test('an old, paused or stopped status cannot enqueue a bookmark', async t => {
  const { markCaptureTest } = await tool;
  for (const status of [{ state: 'paused' }, { state: 'recorded' }, { state: 'finalizing' }, { updatedAt: '2000-01-01T00:00:00Z' }]) {
    const root = fixture(t, status);
    await assert.rejects(markCaptureTest(root, 'W1', 'show-meeting', 'before'), /actively recording/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'raw/control/inbox')), []);
  }
});

test('the CLI cannot issue arbitrary commands or change capture targets', async t => {
  const root = fixture(t), { markCaptureTest } = await tool;
  await assert.rejects(markCaptureTest(root, 'W1', 'stop', 'before'), /defined test case/);
  await assert.rejects(markCaptureTest(root, 'W1', 'show-meeting', 'PRIVATE_TEXT'), /defined test case/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'raw/control/inbox')), []);
});

test('timeout leaves one pending bookmark and does not retry or activate any UI', async t => {
  const root = fixture(t), { markCaptureTest } = await tool;
  await assert.rejects(markCaptureTest(root, 'W1', 'share-start', 'before', { timeoutMs: 25 }), /do not resend automatically/);
  assert.equal(fs.readdirSync(path.join(root, 'raw/control/inbox')).length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'raw/capture_events.jsonl'), 'utf8'), '');
});

test('a redirected IPC directory cannot receive a command', async t => {
  const root = fixture(t), { markCaptureTest } = await tool;
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-marker-external-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.rmdirSync(path.join(root, 'raw/control/inbox'));
  fs.symlinkSync(external, path.join(root, 'raw/control/inbox'));
  await assert.rejects(markCaptureTest(root, 'W1', 'share-start', 'before'), /Unsafe recorder IPC/);
  assert.deepEqual(fs.readdirSync(external), []);
});
