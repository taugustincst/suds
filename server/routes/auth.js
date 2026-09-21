'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { rateLimit } = require('../app');
const { HttpError, badRequest, unauthorized } = require('../http');
const { validate } = require('../validate');
const { hashPasswordAsync, verifyPasswordAsync, generateTotpSecret, verifyTotp, otpauthUrl, encrypt, decrypt } = require('../crypto');

module.exports = (r) => {
  r.post('/api/auth/login', async (ctx) => {
    if (!rateLimit(`login:${ctx.ip}`, require('../config').loginRateLimit, 15 * 60_000)) throw new HttpError(429, 'Too many login attempts. Try again later.');
    const { username, password } = validate(ctx.body, { username: { type: 'string', required: true, maxLen: 100 }, password: { type: 'string', required: true, maxLen: 500 } });
    const result = await auth.login({ username, password, ctx });
    ctx.res.setHeader('Set-Cookie', auth.cookieHeader(result.token));
    // Sync clients (phone app) authenticate with a bearer token instead of the cookie
    const out = { user: result.user, mfaPending: result.mfaPending, mfaSetupRequired: result.mfaSetupRequired, mfaSetupDeadline: result.mfaSetupDeadline };
    if (ctx.headers['x-sync-client']) out.token = result.token;
    return out;
  });

  r.post('/api/auth/mfa/verify', (ctx) => {
    if (!ctx.user) throw unauthorized();
    if (!rateLimit(`mfa:${ctx.user.id}`, 10, 10 * 60_000)) throw new HttpError(429, 'Too many attempts');
    const { code } = validate(ctx.body, { code: { type: 'string', required: true, maxLen: 10 } });
    return { user: auth.verifyMfa(ctx, code) };
  });

  r.post('/api/auth/logout', (ctx) => {
    if (ctx.user) audit.log({ user: ctx.user, action: 'auth.logout', ip: ctx.ip });
    auth.revokeSession(ctx.sessionToken);
    ctx.res.setHeader('Set-Cookie', auth.cookieHeader('', { clear: true }));
    return { ok: true };
  });

  r.get('/api/auth/me', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.user.id);
    return { user: auth.publicUser(u), mfaPending: !!ctx.session.mfa_pending, org_name: db.getSetting('org_name', 'SUDS'), idle_minutes: auth.policy().idleMinutes, setup_needed: false };
  });

  r.post('/api/auth/password', async (ctx) => {
    // requireAuth, not a bare user check: a session that has not cleared its second factor has only
    // half-proven who it belongs to, and must not be able to change the account's password.
    auth.requireAuth(ctx);
    const { current_password, new_password } = validate(ctx.body, { current_password: { type: 'string', required: true, maxLen: 500 }, new_password: { type: 'string', required: true, maxLen: 500 } });
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.user.id);
    if (!(await verifyPasswordAsync(current_password, u.password_hash))) { audit.log({ user: u, action: 'auth.password.change.failed', ip: ctx.ip, success: false }); throw unauthorized('Current password is incorrect'); }
    const errs = auth.passwordPolicy(new_password);
    if (errs.length) throw badRequest('Password must contain ' + errs.join(', '));
    if (await verifyPasswordAsync(new_password, u.password_hash)) throw badRequest('New password must differ from the current password');
    db.run(`UPDATE users SET password_hash=?, must_change_password=0, password_changed_at=?, updated_at=? WHERE id=?`, await hashPasswordAsync(new_password), db.now(), db.now(), u.id);
    // revoke other sessions
    db.run(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL`, db.now(), u.id, ctx.session.id);
    audit.log({ user: u, action: 'auth.password.changed', ip: ctx.ip });
    return { ok: true };
  });

  // MFA enrollment: step 1 returns secret + otpauth URL; step 2 confirms with a valid code.
  r.post('/api/auth/mfa/setup', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const secret = generateTotpSecret();
    db.run(`UPDATE users SET mfa_secret_enc=?, updated_at=? WHERE id=? AND mfa_enabled=0`, encrypt(secret), db.now(), ctx.user.id);
    return { secret, otpauth: otpauthUrl(secret, ctx.user.username, db.getSetting('org_name', 'SUDS')) };
  });
  r.post('/api/auth/mfa/enable', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const { code } = validate(ctx.body, { code: { type: 'string', required: true, maxLen: 10 } });
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.user.id);
    if (!u.mfa_secret_enc) throw badRequest('Run MFA setup first');
    if (!verifyTotp(decrypt(u.mfa_secret_enc), code)) throw badRequest('Invalid code');
    db.run(`UPDATE users SET mfa_enabled=1, updated_at=? WHERE id=?`, db.now(), u.id);
    db.run(`UPDATE sessions SET mfa_pending=0 WHERE id=?`, ctx.session.id);
    audit.log({ user: u, action: 'auth.mfa.enabled', ip: ctx.ip });
    return { ok: true };
  });
  r.post('/api/auth/mfa/disable', async (ctx) => {
    auth.requireAuth(ctx);
    const { password } = validate(ctx.body, { password: { type: 'string', required: true, maxLen: 500 } });
    const u = db.one(`SELECT * FROM users WHERE id=?`, ctx.user.id);
    if (!(await verifyPasswordAsync(password, u.password_hash))) throw unauthorized('Password is incorrect');
    if (auth.policy().mfaRequiredRoles.includes(u.role)) throw badRequest('MFA is required for your role');
    db.run(`UPDATE users SET mfa_enabled=0, mfa_secret_enc=NULL, updated_at=? WHERE id=?`, db.now(), u.id);
    audit.log({ user: u, action: 'auth.mfa.disabled', ip: ctx.ip });
    return { ok: true };
  });

  r.get('/api/auth/sessions', (ctx) => {
    auth.requireAuth(ctx);
    return { sessions: db.all(`SELECT id, created_at, last_seen_at, ip, user_agent, id=? AS current FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`, ctx.session.id, ctx.user.id, db.now()) };
  });
  r.post('/api/auth/sessions/revoke-others', (ctx) => {
    auth.requireAuth(ctx);
    db.run(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL`, db.now(), ctx.user.id, ctx.session.id);
    audit.log({ user: ctx.user, action: 'auth.sessions.revoked_others', ip: ctx.ip });
    return { ok: true };
  });
};
