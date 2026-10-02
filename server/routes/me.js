'use strict';
// Per-user workspace that follows the person across devices: preferences, recent clients, things in progress.
const db = require('../db');
const auth = require('../auth');
const { badRequest } = require('../http');
const M = require('../clients-model');
const { withClientName, SELECT: NAME_COLS } = require('../client-name');

const MAX_PREF_BYTES = 8000;
module.exports = (r) => {
  // The signed-in user's own permission snapshot: effective permissions (grants applied, denies
  // removed) plus the deny list, so the UI can gate exactly like the server and refresh mid-session.
  r.get('/api/me', auth.requireAuth, (ctx) => auth.publicUser(ctx.user));
  // "Set up this phone for the field" (1.23.0, server/field-request.js): the worker's request, and the administrators' answer.
  require('../field-request').routes(r);
  r.get('/api/me/prefs', auth.requireAuth, (ctx) => {
    const out = {};
    for (const p of db.all(`SELECT key, value FROM user_prefs WHERE user_id=?`, ctx.user.id)) { try { out[p.key] = JSON.parse(p.value); } catch { out[p.key] = p.value; } }
    return { prefs: out };
  });
  // Merge-put: only the provided keys change. Values are small JSON (UI state, never PHI).
  r.put('/api/me/prefs', auth.requireAuth, (ctx) => {
    const body = ctx.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Object expected');
    const keys = Object.keys(body).slice(0, 50);
    db.transaction(() => {
      for (const k of keys) {
        if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(k)) throw badRequest(`Invalid preference key ${k}`);
        const v = JSON.stringify(body[k] ?? null);
        if (v.length > MAX_PREF_BYTES) throw badRequest(`Preference ${k} is too large`);
        if (body[k] === null) db.run(`DELETE FROM user_prefs WHERE user_id=? AND key=?`, ctx.user.id, k);
        else db.run(`INSERT INTO user_prefs(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`, ctx.user.id, k, v);
      }
    });
    return { ok: true };
  });

  // "Continue where you left off" — derived from the user's own activity on any device.
  r.get('/api/me/continue', auth.requireAuth, (ctx) => {
    const uid = ctx.user.id;
    const recentIds = db.all(`SELECT client_id, MAX(at) at FROM audit_log WHERE user_id=? AND client_id IS NOT NULL AND action IN ('client.view','client.create','client.update','intervention.create','call.create','note.create','note.update') GROUP BY client_id ORDER BY at DESC LIMIT 8`, uid);
    const recent = [];
    for (const x of recentIds) {
      const c = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL`, x.client_id);
      if (c && auth.canAccessClient(ctx.user, c.id)) recent.push({ ...M.summary(c), last_at: x.at });
    }
    // Drafts and to-dos are scoped to the caseload the way the task list and /api/tasks/due are (security
    // review of 1.13.0, finding 2): once an assignment ends, a client the person can no longer open drops out
    // of this list too — its name, the draft's title and the to-do's title with it — including a to-do another
    // worker gave them on that worker's own client. A to-do with no client is the person's own.
    const cf = (col) => auth.caseloadFilter(ctx.user, col);
    const readsClients = auth.hasPerm(ctx.user, 'clients:read');
    const nf = cf('n.client_id');
    const drafts = !readsClients ? [] : db.all(`SELECT n.id, n.client_id, n.kind, n.format, n.title_enc, n.updated_at, c.client_code, ${NAME_COLS} FROM notes n JOIN clients c ON c.id=n.client_id
      WHERE n.author_id=? AND n.status='draft' AND n.deleted_at IS NULL AND c.deleted_at IS NULL AND ${nf.sql} ORDER BY n.updated_at DESC LIMIT 8`, uid, ...nf.params)
      .map(n => withClientName(ctx, n)).map(n => ({ ...n, title: n.title_enc ? require('../crypto').decrypt(n.title_enc) : null, title_enc: undefined, client_name: n.client_name || n.client_code }));
    const staged = db.one(`SELECT COUNT(*) n FROM import_items x JOIN imports i ON i.id=x.import_id WHERE x.status='staged' AND (i.imported_by=? OR i.imported_by IS NULL)`, uid).n;
    const tf = cf('t.client_id');
    const dueToday = db.all(`SELECT t.id, t.title_enc, t.description_enc, t.created_by, t.assigned_to, t.due_at, t.priority, t.status, t.client_id, c.client_code, ${NAME_COLS} FROM tasks t LEFT JOIN clients c ON c.id=t.client_id
      WHERE t.assigned_to=? AND t.status IN ('open','in_progress') AND substr(t.due_at,1,10) <= date('now','localtime') AND (t.client_id IS NULL OR ${tf.sql}) ORDER BY t.due_at LIMIT 10`, uid, ...tf.params)
      .map(t => withClientName(ctx, t)).map(require('./tasks').presentTask)
      // Home shows only the title: the details stay off its payload, but whether a to-do is a supervisor's reminder to
      // sign notes is said, so ticking it can ask about drafts left without reading the to-do again (review of 1.23.5).
      .map(({ description, created_by, ...t }) => ({ ...t, sign_reminder: !!t.sign_reminder }))
      .map(t => (t.client_id ? { ...t, client_name: t.client_name || t.client_code } : t));
    const lastSeenElsewhere = db.one(`SELECT last_seen_at, user_agent FROM sessions WHERE user_id=? AND revoked_at IS NULL AND id<>? ORDER BY last_seen_at DESC LIMIT 1`, uid, ctx.session.id);
    require('../audit').log({ user: ctx.user, action: 'me.continue', ip: ctx.ip, details: { recent: recent.length, drafts: drafts.length, due_today: dueToday.length } });
    return { recent, drafts, staged_imports: staged, due_today: dueToday, other_device: lastSeenElsewhere ? { last_seen_at: lastSeenElsewhere.last_seen_at, mobile: /Mobi|Android|iPhone|iPad/i.test(lastSeenElsewhere.user_agent || '') } : null };
  });
};
