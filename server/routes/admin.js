'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const { badRequest, notFound, forbidden } = require('../http');
const { validate, paging } = require('../validate');
const { uuid, randomToken, sha256 } = require('../crypto');

const SETTING_KEYS = ['org_name', 'caseload_restriction', 'county_name', 'program_contact', 'default_funding_source_id', 'note_lock_days', 'session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'mfa_required_roles', 'mfa_grace_days'];
const listener = require('../listener');
const fs = require('node:fs');
const path = require('node:path');

module.exports = (r) => {
  r.get('/api/admin/settings', auth.requireAuth, auth.requirePerm('settings:manage'), () => {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = db.getSetting(k, '');
    const pol = auth.policy();
    out.policy = pol;
    out.env = { env: config.env, tls: !!config.tls.cert, tls_mode: config.tls.mode, key_source: config.keySource, idle_minutes: pol.idleMinutes, absolute_hours: pol.absoluteHours, mfa_required_roles: pol.mfaRequiredRoles, listener: listener.describe(), ms_graph_configured: !!(config.msGraph.tenantId && config.msGraph.clientId && config.msGraph.clientSecret && config.msGraph.user) };
    return out;
  });
  r.put('/api/admin/settings', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const changed = [];
    for (const k of SETTING_KEYS) if (ctx.body[k] !== undefined) {
      let v = String(ctx.body[k]).slice(0, 500);
      if (['session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'mfa_grace_days'].includes(k) && v !== '' && !(Number(v) > 0)) throw badRequest(`${k} must be a positive number`);
      if (k === 'mfa_required_roles') v = v.split(',').map(x => x.trim()).filter(x => ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'].includes(x)).join(',');
      if (k === 'session_idle_minutes' && v !== '' && Number(v) > 60) throw badRequest('Idle timeout may not exceed 60 minutes (HIPAA automatic logoff)');
      db.setSetting(k, v); changed.push(k);
    }
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

  // Network / HTTPS configuration (written to data/server.json; applied immediately)
  r.get('/api/admin/network', auth.requireAuth, auth.requirePerm('settings:manage'), () => ({ listener: listener.describe(), file: config.fileCfg, env_overrides: { host: !!process.env.HOST, port: !!process.env.PORT, tls: !!process.env.TLS_CERT_PATH }, cert_expires: certExpiry() }));
  r.put('/api/admin/network', auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    const v = validate(ctx.body, { network: { type: 'string', required: true, enum: ['local', 'lan'] }, port: { type: 'number', integer: true, min: 1, max: 65535 }, https: { type: 'boolean' }, regenerate_cert: { type: 'boolean' }, extra_hosts: { type: 'string', maxLen: 300 }, trust_proxy: { type: 'boolean' } });
    if (process.env.HOST || process.env.PORT || process.env.TLS_CERT_PATH) throw badRequest('Network settings are controlled by environment variables on this server');
    const host = v.network === 'lan' ? '0.0.0.0' : '127.0.0.1';
    const dir = path.join(config.dataDir, 'certs'); const crt = path.join(dir, 'suds.crt'), key = path.join(dir, 'suds.key');
    let tls = 'none';
    if (v.https) {
      if (v.regenerate_cert || !fs.existsSync(crt)) {
        const hosts = ['localhost', '127.0.0.1', 'suds.local', require('node:os').hostname(), require('node:os').hostname() + '.local', ...listener.lanAddresses().map(a => a.address), ...String(v.extra_hosts || '').split(/[\s,]+/).filter(Boolean)];
        const c = require('../selfsigned').generate({ commonName: db.getSetting('org_name', 'SUDS').slice(0, 60), org: db.getSetting('org_name', 'SUDS').slice(0, 60), hosts: [...new Set(hosts)] });
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(crt, c.cert, { mode: 0o600 }); fs.writeFileSync(key, c.key, { mode: 0o600 });
      }
      tls = 'selfsigned';
    }
    let desc;
    try { desc = await listener.relisten({ host, port: v.port || 'auto', certPath: tls === 'selfsigned' ? crt : '', keyPath: tls === 'selfsigned' ? key : '' }); }
    catch (e) { throw badRequest(`Could not start on port ${v.port || 'auto'}: ${e.message}`); }
    config.saveServerJson({ host, port: desc.port, tls, trustProxy: !!v.trust_proxy });
    config.trustProxy = !!process.env.TRUST_PROXY || !!v.trust_proxy;
    // config.tls was frozen at module load, so after switching to HTTPS the server kept reporting
    // tls: false and never sent HSTS until it was restarted. Keep it in step with what is actually bound.
    config.tls.cert = tls === 'selfsigned' ? crt : '';
    config.tls.key = tls === 'selfsigned' ? key : '';
    config.tls.mode = tls;
    audit.log({ user: ctx.user, action: 'network.update', ip: ctx.ip, details: { host, port: desc.port, tls } });
    return { ok: true, listener: desc };
  });
  function certExpiry() { try { const c = fs.readFileSync(path.join(config.dataDir, 'certs', 'suds.crt')); return new (require('node:crypto').X509Certificate)(c).validTo; } catch { return null; } }
  r.get('/api/admin/certificate', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const crt = path.join(config.dataDir, 'certs', 'suds.crt'); if (!fs.existsSync(crt)) throw notFound('No self-signed certificate');
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="suds-certificate.crt"' }); ctx.res.end(fs.readFileSync(crt));
  });

  // Encrypted backup download. Format and restore both live in server/backup.js, shared with the CLI.
  const backup = require('../backup');
  r.get('/api/admin/backup', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const enc = backup.create();
    audit.log({ user: ctx.user, action: 'backup.download', ip: ctx.ip, details: { bytes: enc.length } });
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="suds-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db.enc"` });
    ctx.res.end(enc);
  });

  // Restoring from a backup, without a terminal. INSTALL.md is written for an office manager; telling them
  // to run `node scripts/backup.js --restore` is not a recovery plan.
  function backupFromUpload(ctx) {
    const b64 = (ctx.body && ctx.body.file_b64) || '';
    if (!b64 || typeof b64 !== 'string') throw badRequest('Choose the backup file to upload');
    const raw = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
    return backup.decrypt(raw);
  }

  // Step 1: say what is in the file. Nothing is changed.
  r.post('/api/admin/restore/preview', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const info = backup.inspect(backupFromUpload(ctx));
    audit.log({ user: ctx.user, action: 'backup.preview', ip: ctx.ip, details: { schema_version: info.schema_version, clients: info.counts.clients } });
    return { ...info, current: { clients: db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n, schema_version: Number(db.getSetting('schema_version', '0')) } };
  });

  // Step 2: actually replace the database. The administrator re-enters their password, because this
  // discards everything recorded since the backup was taken.
  r.post('/api/admin/restore', auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    const { password, confirm } = require('../validate').validate(ctx.body, { password: { type: 'string', required: true, maxLen: 500 }, confirm: { type: 'string', required: true, maxLen: 40 }, file_b64: { type: 'string', maxLen: 400 * 1024 * 1024 } }, { partial: true });
    if (confirm !== 'REPLACE') throw badRequest('Type REPLACE to confirm that the current data will be replaced');
    const me = db.one(`SELECT password_hash FROM users WHERE id=?`, ctx.user.id);
    if (!(await require('../crypto').verifyPasswordAsync(password, me.password_hash))) { audit.log({ user: ctx.user, action: 'backup.restore.failed', ip: ctx.ip, success: false }); throw forbidden('Password verification failed'); }
    const plain = backupFromUpload(ctx);
    // Logged before the swap, because afterwards this audit log is the restored file's, not ours.
    audit.log({ user: ctx.user, action: 'backup.restore.start', ip: ctx.ip, details: { bytes: plain.length } });
    const out = backup.restore(plain);
    audit.log({ user: ctx.user, action: 'backup.restore', ip: ctx.ip, details: { clients: out.counts.clients, schema_version: out.schema_version, kept: path.basename(out.previous_database_kept_at) } });
    return { ok: true, ...out, note: 'Everyone will need to sign in again. Devices should sync after this.' };
  });
  r.get('/api/admin/keys-backup', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    if (config.keySource !== 'file') throw badRequest('Keys are provided by the environment on this server');
    audit.log({ user: ctx.user, action: 'keys.download', ip: ctx.ip });
    ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="suds-keys-KEEP-SECRET.json"' }); ctx.res.end(fs.readFileSync(config.keysJsonPath));
  });

  // Fictional sample data (safe in production: only when the database has no real clients yet, removable in one click)
  const demo = require('../demo');
  r.get('/api/admin/demo', auth.requireAuth, auth.requirePerm('settings:manage'), () => demo.status());
  r.post('/api/admin/demo', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const st = demo.status();
    if (st.loaded) throw badRequest('Sample data is already loaded');
    if (st.clients_total > 0) throw badRequest('Sample data can only be added while there are no clients yet, so it never mixes with real records');
    const out = demo.seed(demo.staffFor(ctx.user));
    audit.log({ user: ctx.user, action: 'demo.load.request', ip: ctx.ip, details: { total: out.total } });
    return out;
  });
  r.delete('/api/admin/demo', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const out = demo.remove({ actor: ctx.user.id });
    audit.log({ user: ctx.user, action: 'demo.remove.request', ip: ctx.ip, details: out });
    return out;
  });
  r.get('/api/admin/stats', auth.requireAuth, auth.requirePerm('settings:manage'), () => ({
    users: db.one(`SELECT COUNT(*) n FROM users WHERE is_active=1`).n,
    clients: db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n,
    notes: db.one(`SELECT COUNT(*) n FROM notes WHERE deleted_at IS NULL`).n,
    audit_rows: db.one(`SELECT COUNT(*) n FROM audit_log`).n,
    active_sessions: db.one(`SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?`, db.now()).n,
    db_path: config.dbPath,
    version: config.version,
    key_source: config.keySource,
    listener: listener.describe(),
  }));
};
