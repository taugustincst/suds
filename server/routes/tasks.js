'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const { encrypt, decrypt } = require('../crypto');
const audit = require('../audit');
// A to-do list that says "C26-0014" instead of who the person is sends the worker off to look them up.
const { withClientName, SELECT: NAME_COLS } = require('../client-name');

// Which open to-dos are due within `within` minutes, or already overdue, for the signed-in worker. A
// calendar-day deadline counts as due from the start of that day. Rows are scoped to the caseload the
// same way the list is; a to-do with no client is the worker's own.
// Calendar-day deadlines are compared with "today" in the organisation's time zone, computed once here
// and handed to SQL — not date('now','localtime') in SQL against new Date().toISOString() in JS, which
// were two different days for a few hours either side of midnight.
const { localDate } = require('./budget');
const { isNotice, noticeBy, noticeRevisions } = require('../rules/tasks');
function dueTasks(ctx, within) {
  const cf = auth.caseloadFilter(ctx.user, 'tasks.client_id');
  const horizonMs = Date.now() + within * 60000;
  const horizon = new Date(horizonMs).toISOString(); const horizonDay = localDate(new Date(horizonMs));
  const rows = db.all(`SELECT tasks.*, c.client_code, ${NAME_COLS} FROM tasks LEFT JOIN clients c ON c.id=tasks.client_id
    WHERE tasks.assigned_to=? AND tasks.status IN ('open','in_progress') AND tasks.due_at IS NOT NULL
      AND (CASE WHEN length(tasks.due_at)=10 THEN tasks.due_at <= ? ELSE tasks.due_at <= ? END)
      AND (tasks.client_id IS NULL OR ${cf.sql})
    ORDER BY tasks.due_at LIMIT 50`, ctx.user.id, horizonDay, horizon, ...cf.params);
  const now = db.now(); const today = localDate();
  // Change notices (server/rules/clients.js notifyPrimary) have no due date and are never overdue: listed first, as new.
  const notices = db.all(`SELECT tasks.*, c.client_code, ${NAME_COLS} FROM tasks LEFT JOIN clients c ON c.id=tasks.client_id
    WHERE tasks.assigned_to=? AND tasks.created_by=? AND tasks.status='open' AND tasks.due_at IS NULL AND tasks.client_id IS NOT NULL AND ${cf.sql}
    ORDER BY tasks.updated_at DESC LIMIT 50`, ctx.user.id, ctx.user.id, ...cf.params).filter(isNotice);
  return [...notices.map(x => ({ ...presentTask(withClientName(ctx, x)), overdue: false })),
    ...rows.map(x => withClientName(ctx, x)).map(x => ({ ...presentTask(x), overdue: x.due_at.length === 10 ? x.due_at < today : x.due_at < now }))];
}

// The due-reminder poll is a count the app shell repeats all day; auditing every poll wrote thousands of
// identical rows per worker per week and buried the reads that matter. It is still a task read, so the
// audit entry is written when what the poll returns changes for that worker (and on the first poll of a
// process), not on every repetition of the same answer.
const lastDue = new Map();
module.exports = (r) => {
  r.get('/api/tasks/due', auth.requireAuth, auth.requirePerm('tasks:read', 'tasks:write'), (ctx) => {
    const within = Math.min(24 * 60, Math.max(0, Number(ctx.query.get('within') || 60)));
    const rows = dueTasks(ctx, within);
    const signature = `${within}|${rows.map(x => `${x.id}:${x.overdue ? 1 : 0}`).join(',')}`;
    if (lastDue.get(ctx.user.id) !== signature) {
      lastDue.set(ctx.user.id, signature);
      audit.log({ user: ctx.user, action: 'task.due', ip: ctx.ip, details: { within, count: rows.length } });
    }
    return { rows, within, overdue: rows.filter(x => x.overdue).length, due_soon: rows.filter(x => !x.overdue && !x.notice).length, notices: rows.filter(x => x.notice).length };
  });
  crud.build(r, {
    table: 'tasks', entity: 'task', perm: 'tasks', dateCol: 'due_at', ownerCol: 'assigned_to', creatorCol: 'created_by', clientRequired: false,
    order: `CASE tasks.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 ELSE 1 END, tasks.due_at IS NULL, tasks.due_at ASC`,
    joins: 'LEFT JOIN users u ON u.id=tasks.assigned_to LEFT JOIN clients c ON c.id=tasks.client_id',
    select: `tasks.*, u.display_name AS assignee, c.client_code, ${NAME_COLS}`,
    // shape and canEdit: server/rules/tasks.js (crud.js reads them from there).
    filters: (ctx, where, params) => {
      const s = ctx.query.get('status');
      if (s === 'open') where.push(`tasks.status IN ('open','in_progress')`); else if (s && s !== 'all') { where.push('tasks.status=?'); params.push(s); }
      if (ctx.query.get('overdue') === '1') { where.push(`tasks.status IN ('open','in_progress') AND (CASE WHEN length(tasks.due_at)=10 THEN tasks.due_at < ? ELSE tasks.due_at < ? END)`); params.push(localDate(), db.now()); }
      if (ctx.query.get('milestones') === '1') where.push('tasks.is_milestone=1');
    },
    // A task title ("Call about detox bed") says what a named person is being treated for, and its details
    // say more: both are encrypted. The API keeps the plain field names `title` and `description`.
    beforeInsert: (ctx, v) => { if (!v.assigned_to) v.assigned_to = ctx.user.id; if (v.status === 'done' && !v.completed_at) v.completed_at = db.now(); encFields(v); },
    beforeUpdate: (ctx, v, row) => { if (v.status === 'done' && !row.completed_at && !v.completed_at) v.completed_at = db.now(); if (v.status && v.status !== 'done') v.completed_at = null; encFields(v); },
    afterLoad: (ctx, x) => presentTask(withClientName(ctx, x)),
  });
  function encFields(v) {
    if (v.title !== undefined) { v.title_enc = encrypt(String(v.title ?? '')); delete v.title; }
    if (v.description !== undefined) { v.description_enc = v.description ? encrypt(String(v.description)) : null; delete v.description; }
  }
};
/** Decrypt a task row's title and details, for the route and the places that read tasks outside it. */
function presentTask(t) {
  if (!t) return t;
  const o = { ...t, title: t.title_enc ? decrypt(t.title_enc) : '', title_enc: undefined };
  if ('description_enc' in t) { o.description = t.description_enc ? decrypt(t.description_enc) : null; o.description_enc = undefined; }
  // A change notice (1.16.2): the UI shows it as a read-only card; only its assignee or a manager closes it. Known
  // by how it was raised, never by its text (1.16.3, rules/tasks.js isNotice): this flag is all the UI trusts.
  if (o.description && isNotice(t)) {
    o.notice = true;
    // Who made the change is the audit entry's user, never the title's words (security review of 1.16.3, N5).
    const by = noticeBy(t); const u = by && db.one(`SELECT display_name FROM users WHERE id=?`, by);
    if (u) o.notice_by = u.display_name;
    // The revisions it reports (1.17.0): its card links to them on the record's History ("See what changed").
    const revs = noticeRevisions(t); if (revs.length) o.notice_revisions = revs;
  }
  // A notice's title names the client by code (it is written once, for whoever reads it); shown as every list
  // shows a client: the name, where this reader may see it (r8 M2).
  if (o.notice && o.client_name && o.client_code) o.title = o.title.replace(`${o.client_code}'s record`, `${o.client_name}'s record`);
  return o;
}
module.exports.presentTask = presentTask;
