'use strict';
// The rules for a visit's supply lines (docs/SUPPLIES.md): the items one visit handed out. A line belongs to its
// visit: it travels with it, is checked like it (server/supplies.js linePushProblem: the visit on the office and
// one this person may write to, a real item and quantity), takes the visit's client and worker whatever the
// device sent, and never moves to another visit. Over REST lines are written only by the visit routes
// (routes/interventions.js planSupplies), so the visit's rules are theirs. The stock they draw is the office's to
// work out once the whole push has landed (server/rules/interventions.js finish).
const { define, refuse } = require('./core');

module.exports = define({
  table: 'intervention_supplies',
  owner: null,
  authorise(row, c) {
    const problem = require('../supplies').linePushProblem(c.user, row, c.existing);
    return problem ? refuse(problem) : null;
  },
  afterApply(row, o, c) { require('./interventions').touchVisit(c.session, o.intervention_id || (c.existing && c.existing.intervention_id), { linesPushed: true }); },
  // An item removed from a visit puts back what it drew.
  afterDelete(row, s) { require('./interventions').touchVisit(s, row.intervention_id, { linesPushed: true }); },
});
