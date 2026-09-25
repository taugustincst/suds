'use strict';
// Clinical depth for CalAIM documentation: the problem list (with its change history and note links), the
// care coordination plan, ASAM six-dimension assessments, scored outcome measures (PHQ-9, GAD-7, AUDIT-C,
// DAST-10, wellbeing), the PHQ-9 item 9 safety alert, the programme outcomes report and its de-identified
// export, who may do what, and how the new tables travel by sync.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');
const CL = require('../server/clinical');

let admin, sup, clin, nav, nav2, fin, ro;
let clinId, navId, clientId, navClientId;
const iso = (ms) => new Date(ms).toISOString();
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const push = (c, body) => c.post('/api/sync/push', { device_now: iso(Date.now()), ...body });

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  clinId = H.makeUser('cdclin', 'clinician').id;
  navId = H.makeUser('cdnav', 'navigator').id;
  H.makeUser('cdnav2', 'navigator'); H.makeUser('cdsup', 'supervisor'); H.makeUser('cdfin', 'finance'); H.makeUser('cdro', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('cdsup', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('cdclin', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('cdnav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('cdnav2', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('cdfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('cdro', 'StaffPassw0rd!x');
  clientId = (await clin.post('/api/clients', { first_name: 'Clinical', last_name: 'Depth', confirm_duplicate: true })).data.id;
  // The navigator works the same client (a care team of two), and has one of their own.
  await sup.post(`/api/clients/${clientId}/assignments`, { user_id: navId, role_on_case: 'secondary' });
  navClientId = (await nav.post('/api/clients', { first_name: 'Navigator', last_name: 'Only', confirm_duplicate: true })).data.id;
});
after(H.stop);

// ---------------------------------------------------------------- scoring (pure)
test('scoring: PHQ-9 bands at every boundary, and item 9 raises the safety flag', () => {
  const phq = (total, item9 = 0) => { const r = Array(9).fill(0); r[8] = item9; let left = total - item9; for (let i = 0; i < 8 && left > 0; i++) { const v = Math.min(3, left); r[i] = v; left -= v; } return CL.score('phq9', r); };
  assert.deepEqual([0, 4, 5, 9, 10, 14, 15, 19, 20, 27].map(t => phq(t, t === 27 ? 3 : 0).band),
    ['Minimal', 'Minimal', 'Mild', 'Mild', 'Moderate', 'Moderate', 'Moderately severe', 'Moderately severe', 'Severe', 'Severe']);
  assert.equal(phq(27, 3).total, 27);
  assert.equal(phq(4).safety_flag, 0);
  assert.equal(phq(1, 1).safety_flag, 1, 'a single point on item 9 is an alert, even with a minimal total');
  assert.equal(phq(1, 1).band, 'Minimal');
  assert.equal(phq(10).positive, 1); assert.equal(phq(9).positive, 0);
});

test('scoring: GAD-7, AUDIT-C cut-offs by variant, DAST-10 reverse item, wellbeing', () => {
  assert.equal(CL.score('gad7', [3, 3, 3, 3, 3, 3, 3]).band, 'Severe');
  assert.equal(CL.score('gad7', [1, 1, 1, 1, 1, 0, 0]).band, 'Mild');
  assert.equal(CL.score('gad7', [0, 0, 0, 0, 0, 0, 0]).total, 0);
  const a3 = [1, 1, 1];
  assert.equal(CL.score('auditc', a3, { variant: 'men' }).positive, 0, 'three is negative for men');
  assert.equal(CL.score('auditc', a3, { variant: 'women' }).positive, 1, 'and positive for women');
  assert.equal(CL.score('auditc', a3).positive, 1, 'with no variant the lower cut-off applies');
  assert.equal(CL.score('auditc', a3).variant, 'unspecified');
  assert.equal(CL.score('auditc', [4, 4, 4], { variant: 'men' }).band, 'Positive screen');
  // DAST-10: "Yes" to question 3 ("always able to stop") scores 0, "No" scores 1.
  const dastNo = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(CL.score('dast10', dastNo).total, 1);
  assert.equal(CL.score('dast10', dastNo).band, 'Low level');
  assert.equal(CL.score('dast10', Array(10).fill(0)).band, 'No problems reported');
  assert.equal(CL.score('dast10', Array(10).fill(1)).band, 'Severe level');
  assert.equal(CL.INSTRUMENTS.dast10.items[2].options.find(o => o.label === 'No').value, 1);
  assert.equal(CL.score('wellbeing', [7]).band, 'Good');
  assert.equal(CL.direction('wellbeing', 3, 7), 1, 'higher is better for wellbeing');
  assert.equal(CL.direction('phq9', 15, 7), 1, 'lower is better for PHQ-9');
  assert.equal(CL.direction('phq9', 7, 15), -1);
  assert.equal(CL.direction('gad7', 5, 5), 0);
});

test('scoring: a missing, extra, fractional or impossible answer is refused, never scored low', () => {
  assert.throws(() => CL.score('phq9', Array(8).fill(0)), /9 questions/);
  assert.throws(() => CL.score('phq9', Array(10).fill(0)), /9 questions/);
  assert.throws(() => CL.score('phq9', [0, 0, 0, 0, 0, 0, 0, 0, 4]), /question 9/);
  assert.throws(() => CL.score('phq9', [0, 0, 0, 0, null, 0, 0, 0, 0]), /question 5/);
  assert.throws(() => CL.score('gad7', [0, 0, 0, 0, 0, 0, 1.5]), /question 7/);
  assert.throws(() => CL.score('dast10', Array(10).fill(2)), /question 1/);
  assert.throws(() => CL.score('wellbeing', [11]), /question 1/);
  assert.throws(() => CL.score('nope', [1]), /Unknown instrument/);
  assert.equal(CL.score('gad7', ['1', '0', '0', '0', '0', '0', '0']).total, 1, 'numbers sent as text are accepted');
});

test('ICD-10-CM codes are format-checked and normalised; Z codes must be Z55–Z65', () => {
  assert.equal(CL.normalizeIcd10('f1120'), 'F11.20');
  assert.equal(CL.normalizeIcd10(' F11.20 '), 'F11.20');
  assert.equal(CL.normalizeIcd10('Z59.02'), 'Z59.02');
  assert.equal(CL.normalizeIcd10('F11'), 'F11');
  assert.equal(CL.normalizeIcd10('11.20'), null);
  assert.equal(CL.normalizeIcd10('F11.20000'), null);
  assert.ok(CL.isZCode('Z59.02') && CL.isZCode('Z65.8') && CL.isZCode('Z55.0'));
  assert.ok(!CL.isZCode('Z66') && !CL.isZCode('Z54.1') && !CL.isZCode('F11.20'));
  for (const z of CL.Z_CODES) assert.ok(CL.isZCode(z.code), `${z.code} on the built-in list is in range`);
});

// ---------------------------------------------------------------- problem list
test('problem list: create with codes, encrypted at rest, listed, and every change kept in history', async () => {
  let r = await nav.post(`/api/clients/${clientId}/problems`, { problem: 'Opioid use disorder, seeking MOUD', icd10_code: 'f1120', icd10_description: 'Opioid dependence, uncomplicated', z_codes: ['Z59.02', 'z56.0'], onset_date: '2026-01-15', source: 'assessment' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const pid = r.data.id;
  const raw = H.db.one(`SELECT * FROM problems WHERE id=?`, pid);
  assert.match(raw.problem_enc, /^v1:/); assert.match(raw.icd10_code_enc, /^v1:/); assert.match(raw.z_codes_enc, /^v1:/);
  assert.ok(!JSON.stringify(raw).includes('Opioid'), 'no plaintext problem in the row');

  r = await nav.get(`/api/clients/${clientId}/problems`);
  assert.equal(r.status, 200);
  const p = r.data.rows.find(x => x.id === pid);
  assert.equal(p.icd10_code, 'F11.20');
  assert.deepEqual(p.z_codes, ['Z59.02', 'Z56.0']);
  assert.equal(p.status, 'active'); assert.equal(p.source, 'assessment'); assert.equal(p.added_by, navId);

  // Bad codes are refused by field.
  r = await nav.post(`/api/clients/${clientId}/problems`, { problem: 'x', icd10_code: '123' });
  assert.equal(r.status, 400); assert.ok(r.data.fields.icd10_code);
  r = await nav.post(`/api/clients/${clientId}/problems`, { problem: 'x', z_codes: ['F11.20'] });
  assert.equal(r.status, 400); assert.ok(r.data.fields.z_codes);
  r = await nav.post(`/api/clients/${clientId}/problems`, { icd10_code: 'F11.20' });
  assert.equal(r.status, 400, 'the problem text is required');

  // A clinician resolves it; the resolution is dated and the history says who changed what.
  r = await clin.put(`/api/problems/${pid}`, { status: 'resolved', if_updated_at: raw.updated_at });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changed.sort(), ['resolved_date', 'status']);
  const after = (await clin.get(`/api/problems/${pid}`)).data.problem;
  assert.equal(after.status, 'resolved'); assert.ok(after.resolved_date); assert.equal(after.updated_by, clinId);
  // A stale edit is refused.
  r = await nav.put(`/api/problems/${pid}`, { problem: 'Edited from an old screen', if_updated_at: raw.updated_at });
  assert.equal(r.status, 409);
  // Reopened: the resolved date is cleared.
  r = await nav.put(`/api/problems/${pid}`, { status: 'active', problem: 'Opioid use disorder, on buprenorphine' });
  assert.equal(r.status, 200);
  assert.equal((await nav.get(`/api/problems/${pid}`)).data.problem.resolved_date, null);

  const hist = (await nav.get(`/api/problems/${pid}/history`)).data.rows;
  assert.deepEqual(hist.map(h => h.action), ['created', 'updated', 'updated']);
  assert.equal(hist[0].changed_by, navId); assert.equal(hist[1].changed_by, clinId);
  assert.deepEqual(hist[1].changes.status, { from: 'active', to: 'resolved' });
  assert.equal(hist[2].changes.problem.to, 'Opioid use disorder, on buprenorphine');
  assert.match(H.db.one(`SELECT changes_enc FROM problem_history WHERE problem_id=? LIMIT 1`, pid).changes_enc, /^v1:/, 'history is encrypted');

  // Audited, with no PHI in the details.
  for (const action of ['problem.create', 'problem.update', 'problem.list', 'problem.view', 'problem.history.view']) assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action=? AND client_id=?`, action, clientId), `${action} audited`);
  const details = H.db.all(`SELECT details FROM audit_log WHERE action LIKE 'problem.%'`).map(x => x.details || '').join(' ');
  assert.ok(!/Opioid|F11|Z59/.test(details), 'audit details carry field names only');
});

test('problem list permissions: admin reads only, finance and read-only none, caseload applies', async () => {
  const pid = (await nav.post(`/api/clients/${clientId}/problems`, { problem: 'Needs a phone' })).data.id;
  assert.equal((await admin.get(`/api/clients/${clientId}/problems`)).status, 200, 'an administrator may read the list');
  assert.equal((await admin.post(`/api/clients/${clientId}/problems`, { problem: 'x' })).status, 403);
  assert.equal((await admin.put(`/api/problems/${pid}`, { status: 'inactive' })).status, 403);
  for (const who of [fin, ro]) {
    assert.equal((await who.get(`/api/clients/${clientId}/problems`)).status, 403);
    assert.equal((await who.post(`/api/clients/${clientId}/problems`, { problem: 'x' })).status, 403);
  }
  // Another navigator, not on this client's care team.
  assert.equal((await nav2.get(`/api/clients/${clientId}/problems`)).status, 403);
  assert.equal((await nav2.get(`/api/problems/${pid}`)).status, 403);
  assert.equal((await nav2.put(`/api/problems/${pid}`, { status: 'inactive' })).status, 403);
  assert.equal((await nav2.post(`/api/clients/${clientId}/problems`, { problem: 'x' })).status, 403);
  // There is no delete: a problem is resolved or made inactive.
  assert.equal((await sup.del(`/api/problems/${pid}`)).status, 405);
});

test('notes link to the problems they address', async () => {
  const pid = (await clin.post(`/api/clients/${clientId}/problems`, { problem: 'Unsheltered; wants housing', z_codes: ['Z59.02'] })).data.id;
  const other = (await nav.post(`/api/clients/${navClientId}/problems`, { problem: 'Someone else\'s problem' })).data.id;
  let r = await clin.post('/api/notes', { client_id: clientId, kind: 'admin', content: 'Housing application started', occurred_at: iso(Date.now()), problem_ids: [pid] });
  assert.equal(r.status, 201);
  const noteId = r.data.id;
  const note = (await clin.get(`/api/notes/${noteId}`)).data.note;
  assert.deepEqual(note.problems.map(p => p.problem), ['Unsheltered; wants housing']);
  r = await clin.post('/api/notes', { client_id: clientId, kind: 'admin', content: 'x', occurred_at: iso(Date.now()), problem_ids: [other] });
  assert.equal(r.status, 400, 'a problem on another client cannot be linked');
  r = await clin.put(`/api/notes/${noteId}`, { problem_ids: [pid, pid] });
  assert.equal(r.status, 200);
  assert.equal(H.db.one(`SELECT problem_ids FROM notes WHERE id=?`, noteId).problem_ids, JSON.stringify([pid]), 'duplicates collapse');
  const listed = (await clin.get(`/api/clients/${clientId}/problems`)).data.rows.find(x => x.id === pid);
  assert.equal(listed.notes, 1, 'the problem list counts the notes that address it');
});

// ---------------------------------------------------------------- care plan
test('care plan: goals tied to problems, steps with owners that can create to-dos, overdue reviews', async () => {
  const pid = (await nav.post(`/api/clients/${clientId}/problems`, { problem: 'No ID documents' })).data.id;
  let r = await nav.post(`/api/clients/${clientId}/goals`, { goal: 'I want my ID back so I can get a job', problem_id: pid, target_date: day(60), review_date: day(-1) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const gid = r.data.id;
  assert.match(H.db.one(`SELECT goal_enc FROM care_plan_goals WHERE id=?`, gid).goal_enc, /^v1:/);
  r = await nav.post(`/api/clients/${clientId}/goals`, { goal: 'x', problem_id: (await nav.post(`/api/clients/${navClientId}/problems`, { problem: 'y' })).data.id });
  assert.equal(r.status, 400, 'a goal cannot point at another client\'s problem');

  r = await nav.post(`/api/goals/${gid}/steps`, { step: 'Request birth certificate from county clerk', owner_role: 'staff', owner_user_id: navId, target_date: day(7), create_task: true });
  assert.equal(r.status, 201);
  const sid = r.data.id; const taskId = r.data.task_id;
  const task = H.db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  assert.equal(task.assigned_to, navId); assert.equal(task.due_at, day(7)); assert.equal(task.client_id, clientId);
  assert.equal((await nav.post(`/api/goals/${gid}/steps`, { step: 'Client brings proof of address', owner_role: 'client' })).status, 201);
  assert.equal((await nav.post(`/api/goals/${gid}/steps`, { step: 'x', owner_role: 'boss' })).status, 400);

  let plan = (await nav.get(`/api/clients/${clientId}/care-plan`)).data;
  const g = plan.goals.find(x => x.id === gid);
  assert.equal(g.goal, 'I want my ID back so I can get a job');
  assert.equal(g.problem, 'No ID documents');
  assert.equal(g.review_overdue, true, 'a review date in the past is overdue');
  assert.equal(g.steps.length, 2);
  assert.ok(plan.review_overdue >= 1);
  const summary = (await nav.get(`/api/clients/${clientId}/clinical-summary`)).data;
  assert.ok(summary.care_plan.overdue_reviews.some(x => x.id === gid));
  assert.equal(summary.asam, undefined, 'a navigator is not shown ASAM ratings');

  // Done on the plan closes the to-do it made.
  r = await nav.put(`/api/steps/${sid}`, { status: 'done' });
  assert.equal(r.status, 200);
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'done');
  assert.ok(H.db.one(`SELECT completed_at FROM care_plan_steps WHERE id=?`, sid).completed_at);
  // Reviewed with the client: next review moves forward, no longer overdue.
  r = await nav.put(`/api/goals/${gid}`, { reviewed: true, review_date: day(30) });
  assert.equal(r.status, 200);
  plan = (await nav.get(`/api/clients/${clientId}/care-plan`)).data;
  assert.equal(plan.goals.find(x => x.id === gid).review_overdue, false);
  assert.equal(plan.goals.find(x => x.id === gid).reviewed_at, plan.today);

  // Only the author or a supervisor deletes; the steps go with the goal, as tombstones for devices.
  assert.equal((await clin.del(`/api/goals/${gid}`)).status, 403);
  assert.equal((await admin.put(`/api/goals/${gid}`, { status: 'met' })).status, 403, 'an administrator reads the plan but does not change it');
  assert.equal((await sup.del(`/api/goals/${gid}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='care_plan_steps' AND id=?`, sid));
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='care_plan_goals' AND id=?`, gid));
  for (const action of ['careplan.goal.create', 'careplan.step.create', 'careplan.step.update', 'careplan.goal.update', 'careplan.view', 'careplan.goal.delete']) assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action=?`, action), `${action} audited`);
  assert.equal((await fin.get(`/api/clients/${clientId}/care-plan`)).status, 403);
  assert.equal((await nav2.get(`/api/clients/${clientId}/care-plan`)).status, 403);
});

// ---------------------------------------------------------------- ASAM
test('ASAM: six ratings 0-4, discrepancy needs a reason, the latest sets the client\'s level of care', async () => {
  const base = { assessed_at: day(-10), d1_rating: 1, d2_rating: 0, d3_rating: 2, d4_rating: 3, d5_rating: 3, d6_rating: 4, dimension_notes: { d6: 'Unsheltered, partner uses', d9: 'ignored' }, recommended_loc: '3.5' };
  let r = await clin.post(`/api/clients/${clientId}/asam`, { ...base, d3_rating: 5 });
  assert.equal(r.status, 400); assert.ok(r.data.fields.d3_rating);
  r = await clin.post(`/api/clients/${clientId}/asam`, { ...base, d6_rating: undefined });
  assert.equal(r.status, 400); assert.ok(r.data.fields.d6_rating);
  r = await clin.post(`/api/clients/${clientId}/asam`, { ...base, actual_loc: '2.1' });
  assert.equal(r.status, 400, 'a lower level than recommended needs a reason'); assert.ok(r.data.fields.discrepancy_reason);
  r = await clin.post(`/api/clients/${clientId}/asam`, { ...base, recommended_loc: '9.9' });
  assert.equal(r.status, 400);
  r = await clin.post(`/api/clients/${clientId}/asam`, { ...base, actual_loc: '2.1', discrepancy_reason: 'waitlist', discrepancy_notes: 'No 3.5 bed for three weeks' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const aid = r.data.id;
  assert.equal(r.data.client_asam_level, '2.1', 'the level referred to becomes the client\'s level of care');
  assert.equal(H.db.one(`SELECT asam_level FROM clients WHERE id=?`, clientId).asam_level, '2.1');
  const row = H.db.one(`SELECT * FROM asam_assessments WHERE id=?`, aid);
  assert.match(row.dimension_notes_enc, /^v1:/); assert.match(row.discrepancy_notes_enc, /^v1:/);

  const a = (await clin.get(`/api/asam/${aid}`)).data.assessment;
  assert.deepEqual(a.ratings, [1, 0, 2, 3, 3, 4]);
  assert.deepEqual(a.dimension_notes, { d6: 'Unsheltered, partner uses' }, 'only the six dimensions are kept');
  assert.equal(a.discrepancy, true);

  // A newer one is the latest shown on the Overview.
  r = await clin.post(`/api/clients/${clientId}/asam`, { ...base, assessed_at: day(-1), d6_rating: 2, recommended_loc: '1.0', actual_loc: '1.0', dimension_notes: {} });
  assert.equal(r.status, 201);
  const s = (await clin.get(`/api/clients/${clientId}/clinical-summary`)).data;
  assert.equal(s.asam.id, r.data.id); assert.equal(s.asam.recommended_loc, '1.0');
  assert.equal((await clin.get(`/api/clients/${clientId}/asam`)).data.rows.length, 2, 'history is kept');

  // Edit: the author (or a supervisor), with the discrepancy rule applied to the merged record.
  assert.equal((await clin.put(`/api/asam/${aid}`, { discrepancy_reason: null })).status, 400);
  assert.equal((await clin.put(`/api/asam/${aid}`, { d1_rating: 2 })).status, 200);
  assert.equal((await sup.put(`/api/asam/${aid}`, { summary: 'Reviewed' })).status, 200);

  // Clinical content: navigators, admins, finance, read-only cannot read or write it.
  for (const who of [nav, admin, fin, ro]) {
    assert.equal((await who.get(`/api/clients/${clientId}/asam`)).status, 403);
    assert.equal((await who.post(`/api/clients/${clientId}/asam`, base)).status, 403);
    assert.equal((await who.get(`/api/asam/${aid}`)).status, 403);
  }
  assert.equal((await sup.del(`/api/asam/${aid}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='asam_assessments' AND id=?`, aid));
  for (const action of ['asam.create', 'asam.view', 'asam.list', 'asam.update', 'asam.delete']) assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action=?`, action), `${action} audited`);
});

// ---------------------------------------------------------------- outcome measures
test('outcome measures: scored on save, answers encrypted, bad questionnaires refused', async () => {
  let r = await clin.post(`/api/clients/${clientId}/outcomes`, { instrument: 'gad7', administered_at: day(-30), responses: [2, 2, 2, 2, 2, 2, 2] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.total, 14); assert.equal(r.data.band, 'Moderate'); assert.equal(r.data.safety_alert, null);
  const row = H.db.one(`SELECT * FROM outcome_measures WHERE id=?`, r.data.id);
  assert.match(row.responses_enc, /^v1:/); assert.equal(row.total_score, 14); assert.equal(row.administered_by, clinId);

  r = await clin.post(`/api/clients/${clientId}/outcomes`, { instrument: 'phq9', administered_at: day(0), responses: [1, 1, 1] });
  assert.equal(r.status, 400); assert.ok(r.data.fields.responses);
  r = await clin.post(`/api/clients/${clientId}/outcomes`, { instrument: 'bdi', administered_at: day(0), responses: [1] });
  assert.equal(r.status, 400);
  r = await clin.post(`/api/clients/${clientId}/outcomes`, { instrument: 'auditc', administered_at: day(0), responses: [1, 1, 1], variant: 'men' });
  assert.equal(r.data.band, 'Negative screen');
  r = await clin.post(`/api/clients/${clientId}/outcomes`, { instrument: 'auditc', administered_at: day(0), responses: [1, 1, 1], variant: 'women' });
  assert.equal(r.data.band, 'Positive screen');

  // Correcting the answers rescores.
  const gid = H.db.one(`SELECT id, updated_at FROM outcome_measures WHERE client_id=? AND instrument='gad7'`, clientId);
  r = await clin.put(`/api/outcomes/${gid.id}`, { responses: [3, 3, 3, 3, 3, 3, 3], if_updated_at: gid.updated_at });
  assert.equal(r.status, 200); assert.equal(r.data.total, 21); assert.equal(r.data.band, 'Severe');
  assert.equal((await clin.get(`/api/outcomes/${gid.id}`)).data.measure.responses.length, 7);

  for (const who of [nav, admin, fin, ro]) {
    assert.equal((await who.get(`/api/clients/${clientId}/outcomes`)).status, 403);
    assert.equal((await who.post(`/api/clients/${clientId}/outcomes`, { instrument: 'wellbeing', administered_at: day(0), responses: [5] })).status, 403);
  }
  assert.equal((await nav2.get(`/api/outcomes/${gid.id}`)).status, 403);
});

test('PHQ-9 item 9 above "Not at all" raises a safety alert: an urgent to-do and the safety plan', async () => {
  // A signed safety plan on file is offered in the alert.
  const sp = (await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', format: 'safety_plan', content: 'Plan', occurred_at: iso(Date.now() - 86400000) })).data.id;
  H.db.run(`UPDATE notes SET status='signed', signed_at=?, signed_by=? WHERE id=?`, H.db.now(), clinId, sp);
  const r = await clin.post(`/api/clients/${clientId}/outcomes`, { instrument: 'phq9', administered_at: day(0), responses: [0, 0, 0, 0, 0, 0, 0, 0, 1] });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 1); assert.equal(r.data.band, 'Minimal');
  assert.ok(r.data.safety_alert, 'an alert even though the total is minimal');
  assert.equal(r.data.safety_alert.safety_plan.id, sp);
  const task = H.db.one(`SELECT * FROM tasks WHERE id=?`, r.data.safety_alert.task_id);
  assert.equal(task.priority, 'urgent'); assert.equal(task.assigned_to, clinId); assert.equal(task.status, 'open');
  assert.match(require('../server/crypto').decrypt(task.title_enc), /Safety follow-up/);
  assert.equal(H.db.one(`SELECT safety_flag FROM outcome_measures WHERE id=?`, r.data.id).safety_flag, 1);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='outcome.safety_alert' AND entity_id=?`, r.data.id));
  const s = (await clin.get(`/api/clients/${clientId}/clinical-summary`)).data;
  assert.equal(s.safety_alert.measure_id, r.data.id);
  // Item 9 at zero: no alert.
  const ok = await clin.post(`/api/clients/${clientId}/outcomes`, { instrument: 'phq9', administered_at: day(0), responses: [3, 3, 3, 3, 3, 3, 3, 3, 0] });
  assert.equal(ok.data.band, 'Severe'); assert.equal(ok.data.safety_alert, null);
});

test('programme outcomes report: baseline vs latest, % improved, de-identified export', async () => {
  const c2 = (await clin.post('/api/clients', { first_name: 'Outcome', last_name: 'Pair', confirm_duplicate: true })).data.id;
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, c2).client_code;
  await clin.post(`/api/clients/${c2}/outcomes`, { instrument: 'phq9', administered_at: '2026-03-01', responses: [3, 3, 3, 2, 2, 2, 1, 1, 0] }); // 17
  await clin.post(`/api/clients/${c2}/outcomes`, { instrument: 'phq9', administered_at: '2026-06-01', responses: [1, 1, 1, 1, 1, 0, 0, 0, 0] }); // 5
  await clin.post(`/api/clients/${c2}/outcomes`, { instrument: 'wellbeing', administered_at: '2026-03-01', responses: [3] });
  await clin.post(`/api/clients/${c2}/outcomes`, { instrument: 'wellbeing', administered_at: '2026-06-01', responses: [6] });
  let r = await clin.get('/api/reports/outcomes?from=2026-01-01&to=2026-07-01');
  assert.equal(r.status, 200);
  const phq = r.data.instruments.find(x => x.instrument === 'phq9');
  assert.equal(phq.clients_with_followup, 1); assert.equal(phq.mean_baseline, 17); assert.equal(phq.mean_latest, 5); assert.equal(phq.mean_change, -12);
  assert.equal(phq.improved, 1); assert.equal(phq.pct_improved, 100); assert.equal(phq.positive_at_baseline, 1); assert.equal(phq.positive_at_latest, 0);
  assert.equal(r.data.instruments.find(x => x.instrument === 'wellbeing').pct_improved, 100, 'a higher wellbeing score is an improvement');
  assert.equal((await clin.get('/api/reports/outcomes?from=junk')).status, 400);
  // Aggregate only, so the read-only oversight role may see it; it holds no export permission.
  assert.equal((await ro.get('/api/reports/outcomes')).status, 200);
  assert.equal((await ro.get('/api/reports/outcomes/export')).status, 403);
  // Caseload scoped: another navigator's report does not count this clinician's clients.
  assert.equal((await nav2.get('/api/reports/outcomes')).data.instruments.find(x => x.instrument === 'phq9').clients_screened, 0);

  r = await clin.get('/api/reports/outcomes/export?from=2026-01-01&to=2026-07-01');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('x-suds-export'), /De-identified/);
  assert.match(r.data, new RegExp(`${code},PHQ-9,2,2026-03,17,Moderately severe,2026-06,5,Mild,-12,improved`));
  assert.ok(!/Outcome|Pair|2026-03-01/.test(r.data), 'no names and no full dates');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.export' AND details LIKE '%outcomes%'`));
});

// ---------------------------------------------------------------- sync
test('sync: the care plan reaches every worker\'s device, assessments only clinical roles\'', async () => {
  const pullAs = async (c) => (await c.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).data;
  const n = await pullAs(nav);
  assert.ok(n.tables.problems.some(p => p.client_id === clientId), 'problems travel to the navigator');
  assert.ok(n.tables.problem_history.length > 0);
  assert.deepEqual(n.tables.asam_assessments, [], 'ASAM ratings do not');
  assert.deepEqual(n.tables.outcome_measures, [], 'nor screening answers');
  const c = await pullAs(clin);
  const m = c.tables.outcome_measures.find(x => x.client_id === clientId);
  assert.ok(m, 'the clinician gets outcome measures');
  assert.ok(Array.isArray(JSON.parse(m.responses_enc)), 'decrypted for transport like every _enc column');
  assert.ok(c.tables.asam_assessments.length > 0);
  // Caseload: nav2 sees none of this client's problems.
  assert.ok(!(await pullAs(nav2)).tables.problems.some(p => p.client_id === clientId));
});

test('sync: pushed rows are checked — role, rescoring, append-only history', async () => {
  const now = iso(Date.now());
  // A navigator's device cannot write assessments.
  let r = await push(nav, { tables: { outcome_measures: [{ id: randomUUID(), client_id: clientId, instrument: 'wellbeing', administered_at: day(0), administered_by: navId, responses_enc: '[5]', total_score: 5, created_at: now, updated_at: now }] } });
  assert.match(r.data.rejected[0].reason, /role cannot write/);
  // A clinician's device: the score is recomputed from the answers, whatever the device claimed.
  const mid = randomUUID();
  r = await push(clin, { tables: { outcome_measures: [{ id: mid, client_id: clientId, instrument: 'phq9', administered_at: day(0), administered_by: clinId, responses_enc: '[0,0,0,0,0,0,0,0,2]', total_score: 0, band: 'Minimal', safety_flag: 0, created_at: now, updated_at: now }] } });
  assert.deepEqual(r.data.rejected, []);
  const row = H.db.one(`SELECT * FROM outcome_measures WHERE id=?`, mid);
  assert.equal(row.total_score, 2); assert.equal(row.safety_flag, 1, 'the safety flag cannot be synced away');
  assert.match(row.responses_enc, /^v1:/, 're-encrypted with the office key');
  r = await push(clin, { tables: { outcome_measures: [{ id: randomUUID(), client_id: clientId, instrument: 'phq9', administered_at: day(0), administered_by: clinId, responses_enc: '[9]', total_score: 0, created_at: now, updated_at: now }] } });
  assert.match(r.data.rejected[0].reason, /do not score/);
  // A problem and its history from a device; the history cannot be rewritten afterwards.
  const pid = randomUUID(); const hid = randomUUID();
  r = await push(nav, { tables: {
    problems: [{ id: pid, client_id: clientId, problem_enc: 'Needs dentures', status: 'active', source: 'self_report', added_by: navId, updated_by: navId, created_at: now, updated_at: now }],
    problem_history: [{ id: hid, problem_id: pid, client_id: clientId, action: 'created', changes_enc: '{"problem":{"from":null,"to":"Needs dentures"}}', changed_by: navId, created_at: now, updated_at: now }],
  } });
  assert.deepEqual(r.data.rejected, []);
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT problem_enc FROM problems WHERE id=?`, pid).problem_enc), 'Needs dentures');
  const later = iso(Date.now() + 5000);
  r = await push(nav, { tables: { problem_history: [{ id: hid, problem_id: pid, client_id: clientId, action: 'created', changes_enc: '{"problem":{"from":null,"to":"Rewritten"}}', changed_by: navId, created_at: now, updated_at: later }] } });
  assert.match(r.data.rejected[0].reason, /immutable/);
  // Not on the caseload: refused.
  r = await push(nav2, { tables: { problems: [{ id: randomUUID(), client_id: clientId, problem_enc: 'x', status: 'active', source: 'other', created_at: now, updated_at: now }] } });
  assert.match(r.data.rejected[0].reason, /not on caseload/);
});

test('retention and merge reach the new tables', () => {
  const R = require('../server/retention');
  for (const t of ['problems', 'problem_history', 'care_plan_goals', 'care_plan_steps', 'asam_assessments', 'outcome_measures']) {
    assert.ok(R.DELETE_TABLES.includes(t), `${t} is purged with the client`);
    assert.ok(t in R.ACTIVITY, `${t} counts as activity on the record`);
  }
});
