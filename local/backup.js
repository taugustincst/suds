// Device backup file for SUDS on this device (the on-device web app, and local mode): the whole on-device
// database plus the two keys that read it, encrypted with a passphrase the person chooses. The records on
// a device exist nowhere else, so this file is the only way back from a cleared browser or a lost phone.
//
// Layout: one line of JSON (the header), a newline, then the AES-256-GCM ciphertext.
//   header  { format, version, kdf, iterations, salt, iv, check, created_at, app_version }
//   key     PBKDF2-SHA256(passphrase, salt, iterations) -> 512 bits: the first 256 are the AES key; the
//           last 256, hashed, are `check`, so a wrong passphrase is told apart from a damaged file
//   AAD     the header line itself, so nothing in it (dates, iterations, version) can be edited unseen
//   plain   u32 big-endian length | meta JSON { keys: { enc, idx }, org_name, clients, users, schema_version,
//           created_at } | the raw SQLite bytes
// Everything here is WebCrypto: the browser's own implementation, nothing vendored.
export const FORMAT = 'suds-device-backup';
export const VERSION = 1;
export const ITERATIONS = 600000; // OWASP's current figure for PBKDF2-HMAC-SHA256 (the floor we accept is 310,000)
const MIN_ITERATIONS = 310000;
const MAX_ITERATIONS = 5000000; // a file claiming more would only be a way to hang the page
export const MIN_PASSPHRASE = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(String(s)), c => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export class BackupError extends Error { constructor(message, code) { super(message); this.code = code; } }

async function derive(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const check = hex(await crypto.subtle.digest('SHA-256', bits.slice(32))).slice(0, 32);
  bits.fill(0);
  return { key, check };
}

/** Build the backup file. `bytes` is the exported SQLite database; `meta.keys` the device's two keys (hex). */
export async function create({ bytes, meta, passphrase, appVersion }) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new BackupError(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`, 'weak');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { key, check } = await derive(passphrase, salt, ITERATIONS);
  return sealFile({ bytes, meta, appVersion, key, salt, iterations: ITERATIONS, check });
}

/**
 * The key a scheduled backup is made with (1.24.0): the same PBKDF2 derivation as create(), done once when the
 * device administrator turns scheduled backups on, so a file can be written later without the passphrase being
 * typed again (or kept anywhere). Returns the raw 256-bit AES key with the salt, iterations and check it belongs
 * to; the kernel keeps the key sealed under the device key in the vault (local/vault.js sealBackupKey), never in
 * the database and never in a backup. A file made with it is an ordinary version-1 backup: open() derives the
 * same key from the passphrase and the salt in its header.
 */
export async function deriveKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new BackupError(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`, 'weak');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 512));
  const raw = bits.slice(0, 32);
  const check = hex(await crypto.subtle.digest('SHA-256', bits.slice(32))).slice(0, 32);
  bits.fill(0);
  return { raw, salt, iterations: ITERATIONS, check };
}

/** Build the backup file with a key from deriveKey(): a fresh IV every time; the salt and check are the key's. */
export async function createWithKey({ bytes, meta, derived, appVersion }) {
  if (!derived || !(derived.raw instanceof Uint8Array) || derived.raw.length !== 32 || !(derived.salt instanceof Uint8Array) || derived.salt.length < 16
    || !Number.isInteger(derived.iterations) || derived.iterations < MIN_ITERATIONS || !/^[0-9a-f]{32}$/.test(derived.check || '')) throw new BackupError('Scheduled backups need their passphrase again.', 'key');
  const key = await crypto.subtle.importKey('raw', derived.raw, 'AES-GCM', false, ['encrypt']);
  return sealFile({ bytes, meta, appVersion, key, salt: derived.salt, iterations: derived.iterations, check: derived.check });
}

async function sealFile({ bytes, meta, appVersion, key, salt, iterations, check }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = { format: FORMAT, version: VERSION, kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), check, created_at: meta.created_at, app_version: appVersion };
  const headerLine = enc.encode(JSON.stringify(header));
  const metaBytes = enc.encode(JSON.stringify(meta));
  const plain = new Uint8Array(4 + metaBytes.length + bytes.length);
  new DataView(plain.buffer).setUint32(0, metaBytes.length);
  plain.set(metaBytes, 4); plain.set(bytes, 4 + metaBytes.length);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerLine }, key, plain));
  plain.fill(0);
  const out = new Uint8Array(headerLine.length + 1 + ct.length);
  out.set(headerLine, 0); out[headerLine.length] = 0x0a; out.set(ct, headerLine.length + 1);
  return out;
}

/** Read just the header (no passphrase needed): what file this is and when it was made. */
export function readHeader(file) {
  const u8 = file instanceof Uint8Array ? file : new Uint8Array(file);
  const nl = u8.indexOf(0x0a);
  if (nl < 2 || nl > 4096) throw new BackupError('This is not a SUDS device backup file.', 'format');
  let header;
  try { header = JSON.parse(dec.decode(u8.subarray(0, nl))); } catch { throw new BackupError('This is not a SUDS device backup file.', 'format'); }
  if (!header || header.format !== FORMAT) throw new BackupError('This is not a SUDS device backup file.', 'format');
  if (header.version !== VERSION) throw new BackupError('This backup was made by a newer version of SUDS. Update SUDS on this device, then try again.', 'version');
  if (header.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(header.iterations) || header.iterations < MIN_ITERATIONS || header.iterations > MAX_ITERATIONS) throw new BackupError('This backup file is damaged or has been altered.', 'tampered');
  return { header, headerLine: u8.subarray(0, nl), ciphertext: u8.subarray(nl + 1) };
}

/** Decrypt and unpack. Throws BackupError('wrong passphrase' | 'damaged or altered' | 'not a backup'). */
export async function open(file, passphrase) {
  const { header, headerLine, ciphertext } = readHeader(file);
  let salt, iv;
  try { salt = unb64(header.salt); iv = unb64(header.iv); } catch { throw new BackupError('This backup file is damaged or has been altered.', 'tampered'); }
  if (salt.length < 16 || iv.length !== 12) throw new BackupError('This backup file is damaged or has been altered.', 'tampered');
  const { key, check } = await derive(String(passphrase || ''), salt, header.iterations);
  if (check !== header.check) throw new BackupError('That passphrase does not open this backup.', 'passphrase');
  let plain;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: headerLine }, key, ciphertext)); }
  catch { throw new BackupError('This backup file is damaged or has been altered, so it cannot be restored.', 'tampered'); }
  const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  const meta = JSON.parse(dec.decode(plain.subarray(4, 4 + n)));
  const bytes = plain.slice(4 + n);
  if (!meta || !meta.keys || !/^[0-9a-f]{64}$/.test(meta.keys.enc || '') || !/^[0-9a-f]{64}$/.test(meta.keys.idx || '')) throw new BackupError('This backup file is damaged or has been altered.', 'tampered');
  if (dec.decode(bytes.subarray(0, 15)) !== 'SQLite format 3') throw new BackupError('This backup file is damaged or has been altered.', 'tampered');
  return { header, meta, bytes };
}

// ---- the backup schedule (1.24.0) ----
// How often SUDS on this device makes a backup, in days. Weekly is the longest: it was the reminder's interval
// before schedules existed and stays the floor. A device that never chose keeps it.
export const SCHEDULES = [1, 3, 7];
export const DEFAULT_EVERY_DAYS = 7;
// How many backup files a folder keeps: older ones beyond that are removed (only files SUDS named).
export const DEFAULT_KEEP = 7;
export const MIN_KEEP = 2;
export const MAX_KEEP = 30;

const localDay = (t) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000; };
/** Whole calendar days (in this device's time zone) from `fromIso` to `now`; null when there is no date. */
export function daysSince(fromIso, now = Date.now()) {
  const t = Date.parse(fromIso || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round(localDay(now) - localDay(t)));
}
/**
 * Where a device stands against its schedule. Due once `everyDays` calendar days have begun since the last
 * backup (a daily backup made at 17:00 is due again the next morning, not at 17:00 the next day), or when none
 * was ever made; overdue a day after that, which is when Home warns. `next_due` is the local date it falls due.
 */
// `sinceIso`: when scheduled backups were turned on. With no backup made yet the first one is due that day, and overdue
// only from the next (it read "overdue" a minute after being turned on; market evaluation of 1.24.0, D7).
export function scheduleState(lastIso, everyDays = DEFAULT_EVERY_DAYS, now = Date.now(), sinceIso = null) {
  const every = SCHEDULES.includes(Number(everyDays)) ? Number(everyDays) : DEFAULT_EVERY_DAYS;
  const days = daysSince(lastIso, now);
  const p = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (days === null) {
    const since = daysSince(sinceIso, now);
    return { every_days: every, days: null, due: true, overdue: since === null || since >= 1, next_due: since === null ? null : ymd(new Date(Date.parse(sinceIso))) };
  }
  const t = new Date(Date.parse(lastIso)); const next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + every);
  return { every_days: every, days, due: days >= every, overdue: days > every, next_due: ymd(next) };
}

// suds-device-backup-2026-10-01.sudsbackup (a download) or suds-device-backup-2026-10-01-153012.sudsbackup
// (a scheduled one: the time too, so two in a day never collide). Both are this device's own date and time, the
// day the page calls "today": in UTC, an evening backup in California was named with tomorrow's date (F3).
const FILE_RE = /^suds-device-backup-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.sudsbackup$/;
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** A downloaded backup's file name, from the moment it was made. */
export const downloadName = (iso) => `suds-device-backup-${ymd(new Date(iso))}.sudsbackup`;
/** A scheduled backup's file name, from the moment it was made. */
export function fileName(iso) {
  const d = new Date(iso);
  return `suds-device-backup-${ymd(d)}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.sudsbackup`;
}
/** Is this a file SUDS named? Nothing else in a folder is ever read or removed. */
export const isBackupName = (name) => FILE_RE.test(String(name || ''));
const sortKey = (n) => { const m = FILE_RE.exec(n); return `${m[1]}-${m[2] || '000000'}`; };
const oldestFirst = (names) => (names || []).filter(isBackupName).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
/** The newest SUDS backup among `names` (by the date and time in the name), or null. */
export function newest(names) { const ours = oldestFirst(names); return ours.length ? ours[ours.length - 1] : null; }
/** Which of `names` to remove so that `keep` of SUDS's own backups are left: the oldest go first. */
export function toRemove(names, keep = DEFAULT_KEEP) {
  const n = Math.floor(Number(keep));
  const k = Math.min(MAX_KEEP, Math.max(MIN_KEEP, Number.isFinite(n) ? n : DEFAULT_KEEP));
  const ours = oldestFirst(names);
  return ours.slice(0, Math.max(0, ours.length - k));
}
