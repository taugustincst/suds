'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = require('../server/db');

let admin, nav, sup;
before(async () => {
  await H.start();
  H.makeUser('nav1', 'navigator'); H.makeUser('sup1', 'supervisor'); H.makeUser('clin1', 'clinician');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('sup1', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('sample data: admin loads it, staff see it, it is removed cleanly with tombstones', async () => {
  assert.equal((await nav.get('/api/admin/demo')).status, 403);
  const st0 = (await admin.get('/api/admin/demo')).data;
  assert.equal(st0.loaded, false); assert.equal(st0.clients_total, 0);
  const r = await admin.post('/api/admin/demo', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.loaded, true); assert.equal(r.data.counts.clients, 12); assert.ok(r.data.counts.interventions > 50);
  assert.equal((await admin.post('/api/admin/demo', {})).status, 400);
  // navigator carries part of the sample caseload; codes are marked DEMO-
  const mine = (await nav.get('/api/caseload')).data.caseload; assert.ok(mine.length >= 3, 'navigator has sample caseload');
  const list = (await sup.get('/api/clients')).data; assert.equal(list.clients.length, 12); assert.ok(list.clients.every(c => c.client_code.startsWith('DEMO-')));
  const detail = (await sup.get(`/api/clients/${mine[0].id}`)).data; assert.ok(detail.client.first_name && detail.client.dob, 'PHI decrypts');
  const dash = (await sup.get('/api/reports/dashboard')).data; assert.ok(dash.interventions.total_30d > 0 || dash.clients.active > 0);
  const funds = (await sup.get('/api/budget/funds')).data.funds; assert.equal(funds.length, 2);
  // remove
  const rm = await admin.del('/api/admin/demo'); assert.equal(rm.status, 200); assert.ok(rm.data.removed > 300, `removed ${rm.data.removed}`);
  assert.equal((await sup.get('/api/clients')).data.clients.length, 0);
  assert.equal((await sup.get('/api/resources')).data.rows.length, 0);
  assert.equal(db.one(`SELECT COUNT(*) n FROM tombstones WHERE table_name='clients'`).n, 12);
  assert.equal((await admin.get('/api/admin/demo')).data.loaded, false);
  // refuses once real clients exist
  assert.equal((await nav.post('/api/clients', { first_name: 'Real', last_name: 'Person' })).status, 201);
  assert.equal((await admin.post('/api/admin/demo', {})).status, 400);
});

test('sample data beside existing clients: refused where records may be real, allowed on the static demo, removed cleanly', async () => {
  // Runs after the test above, which leaves one real client ("Real Person") behind.
  const demo = require('../server/demo');
  const st = demo.status();
  assert.ok(st.clients_total > 0 && !st.loaded);
  // The office server (and a browser copy it hands out) says why, and the screens are told not to offer it.
  const offered = (await admin.get('/api/admin/demo')).data;
  assert.equal(offered.can_load, false); assert.equal(offered.alongside, false);
  assert.match(demo.loadRefusal(st), /only be added while there are no clients/);
  // The static demo build (local/kernel.js passes alongside when window.SUDS_STATIC_HOST is set) holds
  // nothing real, so it may add sample data beside what someone typed in while trying SUDS out.
  assert.equal(demo.loadRefusal(st, { alongside: true }), null);
  const realIds = db.all(`SELECT id FROM clients WHERE deleted_at IS NULL`).map(r => r.id);
  const adminId = db.one(`SELECT id FROM users WHERE username='admin'`).id;
  const out = demo.seed({ actor: adminId, workers: [adminId], clinician: null, supervisor: adminId });
  assert.equal(out.loaded, true); assert.equal(out.counts.clients, 12);
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n, realIds.length + 12, 'the sample clients sit beside the real one');
  assert.match(demo.loadRefusal(demo.status(), { alongside: true }), /already loaded/, 'but only once');
  // Every sample row is tagged, so removing them leaves what the person entered themselves.
  demo.remove({ actor: adminId });
  assert.deepEqual(db.all(`SELECT id FROM clients WHERE deleted_at IS NULL`).map(r => r.id).sort(), [...realIds].sort());
  assert.equal(demo.offer({ alongside: true }).can_load, true);
});
