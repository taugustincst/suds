'use strict';
// The rules for the problem list (CalAIM), for /api/clients/:id/problems, /api/problems/:id and sync push:
// careplan:write, the care plan module switched on, and codes that are ICD-10-CM codes (Z55–Z65 for the social
// determinants).
const CL = require('../clinical');
const { define, refuse } = require('./core');

const fieldError = (field, message, reason) => refuse(`has a value the office does not accept (${reason})`, { message: 'Validation failed', fields: { [field]: message } });

module.exports = define({
  table: 'problems',
  module: 'careplan',
  tombstone: 'never', // a problem is resolved or made inactive, never deleted (its history is kept with it)
  fields: {
    problem: { type: 'string', required: true, maxLen: 500 }, icd10_code: { type: 'string', maxLen: 12 }, icd10_description: { type: 'string', maxLen: 300 },
    z_codes: { type: 'array', maxLen: 12, fromColumn: (v) => String(v).split(',').filter(Boolean) },
    status: { type: 'string', enum: CL.PROBLEM_STATUSES }, onset_date: { type: 'date' }, resolved_date: { type: 'date' }, source: { type: 'string', enum: CL.PROBLEM_SOURCES },
  },
  check(row, c) {
    const code = row.icd10_code_enc;
    if (code !== undefined && code !== null && code !== '' && String(code) !== String(c.was('icd10_code_enc') ?? '') && !CL.normalizeIcd10(code)) {
      return fieldError('icd10_code', 'is not an ICD-10-CM code (a letter, two characters, then optionally a dot and up to four more, e.g. F11.20)', 'its ICD-10 code');
    }
    const z = row.z_codes_enc;
    if (z !== undefined && z !== null && z !== '' && String(z) !== String(c.was('z_codes_enc') ?? '')) {
      for (const raw of Array.isArray(z) ? z : String(z).split(',').filter(Boolean)) {
        const n = CL.normalizeIcd10(typeof raw === 'string' ? raw : '');
        if (!n || !CL.isZCode(n)) return fieldError('z_codes', `${String(raw).slice(0, 12)} is not a social determinant code (Z55–Z65)`, 'a social determinant code');
      }
    }
    return null;
  },
});
