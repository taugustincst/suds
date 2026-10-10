'use strict';
// The suds command line of the Windows server (scripts/windows/cli.js, service.js, sea-main.js, zip.js, pe.js;
// docs/WINDOWS-SERVER.md). Everything Windows-specific goes through injected commands, so all of it runs on Linux
// here; the real thing is exercised on windows-2025 by ci.yml's windows-exe job (scripts/windows/smoke-test.ps1).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const C = require('../scripts/windows/cli');
const S = require('../scripts/windows/service');
const B = require('../scripts/windows/sea-main');
const Z = require('../scripts/windows/zip');
const PE = require('../scripts/windows/pe');
const CLI = path.join(ROOT, 'scripts', 'windows', 'cli.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `suds-win-${p}-`));
const run = (args, env = {}) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args], { encoding: 'utf8', env: { ...process.env, SUDS_DATA_DIR: '', ...env } });

test('arguments: commands, aliases, options with a space or =, and a wrong command line exits 2 with one sentence', () => {
  assert.deepEqual(C.parseArgs([]), { cmd: 'default', opts: {}, positional: [], rest: [], help: false });
  assert.equal(C.parseArgs(['serve']).cmd, 'start');
  assert.equal(C.parseArgs(['--version']).cmd, 'version');
  assert.equal(C.parseArgs(['/?']).cmd, 'help');
  assert.deepEqual(C.parseArgs(['start', '--data', 'D:\\SUDS', '--port=8443', '--service']).opts, { data: 'D:\\SUDS', port: 8443, service: true });
  assert.deepEqual(C.parseArgs(['--data', 'x']).opts, { data: 'x' }, 'options without a command: the default command');
  assert.deepEqual(C.parseArgs(['try', '--reset', '--port', '9001']).opts, { reset: true, port: 9001 });
  assert.deepEqual(C.parseArgs(['logs', '--follow', '--lines', '5', '--errors']).opts, { follow: true, lines: 5, errors: true });
  assert.equal(C.parseArgs(['status', '--help']).help, true);
  assert.equal(C.parseArgs(['service', '-h']).help, true, 'help needs no subcommand');
  assert.deepEqual(C.parseArgs(['service', 'install', '--data', 'C:\\x']).positional, ['install']);
  assert.deepEqual(C.parseArgs(['create-admin', 'ana']).positional, ['ana']);
  // Passed through to the script, except --data.
  const b = C.parseArgs(['backup', '--restore', 'f.enc', '--data', 'D:\\d', 'out.db']);
  assert.deepEqual(b.rest, ['--restore', 'f.enc', 'out.db']); assert.equal(b.opts.data, 'D:\\d');
  assert.deepEqual(C.parseArgs(['reset-admin', 'guest']).rest, ['guest']);
  const bad = {
    'nosuch': /"nosuch" is not a SUDS command\. Run "suds help"/,
    'status --jsno': /"--jsno" is not an option of suds status \(it takes --data <value>, --json\)/,
    'start --port': /--port needs a value/,
    'start --port 0': /--port must be a number from 1 to 65535/,
    'try --port http': /--port must be a number/,
    'logs --lines -3': /--lines needs a value|--lines must be a whole number/,
    'logs --lines 0': /--lines must be a whole number/,
    'service': /Say what to do with the service/,
    'service reboot': /"reboot" is not a service command/,
    'version --data x': /not an option of suds version/,
  };
  for (const [line, re] of Object.entries(bad)) {
    assert.throws(() => C.parseArgs(line.split(' ')), (e) => e instanceof C.CliError && e.code === C.EXIT.USAGE && re.test(e.message), line);
  }
});

test('help: every command has a usage line and a summary; the overall help lists them all, and the exit codes', () => {
  const all = C.helpText();
  for (const [name, c] of Object.entries(C.COMMANDS)) {
    assert.ok(c.usage.startsWith('suds'), `${name} usage`); assert.ok(c.summary.length > 10, `${name} summary`);
    assert.ok(all.includes(name === 'default' ? '(no command)' : `  ${name} `), `suds help lists ${name}`);
    const h = C.helpText(name);
    assert.match(h, /^Usage: suds/); assert.match(h, /Exit codes: 0 done; 1 failed .* 2 the command line was wrong; 3 .* 4 needs an elevated .* 5 not available/s);
    assert.ok(C.SPECS[name], `${name} has an argument spec`);
  }
  assert.deepEqual(Object.keys(C.SPECS).filter((k) => k !== 'help').sort(), Object.keys(C.COMMANDS).sort(), 'a spec for every command and nothing else');
  assert.match(C.helpText('service'), /NT SERVICE\\SUDS/); assert.match(C.helpText('service'), /Run as administrator/);
  assert.match(C.helpText('logs'), /8 MB.*30 days/s);
  assert.match(C.helpText('status'), /never goes to the internet/);
  for (const h of [C.helpText(), ...Object.keys(C.COMMANDS).map((n) => C.helpText(n))]) for (const l of h.split('\n')) assert.ok(l.length <= 140, `help line too long: ${l}`);
});

test('the command line run with Node: help, version, a wrong command (exit 2), the service and the host check off Windows (exit 5)', () => {
  let r = run(['help']); assert.equal(r.status, 0); assert.match(r.stdout, /Windows service\n {2}service/);
  r = run(['status', '--help']); assert.equal(r.status, 0); assert.match(r.stdout, /^Usage: suds status/);
  r = run(['version', '--json']); assert.equal(r.status, 0);
  const v = JSON.parse(r.stdout); assert.equal(v.version, require('../package.json').version); assert.equal(v.node, process.versions.node);
  r = run(['frobnicate']); assert.equal(r.status, 2); assert.equal(r.stderr.trim(), '"frobnicate" is not a SUDS command. Run "suds help" to see the commands.');
  if (process.platform !== 'win32') {
    r = run(['service', 'status']); assert.equal(r.status, 5); assert.match(r.stderr, /exists only on Windows/);
    r = run(['update', '--from', 'x.zip']); assert.equal(r.status, 5);
  }
});

test('the data folder: --data, SUDS_DATA_DIR, a data folder beside suds.exe, then %ProgramData%\\SUDS', () => {
  const W = { platform: 'win32', install: 'C:\\Program Files\\SUDS', exists: () => false };
  assert.deepEqual(C.resolveDataDir({ ...W, flag: 'D:\\SUDS-data', env: {} }), { dir: 'D:\\SUDS-data', source: 'the --data option' });
  assert.deepEqual(C.resolveDataDir({ ...W, env: { SUDS_DATA_DIR: 'E:\\s' } }), { dir: 'E:\\s', source: 'SUDS_DATA_DIR' });
  assert.deepEqual(C.resolveDataDir({ ...W, env: { ProgramData: 'C:\\ProgramData' } }), { dir: 'C:\\ProgramData\\SUDS', source: 'the default (%ProgramData%\\SUDS)' });
  assert.equal(C.resolveDataDir({ ...W, env: {} }).dir, 'C:\\ProgramData\\SUDS', 'ProgramData unset: the usual place');
  const portable = C.resolveDataDir({ ...W, env: { ProgramData: 'C:\\ProgramData' }, exists: (p) => p === 'C:\\Program Files\\SUDS\\data' });
  assert.deepEqual(portable, { dir: 'C:\\Program Files\\SUDS\\data', source: 'the data folder beside suds.exe' });
  assert.equal(C.resolveDataDir({ platform: 'linux', install: '/opt/suds', env: {}, exists: () => false }).dir, '/opt/suds/data');
  // The folder suds.exe is in comes from the bootstrap (SUDS_EXE); with plain Node it is the app folder.
  assert.equal(C.installDir({ SUDS_EXE: path.join('/srv', 'SUDS', 'suds.exe') }), path.join('/srv', 'SUDS'));
  assert.equal(C.installDir({}), ROOT);
  // The test copy: data-try beside suds.exe, else %LOCALAPPDATA%\SUDS\data-try.
  assert.equal(C.tryDataDir({ install: '/x', writable: () => true, env: {} }), path.join('/x', 'data-try'));
  assert.equal(C.tryDataDir({ install: '/x', writable: () => false, env: { LOCALAPPDATA: '/home/u/AppData/Local' } }), path.join('/home/u/AppData/Local', 'SUDS', 'data-try'));
});

test('where the server listens: the environment, then <data>\\.env, then server.json, then 8080 on this computer', () => {
  const dir = tmp('listen');
  try {
    assert.deepEqual(C.listenSettings(dir, {}), { scheme: 'http', host: '127.0.0.1', port: 8080, setupComplete: false, probe: 'http://127.0.0.1:8080', url: 'http://localhost:8080', updateFeed: '' });
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ setupComplete: true, host: '0.0.0.0', port: 443, tls: 'selfsigned' }));
    fs.mkdirSync(path.join(dir, 'certs')); fs.writeFileSync(path.join(dir, 'certs', 'suds.crt'), 'x');
    assert.deepEqual(C.listenSettings(dir, {}), { scheme: 'https', host: '0.0.0.0', port: 443, setupComplete: true, probe: 'https://127.0.0.1:443', url: 'https://localhost', updateFeed: '' });
    fs.writeFileSync(path.join(dir, '.env'), '# settings\nPORT=8443\nUPDATE_FEED_URL="https://mirror.county.gov/suds"\n');
    const s = C.listenSettings(dir, {});
    assert.equal(s.port, 8443); assert.equal(s.url, 'https://localhost:8443'); assert.equal(s.updateFeed, 'https://mirror.county.gov/suds');
    assert.equal(C.listenSettings(dir, { PORT: '9000' }).port, 9000, 'the environment wins, as in server/config.js');
    assert.equal(C.listenSettings(dir, { HOST: '10.1.2.3' }).probe, 'https://10.1.2.3:8443');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const SC_RUNNING = 'SERVICE_NAME: SUDS \r\n        TYPE               : 10  WIN32_OWN_PROCESS  \r\n        STATE              : 4  RUNNING \r\n                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)\r\n';
const SC_QC = '[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: SUDS\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        START_TYPE         : 2   AUTO_START  (DELAYED)\r\n        BINARY_PATH_NAME   : "C:\\Program Files\\SUDS\\suds-service.exe"\r\n        SERVICE_START_NAME : NT SERVICE\\SUDS\r\n';
const SC_MISSING = '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n';

test('the service: sc.exe answers read, elevation from whoami /groups, the folder permissions', () => {
  assert.deepEqual(S.parseQuery({ status: 0, stdout: SC_RUNNING, stderr: '' }), { installed: true, state: 'running' });
  assert.deepEqual(S.parseQuery({ status: 1060, stdout: SC_MISSING, stderr: '' }), { installed: false, state: 'not installed' });
  assert.equal(S.parseQuery({ status: 0, stdout: SC_RUNNING.replace('4  RUNNING', '1  STOPPED'), stderr: '' }).state, 'stopped');
  assert.equal(S.parseQuery({ status: 5, stdout: '', stderr: 'Access is denied.' }).installed, null);
  assert.deepEqual(S.parseConfig({ status: 0, stdout: SC_QC }), { account: 'NT SERVICE\\SUDS', startType: 'automatic (delayed start)', command: '"C:\\Program Files\\SUDS\\suds-service.exe"' });
  const exec = (out) => () => ({ status: 0, stdout: out, stderr: '' });
  assert.equal(S.isElevated(exec('Mandatory Label\\High Mandatory Level Label S-1-16-12288')), true);
  assert.equal(S.isElevated(exec('Mandatory Label\\Medium Mandatory Level Label S-1-16-8192')), false);
  assert.equal(S.isElevated(() => ({ status: 1, stdout: '', stderr: '' })), false);
  const q = S.query((cmd, a) => ({ status: 0, stdout: a[0] === 'query' ? SC_RUNNING : SC_QC, stderr: '' }));
  assert.deepEqual(q, { installed: true, state: 'running', account: 'NT SERVICE\\SUDS', startType: 'automatic (delayed start)', command: '"C:\\Program Files\\SUDS\\suds-service.exe"' });
  const [data, prog] = S.permissionCommands({ dataDir: 'C:\\ProgramData\\SUDS', installDir: 'C:\\Program Files\\SUDS' });
  assert.deepEqual(data, ['icacls', ['C:\\ProgramData\\SUDS', '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', 'NT SERVICE\\SUDS:(OI)(CI)M']], 'Administrators, SYSTEM and the service account only: nothing inherited from ProgramData');
  assert.deepEqual(prog, ['icacls', ['C:\\Program Files\\SUDS', '/grant', 'NT SERVICE\\SUDS:(OI)(CI)RX']]);
  // A fatal stop's Event Log entry: the message travels in the environment, never on the command line.
  let seen; S.writeEvent('SUDS stopped; it\'s "quoted"', { exec: (c, a, o) => { seen = { c, a, env: o.env.SUDS_EVENT_MESSAGE }; return { status: 0 }; } });
  assert.equal(seen.c, 'powershell.exe'); assert.match(seen.a.join(' '), /Write-EventLog -LogName Application -Source 'SUDS' -EventId 1001 -EntryType Error -Message \$env:SUDS_EVENT_MESSAGE/);
  assert.ok(!seen.a.join(' ').includes('quoted')); assert.equal(seen.env, 'SUDS stopped; it\'s "quoted"');
});

test('the WinSW configuration: id SUDS, suds.exe start --service, NT SERVICE\\SUDS, restart on failure, delayed start, rolled logs', () => {
  const x = S.serviceXml({ dataDir: 'C:\\ProgramData\\SUDS', version: '1.24.0' });
  const one = (tag) => { const m = x.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m && m[1]; };
  assert.equal(one('id'), 'SUDS'); assert.equal(one('name'), 'SUDS');
  assert.match(one('description'), /SUDS office server 1\.24\.0/);
  assert.equal(one('executable'), '%BASE%\\suds.exe');
  assert.equal(one('arguments'), 'start --service --data "C:\\ProgramData\\SUDS"');
  assert.equal(one('workingdirectory'), 'C:\\ProgramData\\SUDS');
  assert.equal(one('startmode'), 'Automatic'); assert.equal(one('delayedAutoStart'), 'true');
  assert.match(x, /<serviceaccount>\s*<domain>NT SERVICE<\/domain>\s*<user>SUDS<\/user>\s*<\/serviceaccount>/);
  assert.ok(!/LocalSystem|<password>/.test(x), 'not LocalSystem, and no password');
  assert.deepEqual([...x.matchAll(/<onfailure action="(\w+)" delay="([^"]+)"\/>/g)].map((m) => [m[1], m[2]]), [['restart', '10 sec'], ['restart', '30 sec'], ['restart', '60 sec']]);
  assert.equal(one('resetfailure'), '1 hour');
  assert.equal(one('stoptimeout'), '30 sec', 'long enough for the clean stop (the listener closes within 3 s)');
  assert.equal(one('logpath'), 'C:\\ProgramData\\SUDS\\logs\\service');
  assert.match(x, /<log mode="roll-by-size">\s*<sizeThreshold>10240<\/sizeThreshold>\s*<keepFiles>8<\/keepFiles>\s*<\/log>/);
  assert.match(x, /<env name="SUDS_ENV" value="production"\/>/);
  assert.match(x, /^<\?xml version="1\.0" encoding="UTF-8"\?>\r\n/);
  assert.match(S.serviceXml({ dataDir: 'D:\\A&B <data>' }), /<arguments>start --service --data "D:\\A&amp;B &lt;data&gt;"<\/arguments>/, 'escaped');
  assert.throws(() => S.serviceXml({ dataDir: 'C:\\x" --evil' }), /cannot be used/);
  assert.throws(() => S.serviceXml({ dataDir: '' }), /cannot be used/);
  assert.equal(S.ACCOUNT, 'NT SERVICE\\SUDS'); assert.equal(S.EVENT_SOURCE, 'SUDS');
});

test('suds status: the JSON shape monitoring reads, from a fake Windows and a fake server', async () => {
  const dir = tmp('status');
  try {
    // A database with the scheduled backup's settings, a backup file, the last update check.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'suds.db'));
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('last_scheduled_backup_at', '2026-10-03T08:00:00.000Z');
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('last_scheduled_backup_status', 'ok (offsite copied)');
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('backup_schedule_hours', '4');
    db.close();
    fs.mkdirSync(path.join(dir, 'backups')); fs.writeFileSync(path.join(dir, 'backups', 'suds-2026-10-03T08-00-00-000Z.db.enc'), 'x');
    fs.mkdirSync(path.join(dir, 'logs')); fs.writeFileSync(path.join(dir, 'logs', 'suds-2026-10-03.log'), '');
    fs.writeFileSync(path.join(dir, 'update-check.json'), JSON.stringify({ checked_at: '2026-10-02T00:00:00Z', latest: '1.25.0', available: true, url: 'https://example.invalid/r', feed: 'f' }));
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ setupComplete: true, host: '0.0.0.0', port: 8443 }));
    const exec = (cmd, a) => ({ status: 0, stdout: a[0] === 'query' ? SC_RUNNING : SC_QC, stderr: '' });
    const urls = [];
    const fetchJson = async (u) => { urls.push(u); return { status: 200, json: { ok: true, uptime_seconds: 5, database: 'ok' } }; };
    const s = await C.statusReport({ dataFlag: dir, env: {}, platform: 'win32', exec, fetchJson });
    assert.deepEqual(Object.keys(s), ['version', 'node', 'exe', 'app_dir', 'data_dir', 'data_dir_source', 'data_dir_exists', 'service', 'server', 'logs', 'backup', 'disk', 'update']);
    assert.equal(s.version, require('../package.json').version);
    assert.deepEqual(s.service, { name: 'SUDS', installed: true, state: 'running', account: 'NT SERVICE\\SUDS', start_type: 'automatic (delayed start)' });
    assert.deepEqual(urls, ['http://127.0.0.1:8443/api/health'], 'its own health, on this computer, and nothing else');
    assert.equal(s.server.reachable, true); assert.equal(s.server.healthy, true); assert.equal(s.server.port, 8443); assert.equal(s.server.url, 'http://localhost:8443');
    assert.equal(s.backup.last_at, '2026-10-03T08:00:00.000Z'); assert.equal(s.backup.last_status, 'ok (offsite copied)'); assert.equal(s.backup.schedule_hours, 4);
    assert.equal(s.backup.newest_file, 'suds-2026-10-03T08-00-00-000Z.db.enc');
    assert.equal(s.logs.current, path.join(dir, 'logs', 'suds-2026-10-03.log'));
    assert.ok(Number.isFinite(s.disk.free_bytes) && s.disk.free_bytes > 0);
    assert.deepEqual(s.update, { checked_at: '2026-10-02T00:00:00Z', latest: '1.25.0', available: true, url: 'https://example.invalid/r', feed: 'f' });
    const text = C.statusText(s);
    for (const re of [/Service: +running, as NT SERVICE\\SUDS, automatic \(delayed start\)/, /Health: +OK/, /Last backup: +2026-10-03T08:00:00\.000Z, ok \(offsite copied\)/, /Update: +1\.25\.0 is available/, /Disk free: +\d/]) assert.match(text, re);
    // Not installed, not answering, and health warnings.
    const down = await C.statusReport({ dataFlag: dir, env: {}, platform: 'win32', exec: () => ({ status: 1060, stdout: SC_MISSING, stderr: '' }), fetchJson: async () => ({ status: 0, error: 'ECONNREFUSED' }) });
    assert.deepEqual(down.service, { name: 'SUDS', installed: false, state: 'not installed', account: null, start_type: null });
    assert.equal(down.server.reachable, false); assert.equal(down.server.error, 'ECONNREFUSED');
    assert.match(C.statusText(down), /Health: +not answering at http:\/\/localhost:8443 \(ECONNREFUSED\)/);
    const warn = await C.statusReport({ dataFlag: dir, env: {}, platform: 'win32', exec, fetchJson: async () => ({ status: 503, json: { ok: false, warnings: ['Scheduled backups are set for every 4 hours but the last one ran 2026-09-01.'] } }) });
    assert.equal(warn.server.healthy, false); assert.match(C.statusText(warn), /NOT OK \(HTTP 503\)\n +! Scheduled backups/);
    // 1.25.3: /api/health keeps its warnings from anonymous callers. suds status sends the server's METRICS_TOKEN when
    // it has one (here from the data folder's .env), and says where the reason is when it has none.
    const anon = await C.statusReport({ dataFlag: dir, env: {}, platform: 'win32', exec, fetchJson: async () => ({ status: 503, json: { ok: false, uptime_seconds: 5, database: 'ok' } }) });
    assert.match(C.statusText(anon), /NOT OK \(HTTP 503\)\n +! the reason is on Settings > Security status/);
    fs.writeFileSync(path.join(dir, '.env'), 'METRICS_TOKEN=scrape-token-1234\n');
    const seen = [];
    await C.statusReport({ dataFlag: dir, env: {}, platform: 'win32', exec, fetchJson: async (u, o) => { seen.push(o); return { status: 200, json: { ok: true } }; } });
    assert.deepEqual(seen, [{ token: 'scrape-token-1234' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('suds status --json run with Node: valid JSON, exit 1 when nothing answers, and no network but this computer', () => {
  const dir = tmp('status-cli');
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=1\n'); // nothing listens on port 1
    const r = run(['status', '--json', '--data', dir]);
    assert.equal(r.status, 1, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.data_dir, dir); assert.equal(s.server.reachable, false); assert.equal(s.server.port, 1);
    assert.equal(s.update.checked_at, null); assert.match(s.update.note, /suds update --check/);
    assert.equal(s.backup.read_error, undefined, 'no database yet is not an error');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('suds logs: today\'s file, the errors of every file with their stack traces, the service wrapper\'s logs', () => {
  const dir = tmp('logs');
  try {
    const L = path.join(dir, 'logs'); fs.mkdirSync(path.join(L, 'service'), { recursive: true });
    fs.writeFileSync(path.join(L, 'suds-2026-10-01.log'), '2026-10-01T10:00:00.000Z INFO [suds] listening\n2026-10-01T10:00:01.000Z ERROR [suds] uncaught exception: Error: boom\n    at x (server/a.js:1:1)\n    at y (server/b.js:2:2)\n');
    fs.writeFileSync(path.join(L, 'suds-2026-10-02.log.1759400000000.old'), '2026-10-02T01:00:00.000Z ERROR [suds] rolled aside\n');
    fs.writeFileSync(path.join(L, 'suds-2026-10-02.log'), [...Array(60).keys()].map((i) => `2026-10-02T02:00:${String(i).padStart(2, '0')}.000Z INFO [suds] line ${i}`).join('\n') + '\n{"time":"2026-10-02T03:00:00.000Z","level":"ERROR","msg":"[suds] json error"}\n');
    fs.writeFileSync(path.join(L, 'service', 'suds-service.err.log'), 'wrapper said no\n');
    fs.writeFileSync(path.join(L, 'service', 'suds-service.wrapper.log'), '2026-10-02 Starting\n');
    assert.deepEqual(C.serverLogFiles(L).map((f) => path.basename(f)), ['suds-2026-10-01.log', 'suds-2026-10-02.log.1759400000000.old', 'suds-2026-10-02.log']);
    const t = C.tailLogs(dir, { lines: 5 });
    assert.deepEqual(t.files, [path.join(L, 'suds-2026-10-02.log')]);
    assert.equal(t.entries.length, 5); assert.match(t.entries[4], /json error/);
    const e = C.tailLogs(dir, { errors: true });
    assert.deepEqual(e.entries.map((x) => { const l = x.split('\n')[0]; return l.startsWith('{') ? `JSON ${JSON.parse(l).msg}` : l.replace(/^\S+ /, ''); }), ['ERROR [suds] uncaught exception: Error: boom', 'ERROR [suds] rolled aside', 'JSON [suds] json error']);
    assert.match(e.entries[0], /\n {4}at y \(server\/b\.js:2:2\)$/, 'a stack trace stays with its entry');
    assert.equal(C.tailLogs(dir, { errors: true, lines: 1 }).entries.length, 1);
    const sv = C.tailLogs(dir, { service: true, errors: true });
    assert.deepEqual(sv.entries, ['suds-service.err.log: wrapper said no']);
    let r = run(['logs', '--lines', '2', '--data', dir]); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim().split('\n').length, 2);
    r = run(['logs', '--errors', '--data', dir]); assert.equal(r.status, 0); assert.match(r.stdout, /boom[\s\S]*The service wrapper's error output[\s\S]*wrapper said no/);
    r = run(['logs', '--data', path.join(dir, 'nowhere')]); assert.equal(r.status, 1); assert.match(r.stderr, /There is no data folder at .* yet, so no log\. Start SUDS first/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the bootstrap: finds app\\ beside suds.exe, runs only scripts inside it, and quiets only the ExperimentalWarning', () => {
  const W = path.win32;
  const have = new Set(['C:\\SUDS\\app\\package.json', 'C:\\SUDS\\app\\scripts\\windows\\cli.js']);
  const exists = (p) => have.has(p);
  assert.equal(B.locateApp('C:\\SUDS\\suds.exe', { env: {}, exists, P: W }), 'C:\\SUDS\\app');
  assert.equal(B.locateApp('D:\\elsewhere\\suds.exe', { env: {}, exists, P: W }), null, 'no app folder beside it');
  assert.equal(B.locateApp('D:\\elsewhere\\suds.exe', { env: { SUDS_APP_DIR: 'C:\\SUDS\\app' }, exists, P: W }), 'C:\\SUDS\\app', 'SUDS_APP_DIR first');
  assert.equal(B.locateApp('C:\\SUDS\\suds.exe', { env: {}, exists: (p) => p.endsWith('package.json'), P: W }), null, 'an app folder without the command line is incomplete');
  // How the server's child processes start: process.execPath (suds.exe) with a script path.
  const app = 'C:\\SUDS\\app'; const files = new Set(['C:\\SUDS\\app\\server\\dr-drill-child.js', 'C:\\SUDS\\app\\scripts\\seed.js', 'C:\\Users\\x\\evil.js']);
  const ex = (p) => files.has(p);
  assert.deepEqual(B.scriptToRun(['--no-warnings=ExperimentalWarning', 'C:\\SUDS\\app\\server\\dr-drill-child.js'], app, { exists: ex, P: W }), { file: 'C:\\SUDS\\app\\server\\dr-drill-child.js', args: [] });
  assert.deepEqual(B.scriptToRun(['C:\\SUDS\\app\\scripts\\seed.js', '--x'], app, { exists: ex, P: W }), { file: 'C:\\SUDS\\app\\scripts\\seed.js', args: ['--x'] });
  assert.deepEqual(B.scriptToRun(['c:\\suds\\APP\\scripts\\seed.js'], app, { exists: (p) => ex(p) || p === 'c:\\suds\\APP\\scripts\\seed.js', P: W }), { file: 'c:\\suds\\APP\\scripts\\seed.js', args: [] }, 'Windows paths compare without case');
  assert.equal(B.scriptToRun(['C:\\Users\\x\\evil.js'], app, { exists: ex, P: W }), null, 'not a script outside app\\');
  assert.equal(B.scriptToRun(['C:\\SUDS\\app\\..\\evil.js'], app, { exists: () => true, P: W }), null);
  assert.equal(B.scriptToRun(['C:\\SUDS\\app\\scripts\\gone.js'], app, { exists: ex, P: W }), null, 'only a file that exists');
  assert.equal(B.scriptToRun(['start', '--data', 'C:\\SUDS\\app\\x.js'], app, { exists: () => true, P: W }), null, 'an ordinary suds command');
  assert.equal(B.scriptToRun([], app, { exists: ex, P: W }), null);
  const seen = [];
  const proc = { emitWarning: (w, t) => seen.push([String(w), t && (t.type || t)]) };
  B.quietExperimentalWarnings(proc);
  proc.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
  proc.emitWarning('x', { type: 'ExperimentalWarning' });
  proc.emitWarning(Object.assign(new Error('e'), { name: 'ExperimentalWarning' }));
  proc.emitWarning('Buffer() is deprecated', 'DeprecationWarning');
  assert.deepEqual(seen, [['Buffer() is deprecated', 'DeprecationWarning']]);
});

test('zip: round trip, deterministic bytes, safe names only; and suds update --from checks the zip against its .sha256', () => {
  const entries = [{ name: 'suds.exe', data: Buffer.from('MZ fake') }, { name: 'app/package.json', data: JSON.stringify({ version: '9.9.9' }) }, { name: 'app/scripts/windows/cli.js', data: '//' }, { name: 'app/big.txt', data: 'a'.repeat(5000) }];
  const a = Z.writeZip(entries, { mtime: '2026-10-03T12:00:00Z' });
  assert.ok(a.equals(Z.writeZip(entries, { mtime: '2026-10-03T12:00:00Z' })), 'the same files give the same bytes');
  const back = Z.readZip(a);
  assert.deepEqual(back.map((e) => [e.name, e.data().toString()]), entries.map((e) => [e.name, String(e.data)]));
  for (const bad of ['../x', '/abs', 'a\\b', 'a//b']) assert.throws(() => Z.writeZip([{ name: bad, data: '' }]), /refusing the entry name/);
  assert.throws(() => Z.writeZip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /listed twice/);
  assert.throws(() => Z.readZip(Buffer.from('not a zip at all, not at all, really not')), /not a ZIP file/);
  const broken = Buffer.from(a); broken[40] ^= 0xff; // inside the first entry's (stored) data: 30-byte header, 8-byte name
  assert.throws(() => Z.readZip(broken).forEach((e) => e.data()), /damaged|invalid|incorrect/i);
  assert.deepEqual(Z.dosDateTime('1979-06-01T00:00:00Z').date >> 9, 0, 'before 1980 is 1980');
  const dir = tmp('update');
  try {
    const zip = path.join(dir, 'suds-9.9.9-windows-x64.zip');
    fs.writeFileSync(zip, a);
    assert.throws(() => C.checkRelease(zip), /\.sha256 is missing beside the zip/);
    fs.writeFileSync(`${zip}.sha256`, `${'0'.repeat(64)}  suds-9.9.9-windows-x64.zip\n`);
    assert.throws(() => C.checkRelease(zip), /does not match its checksum file/);
    fs.writeFileSync(`${zip}.sha256`, `${crypto.createHash('sha256').update(a).digest('hex')}  suds-9.9.9-windows-x64.zip\n`);
    assert.equal(C.checkRelease(zip).version, '9.9.9');
    const other = path.join(dir, 'other.zip'); const o = Z.writeZip([{ name: 'readme.txt', data: 'hi' }]);
    fs.writeFileSync(other, o); fs.writeFileSync(`${other}.sha256`, crypto.createHash('sha256').update(o).digest('hex'));
    assert.throws(() => C.checkRelease(other), /is not a SUDS Windows release/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Authenticode signature: found in the certificate table, removed, and a file that is not a PE refused', () => {
  // A minimal PE32+ header: e_lfanew 0x40, "PE\0\0", the COFF header, an optional header with 16 data directories.
  const opt = 0x40 + 24; const dirs = opt + 112; const end = dirs + 16 * 8;
  const body = Buffer.alloc(end + 64);
  body.write('MZ', 0, 'latin1'); body.writeUInt32LE(0x40, 0x3c); body.writeUInt32LE(0x00004550, 0x40);
  body.writeUInt16LE(0x20b, opt); body.writeUInt32LE(16, dirs - 4); body.writeUInt32LE(0x1234, opt + 64);
  const cert = Buffer.alloc(32, 7);
  body.writeUInt32LE(body.length, dirs + 32); body.writeUInt32LE(cert.length, dirs + 36);
  const signed = Buffer.concat([body, cert]);
  assert.deepEqual(PE.certificateTable(signed), { offset: body.length, size: 32, entry: dirs + 32, checksumField: opt + 64 });
  assert.equal(PE.isSigned(signed), true);
  const plain = PE.stripSignature(signed);
  assert.equal(plain.length, body.length); assert.equal(PE.isSigned(plain), false); assert.equal(plain.readUInt32LE(opt + 64), 0);
  assert.ok(PE.stripSignature(plain).equals(plain), 'an unsigned file is unchanged');
  assert.throws(() => PE.certificateTable(Buffer.from('#!/bin/sh\n'.padEnd(80))), /not a Windows executable/);
  assert.throws(() => PE.stripSignature(Buffer.concat([signed, Buffer.from('trailing')])), /certificate table runs past|data follows/);
});
