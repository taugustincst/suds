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
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { key, check } = await derive(passphrase, salt, ITERATIONS);
  const header = { format: FORMAT, version: VERSION, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), check, created_at: meta.created_at, app_version: appVersion };
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
