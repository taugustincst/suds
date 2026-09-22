'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const audit = require('../audit');
// A to-do list that says "C26-0014" instead of who the person is sends the worker off to look them up.
const { withClientName, SELECT: NAME_COLS } = require('../client-name');

// Which open to-dos are due within `within` minutes, or already overdue, for the signed-in worker. A
// calendar-day deadline counts as due from the start of that day. Rows are scoped to the caseload the
// same way the list is; a to-do with no client is the worker's own.
function dueTasks(ctx, within) {
  const cf = auth.caseloadFilter(ctx.user, 'tasks.client_id');
  const horizon = new Date(Date.now() + within * 60000).toISOString();
  const rows = db.all(`SELECT tasks.*, c.client_code, ${NAME_COLS} FROM tasks LEFT JOIN clients c ON c.id=tasks.client_id
    WHERE tasks.assigned_to=? AND tasks.status IN ('open','in_progress') AND tasks.due_at IS NOT NULL
      AND (CASE WHEN length(tasks.due_at)=10 THEN tasks.due_at <= date(?,'localtime') ELSE tasks.due_at <= ? END)
      AND (tasks.client_id IS NULL OR ${cf.sql})
    ORDER BY tasks.due_at LIMIT 50`, ctx.user.id, horizon, horizon, ...cf.params);
  const now = db.now(); const today = new Date().toISOString().slice(0, 10);
  return rows.map(x => withClientName(ctx, x)).map(x => ({ ...x, overdue: x.due_at.length === 10 ? x.due_at < today : x.due_at < now }));
}

module.exports = (r) => {
  r.get('/api/tasks/due', auth.requireAuth, auth.requirePerm('tasks:read', 'tasks:write'), (ctx) => {
    const within = Math.min(24 * 60, Math.max(0, Number(ctx.query.get('within') || 60)));
    const rows = dueTasks(ctx, within);
    audit.log({ user: ctx.user, action: 'task.due', ip: ctx.ip, details: { within, count: rows.length } });
    return { rows, within, overdue: rows.filter(x => x.overdue).length, due_soon: rows.filter(x => !x.overdue).length };
  });
  crud.build(r, {
    table: 'tasks', entity: 'task', perm: 'tasks', dateCol: 'due_at', ownerCol: 'assigned_to', creatorCol: 'created_by', clientRequired: false,
    order: `CASE tasks.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 ELSE 1 END, tasks.due_at IS NULL, tasks.due_at ASC`,
    joins: 'LEFT JOIN users u ON u.id=tasks.assigned_to LEFT JOIN clients c ON c.id=tasks.client_id',
    select: `tasks.*, u.display_name AS assignee, c.client_code, ${NAME_COLS}`,
    afterLoad: withClientName,
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
    beforeInsert: (ctx, v) => { if (!v.assigned_to) v.assigned_to = ctx.user.id; if (v.status === 'done' && !v.completed_at) v.completed_at = db.now(); },
    beforeUpdate: (ctx, v, row) => { if (v.status === 'done' && !row.completed_at && !v.completed_at) v.completed_at = db.now(); if (v.status && v.status !== 'done') v.completed_at = null; },
    canEdit: (ctx, row) => row.assigned_to === ctx.user.id || row.created_by === ctx.user.id || auth.hasPerm(ctx.user, 'clients:all'),
  });
};
