import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--settings-ui')) {
  throw new Error('Usage: node tools/test-shell.mjs [--settings-ui]');
}
const build = path.join(root, '.build');
fs.mkdirSync(build, { recursive: true });
const binary = path.join(build, 'meeting-shell-tests');
const compile = ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macos15.0',
  '-module-cache-path', path.join(build, 'module-cache')];
const overlay = path.join(build, 'swift-vfs.json');
if (fs.existsSync(overlay)) compile.push('-vfsoverlay', overlay);
for (const file of ['MeetingArchiveShell', 'AnalysisPreferences', 'AnalysisCredentials', 'CodexConnection',
  'ModelCatalog', 'ClaudeModelDiscovery', 'ClaudePublishedModels']) compile.push(path.join(root, 'native', file + '.swift'));
compile.push(path.join(root, 'test', 'MeetingArchiveShellTests.swift'), '-o', binary);
for (const [command, values] of [['/usr/bin/xcrun', compile], [binary, args]]) {
  const result = spawnSync(command, values, { cwd: root, stdio: 'inherit', timeout: 90000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.signal || result.status}).`);
}
