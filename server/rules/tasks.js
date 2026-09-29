'use strict';
// The rules for to-dos, for /api/tasks (crud.js) and sync push. A to-do is its assignee's or its creator's (or a
// manager's) to change, except that finishing someone's work closes theirs too: a discharge cancels the
// client's open to-dos, and recording a referral's outcome or completing a care-plan step closes the one made
// for it, whoever holds it (routes/episodes.js, referrals.js, careplan.js).
// A change notice (server/rules/clients.js notifyPrimary) tells a client's primary worker that someone off the care
// team changed the record: it is the primary worker's (or a manager's) to close or delete, never the editor's it
// reports on, whoever is recorded as its creator (1.16.1 recorded the editor; security review of 1.16.1, M2).
const auth = require('../auth');
const { define, notPermitted } = require('./core');

// Every change notice ends with this line (no id in it; the UI shows a notice as a read-only card: `notice: true`).
// "Reference: client record change by <user id>" is a 1.16.1 notice's: the same prefix.
const NOTICE_MARKER = 'Reference: client record change notice';
const NOTICE_PREFIX = 'Reference: client record change';
/** Is this to-do a change notice (server/rules/clients.js notifyPrimary)? Reads its encrypted details. */
function isNotice(row) {
  if (!row || !row.description_enc) return false;
  try { return require('../crypto').decrypt(row.description_enc).includes(NOTICE_PREFIX); } catch { return false; }
}
const NOTICE = 'This notice tells the client\'s primary worker about a change to their client\'s record; only they (or a supervisor) can close it';

module.exports = define({
  table: 'tasks',
  deviceColumns: ['referral_id'], createdBy: ['created_by'],
  fields: {
    client_id: { type: 'string' }, assigned_to: { type: 'string' }, title: { type: 'string', required: true, maxLen: 200 }, description: { type: 'string', maxLen: 2000 },
    due_at: { type: 'datetime' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
    is_milestone: { type: 'boolean' }, completed_at: { type: 'datetime' },
  },
  // A change notice is its assignee's (or a manager's) only: the 1.16.1 ones name the editor as creator.
  editableBy: (user, row) => {
    if (row.assigned_to === user.id || auth.hasPerm(user, 'records:manage-others')) return null;
    if (row.created_by === user.id) return isNotice(row) ? notPermitted(NOTICE) : null;
    return notPermitted('You cannot edit this record');
  },
  // Finishing someone's work closes theirs (a discharge on a device cancels the client's open to-dos); a change
  // notice only when that someone is on the client's care team, which its editor was not.
  othersMayChange: (existing, row, changed, c) => ['done', 'cancelled'].includes(row.status) && changed.every(col => col === 'status' || col === 'completed_at')
    && (!isNotice(existing) || !!(c && existing.client_id && require('../db').one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND ${auth.activeAssignment()}`, existing.client_id, c.user.id))),
});
Object.assign(module.exports, { NOTICE_MARKER, isNotice });
