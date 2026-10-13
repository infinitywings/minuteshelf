// Capture diagnostics regression using fabricated pixels and PCM only.
// Never requests TCC access, enumerates real windows, or starts SCK capture.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ArchiveStore, jsonLines } = require('../server/archive-store');
const { SessionManager } = require('../server/archive-session');
const { defaults } = require('../server/archive-config');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-capture-diagnostics-'));
const binary = path.join(root, '.build', 'archivecap');
const archives = new ArchiveStore(data);
const manager = new SessionManager(archives, defaults, binary);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const reportFile = path.join(data, 'capture-diagnostics-validation.json');
const report = { timestamp: new Date().toISOString(), syntheticOnly: true, requestedPermissions: false,
  startedRealCapture: false, dataPath: data, recorderSourceSHA256: hash(path.join(root, 'native', 'ArchiveCapture.swift')),
  nativeBinarySHA256: hash(binary), checks: {}, snapshots: [] };
const snapshots = [];
let child, spawnError, stderr = '';

function assertFinite(value, location = 'snapshot') {
  if (typeof value === 'number') assert(Number.isFinite(value), `${location} must be finite`);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertFinite(item, `${location}.${key}`);
  }
}
function counters(snapshot, group) { return snapshot.counters[group]; }
function seconds(snapshot, group, source) {
  const value = snapshot[group]?.[source]?.seconds;
  assert(Number.isFinite(value), `${group}.${source}.seconds must be present and finite`);
  return value;
}
function captureStatus(meeting) {
  const status = archives.status(meeting.id);
  const snapshot = status?.diagnostics;
  if (snapshot && snapshots.at(-1)?.pts.seconds !== snapshot.pts.seconds) {
    assertFinite(snapshot);
    snapshots.push(snapshot);
  }
  return status;
}
async function wait(check, timeout = 20000, label = 'native fixture') {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (spawnError) throw spawnError;
    const value = await check();
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${label}. ${stderr}`);
}
function checkChildRunning() {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`Fixture exited early: code=${child.exitCode}, signal=${child.signalCode}. ${stderr}`);
  }
}
function compareAudioContinues(before, after) {
  for (const source of ['microphone', 'system']) {
    assert(counters(after, 'received')[source] > counters(before, 'received')[source], `${source} callbacks continue`);
    assert(seconds(after, 'lastWrittenPTS', source) > seconds(before, 'lastWrittenPTS', source), `${source} writes continue`);
  }
}

try {
  const meeting = archives.create({ window: { id: 1, app: 'Fixture', title: 'Synthetic diagnostics' },
    microphone: true, systemAudio: true }, { ...defaults.recording, maxLongEdgePixels: 640, segmentSeconds: 5 },
  'Synthetic capture diagnostics');
  meeting.synthetic = true;
  archives.save(meeting);
  report.meetingId = meeting.id;
  child = spawn(binary, ['fixture', '--dir', archives.raw(meeting.id), '--window', '1', '--mic', '--system-audio',
    '--max-edge', '640', '--segment-seconds', '5', '--fixture-scenario', 'capture-diagnostics'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', error => { spawnError = error; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  await wait(() => {
    checkChildRunning();
    const status = captureStatus(meeting);
    return status?.state === 'recording' && status.diagnostics?.videoState === 'complete'
      && status.diagnostics.elapsedHostSeconds >= 12 && status;
  }, 24000, 'recovery after all diagnostic phases');

  const initial = snapshots.find(s => s.videoState === 'complete' && s.elapsedHostSeconds < 1.5 && s.counters.videoFramesWritten > 0);
  const idle = snapshots.findLast(s => s.videoState === 'idle' && s.elapsedHostSeconds < 3.4);
  assert(idle, 'heartbeat must observe healthy static idle');
  assert(idle.counters.videoFramesWritten > (initial?.counters.videoFramesWritten ?? 0), 'healthy idle keeps writing real prior pixels');
  assert(counters(idle, 'videoStatus').idle > 0);
  assert.equal(counters(idle, 'dropped').missingPixels, 0, 'healthy idle is not a missing-pixel failure');
  report.checks.healthyIdlePreserved = true;

  // Use the earliest suspended snapshot and the last one around the phase
  // boundary. The 1 s heartbeat can precede the sample arriving at exactly 3 s.
  const suspended = snapshots.filter(s => s.videoState === 'suspended' && s.elapsedHostSeconds >= 3 && s.elapsedHostSeconds < 5.4);
  assert(suspended.length >= 2, 'two heartbeats must observe repeated suspended callbacks');
  const suspendedBefore = suspended[0], suspendedAfter = suspended.at(-1);
  assert(counters(suspendedAfter, 'received').video > counters(suspendedBefore, 'received').video);
  assert(counters(suspendedAfter, 'videoStatus').suspended > counters(suspendedBefore, 'videoStatus').suspended);
  assert.equal(suspendedAfter.counters.videoFramesWritten, suspendedBefore.counters.videoFramesWritten);
  assert.equal(seconds(suspendedAfter, 'lastWrittenPTS', 'video'), seconds(suspendedBefore, 'lastWrittenPTS', 'video'));
  assert(seconds(suspendedAfter, 'lastReceivedHostPTS', 'video') > seconds(suspendedBefore, 'lastReceivedHostPTS', 'video'));
  compareAudioContinues(suspendedBefore, suspendedAfter);
  report.checks.repeatedSuspensionDistinctFromNoCallbacks = true;

  const absent = snapshots.filter(s => s.elapsedHostSeconds >= 6 && s.elapsedHostSeconds < 8.8);
  assert(absent.length >= 2, 'two heartbeats must observe the no-callback interval');
  const absentBefore = absent[0], absentAfter = absent.at(-1);
  assert.equal(counters(absentAfter, 'received').video, counters(absentBefore, 'received').video);
  assert.equal(seconds(absentAfter, 'lastReceivedHostPTS', 'video'), seconds(absentBefore, 'lastReceivedHostPTS', 'video'));
  assert.equal(seconds(absentAfter, 'lastWrittenPTS', 'video'), seconds(absentBefore, 'lastWrittenPTS', 'video'));
  assert.equal(absentAfter.counters.videoFramesWritten, absentBefore.counters.videoFramesWritten);
  const beforeAge = absentBefore.pts.seconds - seconds(absentBefore, 'lastReceivedHostPTS', 'video');
  const afterAge = absentAfter.pts.seconds - seconds(absentAfter, 'lastReceivedHostPTS', 'video');
  assert(afterAge > beforeAge + 0.5, 'callback age grows during silence');
  compareAudioContinues(absentBefore, absentAfter);
  report.checks.noCallbacksObservedWithoutAffectingAudio = true;

  const recovered = snapshots.at(-1);
  assert(counters(recovered, 'dropped').invalidSample > 0, 'invalid sample callbacks are counted before admission');
  assert(counters(recovered, 'dropped').invalidPTS > 0, 'invalid media PTS is counted without storing nonfinite timestamps');
  assert(recovered.counters.videoFramesWritten > absentAfter.counters.videoFramesWritten);
  assert(seconds(recovered, 'lastWrittenPTS', 'video') > seconds(absentAfter, 'lastWrittenPTS', 'video'));
  assert.equal(recovered.videoState, 'complete');
  report.checks.invalidSamplesAndPTSCountedThenRecovery = true;

  await manager.stop(meeting.id);
  await wait(() => child.exitCode !== null || child.signalCode !== null, 10000, 'fixture shutdown');
  assert.equal(child.exitCode, 0, stderr);
  const raw = archives.raw(meeting.id);
  const finalStatus = JSON.parse(fs.readFileSync(path.join(raw, 'capture-status.json'), 'utf8'));
  const finalSnapshot = JSON.parse(fs.readFileSync(path.join(raw, 'capture-diagnostics.json'), 'utf8'));
  assert.equal(finalStatus.state, 'recorded');
  assert.equal(finalSnapshot.reason, 'stopped');
  assert.equal(finalStatus.diagnostics.reason, 'stopped');
  assert.deepEqual(finalStatus.diagnostics.counters, finalSnapshot.counters);
  assert.deepEqual(finalStatus.diagnostics.lastWrittenPTS, finalSnapshot.lastWrittenPTS);
  assertFinite(finalStatus);
  assertFinite(finalSnapshot);
  report.checks.finalCumulativeSnapshotPreserved = true;

  for (const snapshot of [...snapshots, finalSnapshot]) {
    assert.equal(snapshot.windowID, 1, 'diagnostics never replace the selected target');
    assert.equal(snapshot.fixture, true);
    assert.deepEqual(snapshot.targetProbe, {}, 'synthetic diagnostics never enumerate real windows');
    assert.deepEqual(Object.keys(counters(snapshot, 'received')).sort(), ['microphone', 'system', 'video']);
    assert.deepEqual(Object.keys(counters(snapshot, 'videoStatus')).sort(), ['blank', 'complete', 'idle', 'missing', 'started', 'stopped', 'suspended', 'unknown']);
    assert.deepEqual(Object.keys(counters(snapshot, 'dropped')).sort(), ['encoderBackpressure', 'invalidPTS', 'invalidSample', 'missingPixels', 'paused', 'videoUnavailable']);
    for (const group of ['received', 'videoStatus', 'dropped']) {
      for (const count of Object.values(counters(snapshot, group))) assert(Number.isSafeInteger(count) && count >= 0);
    }
    assert.equal(counters(snapshot, 'dropped').paused, 0);
    assert.equal(counters(snapshot, 'dropped').videoUnavailable, 0);
    assert(JSON.stringify(snapshot).length < 12000, 'diagnostic snapshot contains bounded metadata only');
  }
  for (let index = 1; index < snapshots.length; index++) {
    for (const group of ['received', 'videoStatus', 'dropped']) {
      for (const key of Object.keys(counters(snapshots[index], group))) {
        assert(counters(snapshots[index], group)[key] >= counters(snapshots[index - 1], group)[key], `${group}.${key} remains cumulative`);
      }
    }
    assert(snapshots[index].counters.videoFramesWritten >= snapshots[index - 1].counters.videoFramesWritten);
  }
  const events = jsonLines(path.join(raw, 'capture_events.jsonl'));
  const diagnostics = events.filter(event => event.event === 'capture-diagnostic');
  assert(diagnostics.length >= 3, 'periodic diagnostic samples are persisted');
  assert(diagnostics.length <= Math.ceil(finalSnapshot.elapsedHostSeconds / 2.5) + 3, 'metadata must not be emitted per frame');
  assert.equal(diagnostics.at(-1).reason, 'stopped');
  assert(!events.some(event => event.event === 'error'), 'instrumentation does not abort recording');
  for (const event of diagnostics) assertFinite(event);
  report.checks.boundedMetadataAndMonotonicCounters = { passed: true, eventCount: diagnostics.length };

  const manifest = archives.refresh(meeting.id);
  assert.equal(manifest.status, 'recorded');
  assert.equal(manifest.interruptedTail.length, 0);
  const videos = manifest.segments.filter(segment => segment.kind === 'video');
  assert(videos.length >= 2, 'video before suspension and after recovery is preserved');
  assert.equal(videos.reduce((sum, segment) => sum + segment.frames, 0), finalSnapshot.counters.videoFramesWritten,
    'diagnostic write count matches committed original video frames');
  const origin = manifest.timeline.originPTS.seconds;
  assert(videos[0].endPTS.seconds - origin <= 3.1, 'first unavailable frame still closes video at the existing boundary');
  assert(videos[1].startPTS.seconds - origin >= 10.9, 'recovery does not conceal the video gap');
  for (const source of ['microphone', 'system']) {
    const segments = manifest.segments.filter(segment => segment.kind === source);
    assert(segments.length >= 2);
    const records = segments.flatMap(segment => jsonLines(path.join(raw, segment.index)));
    assert(records.some(record => record.pts.seconds - origin >= 6 && record.pts.seconds - origin < 8), `${source} original PCM index covers callback loss`);
    assert(records.some(record => record.pts.seconds - origin >= 10 && record.pts.seconds - origin < 11), `${source} original PCM index covers invalid video PTS`);
  }
  report.checks.originalMediaAndAudioPTSRemainPresent = true;
  report.originalMedia = manifest.segments.map(segment => ({ file: segment.file, kind: segment.kind, frames: segment.frames,
    bytes: fs.statSync(path.join(raw, segment.file)).size, sha256: hash(path.join(raw, segment.file)) }));
  assert(report.originalMedia.every(segment => segment.frames > 0 && segment.bytes > 0));
  report.snapshots = snapshots;
  report.finalSnapshot = finalSnapshot;
  report.passed = true;
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: report.checks, dataPath: data, reportFile }, null, 2));
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  report.snapshots = snapshots;
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.error(`Diagnostic fixture failed; evidence retained at ${reportFile}`);
  throw error;
} finally {
  // Terminate only the child created above; leave its synthetic artifacts for
  // diagnosis, and never touch installed apps or the user's meeting archives.
  if (child && child.exitCode === null && child.signalCode === null && !spawnError) {
    child.kill('SIGTERM');
    const until = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
