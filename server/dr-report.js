'use strict';
// The recovery-drill report's integrity block, and its offline check. Separate from server/dr-drill.js (which
// needs the database and the keys) so scripts/verify-dr-report.js can verify a report on an auditor's laptop
// with nothing but Node and the published public key.
//
// A report file is { report, integrity }. integrity carries:
//   sha256              SHA-256 of canonical(report)
//   hmac_sha256         HMAC-SHA256 under the index key (only the server, or the key custodian, can check it)
//   ed25519_signature   Ed25519 over canonical(report) with the signing key (server/signing.js)
//   signing_key_id      the signing public key's id (report.signed_by.key_id says the same, inside the signed body)
//   public_key_pem      the public key, for convenience; check it against the one published by the server
const crypto = require('node:crypto');
const signing = require('./signing');

/** Canonical JSON for signing: keys sorted at every level. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * Verify a report document with a public key only. `publicKeyPem` is the key obtained independently (from
 * GET /api/admin/security/signing-key, recorded when the server was set up); without it the key embedded in
 * the report is used, which proves the report is intact but not who made it — the result says so.
 */
function verifyDoc(doc, { publicKeyPem = null } = {}) {
  const errors = []; const warnings = [];
  const out = { ok: false, errors, warnings, key_id: null, key_source: publicKeyPem ? 'supplied' : 'embedded' };
  if (!doc || typeof doc !== 'object' || !doc.report || !doc.integrity) { errors.push('this is not a SUDS recovery-drill report ({ report, integrity })'); return out; }
  const { report, integrity } = doc;
  const body = canonical(report);
  if (crypto.createHash('sha256').update(body).digest('hex') !== integrity.sha256) errors.push('the SHA-256 of the report does not match its integrity block: the report was edited');
  const key = publicKeyPem || integrity.public_key_pem;
  if (!integrity.ed25519_signature) errors.push('the report is not signed (made by a SUDS version before Ed25519 signing); only its HMAC can be checked, with the index key');
  else if (!key) errors.push('no public key: supply the one published by the server (--public-key)');
  else {
    let kid = null; try { kid = signing.keyIdOf(key); } catch { errors.push('the public key is not a valid PEM key'); }
    out.key_id = kid;
    if (kid) {
      if (!signing.verify(body, integrity.ed25519_signature, key)) errors.push('the Ed25519 signature does not verify with this public key: the report was altered, or was not signed by this server');
      if (integrity.signing_key_id && integrity.signing_key_id !== kid) errors.push(`the report names signing key ${integrity.signing_key_id}, not the key supplied (${kid})`);
      if (report.signed_by && report.signed_by.key_id && report.signed_by.key_id !== kid) errors.push(`the signed report names signing key ${report.signed_by.key_id}, not ${kid}`);
    }
    if (!publicKeyPem) warnings.push(`checked with the public key embedded in the report (key id ${kid}); compare that id with the one published by the server (Settings → Security status, or GET /api/admin/security/signing-key) before relying on it`);
  }
  out.ok = errors.length === 0;
  return out;
}

module.exports = { canonical, verifyDoc };
