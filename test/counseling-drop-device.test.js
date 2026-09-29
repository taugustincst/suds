'use strict';
// Security review of 1.16.1, M3, on the device: a clinical draft a navigator's device pulled, and then flagged as a SUD
// counseling note at the office, leaves that device at its next sync (dropped_rows, server/routes/sync.js exportInto),
// with its addenda. Before 1.16.2 the pull said nothing, and the device's own routes went on showing the old copy.
// The browser kernel runs in Node (test/fixtures/kernel-harness.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base;
const PW = 'StaffPassw0rd!x';
let nav; let clin; let clinC; let client; let note; let addendum;
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  nav = H.makeUser('cddevice', 'navigator', PW); clin = H.makeUser('cdclin', 'clinician', PW);
  clinC = H.client(); await clinC.login(clin.username, PW);
  client = (await clinC.post('/api/clients', { first_name: 'Cora', last_name: 'Counsel', dob: '1983-03-03' })).data.id;
  const n = await clinC.post('/api/notes', { client_id: client, kind: 'clinical', format: 'narrative', title: 'Cd draft', content: 'Cd draft content', occurred_at: new Date().toISOString() });
  assert.equal(n.status, 201, JSON.stringify(n.data)); note = n.data.id;
  const a = await clinC.post(`/api/notes/${note}/addenda`, { content: 'Cd addendum' });
  assert.equal(a.status, 201, JSON.stringify(a.data)); addendum = a.data.id;
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; };
const sync = async () => ok(await device('POST', '/api/local/sync', { server: base, username: nav.username, password: PW }), 200, 'sync');

test('a note flagged as a counseling note after the navigator\'s device pulled it is removed from the device at its next sync', async () => {
  ok(await device('POST', '/api/local/setup', { display_name: 'Cd Device', username: nav.username, password: PW, role: 'navigator' }), 200, 'device set-up');
  ok(await device('POST', '/api/auth/login', { username: nav.username, password: PW }), 200, 'device sign-in');
  await sync();
  const held = ok(await device('GET', `/api/notes/${note}`), 200, 'the device holds the clinical draft').note;
  assert.deepEqual(held.addenda.map(a => a.id), [addendum], 'and its addendum');
  let u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, note).updated_at;
  ok(await clinC.put(`/api/notes/${note}`, { counseling_note: true, if_updated_at: u }), 200, 'flag as a counseling note');
  await sync();
  assert.equal((await device('GET', `/api/notes/${note}`)).status, 404, 'gone from the device');
  assert.ok(!JSON.stringify(ok(await device('GET', `/api/notes?client_id=${client}`), 200, 'device notes')).includes(note));
  // The office never lost it, and the clinician still reads it.
  assert.equal((await clinC.get(`/api/notes/${note}`)).status, 200);
  // Unflagged, it comes back whole: the note and its addendum.
  u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, note).updated_at;
  ok(await clinC.put(`/api/notes/${note}`, { counseling_note: false, if_updated_at: u }), 200, 'unflag');
  await sync();
  const back = ok(await device('GET', `/api/notes/${note}`), 200, 'back on the device').note;
  assert.deepEqual(back.addenda.map(a => a.id), [addendum]);
});
