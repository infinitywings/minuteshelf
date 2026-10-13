import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))), build=path.join(root,'.build');
fs.mkdirSync(build,{recursive:true});
const developer=spawnSync('xcode-select',['-p'],{encoding:'utf8'}).stdout.trim();
const swiftInclude=path.join(developer,'usr','include','swift');
const args=['-parse-as-library','-swift-version','5','-target','arm64-apple-macos15.0','-O','-module-cache-path',path.join(build,'module-cache')];
if(fs.existsSync(path.join(swiftInclude,'module.modulemap')) && fs.existsSync(path.join(swiftInclude,'bridging.modulemap'))) {
  // Old CLT installs can retain a duplicate module map after an upgrade.
  // Shadow that redundant file for this build only; never edit the toolchain.
  const blank=path.join(build,'empty.modulemap'),overlay=path.join(build,'swift-vfs.json');
  fs.writeFileSync(blank,'');
  fs.writeFileSync(overlay,JSON.stringify({version:0,'use-external-names':false,roots:[{type:'file',name:path.join(swiftInclude,'module.modulemap'),'external-contents':blank}]}));
  args.push('-vfsoverlay',overlay);
}
for (const [source, binary] of [['ArchiveCapture.swift','archivecap'],['ArchiveExport.swift','archive-export'],['AnalysisMedia.swift','analysis-media'],['AnalysisCredentialsCLI.swift','analysis-credentials']]) {
  const compile=[...args,'-o',path.join(build,binary),path.join(root,'native',source)];
  if(binary==='analysis-credentials') compile.push(path.join(root,'native','AnalysisCredentials.swift'));
  if(binary==='archivecap') compile.push('-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',path.join(root,'native','ArchiveCapture-Info.plist'));
  const result=spawnSync('xcrun',['swiftc',...compile],{stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) {process.exitCode=result.status??1;break;}
}
