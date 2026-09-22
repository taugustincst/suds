'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const C = require('../constants');
const { badRequest, forbidden } = require('../http');
const { uuid } = require('../crypto');
const supplies = require('./supplies');

// A direct cost against a fund always names the specific line it draws down — mirrors expenditures, where
// budget_line_id is optional on the column but the form never lets a real dollar amount through without a
// category, and here the category comes from the line rather than being typed a second time.
// This touches funding_source_id/budget_line_id/cost, which is real financial data — interventions:write
// alone is not enough to attach a cost to a fund, the same way it is not enough to POST an expenditure
// directly. Without this check, any role that can log a service (a clinician, who holds no budget
// permission at all) could post a pending expenditure against a fund or line they cannot even read.
function checkCost(ctx, v) {
  if (('cost' in v || 'funding_source_id' in v || 'budget_line_id' in v) && !auth.hasPerm(ctx.user, 'budget:write')) throw forbidden('You do not have permission to attach a cost to a funding source');
  if (v.cost && v.cost > 0) {
    if (!v.funding_source_id) throw badRequest('A funding source is required when a cost is entered');
    if (!v.budget_line_id) throw badRequest('A budget line is required when a cost is entered, so it is deducted from the right allocation');
    const line = db.one(`SELECT * FROM budget_lines WHERE id=? AND funding_source_id=?`, v.budget_line_id, v.funding_source_id);
    if (!line) throw badRequest('Budget line does not belong to the selected funding source');
    if (v.occurred_at) require('./budget').assertInPeriod(db.one(`SELECT * FROM funding_sources WHERE id=?`, v.funding_source_id), String(v.occurred_at).slice(0, 10), 'Date of service');
    return line;
  }
  if (v.budget_line_id && !v.funding_source_id) throw badRequest('A funding source is required when a budget line is selected');
  return null;
}
// Recording a service that draws on a fund is a real financial transaction, so it posts a pending
// expenditure the same way the budget page's own "Record expenditure" does — pending, not approved, so the
// existing separation-of-duties approval workflow still gates whether it counts as spent. Handles insert
// (no existing row), update (amend the still-pending one, or create/remove one as the cost is added or
// cleared) and is a no-op once the linked expenditure has been approved/rejected/reimbursed: that is real
// money that has already moved, and an edit to the service record must not silently rewrite it.
function syncExpenditure(row) {
  const existing = db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, row.id);
  if (existing && existing.status !== 'pending') return;
  const wantsCost = row.cost > 0 && row.funding_source_id && row.budget_line_id;
  if (!wantsCost) { if (existing) { db.run(`DELETE FROM expenditures WHERE id=?`, existing.id); db.tombstone('expenditures', existing.id); } return; }
  const line = db.one(`SELECT * FROM budget_lines WHERE id=? AND funding_source_id=?`, row.budget_line_id, row.funding_source_id);
  if (!line) return; // already validated on the way in; guards against a reference that went stale in between
  const desc = `Auto-recorded from ${row.type.replace(/_/g, ' ')}`;
  const spentAt = row.occurred_at.slice(0, 10);
  if (existing) db.run(`UPDATE expenditures SET funding_source_id=?, budget_line_id=?, client_id=?, spent_at=?, amount=?, category=?, description=?, updated_at=? WHERE id=?`,
    row.funding_source_id, row.budget_line_id, row.client_id || null, spentAt, row.cost, line.category, desc, db.now(), existing.id);
  else db.run(`INSERT INTO expenditures(id,funding_source_id,budget_line_id,client_id,user_id,intervention_id,spent_at,amount,category,description) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    uuid(), row.funding_source_id, row.budget_line_id, row.client_id || null, row.user_id, row.id, spentAt, row.cost, line.category, desc);
}

// The visit summary is clinical narrative about a named person, so it is stored encrypted like any other
// PHI field and decrypted on the way out.
function encodeSummary(v) { if (v.summary !== undefined) { v.summary_enc = v.summary ? require('../crypto').encrypt(v.summary) : null; delete v.summary; } }
function decodeSummary(row) {
  let summary = null;
  // A value that cannot be decrypted (a row written before this column was encrypted, or one whose key has
  // been rotated away) must not take the whole list down with it.
  if (row.summary_enc) { try { summary = require('../crypto').decrypt(row.summary_enc); } catch { summary = '[could not be read]'; } }
  return { ...row, summary, summary_enc: undefined };
}

module.exports = (r) => {
  crud.build(r, {
    table: 'interventions', entity: 'intervention', perm: 'interventions', clientRequired: false, dateCol: 'occurred_at', restrictOwner: true,
    joins: 'JOIN users u ON u.id=interventions.user_id LEFT JOIN clients c ON c.id=interventions.client_id LEFT JOIN funding_sources f ON f.id=interventions.funding_source_id',
    select: 'interventions.*, u.display_name AS worker, c.client_code, f.name AS funding_source',
    shape: {
      // Optional: community naloxone distribution and street outreach are services with no identified client.
      client_id: { type: 'string' }, user_id: { type: 'string' },
      type: { type: 'string', required: true, enum: C.INTERVENTION_TYPES }, occurred_at: { type: 'datetime', required: true },
      duration_minutes: { type: 'number', integer: true, min: 0, max: 1440 }, location: { type: 'string', enum: C.LOCATIONS }, modality: { type: 'string', enum: C.MODALITIES },
      outcome: { type: 'string', enum: C.OUTCOMES }, stage_of_change: { type: 'string', enum: C.STAGES }, naloxone_kits: { type: 'number', integer: true, min: 0 },
      fentanyl_strips: { type: 'number', integer: true, min: 0 }, funding_source_id: { type: 'string' }, budget_line_id: { type: 'string' }, cost: { type: 'number', min: 0 },
      summary: { type: 'string', maxLen: 2000 }, follow_up_due: { type: 'date' }, log_time: { type: 'boolean' }, time_category: { type: 'string', enum: C.TIME_CATEGORIES },
    },
    filters: (ctx, where, params) => { const t = ctx.query.get('type'); if (t) { where.push('interventions.type=?'); params.push(t); } },
    afterLoad: (ctx, row) => decodeSummary(row),
    beforeInsert: (ctx, v) => { v._log_time = v.log_time; delete v.log_time; v._time_category = v.time_category; delete v.time_category; encodeSummary(v); checkCost(ctx, v); },
    beforeUpdate: (ctx, v, row) => {
      delete v.log_time; delete v.time_category; encodeSummary(v);
      // Only validated when this edit actually touches cost/fund/line — an unrelated edit to a record from
      // before budget_line_id existed must not suddenly demand one just because cost happens to be nonzero.
      if ('cost' in v || 'funding_source_id' in v || 'budget_line_id' in v) checkCost(ctx, { funding_source_id: row.funding_source_id, budget_line_id: row.budget_line_id, cost: row.cost, occurred_at: row.occurred_at, ...v });
    },
    afterInsert: (ctx, row) => {
      // Optional automatic time entry + naloxone tracking on client
      if (row._log_time && row.duration_minutes > 0) {
        db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,intervention_id,description) VALUES(?,?,?,?,?,?,?,?,?)`,
          uuid(), row.user_id, row.client_id, row.occurred_at.slice(0, 10), row.duration_minutes, row._time_category || 'direct_service', row.funding_source_id || null, row.id, row.type.replace(/_/g, ' '));
      }
      // Community distribution has no client record to update, and no client to follow up with.
      if (row.naloxone_kits > 0 && row.client_id) db.run(`UPDATE clients SET naloxone_provided=1, naloxone_last_date=?, updated_at=? WHERE id=?`, row.occurred_at.slice(0, 10), db.now(), row.client_id);
      if (row.follow_up_due && row.client_id) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title,due_at,priority) VALUES(?,?,?,?,?,?,?)`,
        uuid(), row.client_id, row.user_id, ctx.user.id, `Follow up: ${row.type.replace(/_/g, ' ')}`, row.follow_up_due, 'normal');
      syncExpenditure(row);
      supplies.drawDown(ctx, row);
    },
    afterUpdate: (ctx, row, prev) => { syncExpenditure(row); supplies.drawDown(ctx, row, prev); },
    // The FK from expenditures.intervention_id is ON DELETE SET NULL, so this has to run before the delete
    // — after it, there is no longer any way to find the expenditure this intervention's cost created.
    beforeDelete: (ctx, row) => {
      const existing = db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, row.id);
      if (existing && existing.status === 'pending') { db.run(`DELETE FROM expenditures WHERE id=?`, existing.id); db.tombstone('expenditures', existing.id); }
    },
    canEdit: crud.ownerOrManager(),
  });
  // Only ever called post-login (public/app.js's loadRefData(), itself only reached after /api/auth/me
  // succeeds) — no reason for this to be the one route in the app reachable without a session.
  supplies(r);
  r.get('/api/meta/constants', auth.requireAuth, () => C);
};
