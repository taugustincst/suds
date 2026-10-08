'use strict';
// Security review of 1.12.4, finding 1: POST /api/auth/mfa/enable checked only that a user was attached to
// the session. A password-only attacker (a session still owing its second factor) could skip /mfa/verify,
// with its rate limit, and guess the account's existing authenticator code here without limit or audit —
// and a right guess cleared mfa_pending. Enrolment is now only for a fully signed-in session of an account
// without two-step verification (which includes the forced enrolment after the grace period), shares the
// verify rate limit, is audited when it fails, and every wrong code counts toward the account lockout.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { totp, generateTotpSecret, encrypt } = require('../server/crypto');
const { rateLimitReset } = require('../server/app');

before(() => H.start());
after(() => H.stop());

function enrolled(username, role = 'navigator') {
  const u = H.makeUser(username, role);
  const secret = generateTotpSecret();
  H.db.run(`UPDATE users SET mfa_enabled=1, mfa_secret_enc=? WHERE id=?`, encrypt(secret), u.id);
  return { ...u, secret };
}
const audits = (id, action) => H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE user_id=? AND action=?`, id, action).n;

test('a session still owing its second factor cannot use enrolment to guess the existing code', async () => {
  const u = enrolled('mfabrute');
  const c = H.client();
  assert.equal((await c.login(u.username, u.password)).mfaPending, true);
  const wrong = await c.post('/api/auth/mfa/enable', { code: '000000' });
  assert.equal(wrong.status, 401, 'refused before any code is checked');
  assert.equal(wrong.data.mfaRequired, true);
  const right = await c.post('/api/auth/mfa/enable', { code: totp(u.secret) });
  assert.equal(right.status, 401, 'even the right code does not complete the sign-in through enrolment');
  assert.equal((await c.get('/api/clients')).status, 401, 'the session still owes its second factor');
  assert.equal((await c.post('/api/auth/mfa/setup', {})).status, 401, 'setup is refused too');
  const row = H.db.one(`SELECT mfa_secret_enc FROM users WHERE id=?`, u.id);
  assert.ok(row.mfa_secret_enc, 'the enrolled secret is untouched');
});

test('an account with two-step verification on cannot re-enrol from a full session', async () => {
  const u = enrolled('mfareenrol');
  const c = H.client();
  await c.login(u.username, u.password);
  assert.equal((await c.post('/api/auth/mfa/verify', { code: totp(u.secret, Date.now() - 30_000) })).status, 200);
  assert.equal((await c.post('/api/auth/mfa/setup', {})).status, 400);
  assert.equal((await c.post('/api/auth/mfa/enable', { code: '123456' })).status, 400);
});

test('enrolment failures are rate limited with verify, audited, and count toward the lockout', async () => {
  const u = H.makeUser('mfaenrolfail', 'navigator');
  const c = H.client();
  await c.login(u.username, u.password);
  const setup = await c.post('/api/auth/mfa/setup', {});
  assert.equal(setup.status, 200);
  let r;
  for (let i = 0; i < 4; i++) r = await c.post('/api/auth/mfa/enable', { code: '000000' });
  assert.equal(r.status, 400);
  assert.equal(audits(u.id, 'auth.mfa.enable.failed'), 4, 'each wrong enrolment code is audited');
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, u.id).failed_attempts, 4);
  r = await c.post('/api/auth/mfa/enable', { code: '000000' });
  assert.ok(H.db.one(`SELECT locked_until FROM users WHERE id=?`, u.id).locked_until, 'the fifth wrong code locks the account');
  r = await c.post('/api/auth/mfa/enable', { code: totp(setup.data.secret) });
  assert.equal(r.status, 423, 'a locked account cannot enrol');
  H.db.run(`UPDATE users SET locked_until=NULL, failed_attempts=0 WHERE id=?`, u.id);
  // The shared per-account limit: /mfa/verify's 10 in 10 minutes applies to enrolment too.
  for (let i = 0; i < 6; i++) { r = await c.post('/api/auth/mfa/enable', { code: '000000' }); H.db.run(`UPDATE users SET locked_until=NULL, failed_attempts=0 WHERE id=?`, u.id); }
  assert.equal(r.status, 429, 'the eleventh attempt in ten minutes is refused');
  rateLimitReset('mfa:' + u.id);
  assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(setup.data.secret) })).status, 200);
  assert.equal(audits(u.id, 'auth.mfa.enabled'), 1);
});

test('wrong codes at the sign-in second step lock the account, and the password alone does not unlock it', async () => {
  const u = enrolled('mfaverifylock');
  const c = H.client();
  await c.login(u.username, u.password);
  for (let i = 0; i < 5; i++) await c.post('/api/auth/mfa/verify', { code: '000000' });
  assert.ok(H.db.one(`SELECT locked_until FROM users WHERE id=?`, u.id).locked_until, 'five wrong codes lock the account');
  const r = await c.post('/api/auth/mfa/verify', { code: totp(u.secret) });
  assert.equal(r.status, 423, 'the right code no longer gets in while locked');
  assert.equal((await H.client().post('/api/auth/login', { username: u.username, password: u.password })).status, 423);
  // Unlocked: a correct password does not reset the count of wrong codes, so alternating sign-ins with
  // guesses cannot sidestep the lockout; the second factor does.
  H.db.run(`UPDATE users SET locked_until=NULL, failed_attempts=3 WHERE id=?`, u.id);
  rateLimitReset('mfa:' + u.id);
  const d = H.client(); await d.login(u.username, u.password);
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, u.id).failed_attempts, 3);
  assert.equal((await d.post('/api/auth/mfa/verify', { code: totp(u.secret, Date.now() + 30_000) })).status, 200);
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, u.id).failed_attempts, 0);
});

test('forced enrolment after the grace period still works', async () => {
  H.db.setSetting('mfa_required_roles', 'navigator');
  try {
    const u = H.makeUser('mfaforced', 'navigator');
    H.db.run(`UPDATE users SET created_at=? WHERE id=?`, '2020-01-01T00:00:00.000Z', u.id);
    const c = H.client(); await c.login(u.username, u.password);
    assert.equal((await c.get('/api/clients')).status, 403);
    const setup = await c.post('/api/auth/mfa/setup', {});
    assert.equal(setup.status, 200);
    assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(setup.data.secret) })).status, 200);
    assert.equal((await c.get('/api/clients')).status, 200);
  } finally { H.db.run(`DELETE FROM settings WHERE key='mfa_required_roles'`); }
});

test('1.25.2, FL1: a wrong or reused code at the second step is answered with its reason and code_refused; the sign-in stands', async () => {
  const u = enrolled('mfacoderefused');
  const c = H.client();
  await c.login(u.username, u.password);
  const wrong = await c.post('/api/auth/mfa/verify', { code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.code_refused, true, 'the app keeps the person on the code screen');
  assert.match(wrong.data.error, /^Invalid verification code/);
  const code = totp(u.secret, Date.now() + 30_000);
  assert.equal((await c.post('/api/auth/mfa/verify', { code })).status, 200, 'the same sign-in then finishes with the right code');
  const d = H.client(); await d.login(u.username, u.password);
  const replay = await d.post('/api/auth/mfa/verify', { code });
  assert.equal(replay.status, 401); assert.equal(replay.data.code_refused, true);
  assert.match(replay.data.error, /already been used/);
  const none = await H.client().post('/api/auth/mfa/verify', { code: '000000' });
  assert.equal(none.status, 401); assert.equal(none.data.code_refused, undefined, 'no sign-in at all is not a refused code');
  H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, u.id);
});

test('1.25.2, FL12: the app asks "is anyone signed in?" without a 401; a sign-in owing its second step is still refused elsewhere', async () => {
  const anon = H.client();
  const r = await anon.get('/api/auth/me?optional=1');
  assert.equal(r.status, 200); assert.deepEqual(r.data, { user: null });
  assert.equal((await anon.get('/api/auth/me')).status, 401, 'without ?optional=1, as before');
  const u = enrolled('mfaoptional');
  const c = H.client(); await c.login(u.username, u.password);
  const pending = await c.get('/api/auth/me?optional=1');
  assert.equal(pending.status, 200); assert.equal(pending.data.mfaPending, true, 'a pending sign-in is described as before');
  assert.equal((await c.get('/api/me/prefs')).status, 401, 'and everything else still waits for the second step');
});
