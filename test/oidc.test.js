'use strict';
// Single sign-on: the token verification (server/oidc.js) is tested directly against a fake identity
// provider for every way a forged or replayed token could look legitimate, then the HTTP routes
// (server/routes/oidc.js) are exercised end to end to prove the pieces are actually wired together.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '44'.repeat(32);
process.env.SUDS_INDEX_KEY = '55'.repeat(32);
process.env.SUDS_DB_PATH = ':memory:';
process.env.MFA_REQUIRED_ROLES = '';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const config = require('../server/config');
const db = require('../server/db');
const oidc = require('../server/oidc');
const { createHandler } = require('../server/app');
const { ensureBootstrap } = require('../server/bootstrap');
const { uuid } = require('../server/crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

function signJwt(payload, { alg = 'RS256', kid = KID, key = privateKey } = {}) {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signAlg = alg === 'RS256' ? 'RSA-SHA256' : null;
  const sig = signAlg ? crypto.sign(signAlg, Buffer.from(`${header}.${body}`), key) : Buffer.from('not-a-real-signature');
  return `${header}.${body}.${b64url(sig)}`;
}

// --- Fake identity provider: discovery, JWKS, and a token endpoint whose response this test controls. ---
let idp, idpBase;
let tokenResponder = () => ({ error: 'token responder not configured for this test' });
before(async () => {
  idp = http.createServer((req, res) => {
    const send = (obj, status = 200) => { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(b); };
    if (req.method === 'GET' && req.url === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/jwks` });
    if (req.method === 'GET' && req.url === '/jwks') return send({ keys: [jwk] });
    if (req.method === 'POST' && req.url === '/token') { let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => send(tokenResponder(new URLSearchParams(body)))); return; }
    send({ error: 'not found' }, 404);
  });
  await new Promise((res) => idp.listen(0, '127.0.0.1', res));
  idpBase = `http://127.0.0.1:${idp.address().port}`;
  // Mutated directly on the live config object rather than via env vars, since server/config.js only
  // reads OIDC_* once at process start — by the time this file's `before()` runs (after the fake IdP's
  // port is known), that has already happened. server/oidc.js and server/routes/oidc.js both read
  // config.oidc.* at call time, not at require time, so this takes effect immediately.
  Object.assign(config.oidc, { issuer: idpBase, clientId: 'suds-test-client', clientSecret: 'shh', redirectUri: `${idpBase}/never-dereferenced`, label: 'Sign in with Test IdP', enabled: true });

  db.open();
  ensureBootstrap();
});
after(async () => { await new Promise((res) => idp.close(res)); db.close(); });
beforeEach(() => { oidc._resetCacheForTests(); tokenResponder = () => ({ error: 'token responder not configured for this test' }); });

function validClaims(overrides = {}) {
  return { iss: idpBase, aud: config.oidc.clientId, sub: 'user-sub-1', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), ...overrides };
}

// ---- server/oidc.js: the token exchange and verification, exercised directly ----

test('a valid RS256 ID token round-trips through startAuth + completeAuth', async () => {
  const started = await oidc.startAuth();
  const stateParam = new URL(started.url).searchParams.get('state');
  const nonceParam = new URL(started.url).searchParams.get('nonce');
  const cookieToken = started.cookie.split(';')[0].split('=')[1];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ nonce: nonceParam })) });
  const claims = await oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken });
  assert.equal(claims.sub, 'user-sub-1');
});

test('a state that does not match the signed cookie is refused', async () => {
  const started = await oidc.startAuth();
  const cookieToken = started.cookie.split(';')[0].split('=')[1];
  await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: 'not-the-real-state', cookieToken }), /did not match/);
});

test('a missing or tampered cookie is refused', async () => {
  const started = await oidc.startAuth();
  const stateParam = new URL(started.url).searchParams.get('state');
  await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken: undefined }), /expired or was tampered/);
  const cookieToken = started.cookie.split(';')[0].split('=')[1];
  await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken: cookieToken.slice(0, -2) + 'xx' }), /expired or was tampered/);
});

test('a token whose nonce does not match this sign-in attempt is refused', async () => {
  const started = await oidc.startAuth();
  const stateParam = new URL(started.url).searchParams.get('state');
  const cookieToken = started.cookie.split(';')[0].split('=')[1];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ nonce: 'a-different-nonce' })) });
  await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken }), /did not match this sign-in attempt/);
});

test('a token signed with a symmetric or none algorithm is refused outright', async () => {
  const started = await oidc.startAuth();
  const stateParam = new URL(started.url).searchParams.get('state');
  const nonceParam = new URL(started.url).searchParams.get('nonce');
  const cookieToken = started.cookie.split(';')[0].split('=')[1];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ nonce: nonceParam }), { alg: 'none' }) });
  await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken }), /[Uu]nsupported.*algorithm/);
});

test('a token whose signature does not verify is refused', async () => {
  const started = await oidc.startAuth();
  const stateParam = new URL(started.url).searchParams.get('state');
  const nonceParam = new URL(started.url).searchParams.get('nonce');
  const cookieToken = started.cookie.split(';')[0].split('=')[1];
  const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  tokenResponder = () => ({ id_token: signJwt(validClaims({ nonce: nonceParam }), { key: otherKey }) });
  await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken }), /signature did not verify/);
});

test('a token from an unexpected issuer or audience is refused', async () => {
  for (const bad of [{ iss: 'https://not-the-real-idp.example' }, { aud: 'some-other-client' }]) {
    const started = await oidc.startAuth();
    const stateParam = new URL(started.url).searchParams.get('state');
    const nonceParam = new URL(started.url).searchParams.get('nonce');
    const cookieToken = started.cookie.split(';')[0].split('=')[1];
    tokenResponder = () => ({ id_token: signJwt(validClaims({ nonce: nonceParam, ...bad })) });
    await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken }));
  }
});

test('an expired token is refused', async () => {
  const started = await oidc.startAuth();
  const stateParam = new URL(started.url).searchParams.get('state');
  const nonceParam = new URL(started.url).searchParams.get('nonce');
  const cookieToken = started.cookie.split(';')[0].split('=')[1];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ nonce: nonceParam, exp: Math.floor(Date.now() / 1000) - 60 })) });
  await assert.rejects(() => oidc.completeAuth({ code: 'abc', state: stateParam, cookieToken }), /expired/);
});

// ---- HTTP routes: server/routes/oidc.js, wired into a real request handler ----

let server, base;
before(async () => {
  const handler = createHandler();
  server = http.createServer(handler);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((res) => server.close(res)); });

test('the status endpoint reports whether SSO is offered, without requiring a session', async () => {
  const r = await fetch(`${base}/api/auth/oidc/status`);
  const j = await r.json();
  assert.deepEqual(j, { enabled: true, label: 'Sign in with Test IdP' });
});

test('start redirects to the identity provider with PKCE and a signed state cookie', async () => {
  const r = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin, idpBase);
  assert.equal(loc.searchParams.get('client_id'), 'suds-test-client');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('state'));
  assert.ok(r.headers.getSetCookie().some((c) => c.startsWith('suds_oidc=')));
});

test('a linked, active, non-MFA user is signed in and lands on the dashboard', async () => {
  const userId = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,oidc_subject,password_changed_at) VALUES(?,?,?,?,?,?,?)`, userId, 'ssouser', 'x', 'SSO User', 'navigator', 'linked-sub-1', db.now());
  const startRes = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(startRes.headers.get('location'));
  const oidcCookie = startRes.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ sub: 'linked-sub-1', nonce: loc.searchParams.get('nonce') })) });
  const cbRes = await fetch(`${base}/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oidcCookie } });
  assert.equal(cbRes.status, 302);
  assert.equal(cbRes.headers.get('location'), '/#/dashboard');
  const sessionCookie = cbRes.headers.getSetCookie().find((c) => c.startsWith('suds_session='));
  assert.ok(sessionCookie, 'a session cookie was set');
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: sessionCookie.split(';')[0], 'X-Requested-With': 'suds' } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, 'ssouser');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='auth.oidc.login' AND user_id=?`, userId));
});

test('a linked user with MFA enabled lands on the MFA step, not the dashboard, and the session reflects it', async () => {
  const userId = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,oidc_subject,mfa_enabled,mfa_secret_enc,password_changed_at) VALUES(?,?,?,?,?,?,1,?,?)`, userId, 'ssomfa', 'x', 'SSO MFA', 'navigator', 'linked-sub-mfa', require('../server/crypto').encrypt('base32secretbase32secret'), db.now());
  const startRes = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(startRes.headers.get('location'));
  const oidcCookie = startRes.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ sub: 'linked-sub-mfa', nonce: loc.searchParams.get('nonce') })) });
  const cbRes = await fetch(`${base}/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oidcCookie } });
  assert.equal(cbRes.headers.get('location'), '/#/mfa');
  assert.equal(db.one(`SELECT mfa_pending FROM sessions WHERE user_id=?`, userId).mfa_pending, 1);
});

test('an identity that is not linked to any account is bounced back to the login page with an error, and no session', async () => {
  const startRes = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(startRes.headers.get('location'));
  const oidcCookie = startRes.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ sub: 'never-linked-anywhere', nonce: loc.searchParams.get('nonce') })) });
  const cbRes = await fetch(`${base}/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oidcCookie } });
  assert.equal(cbRes.status, 302);
  assert.equal(cbRes.headers.get('location'), '/#/login?oidc_error=not_linked');
  assert.ok(!cbRes.headers.getSetCookie().some((c) => c.startsWith('suds_session=')));
});

test('a deactivated but linked account cannot sign in via SSO', async () => {
  const userId = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,oidc_subject,is_active,password_changed_at) VALUES(?,?,?,?,?,?,0,?)`, userId, 'ssoinactive', 'x', 'SSO Inactive', 'navigator', 'linked-sub-inactive', db.now());
  const startRes = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(startRes.headers.get('location'));
  const oidcCookie = startRes.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(validClaims({ sub: 'linked-sub-inactive', nonce: loc.searchParams.get('nonce') })) });
  const cbRes = await fetch(`${base}/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oidcCookie } });
  assert.equal(cbRes.headers.get('location'), '/#/login?oidc_error=inactive');
});

test('the identity provider declining the request is passed straight through as an error', async () => {
  const r = await fetch(`${base}/api/auth/oidc/callback?error=access_denied`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/#/login?oidc_error=provider_denied');
});

test('start and callback are not offered when OIDC is not configured', async () => {
  config.oidc.enabled = false;
  try {
    assert.equal((await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${base}/api/auth/oidc/callback`, { redirect: 'manual' })).status, 404);
    assert.equal((await (await fetch(`${base}/api/auth/oidc/status`)).json()).enabled, false);
  } finally { config.oidc.enabled = true; }
});
