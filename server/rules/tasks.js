'use strict';
// The rules for to-dos, for /api/tasks (crud.js) and sync push. A to-do is its assignee's or its creator's (or a
// manager's) to change, except that finishing someone's work closes theirs too: a discharge cancels the
// client's open to-dos, and recording a referral's outcome or completing a care-plan step closes the one made
// for it, whoever holds it (routes/episodes.js, referrals.js, careplan.js).
// A change notice (server/rules/clients.js notifyPrimary) tells a client's primary worker that someone off the care
// team changed the record: it is the primary worker's (or a manager's) to close or delete, never the editor's it
// reports on, whoever is recorded as its creator (1.16.1 recorded the editor; security review of 1.16.1, M2), and a
// discharge leaves it open (1.16.3).
const auth = require('../auth');
const { define, notPermitted } = require('./core');

// Every change notice ends with this line (no id in it; the UI shows a notice as a read-only card: `notice: true`).
// "Reference: client record change by <user id>" is a 1.16.1 notice's: the same prefix.
const NOTICE_MARKER = 'Reference: client record change notice';
const NOTICE_PREFIX = 'Reference: client record change';
/**
 * Is this to-do a change notice (server/rules/clients.js notifyPrimary)? Not by its text, which anyone can type
 * (security review of 1.16.2, L3), but by how it was raised: the audit entry of the edit it reports
 * (client.change_notice) names it and the worker it told, and it is that worker's own (created_by = assigned_to).
 * A 1.16.1 notice was recorded as the editor's and its entry named no to-do: it is one when that editor's entry
 * told this worker about this client as the to-do was written. The audit trail is the office's, so a device
 * knows only the notices raised on it; the office decides who may close one.
 */
function isNotice(row) {
  if (!row || !row.description_enc || !row.client_id || !row.assigned_to) return false;
  let text; try { text = require('../crypto').decrypt(row.description_enc); } catch { return false; }
  if (!text.includes(NOTICE_PREFIX)) return false;
  const db = require('../db');
  const told = (sql, ...params) => db.all(`SELECT details FROM audit_log WHERE client_id=? AND action='client.change_notice' ${sql}`, row.client_id, ...params)
    .some(a => { try { return JSON.parse(a.details).notified === row.assigned_to; } catch { return false; } });
  if (row.created_by === row.assigned_to && text.includes(NOTICE_MARKER)) return told(`AND details LIKE ?`, `%"task":"${String(row.id).replace(/[%_"\\]/g, '')}"%`);
  if (!row.created_at || !text.includes(`${NOTICE_PREFIX} by ${row.created_by}`)) return false;
  return told(`AND user_id=? AND at >= ? AND at <= ?`, row.created_by, row.created_at, new Date(Date.parse(row.created_at) + 60000).toISOString());
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
  // A notice a device raised for an edit made on it is that device's copy: the office raises its own when the edit
  // lands (clients.js afterApply), linked in its audit trail, so the device's is not taken (it would arrive as the
  // editor's ordinary to-do reading like a notice).
  authorise: (row, c) => (c.via === 'sync' && !c.existing && String(row.description_enc || '').includes(NOTICE_MARKER) ? { reason: null, quiet: true } : null),
  // Finishing someone's work closes theirs (a discharge on a device cancels the client's open to-dos); never a
  // change notice, which is not work but the primary worker's to read (security review of 1.16.2, M1).
  othersMayChange: (existing, row, changed) => ['done', 'cancelled'].includes(row.status) && changed.every(col => col === 'status' || col === 'completed_at') && !isNotice(existing),
});
Object.assign(module.exports, { NOTICE_MARKER, isNotice });
