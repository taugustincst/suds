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
