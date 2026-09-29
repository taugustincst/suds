'use strict';
// The rules for to-dos, for /api/tasks (crud.js) and sync push. A to-do is its assignee's or its creator's (or a
// manager's) to change, except that finishing someone's work closes theirs too: a discharge cancels the
// client's open to-dos, and recording a referral's outcome or completing a care-plan step closes the one made
// for it, whoever holds it (routes/episodes.js, referrals.js, careplan.js).
// A change notice (server/rules/clients.js notifyPrimary) tells a client's primary worker that someone off the care
// team changed the record. It is the primary worker's: only they mark it seen (close it) or change it; a supervisor
// (records:manage-others) may delete one, for a worker who has left, but not mark it seen on their behalf (UX
// review of 1.16.3, M2); and a discharge leaves it open (1.16.3).
const auth = require('../auth');
const { define, notPermitted } = require('./core');

// Every change notice ends with this line (no id in it; the UI shows a notice as a read-only card: `notice: true`).
const NOTICE_MARKER = 'Reference: client record change notice';
/**
 * The audit entry that raised this to-do as a change notice (server/rules/clients.js notifyPrimary), or null. Not
 * its text, which anyone can type (security review of 1.16.2, L3), but how it was raised: the entry of the edit it
 * reports (client.change_notice) names it and the worker it told, and it is that worker's own (created_by =
 * assigned_to). The 1.16.1 rule (a to-do reading "... change by <user id>", written as an edit by that user told
 * this worker) is gone: it let anyone forge one that named someone else (security review of 1.16.3, N5), and such
 * a to-do is now an ordinary one. The audit trail is the office's, so a device knows only the notices raised on it
 * and those the office names to it (local/sync.js); the office decides who may close one.
 */
function noticeEntry(row) {
  if (!row || !row.description_enc || !row.client_id || !row.assigned_to || row.created_by !== row.assigned_to) return null;
  let text; try { text = require('../crypto').decrypt(row.description_enc); } catch { return null; }
  if (!text.includes(NOTICE_MARKER)) return null;
  return require('../db').all(`SELECT user_id, details FROM audit_log WHERE client_id=? AND action='client.change_notice' AND details LIKE ?`, row.client_id, `%"task":"${String(row.id).replace(/[%_"\\]/g, '')}"%`)
    .find(a => { try { return JSON.parse(a.details).notified === row.assigned_to; } catch { return false; } }) || null;
}
// The notices the office named to this device, with who made each change (local/sync.js keepNotices): a device's
// audit trail has only its own. Never filled at the office, and never by a device on its own say.
const noticeIds = new Map();
const isNotice = (row) => !!noticeEntry(row) || (!!row && noticeIds.has(row.id));
/** The account whose edit a notice reports: its audit entry's, or the office's word for it on a device. */
const noticeBy = (row) => (noticeEntry(row) || {}).user_id || (row && noticeIds.get(row.id)) || null;
const NOTICE = 'This notice tells the client\'s primary worker about a change to their client\'s record; only they can mark it seen (a supervisor can delete it)';
// A notice a device raised for an edit made on it (its text as notifyPrimary writes it, for someone else).
const deviceNotice = (row, c) => row.assigned_to !== c.user.id && /^Changed: [^\n]*\n(?:[^\n]*\n)*Reference: client record change notice$/.test(String(row.description_enc || ''));

module.exports = define({
  table: 'tasks',
  deviceColumns: ['referral_id'], createdBy: ['created_by'],
  fields: {
    client_id: { type: 'string' }, assigned_to: { type: 'string' }, title: { type: 'string', required: true, maxLen: 200 }, description: { type: 'string', maxLen: 2000 },
    due_at: { type: 'datetime' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
    is_milestone: { type: 'boolean' }, completed_at: { type: 'datetime' },
  },
  editableBy: (user, row) => (row.assigned_to === user.id || row.created_by === user.id || auth.hasPerm(user, 'records:manage-others') ? null : notPermitted('You cannot edit this record')),
  authorise(row, c) {
    // A change notice is changed (marked seen) only by the worker it was sent to; anyone else may at most delete it.
    if (c.existing) return c.existing.assigned_to !== c.user.id && isNotice(c.existing) ? notPermitted(NOTICE) : null;
    // A notice a device raised for an edit made on it is that device's copy: the office raises its own when the edit
    // lands (clients.js afterApply), linked in its audit trail, so the device's is not taken (it would arrive as the
    // editor's ordinary to-do reading like a notice). Any other to-do with the notice line in it is an ordinary one.
    return c.via === 'sync' && deviceNotice(row, c) ? { reason: null, quiet: true } : null;
  },
  // Finishing someone's work closes theirs: a discharge on a device cancels the client's open to-dos, when the
  // discharge landed in the same push and its maker is on the care team (or a manager), as over REST
  // (routes/episodes.js /close). Never otherwise (security review of 1.16.3, N3), never a to-do with no client, and
  // never a change notice, which is not work but the primary worker's to read (security review of 1.16.2, M1).
  othersMayChange(existing, row, changed, c) {
    if (!['done', 'cancelled'].includes(row.status) || !changed.every(col => col === 'status' || col === 'completed_at') || !existing.client_id || isNotice(existing)) return false;
    const st = c && c.session && c.session.state.assignments; const k = st && st.episodes.get(existing.client_id);
    return !!k && k.closed.size > 0 && st.standing(existing.client_id);
  },
});
Object.assign(module.exports, { NOTICE_MARKER, isNotice, noticeEntry, noticeBy, noticeIds });
