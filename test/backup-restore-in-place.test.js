'use strict';
// `node scripts/backup.js --restore-in-place` (server/backup.js restoreInPlace): the restore an upgrade's
// rollback (deploy/linux/upgrade.sh) and a restore on a stopped server use. The live database may have been
// migrated by a newer release that this code cannot open (its schema is newer): the restore must never open
// it, only move it (and its -wal/-shm) aside, sealed, and put the checked backup in its place with no journal
// beside it. Up to this fix `--restore` opened the live database first and failed on exactly that database.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-restore-in-place-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const data = path.join(work, 'data'); const anchors = path.join(work, 'anchors');
fs.mkdirSync(data); fs.mkdirSync(anchors);
const env = { ...process.env, SUDS_ENV: 'production', SUDS_DATA_DIR: data, AUDIT_ANCHOR_DIR: anchors, SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x',
  SUDS_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), SUDS_INDEX_KEY: crypto.randomBytes(32).toString('hex'), SUDS_BACKUP_KEY: crypto.randomBytes(32).toString('hex'), SUDS_SIGNING_KEY: crypto.randomBytes(32).toString('hex') };
delete env.SUDS_DB_PATH;
const node = (args, extra = {}) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', ...args], { cwd: REPO, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
const dbFile = path.join(data, 'suds.db');
const sql = (q) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(dbFile, { readOnly: true }); try { return d.prepare(q).all(); } finally { d.close(); } };

test('--restore-in-place puts the backup back over a database a newer release migrated, without opening it; journals gone', () => {
  let r = node(['-e', `const db = require('./server/db'); db.open(); require('./server/bootstrap').ensureBootstrap(); db.setSetting('org_name', 'Before the upgrade'); db.close();`]);
  assert.equal(r.status, 0, r.stderr);
  const schema = Number(sql(`SELECT value FROM settings WHERE key='schema_version'`)[0].value);
  r = node(['scripts/backup.js', path.join(data, 'backups')]);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(data, 'backups', fs.readdirSync(path.join(data, 'backups')).find((f) => /^suds-.*\.db\.enc$/.test(f)));
  // "The new release migrated it and then failed": a schema this code does not know, a table it never made,
  // and a write-ahead log left behind by a process that did not close the database.
  r = node(['-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(dbFile)});
    d.exec("CREATE TABLE from_the_future(x); UPDATE settings SET value='${schema + 5}' WHERE key='schema_version';"); d.close();`]);
  assert.equal(r.status, 0, r.stderr);
  // The live database cannot be opened by this code any more (the rollback case): the old --restore opened it.
  assert.notEqual(node(['-e', `require('./server/db').open()`]).status, 0, 'this build refuses the migrated database');
  r = node(['-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(dbFile)});
    d.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE settings SET value='Migrated' WHERE key='org_name';");
    process.exit(0);`]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(`${dbFile}-wal`), 'the migrated database has a write-ahead log beside it');
  // Writing over the live file with --restore is refused (it would keep the -wal beside the new file).
  r = node(['scripts/backup.js', '--restore', file, dbFile]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /is the live database/);

  r = node(['scripts/backup.js', '--restore-in-place', file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Checked before this test reads the file: the restored database is in WAL mode (1.25.2, BO1), and a read-only
  // reader of a WAL database leaves its own -wal/-shm beside it.
  assert.ok(!fs.existsSync(`${dbFile}-wal`) && !fs.existsSync(`${dbFile}-shm`), 'no journal of the replaced database beside the restored one');
  assert.equal(sql('PRAGMA journal_mode')[0].journal_mode, 'wal', 'the restored database is in WAL mode');
  assert.match(r.stdout, new RegExp(`Restored .* \\(\\d+ clients, schema ${schema}\\)`));
  assert.equal(Number(sql(`SELECT value FROM settings WHERE key='schema_version'`)[0].value), schema, 'the schema of the backup');
  assert.equal(sql(`SELECT value FROM settings WHERE key='org_name'`)[0].value, 'Before the upgrade');
  assert.equal(sql(`SELECT name FROM sqlite_master WHERE name='from_the_future'`).length, 0);
  assert.ok(sql(`SELECT action FROM audit_log WHERE action='backup.restore'`).length >= 1, 'recorded in the audit log');
  assert.ok(fs.readdirSync(anchors).length >= 1, 'a restore anchor was written');
  const aside = fs.readdirSync(data).find((f) => f.startsWith('suds.db.replaced-'));
  assert.ok(aside, 'the replaced database is kept');
  const kept = fs.readdirSync(path.join(data, aside));
  assert.ok(kept.includes('suds.db.enc') && kept.includes('suds.db-wal.enc'), `sealed: ${kept}`);
  assert.ok(!kept.includes('suds.db') && !kept.includes('suds.db-wal'), 'no plaintext copy left');
  assert.equal(node(['-e', `const db = require('./server/db'); db.open(); db.close();`]).status, 0, 'SUDS opens the restored database');
  // --restore (to a side file) no longer opens the live database either.
  r = node(['scripts/backup.js', '--restore', file, path.join(work, 'side.db')]);
  assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(path.join(work, 'side.db')));
});

test('--restore-in-place refuses a damaged or foreign backup and leaves the live database exactly as it was', () => {
  const before = fs.readFileSync(dbFile);
  const bad = path.join(work, 'bad.db.enc'); fs.writeFileSync(bad, crypto.randomBytes(200));
  const r = node(['scripts/backup.js', '--restore-in-place', bad]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Restore failed/);
  assert.ok(fs.readFileSync(dbFile).equals(before), 'the live database was not touched');
  assert.equal(fs.readdirSync(data).filter((f) => f.includes('.restoring-')).length, 0, 'no half-written copy left');
});
