'use strict';
// The rules for care plan goals, for /api/clients/:id/goals, /api/goals/:id and sync push: careplan:write, the
// care plan module switched on, a goal tied only to a problem on this client's list, and deleted only by the
// person who added it or a supervisor (it can always be marked discontinued).
const db = require('../db');
const CL = require('../clinical');
const { define, refuse } = require('./core');
const { ownedBy } = require('./shared');

module.exports = define({
  table: 'care_plan_goals',
  deviceColumns: ['reviewed_at'], createdBy: ['created_by'], updatedBy: ['updated_by'],
  module: 'careplan',
  fields: {
    goal: { type: 'string', required: true, maxLen: 1000 }, problem_id: { type: 'string', maxLen: 60 }, status: { type: 'string', enum: CL.GOAL_STATUSES },
    start_date: { type: 'date' }, target_date: { type: 'date' }, review_date: { type: 'date' },
  },
  deletableBy: ownedBy(['created_by'], 'records:manage-others', 'Only the person who added this goal, or a supervisor, can delete it. Mark it discontinued instead.'),
  // Its wording likewise: a goal keeps no history, so rewriting someone else's is deleting it (security review of
  // 1.16.0, L4). Its status and dates are anyone's on the plan.
  authorise: (row, c) => (c.existing && c.changed().includes('goal_enc') ? ownedBy(['created_by'], 'records:manage-others', 'Only the person who added this goal, or a supervisor, can change its wording')(c.user, c.existing) : null),
  check(row, c) {
    const pid = row.problem_id;
    if (!pid || (c.existing && pid === c.existing.problem_id)) return null;
    const clientId = c.existing ? c.existing.client_id : row.client_id;
    const p = db.one(`SELECT client_id FROM problems WHERE id=?`, pid);
    if (!p || p.client_id !== clientId) return refuse('has a value the office does not accept (the problem it addresses is not on this client\'s list)', { message: 'Validation failed', fields: { problem_id: 'is not on this client\'s problem list' } });
    return null;
  },
});
