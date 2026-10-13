const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { ArchiveStore } = require('../server/archive-store');
const { ProjectStore } = require('../server/project-store');
const { MeetingLifecycle } = require('../server/meeting-lifecycle');
const { createRecorderServer } = require('../server/index');
const { defaults } = require('../server/archive-config');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-lifecycle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArchiveStore(root), projects = new ProjectStore(root, store);
  const meeting = store.create({ microphone: false, systemAudio: false }, defaults.recording, 'Original meeting');
  meeting.status = 'recorded'; store.save(meeting);
  fs.writeFileSync(path.join(store.raw(meeting.id), 'capture_events.jsonl'), JSON.stringify({ event: 'stopped', clean: true }) + '\n');
  for (const [file, content] of Object.entries({ 'raw/video-000001.mp4': 'raw-video', 'raw/microphone-000001.wav': 'raw-audio',
    'context/documents/example.txt': 'private context', 'outputs/summary.md': 'generated note', 'exports/meeting.mp4': 'combined-video', 'user_notes.md': 'user notes' })) {
    fs.mkdirSync(path.dirname(path.join(store.dir(meeting.id), file)), { recursive: true });
    fs.writeFileSync(path.join(store.dir(meeting.id), file), content);
  }
  const analysis = { worker: null, queue: [] }, exports = { inFlight: new Set(), active: () => [] }, rka = { busy: new Set() };
  const lifecycle = new MeetingLifecycle({ store, projects, analysis, exports, rka });
  return { root, store, projects, meeting, analysis, exports, rka, lifecycle };
}
function hashes(root) {
  const output = {};
  for (const name of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, name);
    if (fs.statSync(file).isFile()) output[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return output;
}
async function server(t, f, options = {}) {
  const runtime = createRecorderServer({ dataDir: f.root, store: f.store, projects: f.projects, config: defaults, token: 'lifecycle-test', ...options });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const request = (route, value, headers = {}) => fetch(base + route, { method: value === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer lifecycle-test', 'Content-Type': 'application/json', ...headers },
    body: value === undefined ? undefined : JSON.stringify(value) });
  return { runtime, base, request };
}

test('rename validates Unicode names and changes only the manifest title', t => {
  const { lifecycle, store, meeting } = fixture(t), before = hashes(store.dir(meeting.id));
  assert.deepEqual(lifecycle.rename(meeting.id, '  研发会议 – Q3  '), { id: meeting.id, title: '研发会议 – Q3' });
  assert.equal(store.manifest(meeting.id).title, '研发会议 – Q3');
  const after = hashes(store.dir(meeting.id));
  for (const name of Object.keys(before)) if (name !== 'manifest.json') assert.equal(after[name], before[name]);
  for (const invalid of ['', ' ', null, 4, 'a\nb', 'a\tb', 'a\0b', '🙂'.repeat(301)]) assert.throws(() => lifecycle.rename(meeting.id, invalid));
  lifecycle.rename(meeting.id, '🙂'.repeat(300));
  assert.equal([...store.manifest(meeting.id).title].length, 300);
});

test('trash and restore preserve all artifacts byte-for-byte and original project membership across restart', t => {
  const { root, lifecycle, store, projects, meeting } = fixture(t);
  const project = projects.create({ name: 'Shared research project' }); projects.assign(meeting.id, project.id);
  const before = hashes(store.dir(meeting.id)), projectBefore = fs.readFileSync(projects.file, 'utf8');
  const removed = lifecycle.trash(meeting.id);
  assert.equal(removed.id, meeting.id); assert.equal(removed.title, meeting.title); assert.equal(removed.restorable, true);
  assert.equal(store.ids().includes(meeting.id), false); assert.equal(projects.list()[0].meetingCount, 0);
  assert.equal(projects.overview(project.id).meetings.length, 0); assert.equal(fs.readFileSync(projects.file, 'utf8'), projectBefore);
  assert.deepEqual(hashes(path.join(root, 'trash', meeting.id)), before);
  const restarted = new MeetingLifecycle({ store: new ArchiveStore(root), projects: new ProjectStore(root, store) });
  assert.equal(restarted.list()[0].projectId, project.id);
  assert.deepEqual(restarted.restore(meeting.id), { id: meeting.id, title: meeting.title });
  assert.deepEqual(restarted.list(), []); assert.equal(projects.overview(project.id).meetings[0].id, meeting.id);
  assert.equal(projects.list()[0].meetingCount, 1); assert.deepEqual(hashes(store.dir(meeting.id)), before);
});

test('active capture, queued analysis, exporting, context reads and in-progress requests block lifecycle changes', t => {
  const { lifecycle, store, meeting, analysis, exports, rka } = fixture(t), id = meeting.id;
  const blocked = () => { assert.throws(() => lifecycle.trash(id), { statusCode: 409 }); assert.throws(() => lifecycle.rename(id, 'Renamed'), { statusCode: 409 }); };
  const status = path.join(store.raw(id), 'capture-status.json');
  fs.writeFileSync(status, JSON.stringify({ pid: process.pid, state: 'recording', updatedAt: new Date().toISOString() })); blocked(); fs.unlinkSync(status);
  analysis.worker = { job: { meetingId: id } }; blocked(); analysis.worker = null;
  analysis.queue.push({ job: { meetingId: id } }); blocked(); analysis.queue.length = 0;
  exports.inFlight.add(id); blocked(); exports.inFlight.clear();
  exports.active = () => [{ meetingId: id }]; blocked(); exports.active = () => [];
  rka.busy.add(id); blocked(); rka.busy.clear();
  const first = lifecycle.begin(id), second = lifecycle.begin(id); blocked(); first(); first(); blocked(); second();
  lifecycle.trash(id); assert.equal(lifecycle.list().length, 1);
});

test('trash never overwrites an existing archive, follows a symlink, or accepts traversal', t => {
  const { lifecycle, store, meeting, root } = fixture(t), original = hashes(store.dir(meeting.id));
  for (const invalid of ['../elsewhere', '/tmp/test', 'a/b']) assert.throws(() => lifecycle.trash(invalid));
  const linked = path.join(root, 'meetings', 'linked'); fs.symlinkSync(store.dir(meeting.id), linked);
  assert.throws(() => lifecycle.trash('linked'), /regular local archive/); assert.deepEqual(hashes(store.dir(meeting.id)), original);
  fs.unlinkSync(linked); lifecycle.trash(meeting.id); fs.mkdirSync(store.dir(meeting.id));
  assert.throws(() => lifecycle.restore(meeting.id), { statusCode: 409 });
  assert.deepEqual(hashes(path.join(root, 'trash', meeting.id)), original);
});

test('a failed move leaves the live archive intact and does not create a phantom deleted meeting', t => {
  const { lifecycle, store, meeting } = fixture(t), source = store.dir(meeting.id), before = hashes(source), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (from === source) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); return rename(from, to); });
  assert.throws(() => lifecycle.trash(meeting.id), /disk failure/);
  assert.deepEqual(lifecycle.list(), []); assert.deepEqual(hashes(source), before);
});

test('a damaged stopped archive can be moved and restored without rewriting its damaged manifest', t => {
  const { lifecycle, store, meeting } = fixture(t), file = path.join(store.dir(meeting.id), 'manifest.json');
  fs.writeFileSync(file, '{damaged'); const before = hashes(store.dir(meeting.id));
  lifecycle.trash(meeting.id); assert.equal(lifecycle.list()[0].title, 'Unavailable meeting');
  lifecycle.restore(meeting.id); assert.deepEqual(hashes(store.dir(meeting.id)), before);
});

test('lifecycle routes enforce authentication and origin policy, then support rename/trash/restore', async t => {
  const f = fixture(t), { request } = await server(t, f), route = `/api/meetings/${f.meeting.id}`;
  assert.equal((await request(route + '/rename', { title: 'No' }, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(route + '/trash', {}, { Origin: 'https://other.example' })).status, 403);
  assert.equal(f.store.manifest(f.meeting.id).title, f.meeting.title);
  assert.equal((await request(route + '/rename', { title: 'Renamed via API' })).status, 200);
  assert.equal((await request(route + '/trash', {})).status, 200);
  const list = await (await request('/api/trash')).json(); assert.equal(list[0].title, 'Renamed via API');
  assert.equal((await request(route)).status, 404);
  assert.equal((await request(`/api/trash/${f.meeting.id}/restore`, {})).status, 200);
  assert.equal((await request(route)).status, 200);
});

test('a slow document upload reserves the archive before body completion', async t => {
  const f = fixture(t), { runtime, base, request } = await server(t, f), id = f.meeting.id;
  const upload = http.request(`${base}/api/meetings/${id}/documents`, { method: 'POST', headers: { Authorization: 'Bearer lifecycle-test', 'X-File-Name': 'fixture.txt', 'Content-Length': '12' } });
  const done = new Promise((resolve, reject) => { upload.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); upload.on('error', reject); });
  upload.write('first');
  for (let attempt = 0; attempt < 100 && !runtime.lifecycle.operations.has(id); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.lifecycle.operations.has(id), true);
  assert.equal((await request(`/api/meetings/${id}/trash`, {})).status, 409);
  assert.equal((await request(`/api/meetings/${id}/rename`, { title: 'Too early' })).status, 409);
  upload.end(' second'); assert.equal(await done, 201);
  assert.equal((await request(`/api/meetings/${id}/trash`, {})).status, 200);
  assert.equal(runtime.lifecycle.operations.size, 0);
});
