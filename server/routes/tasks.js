'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const { encrypt, decrypt } = require('../crypto');

module.exports = (r) => {
  crud.build(r, {
    table: 'tasks', entity: 'task', perm: 'tasks', dateCol: 'due_at', ownerCol: 'assigned_to', creatorCol: 'created_by', clientRequired: false,
    order: `CASE tasks.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 ELSE 1 END, tasks.due_at IS NULL, tasks.due_at ASC`,
    joins: 'LEFT JOIN users u ON u.id=tasks.assigned_to LEFT JOIN clients c ON c.id=tasks.client_id',
    select: 'tasks.*, u.display_name AS assignee, c.client_code',
    shape: {
      client_id: { type: 'string' }, assigned_to: { type: 'string' }, title: { type: 'string', required: true, maxLen: 200 }, description: { type: 'string', maxLen: 2000 },
      due_at: { type: 'datetime' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
      is_milestone: { type: 'boolean' }, completed_at: { type: 'datetime' },
    },
    filters: (ctx, where, params) => {
      const s = ctx.query.get('status');
      if (s === 'open') where.push(`tasks.status IN ('open','in_progress')`); else if (s && s !== 'all') { where.push('tasks.status=?'); params.push(s); }
      if (ctx.query.get('overdue') === '1') { where.push(`tasks.status IN ('open','in_progress') AND (CASE WHEN length(tasks.due_at)=10 THEN tasks.due_at < date('now','localtime') ELSE tasks.due_at < ? END)`); params.push(db.now()); }
      if (ctx.query.get('milestones') === '1') where.push('tasks.is_milestone=1');
    },
    // A task title ("Call about detox bed") says what a named person is being treated for: encrypted.
    beforeInsert: (ctx, v) => { if (!v.assigned_to) v.assigned_to = ctx.user.id; if (v.status === 'done' && !v.completed_at) v.completed_at = db.now(); encTitle(v); },
    beforeUpdate: (ctx, v, row) => { if (v.status === 'done' && !row.completed_at && !v.completed_at) v.completed_at = db.now(); if (v.status && v.status !== 'done') v.completed_at = null; encTitle(v); },
    afterLoad: (ctx, x) => ({ ...x, title: x.title_enc ? decrypt(x.title_enc) : '', title_enc: undefined }),
    canEdit: (ctx, row) => row.assigned_to === ctx.user.id || row.created_by === ctx.user.id || auth.hasPerm(ctx.user, 'clients:all'),
  });
  function encTitle(v) { if (v.title !== undefined) { v.title_enc = encrypt(String(v.title ?? '')); delete v.title; } }
};
/** Decrypt a task row's title in place, for the places that read tasks outside the route. */
module.exports.presentTask = (t) => (t ? { ...t, title: t.title_enc ? decrypt(t.title_enc) : '', title_enc: undefined } : t);
