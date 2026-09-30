'use strict';
// The county view (server/county.js, server/routes/county.js; docs/COUNTY-VIEW.md): a programme's signed county
// submission file (Send to the county, on the Settlement outcomes page), and a county's server registering the
// programmes' keys, importing their files and combining them for a period. One test server plays both: it makes
// its own file as a programme would and, as a county, registers its own key beside three sample programmes'
// (scripts/county-sample.js).
//
// Every test stands on its own: the county side starts each test from no programmes (freshCounty), and nothing
// depends on the order the tests run in.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('./helpers');
const K = require('../server/county');
const SAMPLE = require('../scripts/county-sample');

let admin, fin, sup, ro, nav, clin, thr;
const Q1 = { from: '2026-01-01', to: '2026-03-31' }; const Q2 = { from: '2026-04-01', to: '2026-06-30' };
let samples; let COUNTY; let fundA; let fundB;
const lastAudit = (action) => { const a = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return a ? { ...a, details: a.details ? JSON.parse(a.details) : null } : null; };
const auditCount = (action) => H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action=?`, action).n;
const text = (file) => JSON.stringify(file, null, 2);
const clone = (x) => JSON.parse(JSON.stringify(x));
const userId = (u) => H.db.one(`SELECT id FROM users WHERE username=?`, u).id;

/** The county side from nothing: no programmes, keys or submissions, and nobody's refusals counted. */
function freshCounty() {
  for (const t of ['county_submissions', 'county_programme_keys', 'county_programmes']) H.db.run(`DELETE FROM ${t}`);
  const { rateLimitReset } = require('../server/app');
  for (const u of ['admin', 'cothrottle']) { rateLimitReset(`county-refuse:${userId(u)}`); rateLimitReset(`county-throttle-audit:${userId(u)}`); }
}
/** The sample programme `i` (0 Riverbend, 1 Eastside, 2 Hillview), payload for `period`, made at `at`, signed with its own key. */
function sampleFile(i, period, { k = 1, at, recipient = COUNTY, seed } = {}) {
  const p = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[i], period, k, { recipient, ...(at ? { generatedAt: at } : {}) });
  return K.signWithSeed(p, seed || samples[i].seed);
}
const register = async (c, name, pem, extra = { compared: true }) => c.post('/api/county/programmes', { name, public_key: pem, ...extra });
const importFile = async (c, t) => c.post('/api/county/submissions', { text: t });
const registerSample = async (i) => { const r = await register(admin, samples[i].name, samples[i].public_key); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
const imported = async (file, want = 201) => { const r = await importFile(admin, text(file)); assert.equal(r.status, want, JSON.stringify(r.data)); return r.data; };
const view = async (from, to, c = fin) => { const r = await c.get(`/api/county/view?from=${from}&to=${to}`); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const cell = (d, key, pid) => d.rows.find(x => x.key === key).by[pid];
/** This server's own county file, as its finance lead makes it on Settlement outcomes. */
async function ownFile({ from = Q2.from, to = Q2.to, funds = [fundA], c = fin, county = COUNTY } = {}) {
  const r = await c.get(`/api/county-submission/file?from=${from}&to=${to}&county_code=${encodeURIComponent(county.county_code)}&county_name=${encodeURIComponent(county.county_name)}&funds=${funds.join(',')}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { r, file: r.data, text: text(r.data) };
}

before(async () => {
  await H.start();
  H.db.setSetting('org_name', 'Test Harm Reduction Programme');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['cofin', 'finance'], ['cosup', 'supervisor'], ['coro', 'readonly'], ['conav', 'navigator'], ['coclin', 'clinician'], ['cothrottle', 'admin']]) H.makeUser(u, role);
  fin = H.client(); await fin.login('cofin', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('cosup', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('coro', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('conav', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('coclin', 'StaffPassw0rd!x');
  thr = H.client(); await thr.login('cothrottle', 'StaffPassw0rd!x');
  // The programme's own settlement work in Q2 under two funds: the county's (A) and a city's (B), which the county
  // file for the county must leave out. Kits handed to a named client, a reversal, and spending under each.
  const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
  fundA = ok(await admin.post('/api/budget/funds', { name: 'Test county settlement share', grant_number: 'OSF-T-1', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 90000, settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' })).id;
  fundB = ok(await admin.post('/api/budget/funds', { name: 'Test city abatement grant', grant_number: 'CITY-9', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 50000, settlement_use: 'approved_h', settlement_hiaa: 'hiaa_4' })).id;
  const e = ok(await nav.post('/api/budget/expenditures', { funding_source_id: fundA, spent_at: '2026-05-05', amount: 1234.5, category: 'naloxone_supplies' })).id;
  ok(await sup.post(`/api/budget/expenditures/${e}/approve`, { status: 'approved' }), 200);
  const eb = ok(await nav.post('/api/budget/expenditures', { funding_source_id: fundB, spent_at: '2026-05-06', amount: 999, category: 'naloxone_supplies' })).id;
  ok(await sup.post(`/api/budget/expenditures/${eb}/approve`, { status: 'approved' }), 200);
  const c = ok(await sup.post('/api/clients', { first_name: 'Zebedee', last_name: 'Countyfile', dob: '1980-04-04', confirm_duplicate: true })).id;
  for (let i = 0; i < 3; i++) ok(await sup.post('/api/interventions', { client_id: c, type: 'naloxone_distribution', occurred_at: `2026-05-1${i}T18:00:00.000Z`, naloxone_kits: 2, funding_source_id: fundA }));
  ok(await sup.post('/api/interventions', { client_id: c, type: 'naloxone_distribution', occurred_at: '2026-05-15T18:00:00.000Z', naloxone_kits: 7, funding_source_id: fundB }));
  ok(await sup.post('/api/overdose-events', { occurred_at: '2026-05-20T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 1, survived: true, funding_source_id: fundA }));
  COUNTY = { county_code: K.countyCode().code, county_name: 'Test County Behavioral Health' };
  samples = SAMPLE.sample({ periods: [Q1, Q2], recipient: COUNTY });
});
after(async () => { await H.stop(); });

// ---------------------------------------------------------------- pure: canonical form, keys, signatures, payload
test('the canonical serialisation sorts keys at every depth, keeps array order and has no whitespace', () => {
  const a = { b: 1, a: [3, { z: 'x', y: null }], c: { e: true, d: 1.5 } };
  const b = { c: { d: 1.5, e: true }, a: [3, { y: null, z: 'x' }], b: 1 };
  const want = '{"a":[3,{"y":null,"z":"x"}],"b":1,"c":{"d":1.5,"e":true}}';
  assert.equal(K.canonical(a), want); assert.equal(K.canonical(b), want);
  assert.equal(K.canonical({ 'é': 'ü', 'A': '"' }), '{"A":"\\"","é":"ü"}', 'keys by code unit; strings as JSON writes them');
  assert.throws(() => K.canonical({ x: Infinity }), /finite/); assert.throws(() => K.canonical({ x: undefined }), /not a JSON value/);
  // The same payload signed twice gives the same bytes, hash and (Ed25519 is deterministic) signature.
  const p = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1, { recipient: COUNTY });
  const s1 = K.signWithSeed(p, SAMPLE.seedOf('x')); const s2 = K.signWithSeed(clone(p), SAMPLE.seedOf('x'));
  assert.equal(s1.sha256, s2.sha256); assert.equal(s1.file.signature.value, s2.file.signature.value);
  assert.equal(s1.sha256, crypto.createHash('sha256').update(K.canonical(p)).digest('hex'));
});

test('a fingerprint is 32 hex characters of SHA-256 over the key\'s DER, read out in eight groups of four', () => {
  const s = samples[0];
  const der = crypto.createPublicKey(s.public_key).export({ type: 'spki', format: 'der' });
  assert.equal(s.fingerprint, crypto.createHash('sha256').update(der).digest('hex').slice(0, 32));
  assert.match(K.formatFingerprint(s.fingerprint), /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  assert.equal(K.normaliseFingerprint(K.formatFingerprint(s.fingerprint).toUpperCase()), s.fingerprint);
  assert.throws(() => K.parsePublicKey(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' })), /not an Ed25519 key/);
  assert.throws(() => K.parsePublicKey('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), /private key/);
  assert.throws(() => K.parsePublicKey('hello'), /not a public key/);
});

test('the payload allow-list refuses any field a submission never carries, at any depth', () => {
  const p = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1, { recipient: COUNTY });
  assert.doesNotThrow(() => K.checkPayload(clone(p)));
  for (const mutate of [(x) => { x.client_code = 'M26-0001'; }, (x) => { x.funds[0].participant_code = 'P-1'; }, (x) => { x.total.values.dob = 0; }, (x) => { x.categories[0].rows = []; },
    (x) => { x.funds[0].spend.names = 1; }, (x) => { delete x.total.values.reversals; }, (x) => { x.recipient.email = 'a@b'; }, (x) => { delete x.recipient; }]) {
    const q = clone(p); mutate(q);
    assert.throws(() => K.checkPayload(q), (e) => e instanceof K.SubmissionError && e.code === 'schema');
  }
});

test('schema version 1 is frozen: the payload\'s fields, values list included, are exactly these', () => {
  // Changing any of this is a new schema version (K.SCHEMA_VERSION), never an edit to version 1: a county running
  // an older SUDS would refuse the file, or read a figure under the wrong name.
  assert.equal(K.SCHEMA_VERSION, 1);
  assert.deepEqual(K.PAYLOAD, {
    top: ['categories', 'counts', 'funds', 'generated_at', 'period', 'programme', 'recipient', 'schema_version', 'suds_version', 'total'],
    period: ['from', 'to'],
    recipient: ['county_code', 'county_name'],
    fund: ['category', 'grant_number', 'hiaa', 'name', 'spend', 'values'],
    fundSpend: ['approved', 'other_categories', 'own_category', 'pending'],
    category: ['key', 'spend_own_category', 'values'],
    total: ['spend', 'values'],
    totalSpend: ['approved', 'pending'],
    values: ['contacts', 'education_contacts', 'fentanyl_strips', 'moud_linked', 'naloxone_kits', 'people_linked', 'people_served', 'people_trained', 'referrals_made', 'reversals', 'staff_training_hours', 'syringes', 'treatment_admissions'],
  });
  // payloadFrom refuses figures that lack one the list expects, rather than writing 0 for it.
  const SO = require('../server/settlement-outcomes');
  const raw = SO.figures(rangeFor(Q2));
  assert.doesNotThrow(() => K.payloadFrom(raw, { programme: 'P', recipient: COUNTY }));
  const missing = clone(raw); delete missing.total.values.reversals;
  assert.throws(() => K.payloadFrom(missing, { programme: 'P', recipient: COUNTY }), (e) => e instanceof K.SubmissionError && /reversals/.test(e.message));
  const missingFund = clone(raw); delete missingFund.funds[0].values.people_served;
  assert.throws(() => K.payloadFrom(missingFund, { programme: 'P', recipient: COUNTY }), /people_served/);
  const missingSpend = clone(raw); delete missingSpend.funds[0].spend.pending;
  assert.throws(() => K.payloadFrom(missingSpend, { programme: 'P', recipient: COUNTY }), /pending/);
});
/** A report range for figures() outside a request (server/routes/reports.js range()). */
function rangeFor({ from, to }) { return require('../server/routes/reports').range({ query: new URLSearchParams({ from, to }) }); }

test('S1: the time a file was made is strict ISO-8601 UTC, the version a version, typed text clean and bounded', async () => {
  const base = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1, { recipient: COUNTY });
  const bad = (mutate, re) => { const q = clone(base); mutate(q); assert.throws(() => K.checkPayload(q), (e) => e instanceof K.SubmissionError && (!re || re.test(e.message)), JSON.stringify(q).slice(0, 80)); };
  // generated_at: Date.parse would take every one of these; none is a time SUDS writes.
  for (const g of ['July 4, 2026', '2026-07-01', '2026-07-01T00:00:00+02:00', '2026-07-01 00:00:00Z', '2026-02-30T00:00:00Z', '2026-07-01T24:00:00Z', '2026-07-01T00:00:00.0Z', '2026-07-01T00:00:00.1234Z', ' 2026-07-01T00:00:00Z', 'Tue, 01 Jul 2026 00:00:00 GMT', '<b>2026</b>', 20260701]) {
    bad((q) => { q.generated_at = g; }, /generated_at/);
  }
  for (const g of ['2026-04-01T00:00:00Z', '2026-04-01T10:11:12.345Z']) { const q = clone(base); q.generated_at = g; assert.doesNotThrow(() => K.checkPayload(q), g); }
  bad((q) => { q.generated_at = '2026-03-30T12:00:00Z'; }, /before its period ended/);
  { const q = clone(base); q.generated_at = '2099-01-01T00:00:00Z'; assert.throws(() => K.checkPayload(q, { now: new Date().toISOString() }), /has not happened yet/); }
  // suds_version: a version, not free text.
  for (const v of ['1.18.0 <script>', 'x'.repeat(41), '', '1.18.0\n', 'é1']) bad((q) => { q.suds_version = v; }, /SUDS version/);
  for (const v of ['1.18.0', '1.18.0-rc.1+build.7']) { const q = clone(base); q.suds_version = v; assert.doesNotThrow(() => K.checkPayload(q), v); }
  // Typed text: the programme's, the county's and each fund's name and grant number. No control characters, bidi
  // overrides, line separators or stray spaces, and bounded.
  const nasty = ['Riverbend\u202eevil', 'Line\nbreak', 'Tab\there', ' leading', 'trailing ', 'two  spaces', 'nul\u0000', 'sep\u2028x', 'bom\ufeff'];
  for (const s of nasty) {
    bad((q) => { q.programme = s; }, /program name/);
    bad((q) => { q.funds[0].name = s; }, /name/);
    bad((q) => { q.funds[0].grant_number = s; }, /grant_number/);
    bad((q) => { q.recipient.county_name = s; }, /county/);
  }
  bad((q) => { q.programme = 'x'.repeat(201); }); bad((q) => { q.funds[0].name = 'x'.repeat(201); }); bad((q) => { q.funds[0].grant_number = 'x'.repeat(101); });
  bad((q) => { q.recipient.county_code = 'ILOU0000'; }, /county/);
  // The programme's server writes the same text clean: what its administrators typed is tidied, never refused.
  const raw = require('../server/settlement-outcomes').figures(rangeFor(Q2));
  raw.funds[0].name = '  County\u202e  share\n'; raw.funds[0].grant_number = 'OSF\u0007-1';
  const p = K.payloadFrom(raw, { programme: 'Our\u2066 program\u2069', recipient: { county_code: COUNTY.county_code.toLowerCase(), county_name: ' Test\tCounty ' } });
  assert.equal(p.funds[0].name, 'County share'); assert.equal(p.funds[0].grant_number, 'OSF -1'); assert.equal(p.programme, 'Our program'); assert.equal(p.recipient.county_name, 'Test County');
  assert.equal(p.recipient.county_code, COUNTY.county_code);
  assert.match(p.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // And over HTTP: a properly signed file whose generated_at is free text is refused, and nothing is stored.
  freshCounty(); await registerSample(0);
  const q = clone(base); q.generated_at = 'soon';
  const forged = { format: K.FORMAT, schema_version: 1, payload: q, signature: { algorithm: 'Ed25519', key_fingerprint: samples[0].fingerprint, value: crypto.sign(null, Buffer.from(K.canonical(q)), require('../server/signing').privateKeyFrom(samples[0].seed)).toString('base64') } };
  const r = await importFile(admin, text(forged));
  assert.equal(r.status, 422); assert.equal(r.data.reason, 'schema'); assert.match(r.data.error, /generated_at/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0);
  // Nothing typed reaches a plain column unchecked: the stored generated_at and programme_name are the checked ones.
  await imported(sampleFile(0, Q1).file);
  const row = H.db.one(`SELECT generated_at, programme_name, suds_version FROM county_submissions`);
  assert.ok(K.isInstant(row.generated_at)); assert.equal(row.programme_name, samples[0].name); assert.match(row.suds_version, /^[0-9A-Za-z.+-]{1,40}$/);
});

test('S6: a period is real days (not 2026-02-30), and a county file is made only once the period is over', async () => {
  assert.ok(K.isDay('2026-02-28')); assert.ok(!K.isDay('2026-02-30')); assert.ok(!K.isDay('2026-13-01')); assert.ok(!K.isDay('2026-4-01'));
  const q = `county_code=${COUNTY.county_code}&county_name=x&funds=${fundA}`;
  assert.equal((await fin.get(`/api/county-submission/file?from=2026-02-01&to=2026-02-30&${q}`)).status, 400, 'no such day');
  assert.equal((await fin.get('/api/county/view?from=2026-02-01&to=2026-02-30')).status, 400, 'no such day, on the county view too');
  assert.equal((await fin.get('/api/county/view/export?from=2026-02-30&to=2026-03-31')).status, 400);
  const today = require('../server/routes/budget').localDate();
  const r = await fin.get(`/api/county-submission/file?from=2026-01-01&to=${today}&${q}`);
  assert.equal(r.status, 400, 'a period ending today is not over'); assert.match(r.data.error, /not over yet/);
  const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  assert.match((await fin.get(`/api/county-submission/file?from=2026-01-01&to=${future}&${q}`)).data.error, /not over yet/);
  assert.equal((await fin.get(`/api/county-submission/file?from=2026-06-01&to=2026-05-01&${q}`)).status, 400, 'from after to');
  assert.equal((await fin.get('/api/county-submission/file')).status, 400, 'no period');
});

// ---------------------------------------------------------------- the programme's side
test('Send to the county: the key is made on first use, its private half encrypted; finance makes a signed file for the county', async () => {
  H.db.run(`DELETE FROM county_signing_keys`);
  assert.equal((await fin.get('/api/county-submission/key')).data.key, null, 'no key until one is asked for');
  const { r, file: ownF, text: ownText } = await ownFile();
  assert.match(r.headers.get('content-disposition'), /suds-county-submission-test-harm-reduction-programme-2026-04-01_2026-06-30\.json/, 'the file name carries the program\'s name');
  const row = H.db.one(`SELECT * FROM county_signing_keys`);
  assert.ok(row && row.private_key_enc && !/^[0-9a-f]{64}$/.test(row.private_key_enc), 'stored encrypted');
  const seed = Buffer.from(require('../server/crypto').decrypt(row.private_key_enc), 'hex');
  assert.equal(seed.length, 32);
  const pem = crypto.createPublicKey(require('../server/signing').privateKeyFrom(seed)).export({ type: 'spki', format: 'pem' });
  assert.equal(pem, row.public_key, 'the stored public key is the private key\'s');
  assert.equal(ownF.signature.key_fingerprint, row.fingerprint);
  assert.equal(ownF.format, 'suds-county-submission'); assert.equal(ownF.schema_version, 1);
  const k = (await fin.get('/api/county-submission/key')).data.key;
  assert.equal(k.fingerprint, row.fingerprint); assert.match(k.public_key, /BEGIN PUBLIC KEY/);
  assert.ok(!('private_key_enc' in k));
  assert.ok(crypto.verify(null, Buffer.from(K.canonical(ownF.payload)), crypto.createPublicKey(k.public_key), Buffer.from(ownF.signature.value, 'base64')));
  const p = ownF.payload;
  assert.deepEqual(p.period, Q2); assert.equal(p.programme, 'Test Harm Reduction Programme'); assert.equal(p.counts, 'exact');
  assert.deepEqual(p.recipient, COUNTY, 'the file names the county it is for');
  assert.equal(p.total.values.naloxone_kits, 6); assert.equal(p.total.values.reversals, 1); assert.equal(p.total.values.people_served, 1, 'exact: a count of 1 is not suppressed');
  assert.equal(p.total.spend.approved, 1234.5);
  assert.equal(p.funds.length, 1); assert.equal(p.funds[0].category, 'core_a'); assert.equal(p.funds[0].hiaa, 'hiaa_6');
  // No client, code, name or date of birth: every key on the allow-list.
  const allowed = new Set(Object.values(K.PAYLOAD).flat());
  const keys = new Set(); const strings = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) { keys.add(kk); walk(x); } else if (typeof v === 'string') strings.push(v); };
  walk(p);
  for (const kk of keys) assert.ok(allowed.has(kk), `${kk} is on the allow-list`);
  const code = H.db.one(`SELECT client_code FROM clients LIMIT 1`).client_code;
  for (const s of strings) for (const bad of ['Zebedee', 'Countyfile', '1980-04-04', code]) assert.ok(!s.includes(bad), `"${s}" names nobody`);
  assert.ok(!ownText.includes('Zebedee') && !ownText.includes(code));
  // Audited as leaving the programme, with what identifies the file and not its figures.
  const a = lastAudit('county_submission.export');
  assert.deepEqual(Object.keys(a.details).sort(), ['content', 'county_code', 'fingerprint', 'from', 'funds', 'leaves_programme', 'sha256', 'to']);
  assert.equal(a.details.sha256, crypto.createHash('sha256').update(K.canonical(p)).digest('hex'));
  assert.equal(a.details.fingerprint, row.fingerprint);
  assert.ok(lastAudit('county_submission.key.create'));
});

test('S5: only the funds chosen go into the file, and every total is over them alone; the county and funds are remembered', async () => {
  const both = (await ownFile({ funds: [fundA, fundB] })).file.payload;
  const onlyA = (await ownFile({ funds: [fundA] })).file.payload;
  const onlyB = (await ownFile({ funds: [fundB] })).file.payload;
  assert.deepEqual(onlyA.funds.map(f => f.name), ['Test county settlement share'], 'the city\'s fund is not in the county\'s file');
  assert.deepEqual(both.funds.map(f => f.name).sort(), ['Test city abatement grant', 'Test county settlement share']);
  assert.equal(onlyA.total.values.naloxone_kits, 6); assert.equal(onlyB.total.values.naloxone_kits, 7); assert.equal(both.total.values.naloxone_kits, 13);
  assert.equal(onlyA.total.spend.approved, 1234.5); assert.equal(both.total.spend.approved, 2233.5);
  assert.deepEqual(onlyA.categories.map(c => c.key), ['core_a'], 'categories only of the chosen funds');
  assert.equal(onlyA.total.values.people_served, 1);
  // What is refused: no fund, a fund that is not a settlement fund, no county code, no county name.
  const q = (extra) => fin.get(`/api/county-submission/file?from=${Q2.from}&to=${Q2.to}&${extra}`);
  let r = await q(`county_code=${COUNTY.county_code}&county_name=x`); assert.equal(r.status, 400); assert.match(r.data.error, /Choose the settlement funds/);
  r = await q(`county_code=${COUNTY.county_code}&county_name=x&funds=nope`); assert.equal(r.status, 400);
  r = await q(`county_name=x&funds=${fundA}`); assert.equal(r.status, 400); assert.match(r.data.error, /county code/);
  r = await q(`county_code=NOTACODE!&county_name=x&funds=${fundA}`); assert.equal(r.status, 400);
  r = await q(`county_code=${COUNTY.county_code}&funds=${fundA}`); assert.equal(r.status, 400); assert.match(r.data.error, /county's name/);
  // The options the card offers: every settlement fund, and the county last sent to with the funds chosen then.
  await ownFile({ funds: [fundA] });
  const o = (await fin.get('/api/county-submission/options')).data;
  assert.deepEqual(o.funds.map(f => f.id).sort(), [fundA, fundB].sort());
  assert.equal(o.counties[0].code, COUNTY.county_code); assert.equal(o.counties[0].name, COUNTY.county_name); assert.deepEqual(o.counties[0].fund_ids, [fundA]);
  for (const c of [nav, clin, ro]) assert.equal((await c.get('/api/county-submission/options')).status, 403);
});

test('who may make the file: whoever files the funder submission; not a navigator, clinician or read-only', async () => {
  const q = `from=${Q2.from}&to=${Q2.to}&county_code=${COUNTY.county_code}&county_name=x&funds=${fundA}`;
  assert.equal((await admin.get(`/api/county-submission/file?${q}`)).status, 200);
  assert.equal((await sup.get(`/api/county-submission/file?${q}`)).status, 200);
  for (const c of [nav, clin, ro]) {
    assert.equal((await c.get(`/api/county-submission/file?${q}`)).status, 403);
    assert.equal((await c.get('/api/county-submission/key')).status, 403);
    assert.equal((await c.post('/api/county-submission/key', {})).status, 403);
    assert.equal((await c.post('/api/county-submission/key/new', {})).status, 403);
  }
  const supId = userId('cosup'); H.deny({ id: supId }, 'export:read');
  assert.equal((await sup.get(`/api/county-submission/file?${q}`)).status, 403, 'the file needs export:read too');
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, supId);
});

test('S4/U8: Show the key makes it without a file; Make a new key retires the old one, audited, and signs from then on', async () => {
  H.db.run(`DELETE FROM county_signing_keys`);
  const made = await fin.post('/api/county-submission/key', {});
  assert.equal(made.status, 201); assert.equal(made.data.created, true); assert.match(made.data.key.public_key, /BEGIN PUBLIC KEY/);
  assert.equal(lastAudit('county_submission.key.create').details.fingerprint, made.data.key.fingerprint);
  assert.equal((await fin.post('/api/county-submission/key', {})).status, 200, 'asked again: the same key');
  const before = auditCount('county_submission.key.rotate');
  const nk = await fin.post('/api/county-submission/key/new', {});
  assert.equal(nk.status, 201);
  assert.notEqual(nk.data.key.fingerprint, made.data.key.fingerprint);
  assert.deepEqual(nk.data.retired.map(k => k.fingerprint), [made.data.key.fingerprint], 'the old key is kept, retired');
  assert.equal(auditCount('county_submission.key.rotate'), before + 1);
  const a = lastAudit('county_submission.key.rotate'); assert.equal(a.details.retired_fingerprint, made.data.key.fingerprint); assert.equal(a.details.fingerprint, nk.data.key.fingerprint);
  const got = (await fin.get('/api/county-submission/key')).data;
  assert.equal(got.key.fingerprint, nk.data.key.fingerprint); assert.equal(got.retired.length, 1);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_signing_keys WHERE retired_at IS NULL`).n, 1);
  assert.equal((await ownFile()).file.signature.key_fingerprint, nk.data.key.fingerprint, 'a file made now is signed with the new key');
});

// ---------------------------------------------------------------- the county's side
test('the county code: shown to county:view, the same every time, a county code in form', async () => {
  const a = await fin.get('/api/county/code'); assert.equal(a.status, 200);
  assert.match(a.data.code, /^[0-9A-HJKMNP-TV-Z]{8}$/); assert.equal(a.data.code_display, `${a.data.code.slice(0, 4)}-${a.data.code.slice(4)}`);
  assert.equal((await admin.get('/api/county/code')).data.code, a.data.code);
  assert.equal(K.normaliseCode(a.data.code_display.toLowerCase()), a.data.code);
  for (const c of [ro, nav, clin]) assert.equal((await c.get('/api/county/code')).status, 403);
});

test('permissions: administrators manage; finance and supervisors view; read-only, navigators and clinicians neither', async () => {
  freshCounty();
  const auth = require('../server/auth'); const P = require('../server/permissions');
  for (const role of ['admin']) { assert.ok(auth.hasPerm({ role }, 'county:view')); assert.ok(auth.hasPerm({ role }, 'county:manage')); }
  for (const role of ['finance', 'supervisor']) { assert.ok(auth.hasPerm({ role }, 'county:view'), role); assert.ok(!auth.hasPerm({ role }, 'county:manage'), role); }
  for (const role of ['readonly', 'navigator', 'clinician']) for (const p of ['county:view', 'county:manage']) assert.ok(!auth.hasPerm({ role }, p), `${role} ${p}`);
  for (const p of ['county:view', 'county:manage']) assert.ok(P.PERMISSION_CATALOG.some(x => x.name === p), `${p} is in the catalogue the permissions page lists`);
  assert.equal(P.PERMISSION_CATALOG.find(x => x.name === 'county:manage').risk, 'sensitive');
  assert.match(P.grantProblem('readonly', auth.rolePerms('readonly'), 'county:view') || '', /exact aggregate counts/);
  assert.match(P.grantProblem('navigator', auth.rolePerms('navigator'), 'county:manage') || '', /exact aggregate counts/);
  assert.equal(P.grantProblem('finance', auth.rolePerms('finance'), 'county:manage'), null, 'finance may be granted county:manage');
  const roGrant = await admin.post(`/api/users/${userId('coro')}/permissions`, { permission: 'county:view', mode: 'grant', reason: 'County settlement reporting lead for the pilot' });
  assert.equal(roGrant.status, 400, 'a grant to read-only is refused'); assert.match(roGrant.data.error, /exact aggregate counts/);
  assert.equal((await fin.get('/api/county/programmes')).status, 200);
  assert.equal((await sup.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}`)).status, 200);
  const p = await registerSample(0);
  const s = await imported(sampleFile(0, Q1).file);
  const managed = [['POST', '/api/county/programmes', { name: 'x', public_key: samples[1].public_key, compared: true }], ['POST', '/api/county/submissions', { text: '{}' }], ['POST', '/api/county/fingerprint', { public_key: samples[0].public_key }],
    ['PUT', `/api/county/programmes/${p.id}`, { notes: 'x' }], ['POST', `/api/county/programmes/${p.id}/keys`, { public_key: samples[1].public_key, compared: true }], ['PUT', `/api/county/programmes/${p.id}/keys/${p.keys[0].id}`, { compromised: true }],
    ['POST', `/api/county/submissions/${s.submission.id}/withdraw`, { reason: 'test reason' }], ['POST', `/api/county/submissions/${s.submission.id}/reinstate`, {}]];
  for (const [m, u, b] of managed) assert.equal((await fin.req(m, u, b)).status, 403, `finance: ${m} ${u}`);
  for (const c of [ro, nav, clin]) {
    for (const u of ['/api/county/programmes', '/api/county/submissions', '/api/county/code', `/api/county/view?from=${Q1.from}&to=${Q2.to}`, `/api/county/view?from=${Q1.from}&to=${Q2.to}&by=quarter`, `/api/county/view/export?from=${Q1.from}&to=${Q2.to}`]) assert.equal((await c.get(u)).status, 403, u);
    for (const [m, u, b] of managed) assert.equal((await c.req(m, u, b)).status, 403, `${m} ${u}`);
  }
  assert.ok(lastAudit('authz.denied'));
  // A finance account granted county:manage may then register.
  const finId = userId('cofin');
  assert.equal((await admin.post(`/api/users/${finId}/permissions`, { permission: 'county:manage', mode: 'grant', reason: 'County settlement reporting lead for the pilot' })).status, 200);
  assert.equal((await fin.post('/api/county/fingerprint', { public_key: samples[0].public_key })).status, 200);
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, finId);
});

test('U6 registering: the fingerprint is shown to compare; typed and wrong, or neither typed nor compared, is refused; a key once', async () => {
  freshCounty();
  const f = await admin.post('/api/county/fingerprint', { public_key: samples[0].public_key });
  assert.equal(f.data.fingerprint, samples[0].fingerprint); assert.equal(f.data.fingerprint_display, samples[0].fingerprint_display); assert.equal(f.data.registered_as, null);
  let r = await register(admin, samples[0].name, samples[0].public_key, { fingerprint: '0000 0000 0000 0000 0000 0000 0000 0000' });
  assert.equal(r.status, 400, 'a fingerprint that does not match the key'); assert.ok(r.data.fields.fingerprint);
  r = await register(admin, samples[0].name, samples[0].public_key, {});
  assert.equal(r.status, 400, 'neither typed nor compared'); assert.match(r.data.error, /compared/); assert.ok(r.data.fields.fingerprint);
  assert.equal((await register(admin, samples[0].name, 'not a key')).status, 400);
  r = await register(admin, samples[0].name, samples[0].public_key, { fingerprint: samples[0].fingerprint_display.toUpperCase(), notes: 'Contract 2026-17' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.fingerprint, samples[0].fingerprint); assert.equal(r.data.active, true); assert.equal(r.data.keys.length, 1);
  assert.equal(lastAudit('county.programme.add').details.checked, 'typed');
  assert.equal((await register(admin, 'Another name', samples[0].public_key)).status, 409, 'the same key twice');
  r = await register(admin, samples[1].name, samples[1].public_key, { compared: true });
  assert.equal(r.status, 201); assert.equal(lastAudit('county.programme.add').details.checked, 'compared');
  assert.equal(lastAudit('county.programme.add').details.fingerprint, samples[1].fingerprint);
  const list = await fin.get('/api/county/programmes');
  assert.equal(list.data.rows.length, 2); assert.ok(lastAudit('county.view')); assert.match(list.data.county_code, /^.{4}-.{4}$/);
  assert.equal((await admin.post('/api/county/fingerprint', { public_key: samples[0].public_key })).data.registered_as, samples[0].name);
});

test('import: a good file is imported; the same file again changes nothing; one made later for the period supersedes', async () => {
  freshCounty(); await registerSample(0);
  const first = sampleFile(0, Q1, { at: '2026-04-02T09:00:00.000Z' });
  const r = await imported(first.file);
  assert.equal(r.status, 'imported'); assert.equal(r.submission.period_from, Q1.from); assert.equal(r.submission.programme, samples[0].name);
  assert.match(r.message, /Jan 1, 2026 to Mar 31, 2026/, 'U9: dates in the message as people read them');
  const a = lastAudit('county.submission.import');
  assert.equal(a.details.sha256, first.sha256); assert.ok(!('values' in a.details) && !('total' in a.details) && !JSON.stringify(a.details).includes('naloxone'), 'no figures in the audit');
  const stored = H.db.one(`SELECT * FROM county_submissions WHERE id=?`, r.submission.id);
  assert.ok(!stored.payload_enc.includes('naloxone'), 'the payload is encrypted at rest');
  assert.equal(require('../server/crypto').decrypt(stored.payload_enc), K.canonical(first.file.payload));
  const again = await imported(first.file, 200);
  assert.equal(again.status, 'duplicate'); assert.match(again.message, /already imported on/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 1);
  const corrected = sampleFile(0, Q1, { k: 1.5, at: '2026-04-20T09:00:00.000Z' });
  const sup2 = await imported(corrected.file);
  assert.equal(sup2.status, 'superseded'); assert.equal(sup2.replaced, r.submission.id);
  assert.equal(H.db.one(`SELECT superseded_by FROM county_submissions WHERE id=?`, r.submission.id).superseded_by, sup2.submission.id);
  assert.equal(lastAudit('county.submission.import').details.superseded, r.submission.id);
  const listed = (await fin.get('/api/county/submissions')).data.rows;
  assert.deepEqual(listed.map(x => x.status).sort(), ['current', 'superseded']);
  assert.ok(listed.every(x => !('payload_enc' in x) && !('payload' in x)), 'the list carries no figures');
  assert.equal(cell(await view(Q1.from, Q1.to), 'naloxone_kits', r.submission.programme_id), corrected.file.payload.total.values.naloxone_kits);
});

test('S2: an older file arriving after a newer one for the same period is kept already superseded, and the newer one counts', async () => {
  freshCounty(); const p = await registerSample(0);
  const newer = sampleFile(0, Q1, { k: 2, at: '2026-05-01T12:00:00.000Z' });
  const older = sampleFile(0, Q1, { k: 1, at: '2026-04-02T12:00:00.000Z' });
  const n = await imported(newer.file);
  const o = await imported(older.file);
  assert.equal(o.status, 'older'); assert.match(o.message, /does not count/); assert.match(o.message, /Apr 2, 2026/); assert.match(o.message, /May 1, 2026/);
  assert.equal(o.submission.status, 'superseded'); assert.equal(o.submission.superseded_by, n.submission.id); assert.equal(o.counting.id, n.submission.id);
  assert.equal(H.db.one(`SELECT superseded_by FROM county_submissions WHERE id=?`, n.submission.id).superseded_by, null, 'the newer one still counts');
  assert.equal(cell(await view(Q1.from, Q1.to), 'naloxone_kits', p.id), newer.file.payload.total.values.naloxone_kits);
  assert.equal(lastAudit('county.submission.import').details.status, 'older');
});

test('S3: withdrawing a file puts back what it replaced; a withdrawn file can be reinstated; the reason is kept in the audit', async () => {
  freshCounty(); const p = await registerSample(0);
  const A = sampleFile(0, Q1, { k: 1, at: '2026-04-02T12:00:00.000Z' }); const B = sampleFile(0, Q1, { k: 3, at: '2026-04-09T12:00:00.000Z' });
  const a = await imported(A.file); const b = await imported(B.file);
  assert.equal(b.status, 'superseded');
  const kits = async () => cell(await view(Q1.from, Q1.to), 'naloxone_kits', p.id);
  assert.equal(await kits(), B.file.payload.total.values.naloxone_kits);
  // A reason is needed; a replaced file cannot be withdrawn (it does not count); others may not withdraw.
  assert.equal((await admin.post(`/api/county/submissions/${b.submission.id}/withdraw`, {})).status, 400, 'a reason is needed');
  assert.equal((await admin.post(`/api/county/submissions/${a.submission.id}/withdraw`, { reason: 'Wrong file' })).status, 409, 'A is replaced: withdraw B instead');
  assert.equal((await fin.post(`/api/county/submissions/${b.submission.id}/withdraw`, { reason: 'Wrong file' })).status, 403);
  // Withdraw B: A counts again.
  const w = await admin.post(`/api/county/submissions/${b.submission.id}/withdraw`, { reason: 'Figures entered twice; the program is correcting them' });
  assert.equal(w.status, 200, JSON.stringify(w.data)); assert.equal(w.data.status, 'withdrawn'); assert.equal(w.data.restored.id, a.submission.id);
  assert.equal(H.db.one(`SELECT superseded_by FROM county_submissions WHERE id=?`, a.submission.id).superseded_by, null, 'A is no longer marked superseded');
  assert.equal(await kits(), A.file.payload.total.values.naloxone_kits, 'A counts again');
  const au = lastAudit('county.submission.withdraw');
  assert.equal(au.details.reason, 'Figures entered twice; the program is correcting them'); assert.equal(au.details.counts_again, a.submission.id);
  assert.ok(!JSON.stringify(au.details).includes('naloxone') && !('values' in au.details), 'no figures in the audit');
  assert.equal((await admin.post(`/api/county/submissions/${b.submission.id}/withdraw`, { reason: 'again' })).status, 409, 'already withdrawn');
  // The same file again: nothing changes, and it says how to count it again.
  const dup = await imported(B.file, 200);
  assert.equal(dup.status, 'duplicate'); assert.match(dup.message, /withdrawn/); assert.match(dup.message, /Reinstate/);
  assert.equal(await kits(), A.file.payload.total.values.naloxone_kits);
  // Reinstate B: it is the later-made file, so it counts and A is replaced again.
  assert.equal((await fin.post(`/api/county/submissions/${b.submission.id}/reinstate`, {})).status, 403);
  const re = await admin.post(`/api/county/submissions/${b.submission.id}/reinstate`, {});
  assert.equal(re.status, 200, JSON.stringify(re.data)); assert.equal(re.data.counts, true); assert.equal(re.data.status, 'current');
  assert.equal(await kits(), B.file.payload.total.values.naloxone_kits);
  assert.equal(H.db.one(`SELECT superseded_by FROM county_submissions WHERE id=?`, a.submission.id).superseded_by, b.submission.id);
  assert.equal(lastAudit('county.submission.reinstate').details.replaces, a.submission.id);
  assert.equal((await admin.post(`/api/county/submissions/${b.submission.id}/reinstate`, {})).status, 409, 'not withdrawn');
  assert.equal((await admin.post('/api/county/submissions/nope/reinstate', {})).status, 404);
  // Withdraw the only file of a period: nothing counts for it; reinstate an older one while a newer counts: kept replaced.
  assert.equal((await admin.post(`/api/county/submissions/${b.submission.id}/withdraw`, { reason: 'test' })).status, 200);
  assert.equal((await admin.post(`/api/county/submissions/${a.submission.id}/withdraw`, { reason: 'test' })).status, 200);
  assert.equal((await view(Q1.from, Q1.to)).programmes.find(x => x.id === p.id).status, 'none');
  assert.equal((await admin.post(`/api/county/submissions/${b.submission.id}/reinstate`, {})).data.counts, true);
  const ra = await admin.post(`/api/county/submissions/${a.submission.id}/reinstate`, {});
  assert.equal(ra.data.counts, false); assert.equal(ra.data.status, 'superseded'); assert.match(ra.data.message, /does not count/);
});

test('S5: a file made for another county is refused, saying so', async () => {
  freshCounty(); await registerSample(0);
  const other = sampleFile(0, Q1, { recipient: { county_code: 'ABCD2345', county_name: 'Neighbouring County' } });
  const r = await importFile(admin, text(other.file));
  assert.equal(r.status, 422); assert.equal(r.data.reason, 'recipient'); assert.match(r.data.error, /another county: Neighbouring County \(county code ABCD-2345\)/);
  assert.equal(lastAudit('county.submission.refuse').details.reason, 'recipient');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0);
});

test('S4: key history — a program\'s key replaced; its old files keep counting unless the old key is compromised; new files need the current key; one program is one column', async () => {
  freshCounty(); const p = await registerSample(0);
  const oldQ1 = await imported(sampleFile(0, Q1).file);
  const pemOf = (seed) => K.signWithSeed(SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1, { recipient: COUNTY }), seed).public_key;
  const newSeed = SAMPLE.seedOf('riverbend-new-key'); const newPem = pemOf(newSeed);
  // Replacing needs the same check as registering.
  assert.equal((await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: newPem })).status, 400, 'neither typed nor compared');
  assert.equal((await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: newPem, fingerprint: '1111 1111 1111 1111 1111 1111 1111 1111' })).status, 400, 'typed and wrong');
  const rep = await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: newPem, fingerprint: K.formatFingerprint(K.fingerprintOf(newPem)) });
  assert.equal(rep.status, 201, JSON.stringify(rep.data));
  assert.equal(rep.data.fingerprint, K.fingerprintOf(newPem)); assert.equal(rep.data.keys.length, 2); assert.equal(rep.data.keys.filter(k => k.current).length, 1);
  const origKey = rep.data.keys.find(k => k.fingerprint === samples[0].fingerprint);
  assert.ok(origKey.replaced_at && !origKey.compromised_at, 'the old key is kept, replaced, not compromised');
  const ra = lastAudit('county.programme.key.replace'); assert.equal(ra.details.old_fingerprint, samples[0].fingerprint); assert.equal(ra.details.old_compromised, false);
  assert.equal((await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[0].public_key, compared: true })).status, 409, 'a key the program used before');
  // The file the original key signed, imported before it was replaced, still counts.
  let d = await view(Q1.from, Q1.to);
  assert.equal(d.programmes.find(x => x.id === p.id).status, 'whole');
  // A new file signed with the replaced key is refused; with the current key it imports into the same column.
  const late = await importFile(admin, text(sampleFile(0, Q2).file));
  assert.equal(late.status, 422); assert.equal(late.data.reason, 'retired_key'); assert.match(late.data.error, /old key, replaced on/);
  assert.equal((await importFile(admin, text(sampleFile(0, Q1).file))).data.status, 'duplicate', 'a file already imported is still recognised');
  const q2new = await imported(sampleFile(0, Q2, { seed: newSeed }).file);
  assert.equal(q2new.submission.programme_id, p.id);
  d = await view(Q1.from, Q2.to);
  assert.equal(d.programmes.filter(x => x.name === samples[0].name).length, 1, 'one program, one column');
  assert.equal(d.programmes.find(x => x.id === p.id).submissions.length, 2);
  // "Old key compromised — stop counting its files": the Q1 file stops counting; undone, it counts again.
  assert.equal((await admin.put(`/api/county/programmes/${p.id}/keys/${rep.data.keys.find(k => k.current).id}`, { compromised: true })).status, 409, 'not the current key');
  const mark = await admin.put(`/api/county/programmes/${p.id}/keys/${origKey.id}`, { compromised: true });
  assert.equal(mark.status, 200); assert.ok(mark.data.keys.find(k => k.id === origKey.id).compromised_at);
  assert.equal(lastAudit('county.programme.key.compromised').details.files, 1);
  d = await view(Q1.from, Q1.to);
  assert.equal(d.programmes.find(x => x.id === p.id).status, 'none', 'files the compromised key signed stop counting');
  assert.equal((await fin.get('/api/county/submissions')).data.rows.find(x => x.id === oldQ1.submission.id).status, 'key_compromised');
  assert.equal((await admin.put(`/api/county/programmes/${p.id}/keys/${origKey.id}`, { compromised: false })).status, 200);
  assert.ok(lastAudit('county.programme.key.trusted'));
  assert.equal((await view(Q1.from, Q1.to)).programmes.find(x => x.id === p.id).status, 'whole');
  // Replaced with "the old key was compromised": the files it signed stop counting at once.
  const third = pemOf(SAMPLE.seedOf('riverbend-third-key'));
  const rep2 = await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: third, compared: true, old_compromised: true });
  assert.equal(rep2.status, 201); assert.equal(lastAudit('county.programme.key.replace').details.old_compromised, true);
  assert.equal((await view(Q2.from, Q2.to)).programmes.find(x => x.id === p.id).status, 'none', 'the Q2 file the second key signed no longer counts');
  // The duplicate check is per program: the same payload signed by another program's key is that program's file.
  const e = await registerSample(1);
  const x = await imported(sampleFile(0, Q1, { seed: samples[1].seed }).file);
  assert.equal(x.status, 'imported'); assert.equal(x.submission.programme_id, e.id);
});

test('deactivation: an inactive program\'s files stop counting unless the county keeps them; its new files are refused', async () => {
  freshCounty(); const p = await registerSample(2); await registerSample(0);
  await imported(sampleFile(2, Q1).file);
  let d = await view(Q1.from, Q1.to);
  assert.equal(d.programmes.find(x => x.id === p.id).status, 'whole');
  assert.equal((await admin.put(`/api/county/programmes/${p.id}`, { active: false })).status, 200);
  assert.ok(lastAudit('county.programme.deactivate'));
  d = await view(Q1.from, Q1.to);
  assert.ok(!d.programmes.some(x => x.id === p.id), 'not a column');
  assert.deepEqual(d.inactive_left_out.map(x => x.name), [samples[2].name], 'said, by name');
  assert.equal(d.rows.find(x => x.key === 'naloxone_kits').total, 0);
  const r = await importFile(admin, text(sampleFile(2, Q2).file));
  assert.equal(r.status, 422); assert.equal(r.data.reason, 'inactive');
  // Kept: its files count again, while it stays inactive.
  const k = await admin.put(`/api/county/programmes/${p.id}`, { keep_files: true });
  assert.equal(k.data.active, false); assert.equal(k.data.keep_files, true);
  d = await view(Q1.from, Q1.to);
  assert.equal(d.programmes.find(x => x.id === p.id).status, 'whole'); assert.equal(d.inactive_left_out.length, 0);
  assert.equal((await view(Q2.from, Q2.to)).programmes.some(x => x.id === p.id), false, 'an inactive program with nothing for the period is no column');
  assert.equal((await admin.put(`/api/county/programmes/${p.id}`, { active: true, keep_files: false, notes: 'reactivated' })).status, 200);
  assert.ok(lastAudit('county.programme.reactivate'));
});

test('refusals: each is refused with a reason, audited without figures, and nothing is stored', async () => {
  freshCounty(); await registerSample(1); await registerSample(2);
  const good = sampleFile(1, Q1).file;
  const refusedWith = async (t, reason, status = 422) => {
    const r = await importFile(admin, t);
    assert.equal(r.status, status, `${reason}: ${JSON.stringify(r.data)}`); assert.equal(r.data.reason, reason); assert.ok(r.data.error && r.data.error.length > 20, 'a sentence saying why');
    const a = lastAudit('county.submission.refuse');
    assert.equal(a.details.reason, reason); assert.equal(a.success, 0);
    assert.deepEqual(Object.keys(a.details).sort(), ['bytes', 'file_sha256', 'reason']);
  };
  const tampered = clone(good); tampered.payload.total.values.naloxone_kits += 1;
  await refusedWith(text(tampered), 'signature');
  const forged = K.signWithSeed(good.payload, SAMPLE.seedOf('someone-else')).file; forged.signature.key_fingerprint = samples[1].fingerprint;
  await refusedWith(text(forged), 'signature');
  await refusedWith(text(K.signWithSeed(good.payload, SAMPLE.seedOf('unregistered')).file), 'unknown_key');
  const pid = H.db.one(`SELECT programme_id FROM county_programme_keys WHERE fingerprint=?`, samples[2].fingerprint).programme_id;
  assert.equal((await admin.put(`/api/county/programmes/${pid}`, { active: false })).status, 200);
  await refusedWith(text(sampleFile(2, Q1).file), 'inactive');
  await refusedWith('{"format": "suds-county-submission", ', 'malformed');
  await refusedWith(JSON.stringify({ hello: 'world' }), 'format');
  const extra = clone(good); extra.payload.funds[0].client_code = 'M26-0001';
  await refusedWith(text(extra), 'schema');
  await refusedWith('', 'malformed');
  await refusedWith(JSON.stringify({ ...good, padding: 'x'.repeat(K.MAX_FILE_BYTES) }), 'too_large', 413);
  const future = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  await refusedWith(text(K.signWithSeed({ ...good.payload, period: { from: '2026-01-01', to: future }, generated_at: `${future}T00:00:00.000Z` }, samples[1].seed).file), 'period');
  assert.throws(() => K.signWithSeed({ ...good.payload, period: { from: '2026-03-31', to: '2026-01-01' } }, samples[1].seed), /starts/);
  const b = clone(good); b.payload.period = { from: '2026-03-31', to: '2026-01-01' };
  await refusedWith(text(b), 'period');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0, 'nothing was stored');
});

test('E8: refusals are throttled per person, and the throttling is audited once per window', async () => {
  freshCounty(); await registerSample(1);
  const before = auditCount('county.submission.throttled');
  let last;
  for (let i = 0; i < 25; i++) last = await importFile(thr, 'not json');
  assert.equal(last.status, 429);
  assert.equal((await importFile(thr, text(sampleFile(1, Q1).file))).status, 429, 'even a good file, until the window passes');
  assert.equal(auditCount('county.submission.throttled'), before + 1, 'six throttled attempts, one audit entry');
  const a = lastAudit('county.submission.throttled'); assert.equal(a.success, 0); assert.equal(a.username, 'cothrottle');
  assert.equal((await importFile(admin, text(sampleFile(1, Q1).file))).status, 201, 'another person is not held up');
});

test('the combined view: per program and in total, who submitted for the whole period, part of it or not at all', async () => {
  freshCounty();
  const [r0, r1, r2] = [await registerSample(0), await registerSample(1), await registerSample(2)];
  const own = await ownFile();
  const ownKey = (await fin.get('/api/county-submission/key')).data.key.public_key;
  const me = await register(admin, 'Test Harm Reduction Programme', ownKey); assert.equal(me.status, 201);
  await imported(own.file);
  for (const i of [0, 1]) await imported(sampleFile(i, Q1).file);
  const jan = { from: '2026-01-01', to: '2026-01-31' };
  await imported(sampleFile(2, jan, { k: 0.2 }).file);
  const d = await view(Q1.from, Q1.to);
  const byName = Object.fromEntries(d.programmes.map(p => [p.name, p]));
  assert.equal(byName[samples[0].name].status, 'whole'); assert.equal(byName[samples[1].name].status, 'whole');
  assert.equal(byName[samples[2].name].status, 'part', 'Hillview sent January only');
  assert.equal(byName['Test Harm Reduction Programme'].status, 'none', 'its Q2 file is outside Q1');
  assert.equal(d.whole, 2); assert.equal(d.part, 1); assert.equal(d.none, 1); assert.equal(d.of, 4); assert.equal(d.submitted, 3); assert.equal(d.not_submitted, 1);
  assert.equal(d.headline, '2 of 4 programs submitted for the whole period, 1 for part of it, 1 not at all.', 'U2');
  const kits = d.rows.find(x => x.key === 'naloxone_kits');
  const want = [0, 1].reduce((n, i) => n + sampleFile(i, Q1).file.payload.total.values.naloxone_kits, 0) + sampleFile(2, jan, { k: 0.2 }).file.payload.total.values.naloxone_kits;
  assert.equal(kits.total, want);
  assert.equal(kits.by[me.data.id], null, 'M6: a program that did not submit has no figure, not 0');
  assert.equal(kits.by[r2.id], sampleFile(2, jan, { k: 0.2 }).file.payload.total.values.naloxone_kits);
  // U1: people are each program's own count, summed, and the word "unduplicated" is nowhere on the view.
  assert.equal(d.rows.find(x => x.key === 'people_served').label, 'People served (each program\'s own count, summed)');
  for (const k of ['people_served', 'referrals_made', 'people_linked', 'moud_linked', 'people_trained']) assert.match(d.rows.find(x => x.key === k).label, /each program's own count, summed/);
  assert.ok(!/unduplicated/i.test(JSON.stringify({ ...d, indicators: undefined })), 'never "unduplicated"');
  assert.ok(d.caveats.some(c => /counted twice/.test(c))); assert.match(d.publication_note, /publication screen over the combined release \(planned\)/); assert.ok(d.caveat_summary);
  assert.ok(byName[samples[0].name].submissions[0].received_at);
  const a = lastAudit('county.view'); assert.equal(a.details.what, 'combined'); assert.ok(!JSON.stringify(a.details).includes('naloxone'));
  // Both quarters: the totals are the sum of every file, and the programs add up to the total.
  for (const i of [0, 1, 2]) await imported(sampleFile(i, Q2).file);
  await imported(sampleFile(2, Q1).file);
  const all = await view(Q1.from, Q2.to, sup);
  const files = [sampleFile(0, Q1), sampleFile(1, Q1), sampleFile(2, Q1), sampleFile(0, Q2), sampleFile(1, Q2), sampleFile(2, Q2)].map(f => f.file.payload).concat(own.file.payload);
  for (const k of K.VALUE_KEYS) {
    const row = all.rows.find(x => x.key === k);
    assert.ok(Math.abs(row.total - files.reduce((n, p) => n + p.total.values[k], 0)) < 1e-6, `${k}`);
    assert.ok(Math.abs(Object.values(row.by).reduce((x, y) => x + (y || 0), 0) - row.total) < 1e-6, `${k}: the programs add up to the total`);
  }
  assert.ok(Math.abs(all.rows.find(x => x.key === 'spend_approved').total - files.reduce((n, p) => n + p.total.spend.approved, 0)) < 0.01);
  const coreA = all.rows.find(x => x.group === 'use' && x.key === 'core_a');
  assert.ok(Math.abs(coreA.total - files.reduce((n, p) => n + p.categories.filter(c => c.key === 'core_a').reduce((t, c) => t + c.spend_own_category, 0), 0)) < 0.01);
  assert.ok(all.rows.some(x => x.group === 'hiaa' && x.key === 'hiaa_6'));
  assert.equal(all.whole, 3); assert.equal(all.part, 1, 'this program sent Q2 only'); assert.equal(all.none, 0);
  assert.deepEqual(all.programmes.find(x => x.id === r2.id).left_out.map(x => [x.period_to, x.why]), [['2026-01-31', 'overlaps']]);
  assert.ok(r0 && r1);
});

test('the period rule: only submissions wholly inside the period count; a longer one wins over one inside it', async () => {
  freshCounty(); const p = await registerSample(2); await registerSample(0);
  await imported(sampleFile(2, Q1).file); await imported(sampleFile(2, Q2).file); await imported(sampleFile(0, Q1).file);
  const jan = sampleFile(2, { from: '2026-01-01', to: '2026-01-31' }, { k: 0.2 });
  await imported(jan.file);
  const q1 = (await view(Q1.from, Q1.to)).programmes.find(x => x.id === p.id);
  assert.deepEqual(q1.submissions.map(x => x.period_to), ['2026-03-31']);
  assert.deepEqual(q1.left_out.map(x => [x.period_to, x.why]), [['2026-01-31', 'overlaps']]);
  const j = await view('2026-01-01', '2026-01-31');
  const jp = j.programmes.find(x => x.id === p.id);
  assert.deepEqual(jp.submissions.map(x => x.period_to), ['2026-01-31']); assert.equal(jp.status, 'whole');
  assert.ok(jp.left_out.some(x => x.why === 'outside' && x.period_to === '2026-03-31'));
  assert.equal(cell(j, 'naloxone_kits', p.id), jan.file.payload.total.values.naloxone_kits);
  assert.equal(j.programmes.find(x => x.name === samples[0].name).status, 'none', 'a quarter is never cut down to a month');
  const fm = await view('2026-02-01', '2026-05-31');
  assert.equal(fm.submitted, 0); assert.equal(fm.rows.find(x => x.key === 'naloxone_kits').total, 0);
  const h1 = (await view(Q1.from, Q2.to)).programmes.find(x => x.id === p.id);
  assert.equal(h1.submissions.length, 2); assert.equal(h1.status, 'whole');
  assert.equal((await view(Q1.from, '2026-07-31')).programmes.find(x => x.id === p.id).status, 'part');
  assert.equal((await fin.get('/api/county/view?from=2026-05-01&to=2026-04-01')).status, 400);
});

test('M5: by quarter — measures by quarter, each quarter combined by the same rule, with its programs behind it', async () => {
  freshCounty(); const p0 = await registerSample(0); await registerSample(1);
  await imported(sampleFile(0, Q1).file); await imported(sampleFile(0, Q2).file); await imported(sampleFile(1, Q2).file);
  const r = await fin.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}&by=quarter`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.equal(lastAudit('county.view').details.what, 'by_quarter');
  assert.equal(d.by, 'quarter'); assert.deepEqual(d.quarters.map(q => [q.from, q.to]), [[Q1.from, Q1.to], [Q2.from, Q2.to]]);
  assert.deepEqual(d.quarters.map(q => [q.whole, q.none, q.of]), [[1, 1, 2], [2, 0, 2]]);
  const kits = d.rows.find(x => x.key === 'naloxone_kits');
  for (const [i, q] of [Q1, Q2].entries()) assert.equal(kits.by_quarter[i], (await view(q.from, q.to)).rows.find(x => x.key === 'naloxone_kits').total, 'each column is that quarter combined');
  assert.equal(d.quarters[0].rows.find(x => x.key === 'naloxone_kits').by[p0.id], sampleFile(0, Q1).file.payload.total.values.naloxone_kits);
  assert.ok(!/unduplicated/i.test(JSON.stringify(d)));
  // A range that is not whole quarters: the whole quarters inside it, and how many days are outside them.
  const part = (await fin.get(`/api/county/view?from=2026-02-15&to=${Q2.to}&by=quarter`)).data;
  assert.deepEqual(part.quarters.map(q => q.from), [Q2.from]); assert.equal(part.days_outside_quarters, 45);
  const long = (await fin.get('/api/county/view?from=2020-01-01&to=2026-06-30&by=quarter')).data;
  assert.equal(long.too_many, true); assert.equal(long.quarters.length, 0);
  assert.deepEqual(K.quartersIn('2025-07-01', '2026-06-30').map(q => q.from), ['2025-07-01', '2025-10-01', '2026-01-01', '2026-04-01'], 'a California fiscal year is four quarters');
});

test('the combined view as Excel, CSV and a tidy CSV: labelled internal and exact, audited, never "unduplicated"', async () => {
  freshCounty(); await registerSample(0); await registerSample(1); await registerSample(2);
  for (const i of [0, 1]) { await imported(sampleFile(i, Q1).file); await imported(sampleFile(i, Q2).file); }
  const csv = await fin.get(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /suds-county-view-2026-01-01_2026-06-30-internal-exact\.csv/);
  assert.equal(csv.headers.get('x-suds-report-counts'), 'exact');
  assert.match(csv.data, /Internal — exact counts/); assert.match(csv.data, /counted twice/); assert.match(csv.data, /publication screen over the combined release \(planned\)/);
  assert.ok(!/unduplicated/i.test(csv.data), 'U1: never "unduplicated" in the export');
  assert.match(csv.data, /2 of 3 programs submitted for the whole period, 0 for part of it, 1 not at all\./, 'U2: the headline');
  assert.match(csv.data, /Total \(2 of 3 programs complete\)/, 'M6: the total says how many are complete');
  assert.match(csv.data, /— \(not submitted\)/, 'M6: a program that did not submit says so in words');
  assert.match(csv.data, /People served \(each program's own count, summed\)/);
  for (const s of samples) assert.ok(csv.data.includes(s.name));
  const x = await fin.raw(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}&format=xlsx`);
  assert.equal(x.status, 200); const buf = Buffer.from(await x.arrayBuffer()); assert.equal(buf.slice(0, 2).toString(), 'PK');
  const wb = require('../server/spreadsheet').readWorkbook(buf);
  assert.ok(!/unduplicated/i.test(JSON.stringify(wb)));
  let a = lastAudit('county.export'); assert.equal(a.details.format, 'xlsx'); assert.ok(!JSON.stringify(a.details).includes('naloxone'));
  // M7: the tidy CSV, one row per program, submission, fund and measure.
  const t = await fin.get(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}&format=tidy`);
  assert.equal(t.status, 200); assert.match(t.headers.get('content-disposition'), /-tidy-internal-exact\.csv/);
  const lines = t.data.trim().split(/\r?\n/);
  assert.equal(lines[0], 'program,period_from,period_to,fund,grant_number,measure_code,measure_label,value,source', 'the layout county-entered figures are imported in, and who each figure is from');
  const f = sampleFile(0, Q1).file.payload;
  const kitsRow = lines.find(l => l.startsWith(`${samples[0].name},2026-01-01,2026-03-31,County settlement share,OSF-RB-1,naloxone_kits,`));
  assert.ok(kitsRow, 'a fund\'s measure'); assert.equal(Number(kitsRow.split(',')[7]), f.funds[0].values.naloxone_kits);
  assert.equal(kitsRow.split(',')[8], 'signed by the program', 'a signed file\'s figure says so');
  assert.ok(lines.some(l => l.startsWith(`${samples[0].name},2026-01-01,2026-03-31,All funds in the submission,,spend_approved,`)));
  assert.ok(!lines.some(l => l.startsWith(samples[2].name)), 'a program with nothing counted has no rows');
  assert.ok(!/unduplicated/i.test(t.data));
  a = lastAudit('county.export'); assert.equal(a.details.format, 'tidy');
  const supId = userId('cosup'); H.deny({ id: supId }, 'export:read');
  assert.equal((await sup.get(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}`)).status, 403);
  assert.equal((await sup.get(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}&format=tidy`)).status, 403);
  assert.equal((await sup.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}`)).status, 200);
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, supId);
});

test('E7: the navigation counts every registered program, inactive ones too', async () => {
  freshCounty();
  assert.equal((await fin.get('/api/auth/me')).data.programme.county_programmes, 0);
  const p = await registerSample(0);
  assert.equal((await fin.get('/api/auth/me')).data.programme.county_programmes, 1);
  assert.equal((await admin.put(`/api/county/programmes/${p.id}`, { active: false })).status, 200);
  assert.equal((await fin.get('/api/auth/me')).data.programme.county_programmes, 1, 'its files are still there to see');
});

test('SUDS on this device has no county view: the local kernel does not load the routes', () => {
  const { LOCAL_ROUTE_MODULES, ROUTE_MODULES } = require('../server/app');
  assert.ok(ROUTE_MODULES.includes('county')); assert.ok(!LOCAL_ROUTE_MODULES.includes('county'));
  const fs = require('node:fs'); const path = require('node:path');
  const kernel = fs.readFileSync(path.join(__dirname, '..', 'local', 'kernel.js'), 'utf8');
  assert.ok(!/routes\/county\.js/.test(kernel), 'no loader for the county routes (test/county-device.test.js asks the kernel itself)');
});

test('the county tables stay at the office', () => {
  const S = require('../server/sync-tables');
  for (const t of ['county_signing_keys', 'county_programmes', 'county_programme_keys', 'county_submissions']) { assert.ok(S.server_only.includes(t), t); assert.ok(!S.tables.some(x => x.name === t), t); }
  assert.deepEqual(S.unsynced_enc.county_signing_keys, ['private_key_enc']); assert.deepEqual(S.unsynced_enc.county_submissions, ['payload_enc', 'source_ref_enc']); assert.deepEqual(S.unsynced_enc.county_programme_keys, []);
});

test('M11: county-sample.js --register sets up a development server\'s county view, and refuses a production one', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-county-sample-'));
  const script = path.join(__dirname, '..', 'scripts', 'county-sample.js');
  const run = (extra) => {
    const env = { ...process.env, ...extra }; for (const k of ['SUDS_DB_PATH', 'NODE_ENV', 'SUDS_ENCRYPTION_KEY', 'SUDS_INDEX_KEY', 'SUDS_SIGNING_KEY']) delete env[k];
    return spawnSync(process.execPath, ['--no-warnings', script, '--register'], { env, encoding: 'utf8', timeout: 60000 });
  };
  try {
    let r = run({ SUDS_ENV: 'production', SUDS_DATA_DIR: path.join(dir, 'prod') });
    assert.equal(r.status, 1); assert.match(r.stderr, /Refusing to add sample county data to a production server/);
    assert.ok(!fs.existsSync(path.join(dir, 'prod')), 'nothing written, not even keys');
    const dev = { SUDS_ENV: 'development', SUDS_DATA_DIR: path.join(dir, 'dev'), SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x', SUDS_ADMIN_USERNAME: 'admin' };
    r = run(dev);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /registered 3 sample program\(s\) and imported 6 file\(s\); added 1 program\(s\) not on SUDS with 2 period\(s\) of figures entered by the county/);
    r = run(dev);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /registered 0 sample program\(s\) and imported 0 file\(s\); added 0 program\(s\) not on SUDS with 0 period\(s\)/, 'run again, it changes nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
