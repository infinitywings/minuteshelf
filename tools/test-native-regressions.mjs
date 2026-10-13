// Compiled capture + export regression tests. Every sample is fabricated;
// permissions are inspected only, never requested, and no SCK capture starts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { ArchiveStore, jsonLines } = require('../server/archive-store');
const { SessionManager } = require('../server/archive-session');
const { MeetingArtifacts } = require('../server/meeting-artifacts');
const { ProjectStore } = require('../server/project-store');
const { MediaExports, exportPlan } = require('../server/media-export');
const { defaults } = require('../server/archive-config');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-native-regressions-'));
const binary = path.join(root, '.build', 'archivecap'), exportBinary = path.join(root, '.build', 'archive-export');
const archives = new ArchiveStore(data), projects = new ProjectStore(data, archives);
const exports = new MediaExports(archives, new MeetingArtifacts(archives, projects));
const manager = new SessionManager(archives, defaults, binary), children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(100); }
  throw new Error('Native regression timed out');
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inspect = (file, times) => JSON.parse(execFileSync(exportBinary, ['--inspect', file, '--sample-times', times.join(',')], { encoding: 'utf8' }));
const report = { syntheticOnly: true, requestedPermissions: false, dataPath: data,
  recorderSourceSHA256: hash(path.join(root, 'native', 'ArchiveCapture.swift')), checks: {} };
async function fixture(scenario, ready) {
  const meeting = archives.create({ window: { id: 1, app: 'Fixture', title: 'Synthetic regression' }, microphone: true, systemAudio: false },
    { ...defaults.recording, maxLongEdgePixels: 640, segmentSeconds: 5 }, scenario);
  const child = spawn(binary, ['fixture', '--dir', archives.raw(meeting.id), '--mic', '--max-edge', '640',
    '--segment-seconds', '5', '--fixture-scenario', scenario], { detached: true, stdio: 'ignore' });
  children.push(child); child.unref();
  await wait(() => {
    if (child.exitCode !== null) throw new Error(`Fixture ${scenario} exited ${child.exitCode}`);
    return archives.status(meeting.id)?.state === 'recording';
  });
  await ready(meeting);
  await manager.stop(meeting.id);
  await wait(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0, scenario);
  const manifest = archives.refresh(meeting.id), plan = exportPlan(archives, meeting.id);
  const rawHashes = manifest.segments.map(segment => ({ path: path.join(archives.raw(meeting.id), segment.file), sha256: hash(path.join(archives.raw(meeting.id), segment.file)) }));
  const job = exports.start(meeting.id);
  const completed = await wait(() => {
    const value = exports.jobs(meeting.id).find(value => value.id === job.id);
    return ['ready', 'failed', 'interrupted'].includes(value?.status) && value;
  });
  assert.equal(completed.status, 'ready', JSON.stringify(completed));
  for (const entry of rawHashes) assert.equal(hash(entry.path), entry.sha256, 'export must preserve original bytes');
  return { meeting, manifest, plan, job, movie: path.join(archives.dir(meeting.id), 'exports', job.id, 'meeting.mp4') };
}
try {
  const permissions = JSON.parse(execFileSync(binary, ['permissions'], { encoding: 'utf8' }));
  assert(['granted', 'not-granted'].includes(permissions.screenRecording));
  assert(['granted', 'not-determined', 'denied', 'restricted'].includes(permissions.microphone));
  assert.equal(permissions.systemAudio, 'uses-screen-recording');
  assert.equal(permissions.accessibility, 'not-required');
  assert.throws(() => execFileSync(binary, ['request-permissions'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 2);
  assert.throws(() => execFileSync(binary, ['open-settings', '--permission', 'not-allowed'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 2);
  report.checks.permissionInspectionAndAllowlist = true;

  const clock = await fixture('clock-reorder', () => sleep(1500));
  const microphone = clock.manifest.segments.find(segment => segment.kind === 'microphone');
  const video = clock.manifest.segments.find(segment => segment.kind === 'video');
  assert(Math.abs(video.startPTS.seconds - microphone.startPTS.seconds - 0.05) < 0.0001);
  assert.equal(clock.manifest.timeline.originPTS.seconds, microphone.startPTS.seconds);
  assert(Math.abs(clock.plan.video[0].startSeconds - 0.05) < 0.0001);
  assert.equal(clock.plan.audio[0].spans[0].startSeconds, 0);
  assert(jsonLines(path.join(archives.raw(clock.meeting.id), 'capture_events.jsonl')).some(event => event.event === 'timeline' && event.rebased));
  const clockMedia = inspect(clock.movie, [0, 0.2, clock.plan.durationSeconds - 0.5]);
  assert(clockMedia.samples[0].meanRGB < 2, 'video remains black until its actual delayed start');
  assert(clockMedia.samples[0].audioRMS > 0.02, 'earlier audio must remain audible');
  assert(clockMedia.samples[1].meanRGB > 15);
  assert(Math.abs(clockMedia.durationSeconds - clock.plan.durationSeconds) < 0.1);
  report.checks.outOfOrderSourcePTSAndExport = { passed: true, sourceOffsetMs: 50, meetingId: clock.meeting.id, samples: clockMedia.samples };

  const gap = await fixture('frame-gaps', async meeting => {
    await wait(() => jsonLines(path.join(archives.raw(meeting.id), 'capture_events.jsonl')).some(event => event.event === 'gap-end' && event.source === 'video'));
    await sleep(800);
  });
  const events = jsonLines(path.join(archives.raw(gap.meeting.id), 'capture_events.jsonl'));
  assert(events.some(event => event.event === 'frame-state' && event.status === 2 && event.usable === false));
  assert(events.some(event => event.event === 'frame-state' && event.status === 3 && event.usable === false));
  assert(events.some(event => event.event === 'frame-state' && event.status === 1 && event.usable === false), 'idle after blank must not reuse pre-gap pixels');
  assert(gap.plan.video.length >= 2);
  assert(gap.plan.video[0].startSeconds + gap.plan.video[0].durationSeconds <= 1.001);
  assert(gap.plan.video[1].startSeconds >= 3.49);
  const gapMedia = inspect(gap.movie, [0.5, 1.5, 2.5, 3.2, 4]);
  assert(gapMedia.samples[0].meanRGB > 15 && gapMedia.samples[4].meanRGB > 15);
  for (const sample of gapMedia.samples.slice(1, 4)) assert(sample.meanRGB < 2, 'blank/suspended/idle gap must export black');
  for (const sample of gapMedia.samples) assert(sample.audioRMS > 0.02, 'independent microphone audio continues through video-only gaps');
  assert(Math.abs(gapMedia.durationSeconds - gap.plan.durationSeconds) < 0.1);
  report.checks.blankSuspendedIdleGapsAndExport = { passed: true, meetingId: gap.meeting.id, samples: gapMedia.samples };

  const healthStatuses = [];
  const health = await fixture('frame-health', async meeting => {
    for (const state of ['idle', 'suspended', 'waiting-for-frame', 'complete']) {
      const status = await wait(() => {
        const current = archives.status(meeting.id);
        return current?.videoState === state && current;
      }, 12000);
      const usable = state === 'idle' || state === 'complete';
      assert.equal(status.videoAvailable, usable, `${state} must report real frame availability`);
      assert.equal(status.videoWarning.length === 0, usable);
      if (state === 'suspended') { assert.match(status.videoWarning, /suspended.*Check the recording source/); assert.doesNotMatch(status.videoWarning, /Restore the selected window/); }
      if (state === 'waiting-for-frame') assert.match(status.videoWarning, /Waiting for a new video frame/);
      healthStatuses.push(status);
    }
    await sleep(800);
  });
  assert(healthStatuses[2].lastWrittenPTS.microphone.seconds > healthStatuses[1].lastWrittenPTS.microphone.seconds,
    'audio continues during a suspended video stream');
  assert.equal(healthStatuses[2].lastWrittenPTS.video.seconds, healthStatuses[1].lastWrittenPTS.video.seconds,
    'idle after suspension must not silently repeat pre-gap pixels');
  const healthMedia = inspect(health.movie, [0.5, 2, 4, 6, 7.5]);
  for (const index of [0, 1, 4]) assert(healthMedia.samples[index].meanRGB > 15, 'healthy static idle and recovered frames remain visible');
  for (const index of [2, 3]) assert(healthMedia.samples[index].meanRGB < 2, 'suspended and stale idle remain explicit video gaps');
  for (const sample of healthMedia.samples) assert(sample.audioRMS > 0.02);
  report.checks.liveFrameHealthAndRecovery = { passed: true, meetingId: health.meeting.id,
    states: healthStatuses.map(status => ({ state: status.videoState, available: status.videoAvailable, warning: status.videoWarning })), samples: healthMedia.samples };
  const reportFile = path.join(data, 'native-regressions.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportFile }, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  for (const { job } of exports.active()) process.kill(job.pid, 'SIGTERM');
}
