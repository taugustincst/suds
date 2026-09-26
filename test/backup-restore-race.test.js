'use strict';
// A restore while a backup, snapshot or recovery drill is running (1.12.0 defect). The scheduled backup copies
// the live database with SQLite's online backup API over many turns of the event loop; a restore that swapped
// the file underneath it half-failed: the swap happened, then recording the new sync generation threw
// "database is locked", so the administrator saw an error although the restore had taken effect, devices were
// never told to re-offer what the backup lacked, the restore's audit anchor was not written (a later check read
// the restore as a rewritten chain), and the backup being written was corrupt. Backup, snapshot, drill, offsite
// copy and restore now share one lock (server/backup-lock.js); a restore waits for work in flight (bounded)
// or is refused with a 409, and its post-swap steps complete or the previous database is put back.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '11'.repeat(32);
process.env.SUDS_INDEX_KEY = '22'.repeat(32);
process.env.SUDS_ADMIN_PASSWORD = 'AdminPassw0rd!x';
process.env.MFA_REQUIRED_ROLES = '';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-restore-race-'));
process.env.SUDS_DATA_DIR = dir;
process.env.SUDS_DB_PATH = path.join(dir, 'suds.db');

const db = require('../server/db');
const backup = require('../server/backup');
const scheduled = require('../server/scheduled-backup');
const anchor = require('../server/audit-anchor');
const { encrypt, uuid } = require('../server/crypto');

let server, base, cookie = '';
let small;
async function req(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}

before(async () => {
  db.open();
  require('../server/bootstrap').ensureBootstrap();
  db.run(`UPDATE users SET must_change_password=0`);
  db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc) VALUES(?,?,?,?)`, uuid(), 'C26-0001', encrypt('Small'), encrypt('Backup'));
  require('../server/audit').log({ user: { username: 'system' }, action: 'test.before-backup' });
  small = backup.create();
  // Enough pages that the online backup (256 pages a step, yielding between steps) is still running when the
  // restore arrives: about 48 MB. The backup being restored is the small one taken above, so the request
  // itself is quick.
  const pad = 'x'.repeat(6000);
  db.transaction(() => {
    for (let i = 0; i < 8000; i++) db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,goals_enc) VALUES(?,?,?,?,?)`, uuid(), `C26-${10000 + i}`, encrypt('Race'), encrypt('Client'), encrypt(pad));
  });
  server = http.createServer(require('../server/app').createHandler());
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  await login();
});
// A restore signs everyone out (the restored database has its own sessions), so each test signs in afresh.
async function login() {
  cookie = '';
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'AdminPassw0rd!x' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
after(async () => { await new Promise((res) => server.close(res)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a restore called directly (the CLI) while a scheduled backup is running is refused before anything is swapped', async () => {
  const gen = db.getSetting('db_generation', null);
  const n = db.one(`SELECT COUNT(*) n FROM clients`).n;
  const running = scheduled.run({ retain: 5 });
  await new Promise((res) => setTimeout(res, 30));
  assert.throws(() => backup.restore(backup.decrypt(small)), (e) => e.code === 'EBUSY' && /backup is running/i.test(e.message));
  const made = await running;
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients`).n, n, 'the live database is untouched');
  assert.equal(db.getSetting('db_generation', null), gen);
  assert.equal(made.verified, true, `the backup was written whole and read back: ${made.verifyError}`);
});

test('a restore that arrives while a scheduled backup is running waits for it, then completes whole', async () => {
  const genBefore = db.getSetting('db_generation', null);
  const restoreAnchorsBefore = anchor.list().filter((f) => f.anchor.reason === 'restore').length;
  const running = scheduled.run({ retain: 5 });
  await new Promise((res) => setTimeout(res, 30));
  await login();
  const r = await req('POST', '/api/admin/restore', { file_b64: small.toString('base64'), password: 'AdminPassw0rd!x', confirm: 'REPLACE' });
  const made = await running;

  assert.equal(r.status, 200, `the administrator is told the restore worked: ${JSON.stringify(r.data)}`);
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients`).n, 1, 'the restored database is live');
  const genAfter = db.getSetting('db_generation', null);
  assert.ok(genAfter && genAfter !== genBefore, 'a new sync generation was recorded, so devices re-offer what the backup lacks');
  assert.equal(anchor.list().filter((f) => f.anchor.reason === 'restore').length, restoreAnchorsBefore + 1, 'the restore was anchored');
  assert.equal(anchor.verify().ok, true, 'and the chain verifies afterwards');
  assert.equal(made.verified, true, `the concurrent backup was written whole and read back: ${made.verifyError}`);
  const info = await backup.verifyFileAsync(made.file);
  assert.ok(info.counts.clients >= 8000, 'it holds the database as it was before the restore');
});

test('a restore is refused with a 409, untouched, while a recovery drill holds the lock beyond the wait', async () => {
  const lock = require('../server/backup-lock');
  const enc = backup.create();
  const gen = db.getSetting('db_generation', null);
  let release;
  const held = lock.run('dr-drill', () => new Promise((res) => { release = res; }));
  const prevWait = lock.restoreWaitMs; lock.restoreWaitMs = 200;
  try {
    await login();
    const r = await req('POST', '/api/admin/restore', { file_b64: enc.toString('base64'), password: 'AdminPassw0rd!x', confirm: 'REPLACE' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /recovery drill is running/i);
    assert.equal(db.getSetting('db_generation', null), gen, 'nothing was swapped');
  } finally { lock.restoreWaitMs = prevWait; release(); await held; }
});

test('timers pause during a restore: a snapshot or a due backup asked for meanwhile is skipped, not run on the swapped file', async () => {
  const lock = require('../server/backup-lock');
  let release;
  const held = lock.run('restore', () => new Promise((res) => { release = res; }));
  try {
    db.setSetting('backup_schedule_minutes', '5');
    db.setSetting('backup_schedule_hours', '1');
    db.run(`DELETE FROM settings WHERE key IN ('last_snapshot_at','last_scheduled_backup_at')`);
    assert.equal(await scheduled.snapshotIfDue(), null);
    assert.equal(await scheduled.runIfDue(), null);
    assert.equal(lock.paused(), true);
  } finally { release(); await held; db.run(`DELETE FROM settings WHERE key IN ('backup_schedule_minutes','backup_schedule_hours')`); }
  assert.equal(lock.paused(), false);
});

test('the post-swap steps complete or the restore is rolled back: an anchor that cannot be written puts the previous database back', async () => {
  const enc = backup.create();
  const marker = uuid();
  db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc) VALUES(?,?,?,?)`, marker, 'C26-KEEP', encrypt('Kept'), encrypt('Row'));
  const gen = db.getSetting('db_generation', null);
  const realWrite = anchor.write;
  anchor.write = () => { throw new Error('simulated anchor failure'); };
  try {
    await login();
    const r = await req('POST', '/api/admin/restore', { file_b64: enc.toString('base64'), password: 'AdminPassw0rd!x', confirm: 'REPLACE' });
    assert.ok(r.status >= 400, 'the administrator is told it failed');
    assert.match(r.data.error, /previous database was put back/);
  } finally { anchor.write = realWrite; }
  assert.ok(db.one(`SELECT 1 FROM clients WHERE id=?`, marker), 'serving the database it had before');
  assert.equal(db.getSetting('db_generation', null), gen, 'with its own generation');
});
