'use strict';
// The two-step enrolment link must fit the app's QR code (public/qr.js stops at version 10), whatever the
// programme is called: the issuer appears twice in it, and a county's full name used to overflow it.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { otpauthUrl, generateTotpSecret } = require('../server/crypto');

test('a long programme name still gives an enrolment link the QR encoder takes', async () => {
  // A browser module in a CommonJS package: loaded from its source as an ES module.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'qr.js'), 'utf8');
  const { qrMatrix: encode } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const secret = generateTotpSecret();
  for (const org of ['SUDS', 'Harbor Outreach', 'County of San Bernardino Department of Behavioral Health — Substance Use Disorder and Recovery Services', 'Condado de Riverside: Servicios de Salud Conductual — Programa de Reducción de Daños y Recuperación']) {
    const url = otpauthUrl(secret, 'maria.rivera@example.org', org);
    assert.ok(Buffer.byteLength(url) <= 200, `${org.slice(0, 20)}…: ${Buffer.byteLength(url)} bytes`);
    assert.doesNotThrow(() => encode(url), `${org.slice(0, 20)}… encodes`);
    const u = new URL(url);
    assert.equal(u.searchParams.get('secret'), secret, 'the secret is never shortened');
    assert.ok(org.startsWith(u.searchParams.get('issuer')), 'the issuer is the start of the programme\'s name');
  }
  assert.equal(new URL(otpauthUrl(secret, 'mrivera', 'Harbor Outreach')).searchParams.get('issuer'), 'Harbor Outreach', 'a short name is left whole');
});
