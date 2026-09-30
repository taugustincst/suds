'use strict';
// The county view (docs/COUNTY-VIEW.md; docs/market/DATA-NETWORK.md, Tier 1 "county aggregates from exact
// submissions"). Two halves, one file, because they must agree on the format byte for byte:
//
//   A programme's office server (a CBO) makes a COUNTY SUBMISSION FILE for a period: the aggregate figures its
//   Settlement outcomes page already computes (server/settlement-outcomes.js figures(), exact, never a second
//   way), per settlement fund, per Exhibit E category and in total, signed with an Ed25519 key that belongs to
//   this office server. It carries aggregate counts and money only: no client, client code, participant code,
//   name, date of birth or per-event row (PAYLOAD below is an allow-list, checked when the file is made and
//   again when it is imported). It is not PHI and not a Part 2 disclosure, but it leaves the programme: making
//   it is audited (county_submission.export) with the period, the key fingerprint and the payload's SHA-256.
//
//   A county's office server imports those files. The county registers each contributing programme's public
//   key (given to it out of band, with a fingerprint read out to compare), imports the files the programmes
//   send, and sees them side by side and summed for a period. There is no link between servers, and this adds
//   none: the file is the transport, as the funder submission a CBO already sends under its contract is.
//
// What it never does: unduplicate people across programmes (that needs a shared identifier moving between
// organisations; DATA-NETWORK "What the design rules out"), publish anything (the publication screen over the
// combined release is deferred), or run on SUDS on this device (the route module is office-only:
// LOCAL_ROUTE_MODULES in server/app.js).
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
/** Every outcome a submission carries, in the Settlement outcomes page's order (settlement-outcome-map.js). */
const VALUE_KEYS = Object.keys(MAP.INDICATORS);
const USE_CODES = new Set([...C.SETTLEMENT_USES.map(x => x.code), 'uncategorised']);
const HIAA_CODES = new Set([...C.SETTLEMENT_HIAA.map(x => x.code), 'none']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!s) throw new Error('Paste the programme\'s public key: the block that starts "-----BEGIN PUBLIC KEY-----".');
  if (s.length > 2000) throw new Error('That is too long to be a public key. Paste only the block from "-----BEGIN PUBLIC KEY-----" to "-----END PUBLIC KEY-----".');
  if (/PRIVATE KEY/.test(s)) throw new Error('That is a private key. Never send or paste a private key: ask the programme for its public key.');
  let key;
  try { key = nodeCrypto.createPublicKey({ key: s, format: 'pem' }); } catch { throw new Error('That is not a public key SUDS can read. Paste the whole block from "-----BEGIN PUBLIC KEY-----" to "-----END PUBLIC KEY-----", as shown on the programme\'s Settlement outcomes page.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('That key is not an Ed25519 key. The key a SUDS programme signs county files with is shown on its Settlement outcomes page, under Send to the county.');
  const pem = key.export({ type: 'spki', format: 'pem' });
  return { pem, fingerprint: fingerprintOf(pem) };
}

/**
 * This office server's county signing key (its public half), or null when none has been made. The private
 * key is the 32-byte Ed25519 seed, encrypted with the database key (county_signing_keys.private_key_enc), so
 * key rotation re-encrypts it with everything else and a copy of the database alone does not hold it.
 */
function currentKey() {
  const k = db.one(`SELECT id, public_key, fingerprint, created_at FROM county_signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC, id LIMIT 1`);
  return k ? { ...k, fingerprint_display: formatFingerprint(k.fingerprint), algorithm: ALGORITHM } : null;
}
/** The key, made now if there is none. Returns { key, created }. */
function ensureKey(user) {
  const have = currentKey();
  if (have) return { key: have, created: false };
  const seed = nodeCrypto.randomBytes(32);
  const priv = signing.privateKeyFrom(seed);
  const pem = nodeCrypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  db.run(`INSERT INTO county_signing_keys(id,public_key,fingerprint,private_key_enc,created_at,created_by) VALUES(?,?,?,?,?,?)`,
    uuid(), pem, fingerprintOf(pem), encrypt(seed.toString('hex')), db.now(), user ? user.id : null);
  return { key: currentKey(), created: true };
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
const PAYLOAD = {
  top: ['counts', 'funds', 'categories', 'generated_at', 'period', 'programme', 'schema_version', 'suds_version', 'total'],
  period: ['from', 'to'],
  fund: ['category', 'grant_number', 'hiaa', 'name', 'spend', 'values'],
  fundSpend: ['approved', 'other_categories', 'own_category', 'pending'],
  category: ['key', 'spend_own_category', 'values'],
  total: ['spend', 'values'],
  totalSpend: ['approved', 'pending'],
  values: [...VALUE_KEYS].sort(),
};

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
const text = (v, where, max, { nullable = false } = {}) => { if (nullable && v === null) return; if (typeof v !== 'string' || !v.trim() || v.length > max) refuse('schema', `${where} must be text of at most ${max} characters.`); };
function valuesOk(v, where) { exactKeys(v, PAYLOAD.values, where); for (const k of PAYLOAD.values) amount(v[k], `${where}.${k}`); }
const isDay = (s) => typeof s === 'string' && DAY.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;

/** Throws SubmissionError('schema' | 'period') unless `p` is exactly a county submission payload. */
function checkPayload(p, { today } = {}) {
  exactKeys(p, PAYLOAD.top, 'The submission');
  if (p.schema_version !== SCHEMA_VERSION) refuse('schema', `This file is county submission version ${JSON.stringify(p.schema_version)}; this SUDS reads version ${SCHEMA_VERSION}. Ask the programme to make it again with the same version of SUDS as the county, or upgrade SUDS.`);
  text(p.programme, 'The programme name', 200);
  text(p.suds_version, 'The SUDS version', 40);
  if (typeof p.generated_at !== 'string' || !Number.isFinite(Date.parse(p.generated_at))) refuse('schema', 'The time the file was made (generated_at) is not a date and time.');
  if (p.counts !== 'exact') refuse('schema', 'A county submission carries exact counts (counts: "exact").');
  exactKeys(p.period, PAYLOAD.period, 'The period');
  if (!isDay(p.period.from) || !isDay(p.period.to)) refuse('period', 'The period\'s dates must be real dates (YYYY-MM-DD).');
  if (p.period.from > p.period.to) refuse('period', `The period starts (${p.period.from}) after it ends (${p.period.to}).`);
  if (today && p.period.to > today) refuse('period', `The period ends in the future (${p.period.to}; today is ${today}). A submission reports a period that has happened.`);
  exactKeys(p.total, PAYLOAD.total, 'The total');
  exactKeys(p.total.spend, PAYLOAD.totalSpend, 'The total\'s spending');
  for (const k of PAYLOAD.totalSpend) amount(p.total.spend[k], `total.spend.${k}`);
  valuesOk(p.total.values, 'total.values');
  if (!Array.isArray(p.funds) || p.funds.length > MAX_FUNDS) refuse('schema', `funds must be a list of at most ${MAX_FUNDS}.`);
  p.funds.forEach((f, i) => {
    const w = `funds[${i}]`;
    exactKeys(f, PAYLOAD.fund, w);
    text(f.name, `${w}.name`, 200); text(f.grant_number, `${w}.grant_number`, 100, { nullable: true });
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
 * figures, before any small-cell protection). `raw` is figures(range) for { from, to }.
 */
function payloadFrom(raw, { programme, generatedAt = db.now(), version = config.version } = {}) {
  const vals = (v) => Object.fromEntries(VALUE_KEYS.map(k => [k, v[k] || 0]));
  const p = {
    schema_version: SCHEMA_VERSION,
    programme: String(programme || '').trim().slice(0, 200) || 'Unnamed programme',
    period: { from: raw.from, to: raw.to },
    generated_at: generatedAt,
    suds_version: String(version),
    counts: 'exact',
    funds: raw.funds.map(f => ({ name: String(f.name).slice(0, 200), grant_number: f.grant_number ? String(f.grant_number).slice(0, 100) : null, category: f.category, hiaa: f.hiaa || null,
      spend: { own_category: f.spend.own_category, other_categories: f.spend.other_categories, approved: f.spend.approved, pending: f.spend.pending }, values: vals(f.values) })),
    categories: raw.categories.map(c => ({ key: c.key, spend_own_category: c.spend_own_category, values: vals(c.values) })),
    total: { spend: { approved: raw.total.spend.approved, pending: raw.total.spend.pending }, values: vals(raw.total.values) },
  };
  return checkPayload(p);
}

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
function parseFile(textIn, { today } = {}) {
  if (typeof textIn !== 'string' || !textIn.trim()) refuse('malformed', 'Choose a county submission file (a .json file a SUDS programme made under Send to the county).');
  if (Buffer.byteLength(textIn, 'utf8') > MAX_FILE_BYTES) refuse('too_large', `The file is larger than a county submission can be (${Math.round(MAX_FILE_BYTES / 1024)} KB). It is not a SUDS county submission.`);
  let f;
  try { f = JSON.parse(textIn); } catch { refuse('malformed', 'The file is not a county submission: it is not valid JSON. Ask the programme to send the file SUDS made, unchanged.'); }
  if (!f || typeof f !== 'object' || Array.isArray(f) || f.format !== FORMAT) refuse('format', 'The file is not a SUDS county submission (its format is not suds-county-submission).');
  exactKeys(f, ['format', 'payload', 'schema_version', 'signature'], 'The file');
  if (f.schema_version !== SCHEMA_VERSION) refuse('schema', `This file is county submission version ${JSON.stringify(f.schema_version)}; this SUDS reads version ${SCHEMA_VERSION}.`);
  exactKeys(f.signature, ['algorithm', 'key_fingerprint', 'value'], 'The signature');
  if (f.signature.algorithm !== ALGORITHM) refuse('signature', 'The file is not signed with Ed25519.');
  const fingerprint = normaliseFingerprint(f.signature.key_fingerprint);
  if (!fingerprint) refuse('signature', 'The file does not name the key it was signed with.');
  if (typeof f.signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(f.signature.value)) refuse('signature', 'The file\'s signature is not an Ed25519 signature.');
  checkPayload(f.payload, { today });
  const bytes = canonical(f.payload);
  return { payload: f.payload, bytes, sha256: sha256Hex(bytes), fingerprint, signature: f.signature.value };
}

/**
 * Import a parsed file: its fingerprint must be a registered, active programme's and its signature good under
 * that programme's registered key. A file already imported (the same payload, by SHA-256) changes nothing. A
 * second file for the same programme and exactly the same period supersedes the earlier one, which is kept
 * (superseded_by). Returns { status: 'imported' | 'superseded' | 'duplicate', submission, programme, replaced }.
 */
function importParsed(parsed, user) {
  const prog = db.one(`SELECT * FROM county_programmes WHERE fingerprint=?`, parsed.fingerprint);
  if (!prog) refuse('unknown_key', `The file was signed with a key the county has not registered (fingerprint ${formatFingerprint(parsed.fingerprint)}). Register the programme under County view › Programmes, with the public key it gave you, then import the file again.`);
  if (!prog.active) refuse('inactive', `The file was signed by ${prog.name}, which is not an active programme here. Reactivate it under County view › Programmes if it should report again.`);
  if (!signing.verify(parsed.bytes, parsed.signature, prog.public_key)) refuse('signature', `The signature does not match ${prog.name}'s registered key: the file was changed after it was made, or was not made with that key. Ask the programme to send the file again, unchanged.`);
  const dup = db.one(`SELECT * FROM county_submissions WHERE sha256=?`, parsed.sha256);
  if (dup) return { status: 'duplicate', submission: summary(dup), programme: prog, replaced: null };
  const p = parsed.payload; const id = uuid(); const now = db.now();
  let replaced = null;
  db.transaction(() => {
    db.run(`INSERT INTO county_submissions(id,programme_id,period_from,period_to,schema_version,programme_name,generated_at,suds_version,payload_enc,sha256,signature,received_at,received_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, prog.id, p.period.from, p.period.to, p.schema_version, p.programme, p.generated_at, p.suds_version, encrypt(parsed.bytes), parsed.sha256, parsed.signature, now, user ? user.id : null);
    const earlier = db.one(`SELECT id FROM county_submissions WHERE programme_id=? AND period_from=? AND period_to=? AND id<>? AND superseded_by IS NULL AND withdrawn_at IS NULL ORDER BY received_at DESC LIMIT 1`, prog.id, p.period.from, p.period.to, id);
    if (earlier) { db.run(`UPDATE county_submissions SET superseded_by=? WHERE programme_id=? AND period_from=? AND period_to=? AND id<>? AND superseded_by IS NULL AND withdrawn_at IS NULL`, id, prog.id, p.period.from, p.period.to, id); replaced = earlier.id; }
  });
  return { status: replaced ? 'superseded' : 'imported', submission: summary(db.one(`SELECT * FROM county_submissions WHERE id=?`, id)), programme: prog, replaced };
}

/** A submission's details without its figures. */
function summary(s) {
  return { id: s.id, programme_id: s.programme_id, period_from: s.period_from, period_to: s.period_to, schema_version: s.schema_version, programme_name: s.programme_name,
    generated_at: s.generated_at, suds_version: s.suds_version, sha256: s.sha256, received_at: s.received_at, received_by: s.received_by, superseded_by: s.superseded_by,
    withdrawn_at: s.withdrawn_at, withdrawn_by: s.withdrawn_by, status: s.withdrawn_at ? 'withdrawn' : s.superseded_by ? 'superseded' : 'current' };
}
function programmeOut(p) { return { id: p.id, name: p.name, fingerprint: p.fingerprint, fingerprint_display: formatFingerprint(p.fingerprint), public_key: p.public_key, active: !!p.active, notes: p.notes || '', created_at: p.created_at, updated_at: p.updated_at }; }

// ---- the combined view ------------------------------------------------------------------------------------------
const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
const daysIn = (from, to) => dayNum(to) - dayNum(from) + 1;
const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Which of a programme's current submissions count for the period [from, to]. The rule (docs/COUNTY-VIEW.md,
 * "Which submissions count"): only a submission whose whole period lies inside the chosen one; nothing is
 * pro-rated. Where two such submissions of one programme overlap (a quarter and a month inside it), the longer
 * one counts and the other is left out, so no day is counted twice; between two of the same length, the earlier
 * starting one, then the later received.
 */
function choose(subs, from, to) {
  const inside = subs.filter(s => s.period_from >= from && s.period_to <= to);
  const outside = subs.filter(s => !(s.period_from >= from && s.period_to <= to));
  const order = [...inside].sort((a, b) => daysIn(b.period_from, b.period_to) - daysIn(a.period_from, a.period_to) || a.period_from.localeCompare(b.period_from) || b.received_at.localeCompare(a.received_at));
  const used = []; const overlapped = [];
  for (const s of order) (used.some(u => s.period_from <= u.period_to && u.period_from <= s.period_to) ? overlapped : used).push(s);
  used.sort((a, b) => a.period_from.localeCompare(b.period_from));
  return { used, overlapped, outside };
}

/**
 * The combined view for [from, to]: each programme's figures, from the submissions that count, and the total.
 * Money is summed exactly; counts of people are summed too, which counts a person served by two programmes (or
 * in two of one programme's submissions) twice: the view says so.
 */
function combined(from, to) {
  const programmes = db.all(`SELECT * FROM county_programmes ORDER BY name COLLATE NOCASE, id`);
  const subs = db.all(`SELECT * FROM county_submissions WHERE superseded_by IS NULL AND withdrawn_at IS NULL ORDER BY period_from, received_at`);
  const byProg = new Map(programmes.map(p => [p.id, []]));
  for (const s of subs) if (byProg.has(s.programme_id)) byProg.get(s.programme_id).push(s);
  const period = daysIn(from, to);
  const cols = [];
  for (const p of programmes) {
    const { used, overlapped, outside } = choose(byProg.get(p.id), from, to);
    if (!p.active && !used.length) continue;
    const agg = { spend_approved: 0, spend_pending: 0, use: {}, hiaa: {}, values: Object.fromEntries(VALUE_KEYS.map(k => [k, 0])) };
    for (const s of used) {
      const pl = JSON.parse(decrypt(s.payload_enc));
      agg.spend_approved += pl.total.spend.approved; agg.spend_pending += pl.total.spend.pending;
      for (const k of VALUE_KEYS) agg.values[k] += pl.total.values[k] || 0;
      for (const c of pl.categories) agg.use[c.key] = (agg.use[c.key] || 0) + c.spend_own_category;
      for (const f of pl.funds) { const h = f.hiaa || 'none'; agg.hiaa[h] = (agg.hiaa[h] || 0) + f.spend.approved; }
    }
    const covered = used.reduce((n, s) => n + daysIn(s.period_from, s.period_to), 0);
    cols.push({
      id: p.id, name: p.name, active: !!p.active, fingerprint: p.fingerprint, fingerprint_display: formatFingerprint(p.fingerprint),
      status: !used.length ? 'none' : covered >= period ? 'whole' : 'part', days_covered: covered, days_in_period: period,
      submissions: used.map(summary), left_out: [...overlapped.map(s => ({ ...summary(s), why: 'overlaps' })), ...outside.filter(s => s.period_from <= to && s.period_to >= from).map(s => ({ ...summary(s), why: 'outside' }))],
      agg,
    });
  }
  const USE = C.SETTLEMENT_USES; const HIAA = [...C.SETTLEMENT_HIAA, { code: 'none', label: 'No High Impact Abatement Activity recorded' }];
  const row = (group, key, label, pick, { money = true, round = round2 } = {}) => {
    const by = Object.fromEntries(cols.map(c => [c.id, round(pick(c.agg) || 0)]));
    return { group, key, label, money, by, total: round(cols.reduce((n, c) => n + (pick(c.agg) || 0), 0)) };
  };
  const rows = [
    row('spending', 'spend_approved', 'Spent from settlement funds (approved or reimbursed)', a => a.spend_approved),
    row('spending', 'spend_pending', 'Pending approval', a => a.spend_pending),
  ];
  for (const u of USE) if (cols.some(c => c.agg.use[u.code])) rows.push(row('use', u.code, `${u.label} (${u.schedule})`, a => a.use[u.code]));
  if (cols.some(c => c.agg.use.uncategorised)) rows.push(row('use', 'uncategorised', 'No settlement category recorded', a => a.use.uncategorised));
  for (const x of HIAA) if (cols.some(c => c.agg.hiaa[x.code])) rows.push(row('hiaa', x.code, x.label, a => a.hiaa[x.code]));
  for (const k of VALUE_KEYS) rows.push(row('outcome', k, MAP.INDICATORS[k].label, a => a.values[k], { money: false, round: k === 'staff_training_hours' ? round1 : (n) => n }));
  return {
    from, to, days_in_period: period,
    programmes: cols.map(({ agg, ...c }) => c),
    rows,
    submitted: cols.filter(c => c.status !== 'none').length, not_submitted: cols.filter(c => c.status === 'none').length,
    caveats: CAVEATS, publication_note: PUBLICATION_NOTE, rule: PERIOD_RULE,
  };
}

const CAVEATS = [
  'People are counted by each programme and then added up. A person served by two programmes is counted twice: these figures are "people served per programme, summed", not unduplicated across programmes, and they never can be (that would need a shared identifier to move between organisations).',
  'Exact figures, including small numbers, as each programme sends them under its funding contract. For authorised county staff only: not for publication or sharing.',
  'Each figure is what the programme recorded in SUDS for the work charged to its opioid settlement funds, from its own Settlement outcomes page. Money is exact; a cost per outcome is not calculated across programmes.',
];
const PERIOD_RULE = 'A programme\'s submission counts when its whole period lies inside the period chosen here; nothing is pro-rated. Where two of one programme\'s submissions overlap (a quarter and a month inside it), the longer one counts. A programme whose submissions cover only part of the period is marked "part of the period".';
const PUBLICATION_NOTE = 'Publishing these figures needs the publication screen over the combined release (planned). Until then nothing here is for publication.';

module.exports = {
  FORMAT, SCHEMA_VERSION, ALGORITHM, MAX_FILE_BYTES, VALUE_KEYS, PAYLOAD, CAVEATS, PERIOD_RULE, PUBLICATION_NOTE, SubmissionError,
  canonical, fingerprintOf, formatFingerprint, normaliseFingerprint, parsePublicKey, currentKey, ensureKey, payloadFrom, signFile, signWithSeed, checkPayload, parseFile, importParsed,
  summary, programmeOut, choose, combined, daysIn,
};
