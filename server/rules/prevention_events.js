'use strict';
// The rules for group and community prevention events (1.17.0, server/prevention.js), for /api/prevention-events
// (crud.js) and sync push. An event is recorded by whoever records visits (interventions:write); it is its worker's,
// or a manager's (records:manage-others), to change or delete; a device may not name another worker unless its
// user could. Attendance is a headcount: there is no field for a name.
const db = require('../db');
const C = require('../constants');
const { define, refuse } = require('./core');
const { ownedBy } = require('./shared');

module.exports = define({
  table: 'prevention_events',
  fields: {
    user_id: { type: 'string' },
    event_date: { type: 'date', required: true },
    title: { type: 'string', required: true, maxLen: 200 },
    event_type: { type: 'string', required: true, list: 'PREVENTION_EVENT_TYPES' },
    // National categories (no programme additions, server/options.js): a code off them is refused, not flagged.
    strategy: { type: 'string', required: true, enum: C.PREVENTION_STRATEGIES, list: 'PREVENTION_STRATEGIES' },
    iom_category: { type: 'string', required: true, enum: C.PREVENTION_IOM, list: 'PREVENTION_IOM' },
    audience: { type: 'string', list: 'PREVENTION_AUDIENCES' },
    location: { type: 'string', maxLen: 200 },
    hours: { type: 'number', min: 0, max: 1000 },
    attendance: { type: 'number', integer: true, min: 0, max: 10000000 },
    attendance_estimated: { type: 'boolean' },
    funding_source_id: { type: 'string' },
    // Free text, stored encrypted: what happened, in the worker's words (no names: the form says so).
    notes: { type: 'string', maxLen: 4000 },
  },
  owner: { col: 'user_id', all: 'records:manage-others' },
  editableBy: ownedBy(['user_id'], 'records:manage-others', 'This prevention event is another worker\'s: only they, or a supervisor, can change it'),
  // The table is shared by every device (sync scope 'all'), where a deletion is otherwise a manager's: an event
  // is also its own worker's to delete, from a device as over REST.
  deletableBy: ownedBy(['user_id'], 'records:manage-others', 'This prevention event is another worker\'s: only they, or a supervisor, can delete it'),
  check(row, c) {
    const e = c.existing || {};
    const fund = row.funding_source_id !== undefined ? row.funding_source_id : e.funding_source_id;
    if (row.funding_source_id !== undefined && fund && fund !== e.funding_source_id && !db.one(`SELECT 1 FROM funding_sources WHERE id=?`, fund)) {
      return refuse('refers to a record the office server does not have (the funding source)', { message: 'Validation failed', fields: { funding_source_id: 'is not one of this program\'s funding sources' } });
    }
    return null;
  },
});
