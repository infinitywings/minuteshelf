// An explicit shipping boundary, shared by build, package and relocated-app
// validation. Never package a whole source/build/data directory recursively.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export const appIdentity = Object.freeze({
  name: 'MinuteShelf', bundleName: 'MinuteShelf.app',
  identifier: 'local.meetingarchive.app', executable: 'MeetingArchive',
  // These identifiers deliberately survive the public rename. Changing them
  // would orphan existing recordings, preferences and credential scopes.
  dataDirectoryName: 'Meeting Archive'
});

export const runtimeModules = Object.freeze([
  'server/analysis-manager.js', 'server/analysis-media.js',
  'server/analysis-providers.js', 'server/analysis-settings.js',
  'server/archive-config.js', 'server/archive-session.js',
  'server/archive-store.js', 'server/archive-timeline.js',
  'server/claude-analysis.js', 'server/codex-analysis.js', 'server/index.js',
  'server/media-export.js', 'server/meeting-artifacts.js',
  'server/meeting-lifecycle.js', 'server/project-store.js', 'server/rka-context.js',
  'tools/desktop-server.js'
]);
export const webFiles = Object.freeze([
  'web/recorder.html', 'web/recorder.js', 'web/recorder.css', 'web/analysis.js',
  'web/brand/meeting-archive-mark.png'
]);
export const binaryFiles = Object.freeze([
  'Contents/MacOS/MeetingArchive', 'Contents/Helpers/node',
  'Contents/Helpers/codex', 'Contents/Helpers/analysis-credentials',
  ...['archivecap', 'archive-export', 'analysis-media'].map(name => `Contents/Resources/runtime/.build/${name}`)
]);

export function shippedFiles({ signed = true } = {}) {
  return [
    'Contents/Info.plist', 'Contents/Resources/LICENSE',
    'Contents/Resources/MeetingArchive.icns', 'Contents/Resources/build-info.json',
    'Contents/Resources/DISTRIBUTION.txt',
    ...['Node-LICENSE.txt', 'Node-runtime.lock.json', 'Codex-LICENSE.txt', 'Codex-NOTICE.txt', 'Codex-runtime.lock.json']
      .map(name => `Contents/Resources/Licenses/${name}`),
    ...binaryFiles,
    ...[...runtimeModules, ...webFiles, 'tools/local-asr.py'].map(name => `Contents/Resources/runtime/${name}`),
    ...(signed ? ['Contents/_CodeSignature/CodeResources'] : [])
  ].sort();
}

export function validateBuildInformation(information, expectedVersion) {
  assert.equal(information.applicationName, appIdentity.name, 'Build metadata must use the public application name');
  assert.equal(information.bundleIdentifier, appIdentity.identifier, 'Bundle identity must preserve existing permissions and preferences');
  assert.match(information.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, 'Invalid release version');
  if (expectedVersion !== undefined) assert.equal(information.version, expectedVersion, 'Bundle and package.json versions differ; rebuild before packaging');
  assert.equal(information.architecture, 'arm64');
  assert.equal(information.minimumMacOS, '15.0');
  assert(['adhoc', 'developer-id'].includes(information.signing?.kind), 'Unknown signing state');
  assert.equal(information.signing.notarization, 'not-submitted', 'This packager does not submit or claim notarization');
  assert.deepEqual([...information.runtimeModules].sort(), [...runtimeModules].sort(), 'Runtime modules differ from the explicit shipping policy');
  return information;
}

export function validateBundlePlist(plist, information) {
  assert.equal(plist.CFBundleIdentifier, appIdentity.identifier, 'Do not change the existing bundle identity during a display-name update');
  assert.equal(plist.CFBundleExecutable, appIdentity.executable, 'The internal executable keeps its compatible name');
  assert.equal(plist.CFBundleName, appIdentity.name);
  assert.equal(plist.CFBundleDisplayName, appIdentity.name);
  assert.equal(plist.CFBundleShortVersionString, information.version);
  assert.equal(plist.CFBundleVersion, information.version.split('-')[0]);
  assert.equal(plist.LSMinimumSystemVersion, information.minimumMacOS);
  assert.equal(plist.MeetingArchiveDistribution, information.signing.kind);
}

export function validateAppSignature(display, requirements, information) {
  assert.match(display, /^Identifier=local\.meetingarchive\.app$/m, 'Signature must use the existing bundle identity');
  const cdhash = /^CDHash=([a-f0-9]{40})$/m.exec(display)?.[1];
  assert(cdhash, 'The final app signature must report a CDHash');
  if (information.signing.kind === 'adhoc') {
    assert.match(display, /^Signature=adhoc$/m, 'Build metadata and actual signing type differ');
    // Ad-hoc grants are tied to this build. Do not replace the requirement with
    // a broad identifier-only rule to try to keep TCC/Keychain permissions.
    const designated = /^#?\s*designated => (.+)$/m.exec(requirements)?.[1]?.trim();
    assert.equal(designated, `cdhash H"${cdhash}"`, 'Ad-hoc signing must keep its build-specific designated requirement');
  } else {
    assert.match(display, /^Authority=Developer ID Application:/m, 'Developer ID metadata requires a real Developer ID signature');
  }
  return { cdhash, kind: information.signing.kind };
}

export function validateBundleContents(bundle, { signed = true, expectedVersion } = {}) {
  const expected = new Set(shippedFiles({ signed })), found = [];
  assert(fs.lstatSync(bundle).isDirectory(), 'App must be a real directory, not a symlink');
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.relative(bundle, absolute).split(path.sep).join('/');
      assert(!entry.isSymbolicLink(), `Do not ship symbolic links inside the app: ${relative}`);
      if (entry.isDirectory()) {
        assert([...expected].some(file => file.startsWith(`${relative}/`)), `Unexpected bundle directory: ${relative}`);
        visit(absolute);
      } else {
        assert(entry.isFile() && expected.has(relative), `Unexpected bundle file: ${relative}`);
        found.push(relative);
      }
    }
  };
  visit(bundle);
  assert.deepEqual(found.sort(), [...expected].sort(), 'Required shipping files are missing');
  const information = validateBuildInformation(JSON.parse(fs.readFileSync(path.join(bundle, 'Contents/Resources/build-info.json'), 'utf8')), expectedVersion);
  return { files: found, information };
}
