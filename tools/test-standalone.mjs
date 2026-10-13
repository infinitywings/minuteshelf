// Validate the shipped bundle, not the source checkout. Never records media or
// requests capture permissions. --dmg additionally tests a read-only mounted image.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBundleContents, validateBundlePlist, validateAppSignature } from './bundle-policy.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const systemPath = '/usr/bin:/bin';
const magicNumbers = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

export function parseArguments(argv, base = repository) {
  const options = { app:path.join(base, '.build', 'MinuteShelf.app'), report:path.join(base, '.build', 'reports', 'standalone-validation.json'), timeoutMs:90000 };
  let explicitApp = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') { options.help = true; continue; }
    if (!['--app','--dmg','--report','--timeout-ms'].includes(argument) || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    const value = argv[++index];
    if (argument === '--timeout-ms') {
      options.timeoutMs = Number(value);
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000) throw new Error('Timeout must be between 1000 and 300000 milliseconds');
    } else {
      options[argument.slice(2)] = path.resolve(value);
      if (argument === '--app') explicitApp = true;
    }
  }
  if (options.dmg && explicitApp) throw new Error('Choose --app or --dmg, not both');
  return options;
}
export function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export function parseLibraries(output) {
  return [...new Set(output.split('\n').map(line => /^\s+(.+?) \((?:compatibility|current) version /.exec(line)?.[1]).filter(Boolean))];
}
export function parseRpaths(output) {
  const paths = []; let inRpath = false;
  for (const line of output.split('\n')) {
    if (/^\s*cmd\s+/.test(line)) inRpath = /^\s*cmd\s+LC_RPATH\s*$/.test(line);
    if (inRpath) { const match = /^\s*path\s+(.+?)\s+\(offset\s+\d+\)/.exec(line); if (match) { paths.push(match[1]); inRpath = false; } }
  }
  return [...new Set(paths)];
}
function systemLibrary(name) { return name.startsWith('/usr/lib/') || name.startsWith('/System/Library/'); }
function expandLoaderPath(name, binary, executable) {
  if (name === '@loader_path' || name.startsWith('@loader_path/')) return path.resolve(path.dirname(binary), name.slice('@loader_path'.length).replace(/^\//, ''));
  if (name === '@executable_path' || name.startsWith('@executable_path/')) return path.resolve(path.dirname(executable), name.slice('@executable_path'.length).replace(/^\//, ''));
  return name;
}
export function resolveLibrary(name, { bundle, binary, executable = binary, rpaths = [] }) {
  const candidates = name.startsWith('@rpath/')
    ? rpaths.map(rpath => path.join(expandLoaderPath(rpath, binary, executable), name.slice('@rpath/'.length)))
    : [expandLoaderPath(name, binary, executable)];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    // Many system libraries exist only in the dyld shared cache.
    if (systemLibrary(normalized)) return { name, resolved:normalized, scope:'system' };
    if (isWithin(bundle, normalized) && fs.existsSync(normalized)) {
      const real = fs.realpathSync(normalized);
      if (isWithin(fs.realpathSync(bundle), real)) return { name, resolved:real, scope:'bundle' };
    }
  }
  throw new Error(`Non-system dependency is outside the bundle or unresolved: ${name} (${path.relative(bundle, binary)})`);
}
export function parseSmokeResult(output) {
  for (const line of output.split('\n').reverse()) {
    try { const value = JSON.parse(line); if (value && Object.hasOwn(value, 'launchReady')) return value; } catch {}
  }
  throw new Error('The app did not return a smoke-test result');
}
export function validateCodexVersion(output, expectedVersion) {
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, 'Codex lock must specify a stable version');
  assert.equal(output.trim(), `codex-cli ${expectedVersion}`, 'Bundled Codex version does not match its lock');
  return expectedVersion;
}
export function validateCodexProtocol(clientRequest, initialize, accountRead, login) {
  const methods = (clientRequest.oneOf || []).flatMap(value => value.properties?.method?.enum || []);
  for (const method of ['initialize','account/read','account/login/start','account/login/cancel','account/logout']) assert(methods.includes(method), `Bundled Codex protocol is missing ${method}`);
  assert(initialize.required?.includes('clientInfo'), 'Codex initialize schema is missing clientInfo');
  assert.equal(accountRead.properties?.refreshToken?.type, 'boolean', 'Codex account/read must support explicit refreshToken:false');
  const managedLogin = login.oneOf?.find(value => value.properties?.type?.enum?.includes('chatgpt'));
  assert(managedLogin?.required?.includes('type'), 'Codex schema is missing the managed ChatGPT login flow');
  assert(!managedLogin.required.some(key => ['accessToken','refreshToken','apiKey'].includes(key)), 'Managed ChatGPT login must not require client-supplied credentials');
  return { initializeSchema:'v1', accountSchema:'v2', managedChatgptLogin:true,
    requiredMethods:['initialize','account/read','account/login/start','account/login/cancel','account/logout'], loginStarted:false, accountRead:false };
}
export function validateSmokeResult(smoke, expectedNode, expectedVersion) {
  for (const check of ['launchReady','desktopBridge','quitEditorLock','cancelRestoresFocus','safeQuit']) assert.equal(smoke[check], true, `${check} did not pass`);
  // The native shell must report checks performed against actual AppKit
  // controls and its received Web state, not merely a successful HTML load.
  assert(smoke.nativeShell && typeof smoke.nativeShell === 'object' && !Array.isArray(smoke.nativeShell), 'nativeShell checks are missing');
  for (const check of ['sidebar','toolbar','nativeSearch','webSidebarHidden','stateSnapshot','actionRoundTrip','quitControlsLocked','cancelRestoresNativeControls','nativeLibrary','nativeSettings']) assert.equal(smoke.nativeShell[check], true, `nativeShell.${check} did not pass`);
  assert.equal(smoke.activeMeetings, 0, 'Smoke test must have no active recordings');
  assert.equal(smoke.requestedPermissions, false, 'Smoke test must not request capture permission');
  assert.equal(smoke.nodeVersion, expectedVersion, 'App server used a different Node version');
  assert.equal(typeof smoke.nodeExecPath, 'string', 'App server must report its actual process.execPath');
  assert.equal(fs.realpathSync(smoke.nodeExecPath), fs.realpathSync(expectedNode), 'App server did not use the relocated bundled Node');
}
function runTool(command, args, { allowFailure = false, input, timeout = 30000, env, cwd } = {}) {
  const result = spawnSync(command, args, { encoding:'utf8', input, timeout, maxBuffer:4 * 1024 * 1024, env, cwd });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${path.basename(command)} exited ${result.status}: ${(result.stderr || result.stdout).slice(-8000)}`);
  return { status:result.status, stdout:result.stdout || '', stderr:result.stderr || '' };
}
function readPlist(file) { return JSON.parse(runTool('/usr/bin/plutil', ['-convert','json','-o','-',file]).stdout); }
function plistOutput(text) { return JSON.parse(runTool('/usr/bin/plutil', ['-convert','json','-o','-','-'], { input:text }).stdout); }
function sha256(file) {
  const hash = crypto.createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function bundleFiles(bundle) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes:true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        assert(isWithin(bundle, fs.realpathSync(absolute)), `External bundle symlink: ${absolute}`);
        files.push({ absolute, relative:path.relative(bundle, absolute), symlink:fs.readlinkSync(absolute) });
      } else if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative:path.relative(bundle, absolute) });
      else throw new Error(`Unsupported bundle filesystem entry: ${absolute}`);
    }
  }
  visit(bundle); return files;
}
function isMachO(file) {
  const descriptor = fs.openSync(file, 'r'), bytes = Buffer.alloc(4);
  try { return fs.readSync(descriptor, bytes, 0, 4, 0) === 4 && magicNumbers.has(bytes.readUInt32BE(0)); }
  finally { fs.closeSync(descriptor); }
}
function bundleSnapshot(bundle) {
  return bundleFiles(bundle).map(file => file.symlink !== undefined ? { path:file.relative, symlink:file.symlink }
    : { path:file.relative, bytes:fs.statSync(file.absolute).size, sha256:sha256(file.absolute) });
}
function inspectMachO(bundle) {
  const main = path.join(bundle, 'Contents', 'MacOS', 'MeetingArchive');
  return bundleFiles(bundle).filter(file => file.symlink === undefined && isMachO(file.absolute)).map(file => {
    const libraries = parseLibraries(runTool('/usr/bin/otool', ['-L',file.absolute]).stdout);
    assert(libraries.length, `No dynamic library records found for ${file.relative}`);
    const rpaths = parseRpaths(runTool('/usr/bin/otool', ['-l',file.absolute]).stdout);
    const context = { bundle, binary:file.absolute, executable:file.relative.endsWith('.dylib') ? main : file.absolute, rpaths };
    // Reject latent developer/Homebrew search paths as well as loaded libraries.
    for (const rpath of rpaths) {
      const resolved = expandLoaderPath(rpath, context.binary, context.executable);
      assert(path.isAbsolute(resolved) && (systemLibrary(resolved + '/') || isWithin(bundle, resolved)), `External runpath in ${file.relative}: ${rpath}`);
    }
    const dependencies = libraries.map(library => resolveLibrary(library, context));
    runTool('/usr/bin/codesign', ['--verify','--strict',file.absolute]);
    return { file:file.relative, sha256:sha256(file.absolute), rpaths, dependencies, signatureValid:true };
  });
}
function signatureDetails(bundle, information) {
  runTool('/usr/bin/codesign', ['--verify','--deep','--strict',bundle]);
  const output = runTool('/usr/bin/codesign', ['--display','--verbose=4',bundle]);
  const display = output.stdout + output.stderr;
  const requirements = runTool('/usr/bin/codesign', ['--display','-r-',bundle]);
  const identity = validateAppSignature(display, requirements.stdout + requirements.stderr, information);
  const authorities = [...display.matchAll(/^Authority=(.+)$/gm)].map(match => match[1]);
  const adhoc = /^Signature=adhoc$/m.test(display), developerID = authorities.some(authority => authority.startsWith('Developer ID Application:'));
  const stapler = runTool('/usr/bin/xcrun', ['--find','stapler'], { allowFailure:true });
  const ticket = stapler.status === 0 ? runTool(stapler.stdout.trim(), ['validate',bundle], { allowFailure:true }) : null;
  return { valid:true, cdhash:identity.cdhash, designatedRequirementVerified:true, kind:adhoc ? 'ad-hoc' : developerID ? 'developer-id' : 'other', developerID, authorities,
    teamIdentifier:/^TeamIdentifier=(.+)$/m.exec(display)?.[1] || null,
    stapledTicket:ticket ? ticket.status === 0 : null,
    notarized:adhoc ? false : ticket?.status === 0 ? true : null,
    notarizationEvidence:adhoc ? 'Ad-hoc signed, not a Developer ID notarized distribution.' : ticket?.status === 0 ? 'Stapled ticket validated.' : 'Notarization not verified; absence of a stapled ticket alone does not establish online status.',
    staplerStatus:ticket?.status ?? null, staplerOutput:ticket ? (ticket.stdout + ticket.stderr).trim().slice(-2000) : 'stapler unavailable' };
}
function cleanEnvironment(data, tempDirectory) {
  const environment = { PATH:systemPath, LANG:'en_US.UTF-8', TMPDIR:tempDirectory + path.sep, MEETING_DATA:data };
  for (const key of ['HOME','USER','LOGNAME','TZ']) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}
function runtimeProfile(deniedDirectories) {
  // JSON string quoting is valid for these sandbox string literals, not shell code.
  return `(version 1)\n(allow default)\n${deniedDirectories.map(directory => `(deny file-read* (subpath ${JSON.stringify(directory)}))`).join('\n')}\n`;
}
async function runApp(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd:options.cwd, env:options.env, detached:true, stdio:['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', failed = null, killTimer;
    const killGroup = signal => {
      if (!Number.isInteger(child.pid)) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') failed ||= new Error(`Could not stop the owned test process group: ${error.message}`); }
    };
    const abort = error => { if (failed) return; failed = error; killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), 1500); };
    const timer = setTimeout(() => abort(new Error(`App smoke test timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 2 * 1024 * 1024) abort(new Error('Smoke test stdout exceeded 2 MiB')); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-64000); });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      // This isolated group only contains processes started by this test. Clean
      // up a leftover test backend even if an error made its parent exit first.
      killGroup('SIGKILL');
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Relocated app exited ${code ?? signal}: ${stderr.slice(-8000)}`));
      else resolve({ stdout, stderr, exitCode:code });
    });
  });
}
function mountedAt(directory) {
  const table = runTool('/sbin/mount', []).stdout;
  return table.split('\n').find(line => line.includes(` on ${directory} (`));
}
function mountDmg(image, mountpoint) {
  const attached = plistOutput(runTool('/usr/bin/hdiutil', ['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mountpoint,'-plist',image], { timeout:60000 }).stdout);
  const entity = attached['system-entities']?.find(item => item['mount-point'] && fs.realpathSync(item['mount-point']) === fs.realpathSync(mountpoint));
  assert(entity, 'hdiutil did not mount the image at the owned test mountpoint');
  const mountLine = mountedAt(mountpoint); assert(mountLine && /(?:\(|,\s*)read-only(?:,|\))/.test(mountLine), `Mounted volume is not read-only: ${mountLine}`);
  const probe = path.join(mountpoint, `.meeting-read-only-check-${crypto.randomUUID()}`); let writeError;
  try { fs.writeFileSync(probe, 'Test mount must reject writes', { flag:'wx' }); }
  catch (error) { writeError = error.code; }
  finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }
  assert.equal(writeError, 'EROFS', 'Mounted image did not reject a write as a read-only filesystem');
  const apps = fs.readdirSync(mountpoint).filter(name => name.endsWith('.app') && fs.statSync(path.join(mountpoint, name)).isDirectory());
  assert.equal(apps.length, 1, 'DMG must contain exactly one top-level app');
  return { app:path.join(mountpoint, apps[0]), verification:{ image:path.resolve(image), sha256:sha256(image), readOnly:true, writeProbeError:writeError, device:entity['dev-entry'], mountpoint } };
}
function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temporary = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n'); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function validateStandalone(options) {
  const report = { schemaVersion:'standalone-validation-1', startedAt:new Date().toISOString(), status:'running', checks:{},
    constraints:{ actualCapture:false, permissionRequests:false, testDataOnly:true, PATH:systemPath }, source:options.dmg ? { dmg:options.dmg } : { app:options.app } };
  let temporary, mountpoint, attachAttempted = false, retained = false;
  try {
    assert.equal(process.platform, 'darwin', 'Standalone app validation requires macOS');
    report.host = { macOS:runTool('/usr/bin/sw_vers', ['-productVersion']).stdout.trim(), architecture:process.arch };
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-standalone-validation-')));
    const movedDirectory = path.join(temporary, 'Relocated apps with spaces'), emptyCwd = path.join(temporary, 'Empty working directory'), data = path.join(temporary, 'Isolated meeting data'), processTemp = path.join(temporary, 'Process temporary files');
    for (const directory of [movedDirectory, emptyCwd, data, processTemp]) fs.mkdirSync(directory);
    let sourceApp = options.app;
    if (options.dmg) {
      mountpoint = path.join(temporary, 'Read only image mount'); fs.mkdirSync(mountpoint); attachAttempted = true;
      const mounted = mountDmg(options.dmg, mountpoint); sourceApp = mounted.app; report.dmg = mounted.verification;
    }
    assert(fs.statSync(sourceApp).isDirectory() && sourceApp.endsWith('.app'), 'App bundle not found');
    const app = path.join(movedDirectory, 'MinuteShelf.app');
    runTool('/usr/bin/ditto', [sourceApp, app], { timeout:60000 });
    const before = bundleSnapshot(app), sourceSnapshot = bundleSnapshot(fs.realpathSync(sourceApp));
    assert.deepEqual(before, sourceSnapshot, 'Copied app differs from the source bundle');
    report.relocatedApp = app; report.checks.relocatedBundleBytesMatch = true;
    const inventory = validateBundleContents(app);
    report.checks.onlyApprovedPayloadFiles = true;
    const plist = readPlist(path.join(app, 'Contents', 'Info.plist'));
    validateBundlePlist(plist, inventory.information);
    report.checks.publicNameAndCompatibleIdentity = true;
    const binary = path.join(app, 'Contents', 'MacOS', plist.CFBundleExecutable), node = path.join(app, 'Contents', 'Helpers', 'node'), codex = path.join(app, 'Contents', 'Helpers', 'codex');
    for (const required of [binary, node, codex, path.join(app, 'Contents', 'Resources', 'runtime', 'tools', 'desktop-server.js')]) assert(fs.existsSync(required), `Missing bundled runtime: ${required}`);
    report.bundle = { identifier:plist.CFBundleIdentifier, version:plist.CFBundleShortVersionString, minimumMacOS:plist.LSMinimumSystemVersion, distribution:plist.MeetingArchiveDistribution || null };
    report.machO = inspectMachO(app); assert(report.machO.length >= 5, 'Expected app, Node, Codex, recorder and exporter Mach-O binaries');
    report.checks.allMachODependenciesBundledOrSystem = true;
    report.signing = signatureDetails(app, inventory.information); report.checks.signatureValid = true;
    const environment = cleanEnvironment(data, processTemp);
    report.node = JSON.parse(runTool(node, ['-e','console.log(JSON.stringify({version:process.version,execPath:process.execPath,architecture:process.arch}))'], { env:environment, cwd:emptyCwd }).stdout);
    assert.equal(fs.realpathSync(report.node.execPath), fs.realpathSync(node)); report.checks.bundledNodeExecutes = true;
    const codexLock = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'Licenses', 'Codex-runtime.lock.json'), 'utf8'));
    const codexHome = path.join(temporary, 'Empty Codex profile'), codexUserHome = path.join(temporary, 'Empty Codex user directory');
    for (const directory of [codexHome, codexUserHome]) fs.mkdirSync(directory, { mode:0o700 });
    const codexEnvironment = { PATH:systemPath, HOME:codexUserHome, CODEX_HOME:codexHome, TMPDIR:processTemp, LANG:'en_US.UTF-8' };
    report.codex = { version:validateCodexVersion(runTool(codex, ['--version'], { env:codexEnvironment, cwd:emptyCwd }).stdout, codexLock.version), executable:codex, isolatedProfile:codexHome };
    for (const [name, expected] of [['LICENSE', codexLock.licenseSha256], ['NOTICE', codexLock.noticeSha256]]) {
      assert.match(expected, /^[a-f0-9]{64}$/, `Invalid Codex ${name} digest`);
      assert.equal(sha256(path.join(app, 'Contents', 'Resources', 'Licenses', `Codex-${name}.txt`)), expected, `Bundled Codex ${name} does not match its lock`);
    }
    const schemaDirectory = path.join(temporary, 'Codex protocol schema');
    runTool(codex, ['-c','cli_auth_credentials_store="ephemeral"','app-server','generate-json-schema','--out',schemaDirectory], { env:codexEnvironment, cwd:emptyCwd });
    const schema = file => JSON.parse(fs.readFileSync(path.join(schemaDirectory, file), 'utf8'));
    report.codex.protocol = validateCodexProtocol(schema('ClientRequest.json'), schema('v1/InitializeParams.json'), schema('v2/GetAccountParams.json'), schema('v2/LoginAccountParams.json'));
    assert(!fs.existsSync(path.join(codexHome, 'auth.json')), 'Codex protocol inspection unexpectedly wrote an auth file');
    report.checks.bundledCodexExecutes = true; report.checks.codexManagedAuthSchemaVerified = true;
    const deniedDirectories = [...new Set([repository, fs.realpathSync(repository), '/opt/homebrew', '/usr/local'])];
    assert(deniedDirectories.every(directory => !isWithin(directory, app)), 'Relocated app must be outside denied development directories');
    const profile = runtimeProfile(deniedDirectories), blockedFile = fileURLToPath(import.meta.url);
    const probeProgram = `const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(blockedFile)});throw Error('Development source remained readable');}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;console.log(JSON.stringify({blocked:true,error:error.code}));}`;
    const sandboxProbe = JSON.parse(runTool('/usr/bin/sandbox-exec', ['-p',profile,node,'-e',probeProgram], { env:environment, cwd:emptyCwd }).stdout);
    assert.equal(sandboxProbe.blocked, true);
    report.runtimeIsolation = { deniedDirectories, actualReadDenied:sandboxProbe, emptyWorkingDirectory:emptyCwd };
    const marker = path.join(temporary, 'Unexpected node preload marker'), poison = path.join(temporary, 'Unexpected node preload.cjs');
    fs.writeFileSync(poison, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'NODE_OPTIONS was inherited');\n`);
    const launched = await runApp('/usr/bin/sandbox-exec', ['-p',profile,binary,'--smoke-test'], { cwd:emptyCwd,
      env:{ ...environment, NODE_OPTIONS:`--require ${JSON.stringify(poison)}`, NODE_PATH:path.join(temporary, 'Unexpected node modules') }, timeoutMs:options.timeoutMs });
    report.smoke = parseSmokeResult(launched.stdout); validateSmokeResult(report.smoke, node, report.node.version);
    assert.equal(fs.existsSync(marker), false, 'App passed poisoned NODE_OPTIONS to its backend');
    report.checks.poisonedNodeOptionsBlocked = true; report.checks.startsWithoutDeveloperDirectoryOrHomebrew = true;
    report.checks.realAppSmokePassed = true; report.checks.nativeShellSmokePassed = true;
    report.smokeDiagnostics = launched.stderr.slice(-4000);
    const meetingsDirectory = path.join(data, 'meetings');
    assert(fs.existsSync(meetingsDirectory), 'Backend did not create the isolated test archive');
    assert.deepEqual(fs.readdirSync(meetingsDirectory), [], 'Smoke test unexpectedly created a meeting');
    report.checks.noMeetingsCreated = true;
    assert.deepEqual(bundleSnapshot(app), before, 'Launching modified the app bundle');
    report.checks.bundleUnmodifiedAfterLaunch = true; report.bundleFileCount = before.length;
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; }
  finally {
    if (attachAttempted) {
      try {
        if (mountedAt(mountpoint)) {
          let result = runTool('/usr/bin/hdiutil', ['detach',mountpoint], { allowFailure:true });
          if (result.status !== 0) result = runTool('/usr/bin/hdiutil', ['detach','-force',mountpoint], { allowFailure:true });
          assert.equal(result.status, 0, 'Could not detach the test disk image');
          assert.equal(mountedAt(mountpoint), undefined, 'Test disk image is still mounted');
        }
        report.checks.testDmgDetached = true;
      } catch (error) { retained = true; report.cleanupError = error.message; report.status = 'failed'; }
    }
    if (temporary && !retained) {
      try { fs.rmSync(temporary, { recursive:true, force:true }); report.checks.temporaryFilesRemoved = true; }
      catch (error) { report.cleanupError = error.message; report.status = 'failed'; retained = true; }
    }
    if (retained) report.retainedTestDirectory = temporary;
    report.finishedAt = new Date().toISOString(); writeReport(options.report, report);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node tools/test-standalone.mjs [--app /path/MinuteShelf.app | --dmg /path/image.dmg] [--report /path/report.json] [--timeout-ms 90000]\nRequires macOS GUI access and validation tools. Uses only isolated temporary data; never captures media or requests capture permission.');
    else {
      const report = await validateStandalone(options);
      console.log(JSON.stringify({ status:report.status, report:options.report, checks:report.checks, signing:report.signing, error:report.error, cleanupError:report.cleanupError }, null, 2));
      if (report.status !== 'passed') process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
