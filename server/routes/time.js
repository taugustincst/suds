'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const C = require('../constants');

module.exports = (r) => {
  crud.build(r, {
    table: 'time_entries', entity: 'time_entrie', base: '/api/time', perm: 'time', dateCol: 'work_date', clientRequired: false,
    joins: 'JOIN users u ON u.id=time_entries.user_id LEFT JOIN clients c ON c.id=time_entries.client_id LEFT JOIN funding_sources f ON f.id=time_entries.funding_source_id',
    select: 'time_entries.*, u.display_name AS worker, c.client_code, f.name AS funding_source',
    shape: {
      client_id: { type: 'string' }, user_id: { type: 'string' }, work_date: { type: 'date', required: true }, minutes: { type: 'number', required: true, integer: true, min: 1, max: 1440 },
      category: { type: 'string', enum: C.TIME_CATEGORIES }, billable: { type: 'boolean' }, funding_source_id: { type: 'string' }, description: { type: 'string', maxLen: 500 },
      intervention_id: { type: 'string' }, call_id: { type: 'string' },
    },
    filters: (ctx, where, params) => {
      // non-managers see only their own time
      if (!auth.hasPerm(ctx.user, 'time:all')) { where.push('time_entries.user_id=?'); params.push(ctx.user.id); }
      const cat = ctx.query.get('category'); if (cat) { where.push('time_entries.category=?'); params.push(cat); }
    },
    beforeInsert: (ctx, v) => { if (v.user_id && v.user_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'time:all')) v.user_id = ctx.user.id; },
    canEdit: (ctx, row) => row.user_id === ctx.user.id || auth.hasPerm(ctx.user, 'time:all'),
  });

  r.get('/api/time/summary', auth.requireAuth, auth.requirePerm('time:read', 'time:write'), (ctx) => {
    const from = ctx.query.get('from') || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = ctx.query.get('to') || new Date().toISOString().slice(0, 10);
    const all = auth.hasPerm(ctx.user, 'time:all');
    const scope = all ? '' : 'AND t.user_id=?'; const p = all ? [] : [ctx.user.id];
    return {
      from, to,
      by_worker: db.all(`SELECT u.display_name AS worker, t.user_id, SUM(t.minutes) minutes, SUM(CASE WHEN t.billable THEN t.minutes ELSE 0 END) billable_minutes, COUNT(DISTINCT t.client_id) clients FROM time_entries t JOIN users u ON u.id=t.user_id WHERE t.work_date BETWEEN ? AND ? ${scope} GROUP BY t.user_id ORDER BY minutes DESC`, from, to, ...p),
      by_category: db.all(`SELECT category, SUM(minutes) minutes FROM time_entries t WHERE work_date BETWEEN ? AND ? ${scope} GROUP BY category ORDER BY minutes DESC`, from, to, ...p),
      by_day: db.all(`SELECT work_date, SUM(minutes) minutes FROM time_entries t WHERE work_date BETWEEN ? AND ? ${scope} GROUP BY work_date ORDER BY work_date`, from, to, ...p),
      by_fund: db.all(`SELECT COALESCE(f.name,'Unallocated') fund, SUM(t.minutes) minutes FROM time_entries t LEFT JOIN funding_sources f ON f.id=t.funding_source_id WHERE t.work_date BETWEEN ? AND ? ${scope} GROUP BY f.name ORDER BY minutes DESC`, from, to, ...p),
    };
  });
};
