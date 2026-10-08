'use strict';
// 1.25.2, BO1: a backup made with VACUUM INTO (Download encrypted backup, `npm run backup`) is a rollback-journal
// file. Restored, the live database stayed in that mode (schema.sql sets WAL only when it creates a database),
// and readSnapshot's second, read-only connection then held the main connection's writes -- audit entries
// included -- for busy_timeout at a time: 500 "database is locked" under ordinary load. Every writable open now
// puts the file in WAL mode.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '11'.repeat(32);
process.env.SUDS_INDEX_KEY = '22'.repeat(32);
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-backup-wal-'));
process.env.SUDS_DATA_DIR = dir;
process.env.SUDS_DB_PATH = path.join(dir, 'suds.db');

const db = require('../server/db');
const backup = require('../server/backup');
const { uuid } = require('../server/crypto');

const mode = () => String(db.one('PRAGMA journal_mode').journal_mode).toLowerCase();
const headerMode = (bytes) => ({ 1: 'rollback', 2: 'wal' })[bytes[18]] || `unknown (${bytes[18]})`;

before(() => {
  db.open();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, uuid(), 'walbk', 'x', 'WAL Tester', 'admin');
});
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a VACUUM INTO backup restored with restore() is reopened in WAL mode, and stays WAL after a restart', () => {
  assert.equal(mode(), 'wal');
  const plain = backup.decrypt(backup.create());
  // The fault's precondition: the copy itself is a rollback-journal file.
  assert.equal(headerMode(plain), 'rollback', 'VACUUM INTO writes a rollback-journal file (the reason for the fix)');
  backup.restore(plain);
  assert.equal(mode(), 'wal', 'the restored database is in WAL mode once it is open');
  db.close(); db.open();
  assert.equal(mode(), 'wal', 'and after a restart');
});

test('an existing rollback-journal database (an older restore) is put in WAL mode by the next open', () => {
  db.close();
  const f = process.env.SUDS_DB_PATH;
  const raw = new DatabaseSync(f); raw.exec('PRAGMA journal_mode = DELETE'); raw.close();
  { const check = new DatabaseSync(f, { readOnly: true }); assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); check.close(); }
  db.open();
  assert.equal(mode(), 'wal');
});

test('concurrent writes while a read snapshot is open do not hit SQLITE_BUSY', async () => {
  const restored = backup.decrypt(backup.create());
  await backup.restoreWhenIdle(restored);
  assert.equal(mode(), 'wal');
  // A short timeout so that a lock shows as an error at once rather than as a five-second stall.
  db.get().exec('PRAGMA busy_timeout = 200');
  let release; const held = new Promise((r) => { release = r; });
  let usedSnapshot = null; let seenInSnapshot = null;
  const reader = db.readSnapshot(async (snap) => {
    usedSnapshot = snap;
    db.one('SELECT COUNT(*) n FROM users');
    await held;
    seenInSnapshot = db.one(`SELECT COUNT(*) n FROM users WHERE username LIKE 'conc-%'`).n;
  });
  const errors = [];
  const writes = Array.from({ length: 20 }, (_, i) => new Promise((resolve) => setImmediate(() => {
    try { db.run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, uuid(), `conc-${i}`, 'x', `Writer ${i}`, 'navigator'); }
    catch (e) { errors.push(e.message); }
    resolve();
  })));
  await Promise.all(writes);
  release();
  await reader;
  db.get().exec('PRAGMA busy_timeout = 5000');
  assert.equal(usedSnapshot, true, 'the reader ran on its own connection');
  assert.deepEqual(errors, [], 'no write was refused as locked');
  assert.equal(seenInSnapshot, 0, 'the snapshot did not see the writes made while it was open');
  assert.equal(db.one(`SELECT COUNT(*) n FROM users WHERE username LIKE 'conc-%'`).n, 20);
});
