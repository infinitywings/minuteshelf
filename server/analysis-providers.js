// Stateless inference adapters. The job coordinator must authorize the exact
// content and network scope before invoking this module. No tools are exposed.
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateCodex } = require('./codex-analysis');
const { generateClaude } = require('./claude-analysis');

const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const failure = (message, code = 'analysis_provider') => Object.assign(new Error(message), { code });
function isLoopbackHost(host) {
  const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
function endpointURL(value, provider) {
  let url;
  try { url = new URL(value || (provider === 'anthropic-api' ? 'https://api.anthropic.com/v1' : provider === 'local-service' ? 'http://127.0.0.1:11434' : '')); }
  catch { throw failure('Enter a valid model endpoint.'); }
  const local = isLoopbackHost(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol === 'http:' && !local) || (provider === 'local-service' && !local)) {
    throw failure('Model endpoints must use HTTPS, or HTTP on this Mac. URL credentials and query parameters are not allowed.');
  }
  const suffix = provider === 'anthropic-api' ? '/messages' : provider === 'local-service' ? '/api/chat' : '/chat/completions';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (provider === 'anthropic-api' && !pathname) pathname = '/v1';
  if (!pathname.endsWith(suffix)) pathname += suffix;
  url.pathname = pathname;
  return url;
}
async function readImages(images, dataDirectory) {
  if (!Array.isArray(images) || images.length > 8) throw failure('Send at most eight selected images per request.');
  if (!images.length) return [];
  if (typeof dataDirectory !== 'string') throw failure('Image requests require an archive directory.');
  const root = await fs.realpath(dataDirectory);
  const output = []; let total = 0;
  for (const item of images) {
    if (!item || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mimeType) || typeof item.path !== 'string') throw failure('Unsupported analysis image.');
    const file = await fs.realpath(item.path);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw failure('Analysis images must belong to this archive.');
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE || total + stat.size > 20 * 1024 * 1024) throw failure('Selected images exceed the analysis size limit.');
      const data = await handle.readFile(); total += data.length;
      if (data.length !== stat.size) throw failure('An analysis image changed while being read.');
      output.push({ mimeType: item.mimeType, data: data.toString('base64') });
    } finally { await handle.close(); }
  }
  return output;
}
function cleanUsage(raw) {
  const value = {};
  for (const name of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_eval_count', 'eval_count']) {
    if (Number.isSafeInteger(raw?.[name]) && raw[name] >= 0) value[name] = raw[name];
  }
  return value;
}
async function boundedJSON(response) {
  const length = Number(response.headers?.get('content-length'));
  if (length > MAX_RESPONSE) throw failure('The model response exceeded the size limit.');
  let total = 0; const chunks = [];
  for await (const chunk of response.body || []) {
    total += chunk.length;
    if (total > MAX_RESPONSE) throw failure('The model response exceeded the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('The model returned an invalid JSON response.'); }
}
function apiError(status) {
  if (status === 401 || status === 403) return failure('The provider rejected access. Check the saved API key, account permissions, and selected model.', 'provider_auth');
  if (status === 429) return failure('The provider is rate limited or has insufficient quota. Retry later or check your account.', 'provider_quota');
  if (status >= 300 && status < 400) return failure('The model endpoint redirected the request. Enter its final HTTPS API URL; redirects are not followed.');
  return failure(`The model request failed (HTTP ${Number.isInteger(status) ? status : 'unknown'}). Check the endpoint and model, then retry.`);
}
async function generate({ config, system = '', prompt, images = [], signal, dataDirectory, key, fetchImpl = globalThis.fetch, timeoutMs = 180000, codexOptions = {}, claudeOptions = {} }) {
  if (!config || typeof config.model !== 'string' || !config.model.trim() || config.model.length > 500 || /[\x00-\x1f]/.test(config.model)) throw failure('Choose a model before starting analysis.');
  if (typeof prompt !== 'string' || typeof system !== 'string' || Buffer.byteLength(prompt + system) > 1024 * 1024) throw failure('The analysis text exceeds the per-request limit.');
  if (signal?.aborted) throw failure('Analysis cancelled.', 'aborted');
  const provider = config.provider;
  if (!['anthropic-api', 'openai-compatible', 'local-service', 'chatgpt-plan', 'claude-agent-sdk'].includes(provider)) throw failure('This analysis provider is not available. Choose Anthropic API, Claude Code, Codex, a compatible API, or a local service.');
  const encoded = await readImages(images, dataDirectory);
  if (provider === 'chatgpt-plan') return generateCodex({ config, system, prompt, images: encoded, signal, dataDirectory, timeoutMs, ...codexOptions });
  if (provider === 'claude-agent-sdk') return generateClaude({ config, system, prompt, images: encoded, key, signal, timeoutMs, ...claudeOptions });
  const url = endpointURL(config.endpoint, provider);
  const needsKey = config.authentication === 'api-key' || provider === 'anthropic-api';
  if (needsKey && (typeof key !== 'string' || !key.trim() || key.length > 16384 || /[\x00-\x20\x7f]/.test(key))) throw failure('Save an API key in Settings before starting analysis.', 'provider_auth');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const model = config.model.trim(); let body;
  if (provider === 'anthropic-api') {
    headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
    body = { model, max_tokens: 8192, stream: false, system,
      messages: [{ role: 'user', content: [...encoded.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })), { type: 'text', text: prompt }] }] };
  } else if (provider === 'local-service') {
    if (needsKey) headers.Authorization = `Bearer ${key}`;
    body = { model, stream: false, keep_alive: 0, options: { num_ctx: 8192, num_predict: 8192 }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt, ...(encoded.length ? { images: encoded.map(image => image.data) } : {}) }] };
  } else {
    if (needsKey) headers.Authorization = `Bearer ${key}`;
    body = { model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: encoded.length ? [{ type: 'text', text: prompt }, ...encoded.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] : prompt }] };
  }
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Math.min(timeoutMs, 600000)));
  try {
    const response = await fetchImpl(url.href, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'manual', credentials: 'omit' });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw apiError(response.status); }
    const value = await boundedJSON(response);
    let text;
    if (provider === 'anthropic-api') {
      if (value.stop_reason === 'max_tokens') throw failure('The model response was truncated. Analyze a smaller section and retry.');
      if (!Array.isArray(value.content) || value.content.some(block => block.type === 'tool_use' || block.type === 'server_tool_use')) throw failure('The model returned unsupported tool output.');
      text = value.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    } else if (provider === 'local-service') {
      if (!value.done || value.message?.tool_calls?.length) throw failure('The local model did not finish a text response.');
      text = value.message?.content;
    } else {
      const choice = value.choices?.[0];
      if (choice?.finish_reason === 'length') throw failure('The model response was truncated. Analyze a smaller section and retry.');
      if (choice?.message?.tool_calls?.length || choice?.message?.function_call) throw failure('The model returned unsupported tool output.');
      text = choice?.message?.content;
    }
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_RESPONSE) throw failure('The model returned no usable text.');
    return { text, usage: cleanUsage(value.usage || value), provider, model };
  } catch (error) {
    if (signal?.aborted) throw failure('Analysis cancelled.', 'aborted');
    if (timedOut) throw failure('The model request timed out. Retry with a smaller section.', 'provider_timeout');
    if (error?.code?.startsWith('provider_') || error?.code === 'analysis_provider') throw error;
    // Never relay untrusted response bodies, URLs, headers, or transport errors.
    throw failure('The model service could not be reached. Check its address and network connection.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}
// Dedicated STT HTTP adapters are deliberately separate from LLM SDKs: a video
// attachment does not implicitly transcribe its audio. Each prepared chunk
// retains its original source and session-clock offset.
async function transcribeAPI({ config, audio, runDirectory, signal, dataDirectory, key, fetchImpl = globalThis.fetch, timeoutMs = 180000, onProgress = () => {} }) {
  if (config?.provider !== 'stt-api' || typeof config.model !== 'string' || !config.model.trim() || config.model.length > 500 || /[\x00-\x1f]/.test(config.model)) throw failure('Choose a dedicated speech-to-text API model.');
  if (!Array.isArray(audio) || !audio.length || audio.length > 10000) throw failure('No valid prepared audio chunks are available.');
  const url = endpointURL(config.endpoint, 'openai-compatible');
  url.pathname = url.pathname.replace(/\/chat\/completions$/, '/audio/transcriptions');
  // Also accept an explicitly pasted transcription endpoint.
  url.pathname = url.pathname.replace(/\/audio\/transcriptions\/audio\/transcriptions$/, '/audio/transcriptions');
  const root = await fs.realpath(dataDirectory), run = await fs.realpath(runDirectory);
  const within = (parent, child) => { const relative = path.relative(parent, child); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  if (!within(root, run)) throw failure('Prepared audio must belong to the selected archive.');
  const needsKey = config.authentication === 'api-key';
  if (needsKey && (typeof key !== 'string' || !key.trim() || key.length > 16384 || /[\x00-\x20\x7f]/.test(key))) throw failure('Save the speech-to-text API key in Settings.', 'provider_auth');
  const model = config.model.trim(), segments = [], raw = [], uncertainties = [];
  for (const [index, chunk] of audio.entries()) {
    if (signal?.aborted) throw failure('Analysis cancelled.', 'aborted');
    if (!chunk || typeof chunk.path !== 'string' || path.isAbsolute(chunk.path) || !['system', 'microphone'].includes(chunk.source)
      || !Number.isFinite(chunk.startMs) || !Number.isFinite(chunk.endMs) || chunk.startMs < 0 || chunk.endMs <= chunk.startMs) throw failure('An audio chunk has invalid source or timeline metadata.');
    const file = await fs.realpath(path.resolve(run, chunk.path));
    if (!within(run, file)) throw failure('An audio chunk is outside the current analysis run.');
    const handle = await fs.open(file, 'r'); let data;
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size < 44 || stat.size > 24 * 1024 * 1024) throw failure('An audio chunk exceeds the speech API size limit.'); data = await handle.readFile(); if (data.length !== stat.size) throw failure('An audio chunk changed while being read.'); }
    finally { await handle.close(); }
    const form = new FormData(); form.set('model', model); form.set('file', new Blob([data], { type: 'audio/wav' }), `chunk-${index + 1}.wav`);
    const diarized = /(?:^|-)transcribe-diarize(?:-|$)/.test(model);
    const textOnly = /^gpt-4o(?:-mini)?-transcribe(?:-|$)/.test(model) && !diarized;
    form.set('response_format', diarized ? 'diarized_json' : textOnly ? 'json' : 'verbose_json');
    if (diarized) form.set('chunking_strategy', 'auto');
    const headers = { Accept: 'application/json' }; if (needsKey) headers.Authorization = `Bearer ${key}`;
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Math.min(timeoutMs, 600000)));
    let value;
    try {
      const response = await fetchImpl(url.href, { method: 'POST', headers, body: form, signal: controller.signal, redirect: 'manual', credentials: 'omit' });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw apiError(response.status); }
      value = await boundedJSON(response);
    } catch (error) {
      if (signal?.aborted) throw failure('Analysis cancelled.', 'aborted');
      if (timedOut) throw failure('Speech-to-text timed out for an audio chunk. Retry the analysis.', 'provider_timeout');
      if (error?.code === 'analysis_provider' || error?.code?.startsWith('provider_')) throw error;
      throw failure('The speech-to-text service could not be reached. Check its endpoint.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
    const language = typeof value.language === 'string' && value.language.length < 100 ? value.language : null;
    if (typeof value.text !== 'string' && !Array.isArray(value.segments)) throw failure('The speech service returned no transcript.');
    const timed = Array.isArray(value.segments) && value.segments.length > 0;
    const records = timed ? value.segments : (value.text?.trim() ? [{ text: value.text }] : []);
    if (records.length > 10000) throw failure('The speech service returned too many transcript segments.');
    const safeRaw = [];
    for (const [part, record] of records.entries()) {
      if (typeof record.text !== 'string' || record.text.length > 200000) throw failure('The speech service returned an invalid transcript segment.');
      let startMs = chunk.startMs, endMs = chunk.endMs;
      if (timed) {
        if (!Number.isFinite(record.start) || !Number.isFinite(record.end) || record.start < 0 || record.end < record.start
          || record.end * 1000 > chunk.endMs - chunk.startMs + 1000) throw failure('The speech service returned timestamps outside the audio chunk.');
        startMs = Math.min(chunk.endMs, Math.round(chunk.startMs + record.start * 1000)); endMs = Math.min(chunk.endMs, Math.round(chunk.startMs + record.end * 1000));
      }
      if (!record.text.trim()) continue;
      const observedSpeaker = typeof record.speaker === 'string' && record.speaker.length <= 100 ? record.speaker : null;
      segments.push({ id: `asr-api-${index + 1}-${part + 1}`, source: chunk.source, startMs, endMs, text: record.text,
        language, model, modelRevision: model, speaker: null, ...(observedSpeaker ? { speakerCluster: `${chunk.source}-chunk${index + 1}-${observedSpeaker}` } : {}),
        timing: timed ? 'asr-estimate' : 'chunk-boundary', audioPath: chunk.path });
      safeRaw.push({ text: record.text, ...(timed ? { start: record.start, end: record.end } : {}), ...(observedSpeaker ? { speaker: observedSpeaker } : {}) });
    }
    raw.push({ audioPath: chunk.path, source: chunk.source, startMs: chunk.startMs, endMs: chunk.endMs, language, model, segments: safeRaw, usage: cleanUsage(value.usage) });
    if (!timed && records.length) uncertainties.push(`Audio chunk ${index + 1} has chunk-boundary timing because its provider did not return segment timestamps.`);
    if (diarized) uncertainties.push(`Speaker labels for audio chunk ${index + 1} are local to that chunk and are not confirmed identities.`);
    onProgress({ completed: index + 1, total: audio.length });
  }
  segments.sort((a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source));
  return { segments, raw, uncertainties, model, revision: model };
}
module.exports = { generate, transcribeAPI, endpointURL, isLoopbackHost, readImages, cleanUsage };
