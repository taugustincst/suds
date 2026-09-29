'use strict';
// Settlement outcomes (server/settlement-outcomes.js): each settlement fund's spending beside what the program
// recorded of the work charged to it, on the page (GET /api/reports/settlement-outcomes) and as a file
// (…/export), for finance, supervisors and administrators; small counts of people suppressed as in the funder
// report; nothing client-level; several funds, each shown on its own.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, sup, nav, fin, ro, clin;
const F = {};
const Q = 'from=2026-03-01&to=2026-04-30';
const names = [];
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['sosup', 'supervisor'], ['sonav', 'navigator'], ['sofin', 'finance'], ['soro', 'readonly'], ['soclin', 'clinician']]) H.makeUser(u, role);
  sup = H.client(); await sup.login('sosup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('sonav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('sofin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('soro', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('soclin', 'StaffPassw0rd!x');
  const fund = async (name, extra) => (await admin.post('/api/budget/funds', { name, fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 100000, ...extra })).data.id;
  // Three settlement funds (a county's, a city's and the state's share), and a fund that is not settlement money.
  F.county = await fund('County settlement share', { source_type: 'opioid_settlement', grant_number: 'OSF-C1', settlement_use: 'core_a', settlement_hiaa: 'hiaa_6' });
  F.city = await fund('City settlement share', { source_type: 'opioid_settlement', settlement_use: 'approved_a', settlement_hiaa: 'hiaa_2' });
  F.state = await fund('State abatement account', { source_type: 'opioid_settlement', settlement_use: 'approved_k' });
  F.other = await fund('County general', { source_type: 'county_general' });
  const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
  // Spending: approved under the fund's own category, under another, and pending.
  const spend = async (fid, amount, day, extra = {}) => ok(await nav.post('/api/budget/expenditures', { funding_source_id: fid, spent_at: day, amount, category: 'naloxone_supplies', ...extra })).id;
  for (const id of [await spend(F.county, 1200, '2026-03-05'), await spend(F.county, 300, '2026-04-02', { category: 'training', settlement_use: 'approved_k' }), await spend(F.city, 3000, '2026-03-10', { category: 'treatment_fees' }), await spend(F.state, 900, '2026-04-10', { category: 'training' })]) {
    ok(await sup.post(`/api/budget/expenditures/${id}/approve`, { status: 'approved' }), 200);
  }
  await spend(F.county, 100, '2026-04-20');
  // County: anonymous naloxone distribution, 8 contacts in March and 4 in April (2 kits each), and 3 reversals.
  for (let i = 0; i < 12; i++) ok(await sup.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: `2026-0${i < 8 ? 3 : 4}-${String(3 + i).padStart(2, '0')}T18:00:00.000Z`, naloxone_kits: 2, location: 'street', funding_source_id: F.county }));
  for (let i = 0; i < 3; i++) ok(await sup.post('/api/overdose-events', { occurred_at: `2026-03-${10 + i}T10:00:00Z`, kind: 'reversal', naloxone_used: true, naloxone_doses: 1, survived: true, funding_source_id: F.county }));
  // Not settlement money: its kits are not counted.
  ok(await sup.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: '2026-03-20T18:00:00.000Z', naloxone_kits: 50, location: 'street', funding_source_id: F.other }));
  // City: 15 people served, 12 of them linked to a MAT program (admitted), 2 admissions.
  const otp = ok(await sup.post('/api/resources', { name: 'County OTP', category: 'mat_otp' })).id;
  const people = [];
  for (let i = 0; i < 15; i++) {
    const name = `Settle${i}`; names.push(name);
    const c = ok(await sup.post('/api/clients', { first_name: name, last_name: 'Outcome', confirm_duplicate: true })).id; people.push(c);
    ok(await sup.post('/api/interventions', { client_id: c, type: 'case_management', occurred_at: '2026-03-15T17:00:00.000Z', funding_source_id: F.city }));
    if (i < 12) {
      const consent = ok(await sup.post(`/api/clients/${c}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT referral', signed_at: '2026-03-01', scope: 'Referral', expires_at: '2027-03-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true })).id;
      const ref = ok(await sup.post('/api/referrals', { client_id: c, resource_id: otp, referred_at: '2026-03-16T09:00:00.000Z', consent_id: consent })).id;
      ok(await sup.put(`/api/referrals/${ref}`, { status: 'admitted' }), 200);
    }
    // Their admission (the episode a new client opens) in April, charged to the city's fund.
    if (i >= 12 && i < 14) H.db.run(`UPDATE episodes SET opened_at='2026-04-01', funding_source_id=? WHERE client_id=?`, F.city, c);
  }
  // State: three people at education sessions, and two hours of approved staff training.
  for (let i = 0; i < 3; i++) {
    const c = ok(await sup.post('/api/clients', { first_name: `Trainee${i}`, last_name: 'Outcome', confirm_duplicate: true })).id;
    ok(await sup.post('/api/interventions', { client_id: c, type: 'education', occurred_at: '2026-04-12T17:00:00.000Z', funding_source_id: F.state }));
  }
  const supId = H.db.one(`SELECT id FROM users WHERE username='sosup'`).id;
  H.db.run(`INSERT INTO time_entries(id,user_id,work_date,minutes,category,funding_source_id,status) VALUES(?,?,?,?,?,?,?)`, 'te-train-1', supId, '2026-04-12', 120, 'training', F.state, 'approved');
  H.db.run(`INSERT INTO time_entries(id,user_id,work_date,minutes,category,funding_source_id,status) VALUES(?,?,?,?,?,?,?)`, 'te-train-2', supId, '2026-04-13', 600, 'training', F.state, 'draft');
  // More people served by the program under another fund, so the program's people served is 30.
  for (let i = 0; i < 12; i++) {
    const c = ok(await sup.post('/api/clients', { first_name: `Other${i}`, last_name: 'Outcome', confirm_duplicate: true })).id;
    ok(await sup.post('/api/interventions', { client_id: c, type: 'outreach', occurred_at: '2026-03-21T17:00:00.000Z', funding_source_id: F.other }));
  }
});
after(async () => { await H.stop(); });

const PEOPLE = ['reversals', 'people_served', 'referrals_made', 'people_linked', 'moud_linked', 'treatment_admissions', 'people_trained'];
const small = (v) => typeof v === 'number' && v > 0 && v < 11;

test('finance sees each settlement fund on its own, spending beside outcomes, small counts of people suppressed', async () => {
  const r = await fin.get(`/api/reports/settlement-outcomes?${Q}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.equal(d.suppression.mode, 'suppressed', 'the page shows small counts suppressed unless exact counts are asked for');
  assert.equal(d.suppression.purpose, 'submission');
  assert.deepEqual(d.funds.map(f => f.name).sort(), ['City settlement share', 'County settlement share', 'State abatement account'], 'three settlement funds, each on its own; not the county general fund');
  const by = Object.fromEntries(d.funds.map(f => [f.name, f]));
  const county = by['County settlement share']; const city = by['City settlement share']; const state = by['State abatement account'];
  // Overdose reversal spending: kits distributed (exact) and reversals reported (3: suppressed).
  assert.deepEqual(county.indicators, ['naloxone_kits', 'reversals', 'contacts']);
  assert.equal(county.values.naloxone_kits, 24, 'kits are exact, and the other fund\'s 50 are not counted');
  assert.equal(county.values.contacts, 12);
  assert.equal(county.values.reversals, '<11');
  assert.equal(county.spend.own_category, 1200); assert.equal(county.spend.other_categories, 300); assert.equal(county.spend.pending, 100);
  assert.equal(county.cost_per.naloxone_kits, 50, '1,200 spent under the fund\'s own category for 24 kits');
  assert.equal(county.cost_per.reversals, null, 'no cost per beside a hidden count');
  assert.equal(county.hiaa_label.startsWith('6.'), true);
  // Trends: kits by month, every month listed.
  assert.deepEqual(county.months.map(m => [m.month, m.values.naloxone_kits]), [['2026-03', 16], ['2026-04', 8]]);
  assert.deepEqual(county.months.map(m => m.spend), [1200, 300]);
  // Treatment spending: people served, admissions, people linked to care and to MOUD.
  assert.ok(city.indicators.includes('people_linked') && city.indicators.includes('treatment_admissions'));
  assert.equal(city.values.people_linked, 12);
  assert.equal(city.values.moud_linked, 12);
  assert.equal(city.cost_per.people_linked, 250, '3,000 for 12 people linked to care');
  assert.equal(city.values.treatment_admissions, '<11', 'two admissions: suppressed');
  // Training spending: people trained (3: suppressed), sessions and approved staff training hours (exact).
  assert.equal(state.values.people_trained, '<11');
  assert.equal(state.cost_per.people_trained, null);
  assert.equal(state.values.education_contacts, 3);
  assert.equal(state.values.staff_training_hours, 2, 'approved time only');
  // Nothing anywhere is a small count of people.
  for (const v of [d.total.values, ...d.categories.map(c => c.values), ...d.funds.map(f => f.values), ...d.funds.flatMap(f => f.months.map(m => m.values))]) {
    for (const k of PEOPLE) assert.ok(!small(v[k]), `${k}: ${v[k]}`);
  }
  // By category: one row per Exhibit E category of the funds.
  assert.equal(d.categories.length, 3);
  assert.equal(d.total.spend.approved, 5400); assert.equal(d.total.spend.pending, 100);
  // Nothing client-level.
  const text = JSON.stringify(d);
  for (const n of names) assert.ok(!text.includes(n), 'no names');
  for (const c of H.db.all(`SELECT client_code FROM clients`)) assert.ok(!text.includes(c.client_code), 'no client codes');
  assert.match(d.note, /not an official state reporting system/);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.settlement_outcomes'`));
});

test('exact counts on request, for the roles the funder report lets run them', async () => {
  const f = (await fin.get(`/api/reports/settlement-outcomes?${Q}&counts=exact`)).data;
  assert.equal(f.suppression.mode, 'exact');
  const state = f.funds.find(x => x.name === 'State abatement account');
  assert.equal(state.values.people_trained, 3);
  assert.equal(state.cost_per.people_trained, 300);
  assert.equal(f.funds.find(x => x.name === 'County settlement share').values.reversals, 3);
  assert.equal(f.funds.find(x => x.name === 'City settlement share').values.treatment_admissions, 2);
  const s = (await sup.get(`/api/reports/settlement-outcomes?${Q}&counts=exact&purpose=internal`));
  assert.equal(s.status, 200, 'a supervisor may run it internal, exact');
  assert.equal(s.data.funds.find(x => x.name === 'City settlement share').values.people_served, 15);
});

test('who may run it, and what it never is', async () => {
  assert.equal((await nav.get(`/api/reports/settlement-outcomes?${Q}`)).status, 403, 'a navigator does not account for the settlement money');
  assert.equal((await clin.get(`/api/reports/settlement-outcomes?${Q}`)).status, 403);
  assert.equal((await ro.get(`/api/reports/settlement-outcomes?${Q}`)).status, 403, 'read-only holds no budget:read');
  assert.equal((await admin.get(`/api/reports/settlement-outcomes?${Q}`)).status, 200);
  assert.equal((await sup.get(`/api/reports/settlement-outcomes?${Q}&purpose=publication`)).status, 400, 'never a publication release');
  assert.equal((await fin.get(`/api/reports/settlement-outcomes?${Q}&purpose=internal`)).status, 403, 'finance runs the program\'s own figures only');
  assert.equal((await nav.get(`/api/reports/settlement-outcomes/export?${Q}`)).status, 403);
  assert.equal((await sup.get(`/api/reports/settlement-outcomes?from=2026-13-01&to=2026-04-30`)).status, 400);
});

test('the download: CSV and Excel, made on request, aggregate, labelled with how it counts', async () => {
  const res = await fin.raw(`/api/reports/settlement-outcomes/export?${Q}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /suds-settlement-outcomes-2026-03-01_2026-04-30-internal-suppressed\.csv/);
  assert.equal(res.headers.get('x-suds-report-counts'), 'suppressed (threshold 11)');
  const text = await res.text();
  assert.match(text.split('\r\n')[0], /^﻿?Section,Fund,Category \(Exhibit E\),Measure,Value,Cost per \(\$\)/);
  assert.match(text, /County settlement share/); assert.match(text, /Naloxone kits distributed,24,50/);
  assert.match(text, /<11/);
  assert.match(text, /not an official state reporting system/);
  for (const n of names) assert.ok(!text.includes(n), 'no names');
  for (const c of H.db.all(`SELECT client_code FROM clients`)) assert.ok(!text.includes(c.client_code), 'no client codes');
  const xl = await sup.raw(`/api/reports/settlement-outcomes/export?${Q}&format=xlsx`);
  assert.equal(xl.status, 200);
  assert.match(xl.headers.get('content-type'), /spreadsheetml/);
  const wb = require('../server/spreadsheet').readWorkbook(Buffer.from(await xl.arrayBuffer()));
  assert.deepEqual(wb.map(s => s.name), ['About', 'Outcomes', 'Funds', 'By month']);
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='report.settlement_outcomes.export' ORDER BY id DESC LIMIT 1`).details);
  assert.equal(a.format, 'xlsx'); assert.equal(a.counts, 'suppressed');
});

test('a period that ends before it starts is refused with a clear message, on the page and for the file (1.17.1)', async () => {
  const bad = 'from=2026-09-01&to=2026-01-01';
  const before = H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'report.settlement_outcomes%'`).n;
  for (const path of [`/api/reports/settlement-outcomes?${bad}`, `/api/reports/settlement-outcomes/export?${bad}`, `/api/reports/settlement-outcomes/export?${bad}&format=xlsx`]) {
    const r = await fin.get(path);
    assert.equal(r.status, 400, path);
    assert.match(r.data.error, /start date \(2026-09-01\) is after the end date \(2026-01-01\)/, path);
  }
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'report.settlement_outcomes%'`).n, before, 'nothing was run');
  // One day (from = to) is a period.
  assert.equal((await fin.get('/api/reports/settlement-outcomes?from=2026-03-05&to=2026-03-05')).status, 200);
});

test('no settlement funds: the page says what to do', async () => {
  H.db.run(`UPDATE funding_sources SET source_type='county_general', settlement_use=NULL, settlement_hiaa=NULL WHERE source_type='opioid_settlement'`);
  try {
    const d = (await fin.get(`/api/reports/settlement-outcomes?${Q}`)).data;
    assert.equal(d.funds.length, 0);
    assert.match(d.empty_note, /Opioid settlement/);
  } finally {
    for (const [k, use] of [['county', 'core_a'], ['city', 'approved_a'], ['state', 'approved_k']]) H.db.run(`UPDATE funding_sources SET source_type='opioid_settlement', settlement_use=? WHERE id=?`, use, F[k]);
  }
});
