'use strict';
// The opioid settlement report in the DHCS settlement expenditure layout, and in a county's own template
// matched by a column mapping (server/harm-reduction-reports.js dhcsRows, countyRows; 1.14.0). SUDS fills what
// it holds, leaves the narrative for the programme, never reports a number of people of 10 or fewer (DHCS's
// rule), and the county mapping is set without code by finance, a supervisor or an administrator.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const HR = require('../server/harm-reduction-reports');

let admin, sup, nav, fin, ro, fund;
const Q = 'from=2026-01-01&to=2026-06-30';
const csvRows = (text) => text.trim().split('\r\n').map(l => l.split(','));

before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['lsup', 'supervisor'], ['lfin', 'finance'], ['lro', 'readonly']]) H.makeUser(u, role);
  H.makeCaseloadUser('lnav', 'navigator'); // held to their caseload (clients:all denied), as navigators were before 1.16.0
  sup = H.client(); await sup.login('lsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('lnav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('lfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('lro', 'StaffPassw0rd!x');
  await admin.put('/api/admin/settings', { org_name: 'Harbor Outreach' });
  const f = await admin.post('/api/budget/funds', { name: 'County settlement share', grant_number: 'OSF-22', source_type: 'opioid_settlement', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 50000, settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' });
  assert.equal(f.status, 201, JSON.stringify(f.data)); fund = f.data.id;
  const e1 = await nav.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-02-05', amount: 1200, category: 'naloxone_supplies' });
  const e2 = await nav.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-02-06', amount: 800, category: 'training', settlement_use: 'approved_k', settlement_hiaa: 'none' });
  for (const id of [e1.data.id, e2.data.id]) assert.equal((await sup.post(`/api/budget/expenditures/${id}/approve`, { status: 'approved' })).status, 200);
  await nav.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: '2026-02-07', amount: 300, category: 'supplies' });
  for (let i = 0; i < 3; i++) {
    const c = await nav.post('/api/clients', { first_name: 'Lay', last_name: `Out${i}`, confirm_duplicate: true });
    assert.equal((await nav.post('/api/interventions', { client_id: c.data.id, type: 'case_management', occurred_at: '2026-03-01T17:00:00.000Z', funding_source_id: fund })).status, 201);
  }
});
after(async () => { await H.stop(); });

test('DHCS: people of 10 or fewer are not reported, whatever the counting', () => {
  assert.deepEqual([0, 1, 10, 11, '<11'].map(HR.dhcsPeople), [0, '10 or fewer', '10 or fewer', 11, '<11']);
});

test('the DHCS layout: one row per activity, what SUDS holds filled, the narrative left for the programme', async () => {
  const x = await fin.raw(`/api/reports/opioid-settlement/export?${Q}&layout=dhcs`);
  assert.equal(x.status, 200, await x.clone().text());
  assert.equal(x.headers.get('x-suds-report-purpose'), 'submission', 'finance runs the programme\'s own report (reports:funder)');
  assert.match(x.headers.get('content-disposition'), /dhcs-layout/);
  const text = await x.text();
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0], HR.DHCS_FIELDS.map(f => (/[",]/.test(f.label) ? `"${f.label.replace(/"/g, '""')}"` : f.label)).join(','), 'the DHCS fields, in order');
  assert.equal(lines.length, 3, 'two activities: the fund\'s own category, and the training line under its own');
  assert.match(text, /A\. Naloxone or other FDA-approved drug/); assert.match(text, /6\. The purchase of naloxone/);
  assert.match(text, /K\. Training/); assert.match(text, /Not a High Impact Abatement Activity/);
  assert.match(text, /County settlement share/); assert.match(text, /OSF-22/); assert.match(text, /Harbor Outreach/);
  assert.match(text, /10 or fewer/, 'three people served: not reported as a number');
  assert.ok(!/\bLay\b|Out0/.test(text), 'no client information');
  // The Excel file says what is filled and what the programme must write.
  const xl = await fin.raw(`/api/reports/opioid-settlement/export?${Q}&layout=dhcs&format=xlsx`);
  assert.equal(xl.status, 200); assert.match(xl.headers.get('content-type'), /spreadsheetml/);
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='report.opioid_settlement.export' ORDER BY id DESC LIMIT 1`).details);
  assert.deepEqual([a.layout, a.purpose, a.rows], ['dhcs', 'submission', 2]);
});

test('the layout is the programme\'s own report: never a publication release; roles as the settlement report', async () => {
  assert.equal((await sup.get(`/api/reports/opioid-settlement/export?from=2026-01-01&to=2026-03-31&purpose=publication&layout=dhcs&reviewed=1`)).status, 400);
  assert.equal((await sup.get(`/api/reports/opioid-settlement/export?${Q}&layout=nope`)).status, 400);
  assert.equal((await ro.get(`/api/reports/opioid-settlement/export?${Q}&layout=dhcs`)).status, 403, 'read-only holds no budget:read');
  assert.equal((await nav.get(`/api/reports/opioid-settlement/export?${Q}&layout=dhcs`)).status, 403, 'a whole-programme report: not for a caseload-scoped role');
  assert.equal((await fin.get(`/api/reports/opioid-settlement/export?${Q}&layout=dhcs&purpose=internal`)).status, 403);
  const s = await sup.raw(`/api/reports/opioid-settlement/export?${Q}&layout=dhcs&counts=suppressed`);
  assert.equal(s.status, 200); assert.match(await s.text(), /10 or fewer|<11/);
});

test('a county template: a column mapping set without code, then the same rows in the county\'s columns', async () => {
  assert.equal((await fin.get(`/api/reports/opioid-settlement/export?${Q}&layout=county`)).status, 400, 'none set up yet');
  const layout = { name: 'Harbor County CBO quarterly report', columns: [{ label: 'Strategy', source: 'exhibit_e_category' }, { label: 'HIAA', source: 'hiaa' }, { label: 'Dollars spent', source: 'approved_amount' }, { label: 'Narrative', source: 'blank' }, { label: 'Contract', source: 'text', text: 'C-123' }] };
  assert.equal((await nav.put('/api/reports/settlement-layout', { county: layout })).status, 403, 'budget:manage');
  assert.equal((await ro.put('/api/reports/settlement-layout', { county: layout })).status, 403);
  assert.equal((await fin.put('/api/reports/settlement-layout', { county: { ...layout, columns: [{ label: 'X', source: 'client_name' }] } })).status, 400, 'only fields SUDS fills');
  assert.equal((await fin.put('/api/reports/settlement-layout', { county: { ...layout, columns: [{ label: 'X', source: 'hiaa' }, { label: 'x', source: 'hiaa' }] } })).status, 400, 'headings are unique');
  assert.equal((await fin.put('/api/reports/settlement-layout', { county: { name: '', columns: layout.columns } })).status, 400);
  const put = await fin.put('/api/reports/settlement-layout', { county: layout });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='settings.settlement_layout'`));
  const g = await nav.get('/api/reports/settlement-layout');
  assert.equal(g.status, 200); assert.equal(g.data.county.name, layout.name); assert.ok(g.data.sources.some(x => x.value === 'people_served'));
  assert.equal((await ro.get('/api/reports/settlement-layout')).status, 403);
  const x = await fin.raw(`/api/reports/opioid-settlement/export?${Q}&layout=county`);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /county-template/);
  const rows = csvRows(await x.text());
  assert.deepEqual(rows[0], ['Strategy', 'HIAA', 'Dollars spent', 'Narrative', 'Contract']);
  assert.ok(rows.slice(1).some(r => r[2] === '1200' && r[3] === '' && r[4] === 'C-123'), JSON.stringify(rows));
  assert.equal((await fin.put('/api/reports/settlement-layout', { county: null })).status, 200);
  assert.equal((await fin.get(`/api/reports/opioid-settlement/export?${Q}&layout=county`)).status, 400, 'cleared');
});
