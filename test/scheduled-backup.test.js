'use strict';
// Scheduled backups (server/scheduled-backup.js): due/not-due gating, retention pruning, and the offsite
// copy being best-effort (a bad offsite path must not lose the local backup that already succeeded).
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '11'.repeat(32);
process.env.SUDS_INDEX_KEY = '22'.repeat(32);
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-sched-backup-'));
process.env.SUDS_DATA_DIR = dir;
process.env.SUDS_DB_PATH = path.join(dir, 'suds.db');

const db = require('../server/db');
const scheduled = require('../server/scheduled-backup');

before(() => { db.open(); });
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  for (const k of ['backup_schedule_hours', 'backup_retain_count', 'backup_offsite_dir', 'last_scheduled_backup_at', 'last_scheduled_backup_status'])
    db.run(`DELETE FROM settings WHERE key=?`, k);
  const backupsDir = path.join(dir, 'backups');
  if (fs.existsSync(backupsDir)) fs.rmSync(backupsDir, { recursive: true, force: true });
});

test('runIfDue does nothing while the schedule is off', async () => {
  assert.equal(await scheduled.runIfDue(), null);
  assert.equal(db.getSetting('last_scheduled_backup_at', null), null);
});

test('runIfDue backs up once the interval has elapsed, then waits for the next one', async () => {
  db.setSetting('backup_schedule_hours', '24');
  const first = await scheduled.runIfDue();
  assert.ok(first, 'the first run is always due');
  assert.ok(fs.existsSync(first.file));
  assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified)', 'the file was read back and opened before being called a backup');
  assert.equal(first.verified, true);

  assert.equal(await scheduled.runIfDue(), null, 'not due again immediately');

  const almostADayLater = Date.now() + 23 * 3600_000;
  assert.equal(await scheduled.runIfDue(almostADayLater), null, 'still short of 24 hours');

  const aDayLater = Date.now() + 24 * 3600_000 + 1000;
  const second = await scheduled.runIfDue(aDayLater);
  assert.ok(second, 'due again after the full interval');
  assert.notEqual(second.file, first.file);
});

test('a backup that cannot be written is recorded as failed, audited, and shown by the health check', async () => {
  const backup = require('../server/backup');
  const real = backup.createToFileAsync;
  backup.createToFileAsync = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
  try {
    db.setSetting('backup_schedule_hours', '24');
    const out = await scheduled.runIfDue();
    assert.equal(out.failed, true);
    assert.match(db.getSetting('last_scheduled_backup_status', ''), /^failed: no space left on the disk/);
    assert.ok(db.getSetting('last_scheduled_backup_at', null), 'the attempt is dated, so the schedule does not retry every hour into a full disk');
    const row = db.one(`SELECT * FROM audit_log WHERE action='backup.scheduled' ORDER BY id DESC LIMIT 1`);
    assert.equal(row.success, 0); assert.match(row.details, /ENOSPC/);
    assert.equal(fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).filter(f => f.endsWith('.db.enc')).length : 0, 0, 'no half-written file is left behind');
  } finally { backup.createToFileAsync = real; }
  // Any other exception is recorded with its message.
  backup.createToFileAsync = () => { throw new Error('VACUUM INTO failed: database is locked'); };
  try {
    const out = await scheduled.run({ retain: 3 });
    assert.equal(out.failed, true);
    assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'failed: VACUUM INTO failed: database is locked');
  } finally { backup.createToFileAsync = real; }
  // Once the cause is fixed, the next run clears the status.
  const ok = await scheduled.run({ retain: 3 });
  assert.equal(ok.verified, true);
  assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified)');
});

test('pruning runs before the new backup is written, so a full retention set still has room for tonight', async () => {
  db.setSetting('backup_retain_count', '2');
  const backupsDir = path.join(dir, 'backups'); fs.mkdirSync(backupsDir, { recursive: true });
  for (const t of ['2020-01-01T00-00-00-000Z', '2020-01-02T00-00-00-000Z', '2020-01-03T00-00-00-000Z']) fs.writeFileSync(path.join(backupsDir, `suds-${t}.db.enc`), 'old');
  const seen = [];
  const backup = require('../server/backup'); const real = backup.createToFileAsync;
  backup.createToFileAsync = (...a) => { seen.push(fs.readdirSync(backupsDir).filter(f => f.endsWith(".db.enc")).sort()); return real(...a); };
  try { await scheduled.run({ retain: 2 }); } finally { backup.createToFileAsync = real; }
  assert.deepEqual(seen[0], ['suds-2020-01-03T00-00-00-000Z.db.enc'], 'only retain-1 old files remained when the new one was made');
  const after = fs.readdirSync(backupsDir).filter(f => f.endsWith('.db.enc')).sort();
  assert.equal(after.length, 2); assert.equal(after[0], 'suds-2020-01-03T00-00-00-000Z.db.enc');
});

test('old local backups are pruned beyond the retention count', async () => {
  db.setSetting('backup_retain_count', '3');
  for (let i = 0; i < 5; i++) { await scheduled.run({ retain: 3 }); }
  const files = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db.enc'));
  assert.equal(files.length, 3, 'only the 3 most recent backups are kept');
});

test('an unreachable offsite path does not lose the local backup', async () => {
  // A file (not a directory) in the way of the offsite path makes mkdir/copy fail deterministically,
  // standing in for an unmounted network share without depending on real network storage.
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const offsiteDir = path.join(blocker, 'backups');

  const out = await scheduled.run({ retain: 14, offsiteDir });
  assert.equal(out.offsiteOk, false);
  assert.ok(fs.existsSync(out.file), 'the local backup was still written');
  assert.match(db.getSetting('last_scheduled_backup_status', ''), /^ok \(verified\) — offsite copy failed: .+; local backup kept$/);
});

test('an offsite directory that does not exist is reported, not created', async () => {
  // The offsite path used to be mkdir -p'd, so an unmounted network share (an empty mount point, or a path
  // under one) got a fresh local folder and the copy "succeeded" onto the office computer's own disk --
  // exactly the disk the offsite copy exists to survive losing.
  const offsiteDir = path.join(dir, 'unmounted-share', 'suds-backups');
  const out = await scheduled.run({ retain: 14, offsiteDir });
  assert.equal(out.offsiteOk, false);
  assert.equal(out.offsiteError, 'offsite directory does not exist (is the share mounted?)');
  assert.equal(fs.existsSync(offsiteDir), false, 'nothing was created in its place');
  assert.ok(fs.existsSync(out.file), 'the local backup was still written');
  assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified) — offsite copy failed: offsite directory does not exist (is the share mounted?); local backup kept');
  // A file where the directory should be is the same answer.
  const blocker = path.join(dir, 'a-file'); fs.writeFileSync(blocker, 'x');
  assert.equal((await scheduled.run({ retain: 14, offsiteDir: blocker })).offsiteError, 'offsite directory does not exist (is the share mounted?)');
});

test('a working offsite path receives a copy of the backup', async () => {
  const offsiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-sched-backup-offsite-'));
  try {
    const out = await scheduled.run({ retain: 14, offsiteDir });
    assert.equal(out.offsiteOk, true);
    assert.ok(fs.existsSync(path.join(offsiteDir, path.basename(out.file))), 'the offsite copy exists');
    assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified)');
  } finally { fs.rmSync(offsiteDir, { recursive: true, force: true }); }
});

test('a scheduled backup does not hold the event loop while it copies, encrypts and verifies a large database', async () => {
  // A scheduled backup used VACUUM INTO + synchronous encrypt + synchronous read-back verification: 3.8 s of
  // a frozen server on a 311 MB database, every time the schedule came round. It now uses the online backup
  // API (backup.createToFileAsync), writes and copies asynchronously, and runs the integrity check in a worker.
  db.get().exec('CREATE TABLE IF NOT EXISTS zz_filler(b BLOB)');
  const ins = db.get().prepare('INSERT INTO zz_filler(b) VALUES (randomblob(1048576))');
  for (let i = 0; i < 48; i++) ins.run(); // ~48 MB
  const offsiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-sched-backup-big-'));
  let maxGap = 0; let last = performance.now();
  const timer = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 5);
  try {
    const t0 = performance.now();
    const pending = scheduled.run({ retain: 3, offsiteDir });
    assert.ok(pending && typeof pending.then === 'function', 'run() returns a promise: the work happens off the calling turn');
    const out = await pending;
    const total = performance.now() - t0;
    assert.equal(out.verified, true, 'the read-back verification still runs');
    assert.equal(out.offsiteOk, true);
    // The blocking implementation's longest stall was the whole run. The non-blocking one yields between
    // online-backup steps and encryption slices; generous slack for a loaded CI machine.
    assert.ok(maxGap < Math.max(250, total / 3), `longest event-loop stall ${Math.round(maxGap)} ms of a ${Math.round(total)} ms backup`);
  } finally {
    clearInterval(timer);
    db.get().exec('DROP TABLE zz_filler');
    fs.rmSync(offsiteDir, { recursive: true, force: true });
  }
});

test('the streamed backup is the same frame a restore reads, the read-back catches tampering, and no plaintext is left behind', async () => {
  const backup = require('../server/backup');
  const out = await scheduled.run({ retain: 3 });
  // The CLI / Administration restore path (synchronous decrypt + inspect) opens what the streaming writer wrote.
  const info = backup.inspect(backup.decrypt(fs.readFileSync(out.file)));
  assert.equal(info.schema_version, db.LATEST_SCHEMA_VERSION);
  assert.equal((await backup.verifyFileAsync(out.file)).counts.clients, info.counts.clients);
  const bad = fs.readFileSync(out.file); bad[bad.length - 10] ^= 0xff;
  const badFile = path.join(dir, 'tampered.db.enc'); fs.writeFileSync(badFile, bad);
  await assert.rejects(() => backup.verifyFileAsync(badFile), /could not be read/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /^\.(backup|inspect)-/.test(f)), [], 'temporary plaintext copies are removed');
});
