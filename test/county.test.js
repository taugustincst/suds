'use strict';
// The county view (server/county.js, server/routes/county.js; docs/COUNTY-VIEW.md): a programme's signed county
// submission file (Send to the county, on the Settlement outcomes page), and a county's server registering the
// programmes' keys, importing their files and combining them for a period. One test server plays both: it makes
// its own file as a programme would and, as a county, registers its own key beside three sample programmes'
// (scripts/county-sample.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('./helpers');
const K = require('../server/county');
const SAMPLE = require('../scripts/county-sample');

let admin, fin, sup, ro, nav, clin, thr;
const Q1 = { from: '2026-01-01', to: '2026-03-31' }; const Q2 = { from: '2026-04-01', to: '2026-06-30' };
let samples; let ownFile; let ownText;
const lastAudit = (action) => { const a = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return a ? { ...a, details: a.details ? JSON.parse(a.details) : null } : null; };
const auditCount = (action) => H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action=?`, action).n;
const text = (file) => JSON.stringify(file, null, 2);

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
  // The programme's own settlement work in Q2: a fund, kits handed to a named client, a reversal.
  const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
  const fund = ok(await admin.post('/api/budget/funds', { name: 'Test county settlement share', grant_number: 'OSF-T-1', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 90000, settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' })).id;
  const e = ok(await nav.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-05-05', amount: 1234.5, category: 'naloxone_supplies' })).id;
  ok(await sup.post(`/api/budget/expenditures/${e}/approve`, { status: 'approved' }), 200);
  const c = ok(await sup.post('/api/clients', { first_name: 'Zebedee', last_name: 'Countyfile', dob: '1980-04-04', confirm_duplicate: true })).id;
  for (let i = 0; i < 3; i++) ok(await sup.post('/api/interventions', { client_id: c, type: 'naloxone_distribution', occurred_at: `2026-05-1${i}T18:00:00.000Z`, naloxone_kits: 2, funding_source_id: fund }));
  ok(await sup.post('/api/overdose-events', { occurred_at: '2026-05-20T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 1, survived: true, funding_source_id: fund }));
  samples = SAMPLE.sample({ periods: [Q1, Q2] });
});
after(async () => { await H.stop(); });

// ---------------------------------------------------------------- pure: canonical form, keys, signatures
test('the canonical serialisation sorts keys at every depth, keeps array order and has no whitespace', () => {
  const a = { b: 1, a: [3, { z: 'x', y: null }], c: { e: true, d: 1.5 } };
  const b = { c: { d: 1.5, e: true }, a: [3, { y: null, z: 'x' }], b: 1 };
  const want = '{"a":[3,{"y":null,"z":"x"}],"b":1,"c":{"d":1.5,"e":true}}';
  assert.equal(K.canonical(a), want); assert.equal(K.canonical(b), want);
  assert.equal(K.canonical({ 'é': 'ü', 'A': '"' }), '{"A":"\\"","é":"ü"}', 'keys by code unit; strings as JSON writes them');
  assert.throws(() => K.canonical({ x: Infinity }), /finite/); assert.throws(() => K.canonical({ x: undefined }), /not a JSON value/);
  // The same payload signed twice gives the same bytes, hash and (Ed25519 is deterministic) signature.
  const p = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1);
  const s1 = K.signWithSeed(p, SAMPLE.seedOf('x')); const s2 = K.signWithSeed(JSON.parse(JSON.stringify(p)), SAMPLE.seedOf('x'));
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
  const p = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1);
  assert.doesNotThrow(() => K.checkPayload(JSON.parse(JSON.stringify(p))));
  for (const mutate of [(x) => { x.client_code = 'M26-0001'; }, (x) => { x.funds[0].participant_code = 'P-1'; }, (x) => { x.total.values.dob = 0; }, (x) => { x.categories[0].rows = []; }, (x) => { x.funds[0].spend.names = 1; }, (x) => { delete x.total.values.reversals; }]) {
    const q = JSON.parse(JSON.stringify(p)); mutate(q);
    assert.throws(() => K.checkPayload(q), (e) => e instanceof K.SubmissionError && e.code === 'schema');
  }
});

// ---------------------------------------------------------------- the programme's side
test('Send to the county: the key is made on first use, its private half encrypted; finance makes a signed file', async () => {
  assert.equal((await fin.get('/api/county-submission/key')).data.key, null, 'no key until one is asked for');
  const r = await fin.get(`/api/county-submission/file?from=${Q2.from}&to=${Q2.to}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get('content-disposition'), /suds-county-submission-2026-04-01_2026-06-30\.json/);
  ownText = typeof r.data === 'string' ? r.data : JSON.stringify(r.data); ownFile = JSON.parse(ownText);
  const row = H.db.one(`SELECT * FROM county_signing_keys`);
  assert.ok(row && row.private_key_enc && !/^[0-9a-f]{64}$/.test(row.private_key_enc), 'stored encrypted');
  const seed = Buffer.from(require('../server/crypto').decrypt(row.private_key_enc), 'hex');
  assert.equal(seed.length, 32);
  const pem = crypto.createPublicKey(require('../server/signing').privateKeyFrom(seed)).export({ type: 'spki', format: 'pem' });
  assert.equal(pem, row.public_key, 'the stored public key is the private key\'s');
  assert.equal(ownFile.signature.key_fingerprint, row.fingerprint);
  assert.equal(ownFile.format, 'suds-county-submission'); assert.equal(ownFile.schema_version, 1);
  const k = (await fin.get('/api/county-submission/key')).data.key;
  assert.equal(k.fingerprint, row.fingerprint); assert.match(k.public_key, /BEGIN PUBLIC KEY/);
  assert.ok(!('private_key_enc' in k));
  // The signature verifies with the public key alone, over the canonical payload.
  assert.ok(crypto.verify(null, Buffer.from(K.canonical(ownFile.payload)), crypto.createPublicKey(k.public_key), Buffer.from(ownFile.signature.value, 'base64')));
  // The figures are the Settlement outcomes page's, exact.
  const p = ownFile.payload;
  assert.deepEqual(p.period, Q2); assert.equal(p.programme, 'Test Harm Reduction Programme'); assert.equal(p.counts, 'exact');
  assert.equal(p.total.values.naloxone_kits, 6); assert.equal(p.total.values.reversals, 1); assert.equal(p.total.values.people_served, 1, 'exact: a count of 1 is not suppressed');
  assert.equal(p.total.spend.approved, 1234.5);
  assert.equal(p.funds.length, 1); assert.equal(p.funds[0].category, 'core_a'); assert.equal(p.funds[0].hiaa, 'hiaa_6');
  const so = await fin.get(`/api/reports/settlement-outcomes?from=${Q2.from}&to=${Q2.to}&counts=exact`);
  for (const key of K.VALUE_KEYS) assert.equal(p.total.values[key], so.data.total.values[key], `${key} is the settlement outcomes page's figure`);
  // Audited as leaving the programme, with what identifies the file and not its figures.
  const a = lastAudit('county_submission.export');
  assert.deepEqual(Object.keys(a.details).sort(), ['content', 'fingerprint', 'from', 'funds', 'leaves_programme', 'sha256', 'to']);
  assert.equal(a.details.sha256, crypto.createHash('sha256').update(K.canonical(p)).digest('hex'));
  assert.equal(a.details.fingerprint, row.fingerprint);
  assert.ok(lastAudit('county_submission.key.create'));
});

test('the file carries no client, client code, name or date of birth: every key is on the allow-list', () => {
  const allowed = new Set([...K.PAYLOAD.top, ...K.PAYLOAD.period, ...K.PAYLOAD.fund, ...K.PAYLOAD.fundSpend, ...K.PAYLOAD.category, ...K.PAYLOAD.total, ...K.PAYLOAD.totalSpend, ...K.PAYLOAD.values]);
  const keys = new Set(); const strings = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } else if (typeof v === 'string') strings.push(v); };
  walk(ownFile.payload);
  for (const k of keys) assert.ok(allowed.has(k), `${k} is on the allow-list`);
  for (const bad of ['client', 'client_id', 'client_code', 'participant_code', 'first_name', 'last_name', 'dob', 'occurred_at', 'id']) assert.ok(!keys.has(bad), `no ${bad}`);
  const code = H.db.one(`SELECT client_code FROM clients LIMIT 1`).client_code;
  for (const s of strings) for (const bad of ['Zebedee', 'Countyfile', '1980-04-04', code]) assert.ok(!s.includes(bad), `"${s}" names nobody`);
  assert.ok(!ownText.includes('Zebedee') && !ownText.includes(code));
});

test('who may make the file: whoever files the funder submission; not a navigator, clinician or read-only', async () => {
  assert.equal((await admin.get(`/api/county-submission/file?from=${Q2.from}&to=${Q2.to}`)).status, 200);
  assert.equal((await sup.get(`/api/county-submission/file?from=${Q2.from}&to=${Q2.to}`)).status, 200);
  for (const c of [nav, clin, ro]) {
    assert.equal((await c.get(`/api/county-submission/file?from=${Q2.from}&to=${Q2.to}`)).status, 403);
    assert.equal((await c.get('/api/county-submission/key')).status, 403);
    assert.equal((await c.post('/api/county-submission/key', {})).status, 403);
  }
  assert.equal((await fin.post('/api/county-submission/key', {})).status, 200, 'the key already exists');
  const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  assert.equal((await fin.get(`/api/county-submission/file?from=2026-01-01&to=${future}`)).status, 400, 'a period that has not ended yet');
  assert.equal((await fin.get('/api/county-submission/file?from=2026-06-01&to=2026-05-01')).status, 400, 'from after to');
  assert.equal((await fin.get('/api/county-submission/file')).status, 400, 'no period');
});

// ---------------------------------------------------------------- the county's side
const register = async (c, name, pem, extra = {}) => c.post('/api/county/programmes', { name, public_key: pem, ...extra });
const importFile = async (c, t) => c.post('/api/county/submissions', { text: t });

test('permissions: administrators manage; finance and supervisors view; read-only, navigators and clinicians neither', async () => {
  const auth = require('../server/auth'); const P = require('../server/permissions');
  for (const role of ['admin']) { assert.ok(auth.hasPerm({ role }, 'county:view')); assert.ok(auth.hasPerm({ role }, 'county:manage')); }
  for (const role of ['finance', 'supervisor']) { assert.ok(auth.hasPerm({ role }, 'county:view'), role); assert.ok(!auth.hasPerm({ role }, 'county:manage'), role); }
  for (const role of ['readonly', 'navigator', 'clinician']) for (const p of ['county:view', 'county:manage']) assert.ok(!auth.hasPerm({ role }, p), `${role} ${p}`);
  for (const p of ['county:view', 'county:manage']) assert.ok(P.PERMISSION_CATALOG.some(x => x.name === p), `${p} is in the catalogue the permissions page lists`);
  assert.equal(P.PERMISSION_CATALOG.find(x => x.name === 'county:manage').risk, 'sensitive');
  assert.match(P.grantProblem('readonly', auth.rolePerms('readonly'), 'county:view') || '', /exact aggregate counts/);
  assert.match(P.grantProblem('navigator', auth.rolePerms('navigator'), 'county:manage') || '', /exact aggregate counts/);
  assert.equal(P.grantProblem('finance', auth.rolePerms('finance'), 'county:manage'), null, 'finance may be granted county:manage');
  const roId = H.db.one(`SELECT id FROM users WHERE username='coro'`).id;
  const roGrant = await admin.post(`/api/users/${roId}/permissions`, { permission: 'county:view', mode: 'grant', reason: 'County settlement reporting lead for the pilot' });
  assert.equal(roGrant.status, 400, 'a grant to read-only is refused'); assert.match(roGrant.data.error, /exact aggregate counts/);
  // Over HTTP, before anything is registered.
  assert.equal((await fin.get('/api/county/programmes')).status, 200);
  assert.equal((await sup.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}`)).status, 200);
  assert.equal((await fin.post('/api/county/programmes', { name: 'x', public_key: samples[0].public_key })).status, 403, 'finance cannot register');
  assert.equal((await fin.post('/api/county/submissions', { text: '{}' })).status, 403, 'nor import');
  assert.equal((await fin.post('/api/county/fingerprint', { public_key: samples[0].public_key })).status, 403);
  for (const c of [ro, nav, clin]) {
    for (const p of ['/api/county/programmes', '/api/county/submissions', `/api/county/view?from=${Q1.from}&to=${Q2.to}`, `/api/county/view/export?from=${Q1.from}&to=${Q2.to}`]) assert.equal((await c.get(p)).status, 403, p);
    assert.equal((await c.post('/api/county/submissions', { text: '{}' })).status, 403);
  }
  const denied = lastAudit('authz.denied'); assert.ok(denied);
  // A finance account granted county:manage may then register.
  const finId = H.db.one(`SELECT id FROM users WHERE username='cofin'`).id;
  assert.equal((await admin.post(`/api/users/${finId}/permissions`, { permission: 'county:manage', mode: 'grant', reason: 'County settlement reporting lead for the pilot' })).status, 200);
  assert.equal((await fin.post('/api/county/fingerprint', { public_key: samples[0].public_key })).status, 200);
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, finId);
});

test('registering a programme: its fingerprint is shown to compare, a mismatch is refused, a key is registered once', async () => {
  const f = await admin.post('/api/county/fingerprint', { public_key: samples[0].public_key });
  assert.equal(f.data.fingerprint, samples[0].fingerprint); assert.equal(f.data.fingerprint_display, samples[0].fingerprint_display); assert.equal(f.data.registered_as, null);
  assert.equal((await register(admin, samples[0].name, samples[0].public_key, { fingerprint: '0000 0000 0000 0000 0000 0000 0000 0000' })).status, 400, 'a fingerprint that does not match the key');
  assert.equal((await register(admin, samples[0].name, 'not a key')).status, 400);
  const r = await register(admin, samples[0].name, samples[0].public_key, { fingerprint: samples[0].fingerprint_display.toUpperCase(), notes: 'Contract 2026-17' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.fingerprint, samples[0].fingerprint); assert.equal(r.data.active, true);
  assert.equal((await register(admin, 'Another name', samples[0].public_key)).status, 409, 'the same key twice');
  assert.equal(lastAudit('county.programme.add').details.fingerprint, samples[0].fingerprint);
  for (const s of samples.slice(1)) assert.equal((await register(admin, s.name, s.public_key)).status, 201);
  const list = await fin.get('/api/county/programmes');
  assert.equal(list.data.rows.length, 3); assert.ok(lastAudit('county.view'));
});

test('import: a good file is imported; the same file again changes nothing; a second for the period supersedes', async () => {
  const s = samples[0];
  const r = await importFile(admin, text(s.files[0].file));
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.status, 'imported');
  assert.equal(r.data.submission.period_from, Q1.from); assert.equal(r.data.submission.programme, s.name);
  const a = lastAudit('county.submission.import');
  assert.equal(a.details.sha256, s.files[0].sha256); assert.ok(!('values' in a.details) && !('total' in a.details) && !JSON.stringify(a.details).includes('naloxone'), 'no figures in the audit');
  const stored = H.db.one(`SELECT * FROM county_submissions WHERE id=?`, r.data.submission.id);
  assert.ok(!stored.payload_enc.includes('naloxone'), 'the payload is encrypted at rest');
  assert.equal(require('../server/crypto').decrypt(stored.payload_enc), K.canonical(s.files[0].file.payload));
  // The same file: a no-op.
  const again = await importFile(admin, text(s.files[0].file));
  assert.equal(again.status, 200); assert.equal(again.data.status, 'duplicate');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions WHERE programme_id=?`, stored.programme_id).n, 1);
  // A corrected file for the same period supersedes the first, which is kept.
  const corrected = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1.5);
  const c = K.signWithSeed(corrected, s.seed);
  const sup2 = await importFile(admin, text(c.file));
  assert.equal(sup2.status, 201); assert.equal(sup2.data.status, 'superseded'); assert.equal(sup2.data.replaced, r.data.submission.id);
  const old = H.db.one(`SELECT * FROM county_submissions WHERE id=?`, r.data.submission.id);
  assert.equal(old.superseded_by, sup2.data.submission.id);
  assert.equal(lastAudit('county.submission.import').details.superseded, r.data.submission.id);
  const listed = (await fin.get('/api/county/submissions')).data.rows;
  assert.deepEqual(listed.map(x => x.status).sort(), ['current', 'superseded']);
  assert.ok(listed.every(x => !('payload_enc' in x) && !('payload' in x)), 'the list carries no figures');
  // Put the original back as current for the totals test: withdraw the correction.
  const w = await admin.post(`/api/county/submissions/${sup2.data.submission.id}/withdraw`, { reason: 'test' });
  assert.equal(w.status, 200); assert.equal(w.data.status, 'withdrawn');
  assert.equal((await admin.post(`/api/county/submissions/${sup2.data.submission.id}/withdraw`, {})).status, 409);
  assert.equal((await fin.post(`/api/county/submissions/${r.data.submission.id}/withdraw`, {})).status, 403);
  assert.ok(lastAudit('county.submission.withdraw'));
  H.db.run(`UPDATE county_submissions SET superseded_by=NULL WHERE id=?`, r.data.submission.id);
});

test('refusals: each is refused with a reason, audited without figures, and nothing is stored', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n;
  const good = samples[1].files[0].file;
  const refusedWith = async (t, reason, status = 422) => {
    const r = await importFile(admin, t);
    assert.equal(r.status, status, `${reason}: ${JSON.stringify(r.data)}`); assert.equal(r.data.reason, reason); assert.ok(r.data.error && r.data.error.length > 20, 'a sentence saying why');
    const a = lastAudit('county.submission.refuse');
    assert.equal(a.details.reason, reason); assert.equal(a.success, 0);
    assert.deepEqual(Object.keys(a.details).sort(), ['bytes', 'file_sha256', 'reason']);
  };
  // A tampered payload: one figure changed after signing.
  const tampered = JSON.parse(text(good)); tampered.payload.total.values.naloxone_kits += 1;
  await refusedWith(text(tampered), 'signature');
  // Signed with another key but claiming a registered programme's fingerprint.
  const forged = K.signWithSeed(good.payload, SAMPLE.seedOf('someone-else')).file; forged.signature.key_fingerprint = samples[1].fingerprint;
  await refusedWith(text(forged), 'signature');
  // A key the county has not registered.
  await refusedWith(text(K.signWithSeed(good.payload, SAMPLE.seedOf('unregistered')).file), 'unknown_key');
  // An inactive programme.
  const pid = H.db.one(`SELECT id FROM county_programmes WHERE fingerprint=?`, samples[2].fingerprint).id;
  assert.equal((await admin.put(`/api/county/programmes/${pid}`, { active: false })).status, 200);
  assert.ok(lastAudit('county.programme.deactivate'));
  await refusedWith(text(samples[2].files[0].file), 'inactive');
  assert.equal((await admin.put(`/api/county/programmes/${pid}`, { active: true, notes: 'reactivated' })).status, 200);
  assert.ok(lastAudit('county.programme.update'));
  // Not JSON; not a submission; a field it never carries.
  await refusedWith('{"format": "suds-county-submission", ', 'malformed');
  await refusedWith(JSON.stringify({ hello: 'world' }), 'format');
  const extra = JSON.parse(text(good)); extra.payload.funds[0].client_code = 'M26-0001';
  await refusedWith(text(extra), 'schema');
  await refusedWith('', 'malformed');
  // Too large.
  await refusedWith(JSON.stringify({ ...good, padding: 'x'.repeat(K.MAX_FILE_BYTES) }), 'too_large', 413);
  // A period in the future, and one that ends before it starts (each signed properly, so only the period is wrong).
  const future = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  await refusedWith(text(K.signWithSeed({ ...good.payload, period: { from: '2026-01-01', to: future } }, samples[1].seed).file), 'period');
  const backwards = { ...good.payload, period: { from: '2026-03-31', to: '2026-01-01' } };
  const bw = K.signWithSeed.bind(null); assert.throws(() => bw(backwards, samples[1].seed), /starts/);
  const b = JSON.parse(text(good)); b.payload.period = { from: '2026-03-31', to: '2026-01-01' };
  await refusedWith(text(b), 'period');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, before, 'nothing was stored');
});

test('refusals are throttled per person', async () => {
  let last;
  for (let i = 0; i < 22; i++) last = await importFile(thr, 'not json');
  assert.equal(last.status, 429);
  assert.equal((await importFile(thr, text(samples[1].files[0].file))).status, 429, 'even a good file, until the window passes');
  assert.equal((await importFile(admin, text(samples[1].files[0].file))).status, 201, 'another person is not held up');
});

test('the combined view: per programme and in total, with who has and has not submitted', async () => {
  // Riverbend Q1 (imported above), Eastside Q1 (the throttle test's last import), Hillview: nothing yet for Q1.
  const own = H.db.one(`SELECT public_key FROM county_signing_keys`).public_key;
  assert.equal((await register(admin, 'Test Harm Reduction Programme', own)).status, 201, 'this server\'s own key, as a county registers a programme');
  assert.equal((await importFile(admin, ownText)).status, 201, 'the programme\'s own file (Q2) imports');
  const r = await fin.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  const byName = Object.fromEntries(d.programmes.map(p => [p.name, p]));
  assert.equal(byName[samples[0].name].status, 'whole'); assert.equal(byName[samples[1].name].status, 'whole');
  assert.equal(byName[samples[2].name].status, 'none', 'Hillview has not submitted for Q1');
  assert.equal(byName['Test Harm Reduction Programme'].status, 'none', 'its Q2 file is outside Q1');
  assert.equal(d.submitted, 2); assert.equal(d.not_submitted, 2);
  const kits = d.rows.find(x => x.key === 'naloxone_kits');
  const want = samples[0].files[0].file.payload.total.values.naloxone_kits + samples[1].files[0].file.payload.total.values.naloxone_kits;
  assert.equal(kits.total, want); assert.equal(kits.by[byName[samples[2].name].id], 0);
  assert.ok(d.caveats.some(c => /not unduplicated/.test(c))); assert.match(d.publication_note, /publication screen over the combined release \(planned\)/);
  assert.ok(byName[samples[0].name].submissions[0].received_at && byName[samples[0].name].fingerprint_display);
  // All three sample programmes and this one, both quarters: the totals are the sum of every file.
  for (const s of samples) for (const f of s.files) { const x = await importFile(admin, text(f.file)); assert.ok([200, 201].includes(x.status), JSON.stringify(x.data)); }
  const all = (await sup.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}`)).data;
  const files = [...samples.flatMap(s => s.files.map(f => f.file.payload)), ownFile.payload];
  for (const k of K.VALUE_KEYS) {
    const row = all.rows.find(x => x.key === k);
    const expect = files.reduce((n, p) => n + p.total.values[k], 0);
    assert.ok(Math.abs(row.total - expect) < 1e-6, `${k}: ${row.total} = ${expect}`);
    assert.ok(Math.abs(Object.values(row.by).reduce((a, b) => a + b, 0) - row.total) < 1e-6, `${k}: the programmes add up to the total`);
  }
  const spent = all.rows.find(x => x.key === 'spend_approved');
  assert.ok(Math.abs(spent.total - files.reduce((n, p) => n + p.total.spend.approved, 0)) < 0.01);
  const coreA = all.rows.find(x => x.group === 'use' && x.key === 'core_a');
  assert.ok(Math.abs(coreA.total - files.reduce((n, p) => n + p.categories.filter(c => c.key === 'core_a').reduce((t, c) => t + c.spend_own_category, 0), 0)) < 0.01);
  assert.ok(all.rows.some(x => x.group === 'hiaa' && x.key === 'hiaa_6'));
  assert.equal(all.submitted, 4); assert.equal(all.not_submitted, 0);
  const a = lastAudit('county.view'); assert.equal(a.details.what, 'combined'); assert.ok(!JSON.stringify(a.details).includes('naloxone'));
});

test('the period rule: only submissions wholly inside the period count; a longer one wins over one inside it', async () => {
  const s = samples[2];
  // A January-only file for Hillview, inside its Q1 file.
  const jan = K.signWithSeed(SAMPLE.payloadFor(SAMPLE.PROGRAMMES[2], { from: '2026-01-01', to: '2026-01-31' }, 0.2), s.seed);
  assert.equal((await importFile(admin, text(jan.file))).status, 201);
  const id = H.db.one(`SELECT id FROM county_programmes WHERE fingerprint=?`, s.fingerprint).id;
  // Q1: the quarter counts, January (overlapping it) is left out.
  const q1 = (await fin.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`)).data.programmes.find(p => p.id === id);
  assert.deepEqual(q1.submissions.map(x => x.period_to), ['2026-03-31']);
  assert.deepEqual(q1.left_out.map(x => [x.period_to, x.why]), [['2026-01-31', 'overlaps']]);
  // January alone: only the January file lies inside; the quarter is outside (not pro-rated).
  const j = (await fin.get('/api/county/view?from=2026-01-01&to=2026-01-31')).data;
  const jp = j.programmes.find(p => p.id === id);
  assert.deepEqual(jp.submissions.map(x => x.period_to), ['2026-01-31']); assert.equal(jp.status, 'whole');
  assert.ok(jp.left_out.some(x => x.why === 'outside' && x.period_to === '2026-03-31'));
  assert.equal(j.rows.find(x => x.key === 'naloxone_kits').by[id], jan.file.payload.total.values.naloxone_kits);
  const r0 = j.programmes.find(p => p.name === samples[0].name); assert.equal(r0.status, 'none', 'a quarter is never cut down to a month');
  // February to May: no quarter lies inside; nothing counts, nothing is pro-rated.
  const fm = (await fin.get('/api/county/view?from=2026-02-01&to=2026-05-31')).data;
  assert.equal(fm.submitted, 0); assert.equal(fm.rows.find(x => x.key === 'naloxone_kits').total, 0);
  // Q1 and Q2 together: both quarters count, the programme covers the whole half year.
  const h1 = (await fin.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}`)).data.programmes.find(p => p.id === id);
  assert.equal(h1.submissions.length, 2); assert.equal(h1.status, 'whole');
  // Part of a period: the half year plus July.
  const h1j = (await fin.get(`/api/county/view?from=${Q1.from}&to=2026-07-31`)).data.programmes.find(p => p.id === id);
  assert.equal(h1j.status, 'part');
  assert.equal((await fin.get('/api/county/view?from=2026-05-01&to=2026-04-01')).status, 400);
});

test('the combined view as Excel and CSV: labelled internal and exact, audited', async () => {
  const csv = await fin.get(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /suds-county-view-2026-01-01_2026-06-30-internal-exact\.csv/);
  assert.equal(csv.headers.get('x-suds-report-counts'), 'exact');
  assert.match(csv.data, /Internal — exact counts/); assert.match(csv.data, /not unduplicated/); assert.match(csv.data, /publication screen over the combined release \(planned\)/);
  for (const s of samples) assert.ok(csv.data.includes(s.name));
  const x = await fin.raw(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}&format=xlsx`);
  assert.equal(x.status, 200); const buf = Buffer.from(await x.arrayBuffer()); assert.equal(buf.slice(0, 2).toString(), 'PK');
  const a = lastAudit('county.export'); assert.equal(a.details.format, 'xlsx'); assert.ok(!JSON.stringify(a.details).includes('naloxone'));
  // export:read is needed as well as county:view.
  const supId = H.db.one(`SELECT id FROM users WHERE username='cosup'`).id; H.deny({ id: supId }, 'export:read');
  assert.equal((await sup.get(`/api/county/view/export?from=${Q1.from}&to=${Q2.to}`)).status, 403);
  assert.equal((await sup.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}`)).status, 200);
});

test('the navigation learns how many programmes this server takes county submissions from', async () => {
  const me = await fin.get('/api/auth/me');
  assert.equal(me.data.programme.county_programmes, 4);
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
  for (const t of ['county_signing_keys', 'county_programmes', 'county_submissions']) { assert.ok(S.server_only.includes(t), t); assert.ok(!S.tables.some(x => x.name === t), t); }
  assert.deepEqual(S.unsynced_enc.county_signing_keys, ['private_key_enc']); assert.deepEqual(S.unsynced_enc.county_submissions, ['payload_enc']);
});
