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

/**
 * A note's signature hash (notes.signature_hash, cosignature_hash) is taken over its ciphertext
 * (server/note-signature.js), so re-encrypting the note would leave every signed note reading "not intact". Before
 * the columns are re-encrypted, each note's hashes are checked under the old ciphertext; after, the ones that were
 * intact are computed again over the new ciphertext. One that was NOT intact before is left as it was, so a note
 * changed after it was signed still shows it. (A fingerprint confirmation is bound to the note's plaintext content
 * hash instead, which a rotation does not change: docs/FINGERPRINT.md.) Returns { recomputed, left_broken }.
 */
function signatureHashesBefore(d) {
  const NS = require('../server/note-signature');
  return d.all(`SELECT id, signed_by, cosigned_by, content_enc, structured_enc, signature_hash, cosignature_hash FROM notes WHERE signature_hash IS NOT NULL OR cosignature_hash IS NOT NULL`)
    .map(n => ({ id: n.id, sign: n.signature_hash ? NS.signatureHash(n, n.signed_by) === n.signature_hash : null, cosign: n.cosignature_hash ? NS.cosignatureHash(n, n.cosigned_by) === n.cosignature_hash : null }));
}
function signatureHashesAfter(d, before) {
  const NS = require('../server/note-signature');
  let recomputed = 0; let leftBroken = 0;
  for (const b of before) {
    const n = d.one(`SELECT id, signed_by, cosigned_by, content_enc, structured_enc FROM notes WHERE id=?`, b.id);
    if (b.sign === true) { d.run(`UPDATE notes SET signature_hash=? WHERE id=?`, NS.signatureHash(n, n.signed_by), n.id); recomputed++; } else if (b.sign === false) leftBroken++;
    if (b.cosign === true) { d.run(`UPDATE notes SET cosignature_hash=? WHERE id=?`, NS.cosignatureHash(n, n.cosigned_by), n.id); recomputed++; } else if (b.cosign === false) leftBroken++;
  }
  return { recomputed, left_broken: leftBroken };
}

/** Re-encrypt every *_enc column of the open database `d` (server/db.js) under `newKey`, in one transaction. */
function rotate(d, newKey) {
  const tables = encryptedColumns(d);
  let rows = 0; let values = 0; let hashes = null;
  d.transaction(() => {
    const before = signatureHashesBefore(d);
    for (const { table, cols } of tables) {
      for (const r of d.all(`SELECT id, ${cols.join(',')} FROM ${table}`)) {
        const sets = []; const params = [];
        for (const c of cols) if (r[c]) { sets.push(`${c}=?`); params.push(encrypt(decrypt(r[c]), newKey)); values++; }
        if (sets.length) { d.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=?`, ...params, r.id); rows++; }
      }
    }
    hashes = signatureHashesAfter(d, before);
    audit.log({ user: { username: 'cli' }, action: 'security.key_rotated', details: { rows, values, tables: tables.map(t => t.table), signature_hashes_recomputed: hashes.recomputed, signature_hashes_left_broken: hashes.left_broken } });
    // The server refuses to open a database whose recorded key does not match its own; record the new one.
    d.setSetting('key_fingerprint', require('../server/crypto').sha256('suds-key-check:' + newKey.toString('hex')).slice(0, 32));
  });
  return { rows, values, tables, hashes };
}

if (require.main === module) {
  const newHex = process.env.NEW_ENCRYPTION_KEY;
  if (!newHex || !/^[0-9a-fA-F]{64}$/.test(newHex)) { console.error('Set NEW_ENCRYPTION_KEY to 64 hex characters (npm run gen-key)'); process.exit(1); }
  const newKey = Buffer.from(newHex, 'hex');
  if (newKey.equals(config.encryptionKey)) { console.error('New key equals the current key'); process.exit(1); }

  db.open();
  const { rows, values, tables, hashes } = rotate(db, newKey);
  db.close();
  // In development the key normally lives in data/.dev-encryption-key; update it only when rotating that default database.
  if (!config.isProd && !process.env.SUDS_ENCRYPTION_KEY && !process.env.SUDS_DB_PATH) { const f = require('node:path').join(config.dataDir, '.dev-encryption-key'); if (fs.existsSync(f)) { fs.writeFileSync(f, newHex, { mode: 0o600 }); console.log(`Updated ${f}`); } }
  console.log(`Re-encrypted ${values} values across ${rows} rows in ${tables.length} tables (${tables.map(t => t.table).join(', ')}).`);
  console.log(`Signed notes: ${hashes.recomputed} signature hash${hashes.recomputed === 1 ? '' : 'es'} recomputed over the new ciphertext${hashes.left_broken ? `; ${hashes.left_broken} that did not match before rotation left as they were (the note changed after it was signed)` : ''}.`);
  console.log(`Set SUDS_ENCRYPTION_KEY=${newHex.slice(0, 6)}… in the environment and restart the server.`);
}

module.exports = { encryptedColumns, rotate };
