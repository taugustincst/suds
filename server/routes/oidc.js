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

// Trusting the identity provider's second factor in place of SUDS's own TOTP (Settings → Security policy;
// off by default). With it on, a sign-in whose ID token says multi-factor was used (amr mfa, or two factors
// of different kinds such as pwd+otp, or an acr the administrator named) is complete without the SUDS code; one that does not say so falls back to
// the SUDS second factor exactly as before.
function mfaTrust() {
  const acrValues = String(db.getSetting('sso_mfa_acr_values', '') || '').split(/[\s,]+/).filter(Boolean);
  return { trusted: db.getSetting('sso_trust_idp_mfa', '0') === '1', acrValues };
}

// An account created by SCIM provisioning (server/scim.js) has no OIDC subject until its first sign-in. It is
// linked then — only an account provisioned by the identity provider itself, never one made in SUDS, and
// only on a match with what provisioning recorded: the provider's object id (Entra's oid) against the SCIM
// externalId, or the username the provider sends (preferred_username / upn / email) against the SCIM userName.
function linkProvisioned(claims) {
  const candidates = [];
  if (claims.oid) candidates.push(db.one(`SELECT * FROM users WHERE scim_external_id=? AND oidc_subject IS NULL`, String(claims.oid)));
  for (const k of ['preferred_username', 'upn', 'email']) if (claims[k] && !(k === 'email' && claims.email_verified === false)) candidates.push(db.one(`SELECT * FROM users WHERE username=? COLLATE NOCASE AND scim_external_id IS NOT NULL AND oidc_subject IS NULL`, String(claims[k])));
  const user = candidates.find(Boolean);
  if (!user) return null;
  db.run(`UPDATE users SET oidc_subject=?, updated_at=? WHERE id=?`, claims.sub, db.now(), user.id);
  audit.log({ user: { username: 'system' }, action: 'user.oidc_linked', entity: 'user', entityId: user.id, details: { username: user.username, via: claims.oid && user.scim_external_id === String(claims.oid) ? 'scim externalId' : 'scim userName' } });
  return db.one(`SELECT * FROM users WHERE id=?`, user.id);
}

module.exports = (r) => {
  // Public: whether the login page should offer an SSO button at all, and what to label it.
  r.get('/api/auth/oidc/status', () => ({ enabled: config.oidc.enabled, label: config.oidc.label }));

  r.get('/api/auth/oidc/start', async (ctx) => {
    if (!config.oidc.enabled) throw notFound();
    if (!rateLimit(`login:${ctx.ip}`, config.isTest ? 100000 : 20, 15 * 60_000)) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    let started;
    const t = mfaTrust();
    try { started = await oidc.startAuth({ acrValues: t.trusted ? t.acrValues : [] }); }
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
    const user = db.one(`SELECT * FROM users WHERE oidc_subject=?`, claims.sub) || linkProvisioned(claims);
    if (!user) return fail('not_linked', { sub: claims.sub });
    if (!user.is_active) return fail('inactive');
    // From here on this mirrors auth.login()'s success path exactly, so an OIDC session behaves identically
    // to a password one — same MFA gate, same idle/absolute timeouts, same audit trail — except that the
    // provider's multi-factor sign-in may stand in for SUDS's own second factor when trusted (mfaTrust).
    // idp_seen_at: the provider vouched for this account just now (server/deprovision.js).
    db.run(`UPDATE users SET last_login_at=?, idp_seen_at=? WHERE id=?`, db.now(), db.now(), user.id);
    const trust = mfaTrust();
    const idp = trust.trusted ? oidc.idpMfa(claims, { acrValues: trust.acrValues }) : null;
    const viaIdp = !!(idp && idp.ok);
    const mfaPending = !viaIdp && !!user.mfa_enabled;
    const token = auth.createSession(user, ctx, { mfaPending, mfaSource: viaIdp ? 'idp' : null });
    audit.log({ user, action: mfaPending ? 'auth.oidc.login.mfa_pending' : 'auth.oidc.login', ip: ctx.ip,
      details: idp ? { mfa: viaIdp ? 'idp' : 'not asserted by the identity provider', via: idp.via || undefined, amr: idp.amr.slice(0, 10), acr: idp.acr || undefined } : undefined });
    const cookies = [auth.cookieHeader(token), oidc.stateCookie('', { clear: true })];
    ctx.res.setHeader('Set-Cookie', cookies);
    redirect(ctx.res, mfaPending ? '/#/mfa' : '/#/dashboard');
  });
};
