'use strict';
// `npm run try`: SUDS on your own computer, for testing, with the fictional sample data -- on Windows, macOS or
// Linux, with nothing to install but Node.js (docs/TRY-ON-WINDOWS.md).
//
//   npm run try                      start (the first run creates the data folder and the sample data)
//   npm run try -- --port 8081       on another port
//   npm run try -- --reset           delete the data-try folder and start again with fresh sample data
//   npm run try -- --data-dir <dir>  keep the data somewhere else (it must be empty, or made by this script)
//
// It is the office server itself, in development mode, kept apart from any real install:
//   * its own data folder, data-try/ beside the code (gitignored), never data/; and only a folder this script
//     made (it holds a .suds-try marker) is ever reset or reused;
//   * development, not production: the keys are generated into that folder the way `npm run dev` does, no TLS;
//   * bound to 127.0.0.1 only: nothing on the network can reach it, so Windows Defender Firewall has nothing to ask;
//   * the environment and any .env file are set aside (the server starts with this folder as its working
//     directory and the SUDS settings below), so a real install's keys, database path or audit-anchor directory
//     can never be picked up;
//   * the sample data comes from scripts/seed.js, which refuses a production database.
//
// The server runs in this process (server/index.js is required, not spawned), so Ctrl+C reaches its own clean
// stop on every system: on Windows a child process cannot be sent a Ctrl+C, only killed.
//
// run({ port, reset, dataDir }) is the same start without the command line, for anything else that starts SUDS
// this way (`suds try` in the Windows server exe, scripts/windows/cli.js, passes its own `command` name for the
// messages): it resolves once the server is listening, with what banner() prints. It changes this process's
// working directory and environment and starts the server in it, so it can be called once per process.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const MIN_NODE = [22, 13];
const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'data-try');
const DEFAULT_PORT = 8080;
const HOST = '127.0.0.1';
const MARKER = '.suds-try';
// The sample accounts scripts/seed.js creates, and the one password they share (SEED_PASSWORD, passed to it below).
// They exist only in this fictional data. The first administrator gets the same password here (SUDS_ADMIN_PASSWORD).
const SAMPLE_PASSWORD = 'Navigator2026!!';
const SAMPLE_ACCOUNTS = [
  { username: 'mrivera', role: 'navigator' },
  { username: 'dchen', role: 'navigator' },
  { username: 'kpatel', role: 'clinician' },
  { username: 'jwalker', role: 'supervisor' },
  { username: 'afinance', role: 'finance' },
  { username: 'rreader', role: 'read-only' },
];
const ADMIN_USERNAME = 'guest'; // server/bootstrap.js DEFAULT_ADMIN_USERNAME (SUDS_ADMIN_USERNAME is set aside below)

class TryError extends Error {}

/** How a person types this command with `extra` options: `npm run try -- --port 8081`, or `suds try --port 8081`. */
function commandLine(command, extra) {
  if (!extra.length) return command;
  return command === 'npm run try' ? `${command} -- ${extra.join(' ')}` : `${command} ${extra.join(' ')}`;
}

/** Why this Node.js cannot run SUDS, or null. Plain syntax: it has to run on an old Node to say so. */
function nodeVersionProblem(version = process.versions.node) {
  const [maj, min] = String(version).split('.').map(Number);
  if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])) return null;
  return [
    `SUDS needs Node.js ${MIN_NODE.join('.')} or later; this computer has ${version}.`,
    'Install the current LTS version, then open a new terminal window and try again:',
    '  Windows:  winget install OpenJS.NodeJS.LTS   (or the Windows installer from https://nodejs.org)',
    '  macOS:    the macOS installer from https://nodejs.org (or: brew install node@22)',
    '  Linux:    https://nodejs.org/en/download (or your distribution\'s nodejs 22 package)',
    'Check it with: node -v',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, reset: false, dataDir: DEFAULT_DIR, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name) => { const eq = a.indexOf('='); if (eq >= 0) return a.slice(eq + 1); if (i + 1 >= argv.length) throw new TryError(`${name} needs a value`); return argv[++i]; };
    if (a === '--reset') out.reset = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port' || a.startsWith('--port=')) out.port = val('--port');
    else if (a === '--data-dir' || a.startsWith('--data-dir=')) out.dataDir = path.resolve(val('--data-dir'));
    else throw new TryError(`Unknown option ${a}. Options: --port <number>, --reset, --data-dir <folder>`);
  }
  out.port = checkPort(out.port);
  return out;
}

function checkPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new TryError(`--port must be a number from 1 to 65535 (got "${p}")`);
  return n;
}

/** 'missing', 'empty', 'try' (made by this script) or 'other' (anything else: never touched). */
function folderKind(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
  if (names.includes(MARKER)) return 'try';
  return names.length === 0 ? 'empty' : 'other';
}

function readMarker(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return {}; } }
function writeMarker(dir, patch) { fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ ...readMarker(dir), ...patch }, null, 2) + '\n'); }

/** The pid of a SUDS server still running against `dir` (its instance lock, server/instance-lock.js), or null. */
function runningPid(dir) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, '.suds.lock'), 'utf8')); } catch { return null; }
  const pid = Number(rec && rec.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : null; }
}

/** Delete a folder this script made. Anything else is refused, and so is a folder a server is still using. */
function reset(dir = DEFAULT_DIR) {
  const kind = folderKind(dir);
  if (kind === 'missing') return false;
  if (kind === 'other') throw new TryError(`${dir} was not made by "npm run try" (it has no ${MARKER} file), so it is not deleted. Remove it yourself if it is yours to remove.`);
  const pid = runningPid(dir);
  if (pid) throw new TryError(`SUDS is still running from ${dir} (process ${pid}). Stop it first: press Ctrl+C in its window. Then run this again.`);
  // Audit anchors are made read-only once written (server/audit-anchor.js); on Windows that is the read-only
  // attribute, which can stop a delete. Make every file writable first.
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p); else { try { fs.chmodSync(p, 0o666); } catch {} }
    }
  };
  try { walk(dir); } catch {}
  // A virus scanner or the search indexer can hold a file open for a moment on Windows: retry rather than fail.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return true;
}

/** Whether `port` can be bound on 127.0.0.1 now: null, or the reason it cannot. */
function portProblem(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code || e.message));
    s.listen({ port, host: HOST, exclusive: true }, () => s.close(() => resolve(null)));
  });
}

// Settings that could point this server at a real install, or make it something other than a development
// server on this computer. Removed from the environment it starts with (and a .env file is not read: the server's
// working directory is the data folder, which has none).
const SET_ASIDE = /^(SUDS_|TLS_|AUDIT_|OIDC_|MS_|WEBAUTHN_|SESSION_|MFA_|LOGIN_|SIGNUP_|API_RATE|LOCAL_MODE|SEED_)|^(HOST|PORT|CREDENTIALS_DIRECTORY|TRUST_PROXY|UPDATE_FEED_URL|METRICS_TOKEN|ANTHROPIC_API_KEY|PUBLIC_APP_INFO|ALLOW_STATIC_SYNC|CLIENT_RETENTION_YEARS|TOMBSTONE_RETENTION_DAYS|ORG_TIMEZONE|LOG_FORMAT|GOOGLE_APPLICATION_CREDENTIALS|AWS_[A-Z_]+)$/i;

function tryEnv(dataDir, port, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!SET_ASIDE.test(k)) env[k] = v;
  return Object.assign(env, {
    SUDS_ENV: 'development', SUDS_DATA_DIR: dataDir, HOST, PORT: String(port),
    SUDS_ADMIN_PASSWORD: SAMPLE_PASSWORD, SEED_PASSWORD: SAMPLE_PASSWORD,
    // Fictional data on this computer only: two-step verification is never required of the sample accounts, so a
    // tester is not locked out once the grace period from the day the accounts were made has passed.
    MFA_REQUIRED_ROLES: '',
  });
}

function seed(dataDir, env) {
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'seed.js')], { cwd: dataDir, env, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    const out = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).filter((l) => !/password/i.test(l)).join('\n').trim();
    throw new TryError(`Could not create the sample data${r.error ? ` (${r.error.message})` : ''}.${out ? `\n${out}` : ''}`);
  }
}

function waitForListener(timeoutMs = 60000) {
  const listener = require(path.join(ROOT, 'server', 'listener'));
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const d = listener.describe();
      if (d) return resolve(d);
      if (Date.now() > until) return reject(new TryError('The server did not start listening within a minute (see the messages above).'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Start SUDS for testing. Resolves once it is listening, with { url, port, dataDir, password, accounts, reset, created }.
 * Throws TryError (a message for a person) for anything they can fix: an old Node, a busy port, a folder that is
 * not this script's.
 */
async function run({ port = DEFAULT_PORT, reset: doReset = false, dataDir = DEFAULT_DIR, command = 'npm run try' } = {}) {
  const problem = nodeVersionProblem(); if (problem) throw new TryError(problem);
  port = checkPort(port);
  dataDir = path.resolve(dataDir);
  let wasReset = false;
  if (doReset) wasReset = reset(dataDir);
  const kind = folderKind(dataDir);
  if (kind === 'other') throw new TryError(`${dataDir} already holds files that "${command}" did not make, so it will not use it (it could be a real install's data). Choose an empty folder with --data-dir, or leave the option out to use data-try.`);
  if (kind === 'try') {
    const pid = runningPid(dataDir);
    if (pid) throw new TryError(`SUDS is already running from ${dataDir} (process ${pid}). Use the address printed in that window, or stop it there with Ctrl+C first.`);
  }
  const busy = await portProblem(port);
  if (busy) {
    const why = busy === 'EADDRINUSE' ? `Port ${port} is already in use on this computer (another program, or SUDS already running in another window).`
      : busy === 'EACCES' ? `This computer does not allow a program to use port ${port}.` : `Port ${port} cannot be used (${busy}).`;
    throw new TryError(`${why}\nPick another port, for example:  ${commandLine(command, ['--port', String(port === 8081 ? 8082 : 8081)])}`);
  }

  const created = kind !== 'try';
  fs.mkdirSync(dataDir, { recursive: true });
  if (created) writeMarker(dataDir, { purpose: 'SUDS for testing on this computer, with fictional sample data (npm run try). Safe to delete.', created_at: new Date().toISOString() });
  const env = tryEnv(dataDir, port);
  if (!readMarker(dataDir).seeded_at) {
    seed(dataDir, env);
    writeMarker(dataDir, { seeded_at: new Date().toISOString() });
  }

  // The server reads its settings when its modules load: this process's environment and working directory become
  // the ones made above before server/index.js is required.
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  process.chdir(dataDir);
  require(path.join(ROOT, 'server', 'index.js'));
  const d = await waitForListener();
  return {
    url: (d.urls && d.urls[0]) || `http://localhost:${d.port}`, port: d.port, dataDir, password: SAMPLE_PASSWORD,
    accounts: [...SAMPLE_ACCOUNTS, { username: ADMIN_USERNAME, role: 'administrator' }], reset: wasReset, created,
  };
}

/** What a person needs once it is running. */
function banner(info, { command = 'npm run try', defaultDir = DEFAULT_DIR, dataOption = '--data-dir' } = {}) {
  const opts = [];
  if (info.port !== DEFAULT_PORT) opts.push(`--port ${info.port}`);
  if (info.dataDir !== defaultDir) opts.push(`${dataOption} "${info.dataDir}"`);
  const cmd = (extra) => commandLine(command, [...extra, ...opts]);
  const w = Math.max(...info.accounts.map((a) => a.username.length));
  return [
    '',
    '  ================================================================',
    '  SUDS is running on this computer, for testing.',
    '  ================================================================',
    '',
    `  Open:        ${info.url}   (in Edge, Chrome or Firefox)`,
    '',
    `  Sign in with a sample account. Password for all of them: ${info.password}`,
    ...info.accounts.map((a) => `    ${a.username.padEnd(w)}   ${a.role}`),
    '',
    '  The accounts and the clients in this copy are made up. It is for trying SUDS out:',
    '  do not type real client information into it.',
    '  Two-step verification is not required here (an office server requires it).',
    '',
    `  Data folder: ${info.dataDir}`,
    '  Only this computer can open it (127.0.0.1); nothing on the network can.',
    '',
    '  Stop:        press Ctrl+C in this window',
    `  Start again: ${cmd([])}`,
    `  Start over:  ${cmd(['--reset'])}   (deletes only the ${path.basename(info.dataDir)} folder, then makes fresh sample data)`,
    '',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const problem = nodeVersionProblem();
  if (problem) { console.error(problem); process.exitCode = 1; return; }
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { console.error(e.message); process.exitCode = 1; return; }
  if (opts.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  // A test (test/try-local.test.js) that started this with an IPC channel stops it the way Ctrl+C does: the same
  // SIGINT handler in server/index.js. (A Ctrl+C cannot be sent to another process on Windows.)
  if (process.send) process.on('message', (m) => { if (m === 'suds-try:stop') process.emit('SIGINT', 'SIGINT'); });
  try {
    const info = await run(opts);
    if (info.reset) console.log(`[suds] Started over: deleted the old ${info.dataDir}.`);
    if (info.created) console.log('[suds] Created the data folder and the fictional sample data.');
    process.stdout.write(banner(info) + '\n');
    if (process.send) process.send({ ready: true, url: info.url, port: info.port });
  } catch (e) {
    console.error(e instanceof TryError ? `\n${e.message}\n` : (e && e.stack) || e);
    process.exit(1);
  }
}

module.exports = { run, reset, banner, parseArgs, nodeVersionProblem, folderKind, tryEnv, runningPid, waitForListener, commandLine, DEFAULT_DIR, DEFAULT_PORT, SAMPLE_PASSWORD, SAMPLE_ACCOUNTS, MARKER, TryError };
if (require.main === module) main();
