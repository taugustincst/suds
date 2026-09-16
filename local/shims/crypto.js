// Browser replacement for the subset of node:crypto used by the SUDS server code (pure JS, synchronous).
import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { sha1 } from '@noble/hashes/sha1';
import { hmac } from '@noble/hashes/hmac';
import { scrypt } from '@noble/hashes/scrypt';
import { randomBytes as nobleRandom } from '@noble/hashes/utils';

class B extends Uint8Array {}
export function randomBytes(n) { return Buffer.from(nobleRandom(n)); }
export function randomUUID() { return crypto.randomUUID(); }
function toU8(x, enc) { if (Buffer.isBuffer(x) || x instanceof Uint8Array) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength); return new Uint8Array(Buffer.from(String(x), enc || 'utf8')); }
function out(u8, enc) { const b = Buffer.from(u8); return enc ? b.toString(enc) : b; }
const HASHES = { sha256, sha1 };
export function createHash(alg) { const h = HASHES[alg]; if (!h) throw new Error('Unsupported hash ' + alg); const parts = []; return { update(d, e) { parts.push(toU8(d, e)); return this; }, digest(e) { const all = concat(parts); return out(h(all), e); } }; }
export function createHmac(alg, key) { const h = HASHES[alg]; if (!h) throw new Error('Unsupported hmac ' + alg); const parts = []; const k = toU8(key); return { update(d, e) { parts.push(toU8(d, e)); return this; }, digest(e) { return out(hmac(h, k, concat(parts)), e); } }; }
function concat(parts) { const n = parts.reduce((s, p) => s + p.length, 0); const r = new Uint8Array(n); let o = 0; for (const p of parts) { r.set(p, o); o += p.length; } return r; }
export function createCipheriv(alg, key, iv) {
  if (alg !== 'aes-256-gcm') throw new Error('Unsupported cipher ' + alg);
  const parts = []; let tag = null;
  return { update(d, e) { parts.push(toU8(d, e)); return Buffer.alloc(0); }, final() { const ct = gcm(toU8(key), toU8(iv)).encrypt(concat(parts)); tag = Buffer.from(ct.subarray(ct.length - 16)); return Buffer.from(ct.subarray(0, ct.length - 16)); }, getAuthTag() { return tag; } };
}
export function createDecipheriv(alg, key, iv) {
  if (alg !== 'aes-256-gcm') throw new Error('Unsupported cipher ' + alg);
  const parts = []; let tag = null;
  return { setAuthTag(t) { tag = toU8(t); }, update(d, e) { parts.push(toU8(d, e)); return Buffer.alloc(0); }, final() { const data = concat(parts); const ct = new Uint8Array(data.length + 16); ct.set(data); ct.set(tag, data.length); try { return Buffer.from(gcm(toU8(key), toU8(iv)).decrypt(ct)); } catch { throw new Error('Unsupported state or unable to authenticate data'); } } };
}
export function scryptSync(password, salt, keylen, opts = {}) { return Buffer.from(scrypt(toU8(password), toU8(salt), { N: opts.N || 16384, r: opts.r || 8, p: opts.p || 1, dkLen: keylen, maxmem: 2 ** 31 })); }
export function timingSafeEqual(a, b) { const x = toU8(a), y = toU8(b); if (x.length !== y.length) return false; let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; }
export class X509Certificate { constructor() { throw new Error('X509 not available in local mode'); } }
export function sign() { throw new Error('sign not available in local mode'); }
export function generateKeyPairSync() { throw new Error('not available in local mode'); }
export default { randomBytes, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual, X509Certificate, sign, generateKeyPairSync };
