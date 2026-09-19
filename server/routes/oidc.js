'use strict';
// Optional single sign-on against the county's identity provider. Not part of local/offline mode — a
// phone with no route to an office server has no route to an IdP either (see LOCAL_ROUTE_MODULES in
// server/app.js). Disabled entirely unless every OIDC_* environment variable is set (server/config.js).
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const oidc = require('../oidc');
const { rateLimit } = require('../app');
const { HttpError, notFound } = require('../http');

function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }

module.exports = (r) => {
  // Public: whether the login page should offer an SSO button at all, and what to label it.
  r.get('/api/auth/oidc/status', () => ({ enabled: config.oidc.enabled, label: config.oidc.label }));

  r.get('/api/auth/oidc/start', async (ctx) => {
    if (!config.oidc.enabled) throw notFound();
    if (!rateLimit(`login:${ctx.ip}`, config.isTest ? 100000 : 20, 15 * 60_000)) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    let started;
    try { started = await oidc.startAuth(); }
    catch (e) { console.error('[suds] oidc start failed:', e.message); throw new HttpError(502, 'Could not reach the identity provider. Try again shortly, or sign in with a username and password.'); }
    ctx.res.setHeader('Set-Cookie', started.cookie);
    redirect(ctx.res, started.url);
  });

  r.get('/api/auth/oidc/callback', async (ctx) => {
    if (!config.oidc.enabled) throw notFound();
    const fail = (reason, detail) => {
      audit.log({ user: { username: reason === 'not_linked' ? (detail && detail.sub) || '' : '' }, action: 'auth.oidc.failed', ip: ctx.ip, success: false, details: { reason } });
      ctx.res.setHeader('Set-Cookie', oidc.stateCookie('', { clear: true }));
      redirect(ctx.res, `/#/login?oidc_error=${encodeURIComponent(reason)}`);
    };
    if (ctx.query.get('error')) return fail('provider_denied');
    if (!rateLimit(`login:${ctx.ip}`, config.isTest ? 100000 : 20, 15 * 60_000)) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    let claims;
    try {
      claims = await oidc.completeAuth({ code: ctx.query.get('code') || '', state: ctx.query.get('state') || '', cookieToken: ctx.cookies[oidc.COOKIE] });
    } catch (e) {
      console.error('[suds] oidc callback failed:', e.message);
      return fail('exchange_failed');
    }
    const user = db.one(`SELECT * FROM users WHERE oidc_subject=?`, claims.sub);
    if (!user) return fail('not_linked', { sub: claims.sub });
    if (!user.is_active) return fail('inactive');
    // From here on this mirrors auth.login()'s success path exactly, so an OIDC session behaves identically
    // to a password one — same MFA gate, same idle/absolute timeouts, same audit trail.
    db.run(`UPDATE users SET last_login_at=? WHERE id=?`, db.now(), user.id);
    const mfaPending = !!user.mfa_enabled;
    const token = auth.createSession(user, ctx, { mfaPending });
    audit.log({ user, action: mfaPending ? 'auth.oidc.login.mfa_pending' : 'auth.oidc.login', ip: ctx.ip });
    const cookies = [auth.cookieHeader(token), oidc.stateCookie('', { clear: true })];
    ctx.res.setHeader('Set-Cookie', cookies);
    redirect(ctx.res, mfaPending ? '/#/mfa' : '/#/dashboard');
  });
};
