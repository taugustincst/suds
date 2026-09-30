'use strict';
// The county view (docs/COUNTY-VIEW.md; docs/market/DATA-NETWORK.md, Tier 1 "county aggregates from exact
// submissions"). Two halves, one file, because they must agree on the format byte for byte:
//
//   A programme's office server (a CBO) makes a COUNTY SUBMISSION FILE for a period and for one county: the
//   aggregate figures its Settlement outcomes page already computes (server/settlement-outcomes.js figures(),
//   exact, never a second way) for the settlement funds the person chose, per fund, per Exhibit E category and in
//   total, signed with an Ed25519 key that belongs to this office server. It names the county it is for (the
//   county code the county gave out). It carries aggregate counts and money only: no client, client code,
//   participant code, name, date of birth or per-event row (PAYLOAD below is an allow-list, checked when the file
//   is made and again when it is imported). It is not PHI and not a Part 2 disclosure, but it leaves the
//   programme: making it is audited (county_submission.export) with the period, the key fingerprint and the
//   payload's SHA-256.
//
//   A county's office server imports those files. The county registers each contributing programme's public
//   key (given to it out of band, with a fingerprint read out to compare), keeps each programme's key history,
//   imports the files the programmes send, and sees them side by side and summed for a period. There is no link
//   between servers, and this adds none: the file is the transport, as the funder submission a CBO already sends
//   under its contract is.
//
// What it never does: unduplicate people across programmes (that needs a shared identifier moving between
// organisations; DATA-NETWORK "What the design rules out"), publish anything (the publication screen over the
// combined release is deferred), or run on SUDS on this device (the route module is office-only:
// LOCAL_ROUTE_MODULES in server/app.js).
//
// Wording: what a person reads says "program" (US spelling, as Settings › Program does); identifiers keep the
// codebase's "programme".
const nodeCrypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const C = require('./constants');
const MAP = require('./settlement-outcome-map');
const signing = require('./signing');
const { encrypt, decrypt, uuid } = require('./crypto');

const FORMAT = 'suds-county-submission';
const SCHEMA_VERSION = 1;
const ALGORITHM = 'Ed25519';
/** The largest submission file the county imports (a programme with 200 funds is well under 100 KB). */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FUNDS = 200;
const MAX_CATEGORIES = 60;
/** The most quarters the by-quarter view shows side by side (three years). */
const MAX_QUARTERS = 12;
/** Every outcome a submission carries, in the Settlement outcomes page's order (settlement-outcome-map.js). */
const VALUE_KEYS = Object.keys(MAP.INDICATORS);
const USE_CODES = new Set([...C.SETTLEMENT_USES.map(x => x.code), 'uncategorised']);
const HIAA_CODES = new Set([...C.SETTLEMENT_HIAA.map(x => x.code), 'none']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A signed time: ISO-8601 in UTC, to the second or the millisecond, as Date.prototype.toISOString writes it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
/** A county code: eight Crockford base-32 characters (no I, L, O or U), shown as two groups of four. */
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---- dates -------------------------------------------------------------------------------------------------
/** A real calendar day written YYYY-MM-DD (not 2026-02-30). */
const isDay = (s) => typeof s === 'string' && DAY.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
/** A real instant in strict ISO-8601 UTC that reads back as itself (not "2026-02-30T00:00:00Z", not "July 4"). */
function isInstant(s) {
  if (typeof s !== 'string' || !INSTANT.test(s)) return false;
  const t = Date.parse(s); if (!Number.isFinite(t)) return false;
  const iso = new Date(t).toISOString();
  return iso === s || iso === `${s.slice(0, -1)}.000Z`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A day as people read it: "Apr 1, 2026" (never the time zone's day before). */
const humanDay = (s) => (isDay(String(s).slice(0, 10)) ? `${MONTHS[Number(String(s).slice(5, 7)) - 1]} ${Number(String(s).slice(8, 10))}, ${String(s).slice(0, 4)}` : String(s || ''));
const humanPeriod = (from, to) => `${humanDay(from)} to ${humanDay(to)}`;
const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
const daysIn = (from, to) => dayNum(to) - dayNum(from) + 1;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m is 1-12
/** The whole calendar quarters (Jan–Mar …; a California fiscal year's quarters are the same months) inside [from, to]. */
function quartersIn(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)); let m = Number(from.slice(5, 7));
  m = Math.floor((m - 1) / 3) * 3 + 1;
  for (;;) {
    const qf = `${y}-${String(m).padStart(2, '0')}-01`; const qt = lastDayOf(y, m + 2);
    if (qf > to) break;
    if (qf >= from && qt <= to) out.push({ from: qf, to: qt });
    m += 3; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ---- canonical serialisation -------------------------------------------------------------------------------
// What is signed and hashed: the payload as JSON with every object's keys sorted (by UTF-16 code unit, as
// Array.prototype.sort does), no whitespace, arrays in their order, strings and numbers as JSON.stringify
// writes them. Only JSON's own types are allowed; a number must be finite. So two servers that hold the same
// payload produce the same bytes whatever order the keys arrived in (test/county.test.js pins an example).
function canonical(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('canonical: a number must be finite'); return JSON.stringify(v); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  throw new Error(`canonical: ${typeof v} is not a JSON value`);
}
const sha256Hex = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

// ---- text a person typed ---------------------------------------------------------------------------------------
// The program's name, each fund's name and grant number, and the county's name are typed by people (the CBO's
// administrators, Settings › Program and Funding & spending). They travel in the file and are shown on the
// county's screens and in its spreadsheet, so they are held to one form: no control characters (C0, DEL, C1), no
// bidirectional overrides or isolates, no line or paragraph separators, single spaces, trimmed, and at most a
// set length. The program's server writes them that way (cleanText); the county's refuses a file whose text is
// not already in that form (textOk), since a signed file cannot be tidied without breaking its signature.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/g;
function cleanText(s, max) { return String(s === null || s === undefined ? '' : s).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim(); }

// ---- keys and fingerprints -----------------------------------------------------------------------------------
/**
 * A public key's fingerprint: the first 32 hex characters (128 bits) of SHA-256 over its SPKI DER encoding.
 * Long enough that nobody can make a second key with the same one; short enough to read out over the phone
 * in eight groups of four (formatFingerprint).
 */
function fingerprintOf(publicKeyPem) {
  const der = nodeCrypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return sha256Hex(der).slice(0, 32);
}
const formatFingerprint = (fp) => String(fp || '').match(/.{1,4}/g)?.join(' ') || '';
/** A fingerprint as a person typed or pasted it (spaces, colons, capitals), or null if it cannot be one. */
function normaliseFingerprint(s) { const t = String(s || '').toLowerCase().replace(/[\s:-]/g, ''); return /^[0-9a-f]{32}$/.test(t) ? t : null; }

/**
 * A pasted public key: an Ed25519 SPKI key in PEM ("-----BEGIN PUBLIC KEY-----"). Returns its PEM as node
 * writes it and its fingerprint, or throws with a sentence for the person who pasted it.
 */
function parsePublicKey(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('Paste the program\'s public key: the block that starts "-----BEGIN PUBLIC KEY-----".');
  if (s.length > 2000) throw new Error('That is too long to be a public key. Paste only the block from "-----BEGIN PUBLIC KEY-----" to "-----END PUBLIC KEY-----".');
  if (/PRIVATE KEY/.test(s)) throw new Error('That is a private key. Never send or paste a private key: ask the program for its public key.');
  let key;
  try { key = nodeCrypto.createPublicKey({ key: s, format: 'pem' }); } catch { throw new Error('That is not a public key SUDS can read. Paste the whole block from "-----BEGIN PUBLIC KEY-----" to "-----END PUBLIC KEY-----", as shown on the program\'s Settlement outcomes page.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('That key is not an Ed25519 key. The key a SUDS program signs county files with is shown on its Settlement outcomes page, under Send to the county.');
  const pem = key.export({ type: 'spki', format: 'pem' });
  return { pem, fingerprint: fingerprintOf(pem) };
}

// ---- the county code -------------------------------------------------------------------------------------------
/** A county code as a person typed it ("abcd-efgh", with I/L read as 1 and O as 0), or null if it cannot be one. */
function normaliseCode(s) {
  const t = String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return CODE.test(t) ? t : null;
}
const formatCode = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : '');
/**
 * This county server's code (settings.county_code), made the first time it is asked for: what a program types
 * on its Send to the county card so that its file names this county, and what an import checks. It identifies
 * the county; it is not a secret and proves nothing (the program's signature does that). Returns { code, created }.
 */
function countyCode() {
  const have = db.getSetting('county_code', null);
  if (have && CODE.test(have)) return { code: have, created: false };
  const bytes = nodeCrypto.randomBytes(5); let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let code = ''; for (let i = 7; i >= 0; i--) code += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  db.setSetting('county_code', code);
  return { code, created: true };
}

// ---- the programme's own signing key ---------------------------------------------------------------------------
/**
 * This office server's current county signing key (its public half), or null when none has been made. The
 * private key is the 32-byte Ed25519 seed, encrypted with the database key (county_signing_keys.private_key_enc),
 * so key rotation re-encrypts it with everything else and a copy of the database alone does not hold it.
 */
function currentKey() {
  const k = db.one(`SELECT id, public_key, fingerprint, created_at FROM county_signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC, id LIMIT 1`);
  return k ? { ...k, fingerprint_display: formatFingerprint(k.fingerprint), algorithm: ALGORITHM } : null;
}
/** The keys this server used before (retired by "Make a new key"), newest first: public half and dates only. */
function retiredKeys() {
  return db.all(`SELECT id, fingerprint, created_at, retired_at FROM county_signing_keys WHERE retired_at IS NOT NULL ORDER BY retired_at DESC, id`)
    .map(k => ({ ...k, fingerprint_display: formatFingerprint(k.fingerprint) }));
}
function makeKey(user) {
  const seed = nodeCrypto.randomBytes(32);
  const priv = signing.privateKeyFrom(seed);
  const pem = nodeCrypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  db.run(`INSERT INTO county_signing_keys(id,public_key,fingerprint,private_key_enc,created_at,created_by) VALUES(?,?,?,?,?,?)`,
    uuid(), pem, fingerprintOf(pem), encrypt(seed.toString('hex')), db.now(), user ? user.id : null);
  seed.fill(0);
}
/** The key, made now if there is none. Returns { key, created }. */
function ensureKey(user) {
  const have = currentKey();
  if (have) return { key: have, created: false };
  makeKey(user);
  return { key: currentKey(), created: true };
}
/**
 * "Make a new key": the current key is retired (kept, with retired_at, so the county can still tell which files
 * it signed) and a new one made. Files made from now on are signed with the new key; the county must register it
 * (its fingerprint read out again) before it imports them. Returns { old, key }.
 */
function rotateKey(user) {
  let old = null;
  db.transaction(() => {
    old = currentKey();
    if (old) db.run(`UPDATE county_signing_keys SET retired_at=?, retired_by=? WHERE id=?`, db.now(), user ? user.id : null, old.id);
    makeKey(user);
  });
  return { old, key: currentKey() };
}
function signWithCurrentKey(data) {
  const row = db.one(`SELECT private_key_enc, public_key, fingerprint FROM county_signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC, id LIMIT 1`);
  if (!row) throw new Error('no county signing key');
  const seed = Buffer.from(decrypt(row.private_key_enc), 'hex');
  const sig = nodeCrypto.sign(null, Buffer.from(data), signing.privateKeyFrom(seed)).toString('base64');
  seed.fill(0);
  return { signature: sig, fingerprint: row.fingerprint, public_key: row.public_key };
}

// ---- the payload: an allow-list -------------------------------------------------------------------------------
// Every key a payload may hold, and what its value must be. Nothing else passes: not when the file is made
// (so a change to figures() that added a client-level field could not leak through), and not when it is
// imported. money: a finite amount >= 0; count: a finite number >= 0 (staff training hours have one decimal).
// test/county.test.js freezes this list for SCHEMA_VERSION 1: changing it is a new schema version.
const PAYLOAD = {
  top: ['categories', 'counts', 'funds', 'generated_at', 'period', 'programme', 'recipient', 'schema_version', 'suds_version', 'total'],
  period: ['from', 'to'],
  recipient: ['county_code', 'county_name'],
  fund: ['category', 'grant_number', 'hiaa', 'name', 'spend', 'values'],
  fundSpend: ['approved', 'other_categories', 'own_category', 'pending'],
  category: ['key', 'spend_own_category', 'values'],
  total: ['spend', 'values'],
  totalSpend: ['approved', 'pending'],
  values: [...VALUE_KEYS].sort(),
};
/** The longest each typed text may be. */
const TEXT_MAX = { programme: 200, county_name: 200, fund_name: 200, grant_number: 100 };

class SubmissionError extends Error { constructor(code, message) { super(message); this.code = code; } }
const refuse = (code, message) => { throw new SubmissionError(code, message); };

function exactKeys(o, keys, where) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) refuse('schema', `${where} must be an object.`);
  const have = Object.keys(o).sort();
  const extra = have.filter(k => !keys.includes(k)); const missing = keys.filter(k => !have.includes(k));
  if (extra.length) refuse('schema', `${where} has ${extra.length === 1 ? 'a field' : 'fields'} a county submission never carries (${extra.slice(0, 5).join(', ')}). The file was not made by SUDS, or was changed after it was made.`);
  if (missing.length) refuse('schema', `${where} is missing ${missing.slice(0, 5).join(', ')}.`);
}
const amount = (v, where) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e12) refuse('schema', `${where} must be an amount of 0 or more.`); };
/** Typed text, exactly as cleanText writes it: not empty, at most `max` characters, nothing unsafe in it. */
const text = (v, where, max, { nullable = false } = {}) => {
  if (nullable && v === null) return;
  if (typeof v !== 'string' || !v || v.length > max || cleanText(v, max) !== v) refuse('schema', `${where} must be text of 1 to ${max} characters, with no control characters and no extra spaces.`);
};
function valuesOk(v, where) { exactKeys(v, PAYLOAD.values, where); for (const k of PAYLOAD.values) amount(v[k], `${where}.${k}`); }

/** Throws SubmissionError('schema' | 'period') unless `p` is exactly a county submission payload. */
function checkPayload(p, { today, now } = {}) {
  exactKeys(p, PAYLOAD.top, 'The submission');
  if (p.schema_version !== SCHEMA_VERSION) refuse('schema', `This file is county submission version ${JSON.stringify(p.schema_version)}; this SUDS reads version ${SCHEMA_VERSION}. Ask the program to make it again with the same version of SUDS as the county, or upgrade SUDS.`);
  text(p.programme, 'The program name', TEXT_MAX.programme);
  if (typeof p.suds_version !== 'string' || !VERSION.test(p.suds_version)) refuse('schema', 'The SUDS version must be a version number (letters, digits, dots, plus and minus; at most 40 characters).');
  if (!isInstant(p.generated_at)) refuse('schema', 'The time the file was made (generated_at) must be a date and time in UTC, as SUDS writes it (for example 2026-07-02T16:05:00.000Z).');
  if (p.counts !== 'exact') refuse('schema', 'A county submission carries exact counts (counts: "exact").');
  exactKeys(p.recipient, PAYLOAD.recipient, 'The recipient');
  if (typeof p.recipient.county_code !== 'string' || !CODE.test(p.recipient.county_code)) refuse('schema', 'The file does not name the county it is for (a county code of eight letters and digits).');
  text(p.recipient.county_name, 'The county\'s name', TEXT_MAX.county_name);
  exactKeys(p.period, PAYLOAD.period, 'The period');
  if (!isDay(p.period.from) || !isDay(p.period.to)) refuse('period', 'The period\'s dates must be real dates (YYYY-MM-DD).');
  if (p.period.from > p.period.to) refuse('period', `The period starts (${humanDay(p.period.from)}) after it ends (${humanDay(p.period.to)}).`);
  if (today && p.period.to > today) refuse('period', `The period ends in the future (${humanDay(p.period.to)}; today is ${humanDay(today)}). A submission reports a period that has happened.`);
  if (p.generated_at.slice(0, 10) < p.period.to) refuse('period', `The file says it was made on ${humanDay(p.generated_at)}, before its period ended (${humanDay(p.period.to)}). A submission is made once the period is over.`);
  if (now && Date.parse(p.generated_at) > Date.parse(now) + 86400000) refuse('period', `The file says it was made on ${humanDay(p.generated_at)}, which has not happened yet. Check the clock on the program's server, and ask for the file again.`);
  exactKeys(p.total, PAYLOAD.total, 'The total');
  exactKeys(p.total.spend, PAYLOAD.totalSpend, 'The total\'s spending');
  for (const k of PAYLOAD.totalSpend) amount(p.total.spend[k], `total.spend.${k}`);
  valuesOk(p.total.values, 'total.values');
  if (!Array.isArray(p.funds) || p.funds.length > MAX_FUNDS) refuse('schema', `funds must be a list of at most ${MAX_FUNDS}.`);
  p.funds.forEach((f, i) => {
    const w = `funds[${i}]`;
    exactKeys(f, PAYLOAD.fund, w);
    text(f.name, `${w}.name`, TEXT_MAX.fund_name); text(f.grant_number, `${w}.grant_number`, TEXT_MAX.grant_number, { nullable: true });
    if (!USE_CODES.has(f.category)) refuse('schema', `${w}.category is not an Exhibit E allowable use SUDS knows.`);
    if (f.hiaa !== null && !HIAA_CODES.has(f.hiaa)) refuse('schema', `${w}.hiaa is not a High Impact Abatement Activity SUDS knows.`);
    exactKeys(f.spend, PAYLOAD.fundSpend, `${w}.spend`);
    for (const k of PAYLOAD.fundSpend) amount(f.spend[k], `${w}.spend.${k}`);
    valuesOk(f.values, `${w}.values`);
  });
  if (!Array.isArray(p.categories) || p.categories.length > MAX_CATEGORIES) refuse('schema', `categories must be a list of at most ${MAX_CATEGORIES}.`);
  const seen = new Set();
  p.categories.forEach((c, i) => {
    const w = `categories[${i}]`;
    exactKeys(c, PAYLOAD.category, w);
    if (!USE_CODES.has(c.key) || seen.has(c.key)) refuse('schema', `${w}.key is not an Exhibit E allowable use SUDS knows, or is listed twice.`);
    seen.add(c.key);
    amount(c.spend_own_category, `${w}.spend_own_category`);
    valuesOk(c.values, `${w}.values`);
  });
  return p;
}

// ---- the programme's side: making the file --------------------------------------------------------------------
/**
 * The payload for a period, from the Settlement outcomes page's own figures (exact: figures() is the true
 * figures, before any small-cell protection). `raw` is figures(range, { fundIds }) for { from, to } and the funds
 * the person chose. A figure the allow-list expects and figures() did not give is an error, never a quiet 0.
 */
function payloadFrom(raw, { programme, recipient, generatedAt = new Date().toISOString(), version = config.version } = {}) {
  const need = (o, k, where) => { if (!o || !Object.prototype.hasOwnProperty.call(o, k) || o[k] === undefined || o[k] === null) refuse('schema', `${where} has no ${k}: the figures are not the shape this version of SUDS expects.`); return o[k]; };
  const vals = (v, where) => Object.fromEntries(VALUE_KEYS.map(k => [k, need(v, k, where)]));
  const code = normaliseCode(recipient && recipient.county_code);
  if (!code) refuse('recipient', 'Type the county code the county gave you (eight letters and digits, as its County view › Programs page shows it).');
  const countyName = cleanText(recipient && recipient.county_name, TEXT_MAX.county_name);
  if (!countyName) refuse('recipient', 'Type the county\'s name, as the file should show it.');
  const p = {
    schema_version: SCHEMA_VERSION,
    programme: cleanText(programme, TEXT_MAX.programme) || 'Unnamed program',
    recipient: { county_code: code, county_name: countyName },
    period: { from: raw.from, to: raw.to },
    generated_at: generatedAt,
    suds_version: String(version),
    counts: 'exact',
    funds: raw.funds.map((f, i) => ({ name: cleanText(f.name, TEXT_MAX.fund_name) || `Fund ${i + 1}`, grant_number: cleanText(f.grant_number, TEXT_MAX.grant_number) || null, category: f.category, hiaa: f.hiaa || null,
      spend: { own_category: need(f.spend, 'own_category', `funds[${i}].spend`), other_categories: need(f.spend, 'other_categories', `funds[${i}].spend`), approved: need(f.spend, 'approved', `funds[${i}].spend`), pending: need(f.spend, 'pending', `funds[${i}].spend`) },
      values: vals(f.values, `funds[${i}].values`) })),
    categories: raw.categories.map((c, i) => ({ key: c.key, spend_own_category: need(c, 'spend_own_category', `categories[${i}]`), values: vals(c.values, `categories[${i}].values`) })),
    total: { spend: { approved: need(raw.total.spend, 'approved', 'total.spend'), pending: need(raw.total.spend, 'pending', 'total.spend') }, values: vals(raw.total.values, 'total.values') },
  };
  return checkPayload(p);
}
/** A file name part from the program's name: "Riverbend Harm Reduction" → "riverbend-harm-reduction". */
const slug = (s) => cleanText(s, 200).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'program';

const envelope = (payload, fingerprint, signature) => ({ format: FORMAT, schema_version: SCHEMA_VERSION, payload, signature: { algorithm: ALGORITHM, key_fingerprint: fingerprint, value: signature } });
/** The file: the payload, its signature over canonical(payload), and the signing key's fingerprint. */
function signFile(payload) {
  const bytes = canonical(payload);
  const s = signWithCurrentKey(bytes);
  return { file: envelope(payload, s.fingerprint, s.signature), sha256: sha256Hex(bytes), fingerprint: s.fingerprint };
}
/**
 * The same file signed with a given 32-byte seed rather than this server's key: for sample programmes
 * (scripts/county-sample.js) and tests, which play programmes whose servers are not this one.
 */
function signWithSeed(payload, seed) {
  checkPayload(payload);
  const priv = signing.privateKeyFrom(seed);
  const pem = nodeCrypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  const bytes = canonical(payload); const fingerprint = fingerprintOf(pem);
  return { file: envelope(payload, fingerprint, nodeCrypto.sign(null, Buffer.from(bytes), priv).toString('base64')), public_key: pem, fingerprint, sha256: sha256Hex(bytes) };
}

// ---- the county's side: reading and importing a file ------------------------------------------------------------
/**
 * Read an uploaded file (its text) as far as can be done without the database: size, JSON, the envelope and
 * the payload's allow-list and period. Throws SubmissionError; returns { payload, bytes, sha256, fingerprint,
 * signature }.
 */
function parseFile(textIn, { today, now } = {}) {
  if (typeof textIn !== 'string' || !textIn.trim()) refuse('malformed', 'Choose a county submission file (a .json file a SUDS program made under Send to the county).');
  if (Buffer.byteLength(textIn, 'utf8') > MAX_FILE_BYTES) refuse('too_large', `The file is larger than a county submission can be (${Math.round(MAX_FILE_BYTES / 1024)} KB). It is not a SUDS county submission.`);
  let f;
  try { f = JSON.parse(textIn); } catch { refuse('malformed', 'The file is not a county submission: it is not valid JSON. Ask the program to send the file SUDS made, unchanged.'); }
  if (!f || typeof f !== 'object' || Array.isArray(f) || f.format !== FORMAT) refuse('format', 'The file is not a SUDS county submission (its format is not suds-county-submission).');
  exactKeys(f, ['format', 'payload', 'schema_version', 'signature'], 'The file');
  if (f.schema_version !== SCHEMA_VERSION) refuse('schema', `This file is county submission version ${JSON.stringify(f.schema_version)}; this SUDS reads version ${SCHEMA_VERSION}.`);
  exactKeys(f.signature, ['algorithm', 'key_fingerprint', 'value'], 'The signature');
  if (f.signature.algorithm !== ALGORITHM) refuse('signature', 'The file is not signed with Ed25519.');
  const fingerprint = normaliseFingerprint(f.signature.key_fingerprint);
  if (!fingerprint) refuse('signature', 'The file does not name the key it was signed with.');
  if (typeof f.signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(f.signature.value)) refuse('signature', 'The file\'s signature is not an Ed25519 signature.');
  checkPayload(f.payload, { today, now });
  const bytes = canonical(f.payload);
  return { payload: f.payload, bytes, sha256: sha256Hex(bytes), fingerprint, signature: f.signature.value };
}

/**
 * Submissions with the key that signed each (its fingerprint, and whether it is replaced or compromised). Figures the
 * county entered for a programme not on SUDS (source 'county_entered', migration 60) have no key: a LEFT JOIN, so
 * their key columns are NULL and "not signed by a key marked compromised" holds for them.
 */
const SUBS = `SELECT s.*, k.fingerprint key_fingerprint, k.replaced_at key_replaced_at, k.compromised_at key_compromised_at FROM county_submissions s LEFT JOIN county_programme_keys k ON k.id=s.key_id`;
/** The file of one programme and period that counts now, if any (what an import or a reinstatement may displace). */
const CURRENT = `SELECT id FROM county_submissions WHERE programme_id=? AND period_from=? AND period_to=? AND superseded_by IS NULL AND withdrawn_at IS NULL AND (key_id IS NULL OR key_id IN (SELECT id FROM county_programme_keys WHERE compromised_at IS NULL))`;
const subById = (id) => db.one(`${SUBS} WHERE s.id=?`, id);
const byMade = (a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at) || String(b.received_at).localeCompare(String(a.received_at)) || String(b.id).localeCompare(String(a.id));

/**
 * Settle which of one program's files for exactly one period counts: of those that can count (not withdrawn,
 * not signed by a key marked compromised), a signed file before any figures the county entered, whenever either
 * was made (a signed file always outranks county-entered figures: docs/COUNTY-VIEW.md, "Signed outranks entered");
 * then the one made last (the signed generated_at, or when the county entered it; then the one received last).
 * Every other one that can count is superseded_by it; a withdrawn file, or one a compromised key signed, is
 * superseded by nothing (it is out for its own reason). Returns the id that counts, or null.
 */
const signedFirst = (a, b) => (isEntered(a) ? 1 : 0) - (isEntered(b) ? 1 : 0);
function resettle(programmeId, from, to) {
  const rows = db.all(`${SUBS} WHERE s.programme_id=? AND s.period_from=? AND s.period_to=?`, programmeId, from, to);
  const can = rows.filter(r => !r.withdrawn_at && !r.key_compromised_at).sort((a, b) => signedFirst(a, b) || byMade(a, b));
  const winner = can[0] ? can[0].id : null;
  for (const r of rows) {
    const want = r.withdrawn_at || r.key_compromised_at || r.id === winner ? null : winner;
    if ((r.superseded_by || null) !== want) db.run(`UPDATE county_submissions SET superseded_by=? WHERE id=?`, want, r.id);
  }
  return winner;
}
/** Resettle every period a program has a file for (after one of its keys is marked or unmarked compromised). */
function resettleProgramme(programmeId) {
  for (const p of db.all(`SELECT DISTINCT period_from, period_to FROM county_submissions WHERE programme_id=?`, programmeId)) resettle(programmeId, p.period_from, p.period_to);
}

/**
 * Import a parsed file. In order: it must be for this county (its county code); its key must be a registered
 * program's, and that program active; the signature good under that key; then the same payload already
 * imported from that program changes nothing; and a new file must be signed with the program's current key (a
 * replaced key's files that were imported before it was replaced keep their place). Of the program's files for
 * exactly the same period, the one made last counts, whatever order they arrive in: an older file is stored
 * already superseded. Returns { status: 'imported' | 'superseded' | 'older' | 'duplicate', submission,
 * programme, replaced, counting }.
 */
function importParsed(parsed, user, { countyCode: here } = {}) {
  const p = parsed.payload;
  const code = here || countyCode().code;
  if (p.recipient.county_code !== code) refuse('recipient', `This file was made for another county: ${p.recipient.county_name} (county code ${formatCode(p.recipient.county_code)}). This county's code is ${formatCode(code)}. If the file is meant for this county, ask the program to make it again with this county's code.`);
  const key = db.one(`SELECT * FROM county_programme_keys WHERE fingerprint=?`, parsed.fingerprint);
  if (!key) refuse('unknown_key', `The file was signed with a key the county has not registered (fingerprint ${formatFingerprint(parsed.fingerprint)}). If the program made a new key, add it under County view › Programs › Edit › Replace the key; otherwise register the program with the public key it gave you. Then import the file again.`);
  const prog = db.one(`SELECT * FROM county_programmes WHERE id=?`, key.programme_id);
  if (!prog.active) refuse('inactive', `The file was signed by ${prog.name}, which is not an active program here. Reactivate it under County view › Programs if it should report again.`);
  if (!signing.verify(parsed.bytes, parsed.signature, key.public_key)) refuse('signature', `The signature does not match ${prog.name}'s registered key: the file was changed after it was made, or was not made with that key. Ask the program to send the file again, unchanged.`);
  const dup = db.one(`${SUBS} WHERE s.programme_id=? AND s.sha256=?`, prog.id, parsed.sha256);
  if (dup) return { status: 'duplicate', submission: summary(dup), programme: prog, replaced: null, counting: null };
  if (key.replaced_at) refuse('retired_key', `The file was signed with ${prog.name}'s old key, replaced on ${humanDay(key.replaced_at)}. New files must be signed with its current key: ask the program to make the file again (its Settlement outcomes page signs with the current key).`);
  const id = uuid(); const now = db.now();
  let before = null; let winner = null;
  db.transaction(() => {
    const cur = db.one(CURRENT, prog.id, p.period.from, p.period.to);
    before = cur ? cur.id : null;
    db.run(`INSERT INTO county_submissions(id,programme_id,key_id,period_from,period_to,schema_version,programme_name,generated_at,suds_version,payload_enc,sha256,signature,received_at,received_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, prog.id, key.id, p.period.from, p.period.to, p.schema_version, p.programme, p.generated_at, p.suds_version, encrypt(parsed.bytes), parsed.sha256, parsed.signature, now, user ? user.id : null);
    winner = resettle(prog.id, p.period.from, p.period.to);
  });
  const status = winner !== id ? 'older' : before ? 'superseded' : 'imported';
  const replacedSource = status === 'superseded' ? (subById(before).source || 'signed') : null;
  return { status, submission: summary(subById(id)), programme: prog, replaced: status === 'superseded' ? before : null, replaced_source: replacedSource, counting: status === 'older' ? summary(subById(winner)) : null };
}

/**
 * What an import did, in words: for the county's person who imported the file (routes/county.js), or for the
 * programme whose server sent it over the county connection (routes/county-connect.js). `out` is importParsed's.
 */
function importMessage(out, { audience = 'county' } = {}) {
  const s = out.submission; const who = out.programme.name; const period = humanPeriod(s.period_from, s.period_to);
  if (out.status === 'duplicate') {
    if (s.status !== 'withdrawn') return `This file was already imported on ${humanDay(s.received_at)}; nothing changed.`;
    return audience === 'county' ? `This file was already imported on ${humanDay(s.received_at)} and withdrawn on ${humanDay(s.withdrawn_at)}; nothing changed. To count it again, Reinstate it under Files received.`
      : `The county already had this file (imported on ${humanDay(s.received_at)}) and withdrew it on ${humanDay(s.withdrawn_at)}; nothing changed. Ask the county whether it should count.`;
  }
  if (out.status === 'superseded' && out.replaced_source === ENTERED) return `Imported ${who}'s submission for ${period}. A signed file outranks figures the county entered: it replaces the figures entered for the same period, which are kept but no longer count.`;
  if (out.status === 'superseded') return `Imported ${who}'s submission for ${period}. It replaces the one made earlier for the same period, which is kept but no longer counts.`;
  if (out.status === 'older') return `Imported ${who}'s submission for ${period}, but it does not count: it was made on ${humanDay(s.generated_at)}, before the one that counts for that period (made on ${humanDay(out.counting.generated_at)}). It is kept as replaced.${audience === 'county' ? ' If the older file is the right one, withdraw the newer one.' : ''}`;
  return `Imported ${who}'s submission for ${period}.`;
}

/**
 * Withdraw a file: it is kept, counts for nothing, and whatever it had replaced for the same period counts
 * again (resettle). A file that was itself replaced does not count already, so it cannot be withdrawn (withdraw
 * the one that replaced it). Returns { submission, restored } (restored: the file that counts again, or null).
 */
function withdraw(id, user) {
  const s = subById(id);
  if (!s) return null;
  if (s.withdrawn_at) refuse('conflict', 'This file was already withdrawn.');
  if (s.superseded_by) refuse('conflict', 'This file was replaced by a later one for the same period and does not count. To change what counts, withdraw the later one.');
  let restored = null;
  db.transaction(() => {
    db.run(`UPDATE county_submissions SET withdrawn_at=?, withdrawn_by=?, superseded_by=NULL WHERE id=?`, db.now(), user ? user.id : null, id);
    restored = resettle(s.programme_id, s.period_from, s.period_to);
  });
  return { submission: summary(subById(id)), restored: restored ? summary(subById(restored)) : null, programme_id: s.programme_id };
}
/**
 * Reinstate a withdrawn file: it takes its place again by the same rule as on import (of one program's files for
 * a period, the one made last counts). Returns { submission, counts, displaced }.
 */
function reinstate(id) {
  const s = subById(id);
  if (!s) return null;
  if (!s.withdrawn_at) refuse('conflict', 'This file is not withdrawn.');
  let before = null; let winner = null;
  db.transaction(() => {
    const cur = db.one(CURRENT, s.programme_id, s.period_from, s.period_to);
    before = cur ? cur.id : null;
    db.run(`UPDATE county_submissions SET withdrawn_at=NULL, withdrawn_by=NULL WHERE id=?`, id);
    winner = resettle(s.programme_id, s.period_from, s.period_to);
  });
  return { submission: summary(subById(id)), counts: winner === id, displaced: winner === id && before ? before : null, programme_id: s.programme_id,
    counting: winner && winner !== id ? summary(subById(winner)) : null };
}

/** A submission's details without its figures. */
function summary(s) {
  const status = s.withdrawn_at ? 'withdrawn' : s.superseded_by ? 'superseded' : s.key_compromised_at ? 'key_compromised' : 'current';
  return { id: s.id, programme_id: s.programme_id, period_from: s.period_from, period_to: s.period_to, schema_version: s.schema_version, programme_name: s.programme_name,
    generated_at: s.generated_at, suds_version: s.suds_version, sha256: s.sha256, received_at: s.received_at, received_by: s.received_by, superseded_by: s.superseded_by,
    withdrawn_at: s.withdrawn_at, withdrawn_by: s.withdrawn_by, key_fingerprint: s.key_fingerprint || null, key_fingerprint_display: formatFingerprint(s.key_fingerprint), status,
    source: s.source || 'signed', entered_via: s.entered_via || null };
}
/** A program's keys, current first then newest replaced. */
function programmeKeys(programmeId) {
  return db.all(`SELECT * FROM county_programme_keys WHERE programme_id=? ORDER BY (replaced_at IS NULL) DESC, COALESCE(replaced_at, added_at) DESC, id`, programmeId)
    .map(k => ({ id: k.id, fingerprint: k.fingerprint, fingerprint_display: formatFingerprint(k.fingerprint), public_key: k.public_key, added_at: k.added_at, replaced_at: k.replaced_at,
      compromised_at: k.compromised_at, current: !k.replaced_at }));
}
function programmeOut(p) {
  const keys = programmeKeys(p.id); const cur = keys.find(k => k.current) || null;
  return { id: p.id, name: p.name, fingerprint: cur ? cur.fingerprint : null, fingerprint_display: cur ? cur.fingerprint_display : '', public_key: cur ? cur.public_key : null, keys,
    active: !!p.active, keep_files: !!p.keep_files, counts: !!p.active || !!p.keep_files, notes: p.notes || '', created_at: p.created_at, updated_at: p.updated_at,
    on_suds: p.on_suds === undefined || p.on_suds === null ? true : !!p.on_suds };
}

// ---- the combined view ------------------------------------------------------------------------------------------
const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Which of a programme's counting submissions count for the period [from, to]. The rule (docs/COUNTY-VIEW.md,
 * "Which submissions count"): only a submission whose whole period lies inside the chosen one; nothing is
 * pro-rated. Where two such submissions of one programme overlap (a quarter and a month inside it), the longer
 * one counts and the other is left out, so no day is counted twice; between two of the same length, the earlier
 * starting one, then the later received. Signed files are placed first, all of them, and figures the county entered
 * after: entered figures never push a signed file out, and entered figures that overlap a signed file that counts
 * are left out (`signed_covers`: "a signed file covers this"), whatever their length.
 */
function choose(subs, from, to) {
  const inside = subs.filter(s => s.period_from >= from && s.period_to <= to);
  const outside = subs.filter(s => !(s.period_from >= from && s.period_to <= to));
  const order = [...inside].sort((a, b) => signedFirst(a, b) || daysIn(b.period_from, b.period_to) - daysIn(a.period_from, a.period_to) || a.period_from.localeCompare(b.period_from) || b.received_at.localeCompare(a.received_at));
  const used = []; const overlapped = []; const covered = [];
  const hits = (s, u) => s.period_from <= u.period_to && u.period_from <= s.period_to;
  for (const s of order) {
    const over = used.filter(u => hits(s, u));
    if (!over.length) used.push(s);
    else if (isEntered(s) && over.some(u => !isEntered(u))) covered.push(s);
    else overlapped.push(s);
  }
  used.sort((a, b) => a.period_from.localeCompare(b.period_from));
  return { used, overlapped, covered, outside };
}
/** Why a submission is left out of a period, in words (the view, its files and the read API say the same). */
const LEFT_OUT = { overlaps: 'overlaps a longer file that counts', signed_covers: 'a signed file covers this', outside: 'not wholly inside this period' };
/**
 * The submissions that can count (SUBS): not replaced, not withdrawn, and not signed by a key marked compromised;
 * one programme's, or every programme's. What the combined view adds up, and what the county connection tells a
 * programme it has received (server/county-connect.js statusFor): one rule for both.
 */
function countingSubs(programmeId = null) {
  const where = 's.superseded_by IS NULL AND s.withdrawn_at IS NULL AND k.compromised_at IS NULL';
  return programmeId ? db.all(`${SUBS} WHERE s.programme_id=? AND ${where} ORDER BY s.period_from, s.received_at`, programmeId)
    : db.all(`${SUBS} WHERE ${where} ORDER BY s.period_from, s.received_at`);
}
/** Whether a programme's files count at all: it is active, or inactive and the county keeps counting its files. */
const filesCount = (p) => !!p.active || !!p.keep_files;
/**
 * How one programme's counting submissions cover [from, to] (choose()): the files used, those left out, the days
 * they cover, and the status: 'whole' (every day of the period), 'part' or 'none'.
 */
function coverage(subs, from, to) {
  const c = choose(subs, from, to);
  const covered = c.used.reduce((n, s) => n + daysIn(s.period_from, s.period_to), 0);
  return { ...c, days_covered: covered, status: !c.used.length ? 'none' : covered >= daysIn(from, to) ? 'whole' : 'part' };
}

/**
 * How each measure is labelled on the county view and in its files. A count of people is each program's own
 * count, added up: a person served by two programs is in both, and the county view never claims otherwise.
 */
const PEOPLE_LABELS = {
  people_served: 'People served (each program\'s own count, summed)',
  referrals_made: 'Referrals made for the people served (each program\'s own count, summed)',
  people_linked: 'People linked to care: a referral admitted or completed (each program\'s own count, summed)',
  moud_linked: 'People linked to medication for OUD (each program\'s own count, summed)',
  people_trained: 'People trained in education sessions (each program\'s own count, summed)',
};
function measureLabel(k) {
  if (PEOPLE_LABELS[k]) return PEOPLE_LABELS[k];
  if (MAP.INDICATORS[k].kind === 'person') return `${MAP.INDICATORS[k].short} (each program's own count, summed)`;
  return MAP.INDICATORS[k].label;
}
const USE_ROWS = () => [...C.SETTLEMENT_USES.map(u => ({ code: u.code, label: `${u.label} (${u.schedule})` })), { code: 'uncategorised', label: 'No settlement category recorded' }];
const HIAA_ROWS = () => [...C.SETTLEMENT_HIAA.map(x => ({ code: x.code, label: x.label })), { code: 'none', label: 'No High Impact Abatement Activity recorded' }];

/** Figures the county entered for a programme not on SUDS (migration 60): what every view and file marks them as. */
const ENTERED = 'county_entered';
const ENTERED_LABEL = 'entered by the county — not signed by the program';
const ENTERED_NOTE = 'Figures marked "entered by the county — not signed by the program" were typed or imported by the county\'s own staff, from a document the program sent, for a program that does not run SUDS. No key of the program signed them. They are counted unless you leave them out.';
const isEntered = (s) => s.source === ENTERED;
/** Where a programme's counted figures came from: 'signed', 'county_entered', 'mixed' (both), or null (none). */
const sourceOf = (used) => (!used.length ? null : used.every(isEntered) ? ENTERED : used.some(isEntered) ? 'mixed' : 'signed');

/**
 * The combined view for [from, to]: each programme's figures, from the submissions that count, and the total.
 * A programme's submissions count when the programme is active, or inactive and kept (keep_files); an inactive
 * programme not kept is left out whole (inactive_left_out), never a column of its own. Money is summed exactly;
 * counts of people are summed too, which counts a person served by two programmes (or in two of one programme's
 * submissions) twice: the view says so. A programme with nothing for the period has no figures (null), not 0.
 *
 * Figures the county entered (source 'county_entered') count by the same rule (countingSubs, coverage) and are
 * marked: each programme's `source`, each row's `total_entered` (the part of the total they make up), the
 * headline's own count of them. `entered: false` leaves them out: they are taken away before the rule is applied,
 * a programme not on SUDS with no signed file for the period is no column at all (as an inactive one is not), and
 * `entered_left_out` names the programmes whose entered figures were left out.
 */
function combined(from, to, { entered = true } = {}) {
  const programmes = db.all(`SELECT * FROM county_programmes ORDER BY name COLLATE NOCASE, id`);
  const subs = countingSubs();
  const all = new Map(programmes.map(p => [p.id, []])); const byProg = new Map(programmes.map(p => [p.id, []]));
  for (const s of subs) {
    if (!all.has(s.programme_id)) continue;
    all.get(s.programme_id).push(s);
    if (entered || !isEntered(s)) byProg.get(s.programme_id).push(s);
  }
  const period = daysIn(from, to);
  const cols = []; const inactiveLeftOut = []; const enteredLeftOut = [];
  const blank = () => ({ spend_approved: 0, spend_pending: 0, use: {}, hiaa: {}, values: Object.fromEntries(VALUE_KEYS.map(k => [k, 0])) });
  const add = (agg, pl) => {
    agg.spend_approved += pl.total.spend.approved; agg.spend_pending += pl.total.spend.pending;
    for (const k of VALUE_KEYS) agg.values[k] += pl.total.values[k];
    for (const c of pl.categories) agg.use[c.key] = (agg.use[c.key] || 0) + c.spend_own_category;
    for (const f of pl.funds) { const h = f.hiaa || 'none'; agg.hiaa[h] = (agg.hiaa[h] || 0) + f.spend.approved; }
  };
  for (const p of programmes) {
    const { used, overlapped, covered, outside, days_covered: daysCovered, status } = coverage(byProg.get(p.id), from, to);
    if (!filesCount(p)) { if (used.length) inactiveLeftOut.push({ id: p.id, name: p.name, files: used.length }); continue; }
    if (!entered) {
      const had = coverage(all.get(p.id), from, to).used.filter(isEntered);
      if (had.length) enteredLeftOut.push({ id: p.id, name: p.name, files: had.length });
      if (p.on_suds === 0 && !used.length) continue;
    }
    if (!p.active && !used.length) continue;
    const agg = blank(); const aggEntered = blank();
    for (const s of used) {
      const pl = JSON.parse(decrypt(s.payload_enc));
      add(agg, pl); if (isEntered(s)) add(aggEntered, pl);
    }
    const source = sourceOf(used);
    cols.push({
      id: p.id, name: p.name, active: !!p.active, keep_files: !!p.keep_files, on_suds: p.on_suds !== 0,
      status, days_covered: daysCovered, days_in_period: period, source,
      submissions: used.map(summary),
      left_out: [...overlapped.map(s => ({ ...summary(s), why: 'overlaps', reason: LEFT_OUT.overlaps })), ...covered.map(s => ({ ...summary(s), why: 'signed_covers', reason: LEFT_OUT.signed_covers })),
        ...outside.filter(s => s.period_from <= to && s.period_to >= from).map(s => ({ ...summary(s), why: 'outside', reason: LEFT_OUT.outside }))],
      agg: used.length ? agg : null, aggEntered: source === ENTERED || source === 'mixed' ? aggEntered : null,
    });
  }
  const row = (group, key, label, pick, { money = true, round = round2 } = {}) => {
    const by = Object.fromEntries(cols.map(c => [c.id, c.agg ? round(pick(c.agg) || 0) : null]));
    return { group, key, label, money, by, total: round(cols.reduce((n, c) => n + (c.agg ? pick(c.agg) || 0 : 0), 0)),
      total_entered: round(cols.reduce((n, c) => n + (c.aggEntered ? pick(c.aggEntered) || 0 : 0), 0)) };
  };
  const rows = [
    row('spending', 'spend_approved', 'Spent from settlement funds (approved or reimbursed)', a => a.spend_approved),
    row('spending', 'spend_pending', 'Pending approval', a => a.spend_pending),
  ];
  for (const u of USE_ROWS()) if (cols.some(c => c.agg && c.agg.use[u.code])) rows.push(row('use', u.code, u.label, a => a.use[u.code]));
  for (const x of HIAA_ROWS()) if (cols.some(c => c.agg && c.agg.hiaa[x.code])) rows.push(row('hiaa', x.code, x.label, a => a.hiaa[x.code]));
  for (const k of VALUE_KEYS) rows.push(row('outcome', k, measureLabel(k), a => a.values[k], { money: false, round: k === 'staff_training_hours' ? round1 : (n) => n }));
  const whole = cols.filter(c => c.status === 'whole').length; const part = cols.filter(c => c.status === 'part').length; const none = cols.filter(c => c.status === 'none').length;
  const enteredProgrammes = cols.filter(c => c.source === ENTERED || c.source === 'mixed').length;
  return {
    from, to, days_in_period: period,
    programmes: cols.map(({ agg, aggEntered, ...c }) => c), // eslint-disable-line no-unused-vars
    rows,
    submitted: whole + part, not_submitted: none, whole, part, none, of: cols.length,
    entered, entered_programmes: enteredProgrammes, entered_left_out: enteredLeftOut, has_entered: hasEntered(),
    headline: headline(whole, part, none, cols.length, { entered: enteredProgrammes, leftOut: enteredLeftOut.length }),
    inactive_left_out: inactiveLeftOut,
    caveats: CAVEATS, caveat_summary: CAVEAT_SUMMARY, publication_note: PUBLICATION_NOTE, rule: PERIOD_RULE, entered_label: ENTERED_LABEL, entered_note: ENTERED_NOTE,
  };
}
/** Whether the county has entered figures for any programme (the views offer to leave them out only then). */
const hasEntered = () => !!db.one(`SELECT 1 x FROM county_submissions WHERE source=? LIMIT 1`, ENTERED);
/**
 * "3 of 4 programs submitted for the whole period, 0 for part of it, 1 not at all." Figures the county entered are
 * counted in it, and said apart: "Of the 3 with figures, 1 has figures entered by the county — not signed by the
 * program." Left out, it says so.
 */
function headline(whole, part, none, of, { entered = 0, leftOut = 0 } = {}) {
  let out = `${whole} of ${of} program${of === 1 ? '' : 's'} submitted for the whole period, ${part} for part of it, ${none} not at all.`;
  if (entered) out += ` Of the ${whole + part} with figures, ${entered} ${entered === 1 ? 'has' : 'have'} figures ${ENTERED_LABEL}.`;
  if (leftOut) out += ` Figures entered by the county are left out (${leftOut} program${leftOut === 1 ? '' : 's'}).`;
  return out;
}

/**
 * The combined view by quarter: each whole calendar quarter inside [from, to] (a California fiscal year's
 * quarters are the same months) combined on its own, by the same rule as combined(). Rows are the measures,
 * columns the quarters (the total of each, and the part of it the county entered); each quarter's per-programme
 * figures come with it. `entered` as for combined().
 */
function byQuarter(from, to, { entered = true } = {}) {
  const qs = quartersIn(from, to);
  if (!qs.length) return { from, to, quarters: [], rows: [], days_outside_quarters: daysIn(from, to), too_many: false, entered, has_entered: hasEntered() };
  if (qs.length > MAX_QUARTERS) return { from, to, quarters: [], rows: [], too_many: true, max_quarters: MAX_QUARTERS, entered, has_entered: hasEntered() };
  const views = qs.map(q => combined(q.from, q.to, { entered }));
  const order = [['spending', 'spend_approved'], ['spending', 'spend_pending'], ...USE_ROWS().map(u => ['use', u.code]), ...HIAA_ROWS().map(x => ['hiaa', x.code]), ...VALUE_KEYS.map(k => ['outcome', k])];
  const rows = [];
  for (const [g, k] of order) {
    const found = views.map(v => v.rows.find(r => r.group === g && r.key === k));
    const first = found.find(Boolean); if (!first) continue;
    rows.push({ group: g, key: k, label: first.label, money: first.money, by_quarter: found.map(r => (r ? r.total : 0)), by_quarter_entered: found.map(r => (r ? r.total_entered : 0)) });
  }
  const inQuarters = qs.reduce((n, q) => n + daysIn(q.from, q.to), 0);
  return {
    from, to, rows, too_many: false, days_outside_quarters: daysIn(from, to) - inQuarters, entered, has_entered: hasEntered(), entered_label: ENTERED_LABEL, entered_note: ENTERED_NOTE,
    quarters: views.map((v) => ({ from: v.from, to: v.to, whole: v.whole, part: v.part, none: v.none, of: v.of, headline: v.headline, entered_programmes: v.entered_programmes, entered_left_out: v.entered_left_out, programmes: v.programmes, rows: v.rows })),
  };
}

const CAVEAT_SUMMARY = 'Each program\'s own counts, added up: a person served by two programs counts twice. Exact figures for authorised county staff only, not for publication.';
const CAVEATS = [
  'People are counted by each program and then added up: "each program\'s own count, summed". A person served by two programs is counted twice, and the county view can never remove that double counting (it would need a shared identifier to move between organisations).',
  'Exact figures, including small numbers, as each program sends them under its funding contract. For authorised county staff only: not for publication or sharing.',
  'Each figure is what the program recorded in SUDS for the work charged to the opioid settlement funds it chose to report to the county, from its own Settlement outcomes page. Money is exact; a cost per outcome is not calculated across programs.',
];
const PERIOD_RULE = 'A program\'s submission counts when its whole period lies inside the period chosen here; nothing is pro-rated. Where two of one program\'s submissions overlap (a quarter and a month inside it), the longer one counts, except that a signed file always counts over figures the county entered. A program whose submissions cover only part of the period is marked "part of the period". An inactive program\'s files count only if the county chose to keep counting them.';
const PUBLICATION_NOTE = 'Publishing these figures needs the publication screen over the combined release (planned). Until then nothing here is for publication.';

module.exports = {
  FORMAT, SCHEMA_VERSION, ALGORITHM, MAX_FILE_BYTES, MAX_QUARTERS, VALUE_KEYS, PAYLOAD, TEXT_MAX, CAVEATS, CAVEAT_SUMMARY, PERIOD_RULE, PUBLICATION_NOTE, SubmissionError,
  ENTERED, ENTERED_LABEL, ENTERED_NOTE, LEFT_OUT, USE_CODES, HIAA_CODES, CURRENT, subById, sha256Hex, isEntered, sourceOf, hasEntered,
  SUBS, canonical, cleanText, fingerprintOf, formatFingerprint, normaliseFingerprint, parsePublicKey, normaliseCode, formatCode, countyCode,
  currentKey, retiredKeys, ensureKey, rotateKey, payloadFrom, signFile, signWithSeed, checkPayload, parseFile, importParsed, withdraw, reinstate, resettle, resettleProgramme,
  importMessage, countingSubs, filesCount, coverage, summary, programmeOut, programmeKeys, choose, combined, byQuarter, headline, measureLabel, quartersIn, daysIn, isDay, isInstant, humanDay, humanPeriod, slug,
};
