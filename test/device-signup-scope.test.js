'use strict';
// SUDS on this device, 1.16.0: navigators and clinicians hold clients:all (and navigators notes:clinical:read)
// by default, but a person who signs up on a shared device after the first still sees only the clients they
// record or are assigned, as before: the kernel gives each such sign-up per-user denies of both
// (local/kernel.js SIGNUP_SCOPE). They stay when the device administrator makes the account a clinician, and
// go when it is made a supervisor. The device administrator keeps the role's defaults. The browser kernel is
// bundled from the current sources and run in Node (test/fixtures/kernel-harness.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let call;
before(async () => { ({ L, cleanup } = await loadKernel({ staticHost: true })); call = kernelCaller(L); });
after(async () => { if (cleanup) cleanup(); });

const PW = 'Owner-Device-2026!'; const PW2 = 'Second-Device-2026!';
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
const signIn = async (username, password) => expect(await call('POST', '/api/auth/login', { username, password }), 200, `sign in as ${username}`);
const signOut = () => call('POST', '/api/auth/logout', {});
const names = async () => expect(await call('GET', '/api/clients?status=all&limit=100'), 200, 'clients').clients.map(c => c.last_name).sort();

let ownerClient; let secondId;

test('the first account (a navigator here) keeps the role\'s defaults; a later sign-up is held to its own caseload', async () => {
  expect(await call('POST', '/api/local/signup', { display_name: 'Device Owner', username: 'owner', password: PW, role: 'navigator', storage_ack: true }), 200, 'first account');
  await signIn('owner', PW);
  ownerClient = expect(await call('POST', '/api/clients', { first_name: 'Alpha', last_name: 'Ownersclient', status: 'active' }), 201, 'owner\'s client').id;
  expect(await call('POST', '/api/local/signup', { display_name: 'Sam Second', username: 'second', password: PW2 }), 200, 'a second account');
  await signOut();
  const me = await signIn('second', PW2); secondId = me.user.id;
  assert.equal(me.user.role, 'navigator');
  const whoami = expect(await call('GET', '/api/auth/me'), 200, 'me');
  assert.equal(whoami.user.caseload_restricted, true, 'caseload-scoped');
  assert.ok(whoami.user.denied_permissions.includes('clients:all') && whoami.user.denied_permissions.includes('notes:clinical:read'), JSON.stringify(whoami.user.denied_permissions));
  assert.deepEqual(await names(), [], 'the first person\'s client is not theirs to see');
  assert.equal((await call('GET', `/api/clients/${ownerClient}`)).status, 403);
  expect(await call('POST', '/api/clients', { first_name: 'Beta', last_name: 'Secondsclient', status: 'active' }), 201, 'their own client');
  assert.deepEqual(await names(), ['Secondsclient']);
  await signOut();
  await signIn('owner', PW);
  assert.deepEqual(await names(), ['Ownersclient', 'Secondsclient'], 'the device administrator, a navigator, sees every client on the device (clients:all)');
});

test('made a clinician by the device administrator, the sign-up stays held to its caseload; made a supervisor, it is not', async () => {
  expect(await call('PUT', `/api/local/accounts/${secondId}`, { role: 'clinician' }), 200, 'to clinician');
  await signOut(); await signIn('second', PW2);
  assert.deepEqual(await names(), ['Secondsclient'], 'still their own caseload');
  await signOut(); await signIn('owner', PW);
  expect(await call('PUT', `/api/local/accounts/${secondId}`, { role: 'supervisor' }), 200, 'to supervisor');
  await signOut(); await signIn('second', PW2);
  assert.deepEqual(await names(), ['Ownersclient', 'Secondsclient'], 'a supervisor sees every client');
  assert.equal(expect(await call('GET', '/api/auth/me'), 200, 'me').user.denied_permissions.length, 0, 'the sign-up denies went with the promotion');
});

// The owner's decision after 1.23.5: the device administrator may change their own role too. They keep managing
// the device whatever it is (deviceAdminId), the change applies to the session they make it from at once, and the
// device always keeps an account that can manage users and permissions (auth.lockoutProblem), as at the office.
test('the device administrator changes their own role, audited with self: true, but never leaves nobody who manages users', async () => {
  await signOut(); await signIn('owner', PW);
  const ownerId = expect(await call('GET', '/api/auth/me'), 200, 'me').user.id;
  // A navigator device with nobody who manages users yet: becoming an administrator is not refused.
  expect(await call('PUT', `/api/local/accounts/${ownerId}`, { role: 'admin' }), 200, 'own role to administrator');
  const me = expect(await call('GET', '/api/auth/me'), 200, 'still signed in').user;
  assert.equal(me.role, 'admin'); assert.ok(me.permissions.includes('users:manage'), 'at once, in the same session');
  const a = expect(await call('GET', '/api/admin/audit?action=local.account.role'), 200, 'audit').rows.find(x => x.entity_id === ownerId);
  assert.equal(a.details.self, true);
  // The only administrator now: stepping down is refused.
  const r = await call('PUT', `/api/local/accounts/${ownerId}`, { role: 'navigator' });
  assert.equal(r.status, 400); assert.match(r.data.error, /no active administrator who can manage users/);
  // With another administrator, it is allowed, and they still manage the device.
  expect(await call('PUT', `/api/local/accounts/${secondId}`, { role: 'admin' }), 200, 'second to administrator');
  expect(await call('PUT', `/api/local/accounts/${ownerId}`, { role: 'supervisor' }), 200, 'own role to supervisor');
  assert.equal(expect(await call('GET', '/api/local/device'), 200, 'device').device_admin, true, 'still manages the device');
  expect(await call('PUT', `/api/local/accounts/${ownerId}`, { role: 'admin' }), 200, 'and can take the administrator role back here');
});
