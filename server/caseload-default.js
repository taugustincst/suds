'use strict';
// The programme-wide least-privilege default (1.17.0): "New navigators and clinicians start held to their
// caseload". From 1.16.0 both roles hold clients:all by default (server/auth.js PERMS, the owner's decision);
// a programme that wants least privilege holds a person to their caseload with a per-user deny of clients:all
// (server/auth.js effectivePerms). This setting makes that deny the starting point, so nobody has to remember it:
// every path that makes an account a navigator or a clinician calls holdIfDefault(), which adds the deny with
// the reason REASON, audited per person:
//   - an administrator creates the account (POST /api/users) or changes its role (PUT /api/users/:id);
//   - an access request is approved (POST /api/users/:id/approve);
//   - SCIM provisioning creates the account or changes its role (server/scim.js). Single sign-on never creates
//     an account: it links one SCIM already made (server/routes/oidc.js linkProvisioned), which was held then;
//   - the device administrator of SUDS on this device creates the account (the same POST /api/users) or makes
//     one a navigator or a clinician (PUT /api/local/accounts/:id). A device sign-up (/api/local/signup) is
//     held to its caseload whatever this says (local/kernel.js SIGNUP_SCOPE, stricter: clinical notes too).
// Only clients:all is denied: a navigator keeps reading clinical notes, as the owner decided in 1.16.0 (an
// administrator may deny notes:clinical:read as well, per person). The role's other grants are untouched.
// An individual decision already made for the person (a clients:all grant or deny of their own) is left alone.
// A deny with this reason is the default's own: it goes when the account moves to a role outside navigator and
// clinician (a supervisor or administrator sees every client; finance and read-only never open a record).
// Existing accounts are not changed by turning the setting on; applyExisting() is the administrator's one-off
// "Apply to existing navigators and clinicians", which changes exactly the people the confirmation listed.
// The value is a settings row: '1' on a new install (server/db.js initialise), '0' written once on a database
// that existed before 1.17.0, so an upgrade changes nobody's access silently. No migration.
const db = require('./db');
const audit = require('./audit');

const SETTING = 'caseload_hold_new_staff';
const REASON = 'programme default: held to caseload';
const ROLES = Object.freeze(['navigator', 'clinician']);
const PERMISSION = 'clients:all';

function enabled() { return db.getSetting(SETTING, '0') === '1'; }
function heldRole(role) { return ROLES.includes(role); }
function override(userId) { return db.one(`SELECT mode, reason FROM user_permission_overrides WHERE user_id=? AND permission=?`, userId, PERMISSION); }

function addDeny(userId, { actor, ip, cause, from, to }) {
  db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason, granted_by) VALUES(?,?,'deny',?,?) ON CONFLICT(user_id, permission) DO NOTHING`,
    userId, PERMISSION, REASON, (actor && actor.id) || null);
  // The reason is a fixed sentence (never an administrator's words), so it is recorded as is.
  audit.log({ user: actor, action: 'user.permission.deny', entity: 'user', entityId: userId, ip, details: { permission: PERMISSION, mode: 'deny', cause, reason: REASON, ...(from !== undefined ? { from, to } : {}), ...selfMark(actor, userId) } });
}
// An administrator's change to their own account is audited exactly like one to anyone else's, marked self: true.
const selfMark = (actor, userId) => (actor && actor.id && actor.id === userId ? { self: true } : {});

/**
 * An account has just become a navigator or a clinician (created, approved, provisioned, or its role changed):
 * with the setting on, deny it clients:all unless an individual decision about clients:all is already recorded.
 * Returns true when it added the deny.
 */
function holdIfDefault(userId, role, { actor = null, ip = null, cause = 'created', from, to } = {}) {
  if (!enabled() || !heldRole(role)) return false;
  if (override(userId)) return false;
  addDeny(userId, { actor, ip, cause, from, to });
  return true;
}

/**
 * An account's role changed from `from` to `to`. Into navigator or clinician: holdIfDefault. Out of them: the
 * default's own deny (this reason) goes, audited; an administrator's own deny of clients:all stays.
 * Returns 'held', 'lifted' or null.
 */
function onRoleChange(userId, from, to, { actor = null, ip = null } = {}) {
  if (!to || from === to) return null;
  if (heldRole(to)) return holdIfDefault(userId, to, { actor, ip, cause: 'role_change', from, to }) ? 'held' : null;
  const o = override(userId);
  if (!o || o.mode !== 'deny' || o.reason !== REASON) return null;
  db.run(`DELETE FROM user_permission_overrides WHERE user_id=? AND permission=? AND mode='deny' AND reason=?`, userId, PERMISSION, REASON);
  audit.log({ user: actor, action: 'user.permission.revoke', entity: 'user', entityId: userId, ip, details: { permission: PERMISSION, mode: 'deny', cause: 'role_change', reason: REASON, from, to, ...selfMark(actor, userId) } });
  return 'lifted';
}

/**
 * Who "Apply to existing navigators and clinicians" would change: every navigator and clinician (active or not;
 * not a waiting access request) with no clients:all override of their own. `kept`: those with one already (an
 * administrator's grant of clients:all is a decision this does not overturn; a deny means they are held already).
 */
function candidates() {
  const rows = db.all(`SELECT u.id, u.username, u.display_name, u.role, u.is_active, o.mode AS override_mode, o.reason AS override_reason
    FROM users u LEFT JOIN user_permission_overrides o ON o.user_id=u.id AND o.permission=?
    WHERE u.role IN (${ROLES.map(() => '?').join(',')}) AND u.access_status<>'pending' ORDER BY u.display_name, u.username`, PERMISSION, ...ROLES);
  const pick = ({ id, username, display_name, role, is_active }) => ({ id, username, display_name, role, is_active });
  return {
    change: rows.filter(r => !r.override_mode).map(pick),
    kept: rows.filter(r => r.override_mode === 'grant').map(r => ({ ...pick(r), why: 'granted "See every client" individually' })),
    held: rows.filter(r => r.override_mode === 'deny').length,
  };
}

/**
 * The one-off action: hold the listed people (the confirmation's list) to their caseload. Only those still
 * eligible change, so an account created or granted clients:all since the list was shown is not swept in.
 */
function applyExisting(userIds, { actor, ip }) {
  const wanted = new Set(userIds);
  const eligible = candidates().change.filter(u => wanted.has(u.id));
  db.transaction(() => { for (const u of eligible) addDeny(u.id, { actor, ip, cause: 'applied_to_existing' }); });
  const changed = eligible.map(u => u.id);
  audit.log({ user: actor, action: 'users.caseload_default.applied', ip, details: { changed: changed.length, requested: wanted.size, skipped: wanted.size - changed.length } });
  return { changed, skipped: [...wanted].filter(id => !changed.includes(id)) };
}

module.exports = { SETTING, REASON, ROLES, PERMISSION, enabled, heldRole, holdIfDefault, onRoleChange, candidates, applyExisting };
