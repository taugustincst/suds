'use strict';
// Field devices on the device itself (released in 1.21.0): the browser kernel, run in Node
// (test/fixtures/kernel-harness.js), syncing with a real office. A device an administrator makes a field device first
// sends what it recorded under the full scope, then removes everything a field device may not hold, then pulls again
// under the field scope; made a full device again, it receives the rest. Nothing recorded on it is lost either way.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base; let admin; const office = {};
const PW = 'StaffPassw0rd!x';
const ids = {};
let nav; let other;
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  nav = H.makeUser('fkdevice', 'navigator', PW); other = H.makeUser('fkother', 'navigator', PW);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  for (const u of [nav, other]) { office[u.username] = H.client(); await office[u.username].login(u.username, PW); }
  const mk = async (c, path, body) => { const r = await c.post(path, body); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.data)}`); return r.data.id; };
  ids.own = await mk(office.fkdevice, '/api/clients', { first_name: 'Olive', last_name: 'Fkown', dob: '1981-01-01', phone: '916-555-0111' });
  ids.theirs = await mk(office.fkother, '/api/clients', { first_name: 'Theo', last_name: 'Fktheirs', dob: '1982-02-02' });
  ids.note = await mk(office.fkdevice, '/api/notes', { client_id: ids.own, kind: 'admin', format: 'narrative', title: 'Fk note', content: 'Fk note content', occurred_at: new Date().toISOString() });
  ids.visit = await mk(office.fkdevice, '/api/interventions', { client_id: ids.own, type: 'outreach', occurred_at: new Date(Date.now() - 86400000).toISOString(), duration_minutes: 5 });
});
after(async () => { await H.stop(); cleanup(); });

const device = (...a) => kernelCaller(L)(...a);
const ok = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data).slice(0, 500)}`); return r.data; };
const sync = async () => ok(await device('POST', '/api/local/sync', { server: base, username: nav.username, password: PW }), 200, 'sync');
const deviceClients = async () => ok(await device('GET', '/api/clients?status=all&limit=100'), 200, 'device clients').clients.map(c => c.id);
const deviceId = () => H.db.one(`SELECT id FROM devices WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 1`, nav.id).id;

test('a full device holds everything its user may read', async () => {
  ok(await device('POST', '/api/local/setup', { display_name: 'Fk Device', username: nav.username, password: PW, role: 'navigator' }), 200, 'device set-up');
  ok(await device('POST', '/api/auth/login', { username: nav.username, password: PW }), 200, 'device sign-in');
  await sync();
  const c = await deviceClients();
  assert.ok(c.includes(ids.own) && c.includes(ids.theirs));
  const own = ok(await device('GET', `/api/clients/${ids.own}`), 200, 'own client');
  assert.equal((own.client || own).dob, '1981-01-01');
  const st = ok(await device('GET', '/api/local/sync/status'), 200, 'status');
  assert.equal(st.device.scope, 'full');
  assert.equal(st.device.field, null);
});

test('made a field device, it sends what it recorded first, then keeps only what a field worker needs', async () => {
  // Recorded on the device while it was a full device: a contact with the other worker's client.
  const v = ok(await device('POST', '/api/interventions', { client_id: ids.theirs, type: 'outreach', occurred_at: new Date().toISOString(), duration_minutes: 5 }), 201, 'offline visit');
  ids.offline = v.id;
  ok(await admin.post(`/api/admin/devices/${deviceId()}/scope`, { scope: 'field' }), 200, 'make field');
  const s = await sync();
  assert.ok((s.notices || []).some(n => /now a field device/.test(n)), JSON.stringify(s.notices));
  assert.ok(H.db.one(`SELECT 1 AS x FROM interventions WHERE id=?`, ids.offline), 'the contact recorded before reached the office');
  assert.deepEqual(await deviceClients(), [ids.own], 'only the worker\'s own recent client is left');
  const own = ok(await device('GET', `/api/clients/${ids.own}`), 200, 'own client');
  const rec = own.client || own;
  assert.equal(rec.first_name, 'Olive');
  assert.ok(!rec.dob && !rec.phone, 'no date of birth or phone on a field device');
  assert.equal((await device('GET', `/api/notes/${ids.note}`)).status, 404, 'notes are gone');
  assert.equal((await device('GET', `/api/interventions/${ids.offline}`)).status, 404, 'the other worker\'s client\'s contact is gone too, after it was sent');
  assert.equal((await device('GET', `/api/interventions/${ids.visit}`)).status, 200, 'the worker\'s own contact is kept');
  const st = ok(await device('GET', '/api/local/sync/status'), 200, 'status');
  assert.equal(st.device.scope, 'field');
  assert.equal(st.device.field.window_days, 90);
  assert.match(st.device.field.holds, /own caseload/);
  // The office lost nothing.
  const M = require('../server/clients-model');
  assert.equal(M.decryptRow(H.db.one(`SELECT * FROM clients WHERE id=?`, ids.own)).dob, '1981-01-01');
  assert.ok(H.db.one(`SELECT 1 AS x FROM notes WHERE id=?`, ids.note));
});

test('an edit made on a field device lands at the office without clearing what it never held', async () => {
  const cur = ok(await device('GET', `/api/clients/${ids.own}`), 200, 'own client');
  const rec = cur.client || cur;
  const r = await device('PUT', `/api/clients/${ids.own}`, { first_name: rec.first_name, last_name: rec.last_name, flags: 'dog on site' });
  assert.ok([200, 204].includes(r.status), JSON.stringify(r.data));
  const s = await sync();
  assert.equal((s.rejected || []).length, 0, JSON.stringify(s.rejected));
  const M = require('../server/clients-model');
  const office1 = M.decryptRow(H.db.one(`SELECT * FROM clients WHERE id=?`, ids.own));
  assert.equal(office1.flags, 'dog on site');
  assert.equal(office1.dob, '1981-01-01'); assert.equal(office1.phone, '916-555-0111');
});

test('made a full device again, it receives everything back', async () => {
  ok(await admin.post(`/api/admin/devices/${deviceId()}/scope`, { scope: 'full' }), 200, 'make full');
  const s = await sync();
  assert.ok((s.notices || []).some(n => /no longer a field device/.test(n)), JSON.stringify(s.notices));
  const c = await deviceClients();
  assert.ok(c.includes(ids.theirs) && c.includes(ids.own));
  const own = ok(await device('GET', `/api/clients/${ids.own}`), 200, 'own client');
  assert.equal((own.client || own).dob, '1981-01-01');
  assert.equal((await device('GET', `/api/notes/${ids.note}`)).status, 200);
  assert.equal(ok(await device('GET', '/api/local/sync/status'), 200, 'status').device.scope, 'full');
});
