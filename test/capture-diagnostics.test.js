const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const tool = path.resolve(__dirname, '../tools/diagnose-capture.mjs');

function fixture(t, events = [], snapshot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'raw'));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ title: 'PRIVATE_MEETING_TEXT', durationSeconds: 50,
    selection: { window: { id: 4981, title: 'PRIVATE_WINDOW_TEXT' } }, timeline: { originPTS: { seconds: 100 } } }));
  fs.writeFileSync(path.join(root, 'raw/capture_events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (snapshot) fs.writeFileSync(path.join(root, 'raw/capture-diagnostics.json'), JSON.stringify(snapshot));
  return root;
}
function sample(time, received, suspended, extra = {}) {
  return { event: 'capture-diagnostic', schemaVersion: 1, reason: 'periodic', pts: { seconds: time }, elapsedHostSeconds: time - 100,
    windowID: 4981, videoState: 'suspended', counters: { received: { video: received, system: 200, microphone: 200 },
      videoStatus: { complete: 100, idle: 0, suspended, blank: 0, started: 0, stopped: 0, missing: 0, unknown: 0 },
      dropped: { paused: 0, invalidSample: 0, invalidPTS: 0, videoUnavailable: 0, missingPixels: 0, encoderBackpressure: 0 }, videoFramesWritten: 100 },
    lastReceivedHostPTS: { video: { seconds: time - 1 } }, targetProbe: { observedAtHostPTS: { seconds: time }, windowID: 4981,
      exists: true, isOnScreen: true, frame: { x: 0, y: 0, width: 1280, height: 800 }, sameApplicationWindowIDs: [4981, 4990], error: 'PRIVATE_ERROR_TEXT' }, ...extra };
}
const run = (root, args = []) => JSON.parse(execFileSync(process.execPath, [tool, '--archive', root, ...args], { encoding: 'utf8' }));

test('legacy archive reports insufficient evidence and preserves its raw files', t => {
  const root = fixture(t, [{ event: 'frame-state', pts: { seconds: 113 }, status: 3, usable: false },
    { event: 'segment', kind: 'video', startPTS: { seconds: 100 }, endPTS: { seconds: 113 }, file: 'PRIVATE_MEDIA_NAME' },
    { event: 'segment', kind: 'system', startPTS: { seconds: 100 }, endPTS: { seconds: 150 } }]);
  fs.appendFileSync(path.join(root, 'raw/capture_events.jsonl'), '{truncated');
  const before = fs.readFileSync(path.join(root, 'raw/capture_events.jsonl'));
  const result = run(root);
  assert.match(result.evidenceLevel, /^insufficient/); assert.equal(result.observations.malformedEventLines, 1);
  assert.deepEqual(result.suspensionSessionSeconds, [13]); assert.equal(result.sourceCoverage.video.lastPTS, 113);
  assert.equal(result.sourceCoverage.system.lastPTS, 150); assert.equal(result.cause, 'Not established by these capture metadata.');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.deepEqual(fs.readFileSync(path.join(root, 'raw/capture_events.jsonl')), before);
});
test('a repaired manifest origin is not overwritten by a later legacy zero event', t => {
  const root = fixture(t, [
    { event: 'timeline', originPTS: { seconds: 100 } },
    { event: 'frame-state', pts: { seconds: 113 }, status: 3, usable: false },
    { event: 'timeline', originPTS: { seconds: 0 }, rebased: true },
    { event: 'frame-state', pts: { seconds: 0 }, status: 5, usable: false }
  ]);
  const before = fs.readFileSync(path.join(root, 'raw/capture_events.jsonl'));
  const result = run(root);
  assert.equal(result.originPTSSeconds, 100);
  assert.deepEqual(result.suspensionSessionSeconds, [13]);
  assert.equal(result.timelineProvenance.lastRawOriginPTSSeconds, 0);
  assert.equal(result.timelineProvenance.originSource, 'effective-manifest');
  assert.deepEqual(fs.readFileSync(path.join(root, 'raw/capture_events.jsonl')), before);
});
test('an evidenced unrepaired legacy timeline uses the shared correction without modifying inputs', t => {
  const root = fixture(t, [
    { event: 'timeline', originPTS: { seconds: 100 }, rebased: false },
    { event: 'frame-state', pts: { seconds: 113 }, status: 3, usable: false },
    { event: 'timeline', originPTS: { seconds: 0 }, rebased: true },
    { event: 'frame-state', pts: { seconds: 0 }, status: 5, usable: false },
    { event: 'stopped', endPTS: { seconds: 150 } }
  ]);
  const file = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.timeline = { clock: 'SCK-presentation-time', originPolicy: 'earliest-observed-source-PTS', originPTS: { seconds: 0 } };
  manifest.durationSeconds = 150;
  manifest.segments = [{ startPTS: { seconds: 100 }, endPTS: { seconds: 150 } }];
  fs.writeFileSync(file, JSON.stringify(manifest));
  const before = fs.readFileSync(file);
  const result = run(root);
  assert.equal(result.originPTSSeconds, 100);
  assert.equal(result.durationSeconds, 50);
  assert.deepEqual(result.suspensionSessionSeconds, [13]);
  assert.equal(result.timelineProvenance.legacyZeroPTSCorrection, true);
  assert.equal(result.timelineProvenance.correctedInReport, true);
  assert.deepEqual(fs.readFileSync(file), before);
  // Zero is also a legitimate clock origin: no correction without media evidence.
  manifest.segments[0].startPTS.seconds = 0;
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(run(root).originPTSSeconds, 0);
});
test('cumulative samples distinguish repeated suspended callbacks from no callbacks', t => {
  const last = sample(130, 105, 5, { reason: 'stopped' });
  const root = fixture(t, [sample(120, 101, 1), sample(125, 105, 5), last], last);
  const result = run(root);
  assert.equal(result.observations.diagnosticSamples, 3, 'duplicate final snapshot is counted once');
  assert.equal(result.evidenceLevel, 'callback-intervals-observed');
  assert.equal(result.intervals[0].finding, 'suspended-callbacks-continued');
  assert.equal(result.intervals[0].delta.received.video, 4);
  assert.equal(result.intervals[1].finding, 'no-video-callbacks-in-observed-interval');
  assert.equal(result.intervals[1].durationSeconds, 5);
  assert.equal(result.diagnostics[0].targetProbe.exists, true);
  assert.equal(result.diagnostics[0].targetProbe.errorReported, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});
test('counter reset or target change is not diagnosed as a callback stall', t => {
  const root = fixture(t, [sample(120, 101, 1), sample(125, 1, 0), sample(130, 1, 0, { windowID: 77 })]);
  const result = run(root);
  assert(result.intervals.every(interval => interval.finding === 'counter-or-target-discontinuity'));
  assert.match(result.evidenceLevel, /^insufficient/);
});
test('display diagnostics preserve the target kind and separate different displays with zero window IDs', t => {
  const root = fixture(t, [sample(120, 101, 1, { captureKind:'display', windowID:0, displayID:7 }), sample(125, 101, 1, { captureKind:'display', windowID:0, displayID:8 })]);
  const result = run(root);
  assert.equal(result.diagnostics[0].captureKind, 'display');
  assert.equal(result.diagnostics[0].displayID, 7);
  assert.equal(result.intervals[0].finding, 'counter-or-target-discontinuity');
});
test('missing counters remain unknown instead of becoming zero', t => {
  const root = fixture(t, [sample(120, 101, 1, { counters: {} }), sample(125, 101, 1, { counters: {} })]);
  const result = run(root);
  assert.equal(result.intervals[0].finding, 'insufficient-counters');
  assert.equal(result.intervals[0].delta.received.video, null);
});
test('callbacks can resume without implying why capture was suspended', t => {
  const root = fixture(t, [sample(120, 101, 1), sample(125, 111, 1, { videoState: 'complete' })]);
  const result = run(root);
  assert.equal(result.intervals[0].finding, 'video-callbacks-continued');
  assert.match(result.cause, /Not established/);
});
test('an explicit pause is not reported as an unexplained video callback stall', t => {
  const root = fixture(t, [sample(120, 101, 1), { event: 'pause', pts: { seconds: 121 } },
    { event: 'resume', pts: { seconds: 124 } }, sample(125, 101, 1)]);
  const result = run(root);
  assert.equal(result.intervals[0].deliberatePauseObserved, true);
  assert.equal(result.intervals[0].finding, 'recording-paused-during-observed-interval');
  assert.match(result.evidenceLevel, /^insufficient/);
});
test('one final snapshot cannot establish an interval and unknown schemas are counted', t => {
  const root = fixture(t, [sample(120, 101, 1, { schemaVersion: 99 })], sample(125, 101, 1, { reason: 'stopped' }));
  const result = run(root);
  assert.equal(result.observations.unsupportedDiagnosticRecords, 1);
  assert.equal(result.observations.diagnosticSamples, 1);
  assert.match(result.evidenceLevel, /^insufficient/);
});
test('atomic optional output matches stdout and cannot overwrite raw or manifest', t => {
  const root = fixture(t), output = path.join(root, 'capture-report.json');
  const report = run(root, ['--output', output]);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), report);
  for (const destination of [path.join(root, 'raw/anything.json'), path.join(root, 'manifest.json')]) {
    const result = spawnSync(process.execPath, [tool, '--archive', root, '--output', destination], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /must not overwrite/);
  }
  fs.symlinkSync(path.join(root, 'raw'), path.join(root, 'raw-alias'));
  const viaAlias = spawnSync(process.execPath, [tool, '--archive', root, '--output', path.join(root, 'raw-alias/file.json')]);
  assert.equal(viaAlias.status, 1);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.capture-report-')), false);
});
test('out-of-archive input links are refused without leaking file contents', t => {
  const root = fixture(t), external = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-private-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.writeFileSync(path.join(external, 'secret.json'), '{"private":"PRIVATE_SECRET"}');
  fs.symlinkSync(path.join(external, 'secret.json'), path.join(root, 'raw/capture-diagnostics.json'));
  const result = spawnSync(process.execPath, [tool, '--archive', root], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal((result.stdout + result.stderr).includes('PRIVATE_SECRET'), false);
});
