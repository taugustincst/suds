'use strict';
// Supplies by item, site and lot (docs/SUPPLIES.md): the permissions, the receiving log, transfers,
// adjustments and disposals as an append-only ledger, first-expiry-first-out draw-down by visits, the
// shortfall a draw-down records instead of going below zero, the reports that must not change for visits
// recorded before items existed, the SSP summary, and what a device may push.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

let admin, sup, nav, nav2, clin, fin, ro, navId, clientId, van, office;
const iso = (ms) => new Date(ms).toISOString();
const push = (c, body) => c.post('/api/sync/push', { device_now: iso(Date.now()), ...body });
const onHand = (item, site) => H.db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=?`, item, site).n;
const lotQty = (item, site, lot) => H.db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=? AND lot_number=?`, item, site, lot).n;
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function item(body) { const r = await sup.post('/api/supplies/items', body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function receive(body) { const r = await sup.post('/api/supplies/receipts', body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; }

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  for (const [u, role] of [['spsup', 'supervisor'], ['spclin', 'clinician'], ['spfin', 'finance'], ['spro', 'readonly']]) H.makeUser(u, role);
  // Navigators held to their caseload (clients:all denied): another worker's visit is not theirs to add to.
  for (const u of ['spnav', 'spnav2']) H.makeCaseloadUser(u, 'navigator');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('spsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('spnav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('spnav2', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('spclin', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('spfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('spro', 'StaffPassw0rd!x');
  navId = H.db.one(`SELECT id FROM users WHERE username='spnav'`).id;
  clientId = (await nav.post('/api/clients', { first_name: 'Sy', last_name: 'Ringe' })).data.id;
  office = H.db.MAIN_SITE_ID;
});
after(async () => { await H.stop(); });

test('a new install has one supply site, the main office, with the same id everywhere', () => {
  const s = H.db.all(`SELECT * FROM supply_sites`);
  assert.deepEqual(s.map(x => [x.id, x.name, x.kind, x.is_active]), [['site-main', 'Main office', 'office', 1]]);
});

test('permissions: staff who hand supplies out see the stock and record deliveries; supervisors run the cupboard', async () => {
  for (const c of [ro, fin]) {
    assert.equal((await c.get('/api/supplies')).status, 403);
    assert.equal((await c.get('/api/supplies/ledger')).status, 403);
    assert.equal((await c.get('/api/supplies/alerts')).status, 403);
    assert.equal((await c.get('/api/supplies/catalog')).status, 403);
  }
  for (const c of [nav, clin, sup, admin]) assert.equal((await c.get('/api/supplies')).status, 200);
  const me = (await nav.get('/api/auth/me')).data.user.permissions;
  assert.ok(me.includes('supplies:read') && me.includes('supplies:receive') && !me.includes('supplies:manage'));
  // Items, sites, settings, transfers, adjustments, disposals and the older count routes are supplies:manage.
  const kit = await item({ name: 'Perm kit', category: 'other' });
  const denied = [
    ['post', '/api/supplies/items', { name: 'Nav item' }], ['put', `/api/supplies/items/${kit}`, { name: 'x' }], ['post', '/api/supplies/sites', { name: 'Nav van', kind: 'van' }],
    ['put', `/api/supplies/sites/${office}`, { name: 'x' }], ['put', '/api/supplies/settings', { expiry_warn_days: 30 }],
    ['post', '/api/supplies/transfers', { item_id: kit, from_site_id: office, to_site_id: office, quantity: 1 }], ['post', '/api/supplies/adjustments', { item_id: kit, site_id: office, quantity: -1, reason: 'lost' }],
    ['post', '/api/supplies/disposals', { item_id: kit, site_id: office, reason: 'expired' }], ['post', '/api/supplies', { item: 'Naloxone kit', quantity: 5 }], ['put', `/api/supplies/${kit}`, { adjust: 1 }], ['del', `/api/supplies/${kit}`],
  ];
  for (const [m, path, body] of denied) {
    for (const c of [nav, clin, fin, ro]) assert.equal((await c[m](path, body)).status, 403, `${m} ${path} is refused to ${c === nav ? 'a navigator' : c === clin ? 'a clinician' : c === fin ? 'finance' : 'read-only'}`);
  }
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='authz.denied' AND details LIKE '%supplies:manage%'`));
  // Receiving is field work: navigators and clinicians record their site's deliveries.
  assert.equal((await nav.post('/api/supplies/receipts', { item_id: kit, site_id: office, quantity: 5 })).status, 201);
  assert.equal((await clin.post('/api/supplies/receipts', { item_id: kit, site_id: office, quantity: 2 })).status, 201);
  assert.equal((await fin.post('/api/supplies/receipts', { item_id: kit, site_id: office, quantity: 2 })).status, 403);
  assert.equal(onHand(kit, office), 7);
  // Anyone who sees the stock chooses the site their own visits draw from.
  assert.equal((await nav.put('/api/supplies/my-site', { site_id: office })).status, 200);
  assert.equal((await ro.put('/api/supplies/my-site', { site_id: office })).status, 403);
});

test('items and sites: named once, a naloxone product only on naloxone, the last site cannot be taken out of use', async () => {
  assert.equal((await sup.post('/api/supplies/items', { name: 'perm KIT' })).status, 400, 'names are unique whatever their case');
  assert.equal((await sup.post('/api/supplies/items', { name: 'Syringe 1cc', category: 'syringes', product: 'nasal_4mg' })).status, 400);
  assert.equal((await sup.put(`/api/supplies/sites/${office}`, { is_active: false })).status, 400, 'the only site in use');
  const r = await sup.post('/api/supplies/sites', { name: 'Outreach van', kind: 'van' });
  assert.equal(r.status, 201); van = r.data.id;
  assert.equal((await sup.post('/api/supplies/sites', { name: 'outreach VAN', kind: 'van' })).status, 400);
  assert.equal((await sup.post('/api/supplies/sites', { name: 'Tent', kind: 'tent' })).status, 400, 'a site kind from the list');
  // An item can be created with its opening stock in one step (the Home set-up step does this).
  const withStock = await sup.post('/api/supplies/items', { name: 'Hygiene kit', opening: { quantity: 12, site_id: van, lot_number: 'H-1' } });
  assert.equal(withStock.status, 201);
  assert.equal(onHand(withStock.data.id, van), 12);
  assert.equal(H.db.one(`SELECT kind FROM supply_ledger WHERE item_id=?`, withStock.data.id).kind, 'opening');
  assert.equal(H.db.one(`SELECT category FROM supply_items WHERE id=?`, withStock.data.id).category, 'hygiene_kit', 'the category is read from the name when none is given');
  // Editing: a rename, a naloxone product only on naloxone, an item or site taken out of use (and back).
  const tmp = await item({ name: 'Temp item', category: 'other' });
  assert.equal((await sup.put(`/api/supplies/items/${tmp}`, { name: 'Wound care kit', category: 'wound_care', low_stock: 3, quick: true })).status, 200);
  assert.deepEqual(Object.values(H.db.one(`SELECT name, category, low_stock, quick FROM supply_items WHERE id=?`, tmp)), ['Wound care kit', 'wound_care', 3, 1]);
  assert.equal((await sup.put(`/api/supplies/items/${tmp}`, { product: 'nasal_4mg' })).status, 400);
  assert.equal((await sup.put(`/api/supplies/items/${tmp}`, { name: 'perm kit' })).status, 400, 'not onto another item\'s name');
  assert.equal((await sup.put('/api/supplies/items/nothing', { name: 'x' })).status, 404);
  assert.equal((await sup.put(`/api/supplies/items/${tmp}`, { is_active: false })).status, 200);
  assert.ok(!(await nav.get('/api/supplies/catalog')).data.items.some(i => i.id === tmp), 'an item out of use is not offered on the visit form');
  assert.equal((await sup.put(`/api/supplies/items/${tmp}`, { is_active: true })).status, 200);
  assert.equal((await sup.put(`/api/supplies/sites/${van}`, { name: 'Van 1', kind: 'van' })).status, 200);
  assert.equal(H.db.one(`SELECT name FROM supply_sites WHERE id=?`, van).name, 'Van 1');
  assert.equal((await sup.put(`/api/supplies/sites/${van}`, { name: 'main OFFICE' })).status, 400);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.item.update'`) && H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.site.update'`));
  // The visit form's catalogue: active items and sites, and where this worker draws from.
  const cat = await nav.get('/api/supplies/catalog');
  assert.equal(cat.status, 200);
  assert.ok(cat.data.items.some(i => i.id === tmp && i.quick) && cat.data.sites.length === 2 && cat.data.site_id === office && cat.data.syringes_per_litre === 100);
  const list = (await nav.get('/api/supplies')).data;
  assert.ok(list.sites.some(s => s.id === van) && list.meta.categories.some(c => c.code === 'syringes') && list.meta.products.some(p => p.code === 'nasal_8mg'));
  assert.equal(list.can.manage, false); assert.equal(list.can.receive, true);
});

test('the receiving log: date, item, quantity, lot, expiry, source, fund and reference; never negative', async () => {
  const nal = await item({ name: 'Naloxone 4 mg nasal', category: 'naloxone', product: 'nasal_4mg', quick: true });
  const fund = (await admin.post('/api/budget/funds', { name: 'SSP supplies fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 })).data.id;
  const r = await nav.post('/api/supplies/receipts', { item_id: nal, site_id: office, quantity: 24, lot_number: 'NX-A', expires_on: inDays(300), received_on: '2026-09-01', source: 'ndp', reference: 'NDP order 5521' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.on_hand, 24);
  const row = H.db.one(`SELECT * FROM supply_ledger WHERE id=?`, r.data.id);
  assert.deepEqual([row.kind, row.quantity, row.lot_number, row.expires_on, row.occurred_on, row.source, row.reference, row.user_id], ['received', 24, 'NX-A', inDays(300), '2026-09-01', 'ndp', 'NDP order 5521', navId]);
  assert.equal((await sup.post('/api/supplies/receipts', { item_id: nal, site_id: office, quantity: 10, source: 'purchase', funding_source_id: fund, lot_number: 'NX-B', expires_on: inDays(30) })).status, 201, 'a purchase names the fund that paid');
  assert.equal((await sup.post('/api/supplies/receipts', { item_id: nal, site_id: office, quantity: 10, source: 'donation', funding_source_id: fund })).status, 400, 'a fund is for a purchase only');
  assert.equal((await nav.post('/api/supplies/receipts', { item_id: nal, site_id: office, quantity: -5 })).status, 400, 'quantities received are never negative');
  assert.equal((await nav.post('/api/supplies/receipts', { item_id: nal, site_id: office, quantity: 0 })).status, 400);
  assert.equal((await nav.post('/api/supplies/receipts', { item_id: nal, site_id: 'nowhere', quantity: 5 })).status, 400, 'the site must exist');
  assert.equal((await nav.post('/api/supplies/receipts', { item_id: 'nothing', site_id: office, quantity: 5 })).status, 404, 'the item must exist');
  assert.equal((await nav.post('/api/supplies/receipts', { item_id: nal, site_id: office, quantity: 5, source: 'found_it' })).status, 400);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.receive'`));
  const ledger = (await nav.get(`/api/supplies/ledger?item_id=${nal}`)).data;
  assert.equal(ledger.total, 2);
  assert.ok(ledger.rows.every(x => x.item_name === 'Naloxone 4 mg nasal' && x.site_name === 'Main office' && x.user_name));
  assert.equal(ledger.rows.find(x => x.source === 'purchase').fund_name, 'SSP supplies fund');
});

test('a visit draws its items down first-expiry-first-out, and its naloxone and strips are its counts', async () => {
  const fts = await item({ name: 'Fentanyl test strips', category: 'fentanyl_test_strips', quick: true });
  const syr = await item({ name: 'Syringe 1 mL 29G', category: 'syringes', unit: 'syringe', quick: true });
  const nal = H.db.one(`SELECT id FROM supply_items WHERE name='Naloxone 4 mg nasal'`).id;
  await receive({ item_id: fts, site_id: office, quantity: 100, lot_number: 'F-LATE', expires_on: inDays(400) });
  await receive({ item_id: fts, site_id: office, quantity: 20, lot_number: 'F-SOON', expires_on: inDays(20) });
  await receive({ item_id: fts, site_id: office, quantity: 50, lot_number: 'F-EXPIRED', expires_on: inDays(-5) });
  await receive({ item_id: syr, site_id: office, quantity: 200 });
  const v = await nav.post('/api/interventions', { client_id: clientId, type: 'harm_reduction', occurred_at: new Date().toISOString(),
    supplies: [{ item_id: nal, quantity: 2 }, { item_id: fts, quantity: 25 }, { item_id: syr, quantity: 30 }, { item_id: fts, quantity: 5 }] });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  const row = H.db.one(`SELECT * FROM interventions WHERE id=?`, v.data.id);
  assert.equal(row.naloxone_kits, 2, 'the naloxone count is the sum of the visit\'s naloxone items');
  assert.equal(row.fentanyl_strips, 30, 'and the strip count the sum of its fentanyl test strips (listed twice, merged)');
  assert.equal(row.supply_site_id, office, 'the site is fixed on the visit: the worker\'s');
  // First expiry first: the lot expiring in 20 days, then the one in 400; the expired lot is not handed out.
  assert.equal(lotQty(fts, office, 'F-SOON'), 0); assert.equal(lotQty(fts, office, 'F-LATE'), 90); assert.equal(lotQty(fts, office, 'F-EXPIRED'), 50);
  assert.equal(lotQty(nal, office, 'NX-B'), 8, 'naloxone: the lot expiring in 30 days before the one in 300');
  assert.equal(onHand(syr, office), 170);
  const got = (await nav.get(`/api/interventions/${v.data.id}`)).data.row;
  assert.deepEqual(got.supplies.map(x => [x.item, x.quantity]).sort(), [['Fentanyl test strips', 30], ['Naloxone 4 mg nasal', 2], ['Syringe 1 mL 29G', 30]]);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.drawdown' AND details LIKE ?`, `%${v.data.id}%`));

  // Saving it again draws nothing more; an edit draws (or puts back) the difference.
  await nav.put(`/api/interventions/${v.data.id}`, { summary: 'same supplies' });
  assert.equal(onHand(syr, office), 170);
  await nav.put(`/api/interventions/${v.data.id}`, { supplies: [{ item_id: nal, quantity: 3 }, { item_id: syr, quantity: 10 }] });
  assert.equal(onHand(syr, office), 190, 'twenty syringes back');
  assert.equal(lotQty(fts, office, 'F-SOON') + lotQty(fts, office, 'F-LATE'), 120, 'the strips no longer listed went back');
  assert.equal(H.db.one(`SELECT fentanyl_strips FROM interventions WHERE id=?`, v.data.id).fentanyl_strips, 0);
  assert.equal(H.db.one(`SELECT naloxone_kits FROM interventions WHERE id=?`, v.data.id).naloxone_kits, 3);
  // Moving the visit to another site puts the stock back here and takes it there.
  await receive({ item_id: syr, site_id: van, quantity: 40 });
  await sup.put(`/api/interventions/${v.data.id}`, { supply_site_id: van });
  assert.equal(onHand(syr, office), 200); assert.equal(onHand(syr, van), 30);
  // Deleting the visit puts everything back.
  assert.equal((await nav.del(`/api/interventions/${v.data.id}`)).status, 200);
  assert.equal(onHand(syr, van), 40); assert.equal(onHand(nal, office), 34);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM intervention_supplies WHERE intervention_id=?`, v.data.id).n, 0);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.restore' AND details LIKE ?`, `%${v.data.id}%`));
  // The ledger was only ever added to.
  assert.ok(H.db.one(`SELECT COUNT(*) n FROM supply_ledger WHERE intervention_id=? AND kind='restored'`, v.data.id).n >= 3);
});

test('an anonymous outreach contact records any item too', async () => {
  const cookers = await item({ name: 'Cookers', category: 'cookers' });
  await receive({ item_id: cookers, site_id: office, quantity: 10 });
  const r = await nav.post('/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), supplies: [{ item_id: cookers, quantity: 4 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(onHand(cookers, office), 6);
  assert.equal(H.db.one(`SELECT client_id FROM intervention_supplies WHERE intervention_id=?`, r.data.id).client_id, null);
  assert.equal((await nav.post('/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), supplies: [{ item_id: cookers, quantity: -1 }] })).status, 400);
  assert.equal((await nav.post('/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), supplies: [{ item_id: 'no-such-item', quantity: 1 }] })).status, 400);
  assert.equal((await nav.post('/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), supply_site_id: 'nowhere', supplies: [{ item_id: cookers, quantity: 1 }] })).status, 400);
});

test('a draw-down never goes below zero: what the books lacked is recorded as a flagged shortfall', async () => {
  const pads = await item({ name: 'Alcohol pads', category: 'alcohol_pads' });
  await receive({ item_id: pads, site_id: office, quantity: 5, lot_number: 'P1' });
  const r = await nav.post('/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), supplies: [{ item_id: pads, quantity: 8 }] });
  assert.equal(r.status, 201, 'the visit is recorded: the worker handed them out');
  assert.equal(onHand(pads, office), 0, 'zero, not minus three');
  const short = H.db.one(`SELECT * FROM supply_ledger WHERE item_id=? AND kind='adjustment'`, pads);
  assert.deepEqual([short.quantity, short.reason, short.flagged, short.intervention_id], [3, 'shortfall', 1, r.data.id]);
  const al = (await sup.get('/api/supplies/alerts')).data;
  assert.ok(al.shortfalls.some(x => x.id === short.id), 'shown to whoever runs the cupboard');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.drawdown' AND details LIKE '%"shortfall":3%'`));
});

test('transfers between sites, adjustments with a reason and disposal of expired stock', async () => {
  const fts = H.db.one(`SELECT id FROM supply_items WHERE name='Fentanyl test strips'`).id;
  const before = { office: onHand(fts, office), van: onHand(fts, van) };
  // FEFO across lots when no lot is named; a transfer_out/transfer_in pair per lot.
  const t = await sup.post('/api/supplies/transfers', { item_id: fts, from_site_id: office, to_site_id: van, quantity: 30 });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.equal(onHand(fts, office), before.office - 30); assert.equal(onHand(fts, van), before.van + 30);
  const pair = H.db.all(`SELECT kind, quantity, lot_number FROM supply_ledger WHERE transfer_id=? ORDER BY kind`, t.data.transfer_id);
  assert.ok(pair.length >= 2 && pair.every(x => (x.kind === 'transfer_in') === (x.quantity > 0)));
  assert.equal((await sup.post('/api/supplies/transfers', { item_id: fts, from_site_id: office, to_site_id: van, quantity: 100000 })).status, 400, 'never more than the site holds');
  assert.equal((await sup.post('/api/supplies/transfers', { item_id: fts, from_site_id: office, to_site_id: office, quantity: 1 })).status, 400);
  // Adjustments: a count correction by what was counted, damaged stock taken off, never below zero.
  const c = await sup.post('/api/supplies/adjustments', { item_id: fts, site_id: van, lot_number: 'F-LATE', expires_on: inDays(400), counted: 5, reason: 'count_correction' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(lotQty(fts, van, 'F-LATE'), 5);
  assert.equal((await sup.post('/api/supplies/adjustments', { item_id: fts, site_id: van, lot_number: 'F-LATE', expires_on: inDays(400), quantity: -6, reason: 'damaged' })).status, 400, 'not below zero');
  assert.equal((await sup.post('/api/supplies/adjustments', { item_id: fts, site_id: van, lot_number: 'F-LATE', expires_on: inDays(400), quantity: 2, reason: 'lost' })).status, 400, 'lost stock is taken off');
  assert.equal((await sup.post('/api/supplies/adjustments', { item_id: fts, site_id: van, quantity: -1, reason: 'mislaid' })).status, 400, 'a reason from the list');
  assert.equal((await sup.post('/api/supplies/adjustments', { item_id: fts, site_id: van, lot_number: 'F-LATE', expires_on: inDays(400), quantity: -2, reason: 'damaged' })).status, 201);
  // Expired: an alert, then disposed of (the whole lot by default).
  const al = (await sup.get('/api/supplies/alerts')).data;
  assert.ok(al.expired.some(l => l.item_id === fts && l.lot_number === 'F-EXPIRED' && l.quantity === 50));
  assert.ok(al.expiring.some(l => l.lot_number === 'NX-B'), 'naloxone expiring within the warning window');
  assert.ok(al.counts.expired >= 1 && al.counts.expiring >= 1);
  const d = await sup.post('/api/supplies/disposals', { item_id: fts, site_id: office, lot_number: 'F-EXPIRED', expires_on: inDays(-5), reason: 'expired' });
  assert.equal(d.status, 201, JSON.stringify(d.data)); assert.equal(d.data.quantity, 50);
  assert.equal(lotQty(fts, office, 'F-EXPIRED'), 0);
  assert.ok(!(await sup.get('/api/supplies/alerts')).data.expired.some(l => l.lot_number === 'F-EXPIRED'));
  assert.equal((await sup.post('/api/supplies/disposals', { item_id: fts, site_id: office, lot_number: 'F-EXPIRED', expires_on: inDays(-5), reason: 'expired' })).status, 400, 'nothing left to dispose of');
  for (const a of ['supply.transfer', 'supply.adjust', 'supply.dispose']) assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action=?`, a), a);
  // The Supplies page's view: per site, per lot, with the expiry state.
  const page = (await nav.get('/api/supplies')).data;
  assert.ok(page.stock.some(x => x.item_id === fts && x.site_id === van));
  assert.ok(page.lots.some(l => l.item_id === fts && l.state));
});

test('settings: the default site, the expiry warning and the returns estimate', async () => {
  assert.equal((await sup.put('/api/supplies/settings', { default_site_id: 'nowhere' })).status, 400);
  const r = await sup.put('/api/supplies/settings', { expiry_warn_days: 10, syringes_per_litre: 80 });
  assert.equal(r.status, 200); assert.equal(r.data.expiry_warn_days, 10); assert.equal(r.data.syringes_per_litre, 80);
  assert.ok(!(await sup.get('/api/supplies/alerts')).data.expiring.some(l => l.lot_number === 'NX-B'), 'thirty days out is no longer "soon"');
  // Returns estimated from the container's volume.
  const v = await nav.post('/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), returns_estimated: true, sharps_returned_litres: 1.5 });
  assert.equal(v.status, 201);
  assert.deepEqual(Object.values(H.db.one(`SELECT syringes_returned, returns_estimated FROM interventions WHERE id=?`, v.data.id)), [120, 1]);
  await sup.put('/api/supplies/settings', { expiry_warn_days: 60, syringes_per_litre: 100 });
});

test('the counts alone still work, drawn from the category\'s usual item (an older form, the API, an import)', async () => {
  const nal = H.db.one(`SELECT id FROM supply_items WHERE name='Naloxone 4 mg nasal'`).id;
  const before = onHand(nal, office);
  const v = await nav.post('/api/interventions', { client_id: clientId, type: 'naloxone_distribution', occurred_at: new Date().toISOString(), naloxone_kits: 2 });
  assert.equal(v.status, 201);
  assert.equal(onHand(nal, office), before - 2);
  assert.deepEqual(H.db.all(`SELECT item_id, quantity, untracked FROM intervention_supplies WHERE intervention_id=?`, v.data.id).map(Object.values), [[nal, 2, 0]]);
  await nav.put(`/api/interventions/${v.data.id}`, { naloxone_kits: 5 });
  assert.equal(onHand(nal, office), before - 5, 'an edit draws the difference');
  await nav.put(`/api/interventions/${v.data.id}`, { naloxone_kits: 1 });
  assert.equal(onHand(nal, office), before - 1, 'and puts it back when lowered');
});

test('visits recorded before items existed: their figures do not change, and editing one draws only what is new', async () => {
  // Visits as 1.13 left them: counts on the visit, no items, their kits already off the old cupboard count.
  const legacy = [];
  for (const [kits, strips, client, at] of [[3, 10, clientId, '2026-04-03T18:00:00.000Z'], [5, 0, null, '2026-04-10T18:00:00.000Z'], [1, 20, clientId, '2026-04-20T18:00:00.000Z']]) {
    const id = randomUUID(); legacy.push(id);
    H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,naloxone_kits,fentanyl_strips,location) VALUES(?,?,?,?,?,?,?,?)`, id, client, navId, client ? 'harm_reduction' : 'naloxone_distribution', at, kits, strips, 'field');
  }
  const reports = async () => ({
    funder: (await sup.get('/api/reports/funder?from=2026-04-01&to=2026-04-30&purpose=submission&counts=exact')).data,
    ndp: (await sup.get('/api/reports/naloxone-ndp?from=2026-04-01&to=2026-04-30&purpose=submission&counts=exact')).data,
    settlement: (await sup.get('/api/reports/opioid-settlement?from=2026-04-01&to=2026-04-30&purpose=submission&counts=exact')).data,
    published: (await sup.get('/api/reports/funder?from=2026-04-01&to=2026-04-30&purpose=publication')).data,
  });
  const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (['generated_at', 'id'].includes(k) ? undefined : v)));
  const before = strip(await reports());
  assert.equal(before.funder.naloxone_distribution.kits, 9); assert.equal(before.funder.naloxone_distribution.strips, 30);
  assert.equal(before.ndp.totals.kits, 9);
  assert.ok(before.ndp.rows.filter(r => r.entry === 'distribution').every(r => r.product === null), 'the NDP day log says the product was not recorded');
  const nal = H.db.one(`SELECT id FROM supply_items WHERE name='Naloxone 4 mg nasal'`).id;
  const fts = H.db.one(`SELECT id FROM supply_items WHERE name='Fentanyl test strips'`).id;
  const stock = [onHand(nal, office), onHand(fts, office)];
  // Edited with the new form, which shows the counts as the usual items; and edited through the API alone.
  assert.equal((await sup.put(`/api/interventions/${legacy[0]}`, { summary: 'edited', supplies: [{ item_id: nal, quantity: 3 }, { item_id: fts, quantity: 10 }] })).status, 200);
  assert.equal((await sup.put(`/api/interventions/${legacy[1]}`, { summary: 'edited' })).status, 200);
  assert.equal((await sup.put(`/api/interventions/${legacy[2]}`, { follow_up_due: null, supplies: [{ item_id: nal, quantity: 1 }, { item_id: fts, quantity: 20 }] })).status, 200);
  assert.deepEqual([onHand(nal, office), onHand(fts, office)], stock, 'kits taken off the old count are not drawn again');
  const lines = H.db.all(`SELECT quantity, untracked FROM intervention_supplies WHERE intervention_id=?`, legacy[0]);
  assert.ok(lines.length === 2 && lines.every(l => l.untracked === l.quantity));
  const after = strip(await reports());
  assert.deepEqual(after.funder.naloxone_distribution, before.funder.naloxone_distribution);
  assert.deepEqual(after.funder.unduplicated, before.funder.unduplicated);
  assert.deepEqual(after.funder.by_funding_source, before.funder.by_funding_source);
  assert.deepEqual(after.funder.overdose, before.funder.overdose);
  assert.deepEqual(after.ndp.totals, before.ndp.totals);
  assert.deepEqual(after.ndp.rows, before.ndp.rows, 'the NDP day log, row for row (the product stays "not recorded": the counts were recorded before products)');
  assert.deepEqual(after.settlement.services_by_use, before.settlement.services_by_use);
  assert.deepEqual(after.published.naloxone_distribution, before.published.naloxone_distribution);
  assert.equal(after.published.unduplicated.served, before.published.unduplicated.served);
  // A visit edited to more kits than it had draws only the new ones.
  await sup.put(`/api/interventions/${legacy[1]}`, { naloxone_kits: 7 });
  assert.equal(onHand(nal, office), stock[0] - 2);
});

test('the NDP day log carries the naloxone product where the visit recorded it', async () => {
  const nal8 = await item({ name: 'Naloxone 8 mg nasal', category: 'naloxone', product: 'nasal_8mg' });
  await receive({ item_id: nal8, site_id: office, quantity: 10 });
  const nal4 = H.db.one(`SELECT id FROM supply_items WHERE name='Naloxone 4 mg nasal'`).id;
  await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: '2026-06-05T18:00:00.000Z', location: 'community', supplies: [{ item_id: nal8, quantity: 2 }, { item_id: nal4, quantity: 1 }] });
  const d = (await sup.get('/api/reports/naloxone-ndp?from=2026-06-01&to=2026-06-30&purpose=submission&counts=exact')).data;
  const rows = d.rows.filter(r => r.entry === 'distribution' && r.date === '2026-06-05');
  assert.deepEqual(rows.map(r => [r.product, r.kits]).sort(), [['nasal_4mg', 1], ['nasal_8mg', 2]]);
  assert.equal(d.totals.kits, 3);
  const csv = await sup.req('GET', '/api/reports/naloxone-ndp/export?from=2026-06-01&to=2026-06-30&purpose=submission&counts=exact');
  assert.match(csv.data, /Naloxone product/); assert.match(csv.data, /Nasal spray 8 mg/);
});

test('the SSP summary: contacts, participants, syringes out and back, the ratio, naloxone by product, referrals', async () => {
  const syr = H.db.one(`SELECT id FROM supply_items WHERE name='Syringe 1 mL 29G'`).id;
  const sharps = await item({ name: 'Sharps container 1 qt', category: 'sharps_container' });
  await receive({ item_id: sharps, site_id: office, quantity: 20 });
  const nal8 = H.db.one(`SELECT id FROM supply_items WHERE name='Naloxone 8 mg nasal'`).id;
  const at = (d) => `2026-07-${d}T18:00:00.000Z`;
  await nav.post('/api/interventions', { client_id: clientId, type: 'harm_reduction', occurred_at: at('02'), supplies: [{ item_id: syr, quantity: 40 }, { item_id: sharps, quantity: 1 }], syringes_returned: 30 });
  await nav.post('/api/interventions', { client_id: clientId, type: 'harm_reduction', occurred_at: at('09'), supplies: [{ item_id: syr, quantity: 20 }, { item_id: nal8, quantity: 1 }], returns_estimated: true, sharps_returned_litres: 0.5 });
  await nav.post('/api/interventions', { type: 'outreach', occurred_at: at('15'), supplies: [{ item_id: syr, quantity: 40 }], naloxone_kits: 0 });
  await nav.post('/api/interventions', { type: 'outreach', occurred_at: at('16'), summary: 'talked, nothing handed out' });
  const res = await nav.get('/api/referrals?limit=1');
  assert.ok([200, 403].includes(res.status));
  const r = await sup.get('/api/reports/ssp?from=2026-07-01&to=2026-07-31&counts=exact');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = r.data.totals;
  assert.equal(t.contacts, 3, 'contacts at which supplies went out or sharps came back');
  assert.equal(t.anonymous_contacts, 1);
  assert.equal(t.participants, 1);
  assert.equal(t.syringes_distributed, 100); assert.equal(t.syringes_returned, 80); assert.equal(t.syringes_returned_estimated, 50);
  assert.equal(t.return_ratio, 0.8); assert.equal(t.sharps_containers, 1); assert.equal(t.naloxone_kits, 1);
  assert.deepEqual(r.data.naloxone_by_product.map(x => [x.product, x.kits]), [['nasal_8mg', 1]]);
  assert.equal(r.data.by_month.length, 1); assert.equal(r.data.by_site[0].site, 'Main office');
  assert.ok(r.data.by_item.some(x => x.item === 'Sharps container 1 qt' && x.quantity === 1));
  assert.equal(r.data.suppression.purpose, 'submission');
  // Suppressed (the default for a navigator): one participant is a small cell; supplies stay exact.
  const s = (await nav.get('/api/reports/ssp?from=2026-07-01&to=2026-07-31')).data;
  assert.equal(s.totals.participants, '<11'); assert.equal(s.totals.syringes_distributed, 100);
  assert.equal(s.suppression.purpose, 'internal');
  // Who may run it: not finance or read-only (it counts participants and is never a publication release).
  assert.equal((await fin.get('/api/reports/ssp?from=2026-07-01&to=2026-07-31')).status, 403);
  assert.equal((await ro.get('/api/reports/ssp?from=2026-07-01&to=2026-07-31')).status, 403);
  assert.equal((await nav.get('/api/reports/ssp?from=2026-07-01&to=2026-07-31&counts=exact')).status, 403, 'exact counts are for supervisors and administrators');
  assert.equal((await sup.get('/api/reports/ssp?from=2026-07-01&to=2026-07-31&purpose=publication')).status, 400);
  // Exported as CSV and Excel, with its counting mode in the file.
  const csv = await sup.req('GET', '/api/reports/ssp/export?from=2026-07-01&to=2026-07-31&counts=exact');
  assert.equal(csv.status, 200); assert.match(csv.data, /Syringes distributed,100/); assert.match(csv.headers.get('content-disposition'), /exact-counts\.csv/);
  const xlsx = await sup.raw('/api/reports/ssp/export?from=2026-07-01&to=2026-07-31&format=xlsx');
  assert.equal(xlsx.status, 200); assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  assert.equal((await ro.get('/api/reports/ssp/export?from=2026-07-01&to=2026-07-31')).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.ssp'`) && H.db.one(`SELECT 1 FROM audit_log WHERE action='report.ssp.export'`));
});

test('the older single-number routes keep working on the ledger, for supervisors', async () => {
  const add = await sup.post('/api/supplies', { item: 'Condoms', quantity: 100 });
  assert.equal(add.status, 201);
  const cid = add.data.id;
  assert.equal(H.db.one(`SELECT category FROM supply_items WHERE id=?`, cid).category, 'condoms');
  assert.equal((await sup.post('/api/supplies', { item: 'condoms', quantity: 90 })).status, 200, 'the same item (any case) is set, not duplicated');
  assert.equal(onHand(cid, office), 90);
  assert.equal((await sup.put(`/api/supplies/${cid}`, { adjust: 15 })).data.quantity, 105);
  assert.equal((await sup.put(`/api/supplies/${cid}`, { quantity: 50 })).data.quantity, 50);
  assert.ok(H.db.all(`SELECT kind FROM supply_ledger WHERE item_id=?`, cid).every(x => ['opening', 'adjustment'].includes(x.kind)));
  const rows = (await nav.get('/api/supplies')).data.rows;
  assert.equal(rows.find(x => x.id === cid).quantity, 50);
  assert.equal((await sup.del(`/api/supplies/${cid}`)).status, 200);
  assert.equal(H.db.one(`SELECT is_active FROM supply_items WHERE id=?`, cid).is_active, 0, 'taken out of use, its history kept');
  assert.ok(!(await nav.get('/api/supplies')).data.rows.some(x => x.id === cid));
});

// ---- sync ----
test('sync: sites, items, a visit\'s items and the ledger reach a device', async () => {
  const pulled = (await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).data;
  for (const t of ['supply_sites', 'supply_items', 'supply_ledger', 'intervention_supplies']) assert.ok((pulled.tables[t] || []).length, `${t} pulled`);
  assert.ok(pulled.tables.intervention_supplies.every(l => l.client_id === null || l.client_id === clientId), 'a visit\'s items are scoped like the visit');
  const finPull = await fin.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
  assert.ok(finPull.status !== 200 || !(finPull.data.tables.supply_ledger || []).length, 'the ledger only to roles that see the stock');
});

test('sync: a device\'s stock movements are checked and accepted; items, sites and draw-downs are the office\'s', async () => {
  const kit = H.db.one(`SELECT id FROM supply_items WHERE name='Hygiene kit'`).id;
  const now = iso(Date.now());
  const row = (x) => ({ id: randomUUID(), item_id: kit, site_id: van, lot_number: 'H-1', expires_on: null, occurred_on: now.slice(0, 10), user_id: navId, created_at: now, updated_at: now, ...x });
  const received = row({ kind: 'received', quantity: 6, source: 'donation' });
  const r = await push(nav, { tables: { supply_ledger: [received] } });
  assert.deepEqual(r.data.rejected, []);
  assert.equal(onHand(kit, van), 18);
  const bad = [
    [row({ kind: 'received', quantity: -3 }), /cannot be negative/], [row({ kind: 'received', quantity: 0 }), /whole number/],
    [row({ kind: 'received', quantity: 2, item_id: 'nope' }), /does not have \(the supply item\)/], [row({ kind: 'received', quantity: 2, site_id: 'nope' }), /does not have \(the supply site\)/],
    [row({ kind: 'transfer_out', quantity: -1 }), /your role cannot/], [row({ kind: 'adjustment', quantity: -1, reason: 'lost' }), /your role cannot/],
    [row({ kind: 'distributed', quantity: -1, intervention_id: randomUUID() }), /drawn down at the office/], [row({ kind: 'adjustment', quantity: 5, reason: 'shortfall', flagged: 1 }), /drawn down at the office/],
    [row({ kind: 'teleported', quantity: 1 }), /does not accept/],
  ];
  const r2 = await push(nav, { tables: { supply_ledger: bad.map(([x]) => x) } });
  for (const [x, why] of bad) {
    const rej = r2.data.rejected.find(y => y.id === x.id);
    assert.ok(rej && why.test(rej.reason) && rej.permanent, `${x.kind} ${x.quantity}: ${rej && rej.reason}`);
  }
  assert.equal(onHand(kit, van), 18);
  // Append-only: the same row again is fine; a changed one is refused; a delete is ignored.
  assert.deepEqual((await push(nav, { tables: { supply_ledger: [received] } })).data.rejected, []);
  const changed = await push(nav, { tables: { supply_ledger: [{ ...received, quantity: 600, updated_at: iso(Date.now() + 5000) }] }, tombstones: [{ table_name: 'supply_ledger', id: received.id, deleted_at: iso(Date.now() + 5000) }] });
  assert.ok(changed.data.rejected.some(x => x.id === received.id && x.reason === 'immutable'));
  assert.equal(H.db.one(`SELECT quantity FROM supply_ledger WHERE id=?`, received.id).quantity, 6);
  // Items and sites are pull-only.
  const it = await push(sup, { tables: { supply_items: [{ id: randomUUID(), name: 'Device item', category: 'other', unit: 'each', created_at: now, updated_at: now }], supply_sites: [{ id: randomUUID(), name: 'Device site', kind: 'van', created_at: now, updated_at: now }] } });
  assert.equal(it.data.rejected.filter(x => x.reason === 'server-owned' && x.permanent).length, 2);
  // A supervisor's device moves stock; one taken below zero at the office is a flagged shortfall, not refused.
  const out = row({ kind: 'transfer_out', quantity: -25, transfer_id: 't1' });
  const inn = row({ kind: 'transfer_in', quantity: 25, site_id: office, transfer_id: 't1' });
  const r3 = await push(sup, { tables: { supply_ledger: [out, inn] } });
  assert.deepEqual(r3.data.rejected, []);
  assert.equal(lotQty(kit, van, 'H-1'), 0, 'zero at the van, not minus seven');
  assert.ok(H.db.one(`SELECT 1 FROM supply_ledger WHERE item_id=? AND site_id=? AND reason='shortfall' AND flagged=1 AND quantity=7`, kit, van));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.shortfall' AND ip='device'`));
});

test('sync: the office draws a pushed visit down once, from its items, whatever the device drew', async () => {
  const syr = H.db.one(`SELECT id FROM supply_items WHERE name='Syringe 1 mL 29G'`).id;
  const nal = H.db.one(`SELECT id FROM supply_items WHERE name='Naloxone 4 mg nasal'`).id;
  const start = [onHand(syr, office), onHand(nal, office)];
  const visit = randomUUID(); const now = Date.now();
  const v = { id: visit, client_id: clientId, user_id: navId, type: 'harm_reduction', occurred_at: iso(now), naloxone_kits: 1, fentanyl_strips: 0, supply_site_id: office, created_at: iso(now), updated_at: iso(now) };
  const lines = [{ id: randomUUID(), intervention_id: visit, client_id: clientId, user_id: navId, item_id: syr, quantity: 10, untracked: 0, created_at: iso(now), updated_at: iso(now) },
    { id: randomUUID(), intervention_id: visit, client_id: clientId, user_id: navId, item_id: nal, quantity: 1, untracked: 0, created_at: iso(now), updated_at: iso(now) }];
  const r = await push(nav, { tables: { interventions: [v], intervention_supplies: lines } });
  assert.deepEqual(r.data.rejected, []);
  assert.deepEqual([onHand(syr, office), onHand(nal, office)], [start[0] - 10, start[1] - 1]);
  // Sent again: nothing more.
  await push(nav, { tables: { interventions: [{ ...v, updated_at: iso(now + 1000) }], intervention_supplies: lines.map(l => ({ ...l, updated_at: iso(now + 1000) })) } });
  assert.deepEqual([onHand(syr, office), onHand(nal, office)], [start[0] - 10, start[1] - 1]);
  // Edited on the phone: the difference.
  await push(nav, { tables: { intervention_supplies: [{ ...lines[0], quantity: 4, updated_at: iso(now + 2000) }] } });
  assert.equal(onHand(syr, office), start[0] - 4);
  // A counts-only visit from an older kernel: its lines are worked out at the office.
  const old = randomUUID();
  await push(nav, { tables: { interventions: [{ id: old, client_id: clientId, user_id: navId, type: 'naloxone_distribution', occurred_at: iso(now), naloxone_kits: 2, fentanyl_strips: 0, created_at: iso(now), updated_at: iso(now) }] } });
  assert.equal(onHand(nal, office), start[1] - 3);
  assert.equal(H.db.one(`SELECT quantity FROM intervention_supplies WHERE intervention_id=?`, old).quantity, 2);
  // Deleted on the phone: put back.
  await push(nav, { tombstones: [{ table_name: 'interventions', id: visit, deleted_at: iso(Date.now() + 60000) }] });
  assert.deepEqual([onHand(syr, office), onHand(nal, office)], [start[0], start[1] - 2]);
  // A line for someone else's visit, or for a visit the office does not have, is refused.
  const theirs = (await nav2.post('/api/interventions', { type: 'outreach', occurred_at: iso(now) })).data.id;
  const r2 = await push(nav, { tables: { intervention_supplies: [
    { id: randomUUID(), intervention_id: theirs, client_id: null, user_id: navId, item_id: syr, quantity: 1, created_at: iso(now), updated_at: iso(now) },
    { id: randomUUID(), intervention_id: randomUUID(), client_id: null, user_id: navId, item_id: syr, quantity: 1, created_at: iso(now), updated_at: iso(now) },
    { id: randomUUID(), intervention_id: old, client_id: clientId, user_id: navId, item_id: syr, quantity: 1, untracked: 1, created_at: iso(now), updated_at: iso(now) }] } });
  const reasons = r2.data.rejected.map(x => x.reason);
  assert.ok(reasons.includes('not permitted'), reasons.join('; '));
  assert.ok(reasons.some(x => /does not have \(the visit\)/.test(x)));
  assert.ok(reasons.some(x => /recorded before supplies were kept by item/.test(x)));
});

test('sync round trip: what the office drew for a visit replaces what the device drew for it', async () => {
  // The device's own draw-down rows (written by the same code, provisional there) are never pushed; the
  // office's arrive by pull and carry the visit's id, which local/sync.js uses to drop the device's own.
  const pulled = (await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).data;
  const drawn = pulled.tables.supply_ledger.filter(r => r.kind === 'distributed');
  assert.ok(drawn.length && drawn.every(r => r.intervention_id), 'each draw-down names its visit');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'local', 'sync.js'), 'utf8');
  assert.match(src, /settleSupplies\(payload, officeUserId, skipped\)/, 'the device settles supplies after every pull');
  assert.match(src, /PROVISIONAL/, 'and never pushes its own draw-downs');
});
