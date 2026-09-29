'use strict';
// Street outreach (server/outreach.js, public/views/outreach.js): a field contact is an anonymous visit saved
// through POST /api/interventions, so its supplies draw the stock down by the supply rules and every report that
// counts anonymous distribution counts it; GET /api/outreach/shift is the worker's own "my shift" summary.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let sup, nav, nav2, fin, ro, office;
const I = {};
const onHand = (item) => H.db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=?`, item, office).n;
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

before(async () => {
  await H.start();
  for (const [u, role] of [['orsup', 'supervisor'], ['ornav', 'navigator'], ['ornav2', 'navigator'], ['orfin', 'finance'], ['orro', 'readonly']]) H.makeUser(u, role);
  sup = H.client(); await sup.login('orsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('ornav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('ornav2', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('orfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('orro', 'StaffPassw0rd!x');
  office = H.db.MAIN_SITE_ID;
  for (const [k, name, category, qty] of [['kit', 'Naloxone kit', 'naloxone', 20], ['strip', 'Fentanyl test strips', 'fentanyl_test_strips', 50], ['syr', 'Syringe 1 mL', 'syringes', 200], ['wound', 'Wound care kit', 'wound_care', 10]]) {
    I[k] = ok(await sup.post('/api/supplies/items', { name, category, quick: true })).id;
    ok(await sup.post('/api/supplies/receipts', { item_id: I[k], site_id: office, quantity: qty, lot_number: `L-${k}`, expires_on: '2030-01-01', source: 'purchase' }));
  }
});
after(async () => { await H.stop(); });

// What the outreach screen sends for a contact.
const contact = (c, { type = 'outreach', supplies = [], summary, code, at = minutesAgo(5) } = {}) => c.post('/api/interventions', {
  type, occurred_at: at, location: 'street', modality: 'in_person', supply_site_id: office, supplies, ...(summary ? { summary } : {}), ...(code ? { participant_code: code } : {}) });

test('an outreach contact is an anonymous visit: its supplies come off the stock, first expiry first', async () => {
  const before = { kit: onHand(I.kit), strip: onHand(I.strip), syr: onHand(I.syr), wound: onHand(I.wound) };
  const a = ok(await contact(nav, { type: 'naloxone_distribution', supplies: [{ item_id: I.kit, quantity: 2 }, { item_id: I.strip, quantity: 5 }], summary: 'Asked when the van is next at the park' }));
  ok(await contact(nav, { supplies: [{ item_id: I.syr, quantity: 20 }, { item_id: I.wound, quantity: 1 }, { item_id: I.kit, quantity: 1 }] }));
  ok(await contact(nav, {}), 201);
  assert.equal(onHand(I.kit), before.kit - 3); assert.equal(onHand(I.strip), before.strip - 5);
  assert.equal(onHand(I.syr), before.syr - 20); assert.equal(onHand(I.wound), before.wound - 1);
  const v = H.db.one(`SELECT * FROM interventions WHERE id=?`, a.id);
  assert.equal(v.client_id, null, 'no client');
  assert.equal(v.naloxone_kits, 2, 'the kits are the visit\'s naloxone count, as every report reads it');
  assert.equal(v.fentanyl_strips, 5);
  assert.ok(v.summary_enc && !v.summary_enc.includes('van'), 'the notes are encrypted like every visit summary');
  // A service that needs a client cannot be logged this way.
  assert.equal((await contact(nav, { type: 'case_management' })).status, 400);
});

test('my shift: the worker\'s own anonymous contacts since the shift began, in figures, never the notes', async () => {
  ok(await contact(nav2, { supplies: [{ item_id: I.kit, quantity: 4 }] }));
  const client = ok(await nav.post('/api/clients', { first_name: 'Shift', last_name: 'Client' })).id;
  ok(await nav.post('/api/interventions', { client_id: client, type: 'harm_reduction', occurred_at: minutesAgo(3), naloxone_kits: 1 }));
  ok(await contact(nav, { at: minutesAgo(60 * 30) }), 201);
  const s = ok(await nav.get(`/api/outreach/shift?since=${encodeURIComponent(minutesAgo(120))}`), 200);
  assert.equal(s.contacts, 3, 'three of this worker\'s own contacts in the last two hours: not a colleague\'s, not a client visit, not yesterday\'s');
  assert.equal(s.naloxone_kits, 3); assert.equal(s.fentanyl_strips, 5);
  assert.deepEqual(s.by_type.map(x => [x.type, x.n]).sort(), [['naloxone_distribution', 1], ['outreach', 2]]);
  const by = Object.fromEntries(s.supplies.map(x => [x.item, x.quantity]));
  assert.deepEqual(by, { 'Naloxone kit': 3, 'Fentanyl test strips': 5, 'Syringe 1 mL': 20, 'Wound care kit': 1 });
  assert.equal(s.recent.length, 3);
  assert.ok(s.recent.every(r => r.site === 'Main office' && r.location === 'street'));
  assert.ok(!JSON.stringify(s).includes('van is next'), 'never the notes');
  assert.equal(s.participants, 0, 'no contact carried a participant code');
  // Without since: the start of today in the programme's time zone.
  const today = ok(await nav.get('/api/outreach/shift'), 200);
  assert.equal(today.since, require('../server/outreach').startOfToday());
  // A since further back than a shift is cut to 36 hours; one in the future or not a date is refused.
  const long = ok(await nav.get(`/api/outreach/shift?since=${encodeURIComponent(minutesAgo(60 * 24 * 10))}`), 200);
  assert.ok(Date.now() - Date.parse(long.since) <= 36 * 3600 * 1000 + 60000);
  assert.equal(long.contacts, 4, 'including the one 30 hours ago');
  assert.equal((await nav.get(`/api/outreach/shift?since=${encodeURIComponent(new Date(Date.now() + 3600000).toISOString())}`)).status, 400);
  assert.equal((await nav.get('/api/outreach/shift?since=yesterday')).status, 400);
});

test('who may use it: those who record visits', async () => {
  for (const c of [fin, ro]) assert.equal((await c.get('/api/outreach/shift')).status, 403);
  assert.equal((await sup.get('/api/outreach/shift')).status, 200);
});

test('the reports count outreach contacts as anonymous visits and distribution', async () => {
  const from = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10); const to = require('../server/routes/budget').localDate();
  const ssp = ok(await sup.get(`/api/reports/ssp?from=${from}&to=${to}&counts=exact`), 200);
  assert.ok(ssp.totals.anonymous_contacts >= 3, 'the contacts that handed supplies out: ' + `anonymous contacts ${ssp.totals.anonymous_contacts}`);
  assert.ok(ssp.totals.syringes_distributed >= 20);
  const ndp = ok(await sup.get(`/api/reports/naloxone-ndp?from=${from}&to=${to}&purpose=submission&counts=exact`), 200);
  assert.ok(ndp.totals.community_kits >= 7, `community kits ${ndp.totals.community_kits}`);
  const visits = ok(await sup.get('/api/interventions?type=outreach&limit=50'), 200);
  assert.ok((visits.interventions || visits.rows || visits).length >= 3);
});

test('my shift counts the different SSP participant codes among the worker\'s contacts, never showing one', async () => {
  const worker = H.client(); H.makeUser('orcode', 'navigator'); await worker.login('orcode', 'StaffPassw0rd!x');
  ok(await contact(worker, { code: 'MA0785' }));
  ok(await contact(worker, { code: 'ma-07 85' }), 201); // the same code, typed differently
  ok(await contact(worker, { code: 'JO1190', type: 'naloxone_distribution' }));
  ok(await contact(worker, {}));
  const s = ok(await worker.get(`/api/outreach/shift?since=${encodeURIComponent(minutesAgo(60))}`), 200);
  assert.equal(s.contacts, 4);
  assert.equal(s.participants, 2, 'two different codes');
  const text = JSON.stringify(s);
  assert.ok(!/MA0785|JO1190/i.test(text), 'the summary never carries a code');
  const v = H.db.one(`SELECT participant_code_enc, participant_code_idx FROM interventions WHERE user_id=(SELECT id FROM users WHERE username='orcode') AND participant_code_idx IS NOT NULL LIMIT 1`);
  assert.ok(v.participant_code_enc && !v.participant_code_enc.includes('MA0785'), 'stored encrypted');
});
