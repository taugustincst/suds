'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, notFound } = require('../http');
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
};

module.exports = (r) => {
  // Directory of active staff (for assignment dropdowns) — minimal fields
  r.get('/api/users', auth.requireAuth, auth.requirePerm('users:read', 'users:manage'), (ctx) => {
    const full = auth.hasPerm(ctx.user, 'users:manage');
    const rows = db.all(full
      ? `SELECT id,username,display_name,email,title,role,is_active,mfa_enabled,last_login_at,locked_until,hourly_cost,created_at FROM users ORDER BY display_name`
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
    db.run(`INSERT INTO users(id,username,password_hash,display_name,email,title,role,is_active,hourly_cost,must_change_password,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?,1,?)`,
      id, v.username, hashPassword(temp), v.display_name, v.email || null, v.title || null, v.role, v.is_active ?? 1, v.hourly_cost ?? null, db.now());
    audit.log({ user: ctx.user, action: 'user.create', entity: 'user', entityId: id, ip: ctx.ip, details: { username: v.username, role: v.role } });
    ctx.status = 201;
    return { id, temporary_password: v.password ? undefined : temp };
  });

  r.put('/api/users/:id', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.params.id);
    if (!u) throw notFound();
    const v = validate(ctx.body, { ...shape, username: { ...shape.username, required: false }, role: { ...shape.role, required: false }, display_name: { ...shape.display_name, required: false } }, { partial: true });
    if (u.id === ctx.user.id && (v.role && v.role !== 'admin' || v.is_active === 0)) throw badRequest('You cannot demote or deactivate your own account');
    const sets = []; const params = [];
    for (const k of ['username', 'display_name', 'email', 'title', 'role', 'is_active', 'hourly_cost']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    if (v.password) {
      const errs = auth.passwordPolicy(v.password);
      if (errs.length) throw badRequest('Password must contain ' + errs.join(', '));
      sets.push('password_hash=?', 'must_change_password=1', 'password_changed_at=?'); params.push(hashPassword(v.password), db.now());
      auth.revokeAllForUser(u.id);
    }
    if (ctx.body.unlock) { sets.push('locked_until=NULL', 'failed_attempts=0'); }
    if (ctx.body.reset_mfa) { sets.push('mfa_enabled=0', 'mfa_secret_enc=NULL'); }
    if (v.is_active === 0) auth.revokeAllForUser(u.id);
    if (!sets.length) return { ok: true };
    sets.push('updated_at=?'); params.push(db.now(), u.id);
    db.run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, ...params);
    audit.log({ user: ctx.user, action: 'user.update', entity: 'user', entityId: u.id, ip: ctx.ip, details: { fields: Object.keys(v).filter(k => k !== 'password'), password_reset: !!v.password, unlock: !!ctx.body.unlock, reset_mfa: !!ctx.body.reset_mfa } });
    return { ok: true };
  });
};
