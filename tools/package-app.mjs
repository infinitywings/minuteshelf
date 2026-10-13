// Package the verified self-contained app without Finder automation, uploads,
// notarization, or changes to the user's installed application/recordings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, '.build'), dist = path.join(root, 'dist');
const app = path.join(build, 'Meeting Archive.app');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}${capture ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout?.trim() || '';
}
function assertNoBuild() {
  if (fs.existsSync(path.join(build, 'app-build.lock'))) throw new Error('An app build is in progress. Wait for it to finish before packaging.');
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
if (process.platform !== 'darwin') throw new Error('DMG packaging requires macOS.');
assertNoBuild();
const infoFile = path.join(app, 'Contents', 'Resources', 'build-info.json');
if (!fs.existsSync(infoFile)) throw new Error('Build the self-contained app first with npm run build:app.');
const information = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
const { version } = information;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || information.architecture !== 'arm64') throw new Error('Invalid app build metadata.');
if (!['adhoc', 'developer-id'].includes(information.signing?.kind) || information.signing.notarization !== 'not-submitted') {
  throw new Error('Unknown distribution state. This script packages builds that have not been notarized.');
}
const bundleVersion = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], true);
if (bundleVersion !== version) throw new Error('The app version and build metadata differ; rebuild before packaging.');
for (const relative of ['Contents/Helpers/node', 'Contents/Helpers/codex', 'Contents/Resources/runtime/.build/archivecap', 'Contents/Resources/runtime/.build/archive-export']) {
  if (!fs.lstatSync(path.join(app, relative)).isFile()) throw new Error(`Missing bundled runtime: ${relative}`);
  run('/usr/bin/codesign', ['--verify', '--strict', path.join(app, relative)]);
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
fs.mkdirSync(dist, { recursive: true });
const lockPath = path.join(build, 'app-package.lock');
let lock;
try { lock = fs.openSync(lockPath, 'wx', 0o600); }
catch (error) { if (error.code === 'EEXIST') throw new Error('Another package job may be running. Check .build/app-package.lock before retrying.'); throw error; }
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
const staging = fs.mkdtempSync(path.join(build, 'package-staging-'));
const basename = `Meeting-Archive-${version}-macOS-arm64`;
const imageRoot = path.join(staging, 'image');
const packageApp = path.join(imageRoot, 'Meeting Archive.app');
try {
  fs.mkdirSync(imageRoot);
  run('/usr/bin/ditto', [app, packageApp]);
  assertNoBuild();
  // A complete build can finish between our first metadata read and ditto.
  // A valid signature alone does not establish that it is the same build.
  const copiedInformation = JSON.parse(fs.readFileSync(path.join(packageApp, 'Contents', 'Resources', 'build-info.json'), 'utf8'));
  const copiedVersion = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(packageApp, 'Contents', 'Info.plist')], true);
  if (JSON.stringify(copiedInformation) !== JSON.stringify(information) || copiedVersion !== version) {
    throw new Error('The app changed while packaging. Retry after the build finishes; no release files were replaced.');
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', packageApp]);
  fs.symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
  const signatureNote = information.signing.kind === 'adhoc'
    ? 'This local build is ad-hoc signed. It is not Developer ID signed and has not been notarized by Apple.'
    : 'This build is signed with a Developer ID Application certificate. Apple notarization has not been submitted.';
  const instructions = `MEETING ARCHIVE ${version}\n\nREQUIREMENTS\nApple Silicon Mac (M-series), macOS 15 or later.\nNode.js and Codex are included. You do not need Homebrew, Node, Codex CLI, or a terminal to run the app.\n\nINSTALL\n1. Open the DMG and drag Meeting Archive into Applications.\n2. Eject the disk image, then open Meeting Archive from Applications.\n   If using the ZIP instead, unzip it and move Meeting Archive.app into Applications.\n3. When you create a meeting, grant the requested screen/system-audio permission.\n   Microphone permission is requested only if you enable microphone recording.\n   Accessibility permission is not required.\n\nCONNECT CODEX\nOpen Settings > Analysis > Connect Codex, then finish ChatGPT sign-in in your browser.\nUse Check Connection to read a saved sign-in. Disconnect removes this app's sign-in.\nCredentials use a separate macOS Keychain entry. Connecting does not upload meeting content.\nChoose providers and permitted sources in Settings > Analysis, then start analysis from a saved meeting. Local MLX transcription requires Python 3.11+ and an explicit model install. Claude Code requires its official native runtime. Saving preferences does not start analysis or upload content.\n\nSIGNING STATUS\n${signatureNote}\nIf macOS blocks this copy, review the warning and use System Settings > Privacy & Security > Open Anyway only if you trust this build. Do not disable Gatekeeper.\n\nYOUR RECORDINGS\nSaved by default in ~/Library/Application Support/Meeting Archive.\nEach meeting keeps its recordings, context documents, notes, and exports together.\nClosing the window leaves recording running in the menu bar. Quitting the app asks before stopping an active recording and waits for it to save.\nMicrophone recording is separate from the mute control in your meeting app.\n\nUPDATING\nStop and save recordings, quit Meeting Archive, then replace the app in Applications.\nReplacing the app does not delete your recordings. Permission prompts may recur after an ad-hoc rebuild.\n`;
  fs.writeFileSync(path.join(imageRoot, 'INSTALL.txt'), instructions);
  const dmg = path.join(staging, `${basename}.dmg`), zip = path.join(staging, `${basename}.zip`);
  run('/usr/bin/hdiutil', ['create', '-volname', 'Meeting Archive', '-srcfolder', imageRoot, '-format', 'UDZO', '-fs', 'HFS+', dmg]);
  run('/usr/bin/hdiutil', ['verify', dmg]);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', packageApp, zip]);
  const checksums = `${await sha256(dmg)}  ${path.basename(dmg)}\n${await sha256(zip)}  ${path.basename(zip)}\n`;
  const checksum = path.join(staging, `${basename}.sha256`);
  fs.writeFileSync(checksum, checksums);
  // Only these known generated release filenames are replaced, after all
  // packaging and validation has succeeded. Other dist files stay untouched.
  for (const file of [dmg, zip, checksum]) fs.renameSync(file, path.join(dist, path.basename(file)));
  fs.writeFileSync(path.join(dist, `${basename}-INSTALL.txt`), instructions);
  console.log(`DMG: ${path.join(dist, path.basename(dmg))}\nZIP: ${path.join(dist, path.basename(zip))}\nSHA-256: ${path.join(dist, path.basename(checksum))}\n${signatureNote}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.closeSync(lock); fs.unlinkSync(lockPath);
}
