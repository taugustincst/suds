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
  assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(secret, step(-1)) })).status, 200);
  assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(secret, step(-1)) })).status, 400, 'the enrolment code cannot be replayed either');
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
  await c.post('/api/auth/mfa/enable', { code: totp(setup.data.secret, step(-1)) });
  makeStale(u.id);
  const id = await draft(c);
  let last;
  for (let i = 0; i < 11; i++) last = await c.post(`/api/notes/${id}/sign`, { code: '000000' });
  assert.equal(last.status, 429);
  const other = H.client(); await other.login('sigtotplimit', PW);
  assert.equal((await other.post('/api/auth/mfa/verify', { code: totp(setup.data.secret) })).status, 429, 'the same bucket as the sign-in');
});
