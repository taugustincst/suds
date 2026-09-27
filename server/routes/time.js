'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const C = require('../constants');
const { withClientName, SELECT: NAME_COLS } = require('../client-name');
const { encrypt, decrypt } = require('../crypto');

// What the time was spent on ("Drove J. to detox intake") and the reviewer's note on it are free text that
// can name the client: both are encrypted (migration 37). The API keeps the plain names description and
// approval_note.
function encDescription(v) {
  if (v.description !== undefined) { v.description_enc = v.description ? encrypt(String(v.description)) : null; delete v.description; }
}
/** Decrypt a time entry row's free text, for this route and the places that read time entries outside it. */
function presentTime(t) {
  if (!t) return t;
  const o = { ...t };
  if ('description_enc' in t) { o.description = t.description_enc ? decrypt(t.description_enc) : null; delete o.description_enc; }
  if ('approval_note_enc' in t) { o.approval_note = t.approval_note_enc ? decrypt(t.approval_note_enc) : null; delete o.approval_note_enc; }
  return o;
}

/**
 * What a reader may see of an entry's description. A role without clients:read (finance: time:all, to approve
 * hours) sees another worker's time as category, fund and hours only (security review of 1.13.0, 7): the
 * description is free text about the work and can name the client. Its own entries keep their description.
 * exports.js applies the same rule (mayReadDescription); a role without clients:read cannot sync at all.
 */
const mayReadDescription = (user, entry) => auth.hasPerm(user, 'clients:read') || entry.user_id === user.id;
function withheldFor(user, t) {
  if (!t || mayReadDescription(user, t)) return t;
  return { ...t, description: null, description_withheld: !!(t.description || t.description_enc) };
}

module.exports = (r) => {
  crud.build(r, {
    table: 'time_entries', entity: 'time_entry', base: '/api/time', perm: 'time', dateCol: 'work_date', clientRequired: false,
    // Time is personal: an entry with no client can only be read by the worker who logged it, or a manager
    // (time:all) -- sync-tables.js `unlinked`, which crud.js applies to these routes.
    joins: 'JOIN users u ON u.id=time_entries.user_id LEFT JOIN clients c ON c.id=time_entries.client_id LEFT JOIN funding_sources f ON f.id=time_entries.funding_source_id',
    select: `time_entries.*, u.display_name AS worker, c.client_code, f.name AS funding_source, ${NAME_COLS}`,
    // source (1.14.0): where the entry came from — 'visit' (logged with a visit: "Also log this as a time
    // entry"), 'call' (logged with a call) or 'manual' — so a list can mark the generated ones and the time
    // form can warn before the same work is logged twice.
    afterLoad: (ctx, x) => ({ ...withheldFor(ctx.user, presentTime(withClientName(ctx, x))), source: x.intervention_id ? 'visit' : x.call_id ? 'call' : 'manual' }),
    // shape, owner (time:all), canEdit and the fund-period check: server/rules/time_entries.js.
    filters: (ctx, where, params) => {
      // non-managers see only their own time
      if (!auth.hasPerm(ctx.user, 'time:all')) { where.push('time_entries.user_id=?'); params.push(ctx.user.id); }
      const cat = ctx.query.get('category'); if (cat) { where.push('time_entries.category=?'); params.push(cat); }
      // A manager's own view of one worker's time (the time form's overlap check for a worker they log for).
      const uid = ctx.query.get('user_id'); if (uid) { where.push('time_entries.user_id=?'); params.push(uid); }
      // source=visit|call|manual: the entries a visit or a call logged, or the ones entered by hand.
      const src = ctx.query.get('source');
      if (src === 'visit') where.push('time_entries.intervention_id IS NOT NULL');
      else if (src === 'call') where.push('time_entries.call_id IS NOT NULL');
      else if (src === 'manual') where.push('time_entries.intervention_id IS NULL AND time_entries.call_id IS NULL');
    },
    // Reassigning whose hours these are is a time:all action (see public/views/time.js, which only shows the
    // Worker picker when can('time:all')): the rules' owner, which crud.js applies on insert and update alike.
    beforeInsert: (ctx, v) => { encDescription(v); },
    beforeUpdate: (ctx, v) => { encDescription(v); },
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
module.exports.presentTime = presentTime;
module.exports.mayReadDescription = mayReadDescription;
