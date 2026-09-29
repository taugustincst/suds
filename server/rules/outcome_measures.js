'use strict';
// The rules for outcome measures (PHQ-9, GAD-7, ...): an optional instrument the office has not enabled takes
// no new results or edits, and a score is always recomputed from the answers as POST /api/clients/:id/outcomes
// computes it; a device's total, band or safety flag is never taken on trust.
const db = require('../db');
const { define, refuse } = require('./core');
const { ownedBy } = require('./shared');

/** Is this instrument enabled at the office? Optional ones (clinical.js OPTIONAL_INSTRUMENTS) need their setting. */
function instrumentEnabledHere(code) {
  const opt = (require('../clinical').OPTIONAL_INSTRUMENTS || {})[code];
  return !opt || !opt.setting || db.getSetting(opt.setting, '0') === '1';
}
function instrumentName(code) { return (require('../clinical').INSTRUMENTS[code] || {}).name || String(code); }

module.exports = define({
  table: 'outcome_measures',
  createdBy: ['administered_by'],
  module: 'assessments',
  fields: {
    instrument: { type: 'string', required: true, enum: require('../clinical').INSTRUMENT_CODES },
    administered_at: { type: 'date', required: true },
    responses: { type: 'array', required: true, maxLen: 20, fromColumn: JSON.parse },
    variant: { type: 'string', enum: ['men', 'women', 'unspecified'] },
    notes: { type: 'string', maxLen: 2000 },
  },
  editableBy: ownedBy(['administered_by'], 'records:manage-others', 'Only the person who gave this questionnaire, or a supervisor, can change it'),
  deletableBy: ownedBy(['administered_by'], 'records:manage-others', 'Only the person who gave this questionnaire, or a supervisor, can delete it'),
  check(row, c) {
    const code = row.instrument || (c.existing && c.existing.instrument);
    // A result already on file stays, and an unchanged copy of it is not refused.
    if (!instrumentEnabledHere(code) && (!c.existing || c.changed().length)) {
      return refuse(`has a value the office does not accept (${instrumentName(code)} is not enabled on the office server; an administrator can turn it on under Settings → Screening instruments)`,
        { message: 'Validation failed', fields: { instrument: `${instrumentName(code)} is not enabled for this program. An administrator can turn it on under Settings → Screening instruments, after confirming the program holds the rights to use it.` } });
    }
    return null;
  },
  normalise(row, c) {
    // The instrument is what the answers were given to: a correction rescores them, it never changes the test.
    if (c.existing) row.instrument = c.existing.instrument;
    try {
      const sc = require('../clinical').score(row.instrument, JSON.parse(row.responses_enc), { variant: row.variant });
      row.total_score = sc.total; row.band = sc.band; row.positive = sc.positive; row.safety_flag = sc.safety_flag; row.variant = sc.variant;
    } catch { return refuse('has a value the office does not accept (the answers do not score)'); }
    return null;
  },
});
module.exports.instrumentEnabledHere = instrumentEnabledHere;
