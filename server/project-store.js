const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, readJSON } = require('./archive-store');

function projectID(value) {
  if (typeof value !== 'string' || !/^(?:prj_[A-Za-z0-9]{1,64}|proj_default)$/.test(value)) throw new Error('Invalid RKA project_id.');
  return value;
}
function textField(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label} has an invalid format or length.`);
  return value.trim();
}
class ProjectStore {
  constructor(dataDir, archives) { this.file = path.join(dataDir, 'projects.json'); this.archives = archives; }
  read() {
    if (!fs.existsSync(this.file)) return { schemaVersion: 1, projects: [], meetingProjects: {} };
    const value = readJSON(this.file);
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.projects) || !value.meetingProjects
      || typeof value.meetingProjects !== 'object' || Array.isArray(value.meetingProjects)) throw new Error('The project list is damaged. Preserve the file and restore a backup.');
    return value;
  }
  write(value) { atomicWrite(this.file, JSON.stringify(value, null, 2)); }
  get(id) {
    const value = this.read().projects.find(p => p.id === id);
    if (!value) throw Object.assign(new Error('Project not found.'), { statusCode: 404 });
    return value;
  }
  fields(input, previous = {}) {
    const name = textField(input.name ?? previous.name ?? '', 200, 'Project name');
    if (!name) throw new Error('Enter a project name.');
    const description = textField(input.description ?? previous.description ?? '', 4000, 'Project description');
    const rkaProjectId = input.rkaProjectId === undefined ? (previous.rkaProjectId || null) : (input.rkaProjectId ? projectID(input.rkaProjectId) : null);
    return { name, description, rkaProjectId };
  }
  create(input) {
    const data = this.read(), now = new Date().toISOString();
    const project = { ...this.fields(input), id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    data.projects.push(project); this.write(data); return project;
  }
  update(id, input) {
    const data = this.read(), index = data.projects.findIndex(p => p.id === id);
    const previous = this.get(id);
    data.projects[index] = { ...previous, ...this.fields(input, previous), updatedAt: new Date().toISOString() };
    this.write(data); return data.projects[index];
  }
  assignment(meetingId) { this.archives.manifest(meetingId); return this.read().meetingProjects[meetingId] || null; }
  assign(meetingId, id) {
    this.archives.manifest(meetingId);
    if (id !== null) this.get(id);
    const data = this.read();
    if (id) data.meetingProjects[meetingId] = id; else delete data.meetingProjects[meetingId];
    this.write(data);
    atomicWrite(path.join(this.archives.dir(meetingId), 'project.json'), JSON.stringify({ meetingId, project: id ? this.get(id) : null }, null, 2));
    return { projectId: id };
  }
  list() {
    const data = this.read(), visible = new Set(this.archives.ids());
    return data.projects.map(p => ({ ...p, meetingCount: Object.entries(data.meetingProjects).filter(([meetingId, id]) => id === p.id && visible.has(meetingId)).length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  overview(id) {
    const project = this.get(id), data = this.read(), visible = new Set(this.archives.ids());
    // Keep membership for recoverable deleted archives, without counting or
    // displaying them until their original directory is restored.
    const meetings = Object.entries(data.meetingProjects).filter(([meetingId, p]) => p === id && visible.has(meetingId)).map(([meetingId]) => {
      let m;
      try { m = this.archives.manifest(meetingId); }
      catch (error) {
        if (!['MANIFEST_INVALID', 'MANIFEST_MISSING'].includes(error.code)) throw error;
        return { ...this.archives.unavailable(meetingId, error), notes: '', noteRef: null, durationSeconds: 0 };
      }
      const notes = fs.readFileSync(path.join(this.archives.dir(meetingId), 'user_notes.md'), 'utf8');
      return { id: m.id, title: m.title, createdAt: m.createdAt, status: m.status, durationSeconds: m.durationSeconds || 0,
        notes, noteRef: { id: `meeting:${m.id}:user-notes`, kind: 'user_note', meetingId: m.id,
          sha256: crypto.createHash('sha256').update(notes).digest('hex') } };
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { project, meetings, meetingCount: meetings.length,
      durationSeconds: meetings.reduce((n, m) => n + m.durationSeconds, 0),
      rollupStatus: 'not_implemented' };
  }
}
module.exports = { ProjectStore, projectID, textField };
