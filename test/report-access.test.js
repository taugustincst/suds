'use strict';
// Who may run which kind of funder, NDP and settlement report (server/auth.js reportRunAllowed). Small-cell
// suppression inside one report cannot stop two reports being subtracted from each other: the August
// publication release (housing 15 of 15) minus an internal run for 1–30 August (15 of 14) says the one
// person served on 31 August is unhoused. So a run that is not a publication release (purpose internal or
// submission, suppressed or exact) needs reports:internal — supervisors and administrators — or client-level
// access to everyone the run counts (a navigator's or clinician's own caseload). Finance and read-only
// accounts get publication releases only; finance's money and hours are exact in those, and on Budget.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PUB = 'from=2026-08-01&to=2026-08-31';          // one calendar month that has ended: a publication release
const SHORT = 'from=2026-08-01&to=2026-08-30';        // anything else is internal
const RUNS = {
  'default (no purpose asked)': PUB,
  publication: `${PUB}&purpose=publication`,
  'internal (default for a custom range)': SHORT,
  'purpose=internal': `${PUB}&purpose=internal`,
  'purpose=submission': `${PUB}&purpose=submission`,
  'exact counts': `${PUB}&purpose=submission&counts=exact`,
};
const ROLES = ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'];
// What each role may run, per kind of run (the funder report and the NDP log, which count a caseload-scoped
// role's own caseload only).
// A caseload-scoped role's run counts only its caseload, so it is never a publication release: asking for one
// is a bad request (400), not a permission it lacks.
const ALLOWED = {
  admin: ['default (no purpose asked)', 'publication', 'internal (default for a custom range)', 'purpose=internal', 'purpose=submission', 'exact counts'],
  supervisor: ['default (no purpose asked)', 'publication', 'internal (default for a custom range)', 'purpose=internal', 'purpose=submission', 'exact counts'],
  clinician: ['default (no purpose asked)', 'internal (default for a custom range)', 'purpose=internal', 'purpose=submission'],
  navigator: ['default (no purpose asked)', 'internal (default for a custom range)', 'purpose=internal', 'purpose=submission'],
  finance: ['default (no purpose asked)', 'publication'],
  readonly: ['default (no purpose asked)', 'publication'],
};
// What each role's first click is (no purpose asked), for a period that could be published (1.13.0): a
// supervisor's or an administrator's is the programme's own submission to its funder, with exact counts; a
// caseload-scoped role's is internal (its caseload); finance and read-only get the publication release.
const DEFAULT = { admin: ['submission', 'exact'], supervisor: ['submission', 'exact'], clinician: ['internal', 'suppressed'], navigator: ['internal', 'suppressed'], finance: ['publication', 'suppressed'], readonly: ['publication', 'suppressed'] };
const c = {};
let fund;

before(async () => {
  await H.start();
  c.admin = H.client(); await c.admin.login('admin', 'AdminPassw0rd!x');
  for (const role of ROLES.slice(1)) { H.makeUser(`ra${role}`, role); c[role] = H.client(); await c[role].login(`ra${role}`, 'StaffPassw0rd!x'); }
  fund = (await c.admin.post('/api/budget/funds', { name: 'Settlement A', source_type: 'opioid_settlement', total_amount: 10000, fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', settlement_use: 'core_a' })).data.id;
  const id = (await c.supervisor.post('/api/clients', { first_name: 'Augusta', last_name: 'Last', confirm_duplicate: true })).data.id;
  assert.equal((await c.supervisor.post('/api/interventions', { client_id: id, type: 'case_management', occurred_at: '2026-08-31T18:00:00.000Z', funding_source_id: fund })).status, 201);
  assert.equal((await c.supervisor.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: '2026-08-12T18:00:00.000Z', naloxone_kits: 3, location: 'community' })).status, 201);
});
after(async () => { await H.stop(); });

for (const [path, label] of [['/api/reports/funder', 'funder report'], ['/api/reports/naloxone-ndp', 'NDP log']]) {
  test(`${label}: each role × each kind of run`, async () => {
    for (const role of ROLES) {
      for (const [kind, q] of Object.entries(RUNS)) {
        const r = await c[role].get(`${path}?${q}`);
        const want = ALLOWED[role].includes(kind) ? 200 : kind === 'publication' ? 400 : 403;
        assert.equal(r.status, want, `${role}, ${kind}: ${JSON.stringify(r.data).slice(0, 200)}`);
        if (want === 200 && kind === 'default (no purpose asked)') {
          assert.deepEqual([r.data.suppression.purpose, r.data.suppression.mode], DEFAULT[role], role);
          assert.match(r.data.suppression.label, { submission: /^Submission to your funder — not for publication$/, internal: /^Internal — not for publication$/, publication: /^Publication release — small cells screened; review before sharing$/ }[DEFAULT[role][0]], role);
        }
        if (want === 200 && kind === 'publication') assert.equal(r.data.suppression.purpose, 'publication', role);
        if (want === 403 && kind !== 'exact counts') assert.match(r.data.error, /publication release/i, 'the refusal says what the role can run instead');
      }
    }
  });
}

test('funder report and NDP exports follow the same rule (finance holds export:read)', async () => {
  for (const path of ['/api/reports/funder/export', '/api/reports/naloxone-ndp/export']) {
    assert.equal((await c.finance.get(`${path}?${PUB}&format=csv`)).status, 428, `${path}: a publication release needs its review confirmed`);
    assert.equal((await c.finance.get(`${path}?${PUB}&format=csv&reviewed=1`)).status, 200, `${path}: a publication release`);
    assert.equal((await c.finance.get(`${path}?${SHORT}&format=csv`)).status, 403, `${path}: an internal run`);
    assert.equal((await c.finance.get(`${path}?${PUB}&purpose=submission&counts=exact&format=csv`)).status, 403, `${path}: exact counts`);
    assert.equal((await c.supervisor.get(`${path}?${SHORT}&format=csv`)).status, 200);
  }
});

test('a fund-filtered run is internal, so finance and read-only cannot run one (the whole-programme-minus-one-fund difference)', async () => {
  for (const role of ['finance', 'readonly']) assert.equal((await c[role].get(`/api/reports/funder?${PUB}&funding_source_id=${fund}`)).status, 403, role);
  assert.equal((await c.supervisor.get(`/api/reports/funder?${PUB}&funding_source_id=${fund}`)).status, 200);
});

test('the settlement report: publication releases for finance; internal runs need reports:internal, as it is not caseload-scoped', async () => {
  const path = '/api/reports/opioid-settlement';
  const pub = await c.finance.get(`${path}?${PUB}`);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.suppression.purpose, 'publication');
  for (const q of [SHORT, `${PUB}&purpose=submission`, `${PUB}&purpose=submission&counts=exact`]) {
    assert.equal((await c.finance.get(`${path}?${q}`)).status, 403, `finance: ${q}`);
    assert.equal((await c.finance.get(`${path}/export?${q}&format=csv`)).status, 403, `finance export: ${q}`);
    assert.equal((await c.supervisor.get(`${path}?${q}`)).status, 200, `supervisor: ${q}`);
  }
  // A navigator holds budget:read, but the settlement report counts the whole programme's people, not a
  // caseload, and a caseload-scoped run is never a publication release: refused while caseloads are
  // restricted, allowed when they are not (a navigator can then open every client record anyway).
  for (const q of [PUB, SHORT]) {
    const r = await c.navigator.get(`${path}?${q}`);
    assert.equal(r.status, 403, q);
    assert.match(r.data.error, /publication release/i);
  }
  assert.equal((await c.admin.put('/api/admin/settings', { caseload_restriction: '0' })).status, 200);
  try { assert.equal((await c.navigator.get(`${path}?${SHORT}`)).status, 200); } finally { await c.admin.put('/api/admin/settings', { caseload_restriction: '1' }); }
});

test('the settlement report\'s first click per role: the submission for a supervisor or an administrator, the publication release for finance', async () => {
  const path = '/api/reports/opioid-settlement';
  for (const role of ['admin', 'supervisor']) {
    const r = await c[role].get(`${path}?${PUB}`);
    assert.equal(r.status, 200, role);
    assert.deepEqual([r.data.suppression.purpose, r.data.suppression.mode], ['submission', 'exact'], role);
    assert.equal(r.data.suppression.label, 'Submission to your funder — not for publication');
    assert.equal(typeof r.data.services_by_use[0].people, 'number', `${role}: exact counts for the funder`);
    const pub = await c[role].get(`${path}?${PUB}&purpose=publication`);
    assert.equal(pub.data.suppression.purpose, 'publication', `${role}: publication when asked for`);
    assert.ok(Array.isArray(pub.data.release.withheld_reasons), 'a publication release lists what it withheld, with why');
  }
  const f = await c.finance.get(`${path}?${PUB}`);
  assert.deepEqual([f.data.suppression.purpose, f.data.suppression.mode], ['publication', 'suppressed']);
  // A supervisor's submission file says what it is, in its name and on its About sheet.
  const x = await c.supervisor.raw(`${path}/export?${PUB}&format=xlsx`);
  assert.equal(x.status, 200); assert.match(x.headers.get('content-disposition'), /exact-counts\.xlsx/); assert.equal(x.headers.get('x-suds-report-purpose'), 'submission');
});

test('a refused run is audited as a denial naming reports:internal', async () => {
  await c.readonly.get(`/api/reports/funder?${SHORT}`);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='authz.denied' ORDER BY id DESC LIMIT 1`);
  assert.match(a.details, /reports:internal/);
});

test('the permission matrix: reports:internal for supervisors and administrators; reports:exact no longer for finance', () => {
  const auth = require('../server/auth');
  const u = (role) => ({ id: 'x', role });
  for (const role of ['admin', 'supervisor']) { assert.ok(auth.hasPerm(u(role), 'reports:internal'), role); assert.ok(auth.hasPerm(u(role), 'reports:exact'), role); }
  for (const role of ['clinician', 'navigator', 'finance', 'readonly']) { assert.ok(!auth.hasPerm(u(role), 'reports:internal'), role); assert.ok(!auth.hasPerm(u(role), 'reports:exact'), role); }
});

test('the monthly trends report (exact programme-wide counts of people, an insider view) is audited', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.monthly'`).n;
  assert.equal((await c.readonly.get('/api/reports/monthly?months=3')).status, 200);
  const row = H.db.one(`SELECT user_id, details FROM audit_log WHERE action='report.monthly' ORDER BY rowid DESC LIMIT 1`);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.monthly'`).n, before + 1);
  assert.ok(row.user_id, 'the entry names who read it');
  assert.match(row.details, /"months":3/);
});
