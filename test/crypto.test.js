'use strict';
const { test: t0 } = require('node:test');
t0('the self-signed certificate is a CA-signed leaf, so the CA can be installed on a phone', () => {
  const { X509Certificate } = require('node:crypto');
  const c = require('../server/selfsigned').generate({ commonName: 'SUDS', org: 'County', hosts: ['localhost', '192.168.1.5', 'suds.local'] });
  const leaf = new X509Certificate(c.cert), ca = new X509Certificate(c.ca);
  require('node:assert').equal(ca.ca, true, 'the installable certificate is a CA');
  require('node:assert').equal(leaf.ca, false, 'the server certificate is not');
  require('node:assert').equal(leaf.verify(ca.publicKey), true, 'and is signed by it');
  require('node:assert').match(leaf.subjectAltName, /IP Address:192\.168\.1\.5/);
  require('node:assert').ok(c.cert.split('BEGIN CERTIFICATE').length === 3, 'the server file carries the chain');
});
t0('the CA a phone installs is name-constrained to the server\'s own hosts and outlives its leaf by a month, not a decade', async () => {
  const assert = require('node:assert');
  const { X509Certificate } = require('node:crypto');
  const c = require('../server/selfsigned').generate({ commonName: 'SUDS', org: 'County', hosts: ['localhost', '127.0.0.1', 'suds.local'], days: 100 });
  const leaf = new X509Certificate(c.cert), ca = new X509Certificate(c.ca);
  const caDays = (Date.parse(ca.validTo) - Date.parse(leaf.validTo)) / 86400000;
  assert.ok(caDays > 29 && caDays < 31, `the CA expires 30 days after the leaf, not ${caDays} days`);
  // Name constraints (OID 2.5.29.30, critical): DER 06 03 55 1D 1E followed by BOOLEAN TRUE
  assert.ok(ca.raw.includes(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e, 0x01, 0x01, 0xff])), 'the CA carries a critical nameConstraints extension');
  // And a real TLS client (OpenSSL, which enforces name constraints when it builds the chain) still
  // accepts the server certificate for a permitted name. Node's tls does the verification here.
  const tls = require('node:tls');
  const server = tls.createServer({ cert: c.cert, key: c.key }, (s) => { s.end('ok'); });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  try {
    const connect = (servername) => new Promise((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: server.address().port, ca: c.ca, servername, rejectUnauthorized: true }, () => { s.end(); resolve(s.authorized); });
      s.on('error', reject);
    });
    assert.equal(await connect('suds.local'), true, 'a name inside the constraints verifies');
    await assert.rejects(connect('evil.example'), /altnames|Hostname|does not match/i, 'a name outside them does not');
  } finally { await new Promise(res => server.close(res)); }
});
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
