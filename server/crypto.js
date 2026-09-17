'use strict';
// Cryptographic primitives: PHI field encryption (AES-256-GCM), blind-index hashing,
// password hashing (scrypt), tokens, and TOTP (RFC 6238) for MFA.
const crypto = require('node:crypto');
const config = require('./config');

const VERSION = 'v1';

function encrypt(plain, key = config.encryptionKey) {
  if (plain === null || plain === undefined) return null;
  const text = String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload, key = config.encryptionKey) {
  if (payload === null || payload === undefined || payload === '') return payload ?? null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognized ciphertext format');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Deterministic blind index for equality/prefix-free search on encrypted fields.
function blindIndex(value, key = config.indexKey) {
  if (value === null || value === undefined) return null;
  const norm = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  return crypto.createHmac('sha256', key).update(norm).digest('hex');
}

// Password hashing with scrypt (N=2^15, r=8, p=1) and per-user salt.
// Deliberately expensive: about 90ms per call. That cost is paid on the event loop by the synchronous
// variants, so anything in a request path uses the async ones below and lets other requests run meanwhile.
// The sync versions remain for CLI scripts and first-run bootstrap, where nothing else is waiting.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (password, salt, keylen, opts) => new Promise((resolve, reject) => {
  // The browser kernel's shim has no callback form; fall back to the synchronous one there.
  if (typeof crypto.scrypt !== 'function') { try { resolve(crypto.scryptSync(password, salt, keylen, opts)); } catch (e) { reject(e); } return; }
  crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
});
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
/** Parse a stored hash into the parameters needed to recompute it. Returns null if it is not one of ours. */
function parseHash(stored) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return null;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    return { salt: Buffer.from(saltB64, 'base64'), expected, opts: { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, keylen: expected.length };
  } catch { return null; }
}

/** Hash a password without blocking the event loop. Use this anywhere a request is waiting. */
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

/** Verify a password without blocking the event loop. Constant-time comparison, same as the sync form. */
async function verifyPasswordAsync(password, stored) {
  const p = parseHash(stored);
  if (!p) return false;
  try {
    const actual = Buffer.from(await scryptAsync(String(password), p.salt, p.keylen, p.opts));
    return actual.length === p.expected.length && crypto.timingSafeEqual(actual, p.expected);
  } catch { return false; }
}

function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function uuid() { return crypto.randomUUID(); }

// ---- TOTP (RFC 6238 / RFC 4226) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function generateTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
function totp(secretB32, time = Date.now(), step = 30) { return hotp(secretB32, Math.floor(time / 1000 / step)); }
function verifyTotp(secretB32, code, window = 1, time = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const counter = Math.floor(time / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretB32, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}
function otpauthUrl(secret, account, issuer = 'SUDS') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { encrypt, decrypt, blindIndex, hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync, randomToken, sha256, uuid,
  generateTotpSecret, totp, verifyTotp, otpauthUrl, base32Encode, base32Decode };
