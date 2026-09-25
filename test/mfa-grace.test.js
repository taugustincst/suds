'use strict';
// The two-step-verification grace period: 3 days by default (was 14, and approving an access request restarts
// it, so every approved account got a fresh fortnight of password-only access). When it runs out the account
// is sent to enrolment, never locked out: the enrolment endpoints and the app shell's two harmless reads still
// answer, everything else says mfaSetupRequired.
delete process.env.MFA_GRACE_DAYS;
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const config = require('../server/config');
const auth = require('../server/auth');

let admin;
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
});
after(async () => { await H.stop(); });

test('the default grace period is 3 days, and MFA_GRACE_DAYS still configures it (0 allowed)', () => {
  assert.equal(config.mfaGraceDays, 3);
  H.db.run(`DELETE FROM settings WHERE key='mfa_grace_days'`);
  assert.equal(auth.policy().mfaGraceDays, 3);
  const { execFileSync } = require('node:child_process');
  const read = (v) => execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./server/config').mfaGraceDays))"], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, SUDS_ENV: 'test', SUDS_DB_PATH: ':memory:', MFA_GRACE_DAYS: v } }).toString();
  assert.equal(read('0'), '0');
  assert.equal(read('10'), '10');
  assert.equal(read('soon'), '3', 'a value that is not a number falls back to the default instead of breaking every deadline');
  assert.equal(read('-2'), '3');
});

test('a new account has 3 days to enrol by default', async () => {
  H.db.setSetting('mfa_required_roles', 'navigator');
  try {
    const u = H.makeUser('grace3', 'navigator');
    const c = H.client();
    const r = await c.post('/api/auth/login', { username: u.username, password: u.password });
    assert.equal(r.data.mfaSetupRequired, true);
    const days = (Date.parse(r.data.mfaSetupDeadline) - Date.now()) / 86400000;
    assert.ok(days > 2.9 && days <= 3, `${days} days`);
  } finally { H.db.run(`DELETE FROM settings WHERE key='mfa_required_roles'`); }
});

test('past the deadline the account is sent to enrolment, not locked out', async () => {
  H.db.setSetting('mfa_required_roles', 'navigator');
  try {
    const u = H.makeUser('graceover', 'navigator');
    H.db.run(`UPDATE users SET created_at=? WHERE id=?`, new Date(Date.now() - 4 * 86400000).toISOString(), u.id);
    const c = H.client();
    const login = await c.post('/api/auth/login', { username: u.username, password: u.password });
    assert.equal(login.status, 200, 'signing in still works');
    assert.ok(Date.parse(login.data.mfaSetupDeadline) < Date.now());
    const blocked = await c.get('/api/clients');
    assert.equal(blocked.status, 403); assert.equal(blocked.data.mfaSetupRequired, true);
    // The app shell loads these before it can show the enrolment page; they carry no PHI.
    assert.equal((await c.get('/api/meta/constants')).status, 200);
    assert.equal((await c.get('/api/me/prefs')).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 200);
    const setup = await c.post('/api/auth/mfa/setup', {});
    assert.equal(setup.status, 200, 'enrolment is reachable');
  } finally { H.db.run(`DELETE FROM settings WHERE key='mfa_required_roles'`); }
});
