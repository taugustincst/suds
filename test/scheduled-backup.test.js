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

test('runIfDue does nothing while the schedule is off', () => {
  assert.equal(scheduled.runIfDue(), null);
  assert.equal(db.getSetting('last_scheduled_backup_at', null), null);
});

test('runIfDue backs up once the interval has elapsed, then waits for the next one', () => {
  db.setSetting('backup_schedule_hours', '24');
  const first = scheduled.runIfDue();
  assert.ok(first, 'the first run is always due');
  assert.ok(fs.existsSync(first.file));
  assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified)', 'the file was read back and opened before being called a backup');
  assert.equal(first.verified, true);

  assert.equal(scheduled.runIfDue(), null, 'not due again immediately');

  const almostADayLater = Date.now() + 23 * 3600_000;
  assert.equal(scheduled.runIfDue(almostADayLater), null, 'still short of 24 hours');

  const aDayLater = Date.now() + 24 * 3600_000 + 1000;
  const second = scheduled.runIfDue(aDayLater);
  assert.ok(second, 'due again after the full interval');
  assert.notEqual(second.file, first.file);
});

test('old local backups are pruned beyond the retention count', () => {
  db.setSetting('backup_retain_count', '3');
  for (let i = 0; i < 5; i++) { scheduled.run({ retain: 3 }); }
  const files = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db.enc'));
  assert.equal(files.length, 3, 'only the 3 most recent backups are kept');
});

test('an unreachable offsite path does not lose the local backup', () => {
  // A file (not a directory) in the way of the offsite path makes mkdir/copy fail deterministically,
  // standing in for an unmounted network share without depending on real network storage.
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const offsiteDir = path.join(blocker, 'backups');

  const out = scheduled.run({ retain: 14, offsiteDir });
  assert.equal(out.offsiteOk, false);
  assert.ok(fs.existsSync(out.file), 'the local backup was still written');
  assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified) — offsite copy failed, local backup kept');
});

test('a working offsite path receives a copy of the backup', () => {
  const offsiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-sched-backup-offsite-'));
  try {
    const out = scheduled.run({ retain: 14, offsiteDir });
    assert.equal(out.offsiteOk, true);
    assert.ok(fs.existsSync(path.join(offsiteDir, path.basename(out.file))), 'the offsite copy exists');
    assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified)');
  } finally { fs.rmSync(offsiteDir, { recursive: true, force: true }); }
});
