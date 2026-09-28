'use strict';
// 1.16.0: what a local-mode device holds follows its person's permissions when they change, not only at the
// first sync. A navigator holds clients:all and notes:clinical:read by default; an administrator who holds
// them to their caseload (per-user denies, Settings -> Users & permissions -> Permissions) must see the
// device lose what the person may no longer read at its next sync, and lifting the denies must bring it back.
// A pull used to send only rows changed since the device's cursor, so neither happened (server/routes/sync.js
// syncScopeKey). The device also receives the person's own overrides and the office's caseload restriction,
// so its kernel scopes them as the office does. The browser kernel runs in Node (test/fixtures/kernel-harness.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base; let admin; let office = {};
const PW = 'StaffPassw0rd!x';
const ids = {};
let nav; let other; let clin;
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  nav = H.makeUser('scdevice', 'navigator', PW); other = H.makeUser('scother', 'navigator', PW); clin = H.makeUser('scclin', 'clinician', PW);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const u of [nav, other, clin]) { office[u.username] = H.client(); await office[u.username].login(u.username, PW); }
  const mk = async (c, path, body) => { const r = await c.post(path, body); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.data)}`); return r.data.id; };
  ids.own = await mk(office.scdevice, '/api/clients', { first_name: 'Owen', last_name: 'Scownclient', dob: '1981-01-01' });
  ids.theirs = await mk(office.scother, '/api/clients', { first_name: 'Tess', last_name: 'Sctheirs', dob: '1982-02-02' });
  ids.clinical = await mk(office.scclin, '/api/notes', { client_id: ids.own, kind: 'clinical', format: 'narrative', title: 'Sc clinical', content: 'Sc clinical content', occurred_at: new Date().toISOString() });
  ids.admin = await mk(office.scclin, '/api/notes', { client_id: ids.own, kind: 'admin', format: 'narrative', title: 'Sc admin', content: 'Sc admin content', occurred_at: new Date().toISOString() });
  ids.call = await mk(office.scother, '/api/calls', { direction: 'inbound', method: 'phone', started_at: new Date().toISOString(), contact_name: 'Sc Walkin', phone: '916-555-0177', summary: 'no client yet' });
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 400)}`); return r.data; };
const sync = async () => ok(await device('POST', '/api/local/sync', { server: base, username: nav.username, password: PW }), 200, 'sync');
const onDevice = async () => {
  const clients = ok(await device('GET', '/api/clients?status=all&limit=100'), 200, 'device clients').clients.map(c => c.id);
  const notes = JSON.stringify(ok(await device('GET', `/api/notes?client_id=${ids.own}`), 200, 'device notes'));
  const call = (await device('GET', `/api/calls/${ids.call}`)).status;
  return { clients, clinical: notes.includes(ids.clinical), adminNote: notes.includes(ids.admin), call };
};
const permit = async (perm, mode) => ok(await admin.post(`/api/users/${nav.id}/permissions`, { permission: perm, mode, reason: 'scope change test for a device' }), 200, `${mode} ${perm}`);
const lift = async (perm) => { const r = await admin.del(`/api/users/${nav.id}/permissions/${encodeURIComponent(perm)}`); assert.ok([200, 204].includes(r.status), `lift ${perm}: ${r.status} ${JSON.stringify(r.data)}`); };

test('a navigator\'s device first pulls the whole programme, clinical notes included', async () => {
  ok(await device('POST', '/api/local/setup', { display_name: 'Sc Device', username: nav.username, password: PW, role: 'navigator' }), 200, 'device set-up');
  ok(await device('POST', '/api/auth/login', { username: nav.username, password: PW }), 200, 'device sign-in');
  await sync();
  const d = await onDevice();
  assert.ok(d.clients.includes(ids.own) && d.clients.includes(ids.theirs), 'both clients');
  assert.ok(d.clinical && d.adminNote, 'the clinical note too (notes:clinical:read)');
  assert.equal(d.call, 200, 'and another worker\'s call with no client (clients:all)');
});

test('denying clients:all and notes:clinical:read at the office removes what they no longer allow from the device', async () => {
  await permit('clients:all', 'deny'); await permit('notes:clinical:read', 'deny');
  const s = await sync();
  assert.ok((s.notices || []).some(n => /removed from this device/.test(n)), JSON.stringify(s.notices));
  const d = await onDevice();
  assert.deepEqual(d.clients, [ids.own], 'only their caseload is left on the device');
  assert.ok(!d.clinical, 'the clinical note is gone');
  assert.ok(d.adminNote, 'the admin note stays');
  assert.notEqual(d.call, 200, 'another worker\'s call with no client is gone');
  const me = ok(await device('GET', '/api/auth/me'), 200, 'me').user;
  assert.equal(me.caseload_restricted, true, 'the device applies the office\'s denies (and caseload restriction) itself');
  assert.ok(me.denied_permissions.includes('clients:all'));
  // The office never lost them.
  assert.ok(H.db.one(`SELECT 1 FROM clients WHERE id=?`, ids.theirs) && H.db.one(`SELECT 1 FROM notes WHERE id=?`, ids.clinical) && H.db.one(`SELECT 1 FROM calls WHERE id=?`, ids.call));
  // A second sync with nothing changed removes nothing more and restarts nothing.
  const again = await sync();
  assert.ok(!(again.notices || []).some(n => /access at the office changed/.test(n)), JSON.stringify(again.notices));
});

test('lifting the denies brings the rest of the programme back to the device at its next sync', async () => {
  await lift('clients:all'); await lift('notes:clinical:read');
  const s = await sync();
  assert.ok((s.notices || []).some(n => /downloaded everything you may now see/.test(n)), JSON.stringify(s.notices));
  const d = await onDevice();
  assert.ok(d.clients.includes(ids.theirs), 'the other worker\'s client is back');
  assert.ok(d.clinical, 'and the clinical note');
  assert.equal(d.call, 200);
  assert.equal(ok(await device('GET', '/api/auth/me'), 200, 'me').user.caseload_restricted, false);
});
