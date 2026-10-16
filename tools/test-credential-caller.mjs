// Exercises the production trust gate with signed synthetic processes only.
// No credential is saved/read: the payload deliberately fails request
// validation after an accepted caller, before any Keychain item operation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--app')) throw new Error('Usage: node tools/test-credential-caller.mjs [--app /path/MinuteShelf.app]');
const releaseApp = args.length ? path.resolve(args[1]) : null;
const build = path.join(root, '.build'); fs.mkdirSync(build, { recursive: true });
const temporary = fs.mkdtempSync(path.join(build, 'credential-caller-'));
let checks = 0;
function run(command, values, options = {}) {
  const result = spawnSync(command, values, { encoding: 'utf8', timeout: 90000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(command)} failed: ${result.stderr}`);
  return result.stdout;
}
function expectError(command, values, code, options = {}) {
  const result = spawnSync(command, values, {
    encoding: 'utf8', timeout: 10000, input: request,
    env: { PATH: '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary }, ...options
  });
  if (result.error) throw result.error;
  const response = JSON.parse(result.stdout);
  assert.deepEqual(response, { error: { code } });
  assert.equal(result.status, options.host ? 0 : 1);
  checks++;
}
const request = JSON.stringify({ operation: 'reject-before-keychain', dataDirectory: temporary,
  task: 'vision', provider: 'claude-agent-sdk', endpoint: '', authentication: 'claude-code-oauth-token' });
try {
  const app = path.join(temporary, 'Caller Fixture.app');
  const main = path.join(app, 'Contents/MacOS/MeetingArchive');
  const node = path.join(app, 'Contents/Helpers/node');
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.minuteshelf.credential-caller-test</string><key>CFBundleExecutable</key><string>MeetingArchive</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const compile = ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macos15.0',
    '-module-cache-path', path.join(build, 'module-cache')];
  const overlay = path.join(build, 'swift-vfs.json');
  if (fs.existsSync(overlay)) compile.push('-vfsoverlay', overlay);
  compile.push(path.join(root, 'native/AnalysisCredentials.swift'), path.join(root, 'test/AnalysisCredentialCallerTests.swift'), '-o', main);
  run('/usr/bin/xcrun', compile);
  fs.copyFileSync(path.join(build, 'vendor/node/bin/node'), node); fs.chmodSync(node, 0o755);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', path.join(root, 'native/Node.entitlements'), node]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);

  expectError(main, ['--direct'], 'credential_scope', { host: true });
  expectError(main, ['--node'], 'credential_scope', { host: true });
  expectError(main, ['--credential-helper'], 'credential_helper_trust');

  // A copy of this parent process's signed executable supplies the fake trust
  // anchor used by the original argv[0] bug. It is never executed or authorized.
  const forgedMain = path.join(temporary, 'Forged.app/Contents/MacOS/MeetingArchive');
  fs.mkdirSync(path.dirname(forgedMain), { recursive: true });
  fs.copyFileSync(process.execPath, forgedMain);
  run('/usr/bin/codesign', ['--verify', '--strict', forgedMain]);
  expectError(main, ['--credential-helper'], 'credential_helper_trust', { argv0: forgedMain });
  expectError(main, ['--node-spoof', forgedMain], 'credential_helper_trust', { host: true });
  expectError(main, ['--credential-helper'], 'credential_helper_trust', { argv0: 'MeetingArchive' });
  const script = "const r=require('node:child_process').spawnSync(process.argv[1],['--credential-helper'],{input:require('node:fs').readFileSync(0),env:{PATH:'/usr/bin:/bin'},timeout:5000});if(r.error)process.exit(2);process.stdout.write(r.stdout);";
  expectError(node, ['-e', script, main], 'credential_helper_trust', { host: true });

  if (releaseApp) {
    const reader = path.join(releaseApp, 'Contents/MacOS/MeetingArchive');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', releaseApp]);
    expectError(reader, ['--credential-helper'], 'credential_helper_trust');
    expectError(reader, ['--credential-helper'], 'credential_helper_trust', { argv0: forgedMain });
  }
  console.log(`Credential caller: ${checks} checks passed; signed app and app-owned Node accepted, unrelated/spoofed callers rejected; no Keychain item access.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
