'use strict';
// The rules for patient-rights requests (§164.524/.526/.522/.528), for /api/patient-requests (crud.js) and sync
// push: patient-requests:write, and a request is its handler's or creator's (or a manager's) to change.
const auth = require('../auth');
const { define, notPermitted } = require('./core');

const KINDS = ['access', 'amendment', 'restriction', 'accounting'];
const STATUSES = ['open', 'fulfilled', 'denied'];

module.exports = define({
  table: 'patient_requests',
  fields: {
    client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: KINDS },
    received_at: { type: 'date', required: true }, due_at: { type: 'date' }, status: { type: 'string', enum: STATUSES },
    notes: { type: 'string', maxLen: 4000 }, handled_by: { type: 'string' }, closed_at: { type: 'datetime' },
  },
  editableBy: (user, row) => (row.handled_by === user.id || row.created_by === user.id || auth.hasPerm(user, 'records:manage-others') ? null : notPermitted('You cannot edit this record')),
});
module.exports.KINDS = KINDS; module.exports.STATUSES = STATUSES;
