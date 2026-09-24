'use strict';
// Migration 26 re-derives every client's name indexes under the Unicode-aware normalisation, so a record
// entered before it — whose Arabic surname indexed as nothing, or whose "Øster" indexed as "ster" — is
// found by search and matched as a duplicate after the upgrade, not only records entered since.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '2'.repeat(64);
process.env.SUDS_INDEX_KEY = '3'.repeat(64);
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-nameidx-'));
const dbPath = path.join(dir, 'suds.db');
after(() => { try { require('../server/db').close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

test('migration 26 recomputes the name indexes of existing clients', () => {
  const db = require('../server/db');
  const { encrypt, blindIndex } = require('../server/crypto');
  const M = require('../server/clients-model');
  db.open(dbPath);
  const add = (id, first, last, extra = {}) => db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,dob_enc,last_name_idx,full_name_idx,name_prefix_idx,name_phonetic_idx,first_name_idx,dob_idx) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, `C26-${id}`, encrypt(first), encrypt(last), extra.dob ? encrypt(extra.dob) : null, ...(extra.idx || [null, null, null, null, null]), extra.dob ? blindIndex(extra.dob) : null);
  // What 1.9.4 stored: nothing at all for an Arabic name, and "ster" for Øster.
  add('0001', 'علي', 'حسن', { dob: '1980-01-01' });
  add('0002', 'Ingrid', 'Øster', { idx: [blindIndex('ster'), blindIndex('sterIngrid'), 'stale', 'stale', blindIndex('ingrid')] });
  add('0003', 'Unreadable', 'Row');
  db.run(`UPDATE clients SET last_name_enc='v1:not:valid:cipher', last_name_idx='kept' WHERE id='0003'`);
  db.run(`UPDATE settings SET value='25' WHERE key='schema_version'`);
  db.close();

  db.open(dbPath);
  assert.equal(db.getSetting('schema_version'), String(db.LATEST_SCHEMA_VERSION));
  const a = db.one(`SELECT * FROM clients WHERE id='0001'`);
  assert.equal(a.last_name_idx, blindIndex('حسن'));
  assert.equal(a.full_name_idx, blindIndex('حسنعلي'));
  assert.equal(a.name_prefix_idx, M.namePrefixIndex('حسن'));
  assert.equal(a.name_phonetic_idx, M.namePhoneticIndex('حسن'));
  assert.equal(a.first_name_idx, blindIndex('علي'));
  assert.equal(a.dob_idx, blindIndex('1980-01-01'), 'unchanged values are rewritten identically');
  const o = db.one(`SELECT * FROM clients WHERE id='0002'`);
  assert.equal(o.last_name_idx, blindIndex('Oster'));
  assert.equal(o.name_phonetic_idx, M.namePhoneticIndex('Oster'));
  assert.equal(db.one(`SELECT last_name_idx FROM clients WHERE id='0003'`).last_name_idx, 'kept', 'a row that cannot be decrypted keeps what it had');
});
