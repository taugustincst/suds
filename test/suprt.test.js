'use strict';
// SUPRT-A (server/suprt.js, server/routes/suprt.js, docs/compliance/SUPRT.md): SAMHSA's client-level record
// for a State Opioid Response grant. The module switches on with a SOR grant fund; items SUDS already holds
// are pre-filled from the client record and the rest asked; the answers are encrypted; the windows around
// each anniversary drive the to-do list and the completion rates; and the file for entry into SPARS is a
// disclosure — refused without a consent naming the recipient, accounted for client by client when made.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const S = require('../server/suprt');

let admin, sup, nav, fin, ro, clientId, code, other, otherCode, fund;
const ELEMENTS = { signed_at: '2026-01-02', scope: 'SUPRT-A performance data', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };

before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const [u, role] of [['ssup', 'supervisor'], ['snav', 'navigator'], ['sfin', 'finance'], ['sro', 'readonly']]) H.makeUser(u, role);
  sup = H.client(); await sup.login('ssup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('snav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('sfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('sro', 'StaffPassw0rd!x');
  const c = await nav.post('/api/clients', { first_name: 'Sora', last_name: 'Baseline', dob: '1990-04-05', gender: 'female', veteran: true, housing_status: 'unsheltered', primary_substance: 'opioids_fentanyl', route_of_use: 'smoking', mat_status: 'active', mat_medication: 'buprenorphine', overdose_history: true, co_occurring_mh: true, intake_date: '2026-01-05', status: 'active' });
  assert.equal(c.status, 201, JSON.stringify(c.data)); clientId = c.data.id;
  code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, clientId).client_code;
  const o = await nav.post('/api/clients', { first_name: 'Otto', last_name: 'Missed', status: 'active', intake_date: '2026-01-05' });
  other = o.data.id; otherCode = H.db.one(`SELECT client_code FROM clients WHERE id=?`, other).client_code;
});
after(async () => { await H.stop(); });

test('the module is off for a programme with no SOR fund, and on once it has one', async () => {
  let me = (await nav.get('/api/auth/me')).data;
  assert.equal(me.programme.modules.suprt, false);
  const r = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10' });
  assert.equal(r.status, 403); assert.equal(r.data.module, 'suprt');
  const f = await admin.post('/api/budget/funds', { name: 'SOR IV', source_type: 'sor_grant', total_amount: 50000, fiscal_year_start: '2025-10-01', fiscal_year_end: '2026-09-29' });
  assert.equal(f.status, 201, JSON.stringify(f.data)); fund = f.data.id;
  me = (await nav.get('/api/auth/me')).data;
  assert.equal(me.programme.modules.suprt, true, 'a SOR grant fund switches SUPRT-A on by default');
  // Visits that the pre-fill reads: a SOR-funded case management visit with naloxone, and an overdose.
  for (const [id, at, type, kits] of [[clientId, '2026-01-06T17:00:00.000Z', 'case_management', 0], [clientId, '2026-03-02T17:00:00.000Z', 'naloxone_distribution', 2], [clientId, '2026-06-20T17:00:00.000Z', 'peer_support', 0], [other, '2026-01-07T17:00:00.000Z', 'case_management', 0]]) {
    const v = await nav.post('/api/interventions', { client_id: id, type, occurred_at: at, funding_source_id: fund, naloxone_kits: kits });
    assert.equal(v.status, 201, JSON.stringify(v.data));
  }
  assert.equal((await nav.post(`/api/clients/${clientId}/problems`, { problem: 'Opioid use disorder', icd10_code: 'f1120' })).status, 201);
  assert.equal((await sup.post(`/api/clients/${clientId}/outcomes`, { instrument: 'phq9', administered_at: '2026-01-08', responses: [2, 2, 2, 2, 2, 1, 1, 0, 1] })).status, 201);
});

test('pre-fill: the answers SUDS already holds come from the client record; the rest are asked', async () => {
  const r = await nav.get(`/api/clients/${clientId}/suprt/prefill?type=baseline&date=2026-01-10`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = r.data.answers;
  assert.equal(a.A_client_id, code);
  assert.equal(a.A_first_service_date, '2026-01-05', 'the intake date is before the first visit');
  assert.equal(a.B_primary_substance, 'opioids_fentanyl');
  assert.equal(a.B_moud, 'yes'); assert.equal(a.B_moud_medication, 'buprenorphine');
  assert.equal(a.B_overdose_ever, 'yes'); assert.equal(a.B_co_occurring_mh, 'yes');
  assert.equal(a.C_mental_health_screen, 'positive', 'PHQ-9 of 13'); assert.equal(a.C_suicide_risk_screen, 'positive', 'PHQ-9 item 9 above not at all');
  assert.equal(a.D_icd10_codes, 'F11.20'); assert.equal(a.D_oud, 'yes'); assert.equal(a.D_stimulant_use_disorder, 'no');
  assert.equal(a.F_date_of_birth, '1990-04-05'); assert.equal(a.F_veteran, 'yes'); assert.equal(a.F_housing, 'unsheltered');
  for (const asked of ['A_suprt_c', 'B_crisis_since_last', 'B_residential_tx_since_last', 'C_trauma_screen']) assert.ok(!(asked in a), `${asked} is asked, not derived`);
  assert.ok(!Object.keys(a).some(k => k.startsWith('E_')), 'services received are not asked at baseline');
  assert.ok(r.data.derived.includes('D_oud') && !r.data.derived.includes('A_suprt_c'));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='suprt.prefill' AND client_id=?`, clientId), 'reading the record to pre-fill is audited');
});

test('a baseline: required items before it is complete, stored encrypted, the order of a cycle kept', async () => {
  const pre = (await nav.get(`/api/clients/${clientId}/suprt/prefill?type=baseline&date=2026-01-10`)).data.answers;
  let r = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'complete', answers: pre });
  assert.equal(r.status, 400); assert.match(r.data.error, /Client questionnaire/);
  r = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'complete', answers: { ...pre, A_suprt_c: 'maybe' } });
  assert.equal(r.status, 400, 'a choice must be one of its options');
  r = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'complete', answers: { ...pre, E_naloxone: 'yes' } });
  assert.equal(r.status, 400, 'an item not asked at baseline is refused');
  r = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-10', status: 'complete', answers: { ...pre, A_suprt_c: 'declined', C_trauma_screen: 'not_screened' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.derived_keys.includes('D_oud') && !r.data.derived_keys.includes('A_suprt_c'), 'the record says which answers came from the client record');
  const raw = H.db.one(`SELECT * FROM suprt_assessments WHERE id=?`, r.data.id);
  assert.match(raw.answers_enc, /^v1:/);
  for (const [k, v] of Object.entries(raw)) if (k !== 'answers_enc' && typeof v === 'string') for (const phi of [code, '1990-04-05', 'F11.20']) assert.ok(!v.includes(phi), `${k} holds no PHI in the clear`);
  assert.ok(!JSON.stringify(H.db.all(`SELECT details FROM audit_log WHERE action LIKE 'suprt.%'`)).includes('1990-04-05'), 'no PHI in the audit log');
  // Another baseline while this cycle is open is refused; a reassessment for a client with none is too.
  assert.equal((await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-02-10', status: 'complete', answers: { A_first_service_date: '2026-01-05', A_suprt_c: 'completed' } })).status, 400);
  const x = await nav.post(`/api/clients/${other}/suprt`, { assessment_type: 'reassessment', assessment_date: '2026-07-01', status: 'complete', answers: { A_first_service_date: '2026-01-05', A_suprt_c: 'completed' } });
  assert.equal(x.status, 400); assert.match(JSON.stringify(x.data), /baseline first/);
  assert.equal((await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'reassessment', assessment_date: '2099-01-01' })).status, 400, 'not in the future');
  // Reading it back.
  const list = await nav.get(`/api/clients/${clientId}/suprt`);
  assert.equal(list.status, 200); assert.equal(list.data.rows[0].answers.A_suprt_c, 'declined'); assert.equal(list.data.cycle.baseline, '2026-01-10');
});

test('the windows: a reassessment 180 days after baseline (or 90), annual every 365, 30 days either side', () => {
  const sch = (on, extra = {}) => S.schedule({ baseline: '2026-01-10', on, reassessDays: 180, ...extra });
  const re = (on, extra) => sch(on, extra).find(e => e.type === 'reassessment');
  assert.deepEqual([re('2026-05-01').due, re('2026-05-01').opens, re('2026-05-01').closes], ['2026-07-09', '2026-06-09', '2026-08-08']);
  assert.equal(re('2026-06-08').status, 'upcoming');
  assert.equal(re('2026-06-09').status, 'open'); assert.equal(re('2026-06-09').overdue, false);
  assert.equal(re('2026-07-20').status, 'open'); assert.equal(re('2026-07-20').overdue, true, 'past the anniversary, window still open');
  assert.equal(re('2026-08-09').status, 'missed');
  assert.equal(re('2026-08-09', { done: [{ type: 'reassessment', date: '2026-07-01' }] }).status, 'done');
  assert.equal(re('2026-08-09', { done: [{ type: 'reassessment', date: '2026-07-01' }] }).in_window, true);
  const late = re('2026-09-01', { done: [{ type: 'reassessment', date: '2026-08-20' }] });
  assert.deepEqual([late.status, late.in_window], ['done', false], 'a late reassessment is taken, and said to be late');
  assert.equal(S.schedule({ baseline: '2026-01-10', on: '2026-03-01', reassessDays: 90 }).find(e => e.type === 'reassessment').due, '2026-04-10');
  const annual = sch('2027-01-01').filter(e => e.type === 'annual');
  assert.deepEqual(annual.map(e => [e.due, e.status]), [['2027-01-10', 'open'], ['2028-01-10', 'upcoming']], 'up to the next one not yet open');
  assert.deepEqual(sch('2028-03-01').filter(e => e.type === 'annual').map(e => [e.due, e.status]), [['2027-01-10', 'missed'], ['2028-01-10', 'missed'], ['2029-01-09', 'upcoming']]);
  // A closeout ends the cycle: what had not opened is dropped, what was open is not required.
  const closed = sch('2026-09-01', { closeout: '2026-06-20' });
  assert.equal(closed.find(e => e.type === 'reassessment').status, 'not_required');
  assert.ok(!closed.some(e => e.type === 'annual'));
  // Services ended with no closeout: one is due within 30 days of the discharge.
  const d = sch('2026-05-10', { discharge: '2026-05-01' }).find(e => e.type === 'closeout');
  assert.deepEqual([d.due, d.status], ['2026-05-31', 'open']);
  assert.equal(sch('2026-06-10', { discharge: '2026-05-01' }).find(e => e.type === 'closeout').status, 'missed');
});

test('the to-do list: due and overdue follow-ups for the worker\'s caseload and the supervisor\'s team', async () => {
  const n = await nav.get('/api/suprt/due');
  assert.equal(n.status, 200, JSON.stringify(n.data));
  const mine = n.data.rows.find(x => x.client_id === other);
  assert.ok(mine, 'a client with a SOR-funded service and no baseline needs one');
  assert.equal(mine.type, 'baseline'); assert.equal(mine.overdue, true); assert.equal(mine.name, 'Otto Missed');
  const s = await sup.get('/api/suprt/due');
  assert.ok(s.data.rows.some(x => x.client_id === other && x.workers.includes('snav')), 'the supervisor sees the team, and who has the client');
  assert.equal((await fin.get('/api/suprt/due')).status, 403, 'finance opens no client records');
  assert.equal((await ro.get('/api/suprt/due')).status, 403);
  // The reassessment (due 2026-07-09) was missed on the day this suite runs, unless it is recorded.
  const today = S.today();
  if (today > '2026-08-08') assert.ok(s.data.rows.every(x => !(x.client_id === clientId && x.type === 'reassessment')), 'a missed reassessment is not a to-do: its window has closed');
});

test('completion rates per period: done within the window, of those whose window has closed', async () => {
  // Record the reassessment in its window, then the other client's baseline.
  const pre = (await nav.get(`/api/clients/${clientId}/suprt/prefill?type=reassessment&date=2026-07-01`)).data.answers;
  // Services since the last assessment (the baseline on 10 January), from the visits between the two.
  assert.equal(pre.E_naloxone, 'yes'); assert.equal(pre.E_peer_recovery_support, 'yes'); assert.equal(pre.E_moud, 'yes'); assert.equal(pre.E_housing_support, 'no');
  assert.equal(pre.E_case_management, 'no', 'the case management visit was before the baseline');
  assert.ok(!('F_date_of_birth' in pre), 'demographics are asked at baseline only');
  const r = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'reassessment', assessment_date: '2026-07-01', status: 'complete', answers: { ...pre, A_suprt_c: 'completed' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const b = await nav.post(`/api/clients/${other}/suprt`, { assessment_type: 'baseline', assessment_date: '2026-01-20', status: 'complete', answers: { A_first_service_date: '2026-01-05', A_suprt_c: 'completed' } });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  const c = await sup.get('/api/suprt/completion?from=2026-07-01&to=2026-07-31');
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const re = c.data.by_type.find(x => x.type === 'reassessment');
  assert.equal(re.due, 2); assert.equal(re.done_in_window, 1);
  if (S.today() > '2026-08-18') { assert.equal(re.missed, 1); assert.equal(re.rate, 50); }
  assert.equal(c.data.baselines_recorded, 0, 'the baselines were in January');
  assert.equal((await sup.get('/api/suprt/completion?from=2026-01-01&to=2026-01-31')).data.baselines_recorded, 2);
  assert.equal((await fin.get('/api/suprt/completion')).status, 403);
});

test('the SPARS entry file is a disclosure: refused without a consent naming the recipient, accounted for when made', async () => {
  const q = 'from=2026-01-01&to=2026-08-31';
  assert.equal((await nav.get(`/api/suprt/export?${q}`)).status, 403, 'export:identified: supervisors and administrators');
  const before = H.db.one(`SELECT COUNT(*) n FROM disclosures`).n;
  const refused = await sup.get(`/api/suprt/export?${q}`);
  assert.equal(refused.status, 409, JSON.stringify(refused.data)); assert.equal(refused.data.code, 'no_consent');
  assert.match(refused.data.error, /consent on file naming "SAMHSA"/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures`).n, before, 'nothing accounted: nothing left');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='suprt.export.refused'`));
  assert.equal((await sup.get(`/api/suprt/export?${q}&basis=internal&recipient=SAMHSA`)).status, 400, 'not an internal disclosure');
  assert.equal((await sup.get(`/api/suprt/export?${q}&basis=audit_evaluation`)).status, 400, 'an audit basis needs the approval on file');
  // One client consents to SPARS reporting: the file carries that client only, and says who was left out.
  const k = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'SAMHSA', purpose: 'SOR performance reporting', ...ELEMENTS });
  assert.equal(k.status, 201, JSON.stringify(k.data));
  const x = await sup.raw(`/api/suprt/export?${q}`);
  assert.equal(x.status, 200);
  const body = await x.text();
  const lines = body.split('\r\n');
  assert.equal(lines[0].split(',')[0], 'A_client_id', 'SUDS variable names, section A first');
  assert.ok(lines[0].indexOf('B_primary_substance') < lines[0].indexOf('F_date_of_birth'));
  assert.equal(lines.filter(l => l.startsWith(code)).length, 2, 'the baseline and the reassessment');
  assert.ok(!body.includes(otherCode), 'the client without a consent is left out');
  assert.match(body, /For entry into SPARS - check against the current SUPRT handbook/);
  assert.match(x.headers.get('content-disposition'), /for-entry-into-SPARS-check-against-current-handbook\.csv/);
  assert.equal(x.headers.get('x-suds-export-excluded'), otherCode);
  const acc = H.db.all(`SELECT * FROM disclosures WHERE source='suprt'`);
  assert.equal(acc.length, 1); assert.equal(acc[0].client_id, clientId); assert.equal(acc[0].basis, 'consent'); assert.ok(acc[0].consent_id);
  assert.equal(require('../server/crypto').decrypt(acc[0].recipient_enc), 'SAMHSA');
  assert.ok(H.db.one(`SELECT exported_at FROM suprt_assessments WHERE client_id=? AND assessment_type='baseline'`, clientId).exported_at);
  assert.equal(H.db.one(`SELECT exported_at FROM suprt_assessments WHERE client_id=?`, other).exported_at, null);
  const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='suprt.export' ORDER BY id DESC LIMIT 1`).details);
  assert.deepEqual([a.clients_disclosed, a.assessments, a.left_out, a.basis], [1, 2, 1, 'consent']);
  // An exported assessment is corrected, not deleted.
  const id = H.db.one(`SELECT id FROM suprt_assessments WHERE client_id=? AND assessment_type='baseline'`, clientId).id;
  assert.equal((await nav.del(`/api/suprt/${id}`)).status, 409);
  // Under an audit or evaluation approval on file with SAMHSA, the whole file.
  const ag = await H.agreement(sup, 'SAMHSA', 'audit_evaluation');
  const y = await sup.raw(`/api/suprt/export?${q}&basis=audit_evaluation&agreement_id=${ag}`);
  assert.equal(y.status, 200); assert.ok((await y.text()).includes(otherCode));
  // Closeouts go in a file of their own.
  assert.equal((await sup.get(`/api/suprt/export?${q}&set=closeout`)).status, 400, 'no closeout yet');
});

test('a closeout, pre-filled from the discharge; switched off, the module stops new records but not reads', async () => {
  assert.equal((await nav.put(`/api/clients/${other}`, { status: 'inactive', discharge_date: '2026-08-01', discharge_reason: 'lost_contact' })).status, 200);
  const due = (await nav.get('/api/suprt/due')).data.rows.find(x => x.client_id === other && x.type === 'closeout');
  assert.ok(due, 'a closeout is due once services end'); assert.equal(due.due, '2026-08-31');
  const pre = (await nav.get(`/api/clients/${other}/suprt/prefill?type=closeout&date=2026-08-05`)).data.answers;
  assert.equal(pre.A_closeout_reason, 'no_contact'); assert.equal(pre.A_last_service_date, '2026-01-07');
  const r = await nav.post(`/api/clients/${other}/suprt`, { assessment_type: 'closeout', assessment_date: '2026-08-05', status: 'complete', answers: pre });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await nav.post(`/api/clients/${other}/suprt`, { assessment_type: 'reassessment', assessment_date: '2026-08-06', status: 'complete', answers: { A_first_service_date: '2026-01-05', A_suprt_c: 'completed' } })).status, 400, 'closed out: a new baseline first');
  assert.equal((await admin.put('/api/admin/settings', { module_suprt: '0' })).status, 200);
  try {
    assert.equal((await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'annual', assessment_date: '2026-08-01' })).status, 403);
    assert.equal((await sup.get('/api/suprt/export?from=2026-01-01&to=2026-08-31')).status, 403);
    assert.equal((await nav.get(`/api/clients/${clientId}/suprt`)).status, 200, 'what was recorded stays readable');
  } finally { await admin.put('/api/admin/settings', { module_suprt: null }); }
});

test('settings: grant and site IDs pre-fill every record; the reassessment interval is 3 or 6 months', async () => {
  assert.equal((await admin.put('/api/admin/settings', { suprt_reassessment_months: '4' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { suprt_grant_id: 'TI-081234', suprt_site_id: 'CA-01', suprt_reassessment_months: '3' })).status, 200);
  const a = (await nav.get(`/api/clients/${clientId}/suprt/prefill?type=annual&date=2026-08-01`)).data.answers;
  assert.deepEqual([a.A_grant_id, a.A_site_id], ['TI-081234', 'CA-01']);
  assert.equal((await nav.get('/api/suprt/items')).data.reassessment_days, 90);
  // The form does not send the grant and site IDs (they are not the worker's to change): the record carries them.
  const d = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'annual', assessment_date: '2026-08-02', status: 'draft', answers: { A_suprt_c: 'completed' } });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  assert.deepEqual([d.data.answers.A_grant_id, d.data.answers.A_site_id, d.data.answers.A_client_id], ['TI-081234', 'CA-01', code]);
  assert.ok(d.data.missing.includes('A_first_service_date'), 'a draft says what is still to answer');
  await admin.put('/api/admin/settings', { suprt_reassessment_months: null });
  const SYNC = require('../server/sync-tables');
  assert.ok(SYNC.tables.find(t => t.name === 'suprt_assessments').enc.includes('answers_enc'), 'the answers travel encrypted-at-rest columns');
  for (const k of ['suprt_grant_id', 'suprt_site_id', 'suprt_reassessment_months', 'module_suprt', 'module_publication']) assert.ok(SYNC.settings_keys.includes(k), k);
});

test('an assessment is corrected with PUT and a draft removed with DELETE; roles without the client record are refused', async () => {
  const draft = H.db.one(`SELECT id FROM suprt_assessments WHERE client_id=? AND assessment_type='annual'`, clientId).id;
  let r = await nav.put(`/api/suprt/${draft}`, { status: 'complete', answers: { A_suprt_c: 'completed' } });
  assert.equal(r.status, 400, 'still missing the first service date');
  r = await nav.put(`/api/suprt/${draft}`, { status: 'complete', answers: { A_suprt_c: 'completed', A_first_service_date: '2026-01-05', B_crisis_since_last: 'no' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.status, r.data.answers.B_crisis_since_last, r.data.answers.A_grant_id], ['complete', 'no', 'TI-081234']);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='suprt.update' AND entity_id=?`, draft));
  for (const c of [fin, ro]) {
    assert.equal((await c.put(`/api/suprt/${draft}`, { status: 'draft' })).status, 403);
    assert.equal((await c.get(`/api/clients/${clientId}/suprt`)).status, 403);
    assert.equal((await c.get(`/api/clients/${clientId}/suprt/prefill`)).status, 403);
    assert.equal((await c.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'annual', assessment_date: '2026-08-01' })).status, 403);
  }
  // A worker whose caseload the client is not on cannot read or change it.
  H.makeCaseloadUser('snav2', 'navigator'); const nav2 = H.client(); await nav2.login('snav2', 'StaffPassw0rd!x');
  assert.equal((await nav2.get(`/api/clients/${clientId}/suprt`)).status, 403);
  assert.equal((await nav2.put(`/api/suprt/${draft}`, { status: 'draft' })).status, 403);
  assert.ok(!(await nav2.get('/api/suprt/due')).data.rows.some(x => x.client_id === clientId), 'nor see it on its to-do list');
  const d = await nav.post(`/api/clients/${clientId}/suprt`, { assessment_type: 'annual', assessment_date: '2026-08-03' });
  assert.equal(d.status, 201);
  assert.equal((await nav2.del(`/api/suprt/${d.data.id}`)).status, 403);
  assert.equal((await nav.del(`/api/suprt/${d.data.id}`)).status, 200);
  assert.ok(!H.db.one(`SELECT 1 FROM suprt_assessments WHERE id=?`, d.data.id));
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='suprt_assessments' AND id=?`, d.data.id), 'devices learn it is gone');
  assert.equal((await nav.del(`/api/suprt/${d.data.id}`)).status, 404);
});
