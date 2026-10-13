// Self-contained Apple Silicon app build. Runtime downloads are a separate,
// explicit step: this script never substitutes the developer's local Node.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, '.build');
const app = path.join(build, 'Meeting Archive.app');
const vendor = path.join(build, 'vendor', 'node');
const vendorNode = path.join(vendor, 'bin', 'node');
const codexVendor = path.join(build, 'vendor', 'codex');
const vendorCodex = path.join(codexVendor, 'bin', 'codex');
const identity = process.env.MEETING_SIGN_IDENTITY?.trim() || '-';
const developerID = identity !== '-';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple Silicon Mac.');
if (developerID && !identity.startsWith('Developer ID Application:')) throw new Error('MEETING_SIGN_IDENTITY must name a Developer ID Application certificate.');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('package.json has an unsupported version.');

function run(command, args, capture = false, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}${capture ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout?.trim() || '';
}
function assertRegular(file) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`Required regular file is missing: ${file}`);
}
function assertNotRunning() {
  // Replacing resources used by a live server can break saves and IPC. Never
  // stop that process here: the user must quit normally and save recordings.
  const processes = run('/bin/ps', ['-axo', 'pid=,command='], true).split('\n');
  const running = processes.filter(line => line.includes(`${app}/Contents/`)
    || line.includes(`${build}/archivecap `) || line.trimEnd().endsWith(`${build}/archivecap`)
    || line.includes(`${build}/archive-export `));
  if (running.length) throw new Error('The built app or a recorder/export worker is running. Stop and save recordings, quit Meeting Archive, and retry; no process was stopped.');
}
function runtimeModules(entry) {
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, ''))), seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    const relative = path.relative(root, file);
    if (!(relative.startsWith('server/') || relative === 'tools/desktop-server.js')) throw new Error(`Unexpected runtime module: ${relative}`);
    assertRegular(file); seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      const specifier = match[2];
      if (specifier.startsWith('.')) {
        const dependency = path.resolve(path.dirname(file), specifier);
        visit(path.extname(dependency) ? dependency : `${dependency}.js`);
      } else if (!builtins.has(specifier.replace(/^node:/, ''))) throw new Error(`Unbundled dependency: ${specifier}`);
    }
  }
  visit(entry); return [...seen].sort();
}
function copyFile(source, destination) {
  assertRegular(source); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
}
function copyAssets(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyAssets(from, to);
    else if (entry.isFile()) copyFile(from, to);
    else throw new Error(`Do not package symbolic links in web assets: ${from}`);
  }
}
function xml(value) { return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]); }
function setPlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (!pattern.test(plist)) throw new Error(`Info.plist is missing ${key}`);
  return plist.replace(pattern, (_, before, after) => before + xml(value) + after);
}
function sign(target, entitlements, hardened = developerID) {
  const args = ['--force', '--sign', identity];
  if (hardened) args.push('--options', 'runtime');
  if (developerID) args.push('--timestamp');
  if (entitlements) args.push('--entitlements', entitlements);
  args.push(target); run('/usr/bin/codesign', args);
}
function verify(target) { run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', target]); }
function isolatedCodexVersion(binary) {
  const temporary = fs.mkdtempSync(path.join(build, 'codex-version-'));
  try {
    const codexHome = path.join(temporary, 'codex'); fs.mkdirSync(codexHome, { mode:0o700 });
    return run(binary, ['--version'], true, { cwd:temporary,
      env:{ PATH:'/usr/bin:/bin', HOME:temporary, CODEX_HOME:codexHome, TMPDIR:temporary, LANG:'en_US.UTF-8' } });
  } finally { fs.rmSync(temporary, { recursive:true, force:true }); }
}

assertRegular(vendorNode); assertRegular(path.join(vendor, 'LICENSE'));
const runtimeLock = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'node-runtime.lock.json'), 'utf8'));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (digest(vendorNode) !== runtimeLock.binarySha256 || digest(path.join(vendor, 'LICENSE')) !== runtimeLock.licenseSha256) {
  throw new Error('Vendor Node or LICENSE does not match tools/node-runtime.lock.json. Restore the verified official runtime.');
}
if (run('/usr/bin/lipo', ['-archs', vendorNode], true) !== 'arm64') throw new Error('The bundled Node runtime must be the official darwin-arm64 build.');
const dependencies = run('/usr/bin/otool', ['-L', vendorNode], true).split('\n').slice(1).map(line => line.trim().split(/\s+\(/)[0]).filter(Boolean);
if (!dependencies.length || dependencies.some(name => !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/'))) {
  throw new Error('Node has non-system dynamic-library dependencies. Supply the official standalone darwin-arm64 runtime, not Homebrew Node.');
}
const nodeVersion = run(vendorNode, ['--version'], true);
if (!/^v\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error('The vendor Node runtime did not report a valid version.');
if (nodeVersion.replace(/^v/, '') !== runtimeLock.version.replace(/^v/, '')) throw new Error('Vendor Node version does not match the runtime lock.');
const codexLock = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'codex-runtime.lock.json'), 'utf8'));
for (const [name, expected] of [['bin/codex', codexLock.binarySha256], ['LICENSE', codexLock.licenseSha256], ['NOTICE', codexLock.noticeSha256]]) {
  const file = path.join(codexVendor, name); assertRegular(file);
  if (digest(file) !== expected) throw new Error(`Vendor Codex ${name} does not match tools/codex-runtime.lock.json. Run the explicit runtime fetch step.`);
}
if (run('/usr/bin/lipo', ['-archs', vendorCodex], true) !== 'arm64') throw new Error('The bundled Codex runtime must be the official darwin-arm64 build.');
const codexDependencies = run('/usr/bin/otool', ['-L', vendorCodex], true).split('\n').slice(1).map(line => line.trim().split(/\s+\(/)[0]).filter(Boolean);
if (!codexDependencies.length || codexDependencies.some(name => !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/'))) {
  throw new Error('Codex has non-system dynamic-library dependencies. Supply the pinned standalone official binary.');
}
const codexVersion = isolatedCodexVersion(vendorCodex);
if (codexVersion !== `codex-cli ${codexLock.version}`) throw new Error('Vendor Codex version does not match its runtime lock.');
assertNotRunning();
fs.mkdirSync(build, { recursive: true });
const lockPath = path.join(build, 'app-build.lock');
let lock;
try { lock = fs.openSync(lockPath, 'wx', 0o600); }
catch (error) { if (error.code === 'EEXIST') throw new Error('Another build may be running. Check .build/app-build.lock before retrying.'); throw error; }
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
const staging = fs.mkdtempSync(path.join(build, 'app-staging-'));
const stagedApp = path.join(staging, 'Meeting Archive.app');
const contents = path.join(stagedApp, 'Contents'), resources = path.join(contents, 'Resources'), runtime = path.join(resources, 'runtime');
try {
  run(process.execPath, [path.join(root, 'tools', 'build-native.mjs')]);
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  const modules = runtimeModules(path.join(root, 'tools', 'desktop-server.js'));
  for (const source of modules) copyFile(source, path.join(runtime, path.relative(root, source)));
  for (const name of ['recorder.html', 'recorder.js', 'recorder.css', 'analysis.js']) copyFile(path.join(root, 'web', name), path.join(runtime, 'web', name));
  copyAssets(path.join(root, 'web', 'brand'), path.join(runtime, 'web', 'brand'));
  if (fs.existsSync(path.join(root, 'web', 'assets'))) copyAssets(path.join(root, 'web', 'assets'), path.join(runtime, 'web', 'assets'));
  copyFile(path.join(root, 'LICENSE'), path.join(resources, 'LICENSE'));
  copyFile(path.join(vendor, 'LICENSE'), path.join(resources, 'Licenses', 'Node-LICENSE.txt'));
  copyFile(path.join(root, 'tools', 'node-runtime.lock.json'), path.join(resources, 'Licenses', 'Node-runtime.lock.json'));
  if (fs.existsSync(path.join(vendor, 'runtime.json'))) copyFile(path.join(vendor, 'runtime.json'), path.join(resources, 'Licenses', 'Node-runtime.json'));
  const bundledNode = path.join(contents, 'Helpers', 'node');
  copyFile(vendorNode, bundledNode); fs.chmodSync(bundledNode, 0o755);
  const bundledCodex = path.join(contents, 'Helpers', 'codex');
  copyFile(vendorCodex, bundledCodex); fs.chmodSync(bundledCodex, 0o755);
  for (const name of ['LICENSE', 'NOTICE']) copyFile(path.join(codexVendor, name), path.join(resources, 'Licenses', `Codex-${name}.txt`));
  copyFile(path.join(root, 'tools', 'codex-runtime.lock.json'), path.join(resources, 'Licenses', 'Codex-runtime.lock.json'));
  if (fs.existsSync(path.join(codexVendor, 'runtime.json'))) copyFile(path.join(codexVendor, 'runtime.json'), path.join(resources, 'Licenses', 'Codex-runtime.json'));
  for (const name of ['archivecap', 'archive-export', 'analysis-media']) {
    const target = path.join(runtime, '.build', name); copyFile(path.join(build, name), target); fs.chmodSync(target, 0o755);
  }
  copyFile(path.join(root, 'tools', 'local-asr.py'), path.join(runtime, 'tools', 'local-asr.py'));
  const credentialsHelper = path.join(contents, 'Helpers', 'analysis-credentials');
  copyFile(path.join(build, 'analysis-credentials'), credentialsHelper); fs.chmodSync(credentialsHelper, 0o755);
  let plist = fs.readFileSync(path.join(root, 'native', 'MeetingArchiveApp-Info.plist'), 'utf8');
  plist = setPlistString(plist, 'CFBundleIdentifier', 'local.meetingarchive.app');
  plist = setPlistString(plist, 'CFBundleVersion', version.split('-')[0]);
  plist = setPlistString(plist, 'CFBundleShortVersionString', version);
  plist = setPlistString(plist, 'MeetingArchiveDistribution', developerID ? 'developer-id' : 'adhoc');
  if (/__NODE_EXECUTABLE__|MeetingArchiveNodePath/.test(plist)) throw new Error('Info.plist still embeds a developer-local Node path.');
  const icon = path.join(root, 'native', 'MeetingArchive.icns');
  if (fs.existsSync(icon)) {
    copyFile(icon, path.join(resources, 'MeetingArchive.icns'));
    plist = plist.replace('<!-- APP_ICON -->', '<key>CFBundleIconFile</key><string>MeetingArchive.icns</string>');
  }
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  const information = { schemaVersion: 1, version, architecture: 'arm64', minimumMacOS: '15.0', builtAt: new Date().toISOString(),
    node: { version: nodeVersion, sourceSHA256: runtimeLock.binarySha256, archiveSHA256: runtimeLock.sha256, systemDependencies: dependencies },
    codex: { version: codexLock.version, sourceSHA256: codexLock.binarySha256, archiveSHA256: codexLock.sha256, systemDependencies: codexDependencies, scope:'managed-account-and-post-meeting-analysis' },
    signing: { kind: developerID ? 'developer-id' : 'adhoc', identity, notarization: 'not-submitted' },
    runtimeModules: modules.map(file => path.relative(root, file)) };
  fs.writeFileSync(path.join(resources, 'build-info.json'), JSON.stringify(information, null, 2) + '\n');
  fs.writeFileSync(path.join(resources, 'DISTRIBUTION.txt'), `Meeting Archive ${version}\nApple Silicon · macOS 15 or later\nBundled Node.js ${nodeVersion} and Codex ${codexLock.version}; no Node, Codex CLI, or Homebrew installation is required.\nCodex is included for the optional managed account connection; post-meeting image and text analysis use the selected provider. Local MLX speech requires explicit runtime and model setup.\nDefault recordings: ~/Library/Application Support/Meeting Archive\n${developerID ? 'Developer ID signed; Apple notarization has NOT been submitted.' : 'Ad-hoc signed local build; NOT Developer ID signed or Apple notarized.'}\n`);
  const developer = run('/usr/bin/xcode-select', ['-p'], true);
  const swiftInclude = path.join(developer, 'usr', 'include', 'swift');
  const args = ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macos15.0', '-O', '-module-cache-path', path.join(build, 'module-cache')];
  if (fs.existsSync(path.join(swiftInclude, 'module.modulemap')) && fs.existsSync(path.join(swiftInclude, 'bridging.modulemap'))) args.push('-vfsoverlay', path.join(build, 'swift-vfs.json'));
  args.push('-o', path.join(contents, 'MacOS', 'MeetingArchive'),
    path.join(root, 'native', 'MeetingArchiveApp.swift'), path.join(root, 'native', 'MeetingArchiveShell.swift'),
    path.join(root, 'native', 'AnalysisPreferences.swift'), path.join(root, 'native', 'AnalysisCredentials.swift'), path.join(root, 'native', 'CodexConnection.swift'),
    path.join(root, 'native', 'ModelCatalog.swift'), path.join(root, 'native', 'ClaudeModelDiscovery.swift'),
    path.join(root, 'native', 'ClaudePublishedModels.swift'));
  run('/usr/bin/xcrun', args);
  // Only the V8 runtime needs JIT. The native app/recorders get no JIT or
  // library-validation exceptions. Do not sign nested code using --deep.
  const nodeEntitlements = path.join(root, 'native', 'Node.entitlements');
  assertRegular(nodeEntitlements);
  sign(bundledNode, nodeEntitlements, true); verify(bundledNode);
  // Exercise V8 after signing, before publishing the bundle.
  run(bundledNode, ['-e', 'let value=0; for(let i=0;i<100000;i++) value+=Math.sqrt(i); if(!Number.isFinite(value)) process.exit(1); console.log(process.version,process.arch);']);
  sign(bundledCodex, undefined, true); verify(bundledCodex);
  if (isolatedCodexVersion(bundledCodex) !== codexVersion) throw new Error('The signed bundled Codex runtime did not execute correctly.');
  const captureEntitlements = path.join(root, 'native', 'ArchiveCapture.entitlements');
  assertRegular(captureEntitlements);
  for (const name of ['archivecap', 'archive-export', 'analysis-media']) {
    const binary = path.join(runtime, '.build', name);
    sign(binary, name === 'archivecap' ? captureEntitlements : undefined); verify(binary);
  }
  sign(credentialsHelper); verify(credentialsHelper);
  sign(stagedApp); verify(stagedApp);
  // Verification may recurse; signing above is deliberately inside-out.
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
  assertNotRunning();
  const previous = path.join(staging, 'Previous Meeting Archive.app');
  if (fs.existsSync(app)) fs.renameSync(app, previous);
  try { fs.renameSync(stagedApp, app); }
  catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, app); throw error; }
  console.log(`Self-contained app: ${app}\nNode: ${nodeVersion} (bundled)\nCodex: ${codexLock.version} (bundled, managed account connection)\nSigning: ${information.signing.kind}; notarization NOT submitted.`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.closeSync(lock); fs.unlinkSync(lockPath);
}
