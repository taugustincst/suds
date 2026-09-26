'use strict';
// The rules for ASAM assessments, for /api/clients/:id/asam, /api/asam/:id and sync push: assessments:write, the
// assessments module switched on, a documented reason when the level referred to differs from the level
// recommended (DHCS expects it), and changed or deleted only by the assessor or a supervisor.
const C = require('../constants');
const CL = require('../clinical');
const { define, refuse } = require('./core');
const { ownedBy } = require('./shared');

const rating = { type: 'number', integer: true, min: 0, max: 4 };

module.exports = define({
  table: 'asam_assessments',
  module: 'assessments',
  fields: {
    assessed_at: { type: 'date', required: true },
    d1_rating: { ...rating, required: true }, d2_rating: { ...rating, required: true }, d3_rating: { ...rating, required: true },
    d4_rating: { ...rating, required: true }, d5_rating: { ...rating, required: true }, d6_rating: { ...rating, required: true },
    dimension_notes: { type: 'object', fromColumn: JSON.parse },
    recommended_loc: { type: 'string', enum: C.ASAM }, actual_loc: { type: 'string', enum: C.ASAM },
    discrepancy_reason: { type: 'string', enum: CL.ASAM_DISCREPANCY_REASONS }, discrepancy_notes: { type: 'string', maxLen: 2000 },
    summary: { type: 'string', maxLen: 5000 },
    update_client_level: { type: 'boolean', sync: false },
  },
  editableBy: ownedBy(['assessed_by'], 'clients:all', 'Only the person who completed this assessment, or a supervisor, can change it'),
  deletableBy: ownedBy(['assessed_by'], 'clients:all', 'Only the person who completed this assessment, or a supervisor, can delete it'),
  check(row, c) {
    const val = (k) => (row[k] !== undefined ? row[k] : c.existing ? c.existing[k] : undefined);
    const rec = val('recommended_loc'); const act = val('actual_loc');
    if (rec && act && rec !== act && rec !== 'unknown' && act !== 'unknown' && !val('discrepancy_reason')) {
      return refuse('is missing a required field (the reason the level referred to differs from the level recommended)', { message: 'Validation failed', fields: { discrepancy_reason: 'is required when the level referred to differs from the level recommended' } });
    }
    return null;
  },
});
