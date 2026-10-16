// Package the verified self-contained app without Finder automation, uploads,
// notarization, or changes to the user's installed application/recordings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appIdentity, binaryFiles, validateBundleContents, validateBundlePlist, validateAppSignature } from './bundle-policy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, '.build'), dist = path.join(root, 'dist');
const app = path.join(build, appIdentity.bundleName);
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
function signatureOutput(target, arguments_) {
  const result = spawnSync('/usr/bin/codesign', ['--display', ...arguments_, target], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not inspect the signed application');
  return `${result.stdout}\n${result.stderr}`;
}
function checkSignature(target, information) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  return validateAppSignature(signatureOutput(target, ['--verbose=4']), signatureOutput(target, ['-r-']), information);
}
if (process.platform !== 'darwin') throw new Error('DMG packaging requires macOS.');
assertNoBuild();
const infoFile = path.join(app, 'Contents', 'Resources', 'build-info.json');
if (!fs.existsSync(infoFile)) throw new Error('Build the self-contained app first with npm run build:app.');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const inventory = validateBundleContents(app, { expectedVersion: packageVersion });
const information = inventory.information;
const { version } = information;
validateBundlePlist(JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], true)), information);
for (const relative of binaryFiles) {
  if (!fs.lstatSync(path.join(app, relative)).isFile()) throw new Error(`Missing bundled runtime: ${relative}`);
  run('/usr/bin/codesign', ['--verify', '--strict', path.join(app, relative)]);
}
const sourceSignature = checkSignature(app, information);
const sourceHashes = await Promise.all(inventory.files.map(async file => [file, await sha256(path.join(app, file))]));
fs.mkdirSync(dist, { recursive: true });
const lockPath = path.join(build, 'app-package.lock');
let lock;
try { lock = fs.openSync(lockPath, 'wx', 0o600); }
catch (error) { if (error.code === 'EEXIST') throw new Error('Another package job may be running. Check .build/app-package.lock before retrying.'); throw error; }
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
const staging = fs.mkdtempSync(path.join(build, 'package-staging-'));
const basename = `MinuteShelf-${version}-macOS-arm64`;
const imageRoot = path.join(staging, 'image');
const packageApp = path.join(imageRoot, appIdentity.bundleName);
try {
  fs.mkdirSync(imageRoot);
  run('/usr/bin/ditto', [app, packageApp]);
  assertNoBuild();
  // A complete build can finish between our first metadata read and ditto.
  // A valid signature alone does not establish that it is the same build.
  const copiedInventory = validateBundleContents(packageApp, { expectedVersion: version });
  validateBundlePlist(JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(packageApp, 'Contents', 'Info.plist')], true)), information);
  const copiedHashes = await Promise.all(copiedInventory.files.map(async file => [file, await sha256(path.join(packageApp, file))]));
  if (JSON.stringify(copiedInventory.information) !== JSON.stringify(information) || JSON.stringify(copiedHashes) !== JSON.stringify(sourceHashes)) {
    throw new Error('The app changed while packaging. Retry after the build finishes; no release files were replaced.');
  }
  if (checkSignature(packageApp, information).cdhash !== sourceSignature.cdhash) throw new Error('The packaged signature differs from the source app');
  fs.symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
  const signatureNote = information.signing.kind === 'adhoc'
    ? 'This preview is ad-hoc signed. It is not Developer ID signed and has not been notarized by Apple.'
    : 'This build is signed with a Developer ID Application certificate. Apple notarization has not been submitted.';
  const instructions = `MINUTESHELF ${version}

REQUIREMENTS
Apple Silicon Mac (M-series), macOS 15 or later.
Node.js and Codex are included. No Homebrew, Node, Codex CLI, or terminal is required to launch the app.

INSTALL
1. Open the DMG and drag MinuteShelf into Applications.
2. Eject the disk image, then open MinuteShelf from Applications.
   For the ZIP, unzip it and move MinuteShelf.app into Applications.
3. In Settings > General, request Screen & System Audio access.
   Grant Microphone access if you want microphone recording.
   Accessibility permission is not required.

UPGRADING FROM MEETING ARCHIVE
Stop and save recordings, then quit Meeting Archive normally.
Move the old Meeting Archive.app out of Applications before installing MinuteShelf.app.
Only move the application bundle: keep ~/Library/Application Support/Meeting Archive.
The new filename does not automatically replace the old app. Keeping both apps installed
with the same bundle identifier can confuse macOS launch and permission attribution.
The bundle identifier, archive path, preferences and credential scopes are preserved.

SIGNING AND PERMISSIONS
${signatureNote}
If macOS blocks this copy, review the warning and use System Settings > Privacy & Security > Open Anyway only if you trust this release. Do not disable Gatekeeper.
Ad-hoc signatures change between builds. An existing privacy toggle can remain enabled
while the updated app has no working grant. Install the final copy in Applications first,
then use Settings > General > Request Access and check the permission status in the app.
If macOS requests a restart, quit and reopen this installed copy before checking again.
If it still says Not allowed, consult the release installation guide for a targeted reset.
The installer never resets privacy grants, changes other apps' permissions, or modifies
the signed app after installation. No automatic grant or permission continuity is promised.

CONNECT AND ANALYZE
Open Settings > Analysis > Connect Codex, then finish ChatGPT sign-in in your browser.
Use Check Connection to check the saved sign-in. Disconnect removes this app's sign-in.
Credentials use this app's macOS Keychain scope. Connecting does not upload meeting content.
After an update, a saved API key or Claude Code token may need renewed Keychain consent.
Use Authorize Access in that provider's settings, confirm the requesting app is MinuteShelf,
then check for Background access verified. Enter passwords only in the macOS dialog.
Choose providers and permitted sources in Settings > Analysis, then start analysis from a saved meeting.
Local MLX transcription requires Python 3.11+ and explicit runtime/model installation.
Save the speech model, then use Settings > Analysis > Speech recognition > Install / Update Local STT.
Claude Code requires its official native runtime. Saving preferences does not start analysis or uploads.

YOUR RECORDINGS
Saved by default in ~/Library/Application Support/Meeting Archive (legacy path retained).
Each meeting keeps recordings, context documents, notes, and exports together.
Closing the window leaves recording running in the menu bar. Quitting asks before stopping
an active recording and waits for it to save. Microphone recording is separate from mute in your meeting app.

FUTURE UPDATES
Stop and save recordings, quit MinuteShelf, then replace MinuteShelf.app in Applications.
Replacing the app does not delete your recordings. Check capture permission after an update.
`;
  fs.writeFileSync(path.join(imageRoot, 'INSTALL.txt'), instructions);
  const dmg = path.join(staging, `${basename}.dmg`), zip = path.join(staging, `${basename}.zip`);
  run('/usr/bin/hdiutil', ['create', '-volname', 'MinuteShelf', '-srcfolder', imageRoot, '-format', 'UDZO', '-fs', 'HFS+', dmg]);
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
