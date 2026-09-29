'use strict';
// The rules for a visit's supply lines (docs/SUPPLIES.md): the items one visit handed out. A line belongs to its
// visit: it travels with it, is checked like it (server/supplies.js linePushProblem: the visit on the office and
// one this person may write to, a real item and quantity), takes the visit's client and worker whatever the
// device sent, and never moves to another visit. Over REST lines are written only by the visit routes
// (routes/interventions.js planSupplies), so the visit's rules are theirs. The stock they draw is the office's to
// work out once the whole push has landed (server/rules/interventions.js finish). Its worker (user_id) is never a
// device's to say: it is dropped from what a push may write and set from the visit (security review of 1.16.1, L1).
const { define, refuse } = require('./core');

module.exports = define({
  table: 'intervention_supplies',
  deviceColumns: ['item_id', 'quantity', 'untracked'],
  owner: null,
  authorise(row, c) {
    const problem = require('../supplies').linePushProblem(c.user, row, c.existing);
    return problem ? refuse(problem) : null;
  },
  // Removing a line changes the visit: the visit's rule (its worker, or records:manage-others).
  deletableBy(user, row) {
    const visit = require('../db').one(`SELECT id, client_id, user_id FROM interventions WHERE id=?`, row.intervention_id);
    return visit ? require('./interventions').editableBy(user, visit) : null;
  },
  afterApply(row, o, c) { require('./interventions').touchVisit(c.session, o.intervention_id || (c.existing && c.existing.intervention_id), { linesPushed: true }); },
  // An item removed from a visit puts back what it drew.
  afterDelete(row, s) { require('./interventions').touchVisit(s, row.intervention_id, { linesPushed: true }); },
});
