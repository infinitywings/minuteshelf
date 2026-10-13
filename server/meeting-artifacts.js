const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, readJSON } = require('./archive-store');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function relativeFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative)
    || relative.split('/').some(p => !p || p === '.' || p === '..')) throw fail('Invalid archive path.');
  const file = path.resolve(root, relative), realRoot = fs.realpathSync(root);
  // Every ancestor is checked, including the final file: imported files are
  // copies, and archive links must never follow symlinks outside the meeting.
  if (!fs.realpathSync(file).startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) throw fail('The file is missing or outside this meeting archive.', 404);
  return file;
}
function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 500) throw fail('Provide a document filename.');
  const result = name.normalize('NFC').replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_').slice(0, 180);
  return result || 'document';
}
class MeetingArtifacts {
  constructor(archives, projects, { maxDocumentBytes = 100 * 1024 * 1024 } = {}) {
    this.archives = archives; this.projects = projects; this.maxDocumentBytes = maxDocumentBytes;
  }
  ensure(id) {
    const root = this.archives.dir(id), m = this.archives.manifest(id);
    for (const directory of ['context/documents', 'outputs', 'exports']) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
    const projectId = this.projects?.assignment(id), project = projectId ? this.projects.get(projectId) : null;
    atomicWrite(path.join(root, 'project.json'), JSON.stringify({ meetingId: id, project }, null, 2));
    const text = `# ${m.title.replace(/[\r\n]/g, ' ')}\n\nMeeting ID: ${id}\nRecording started (UTC): ${m.createdAt}\n${project ? `Project: ${project.name}\n` : ''}\n`
      + 'This folder contains the local artifacts for this meeting.\n\n'
      + '- raw/: Original video, separate audio sources, PTS indexes, and capture events.\n'
      + '- exports/<export-id>/meeting.mp4: Video with audio; recording.m4a: Audio export (depending on the recorded sources).\n'
      + '- context/documents/: Imported document copies and provenance/hash metadata; source files are not moved.\n'
      + '- context/rka/: RKA background snapshots, separate from meeting evidence.\n'
      + '- user_notes.md: Your notes.\n'
      + '- outputs/<run-id>/: Transcripts, summaries, selected frames, evidence, and resumable analysis jobs.\n'
      + '- artifacts.json: Relative paths to accessible files.\n'
      + '- manifest.json / project.json: Recording manifest and current project snapshot.\n\n'
      + 'Exports preserve the meeting timeline and its gaps. Separate original sources are retained. The export plan records gaps; the report records audio tracks and mixing gains.\n';
    atomicWrite(path.join(root, 'README.md'), text);
    return root;
  }
  documents(id) {
    const directory = path.join(this.archives.dir(id), 'context', 'documents'); this.archives.manifest(id);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => {
      const value = readJSON(path.join(directory, f));
      if (!value || value.meetingId !== id || !/^[a-f0-9-]{36}$/.test(value.id)) throw fail('Document provenance metadata is damaged.');
      relativeFile(this.archives.dir(id), value.path); return value;
    }).sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  }
  async importDocument(id, name, stream, declaredBytes) {
    this.ensure(id);
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > this.maxDocumentBytes)) throw fail('Invalid document size. Each file must be at most 100 MiB.', 413);
    const originalName = safeName(name), documentId = crypto.randomUUID();
    const relative = `context/documents/${documentId}-${originalName}`;
    const file = path.join(this.archives.dir(id), relative), temporary = `${file}.partial`;
    const handle = await fs.promises.open(temporary, 'wx', 0o600), digest = crypto.createHash('sha256'); let bytes = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > this.maxDocumentBytes) throw fail('The document exceeds the size limit.', 413);
        digest.update(buffer);
        // FileHandle.write can write only part of a buffer.
        for (let offset = 0; offset < buffer.length;) { const result = await handle.write(buffer, offset, buffer.length - offset); offset += result.bytesWritten; }
      }
      if (!bytes || declaredBytes !== undefined && bytes !== declaredBytes) throw fail('The document is empty or the upload is incomplete.');
      await handle.sync(); await handle.close(); fs.renameSync(temporary, file);
      const document = { schemaVersion: 'meeting-document-1', id: documentId, meetingId: id, name: originalName,
        path: relative, bytes, sha256: digest.digest('hex'), importedAt: new Date().toISOString(),
        role: 'user_provided_background', extractionStatus: 'not_implemented' };
      atomicWrite(path.join(path.dirname(file), `${documentId}.json`), JSON.stringify(document, null, 2));
      this.inventory(id); return document;
    } catch (error) {
      await handle.close().catch(() => {});
      fs.rmSync(temporary, { force: true }); // Only the incomplete file created by this request.
      throw error;
    }
  }
  documentPacket(id) {
    return this.documents(id).map(d => ({ ...d, sourceRef: { id: `document:${d.id}`, kind: 'document_background',
      meetingId: id, path: d.path, sha256: d.sha256, importedAt: d.importedAt } }));
  }
  inventory(id) {
    const root = this.ensure(id), entries = [];
    const walk = (directory, prefix = '') => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const relative = prefix + item.name;
        if (item.isDirectory()) { if (relative !== 'raw/control') walk(path.join(directory, item.name), relative + '/'); continue; }
        if (!item.isFile() || relative === 'artifacts.json' || /(?:\.partial(?:\.|$)|\.tmp-|\.lock$)/.test(relative)) continue;
        const stat = fs.statSync(path.join(directory, item.name));
        const kind = relative.startsWith('raw/') ? 'original' : relative.startsWith('context/') ? 'background'
          : relative.startsWith('outputs/') ? 'generated' : relative.startsWith('exports/') ? 'export' : 'metadata';
        entries.push({ path: relative, bytes: stat.size, kind });
      }
    };
    walk(root); entries.sort((a, b) => a.path.localeCompare(b.path));
    const result = { schemaVersion: 'meeting-artifacts-1', meetingId: id, folder: root,
      updatedAt: new Date().toISOString(), documents: this.documents(id), entries,
      generatedContentAvailable: entries.some(e => e.kind === 'generated') };
    // The portable on-disk index uses relative paths only.
    const { folder, ...portable } = result; atomicWrite(path.join(root, 'artifacts.json'), JSON.stringify(portable, null, 2));
    return result;
  }
  file(id, relative) {
    const inventory = this.inventory(id);
    if (!inventory.entries.some(e => e.path === relative)) throw fail('The archive file is not committed or registered.', 404);
    return relativeFile(this.archives.dir(id), relative);
  }
}
module.exports = { MeetingArtifacts, relativeFile, safeName };
