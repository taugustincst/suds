'use strict';
// Security review of 1.16.2, M2, on a shared device: a clinician and a navigator sign in to the same phone (each with
// their own pull cursor). The navigator's sync must not delete a SUD counseling note the clinician holds there, nor
// the clinician's unsynced edit to it, nor send that edit up under the navigator's account (where the office
// refuses it for good and the device would then forget it). The browser kernel runs in Node
// (test/fixtures/kernel-harness.js), as in test/counseling-drop-device.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base;
const PW = 'StaffPassw0rd!x';
let nav; let clin; let clinC; let client;
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  nav = H.makeUser('sdnav', 'navigator', PW); clin = H.makeUser('sdclin', 'clinician', PW);
  clinC = H.client(); await clinC.login(clin.username, PW);
  client = (await clinC.post('/api/clients', { first_name: 'Shay', last_name: 'Ared', dob: '1981-01-01' })).data.id;
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; };
const sync = async (u) => ok(await device('POST', '/api/local/sync', { server: base, username: u.username, password: PW }), 200, `sync as ${u.username}`);
const signIn = async (u) => ok(await device('POST', '/api/auth/login', { username: u.username, password: PW }), 200, `sign in as ${u.username}`);
const officeContent = (id) => require('../server/crypto').decrypt(H.db.one(`SELECT content_enc FROM notes WHERE id=?`, id).content_enc);
async function officeNote(content, counseling) {
  const n = await clinC.post('/api/notes', { client_id: client, kind: 'clinical', format: 'narrative', content, counseling_note: counseling, occurred_at: new Date().toISOString() });
  assert.equal(n.status, 201, JSON.stringify(n.data)); return n.data.id;
}
async function editOnDevice(id, content) {
  const held = ok(await device('GET', `/api/notes/${id}`), 200, 'the clinician reads it on the device').note;
  ok(await device('PUT', `/api/notes/${id}`, { content, if_updated_at: held.updated_at }), 200, 'offline edit');
}

test('the reviewer\'s repro: a navigator\'s sync keeps the clinician\'s counseling note and their offline edit, which reaches the office', async () => {
  const N = await officeNote('v1 office', true);
  ok(await device('POST', '/api/local/setup', { display_name: 'Sd Clin', username: clin.username, password: PW, role: 'clinician' }), 200, 'device set-up');
  await signIn(clin); await sync(clin);
  await sync(nav);
  const u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, N).updated_at;
  ok(await clinC.put(`/api/notes/${N}`, { content: 'v2 office', if_updated_at: u }), 200, 'office edit');
  await sync(clin);
  await editOnDevice(N, 'v3 device-only offline edit');
  await sync(nav);
  await signIn(clin);
  assert.equal(ok(await device('GET', `/api/notes/${N}`), 200, 'still on the device after the navigator synced').note.content, 'v3 device-only offline edit');
  await sync(clin);
  assert.equal(officeContent(N), 'v3 device-only offline edit', 'the clinician\'s edit reached the office');
});

test('a note flagged at the office stays on a device another account there may read, with its unsynced edit', async () => {
  const N = await officeNote('clinical draft', false);
  await signIn(clin); await sync(clin); await sync(nav);
  const u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, N).updated_at;
  ok(await clinC.put(`/api/notes/${N}`, { counseling_note: true, if_updated_at: u }), 200, 'flagged at the office');
  const P = await officeNote('another draft', false);
  await sync(clin); await sync(nav);
  const v = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, P).updated_at;
  ok(await clinC.put(`/api/notes/${P}`, { counseling_note: true, if_updated_at: v }), 200, 'the second flagged at the office');
  await sync(clin);
  await editOnDevice(N, 'edited on the device after the flag');
  await sync(nav); // the office names both notes to the navigator
  await signIn(clin);
  ok(await device('GET', `/api/notes/${P}`), 200, 'the clinician still reads the untouched one on the device');
  assert.equal(ok(await device('GET', `/api/notes/${N}`), 200, 'and the edited one').note.content, 'edited on the device after the flag');
  await sync(clin);
  assert.equal(officeContent(N), 'edited on the device after the flag');
});

// Security review of 1.16.3, N1: whether another account on the device may read a note the office has just named is
// judged against the note as it now is (a SUD counseling note), not the device's pre-flag copy, which any navigator
// may read. The office sends what makes it one (counseling_note, author_id, cosigned_by) with the drop. A device only
// navigators use drops it: test/shared-device-navigators.test.js.
const flagAtOffice = async (id) => {
  const u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, id).updated_at;
  ok(await clinC.put(`/api/notes/${id}`, { counseling_note: true, if_updated_at: u }), 200, 'flagged at the office');
};
test('an idle clinician on the device keeps the note, but it is a counseling note there: the navigator cannot read it', async () => {
  const idle = H.makeUser('sdidle', 'clinician', PW); const navC = H.makeUser('sdnavc', 'navigator', PW);
  const N = await officeNote('SECRET idle draft', false);
  await sync(idle); await sync(navC);
  await flagAtOffice(N);
  await sync(navC);
  await signIn(navC);
  assert.equal((await device('GET', `/api/notes/${N}`)).status, 403, 'the navigator cannot read it (the clinician keeps it)');
  const list = ok(await device('GET', `/api/notes?client_id=${client}`), 200, 'the navigator lists the notes');
  assert.ok(!JSON.stringify(list).includes(N), 'nor list it');
  await signIn(idle);
  ok(await device('GET', `/api/notes/${N}`), 200, 'the clinician still reads it on the device');
});
