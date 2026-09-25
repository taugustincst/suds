'use strict';
// Blind indexes (the *_idx columns) are HMAC-SHA256 under SUDS_INDEX_KEY. For low-entropy values -- a date
// of birth has ~36,500 plausible values, a phone number's digits a few billion, a surname prefix a few
// thousand -- anyone holding the index key can recover the value by trying them all. So the index key must be
// a different key from the one that encrypts the records, and one install's indexes must be useless against
// another's (docs/security/ENCRYPTION-AND-KEYS.md, "Blind indexes").
const { test } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const H = require('./helpers');
const config = require('../server/config');
const { blindIndex, encrypt, decrypt } = require('../server/crypto');
const checks = require('../server/startup-checks');

test('the index key and the encryption key are distinct 256-bit keys', () => {
  assert.equal(config.encryptionKey.length, 32);
  assert.equal(config.indexKey.length, 32);
  assert.ok(!config.encryptionKey.equals(config.indexKey), 'separate keys');
  // The index key does not decrypt a record; the encryption key does not reproduce an index.
  const ct = encrypt('1985-06-15');
  assert.throws(() => decrypt(ct, config.indexKey));
  assert.notEqual(blindIndex('1985-06-15', config.encryptionKey), blindIndex('1985-06-15'));
});

test('the same DOB indexes differently on installs with different index keys, and never as a bare hash', () => {
  const a = nodeCrypto.randomBytes(32); const b = nodeCrypto.randomBytes(32);
  for (const dob of ['1985-06-15', '2001-01-01', '1950-12-31']) {
    const ia = blindIndex(dob, a); const ib = blindIndex(dob, b);
    assert.match(ia, /^[0-9a-f]{64}$/);
    assert.notEqual(ia, ib, 'install A\'s index says nothing about install B\'s');
    assert.equal(ia, blindIndex(dob, a), 'deterministic within an install (that is what makes it searchable)');
    assert.notEqual(ia, nodeCrypto.createHash('sha256').update(dob).digest('hex'), 'not an unkeyed hash anyone could precompute');
  }
});

test('what the index key alone exposes: a DOB is recoverable by brute force, which is why it is kept apart', () => {
  // The risk this documents, demonstrated: with the index key (and no encryption key) every date of birth in
  // a century falls out in well under a second. Without it the same search is hopeless.
  const key = nodeCrypto.randomBytes(32);
  const target = blindIndex('1979-03-02', key);
  const find = (k) => { for (let d = Date.UTC(1920, 0, 1); d < Date.UTC(2020, 0, 1); d += 86400000) { const s = new Date(d).toISOString().slice(0, 10); if (blindIndex(s, k) === target) return s; } return null; };
  assert.equal(find(key), '1979-03-02');
  assert.equal(find(nodeCrypto.randomBytes(32)), null);
});

test('a production server with the two keys set to the same value is flagged at startup', () => {
  const k = nodeCrypto.randomBytes(32);
  assert.match(checks.keySeparationProblem({ isProd: true, encryptionKey: k, indexKey: Buffer.from(k) }), /same value/);
  assert.match(checks.keySeparationProblem({ isProd: true, encryptionKey: k, indexKey: nodeCrypto.randomBytes(32), backupKey: Buffer.from(k) }), /SUDS_BACKUP_KEY/);
  assert.equal(checks.keySeparationProblem({ isProd: true, encryptionKey: k, indexKey: nodeCrypto.randomBytes(32), backupKey: null }), null);
  assert.equal(checks.keySeparationProblem(), null, 'the test configuration uses separate keys (and is not production)');
});

test('client DOB and phone indexes in the database are keyed with the index key', async () => {
  await H.start();
  try {
    const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
    const r = await admin.post('/api/clients', { first_name: 'Ida', last_name: 'Index', dob: '1985-06-15', phone: '(916) 555-0142', confirm_duplicate: true });
    assert.equal(r.status, 201);
    const row = H.db.one(`SELECT dob_idx, phone_idx, dob_enc FROM clients WHERE id=?`, r.data.id);
    assert.equal(row.dob_idx, blindIndex('1985-06-15', config.indexKey));
    assert.equal(row.phone_idx, blindIndex('9165550142', config.indexKey));
    assert.notEqual(row.dob_idx, blindIndex('1985-06-15', config.encryptionKey));
    assert.equal(decrypt(row.dob_enc), '1985-06-15');
  } finally { await H.stop(); }
});
