// Package the approved generated PNG into macOS 15-compatible icon sizes.
// sips only downsamples; the source artwork remains unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'design/brand/meeting-archive-app-icon-v1.png');
const iconset = path.join(root, '.build/MeetingArchive.iconset');
fs.mkdirSync(iconset, { recursive: true });
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
}
for (const logicalSize of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const size = String(logicalSize * scale);
    const name = `icon_${logicalSize}x${logicalSize}${scale === 2 ? '@2x' : ''}.png`;
    run('/usr/bin/sips', ['-z', size, size, source, '--out', path.join(iconset, name)]);
  }
}
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'native/MeetingArchive.icns')]);
console.log('Built native/MeetingArchive.icns from the app icon source.');
