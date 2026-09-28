'use strict';
// A restore sets the live database aside (its undo) and then seals that copy with the backup key. Until 1.16.0
// a failed seal was one warning line in the log and the whole database stayed beside the live one in plaintext
// until the next start. Now the copy is named on Settings → Security status and by /api/health, with what to
// do, and housekeeping tries the seal again every hour.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-aside-seal-'));
Object.assign(process.env, {
  SUDS_ENV: 'test', SUDS_DATA_DIR: dir, SUDS_DB_PATH: path.join(dir, 'suds.db'),
  SUDS_ENCRYPTION_KEY: '33'.repeat(32), SUDS_INDEX_KEY: '44'.repeat(32),
  SUDS_ADMIN_USERNAME: 'admin', SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x', MFA_REQUIRED_ROLES: '',
});
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const db = require('../server/db');
const backup = require('../server/backup');

let server; let base; let cookie = '';
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
};
before(async () => {
  db.open();
  require('../server/bootstrap').ensureBootstrap();
  db.run(`UPDATE users SET must_change_password=0`);
  server = http.createServer(require('../server/app').createHandler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const statusItem = async () => {
  if (!cookie) assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPassw0rd!x' })).status, 200);
  const r = await call('GET', '/api/admin/security/status');
  assert.equal(r.status, 200);
  return r.data.items.find((i) => i.name === 'Unencrypted database copies');
};

test('a restore whose undo copy cannot be sealed is reported by name, and the hourly housekeeping seals it', async () => {
  const before0 = await statusItem();
  assert.equal(before0.level, 'ok', 'nothing to report to begin with');
  assert.deepEqual(db.plaintextCopies(), []);

  // The seal fails (a full disk, say): writing the sealed copy is refused.
  const openSync = fs.openSync;
  fs.openSync = function (p, flags, ...rest) {
    if (flags === 'wx' && /\.before-restore-[^/]+\.enc$/.test(String(p))) { const e = new Error(`ENOSPC: no space left on device, open '${p}'`); e.code = 'ENOSPC'; throw e; }
    return openSync.call(this, p, flags, ...rest);
  };
  let out;
  try { out = backup.restore(backup.decrypt(backup.create())); } finally { fs.openSync = openSync; }
  assert.doesNotMatch(out.previous_database_kept_at, /\.enc$/, 'the restore took; its undo copy is still plain');
  assert.equal(fs.readFileSync(out.previous_database_kept_at).subarray(0, 15).toString(), 'SQLite format 3');
  const file = path.basename(out.previous_database_kept_at);

  const plain = db.plaintextCopies();
  assert.equal(plain.length, 1);
  assert.equal(plain[0].file, file); assert.equal(plain[0].kind, 'restore');
  assert.match(plain[0].error.error, /ENOSPC/, 'why it failed is kept');

  // Settings → Security status names the file, says why and what to do.
  const item = await statusItem();
  assert.equal(item.level, 'bad');
  assert.match(item.value, new RegExp(`1 not encrypted: ${file.replace(/[.]/g, '\\.')}`));
  assert.ok(item.detail.includes(out.previous_database_kept_at), 'the full path, for the administrator');
  assert.match(item.detail, /sealing it failed: ENOSPC/);
  assert.match(item.detail, /tries again every hour/);
  assert.match(item.detail, /delete it securely/);
  // /api/health says "not ok" to whatever monitors it, naming the file (not its path).
  const h = await call('GET', '/api/health');
  assert.equal(h.status, 503);
  const w = (h.data.warnings || []).find((x) => x.includes(file));
  assert.ok(w, JSON.stringify(h.data));
  assert.match(w, /is not encrypted: sealing it failed/);
  assert.ok(!w.includes(dir), 'no directory path to an unauthenticated caller');

  // The next housekeeping pass (server/index.js, hourly) seals it; the reports clear.
  assert.deepEqual(db.sealPlaintextCopies(), []);
  assert.ok(!fs.existsSync(out.previous_database_kept_at), 'the plaintext copy is gone');
  assert.equal(backup.decrypt(fs.readFileSync(`${out.previous_database_kept_at}.enc`)).subarray(0, 15).toString(), 'SQLite format 3', 'sealed beside it');
  assert.equal((await statusItem()).level, 'ok');
  const h2 = await call('GET', '/api/health');
  assert.ok(!(h2.data.warnings || []).some((x) => x.includes(file)));
});

test('a pre-migration snapshot left plain is reported and sealed the same way; a restore in progress is not reported', () => {
  const snaps = path.join(dir, 'pre-migration'); fs.mkdirSync(snaps, { recursive: true });
  const snap = path.join(snaps, 'suds.db.v47-2026-09-01.db');
  fs.copyFileSync(process.env.SUDS_DB_PATH, snap);
  // The sealed name is taken by a directory, so the seal fails and is retried.
  fs.mkdirSync(`${snap}.enc`);
  assert.deepEqual(db.sealPlaintextCopies().map((p) => [p.file, p.kind]), [['suds.db.v47-2026-09-01.db', 'snapshot']]);
  assert.ok(db.plaintextCopies()[0].error, 'the failure is recorded');
  fs.rmdirSync(`${snap}.enc`);
  assert.deepEqual(db.sealPlaintextCopies(), []);
  assert.ok(fs.existsSync(`${snap}.enc`) && !fs.existsSync(snap));
  // While a restore holds the lock, its own aside is plain on purpose (its rollback needs it): not a finding.
  const aside = `${process.env.SUDS_DB_PATH}.before-restore-2026-09-28T00-00-00-000Z`;
  fs.copyFileSync(process.env.SUDS_DB_PATH, aside);
  const lock = require('../server/backup-lock');
  const held = lock.current; lock.current = () => ({ name: 'restore' });
  try { assert.deepEqual(db.plaintextCopies(), []); } finally { lock.current = held; }
  assert.equal(db.plaintextCopies().length, 1);
  assert.deepEqual(db.sealPlaintextCopies(), []);
});

test('housekeeping retries the seal every hour, not only at the next start', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const hk = src.slice(src.indexOf('function housekeeping()'), src.indexOf('setInterval(housekeeping'));
  assert.match(hk, /db\.sealPlaintextCopies\(\)/);
  assert.match(src, /setInterval\(housekeeping, 3600_000\)/);
});
