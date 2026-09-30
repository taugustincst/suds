'use strict';
// Award amounts in the county submission file (schema version 2) and the programme's reporting-cadence reminders
// (built for 1.21.0, not yet released; docs/COUNTY-VIEW.md, "Award amounts" and "Reminders on the programme's side").
// One test server plays both sides, as test/county.test.js does: it makes its own files as a programme, and as the
// county imports them beside the sample programmes' (scripts/county-sample.js), version 1 and version 2.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('./helpers');
const K = require('../server/county');
const E = require('../server/county-entry');
const SCH = require('../server/county-schedule');
const SAMPLE = require('../scripts/county-sample');

let admin, fin, nav, ro, sup;
let COUNTY; let fundA; let fundZero;
const Q1 = { from: '2026-01-01', to: '2026-03-31' }; const Q2 = { from: '2026-04-01', to: '2026-06-30' };
const H1 = { from: Q1.from, to: Q2.to };
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const text = (f) => JSON.stringify(f, null, 2);
const lastAudit = (action) => { const a = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return a ? { ...a, details: a.details ? JSON.parse(a.details) : null } : null; };
const seed = (i) => SAMPLE.seedOf(SAMPLE.PROGRAMMES[i].slug);
/** Sample programme i's file for a period, in schema version v. */
const sampleFile = (i, period, v = 2, extra = {}) => K.signWithSeed(SAMPLE.payloadFor(SAMPLE.PROGRAMMES[i], period, 1, { recipient: COUNTY, schemaVersion: v, ...extra }), seed(i));
/** Sign a payload as sample programme i would, however it was changed: tamper tests that the signature alone does not catch. */
const resign = (i, payload, envelopeVersion = payload.schema_version) => ({ format: K.FORMAT, schema_version: envelopeVersion, payload,
  signature: { algorithm: 'Ed25519', key_fingerprint: K.fingerprintOf(crypto.createPublicKey(require('../server/signing').privateKeyFrom(seed(i))).export({ type: 'spki', format: 'pem' })), value: crypto.sign(null, Buffer.from(K.canonical(payload)), require('../server/signing').privateKeyFrom(seed(i))).toString('base64') } });
const importText = (t) => admin.post('/api/county/submissions', { text: t });
function freshCounty() {
  for (const t of ['county_submissions', 'county_programme_keys', 'county_programmes']) H.db.run(`DELETE FROM ${t}`);
  const { rateLimitReset } = require('../server/app');
  rateLimitReset(`county-refuse:${H.db.one(`SELECT id FROM users WHERE username='admin'`).id}`);
}
async function registerSamples(n = 3) {
  const s = SAMPLE.sample({ periods: [Q1], recipient: COUNTY, programmes: SAMPLE.PROGRAMMES.slice(0, n) });
  const out = [];
  for (const x of s) out.push(ok(await admin.post('/api/county/programmes', { name: x.name, public_key: x.public_key, compared: true })));
  return out;
}
const fileUrl = (period, funds, extra = '') => `/api/county-submission/file?from=${period.from}&to=${period.to}&county_code=${COUNTY.county_code}&county_name=${encodeURIComponent(COUNTY.county_name)}&funds=${funds.join(',')}${extra}`;

before(async () => {
  await H.start();
  H.db.setSetting('org_name', 'Award Test Programme');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['awfin', 'finance'], ['awnav', 'navigator'], ['awro', 'readonly'], ['awsup', 'supervisor']]) H.makeUser(u, role);
  fin = H.client(); await fin.login('awfin', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('awnav', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('awro', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('awsup', 'StaffPassw0rd!x');
  fundA = ok(await admin.post('/api/budget/funds', { name: 'Award county share', grant_number: 'AW-1', source_type: 'opioid_settlement', fiscal_year_start: '2025-07-01', fiscal_year_end: '2026-06-30', total_amount: 120000, settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' })).id;
  fundZero = ok(await admin.post('/api/budget/funds', { name: 'Award-less settlement fund', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 0, settlement_use: 'approved_h' })).id;
  const e = ok(await nav.post('/api/budget/expenditures', { funding_source_id: fundA, spent_at: '2026-05-05', amount: 3000, category: 'naloxone_supplies' })).id;
  ok(await sup.post(`/api/budget/expenditures/${e}/approve`, { status: 'approved' }), 200);
  COUNTY = { county_code: K.countyCode().code, county_name: 'Award Test County' };
});
after(async () => { await H.stop(); });

// ---------------------------------------------------------------- the format
test('schema version 2 is frozen: version 1 with each fund\'s award, null or exactly { amount, from, to }', () => {
  assert.equal(K.SCHEMA_VERSION, 2); assert.deepEqual(K.SCHEMA_VERSIONS, [1, 2]);
  assert.deepEqual(K.PAYLOAD_V2, { ...K.PAYLOAD, fund: ['award', 'category', 'grant_number', 'hiaa', 'name', 'spend', 'values'], award: ['amount', 'from', 'to'] });
  assert.deepEqual(K.PAYLOADS, { 1: K.PAYLOAD, 2: K.PAYLOAD_V2 });
  // What the fund record gives becomes an award only when it is one: an amount above 0 and a real period.
  assert.deepEqual(K.awardFrom({ amount: 1000.456, from: '2026-01-01', to: '2026-12-31' }), { amount: 1000.46, from: '2026-01-01', to: '2026-12-31' });
  for (const bad of [null, {}, { amount: 0, from: '2026-01-01', to: '2026-12-31' }, { amount: -5, from: '2026-01-01', to: '2026-12-31' }, { amount: 5, from: '2026-02-30', to: '2026-12-31' },
    { amount: 5, from: '2026-12-31', to: '2026-01-01' }, { amount: 'lots', from: '2026-01-01', to: '2026-12-31' }]) assert.equal(K.awardFrom(bad), null, JSON.stringify(bad));
});

test('the programme makes version 2: each fund\'s award from its record (none for a fund without an amount); version 1 on request; audited with the version', async () => {
  const r = await fin.get(fileUrl(Q2, [fundA, fundZero]));
  const f = ok(r, 200);
  assert.equal(f.schema_version, 2); assert.equal(f.payload.schema_version, 2);
  const byName = Object.fromEntries(f.payload.funds.map(x => [x.name, x]));
  assert.deepEqual(byName['Award county share'].award, { amount: 120000, from: '2025-07-01', to: '2026-06-30' });
  assert.equal(byName['Award-less settlement fund'].award, null, 'no amount recorded: no award, never 0');
  assert.doesNotThrow(() => K.parseFile(text(f)));
  assert.equal(lastAudit('county_submission.export').details.schema_version, 2);
  // For a county still on SUDS 1.20: version 1, with no award anywhere in it.
  const v1 = ok(await fin.get(fileUrl(Q2, [fundA], '&schema_version=1')), 200);
  assert.equal(v1.schema_version, 1); assert.equal(v1.payload.schema_version, 1);
  assert.ok(!JSON.stringify(v1).includes('award'));
  assert.equal(lastAudit('county_submission.export').details.schema_version, 1);
  for (const bad of ['3', '0', 'two', '1.5']) assert.equal((await fin.get(fileUrl(Q2, [fundA], `&schema_version=${bad}`))).status, 400, bad);
  // Who may make it is unchanged.
  for (const c of [nav, ro]) assert.equal((await c.get(fileUrl(Q2, [fundA]))).status, 403);
});

// ---------------------------------------------------------------- the county reads both versions
test('the county imports version 1 and version 2 files side by side; version 1 shows "award not in file"; totals are over the programmes whose files carry the award', async () => {
  freshCounty();
  const [rb, es, hv] = await registerSamples(3);
  ok(await importText(text(sampleFile(0, Q1, 2).file)));
  ok(await importText(text(sampleFile(1, Q1, 1).file)), 201);
  ok(await importText(text(sampleFile(2, Q1, 2).file)));
  const d = ok(await admin.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`), 200);
  const row = (k) => d.rows.find(x => x.key === k);
  const fy = SAMPLE.fiscalYearOf(Q1.from);
  // Riverbend: its county share has a 240,000 award; its city grant none (partial). Hillview: 80,000.
  assert.equal(row('award_amount').by[rb.id], 240000); assert.equal(row('award_amount').by[hv.id], 80000);
  assert.equal(row('award_amount').by[es.id], null); assert.equal(row('award_amount').by_note[es.id], K.AWARD_NOT_IN_FILE);
  assert.equal(row('award_spent_pct').by_note[es.id], 'award not in file');
  assert.equal(d.programmes.find(p => p.id === es.id).award.status, 'not_in_file');
  assert.equal(d.programmes.find(p => p.id === rb.id).award.status, 'partial');
  assert.equal(d.programmes.find(p => p.id === hv.id).award.status, 'whole');
  // Spent against the award: only the funds that carry one (Riverbend's county share, 70% of its spending).
  const rbFile = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1, { recipient: COUNTY });
  const rbSpent = rbFile.funds.find(f => f.award).spend.approved;
  assert.equal(row('award_spent').by[rb.id], rbSpent);
  assert.equal(row('award_spent_pct').by[rb.id], Math.round((rbSpent / 240000) * 1000) / 10);
  // Totals: over Riverbend and Hillview only (not Eastside, whose file is version 1), and said so.
  const hvSpent = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[2], Q1, 1, { recipient: COUNTY }).funds[0].spend.approved;
  assert.equal(row('award_amount').total, 320000); assert.equal(row('award_amount').total_over, 2);
  assert.equal(row('award_spent').total, Math.round((rbSpent + hvSpent) * 100) / 100);
  assert.equal(row('award_spent_pct').total, Math.round(((rbSpent + hvSpent) / 320000) * 1000) / 10);
  assert.equal(row('award_spent_pct').percent, true);
  assert.equal(d.award.programmes_with, 2); assert.equal(d.award.of, 3); assert.match(d.award.note, /over the 2 of 3 programs/);
  assert.ok(fy.from <= Q1.from);
  // The other rows are unchanged by the version: spending adds up across both.
  assert.equal(row('spend_approved').by[es.id], SAMPLE.payloadFor(SAMPLE.PROGRAMMES[1], Q1, 1, { recipient: COUNTY, schemaVersion: 1 }).total.spend.approved);
});

test('an award is counted once however many files carry it: two quarters of one fiscal year are one award, and their spending adds up', async () => {
  freshCounty();
  const [, , hv] = await registerSamples(3);
  ok(await importText(text(sampleFile(2, Q1, 2).file)));
  ok(await importText(text(sampleFile(2, { from: '2025-10-01', to: '2025-12-31' }, 2).file)));
  const d = ok(await admin.get('/api/county/view?from=2025-10-01&to=2026-03-31'), 200);
  const row = (k) => d.rows.find(x => x.key === k);
  assert.equal(row('award_amount').by[hv.id], 80000, 'the same fund, grant number and award period: one award');
  const spent = row('spend_approved').by[hv.id];
  assert.equal(row('award_spent').by[hv.id], spent);
  // By quarter: each quarter on its own; the award rows and how many programmes each total is over.
  const q = ok(await admin.get('/api/county/view?from=2025-10-01&to=2026-03-31&by=quarter'), 200);
  const qa = q.rows.find(x => x.key === 'award_amount');
  assert.deepEqual(qa.by_quarter, [80000, 80000]); assert.deepEqual(qa.by_quarter_over, [1, 1]); assert.match(q.award_note, /each quarter/);
});

test('a programme whose version 2 files carry no award at all is "no award recorded", not "award not in file"; with no award anywhere the totals are empty, never 0', async () => {
  freshCounty();
  const [rb] = await registerSamples(1);
  const p = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[0], Q1, 1, { recipient: COUNTY });
  for (const f of p.funds) f.award = null;
  ok(await importText(text(K.signWithSeed(p, seed(0)).file)));
  const d = ok(await admin.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`), 200);
  const row = d.rows.find(x => x.key === 'award_amount');
  assert.equal(row.by[rb.id], null); assert.equal(row.by_note[rb.id], K.AWARD_NONE); assert.equal(row.total, null); assert.equal(row.total_over, 0);
  assert.equal(d.programmes[0].award.status, 'none');
});

// ---------------------------------------------------------------- tampering
test('tampering with a version 2 file is refused: the award changed, added to version 1, removed from version 2, or the versions mixed', async () => {
  freshCounty();
  await registerSamples(1);
  const good = sampleFile(0, Q1, 2).file;
  const refused = async (file, reason, re) => {
    const r = await importText(typeof file === 'string' ? file : text(file));
    assert.equal(r.status, 422, JSON.stringify(r.data).slice(0, 300)); assert.equal(r.data.reason, reason); if (re) assert.match(r.data.error, re);
  };
  // The award raised after signing: the signature no longer matches.
  { const f = clone(good); f.payload.funds[0].award.amount = 999999; await refused(f, 'signature'); }
  { const f = clone(good); f.payload.funds[0].award.to = '2030-06-30'; await refused(f, 'signature'); }
  { const f = clone(good); f.payload.funds[1].award = { amount: 1, from: '2026-01-01', to: '2026-12-31' }; await refused(f, 'signature'); }
  // The envelope says version 1 but the signed payload is version 2 (or the other way round).
  { const f = clone(good); f.schema_version = 1; await refused(f, 'schema', /version and its signed contents' version differ/); }
  { const v1 = clone(sampleFile(0, Q1, 1).file); v1.schema_version = 2; await refused(v1, 'schema', /differ/); }
  // Signed, but not the shape of its version: an award in a version 1 file; none in a version 2 file; extra keys.
  { const p = clone(good.payload); p.schema_version = 1; await refused(resign(0, p), 'schema', /never carries \(award\)/); }
  { const p = clone(good.payload); delete p.funds[0].award; await refused(resign(0, p), 'schema', /missing award/); }
  { const p = clone(good.payload); p.funds[0].award.note = 'x'; await refused(resign(0, p), 'schema', /never carries/); }
  { const p = clone(good.payload); delete p.funds[0].award.to; await refused(resign(0, p), 'schema', /missing to/); }
  for (const [mutate, re] of [[(a) => { a.amount = 0; }, /more than 0/], [(a) => { a.amount = -1; }, /amount/], [(a) => { a.amount = '100'; }, /amount/], [(a) => { a.amount = 1e13; }, /amount/],
    [(a) => { a.from = '2026-02-30'; }, /real dates/], [(a) => { a.from = '2027-01-01'; }, /starts .* after it ends/], [(a) => { a.to = 20261231; }, /real dates/]]) {
    const p = clone(good.payload); mutate(p.funds[0].award); await refused(resign(0, p), 'schema', re);
  }
  { const p = clone(good.payload); p.funds[0].award = []; await refused(resign(0, p), 'schema'); }
  // A version SUDS does not know.
  { const p = clone(good.payload); p.schema_version = 3; await refused(resign(0, p), 'schema', /reads versions 1 and 2/); }
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0, 'nothing was kept');
  // And the untouched file imports.
  ok(await importText(text(good)));
});

// ---------------------------------------------------------------- the exports
test('the exports: the award rows, "award not in file" for a version 1 programme, the totals note; the long CSV carries each fund\'s award', async () => {
  freshCounty();
  await registerSamples(2);
  ok(await importText(text(sampleFile(0, Q1, 2).file)));
  ok(await importText(text(sampleFile(1, Q1, 1).file)));
  const csv = ok(await fin.get(`/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=csv`), 200);
  assert.match(csv, /Spent against the award \(%\)/); assert.match(csv, /— \(award not in file\)/); assert.match(csv, /Award totals are over the 1 of 2 programs/);
  assert.match(csv, /Award \(total over 1 of 2 programs\)/);
  const tidy = ok(await fin.get(`/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=tidy`), 200);
  const fy = SAMPLE.fiscalYearOf(Q1.from);
  assert.match(tidy, /County settlement share,OSF-RB-1,award_amount,Award or contract amount \(\$\),240000,signed/);
  assert.ok(tidy.includes(`award_from,Award period: first day (YYYY-MM-DD),${fy.from}`)); assert.ok(tidy.includes(`award_to,Award period: last day (YYYY-MM-DD),${fy.to}`));
  assert.ok(!/Eastside[^\n]*award_amount/.test(tidy), 'a version 1 file has no award rows');
  const xlsx = await fin.get(`/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=xlsx`);
  assert.equal(xlsx.status, 200);
});

// ---------------------------------------------------------------- county-entered figures carry the award too
const fund = (over = {}) => ({ name: 'County settlement share', grant_number: 'OSF-9', category: 'core_a', hiaa: 'hiaa_6', spend_own_category: '1000', spend_other_categories: '0', spend_pending: '0', ...Object.fromEntries(K.VALUE_KEYS.map(k => [k, '1'])), ...over });
async function notOnSuds(name = 'Award Mobile Outreach') { return ok(await admin.post('/api/county/programmes', { name, not_on_suds: true })); }

test('county-entered figures carry the award: all three fields or none, checked; the correction form gets it back', async () => {
  freshCounty();
  const p = await notOnSuds();
  const enter = (funds) => admin.post(`/api/county/programmes/${p.id}/entries`, { ...Q1, source_ref: 'Q1 report', funds });
  for (const [over, field, re] of [[{ award_amount: '5000' }, 'funds.0.award_from', /award period's first day/], [{ award_from: '2025-07-01', award_to: '2026-06-30' }, 'funds.0.award_amount', /award or contract amount/],
    [{ award_amount: '5,000', award_from: '2025-07-01', award_to: '2026-06-30' }, 'funds.0.award_amount', /not an amount/], [{ award_amount: '0', award_from: '2025-07-01', award_to: '2026-06-30' }, 'funds.0.award_amount', /more than 0/],
    [{ award_amount: '5000', award_from: '2026-02-30', award_to: '2026-06-30' }, 'funds.0.award_from', /real date/], [{ award_amount: '5000', award_from: '2026-07-01', award_to: '2026-06-30' }, 'funds.0.award_from', /after the award period's last day/]]) {
    const r = await enter([fund(over)]);
    assert.equal(r.status, 400, JSON.stringify(over)); assert.match(r.data.fields[field], re, JSON.stringify(r.data.fields));
  }
  const saved = ok(await enter([fund({ award_amount: '5000.5', award_from: '2025-07-01', award_to: '2026-06-30' }), fund({ name: 'City grant', grant_number: '' })]));
  const pl = JSON.parse(require('../server/crypto').decrypt(H.db.one(`SELECT payload_enc FROM county_submissions WHERE id=?`, saved.submission.id).payload_enc));
  assert.equal(pl.schema_version, 2);
  assert.deepEqual(pl.funds.map(f => f.award), [{ amount: 5000.5, from: '2025-07-01', to: '2026-06-30' }, null]);
  const form = ok(await admin.get(`/api/county/entries/${saved.submission.id}`), 200);
  assert.equal(form.funds[0].award_amount, 5000.5); assert.equal(form.funds[0].award_from, '2025-07-01'); assert.equal(form.funds[1].award_amount, '');
  const d = ok(await admin.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`), 200);
  const row = d.rows.find(x => x.key === 'award_amount');
  assert.equal(row.by[p.id], 5000.5); assert.equal(row.total_entered, 5000.5, 'the part of the total the county entered');
});

test('the long CSV imports each fund\'s award (award_amount, award_from, award_to; empty is none); the per-program template offers the rows', async () => {
  freshCounty();
  const p = await notOnSuds('Award CSV Outreach');
  const rows = (name, grant, award) => [
    ...E.SPEND_CODES.filter(c => c !== 'spend_approved').map(c => [c, c === 'spend_own_category' ? '100' : '0']), ...K.VALUE_KEYS.map(k => [k, '2']),
    ...(award ? [['award_amount', award[0]], ['award_from', award[1]], ['award_to', award[2]]] : [['award_amount', ''], ['award_from', ''], ['award_to', '']]),
  ].map(([c, v]) => `${p.name},${Q1.from},${Q1.to},${name},${grant},${c},x,${v}`);
  const csv = (a1, a2) => [E.CSV_COLUMNS.join(','), ...rows('Share', 'S-1', a1), ...rows('Grant', 'G-2', a2)].join('\r\n');
  const imp = (t, preview = false) => admin.post(`/api/county/programmes/${p.id}/entries/import`, { text: t, source_ref: 'CSV from the program', preview });
  const pv = ok(await imp(csv(['7500', '2025-07-01', '2026-06-30'], null), true), 200);
  assert.deepEqual(pv.periods[0].funds.map(f => f.award), [{ amount: 7500, from: '2025-07-01', to: '2026-06-30' }, null]);
  // A date that is not one, and an award with its period missing: said by row and column; nothing saved.
  let r = await imp(csv(['7500', '2025-07-32', '2026-06-30'], null));
  assert.equal(r.status, 422); assert.ok(r.data.errors.some(e => e.column === 'value' && /award period's first day/.test(e.message)), JSON.stringify(r.data.errors));
  r = await imp([E.CSV_COLUMNS.join(','), ...rows('Share', 'S-1', ['7500', '', ''])].join('\r\n'));
  assert.equal(r.status, 422); assert.match(r.data.error, /award/); assert.ok(r.data.errors.some(e => /award_from/.test(e.column)), JSON.stringify(r.data.errors));
  r = await imp([E.CSV_COLUMNS.join(','), `${p.name},${Q1.from},${Q1.to},All funds in the submission,,award_amount,x,5`, ...rows('Share', 'S-1', null)].join('\r\n'));
  assert.equal(r.status, 422, 'no award on the totals');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0);
  ok(await imp(csv(['7500', '2025-07-01', '2026-06-30'], null)));
  const d = ok(await admin.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`), 200);
  assert.equal(d.rows.find(x => x.key === 'award_amount').by[p.id], 7500);
  // The template: the three award rows per fund, empty.
  const t = ok(await admin.get(`/api/county/programmes/${p.id}/entries/template?from=${Q2.from}&to=${Q2.to}`), 200);
  for (const [code] of E.AWARD_MEASURES) assert.ok(t.split(/\r?\n/).filter(l => l.includes(`,${code},`)).every(l => l.endsWith(',')), code);
  assert.equal(t.split(/\r?\n/).filter(l => /,award_amount,/.test(l)).length, 2, 'one per fund last entered');
  // The county's own long CSV round-trips: exported with the award, it imports with the award.
  const tidy = ok(await admin.get(`/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=tidy`), 200);
  assert.match(tidy, /Share,S-1,award_amount,Award or contract amount \(\$\),7500,county_entered/);
});

// ---------------------------------------------------------------- reminders, the programme's own schedule
test('reminders: finance records a county\'s schedule; the periods due and overdue are listed until the file is made; permissions; audited', async () => {
  H.db.run(`DELETE FROM settings WHERE key IN ('county_submission_made','county_submission_schedules')`);
  const P = require('../server/county-periods');
  const today = require('../server/routes/budget').localDate();
  const [q0, q1] = P.completeQuarters(today, 2);
  const code = K.formatCode(COUNTY.county_code);
  let r = ok(await fin.get('/api/county-submission/reminders'), 200);
  assert.deepEqual(r.counties, []); assert.deepEqual(r.reminders, []);
  for (const c of [nav, ro]) {
    assert.equal((await c.get('/api/county-submission/reminders')).status, 403);
    assert.equal((await c.put(`/api/county-submission/schedules/${code}`, { cadence: 'quarterly_calendar' })).status, 403);
  }
  // Checked: the code, the cadence, the days, the first period.
  for (const [path, body, field] of [['NOTACODE!', { cadence: 'quarterly_calendar' }, 'county_code'], [code, { cadence: 'weekly' }, 'cadence'], [code, { cadence: 'monthly', due_days: 0 }, 'due_days'],
    [code, { cadence: 'monthly', due_days: 181 }, 'due_days'], [code, { cadence: 'monthly', start: '2026-02-30' }, 'start']]) {
    const x = await fin.put(`/api/county-submission/schedules/${encodeURIComponent(path)}`, body);
    assert.equal(x.status, 400, JSON.stringify(body)); assert.ok(x.data.fields[field], JSON.stringify(x.data));
  }
  // By default, reminders start with the last period that has ended: nothing earlier is called missing.
  r = ok(await fin.put(`/api/county-submission/schedules/${code.toLowerCase()}`, { county_name: COUNTY.county_name, cadence: 'quarterly_calendar', due_days: 30 }), 200);
  assert.equal(lastAudit('county_submission.schedule.save').details.county_code, COUNTY.county_code);
  assert.equal(r.counties.length, 1); assert.equal(r.counties[0].source, 'programme'); assert.equal(r.counties[0].start, q0.from);
  assert.deepEqual(r.counties[0].periods.map(p => p.from), [q0.from]);
  assert.equal(r.reminders.length, 1);
  const due = SCH.reminders(today).reminders[0];
  assert.equal(due.due_by, new Date(Date.parse(`${q0.to}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10));
  assert.match(due.text, /^County file to Award Test County for .* due by .* — not yet made$/);
  // From an earlier start: the quarter before is listed too, and overdue once its due date has passed.
  r = ok(await fin.put(`/api/county-submission/schedules/${code}`, { county_name: COUNTY.county_name, cadence: 'quarterly_calendar', due_days: 1, start: q1.from }), 200);
  assert.deepEqual(r.counties[0].periods.map(p => [p.from, p.state]), [[q1.from, 'overdue'], [q0.from, q0.to < CCtoday(-1) ? 'overdue' : 'due']]);
  // Made (downloaded here): done. A file for another county's code does not count for this one.
  ok(await fin.get(`/api/county-submission/file?from=${q1.from}&to=${q1.to}&county_code=SAMP-1E00&county_name=Other&funds=${fundA}`), 200);
  r = ok(await fin.get('/api/county-submission/reminders'), 200);
  assert.equal(r.counties[0].periods.find(p => p.from === q1.from).state, 'overdue');
  ok(await fin.get(fileUrl(q1, [fundA])), 200);
  r = ok(await fin.get('/api/county-submission/reminders'), 200);
  const made = r.counties[0].periods.find(p => p.from === q1.from);
  assert.equal(made.state, 'made'); assert.equal(made.done, true); assert.equal(made.made.via, 'download'); assert.equal(made.made.schema_version, 2);
  assert.ok(!r.reminders.some(x => x.from === q1.from));
  // Nothing in the record but the county code, the period, the file's hash and version, and how it was made.
  const rec = JSON.parse(H.db.getSetting('county_submission_made'));
  assert.deepEqual(Object.keys(rec[0]).sort(), ['at', 'county_code', 'from', 'schema_version', 'sha256', 'to', 'via']);
  // Removed: nothing reminded. An unknown code is 404.
  assert.equal((await nav.del(`/api/county-submission/schedules/${code}`)).status, 403);
  r = ok(await fin.del(`/api/county-submission/schedules/${code}`), 200);
  assert.deepEqual(r.reminders, []); assert.equal(lastAudit('county_submission.schedule.remove').details.county_code, COUNTY.county_code);
  assert.equal((await fin.del(`/api/county-submission/schedules/${code}`)).status, 404);
});
const CCtoday = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
