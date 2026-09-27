'use strict';
// Security review of 1.13.0, finding 5: from inside a signed-in session, POST /api/auth/mfa/disable and
// POST /api/auth/password took unlimited wrong passwords (30 each: 401, failed_attempts 0, no lockout, and no
// audit entry for /mfa/disable), and then the right password turned two-step verification off. Both now go
// through the sign-in's protections (the per-address limit, the account's failure count and lockout, an audit
// entry for every failure), and turning two-step verification off also needs a current authenticator code.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;
const { totp, decrypt } = require('../server/crypto');
const config = require('../server/config');

const PW = 'StaffPassw0rd!x';
let a, uid;
const codeFor = (id, offset = 0) => totp(decrypt(db.one(`SELECT mfa_secret_enc FROM users WHERE id=?`, id).mfa_secret_enc), Date.now() + offset * 30000);
async function enrol(c, id) {
  const s = await c.post('/api/auth/mfa/setup', {});
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal((await c.post('/api/auth/mfa/enable', { code: codeFor(id) })).status, 200);
}
before(async () => {
  await H.start();
  uid = H.makeUser('ig_user', 'navigator').id;
  a = H.client(); await a.login('ig_user', PW);
});
after(() => H.stop());
const unlock = () => db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?`, uid);

test('wrong current passwords at /api/auth/password count toward the lockout, are audited, and lock the account', async () => {
  const { rateLimitReset } = require('../server/app');
  const max = config.lockout.maxAttempts;
  const before = db.one(`SELECT COUNT(*) n FROM audit_log WHERE user_id=? AND action='auth.password.change.failed'`, uid).n;
  let status;
  for (let i = 0; i < max; i++) { rateLimitReset('api:127.0.0.1'); status = (await a.post('/api/auth/password', { current_password: 'wrong' + i, new_password: 'NewPassw0rd!xyz9' })).status; }
  const u = db.one(`SELECT failed_attempts, locked_until FROM users WHERE id=?`, uid);
  assert.ok(u.locked_until && Date.parse(u.locked_until) > Date.now(), `locked after ${max} wrong passwords`);
  assert.equal(db.one(`SELECT COUNT(*) n FROM audit_log WHERE user_id=? AND action='auth.password.change.failed'`, uid).n - before, max, 'each failure audited');
  assert.ok([401, 403, 423].includes(status));
  // Locked: even the right password is refused until the lockout ends.
  const right = await a.post('/api/auth/password', { current_password: PW, new_password: 'NewPassw0rd!xyz9' });
  assert.equal(right.status, 423);
  unlock();
});

test('turning two-step verification off needs the password and a current code, and wrong ones lock the account', async () => {
  const { rateLimitReset } = require('../server/app');
  await enrol(a, uid);
  // The password alone is no longer enough.
  const noCode = await a.post('/api/auth/mfa/disable', { password: PW });
  assert.equal(noCode.status, 400, JSON.stringify(noCode.data));
  assert.equal(db.one(`SELECT mfa_enabled FROM users WHERE id=?`, uid).mfa_enabled, 1);
  // Wrong passwords: audited, counted, locked.
  const max = config.lockout.maxAttempts;
  for (let i = 0; i < max; i++) { rateLimitReset('api:127.0.0.1'); rateLimitReset(`mfa:${uid}`); await a.post('/api/auth/mfa/disable', { password: 'wrong' + i, code: '000000' }); }
  const u = db.one(`SELECT locked_until FROM users WHERE id=?`, uid);
  assert.ok(u.locked_until && Date.parse(u.locked_until) > Date.now(), 'locked');
  assert.ok(db.one(`SELECT COUNT(*) n FROM audit_log WHERE user_id=? AND action='auth.mfa.disable.failed'`, uid).n >= max, 'every failure audited');
  // Locked: the right password and code are refused, and two-step verification stays on.
  const locked = await a.post('/api/auth/mfa/disable', { password: PW, code: codeFor(uid, 1) });
  assert.equal(locked.status, 423);
  assert.equal(db.one(`SELECT mfa_enabled FROM users WHERE id=?`, uid).mfa_enabled, 1);
  unlock();
  // A wrong code with the right password fails too, and is audited as such.
  rateLimitReset(`mfa:${uid}`);
  const badCode = await a.post('/api/auth/mfa/disable', { password: PW, code: '000000' });
  assert.equal(badCode.status, 403);
  assert.equal(db.one(`SELECT mfa_enabled FROM users WHERE id=?`, uid).mfa_enabled, 1);
  const last = db.one(`SELECT details FROM audit_log WHERE user_id=? AND action='auth.mfa.disable.failed' ORDER BY id DESC LIMIT 1`, uid);
  assert.match(last.details, /code/);
});

test('with the right password and a current code it is turned off, and audited', async () => {
  const { rateLimitReset } = require('../server/app');
  rateLimitReset(`mfa:${uid}`); unlock();
  const ok = await a.post('/api/auth/mfa/disable', { password: PW, code: codeFor(uid, 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.one(`SELECT mfa_enabled FROM users WHERE id=?`, uid).mfa_enabled, 0);
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE user_id=? AND action='auth.mfa.disabled'`, uid));
  assert.equal(db.one(`SELECT failed_attempts FROM users WHERE id=?`, uid).failed_attempts, 0, 'a success clears the count');
});
