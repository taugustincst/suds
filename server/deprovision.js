'use strict';
// Deprovisioning by absence: an account linked to the county identity provider that the provider has not
// vouched for in sso_deprovision_days (no SSO sign-in, no SCIM update leaving it active) is disabled, its
// sessions revoked and its devices revoked with a wipe on their next sync. It covers the leaver whose IdP
// account was removed without anyone telling SUDS, where SCIM is not set up. Off by default (0 days);
// emergency (break-glass) accounts are never touched. Runs daily from housekeeping, or on demand; each
// account disabled is audited, and the report lists what was done and what is coming up.
const config = require('./config');
const db = require('./db');
const audit = require('./audit');

const DAY = 86400_000;
function days() { const v = Number(db.getSetting('sso_deprovision_days', '0')); return Number.isInteger(v) && v > 0 ? v : 0; }
function emergency() { return String(db.getSetting('sso_emergency_accounts', '') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); }
/** Only meaningful where the identity provider can vouch for anyone: OIDC configured, or a live SCIM token. */
function applicable() { return !config.local && (!!(config.oidc && config.oidc.enabled) || !!db.one(`SELECT 1 FROM api_keys WHERE scopes='scim' AND revoked_at IS NULL`)); }

// The last time the provider vouched for the account: the latest SSO/SCIM sighting, else (for an account
// linked before this was recorded) its last sign-in, else its creation.
const SEEN = `COALESCE(idp_seen_at, last_login_at, created_at)`;
function linked() {
  const skip = emergency();
  return db.all(`SELECT id, username, display_name, role, ${SEEN} AS seen_at, oidc_subject IS NOT NULL AS sso, scim_external_id IS NOT NULL AS scim FROM users
    WHERE is_active=1 AND (oidc_subject IS NOT NULL OR scim_external_id IS NOT NULL) ORDER BY ${SEEN}`).filter((u) => !skip.includes(String(u.username).toLowerCase()));
}

/** Disable one account the provider has stopped vouching for. */
function disable(u, { by = { username: 'system' }, n }) {
  let devices = 0;
  db.transaction(() => {
    db.run(`UPDATE users SET is_active=0, updated_at=? WHERE id=? AND is_active=1`, db.now(), u.id);
    devices = require('./scim').cutOff(u.id);
  });
  audit.log({ user: by, action: 'user.deprovisioned', entity: 'user', entityId: u.id, details: { username: u.username, reason: `not seen at the identity provider for ${n} days`, last_seen_at: u.seen_at, devices_revoked: devices } });
}

/** Disable every linked account not seen for the configured number of days. */
function run({ now = Date.now(), by } = {}) {
  const n = days();
  if (!n || !applicable()) return { days: n, disabled: [] };
  const cutoff = now - n * DAY;
  const disabled = [];
  for (const u of linked()) {
    if (Date.parse(u.seen_at) >= cutoff) continue;
    disable(u, { by, n });
    disabled.push({ id: u.id, username: u.username, last_seen_at: u.seen_at });
  }
  if (disabled.length) console.warn(`[suds] deprovisioned ${disabled.length} account(s) not seen at the identity provider for ${n} days`);
  db.setSetting('sso_deprovision_ran_at', db.now());
  return { days: n, disabled };
}
function runIfDue(now = Date.now()) {
  const last = db.getSetting('sso_deprovision_ran_at', null);
  if (last && now - Date.parse(last) < DAY) return null;
  return run({ now });
}

/** The administrator's report: the setting, who is due or coming due, and what was disabled recently. */
function report(now = Date.now()) {
  const n = days();
  const rows = linked().map((u) => ({ ...u, sso: !!u.sso, scim: !!u.scim, days_unseen: Math.floor((now - Date.parse(u.seen_at)) / DAY) }));
  const recent = db.all(`SELECT at, entity_id, details, username AS by_username, action FROM audit_log WHERE action IN ('user.deprovisioned','scim.user.deactivate') AND at >= ? ORDER BY id DESC LIMIT 200`, new Date(now - 90 * DAY).toISOString())
    .map((r) => { let d = {}; try { d = JSON.parse(r.details || '{}'); } catch {} return { at: r.at, user_id: r.entity_id, username: d.username || null, reason: r.action === 'user.deprovisioned' ? d.reason : 'deactivated by the identity provider (SCIM)', by: r.by_username }; });
  return {
    days: n, applicable: applicable(), last_run_at: db.getSetting('sso_deprovision_ran_at', null),
    due: n ? rows.filter((u) => u.days_unseen >= n) : [],
    soon: n ? rows.filter((u) => u.days_unseen < n && u.days_unseen >= n - 7) : [],
    linked_active: rows.length, recent,
  };
}

module.exports = { run, runIfDue, report, days };
