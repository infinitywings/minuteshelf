import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Synthetic protocol and process-lifecycle checks by default. The explicit
// --runtime option probes only an official CLI's initialize metadata in an
// ephemeral home. It sends no prompt and reads no account credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--runtime')) {
  throw new Error('Usage: node tools/test-claude-models.mjs [--runtime /path/to/claude]');
}
function run(command, values) {
  const result = spawnSync(command, values, { cwd: root, stdio: 'inherit', timeout: 90000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.signal || result.status}).`);
}
const build = path.join(root, '.build');
fs.mkdirSync(build, { recursive: true });
const binary = path.join(build, 'claude-model-discovery-tests');
const compile = ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macos15.0',
  '-module-cache-path', path.join(build, 'module-cache')];
const overlay = path.join(build, 'swift-vfs.json');
if (fs.existsSync(overlay)) compile.push('-vfsoverlay', overlay);
compile.push(path.join(root, 'native', 'ClaudeModelDiscovery.swift'), path.join(root, 'test', 'ClaudeModelDiscoveryTests.swift'), '-o', binary);
run('/usr/bin/xcrun', compile);
run(binary, []);
if (args.length) run(binary, ['--probe-runtime', path.resolve(args[1])]);
