'use strict';
// County-entered figures for grantees not on SUDS (built for 1.20.0; server/county-entry.js, server/routes/county.js;
// docs/COUNTY-VIEW.md "County-entered figures"): registering a programme not on SUDS, entering its figures in the
// form or importing them as the county view's own tidy CSV, validated against the submission allow-list with strict
// numbers and the period rules; stored as county submissions with source 'county_entered', counted by the combined
// view's own rule, superseded, withdrawn and reinstated by the signed files' paths; marked in the combined view, by
// quarter, the Excel, CSV and tidy CSV and the read API, with a switch to leave them out; audited without figures.
//
// Each test stands on its own: freshCounty() starts it from no programmes.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const K = require('../server/county');
const E = require('../server/county-entry');
const SAMPLE = require('../scripts/county-sample');
const { rateLimitReset } = require('../server/app');

let base; let admin; let fin; let sup; let ro; let nav; let COUNTY; let samples;
const Q1 = { from: '2026-01-01', to: '2026-03-31' }; const Q2 = { from: '2026-04-01', to: '2026-06-30' };
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const lastAudit = (action) => { const a = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return a ? { ...a, details: a.details ? JSON.parse(a.details) : null } : null; };
const auditCount = (action) => H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action=?`, action).n;
const text = (file) => JSON.stringify(file, null, 2);

function freshCounty() {
  for (const t of ['county_connect_tokens', 'county_submissions', 'county_programme_keys', 'county_programmes']) H.db.run(`DELETE FROM ${t}`);
}
/** One fund's figures as the form sends them (strings, as typed). `k` scales them. */
function fund(k = 1, extra = {}) {
  const v = (n) => String(Math.round(n * k));
  return { name: 'County settlement share', grant_number: 'OSF-NS-1', category: 'core_h', hiaa: 'hiaa_4', spend_own_category: (1000.5 * k).toFixed(2), spend_other_categories: '0', spend_pending: '25',
    contacts: v(120), naloxone_kits: v(80), fentanyl_strips: v(300), syringes: v(900), reversals: v(3), treatment_admissions: v(2), education_contacts: v(5),
    staff_training_hours: '12.5', referrals_made: v(14), people_served: v(70), people_linked: v(6), moud_linked: v(2), people_trained: v(9), ...extra };
}
const entry = (period = Q1, extra = {}) => ({ ...period, source_ref: 'Q1 report emailed 3 April 2026', funds: [fund()], ...extra });
const notOnSuds = async (name = 'Valley Outreach Collective') => ok(await admin.post('/api/county/programmes', { name, not_on_suds: true, notes: 'Grantee on paper reports' }));
const enter = (pid, body, c = admin) => c.post(`/api/county/programmes/${pid}/entries`, body);
const importCsv = (pid, body, c = admin) => c.post(`/api/county/programmes/${pid}/entries/import`, body);
/** The whole answer (status, headers, data) of a GET that must succeed. */
const got = async (c, path) => { const r = await c.get(path); assert.equal(r.status, 200, typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data)); return r; };
const view = async (from, to, q = '') => ok(await fin.get(`/api/county/view?from=${from}&to=${to}${q}`), 200);
/** A tidy CSV (the county view's long layout) for one programme's funds and period, from `fund()`-shaped figures. */
function tidyCsv(programme, period, funds, { totals = null, header = [...E.CSV_COLUMNS] } = {}) {
  const rows = [header.join(',')];
  for (const f of funds) {
    const own = Number(f.spend_own_category); const other = Number(f.spend_other_categories);
    const line = (code, value) => rows.push([programme, period.from, period.to, f.name, f.grant_number || '', code, 'label', value].join(','));
    line('spend_own_category', own); line('spend_other_categories', other); line('spend_approved', Math.round((own + other) * 100) / 100); line('spend_pending', f.spend_pending);
    for (const k of K.VALUE_KEYS) line(k, f[k]);
  }
  if (totals) for (const [code, value] of Object.entries(totals)) rows.push([programme, period.from, period.to, E.TOTAL_FUND, '', code, 'label', value].join(','));
  return rows.join('\r\n');
}

before(async () => {
  base = await H.start();
  H.db.setSetting('org_name', 'Entry Test County');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['cefin', 'finance'], ['cesup', 'supervisor'], ['cero', 'readonly'], ['cenav', 'navigator']]) H.makeUser(u, role);
  fin = H.client(); await fin.login('cefin', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('cesup', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('cero', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('cenav', 'StaffPassw0rd!x');
  COUNTY = { county_code: K.countyCode().code, county_name: 'Entry Test County' };
  samples = SAMPLE.sample({ periods: [Q1, Q2], recipient: COUNTY });
});
after(async () => { await H.stop(); });
beforeEach(() => { freshCounty(); rateLimitReset('county-connect:127.0.0.1'); rateLimitReset('county-connect-bad:127.0.0.1'); });

// ---------------------------------------------------------------- registering, permissions
test('a program not on SUDS is registered with no key, audited; only county:manage may register, enter or import', async () => {
  const p = await notOnSuds();
  assert.equal(p.on_suds, false); assert.equal(p.fingerprint, null); assert.deepEqual(p.keys, []); assert.equal(p.active, true);
  const a = lastAudit('county.programme.add'); assert.equal(a.entity_id, p.id); assert.equal(a.details.on_suds, false);
  const list = ok(await fin.get('/api/county/programmes'), 200);
  assert.equal(list.rows.find(x => x.id === p.id).on_suds, false);
  assert.equal(list.measures.length, K.VALUE_KEYS.length, 'the Enter figures form\'s outcomes'); assert.ok(!/unduplicated/i.test(JSON.stringify(list.measures)));
  // A name is still required; a programme with a key keeps needing one.
  assert.equal((await admin.post('/api/county/programmes', { name: '  ', not_on_suds: true })).status, 400);
  assert.equal((await admin.post('/api/county/programmes', { name: 'No key given' })).status, 400);
  const e = ok(await enter(p.id, entry()));
  for (const c of [fin, sup, ro, nav]) {
    assert.equal((await c.post('/api/county/programmes', { name: 'X', not_on_suds: true })).status, 403);
    assert.equal((await enter(p.id, entry(), c)).status, 403);
    assert.equal((await importCsv(p.id, { text: 'x', preview: true }, c)).status, 403);
    assert.equal((await c.get(`/api/county/entries/${e.submission.id}`)).status, 403);
  }
  // county:view sees them (finance, supervisors); read-only and navigators do not.
  for (const c of [fin, sup]) assert.equal((await c.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`)).status, 200);
  for (const c of [ro, nav]) assert.equal((await c.get(`/api/county/view?from=${Q1.from}&to=${Q1.to}`)).status, 403);
  assert.equal((await enter('no-such-programme', entry())).status, 404);
  assert.equal((await importCsv('no-such-programme', { text: 'x' })).status, 404);
  assert.equal((await admin.get('/api/county/entries/no-such-entry')).status, 404);
});

// ---------------------------------------------------------------- the form
test('figures entered in the form: stored as a county-entered submission, encrypted, with who, when, how and the source document; audited without figures', async () => {
  const p = await notOnSuds();
  const out = ok(await enter(p.id, entry()));
  assert.equal(out.status, 'entered'); assert.match(out.message, /entered by the county — not signed by the program/);
  const s = out.submission;
  assert.equal(s.source, 'county_entered'); assert.equal(s.entered_via, 'form'); assert.equal(s.status, 'current'); assert.equal(s.key_fingerprint, null);
  const row = H.db.one(`SELECT * FROM county_submissions WHERE id=?`, s.id);
  assert.equal(row.key_id, null); assert.equal(row.signature, null); assert.equal(row.received_by, H.db.one(`SELECT id FROM users WHERE username='admin'`).id);
  assert.ok(row.received_at);
  assert.ok(!row.payload_enc.includes('naloxone') && !row.source_ref_enc.includes('Q1 report'), 'the figures and the source document are encrypted at rest');
  const { decrypt } = require('../server/crypto');
  const pl = JSON.parse(decrypt(row.payload_enc));
  assert.doesNotThrow(() => K.checkPayload(pl), 'the payload is exactly the submission allow-list');
  assert.equal(pl.programme, 'Valley Outreach Collective'); assert.equal(pl.recipient.county_code, COUNTY.county_code); assert.deepEqual(pl.period, Q1);
  assert.equal(pl.funds[0].spend.approved, 1000.5); assert.equal(pl.funds[0].values.naloxone_kits, 80); assert.equal(pl.total.values.staff_training_hours, 12.5);
  assert.equal(pl.categories[0].key, 'core_h'); assert.equal(pl.categories[0].spend_own_category, 1000.5);
  assert.equal(K.sha256Hex(K.canonical(pl)), row.sha256);
  const a = lastAudit('county.entry.create');
  assert.equal(a.entity_id, s.id); assert.equal(a.details.programme_id, p.id); assert.equal(a.details.via, 'form'); assert.equal(a.details.status, 'entered'); assert.equal(a.details.sha256, row.sha256);
  const said = JSON.stringify(a.details);
  for (const figure of ['1000.5', '"80"', 'naloxone', 'Q1 report', 'contacts']) assert.ok(!said.includes(figure), `no figure or typed text in the audit (${figure})`);
  // The listing carries the source document for the county's own staff; the correction form has the figures.
  const listed = ok(await fin.get('/api/county/submissions'), 200).rows.find(x => x.id === s.id);
  assert.equal(listed.source, 'county_entered'); assert.equal(listed.source_ref, 'Q1 report emailed 3 April 2026');
  const form = ok(await admin.get(`/api/county/entries/${s.id}`), 200);
  assert.deepEqual({ from: form.from, to: form.to, source_ref: form.source_ref }, { ...Q1, source_ref: 'Q1 report emailed 3 April 2026' });
  assert.equal(form.funds[0].naloxone_kits, 80); assert.equal(form.funds[0].category, 'core_h');
  assert.equal(lastAudit('county.view').details.what, 'entry');
});

test('validation: strict numbers, the allow-list\'s categories, the period rules and the source document, each said at its field; nothing stored; the refusal audited without the values', async () => {
  const p = await notOnSuds();
  const bad = async (body, field, re) => {
    const r = await enter(p.id, body);
    assert.equal(r.status, 400, JSON.stringify(r.data)); assert.equal(r.data.reason, 'invalid');
    assert.ok(r.data.fields[field], `${field} is named: ${JSON.stringify(r.data.fields)}`); if (re) assert.match(r.data.fields[field], re);
    return r.data;
  };
  for (const [v, re] of [['1,200', /not a whole number/], ['$5', /not a whole number/], ['-1', /not a whole number/], ['1e3', /not a whole number/], ['12.5', /not a whole number/], [' ', /type 0/], ['', /type 0/], ['twelve', /not a whole number/]]) {
    await bad(entry(Q1, { funds: [fund(1, { naloxone_kits: v })] }), 'funds.0.naloxone_kits', re);
  }
  await bad(entry(Q1, { funds: [fund(1, { spend_own_category: '1,000.50' })] }), 'funds.0.spend_own_category', /amount/);
  await bad(entry(Q1, { funds: [fund(1, { spend_pending: '10.555' })] }), 'funds.0.spend_pending', /amount/);
  await bad(entry(Q1, { funds: [fund(1, { staff_training_hours: '1.234' })] }), 'funds.0.staff_training_hours', /hours/);
  await bad(entry(Q1, { funds: [fund(1, { category: 'core_z' })] }), 'funds.0.category', /allowable use/);
  await bad(entry(Q1, { funds: [fund(1, { hiaa: 'hiaa_99' })] }), 'funds.0.hiaa', /High Impact/);
  await bad(entry(Q1, { funds: [fund(1, { name: '   ' })] }), 'funds.0.name', /required/);
  await bad(entry(Q1, { funds: [fund(), fund()] }), 'funds.1.name', /same fund/);
  await bad(entry(Q1, { funds: [fund(1, { name: 'All funds in the submission' })] }), 'funds.0.name', /totals/);
  await bad(entry(Q1, { funds: [] }), 'funds', /at least one/);
  await bad(entry(Q1, { source_ref: 'x' }), 'source_ref', /required/);
  await bad(entry({ from: '2026-02-30', to: '2026-03-31' }), 'from', /real date/);
  await bad(entry({ from: '2026-03-31', to: '2026-01-01' }), 'from', /after the end/);
  const today = require('../server/routes/budget').localDate();
  await bad(entry({ from: '2026-01-01', to: today }), 'to', /not over yet/);
  await bad(entry({ from: '2026-01-01', to: '2099-12-31' }), 'to', /not over yet/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0, 'nothing was stored');
  // A JSON number and one given with its decimals are accepted as they are.
  ok(await enter(p.id, entry(Q1, { funds: [fund(1, { contacts: 12, spend_own_category: 99.5 })] })));
  // Refused: audited with the reason and the fields named, never the values typed.
  await bad(entry(Q2, { funds: [fund(1, { naloxone_kits: '9,876,543' })] }), 'funds.0.naloxone_kits');
  const a = lastAudit('county.entry.refuse');
  assert.equal(a.success, 0); assert.equal(a.details.reason, 'invalid'); assert.equal(a.details.via, 'form'); assert.deepEqual(a.details.fields, ['funds.0.naloxone_kits']);
  assert.ok(!JSON.stringify(a.details).includes('9,876'), 'the value typed is not in the audit');
});

test('a program on SUDS, or an inactive one, gets no entered figures; a connection token is not issued for a program not on SUDS', async () => {
  const signed = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  let r = await enter(signed.id, entry());
  assert.equal(r.status, 409); assert.equal(r.data.reason, 'on_suds'); assert.match(r.data.error, /signs its own files/);
  assert.equal(lastAudit('county.entry.refuse').details.reason, 'on_suds');
  const p = await notOnSuds();
  ok(await admin.put(`/api/county/programmes/${p.id}`, { active: false }), 200);
  r = await enter(p.id, entry());
  assert.equal(r.status, 409); assert.equal(r.data.reason, 'inactive');
  assert.equal((await importCsv(p.id, { text: tidyCsv(p.name, Q1, [fund()]), source_ref: 'Report' })).status, 409);
  ok(await admin.put(`/api/county/programmes/${p.id}`, { active: true }), 200);
  const t = await admin.post('/api/county-connect/tokens', { scope: 'county.submit', programme_id: p.id });
  assert.equal(t.status, 400); assert.match(t.data.error, /not on SUDS/);
  // When it starts running SUDS, the county adds its key: it is then on SUDS, and signs its files from then on.
  const k = ok(await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[2].public_key, compared: true }));
  assert.equal(k.on_suds, true); assert.equal(k.fingerprint, samples[2].fingerprint);
  assert.equal(lastAudit('county.programme.key.replace').details.joined_suds, true);
  assert.equal((await enter(p.id, entry())).status, 409, 'and gets no more entered figures');
});

// ---------------------------------------------------------------- supersede, withdraw, reinstate
test('figures entered again for a period replace the earlier ones (county.entry.update); withdraw and reinstate take the signed files\' paths', async () => {
  const p = await notOnSuds();
  const first = ok(await enter(p.id, entry())).submission;
  const second = ok(await enter(p.id, entry(Q1, { funds: [fund(2)], source_ref: 'Corrected Q1 report' })));
  assert.equal(second.status, 'superseded'); assert.equal(second.replaced, first.id); assert.match(second.message, /replace the figures entered earlier/);
  const a = lastAudit('county.entry.update'); assert.equal(a.entity_id, second.submission.id); assert.equal(a.details.replaces, first.id); assert.equal(a.details.replaces_source, 'county_entered');
  assert.equal(K.summary(K.subById(first.id)).status, 'superseded');
  let d = await view(Q1.from, Q1.to);
  assert.equal(d.rows.find(x => x.key === 'naloxone_kits').by[p.id], 160, 'the later figures count');
  // Withdraw the later ones: the earlier ones count again (resettle), audited as an entry's withdrawal.
  const w = ok(await admin.post(`/api/county/submissions/${second.submission.id}/withdraw`, { reason: 'Typed from the wrong report' }), 200);
  assert.equal(w.restored.id, first.id);
  const wa = lastAudit('county.entry.withdraw'); assert.equal(wa.details.reason, 'Typed from the wrong report'); assert.equal(wa.details.counts_again, first.id);
  assert.equal(lastAudit('county.submission.withdraw'), null, 'not as a signed file\'s');
  d = await view(Q1.from, Q1.to);
  assert.equal(d.rows.find(x => x.key === 'naloxone_kits').by[p.id], 80);
  // Reinstate: it takes its place again by the same rule.
  const re = ok(await admin.post(`/api/county/submissions/${second.submission.id}/reinstate`, {}), 200);
  assert.equal(re.counts, true); assert.equal(lastAudit('county.entry.reinstate').entity_id, second.submission.id);
  assert.equal((await view(Q1.from, Q1.to)).rows.find(x => x.key === 'naloxone_kits').by[p.id], 160);
  // A correction form for a signed file does not exist.
  const signedProg = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  const sf = ok(await admin.post('/api/county/submissions', { text: text(samples[0].files[0].file) }));
  assert.equal((await admin.get(`/api/county/entries/${sf.submission.id}`)).status, 404);
  assert.ok(signedProg.id);
});

test('a programme that joined SUDS: its signed file made later for the period replaces the county\'s figures', async () => {
  const p = await notOnSuds(samples[1].name);
  const e1 = ok(await enter(p.id, entry(Q1))).submission;
  ok(await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[1].public_key, compared: true }));
  const r = ok(await admin.post('/api/county/submissions', { text: text(SAMPLE.sample({ periods: [Q1], recipient: COUNTY, programmes: [SAMPLE.PROGRAMMES[1]] })[0].files[0].file) }));
  // The sample file was made at the end of Q1 (before the county entered its figures today): it is the older one.
  assert.equal(r.status, 'older');
  assert.equal(K.summary(K.subById(e1.id)).status, 'current');
  const d = await view(Q1.from, Q1.to);
  assert.equal(d.programmes.find(x => x.id === p.id).source, 'county_entered');
});

// ---------------------------------------------------------------- the combined view and the switch
test('the combined view counts entered figures by default, marks them, and counts them separately; leaving them out takes exactly them away', async () => {
  const signed = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  ok(await admin.post('/api/county/submissions', { text: text(samples[0].files[0].file) }));
  const p = await notOnSuds();
  ok(await enter(p.id, entry()));
  const empty = await notOnSuds('Hilltop Peer Network'); // not on SUDS, nothing entered for Q1
  const d = await view(Q1.from, Q1.to);
  assert.equal(d.entered, true); assert.equal(d.has_entered, true); assert.equal(d.entered_programmes, 1);
  const col = (id) => d.programmes.find(x => x.id === id);
  assert.equal(col(p.id).source, 'county_entered'); assert.equal(col(p.id).on_suds, false); assert.equal(col(signed.id).source, 'signed'); assert.equal(col(empty.id).source, null);
  assert.equal(col(p.id).submissions[0].source, 'county_entered');
  assert.equal(d.of, 3);
  assert.equal(d.headline, '2 of 3 programs submitted for the whole period, 0 for part of it, 1 not at all. Of the 2 with figures, 1 has figures entered by the county — not signed by the program.');
  assert.match(d.entered_note, /not signed by the program/); assert.equal(d.entered_label, K.ENTERED_LABEL);
  const signedKits = samples[0].files[0].file.payload.total.values.naloxone_kits;
  const kits = d.rows.find(x => x.key === 'naloxone_kits');
  assert.equal(kits.total, signedKits + 80); assert.equal(kits.total_entered, 80); assert.equal(kits.by[p.id], 80);
  const spend = d.rows.find(x => x.key === 'spend_approved');
  assert.equal(spend.total_entered, 1000.5);
  assert.ok(d.rows.find(x => x.group === 'use' && x.key === 'core_h').total_entered > 0, 'by allowable use');
  assert.ok(d.rows.find(x => x.group === 'hiaa' && x.key === 'hiaa_4').total_entered > 0, 'by High Impact Abatement Activity');
  // Left out: every total loses exactly its entered part; the programme not on SUDS is no column; the headline says so.
  const x = await view(Q1.from, Q1.to, '&entered=exclude');
  assert.equal(x.entered, false); assert.equal(x.entered_programmes, 0);
  assert.deepEqual(x.entered_left_out.map(y => y.id), [p.id]);
  assert.ok(!x.programmes.some(y => y.id === p.id || y.id === empty.id), 'programs not on SUDS are no columns');
  assert.equal(x.of, 1);
  assert.equal(x.headline, '1 of 1 program submitted for the whole period, 0 for part of it, 0 not at all. Figures entered by the county are left out (1 program).');
  for (const r of d.rows) {
    const other = x.rows.find(y => y.group === r.group && y.key === r.key);
    const left = other ? other.total : 0;
    assert.ok(Math.abs((r.total - r.total_entered) - left) < 0.001, `${r.group}/${r.key}: ${r.total} - ${r.total_entered} = ${left}`);
    if (other) assert.equal(other.total_entered, 0);
  }
  assert.equal(lastAudit('county.view').details.entered_excluded, true);
  // By quarter: each quarter's total and the part of it entered by the county, with the same switch.
  const q = ok(await fin.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}&by=quarter`), 200);
  const qk = q.rows.find(r => r.key === 'naloxone_kits');
  assert.equal(qk.by_quarter[0], signedKits + 80); assert.equal(qk.by_quarter_entered[0], 80); assert.equal(qk.by_quarter_entered[1], 0);
  assert.equal(q.quarters[0].entered_programmes, 1); assert.match(q.quarters[0].headline, /entered by the county — not signed by the program/);
  const qx = ok(await fin.get(`/api/county/view?from=${Q1.from}&to=${Q2.to}&by=quarter&entered=exclude`), 200);
  assert.equal(qx.rows.find(r => r.key === 'naloxone_kits').by_quarter[0], signedKits); assert.equal(qx.entered, false);
});

test('the toggle\'s math over a programme with both: a signed quarter file and county-entered monthly figures inside it', async () => {
  const p = await notOnSuds(samples[2].name);
  // Entered for January and February, then it joined SUDS and sent its own file for March.
  ok(await enter(p.id, entry({ from: '2026-01-01', to: '2026-01-31' })));
  ok(await enter(p.id, entry({ from: '2026-02-01', to: '2026-02-28' }, { funds: [fund(2)] })));
  ok(await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[2].public_key, compared: true }));
  const march = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[2], { from: '2026-03-01', to: '2026-03-31' }, 1, { recipient: COUNTY });
  ok(await admin.post('/api/county/submissions', { text: text(K.signWithSeed(march, samples[2].seed).file) }));
  const d = await view(Q1.from, Q1.to);
  const c = d.programmes.find(x => x.id === p.id);
  assert.equal(c.source, 'mixed'); assert.equal(c.status, 'whole'); assert.equal(c.submissions.length, 3);
  const kits = d.rows.find(x => x.key === 'naloxone_kits');
  assert.equal(kits.total, 80 + 160 + march.total.values.naloxone_kits); assert.equal(kits.total_entered, 240);
  const x = await view(Q1.from, Q1.to, '&entered=exclude');
  const cx = x.programmes.find(y => y.id === p.id);
  assert.equal(cx.source, 'signed'); assert.equal(cx.status, 'part', 'without the entered months only March is covered');
  assert.equal(x.rows.find(y => y.key === 'naloxone_kits').total, march.total.values.naloxone_kits);
  assert.deepEqual(x.entered_left_out, [{ id: p.id, name: p.name, files: 2 }]);
});

// ---------------------------------------------------------------- files
test('Excel, CSV and tidy CSV mark entered figures, give the total\'s entered part, and follow the switch; the tidy CSV imports back', async () => {
  const signed = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  ok(await admin.post('/api/county/submissions', { text: text(samples[0].files[0].file) }));
  const p = await notOnSuds();
  ok(await enter(p.id, entry()));
  const csv = await got(fin, `/api/county/view/export?from=${Q1.from}&to=${Q1.to}`);
  const head = csv.data.replace(/^﻿/, '').split(/\r?\n/)[0];
  assert.ok(head.includes('Valley Outreach Collective (entered by the county — not signed by the program)'), head);
  assert.ok(head.includes(samples[0].name) && !head.includes(`${samples[0].name} (entered`), 'a signed program is not marked');
  assert.ok(head.endsWith('"Of the total, entered by the county — not signed by the program"') || head.endsWith('Of the total, entered by the county — not signed by the program'), head);
  assert.match(csv.data, /Figures entered by the county,+"?Counted, and marked/);
  assert.equal(lastAudit('county.export').details.entered_programmes, 1);
  const tidy = await got(fin, `/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=tidy`);
  const lines = tidy.data.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines[0], [...E.CSV_COLUMNS, 'source'].join(','));
  const mine = lines.filter(l => l.startsWith('Valley Outreach Collective,'));
  assert.ok(mine.length > 0 && mine.every(l => l.endsWith('entered by the county — not signed by the program')), 'every figure of it says so');
  assert.ok(lines.filter(l => l.startsWith(`${samples[0].name},`)).every(l => l.endsWith(',signed by the program')));
  const x = await fin.raw(`/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=xlsx`);
  const wb = require('../server/spreadsheet').readWorkbook(Buffer.from(await x.arrayBuffer()));
  const sheet = (n) => wb.find(w => w.name === n).rows;
  assert.ok(sheet('Combined')[0].some(c => String(c).includes('(entered by the county — not signed by the program)')), 'the Excel column is marked');
  assert.ok(sheet('Submissions').some(r => r.includes('entered by the county — not signed by the program')), 'and the submission');
  assert.ok(sheet('About').some(r => r[0] === 'Figures entered by the county'));
  // Left out: the file says so in its name, and the program is not in it.
  const xs = await got(fin, `/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=tidy&entered=exclude`);
  assert.match(xs.headers.get('content-disposition'), /-signed-only-internal-exact\.csv/);
  assert.ok(!xs.data.includes('Valley Outreach Collective'));
  // The tidy CSV imports back: the programme's own rows, as the county downloaded them, give the same figures.
  const back = [lines[0], ...mine].join('\r\n');
  const pv = ok(await importCsv(p.id, { text: back, preview: true }), 200);
  assert.equal(pv.preview, true); assert.equal(pv.periods.length, 1); assert.equal(pv.periods[0].totals_given, true);
  assert.equal(pv.periods[0].total.values.naloxone_kits, 80);
  const im = ok(await importCsv(p.id, { text: back, source_ref: 'Re-imported from the county\'s own long CSV', funds: [{ name: 'County settlement share', grant_number: 'OSF-NS-1', category: 'core_h', hiaa: 'hiaa_4' }] }));
  assert.equal(im.entries[0].status_on_entry, 'superseded');
  const before = K.combined(Q1.from, Q1.to); const again = before.rows.find(x => x.key === 'naloxone_kits');
  assert.equal(again.by[p.id], 80); assert.equal(before.rows.find(x => x.key === 'spend_approved').by[p.id], 1000.5);
  assert.ok(signed.id);
});

test('the read API gives a source per program and per figure, the entered part of each total, and follows the switch', async () => {
  const signed = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  ok(await admin.post('/api/county/submissions', { text: text(samples[0].files[0].file) }));
  const p = await notOnSuds();
  ok(await enter(p.id, entry()));
  ok(await admin.put('/api/county-connect/settings', { enabled: true }), 200);
  try {
    const rt = ok(await admin.post('/api/county-connect/tokens', { scope: 'county.read', name: 'Warehouse' }));
    const call = async (path) => { const res = await fetch(base + path, { headers: { Authorization: `Bearer ${rt.token}` } }); const ct = res.headers.get('content-type') || ''; return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() }; };
    const j = ok(await call(`/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}`), 200);
    assert.equal(j.programmes.find(x => x.id === p.id).source, 'county_entered'); assert.equal(j.programmes.find(x => x.id === signed.id).source, 'signed');
    assert.equal(j.programmes.find(x => x.id === p.id).submissions[0].source, 'county_entered');
    assert.equal(j.rows.find(x => x.key === 'naloxone_kits').total_entered, 80);
    assert.equal(j.notes.entered, 'counted'); assert.equal(j.notes.entered_label, K.ENTERED_LABEL); assert.match(j.notes.source, /county_entered/);
    assert.ok(!('entered_note' in j) && j.notes.entered_note);
    const jx = ok(await call(`/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}&entered=exclude`), 200);
    assert.ok(!jx.programmes.some(x => x.id === p.id)); assert.equal(jx.notes.entered, 'left out'); assert.equal(jx.rows.find(x => x.key === 'naloxone_kits').total_entered, 0);
    const csv = await call(`/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}&format=tidy-csv`); assert.equal(csv.status, 200);
    const lines = csv.data.replace(/^﻿/, '').split('\r\n');
    assert.equal(lines[0], 'from,to,programme_id,programme,programme_status,source,group,measure_key,measure,unit,value');
    assert.ok(lines.some(l => l.includes(`,${p.id},Valley Outreach Collective,whole,county_entered,outcome,naloxone_kits,`)));
    assert.ok(lines.some(l => l.includes('"Of the total, entered by the county — not signed by the program",,county_entered,outcome,naloxone_kits,') && l.endsWith(',80')));
    const pr = ok(await call('/api/county-connect/v1/programs'), 200);
    const row = pr.rows.find(x => x.id === p.id);
    assert.equal(row.on_suds, false); assert.equal(row.source, 'county_entered'); assert.equal(row.periods[0].source, 'county_entered'); assert.equal(row.fingerprint, null);
    assert.equal(pr.rows.find(x => x.id === signed.id).periods[0].source, 'signed');
    assert.ok(!JSON.stringify(pr).includes('Q1 report'), 'the source document stays on the county\'s own screens');
  } finally { ok(await admin.put('/api/county-connect/settings', { enabled: false }), 200); }
});

// ---------------------------------------------------------------- the CSV
test('CSV import: preview writes nothing; import enters every period at once with the fund categories chosen, audited without figures', async () => {
  const p = await notOnSuds(); const imports = auditCount('county.entry.import');
  const csv = [tidyCsv(p.name, Q1, [fund(1), fund(1, { name: 'City abatement grant', grant_number: '', category: undefined })]), tidyCsv(p.name, Q2, [fund(2)]).split('\r\n').slice(1).join('\r\n')].join('\r\n');
  const pv = ok(await importCsv(p.id, { text: csv, preview: true }), 200);
  assert.equal(pv.rows, 17 * 3); assert.deepEqual(pv.periods.map(x => [x.from, x.to]), [[Q1.from, Q1.to], [Q2.from, Q2.to]]);
  assert.deepEqual(pv.funds.map(f => f.name), ['County settlement share', 'City abatement grant']);
  assert.equal(pv.periods[0].total.values.naloxone_kits, 160, 'the funds added up when the file gives no totals'); assert.equal(pv.periods[0].totals_given, false);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0, 'the preview wrote nothing');
  assert.equal(auditCount('county.entry.import'), imports, 'and audited no import');
  // Importing needs the source document.
  let r = await importCsv(p.id, { text: csv });
  assert.equal(r.status, 400); assert.ok(r.data.fields.source_ref);
  r = ok(await importCsv(p.id, { text: csv, source_ref: 'Annual report, emailed 1 July 2026', funds: [{ name: 'County settlement share', grant_number: 'OSF-NS-1', category: 'core_h', hiaa: 'hiaa_4' }, { name: 'City abatement grant', grant_number: '', category: 'approved_h', hiaa: 'none' }] }));
  assert.equal(r.entries.length, 2); assert.match(r.message, /for 2 periods, entered by the county — not signed by the program/);
  assert.ok(r.entries.every(e => e.source === 'county_entered' && e.entered_via === 'csv'));
  const { decrypt } = require('../server/crypto');
  const pl = JSON.parse(decrypt(H.db.one(`SELECT payload_enc FROM county_submissions WHERE period_from=?`, Q1.from).payload_enc));
  assert.deepEqual(pl.funds.map(f => [f.name, f.category, f.hiaa]), [['County settlement share', 'core_h', 'hiaa_4'], ['City abatement grant', 'approved_h', null]]);
  assert.deepEqual(pl.categories.map(c => c.key).sort(), ['approved_h', 'core_h']);
  const a = lastAudit('county.entry.import');
  assert.equal(a.entity_id, p.id); assert.equal(a.details.rows, 51); assert.equal(a.details.entries.length, 2); assert.ok(a.details.file_sha256);
  assert.ok(!/naloxone|1000\.5|Annual report/.test(JSON.stringify(a.details)), 'no figures and no typed text in the audit');
});

test('CSV import refusals: header, program, numbers, measures, duplicates, missing figures, totals, periods, shape and size; each row and column named, nothing saved, audited', async () => {
  const p = await notOnSuds();
  const good = tidyCsv(p.name, Q1, [fund()]);
  const refused = async (csvText, re, { status = 422, row = null, column = null } = {}) => {
    const r = await importCsv(p.id, { text: csvText, preview: true });
    assert.equal(r.status, status, JSON.stringify(r.data)); assert.match(JSON.stringify(r.data), re);
    if (row || column) assert.ok(r.data.errors.some(e => (!row || e.row === row) && (!column || e.column === column)), JSON.stringify(r.data.errors));
    return r.data;
  };
  await refused('', /Choose a CSV file/);
  await refused('a,b,c\r\n1,2,3', /first row must name the columns/);
  await refused(good.replace(/^program,/, 'programme,'), /first row must name the columns/);
  await refused(good.replace(/Valley Outreach Collective/g, 'Another Program'), /not Valley Outreach Collective/, { row: 2, column: 'program' });
  await refused(good.replace(',naloxone_kits,label,80', ',naloxone_kits,label,"1,000"'), /not a whole number/, { column: 'value' });
  await refused(good.replace(',naloxone_kits,label,80', ',naloxone_kits,label,-80'), /not a whole number/, { column: 'value' });
  await refused(good.replace(',naloxone_kits,label,80', ',naloxone_kits,label,=1+1'), /not a whole number/, { column: 'value' });
  await refused(good.replace(',naloxone_kits,', ',client_name,'), /not a measure a county submission carries/, { column: 'measure_code' });
  await refused(`${good}\r\n${good.split('\r\n')[5]}`, /given twice/, { column: 'measure_code' });
  await refused(good.split('\r\n').filter(l => !l.includes(',people_served,')).join('\r\n'), /has no people_served/, { column: 'measure_code' });
  await refused(good.replace(/2026-03-31/g, '2099-03-31'), /not over yet/, { column: 'period_to' });
  await refused(good.replace(/2026-01-01/g, '2026-02-30'), /real date/, { column: 'period_from' });
  await refused(good.replace(',spend_approved,label,1000.5', ',spend_approved,label,999'), /is not the spending under its own category/);
  await refused(tidyCsv(p.name, Q1, [fund()], { totals: { spend_approved: 1000.5, spend_pending: 25 } }), /totals .* have no/);
  const totals = { spend_approved: 5, spend_pending: 25, ...Object.fromEntries(K.VALUE_KEYS.map(k => [k, 1])) };
  await refused(tidyCsv(p.name, Q1, [fund()], { totals }), /not the funds' spend_approved added up/);
  await refused(`${good}\r\n"unclosed,quote`, /columns; the header has/);
  await refused(good.replace('County settlement share', ''), /is empty: name the fund/, { column: 'fund' });
  const many = [E.CSV_COLUMNS.join(',')];
  for (let m = 1; m <= 13; m++) { const y = 2024 + Math.floor((m - 1) / 12); const mm = ((m - 1) % 12) + 1; const last = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); many.push(...tidyCsv(p.name, { from: `${y}-${String(mm).padStart(2, '0')}-01`, to: last }, [fund()]).split('\r\n').slice(1)); }
  await refused(many.join('\r\n'), /at most 12/);
  await refused(`${E.CSV_COLUMNS.join(',')}\r\n${'x'.repeat(300 * 1024)}`, /larger than 256 KB/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0, 'nothing was saved');
  const a = lastAudit('county.entry.refuse');
  assert.equal(a.details.reason, 'csv'); assert.equal(a.details.via, 'csv'); assert.equal(a.details.preview, true); assert.ok(a.details.file_sha256); assert.ok(a.details.bytes > 0);
  assert.ok(!/Valley|naloxone/.test(JSON.stringify(a.details)));
  // A cell the spreadsheet guard quoted ('=…) is read back as its text; formulas never become numbers.
  const quoted = good.replace(/County settlement share/g, '"\'=Fund A"');
  const pv = ok(await importCsv(p.id, { text: quoted, preview: true }), 200);
  assert.equal(pv.funds[0].name, '=Fund A');
  // The source column of the county view's own export is accepted.
  const withSource = good.split('\r\n').map((l, i) => `${l},${i ? 'entered by the county — not signed by the program' : 'source'}`).join('\r\n');
  assert.equal((await importCsv(p.id, { text: withSource, preview: true })).status, 200);
});

// ---------------------------------------------------------------- pure
test('strict numbers: digits and one decimal point only, by kind', () => {
  assert.equal(E.strictNumber('1234.50', 'spend_pending'), 1234.5); assert.equal(E.strictNumber('0', 'contacts'), 0); assert.equal(E.strictNumber(7, 'contacts'), 7);
  assert.equal(E.strictNumber(' 12 ', 'contacts'), 12); assert.equal(E.strictNumber('3.25', 'staff_training_hours'), 3.25);
  for (const [v, code] of [['1,234', 'contacts'], ['1.5', 'contacts'], ['$1', 'spend_pending'], ['1.234', 'spend_pending'], ['-0', 'contacts'], ['+1', 'contacts'], ['0x10', 'contacts'], ['1e2', 'contacts'], ['Infinity', 'contacts'], [NaN, 'contacts'], [Infinity, 'contacts'], [null, 'contacts'], [true, 'contacts'], ['1'.repeat(14), 'contacts'], ['١٢', 'contacts']]) {
    assert.throws(() => E.strictNumber(v, code), Error, `${String(v)} (${code})`);
  }
  assert.equal(E.kindOf('spend_own_category'), 'money'); assert.equal(E.kindOf('staff_training_hours'), 'hours'); assert.equal(E.kindOf('people_served'), 'count');
});

test('the source document is declared as an office-only encrypted column, and the routes are office-only', () => {
  const S = require('../server/sync-tables');
  assert.ok(S.unsynced_enc.county_submissions.includes('source_ref_enc'));
  assert.ok(S.server_only.includes('county_submissions'));
  const { LOCAL_ROUTE_MODULES, ROUTE_MODULES } = require('../server/app');
  assert.ok(ROUTE_MODULES.includes('county') && !LOCAL_ROUTE_MODULES.includes('county'), 'SUDS on this device has no county view, entered figures included');
});
