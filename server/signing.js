'use strict';
// Ed25519 signatures for the evidence SUDS hands to someone else: the recovery-drill report and the audit
// export's manifest. The HMACs those documents also carry are keyed with the index key, which whoever runs
// the database necessarily holds — so an HMAC proves nothing to an auditor about who made the document. A
// signature does: it is made with a private key kept with the other keys (never in the database; see
// server/config.js loadSigningKey) and checked with the public key alone, which is published at
// GET /api/admin/security/signing-key and embedded in every signed document.
//
// Kept free of the database and of config at require time, so the offline verifiers
// (scripts/verify-audit-export.js, scripts/verify-dr-report.js) can use verify() with nothing but Node.
const crypto = require('node:crypto');

// PKCS#8 wrapper for a raw 32-byte Ed25519 private key (RFC 8410): node:crypto has no "from seed" call.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ALGORITHM = 'Ed25519';

function privateKeyFrom(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('The signing key must be 32 bytes');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}
let cached = null;
function keys(seed = require('./config').signingKey) {
  if (cached && cached.seed.equals(seed)) return cached;
  const privateKey = privateKeyFrom(seed);
  const publicKey = crypto.createPublicKey(privateKey);
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  cached = { seed, privateKey, publicKey, pem, keyId: keyIdOf(pem) };
  return cached;
}
/** A short, stable name for a public key: the first 16 hex characters of SHA-256 over its DER encoding. */
function keyIdOf(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** What GET /api/admin/security/signing-key publishes. */
function publicInfo(seed) {
  const k = keys(seed);
  const der = k.publicKey.export({ type: 'spki', format: 'der' });
  return { algorithm: ALGORITHM, key_id: k.keyId, public_key_pem: k.pem, sha256_fingerprint: crypto.createHash('sha256').update(der).digest('hex') };
}

/** Sign a string or bytes. Returns the signature, base64. */
function sign(data, seed) { return crypto.sign(null, Buffer.from(data), keys(seed).privateKey).toString('base64'); }

/** Check a base64 signature over `data` with a PEM public key. Never throws; false for anything malformed. */
function verify(data, signatureB64, publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(String(signatureB64), 'base64'));
  } catch { return false; }
}

module.exports = { ALGORITHM, sign, verify, publicInfo, keyIdOf, privateKeyFrom };
