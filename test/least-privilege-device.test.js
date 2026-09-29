'use strict';
// 1.17.0, the programme-wide least-privilege default (server/caseload-default.js) on SUDS on this device, run
// in the browser kernel bundled from the current sources (test/fixtures/kernel-harness.js). A new device is a
// new install: the default is on. A device sign-up (/api/local/signup) is held to its caseload whatever the
// setting says (local/kernel.js SIGNUP_SCOPE, stricter: clinical notes too). An account the device administrator
// creates under Settings -> Users & permissions (POST /api/users) is held by the default, and one the device
// administrator makes a navigator or clinician under This device (PUT /api/local/accounts/:id) is too; made a
// supervisor, the default's deny goes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let call;
before(async () => { ({ L, cleanup } = await loadKernel({ staticHost: true })); call = kernelCaller(L); });
after(async () => { if (cleanup) cleanup(); });

const PW = 'Owner-Device-2026!'; const PW2 = 'Second-Device-2026!'; const PW3 = 'Third-Device-2026!x';
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
const signIn = async (username, password) => expect(await call('POST', '/api/auth/login', { username, password }), 200, `sign in as ${username}`);
const signOut = () => call('POST', '/api/auth/logout', {});
const names = async () => expect(await call('GET', '/api/clients?status=all&limit=100'), 200, 'clients').clients.map(c => c.last_name).sort();

let made;

test('a new device starts with the default on; a device sign-up is held to its caseload (stricter than the default)', async () => {
  expect(await call('POST', '/api/local/signup', { display_name: 'Device Owner', username: 'owner', password: PW, role: 'admin', storage_ack: true }), 200, 'first account');
  await signIn('owner', PW);
  const d = expect(await call('GET', '/api/users/caseload-default'), 200, 'read the default');
  assert.equal(d.enabled, true);
  expect(await call('POST', '/api/clients', { first_name: 'Alpha', last_name: 'Ownersclient', status: 'active' }), 201, 'owner\'s client');
  // Off: a device sign-up is still held.
  expect(await call('PUT', '/api/users/caseload-default', { enabled: false }), 200, 'off');
  expect(await call('POST', '/api/local/signup', { display_name: 'Sam Second', username: 'second', password: PW2 }), 200, 'a sign-up');
  await signOut();
  await signIn('second', PW2);
  const me = expect(await call('GET', '/api/auth/me'), 200, 'me').user;
  assert.equal(me.caseload_restricted, true);
  assert.deepEqual([...me.denied_permissions].sort(), ['clients:all', 'notes:clinical:read']);
  assert.deepEqual(await names(), []);
  await signOut(); await signIn('owner', PW);
  expect(await call('PUT', '/api/users/caseload-default', { enabled: true }), 200, 'on');
});

test('the device administrator creates a navigator: held by the default, and the scoping holds on the device', async () => {
  made = expect(await call('POST', '/api/users', { username: 'third', display_name: 'Tia Third', role: 'navigator', password: PW3 }), 201, 'create');
  assert.equal(made.held_to_caseload, true);
  const perms = expect(await call('GET', `/api/users/${made.id}/permissions`), 200, 'permissions');
  assert.deepEqual(perms.overrides.map(o => [o.permission, o.mode, o.reason]), [['clients:all', 'deny', 'programme default: held to caseload']]);
  const scope = expect(await call('GET', '/api/users'), 200, 'users').users.find(u => u.id === made.id).client_scope;
  assert.deepEqual(scope, { scope: 'caseload', held_by_default: true });
  await signOut();
  const r = await call('POST', '/api/auth/login', { username: 'third', password: PW3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // A new account's temporary password is changed at its first sign-in.
  expect(await call('POST', '/api/auth/password', { current_password: PW3, new_password: PW3 + 'z' }), 200, 'change password');
  assert.equal(expect(await call('GET', '/api/auth/me'), 200, 'me').user.caseload_restricted, true);
  assert.deepEqual(await names(), [], 'another person\'s client is not theirs to see');
  await signOut(); await signIn('owner', PW);
});

test('This device: made a supervisor the default\'s deny goes; made a clinician again, it comes back', async () => {
  let r = expect(await call('PUT', `/api/local/accounts/${made.id}`, { role: 'supervisor' }), 200, 'to supervisor');
  assert.equal(r.caseload_default, 'lifted');
  assert.deepEqual(expect(await call('GET', `/api/users/${made.id}/permissions`), 200, 'p').overrides, []);
  r = expect(await call('PUT', `/api/local/accounts/${made.id}`, { role: 'clinician' }), 200, 'to clinician');
  assert.equal(r.caseload_default, 'held');
  assert.deepEqual(expect(await call('GET', `/api/users/${made.id}/permissions`), 200, 'p').denied, ['clients:all']);
});
