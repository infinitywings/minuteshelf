const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, readJSON } = require('./archive-store');

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const validID = id => typeof id === 'string' && /^[a-z0-9-]{1,100}$/.test(id);
function title(value) {
  if (typeof value !== 'string') throw fail('Enter a meeting name.');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 300 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw fail('Use a meeting name of 1–300 characters without line breaks or control characters.');
  return name;
}

// Recently Deleted is an app-managed sibling of meetings, on the same volume.
// A directory rename moves every artifact atomically; no original is rewritten.
// Project membership remains in projects.json and becomes visible on restore.
class MeetingLifecycle {
  constructor({ store, projects, sessions, analysis, exports, rka }) {
    Object.assign(this, { store, projects, sessions, analysis, exports, rka });
    this.root = path.join(path.dirname(store.root), 'trash');
    this.operations = new Map();
  }
  safeDirectory(directory) {
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') throw fail('Meeting not found.', 404); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('The meeting directory is not a regular local archive.', 409);
    return directory;
  }
  trashRoot() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    return this.safeDirectory(this.root);
  }
  trashDirectory(id) {
    if (!validID(id)) throw fail('Invalid meeting ID.');
    return path.join(this.trashRoot(), id);
  }
  begin(id) {
    this.safeDirectory(this.store.dir(id));
    this.operations.set(id, (this.operations.get(id) || 0) + 1);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const count = this.operations.get(id) - 1;
      if (count) this.operations.set(id, count); else this.operations.delete(id);
    };
  }
  assertIdle(id) {
    if (this.store.active().some(m => m.id === id)) throw fail('Stop and save this recording before renaming or deleting it.', 409);
    if (this.operations.has(id)) throw fail('Wait for this meeting’s current operation to finish, then try again.', 409);
    if (this.analysis?.worker?.job?.meetingId === id || this.analysis?.queue?.some(work => work.job.meetingId === id)) throw fail('Pause this meeting’s analysis before renaming or deleting it.', 409);
    if (this.exports?.inFlight?.has(id) || this.exports?.active?.().some(job => job.meetingId === id)) throw fail('Wait for this meeting’s media export to finish.', 409);
    if (this.rka?.busy?.has(id)) throw fail('Wait for this meeting’s context retrieval to finish.', 409);
  }
  rename(id, value) {
    const name = title(value);
    this.safeDirectory(this.store.dir(id)); this.assertIdle(id);
    const manifest = this.store.manifest(id);
    this.store.save({ ...manifest, title: name });
    // README and artifact inventory are regenerated from the manifest on access.
    return { id, title: name };
  }
  record(id) {
    const directory = this.safeDirectory(this.trashDirectory(id));
    const manifest = readJSON(path.join(directory, 'manifest.json'));
    const saved = readJSON(path.join(this.root, `${id}.json`));
    const deletedAt = saved?.id === id && typeof saved.deletedAt === 'string' ? saved.deletedAt : fs.statSync(directory).mtime.toISOString();
    return { id, title: typeof manifest?.title === 'string' ? manifest.title : saved?.title || 'Unavailable meeting',
      createdAt: manifest?.createdAt || saved?.createdAt || deletedAt, deletedAt, trashedAt: deletedAt,
      projectId: this.projects.read().meetingProjects[id] || null, restorable: true };
  }
  list() {
    const root = this.trashRoot();
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => validID(entry.name) && entry.isDirectory())
      .map(entry => this.record(entry.name)).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  trash(id) {
    const source = this.safeDirectory(this.store.dir(id)); this.assertIdle(id);
    const destination = this.trashDirectory(id);
    if (fs.existsSync(destination)) throw fail('This meeting already has a copy in Recently Deleted. Restore it before trying again.', 409);
    let manifest;
    try { manifest = this.store.manifest(id); }
    catch (error) {
      if (!['MANIFEST_INVALID', 'MANIFEST_MISSING'].includes(error.code)) throw error;
      manifest = { title: 'Unavailable meeting', createdAt: fs.statSync(source).mtime.toISOString() };
    }
    const deletedAt = new Date().toISOString();
    // Commit metadata before moving. An interrupted move leaves the source in
    // meetings; list() only includes real archive directories in trash.
    atomicWrite(path.join(this.root, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, title: manifest.title,
      createdAt: manifest.createdAt, deletedAt }, null, 2));
    fs.renameSync(source, destination);
    return this.record(id);
  }
  restore(id) {
    const source = this.safeDirectory(this.trashDirectory(id)), record = this.record(id);
    const destination = this.store.dir(id);
    if (fs.existsSync(destination)) throw fail('A meeting with this ID already exists. No files were replaced.', 409);
    fs.renameSync(source, destination);
    // Sidecar can safely remain after a crash: the directory is authoritative.
    try { fs.unlinkSync(path.join(this.root, `${id}.json`)); } catch (error) { if (error.code !== 'ENOENT') { /* restored archive remains usable */ } }
    return { id, title: record.title };
  }
}
module.exports = { MeetingLifecycle, title };
