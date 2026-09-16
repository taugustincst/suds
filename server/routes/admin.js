'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const { badRequest, notFound } = require('../http');
const { validate, paging } = require('../validate');
const { uuid, randomToken, sha256 } = require('../crypto');

const SETTING_KEYS = ['org_name', 'caseload_restriction', 'county_name', 'program_contact', 'default_funding_source_id', 'note_lock_days'];

module.exports = (r) => {
  r.get('/api/admin/settings', auth.requireAuth, auth.requirePerm('settings:manage'), () => {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = db.getSetting(k, '');
    out.env = { env: config.env, tls: !!config.tls.cert, idle_minutes: config.session.idleMinutes, absolute_hours: config.session.absoluteHours, mfa_required_roles: config.mfaRequiredRoles, ms_graph_configured: !!(config.msGraph.tenantId && config.msGraph.clientId && config.msGraph.clientSecret && config.msGraph.user) };
    return out;
  });
  r.put('/api/admin/settings', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const changed = [];
    for (const k of SETTING_KEYS) if (ctx.body[k] !== undefined) { db.setSetting(k, String(ctx.body[k]).slice(0, 500)); changed.push(k); }
    audit.log({ user: ctx.user, action: 'settings.update', ip: ctx.ip, details: { changed } });
    return { ok: true };
  });

  r.get('/api/admin/audit', auth.requireAuth, auth.requirePerm('audit:read'), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 1000 });
    const where = []; const params = [];
    for (const [k, col] of [['user_id', 'user_id'], ['client_id', 'client_id'], ['action', 'action'], ['entity', 'entity']]) {
      const v = ctx.query.get(k); if (v) { where.push(`${col} LIKE ?`); params.push(v + '%'); }
    }
    if (ctx.query.get('from')) { where.push('at >= ?'); params.push(ctx.query.get('from')); }
    if (ctx.query.get('to')) { where.push('at <= ?'); params.push(ctx.query.get('to') + 'T23:59:59.999Z'); }
    if (ctx.query.get('failures') === '1') where.push('success=0');
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.all(`SELECT id,at,user_id,username,action,entity,entity_id,client_id,ip,success,details FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM audit_log ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: 'audit.read', ip: ctx.ip, details: { filters: Object.fromEntries(ctx.query) } });
    return { rows: rows.map(x => ({ ...x, details: x.details ? JSON.parse(x.details) : null })), total, limit, offset };
  });
  r.get('/api/admin/audit/verify', auth.requireAuth, auth.requirePerm('audit:read'), (ctx) => {
    const res = audit.verifyChain();
    audit.log({ user: ctx.user, action: 'audit.verify', ip: ctx.ip, details: res });
    return res;
  });

  // API keys for automated intake (e.g. Pocket AI share/webhook)
  r.get('/api/admin/api-keys', auth.requireAuth, auth.requirePerm('apikeys:manage'), () =>
    ({ keys: db.all(`SELECT k.id,k.name,k.prefix,k.scopes,k.created_at,k.last_used_at,k.revoked_at,u.display_name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id=k.created_by ORDER BY k.created_at DESC`) }));
  r.post('/api/admin/api-keys', auth.requireAuth, auth.requirePerm('apikeys:manage'), (ctx) => {
    const { name } = validate(ctx.body, { name: { type: 'string', required: true, maxLen: 100 } });
    const raw = 'suds_' + randomToken(32);
    const id = uuid();
    db.run(`INSERT INTO api_keys(id,name,key_hash,prefix,scopes,created_by) VALUES(?,?,?,?,?,?)`, id, name, sha256(raw), raw.slice(0, 12), 'intake', ctx.user.id);
    audit.log({ user: ctx.user, action: 'apikey.create', entity: 'api_key', entityId: id, ip: ctx.ip, details: { name } });
    ctx.status = 201;
    return { id, key: raw, note: 'Store this key now; it will not be shown again.' };
  });
  r.delete('/api/admin/api-keys/:id', auth.requireAuth, auth.requirePerm('apikeys:manage'), (ctx) => {
    const k = db.one(`SELECT id FROM api_keys WHERE id=?`, ctx.params.id); if (!k) throw notFound();
    db.run(`UPDATE api_keys SET revoked_at=? WHERE id=?`, db.now(), k.id);
    audit.log({ user: ctx.user, action: 'apikey.revoke', entity: 'api_key', entityId: k.id, ip: ctx.ip });
    return { ok: true };
  });

  r.get('/api/admin/stats', auth.requireAuth, auth.requirePerm('settings:manage'), () => ({
    users: db.one(`SELECT COUNT(*) n FROM users WHERE is_active=1`).n,
    clients: db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n,
    notes: db.one(`SELECT COUNT(*) n FROM notes WHERE deleted_at IS NULL`).n,
    audit_rows: db.one(`SELECT COUNT(*) n FROM audit_log`).n,
    active_sessions: db.one(`SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?`, db.now()).n,
    db_path: config.dbPath,
  }));
};
