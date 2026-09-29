'use strict';
// UX review of 1.16.3, M1: a change notice pulled to a device is a notice there too. A device's audit trail has no
// entry for a notice the office raised, so the office names the notices in each pull (server/routes/sync.js
// `notices`) and the device takes its word for those rows only (local/sync.js keepNotices): the read-only card, the
// bell group and the client tile work on the phone, and only the worker told marks it seen. A to-do typed on the
// device never becomes one. The browser kernel runs in Node (test/fixtures/kernel-harness.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base;
const PW = 'StaffPassw0rd!x';
let navA; let navB; let navC; let client; let notice;
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  navA = H.makeUser('dn_nava', 'navigator', PW); navB = H.makeUser('dn_navb', 'navigator', PW); navC = H.makeUser('dn_navc', 'navigator', PW);
  const b = H.client(); await b.login(navB.username, PW);
  client = (await b.post('/api/clients', { first_name: 'Noa', last_name: 'Tice', dob: '1983-03-03' })).data.id;
  const a = H.client(); await a.login(navA.username, PW);
  const cur = (await a.get(`/api/clients/${client}`)).data;
  assert.equal((await a.put(`/api/clients/${client}`, { phone: '916-555-0199', updated_at: cur.updated_at || cur.client?.updated_at })).status, 200);
  notice = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='client.change_notice' AND client_id=?`, client).details).task;
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; };
const sync = async (u) => ok(await device('POST', '/api/local/sync', { server: base, username: u.username, password: PW }), 200, `sync as ${u.username}`);
const signIn = async (u) => ok(await device('POST', '/api/auth/login', { username: u.username, password: PW }), 200, `sign in as ${u.username}`);

test('a notice pulled to a device is a notice there, naming who made the change; only the worker told marks it seen', async () => {
  ok(await device('POST', '/api/local/setup', { display_name: 'Dn B', username: navB.username, password: PW, role: 'navigator' }), 200, 'device set-up');
  await signIn(navB); await sync(navB);
  const row = ok(await device('GET', `/api/tasks/${notice}`), 200, 'the notice on the device').row;
  assert.equal(row.notice, true);
  assert.equal(row.notice_by, 'dn_nava');
  const due = ok(await device('GET', '/api/tasks/due?within=60'), 200, 'the bell');
  assert.ok(due.rows.some(r => r.id === notice && r.notice === true), 'in the bell as a notice');
  // A to-do typed on the device with the notice's words is an ordinary one.
  const typed = ok(await device('POST', '/api/tasks', { client_id: client, title: 'Looks official', description: 'Changed: Phone\nReference: client record change notice' }), 201, 'typed on the device').id;
  assert.ok(!ok(await device('GET', `/api/tasks/${typed}`), 200, 'the typed one').row.notice);
  // Another account on the device cannot mark it seen; the worker told can, and the office has it.
  await sync(navC); await signIn(navC);
  assert.equal((await device('PUT', `/api/tasks/${notice}`, { status: 'done' })).status, 403);
  await signIn(navB);
  ok(await device('PUT', `/api/tasks/${notice}`, { status: 'done' }), 200, 'navB marks it seen');
  await sync(navB);
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, notice).status, 'done');
});
