const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { ArchiveStore, atomicWrite, recoverWav } = require('../server/archive-store');
const { createRecorderServer } = require('../server/index');
const { defaults, load } = require('../server/archive-config');
const { SessionManager } = require('../server/archive-session');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-test-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const store = new ArchiveStore(root);
  const manifest = store.create({ window:{id:8,title:'Test',app:'Test'}, microphone:false, systemAudio:false }, defaults.recording, '测试会议');
  return { root, store, manifest };
}
function request(port, target, { method='GET', headers={}, body } = {}) {
  return new Promise((resolve,reject)=> {
    const req = http.request({ host:'127.0.0.1',port,path:target,method,headers },res=> {
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    }); req.on('error',reject); if(body) req.write(JSON.stringify(body)); req.end();
  });
}
test('raw archives survive truncated event logs and interrupted native tails', t => {
  const {store,manifest:m} = fixture(t), raw=store.raw(m.id);
  fs.writeFileSync(path.join(raw,'video-000001.mp4'),'committed');
  atomicWrite(path.join(raw,'video-000001.json'),JSON.stringify({kind:'video',file:'video-000001.mp4',status:'complete',startPTS:{seconds:100},endPTS:{seconds:110}}));
  fs.writeFileSync(path.join(raw,'video-000002.partial.mp4'),'tail');
  fs.writeFileSync(path.join(raw,'capture_events.jsonl'),'\n{"event":"gap","reason":"test"}\n{"event":');
  m.status='recording'; store.save(m);
  const result=store.refresh(m.id);
  assert.equal(result.status,'partial'); assert.equal(result.segments.length,1);
  assert.deepEqual(result.interruptedTail,['video-000002.partial.mp4']);
  assert.equal(fs.readFileSync(path.join(raw,'video-000001.mp4'),'utf8'),'committed');
  assert.throws(()=>store.dir('../private')); assert.throws(()=>store.media(m.id,'../capture_events.jsonl'));
});
test('Node restart discovers the same independent native host', t=> {
  const {root,store,manifest:m}=fixture(t);
  atomicWrite(path.join(store.raw(m.id),'capture-status.json'),JSON.stringify({pid:process.pid,hostID:'fixture-host',state:'recording',updatedAt:new Date().toISOString()}));
  assert.equal(new ArchiveStore(root).active()[0].id,m.id);
  assert.equal(new ArchiveStore(root).active()[0].capture.hostID,'fixture-host');
});
test('a stopped native status does not keep a stale starting manifest active', t => {
  const { store, manifest:m } = fixture(t);
  atomicWrite(path.join(store.raw(m.id), 'capture-status.json'), JSON.stringify({ pid: process.pid, state: 'recorded', updatedAt: new Date().toISOString() }));
  assert.deepEqual(store.active(), []);
});
test('directory snapshots tolerate a native partial commit and atomic status rename', t => {
  const {store,manifest:m}=fixture(t), raw=store.raw(m.id);
  m.status='recording';store.save(m);
  fs.writeFileSync(path.join(raw,'capture_events.jsonl'),JSON.stringify({event:'stopped',clean:true})+'\n');
  const partial=path.join(raw,'video-000001.partial.mp4'), final=path.join(raw,'video-000001.mp4');
  const temporary=path.join(raw,'capture-status.json.tmp-fixture');
  fs.writeFileSync(partial,'committed video');fs.writeFileSync(temporary,'{"state":"recorded"}');
  const originalStat=fs.statSync;let commits=0;
  t.mock.method(fs,'statSync',function(file,...args) {
    if(file===partial && fs.existsSync(partial)) {
      fs.renameSync(partial,final);commits++;
      atomicWrite(path.join(raw,'video-000001.json'),JSON.stringify({kind:'video',file:'video-000001.mp4',status:'complete',startPTS:{seconds:100},endPTS:{seconds:101}}));
    }
    if(file===temporary && fs.existsSync(temporary)) { fs.renameSync(temporary,path.join(raw,'capture-status.json'));commits++; }
    return originalStat.call(fs,file,...args);
  });
  const during=store.refresh(m.id);
  assert.equal(commits,2);assert.equal(during.status,'recorded');assert.deepEqual(during.interruptedTail,[]);
  const after=store.refresh(m.id);assert.equal(after.segments.length,1);assert.equal(after.segments[0].bytes,15);
  assert.equal(fs.readFileSync(final,'utf8'),'committed video');
});
test('archive inventory does not hide unrelated filesystem errors', t => {
  const {store,manifest:m}=fixture(t), blocked=path.join(store.raw(m.id),'unreadable.bin');fs.writeFileSync(blocked,'x');
  const originalStat=fs.statSync;
  t.mock.method(fs,'statSync',function(file,...args) {
    if(file===blocked) throw Object.assign(new Error('test permission denial'),{code:'EACCES'});
    return originalStat.call(fs,file,...args);
  });
  assert.throws(()=>store.refresh(m.id),{code:'EACCES'});
  assert.throws(()=>store.list(),{code:'EACCES'});
});
test('damaged historical manifest remains visible without blocking new recording preflight', async t => {
  const {store,manifest:m}=fixture(t), file=path.join(store.dir(m.id),'manifest.json');
  const original='{broken-manifest';fs.writeFileSync(file,original);
  const damaged=store.list()[0];assert.equal(damaged.status,'unavailable');assert.equal(damaged.archiveError.code,'MANIFEST_INVALID');
  assert.equal(store.active().length,0);assert.equal(fs.readFileSync(file,'utf8'),original);
  const sessions=new SessionManager(store,defaults,'/does/not/exist');let sourcesCalled=false;
  sessions.permissions=async()=>({screenRecording:'granted',microphone:'granted'});
  sessions.sources=async()=>{sourcesCalled=true;return {windows:[],microphones:[]};};
  sessions.previews.set('test-preview',{windowID:8,expires:Date.now()+10000});
  await assert.rejects(sessions.start({previewID:'test-preview',windowID:8,confirmed:true,microphone:false,systemAudio:false,fps:15}),/window is no longer available/);
  assert.equal(sourcesCalled,true);assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('a live native host still blocks recording when its manifest is corrupt or missing', async t => {
  const {store,manifest:m}=fixture(t), file=path.join(store.dir(m.id),'manifest.json');
  atomicWrite(path.join(store.raw(m.id),'capture-status.json'),JSON.stringify({pid:process.pid,hostID:'live-corrupt-fixture',state:'recording',updatedAt:new Date().toISOString()}));
  const sessions=new SessionManager(store,defaults,'/does/not/exist');let sourcesCalled=false;
  sessions.sources=async()=>{sourcesCalled=true;return {windows:[],microphones:[]};};
  for(const remove of [false,true]) {
    if(remove) fs.unlinkSync(file);else fs.writeFileSync(file,'{broken');
    const active=store.active();assert.equal(active.length,1);assert.equal(active[0].id,m.id);assert.equal(active[0].capture.hostID,'live-corrupt-fixture');
    assert.equal(active[0].archiveError.code,remove?'MANIFEST_MISSING':'MANIFEST_INVALID');
    await assert.rejects(sessions.start({}),{statusCode:409});
  }
  assert.equal(sourcesCalled,false);
});
test('WAV crash repair preserves raw bytes and drops only incomplete sample frames', t=> {
  const {root}=fixture(t); const original=path.join(root,'input.wav'), recovered=path.join(root,'output.wav');
  const buffer=Buffer.alloc(44+401); buffer.write('RIFF',0);buffer.writeUInt32LE(0,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);
  buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(2,22);buffer.writeUInt32LE(48000,24);buffer.writeUInt32LE(192000,28);buffer.writeUInt16LE(4,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(0,40);
  fs.writeFileSync(original,buffer); const digest=crypto.createHash('sha256').update(buffer).digest('hex');
  const result=recoverWav(original,recovered); assert.equal(result.frames,100);assert.equal(result.truncatedBytes,1);
  assert.equal(fs.readFileSync(recovered).readUInt32LE(40),400);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex'),digest);
});
test('proposal/unsafe settings fail closed; recorder does not load AI/MCP', t=> {
  const {root}=fixture(t);
  for(const config of [{schemaVersion:'2-proposal'},{server:{host:'0.0.0.0'}},{processing:{enabled:true}},{mcp:{enabled:true}}]) {
    fs.writeFileSync(path.join(root,'recorder-config.json'),JSON.stringify(config)); assert.throws(()=>load(root));
  }
});
test('start requires a recent preview and explicit input decisions before native capture', async t=> {
  const {store}=fixture(t); const sessions=new SessionManager(store,defaults,'/does/not/exist');
  // Remove fixture from the active starting state before testing validation.
  const m=store.list()[0];m.status='failed';store.save(m);
  await assert.rejects(sessions.start({windowID:10}),/preview/);
});
test('HTTP blocks unauthenticated, hostile origins and hosts; media supports ranges',async t=> {
  const {root,store,manifest:m}=fixture(t),raw=store.raw(m.id);
  fs.writeFileSync(path.join(raw,'video-000001.mp4'),'0123456789');
  atomicWrite(path.join(raw,'video-000001.json'),JSON.stringify({kind:'video',file:'video-000001.mp4',status:'complete',startPTS:{seconds:100},endPTS:{seconds:110}}));
  const runtime=createRecorderServer({dataDir:root,config:defaults,store,token:'test-only-token'});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>runtime.server.close(resolve)));const port=runtime.server.address().port;
  assert.equal((await request(port,'/api/meetings')).status,401);
  assert.equal((await request(port,'/api/meetings',{headers:{Authorization:'Bearer test-only-token',Origin:'https://attacker.example'}})).status,403);
  assert.equal((await request(port,'/',{headers:{Host:`attacker.example:${port}`}})).status,403);
  const auth=await request(port,'/api/session',{method:'POST',body:{token:'test-only-token'}});assert.equal(auth.status,200);
  assert.match(auth.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);const cookie=auth.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(port,'/api/meetings',{headers:{Cookie:cookie}})).status,200);
  const range=await request(port,`/api/meetings/${m.id}/media/video-000001.mp4`,{headers:{Cookie:cookie,Range:'bytes=2-5'}});
  assert.equal(range.status,206);assert.equal(range.body.toString(),'2345');assert.equal(range.headers['content-range'],'bytes 2-5/10');
  assert.equal((await request(port,`/api/meetings/${m.id}/media/video-000001.mp4`,{headers:{Cookie:cookie,Range:'bytes=100-200'}})).status,416);
  assert.equal((await request(port,'/mcp',{headers:{Cookie:cookie}})).status,404);
});
