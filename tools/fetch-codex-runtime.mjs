// Explicit build-time download. No global CLI, npm install, or existing account
// credentials are consulted. Only the Codex binary and legal notices are kept.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'tools/codex-runtime.lock.json'), 'utf8'));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Prepare the Codex runtime on an Apple Silicon Mac.');
if (!/^\d+\.\d+\.\d+$/.test(lock.version) || lock.package !== '@openai/codex' || lock.platform !== 'darwin-arm64'
    || lock.packageVersion !== `${lock.version}-darwin-arm64` || lock.archive !== `codex-${lock.packageVersion}.tgz`
    || lock.url !== `https://registry.npmjs.org/@openai/codex/-/${lock.archive}`
    || lock.binaryMember !== 'package/vendor/aarch64-apple-darwin/bin/codex'
    || lock.licenseUrl !== `https://raw.githubusercontent.com/openai/codex/rust-v${lock.version}/LICENSE`
    || lock.noticeUrl !== `https://raw.githubusercontent.com/openai/codex/rust-v${lock.version}/NOTICE`
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(lock.npmIntegrity)
    || [lock.sha256, lock.binarySha256, lock.licenseSha256, lock.noticeSha256].some(value => !/^[a-f0-9]{64}$/.test(value))) {
  throw new Error('Invalid official Codex runtime lock.');
}
const vendor = path.join(root, '.build/vendor'), downloads = path.join(vendor, 'downloads');
fs.mkdirSync(downloads, { recursive:true });
const lockPath = path.join(vendor, 'fetch-codex.lock'), descriptor = fs.openSync(lockPath, 'wx', 0o600);
fs.writeFileSync(descriptor, JSON.stringify({ pid:process.pid }) + '\n');
const staging = fs.mkdtempSync(path.join(vendor, 'codex-staging-'));
const hash = (file, algorithm = 'sha256', format = 'hex') => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(format);
function run(command, args, stdout = 'inherit') {
  const result = spawnSync(command, args, { stdio:['ignore', stdout, 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
function download(name, url, digest) {
  const file = path.join(downloads, name);
  if (!fs.existsSync(file)) {
    const partial = path.join(staging, `${name}.partial`);
    run('/usr/bin/curl', ['--fail','--location','--proto','=https','--proto-redir','=https','--tlsv1.2','--connect-timeout','20','--max-time','300','--output',partial,url]);
    if (hash(partial) !== digest) throw new Error(`Downloaded ${name} failed its pinned checksum; nothing installed.`);
    fs.renameSync(partial, file);
  }
  if (!fs.lstatSync(file).isFile() || hash(file) !== digest) throw new Error(`Cached ${name} failed its pinned checksum; inspect the cache before retrying.`);
  return file;
}
try {
  const archive = download(lock.archive, lock.url, lock.sha256);
  if (`sha512-${hash(archive, 'sha512', 'base64')}` !== lock.npmIntegrity) throw new Error('Codex archive does not match the published npm integrity digest.');
  const license = download(`codex-${lock.version}-LICENSE`, lock.licenseUrl, lock.licenseSha256);
  const notice = download(`codex-${lock.version}-NOTICE`, lock.noticeUrl, lock.noticeSha256);
  const extracted = path.join(staging, 'codex'); fs.mkdirSync(path.join(extracted, 'bin'), { recursive:true });
  const binary = path.join(extracted, 'bin', 'codex'), output = fs.openSync(binary, 'wx', 0o755);
  try { run('/usr/bin/tar', ['-xOf',archive,lock.binaryMember], output); } finally { fs.closeSync(output); }
  if (hash(binary) !== lock.binarySha256) throw new Error('Extracted Codex binary checksum mismatch; nothing installed.');
  fs.copyFileSync(license, path.join(extracted, 'LICENSE')); fs.copyFileSync(notice, path.join(extracted, 'NOTICE'));
  fs.writeFileSync(path.join(extracted, 'runtime.json'), JSON.stringify({ ...lock, preparedAt:new Date().toISOString(),
    verification:'Published npm SHA-512 integrity plus pinned SHA-256 archive, binary, LICENSE and NOTICE. No independent registry-signature or provenance verification claim.' }, null, 2) + '\n');
  const destination = path.join(vendor, 'codex'), previous = path.join(staging, 'previous');
  if (fs.existsSync(destination)) fs.renameSync(destination, previous);
  try { fs.renameSync(extracted, destination); }
  catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, destination); throw error; }
  console.log(`Verified official Codex ${lock.version}: ${destination}\nOnly the managed-account runtime and legal notices are included; no account was read.`);
} finally {
  fs.rmSync(staging, { recursive:true, force:true });
  fs.closeSync(descriptor); fs.unlinkSync(lockPath);
}
