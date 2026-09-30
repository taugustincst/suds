'use strict';
// Provisioned settings: the database settings an installer chooses for a new server (deploy/linux/install.sh
// writes /etc/suds/provision.json and points SUDS_PROVISION_FILE at it). The browser setup wizard does the
// same for a wizard install (server/routes/setup.js applyProductionDefaults); a server configured by its
// environment has no wizard, and without this would start with scheduled backups off.
//
// Applied at every start, but only to a setting that has never been chosen (no row in settings): once an
// administrator changes one under Settings, the file no longer touches it. Only the keys below, each
// checked; anything else in the file is refused by name in the log. Recorded as settings.provisioned.
//
// The file may only TIGHTEN: it runs before anyone has signed in, from a file anyone with root can edit, and
// a value it sets counts as "chosen" from then on. So only the stricter value of each switch is accepted
// (two-step verification required, self sign-up off, the monthly drill on) and backups at least daily; a
// weaker value is refused and never written, and the setting stays at its default for an administrator to
// decide under Settings.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const only = (want) => (v) => v === want;
const KEYS = {
  backup_schedule_hours: (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 && Number(v) <= 24,
  backup_retain_count: (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 1000,
  backup_schedule_minutes: (v) => Number.isInteger(Number(v)) && (Number(v) === 0 || (Number(v) >= 5 && Number(v) <= 1440)),
  // An existing absolute directory, as Settings requires: an unmounted share is an empty mount point.
  backup_offsite_dir: (v) => path.isAbsolute(v) && (() => { try { return fs.statSync(v).isDirectory(); } catch { return false; } })(),
  dr_drill_monthly: only('1'),
  mfa_require_all: only('1'),
  self_signup: only('0'),
};
// Why a value is refused, for the log and the audit entry.
const WEAKER = { backup_schedule_hours: 'backups less often than daily, or off', dr_drill_monthly: 'turns the monthly recovery drill off', mfa_require_all: 'does not require two-step verification', self_signup: 'turns self sign-up on' };

/** Returns { applied: [keys], refused: [{ key, reason }] }. Never throws for a bad file: it logs and carries on. */
function apply({ file = process.env.SUDS_PROVISION_FILE } = {}) {
  const out = { applied: [], refused: [] };
  if (!file) return out;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`[suds] SUDS_PROVISION_FILE ${file} could not be read: ${e.message}`); return out; }
  const settings = doc && typeof doc.settings === 'object' && doc.settings ? doc.settings : {};
  for (const [k, raw] of Object.entries(settings)) {
    const v = raw === null || raw === undefined ? '' : String(raw);
    if (!KEYS[k]) { out.refused.push({ key: k, reason: 'not a setting this file may provision' }); continue; }
    if (!KEYS[k](v)) { out.refused.push({ key: k, reason: k === 'backup_offsite_dir' ? 'invalid value (must be an existing absolute directory: is the share mounted?)' : WEAKER[k] ? `a provisioning file may only tighten a setting: this value ${WEAKER[k]}` : 'invalid value' }); continue; }
    if (db.getSetting(k, null) !== null) continue;
    db.setSetting(k, v);
    out.applied.push(k);
  }
  for (const r of out.refused) console.warn(`[suds] provisioned setting ${r.key} refused: ${r.reason}`);
  if (out.applied.length || out.refused.length) {
    require('./audit').log({ user: { username: 'system' }, action: 'settings.provisioned', success: !out.refused.length, details: { file: path.basename(file), applied: out.applied, refused: out.refused.map((r) => r.key) } });
  }
  if (out.applied.length) console.log(`[suds] provisioned settings applied from ${file}: ${out.applied.join(', ')}`);
  return out;
}

module.exports = { apply, KEYS };
