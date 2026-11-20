// The native app owns this local server. Stop it if its parent app disappears.
const { startStudio } = require('./server.cjs');
const parent = Number(process.env.CUT_PARENT_PID) || process.ppid;
let session;
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  if (session) await session.close();
  process.exitCode = 0;
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
const watchdog = setInterval(() => { if (process.ppid !== parent) void stop(); }, 1000);
watchdog.unref();
startStudio(process.argv[2], 0, false).then(value => {
  session = value;
  if (closing) return session.close();
}).catch(error => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
