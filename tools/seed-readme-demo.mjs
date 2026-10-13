// Reproducible documentation fixtures, never user recordings or AI output.
// node tools/seed-readme-demo.mjs [--serve]
// Ctrl-C stops the optional isolated loopback server. Its local access token
// only unlocks fabricated demo data; it is not a model credential.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(root, '.build', 'readme-demo-2026-10-13');
const data = path.join(directory, 'data');
const media = path.join(directory, 'media');
const receiptFile = path.join(directory, 'receipt.json');
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const { ArchiveStore } = require('../server/archive-store');
const { ProjectStore } = require('../server/project-store');
const { MeetingArtifacts } = require('../server/meeting-artifacts');
const { defaults } = require('../server/archive-config');
const { createRecorderServer } = require('../server/index');
const store = new ArchiveStore(data), projects = new ProjectStore(data, store), artifacts = new MeetingArtifacts(store, projects);

if (!fs.existsSync(receiptFile)) {
  fs.mkdirSync(media, { recursive: true });
  if (!fs.existsSync(path.join(media, 'media-ready.json'))) {
    const binary = path.join(directory, 'render-media');
    const compile = ['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macos15.0', '-module-cache-path', path.join(root, '.build', 'module-cache')];
    const developer = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    const swiftInclude = path.join(developer, 'usr/include/swift');
    if (fs.existsSync(path.join(swiftInclude, 'module.modulemap')) && fs.existsSync(path.join(swiftInclude, 'bridging.modulemap'))) {
      // Match the existing native build's workaround for stale duplicate CLT
      // module maps, without modifying the toolchain installation.
      const blank = path.join(directory, 'empty.modulemap'), overlay = path.join(directory, 'swift-vfs.json');
      fs.writeFileSync(blank, '');
      save(overlay, { version: 0, 'use-external-names': false, roots: [{ type: 'file', name: path.join(swiftInclude, 'module.modulemap'), 'external-contents': blank }] });
      compile.push('-vfsoverlay', overlay);
    }
    execFileSync('/usr/bin/xcrun', [...compile, path.join(root, 'tools/readme-demo-media.swift'), '-o', binary], { stdio: 'inherit' });
    execFileSync(binary, [media], { stdio: 'inherit' });
  }
  const project = projects.create({ name: 'Project Atlas', description: 'Synthetic demo project: review experiments, keep decisions grounded, and track the next discussion.' });
  const project2 = projects.create({ name: 'Product Research', description: 'Synthetic demo project for interviews and design discussions.' });
  const titles = ['Pilot kickoff', 'Experiment review · Synthetic demo', 'Design review'];
  const notes = [
    'Synthetic demo — all names and discussion content are fictional.\n\nGoal\nDefine a small pilot and agree on evaluation criteria.\n\nDecision\nStart with a focused experiment; review false positives before expanding.\n\nNext meeting\nCompare baseline and proposed results.',
    'Synthetic demo — all media, discussion content and analysis below are hand-authored examples. No model was run.\n\nDiscussion\nThe shared results table shows baseline F1 = 0.81 and proposed F1 = 0.92. Check false positives before extending the pilot.\n\nNext step\nAlex will review failure cases by Friday.\n\nOpen question\nHow do the results change with overlapping speakers?',
    'Synthetic demo — fictional design discussion.\n\nFocus\nKeep original recordings, supporting documents and outputs together.\n\nDecision\nReview the archive and playback experience before the next iteration.'
  ];
  const ids = [];
  for (let index = 0; index < titles.length; index++) {
    const m = store.create({ kind: 'window', window: { id: 1, app: 'Synthetic slides', title: 'Project Atlas — synthetic demo' }, microphone: false, systemAudio: false }, defaults.recording, titles[index]);
    ids.push(m.id);
    m.createdAt = ['2026-10-06T14:00:00Z', '2026-10-13T14:00:00Z', '2026-10-10T15:30:00Z'][index];
    m.status = 'recorded'; m.syntheticDemo = true; m.processingStatus = 'ready'; store.save(m);
    projects.assign(m.id, index === 2 ? project2.id : project.id);
    store.notes(m.id, notes[index]);
    const raw = store.raw(m.id);
    fs.copyFileSync(path.join(media, 'demo.mp4'), path.join(raw, 'video-000001.mp4'));
    save(path.join(raw, 'video-000001.json'), { status: 'complete', kind: 'video', file: 'video-000001.mp4', startPTS: { seconds: 1000 }, endPTS: { seconds: 1090 }, durationSeconds: 90, width: 1280, height: 720, frames: 1350, syntheticDemo: true });
    save(path.join(raw, 'timeline.json'), { clock: 'SCK-presentation-time', originPTS: { seconds: 1000 }, originPolicy: 'earliest-valid-media-PTS', syntheticDemo: true });
    fs.writeFileSync(path.join(raw, 'capture_events.jsonl'), [{ event: 'started', syntheticDemo: true }, { event: 'stopped', clean: true, endPTS: { seconds: 1090 }, syntheticDemo: true }].map(v => JSON.stringify(v)).join('\n') + '\n');
    store.refresh(m.id);
  }
  const meeting = ids[1];
  for (const [name, content] of [
    ['experiment-brief.md', '# Project Atlas — experiment brief\n\nSYNTHETIC DEMO. Fictional background, not meeting evidence.\n\nCompare baseline F1 0.81 with proposed F1 0.92. Validate false positives before expanding the pilot.\n'],
    ['review-agenda.md', '# Review agenda\n\nSYNTHETIC DEMO.\n\n1. Inspect the results table.\n2. Review failure cases.\n3. Agree on the next validation task.\n']
  ]) await artifacts.importDocument(meeting, name, Readable.from([content]), Buffer.byteLength(content));
  const runId = 'de000000-0000-4000-8000-000000000001';
  const run = path.join(store.dir(meeting), 'outputs', runId);
  fs.mkdirSync(path.join(run, 'frames'), { recursive: true });
  fs.copyFileSync(path.join(media, 'slide-1.png'), path.join(run, 'frames', 'results.png'));
  const transcript = [
    { id: 't000001', kind: 'transcript', source: 'imported', startMs: 5000, endMs: 16000, text: 'The improvement looks promising. We should review the false positives before expanding the pilot.', speaker: null, timingAccuracy: 'synthetic-demo', model: 'hand-authored example' },
    { id: 't000002', kind: 'transcript', source: 'imported', startMs: 35000, endMs: 48000, text: 'Alex will review the failure cases by Friday. We still need to evaluate overlapping speakers.', speaker: null, timingAccuracy: 'synthetic-demo', model: 'hand-authored example' }
  ];
  const evidence = [...transcript, { id: 'v000001', kind: 'visual', sourceMs: 8000, startMs: 0, endMs: 30000, text: 'Synthetic slide: Baseline F1 = 0.81; Proposed F1 = 0.92. Illustrative values only.', title: 'Results table · synthetic demo', framePath: `outputs/${runId}/frames/results.png` }];
  const summary = {
    schemaVersion: 1, syntheticDemo: true,
    overview: [{ text: 'Synthetic demo: the team reviewed the experiment results and agreed to validate failure cases before extending the pilot.', evidence_refs: ['t000001', 'v000001'] }],
    topics: [{ text: 'The shared results show F1 increasing from 0.81 to 0.92. These values come from the slide; the discussion adds the need to inspect false positives.', evidence_refs: ['v000001', 't000001'] }],
    decisions: [{ text: 'Review false positives before expanding the pilot.', evidence_refs: ['t000001'] }],
    actionItems: [{ text: 'Review the failure cases.', owner: 'Alex', deadline: 'Friday', evidence_refs: ['t000002'] }],
    openQuestions: [{ text: 'How does performance change when speakers overlap?', evidence_refs: ['t000002'] }],
    uncertainties: [{ text: 'All content in this demonstration is fabricated. The summary and transcript were hand-authored; they are not outputs from a live AI run.', evidence_refs: [] }]
  };
  save(path.join(run, 'job.json'), { id: runId, meetingId: meeting, createdAt: '2026-10-13T14:02:00Z', updatedAt: '2026-10-13T14:02:00Z', status: 'ready', stage: 'complete', progress: 1, syntheticDemo: true });
  save(path.join(run, 'summary.json'), summary); save(path.join(run, 'transcript.json'), { syntheticDemo: true, segments: transcript }); save(path.join(run, 'evidence.json'), evidence);
  fs.writeFileSync(path.join(run, 'transcript.jsonl'), transcript.map(v => JSON.stringify(v)).join('\n') + '\n');
  fs.writeFileSync(path.join(run, 'summary.md'), '# Synthetic demo summary\n\nHand-authored example, not an AI result.\n\nReview false positives before expanding the pilot. [t000001]\n\nThe slide shows F1 = 0.81 and 0.92. [v000001]\n');
  artifacts.inventory(meeting);
  save(path.join(data, 'settings', 'analysis-preferences.json'), { schemaVersion: 1, networkPolicy: 'local-only', manualAnalysisStart: true, pauseDuringRecording: true, automaticFallback: false, uploads: { audio: false, images: false, transcriptsAndNotes: false, contextDocuments: false }, tasks: { transcription: { provider: 'imported-transcript', model: '', authentication: 'none', endpoint: '' }, vision: { provider: 'disabled', model: '', authentication: 'none', endpoint: '' }, summary: { provider: 'disabled', model: '', authentication: 'none', endpoint: '' } } });
  save(receiptFile, { syntheticOnly: true, capturedScreen: false, capturedAudio: false, usedAI: false, readCredentials: false, projectId: project.id, meetingId: meeting, meetingIds: ids, runId, dataDirectory: data });
}
const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
console.log(JSON.stringify(receipt, null, 2));
if (process.argv.includes('--serve')) {
  const blocked = () => { throw new Error('Disabled in the synthetic documentation demo.'); };
  const sessions = { binary: path.join(root, '.build', 'archivecap'), sources: async () => ({ windows: [], displays: [] }), permissions: async () => ({ screen: 'not-requested', microphone: 'not-requested', accessibility: 'not-required' }), requestPermissions: blocked, openPermissionSettings: blocked, preview: blocked, start: blocked, stop: blocked, command: blocked, recover: blocked };
  const runtime = createRecorderServer({ dataDir: data, store, projects, artifacts, sessions, openFolder: blocked, rkaClient: { projects: async () => ({ projects: [], version: 'synthetic-demo' }) } });
  for (const operation of ['start', 'preview', 'installRuntime']) runtime.analysis[operation] = blocked;
  runtime.exports.start = blocked;
  runtime.rka.refresh = blocked;
  runtime.server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${runtime.server.address().port}/#token=${runtime.token}`;
    save(path.join(directory, 'server.json'), { pid: process.pid, url, syntheticOnly: true, ...receipt });
    console.log(`Synthetic documentation demo: ${url}`);
  });
  const stop = () => runtime.server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
