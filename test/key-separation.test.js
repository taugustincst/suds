'use strict';
// Security review of 1.12.4, item 9: SUDS_INDEX_KEY keyed the blind indexes, the audit chain and anchors,
// and the OIDC state cookie with the same bytes, so a MAC made for one purpose was a valid MAC for any other
// that happened to cover the same text. New uses get a purpose-separated subkey (HKDF-SHA256 from the index
// key, crypto.subkey); the OIDC state cookie is the first. (The audit chain keeps the index key itself:
// changing it would break verification of every existing entry. docs/security/ENCRYPTION-AND-KEYS.md.)
const { test } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
process.env.SUDS_ENV = 'test';
const config = require('../server/config');
const C = require('../server/crypto');

test('subkeys are HKDF-SHA256 of the index key, one per purpose, and never the index key', () => {
  const a = C.subkey('oidc-state'); const b = C.subkey('oidc-state'); const c = C.subkey('something-else');
  assert.ok(Buffer.isBuffer(a) && a.length === 32);
  assert.ok(a.equals(b), 'deterministic');
  assert.ok(!a.equals(c), 'purpose-separated');
  assert.ok(!a.equals(Buffer.from(config.indexKey)));
  const expected = Buffer.from(nodeCrypto.hkdfSync('sha256', config.indexKey, Buffer.from('suds-subkey-v1'), Buffer.from('suds/oidc-state'), 32));
  assert.ok(a.equals(expected), 'the documented derivation');
  assert.throws(() => C.subkey(''), /purpose/);
});

test('the OIDC state cookie is signed with its subkey, not the index key', () => {
  const oidc = require('../server/oidc');
  const token = oidc._signStateForTests({ state: 's', exp: Date.now() + 60_000 });
  const [body, sig] = token.split('.');
  const withIndex = Buffer.from(nodeCrypto.createHmac('sha256', config.indexKey).update(body).digest()).toString('base64url');
  const withSub = Buffer.from(nodeCrypto.createHmac('sha256', C.subkey('oidc-state')).update(body).digest()).toString('base64url');
  assert.notEqual(sig, withIndex);
  assert.equal(sig, withSub);
  assert.equal(oidc.readState(token).state, 's');
  assert.equal(oidc.readState(`${body}.${withIndex}`), null, 'a MAC under the index key is not accepted');
});
