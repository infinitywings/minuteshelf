// Fabricated pixels only. Validate CLI selection and video-only status wording;
// actual SCDisplay capture still requires an explicitly authorized live test.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'), binary=path.join(root,'.build/archivecap');
const raw=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-display-fixture-'));
const report={syntheticOnly:true,actualCapture:false,requestedPermissions:false,raw,checks:{}};
for(const args of [['preview'],['preview','--display','0'],['preview','--display','4294967296'],['preview','--display','7','--window','7'],['record','--display','7','--display','8']]) {
  const result=spawnSync(binary,args,{encoding:'utf8'});assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).event,'error');
}
report.checks.ambiguousOrInvalidTargetRejectedBeforePermission=true;
const child=spawn(binary,['fixture','--dir',raw,'--display','7','--max-edge','640','--segment-seconds','5','--fixture-scenario','frame-health'],{stdio:'ignore'});
const read=()=>{try{return JSON.parse(fs.readFileSync(path.join(raw,'capture-status.json')))}catch{return null}};
try {
  const deadline=Date.now()+12000;let status;
  while(Date.now()<deadline){status=read();if(status?.videoState==='suspended')break;if(child.exitCode!==null)throw Error('Display fixture exited');await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(status.videoState,'suspended');assert.equal(status.captureKind,'display');assert.equal(status.displayID,7);assert.equal(status.windowID,0);
  assert.match(status.videoWarning,/selected display.*suspended/);assert.match(status.videoWarning,/No audio source is recording/);assert.doesNotMatch(status.videoWarning,/audio continues|Restore.*window/i);
  const events=fs.readFileSync(path.join(raw,'capture_events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert(events.every(event=>event.kind!=='microphone'&&event.kind!=='system'));
  fs.writeFileSync(path.join(raw,'control/inbox/stop.json'),JSON.stringify({command:'stop'}));
  await new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(Error('Fixture failed')))});
  report.checks.displayMetadataAndVideoOnlyWarning=true;
  report.finalStatus=read();assert.equal(report.finalStatus.state,'recorded');assert.equal(report.finalStatus.diagnostics.counters.received.system,0);assert.equal(report.finalStatus.diagnostics.counters.received.microphone,0);
  fs.writeFileSync(path.join(root,'.build/display-native-selection.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({raw,checks:report.checks}));
} finally {if(child.exitCode===null)child.kill('SIGTERM')}
