#!/usr/bin/env node
// Explicit bookmark only, using the installed recorder's existing file IPC.
// Does not start capture, change sources, activate windows or request access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cases } from './collect-capture-test.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safe(root, relative, directory = false) {
  const file = path.join(root, relative), real = fs.realpathSync(file), stat = fs.lstatSync(file);
  if (real !== file || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe recorder IPC path');
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('Recorder IPC belongs to another user');
  return file;
}
function state(root) {
  const file = safe(root, 'raw/capture-status.json');
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid recorder status');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function findBookmark(root, id) {
  const lines = readline.createInterface({ input: fs.createReadStream(safe(root, 'raw/capture_events.jsonl')), crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event === 'bookmark' && event.id === id && typeof event.pts?.seconds === 'number' && Number.isFinite(event.pts.seconds)) {
      return event.pts.seconds;
    }
  }
  return null;
}
export async function markCaptureTest(archive, caseID, action, edge, { timeoutMs = 6500 } = {}) {
  if (!Object.hasOwn(cases, caseID) || !cases[caseID].includes(action) || !['before', 'after'].includes(edge)) {
    throw new Error('Choose a defined test case, its action and before/after edge');
  }
  const root = fs.realpathSync(archive), status = state(root);
  const updated = Date.parse(status.updatedAt);
  if (status.state !== 'recording' || !Number.isSafeInteger(status.pid) || status.pid <= 0
    || !Number.isFinite(updated) || Math.abs(Date.now() - updated) > 5000) {
    throw new Error('Recorder must be actively recording with a fresh status');
  }
  const inbox = safe(root, 'raw/control/inbox', true), results = safe(root, 'raw/control/results', true);
  const id = crypto.randomUUID(), name = `${Date.now()}-${id}.json`;
  const text = `TEST:${caseID}:${action}:${edge}`, request = path.join(inbox, name);
  const temporary = path.join(inbox, `.bookmark-${id}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ command: 'bookmark', id, text }), { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, request);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  const responsePath = path.join(results, name), until = Date.now() + timeoutMs;
  let acknowledged = false;
  while (Date.now() < until) {
    if (!acknowledged && fs.existsSync(responsePath)) {
      const response = JSON.parse(fs.readFileSync(safe(root, `raw/control/results/${name}`), 'utf8'));
      if (response.ok !== true) throw new Error('Recorder rejected the test bookmark');
      acknowledged = true;
    }
    if (acknowledged) {
      const hostSeconds = await findBookmark(root, id);
      if (hostSeconds !== null) {
        // Leave the native command receipt in place as diagnostic evidence.
        return { id, label: text, acknowledged: true, hostSeconds,
          timing: 'Native recorder bookmark PTS; brackets the operator action, not an exact Zoom event.' };
      }
    }
    await sleep(100);
  }
  throw new Error(`Test bookmark confirmation timed out; do not resend automatically. Pending request ID: ${id}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = {}, args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!['--archive', '--case', '--action', '--edge'].includes(args[i]) || !args[i + 1]
        || args[i + 1].startsWith('--') || values[args[i]]) throw new Error('Invalid arguments');
      values[args[i]] = args[i + 1];
    }
    if (!values['--archive'] || !values['--case'] || !values['--action'] || !values['--edge']) {
      throw new Error('Usage: node tools/mark-capture-test.mjs --archive <active-meeting-folder> --case W1 --action show-meeting --edge <before|after>');
    }
    console.log(JSON.stringify(await markCaptureTest(values['--archive'], values['--case'], values['--action'], values['--edge'])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
