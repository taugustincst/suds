'use strict';
// The electronic-signature step (auth.verifySigner) is a password / authenticator check like the sign-in,
// so it gets the sign-in's protections: wrong passwords count toward the account lockout, a locked account
// cannot sign, a failed attempt ends the quick-signing window, and an authenticator code is accepted once
// only — at signing and at sign-in alike (RFC 6238 §5.2).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { totp } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
let admin, clientId;
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  clientId = (await admin.post('/api/clients', { first_name: 'Sig', last_name: 'Hardening' })).data.id;
});
after(H.stop);

const draft = async (c) => (await c.post('/api/notes', { client_id: clientId, kind: 'admin', title: 'Visit', content: 'Seen at the van.', occurred_at: new Date().toISOString() })).data.id;
const makeStale = (userId) => H.db.run(`UPDATE sessions SET reauth_at=? WHERE user_id=? AND revoked_at IS NULL`, new Date(Date.now() - 60 * 60000).toISOString(), userId);
const step = (n) => Date.now() + n * 30_000; // a code from n time-steps away (the server accepts ±1)

async function staff(name) {
  const u = H.makeUser(name, 'navigator');
  const c = H.client(); await c.login(name, PW);
  await admin.post(`/api/clients/${clientId}/assignments`, { user_id: u.id, role_on_case: 'secondary' });
  return { u, c };
}

test('wrong signature passwords count toward the account lockout; a locked account can neither sign nor sign in', async () => {
  const { u, c } = await staff('sigpw');
  const id = await draft(c);
  for (let i = 0; i < 4; i++) assert.equal((await c.post(`/api/notes/${id}/sign`, { password: 'Wrong-guess-1!' })).status, 403);
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, u.id).failed_attempts, 4, 'each failure is counted like a failed sign-in');
  await c.post(`/api/notes/${id}/sign`, { password: 'Wrong-guess-1!' });
  assert.ok(H.db.one(`SELECT locked_until FROM users WHERE id=?`, u.id).locked_until, 'the fifth locks the account');
  assert.equal((await c.post(`/api/notes/${id}/sign`, { password: PW })).status, 423, 'even the right password is refused while locked');
  assert.equal((await c.post(`/api/notes/${id}/sign`, { confirm: true })).status, 423, 'and so is the quick confirmation');
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, id).status, 'draft');
  assert.equal((await H.client().post('/api/auth/login', { username: 'sigpw', password: PW })).status, 423, 'sign-in is locked too');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.sign.failed' AND user_id=? AND details LIKE '%locked%'`, u.id), 'the lock is audited');
});

test('a right signature password clears the failure count; a wrong one ends the quick-signing window', async () => {
  const { u, c } = await staff('sigreset');
  const id = await draft(c);
  assert.equal((await c.get('/api/auth/reauth')).data.recent, true);
  assert.equal((await c.post(`/api/notes/${id}/sign`, { password: 'Wrong-guess-1!' })).status, 403);
  assert.equal((await c.get('/api/auth/reauth')).data.recent, false, 'someone guessing at the keyboard does not keep the window open');
  assert.equal((await c.post(`/api/notes/${id}/sign`, { confirm: true })).status, 403);
  assert.equal((await c.post(`/api/notes/${id}/sign`, { password: PW })).status, 200);
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, u.id).failed_attempts, 0);
});

test('an authenticator code is accepted once: not again for signing, nor for a sign-in', async () => {
  const { u, c } = await staff('sigtotp');
  const setup = await c.post('/api/auth/mfa/setup', {});
  const secret = setup.data.secret;
  const first = await H.totpPreviousStep(secret);
  assert.equal((await c.post('/api/auth/mfa/enable', { code: first })).status, 200);
  assert.equal((await c.post('/api/auth/mfa/enable', { code: first })).status, 400, 'the enrolment code cannot be replayed either');
  makeStale(u.id);
  const a = await draft(c), b = await draft(c);
  const code = totp(secret, step(0));
  assert.equal((await c.post(`/api/notes/${a}/sign`, { code })).status, 200);
  makeStale(u.id);
  const replay = await c.post(`/api/notes/${b}/sign`, { code });
  assert.equal(replay.status, 403, 'the same code again is refused');
  assert.match(replay.data.error, /already been used/);
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, b).status, 'draft');
  // The code used for a signature cannot complete a sign-in (someone reading it off the screen or network).
  const other = H.client(); await other.login('sigtotp', PW);
  assert.equal((await other.post('/api/auth/mfa/verify', { code })).status, 401);
  // An older code than the last one used is refused too; the next one works, once.
  assert.equal((await other.post('/api/auth/mfa/verify', { code: totp(secret, step(-1)) })).status, 401);
  const next = totp(secret, step(1));
  assert.equal((await other.post('/api/auth/mfa/verify', { code: next })).status, 200);
  const third = H.client(); await third.login('sigtotp', PW);
  assert.equal((await third.post('/api/auth/mfa/verify', { code: next })).status, 401, 'a sign-in code cannot be replayed');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.mfa.failed' AND user_id=? AND details LIKE '%replay%'`, u.id));
});

test('authenticator attempts at signing share the per-user limit with the sign-in\'s second step', async () => {
  const { u, c } = await staff('sigtotplimit');
  const setup = await c.post('/api/auth/mfa/setup', {});
  assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(setup.data.secret, step(0)) })).status, 200);
  makeStale(u.id);
  const id = await draft(c);
  let last;
  // Wrong codes also count toward the account lockout (five lock it); cleared here each time so the loop
  // reaches the per-user rate limit this test is about.
  for (let i = 0; i < 11; i++) { last = await c.post(`/api/notes/${id}/sign`, { code: '000000' }); H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, u.id); }
  assert.equal(last.status, 429);
  const other = H.client(); await other.login('sigtotplimit', PW);
  assert.equal((await other.post('/api/auth/mfa/verify', { code: totp(setup.data.secret) })).status, 429, 'the same bucket as the sign-in');
});

test('wrong authenticator codes at signing count toward the account lockout', async () => {
  const { u, c } = await staff('sigtotplock');
  const setup = await c.post('/api/auth/mfa/setup', {});
  assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(setup.data.secret, step(0)) })).status, 200);
  makeStale(u.id);
  const id = await draft(c);
  let last;
  for (let i = 0; i < 5; i++) last = await c.post(`/api/notes/${id}/sign`, { code: '000000' });
  assert.equal(last.status, 403);
  assert.ok(H.db.one(`SELECT locked_until FROM users WHERE id=?`, u.id).locked_until, 'the fifth wrong code locks the account');
  assert.equal((await c.post(`/api/notes/${id}/sign`, { code: totp(setup.data.secret, step(1)) })).status, 423);
});

// Pen test of 1.23.6, L2, finished in 1.24.0: the password given again inside a session (to sign, to change it) and
// fingerprint sign-in counted their failures per address alone, so one person's wrong guesses refused every
// colleague's signature behind the same NAT address. They now count per account (a passkey: per credential) from the
// address, with the per-address ceiling (LOGIN_IP_RATE_LIMIT) behind it, as POST /api/auth/login does.
test('one person\'s failed signing passwords do not block a colleague at the same address (L2)', async () => {
  const config = require('../server/config'); const app = require('../server/app');
  const was = [config.loginRateLimit, config.loginIpRateLimit];
  const a = await staff('l2signa'); const b = await staff('l2signb');
  const reset = () => { app.rateLimitReset('login-ip:127.0.0.1'); for (const x of [a, b]) app.rateLimitReset(`login-account:${x.u.id}@127.0.0.1`); };
  config.loginRateLimit = 3; config.loginIpRateLimit = 8; reset();
  try {
    const noteA = await draft(a.c); const noteB = await draft(b.c);
    for (let i = 0; i < 3; i++) assert.equal((await a.c.post(`/api/notes/${noteA}/sign`, { password: 'Wrong-guess-1!' })).status, 403);
    assert.equal((await a.c.post(`/api/notes/${noteA}/sign`, { password: PW })).status, 429, 'the guesser is limited');
    assert.equal((await b.c.post(`/api/notes/${noteB}/sign`, { password: PW })).status, 200, 'a colleague at the same address still signs');
    assert.equal((await H.client().post('/api/auth/login', { username: 'l2signb', password: PW })).status, 200, 'and signs in');
    // The password given to change it is the same check (auth.confirmPassword).
    for (let i = 0; i < 3; i++) assert.equal((await b.c.post('/api/auth/password', { current_password: 'Wrong-guess-1!', new_password: 'Brand-Fresh-Passw0rd!' })).status, 401);
    assert.equal((await b.c.post('/api/auth/password', { current_password: PW, new_password: 'Brand-Fresh-Passw0rd!' })).status, 429, 'the change is limited for that account');
    // Six failures from this address so far; the per-address ceiling (8) is still the backstop against spraying.
    const c = await staff('l2signc'); const noteC = await draft(c.c);
    for (let i = 0; i < 2; i++) assert.equal((await c.c.post(`/api/notes/${noteC}/sign`, { password: 'Wrong-guess-1!' })).status, 403);
    assert.equal((await c.c.post(`/api/notes/${noteC}/sign`, { password: PW })).status, 429, 'past the per-address ceiling every attempt from it waits');
    app.rateLimitReset(`login-account:${c.u.id}@127.0.0.1`);
  } finally { [config.loginRateLimit, config.loginIpRateLimit] = was; reset(); }
});

test('fingerprint sign-in failures count per passkey from an address, not per address alone (L2)', async () => {
  const config = require('../server/config'); const app = require('../server/app');
  const was = [config.loginRateLimit, config.loginIpRateLimit];
  const reset = () => { app.rateLimitReset('login-ip:127.0.0.1'); for (const id of ['l2-cred-a', 'l2-cred-b']) app.rateLimitReset(`login-passkey:${id}@127.0.0.1`); };
  config.loginRateLimit = 3; config.loginIpRateLimit = 8; reset();
  const bogus = (id) => ({ id, rawId: id, type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } });
  try {
    for (let i = 0; i < 3; i++) assert.notEqual((await H.client().post('/api/auth/passkeys/login', { credential: bogus('l2-cred-a') })).status, 429);
    assert.equal((await H.client().post('/api/auth/passkeys/login', { credential: bogus('l2-cred-a') })).status, 429, 'that credential is limited');
    assert.notEqual((await H.client().post('/api/auth/passkeys/login', { credential: bogus('l2-cred-b') })).status, 429, 'another passkey from the same address is not');
    assert.equal((await H.client().post('/api/auth/login', { username: 'admin', password: 'AdminPassw0rd!x' })).status, 200, 'nor is a password sign-in');
  } finally { [config.loginRateLimit, config.loginIpRateLimit] = was; reset(); }
});
