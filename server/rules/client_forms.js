'use strict';
// The rules for forms filled in for a client, for /api/clients/:id/forms, /api/forms/:id and sync push. A
// completed form is changed (or removed) only by a supervisor (forms:manage), a form is completed only with its
// required fields filled in, and voiding or removing one is the person's who started it, or records:manage-others'
// (security review of 1.16.0, M2: any worker could void or delete another's draft).
const auth = require('../auth');
const { define, refuse, flag, notPermitted } = require('./core');

const locked = (message) => (user, row) => (row.status === 'completed' && !auth.hasPerm(user, 'forms:manage') ? refuse('not permitted: the form is completed; a supervisor can reopen it', { message }) : null);
const removable = (user, row) => locked('Completed forms can only be removed by a supervisor')(user, row)
  || (row.created_by === user.id || auth.hasPerm(user, 'records:manage-others') ? null : notPermitted('Only the person who started this form, or a supervisor, can void or remove it'));

module.exports = define({
  table: 'client_forms',
  deviceColumns: ['template_id', 'template_name', 'fields_json', 'values_enc', 'completed_at', 'deleted_at'], createdBy: ['created_by'],
  fields: { status: { type: 'string', enum: ['draft', 'completed', 'void'] }, notes: { type: 'string', maxLen: 2000 } },
  editableBy: locked('This form is completed. Ask a supervisor to reopen it.'),
  deletableBy: removable,
  // Voiding a form, or removing it (deleted_at), by sync is removing it: DELETE /api/forms/:id's rule.
  authorise(row, c) {
    const e = c.existing;
    return e && ((row.status === 'void' && e.status !== 'void') || (row.deleted_at && !e.deleted_at)) ? removable(c.user, e) : null;
  },
  // Who completed it is whoever completed it here, as PUT /api/forms/:id records it.
  normalise(row, c) {
    const e = c.existing || {};
    const status = row.status !== undefined ? row.status : e.status;
    row.completed_by = status !== 'completed' ? null : e.status === 'completed' ? e.completed_by : c.user.id;
    return null;
  },
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
