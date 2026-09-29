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
const { define, refuse } = require('./core');
const { periodProblem, ownedBy, officeRuling } = require('./shared');

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
  afterApply: (row, o, c) => require('./shared').logRecordedFor('time_entries', row, c), // separation of duties
});
