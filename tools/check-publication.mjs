// Check publication boundaries without reading ignored archives or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public-files.json'), 'utf8'));
const failures = [];
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid public-file manifest.');
const allowed = new Set(manifest.files);
if (allowed.size !== manifest.files.length) failures.push('Duplicate public-file paths.');
for (const relative of allowed) {
  if (typeof relative !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(relative)
      || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) {
    failures.push('Invalid relative path in public-file manifest.');
    continue;
  }
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const file = path.join(root, ...parts.slice(0, index));
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
      failures.push(`Missing or symbolic public path: ${relative}`);
      break;
    }
  }
  if (fs.existsSync(path.join(root, relative)) && !fs.lstatSync(path.join(root, relative)).isFile()) failures.push(`Not a regular file: ${relative}`);
}

function git(args, optional = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    if (optional) return undefined;
    throw new Error('Git check failed. Use --files-only for an extracted source tree.');
  }
  return result.stdout.split('\0').filter(Boolean);
}
if (!process.argv.includes('--files-only')) {
  const indexed = git(['ls-files', '-z']);
  for (const file of indexed) if (!allowed.has(file)) failures.push(`Outside public-file list in index: ${file}`);
  for (const file of allowed) if (!indexed.includes(file)) failures.push(`Public file not staged/tracked: ${file}`);
  for (const file of git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], true) || []) {
    if (!allowed.has(file)) failures.push(`Outside public-file list in HEAD: ${file}`);
  }
  for (const entry of git(['ls-files', '--stage', '-z'])) {
    if (entry.startsWith('120000 ') || entry.startsWith('160000 ')) failures.push('Symbolic links and submodules are not approved public files.');
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication boundary passed: ${allowed.size} explicitly approved regular files. Run a separate secret scan before pushing.`);
}
