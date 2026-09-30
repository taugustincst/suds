'use strict';
// Fingerprint sign-in, authorization and signing with passkeys (docs/FINGERPRINT.md): WebAuthn verified with
// node:crypto alone (server/webauthn.js), driven here by a software authenticator (test/authenticator.js) that
// answers the way a phone does once the finger has matched, and can be bent to answer the ways it must not. Every test
// sets up what it needs (its own people, notes and passkeys), so any one runs on its own and in any order; the review's
// fixes are in test/fingerprint-review.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const H = require('./helpers');
const { SoftAuthenticator, cbor, b64url } = require('./authenticator');
const W = require('../server/webauthn');
const { totp, decrypt, encrypt } = require('../server/crypto');
const config = require('../server/config');

const PW = 'StaffPassw0rd!x';
const APW = 'AdminPassw0rd!x';
let admin, base, clientId;
// Dates are worked out when each test runs, from today: nothing here stops working on a given day.
const today = () => new Date().toISOString().slice(0, 10);
const yearFrom = (years) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + years); return d.toISOString().slice(0, 10); };
const newFund = async () => (await admin.post('/api/budget/funds', { name: `Passkey fund ${crypto.randomUUID().slice(0, 8)}`, source_type: 'other', fiscal_year_start: yearFrom(-1), fiscal_year_end: yearFrom(1), total_amount: 100000 })).data.id;
const resetLimits = () => { const app = require('../server/app'); for (const k of ['passkey-options:127.0.0.1', 'login:127.0.0.1']) app.rateLimitReset(k); };

before(async () => {
  base = await H.start();
  admin = H.client(); await admin.login('admin', APW);
  // The one shared record: a client every role in these tests may see (navigators and clinicians hold clients:all).
  clientId = (await admin.post('/api/clients', { first_name: 'Finger', last_name: 'Print' })).data.id;
});
after(H.stop);

const key = (o = {}) => new SoftAuthenticator({ origin: base, ...o });
async function person(name, role = 'navigator') {
  const u = H.makeUser(name, role);
  const c = H.client(); await c.login(name, PW);
  return { u, c };
}
/** Enrol `a` for the signed-in client `c`: password step, then the new credential. Returns the register response. */
async function enrol(c, a, { password = PW, code, name = 'Test phone', bend } = {}) {
  const o = await c.post('/api/auth/passkeys/register/options', { password, code });
  if (o.status !== 200) return o;
  return c.post('/api/auth/passkeys/register', { credential: a.create(o.data.publicKey, bend), name });
}
async function passkeyLogin(a, { username, bend, client: c = H.client() } = {}) {
  resetLimits();
  const o = await c.post('/api/auth/passkeys/login/options', username ? { username } : {});
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const r = await c.post('/api/auth/passkeys/login', { credential: a.get(o.data.publicKey, bend) });
  return { r, c, options: o.data };
}
/** "Confirm with fingerprint": the challenge for `purpose`, answered by `a`. */
async function confirmWith(c, a, purpose, params = {}, bend) {
  const o = await c.post('/api/auth/passkeys/challenge', { purpose, ...params });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  return a.get(o.data.publicKey, bend);
}
const draft = async (c, content = 'Met at the drop-in; talked about detox.') => (await c.post('/api/notes', { client_id: clientId, kind: 'admin', title: 'Visit', content, occurred_at: new Date().toISOString() })).data.id;
const stale = (userId) => H.db.run(`UPDATE sessions SET reauth_at=? WHERE user_id=? AND revoked_at IS NULL`, new Date(Date.now() - 60 * 60000).toISOString(), userId);
const setting = (k, v) => { if (v === null) H.db.run(`DELETE FROM settings WHERE key=?`, k); else H.db.setSetting(k, v); };
/** A note signed with a fingerprint by a new person: { u, c, a, note, evId }. */
async function signedWithFingerprint(prefix) {
  const p = await person(`${prefix}_${crypto.randomUUID().slice(0, 6)}`);
  const a = key(); assert.equal((await enrol(p.c, a)).status, 201);
  const note = await draft(p.c, `Signed with a fingerprint (${prefix})`);
  const r = await p.c.post(`/api/notes/${note}/sign`, { passkey: await confirmWith(p.c, a, 'note.sign', { note_id: note }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { ...p, a, note, evId: JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, note).details).evidence };
}

// ---------------------------------------------------------------- the verifier on its own
test('CBOR, authenticator data and COSE keys: ES256, EdDSA and RS256 turn into public keys that verify', () => {
  for (const alg of ['ES256', 'EdDSA', 'RS256']) {
    const a = key({ alg });
    const k = W.coseToKey(W.cborDecodeAll(cbor(a.coseKey())));
    assert.equal(k.alg, { ES256: -7, EdDSA: -8, RS256: -257 }[alg]);
    const data = Buffer.from('signed bytes');
    const cd = Buffer.from('{}');
    const sig = a.sign(Buffer.concat([data, crypto.createHash('sha256').update(cd).digest()]));
    assert.ok(W.verifySignature(k.alg, k.key, data, cd, sig), `${alg} signature verifies`);
    assert.ok(!W.verifySignature(k.alg, k.key, Buffer.from('other'), cd, sig), `${alg} signature over other bytes does not`);
  }
  assert.throws(() => W.cborDecodeAll(Buffer.from([0x9f, 0x01, 0xff])), /indefinite/, 'indefinite lengths are refused');
  assert.throws(() => W.cborDecodeAll(Buffer.concat([cbor(1), Buffer.from([0])])), /left over/);
  assert.throws(() => W.coseToKey(new Map([[1, 2], [3, -36]])), /algorithm/, 'an algorithm SUDS did not ask for is refused');
  const ad = W.parseAuthData(key().authData({ flags: 0x45, counter: 7, attested: true }));
  assert.ok(ad.up && ad.uv && ad.credentialId && ad.coseKey instanceof Map);
  assert.equal(ad.signCount, 7);
});

// ---------------------------------------------------------------- enrolment
test('enrolment: the password again, then the device\'s new key; only the public key and its details are stored', async () => {
  const { u, c } = await person('fp_enrol');
  assert.equal((await c.post('/api/auth/passkeys/register/options', {})).status, 400, 'no password, no options');
  const wrong = await c.post('/api/auth/passkeys/register/options', { password: 'Wrong-Passw0rd!' });
  assert.equal(wrong.status, 401);
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, u.id).failed_attempts, 1, 'a wrong password counts toward the lockout');
  const o = await c.post('/api/auth/passkeys/register/options', { password: PW });
  assert.equal(o.status, 200);
  const pk = o.data.publicKey;
  assert.equal(pk.authenticatorSelection.userVerification, 'required', 'user verification is required');
  assert.equal(pk.authenticatorSelection.authenticatorAttachment, 'platform', 'the device\'s own authenticator');
  assert.equal(pk.attestation, 'none', 'no attestation: nothing about the device beyond its model id');
  assert.equal(pk.rp.id, '127.0.0.1');
  assert.deepEqual(pk.pubKeyCredParams.map(p => p.alg), [-7, -8, -19, -257]);
  assert.equal(W.fromB64url(pk.challenge).length, 32, 'a random 32-byte challenge');
  const a = key();
  const r = await c.post('/api/auth/passkeys/register', { credential: a.create(pk), name: "Maria's iPhone" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.passkey.name, "Maria's iPhone");
  const row = H.db.one(`SELECT * FROM passkeys WHERE user_id=?`, u.id);
  assert.equal(row.credential_id, a.id);
  assert.equal(row.alg, -7);
  assert.equal(row.aaguid, 'abababab-abab-abab-abab-abababababab');
  assert.deepEqual(JSON.parse(row.transports), ['internal']);
  assert.ok(crypto.createPublicKey({ key: Buffer.from(row.public_key, 'base64'), format: 'der', type: 'spki' }), 'a public key, SPKI');
  assert.deepEqual(Object.keys(row).sort(), ['aaguid', 'alg', 'backed_up', 'backup_eligible', 'created_at', 'credential_id', 'flag_reason', 'flagged_at', 'id', 'last_used_at', 'name', 'public_key', 'rp_id', 'sign_count', 'transports', 'user_id'].sort(), 'no column could hold a fingerprint');
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, u.id).failed_attempts, 0, 'the right password clears the count');
  const au = H.db.one(`SELECT details FROM audit_log WHERE action='auth.passkey.enrolled' AND user_id=?`, u.id);
  assert.ok(au, 'enrolment is audited');
  assert.ok(!au.details.includes(row.public_key.slice(0, 40)) && !au.details.includes("Maria"), 'without the key or the name');
  const list = await c.get('/api/auth/passkeys');
  assert.equal(list.data.passkeys.length, 1);
  assert.equal(list.data.passkeys[0].public_key, undefined, 'the list does not hand out the key');
  assert.equal((await c.post('/api/auth/passkeys/register', { credential: a.create(pk) })).status, 400, 'the same challenge cannot be answered twice');
  // RS256 and EdDSA enrol too.
  for (const alg of ['EdDSA', 'RS256']) assert.equal((await enrol(c, key({ alg }))).status, 201, alg);
  assert.equal((await c.get('/api/auth/me')).data.user.passkeys, 3);
});

test('enrolment with two-step verification on needs the authenticator code as well', async () => {
  const { u, c } = await person('fp_enrol_totp');
  const secret = (await c.post('/api/auth/mfa/setup', {})).data.secret;
  assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(secret, Date.now() - 30_000) })).status, 200);
  const c2 = H.client(); await c2.login('fp_enrol_totp', PW); await c2.post('/api/auth/mfa/verify', { code: totp(secret) });
  assert.equal((await c2.post('/api/auth/passkeys/register/options', { password: PW })).status, 400, 'the password alone is not enough');
  assert.equal((await c2.post('/api/auth/passkeys/register/options', { password: PW, code: '000000' })).status, 403, 'a wrong code is refused');
  assert.equal((await enrol(c2, key(), { code: totp(secret, Date.now() + 30_000) })).status, 201);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.passkey.enrol.failed' AND user_id=?`, u.id), 'the refused attempt is audited');
});

test('enrolment refuses a wrong origin, another site\'s RP ID, no fingerprint check, no presence, and more than ten', async () => {
  const { u, c } = await person('fp_enrol_bad');
  for (const [bend, code] of [[{ origin: 'https://evil.example' }, 'origin'], [{ rpId: 'evil.example' }, 'rpid'], [{ uv: false }, 'uv'], [{ up: false }, 'up'], [{ type: 'webauthn.get' }, 'type'], [{ crossOrigin: true }, 'origin'], [{ challenge: b64url(crypto.randomBytes(32)) }, 'challenge']]) {
    const r = await enrol(c, key(), { bend });
    assert.equal(r.status, 400, JSON.stringify(bend));
    assert.equal(r.data.passkeyError, code, JSON.stringify(bend));
  }
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, u.id).n, 0);
  for (let i = 0; i < 10; i++) assert.equal((await enrol(c, key({ alg: 'EdDSA' }))).status, 201);
  assert.equal((await c.post('/api/auth/passkeys/register/options', { password: PW })).status, 400, 'ten is the most one account may have');
});

// ---------------------------------------------------------------- sign-in
test('sign in with fingerprint: a discoverable passkey, with or without a username typed; the session needs no code', async () => {
  const { u, c } = await person('fp_login');
  const a = key(); await enrol(c, a);
  const { r, c: s } = await passkeyLogin(a);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.username, 'fp_login');
  assert.equal((await s.get('/api/clients?limit=1')).status, 200, 'signed in');
  const sess = H.db.one(`SELECT mfa_source, reauth_method, mfa_pending FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1`, u.id);
  assert.deepEqual({ ...sess }, { mfa_source: 'passkey', reauth_method: 'passkey', mfa_pending: 0 });
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.login' AND user_id=? AND details LIKE '%"method":"passkey"%'`, u.id), 'audited as a passkey sign-in');
  // A username typed first changes nothing: the options never list an account's credentials (test/fingerprint-review).
  const named = await passkeyLogin(a, { username: 'fp_login' });
  assert.deepEqual(named.options.publicKey.allowCredentials, []);
  assert.equal(named.r.status, 200);
  assert.equal(H.db.one(`SELECT sign_count FROM passkeys WHERE credential_id=?`, a.id).sign_count, 2, 'the counter follows the device');
  // No CSRF header, no options.
  const raw = await fetch(base + '/api/auth/passkeys/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 403);
});

test('sign-in refuses: wrong origin, other RP ID, no UV, no UP, a bad signature, a reused or expired challenge, one for another purpose', async () => {
  const { u, c } = await person('fp_login_bad');
  const a = key(); await enrol(c, a);
  for (const [bend, code] of [[{ origin: 'https://evil.example' }, 'origin'], [{ rpId: 'evil.example' }, 'rpid'], [{ uv: false }, 'uv'], [{ up: false }, 'up'], [{ badSignature: true }, 'signature'], [{ type: 'webauthn.create' }, 'type']]) {
    H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, u.id);
    const { r } = await passkeyLogin(a, { bend });
    assert.equal(r.status, 401, JSON.stringify(bend));
    assert.match(r.data.passkeyError, new RegExp(code), JSON.stringify(bend));
  }
  // Reused: the same challenge answered twice.
  const c1 = H.client();
  const o = (await c1.post('/api/auth/passkeys/login/options', {})).data.publicKey;
  assert.equal((await c1.post('/api/auth/passkeys/login', { credential: a.get(o) })).status, 200);
  const again = await H.client().post('/api/auth/passkeys/login', { credential: a.get(o) });
  assert.equal(again.status, 401); assert.equal(again.data.passkeyError, 'challenge_used');
  // Expired.
  const o2 = (await H.client().post('/api/auth/passkeys/login/options', {})).data.publicKey;
  H.db.run(`UPDATE webauthn_challenges SET expires_at=? WHERE id=?`, new Date(Date.now() - 1000).toISOString(), crypto.createHash('sha256').update(W.fromB64url(o2.challenge)).digest('hex'));
  const late = await H.client().post('/api/auth/passkeys/login', { credential: a.get(o2) });
  assert.equal(late.data.passkeyError, 'challenge_expired');
  assert.ok(H.db.one(`SELECT 1 FROM webauthn_challenges WHERE id=?`, crypto.createHash('sha256').update(W.fromB64url(o2.challenge)).digest('hex')), 'challenges are stored by their hash');
  assert.ok(!H.db.one(`SELECT 1 FROM webauthn_challenges WHERE id=?`, o2.challenge), 'never as themselves');
  // A signing challenge is not a sign-in challenge.
  const id = await draft(c);
  const signing = await c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: id });
  const cross = await H.client().post('/api/auth/passkeys/login', { credential: a.get(signing.data.publicKey) });
  assert.equal(cross.data.passkeyError, 'challenge_purpose');
  // Nothing got in.
  assert.ok(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='auth.login.failed' AND user_id=? AND details LIKE '%passkey%'`, u.id).n >= 6);
});

test('a counter that goes backwards disables the passkey and is audited; a removed passkey is refused', async () => {
  const { u, c } = await person('fp_clone');
  const a = key({ counter: 10 }); await enrol(c, a);
  assert.equal((await passkeyLogin(a)).r.status, 200);
  const { r } = await passkeyLogin(a, { bend: { counter: 5 } });
  assert.equal(r.status, 403); assert.equal(r.data.passkeyError, 'counter');
  const row = H.db.one(`SELECT flagged_at, flag_reason FROM passkeys WHERE credential_id=?`, a.id);
  assert.ok(row.flagged_at && /counter/.test(row.flag_reason), 'the passkey is flagged');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.passkey.clone_suspected' AND user_id=?`, u.id), 'and the suspected copy audited');
  assert.equal((await passkeyLogin(a)).r.status, 403, 'refused from then on, even with a good counter');
  assert.equal((await c.get('/api/auth/passkeys')).data.passkeys[0].flagged, true, 'its owner sees why');
  // A device that does not count (0 each time) is fine.
  const z = key({ step: 0 }); await enrol(c, z);
  assert.equal((await passkeyLogin(z)).r.status, 200); assert.equal((await passkeyLogin(z)).r.status, 200);
  // Removing one takes the password; afterwards it signs no one in.
  const pid = H.db.one(`SELECT id FROM passkeys WHERE credential_id=?`, z.id).id;
  assert.equal((await c.del(`/api/auth/passkeys/${pid}`, {})).status, 400);
  assert.equal((await c.del(`/api/auth/passkeys/${pid}`, { password: PW })).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.passkey.removed' AND entity_id=?`, u.id));
  const gone = await passkeyLogin(z);
  assert.equal(gone.r.status, 401); assert.equal(gone.r.data.passkeyError, 'unknown passkey');
});

test('a deactivated or locked account cannot sign in with a passkey, and failed passkey attempts count toward the lockout', async () => {
  const { u, c } = await person('fp_state');
  const a = key(); await enrol(c, a);
  H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, u.id);
  assert.equal((await passkeyLogin(a)).r.status, 403, 'inactive');
  H.db.run(`UPDATE users SET is_active=1 WHERE id=?`, u.id);
  for (let i = 0; i < 5; i++) await passkeyLogin(a, { bend: { badSignature: true } });
  assert.ok(H.db.one(`SELECT locked_until FROM users WHERE id=?`, u.id).locked_until, 'five bad assertions lock the account');
  assert.equal((await passkeyLogin(a)).r.status, 423, 'even a good passkey is refused while locked');
  assert.equal((await H.client().post('/api/auth/login', { username: 'fp_state', password: PW })).status, 423, 'the lock is the account\'s');
  H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, u.id);
  assert.equal((await passkeyLogin(a)).r.status, 200);
  // Offboarding: an administrator deactivating the account removes its passkeys.
  assert.equal((await admin.put(`/api/users/${u.id}`, { is_active: 0 })).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, u.id).n, 0, 'deactivation removes the passkeys');
  H.db.run(`UPDATE users SET is_active=1 WHERE id=?`, u.id);
  assert.equal((await passkeyLogin(a)).r.status, 401, 're-enabling the account does not bring them back');
  // SCIM cut-off does the same.
  const b = key(); const c2 = H.client(); await c2.login('fp_state', PW); await enrol(c2, b);
  require('../server/scim').cutOff(u.id, { username: 'scim' });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, u.id).n, 0, 'SCIM deprovisioning removes them');
});

test('administrators see how many passkeys a person has and revoke them (users:manage), audited', async () => {
  const { u, c } = await person('fp_adminview');
  await enrol(c, key()); await enrol(c, key());
  const users = (await admin.get('/api/users')).data.users;
  assert.equal(users.find(x => x.id === u.id).passkey_count, 2);
  const nav = await person('fp_nosee');
  assert.equal((await nav.c.get(`/api/users/${u.id}/passkeys`)).status, 403, 'not without users:manage');
  assert.equal((await nav.c.del(`/api/users/${u.id}/passkeys`)).status, 403);
  const list = await admin.get(`/api/users/${u.id}/passkeys`);
  assert.equal(list.data.count, 2);
  assert.equal((await admin.del(`/api/users/${u.id}/passkeys/${list.data.passkeys[0].id}`)).status, 200);
  assert.equal((await admin.del(`/api/users/${u.id}/passkeys`)).data.removed, 1);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='user.passkeys.revoked' AND entity_id=?`, u.id), 'audited');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, u.id).n, 0);
});

test('"Require single sign-on": passkey sign-in is refused like a password, except for the emergency accounts', async () => {
  const { c } = await person('fp_sso');
  const a = key(); await enrol(c, a);
  const b = key(); await enrol(admin, b, { password: APW });
  const was = config.oidc.enabled;
  config.oidc.enabled = true;
  setting('sso_required', '1'); setting('sso_emergency_accounts', 'admin');
  try {
    const { r } = await passkeyLogin(a);
    assert.equal(r.status, 403); assert.equal(r.data.ssoRequired, true);
    assert.equal((await passkeyLogin(b)).r.status, 200, 'the break-glass administrator still can');
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.login' AND username='admin' AND details LIKE '%emergency_account%' AND details LIKE '%passkey%'`));
  } finally { setting('sso_required', null); setting('sso_emergency_accounts', null); config.oidc.enabled = was; }
});

test('a passkey satisfies the roles that require two-step verification: as the second step, or on its own', async () => {
  const { u, c } = await person('fp_mfa', 'clinician');
  setting('mfa_required_roles', 'clinician'); setting('mfa_grace_days', '0');
  try {
    const c1 = H.client(); await c1.login('fp_mfa', PW);
    const blocked = await c1.get('/api/clients?limit=1');
    assert.equal(blocked.status, 403); assert.equal(blocked.data.mfaSetupRequired, true, 'past the grace period with no second factor');
    const a = key();
    assert.equal((await enrol(c1, a)).status, 201, 'a passkey can be enrolled from there (it is two-step verification)');
    assert.equal((await c1.get('/api/clients?limit=1')).status, 200, 'and counts as it');
    // A password sign-in now owes its second step, which the passkey gives.
    const c2 = H.client(); const l = await c2.login('fp_mfa', PW);
    assert.equal(l.mfaPending, true); assert.deepEqual(l.mfaMethods, ['passkey']);
    assert.equal((await c2.get('/api/clients?limit=1')).status, 401, 'half signed in');
    assert.deepEqual((await c2.get('/api/auth/me')).data.mfa_methods, ['passkey']);
    const o = await c2.post('/api/auth/passkeys/login/options', {});
    assert.equal(o.data.purpose, 'mfa'); assert.deepEqual(o.data.publicKey.allowCredentials.map(x => x.id), [a.id]);
    const other = key(); const bad = await c2.post('/api/auth/passkeys/login', { credential: other.get(o.data.publicKey) });
    assert.equal(bad.status, 401, 'someone else\'s passkey does not finish it');
    const o2 = await c2.post('/api/auth/passkeys/login/options', {});
    assert.equal((await c2.post('/api/auth/passkeys/login', { credential: a.get(o2.data.publicKey) })).status, 200);
    assert.equal((await c2.get('/api/clients?limit=1')).status, 200, 'signed in with two factors');
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.login' AND user_id=? AND details LIKE '%"mfa":true%' AND details LIKE '%passkey%'`, u.id));
    // Straight in with the passkey: two factors in one.
    const { r, c: c3 } = await passkeyLogin(a);
    assert.equal(r.status, 200); assert.equal((await c3.get('/api/clients?limit=1')).status, 200);
    // Security status counts the passkey as two-step verification.
    const st = (await admin.get('/api/admin/security/status')).data;
    assert.ok(!st.mfa.without.some(x => x.id === u.id), 'Security status does not list the account as without two-step verification');
    assert.ok(st.items.find(i => i.name === 'Fingerprint sign-in (passkeys)'), 'and shows passkey adoption');
    // With fingerprint sign-in switched off, the passkey no longer counts.
    setting('passkey_signin', '0');
    assert.equal((await c3.get('/api/clients?limit=1')).status, 200, 'the passkey session stays (it was two factors)');
    const c4 = H.client(); await c4.login('fp_mfa', PW);
    assert.equal((await c4.get('/api/clients?limit=1')).status, 403, 'a password sign-in is again one factor short');
    assert.equal((await H.client().post('/api/auth/passkeys/login/options', {})).status, 403, 'and fingerprint sign-in is refused');
  } finally { setting('mfa_required_roles', null); setting('mfa_grace_days', null); setting('passkey_signin', null); }
  void c;
});

// ---------------------------------------------------------------- signing and approvals
test('signing a note with a fingerprint: bound to that note and its content; A\'s confirmation cannot sign B', async () => {
  const { u, c } = await person('fp_sign');
  await admin.post(`/api/clients/${clientId}/assignments`, { user_id: u.id, role_on_case: 'secondary' });
  const a = key(); await enrol(c, a);
  const A = await draft(c, 'Note A'); const B = await draft(c, 'Note B');
  const st = (await c.get('/api/auth/reauth')).data;
  assert.equal(st.passkey, true, 'the signature dialog is told fingerprint is on offer');
  const forA = await confirmWith(c, a, 'note.sign', { note_id: A });
  const wrong = await c.post(`/api/notes/${B}/sign`, { passkey: forA });
  assert.equal(wrong.status, 403); assert.equal(wrong.data.passkeyError, 'another record');
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, B).status, 'draft', 'B is not signed');
  const again = await c.post(`/api/notes/${A}/sign`, { passkey: forA });
  assert.equal(again.status, 403, 'and the confirmation was spent by the attempt'); assert.equal(again.data.passkeyError, 'challenge_used');
  // Content changed after the challenge: refused.
  const forA2 = await confirmWith(c, a, 'note.sign', { note_id: A });
  await c.put(`/api/notes/${A}`, { content: 'Note A, edited after confirming' });
  const changed = await c.post(`/api/notes/${A}/sign`, { passkey: forA2 });
  assert.equal(changed.data.passkeyError, 'record changed');
  // The right one.
  stale(u.id);
  const ok = await c.post(`/api/notes/${A}/sign`, { passkey: await confirmWith(c, a, 'note.sign', { note_id: A }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const au = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, A).details);
  assert.equal(au.identity, 'passkey', 'audited with method passkey');
  assert.ok(au.evidence, 'and the evidence id');
  // The evidence: stored encrypted, re-verifiable, and bound to exactly the signature hash the note carries.
  const evRow = H.db.one(`SELECT * FROM signature_evidence WHERE id=?`, au.evidence);
  assert.match(evRow.evidence_enc, /^v1:/, 'encrypted at rest');
  assert.equal(evRow.record_type, 'note'); assert.deepEqual(JSON.parse(evRow.record_ids), [A]);
  const ev = JSON.parse(decrypt(evRow.evidence_enc));
  assert.equal(ev.statement.content, require('../server/note-signature').contentHash(H.db.one(`SELECT * FROM notes WHERE id=?`, A), u.id, 'sign'), 'the statement names the note\'s content hash');
  assert.equal(ev.statement.user_id, u.id); assert.equal(ev.statement.purpose, 'note.sign');
  assert.ok(ev.statement.nonce && ev.statement.issued_at);
  assert.deepEqual(W.verifyEvidence(ev), { ok: true, checks: { statement: true, type: true, rp: true, origin: true, flags: true, signature: true }, reason: null }, 'verifies offline with nothing but the evidence');
  assert.equal(W.verifyEvidence({ ...ev, statement: { ...ev.statement, record_ids: [B] } }).ok, false, 'a statement changed afterwards does not');
  assert.equal(W.verifyEvidence({ ...ev, public_key: key().keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }).ok, false, 'nor under another key');
  const v = (await c.get(`/api/notes/${A}/verify`)).data;
  assert.equal(v.intact, true); assert.equal(v.fingerprint.verified, true, 'the note\'s verification re-checks the fingerprint evidence');
  // The quick-signing window opened by the fingerprint signs B with a confirmation.
  assert.equal((await c.post(`/api/notes/${B}/sign`, { confirm: true })).status, 200, 'a fingerprint opens the quick-signing window like a password');
  // The evidence survives the passkey's removal.
  await c.del(`/api/auth/passkeys/${H.db.one(`SELECT id FROM passkeys WHERE credential_id=?`, a.id).id}`, { password: PW });
  assert.equal((await c.get(`/api/notes/${A}/verify`)).data.fingerprint.verified, true, 'still verifiable once the passkey is gone');
  const exp = await admin.get(`/api/admin/signature-evidence?record_type=note&record_id=${A}`);
  assert.equal(exp.status, 200); assert.equal(exp.data.rows[0].verified, true, 'an auditor can export it');
  assert.equal((await c.get(`/api/admin/signature-evidence?record_type=note&record_id=${A}`)).status, 403, 'audit:read only');
});

test('a challenge is bound to its user and session: another person\'s, or another session\'s, is refused', async () => {
  const one = await person('fp_bind1'); const two = await person('fp_bind2');
  for (const p of [one, two]) await admin.post(`/api/clients/${clientId}/assignments`, { user_id: p.u.id, role_on_case: 'secondary' });
  const a1 = key(); await enrol(one.c, a1);
  const a2 = key(); await enrol(two.c, a2);
  const note = await draft(two.c);
  // One asks for a challenge (for their own draft) and two answers it with their passkey: refused.
  const mine = await draft(one.c);
  const o = await one.c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: mine });
  const r = await two.c.post(`/api/notes/${note}/sign`, { passkey: a2.get(o.data.publicKey) });
  assert.equal(r.status, 403); assert.equal(r.data.passkeyError, 'challenge_user');
  // The same person in another session.
  const other = H.client(); await other.login('fp_bind2', PW);
  const o2 = await other.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: note });
  const r2 = await two.c.post(`/api/notes/${note}/sign`, { passkey: a2.get(o2.data.publicKey) });
  assert.equal(r2.data.passkeyError, 'challenge_session');
  // Someone else's passkey on your own challenge.
  const o3 = await two.c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: note });
  const r3 = await two.c.post(`/api/notes/${note}/sign`, { passkey: a1.get(o3.data.publicKey) });
  assert.equal(r3.data.passkeyError, 'unknown passkey');
  assert.equal((await two.c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: mine })).status, 403, 'no challenge to sign someone else\'s note');
  // No UV on a signature.
  const o4 = await two.c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: note });
  const r4 = await two.c.post(`/api/notes/${note}/sign`, { passkey: a2.get(o4.data.publicKey, { uv: false }) });
  assert.equal(r4.data.passkeyError, 'uv');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.sign.failed' AND user_id=? AND details LIKE '%passkey%'`, two.u.id), 'failures are audited as signature failures');
  assert.equal((await two.c.get('/api/auth/reauth')).data.recent, false, 'and close the quick-signing window');
});

test('countersigning (one note and a batch) with a fingerprint', async () => {
  resetLimits();
  const w = await person('fp_writer'); const s = await person('fp_super', 'supervisor');
  await admin.post(`/api/clients/${clientId}/assignments`, { user_id: w.u.id, role_on_case: 'secondary' });
  const a = key(); await enrol(s.c, a);
  const ids = [];
  for (let i = 0; i < 3; i++) { const id = await draft(w.c, `Cosign me ${i}`); await w.c.post(`/api/notes/${id}/request-cosign`, {}); assert.equal((await w.c.post(`/api/notes/${id}/sign`, { confirm: true })).status, 200); ids.push(id); }
  stale(s.u.id);
  const one = await s.c.post(`/api/notes/${ids[0]}/cosign`, { passkey: await confirmWith(s.c, a, 'note.cosign', { note_id: ids[1] }) });
  assert.equal(one.data.passkeyError, 'another record', 'a countersignature for note 2 does not countersign note 1');
  assert.equal((await s.c.post(`/api/notes/${ids[0]}/cosign`, { passkey: await confirmWith(s.c, a, 'note.cosign', { note_id: ids[0] }) })).status, 200);
  assert.equal((await s.c.get(`/api/notes/${ids[0]}/verify`)).data.cosign_fingerprint.verified, true);
  stale(s.u.id);
  // A batch confirmation covers exactly its notes.
  const batchFor = await confirmWith(s.c, a, 'note.cosign-batch', { ids: [ids[1]] });
  assert.equal((await s.c.post('/api/notes/cosign-batch', { ids: [ids[1], ids[2]], passkey: batchFor })).data.passkeyError, 'another record');
  const r = await s.c.post('/api/notes/cosign-batch', { ids: [ids[2], ids[1]], passkey: await confirmWith(s.c, a, 'note.cosign-batch', { ids: [ids[1], ids[2]] }) });
  assert.equal(r.status, 200); assert.deepEqual(r.data.cosigned.sort(), [ids[1], ids[2]].sort());
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.cosign' AND entity_id=? AND details LIKE '%"identity":"passkey"%'`, ids[2]));
});

test('approving time with a fingerprint: bound to the entries and the decision', async () => {
  const w = await person('fp_timew'); const s = await person('fp_times', 'supervisor');
  const a = key(); await enrol(s.c, a);
  const mk = async () => { const t = (await w.c.post('/api/time', { work_date: today(), minutes: 45, category: 'documentation' })).data.id; await w.c.post(`/api/time/${t}/submit`, {}); return t; };
  const t1 = await mk(); const t2 = await mk(); const t3 = await mk();
  // Without a fingerprint, approval works as before (no proof asked by default).
  assert.equal((await s.c.post(`/api/time/${t3}/approve`, { decision: 'approved' })).status, 200);
  const forT1 = await confirmWith(s.c, a, 'time.approve', { ids: [t1], decision: 'approved' });
  assert.equal((await s.c.post(`/api/time/${t2}/approve`, { decision: 'approved', passkey: forT1 })).data.passkeyError, 'another record', 'a confirmation for one entry does not approve another');
  const ok = await s.c.post(`/api/time/${t1}/approve`, { decision: 'approved', passkey: await confirmWith(s.c, a, 'time.approve', { ids: [t1], decision: 'approved' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const au = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='time.approved' AND entity_id=?`, t1).details);
  assert.equal(au.identity, 'passkey'); assert.ok(au.evidence);
  // The batch.
  const t4 = await mk(); const t5 = await mk();
  const rej = await confirmWith(s.c, a, 'time.approve', { ids: [t4, t5], decision: 'rejected' });
  assert.equal((await s.c.post('/api/time/approve-batch', { ids: [t4, t5], decision: 'approved', passkey: rej })).data.passkeyError, 'record changed', 'a confirmation to return them does not approve them');
  const b = await s.c.post('/api/time/approve-batch', { ids: [t4, t5], decision: 'approved', passkey: await confirmWith(s.c, a, 'time.approve', { ids: [t5, t4], decision: 'approved' }) });
  assert.equal(b.status, 200); assert.equal(b.data.approved, 2);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='time.approved.batch' AND user_id=? AND details LIKE '%"identity":"passkey"%'`, s.u.id));
  assert.equal((await w.c.post('/api/auth/passkeys/challenge', { purpose: 'time.approve', ids: [t4], decision: 'approved' })).status, 403, 'no challenge without time:approve');
});

test('approving spending with a fingerprint', async () => {
  const w = await person('fp_expw'); const s = await person('fp_exps', 'supervisor');
  const a = key(); await enrol(s.c, a);
  const fundId = await newFund();
  const mk = async (amount) => (await w.c.post('/api/budget/expenditures', { funding_source_id: fundId, spent_at: today(), amount, category: 'client_assistance' })).data.id;
  const e1 = await mk(10); const e2 = await mk(20);
  const forE1 = await confirmWith(s.c, a, 'expenditure.approve', { id: e1, status: 'approved' });
  assert.equal((await s.c.post(`/api/budget/expenditures/${e2}/approve`, { status: 'approved', passkey: forE1 })).data.passkeyError, 'another record');
  const ok = await s.c.post(`/api/budget/expenditures/${e1}/approve`, { status: 'approved', passkey: await confirmWith(s.c, a, 'expenditure.approve', { id: e1, status: 'approved' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const au = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='expenditure.approved' AND entity_id=?`, e1).details);
  assert.equal(au.identity, 'passkey');
  const ev = require('../server/passkeys').evidenceFor('expenditure', e1);
  assert.equal(ev.length, 1); assert.equal(ev[0].verified, true);
  assert.equal((await w.c.post('/api/auth/passkeys/challenge', { purpose: 'expenditure.approve', id: e2, status: 'approved' })).status, 403, 'no challenge without budget:approve');
});

test('"Require fingerprint or authenticator for signing": the password alone no longer signs or approves', async () => {
  const { u, c } = await person('fp_strong');
  await admin.post(`/api/clients/${clientId}/assignments`, { user_id: u.id, role_on_case: 'secondary' });
  const s = await person('fp_strong_sup', 'supervisor');
  const a = key(); await enrol(c, a);
  const sa = key(); await enrol(s.c, sa);
  setting('sign_strong_required', '1');
  try {
    const n = await draft(c);
    const pw = await c.post(`/api/notes/${n}/sign`, { password: PW });
    assert.equal(pw.status, 403); assert.equal(pw.data.strongRequired, true, 'the password alone is refused');
    const st = (await c.get('/api/auth/reauth')).data;
    assert.equal(st.strong_required, true); assert.equal(st.recent, false, 'a window opened by a password sign-in does not count');
    assert.equal((await c.post(`/api/notes/${n}/sign`, { confirm: true })).status, 403);
    assert.equal((await c.post(`/api/notes/${n}/sign`, { passkey: await confirmWith(c, a, 'note.sign', { note_id: n }) })).status, 200, 'a fingerprint signs');
    const n2 = await draft(c);
    assert.equal((await c.post(`/api/notes/${n2}/sign`, { confirm: true })).status, 200, 'and a window it opened counts');
    // Approvals now need it too.
    const t = (await c.post('/api/time', { work_date: today(), minutes: 30, category: 'documentation' })).data.id; await c.post(`/api/time/${t}/submit`, {});
    stale(s.u.id);
    const none = await s.c.post(`/api/time/${t}/approve`, { decision: 'approved' });
    assert.equal(none.status, 403); assert.equal(none.data.strongRequired, true);
    assert.equal((await s.c.post(`/api/time/${t}/approve`, { decision: 'approved', passkey: await confirmWith(s.c, sa, 'time.approve', { ids: [t], decision: 'approved' }) })).status, 200);
    // Returning time still needs nothing.
    const t2 = (await c.post('/api/time', { work_date: today(), minutes: 30, category: 'documentation' })).data.id; await c.post(`/api/time/${t2}/submit`, {});
    assert.equal((await s.c.post(`/api/time/${t2}/approve`, { decision: 'rejected', note: 'wrong day' })).status, 200);
  } finally { setting('sign_strong_required', null); }
});

test('the programme can switch fingerprint signing off; then no challenge is issued and none is accepted', async () => {
  const { u, c } = await person('fp_off');
  await admin.post(`/api/clients/${clientId}/assignments`, { user_id: u.id, role_on_case: 'secondary' });
  const a = key(); await enrol(c, a);
  const n = await draft(c);
  const early = await confirmWith(c, a, 'note.sign', { note_id: n });
  assert.equal((await admin.put('/api/admin/settings', { passkey_signing: '0' })).status, 200);
  try {
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='security.passkey_policy'`), 'the change has its own audit entry');
    assert.equal((await c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: n })).status, 403);
    assert.equal((await c.post(`/api/notes/${n}/sign`, { passkey: early })).status, 403, 'a confirmation from before is refused too');
    assert.equal((await c.get('/api/auth/reauth')).data.passkey, false);
    assert.equal((await admin.put('/api/admin/settings', { passkey_signing: 'maybe' })).status, 400);
  } finally { await admin.put('/api/admin/settings', { passkey_signing: null }); }
});

test('where passkeys cannot work: plain http on a real host name, another host, and a device (local mode)', () => {
  const P = require('../server/passkeys');
  const ctx = (host, extra = {}) => ({ headers: { host, ...extra } });
  assert.equal(P.relyingParty(ctx('127.0.0.1:9')).rpId, '127.0.0.1', 'localhost over http, outside production');
  assert.throws(() => P.relyingParty(ctx('suds.county.example')), /HTTPS/, 'a real host name over http is refused');
  const saved = { ...config.webauthn }; const wasProxy = config.trustProxy; const wasProd = config.isProd;
  try {
    config.webauthn.rpId = 'suds.county.example'; config.trustProxy = true;
    assert.throws(() => P.relyingParty(ctx('other.example', { 'x-forwarded-proto': 'https' })), /set up for suds\.county\.example/, 'another host is refused');
    const rp = P.relyingParty(ctx('suds.county.example', { 'x-forwarded-proto': 'https' }));
    assert.deepEqual(rp.origins, ['https://suds.county.example']);
    config.isProd = true; config.webauthn.rpId = 'localhost';
    assert.throws(() => P.relyingParty(ctx('localhost:8080')), /HTTPS/, 'in production even localhost needs HTTPS');
    config.webauthn.rpId = '';
    assert.throws(() => P.relyingParty(ctx('suds.county.example', { 'x-forwarded-proto': 'https' })), /WEBAUTHN_RP_ID/, 'and production needs the relying party configured');
  } finally { Object.assign(config.webauthn, saved); config.trustProxy = wasProxy; config.isProd = wasProd; }
  // A device (SUDS on this device): no passkey route in its kernel, no policy, no relying party.
  assert.ok(!require('../server/app').LOCAL_ROUTE_MODULES.includes('passkeys'), 'the local kernel has no passkey routes');
  const wasLocal = config.local;
  config.local = true;
  try {
    const pol = require('../server/auth').policy();
    assert.deepEqual([pol.passkeySignin, pol.passkeySigning, pol.signStrongRequired], [false, false, false]);
    assert.throws(() => P.relyingParty(ctx('localhost')), /not available on this device/);
    assert.equal(require('../server/auth').passkeyCount('anyone'), 0);
  } finally { config.local = wasLocal; }
});

test('audit entries carry no secret: no signature, client data, public key or challenge', async () => {
  // Its own passkey sign-in, signature, countersignature and approval first, so it checks something whatever ran before.
  const s = await signedWithFingerprint('fp_secret');
  assert.equal((await passkeyLogin(s.a)).r.status, 200);
  const sup = await person(`fp_secret_sup_${crypto.randomUUID().slice(0, 6)}`, 'supervisor'); const sa = key(); await enrol(sup.c, sa);
  await s.c.post(`/api/notes/${s.note}/request-cosign`, {});
  assert.equal((await sup.c.post(`/api/notes/${s.note}/cosign`, { passkey: await confirmWith(sup.c, sa, 'note.cosign', { note_id: s.note }) })).status, 200);
  const t = (await s.c.post('/api/time', { work_date: today(), minutes: 15, category: 'documentation' })).data.id; await s.c.post(`/api/time/${t}/submit`, {});
  assert.equal((await sup.c.post(`/api/time/${t}/approve`, { decision: 'approved', passkey: await confirmWith(sup.c, sa, 'time.approve', { ids: [t], decision: 'approved' }) })).status, 200);
  const rows = H.db.all(`SELECT details FROM audit_log WHERE details IS NOT NULL AND (action LIKE 'auth.%' OR action LIKE 'note.%' OR action LIKE 'time.%' OR action LIKE 'expenditure.%' OR action LIKE 'user.passkeys%')`);
  const keys = H.db.all(`SELECT public_key, credential_id FROM passkeys`);
  const ev = H.db.all(`SELECT evidence_enc FROM signature_evidence`).map(r => JSON.parse(decrypt(r.evidence_enc)));
  assert.ok(ev.length >= 3 && keys.length >= 2, "there is something to check");
  for (const r of rows) {
    for (const k of keys) { assert.ok(!r.details.includes(k.public_key.slice(20, 60)), 'no public key'); assert.ok(!r.details.includes(k.credential_id), 'no credential id'); }
    for (const e of ev) { assert.ok(!r.details.includes(e.signature.slice(0, 30)), 'no signature'); assert.ok(!r.details.includes(e.client_data_json.slice(0, 30)), 'no client data'); assert.ok(!r.details.includes(e.statement.nonce), 'no statement nonce'); }
  }
});

// The rotation itself (scripts/rotate-key.js run on a copy of the database, and the evidence verified afterwards) is
// in test/fingerprint-review.test.js; this is that rotation finds the column and that it never leaves the office.
test('key rotation finds the signature evidence like any other _enc column, and it is kept at the office', () => {
  const { encryptedColumns } = require('../scripts/rotate-key');
  const t = encryptedColumns(H.db).find(x => x.table === 'signature_evidence');
  assert.deepEqual(t && t.cols, ['evidence_enc'], 'rotation finds it by itself');
  const SYNC = require('../server/sync-tables');
  assert.ok(SYNC.server_only.includes('signature_evidence') && SYNC.unsynced_enc.signature_evidence.includes('evidence_enc'), 'declared as kept at the office');
  for (const tbl of ['passkeys', 'webauthn_challenges']) assert.ok(SYNC.server_only.includes(tbl), `${tbl} never synchronises`);
});

test('the key backup download accepts a fingerprint: fresh by nature, and bound to that download', async () => {
  const fs = require('node:fs');
  const a = key(); await enrol(admin, a, { password: APW });
  const was = config.keySource;
  try {
    config.keySource = 'file';
    fs.writeFileSync(config.keysJsonPath, JSON.stringify({ SUDS_ENCRYPTION_KEY: 'c'.repeat(64) }));
    // A note-signing confirmation is not a key-backup one.
    const n = (await admin.post('/api/notes', { client_id: clientId, kind: 'admin', content: 'x', occurred_at: new Date().toISOString() })).data.id;
    const forNote = await confirmWith(admin, a, 'note.sign', { note_id: n });
    assert.equal((await admin.post('/api/admin/keys-backup', { passkey: forNote })).status, 403);
    const r = await admin.post('/api/admin/keys-backup', { passkey: await confirmWith(admin, a, 'keys.download') });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const au = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='keys.download' ORDER BY id DESC LIMIT 1`).details);
    assert.equal(au.method, 'passkey'); assert.ok(au.evidence);
    assert.equal((await admin.post('/api/admin/keys-backup', { confirm: true })).status, 403, 'and the next download asks again');
    assert.equal((await H.client().post('/api/auth/passkeys/challenge', { purpose: 'keys.download' })).status, 401);
    const nav = await person('fp_nokeys');
    await enrol(nav.c, key());
    assert.equal((await nav.c.post('/api/auth/passkeys/challenge', { purpose: 'keys.download' })).status, 403, 'no challenge without settings:manage');
  } finally { config.keySource = was; fs.rmSync(config.keysJsonPath, { force: true }); }
});

test('an auditor exports the evidence and verifies it offline with scripts/verify-passkey-evidence.js', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const s = await signedWithFingerprint('fp_auditor');
  const note = { id: s.note };
  const exp = (await admin.get(`/api/admin/signature-evidence?record_type=note&record_id=${note.id}`)).data;
  const content = (await s.c.get(`/api/notes/${note.id}/verify`)).data.fingerprint.content_hash;
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='signature_evidence.view' AND entity_id=?`, note.id), 'the export is audited');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-fp-'));
  const file = path.join(dir, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(exp));
  const { run } = require('../scripts/verify-passkey-evidence');
  const good = run([file, '--content', content]);
  assert.equal(good.code, 0, good.lines.join('\n')); assert.match(good.lines.join('\n'), /All 1 verified/);
  assert.equal(run([file, '--content', 'f'.repeat(64)]).code, 1, 'a different content hash does not match');
  exp.rows[0].evidence.statement.record_ids = ['someone-else'];
  fs.writeFileSync(file, JSON.stringify(exp));
  assert.equal(run([file]).code, 1, 'an edited statement does not verify');
  fs.rmSync(dir, { recursive: true, force: true });
});
