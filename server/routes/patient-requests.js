'use strict';
// Patient-rights requests: a client asking to see their record (§164.524), to amend it (§164.526), to
// restrict how it is used (§164.522) or for the accounting of disclosures (§164.528). Each has a 30-day
// clock from the day it was received; recording it here is what makes the deadline visible.
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const { encrypt, decrypt } = require('../crypto');

const KINDS = ['access', 'amendment', 'restriction', 'accounting'];
const STATUSES = ['open', 'fulfilled', 'denied'];
const DAYS_TO_RESPOND = 30;

function encNotes(v) { if (v.notes !== undefined) { v.notes_enc = v.notes ? encrypt(v.notes) : null; delete v.notes; } }
const dueFrom = (received) => new Date(Date.parse(received) + DAYS_TO_RESPOND * 86400000).toISOString().slice(0, 10);

module.exports = (r) => {
  crud.build(r, {
    table: 'patient_requests', entity: 'patient_request', base: '/api/patient-requests', perm: 'patient-requests',
    dateCol: 'received_at', ownerCol: 'handled_by', creatorCol: 'created_by',
    order: `CASE patient_requests.status WHEN 'open' THEN 0 ELSE 1 END, patient_requests.due_at ASC`,
    joins: 'JOIN clients c ON c.id=patient_requests.client_id LEFT JOIN users u ON u.id=patient_requests.handled_by',
    select: 'patient_requests.*, c.client_code, u.display_name AS handler',
    shape: {
      client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: KINDS },
      received_at: { type: 'date', required: true }, due_at: { type: 'date' }, status: { type: 'string', enum: STATUSES },
      notes: { type: 'string', maxLen: 4000 }, handled_by: { type: 'string' }, closed_at: { type: 'datetime' },
    },
    filters: (ctx, where, params) => {
      const s = ctx.query.get('status'); if (s && s !== 'all') { where.push('patient_requests.status=?'); params.push(s); }
      if (ctx.query.get('overdue') === '1') { where.push(`patient_requests.status='open' AND patient_requests.due_at < ?`); params.push(new Date().toISOString().slice(0, 10)); }
    },
    beforeInsert: (ctx, v) => {
      if (!v.due_at) v.due_at = dueFrom(v.received_at);
      if (!v.handled_by) v.handled_by = ctx.user.id;
      if (v.status && v.status !== 'open' && !v.closed_at) v.closed_at = db.now();
      encNotes(v);
    },
    beforeUpdate: (ctx, v, row) => {
      if (v.received_at && !v.due_at && !row.due_at) v.due_at = dueFrom(v.received_at);
      if (v.status && v.status !== 'open' && !row.closed_at && !v.closed_at) v.closed_at = db.now();
      if (v.status === 'open') v.closed_at = null;
      encNotes(v);
    },
    afterLoad: (ctx, row) => ({ ...row, notes: row.notes_enc ? decrypt(row.notes_enc) : null, notes_enc: undefined, overdue: row.status === 'open' && row.due_at < new Date().toISOString().slice(0, 10) }),
    canEdit: (ctx, row) => row.handled_by === ctx.user.id || row.created_by === ctx.user.id || auth.hasPerm(ctx.user, 'clients:all'),
  });
  r.get('/api/meta/patient-request-options', auth.requireAuth, () => ({ kinds: KINDS, statuses: STATUSES, days_to_respond: DAYS_TO_RESPOND }));
};
module.exports.KINDS = KINDS; module.exports.STATUSES = STATUSES;
