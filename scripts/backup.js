'use strict';
// Creates a consistent SQLite backup and wraps it in an AES-256-GCM encrypted archive.
//
//   npm run backup [-- /path/to/backups]                          an encrypted backup of the live database
//   node scripts/backup.js --restore file.enc [out.db]            decrypt a backup to a separate file (default
//                                                                 <db>.restored); the live database is not touched
//   node scripts/backup.js --restore-in-place file.enc            with SUDS STOPPED: put the backup in place of the
//                                                                 live database (server/backup.js restoreInPlace)
//
// --restore-in-place never opens the live database: it may have been migrated by a newer release this code
// cannot read (an upgrade's rollback, deploy/linux/upgrade.sh). The backup is checked, written beside the
// database and checked again, the live file and its -wal/-shm are moved aside (sealed like a backup), the copy
// renamed into place and the journals dropped.
//
// The backup is encrypted with a key derived from SUDS_ENCRYPTION_KEY (or SUDS_BACKUP_KEY); keep that key safe
// and separate. The format lives in server/backup.js and is shared with the Administration page.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const db = require('../server/db');
const backup = require('../server/backup');

const args = process.argv.slice(2);

if (args[0] === '--restore') {
  const src = args[1];
  if (!src) { console.error('Usage: node scripts/backup.js --restore <file.enc> [out.db]'); process.exit(1); }
  const out = path.resolve(args[2] || config.dbPath + '.restored');
  // Writing straight over the live file would leave its -wal/-shm beside the new one, and corrupt it.
  if (out === path.resolve(config.dbPath)) { console.error(`${out} is the live database. Stop SUDS and use: node scripts/backup.js --restore-in-place ${src}`); process.exit(1); }
  if (fs.existsSync(out)) { console.error(`${out} already exists: name another file (it is never overwritten).`); process.exit(1); }
  const plain = backup.decrypt(fs.readFileSync(src));
  const info = backup.inspect(plain); // needs only this build's schema version: the live database is not opened
  fs.writeFileSync(out, plain, { mode: 0o600, flag: 'wx' });
  console.log(`Restored to ${out} (${info.counts.clients} clients, schema ${info.schema_version}).`);
  console.log(`To put it in place: stop SUDS and run node scripts/backup.js --restore-in-place ${src}`);
  process.exit(0);
}

if (args[0] === '--restore-in-place') {
  const src = args[1];
  if (!src || args.length > 2) { console.error('Usage (SUDS stopped): node scripts/backup.js --restore-in-place <file.enc>'); process.exit(1); }
  try {
    const plain = backup.decrypt(fs.readFileSync(src));
    const info = backup.restoreInPlace(plain);
    console.log(`Restored ${path.basename(src)} in place of ${config.dbPath} (${info.counts.clients} clients, schema ${info.schema_version}).`);
    if (info.replaced_kept_at) console.log(`The database it replaced is kept, encrypted, in ${info.replaced_kept_at}.`);
    process.exit(0);
  } catch (e) {
    console.error(`Restore failed: ${e.message}`);
    process.exit(1);
  }
}

const outDir = path.resolve(args[0] || path.join(config.dataDir, 'backups'));
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
db.open();
const bytes = backup.create();
db.close();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(outDir, `suds-${stamp}.db.enc`);
fs.writeFileSync(out, bytes, { mode: 0o600 });
console.log(`Encrypted backup written: ${out} (${(bytes.length / 1024).toFixed(0)} KB)`);
