'use strict';
// WebAuthn (passkey) verification with node:crypto alone (docs/FINGERPRINT.md): no npm package, as for the rest of
// SUDS. What is here is the part of the W3C Web Authentication Level 2 relying-party procedure that SUDS needs:
//  * a CBOR decoder (RFC 8949) for the attestation object and the credential public key, definite lengths only;
//  * authenticator data (§6.1): the RP ID hash, the flags (UP, UV, BE, BS, AT, ED), the signature counter and the
//    attested credential data (AAGUID, credential id, COSE public key);
//  * a COSE_Key (RFC 9053) turned into a node:crypto KeyObject for the three algorithms SUDS asks for:
//    ES256 (-7, P-256), EdDSA (-8, Ed25519) and RS256 (-257, RSASSA-PKCS1-v1_5 with SHA-256);
//  * registration (§7.1) and assertion (§7.2) verification, and re-verification of stored signature evidence.
//
// SUDS never receives a fingerprint: the device's authenticator matches the finger (or the device PIN) and signs.
// What comes back is a public key at registration, and a signature over the challenge afterwards.
//
// Kept free of the database and of config at require time, so an offline verifier can use verifyEvidence() with
// nothing but Node (scripts/verify-passkey-evidence.js).
const crypto = require('node:crypto');

const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };
const ALGS = { ES256: -7, EdDSA: -8, RS256: -257 };
const ALG_NAMES = { [-7]: 'ES256', [-8]: 'EdDSA', [-257]: 'RS256' };

class WebAuthnError extends Error {
  /** `code` is a short machine name for the failure (for tests and the audit entry); the message is for people. */
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new WebAuthnError(code, message); };

// ---- base64url ----
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) fail('encoding', 'A value is not base64url');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ---- CBOR (RFC 8949), the subset WebAuthn uses ----
/** Decode one CBOR item from `buf` at `offset`. Returns { value, end }. Maps become Map (keys may be integers). */
function cborDecode(buf, offset = 0, depth = 0) {
  if (depth > 16) fail('cbor', 'CBOR nested too deeply');
  let p = offset;
  const need = (n) => { if (p + n > buf.length) fail('cbor', 'CBOR data ends early'); };
  need(1);
  const ib = buf[p++]; const major = ib >> 5; const info = ib & 0x1f;
  const arg = () => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[p++]; }
    if (info === 25) { need(2); const v = buf.readUInt16BE(p); p += 2; return v; }
    if (info === 26) { need(4); const v = buf.readUInt32BE(p); p += 4; return v; }
    if (info === 27) { need(8); const v = buf.readBigUInt64BE(p); p += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail('cbor', 'CBOR integer too large'); return Number(v); }
    fail('cbor', 'CBOR indefinite lengths are not accepted');
  };
  switch (major) {
    case 0: return { value: arg(), end: p };
    case 1: return { value: -1 - arg(), end: p };
    case 2: { const n = arg(); need(n); const v = Buffer.from(buf.subarray(p, p + n)); return { value: v, end: p + n }; }
    case 3: { const n = arg(); need(n); const v = buf.subarray(p, p + n).toString('utf8'); return { value: v, end: p + n }; }
    case 4: { const n = arg(); if (n > 1024) fail('cbor', 'CBOR array too long'); const out = []; for (let i = 0; i < n; i++) { const r = cborDecode(buf, p, depth + 1); out.push(r.value); p = r.end; } return { value: out, end: p }; }
    case 5: { const n = arg(); if (n > 256) fail('cbor', 'CBOR map too long'); const m = new Map(); for (let i = 0; i < n; i++) { const k = cborDecode(buf, p, depth + 1); const v = cborDecode(buf, k.end, depth + 1); if (m.has(k.value)) fail('cbor', 'CBOR map has a duplicate key'); m.set(k.value, v.value); p = v.end; } return { value: m, end: p }; }
    case 6: { arg(); return cborDecode(buf, p, depth + 1); } // a tag: its content
    case 7: {
      if (info === 20) return { value: false, end: p };
      if (info === 21) return { value: true, end: p };
      if (info === 22 || info === 23) return { value: null, end: p };
      fail('cbor', 'CBOR floating-point and simple values are not accepted');
    }
  }
  fail('cbor', 'CBOR item not understood');
}
/** Decode a whole buffer holding exactly one CBOR item. */
function cborDecodeAll(buf) {
  const r = cborDecode(buf, 0);
  if (r.end !== buf.length) fail('cbor', 'CBOR data has bytes left over');
  return r.value;
}

// ---- authenticator data (§6.1) ----
function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) fail('authdata', 'Authenticator data is too short');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  out.up = !!(out.flags & FLAGS.UP); out.uv = !!(out.flags & FLAGS.UV); out.be = !!(out.flags & FLAGS.BE); out.bs = !!(out.flags & FLAGS.BS);
  let p = 37;
  if (out.flags & FLAGS.AT) {
    if (buf.length < p + 18) fail('authdata', 'Attested credential data is too short');
    out.aaguid = buf.subarray(p, p + 16); p += 16;
    const len = buf.readUInt16BE(p); p += 2;
    if (len < 1 || len > 1023 || buf.length < p + len) fail('authdata', 'The credential id is not a valid length');
    out.credentialId = Buffer.from(buf.subarray(p, p + len)); p += len;
    const k = cborDecode(buf, p);
    out.coseKey = k.value; out.coseKeyBytes = Buffer.from(buf.subarray(p, k.end)); p = k.end;
  }
  if (out.flags & FLAGS.ED) { const e = cborDecode(buf, p); out.extensions = e.value; p = e.end; }
  if (p !== buf.length) fail('authdata', 'Authenticator data has bytes left over');
  return out;
}
/** The AAGUID as the usual 8-4-4-4-12 hex form. */
function aaguidString(b) { const h = Buffer.from(b).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }

// ---- COSE_Key -> KeyObject ----
/** A credential public key (a decoded COSE_Key Map) as { key: KeyObject, alg, spki (base64 DER) }. */
function coseToKey(cose) {
  if (!(cose instanceof Map)) fail('cose', 'The credential public key is not a COSE key');
  const kty = cose.get(1); const alg = cose.get(3);
  if (!ALG_NAMES[alg]) fail('alg', 'The credential uses an algorithm SUDS does not accept (ES256, EdDSA or RS256)');
  let jwk;
  if (alg === ALGS.ES256) {
    const x = cose.get(-2), y = cose.get(-3);
    if (kty !== 2 || cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) fail('cose', 'The ES256 key is not a P-256 key');
    jwk = { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) };
  } else if (alg === ALGS.EdDSA) {
    const x = cose.get(-2);
    if (kty !== 1 || cose.get(-1) !== 6 || !Buffer.isBuffer(x) || x.length !== 32) fail('cose', 'The EdDSA key is not an Ed25519 key');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(x) };
  } else {
    const n = cose.get(-1), e = cose.get(-2);
    if (kty !== 3 || !Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) fail('cose', 'The RS256 key is not an RSA key of 2048 bits or more');
    jwk = { kty: 'RSA', n: b64url(n), e: b64url(e) };
  }
  let key;
  try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { fail('cose', 'The credential public key could not be read'); }
  return { key, alg, spki: key.export({ type: 'spki', format: 'der' }).toString('base64') };
}
function keyFromSpki(spkiB64) { return crypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' }); }

/** Check a WebAuthn signature over authenticatorData || SHA-256(clientDataJSON). */
function verifySignature(alg, key, authData, clientDataJSON, signature) {
  const data = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  try {
    if (alg === ALGS.ES256) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
    if (alg === ALGS.RS256) return crypto.verify('sha256', data, key, signature);
    if (alg === ALGS.EdDSA) return crypto.verify(null, data, key, signature);
  } catch { return false; }
  return false;
}

// ---- client data (§5.8.1) ----
function parseClientData(buf, { type, challenge, origins }) {
  let c;
  try { c = JSON.parse(buf.toString('utf8')); } catch { fail('clientdata', 'The client data is not JSON'); }
  if (!c || typeof c !== 'object') fail('clientdata', 'The client data is not an object');
  if (c.type !== type) fail('type', `The client data is for ${String(c.type).slice(0, 40)}, not ${type}`);
  if (typeof c.challenge !== 'string') fail('challenge', 'The client data has no challenge');
  if (challenge !== undefined && (c.challenge.length !== challenge.length || !crypto.timingSafeEqual(Buffer.from(c.challenge), Buffer.from(challenge)))) fail('challenge', 'The challenge does not match');
  if (!origins.includes(c.origin)) fail('origin', 'The request came from a page SUDS does not serve (origin mismatch)');
  // A page embedded in another site's frame is not where a signature is given.
  if (c.crossOrigin === true) fail('origin', 'Passkeys are not accepted from an embedded page');
  return c;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function checkAuthFlags(ad, rpId) {
  if (!crypto.timingSafeEqual(ad.rpIdHash, sha256(Buffer.from(rpId, 'utf8')))) fail('rpid', 'The passkey belongs to a different site (RP ID mismatch)');
  if (!ad.up) fail('up', 'The authenticator did not confirm a person was present');
  // User verification is required: the fingerprint (or the device's screen lock). A passkey used without it is refused.
  if (!ad.uv) fail('uv', 'The device did not verify you (fingerprint or screen lock). Passkeys are accepted only with that check.');
}

/**
 * Registration (§7.1). `response` holds base64url clientDataJSON and attestationObject; `id` is the credential id
 * (base64url) the browser reported. Returns what SUDS stores: credential id, public key (SPKI, base64), algorithm,
 * sign count, AAGUID, backup flags and transports. Attestation is not verified: SUDS asks for 'none' and records the
 * AAGUID as reported, for information only.
 */
function verifyRegistration({ id, response, transports: given }, { challenge, rpId, origins, algs = [ALGS.ES256, ALGS.EdDSA, ALGS.RS256] }) {
  if (!response || typeof response !== 'object') fail('shape', 'The passkey response is missing');
  const clientDataJSON = fromB64url(response.clientDataJSON || '');
  parseClientData(clientDataJSON, { type: 'webauthn.create', challenge, origins });
  const att = cborDecodeAll(fromB64url(response.attestationObject || ''));
  if (!(att instanceof Map) || typeof att.get('fmt') !== 'string' || !Buffer.isBuffer(att.get('authData'))) fail('attestation', 'The attestation object is not understood');
  const ad = parseAuthData(att.get('authData'));
  checkAuthFlags(ad, rpId);
  if (!ad.credentialId) fail('authdata', 'The authenticator did not return a new credential');
  if (id !== undefined && b64url(ad.credentialId) !== id) fail('credential', 'The credential id does not match the authenticator data');
  const k = coseToKey(ad.coseKey);
  if (!algs.includes(k.alg)) fail('alg', 'The credential uses an algorithm SUDS did not ask for');
  const known = ['internal', 'hybrid', 'usb', 'nfc', 'ble', 'smart-card'];
  const transports = given || response.transports;
  return {
    credentialId: b64url(ad.credentialId), publicKey: k.spki, alg: k.alg, signCount: ad.signCount,
    aaguid: ad.aaguid ? aaguidString(ad.aaguid) : null, backupEligible: ad.be, backedUp: ad.bs, fmt: att.get('fmt'),
    transports: Array.isArray(transports) ? transports.filter(t => known.includes(t)) : [],
  };
}

/**
 * Assertion (§7.2) against a stored credential { publicKey (SPKI base64), alg, signCount }. `challenge` is the
 * expected base64url challenge. Returns { signCount, flags, clientData, cloned }: `cloned` is true when a counter
 * that was in use did not go up (the credential may have been copied), which the caller refuses and records.
 */
function verifyAssertion({ response }, stored, { challenge, rpId, origins }) {
  if (!response || typeof response !== 'object') fail('shape', 'The passkey response is missing');
  const clientDataJSON = fromB64url(response.clientDataJSON || '');
  const authData = fromB64url(response.authenticatorData || '');
  const signature = fromB64url(response.signature || '');
  const clientData = parseClientData(clientDataJSON, { type: 'webauthn.get', challenge, origins });
  const ad = parseAuthData(authData);
  checkAuthFlags(ad, rpId);
  if (!verifySignature(stored.alg, keyFromSpki(stored.publicKey), authData, clientDataJSON, signature)) fail('signature', 'The passkey signature is not valid');
  const prev = Number(stored.signCount) || 0;
  const cloned = (prev > 0 || ad.signCount > 0) && ad.signCount <= prev;
  return { signCount: ad.signCount, flags: ad.flags, uv: ad.uv, up: ad.up, backedUp: ad.bs, clientData, cloned, authData, clientDataJSON, signature };
}

// ---- signing statements (docs/FINGERPRINT.md, "What a fingerprint signature is bound to") ----
/** JSON with object keys sorted at every level: the canonical form a statement is hashed in. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
/** The WebAuthn challenge for a statement: SHA-256 over its canonical JSON. */
function statementChallenge(statement) { return sha256(Buffer.from(canonical(statement), 'utf8')); }

/**
 * Re-verify stored signature evidence, offline: the statement hashes to the challenge the browser signed, the
 * client data is a WebAuthn get for an origin on the relying party, the authenticator data is for that RP ID with
 * user presence and user verification, and the signature is valid under the credential's public key. Returns
 * { ok, checks: { statement, type, rp, flags, signature }, reason }. Never throws.
 */
function verifyEvidence(ev) {
  const checks = { statement: false, type: false, rp: false, flags: false, signature: false };
  try {
    const clientDataJSON = fromB64url(ev.client_data_json);
    const authData = fromB64url(ev.authenticator_data);
    const signature = fromB64url(ev.signature);
    const cd = JSON.parse(clientDataJSON.toString('utf8'));
    const want = b64url(statementChallenge(ev.statement));
    checks.statement = cd.challenge === want && (!ev.statement_hash || ev.statement_hash === statementChallenge(ev.statement).toString('hex'));
    checks.type = cd.type === 'webauthn.get';
    const ad = parseAuthData(authData);
    let host = ''; try { host = new URL(cd.origin).hostname; } catch { host = ''; }
    checks.rp = sha256(Buffer.from(ev.rp_id, 'utf8')).equals(ad.rpIdHash) && (host === ev.rp_id || host.endsWith('.' + ev.rp_id));
    checks.flags = ad.up && ad.uv;
    checks.signature = verifySignature(ev.alg, keyFromSpki(ev.public_key), authData, clientDataJSON, signature);
    const ok = Object.values(checks).every(Boolean);
    return { ok, checks, reason: ok ? null : Object.keys(checks).find(k => !checks[k]) };
  } catch (e) { return { ok: false, checks, reason: e.message }; }
}

module.exports = { FLAGS, ALGS, ALG_NAMES, WebAuthnError, b64url, fromB64url, cborDecode, cborDecodeAll, parseAuthData, aaguidString, coseToKey, keyFromSpki, verifySignature,
  verifyRegistration, verifyAssertion, canonical, statementChallenge, verifyEvidence };
