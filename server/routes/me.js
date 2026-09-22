'use strict';
// Per-user workspace that follows the person across devices: preferences, recent clients, things in progress.
const db = require('../db');
const auth = require('../auth');
const { badRequest } = require('../http');
const M = require('../clients-model');

const MAX_PREF_BYTES = 8000;
module.exports = (r) => {
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
    const drafts = db.all(`SELECT n.id, n.client_id, n.kind, n.format, n.title_enc, n.updated_at, c.client_code FROM notes n JOIN clients c ON c.id=n.client_id WHERE n.author_id=? AND n.status='draft' AND n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 8`, uid).map(n => ({ ...n, title: n.title_enc ? require('../crypto').decrypt(n.title_enc) : null, title_enc: undefined }));
    for (const d of drafts) { const c = db.one(`SELECT * FROM clients WHERE id=?`, d.client_id); d.client_name = c ? M.summary(c).display_name : d.client_code; }
    const staged = db.one(`SELECT COUNT(*) n FROM import_items x JOIN imports i ON i.id=x.import_id WHERE x.status='staged' AND (i.imported_by=? OR i.imported_by IS NULL)`, uid).n;
    const dueToday = db.all(`SELECT t.id, t.title_enc, t.due_at, t.priority, t.client_id, c.client_code FROM tasks t LEFT JOIN clients c ON c.id=t.client_id WHERE t.assigned_to=? AND t.status IN ('open','in_progress') AND substr(t.due_at,1,10) <= date('now','localtime') ORDER BY t.due_at LIMIT 10`, uid).map(require('./tasks').presentTask);
    for (const t of dueToday) { if (t.client_id) { const c = db.one(`SELECT * FROM clients WHERE id=?`, t.client_id); t.client_name = c ? M.summary(c).display_name : t.client_code; } }
    const lastSeenElsewhere = db.one(`SELECT last_seen_at, user_agent FROM sessions WHERE user_id=? AND revoked_at IS NULL AND id<>? ORDER BY last_seen_at DESC LIMIT 1`, uid, ctx.session.id);
    require('../audit').log({ user: ctx.user, action: 'me.continue', ip: ctx.ip, details: { recent: recent.length, drafts: drafts.length, due_today: dueToday.length } });
    return { recent, drafts, staged_imports: staged, due_today: dueToday, other_device: lastSeenElsewhere ? { last_seen_at: lastSeenElsewhere.last_seen_at, mobile: /Mobi|Android|iPhone|iPad/i.test(lastSeenElsewhere.user_agent || '') } : null };
  });
};
