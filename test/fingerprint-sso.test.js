'use strict';
// Single sign-on and the fingerprint (docs/FINGERPRINT.md, "Single sign-on"): someone in a role that requires two-step
// verification whose passkey is their enrolment, signing in through an identity provider that did not assert
// multi-factor, finishes with the fingerprint (#/mfa) exactly as after a password. When the provider asserts it (and
// the administrator trusts that), nothing more is asked. People without passkeys, and devices, are as before.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('../server/config');
const oidc = require('../server/oidc');
const H = require('./helpers');
const { SoftAuthenticator } = require('./authenticator');
const { totp, encrypt, uuid } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
const APW = 'AdminPassw0rd!x';
const SECRET = 'JBSWY3DPEHPK3PXP';
const setting = (k, v) => { if (v === null) H.db.run(`DELETE FROM settings WHERE key=?`, k); else H.db.setSetting(k, v); };
const resetLimits = () => { const app = require('../server/app'); for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) for (const k of ['login', 'api', 'passkey-options']) app.rateLimitReset(`${k}:${ip}`); };

// ---- a fake identity provider (as test/fingerprint-regression.test.js) ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64url = (b) => Buffer.from(b).toString('base64url');
const signJwt = (payload) => { const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })); const p = b64url(JSON.stringify(payload)); return `${h}.${p}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey))}`; };
let idp, idpBase, base;
let tokenResponder = () => ({ error: 'not configured' });
const claims = (o = {}) => { const t = Math.floor(Date.now() / 1000); return { iss: idpBase, aud: 'suds-test-client', exp: t + 300, iat: t, auth_time: t, ...o }; };

before(async () => {
  idp = http.createServer((req, res) => {
    const send = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/jwks` });
    if (req.url === '/jwks') return send({ keys: [jwk] });
    if (req.method === 'POST' && req.url === '/token') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => send(tokenResponder(new URLSearchParams(b)))); return; }
    send({ error: 'not found' }, 404);
  });
  await new Promise((res) => idp.listen(0, '127.0.0.1', res));
  idpBase = `http://127.0.0.1:${idp.address().port}`;
  Object.assign(config.oidc, { issuer: idpBase, clientId: 'suds-test-client', clientSecret: 'shh', redirectUri: `${idpBase}/never`, label: 'County sign-in', enabled: true });
  base = await H.start();
  config.localModeEnabled = true; // device sync
  const admin = H.client(); await admin.login('admin', APW);
});
after(async () => { await H.stop(); await new Promise((r) => idp.close(r)); });

function cookieClient(cookie) {
  const req = async (method, path, body) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : null };
  };
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b) };
}
/** A single sign-on through the fake provider; `extra` goes into the ID token (amr, acr). */
async function ssoSignIn(sub, extra = {}) {
  resetLimits(); oidc._resetCacheForTests();
  const s = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(s.headers.get('location'));
  const oc = s.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(claims({ sub, nonce: loc.searchParams.get('nonce'), ...extra })) });
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=x&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oc } });
  const cookie = cb.headers.getSetCookie().find((x) => x.startsWith('suds_session='));
  assert.ok(cookie, `a session (${cb.headers.get('location')})`);
  return { c: cookieClient(cookie.split(';')[0]), location: cb.headers.get('location') };
}

let seq = 0;
/** Someone who can sign in with single sign-on and has a password (to add a passkey), optionally a passkey and an authenticator app. */
async function person(role, { passkey = false, withTotp = false } = {}) {
  const u = H.makeUser(`fpsso_${role}_${++seq}`, role);
  u.sub = `sub-${uuid()}`;
  H.db.run(`UPDATE users SET oidc_subject=? WHERE id=?`, u.sub, u.id);
  if (passkey) {
    resetLimits();
    u.key = new SoftAuthenticator({ origin: base });
    const c = H.client(); const l = await c.login(u.username, PW);
    assert.equal(l.mfaPending, false);
    const o = await c.post('/api/auth/passkeys/register/options', { password: PW });
    assert.equal(o.status, 200, JSON.stringify(o.data));
    assert.equal((await c.post('/api/auth/passkeys/register', { credential: u.key.create(o.data.publicKey), name: 'Phone' })).status, 201);
  }
  if (withTotp) H.db.run(`UPDATE users SET mfa_enabled=1, mfa_secret_enc=? WHERE id=?`, encrypt(SECRET), u.id);
  return u;
}
async function finishWithFingerprint(c, u) {
  const o = await c.post('/api/auth/passkeys/login/options', {});
  assert.equal(o.status, 200, JSON.stringify(o.data)); assert.equal(o.data.purpose, 'mfa');
  return c.post('/api/auth/passkeys/login', { credential: u.key.get(o.data.publicKey) });
}
const lastAudit = (userId, action) => H.db.one(`SELECT * FROM audit_log WHERE user_id=? AND action=? ORDER BY rowid DESC LIMIT 1`, userId, action);
const withPolicy = async (fn, { grace = '30', trust = '0' } = {}) => {
  setting('mfa_required_roles', 'clinician'); setting('mfa_grace_days', grace); setting('sso_trust_idp_mfa', trust);
  try { await fn(); } finally { setting('mfa_required_roles', null); setting('mfa_grace_days', null); setting('sso_trust_idp_mfa', null); }
};

test('SSO without multi-factor asserted: a passkey-only account in a role that requires it finishes with the fingerprint', async () => {
  await withPolicy(async () => {
    const u = await person('clinician', { passkey: true });
    for (const extra of [{}, { amr: ['pwd'] }]) {
      const { c, location } = await ssoSignIn(u.sub, extra);
      assert.equal(location, '/#/mfa');
      const me = await c.get('/api/auth/me');
      assert.equal(me.status, 200); assert.equal(me.data.mfaPending, true); assert.deepEqual(me.data.mfa_methods, ['passkey']);
      const early = await c.get('/api/clients?limit=1');
      assert.equal(early.status, 401, 'nothing before the second step'); assert.equal(early.data.mfaRequired, true);
      assert.ok(lastAudit(u.id, 'auth.oidc.login.mfa_pending'), 'the half sign-in is audited');
      const f = await finishWithFingerprint(c, u);
      assert.equal(f.status, 200, JSON.stringify(f.data)); assert.equal(f.data.mfaPending, false);
      assert.equal((await c.get('/api/clients?limit=1')).status, 200, 'a full session');
      const a = lastAudit(u.id, 'auth.login'); assert.equal(JSON.parse(a.details).method, 'passkey'); assert.equal(JSON.parse(a.details).mfa, true);
      const s = H.db.one(`SELECT * FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, u.id);
      assert.equal(s.mfa_pending, 0); assert.equal(s.mfa_source, 'passkey');
    }
    // Past the enrolment deadline too: the passkey is the enrolment, given as the second step.
    setting('mfa_grace_days', '0');
    const { c } = await ssoSignIn(u.sub);
    assert.equal((await c.get('/api/clients?limit=1')).status, 401);
    assert.equal((await finishWithFingerprint(c, u)).status, 200);
    assert.equal((await c.get('/api/clients?limit=1')).status, 200);
  });
});

test('SSO without multi-factor asserted: with an authenticator app as well, either finishes it', async () => {
  await withPolicy(async () => {
    const u = await person('clinician', { passkey: true, withTotp: true });
    const a = await ssoSignIn(u.sub);
    assert.equal(a.location, '/#/mfa');
    assert.deepEqual((await a.c.get('/api/auth/me')).data.mfa_methods, ['totp', 'passkey']);
    assert.equal((await a.c.post('/api/auth/mfa/verify', { code: totp(SECRET) })).status, 200);
    assert.equal((await a.c.get('/api/clients?limit=1')).status, 200);
    const b = await ssoSignIn(u.sub);
    assert.equal((await b.c.get('/api/clients?limit=1')).status, 401);
    assert.equal((await finishWithFingerprint(b.c, u)).status, 200);
    assert.equal((await b.c.get('/api/clients?limit=1')).status, 200);
  });
});

test('SSO with multi-factor asserted by a trusted provider: a full session straight away', async () => {
  await withPolicy(async () => {
    const u = await person('clinician', { passkey: true });
    const { c, location } = await ssoSignIn(u.sub, { amr: ['mfa'] });
    assert.equal(location, '/#/dashboard');
    assert.equal((await c.get('/api/auth/me')).data.mfaPending, false);
    assert.equal((await c.get('/api/clients?limit=1')).status, 200);
    // The same assertion from a provider the administrator does not trust is not multi-factor: the fingerprint is asked.
    setting('sso_trust_idp_mfa', '0');
    const n = await ssoSignIn(u.sub, { amr: ['mfa'] });
    assert.equal(n.location, '/#/mfa');
  }, { trust: '1' });
});

test('SSO: a passkey outside a role that requires two-step verification, or with fingerprint sign-in switched off, asks nothing', async () => {
  await withPolicy(async () => {
    const nav = await person('navigator', { passkey: true });
    const a = await ssoSignIn(nav.sub);
    assert.equal(a.location, '/#/dashboard'); assert.equal((await a.c.get('/api/clients?limit=1')).status, 200);
    const cl = await person('clinician', { passkey: true });
    setting('passkey_signin', '0');
    try {
      const b = await ssoSignIn(cl.sub);
      assert.equal(b.location, '/#/dashboard', 'no step it could not finish; the enrolment deadline applies instead');
      assert.equal((await b.c.get('/api/clients?limit=1')).status, 200, 'in the grace period');
    } finally { setting('passkey_signin', null); }
  });
});

test('SSO: someone in a role that requires it with no passkey is as on 1.18.0 (grace period, then the deadline)', async () => {
  await withPolicy(async () => {
    const u = await person('clinician');
    const a = await ssoSignIn(u.sub);
    assert.equal(a.location, '/#/dashboard'); assert.equal((await a.c.get('/api/clients?limit=1')).status, 200);
    setting('mfa_grace_days', '0');
    const b = await ssoSignIn(u.sub);
    assert.equal(b.location, '/#/dashboard');
    const r = await b.c.get('/api/clients?limit=1');
    assert.equal(r.status, 403); assert.equal(r.data.mfaSetupRequired, true);
  });
});

test('a device sign-in of a passkey-only account is unchanged: no fingerprint asked, the old deadline', async () => {
  await withPolicy(async () => {
    const u = await person('clinician', { passkey: true });
    resetLimits();
    const c = H.client(); c.setHeader('X-Sync-Client', '1'); c.setHeader('X-Device-Id', `dev-${u.username}`);
    const l = await c.post('/api/auth/login', { username: u.username, password: PW });
    assert.equal(l.status, 200); assert.equal(l.data.mfaPending, false); assert.equal(l.data.mfaMethods, undefined);
    assert.equal(l.data.mfaSetupRequired, true); assert.ok(l.data.mfaSetupDeadline);
    const p = await c.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', { Authorization: 'Bearer ' + l.data.token, Cookie: '' });
    assert.equal(p.status, 200);
  });
});
