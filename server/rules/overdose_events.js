'use strict';
// The rules for overdose events, for /api/overdose-events (crud.js) and sync push. The person who reported an
// event is on the record as its reporter (a device may not name someone else unless its user could), and the
// event is theirs, or a manager's, to change.
const C = require('../constants');
const { define, flag } = require('./core');
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
  owner: { col: 'reported_by', all: 'records:manage-others' },
  editableBy: ownedBy(['reported_by'], 'records:manage-others'),
  // What happened and the naloxone answers must agree, since each kind is a different count (1.25.2, FL2). A reversal
  // means naloxone was given and a fatal overdose that the person did not survive: the kind decides those, at the
  // office (routes/overdose.js normalise) and now on a push too. An overdose "with no naloxone given" that says
  // naloxone was given is ambiguous: REST refuses it, and a device's offline record lands flagged for the office.
  normalise(row, c) {
    const kind = c.plain('kind');
    if (kind === 'reversal') row.naloxone_used = 1;
    if (kind === 'fatal') row.survived = 0;
    return null;
  },
  check(row, c) {
    if (!c.changed().some(k => ['kind', 'naloxone_used', 'naloxone_doses'].includes(k)) || c.plain('kind') !== 'overdose') return null;
    if (![true, 1, '1'].includes(c.plain('naloxone_used')) && !(Number(c.plain('naloxone_doses')) > 0)) return null;
    const message = `Naloxone was given, so this is "Overdose reversed with naloxone" (or a fatal overdose), not an overdose with no naloxone given. Change what happened, or untick naloxone and clear the doses.`;
    return flag('was accepted, but it says naloxone was given to an overdose recorded as having none; the office will review it', { message, fields: { kind: message }, code: 'overdose_consistency' });
  },
});
