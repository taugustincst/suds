'use strict';
// CalAIM problem list and care coordination plan.
//
// Problem list: each client's current problems and needs, in words, with an optional ICD-10-CM code and
// social determinant (Z) codes. It is never deleted from — a problem is resolved or made inactive — and
// every change is kept in problem_history (who, when, each field's old and new value, encrypted).
// Care plan: goals in the client's own words, tied to a problem, with a review date that shows as overdue
// once it passes; and the steps toward each goal, with who does them and by when (optionally a to-do).
//
// Permissions: careplan:read / careplan:write (server/auth.js). Everything is caseload scoped and audited.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const CL = require('../clinical');
const { badRequest, notFound, forbidden } = require('../http');
const { validate } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');
const { assertFresh } = require('../crud');

const dec = (v) => (v ? decrypt(v) : null);
const today = () => require('./budget').localDate();

function clientFor(ctx, clientId) {
  if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, clientId)) throw notFound('Client not found');
  auth.assertClientAccess(ctx, clientId);
}
function fieldError(field, message) { return badRequest('Validation failed', { fields: { [field]: message } }); }

// ---- problems ----
const problemShape = {
  problem: { type: 'string', required: true, maxLen: 500 },
  icd10_code: { type: 'string', maxLen: 12 },
  icd10_description: { type: 'string', maxLen: 300 },
  z_codes: { type: 'array', maxLen: 12 },
  status: { type: 'string', enum: CL.PROBLEM_STATUSES },
  onset_date: { type: 'date' },
  resolved_date: { type: 'date' },
  source: { type: 'string', enum: CL.PROBLEM_SOURCES },
};
const TRACKED = ['problem', 'icd10_code', 'icd10_description', 'z_codes', 'status', 'onset_date', 'resolved_date', 'source'];

/** Check and normalise the codes; returns the plaintext values to store. */
function cleanCodes(v) {
  if (v.icd10_code !== undefined && v.icd10_code !== null) {
    const code = CL.normalizeIcd10(v.icd10_code);
    if (!code) throw fieldError('icd10_code', 'is not an ICD-10-CM code (a letter, two characters, then optionally a dot and up to four more, e.g. F11.20)');
    v.icd10_code = code;
  }
  if (v.z_codes !== undefined && v.z_codes !== null) {
    const out = [];
    for (const raw of v.z_codes) {
      const code = CL.normalizeIcd10(typeof raw === 'string' ? raw : '');
      if (!code || !CL.isZCode(code)) throw fieldError('z_codes', `${String(raw).slice(0, 12)} is not a social determinant code (Z55–Z65)`);
      if (!out.includes(code)) out.push(code);
    }
    v.z_codes = out.length ? out.join(',') : null;
  }
  return v;
}

function presentProblem(row) {
  return {
    id: row.id, client_id: row.client_id, status: row.status, onset_date: row.onset_date, resolved_date: row.resolved_date, source: row.source,
    added_by: row.added_by, updated_by: row.updated_by, added_by_name: row.added_by_name || null, updated_by_name: row.updated_by_name || null,
    created_at: row.created_at, updated_at: row.updated_at,
    problem: dec(row.problem_enc), icd10_code: dec(row.icd10_code_enc), icd10_description: dec(row.icd10_description_enc),
    z_codes: row.z_codes_enc ? dec(row.z_codes_enc).split(',').filter(Boolean) : [],
  };
}
function loadProblem(ctx, id) {
  const row = db.one(`SELECT p.*, a.display_name AS added_by_name, u.display_name AS updated_by_name FROM problems p LEFT JOIN users a ON a.id=p.added_by LEFT JOIN users u ON u.id=p.updated_by WHERE p.id=?`, id);
  if (!row) throw notFound('Problem not found');
  auth.assertClientAccess(ctx, row.client_id);
  return row;
}
function recordHistory(problem, clientId, userId, action, changes) {
  db.run(`INSERT INTO problem_history(id,problem_id,client_id,action,changes_enc,changed_by) VALUES(?,?,?,?,?,?)`, uuid(), problem, clientId, action, encrypt(JSON.stringify(changes)), userId);
}
// Notes that say they address each problem, counted over the note kinds this person may read.
function noteCounts(ctx, clientId) {
  const kinds = ['admin', 'clinical'].filter(k => auth.hasPerm(ctx.user, `notes:${k}:read`) || auth.hasPerm(ctx.user, `notes:${k}:write`));
  const counts = {};
  if (!kinds.length) return counts;
  for (const n of db.all(`SELECT problem_ids FROM notes WHERE client_id=? AND deleted_at IS NULL AND problem_ids IS NOT NULL AND kind IN (${kinds.map(() => '?').join(',')})`, clientId, ...kinds)) {
    let ids = []; try { ids = JSON.parse(n.problem_ids); } catch { ids = []; }
    if (Array.isArray(ids)) for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

// ---- care plan ----
const goalShape = {
  goal: { type: 'string', required: true, maxLen: 1000 },
  problem_id: { type: 'string', maxLen: 60 },
  status: { type: 'string', enum: CL.GOAL_STATUSES },
  start_date: { type: 'date' }, target_date: { type: 'date' }, review_date: { type: 'date' },
};
const stepShape = {
  step: { type: 'string', required: true, maxLen: 1000 },
  owner_role: { type: 'string', enum: CL.STEP_OWNERS },
  owner_user_id: { type: 'string', maxLen: 60 },
  target_date: { type: 'date' },
  status: { type: 'string', enum: CL.STEP_STATUSES },
};
function checkProblemOnClient(problemId, clientId) {
  if (!problemId) return;
  const p = db.one(`SELECT client_id FROM problems WHERE id=?`, problemId);
  if (!p || p.client_id !== clientId) throw fieldError('problem_id', 'is not on this client\'s problem list');
}
function checkOwner(userId) {
  if (userId && !db.one(`SELECT 1 FROM users WHERE id=?`, userId)) throw fieldError('owner_user_id', 'is not a staff account');
}
function loadGoal(ctx, id) {
  const g = db.one(`SELECT * FROM care_plan_goals WHERE id=?`, id);
  if (!g) throw notFound('Goal not found');
  auth.assertClientAccess(ctx, g.client_id);
  return g;
}
function loadStep(ctx, id) {
  const s = db.one(`SELECT * FROM care_plan_steps WHERE id=?`, id);
  if (!s) throw notFound('Step not found');
  auth.assertClientAccess(ctx, s.client_id);
  return s;
}
const canChange = (ctx, row, col) => row[col] === ctx.user.id || auth.hasPerm(ctx.user, 'clients:all');

/** The whole plan for a client, decrypted: goals with their steps and the problem each addresses. */
function carePlan(clientId) {
  const now = today();
  const problems = new Map(db.all(`SELECT id, problem_enc, status FROM problems WHERE client_id=?`, clientId).map(p => [p.id, { problem: dec(p.problem_enc), status: p.status }]));
  const steps = db.all(`SELECT s.*, u.display_name AS owner_name, t.status AS task_status FROM care_plan_steps s LEFT JOIN users u ON u.id=s.owner_user_id LEFT JOIN tasks t ON t.id=s.task_id WHERE s.client_id=? ORDER BY COALESCE(s.target_date,'9999'), s.created_at`, clientId);
  const goals = db.all(`SELECT g.*, u.display_name AS created_by_name FROM care_plan_goals g LEFT JOIN users u ON u.id=g.created_by WHERE g.client_id=? ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, COALESCE(g.review_date,'9999'), g.created_at`, clientId);
  return goals.map(g => {
    const out = { ...g, goal: dec(g.goal_enc), goal_enc: undefined, problem: g.problem_id && problems.get(g.problem_id) ? problems.get(g.problem_id).problem : null };
    out.review_overdue = g.status === 'active' && !!g.review_date && g.review_date < now;
    out.steps = steps.filter(s => s.goal_id === g.id).map(s => ({ ...s, step: dec(s.step_enc), step_enc: undefined, overdue: s.status === 'open' && !!s.target_date && s.target_date < now }));
    return out;
  });
}

module.exports = (r) => {
  // ---------- problem list ----------
  r.get('/api/clients/:id/problems', auth.requireAuth, auth.requirePerm('careplan:read', 'careplan:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const status = ctx.query.get('status');
    const where = ['p.client_id=?']; const params = [ctx.params.id];
    if (status && status !== 'all') { where.push('p.status=?'); params.push(status); }
    const rows = db.all(`SELECT p.*, a.display_name AS added_by_name, u.display_name AS updated_by_name FROM problems p LEFT JOIN users a ON a.id=p.added_by LEFT JOIN users u ON u.id=p.updated_by
      WHERE ${where.join(' AND ')} ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'inactive' THEN 1 ELSE 2 END, COALESCE(p.onset_date, p.created_at) DESC`, ...params);
    const counts = noteCounts(ctx, ctx.params.id);
    const goals = {};
    for (const g of db.all(`SELECT problem_id, COUNT(*) n FROM care_plan_goals WHERE client_id=? AND problem_id IS NOT NULL GROUP BY problem_id`, ctx.params.id)) goals[g.problem_id] = g.n;
    const out = rows.map(x => ({ ...presentProblem(x), notes: counts[x.id] || 0, goals: goals[x.id] || 0 }));
    audit.log({ user: ctx.user, action: 'problem.list', clientId: ctx.params.id, ip: ctx.ip, details: { count: out.length } });
    return { rows: out };
  });

  r.post('/api/clients/:id/problems', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const v = cleanCodes(validate(ctx.body, problemShape));
    const status = v.status || 'active';
    const resolved = status === 'resolved' ? (v.resolved_date || today()) : (v.resolved_date || null);
    const id = uuid();
    db.transaction(() => {
      db.run(`INSERT INTO problems(id,client_id,problem_enc,icd10_code_enc,icd10_description_enc,z_codes_enc,status,onset_date,resolved_date,source,added_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.params.id, encrypt(v.problem), v.icd10_code ? encrypt(v.icd10_code) : null, v.icd10_description ? encrypt(v.icd10_description) : null, v.z_codes ? encrypt(v.z_codes) : null,
        status, v.onset_date || null, resolved, v.source || 'self_report', ctx.user.id, ctx.user.id);
      const initial = {}; for (const k of TRACKED) { const val = k === 'status' ? status : k === 'resolved_date' ? resolved : k === 'source' ? (v.source || 'self_report') : v[k]; if (val !== undefined && val !== null) initial[k] = { from: null, to: val }; }
      recordHistory(id, ctx.params.id, ctx.user.id, 'created', initial);
    });
    audit.log({ user: ctx.user, action: 'problem.create', entity: 'problem', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { status, coded: !!v.icd10_code, z_codes: v.z_codes ? v.z_codes.split(',').length : 0 } });
    ctx.status = 201;
    return { id, updated_at: db.one(`SELECT updated_at FROM problems WHERE id=?`, id).updated_at };
  });

  r.get('/api/problems/:id', auth.requireAuth, auth.requirePerm('careplan:read', 'careplan:write'), (ctx) => {
    const row = loadProblem(ctx, ctx.params.id);
    audit.log({ user: ctx.user, action: 'problem.view', entity: 'problem', entityId: row.id, clientId: row.client_id, ip: ctx.ip });
    return { problem: presentProblem(row) };
  });

  r.put('/api/problems/:id', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    const row = loadProblem(ctx, ctx.params.id);
    assertFresh(ctx, row, 'problem');
    const v = cleanCodes(validate(ctx.body, Object.fromEntries(Object.entries(problemShape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true }));
    if (v.problem === null) throw fieldError('problem', 'is required');
    const before = presentProblem(row); before.z_codes = before.z_codes.length ? before.z_codes.join(',') : null;
    const next = { ...before };
    for (const k of TRACKED) if (v[k] !== undefined) next[k] = v[k];
    if (!next.status) next.status = before.status;
    if (!next.source) next.source = before.source;
    // Resolving a problem dates it (today unless a date is given); reopening one clears the date.
    if (next.status === 'resolved' && !next.resolved_date) next.resolved_date = today();
    if (v.status === 'active' && before.status !== 'active' && v.resolved_date === undefined) next.resolved_date = null;
    const changes = {};
    for (const k of TRACKED) if ((before[k] ?? null) !== (next[k] ?? null)) changes[k] = { from: before[k] ?? null, to: next[k] ?? null };
    if (!Object.keys(changes).length) return { ok: true, updated_at: row.updated_at, changed: [] };
    const stamp = db.now();
    db.transaction(() => {
      db.run(`UPDATE problems SET problem_enc=?, icd10_code_enc=?, icd10_description_enc=?, z_codes_enc=?, status=?, onset_date=?, resolved_date=?, source=?, updated_by=?, updated_at=? WHERE id=?`,
        encrypt(next.problem), next.icd10_code ? encrypt(next.icd10_code) : null, next.icd10_description ? encrypt(next.icd10_description) : null, next.z_codes ? encrypt(next.z_codes) : null,
        next.status, next.onset_date || null, next.resolved_date || null, next.source, ctx.user.id, stamp, row.id);
      recordHistory(row.id, row.client_id, ctx.user.id, 'updated', changes);
    });
    // Field names only: the values are the problem itself.
    audit.log({ user: ctx.user, action: 'problem.update', entity: 'problem', entityId: row.id, clientId: row.client_id, ip: ctx.ip, details: { fields: Object.keys(changes) } });
    return { ok: true, updated_at: stamp, changed: Object.keys(changes) };
  });

  r.get('/api/problems/:id/history', auth.requireAuth, auth.requirePerm('careplan:read', 'careplan:write'), (ctx) => {
    const row = loadProblem(ctx, ctx.params.id);
    const rows = db.all(`SELECT h.id, h.action, h.changes_enc, h.changed_by, h.created_at, u.display_name AS changed_by_name FROM problem_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.problem_id=? ORDER BY h.created_at, h.rowid`, row.id)
      .map(h => { let changes = {}; try { changes = JSON.parse(dec(h.changes_enc) || '{}'); } catch { changes = {}; } return { id: h.id, action: h.action, changed_by: h.changed_by, changed_by_name: h.changed_by_name, created_at: h.created_at, changes }; });
    audit.log({ user: ctx.user, action: 'problem.history.view', entity: 'problem', entityId: row.id, clientId: row.client_id, ip: ctx.ip, details: { count: rows.length } });
    return { rows };
  });

  // ---------- care coordination plan ----------
  r.get('/api/clients/:id/care-plan', auth.requireAuth, auth.requirePerm('careplan:read', 'careplan:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const goals = carePlan(ctx.params.id);
    audit.log({ user: ctx.user, action: 'careplan.view', clientId: ctx.params.id, ip: ctx.ip, details: { goals: goals.length } });
    return { goals, review_overdue: goals.filter(g => g.review_overdue).length, today: today() };
  });

  r.post('/api/clients/:id/goals', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const v = validate(ctx.body, goalShape);
    checkProblemOnClient(v.problem_id, ctx.params.id);
    const id = uuid();
    db.run(`INSERT INTO care_plan_goals(id,client_id,problem_id,goal_enc,status,start_date,target_date,review_date,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, v.problem_id || null, encrypt(v.goal), v.status || 'active', v.start_date || today(), v.target_date || null, v.review_date || null, ctx.user.id, ctx.user.id);
    audit.log({ user: ctx.user, action: 'careplan.goal.create', entity: 'care_plan_goal', entityId: id, clientId: ctx.params.id, ip: ctx.ip });
    ctx.status = 201;
    return { id, updated_at: db.one(`SELECT updated_at FROM care_plan_goals WHERE id=?`, id).updated_at };
  });

  r.put('/api/goals/:id', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    const g = loadGoal(ctx, ctx.params.id);
    assertFresh(ctx, g, 'care_plan_goal');
    const v = validate(ctx.body, { ...Object.fromEntries(Object.entries(goalShape).map(([k, s]) => [k, { ...s, required: false }])), reviewed: { type: 'boolean' } }, { partial: true });
    if (v.goal === null) throw fieldError('goal', 'is required');
    if (v.problem_id) checkProblemOnClient(v.problem_id, g.client_id);
    const sets = []; const params = [];
    if (v.goal !== undefined) { sets.push('goal_enc=?'); params.push(encrypt(v.goal)); }
    for (const k of ['problem_id', 'status', 'start_date', 'target_date', 'review_date']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    // "Reviewed today": the plan was gone over with the client. The next review date is whatever was sent.
    if (v.reviewed) { sets.push('reviewed_at=?'); params.push(today()); }
    const stamp = db.now();
    if (sets.length) db.run(`UPDATE care_plan_goals SET ${sets.join(', ')}, updated_by=?, updated_at=? WHERE id=?`, ...params, ctx.user.id, stamp, g.id);
    audit.log({ user: ctx.user, action: 'careplan.goal.update', entity: 'care_plan_goal', entityId: g.id, clientId: g.client_id, ip: ctx.ip, details: { fields: Object.keys(v).filter(k => v[k] !== undefined) } });
    return { ok: true, updated_at: sets.length ? stamp : g.updated_at };
  });

  r.delete('/api/goals/:id', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    const g = loadGoal(ctx, ctx.params.id);
    if (!canChange(ctx, g, 'created_by')) throw forbidden('Only the person who added this goal, or a supervisor, can delete it. Mark it discontinued instead.');
    const stepIds = db.all(`SELECT id FROM care_plan_steps WHERE goal_id=?`, g.id).map(s => s.id);
    db.transaction(() => {
      db.run(`DELETE FROM care_plan_steps WHERE goal_id=?`, g.id);
      for (const id of stepIds) db.tombstone('care_plan_steps', id);
      db.run(`DELETE FROM care_plan_goals WHERE id=?`, g.id); db.tombstone('care_plan_goals', g.id);
    });
    audit.log({ user: ctx.user, action: 'careplan.goal.delete', entity: 'care_plan_goal', entityId: g.id, clientId: g.client_id, ip: ctx.ip, details: { steps: stepIds.length } });
    return { ok: true };
  });

  r.post('/api/goals/:id/steps', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    const g = loadGoal(ctx, ctx.params.id);
    const v = validate(ctx.body, { ...stepShape, create_task: { type: 'boolean' } });
    checkOwner(v.owner_user_id);
    if (v.create_task && !auth.hasPerm(ctx.user, 'tasks:write')) throw forbidden('Your role cannot create to-dos');
    const id = uuid(); let taskId = null;
    db.transaction(() => {
      if (v.create_task) {
        taskId = uuid();
        db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority,status) VALUES(?,?,?,?,?,?,?,?,?)`,
          taskId, g.client_id, v.owner_user_id || ctx.user.id, ctx.user.id, encrypt(`Care plan: ${v.step}`.slice(0, 200)), encrypt(`Step toward the goal: ${dec(g.goal_enc)}`.slice(0, 2000)), v.target_date || null, 'normal', 'open');
      }
      db.run(`INSERT INTO care_plan_steps(id,goal_id,client_id,step_enc,owner_role,owner_user_id,target_date,status,task_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        id, g.id, g.client_id, encrypt(v.step), v.owner_role || 'staff', v.owner_user_id || null, v.target_date || null, v.status || 'open', taskId, ctx.user.id);
      db.run(`UPDATE care_plan_goals SET updated_at=? WHERE id=?`, db.now(), g.id);
    });
    audit.log({ user: ctx.user, action: 'careplan.step.create', entity: 'care_plan_step', entityId: id, clientId: g.client_id, ip: ctx.ip, details: { task_created: !!taskId } });
    if (taskId) audit.log({ user: ctx.user, action: 'task.create', entity: 'task', entityId: taskId, clientId: g.client_id, ip: ctx.ip, details: { from: 'care_plan_step' } });
    ctx.status = 201;
    return { id, task_id: taskId };
  });

  r.put('/api/steps/:id', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    const s = loadStep(ctx, ctx.params.id);
    assertFresh(ctx, s, 'care_plan_step');
    const v = validate(ctx.body, Object.fromEntries(Object.entries(stepShape).map(([k, x]) => [k, { ...x, required: false }])), { partial: true });
    if (v.step === null) throw fieldError('step', 'is required');
    checkOwner(v.owner_user_id);
    const sets = []; const params = [];
    if (v.step !== undefined) { sets.push('step_enc=?'); params.push(encrypt(v.step)); }
    for (const k of ['owner_role', 'owner_user_id', 'target_date', 'status']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    if (v.status === 'done' && s.status !== 'done') { sets.push('completed_at=?'); params.push(db.now()); }
    if (v.status && v.status !== 'done') { sets.push('completed_at=?'); params.push(null); }
    const stamp = db.now();
    db.transaction(() => {
      if (sets.length) db.run(`UPDATE care_plan_steps SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, stamp, s.id);
      // The to-do made for this step follows it: done or cancelled here closes it there.
      if (s.task_id && (v.status === 'done' || v.status === 'cancelled')) db.run(`UPDATE tasks SET status=?, completed_at=?, updated_at=? WHERE id=? AND status IN ('open','in_progress')`, v.status, v.status === 'done' ? db.now() : null, stamp, s.task_id);
    });
    audit.log({ user: ctx.user, action: 'careplan.step.update', entity: 'care_plan_step', entityId: s.id, clientId: s.client_id, ip: ctx.ip, details: { fields: Object.keys(v).filter(k => v[k] !== undefined) } });
    return { ok: true, updated_at: sets.length ? stamp : s.updated_at };
  });

  r.delete('/api/steps/:id', auth.requireAuth, auth.requirePerm('careplan:write'), (ctx) => {
    const s = loadStep(ctx, ctx.params.id);
    if (!canChange(ctx, s, 'created_by')) throw forbidden('Only the person who added this step, or a supervisor, can delete it. Mark it cancelled instead.');
    db.run(`DELETE FROM care_plan_steps WHERE id=?`, s.id); db.tombstone('care_plan_steps', s.id);
    audit.log({ user: ctx.user, action: 'careplan.step.delete', entity: 'care_plan_step', entityId: s.id, clientId: s.client_id, ip: ctx.ip });
    return { ok: true };
  });

  // ---------- the client Overview's clinical card ----------
  // Active problems, care plan reviews that are due, the latest ASAM assessment and each instrument's
  // trend — each part only for a role that may read it.
  r.get('/api/clients/:id/clinical-summary', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const id = ctx.params.id; const out = { today: today() };
    if (auth.hasPerm(ctx.user, 'careplan:read')) {
      out.problems = db.all(`SELECT * FROM problems WHERE client_id=? AND status='active' ORDER BY COALESCE(onset_date, created_at) DESC`, id).map(presentProblem);
      const goals = carePlan(id);
      out.care_plan = { active_goals: goals.filter(g => g.status === 'active').length, overdue_reviews: goals.filter(g => g.review_overdue).map(g => ({ id: g.id, goal: g.goal, review_date: g.review_date })),
        next_review: goals.filter(g => g.status === 'active' && g.review_date && !g.review_overdue).map(g => g.review_date).sort()[0] || null };
    }
    if (auth.hasPerm(ctx.user, 'assessments:read')) {
      const a = db.one(`SELECT a.*, u.display_name AS assessed_by_name FROM asam_assessments a LEFT JOIN users u ON u.id=a.assessed_by WHERE a.client_id=? ORDER BY a.assessed_at DESC, a.created_at DESC LIMIT 1`, id);
      out.asam = a ? { id: a.id, assessed_at: a.assessed_at, assessed_by_name: a.assessed_by_name, ratings: CL.ASAM_DIMENSIONS.map(d => a[`${d.key}_rating`]), recommended_loc: a.recommended_loc, actual_loc: a.actual_loc, discrepancy_reason: a.discrepancy_reason } : null;
      const series = {};
      for (const m of db.all(`SELECT id, instrument, administered_at, total_score, band, positive, safety_flag FROM outcome_measures WHERE client_id=? ORDER BY administered_at, created_at`, id)) (series[m.instrument] = series[m.instrument] || []).push(m);
      out.outcomes = Object.entries(series).map(([instrument, rows]) => ({ instrument, name: CL.INSTRUMENTS[instrument]?.name || instrument, better: CL.INSTRUMENTS[instrument]?.better, max: CL.INSTRUMENTS[instrument]?.max, latest: rows[rows.length - 1], baseline: rows[0], series: rows.map(x => ({ at: x.administered_at, score: x.total_score })) }));
      const phq = series.phq9 && series.phq9[series.phq9.length - 1];
      out.safety_alert = phq && phq.safety_flag ? { at: phq.administered_at, measure_id: phq.id } : null;
    }
    audit.log({ user: ctx.user, action: 'client.clinical_summary.view', entity: 'client', entityId: id, clientId: id, ip: ctx.ip, details: { parts: Object.keys(out).filter(k => k !== 'today') } });
    return out;
  });
};

module.exports.carePlan = carePlan;
