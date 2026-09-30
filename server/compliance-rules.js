'use strict';
// The one list of compliance checks, and the rules each maps to. Used by Settings → Security status
// (server/security-status.js: every app-level line carries its check id and rules) and by the host
// compliance check (scripts/compliance-check.js: the same app-level lines, plus the host checks below). A
// check is defined here once; neither side keeps its own copy of the mapping.
//
// Pure data, no requires: the offline report verifier and the browser kernel can load it.
//
// The citations are to the regulation's standard and, where there is one, its implementation specification
// ((R) required, (A) addressable). A mapping says which rule a check produces evidence for; it is not a
// statement that passing the check satisfies the rule (docs/SELF-HOSTING.md, "Compliance boundary").

const RULES = {
  'hipaa-308a1iiA': { cite: '45 CFR §164.308(a)(1)(ii)(A)', title: 'Risk analysis (R)' },
  'hipaa-308a1iiB': { cite: '45 CFR §164.308(a)(1)(ii)(B)', title: 'Risk management (R)' },
  'hipaa-308a1iiD': { cite: '45 CFR §164.308(a)(1)(ii)(D)', title: 'Information system activity review (R)' },
  'hipaa-308a3iiC': { cite: '45 CFR §164.308(a)(3)(ii)(C)', title: 'Termination procedures (A)' },
  'hipaa-308a4iiC': { cite: '45 CFR §164.308(a)(4)(ii)(C)', title: 'Access establishment and modification (A)' },
  'hipaa-308a5iiB': { cite: '45 CFR §164.308(a)(5)(ii)(B)', title: 'Protection from malicious software (A)' },
  'hipaa-308a5iiD': { cite: '45 CFR §164.308(a)(5)(ii)(D)', title: 'Password management (A)' },
  'hipaa-308a7iiA': { cite: '45 CFR §164.308(a)(7)(ii)(A)', title: 'Data backup plan (R)' },
  'hipaa-308a7iiB': { cite: '45 CFR §164.308(a)(7)(ii)(B)', title: 'Disaster recovery plan (R)' },
  'hipaa-308a7iiD': { cite: '45 CFR §164.308(a)(7)(ii)(D)', title: 'Testing and revision procedures (A)' },
  'hipaa-308a8': { cite: '45 CFR §164.308(a)(8)', title: 'Evaluation (R)' },
  'hipaa-310d1': { cite: '45 CFR §164.310(d)(1)', title: 'Device and media controls' },
  'hipaa-310d2iv': { cite: '45 CFR §164.310(d)(2)(iv)', title: 'Data backup and storage (A)' },
  'hipaa-312a1': { cite: '45 CFR §164.312(a)(1)', title: 'Access control' },
  'hipaa-312a2i': { cite: '45 CFR §164.312(a)(2)(i)', title: 'Unique user identification (R)' },
  'hipaa-312a2iii': { cite: '45 CFR §164.312(a)(2)(iii)', title: 'Automatic logoff (A)' },
  'hipaa-312a2iv': { cite: '45 CFR §164.312(a)(2)(iv)', title: 'Encryption and decryption (A)' },
  'hipaa-312b': { cite: '45 CFR §164.312(b)', title: 'Audit controls' },
  'hipaa-312c1': { cite: '45 CFR §164.312(c)(1)', title: 'Integrity' },
  'hipaa-312c2': { cite: '45 CFR §164.312(c)(2)', title: 'Mechanism to authenticate electronic PHI (A)' },
  'hipaa-312d': { cite: '45 CFR §164.312(d)', title: 'Person or entity authentication' },
  'hipaa-312e1': { cite: '45 CFR §164.312(e)(1)', title: 'Transmission security' },
  'hipaa-312e2ii': { cite: '45 CFR §164.312(e)(2)(ii)', title: 'Encryption in transmission (A)' },
  'hipaa-316b2i': { cite: '45 CFR §164.316(b)(2)(i)', title: 'Documentation time limit (six years)' },
  'part2-16a2i': { cite: '42 CFR §2.16(a)(2)(i)', title: 'Electronic records: creating, receiving, maintaining and transmitting' },
  'part2-16a2ii': { cite: '42 CFR §2.16(a)(2)(ii)', title: 'Electronic records: destroying, and sanitising media' },
  'part2-16a2iii': { cite: '42 CFR §2.16(a)(2)(iii)', title: 'Electronic records: using and accessing' },
  'cmia-56101a': { cite: 'Cal. Civ. Code §56.101(a)', title: 'Preserve confidentiality in creating, maintaining, storing and destroying medical information' },
  'cmia-56101b1A': { cite: 'Cal. Civ. Code §56.101(b)(1)(A)', title: 'Electronic record system protects and preserves integrity' },
  'cmia-56101b1B': { cite: 'Cal. Civ. Code §56.101(b)(1)(B)', title: 'Electronic record system records every change or deletion' },
};

// Checks on the host, made by scripts/compliance-check.js only (Security status shows their last result).
const HOST_CHECKS = [
  { id: 'host.os', title: 'Supported operating system', rules: ['hipaa-308a1iiB'], remediation: 'Run SUDS Server on Ubuntu 24.04 LTS or RHEL/Rocky/Alma 9, which receive security updates and which the installer supports.' },
  { id: 'host.data_dir', title: 'Data directory and database file permissions', rules: ['hipaa-312a1', 'part2-16a2iii', 'cmia-56101a'], remediation: 'chown -R suds:suds /var/lib/suds; chmod 0700 /var/lib/suds; chmod 0600 /var/lib/suds/suds.db* (deploy/linux/install.sh does this).' },
  { id: 'host.disk_encryption', title: 'Data on an encrypted block device', rules: ['hipaa-312a2iv', 'hipaa-310d1', 'part2-16a2i', 'cmia-56101a'], remediation: 'Put the data directory on a LUKS (dm-crypt) volume. This cannot be done in place: attach a new encrypted disk, stop SUDS, move /var/lib/suds onto it and start SUDS again (docs/SELF-HOSTING.md, "Prerequisites").' },
  { id: 'host.keys', title: 'Keys kept out of readable files and the environment', rules: ['hipaa-312a2iv', 'hipaa-312a1'], remediation: 'Keep each key in /etc/suds/credentials/<name> (root, 0600, directory 0700) loaded with LoadCredential= (deploy/linux/suds.service); remove any SUDS_*_KEY from Environment= and from environment files.' },
  { id: 'host.service', title: 'Service sandboxing (systemd unit)', rules: ['hipaa-312a1', 'hipaa-308a1iiB'], remediation: 'Install deploy/linux/suds.service unchanged (deploy/linux/install.sh) and keep local changes in a drop-in that does not weaken it.' },
  { id: 'host.tls', title: 'HTTPS: TLS 1.2 or newer, valid certificate, HSTS', rules: ['hipaa-312e1', 'hipaa-312e2ii', 'part2-16a2i'], remediation: 'Terminate TLS with Caddy (the repository\'s Caddyfile, installed as /etc/caddy/Caddyfile: TLS 1.2+ only, HSTS) or a county certificate; renew the certificate before it has 14 days left.' },
  { id: 'host.http_redirect', title: 'Plain HTTP only redirects to HTTPS', rules: ['hipaa-312e1'], remediation: 'Serve nothing but a redirect (and ACME challenges) on port 80; close it when the certificate is county-issued.' },
  { id: 'host.bind', title: 'SUDS listens on this machine only (127.0.0.1)', rules: ['hipaa-312e1', 'hipaa-312a1'], remediation: 'Set HOST=127.0.0.1 in the unit (deploy/linux/suds.service) so only the TLS proxy on this host can reach SUDS.' },
  { id: 'host.firewall', title: 'Host firewall active with only the expected ports', rules: ['hipaa-312e1', 'hipaa-308a1iiB'], remediation: 'ufw (Ubuntu) or firewalld (RHEL): deny incoming by default, allow 443 (and 80 while it only redirects), SSH only from the administration network (deploy/linux/install.sh --admin-cidr).' },
  { id: 'host.time_sync', title: 'Clock synchronised (audit timestamps)', rules: ['hipaa-312b', 'cmia-56101b1B'], remediation: 'Enable chrony (RHEL) or systemd-timesyncd/chrony (Ubuntu) against the county time source: timedatectl set-ntp true.' },
  { id: 'host.security_updates', title: 'Automatic security updates', rules: ['hipaa-308a5iiB', 'hipaa-308a1iiB'], remediation: 'Ubuntu: unattended-upgrades with the -security origin and apt-daily-upgrade.timer; RHEL: dnf-automatic with upgrade_type = security, apply_updates = yes and dnf-automatic.timer (as deploy/linux/install.sh sets it).' },
  { id: 'host.journald', title: 'System journal persistent and retained', rules: ['hipaa-312b', 'hipaa-308a1iiD'], remediation: 'Storage=persistent and MaxRetentionSec at least the log retention policy (default 400 days) in /etc/systemd/journald.conf.d/suds.conf; forward to the county SIEM for longer.' },
  { id: 'host.auditd', title: 'Linux audit daemon (recommended)', rules: ['hipaa-312b', 'hipaa-308a1iiD'], remediation: 'Recommended, not required: install and enable auditd so logins, sudo and changes to /etc/suds are recorded by the OS as well.' },
  { id: 'host.node', title: 'Node.js is the pinned, checksum-verified release', rules: ['hipaa-308a1iiB'], remediation: 'Install the release pinned in deploy/linux/pins (the one CI tests) with deploy/linux/install.sh or upgrade.sh.' },
  { id: 'host.suds_version', title: 'SUDS release is supported', rules: ['hipaa-308a1iiB', 'hipaa-308a5iiB'], remediation: 'Upgrade to the latest minor release (docs/RELEASE.md, "Supported versions") with deploy/linux/upgrade.sh.' },
  { id: 'host.release_integrity', title: 'SUDS release checked against an independently published checksum', rules: ['hipaa-308a1iiB', 'hipaa-308a5iiB'], remediation: 'Upgrade with --release-sha256=<hex> taken from a channel other than the download: the SHA-256 published in the GitHub Release notes and recorded in that version\'s CHANGELOG section on the main branch, which must agree (not at the release tag: the zip is built from the tagged commit, so its checksum is added after it; docs/SELF-HOSTING.md, Upgrading). Not --trust-release-checksum.' },
  { id: 'host.backup_files', title: 'Latest backup is recent and the offsite copy exists', rules: ['hipaa-308a7iiA', 'hipaa-310d2iv'], remediation: 'Scheduled backups (Settings → Scheduled backups) with the offsite directory on the mounted offsite share; check the share is mounted.' },
  { id: 'host.dr_evidence', title: 'Recovery drill within 90 days, signed report verifies', rules: ['hipaa-308a7iiD', 'hipaa-308a7iiB'], remediation: 'Run a recovery drill with the escrowed key file against the offsite copy (Settings → System & backups, or npm run dr-drill); turn the monthly drill on.' },
  { id: 'host.audit_verify', title: 'Audit chain and external anchors verify now', rules: ['hipaa-312b', 'hipaa-312c1', 'hipaa-312c2', 'cmia-56101b1B', 'part2-16a2iii'], remediation: 'A failure is a possible incident: follow docs/security/INCIDENT-RESPONSE.md. "Could not check" means the check ran without the index key (run it as root, or from suds-compliance.service).' },
];

// Settings → Security status lines (server/security-status.js), by name. Every line status() produces must
// be here (test/compliance-check.test.js checks it). `info` says how an "info" line counts in the compliance
// report: 'pass' when info means "as designed", 'warn' when it means "a recommended setting is off".
const APP_CHECKS = [
  { id: 'app.mfa_coverage', item: 'Two-step verification coverage', rules: ['hipaa-312d', 'hipaa-308a5iiD'], remediation: 'Have every active account enrol in two-step verification (Settings → Security status lists who has not).' },
  { id: 'app.mfa_required', item: 'Two-step verification required for', rules: ['hipaa-312d'], remediation: 'Settings → Security policy → "Require two-step verification for every role" (or MFA_REQUIRED_ROLES naming every role).' },
  { id: 'app.sso', item: 'Single sign-on (OIDC)', rules: ['hipaa-312a2i', 'hipaa-308a3iiC'], remediation: 'Configure OIDC against the county identity provider (docs/DEPLOYMENT.md, "Single sign-on").' },
  { id: 'app.idp_mfa', item: "Identity provider's multi-factor sign-in", rules: ['hipaa-312d'], info: 'pass', remediation: 'Trust the provider\'s MFA only where it enforces MFA for this application (conditional access).' },
  { id: 'app.deprovisioning', item: 'Deprovisioning', rules: ['hipaa-308a3iiC', 'hipaa-308a4iiC'], info: 'warn', remediation: 'Create a SCIM token or set "Disable single sign-on accounts not seen for (days)".' },
  { id: 'app.passkeys', item: 'Fingerprint sign-in (passkeys)', rules: ['hipaa-312d'], info: 'pass', remediation: 'Optional: staff add a passkey under My profile → Fingerprint sign-in (needs HTTPS and WEBAUTHN_RP_ID matching the server\'s name, docs/FINGERPRINT.md).' },
  { id: 'app.password_signin', item: 'Password sign-in', rules: ['hipaa-312d'], info: 'pass', remediation: 'Settings → Security policy → "Require single sign-on" with named break-glass administrators.' },
  { id: 'app.password_policy', item: 'Password policy', rules: ['hipaa-308a5iiD'], info: 'pass', remediation: 'Enforced in code (server/auth.js); nothing to configure.' },
  { id: 'app.session_timeout', item: 'Session timeouts', rules: ['hipaa-312a2iii'], remediation: 'Settings → Security policy: idle timeout 15 minutes or less.' },
  { id: 'app.backups', item: 'Scheduled encrypted backups', rules: ['hipaa-308a7iiA', 'hipaa-310d2iv'], remediation: 'Settings → Scheduled backups: every 4 hours or less.' },
  { id: 'app.snapshots', item: 'Frequent online snapshots', rules: ['hipaa-308a7iiA'], info: 'pass', remediation: 'Optional: Settings → Scheduled backups → "Also snapshot every (minutes)" for a recovery point in minutes.' },
  { id: 'app.rpo', item: 'Recovery point objective (worst case)', rules: ['hipaa-308a7iiA', 'hipaa-308a7iiB'], remediation: 'Shorten the backup interval, or add snapshots, until the worst case is within the target.' },
  { id: 'app.offsite', item: 'Offsite copy', rules: ['hipaa-308a7iiA', 'hipaa-310d2iv'], remediation: 'Set the offsite directory to the mounted offsite share (Settings → Scheduled backups).' },
  { id: 'app.dr_drill', item: 'Last recovery drill', rules: ['hipaa-308a7iiD', 'hipaa-308a7iiB'], remediation: 'Run a recovery drill (Settings → System & backups).' },
  { id: 'app.dr_monthly', item: 'Monthly recovery drill', rules: ['hipaa-308a7iiD'], info: 'warn', remediation: 'Settings → Scheduled backups → "Recovery drill every month".' },
  { id: 'app.plaintext_copies', item: 'Unencrypted database copies', rules: ['hipaa-312a2iv', 'part2-16a2ii'], remediation: 'Free disk space so SUDS can seal them, or delete them securely.' },
  { id: 'app.backup_key', item: 'Backup encryption key', rules: ['hipaa-312a2iv', 'hipaa-308a7iiA'], info: 'warn', remediation: 'Set SUDS_BACKUP_KEY (deploy/linux/install.sh generates it) so the PHI key can rotate without re-keying the backups.' },
  { id: 'app.audit_chain', item: 'Audit chain verification', rules: ['hipaa-312b', 'hipaa-312c1', 'cmia-56101b1B'], remediation: 'A failure is a possible incident (docs/security/INCIDENT-RESPONSE.md).' },
  { id: 'app.audit_anchors', item: 'Audit anchors outside the database', rules: ['hipaa-312b', 'hipaa-312c2', 'cmia-56101b1A'], remediation: 'AUDIT_ANCHOR_DIR on write-once storage outside the data directory (install.sh --anchors).' },
  { id: 'app.audit_retention', item: 'Audit retention', rules: ['hipaa-316b2i', 'hipaa-312b'], remediation: 'Remove AUDIT_RETENTION_DAYS or set it to 2190 or more.' },
  { id: 'app.phi_key', item: 'PHI encryption key', rules: ['hipaa-312a2iv', 'part2-16a2i', 'cmia-56101a'], remediation: 'Rotate annually (npm run rotate-key) and keep the key in the credential store.' },
  { id: 'app.signing_key', item: 'Evidence signing key (Ed25519)', rules: ['hipaa-312c2'], remediation: 'Provide SUDS_SIGNING_KEY (install.sh generates it) and give its public key to the auditor.' },
  { id: 'app.index_key', item: 'Index key (blind indexes, audit chain)', rules: ['hipaa-312c1'], info: 'pass', remediation: 'Rotate on custodian change or suspected exposure (npm run rotate-index-key).' },
  { id: 'app.key_backup', item: 'Key backup', rules: ['hipaa-308a7iiA'], remediation: 'Download the key backup (Settings → System & backups) and keep it apart from the database backups.' },
  { id: 'app.client_retention', item: 'Client record retention', rules: ['part2-16a2ii', 'cmia-56101a'], info: 'pass', remediation: 'Set the retention period the programme\'s policy requires (never below 6 years).' },
  { id: 'app.https', item: 'HTTPS', rules: ['hipaa-312e1', 'hipaa-312e2ii'], remediation: 'Run behind the TLS proxy with TRUST_PROXY=1, or give SUDS a certificate.' },
  { id: 'app.local_mode', item: 'Local mode (offline copies on devices)', rules: ['hipaa-310d1', 'hipaa-312a1'], remediation: 'Leave LOCAL_MODE_ENABLED off unless a field-work need is documented (docs/PLATFORM.md).' },
  { id: 'app.version', item: 'Version', rules: ['hipaa-308a1iiB'], info: 'pass', remediation: 'See host.suds_version.' },
  { id: 'app.db_indexes', item: 'Database indexes', rules: ['hipaa-312c1'], inAppOnly: true, remediation: 'Resolve the duplicate rows named, then restart.' },
  { id: 'app.monitoring', item: 'Monitoring', rules: ['hipaa-308a1iiD'], info: 'pass', remediation: 'Point the county monitoring at /api/health; set METRICS_TOKEN for Prometheus.' },
];

const byItem = new Map(APP_CHECKS.map((c) => [c.item, c]));
const byId = new Map([...HOST_CHECKS, ...APP_CHECKS].map((c) => [c.id, c]));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** The catalogue entry for a Security status line; a line not in the catalogue still gets an id (and no rules). */
function forItem(name) { return byItem.get(name) || { id: `app.other.${slug(name)}`, item: name, rules: [], remediation: '' }; }
/** The citations for rule keys, for display: [{ key, cite, title }]. */
function cite(keys) { return (keys || []).filter((k) => RULES[k]).map((k) => ({ key: k, ...RULES[k] })); }

/** Security status level → compliance result. "info" counts as the entry says; nothing unknown is a pass. */
function resultOfLevel(level, entry) {
  if (level === 'ok') return 'pass';
  if (level === 'bad') return 'fail';
  if (level === 'warn') return 'warn';
  if (level === 'info') return (entry && entry.info) || 'warn';
  return 'not-checked';
}
/** Compliance result → Security status level (for the host lines Security status shows). */
function levelOfResult(result) { return result === 'pass' ? 'ok' : result === 'fail' ? 'bad' : 'warn'; }

// What a new server's first backup or recovery drill that has not run yet reads as, for a bounded time after it
// was scheduled: a warning, on every surface (Security status, the compliance report, /api/health).
const PENDING_FIRST_RUN = 'pending first run (expected on day one)';

module.exports = { RULES, HOST_CHECKS, APP_CHECKS, forItem, cite, byId, resultOfLevel, levelOfResult, PENDING_FIRST_RUN, RESULTS: ['pass', 'fail', 'warn', 'not-checked'] };
