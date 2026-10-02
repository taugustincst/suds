'use strict';
// The security settings an office server ships with off, unset or merely defaulted, as a checklist an administrator
// can work through (built for 1.24.0): Home's "Finish setting up" card shows the recommended ones not yet done, and
// Settings → Security status lists them all. Every item is computed from the configuration in force, never ticked by
// hand, so it ticks itself off the moment the setting is saved (or the server is restarted with the environment
// variable set) and comes back if someone turns it off again. Office server only (server/routes/security.js, which
// the device kernel leaves out). No PHI: settings, counts of accounts and the compliance report's summary.
const db = require('./db');
const config = require('./config');
const auth = require('./auth');

// The roles whose accounts reach every client, the audit log or the program's settings.
const PRIVILEGED = ['admin', 'supervisor'];
const settingsLink = (section, field) => `#/admin?tab=settings&section=${section}&field=${field}`;

/**
 * Each item: { id, title, why, done, status, recommended, action: { label, href }, where }.
 * `recommended` items appear on Home until done; the others are listed on Security status only (a choice, not a gap).
 * `where` says who changes it: 'settings' (Settings in SUDS) or 'server' (the server's environment, IT's job).
 */
function items() {
  const out = [];
  const pol = auth.policy();
  const add = (x) => out.push({ recommended: true, where: 'settings', ...x });

  // ---- Two-step verification for the privileged roles ----
  {
    const missing = PRIVILEGED.filter((r) => !pol.mfaRequiredRoles.includes(r));
    const rep = require('./security-status').mfaReport();
    const notEnrolled = rep.without.filter((u) => PRIVILEGED.includes(u.role));
    const done = !missing.length && !notEnrolled.length;
    add({ id: 'mfa_privileged', title: 'Require two-step verification for administrators and supervisors', done,
      why: missing.length
        ? `Accounts in the ${missing.join(' and ')} role${missing.length === 1 ? '' : 's'} can reach every client and the program's settings with a password alone. Add ${missing.length === 1 ? 'it' : 'them'} to "Roles that must use MFA" (recommended: every role).`
        : notEnrolled.length
          ? `The policy requires it, but ${notEnrolled.length} administrator or supervisor account${notEnrolled.length === 1 ? ' has' : 's have'} not set up an authenticator app or a passkey yet. Each does it under My profile; the list is on Security status.`
          : 'Required for these roles, and every administrator and supervisor account has enrolled.',
      status: missing.length ? `not required for ${missing.join(', ')}` : notEnrolled.length ? `${notEnrolled.length} not enrolled` : 'required and enrolled',
      action: missing.length ? { label: 'Choose roles', href: settingsLink('security', 'mfa_required_roles') } : { label: 'See who has not enrolled', href: '#/admin?tab=security' } });
  }

  // ---- Backups: scheduled, and copied off this machine ----
  {
    const hours = Number(db.getSetting('backup_schedule_hours', '0')) || 0;
    const offsite = db.getSetting('backup_offsite_dir', '') || '';
    add({ id: 'backups', title: hours ? 'Copy each backup off this server' : 'Turn on scheduled backups', done: !!(hours && offsite),
      why: !hours ? 'Nothing is backing this database up automatically. Set how often (every 4 hours is the production default), and a folder on another machine for a copy.'
        : !offsite ? `Backups run every ${hours} hour${hours === 1 ? '' : 's'}, but only onto this server's own disk: a failed disk or a stolen server takes them with it. Name a mounted network share or drive for a second copy.`
          : `Every ${hours} hour${hours === 1 ? '' : 's'}, with a copy in ${offsite}.`,
      status: !hours ? 'off' : !offsite ? `every ${hours} h, local only` : `every ${hours} h, copied offsite`,
      action: { label: hours ? 'Set the offsite folder' : 'Set up backups', href: settingsLink('backups', hours ? 'backup_offsite_dir' : 'backup_schedule_hours') } });
  }

  // ---- Monthly recovery drill (off by default) ----
  {
    const on = db.getSetting('dr_drill_monthly', '0') === '1';
    // Asked for on Home once backups are scheduled: until then there is nothing to restore, and the backup step comes first.
    const scheduled = (Number(db.getSetting('backup_schedule_hours', '0')) || 0) > 0;
    add({ id: 'dr_drill', title: 'Test a restore every month', done: on, recommended: scheduled,
      why: on ? 'Each month SUDS restores the newest backup into a temporary copy and checks it.' : 'A backup nobody has restored is a hope, not a backup. With the monthly drill on, SUDS restores the newest backup into a temporary copy each month, checks it, and signs a report an auditor can verify.',
      status: on ? 'on' : 'off', action: { label: 'Turn on the monthly drill', href: settingsLink('backups', 'dr_drill_monthly') } });
  }

  // ---- Session idle timeout: confirmed, and no longer than HIPAA's usual 15 minutes ----
  {
    const stored = db.getSetting('session_idle_minutes', null);
    const confirmed = (stored !== null && String(stored).trim() !== '') || !!process.env.SESSION_IDLE_MINUTES;
    const ok = pol.idleMinutes <= 15;
    add({ id: 'session_idle', title: 'Set the automatic sign-out after inactivity', done: confirmed && ok,
      why: !ok ? `Staff are signed out after ${pol.idleMinutes} minutes idle. HIPAA's automatic logoff is usually 15 minutes or less on a shared or field device.`
        : confirmed ? `Signed out after ${pol.idleMinutes} minutes idle, ${pol.absoluteHours} hours at most.`
          : `Staff are signed out after ${pol.idleMinutes} minutes idle, the default nobody has confirmed for this program. Check it fits your policy and save it (15 minutes or less is typical).`,
      status: `${pol.idleMinutes} min${confirmed ? '' : ' (default, not confirmed)'}`,
      action: { label: 'Set the sign-out time', href: settingsLink('security', 'session_idle_minutes') } });
  }

  // ---- A fingerprint or authenticator code to sign and approve (off by default) ----
  {
    const on = !!pol.signStrongRequired;
    add({ id: 'sign_strong', title: 'Require a fingerprint or authenticator code to sign and approve', done: on,
      why: on ? 'Signing a note and approving time or spending need a passkey or an authenticator code, not the password alone.' : 'Today a signature or an approval can be confirmed with the password alone, so a password someone has seen is enough to sign as that person. With this on, it takes a fingerprint (passkey) or an authenticator code.',
      status: on ? 'on' : 'off', action: { label: 'Turn it on', href: settingsLink('security', 'sign_strong_required') } });
  }

  // ---- HTTPS (served by SUDS, or terminated by a proxy SUDS trusts) ----
  {
    const on = !!config.tls.cert || !!config.trustProxy;
    add({ id: 'https', title: 'Serve SUDS over HTTPS', done: on, where: 'server',
      why: on ? (config.tls.cert ? 'SUDS serves HTTPS itself.' : 'A reverse proxy terminates HTTPS (TRUST_PROXY), which also turns on HSTS and secure cookies behind it.')
        : 'Sign-in passwords and client records cross the network unencrypted, and passkeys cannot work. Turn on HTTPS under Network & devices, or put SUDS behind a TLS proxy and set TRUST_PROXY=1.',
      status: on ? (config.tls.cert ? 'served by SUDS' : 'reverse proxy') : 'off', action: { label: 'Open Network & devices', href: '#/admin?tab=network' } });
  }

  // ---- Audit anchors on write-once storage away from the database (AUDIT_ANCHOR_DIR) ----
  {
    const st = require('./audit-anchor').dirStatus();
    const on = st.configured && !st.inside_data_dir;
    add({ id: 'audit_anchor', title: 'Keep the audit log\'s safety copies off the database disk', done: on, where: 'server',
      why: on ? `Anchors are written to ${st.dir}.` : 'SUDS seals copies of the audit log\'s head so a changed or deleted entry is caught, but they sit beside the database, where anyone able to rewrite the records could rewrite them too. Ask IT to set AUDIT_ANCHOR_DIR to write-once (WORM) storage on another disk (docs/security/LOGGING-AND-AUDIT.md).',
      status: on ? 'outside the data directory' : st.configured ? 'inside the data directory' : 'AUDIT_ANCHOR_DIR not set', action: { label: 'Open Security status', href: '#/admin?tab=security' } });
  }

  // ---- Audit retention and sign-in rate limit: on by default; listed so a weakened setting shows ----
  {
    const min = config.AUDIT_RETENTION_MIN_DAYS || 2190;
    const low = config.auditRetentionDaysConfigured != null && config.auditRetentionDaysConfigured < min;
    add({ id: 'audit_retention', title: 'Keep the audit log at least six years', done: !low && config.auditRetentionDays >= min, where: 'server',
      why: low ? `AUDIT_RETENTION_DAYS is set to ${config.auditRetentionDaysConfigured}, below HIPAA's six-year minimum; SUDS keeps ${config.auditRetentionDays} days instead. Ask IT to raise or remove the setting.` : `Audit entries are kept ${config.auditRetentionDays} days (45 CFR §164.316(b)(2) asks for six years).`,
      status: `${config.auditRetentionDays} days`, action: { label: 'Open Security status', href: '#/admin?tab=security' } });
    const lim = config.loginRateLimit;
    const sane = Number.isFinite(lim) && lim > 0 && lim <= 100;
    add({ id: 'login_rate_limit', title: 'Limit sign-in attempts', done: sane, where: 'server',
      why: sane ? `${lim} sign-in attempts per address per 15 minutes, and an account locks for ${config.lockout.minutes} minutes after ${config.lockout.maxAttempts} wrong passwords.` : `LOGIN_RATE_LIMIT is ${lim}, which lets one address guess passwords far faster than an office needs. Ask IT to set it to 20 (the default), or up to 100 for a large office behind one address.`,
      status: `${lim} per 15 min`, action: { label: 'Open Security status', href: '#/admin?tab=security' } });
  }

  // ---- The weekly host compliance check (SUDS Server: suds-compliance.timer) ----
  {
    const ss = require('./security-status');
    let hc = null; try { hc = ss.hostCompliance(); } catch { hc = null; }
    const installed = ss.noReportLevel() === 'warn';
    if (!hc) {
      add({ id: 'compliance_check', title: 'Run the weekly host compliance check', done: false, where: 'server', recommended: installed,
        why: installed ? 'SUDS Server schedules a weekly check of this machine (disk encryption, firewall, TLS, time, updates), but no report has arrived: is suds-compliance.timer running?' : 'A weekly check of the machine itself (disk encryption, firewall, TLS, time, updates) runs with SUDS Server, or by hand with npm run compliance-check. No report has been found yet.',
        status: 'no report yet', compliance: null, action: { label: 'Open Security status', href: '#/admin?tab=security' } });
    } else {
      const r = (hc.doc && hc.doc.report) || {};
      const overall = (r.summary && r.summary.overall) || 'unknown';
      const age = r.generated_at ? Math.floor((Date.now() - Date.parse(r.generated_at)) / 86400_000) : null;
      const signed = !!hc.verification.ok;
      const fresh = age !== null && age <= 8;
      add({ id: 'compliance_check', title: 'Pass the weekly host compliance check', done: signed && overall === 'pass' && fresh, where: 'server',
        why: !signed ? 'The last compliance report\'s signature does not verify. Look at it on Security status before relying on it.'
          : overall !== 'pass' ? `The last check (${String(r.generated_at).slice(0, 10)}) found ${overall === 'fail' ? 'failures' : 'items needing attention'} on this machine. Each is listed, with how to fix it, under "Host (last compliance check)" on Security status.`
            : !fresh ? `The last report is ${age} days old: the check should run weekly (suds-compliance.timer).` : `Passed on ${String(r.generated_at).slice(0, 10)}.`,
        status: `${overall} on ${String(r.generated_at || '?').slice(0, 10)}${signed ? '' : ' (signature does not verify)'}`,
        compliance: { overall, generated_at: r.generated_at || null, signature_ok: signed, counts: (r.summary && r.summary.counts) || null },
        action: { label: 'See the findings', href: '#/admin?tab=security' } });
    }
  }

  // ---- Choices worth knowing about, not gaps: shown on Security status only ----
  {
    const al = require('./passkeys').allowlist.status();
    add({ id: 'passkey_allowlist', title: 'Accept passkeys only from listed authenticator models', done: !!al.enabled, recommended: false,
      why: al.enabled ? `On: ${al.models.length} model${al.models.length === 1 ? '' : 's'} accepted.` : 'Off: any authenticator may hold a passkey. A program with managed devices can accept only the models it issues, each proven against the FIDO Metadata Service.',
      status: al.enabled ? 'on' : 'off', action: { label: 'Open the allow-list', href: '#/admin?tab=settings' } });
    const sso = auth.policy().ssoRequired;
    add({ id: 'sso_required', title: 'Sign in through the county identity provider', done: !!sso, recommended: false,
      why: sso ? 'Password sign-in is off except for the emergency accounts.' : config.oidc.enabled ? 'Single sign-on is configured but not required, so leavers keep their SUDS password until someone disables the account.' : 'Single sign-on is not configured (OIDC_* settings, docs/DEPLOYMENT.md). With it, leavers are cut off at the county\'s identity provider.',
      status: sso ? 'required' : config.oidc.enabled ? 'configured, not required' : 'not configured', action: { label: 'Open single sign-on settings', href: settingsLink('sso', 'sso_required') } });
  }
  return out;
}

function summary() {
  const all = items();
  return { items: all, open: all.filter((i) => i.recommended && !i.done).length, done: all.filter((i) => i.done).length, total: all.length };
}

module.exports = { items, summary, PRIVILEGED };
