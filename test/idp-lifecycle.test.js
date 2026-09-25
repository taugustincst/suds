'use strict';
// The identity provider as the source of truth for who may sign in: trusting its multi-factor sign-in in
// place of SUDS TOTP (off by default, audited), linking an account SCIM provisioned on its first SSO sign-in,
// and disabling SSO accounts the provider has not vouched for in N days, with their sessions and devices.
process.env.SUDS_ENV = 'test';
process.env.SUDS_DB_PATH = ':memory:';
process.env.MFA_REQUIRED_ROLES = 'admin,supervisor,clinician,navigator,finance,readonly';
process.env.MFA_GRACE_DAYS = '0';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const config = require('../server/config');
const db = require('../server/db');
const oidc = require('../server/oidc');
const { createHandler } = require('../server/app');
const { ensureBootstrap } = require('../server/bootstrap');
const { uuid, encrypt, generateTotpSecret } = require('../server/crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const signJwt = (payload) => { const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })); const b = b64url(JSON.stringify(payload)); return `${h}.${b}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey))}`; };

let idp, idpBase, server, base; let claimsFor = () => ({});
before(async () => {
  idp = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/jwks` });
    if (req.url === '/jwks') return send({ keys: [jwk] });
    if (req.url === '/token') { let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => send({ id_token: signJwt({ iss: idpBase, aud: config.oidc.clientId, exp: Math.floor(Date.now() / 1000) + 300, ...claimsFor() }) })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  idpBase = `http://127.0.0.1:${idp.address().port}`;
  Object.assign(config.oidc, { issuer: idpBase, clientId: 'suds-idp-test', clientSecret: 's', redirectUri: `${idpBase}/cb`, label: 'SSO', enabled: true });
  db.open(); ensureBootstrap();
  server = http.createServer(createHandler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => idp.close(r)); db.close(); });
beforeEach(() => oidc._resetCacheForTests());

/** A full SSO round trip; `extra` are claims beyond iss/aud/exp/nonce. Returns the callback's location and session cookie. */
async function ssoSignIn(extra) {
  const s = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(s.headers.get('location'));
  const cookie = s.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  claimsFor = () => ({ nonce: loc.searchParams.get('nonce'), ...extra });
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=x&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: cookie } });
  const sess = (cb.headers.getSetCookie().find((c) => c.startsWith('suds_session=')) || '').split(';')[0];
  return { location: cb.headers.get('location'), cookie: sess, authorize: loc };
}
const get = (p, cookie) => fetch(base + p, { headers: { Cookie: cookie, 'X-Requested-With': 'suds' } });
function ssoUser(username, sub, { mfa = false, createdAt = '2020-01-01T00:00:00.000Z' } = {}) {
  const id = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,oidc_subject,password_changed_at,created_at,mfa_enabled,mfa_secret_enc) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, username, 'x', username, 'navigator', sub, db.now(), createdAt, mfa ? 1 : 0, mfa ? encrypt(generateTotpSecret()) : null);
  return id;
}

test('trust off (the default): an SSO sign-in still needs SUDS two-step verification, whatever amr says', async () => {
  const id = ssoUser('mfa-off', 'sub-off', { mfa: true });
  const r = await ssoSignIn({ sub: 'sub-off', amr: ['pwd', 'mfa'] });
  assert.equal(r.location, '/#/mfa');
  assert.equal(db.one(`SELECT mfa_pending FROM sessions WHERE user_id=?`, id).mfa_pending, 1);
  // Past the enrolment deadline with no SUDS authenticator: blocked, as before.
  const id2 = ssoUser('mfa-none', 'sub-none');
  const r2 = await ssoSignIn({ sub: 'sub-none', amr: ['mfa'] });
  assert.equal((await get('/api/clients', r2.cookie)).status, 403);
  assert.ok(id2);
});

test('trust on: amr mfa or two factor kinds (or a configured acr) completes the sign-in without the SUDS code, audited as such', async () => {
  db.setSetting('sso_trust_idp_mfa', '1'); db.setSetting('sso_mfa_acr_values', 'urn:county:mfa');
  try {
    const id = ssoUser('mfa-trusted', 'sub-trusted', { mfa: true });
    const r = await ssoSignIn({ sub: 'sub-trusted', amr: ['pwd', 'mfa'] });
    assert.equal(r.location, '/#/dashboard');
    const s = db.one(`SELECT mfa_pending, mfa_source FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1`, id);
    assert.equal(s.mfa_pending, 0); assert.equal(s.mfa_source, 'idp');
    const log = JSON.parse(db.one(`SELECT details FROM audit_log WHERE action='auth.oidc.login' AND user_id=? ORDER BY id DESC LIMIT 1`, id).details);
    assert.equal(log.mfa, 'idp'); assert.equal(log.via, 'amr:mfa');
    // An account with no SUDS authenticator, past its deadline, reaches records on the provider's MFA.
    ssoUser('mfa-idp-only', 'sub-idp-only');
    const r2 = await ssoSignIn({ sub: 'sub-idp-only', amr: ['hwk', 'pin'] });
    assert.equal((await get('/api/clients', r2.cookie)).status, 200);
    // A hardware key alone is one factor (RFC 8176): not MFA, so no records without the SUDS code.
    const r2b = await ssoSignIn({ sub: 'sub-idp-only', amr: ['hwk'] });
    assert.equal((await get('/api/clients', r2b.cookie)).status, 403);
    // acr instead of amr, and the acr asked for at the provider.
    const r3 = await ssoSignIn({ sub: 'sub-idp-only', acr: 'urn:county:mfa' });
    assert.equal((await get('/api/clients', r3.cookie)).status, 200);
    assert.equal(r3.authorize.searchParams.get('acr_values'), 'urn:county:mfa');
    // No MFA asserted: back to the SUDS second factor (pending for an enrolled account, blocked for the other).
    const r4 = await ssoSignIn({ sub: 'sub-trusted', amr: ['pwd'] });
    assert.equal(r4.location, '/#/mfa');
    const r5 = await ssoSignIn({ sub: 'sub-idp-only', amr: ['pwd'], acr: 'something-else' });
    assert.equal((await get('/api/clients', r5.cookie)).status, 403);
    assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='auth.oidc.login' AND details LIKE '%not asserted%'`));
  } finally { db.run(`DELETE FROM settings WHERE key IN ('sso_trust_idp_mfa','sso_mfa_acr_values')`); }
});

test('what counts as the provider multi-factor sign-in, and Security status says whether it is trusted', async () => {
  assert.equal(oidc.idpMfa({ amr: ['pwd'] }).ok, false);
  // RFC 8176: otp, hwk, swk, sms alone are single factors; two of the same kind are still one kind.
  for (const amr of ['otp', ['otp'], ['hwk'], ['swk'], ['sms'], ['otp', 'sms'], ['hwk', 'swk'], ['pwd', 'kba'], ['fpt', 'face'], ['pwd', 'user'], []]) {
    assert.equal(oidc.idpMfa({ amr }).ok, false, JSON.stringify(amr));
  }
  // mfa itself, or two factors of different kinds (knowledge / possession / inherence).
  for (const amr of [['mfa'], 'mfa', ['pwd', 'mfa'], ['pwd', 'otp'], ['pwd', 'hwk'], ['hwk', 'pin'], ['swk', 'pin'], ['fpt', 'hwk'], ['face', 'swk'], ['PWD', 'OTP'], ['pwd', 'sms'], ['sc', 'pin']]) {
    assert.equal(oidc.idpMfa({ amr }).ok, true, JSON.stringify(amr));
  }
  assert.equal(oidc.idpMfa({ amr: ['pwd', 'otp'] }).via, 'amr:pwd+otp');
  assert.equal(oidc.idpMfa({ amr: ['otp'], acr: 'gold' }).ok, false);
  assert.equal(oidc.idpMfa({ acr: 'gold' }, { acrValues: ['gold'] }).via, 'acr:gold');
  db.setSetting('sso_trust_idp_mfa', '1');
  try {
    const item = require('../server/security-status').status().items.find((i) => i.name === "Identity provider's multi-factor sign-in");
    assert.match(item.value, /trusted in place of SUDS/);
  } finally { db.run(`DELETE FROM settings WHERE key='sso_trust_idp_mfa'`); }
  assert.match(require('../server/security-status').status().items.find((i) => i.name === "Identity provider's multi-factor sign-in").value, /not trusted/);
});

test('an account SCIM provisioned is linked on its first SSO sign-in (by oid or username); an account made in SUDS is not', async () => {
  const provisioned = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,password_changed_at,scim_external_id) VALUES(?,?,?,?,?,?,?)`, provisioned, 'lee@county.gov', '!scim-provisioned-no-password', 'Lee', 'navigator', db.now(), 'oid-lee');
  const local = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,password_changed_at) VALUES(?,?,?,?,?,?)`, local, 'kim@county.gov', 'x', 'Kim', 'navigator', db.now());
  const r = await ssoSignIn({ sub: 'pairwise-sub-lee', oid: 'oid-lee' });
  assert.notEqual(r.location, '/#/login?oidc_error=not_linked');
  assert.equal(db.one(`SELECT oidc_subject FROM users WHERE id=?`, provisioned).oidc_subject, 'pairwise-sub-lee');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='user.oidc_linked' AND entity_id=?`, provisioned));
  const k = await ssoSignIn({ sub: 'sub-kim', preferred_username: 'kim@county.gov' });
  assert.equal(k.location, '/#/login?oidc_error=not_linked', 'an account made in SUDS is linked only by an administrator');
  assert.equal(db.one(`SELECT oidc_subject FROM users WHERE id=?`, local).oidc_subject, null);
});

test('deprovisioning: SSO accounts not seen for N days are disabled with their sessions and devices; recent ones and break-glass accounts are not', async () => {
  const deprov = require('../server/deprovision');
  assert.deepEqual(deprov.run().disabled, [], 'off by default');
  const stale = ssoUser('gone@county.gov', 'sub-gone', { createdAt: '2020-01-01T00:00:00.000Z' });
  db.run(`UPDATE users SET idp_seen_at='2020-02-01T00:00:00.000Z', last_login_at='2020-02-01T00:00:00.000Z' WHERE id=?`, stale);
  db.run(`INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at) VALUES('sess-gone',?,?,?,?)`, stale, db.now(), db.now(), new Date(Date.now() + 3600_000).toISOString());
  db.run(`INSERT INTO devices(id,user_id,label) VALUES('dev-gone',?,'tablet')`, stale);
  const fresh = ssoUser('here@county.gov', 'sub-here');
  db.run(`UPDATE users SET idp_seen_at=? WHERE id=?`, db.now(), fresh);
  const glass = ssoUser('glass', 'sub-glass');
  db.run(`UPDATE users SET idp_seen_at='2019-01-01T00:00:00.000Z' WHERE id=?`, glass);
  db.setSetting('sso_emergency_accounts', 'glass');
  db.setSetting('sso_deprovision_days', '30');
  try {
    const rep = deprov.report();
    assert.ok(rep.due.some((u) => u.id === stale) && !rep.due.some((u) => u.id === fresh) && !rep.due.some((u) => u.id === glass));
    const out = deprov.run();
    assert.ok(out.disabled.some((u) => u.id === stale));
    assert.equal(db.one(`SELECT is_active FROM users WHERE id=?`, stale).is_active, 0);
    assert.equal(db.one(`SELECT is_active FROM users WHERE id=?`, fresh).is_active, 1);
    assert.equal(db.one(`SELECT is_active FROM users WHERE id=?`, glass).is_active, 1, 'never a break-glass account');
    assert.ok(db.one(`SELECT revoked_at FROM sessions WHERE id='sess-gone'`).revoked_at);
    const dev = db.one(`SELECT * FROM devices WHERE id='dev-gone'`);
    assert.ok(dev.revoked_at && dev.wipe_requested_at);
    const log = db.one(`SELECT details FROM audit_log WHERE action='user.deprovisioned' AND entity_id=?`, stale);
    assert.match(log.details, /not seen at the identity provider for 30 days/);
    assert.ok(deprov.report().recent.some((x) => x.user_id === stale), 'and the report lists it');
    // Seen at the provider (an SSO sign-in) keeps an account alive.
    db.run(`UPDATE users SET idp_seen_at='2020-01-01T00:00:00.000Z' WHERE id=?`, fresh);
    await ssoSignIn({ sub: 'sub-here' });
    assert.ok(Date.parse(db.one(`SELECT idp_seen_at FROM users WHERE id=?`, fresh).idp_seen_at) > Date.now() - 60_000);
    assert.equal(deprov.run().disabled.length, 0);
  } finally { db.run(`DELETE FROM settings WHERE key IN ('sso_deprovision_days','sso_emergency_accounts')`); }
});
