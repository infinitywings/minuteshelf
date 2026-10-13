import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Defaults to synthetic protocol/lifecycle checks only. --runtime PATH is an
// explicit opt-in to initialize a real app-server in a new isolated namespace,
// obtain (without opening) its login URL, and immediately cancel that login.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let runtime;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--runtime') throw new Error('Usage: node tools/test-codex-connection.mjs [--runtime /path/to/codex]');
  runtime = path.resolve(args[1]);
  if (!fs.statSync(runtime).isFile()) throw new Error('The runtime path must name an executable file.');
  fs.accessSync(runtime, fs.constants.X_OK);
}
function run(command, values) {
  const result = spawnSync(command, values, { cwd: root, stdio: 'inherit', timeout: 90000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.signal || result.status}).`);
}
const build = path.join(root, '.build');
fs.mkdirSync(build, { recursive: true });
const binary = path.join(build, 'codex-connection-tests');
const compile = ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macos15.0',
  '-module-cache-path', path.join(build, 'module-cache')];
const overlay = path.join(build, 'swift-vfs.json');
if (fs.existsSync(overlay)) compile.push('-vfsoverlay', overlay);
compile.push(path.join(root, 'native', 'CodexConnection.swift'), path.join(root, 'test', 'CodexConnectionTests.swift'), '-o', binary);
run('/usr/bin/xcrun', compile);
run(binary, []);
if (runtime) run(binary, ['--probe-runtime', runtime]);
