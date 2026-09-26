'use strict';
// Settings → Lists: an administrator rewords, reorders, retires and adds to the choices on documentation
// forms. The stored code never changes; validation accepts the programme's own choices, refuses retired
// ones on new records but keeps them on old ones, and choices SUDS relies on cannot be retired.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;

let admin, sup, nav, fin, clientId;
const iso = (ms) => new Date(ms).toISOString();
const entry = (entries, code) => entries.find(e => e.code === code);
before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true; // for the sync checks at the end
  H.makeUser('ol_sup', 'supervisor'); H.makeUser('ol_nav', 'navigator'); H.makeUser('ol_fin', 'finance');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('ol_sup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('ol_nav', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('ol_fin', 'StaffPassw0rd!x');
  clientId = (await nav.post('/api/clients', { first_name: 'Lista', last_name: 'Options' })).data.id;
});
after(async () => { await H.stop(); });

test('only settings:manage (administrators) may see or change the lists', async () => {
  const r = await admin.get('/api/admin/lists');
  assert.equal(r.status, 200);
  const keys = r.data.lists.map(l => l.key);
  for (const k of ['INTERVENTION_TYPES', 'LOCATIONS', 'CALL_OUTCOMES', 'TEXT_OUTCOMES', 'REFERRAL_STATUSES', 'OVERDOSE_KINDS', 'ADMINISTERED_BY', 'TIME_CATEGORIES', 'NOTE_FORMATS', 'SUBSTANCES', 'DISCHARGE_REASONS', 'REFERRAL_BARRIERS']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('RACE_CODES') && !keys.includes('ASAM'), 'reporting code sets are not editable');
  assert.ok(r.data.excluded.length >= 3, 'and the page says which lists are not, and why');
  assert.equal(r.data.editable, true);
  assert.equal(entry(r.data.lists.find(l => l.key === 'OVERDOSE_KINDS').entries, 'reversal').label, 'Overdose reversed with naloxone', 'built-in wording comes from the server');
  for (const c of [sup, nav, fin]) {
    assert.equal((await c.get('/api/admin/lists')).status, 403);
    assert.equal((await c.put('/api/admin/lists/LOCATIONS/entries/field', { label: 'Street' })).status, 403);
    assert.equal((await c.post('/api/admin/lists/LOCATIONS/entries', { label: 'Van' })).status, 403);
    assert.equal((await c.put('/api/admin/lists/LOCATIONS/order', { codes: [] })).status, 403);
    assert.equal((await c.post('/api/admin/lists/LOCATIONS/reset', {})).status, 403);
  }
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='authz.denied' AND details LIKE '%settings:manage%'`), 'refusals are audited');
  assert.equal((await admin.put('/api/admin/lists/NOPE/entries/x', { label: 'x' })).status, 404);
  assert.equal((await admin.put('/api/admin/lists/LOCATIONS/entries/nope', { label: 'x' })).status, 404);
});

test('renaming a choice changes its wording everywhere but never the stored code', async () => {
  const r = await admin.put('/api/admin/lists/INTERVENTION_TYPES/entries/warm_handoff', { label: 'Warm hand-off to provider' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(entry(r.data.entries, 'warm_handoff').label, 'Warm hand-off to provider');
  const meta = (await nav.get('/api/meta/constants')).data;
  assert.equal(entry(meta.option_lists.INTERVENTION_TYPES, 'warm_handoff').label, 'Warm hand-off to provider', 'the forms get the new wording');
  assert.ok(meta.INTERVENTION_TYPES.includes('warm_handoff'), 'and the code is unchanged');
  const iv = await nav.post('/api/interventions', { client_id: clientId, type: 'warm_handoff', occurred_at: '2026-09-10T15:00:00Z' });
  assert.equal(iv.status, 201);
  assert.equal(db.one(`SELECT type FROM interventions WHERE id=?`, iv.data.id).type, 'warm_handoff');
  const csv = String((await admin.get('/api/reports/export/interventions?from=2026-09-01&to=2026-09-30')).data);
  assert.match(csv, /Warm hand-off to provider/, 'exports use the programme\'s wording');
  const a = db.one(`SELECT details FROM audit_log WHERE action='options.update' ORDER BY rowid DESC LIMIT 1`);
  assert.match(a.details, /warm_handoff/, 'the change is audited');
  // Two choices that read the same cannot be told apart.
  assert.equal((await admin.put('/api/admin/lists/INTERVENTION_TYPES/entries/referral', { label: 'warm hand-off to provider' })).status, 400);
  assert.equal((await admin.put('/api/admin/lists/INTERVENTION_TYPES/entries/referral', { label: '   ' })).status, 200, 'blank puts the built-in wording back');
  assert.equal(entry((await admin.get('/api/admin/lists')).data.lists.find(l => l.key === 'INTERVENTION_TYPES').entries, 'referral').label, 'Referral');
});

test('a hidden choice is refused on a new record, kept on an old one', async () => {
  const old = await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', location: 'shelter', occurred_at: '2026-09-11T15:00:00Z' });
  assert.equal(old.status, 201);
  const h = await admin.put('/api/admin/lists/LOCATIONS/entries/shelter', { hidden: true });
  assert.equal(h.status, 200);
  assert.equal(entry(h.data.entries, 'shelter').hidden, true);
  const meta = (await nav.get('/api/meta/constants')).data;
  assert.ok(!meta.LOCATIONS.includes('shelter'), 'no longer offered');
  assert.ok(entry(meta.option_lists.LOCATIONS, 'shelter'), 'but still worded, for the records that have it');
  const fresh = await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', location: 'shelter', occurred_at: '2026-09-11T16:00:00Z' });
  assert.equal(fresh.status, 400);
  assert.ok(fresh.data.fields.location);
  const row = db.one(`SELECT updated_at FROM interventions WHERE id=?`, old.data.id);
  const edit = await nav.put(`/api/interventions/${old.data.id}`, { location: 'shelter', duration_minutes: 45, if_updated_at: row.updated_at });
  assert.equal(edit.status, 200, 'editing the old record keeps its retired value');
  const other = await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', location: 'office', occurred_at: '2026-09-11T17:00:00Z' });
  assert.equal((await nav.put(`/api/interventions/${other.data.id}`, { location: 'shelter' })).status, 400, 'but it cannot be chosen for a record that did not have it');
  assert.equal((await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', location: 'moon_base', occurred_at: '2026-09-11T18:00:00Z' })).status, 400, 'an unknown code is refused');
  assert.equal((await admin.put('/api/admin/lists/LOCATIONS/entries/shelter', { hidden: false })).status, 200);
  assert.ok((await nav.get('/api/meta/constants')).data.LOCATIONS.includes('shelter'), 'and it can be brought back');
});

test('choices SUDS relies on can be reworded but not hidden', async () => {
  for (const [list, code] of [['CALL_OUTCOMES', 'reached'], ['TEXT_OUTCOMES', 'replied'], ['OVERDOSE_KINDS', 'fatal'], ['DISCHARGE_REASONS', 'deceased'], ['SUBSTANCES', 'unknown'], ['INTERVENTION_TYPES', 'naloxone_distribution'], ['REFERRAL_STATUSES', 'admitted'], ['TIME_CATEGORIES', 'direct_service']]) {
    const r = await admin.put(`/api/admin/lists/${list}/entries/${code}`, { hidden: true });
    assert.equal(r.status, 400, `${list}.${code}`);
    assert.match(r.data.error, /used by SUDS/);
  }
  const lists = (await admin.get('/api/admin/lists')).data.lists;
  assert.ok(entry(lists.find(l => l.key === 'CALL_OUTCOMES').entries, 'reached').protected, 'and the page says why');
  const r = await admin.put('/api/admin/lists/CALL_OUTCOMES/entries/reached', { label: 'Spoke with them' });
  assert.equal(r.status, 200);
  const call = await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-12T15:00:00Z', outcome: 'reached' });
  assert.equal(call.status, 201, 'the code is what the contact counts use, whatever it is called');
});

test('an administrator adds the programme\'s own choice; its code never collides with a built-in one', async () => {
  const r = await admin.post('/api/admin/lists/LOCATIONS/entries', { label: 'Mobile van' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.code, 'mobile_van');
  const e = entry(r.data.entries, 'mobile_van'); assert.ok(e.custom && !e.hidden);
  assert.equal(r.data.entries[r.data.entries.length - 1].code, 'mobile_van', 'added at the end');
  // Wording that makes the same code as a built-in choice gets a different code.
  const twin = await admin.post('/api/admin/lists/LOCATIONS/entries', { label: 'office-' });
  assert.equal(twin.status, 201);
  assert.notEqual(twin.data.code, 'office');
  assert.equal((await admin.post('/api/admin/lists/LOCATIONS/entries', { label: 'Mobile Van' })).status, 400, 'the same wording twice is refused');
  assert.equal((await admin.post('/api/admin/lists/LOCATIONS/entries', { label: '' })).status, 400);
  const iv = await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', location: 'mobile_van', occurred_at: '2026-09-13T15:00:00Z' });
  assert.equal(iv.status, 201, 'a new record may use it');
  // (Location is not in a de-identified export; an outcome is.)
  const oc = await admin.post('/api/admin/lists/OUTCOMES/entries', { label: 'Linked to peer group' });
  assert.equal(oc.status, 201);
  assert.equal((await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', outcome: oc.data.code, occurred_at: '2026-09-13T16:00:00Z' })).status, 201);
  const csv = String((await admin.get('/api/reports/export/interventions?from=2026-09-01&to=2026-09-30')).data);
  assert.match(csv, /Linked to peer group/, 'and the export shows its wording');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='options.add' AND details LIKE '%mobile_van%'`));
  // A discharge reason of the programme's own reaches the discharge form through its meta route.
  const dr = await admin.post('/api/admin/lists/DISCHARGE_REASONS/entries', { label: 'Aged out of program' });
  assert.equal(dr.status, 201);
  const m = (await nav.get('/api/meta/discharge-reasons')).data;
  assert.ok(m.discharge_reasons.includes(dr.data.code));
  assert.equal(entry(m.options, dr.data.code).label, 'Aged out of program');
  // Lists whose values drive logic (and overdose kinds, fixed by a CHECK constraint) take no additions.
  assert.equal((await admin.post('/api/admin/lists/REFERRAL_STATUSES/entries', { label: 'Lost in the mail' })).status, 400);
  assert.equal((await admin.post('/api/admin/lists/OVERDOSE_KINDS/entries', { label: 'Near miss' })).status, 400);
});

test('reordering and renaming reach the overdose form\'s "What happened" and "Given by"', async () => {
  const cur = (await admin.get('/api/admin/lists')).data.lists.find(l => l.key === 'ADMINISTERED_BY').entries.map(e => e.code);
  const order = [...cur].reverse();
  assert.equal((await admin.put('/api/admin/lists/ADMINISTERED_BY/order', { codes: order })).status, 200);
  assert.equal((await admin.put('/api/admin/lists/ADMINISTERED_BY/order', { codes: order.slice(1) })).status, 400, 'every choice, each once');
  assert.equal((await admin.put('/api/admin/lists/ADMINISTERED_BY/order', { codes: [...order.slice(1), order[1]] })).status, 400);
  assert.equal((await admin.put('/api/admin/lists/OVERDOSE_KINDS/entries/reversal', { label: 'Reversed with Narcan' })).status, 200);
  const m = (await nav.get('/api/meta/overdose-options')).data;
  assert.deepEqual(m.administered_by, order);
  assert.equal(entry(m.kind_options, 'reversal').label, 'Reversed with Narcan');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='options.reorder'`));
});

test('restore defaults puts a list back; the programme\'s own choices are hidden, not deleted', async () => {
  const r = await admin.post('/api/admin/lists/LOCATIONS/reset', {});
  assert.equal(r.status, 200);
  const C = require('../server/constants');
  assert.deepEqual(r.data.entries.filter(e => !e.hidden).map(e => e.code), C.LOCATIONS, 'the built-in choices in the built-in order');
  assert.equal(entry(r.data.entries, 'mobile_van').hidden, true, 'the van is kept for the visit that used it');
  assert.equal((await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', location: 'mobile_van', occurred_at: '2026-09-14T15:00:00Z' })).status, 400);
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='options.reset'`));
  assert.equal((await admin.put('/api/admin/lists/LOCATIONS/entries/mobile_van', { hidden: false })).status, 200, 'and can be offered again');
});

test('a spreadsheet import accepts the programme\'s wording and its own choices', async () => {
  const DI = require('../server/dataimport');
  const loc = DI.ENTITIES.interventions.fields.find(f => f.key === 'location');
  assert.equal(loc.parse('Mobile van'), 'mobile_van');
  assert.equal(loc.parse('field'), 'field');
  assert.equal(loc.parse('nowhere at all'), undefined);
});

test('devices receive the lists but can never change them', async () => {
  const bare = H.client();
  const l = await bare.post('/api/auth/login', { username: 'ol_nav', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' });
  const hdr = { Authorization: 'Bearer ' + l.data.token, Cookie: '' };
  const pull = await bare.get(`/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`, hdr);
  assert.equal(pull.status, 200);
  const rows = pull.data.tables.option_overrides;
  assert.ok(rows.some(x => x.list_key === 'LOCATIONS' && x.code === 'mobile_van' && x.label === 'Mobile van'), 'the programme\'s lists travel to devices');
  const id = rows[0].id;
  const push = await bare.post('/api/sync/push', { device_now: iso(Date.now()), tables: { option_overrides: [{ ...rows[0], label: 'Hacked', updated_at: iso(Date.now() + 5000) }] } }, hdr);
  assert.ok(push.data.rejected.some(x => x.id === id && x.reason === 'server-owned'), 'a device\'s copy is never accepted');
  assert.notEqual(db.one(`SELECT label FROM option_overrides WHERE id=?`, id).label, 'Hacked');
});

test('a client safety flag stored as a code has a label in the Safety flags list, rewordable like any other', async () => {
  const m = (await nav.get('/api/meta/constants')).data;
  assert.equal(entry(m.option_lists.CLIENT_FLAGS, 'no_home_visits').label, 'No home visits alone', 'the code a flag may be stored as has words');
  const put = await nav.put(`/api/clients/${clientId}`, { flags: 'no_home_visits, allergy: naltrexone' });
  assert.ok(put.status < 300, JSON.stringify(put.data));
  assert.equal((await nav.get(`/api/clients/${clientId}`)).data.client.flags, 'no_home_visits, allergy: naltrexone', 'the stored text is unchanged; only the display uses the label');
  assert.equal((await admin.put('/api/admin/lists/CLIENT_FLAGS/entries/no_home_visits', { label: 'Never visit at home alone' })).status, 200);
  assert.equal(entry((await nav.get('/api/meta/constants')).data.option_lists.CLIENT_FLAGS, 'no_home_visits').label, 'Never visit at home alone');
  assert.equal((await admin.post('/api/admin/lists/CLIENT_FLAGS/reset', {})).status, 200);
});
