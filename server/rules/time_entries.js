'use strict';
// The rules for time entries, for /api/time (crud.js) and sync push. Time is personal: whose hours these are is
// time:all to change, and only the worker or a manager edits them. Hours charged to a grant fall in its
// period. Approving them is time:approve, done at the office, so a device can submit time but never approve,
// reject or rewrite a ruling.
// Approved time is part of a signed-off time sheet (QA 1.15.3): nobody edits or deletes it, the worker and a
// manager alike, at either door. A supervisor returns it first (POST /api/time/:id/approve, decision
// "rejected", with a reason: routes/supervision.js), and the worker corrects and resubmits it. Submitted time
// stays its worker's to correct until it is ruled on.
const db = require('../db');
const auth = require('../auth');
const { define, refuse } = require('./core');
const { periodProblem, ownedBy } = require('./shared');

const APPROVED = 'This time entry has been approved and is part of a signed-off time sheet, so it cannot be changed or deleted. Ask a supervisor to reopen it (return it for correction) first.';
const owned = ownedBy(['user_id'], 'time:all');

module.exports = define({
  table: 'time_entries',
  fields: {
    client_id: { type: 'string' }, user_id: { type: 'string' }, work_date: { type: 'date', required: true }, minutes: { type: 'number', required: true, integer: true, min: 1, max: 1440 },
    category: { type: 'string', list: 'TIME_CATEGORIES' }, billable: { type: 'boolean' }, funding_source_id: { type: 'string' }, description: { type: 'string', maxLen: 500 },
    intervention_id: { type: 'string' }, call_id: { type: 'string' },
  },
  owner: { col: 'user_id', all: 'time:all' },
  // 'not permitted …' is one of sync-tables.js's permanent reasons: the device stops resending the edit.
  editableBy: (user, row) => (row.status === 'approved' ? refuse('not permitted (the time entry is approved; a supervisor must reopen it)', { status: 409, message: APPROVED }) : owned(user, row)),
  check(row, c) {
    const e = c.existing || {};
    if (c.existing && !['work_date', 'funding_source_id'].some(k => row[k] !== undefined && String(row[k] ?? '') !== String(e[k] ?? ''))) return null;
    const fundId = row.funding_source_id !== undefined ? row.funding_source_id : e.funding_source_id;
    const fund = fundId ? db.one(`SELECT * FROM funding_sources WHERE id=?`, fundId) : null;
    return periodProblem(fund, row.work_date !== undefined ? row.work_date : e.work_date, 'Work date');
  },
  normalise(row, c) {
    const e = c.existing;
    if (!e) { row.status = row.status === 'submitted' ? 'submitted' : 'draft'; row.approved_by = null; row.approved_at = null; }
    else if (!auth.hasPerm(c.user, 'time:approve')) { row.status = e.status === 'approved' || e.status === 'rejected' ? e.status : row.status; row.approved_by = e.approved_by; row.approved_at = e.approved_at; row.approval_note_enc = undefined; }
    return null;
  },
});
