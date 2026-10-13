#!/usr/bin/env node
// Reads capture metadata only. No media decoding, model calls, or archive mutation.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiveTimeline from '../server/archive-timeline.js';

const { effectiveTimeline } = archiveTimeline;

const sources = ['video', 'system', 'microphone'];
const statuses = ['complete', 'idle', 'suspended', 'blank', 'started', 'stopped', 'missing', 'unknown'];
const drops = ['paused', 'invalidSample', 'invalidPTS', 'videoUnavailable', 'missingPixels', 'encoderBackpressure'];
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const seconds = value => number(value?.seconds ?? value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const map = (keys, object, sanitize = count) => Object.fromEntries(keys.map(key => [key, sanitize(object?.[key])]));
const within = (root, file) => file === root || file.startsWith(root + path.sep);

function safeInput(root, relative) {
  const file = path.join(root, relative);
  try {
    const resolved = fs.realpathSync(file);
    if (!within(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error('Unsafe metadata input');
    return resolved;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot safely read ${relative}`);
  }
}

function jsonInput(root, relative, issues) {
  const file = safeInput(root, relative);
  if (!file) return { present: false, value: null };
  try { return { present: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { issues.push(`${relative} is not valid JSON`); return { present: true, value: null }; }
}

function diagnostic(raw) {
  if (raw?.schemaVersion !== 1 || seconds(raw.pts) === null) return null;
  const probe = raw.targetProbe;
  return {
    schemaVersion: 1,
    reason: ['periodic', 'stopped'].includes(raw.reason) ? raw.reason : 'unknown',
    hostSeconds: seconds(raw.pts), elapsedHostSeconds: number(raw.elapsedHostSeconds),
    windowID: count(raw.windowID),
    captureKind: raw.captureKind === 'display' ? 'display' : 'window', displayID: count(raw.displayID),
    videoState: [...statuses, 'unavailable', 'waiting-for-frame', 'paused', 'starting'].includes(raw.videoState) ? raw.videoState : 'unknown',
    counters: { received: map(sources, raw.counters?.received), videoStatus: map(statuses, raw.counters?.videoStatus),
      dropped: map(drops, raw.counters?.dropped), videoFramesWritten: count(raw.counters?.videoFramesWritten) },
    lastReceivedHostPTS: map(sources, raw.lastReceivedHostPTS, seconds),
    lastReceivedMediaPTS: map(sources, raw.lastReceivedMediaPTS, seconds),
    lastWrittenPTS: map(sources, raw.lastWrittenPTS, seconds),
    targetProbe: probe && typeof probe === 'object' ? {
      observedAtHostSeconds: seconds(probe.observedAtHostPTS), windowID: count(probe.windowID),
      captureKind: probe.captureKind === 'display' ? 'display' : 'window', displayID: count(probe.displayID),
      exists: typeof probe.exists === 'boolean' ? probe.exists : null,
      isOnScreen: typeof probe.isOnScreen === 'boolean' ? probe.isOnScreen : null,
      frame: probe.frame ? map(['x', 'y', 'width', 'height'], probe.frame, number) : null,
      sameApplicationWindowIDs: Array.isArray(probe.sameApplicationWindowIDs)
        ? [...new Set(probe.sameApplicationWindowIDs.filter(id => count(id) !== null))] : [],
      // Error text and window titles can contain private content; never echo them.
      errorReported: Boolean(probe.error)
    } : null
  };
}

function difference(a, b) {
  if (a === null || b === null) return null;
  return b - a;
}
function deltas(a, b) {
  const result = {};
  for (const [group, keys] of [['received', sources], ['videoStatus', statuses], ['dropped', drops]]) {
    result[group] = Object.fromEntries(keys.map(key => [key, difference(a.counters[group][key], b.counters[group][key])]));
  }
  result.videoFramesWritten = difference(a.counters.videoFramesWritten, b.counters.videoFramesWritten);
  return result;
}

export async function diagnoseCapture(archive) {
  const root = fs.realpathSync(archive);
  if (!fs.statSync(root).isDirectory()) throw new Error('Archive must be a directory');
  const issues = [], diagnostics = [], transitions = [], pauses = [];
  const manifestInput = jsonInput(root, 'manifest.json', issues);
  const manifest = manifestInput.value;
  const eventsFile = safeInput(root, 'raw/capture_events.jsonl');
  let malformedEventLines = 0, unsupportedDiagnosticRecords = 0, eventCount = 0, closedWindowEvents = 0;
  let lastRawOrigin = null, stop = null;
  const clockEvents = [];
  const coverage = Object.fromEntries(sources.map(source => [source, { segments: 0, firstPTS: null, lastPTS: null }]));
  if (eventsFile) {
    const lines = readline.createInterface({ input: fs.createReadStream(eventsFile), crlfDelay: Infinity });
    for await (const line of lines) {
      // Keep physical line positions for the shared legacy-correction evidence,
      // without retaining private titles, bookmark text or error descriptions.
      clockEvents.push({});
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { malformedEventLines++; continue; }
      if (!e || typeof e !== 'object') { malformedEventLines++; continue; }
      eventCount++;
      clockEvents[clockEvents.length - 1] = {
        event: e.event,
        originPTS: { seconds: seconds(e.originPTS) }, rebased: e.rebased === true,
        pts: { seconds: seconds(e.pts) }, status: e.status, usable: e.usable
      };
      if (e.event === 'capture-diagnostic') {
        const sample = diagnostic(e);
        if (sample) diagnostics.push(sample); else unsupportedDiagnosticRecords++;
      }
      if (e.event === 'timeline' && seconds(e.originPTS) !== null) lastRawOrigin = seconds(e.originPTS);
      if (e.event === 'stopped') stop = seconds(e.endPTS);
      if (['pause', 'resume'].includes(e.event) && seconds(e.pts) !== null) pauses.push({ hostSeconds: seconds(e.pts), paused: e.event === 'pause' });
      if (e.event === 'frame-state' && seconds(e.pts) !== null) {
        const state = ({ 0: 'complete', 1: 'idle', 2: 'blank', 3: 'suspended', 4: 'started', 5: 'stopped' })[e.status];
        transitions.push({ hostSeconds: seconds(e.pts), state: state || 'unknown', usable: typeof e.usable === 'boolean' ? e.usable : null });
      }
      if (e.event === 'gap' && e.source === 'video' && typeof e.reason === 'string' && e.reason.startsWith('Selected window closed')) closedWindowEvents++;
      if (e.event === 'segment' && sources.includes(e.kind)) {
        const start = seconds(e.startPTS), end = seconds(e.endPTS), track = coverage[e.kind];
        if (start !== null && end !== null && end >= start) {
          track.segments++; track.firstPTS = track.firstPTS === null ? start : Math.min(track.firstPTS, start);
          track.lastPTS = track.lastPTS === null ? end : Math.max(track.lastPTS, end);
        }
      }
    }
  }
  const timeline = effectiveTimeline(manifest?.timeline,
    Array.isArray(manifest?.segments) ? manifest.segments : [], clockEvents);
  const effectiveOrigin = seconds(timeline?.originPTS);
  const origin = effectiveOrigin ?? lastRawOrigin;
  const correctedInReport = effectiveOrigin !== null
    && effectiveOrigin !== seconds(manifest?.timeline?.originPTS);
  const snapshotInput = jsonInput(root, 'raw/capture-diagnostics.json', issues);
  if (snapshotInput.value) {
    const sample = diagnostic(snapshotInput.value);
    if (sample) diagnostics.push(sample); else unsupportedDiagnosticRecords++;
  }
  // The final snapshot is also an event. Count an identical observation once.
  const samples = [...new Map(diagnostics.map(sample => [JSON.stringify(sample), sample])).values()]
    .sort((a, b) => a.hostSeconds - b.hostSeconds);
  transitions.sort((a, b) => a.hostSeconds - b.hostSeconds);
  pauses.sort((a, b) => a.hostSeconds - b.hostSeconds);
  const intervals = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.hostSeconds <= a.hostSeconds) continue;
    const delta = deltas(a, b);
    const numericDeltas = [...Object.values(delta.received), ...Object.values(delta.videoStatus), ...Object.values(delta.dropped), delta.videoFramesWritten];
    const comparable = a.captureKind === b.captureKind && (a.captureKind === 'display' ? a.displayID === b.displayID : a.windowID === b.windowID)
      && !numericDeltas.some(value => value !== null && value < 0);
    const lastTransition = transitions.findLast(event => event.hostSeconds <= a.hostSeconds);
    const afterSuspension = a.videoState === 'suspended' || (lastTransition?.state === 'suspended' && a.videoState !== 'complete');
    const deliberatePauseObserved = a.videoState === 'paused' || b.videoState === 'paused'
      || pauses.findLast(event => event.hostSeconds <= a.hostSeconds)?.paused === true
      || pauses.some(event => event.paused && event.hostSeconds > a.hostSeconds && event.hostSeconds <= b.hostSeconds);
    let finding = 'not-an-interval-after-observed-suspension';
    if (!comparable) finding = 'counter-or-target-discontinuity';
    else if (deliberatePauseObserved) finding = 'recording-paused-during-observed-interval';
    else if (afterSuspension) {
      if (delta.received.video === null) finding = 'insufficient-counters';
      else if (delta.received.video === 0) finding = 'no-video-callbacks-in-observed-interval';
      else if (delta.videoStatus.suspended > 0) finding = 'suspended-callbacks-continued';
      else finding = 'video-callbacks-continued';
    }
    intervals.push({ startHostSeconds: a.hostSeconds, endHostSeconds: b.hostSeconds,
      durationSeconds: b.hostSeconds - a.hostSeconds, afterSuspension, deliberatePauseObserved, comparable, finding, delta });
  }
  const suspensionTimes = transitions.filter(event => event.state === 'suspended').map(event => event.hostSeconds);
  const result = {
    schemaVersion: 1,
    scope: 'Local capture metadata only; no media or meeting content read.',
    sources: { manifest: manifestInput.present, captureEvents: Boolean(eventsFile), diagnosticSnapshot: snapshotInput.present },
    durationSeconds: correctedInReport && stop !== null ? Math.max(0, stop - origin)
      : number(manifest?.durationSeconds) ?? (origin !== null && stop !== null ? Math.max(0, stop - origin) : null),
    originPTSSeconds: origin,
    timelineProvenance: {
      originSource: effectiveOrigin !== null ? 'effective-manifest' : (lastRawOrigin !== null ? 'raw-events' : 'unavailable'),
      manifestOriginPTSSeconds: seconds(manifest?.timeline?.originPTS),
      lastRawOriginPTSSeconds: lastRawOrigin,
      legacyZeroPTSCorrection: timeline?.correction?.kind === 'legacy-stopped-notification-zero-PTS',
      correctedInReport
    },
    initialWindowID: count(manifest?.selection?.window?.id),
    initialDisplayID: count(manifest?.selection?.display?.id),
    captureKind: manifest?.selection?.target?.kind === 'display' ? 'display' : 'window',
    sourceCoverage: coverage,
    suspensionSessionSeconds: suspensionTimes.map(time => origin === null ? null : time - origin),
    observations: { eventCount, diagnosticSamples: samples.length, malformedEventLines, unsupportedDiagnosticRecords, closedWindowEvents },
    evidenceLevel: intervals.some(interval => interval.afterSuspension && !interval.deliberatePauseObserved && interval.comparable && interval.delta.received.video !== null)
      ? 'callback-intervals-observed' : 'insufficient-evidence-to-distinguish-callback-stall-from-repeated-suspension',
    frameStateTransitions: transitions, intervals, diagnostics: samples,
    cause: 'Not established by these capture metadata.',
    issues,
    limitations: [
      'Frame-state events record changes only. Without cumulative diagnostic samples, silence in the event log does not mean callbacks stopped.',
      'An interval with zero new video callbacks describes only the measured interval, not a permanent failure.',
      'Target probes are sampled observations. Window existence or isOnScreen does not establish that shared content reached the selected capture surface.',
      'These metadata cannot identify Zoom internal surfaces or establish why ScreenCaptureKit suspended capture.',
      'Schema 1 dropped-sample counters describe video only; they do not measure discarded system or microphone audio samples.',
      'No image, audio, meeting text, credential, or arbitrary error text is included in this report.'
    ]
  };
  if (!samples.length) result.issues.push('No supported diagnostic samples. Older recordings cannot distinguish repeated suspended callbacks from a callback stall.');
  return result;
}

export function writeReport(archive, output, report) {
  const root = fs.realpathSync(archive), parent = fs.realpathSync(path.dirname(path.resolve(output)));
  const destination = path.join(parent, path.basename(output));
  const raw = fs.existsSync(path.join(root, 'raw')) ? fs.realpathSync(path.join(root, 'raw')) : path.join(root, 'raw');
  const manifest = safeInput(root, 'manifest.json');
  if (within(raw, destination) || destination === path.join(root, 'manifest.json') || destination === manifest) throw new Error('Report output must not overwrite archive inputs or raw files');
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Report output must not be a symbolic link');
  const temporary = path.join(parent, `.capture-report-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--archive', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || values[args[i]]) throw new Error('Usage: node tools/diagnose-capture.mjs --archive <meeting-folder> [--output <report.json>]');
      values[args[i]] = args[i + 1];
    }
    if (!values['--archive']) throw new Error('Usage: node tools/diagnose-capture.mjs --archive <meeting-folder> [--output <report.json>]');
    const result = await diagnoseCapture(values['--archive']);
    if (values['--output']) writeReport(values['--archive'], values['--output'], result);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    // System error strings may contain sensitive local paths. Only emit our bounded messages.
    process.stderr.write((error.code ? 'Cannot read archive metadata or write the diagnostic report.' : error.message) + '\n');
    process.exitCode = 1;
  }
}
