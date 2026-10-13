'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareMedia, extractDocuments, transcribeLocal, localASRStatus, inside } = require('../server/analysis-media');
const binary = path.resolve(__dirname, '..', '.build', 'analysis-media');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-media-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'raw')); fs.mkdirSync(path.join(root, 'outputs', 'test'), { recursive: true });
  return { root, output: path.join(root, 'outputs', 'test') };
}
function wave(file, sampleRate, seconds, channels = 2) {
  const frames = sampleRate * seconds, data = Buffer.alloc(44 + frames * channels * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let index = 0; index < frames; index++) for (let channel = 0; channel < channels; channel++) data.writeInt16LE(Math.round(Math.sin(index / sampleRate * 440 * 2 * Math.PI) * 12000), 44 + (index * channels + channel) * 2);
  fs.writeFileSync(file, data);
}
function wavInfo(file) {
  const data = fs.readFileSync(file); let audioBytes, channels, sampleRate, bits;
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  for (let offset = 12; offset + 8 <= data.length;) {
    const id = data.toString('ascii', offset, offset + 4), bytes = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') { channels = data.readUInt16LE(offset + 10); sampleRate = data.readUInt32LE(offset + 12); bits = data.readUInt16LE(offset + 22); }
    if (id === 'data') audioBytes = bytes;
    offset += 8 + bytes + bytes % 2;
  }
  return { channels, sampleRate, bits, frames: audioBytes / channels / (bits / 8) };
}
test('media paths refuse traversal and symlinks outside the run', t => {
  const { root, output } = fixture(t); fs.writeFileSync(path.join(root, 'raw', 'a.wav'), 'source');
  assert.throws(() => inside(output, '../../raw/a.wav'), /outside/);
  fs.symlinkSync(path.join(root, 'raw', 'a.wav'), path.join(output, 'link.wav'));
  assert.throws(() => inside(output, 'link.wav'), /symbolic link/);
});
test('missing local models return an explicit setup state without downloading', async t => {
  const { root, output } = fixture(t), config = { provider: 'local-qwen' };
  const status = localASRStatus({ config, dataDirectory: root }); assert.equal(status.ready, false); assert.equal(status.supported, true);
  wave(path.join(output, 'sample.wav'), 16000, 1, 1);
  await assert.rejects(transcribeLocal({ config, dataDirectory: root, runDirectory: output, audio: [{ path: 'sample.wav', source: 'system', startMs: 0, endMs: 1000 }] }), /Install Local STT/);
  assert.equal(fs.existsSync(path.join(root, 'connections')), false);
});
test('offline preparation maps resampling and gaps to session PTS', { skip: !fs.existsSync(binary) }, async t => {
  const { root, output } = fixture(t); wave(path.join(root, 'raw', 'sample.wav'), 48000, 4);
  const plan = { durationSeconds: 20, video: [], audio: [{ path: 'raw/sample.wav', source: 'system', sampleRate: 48000,
    spans: [{ startSeconds: 10, frameOffset: 0, frames: 96000 }, { startSeconds: 16, frameOffset: 96000, frames: 96000 }] }] };
  const result = await prepareMedia({ meetingRoot: root, runDirectory: output, plan, binary });
  assert.equal(result.audio.length, 2); assert.equal(result.frames.length, 0);
  assert.equal(result.audio[0].startMs, 10000); assert.ok(Math.abs(result.audio[0].endMs - 12000) < 0.2);
  assert.equal(result.audio[1].startMs, 16000); assert.ok(Math.abs(result.audio[1].endMs - 18000) < 0.2);
  for (const item of result.audio) assert.deepEqual(wavInfo(path.join(output, item.path)), { channels: 1, sampleRate: 16000, bits: 16, frames: 32000 });
  assert.equal(result.audio[1].timeline[0].sourceFrameOffset, 96000);
  assert.equal(result.coverage.allFramesAnalyzed, false);
});
test('offline preparation joins adjacent files without resetting session offsets', { skip: !fs.existsSync(binary) }, async t => {
  const { root, output } = fixture(t); wave(path.join(root, 'raw', 'one.wav'), 44100, 1, 1); wave(path.join(root, 'raw', 'two.wav'), 44100, 1, 1);
  const plan = { durationSeconds: 9, video: [], audio: [0, 1].map(index => ({ path: `raw/${index ? 'two' : 'one'}.wav`, source: 'microphone', sampleRate: 44100,
    spans: [{ startSeconds: 5 + index, frameOffset: 0, frames: 44100 }] })) };
  const result = await prepareMedia({ meetingRoot: root, runDirectory: output, plan, binary });
  assert.equal(result.audio.length, 1); assert.equal(result.audio[0].startMs, 5000); assert.equal(result.audio[0].endMs, 7000);
  assert.deepEqual(wavInfo(path.join(output, result.audio[0].path)), { channels: 1, sampleRate: 16000, bits: 16, frames: 32000 });
});
test('document extraction is scoped and preserves existing media results', { skip: !fs.existsSync(binary) }, async t => {
  const { root, output } = fixture(t); fs.writeFileSync(path.join(root, 'raw', 'context.txt'), '中文 meeting context');
  fs.writeFileSync(path.join(output, 'prepared-media.json'), '{"preserved":true}');
  const result = await extractDocuments({ meetingRoot: root, runDirectory: output, documents: ['raw/context.txt'], binary });
  assert.equal(result[0].text, '中文 meeting context'); assert.equal(result[0].textUnavailable, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'prepared-media.json'))), { preserved: true });
});
test('overlapping source timeline is rejected instead of silently shifting audio', { skip: !fs.existsSync(binary) }, async t => {
  const { root, output } = fixture(t); wave(path.join(root, 'raw', 'sample.wav'), 48000, 4);
  await assert.rejects(prepareMedia({ meetingRoot: root, runDirectory: output, binary, plan: { durationSeconds: 5, video: [], audio: [{ path: 'raw/sample.wav', source: 'system', sampleRate: 48000,
    spans: [{ startSeconds: 0, frameOffset: 0, frames: 96000 }, { startSeconds: 1, frameOffset: 96000, frames: 96000 }] }] } }), /Overlapping audio/);
});
