'use strict';
const LD = require('../server/local-date'); // the programme's calendar, as the server dates things
// Street outreach on a device that syncs with an office (local mode): the office's supply items and stock reach
// the device, a contact logged there with no connection draws the device's copy down, and at the next sync the
// office receives the contact and its supplies, draws its own stock down once (the supply rules,
// server/rules/interventions.js), counts it in its reports and in the worker's shift summary.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let base; let office;
const USER = 'fieldnav'; const PASSWORD = 'Orchid-Lamp-77!x';
before(async () => {
  ({ L, cleanup } = await loadKernel({ staticHost: false }));
  base = await H.start();
  require('../server/config').localModeEnabled = true;
  H.makeUser(USER, 'navigator', PASSWORD);
  H.makeUser('fieldsup', 'supervisor');
  office = H.client(); await office.login('fieldsup', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); cleanup(); });
const device = (...a) => kernelCaller(L)(...a);
const ok = (r, s, what) => { assert.equal(r.status, s, `${what}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const onHand = (item) => H.db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=?`, item).n;

test('a contact logged offline on the device reaches the office at the next sync and draws its stock once', async () => {
  const kit = ok(await office.post('/api/supplies/items', { name: 'Naloxone kit', category: 'naloxone', quick: true }), 201, 'item').id;
  const strips = ok(await office.post('/api/supplies/items', { name: 'Fentanyl test strips', category: 'fentanyl_test_strips', quick: true }), 201, 'item').id;
  for (const id of [kit, strips]) ok(await office.post('/api/supplies/receipts', { item_id: id, site_id: H.db.MAIN_SITE_ID, quantity: 40, lot_number: 'OF-1', expires_on: '2030-01-01', source: 'purchase' }), 201, 'receive');
  ok(await device('POST', '/api/local/setup', { display_name: 'Field Nav', username: USER, password: PASSWORD, role: 'navigator' }), 200, 'device set-up');
  ok(await device('POST', '/api/auth/login', { username: USER, password: PASSWORD }), 200, 'device sign-in');
  const sync = async () => ok(await device('POST', '/api/local/sync', { server: base, username: USER, password: PASSWORD }), 200, 'sync');
  await sync();
  const cat = ok(await device('GET', '/api/supplies/catalog'), 200, 'catalog on the device');
  assert.deepEqual(cat.items.map(i => i.name).sort(), ['Fentanyl test strips', 'Naloxone kit'], 'the office\'s items arrived');
  // No connection from here until the next sync: the device answers on its own.
  const at = new Date(Date.now() - 20 * 60000).toISOString();
  const c = ok(await device('POST', '/api/interventions', { type: 'naloxone_distribution', occurred_at: at, location: 'street', modality: 'in_person', supply_site_id: cat.site_id,
    supplies: [{ item_id: kit, quantity: 3 }, { item_id: strips, quantity: 6 }], summary: 'By the library steps' }), 201, 'contact on the device');
  const shiftDevice = ok(await device('GET', `/api/outreach/shift?since=${encodeURIComponent(new Date(Date.parse(at) - 60000).toISOString())}`), 200, 'shift on the device');
  assert.equal(shiftDevice.contacts, 1); assert.equal(shiftDevice.naloxone_kits, 3);
  assert.equal(onHand(kit), 40, 'the office has not heard of it yet');
  const s2 = await sync();
  assert.equal((s2.rejected || []).length, 0, `rejected ${JSON.stringify(s2.rejected)}`);
  const v = H.db.one(`SELECT * FROM interventions WHERE id=?`, c.id);
  assert.ok(v, 'the office has the contact');
  assert.equal(v.client_id, null); assert.equal(v.naloxone_kits, 3); assert.equal(v.fentanyl_strips, 6);
  assert.equal(onHand(kit), 37, 'three kits drawn once at the office'); assert.equal(onHand(strips), 34);
  await sync();
  assert.equal(onHand(kit), 37, 'a second sync draws nothing more');
  const nav = H.client(); await nav.login(USER, PASSWORD);
  const shift = ok(await nav.get(`/api/outreach/shift?since=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}`), 200, 'shift at the office');
  assert.equal(shift.contacts, 1); assert.equal(shift.naloxone_kits, 3);
  const day = require('../server/routes/budget').localDate(); const from = LD.addDays(LD.today(), -2);
  const ndp = ok(await office.get(`/api/reports/naloxone-ndp?from=${from}&to=${day}&purpose=submission&counts=exact`), 200, 'ndp');
  assert.equal(ndp.totals.community_kits, 3, 'counted as community distribution');
});
