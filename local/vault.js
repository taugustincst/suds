// Encryption at rest for the on-device database (docs/architecture/ADR-0008-device-encryption.md).
//
// Everything SUDS keeps about clients on a device lives in one SQLite image in IndexedDB. That image is
// sealed with AES-256-GCM under a random data-encryption key (the DEK). The DEK is never stored as it is:
// for each device account it is wrapped (AES-256-GCM again) under a key-encryption key derived from that
// account's password with PBKDF2-SHA-256, and only those wraps are stored — in IndexedDB beside the sealed
// image, in one record called the vault. The `_enc` column keys (encryption and blind index) are sealed
// under the DEK inside the vault as well, so nothing in localStorage or IndexedDB can read a record
// without an account password.
//
//   vault  { format, version, salt, kdf, iterations,
//            wraps: [{ user_id, name, salt, iv, ct }],   name = SHA-256(salt | lower-cased username), so the
//                                                       right wrap is found without trying every one
//            keys:  { iv, ct },                          AES-GCM(DEK, {"enc":hex,"idx":hex})
//            hints: { users, signup_enabled, program_contact },   what the locked sign-in page may show
//            chain: { iv, ct },                          after a restore only: see backupRecord
//            rekey: 'restore',                           after a restore only, until rekeyAfterRestore
//            dropped_after_restore: [name] }             the wraps that rotation dropped (lookup names, as in
//                                                       wraps), until each account is let in again
//   image  { format, version, iv, ct }                   AES-GCM(DEK, SQLite bytes)
//
// Every function here is WebCrypto (crypto.subtle), so it runs the same in a browser and under Node's
// globalThis.crypto (test/device-vault.test.js). The one synchronous path, sealing on the way out of a page
// (sealSync), is handed a GCM implementation by its caller, because WebCrypto has no synchronous API.
export const VAULT_FORMAT = 'suds-device-vault';
export const IMAGE_FORMAT = 'suds-sealed-db';
export const VERSION = 1;
// OWASP's current figure for PBKDF2-HMAC-SHA256. WebCrypto offers no memory-hard KDF (no scrypt or Argon2),
// so this is the strongest KDF available to a web page without shipping one.
export const ITERATIONS = 600000;
const MIN_ITERATIONS = 310000;
const MAX_ITERATIONS = 5000000; // a vault claiming more would only be a way to hang the sign-in page
const AAD_IMAGE = 'suds-device-db/v1';
const AAD_KEYS = 'suds-device-keys/v1';
const AAD_WRAP = 'suds-device-dek-wrap/v1';
const AAD_CHAIN = 'suds-device-dek-chain/v1';
const BACKUP_FORMAT = 'suds-device-vault-backup';

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const hex = (u8) => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
const b64 = (x) => { const a = u8(x); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(String(s)), c => c.charCodeAt(0));

export class VaultError extends Error { constructor(message, code) { super(message); this.code = code; } }

/** A fresh 256-bit data-encryption key, as raw bytes (the caller zeroes it when it locks). */
export function newDek() { return rand(32); }
/** The DEK as a non-extractable WebCrypto key, for sealing and opening. */
export function importDek(raw) { return subtle().importKey('raw', u8(raw), 'AES-GCM', false, ['encrypt', 'decrypt']); }

/** True for an IndexedDB value that is a sealed database image. */
export function isSealed(v) { return !!v && typeof v === 'object' && v.format === IMAGE_FORMAT && v.iv instanceof Uint8Array && v.ct instanceof Uint8Array; }
/** True for bytes that begin with SQLite's file header: a database stored in the clear (1.11 and earlier). */
export function isPlainSqlite(v) {
  if (!v || isSealed(v)) return false;
  const b = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
  return !!b && b.length >= 15 && td.decode(b.subarray(0, 15)) === 'SQLite format 3';
}
/** A vault this build can use, with at least one account that can unlock it. */
export function hasAccounts(v) { return !!v && v.format === VAULT_FORMAT && Array.isArray(v.wraps) && v.wraps.length > 0; }

/** Seal a database image (async, WebCrypto). */
export async function seal(dekKey, bytes, aad = AAD_IMAGE) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, dekKey, u8(bytes)));
  return { format: IMAGE_FORMAT, version: VERSION, iv, ct };
}
/**
 * Seal synchronously with a GCM implementation the caller supplies (`gcm(key, iv, aad).encrypt(bytes)`,
 * @noble/ciphers' signature). Used only on the way out of a page, where nothing asynchronous can be waited
 * for; the output is the same format and opens with open().
 */
export function sealSync(gcm, dekRaw, bytes, aad = AAD_IMAGE) {
  const iv = rand(12);
  const ct = gcm(u8(dekRaw), iv, te.encode(aad)).encrypt(u8(bytes));
  return { format: IMAGE_FORMAT, version: VERSION, iv, ct: u8(ct) };
}
/** Open a sealed image. Throws VaultError('tampered') if it was altered or sealed under another key. */
export async function open(dekKey, sealed, aad = AAD_IMAGE) {
  if (!isSealed(sealed)) throw new VaultError('The on-device database is not in a format this version can read.', 'format');
  try { return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: te.encode(aad) }, dekKey, sealed.ct)); }
  catch { throw new VaultError('The on-device database could not be decrypted: it has been altered, or belongs to another set of keys.', 'tampered'); }
}

/** The lookup name of an account's wrap: not the username itself, which the vault never stores. */
export async function nameHash(vaultSalt, username) {
  const data = te.encode(`suds-device-account|${hex(u8(vaultSalt))}|${String(username || '').trim().toLowerCase()}`);
  return hex(new Uint8Array(await subtle().digest('SHA-256', data)));
}

async function deriveKek(password, salt, iterations) {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new VaultError('The device vault is damaged.', 'tampered');
  const base = await subtle().importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: u8(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Wrap the DEK under a key derived from `password`: one entry of vault.wraps. Salt is per wrap. */
export async function wrapDek(dekRaw, password, { userId, name, iterations = ITERATIONS }) {
  const salt = rand(16); const iv = rand(12);
  const kek = await deriveKek(password, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(AAD_WRAP) }, kek, u8(dekRaw)));
  return { user_id: userId, name, kdf: 'PBKDF2-SHA256', iterations, salt, iv, ct, created_at: new Date().toISOString() };
}
/** The DEK from one wrap, or null when the password is not the one it was wrapped with. */
export async function unwrapDek(wrap, password) {
  if (!wrap || wrap.kdf !== 'PBKDF2-SHA256') return null;
  const kek = await deriveKek(password, wrap.salt, wrap.iterations);
  try { return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: wrap.iv, additionalData: te.encode(AAD_WRAP) }, kek, wrap.ct)); }
  catch { return null; }
}
/**
 * What a device backup carries so that the accounts in it can unlock the device it is restored onto with
 * the passwords they had when it was made: their wraps (each opens this device's DEK only with that
 * account's password), a fresh key for the restored device (`next_dek`) and that key sealed under this
 * device's DEK (`chain`). So the backup never holds this device's own DEK; a restored device's accounts go
 * wrap → this DEK → chain → the new DEK, and each is re-wrapped directly at its first sign-in.
 * Everything is base64/hex so it travels in the backup's JSON metadata (local/backup.js).
 */
export async function backupRecord(vault, dekKey, nextDek) {
  const chain = await seal(dekKey, nextDek, AAD_CHAIN);
  const w64 = (w) => ({ user_id: w.user_id, name: w.name, kdf: w.kdf, iterations: w.iterations, salt: b64(w.salt), iv: b64(w.iv), ct: b64(w.ct) });
  // A wrap that is itself chained (this device was restored and that account has not signed in since)
  // cannot be carried: its chain belongs to the backup this device came from, not to this device's DEK.
  return { format: BACKUP_FORMAT, version: VERSION, salt: b64(vault.salt), wraps: vault.wraps.filter(w => !w.chained).map(w64), chain: { iv: b64(chain.iv), ct: b64(chain.ct) }, next_dek: hex(u8(nextDek)) };
}
/** The restored device's DEK and vault from a backup's record (see backupRecord), or null if it has none. */
export async function fromBackupRecord(rec, keys, hints = {}) {
  if (!rec || rec.format !== BACKUP_FORMAT || !/^[0-9a-f]{64}$/.test(rec.next_dek || '') || !Array.isArray(rec.wraps) || !rec.chain) return null;
  const dek = Uint8Array.from(rec.next_dek.match(/../g).map(x => parseInt(x, 16)));
  const key = await importDek(dek);
  const v = await create(key, keys, hints);
  v.salt = unb64(rec.salt);
  v.chain = { iv: unb64(rec.chain.iv), ct: unb64(rec.chain.ct) };
  v.wraps = rec.wraps.map(w => ({ user_id: w.user_id, name: w.name, kdf: w.kdf, iterations: w.iterations, salt: unb64(w.salt), iv: unb64(w.iv), ct: unb64(w.ct), chained: true }));
  // This key is written in the backup (next_dek): anyone with the file and its passphrase has it. The first
  // sign-in by one of the backed-up accounts moves the device to a key the backup never held (rekeyAfterRestore).
  v.rekey = 'restore';
  return { dek, key, vault: v };
}

/**
 * The key rotation after a restore (docs/architecture/ADR-0008-device-encryption.md, "Backups and restore").
 * A restored device starts under the key its backup carried (`next_dek`), so whoever holds the backup and its
 * passphrase, and later gets the device's browser storage, could read everything recorded after the restore.
 * At the first sign-in by an account whose carried wrap opens with its password, this makes a fresh key and
 * returns the vault for it:
 *   - the column keys sealed under the new key;
 *   - that account's own wrap of the new key;
 *   - the other carried wraps kept as they are (each opens the backed-up device's key, D0, with its account's
 *     password), and the chain re-sealed from D0 to the NEW key: D0 was never in the backup (only wraps of it,
 *     each needing a password), so the backup's holder cannot follow it, while every backed-up account still
 *     can, with the password it had, until its own first sign-in replaces its carried wrap;
 *   - any other wrap (an account enrolled on the restored device before this, which wraps the backup's key)
 *     dropped: it would open only the old key. Its account is vouched for at its next sign-in (`dropped`).
 * `currentDek` is the key the device is under now; the chain must lead to it, or nothing is rotated.
 * Resolves to { dek, key, vault, dropped } — the caller seals the image under `key` and stores it with the
 * vault in one write — or null when this account cannot rotate (no carried wrap, wrong password, not pending).
 */
export async function rekeyAfterRestore(v, currentDek, username, password, { userId, keys, hints } = {}) {
  if (!v || v.rekey !== 'restore' || !v.chain || !userId || !keys) return null;
  const name = await nameHash(v.salt, username);
  let prev = null;
  for (const w of v.wraps.filter(x => x.chained && x.name === name)) {
    const d0 = await unwrapDek(w, password);
    if (!d0) continue;
    try {
      const d1 = await open(await importDek(d0), { format: IMAGE_FORMAT, version: VERSION, iv: v.chain.iv, ct: v.chain.ct }, AAD_CHAIN);
      const same = d1.length === u8(currentDek).length && d1.every((b, i) => b === u8(currentDek)[i]);
      d1.fill(0);
      if (same) { prev = d0; break; }
    } catch { /* not this chain */ }
    d0.fill(0);
  }
  if (!prev) return null;
  const dek = newDek(); const key = await importDek(dek);
  const others = v.wraps.filter(w => w.chained && w.user_id !== userId && w.name !== name);
  const droppedWraps = v.wraps.filter(w => !w.chained && w.user_id !== userId);
  const dropped = droppedWraps.map(w => w.user_id);
  const own = await wrapDek(dek, password, { userId, name });
  const next = { ...v, keys: await sealKeys(key, keys), wraps: [...others, own], rekeyed_at: new Date().toISOString() };
  // Remembered by lookup name (a salted hash, never the username), so that account's next sign-in is told the
  // device was restored and moved to a new key, not that its password is wrong (droppedAfterRestore).
  const names = [...new Set([...(v.dropped_after_restore || []), ...droppedWraps.map(w => w.name)])];
  if (names.length) next.dropped_after_restore = names; else delete next.dropped_after_restore;
  if (hints) next.hints = hints;
  delete next.rekey;
  if (others.length) { const c = await seal(await importDek(prev), dek, AAD_CHAIN); next.chain = { iv: c.iv, ct: c.ct }; } else delete next.chain;
  prev.fill(0);
  return { dek, key, vault: next, dropped };
}

/** The wraps whose lookup name matches `username` (normally one). */
export async function wrapsFor(vault, username) {
  if (!hasAccounts(vault)) return [];
  const name = await nameHash(vault.salt, username);
  return vault.wraps.filter(w => w.name === name);
}
/** Try `password` against this username's wraps: { dek, wrap } or null. */
export async function unlock(vault, username, password) {
  for (const w of await wrapsFor(vault, username)) {
    let dek = await unwrapDek(w, password);
    if (dek && w.chained) {
      // A wrap carried over by a restore opens the backed-up device's DEK, which opens this one's (the chain).
      if (!vault.chain) continue;
      const k = await importDek(dek); dek.fill(0);
      try { dek = await open(k, { format: IMAGE_FORMAT, version: VERSION, iv: vault.chain.iv, ct: vault.chain.ct }, AAD_CHAIN); } catch { continue; }
    }
    if (dek) return { dek, wrap: w };
  }
  return null;
}

/** Seal / open the two `_enc` column keys ({ enc, idx } as hex) under the DEK. */
export async function sealKeys(dekKey, keys) { const s = await seal(dekKey, te.encode(JSON.stringify({ enc: keys.enc, idx: keys.idx })), AAD_KEYS); return { iv: s.iv, ct: s.ct }; }
export async function openKeys(dekKey, sealed) {
  const plain = await open(dekKey, { format: IMAGE_FORMAT, version: VERSION, iv: sealed.iv, ct: sealed.ct }, AAD_KEYS);
  const k = JSON.parse(td.decode(plain)); plain.fill(0);
  if (!/^[0-9a-f]{64}$/.test(k.enc || '') || !/^[0-9a-f]{64}$/.test(k.idx || '')) throw new VaultError('The device vault is damaged.', 'tampered');
  return k;
}

/** A new vault (no accounts yet) for this DEK and these column keys. */
export async function create(dekKey, keys, hints = {}) {
  return { format: VAULT_FORMAT, version: VERSION, salt: rand(16), kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, wraps: [], keys: await sealKeys(dekKey, keys), hints, created_at: new Date().toISOString() };
}
/**
 * Was this username's wrap dropped by the key rotation after a restore (rekeyAfterRestore), with no wrap of
 * its own since? Its sign-in cannot open the device, and it needs someone who can to vouch for it again.
 */
export async function droppedAfterRestore(vault, username) {
  if (!vault || !Array.isArray(vault.dropped_after_restore) || !vault.dropped_after_restore.length || !username) return false;
  if ((await wrapsFor(vault, username)).length) return false;
  return vault.dropped_after_restore.includes(await nameHash(vault.salt, username));
}

/** A copy of `vault` with `wrap` in place of any earlier wrap for the same account. */
export function withWrap(vault, wrap) {
  const next = { ...vault, wraps: vault.wraps.filter(w => w.user_id !== wrap.user_id).concat(wrap) };
  // An account dropped at the rotation after a restore has a key again: it is no longer waiting.
  if (Array.isArray(next.dropped_after_restore)) {
    const left = next.dropped_after_restore.filter(n => n !== wrap.name);
    if (left.length) next.dropped_after_restore = left; else delete next.dropped_after_restore;
  }
  if (!next.wraps.some(w => w.chained)) delete next.chain; // every restored account has its own wrap now
  return next;
}

/**
 * Does any stored value still hold a database in the clear? `entries` is [key, value] pairs from the
 * store. Used after sealing an old device's database to prove the plaintext copies are gone.
 */
export function plaintextLeft(entries) { return entries.filter(([, v]) => isPlainSqlite(v)).map(([k]) => k); }
