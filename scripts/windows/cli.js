'use strict';
// `suds`: the command line of the SUDS Windows server (suds.exe; docs/WINDOWS-SERVER.md). suds.exe is Node.js with a
// small bootstrap injected (scripts/windows/sea-main.js) that finds the app\ folder beside it and runs this file from
// there, so an update replaces app\ and nothing else. Every command is a thin wrapper over what a Linux server runs
// with npm (server/index.js, scripts/try-local.js, scripts/backup.js and the rest), run with the bundled Node.
//
// It also runs with plain Node from a checkout (node scripts/windows/cli.js status), which is how
// test/windows-cli.test.js exercises it on Linux. Nothing here is a runtime dependency: Node built-ins only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const svc = require('./service');

const ROOT = path.join(__dirname, '..', '..'); // the app folder (the repository root in a checkout)
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DEFAULT_PORT = 8080;

// Exit codes (docs/WINDOWS-SERVER.md, "Exit codes"). A monitoring script can rely on them.
const EXIT = { OK: 0, FAILED: 1, USAGE: 2, BROKEN: 3, NOT_ELEVATED: 4, UNSUPPORTED: 5 };

/** An error for a person: one plain sentence and the next step. `code` is the exit code. */
class CliError extends Error { constructor(message, code = EXIT.FAILED) { super(message); this.code = code; } }

// ---------------------------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------------------------
const DATA_HELP = '--data <folder>   The data folder. Default: a "data" folder beside suds.exe if there is one, otherwise C:\\ProgramData\\SUDS.';
const COMMANDS = {
  default: { usage: 'suds [--data <folder>] [--port <number>]', summary: 'Start SUDS in this window and open it in the browser.',
    details: ['With no command (or when suds.exe is double-clicked), SUDS starts in this window. On a first run the browser opens the',
      'setup wizard; after that it opens the sign-in page. The window shows the address, the data folder and the log file.',
      'Press Ctrl+C to stop it cleanly. If SUDS is already running (as the Windows service, say), the browser is opened on it.',
      '', DATA_HELP, '--port <number>   Listen on this port (fixes it: the setup wizard will not offer to change it).'] },
  start: { usage: 'suds start [--data <folder>] [--port <number>]', summary: 'Start SUDS in this window without opening a browser. Ctrl+C stops it.',
    details: ['The same server as the Windows service, in the foreground. "suds serve" is the same command.',
      '', DATA_HELP, '--port <number>   Listen on this port.', '--open            Open the browser as well (what "suds" with no command does).'] },
  try: { usage: 'suds try [--reset] [--port <number>] [--data <folder>]', summary: 'A test copy with made-up sample data, on this computer only.',
    details: ['Starts SUDS with fictional clients and staff, reachable from this computer only (127.0.0.1), in its own',
      'data-try folder beside suds.exe. It is for trying SUDS out: never type real client information into it.',
      '', '--reset           Delete the data-try folder and start again with fresh sample data.', '--port <number>   Use another port (default 8080).',
      '--data <folder>   Keep the test copy somewhere else (an empty folder, or one "suds try" made).'] },
  status: { usage: 'suds status [--json] [--data <folder>]', summary: 'Version, service, health, port, folders, last backup, disk space.',
    details: ['Prints what county IT needs at a glance. It never goes to the internet: the update line is the result of the last',
      '"suds update --check". Exit code 0 when SUDS answers and reports itself healthy, 1 otherwise.',
      '', '--json            The same as JSON, for monitoring tools.', DATA_HELP] },
  service: { usage: 'suds service install|uninstall|start|stop|restart|status [--data <folder>]', summary: 'Run SUDS as a Windows service.',
    details: ['install     Install the Windows service "SUDS" (automatic, delayed start; restarted if it fails), running as the',
      '            virtual account NT SERVICE\\SUDS, and set the data folder so only that account, Administrators and SYSTEM can',
      '            open it. Writes suds-service.xml beside suds.exe.',
      'start       Start the service, and wait until SUDS answers.', 'stop        Stop it (SUDS shuts down cleanly).', 'restart     Stop it, then start it.',
      'status      Whether it is installed and running, and as which account.', 'uninstall   Stop and remove the service. The data folder is kept.',
      '', 'Every subcommand but status needs an elevated prompt: right-click Terminal and choose "Run as administrator".', DATA_HELP] },
  logs: { usage: 'suds logs [--follow] [--lines <N>] [--errors] [--service] [--data <folder>]', summary: 'Show the server log.',
    details: ['The server writes one log file a day under <data folder>\\logs (suds-YYYY-MM-DD.log), rolls a file aside at 8 MB and',
      'deletes files older than 30 days. Log lines never contain client information.',
      '', '--lines <N>       How many lines to show (default 50).', '--follow          Keep showing new lines as they are written (Ctrl+C to stop).',
      '--errors          Only errors, from all the log files, newest last; and the service wrapper\'s error output.',
      '--service         The service wrapper\'s own log instead (logs\\service).', DATA_HELP] },
  open: { usage: 'suds open [--data <folder>]', summary: 'Open SUDS in the default browser.', details: [DATA_HELP] },
  version: { usage: 'suds version [--json]', summary: 'Print the version.', details: [] },
  backup: { usage: 'suds backup [<folder>] | --restore <file.enc> [<out.db>] | --restore-in-place <file.enc>', summary: 'Take an encrypted backup now, or restore one.',
    details: ['suds backup                         An encrypted backup of the live database, into <data folder>\\backups (or <folder>).',
      'suds backup --restore <file.enc>    Decrypt a backup to a separate file; the live database is not touched.',
      'suds backup --restore-in-place <f>  With the service STOPPED (suds service stop): put the backup in place of the live database.',
      'Run it from an elevated prompt when SUDS runs as the service (only Administrators and the service may open the data folder).', DATA_HELP] },
  'dr-drill': { usage: 'suds dr-drill [--backup <file>] [--fresh] [--keys-file <keys.json>] [--local|--offsite] [--json]', summary: 'Run a recovery drill on the newest backup.',
    details: ['Restores a backup into a temporary folder, checks it in a separate process and signs a report. Safe while SUDS runs.', DATA_HELP] },
  update: { usage: 'suds update --check | --from <suds-X.Y.Z-windows-x64.zip>', summary: 'Check for a newer release, or install one from a downloaded zip.',
    details: ['--check           Ask the release feed (UPDATE_FEED_URL, or GitHub\'s releases of SUDS) for the newest version. This is the',
      '                  only command that goes to the internet, and only when you run it. "suds status" shows the answer.',
      '--feed <url>      Ask this feed instead (a GitHub releases API URL, or a county mirror).',
      '--from <zip>      Install a release zip you downloaded: checks it against its .sha256 file beside it, takes a backup, stops',
      '                  the service, replaces app\\ (the old one is kept as app.previous), and starts the service again.',
      '                  Needs an elevated prompt.', DATA_HELP] },
  'create-admin': { usage: 'suds create-admin [<username>] [--data <folder>]', summary: 'Create an administrator account, or reset one\'s password.',
    details: ['Asks for the password (or reads SUDS_ADMIN_PASSWORD). The account must change it at its first sign-in. The default name is "guest".', DATA_HELP] },
  'reset-admin': { usage: 'suds reset-admin <username> [--data <folder>]', summary: 'Let a locked-out administrator back in.',
    details: ['Sets a new temporary password (printed once), clears the lockout, two-step verification and passkeys of that one', 'administrator account, and records it in the audit log.', DATA_HELP] },
  'verify-audit-export': { usage: 'suds verify-audit-export <export.ndjson> [--public-key <file>] [--key-file <keys.json>] [--anchors <folder>] [--json]', summary: 'Check an audit export file away from the server.', details: [] },
  'compliance-check': { usage: 'suds compliance-check', summary: 'The host compliance check (Linux servers only).',
    details: ['The host check reads Linux settings (systemd, file modes, the firewall) and does not run on Windows. The in-app', 'checks still apply: Settings -> Security status, and Settings -> Compliance.'] },
};
const ORDER = [['Running SUDS', ['default', 'start', 'open', 'try']], ['Windows service', ['service']], ['Checking on it', ['status', 'logs', 'version']],
  ['Looking after it', ['backup', 'dr-drill', 'update', 'create-admin', 'reset-admin', 'verify-audit-export', 'compliance-check']]];
const EXIT_HELP = ['Exit codes: 0 done; 1 failed (the message says why); 2 the command line was wrong; 3 SUDS\'s own files are', 'incomplete; 4 needs an elevated (administrator) prompt; 5 not available on this system.'];

function helpText(cmd) {
  if (cmd && COMMANDS[cmd]) {
    const c = COMMANDS[cmd];
    return [`Usage: ${c.usage}`, '', c.summary, ...(c.details.length ? ['', ...c.details] : []), '', ...EXIT_HELP, ''].join('\n');
  }
  const lines = [`SUDS ${PKG.version}: the SUDS office server on Windows.`, '', 'Usage: suds <command> [options]     (suds <command> --help for more)', ''];
  for (const [title, names] of ORDER) {
    lines.push(title);
    for (const n of names) lines.push(`  ${(n === 'default' ? '(no command)' : n).padEnd(21)}${COMMANDS[n].summary}`);
    lines.push('');
  }
  lines.push('Most commands take --data <folder>: the data folder. Default: a "data" folder beside suds.exe if there is one,', 'otherwise C:\\ProgramData\\SUDS. Guide: docs\\WINDOWS-SERVER.md, or README-WINDOWS.txt beside suds.exe.', '', ...EXIT_HELP, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------
const ALIASES = { serve: 'start', '--version': 'version', '-v': 'version', '/?': 'help', '-h': 'help', '--help': 'help' };
const SPECS = {
  default: { values: ['--data', '--port'], flags: [] },
  start: { values: ['--data', '--port'], flags: ['--service', '--open'] },
  try: { values: ['--data', '--port'], flags: ['--reset'] },
  status: { values: ['--data'], flags: ['--json'] },
  service: { values: ['--data'], flags: [], positional: 1 },
  logs: { values: ['--data', '--lines'], flags: ['--follow', '--errors', '--service'] },
  open: { values: ['--data'], flags: [] },
  version: { values: [], flags: ['--json'] },
  update: { values: ['--data', '--from', '--feed'], flags: ['--check', '--allow-downgrade'] },
  'create-admin': { values: ['--data'], flags: [], positional: 1 },
  // Passed through to the script, except --data and --help.
  backup: { passthrough: true }, 'dr-drill': { passthrough: true }, 'reset-admin': { passthrough: true },
  'verify-audit-export': { passthrough: true }, 'compliance-check': { passthrough: true },
  help: { values: [], flags: [], positional: 1 },
};

/** argv (after `suds`) → { cmd, opts, positional, rest, help }. Throws CliError (exit 2) for a wrong command line. */
function parseArgs(argv) {
  const args = [...argv];
  let cmd = 'default';
  if (args.length && !args[0].startsWith('--')) cmd = args.shift();
  else if (args.length && ALIASES[args[0]]) cmd = args.shift();
  cmd = ALIASES[cmd] || cmd;
  if (cmd === 'help') return { cmd: 'help', opts: {}, positional: args.filter((a) => !a.startsWith('-')).slice(0, 1), rest: [], help: true };
  const spec = SPECS[cmd];
  if (!spec) throw new CliError(`"${cmd}" is not a SUDS command. Run "suds help" to see the commands.`, EXIT.USAGE);
  const out = { cmd, opts: {}, positional: [], rest: [], help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('='); const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      if (eq > 0 && a.startsWith('--')) return a.slice(eq + 1);
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new CliError(`${name} needs a value. Run "suds ${cmd === 'default' ? '' : `${cmd} `}--help" for how to use it.`, EXIT.USAGE);
      return args[++i];
    };
    if (name === '--help' || name === '-h' || name === '/?') { out.help = true; continue; }
    if (spec.passthrough) { if (name === '--data') out.opts.data = value(); else out.rest.push(a); continue; }
    if ((spec.values || []).includes(name)) { out.opts[name.slice(2)] = value(); continue; }
    if ((spec.flags || []).includes(name) && eq < 0) { out.opts[name.slice(2)] = true; continue; }
    if (!a.startsWith('-') && out.positional.length < (spec.positional || 0)) { out.positional.push(a); continue; }
    const known = [...(spec.values || []).map((v) => `${v} <value>`), ...(spec.flags || [])];
    throw new CliError(`"${a}" is not an option of ${cmd === 'default' ? 'suds' : `suds ${cmd}`}${known.length ? ` (it takes ${known.join(', ')})` : ''}. Run "suds ${cmd === 'default' ? '' : `${cmd} `}--help".`, EXIT.USAGE);
  }
  if (out.opts.port !== undefined) out.opts.port = checkPort(out.opts.port);
  if (out.opts.lines !== undefined) {
    const n = Number(out.opts.lines);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw new CliError(`--lines must be a whole number from 1 to 100000 (got "${out.opts.lines}").`, EXIT.USAGE);
    out.opts.lines = n;
  }
  if (cmd === 'service' && !out.help) {
    const sub = out.positional[0];
    if (!sub) throw new CliError('Say what to do with the service: suds service install, start, stop, restart, status or uninstall.', EXIT.USAGE);
    if (!['install', 'uninstall', 'start', 'stop', 'restart', 'status'].includes(sub)) throw new CliError(`"${sub}" is not a service command. Use install, uninstall, start, stop, restart or status.`, EXIT.USAGE);
  }
  return out;
}

function checkPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`--port must be a number from 1 to 65535 (got "${p}").`, EXIT.USAGE);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------------------------------------------
/** The folder suds.exe is in (SUDS_EXE is set by the bootstrap), or the app folder when run with plain Node. */
function installDir(env = process.env) { return env.SUDS_EXE ? path.dirname(env.SUDS_EXE) : ROOT; }

/**
 * The data folder, and why: the --data option, else SUDS_DATA_DIR, else a "data" folder beside suds.exe (a portable
 * install), else %ProgramData%\SUDS on Windows (the service's, and the default for everything else too, so the
 * foreground server, the backup and the service all use the same data), else <install>\data elsewhere.
 */
function resolveDataDir({ flag, env = process.env, install = installDir(env), platform = process.platform, exists = fs.existsSync } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (flag) return { dir: P.resolve(flag), source: 'the --data option' };
  if (env.SUDS_DATA_DIR) return { dir: P.resolve(env.SUDS_DATA_DIR), source: 'SUDS_DATA_DIR' };
  const portable = P.join(install, 'data');
  if (exists(portable)) return { dir: portable, source: 'the data folder beside suds.exe' };
  if (platform === 'win32') return { dir: P.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'SUDS'), source: 'the default (%ProgramData%\\SUDS)' };
  return { dir: portable, source: 'the default' };
}

/** The test copy's folder: data-try beside suds.exe, or in %LOCALAPPDATA%\SUDS when that folder cannot be written. */
function tryDataDir({ env = process.env, install = installDir(env), writable = canWrite } = {}) {
  if (writable(install)) return path.join(install, 'data-try');
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'SUDS', 'data-try');
}

function canWrite(dir) {
  try { const f = path.join(dir, `.suds-write-test-${process.pid}`); fs.writeFileSync(f, ''); fs.unlinkSync(f); return true; } catch { return false; }
}

/** KEY=VALUE lines of a .env file (the server reads <data folder>\.env: it runs with the data folder as its working directory). */
function readDotEnv(file) {
  const out = {};
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Where the server listens, from the same sources it reads (the environment, <data>\.env, <data>\server.json). */
function listenSettings(dataDir, env = process.env) {
  const dot = readDotEnv(path.join(dataDir, '.env'));
  const get = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : dot[k]);
  let file = {}; try { file = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8')); } catch {}
  const tls = !!get('TLS_CERT_PATH') || (file.tls === 'selfsigned' && fs.existsSync(path.join(dataDir, 'certs', 'suds.crt')));
  const port = Number(get('PORT') || file.port || DEFAULT_PORT) || DEFAULT_PORT;
  const host = get('HOST') || file.host || '127.0.0.1';
  const scheme = tls ? 'https' : 'http';
  const local = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' ? '127.0.0.1' : host;
  const shown = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' ? 'localhost' : host;
  const std = (tls && port === 443) || (!tls && port === 80);
  return { scheme, host, port, setupComplete: !!file.setupComplete, probe: `${scheme}://${local}:${port}`, url: `${scheme}://${shown}${std ? '' : `:${port}`}`, updateFeed: get('UPDATE_FEED_URL') || '' };
}

/** Make this process the server's: its data folder, production unless set otherwise, and the data folder as working directory. */
function serverEnv(dataDir) {
  try { fs.mkdirSync(dataDir, { recursive: true }); }
  catch (e) { throw new CliError(`SUDS cannot create its data folder ${dataDir} (${e.code || e.message}). Run this from an elevated prompt, or choose another folder with --data.`); }
  try { fs.readdirSync(dataDir); } catch (e) { throw new CliError(`SUDS cannot open its data folder ${dataDir} (${e.code || e.message}). When SUDS runs as the service only Administrators may open it: run this from an elevated prompt.`, e.code === 'EPERM' || e.code === 'EACCES' ? EXIT.NOT_ELEVATED : EXIT.FAILED); }
  process.env.SUDS_DATA_DIR = dataDir;
  if (!process.env.SUDS_ENV) process.env.SUDS_ENV = 'production';
  process.chdir(dataDir);
}

// ---------------------------------------------------------------------------------------------------------------
// Running SUDS's own scripts with the bundled Node
// ---------------------------------------------------------------------------------------------------------------
/** Run one of app\scripts\*.js in this process, as `node scripts/<name> <args>` would. */
function runScript(name, args, dataDir) {
  const file = path.join(ROOT, 'scripts', name);
  if (dataDir) serverEnv(dataDir);
  process.argv = [process.execPath, file, ...args];
  require('node:module')._load(file, null, true);
}

/** The same in a child process (the bundled Node: suds.exe runs a script inside app\ when given its path). */
function runScriptChild(name, args, { dataDir, env = process.env, stdio = 'inherit' } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], {
    stdio, encoding: 'utf8', windowsHide: true, cwd: dataDir || process.cwd(),
    env: { ...env, ...(dataDir ? { SUDS_DATA_DIR: dataDir, SUDS_ENV: env.SUDS_ENV || 'production' } : {}) },
  });
  return r;
}

function openBrowser(url, { platform = process.platform, run = (c, a) => spawn(c, a, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref() } = {}) {
  // rundll32's URL handler opens the default browser without a shell, so nothing in the address is interpreted.
  if (platform === 'win32') run('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  else if (platform === 'darwin') run('open', [url]);
  else run('xdg-open', [url]);
}

// ---------------------------------------------------------------------------------------------------------------
// suds / suds start
// ---------------------------------------------------------------------------------------------------------------
function lockPid(dataDir) { return require(path.join(ROOT, 'scripts', 'try-local.js')).runningPid(dataDir); }

/** In the service: no line naming a temporary password reaches WinSW's log files (server/log.js's rule, for stdout too). */
function guardServiceOutput() {
  const { redacted } = require(path.join(ROOT, 'server', 'log.js'));
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const text = String(chunk);
        if (text.split('\n').some((l) => redacted(l))) chunk = text.split('\n').map((l) => (redacted(l) ? '[suds] (a temporary password was printed here; it is in first-admin-password.txt in the data folder)' : l)).join('\n');
      }
      return write(chunk, ...rest);
    };
  }
}

/** A fatal stop of the service also goes to the Windows Event Log (Application, source SUDS), without the error's text. */
function reportFatalExits(dataDir) {
  process.on('exit', (code) => {
    if (!code) return;
    const msg = `SUDS stopped with an error (exit code ${code}). See the server log: suds logs --errors, or ${path.join(dataDir, 'logs')}. The service is restarted automatically.`;
    try { svc.writeEvent(msg, { type: 'Error', id: 1001 }); } catch {}
  });
}

async function cmdStart(p, { browser }) {
  const { dir } = resolveDataDir({ flag: p.opts.data });
  const service = !!p.opts.service;
  if (!service) {
    let pid = null; try { pid = lockPid(dir); } catch {}
    if (pid) {
      const where = listenSettings(dir);
      if (browser) { console.log(`SUDS is already running (process ${pid}). Opening ${where.url} in the browser.`); openBrowser(where.url); return EXIT.OK; }
      throw new CliError(`SUDS is already running from ${dir} (process ${pid}, perhaps the Windows service). Open ${where.url}, or stop it first (suds service stop).`);
    }
  }
  serverEnv(dir);
  if (p.opts.port) process.env.PORT = String(p.opts.port);
  if (service) { guardServiceOutput(); if (process.platform === 'win32') reportFatalExits(dir); }
  require(path.join(ROOT, 'server', 'index.js'));
  const d = await require(path.join(ROOT, 'scripts', 'try-local.js')).waitForListener(120000);
  const log = require(path.join(ROOT, 'server', 'log.js')).currentFile();
  const url = (d.urls || []).find((u) => /localhost/.test(u)) || (d.urls || [])[0];
  let setup = false; try { setup = require(path.join(ROOT, 'server', 'routes', 'setup.js')).isNeeded(); } catch {}
  if (!service) {
    process.stdout.write(['', '  ================================================================', `  SUDS ${PKG.version} is running.`, '  ================================================================', '',
      `  Open:         ${(d.urls || []).join('   ')}`, ...(setup ? ['  First run:    open the address above on this computer to finish the setup wizard.'] : []), '',
      `  Data folder:  ${dir}`, `  Log file:     ${log || path.join(dir, 'logs')}`, '', '  Stop:         press Ctrl+C in this window', ''].join('\n') + '\n');
    if (browser || p.opts.open) openBrowser(url);
  }
  return undefined; // keeps running
}

// ---------------------------------------------------------------------------------------------------------------
// suds try
// ---------------------------------------------------------------------------------------------------------------
async function cmdTry(p) {
  const T = require(path.join(ROOT, 'scripts', 'try-local.js'));
  const defaultDir = tryDataDir();
  const dataDir = p.opts.data ? path.resolve(p.opts.data) : defaultDir;
  try {
    const info = await T.run({ port: p.opts.port || T.DEFAULT_PORT, reset: !!p.opts.reset, dataDir, command: 'suds try' });
    if (info.reset) console.log(`[suds] Started over: deleted the old ${info.dataDir}.`);
    if (info.created) console.log('[suds] Created the data folder and the fictional sample data.');
    process.stdout.write(T.banner(info, { command: 'suds try', defaultDir, dataOption: '--data' }) + '\n');
    return undefined;
  } catch (e) {
    if (e instanceof T.TryError) throw new CliError(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// suds status
// ---------------------------------------------------------------------------------------------------------------
function getJson(url, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? require('node:https') : require('node:http');
    // Only this server's own health answer is read, on this machine: a self-signed certificate is accepted here.
    const req = mod.get(url, { timeout: timeoutMs, rejectUnauthorized: false, headers: { Accept: 'application/json' } }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
  });
}

/** The last scheduled backup, from the database's settings (read-only), and the newest file in the backups folder. */
function backupInfo(dataDir) {
  const out = { folder: path.join(dataDir, 'backups'), last_at: null, last_status: null, newest_file: null, newest_at: null };
  try {
    const file = path.join(dataDir, 'suds.db');
    if (!fs.existsSync(file)) throw Object.assign(new Error('no database yet'), { code: 'NO_DB' });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN ('last_scheduled_backup_at','last_scheduled_backup_status','backup_schedule_hours')`).all();
      const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      out.last_at = m.last_scheduled_backup_at || null; out.last_status = m.last_scheduled_backup_status || null;
      out.schedule_hours = Number(m.backup_schedule_hours || 0) || 0;
    } finally { db.close(); }
  } catch (e) { if (e.code !== 'NO_DB') out.read_error = e.code === 'ERR_SQLITE_ERROR' || /unable to open/i.test(e.message) ? 'the database could not be read (run from an elevated prompt)' : String(e.message).slice(0, 200); }
  try {
    const files = fs.readdirSync(out.folder).filter((f) => /\.enc$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(out.folder, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (files.length) { out.newest_file = files[0].f; out.newest_at = new Date(files[0].t).toISOString(); }
  } catch {}
  return out;
}

function updateInfo(dataDir) {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-check.json'), 'utf8'));
    return { checked_at: u.checked_at || null, latest: u.latest || null, available: !!u.available, url: u.url || null, feed: u.feed || null };
  } catch { return { checked_at: null, latest: null, available: null, note: 'Not checked yet: run "suds update --check" (status never goes to the internet).' }; }
}

function diskFree(dir) {
  for (let d = dir; d; d = path.dirname(d)) {
    try { const s = fs.statfsSync(d); return { path: d, free_bytes: s.bavail * s.bsize }; } catch {}
    if (path.dirname(d) === d) break;
  }
  return { path: dir, free_bytes: null };
}

/** Everything `suds status` reports. `deps` lets tests replace Windows and the network. */
async function statusReport({ dataFlag, env = process.env, platform = process.platform, exec = svc.defaultExec, fetchJson = getJson } = {}) {
  const { dir, source } = resolveDataDir({ flag: dataFlag, env, platform });
  const where = listenSettings(dir, env);
  const service = platform === 'win32' ? svc.query(exec) : { installed: false, state: 'not available (Windows only)' };
  const h = await fetchJson(`${where.probe}/api/health`);
  const logDir = path.join(dir, 'logs');
  let current = null; try { current = fs.readdirSync(logDir).filter((f) => /^suds-\d{4}-\d\d-\d\d\.log$/.test(f)).sort().pop() || null; } catch {}
  return {
    version: PKG.version, node: process.versions.node, exe: env.SUDS_EXE || null, app_dir: ROOT,
    data_dir: dir, data_dir_source: source, data_dir_exists: fs.existsSync(dir),
    service: { name: svc.SERVICE_ID, installed: service.installed, state: service.state, account: service.account || null, start_type: service.startType || null, ...(service.error ? { error: service.error } : {}) },
    server: { url: where.url, scheme: where.scheme, host: where.host, port: where.port, setup_complete: where.setupComplete, reachable: h.status > 0,
      healthy: !!(h.json && h.json.ok === true), http_status: h.status || null, health: h.json || null, ...(h.error ? { error: h.error } : {}) },
    logs: { dir: logDir, current: current ? path.join(logDir, current) : null, service_dir: svc.wrapperLogDir(dir) },
    backup: backupInfo(dir),
    disk: diskFree(dir),
    update: updateInfo(dir),
  };
}

const fmtBytes = (n) => (n == null ? 'unknown' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

function statusText(s) {
  const h = s.server.health || {};
  const warn = [...(h.warnings || []), ...(h.warning ? [h.warning] : [])];
  const health = !s.server.reachable ? `not answering at ${s.server.url} (${s.server.error || 'no answer'})` : s.server.healthy ? 'OK' : `NOT OK (HTTP ${s.server.http_status})`;
  const b = s.backup;
  const backup = b.last_at ? `${b.last_at}, ${b.last_status || 'no result recorded'}` : b.newest_file ? `${b.newest_at} (${b.newest_file})` : b.read_error ? `unknown: ${b.read_error}` : 'none yet';
  const u = s.update;
  const update = u.checked_at ? (u.available ? `${u.latest} is available (checked ${u.checked_at}): see suds update --help` : `up to date (checked ${u.checked_at})`) : u.note;
  return [
    `SUDS ${s.version}`,
    `  Service:      ${s.service.installed === true ? `${s.service.state}${s.service.account ? `, as ${s.service.account}` : ''}${s.service.start_type ? `, ${s.service.start_type}` : ''}` : s.service.installed === false ? s.service.state : `unknown (${s.service.error || 'sc.exe did not answer'})`}`,
    `  Health:       ${health}`,
    ...warn.map((w) => `                ! ${w}`),
    `  Address:      ${s.server.url}   (port ${s.server.port}${s.server.setup_complete ? '' : '; setup not finished yet'})`,
    `  Data folder:  ${s.data_dir}${s.data_dir_exists ? '' : ' (does not exist yet)'}   (${s.data_dir_source})`,
    `  Logs:         ${s.logs.current || s.logs.dir}`,
    `  Last backup:  ${backup}`,
    `  Disk free:    ${fmtBytes(s.disk.free_bytes)} on ${s.disk.path}`,
    `  Update:       ${update}`,
    '',
  ].join('\n');
}

async function cmdStatus(p) {
  const s = await statusReport({ dataFlag: p.opts.data });
  process.stdout.write(p.opts.json ? JSON.stringify(s, null, 2) + '\n' : statusText(s));
  return s.server.reachable && s.server.healthy ? EXIT.OK : EXIT.FAILED;
}

// ---------------------------------------------------------------------------------------------------------------
// suds service
// ---------------------------------------------------------------------------------------------------------------
function needWindows(what) { if (process.platform !== 'win32') throw new CliError(`${what} exists only on Windows. On Linux, SUDS Server runs under systemd (docs/DEPLOYMENT.md).`, EXIT.UNSUPPORTED); }
function needElevated(cmd, exec = svc.defaultExec) {
  if (!svc.isElevated(exec)) throw new CliError(`"suds ${cmd}" needs an administrator. Right-click Terminal (or PowerShell) and choose "Run as administrator", then run it again.`, EXIT.NOT_ELEVATED);
}
function mustRun(r, what) {
  if (r.status !== 0) throw new CliError(`${what} failed (exit code ${r.status}): ${((r.stderr || '') + (r.stdout || '')).trim().split(/\r?\n/).slice(-3).join(' ') || (r.error && r.error.message) || 'no message'}. See suds logs --errors.`);
  return r;
}

async function waitHealthy(dataDir, timeoutMs = 90000) {
  const where = listenSettings(dataDir);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const h = await getJson(`${where.probe}/api/health/live`, { timeoutMs: 3000 });
    if (h.status === 200) return where;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cmdService(p, { exec = svc.defaultExec } = {}) {
  needWindows('The Windows service');
  const sub = p.positional[0];
  const dir = resolveDataDir({ flag: p.opts.data }).dir;
  const inst = installDir();
  const wrapper = path.join(inst, svc.WRAPPER_EXE);
  if (sub === 'status') {
    const q = svc.query(exec);
    if (q.installed === false) { console.log('The SUDS service is not installed. Install it from an elevated prompt: suds service install'); return EXIT.FAILED; }
    console.log(`The SUDS service is ${q.state}${q.account ? `, running as ${q.account}` : ''}${q.startType ? `, start: ${q.startType}` : ''}.`);
    return q.state === 'running' ? EXIT.OK : EXIT.FAILED;
  }
  needElevated(`service ${sub}`, exec);
  if (!fs.existsSync(wrapper)) throw new CliError(`${svc.WRAPPER_EXE} is missing beside suds.exe (${inst}). Unzip the whole SUDS download again into this folder.`, EXIT.BROKEN);
  const q = svc.query(exec);
  if (sub === 'install') {
    if (q.installed) throw new CliError(`The SUDS service is already installed (${q.state}). To change it: suds service uninstall, then suds service install.`);
    fs.mkdirSync(path.join(dir, 'logs', 'service'), { recursive: true });
    svc.writeXml(inst, { dataDir: dir, version: PKG.version });
    console.log(`Wrote ${path.join(inst, svc.WRAPPER_XML)} (data folder ${dir}).`);
    mustRun(exec(wrapper, ['install']), 'Installing the service');
    console.log(`Installed the Windows service "${svc.SERVICE_NAME}", running as ${svc.ACCOUNT}: automatic (delayed) start, restarted if it fails.`);
    for (const [cmd, args] of svc.permissionCommands({ dataDir: dir, installDir: inst })) mustRun(exec(cmd, args), `Setting the permissions of ${args[0]}`);
    console.log(`Set the data folder so only ${svc.ACCOUNT}, Administrators and SYSTEM can open it; the service may read ${inst}.`);
    const ev = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', svc.REGISTER_SOURCE]);
    console.log(ev.status === 0 ? 'Service start, stop and failures go to the Windows Event Log (Application, source SUDS).' : 'Note: could not register the Event Log source SUDS; the service still runs, but its events may not appear in Event Viewer.');
    console.log(['', 'Next:', '  suds service start', '  then open the address it prints, on this computer, to finish the setup wizard.',
      '  For other computers to reach it: an inbound firewall rule for its port (docs\\WINDOWS-SERVER.md, "Firewall").', ''].join('\n'));
    return EXIT.OK;
  }
  if (q.installed === false) throw new CliError('The SUDS service is not installed. Install it first: suds service install');
  if (sub === 'stop' || sub === 'restart' || sub === 'uninstall') {
    if (q.state !== 'stopped') {
      const r = exec('sc.exe', ['stop', svc.SERVICE_ID]);
      if (r.status !== 0 && !/1062/.test(r.stdout + r.stderr)) mustRun(r, 'Stopping the service');
      const after = await svc.waitFor('stopped', { exec });
      if (after.state !== 'stopped') throw new CliError(`The SUDS service did not stop within 90 seconds (it is ${after.state}). See suds logs --errors, and the Event Viewer: Windows Logs > Application, source SUDS.`);
      console.log('Stopped the SUDS service (SUDS shut down cleanly).');
    } else if (sub === 'stop') console.log('The SUDS service is already stopped.');
  }
  if (sub === 'uninstall') {
    mustRun(exec(wrapper, ['uninstall']), 'Removing the service');
    console.log(`Removed the SUDS service. The data folder ${dir} is kept: back it up or delete it yourself.`);
    return EXIT.OK;
  }
  if (sub === 'start' || sub === 'restart') {
    const r = exec('sc.exe', ['start', svc.SERVICE_ID]);
    if (r.status !== 0 && !/1056/.test(r.stdout + r.stderr)) mustRun(r, 'Starting the service');
    const after = await svc.waitFor('running', { exec });
    if (after.state !== 'running') throw new CliError(`The SUDS service did not start (it is ${after.state}). See why: suds logs --errors, and the Event Viewer: Windows Logs > Application, source SUDS.`);
    const where = await waitHealthy(dir);
    if (!where) throw new CliError(`The SUDS service is running but SUDS does not answer yet. See suds logs --errors; it may still be starting (suds status).`);
    console.log(`The SUDS service is running: ${where.url}${where.setupComplete ? '' : '   (first run: open it on this computer to finish the setup wizard)'}`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------------------
// suds logs
// ---------------------------------------------------------------------------------------------------------------
const ENTRY_START = /^(\{"time":"|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/;
/** Log text → entries (a line with a timestamp starts one; a stack trace's lines belong to it). */
function logEntries(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (ENTRY_START.test(line) || !out.length) out.push(line); else out[out.length - 1] += `\n${line}`;
  }
  return out;
}
const isError = (entry) => /^\S+ ERROR /.test(entry) || /^\{"time":"[^"]*","level":"ERROR"/.test(entry);

function serverLogFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^suds-\d{4}-\d\d-\d\d\.log(\.\d+\.old)?$/.test(f)).sort((a, b) => (a.slice(5, 15) === b.slice(5, 15) ? (a.endsWith('.log') ? 1 : b.endsWith('.log') ? -1 : a < b ? -1 : 1) : a < b ? -1 : 1)).map((f) => path.join(dir, f)); } catch { return []; }
}

/** The last `lines` entries: of today's file, or (errors) the errors of every file, oldest first. */
function tailLogs(dataDir, { lines = 50, errors = false, service = false } = {}) {
  const dir = path.join(dataDir, 'logs');
  if (service) {
    const sdir = svc.wrapperLogDir(dataDir).split(path.win32.sep).join(path.sep);
    let files = []; try { files = fs.readdirSync(sdir).filter((f) => /\.log$/.test(f)).map((f) => path.join(sdir, f)); } catch {}
    const want = files.filter((f) => (errors ? /\.err\.log$/.test(f) : /\.(wrapper|out|err)\.log$/.test(f)));
    return { files: want, entries: want.flatMap((f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => `${path.basename(f)}: ${l}`)).slice(-lines) };
  }
  const files = serverLogFiles(dir);
  if (!files.length) return { files: [], entries: [] };
  if (!errors) return { files: [files[files.length - 1]], entries: logEntries(fs.readFileSync(files[files.length - 1], 'utf8')).slice(-lines) };
  const all = files.flatMap((f) => logEntries(fs.readFileSync(f, 'utf8')).filter(isError));
  return { files, entries: all.slice(-lines) };
}

async function cmdLogs(p) {
  const { dir } = resolveDataDir({ flag: p.opts.data });
  const lines = p.opts.lines || 50;
  const t = tailLogs(dir, { lines, errors: !!p.opts.errors, service: !!p.opts.service });
  if (!t.files.length) {
    if (!fs.existsSync(dir)) throw new CliError(`There is no data folder at ${dir} yet, so no log. Start SUDS first (suds start, or suds service start), or name the folder with --data.`);
    try { fs.readdirSync(dir); } catch { throw new CliError(`SUDS cannot open ${dir}: only Administrators and the service may. Run this from an elevated prompt.`, EXIT.NOT_ELEVATED); }
    throw new CliError(`There are no log files in ${path.join(dir, 'logs')} yet. They appear once SUDS has started.`);
  }
  if (t.entries.length) console.log(t.entries.join('\n'));
  else if (p.opts.errors) console.log('No errors in the logs.');
  if (p.opts.errors && !p.opts.service) {
    const s = tailLogs(dir, { lines: Math.min(lines, 20), errors: true, service: true });
    if (s.entries.length) console.log(['', `The service wrapper's error output (${svc.wrapperLogDir(dir)}):`, ...s.entries].join('\n'));
  }
  if (!p.opts.follow) return EXIT.OK;
  // Follow: new lines of the newest file, switching to the next day's file when it appears.
  let file = t.files[t.files.length - 1]; let pos = fs.statSync(file).size;
  const logDir = path.join(dir, 'logs');
  setInterval(() => {
    const newest = p.opts.service ? file : serverLogFiles(logDir).filter((f) => f.endsWith('.log')).pop() || file;
    if (newest !== file) { file = newest; pos = 0; }
    let size; try { size = fs.statSync(file).size; } catch { return; }
    if (size < pos) pos = 0;
    if (size === pos) return;
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - pos); fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos = size;
    let text = buf.toString('utf8');
    if (p.opts.errors) text = logEntries(text).filter(isError).join('\n') + (text.trim() ? '\n' : '');
    if (text.trim()) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }, 1000);
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// suds update
// ---------------------------------------------------------------------------------------------------------------
const DEFAULT_FEED = 'https://api.github.com/repos/taugustincst/suds/releases/latest';
const crypto = require('node:crypto');

async function cmdUpdate(p, { exec = svc.defaultExec } = {}) {
  const { dir } = resolveDataDir({ flag: p.opts.data });
  if (p.opts.check) {
    const feed = p.opts.feed || listenSettings(dir).updateFeed || DEFAULT_FEED;
    console.log(`Asking ${feed} for the newest release...`);
    let r;
    try { r = await require(path.join(ROOT, 'server', 'update.js')).checkForUpdate({ feedUrl: feed, currentVersion: PKG.version }); }
    catch (e) { throw new CliError(`Could not check for updates: ${e.message}. Check this computer can reach ${new URL(feed).host}, or set UPDATE_FEED_URL to a county mirror.`); }
    const rec = { checked_at: new Date().toISOString(), current: r.current, latest: r.latest, available: r.available, url: r.url, feed };
    try { fs.writeFileSync(path.join(dir, 'update-check.json'), JSON.stringify(rec, null, 2) + '\n'); } catch {}
    console.log(r.available ? `SUDS ${r.latest} is available (this is ${r.current}): ${r.url || ''}\nDownload suds-${r.latest}-windows-x64.zip and its .sha256 file, then: suds update --from <the zip>` : `SUDS ${r.current} is the newest release.`);
    return EXIT.OK;
  }
  if (!p.opts.from) { process.stdout.write(helpText('update')); return EXIT.USAGE; }
  needWindows('Installing a Windows release');
  needElevated('update --from', exec);
  return applyUpdate({ zipPath: path.resolve(p.opts.from), dataDir: dir, allowDowngrade: !!p.opts['allow-downgrade'], exec });
}

/** Check a downloaded Windows zip against the .sha256 file beside it and read what it holds. */
function checkRelease(zipPath) {
  if (!fs.existsSync(zipPath)) throw new CliError(`There is no file ${zipPath}.`);
  const bytes = fs.readFileSync(zipPath);
  const sumFile = `${zipPath}.sha256`;
  if (!fs.existsSync(sumFile)) throw new CliError(`${path.basename(sumFile)} is missing beside the zip. Download it from the same release and put it in the same folder, so the zip can be checked.`);
  const want = (fs.readFileSync(sumFile, 'utf8').match(/^[0-9a-fA-F]{64}/) || [])[0];
  const have = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!want || want.toLowerCase() !== have) throw new CliError(`${path.basename(zipPath)} does not match its checksum file: it is damaged or not the released file. Download both again.`);
  const entries = require('./zip').readZip(bytes);
  const pkg = entries.find((e) => e.name === 'app/package.json');
  if (!pkg || !entries.some((e) => e.name === 'suds.exe') || !entries.some((e) => e.name === 'app/scripts/windows/cli.js')) throw new CliError(`${path.basename(zipPath)} is not a SUDS Windows release (no suds.exe and app folder in it).`);
  return { entries, version: JSON.parse(pkg.data().toString('utf8')).version };
}

async function applyUpdate({ zipPath, dataDir, allowDowngrade, exec }) {
  const inst = installDir();
  const { entries, version } = checkRelease(zipPath);
  const { compareVersions } = require(path.join(ROOT, 'server', 'update.js'));
  if (compareVersions(version, PKG.version) < 0 && !allowDowngrade) throw new CliError(`${path.basename(zipPath)} is SUDS ${version}, older than this ${PKG.version}. A database migrated by a newer release may not open in an older one; restore a backup instead (docs\\WINDOWS-SERVER.md, "Updates").`);
  console.log(`Updating SUDS ${PKG.version} to ${version} in ${inst}.`);
  console.log('Taking a backup first...');
  const b = runScriptChild('backup.js', [], { dataDir });
  if (b.status !== 0) throw new CliError('The backup before the update failed, so nothing was changed. See the message above.');
  const q = svc.query(exec);
  const wasRunning = q.installed && q.state === 'running';
  if (wasRunning) {
    mustRun(exec('sc.exe', ['stop', svc.SERVICE_ID]), 'Stopping the service');
    const after = await svc.waitFor('stopped', { exec });
    if (after.state !== 'stopped') throw new CliError('The SUDS service did not stop, so nothing was changed. See suds logs --errors.');
  }
  // app\ → app.previous (one kept), the new app\ written beside it, then renamed into place.
  const app = path.join(inst, 'app'); const prev = path.join(inst, 'app.previous'); const next = path.join(inst, 'app.new');
  fs.rmSync(next, { recursive: true, force: true });
  for (const e of entries) {
    if (!e.name.startsWith('app/')) continue;
    const to = path.join(next, ...e.name.slice(4).split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, e.data());
  }
  fs.rmSync(prev, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.renameSync(app, prev); fs.renameSync(next, app);
  // The executables: a running exe cannot be overwritten on Windows, but it can be renamed aside.
  for (const name of ['suds.exe', svc.WRAPPER_EXE, 'README-WINDOWS.txt', 'THIRD-PARTY-NOTICES.txt']) {
    const e = entries.find((x) => x.name === name); if (!e) continue;
    const to = path.join(inst, name); const data = e.data();
    if (fs.existsSync(to) && fs.readFileSync(to).equals(data)) continue;
    if (/\.exe$/.test(name) && fs.existsSync(to)) { const old = `${to}.old`; fs.rmSync(old, { force: true }); fs.renameSync(to, old); }
    fs.writeFileSync(to, data);
  }
  console.log(`Installed SUDS ${version}. The previous app folder is kept as ${prev}.`);
  if (wasRunning) {
    mustRun(exec('sc.exe', ['start', svc.SERVICE_ID]), 'Starting the service');
    const after = await svc.waitFor('running', { exec });
    if (after.state !== 'running') throw new CliError(`SUDS ${version} did not start. Roll back: suds service stop, rename app to app.failed and app.previous to app, then suds service start (docs\\WINDOWS-SERVER.md, "Updates").`);
    const where = await waitHealthy(dataDir);
    console.log(where ? `The SUDS service is running ${version}: ${where.url}` : 'The service is running; SUDS does not answer yet: check suds status in a minute.');
  } else console.log('Start it again: suds service start (or suds start).');
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------------------
// The thin wrappers
// ---------------------------------------------------------------------------------------------------------------
/** A password typed without echo (the terminal's raw mode). Resolves with what was typed. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { reject(new CliError('No terminal to type the password in. Set SUDS_ADMIN_PASSWORD instead.', EXIT.USAGE)); return; }
    process.stdout.write(prompt);
    let s = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (err) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); if (err) reject(err); else resolve(s); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new CliError('Cancelled.', EXIT.FAILED));
        if (ch === '\u0008' || ch === '\u007f') s = s.slice(0, -1); else if (ch >= ' ') s += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function cmdCreateAdmin(p) {
  const { dir } = resolveDataDir({ flag: p.opts.data });
  if (p.positional[0]) process.env.SUDS_ADMIN_USERNAME = p.positional[0];
  if (!process.env.SUDS_ADMIN_PASSWORD) {
    const a = await askHidden(`New password for "${process.env.SUDS_ADMIN_USERNAME || 'guest'}" (at least 12 characters; not shown): `);
    const b = await askHidden('The same password again: ');
    if (a !== b) throw new CliError('The two passwords are not the same. Run suds create-admin again.');
    process.env.SUDS_ADMIN_PASSWORD = a;
  }
  runScript('create-admin.js', [], dir);
  return undefined;
}

function passthrough(script, { needsData = true } = {}) {
  return async (p) => { runScript(script, p.rest, needsData ? resolveDataDir({ flag: p.opts.data }).dir : null); return undefined; };
}

async function cmdComplianceCheck(p) {
  if (process.platform === 'win32') {
    console.log(['The host compliance check (suds compliance-check) is for Linux servers only: it reads systemd, file modes and the', 'firewall, which Windows does not have. Nothing is wrong with this server because of that.',
      'The in-app checks still apply: sign in as an administrator and open Settings -> Security status, and Settings -> Compliance.',
      'For this Windows server, docs\\WINDOWS-SERVER.md, "Hardening checklist", lists what to check by hand (BitLocker, the firewall rule, folder permissions).'].join('\n'));
    return EXIT.UNSUPPORTED;
  }
  return passthrough('compliance-check.js')(p);
}

async function cmdOpen(p) {
  const { dir } = resolveDataDir({ flag: p.opts.data });
  const where = listenSettings(dir);
  console.log(`Opening ${where.url}`);
  openBrowser(where.url);
  return EXIT.OK;
}

function cmdVersion(p) {
  const v = { version: PKG.version, node: process.versions.node, platform: `${process.platform}-${process.arch}`, exe: process.env.SUDS_EXE || null, app_dir: ROOT };
  console.log(p.opts.json ? JSON.stringify(v) : `SUDS ${v.version} (Node.js ${v.node}, ${v.platform})`);
  return EXIT.OK;
}

const HANDLERS = {
  default: (p) => cmdStart(p, { browser: true }), start: (p) => cmdStart(p, { browser: false }), try: cmdTry, status: cmdStatus, service: cmdService,
  logs: cmdLogs, open: cmdOpen, version: cmdVersion, update: cmdUpdate, 'create-admin': cmdCreateAdmin, 'compliance-check': cmdComplianceCheck,
  backup: passthrough('backup.js'), 'dr-drill': passthrough('dr-drill.js'), 'reset-admin': passthrough('reset-admin.js'),
  'verify-audit-export': passthrough('verify-audit-export.js', { needsData: false }),
};

/** Runs one command. Resolves with an exit code, or undefined for a command that keeps running (the server, --follow). */
async function main(argv) {
  const p = parseArgs(argv);
  if (p.cmd === 'help') { process.stdout.write(helpText(p.positional[0] ? (ALIASES[p.positional[0]] || p.positional[0]) : null)); return EXIT.OK; }
  if (p.help) { process.stdout.write(helpText(p.cmd)); return EXIT.OK; }
  return HANDLERS[p.cmd](p);
}

/** The command line: errors as one plain sentence; a double-clicked window waits before it closes on an error. */
function cli(argv = process.argv.slice(2)) {
  const doubleClicked = argv.length === 0 && process.platform === 'win32' && process.stdin.isTTY;
  const fail = (code) => {
    process.exitCode = code;
    if (doubleClicked && code) { process.stdout.write('\nPress Enter to close this window.'); process.stdin.resume(); process.stdin.once('data', () => process.exit(code)); }
  };
  main(argv).then((code) => { if (typeof code === 'number') { if (code && doubleClicked) fail(code); else process.exitCode = code; } }, (e) => {
    if (e instanceof CliError) { console.error(e.message); fail(e.code); return; }
    console.error(`SUDS stopped because of an unexpected error: ${(e && e.message) || e}. Run "suds logs --errors" for details, and report it with "suds version".`);
    if (e && e.stack && process.env.SUDS_DEBUG) console.error(e.stack);
    fail(EXIT.FAILED);
  });
}

module.exports = {
  EXIT, CliError, COMMANDS, SPECS, parseArgs, helpText, resolveDataDir, tryDataDir, installDir, listenSettings, readDotEnv, statusReport, statusText,
  logEntries, isError, tailLogs, serverLogFiles, checkRelease, openBrowser, main, DEFAULT_FEED, ROOT,
};
if (require.main === module) cli();
