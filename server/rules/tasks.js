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

/** Does this edit put the sign reminder's line into details that did not have it? (REST sends `description`, a device
 *  `description_enc` as written; the stored row holds ciphertext.) */
function addsSignReminder(row, existing) {
  const next = row.description !== undefined ? row.description : row.description_enc;
  if (next === undefined || next === null) return false;
  const { SIGN_REMINDER } = require('./notes');
  if (!String(next).includes(SIGN_REMINDER)) return false;
  let before = ''; try { before = existing.description_enc ? require('../crypto').decrypt(existing.description_enc) : ''; } catch { before = ''; }
  return !before.includes(SIGN_REMINDER);
}

module.exports = define({
  table: 'tasks',
  // The record whose follow-up this to-do is (server/rules/follow-ups.js): a device's to-do carries its call's or
  // visit's id as the office's does, so the office finds it rather than making a second one.
  deviceColumns: ['referral_id', 'call_id', 'intervention_id'], createdBy: ['created_by'],
  fields: {
    client_id: { type: 'string' }, assigned_to: { type: 'string' }, title: { type: 'string', required: true, maxLen: 200 }, description: { type: 'string', maxLen: 2000 },
    due_at: { type: 'datetime' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
    is_milestone: { type: 'boolean' }, completed_at: { type: 'datetime' },
  },
  editableBy: (user, row) => (row.assigned_to === user.id || row.created_by === user.id || auth.hasPerm(user, 'records:manage-others') ? null : notPermitted('You cannot edit this record')),
  authorise(row, c) {
    // A change notice is changed (marked seen) only by the worker it was sent to; anyone else may at most delete it.
    if (c.existing && c.existing.assigned_to !== c.user.id && isNotice(c.existing)) return notPermitted(NOTICE);
    // A supervisor's "finish and sign" reminder is recognised by its last line (rules/notes.js SIGN_REMINDER); only the
    // to-do's maker may write that line into one, so a worker cannot turn a to-do someone gave them into a reminder that
    // keeps Remind away and closes when they sign (review of 1.23.2).
    if (c.existing && c.existing.created_by !== c.user.id && addsSignReminder(row, c.existing)) return notPermitted('Only whoever made this to-do can make it a reminder to sign notes');
    if (c.existing) return null;
    // A notice a device raised for an edit made on it is that device's copy: the office raises its own when the edit
    // lands (clients.js afterApply), linked in its audit trail, so the device's is not taken (it would arrive as the
    // editor's ordinary to-do reading like a notice). Any other to-do with the notice line in it is an ordinary one.
    return c.via === 'sync' && deviceNotice(row, c) ? { reason: null, quiet: true } : null;
  },
  // Finishing someone's work closes theirs: a discharge on a device cancels the client's open to-dos, when the
  // discharge landed in the same push and its maker is on the care team (or a manager), as over REST
  // (routes/episodes.js /close). Never otherwise (security review of 1.16.3, N3), never a to-do with no client, and
  // never a change notice, which is not work but the primary worker's to read (security review of 1.16.2, M1).
  // A link to a call or visit the office does not have (refused in this push, or deleted) is dropped, not the to-do;
  // so is a link to someone else's: a follow-up to-do belongs to the worker who made the call or visit, and a device's
  // to-do linked to a colleague's record would stop the office making that colleague's (review of 1.23).
  // The same for a referral (1.23.1): a to-do a device links to a referral, or re-links to another, keeps the link only
  // when the referral is the to-do's worker's own, so a crafted link cannot hold back a colleague's follow-up or pass
  // for a supervisor's reminder about their referral. A link the office made (a secure referral link's to-do, which is
  // its maker's) is kept as it is when the device sends it back unchanged.
  beforeStore(row, c) {
    for (const [col, table] of [['call_id', 'calls'], ['intervention_id', 'interventions']]) {
      if (!row[col]) continue;
      const rec = require('../db').one(`SELECT user_id FROM ${table} WHERE id=?`, row[col]);
      if (!rec || rec.user_id !== row.assigned_to) row[col] = null;
    }
    const e = c && c.existing;
    if (row.referral_id && (!e || e.referral_id !== row.referral_id)) {
      const rec = require('../db').one(`SELECT user_id FROM referrals WHERE id=?`, row.referral_id);
      const assignee = row.assigned_to !== undefined ? row.assigned_to : e && e.assigned_to;
      if (!rec || rec.user_id !== assignee) row.referral_id = null;
    }
  },
  othersMayChange(existing, row, changed, c) {
    if (!['done', 'cancelled'].includes(row.status) || !changed.every(col => col === 'status' || col === 'completed_at') || !existing.client_id || isNotice(existing)) return false;
    const st = c && c.session && c.session.state.assignments; const k = st && st.episodes.get(existing.client_id);
    return !!k && k.closed.size > 0 && st.standing(existing.client_id);
  },
});
/**
 * The revisions a change notice reports (1.17.0, server/client-revisions.js), oldest first: each edit that raised or
 * added to it names its revision in its audit entry. Empty on a device, whose audit trail is its own, and for a
 * notice raised before revisions were kept.
 */
function noticeRevisions(row) {
  if (!noticeEntry(row)) return [];
  return require('../db').all(`SELECT details FROM audit_log WHERE client_id=? AND action='client.change_notice' AND details LIKE ? ORDER BY id`, row.client_id, `%"task":"${String(row.id).replace(/[%_"\\]/g, '')}"%`)
    .map(a => { try { return JSON.parse(a.details); } catch { return {}; } }).filter(d => d.task === row.id && d.notified === row.assigned_to && d.revision).map(d => d.revision);
}
Object.assign(module.exports, { NOTICE_MARKER, isNotice, noticeEntry, noticeBy, noticeIds, noticeRevisions });
