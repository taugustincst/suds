'use strict';
// `npm run try` (scripts/try-local.js, docs/TRY-ON-WINDOWS.md): SUDS on one computer for testing, with the
// fictional sample data. Run on Linux in `npm test`, and on windows-latest in CI (.github/workflows/ci.yml,
// "Windows: npm run try"), where it is the proof that the path a Windows tester takes works there.
//
// The smoke test starts the script as `npm run try` runs it (package.json's "try" is checked to be exactly that),
// in a temporary data folder on a free port, waits for /api/health, signs in with a sample account, lists clients
// and stops it the way Ctrl+C does. On Linux and macOS that is a real SIGINT. Windows cannot send a Ctrl+C to
// another process (process.kill there ends it outright), so the test asks the script over its IPC channel to raise
// SIGINT in itself: the same handler in server/index.js runs either way.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'try-local.js');
const T = require('../scripts/try-local');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Start the script; resolves once it reports it is listening. */
function start(args) {
  const child = fork(SCRIPT, args, { execArgv: ['--no-warnings=ExperimentalWarning'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`npm run try did not start in 90 s:\n${out}`)), 90000);
    child.on('message', (m) => { if (m && m.ready) { clearTimeout(timer); resolve(m); } });
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`npm run try exited (${code}) before it was ready:\n${out}`)); });
  });
  return { child, ready, exited, output: () => out };
}

/** Stop it the way Ctrl+C does (see the header). `twice`: the same Ctrl+C delivered twice, as npm and a terminal do. */
function ctrlC(child, { twice = false } = {}) {
  if (process.platform === 'win32') { child.send('suds-try:stop'); if (twice) child.send('suds-try:stop'); return; }
  child.kill('SIGINT'); if (twice) setTimeout(() => { try { child.kill('SIGINT'); } catch {} }, 20);
}

async function api(base, method, p, body, cookie) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json(), cookie: sc ? sc.split(';')[0] : cookie };
}

test('package.json: "npm run try" runs scripts/try-local.js, and "npm run dev" needs no POSIX shell', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.try, 'node --no-warnings=ExperimentalWarning scripts/try-local.js');
  assert.equal(pkg.scripts.dev, 'node scripts/dev.js');
  // An inline VAR=value prefix only works in sh: cmd.exe and PowerShell (npm's script shell on Windows) refuse it.
  for (const [name, cmd] of Object.entries(pkg.scripts)) assert.doesNotMatch(cmd, /(^|&&\s*|;\s*)[A-Z_][A-Z0-9_]*=\S/, `npm run ${name} sets a variable the POSIX way`);
});

test('npm run try: starts on 127.0.0.1 with the sample data, signs in, lists clients, stops on Ctrl+C, restarts without reseeding, and --reset deletes only its folder', { timeout: 240000 }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-try-'));
  const dir = path.join(parent, 'data-try');
  try {
    const port = await freePort();
    const run1 = start(['--port', String(port), '--data-dir', dir]);
    const ready = await run1.ready;
    assert.equal(ready.url, `http://localhost:${port}`);
    const base = `http://127.0.0.1:${port}`;
    const health = await api(base, 'GET', '/api/health');
    assert.equal(health.status, 200); assert.equal(health.data.ok, true);

    // What the banner says is what works.
    const out = run1.output();
    assert.match(out, new RegExp(`Open: +http://localhost:${port}`));
    assert.ok(out.includes(`Password for all of them: ${T.SAMPLE_PASSWORD}`));
    for (const a of T.SAMPLE_ACCOUNTS) assert.match(out, new RegExp(`\\n +${a.username} +${a.role}\\n`));
    assert.match(out, /Ctrl\+C/);
    assert.ok(out.includes(`npm run try -- --reset --port ${port} --data-dir "${dir}"`));
    assert.doesNotMatch(out, /Temporary password/, 'the bootstrap lines of the seed are not shown: the banner gives the password');

    let r = await api(base, 'POST', '/api/auth/login', { username: 'mrivera', password: T.SAMPLE_PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.user.role, 'navigator');
    const list = await api(base, 'GET', '/api/clients', undefined, r.cookie);
    assert.equal(list.status, 200);
    assert.ok(list.data.clients.length > 0, 'the sample clients are there');
    assert.ok(list.data.clients.every((c) => /^DEMO-/.test(c.client_code)), 'only the fictional sample clients');
    r = await api(base, 'POST', '/api/auth/login', { username: 'guest', password: T.SAMPLE_PASSWORD });
    assert.equal(r.status, 200, 'the administrator in the banner signs in with the same password');
    assert.equal(r.data.user.role, 'admin'); assert.equal(r.data.user.must_change_password, false);

    // A development server's keys, in its own folder; the folder is marked as this script's.
    for (const f of ['.dev-encryption-key', '.dev-index-key', '.dev-signing-key', 'suds.db', T.MARKER]) assert.ok(fs.existsSync(path.join(dir, f)), f);
    const seededAt = JSON.parse(fs.readFileSync(path.join(dir, T.MARKER), 'utf8')).seeded_at;
    assert.ok(seededAt);

    // A second start against the same folder, while the first runs, is refused with a sentence, not a stack.
    const dup = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', SCRIPT, '--port', String(await freePort()), '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(dup.status, 1); assert.match(dup.stderr, /already running from/);
    // And so is a reset of it.
    assert.throws(() => T.reset(dir), /still running/);

    ctrlC(run1.child);
    const ex1 = await run1.exited;
    assert.equal(ex1.code, 0, run1.output()); assert.match(run1.output(), /shutting down/);
    assert.ok(!fs.existsSync(path.join(dir, '.suds.lock')), 'a clean stop releases the instance lock');
    assert.ok(!fs.existsSync(path.join(dir, 'suds.db-wal')), 'and closes the database (its write-ahead log folded in)');

    // Started again: the same data, not seeded twice. Ctrl+C arriving twice at once still stops cleanly.
    const run2 = start(['--port', String(port), '--data-dir', dir]);
    await run2.ready;
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, T.MARKER), 'utf8')).seeded_at, seededAt);
    assert.doesNotMatch(run2.output(), /Created the data folder/);
    ctrlC(run2.child, { twice: true });
    const ex2 = await run2.exited;
    assert.equal(ex2.code, 0, run2.output());
    assert.ok(!fs.existsSync(path.join(dir, '.suds.lock')), 'the instance lock is released');
    assert.ok(!fs.existsSync(path.join(dir, 'suds.db-wal')), 'the second Ctrl+C did not cut the clean stop short: the database was closed');

    // --reset: an audit anchor is read-only once written (on Windows, the read-only attribute); it still goes.
    const anchors = fs.readdirSync(path.join(dir, 'audit-anchors'));
    assert.ok(anchors.length > 0);
    assert.equal(T.reset(dir), true);
    assert.ok(!fs.existsSync(dir));
    assert.ok(fs.existsSync(parent), 'only the try folder itself is removed');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('npm run try never uses or deletes a folder it did not make, and says when the port is taken', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-try-guard-'));
  try {
    const real = path.join(parent, 'data');
    fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'suds.db'), 'a real install');
    assert.equal(T.folderKind(real), 'other');
    assert.throws(() => T.reset(real), /was not made by "npm run try"/);
    assert.ok(fs.existsSync(path.join(real, 'suds.db')));
    await assert.rejects(T.run({ dataDir: real, port: await freePort() }), /did not make, so it will not use it/);
    assert.equal(T.reset(path.join(parent, 'nothing-here')), false);

    // A busy port: the message names it and how to choose another.
    const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const busy = s.address().port;
    try {
      const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', SCRIPT, '--port', String(busy), '--data-dir', path.join(parent, 't')], { encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`[Pp]ort ${busy}`)); // "already in use" (Windows may say the port is not allowed)
      assert.match(r.stderr, /npm run try -- --port \d+/);
    } finally { s.close(); }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('try-local: options, the Node version check, and the settings it sets aside', () => {
  assert.deepEqual(T.parseArgs([]), { port: 8080, reset: false, dataDir: T.DEFAULT_DIR, help: false });
  assert.equal(T.DEFAULT_DIR, path.join(ROOT, 'data-try'));
  const o = T.parseArgs(['--reset', '--port=9001', '--data-dir', 'x']);
  assert.equal(o.port, 9001); assert.equal(o.reset, true); assert.equal(o.dataDir, path.resolve('x'));
  assert.throws(() => T.parseArgs(['--port', '0']), /1 to 65535/);
  assert.throws(() => T.parseArgs(['--port']), /needs a value/);
  assert.throws(() => T.parseArgs(['--prod']), /Unknown option/);

  assert.equal(T.nodeVersionProblem('22.13.0'), null);
  assert.equal(T.nodeVersionProblem('24.1.0'), null);
  for (const v of ['22.12.0', '20.18.1', '18.0.0']) {
    const p = T.nodeVersionProblem(v);
    assert.match(p, /22\.13 or later/); assert.match(p, /winget install OpenJS\.NodeJS\.LTS/); assert.match(p, /nodejs\.org/);
  }

  // Nothing from a real install's environment reaches the try server.
  const env = T.tryEnv('/x/data-try', 8123, {
    PATH: '/bin', SUDS_ENV: 'production', SUDS_DB_PATH: '/var/lib/suds/suds.db', SUDS_ENCRYPTION_KEY_FILE: '/run/secrets/k', AUDIT_ANCHOR_DIR: '/mnt/worm',
    TLS_CERT_PATH: '/etc/c', CREDENTIALS_DIRECTORY: '/run/credentials/suds', HOST: '0.0.0.0', LOCAL_MODE_ENABLED: 'true', OIDC_ISSUER: 'https://idp', SEED_PASSWORD: 'x',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.SUDS_ENV, 'development'); assert.equal(env.SUDS_DATA_DIR, '/x/data-try'); assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.PORT, '8123');
  assert.equal(env.SEED_PASSWORD, T.SAMPLE_PASSWORD);
  for (const k of ['SUDS_DB_PATH', 'SUDS_ENCRYPTION_KEY_FILE', 'AUDIT_ANCHOR_DIR', 'TLS_CERT_PATH', 'CREDENTIALS_DIRECTORY', 'LOCAL_MODE_ENABLED', 'OIDC_ISSUER']) assert.equal(env[k], undefined, k);
});

test('the sample data it loads (scripts/seed.js) refuses a production database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-seed-prod-'));
  try {
    const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'seed.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, SUDS_ENV: 'production', SUDS_DATA_DIR: dir, SUDS_DB_PATH: '', SUDS_ENCRYPTION_KEY: '11'.repeat(32), SUDS_INDEX_KEY: '22'.repeat(32) },
    });
    assert.equal(r.status, 1); assert.match(r.stderr, /Refusing to seed a production database/);
    assert.ok(!fs.existsSync(path.join(dir, 'suds.db')), 'nothing was created');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
