'use strict';
// Security review of 1.16.3, N1, on a device two navigators share (and nobody who may read SUD counseling notes): a
// note flagged as one at the office after they pulled it is removed for both when either syncs. The keep rule
// judged the other navigator against the device's pre-flag copy, which any navigator may read, so it was never
// removed. With a clinician on the device: test/shared-device-drop.test.js. The browser kernel runs in Node
// (test/fixtures/kernel-harness.js), one per test process.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base;
const PW = 'StaffPassw0rd!x';
let clinC; let client;
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  const clin = H.makeUser('sdn_clin', 'clinician', PW);
  clinC = H.client(); await clinC.login(clin.username, PW);
  client = (await clinC.post('/api/clients', { first_name: 'Nav', last_name: 'Only', dob: '1982-02-02' })).data.id;
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; };
const sync = async (u) => ok(await device('POST', '/api/local/sync', { server: base, username: u.username, password: PW }), 200, `sync as ${u.username}`);
const signIn = async (u) => ok(await device('POST', '/api/auth/login', { username: u.username, password: PW }), 200, `sign in as ${u.username}`);

test('two navigators on one device: a note flagged at the office is gone for both after either syncs', async () => {
  const navA = H.makeUser('sdn_nava', 'navigator', PW); const navB = H.makeUser('sdn_navb', 'navigator', PW);
  const N = (await clinC.post('/api/notes', { client_id: client, kind: 'clinical', format: 'narrative', content: 'SECRET pre-flag draft', occurred_at: new Date().toISOString() })).data.id;
  ok(await device('POST', '/api/local/setup', { display_name: 'Nav A', username: navA.username, password: PW, role: 'navigator' }), 200, 'device set-up');
  await signIn(navA); await sync(navA); await sync(navB);
  await signIn(navA); ok(await device('GET', `/api/notes/${N}`), 200, 'navA holds the draft');
  const u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, N).updated_at;
  ok(await clinC.put(`/api/notes/${N}`, { counseling_note: true, if_updated_at: u }), 200, 'flagged at the office');
  await sync(navA);
  await signIn(navA);
  assert.equal((await device('GET', `/api/notes/${N}`)).status, 404, 'navA no longer has it');
  await signIn(navB);
  assert.equal((await device('GET', `/api/notes/${N}`)).status, 404, 'nor does navB, who has not synced since');
});
