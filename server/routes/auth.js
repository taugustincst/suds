'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { rateLimit, rateLimited } = require('../app');
const { HttpError, badRequest, unauthorized } = require('../http');
const { validate } = require('../validate');
const { hashPasswordAsync, verifyPasswordAsync, generateTotpSecret, verifyTotp, otpauthUrl, encrypt, decrypt } = require('../crypto');

module.exports = (r) => {
  r.post('/api/auth/login', async (ctx) => {
    const limit = require('../config').loginRateLimit;
    if (rateLimited(`login:${ctx.ip}`, limit)) throw new HttpError(429, 'Too many login attempts. Try again later.');
    const { username, password } = validate(ctx.body, { username: { type: 'string', required: true, maxLen: 100 }, password: { type: 'string', required: true, maxLen: 500 } });
    let result;
    // Only a failed attempt counts against the address: successful sign-ins are what an office does.
    try { result = await auth.login({ username, password, ctx }); }
    catch (e) { rateLimit(`login:${ctx.ip}`, limit, 15 * 60_000); throw e; }
    ctx.res.setHeader('Set-Cookie', auth.cookieHeader(result.token));
    // Sync clients (local-mode devices) authenticate with a bearer token instead of the cookie
    const out = { user: result.user, mfaPending: result.mfaPending, mfaSetupRequired: result.mfaSetupRequired, mfaSetupDeadline: result.mfaSetupDeadline };
    if (ctx.headers['x-sync-client']) out.token = result.token;
    return out;
  });

  // ---- Sign up: ask for an account ----
  // On the office server "Sign up" is a request, never an account: the row it creates cannot sign in until
  // an administrator approves it (Settings -> Users & roles -> Access requests), choosing the role then.
  // The programme can switch the form off (Settings -> self_signup); it is on unless someone turns it off.
  const signupEnabled = () => db.getSetting('self_signup', '1') !== '0';
  // Unauthenticated, so everything here is public: whether the form is open, and the programme's contact
  // line (the privacy officer the Part 2 notice names), which the sign-in page shows in its footer.
  r.get('/api/auth/signup/status', () => ({ enabled: signupEnabled(), program_contact: db.getSetting('program_contact', '') || '', org_name: db.getSetting('org_name', 'SUDS') }));
  r.post('/api/auth/signup', async (ctx) => {
    // No session exists yet, so the pipeline's CSRF check (cookie-authenticated requests only) does not
    // apply; a cross-site form post cannot set this header without a CORS preflight the server never grants.
    if (ctx.headers['x-requested-with'] !== 'suds') throw new HttpError(403, 'Missing CSRF header');
    // A device has no administrator to approve anything: it creates accounts itself (/api/local/signup).
    if (require('../config').local) throw new HttpError(404, 'Not found');
    const limit = require('../config').signupRateLimit;
    if (!rateLimit(`signup:${ctx.ip}`, limit, 60 * 60_000)) throw new HttpError(429, 'Too many account requests from this address. Try again later.');
    if (!signupEnabled()) throw new HttpError(403, 'Sign-up is turned off here. Ask your administrator for an account.', { signupDisabled: true });
    const v = validate(ctx.body, {
      display_name: { type: 'string', required: true, maxLen: 120 },
      username: { type: 'string', required: true, maxLen: 60, pattern: /^[a-zA-Z0-9._@-]+$/ },
      email: { type: 'string', maxLen: 200 },
      password: { type: 'string', required: true, maxLen: 500 },
      reason: { type: 'string', maxLen: 200 },
    });
    const errs = auth.passwordPolicy(v.password);
    if (errs.length) throw badRequest('Password must contain ' + errs.join(', '));
    // Hashed whether or not the name is free, so neither the answer nor its timing says which it was.
    const hash = await hashPasswordAsync(v.password);
    const taken = !!db.one(`SELECT 1 FROM users WHERE username=?`, v.username);
    if (!taken) {
      const { uuid } = require('../crypto');
      const id = uuid();
      // 'readonly' is a placeholder until approval (the role column cannot be empty): the administrator
      // chooses the real role, and nothing can sign in as this row before then anyway.
      db.run(`INSERT INTO users(id,username,password_hash,display_name,email,role,is_active,access_status,access_note,requested_at,must_change_password,password_changed_at) VALUES(?,?,?,?,?,'readonly',0,'pending',?,?,0,?)`,
        id, v.username, hash, v.display_name, v.email || null, v.reason || null, db.now(), db.now());
      audit.log({ user: { id, username: v.username }, action: 'user.signup.requested', entity: 'user', entityId: id, ip: ctx.ip });
    } else {
      audit.log({ user: { username: auth.auditUsername(v.username) }, action: 'user.signup.requested', ip: ctx.ip, success: false, details: { reason: 'username taken' } });
    }
    ctx.status = 202;
    return { ok: true, message: 'Thank you. If the request can be accepted, an administrator will review it; you can sign in once it is approved.' };
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
    // default_fund_id: what the visit form pre-fills its funding source with (the worker's, else the programme's).
    return { user: auth.publicUser(u), mfaPending: !!ctx.session.mfa_pending, org_name: db.getSetting('org_name', 'SUDS'), idle_minutes: auth.policy().idleMinutes, setup_needed: false,
      default_fund_id: require('./budget').defaultFundFor(u.id) };
  });

  // Whether signing a note now needs the password (or authenticator code) again, or only a confirmation:
  // the signature form asks for exactly what the server will want (auth.verifySigner).
  r.get('/api/auth/reauth', (ctx) => {
    auth.requireAuth(ctx);
    return auth.reauthStatus(ctx);
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
    // The generated first-run password was left in a file for the operator (server/bootstrap.js). The first
    // administrator to change theirs has retired it, so the file goes.
    if (u.role === 'admin') require('../bootstrap').discardPasswordFile();
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
