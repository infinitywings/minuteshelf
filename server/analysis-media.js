'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite, readJSON } = require('./archive-store');

const MODEL_SPECS = Object.freeze({
  'local-qwen': { repo: 'mlx-community/Qwen3-ASR-1.7B-4bit', revision: '78a389c776a5483b2d0d4ea5494e11012e0d6159', directory: 'Qwen3-ASR-1.7B-4bit' },
  'local-mimo': { repo: 'mlx-community/MiMo-V2.5-ASR-MLX', revision: '69813f0d57fb9bb5328735c4e907a4558b47d341', directory: 'MiMo-V2.5-ASR-MLX' },
});
const RUNTIME_REVISION = '6241c57d61663725bb8a0ca1e1695c89ab6c09c0';
const SCRIPT = path.join(__dirname, '..', 'tools', 'local-asr.py');
const error = message => Object.assign(new Error(message), { statusCode: 422 });

function inside(root, file, mustExist = true) {
  const base = fs.realpathSync(root), target = path.resolve(base, file);
  if (!target.startsWith(base + path.sep)) throw error('Analysis file is outside its permitted folder.');
  const resolved = mustExist ? fs.realpathSync(target) : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  if (!resolved.startsWith(base + path.sep)) throw error('Analysis symbolic link leaves its permitted folder.');
  if (mustExist && !fs.statSync(resolved).isFile()) throw error('Analysis input is not a regular file.');
  return resolved;
}
function directory(value) {
  fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(value).isSymbolicLink()) throw error('Analysis folders must not be symbolic links.');
  return fs.realpathSync(value);
}
function run(executable, args, { signal, cwd, env, timeout = 60 * 60 * 1000, onProgress } = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Analysis cancelled.'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    let out = '', err = '', timedOut = false, aborted = false, termination;
    const child = spawn(executable, args, { cwd, env: { ...(env || process.env), MEETING_ANALYSIS_PARENT_PID: String(process.pid) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      termination = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500); termination.unref();
    };
    const abort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout); timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(termination); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', data => { out = (out + data).slice(-1024 * 1024); onProgress?.(); });
    child.stderr.on('data', data => { err = (err + data).slice(-16000); onProgress?.(); });
    child.on('error', failure => { cleanup(); reject(error(`Cannot launch ${path.basename(executable)}: ${failure.code || 'execution failed'}`)); });
    child.on('close', code => {
      cleanup();
      if (aborted) return reject(Object.assign(new Error('Analysis cancelled.'), { name: 'AbortError' }));
      if (timedOut) return reject(error('The local analysis step timed out. Its original files are preserved.'));
      if (code !== 0) return reject(error(`${path.basename(executable)} exited ${code}: ${err.trim().slice(-2000) || 'See the analysis stage status.'}`));
      resolve(out);
    });
  });
}
function environment(runtimeRoot, offline = true) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8',
    HF_HOME: path.join(runtimeRoot, 'cache'), HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    ...(offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {}), PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' };
}
async function prepareMedia({ meetingRoot, runDirectory, plan, signal, binary = path.join(__dirname, '..', '.build', 'analysis-media'), documents = [], bookmarks = [], frameBudget = 60 }) {
  const root = fs.realpathSync(meetingRoot), output = directory(runDirectory);
  if (!output.startsWith(root + '/outputs/') && !output.startsWith(root + '/derived/')) throw error('Analysis output must stay inside its meeting folder.');
  for (const part of [...(plan?.audio || []), ...(plan?.video || [])]) inside(root, part.path);
  for (const doc of documents) inside(root, doc);
  if (!fs.existsSync(binary)) throw error('The offline media preparation helper is missing. Reinstall the app.');
  const request = { meetingRoot: root, outputRoot: output, mediaPlan: plan, documents, bookmarks, frameBudget, chunkSeconds: 30, sampleSeconds: 5 };
  const requestFile = path.join(output, 'media-request.json'); atomicWrite(requestFile, JSON.stringify(request));
  await run(binary, ['--plan', requestFile], { signal, cwd: output, env: environment(output) });
  const result = readJSON(path.join(output, 'prepared-media.json'));
  if (!result || !Array.isArray(result.audio) || !Array.isArray(result.frames)) throw error('Media preparation did not return a valid result.');
  for (const file of [...result.audio, ...result.frames]) inside(output, file.path);
  return { ...result, uncertainties: result.coverage?.limitations || [] };
}
async function extractDocuments({ meetingRoot, runDirectory, documents, signal, binary = path.join(__dirname, '..', '.build', 'analysis-media') }) {
  const root = fs.realpathSync(meetingRoot), output = directory(runDirectory);
  if (!output.startsWith(root + '/outputs/') && !output.startsWith(root + '/derived/')) throw error('Document output must stay inside its meeting folder.');
  for (const document of documents) inside(root, document);
  const requestFile = path.join(output, 'document-request.json');
  atomicWrite(requestFile, JSON.stringify({ meetingRoot: root, outputRoot: output, documents }));
  await run(binary, ['--plan', requestFile], { signal, cwd: output, env: environment(output), timeout: 120000 });
  const result = readJSON(path.join(output, 'prepared-documents.json'));
  if (!Array.isArray(result?.documents)) throw error('Context document extraction failed.');
  return result.documents;
}
function runtimeRoot(dataDirectory) { return path.join(dataDirectory, 'connections', 'local-asr'); }
function modelLocation(config, root) {
  const spec = MODEL_SPECS[config.provider];
  if (!spec) throw error('Select Local Qwen or Local MiMo to prepare an MLX runtime.');
  const selected = String(config.model || spec.repo).trim();
  if (path.isAbsolute(selected)) return { path: selected, model: selected, revision: 'local-model', spec };
  if (selected !== spec.repo) throw error('Automatic installation supports the suggested Qwen or MiMo model. A custom model must be an existing absolute local folder.');
  return { path: path.join(root, 'models', spec.directory), model: selected, revision: spec.revision, spec };
}
function localASRStatus({ config, dataDirectory }) {
  if (!MODEL_SPECS[config.provider]) return { ready: false, supported: false, reason: 'Select Local Qwen or Local MiMo for automatic setup.' };
  const root = runtimeRoot(dataDirectory), location = modelLocation(config, root), runtime = readJSON(path.join(root, 'runtime.json'));
  const installed = readJSON(path.join(location.path, 'meeting-archive-model.json'));
  const ready = fs.existsSync(path.join(root, 'venv', 'bin', 'python3')) && runtime?.revision === RUNTIME_REVISION
    && fs.existsSync(path.join(location.path, 'config.json')) && (location.revision === 'local-model' || installed?.revision === location.revision);
  return { ready, supported: true, model: location.model, revision: location.revision, runtimeRevision: runtime?.revision || null,
    reason: ready ? 'Local ASR runtime and model are installed.' : 'Use Install Local STT to download its runtime and selected model before analysis.' };
}
async function setupLocalASR({ config, dataDirectory, signal, onProgress }) {
  const root = directory(runtimeRoot(dataDirectory)), location = modelLocation(config, root), python = path.join(root, 'venv', 'bin', 'python3');
  if (!fs.existsSync(python)) {
    const versions = '/Library/Frameworks/Python.framework/Versions';
    const framework = fs.existsSync(versions) ? fs.readdirSync(versions).filter(v => /^3\.(1[1-4])$/.test(v)).sort().reverse().map(v => path.join(versions, v, 'bin', 'python3')) : [];
    const candidates = [...framework, '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
    const host = candidates.find(file => fs.existsSync(file));
    if (!host) throw error('Local MLX setup requires Python 3.11 or later for Apple Silicon. Install Python from python.org, then retry Install Local STT.');
    onProgress?.({ phase: 'Creating private Python environment' });
    await run(host, [SCRIPT, 'supervise', '--exec', host, '-m', 'venv', path.join(root, 'venv')], { signal, cwd: root, env: environment(root, false), timeout: 120000 });
  }
  if (readJSON(path.join(root, 'runtime.json'))?.revision !== RUNTIME_REVISION) {
    onProgress?.({ phase: 'Downloading the pinned MLX runtime' });
    const packages = ['mlx==0.32.3', 'mlx-lm==0.32.0', 'transformers==5.18.0', 'huggingface-hub==1.33.0', 'sentencepiece==0.2.2',
      `https://github.com/ailuntx/mlx-audio/archive/${RUNTIME_REVISION}.zip`];
    await run(python, [SCRIPT, 'supervise', '--exec', python, '-m', 'pip', 'install', '--disable-pip-version-check', '--isolated', ...packages], { signal, cwd: root, env: environment(root, false), timeout: 30 * 60 * 1000 });
    atomicWrite(path.join(root, 'runtime.json'), JSON.stringify({ revision: RUNTIME_REVISION, installedAt: new Date().toISOString(), packages }));
  }
  if (location.revision !== 'local-model') {
    onProgress?.({ phase: `Downloading ${location.model}; this may take several minutes` });
    await run(python, [SCRIPT, 'install', '--root', root, '--provider', config.provider], { signal, cwd: root, env: environment(root, false), timeout: 4 * 60 * 60 * 1000 });
  }
  return localASRStatus({ config, dataDirectory });
}
async function transcribeLocal({ config, audio, runDirectory, signal, dataDirectory }) {
  const output = fs.realpathSync(runDirectory), root = runtimeRoot(dataDirectory);
  for (const chunk of audio) {
    inside(output, chunk.path);
    if (!Number.isFinite(chunk.startMs) || !Number.isFinite(chunk.endMs) || chunk.startMs < 0 || chunk.endMs <= chunk.startMs || chunk.endMs - chunk.startMs > 31000) throw error('Invalid local ASR chunk timeline.');
  }
  if (!audio.length) return { segments: [], uncertainties: ['No audio was recorded.'], model: config.model };
  if (config.provider === 'local-whisper') return transcribeWhisper({ config, audio, runDirectory: output, signal, dataDirectory });
  if (!localASRStatus({ config, dataDirectory }).ready) throw error('The local STT runtime or selected model is not installed. Use Install Local STT in Analysis settings, then retry.');
  const location = modelLocation(config, root), requestFile = path.join(output, 'asr-request.json');
  atomicWrite(requestFile, JSON.stringify({ provider: config.provider, model: location.model, modelPath: location.path, revision: location.revision, runDirectory: output, audio, attemptID: crypto.randomUUID() }));
  const python = path.join(root, 'venv', 'bin', 'python3');
  await run('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny network*)', python, SCRIPT, 'infer', '--request', requestFile],
    { signal, cwd: output, env: environment(root), timeout: 24 * 60 * 60 * 1000 });
  const result = readJSON(path.join(output, 'local-transcript.json'));
  if (!result || !Array.isArray(result.segments)) throw error('Local STT returned no readable transcript.');
  return result;
}
async function transcribeWhisper({ config, audio, runDirectory, signal, dataDirectory }) {
  const binary = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(file => fs.existsSync(file));
  if (!binary) throw error('Install whisper.cpp first, or use Local Qwen with Install Local STT.');
  const selected = String(config.model || 'large-v3-turbo').trim();
  if (!path.isAbsolute(selected) && !/^[a-zA-Z0-9._-]+$/.test(selected)) throw error('Select a Whisper model name or an absolute ggml model path.');
  const model = path.isAbsolute(selected) ? selected : path.join(dataDirectory, 'connections', 'local-asr', 'models', `ggml-${selected}.bin`);
  if (!fs.existsSync(model) || !fs.statSync(model).isFile()) throw error('The selected Whisper model is not installed. Enter its absolute local ggml .bin path in Model.');
  const segments = [], uncertainties = ['Speaker diarization has not been run; audio source does not identify a person.', 'Whisper segment times are estimates; check original audio for precise wording.'];
  for (let index = 0; index < audio.length; index++) {
    const chunk = audio[index], prefix = path.join(runDirectory, `whisper-${String(index).padStart(6, '0')}`);
    await run('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny network*)', binary, '-m', model, '-f', inside(runDirectory, chunk.path), '-l', 'auto', '-oj', '-of', prefix],
      { signal, cwd: runDirectory, env: environment(runtimeRoot(dataDirectory)), timeout: 20 * 60 * 1000 });
    const result = readJSON(prefix + '.json');
    if (!Array.isArray(result?.transcription)) throw error('Whisper did not return structured timestamps.');
    for (const [partIndex, part] of result.transcription.entries()) {
      const begin = Number(part.offsets?.from), finish = Number(part.offsets?.to), text = String(part.text || '').trim();
      if (!text) continue;
      if (!Number.isFinite(begin) || !Number.isFinite(finish) || begin < 0 || finish <= begin || finish > chunk.endMs - chunk.startMs + 100) throw error('Whisper returned invalid segment timestamps.');
      segments.push({ id: `asr_${index}_${partIndex}`, source: chunk.source, startMs: chunk.startMs + begin, endMs: Math.min(chunk.endMs, chunk.startMs + finish), text, language: result.result?.language,
        model: selected, speaker: null, timing: 'asr-estimate', audioPath: chunk.path });
    }
  }
  const result = { segments, uncertainties, model: selected }; atomicWrite(path.join(runDirectory, 'local-transcript.json'), JSON.stringify(result)); return result;
}
module.exports = { prepareMedia, extractDocuments, transcribeLocal, setupLocalASR, localASRStatus, runtimeStatus: localASRStatus, inside, MODEL_SPECS, RUNTIME_REVISION };
