// Explicit build-time download. The installed app never downloads a runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'tools/node-runtime.lock.json'), 'utf8'));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Use an Apple Silicon Mac to prepare this runtime.');
if (!/^v\d+\.\d+\.\d+$/.test(lock.version) || lock.platform !== 'darwin-arm64'
  || lock.archive !== `node-${lock.version}-darwin-arm64.tar.gz`
  || lock.url !== `https://nodejs.org/dist/${lock.version}/${lock.archive}`
  || [lock.sha256, lock.binarySha256, lock.licenseSha256].some(value => !/^[a-f0-9]{64}$/.test(value))) {
  throw new Error('Invalid official Node runtime lock.');
}
const vendor = path.join(root, '.build/vendor');
fs.mkdirSync(path.join(vendor, 'downloads'), { recursive: true });
const lockPath = path.join(vendor, 'fetch.lock');
const fd = fs.openSync(lockPath, 'wx', 0o600);
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }) + '\n');
const staging = fs.mkdtempSync(path.join(vendor, 'node-staging-'));
const archive = path.join(vendor, 'downloads', lock.archive);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(command, args, stdout = 'inherit') {
  const result = spawnSync(command, args, { stdio: ['ignore', stdout, 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
try {
  if (!fs.existsSync(archive)) {
    const download = path.join(staging, 'download.partial');
    run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--connect-timeout', '20', '--max-time', '300', '--output', download, lock.url]);
    if (digest(download) !== lock.sha256) throw new Error('Downloaded Node archive checksum mismatch; nothing installed.');
    fs.renameSync(download, archive);
  }
  if (!fs.lstatSync(archive).isFile() || digest(archive) !== lock.sha256) throw new Error('Cached Node archive checksum mismatch; inspect the cache before retrying.');
  const extracted = path.join(staging, 'node');
  fs.mkdirSync(path.join(extracted, 'bin'), { recursive: true });
  for (const [member, expected, mode] of [['bin/node', lock.binarySha256, 0o755], ['LICENSE', lock.licenseSha256, 0o644]]) {
    const destination = path.join(extracted, member);
    const output = fs.openSync(destination, 'wx', mode);
    try { run('/usr/bin/tar', ['-xOf', archive, `node-${lock.version}-darwin-arm64/${member}`], output); }
    finally { fs.closeSync(output); }
    if (digest(destination) !== expected) throw new Error(`Extracted ${member} checksum mismatch; nothing installed.`);
  }
  fs.writeFileSync(path.join(extracted, 'runtime.json'), JSON.stringify({ ...lock, preparedAt: new Date().toISOString(), verification: 'Pinned SHA-256 archive, binary, and LICENSE digests; no GPG verification claim.' }, null, 2) + '\n');
  const destination = path.join(vendor, 'node'), previous = path.join(staging, 'previous');
  if (fs.existsSync(destination)) fs.renameSync(destination, previous);
  try { fs.renameSync(extracted, destination); }
  catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, destination); throw error; }
  console.log(`Verified official Node ${lock.version}: ${destination}\nOnly the runtime and license are included; npm is not bundled.`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.closeSync(fd); fs.unlinkSync(lockPath);
}
