'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const crud = require('../crud');
const C = require('../constants');
const config = require('../config');
const { badRequest, notFound, HttpError } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');

/** Money is stored as REAL: round to cents at the boundary so 25.009999 is never written and never summed. */
const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
/** The calendar date (YYYY-MM-DD) of an instant in the organisation's time zone (config.orgTimezone). */
function localDate(when = new Date(), tz = config.orgTimezone) {
  const d = when instanceof Date ? when : new Date(when);
  if (!Number.isFinite(d.getTime())) return null;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}

/**
 * The instant (ISO, UTC) at which calendar day `date` (YYYY-MM-DD) begins in the organisation's time zone.
 * A report "for June 30" runs from local midnight to local midnight: with the day's bounds taken in UTC
 * instead, a 5:30pm visit on June 30th in Los Angeles (00:30 UTC on July 1st) fell out of the fiscal year.
 * DST-safe: the offset is measured at the answer, not at the guess.
 */
function localMidnight(date, tz = config.orgTimezone) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(guess)) return null;
  const offset = (ms) => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - (ms - (ms % 1000));
    } catch { return 0; }
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first)).toISOString();
}

const fundShape = {
  name: { type: 'string', required: true, maxLen: 200 }, source_type: { type: 'string', enum: C.FUNDING_TYPES }, grant_number: { type: 'string', maxLen: 100 },
  fiscal_year_start: { type: 'date', required: true }, fiscal_year_end: { type: 'date', required: true }, total_amount: { type: 'number', required: true, min: 0 },
  restrictions: { type: 'string', maxLen: 2000 }, notes: { type: 'string', maxLen: 2000 }, is_active: { type: 'boolean' },
};
const lineShape = { category: { type: 'string', required: true, enum: C.BUDGET_CATEGORIES }, label: { type: 'string', maxLen: 200 }, allocated_amount: { type: 'number', required: true, min: 0 }, notes: { type: 'string', maxLen: 1000 }, parent_id: { type: 'string' } };

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
/** A period that ends before it starts is a typo, and every date check downstream would refuse everything. */
function assertPeriodOrder(start, end) {
  if (start && end && end < start) throw badRequest(`The period ends (${end}) before it starts (${start})`);
}
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
    const v = validate(ctx.body, fundShape); const id = uuid(); const keys = Object.keys(v);
    assertPeriodOrder(v.fiscal_year_start, v.fiscal_year_end);
    db.run(`INSERT INTO funding_sources(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, id, ...keys.map(k => v[k]));
    audit.log({ user: ctx.user, action: 'fund.create', entity: 'funding_source', entityId: id, ip: ctx.ip });
    ctx.status = 201; return { id };
  });
  r.put('/api/budget/funds/:id', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const f = db.one(`SELECT * FROM funding_sources WHERE id=?`, ctx.params.id); if (!f) throw notFound();
    const v = validate(ctx.body, Object.fromEntries(Object.entries(fundShape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true });
    const keys = Object.keys(v); if (!keys.length) return { ok: true };
    assertPeriodOrder(v.fiscal_year_start ?? f.fiscal_year_start, v.fiscal_year_end ?? f.fiscal_year_end);
    db.run(`UPDATE funding_sources SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), db.now(), f.id);
    audit.log({ user: ctx.user, action: 'fund.update', entity: 'funding_source', entityId: f.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true };
  });
  r.post('/api/budget/funds/:id/lines', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const f = db.one(`SELECT id FROM funding_sources WHERE id=?`, ctx.params.id); if (!f) throw notFound();
    const v = validate(ctx.body, lineShape); const id = uuid();
    if (v.parent_id) { const p = db.one(`SELECT id FROM budget_lines WHERE id=? AND funding_source_id=?`, v.parent_id, f.id); if (!p) throw badRequest('Parent allocation does not belong to this fund'); }
    assertRoom(f.id, v.parent_id || null, v.allocated_amount);
    db.run(`INSERT INTO budget_lines(id,funding_source_id,parent_id,category,label,allocated_amount,notes) VALUES(?,?,?,?,?,?,?)`, id, f.id, v.parent_id || null, v.category, v.label || null, v.allocated_amount, v.notes || null);
    audit.log({ user: ctx.user, action: 'budget_line.create', entity: 'budget_line', entityId: id, ip: ctx.ip, details: v.parent_id ? { parent_id: v.parent_id } : undefined });
    ctx.status = 201; return { id };
  });
  r.put('/api/budget/lines/:id', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const l = db.one(`SELECT * FROM budget_lines WHERE id=?`, ctx.params.id); if (!l) throw notFound();
    const v = validate(ctx.body, Object.fromEntries(Object.entries(lineShape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true });
    if ('parent_id' in v && v.parent_id) {
      if (v.parent_id === l.id) throw badRequest('A budget line cannot be its own parent');
      const p = db.one(`SELECT id FROM budget_lines WHERE id=? AND funding_source_id=?`, v.parent_id, l.funding_source_id); if (!p) throw badRequest('Parent allocation does not belong to this fund');
      if (wouldCycle(l.id, v.parent_id)) throw badRequest('That would nest this allocation inside one of its own sub-allocations');
    }
    if ('allocated_amount' in v || 'parent_id' in v) {
      const parentId = 'parent_id' in v ? (v.parent_id || null) : l.parent_id;
      const amount = v.allocated_amount ?? l.allocated_amount;
      assertRoom(l.funding_source_id, parentId, amount, { excluding: l.id });
      // Shrinking a line below what it has already handed down to sub-allocations is the same overrun from
      // the other side.
      const handedDown = db.one(`SELECT COALESCE(SUM(allocated_amount),0) n FROM budget_lines WHERE parent_id=?`, l.id).n;
      if (cents(amount) < cents(handedDown)) throw badRequest(`Its sub-allocations already total ${money(handedDown)}; reduce those first`);
    }
    const keys = Object.keys(v); if (keys.length) db.run(`UPDATE budget_lines SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), db.now(), l.id);
    audit.log({ user: ctx.user, action: 'budget_line.update', entity: 'budget_line', entityId: l.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true };
  });
  r.delete('/api/budget/lines/:id', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    // budget_lines.parent_id is ON DELETE CASCADE, so deleting a line with sub-allocations removes them at
    // the SQLite level in the same statement -- no application code runs for them. Without gathering the
    // whole subtree up front, only the named line got a tombstone and an audit entry: other devices never
    // learned the children were gone (so they'd keep showing them, permanently diverged, until a push on one
    // of those phantom rows hit the FK and got rejected with no way to reconcile short of a full resync), and
    // an arbitrarily large sub-tree could be destroyed under a single audit-log entry.
    const ids = db.all(`WITH RECURSIVE sub(id) AS (SELECT id FROM budget_lines WHERE id=? UNION ALL SELECT b.id FROM budget_lines b JOIN sub ON b.parent_id=sub.id) SELECT id FROM sub`, ctx.params.id).map(row => row.id);
    db.run(`DELETE FROM budget_lines WHERE id=?`, ctx.params.id); // cascades to the rest of `ids`
    for (const id of ids) {
      db.tombstone('budget_lines', id);
      audit.log({ user: ctx.user, action: 'budget_line.delete', entity: 'budget_line', entityId: id, ip: ctx.ip });
    }
    return { ok: true };
  });

  crud.build(r, {
    table: 'expenditures', entity: 'expenditure', base: '/api/budget/expenditures', perm: 'budget', dateCol: 'spent_at', clientRequired: false, restrictOwner: true,
    joins: 'JOIN users u ON u.id=expenditures.user_id JOIN funding_sources f ON f.id=expenditures.funding_source_id LEFT JOIN budget_lines b ON b.id=expenditures.budget_line_id LEFT JOIN clients c ON c.id=expenditures.client_id LEFT JOIN users a ON a.id=expenditures.approved_by',
    select: 'expenditures.*, u.display_name AS worker, f.name AS fund, b.label AS line_label, b.category AS line_category, c.client_code, a.display_name AS approver',
    // intervention_id is deliberately not writable here: it only ever means "this expenditure was
    // auto-posted from that service record" (server/routes/interventions.js's syncExpenditure, a raw INSERT
    // that bypasses this shape entirely). Accepting it from a normal request would let anyone attach a
    // second expenditure to an already-linked intervention, double-counting its cost.
    shape: {
      client_id: { type: 'string' }, user_id: { type: 'string' }, funding_source_id: { type: 'string', required: true }, budget_line_id: { type: 'string' },
      spent_at: { type: 'date', required: true }, amount: { type: 'number', required: true, min: 0.01 }, category: { type: 'string', required: true, enum: C.BUDGET_CATEGORIES },
      vendor: { type: 'string', maxLen: 200 }, description: { type: 'string', maxLen: 1000 }, receipt_ref: { type: 'string', maxLen: 200 },
    },
    filters: (ctx, where, params) => {
      const f = ctx.query.get('fund'); if (f) { where.push('expenditures.funding_source_id=?'); params.push(f); }
      const s = ctx.query.get('status'); if (s && s !== 'all') { where.push('expenditures.status=?'); params.push(s); }
    },
    beforeInsert: (ctx, v) => {
      v.amount = cents(v.amount);
      const f = db.one(`SELECT * FROM funding_sources WHERE id=? AND is_active=1`, v.funding_source_id); if (!f) throw badRequest('Unknown or inactive funding source');
      assertInPeriod(f, v.spent_at, 'Expenditure date');
      if (v.budget_line_id) { const l = db.one(`SELECT * FROM budget_lines WHERE id=? AND funding_source_id=?`, v.budget_line_id, f.id); if (!l) throw badRequest('Budget line does not belong to fund'); if (!v.category) v.category = l.category; }
    },
    beforeUpdate: (ctx, v, row) => {
      if (v.amount !== undefined && v.amount !== null) v.amount = cents(v.amount);
      // The date and fund are held to the same rules on an edit as on entry: a pending item could otherwise
      // be recorded in-period and then moved outside it, or into the future, once nobody was looking.
      if ('spent_at' in v || 'funding_source_id' in v || 'budget_line_id' in v) {
        const f = db.one(`SELECT * FROM funding_sources WHERE id=? AND is_active=1`, v.funding_source_id || row.funding_source_id); if (!f) throw badRequest('Unknown or inactive funding source');
        assertInPeriod(f, v.spent_at || row.spent_at, 'Expenditure date');
        const lineId = 'budget_line_id' in v ? v.budget_line_id : row.budget_line_id;
        if (lineId) { const l = db.one(`SELECT id FROM budget_lines WHERE id=? AND funding_source_id=?`, lineId, f.id); if (!l) throw badRequest('Budget line does not belong to fund'); }
      }
    },
    canEdit: (ctx, row) => row.status === 'pending' && (row.user_id === ctx.user.id || auth.hasPerm(ctx.user, 'budget:approve')),
  });
  // The approval state machine: pending -> approved | rejected, approved -> reimbursed, nothing else. A
  // second "approve" used to overwrite the first approver's name and date; a rejected item could be
  // approved afterwards; a reimbursed one could be un-reimbursed by approving it again. Money that has
  // moved keeps the record of who moved it.
  const TRANSITIONS = { pending: ['approved', 'rejected'], approved: ['reimbursed'] };
  r.post('/api/budget/expenditures/:id/approve', auth.requireAuth, auth.requirePerm('budget:approve'), (ctx) => {
    const e = db.one(`SELECT * FROM expenditures WHERE id=?`, ctx.params.id); if (!e) throw notFound();
    const { status, note, force } = validate(ctx.body, { status: { type: 'string', required: true, enum: ['approved', 'rejected', 'reimbursed'] }, note: { type: 'string', maxLen: 500 }, force: { type: 'boolean' } });
    if (!(TRANSITIONS[e.status] || []).includes(status)) {
      const by = e.approved_by ? db.one(`SELECT display_name FROM users WHERE id=?`, e.approved_by) : null;
      throw new HttpError(409, `This expenditure is already ${e.status}${by ? ` (by ${by.display_name})` : ''}; it cannot be marked ${status}`, { current_status: e.status, approved_by: e.approved_by || null });
    }
    // No role is exempt: an administrator's own claim waits for someone else exactly like anyone's.
    if (e.user_id === ctx.user.id && status === 'approved') throw badRequest('Separation of duties: you cannot approve your own expenditure; another approver must review it');
    // A rejection with no reason leaves the submitter guessing, and there is no undo for a mis-click.
    if (status === 'rejected' && !note) throw badRequest('Say why this expenditure is being rejected, so the person who submitted it knows what to fix');
    const details = { note, amount: e.amount };
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
    if (status === 'reimbursed') {
      // The approver stays on the record; reimbursement is a later step by (often) a different person.
      db.run(`UPDATE expenditures SET status=?, approval_note=COALESCE(?, approval_note), updated_at=? WHERE id=?`, status, note || null, db.now(), e.id);
      details.reimbursed_by = ctx.user.id;
    } else {
      db.run(`UPDATE expenditures SET status=?, approved_by=?, approved_at=?, approval_note=?, updated_at=? WHERE id=?`, status, ctx.user.id, db.now(), note || null, db.now(), e.id);
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
// Reused by server/routes/sync.js: the REST route validates a re-parent through this, but a sync push
// applies budget_lines rows straight through importRow() with no such check — see that file for why.
module.exports.wouldCycle = wouldCycle;
module.exports.assertInPeriod = assertInPeriod;
module.exports.localDate = localDate;
module.exports.localMidnight = localMidnight;
module.exports.cents = cents;
module.exports.lineAvailable = lineAvailable;
