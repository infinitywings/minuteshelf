const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { effectiveTimeline } = require('./archive-timeline');

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function statIfPresent(file) {
  try { return fs.statSync(file); } catch (error) {
    // Native commits rename temporary files while Node inventories the directory.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function isManifestError(error) { return ['MANIFEST_MISSING', 'MANIFEST_INVALID'].includes(error.code); }
function jsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { return line ? [JSON.parse(line)] : []; } catch { return []; } // interrupted last line
  });
}
function isLive(status) {
  if (!status || !['starting', 'recording', 'paused', 'finalizing'].includes(status.state)) return false;
  try { process.kill(status.pid, 0); } catch { return false; }
  // A stalled heartbeat must block a second recording while its host lives.
  // Verify stale PIDs to avoid confusing PID reuse with the original host.
  if (Date.now() - Date.parse(status.updatedAt) > 15000) {
    const { spawnSync } = require('node:child_process');
    const command = spawnSync('/bin/ps', ['-p', String(status.pid), '-o', 'comm='], { encoding:'utf8' }).stdout?.trim() || '';
    return /(?:^|\/)archivecap$/.test(command);
  }
  return true;
}
class ArchiveStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'meetings');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  dir(id) {
    if (!/^[a-z0-9-]{1,100}$/.test(id)) throw new Error('Invalid meeting ID');
    return path.join(this.root, id);
  }
  raw(id) { return path.join(this.dir(id), 'raw'); }
  manifest(id) {
    let value;
    try { value = JSON.parse(fs.readFileSync(path.join(this.dir(id), 'manifest.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('The meeting manifest is missing. Existing files are preserved; restore the manifest.'), { code: 'MANIFEST_MISSING', statusCode: 404 });
      if (error instanceof SyntaxError) throw Object.assign(new Error('The meeting manifest is damaged. Existing files are preserved; repair or restore the manifest.'), { code: 'MANIFEST_INVALID', statusCode: 422 });
      throw error;
    }
    if (!value || value.id !== id || typeof value.title !== 'string' || typeof value.status !== 'string'
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
      throw Object.assign(new Error('The meeting manifest format is invalid. Existing files are preserved; repair or restore the manifest.'), { code: 'MANIFEST_INVALID', statusCode: 422 });
    }
    return value;
  }
  save(value) { atomicWrite(path.join(this.dir(value.id), 'manifest.json'), JSON.stringify(value, null, 2)); }
  create(selection, preset, title) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}-${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(this.raw(id), { recursive: true, mode: 0o700 });
    for (const directory of ['context/documents', 'outputs', 'exports']) fs.mkdirSync(path.join(this.dir(id), directory), { recursive: true, mode: 0o700 });
    const manifest = { schemaVersion: 1, id, title: String(title || 'Untitled meeting').slice(0, 300),
      createdAt: new Date().toISOString(), status: 'starting', selection, preset,
      clock: 'SCK-presentation-time', upstreamCommit: '8d048f7034b8ff75b04640f48cf0c4f569b3c274',
      recorderRevision: 'archive-recorder-0.1', liveInference: false, processingStatus: 'unavailable',
      segments: [], gaps: [], interruptedTail: [], audioScope: selection.systemAudio ? 'all-system' : 'disabled' };
    this.save(manifest);
    atomicWrite(path.join(this.dir(id), 'user_notes.md'), '');
    atomicWrite(path.join(this.dir(id), 'README.md'), `# ${manifest.title.replace(/[\r\n]/g, ' ')}\n\nMinuteShelf meeting ID: ${id}\n\nraw/: Original media; context/: Background documents and RKA; outputs/: Generated content; exports/: Video with audio and audio exports; user_notes.md: Your notes.\n`);
    return manifest;
  }
  ids() {
    // Include archives with a missing manifest: their independent host may live.
    return fs.readdirSync(this.root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-z0-9-]{1,100}$/.test(entry.name)).map(entry => entry.name);
  }
  status(id) { return readJSON(path.join(this.raw(id), 'capture-status.json')); }
  unavailable(id, error, capture = this.status(id)) {
    return { id, title: 'Unavailable meeting', createdAt: (statIfPresent(this.dir(id))?.mtime || new Date(0)).toISOString(),
      status: 'unavailable', archiveError: { code: error.code, message: error.message }, capture,
      segments: [], gaps: [], interruptedTail: [] };
  }
  refresh(id) {
    const manifest = this.manifest(id);
    const raw = this.raw(id);
    const events = jsonLines(path.join(raw, 'capture_events.jsonl'));
    const status = this.status(id);
    const live = isLive(status);
    const files = fs.readdirSync(raw);
    const metadata = files.filter(f => /^(video|microphone|system)-\d{6}\.json$/.test(f)).map(f => readJSON(path.join(raw, f))).filter(Boolean);
    manifest.timeline = readJSON(path.join(raw, 'timeline.json'));
    manifest.segments = metadata.flatMap(m => {
      if (m.status !== 'complete') return [];
      const stat = statIfPresent(path.join(raw, m.file));
      return stat?.isFile() && stat.size > 0 ? [{ ...m, bytes: stat.size }] : [];
    });
    manifest.timeline = effectiveTimeline(manifest.timeline, manifest.segments, events);
    manifest.interruptedTail = live ? [] : files.filter(f => /\.partial\.(mp4|wav)$/.test(f) && statIfPresent(path.join(raw, f)));
    manifest.gaps = events.filter(e => ['gap', 'gap-end', 'error', 'warning', 'pause', 'resume', 'mic'].includes(e.event)
      || (e.event === 'frame-state' && !e.usable));
    manifest.bookmarks = events.filter(e => e.event === 'bookmark');
    const stopped = events.findLast(e => e.event === 'stopped');
    if (live) manifest.status = status.state;
    else if (stopped) manifest.status = stopped.clean && !manifest.interruptedTail.length ? 'recorded' : 'partial';
    else if (manifest.status !== 'starting' || Date.now() - Date.parse(manifest.createdAt) > 30000) {
      manifest.status = manifest.segments.length ? 'partial' : 'failed';
      if (!manifest.gaps.some(g => g.reason === 'native-interrupted')) manifest.gaps.push({ event: 'gap', reason: 'native-interrupted', detail: 'Recording was interrupted. Uncommitted media may need recovery; the end of the gap is unknown.' });
    }
    manifest.capture = status;
    const origin = manifest.timeline?.originPTS?.seconds;
    const end = stopped?.endPTS?.seconds ?? status?.clockPTS?.seconds;
    manifest.durationSeconds = Number.isFinite(origin) && Number.isFinite(end) ? Math.max(0, end - origin) : 0;
    manifest.bytes = files.reduce((n, f) => { const stat = statIfPresent(path.join(raw, f)); return n + (stat?.isFile() ? stat.size : 0); }, 0);
    this.save(manifest);
    return manifest;
  }
  list() {
    return this.ids().map(id => {
      try { return this.refresh(id); } catch (error) {
        if (!isManifestError(error)) throw error;
        return this.unavailable(id, error);
      }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  active() {
    // Recording safety depends on the native host, never on readable history.
    return this.ids().flatMap(id => {
      const capture = this.status(id), live = isLive(capture);
      let manifest;
      try { manifest = this.manifest(id); } catch (error) {
        if (!isManifestError(error)) throw error;
        return live ? [{ ...this.unavailable(id, error, capture), status: capture.state }] : [];
      }
      if (live) return [{ ...manifest, status: capture.state, capture }];
      // A newly launched native host has a brief interval before its first status.
      if ((!capture || capture.state === 'starting') && manifest.status === 'starting' && Date.now() - Date.parse(manifest.createdAt) <= 30000) return [manifest];
      return [];
    });
  }
  meeting(id) { return { manifest: this.refresh(id), notes: fs.readFileSync(path.join(this.dir(id), 'user_notes.md'), 'utf8') }; }
  notes(id, value) { this.manifest(id); atomicWrite(path.join(this.dir(id), 'user_notes.md'), value); }
  media(id, name) {
    const manifest = this.refresh(id);
    const segment = [...manifest.segments, ...(manifest.recovered || [])].find(s => s.file === name);
    if (!segment || !/^(video|microphone|system)-\d{6}(?:-recovered)?\.(mp4|wav)$/.test(name)) throw Object.assign(new Error('Committed media not found'), { statusCode: 404 });
    return path.join(segment.recovered ? path.join(this.dir(id), 'derived', 'recovery') : this.raw(id), name);
  }
}

// Restore an interrupted WAV into a DERIVED copy. Original bytes are retained.
// AVAudioFile may write RIFF/WAVE with JUNK/fmt chunks before data.
function recoverWav(input, output) {
  const bytes = fs.readFileSync(input);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Unsupported WAV container');
  let offset = 12, blockAlign = 0, dataOffset = 0, dataSizeOffset = 0;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (kind === 'fmt ' && size >= 16 && offset + 8 + size <= bytes.length) blockAlign = bytes.readUInt16LE(offset + 20);
    if (kind === 'data') { dataOffset = offset + 8; dataSizeOffset = offset + 4; break; }
    offset += 8 + size + (size % 2);
  }
  if (!blockAlign || !dataOffset) throw new Error('WAV format/data chunk missing');
  const completeBytes = Math.floor((bytes.length - dataOffset) / blockAlign) * blockAlign;
  if (!completeBytes) throw new Error('No complete audio samples to recover');
  const result = Buffer.from(bytes.subarray(0, dataOffset + completeBytes));
  result.writeUInt32LE(result.length - 8, 4); result.writeUInt32LE(completeBytes, dataSizeOffset);
  atomicWrite(output, result);
  return { frames: completeBytes / blockAlign, truncatedBytes: bytes.length - result.length, bytes: result.length };
}
module.exports = { ArchiveStore, atomicWrite, readJSON, jsonLines, isLive, recoverWav };
