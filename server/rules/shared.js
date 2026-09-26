'use strict';
// Checks more than one table's rules make.
const auth = require('../auth');
const { flag, notPermitted } = require('./core');

/**
 * A date charged to a fund must fall in its period and not in the future (routes/budget.js assertInPeriod).
 * Flagged on push: the device checked the same thing against the fund as it had it, and a period changed at the
 * office (or a phone clock a day ahead) is no reason to throw away hours or spending recorded in the field.
 */
function periodProblem(fund, date, what) {
  try { require('../routes/budget').assertInPeriod(fund, date, what); return null; }
  catch (err) { return flag(`was accepted, but its ${what.toLowerCase()} is outside the period of the fund it is charged to, or in the future; the office will review it`, { message: err.message, code: 'fund_period' }); }
}

/** An editableBy for a record that is its owner's (any of `cols`) unless the user holds `all`. */
const ownedBy = (cols, all, message = 'You cannot edit this record') => (user, row) => (cols.some(c => row[c] === user.id) || auth.hasPerm(user, all) ? null : notPermitted(message));

module.exports = { periodProblem, ownedBy };
