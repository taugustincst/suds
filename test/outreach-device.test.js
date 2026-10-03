'use strict';
// Street outreach on SUDS on this device (the published web app, no office): the browser kernel, bundled from the
// current sources (test/fixtures/kernel-harness.js), is the whole of SUDS there, with no connection at all. A
// contact logged on the outreach screen draws the device's own stock down, the shift summary counts it, and the
// device's own reports count it as anonymous distribution.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup;
before(async () => { ({ L, cleanup } = await loadKernel({ staticHost: true })); });
after(() => cleanup());
const call = (...a) => kernelCaller(L)(...a);
const ok = (r, s, what) => { assert.equal(r.status, s, `${what}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };

test('offline on the device: an outreach contact draws the device\'s stock down and is counted', async () => {
  ok(await call('POST', '/api/local/signup', { display_name: 'Field Worker', username: 'field', password: 'Orchid-Lamp-77!x', role: 'admin', storage_ack: true }), 200, 'sign up');
  ok(await call('POST', '/api/auth/login', { username: 'field', password: 'Orchid-Lamp-77!x' }), 200, 'sign in');
  const cat0 = ok(await call('GET', '/api/supplies/catalog'), 200, 'catalog');
  const site = cat0.site_id;
  const items = {};
  for (const [k, name, category] of [['kit', 'Naloxone kit', 'naloxone'], ['syr', 'Syringe 1 mL', 'syringes'], ['wound', 'Wound care kit', 'wound_care']]) {
    items[k] = ok(await call('POST', '/api/supplies/items', { name, category, quick: true }), 201, `item ${name}`).id;
    ok(await call('POST', '/api/supplies/receipts', { item_id: items[k], site_id: site, quantity: 30, lot_number: `D-${k}`, expires_on: '2030-01-01', source: 'donation' }), 201, 'receive');
  }
  const stock = async (id) => { const d = ok(await call('GET', '/api/supplies'), 200, 'stock'); return d.stock.filter(s => s.item_id === id).reduce((n, s) => n + s.quantity, 0); };
  const at = new Date(Date.now() - 10 * 60000).toISOString();
  ok(await call('POST', '/api/interventions', { type: 'naloxone_distribution', occurred_at: at, location: 'street', modality: 'in_person', supply_site_id: site, supplies: [{ item_id: items.kit, quantity: 2 }, { item_id: items.syr, quantity: 10 }], summary: 'Back next week' }), 201, 'contact');
  ok(await call('POST', '/api/interventions', { type: 'outreach', occurred_at: at, location: 'shelter', modality: 'in_person', supply_site_id: site, supplies: [{ item_id: items.wound, quantity: 1 }] }), 201, 'contact');
  assert.equal(await stock(items.kit), 28); assert.equal(await stock(items.syr), 20); assert.equal(await stock(items.wound), 29);
  const s = ok(await call('GET', `/api/outreach/shift?since=${encodeURIComponent(new Date(Date.parse(at) - 60000).toISOString())}`), 200, 'shift');
  assert.equal(s.contacts, 2); assert.equal(s.naloxone_kits, 2);
  assert.deepEqual(Object.fromEntries(s.supplies.map(x => [x.item, x.quantity])), { 'Naloxone kit': 2, 'Syringe 1 mL': 10, 'Wound care kit': 1 });
  const day = require('../server/routes/budget').localDate(); const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const ssp = ok(await call('GET', `/api/reports/ssp?from=${from}&to=${day}&counts=exact`), 200, 'ssp');
  assert.equal(ssp.totals.anonymous_contacts, 2); assert.equal(ssp.totals.syringes_distributed, 10);
  // Settlement outcomes run on the device too (the same server code): none of its funds is settlement money yet.
  const so = ok(await call('GET', `/api/reports/settlement-outcomes?from=${from}&to=${day}`), 200, 'settlement outcomes on the device');
  assert.equal(so.funds.length, 0); assert.match(so.empty_note, /Opioid settlement/);
  // The start page is a preference kept with the account, on the device too.
  ok(await call('PUT', '/api/me/prefs', { start_page: 'outreach' }), 200, 'start page');
  assert.equal(ok(await call('GET', '/api/me/prefs'), 200, 'prefs').prefs.start_page, 'outreach');
});
