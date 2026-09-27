'use strict';
// The rules for calls and text messages, for /api/calls (crud.js) and sync push. A call's outcomes and a text's
// outcomes are different lists (Settings → Lists); picking one from the wrong list quietly breaks the reports
// that count who was actually reached.
const C = require('../constants');
const O = require('../options');
const { define, flag } = require('./core');
const { ownedBy } = require('./shared');

module.exports = define({
  table: 'calls',
  fields: {
    client_id: { type: 'string' }, user_id: { type: 'string' }, direction: { type: 'string', required: true, enum: ['inbound', 'outbound'] },
    method: { type: 'string', enum: C.CONTACT_METHODS },
    started_at: { type: 'datetime', required: true }, duration_minutes: { type: 'number', integer: true, min: 0, max: 1440 },
    contact_type: { type: 'string', list: 'CALL_CONTACT_TYPES' }, contact_name: { type: 'string', maxLen: 120 }, phone: { type: 'string', maxLen: 40 },
    purpose: { type: 'string', maxLen: 300 }, outcome: { type: 'string', maxLen: 60 }, crisis: { type: 'boolean' },
    follow_up_needed: { type: 'boolean' }, follow_up_due: { type: 'date' }, summary: { type: 'string', maxLen: 4000 },
    log_time: { type: 'boolean', sync: false },
  },
  owner: { col: 'user_id', all: 'clients:all' },
  editableBy: ownedBy(['user_id'], 'clients:all'),
  check(row, c) {
    const e = c.existing;
    if (row.outcome === undefined || row.outcome === null) return null;
    const method = row.method || (e && e.method) || 'phone';
    if (e && row.outcome === e.outcome && method === (e.method || 'phone')) return null;
    // Editing an old record keeps the outcome it has even if that choice has since been retired.
    const list = method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES';
    const kept = e && (e.method || 'phone') === method ? e.outcome : undefined;
    if (O.accepts(list, row.outcome, kept)) return null;
    const what = method === 'text' ? 'text message' : 'phone call';
    return flag(`was accepted, but its outcome is not one the office offers for a ${what}; the office will review it`, { message: `"${row.outcome}" is not an outcome for a ${what}. Choose one of: ${O.visible(list).join(', ')}`, fields: { outcome: 'not an outcome for this kind of contact' }, code: 'list' });
  },
});
