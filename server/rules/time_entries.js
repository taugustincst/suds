'use strict';
// The rules for time entries, for /api/time (crud.js) and sync push. Time is personal: whose hours these are is
// time:all to change, and only the worker or a manager edits them. Hours charged to a grant fall in its
// period. Approving them is time:approve, done at the office (POST /api/time/:id/approve, never your own), so a
// device can submit time but never approve, reject or rewrite a ruling, whoever holds it (security review of
// 1.15.3, H1: a navigator's device pushed its own time as approved, a supervisor's approved the supervisor's own).
// Approved time is part of a signed-off time sheet (QA 1.15.3): nobody edits or deletes it, the worker and a
// manager alike, at either door. A supervisor returns it first (POST /api/time/:id/approve, decision
// "rejected", with a reason: routes/supervision.js), and the worker corrects and resubmits it. Submitted time
// stays its worker's to correct until it is ruled on.
const db = require('../db');
const { decrypt } = require('../crypto');
const { define, refuse, flag } = require('./core');
const { periodProblem, ownedBy, officeRuling } = require('./shared');

// ---- possible duplicates (1.24.0) ----
// The same work logged twice is the same staff on the same day with either (a) time ranges that overlap (start_time
// plus minutes; only entries that both say when they started can overlap) or (b) the same minutes and the same
// description (compared decrypted, ignoring case and spacing; a blank description matches nothing, or every pair of
// untitled half-hours would be "the same"). There is no blind index of the description: a worker's entries for one
// day are a handful, decrypted here and never written anywhere. The REST door (routes/time.js) asks the person
// (Merge / Save anyway / Cancel); a device's push cannot answer, so it lands and is marked for review (beforeStore).
const START = /^([01]\d|2[0-3]):[0-5]\d$/;
const DUP_COLS = ['user_id', 'work_date', 'start_time', 'minutes', 'description_enc'];
const toMin = (t) => (t && START.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const sameNote = (a, b) => { const n = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase(); return !!n(a) && n(a) === n(b); };
/** [start, end) in minutes from midnight, or null when the entry does not say when it started. */
function rangeOf(e) { const s = toMin(e.start_time); return s === null ? null : [s, s + (Number(e.minutes) || 0)]; }
/**
 * The stored entries `e` may duplicate, with why: e is { id?, user_id, work_date, start_time, minutes, description }
 * (description in plain text). `exclude`: ids never to count (the entry itself, the one being merged away).
 * Returns [{ row (stored, encrypted), reasons: ['overlap' | 'same_note'] }], oldest first.
 */
function duplicatesOf(e, { exclude = [] } = {}) {
  if (!e || !e.user_id || !e.work_date) return [];
  const skip = new Set([e.id, ...exclude].filter(Boolean));
  const mine = rangeOf(e);
  const out = [];
  for (const row of db.all(`SELECT * FROM time_entries WHERE user_id=? AND work_date=? ORDER BY created_at, id`, e.user_id, e.work_date)) {
    if (skip.has(row.id)) continue;
    const reasons = [];
    const theirs = rangeOf(row);
    if (mine && theirs && mine[0] < theirs[1] && theirs[0] < mine[1]) reasons.push('overlap');
    if (Number(row.minutes) === Number(e.minutes) && e.description && row.description_enc) {
      let note = null; try { note = decrypt(row.description_enc); } catch { note = null; }
      if (sameNote(note, e.description)) reasons.push('same_note');
    }
    if (reasons.length) out.push({ row, reasons });
  }
  return out;
}
/** Entries marked as possible duplicates of `id` (going now): pointed at `to` instead (a merge), or cleared. */
function clearMarksTo(id, to = null) {
  db.run(`UPDATE time_entries SET duplicate_of=?, updated_at=? WHERE duplicate_of=? AND id<>?`, to, db.now(), id, to || '');
}
/** Does this write change what the duplicate check looks at? (Always, for a new entry.) */
const touchesDuplicateCheck = (c) => !c.existing || c.changed().some(k => DUP_COLS.includes(k));

const RULING = ['status', 'approved_by', 'approved_at', 'approval_note_enc'];

const APPROVED = 'This time entry has been approved and is part of a signed-off time sheet, so it cannot be changed or deleted. Ask a supervisor to reopen it (return it for correction) first.';
const owned = ownedBy(['user_id'], 'time:all');

module.exports = define({
  table: 'time_entries',
  deviceColumns: ['status', 'submitted_at', 'approved_by', 'approved_at', 'approval_note_enc'],
  fields: {
    client_id: { type: 'string' }, user_id: { type: 'string' }, work_date: { type: 'date', required: true }, minutes: { type: 'number', required: true, integer: true, min: 1, max: 1440 },
    category: { type: 'string', list: 'TIME_CATEGORIES' }, billable: { type: 'boolean' }, funding_source_id: { type: 'string' }, description: { type: 'string', maxLen: 500 },
    intervention_id: { type: 'string' }, call_id: { type: 'string' },
    // When it started (HH:MM, optional; 1.24.0): with minutes, the range the duplicate check compares.
    start_time: { type: 'string', pattern: START },
  },
  owner: { col: 'user_id', all: 'time:all' },
  // 'not permitted …' is one of sync-tables.js's permanent reasons: the device stops resending the edit.
  editableBy: (user, row) => (row.status === 'approved' ? refuse('not permitted (the time entry is approved; a supervisor must reopen it)', { status: 409, message: APPROVED }) : owned(user, row)),
  // A push that only asks for a ruling reaches normalise, which keeps the office's and flags the ask (rather
  // than a bare "not permitted" on an approved entry the device thought it could approve).
  othersMayChange: (existing, row, changed) => changed.length > 0 && changed.every(col => RULING.includes(col)),
  check(row, c) {
    const e = c.existing || {};
    if (c.existing && !['work_date', 'funding_source_id'].some(k => row[k] !== undefined && String(row[k] ?? '') !== String(e[k] ?? ''))) return null;
    const fundId = row.funding_source_id !== undefined ? row.funding_source_id : e.funding_source_id;
    const fund = fundId ? db.one(`SELECT * FROM funding_sources WHERE id=?`, fundId) : null;
    return periodProblem(fund, row.work_date !== undefined ? row.work_date : e.work_date, 'Work date');
  },
  // Only the office rules on time (shared.js officeRuling): a device may submit its own (draft -> submitted) and
  // resubmit time it was shown returned (rejected -> submitted, from the returned copy); anything else it says
  // about the status, approver, date or note is the office's, and a ruling it asks for is flagged.
  normalise: (row, c) => officeRuling(row, c, {
    what: 'time', rulings: ['approved', 'rejected'], cols: ['approved_by', 'approved_at'], enc: ['approval_note_enc'],
    initial: (s) => (s === 'submitted' ? 'submitted' : 'draft'),
    mayMove: (from, to, row, e) => to === 'submitted' && (from === 'draft' || (from === 'rejected' && String(row.approved_at ?? '') === String(e.approved_at ?? ''))),
  }),
  // A device's entry that may duplicate another of the same worker's that day lands (the device cannot answer the
  // question a form asks, and refusing it would lose work done offline) and is marked for review: duplicate_of names
  // the earliest such entry, shown as "Possible duplicate" on the time list and the approval queue, where it is
  // merged (POST /api/time/:id/merge) or dismissed (POST /api/time/:id/not-duplicate). The device is told (a flag),
  // and the audit trail records it as sync.conflict, flagged 'duplicate', naming no description. An edit that no
  // longer matches anything clears the mark. duplicate_of is the office's: a device never writes it (not declared).
  beforeStore(row, c) {
    if (!touchesDuplicateCheck(c)) return;
    const e = { id: row.id, user_id: c.plain('user_id'), work_date: c.plain('work_date'), start_time: c.plain('start_time'), minutes: c.plain('minutes'), description: c.plain('description_enc') };
    // Never the entry pointing back at this one: a pair is one review, not two.
    const found = duplicatesOf(e).filter(d => d.row.duplicate_of !== row.id);
    row.duplicate_of = found.length ? found[0].row.id : null;
    if (found.length) c.flags.push(flag('was accepted, but it may duplicate another time entry for the same worker and day; a supervisor will review it', { code: 'duplicate' }));
  },
  afterApply: (row, o, c) => require('./shared').logRecordedFor('time_entries', row, c), // separation of duties
  // A device's deletion: the entry is no longer anyone's possible duplicate.
  beforeDelete: (stored) => { clearMarksTo(stored.id); },
});
module.exports.duplicatesOf = duplicatesOf;
module.exports.touchesDuplicateCheck = touchesDuplicateCheck;
module.exports.rangeOf = rangeOf;
module.exports.sameNote = sameNote;
module.exports.clearMarksTo = clearMarksTo;
