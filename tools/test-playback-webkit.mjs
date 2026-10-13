// Copy only the required real archive media and metadata to an isolated root.
// Exercise our actual HTML/controller in an owned WKWebView test host; no SCK.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url), {createRecorderServer}=require('../server/index');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const archive=process.argv[2];
if(!archive) throw new Error('Supply an explicit Testing3 archive path. This test reads it without modification.');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-webkit-playback-'));
const output=path.resolve(process.argv[3] || path.join(temporary,'screenshots'));
fs.mkdirSync(output,{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(archive,'manifest.json'))), id=manifest.id;
const copy=path.join(temporary,'meetings',id); fs.mkdirSync(copy,{recursive:true});
const hashes=directory=>Object.fromEntries(fs.readdirSync(path.join(directory,'raw')).filter(name=>fs.statSync(path.join(directory,'raw',name)).isFile()).map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'raw',name))).digest('hex')]));
const before=hashes(archive);
fs.copyFileSync(path.join(archive,'manifest.json'),path.join(copy,'manifest.json'));
fs.cpSync(path.join(archive,'raw'),path.join(copy,'raw'),{recursive:true});
fs.writeFileSync(path.join(copy,'user_notes.md'),'');
for(const dir of ['context/documents','outputs','exports']) fs.mkdirSync(path.join(copy,dir),{recursive:true});
const token=crypto.randomUUID();
const runtime=createRecorderServer({dataDir:temporary,token});
await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
try {
  const binary=path.join(root,'.build','playback-webkit-tests');
  const args=['swiftc','-parse-as-library','-swift-version','5','-target','arm64-apple-macos15.0','-module-cache-path',path.join(root,'.build/module-cache')];
  if(fs.existsSync(path.join(root,'.build/swift-vfs.json'))) args.push('-vfsoverlay',path.join(root,'.build/swift-vfs.json'));
  for(const name of ['MeetingArchiveShell','AnalysisPreferences','AnalysisCredentials','CodexConnection','ModelCatalog','ClaudeModelDiscovery','ClaudePublishedModels']) args.push(path.join(root,'native',name+'.swift'));
  args.push(path.join(root,'test/PlaybackWebKit.swift'),'-o',binary);
  execFileSync('/usr/bin/xcrun',args,{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const child=spawn(binary,[`http://127.0.0.1:${runtime.server.address().port}/#token=${token}`,id,output,...(process.argv.includes('--native-shell')?['--native-shell']:[])],{stdio:['ignore','pipe','pipe']});
    let errors='';child.stderr.on('data',data=>errors=(errors+data).slice(-3000));child.stdout.resume();
    const timeout=setTimeout(()=>child.kill('SIGTERM'),45000);
    child.on('error',error=>{clearTimeout(timeout);reject(error)});
    child.on('close',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(`WebKit test exited ${code}: ${errors}`))});
  });
  const after=hashes(archive);
  const report=JSON.parse(fs.readFileSync(path.join(output,'webkit-report.json')));
  report.rawInputsUnchanged=JSON.stringify(before)===JSON.stringify(after);report.isolatedDataPath=temporary;
  fs.writeFileSync(path.join(output,'webkit-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,rawInputsUnchanged:report.rawInputsUnchanged,measurements:report.measurements.map(({name,hidden,readyState,networkState,videoWidth,videoHeight,currentTime,canvasMeanRGB,snapshotCenterRGB})=>({name,hidden,readyState,networkState,videoWidth,videoHeight,currentTime,canvasMeanRGB,snapshotCenterRGB}))},null,2));
} finally { await new Promise(resolve=>runtime.server.close(resolve)); }
