'use strict';
// Who may run which kind of funder, NDP and settlement report (server/auth.js reportRunAllowed and, since
// 1.14.0, submissionRunAllowed). Small-cell suppression inside one report cannot stop two reports being
// subtracted from each other: the August publication release (housing 15 of 15) minus an internal run for
// 1–30 August (15 of 14) says the one person served on 31 August is unhoused. So a run that is not a
// publication release (purpose internal or submission, suppressed or exact) needs reports:internal —
// supervisors and administrators — or client-level access to everyone the run counts (from 1.16.0 a navigator
// or clinician holds clients:all and so sees the whole programme; one the programme holds to their caseload
// with a per-user deny of clients:all counts its own caseload only). The one exception is reports:funder (finance): the programme's own SUBMISSION to
// its funder — exact aggregate counts, by fund and for any range — without clients:read and without anything
// client-level. Read-only accounts get publication releases only.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PUB = 'from=2026-08-01&to=2026-08-31';          // one calendar month that has ended: a publication release
const SHORT = 'from=2026-08-01&to=2026-08-30';        // anything else is internal
const RUNS = {
  'default (no purpose asked)': PUB,
  publication: `${PUB}&purpose=publication`,
  'custom range (no purpose asked)': SHORT,
  'purpose=internal': `${PUB}&purpose=internal`,
  'purpose=submission': `${PUB}&purpose=submission`,
  'exact counts': `${PUB}&purpose=submission&counts=exact`,
  'custom range submission, exact': `${SHORT}&purpose=submission&counts=exact`,
  'submission, small cells suppressed': `${SHORT}&purpose=submission&counts=suppressed`,
  'internal, exact': `${SHORT}&purpose=internal&counts=exact`,
};
const ROLES = ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly', 'clinician_scoped', 'navigator_scoped'];
// A navigator or clinician held to their caseload (clients:all denied), as both roles were before 1.16.0.
const SCOPED = { clinician_scoped: 'clinician', navigator_scoped: 'navigator' };
const ALL = Object.keys(RUNS);
// What each role may run, per kind of run (the funder report and the NDP log, which count a caseload-scoped
// role's own caseload only). A caseload-scoped role's run counts only its caseload, so it is never a
// publication release: asking for one is a bad request (400), not a permission it lacks.
const ALLOWED = {
  admin: ALL,
  supervisor: ALL,
  // 1.16.0: clients:all, so the whole programme: a publication release can be asked for too (was: 400, a
  // caseload run is never one). Still no exact counts (reports:exact).
  clinician: ['default (no purpose asked)', 'publication', 'custom range (no purpose asked)', 'purpose=internal', 'purpose=submission', 'submission, small cells suppressed'],
  navigator: ['default (no purpose asked)', 'publication', 'custom range (no purpose asked)', 'purpose=internal', 'purpose=submission', 'submission, small cells suppressed'],
  clinician_scoped: ['default (no purpose asked)', 'custom range (no purpose asked)', 'purpose=internal', 'purpose=submission', 'submission, small cells suppressed'],
  navigator_scoped: ['default (no purpose asked)', 'custom range (no purpose asked)', 'purpose=internal', 'purpose=submission', 'submission, small cells suppressed'],
  // reports:funder: every submission run (exact or suppressed, any range) and a publication release; never an internal run.
  finance: ['default (no purpose asked)', 'publication', 'custom range (no purpose asked)', 'purpose=submission', 'exact counts', 'custom range submission, exact', 'submission, small cells suppressed'],
  readonly: ['default (no purpose asked)', 'publication'],
};
// What each role's first click is (no purpose asked), for a period that could be published: a supervisor's,
// an administrator's and (1.14.0) finance's is the programme's own submission to its funder, with exact
// counts; a navigator's and a clinician's is internal (the whole programme from 1.16.0, or their caseload when
// held to it; server/funder-report.js countingMode); read-only gets the publication release.
const DEFAULT = { admin: ['submission', 'exact'], supervisor: ['submission', 'exact'], clinician: ['internal', 'suppressed'], navigator: ['internal', 'suppressed'], finance: ['submission', 'exact'], readonly: ['publication', 'suppressed'], clinician_scoped: ['internal', 'suppressed'], navigator_scoped: ['internal', 'suppressed'] };
const c = {};
let fund; let clientId; let clientCode;

before(async () => {
  await H.start();
  c.admin = H.client(); await c.admin.login('admin', 'AdminPassw0rd!x');
  for (const role of ROLES.slice(1)) { (SCOPED[role] ? H.makeCaseloadUser(`ra${role}`, SCOPED[role]) : H.makeUser(`ra${role}`, role)); c[role] = H.client(); await c[role].login(`ra${role}`, 'StaffPassw0rd!x'); }
  fund = (await c.admin.post('/api/budget/funds', { name: 'Settlement A', source_type: 'opioid_settlement', total_amount: 10000, fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', settlement_use: 'core_a' })).data.id;
  const id = (await c.supervisor.post('/api/clients', { first_name: 'Augusta', last_name: 'Last', confirm_duplicate: true })).data.id;
  clientId = id; clientCode = H.db.one(`SELECT client_code FROM clients WHERE id=?`, id).client_code;
  assert.equal((await c.supervisor.post('/api/interventions', { client_id: id, type: 'case_management', occurred_at: H.localAt('2026-08-31', 11), funding_source_id: fund })).status, 201);
  assert.equal((await c.supervisor.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: H.localAt('2026-08-12', 11), naloxone_kits: 3, location: 'community' })).status, 201);
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
        if (want === 200 && /exact/.test(kind)) assert.equal(r.data.suppression.mode, 'exact', `${role}, ${kind}`);
        if (want === 403 && !/exact/.test(kind)) assert.match(r.data.error, /publication release/i, 'the refusal says what the role can run instead');
      }
    }
  });
}

test('funder report and NDP exports follow the same rule (finance holds export:read and reports:funder)', async () => {
  for (const path of ['/api/reports/funder/export', '/api/reports/naloxone-ndp/export']) {
    assert.equal((await c.finance.get(`${path}?${PUB}&purpose=publication&format=csv`)).status, 428, `${path}: a publication release needs its review confirmed`);
    assert.equal((await c.finance.get(`${path}?${PUB}&purpose=publication&format=csv&reviewed=1`)).status, 200, `${path}: a publication release`);
    const sub = await c.finance.raw(`${path}?${SHORT}&format=csv`);
    assert.equal(sub.status, 200, `${path}: the submission, custom range`);
    assert.equal(sub.headers.get('x-suds-report-purpose'), 'submission'); assert.equal(sub.headers.get('x-suds-report-counts'), 'exact');
    assert.equal((await c.finance.get(`${path}?${PUB}&purpose=submission&counts=exact&format=csv`)).status, 200, `${path}: exact counts for the submission`);
    assert.equal((await c.finance.get(`${path}?${SHORT}&purpose=internal&format=csv`)).status, 403, `${path}: an internal run`);
    assert.equal((await c.readonly.get(`${path}?${SHORT}&format=csv`)).status, 403, `${path}: read-only holds no export:read`);
    assert.equal((await c.supervisor.get(`${path}?${SHORT}&format=csv`)).status, 200);
  }
});

test('a fund-filtered run: finance runs it as the submission (reports:funder); read-only cannot', async () => {
  const f = await c.finance.get(`/api/reports/funder?${PUB}&funding_source_id=${fund}`);
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.deepEqual([f.data.suppression.purpose, f.data.suppression.mode, f.data.funding_source_id], ['submission', 'exact', fund]);
  assert.equal(f.data.unduplicated.served, 1, 'an exact count of one person, for the funder');
  assert.equal((await c.finance.get(`/api/reports/funder?${PUB}&funding_source_id=${fund}&purpose=internal`)).status, 403, 'never an internal run');
  assert.equal((await c.readonly.get(`/api/reports/funder?${PUB}&funding_source_id=${fund}`)).status, 403);
  assert.equal((await c.supervisor.get(`/api/reports/funder?${PUB}&funding_source_id=${fund}`)).status, 200);
});

test('reports:funder is aggregate only: no names, codes or client ids in any submission run finance makes', async () => {
  for (const path of ['/api/reports/funder', '/api/reports/naloxone-ndp', '/api/reports/opioid-settlement']) {
    for (const q of [SHORT, `${PUB}&funding_source_id=${fund}`]) {
      const r = await c.finance.get(`${path}?${q}`);
      assert.equal(r.status, 200, `${path}?${q}: ${JSON.stringify(r.data).slice(0, 200)}`);
      const text = JSON.stringify(r.data);
      for (const leak of ['Augusta', 'Last', clientCode, clientId]) assert.ok(!text.includes(leak), `${path}: ${leak} must not appear`);
    }
  }
});

test('reports:funder unlocks nothing client-level: no client record, no identified export, the dashboard stays masked', async () => {
  assert.equal((await c.finance.get(`/api/clients/${clientId}`)).status, 403);
  assert.equal((await c.finance.get(`/api/reports/export/workbook?${SHORT}&identified=1&recipient=Funder&purpose=Report&basis=consent`)).status, 200, 'an export is made, but de-identified (no export:identified)');
  const x = await c.finance.raw(`/api/reports/export/clients?${SHORT}&identified=1&recipient=Funder&purpose=Report&basis=consent`);
  assert.match(x.headers.get('x-suds-export') || '', /de-identified|Safe Harbor/i, 'finance cannot make an identified export');
  const d = await c.finance.get(`/api/reports/dashboard?${SHORT}`);
  assert.equal(d.status, 200); assert.equal(d.data.small_cells && d.data.small_cells.masked, true, 'dashboard-mask.js still masks finance');
  const m = await c.finance.get('/api/reports/monthly?months=3');
  assert.equal(m.data.small_cells && m.data.small_cells.masked, true, 'the monthly trends stay masked');
});

test('every submission run finance makes is audited: who, purpose, fund and period', async () => {
  const fin = H.db.one(`SELECT id FROM users WHERE username='rafinance'`).id;
  await c.finance.get(`/api/reports/funder?${SHORT}&funding_source_id=${fund}`);
  const a = H.db.one(`SELECT user_id, details FROM audit_log WHERE action='report.funder' ORDER BY id DESC LIMIT 1`);
  assert.equal(a.user_id, fin);
  const d = JSON.parse(a.details);
  assert.deepEqual([d.purpose, d.counts, d.funding_source_id, d.from, d.to], ['submission', 'exact', fund, '2026-08-01', '2026-08-30']);
  await c.finance.get(`/api/reports/naloxone-ndp?${SHORT}`);
  const n = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='report.naloxone_ndp' ORDER BY id DESC LIMIT 1`).details);
  assert.deepEqual([n.purpose, n.from, n.to], ['submission', '2026-08-01', '2026-08-30']);
  await c.finance.get(`/api/reports/opioid-settlement/export?${SHORT}&format=csv`);
  const e = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='report.opioid_settlement.export' ORDER BY id DESC LIMIT 1`).details);
  assert.equal(e.purpose, 'submission');
});

test('the settlement report: finance runs the submission (any range) and publication releases; internal runs need reports:internal', async () => {
  const path = '/api/reports/opioid-settlement';
  const pub = await c.finance.get(`${path}?${PUB}&purpose=publication`);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.suppression.purpose, 'publication');
  for (const q of [SHORT, `${PUB}&purpose=submission`, `${PUB}&purpose=submission&counts=exact`]) {
    assert.equal((await c.finance.get(`${path}?${q}`)).status, 200, `finance: ${q}`);
    assert.equal((await c.finance.get(`${path}/export?${q}&format=csv`)).status, 200, `finance export: ${q}`);
    assert.equal((await c.supervisor.get(`${path}?${q}`)).status, 200, `supervisor: ${q}`);
  }
  for (const q of [`${SHORT}&purpose=internal`, `${PUB}&purpose=internal&counts=exact`]) {
    assert.equal((await c.finance.get(`${path}?${q}`)).status, 403, `finance: ${q}`);
    assert.equal((await c.finance.get(`${path}/export?${q}&format=csv`)).status, 403, `finance export: ${q}`);
  }
  // A navigator holds budget:read, but the settlement report counts the whole programme's people, not a
  // caseload, and a caseload-scoped run is never a publication release: for a navigator held to their caseload
  // it is refused while caseloads are restricted, allowed when they are not (they can then open every client
  // record anyway). From 1.16.0 a navigator with the role's defaults holds clients:all, and runs it, as does a
  // clinician (budget:read from 1.16.0).
  for (const q of [PUB, SHORT]) {
    const r = await c.navigator_scoped.get(`${path}?${q}`);
    assert.equal(r.status, 403, q);
    assert.match(r.data.error, /publication release/i);
    assert.equal((await c.navigator.get(`${path}?${q}`)).status, 200, `navigator (clients:all): ${q}`);
    assert.equal((await c.clinician.get(`${path}?${q}`)).status, 200, `clinician (clients:all, budget:read): ${q}`);
  }
  assert.equal((await c.navigator.get(`${path}?${SHORT}`)).data.suppression.purpose, 'internal', 'a navigator\'s run is internal');
  assert.equal((await c.admin.put('/api/admin/settings', { caseload_restriction: '0' })).status, 200);
  try { assert.equal((await c.navigator_scoped.get(`${path}?${SHORT}`)).status, 200); } finally { await c.admin.put('/api/admin/settings', { caseload_restriction: '1' }); }
});

test('the settlement report\'s first click per role: the submission for a supervisor, an administrator and finance', async () => {
  const path = '/api/reports/opioid-settlement';
  for (const role of ['admin', 'supervisor', 'finance']) {
    const r = await c[role].get(`${path}?${PUB}`);
    assert.equal(r.status, 200, role);
    assert.deepEqual([r.data.suppression.purpose, r.data.suppression.mode], ['submission', 'exact'], role);
    assert.equal(r.data.suppression.label, 'Submission to your funder — not for publication');
    assert.equal(typeof r.data.services_by_use[0].people, 'number', `${role}: exact counts for the funder`);
    const pub = await c[role].get(`${path}?${PUB}&purpose=publication`);
    assert.equal(pub.data.suppression.purpose, 'publication', `${role}: publication when asked for`);
    assert.ok(Array.isArray(pub.data.release.withheld_reasons), 'a publication release lists what it withheld, with why');
  }
  // A supervisor's submission file says what it is, in its name and on its About sheet.
  const x = await c.supervisor.raw(`${path}/export?${PUB}&format=xlsx`);
  assert.equal(x.status, 200); assert.match(x.headers.get('content-disposition'), /exact-counts\.xlsx/); assert.equal(x.headers.get('x-suds-report-purpose'), 'submission');
});

test('a refused run is audited as a denial naming reports:internal', async () => {
  await c.readonly.get(`/api/reports/funder?${SHORT}`);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='authz.denied' ORDER BY id DESC LIMIT 1`);
  assert.match(a.details, /reports:internal/);
});

test('the permission matrix: reports:internal and reports:exact for supervisors and administrators; reports:funder also for finance', () => {
  const auth = require('../server/auth');
  const u = (role) => ({ id: 'x', role });
  for (const role of ['admin', 'supervisor']) for (const p of ['reports:internal', 'reports:exact', 'reports:funder']) assert.ok(auth.hasPerm(u(role), p), `${role} ${p}`);
  for (const role of ['clinician', 'navigator', 'finance', 'readonly']) { assert.ok(!auth.hasPerm(u(role), 'reports:internal'), role); assert.ok(!auth.hasPerm(u(role), 'reports:exact'), role); }
  assert.ok(auth.hasPerm(u('finance'), 'reports:funder'));
  assert.ok(auth.submissionRunAllowed(u('finance')));
  for (const role of ['clinician', 'navigator', 'readonly']) assert.ok(!auth.hasPerm(u(role), 'reports:funder'), role);
  // It must not widen anything else: no client records, no identified exports, and the dashboard mask stays.
  assert.ok(!auth.hasPerm(u('finance'), 'clients:read')); assert.ok(!auth.hasPerm(u('finance'), 'export:identified'));
  assert.ok(!auth.reportRunAllowed(u('finance'), { caseloadScoped: true }), 'dashboard-mask.js keys on reportRunAllowed, which reports:funder does not change');
});

test('publication releases switched off (module publication): refused with a clear message; submissions carry on', async () => {
  assert.equal((await c.admin.put('/api/admin/settings', { module_publication: '0' })).status, 200);
  try {
    for (const path of ['/api/reports/funder', '/api/reports/naloxone-ndp', '/api/reports/opioid-settlement']) {
      for (const role of ['admin', 'supervisor', 'finance']) {
        const pub = await c[role].get(`${path}?${PUB}&purpose=publication`);
        assert.equal(pub.status, 403, `${role} ${path}`);
        assert.match(pub.data.error, /Publication releases are switched off/);
        assert.match(pub.data.error, /submission to its funder instead/);
        const sub = await c[role].get(`${path}?${PUB}`);
        assert.equal(sub.status, 200, `${role} ${path}: the submission is unaffected`);
        assert.equal(sub.data.suppression.purpose, 'submission');
        assert.equal((await c[role].get(`${path}/export?${PUB}&purpose=publication&reviewed=1&format=csv`)).status, 403, `${role} ${path}: its files too`);
      }
      // Read-only runs publication releases only: nothing to run, and it is told why.
      for (const q of [PUB, SHORT]) {
        const r = await c.readonly.get(`${path}?${q}`);
        if (path === '/api/reports/opioid-settlement') { assert.equal(r.status, 403); continue; } // needs budget:read
        assert.equal(r.status, 403, `readonly ${path}?${q}`);
        assert.match(r.data.error, /Publication releases are switched off/);
        assert.match(r.data.error, /nothing to run/);
      }
    }
    const me = await c.readonly.get('/api/auth/me');
    assert.equal(me.data.programme.modules.publication, false, 'the screens are told');
  } finally { await c.admin.put('/api/admin/settings', { module_publication: null }); }
  assert.equal((await c.readonly.get(`/api/reports/funder?${PUB}`)).status, 200, 'on again: the default');
});

test('the monthly trends report (exact programme-wide counts of people, an insider view) is audited', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.monthly'`).n;
  assert.equal((await c.readonly.get('/api/reports/monthly?months=3')).status, 200);
  const row = H.db.one(`SELECT user_id, details FROM audit_log WHERE action='report.monthly' ORDER BY rowid DESC LIMIT 1`);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='report.monthly'`).n, before + 1);
  assert.ok(row.user_id, 'the entry names who read it');
  assert.match(row.details, /"months":3/);
});
