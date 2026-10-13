// Exercise a shipped bundle using only generated pixels/tone and temporary data.
// No ScreenCaptureKit sources, microphone devices, or permission APIs are used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url), repository = path.dirname(path.dirname(script));
const options = { report:path.join(repository, '.build', 'reports', 'bundled-media-validation.json') };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--help') {
    console.log('node tools/test-bundled-media.mjs --app /path/to/MinuteShelf.app [--report /path/to/report.json]');
    process.exit(0);
  }
  if (!['--app', '--report', '--worker-root'].includes(flag) || !process.argv[i + 1]) throw new Error(`Unknown or incomplete argument: ${flag}`);
  options[flag.slice(2)] = path.resolve(process.argv[++i]);
}
assert(options.app, 'Pass an explicit --app path to the installed or relocated bundle.');
const app = fs.realpathSync(options.app), node = path.join(app, 'Contents', 'Helpers', 'node');
const runtime = path.join(app, 'Contents', 'Resources', 'runtime');
const systemPath = '/usr/bin:/bin';
function writeReport(report) {
  fs.mkdirSync(path.dirname(options.report), { recursive:true });
  const temporary = `${options.report}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n'); fs.renameSync(temporary, options.report);
}
function sha256(file) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), descriptor = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = fn(); if (value) return value; await sleep(100); }
  throw new Error('Bundled media validation timed out.');
}

async function runUnderBundledNode() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-bundled-media-')));
  const cwd = path.join(temporary, 'Empty working directory'), processTemp = path.join(temporary, 'Process temporary files');
  fs.mkdirSync(cwd); fs.mkdirSync(processTemp);
  const environment = { PATH:systemPath, LANG:'en_US.UTF-8', TMPDIR:processTemp + path.sep };
  for (const key of ['HOME','USER','LOGNAME','TZ']) if (process.env[key]) environment[key] = process.env[key];
  const baseReport = { schemaVersion:'bundled-media-validation-1', startedAt:new Date().toISOString(), status:'failed', appPath:app,
    syntheticOnly:true, actualCapture:false, requestedPermissions:false, dataPath:temporary };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(node, [script, '--app', app, '--report', options.report, '--worker-root', temporary],
        { cwd, env:environment, detached:true, stdio:['ignore','pipe','pipe'] });
      let stderr = '', stdout = '', timedOut = false, killTimer;
      const killGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
      const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), 1500); }, 120000);
      child.stdout.on('data', data => { stdout = (stdout + data).slice(-16000); });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
      child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(killTimer); killGroup('SIGKILL');
        if (timedOut || code !== 0) reject(new Error(timedOut ? 'Bundled media worker timed out.' : `Bundled media worker exited ${code ?? signal}: ${stderr || stdout}`));
        else { process.stdout.write(stdout); resolve(); }
      });
    });
    const report = JSON.parse(fs.readFileSync(options.report, 'utf8'));
    assert.equal(report.status, 'passed'); assert.equal(fs.realpathSync(report.nodeExecPath), fs.realpathSync(node));
  } catch (error) {
    let report = baseReport;
    try { const existing = JSON.parse(fs.readFileSync(options.report, 'utf8')); if (existing.dataPath?.startsWith(temporary)) report = existing; } catch {}
    writeReport({ ...report, status:'failed', error:error.message, completedAt:new Date().toISOString() });
    throw error;
  }
}

async function validateMedia() {
  const temporary = options['worker-root'], data = path.join(temporary, 'Isolated meeting archive');
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(node), 'Test worker must use the bundle Node.');
  assert.equal(process.env.PATH, systemPath, 'Unexpected developer PATH.');
  assert.deepEqual(fs.readdirSync(process.cwd()), [], 'Test working directory must be empty.');
  assert(!process.env.NODE_OPTIONS && !process.env.NODE_PATH && !Object.keys(process.env).some(key => key.startsWith('DYLD_')), 'Developer runtime overrides must be absent.');
  fs.mkdirSync(data);
  const require = createRequire(path.join(runtime, 'tools', 'desktop-server.js'));
  const { ArchiveStore } = require('../server/archive-store');
  const { SessionManager } = require('../server/archive-session');
  const { ProjectStore } = require('../server/project-store');
  const { MeetingArtifacts } = require('../server/meeting-artifacts');
  const { MediaExports, exportPlan } = require('../server/media-export');
  const { defaults } = require('../server/archive-config');
  const loadedModules = Object.keys(require.cache);
  assert(loadedModules.length > 0 && loadedModules.every(file => within(runtime, fs.realpathSync(file))), 'Only bundled application modules may load.');
  const capture = path.join(runtime, '.build', 'archivecap'), exporter = path.join(runtime, '.build', 'archive-export');
  const build = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'build-info.json'), 'utf8'));
  assert.equal(process.version, build.node.version);
  const bundleHashes = [node, capture, exporter, ...loadedModules].map(file => [file, sha256(file)]);
  const children = [], exits = new Map();
  function start(command, args, settings = {}) {
    assert([capture, exporter].includes(command), 'Only bundled native fixture/export helpers may spawn.');
    const child = spawn(command, args, { ...settings, env:process.env, cwd:process.cwd(), detached:false });
    children.push(child);
    const settled = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('close', (code, signal) => resolve({ code, signal })); });
    exits.set(child, settled); return child;
  }
  const archives = new ArchiveStore(data), projects = new ProjectStore(data, archives), artifacts = new MeetingArtifacts(archives, projects);
  const exports = new MediaExports(archives, artifacts, { spawnWorker:start });
  const manager = new SessionManager(archives, defaults);
  // Default constructor paths must resolve in the installed bundle, not the repo.
  assert.equal(manager.binary, capture); assert.equal(exports.binary, exporter);
  const report = { schemaVersion:'bundled-media-validation-1', startedAt:new Date().toISOString(), status:'running', appPath:app,
    syntheticOnly:true, actualCapture:false, requestedPermissions:false, dataPath:data,
    nodeExecPath:process.execPath, nodeVersion:process.version, PATH:process.env.PATH, cwd:process.cwd(),
    loadedModules:loadedModules.map(file => path.relative(app, file)), checks:{} };
  try {
    const m = archives.create({ window:{ id:1, app:'Synthetic fixture', title:'Generated pixels and tone only' }, microphone:true, systemAudio:true },
      defaults.recording, 'Bundled media validation');
    report.meetingId = m.id;
    const project = projects.create({ name:'Synthetic validation project' }); projects.assign(m.id, project.id);
    const note = 'Synthetic meeting notes — Unicode is preserved: Δ and 会议.\nNo real conversation was recorded.\n';
    archives.notes(m.id, note); assert.equal(archives.meeting(m.id).notes, note);
    const document = Buffer.from('Synthetic context document\nExperiment target: generated pixels and tone only.\n');
    const imported = await artifacts.importDocument(m.id, 'fixture-context.md', Readable.from([document]), document.length);
    assert.deepEqual(fs.readFileSync(artifacts.file(m.id, imported.path)), document);
    assert.equal(imported.sha256, crypto.createHash('sha256').update(document).digest('hex'));
    assert.equal(artifacts.documentPacket(m.id)[0].sha256, imported.sha256);
    assert.equal(projects.assignment(m.id), project.id);
    report.checks.notesSavedAndRead = true; report.checks.contextCopiedWithHash = true; report.checks.projectAssignment = true;
    const recorder = start(capture, ['fixture', '--dir', archives.raw(m.id), '--mic', '--system-audio', '--segment-seconds', '5'], { stdio:'ignore' });
    await wait(() => { if (recorder.exitCode !== null || recorder.signalCode !== null) throw new Error('Synthetic recorder exited before recording.'); return archives.status(m.id)?.state === 'recording'; });
    await sleep(1200); await manager.command(m.id, 'pause'); await sleep(1200); await manager.command(m.id, 'resume');
    await sleep(1300); await manager.stop(m.id);
    await wait(() => recorder.exitCode !== null || recorder.signalCode !== null, 10000);
    const captureExit = await exits.get(recorder); assert.equal(captureExit.code, 0, JSON.stringify(captureExit));
    const manifest = archives.refresh(m.id);
    assert.equal(manifest.status, 'recorded');
    for (const kind of ['video','microphone','system']) assert(manifest.segments.some(segment => segment.kind === kind), `Missing ${kind} archive source.`);
    const raw = archives.raw(m.id);
    const before = fs.readdirSync(raw).filter(file => fs.statSync(path.join(raw, file)).isFile()).map(file => [file, sha256(path.join(raw, file))]);
    const plan = exportPlan(archives, m.id), pause = manifest.gaps.find(event => event.event === 'pause'), resume = manifest.gaps.find(event => event.event === 'resume');
    assert(Number.isFinite(pause?.pts?.seconds) && Number.isFinite(resume?.pts?.seconds));
    const gap = (pause.pts.seconds + resume.pts.seconds) / 2 - plan.originPTS;
    const job = exports.start(m.id);
    const completed = await wait(() => { const state = exports.jobs(m.id).find(item => item.id === job.id); return state && ['ready','failed','interrupted'].includes(state.status) && state; });
    assert.equal(completed.status, 'ready', completed.error);
    const inspect = file => JSON.parse(execFileSync(exporter, ['--inspect', file, '--sample-times', `0.5,${gap},${manifest.durationSeconds - 0.5}`],
      { cwd:process.cwd(), env:process.env, encoding:'utf8', timeout:30000, maxBuffer:1024 * 1024 }));
    const video = inspect(path.join(archives.dir(m.id), 'exports', job.id, 'meeting.mp4'));
    const audio = inspect(path.join(archives.dir(m.id), 'exports', job.id, 'recording.m4a'));
    assert.equal(video.videoTracks, 1); assert.equal(video.audioTracks, 1); assert.equal(audio.videoTracks, 0); assert.equal(audio.audioTracks, 1);
    assert(video.videoCodecs.includes('avc1')); assert(video.audioCodecs.includes('aac ')); assert(audio.audioCodecs.includes('aac '));
    assert(Math.abs(video.durationSeconds - manifest.durationSeconds) < 0.1); assert(Math.abs(audio.durationSeconds - manifest.durationSeconds) < 0.1);
    assert(video.samples[0].meanRGB > 15); assert(video.samples[1].meanRGB < 2); assert(video.samples[2].meanRGB > 15);
    assert(video.samples[0].audioRMS > 0.02); assert(video.samples[1].audioRMS < 0.001); assert(video.samples[2].audioRMS > 0.02);
    assert(audio.samples[0].audioRMS > 0.02); assert(audio.samples[1].audioRMS < 0.001); assert(audio.samples[2].audioRMS > 0.02);
    assert.deepEqual(fs.readdirSync(raw).filter(file => fs.statSync(path.join(raw, file)).isFile()).sort(), before.map(([file]) => file).sort());
    for (const [file, hash] of before) assert.equal(sha256(path.join(raw, file)), hash, `Raw file changed: ${file}`);
    for (const [file, hash] of bundleHashes) assert.equal(sha256(file), hash, `Bundle file changed: ${file}`);
    assert.equal(archives.meeting(m.id).notes, note); assert.deepEqual(fs.readFileSync(artifacts.file(m.id, imported.path)), document);
    Object.assign(report, { status:'passed', completedAt:new Date().toISOString(), exportId:job.id, durationSeconds:manifest.durationSeconds,
      pauseMidpointSeconds:gap, video, audio, contextDocument:imported, rawFileCount:before.length,
      checks:{ ...report.checks, bundledNode:true, bundledModulesOnly:true, bundledHelpers:true, cleanEnvironment:true, emptyWorkingDirectory:true,
        separateRawSources:true, mp4HasVideoAndMixedAudio:true, standaloneM4a:true, durationPreserved:true, gapVideoIsBlack:true,
        gapAudioIsSilent:true, beforeAfterGapPlayable:true, rawHashesUnchanged:true, bundleHashesUnchanged:true } });
    writeReport(report); console.log(JSON.stringify({ status:report.status, appPath:app, report:options.report, checks:report.checks }, null, 2));
  } catch (error) {
    writeReport({ ...report, status:'failed', completedAt:new Date().toISOString(), error:error.stack || error.message }); throw error;
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([Promise.all([...exits.values()]), sleep(1500)]);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

try {
  if (options['worker-root']) await validateMedia(); else await runUnderBundledNode();
} catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
