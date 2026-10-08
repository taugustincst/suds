'use strict';
// Pen test of suds.systems, MINOR-1: a real account answered 423 "Account locked" after five wrong passwords, before
// its password was looked at, while a name nobody has answered 401 for ever, so the lockout told a guesser which
// names exist. A name with no active account now fails and locks the same way (server/auth.js, nameLocked): the
// same status and body at every attempt, before and after the threshold. The lockout itself is unchanged.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const config = require('../server/config');

before(async () => {
  await H.start();
  H.makeUser('enum.real', 'navigator');
  const gone = H.makeUser('enum.gone', 'navigator'); H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, gone.id);
});
after(async () => { await H.stop(); });

const attempt = async (username, password = 'Wrong-guess-123') => { const r = await H.client().post('/api/auth/login', { username, password }); return { status: r.status, body: r.data }; };

test('a real account, a deactivated one and a name nobody has answer alike, before and after the lockout threshold', async () => {
  const names = ['enum.real', 'enum.gone', 'enum.nobody'];
  for (let i = 0; i < config.lockout.maxAttempts; i++) {
    const [real, gone, nobody] = await Promise.all(names.map((n) => attempt(n)));
    assert.equal(real.status, 401, `attempt ${i + 1}`);
    assert.deepEqual(nobody, real, `attempt ${i + 1}: a name nobody has answers as the account does`);
    assert.deepEqual(gone, real, `attempt ${i + 1}: and so does a deactivated account`);
  }
  const [real, gone, nobody] = await Promise.all(names.map((n) => attempt(n)));
  assert.equal(real.status, 423, 'the account is locked (the policy is unchanged)');
  assert.deepEqual(nobody, real, 'the name nobody has is "locked" too, with the same message');
  assert.deepEqual(gone, real);
  assert.equal(real.body.error, 'Account locked. Try again later or contact an administrator.');
  // The right password does not get through a lock, for the account; the same answer for the others.
  assert.deepEqual(await attempt('enum.real', 'StaffPassw0rd!x'), real);
  // The name as the lookup matches it: trimmed, any case.
  assert.deepEqual(await attempt(' ENUM.Nobody '), real);
});

test('the lock on a name ends when an account\'s would, and the count starts again', async () => {
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + (config.lockout.minutes + 1) * 60000;
    H.db.run(`UPDATE users SET locked_until=? WHERE username='enum.real'`, new Date(realNow() - 1000).toISOString());
    const real = await attempt('enum.real'); const nobody = await attempt('enum.nobody');
    assert.equal(real.status, 401); assert.deepEqual(nobody, real, 'both answer 401 again');
  } finally { Date.now = realNow; }
});

test('the names counted are kept in memory only, and never their text: the audit row is the hashed form as before', async () => {
  await attempt('enum.secret-looking-name');
  const row = H.db.one(`SELECT details, username FROM audit_log WHERE action='auth.login.failed' ORDER BY rowid DESC LIMIT 1`);
  assert.ok(!JSON.stringify(row).includes('secret-looking-name'), JSON.stringify(row));
});
