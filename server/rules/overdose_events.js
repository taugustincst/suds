'use strict';
// The rules for overdose events, for /api/overdose-events (crud.js) and sync push. The person who reported an
// event is on the record as its reporter (a device may not name someone else unless its user could), and the
// event is theirs, or a manager's, to change.
const C = require('../constants');
const { define } = require('./core');
const { ownedBy } = require('./shared');

const KINDS = C.OVERDOSE_KINDS;

module.exports = define({
  table: 'overdose_events',
  fields: {
    // client_id stays optional: a bystander reversal reported by an outreach worker has no client.
    client_id: { type: 'string' }, occurred_at: { type: 'datetime', required: true },
    // Required: an empty form saved by accident used to become a countable reversal.
    kind: { type: 'string', enum: KINDS, list: 'OVERDOSE_KINDS', required: true }, substances: { type: 'string', maxLen: 200 },
    naloxone_used: { type: 'boolean' }, naloxone_doses: { type: 'number', integer: true, min: 0, max: C.NALOXONE_DOSES_MAX },
    administered_by: { type: 'string', list: 'ADMINISTERED_BY' }, ems_called: { type: 'boolean' },
    hospitalized: { type: 'boolean' }, survived: { type: 'boolean' },
    // A code from the LOCATIONS list; typed-in text is matched to one (routes/overdose.js normalise).
    location_type: { type: 'string', maxLen: 60 }, city: { type: 'string', maxLen: 100 },
    funding_source_id: { type: 'string' }, notes: { type: 'string', maxLen: 4000 },
  },
  owner: { col: 'reported_by', all: 'clients:all' },
  editableBy: ownedBy(['reported_by'], 'clients:all'),
});
