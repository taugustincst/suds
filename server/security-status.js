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
  // A passkey with user verification is two-step verification of its own (docs/FINGERPRINT.md; auth.mfaDeadline).
  const without = users.filter((u) => !u.mfa_enabled && !(pol.passkeySignin && auth.passkeyCount(u.id) > 0)).map((u) => {
    const deadline = auth.mfaDeadline(u);
    return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, required: pol.mfaRequiredRoles.includes(u.role), deadline, overdue: !!deadline && Date.now() > Date.parse(deadline), sso_linked: !!u.oidc_subject, emergency_account: pol.ssoEmergencyAccounts.includes(String(u.username).toLowerCase()), last_login_at: u.last_login_at };
  });
  return { active: users.length, with_mfa: users.length - without.length, coverage_pct: users.length ? Math.round(((users.length - without.length) / users.length) * 1000) / 10 : 100, required_roles: pol.mfaRequiredRoles, require_all: pol.mfaRequireAll, grace_days: pol.mfaGraceDays, without };
}

function lastAudit(action) { return db.one(`SELECT at, details FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action) || null; }
function settingUpdatedAt(key) { const r = db.one(`SELECT updated_at FROM settings WHERE key=?`, key); return r ? r.updated_at : null; }

// Where scripts/compliance-check.js writes its signed reports by default (and where this page reads the last).
const complianceDir = () => config.complianceDir || path.join(config.dataDir, 'compliance');

/**
 * The public key a compliance report must verify with: SUDS Server's separate compliance key when the
 * installer configured one (SUDS_COMPLIANCE_PUBLIC_KEY_FILE; its private half is root-only and never given to
 * this service), else this server's own evidence signing key. { pem, source } or { error }.
 */
function complianceKey() {
  if (config.compliancePublicKeyFile) {
    try {
      const pem = fs.readFileSync(config.compliancePublicKeyFile, 'utf8');
      if (!/-----BEGIN PUBLIC KEY-----/.test(pem)) return { error: `${config.compliancePublicKeyFile} is not a PEM public key` };
      return { pem, source: 'compliance' };
    } catch (e) { return { error: `the compliance public key ${config.compliancePublicKeyFile} cannot be read (${e.code || e.message})` }; }
  }
  return { pem: require('./signing').publicInfo().public_key_pem, source: 'service' };
}

/**
 * How "no report yet" counts: a warning on a production server the Linux installer set up (it schedules
 * the check, so a missing report means the timer is not running), information anywhere else (a wizard or
 * Docker install has no host check to run). The installer leaves /etc/suds/suds-server.conf.
 */
function noReportLevel({ isProd = config.isProd, confFile = process.env.SUDS_SERVER_CONF || '/etc/suds/suds-server.conf' } = {}) {
  let installed = false; try { installed = fs.existsSync(confFile); } catch {}
  return isProd && installed ? 'warn' : 'info';
}

/**
 * The newest host compliance report (scripts/compliance-check.js) in the data directory: { file, doc,
 * verification } or null. Its signature is checked against this server's own signing key. The first time
 * the server sees a report it is recorded in the audit log (security.compliance_report.generated), so the
 * log says when each weekly check ran and what it found — the check itself only reads the database.
 */
function hostCompliance({ record = true } = {}) {
  const rep = require('./compliance-report');
  const found = rep.latest(complianceDir());
  if (!found) return null;
  let verification;
  const key = complianceKey();
  try { verification = key.error ? { ok: false, errors: [key.error], warnings: [] } : rep.verifyDoc(found.doc, { publicKeyPem: key.pem }); }
  catch (e) { verification = { ok: false, errors: [String(e.message || e)], warnings: [] }; }
  const r = found.doc && found.doc.report;
  if (record && r && r.report_id && db.getSetting('compliance_report_seen', null) !== r.report_id) {
    db.setSetting('compliance_report_seen', r.report_id);
    try {
      require('./audit').log({ user: { username: 'system' }, action: 'security.compliance_report.generated', entity: 'compliance_report', entityId: r.report_id,
        success: verification.ok && r.summary && r.summary.overall !== 'fail', details: { file: found.file, generated_at: r.generated_at, overall: r.summary && r.summary.overall, counts: r.summary && r.summary.counts, signature: verification.ok ? 'verified' : 'does not verify' } });
    } catch (e) { console.error('[suds] could not audit the compliance report:', e && e.message); }
  }
  verification.key_source = key.source || null;
  return { ...found, verification };
}

function status({ host = true } = {}) {
  const items = [];
  const rules = require('./compliance-rules');
  const add = (group, name, level, value, detail = '', evidence = '') => {
    const c = rules.forItem(name);
    items.push({ group, name, level, value, detail, evidence, check_id: c.id, rules: rules.cite(c.rules) });
  };
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
  if (config.oidc.enabled || db.getSetting('sso_trust_idp_mfa', '0') === '1') {
    const trusted = db.getSetting('sso_trust_idp_mfa', '0') === '1';
    const acr = db.getSetting('sso_mfa_acr_values', '') || '';
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const viaIdp = trusted ? db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='auth.oidc.login' AND at >= ? AND details LIKE '%"mfa":"idp"%'`, since).n : 0;
    add('Identity', "Identity provider's multi-factor sign-in", trusted ? 'info' : 'ok', trusted ? `trusted in place of SUDS two-step verification (amr mfa or two factor kinds such as pwd+otp${acr ? `, or acr ${acr}` : ''}); ${viaIdp} sign-in${viaIdp === 1 ? '' : 's'} in 30 days` : 'not trusted: SSO sign-ins still need the SUDS second factor',
      trusted ? 'A sign-in the provider does not mark as multi-factor still needs the SUDS code. Every trusted sign-in is audited (auth.oidc.login with mfa "idp"). Make sure the provider enforces MFA for this application (conditional access).' : 'Settings → Security policy → "Trust the identity provider\'s multi-factor sign-in" (off by default).', 'server/routes/oidc.js mfaTrust; server/oidc.js idpMfa');
  }
  // Fingerprint sign-in (passkeys, docs/FINGERPRINT.md): adoption, and whether it can work on this server at all.
  if (!config.local) {
    const a = require('./passkeys').adoption();
    const off = !pol.passkeySignin && !pol.passkeySigning;
    const httpsOk = !!config.tls.cert || !!config.trustProxy || !config.isProd;
    // Production refuses passkey options until the relying party is configured (server/passkeys.js relyingParty).
    const rpId = require('./passkeys').configuredRpId();
    const unconfigured = config.isProd && !rpId && !off;
    add('Identity', 'Fingerprint sign-in (passkeys)', unconfigured ? 'bad' : a.flagged ? 'warn' : 'info',
      off ? 'turned off' : unconfigured ? 'not working: WEBAUTHN_RP_ID is not set' : `${a.with_passkey} of ${a.active} active accounts have one (${a.total} passkey${a.total === 1 ? '' : 's'}); ${a.sign_ins_30d} sign-in${a.sign_ins_30d === 1 ? '' : 's'} and ${a.confirmations_30d} signature${a.confirmations_30d === 1 ? '' : 's'} or approval${a.confirmations_30d === 1 ? '' : 's'} with one in 30 days`,
      [a.flagged ? `${a.flagged} passkey${a.flagged === 1 ? ' was' : 's were'} disabled because a signature counter went backwards (a possible copy): see the audit log (auth.passkey.clone_suspected).` : '',
        `Sign-in ${pol.passkeySignin ? 'on' : 'off'}; signatures and approvals ${pol.passkeySigning ? 'on' : 'off'}; fingerprint or authenticator code required for signing: ${pol.signStrongRequired ? 'yes' : 'no'}.`,
        rpId ? `Relying party ${rpId}.` : config.isProd ? 'WEBAUTHN_RP_ID is not set, so no one can add or use a passkey on this production server: set it to the server\'s name, as in the address staff open and on its certificate (docs/SELF-HOSTING.md), and restart.' : 'WEBAUTHN_RP_ID is not set: outside production, passkeys are made for the host name each request was addressed to (the Host header). Production requires it.',
        httpsOk ? '' : 'Passkeys need HTTPS, which is not on.', 'SUDS stores no fingerprint: only each passkey\'s public key.'].filter(Boolean).join(' '), 'server/passkeys.js, server/webauthn.js; Settings → Security policy');
  }
  {
    const dp = require('./deprovision').report();
    const scimTokens = db.one(`SELECT COUNT(*) n FROM api_keys WHERE scopes='scim' AND revoked_at IS NULL`).n;
    add('Identity', 'Deprovisioning', dp.days || scimTokens ? (dp.due.length ? 'warn' : 'ok') : config.oidc.enabled ? 'warn' : 'info',
      [scimTokens ? `SCIM provisioning on (${scimTokens} token${scimTokens === 1 ? '' : 's'})` : 'no SCIM provisioning', dp.days ? `SSO accounts not seen for ${dp.days} days are disabled` : 'accounts not seen at the identity provider are not disabled automatically'].join('; '),
      `${dp.linked_active} active account${dp.linked_active === 1 ? '' : 's'} linked to the identity provider${dp.due.length ? `, ${dp.due.length} due to be disabled at the next daily run` : ''}${dp.recent.length ? `; ${dp.recent.length} disabled in the last 90 days` : ''}. ${dp.days || scimTokens ? '' : 'Create a SCIM token (Provisioning below) or set "Disable single sign-on accounts not seen for (days)".'}`.trim(), 'server/deprovision.js; server/routes/scim.js');
  }
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
  {
    const plain = db.plaintextCopies();
    add('Backups and recovery', 'Unencrypted database copies', plain.length ? 'bad' : 'ok', plain.length ? `${plain.length} not encrypted: ${plain.map((p) => p.file).join(', ')}` : 'none: restore undo copies and pre-migration snapshots are sealed',
      plain.length ? plainCopiesAdvice(plain) : 'A restore\'s undo copy and an upgrade\'s snapshot are encrypted with the backup key as soon as they are no longer needed in plaintext; a failure is retried every hour.', 'server/db.js plaintextCopies, sealPlaintextCopies');
  }
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
  {
    const min = config.AUDIT_RETENTION_MIN_DAYS || 2190;
    const low = config.auditRetentionDaysConfigured != null && config.auditRetentionDaysConfigured < min;
    const p = lastAudit('audit.purge');
    add('Audit', 'Audit retention', low || config.auditRetentionDays < min ? 'bad' : 'ok', `${Math.round(config.auditRetentionDays / 365 * 10) / 10} years (${config.auditRetentionDays} days)`,
      [low ? `AUDIT_RETENTION_DAYS=${config.auditRetentionDaysConfigured} is below the six-year minimum (${min} days, 45 CFR §164.316(b)(2)); SUDS keeps ${config.auditRetentionDays} days instead. Raise or remove the setting.` : '', p ? `Last purge ${p.at}.` : 'No audit entries old enough to purge yet.'].filter(Boolean).join(' '), 'AUDIT_RETENTION_DAYS (minimum 2190); server/config.js; server/audit.js purge');
  }

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
  const ixp = db.indexProblems();
  add('Platform', 'Database indexes', ixp.length ? 'bad' : 'ok', ixp.length ? `${ixp.length} missing: ${ixp.map((x) => x.index).join(', ')}` : 'every index in schema.sql is present',
    ixp.length ? `Could not be created at startup: ${ixp.map((x) => `${x.index} (${x.error})`).join('; ')}. A missing UNIQUE index usually means duplicate rows it would have prevented; resolve them, then restart.` : 'Checked at every start.', 'server/db.js ensureIndexes');
  add('Platform', 'Monitoring', config.metricsToken || config.logFormat === 'json' ? 'ok' : 'info', [config.metricsToken ? 'Prometheus metrics on' : 'metrics off', `logs ${config.logFormat}`].join('; '), '/api/health answers 503 on a failed audit check, stale backups or an expiring certificate.', 'server/metrics.js, server/log.js, server/routes/app.js');

  // ---- Host: the last compliance check (scripts/compliance-check.js, weekly from suds-compliance.timer) ----
  // Host controls (disk encryption, firewall, TLS, time sync, updates) are not visible from inside the
  // process; they are shown as the last signed report found them, with its date, never as current.
  let compliance = null;
  if (host) {
    const hc = hostCompliance();
    const G = 'Host (last compliance check)';
    if (!hc) {
      items.push({ group: G, name: 'Host compliance check', level: noReportLevel(), value: 'no report yet', detail: `No report in ${complianceDir()}. Run npm run compliance-check on the server (deploy/linux/install.sh schedules it weekly: suds-compliance.timer).`, evidence: 'scripts/compliance-check.js', check_id: 'host.report', rules: rules.cite(['hipaa-308a8']) });
    } else {
      const r = hc.doc.report || {};
      const age = ageDays(r.generated_at);
      const signed = hc.verification.ok;
      const overall = (r.summary && r.summary.overall) || 'unknown';
      compliance = { file: hc.file, generated_at: r.generated_at || null, overall, signature_ok: signed, report_id: r.report_id || null };
      items.push({ group: G, name: 'Host compliance check', level: !signed || overall === 'fail' ? 'bad' : age === null || age > 8 || overall !== 'pass' ? 'warn' : 'ok',
        value: `${overall} on ${String(r.generated_at || '?').slice(0, 10)}${age !== null ? ` (${Math.floor(age)} day${Math.floor(age) === 1 ? '' : 's'} ago)` : ''}`,
        detail: [signed ? `The report's Ed25519 signature verifies with ${hc.verification.key_source === 'compliance' ? 'the compliance check\'s own key (root-only; not this service\'s)' : 'this server\'s signing key'}.` : `The report does not verify: ${(hc.verification.errors || []).join('; ')}.`, age !== null && age > 8 ? 'Older than a week: is suds-compliance.timer running?' : '', ...(r.risk_accepted || []).map((x) => `RISK ACCEPTED: ${x}`)].filter(Boolean).join(' '),
        evidence: `compliance/${hc.file}`, check_id: 'host.report', rules: rules.cite(['hipaa-308a8']) });
      if (signed) {
        for (const k of (r.checks || []).filter((x) => String(x.id).startsWith('host.'))) {
          items.push({ group: G, name: k.title, level: rules.levelOfResult(k.result), value: k.result === 'not-checked' ? 'could not check' : k.result === 'pass' ? 'pass' : k.result, detail: [k.evidence, k.result === 'pass' ? '' : k.remediation].filter(Boolean).join(' — '), evidence: `as of ${String(r.generated_at).slice(0, 16).replace('T', ' ')} UTC`, check_id: k.id, rules: k.rules || [] });
        }
      }
    }
  }

  const counts = { ok: 0, warn: 0, bad: 0, info: 0 };
  for (const i of items) counts[i.level]++;
  return { generated_at: db.now(), version: config.version, counts, items, mfa, compliance, attestation: 'SUDS holds no SOC 2, ISO 27001, HITRUST, StateRAMP or FedRAMP attestation. This page reports the technical controls in this installation; independent attestation requires an auditor (docs/security/SOC2-READINESS.md).' };
}

/** What to do about database copies still in plaintext (server/db.js plaintextCopies): one sentence per file. */
function plainCopiesAdvice(plain) {
  return plain.map((p) => `${p.path} (${p.kind === 'restore' ? 'the database as it was before a restore, kept to undo it' : 'a snapshot taken before a schema upgrade'}; since ${p.since}) holds every record unencrypted${p.error ? `; sealing it failed: ${p.error.error}` : ''}.`).join(' ')
    + ' SUDS tries again every hour. Make room on the disk and check that SUDS can write to that folder; the next hourly try (or a restart) then seals it. If it is not needed, delete it securely instead (shred -u, or your platform\'s secure delete).';
}

module.exports = { status, mfaReport, validateSettings, plainCopiesAdvice, hostCompliance, complianceDir, complianceKey, noReportLevel };
