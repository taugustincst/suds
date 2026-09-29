'use strict';
// The rules for care plan steps, for /api/goals/:id/steps, /api/steps/:id and sync push: careplan:write, the
// care plan module switched on, an owner who is a staff account, and deleted only by the person who added it or
// a supervisor, or with its goal.
const db = require('../db');
const auth = require('../auth');
const CL = require('../clinical');
const { define, refuse, notPermitted } = require('./core');

module.exports = define({
  table: 'care_plan_steps',
  deviceColumns: ['completed_at', 'task_id'], createdBy: ['created_by'],
  module: 'careplan',
  fields: {
    step: { type: 'string', required: true, maxLen: 1000 }, owner_role: { type: 'string', enum: CL.STEP_OWNERS }, owner_user_id: { type: 'string', maxLen: 60 },
    target_date: { type: 'date' }, status: { type: 'string', enum: CL.STEP_STATUSES },
  },
  // Deleting a goal deletes its steps, whoever added them (DELETE /api/goals/:id): a step whose goal goes in the
  // same push goes with it.
  deletableBy: (user, row, { deleting } = {}) => (row.created_by === user.id || auth.hasPerm(user, 'records:manage-others') || (deleting && deleting.has(`care_plan_goals:${row.goal_id}`)) ? null
    : notPermitted('Only the person who added this step, or a supervisor, can delete it. Mark it cancelled instead.')),
  // Its wording is the person's who added it, or records:manage-others' (security review of 1.16.0, L4).
  authorise: (row, c) => (c.existing && c.changed().includes('step_enc') && c.existing.created_by !== c.user.id && !auth.hasPerm(c.user, 'records:manage-others')
    ? notPermitted('Only the person who added this step, or a supervisor, can change its wording') : null),
  check(row, c) {
    // A device-minted owner id is the syncing user's own offline account, remapped when the row lands.
    if (c.via !== 'rest' || !row.owner_user_id || (c.existing && row.owner_user_id === c.existing.owner_user_id)) return null;
    if (!db.one(`SELECT 1 FROM users WHERE id=?`, row.owner_user_id)) return refuse('has a value the office does not accept (its owner is not a staff account)', { message: 'Validation failed', fields: { owner_user_id: 'is not a staff account' } });
    return null;
  },
});
