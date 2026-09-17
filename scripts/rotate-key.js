'use strict';
// Re-encrypts all PHI fields from the current SUDS_ENCRYPTION_KEY to a new key.
// Usage (server stopped, backup taken first):
//   NEW_ENCRYPTION_KEY=<64 hex> npm run rotate-key
// Afterwards set SUDS_ENCRYPTION_KEY to the new value and restart.
//
// The set of encrypted columns is read from the live schema rather than listed here. A hand-maintained
// list is how client_forms.values_enc and client_form_files.data_enc came to be left behind in 1.5, which
// meant following the documented rotation procedure destroyed every completed county form.
const fs = require('node:fs');
const config = require('../server/config');
const db = require('../server/db');
const { encrypt, decrypt } = require('../server/crypto');
const audit = require('../server/audit');

/** Every `*_enc` column in the database, with the table it belongs to. */
function encryptedColumns(d) {
  const out = [];
  for (const t of d.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)) {
    const cols = d.all(`PRAGMA table_info(${t.name})`).map(c => c.name);
    const enc = cols.filter(c => c.endsWith('_enc'));
    if (enc.length && cols.includes('id')) out.push({ table: t.name, cols: enc });
  }
  return out;
}

if (require.main === module) {
  const newHex = process.env.NEW_ENCRYPTION_KEY;
  if (!newHex || !/^[0-9a-fA-F]{64}$/.test(newHex)) { console.error('Set NEW_ENCRYPTION_KEY to 64 hex characters (npm run gen-key)'); process.exit(1); }
  const newKey = Buffer.from(newHex, 'hex');
  if (newKey.equals(config.encryptionKey)) { console.error('New key equals the current key'); process.exit(1); }

  db.open();
  const tables = encryptedColumns(db);
  let rows = 0; let values = 0;
  db.transaction(() => {
    for (const { table, cols } of tables) {
      for (const r of db.all(`SELECT id, ${cols.join(',')} FROM ${table}`)) {
        const sets = []; const params = [];
        for (const c of cols) if (r[c]) { sets.push(`${c}=?`); params.push(encrypt(decrypt(r[c]), newKey)); values++; }
        if (sets.length) { db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=?`, ...params, r.id); rows++; }
      }
    }
    audit.log({ user: { username: 'cli' }, action: 'security.key_rotated', details: { rows, values, tables: tables.map(t => t.table) } });
  });
  db.close();
  // In development the key normally lives in data/.dev-encryption-key; update it only when rotating that default database.
  if (!config.isProd && !process.env.SUDS_ENCRYPTION_KEY && !process.env.SUDS_DB_PATH) { const f = require('node:path').join(config.dataDir, '.dev-encryption-key'); if (fs.existsSync(f)) { fs.writeFileSync(f, newHex, { mode: 0o600 }); console.log(`Updated ${f}`); } }
  console.log(`Re-encrypted ${values} values across ${rows} rows in ${tables.length} tables (${tables.map(t => t.table).join(', ')}).`);
  console.log(`Set SUDS_ENCRYPTION_KEY=${newHex.slice(0, 6)}… in the environment and restart the server.`);
}

module.exports = { encryptedColumns };
