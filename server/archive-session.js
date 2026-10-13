const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite, readJSON, isLive, jsonLines, recoverWav } = require('./archive-store');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Bind consent to both kind and ID. Window and display IDs can overlap; a
// window preview must never authorize recording an entire display.
function captureTarget(input) {
  if (typeof input === 'number') input = { windowID: input }; // legacy preview caller
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Select a window or display.');
  let target;
  if (Object.hasOwn(input, 'target')) {
    if (Object.hasOwn(input, 'windowID') || Object.hasOwn(input, 'displayID')) throw new Error('Choose exactly one recording target.');
    target = input.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || Object.keys(target).length !== 2 || Object.keys(target).some(key => !['kind', 'id'].includes(key))) throw new Error('Invalid recording target.');
  } else {
    if (Object.hasOwn(input, 'displayID')) throw new Error('A display requires an explicit target kind.');
    target = { kind: 'window', id: input.windowID };
  }
  if (!['window', 'display'].includes(target.kind) || !Number.isInteger(target.id) || target.id <= 0 || target.id > 0xffffffff) throw new Error('Select a valid window or display.');
  return { kind: target.kind, id: target.id };
}
const sameTarget = (a, b) => a?.kind === b?.kind && a?.id === b?.id;

class SessionManager {
  constructor(store, config, binary = path.join(__dirname, '..', '.build', 'archivecap')) {
    this.store = store; this.config = config; this.binary = binary; this.starting = false;
    this.previews = new Map();
  }
  async native(args, timeoutMs = 30000) {
    if (!fs.existsSync(this.binary)) throw new Error('Build the native helper with npm run build:native first.');
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', diagnostic = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native request timed out; check macOS permission dialogs')); }, timeoutMs);
      child.stdout.on('data', data => { output += data; if (output.length > 4e6) child.kill(); });
      child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        let response;
        try { response = JSON.parse(output.trim()); } catch { return reject(new Error(diagnostic || 'Invalid native response')); }
        if (code || response.event === 'error') return reject(new Error(response.detail || diagnostic || `Native exit ${code}`));
        resolve(response);
      });
    });
  }
  sources() { return this.native(['list']); }
  permissions() { return this.native(['permissions']); }
  requestPermissions(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['screen', 'microphone'].includes(key))
      || Object.values(input).some(value => typeof value !== 'boolean')
      || !(input.screen || input.microphone)) throw new Error('Choose the screen or microphone permission to request.');
    const args = ['request-permissions'];
    if (input.screen) args.push('--screen');
    if (input.microphone) args.push('--mic');
    return this.native(args, 120000);
  }
  openPermissionSettings(permission) {
    if (!['screen', 'microphone'].includes(permission)) throw new Error('Invalid permission setting.');
    return this.native(['open-settings', '--permission', permission]);
  }
  async ensurePermissions(microphone) {
    let state = await this.permissions();
    const screenNeeded = state.screenRecording !== 'granted';
    const microphoneNeeded = microphone && state.microphone !== 'granted';
    if (screenNeeded || microphoneNeeded) state = await this.requestPermissions({ screen: screenNeeded, microphone: microphoneNeeded });
    if (state.screenRecording !== 'granted') throw Object.assign(new Error('Allow Screen & System Audio Recording in System Settings, then check again. Restart the app if macOS asks you to.'), { statusCode: 403 });
    if (microphone && state.microphone !== 'granted') throw Object.assign(new Error('Allow microphone access in System Settings, or turn off Save microphone.'), { statusCode: 403 });
  }
  async preview(input) {
    const target = captureTarget(input);
    const response = await this.native(['preview', `--${target.kind}`, String(target.id)]);
    const previewID = crypto.randomUUID();
    this.previews.set(previewID, { target, expires: Date.now() + 120000 });
    for (const [id, p] of this.previews) if (p.expires < Date.now()) this.previews.delete(id);
    return { ...response, target, previewID };
  }
  async start(body) {
    if (this.starting || this.store.active().length) throw Object.assign(new Error('A recording is already running.'), { statusCode: 409 });
    const target = captureTarget(body);
    const p = this.previews.get(body.previewID);
    const previewTarget = p?.target || (p && { kind: 'window', id: p.windowID });
    if (!p || !sameTarget(previewTarget, target) || p.expires < Date.now() || body.confirmed !== true) throw new Error('Review and confirm a fresh preview of the selected window or display before recording.');
    if (typeof body.microphone !== 'boolean' || typeof body.systemAudio !== 'boolean') throw new Error('Explicitly choose whether to save each audio source.');
    if (![15, 30].includes(body.fps)) throw new Error('Frame rate must be 15 or 30 fps.');
    this.starting = true;
    let meeting;
    try {
      await this.ensurePermissions(body.microphone);
      const available = await this.sources();
      const source = (target.kind === 'display' ? available.displays || [] : available.windows || []).find(value => value.id === target.id);
      if (!source) throw new Error(`The selected ${target.kind} is no longer available. Select another ${target.kind}.`);
      if (body.microphone && !available.microphones.some(m => m.id === body.microphoneID)) throw new Error('Select an available microphone.');
      if (this.previews.get(body.previewID) !== p || p.expires < Date.now()) throw new Error('The preview expired during permission or device checks. Review and confirm the target again.');
      await this.beforeStart?.();
      const selection = { target, [target.kind]: source, microphone: body.microphone, microphoneID: body.microphone ? body.microphoneID : null,
        systemAudio: body.systemAudio, userConfirmedAt: new Date().toISOString() };
      const preset = { ...this.config.recording, fps: body.fps };
      meeting = this.store.create(selection, preset, body.title);
      const args = ['record', '--dir', this.store.raw(meeting.id), `--${target.kind}`, String(target.id),
        '--fps', String(preset.fps), '--max-edge', String(preset.maxLongEdgePixels), '--bitrate', String(preset.bitrate),
        '--segment-seconds', String(preset.segmentSeconds)];
      if (body.microphone) args.push('--mic', '--mic-device', body.microphoneID);
      if (body.systemAudio) args.push('--system-audio');
      const child = spawn(this.binary, args, { detached: true, stdio: 'ignore' });
      let spawnError;
      child.on('error', error => { spawnError = error; });
      child.unref();
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        if (spawnError) throw spawnError;
        const status = this.store.status(meeting.id);
        if (isLive(status) && status.state === 'recording') return this.store.refresh(meeting.id);
        const error = jsonLines(path.join(this.store.raw(meeting.id), 'capture_events.jsonl')).findLast(e => e.event === 'error');
        if (error) throw new Error(error.detail);
        await delay(150);
      }
      // Do not kill an independently running recorder on an HTTP timeout.
      throw new Error(`Recording startup timed out. Check the menu bar and permission dialogs. Meeting ID: ${meeting.id}`);
    } catch (error) {
      if (meeting && !isLive(this.store.status(meeting.id))) {
        meeting.status = 'failed'; meeting.startError = error.message; this.store.save(meeting);
      }
      throw error;
    } finally { this.starting = false; }
  }
  async command(id, command, values = {}) {
    const status = this.store.status(id);
    if (!isLive(status)) throw Object.assign(new Error('The recording host is not running.'), { statusCode: 409 });
    const name = `${Date.now()}-${crypto.randomUUID()}.json`;
    const root = path.join(this.store.raw(id), 'control');
    atomicWrite(path.join(root, 'inbox', name), JSON.stringify({ command, ...values }));
    const result = path.join(root, 'results', name);
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const response = readJSON(result);
      if (response) {
        fs.unlinkSync(result);
        if (!response.ok) throw new Error(response.error);
        return response;
      }
      await delay(100);
    }
    throw new Error('The recording command has not been confirmed. Check the menu bar status.');
  }
  async stop(id) {
    await this.command(id, 'stop');
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const m = this.store.refresh(id);
      if (!['recording', 'paused', 'finalizing'].includes(m.status)) return m;
      await delay(150);
    }
    return this.store.refresh(id); // honest finalizing state, never AI work
  }
  async recover(id) {
    const manifest = this.store.refresh(id);
    if (isLive(this.store.status(id))) throw new Error('Stop recording before recovering media.');
    const directory = path.join(this.store.dir(id), 'derived', 'recovery');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const results = [];
    for (const file of manifest.interruptedTail) {
      const source = path.join(this.store.raw(id), file);
      const base = file.replace('.partial', '').replace(/\.(wav|mp4)$/, '');
      const meta = readJSON(path.join(this.store.raw(id), base + '.json'), {});
      const outputName = file.replace('.partial', '-recovered');
      const output = path.join(directory, outputName);
      try {
        if (file.endsWith('.wav')) {
          const recovered = recoverWav(source, output);
          const index = meta.index || base + '.pts.jsonl';
          const records = jsonLines(path.join(this.store.raw(id), index)).filter(r => r.frameOffset + r.frames <= recovered.frames);
          const last = records.at(-1);
          results.push({ ...meta, ...recovered, file: outputName, recovered: true, status: 'recovered',
            index, endPTS: last && meta.sampleRate ? { seconds: last.pts.seconds + last.frames / meta.sampleRate } : null });
        } else {
          const check = await this.native(['inspect', '--file', source]);
          if (!check.playable || !check.durationSeconds) throw new Error('The unfinished MP4 contains no playable fragments. The original is preserved for recovery.');
          fs.copyFileSync(source, output);
          results.push({ ...meta, file: outputName, kind: 'video', bytes: fs.statSync(output).size,
            recovered: true, status: 'recovered', endPTS: { seconds: meta.startPTS.seconds + check.durationSeconds } });
        }
      } catch (error) { results.push({ file, status: 'unrecoverable', error: error.message }); }
    }
    manifest.recovered = results.filter(r => r.recovered);
    manifest.recoveryResults = results; this.store.save(manifest);
    return results;
  }
}
module.exports = { SessionManager, captureTarget };
