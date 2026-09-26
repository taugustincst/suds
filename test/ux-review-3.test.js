'use strict';
// The third hands-on UX review (1.13.1): a fresh production install through the wizard, a navigator on a
// phone, a supervisor, finance and read-only at a desk, and local mode. What it found that the API decides:
// anonymous outreach missing from Home and Reports, the usual consent that could not be saved as offered,
// the wizard's fund that never reached the settlement report, and overdose doses shown one way on the list
// and another in the reports.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
let admin, nav, nav2, sup, fin, clientId;
const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
before(async () => {
  await H.start();
  H.makeUser('uxnav', 'navigator'); H.makeUser('uxnav2', 'navigator'); H.makeUser('uxsup', 'supervisor'); H.makeUser('uxfin', 'finance');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('uxnav', PW);
  nav2 = H.client(); await nav2.login('uxnav2', PW);
  sup = H.client(); await sup.login('uxsup', PW);
  fin = H.client(); await fin.login('uxfin', PW);
  clientId = (await nav.post('/api/clients', { first_name: 'Marisol', last_name: 'Okafor', primary_substance: 'opioids_fentanyl', status: 'active' })).data.id;
});
after(H.stop);

const at = () => new Date(Date.now() - 3600000).toISOString();
test('Home and Reports count anonymous outreach: a supervisor\'s totals agree with the funder report for the same period', async () => {
  // Two named visits (2 kits, 1 strip) and two anonymous distributions by two workers (10 kits + 4 strips, 3 kits).
  for (const v of [{ client_id: clientId, type: 'naloxone_distribution', naloxone_kits: 2, fentanyl_strips: 1 }, { client_id: clientId, type: 'crisis_response', duration_minutes: 20 }]) {
    assert.equal((await nav.post('/api/interventions', { occurred_at: at(), ...v })).status, 201);
  }
  assert.equal((await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at(), naloxone_kits: 10, fentanyl_strips: 4 })).status, 201);
  assert.equal((await nav2.post('/api/interventions', { type: 'outreach', occurred_at: at(), naloxone_kits: 3 })).status, 201);

  const q = `from=${from}&to=${today}`;
  const d = (await sup.get(`/api/reports/dashboard?${q}`)).data;
  const f = (await sup.get(`/api/reports/funder?${q}&purpose=submission&counts=exact`)).data;
  const services = f.by_funding_source.reduce((s, x) => s + x.services, 0);
  assert.equal(d.interventions.naloxone_kits, 15, 'every kit that went out, anonymous distribution included');
  assert.equal(d.interventions.naloxone_kits, f.naloxone_distribution.kits, 'Home/Reports kits = the funder report\'s');
  assert.equal(d.interventions.fentanyl_strips, f.naloxone_distribution.strips, 'test strips agree');
  assert.equal(d.interventions.total, 4); assert.equal(d.interventions.total, services, 'visits = the funder report\'s services');
  assert.equal(d.interventions.by_type.reduce((s, x) => s + x.n, 0), d.interventions.total, 'the by-type bars add up to the total');
  assert.equal(d.interventions.by_week.reduce((s, x) => s + x.n, 0), d.interventions.total);
  assert.equal(d.interventions.by_worker.reduce((s, x) => s + x.n, 0), d.interventions.total, 'and the by-worker bars');

  // Finance sees the programme's visits too (counts of visits and kits are not masked), anonymous ones included.
  const df = (await fin.get(`/api/reports/dashboard?${q}`)).data;
  assert.equal(df.interventions.naloxone_kits, 15); assert.equal(df.interventions.total, 4);

  // A caseload-scoped navigator: their clients' visits, and the anonymous visits they logged themselves (the
  // owner rule for records with no client) - not another worker's anonymous outreach.
  const dn = (await nav.get(`/api/reports/dashboard?${q}`)).data;
  assert.equal(dn.interventions.naloxone_kits, 12); assert.equal(dn.interventions.total, 3); assert.equal(dn.interventions.fentanyl_strips, 5);
  const dn2 = (await nav2.get(`/api/reports/dashboard?${q}`)).data;
  assert.equal(dn2.interventions.naloxone_kits, 3, 'the other worker: only their own anonymous outreach'); assert.equal(dn2.interventions.total, 1);
});

test('the usual consent saves with the referral partners ticked (a list kept with it), and a consent filled in from it saves too', async () => {
  const partners = ['Hope Street Detox', 'Riverbend Opioid Treatment Program', 'Northside Intensive Outpatient', 'Harbor Recovery Residence', 'Eastside Syringe Services Program', 'County Behavioral Health Access Center', 'St. Mark\'s Medication for Addiction Treatment Clinic'];
  const recipient = `My treating providers, health plans, third-party payers, and people helping to operate this program, including ${partners.join(', ')}`;
  assert.ok(recipient.length > 300, 'longer than the old 300-character limit');
  const r = await admin.put('/api/consent-template', { type: 'part2_tpo', recipient, partners, purpose: 'For treatment, payment, and health care operations', expires_days: 365, info_categories: ['demographics', 'referrals'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = (await nav.get('/api/consent-template')).data.template;
  assert.deepEqual(t.partners, partners, 'which partners were ticked is kept, for the form to show them again');
  assert.equal(t.recipient, recipient);
  // A worker fills a consent in from it: the recipient is the template's, and it must save too.
  const c = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_tpo', recipient: t.recipient, purpose: t.purpose, scope: 'Referral information', signed_at: today, expires_at: '2099-01-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true, info_categories: t.info_categories });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const bad = await admin.put('/api/consent-template', { type: 'part2_tpo', recipient: 'x', partners: 'Hope Street Detox' });
  assert.equal(bad.status, 400); assert.match(bad.data.fields.partners, /^Choose at most 200 referral partners/, 'a sentence a person can act on');
  const long = await admin.put('/api/consent-template', { type: 'part2_tpo', recipient: 'x'.repeat(2001) });
  assert.equal(long.status, 400, 'still bounded');
});

test('the settlement report says plainly when no fund is settlement money; the wizard\'s fund can be settlement money with its category', async () => {
  const q = `from=${from}&to=${today}&purpose=internal&counts=exact`;
  const empty = await admin.get(`/api/reports/opioid-settlement?${q}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.funds, []);
  assert.match(empty.data.note, /No funding source is marked as opioid settlement money/, 'the screen is told why it is empty');
  const csv = await admin.get(`/api/reports/opioid-settlement/export?${q}`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Note,"No funding source is marked as opioid settlement money/, 'and the file says so in a row, not a bare header');
  // The first-run wizard's fund (POST /api/setup/complete runs createProgrammeFund with the answers).
  const budget = require('../server/routes/budget');
  const setup = require('../server/routes/setup');
  const opts = setup.fundOptions();
  assert.ok(opts.types.some(t => t.value === 'opioid_settlement' && t.label === 'Opioid settlement'), 'the wizard offers the fund types, in words');
  assert.ok(opts.types.some(t => t.value === 'sor_grant' && t.label === 'SOR grant'));
  assert.ok(opts.settlement_uses.some(u => u.value === 'approved_h'));
  const id = budget.createProgrammeFund('County opioid settlement allocation', { type: 'opioid_settlement', settlement_use: 'approved_h', settlement_hiaa: 'hiaa_6' });
  const f = H.db.one('SELECT source_type, settlement_use, settlement_hiaa FROM funding_sources WHERE id=?', id);
  assert.deepEqual({ ...f }, { source_type: 'opioid_settlement', settlement_use: 'approved_h', settlement_hiaa: 'hiaa_6' });
  const other = budget.createProgrammeFund('A foundation grant', { type: 'foundation', settlement_use: 'approved_h' });
  assert.deepEqual({ ...H.db.one('SELECT source_type, settlement_use FROM funding_sources WHERE id=?', other) }, { source_type: 'foundation', settlement_use: null }, 'a settlement category only on settlement money');
  const listed = (await admin.get(`/api/reports/opioid-settlement?${q}`)).data;
  assert.ok(listed.funds.some(x => x.id === id), 'the wizard\'s settlement fund reaches the settlement report');
  assert.match(listed.note, /No spending from opioid settlement funds was recorded in this period/);
  H.db.run('UPDATE funding_sources SET is_active=0 WHERE id IN (?,?)', id, other);
  H.db.run(`DELETE FROM settings WHERE key='default_fund_id'`);
});

test('Home\'s audit-anchor finding is a plain sentence with where to read more, amber unless an audit check has failed', async () => {
  const config = require('../server/config');
  const saved = { isProd: config.isProd, auditAnchorDirConfigured: config.auditAnchorDirConfigured };
  Object.assign(config, { isProd: true, auditAnchorDirConfigured: false });
  try {
    let a = (await admin.get('/api/admin/security/alerts')).data.alerts.find(x => x.key === 'audit_anchor_dir');
    assert.ok(a, 'the finding is still raised: it is a real production problem');
    assert.equal(a.severity, 'warn', 'amber, not an alarm');
    assert.match(a.explain, /same disk as the database/); assert.match(a.explain, /Ask your IT support/); assert.match(a.explain, /docs\/security\/LOGGING-AND-AUDIT\.md/);
    assert.equal(a.link, '#/admin?tab=security');
    H.db.setSetting('audit_verify_failed_at', new Date().toISOString());
    a = (await admin.get('/api/admin/security/alerts')).data.alerts.find(x => x.key === 'audit_anchor_dir');
    assert.equal(a.severity, 'danger', 'red once an audit check has actually failed');
    // Sample data is not offered on a production server's Home (it stays under Settings).
    assert.equal((await admin.get('/api/admin/demo')).data.home_offer, false);
  } finally { Object.assign(config, saved); H.db.run(`DELETE FROM settings WHERE key='audit_verify_failed_at'`); }
  assert.equal((await admin.get('/api/admin/demo')).data.home_offer, true, 'elsewhere Home offers it on an empty programme');
});

test('coded values read as words: the labels the review found printed as codes', () => {
  const O = require('../server/options');
  for (const [code, label] of [['court_probation', 'Court / probation'], ['ems', 'EMS'], ['va', 'VA'], ['opioids_fentanyl', 'Opioids (fentanyl)'], ['buprenorphine_xr', 'Buprenorphine XR'],
    ['non_binary', 'Non-binary'], ['crisis_24_7', '24/7 crisis'], ['co_occurring', 'Co-occurring'], ['readonly', 'Read-only'], ['sor_grant', 'SOR grant']]) assert.equal(O.humanize(code), label, code);
  assert.equal(O.labelOf('SUBSTANCES', 'opioids_fentanyl'), 'Opioids (fentanyl)', 'in a documentation list too (and so in exports)');
});

test('an overdose event is charged to the default fund, as a visit is; an explicit "none" stays none; doses left empty are stored as 0', async () => {
  const f = (await admin.post('/api/budget/funds', { name: 'County general FY', source_type: 'county_general', fiscal_year_start: '2026-01-01', fiscal_year_end: '2099-12-31', total_amount: 1000 })).data.id;
  assert.equal((await admin.put('/api/admin/settings', { default_fund_id: f })).status, 200);
  const r = await nav.post('/api/overdose-events', { kind: 'reversal', occurred_at: at(), naloxone_doses: null });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = H.db.one('SELECT funding_source_id, naloxone_doses, naloxone_used FROM overdose_events WHERE id=?', r.data.id);
  assert.equal(row.funding_source_id, f, 'the programme default fund, with no fund on the request');
  assert.equal(row.naloxone_doses, 0, 'doses not recorded are stored as 0 (and shown as "doses not recorded", never "1 dose")');
  assert.equal(row.naloxone_used, 1);
  const none = await nav.post('/api/overdose-events', { kind: 'overdose', occurred_at: at(), funding_source_id: null });
  assert.equal(H.db.one('SELECT funding_source_id FROM overdose_events WHERE id=?', none.data.id).funding_source_id, null, 'an explicit none is left as chosen');
  assert.equal((await admin.put('/api/admin/settings', { default_fund_id: '' })).status, 200);
});

test('a visit that hands out kits with no supply item to take them off says so; with the item, it is drawn down and says nothing', async () => {
  H.db.run('DELETE FROM supply_stock');
  const r = await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at(), naloxone_kits: 4, fentanyl_strips: 2 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.supplies_untracked, [{ item: 'Naloxone kit', quantity: 4 }, { item: 'Fentanyl test strips', quantity: 2 }], 'the form is told what was not taken off');
  assert.equal((await nav.post('/api/supplies', { item: 'Naloxone kit', quantity: 10 })).status, 201);
  const r2 = await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at(), naloxone_kits: 3 });
  assert.equal(r2.data.supplies_untracked, undefined, 'nothing to say');
  assert.equal(H.db.one(`SELECT quantity FROM supply_stock WHERE item='Naloxone kit'`).quantity, 7, 'drawn down');
  const r3 = await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at(), naloxone_kits: 1, fentanyl_strips: 5 });
  assert.deepEqual(r3.data.supplies_untracked, [{ item: 'Fentanyl test strips', quantity: 5 }], 'only the item that is missing');
});
