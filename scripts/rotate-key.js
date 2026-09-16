'use strict';
// Re-encrypts all PHI fields from the current SUDS_ENCRYPTION_KEY to a new key.
// Usage (server stopped, backup taken first):
//   NEW_ENCRYPTION_KEY=<64 hex> npm run rotate-key
// Afterwards set SUDS_ENCRYPTION_KEY to the new value and restart.
const fs = require('node:fs');
const config = require('../server/config');
const db = require('../server/db');
const { encrypt, decrypt } = require('../server/crypto');
const audit = require('../server/audit');

const newHex = process.env.NEW_ENCRYPTION_KEY;
if (!newHex || !/^[0-9a-fA-F]{64}$/.test(newHex)) { console.error('Set NEW_ENCRYPTION_KEY to 64 hex characters (npm run gen-key)'); process.exit(1); }
const newKey = Buffer.from(newHex, 'hex');
if (newKey.equals(config.encryptionKey)) { console.error('New key equals the current key'); process.exit(1); }

const TABLES = {
  clients: ['first_name_enc', 'last_name_enc', 'preferred_name_enc', 'dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc'],
  calls: ['contact_name_enc', 'phone_enc', 'summary_enc'],
  notes: ['content_enc', 'structured_enc'],
  note_addenda: ['content_enc'],
  import_items: ['content_enc'],
  users: ['mfa_secret_enc'],
};
db.open();
let rows = 0;
db.transaction(() => {
  for (const [table, cols] of Object.entries(TABLES)) {
    for (const r of db.all(`SELECT id, ${cols.join(',')} FROM ${table}`)) {
      const sets = []; const params = [];
      for (const c of cols) if (r[c]) { sets.push(`${c}=?`); params.push(encrypt(decrypt(r[c]), newKey)); }
      if (sets.length) { db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=?`, ...params, r.id); rows++; }
    }
  }
  audit.log({ user: { username: 'cli' }, action: 'security.key_rotated', details: { rows } });
});
db.close();
if (!config.isProd) { const f = require('node:path').join(config.dataDir, '.dev-encryption-key'); if (fs.existsSync(f)) fs.writeFileSync(f, newHex, { mode: 0o600 }); }
console.log(`Re-encrypted ${rows} rows. Set SUDS_ENCRYPTION_KEY=${newHex.slice(0, 6)}… in the environment and restart the server.`);
