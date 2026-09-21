'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const crud = require('../crud');
const C = require('../constants');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');

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
    l.subtree_spent = subtreeSpent; l.subtree_pending = subtreePending; l.subtree_remaining = l.allocated_amount - subtreeSpent - subtreePending;
    l.child_allocated = l.children.reduce((s, c) => s + c.allocated_amount, 0); l.unallocated = l.allocated_amount - l.child_allocated;
    // What can still be spent directly against THIS line: its envelope less what it has handed down to
    // sub-allocations and less its own spend. subtree_remaining answers a different question ("how much
    // of the whole envelope is unspent") and read as "$50,000 left" on a parent that had already handed
    // $8,000 to a child -- the wrong number to be looking at while deciding whether to spend.
    l.available = l.allocated_amount - l.child_allocated - l.spent - l.pending;
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

function fundSummary(f) {
  const spent = db.one(`SELECT COALESCE(SUM(amount),0) n FROM expenditures WHERE funding_source_id=? AND status IN ('approved','reimbursed')`, f.id).n;
  const pending = db.one(`SELECT COALESCE(SUM(amount),0) n FROM expenditures WHERE funding_source_id=? AND status='pending'`, f.id).n;
  const staffMinutes = db.one(`SELECT COALESCE(SUM(minutes),0) n FROM time_entries WHERE funding_source_id=?`, f.id).n;
  // The funder report counts approved time only (what a county can invoice); this page showed all logged
  // time under the same-sounding label, and the two never reconciled. Both are sent so the page can say which is which.
  const staffMinutesApproved = db.one(`SELECT COALESCE(SUM(minutes),0) n FROM time_entries WHERE funding_source_id=? AND status='approved'`, f.id).n;
  const staffCost = db.one(`SELECT COALESCE(SUM(t.minutes/60.0*COALESCE(u.hourly_cost,0)),0) n FROM time_entries t JOIN users u ON u.id=t.user_id WHERE t.funding_source_id=?`, f.id).n;
  const flatLines = db.all(`SELECT b.*, (SELECT COALESCE(SUM(amount),0) FROM expenditures e WHERE e.budget_line_id=b.id AND e.status IN ('approved','reimbursed')) AS spent, (SELECT COALESCE(SUM(amount),0) FROM expenditures e WHERE e.budget_line_id=b.id AND e.status='pending') AS pending FROM budget_lines b WHERE b.funding_source_id=? ORDER BY category`, f.id);
  // Only top-level lines count against the fund's own total — a nested sub-allocation is carved out of its
  // parent's allocated_amount, not an additional draw on the fund (see buildLineTree).
  const allocated = flatLines.filter(l => !l.parent_id).reduce((s, l) => s + l.allocated_amount, 0);
  const lines = buildLineTree(flatLines);
  const totalDays = Math.max(1, (Date.parse(f.fiscal_year_end) - Date.parse(f.fiscal_year_start)) / 86400000);
  const elapsed = Math.min(totalDays, Math.max(0, (Date.now() - Date.parse(f.fiscal_year_start)) / 86400000));
  return { ...f, spent, pending, staff_minutes: staffMinutes, staff_minutes_approved: staffMinutesApproved, staff_cost: staffCost, allocated, unallocated: f.total_amount - allocated, remaining: f.total_amount - spent - pending,
    pct_spent: f.total_amount ? (spent / f.total_amount) * 100 : 0, pct_elapsed: (elapsed / totalDays) * 100, lines };
}

module.exports = (r) => {
  r.get('/api/budget/funds', auth.requireAuth, auth.requirePerm('budget:read'), (ctx) => {
    const rows = db.all(`SELECT * FROM funding_sources ${ctx.query.get('all') === '1' ? '' : 'WHERE is_active=1'} ORDER BY fiscal_year_start DESC, name`);
    return { funds: rows.map(fundSummary) };
  });
  r.post('/api/budget/funds', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const v = validate(ctx.body, fundShape); const id = uuid(); const keys = Object.keys(v);
    db.run(`INSERT INTO funding_sources(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, id, ...keys.map(k => v[k]));
    audit.log({ user: ctx.user, action: 'fund.create', entity: 'funding_source', entityId: id, ip: ctx.ip });
    ctx.status = 201; return { id };
  });
  r.put('/api/budget/funds/:id', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const f = db.one(`SELECT id FROM funding_sources WHERE id=?`, ctx.params.id); if (!f) throw notFound();
    const v = validate(ctx.body, Object.fromEntries(Object.entries(fundShape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true });
    const keys = Object.keys(v); if (!keys.length) return { ok: true };
    db.run(`UPDATE funding_sources SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), db.now(), f.id);
    audit.log({ user: ctx.user, action: 'fund.update', entity: 'funding_source', entityId: f.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true };
  });
  r.post('/api/budget/funds/:id/lines', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const f = db.one(`SELECT id FROM funding_sources WHERE id=?`, ctx.params.id); if (!f) throw notFound();
    const v = validate(ctx.body, lineShape); const id = uuid();
    if (v.parent_id) { const p = db.one(`SELECT id FROM budget_lines WHERE id=? AND funding_source_id=?`, v.parent_id, f.id); if (!p) throw badRequest('Parent allocation does not belong to this fund'); }
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
      const f = db.one(`SELECT * FROM funding_sources WHERE id=? AND is_active=1`, v.funding_source_id); if (!f) throw badRequest('Unknown or inactive funding source');
      if (v.budget_line_id) { const l = db.one(`SELECT * FROM budget_lines WHERE id=? AND funding_source_id=?`, v.budget_line_id, f.id); if (!l) throw badRequest('Budget line does not belong to fund'); if (!v.category) v.category = l.category; }
    },
    canEdit: (ctx, row) => row.status === 'pending' && (row.user_id === ctx.user.id || auth.hasPerm(ctx.user, 'budget:approve')),
  });
  r.post('/api/budget/expenditures/:id/approve', auth.requireAuth, auth.requirePerm('budget:approve'), (ctx) => {
    const e = db.one(`SELECT * FROM expenditures WHERE id=?`, ctx.params.id); if (!e) throw notFound();
    const { status, note } = validate(ctx.body, { status: { type: 'string', required: true, enum: ['approved', 'rejected', 'reimbursed'] }, note: { type: 'string', maxLen: 500 } });
    if (e.user_id === ctx.user.id && status === 'approved' && ctx.user.role !== 'admin') throw badRequest('Separation of duties: you cannot approve your own expenditure');
    // A rejection with no reason leaves the submitter guessing, and there is no undo for a mis-click.
    if (status === 'rejected' && !note) throw badRequest('Say why this expenditure is being rejected, so the person who submitted it knows what to fix');
    db.run(`UPDATE expenditures SET status=?, approved_by=?, approved_at=?, approval_note=?, updated_at=? WHERE id=?`, status, ctx.user.id, db.now(), note || null, db.now(), e.id);
    audit.log({ user: ctx.user, action: `expenditure.${status}`, entity: 'expenditure', entityId: e.id, clientId: e.client_id, ip: ctx.ip, details: { note, amount: e.amount } });
    return { ok: true };
  });
  r.get('/api/budget/summary', auth.requireAuth, auth.requirePerm('budget:read'), () => {
    const funds = db.all(`SELECT * FROM funding_sources WHERE is_active=1`).map(fundSummary);
    return {
      totals: { budget: funds.reduce((s, f) => s + f.total_amount, 0), spent: funds.reduce((s, f) => s + f.spent, 0), pending: funds.reduce((s, f) => s + f.pending, 0), remaining: funds.reduce((s, f) => s + f.remaining, 0) },
      by_category: db.all(`SELECT category, SUM(amount) amount, COUNT(*) n FROM expenditures WHERE status IN ('approved','reimbursed') GROUP BY category ORDER BY amount DESC`),
      by_month: db.all(`SELECT substr(spent_at,1,7) month, SUM(amount) amount FROM expenditures WHERE status<>'rejected' GROUP BY month ORDER BY month`),
      per_client: db.one(`SELECT COUNT(DISTINCT client_id) clients, COALESCE(SUM(amount),0) amount FROM expenditures WHERE client_id IS NOT NULL AND status IN ('approved','reimbursed')`),
      funds,
    };
  });
};
// Reused by server/routes/sync.js: the REST route validates a re-parent through this, but a sync push
// applies budget_lines rows straight through importRow() with no such check — see that file for why.
module.exports.wouldCycle = wouldCycle;
