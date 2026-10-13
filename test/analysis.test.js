const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { ArchiveStore } = require('../server/archive-store');
const { ProjectStore } = require('../server/project-store');
const { MeetingArtifacts } = require('../server/meeting-artifacts');
const { defaults } = require('../server/archive-config');
const { AnalysisManager, normalizeSummary, transcriptSegments, parseObject } = require('../server/analysis-manager');
const { validateSettings, authorize, remote, revision } = require('../server/analysis-settings');

const disabled = { provider: 'disabled', endpoint: '', model: '', authentication: 'none' };
function preferences() { return { schemaVersion: 1, networkPolicy: 'selected-remote-allowed', uploads: { audio: false, images: false, transcriptsAndNotes: true, contextDocuments: false },
  manualAnalysisStart: true, pauseDuringRecording: true, automaticFallback: false,
  tasks: { transcription: { ...disabled, provider: 'imported-transcript' }, vision: { ...disabled }, summary: { provider: 'anthropic-api', endpoint: 'https://api.anthropic.com/v1', model: 'test-model', authentication: 'api-key' } } }; }
function response(text = 'The team agreed to test.') { return { text: JSON.stringify({ overview: [{ text, evidence_refs: ['t000001'] }], decisions: [{ text, evidence_refs: ['t000001'] }], actionItems: [], topics: [], openQuestions: [], uncertainties: [] }), provider: 'anthropic-api', model: 'test-model', usage: {} }; }
const transcript = JSON.stringify([{ source: 'system', startMs: 1000, endMs: 3000, text: '我们决定 test this app.' }]);
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-analysis-test-')); const store = new ArchiveStore(root); const projects = new ProjectStore(root, store); const artifacts = new MeetingArtifacts(store, projects);
  const meeting = store.create({ window: { id: 1, app: 'Fixture', title: 'Fixture' }, microphone: false, systemAudio: true }, defaults.recording, 'Synthetic analysis'); meeting.status = 'failed'; store.save(meeting);
  const original = path.join(store.raw(meeting.id), 'untouched-original.bin'); fs.writeFileSync(original, 'original media sentinel');
  let currentSettings = validateSettings(preferences()); const calls = { prepare: 0, generate: 0 };
  const dependencies = { loadSettings: () => currentSettings, exportPlan: () => ({ durationSeconds: 10, audioSources: ['system'], audio: [], video: [] }),
    readCredential: async config => config.config.authentication === 'api-key' ? 'synthetic-private-credential' : undefined,
    prepareMedia: async () => { calls.prepare++; return { audio: [], frames: [], uncertainties: [] }; },
    generate: async () => { calls.generate++; return response(); }, ...overrides };
  const manager = new AnalysisManager({ store, artifacts, rka: { packet: () => ({ enabled: false }) }, dataDirectory: root, exports: { active: () => [] }, dependencies });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, artifacts, meeting, manager, calls, original, getSettings: () => currentSettings, setSettings: input => { currentSettings = validateSettings(input); } };
}
function start(f, options = {}) { const preview = f.manager.preview(f.meeting.id, options); return f.manager.start(f.meeting.id, { settingsRevision: preview.settingsRevision, transcript, ...options }); }
async function idle(manager) {
  for (let i = 0; i < 1000; i++) { if (!manager.worker && !manager.queue.length) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error('Synthetic analysis did not finish.');
}
test('settings strip credential-like extras and preserve auth isolation and loopback policy', () => {
  const input = preferences(); input.key = 'secret'; input.tasks.summary.apiKey = 'secret';
  const value = validateSettings(input); assert.equal(JSON.stringify(value).includes('secret'), false);
  const api = { provider: 'stt-api', endpoint: 'http://127.20.30.40:8000/v1', model: 'dedicated-stt', authentication: 'none' };
  input.tasks.transcription = api; assert.equal(validateSettings(input).tasks.transcription.authentication, 'none'); assert.equal(remote(api), false);
  assert.equal(remote({ provider: 'chatgpt-plan', endpoint: '' }), true); assert.equal(remote({ provider: 'claude-agent-sdk', endpoint: '' }), true);
  assert.throws(() => validateSettings({ ...input, tasks: { ...input.tasks, summary: { ...input.tasks.summary, authentication: 'claude-code-oauth-token' } } }), /authentication/);
  assert.throws(() => validateSettings({ ...input, tasks: { ...input.tasks, summary: { ...input.tasks.summary, endpoint: 'https://api.example/v1?key=secret' } } }));
});
test('scope authorization requires both selected-remote policy and each data category', () => {
  const settings = validateSettings(preferences()), config = settings.tasks.summary;
  authorize(config, settings, ['transcriptsAndNotes']); assert.throws(() => authorize(config, settings, ['images']), /images/);
  assert.throws(() => authorize(config, { ...settings, networkPolicy: 'local-only' }, ['transcriptsAndNotes']), /remote providers/);
  authorize({ provider: 'local-service', endpoint: 'http://127.0.0.1:11434' }, { ...settings, networkPolicy: 'local-only' }, ['images', 'audio']);
});
test('imported mixed-language transcript reaches evidence-linked summary without changing raw media', async t => {
  const f = fixture(t); f.store.notes(f.meeting.id, 'User note, not a quotation.'); const job = start(f); await idle(f.manager);
  const result = f.manager.result(f.meeting.id, job.id); assert.equal(result.job.status, 'ready'); assert.equal(result.transcript[0].text, '我们决定 test this app.');
  assert.equal(result.transcript[0].startMs, 1000); assert.deepEqual(result.summary.overview[0].evidence_refs, ['t000001']); assert.equal(result.transcript[0].speaker, null);
  assert.equal(result.evidence.find(e => e.id === 'n000001').kind, 'user-note'); assert.equal(fs.readFileSync(f.original, 'utf8'), 'original media sentinel');
  const output = path.join(f.store.dir(f.meeting.id), 'outputs', job.id); assert.match(fs.readFileSync(path.join(output, 'summary.md'), 'utf8'), /\[t000001\]/);
  for (const name of fs.readdirSync(output)) if (/\.json$/.test(name)) assert.equal(fs.readFileSync(path.join(output, name), 'utf8').includes('synthetic-private-credential'), false);
});
test('local-only or stale preview cannot enqueue a remote job', async t => {
  const f = fixture(t); const input = preferences(); input.networkPolicy = 'local-only'; f.setSettings(input);
  assert.throws(() => f.manager.preview(f.meeting.id), /remote providers/); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.generate, 0);
  f.setSettings(preferences()); const preview = f.manager.preview(f.meeting.id); const next = preferences(); next.tasks.summary.model = 'changed-model'; f.setSettings(next);
  assert.throws(() => f.manager.start(f.meeting.id, { settingsRevision: preview.settingsRevision, transcript }), /settings changed/); assert.equal(f.manager.queue.length, 0);
});
test('settings changing between preview and enqueue cannot bypass the reviewed revision', t => {
  const f = fixture(t), before = f.getSettings(); const after = structuredClone(before); after.tasks.summary.model = 'unexpected-model';
  const reviewed = revision(before); let calls = 0;
  f.manager.dependencies.loadSettings = () => ++calls === 1 ? before : after;
  assert.throws(() => f.manager.start(f.meeting.id, { settingsRevision: reviewed, transcript }), /settings changed/i);
  assert.equal(f.manager.queue.length, 0);
});
test('context upload permission is checked separately, and excluded context remains local', async t => {
  let sent; const f = fixture(t, { generate: async options => { sent = options.prompt; return response(); } });
  await f.artifacts.importDocument(f.meeting.id, 'background.txt', Readable.from([Buffer.from('private background')]), 18);
  assert.throws(() => f.manager.preview(f.meeting.id), /context documents/);
  const job = start(f, { includeContext: false }); await idle(f.manager); assert.equal(f.manager.result(f.meeting.id, job.id).job.status, 'ready'); assert.equal(sent.includes('private background'), false);
});
test('failed analysis retries reuse completed stages while retaining raw response for review', async t => {
  let attempts = 0; const f = fixture(t, { generate: async () => { attempts++; return attempts === 1 ? { text: 'invalid synthetic model JSON', provider: 'test', model: 'test-model' } : response(); } });
  const first = start(f); await idle(f.manager); assert.equal(f.manager.jobs(f.meeting.id)[0].status, 'failed'); assert.equal(f.calls.prepare, 1);
  const directory = path.join(f.store.dir(f.meeting.id), 'outputs', first.id); assert.ok(fs.existsSync(path.join(directory, 'summary-part-0-raw.json')));
  const second = start(f, { retryRunId: first.id }); assert.equal(second.id, first.id); await idle(f.manager);
  assert.equal(f.manager.result(f.meeting.id, first.id).job.status, 'ready'); assert.equal(f.calls.prepare, 1); assert.equal(attempts, 2);
});
test('changed transcript refuses checkpoint reuse instead of mixing evidence runs', async t => {
  const f = fixture(t); const job = start(f); await idle(f.manager);
  assert.throws(() => start(f, { retryRunId: job.id, transcript: 'Changed imported transcript.' }), /changed/);
  assert.equal(f.manager.result(f.meeting.id, job.id).transcript[0].text, '我们决定 test this app.');
});
test('new recording cancels the running request and pauses queued jobs before another heavy stage starts', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; }); let count = 0;
  const f = fixture(t, { generate: ({ signal }) => { count++; entered(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled synthetic request')), { once: true })); } });
  const first = start(f); await started;
  const secondMeeting = f.store.create({ window: { id: 2, app: 'Fixture', title: 'Fixture' }, microphone: false, systemAudio: true }, defaults.recording, 'Queued'); secondMeeting.status = 'failed'; f.store.save(secondMeeting);
  const preview = f.manager.preview(secondMeeting.id); const second = f.manager.start(secondMeeting.id, { settingsRevision: preview.settingsRevision, transcript });
  await f.manager.cancelForRecording(); assert.equal(f.manager.queue.length, 0); assert.equal(count, 1);
  assert.equal(f.manager.jobs(f.meeting.id).find(j => j.id === first.id).status, 'paused'); assert.equal(f.manager.jobs(secondMeeting.id).find(j => j.id === second.id).status, 'paused');
});
test('unowned persisted processing jobs recover as interrupted without discarding artifacts', async t => {
  const f = fixture(t); const job = start(f); await idle(f.manager);
  const file = path.join(f.store.dir(f.meeting.id), 'outputs', job.id, 'job.json'), value = JSON.parse(fs.readFileSync(file)); value.status = 'processing'; fs.writeFileSync(file, JSON.stringify(value));
  assert.equal(f.manager.jobs(f.meeting.id)[0].status, 'interrupted'); assert.ok(fs.existsSync(path.join(path.dirname(file), 'summary.md')));
});
test('summary validation drops fabricated citations and decisions supported only by slides', () => {
  const evidence = [{ id: 't000001' }, { id: 'v000001' }, { id: 'b000001' }];
  const result = normalizeSummary({ overview: [{ text: 'valid', evidence_refs: ['t000001'] }, { text: 'fabricated', evidence_refs: ['made-up'] }], decisions: [{ text: 'visual only', evidence_refs: ['v000001'] }, { text: 'background only', evidence_refs: ['b000001'] }, { text: 'spoken decision', evidence_refs: ['t000001'] }], actionItems: [{ text: 'follow up', evidence_refs: ['t000001'], owner: null, deadline: null }] }, evidence);
  assert.equal(result.overview.length, 1); assert.equal(result.decisions.length, 1); assert.equal(result.actionItems[0].owner, null); assert.ok(result.uncertainties.some(item => /Uncited/.test(item.text)));
  assert.throws(() => parseObject('not JSON')); assert.throws(() => transcriptSegments([{ text: 'bad', startMs: 0, endMs: 999999 }], 10000));
});

test('retry can reuse the saved imported transcript after reopening the app', async t => {
  const f = fixture(t); const first = start(f); await idle(f.manager);
  const preview = f.manager.preview(f.meeting.id);
  const retry = f.manager.start(f.meeting.id, { settingsRevision: preview.settingsRevision, retryRunId: first.id, transcript: '' });
  await idle(f.manager); assert.equal(retry.id, first.id); assert.equal(f.manager.result(f.meeting.id, first.id).job.status, 'ready');
});
test('edited context copies cannot be cited under an old provenance hash', async t => {
  const f = fixture(t); const settings = preferences(); settings.uploads.contextDocuments = true; f.setSettings(settings);
  const doc = await f.artifacts.importDocument(f.meeting.id, 'versioned.txt', Readable.from([Buffer.from('original')]), 8);
  fs.writeFileSync(path.join(f.store.dir(f.meeting.id), doc.path), 'edited');
  assert.throws(() => start(f), /document changed/i); assert.equal(f.calls.prepare, 0);
});
