'use strict';
// scripts/rotate-index-key.js: after the blind-index key is rotated, the search box still finds the same
// people, and the audit chain — whose HMAC is keyed with the same key — still verifies.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const config = require('../server/config');
const audit = require('../server/audit');
const { rotateIndexKey, indexedColumns } = require('../scripts/rotate-index-key');

let admin, nav;
before(async () => {
  await H.start();
  H.makeUser('nav1', 'navigator');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('every blind-index column in the schema has a known derivation', () => {
  // A new *_idx column that nobody taught the script about must fail this, not be silently left under the old key.
  const { DERIVATIONS } = require('../scripts/rotate-index-key');
  for (const t of indexedColumns(H.db)) {
    assert.ok(DERIVATIONS[t.table], `${t.table} has _idx columns but no derivation`);
    const known = Object.keys(DERIVATIONS[t.table].derive({}));
    for (const c of t.cols) assert.ok(known.includes(c), `${t.table}.${c} has no derivation`);
  }
});

test('search still finds the client after the index key is rotated, and the audit chain verifies under the new key', async () => {
  const made = await nav.post('/api/clients', { first_name: 'Rosalind', last_name: 'Nguyen', dob: '1988-02-14', phone: '(555) 010-0199' });
  assert.equal(made.status, 201);
  const find = async (q) => (await nav.get(`/api/clients?q=${encodeURIComponent(q)}`)).data.clients.length;
  assert.equal(await find('nguyen'), 1); assert.equal(await find('rosalind'), 1); assert.equal(await find('1988-02-14'), 1); assert.equal(await find('5550100199'), 1);
  assert.equal(await find('Ngu'), 1, 'prefix index'); assert.equal(await find('Nguyan'), 1, 'phonetic index');
  const before = H.db.one(`SELECT last_name_idx, full_name_idx, phone_idx FROM clients WHERE id=?`, made.data.id);
  assert.equal(audit.verifyChain().ok, true);
  const entriesBefore = H.db.one(`SELECT COUNT(*) n FROM audit_log`).n;

  const oldKey = config.indexKey;
  const newKey = require('node:crypto').createHash('sha256').update('rotated-index-key').digest();
  assert.throws(() => rotateIndexKey(oldKey), /equals the current key/);
  const result = rotateIndexKey(newKey);
  assert.ok(result.rows >= 1); assert.ok(result.tables.includes('clients'));
  assert.ok(config.indexKey.equals(newKey), 'the process now uses the new key');

  // The chain was re-signed in place, kept its length plus the rotation entry, and verifies under the new
  // key — while the old key no longer does, which is what "rotated" means.
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log`).n, entriesBefore + 1);
  assert.equal(audit.verifyChain().ok, true);
  assert.equal(audit.verifyChain({ key: oldKey }).ok, false);
  assert.ok(result.chain.resigned >= entriesBefore - 1);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='security.index_key_rotated'`));

  const afterRow = H.db.one(`SELECT last_name_idx, full_name_idx, phone_idx FROM clients WHERE id=?`, made.data.id);
  for (const k of Object.keys(before)) assert.notEqual(afterRow[k], before[k], `${k} was re-derived`);
  assert.equal(await find('nguyen'), 1); assert.equal(await find('rosalind'), 1); assert.equal(await find('1988-02-14'), 1); assert.equal(await find('5550100199'), 1);
  assert.equal(await find('Ngu'), 1); assert.equal(await find('Nguyan'), 1);
  assert.equal(await find('smith'), 0);
  // New writes chain onto the re-signed rows without a seam
  await nav.post('/api/clients', { first_name: 'After', last_name: 'Rotation' });
  assert.equal(audit.verifyChain().ok, true);
  assert.equal((await admin.get('/api/admin/audit/verify')).data.ok, true);
});

test('rotation succeeds once the audit head has been checkpointed, and re-seals the head under the new key', async () => {
  // Before: the head was sealed under the old key, so the post-rotation verification read the untouched
  // chain as truncated and rolled the whole rotation back.
  await nav.post('/api/clients', { first_name: 'Before', last_name: 'Checkpoint' });
  assert.ok(audit.checkpoint(), 'a checkpoint exists');
  assert.equal(audit.verifyChain().checkpointed, true);
  const headBefore = H.db.getSetting('audit_head');
  const oldKey = config.indexKey;
  const newKey = require('node:crypto').createHash('sha256').update('rotated-after-checkpoint').digest();
  const result = rotateIndexKey(newKey);
  assert.ok(result.chain.resigned >= 1);
  assert.ok(config.indexKey.equals(newKey));
  const v = audit.verifyChain();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.checkpointed, true, 'still pinned');
  assert.equal(v.truncated, false);
  assert.notEqual(H.db.getSetting('audit_head'), headBefore, 'the head was re-sealed under the new key');
  assert.equal(audit.verifyChain({ key: oldKey }).ok, false);
  const sv = audit.scheduledVerify();
  assert.equal(sv.ok, true);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='audit.verify.failed'`).n, 0, 'the scheduled verification after a rotation is clean');
  assert.equal((await admin.get('/api/admin/audit/verify')).data.ok, true);
});

test('a chain that already fails is not re-signed', () => {
  H.db.run(`UPDATE audit_log SET details='tampered' WHERE id=(SELECT MIN(id) FROM audit_log WHERE details IS NOT NULL)`);
  const another = require('node:crypto').createHash('sha256').update('third-key').digest();
  const keyBefore = config.indexKey;
  assert.throws(() => rotateIndexKey(another), /does not verify under the current key/);
  assert.ok(config.indexKey.equals(keyBefore), 'the key in use is unchanged after a refused rotation');
});
