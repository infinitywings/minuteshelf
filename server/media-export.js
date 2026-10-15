const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { atomicWrite, readJSON, jsonLines, isLive } = require('./archive-store');
const { relativeFile } = require('./meeting-artifacts');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const JITTER_SECONDS = 0.002;

// Map sample spans to PTS. Coalesce only if accumulated drift stays below 2ms;
// pauses/discontinuities create new spans, never disappear by concatenation.
function audioSpans(segment, records, origin) {
  if (!(segment.sampleRate > 0) || !Number.isSafeInteger(segment.frames) || segment.frames < 1) throw fail('Audio format or frame count is missing.');
  if (!records.length) throw fail(`Audio is missing its PTS index: ${segment.file}`);
  const spans = []; let previousFrame = 0;
  for (const record of records) {
    if (!Number.isFinite(record.pts?.seconds) || !Number.isSafeInteger(record.frameOffset) || !Number.isSafeInteger(record.frames)
      || record.frames < 1 || record.frameOffset !== previousFrame || record.frameOffset + record.frames > segment.frames) throw fail(`The audio PTS index is not contiguous: ${segment.file}`);
    const start = record.pts.seconds - origin;
    if (start < -JITTER_SECONDS) throw fail('Audio PTS precedes the session origin.');
    const last = spans.at(-1), prediction = last && last.startSeconds + last.frames / segment.sampleRate;
    if (last && Math.abs(start - prediction) <= JITTER_SECONDS) last.frames += record.frames;
    else spans.push({ startSeconds: Math.max(0, start), frameOffset: record.frameOffset, frames: record.frames });
    previousFrame = record.frameOffset + record.frames;
  }
  if (previousFrame !== segment.frames) throw fail(`The audio PTS index does not cover the complete file: ${segment.file}`);
  return spans;
}
function exportPlan(archives, id, { audioSources = ['system', 'microphone'] } = {}) {
  const manifest = archives.refresh(id);
  if (isLive(archives.status(id)) || ['starting', 'recording', 'paused', 'finalizing'].includes(manifest.status)) throw fail('Stop and save the recording before exporting.', 409);
  if (!Array.isArray(audioSources) || audioSources.some(s => !['system', 'microphone'].includes(s))) throw fail('Invalid audio source.');
  const origin = manifest.timeline?.originPTS?.seconds;
  if (!Number.isFinite(origin)) throw fail('The recording has no unified timeline and cannot be merged safely.');
  const segments = [...manifest.segments, ...(manifest.recovered || [])].filter(s => s.kind === 'video' || audioSources.includes(s.kind));
  const video = [], audio = []; let end = origin;
  for (const s of segments) {
    if (!Number.isFinite(s.startPTS?.seconds) || !Number.isFinite(s.endPTS?.seconds) || s.endPTS.seconds <= s.startPTS.seconds) throw fail('Invalid media time range.');
    const directory = s.recovered ? 'derived/recovery' : 'raw', relative = `${directory}/${s.file}`;
    relativeFile(archives.dir(id), relative);
    const item = { path: relative, startSeconds: s.startPTS.seconds - origin, durationSeconds: s.endPTS.seconds - s.startPTS.seconds };
    if (item.startSeconds < -JITTER_SECONDS) throw fail('Media PTS precedes the session origin.');
    item.startSeconds = Math.max(0, item.startSeconds); end = Math.max(end, s.endPTS.seconds);
    if (s.kind === 'video') video.push(item);
    else {
      const records = jsonLines(relativeFile(archives.dir(id), `raw/${s.index}`));
      // Recovered WAVs may have an unfinished last original PTS entry.
      const complete = s.recovered ? records.filter(r => r.frameOffset + r.frames <= s.frames) : records;
      audio.push({ ...item, source: s.kind, sampleRate: s.sampleRate, spans: audioSpans(s, complete, origin) });
    }
  }
  if (!video.length && !audio.length) throw fail('No committed media is available to export.');
  video.sort((a, b) => a.startSeconds - b.startSeconds);
  const usedSources = [...new Set(audio.map(a => a.source))];
  const durationSeconds = Math.max(end - origin, manifest.durationSeconds || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) throw fail('Unsupported meeting duration.');
  if (audio.reduce((n, a) => n + a.spans.length, 0) > 20000) throw fail('The timeline is too fragmented. Check its PTS before exporting; no potentially unsynchronized file was generated.');
  return { schemaVersion: 'meeting-export-plan-1', meetingId: id, originPTS: origin, durationSeconds,
    video, audio, audioSources: usedSources, mixedAudioGainPerSource: usedSources.length > 1 ? 0.5 : 1,
    jitterToleranceMs: JITTER_SECONDS * 1000, gapPolicy: 'preserve-time-black-video-silent-audio', knownGaps: manifest.gaps,
    interruptedTail: manifest.interruptedTail, rawUnchanged: true };
}
function workerLive(state) {
  if (!state?.pid || !['queued', 'processing'].includes(state.status)) return false;
  try { process.kill(state.pid, 0); } catch { return false; }
  const command = spawnSync('/bin/ps', ['-p', String(state.pid), '-o', 'comm='], { encoding: 'utf8' }).stdout?.trim() || '';
  return /(?:^|\/)archive-export$/.test(command);
}
function playbackRevision(archives, manifest) {
  const root = archives.dir(manifest.id);
  const audio = [...manifest.segments, ...(manifest.recovered || [])].filter(s => ['system', 'microphone'].includes(s.kind));
  const files = audio.map(s => {
    const media = relativeFile(root, `${s.recovered ? 'derived/recovery' : 'raw'}/${s.file}`);
    const index = relativeFile(root, `raw/${s.index}`);
    const signature = file => { const stat = fs.statSync(file); return [stat.size, stat.mtimeMs]; };
    return [s.kind, s.file, s.startPTS, s.endPTS, s.frames, s.sampleRate, signature(media), signature(index)];
  }).sort((a, b) => a[1].localeCompare(b[1]));
  return crypto.createHash('sha256').update(JSON.stringify({ version: 1, duration: manifest.durationSeconds, origin: manifest.timeline?.originPTS, files })).digest('hex');
}
class MediaExports {
  constructor(archives, artifacts, { binary = path.join(__dirname, '..', '.build', 'archive-export'), spawnWorker = spawn } = {}) {
    this.archives = archives; this.artifacts = artifacts; this.binary = binary; this.spawnWorker = spawnWorker;
    this.inFlight = new Set();
  }
  jobs(id) {
    this.archives.manifest(id);
    return this.jobStates(id);
  }
  jobStates(id) {
    // Worker lifecycle is independent of the meeting manifest. A damaged old
    // archive must not prevent cancelling live exports for a new recording.
    const root = path.join(this.archives.dir(id), 'exports');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => /^[a-f0-9-]{36}$/.test(id)).map(jobId => {
      const file = path.join(root, jobId, 'export-status.json'), state = readJSON(file);
      if (!state) return null;
      if (['queued', 'processing'].includes(state.status) && !workerLive(state)) {
        // The independent worker can commit its terminal status and exit
        // between our initial read and the PID check. Preserve that commit.
        const latest = readJSON(file);
        if (!latest || !['queued', 'processing'].includes(latest.status) || latest.pid !== state.pid) return latest;
        latest.status = 'interrupted'; latest.error = 'Export was interrupted. Try exporting again; the originals are preserved.';
        atomicWrite(file, JSON.stringify(latest, null, 2));
        return latest;
      }
      return state;
    }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  active() { return this.archives.ids().flatMap(id => this.jobStates(id).filter(workerLive).map(job => ({ meetingId: id, job }))); }
  playback(id, { create = false } = {}) {
    const manifest = this.archives.refresh(id);
    if (['starting', 'recording', 'paused', 'finalizing'].includes(manifest.status) || isLive(this.archives.status(id))) return { status: 'recording' };
    if (![...manifest.segments, ...(manifest.recovered || [])].some(s => ['system', 'microphone'].includes(s.kind))) return { status: 'video-only' };
    const revision = playbackRevision(this.archives, manifest);
    const job = this.jobStates(id).find(j => j.purpose === 'playback' && j.inputRevision === revision);
    const audio = job?.files?.find(f => f.path === `exports/${job.id}/recording.m4a`);
    if (job?.status === 'ready' && audio) {
      try {
        const file = relativeFile(this.archives.dir(id), audio.path);
        if (fs.statSync(file).size > 0) return { status: 'ready', revision, jobId: job.id, path: audio.path, durationSeconds: manifest.durationSeconds };
      } catch { /* Rebuild a missing cache; raw recordings are unchanged. */ }
    }
    if (job && ['queued', 'processing'].includes(job.status)) return { status: 'preparing', revision, jobId: job.id, progress: job.progress || 0 };
    if (create) {
      try {
        const started = this.start(id, { audioOnly: true, purpose: 'playback', inputRevision: revision });
        return { status: 'preparing', revision, jobId: started.id, progress: 0 };
      } catch (error) { if (error.statusCode === 409) return { status: 'blocked', error: error.message }; throw error; }
    }
    return { status: job?.status === 'ready' ? 'missing' : job?.status || 'missing', revision, error: job?.error };
  }
  start(id, options = {}) {
    if (!fs.existsSync(this.binary)) throw fail('Build the media export helper with npm run build:native first.');
    if (this.archives.active().length || this.inFlight.size || this.active().length) throw fail('A recording or media export is running. Try again later.', 409);
    const plan = exportPlan(this.archives, id, options), root = this.artifacts.ensure(id), jobId = crypto.randomUUID();
    // A playback cache merges every captured audio source once, retaining PTS
    // gaps. It never waits for full-resolution video re-encoding.
    if (options.audioOnly === true) plan.video = [];
    const directory = path.join(root, 'exports', jobId); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(directory, 'export-plan.json'), JSON.stringify(plan, null, 2));
    const stateFile = path.join(directory, 'export-status.json'), createdAt = new Date().toISOString();
    const state = { id: jobId, meetingId: id, createdAt, status: 'queued', progress: 0, files: [],
      ...(options.purpose === 'playback' ? { purpose: 'playback', inputRevision: options.inputRevision } : {}) };
    atomicWrite(stateFile, JSON.stringify(state, null, 2));
    const log = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    try {
      const child = this.spawnWorker(this.binary, ['--archive', root, '--job', jobId], { detached: true, stdio: ['ignore', log, log] });
      this.inFlight.add(id);
      state.pid = child.pid; atomicWrite(stateFile, JSON.stringify(state, null, 2));
      child.on('error', error => { const latest = readJSON(stateFile, state); latest.status = 'failed'; latest.error = error.message; atomicWrite(stateFile, JSON.stringify(latest, null, 2)); });
      child.on('close', code => {
        try {
          const latest = readJSON(stateFile, state);
          if (['queued', 'processing'].includes(latest.status)) { latest.status = 'interrupted'; latest.error = `Export did not complete (exit ${code}); the originals are preserved.`; atomicWrite(stateFile, JSON.stringify(latest, null, 2)); }
        } finally { this.inFlight.delete(id); }
      });
      child.unref(); return state;
    } finally { fs.closeSync(log); }
  }
  cancelForRecording() {
    for (const { meetingId, job } of this.active()) {
      try { process.kill(job.pid, 'SIGTERM'); } catch {}
      const stateFile = path.join(this.archives.dir(meetingId), 'exports', job.id, 'export-status.json');
      atomicWrite(stateFile, JSON.stringify({ ...job, status: 'interrupted', error: 'Export stopped to prioritize a new recording. You can export again later.' }, null, 2));
    }
  }
}
module.exports = { MediaExports, exportPlan, audioSpans, workerLive };
