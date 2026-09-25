'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const { badRequest, notFound, forbidden, HttpError } = require('../http');
const { validate, paging } = require('../validate');
const { uuid, randomToken, sha256 } = require('../crypto');

// default_funding_source_id used to be accepted here and was read by nothing; it is gone (1.9.5). Its
// successor, default_fund_id, is read: new visits are charged to it (server/routes/interventions.js).
const SETTING_KEYS = ['org_name', 'caseload_restriction', 'county_name', 'program_contact', 'self_signup', 'note_lock_days', 'session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'mfa_required_roles', 'mfa_grace_days',
  'backup_schedule_hours', 'backup_retain_count', 'backup_offsite_dir', 'client_retention_years', 'org_timezone',
  // Minutes after proving identity during which a note is signed with a confirmation alone (auth.verifySigner).
  'sign_reauth_minutes',
  // Identity and recovery controls (server/security-status.js validates them together).
  'mfa_require_all', 'sso_required', 'sso_emergency_accounts', 'dr_drill_monthly', 'dr_rto_target_minutes', 'dr_rpo_target_hours',
  // Frequent online snapshots (server/scheduled-backup.js snapshot).
  'backup_schedule_minutes', 'backup_snapshot_retain',
  // Identity-provider trust and lifecycle: IdP MFA in place of SUDS TOTP (server/routes/oidc.js), disabling
  // SSO accounts the provider no longer vouches for (server/deprovision.js), SCIM provisioning (server/routes/scim.js).
  'sso_trust_idp_mfa', 'sso_mfa_acr_values', 'sso_deprovision_days', 'scim_group_roles', 'scim_default_role',
  // Reporting (server/routes/reports.js, server/harm-reduction-reports.js): the programme's default fund, the
  // funder report's small-cell threshold, and how many naloxone doses one distributed kit holds.
  'default_fund_id', 'small_cell_threshold', 'naloxone_doses_per_kit'];
const ROLES = ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'];
const listener = require('../listener');
const fs = require('node:fs');
const path = require('node:path');

module.exports = (r) => {
  r.get('/api/admin/settings', auth.requireAuth, auth.requirePerm('settings:manage'), () => {
    const out = {};
    // An unset key is null, never ''. The Settings form fills a field from this value when it is present
    // and from the field's own default otherwise -- and '' counts as present, so every policy field used to
    // render blank on a fresh install and be saved back blank, which switched MFA off for every role.
    for (const k of SETTING_KEYS) { const v = db.getSetting(k, null); out[k] = v === '' ? null : v; }
    const pol = auth.policy();
    out.policy = pol;
    // The zone in force (the setting, else ORG_TIMEZONE, else the machine's) and the fallback a blank
    // setting returns to, so the form can say what "not set" means.
    const budget = require('./budget');
    out.timezone = { effective: budget.orgTimezone(), fallback: config.orgTimezone || null, from_env: !!process.env.ORG_TIMEZONE };
    out.env = { env: config.env, tls: !!config.tls.cert, tls_mode: config.tls.mode, key_source: config.keySource, idle_minutes: pol.idleMinutes, absolute_hours: pol.absoluteHours, mfa_required_roles: pol.mfaRequiredRoles, listener: listener.describe(), ms_graph_configured: !!(config.msGraph.tenantId && config.msGraph.clientId && config.msGraph.clientSecret && config.msGraph.user), oidc_configured: config.oidc.enabled, oidc_label: config.oidc.label };
    return out;
  });
  r.put('/api/admin/settings', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const changed = [];
    const ssoBefore = [db.getSetting('sso_required', '0'), db.getSetting('sso_emergency_accounts', '')].join('|');
    // One transaction: a bad value part-way through the form must not leave the fields before it saved
    // and the ones after it not.
    db.transaction(() => {
      for (const k of SETTING_KEYS) if (ctx.body[k] !== undefined) {
        // A blank number field reaches here as null (the frontend form reads an empty input as null, not
        // ''), and String(null) is the four-character string "null" — which failed every numeric check
        // below and, for a text setting, silently saved the literal word "null" as its value.
        let v = ctx.body[k] === null ? '' : String(ctx.body[k]).slice(0, 500);
        if (['session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'mfa_grace_days', 'backup_schedule_hours', 'backup_retain_count', 'client_retention_years'].includes(k) && v !== '' && !(Number(v) >= 0)) throw badRequest(`${k} must be a non-negative number`);
        // A zero here would not mean zero: the policy falls back to its default for anything under 1, so
        // "0 minutes" quietly became 15. Say so instead. (0 grace days and 0 schedule hours do mean 0.)
        if (['session_idle_minutes', 'session_absolute_hours', 'password_max_age_days', 'backup_retain_count'].includes(k) && v !== '' && Number(v) < 1) throw badRequest(`${k} must be at least 1; leave it blank to use the default`);
        // Shorter than HIPAA's six-year documentation floor is not a setting, it is a policy violation.
        if (k === 'client_retention_years' && v !== '' && Number(v) < 6) throw badRequest('Client records must be kept at least 6 years (45 CFR §164.316(b)(2)); most SUD programs keep 7 or more');
        // Sign-up on the sign-in page (POST /api/auth/signup): on unless switched off.
        if (k === 'self_signup' && v !== '' && !['0', '1'].includes(v)) throw badRequest('self_signup must be 1 (on) or 0 (off)');
        // The programme's calendar (server/routes/budget.js orgTimezone): an IANA name this server knows.
        if (k === 'org_timezone' && v !== '' && !require('./budget').validTimezone(v)) throw badRequest('org_timezone must be a time zone name such as America/Los_Angeles');
        if (['mfa_require_all', 'sso_required', 'dr_drill_monthly'].includes(k) && v !== '' && !['0', '1'].includes(v)) throw badRequest(`${k} must be 1 (on) or 0 (off)`);
        if (['dr_rto_target_minutes', 'dr_rpo_target_hours'].includes(k) && v !== '' && !(Number(v) > 0)) throw badRequest(`${k} must be a positive number`);
        if (k === 'mfa_required_roles') v = v.split(',').map(x => x.trim()).filter(x => ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'].includes(x)).join(',');
        if (k === 'sign_reauth_minutes' && v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 60)) throw badRequest('sign_reauth_minutes must be a whole number of minutes from 0 (always ask) to 60');
        if (k === 'session_idle_minutes' && v !== '' && Number(v) > 60) throw badRequest('Idle timeout may not exceed 60 minutes (HIPAA automatic logoff)');
        // Snapshots every few minutes: 0 is off; under 5 would spend the server on copying itself.
        if (k === 'backup_schedule_minutes' && v !== '' && !(Number.isInteger(Number(v)) && (Number(v) === 0 || (Number(v) >= 5 && Number(v) <= 1440)))) throw badRequest('backup_schedule_minutes must be 0 (off) or a whole number of minutes from 5 to 1440');
        if (k === 'backup_snapshot_retain' && v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 1000)) throw badRequest('backup_snapshot_retain must be a whole number from 1 to 1000');
        if (k === 'sso_trust_idp_mfa' && v !== '' && !['0', '1'].includes(v)) throw badRequest('sso_trust_idp_mfa must be 1 (on) or 0 (off)');
        if (k === 'sso_mfa_acr_values' && v !== '') { const vals = v.split(/[\s,]+/).filter(Boolean); if (vals.some((x) => !/^[\w:./#-]{1,200}$/.test(x))) throw badRequest('sso_mfa_acr_values must be acr values (URIs or names) separated by commas'); v = vals.join(','); }
        if (k === 'sso_deprovision_days' && v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 3650)) throw badRequest('sso_deprovision_days must be 0 (off) or a whole number of days');
        if (k === 'scim_default_role' && v !== '' && !ROLES.includes(v)) throw badRequest(`scim_default_role must be one of ${ROLES.join(', ')}`);
        if (k === 'scim_group_roles' && v !== '') v = require('../scim').normaliseGroupRoles(v);
        if (k === 'default_fund_id' && v !== '' && !db.one(`SELECT 1 FROM funding_sources WHERE id=? AND is_active=1`, v)) throw badRequest('default_fund_id must be an active funding source');
        // Under 2 would suppress nothing at all; over 50 would suppress nearly every breakdown a small programme has.
        if (k === 'small_cell_threshold' && v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 2 && Number(v) <= 50)) throw badRequest('small_cell_threshold must be a whole number from 2 to 50');
        if (k === 'naloxone_doses_per_kit' && v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 20)) throw badRequest('naloxone_doses_per_kit must be a whole number from 1 to 20');
        // Blank means "back to the default", so the row goes rather than an empty string being stored:
        // policy() read '' in mfa_required_roles as "no role needs MFA". Nothing here ever stores ''.
        if (v === '') db.run(`DELETE FROM settings WHERE key=?`, k); else db.setSetting(k, v);
        changed.push(k);
      }
      // Checked on the settings as saved, so turning SSO on and naming the emergency accounts can be one save —
      // and only when this save turns it on or changes the accounts, so a server whose identity provider has
      // since been unconfigured can still save its other settings (Security status flags that state).
      if (!config.local && [db.getSetting('sso_required', '0'), db.getSetting('sso_emergency_accounts', '')].join('|') !== ssoBefore) require('../security-status').validateSettings();
    });
    audit.log({ user: ctx.user, action: 'settings.update', ip: ctx.ip, details: { changed } });
    // Trusting the identity provider's second factor changes who can reach records without SUDS's own: its
    // own audit entry, so it stands out from routine settings changes.
    if (changed.includes('sso_trust_idp_mfa') || changed.includes('sso_mfa_acr_values')) audit.log({ user: ctx.user, action: 'security.idp_mfa_trust', ip: ctx.ip, details: { trusted: db.getSetting('sso_trust_idp_mfa', '0') === '1', acr_values: db.getSetting('sso_mfa_acr_values', '') || null } });
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
  // The whole chain, but in batches with the event loop free in between, so one administrator's click on a
  // million-row log does not stall every other request for seconds.
  r.get('/api/admin/audit/verify', auth.requireAuth, auth.requirePerm('audit:read'), async (ctx) => {
    const res = await audit.verifyChainAsync();
    // And against the anchors written outside the database (server/audit-anchor.js): the check that
    // catches a chain rebuilt wholesale by someone holding the database and its key.
    if (!config.local) { const a = require('../audit-anchor').verifyAndRecord(); res.anchors = { ok: a.ok, total: a.total, matched: a.matched, other_key: a.other_key, purged: a.purged, bad: a.bad.slice(0, 20) }; }
    audit.log({ user: ctx.user, action: 'audit.verify', ip: ctx.ip, details: res });
    if (!res.ok) require('../incidents').chainFailure(res, ctx.user);
    return res;
  });

  // API keys for automated intake (e.g. Pocket AI share/webhook)
  r.get('/api/admin/api-keys', auth.requireAuth, auth.requirePerm('apikeys:manage'), () =>
    ({ keys: db.all(`SELECT k.id,k.name,k.prefix,k.scopes,k.created_at,k.last_used_at,k.revoked_at,u.display_name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id=k.created_by WHERE k.scopes NOT LIKE 'fhir%' AND k.scopes <> 'scim' ORDER BY k.created_at DESC`) }));
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
    if (v.network === 'lan' && !v.https && !v.trust_proxy && !config.trustProxy) throw badRequest('HTTPS is required when other devices can connect');
    if (v.https) {
      if (v.regenerate_cert || !fs.existsSync(crt) || !fs.existsSync(path.join(dir, 'suds-ca.crt'))) {
        const hosts = ['localhost', '127.0.0.1', 'suds.local', require('node:os').hostname(), require('node:os').hostname() + '.local', ...listener.lanAddresses().map(a => a.address), ...String(v.extra_hosts || '').split(/[\s,]+/).filter(Boolean)];
        const c = require('../selfsigned').generate({ commonName: db.getSetting('org_name', 'SUDS').slice(0, 60), org: db.getSetting('org_name', 'SUDS').slice(0, 60), hosts: [...new Set(hosts)] });
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(crt, c.cert, { mode: 0o600 }); fs.writeFileSync(key, c.key, { mode: 0o600 }); fs.writeFileSync(path.join(dir, 'suds-ca.crt'), c.ca, { mode: 0o644 });
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
  // What a phone installs is the CA, not the server certificate: only a CA can be added to a device's trust
  // store. A certs folder from before the CA existed still serves its self-signed leaf, which browsers on a
  // computer will accept, until "Create a new certificate" is used.
  r.get('/api/admin/certificate', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const caPath = path.join(config.dataDir, 'certs', 'suds-ca.crt'); const crt = fs.existsSync(caPath) ? caPath : path.join(config.dataDir, 'certs', 'suds.crt');
    if (!fs.existsSync(crt)) throw notFound('No self-signed certificate');
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

  // Unattended backups (server/scheduled-backup.js), run from the hourly housekeeping timer once an
  // administrator turns the schedule on under Settings → System & backups.
  const scheduledBackup = require('../scheduled-backup');
  r.post('/api/admin/backup/run-now', auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    const { retain, offsiteDir } = scheduledBackup.settings();
    const out = await scheduledBackup.run({ retain, offsiteDir });
    audit.log({ user: ctx.user, action: 'backup.run_now', ip: ctx.ip, details: { bytes: out.bytes, offsite: out.offsiteOk, verified: out.verified } });
    return { ok: true, file: path.basename(out.file), bytes: out.bytes, offsite_ok: out.offsiteOk, offsite_error: out.offsiteError || null, verified: out.verified, verify_error: out.verifyError || null };
  });

  // Restoring from a backup, without a terminal. INSTALL.md is written for an office manager; telling them
  // to run `node scripts/backup.js --restore` is not a recovery plan.
  function backupFromUpload(ctx) {
    const b64 = (ctx.body && ctx.body.file_b64) || '';
    if (!b64 || typeof b64 !== 'string') throw badRequest('Choose the backup file to upload');
    const raw = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
    return asBadRequest(() => backup.decrypt(raw));
  }
  // server/backup.js speaks in plain Errors (it is shared with the CLI). Everything it can say about a file
  // -- wrong key, damaged, not a SUDS backup, made by a newer SUDS -- is the uploader's answer, not an
  // internal error, so it reaches the page as a 400 with the message rather than "Internal server error".
  function asBadRequest(fn) {
    try { return fn(); }
    catch (e) { if (e instanceof HttpError) throw e; throw badRequest(e.message); }
  }

  // Step 1: say what is in the file. Nothing is changed.
  r.post('/api/admin/restore/preview', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const info = asBadRequest(() => backup.inspect(backupFromUpload(ctx)));
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
    // Refused here, before anything is touched, with the same message the preview gave.
    asBadRequest(() => backup.inspect(plain));
    // Logged before the swap, because afterwards this audit log is the restored file's, not ours.
    audit.log({ user: ctx.user, action: 'backup.restore.start', ip: ctx.ip, details: { bytes: plain.length } });
    const out = backup.restore(plain);
    audit.log({ user: ctx.user, action: 'backup.restore', ip: ctx.ip, details: { clients: out.counts.clients, schema_version: out.schema_version, kept: path.basename(out.previous_database_kept_at) } });
    return { ok: true, ...out, note: 'Everyone will need to sign in again. Devices should sync after this.' };
  });
  r.get('/api/admin/keys-backup', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    if (config.keySource !== 'file') throw badRequest('Keys are provided by the environment on this server');
    audit.log({ user: ctx.user, action: 'keys.download', ip: ctx.ip });
    // Remembered so the dashboard can stop asking — and so an admin can see when it was last done.
    db.setSetting('keys_backup_at', db.now());
    ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="suds-keys-KEEP-SECRET.json"' }); ctx.res.end(fs.readFileSync(config.keysJsonPath));
  });

  // Fictional sample data (safe in production: only when the database has no real clients yet, removable in one click)
  const demo = require('../demo');
  r.get('/api/admin/demo', auth.requireAuth, auth.requirePerm('settings:manage'), () => demo.offer());
  r.post('/api/admin/demo', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const refused = demo.loadRefusal(demo.status());
    if (refused) throw badRequest(refused);
    const out = demo.seed(demo.staffFor(ctx.user));
    audit.log({ user: ctx.user, action: 'demo.load.request', ip: ctx.ip, details: { total: out.total } });
    return out;
  });
  r.delete('/api/admin/demo', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const out = demo.remove({ actor: ctx.user.id });
    audit.log({ user: ctx.user, action: 'demo.remove.request', ip: ctx.ip, details: out });
    return out;
  });
  // Update check only — applying an update is scripts/update.js, a separate CLI tool; a running server
  // cannot safely overwrite the source files it is currently executing from.
  const update = require('../update');
  r.get('/api/admin/update/check', auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    let info;
    try { info = await update.checkForUpdate(); }
    catch (e) { throw badRequest(e.message); }
    if (info.configured) audit.log({ user: ctx.user, action: 'update.check', ip: ctx.ip, details: { current: info.current, latest: info.latest, available: info.available } });
    return info;
  });

  // Local-mode devices (server/devices.js): list, revoke, remote-wipe-on-next-sync, and un-revoke a
  // recovered device. See server/schema.sql's devices table comment for what "wipe" can and cannot reach.
  r.get('/api/admin/devices', auth.requireAuth, auth.requirePerm('users:manage'), () =>
    ({ devices: db.all(`SELECT d.*, u.display_name, u.username FROM devices d JOIN users u ON u.id=d.user_id ORDER BY d.last_seen_at DESC`) }));
  function findDevice(ctx) { const d = db.one(`SELECT * FROM devices WHERE id=?`, ctx.params.id); if (!d) throw notFound(); return d; }
  r.post('/api/admin/devices/:id/revoke', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const d = findDevice(ctx);
    db.run(`UPDATE devices SET revoked_at=?, wipe_requested_at=NULL WHERE id=?`, db.now(), d.id);
    audit.log({ user: ctx.user, action: 'device.revoke', entity: 'device', entityId: d.id, ip: ctx.ip, details: { device_user: d.user_id } });
    return { ok: true };
  });
  r.post('/api/admin/devices/:id/wipe', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const d = findDevice(ctx);
    db.run(`UPDATE devices SET wipe_requested_at=? WHERE id=?`, db.now(), d.id);
    audit.log({ user: ctx.user, action: 'device.wipe.requested', entity: 'device', entityId: d.id, ip: ctx.ip, details: { device_user: d.user_id } });
    return { ok: true };
  });
  r.post('/api/admin/devices/:id/clear', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const d = findDevice(ctx);
    db.run(`UPDATE devices SET revoked_at=NULL, wipe_requested_at=NULL WHERE id=?`, d.id);
    audit.log({ user: ctx.user, action: 'device.clear', entity: 'device', entityId: d.id, ip: ctx.ip, details: { device_user: d.user_id } });
    return { ok: true };
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
    keys_backup_at: db.getSetting('keys_backup_at') || '',
    listener: listener.describe(),
    last_scheduled_backup_at: db.getSetting('last_scheduled_backup_at') || '',
    last_scheduled_backup_status: db.getSetting('last_scheduled_backup_status') || '',
  }));
};
