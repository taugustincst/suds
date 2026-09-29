'use strict';
// The rules for CalOMS Tx records (admission, discharge, annual update), for /api/episodes/:id/caloms,
// /api/caloms/records/:id and sync push: episodes:write, the CalOMS module switched on, and a discharge record
// only for a discharged episode (it is dated by the discharge).
const db = require('../db');
const { define, flag, refuse } = require('./core');
const { ownedBy } = require('./shared');

// Deleted by the person who recorded it or records:manage-others; one already sent to DHCS in an extract by
// nobody (security review of 1.16.0, M5): it is corrected instead (PUT /api/caloms/records/:id, and the state copy
// through the county's CalOMS process). Re-admitting a discharge made in error still takes its discharge record
// with it (POST /api/episodes/:id/reopen), which tells the worker to correct the state copy.
const owner = ownedBy(['created_by'], 'records:manage-others', 'Only the person who recorded this CalOMS record, or a supervisor, can delete it');

module.exports = define({
  table: 'caloms_records',
  deviceColumns: ['service_type', 'discharge_status', 'extracted_at'], createdBy: ['created_by'], updatedBy: ['updated_by'],
  module: 'caloms',
  fields: {
    record_type: { type: 'string', required: true, enum: require('../caloms-spec').RECORD_TYPES }, provider_id: { type: 'string', maxLen: 20 },
    record_date: { type: 'date' }, answers: { type: 'object', required: true, fromColumn: JSON.parse },
  },
  deletableBy: (user, row) => (row.extracted_at ? refuse('not permitted: it was sent to DHCS in an extract; correct it instead', { status: 409, message: 'This record was already sent to DHCS in an extract, so it cannot be deleted. Correct it instead, and correct the state copy through the county\'s CalOMS process.' }) : owner(user, row)),
  check(row, c) {
    const type = row.record_type !== undefined ? row.record_type : c.existing && c.existing.record_type;
    if (type !== 'discharge' || (c.existing && c.existing.record_type === 'discharge' && row.episode_id === undefined)) return null;
    const episodeId = row.episode_id || (c.existing && c.existing.episode_id);
    const e = db.one(`SELECT status FROM episodes WHERE id=?`, episodeId);
    if (e && e.status !== 'closed') return flag('was accepted, but it is a discharge record for an episode that is open at the office; the office will review it', { code: 'episode_open', message: 'A CalOMS discharge record is completed when the episode is discharged (Discharge on the Episodes tab)' });
    return null;
  },
  // When it went into a state extract is the office's (POST /api/caloms/extract); a device's copy may be stale.
  normalise: (row, c) => require('./shared').officeMarks(row, c, ['extracted_at'], 'its extract date (when it was sent to DHCS)'),
});
