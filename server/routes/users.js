'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const devices = require('../devices');
const { badRequest, notFound, HttpError } = require('../http');
const { validate } = require('../validate');
const { hashPassword, uuid, randomToken } = require('../crypto');

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
  // Whether deactivating the account or resetting its password also tells every phone it syncs from to
  // erase itself. On by default: the admin UI shows the checkbox with the device count so it is a choice
  // made knowingly, not a side effect discovered afterwards.
  wipe_devices: { type: 'boolean' },
};

module.exports = (r) => {
  // Directory of active staff (for assignment dropdowns) — minimal fields
  r.get('/api/users', auth.requireAuth, auth.requirePerm('users:read', 'users:manage'), (ctx) => {
    const full = auth.hasPerm(ctx.user, 'users:manage');
    const rows = db.all(full
      ? `SELECT id,username,display_name,email,title,role,is_active,mfa_enabled,last_login_at,locked_until,hourly_cost,created_at,oidc_subject,requires_cosign,supervisor_id,access_status FROM users WHERE access_status<>'pending' ORDER BY display_name`
      : `SELECT id,display_name,title,role,is_active FROM users WHERE is_active=1 ORDER BY display_name`);
    return { users: rows };
  });

  r.post('/api/users', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const v = validate(ctx.body, shape);
    if (db.one(`SELECT 1 FROM users WHERE username=?`, v.username)) throw badRequest('Username already exists');
    const temp = v.password || (randomToken(10) + 'Aa1!');
    const errs = auth.passwordPolicy(temp);
    if (errs.length) throw badRequest('Password must contain ' + errs.join(', '));
    const id = uuid();
    if (v.supervisor_id && !db.one(`SELECT 1 FROM users WHERE id=? AND role IN ('supervisor','admin')`, v.supervisor_id)) throw badRequest('The supervisor must be a supervisor or administrator account');
    db.run(`INSERT INTO users(id,username,password_hash,display_name,email,title,role,is_active,hourly_cost,requires_cosign,supervisor_id,must_change_password,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      id, v.username, hashPassword(temp), v.display_name, v.email || null, v.title || null, v.role, v.is_active ?? 1, v.hourly_cost ?? null, v.requires_cosign ?? 0, v.supervisor_id || null, db.now());
    audit.log({ user: ctx.user, action: 'user.create', entity: 'user', entityId: id, ip: ctx.ip, details: { username: v.username, role: v.role } });
    ctx.status = 201;
    return { id, temporary_password: v.password ? undefined : temp };
  });

  r.put('/api/users/:id', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.params.id);
    if (!u) throw notFound();
    const v = validate(ctx.body, { ...shape, username: { ...shape.username, required: false }, role: { ...shape.role, required: false }, display_name: { ...shape.display_name, required: false } }, { partial: true });
    if (u.id === ctx.user.id && (v.role && v.role !== 'admin' || v.is_active === 0)) throw badRequest('You cannot demote or deactivate your own account');
    if (v.oidc_subject && db.one(`SELECT 1 FROM users WHERE oidc_subject=? AND id<>?`, v.oidc_subject, u.id)) throw badRequest('That single sign-on identity is already linked to a different account');
    if (v.supervisor_id && !db.one(`SELECT 1 FROM users WHERE id=? AND id<>? AND role IN ('supervisor','admin')`, v.supervisor_id, u.id)) throw badRequest('The supervisor must be a different supervisor or administrator account');
    const sets = []; const params = [];
    for (const k of ['username', 'display_name', 'email', 'title', 'role', 'is_active', 'hourly_cost', 'oidc_subject', 'requires_cosign', 'supervisor_id']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    if (v.password) {
      const errs = auth.passwordPolicy(v.password);
      if (errs.length) throw badRequest('Password must contain ' + errs.join(', '));
      sets.push('password_hash=?', 'must_change_password=1', 'password_changed_at=?'); params.push(hashPassword(v.password), db.now());
      auth.revokeAllForUser(u.id);
    }
    if (ctx.body.unlock) { sets.push('locked_until=NULL', 'failed_attempts=0'); }
    // Re-activating an account whose access request was declined is the administrator changing their mind.
    if (v.is_active === 1 && u.access_status !== 'active') sets.push(`access_status='active'`);
    if (ctx.body.reset_mfa) { sets.push('mfa_enabled=0', 'mfa_secret_enc=NULL'); }
    if (v.is_active === 0) auth.revokeAllForUser(u.id);
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
    audit.log({ user: ctx.user, action: 'user.update', entity: 'user', entityId: u.id, ip: ctx.ip, details: { fields: Object.keys(v).filter(k => k !== 'password'), password_reset: !!v.password, unlock: !!ctx.body.unlock, reset_mfa: !!ctx.body.reset_mfa, devices_wiped: wiped.length, wipe_devices: wipeDevices } });
    return { ok: true, devices_wiped: wiped.length };
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
    return { ok: true };
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
