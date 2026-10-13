// Actual AVFoundation mux/export verification with synthetic pixels/tone only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { ArchiveStore } = require('../server/archive-store');
const { SessionManager } = require('../server/archive-session');
const { ProjectStore } = require('../server/project-store');
const { MeetingArtifacts } = require('../server/meeting-artifacts');
const { MediaExports, exportPlan } = require('../server/media-export');
const { defaults } = require('../server/archive-config');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), data = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-export-validation-'));
const exportBinary = process.env.MEETING_EXPORT_TEST_BINARY || path.join(root, '.build', 'archive-export');
const archives = new ArchiveStore(data), projects = new ProjectStore(data, archives), artifacts = new MeetingArtifacts(archives, projects);
const exports = new MediaExports(archives, artifacts, { binary: exportBinary }), manager = new SessionManager(archives, defaults);
const m = archives.create({ window: { id: 1, app: 'Fixture', title: 'Synthetic export validation' }, microphone: true, systemAudio: true }, defaults.recording, '合成数据 · 会议资料和音视频合并');
const child = spawn(path.join(root, '.build', 'archivecap'), ['fixture', '--dir', archives.raw(m.id), '--mic', '--system-audio', '--segment-seconds', '5'], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(100); } throw new Error('Export validation timed out'); }
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  await wait(() => archives.status(m.id)?.state === 'recording');
  await sleep(1200); await manager.command(m.id, 'pause'); await sleep(1200); await manager.command(m.id, 'resume');
  await sleep(1300); await manager.stop(m.id);
  const manifest = archives.refresh(m.id), before = manifest.segments.map(s => [s.file, hash(path.join(archives.raw(m.id), s.file))]);
  const plan = exportPlan(archives, m.id), pause = manifest.gaps.find(e => e.event === 'pause'), resume = manifest.gaps.find(e => e.event === 'resume');
  const gap = ((pause.pts.seconds + resume.pts.seconds) / 2) - plan.originPTS;
  const job = exports.start(m.id), completed = await wait(() => { const job = exports.jobs(m.id)[0]; return ['ready','failed','interrupted'].includes(job.status) && job; });
  assert.equal(completed.status, 'ready', completed.error);
  const inspect = (file, times = [0.5, gap, manifest.durationSeconds - 0.5]) => JSON.parse(execFileSync(exportBinary, ['--inspect', file, '--sample-times', times.join(',')], { encoding: 'utf8' }));
  const video = inspect(path.join(archives.dir(m.id), 'exports', job.id, 'meeting.mp4'));
  const audio = inspect(path.join(archives.dir(m.id), 'exports', job.id, 'recording.m4a'));
  assert.equal(video.videoTracks, 1); assert.equal(video.audioTracks, 1); assert.equal(audio.videoTracks, 0); assert.equal(audio.audioTracks, 1);
  assert(video.videoCodecs.includes('avc1')); assert(video.audioCodecs.includes('aac '));
  assert(Math.abs(video.durationSeconds - manifest.durationSeconds) < 0.1);
  assert(Math.abs(audio.durationSeconds - manifest.durationSeconds) < 0.1);
  assert(video.samples[0].meanRGB > 15); assert(video.samples[1].meanRGB < 2); assert(video.samples[2].meanRGB > 15);
  assert(video.samples[0].audioRMS > 0.02); assert(video.samples[1].audioRMS < 0.001); assert(video.samples[2].audioRMS > 0.02);
  assert(audio.samples[1].audioRMS < 0.001);
  // A long unavailable-picture tail must contain decodable black frames, even
  // while late audio continues. No later video clip exists to extend the track.
  const tailJob = crypto.randomUUID(), tailDirectory = path.join(archives.dir(m.id), 'exports', tailJob);
  fs.mkdirSync(tailDirectory, { recursive: true });
  const tailAudio = plan.audio.find(part => part.source === 'system') || plan.audio[0];
  const tailSpans = tailAudio.spans.map(span => ({ ...span, startSeconds: 26 + span.startSeconds - tailAudio.spans[0].startSeconds }));
  const tailDuration = Math.max(...tailSpans.map(span => span.startSeconds + span.frames / tailAudio.sampleRate));
  const tailPlan = { ...plan, durationSeconds: tailDuration,
    video: [{ ...plan.video[0], startSeconds: 11.911, durationSeconds: 1.019312 }],
    audio: [{ ...tailAudio, spans: tailSpans }], mixedAudioGainPerSource: 1 };
  fs.writeFileSync(path.join(tailDirectory, 'export-plan.json'), JSON.stringify(tailPlan));
  fs.writeFileSync(path.join(tailDirectory, 'export-status.json'), JSON.stringify({ id: tailJob, createdAt: new Date().toISOString(), status: 'queued', files: [] }));
  execFileSync(exportBinary, ['--archive', archives.dir(m.id), '--job', tailJob], { encoding: 'utf8' });
  const trailingGap = inspect(path.join(tailDirectory, 'meeting.mp4'), [0.5, 12.5, 15, 26, tailDuration - 0.2]);
  assert(Math.abs(trailingGap.durationSeconds - tailDuration) < 0.1);
  assert(trailingGap.samples[1].meanRGB > 15);
  for (const index of [0, 2, 3, 4]) assert(trailingGap.samples[index].meanRGB < 2, `Gap at ${trailingGap.samples[index].seconds}s must decode as black`);
  assert(trailingGap.samples[3].audioRMS > 0.02, 'Late audio must remain audible after video ends');
  for (const [file, digest] of before) assert.equal(hash(path.join(archives.raw(m.id), file)), digest);
  const report = { checkedAt: new Date().toISOString(), syntheticOnly: true, dataPath: data, meetingId: m.id, exportId: job.id,
    durationSeconds: manifest.durationSeconds, pauseMidpointSeconds: gap, video, audio, trailingGap,
    checks: { mp4HasVideoAndMixedAudio: true, standaloneM4a: true, durationPreserved: true, gapVideoIsBlack: true, gapAudioIsSilent: true,
      beforeAfterGapPlayable: true, longTrailingGapDecodesBlack: true, lateAudioAfterVideoPreserved: true, rawHashesUnchanged: true }, exporterSourceSHA256: hash(path.join(root, 'native', 'ArchiveExport.swift')) };
  const reportFile = path.join(root, '.build', 'reports', 'export-validation.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); for (const { job } of exports.active()) process.kill(job.pid, 'SIGTERM'); }
