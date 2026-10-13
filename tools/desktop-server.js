// Private stdio contract for the native development app. No shell commands or
// paths are accepted over stdin. The independent recorder is never killed here.
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createRecorderServer } = require('../server/index');

function startDesktopServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const runtime = createRecorderServer({ ...options,
    dataDir: options.dataDir || process.env.MEETING_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'Meeting Archive') });
  const send = value => output.write(JSON.stringify(value) + '\n');
  let closing = false;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const shutdown = async () => {
    if (closing) return;
    try {
      if (runtime.sessions.starting || runtime.store.active().length) {
        send({ event: 'shutdown', ok: false, error: 'recording-active' });
        return;
      }
    } catch {
      send({ event: 'shutdown', ok: false, error: 'recording-status-unavailable' });
      return;
    }
    closing = true;
    runtime.server.shuttingDown = true;
    await runtime.analysis.shutdown();
    // Finish in-flight writes. A stuck media download must not hang app exit.
    const timer = setTimeout(() => runtime.server.closeAllConnections(), 8000);
    timer.unref();
    runtime.server.close(() => {
      clearTimeout(timer);
      lines.close();
      input.pause();
      send({ event: 'shutdown', ok: true });
      options.onClosed?.();
    });
  };
  lines.on('line', line => {
    if (line.length > 1024) return send({ event: 'error', error: 'invalid-command' });
    try {
      const command = JSON.parse(line);
      if (command?.command !== 'shutdown' || Object.keys(command).length !== 1) throw new Error('Invalid command');
      shutdown();
    } catch { send({ event: 'error', error: 'invalid-command' }); }
  });
  runtime.server.listen(0, '127.0.0.1', () => {
    const port = runtime.server.address().port;
    send({ url: `http://127.0.0.1:${port}/`, port, token: runtime.token,
      nodeVersion: process.version, nodeExecPath: process.execPath });
  });
  return { ...runtime, shutdown };
}

if (require.main === module) {
  const runtime = startDesktopServer({ onClosed: () => { process.exitCode = 0; } });
  process.on('SIGTERM', runtime.shutdown);
  process.on('SIGINT', runtime.shutdown);
  runtime.server.on('error', error => { console.error(error.message); process.exit(1); });
}
module.exports = { startDesktopServer };
