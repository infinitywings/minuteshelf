// Exercise the actual authenticated HTTP routes, native media helpers and HTTP
// provider adapters with fabricated pixels/audio and loopback model fixtures.
// Usage: node tools/test-analysis-e2e.mjs [--app '/path/Meeting Archive.app']
// No screen/microphone capture, user archives, Keychain or cloud credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
assert.ok(!args.length || args.length === 2 && args[0] === '--app', 'Usage: test-analysis-e2e.mjs [--app <bundle>]');
assert.equal(process.platform, 'darwin', 'The native media validation requires macOS.');
const app = path.resolve(args[1] || path.join(root, '.build', 'Meeting Archive.app'));
const packaged = path.join(app, 'Contents', 'Resources', 'runtime');
const runtimeRoot = args.length ? packaged : root;
const binaries = Object.fromEntries(['archivecap', 'analysis-media', 'archive-export'].map(name => [name, path.join(packaged, '.build', name)]));
for (const file of Object.values(binaries)) assert.ok(fs.existsSync(file), `Build the app before running this test: ${file}`);
const { createRecorderServer } = require(path.join(runtimeRoot, 'server', 'index.js'));
const { ArchiveStore } = require(path.join(runtimeRoot, 'server', 'archive-store.js'));
const { SessionManager } = require(path.join(runtimeRoot, 'server', 'archive-session.js'));
const { ProjectStore } = require(path.join(runtimeRoot, 'server', 'project-store.js'));
const { MeetingArtifacts } = require(path.join(runtimeRoot, 'server', 'meeting-artifacts.js'));
const { MediaExports } = require(path.join(runtimeRoot, 'server', 'media-export.js'));
const media = require(path.join(runtimeRoot, 'server', 'analysis-media.js'));
const { defaults } = require(path.join(runtimeRoot, 'server', 'archive-config.js'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-analysis-e2e-'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const reportFile = path.join(root, '.build', 'reports', 'analysis-validation-0.1.6.json');
const report = { mode: args.length ? 'packaged-server' : 'source-server-packaged-helpers', startedAt: new Date().toISOString(),
  syntheticOnly: true, requestedCapturePermissions: false, readKeychain: false, usedRealCredentials: false,
  modelTransport: 'loopback HTTP fixtures only', realModelQualityTested: false, node: process.version, architecture: process.arch,
  app, runtimeRoot, dataPath: data, dataRemovedAfterTest: false, checks,
  sha256: Object.fromEntries([...Object.entries(binaries), ...['index.js', 'analysis-manager.js', 'analysis-providers.js', 'analysis-media.js'].map(name => [name, path.join(runtimeRoot, 'server', name)])].map(([name, file]) => [name, sha(file)])) };
let runtime, fixtureChild, cookie;
const requests = { stt: 0, vision: 0, summary: 0 }, received = { audioHashes: [], imageHashes: [], contextNames: [] };
let fixtureFailure;
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function incoming(req) {
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; assert.ok(size <= 24 * 1024 * 1024, 'Fixture request bound'); parts.push(part); }
  return Buffer.concat(parts);
}
const models = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, undefined, 'Synthetic no-key services must not receive inherited credentials');
    const buffer = await incoming(req);
    if (req.url === '/v1/audio/transcriptions') {
      const multipart = await new Request('http://127.0.0.1/fixture', { method: 'POST', headers: req.headers, body: buffer }).formData();
      assert.equal(multipart.get('model'), 'synthetic-stt'); assert.equal(multipart.get('response_format'), 'verbose_json');
      const audio = Buffer.from(await multipart.get('file').arrayBuffer());
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
      let fmt; for (let at = 12; at + 8 <= audio.length;) { const size = audio.readUInt32LE(at + 4); if (audio.toString('ascii', at, at + 4) === 'fmt ') { fmt = at + 8; break; } at += 8 + size + size % 2; }
      assert.ok(fmt); assert.equal(audio.readUInt32LE(fmt + 4), 16000); assert.equal(audio.readUInt16LE(fmt + 2), 1);
      received.audioHashes.push(crypto.createHash('sha256').update(audio).digest('hex'));
      requests.stt++;
      return json(res, { text: '我们决定 test the baseline.', language: 'zh', segments: [{ start: 0.1, end: 0.7, text: '我们决定 test the baseline.' }] });
    }
    assert.equal(req.url, '/v1/chat/completions');
    const body = JSON.parse(buffer); assert.equal(body.tools, undefined, 'Analysis must not expose tools');
    const user = body.messages.find(item => item.role === 'user'); assert.ok(user);
    let output;
    if (body.model === 'synthetic-vision') {
      assert.ok(Array.isArray(user.content));
      const images = user.content.filter(item => item.type === 'image_url'); assert.equal(images.length, 1);
      const match = /^data:image\/jpeg;base64,(.+)$/.exec(images[0].image_url.url); assert.ok(match, 'Native frame must arrive as an inline JPEG');
      const image = Buffer.from(match[1], 'base64'); assert.equal(image.readUInt16BE(0), 0xffd8);
      received.imageHashes.push(crypto.createHash('sha256').update(image).digest('hex')); requests.vision++;
      output = JSON.stringify({ title: 'Synthetic fixture', contentType: 'test_pattern', visibleFacts: ['Fabricated validation image; no real meeting content.'], uncertainties: ['This fixture does not measure visual model quality.'] });
    } else {
      assert.equal(body.model, 'synthetic-summary'); assert.equal(typeof user.content, 'string'); requests.summary++;
      const evidence = JSON.parse(user.content.split('\nEvidence:\n')[1]);
      const speech = evidence.find(item => item.kind === 'transcript'), visual = evidence.find(item => item.kind === 'visual');
      const background = evidence.filter(item => item.kind === 'background');
      assert.ok(speech && visual); assert.equal(background.length, 2);
      assert.ok(background.some(item => item.text.includes('SYNTHETIC TEXT background')));
      assert.ok(background.some(item => item.text.includes('SYNTHETIC PDF background')));
      received.contextNames = ['synthetic-context.txt', 'synthetic-context.pdf'];
      // One provider-format failure proves retry via the route reuses native
      // media, STT, visual and context checkpoints instead of recomputing them.
      output = requests.summary === 1 ? 'deliberately malformed synthetic JSON' : JSON.stringify({
        overview: [{ text: 'The synthetic meeting discussed testing the baseline.', evidence_refs: [speech.id] },
          { text: 'The selected frame is a fabricated validation image.', evidence_refs: [visual.id] },
          { text: 'Prior context was attached separately.', evidence_refs: background.map(item => item.id) },
          { text: 'UNSUPPORTED_SYNTHETIC_CLAIM', evidence_refs: ['nonexistent-evidence'] }],
        decisions: [{ text: 'Test the baseline.', evidence_refs: [speech.id] }],
        actionItems: [{ text: 'Test the baseline.', evidence_refs: [speech.id], owner: null, deadline: null }], topics: [], openQuestions: [], uncertainties: [] });
    }
    json(res, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: output } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
  } catch (error) { fixtureFailure = error; json(res, { error: 'Synthetic fixture assertion failed.' }, 500); }
});
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return `http://127.0.0.1:${server.address().port}`; }
async function wait(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (fixtureFailure) throw fixtureFailure; const value = await check(); if (value) return value; await sleep(80); }
  throw new Error('Synthetic end-to-end check timed out.');
}
function pdf() {
  const content = 'BT /F1 12 Tf 50 700 Td (SYNTHETIC PDF background: baseline F1 = 0.81.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(text); text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
async function close(server) { if (!server?.listening) return; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
try {
  const modelURL = await listen(models);
  const settings = { schemaVersion: 1, networkPolicy: 'local-only', uploads: { audio: false, images: false, transcriptsAndNotes: false, contextDocuments: false },
    manualAnalysisStart: true, pauseDuringRecording: true, automaticFallback: false,
    tasks: Object.fromEntries([['transcription', 'stt-api', 'synthetic-stt'], ['vision', 'openai-compatible', 'synthetic-vision'], ['summary', 'openai-compatible', 'synthetic-summary']]
      .map(([task, provider, model]) => [task, { provider, model, endpoint: modelURL + '/v1', authentication: 'none' }])) };
  fs.mkdirSync(path.join(data, 'settings')); fs.writeFileSync(path.join(data, 'settings', 'analysis-preferences.json'), JSON.stringify(settings));
  const store = new ArchiveStore(data), projects = new ProjectStore(data, store), artifacts = new MeetingArtifacts(store, projects);
  const config = { ...defaults, recording: { ...defaults.recording, segmentSeconds: 5, maxLongEdgePixels: 640 } };
  const sessions = new SessionManager(store, config, binaries.archivecap), exports = new MediaExports(store, artifacts, { binary: binaries['archive-export'] });
  runtime = createRecorderServer({ dataDir: data, config, store, projects, artifacts, sessions, exports,
    analysisDependencies: {
      prepareMedia: options => media.prepareMedia({ ...options, binary: binaries['analysis-media'] }),
      extractDocuments: options => media.extractDocuments({ ...options, binary: binaries['analysis-media'] })
    } });
  const url = await listen(runtime.server);
  async function request(route, { method = 'GET', value, raw, headers = {}, auth = true, status = 200, bytes = false } = {}) {
    const response = await fetch(url + route, { method, headers: { ...(auth ? { Cookie: cookie } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: raw ?? (value === undefined ? undefined : JSON.stringify(value)) });
    const output = bytes ? Buffer.from(await response.arrayBuffer()) : await response.json();
    assert.equal(response.status, status, `${method} ${route}: ${Buffer.isBuffer(output) ? 'binary response' : JSON.stringify(output)}`);
    return { output, response };
  }
  await request('/api/status', { auth: false, status: 401 });
  await request('/api/session', { auth: false, method: 'POST', value: { token: 'wrong-synthetic-token' }, status: 401 });
  const login = await request('/api/session', { auth: false, method: 'POST', value: { token: runtime.token } });
  cookie = login.response.headers.get('set-cookie').split(';')[0]; assert.ok(cookie.startsWith('meeting_session='));
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  await request('/api/status', { headers: { Origin: 'https://untrusted.example' }, status: 403 });
  const bearer = await request('/api/status', { auth: false, headers: { Authorization: `Bearer ${runtime.token}` } }); assert.equal(bearer.output.active.length, 0);
  checks.push('unauthenticated requests rejected; bearer and session cookie accepted; cross-origin rejected');

  const meeting = store.create({ window: { id: 1, app: 'Synthetic fixture', title: 'Fabricated pixels only' }, microphone: true, microphoneID: 'synthetic', systemAudio: true }, config.recording, 'Synthetic end-to-end analysis');
  meeting.synthetic = true; store.save(meeting); const route = `/api/meetings/${meeting.id}`;
  report.meetingId = meeting.id;
  fixtureChild = spawn(binaries.archivecap, ['fixture', '--dir', store.raw(meeting.id), '--mic', '--system-audio', '--max-edge', '640', '--segment-seconds', '5'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = ''; fixtureChild.stderr.on('data', chunk => { childError = (childError + chunk).slice(-2000); });
  fixtureChild.once('error', error => { fixtureFailure = error; });
  await wait(() => { if (fixtureChild.exitCode !== null) throw new Error(`Synthetic writer exited: ${childError}`); return store.status(meeting.id)?.state === 'recording'; });
  await request(route + '/bookmark', { method: 'POST', value: { text: 'Synthetic keyframe bookmark' } });
  await wait(() => store.refresh(meeting.id).segments.some(segment => segment.kind === 'video'));
  await sleep(500);
  const stopped = (await request(route + '/stop', { method: 'POST', value: {} })).output;
  assert.equal(stopped.status, 'recorded'); assert.ok(stopped.segments.some(s => s.kind === 'microphone')); assert.ok(stopped.segments.some(s => s.kind === 'system'));
  await wait(() => fixtureChild.exitCode !== null || fixtureChild.signalCode !== null);
  const rawFiles = fs.readdirSync(store.raw(meeting.id)).filter(name => fs.statSync(path.join(store.raw(meeting.id), name)).isFile());
  const original = Object.fromEntries(rawFiles.map(name => [name, sha(path.join(store.raw(meeting.id), name))]));
  report.originalSHA256 = original; report.durationSeconds = stopped.durationSeconds;
  checks.push('packaged native fixture writer created video plus both audio sources; authenticated bookmark and stop worked');

  await request(route + '/notes', { method: 'PUT', value: { notes: 'SYNTHETIC USER NOTE: a note is not verbatim speech.' } });
  for (const [name, contents] of [['synthetic-context.txt', Buffer.from('SYNTHETIC TEXT background: this is prior context, not meeting speech.')], ['synthetic-context.pdf', pdf()]]) {
    const imported = (await request(route + '/documents', { method: 'POST', raw: contents, headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' }, status: 201 })).output;
    assert.equal(imported.sha256, crypto.createHash('sha256').update(contents).digest('hex'));
  }
  const contextPacket = (await request(route + '/analysis-context')).output; assert.equal(contextPacket.documents.length, 2);
  const project = (await request('/api/projects', { method: 'POST', value: { name: 'Synthetic project' }, status: 201 })).output;
  await request(route + '/project', { method: 'PUT', value: { projectId: project.id } });
  checks.push('text/PDF context imported through HTTP with matching hashes; project assignment saved');

  const preview = (await request(route + '/analysis-preview', { method: 'POST', value: { includeContext: true } })).output;
  assert.deepEqual(preview.uploads, []); assert.deepEqual([...preview.audioSources].sort(), ['microphone', 'system']);
  await request(route + '/analysis', { method: 'POST', value: { settingsRevision: 'stale-revision' }, status: 409 });
  const job = (await request(route + '/analysis', { method: 'POST', value: { settingsRevision: preview.settingsRevision, includeContext: true }, status: 202 })).output;
  report.runId = job.id;
  let result = await wait(async () => { const state = (await request(route + '/analysis/' + job.id)).output; return !['queued', 'processing'].includes(state.job.status) && state; }, 60000);
  assert.equal(result.job.status, 'failed', result.job.error); assert.match(result.job.error, /structured output/);
  assert.ok(result.job.completedStages.includes('context')); assert.ok(requests.stt >= 2); assert.ok(requests.vision >= 1); assert.equal(requests.summary, 1);
  const runDirectory = path.join(store.dir(meeting.id), 'outputs', job.id);
  const completed = Object.fromEntries(['prepare-media.json', 'transcript.json', 'visual.json', 'context.json'].map(name => [name, { sha256: sha(path.join(runDirectory, name)), modifiedMs: fs.statSync(path.join(runDirectory, name)).mtimeMs }]));
  const countsBeforeRetry = { ...requests };
  const retry = (await request(route + '/analysis', { method: 'POST', value: { settingsRevision: preview.settingsRevision, includeContext: true, retryRunId: job.id }, status: 202 })).output;
  assert.equal(retry.id, job.id);
  result = await wait(async () => { const state = (await request(route + '/analysis/' + job.id)).output; return !['queued', 'processing'].includes(state.job.status) && state; }, 60000);
  assert.equal(result.job.status, 'ready', result.job.error);
  assert.equal(requests.stt, countsBeforeRetry.stt); assert.equal(requests.vision, countsBeforeRetry.vision); assert.equal(requests.summary, 2);
  for (const [name, before] of Object.entries(completed)) { assert.equal(sha(path.join(runDirectory, name)), before.sha256); assert.equal(fs.statSync(path.join(runDirectory, name)).mtimeMs, before.modifiedMs); }
  checks.push('authenticated analysis preview/start, stale revision rejection and failed-summary retry preserved completed checkpoints');

  const prepared = JSON.parse(fs.readFileSync(path.join(runDirectory, 'prepare-media.json')));
  assert.ok(prepared.audio.length >= 2); assert.deepEqual([...new Set(prepared.audio.map(item => item.source))].sort(), ['microphone', 'system']); assert.ok(prepared.frames.length > 0);
  assert.deepEqual(received.audioHashes, prepared.audio.map(item => sha(path.join(runDirectory, item.path))));
  assert.deepEqual(received.imageHashes, prepared.frames.map(item => sha(path.join(runDirectory, item.path))));
  for (const segment of result.transcript) {
    const chunk = prepared.audio.find(item => item.path === segment.audioPath); assert.ok(chunk); assert.equal(segment.source, chunk.source);
    assert.equal(segment.startMs, Math.min(chunk.endMs, Math.round(chunk.startMs + 100))); assert.equal(segment.endMs, Math.min(chunk.endMs, Math.round(chunk.startMs + 700)));
    assert.equal(segment.timingAccuracy, 'asr-estimate'); assert.equal(segment.speaker, null); assert.equal(segment.audioPath, chunk.path);
    assert.equal(segment.text, '我们决定 test the baseline.'); assert.ok(chunk.timeline.length);
  }
  assert.equal(result.evidence.filter(item => item.kind === 'background').length, 2);
  assert.equal(result.evidence.filter(item => item.kind === 'user-note').length, 1);
  assert.ok(result.visual.events.every(event => event.startMs >= 0 && event.endMs <= stopped.durationSeconds * 1000 + 1000));
  assert.ok(result.summary.overview.every(item => !item.text.includes('UNSUPPORTED_SYNTHETIC_CLAIM')));
  assert.ok(result.summary.uncertainties.some(item => /Uncited/.test(item.text)));
  assert.equal(result.summary.actionItems[0].owner, null); assert.equal(result.summary.actionItems[0].deadline, null);
  const evidenceIDs = new Set(result.evidence.map(item => item.id));
  for (const value of Object.values(result.summary)) if (Array.isArray(value)) for (const item of value) for (const id of item.evidence_refs) assert.ok(evidenceIDs.has(id));
  checks.push('native 16kHz mono chunks and JPEGs exactly matched HTTP payloads; bilingual text, source offsets and provenance retained');
  checks.push('native PDF extraction and text context remained background evidence; unsupported citations removed; speaker/owner/deadline stayed unknown');

  const inventory = (await request(route + '/artifacts')).output;
  for (const file of result.job.files) assert.ok(inventory.entries.some(entry => entry.path === file.path));
  const summaryPath = `outputs/${job.id}/summary.md`;
  const summary = await request(route + '/artifact?path=' + encodeURIComponent(summaryPath), { bytes: true });
  assert.match(summary.response.headers.get('content-disposition'), /attachment/); assert.deepEqual(summary.output, fs.readFileSync(path.join(runDirectory, 'summary.md')));
  const framePath = result.visual.events[0].framePath;
  const frame = await request(route + '/artifact?path=' + encodeURIComponent(framePath) + '&inline=1', { bytes: true, headers: { Range: 'bytes=0-31' }, status: 206 });
  assert.equal(frame.output.length, 32); assert.equal(frame.response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(frame.output, fs.readFileSync(path.join(store.dir(meeting.id), framePath)).subarray(0, 32));
  await request(route + '/artifact?path=' + encodeURIComponent(summaryPath), { auth: false, status: 401 });
  await request(route + '/artifact?path=' + encodeURIComponent('../outside.txt'), { status: 404 });
  const projectContext = (await request(`/api/projects/${project.id}/analysis-context`)).output;
  assert.equal(projectContext.meetings.length, 1); assert.equal(projectContext.meetings[0].background.documents.length, 2);
  checks.push('authenticated summary downloads, inline evidence JPEG range playback, project context and artifact inventory verified');

  await wait(() => !runtime.analysis.worker);
  const exportJob = (await request(route + '/export-media', { method: 'POST', value: {}, status: 202 })).output;
  const exported = await wait(async () => { const jobs = (await request(route + '/exports')).output; const current = jobs.find(item => item.id === exportJob.id); return current && !['queued', 'processing'].includes(current.status) && current; }, 60000);
  assert.equal(exported.status, 'ready', JSON.stringify(exported));
  const mergedPath = `exports/${exportJob.id}/meeting.mp4`;
  const inspected = JSON.parse(execFileSync(binaries.archivecap, ['inspect', '--file', path.join(store.dir(meeting.id), mergedPath)], { encoding: 'utf8' }));
  assert.equal(inspected.playable, true); assert.ok(inspected.durationSeconds > 0);
  const tracks = JSON.parse(execFileSync(binaries['archive-export'], ['--inspect', path.join(store.dir(meeting.id), mergedPath), '--sample-times', '0.2,2.0'], { encoding: 'utf8' }));
  assert.equal(tracks.videoTracks, 1); assert.ok(tracks.audioTracks >= 1);
  assert.ok(tracks.samples.every(sample => sample.audioValuesDecoded > 0 && sample.audioRMS > 0));
  assert.equal(exported.files.find(file => file.path === mergedPath).sha256, sha(path.join(store.dir(meeting.id), mergedPath)));
  const video = await request(route + '/artifact?path=' + encodeURIComponent(mergedPath) + '&inline=1', { bytes: true, headers: { Range: 'bytes=0-63' }, status: 206 });
  assert.equal(video.response.headers.get('content-type'), 'video/mp4'); assert.equal(video.output.length, 64);
  for (const [name, hash] of Object.entries(original)) assert.equal(sha(path.join(store.raw(meeting.id), name)), hash, `Original changed: ${name}`);
  report.export = { status: exported.status, inspect: inspected, tracks }; report.requests = requests;
  report.resultCounts = { transcriptSegments: result.transcript.length, visualEvents: result.visual.events.length, evidence: result.evidence.length, artifactFiles: inventory.entries.length };
  checks.push('native merged video/audio export completed and served over authenticated range route; all original files retained identical SHA256');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  await runtime?.analysis.shutdown(); runtime?.exports.cancelForRecording();
  if (fixtureChild && fixtureChild.exitCode === null && fixtureChild.signalCode === null) {
    fixtureChild.kill('SIGTERM'); await wait(() => fixtureChild.exitCode !== null || fixtureChild.signalCode !== null, 3000).catch(() => fixtureChild.kill('SIGKILL'));
  }
  await close(runtime?.server); await close(models);
  // Only a fresh directory made by this invocation is removed. Preserve failed
  // synthetic runs to diagnose a test failure; never touch any user archive.
  if (report.status === 'passed') { fs.rmSync(data, { recursive: true, force: true }); report.dataRemovedAfterTest = true; }
  report.completedAt = new Date().toISOString();
  let previous; try { previous = JSON.parse(fs.readFileSync(reportFile)); } catch {}
  const runs = [...(previous?.runs || []).filter(item => item.mode !== report.mode), report];
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify({ schemaVersion: 1, description: 'Synthetic transport and archive integration; not live model quality, account entitlement, real capture permission or long-session validation.', runs }, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, mode: report.mode, checks, requests, error: report.error?.message, report: reportFile }, null, 2));
}
