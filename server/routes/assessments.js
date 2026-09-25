'use strict';
// ASAM six-dimension assessments and outcome measures (scored screening instruments), and the programme
// outcomes report built from them.
//
// Both are clinical content: assessments:read / assessments:write (clinicians and supervisors; see
// server/auth.js). Answers, reasoning and notes are encrypted; ratings, levels of care, totals and bands
// are kept readable so the latest assessment, a trend and the de-identified outcomes report can be made.
// A PHQ-9 whose item 9 is answered above "Not at all" raises a safety alert when it is saved: an urgent
// to-do for the person who gave it, and a pointer to the client's safety plan (or a prompt to write one).
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const CL = require('../clinical');
const { badRequest, notFound, forbidden } = require('../http');
const { validate } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');
const { assertFresh } = require('../crud');

const dec = (v) => (v ? decrypt(v) : null);
const today = () => require('./budget').localDate();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function clientFor(ctx, clientId) {
  if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, clientId)) throw notFound('Client not found');
  auth.assertClientAccess(ctx, clientId);
}
const fieldError = (field, message) => badRequest('Validation failed', { fields: { [field]: message } });
const mayChange = (ctx, row, col) => row[col] === ctx.user.id || auth.hasPerm(ctx.user, 'clients:all');

// ---------- ASAM ----------
const ratingRule = { type: 'number', integer: true, min: 0, max: 4 };
const asamShape = {
  assessed_at: { type: 'date', required: true },
  d1_rating: { ...ratingRule, required: true }, d2_rating: { ...ratingRule, required: true }, d3_rating: { ...ratingRule, required: true },
  d4_rating: { ...ratingRule, required: true }, d5_rating: { ...ratingRule, required: true }, d6_rating: { ...ratingRule, required: true },
  dimension_notes: { type: 'object' },
  recommended_loc: { type: 'string', enum: C.ASAM }, actual_loc: { type: 'string', enum: C.ASAM },
  discrepancy_reason: { type: 'string', enum: CL.ASAM_DISCREPANCY_REASONS }, discrepancy_notes: { type: 'string', maxLen: 2000 },
  summary: { type: 'string', maxLen: 5000 },
  update_client_level: { type: 'boolean' },
};
function cleanDimensionNotes(notes) {
  if (notes === undefined || notes === null) return notes;
  if (Array.isArray(notes)) throw fieldError('dimension_notes', 'must be an object keyed d1 to d6');
  const out = {};
  for (const d of CL.ASAM_DIMENSIONS) {
    const v = notes[d.key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > 4000) throw fieldError('dimension_notes', `${d.key} must be text of at most 4000 characters`);
    out[d.key] = v.trim();
  }
  return out;
}
// The level referred to differs from the level recommended: DHCS expects the reason to be documented.
function checkDiscrepancy(rec, act, reason) {
  if (rec && act && rec !== act && rec !== 'unknown' && act !== 'unknown' && !reason) throw fieldError('discrepancy_reason', 'is required when the level referred to differs from the level recommended');
}
function presentAsam(a) {
  let notes = {}; try { notes = a.dimension_notes_enc ? JSON.parse(dec(a.dimension_notes_enc)) : {}; } catch { notes = {}; }
  const out = { ...a, dimension_notes: notes, discrepancy_notes: dec(a.discrepancy_notes_enc), summary: dec(a.summary_enc) };
  delete out.dimension_notes_enc; delete out.discrepancy_notes_enc; delete out.summary_enc;
  out.ratings = CL.ASAM_DIMENSIONS.map(d => a[`${d.key}_rating`]);
  out.discrepancy = !!(a.recommended_loc && a.actual_loc && a.recommended_loc !== a.actual_loc);
  return out;
}
function loadAsam(ctx, id) {
  const a = db.one(`SELECT a.*, u.display_name AS assessed_by_name FROM asam_assessments a LEFT JOIN users u ON u.id=a.assessed_by WHERE a.id=?`, id);
  if (!a) throw notFound('Assessment not found');
  auth.assertClientAccess(ctx, a.client_id);
  return a;
}
// The client record's "ASAM level" field follows the most recent assessment: the level referred to, or the
// level recommended when no referral level was given.
function syncClientLevel(ctx, clientId) {
  const latest = db.one(`SELECT recommended_loc, actual_loc FROM asam_assessments WHERE client_id=? ORDER BY assessed_at DESC, created_at DESC LIMIT 1`, clientId);
  if (!latest) return null;
  const level = latest.actual_loc && latest.actual_loc !== 'unknown' ? latest.actual_loc : latest.recommended_loc;
  if (!level || level === 'unknown') return null;
  const c = db.one(`SELECT asam_level FROM clients WHERE id=?`, clientId);
  if (c && c.asam_level !== level) {
    db.run(`UPDATE clients SET asam_level=?, updated_at=? WHERE id=?`, level, db.now(), clientId);
    audit.log({ user: ctx.user, action: 'client.update', entity: 'client', entityId: clientId, clientId, ip: ctx.ip, details: { fields: ['asam_level'], from: 'asam_assessment' } });
  }
  return level;
}

// ---------- outcome measures ----------
const outcomeShape = {
  instrument: { type: 'string', required: true, enum: CL.INSTRUMENT_CODES },
  administered_at: { type: 'date', required: true },
  responses: { type: 'array', required: true, maxLen: 20 },
  variant: { type: 'string', enum: ['men', 'women', 'unspecified'] },
  notes: { type: 'string', maxLen: 2000 },
};
// Optional instruments (server/clinical.js OPTIONAL_INSTRUMENTS, e.g. the DAST-10): off until an administrator
// enables one and confirms the programme holds the rights to use it. Results already recorded stay readable.
function instrumentEnabled(code) {
  const opt = CL.OPTIONAL_INSTRUMENTS[code];
  return !opt || db.getSetting(opt.setting, '0') === '1';
}
function assertInstrumentEnabled(code) {
  if (!instrumentEnabled(code)) throw fieldError('instrument', `${CL.INSTRUMENTS[code].name} is not enabled for this programme. An administrator can turn it on under Settings → Screening instruments, after confirming the programme holds the rights to use it.`);
}
function instrumentList() {
  return CL.INSTRUMENT_CODES.map((code) => {
    const ins = CL.INSTRUMENTS[code]; const opt = CL.OPTIONAL_INSTRUMENTS[code];
    const out = { code, name: ins.name, title: ins.title, optional: !!opt, enabled: instrumentEnabled(code) };
    if (opt) {
      const by = db.getSetting(`${opt.setting}_by`, null);
      Object.assign(out, { notice: opt.notice, confirmation: opt.confirmation, confirmed_at: out.enabled ? db.getSetting(`${opt.setting}_at`, null) : null,
        confirmed_by_name: out.enabled && by ? (db.one(`SELECT display_name FROM users WHERE id=?`, by) || {}).display_name || null : null });
    }
    return out;
  });
}
function scoreOrReject(instrument, responses, variant) {
  try { return CL.score(instrument, responses, { variant }); }
  catch (e) { throw badRequest(e.message, { fields: e.fields || { responses: 'invalid' } }); }
}
function presentOutcome(m) {
  let responses = []; try { responses = JSON.parse(dec(m.responses_enc) || '[]'); } catch { responses = []; }
  const out = { ...m, responses, notes: dec(m.notes_enc), name: CL.INSTRUMENTS[m.instrument]?.name || m.instrument };
  delete out.responses_enc; delete out.notes_enc;
  return out;
}
function loadOutcome(ctx, id) {
  const m = db.one(`SELECT m.*, u.display_name AS administered_by_name FROM outcome_measures m LEFT JOIN users u ON u.id=m.administered_by WHERE m.id=?`, id);
  if (!m) throw notFound('Measure not found');
  auth.assertClientAccess(ctx, m.client_id);
  return m;
}
/** The client's most recent signed safety plan this person may read (as the client page's chip finds it). */
function safetyPlanFor(ctx, clientId) {
  const kinds = ['admin', 'clinical'].filter(k => auth.hasPerm(ctx.user, `notes:${k}:read`) || auth.hasPerm(ctx.user, `notes:${k}:write`));
  if (!kinds.length) return null;
  return db.one(`SELECT id, occurred_at, status FROM notes WHERE client_id=? AND format='safety_plan' AND deleted_at IS NULL AND status IN ('signed','amended') AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY occurred_at DESC LIMIT 1`, clientId, ...kinds) || null;
}
/**
 * PHQ-9 item 9: a same-day follow-up to-do for the person who gave the questionnaire, urgent, so the
 * alert outlives the dialog that showed it. The wording names no score and no answer.
 */
function raiseSafetyAlert(ctx, clientId, measureId) {
  const taskId = uuid();
  db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority,status) VALUES(?,?,?,?,?,?,?,?,?)`,
    taskId, clientId, ctx.user.id, ctx.user.id, encrypt('Safety follow-up: PHQ-9 question 9 answered above "Not at all"'),
    encrypt('Assess risk today and review or write the safety plan with the client. Follow your programme\'s crisis protocol; for imminent danger call 988 or 911.'), today(), 'urgent', 'open');
  audit.log({ user: ctx.user, action: 'outcome.safety_alert', entity: 'outcome_measure', entityId: measureId, clientId, ip: ctx.ip, details: { task_id: taskId } });
  return taskId;
}

// ---------- programme outcomes (aggregate, de-identified) ----------
function outcomePairs(ctx, { from, to } = {}) {
  const cf = auth.caseloadFilter(ctx.user, 'm.client_id');
  const where = ['c.deleted_at IS NULL', cf.sql]; const params = [...cf.params];
  if (from) { where.push('substr(m.administered_at,1,10) >= ?'); params.push(from); }
  if (to) { where.push('substr(m.administered_at,1,10) <= ?'); params.push(to); }
  const rows = db.all(`SELECT m.client_id, c.client_code, m.instrument, m.administered_at, m.total_score, m.band, m.positive, m.safety_flag
    FROM outcome_measures m JOIN clients c ON c.id=m.client_id WHERE ${where.join(' AND ')} ORDER BY m.administered_at, m.created_at`, ...params);
  const by = new Map();
  for (const r of rows) { const k = `${r.instrument}|${r.client_id}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  const pairs = [];
  for (const list of by.values()) {
    const b = list[0], l = list[list.length - 1];
    pairs.push({ instrument: b.instrument, client_id: b.client_id, client_code: b.client_code, administrations: list.length, baseline: b, latest: l, safety_flags: list.filter(x => x.safety_flag).length,
      change: list.length > 1 ? l.total_score - b.total_score : null, direction: list.length > 1 ? CL.direction(b.instrument, b.total_score, l.total_score) : null });
  }
  return pairs;
}
function summarise(pairs) {
  const round = (n) => Math.round(n * 10) / 10;
  const mean = (a) => (a.length ? round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  // An optional instrument that is off and has no results in the period is not a row of zeros.
  return CL.INSTRUMENT_CODES.filter(code => instrumentEnabled(code) || pairs.some(p => p.instrument === code)).map(code => {
    const all = pairs.filter(p => p.instrument === code);
    const paired = all.filter(p => p.administrations > 1);
    const improved = paired.filter(p => p.direction === 1).length, worse = paired.filter(p => p.direction === -1).length;
    const ins = CL.INSTRUMENTS[code];
    return {
      instrument: code, name: ins.name, better: ins.better, clients_screened: all.length, clients_with_followup: paired.length,
      mean_baseline: mean(paired.map(p => p.baseline.total_score)), mean_latest: mean(paired.map(p => p.latest.total_score)), mean_change: mean(paired.map(p => p.change)),
      improved, worse, unchanged: paired.length - improved - worse, pct_improved: paired.length ? Math.round((improved / paired.length) * 100) : null,
      positive_at_baseline: paired.filter(p => p.baseline.positive === 1).length, positive_at_latest: paired.filter(p => p.latest.positive === 1).length,
      safety_flags: all.reduce((n, p) => n + p.safety_flags, 0),
    };
  });
}
function period(ctx) {
  const from = ctx.query.get('from') || null; const to = ctx.query.get('to') || null;
  for (const [k, v] of [['from', from], ['to', to]]) if (v && (!DAY.test(v) || !Number.isFinite(Date.parse(v)))) throw badRequest(`${k} must be a date (YYYY-MM-DD)`);
  return { from, to };
}

module.exports = (r) => {
  // ---------- ASAM ----------
  r.get('/api/clients/:id/asam', auth.requireAuth, auth.requirePerm('assessments:read', 'assessments:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const rows = db.all(`SELECT a.*, u.display_name AS assessed_by_name FROM asam_assessments a LEFT JOIN users u ON u.id=a.assessed_by WHERE a.client_id=? ORDER BY a.assessed_at DESC, a.created_at DESC`, ctx.params.id).map(presentAsam);
    audit.log({ user: ctx.user, action: 'asam.list', clientId: ctx.params.id, ip: ctx.ip, details: { count: rows.length } });
    return { rows, dimensions: CL.ASAM_DIMENSIONS };
  });

  r.post('/api/clients/:id/asam', auth.requireAuth, auth.requirePerm('assessments:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const v = validate(ctx.body, asamShape);
    const notes = cleanDimensionNotes(v.dimension_notes);
    checkDiscrepancy(v.recommended_loc, v.actual_loc, v.discrepancy_reason);
    const id = uuid(); let level = null;
    db.transaction(() => {
      db.run(`INSERT INTO asam_assessments(id,client_id,assessed_at,assessed_by,d1_rating,d2_rating,d3_rating,d4_rating,d5_rating,d6_rating,dimension_notes_enc,recommended_loc,actual_loc,discrepancy_reason,discrepancy_notes_enc,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.params.id, v.assessed_at, ctx.user.id, v.d1_rating, v.d2_rating, v.d3_rating, v.d4_rating, v.d5_rating, v.d6_rating,
        notes && Object.keys(notes).length ? encrypt(JSON.stringify(notes)) : null, v.recommended_loc || null, v.actual_loc || null, v.discrepancy_reason || null,
        v.discrepancy_notes ? encrypt(v.discrepancy_notes) : null, v.summary ? encrypt(v.summary) : null);
      if (v.update_client_level !== 0) level = syncClientLevel(ctx, ctx.params.id);
    });
    audit.log({ user: ctx.user, action: 'asam.create', entity: 'asam_assessment', entityId: id, clientId: ctx.params.id, ip: ctx.ip });
    ctx.status = 201;
    return { id, client_asam_level: level, updated_at: db.one(`SELECT updated_at FROM asam_assessments WHERE id=?`, id).updated_at };
  });

  r.get('/api/asam/:id', auth.requireAuth, auth.requirePerm('assessments:read', 'assessments:write'), (ctx) => {
    const a = loadAsam(ctx, ctx.params.id);
    audit.log({ user: ctx.user, action: 'asam.view', entity: 'asam_assessment', entityId: a.id, clientId: a.client_id, ip: ctx.ip });
    return { assessment: presentAsam(a), dimensions: CL.ASAM_DIMENSIONS };
  });

  r.put('/api/asam/:id', auth.requireAuth, auth.requirePerm('assessments:write'), (ctx) => {
    const a = loadAsam(ctx, ctx.params.id);
    if (!mayChange(ctx, a, 'assessed_by')) throw forbidden('Only the person who completed this assessment, or a supervisor, can change it');
    assertFresh(ctx, a, 'asam_assessment');
    const v = validate(ctx.body, Object.fromEntries(Object.entries(asamShape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true });
    for (const k of ['assessed_at', ...CL.ASAM_DIMENSIONS.map(d => `${d.key}_rating`)]) if (v[k] === null) throw fieldError(k, 'is required');
    const notes = cleanDimensionNotes(v.dimension_notes);
    const rec = v.recommended_loc !== undefined ? v.recommended_loc : a.recommended_loc, act = v.actual_loc !== undefined ? v.actual_loc : a.actual_loc;
    checkDiscrepancy(rec, act, v.discrepancy_reason !== undefined ? v.discrepancy_reason : a.discrepancy_reason);
    const sets = []; const params = [];
    for (const k of ['assessed_at', 'd1_rating', 'd2_rating', 'd3_rating', 'd4_rating', 'd5_rating', 'd6_rating', 'recommended_loc', 'actual_loc', 'discrepancy_reason']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    if (notes !== undefined) { sets.push('dimension_notes_enc=?'); params.push(notes && Object.keys(notes).length ? encrypt(JSON.stringify(notes)) : null); }
    if (v.discrepancy_notes !== undefined) { sets.push('discrepancy_notes_enc=?'); params.push(v.discrepancy_notes ? encrypt(v.discrepancy_notes) : null); }
    if (v.summary !== undefined) { sets.push('summary_enc=?'); params.push(v.summary ? encrypt(v.summary) : null); }
    const stamp = db.now();
    db.transaction(() => {
      if (sets.length) db.run(`UPDATE asam_assessments SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, stamp, a.id);
      if (v.update_client_level !== 0 && (v.recommended_loc !== undefined || v.actual_loc !== undefined || v.assessed_at !== undefined)) syncClientLevel(ctx, a.client_id);
    });
    audit.log({ user: ctx.user, action: 'asam.update', entity: 'asam_assessment', entityId: a.id, clientId: a.client_id, ip: ctx.ip, details: { fields: Object.keys(v).filter(k => v[k] !== undefined) } });
    return { ok: true, updated_at: sets.length ? stamp : a.updated_at };
  });

  r.delete('/api/asam/:id', auth.requireAuth, auth.requirePerm('assessments:write'), (ctx) => {
    const a = loadAsam(ctx, ctx.params.id);
    if (!mayChange(ctx, a, 'assessed_by')) throw forbidden('Only the person who completed this assessment, or a supervisor, can delete it');
    db.run(`DELETE FROM asam_assessments WHERE id=?`, a.id); db.tombstone('asam_assessments', a.id);
    audit.log({ user: ctx.user, action: 'asam.delete', entity: 'asam_assessment', entityId: a.id, clientId: a.client_id, ip: ctx.ip });
    return { ok: true };
  });

  // ---------- which instruments this programme uses ----------
  // Reference data, not PHI: every signed-in user may read it (the Assessments tab offers only enabled ones).
  r.get('/api/instruments', auth.requireAuth, () => ({ instruments: instrumentList() }));
  // Turning an optional instrument on needs the administrator's confirmation that the programme holds the
  // rights to use it; the confirmation text, who gave it and when are kept and audited.
  r.put('/api/admin/instruments/:code', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const opt = CL.OPTIONAL_INSTRUMENTS[ctx.params.code];
    if (!opt) throw notFound('No optional instrument by that name');
    const v = validate(ctx.body, { enabled: { type: 'boolean', required: true }, confirm_rights: { type: 'boolean' } });
    if (v.enabled && v.confirm_rights !== 1) throw fieldError('confirm_rights', `must be confirmed: ${opt.confirmation}`);
    db.transaction(() => {
      if (v.enabled) {
        db.setSetting(opt.setting, '1'); db.setSetting(`${opt.setting}_by`, ctx.user.id); db.setSetting(`${opt.setting}_at`, db.now());
      } else {
        for (const k of [opt.setting, `${opt.setting}_by`, `${opt.setting}_at`]) db.run(`DELETE FROM settings WHERE key=?`, k);
      }
    });
    audit.log({ user: ctx.user, action: v.enabled ? 'instrument.enable' : 'instrument.disable', entity: 'instrument', entityId: ctx.params.code, ip: ctx.ip,
      details: v.enabled ? { instrument: ctx.params.code, confirmation: opt.confirmation } : { instrument: ctx.params.code } });
    return { instruments: instrumentList() };
  });

  // ---------- outcome measures ----------
  r.get('/api/clients/:id/outcomes', auth.requireAuth, auth.requirePerm('assessments:read', 'assessments:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const rows = db.all(`SELECT m.*, u.display_name AS administered_by_name FROM outcome_measures m LEFT JOIN users u ON u.id=m.administered_by WHERE m.client_id=? ORDER BY m.administered_at DESC, m.created_at DESC`, ctx.params.id).map(presentOutcome);
    const series = {};
    for (const m of [...rows].reverse()) (series[m.instrument] = series[m.instrument] || []).push({ id: m.id, at: m.administered_at, score: m.total_score, band: m.band });
    audit.log({ user: ctx.user, action: 'outcome.list', clientId: ctx.params.id, ip: ctx.ip, details: { count: rows.length } });
    return { rows, series };
  });

  r.post('/api/clients/:id/outcomes', auth.requireAuth, auth.requirePerm('assessments:write'), (ctx) => {
    clientFor(ctx, ctx.params.id);
    const v = validate(ctx.body, outcomeShape);
    assertInstrumentEnabled(v.instrument);
    const s = scoreOrReject(v.instrument, v.responses, v.variant);
    const id = uuid(); let taskId = null;
    db.transaction(() => {
      db.run(`INSERT INTO outcome_measures(id,client_id,instrument,administered_at,administered_by,responses_enc,total_score,band,positive,variant,safety_flag,notes_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.params.id, v.instrument, v.administered_at, ctx.user.id, encrypt(JSON.stringify(s.responses)), s.total, s.band, s.positive, s.variant, s.safety_flag, v.notes ? encrypt(v.notes) : null);
      if (s.safety_flag && auth.hasPerm(ctx.user, 'tasks:write')) taskId = raiseSafetyAlert(ctx, ctx.params.id, id);
    });
    audit.log({ user: ctx.user, action: 'outcome.create', entity: 'outcome_measure', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { instrument: v.instrument } });
    ctx.status = 201;
    const alert = s.safety_flag ? {
      message: 'PHQ-9 question 9 was answered above "Not at all". Assess risk today and review the safety plan with the client. For imminent danger, follow your crisis protocol (988 / 911).',
      task_id: taskId, safety_plan: safetyPlanFor(ctx, ctx.params.id),
    } : null;
    return { id, total: s.total, band: s.band, positive: s.positive, safety_alert: alert };
  });

  r.get('/api/outcomes/:id', auth.requireAuth, auth.requirePerm('assessments:read', 'assessments:write'), (ctx) => {
    const m = loadOutcome(ctx, ctx.params.id);
    audit.log({ user: ctx.user, action: 'outcome.view', entity: 'outcome_measure', entityId: m.id, clientId: m.client_id, ip: ctx.ip });
    return { measure: presentOutcome(m) };
  });

  // Correct the answers (a question keyed wrongly): rescored as a new save would be.
  r.put('/api/outcomes/:id', auth.requireAuth, auth.requirePerm('assessments:write'), (ctx) => {
    const m = loadOutcome(ctx, ctx.params.id);
    if (!mayChange(ctx, m, 'administered_by')) throw forbidden('Only the person who gave this questionnaire, or a supervisor, can change it');
    assertFresh(ctx, m, 'outcome_measure');
    const v = validate(ctx.body, { administered_at: { type: 'date' }, responses: { type: 'array', maxLen: 20 }, variant: outcomeShape.variant, notes: outcomeShape.notes }, { partial: true });
    if (v.administered_at === null) throw fieldError('administered_at', 'is required');
    assertInstrumentEnabled(m.instrument);
    let responses; try { responses = JSON.parse(dec(m.responses_enc) || '[]'); } catch { responses = []; }
    const s = scoreOrReject(m.instrument, v.responses || responses, v.variant !== undefined ? v.variant : m.variant);
    const stamp = db.now(); let taskId = null;
    db.transaction(() => {
      db.run(`UPDATE outcome_measures SET administered_at=?, responses_enc=?, total_score=?, band=?, positive=?, variant=?, safety_flag=?, notes_enc=?, updated_at=? WHERE id=?`,
        v.administered_at || m.administered_at, encrypt(JSON.stringify(s.responses)), s.total, s.band, s.positive, s.variant, s.safety_flag,
        v.notes !== undefined ? (v.notes ? encrypt(v.notes) : null) : m.notes_enc, stamp, m.id);
      if (s.safety_flag && !m.safety_flag && auth.hasPerm(ctx.user, 'tasks:write')) taskId = raiseSafetyAlert(ctx, m.client_id, m.id);
    });
    audit.log({ user: ctx.user, action: 'outcome.update', entity: 'outcome_measure', entityId: m.id, clientId: m.client_id, ip: ctx.ip, details: { fields: Object.keys(v).filter(k => v[k] !== undefined) } });
    return { ok: true, updated_at: stamp, total: s.total, band: s.band, safety_alert: s.safety_flag && !m.safety_flag ? { task_id: taskId, safety_plan: safetyPlanFor(ctx, m.client_id) } : null };
  });

  r.delete('/api/outcomes/:id', auth.requireAuth, auth.requirePerm('assessments:write'), (ctx) => {
    const m = loadOutcome(ctx, ctx.params.id);
    if (!mayChange(ctx, m, 'administered_by')) throw forbidden('Only the person who gave this questionnaire, or a supervisor, can delete it');
    db.run(`DELETE FROM outcome_measures WHERE id=?`, m.id); db.tombstone('outcome_measures', m.id);
    audit.log({ user: ctx.user, action: 'outcome.delete', entity: 'outcome_measure', entityId: m.id, clientId: m.client_id, ip: ctx.ip, details: { instrument: m.instrument } });
    return { ok: true };
  });

  // ---------- programme outcomes report ----------
  // Aggregate only: counts, means and percentages per instrument, caseload scoped like every report.
  // Baseline is each client's first administration of an instrument in the period, latest their last.
  r.get('/api/reports/outcomes', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const p = period(ctx);
    const instruments = summarise(outcomePairs(ctx, p));
    audit.log({ user: ctx.user, action: 'report.outcomes', ip: ctx.ip, details: { from: p.from, to: p.to } });
    return { ...p, instruments };
  });

  // One row per client and instrument, de-identified under HIPAA Safe Harbor like every de-identified export
  // in SUDS (server/exports.js): dates reduced to the year, and the client code replaced by a record id
  // drawn at random for this export. No answers, no notes, no names.
  r.get('/api/reports/outcomes/export', auth.requireAuth, auth.requirePerm('export:read'), (ctx) => {
    const p = period(ctx);
    const X = require('../exports'); const S = require('../spreadsheet');
    const year = (v) => (v ? X.toYear(String(v)) : ''); const pseudo = X.pseudonymizer();
    const rows = outcomePairs(ctx, p).map(x => ({
      record_id: pseudo(x.client_id), instrument: CL.INSTRUMENTS[x.instrument].name, administrations: x.administrations,
      baseline_year: year(x.baseline.administered_at), baseline_score: x.baseline.total_score, baseline_band: x.baseline.band || '',
      latest_year: x.administrations > 1 ? year(x.latest.administered_at) : '', latest_score: x.administrations > 1 ? x.latest.total_score : '', latest_band: x.administrations > 1 ? (x.latest.band || '') : '',
      change: x.change === null ? '' : x.change, direction: x.direction === null ? '' : x.direction === 1 ? 'improved' : x.direction === -1 ? 'worse' : 'unchanged',
    }));
    const columns = ['record_id', 'instrument', 'administrations', 'baseline_year', 'baseline_score', 'baseline_band', 'latest_year', 'latest_score', 'latest_band', 'change', 'direction']
      .map(k => ({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }));
    audit.log({ user: ctx.user, action: 'report.export', ip: ctx.ip, details: { kind: 'outcomes', rows: rows.length, identified: false, from: p.from, to: p.to, format: 'csv' } });
    const filename = `suds-outcomes-${p.from || 'all'}_${p.to || 'all'}-deidentified.csv`;
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'X-SUDS-Export': `${X.DEID_LABEL} Generated ${db.now()}.`.replace(/[^\x20-\x7e]/g, '?') });
    ctx.res.end(S.toCsv(rows, columns));
  });
};

module.exports.summarise = summarise;
