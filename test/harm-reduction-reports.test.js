'use strict';
// The reports a California harm-reduction programme owes besides its funder report
// (docs/compliance/HARM-REDUCTION-REPORTING.md): the Naloxone Distribution Project distribution and
// reversal log, and the opioid settlement expenditure report by allowable-use category.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const C = require('../server/constants');

let admin, sup, nav, fin, ro, clin, clientId, fund, plainFund, line;
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['hrsup', 'supervisor'], ['hrnav', 'navigator'], ['hrfin', 'finance'], ['hrro', 'readonly'], ['hrclin', 'clinician']]) H.makeUser(u, role);
  sup = H.client(); await sup.login('hrsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('hrnav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('hrfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('hrro', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('hrclin', 'StaffPassw0rd!x');
  clientId = (await sup.post('/api/clients', { first_name: 'Nadia', last_name: 'Loxone', confirm_duplicate: true })).data.id;
  // Anonymous community distribution at two sites, and one kit to an enrolled client.
  for (const [kits, location, at] of [[10, 'community', '2026-05-02T18:00:00.000Z'], [5, 'community', '2026-05-02T19:00:00.000Z'], [8, 'shelter', '2026-05-09T17:00:00.000Z']]) {
    assert.equal((await sup.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at, naloxone_kits: kits, location })).status, 201);
  }
  assert.equal((await sup.post('/api/interventions', { client_id: clientId, type: 'harm_reduction', occurred_at: '2026-05-03T18:00:00.000Z', naloxone_kits: 1, location: 'field' })).status, 201);
  assert.equal((await sup.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-05-03T18:00:00.000Z' })).status, 201, 'a visit with no naloxone is not in the log');
  // Reversals reported back to the programme: one by a named client, one from the community.
  assert.equal((await sup.post('/api/overdose-events', { client_id: clientId, occurred_at: '2026-05-10T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 2, administered_by: 'bystander', survived: true, location_type: 'residence' })).status, 201);
  assert.equal((await sup.post('/api/overdose-events', { occurred_at: '2026-05-11T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 1, administered_by: 'family', survived: true, location_type: 'street', city: 'Marysville' })).status, 201);
  assert.equal((await sup.post('/api/overdose-events', { occurred_at: '2026-05-12T10:00:00Z', kind: 'fatal', naloxone_used: false, survived: false })).status, 201, 'a death is not a reversal');
});
after(async () => { await H.stop(); });

// ---- (a) Naloxone Distribution Project log ----
test('the NDP log: distribution and reversals reported, aggregated, with no names or client codes', async () => {
  const r = await sup.get('/api/reports/naloxone-ndp?from=2026-05-01&to=2026-05-31');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // A navigator sees community distribution and their own caseload's, as with every other report.
  assert.equal((await nav.get('/api/reports/naloxone-ndp?from=2026-05-01&to=2026-05-31')).data.totals.kits, 23, 'the enrolled client is not on this navigator\'s caseload');
  assert.equal(r.data.totals.kits, 24);
  assert.equal(r.data.totals.doses, 48, 'two doses per kit by default');
  assert.equal(r.data.totals.reversals, 2);
  assert.equal(r.data.totals.reversal_doses, 3);
  const may2 = r.data.rows.find(x => x.date === '2026-05-02' && x.entry === 'distribution');
  assert.equal(may2.kits, 15, 'the two community hand-outs on the same day and site are one row');
  assert.equal(may2.recipient_type, 'Community member (anonymous)');
  assert.ok(r.data.rows.some(x => x.recipient_type === 'Programme participant' && x.kits === 1));
  assert.ok(r.data.rows.some(x => x.entry === 'reversal' && x.site_type === 'street' && x.reversals === 1));
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('Loxone') && !text.includes('Nadia'), 'no names');
  assert.ok(!text.includes(H.db.one(`SELECT client_code FROM clients WHERE id=?`, clientId).client_code), 'no client codes');
  assert.match(r.data.template_note, /must be checked against the current NDP/);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.naloxone_ndp'`));
});

test('the NDP log: doses per kit is a setting', async () => {
  assert.equal((await admin.put('/api/admin/settings', { naloxone_doses_per_kit: 0 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { naloxone_doses_per_kit: 1 })).status, 200);
  try { assert.equal((await sup.get('/api/reports/naloxone-ndp?from=2026-05-01&to=2026-05-31')).data.totals.doses, 24); }
  finally { await admin.put('/api/admin/settings', { naloxone_doses_per_kit: null }); }
});

test('the NDP log exports to CSV and Excel, labelled as not the official template', async () => {
  const csv = await nav.get('/api/reports/naloxone-ndp/export?from=2026-05-01&to=2026-05-31&format=csv');
  assert.equal(csv.status, 200);
  const lines = String(csv.data).split('\r\n');
  assert.match(lines[0], /^Date,Entry,Site type,Recipient type,Kits distributed,Naloxone doses distributed,Reversals reported,Doses used in reversals,Naloxone given by/);
  assert.match(csv.headers.get('x-suds-export'), /not the official NDP template/i);
  const xl = await fetch(`${await H.start()}/api/reports/naloxone-ndp/export?from=2026-05-01&to=2026-05-31&format=xlsx`, { headers: { Authorization: `Bearer ${(await H.client().post('/api/auth/login', { username: 'hrnav', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token}` } });
  assert.equal(xl.status, 200);
  const all = [...require('../server/importers/text').unzip(Buffer.from(await xl.arrayBuffer())).values()].map(String).join('\n');
  assert.ok(all.includes('must be checked against the current NDP reporting template'));
  assert.equal((await ro.get('/api/reports/naloxone-ndp/export?from=2026-05-01&to=2026-05-31')).status, 403, 'an export needs export:read');
  assert.equal((await ro.get('/api/reports/naloxone-ndp?from=2026-05-01&to=2026-05-31')).status, 200, 'the on-screen totals need only reports:read');
  assert.equal((await nav.get('/api/reports/naloxone-ndp?from=bad')).status, 400);
});

// ---- (b) Opioid settlement expenditure report ----
test('the settlement categories are listed in constants, each with a source', () => {
  assert.ok(C.SETTLEMENT_USES.length >= 10);
  assert.ok(C.SETTLEMENT_USES.every(x => x.code && x.label && x.schedule));
  assert.equal(C.SETTLEMENT_HIAA.length, 6, 'California\'s six High Impact Abatement Activities');
});

test('a fund and an expenditure carry a settlement category', async () => {
  const hiaa = C.SETTLEMENT_HIAA.find(x => /naloxone/i.test(x.label)).code;
  const f = await admin.post('/api/budget/funds', { name: 'County settlement share', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 50000, settlement_use: 'core_a', settlement_hiaa: hiaa });
  assert.equal(f.status, 201, JSON.stringify(f.data)); fund = f.data.id;
  assert.equal((await admin.post('/api/budget/funds', { name: 'Bad', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1, settlement_use: 'made_up' })).status, 400);
  plainFund = (await admin.post('/api/budget/funds', { name: 'Foundation', source_type: 'foundation', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 })).data.id;
  line = (await admin.post(`/api/budget/funds/${fund}/lines`, { category: 'naloxone_supplies', allocated_amount: 50000 })).data.id;
  const e1 = await nav.post('/api/budget/expenditures', { funding_source_id: fund, budget_line_id: line, spent_at: '2026-05-05', amount: 1200, category: 'naloxone_supplies' });
  assert.equal(e1.status, 201, JSON.stringify(e1.data));
  const e2 = await nav.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-05-06', amount: 800, category: 'training', settlement_use: 'approved_k', settlement_hiaa: 'none' });
  assert.equal(e2.status, 201, JSON.stringify(e2.data));
  assert.equal((await nav.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-05-06', amount: 1, category: 'training', settlement_use: 'nope' })).status, 400);
  await nav.post('/api/budget/expenditures', { funding_source_id: plainFund, spent_at: '2026-05-06', amount: 99, category: 'training' });
  for (const id of [e1.data.id, e2.data.id]) assert.equal((await sup.post(`/api/budget/expenditures/${id}/approve`, { status: 'approved' })).status, 200);
  await nav.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-05-07', amount: 300, category: 'supplies' });
});

test('the opioid settlement report groups settlement spending by allowable use and HIAA', async () => {
  const r = await fin.get('/api/reports/opioid-settlement?from=2026-01-01&to=2026-12-31');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const core = r.data.by_use.find(x => x.code === 'core_a');
  assert.equal(core.approved_amount, 1200, 'the fund\'s default category');
  assert.equal(core.pending_amount, 300, 'pending spending is shown apart');
  assert.equal(r.data.by_use.find(x => x.code === 'approved_k').approved_amount, 800, 'an expenditure\'s own category wins');
  assert.equal(r.data.totals.approved_amount, 2000, 'only settlement funds: the foundation grant is left out');
  assert.equal(r.data.totals.hiaa_amount, 1200, 'the training line was marked as not HIAA');
  assert.equal(r.data.totals.hiaa_share, 60);
  assert.match(r.data.source_note, /verif/i);
  assert.equal((await nav.get('/api/reports/opioid-settlement?from=2026-01-01&to=2026-12-31')).status, 200, 'a navigator holds budget:read');
  assert.equal((await clin.get('/api/reports/opioid-settlement?from=2026-01-01&to=2026-12-31')).status, 403, 'a clinician holds no budget permission');
  assert.equal((await ro.get('/api/reports/opioid-settlement?from=2026-01-01&to=2026-12-31')).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.opioid_settlement'`));
});

test('the opioid settlement report exports to CSV and Excel', async () => {
  const csv = await fin.get('/api/reports/opioid-settlement/export?from=2026-01-01&to=2026-12-31&format=csv');
  assert.equal(csv.status, 200);
  assert.match(String(csv.data).split('\r\n')[0], /^Schedule,Category,High Impact Abatement Activity/);
  assert.ok(String(csv.data).includes('1200'));
  const xl = await fin.get('/api/reports/opioid-settlement/export?from=2026-01-01&to=2026-12-31&format=xlsx');
  assert.equal(xl.status, 200);
  assert.match(xl.headers.get('content-type'), /spreadsheetml/);
  assert.equal((await clin.get('/api/reports/opioid-settlement/export?from=2026-01-01&to=2026-12-31')).status, 403);
});
