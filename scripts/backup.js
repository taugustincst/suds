'use strict';
// Creates a consistent SQLite backup and wraps it in an AES-256-GCM encrypted archive.
// Usage: npm run backup [-- /path/to/backups]      Restore: node scripts/backup.js --restore file.enc [out.db]
// The backup is encrypted with a key derived from SUDS_ENCRYPTION_KEY; keep that key safe and separate.
// The format lives in server/backup.js and is shared with the Administration page, so the two cannot drift.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const db = require('../server/db');
const backup = require('../server/backup');

const args = process.argv.slice(2);

if (args[0] === '--restore') {
  const src = args[1];
  if (!src) { console.error('Usage: node scripts/backup.js --restore <file.enc> [out.db]'); process.exit(1); }
  const plain = backup.decrypt(fs.readFileSync(src));
  db.open();
  const info = backup.inspect(plain);
  db.close();
  const out = args[2] || config.dbPath + '.restored';
  fs.writeFileSync(out, plain, { mode: 0o600 });
  console.log(`Restored to ${out} (${info.counts.clients} clients, schema ${info.schema_version}).`);
  console.log(`Stop the server, move it to ${config.dbPath}, and remove any -wal/-shm files before starting.`);
  process.exit(0);
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
