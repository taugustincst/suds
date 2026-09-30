'use strict';
// A software WebAuthn authenticator for the tests (docs/FINGERPRINT.md): it does what Touch ID, Windows Hello or an
// Android phone does once the finger has matched: makes a key pair for the site, answers registration with an
// attestation object in format "none", and signs assertions over authenticatorData || SHA-256(clientDataJSON). Every
// part can be bent (origin, RP ID, the UP and UV flags, the counter, the challenge, the signature) to test that the
// server refuses what a real browser or a tampered one might send. ES256, EdDSA and RS256.
const crypto = require('node:crypto');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---- a CBOR encoder, the subset WebAuthn uses ----
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)));
  if (v === true) return Buffer.from([0xf5]); if (v === false) return Buffer.from([0xf4]);
  return Buffer.from([0xf6]);
}

const ALGS = { ES256: -7, EdDSA: -8, RS256: -257 };

class SoftAuthenticator {
  /**
   * `origin`: the page the browser would report (the test server's address). `rpId`: defaults to its host name.
   * `uv`/`up`: whether the fingerprint (user verification) and presence flags are set. `counter`: the starting
   * signature counter; `step`: how much each use adds (0 = a device that does not count, as many passkeys do).
   */
  // `coseAlg`: the algorithm number the key is reported with (-19 for an Ed25519 key named "fully specified").
  constructor({ alg = 'ES256', coseAlg, origin, rpId, uv = true, up = true, counter = 0, step = 1, aaguid = Buffer.alloc(16, 0xab) } = {}) {
    this.alg = alg; this.coseAlg = coseAlg; this.origin = origin; this.rpId = rpId || (origin ? new URL(origin).hostname : 'localhost');
    this.uv = uv; this.up = up; this.counter = counter; this.step = step; this.aaguid = aaguid;
    this.credentialId = crypto.randomBytes(32);
    if (alg === 'ES256') this.keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    else if (alg === 'EdDSA') this.keys = crypto.generateKeyPairSync('ed25519');
    else if (alg === 'RS256') this.keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    else throw new Error('unknown alg ' + alg);
    this.userHandle = null;
  }
  get id() { return b64url(this.credentialId); }
  coseKey() {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    if (this.alg === 'ES256') return new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]);
    if (this.alg === 'EdDSA') return new Map([[1, 1], [3, this.coseAlg || -8], [-1, 6], [-2, fromB64url(jwk.x)]]);
    return new Map([[1, 3], [3, -257], [-1, fromB64url(jwk.n)], [-2, fromB64url(jwk.e)]]);
  }
  flags({ at = false, uv = this.uv, up = this.up, be = false, bs = false } = {}) { return (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (be ? 0x08 : 0) | (bs ? 0x10 : 0) | (at ? 0x40 : 0); }
  authData({ rpId = this.rpId, flags, counter, attested = false }) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter >>> 0);
    const parts = [sha256(Buffer.from(rpId, 'utf8')), Buffer.from([flags]), c];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length); parts.push(this.aaguid, len, this.credentialId, cbor(this.coseKey())); }
    return Buffer.concat(parts);
  }
  clientData({ type, challenge, origin = this.origin, crossOrigin, topOrigin }) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, ...(crossOrigin !== undefined ? { crossOrigin } : {}), ...(topOrigin !== undefined ? { topOrigin } : {}) }), 'utf8');
  }
  sign(data) {
    if (this.alg === 'ES256') return crypto.sign('sha256', data, { key: this.keys.privateKey, dsaEncoding: 'der' });
    if (this.alg === 'RS256') return crypto.sign('sha256', data, this.keys.privateKey);
    return crypto.sign(null, data, this.keys.privateKey);
  }
  /** navigator.credentials.create(), answered: `options` is the server's publicKey (JSON), `o` bends the answer. */
  create(options, o = {}) {
    if (options && options.user) this.userHandle = options.user.id;
    const clientDataJSON = this.clientData({ type: o.type || 'webauthn.create', challenge: o.challenge || options.challenge, origin: o.origin || this.origin, crossOrigin: o.crossOrigin, topOrigin: o.topOrigin });
    const ad = this.authData({ rpId: o.rpId || this.rpId, flags: this.flags({ at: true, uv: o.uv ?? this.uv, up: o.up ?? this.up, be: o.be, bs: o.bs }), counter: this.counter, attested: true });
    const attestationObject = cbor(new Map([['fmt', o.fmt || 'none'], ['attStmt', new Map()], ['authData', ad]]));
    return { id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] } };
  }
  /** navigator.credentials.get(), answered. */
  get(options, o = {}) {
    this.counter += o.counterStep ?? this.step;
    const counter = o.counter ?? this.counter;
    const clientDataJSON = this.clientData({ type: o.type || 'webauthn.get', challenge: o.challenge || options.challenge, origin: o.origin || this.origin, crossOrigin: o.crossOrigin, topOrigin: o.topOrigin });
    // `at`: a (wrong) assertion that carries attested credential data, as only a registration may.
    const ad = this.authData({ rpId: o.rpId || this.rpId, flags: this.flags({ uv: o.uv ?? this.uv, up: o.up ?? this.up, be: o.be, bs: o.bs, at: o.at }), counter, attested: !!o.at });
    let signature = this.sign(Buffer.concat([ad, sha256(clientDataJSON)]));
    if (o.badSignature) { signature = Buffer.from(signature); signature[signature.length - 1] ^= 0x01; }
    return { id: this.id, rawId: this.id, type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(ad), signature: b64url(signature), ...(this.userHandle && !o.noUserHandle ? { userHandle: o.userHandle || this.userHandle } : {}) } };
  }
}

module.exports = { SoftAuthenticator, cbor, b64url, fromB64url, ALGS };
