'use strict';
// The rules for expenditures, for /api/budget/expenditures (crud.js) and sync push. Spending is recorded against
// an active fund, inside its period, on a line of that fund; it is its submitter's (or an approver's) to change
// while pending. Approval is budget:approve's, done at the office (POST .../approve and its state machine, which
// refuses your own): a device records spending as pending and never approves, rejects or reimburses it, whoever
// holds it (security review of 1.15.3, H1: an approver's device approved the approver's own spending).
const db = require('../db');
const auth = require('../auth');
const C = require('../constants');
const { define, refuse, flag, notPermitted } = require('./core');
const { periodProblem, officeRuling } = require('./shared');

const SETTLEMENT = { settlement_use: { type: 'string', enum: C.SETTLEMENT_USES.map(x => x.code) }, settlement_hiaa: { type: 'string', enum: [...C.SETTLEMENT_HIAA.map(x => x.code), 'none'] } };
const APPROVAL = ['status', 'approved_by', 'approved_at', 'approval_note_enc'];

module.exports = define({
  table: 'expenditures',
  deviceColumns: ['intervention_id', 'status', 'approved_by', 'approved_at', 'approval_note_enc'],
  // intervention_id is deliberately not writable over REST: it only ever means "auto-posted from that service
  // record" (routes/interventions.js syncExpenditure). Accepting it from a request would let anyone attach a
  // second expenditure to an already-linked intervention, double-counting its cost.
  fields: {
    client_id: { type: 'string' }, user_id: { type: 'string' }, funding_source_id: { type: 'string', required: true }, budget_line_id: { type: 'string' },
    spent_at: { type: 'date', required: true }, amount: { type: 'number', required: true, min: 0.01 }, category: { type: 'string', required: true, enum: C.BUDGET_CATEGORIES },
    vendor: { type: 'string', maxLen: 200 }, description: { type: 'string', maxLen: 1000 }, receipt_ref: { type: 'string', maxLen: 200 },
    // Only when this expenditure's opioid settlement category differs from its fund's.
    ...SETTLEMENT,
  },
  owner: { col: 'user_id', all: 'records:manage-others' },
  editableBy: (user, row) => (row.status === 'pending' && (row.user_id === user.id || auth.hasPerm(user, 'budget:approve')) ? null : notPermitted('You cannot edit this record')),
  // A push that only asks for a ruling (approve, reject, reimburse) reaches normalise, which keeps the office's
  // and flags the ask, whatever the item's status and whoever sent it.
  othersMayChange: (existing, row, changed) => changed.every(col => APPROVAL.includes(col)),
  // Money that has moved keeps its record: only a pending item is deleted, by its submitter or an approver.
  deletableBy: (user, row) => (row.status !== 'pending' ? 'skip' : row.user_id === user.id || auth.hasPerm(user, 'budget:approve') ? null : notPermitted('You cannot delete this record')),
  check(row, c) {
    const e = c.existing || {};
    if (c.existing && !['spent_at', 'funding_source_id', 'budget_line_id'].some(k => row[k] !== undefined && String(row[k] ?? '') !== String(e[k] ?? ''))) return null;
    const fundId = row.funding_source_id !== undefined ? row.funding_source_id : e.funding_source_id;
    const f = db.one(`SELECT * FROM funding_sources WHERE id=? AND is_active=1`, fundId);
    // A fund closed at the office while the phone was out: the spending still happened; the office reviews it.
    if (!f) return flag('was accepted, but the fund it is charged to is closed or unknown at the office; the office will review it', { message: 'Unknown or inactive funding source', code: 'fund_inactive' });
    const lineId = row.budget_line_id !== undefined ? row.budget_line_id : e.budget_line_id;
    // In the REST route's order: the period, then the line (push lets the line's refusal win over the flag).
    return [periodProblem(f, row.spent_at !== undefined ? row.spent_at : e.spent_at, 'Expenditure date'),
      lineId && !db.one(`SELECT 1 FROM budget_lines WHERE id=? AND funding_source_id=?`, lineId, f.id) ? refuse('has a value the office does not accept (its budget line belongs to another fund)', { message: 'Budget line does not belong to fund' }) : null];
  },
  // The status is the office's from the start (pending) to the end (reimbursed): shared.js officeRuling.
  normalise: (row, c) => officeRuling(row, c, { what: 'spending', rulings: ['approved', 'rejected', 'reimbursed'], cols: ['approved_by', 'approved_at'], enc: ['approval_note_enc'], initial: () => 'pending' }),
  afterApply: (row, o, c) => require('./shared').logRecordedFor('expenditures', row, c), // separation of duties
});
module.exports.SETTLEMENT = SETTLEMENT;
