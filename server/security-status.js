'use strict';
// Settings → Security status: the controls a county IT reviewer asks about, each read from where it is
// actually enforced or recorded — never from a document — with a level (ok / warn / bad / info) and a
// sentence an administrator can act on. Read-only. No PHI: counts, dates, settings and file names.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');

const ROLES = ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'];
const DAY = 86400_000;
const ageDays = (iso) => (iso ? (Date.now() - Date.parse(iso)) / DAY : null);

/** Refuse a combination of identity settings that would lock the programme out, or leave SSO toothless. */
function validateSettings() {
  const { badRequest } = require('./http');
  const pol = auth.policy();
  if (!pol.ssoRequiredSetting) return;
  if (!config.oidc.enabled) throw badRequest('Single sign-on cannot be required until it is configured (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI; docs/DEPLOYMENT.md)');
  if (!pol.ssoEmergencyAccounts.length) throw badRequest('Name at least one emergency (break-glass) administrator account that may still sign in with a password, or an identity-provider outage would lock everyone out');
  for (const u of pol.ssoEmergencyAccounts) {
    const row = db.one(`SELECT role, is_active FROM users WHERE username=?`, u);
    if (!row) throw badRequest(`Emergency account "${u}" does not exist`);
    if (row.role !== 'admin' || !row.is_active) throw badRequest(`Emergency account "${u}" must be an active administrator`);
  }
}

/** Active accounts without two-step verification, with whether their role requires it and by when. */
function mfaReport() {
  const pol = auth.policy();
  const users = db.all(`SELECT id, username, display_name, role, mfa_enabled, created_at, last_login_at, oidc_subject FROM users WHERE is_active=1 ORDER BY display_name`);
  const without = users.filter((u) => !u.mfa_enabled).map((u) => {
    const deadline = auth.mfaDeadline(u);
    return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, required: pol.mfaRequiredRoles.includes(u.role), deadline, overdue: !!deadline && Date.now() > Date.parse(deadline), sso_linked: !!u.oidc_subject, emergency_account: pol.ssoEmergencyAccounts.includes(String(u.username).toLowerCase()), last_login_at: u.last_login_at };
  });
  return { active: users.length, with_mfa: users.length - without.length, coverage_pct: users.length ? Math.round(((users.length - without.length) / users.length) * 1000) / 10 : 100, required_roles: pol.mfaRequiredRoles, require_all: pol.mfaRequireAll, grace_days: pol.mfaGraceDays, without };
}

function lastAudit(action) { return db.one(`SELECT at, details FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action) || null; }
function settingUpdatedAt(key) { const r = db.one(`SELECT updated_at FROM settings WHERE key=?`, key); return r ? r.updated_at : null; }

function status() {
  const items = [];
  const add = (group, name, level, value, detail = '', evidence = '') => items.push({ group, name, level, value, detail, evidence });
  const pol = auth.policy();

  // ---- Identity ----
  const mfa = mfaReport();
  const overdue = mfa.without.filter((u) => u.overdue).length;
  add('Identity', 'Two-step verification coverage', mfa.coverage_pct === 100 ? 'ok' : overdue ? 'bad' : 'warn', `${mfa.coverage_pct}% (${mfa.with_mfa} of ${mfa.active} active accounts)`,
    mfa.without.length ? `${mfa.without.length} without it${overdue ? `, ${overdue} past their enrolment deadline (locked out of everything but enrolment)` : ''} — see "Accounts without two-step verification" below.` : 'Every active account has enrolled.', 'server/auth.js requireAuth, mfaDeadline');
  const allRoles = ROLES.every((r) => pol.mfaRequiredRoles.includes(r));
  add('Identity', 'Two-step verification required for', allRoles ? 'ok' : 'warn', pol.mfaRequireAll ? 'every role (enforced by the "all roles" switch)' : allRoles ? 'every role' : (pol.mfaRequiredRoles.join(', ') || 'no role'),
    `New accounts have ${pol.mfaGraceDays} day${pol.mfaGraceDays === 1 ? '' : 's'} to enrol, then are blocked until they do.${pol.mfaRequireAll ? '' : ' Turn on "Require two-step verification for every role" in Settings to make this explicit.'}`, 'Settings → Security policy; server/auth.js policy()');
  const linked = db.one(`SELECT COUNT(*) n FROM users WHERE is_active=1 AND oidc_subject IS NOT NULL AND oidc_subject <> ''`).n;
  add('Identity', 'Single sign-on (OIDC)', config.oidc.enabled ? 'ok' : 'warn', config.oidc.enabled ? `configured (${config.oidc.issuer.replace(/^https?:\/\//, '')}); ${linked} account${linked === 1 ? '' : 's'} linked` : 'not configured',
    config.oidc.enabled ? '' : 'Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI to sign in through the county identity provider (docs/DEPLOYMENT.md).', 'server/oidc.js, server/routes/oidc.js');
  add('Identity', 'Password sign-in', pol.ssoRequired ? 'ok' : pol.ssoRequiredSetting ? 'bad' : 'info',
    pol.ssoRequired ? `disabled except for emergency account${pol.ssoEmergencyAccounts.length === 1 ? '' : 's'} ${pol.ssoEmergencyAccounts.join(', ')}` : pol.ssoRequiredSetting ? 'SSO is set as required, but OIDC is not configured, so passwords are still accepted' : 'allowed for every account',
    pol.ssoRequired ? 'Every emergency sign-in is audited (auth.login with emergency_account) and logged.' : 'Settings → Security policy → "Require single sign-on" turns password sign-in off for everyone but named break-glass administrators.', 'server/auth.js login()');
  add('Identity', 'Password policy', 'info', `${config.password.minLength}+ characters with upper, lower, digit and symbol; expires after ${pol.passwordMaxAgeDays} days; locked for ${config.lockout.minutes} min after ${config.lockout.maxAttempts} failures`, 'Hashed with scrypt (N=32768).', 'server/auth.js passwordPolicy, server/crypto.js');
  add('Identity', 'Session timeouts', pol.idleMinutes <= 15 ? 'ok' : 'warn', `signed out after ${pol.idleMinutes} min idle; ${pol.absoluteHours} h maximum`, pol.idleMinutes <= 15 ? '' : 'HIPAA automatic logoff: 15 minutes or less is typical.', 'Settings → Security policy; server/auth.js resolveSession');

  // ---- Backups and recovery ----
  const hours = Number(db.getSetting('backup_schedule_hours', '0')) || 0;
  const lastBackup = db.getSetting('last_scheduled_backup_at', null); const lastStatus = db.getSetting('last_scheduled_backup_status', '') || '';
  const stale = hours && (!lastBackup || ageDays(lastBackup) * 24 > 2 * hours);
  const sb = require('./scheduled-backup');
  const sched = sb.settings();
  add('Backups and recovery', 'Scheduled encrypted backups', !hours ? 'bad' : stale || !/^ok/.test(lastStatus) ? 'bad' : 'ok', hours ? `every ${hours} h; last ${lastBackup || 'never'}` : 'off', hours ? lastStatus : `${config.isProd ? 'This is a production server with nothing backing it up. ' : ''}Turn on under Settings → Scheduled backups (every 4 hours is the production default).`, 'server/scheduled-backup.js');
  const lastSnap = db.getSetting('last_snapshot_at', null); const snapStatus = db.getSetting('last_snapshot_status', '') || '';
  const snapStale = sched.minutes && (!lastSnap || ageDays(lastSnap) * 1440 > 3 * sched.minutes);
  add('Backups and recovery', 'Frequent online snapshots', !sched.minutes ? 'info' : snapStale || /^failed/.test(snapStatus) ? 'bad' : 'ok',
    sched.minutes ? `every ${sched.minutes} min to ${sched.offsiteDir ? 'the offsite directory' : 'the local backups directory'}, newest ${sched.snapshotRetain} kept; last ${lastSnap || 'never'}` : 'off',
    sched.minutes ? `${snapStatus}${!sched.offsiteDir ? ' Snapshots stay on this disk until an offsite directory is set.' : ''}` : 'Turn on under Settings → Scheduled backups to bring the recovery point down to minutes (SQLite online backup; measured cost in docs/security/BACKUP-AND-DR.md).', 'server/scheduled-backup.js snapshot');
  const rpo = sb.rpo(sched);
  const rpoTarget = require('./dr-drill').targets().rpo_hours;
  add('Backups and recovery', 'Recovery point objective (worst case)', !rpo ? 'bad' : rpo.minutes > rpoTarget * 60 ? 'warn' : 'ok',
    rpo ? `${rpo.minutes < 120 ? `${rpo.minutes} min` : `${Math.round(rpo.minutes / 6) / 10} h`} (${rpo.by}); target ${rpoTarget < 2 ? `${Math.round(rpoTarget * 60)} min` : `${rpoTarget} h`}` : 'unbounded: nothing is scheduled',
    rpo ? 'A loss just before the next copy runs costs one whole interval. The last recovery drill measures the age of the copy it restored.' : 'With no schedule, everything since the last manual backup would be lost.', 'server/scheduled-backup.js rpo');
  const offsite = db.getSetting('backup_offsite_dir', '') || '';
  add('Backups and recovery', 'Offsite copy', !offsite ? 'warn' : /offsite copy failed/.test(lastStatus) ? 'bad' : 'ok', offsite ? offsite : 'not configured', offsite ? (/offsite copy failed/.test(lastStatus) ? lastStatus : 'Each scheduled backup is copied here after it is verified.') : 'Set an offsite directory (a mounted share on another host or site).', 'server/scheduled-backup.js');
  const drill = require('./dr-drill').lastDrill();
  const drillAge = drill ? ageDays(drill.at) : null;
  add('Backups and recovery', 'Last recovery drill', !drill ? 'bad' : !drill.ok ? 'bad' : drillAge > 95 ? 'warn' : 'ok',
    drill ? `${drill.ok ? 'passed' : 'FAILED'} ${drill.at.slice(0, 10)} — RTO ${drill.rto_seconds ?? '?'} s (target ${drill.rto_target_minutes} min), RPO ${drill.rpo_seconds != null ? Math.round(drill.rpo_seconds / 360) / 10 + ' h' : '?'} (target ${drill.rpo_target_hours} h)` : 'never run',
    drill ? (drill.ok ? `${drill.checks_passed}/${drill.checks_total} checks; restored the ${drill.backup_copy || 'local'} copy with keys from ${drill.keys_source || 'server memory'}; report ${drill.report_file || '(not written)'}.${drill.keys_source && drill.keys_source !== 'server memory' ? '' : ' Run one with the escrowed key file to prove it opens the backups.'}` : (drill.failures || []).join('; ')) : 'Run one from System & backups, or npm run dr-drill.', 'server/dr-drill.js; report in <data>/backups/dr-drill-*.json');
  add('Backups and recovery', 'Monthly recovery drill', db.getSetting('dr_drill_monthly', '0') === '1' ? 'ok' : 'info', db.getSetting('dr_drill_monthly', '0') === '1' ? 'on' : 'off', 'Settings → Scheduled backups.', 'server/dr-drill.js runIfDue');
  add('Backups and recovery', 'Backup encryption key', config.backupKey ? 'ok' : 'info', config.backupKey ? 'separate SUDS_BACKUP_KEY' : 'derived from the PHI encryption key', config.backupKey ? '' : 'Setting SUDS_BACKUP_KEY lets the PHI key rotate without re-keying the backup set.', 'server/backup.js');

  // ---- Audit ----
  const verifiedAt = db.getSetting('audit_verified_at', null); const fullAt = db.getSetting('audit_full_verified_at', null); const failedAt = db.getSetting('audit_verify_failed_at', null);
  add('Audit', 'Audit chain verification', failedAt ? 'bad' : !verifiedAt || ageDays(verifiedAt) > 2 ? 'warn' : 'ok', failedAt ? `FAILED ${failedAt}` : verifiedAt ? `verified ${verifiedAt}${fullAt ? `; last full walk ${fullAt}` : ''}` : 'not yet verified',
    'Hash chain keyed with the index key; verified daily (incremental) and weekly (full).', 'server/audit.js scheduledVerify');
  const ad = require('./audit-anchor').dirStatus();
  const anchors = require('./audit-anchor').list().length;
  const lastAnchor = db.getSetting('audit_anchor_last_at', null); const anchorWrite = db.getSetting('audit_anchor_last_status', '') || '';
  const anchorVerify = db.getSetting('audit_anchor_verify_status', '') || '';
  const placement = require('./audit-anchor').placementProblem();
  add('Audit', 'Audit anchors outside the database', /^failed/.test(anchorWrite) || /^FAILED/.test(anchorVerify) || placement ? 'bad' : !ad.configured || ad.inside_data_dir ? 'warn' : !anchors ? 'warn' : 'ok',
    `${anchors} anchor${anchors === 1 ? '' : 's'} in ${ad.dir}${lastAnchor ? `; last ${lastAnchor}` : ''}${config.auditAnchorHours > 0 ? `; every ${config.auditAnchorHours} h and at each backup` : '; at each backup only'}`,
    [placement || '', anchorVerify ? `Last check: ${anchorVerify}.` : 'Not yet checked (runs with the daily audit verification).', /^failed/.test(anchorWrite) ? `Last write ${anchorWrite}.` : '', placement ? '' : !ad.configured || ad.inside_data_dir ? 'Set AUDIT_ANCHOR_DIR to write-once storage outside the data directory (WORM/immutable share) so a rewrite of the whole data directory is also caught.' : '', config.auditSyslog ? `Also sent to syslog ${config.auditSyslog}.` : ''].filter(Boolean).join(' '), 'server/audit-anchor.js');
  add('Audit', 'Audit retention', 'info', `${Math.round(config.auditRetentionDays / 365 * 10) / 10} years (${config.auditRetentionDays} days)`, (() => { const p = lastAudit('audit.purge'); return p ? `Last purge ${p.at}.` : 'No audit entries old enough to purge yet.'; })(), 'AUDIT_RETENTION_DAYS; server/audit.js purge');

  // ---- Encryption and keys ----
  const keyAt = settingUpdatedAt('key_fingerprint');
  const rotated = lastAudit('security.key_rotated'); const idxRotated = lastAudit('security.index_key_rotated');
  const keyAge = ageDays(rotated ? rotated.at : keyAt);
  add('Encryption and keys', 'PHI encryption key', keyAge !== null && keyAge > 400 ? 'warn' : 'ok', `AES-256-GCM; keys from ${config.keySource === 'env' ? 'the environment / secrets manager' : config.keySource === 'file' ? 'data/keys.json (0600)' : 'development key files in the data directory'}`,
    `${rotated ? `Last rotated ${rotated.at}` : `In use since ${keyAt || 'unknown'}`}${keyAge !== null ? ` (${Math.round(keyAge)} days)` : ''}. Rotate annually: npm run rotate-key.`, 'server/crypto.js; scripts/rotate-key.js');
  try {
    const sk = require('./signing').publicInfo();
    add('Encryption and keys', 'Evidence signing key (Ed25519)', 'ok', `key id ${sk.key_id}; private key in ${config.signingKeySource === 'env' ? 'the environment (SUDS_SIGNING_KEY)' : config.signingKeySource === 'file' ? 'data/keys.json' : config.signingKeySource === 'devfile' ? 'a development key file in the data directory' : 'the test configuration'}, never in the database`,
      'Signs recovery-drill reports and audit-export manifests; anyone with the public key (GET /api/admin/security/signing-key) can verify them: npm run verify-dr-report, npm run verify-audit-export -- --public-key.', 'server/signing.js');
  } catch (e) { add('Encryption and keys', 'Evidence signing key (Ed25519)', 'bad', 'unavailable', String(e.message || e), 'server/signing.js'); }
  add('Encryption and keys', 'Index key (blind indexes, audit chain)', 'info', idxRotated ? `last rotated ${idxRotated.at}` : 'not rotated since install', 'npm run rotate-index-key re-derives the indexes and re-signs the audit chain.', 'scripts/rotate-index-key.js');
  if (config.keySource === 'file') { const kb = db.getSetting('keys_backup_at', null); add('Encryption and keys', 'Key backup', kb ? 'ok' : 'bad', kb ? `downloaded ${kb}` : 'never downloaded', 'Keep it apart from the database backups (a password manager or safe).', 'Settings → System & backups'); }

  // ---- Data lifecycle ----
  const years = (() => { const v = Number(db.getSetting('client_retention_years', '')); return Number.isFinite(v) && v > 0 ? v : config.clientRetentionYears; })();
  const ran = db.getSetting('client_retention_ran_at', null);
  add('Data lifecycle', 'Client record retention', 'info', `${years} years after last activity, then deleted from every table (legal hold exempts)`, ran ? `Retention job last ran ${ran}.` : 'The retention job has not run yet.', 'server/retention.js');

  // ---- Platform ----
  const tls = config.tls.cert ? `served by SUDS (${config.tls.mode === 'selfsigned' ? 'self-signed certificate' : 'certificate from TLS_CERT_PATH'})` : config.trustProxy ? 'terminated by a reverse proxy (TRUST_PROXY)' : 'not configured';
  let certNote = '';
  try { const crt = config.tls.cert || path.join(config.dataDir, 'certs', 'suds.crt'); if (fs.existsSync(crt)) certNote = `Certificate valid until ${new (require('node:crypto').X509Certificate)(fs.readFileSync(crt)).validTo}.`; } catch {}
  add('Platform', 'HTTPS', config.tls.cert || config.trustProxy ? 'ok' : config.isProd ? 'bad' : 'warn', tls, certNote || (config.tls.cert || config.trustProxy ? '' : 'Enable HTTPS under Network & devices, or run behind a TLS proxy.'), 'server/listener.js; Caddyfile');
  add('Platform', 'Local mode (offline copies on devices)', config.localModeEnabled ? 'warn' : 'ok', config.localModeEnabled ? 'on' : 'off', config.localModeEnabled ? `Records are copied to devices${pol.ssoRequired ? '; with SSO required only emergency accounts can sync a device' : ''}. Only for a documented field-work need (docs/PLATFORM.md).` : 'The office server is the only copy.', 'LOCAL_MODE_ENABLED / server.json');
  add('Platform', 'Version', 'info', `SUDS ${config.version}, schema ${db.getSetting('schema_version', '?')}, Node ${process.versions.node}`, config.updateFeedUrl ? 'Update checks are configured (System & backups → Check for updates).' : 'UPDATE_FEED_URL is not set, so this server cannot check for updates itself.', 'package.json; server/update.js');
  add('Platform', 'Monitoring', config.metricsToken || config.logFormat === 'json' ? 'ok' : 'info', [config.metricsToken ? 'Prometheus metrics on' : 'metrics off', `logs ${config.logFormat}`].join('; '), '/api/health answers 503 on a failed audit check, stale backups or an expiring certificate.', 'server/metrics.js, server/log.js, server/routes/app.js');

  const counts = { ok: 0, warn: 0, bad: 0, info: 0 };
  for (const i of items) counts[i.level]++;
  return { generated_at: db.now(), version: config.version, counts, items, mfa, attestation: 'SUDS holds no SOC 2, ISO 27001, HITRUST, StateRAMP or FedRAMP attestation. This page reports the technical controls in this installation; independent attestation requires an auditor (docs/security/SOC2-READINESS.md).' };
}

module.exports = { status, mfaReport, validateSettings };
