'use strict';
// County-entered figures for grantees not on SUDS (released in 1.20.0; server/county-entry.js, server/routes/county.js;
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
/** The refusal throttle on entries (routes/county.js throttle) put back to nothing, for tests that refuse many on purpose. */
function unthrottle() { for (const u of H.db.all(`SELECT id FROM users`)) for (const b of ['county-entry-refuse', 'county-entry-refuse-throttle-audit']) rateLimitReset(`${b}:${u.id}`); }
beforeEach(() => { freshCounty(); unthrottle(); rateLimitReset('county-connect:127.0.0.1'); rateLimitReset('county-connect-bad:127.0.0.1'); });

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
  // The listing carries the source document for those who enter and correct figures (county:manage) only; someone
  // who may only view (finance, supervisors) sees that the figures were entered, not the document (D3).
  const listed = ok(await admin.get('/api/county/submissions'), 200).rows.find(x => x.id === s.id);
  assert.equal(listed.source, 'county_entered'); assert.equal(listed.source_ref, 'Q1 report emailed 3 April 2026');
  assert.equal(listed.programme_on_suds, false);
  for (const c of [fin, sup]) {
    const seen = ok(await c.get('/api/county/submissions'), 200);
    const row = seen.rows.find(x => x.id === s.id);
    assert.equal(row.source, 'county_entered'); assert.ok(!('source_ref' in row), 'no source document for county:view alone');
    assert.ok(!JSON.stringify(seen).includes('Q1 report'));
  }
  const form = ok(await admin.get(`/api/county/entries/${s.id}`), 200);
  assert.deepEqual({ from: form.from, to: form.to, source_ref: form.source_ref }, { ...Q1, source_ref: 'Q1 report emailed 3 April 2026' });
  assert.equal(form.funds[0].naloxone_kits, 80); assert.equal(form.funds[0].category, 'core_h');
  assert.equal(lastAudit('county.view').details.what, 'entry');
});

test('validation: strict numbers, the allow-list\'s categories, the period rules and the source document, each said at its field; nothing stored; the refusal audited without the values', async () => {
  const p = await notOnSuds();
  const bad = async (body, field, re) => {
    unthrottle();
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

test('D1: a programme that joined SUDS: its signed file for the period replaces the county\'s figures, even one made before them', async () => {
  const p = await notOnSuds(samples[1].name);
  const e1 = ok(await enter(p.id, entry(Q1))).submission;
  ok(await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[1].public_key, compared: true }));
  const r = ok(await admin.post('/api/county/submissions', { text: text(SAMPLE.sample({ periods: [Q1], recipient: COUNTY, programmes: [SAMPLE.PROGRAMMES[1]] })[0].files[0].file) }));
  // The sample file was made at the end of Q1, before the county entered its figures today: a signed file outranks
  // county-entered figures whatever either's generated_at, so it counts and the entered figures are replaced.
  assert.equal(r.status, 'superseded'); assert.equal(r.replaced, e1.id);
  assert.match(r.message, /signed file outranks figures the county entered/);
  assert.ok(Date.parse(K.subById(r.submission.id).generated_at) < Date.parse(K.subById(e1.id).generated_at), 'the signed file was made before the entry');
  assert.equal(K.summary(K.subById(e1.id)).status, 'superseded');
  let d = await view(Q1.from, Q1.to);
  assert.equal(d.programmes.find(x => x.id === p.id).source, 'signed');
  // Withdraw the signed file: the entered figures count again; reinstate it: it outranks them again.
  const w = ok(await admin.post(`/api/county/submissions/${r.submission.id}/withdraw`, { reason: 'Checking the file' }), 200);
  assert.equal(w.restored.id, e1.id);
  assert.equal((await view(Q1.from, Q1.to)).programmes.find(x => x.id === p.id).source, 'county_entered');
  // Withdraw the entered figures too, reinstate the signed file (it counts), then the entered figures: they are
  // reinstated as replaced, and the message says a signed file outranks them.
  ok(await admin.post(`/api/county/submissions/${e1.id}/withdraw`, { reason: 'Checking the entry' }), 200);
  const re = ok(await admin.post(`/api/county/submissions/${r.submission.id}/reinstate`, {}), 200);
  assert.equal(re.counts, true);
  const re2 = ok(await admin.post(`/api/county/submissions/${e1.id}/reinstate`, {}), 200);
  assert.equal(re2.counts, false); assert.match(re2.message, /a signed file outranks figures the county entered/);
  assert.equal(K.summary(K.subById(e1.id)).status, 'superseded');
  d = await view(Q1.from, Q1.to);
  assert.equal(d.programmes.find(x => x.id === p.id).source, 'signed');
});

test('D1: in a period, a signed file always counts where it overlaps county-entered figures; the entered ones are left out, "a signed file covers this"', async () => {
  const p = await notOnSuds(samples[2].name);
  const quarter = ok(await enter(p.id, entry(Q1))).submission; // entered for the whole quarter
  ok(await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[2].public_key, compared: true }));
  const jan = SAMPLE.payloadFor(SAMPLE.PROGRAMMES[2], { from: '2026-01-01', to: '2026-01-31' }, 1, { recipient: COUNTY });
  const sj = ok(await admin.post('/api/county/submissions', { text: text(K.signWithSeed(jan, samples[2].seed).file) }));
  assert.equal(sj.status, 'imported', 'a different period: nothing is superseded');
  const d = await view(Q1.from, Q1.to);
  const c = d.programmes.find(x => x.id === p.id);
  // Before D1 the longer entered quarter counted and pushed the signed month out; now the signed month counts.
  assert.deepEqual(c.submissions.map(x => x.id), [sj.submission.id]);
  assert.equal(c.source, 'signed'); assert.equal(c.status, 'part');
  const lo = c.left_out.find(x => x.id === quarter.id);
  assert.equal(lo.why, 'signed_covers'); assert.equal(lo.reason, 'a signed file covers this');
  assert.equal(d.rows.find(x => x.key === 'naloxone_kits').by[p.id], jan.total.values.naloxone_kits);
  assert.equal(d.rows.find(x => x.key === 'naloxone_kits').total_entered, 0);
  // The files say the same.
  const x = await fin.raw(`/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=xlsx`);
  const wb = require('../server/spreadsheet').readWorkbook(Buffer.from(await x.arrayBuffer()));
  assert.ok(wb.find(w => w.name === 'Submissions').rows.some(r => r.includes('Left out: a signed file covers this')));
  // Pure: two entered rows still follow the length rule between themselves; a signed row is never left out for an entered one.
  const row = (id, from, to, source, rec = '2026-04-01') => ({ id, period_from: from, period_to: to, source, received_at: rec });
  const ch = K.choose([row('eq', Q1.from, Q1.to, 'county_entered'), row('ej', '2026-01-01', '2026-01-31', 'county_entered'), row('sf', '2026-02-01', '2026-02-28', 'signed')], Q1.from, Q1.to);
  assert.deepEqual(ch.used.map(s => s.id), ['ej', 'sf']);
  assert.deepEqual(ch.covered.map(s => s.id), ['eq']); assert.deepEqual(ch.overlapped, []);
  const ch2 = K.choose([row('eq', Q1.from, Q1.to, 'county_entered'), row('ej', '2026-01-01', '2026-01-31', 'county_entered')], Q1.from, Q1.to);
  assert.deepEqual(ch2.used.map(s => s.id), ['eq']); assert.deepEqual(ch2.overlapped.map(s => s.id), ['ej']);
});

test('D2: the county connection\'s status counts only signed files as received; entered figures never take a period off the outstanding list', async () => {
  const p = await notOnSuds(samples[1].name);
  const e1 = ok(await enter(p.id, entry(Q1))).submission;
  ok(await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[1].public_key, compared: true }));
  ok(await admin.put('/api/county-connect/settings', { enabled: true }), 200);
  try {
    const t = ok(await admin.post('/api/county-connect/tokens', { scope: 'county.submit', programme_id: p.id }));
    const status = async () => { const res = await fetch(base + '/api/county-connect/v1/status', { headers: { Authorization: `Bearer ${t.token}` } }); assert.equal(res.status, 200); return res.json(); };
    let st = await status();
    const q1 = st.expected.find(x => x.from === Q1.from && x.to === Q1.to);
    assert.ok(q1, JSON.stringify(st.expected));
    assert.equal(q1.received, false, 'entered figures are not a file the programme sent'); assert.equal(q1.coverage, 'none');
    assert.ok(st.outstanding.some(x => x.from === Q1.from && x.to === Q1.to), 'Q1 is still outstanding');
    const got1 = st.received.find(x => x.sha256 === K.subById(e1.id).sha256);
    assert.equal(got1.source, 'county_entered', 'the entered figures are listed, marked');
    // Its signed file for Q1 makes Q1 received.
    ok(await admin.post('/api/county/submissions', { text: text(SAMPLE.sample({ periods: [Q1], recipient: COUNTY, programmes: [SAMPLE.PROGRAMMES[1]] })[0].files[0].file) }));
    st = await status();
    assert.equal(st.expected.find(x => x.from === Q1.from).received, true);
    assert.ok(!st.outstanding.some(x => x.from === Q1.from && x.to === Q1.to));
    assert.ok(st.received.every(x => ['signed', 'county_entered'].includes(x.source)));
    assert.equal(st.received.find(x => x.status === 'current').source, 'signed');
  } finally { ok(await admin.put('/api/county-connect/settings', { enabled: false }), 200); }
});

test('D4: two programmes of one name are refused, whatever the case or spacing, on registering either kind and on renaming', async () => {
  const p = await notOnSuds('Valley Outreach Collective');
  let r = await admin.post('/api/county/programmes', { name: '  valley OUTREACH collective ', public_key: samples[0].public_key, compared: true });
  assert.equal(r.status, 409); assert.equal(r.data.reason, 'duplicate_name'); assert.ok(r.data.fields.name); assert.match(r.data.error, /already registered/);
  r = await admin.post('/api/county/programmes', { name: 'VALLEY OUTREACH COLLECTIVE', not_on_suds: true });
  assert.equal(r.status, 409);
  const other = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  r = await admin.put(`/api/county/programmes/${other.id}`, { name: 'Valley outreach collective' });
  assert.equal(r.status, 409); assert.equal(H.db.one(`SELECT name FROM county_programmes WHERE id=?`, other.id).name, samples[0].name);
  // Renaming a programme to its own name in another case is its own business.
  assert.equal(ok(await admin.put(`/api/county/programmes/${p.id}`, { name: 'Valley Outreach collective' }), 200).name, 'Valley Outreach collective');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_programmes`).n, 2);
});

test('D5: after a programme joins SUDS its entered figures can be withdrawn and reinstated, not corrected or added to', async () => {
  const p = await notOnSuds();
  const e1 = ok(await enter(p.id, entry(Q1))).submission;
  ok(await admin.post(`/api/county/programmes/${p.id}/keys`, { public_key: samples[2].public_key, compared: true }));
  assert.equal((await enter(p.id, entry(Q1, { source_ref: 'A correction' }))).status, 409, 'no correction: a new entry is refused');
  assert.equal((await importCsv(p.id, { text: tidyCsv(p.name, Q2, [fund()]), source_ref: 'Report', funds: [] })).status, 409);
  assert.equal((await admin.get(`/api/county/programmes/${p.id}/entries/template?from=${Q2.from}&to=${Q2.to}`)).status, 409);
  const listed = ok(await admin.get('/api/county/submissions'), 200).rows.find(x => x.id === e1.id);
  assert.equal(listed.programme_on_suds, true, 'the list says so, so the page offers no Correct');
  ok(await admin.post(`/api/county/submissions/${e1.id}/withdraw`, { reason: 'Superseded by its own report' }), 200);
  assert.equal(K.summary(K.subById(e1.id)).status, 'withdrawn');
  const re = ok(await admin.post(`/api/county/submissions/${e1.id}/reinstate`, {}), 200);
  assert.equal(re.counts, true);
  assert.equal(lastAudit('county.entry.reinstate').entity_id, e1.id);
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
  assert.equal(lines[0], [...E.CSV_COLUMNS, 'source', 'source_label'].join(','));
  const mine = lines.filter(l => l.startsWith('Valley Outreach Collective,'));
  // The source column is a code, as the read API gives it; source_label says it in words.
  assert.ok(mine.length > 0 && mine.every(l => l.endsWith(',county_entered,entered by the county — not signed by the program')), 'every figure of it says so');
  assert.ok(lines.filter(l => l.startsWith(`${samples[0].name},`)).every(l => l.endsWith(',signed,signed by the program')));
  const x = await fin.raw(`/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=xlsx`);
  const wb = require('../server/spreadsheet').readWorkbook(Buffer.from(await x.arrayBuffer()));
  const sheet = (n) => wb.find(w => w.name === n).rows;
  assert.ok(sheet('Combined')[0].some(c => String(c).includes('(entered by the county — not signed by the program)')), 'the Excel column is marked');
  assert.ok(sheet('Submissions').some(r => r.includes('entered by the county — not signed by the program')), 'and the submission');
  assert.ok(sheet('About').some(r => r[0] === 'Figures entered by the county'));
  assert.ok(sheet('About').some(r => r[0] === 'Source (long CSV and Tidy sheet)' && /"county_entered"/.test(r[1])), 'the About sheet explains the source codes');
  // The Report line names both sources when entered figures are in the file (and only then: below).
  assert.match(sheet('About').find(r => r[0] === 'Report')[1], /signed submissions, and figures entered by the county — not signed by the program$/);
  // Left out: the file says so in its name, and the program is not in it.
  const xs = await got(fin, `/api/county/view/export?from=${Q1.from}&to=${Q1.to}&format=tidy&entered=exclude`);
  assert.match(xs.headers.get('content-disposition'), /-signed-only-internal-exact\.csv/);
  assert.ok(!xs.data.includes('Valley Outreach Collective'));
  const xo = await got(fin, `/api/county/view/export?from=${Q1.from}&to=${Q1.to}&entered=exclude`);
  const report = xo.data.replace(/^﻿/, '').split(/\r?\n/).find(l => l.startsWith('About,Report,'));
  assert.ok(report && /signed submissions"?$/.test(report) && !/entered/.test(report), `left out, the Report line names signed submissions alone: ${report}`);
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
    unthrottle();
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

test('CSV import reads only this program\'s rows: another program\'s are never imported, and said in one line', async () => {
  const p = await notOnSuds();
  const signed = ok(await admin.post('/api/county/programmes', { name: samples[0].name, public_key: samples[0].public_key, compared: true }));
  const mineCsv = tidyCsv(p.name, Q1, [fund()]);
  const theirs = tidyCsv(signed.name, Q1, [fund(3)]).split('\r\n').slice(1);
  const both = [mineCsv, ...theirs].join('\r\n');
  const pv = ok(await importCsv(p.id, { text: both, preview: true }), 200);
  assert.equal(pv.rows, 17, 'only this program\'s rows are read');
  assert.deepEqual(pv.others, [{ name: signed.name, rows: 17 }]);
  assert.ok(pv.warnings.some(w => /17 rows for other programs \(.+\) were not read/.test(w)), JSON.stringify(pv.warnings));
  const im = ok(await importCsv(p.id, { text: both, source_ref: 'Mixed file', funds: [{ name: 'County settlement share', grant_number: 'OSF-NS-1', category: 'core_h', hiaa: 'hiaa_4' }] }));
  assert.equal(im.entries.length, 1); assert.match(im.message, /17 rows for other programs/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions WHERE programme_id=?`, signed.id).n, 0, 'nothing of the other program');
  assert.equal(lastAudit('county.entry.import').details.other_rows, 17);
  // A file with no row for this program is refused, naming whose rows it has.
  const r = await importCsv(p.id, { text: [E.CSV_COLUMNS.join(','), ...theirs].join('\r\n'), preview: true });
  assert.equal(r.status, 422); assert.match(r.data.error, new RegExp(`no rows for ${p.name}: its rows are for ${signed.name}`));
});

test('CSV import: a figure that is not a number is one problem, not also "has no" that figure; the message says it once', async () => {
  const p = await notOnSuds();
  const r = await importCsv(p.id, { text: tidyCsv(p.name, Q1, [fund()]).replace(',naloxone_kits,label,80', ',naloxone_kits,label,9x'), preview: true });
  assert.equal(r.status, 422);
  assert.deepEqual(r.data.errors.map(e => e.column), ['value'], JSON.stringify(r.data.errors));
  assert.ok(!/has no/.test(JSON.stringify(r.data)));
  assert.equal(r.data.error, 'The file has 1 problem. Nothing was saved.');
  assert.ok(!/not imported/i.test(r.data.error), 'the page adds nothing that says it twice');
});

test('CSV source column: codes or words; a row that says signed is warned about in the preview; anything else is refused at the cell', async () => {
  const p = await notOnSuds();
  const withSource = (v) => tidyCsv(p.name, Q1, [fund()]).split('\r\n').map((l, i) => `${l},${i ? v : 'source'}`).join('\r\n');
  const pe = ok(await importCsv(p.id, { text: withSource('county_entered'), preview: true }), 200);
  assert.deepEqual(pe.warnings, []);
  for (const v of ['signed', 'signed by the program']) {
    const pv = ok(await importCsv(p.id, { text: withSource(v), preview: true }), 200);
    assert.ok(pv.warnings.some(w => /17 rows say "signed" in the source column\. Once imported, these figures are entered by the county — not signed by the program/.test(w)), JSON.stringify(pv.warnings));
  }
  const two = tidyCsv(p.name, Q1, [fund()]).split('\r\n').map((l, i) => `${l},${i ? 'county_entered,entered by the county — not signed by the program' : 'source,source_label'}`).join('\r\n');
  ok(await importCsv(p.id, { text: two, preview: true }), 200);
  const bad = await importCsv(p.id, { text: withSource('trusted'), preview: true });
  assert.equal(bad.status, 422); assert.ok(bad.data.errors.some(e => e.column === 'source' && /must be signed or county_entered/.test(e.message)));
});

test('a template of the long CSV for one program not on SUDS: its funds and the period, values empty; county:manage; audited', async () => {
  const p = await notOnSuds();
  let t = await got(admin, `/api/county/programmes/${p.id}/entries/template?from=${Q2.from}&to=${Q2.to}`);
  let lines = t.data.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines[0], E.CSV_COLUMNS.join(','));
  assert.equal(lines.length, 1 + 4 + K.VALUE_KEYS.length + E.AWARD_MEASURES.length, 'one fund to name when it has none (its award rows too, optional)');
  assert.ok(lines.slice(1).every(l => l.startsWith(`${p.name},${Q2.from},${Q2.to},,,`) && l.endsWith(',')), lines[1]);
  assert.match(t.headers.get('content-disposition'), /suds-county-entry-template-.*-2026-04-01_2026-06-30\.csv/);
  ok(await enter(p.id, entry(Q1, { funds: [fund(), fund(1, { name: 'City abatement grant', grant_number: 'CAG-2' })] })));
  t = await got(admin, `/api/county/programmes/${p.id}/entries/template?from=${Q2.from}&to=${Q2.to}`);
  lines = t.data.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines.length, 1 + 2 * (4 + K.VALUE_KEYS.length + E.AWARD_MEASURES.length));
  assert.ok(lines.some(l => l.startsWith(`${p.name},${Q2.from},${Q2.to},City abatement grant,CAG-2,naloxone_kits,`)));
  assert.ok(!/1000\.5|,80\b/.test(t.data), 'no figure of the earlier entry is in it');
  assert.equal(lastAudit('county.entry.template').entity_id, p.id);
  // Filled in, it imports.
  // The award rows are optional: left empty, the fund has no award.
  const filled = lines.map((l, i) => (i ? `${l}${/,award_/.test(l) ? '' : /,spend_approved,/.test(l) ? '10' : /,spend_own_category,/.test(l) ? '10' : '0'}` : l)).join('\r\n');
  ok(await importCsv(p.id, { text: filled, preview: true }), 200);
  for (const c of [fin, sup, ro, nav]) assert.equal((await c.get(`/api/county/programmes/${p.id}/entries/template?from=${Q2.from}&to=${Q2.to}`)).status, 403);
  assert.equal((await admin.get(`/api/county/programmes/${p.id}/entries/template?from=2026-02-30&to=${Q2.to}`)).status, 400);
  assert.equal((await admin.get(`/api/county/programmes/no-such/entries/template?from=${Q2.from}&to=${Q2.to}`)).status, 404);
});

test('refused entries are throttled per person, as refused files are: the 21st in ten minutes is refused unread, audited once', async () => {
  const p = await notOnSuds();
  const before = auditCount('county.entry.throttled');
  for (let i = 0; i < 20; i++) assert.equal((i % 2 ? await enter(p.id, entry(Q1, { source_ref: 'x' })) : await importCsv(p.id, { text: 'a,b', preview: true })).status, i % 2 ? 400 : 422);
  let r = await enter(p.id, entry());
  assert.equal(r.status, 429, 'even a good entry waits'); assert.match(r.data.error, /Too many entries were refused/);
  r = await importCsv(p.id, { text: tidyCsv(p.name, Q1, [fund()]), preview: true });
  assert.equal(r.status, 429);
  assert.equal(auditCount('county.entry.throttled') - before, 1, 'audited once per window');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM county_submissions`).n, 0);
  // Ten minutes later (the count put back), a good entry is saved.
  unthrottle();
  ok(await enter(p.id, entry()));
});

test('entered= takes include or exclude only: anything else is refused, on the view, its files and the read API', async () => {
  const p = await notOnSuds();
  ok(await enter(p.id, entry()));
  for (const q of ['entered=Exclude', 'entered=no', 'entered=', 'entered=exclude%20']) {
    for (const path of [`/api/county/view?from=${Q1.from}&to=${Q1.to}&${q}`, `/api/county/view?from=${Q1.from}&to=${Q2.to}&by=quarter&${q}`, `/api/county/view/export?from=${Q1.from}&to=${Q1.to}&${q}`]) {
      const r = await fin.get(path); assert.equal(r.status, 400, `${path}: ${r.status}`);
    }
  }
  assert.equal((await view(Q1.from, Q1.to, '&entered=include')).entered, true);
  ok(await admin.put('/api/county-connect/settings', { enabled: true }), 200);
  try {
    const rt = ok(await admin.post('/api/county-connect/tokens', { scope: 'county.read', name: 'Warehouse' }));
    const call = (q) => fetch(`${base}/api/county-connect/v1/combined?from=${Q1.from}&to=${Q1.to}&${q}`, { headers: { Authorization: `Bearer ${rt.token}` } });
    assert.equal((await call('entered=nope')).status, 400);
    assert.equal((await call('entered=include')).status, 200);
  } finally { ok(await admin.put('/api/county-connect/settings', { enabled: false }), 200); }
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
