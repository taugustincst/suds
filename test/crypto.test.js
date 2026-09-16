'use strict';
process.env.SUDS_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../server/crypto');

test('encrypt/decrypt roundtrip and tamper detection', () => {
  const ct = c.encrypt('Jane Doe 555-0100');
  assert.notEqual(ct, 'Jane Doe 555-0100');
  assert.equal(c.decrypt(ct), 'Jane Doe 555-0100');
  const parts = ct.split(':'); parts[3] = Buffer.from('xx').toString('base64') + parts[3].slice(4);
  assert.throws(() => c.decrypt(parts.join(':')));
  assert.equal(c.decrypt(null), null);
});
test('blind index normalizes', () => {
  assert.equal(c.blindIndex('O\'Brien'), c.blindIndex('obrien'));
  assert.notEqual(c.blindIndex('smith'), c.blindIndex('smyth'));
  assert.equal(c.blindIndex(''), null);
});
test('password hashing', () => {
  const h = c.hashPassword('CorrectHorse1!');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(c.verifyPassword('CorrectHorse1!', h));
  assert.ok(!c.verifyPassword('wrong', h));
  assert.ok(!c.verifyPassword('x', 'garbage'));
});
test('TOTP generates and verifies', () => {
  const s = c.generateTotpSecret();
  const code = c.totp(s);
  assert.match(code, /^\d{6}$/);
  assert.ok(c.verifyTotp(s, code));
  assert.ok(!c.verifyTotp(s, '000000') || code === '000000');
  assert.ok(!c.verifyTotp(s, 'abc'));
  // RFC 6238 test vector (SHA1, secret "12345678901234567890", T=59 -> 94287082)
  const secret = c.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(c.totp(secret, 59 * 1000), '287082');
});
