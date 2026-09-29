'use strict';
// The rules for the record that a client was given the 42 CFR §2.22 notice, for POST
// /api/clients/:id/part2-notices and sync push. It records a fact and is not edited afterwards (there is no REST
// route that changes one); a notice cannot have been given in the future, and a client either signed the
// acknowledgement or declined to, not both.
const C = require('../constants');
const { define, refuse, flag } = require('./core');

module.exports = define({
  table: 'part2_notices',
  deviceColumns: ['notice_version'], createdBy: ['given_by'],
  fields: { given_at: { type: 'date', required: true }, method: { type: 'string', required: true, enum: C.PART2_NOTICE_METHODS }, acknowledged: { type: 'boolean' }, ack_refused: { type: 'boolean' }, notes: { type: 'string', maxLen: 2000 } },
  immutable: true,
  tombstone: 'never', // the record that the §2.22 notice was given is kept
  check(row, c) {
    if (c.existing) return null;
    const out = [];
    if (row.acknowledged && row.ack_refused) out.push(refuse('has a value the office does not accept (it is both acknowledged and refused)', { message: 'Either the client signed the acknowledgement or declined to; not both' }));
    // Flagged on push: a phone whose date runs ahead of the office's has still recorded a notice that was given.
    if (row.given_at && row.given_at > new Date().toISOString().slice(0, 10)) out.push(flag('was accepted, but it is dated in the future; the office will review it', { message: 'The notice cannot have been given in the future', code: 'future_date' }));
    return out;
  },
});
