// Real native writer, fabricated samples only. No SCK capture, permission
// request, cloud call or user archive access. Read raw timeline/events directly
// so an ArchiveStore recovery cannot mask the native regression.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = process.env.MEETING_CAPTURE_TEST_BINARY || path.join(root, '.build', 'archivecap');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-zero-pts-native-'));
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const lines = file => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function wait(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await sleep(50); }
  throw new Error('Zero PTS native regression timed out');
}
function segments(raw) {
  return fs.readdirSync(raw).filter(name => /^(video|system|microphone)-\d{6}\.json$/.test(name))
    .map(name => read(path.join(raw, name))).filter(value => value?.status === 'complete');
}
async function fixture(scenario, verifyLive) {
  const raw = path.join(data, scenario); fs.mkdirSync(raw);
  const child = spawn(binary, ['fixture', '--dir', raw, '--mic', '--system-audio', '--max-edge', '640',
    '--segment-seconds', '5', '--fixture-scenario', scenario], { stdio: 'ignore' });
  children.push(child);
  await wait(() => {
    if (child.exitCode !== null) throw new Error(`Fixture ${scenario} exited before media (${child.exitCode})`);
    return read(path.join(raw, 'timeline.json'));
  });
  await verifyLive(raw);
  const id = crypto.randomUUID(), command = path.join(raw, 'control', 'inbox', `${id}.json`);
  fs.writeFileSync(command + '.tmp', JSON.stringify({ command: 'stop' })); fs.renameSync(command + '.tmp', command);
  await wait(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0, scenario);
  return { raw, timeline: read(path.join(raw, 'timeline.json')),
    status: read(path.join(raw, 'capture-status.json')), events: lines(path.join(raw, 'capture_events.jsonl')), segments: segments(raw) };
}

const report = { syntheticOnly: true, requestedPermissions: false, dataPath: data,
  recorderSourceSHA256: hash(path.join(root, 'native', 'ArchiveCapture.swift')), checks: {} };
try {
  let originalOrigin, committedHashes;
  const zero = await fixture('zero-pts-stop', async raw => {
    originalOrigin = read(path.join(raw, 'timeline.json')).originPTS.seconds;
    assert(originalOrigin > 0);
    await wait(() => lines(path.join(raw, 'capture_events.jsonl')).find(event => event.event === 'frame-state' && event.status === 5));
    assert.equal(read(path.join(raw, 'timeline.json')).originPTS.seconds, originalOrigin,
      'a zero-PTS stopped callback must not rebase the raw media timeline');
    const committed = await wait(() => {
      const video = segments(raw).filter(segment => segment.kind === 'video'); return video.length && video;
    });
    committedHashes = committed.map(segment => [path.join(raw, segment.file), hash(path.join(raw, segment.file))]);
    await sleep(1300); // Independent audio must continue after the terminal video callback.
  });
  assert.equal(zero.timeline.originPTS.seconds, originalOrigin);
  assert.equal(zero.timeline.originPolicy, 'earliest-written-source-PTS');
  const timelineEvents = zero.events.filter(event => event.event === 'timeline');
  assert(timelineEvents.length > 0 && timelineEvents.every(event => event.originPTS.seconds === originalOrigin));
  const stoppedFrame = zero.events.find(event => event.event === 'frame-state' && event.status === 5);
  assert.equal(stoppedFrame.usable, false);
  assert.equal(stoppedFrame.samplePTS.seconds, 0, 'preserve the source control timestamp as diagnostic provenance');
  assert.equal(stoppedFrame.ptsSource, 'host-receipt');
  assert(stoppedFrame.pts.seconds - originalOrigin >= 1.8 && stoppedFrame.pts.seconds - originalOrigin < 3);
  const videoGap = zero.events.find(event => event.event === 'gap' && event.source === 'video');
  assert.equal(videoGap.pts.seconds, stoppedFrame.pts.seconds);
  assert.equal(videoGap.samplePTS.seconds, 0);
  const duration = zero.status.endPTS.seconds - originalOrigin;
  assert(duration >= 3.2 && duration < 10, 'duration must remain seconds, not host uptime');
  assert.equal(zero.status.state, 'recorded');
  const video = zero.segments.filter(segment => segment.kind === 'video');
  assert.equal(video.length, 1);
  assert.equal(video[0].endPTS.seconds, videoGap.pts.seconds);
  for (const source of ['microphone', 'system']) {
    const audio = zero.segments.filter(segment => segment.kind === source);
    assert(audio.length > 0 && audio.at(-1).endPTS.seconds > video[0].endPTS.seconds + 1);
    for (const segment of audio) {
      const index = lines(path.join(zero.raw, segment.index));
      assert(index.length > 0 && index.every(record => record.pts.seconds >= originalOrigin && record.frames > 0));
      assert.equal(index.reduce((sum, record) => sum + record.frames, 0), segment.frames);
    }
  }
  for (const [file, digest] of committedHashes) assert.equal(hash(file), digest, 'continued audio/finalization must not rewrite committed video');
  report.checks.zeroPTSStatusCannotRebase = { passed: true, originPTS: originalOrigin, durationSeconds: duration,
    videoEndSeconds: videoGap.pts.seconds - originalOrigin, preservedSamplePTS: stoppedFrame.samplePTS, committedVideoUnchanged: true };

  const reorder = await fixture('clock-reorder', () => sleep(500));
  const mic = reorder.segments.find(segment => segment.kind === 'microphone');
  const image = reorder.segments.find(segment => segment.kind === 'video');
  assert(Math.abs(image.startPTS.seconds - mic.startPTS.seconds - 0.05) < 0.0001);
  assert.equal(reorder.timeline.originPTS.seconds, mic.startPTS.seconds);
  assert(reorder.events.some(event => event.event === 'timeline' && event.rebased), 'earlier real media must still rebase the origin');
  report.checks.realOutOfOrderPTSStillRebases = { passed: true, sourceOffsetMs: 50 };
  const output = path.join(data, 'zero-pts-native-validation.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportFile: output }, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
