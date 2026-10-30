'use strict';
// Cryptographic primitives: PHI field encryption (AES-256-GCM), blind-index hashing,
// password hashing (scrypt), tokens, and TOTP (RFC 6238) for MFA.
const crypto = require('node:crypto');
const config = require('./config');

const VERSION = 'v1';

// AES-256-GCM. `aad` (independent evaluation, item 2) binds the ciphertext to where it lives — its
// table|column|id, via aadFor() — so a value moved to another row or column no longer decrypts there, only in
// its own place. A v1 payload carried no AAD and still decrypts with none; a v2 payload must be given the same
// AAD it was sealed with, or GCM's tag check fails. A column moves to v2 only when its write and every read
// pass the matching AAD together (a v2 payload read with the wrong or no AAD throws, which is the point).
function encrypt(plain, key = config.encryptionKey, aad = null) {
  if (plain === null || plain === undefined) return null;
  const text = String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad !== null && aad !== undefined) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const version = aad !== null && aad !== undefined ? 'v2' : VERSION;
  return `${version}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload, key = config.encryptionKey, aad = null) {
  if (payload === null || payload === undefined || payload === '') return payload ?? null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || (parts[0] !== VERSION && parts[0] !== 'v2')) throw new Error('Unrecognized ciphertext format');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  // A v2 payload was sealed with an AAD and will not open without the same one. A v1 payload never had one.
  if (parts[0] === 'v2') {
    if (aad === null || aad === undefined) throw new Error('this field is bound to its row and column and needs that binding to decrypt');
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** The binding for a PHI column: its table, column and row id, so its ciphertext decrypts only in that cell. */
function aadFor(table, column, id) { return `suds-phi/${table}/${column}/${id}`; }

// Columns whose ciphertext is bound to its cell (independent evaluation, item 2). A column is listed only once
// every path that encrypts or decrypts it passes boundAad() and a migration has re-sealed the stored values as
// v2; until then boundAad returns null and the column stays v1. The client record's PHI is the first set bound
// (migration 76). Every writer and reader of these columns — the REST create/update (clients-model
// encryptFields/decryptRow), sync transport (sync-tables exportRow/importRow), the FHIR Patient view, exports,
// CalOMS and the merge re-seal — goes through boundAad, so the binding is consistent.
const AAD_BOUND = {
  clients: new Set(['first_name_enc', 'last_name_enc', 'preferred_name_enc', 'dob_enc', 'phone_enc', 'alt_phone_enc',
    'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc', 'goals_enc', 'flags_enc', 'contact_preferences_enc']),
};
/** The AAD for a PHI cell when its column is bound and the row id is known, else null (an unbound column stays v1). */
function boundAad(table, column, id) { return id && AAD_BOUND[table] && AAD_BOUND[table].has(column) ? aadFor(table, column, id) : null; }
/** Move a bound value between cells (a merge, or the v1→v2 migration): decrypt under the source binding, re-seal under the target's. */
function reseal(ct, table, column, fromId, toId) {
  if (ct === null || ct === undefined) return ct;
  return encrypt(decrypt(ct, config.encryptionKey, boundAad(table, column, fromId)), config.encryptionKey, boundAad(table, column, toId));
}

// Letters that Unicode does not decompose into a base letter plus an accent, so NFKD alone leaves them as
// they are: "Øster" has to find "Oster" and "Łecki" has to find "Lecki", the way a worker types them.
const TRANSLIT = { 'ø': 'o', 'ł': 'l', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŀ': 'l', 'ŧ': 't', 'ĸ': 'k', 'ŋ': 'ng', 'ſ': 's', 'ƒ': 'f', 'ǥ': 'g', 'ɨ': 'i', 'ʉ': 'u' };
const TRANSLIT_RE = new RegExp(`[${Object.keys(TRANSLIT).join('')}]`, 'g');
// The accents and vowel points that are dropped: Latin/Greek/Cyrillic combining diacritics, Hebrew points,
// Arabic harakat (and the tatweel used to stretch a word). Only these ranges — a Devanagari vowel sign or
// a kana voicing mark is part of the letter, not an accent, and removing it would merge different names.
const DIACRITICS_RE = /[\u0300-\u036f\u0591-\u05c7\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06ed\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
/**
 * The one normalisation every blind index and name index is computed from, so a name matches however it
 * was typed: compatibility-decomposed (NFKD: full-width and ligature forms become plain letters), accents
 * removed, lower-cased, the letters above transliterated, then recomposed (NFC, so Hangul and kana come
 * back whole) and reduced to Unicode letters, marks and digits. "José" → "jose", "Øster" → "oster",
 * "حَسَن" → "حسن", "Иван" → "иван". Before 1.9.5 anything outside a-z was thrown away, so an Arabic or
 * Cyrillic name indexed as nothing and could not be searched for or matched as a duplicate.
 */
function foldText(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKD').replace(DIACRITICS_RE, '').toLowerCase()
    .replace(TRANSLIT_RE, (c) => TRANSLIT[c]).normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

// A purpose-separated key derived from the index key (HKDF-SHA256, RFC 5869): a MAC made for one purpose is
// then never a valid MAC for another. For every use of the index key added from 1.13.0 on (the OIDC state
// cookie first). The blind indexes, the audit chain and the anchors keep the index key itself, because
// changing their key would change every stored index and break verification of every existing audit entry
// (docs/security/ENCRYPTION-AND-KEYS.md). Rotating the index key rotates every subkey with it.
// Not cached: it costs microseconds, and a cache would outlive a rotated key.
function subkey(purpose, key = config.indexKey) {
  if (!purpose || typeof purpose !== 'string') throw new Error('subkey: a purpose is required');
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from('suds-subkey-v1'), Buffer.from(`suds/${purpose}`), 32));
}

// A short keyed fingerprint of one field's exact value, under its own label: a device keeps these for each row as
// last exchanged with the office, to tell which fields changed on which side (local/sync.js keepBase). Not a search
// index (no folding: a change of case is a change), and never the value itself.
function fieldPrint(label, value, key = config.indexKey) {
  return crypto.createHmac('sha256', key).update(`suds/field-print\u0000${label}\u0000${String(value ?? '')}`).digest('hex').slice(0, 12);
}

// Deterministic blind index for equality/prefix-free search on encrypted fields.
// `purpose` domain-separates columns: with it, the HMAC is keyed with a per-purpose subkey (HKDF of the index
// key), so the same value in two columns no longer produces the same index (independent evaluation, item 4).
// Without one, the index key is used directly — the prefixed name/phonetic indexes rely on that, separating
// themselves by a value prefix instead. A caller passing a purpose for a column must pass the identical one
// on every write and every search, or that column stops matching; the reindex in db.js migration 75 and key
// rotation both go through clients-model, so they stay in step.
function blindIndex(value, purpose) {
  if (value === null || value === undefined) return null;
  const norm = foldText(value);
  if (!norm) return null;
  // A string `purpose` domain-separates the column with a per-purpose key derived from the index key by a
  // labelled HMAC (not hkdfSync — the browser kernel's crypto shim has no HKDF, and HMAC gives the same
  // domain separation and runs in both). A Buffer is an explicit key — the per-install separation and
  // brute-force properties in docs/security/ENCRYPTION-AND-KEYS.md are shown that way, and key rotation swaps
  // config.indexKey, which the per-purpose key is derived from. Default: the index key itself.
  const key = Buffer.isBuffer(purpose) ? purpose
    : purpose ? crypto.createHmac('sha256', config.indexKey).update('suds/blind-index-subkey/' + purpose).digest()
      : config.indexKey;
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
/** The time-step (RFC 6238 counter) `code` matches within ±window steps of `time`, or null. */
function totpStep(secretB32, code, window = 1, time = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const counter = Math.floor(time / 1000 / 30);
  let found = null;
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretB32, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c)) && found === null) found = counter + i;
  }
  return found;
}
function verifyTotp(secretB32, code, window = 1, time = Date.now()) { return totpStep(secretB32, code, window, time) !== null; }
// The enrolment QR code (public/qr.js) holds at most OTPAUTH_MAX bytes; the issuer (the programme's name) appears twice,
// so a long name is shortened, from the end, until the link fits. Authenticator apps show only the start of it anyway.
const OTPAUTH_MAX = 200;
function otpauthUrl(secret, account, issuer = 'SUDS') {
  const url = (iss, acct) => `otpauth://totp/${encodeURIComponent(iss)}:${encodeURIComponent(acct)}?secret=${secret}&issuer=${encodeURIComponent(iss)}&algorithm=SHA1&digits=6&period=30`;
  let iss = String(issuer || 'SUDS'); let acct = String(account);
  while (Buffer.byteLength(url(iss, acct)) > OTPAUTH_MAX && [...iss].length > 8) iss = [...iss].slice(0, -1).join('').trimEnd();
  // Eight characters of a name in a non-Latin script are still 72 bytes each time they appear: the product's name then.
  if (Buffer.byteLength(url(iss, acct)) > OTPAUTH_MAX) iss = 'SUDS';
  while (Buffer.byteLength(url(iss, acct)) > OTPAUTH_MAX && [...acct].length > 8) acct = [...acct].slice(0, -1).join('');
  return url(iss, acct);
}

/**
 * A short, non-reversible fingerprint of the PHI key in use. Stored alongside the data so a device can tell
 * that its key has been replaced (browser storage cleared) before it writes anything under the new one.
 */
function keyFingerprint() { return sha256('suds-key-check:' + config.encryptionKey.toString('hex')).slice(0, 32); }

module.exports = { encrypt, decrypt, aadFor, boundAad, reseal, blindIndex, fieldPrint, subkey, foldText, keyFingerprint, hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync, randomToken, sha256, uuid,
  generateTotpSecret, totp, totpStep, verifyTotp, otpauthUrl, base32Encode, base32Decode };
