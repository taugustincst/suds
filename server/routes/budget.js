'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const crud = require('../crud');
const C = require('../constants');
const { badRequest, notFound, forbidden, HttpError } = require('../http');
const { validate } = require('../validate');
const { uuid, encrypt, decrypt } = require('../crypto');

// What an expenditure bought and for whom ("Motel night for J.") and the reviewer's note on it are free text
// that can name the client: both are encrypted (migration 37). The API keeps the names description and
// approval_note.
function encDescription(v) {
  if (v.description !== undefined) { v.description_enc = v.description ? encrypt(String(v.description)) : null; delete v.description; }
}
function presentExpenditure(e) {
  if (!e) return e;
  const o = { ...e };
  if ('description_enc' in e) { o.description = e.description_enc ? decrypt(e.description_enc) : null; delete o.description_enc; }
  if ('approval_note_enc' in e) { o.approval_note = e.approval_note_enc ? decrypt(e.approval_note_enc) : null; delete o.approval_note_enc; }
  return o;
}

/** Money is stored as REAL: round to cents at the boundary so 25.009999 is never written and never summed. */
const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const { localDate, localMidnight, orgTimezone, validTimezone } = require('../local-date');

// The fields of a fund and of a budget line, and what they must satisfy, are the tables' rules
// (server/rules/funding_sources.js, budget_lines.js), which sync push applies to a device's rows as well.
const rules = require('../rules');
const FUNDS = () => rules.forTable('funding_sources');
const LINES = () => rules.forTable('budget_lines');

// A sub-allocation is carved *out of* its parent's own envelope, not stacked on top of it — allocated_amount
// never sums up the tree (that would double-count the same money at every level it passes through). Actual
// spend does sum up: a transaction posted against a deeply nested line is real money leaving the whole
// envelope above it, wherever in the hierarchy someone happened to record it against.
function buildLineTree(flat) {
  const byId = new Map(flat.map(l => [l.id, { ...l, children: [] }]));
  const roots = [];
  for (const l of byId.values()) { const p = l.parent_id && byId.get(l.parent_id); if (p) p.children.push(l); else roots.push(l); }
  const rollup = (l) => {
    let subtreeSpent = l.spent, subtreePending = l.pending;
    for (const c of l.children) { rollup(c); subtreeSpent += c.subtree_spent; subtreePending += c.subtree_pending; }
    l.subtree_spent = cents(subtreeSpent); l.subtree_pending = cents(subtreePending); l.subtree_remaining = cents(l.allocated_amount - subtreeSpent - subtreePending);
    l.child_allocated = cents(l.children.reduce((s, c) => s + c.allocated_amount, 0)); l.unallocated = cents(l.allocated_amount - l.child_allocated);
    // What can still be spent directly against THIS line: its envelope less what it has handed down to
    // sub-allocations and less its own spend. subtree_remaining answers a different question ("how much
    // of the whole envelope is unspent") and read as "$50,000 left" on a parent that had already handed
    // $8,000 to a child -- the wrong number to be looking at while deciding whether to spend.
    l.available = cents(l.allocated_amount - l.child_allocated - l.spent - l.pending);
  };
  for (const r of roots) rollup(r);
  return roots;
}
// Would setting `proposedParentId` as lineId's parent nest a line inside its own sub-allocation? Walks up
// from the proposed parent toward the fund's top level; if it reaches lineId first, that is a cycle.
function wouldCycle(lineId, proposedParentId) {
  let cur = proposedParentId; const seen = new Set();
  while (cur) {
    if (cur === lineId || seen.has(cur)) return true;
    seen.add(cur);
    const row = db.one(`SELECT parent_id FROM budget_lines WHERE id=?`, cur);
    cur = row ? row.parent_id : null;
  }
  return false;
}

// A grant pays for what happened in its period. A date outside it, or in the future, is almost always a
// typo -- and if it is not, it belongs on a different fund. Either way it must not quietly land in this
// fund's totals, where the Funds card and the funder report then disagree and nobody can say why.
function assertInPeriod(fund, date, what) {
  if (!date) return;
  const today = localDate();
  if (date > today) throw badRequest(`${what} is in the future (${date})`);
  if (fund && ((fund.fiscal_year_start && date < fund.fiscal_year_start) || (fund.fiscal_year_end && date > fund.fiscal_year_end))) {
    throw badRequest(`${what} ${date} is outside the period of ${fund.name} (${fund.fiscal_year_start} to ${fund.fiscal_year_end}). Charge it to the fund that covers that date.`);
  }
}

const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * A budget line is carved out of whatever holds it: a sub-allocation out of its parent's allocated_amount,
 * a top-level line out of the fund's total. Lines that together promise more than that read as covered
 * money that does not exist, so they are refused, with the numbers, before they are written.
 */
function assertRoom(fundId, parentId, amount, { excluding = null } = {}) {
  const siblings = parentId
    ? db.one(`SELECT COALESCE(SUM(allocated_amount),0) n FROM budget_lines WHERE parent_id=? AND id<>?`, parentId, excluding || '').n
    : db.one(`SELECT COALESCE(SUM(allocated_amount),0) n FROM budget_lines WHERE funding_source_id=? AND parent_id IS NULL AND id<>?`, fundId, excluding || '').n;
  const holder = parentId
    ? db.one(`SELECT COALESCE(label, category) AS name, allocated_amount AS cap FROM budget_lines WHERE id=?`, parentId)
    : db.one(`SELECT name, total_amount AS cap FROM funding_sources WHERE id=?`, fundId);
  if (!holder) return;
  const total = cents(siblings + amount);
  if (total > cents(holder.cap)) {
    throw badRequest(`That would allocate ${money(total)} against ${holder.name}, which ${parentId ? 'is allocated' : 'totals'} ${money(holder.cap)}; ${money(cents(holder.cap - siblings))} is left to allocate. Reduce the amount, or raise ${parentId ? "the parent allocation" : "the fund's total"} first.`);
  }
}

/**
 * What can still be approved against a budget line: its allocation, less what it has handed down to
 * sub-allocations, less what is already approved or reimbursed. Other pending items are not counted (each
 * is judged when its own turn comes), and `excluding` leaves out the item being judged.
 */
function lineAvailable(lineId, { excluding = null } = {}) {
  const l = db.one(`SELECT * FROM budget_lines WHERE id=?`, lineId); if (!l) return null;
  const child = db.one(`SELECT COALESCE(SUM(allocated_amount),0) n FROM budget_lines WHERE parent_id=?`, lineId).n;
  const spent = db.one(`SELECT COALESCE(SUM(amount),0) n FROM expenditures WHERE budget_line_id=? AND status IN ('approved','reimbursed') AND id<>?`, lineId, excluding || '').n;
  return cents(l.allocated_amount - child - spent);
}

function fundSummary(f) {
  const spent = db.one(`SELECT ROUND(COALESCE(SUM(amount),0),2) n FROM expenditures WHERE funding_source_id=? AND status IN ('approved','reimbursed')`, f.id).n;
  const pending = db.one(`SELECT ROUND(COALESCE(SUM(amount),0),2) n FROM expenditures WHERE funding_source_id=? AND status='pending'`, f.id).n;
  const staffMinutes = db.one(`SELECT COALESCE(SUM(minutes),0) n FROM time_entries WHERE funding_source_id=?`, f.id).n;
  // The funder report counts approved time only (what a county can invoice); this page showed all logged
  // time under the same-sounding label, and the two never reconciled. Both are sent so the page can say which is which.
  const staffMinutesApproved = db.one(`SELECT COALESCE(SUM(minutes),0) n FROM time_entries WHERE funding_source_id=? AND status='approved'`, f.id).n;
  const staffCost = db.one(`SELECT ROUND(COALESCE(SUM(t.minutes/60.0*COALESCE(u.hourly_cost,0)),0),2) n FROM time_entries t JOIN users u ON u.id=t.user_id WHERE t.funding_source_id=?`, f.id).n;
  const flatLines = db.all(`SELECT b.*, (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM expenditures e WHERE e.budget_line_id=b.id AND e.status IN ('approved','reimbursed')) AS spent, (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM expenditures e WHERE e.budget_line_id=b.id AND e.status='pending') AS pending FROM budget_lines b WHERE b.funding_source_id=? ORDER BY category`, f.id);
  // Only top-level lines count against the fund's own total — a nested sub-allocation is carved out of its
  // parent's allocated_amount, not an additional draw on the fund (see buildLineTree).
  const allocated = flatLines.filter(l => !l.parent_id).reduce((s, l) => s + l.allocated_amount, 0);
  const lines = buildLineTree(flatLines);
  const totalDays = Math.max(1, (Date.parse(f.fiscal_year_end) - Date.parse(f.fiscal_year_start)) / 86400000);
  const elapsed = Math.min(totalDays, Math.max(0, (Date.now() - Date.parse(f.fiscal_year_start)) / 86400000));
  return { ...f, spent, pending, staff_minutes: staffMinutes, staff_minutes_approved: staffMinutesApproved, staff_cost: staffCost, allocated: cents(allocated), unallocated: cents(f.total_amount - allocated), remaining: cents(f.total_amount - spent - pending),
    pct_spent: f.total_amount ? (spent / f.total_amount) * 100 : 0, pct_elapsed: (elapsed / totalDays) * 100, lines };
}

module.exports = (r) => {
  r.get('/api/budget/funds', auth.requireAuth, auth.requirePerm('budget:read'), (ctx) => {
    const rows = db.all(`SELECT * FROM funding_sources ${ctx.query.get('all') === '1' ? '' : 'WHERE is_active=1'} ORDER BY fiscal_year_start DESC, name`);
    return { funds: rows.map(fundSummary) };
  });
  r.post('/api/budget/funds', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const v = validate(ctx.body, FUNDS().shape()); const id = uuid(); const keys = Object.keys(v);
    rules.assertWrite('funding_sources', v, ctx);
    db.run(`INSERT INTO funding_sources(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, id, ...keys.map(k => v[k]));
    audit.log({ user: ctx.user, action: 'fund.create', entity: 'funding_source', entityId: id, ip: ctx.ip });
    ctx.status = 201; return { id };
  });
  r.put('/api/budget/funds/:id', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const f = db.one(`SELECT * FROM funding_sources WHERE id=?`, ctx.params.id); if (!f) throw notFound();
    require('../crud').assertFresh(ctx, f, 'fund');
    const v = validate(ctx.body, FUNDS().partialShape(), { partial: true });
    const keys = Object.keys(v); if (!keys.length) return { ok: true, updated_at: f.updated_at };
    rules.assertWrite('funding_sources', { id: f.id, ...v }, ctx, { existing: f });
    const stamp = db.now();
    db.run(`UPDATE funding_sources SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), stamp, f.id);
    audit.log({ user: ctx.user, action: 'fund.update', entity: 'funding_source', entityId: f.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true, updated_at: stamp };
  });
  r.post('/api/budget/funds/:id/lines', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const f = db.one(`SELECT id FROM funding_sources WHERE id=?`, ctx.params.id); if (!f) throw notFound();
    const v = validate(ctx.body, LINES().shape()); const id = uuid();
    rules.assertWrite('budget_lines', { id, funding_source_id: f.id, ...v }, ctx);
    db.run(`INSERT INTO budget_lines(id,funding_source_id,parent_id,category,label,allocated_amount,notes) VALUES(?,?,?,?,?,?,?)`, id, f.id, v.parent_id || null, v.category, v.label || null, v.allocated_amount, v.notes || null);
    audit.log({ user: ctx.user, action: 'budget_line.create', entity: 'budget_line', entityId: id, ip: ctx.ip, details: v.parent_id ? { parent_id: v.parent_id } : undefined });
    ctx.status = 201; return { id };
  });
  r.put('/api/budget/lines/:id', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const l = db.one(`SELECT * FROM budget_lines WHERE id=?`, ctx.params.id); if (!l) throw notFound();
    require('../crud').assertFresh(ctx, l, 'budget_line');
    const v = validate(ctx.body, LINES().partialShape(), { partial: true });
    rules.assertWrite('budget_lines', { id: l.id, ...v }, ctx, { existing: l });
    const keys = Object.keys(v); const stamp = keys.length ? db.now() : l.updated_at;
    if (keys.length) db.run(`UPDATE budget_lines SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), stamp, l.id);
    audit.log({ user: ctx.user, action: 'budget_line.update', entity: 'budget_line', entityId: l.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true, updated_at: stamp };
  });
  r.delete('/api/budget/lines/:id', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    // budget_lines.parent_id is ON DELETE CASCADE, so deleting a line with sub-allocations removes them at
    // the SQLite level in the same statement -- no application code runs for them. Without gathering the
    // whole subtree up front, only the named line got a tombstone and an audit entry: other devices never
    // learned the children were gone (so they'd keep showing them, permanently diverged, until a push on one
    // of those phantom rows hit the FK and got rejected with no way to reconcile short of a full resync), and
    // an arbitrarily large sub-tree could be destroyed under a single audit-log entry.
    if (!db.one(`SELECT 1 FROM budget_lines WHERE id=?`, ctx.params.id)) throw notFound('Budget line not found');
    const no = require('../rules/budget_lines').deleteProblem(ctx.params.id);
    if (no) { audit.log({ user: ctx.user, action: 'budget_line.delete', entity: 'budget_line', entityId: ctx.params.id, ip: ctx.ip, success: false, details: { reason: 'approved spending' } }); throw new HttpError(409, no); }
    const ids = db.all(`WITH RECURSIVE sub(id) AS (SELECT id FROM budget_lines WHERE id=? UNION ALL SELECT b.id FROM budget_lines b JOIN sub ON b.parent_id=sub.id) SELECT id FROM sub`, ctx.params.id).map(row => row.id);
    db.run(`DELETE FROM budget_lines WHERE id=?`, ctx.params.id); // cascades to the rest of `ids`
    for (const id of ids) {
      db.tombstone('budget_lines', id);
      audit.log({ user: ctx.user, action: 'budget_line.delete', entity: 'budget_line', entityId: id, ip: ctx.ip });
    }
    return { ok: true };
  });

  crud.build(r, {
    table: 'expenditures', entity: 'expenditure', base: '/api/budget/expenditures', perm: 'budget', dateCol: 'spent_at', clientRequired: false,
    joins: 'JOIN users u ON u.id=expenditures.user_id JOIN funding_sources f ON f.id=expenditures.funding_source_id LEFT JOIN budget_lines b ON b.id=expenditures.budget_line_id LEFT JOIN clients c ON c.id=expenditures.client_id LEFT JOIN users a ON a.id=expenditures.approved_by',
    select: 'expenditures.*, u.display_name AS worker, f.name AS fund, b.label AS line_label, b.category AS line_category, c.client_code, a.display_name AS approver',
    // shape, owner, canEdit and the fund/period/line checks: server/rules/expenditures.js (crud.js reads them).
    filters: (ctx, where, params) => {
      const f = ctx.query.get('fund'); if (f) { where.push('expenditures.funding_source_id=?'); params.push(f); }
      const s = ctx.query.get('status'); if (s && s !== 'all') { where.push('expenditures.status=?'); params.push(s); }
    },
    // The date and fund are held to the same rules on an edit as on entry (the rules' check): a pending item could
    // otherwise be recorded in-period and then moved outside it, or into the future, once nobody was looking.
    beforeInsert: (ctx, v) => { v.amount = cents(v.amount); encDescription(v); },
    beforeUpdate: (ctx, v) => { if (v.amount !== undefined && v.amount !== null) v.amount = cents(v.amount); encDescription(v); },
    afterLoad: (ctx, x) => presentExpenditure(x),
  });
  // The approval state machine: pending -> approved | rejected, approved -> reimbursed, nothing else. A
  // second "approve" used to overwrite the first approver's name and date; a rejected item could be
  // approved afterwards; a reimbursed one could be un-reimbursed by approving it again. Money that has
  // moved keeps the record of who moved it.
  const TRANSITIONS = { pending: ['approved', 'rejected'], approved: ['reimbursed'] };
  r.post('/api/budget/expenditures/:id/approve', auth.requireAuth, auth.requirePerm('budget:approve'), async (ctx) => {
    require('../rules/shared').assertRulingHere('Approving, rejecting or reimbursing spending');
    const e = db.one(`SELECT * FROM expenditures WHERE id=?`, ctx.params.id); if (!e) throw notFound();
    const body = validate(ctx.body, { status: { type: 'string', required: true, enum: ['approved', 'rejected', 'reimbursed'] }, note: { type: 'string', maxLen: 500 }, force: { type: 'boolean' },
      password: { type: 'string', maxLen: 500 }, code: { type: 'string', maxLen: 10 }, confirm: { type: 'boolean' }, passkey: { type: 'object' } });
    const { status, note, force } = body;
    if (!(TRANSITIONS[e.status] || []).includes(status)) {
      const by = e.approved_by ? db.one(`SELECT display_name FROM users WHERE id=?`, e.approved_by) : null;
      throw new HttpError(409, `This expenditure is already ${e.status}${by ? ` (by ${by.display_name})` : ''}; it cannot be marked ${status}`, { current_status: e.status, approved_by: e.approved_by || null });
    }
    // No role is exempt: an administrator's own claim waits for someone else exactly like anyone's.
    if (e.user_id === ctx.user.id && status === 'approved') throw badRequest('Separation of duties: you cannot approve your own expenditure; another approver must review it');
    // Nor one they recorded for someone else, or whose amount or details they changed (security review of 1.16.0, M7).
    if (status === 'approved' && require('../rules/shared').recordedOrChanged('expenditure', 'expenditures', e.id, ctx.user.id)) throw forbidden('Separation of duties: you recorded or changed this expenditure, so another approver must review it');
    // A rejection with no reason leaves the submitter guessing, and there is no undo for a mis-click.
    if (status === 'rejected' && !note) throw badRequest('Say why this expenditure is being rejected, so the person who submitted it knows what to fix');
    // The note can name the client ("receipt shows J.'s name"): encrypted on the row, and the audit entry
    // records only that one was given.
    const details = { note_recorded: note ? true : undefined, amount: e.amount };
    if (status === 'approved' && e.budget_line_id) {
      // Overspending a line is not something a reviewer does by accident. Recording the expense already
      // warned; approving it is where the money is committed, so it takes a supervisor or administrator
      // saying so (force) with a note that says why, the same shape as the confirmation on time approval.
      const available = lineAvailable(e.budget_line_id, { excluding: e.id });
      if (available !== null && cents(e.amount) > available) {
        const over = cents(e.amount - available);
        const line = db.one(`SELECT label, category FROM budget_lines WHERE id=?`, e.budget_line_id);
        const mayForce = ['supervisor', 'admin'].includes(ctx.user.role);
        if (!(force && note && mayForce)) {
          throw new HttpError(409, `Approving ${e.amount.toFixed(2)} would take ${line.label || line.category} ${over.toFixed(2)} below zero (${available.toFixed(2)} available)${mayForce ? '. Approve it anyway with force and a note saying why.' : '. Ask a supervisor to approve it, or move it to a line with room.'}`,
            { overspend: true, available, over, force_allowed: mayForce });
        }
        details.overspend = over; details.forced = true;
      }
    }
    // Committing or paying out money may be confirmed with a fingerprint, or the password or code (auth.verifyApprover),
    // and must be, with a fingerprint or a code, under "Require fingerprint or authenticator for signing". Checked
    // after the budget line, so an overspend refusal does not spend a fingerprint confirmation (the retry with force uses it).
    if (status !== 'rejected') {
      const identity = await auth.verifyApprover(ctx, body, { action: 'expenditure.approve.failed', purpose: `mark this expenditure ${status}`, bind: body.passkey ? require('../passkeys').bindingFor(ctx, 'expenditure.approve', { id: e.id, status }) : null });
      if (identity) { details.identity = identity; if (ctx.signatureEvidence) details.evidence = ctx.signatureEvidence; }
    }
    if (status === 'reimbursed') {
      // The approver stays on the record; reimbursement is a later step by (often) a different person.
      db.run(`UPDATE expenditures SET status=?, approval_note_enc=COALESCE(?, approval_note_enc), updated_at=? WHERE id=?`, status, note ? encrypt(note) : null, db.now(), e.id);
      details.reimbursed_by = ctx.user.id;
    } else {
      db.run(`UPDATE expenditures SET status=?, approved_by=?, approved_at=?, approval_note_enc=?, updated_at=? WHERE id=?`, status, ctx.user.id, db.now(), note ? encrypt(note) : null, db.now(), e.id);
    }
    audit.log({ user: ctx.user, action: `expenditure.${status}`, entity: 'expenditure', entityId: e.id, clientId: e.client_id, ip: ctx.ip, details });
    return { ok: true, status };
  });
  r.get('/api/budget/summary', auth.requireAuth, auth.requirePerm('budget:read'), () => {
    const funds = db.all(`SELECT * FROM funding_sources WHERE is_active=1`).map(fundSummary);
    return {
      totals: { budget: cents(funds.reduce((s, f) => s + f.total_amount, 0)), spent: cents(funds.reduce((s, f) => s + f.spent, 0)), pending: cents(funds.reduce((s, f) => s + f.pending, 0)), remaining: cents(funds.reduce((s, f) => s + f.remaining, 0)) },
      by_category: db.all(`SELECT category, ROUND(SUM(amount),2) amount, COUNT(*) n FROM expenditures WHERE status IN ('approved','reimbursed') GROUP BY category ORDER BY amount DESC`),
      // Approved and reimbursed only, the same as the headline "Spent (approved)" figure above it: the two
      // used to differ by whatever was still pending, on the same page.
      by_month: db.all(`SELECT substr(spent_at,1,7) month, ROUND(SUM(amount),2) amount FROM expenditures WHERE status IN ('approved','reimbursed') GROUP BY month ORDER BY month`),
      per_client: db.one(`SELECT COUNT(DISTINCT client_id) clients, ROUND(COALESCE(SUM(amount),0),2) amount FROM expenditures WHERE client_id IS NOT NULL AND status IN ('approved','reimbursed')`),
      funds,
    };
  });
};
/**
 * The fund a new visit by `userId` is charged to when nobody chose one: the worker's own default, else the
 * programme's (the default_fund_id setting) — either only while it is an active fund.
 */
function defaultFundFor(userId) {
  const u = userId ? db.one(`SELECT default_fund_id FROM users WHERE id=?`, userId) : null;
  for (const id of [u && u.default_fund_id, db.getSetting('default_fund_id', null)]) if (id && db.one(`SELECT 1 FROM funding_sources WHERE id=? AND is_active=1`, id)) return id;
  return null;
}
module.exports.defaultFundFor = defaultFundFor;
/**
 * The programme's main fund, named in the first-run wizard (optional): created for the California fiscal
 * year (July to June) that `today` falls in, with no amount yet, and made the programme default unless one
 * is already set, so a new install's visits are charged to it rather than to "No funding source". Its dates,
 * amount and type are changed under Budget. Returns the new fund's id, or null for a blank name.
 * type: its source type (C.FUNDING_TYPES; 'other' when not given). An opioid settlement fund also takes its
 * allowable use and California HIAA (settlement_use, settlement_hiaa) as Funding & spending sets them: the
 * wizard used to create every fund as 'other', so a county's settlement allocation never reached the
 * settlement report.
 */
function createProgrammeFund(name, { today = localDate(), type = 'other', settlement_use = null, settlement_hiaa = null } = {}) {
  const n = String(name || '').trim().slice(0, 200);
  if (!n) return null;
  const y = Number(today.slice(0, 4)); const start = Number(today.slice(5, 7)) >= 7 ? y : y - 1;
  const id = uuid();
  const t = C.FUNDING_TYPES.includes(type) ? type : 'other';
  const settlement = t === 'opioid_settlement';
  const use = settlement && C.SETTLEMENT_USES.some(x => x.code === settlement_use) ? settlement_use : null;
  const hiaa = settlement && (settlement_hiaa === 'none' || C.SETTLEMENT_HIAA.some(x => x.code === settlement_hiaa)) ? settlement_hiaa : null;
  db.run(`INSERT INTO funding_sources(id,name,source_type,fiscal_year_start,fiscal_year_end,total_amount,settlement_use,settlement_hiaa) VALUES(?,?,?,?,?,0,?,?)`, id, n, t, `${start}-07-01`, `${start + 1}-06-30`, use, hiaa);
  if (!defaultFundFor(null)) db.setSetting('default_fund_id', id);
  return id;
}
module.exports.createProgrammeFund = createProgrammeFund;
// Reused by server/routes/sync.js: the REST route validates a re-parent through this, but a sync push
// applies budget_lines rows straight through importRow() with no such check — see that file for why.
module.exports.wouldCycle = wouldCycle;
module.exports.assertInPeriod = assertInPeriod;
module.exports.assertRoom = assertRoom;
module.exports.localDate = localDate;
module.exports.localMidnight = localMidnight;
module.exports.orgTimezone = orgTimezone;
module.exports.validTimezone = validTimezone;
module.exports.cents = cents;
module.exports.lineAvailable = lineAvailable;
module.exports.presentExpenditure = presentExpenditure;
