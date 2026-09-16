'use strict';
// Creates a consistent SQLite backup and wraps it in an AES-256-GCM encrypted archive.
// Usage: npm run backup [-- /path/to/backups]      Restore: node scripts/backup.js --restore file.enc [out.db]
// The backup is encrypted with a key derived from SUDS_ENCRYPTION_KEY; keep that key safe and separate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../server/config');
const db = require('../server/db');

const args = process.argv.slice(2);
const backupKey = crypto.createHash('sha256').update(Buffer.concat([config.encryptionKey, Buffer.from('suds-backup')])).digest();

if (args[0] === '--restore') {
  const src = args[1]; const out = args[2] || config.dbPath + '.restored';
  const buf = fs.readFileSync(src);
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', backupKey, iv); d.setAuthTag(tag);
  fs.writeFileSync(out, Buffer.concat([d.update(data), d.final()]), { mode: 0o600 });
  console.log(`Restored to ${out}. Stop the server, move it to ${config.dbPath}, and remove any -wal/-shm files before starting.`);
  process.exit(0);
}
const outDir = path.resolve(args[0] || path.join(config.dataDir, 'backups'));
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tmp = path.join(outDir, `suds-${stamp}.db`);
const d = db.open();
d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
db.close();
const plain = fs.readFileSync(tmp); fs.unlinkSync(tmp);
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', backupKey, iv);
const enc = Buffer.concat([c.update(plain), c.final()]);
const out = path.join(outDir, `suds-${stamp}.db.enc`);
fs.writeFileSync(out, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
console.log(`Encrypted backup written: ${out} (${(enc.length / 1024).toFixed(0)} KB)`);
