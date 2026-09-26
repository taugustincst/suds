'use strict';
// The rules for forms filled in for a client, for /api/clients/:id/forms, /api/forms/:id and sync push. A
// completed form is changed (or removed) only by a supervisor (forms:manage), and a form is completed only with
// its required fields filled in.
const auth = require('../auth');
const { define, refuse, flag } = require('./core');

const locked = (message) => (user, row) => (row.status === 'completed' && !auth.hasPerm(user, 'forms:manage') ? refuse('not permitted: the form is completed; a supervisor can reopen it', { message }) : null);

module.exports = define({
  table: 'client_forms',
  fields: { status: { type: 'string', enum: ['draft', 'completed', 'void'] }, notes: { type: 'string', maxLen: 2000 } },
  editableBy: locked('This form is completed. Ask a supervisor to reopen it.'),
  deletableBy: locked('Completed forms can only be removed by a supervisor'),
  check(row, c) {
    if (row.status !== 'completed' || (c.existing && c.existing.status === 'completed')) return null;
    let fields = []; let values = {};
    try { fields = JSON.parse(row.fields_json !== undefined ? row.fields_json : (c.existing && c.existing.fields_json) || '[]'); } catch { fields = []; }
    try { values = JSON.parse(c.plain('values_enc') || '{}'); } catch { values = {}; }
    const miss = require('../routes/forms').missingRequired(fields, values);
    // Flagged on push: the device checked the same list; a form completed in the field still happened.
    return miss.length ? flag(`was accepted as completed, but it is missing required answers (${miss.length}); the office will review it`, { message: `Please fill in: ${miss.join(', ')}`, code: 'form_incomplete' }) : null;
  },
});
