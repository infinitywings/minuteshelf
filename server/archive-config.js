const fs = require('node:fs');
const path = require('node:path');

const defaults = {
  schemaVersion: 'recorder-1',
  server: { host: '127.0.0.1', port: 3123 },
  recording: { fps: 15, maxLongEdgePixels: 2560, bitrate: 6000000, segmentSeconds: 10 },
  processing: { trigger: 'manual', enabled: false },
  mcp: { enabled: false },
  retention: { automaticRawDeletion: false },
};
function load(dataDir) {
  const file = path.join(dataDir, 'recorder-config.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const config = { ...defaults, ...saved,
    server: { ...defaults.server, ...saved.server },
    recording: { ...defaults.recording, ...saved.recording } };
  if (config.schemaVersion !== 'recorder-1') throw new Error('Use recorder-1 configuration; proposal and upstream configs are not executable configs');
  if (config.server.host !== '127.0.0.1') throw new Error('Recorder v1 only supports loopback binding');
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) throw new Error('Invalid port');
  const r = config.recording;
  if (![15, 30].includes(r.fps) || !Number.isInteger(r.maxLongEdgePixels) || r.maxLongEdgePixels < 320 || r.maxLongEdgePixels > 2560
      || !Number.isInteger(r.bitrate) || r.bitrate < 1000000 || r.bitrate > 30000000
      || !Number.isFinite(r.segmentSeconds) || r.segmentSeconds < 5 || r.segmentSeconds > 60) throw new Error('Invalid recording preset');
  if (config.processing?.enabled || config.mcp?.enabled || config.retention?.automaticRawDeletion) throw new Error('AI, MCP and automatic deletion are unavailable in Recorder v1');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}
module.exports = { load, defaults };
