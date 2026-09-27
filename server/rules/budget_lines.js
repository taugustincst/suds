'use strict';
// The rules for budget lines (a grant's allocations), for /api/budget/funds/:id/lines, /api/budget/lines/:id and
// sync push. Restructuring them is budget:manage. A line hangs off a line of its own fund, never off itself or
// its own sub-allocations, and lines never promise more than whatever holds them.
const db = require('../db');
const C = require('../constants');
const { define, refuse } = require('./core');

const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = define({
  table: 'budget_lines',
  fields: { category: { type: 'string', required: true, enum: C.BUDGET_CATEGORIES }, label: { type: 'string', maxLen: 200 }, allocated_amount: { type: 'number', required: true, min: 0 }, notes: { type: 'string', maxLen: 1000 }, parent_id: { type: 'string' } },
  check(row, c) {
    const B = require('../routes/budget');
    const e = c.existing || {};
    const fundId = c.existing ? e.funding_source_id : row.funding_source_id;
    const parentChanged = row.parent_id !== undefined && (row.parent_id || null) !== (e.parent_id || null);
    if (row.parent_id && parentChanged) {
      if (row.parent_id === row.id) return refuse('would create a cycle in its allocation hierarchy', { message: 'A budget line cannot be its own parent' });
      // A parent in another fund leaves the line out of its own fund's allocated total, silently inflating that
      // fund's "unallocated" figure while it still draws real expenditures.
      const parent = db.one(`SELECT funding_source_id FROM budget_lines WHERE id=?`, row.parent_id);
      if (parent && parent.funding_source_id !== fundId) return refuse('parent allocation does not belong to this fund', { message: 'Parent allocation does not belong to this fund' });
      if (!parent && c.via === 'rest') return refuse('parent allocation does not belong to this fund', { message: 'Parent allocation does not belong to this fund' });
      // Two lines each pointing at the other drop out of every fund's line tree (buildLineTree walks from roots).
      if (c.existing && B.wouldCycle(row.id, row.parent_id)) return refuse('would create a cycle in its allocation hierarchy', { message: 'That would nest this allocation inside one of its own sub-allocations' });
    }
    // Lines that together promise more than what holds them read as covered money that does not exist.
    if (!c.existing || parentChanged || (row.allocated_amount !== undefined && Number(row.allocated_amount) !== Number(e.allocated_amount))) {
      const parentId = row.parent_id !== undefined ? (row.parent_id || null) : (e.parent_id || null);
      const amount = row.allocated_amount ?? e.allocated_amount;
      try { B.assertRoom(fundId, parentId, amount, { excluding: c.existing ? row.id : null }); }
      catch (err) { return refuse('has a value the office does not accept (it allocates more than its fund or parent line holds)', { message: err.message }); }
      // Shrinking a line below what it has already handed down to sub-allocations is the same overrun from below.
      if (c.existing) {
        const handedDown = db.one(`SELECT COALESCE(SUM(allocated_amount),0) n FROM budget_lines WHERE parent_id=?`, row.id).n;
        if (B.cents(amount) < B.cents(handedDown)) return refuse('has a value the office does not accept (it is less than its sub-allocations)', { message: `Its sub-allocations already total ${money(handedDown)}; reduce those first` });
      }
    }
    return null;
  },
});
