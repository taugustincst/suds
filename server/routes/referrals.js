'use strict';
const db = require('../db');
const crud = require('../crud');
const C = require('../constants');
const { uuid } = require('../crypto');

module.exports = (r) => {
  crud.build(r, {
    table: 'referrals', entity: 'referral', perm: 'referrals', dateCol: 'referred_at', restrictOwner: true,
    joins: 'JOIN users u ON u.id=referrals.user_id JOIN clients c ON c.id=referrals.client_id JOIN resources res ON res.id=referrals.resource_id',
    select: 'referrals.*, u.display_name AS worker, c.client_code, res.name AS resource_name, res.category AS resource_category, res.phone AS resource_phone',
    shape: {
      client_id: { type: 'string', required: true }, resource_id: { type: 'string', required: true }, user_id: { type: 'string' }, referred_at: { type: 'datetime', required: true },
      status: { type: 'string', enum: C.REFERRAL_STATUSES }, urgency: { type: 'string', enum: ['routine', 'urgent', 'emergent'] }, appointment_at: { type: 'datetime' }, admitted_at: { type: 'datetime' },
      closed_at: { type: 'datetime' }, outcome: { type: 'string', maxLen: 500 }, barrier: { type: 'string', maxLen: 300 }, warm_handoff: { type: 'boolean' }, consent_id: { type: 'string' },
      follow_up_due: { type: 'date' }, notes: { type: 'string', maxLen: 2000 },
    },
    filters: (ctx, where, params) => {
      const s = ctx.query.get('status'); if (s) { where.push('referrals.status=?'); params.push(s); }
      if (ctx.query.get('open') === '1') where.push(`referrals.status IN ('pending','contacted','accepted','waitlisted','scheduled')`);
      const res = ctx.query.get('resource_id'); if (res) { where.push('referrals.resource_id=?'); params.push(res); }
    },
    beforeInsert: (ctx, v) => { if (!db.one(`SELECT 1 FROM resources WHERE id=?`, v.resource_id)) throw require('../http').badRequest('Unknown resource'); },
    beforeUpdate: (ctx, v, row) => {
      if (v.status && ['completed', 'closed', 'declined_by_client', 'declined_by_provider'].includes(v.status) && !v.closed_at && !row.closed_at) v.closed_at = db.now();
      if (v.status === 'admitted' && !v.admitted_at && !row.admitted_at) v.admitted_at = db.now();
    },
    afterInsert: (ctx, row) => {
      if (row.follow_up_due) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title,due_at,priority) VALUES(?,?,?,?,?,?,?)`,
        uuid(), row.client_id, row.user_id, ctx.user.id, `Follow up on referral`, row.follow_up_due, row.urgency === 'emergent' ? 'urgent' : 'normal');
    },
    canEdit: crud.ownerOrManager(),
  });
};
