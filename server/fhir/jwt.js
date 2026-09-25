'use strict';
// SMART Backend Services client authentication (private_key_jwt, RFC 7523 §2.2 as profiled by SMART App
// Launch 2.x "Backend Services"): the FHIR client proves who it is by signing a short-lived JWT with a
// private key whose public half it registered with SUDS, instead of sending a shared secret. node:crypto
// only — no JOSE library, so the supply chain stays empty.
//
// What is accepted, and why:
//   * alg RS384 (RSA, at least 2048 bits) or ES384 (EC P-384): the two algorithms SMART requires servers to
//     support. "none", HMAC and every other alg are refused, and the key's own kty/crv must match the alg,
//     so a public RSA key can never be used as an HMAC secret (the classic alg-confusion attack).
//   * iss = sub = the client_id; aud = this server's token URL; exp in the future and no more than five
//     minutes away; a jti never seen before for this client (kept in fhir_jwt_assertions until it expires,
//     so a restart does not reopen the window).
//   * the key comes from the JWKS the administrator registered (pasted in), or from a JWKS URL, which is
//     https only and fetched through the same SSRF guard as provider pictures (server/region-pictures.js):
//     never an address on this machine or the county network. Fetched sets are cached for an hour; an
//     unknown kid refetches (at most once a minute) so the client can rotate keys without calling anyone.
const nodeCrypto = require('node:crypto');
const db = require('../db');
const { sha256 } = require('../crypto');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ALGS = { RS384: { kty: 'RSA', hash: 'sha384' }, ES384: { kty: 'EC', crv: 'P-384', hash: 'sha384' } };
const MAX_LIFETIME_S = 300;   // exp may be at most five minutes ahead (SMART Backend Services)
const CLOCK_SKEW_S = 60;      // tolerance for the two clocks disagreeing
const MAX_KEYS = 10;
const MAX_ASSERTION_BYTES = 8 * 1024;
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_REFETCH_MS = 60_000;
const JWKS_MAX_BYTES = 64 * 1024;
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

class JwtError extends Error { constructor(message) { super(message); this.jwt = true; } }

/**
 * Validate a JWK Set (object, JSON text, or a single JWK) and return it reduced to the public members SUDS
 * needs. Throws JwtError with a message fit for the administrator.
 */
function parseJwks(input) {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { throw new JwtError('The key set is not valid JSON'); } }
  if (!v || typeof v !== 'object') throw new JwtError('The key set must be a JSON Web Key Set ({"keys": [...]})');
  const list = Array.isArray(v.keys) ? v.keys : v.kty ? [v] : null;
  if (!list || !list.length) throw new JwtError('The key set has no keys');
  if (list.length > MAX_KEYS) throw new JwtError(`At most ${MAX_KEYS} keys may be registered`);
  const keys = [];
  for (const [i, k] of list.entries()) {
    const n = `Key ${i + 1}${k && k.kid ? ` ("${String(k.kid).slice(0, 40)}")` : ''}`;
    if (!k || typeof k !== 'object') throw new JwtError(`${n} is not a JSON Web Key`);
    if (PRIVATE_MEMBERS.some(m => m in k)) throw new JwtError(`${n} contains private key material. Register only the public key; the private key never leaves the other system.`);
    if (k.use !== undefined && k.use !== 'sig') throw new JwtError(`${n} is not a signing key (use must be "sig")`);
    if (k.key_ops !== undefined && !(Array.isArray(k.key_ops) && k.key_ops.includes('verify'))) throw new JwtError(`${n} does not allow "verify"`);
    if (k.alg !== undefined && !ALGS[k.alg]) throw new JwtError(`${n} is for ${String(k.alg).slice(0, 20)}; SUDS accepts RS384 or ES384`);
    let pub;
    if (k.kty === 'RSA') pub = { kty: 'RSA', n: String(k.n || ''), e: String(k.e || '') };
    else if (k.kty === 'EC' && k.crv === 'P-384') pub = { kty: 'EC', crv: 'P-384', x: String(k.x || ''), y: String(k.y || '') };
    else throw new JwtError(`${n} must be an RSA key (RS384) or an EC P-384 key (ES384)`);
    if (k.alg && ALGS[k.alg].kty !== pub.kty) throw new JwtError(`${n}: alg ${k.alg} does not match key type ${pub.kty}`);
    let obj;
    try { obj = nodeCrypto.createPublicKey({ key: pub, format: 'jwk' }); } catch { throw new JwtError(`${n} is not a valid public key`); }
    if (pub.kty === 'RSA' && (obj.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new JwtError(`${n} is shorter than 2048 bits`);
    if (k.kid !== undefined) pub.kid = String(k.kid).slice(0, 200);
    if (k.alg !== undefined) pub.alg = k.alg;
    keys.push(pub);
  }
  return { keys };
}

/** An https JWKS URL on the public internet (the SSRF guard's first check; each fetch checks it again). */
function checkJwksUrl(u) {
  const { assertPublicHttps } = require('../region-pictures');
  try { return assertPublicHttps(String(u || '').trim()); } catch (e) { throw new JwtError(`The key set URL is not allowed: ${e.message}`); }
}

const jwksCache = new Map(); // url -> { keys, at, tried }
async function fetchJwks(url, { force = false } = {}) {
  const hit = jwksCache.get(url);
  const now = Date.now();
  if (hit && !force && now - hit.at < JWKS_TTL_MS) return hit.keys;
  if (hit && force && now - hit.tried < JWKS_REFETCH_MS) return hit.keys;
  if (hit) hit.tried = now;
  const { get } = require('../region-pictures');
  let set;
  try { set = parseJwks((await get(url, { timeoutMs: 8000, maxBytes: JWKS_MAX_BYTES })).toString('utf8')); }
  catch (e) {
    if (hit) return hit.keys; // keep using the last good set if the host is briefly down
    throw new JwtError(`The client's key set could not be fetched: ${e.message}`);
  }
  if (jwksCache.size > 200) jwksCache.clear();
  jwksCache.set(url, { keys: set.keys, at: now, tried: now });
  return set.keys;
}

const b64json = (part, what) => {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new JwtError(`The assertion's ${what} is not base64url`);
  try { const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v; }
  catch { throw new JwtError(`The assertion's ${what} is not a JSON object`); }
};

/** Split and decode a compact JWS without trusting anything in it yet. */
function decode(assertion) {
  const s = String(assertion || '');
  if (!s || s.length > MAX_ASSERTION_BYTES) throw new JwtError('The client assertion is missing or too long');
  const parts = s.split('.');
  if (parts.length !== 3) throw new JwtError('The client assertion is not a signed JWT (header.payload.signature)');
  const header = b64json(parts[0], 'header');
  const claims = b64json(parts[1], 'payload');
  if (!/^[A-Za-z0-9_-]*$/.test(parts[2])) throw new JwtError('The assertion\'s signature is not base64url');
  return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
}

function verifySignature({ header, signingInput, signature }, keys) {
  const alg = ALGS[header.alg];
  if (!alg) throw new JwtError(`alg ${String(header.alg).slice(0, 20)} is not accepted (RS384 or ES384)`);
  if (header.crit !== undefined) throw new JwtError('The assertion has critical header parameters SUDS does not understand');
  if (header.jku !== undefined || header.x5u !== undefined || header.jwk !== undefined) throw new JwtError('Keys named inside the assertion (jku, x5u, jwk) are not used; register the key set with SUDS');
  const fits = keys.filter(k => k.kty === alg.kty && (!alg.crv || k.crv === alg.crv) && (!k.alg || k.alg === header.alg));
  let candidates;
  if (header.kid !== undefined) candidates = fits.filter(k => k.kid === String(header.kid));
  else candidates = fits.length === 1 ? fits : [];
  if (!candidates.length) return false;
  for (const k of candidates) {
    const key = nodeCrypto.createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e, crv: k.crv, x: k.x, y: k.y }, format: 'jwk' });
    const ok = alg.kty === 'EC'
      ? nodeCrypto.verify(alg.hash, Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, signature)
      : nodeCrypto.verify(alg.hash, Buffer.from(signingInput), { key, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, signature);
    if (ok) return true;
  }
  throw new JwtError('The assertion\'s signature does not verify with the registered key');
}

/** Check the claims SMART Backend Services requires. Returns the exp (seconds). */
function checkClaims(claims, { clientId, tokenUrl, now = Date.now() }) {
  const t = Math.floor(now / 1000);
  if (claims.iss !== clientId || claims.sub !== clientId) throw new JwtError('iss and sub must both be the client_id');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(tokenUrl)) throw new JwtError(`aud must be the token URL, ${tokenUrl}`);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new JwtError('exp is required');
  if (claims.exp <= t - CLOCK_SKEW_S) throw new JwtError('The assertion has expired');
  if (claims.exp > t + MAX_LIFETIME_S + CLOCK_SKEW_S) throw new JwtError('exp must be no more than five minutes in the future');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > t + CLOCK_SKEW_S)) throw new JwtError('The assertion is not valid yet (nbf)');
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > t + CLOCK_SKEW_S)) throw new JwtError('iat is in the future');
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256) throw new JwtError('jti is required (a unique id for this assertion)');
  return claims.exp;
}

/** Remember a jti until its assertion expires; false when it was already used (a replay). */
function claimJti(keyId, jti, exp) {
  const nowIso = new Date().toISOString();
  db.run(`DELETE FROM fhir_jwt_assertions WHERE expires_at < ?`, nowIso);
  // Kept a little past exp so the skew allowance above cannot outlive the record of it.
  const until = new Date((exp + CLOCK_SKEW_S) * 1000).toISOString();
  const r = db.run(`INSERT OR IGNORE INTO fhir_jwt_assertions(api_key_id, jti_hash, expires_at) VALUES(?,?,?)`, keyId, sha256(`${keyId}\n${jti}`), until);
  return r.changes === 1;
}

/**
 * Validate a client assertion for one registered client. `reg` is its registration (jwks and/or jwks_url).
 * Resolves on success; throws JwtError (the reason, for the audit trail) otherwise.
 */
async function verifyClientAssertion(assertion, { keyId, reg, tokenUrl }) {
  const parsed = decode(assertion);
  if (parsed.header.typ !== undefined && !/^(JWT|jwt|application\/jwt)$/.test(String(parsed.header.typ))) throw new JwtError('typ must be JWT');
  checkClaims(parsed.claims, { clientId: keyId, tokenUrl });
  let keys = reg.jwks?.keys || [];
  let verified = keys.length ? verifySignature(parsed, keys) : false;
  if (!verified && reg.jwks_url) {
    keys = await fetchJwks(reg.jwks_url);
    verified = verifySignature(parsed, keys);
    if (!verified) verified = verifySignature(parsed, await fetchJwks(reg.jwks_url, { force: true })); // the client may have rotated
  }
  if (!verified) throw new JwtError('No registered key matches the assertion (check kid and alg)');
  if (!claimJti(keyId, parsed.claims.jti, parsed.claims.exp)) throw new JwtError('This assertion (jti) has already been used');
  return parsed.claims;
}

/** The client_id an assertion claims to be from (iss), read before anything is verified. Throws JwtError. */
function unverifiedIssuer(assertion) {
  const { claims } = decode(assertion);
  if (typeof claims.iss !== 'string' || !claims.iss) throw new JwtError('iss is required');
  return claims.iss;
}

module.exports = { ASSERTION_TYPE, ALGS, MAX_LIFETIME_S, JwtError, parseJwks, checkJwksUrl, fetchJwks, verifyClientAssertion, unverifiedIssuer, _jwksCache: jwksCache };
