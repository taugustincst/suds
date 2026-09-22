'use strict';
const db = require('../db');
const crud = require('../crud');
const C = require('../constants');
const { encrypt, decrypt, uuid } = require('../crypto');
const { badRequest } = require('../http');

module.exports = (r) => {
  crud.build(r, {
    table: 'calls', entity: 'call', perm: 'calls', dateCol: 'started_at', clientRequired: false, restrictOwner: true,
    joins: 'JOIN users u ON u.id=calls.user_id LEFT JOIN clients c ON c.id=calls.client_id',
    select: 'calls.*, u.display_name AS worker, c.client_code',
    shape: {
      client_id: { type: 'string' }, user_id: { type: 'string' }, direction: { type: 'string', required: true, enum: ['inbound', 'outbound'] },
      method: { type: 'string', enum: C.CONTACT_METHODS },
      started_at: { type: 'datetime', required: true }, duration_minutes: { type: 'number', integer: true, min: 0, max: 1440 },
      contact_type: { type: 'string', enum: C.CALL_CONTACT_TYPES }, contact_name: { type: 'string', maxLen: 120 }, phone: { type: 'string', maxLen: 40 },
      purpose: { type: 'string', maxLen: 300 }, outcome: { type: 'string', enum: [...C.CALL_OUTCOMES, ...C.TEXT_OUTCOMES] }, crisis: { type: 'boolean' },
      follow_up_needed: { type: 'boolean' }, follow_up_due: { type: 'date' }, summary: { type: 'string', maxLen: 4000 }, log_time: { type: 'boolean' },
    },
    filters: (ctx, where, params) => {
      const method = ctx.query.get('method'); if (C.CONTACT_METHODS.includes(method)) { where.push('calls.method=?'); params.push(method); }
      if (ctx.query.get('crisis') === '1') where.push('calls.crisis=1');
      if (ctx.query.get('follow_up') === '1') where.push('calls.follow_up_needed=1');
    },
    beforeInsert: (ctx, v) => {
      const method = v.method || 'phone';
      // The column defaults to 'reached', which is a call's word: a text with no outcome was simply sent.
      if (method === 'text' && !v.outcome) v.outcome = 'sent';
      checkOutcome(v, method); encAll(v);
    },
    beforeUpdate: (ctx, v, row) => { checkOutcome(v, v.method || row.method || 'phone'); encAll(v); },
    afterInsert: (ctx, row) => {
      const what = row.method === 'text' ? 'text message' : 'call';
      if (row._log_time && row.duration_minutes > 0) db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,call_id,description) VALUES(?,?,?,?,?,?,?,?)`,
        uuid(), row.user_id, row.client_id || null, row.started_at.slice(0, 10), row.duration_minutes, 'direct_service', row.id, `${row.direction} ${what}`);
      if (row.follow_up_needed && row.follow_up_due) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,priority) VALUES(?,?,?,?,?,?,?)`,
        uuid(), row.client_id || null, row.user_id, ctx.user.id, encrypt(`${row.method === 'text' ? 'Text back' : 'Call back'}: ${row._purpose || row.contact_type}`), row.follow_up_due, row.crisis ? 'urgent' : 'normal');
    },
    afterLoad: (ctx, x) => ({ ...x, contact_name: x.contact_name_enc ? decrypt(x.contact_name_enc) : null, phone: x.phone_enc ? decrypt(x.phone_enc) : null, summary: x.summary_enc ? decrypt(x.summary_enc) : null, purpose: x.purpose_enc ? decrypt(x.purpose_enc) : null, contact_name_enc: undefined, phone_enc: undefined, summary_enc: undefined, purpose_enc: undefined }),
    canEdit: crud.ownerOrManager(),
  });
  // A call's outcomes and a text's outcomes do not overlap, and picking one from the wrong list would
  // quietly break the reports that count who was actually reached.
  function checkOutcome(v, method) {
    if (v.outcome === undefined || v.outcome === null) return;
    const allowed = method === 'text' ? C.TEXT_OUTCOMES : C.CALL_OUTCOMES;
    if (!allowed.includes(v.outcome)) throw badRequest(`"${v.outcome}" is not an outcome for a ${method === 'text' ? 'text message' : 'phone call'}. Choose one of: ${allowed.join(', ')}`);
  }
  function encAll(v) {
    // The purpose of a call ("detox bed", "MAT intake") names the client's situation, so it is encrypted
    // like the summary; the plaintext is kept only for the follow-up task title built in afterInsert.
    if (v.purpose !== undefined) v._purpose = v.purpose;
    for (const f of ['contact_name', 'phone', 'summary', 'purpose']) if (v[f] !== undefined) { v[`${f}_enc`] = v[f] === null ? null : encrypt(v[f]); delete v[f]; }
    v._log_time = v.log_time; delete v.log_time;
  }
};
