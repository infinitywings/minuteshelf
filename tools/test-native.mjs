// Real native writer/IPC/crash tests with synthetic content only. No SCK or mic.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const {ArchiveStore}=require('../server/archive-store');
const {SessionManager}=require('../server/archive-session');
const {defaults}=require('../server/archive-config');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-native-validation-'));
const store=new ArchiveStore(data),binary=path.join(root,'.build','archivecap');
const children=[];const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check, timeout=12000) { const until=Date.now()+timeout;while(Date.now()<until){const value=await check();if(value)return value;await sleep(150);}throw new Error('Native test timed out'); }
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report={timestamp:new Date().toISOString(),syntheticOnly:true,node:process.version,architecture:process.arch,
  swift:execFileSync('swift',['--version'],{encoding:'utf8'}).trim(),
  upstreamCommit:'8d048f7034b8ff75b04640f48cf0c4f569b3c274',nativeBinarySHA256:hash(binary),recorderSourceSHA256:hash(path.join(root,'native','ArchiveCapture.swift')),
  dataPath:data,checks:{}};
let daemon;
try {
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const config={...defaults,server:{host:'127.0.0.1',port},recording:{...defaults.recording,segmentSeconds:5,maxLongEdgePixels:640}};
  fs.writeFileSync(path.join(data,'recorder-config.json'),JSON.stringify(config));
  async function startDaemon() {
    const child=spawn(process.execPath,[path.join(root,'server','index.js')],{env:{...process.env,MEETING_DATA:data},stdio:['ignore','pipe','pipe']});children.push(child);
    let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
    const token=await wait(()=>/\/#token=([a-f0-9]+)/.exec(output)?.[1] || (child.exitCode!==null ? Promise.reject(new Error(error)) : null));
    return {child,token};
  }
  async function api(target,method='GET',value) {
    const response=await fetch(`http://127.0.0.1:${port}${target}`,{method,headers:{Authorization:`Bearer ${daemon.token}`,'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
    const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
  }
  function startFixture(title) {
    const m=store.create({window:{id:1,title:'SYNTHETIC TEST · fabricated pixels',app:'Fixture'},microphone:true,microphoneID:'synthetic',systemAudio:true},config.recording,title);
    m.synthetic=true;store.save(m);
    const child=spawn(binary,['fixture','--dir',store.raw(m.id),'--mic','--system-audio','--segment-seconds','5'],{detached:true,stdio:'ignore'});children.push(child);child.unref();return {m,child};
  }
  const first=startFixture('合成测试 · Node 重启与回放');
  await wait(()=>store.status(first.m.id)?.state==='recording');
  const hostID=store.status(first.m.id).hostID;
  await wait(()=>store.refresh(first.m.id).segments.some(s=>s.kind==='video'));
  daemon=await startDaemon();
  assert.equal((await api('/api/status')).active[0].id,first.m.id);
  report.checks.nativeWriter=true;
  await api(`/api/meetings/${first.m.id}/bookmark`,'POST',{text:'合成数据书签'});
  await api(`/api/meetings/${first.m.id}/mic`,'POST',{enabled:false});
  assert.equal(store.status(first.m.id).micEnabled,false);
  await api(`/api/meetings/${first.m.id}/pause`,'POST',{});
  const before=JSON.stringify(store.status(first.m.id).lastWrittenPTS);
  await sleep(1200);assert.equal(JSON.stringify(store.status(first.m.id).lastWrittenPTS),before);
  await api(`/api/meetings/${first.m.id}/resume`,'POST',{});
  report.checks.pauseGatesAllSources=true;report.checks.micGateAcknowledged=true;
  const count=store.refresh(first.m.id).segments.filter(s=>s.kind==='video').length;
  daemon.child.kill('SIGKILL');await sleep(300);
  await wait(()=>store.refresh(first.m.id).segments.filter(s=>s.kind==='video').length>count);
  assert.equal(store.status(first.m.id).hostID,hostID);
  daemon=await startDaemon();
  assert.equal((await api('/api/status')).active[0].capture.hostID,hostID);
  report.checks.nodeCrashSurvivalAndReconnect=true;
  const stopped=await api(`/api/meetings/${first.m.id}/stop`,'POST',{});
  assert.equal(stopped.status,'recorded');assert.equal(stopped.bookmarks.length,1);
  const inspect=file=>JSON.parse(execFileSync(binary,['inspect','--file',file],{encoding:'utf8'}).trim());
  const committed=store.refresh(first.m.id).segments;
  const durationChecks=[];
  for(const segment of committed){const info=inspect(path.join(store.raw(first.m.id),segment.file));assert(info.playable);assert(info.durationSeconds>0);
    if(segment.kind==='video') {assert(info.decodedBoundaryFrames); const deltaMs=Math.abs(info.durationSeconds-(segment.endPTS.seconds-segment.startPTS.seconds))*1000;assert(deltaMs<100);durationChecks.push({file:segment.file,durationSeconds:info.durationSeconds,deltaMs});}
  }
  report.checks.allCommittedMediaPlayable=true;
  report.checks.videoBoundaryFramesDecode=true;report.videoDurationChecks=durationChecks;
  report.media=committed.map(s=>({file:s.file,frames:s.frames,sampleRate:s.sampleRate,channels:s.channels,startPTS:s.startPTS.seconds,endPTS:s.endPTS.seconds,bytes:s.bytes}));
  const firstVideo=committed.find(s=>s.kind==='video'),firstMic=committed.find(s=>s.kind==='microphone'),firstSystem=committed.find(s=>s.kind==='system');
  report.syntheticSourceStartDifferenceMs=Math.max(Math.abs(firstMic.startPTS.seconds-firstVideo.startPTS.seconds),Math.abs(firstSystem.startPTS.seconds-firstVideo.startPTS.seconds))*1000;
  assert.equal(report.syntheticSourceStartDifferenceMs,0);
  const second=startFixture('合成测试 · 原生进程中断');
  await wait(()=>store.refresh(second.m.id).segments.some(s=>s.kind==='video'));
  const original=store.refresh(second.m.id).segments.map(s=>({file:s.file,hash:hash(path.join(store.raw(second.m.id),s.file))}));
  await sleep(1000);second.child.kill('SIGKILL');await wait(()=>second.child.signalCode==='SIGKILL');
  const partial=store.refresh(second.m.id);assert.equal(partial.status,'partial');assert(partial.interruptedTail.length);
  const manager=new SessionManager(store,config,binary);const recovered=await manager.recover(second.m.id);
  assert(recovered.some(r=>r.recovered&&r.file.endsWith('.wav')));
  assert(recovered.filter(r=>r.recovered&&r.file.endsWith('.wav')).every(r=>r.index&&r.endPTS));
  for(const segment of original)assert.equal(hash(path.join(store.raw(second.m.id),segment.file)),segment.hash);
  report.checks.nativeCrashPreservesCommittedMedia=true;report.checks.interruptedWavRecovery=true;
  report.recovery=recovered;report.previewMeetingId=first.m.id;
  const reportFile=path.join(root,'.build','reports','native-validation.json');
  fs.mkdirSync(path.dirname(reportFile),{recursive:true});
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
  console.log(JSON.stringify({checks:report.checks,syntheticSourceStartDifferenceMs:report.syntheticSourceStartDifferenceMs,dataPath:data,previewMeetingId:first.m.id},null,2));
} finally {
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
}
