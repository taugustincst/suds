'use strict';
const db = require('../db');
const crud = require('../crud');
const C = require('../constants');
const { encrypt, decrypt, uuid } = require('../crypto');

module.exports = (r) => {
  crud.build(r, {
    table: 'calls', entity: 'call', perm: 'calls', dateCol: 'started_at', clientRequired: false,
    joins: 'JOIN users u ON u.id=calls.user_id LEFT JOIN clients c ON c.id=calls.client_id',
    select: 'calls.*, u.display_name AS worker, c.client_code',
    shape: {
      client_id: { type: 'string' }, user_id: { type: 'string' }, direction: { type: 'string', required: true, enum: ['inbound', 'outbound'] },
      started_at: { type: 'datetime', required: true }, duration_minutes: { type: 'number', integer: true, min: 0, max: 1440 },
      contact_type: { type: 'string', enum: C.CALL_CONTACT_TYPES }, contact_name: { type: 'string', maxLen: 120 }, phone: { type: 'string', maxLen: 40 },
      purpose: { type: 'string', maxLen: 300 }, outcome: { type: 'string', enum: C.CALL_OUTCOMES }, crisis: { type: 'boolean' },
      follow_up_needed: { type: 'boolean' }, follow_up_due: { type: 'date' }, summary: { type: 'string', maxLen: 4000 }, log_time: { type: 'boolean' },
    },
    filters: (ctx, where, params) => {
      if (ctx.query.get('crisis') === '1') where.push('calls.crisis=1');
      if (ctx.query.get('follow_up') === '1') where.push('calls.follow_up_needed=1');
    },
    beforeInsert: (ctx, v) => encAll(v),
    beforeUpdate: (ctx, v) => encAll(v),
    afterInsert: (ctx, row) => {
      if (row._log_time && row.duration_minutes > 0) db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,call_id,description) VALUES(?,?,?,?,?,?,?,?)`,
        uuid(), row.user_id, row.client_id || null, row.started_at.slice(0, 10), row.duration_minutes, 'direct_service', row.id, `${row.direction} call`);
      if (row.follow_up_needed && row.follow_up_due) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title,due_at,priority) VALUES(?,?,?,?,?,?,?)`,
        uuid(), row.client_id || null, row.user_id, ctx.user.id, `Call back: ${row.purpose || row.contact_type}`, row.follow_up_due, row.crisis ? 'urgent' : 'normal');
    },
    afterLoad: (ctx, x) => ({ ...x, contact_name: x.contact_name_enc ? decrypt(x.contact_name_enc) : null, phone: x.phone_enc ? decrypt(x.phone_enc) : null, summary: x.summary_enc ? decrypt(x.summary_enc) : null, contact_name_enc: undefined, phone_enc: undefined, summary_enc: undefined }),
    canEdit: crud.ownerOrManager(),
  });
  function encAll(v) {
    for (const f of ['contact_name', 'phone', 'summary']) if (v[f] !== undefined) { v[`${f}_enc`] = v[f] === null ? null : encrypt(v[f]); delete v[f]; }
    v._log_time = v.log_time; delete v.log_time;
  }
};
