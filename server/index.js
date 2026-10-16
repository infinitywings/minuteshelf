// Recorder, project archives, and explicitly started post-meeting analysis.
// Native capture is independent; no model work begins when this server starts.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ArchiveStore } = require('./archive-store');
const { SessionManager } = require('./archive-session');
const { load } = require('./archive-config');
const { ProjectStore } = require('./project-store');
const { RkaClient, RkaContextStore } = require('./rka-context');
const { MeetingArtifacts } = require('./meeting-artifacts');
const { MediaExports } = require('./media-export');
const { AnalysisManager } = require('./analysis-manager');
const { MeetingLifecycle } = require('./meeting-lifecycle');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}
function media(req, res, file, contentType) {
  const size = fs.statSync(file).size;
  let start = 0, end = size - 1, code = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) return json(res, 416, { error: 'Invalid range' });
    if (!range[1]) start = Math.max(0, size - Number(range[2]));
    else { start = Number(range[1]); end = range[2] ? Math.min(end, Number(range[2])) : end; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      res.setHeader('Content-Range', `bytes */${size}`); return json(res, 416, { error: 'Invalid range' });
    }
    code = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.writeHead(code, { 'Content-Type': contentType || (file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.m4a') ? 'audio/mp4' : 'audio/wav'),
    'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
function createRecorderServer(options = {}) {
  const dataDir = options.dataDir || process.env.MEETING_DATA || path.join(__dirname, '..', 'data');
  const config = options.config || load(dataDir);
  const store = options.store || new ArchiveStore(dataDir);
  const sessions = options.sessions || new SessionManager(store, config);
  const projects = options.projects || new ProjectStore(dataDir, store);
  const rka = options.rka || new RkaContextStore(store, options.rkaClient || new RkaClient());
  const artifacts = options.artifacts || new MeetingArtifacts(store, projects);
  const exports = options.exports || new MediaExports(store, artifacts);
  const openFolder = options.openFolder || (folder => promisify(execFile)('/usr/bin/open', [folder]));
  const analysis = options.analysis || new AnalysisManager({ store, artifacts, rka, dataDirectory: dataDir, exports, dependencies: options.analysisDependencies });
  const lifecycle = new MeetingLifecycle({ store, projects, sessions, analysis, exports, rka });
  sessions.beforeStart = async () => { exports.cancelForRecording(); await analysis.cancelForRecording(); };
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const cookie = crypto.randomBytes(32).toString('hex');
  const staticFiles = { '/': ['recorder.html', 'text/html'], '/recorder.js': ['recorder.js', 'text/javascript'], '/recorder.css': ['recorder.css', 'text/css'], '/analysis.js': ['analysis.js', 'text/javascript'],
    '/brand/meeting-archive-mark.png': ['brand/meeting-archive-mark.png', 'image/png'] };
  const server = http.createServer(async (req, res) => {
    let releaseMeeting;
    const port = server.address()?.port || config.server.port;
    const authorities = [`127.0.0.1:${port}`, `localhost:${port}`];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!authorities.includes(req.headers.host)) return json(res, 403, { error: 'Invalid Host' });
      if (req.headers.origin && !authorities.some(a => req.headers.origin === `http://${a}`)) return json(res, 403, { error: 'Invalid Origin' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request rejected' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const value = await body(req);
        if (!safeEqual(value.token, token)) return json(res, 401, { error: 'Invalid access token' });
        res.setHeader('Set-Cookie', `meeting_session=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        const bearer = req.headers.authorization?.replace(/^Bearer /, '');
        const sessionCookie = /(?:^|;\s*)meeting_session=([^;]*)/.exec(req.headers.cookie || '')?.[1];
        if (!safeEqual(bearer, token) && !safeEqual(sessionCookie, cookie)) return json(res, 401, { error: 'Connect using the local access link shown at startup.' });
        if (url.pathname === '/api/status' && req.method === 'GET') {
          const disk = fs.statfsSync(dataDir);
          return json(res, 200, { active: store.active(), archivePath: store.root,
            freeBytes: disk.bavail * disk.bsize, nativeBuilt: fs.existsSync(sessions.binary),
            liveInference: false, processingAvailable: true, mcpEnabled: false });
        }
        if (url.pathname === '/api/analysis/runtime-install' && req.method === 'GET') return json(res, 200, {
          installation: analysis.install?.state || null,
          busy: Boolean(analysis.worker || analysis.queue.length || analysis.install?.running || exports.active().length),
          recording: Boolean(store.active().length)
        });
        if (url.pathname === '/api/analysis/runtime-install' && req.method === 'POST') {
          await body(req);
          if (server.shuttingDown) return json(res, 503, { error: 'The app is quitting.' });
          return json(res, 202, analysis.installRuntime());
        }
        if (url.pathname === '/api/sources' && req.method === 'GET') return json(res, 200, await sessions.sources());
        if (url.pathname === '/api/permissions' && req.method === 'GET') return json(res, 200, await sessions.permissions());
        if (url.pathname === '/api/permissions/request' && req.method === 'POST') return json(res, 200, await sessions.requestPermissions(await body(req)));
        if (url.pathname === '/api/permissions/settings' && req.method === 'POST') return json(res, 200, await sessions.openPermissionSettings((await body(req)).permission));
        if (url.pathname === '/api/preview' && req.method === 'POST') return json(res, 200, await sessions.preview(await body(req)));
        if (url.pathname === '/api/record/start' && req.method === 'POST') {
          const input = await body(req);
          // Recheck after reading the body: a desktop quit can begin while a
          // slow request is arriving. Never spawn a recorder after shutdown.
          if (server.shuttingDown) return json(res, 503, { error: 'The app is quitting. Reopen it before starting a recording.' });
          return json(res, 201, await sessions.start(input));
        }
        if (url.pathname === '/api/meetings' && req.method === 'GET') return json(res, 200, store.list().map(m => m.archiveError
          ? { ...m, projectId: projects.read().meetingProjects[m.id] || null, notesPreview: m.archiveError.message }
          : { ...m, projectId: projects.assignment(m.id), notesPreview: store.meeting(m.id).notes.slice(0, 1000) }));
        if (url.pathname === '/api/trash' && req.method === 'GET') return json(res, 200, lifecycle.list());
        const restoreMatch = /^\/api\/trash\/([a-z0-9-]{1,100})\/restore$/.exec(url.pathname);
        if (restoreMatch && req.method === 'POST') { await body(req); return json(res, 200, lifecycle.restore(restoreMatch[1])); }
        if (url.pathname === '/api/rka/projects' && req.method === 'GET') return json(res, 200, await rka.client.projects());
        if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, projects.list());
        if (url.pathname === '/api/projects' && req.method === 'POST') return json(res, 201, projects.create(await body(req)));
        const projectMatch = /^\/api\/projects\/([a-f0-9-]{36})(?:\/(analysis-context))?$/.exec(url.pathname);
        if (projectMatch) {
          const [, id, action] = projectMatch;
          if (!action && req.method === 'GET') return json(res, 200, projects.overview(id));
          if (!action && req.method === 'PUT') return json(res, 200, projects.update(id, await body(req)));
          if (action && req.method === 'GET') {
            const overview = projects.overview(id);
            res.setHeader('Content-Disposition', `attachment; filename="project-context-${id}.json"`);
            return json(res, 200, { schemaVersion: 'project-analysis-context-1', ...overview,
              generatedAt: new Date().toISOString(),
              interpretationRules: ['Cite each meeting separately by time, preserving its meeting and evidence IDs.', 'Distinguish historical decisions, later revisions, and open questions.',
                'A later mention does not automatically replace an earlier decision; completion requires explicit evidence.', 'User notes and RKA background must not be presented as verbatim meeting quotes.'],
              meetings: overview.meetings.map(m => {
                if (m.archiveError) return { ...m, background: null, backgroundMatchesProjectRka: null };
                const background = { ...rka.packet(m.id), documents: artifacts.documentPacket(m.id) };
                return { ...m, background, backgroundMatchesProjectRka: overview.project.rkaProjectId && background.projectId
                  ? overview.project.rkaProjectId === background.projectId : null };
              }) });
          }
        }
        const match = /^\/api\/meetings\/([a-z0-9-]{1,100})(?:\/([a-z-]+)(?:\/([^/]+))?)?$/.exec(url.pathname);
        if (match) {
          const [, id, action, file] = match;
          // Reserve the archive across asynchronous bodies/uploads and native
          // recovery/control operations. A concurrent delete cannot move it
          // while any request is still writing into its original location.
          if (!['GET', 'HEAD'].includes(req.method) && !['rename', 'trash'].includes(action)) {
            releaseMeeting = lifecycle.begin(id);
          }
          if (action === 'rename' && req.method === 'POST') return json(res, 200, lifecycle.rename(id, (await body(req)).title));
          if (action === 'trash' && req.method === 'POST') { await body(req); return json(res, 200, lifecycle.trash(id)); }
          if (!action && req.method === 'GET') return json(res, 200, { ...store.meeting(id), projectId: projects.assignment(id) });
          if (action === 'playback' && req.method === 'GET') return json(res, 200, exports.playback(id));
          if (action === 'playback' && req.method === 'POST') {
            await body(req);
            if (server.shuttingDown) return json(res, 503, { error: 'The app is quitting.' });
            if (analysis.worker || analysis.install?.running) return json(res, 200, { status: 'blocked', error: 'Pause analysis before preparing playback.' });
            return json(res, 200, exports.playback(id, { create: true }));
          }
          if (action === 'analysis' && req.method === 'GET') return json(res, 200, file ? analysis.result(id, file) : analysis.state(id));
          if (action === 'analysis-preview' && req.method === 'POST') return json(res, 200, analysis.preview(id, await body(req)));
          if (action === 'analysis' && req.method === 'POST') { if (server.shuttingDown) return json(res, 503, { error: 'The app is quitting.' }); return json(res, 202, analysis.start(id, await body(req))); }
          if (action === 'analysis-pause' && req.method === 'POST') return json(res, 200, await analysis.cancel(id, (await body(req)).runId));
          if (action === 'project' && req.method === 'PUT') return json(res, 200, projects.assign(id, (await body(req)).projectId));
          if (action === 'rka-context' && req.method === 'GET') return json(res, 200, rka.state(id));
          if (action === 'rka-context' && req.method === 'PUT') return json(res, 200, rka.configure(id, await body(req)));
          if (action === 'rka-refresh' && req.method === 'POST') return json(res, 200, await rka.refresh(id, (await body(req)).revision));
          if (action === 'analysis-context' && req.method === 'GET') {
            res.setHeader('Content-Disposition', `attachment; filename="meeting-context-${id}.json"`);
            return json(res, 200, { ...rka.packet(id), documents: artifacts.documentPacket(id) });
          }
          if (action === 'artifacts' && req.method === 'GET') return json(res, 200, { ...artifacts.inventory(id), exports: exports.jobs(id) });
          if (action === 'exports' && req.method === 'GET') return json(res, 200, exports.jobs(id));
          if (action === 'documents' && req.method === 'POST') {
            const name = decodeURIComponent(req.headers['x-file-name'] || '');
            const size = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length']);
            return json(res, 201, await artifacts.importDocument(id, name, req, size));
          }
          if (action === 'open-folder' && req.method === 'POST') { const folder = artifacts.ensure(id); await openFolder(folder); return json(res, 200, { folder }); }
          if (action === 'export-media' && req.method === 'POST') { if (analysis.worker || analysis.install?.running) return json(res, 409, { error: 'Pause analysis before exporting media.' }); const options = await body(req); return json(res, 202, exports.start(id, { audioSources: options.audioSources })); }
          if (action === 'artifact' && ['GET', 'HEAD'].includes(req.method)) {
            const requested = url.searchParams.get('path'), target = artifacts.file(id, requested);
            const inline = url.searchParams.get('inline') === '1' && /\.(mp4|m4a|jpg|jpeg|png)$/.test(target);
            if (!inline) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`);
            const imageType = /\.png$/i.test(target) ? 'image/png' : /\.jpe?g$/i.test(target) ? 'image/jpeg' : undefined;
            return media(req, res, target, inline ? imageType : 'application/octet-stream');
          }
          if (action === 'media' && ['GET', 'HEAD'].includes(req.method)) return media(req, res, store.media(id, file));
          if (action === 'index' && req.method === 'GET') {
            const manifest = store.refresh(id);
            const segment = [...manifest.segments, ...(manifest.recovered || [])].find(s => s.file === file);
            if (!segment || !/^(microphone|system)-\d{6}\.pts\.jsonl$/.test(segment.index || '')) return json(res, 404, { error: 'Audio PTS index not found' });
            const { jsonLines } = require('./archive-store');
            return json(res, 200, jsonLines(path.join(store.raw(id), segment.index)));
          }
          if (action === 'notes' && req.method === 'PUT') { store.notes(id, String((await body(req)).notes || '')); return json(res, 200, { ok: true }); }
          if (action === 'stop' && req.method === 'POST') return json(res, 200, await sessions.stop(id));
          if (['pause', 'resume', 'mic', 'bookmark'].includes(action) && req.method === 'POST') return json(res, 200, await sessions.command(id, action, await body(req)));
          if (action === 'recover' && req.method === 'POST') return json(res, 200, await sessions.recover(id));
          if (action === 'manifest' && req.method === 'GET') {
            res.setHeader('Content-Disposition', 'attachment; filename="manifest.json"'); return json(res, 200, store.refresh(id));
          }
        }
        return json(res, 404, { error: 'API unavailable in Recorder v1' });
      }
      if (req.method !== 'GET' || !staticFiles[url.pathname]) return json(res, 404, { error: 'Not found' });
      const [name, type] = staticFiles[url.pathname];
      res.writeHead(200, { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, '..', 'web', name)));
    } catch (error) { if (!res.headersSent) json(res, error.statusCode || 400, { error: error.message }); else res.destroy(); }
    finally { releaseMeeting?.(); }
  });
  return { server, store, sessions, projects, rka, artifacts, exports, analysis, lifecycle, token, config };
}
if (require.main === module) {
  const runtime = createRecorderServer();
  runtime.server.listen(runtime.config.server.port, '127.0.0.1', () => {
    console.log(`MinuteShelf: http://127.0.0.1:${runtime.config.server.port}/#token=${runtime.token}`);
    console.log(`MinuteShelf archive: ${runtime.store.root}`);
    console.log('Closing Node does not stop an active native recording. Use the macOS menu bar to stop it.');
  });
  runtime.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createRecorderServer, safeEqual, media };
