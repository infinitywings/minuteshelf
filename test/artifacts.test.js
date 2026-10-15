const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { ArchiveStore, atomicWrite } = require('../server/archive-store');
const { ProjectStore } = require('../server/project-store');
const { MeetingArtifacts } = require('../server/meeting-artifacts');
const { audioSpans, exportPlan, MediaExports, workerLive } = require('../server/media-export');
const { SessionManager } = require('../server/archive-session');
const { defaults } = require('../server/archive-config');
const { createRecorderServer } = require('../server/index');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-artifact-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archives = new ArchiveStore(root), projects = new ProjectStore(root, archives);
  const m = archives.create({ window: { id: 1, app: 'Synthetic', title: 'Synthetic' }, microphone: false, systemAudio: true }, defaults.recording, '资料归档验证');
  m.status = 'failed'; archives.save(m); const artifacts = new MeetingArtifacts(archives, projects);
  return { root, archives, projects, artifacts, m };
}
function playbackFixture(t) {
  const f=fixture(t), raw=f.archives.raw(f.m.id);
  f.m.status='recorded';f.m.durationSeconds=10;f.m.timeline={originPTS:{seconds:0}};
  f.m.segments=['system','microphone'].map(kind=>{
    const file=kind+'-000001.wav', index=kind+'-000001.pts.jsonl';
    fs.writeFileSync(path.join(raw,file),'synthetic audio bytes');
    fs.writeFileSync(path.join(raw,index),JSON.stringify({pts:{seconds:0},frameOffset:0,frames:480000})+'\n');
    return {kind,file,index,sampleRate:48000,frames:480000,startPTS:{seconds:0},endPTS:{seconds:10}};
  });
  f.archives.save(f.m);f.archives.refresh=()=>f.m;
  const child=new EventEmitter();child.unref=()=>{};
  const exports=new MediaExports(f.archives,f.artifacts,{binary:'/bin/sleep',spawnWorker:()=>child});
  t.after(()=>child.removeAllListeners());return {...f,exports,child};
}
test('playback prepares one audio-only cache from every source and reuses a completed cache', t=>{
  const f=playbackFixture(t);assert.equal(f.exports.playback(f.m.id).status,'missing');
  const started=f.exports.playback(f.m.id,{create:true});assert.equal(started.status,'preparing');
  const dir=path.join(f.archives.dir(f.m.id),'exports',started.jobId);
  const plan=JSON.parse(fs.readFileSync(path.join(dir,'export-plan.json')));
  assert.equal(plan.video.length,0);assert.deepEqual(plan.audioSources.sort(),['microphone','system']);assert.equal(plan.mixedAudioGainPerSource,.5);
  fs.writeFileSync(path.join(dir,'recording.m4a'),'synthetic committed cache');
  const state=JSON.parse(fs.readFileSync(path.join(dir,'export-status.json')));
  state.status='ready';state.files=[{path:`exports/${started.jobId}/recording.m4a`}];fs.writeFileSync(path.join(dir,'export-status.json'),JSON.stringify(state));
  const ready=f.exports.playback(f.m.id,{create:true});assert.equal(ready.status,'ready');assert.equal(ready.jobId,started.jobId);
  fs.appendFileSync(path.join(f.archives.raw(f.m.id),'system-000001.pts.jsonl'),'\n');
  assert.equal(f.exports.playback(f.m.id).status,'missing','Changed source index invalidates the old mix');
});
test('playback never adopts an arbitrary export and never renders during active recording',t=>{
  const f=playbackFixture(t),id=crypto.randomUUID(),dir=path.join(f.archives.dir(f.m.id),'exports',id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'recording.m4a'),'single-source legacy export');
  fs.writeFileSync(path.join(dir,'export-status.json'),JSON.stringify({id,createdAt:new Date().toISOString(),status:'ready',files:[{path:`exports/${id}/recording.m4a`}]}));
  assert.equal(f.exports.playback(f.m.id).status,'missing');
  f.m.status='recording';assert.deepEqual(f.exports.playback(f.m.id,{create:true}),{status:'recording'});
  f.m.status='recorded';f.m.segments=[];assert.deepEqual(f.exports.playback(f.m.id),{status:'video-only'});
});
test('meeting folder copies context documents with hashes; duplicate filenames do not overwrite', async t => {
  const { archives, projects, artifacts, m } = fixture(t), p = projects.create({ name: '合成项目' }); projects.assign(m.id, p.id);
  const input = Buffer.from('会议背景\n保持原样'), hash = crypto.createHash('sha256').update(input).digest('hex');
  const a = await artifacts.importDocument(m.id, '背景文档.md', Readable.from([input]), input.length);
  const b = await artifacts.importDocument(m.id, '背景文档.md', Readable.from([Buffer.from('下一版')]));
  assert.notEqual(a.path, b.path); assert.equal(a.sha256, hash); assert.deepEqual(fs.readFileSync(artifacts.file(m.id, a.path)), input);
  const inventory = artifacts.inventory(m.id); assert.equal(inventory.documents.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archives.dir(m.id), 'project.json'))).project.id, p.id);
  assert(fs.existsSync(path.join(archives.dir(m.id), 'outputs'))); assert(fs.existsSync(path.join(archives.dir(m.id), 'exports')));
  assert.equal(artifacts.documentPacket(m.id)[0].sourceRef.kind, 'document_background');
  const portable = JSON.parse(fs.readFileSync(path.join(archives.dir(m.id), 'artifacts.json'))); assert.equal(portable.folder, undefined);
  assert(portable.entries.every(e => !path.isAbsolute(e.path)));
});
test('oversize/interrupted document imports cannot leave a committed artifact; unsafe paths and symlinks blocked', async t => {
  const { archives, projects, m } = fixture(t), artifacts = new MeetingArtifacts(archives, projects, { maxDocumentBytes: 4 });
  await assert.rejects(artifacts.importDocument(m.id, 'big.txt', Readable.from([Buffer.from('12345')])), /size/);
  await assert.rejects(artifacts.importDocument(m.id, 'short.txt', Readable.from([Buffer.from('123')]), 4), /complete/);
  assert.equal(artifacts.documents(m.id).length, 0);
  assert.equal(fs.readdirSync(path.join(archives.dir(m.id), 'context/documents')).length, 0);
  await artifacts.importDocument(m.id, '../../unsafe.txt', Readable.from([Buffer.from('x')]));
  assert.equal(artifacts.documents(m.id).length, 1); assert.throws(() => artifacts.file(m.id, '../manifest.json'));
  fs.symlinkSync('/etc/passwd', path.join(archives.dir(m.id), 'outputs/private.txt'));
  fs.writeFileSync(path.join(archives.dir(m.id), 'outputs/test.partial.mp4'), 'partial');
  assert.throws(() => artifacts.file(m.id, 'outputs/private.txt'));
  assert.throws(() => artifacts.file(m.id, 'outputs/test.partial.mp4'));
});
test('audio export mapping preserves delay, within-file gaps and accumulated drift instead of sample-count time', () => {
  const s = { file: 'system-000001.wav', sampleRate: 1000, frames: 400 };
  const records = [
    { frameOffset: 0, frames: 100, pts: { seconds: 102 } }, { frameOffset: 100, frames: 100, pts: { seconds: 102.1005 } },
    { frameOffset: 200, frames: 100, pts: { seconds: 105 } }, { frameOffset: 300, frames: 100, pts: { seconds: 105.1 } }
  ];
  assert.deepEqual(audioSpans(s, records, 100), [{ startSeconds: 2, frameOffset: 0, frames: 200 }, { startSeconds: 5, frameOffset: 200, frames: 200 }]);
  assert.throws(() => audioSpans(s, [records[0]], 100), /complete/);
  assert.throws(() => audioSpans(s, [{ ...records[0], frameOffset: 1 }], 100), /not contiguous/);
});
test('new recording cancels a live export even when its historical manifest is damaged', async t => {
  const {root,archives,artifacts,m}=fixture(t);
  // A harmless named sleeper exercises the real worker PID/name check and SIGTERM.
  const binary=path.join(root,'archive-export');fs.copyFileSync('/bin/sleep',binary);fs.chmodSync(binary,0o700);
  const child=spawn(binary,['30'],{stdio:'ignore'});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{child.kill('SIGTERM');await exited;});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const jobId=crypto.randomUUID(), jobDir=path.join(archives.dir(m.id),'exports',jobId);fs.mkdirSync(jobDir);
  const state={id:jobId,meetingId:m.id,pid:child.pid,status:'processing',createdAt:new Date().toISOString()};
  assert.equal(workerLive(state),true);
  atomicWrite(path.join(jobDir,'export-status.json'),JSON.stringify(state));
  fs.writeFileSync(path.join(archives.dir(m.id),'manifest.json'),'{broken');
  const exports=new MediaExports(archives,artifacts);
  assert.equal(exports.active().length,1);
  const sessions=new SessionManager(archives,defaults,'/does/not/exist');let sourcesCalled=false,preflightReached=false;
  sessions.permissions=async()=>({screenRecording:'granted',microphone:'granted'});
  sessions.sources=async()=>{sourcesCalled=true;return {windows:[{id:8}],microphones:[]};};
  sessions.previews.set('test-preview',{windowID:8,expires:Date.now()+10000});
  sessions.beforeStart=()=>{exports.cancelForRecording();preflightReached=true;throw new Error('fixture: before capture');};
  await assert.rejects(sessions.start({previewID:'test-preview',windowID:8,confirmed:true,microphone:false,systemAudio:false,fps:15}),/fixture: before capture/);
  assert.equal(sourcesCalled,true);assert.equal(preflightReached,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobDir,'export-status.json'))).status,'interrupted');
  await exited;assert.equal(exports.active().length,0);
  assert.equal(fs.readFileSync(path.join(archives.dir(m.id),'manifest.json'),'utf8'),'{broken');
});
for (const terminal of ['ready', 'failed']) test(`export status polling preserves ${terminal} committed while checking the worker PID`, t => {
  const { archives, artifacts, m } = fixture(t), jobId = crypto.randomUUID();
  const jobDir = path.join(archives.dir(m.id), 'exports', jobId); fs.mkdirSync(jobDir);
  const file = path.join(jobDir, 'export-status.json');
  const state = { id: jobId, meetingId: m.id, pid: 2147483646, status: 'processing', createdAt: new Date().toISOString(), progress: 0.9 };
  const completed = { ...state, status: terminal, progress: 1,
    ...(terminal === 'ready' ? { files: ['meeting.mp4'], durationSeconds: 50.856667 } : { error: 'Synthetic export validation failed.' }) };
  atomicWrite(file, JSON.stringify(state));
  const originalKill = process.kill; let exits = 0;
  t.mock.method(process, 'kill', function(pid, signal) {
    if (pid !== state.pid || signal !== 0) return originalKill.call(process, pid, signal);
    // Simulate native atomic terminal commit + exit after polling read
    // processing but before its liveness check completed.
    exits++; atomicWrite(file, JSON.stringify(completed));
    throw Object.assign(new Error('Synthetic worker exited'), { code: 'ESRCH' });
  });
  const exports = new MediaExports(archives, artifacts);
  assert.deepEqual(exports.jobs(m.id), [completed]);
  assert.equal(exits, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), completed);
});
test('a dead export without a terminal commit is still marked interrupted', t => {
  const { archives, artifacts, m } = fixture(t), jobId = crypto.randomUUID();
  const jobDir = path.join(archives.dir(m.id), 'exports', jobId); fs.mkdirSync(jobDir);
  const file = path.join(jobDir, 'export-status.json');
  const state = { id: jobId, meetingId: m.id, pid: 2147483646, status: 'processing', createdAt: new Date().toISOString() };
  atomicWrite(file, JSON.stringify(state));
  const originalKill = process.kill;
  t.mock.method(process, 'kill', function(pid, signal) {
    if (pid !== state.pid || signal !== 0) return originalKill.call(process, pid, signal);
    throw Object.assign(new Error('Synthetic dead worker'), { code: 'ESRCH' });
  });
  const exports = new MediaExports(archives, artifacts);
  assert.equal(exports.jobs(m.id)[0].status, 'interrupted');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'interrupted');
});
test('export plan preserves session duration, source options and PTS; rejects missing timeline/index and active capture', t => {
  const { archives, m } = fixture(t), raw = archives.raw(m.id);
  atomicWrite(path.join(raw, 'timeline.json'), JSON.stringify({ originPTS: { seconds: 100 } }));
  fs.writeFileSync(path.join(raw, 'capture_events.jsonl'), JSON.stringify({ event: 'stopped', clean: true, endPTS: { seconds: 110 } }) + '\n');
  fs.writeFileSync(path.join(raw, 'video-000001.mp4'), 'synthetic-placeholder');
  atomicWrite(path.join(raw, 'video-000001.json'), JSON.stringify({ file: 'video-000001.mp4', kind: 'video', status: 'complete', startPTS: { seconds: 101 }, endPTS: { seconds: 102 } }));
  fs.writeFileSync(path.join(raw, 'system-000001.wav'), 'synthetic-placeholder');
  atomicWrite(path.join(raw, 'system-000001.json'), JSON.stringify({ file: 'system-000001.wav', kind: 'system', status: 'complete', startPTS: { seconds: 102 }, endPTS: { seconds: 104 }, sampleRate: 48000, frames: 96000, index: 'system-000001.pts.jsonl' }));
  fs.writeFileSync(path.join(raw, 'system-000001.pts.jsonl'), JSON.stringify({ frameOffset: 0, frames: 96000, pts: { seconds: 102 } }) + '\n');
  const plan = exportPlan(archives, m.id); assert.equal(plan.durationSeconds, 10); assert.equal(plan.video[0].startSeconds, 1);
  assert.equal(plan.audio[0].spans[0].startSeconds, 2); assert.deepEqual(plan.audioSources, ['system']);
  assert.equal(exportPlan(archives, m.id, { audioSources: [] }).audio.length, 0);
  fs.writeFileSync(path.join(raw, 'system-000001.pts.jsonl'), ''); assert.throws(() => exportPlan(archives, m.id), /PTS/);
  atomicWrite(path.join(raw, 'capture-status.json'), JSON.stringify({ pid: process.pid, state: 'recording', updatedAt: new Date().toISOString() }));
  assert.throws(() => exportPlan(archives, m.id), /Stop/);
});
test('HTTP artifact import/download and folder opening require auth; documents join analysis context', async t => {
  const { root, archives, m } = fixture(t); let opened;
  const runtime = createRecorderServer({ dataDir: root, store: archives, config: defaults, token: 'artifact-test', openFolder: async folder => { opened = folder; } });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${runtime.server.address().port}/api/meetings/${m.id}`;
  const headers = { Authorization: 'Bearer artifact-test' }, input = Buffer.from('合成 context document');
  assert.equal((await fetch(`${base}/artifacts`)).status, 401);
  const upload = await fetch(`${base}/documents`, { method: 'POST', headers: { ...headers, 'X-File-Name': encodeURIComponent('背景.md'), 'Content-Type': 'application/octet-stream' }, body: input });
  assert.equal(upload.status, 201); const document = await upload.json();
  const response = await fetch(`${base}/artifact?path=${encodeURIComponent(document.path)}`, { headers });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), input);
  assert.equal((await (await fetch(`${base}/analysis-context`, { headers })).json()).documents[0].sha256, document.sha256);
  assert.equal((await fetch(`${base}/open-folder`, { method: 'POST', headers })).status, 200);
  assert.equal(opened, archives.dir(m.id));
  assert.equal((await fetch(`${base}/artifact?path=..%2Fmanifest.json`, { headers })).status, 404);
});
