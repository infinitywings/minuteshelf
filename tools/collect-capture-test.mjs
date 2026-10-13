#!/usr/bin/env node
// Offline evidence collection only. Never controls Zoom, requests permissions,
// decodes media, contacts a model, or writes to the source archive.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { diagnoseCapture } from './diagnose-capture.mjs';

export const cases = {
  W0: ['share-start', 'content-change', 'share-stop'],
  W1: ['share-start', 'show-meeting', 'content-change', 'share-stop'],
  W2: ['content-change'], // Fresh, separately confirmed recording during sharing.
  L1: ['share-start', 'content-change', 'share-stop'], // Record the local shared source window itself.
  D1: ['share-start', 'content-change', 'share-stop'],
  R1: ['remote-share-start', 'content-change', 'highlight-change', 'final-content', 'remote-share-stop'],
  R2: ['remote-share-start', 'remote-share-stop', 'share-start', 'share-stop'],
  S1: ['sync-pulse']
};
const actions = new Set(Object.values(cases).flat());
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const seconds = value => number(value?.seconds ?? value);
const within = (root, file) => file === root || file.startsWith(root + path.sep);

function input(root, relative, optional = false) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) && optional) return null;
  const resolved = fs.realpathSync(file);
  if (!within(root, resolved) || !fs.lstatSync(file).isFile()) throw new Error(`Unsafe input: ${relative}`);
  return resolved;
}
function readJSON(root, relative, optional = false) {
  const file = input(root, relative, optional);
  if (!file) return null;
  if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error(`Oversized metadata: ${relative}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Invalid JSON: ${relative}`); }
}
function inventory(root) {
  const files = [input(root, 'manifest.json')];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // IPC commands/results can be consumed independently; they are not media.
      if (directory === path.join(root, 'raw') && entry.name === 'control') continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Archive raw inputs must not contain symbolic links');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(input(root, path.relative(root, file)));
      else throw new Error('Unsupported raw input type');
    }
  }
  const raw = fs.realpathSync(path.join(root, 'raw'));
  if (raw !== path.join(root, 'raw')) throw new Error('Archive raw directory must not be a symbolic link');
  visit(raw);
  return files.sort();
}
async function hashes(root) {
  const result = [];
  for (const file of inventory(root)) {
    const before = fs.statSync(file), hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    const after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      throw new Error('Archive input changed while being hashed; stop recording and retry');
    }
    result.push({ path: path.relative(root, file), bytes: after.size, sha256: hash.digest('hex') });
  }
  return result;
}
async function markers(root, caseID, origin) {
  const file = input(root, 'raw/capture_events.jsonl', true);
  if (!file) return [];
  const result = [], lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.event !== 'bookmark' || typeof event.text !== 'string') continue;
    const match = /^TEST:(W0|W1|W2|L1|D1|R1|R2|S1):([a-z-]+):(before|after)$/.exec(event.text);
    const time = seconds(event.pts);
    if (!match || match[1] !== caseID || !actions.has(match[2]) || time === null) continue;
    result.push({ action: match[2], edge: match[3], lineNumber, hostSeconds: time,
      sessionSeconds: origin === null ? null : time - origin });
  }
  return result;
}
function comparison(a, b) {
  if (!a || !b) return null;
  const counterDelta = (x, y) => number(x) === null || number(y) === null ? null : y - x;
  const delta = {
    videoCallbacks: counterDelta(a.counters.received.video, b.counters.received.video),
    videoFramesWritten: counterDelta(a.counters.videoFramesWritten, b.counters.videoFramesWritten),
    systemCallbacks: counterDelta(a.counters.received.system, b.counters.received.system),
    microphoneCallbacks: counterDelta(a.counters.received.microphone, b.counters.received.microphone),
    suspendedCallbacks: counterDelta(a.counters.videoStatus.suspended, b.counters.videoStatus.suspended),
    encoderBackpressure: counterDelta(a.counters.dropped.encoderBackpressure, b.counters.dropped.encoderBackpressure)
  };
  const targetID = a.captureKind === 'display' ? a.displayID : a.windowID;
  const sameTarget = Number.isSafeInteger(targetID) && targetID > 0 && a.captureKind === b.captureKind
    && (a.captureKind === 'display' ? a.displayID === b.displayID : a.windowID === b.windowID);
  return { startHostSeconds: a.hostSeconds, endHostSeconds: b.hostSeconds,
    durationSeconds: b.hostSeconds - a.hostSeconds, sameTarget,
    comparable: sameTarget && delta.videoCallbacks !== null && delta.videoFramesWritten !== null
      && !Object.values(delta).some(v => v !== null && v < 0), delta };
}
function actionEvidence(action, points, diagnostics) {
  const before = points.filter(m => m.action === action && m.edge === 'before');
  const after = points.filter(m => m.action === action && m.edge === 'after');
  const paired = before.length === 1 && after.length === 1 && before[0].hostSeconds <= after[0].hostSeconds;
  if (!paired) return { action, timing: 'missing-duplicate-or-reversed-bookmark-pair', before, after };
  const start = before[0].hostSeconds, end = after[0].hostSeconds;
  // These samples bracket the operator's action, not the exact Zoom event.
  const prior = diagnostics.findLast(d => d.hostSeconds <= start) ?? null;
  const subsequent = diagnostics.find(d => d.hostSeconds >= end) ?? null;
  const stable = diagnostics.filter(d => d.hostSeconds >= end + 3 && d.hostSeconds <= end + 18);
  const progress = comparison(stable[0], stable.at(-1));
  const adjacent = stable.slice(1).map((d, i) => comparison(stable[i], d));
  return { action, timing: 'operator-action-bracket', before: before[0], after: after[0],
    bracketDurationSeconds: end - start,
    nearestDiagnosticBefore: prior, nearestDiagnosticAfter: subsequent,
    diagnosticDistanceBeforeSeconds: prior ? start - prior.hostSeconds : null,
    diagnosticDistanceAfterSeconds: subsequent ? subsequent.hostSeconds - end : null,
    transitionComparison: comparison(prior, subsequent),
    stableObservation: { requestedWindowAfterActionSeconds: [3, 18], sampleCount: stable.length,
      enoughDuration: Boolean(stable.length >= 3 && progress && progress.durationSeconds >= 9 && progress.comparable
        && adjacent.every(interval => interval.comparable && interval.durationSeconds <= 6)
        && !stable.some(d => d.videoState === 'paused')), progress },
    note: 'Callbacks and writes are metadata. Decoded changing picture and installed-player checks remain required.' };
}

function mediaInspectionPlan(manifest, reports, origin, duration) {
  const segments = (Array.isArray(manifest.segments) ? manifest.segments : [])
    .filter(s => s.kind === 'video').map(s => ({
      // Do not turn arbitrary model/manifest text into decoder arguments.
      file: typeof s.file === 'string' && !path.isAbsolute(s.file) && path.normalize(s.file) === s.file
        && !s.file.split(path.sep).includes('..') && /\.(mp4|mov|m4v)$/.test(s.file) ? s.file : null,
      startHostSeconds: seconds(s.startPTS), endHostSeconds: seconds(s.endPTS)
    })).filter(s => s.file && s.startHostSeconds !== null && s.endHostSeconds !== null
      && s.endHostSeconds > s.startHostSeconds);
  const requests = [];
  const add = (label, host) => {
    const session = origin === null ? null : host - origin;
    const segment = segments.find(s => s.startHostSeconds <= host && host < s.endHostSeconds);
    requests.push({ label, requestedHostSeconds: host, requestedSessionSeconds: session,
      disposition: session === null || duration === null ? 'unknown-timeline'
        : session < 0 || session > duration ? 'outside-session'
          : segment ? 'decode-requested-not-yet-validated' : 'no-segment-at-requested-time',
      file: segment?.file ?? null, segmentTimeSeconds: segment ? host - segment.startHostSeconds : null });
  };
  for (const a of reports.filter(a => a.timing === 'operator-action-bracket')) {
    add(`${a.action}/before-2s`, a.before.hostSeconds - 2);
    add(`${a.action}/before+2s`, a.before.hostSeconds + 2);
    for (const offset of [-2, 2, 5, 15]) add(`${a.action}/after${offset >= 0 ? '+' : ''}${offset}s`, a.after.hostSeconds + offset);
  }
  if (origin !== null && duration !== null) add('near-end', origin + Math.max(0, duration - 0.3));
  return { segmentCount: segments.length, committedVideoSegments: segments, requestedFrames: requests,
    note: 'Metadata-derived decode requests only. Never substitute a neighboring segment for a gap; inspect the decoded content separately.' };
}

export async function collectCaptureTest(archive, caseID) {
  if (!Object.hasOwn(cases, caseID)) throw new Error('Choose case W0, W1, W2, L1, D1, R1, R2 or S1');
  const root = fs.realpathSync(archive);
  const status = readJSON(root, 'raw/capture-status.json', true);
  if (['starting', 'recording', 'paused', 'finalizing'].includes(status?.state)) {
    throw new Error('Wait for the recording to finish before collecting evidence');
  }
  const before = await hashes(root);
  const manifest = readJSON(root, 'manifest.json');
  const diagnostic = await diagnoseCapture(root);
  const final = readJSON(root, 'raw/capture-diagnostics.json', true);
  const origin = diagnostic.originPTSSeconds;
  const points = await markers(root, caseID, origin);
  const actionReports = cases[caseID].map(action => actionEvidence(action, points, diagnostic.diagnostics));
  const after = await hashes(root);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Archive inputs changed during collection; no report committed');
  const missing = actionReports.filter(a => a.timing !== 'operator-action-bracket').map(a => `${a.action}: bookmark pair unavailable`);
  for (const action of actionReports.filter(a => a.timing === 'operator-action-bracket')) {
    if (!action.stableObservation.enoughDuration) missing.push(`${action.action}: insufficient comparable observations in the 3-18s window`);
    if (action.diagnosticDistanceBeforeSeconds === null || action.diagnosticDistanceBeforeSeconds > 6
      || action.diagnosticDistanceAfterSeconds === null || action.diagnosticDistanceAfterSeconds > 6) {
      missing.push(`${action.action}: missing or distant boundary diagnostics`);
    }
  }
  if (!final || final.reason !== 'stopped') missing.push('Final stopped diagnostic snapshot unavailable');
  if (!status || !['recorded', 'partial'].includes(status.state)) missing.push('Terminal native status unavailable');
  const fixture = typeof final?.fixture === 'boolean' ? final.fixture
    : typeof status?.diagnostics?.fixture === 'boolean' ? status.diagnostics.fixture : null;
  return { schemaVersion: 1, collectedAt: new Date().toISOString(), caseID, archiveID: path.basename(root),
    scope: 'Offline metadata and streamed SHA-256 only; no media decoding, capture, model call or source mutation.',
    fixture, archiveStatus: ['recorded', 'partial', 'ready', 'saved'].includes(manifest.status) ? manifest.status : 'other-or-unknown',
    terminalNativeState: ['recorded', 'partial'].includes(status?.state) ? status.state : null,
    actionReports, markerCount: points.length, missingEvidence: missing, diagnostic,
    mediaInspectionPlan: mediaInspectionPlan(manifest, actionReports, origin, diagnostic.durationSeconds),
    inputIntegrity: { unchangedDuringCollection: true, algorithm: 'sha256',
      excludes: ['raw/control/ (transient command IPC)'], files: before },
    mediaValidation: 'pending-independent-decoding-and-content-inspection',
    installedPlaybackValidation: 'pending',
    limitations: ['The tool does not inspect screenshots or establish Zoom internal behavior.',
      'Bookmarks bracket operator actions; they do not timestamp the exact Zoom share transition.',
      'A missing marker or short hold is missing evidence, not a recording failure.',
      'A native window probe and its timestamp may lag a diagnostic snapshot; inspect observedAtHostSeconds.',
      'Stable nonblack pixels alone do not prove the correct content was recorded.'] };
}

export function saveBundle(archive, output, report) {
  const root = fs.realpathSync(archive), parent = fs.realpathSync(path.dirname(path.resolve(output)));
  const destination = path.join(parent, path.basename(output));
  if (within(root, destination)) throw new Error('Evidence output must be outside the entire source archive');
  const temporary = path.join(parent, `.capture-test-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // link is atomic and fails if the destination exists, including a symlink.
    fs.linkSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = {}, args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!['--archive', '--case', '--output'].includes(args[i]) || !args[i + 1]
        || args[i + 1].startsWith('--') || values[args[i]]) throw new Error('Invalid arguments');
      values[args[i]] = args[i + 1];
    }
    if (!values['--archive'] || !values['--case'] || !values['--output']) {
      throw new Error('Usage: node tools/collect-capture-test.mjs --archive <meeting-folder> --case <W0|W1|W2|L1|D1|R1|R2|S1> --output <new-report.json>');
    }
    const report = await collectCaptureTest(values['--archive'], values['--case']);
    saveBundle(values['--archive'], values['--output'], report);
    console.log(JSON.stringify({ caseID: report.caseID, fixture: report.fixture, markerCount: report.markerCount,
      missingEvidence: report.missingEvidence, originalInputsUnchanged: report.inputIntegrity.unchangedDuringCollection,
      mediaValidation: report.mediaValidation, installedPlaybackValidation: report.installedPlaybackValidation }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
