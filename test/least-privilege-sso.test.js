'use strict';
// 1.17.0, the programme-wide least-privilege default (server/caseload-default.js) on the identity-provider
// paths: an account SCIM provisions as a navigator or clinician starts held to its caseload, as does one a
// group change moves into those roles (and a move out lifts the default's deny). Single sign-on creates no
// account: its first sign-in links the one SCIM made (server/routes/oidc.js linkProvisioned), which keeps the
// deny it was given, so the person's first session is already scoped; an identity nothing was provisioned for
// is refused and no account appears.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const H = require('./helpers');
const config = require('../server/config');
const oidc = require('../server/oidc');
const CD = require('../server/caseload-default');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'lp-key', use: 'sig', alg: 'RS256' };
const signJwt = (payload) => { const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'lp-key' })); const b = b64url(JSON.stringify(payload)); return `${h}.${b}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey))}`; };

let base, admin, token, idp, idpBase, tokenResponder = () => ({ error: 'unset' });
const override = (userId) => H.db.one(`SELECT mode, reason FROM user_permission_overrides WHERE user_id=? AND permission='clients:all'`, userId);
const scim = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); return { status: res.status, data: text ? JSON.parse(text) : null };
};
const provision = (userName, group, externalId) => scim('POST', '/scim/v2/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName, externalId, name: { givenName: 'Test', familyName: userName }, active: true, groups: [{ display: group }] });

before(async () => {
  idp = http.createServer((req, res) => {
    const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/jwks` });
    if (req.url === '/jwks') return send({ keys: [jwk] });
    if (req.url === '/token') { req.resume(); req.on('end', () => send(tokenResponder())); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((res) => idp.listen(0, '127.0.0.1', res));
  idpBase = `http://127.0.0.1:${idp.address().port}`;
  base = await H.start();
  Object.assign(config.oidc, { issuer: idpBase, clientId: 'suds-lp', clientSecret: 'shh', redirectUri: `${idpBase}/cb`, label: 'Sign in', enabled: true });
  oidc._resetCacheForTests();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  token = (await admin.post('/api/admin/scim/tokens', { name: 'Entra' })).data.token;
  assert.equal((await admin.put('/api/admin/settings', { scim_group_roles: 'Navigators=navigator; Clinicians=clinician; Supervisors=supervisor' })).status, 200);
});
after(async () => { config.oidc.enabled = false; await new Promise((res) => idp.close(res)); await H.stop(); });

// Sign in through the fake provider as `claims`; returns the redirect and the session cookie, if any.
async function ssoSignIn(claims) {
  const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  const now = Math.floor(Date.now() / 1000);
  tokenResponder = () => ({ id_token: signJwt({ iss: idpBase, aud: 'suds-lp', exp: now + 300, iat: now, nonce: loc.searchParams.get('nonce'), ...claims }) });
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=x&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: cookie } });
  const session = cb.headers.getSetCookie().find((c) => c.startsWith('suds_session='));
  return { location: cb.headers.get('location'), session: session ? session.split(';')[0] : null };
}

test('SCIM provisions a navigator or clinician held to their caseload (audited); a supervisor is not', async () => {
  const ids = {};
  for (const [name, group] of [['lp.nav@county.gov', 'Navigators'], ['lp.clin@county.gov', 'Clinicians'], ['lp.sup@county.gov', 'Supervisors']]) {
    const r = await provision(name, group, `ext-${name}`);
    assert.equal(r.status, 201, JSON.stringify(r.data)); ids[group] = r.data.id;
  }
  for (const g of ['Navigators', 'Clinicians']) {
    assert.deepEqual(override(ids[g]), { mode: 'deny', reason: CD.REASON }, g);
    const a = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='user.permission.deny' AND entity_id=?`, ids[g]).details);
    assert.equal(a.cause, 'scim_provisioned'); assert.equal(a.permission, 'clients:all');
  }
  assert.equal(override(ids.Supervisors), undefined);
});

test('a SCIM group change into navigator holds the person; out to supervisor lifts the default\'s deny', async () => {
  const r = await provision('lp.mover@county.gov', 'Supervisors', 'ext-mover');
  assert.equal(r.status, 201); const id = r.data.id;
  assert.equal(override(id), undefined);
  const patch = (group) => scim('PATCH', `/scim/v2/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'roles', value: [{ value: group }] }] });
  // Entra sends the mapped group as a role value; the mapping turns it into the SUDS role.
  let p = await patch('Navigators');
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(H.db.one(`SELECT role FROM users WHERE id=?`, id).role, 'navigator');
  assert.deepEqual(override(id), { mode: 'deny', reason: CD.REASON });
  p = await patch('Supervisors');
  assert.equal(p.status, 200);
  assert.equal(override(id), undefined, 'a supervisor sees every client');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='user.permission.revoke' AND entity_id=?`, id));
});

test('single sign-on links the provisioned navigator at first sign-in and the first session is caseload-scoped', async () => {
  const id = H.db.one(`SELECT id FROM users WHERE username='lp.nav@county.gov'`).id;
  const s = await ssoSignIn({ sub: 'sub-lp-nav', oid: 'ext-lp.nav@county.gov' });
  assert.equal(s.location, '/#/dashboard'); assert.ok(s.session);
  assert.equal(H.db.one(`SELECT oidc_subject FROM users WHERE id=?`, id).oidc_subject, 'sub-lp-nav');
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: s.session, 'X-Requested-With': 'suds' } })).json();
  assert.equal(me.user.caseload_restricted, true);
  assert.ok(me.user.denied_permissions.includes('clients:all'));
  assert.deepEqual(override(id), { mode: 'deny', reason: CD.REASON }, 'linking kept the deny');
});

test('an identity nothing was provisioned for is refused, and no account is created', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM users`).n;
  const s = await ssoSignIn({ sub: 'sub-stranger', preferred_username: 'stranger@county.gov' });
  assert.equal(s.location, '/#/login?oidc_error=not_linked'); assert.equal(s.session, null);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM users`).n, before);
});

test('with the default off, SCIM provisions a navigator who sees every client', async () => {
  assert.equal((await admin.put('/api/users/caseload-default', { enabled: false })).status, 200);
  const r = await provision('lp.open@county.gov', 'Navigators', 'ext-open');
  assert.equal(r.status, 201);
  assert.equal(override(r.data.id), undefined);
  assert.equal((await admin.put('/api/users/caseload-default', { enabled: true })).status, 200);
});
