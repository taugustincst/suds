'use strict';
// Security review of 1.13.0, finding 3: the migrations that encrypt a plaintext column (encryptColumn) left
// the plaintext recoverable. After upgrading schema 41 -> 43 all 50 import file names were still in the free
// pages of suds.db (no secure_delete, no VACUUM), and 85 more copies sat in the plaintext pre-migration
// snapshots beside it. Now every connection runs with secure_delete, an upgrade that encrypted a column ends
// with a VACUUM, a database from before 1.13.1 is vacuumed once, and the pre-migration snapshots are sealed
// with the backup key once the upgrade has succeeded (and deleted after SNAPSHOT_KEEP_DAYS). Checked by
// scanning the bytes of every file for the plaintext.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '2'.repeat(64);
process.env.SUDS_INDEX_KEY = '3'.repeat(64);
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const db = require('../server/db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-remnants-'));
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const MARK = 'Kowalski-Robert-MARKER';
// Every copy of the marker in the database, its WAL, and the pre-migration folder.
function occurrences(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const n = (fs.readFileSync(p).toString('latin1').match(new RegExp(MARK, 'g')) || []).length; if (n) out[path.relative(dir, p)] = n; } } };
  walk(dir);
  return out;
}
// A database as 1.12 left it at schema 41: imports.filename in plaintext, 50 file names on file.
function schema41(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'suds.db');
  db.open(file); db.close();
  const d = new DatabaseSync(file);
  d.exec('PRAGMA secure_delete = OFF; PRAGMA foreign_keys = OFF');
  d.exec('ALTER TABLE imports DROP COLUMN filename_enc; ALTER TABLE imports ADD COLUMN filename TEXT');
  const ins = d.prepare('INSERT INTO imports(id,source,filename) VALUES(?,?,?)');
  for (let i = 0; i < 50; i++) ins.run('imp' + i, 'upload', `${MARK}-intake-${i}.pdf`);
  d.exec("UPDATE settings SET value='41' WHERE key='schema_version'; DELETE FROM settings WHERE key='free_pages_scrubbed_at'");
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  d.close();
  assert.ok(Object.keys(occurrences(dir)).length, 'the marker is in the file before the upgrade');
  return file;
}

test('an upgrade that encrypts a column leaves no plaintext in the database file, its WAL or the snapshot folder', () => {
  const dir = path.join(root, 'upgrade');
  const file = schema41(dir);
  const log = console.log; console.log = () => {};
  try { db.open(file); } finally { console.log = log; }
  assert.equal(db.getSetting('schema_version'), String(db.LATEST_SCHEMA_VERSION));
  const { decrypt } = require('../server/crypto');
  assert.equal(db.all(`SELECT filename_enc FROM imports`).filter(r => decrypt(r.filename_enc).startsWith(MARK)).length, 50, 'the file names are all still there, encrypted');
  assert.ok(db.getSetting('free_pages_scrubbed_at'), 'recorded');
  db.close();
  assert.deepEqual(occurrences(dir), {}, 'no copy of the plaintext anywhere under the data folder');
});

test('the pre-migration snapshot is kept sealed, and still restores the database as it was', () => {
  const snapDir = path.join(root, 'upgrade', 'pre-migration');
  const files = fs.readdirSync(snapDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^suds\.db\.v41\..*\.db\.enc$/, 'the plaintext snapshot was replaced by its sealed copy');
  assert.equal((fs.statSync(path.join(snapDir, files[0])).mode & 0o777).toString(8), '600');
  const plain = require('../server/backup').decrypt(fs.readFileSync(path.join(snapDir, files[0])));
  const tmp = path.join(root, 'restored.db'); fs.writeFileSync(tmp, plain);
  const d = new DatabaseSync(tmp, { readOnly: true });
  try {
    assert.equal(d.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get().value, '41');
    assert.equal(d.prepare(`SELECT COUNT(*) n FROM imports WHERE filename LIKE ?`).get(`${MARK}%`).n, 50, 'the rollback copy is whole');
  } finally { d.close(); fs.rmSync(tmp); }
});

test('a database already at schema 43 with plaintext in its free pages (a 1.13.0 install) is vacuumed once on start', () => {
  const dir = path.join(root, 'already');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'suds.db');
  db.open(file); db.close();
  const d = new DatabaseSync(file);
  d.exec('PRAGMA secure_delete = OFF');
  d.exec('CREATE TABLE leftover(id INTEGER PRIMARY KEY, v TEXT)');
  const ins = d.prepare('INSERT INTO leftover(v) VALUES(?)');
  for (let i = 0; i < 200; i++) ins.run(`${MARK}-${i}.pdf ${'x'.repeat(200)}`);
  d.exec('DROP TABLE leftover');
  d.exec("DELETE FROM settings WHERE key='free_pages_scrubbed_at'");
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  d.close();
  // A plaintext snapshot 1.13.0 left behind, and a sealed one past its keeping period.
  fs.mkdirSync(path.join(dir, 'pre-migration'));
  fs.writeFileSync(path.join(dir, 'pre-migration', 'suds.db.v41.2026-09-01T00-00-00-000Z.db'), `SQLite format 3 ${MARK}`);
  const old = path.join(dir, 'pre-migration', 'suds.db.v40.2026-01-01T00-00-00-000Z.db.enc');
  fs.writeFileSync(old, 'sealed');
  const longAgo = new Date(Date.now() - 30 * 86400000); fs.utimesSync(old, longAgo, longAgo);
  assert.ok(occurrences(dir)['suds.db'], 'the dropped rows are still readable in the free pages');
  const log = console.log; console.log = () => {};
  try { db.open(file); } finally { console.log = log; }
  const at = db.getSetting('free_pages_scrubbed_at');
  assert.ok(at);
  db.close();
  assert.deepEqual(occurrences(dir), {}, 'nothing left in the database or the snapshot folder');
  assert.ok(!fs.existsSync(old), 'a sealed snapshot past its keeping period is deleted');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pre-migration')), ['suds.db.v41.2026-09-01T00-00-00-000Z.db.enc']);
  // Once: the next start does not vacuum again.
  db.open(file);
  assert.equal(db.getSetting('free_pages_scrubbed_at'), at);
  db.close();
});

test('every connection deletes securely, so what is deleted from now on is not left behind either', () => {
  const dir = path.join(root, 'ongoing');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'suds.db');
  db.open(file);
  assert.equal(db.one('PRAGMA secure_delete').secure_delete, 1);
  db.run('CREATE TABLE scratch(id INTEGER PRIMARY KEY, v TEXT)');
  for (let i = 0; i < 100; i++) db.run('INSERT INTO scratch(v) VALUES(?)', `${MARK}-${i} ${'y'.repeat(300)}`);
  db.run('DELETE FROM scratch');
  db.run('DROP TABLE scratch');
  db.get().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  assert.deepEqual(occurrences(dir), {});
});
