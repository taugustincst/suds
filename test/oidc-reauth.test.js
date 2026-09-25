'use strict';
// Signing a note as a single sign-on user with no SUDS password (a SCIM-provisioned account, say): after
// the quick-signing window the signature step cannot ask for a password the person does not have, so it
// sends them back to the identity provider with prompt=login and max_age=0, checks that the ID token's
// auth_time is fresh and names the same person, and marks the session re-authenticated.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '46'.repeat(32);
process.env.SUDS_INDEX_KEY = '57'.repeat(32);
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
const { uuid, hashPassword } = require('../server/crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const signJwt = (payload) => {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey))}`;
};

let idp, idpBase, server, base;
let tokenResponder = () => ({ error: 'not configured' });
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
  db.open(); ensureBootstrap();
  db.setSetting('programme_profile', 'treatment'); // notes are a module of that profile (server/programme.js)
  server = http.createServer(createHandler());
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => idp.close(r)); db.close(); });
beforeEach(() => { oidc._resetCacheForTests(); });

const claims = (o = {}) => ({ iss: idpBase, aud: 'suds-test-client', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), auth_time: Math.floor(Date.now() / 1000), ...o });
const now = () => Math.floor(Date.now() / 1000);

/** Sign in through the fake provider; returns a tiny client bound to the new session cookie. */
async function ssoSignIn(sub) {
  const s = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(s.headers.get('location'));
  const oc = s.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(claims({ sub, nonce: loc.searchParams.get('nonce') })) });
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=x&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oc } });
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('suds_session=')).split(';')[0];
  return client(cookie);
}
function client(cookie) {
  const req = async (method, path, body, extra = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', Cookie: cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : null, headers: r.headers };
  };
  return { cookie, get: (p) => req('GET', p), post: (p, b) => req('POST', p, b) };
}
function makeSsoUser(username, sub, { password = null } = {}) {
  const id = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,oidc_subject,password_changed_at) VALUES(?,?,?,?,?,?,?)`, id, username, password ? hashPassword(password) : '!scim-provisioned-no-password', username, 'navigator', sub, db.now());
  return id;
}
const makeStale = (userId) => db.run(`UPDATE sessions SET reauth_at=? WHERE user_id=?`, new Date(Date.now() - 3600_000).toISOString(), userId);
async function draftNote(c) {
  const clientId = (await c.post('/api/clients', { first_name: 'Sso', last_name: 'Signer' + Math.random().toString(36).slice(2, 8) })).data.id;
  return (await c.post('/api/notes', { client_id: clientId, kind: 'admin', title: 'Visit', content: 'Outreach contact.', occurred_at: new Date().toISOString() })).data.id;
}
/** Start the re-authentication and finish it at the fake provider with `tokenClaims`. */
async function reauthRoundTrip(c, ret, tokenClaims) {
  const st = await c.post('/api/auth/oidc/reauth', { return: ret });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const url = new URL(st.data.url);
  const oc = st.headers.getSetCookie().find((x) => x.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(claims({ nonce: url.searchParams.get('nonce'), ...tokenClaims(url) })) });
  // The provider's redirect back is a cross-site navigation: the SameSite=Strict session cookie is NOT sent.
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=y&state=${url.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oc } });
  return { url, cb };
}

test('an SSO-only account is told to confirm with single sign-on, not asked for a password it does not have', async () => {
  const id = makeSsoUser('ssoonly', 'sub-only');
  const c = await ssoSignIn('sub-only');
  let st = (await c.get('/api/auth/reauth')).data;
  assert.equal(st.recent, true); assert.equal(st.method, 'sso'); assert.equal(st.sso, true);
  makeStale(id);
  const note = await draftNote(c);
  const r = await c.post(`/api/notes/${note}/sign`, { confirm: true });
  assert.equal(r.status, 403); assert.equal(r.data.reauthRequired, true); assert.equal(r.data.method, 'sso');
  assert.match(r.data.error, /single sign-on/);
  st = (await c.get('/api/auth/reauth')).data;
  assert.equal(st.recent, false); assert.equal(st.method, 'sso');
});

test('the SSO round-trip asks for a fresh sign-in, checks auth_time and subject, and opens the signing window', async () => {
  const id = makeSsoUser('ssosign', 'sub-sign');
  const c = await ssoSignIn('sub-sign');
  makeStale(id);
  const note = await draftNote(c);
  const { url, cb } = await reauthRoundTrip(c, `#/notes/${note}`, () => ({ sub: 'sub-sign', auth_time: now() }));
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.get('max_age'), '0');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), `/#/notes/${note}?sso_reauth=ok`);
  assert.ok(!cb.headers.getSetCookie().some((x) => x.startsWith('suds_session=') && !/Max-Age=0/.test(x)), 'no new session: the existing one is re-authenticated');
  assert.equal((await c.get('/api/auth/reauth')).data.recent, true);
  const signed = await c.post(`/api/notes/${note}/sign`, { confirm: true });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='auth.oidc.reauth' AND user_id=? AND success=1`, id));
});

test('a stale auth_time, a missing one, or another person\'s identity does not re-authenticate', async () => {
  const id = makeSsoUser('ssobad', 'sub-bad');
  const c = await ssoSignIn('sub-bad');
  for (const [tok, reason] of [
    [{ sub: 'sub-bad', auth_time: now() - 3600 }, 'stale'],   // the provider reused an old sign-in (ignored max_age)
    [{ sub: 'sub-bad', auth_time: undefined }, 'stale'],
    [{ sub: 'someone-else', auth_time: now() }, 'mismatch'],
  ]) {
    makeStale(id);
    const { cb } = await reauthRoundTrip(c, '#/notes', () => tok);
    assert.equal(cb.headers.get('location'), `/#/notes?sso_reauth=${reason}`);
    assert.equal((await c.get('/api/auth/reauth')).data.recent, false, reason);
  }
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='auth.oidc.reauth' AND user_id=? AND success=0`, id));
});

test('a session revoked while the person was at the provider is not re-authenticated', async () => {
  const id = makeSsoUser('ssorevoked', 'sub-revoked');
  const c = await ssoSignIn('sub-revoked');
  makeStale(id);
  const st = await c.post('/api/auth/oidc/reauth', { return: '#/notes' });
  const url = new URL(st.data.url);
  const oc = st.headers.getSetCookie().find((x) => x.startsWith('suds_oidc=')).split(';')[0];
  db.run(`UPDATE sessions SET revoked_at=? WHERE user_id=?`, db.now(), id);
  tokenResponder = () => ({ id_token: signJwt(claims({ sub: 'sub-revoked', nonce: url.searchParams.get('nonce') })) });
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=y&state=${url.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oc } });
  assert.equal(cb.headers.get('location'), '/#/login?oidc_error=session_ended');
  assert.equal(db.one(`SELECT COUNT(*) n FROM sessions WHERE user_id=? AND revoked_at IS NULL`, id).n, 0);
});

test('the return address is only ever a path in this app', async () => {
  const id = makeSsoUser('ssoret', 'sub-ret');
  const c = await ssoSignIn('sub-ret');
  makeStale(id);
  const { cb } = await reauthRoundTrip(c, '//evil.example/#/x', () => ({ sub: 'sub-ret' }));
  assert.equal(cb.headers.get('location'), '/#/dashboard?sso_reauth=ok');
});

test('start: needs a session and a linked account; an unreachable provider gets a clear message', async () => {
  assert.equal((await fetch(`${base}/api/auth/oidc/reauth`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: '{}' })).status, 401);
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,password_changed_at) VALUES(?,?,?,?,?,?)`, uuid(), 'localonly', hashPassword('LocalPassw0rd!x'), 'Local', 'navigator', db.now());
  const admin = await (async () => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify({ username: 'localonly', password: 'LocalPassw0rd!x' }) });
    return client(r.headers.getSetCookie().find((x) => x.startsWith('suds_session=')).split(';')[0]);
  })();
  const notLinked = await admin.post('/api/auth/oidc/reauth', { return: '#/notes' });
  assert.equal(notLinked.status, 400);
  assert.equal((await admin.get('/api/auth/reauth')).data.sso, false);
  makeSsoUser('ssodown', 'sub-down');
  const c = await ssoSignIn('sub-down');
  const saved = config.oidc.issuer;
  config.oidc.issuer = 'http://127.0.0.1:9'; oidc._resetCacheForTests();
  try {
    const r = await c.post('/api/auth/oidc/reauth', { return: '#/notes' });
    assert.equal(r.status, 502);
    assert.match(r.data.error, /could not reach the identity provider/i);
  } finally { config.oidc.issuer = saved; oidc._resetCacheForTests(); }
});

test('an SSO-linked account that also has a SUDS password can use either', async () => {
  const id = makeSsoUser('ssoboth', 'sub-both', { password: 'BothPassw0rd!x' });
  const c = await ssoSignIn('sub-both');
  const st = (await c.get('/api/auth/reauth')).data;
  assert.equal(st.method, 'password'); assert.equal(st.sso, true);
  makeStale(id);
  const { cb } = await reauthRoundTrip(c, '#/notes', () => ({ sub: 'sub-both' }));
  assert.equal(cb.headers.get('location'), '/#/notes?sso_reauth=ok');
});
