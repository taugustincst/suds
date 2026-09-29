'use strict';
// The rules for CalOMS Tx records (admission, discharge, annual update), for /api/episodes/:id/caloms,
// /api/caloms/records/:id and sync push: episodes:write, the CalOMS module switched on, and a discharge record
// only for a discharged episode (it is dated by the discharge).
const db = require('../db');
const { define, flag } = require('./core');

module.exports = define({
  table: 'caloms_records',
  module: 'caloms',
  fields: {
    record_type: { type: 'string', required: true, enum: require('../caloms-spec').RECORD_TYPES }, provider_id: { type: 'string', maxLen: 20 },
    record_date: { type: 'date' }, answers: { type: 'object', required: true, fromColumn: JSON.parse },
  },
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
