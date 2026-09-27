'use strict';
// The rules for funds (grants, settlement money), for /api/budget/funds and sync push: budget:manage, and a
// period that ends before it starts is a typo every date check downstream would trip over.
const C = require('../constants');
const { define, refuse } = require('./core');

module.exports = define({
  table: 'funding_sources',
  fields: {
    name: { type: 'string', required: true, maxLen: 200 }, source_type: { type: 'string', enum: C.FUNDING_TYPES }, grant_number: { type: 'string', maxLen: 100 },
    fiscal_year_start: { type: 'date', required: true }, fiscal_year_end: { type: 'date', required: true }, total_amount: { type: 'number', required: true, min: 0 },
    restrictions: { type: 'string', maxLen: 2000 }, notes: { type: 'string', maxLen: 2000 }, is_active: { type: 'boolean' },
    // Opioid settlement categories (constants.SETTLEMENT_USES / SETTLEMENT_HIAA); blank for any other fund.
    ...require('./expenditures').SETTLEMENT,
  },
  check(row, c) {
    const e = c.existing || {};
    const start = row.fiscal_year_start ?? e.fiscal_year_start; const end = row.fiscal_year_end ?? e.fiscal_year_end;
    if (start && end && end < start) return refuse('has a value the office does not accept (its period ends before it starts)', { message: `The period ends (${end}) before it starts (${start})` });
    return null;
  },
});
