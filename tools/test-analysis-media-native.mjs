// Synthetic pixels and tones only. Does not request capture permissions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ArchiveStore } = require('../server/archive-store');
const { SessionManager } = require('../server/archive-session');
const { defaults } = require('../server/archive-config');
const { exportPlan } = require('../server/media-export');
const { prepareMedia } = require('../server/analysis-media');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-media-video-'));
const archives = new ArchiveStore(data), binary = path.resolve('.build/archivecap');
const manager = new SessionManager(archives, defaults, binary);
const meeting = archives.create({ window: { id: 1, app: 'Fixture', title: 'Synthetic analysis' }, microphone: true, systemAudio: true },
  { ...defaults.recording, maxLongEdgePixels: 640, segmentSeconds: 5 }, 'Analysis keyframe test');
let diagnostic = '';
const child = spawn(binary, ['fixture', '--dir', archives.raw(meeting.id), '--mic', '--system-audio', '--max-edge', '640', '--segment-seconds', '5'], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', data => { diagnostic = (diagnostic + data).slice(-5000); });
child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-5000); });
try {
  for (let count = 0; count < 100 && archives.status(meeting.id)?.state !== 'recording'; count++) {
    if (child.exitCode !== null) throw Error('Fixture exited: ' + diagnostic);
    await sleep(100);
  }
  assert.equal(archives.status(meeting.id)?.state, 'recording', diagnostic);
  await sleep(6100); await manager.stop(meeting.id);
  for (let count = 0; count < 100 && child.exitCode === null; count++) await sleep(100);
  assert.equal(child.exitCode, 0, diagnostic);
  const plan = exportPlan(archives, meeting.id), runDirectory = path.join(archives.dir(meeting.id), 'outputs', 'analysis-test');
  const result = await prepareMedia({ meetingRoot: archives.dir(meeting.id), runDirectory, plan, bookmarks: [1, 4.5] });
  assert(result.frames.length >= 2, 'Expected bookmark frames');
  assert.deepEqual([...new Set(result.audio.map(item => item.source))].sort(), ['microphone', 'system'], 'Expected both audio sources');
  assert(result.frames.some(frame => frame.bookmark && Math.abs(frame.sourceMs - 1000) < 250));
  assert(result.frames.some(frame => frame.bookmark && Math.abs(frame.sourceMs - 4500) < 250));
  for (const frame of result.frames) {
    assert(frame.sourceMs >= 0 && frame.sourceMs <= plan.durationSeconds * 1000);
    const bytes = fs.readFileSync(path.join(runDirectory, frame.path)); assert.equal(bytes.readUInt16BE(0), 0xffd8);
  }
  const report = { syntheticOnly: true, requestedPermissions: false, dataPath: data, plan, result };
  fs.writeFileSync('.build/analysis-media-native-validation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, sources: result.audio.map(item => item.source), frames: result.frames.length, samplesDecoded: result.coverage.samplesDecoded, dataPath: data }));
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
}
