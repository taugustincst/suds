'use strict';
// Follow-up to-dos on a device that syncs with the office (released in 1.23.0;
// server/rules/follow-ups.js): the browser kernel, bundled from the current sources, makes and moves the to-do itself
// with the same rule, links it to the call or visit, and the office, running the rule again on the push, finds that
// to-do rather than making a second one.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base; let office;
const USER = 'fusync'; const PASSWORD = 'FuSyncPassw0rd!x';
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  H.makeUser(USER, 'admin', PASSWORD);
  office = H.client(); await office.login(USER, PASSWORD);
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const sync = async () => { const s = ok(await device('POST', '/api/local/sync', { server: base, username: USER, password: PASSWORD }), 200, 'sync'); assert.equal((s.rejected || []).length, 0, JSON.stringify(s.rejected)); return s; };
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('a device\'s call and visit follow-ups: one to-do each at the office, moved with the date', async () => {
  const clientId = ok(await office.post('/api/clients', { first_name: 'Kai', last_name: 'Kernel', status: 'active', confirm_duplicate: true }), 201, 'client').id;
  ok(await device('POST', '/api/local/setup', { display_name: 'FU Sync', username: USER, password: PASSWORD, role: 'admin' }), 200, 'device set-up');
  ok(await device('POST', '/api/auth/login', { username: USER, password: PASSWORD }), 200, 'device sign-in');
  await sync();
  const call = ok(await device('POST', '/api/calls', { client_id: clientId, direction: 'outbound', started_at: new Date().toISOString(), purpose: 'Kernel bed', follow_up_due: inDays(2) }), 201, 'device call').id;
  const visit = ok(await device('POST', '/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: new Date().toISOString() }), 201, 'device visit').id;
  ok(await device('PUT', `/api/interventions/${visit}`, { follow_up_due: inDays(4) }), 200, 'date added on the device');
  ok(await device('PUT', `/api/calls/${call}`, { follow_up_due: inDays(6) }), 200, 'date moved on the device');
  await sync();
  const at = (col, id) => H.db.all(`SELECT * FROM tasks WHERE ${col}=?`, id);
  assert.equal(at('call_id', call).length, 1, 'one call-back to-do at the office');
  assert.equal(at('call_id', call)[0].due_at, inDays(6));
  assert.equal(at('intervention_id', visit).length, 1, 'one visit follow-up at the office');
  assert.equal(at('intervention_id', visit)[0].due_at, inDays(4));
  // The office moves the call's date; the device pulls the moved to-do and still has one.
  ok(await office.put(`/api/calls/${call}`, { follow_up_due: inDays(9) }), 200, 'office edit');
  await sync();
  const mine = ok(await device('GET', '/api/tasks?status=open'), 200, 'device to-dos');
  const rows = (mine.rows || mine.tasks || mine).filter(t => t.call_id === call);
  assert.equal(rows.length, 1); assert.equal(rows[0].due_at, inDays(9));
  assert.equal(at('call_id', call).length, 1, 'and the office still has one');
});
