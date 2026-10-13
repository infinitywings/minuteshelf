const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped event handlers with a small DOM, never a model service.
// Reject innerHTML so malicious model text cannot accidentally become markup.
class Element {
  constructor(tag = 'div') { Object.assign(this, { tagName: tag, children: [], dataset: {}, attrs: {}, value: '', checked: false, disabled: false, hidden: false, open: false, ownText: '', parentNode: null }); }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  set innerHTML(_) { throw new Error('Unsafe innerHTML assignment'); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  setAttribute(name, value) { this.attrs[name] = value; if (name === 'open') this.open = true; }
  closest(name) { for (let node = this; node; node = node.parentNode) if (node.tagName === name) return node; return null; }
  scrollIntoView() { this.scrolled = true; }
  async click() { if (!this.disabled) return this.onclick?.(); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = (overrides = {}) => ({ settings: { tasks: {
  transcription: { provider: 'imported-transcript', model: '' }, vision: { provider: 'disabled', model: '' }, summary: { provider: 'anthropic-api', model: 'fixture-model' }
}}, jobs: [], recording: false, busy: false, ...overrides });
const preview = (overrides = {}) => ({ settingsRevision: 'revision-reviewed', uploads: [{ task: 'summary', provider: 'anthropic-api', model: 'fixture-model', endpoint: 'https://api.example.test/v1', content: ['transcriptsAndNotes'] }], durationSeconds: 60, audioSources: ['microphone', 'system'], maxSelectedImages: 0, includeContext: false, transcriptImportRequired: true, limitations: ['Sparse frames can miss details.'], ...overrides });
const job = (overrides = {}) => ({ id: 'run-A', status: 'ready', stage: 'complete', createdAt: '2026-10-05T01:00:00Z', updatedAt: '2026-10-05T01:01:00Z', ...overrides });
const emptyResult = job => ({ job, summary: null, evidence: [] });
function harness(handler = request => { if (request.method === 'GET') return state(); throw new Error(`Unexpected ${request.url}`); }, { flushNotes = async () => {} } = {}) {
  const elements = new Map(), requests = [], intervals = [], navigation = [], native = [];
  const get = id => { if (!elements.has(id)) { const node = new Element(); node.id = id; elements.set(id, node); } return elements.get(id); };
  const find = (node, id) => node.id === id ? node : node.children.map(c => find(c, id)).find(Boolean);
  const document = { createElement: tag => new Element(tag), getElementById: id => [...elements.values()].map(node => find(node, id)).find(Boolean) || null };
  const window = { open() { throw new Error('Native UI should show screen evidence inline, not launch a new window'); } };
  const request = async (method, url, body) => { const item = { method, url, ...(body === undefined ? {} : { body: JSON.parse(JSON.stringify(body)) }) }; requests.push(item); return handler(item); };
  const context = vm.createContext({ $, document, window, console, selected: null, view: 'meeting',
    api: url => request('GET', url), post: (url, body) => request('POST', url, body), flushNotes,
    setInterval(fn) { intervals.push(fn); }, updateList(id, _value, render) { render(get(id)); },
    artifactURL: (id, relative) => `/artifact/${id}/${relative}`, artifactLink(id, relative, label) { const a = new Element('a'); a.href = `/artifact/${id}/${relative}`; a.textContent = label; return a; },
    seconds: number => `${number}s`, selectMeetingTab(tab) { navigation.push({ tab }); }, async seek(time, playing) { navigation.push({ time, playing }); },
    async jumpToSource(evidence) { navigation.push({ source: evidence.source, startMs: evidence.startMs }); }, showMessage(message) { get('message').textContent = message; },
    sendNativeCommand(command) { native.push(command); return true; }
  });
  function $(id) { return get(id); }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/analysis.js'), 'utf8'), context);
  context.window.meetingAnalysis.setAvailable(true);
  return { get, requests, context, navigation, native, async open(id) { context.selected = id; window.meetingAnalysis.open(id); await tick(); }, poll: () => intervals[0](), all(node) { return [node, ...node.children.flatMap(c => this.all(c))]; } };
}

test('opening analysis only reads status; upload preview and confirmation are separate actions', async () => {
  let running = false;
  const ui = harness(({ method, url }) => {
    if (method === 'GET') return url.endsWith('/analysis/run-new') ? emptyResult(job({ id: 'run-new' })) : state();
    if (url.endsWith('/analysis-preview')) return preview();
    running = true; return job({ id: 'run-new' });
  });
  await ui.open('A'); assert.equal(ui.requests.filter(r => r.method === 'POST').length, 0);
  ui.get('analysis-transcript').value = 'A transcript'; ui.get('analysis-context').checked = false;
  await ui.get('analysis-start').click();
  assert.equal(running, false); assert.equal(ui.get('analysis-review').open, true);
  assert.match(ui.get('analysis-review-details').textContent, /api\.example\.test/);
  assert.match(ui.get('analysis-review-details').textContent, /transcriptsAndNotes/);
  assert.match(ui.get('analysis-review-details').textContent, /Context: Excluded/);
  ui.get('analysis-transcript').value = 'Unreviewed edit';
  await ui.get('analysis-review-confirm').click();
  const starts = ui.requests.filter(r => r.method === 'POST' && r.url.endsWith('/analysis'));
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].body, { includeContext: false, transcript: 'A transcript', settingsRevision: 'revision-reviewed' });
  assert.equal(ui.get('analysis-review').open, false);
});

test('cancelled review never starts analysis or uploads a recording', async () => {
  const ui = harness(({ method }) => method === 'GET' ? state() : preview()); await ui.open('A');
  ui.get('analysis-transcript').value = 'Words'; await ui.get('analysis-start').click(); await ui.get('analysis-review-cancel').click();
  await ui.get('analysis-review-confirm').click();
  assert.equal(ui.get('analysis-review').open, false);
  assert.equal(ui.requests.some(r => r.method === 'POST' && r.url.endsWith('/analysis')), false);
});

test('failed start remains visible and can be retried from the same review', async () => {
  const ui = harness(({ method, url }) => {
    if (method === 'GET') return state();
    if (url.endsWith('/analysis-preview')) return preview();
    throw new Error('Save the API key in Settings first.');
  });
  await ui.open('A'); ui.get('analysis-transcript').value = 'Words'; await ui.get('analysis-start').click();
  await ui.get('analysis-review-confirm').click();
  assert.match(ui.get('analysis-state').textContent, /Save the API key/);
  assert.equal(ui.get('analysis-review-confirm').disabled, false); assert.equal(ui.get('analysis-review').open, true);
});

test('a late status response cannot replace another meeting', async () => {
  const late = deferred();
  const ui = harness(({ url }) => url.includes('/A/') ? late.promise : state({ settingsError: 'Current B settings' }));
  await ui.open('A'); await ui.open('B'); late.resolve(state({ settingsError: 'Stale A' })); await tick(); await ui.poll();
  assert.equal(ui.get('analysis-state').textContent, 'Current B settings');
});

test('a late result response cannot inject the old meeting summary into the new meeting', async () => {
  const late = deferred(), old = job();
  const ui = harness(({ url }) => url.endsWith('/A/analysis/run-A') ? late.promise : url.endsWith('/A/analysis') ? state({ jobs: [old] }) : state());
  await ui.open('A'); await ui.open('B');
  late.resolve({ job: old, summary: { overview: [{ text: 'STALE PRIVATE A', evidence_refs: [] }] }, evidence: [] }); await tick(); await ui.poll();
  assert.equal(ui.get('analysis-summary').textContent.includes('STALE PRIVATE A'), false);
  assert.equal(ui.get('analysis-result').hidden, true);
});

test('a late upload preview is ignored after meeting navigation', async () => {
  const late = deferred(), ui = harness(({ method }) => method === 'GET' ? state() : late.promise);
  await ui.open('A'); ui.get('analysis-transcript').value = 'A words';
  const opening = ui.get('analysis-start').click(); await tick(); await ui.open('B'); late.resolve(preview()); await opening;
  assert.equal(ui.get('analysis-review').open, false);
  assert.equal(ui.requests.some(r => r.method === 'POST' && r.url.endsWith('/analysis')), false);
});

test('navigation during a pending note save cancels the original review action', async () => {
  const saved = deferred(), ui = harness(({ method }) => method === 'GET' ? state() : preview({ transcriptImportRequired: false }), { flushNotes: () => saved.promise });
  await ui.open('A'); const opening = ui.get('analysis-start').click(); await tick(); await ui.open('B');
  saved.resolve(); await opening;
  assert.equal(ui.requests.some(r => r.method === 'POST'), false, 'A delayed action from A must not begin a review for B');
  assert.equal(ui.get('analysis-review').open, false);
});

test('a rejected old preview cannot overwrite the new meeting status', async () => {
  const late = deferred(), ui = harness(({ method }) => method === 'GET' ? state({ settingsError: 'B current status' }) : late.promise);
  await ui.open('A'); ui.get('analysis-transcript').value = 'Words'; const opening = ui.get('analysis-start').click(); await tick();
  await ui.open('B'); late.reject(new Error('A request rejected')); await opening;
  assert.equal(ui.get('analysis-state').textContent, 'B current status');
});

test('a completed old start request cannot close a new meeting review', async () => {
  const oldStart = deferred();
  const ui = harness(({ method, url }) => method === 'GET' ? state() : url.endsWith('/analysis-preview') ? preview() : oldStart.promise);
  await ui.open('A'); ui.get('analysis-transcript').value = 'A words'; await ui.get('analysis-start').click();
  const starting = ui.get('analysis-review-confirm').click(); await tick(); await ui.open('B');
  ui.get('analysis-transcript').value = 'B words'; await ui.get('analysis-start').click();
  assert.equal(ui.get('analysis-review').open, true); oldStart.resolve(job()); await starting;
  assert.equal(ui.get('analysis-review').open, true, 'A response must not dismiss B consent');
});

test('retry reviews the exact run and sends the reviewed scope revision', async () => {
  const failed = job({ status: 'failed', error: 'Quota exhausted.' });
  const ui = harness(({ method, url }) => {
    if (method === 'GET') return url.endsWith('/run-A') ? emptyResult(failed) : state({ jobs: [failed] });
    return url.endsWith('/analysis-preview') ? preview() : failed;
  });
  await ui.open('A'); ui.get('analysis-transcript').value = 'Retry transcript'; ui.get('analysis-context').checked = false;
  assert.match(ui.get('analysis-jobs').textContent, /Quota exhausted/);
  const retry = ui.all(ui.get('analysis-jobs')).find(node => node.textContent === 'Retry'); assert.ok(retry); await retry.click();
  assert.equal(ui.get('analysis-review-confirm').textContent, 'Retry analysis'); await ui.get('analysis-review-confirm').click();
  const start = ui.requests.find(r => r.method === 'POST' && r.url.endsWith('/analysis'));
  assert.deepEqual(start.body, { includeContext: false, transcript: 'Retry transcript', retryRunId: 'run-A', settingsRevision: 'revision-reviewed' });
});

test('model output and evidence are rendered as text; audio citations retain their source and time', async () => {
  const ready = job(), malicious = '<img src=x onerror="window.pwned=true">';
  const ui = harness(({ url }) => url.endsWith('/run-A') ? { job: ready, summary: {
    overview: [{ text: malicious, evidence_refs: ['t1', 'unknown'] }], actionItems: [{ text: 'Action', owner: malicious, deadline: null, evidence_refs: ['t1'] }]
  }, evidence: [{ id: 't1', kind: 'transcript', text: malicious, source: 'system', startMs: 5000, endMs: 8000, timingAccuracy: 'chunk-boundary' }] } : state({ jobs: [ready] }));
  await ui.open('A'); assert.ok(ui.get('analysis-summary').textContent.includes(malicious)); assert.ok(ui.get('analysis-evidence').textContent.includes(malicious));
  assert.equal(ui.context.window.pwned, undefined);
  assert.equal(ui.all(ui.get('analysis-summary')).filter(n => n.tagName === 'img').length, 0);
  const play = ui.all(ui.get('analysis-summary')).find(node => node.tagName === 'button'); await play.click();
  assert.deepEqual(ui.navigation, [{ source: 'system', startMs: 5000 }]);
  assert.match(play.textContent, /^Jump to source/);
});

test('screen evidence opens its inline details without creating a browser window', async () => {
  const ready = job(), frame = { id: 'v1', kind: 'visual', text: 'Visible table', sourceMs: 6000, startMs: 5000, endMs: 10000, framePath: 'outputs/run-A/frames/frame.jpg', title: 'Table' };
  const ui = harness(({ url }) => url.endsWith('/run-A') ? { job: ready, summary: { topics: [{ text: 'Table discussed', evidence_refs: ['v1'] }] }, evidence: [frame] } : state({ jobs: [ready] }));
  const details = new Element('details'); details.append(ui.get('analysis-evidence'));
  await ui.open('A');
  const button = ui.all(ui.get('analysis-summary')).find(node => node.tagName === 'button'); await button.click();
  const row = ui.all(ui.get('analysis-evidence')).find(node => node.id === 'evidence-v1');
  assert.equal(details.open, true); assert.equal(row.scrolled, true);
  assert.equal(ui.navigation.length, 0);
  assert.equal(ui.all(row).find(node => node.tagName === 'img').src, '/artifact/A/outputs/run-A/frames/frame.jpg');
});

test('model download requires its own explicit confirmation and does not start analysis', async () => {
  const ui = harness(({ method, url }) => method === 'GET' ? state({ settings: { tasks: { transcription: { provider: 'local-qwen', model: 'fixture-local' } } } }) : {});
  await ui.open('A'); await ui.get('analysis-install').click();
  assert.equal(ui.requests.some(r => r.method === 'POST'), false); assert.match(ui.get('analysis-review-details').textContent, /No meeting audio is uploaded/);
  await ui.get('analysis-review-confirm').click();
  assert.deepEqual(ui.requests.filter(r => r.method === 'POST'), [{ method: 'POST', url: '/api/analysis/runtime-install', body: {} }]);
});
