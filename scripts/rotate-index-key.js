'use strict';
// Rotates SUDS_INDEX_KEY: re-derives every `*_idx` blind index from the decrypted PHI it was computed from,
// and re-signs the audit chain, whose HMAC is keyed with the same key (server/audit.js).
// Usage (server stopped, backup taken first):
//   NEW_INDEX_KEY=<64 hex> npm run rotate-index-key
// Afterwards set SUDS_INDEX_KEY to the new value (or let this script update keys.json / the dev key file,
// which it does when that is where the current key came from) and restart.
//
// Like scripts/rotate-key.js, the columns are discovered from the live schema rather than listed here; a
// table with an `_idx` column this script does not know how to derive stops the rotation instead of being
// skipped, because a blind index left under the old key is a client the search box can no longer find.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const db = require('../server/db');
const audit = require('../server/audit');
const { decrypt, blindIndex } = require('../server/crypto');

/** Every `*_idx` column in the database, with the table it belongs to. */
function indexedColumns(d) {
  const out = [];
  for (const t of d.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)) {
    const cols = d.all(`PRAGMA table_info(${t.name})`).map(c => c.name);
    const idx = cols.filter(c => c.endsWith('_idx'));
    if (idx.length) out.push({ table: t.name, cols: idx, hasId: cols.includes('id') });
  }
  return out;
}

// How each table's blind indexes are derived from its plaintext. The same expressions the write paths
// use (server/clients-model.js encryptFields, server/sync-tables.js importRow); blindIndex and the
// name-index helpers read config.indexKey at call time, which is why the key is swapped in below.
const DERIVATIONS = {
  clients: {
    source: ['first_name_enc', 'last_name_enc', 'dob_enc', 'phone_enc', 'preferred_name_enc'],
    derive(p) {
      const M = require('../server/clients-model');
      const first = p.first_name_enc || '', last = p.last_name_enc || '';
      return {
        last_name_idx: blindIndex(last),
        full_name_idx: blindIndex(last + first),
        name_prefix_idx: M.namePrefixIndex(last),
        name_phonetic_idx: M.namePhoneticIndex(last),
        first_name_idx: blindIndex(String(first).trim().toLowerCase()),
        first_name_prefix_idx: M.namePrefixIndex(first),
        preferred_name_idx: M.preferredNameIndex(p.preferred_name_enc || ''),
        dob_idx: blindIndex(p.dob_enc || ''),
        phone_idx: blindIndex(String(p.phone_enc || '').replace(/\D/g, '')),
      };
    },
  },
};

/**
 * Re-derive every blind index and re-sign the audit chain under `newKey`, in one transaction. On return
 * config.indexKey is the new key (the process is a CLI, or a test, and nothing else in it must keep using
 * the old one). Throws, changing nothing, if a table carries an `_idx` column with no known derivation.
 */
function rotateIndexKey(newKey) {
  if (!Buffer.isBuffer(newKey) || newKey.length !== 32) throw new Error('The new index key must be 32 bytes');
  if (newKey.equals(config.indexKey)) throw new Error('New key equals the current key');
  const tables = indexedColumns(db);
  const unknown = [];
  for (const t of tables) {
    const d = DERIVATIONS[t.table];
    const missing = d ? t.cols.filter(c => !(c in d.derive({}))) : t.cols;
    if (missing.length || !t.hasId) unknown.push(`${t.table}(${missing.join(', ') || 'no id column'})`);
  }
  if (unknown.length) throw new Error(`No derivation is known for these blind-index columns, so the rotation cannot proceed: ${unknown.join('; ')}. Add them to DERIVATIONS in scripts/rotate-index-key.js.`);

  const oldKey = config.indexKey;
  let rows = 0; let values = 0; let chain;
  try {
    db.transaction(() => {
      for (const t of tables) {
        const { source, derive } = DERIVATIONS[t.table];
        for (const r of db.all(`SELECT id, ${source.join(',')} FROM ${t.table}`)) {
          const plain = {};
          config.indexKey = oldKey;
          for (const c of source) { try { plain[c] = r[c] ? decrypt(r[c]) : null; } catch { plain[c] = null; } }
          config.indexKey = newKey;
          const idx = derive(plain);
          const cols = t.cols.filter(c => c in idx);
          db.run(`UPDATE ${t.table} SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`, ...cols.map(c => idx[c]), r.id);
          rows++; values += cols.length;
        }
      }
      config.indexKey = oldKey;
      chain = audit.resignChain(newKey);
      config.indexKey = newKey;
      audit.log({ user: { username: 'cli' }, action: 'security.index_key_rotated', details: { rows, values, tables: tables.map(t => t.table), audit_rows_resigned: chain.resigned } });
    });
  } catch (e) { config.indexKey = oldKey; throw e; }
  return { rows, values, tables: tables.map(t => t.table), chain };
}

if (require.main === module) {
  const newHex = process.env.NEW_INDEX_KEY;
  if (!newHex || !/^[0-9a-fA-F]{64}$/.test(newHex)) { console.error('Set NEW_INDEX_KEY to 64 hex characters (npm run gen-key)'); process.exit(1); }
  db.open();
  let result;
  try { result = rotateIndexKey(Buffer.from(newHex, 'hex')); }
  catch (e) { console.error(`[suds] ${e.message}`); db.close(); process.exit(1); }
  db.close();
  // Where the key came from decides who updates it. From the environment: the operator does (the value
  // is theirs). From keys.json (setup-wizard installs) or the development key file: this script does,
  // because those installs have no operator editing JSON by hand.
  if (config.keySource === 'file' && fs.existsSync(config.keysJsonPath)) {
    const keys = JSON.parse(fs.readFileSync(config.keysJsonPath, 'utf8')); keys.SUDS_INDEX_KEY = newHex; keys.index_key_rotated_at = new Date().toISOString();
    fs.writeFileSync(config.keysJsonPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.log(`Updated ${config.keysJsonPath} — download a fresh key backup (Administration → System) and keep the old one with the backups made before today.`);
  } else if (!config.isProd && !process.env.SUDS_INDEX_KEY && !process.env.SUDS_DB_PATH) {
    const f = path.join(config.dataDir, '.dev-index-key'); if (fs.existsSync(f)) { fs.writeFileSync(f, newHex, { mode: 0o600 }); console.log(`Updated ${f}`); }
  } else {
    console.log(`Set SUDS_INDEX_KEY=${newHex.slice(0, 6)}… in the environment before starting the server.`);
  }
  console.log(`Re-derived ${result.values} blind indexes across ${result.rows} rows in ${result.tables.length} table(s) (${result.tables.join(', ')}); re-signed ${result.chain.resigned} of ${result.chain.checked} audit entries.`);
}

module.exports = { indexedColumns, rotateIndexKey, DERIVATIONS };
