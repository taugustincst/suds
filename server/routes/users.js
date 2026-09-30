'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const devices = require('../devices');
const { badRequest, notFound, HttpError } = require('../http');
const { validate } = require('../validate');
const { isKnownPermission, PERMISSION_CATALOG, grantProblem } = require('../permissions');
const { hashPasswordAsync, uuid, randomToken, sha256 } = require('../crypto');
const caseloadDefault = require('../caseload-default');

const ROLES = ['admin', 'supervisor', 'clinician', 'navigator', 'finance', 'readonly'];
const shape = {
  username: { type: 'string', required: true, maxLen: 60, pattern: /^[a-zA-Z0-9._@-]+$/ },
  display_name: { type: 'string', required: true, maxLen: 120 },
  email: { type: 'string', maxLen: 200 },
  title: { type: 'string', maxLen: 120 },
  role: { type: 'string', required: true, enum: ROLES },
  is_active: { type: 'boolean' },
  hourly_cost: { type: 'number', min: 0 },
  password: { type: 'string', maxLen: 500 },
  oidc_subject: { type: 'string', maxLen: 300 },
  // Supervision: who countersigns this person's notes, and whether they need it. Until now these columns
  // existed with no way to set them short of SQL, so the countersignature workflow could never start.
  requires_cosign: { type: 'boolean' },
  supervisor_id: { type: 'string', maxLen: 64 },
  // The fund this person's visits are charged to unless they choose another (blank: the programme's default).
  default_fund_id: { type: 'string', maxLen: 64 },
  // Whether deactivating the account or resetting its password also tells every phone it syncs from to
  // erase itself. On by default: the admin UI shows the checkbox with the device count so it is a choice
  // made knowingly, not a side effect discovered afterwards.
  wipe_devices: { type: 'boolean' },
};

function clientScope(u) {
  const person = { id: u.id, role: u.role };
  if (auth.hasPerm(person, 'clients:read')) {
    if (!auth.caseloadRestricted(person)) return { scope: 'all' };
    const o = db.one(`SELECT reason FROM user_permission_overrides WHERE user_id=? AND permission=? AND mode='deny'`, u.id, caseloadDefault.PERMISSION);
    return { scope: 'caseload', held_by_default: !!o && o.reason === caseloadDefault.REASON };
  }
  return { scope: auth.hasPerm(person, 'clients:list-deidentified') ? 'codes' : auth.caseloadRestricted(person) ? 'caseload' : 'none' };
}

module.exports = (r) => {
  // Directory of active staff (for assignment dropdowns) — minimal fields
  r.get('/api/users', auth.requireAuth, auth.requirePerm('users:read', 'users:manage'), (ctx) => {
    const full = auth.hasPerm(ctx.user, 'users:manage');
    const rows = db.all(full
      // override_count: how many individual permission overrides the person has, for the badge on their row in
      // Users & permissions (the overrides themselves are GET /api/users/:id/permissions). passkey_count: how many
      // passkeys (fingerprint sign-in) they have; GET/DELETE /api/users/:id/passkeys lists and revokes them.
      ? `SELECT id,username,display_name,email,title,role,is_active,mfa_enabled,last_login_at,locked_until,hourly_cost,created_at,oidc_subject,requires_cosign,supervisor_id,access_status,default_fund_id,
          (SELECT COUNT(*) FROM user_permission_overrides o WHERE o.user_id=users.id) AS override_count,
          (SELECT COUNT(*) FROM passkeys p WHERE p.user_id=users.id) AS passkey_count FROM users WHERE access_status<>'pending' ORDER BY display_name`
      : `SELECT id,display_name,title,role,is_active FROM users WHERE is_active=1 ORDER BY display_name`);
    // Which clients each person reaches, for the Clients column of Users & permissions (1.17.0): every client,
    // only their caseload (held_by_default: by the programme default's deny, server/caseload-default.js), client
    // codes only (a de-identified role), or none. Worked out as the request-time checks do (server/auth.js).
    if (full) for (const u of rows) u.client_scope = clientScope(u);
    return { users: rows };
  });

  // ---- What a person still holds: open client assignments and open to-dos ----
  // Deactivating someone ends their sessions but not their caseload, so the administrator is told how much
  // work is still assigned to them (Users -> edit -> Deactivate) and a supervisor is warned when clients sit
  // with an inactive account (Home). Counts and the person's name only: nothing about any client or to-do.
  // "Open" matches what POST /api/caseload/transfer moves (server/routes/episodes.js).
  const caseloadCounts = (userId) => {
    const today = new Date().toISOString().slice(0, 10);
    const where = userId ? 'AND u.id=?' : '';
    const args = userId ? [userId] : [];
    return db.all(`SELECT u.id, u.display_name, u.role, u.is_active,
        (SELECT COUNT(DISTINCT a.client_id) FROM assignments a JOIN clients c ON c.id=a.client_id
          WHERE a.user_id=u.id AND (a.end_date IS NULL OR a.end_date >= ?) AND a.ended_at IS NULL AND c.deleted_at IS NULL) AS clients,
        (SELECT COUNT(*) FROM tasks t LEFT JOIN clients c ON c.id=t.client_id
          WHERE t.assigned_to=u.id AND t.status IN ('open','in_progress') AND (t.client_id IS NULL OR c.deleted_at IS NULL)) AS open_tasks
      FROM users u WHERE 1=1 ${where} ORDER BY u.display_name`, today, ...args);
  };
  const canSeeCaseloads = auth.requirePerm('users:manage', 'assignments:manage');
  // Everyone who holds any open work, active or not. Supervisors need the inactive ones in particular: they
  // are who "Move a caseload" must be able to move clients away from, and GET /api/users (the directory
  // behind every assignment picker) deliberately lists only active staff to them.
  r.get('/api/users/caseloads', auth.requireAuth, canSeeCaseloads, () => {
    const users = caseloadCounts().filter(u => u.clients || u.open_tasks);
    const inactive = users.filter(u => !u.is_active);
    return { users, inactive_clients: inactive.reduce((n, u) => n + u.clients, 0), inactive_tasks: inactive.reduce((n, u) => n + u.open_tasks, 0) };
  });
  r.get('/api/users/:id/caseload', auth.requireAuth, canSeeCaseloads, (ctx) => {
    const [u] = caseloadCounts(ctx.params.id);
    if (!u) throw notFound();
    return u;
  });

  // ---- The programme's least-privilege default (1.17.0, server/caseload-default.js) ----
  // Settings -> Users & permissions: whether new navigators and clinicians start held to their caseload, who the
  // one-off "Apply to existing navigators and clinicians" would change, and that action itself.
  r.get('/api/users/caseload-default', auth.requireAuth, auth.requirePerm('users:manage'), () => {
    const c = caseloadDefault.candidates();
    return { enabled: caseloadDefault.enabled(), reason: caseloadDefault.REASON, roles: caseloadDefault.ROLES,
      // Caseload restriction off (Settings -> Program) means a deny of clients:all limits nobody.
      caseload_restriction: db.getSetting('caseload_restriction', '1') === '1',
      would_change: c.change, kept: c.kept, already_held: c.held };
  });
  r.put('/api/users/caseload-default', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const v = validate(ctx.body || {}, { enabled: { type: 'boolean', required: true } });
    const before = caseloadDefault.enabled();
    db.setSetting(caseloadDefault.SETTING, v.enabled ? '1' : '0');
    audit.log({ user: ctx.user, action: 'settings.caseload_default', ip: ctx.ip, details: { enabled: !!v.enabled, was: before } });
    return { ok: true, enabled: !!v.enabled };
  });
  r.post('/api/users/caseload-default/apply', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const body = ctx.body || {};
    // The accounts the administrator confirmed, by id: exactly those change (if still eligible), never more.
    if (!Array.isArray(body.user_ids) || !body.user_ids.length || body.user_ids.length > 5000 || body.user_ids.some(x => typeof x !== 'string' || x.length > 64)) throw badRequest('user_ids must list the accounts to hold to their caseload, as the confirmation showed them');
    if (body.user_ids.includes(ctx.user.id)) throw badRequest('You cannot change your own permissions');
    const res = caseloadDefault.applyExisting(body.user_ids, { actor: ctx.user, ip: ctx.ip });
    return { ok: true, changed: res.changed.length, skipped: res.skipped.length };
  });

  r.post('/api/users', auth.requireAuth, auth.requirePerm('users:manage'), async (ctx) => {
    const v = validate(ctx.body, shape);
    if (db.one(`SELECT 1 FROM users WHERE username=?`, v.username)) throw badRequest('Username already exists');
    const temp = v.password || (randomToken(10) + 'Aa1!');
    const errs = auth.passwordPolicy(temp);
    if (errs.length) throw badRequest('Password must contain ' + errs.join(', '));
    const id = uuid();
    if (v.supervisor_id && !db.one(`SELECT 1 FROM users WHERE id=? AND role IN ('supervisor','admin')`, v.supervisor_id)) throw badRequest('The supervisor must be a supervisor or administrator account');
    if (v.default_fund_id && !db.one(`SELECT 1 FROM funding_sources WHERE id=? AND is_active=1`, v.default_fund_id)) throw badRequest('The default fund must be an active funding source');
    // scrypt costs ~90 ms: hashed off the event loop, and before the username is checked again below.
    const hash = await hashPasswordAsync(temp);
    if (db.one(`SELECT 1 FROM users WHERE username=?`, v.username)) throw badRequest('Username already exists');
    db.run(`INSERT INTO users(id,username,password_hash,display_name,email,title,role,is_active,hourly_cost,requires_cosign,supervisor_id,default_fund_id,must_change_password,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      id, v.username, hash, v.display_name, v.email || null, v.title || null, v.role, v.is_active ?? 1, v.hourly_cost ?? null, v.requires_cosign ?? 0, v.supervisor_id || null, v.default_fund_id || null, db.now());
    audit.log({ user: ctx.user, action: 'user.create', entity: 'user', entityId: id, ip: ctx.ip, details: { username: v.username, role: v.role } });
    const held = caseloadDefault.holdIfDefault(id, v.role, { actor: ctx.user, ip: ctx.ip, cause: 'created' });
    ctx.status = 201;
    return { id, temporary_password: v.password ? undefined : temp, held_to_caseload: held };
  });

  r.put('/api/users/:id', auth.requireAuth, auth.requirePerm('users:manage'), async (ctx) => {
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.params.id);
    if (!u) throw notFound();
    const v = validate(ctx.body, { ...shape, username: { ...shape.username, required: false }, role: { ...shape.role, required: false }, display_name: { ...shape.display_name, required: false } }, { partial: true });
    // Nobody changes their own role, up or down (security review of 1.15.3, M2: a demoted account that kept a
    // users:manage grant promoted itself back to administrator). Saving one's own profile unchanged is fine.
    if (u.id === ctx.user.id && ((v.role !== undefined && v.role !== u.role) || v.is_active === 0)) throw badRequest('You cannot change your own role or deactivate your own account. Ask another administrator.');
    if (v.oidc_subject && db.one(`SELECT 1 FROM users WHERE oidc_subject=? AND id<>?`, v.oidc_subject, u.id)) throw badRequest('That single sign-on identity is already linked to a different account');
    if (v.supervisor_id && !db.one(`SELECT 1 FROM users WHERE id=? AND id<>? AND role IN ('supervisor','admin')`, v.supervisor_id, u.id)) throw badRequest('The supervisor must be a different supervisor or administrator account');
    if (v.default_fund_id && !db.one(`SELECT 1 FROM funding_sources WHERE id=? AND is_active=1`, v.default_fund_id)) throw badRequest('The default fund must be an active funding source');
    if (v.default_fund_id === '') v.default_fund_id = null;
    const sets = []; const params = [];
    for (const k of ['username', 'display_name', 'email', 'title', 'role', 'is_active', 'hourly_cost', 'oidc_subject', 'requires_cosign', 'supervisor_id', 'default_fund_id']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    if (v.password) {
      const errs = auth.passwordPolicy(v.password);
      if (errs.length) throw badRequest('Password must contain ' + errs.join(', '));
      sets.push('password_hash=?', 'must_change_password=1', 'password_changed_at=?'); params.push(await hashPasswordAsync(v.password), db.now());
      auth.revokeAllForUser(u.id);
    }
    if (ctx.body.unlock) { sets.push('locked_until=NULL', 'failed_attempts=0'); }
    // Re-activating an account whose access request was declined is the administrator changing their mind.
    if (v.is_active === 1 && u.access_status !== 'active') sets.push(`access_status='active'`);
    if (ctx.body.reset_mfa) { sets.push('mfa_enabled=0', 'mfa_secret_enc=NULL'); }
    if (v.is_active === 0) auth.revokeAllForUser(u.id);
    // Their secure referral links that could still be opened are withdrawn (server/referral-links.js).
    if (v.is_active === 0 && u.is_active) require('../referral-links').revokeForUser(u.id, ctx.user);
    // And their passkeys (fingerprint sign-in, docs/FINGERPRINT.md): re-enabling the account later does not bring them
    // back. Resetting their two-step verification or their password takes them too: both are how an administrator
    // recovers an account someone else may have had, and a passkey is a way in and a second factor like the code
    // (each removal audited as auth.passkey.removed with the cause, and the sessions they opened end with them).
    const passkeyCause = v.is_active === 0 ? 'deactivated' : ctx.body.reset_mfa ? 'two-step verification reset' : v.password ? 'password reset' : null;
    const passkeysRemoved = passkeyCause && !require('../config').local ? require('../passkeys').remove(u.id, { actor: ctx.user, ip: ctx.ip, cause: passkeyCause }) : 0;
    // Deactivating someone, or resetting their password from here, ends their hold on client records on
    // every phone they sync from too: each of their devices is told to erase itself at its next sync. The
    // wipe is answered before the credentials are (server/auth.js login()), so an inactive account or an
    // unknown new password does not stop it from arriving.
    let wiped = [];
    const wipeDevices = v.wipe_devices === undefined ? true : !!v.wipe_devices;
    if ((v.is_active === 0 || v.password) && wipeDevices) wiped = devices.requestWipeForUser(u.id, { actor: ctx.user, ip: ctx.ip, reason: v.is_active === 0 ? 'deactivated' : 'password_reset' });
    if (!sets.length) return { ok: true, devices_wiped: wiped.length };
    sets.push('updated_at=?'); params.push(db.now(), u.id);
    db.run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, ...params);
    // A role change takes away the individual grants the new role may not hold (a privileged one after a
    // demotion, clients:read on a de-identified role), each removal audited. auth.effectivePerms ignores such a
    // grant anyway, at every request; removing it keeps Users & permissions from showing a grant that does nothing.
    if (v.role !== undefined && v.role !== u.role) {
      for (const o of db.all(`SELECT permission, mode, reason FROM user_permission_overrides WHERE user_id=? AND mode='grant'`, u.id)) {
        if (!grantProblem(v.role, auth.rolePerms(v.role), o.permission)) continue;
        db.run(`DELETE FROM user_permission_overrides WHERE user_id=? AND permission=?`, u.id, o.permission);
        audit.log({ user: ctx.user, action: 'user.permission.revoke', entity: 'user', entityId: u.id, ip: ctx.ip, details: { permission: o.permission, mode: o.mode, cause: 'role_change', from: u.role, to: v.role } });
      }
    }
    // Into navigator or clinician: the programme's least-privilege default applies as to a new account; out of
    // them, its own deny of clients:all goes (server/caseload-default.js onRoleChange).
    const caseload = v.role !== undefined ? caseloadDefault.onRoleChange(u.id, u.role, v.role, { actor: ctx.user, ip: ctx.ip }) : null;
    audit.log({ user: ctx.user, action: 'user.update', entity: 'user', entityId: u.id, ip: ctx.ip, details: { fields: Object.keys(v).filter(k => k !== 'password'), password_reset: !!v.password, unlock: !!ctx.body.unlock, reset_mfa: !!ctx.body.reset_mfa, devices_wiped: wiped.length, wipe_devices: wipeDevices, passkeys_removed: passkeysRemoved || undefined } });
    return { ok: true, devices_wiped: wiped.length, ...(caseload ? { caseload_default: caseload } : {}) };
  });

  // ---- Per-user permission overrides (admin-managed permissions) ----
  // Effective permissions = role defaults + grants − denies (auth.effectivePerms).
  // Deny always wins, including across wildcards and write-implies-read.
  // The full permission catalog for the grant dropdown and the labels the admin UI shows.
  r.get('/api/permissions/catalog', auth.requireAuth, auth.requirePerm('users:manage'), () => ({ permissions: PERMISSION_CATALOG }));
  r.get('/api/users/:id/permissions', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const target = db.one(`SELECT id, role FROM users WHERE id=?`, ctx.params.id);
    if (!target) throw notFound('User not found');
    const eff = auth.effectivePerms({ id: target.id, role: target.role });
    const overrides = db.all(
      `SELECT permission, mode, reason, granted_by, granted_at FROM user_permission_overrides WHERE user_id=? ORDER BY permission`, target.id);
    // no_effect: a grant this role may not hold (permissions.js grantProblem), left from before 1.15.4 or put in by
    // hand; effectivePerms ignores it, and the list says so rather than showing it as if it worked.
    for (const o of overrides) if (o.mode === 'grant' && grantProblem(target.role, auth.rolePerms(target.role), o.permission)) o.no_effect = true;
    return {
      user_id: target.id,
      role: target.role,
      role_permissions: auth.rolePerms(target.role),
      overrides,
      effective: eff.allow,
      denied: eff.deny,
    };
  });

  // validate() has no string minLen option, so the 10-character reason minimum is enforced explicitly. The reason
  // is bounded (REASON_MAX) and stays with the override: it is for the administrators who read Users &
  // permissions, and the audit log records only its length and SHA-256 (security review of 1.15.3, L2): the words
  // stay out of the hash-chained trail, which cannot be edited if someone puts a client's name in them, and a
  // reason given later can still be checked against the one recorded. It is about the
  // staff member's job, never a client: the form says so.
  const REASON_MIN = 10; const REASON_MAX = 300;
  const reasonProblem = (reason) => (typeof reason !== 'string' || reason.trim().length < REASON_MIN ? `reason must be at least ${REASON_MIN} characters`
    : reason.length > REASON_MAX ? `reason must be at most ${REASON_MAX} characters (say why in a sentence; no client details)` : null);
  const permShape = { permission: { type: 'string', required: true, maxLen: 100 }, mode: { type: 'string', required: true, maxLen: 10 }, reason: { type: 'string', required: true, maxLen: 2000 } };

  r.post('/api/users/:id/permissions', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const v = validate(ctx.body || {}, permShape);
    const fail = (msg, status = 400) => {
      audit.log({ user: ctx.user, action: 'user.permission.denied', entity: 'user', entityId: ctx.params.id, ip: ctx.ip, details: { permission: v.permission, mode: v.mode, reason: msg } });
      if (status === 404) throw notFound(msg);
      throw badRequest(msg);
    };
    if (ctx.params.id === ctx.user.id) return fail('You cannot change your own permissions');
    const target = db.one(`SELECT id, role FROM users WHERE id=?`, ctx.params.id);
    if (!target) return fail('User not found', 404);
    if (v.mode !== 'grant' && v.mode !== 'deny') return fail('mode must be "grant" or "deny"');
    if (!isKnownPermission(v.permission)) return fail(`Unknown permission "${v.permission}"`);
    const bad = reasonProblem(v.reason); if (bad) return fail(bad);
    // What the target's role may be granted at all (permissions.js grantProblem): privileged permissions are an
    // administrator's; a de-identified role is never granted a way to identify clients (M1), nor records:manage-others
    // (1.16.0), which presupposes a role that records client work.
    if (v.mode === 'grant') { const no = grantProblem(target.role, auth.rolePerms(target.role), v.permission); if (no) return fail(no); }
    db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason, granted_by)
            VALUES(?, ?, ?, ?, ?) ON CONFLICT(user_id, permission) DO UPDATE SET mode=excluded.mode, reason=excluded.reason, granted_by=excluded.granted_by, granted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      target.id, v.permission, v.mode, v.reason, ctx.user.id);
    // A deny is audited as a deny, a grant as a grant.
    audit.log({ user: ctx.user, action: v.mode === 'deny' ? 'user.permission.deny' : 'user.permission.grant', entity: 'user', entityId: target.id, ip: ctx.ip, details: { permission: v.permission, mode: v.mode, reason_length: v.reason.length, reason_sha256: sha256(v.reason) } });
    return { ok: true };
  });

  // Revoking an override needs a reason too (the same bounds), in the body: DELETE ... { reason }.
  r.delete('/api/users/:id/permissions/:permission', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    if (ctx.params.id === ctx.user.id) {
      audit.log({ user: ctx.user, action: 'user.permission.denied', entity: 'user', entityId: ctx.params.id, ip: ctx.ip, details: { permission: ctx.params.permission, reason: 'self-edit' } });
      throw badRequest('You cannot change your own permissions');
    }
    const target = db.one(`SELECT id FROM users WHERE id=?`, ctx.params.id);
    if (!target) throw notFound('User not found');
    const row = db.one(`SELECT permission, mode, reason FROM user_permission_overrides WHERE user_id=? AND permission=?`, target.id, ctx.params.permission);
    if (!row) throw notFound('No such override');
    const reason = ctx.body && typeof ctx.body.reason === 'string' ? ctx.body.reason : '';
    const bad = reasonProblem(reason);
    if (bad) throw badRequest(`Say why the override is being revoked: ${bad}`, { fields: { reason: bad } });
    db.run(`DELETE FROM user_permission_overrides WHERE user_id=? AND permission=?`, target.id, ctx.params.permission);
    audit.log({ user: ctx.user, action: 'user.permission.revoke', entity: 'user', entityId: target.id, ip: ctx.ip, details: { permission: row.permission, mode: row.mode, reason_length: String(row.reason || '').length, revoke_reason_length: reason.length, revoke_reason_sha256: sha256(reason) } });
    return { ok: true };
  });

  // ---- Access requests (self sign-up, POST /api/auth/signup) ----
  // Waiting requests, oldest first. The reason is the requester's own words about their job, shown only here.
  r.get('/api/users/access-requests', auth.requireAuth, auth.requirePerm('users:manage'), () =>
    ({ requests: db.all(`SELECT id,username,display_name,email,access_note AS reason,requested_at FROM users WHERE access_status='pending' ORDER BY requested_at, username`) }));
  function pendingRequest(ctx) {
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.params.id);
    if (!u) throw notFound();
    if (u.access_status !== 'pending') throw badRequest('This request has already been answered');
    return u;
  }
  // Approving chooses the role (and optionally a supervisor) and lets the account sign in with the password
  // the person chose. Two-step verification then applies exactly as for any new account: its grace period
  // runs from approval (created_at is reset to it), not from when the request was sent.
  r.post('/api/users/:id/approve', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const u = pendingRequest(ctx);
    const v = validate(ctx.body, { role: shape.role, supervisor_id: shape.supervisor_id, title: shape.title });
    if (v.supervisor_id && !db.one(`SELECT 1 FROM users WHERE id=? AND id<>? AND is_active=1 AND role IN ('supervisor','admin')`, v.supervisor_id, u.id)) throw badRequest('The supervisor must be an active supervisor or administrator account');
    db.run(`UPDATE users SET role=?, supervisor_id=?, title=COALESCE(?, title), is_active=1, access_status='active', failed_attempts=0, locked_until=NULL, created_at=?, updated_at=? WHERE id=?`,
      v.role, v.supervisor_id || null, v.title || null, db.now(), db.now(), u.id);
    audit.log({ user: ctx.user, action: 'user.signup.approved', entity: 'user', entityId: u.id, ip: ctx.ip, details: { username: u.username, role: v.role } });
    const held = caseloadDefault.holdIfDefault(u.id, v.role, { actor: ctx.user, ip: ctx.ip, cause: 'access_request_approved' });
    return { ok: true, held_to_caseload: held };
  });
  r.post('/api/users/:id/decline', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const u = pendingRequest(ctx);
    db.run(`UPDATE users SET access_status='declined', is_active=0, updated_at=? WHERE id=?`, db.now(), u.id);
    audit.log({ user: ctx.user, action: 'user.signup.declined', entity: 'user', entityId: u.id, ip: ctx.ip, details: { username: u.username } });
    return { ok: true };
  });

  // A device that received a wipe instruction (a deviceWipeRequired login response) reports that it has
  // erased itself, presenting the one-time token that response carried. Unauthenticated by design: the
  // phone has just been told its credentials are no longer welcome. The device id alone is not proof of
  // anything — without the token the pending wipe is left in place (server/devices.js ackWipe).
  r.post('/api/devices/wipe-ack', (ctx) => {
    const { device_id, token } = validate(ctx.body, { device_id: { type: 'string', required: true, maxLen: 100 }, token: { type: 'string', required: true, maxLen: 200 } });
    const d = db.one(`SELECT * FROM devices WHERE id=?`, device_id);
    if (!d || !d.wipe_requested_at || !devices.ackWipe(d.id, token)) {
      audit.log({ user: { username: 'device' }, action: 'device.wipe.ack.rejected', entity: 'device', entityId: d ? d.id : null, ip: ctx.ip, success: false });
      throw new HttpError(403, 'This acknowledgement is not valid');
    }
    audit.log({ user: { username: 'device' }, action: 'device.wipe.acknowledged', entity: 'device', entityId: d.id, ip: ctx.ip, details: { device_user: d.user_id } });
    return { ok: true };
  });
};
