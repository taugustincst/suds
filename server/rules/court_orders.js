'use strict';
// The rules for subpart E court orders (42 CFR Part 2 §§2.64–2.67), for POST /api/clients/:id/court-orders,
// /api/court-orders/:id/vacate and sync push. An order is recorded as the court made it and is never edited
// afterwards: the one change is vacating it, with a reason. (A device used to be able to rewrite an order's
// court, scope or findings by sync, which no REST route allows.)
const C = require('../constants');
const { define, refuse } = require('./core');

const VACATE = ['status', 'vacated_at', 'vacated_reason_enc'];

module.exports = define({
  table: 'court_orders',
  fields: {
    order_type: { type: 'string', required: true, enum: C.COURT_ORDER_TYPES }, court: { type: 'string', required: true, maxLen: 200 }, case_ref: { type: 'string', maxLen: 120 },
    issued_at: { type: 'date', required: true }, expires_at: { type: 'date' }, recipient: { type: 'string', maxLen: 300 }, purpose: { type: 'string', required: true, maxLen: 500 },
    scope: { type: 'string', required: true, maxLen: 1000 }, findings_recorded: { type: 'boolean' }, notice_requirement_met: { type: 'boolean' }, covers_counseling_notes: { type: 'boolean' },
    document_ref: { type: 'string', maxLen: 300 },
  },
  immutable: true, tombstone: 'never',
  allowChange(existing, row, changed) {
    if (existing.status === 'vacated' || row.status !== 'vacated' || !row.vacated_reason_enc || !changed.every(col => VACATE.includes(col))) return null;
    return VACATE;
  },
  check(row, c) {
    if (c.existing) return null; // vacating is allowChange's; nothing else changes
    const val = (k) => row[k];
    const blank = (k) => { const x = val(k); return x === undefined || x === null || String(x).trim() === ''; };
    const missing = [['court_enc', 'the court'], ['purpose_enc', 'the purpose the order states'], ['scope_enc', 'what the order permits to be disclosed'], ['issued_at', 'when it was issued']].filter(([k]) => blank(k)).map(([, l]) => l);
    if (missing.length) return refuse(`is missing a required field: a court order must record ${missing.join('; ')}`);
    if (!C.COURT_ORDER_TYPES.includes(val('order_type'))) return refuse(`has a value the office does not accept (order type "${String(val('order_type')).slice(0, 40)}")`);
    if (val('expires_at') && val('expires_at') < val('issued_at')) return refuse('has a value the office does not accept (the order expires before it was issued)', { message: 'An order cannot expire before it was issued' });
    return null;
  },
});
