// Pure validation tests. These never launch the app, mount an image, or request
// permissions, and are intentionally separate from the existing application suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArguments, isWithin, parseLibraries, parseRpaths, resolveLibrary, parseSmokeResult, validateSmokeResult, validateCodexVersion, validateCodexProtocol } from '../tools/test-standalone.mjs';
import { appIdentity, runtimeModules, shippedFiles, validateBundleContents, validateBuildInformation, validateBundlePlist, validateAppSignature } from '../tools/bundle-policy.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-standalone-unit-')));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const bundle = path.join(root, 'Relocated apps with spaces', 'MinuteShelf.app');
  const binary = path.join(bundle, 'Contents', 'MacOS', 'MeetingArchive');
  const framework = path.join(bundle, 'Contents', 'Frameworks', 'libFixture.dylib');
  for (const file of [binary, framework]) { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, 'Only a path-resolution fixture'); }
  return { root, bundle, binary, framework };
}

test('standalone CLI supports paths with spaces and explicit output without ambiguous sources', () => {
  const defaults = parseArguments([], '/project');
  assert.equal(defaults.app, '/project/.build/MinuteShelf.app');
  assert.equal(defaults.report, '/project/.build/reports/standalone-validation.json');
  const supplied = parseArguments(['--dmg','/tmp/MinuteShelf.dmg','--report','/tmp/Review report.json','--timeout-ms','45000'], '/project');
  assert.equal(supplied.dmg, '/tmp/MinuteShelf.dmg'); assert.equal(supplied.report, '/tmp/Review report.json'); assert.equal(supplied.timeoutMs, 45000);
  assert.throws(() => parseArguments(['--app','/app','--dmg','/image']), /not both/);
  assert.throws(() => parseArguments(['--report']), /incomplete/);
  assert.throws(() => parseArguments(['--timeout-ms','Infinity']), /Timeout/);
  assert.throws(() => parseArguments(['--skip-dependencies']), /Unknown/);
});

test('Mach-O dependency parsing supports fat slices and spaces without treating headers as libraries', () => {
  const output = `/tmp/Relocated apps with spaces/MinuteShelf.app/Contents/MacOS/MeetingArchive (architecture arm64):
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
\t@rpath/Fixture Framework.framework/Fixture Framework (compatibility version 1.0.0, current version 1.0.0)
/tmp/Relocated apps with spaces/MinuteShelf.app/Contents/MacOS/MeetingArchive (architecture x86_64):
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
`;
  assert.deepEqual(parseLibraries(output), ['/usr/lib/libSystem.B.dylib','@rpath/Fixture Framework.framework/Fixture Framework']);
  assert.deepEqual(parseLibraries('/tmp/app:\n'), []);
});

test('runpath parsing only reads LC_RPATH commands', () => {
  assert.deepEqual(parseRpaths(`Load command 1
          cmd LC_RPATH
      cmdsize 40
         path @executable_path/../Frameworks (offset 12)
Load command 2
          cmd LC_LOAD_DYLIB
      cmdsize 52
         name /usr/lib/libSystem.B.dylib (offset 24)
Load command 3
          cmd LC_RPATH
      cmdsize 32
         path /usr/lib/swift (offset 12)
`), ['@executable_path/../Frameworks','/usr/lib/swift']);
});

test('system libraries in the dyld cache and real bundled libraries resolve without Homebrew', t => {
  const context = fixture(t);
  const system = resolveLibrary('/usr/lib/libSystem.B.dylib', context); assert.equal(system.scope, 'system');
  const loader = resolveLibrary('@loader_path/../Frameworks/libFixture.dylib', context); assert.equal(loader.resolved, context.framework); assert.equal(loader.scope, 'bundle');
  const rpath = resolveLibrary('@rpath/libFixture.dylib', { ...context, rpaths:['@executable_path/../Frameworks'] }); assert.equal(rpath.resolved, context.framework);
  const swift = resolveLibrary('@rpath/libswiftCore.dylib', { ...context, rpaths:['/usr/lib/swift'] }); assert.equal(swift.scope, 'system');
});

test('dependencies cannot escape through traversal, external symlinks, missing files or prefix lookalikes', t => {
  const context = fixture(t), external = path.join(context.root, 'external.dylib'); fs.writeFileSync(external, 'external fixture');
  fs.symlinkSync(external, path.join(context.bundle, 'Contents', 'Frameworks', 'escaped.dylib'));
  for (const name of ['/opt/homebrew/lib/libnode.dylib', '/usr/local/lib/libuv.dylib', '/usr/lib/../../opt/homebrew/lib/escape.dylib', '@loader_path/../Frameworks/escaped.dylib', '@rpath/missing.dylib', 'libRelative.dylib']) {
    assert.throws(() => resolveLibrary(name, { ...context, rpaths:['@executable_path/../Frameworks'] }), /outside the bundle or unresolved/);
  }
  assert.equal(isWithin(context.bundle, context.bundle + '-other/file'), false);
  assert.equal(isWithin(context.bundle, path.join(context.bundle, '..', 'outside')), false);
});

test('smoke validation requires actual relocated Node identity, clean quit and no capture authorization', t => {
  const { root, bundle } = fixture(t), node = path.join(bundle, 'Contents', 'Helpers', 'node');
  fs.mkdirSync(path.dirname(node)); fs.writeFileSync(node, 'Node identity fixture');
  const other = path.join(root, 'external-node'); fs.writeFileSync(other, 'Not the bundled node');
  const smoke = { launchReady:true, desktopBridge:true, quitEditorLock:true, cancelRestoresFocus:true, safeQuit:true,
    nativeShell:{ sidebar:true, toolbar:true, nativeSearch:true, webSidebarHidden:true, stateSnapshot:true, actionRoundTrip:true,
      quitControlsLocked:true, cancelRestoresNativeControls:true, nativeLibrary:true, nativeSettings:true },
    activeMeetings:0, requestedPermissions:false, nodeVersion:'v24.21.0', nodeExecPath:node };
  validateSmokeResult(smoke, node, 'v24.21.0');
  assert.throws(() => validateSmokeResult({ ...smoke, nodeExecPath:other }, node, 'v24.21.0'), /relocated bundled Node/);
  assert.throws(() => validateSmokeResult({ ...smoke, nodeVersion:'v22.0.0' }, node, 'v24.21.0'), /different Node version/);
  assert.throws(() => validateSmokeResult({ ...smoke, requestedPermissions:true }, node, 'v24.21.0'), /must not request/);
  assert.throws(() => validateSmokeResult({ ...smoke, activeMeetings:1 }, node, 'v24.21.0'), /no active recordings/);
  assert.throws(() => validateSmokeResult({ ...smoke, safeQuit:false }, node, 'v24.21.0'), /safeQuit/);
  assert.throws(() => validateSmokeResult({ ...smoke, nativeShell:undefined }, node, 'v24.21.0'), /nativeShell checks/);
  for (const check of ['sidebar','toolbar','nativeSearch','webSidebarHidden','stateSnapshot','actionRoundTrip','quitControlsLocked','cancelRestoresNativeControls','nativeLibrary','nativeSettings']) {
    assert.throws(() => validateSmokeResult({ ...smoke, nativeShell:{ ...smoke.nativeShell, [check]:false } }, node, 'v24.21.0'), new RegExp(check));
    const missing = { ...smoke, nativeShell:{ ...smoke.nativeShell } }; delete missing.nativeShell[check];
    assert.throws(() => validateSmokeResult(missing, node, 'v24.21.0'), new RegExp(check));
  }
});

test('smoke parser requires the structured completion result instead of arbitrary stdout', () => {
  const result = { launchReady:true, safeQuit:true };
  assert.deepEqual(parseSmokeResult(`diagnostic\n${JSON.stringify(result)}\nother output\n`), result);
  assert.throws(() => parseSmokeResult('{"ready":true}\n'), /did not return/);
});

test('bundled Codex validation requires the pinned runtime and managed login schema without credentials', () => {
  assert.equal(validateCodexVersion('codex-cli 0.160.0\n', '0.160.0'), '0.160.0');
  assert.throws(() => validateCodexVersion('codex-cli 0.16.0\n', '0.160.0'), /does not match/);
  assert.throws(() => validateCodexVersion('codex-cli 0.160.0-alpha.1', '0.160.0-alpha.1'), /stable version/);
  const methods = ['initialize','account/read','account/login/start','account/login/cancel','account/logout'];
  const client = { oneOf:methods.map(method => ({ properties:{ method:{ enum:[method] } } })) };
  const initialize = { required:['clientInfo'] }, account = { properties:{ refreshToken:{ type:'boolean' } } };
  const login = { oneOf:[{ required:['type'], properties:{ type:{ enum:['chatgpt'] } } }] };
  const result = validateCodexProtocol(client, initialize, account, login);
  assert.equal(result.managedChatgptLogin, true); assert.equal(result.loginStarted, false); assert.equal(result.accountRead, false);
  assert.throws(() => validateCodexProtocol({ oneOf:client.oneOf.slice(0, -1) }, initialize, account, login), /account\/logout/);
  assert.throws(() => validateCodexProtocol(client, initialize, {}, login), /refreshToken/);
  assert.throws(() => validateCodexProtocol(client, initialize, account, { oneOf:[] }), /managed ChatGPT/);
  assert.throws(() => validateCodexProtocol(client, initialize, account, { oneOf:[{ ...login.oneOf[0], required:['type','accessToken'] }] }), /client-supplied credentials/);
});

function shippingFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minuteshelf-shipping-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, appIdentity.bundleName);
  const information = { applicationName: 'MinuteShelf', bundleIdentifier: 'local.meetingarchive.app',
    version: '0.1.10', architecture: 'arm64', minimumMacOS: '15.0',
    signing: { kind: 'adhoc', notarization: 'not-submitted' }, runtimeModules: [...runtimeModules] };
  for (const name of shippedFiles()) {
    const file = path.join(bundle, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Synthetic bundle policy fixture');
  }
  fs.writeFileSync(path.join(bundle, 'Contents/Resources/build-info.json'), JSON.stringify(information));
  return { root, bundle, information };
}

test('release inventory permits only the complete explicitly shipped payload', t => {
  const { bundle } = shippingFixture(t);
  assert.deepEqual(validateBundleContents(bundle, { expectedVersion: '0.1.10' }).files, shippedFiles());
  assert.throws(() => validateBundleContents(bundle, { expectedVersion: '0.1.9' }), /versions differ/);
  fs.unlinkSync(path.join(bundle, 'Contents/Helpers/codex'));
  assert.throws(() => validateBundleContents(bundle), /Required shipping files/);
});

test('release inventory rejects personal data, credentials and local debug artifacts anywhere in the bundle', t => {
  const { bundle } = shippingFixture(t);
  for (const name of [
    'Contents/Resources/runtime/auth.json',
    'Contents/Resources/runtime/.env',
    'Contents/Resources/runtime/.build/capture-diagnostics.json',
    'Contents/Resources/runtime/web/brand/private-meeting.png',
    'Contents/Resources/Licenses/Node-runtime.json'
  ]) {
    const file = path.join(bundle, name); fs.writeFileSync(file, 'Synthetic private-file marker');
    assert.throws(() => validateBundleContents(bundle), /Unexpected bundle file/);
    fs.unlinkSync(file);
  }
  const privateDirectory = path.join(bundle, 'Contents/Resources/runtime/data');
  fs.mkdirSync(privateDirectory);
  assert.throws(() => validateBundleContents(bundle), /Unexpected bundle directory/);
  fs.rmdirSync(privateDirectory);
  const script = path.join(bundle, 'Contents/Resources/runtime/tools/local-asr.py');
  fs.unlinkSync(script);
  fs.symlinkSync(path.join(bundle, 'Contents/Resources/LICENSE'), script);
  assert.throws(() => validateBundleContents(bundle), /symbolic links/);
});

test('payload metadata cannot extend the shipping boundary or silently change persistent identity', t => {
  const { information } = shippingFixture(t);
  assert.throws(() => validateBuildInformation({ ...information, runtimeModules: [...runtimeModules, '../auth.json'] }), /shipping policy/);
  assert.throws(() => validateBuildInformation({ ...information, runtimeModules: [...runtimeModules, 'server/private-debug.js'] }), /shipping policy/);
  assert.throws(() => validateBuildInformation({ ...information, applicationName: 'Meeting Archive' }), /public application name/);
  assert.throws(() => validateBuildInformation({ ...information, bundleIdentifier: 'new.minuteshelf.app' }), /identity/);
  const plist = { CFBundleIdentifier: 'local.meetingarchive.app', CFBundleExecutable: 'MeetingArchive',
    CFBundleName: 'MinuteShelf', CFBundleDisplayName: 'MinuteShelf', CFBundleShortVersionString: '0.1.10',
    CFBundleVersion: '0.1.10', LSMinimumSystemVersion: '15.0', MeetingArchiveDistribution: 'adhoc' };
  validateBundlePlist(plist, information);
  assert.throws(() => validateBundlePlist({ ...plist, CFBundleExecutable: 'MinuteShelf' }, information), /compatible name/);
  assert.throws(() => validateBundlePlist({ ...plist, CFBundleIdentifier: 'new.minuteshelf.app' }, information), /bundle identity/);
});

test('ad-hoc releases keep build-specific identity instead of broadening a requirement to retain permissions', t => {
  const { information } = shippingFixture(t), cdhash = 'a'.repeat(40);
  const display = `Identifier=local.meetingarchive.app\nSignature=adhoc\nCDHash=${cdhash}\n`;
  const requirement = `# designated => cdhash H"${cdhash}"\n`;
  assert.equal(validateAppSignature(display, requirement, information).cdhash, cdhash);
  assert.throws(() => validateAppSignature(display, 'designated => identifier "local.meetingarchive.app"', information), /build-specific/);
  assert.throws(() => validateAppSignature(display, requirement.replace(cdhash, 'b'.repeat(40)), information), /build-specific/);
  assert.throws(() => validateAppSignature(display, `designated => cdhash H"${cdhash}" or identifier "local.meetingarchive.app"`, information), /build-specific/);
  assert.throws(() => validateAppSignature(display.replace('Signature=adhoc', 'Signature=other'), requirement, information), /signing type/);
});
