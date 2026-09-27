'use strict';
// The rules for to-dos, for /api/tasks (crud.js) and sync push. A to-do is its assignee's or its creator's (or a
// manager's) to change, except that finishing someone's work closes theirs too: a discharge cancels the
// client's open to-dos, and recording a referral's outcome or completing a care-plan step closes the one made
// for it, whoever holds it (routes/episodes.js, referrals.js, careplan.js).
const auth = require('../auth');
const { define, notPermitted } = require('./core');

module.exports = define({
  table: 'tasks',
  fields: {
    client_id: { type: 'string' }, assigned_to: { type: 'string' }, title: { type: 'string', required: true, maxLen: 200 }, description: { type: 'string', maxLen: 2000 },
    due_at: { type: 'datetime' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
    is_milestone: { type: 'boolean' }, completed_at: { type: 'datetime' },
  },
  editableBy: (user, row) => (row.assigned_to === user.id || row.created_by === user.id || auth.hasPerm(user, 'clients:all') ? null : notPermitted('You cannot edit this record')),
  othersMayChange: (existing, row, changed) => ['done', 'cancelled'].includes(row.status) && changed.every(col => col === 'status' || col === 'completed_at'),
});
