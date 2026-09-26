'use strict';
// The funder report at a realistic size: the same answers as before it was made fast (a golden file written
// by the earlier implementation over a deterministic synthetic programme, test/fixtures/funder-scale.js),
// and the per-run choices a small programme needs — small-cell suppression on for anything that will be
// published or shared, exact counts for its own submission to its funder — plus the funding-attribution
// gaps the report now shows instead of hiding (visits with no fund; staff hours logged but not approved).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const config = require('../server/config');
const scale = require('./fixtures/funder-scale');

const GOLDEN = path.join(__dirname, 'fixtures', 'funder-golden.json');
let admin, sup, fin, nav, ro, fx;

before(async () => {
  await H.start();
  fx = scale.seed(H.db, { clients: 3000, visits: 15000, calls: 3000, notes: 0, seedValue: 7 });
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['frsup', 'supervisor'], ['frfin', 'finance'], ['frnav', 'navigator'], ['frro', 'readonly']]) H.makeUser(u, role);
  sup = H.client(); await sup.login('frsup', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('frfin', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('frnav', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('frro', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

// What the earlier implementation returned, and only that: fields added since are left out, fund ids are
// random per run (names are not), and rows that tie on their count may come back in either order. The golden
// answers are exact counts (the programme's own submission): how small cells are suppressed for publication
// is tested on its own below, so a change to suppression is not a change to what the report counts. A
// report filtered to one fund shows that fund's row only. An event of kind "reversal" counts as
// a naloxone reversal whether or not its box was ticked (the fixture has such rows), which moved the reversal
// figures and nothing else.
const FUND_KEYS = ['name', 'grant_number', 'fiscal_year_start', 'fiscal_year_end', 'clients_served', 'services', 'approved_minutes'];
const sortRows = (rows) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function normalise(d) {
  const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
  return {
    from: d.from, to: d.to, small_cell_threshold: d.small_cell_threshold,
    unduplicated: d.unduplicated,
    demographics: Object.fromEntries(Object.entries(d.demographics).map(([k, rows]) => [k, sortRows(rows)])),
    episodes: { ...d.episodes, by_discharge_reason: sortRows(d.episodes.by_discharge_reason) },
    overdose: { ...d.overdose, by_administered_by: sortRows(d.overdose.by_administered_by) },
    naloxone_distribution: d.naloxone_distribution,
    by_funding_source: d.by_funding_source.filter(f => f.id && (!d.funding_source_id || f.id === d.funding_source_id)).map(f => pick(f, FUND_KEYS)),
  };
}
const EXACT = '&purpose=submission&counts=exact';
const CASES = [
  ['fiscal year', 'from=2025-07-01&to=2026-06-30'],
  ['a quarter', 'from=2026-01-01&to=2026-03-31'],
  ['one day', 'from=2026-02-14&to=2026-02-14'],
  ['one fund', 'from=2025-07-01&to=2026-06-30&funding_source_id={F0}'],
];
async function runCases() {
  const out = {};
  for (const [name, q] of CASES) {
    const r = await admin.get(`/api/reports/funder?${q.replace('{F0}', fx.funds[0])}${EXACT}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    out[name] = normalise(r.data);
  }
  // Report days are local days: the same fiscal year in Los Angeles moves visits across the boundaries.
  const was = config.orgTimezone; config.orgTimezone = 'America/Los_Angeles';
  try { out['fiscal year, Los Angeles'] = normalise((await admin.get(`/api/reports/funder?from=2025-07-01&to=2026-06-30${EXACT}`)).data); }
  finally { config.orgTimezone = was; }
  const d = (await admin.get('/api/reports/dashboard?from=2025-07-01&to=2026-06-30')).data;
  out.dashboard = { interventions: { total: d.interventions.total, minutes: d.interventions.minutes, naloxone_kits: d.interventions.naloxone_kits }, calls: { total: d.calls.total }, referrals: { total: d.referrals.total } };
  return out;
}

test('the funder report gives the same answers as the implementation it replaced', async () => {
  const now = await runCases();
  if (process.env.SUDS_WRITE_GOLDEN === '1') { fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n'); return; }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  for (const k of Object.keys(golden)) assert.deepStrictEqual(now[k], golden[k], `${k} differs from the golden report`);
});

test('the report period predicate is sargable: it reads the date index, not the whole table', () => {
  const { range } = require('../server/routes/reports');
  const p = range({ query: new URLSearchParams('from=2026-01-01&to=2026-03-31') });
  const plan = H.db.all(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM interventions i WHERE ${p.ts('i.occurred_at')}`, ...p.tsP).map(x => x.detail).join('\n');
  assert.match(plan, /USING (COVERING )?INDEX idx_interventions_period/, plan);
  assert.doesNotMatch(plan, /^SCAN i$/m, plan);
  // One range scan, not two merged row by row (the earlier OR of two ranges): the cost that dominated.
  assert.doesNotMatch(plan, /MULTI-INDEX OR/, plan);
});

// ---- small-cell suppression, per run ----
test('small cells are suppressed by default and the report says which mode it used', async () => {
  const r = await sup.get('/api/reports/funder?from=2026-02-14&to=2026-02-14');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.suppression, { mode: 'suppressed', threshold: 11, purpose: 'publication' });
  assert.ok(Object.values(r.data.demographics).flat().some(x => x.n === '<11'), 'a one-day report has small cells');
});

test('exact counts: only for the programme\'s own submission, and only supervisor, administrator or finance', async () => {
  const q = '/api/reports/funder?from=2026-02-14&to=2026-02-14&purpose=submission&counts=exact';
  for (const c of [nav, ro]) assert.equal((await c.get(q)).status, 403, 'a navigator or read-only account cannot switch suppression off');
  for (const c of [sup, admin, fin]) {
    const r = await c.get(q);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.suppression, { mode: 'exact', threshold: 11, purpose: 'submission' });
    assert.equal(r.data.small_cell_threshold, null, 'no threshold applied');
    assert.ok(Object.values(r.data.demographics).flat().every(x => typeof x.n === 'number'), 'every cell is a number');
  }
  // Something labelled for publication is never exact, whoever asks.
  assert.equal((await sup.get('/api/reports/funder?from=2026-02-14&to=2026-02-14&purpose=publication&counts=exact')).status, 400);
  assert.equal((await sup.get('/api/reports/funder?from=2026-02-14&to=2026-02-14&purpose=junk')).status, 400);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='report.funder' ORDER BY id DESC LIMIT 1`);
  assert.match(a.details, /"counts":"exact"/, 'the audit entry records the mode');
});

test('the small-cell threshold is a setting (default 11)', async () => {
  assert.equal((await admin.put('/api/admin/settings', { small_cell_threshold: 1 })).status, 400, 'below 2 would suppress nothing');
  assert.equal((await admin.put('/api/admin/settings', { small_cell_threshold: 5 })).status, 200);
  try {
    const r = await sup.get('/api/reports/funder?from=2026-02-14&to=2026-02-14');
    assert.equal(r.data.suppression.threshold, 5);
    assert.equal(r.data.small_cell_threshold, 5);
    for (const x of Object.values(r.data.demographics).flat()) assert.ok(x.n === '<5' || x.n === 'suppressed' || x.n >= 5, `${x.k}: ${x.n}`);
  } finally { await admin.put('/api/admin/settings', { small_cell_threshold: null }); }
  assert.equal((await nav.get('/api/reports/funder?from=2026-02-14&to=2026-02-14')).data.suppression.threshold, 11);
});

test('the funder report export states its counting mode on the About sheet and in the header', async () => {
  const pub = await nav.get('/api/reports/funder/export?from=2026-01-01&to=2026-03-31&format=csv');
  assert.equal(pub.status, 200);
  assert.match(pub.headers.get('x-suds-report-counts'), /suppressed/i);
  assert.match(pub.headers.get('content-disposition'), /suppressed/);
  assert.match(String(pub.data), /Small cells suppressed/);
  const xl = await fetch(`${await H.start()}/api/reports/funder/export?from=2026-01-01&to=2026-03-31&format=xlsx&purpose=submission&counts=exact`, { headers: { Authorization: `Bearer ${(await H.client().post('/api/auth/login', { username: 'frsup', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token}` } });
  assert.equal(xl.status, 200);
  assert.match(xl.headers.get('content-disposition'), /exact/);
  const files = require('../server/importers/text').unzip(Buffer.from(await xl.arrayBuffer()));
  const all = [...files.values()].map(String).join('\n');
  assert.ok(all.includes('Exact counts'), 'the About sheet says exact counts were used');
  assert.ok(all.includes('not for publication'), 'and that the file is not for publication');
  assert.equal((await nav.get('/api/reports/funder/export?from=2026-01-01&to=2026-03-31&purpose=submission&counts=exact')).status, 403);
  assert.equal((await ro.get('/api/reports/funder/export?from=2026-01-01&to=2026-03-31')).status, 403, 'an export needs export:read');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.funder.export'`), 'the export is audited');
});

// ---- funding attribution ----
test('visits with no funding source get their own row and a warning', async () => {
  const r = (await admin.get('/api/reports/funder?from=2025-07-01&to=2026-06-30')).data;
  const none = r.by_funding_source.find(f => f.id === null);
  assert.ok(none, 'a "No funding source" row');
  assert.equal(none.name, 'No funding source');
  const n = H.db.one(`SELECT COUNT(*) n FROM interventions WHERE funding_source_id IS NULL AND occurred_at >= '2025-07-01' AND occurred_at < '2026-07-01'`).n;
  assert.ok(Math.abs(none.services - n) <= 60, `about ${n} unattributed services (boundary days aside): ${none.services}`);
  assert.equal(r.attribution.unattributed_services, none.services);
  assert.match(r.attribution.fix_link, /^#\/interventions\?.*funding=none/);
  // The list the link opens shows exactly those visits.
  const list = await admin.get('/api/interventions?funding=none&limit=5');
  assert.equal(list.status, 200);
  assert.ok(list.data.rows.length > 0 && list.data.rows.every(x => x.funding_source_id === null));
});

test('staff hours: logged but not yet approved are shown beside approved, with a warning', async () => {
  const f = (await admin.post('/api/budget/funds', { name: 'Hours fund', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 })).data.id;
  const worker = H.makeUser('frhours', 'navigator');
  for (const [m, s] of [[4770, 'submitted'], [60, 'draft'], [30, 'rejected']]) H.db.run(`INSERT INTO time_entries(id,user_id,work_date,minutes,funding_source_id,status) VALUES(?,?,?,?,?,?)`, require('node:crypto').randomUUID(), worker.id, '2026-08-03', m, f, s);
  const r = (await admin.get('/api/reports/funder?from=2026-08-01&to=2026-08-31')).data;
  const row = r.by_funding_source.find(x => x.id === f);
  assert.equal(row.approved_minutes, 0);
  assert.equal(row.unapproved_minutes, 4830, '79.5 h waiting for approval (rejected time is not counted)');
  assert.ok(r.attribution.unapproved_minutes >= 4830);
});

test('a default fund per worker and for the programme pre-fills new visits', async () => {
  const f = (await admin.post('/api/budget/funds', { name: 'Default fund', fiscal_year_start: '2025-01-01', fiscal_year_end: '2027-12-31', total_amount: 1000 })).data.id;
  const g = (await admin.post('/api/budget/funds', { name: 'Worker fund', fiscal_year_start: '2025-01-01', fiscal_year_end: '2027-12-31', total_amount: 1000 })).data.id;
  assert.equal((await admin.put('/api/admin/settings', { default_fund_id: 'no-such-fund' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { default_fund_id: f })).status, 200);
  const me = (await nav.get('/api/auth/me')).data;
  assert.equal(me.default_fund_id, f, 'the programme default');
  const u = H.db.one(`SELECT id FROM users WHERE username='frnav'`);
  assert.equal((await admin.put(`/api/users/${u.id}`, { default_fund_id: 'nope' })).status, 400);
  assert.equal((await admin.put(`/api/users/${u.id}`, { default_fund_id: g })).status, 200);
  assert.equal((await nav.get('/api/auth/me')).data.default_fund_id, g, 'the worker\'s own default wins');
  assert.equal((await admin.get('/api/users')).data.users.find(x => x.id === u.id).default_fund_id, g);
  // A visit logged without choosing a fund (a role that is not shown the field) is charged to the default;
  // one where the worker chose "none" is left alone.
  const cl = H.makeUser('frclin', 'clinician');
  const clin = H.client(); await clin.login('frclin', 'StaffPassw0rd!x');
  const v = await clin.post('/api/interventions', { type: 'outreach', occurred_at: '2026-08-05T10:00:00Z' });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  assert.equal(H.db.one(`SELECT funding_source_id FROM interventions WHERE id=?`, v.data.id).funding_source_id, f, 'the programme default, for a worker with none of their own');
  assert.ok(cl.id);
  const w = await nav.post('/api/interventions', { type: 'outreach', occurred_at: '2026-08-05T10:00:00Z', funding_source_id: null });
  assert.equal(H.db.one(`SELECT funding_source_id FROM interventions WHERE id=?`, w.data.id).funding_source_id, null);
  await admin.put('/api/admin/settings', { default_fund_id: null });
});

// ---- a report filtered to one fund reports that fund only ----
test('filtered to one fund: its staff hours, its services and no other fund\'s', async () => {
  const x = (await admin.post('/api/budget/funds', { name: 'Filter fund X', fiscal_year_start: '2027-01-01', fiscal_year_end: '2027-12-31', total_amount: 1000 })).data.id;
  const y = (await admin.post('/api/budget/funds', { name: 'Filter fund Y', fiscal_year_start: '2027-01-01', fiscal_year_end: '2027-12-31', total_amount: 1000 })).data.id;
  const worker = H.makeUser('frfilter', 'navigator');
  for (const [m, s, f] of [[120, 'submitted', x], [60, 'approved', x], [300, 'draft', y], [90, 'approved', y], [30, 'submitted', null]]) {
    H.db.run(`INSERT INTO time_entries(id,user_id,work_date,minutes,funding_source_id,status) VALUES(?,?,?,?,?,?)`, require('node:crypto').randomUUID(), worker.id, '2027-01-12', m, f, s);
  }
  assert.equal((await admin.post('/api/interventions', { type: 'outreach', occurred_at: '2027-01-12T18:00:00Z', funding_source_id: null })).status, 201);
  assert.equal((await admin.post('/api/interventions', { type: 'outreach', occurred_at: '2027-01-12T18:00:00Z', funding_source_id: x })).status, 201);
  const all = (await admin.get('/api/reports/funder?from=2027-01-01&to=2027-01-31')).data;
  assert.equal(all.attribution.unapproved_minutes, 450, 'programme-wide: every fund\'s time and time charged to none');
  assert.equal(all.attribution.approved_minutes, 150);
  assert.equal(all.attribution.unattributed_services, 1);
  const one = (await admin.get(`/api/reports/funder?from=2027-01-01&to=2027-01-31&funding_source_id=${x}`)).data;
  assert.equal(one.attribution.unapproved_minutes, 120, 'only fund X\'s time waiting for approval');
  assert.equal(one.attribution.approved_minutes, 60);
  assert.equal(one.attribution.unattributed_services, 0, 'a visit charged to no fund is not in a report about fund X');
  assert.deepEqual(one.by_funding_source.map(f => f.id), [x], 'the fund table shows the chosen fund');
  const csv = String((await admin.get(`/api/reports/funder/export?from=2027-01-01&to=2027-01-31&funding_source_id=${x}&format=csv`)).data);
  assert.match(csv, /Funding attribution,"?Staff hours logged, not yet approved"?,2\r?\n/, 'the Summary sheet: two hours, fund X\'s');
  assert.match(csv, /Funding attribution,"?Approved staff hours"?,1\r?\n/);
});

// ---- no programme default fund: the report says where to set one ----
test('with no programme default fund, the attribution warning points to Settings', async () => {
  await admin.put('/api/admin/settings', { default_fund_id: null });
  let d = (await sup.get('/api/reports/funder?from=2027-01-01&to=2027-01-31')).data;
  assert.equal(d.attribution.default_fund_set, false);
  assert.equal(d.attribution.settings_link, '#/admin?tab=settings&section=reporting');
  const f = (await admin.post('/api/budget/funds', { name: 'Main fund', fiscal_year_start: '2027-01-01', fiscal_year_end: '2027-12-31', total_amount: 1000 })).data.id;
  await admin.put('/api/admin/settings', { default_fund_id: f });
  try {
    d = (await sup.get('/api/reports/funder?from=2027-01-01&to=2027-01-31')).data;
    assert.equal(d.attribution.default_fund_set, true);
  } finally { await admin.put('/api/admin/settings', { default_fund_id: null }); }
});

test('first-run setup can name the programme\'s main fund and make it the default', () => {
  const budget = require('../server/routes/budget');
  H.db.run(`DELETE FROM settings WHERE key='default_fund_id'`);
  assert.equal(budget.createProgrammeFund('', { today: '2026-09-25' }), null, 'optional: a blank name creates nothing');
  const id = budget.createProgrammeFund('  County SUD Navigation Grant  ', { today: '2026-09-25' });
  const f = H.db.one(`SELECT * FROM funding_sources WHERE id=?`, id);
  assert.equal(f.name, 'County SUD Navigation Grant');
  assert.equal(f.is_active, 1);
  assert.deepEqual([f.fiscal_year_start, f.fiscal_year_end], ['2026-07-01', '2027-06-30'], 'the California fiscal year it falls in, editable under Budget');
  assert.equal(H.db.getSetting('default_fund_id', null), id, 'and it is the programme default');
  assert.equal(budget.defaultFundFor(null), id);
  assert.deepEqual(budget.createProgrammeFund('x', { today: '2026-03-01' }) && H.db.getSetting('default_fund_id', null), id, 'an existing default is kept');
  H.db.run(`DELETE FROM settings WHERE key='default_fund_id'`);
});
