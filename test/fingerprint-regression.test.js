'use strict';
// People WITHOUT passkeys see SUDS exactly as on 1.18.0 (docs/FINGERPRINT.md): password only, password and an
// authenticator app, and single sign-on; signing in in the browser and on a device (sync), signing a note,
// countersigning, approving time and spending, and the key backup. Each flow's status codes and the fields 1.18.0
// answered with are collected into one table, which must equal EXPECTED under every combination of "Allow fingerprint
// sign-in" and "Allow fingerprint to confirm signatures and approvals", with "Require fingerprint or authenticator for
// signing" off (its default). EXPECTED was produced by running this very file against 1.18.0 (39e397e), where the
// passkey settings do not exist: `REGRESSION_PRINT=<file> node --test test/fingerprint-regression.test.js` writes the table.
process.env.MFA_REQUIRED_ROLES = '';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const config = require('../server/config');
const oidc = require('../server/oidc');
const H = require('./helpers');
const { totp, encrypt, uuid } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
const APW = 'AdminPassw0rd!x';
const SECRET = 'JBSWY3DPEHPK3PXP';
const setting = (k, v) => { if (v === null) H.db.run(`DELETE FROM settings WHERE key=?`, k); else H.db.setSetting(k, v); };
const resetLimits = () => { const app = require('../server/app'); for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) { app.rateLimitReset(`login:${ip}`); app.rateLimitReset(`api:${ip}`); } };
const yearFrom = (years) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + years); return d.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const stale = (userId) => H.db.run(`UPDATE sessions SET reauth_at=? WHERE user_id=? AND revoked_at IS NULL`, new Date(Date.now() - 60 * 60000).toISOString(), userId);
let step = 0; // each code a step of its own, so none is refused as already used
const code = () => { H.db.run(`UPDATE users SET totp_last_step=NULL`); return totp(SECRET, Date.now() + (step++ % 2 ? 30_000 : 0)); };

// ---- a fake identity provider for the single sign-on flows (as test/oidc-reauth.test.js) ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64url = (b) => Buffer.from(b).toString('base64url');
const signJwt = (payload) => { const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })); const p = b64url(JSON.stringify(payload)); return `${h}.${p}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey))}`; };
let idp, idpBase, base, admin;
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
  admin = H.client(); await admin.login('admin', APW);
});
after(async () => { await H.stop(); await new Promise((r) => idp.close(r)); });

/** A session cookie from a single sign-on through the fake provider. */
async function ssoSignIn(sub) {
  oidc._resetCacheForTests();
  const s = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const loc = new URL(s.headers.get('location'));
  const oc = s.headers.getSetCookie().find((c) => c.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(claims({ sub, nonce: loc.searchParams.get('nonce') })) });
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=x&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oc } });
  return { c: cookieClient(cb.headers.getSetCookie().find((x) => x.startsWith('suds_session=')).split(';')[0]), location: cb.headers.get('location') };
}
/** A client held to one session cookie (the single sign-on's; the provider's own cookies are not mixed in). */
function cookieClient(cookie) {
  const req = async (method, path, body) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : null, headers: r.headers };
  };
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b) };
}
async function ssoReauth(c, sub) {
  const st = await c.post('/api/auth/oidc/reauth', { return: '#/notes' });
  const url = new URL(st.data.url);
  const oc = st.headers.getSetCookie().find((x) => x.startsWith('suds_oidc=')).split(';')[0];
  tokenResponder = () => ({ id_token: signJwt(claims({ sub, nonce: url.searchParams.get('nonce') })) });
  const cb = await fetch(`${base}/api/auth/oidc/callback?code=y&state=${url.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: oc } });
  return cb.headers.get('location');
}

let seq = 0;
function user(role, { withTotp = false, sso = false, ssoOnly = false } = {}) {
  const u = H.makeUser(`reg_${role}_${++seq}`, role);
  if (withTotp) H.db.run(`UPDATE users SET mfa_enabled=1, mfa_secret_enc=? WHERE id=?`, encrypt(SECRET), u.id);
  if (sso || ssoOnly) { u.sub = `sub-${uuid()}`; H.db.run(`UPDATE users SET oidc_subject=?${ssoOnly ? `, password_hash='!scim-provisioned-no-password'` : ''} WHERE id=?`, u.sub, u.id); }
  return u;
}
/** A browser sign-in, finished with the code when one is owed. */
async function signIn(u) {
  resetLimits();
  const c = H.client(); const l = await c.post('/api/auth/login', { username: u.username, password: PW });
  if (l.data.mfaPending) await c.post('/api/auth/mfa/verify', { code: code() });
  return c;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));
const LOGIN_FIELDS = ['mfaPending', 'mfaSetupRequired'];
const REAUTH_FIELDS = ['recent', 'method', 'sso', 'window_minutes'];
const ERR_FIELDS = ['reauthRequired', 'method', 'sso', 'mfaRequired', 'mfaSetupRequired'];
const res = (r, fields = ERR_FIELDS) => ({ status: r.status, ...pick(r.data, fields) });

async function sweep() {
  const out = {};
  const clientId = (await admin.post('/api/clients', { first_name: 'Regression', last_name: `Client${++seq}` })).data.id;

  // ---- signing in: browser and device, with and without a role that requires two-step verification ----
  const pw = user('navigator'); const tp = user('navigator', { withTotp: true });
  for (const [name, u] of [['password', pw], ['totp', tp]]) {
    for (const required of [false, true]) {
      setting('mfa_required_roles', required ? 'navigator' : null); setting('mfa_grace_days', required ? '0' : null);
      const tag = `${name}${required ? ' (role requires 2SV, past grace)' : ''}`;
      resetLimits();
      const c = H.client(); const l = await c.post('/api/auth/login', { username: u.username, password: PW });
      const browser = { login: res(l, LOGIN_FIELDS), deadline: !!l.data.mfaSetupDeadline, before: (await c.get('/api/clients?limit=1')).status };
      if (l.data.mfaPending) { browser.verify = (await c.post('/api/auth/mfa/verify', { code: code() })).status; browser.after = (await c.get('/api/clients?limit=1')).status; }
      out[`browser sign-in: ${tag}`] = browser;
      resetLimits();
      const d = H.client(); d.setHeader('X-Sync-Client', '1'); d.setHeader('X-Device-Id', `reg-dev-${u.id}`);
      const dl = await d.post('/api/auth/login', { username: u.username, password: PW });
      const bearer = { Authorization: 'Bearer ' + dl.data.token, Cookie: '' };
      const device = { login: res(dl, LOGIN_FIELDS), token: !!dl.data.token, deadline: !!dl.data.mfaSetupDeadline, pull: res(await d.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', bearer)) };
      if (dl.data.mfaPending) { device.verify = (await d.post('/api/auth/mfa/verify', { code: code() }, bearer)).status; device.pullAfter = res(await d.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', bearer)); }
      out[`device sign-in: ${tag}`] = device;
    }
  }
  setting('mfa_required_roles', null); setting('mfa_grace_days', null);

  // ---- single sign-on ----
  const so = user('navigator', { ssoOnly: true }); const st = user('navigator', { sso: true, withTotp: true });
  const s1 = await ssoSignIn(so.sub);
  out['sso sign-in'] = { location: s1.location, me: (await s1.c.get('/api/auth/me')).status, reauth: pick((await s1.c.get('/api/auth/reauth')).data, REAUTH_FIELDS) };
  const s2 = await ssoSignIn(st.sub);
  out['sso sign-in with an authenticator app'] = { location: s2.location, before: (await s2.c.get('/api/clients?limit=1')).status, verify: (await s2.c.post('/api/auth/mfa/verify', { code: code() })).status, after: (await s2.c.get('/api/clients?limit=1')).status };

  // ---- signing a note ----
  const draft = async (c) => { const r = await c.post('/api/notes', { client_id: clientId, kind: 'admin', title: 'Visit', content: `Regression note ${++seq}`, occurred_at: new Date().toISOString() }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  for (const [name, u, proof, bad] of [['password', pw, () => ({ password: PW }), { password: 'Wrong-password-1!' }], ['totp', tp, () => ({ code: code() }), { code: '000000' }]]) {
    const c = await signIn(u);
    const r = { reauth: pick((await c.get('/api/auth/reauth')).data, REAUTH_FIELDS), inWindow: res(await c.post(`/api/notes/${await draft(c)}/sign`, { confirm: true })) };
    stale(u.id);
    const n = await draft(c);
    r.staleReauth = pick((await c.get('/api/auth/reauth')).data, REAUTH_FIELDS);
    r.staleConfirm = res(await c.post(`/api/notes/${n}/sign`, { confirm: true }));
    r.wrongProof = res(await c.post(`/api/notes/${n}/sign`, { ...bad, confirm: true }));
    H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL`); resetLimits();
    r.proof = res(await c.post(`/api/notes/${n}/sign`, { ...proof(), confirm: true }));
    const signed = H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, n);
    r.identity = signed ? JSON.parse(signed.details).identity : null;
    r.afterProof = res(await c.post(`/api/notes/${await draft(c)}/sign`, { confirm: true }));
    out[`sign a note: ${name}`] = r;
  }
  {
    const c = (await ssoSignIn(so.sub)).c;
    const r = { inWindow: res(await c.post(`/api/notes/${await draft(c)}/sign`, { confirm: true })) };
    stale(so.id);
    const n = await draft(c);
    r.staleConfirm = res(await c.post(`/api/notes/${n}/sign`, { confirm: true }));
    r.password = res(await c.post(`/api/notes/${n}/sign`, { password: PW, confirm: true }));
    r.reauth = await ssoReauth(c, so.sub);
    r.afterReauth = res(await c.post(`/api/notes/${n}/sign`, { confirm: true }));
    out['sign a note: sso'] = r;
  }

  // ---- countersigning ----
  const worker = user('navigator', { withTotp: false }); const wc = await signIn(worker);
  const toCosign = [];
  for (let i = 0; i < 4; i++) { const id = await draft(wc); await wc.post(`/api/notes/${id}/request-cosign`, {}); await wc.post(`/api/notes/${id}/sign`, { confirm: true }); toCosign.push(id); }
  for (const [name, u, proof] of [['password', user('supervisor'), () => ({ password: PW })], ['totp', user('supervisor', { withTotp: true }), () => ({ code: code() })]]) {
    const c = await signIn(u);
    const [a, b, x, y] = name === 'password' ? toCosign.slice(0, 4) : [];
    const r = {};
    if (name === 'password') {
      r.inWindow = res(await c.post(`/api/notes/${a}/cosign`, { confirm: true }));
      stale(u.id);
      r.staleConfirm = res(await c.post(`/api/notes/${b}/cosign`, { confirm: true }));
      r.proof = res(await c.post(`/api/notes/${b}/cosign`, { ...proof(), confirm: true }));
      stale(u.id);
      r.batchStale = res(await c.post('/api/notes/cosign-batch', { ids: [x, y], confirm: true }));
      r.batchProof = res(await c.post('/api/notes/cosign-batch', { ids: [x, y], ...proof(), confirm: true }));
    } else {
      const ids = [];
      for (let i = 0; i < 2; i++) { const id = await draft(wc); await wc.post(`/api/notes/${id}/request-cosign`, {}); await wc.post(`/api/notes/${id}/sign`, { confirm: true }); ids.push(id); }
      stale(u.id);
      r.staleConfirm = res(await c.post(`/api/notes/${ids[0]}/cosign`, { confirm: true }));
      r.proof = res(await c.post(`/api/notes/${ids[0]}/cosign`, { ...proof(), confirm: true }));
      r.inWindowAfterProof = res(await c.post(`/api/notes/${ids[1]}/cosign`, { confirm: true }));
    }
    out[`countersign: ${name}`] = r;

    // ---- approving time and spending: no proof asked, as before ----
    const mkTime = async () => { const t = (await wc.post('/api/time', { work_date: today(), minutes: 30, category: 'documentation' })).data.id; await wc.post(`/api/time/${t}/submit`, {}); return t; };
    const fund = (await admin.post('/api/budget/funds', { name: `Regression fund ${++seq}`, source_type: 'other', fiscal_year_start: yearFrom(-1), fiscal_year_end: yearFrom(1), total_amount: 100000 })).data.id;
    const mkExp = async () => (await wc.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: today(), amount: 5, category: 'client_assistance' })).data.id;
    stale(u.id);
    const t1 = await mkTime(); const t2 = await mkTime(); const t3 = await mkTime(); const t4 = await mkTime();
    const e1 = await mkExp(); const e2 = await mkExp();
    out[`approve: ${name}`] = {
      time: res(await c.post(`/api/time/${t1}/approve`, { decision: 'approved' })),
      timeReturned: res(await c.post(`/api/time/${t2}/approve`, { decision: 'rejected', note: 'Wrong day' })),
      timeBatch: res(await c.post('/api/time/approve-batch', { ids: [t3, t4], decision: 'approved' })),
      statuses: [t1, t2, t3, t4].map(t => H.db.one(`SELECT status FROM time_entries WHERE id=?`, t).status),
      expenditure: res(await c.post(`/api/budget/expenditures/${e1}/approve`, { status: 'approved' })),
      expenditureRejected: res(await c.post(`/api/budget/expenditures/${e2}/approve`, { status: 'rejected', note: 'Not an eligible cost' })),
      expStatuses: [e1, e2].map(e => H.db.one(`SELECT status FROM expenditures WHERE id=?`, e).status),
    };
  }

  // ---- the key backup ----
  const was = config.keySource; const hadKeys = fs.existsSync(config.keysJsonPath);
  try {
    config.keySource = 'file';
    if (!hadKeys) fs.writeFileSync(config.keysJsonPath, JSON.stringify({ SUDS_ENCRYPTION_KEY: 'c'.repeat(64) }));
    for (const [name, u, proof, bad] of [['password', user('admin'), () => ({ password: PW }), { password: 'Wrong-password-1!' }], ['totp', user('admin', { withTotp: true }), () => ({ code: code() }), { code: '000000' }]]) {
      const c = await signIn(u); resetLimits();
      out[`key backup: ${name}`] = {
        confirmOnly: res(await c.post('/api/admin/keys-backup', { confirm: true })),
        nothing: res(await c.post('/api/admin/keys-backup', {})),
        wrong: res(await c.post('/api/admin/keys-backup', bad)),
        proof: (H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL`), resetLimits(), res(await c.post('/api/admin/keys-backup', proof()))),
      };
    }
  } finally { config.keySource = was; if (!hadKeys) fs.rmSync(config.keysJsonPath, { force: true }); H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL`); }
  return out;
}

// What 1.18.0 answered (see the top of this file for how it was produced).
const EXPECTED = {
  'browser sign-in: password': { login: { status: 200, mfaPending: false, mfaSetupRequired: false }, deadline: false, before: 200 },
  'device sign-in: password': { login: { status: 200, mfaPending: false, mfaSetupRequired: false }, token: true, deadline: false, pull: { status: 200 } },
  'browser sign-in: password (role requires 2SV, past grace)': { login: { status: 200, mfaPending: false, mfaSetupRequired: true }, deadline: true, before: 403 },
  'device sign-in: password (role requires 2SV, past grace)': { login: { status: 200, mfaPending: false, mfaSetupRequired: true }, token: true, deadline: true, pull: { status: 403, mfaSetupRequired: true } },
  'browser sign-in: totp': { login: { status: 200, mfaPending: true, mfaSetupRequired: false }, deadline: false, before: 401, verify: 200, after: 200 },
  'device sign-in: totp': { login: { status: 200, mfaPending: true, mfaSetupRequired: false }, token: true, deadline: false, pull: { status: 401, mfaRequired: true }, verify: 200, pullAfter: { status: 200 } },
  'browser sign-in: totp (role requires 2SV, past grace)': { login: { status: 200, mfaPending: true, mfaSetupRequired: false }, deadline: false, before: 401, verify: 200, after: 200 },
  'device sign-in: totp (role requires 2SV, past grace)': { login: { status: 200, mfaPending: true, mfaSetupRequired: false }, token: true, deadline: false, pull: { status: 401, mfaRequired: true }, verify: 200, pullAfter: { status: 200 } },
  'sso sign-in': { location: '/#/dashboard', me: 200, reauth: { recent: true, method: 'sso', sso: true, window_minutes: 10 } },
  'sso sign-in with an authenticator app': { location: '/#/mfa', before: 401, verify: 200, after: 200 },
  'sign a note: password': { reauth: { recent: true, method: 'password', sso: false, window_minutes: 10 }, inWindow: { status: 200 }, staleReauth: { recent: false, method: 'password', sso: false, window_minutes: 10 }, staleConfirm: { status: 403, reauthRequired: true, method: 'password', sso: false }, wrongProof: { status: 403 }, proof: { status: 200 }, identity: 'password', afterProof: { status: 200 } },
  'sign a note: totp': { reauth: { recent: true, method: 'totp', sso: false, window_minutes: 10 }, inWindow: { status: 200 }, staleReauth: { recent: false, method: 'totp', sso: false, window_minutes: 10 }, staleConfirm: { status: 403, reauthRequired: true, method: 'totp', sso: false }, wrongProof: { status: 403 }, proof: { status: 200 }, identity: 'totp', afterProof: { status: 200 } },
  'sign a note: sso': { inWindow: { status: 200 }, staleConfirm: { status: 403, reauthRequired: true, method: 'sso', sso: true }, password: { status: 403 }, reauth: '/#/notes?sso_reauth=ok', afterReauth: { status: 200 } },
  'countersign: password': { inWindow: { status: 200 }, staleConfirm: { status: 403, reauthRequired: true, method: 'password', sso: false }, proof: { status: 200 }, batchStale: { status: 403, reauthRequired: true, method: 'password', sso: false }, batchProof: { status: 200 } },
  'approve: password': { time: { status: 200 }, timeReturned: { status: 200 }, timeBatch: { status: 200 }, statuses: ['approved', 'rejected', 'approved', 'approved'], expenditure: { status: 200 }, expenditureRejected: { status: 200 }, expStatuses: ['approved', 'rejected'] },
  'countersign: totp': { staleConfirm: { status: 403, reauthRequired: true, method: 'totp', sso: false }, proof: { status: 200 }, inWindowAfterProof: { status: 200 } },
  'approve: totp': { time: { status: 200 }, timeReturned: { status: 200 }, timeBatch: { status: 200 }, statuses: ['approved', 'rejected', 'approved', 'approved'], expenditure: { status: 200 }, expenditureRejected: { status: 200 }, expStatuses: ['approved', 'rejected'] },
  'key backup: password': { confirmOnly: { status: 403, reauthRequired: true, method: 'password', sso: false }, nothing: { status: 403, reauthRequired: true, method: 'password', sso: false }, wrong: { status: 403 }, proof: { status: 200 } },
  'key backup: totp': { confirmOnly: { status: 403, reauthRequired: true, method: 'totp', sso: false }, nothing: { status: 403, reauthRequired: true, method: 'totp', sso: false }, wrong: { status: 403 }, proof: { status: 200 } },
};

test('people without passkeys: every flow as on 1.18.0, whatever the fingerprint settings (strong signing off)', async () => {
  const combos = [[null, null], ['0', '0'], ['1', '0'], ['0', '1'], ['1', '1']];
  for (const [signin, signing] of combos) {
    setting('passkey_signin', signin); setting('passkey_signing', signing); setting('sign_strong_required', '0');
    try {
      resetLimits(); // five sweeps are more requests a minute than one address may send
      const got = await sweep();
      if (process.env.REGRESSION_PRINT) { fs.writeFileSync(process.env.REGRESSION_PRINT, JSON.stringify(got, null, 2)); return; }
      assert.deepStrictEqual(got, EXPECTED, `passkey_signin=${signin} passkey_signing=${signing}`);
    } finally { setting('passkey_signin', null); setting('passkey_signing', null); setting('sign_strong_required', null); }
  }
});
