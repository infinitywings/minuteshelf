const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ArchiveStore } = require('../server/archive-store');
const { defaults } = require('../server/archive-config');
const { ProjectStore } = require('../server/project-store');
const { RkaClient, RkaContextStore, endpoint } = require('../server/rka-context');
const { createRecorderServer } = require('../server/index');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-context-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archives = new ArchiveStore(root);
  const make = title => {
    const m = archives.create({ window: { id: 1, app: 'Fixture', title: 'Synthetic' }, microphone: false, systemAudio: false }, defaults.recording, title);
    m.status = 'failed'; archives.save(m); return m;
  };
  return { root, archives, m: make('第一次讨论'), m2: make('第二次讨论') };
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function entity(id, record = {}) {
  return { found: true, outcome: 'resolved', type: id.startsWith('clm') ? 'claim' : 'journal', project_id: 'prj_fixture',
    revision: { fingerprint: `revision-${id}` }, tags: ['test'], currentness: { is_current: true, state: 'current', reasons: [] },
    record: { id, title: `记录 ${id}`, project_id: 'prj_fixture', status: 'active', confidence: 0.6, ...record } };
}
const collectResult = () => ({ project: { id: 'prj_fixture', name: 'Synthetic project' }, serverVersion: 'fixture',
  retrieval: { queries: ['实验'], truncated: false }, links: [], claimEdges: [], records: [
    { id: 'clm_current', available: true, type: 'claim', title: '当前背景', record: { title: 'A', confidence: 0.6 }, revision: { fingerprint: 'r1' }, recordHash: 'h1', currentness: { is_current: true }, useAs: 'current_background' },
    { id: 'clm_old', available: true, type: 'claim', title: '历史背景', record: { title: 'B', stale: true }, recordHash: 'h2', currentness: { is_current: false }, useAs: 'historical_or_unverified_background' }
  ] });
function configure(store, id, extra = {}) {
  const c = store.connection(id);
  return store.configure(id, { ...c, enabled: true, projectId: 'prj_fixture', query: '本次实验讨论', angleQueries: ['实验结果'], ...extra });
}

test('local projects group multiple meetings; moving a meeting changes only its membership', t => {
  const { root, archives, m, m2 } = fixture(t), projects = new ProjectStore(root, archives);
  archives.notes(m.id, '先前提出方案 A'); archives.notes(m2.id, '仍需核查，不能当作已完成');
  const p = projects.create({ name: '实验项目', rkaProjectId: 'prj_fixture' }), other = projects.create({ name: '另一项目' });
  projects.assign(m.id, p.id); projects.assign(m2.id, p.id);
  const overview = projects.overview(p.id);
  assert.equal(overview.meetingCount, 2); assert.equal(overview.rollupStatus, 'not_implemented');
  assert.equal(overview.meetings[0].noteRef.meetingId, m.id); assert.equal(overview.meetings[1].notes, '仍需核查，不能当作已完成');
  assert.equal(new ProjectStore(root, archives).assignment(m.id), p.id);
  projects.assign(m.id, other.id); assert.equal(projects.overview(p.id).meetingCount, 1);
  assert.equal(archives.manifest(m.id).title, '第一次讨论'); assert.equal(archives.meeting(m.id).notes, '先前提出方案 A');
  projects.assign(m.id, null); assert.equal(projects.assignment(m.id), null);
  assert.throws(() => projects.assign(m.id, 'not-a-project'));
  assert.throws(() => projects.create({ name: ' ', rkaProjectId: 'prj_fixture' }));
  fs.writeFileSync(projects.file, '{invalid');
  assert.throws(() => projects.create({ name: '不能覆盖损坏清单' }), /damaged/);
  assert.equal(fs.readFileSync(projects.file, 'utf8'), '{invalid');
});

test('a damaged project meeting stays visible without blocking healthy meetings or context export', async t => {
  const { root, archives, m, m2 } = fixture(t), projects = new ProjectStore(root, archives);
  const p = projects.create({ name: '包含损坏记录的项目' });
  projects.assign(m.id, p.id); projects.assign(m2.id, p.id); archives.notes(m2.id, '可读笔记');
  const manifestFile = path.join(archives.dir(m.id), 'manifest.json'); fs.writeFileSync(manifestFile, '{invalid');
  const runtime = createRecorderServer({ dataDir: root, store: archives, projects, config: defaults, token: 'project-test' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => runtime.server.close(resolve)));
  const base = `http://127.0.0.1:${runtime.server.address().port}`, headers = { Authorization: 'Bearer project-test' };
  for (const route of ['/api/meetings', `/api/projects/${p.id}`, `/api/projects/${p.id}/analysis-context`]) {
    const response = await fetch(base + route, { headers }); assert.equal(response.status, 200);
    const result = await response.json(), meetings = Array.isArray(result) ? result : result.meetings;
    const bad = meetings.find(item => item.id === m.id), good = meetings.find(item => item.id === m2.id);
    assert.equal(bad.status, 'unavailable'); assert.equal(bad.archiveError.code, 'MANIFEST_INVALID');
    assert.equal(good.notes ?? good.notesPreview, '可读笔记');
    if (route.endsWith('analysis-context')) { assert.equal(bad.background, null); assert.equal(bad.noteRef, null); }
  }
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), '{invalid');
});

test('RKA adapter uses explicit project-scoped read-only routes and preserves source closure', async t => {
  const requests = [];
  const url = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, route: req.url, project: req.headers['x-rka-project'], body: raw && JSON.parse(raw) });
    let value;
    if (req.url === '/api/health') value = { status: 'ok', version: 'fixture-v1' };
    else if (req.url === '/api/projects') value = [{ id: 'prj_fixture', name: 'Synthetic' }];
    else if (req.url === '/api/graph/report-context') value = { nodes: [{ id: 'clm_stale', included_via: ['search'] }, { id: 'clm_current', included_via: ['seed'] }], queries: ['结果'] };
    else if (req.url === '/api/entities/resolve') value = { schema_version: 'rka-entity-resolution/v1', project_id: 'prj_fixture', mode: 'read_only', entities: {
      clm_stale: entity('clm_stale', { stale: true, staleness: 'green' }), clm_current: entity('clm_current'), jrn_source: entity('jrn_source', { content: '原始实验记录' })
    }, terminal_sources: { clm_current: { source_entry_id: 'jrn_source', outcome: 'resolved', terminal: true } } };
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
  });
  const result = await new RkaClient({ url }).collect('prj_fixture', '实验结果会议', ['实验']);
  assert.equal(result.records[0].useAs, 'historical_or_unverified_background'); // stale wins even if green/current
  assert.equal(result.records[1].terminalSources.entity.record.content, '原始实验记录');
  assert.equal(result.records[1].revision.fingerprint, 'revision-clm_current');
  assert.equal(result.records[1].record.confidence, 0.6);
  assert.deepEqual(requests.filter(r => r.method === 'POST').map(r => [r.route, r.project]),
    [['/api/graph/report-context', 'prj_fixture'], ['/api/entities/resolve', 'prj_fixture']]);
  await assert.rejects(new RkaClient({ url }).collect('prj_notlisted', '实验讨论', []), /not in/);
});

test('RKA rejects non-loopback destinations, redirects, large responses, and total-deadline stalls', async t => {
  for (const url of ['https://127.0.0.1:9712', 'http://example.com', 'http://127.0.0.1/private', 'http://user:pass@127.0.0.1', 'http://127.0.0.1?x=1']) assert.throws(() => endpoint(url));
  assert.equal(endpoint('http://localhost:9712/api').host, '127.0.0.1');
  const redirect = await listen(t, (req, res) => { res.writeHead(302, { Location: 'http://example.com' }); res.end(); });
  await assert.rejects(new RkaClient({ url: redirect }).request('/health'), /302/);
  const large = await listen(t, (req, res) => res.end(JSON.stringify({ text: 'x'.repeat(200) })));
  await assert.rejects(new RkaClient({ url: large, maxBytes: 100 }).request('/health'), /exceeds/);
  const stalled = await listen(t, (req, res) => { res.writeHead(200); res.write('{'); });
  await assert.rejects(new RkaClient({ url: stalled, timeoutMs: 50 }).request('/health'), /timed out/);
  assert.throws(() => new RkaClient().request('/write'), /not available/);
});

test('RKA refuses foreign-project resolved records, including claim source dependencies', async t => {
  const url = await listen(t, (req, res) => {
    let value;
    if (req.url === '/api/health') value = { status: 'ok' };
    else if (req.url === '/api/projects') value = [{ id: 'prj_fixture', name: 'Fixture' }];
    else if (req.url === '/api/graph/report-context') value = { nodes: [{ id: 'clm_current' }] };
    else value = { schema_version: 'rka-entity-resolution/v1', project_id: 'prj_fixture', mode: 'read_only',
      entities: { clm_current: entity('clm_current'), jrn_foreign: { ...entity('jrn_foreign'), project_id: 'prj_other' } },
      terminal_sources: { clm_current: { source_entry_id: 'jrn_foreign', terminal: true } } };
    res.end(JSON.stringify(value));
  });
  await assert.rejects(new RkaClient({ url }).collect('prj_fixture', '讨论结果', []), /another project/);
});

test('context snapshots are durable; explicit selection, versions, disabling and failures preserve boundaries', async t => {
  const { archives, m } = fixture(t); let failing = false;
  const store = new RkaContextStore(archives, { collect: async () => { if (failing) throw new Error('offline'); return collectResult(); } });
  let state = configure(store, m.id), result = await store.refresh(m.id, state.connection.revision);
  assert.equal(store.packet(m.id).records.length, 0); // retrieved is not selected
  assert.equal(result.snapshot.capturedRelativeToMeeting, 'after_start');
  state = store.configure(m.id, { ...result.connection, selectedIds: ['clm_current', 'clm_old'] });
  const packet = store.packet(m.id); assert.equal(packet.records.length, 2);
  assert.equal(packet.records[0].sourceRef.entityId, 'clm_current'); assert.equal(packet.records[1].useAs, 'historical_or_unverified_background');
  assert.throws(() => store.configure(m.id, { ...state.connection, selectedIds: ['arbitrary-id'] }), /must come from/);
  assert.throws(() => store.configure(m.id, { ...state.connection, revision: 'old-revision' }), /have changed/);
  const before = fs.readFileSync(path.join(store.dir(m.id), 'rka', 'snapshots', `${result.snapshot.id}.json`), 'utf8');
  failing = true; await assert.rejects(store.refresh(m.id, state.connection.revision), /offline/);
  assert.equal(store.state(m.id).snapshot.id, result.snapshot.id); assert.equal(store.packet(m.id).lastRetrievalError.message, 'offline');
  assert.equal(fs.readFileSync(path.join(store.dir(m.id), 'rka', 'snapshots', `${result.snapshot.id}.json`), 'utf8'), before);
  state = store.configure(m.id, { ...store.connection(m.id), enabled: false }); assert.equal(store.packet(m.id).records.length, 0);
  assert.equal(state.snapshot.id, result.snapshot.id); assert.equal(state.connection.selectedIds.length, 2);
  const restarted = new RkaContextStore(archives); assert.equal(restarted.state(m.id).snapshot.id, result.snapshot.id);
  const snapshotFile = path.join(store.dir(m.id), 'rka', 'snapshots', `${result.snapshot.id}.json`);
  const modified = JSON.parse(before); modified.records[0].record.title = 'tampered'; fs.writeFileSync(snapshotFile, JSON.stringify(modified));
  assert.throws(() => restarted.state(m.id), /integrity check failed/);
});

test('late RKA responses cannot cross project changes or overwrite settings', async t => {
  const { archives, m } = fixture(t); let finish;
  const store = new RkaContextStore(archives, { collect: () => new Promise(resolve => { finish = resolve; }) });
  const state = configure(store, m.id), pending = store.refresh(m.id, state.connection.revision);
  await assert.rejects(store.refresh(m.id, state.connection.revision), /search is already running/);
  store.configure(m.id, { ...state.connection, projectId: 'prj_other' }); finish(collectResult());
  await assert.rejects(pending, /outdated response was discarded/); assert.equal(store.state(m.id).connection.projectId, 'prj_other');
  assert.equal(store.state(m.id).snapshot, null); assert.equal(store.state(m.id).connection.lastError, null);
});

test('authenticated HTTP project/context routes work while RKA is optional and offline', async t => {
  const { root, archives, m, m2 } = fixture(t);
  const runtime = createRecorderServer({ dataDir: root, store: archives, config: defaults, token: 'context-test',
    rkaClient: { projects: async () => { throw Object.assign(new Error('offline'), { statusCode: 502 }); }, collect: async () => collectResult() } });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const call = async (target, method = 'GET', value) => {
    const response = await fetch(`${base}${target}`, { method, headers: { Authorization: 'Bearer context-test', 'Content-Type': 'application/json' }, body: value ? JSON.stringify(value) : undefined });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  assert.equal((await fetch(`${base}/api/rka/projects`)).status, 401);
  assert.equal((await call('/api/status')).status, 200); assert.equal((await call('/api/rka/projects')).status, 502);
  const p = (await call('/api/projects', 'POST', { name: '汇总项目' })).data;
  for (const id of [m.id, m2.id]) assert.equal((await call(`/api/meetings/${id}/project`, 'PUT', { projectId: p.id })).status, 200);
  const c = (await call(`/api/meetings/${m.id}/rka-context`)).data.connection;
  const saved = await call(`/api/meetings/${m.id}/rka-context`, 'PUT', { ...c, enabled: true, projectId: 'prj_fixture', query: '实验讨论' });
  const retrieved = await call(`/api/meetings/${m.id}/rka-refresh`, 'POST', { revision: saved.data.connection.revision });
  assert.equal(retrieved.status, 200);
  await call(`/api/meetings/${m.id}/rka-context`, 'PUT', { ...retrieved.data.connection, selectedIds: ['clm_current'] });
  const rollup = await call(`/api/projects/${p.id}/analysis-context`);
  assert.equal(rollup.status, 200); assert.equal(rollup.data.meetings.length, 2);
  assert.match(rollup.headers.get('content-disposition'), /^attachment; filename="project-context-/);
  const meetingExport = await call(`/api/meetings/${m.id}/analysis-context`);
  assert.equal(meetingExport.status, 200);
  assert.match(meetingExport.headers.get('content-disposition'), /^attachment; filename="meeting-context-/);
  assert.equal(rollup.data.meetings[0].background.records.length, 1);
  assert.equal(rollup.data.meetings[1].background.records.length, 0);
  assert.equal(rollup.data.rollupStatus, 'not_implemented');
});
