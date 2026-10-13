const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const tool = import(pathToFileURL(path.resolve(__dirname, '../tools/collect-capture-test.mjs')));

function setup(t) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-bundle-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'archive');
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
  const events = [];
  for (const [i, action] of ['share-start', 'show-meeting', 'content-change', 'share-stop'].entries()) {
    const start = 105 + i * 25;
    events.push({ event: 'bookmark', text: `TEST:W1:${action}:before`, pts: { seconds: start } },
      { event: 'bookmark', text: `TEST:W1:${action}:after`, pts: { seconds: start + 1 } });
  }
  for (let time = 100; time <= 205; time += 3) events.push({ event: 'capture-diagnostic', reason: 'periodic',
    schemaVersion: 1, captureKind: 'window', windowID: 10, videoState: 'complete', pts: { seconds: time },
    counters: { received: { video: time, system: 0, microphone: 0 }, videoStatus: { complete: time }, videoFramesWritten: time },
    targetProbe: { windowID: 10, exists: true, isOnScreen: true, observedAtHostPTS: { seconds: time - 0.5 },
      sameApplicationWindowIDs: [10, 11], error: 'PRIVATE_ERROR' } });
  events.sort((a, b) => a.pts.seconds - b.pts.seconds);
  const status = { state: 'recorded', diagnostics: { fixture: true } };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ title: 'PRIVATE_TITLE', status: 'recorded',
    durationSeconds: 105, timeline: { originPTS: { seconds: 100 } }, selection: { window: { id: 10, title: 'PRIVATE_WINDOW' } } }));
  fs.writeFileSync(path.join(root, 'raw/capture-status.json'), JSON.stringify(status));
  fs.writeFileSync(path.join(root, 'raw/capture-diagnostics.json'), JSON.stringify({ ...events.at(-1), reason: 'stopped', fixture: true }));
  const eventFile = path.join(root, 'raw/capture_events.jsonl');
  const persist = () => fs.writeFileSync(eventFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  persist();
  fs.writeFileSync(path.join(root, 'raw/video_000001.mp4'), Buffer.from('synthetic non-media bytes'));
  return { outer, root, events, status, persist };
}

test('operator brackets align to native PTS, preserve uncertainty and redact private metadata', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  f.events.push({ event: 'bookmark', text: 'PRIVATE_NOTE', pts: { seconds: 130 } }); f.persist();
  const original = fs.readFileSync(path.join(f.root, 'raw/capture_events.jsonl'));
  const report = await collectCaptureTest(f.root, 'W1');
  assert.equal(report.fixture, true);
  assert.equal(report.markerCount, 8);
  assert.deepEqual(report.missingEvidence, []);
  assert.equal(report.actionReports[1].before.sessionSeconds, 30);
  assert.equal(report.actionReports[1].bracketDurationSeconds, 1);
  assert.equal(report.actionReports[1].stableObservation.enoughDuration, true);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.match(report.mediaValidation, /^pending/);
  assert.equal(report.installedPlaybackValidation, 'pending');
  assert.equal(report.inputIntegrity.unchangedDuringCollection, true);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'raw/capture_events.jsonl')), original);
});

test('duplicate, reversed or absent action edges remain insufficient evidence', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  f.events.push({ event: 'bookmark', text: 'TEST:W1:show-meeting:before', pts: { seconds: 130 } });
  f.events.find(e => e.text === 'TEST:W1:content-change:after').pts.seconds = 140;
  f.events.splice(f.events.findIndex(e => e.text === 'TEST:W1:share-stop:after'), 1); f.persist();
  const report = await collectCaptureTest(f.root, 'W1');
  assert.equal(report.actionReports.filter(a => a.timing === 'operator-action-bracket').length, 1);
  assert.equal(report.missingEvidence.filter(s => s.includes('bookmark pair unavailable')).length, 3);
});

test('too-short holds and distant observations cannot pass observation gate', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  for (let i = f.events.length - 1; i >= 0; i--) {
    if (f.events[i].event === 'capture-diagnostic' && f.events[i].pts.seconds > 135) f.events.splice(i, 1);
  }
  f.persist();
  const report = await collectCaptureTest(f.root, 'W1');
  assert.equal(report.actionReports[1].stableObservation.enoughDuration, false);
  assert(report.missingEvidence.some(s => s.includes('content-change: missing or distant')));
});

test('a counter reset or target change inside a hold is not hidden by growing endpoints', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  const sample = f.events.find(e => e.event === 'capture-diagnostic' && e.pts.seconds === 118);
  sample.counters.received.video = 1;
  f.persist();
  let report = await collectCaptureTest(f.root, 'W1');
  assert.equal(report.actionReports[0].stableObservation.enoughDuration, false);
  sample.counters.received.video = 118; sample.windowID = 99; f.persist();
  report = await collectCaptureTest(f.root, 'W1');
  assert.equal(report.actionReports[0].stableObservation.enoughDuration, false);
});

test('decode requests preserve a middle gap and a valid tail without borrowing adjacent pictures', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  const file = path.join(f.root, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.segments = [
    { kind: 'video', file: 'video_000001.mp4', startPTS: { seconds: 100 }, endPTS: { seconds: 120 } },
    { kind: 'video', file: 'video_000002.mp4', startPTS: { seconds: 180 }, endPTS: { seconds: 205 } },
    { kind: 'video', file: '../private.mp4', startPTS: { seconds: 121 }, endPTS: { seconds: 179 } }
  ];
  fs.writeFileSync(file, JSON.stringify(manifest));
  const report = await collectCaptureTest(f.root, 'W1');
  assert.equal(report.mediaInspectionPlan.segmentCount, 2);
  const gap = report.mediaInspectionPlan.requestedFrames.find(r => r.label === 'show-meeting/after+5s');
  assert.equal(gap.disposition, 'no-segment-at-requested-time');
  assert.equal(gap.file, null);
  const tail = report.mediaInspectionPlan.requestedFrames.at(-1);
  assert.equal(tail.file, 'video_000002.mp4');
  assert(Math.abs(tail.segmentTimeSeconds - 24.7) < 1e-6);
});

test('collection is blocked while native recording or finalization is active', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  for (const state of ['starting', 'recording', 'paused', 'finalizing']) {
    fs.writeFileSync(path.join(f.root, 'raw/capture-status.json'), JSON.stringify({ state }));
    await assert.rejects(collectCaptureTest(f.root, 'W1'), /finish before collecting/);
  }
});

test('evidence output cannot replace any archive input or an existing report', async t => {
  const f = setup(t), { collectCaptureTest, saveBundle } = await tool;
  const report = await collectCaptureTest(f.root, 'W1');
  assert.throws(() => saveBundle(f.root, path.join(f.root, 'manifest.json'), report), /outside/);
  fs.mkdirSync(path.join(f.root, 'annotations'));
  assert.throws(() => saveBundle(f.root, path.join(f.root, 'annotations/report.json'), report), /outside/);
  const output = path.join(f.outer, 'report.json');
  saveBundle(f.root, output, report);
  const before = fs.readFileSync(output);
  assert.throws(() => saveBundle(f.root, output, report), /EEXIST/);
  assert.deepEqual(fs.readFileSync(output), before);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test('external raw symlinks are never read or hashed', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  const external = path.join(f.outer, 'external'); fs.writeFileSync(external, 'private');
  fs.symlinkSync(external, path.join(f.root, 'raw/linked.wav'));
  await assert.rejects(collectCaptureTest(f.root, 'W1'), /symbolic links/);
});

test('transient IPC is excluded and missing final evidence is explicit', async t => {
  const f = setup(t), { collectCaptureTest } = await tool;
  fs.mkdirSync(path.join(f.root, 'raw/control'));
  fs.writeFileSync(path.join(f.root, 'raw/control/inbox.json'), 'PRIVATE_CONTROL');
  fs.unlinkSync(path.join(f.root, 'raw/capture-diagnostics.json'));
  const report = await collectCaptureTest(f.root, 'W1');
  assert(report.missingEvidence.includes('Final stopped diagnostic snapshot unavailable'));
  assert(!report.inputIntegrity.files.some(f => f.path.startsWith('raw/control/')));
  assert.equal(report.fixture, true);
});
