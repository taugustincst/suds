'use strict';
// Sign up on the office server: POST /api/auth/signup creates a request that cannot sign in until an
// administrator approves it (Settings -> Users & roles -> Access requests), and the self_signup setting.
process.env.SIGNUP_RATE_LIMIT = '8';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin;
const PW = 'Requested-Passw0rd!';
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
});
after(() => H.stop());

const req = (over = {}) => ({ display_name: 'Riley Request', username: 'rrequest', email: 'riley@example.org', password: PW, reason: 'New peer navigator, north team', ...over });

test('sign-up status is public and says whether the form is open, with the programme contact', async () => {
  H.db.setSetting('program_contact', 'Privacy officer: Sam Lee, 555-0100');
  const r = await H.client().get('/api/auth/signup/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true, 'on by default');
  assert.equal(r.data.program_contact, 'Privacy officer: Sam Lee, 555-0100');
});

test('a sign-up needs the CSRF header and a password that meets the policy', async () => {
  const anon = H.client();
  const noHeader = await anon.post('/api/auth/signup', req(), { 'X-Requested-With': '' });
  assert.equal(noHeader.status, 403);
  const weak = await anon.post('/api/auth/signup', req({ password: 'short' }));
  assert.equal(weak.status, 400);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM users WHERE username='rrequest'`).n, 0);
});

test('a request creates a pending account that cannot sign in; the answer never reveals whether the username exists', async () => {
  const anon = H.client();
  const r = await anon.post('/api/auth/signup', req());
  assert.equal(r.status, 202);
  const u = H.db.one(`SELECT * FROM users WHERE username='rrequest'`);
  assert.equal(u.access_status, 'pending');
  assert.equal(u.is_active, 0);
  assert.equal(u.access_note, 'New peer navigator, north team');
  assert.ok(u.requested_at);
  assert.ok(!u.password_hash.includes(PW));
  // The same answer for a name that is already taken (an existing account), and nothing is changed.
  const dup = await anon.post('/api/auth/signup', req({ username: 'admin', display_name: 'Not Admin' }));
  assert.equal(dup.status, 202);
  assert.deepEqual(dup.data, r.data);
  assert.equal(H.db.one(`SELECT display_name FROM users WHERE username='admin'`).display_name !== 'Not Admin', true);
  // Audited, with no password in the details.
  const a = H.db.all(`SELECT * FROM audit_log WHERE action='user.signup.requested'`);
  assert.ok(a.length >= 2);
  assert.ok(a.every(x => !String(x.details || '').includes(PW)));
  // Signing in: a wrong password gets the ordinary failure; the right one is told the request is waiting.
  const wrong = await H.client().post('/api/auth/login', { username: 'rrequest', password: 'Wrong-Passw0rd!!' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error, /Invalid username or password/);
  const pending = await H.client().post('/api/auth/login', { username: 'rrequest', password: PW });
  assert.equal(pending.status, 403);
  assert.equal(pending.data.accessPending, true);
  assert.match(pending.data.error, /waiting for an administrator to approve/);
  assert.ok(!pending.headers.get('set-cookie'), 'no session is created');
});

test('only an administrator sees and answers access requests', async () => {
  const nav = H.makeUser('signup_nav', 'navigator'); const c = H.client(); await c.login(nav.username, nav.password);
  assert.equal((await c.get('/api/users/access-requests')).status, 403);
  const id = H.db.one(`SELECT id FROM users WHERE username='rrequest'`).id;
  assert.equal((await c.post(`/api/users/${id}/approve`, { role: 'navigator' })).status, 403);
  const list = await admin.get('/api/users/access-requests');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.requests.map(x => x.username), ['rrequest']);
  assert.equal(list.data.requests[0].reason, 'New peer navigator, north team');
  // Not in the ordinary user list, nor the staff directory, while pending.
  assert.ok(!(await admin.get('/api/users')).data.users.some(u => u.username === 'rrequest'));
});

test('approval sets the role and supervisor, lets the account sign in, and starts the MFA grace period then', async () => {
  const id = H.db.one(`SELECT id FROM users WHERE username='rrequest'`).id;
  // Pretend the request waited a month: the grace period must still run from approval.
  H.db.run(`UPDATE users SET created_at=? WHERE id=?`, new Date(Date.now() - 30 * 86400000).toISOString(), id);
  const sup = H.makeUser('signup_sup', 'supervisor');
  assert.equal((await admin.post(`/api/users/${id}/approve`, { role: 'bogus' })).status, 400);
  const ok = await admin.post(`/api/users/${id}/approve`, { role: 'navigator', supervisor_id: sup.id });
  assert.equal(ok.status, 200);
  const u = H.db.one(`SELECT * FROM users WHERE id=?`, id);
  assert.equal(u.access_status, 'active'); assert.equal(u.is_active, 1); assert.equal(u.role, 'navigator'); assert.equal(u.supervisor_id, sup.id);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='user.signup.approved' AND entity_id=?`, id));
  assert.equal((await admin.post(`/api/users/${id}/approve`, { role: 'navigator' })).status, 400, 'answered once');
  H.db.setSetting('mfa_required_roles', 'navigator'); H.db.setSetting('mfa_grace_days', '7');
  try {
    const c = H.client();
    const r = await c.post('/api/auth/login', { username: 'rrequest', password: PW });
    assert.equal(r.status, 200);
    assert.equal(r.data.mfaSetupRequired, true, 'the MFA policy applies like any other account');
    const days = (Date.parse(r.data.mfaSetupDeadline) - Date.now()) / 86400000;
    assert.ok(days > 6 && days <= 7, `grace runs from approval (${days} days left)`);
    assert.equal((await c.get('/api/clients')).status, 200, 'and the account works inside its grace period');
  } finally { H.db.run(`DELETE FROM settings WHERE key IN ('mfa_required_roles','mfa_grace_days')`); }
});

test('a declined request cannot sign in and is told so only with the right password', async () => {
  await H.client().post('/api/auth/signup', req({ username: 'ddecline', display_name: 'Dee Decline' }));
  const id = H.db.one(`SELECT id FROM users WHERE username='ddecline'`).id;
  assert.equal((await admin.post(`/api/users/${id}/decline`, {})).status, 200);
  assert.equal(H.db.one(`SELECT access_status FROM users WHERE id=?`, id).access_status, 'declined');
  const r = await H.client().post('/api/auth/login', { username: 'ddecline', password: PW });
  assert.equal(r.status, 403); assert.equal(r.data.accessDeclined, true);
  assert.equal((await H.client().post('/api/auth/login', { username: 'ddecline', password: 'Wrong-Passw0rd!!' })).status, 401);
  // An administrator who changes their mind re-activates the account from the ordinary user form.
  assert.equal((await admin.put(`/api/users/${id}`, { is_active: true, role: 'navigator' })).status, 200);
  assert.equal(H.db.one(`SELECT access_status FROM users WHERE id=?`, id).access_status, 'active');
  assert.equal((await H.client().post('/api/auth/login', { username: 'ddecline', password: PW })).status, 200);
});

test('self_signup off: the status says so and the route refuses with 403', async () => {
  assert.equal((await admin.put('/api/admin/settings', { self_signup: 'maybe' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { self_signup: '0' })).status, 200);
  assert.equal((await admin.get('/api/admin/settings')).data.self_signup, '0');
  assert.equal((await H.client().get('/api/auth/signup/status')).data.enabled, false);
  const r = await H.client().post('/api/auth/signup', req({ username: 'offrequest' }));
  assert.equal(r.status, 403); assert.equal(r.data.signupDisabled, true);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM users WHERE username='offrequest'`).n, 0);
  await admin.put('/api/admin/settings', { self_signup: '1' });
});

test('settings: mfa_grace_days is accepted; default_funding_source_id is no longer a setting', async () => {
  assert.equal((await admin.put('/api/admin/settings', { mfa_grace_days: 3, default_funding_source_id: 'x' })).status, 200);
  const s = (await admin.get('/api/admin/settings')).data;
  assert.equal(s.mfa_grace_days, '3');
  assert.ok(!('default_funding_source_id' in s));
  assert.equal(H.db.getSetting('default_funding_source_id', null), null);
  await admin.put('/api/admin/settings', { mfa_grace_days: null });
});

test('sign-ups are rate limited per address', async () => {
  let last;
  for (let i = 0; i < 10; i++) { last = await H.client().post('/api/auth/signup', req({ username: `flood${i}` })); if (last.status === 429) break; }
  assert.equal(last.status, 429);
});
