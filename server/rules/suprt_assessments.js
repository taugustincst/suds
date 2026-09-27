'use strict';
// The rules for SUPRT-A assessments (server/suprt.js, docs/compliance/SUPRT.md), for POST /api/clients/:id/suprt,
// PUT /api/suprt/:id and sync push: clients:write, the SUPRT module switched on, answers the instrument asks at
// that assessment point, a completed one with every required answer and in the order of a cycle, and one already
// put in a SPARS entry file never deleted. The record-management answers (the client code, the grant and site
// IDs, the type and date) are the office's, whatever the form or the device sent.
const { define, refuse, flag } = require('./core');

const S = () => require('../suprt');
const answersOf = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || '{}') || {}; } catch { return null; } };
const fieldFlag = (reason, field, message, code) => flag(reason, { message: 'Validation failed', fields: { [field]: message }, code });

module.exports = define({
  table: 'suprt_assessments',
  module: 'suprt',
  fields: {
    assessment_type: { type: 'string', enum: require('../suprt').TYPES, required: true },
    assessment_date: { type: 'date', required: true },
    status: { type: 'string', enum: ['draft', 'complete'] },
    answers: { type: 'object', fromColumn: JSON.parse },
  },
  // Deleting one already in a SPARS entry file would leave the accounting of disclosures pointing at nothing.
  deletableBy: (user, row) => (row.exported_at ? refuse('not permitted: it was put in a SPARS entry file; correct it instead', { status: 409, message: 'This assessment was put in a SPARS entry file and cannot be deleted; correct it instead.' }) : null),
  check(row, c) {
    const e = c.existing || {};
    const type = c.existing ? e.assessment_type : row.assessment_type;
    const date = row.assessment_date !== undefined ? row.assessment_date : e.assessment_date;
    const status = row.status || e.status || 'draft';
    const clientId = c.existing ? e.client_id : row.client_id;
    const out = [];
    // Flagged on push: a phone whose date runs ahead of the office's has still recorded an assessment.
    if (date && date > S().today() && (!c.existing || date !== e.assessment_date)) out.push(fieldFlag('was accepted, but it is dated in the future; the office will review it', 'assessment_date', 'cannot be in the future', 'future_date'));
    const answers = answersOf(c.plain('answers_enc'));
    if (answers === null) return [...out, refuse('has a value the office does not accept (its answers cannot be read)')];
    const clean = S().cleanAnswers(type, answers);
    if (Object.keys(clean.errors).length) {
      out.push(refuse(`has a value the office does not accept (answers: ${Object.keys(clean.errors).slice(0, 5).join(', ')})`, { message: 'Validation failed', fields: Object.fromEntries(Object.entries(clean.errors).map(([k, m]) => [`answers.${k}`, m])) }));
      return out;
    }
    if (status === 'complete') {
      // The record-management answers the office fills in count as answered (routes/suprt.js recordManagement).
      const missing = S().cleanAnswers(type, { ...clean.answers, ...require('../routes/suprt').recordManagement({ client_code: 'x' }, type, date) }).missing;
      if (missing.length) {
        out.push(flag(`was accepted as complete, but it is missing required answers (${missing.length}); the office will review it`, { code: 'suprt_incomplete',
          message: `Answer ${missing.map(k => S().ITEM[k].label).join('; ')} before marking it complete, or save it as a draft.`, fields: Object.fromEntries(missing.map(k => [`answers.${k}`, 'is required'])) }));
        return out;
      }
      // The order of a cycle depends on what else is on file at the office: flagged on push (another device may
      // have recorded the baseline), refused over REST.
      try { require('../routes/suprt').checkOrder(clientId, type, date, c.existing ? e.id : (c.via === 'sync' ? row.id : null)); }
      catch (err) { out.push(flag('was accepted, but it does not follow the client\'s SUPRT-A cycle at the office; the office will review it', { message: err.message, fields: err.extra && err.extra.fields, code: 'suprt_order' })); }
    }
    return out;
  },
  normalise(row, c) {
    const e = c.existing;
    if (e) row.assessment_type = e.assessment_type; // an assessment point is what it was recorded as
    row.exported_at = e ? e.exported_at : null; // a SPARS export is the office's act
    row.updated_by = c.user.id;
    // The record-management answers are the record's own, as the REST routes make them.
    const R = require('../routes/suprt');
    const clientRow = require('../db').one(`SELECT * FROM clients WHERE id=?`, e ? e.client_id : row.client_id);
    if (clientRow) {
      const date = row.assessment_date !== undefined ? row.assessment_date : e.assessment_date;
      const clean = S().cleanAnswers(row.assessment_type, answersOf(c.plain('answers_enc')) || {}).answers;
      const answers = { ...clean, ...R.recordManagement(clientRow, row.assessment_type, date) };
      row.answers_enc = JSON.stringify(answers);
      row.derived_keys = R.derivedKeys(clientRow.id, row.assessment_type, date, answers, row.id);
    }
    return null;
  },
});
