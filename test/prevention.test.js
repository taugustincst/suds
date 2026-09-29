'use strict';
// 1.17.0 "Prevention and syringe services": the anonymous SSP participant code (server/participant-code.js) and
// group and community prevention events (server/routes/prevention.js, server/prevention.js).
//
// Participant code: stored encrypted with a blind index, only on a contact with no client; counted by the SSP
// summary (small-cell rule), never printed, never exported (a per-file reference stands in), carried by sync
// with its index recomputed by the receiver, re-derived by index-key rotation, and not in a publication release.
// Prevention events: the routes and their permissions (interventions:read/write, records:manage-others for another
// worker's), notes encrypted, sync of the new table, and the prevention activity summary with its exports.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

let admin, sup, nav, nav2, fin, ro, navId, nav2Id, clientId, fund;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const push = (c, body) => c.post('/api/sync/push', { device_now: iso(), ...body });
const PC = () => require('../server/participant-code');
const { decrypt } = require('../server/crypto');

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  for (const [u, role] of [['pvsup', 'supervisor'], ['pvnav', 'navigator'], ['pvnav2', 'navigator'], ['pvfin', 'finance'], ['pvro', 'readonly']]) H.makeUser(u, role);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('pvsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('pvnav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('pvnav2', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('pvfin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('pvro', 'StaffPassw0rd!x');
  navId = H.db.one(`SELECT id FROM users WHERE username='pvnav'`).id;
  nav2Id = H.db.one(`SELECT id FROM users WHERE username='pvnav2'`).id;
  clientId = (await nav.post('/api/clients', { first_name: 'Pia', last_name: 'Code' })).data.id;
  fund = (await admin.post('/api/budget/funds', { name: 'SABG prevention', source_type: 'state_block_grant', fiscal_year_start: '2026-07-01', fiscal_year_end: '2027-06-30', total_amount: 1000 })).data.id;
});
after(async () => { await H.stop(); });

// ---- the participant code ----
test('participant code: normalised, encrypted at rest, counted by its blind index, and read back only by whoever may read the visit', async () => {
  assert.equal(PC().normalise(' ab-07 85 '), 'AB0785');
  assert.equal(PC().index('ab 0785'), PC().index('AB-0785'), 'the same code however it was typed');
  assert.notEqual(PC().index('AB0785'), PC().index('AB0786'));
  assert.equal(PC().problem('AB'), 'must have at least 4 letters or digits');
  assert.equal(PC().problem(''), null);

  const r = await nav.post('/api/interventions', { type: 'outreach', occurred_at: '2026-08-05T18:00:00.000Z', participant_code: 'ab-07 85' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = H.db.one(`SELECT * FROM interventions WHERE id=?`, r.data.id);
  assert.match(row.participant_code_enc, /^v1:/, 'stored encrypted');
  assert.equal(decrypt(row.participant_code_enc), 'AB0785');
  assert.equal(row.participant_code_idx, PC().index('AB0785'));
  assert.ok(!JSON.stringify(row).includes('AB0785'), 'no plaintext copy anywhere in the row');
  const got = (await nav.get(`/api/interventions/${r.data.id}`)).data.row;
  assert.equal(got.participant_code, 'AB0785');
  assert.equal(got.participant_code_enc, undefined); assert.equal(got.participant_code_idx, undefined);
  // A navigator held to their caseload does not reach someone else's anonymous contact (the owner rule), code included.
  const held = H.makeCaseloadUser('pvheld', 'navigator'); const hc = H.client(); await hc.login(held.username, held.password);
  assert.equal((await hc.get(`/api/interventions/${r.data.id}`)).status, 403);
  // Never in the audit trail.
  assert.ok(!H.db.all(`SELECT details FROM audit_log WHERE details IS NOT NULL`).some(a => /AB0785|ab-07/i.test(a.details)), 'the code is not written into audit details');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='intervention.create' AND entity_id=?`, r.data.id));

  // Only on an anonymous contact, and a code must be long enough to tell people apart.
  const withClient = await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', occurred_at: '2026-08-05T18:00:00.000Z', participant_code: 'AB0785' });
  assert.equal(withClient.status, 400); assert.ok(withClient.data.fields && withClient.data.fields.participant_code);
  assert.equal((await nav.post('/api/interventions', { type: 'outreach', occurred_at: '2026-08-05T18:00:00.000Z', participant_code: 'a-b' })).status, 400);
  // Linking a coded contact to a client means removing the code in the same change.
  assert.equal((await nav.put(`/api/interventions/${r.data.id}`, { client_id: clientId })).status, 400);
  const e = await nav.put(`/api/interventions/${r.data.id}`, { participant_code: 'cd 1122' });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.equal(H.db.one(`SELECT participant_code_idx FROM interventions WHERE id=?`, r.data.id).participant_code_idx, PC().index('CD1122'));
  const cleared = await nav.put(`/api/interventions/${r.data.id}`, { participant_code: null });
  assert.equal(cleared.status, 200);
  const after = H.db.one(`SELECT participant_code_enc, participant_code_idx FROM interventions WHERE id=?`, r.data.id);
  assert.equal(after.participant_code_enc, null); assert.equal(after.participant_code_idx, null);
});

// Four anonymous contacts in September 2026 with codes QQ01, QQ01 (typed differently) and ZZ99, one with no code,
// and one client visit, each handing out a naloxone kit so each is a contact.
async function seedSeptember() {
  const at = (d) => `2026-09-${d}T17:00:00.000Z`;
  for (const [d, code] of [['02', 'QQ01'], ['03', 'qq-01'], ['04', 'ZZ99'], ['05', null]]) {
    const r = await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at(d), naloxone_kits: 1, ...(code ? { participant_code: code } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  assert.equal((await nav.post('/api/interventions', { client_id: clientId, type: 'harm_reduction', occurred_at: at('06'), naloxone_kits: 1 })).status, 201);
}

test('the SSP summary counts unique participants from codes, under the small-cell rule, and never prints a code', async () => {
  await seedSeptember();
  const Q = 'from=2026-09-01&to=2026-09-30';
  const exact = (await sup.get(`/api/reports/ssp?${Q}&counts=exact`)).data;
  assert.equal(exact.totals.anonymous_participants, 2, 'QQ01 twice and ZZ99: two participants');
  assert.equal(exact.totals.coded_contacts, 3);
  assert.equal(exact.totals.anonymous_contacts, 4);
  assert.equal(exact.totals.participants, 1, 'clients with a record are counted apart from codes');
  assert.match(exact.participant_code_note, /not added together/);
  // Suppressed for an internal run: two people is a small cell, like participants served.
  const s = (await nav.get(`/api/reports/ssp?${Q}`)).data;
  assert.equal(s.totals.anonymous_participants, '<11'); assert.equal(s.totals.coded_contacts, 3, 'contacts are not people: exact');
  // Exported: the count and the note, never a code.
  const csv = await sup.req('GET', `/api/reports/ssp/export?${Q}&counts=exact`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Anonymous participants \(different participant codes\),2/);
  assert.match(csv.data, /with a participant code",3/);
  assert.ok(!/QQ01|ZZ99/.test(csv.data), 'no code in the file');
  const x = await sup.raw(`/api/reports/ssp/export?${Q}&counts=exact&format=xlsx`);
  assert.equal(x.status, 200); const buf = Buffer.from(await x.arrayBuffer());
  assert.ok(!buf.includes('QQ01'), 'no code in the workbook');
  // Never a publication release: the syringe services summary refuses one, as before.
  assert.equal((await sup.get(`/api/reports/ssp?${Q}&purpose=publication`)).status, 400);
});

test('exports: a participant code goes out only as a reference random for the file, de-identified or identified', async () => {
  const Q = 'from=2026-09-01&to=2026-09-30';
  const d = String((await sup.get(`/api/reports/export/interventions?${Q}`)).data).replace(/^\uFEFF/, '');
  const rows = require('../server/spreadsheet').parseCsv(d);
  const head = rows[0]; const ref = head.indexOf('Participant Ref');
  assert.ok(ref > 0, head.join('|'));
  const refs = rows.slice(1).map(r => r[ref]).filter(Boolean);
  assert.equal(refs.length, 3, 'the three coded contacts carry a reference');
  assert.equal(new Set(refs).size, 2, 'the same code shares a reference within the file');
  assert.ok(refs.every(x => /^P-[0-9A-F]{10}$/.test(x)));
  assert.ok(!/QQ01|ZZ99/.test(d), 'no code in a de-identified file');
  // The next file gets different references.
  const d2 = String((await sup.get(`/api/reports/export/interventions?${Q}`)).data);
  assert.ok(!refs.some(x => d2.includes(x)), 'references are random for each file');
  // Identified: still the reference, never the code (disclosure.js accounts for the clients the file names).
  await H.agreement(admin, 'County counsel');
  const idr = await sup.get(`/api/reports/export/interventions?${Q}&identified=1&basis=audit_evaluation&recipient=County%20counsel&purpose=Audit`);
  assert.equal(idr.status, 200, JSON.stringify(idr.data));
  assert.match(String(idr.data), /Participant Ref/); assert.ok(!/QQ01|ZZ99/.test(String(idr.data)), 'no code in an identified file');
});

test('publication: no participant figure enters a publication release', async () => {
  const pub = await sup.get('/api/reports/funder?from=2026-09-01&to=2026-09-30&purpose=publication');
  // September has not ended in every time zone the test may run in: a refusal is fine, a figure is not.
  assert.ok([200, 400, 422].includes(pub.status), JSON.stringify(pub.data).slice(0, 300));
  assert.ok(!/participant_code|anonymous_participants/.test(JSON.stringify(pub.data)));
  const aug = await sup.get('/api/reports/funder?from=2026-08-01&to=2026-08-31&purpose=publication');
  assert.ok(!/participant_code|anonymous_participants/.test(JSON.stringify(aug.data)));
});

test('sync: a device\'s code is normalised and indexed with the office key; a pull sends it decrypted, never the index', async () => {
  const id = randomUUID();
  const r = await push(nav, { tables: { interventions: [{ id, user_id: navId, type: 'outreach', occurred_at: '2026-09-10T17:00:00.000Z', participant_code_enc: 'xy 12-34', participant_code_idx: 'forged', created_at: iso(), updated_at: iso() }] } });
  assert.equal(r.status, 200); assert.ok(!r.data.rejected.length, JSON.stringify(r.data.rejected));
  const row = H.db.one(`SELECT participant_code_enc, participant_code_idx FROM interventions WHERE id=?`, id);
  assert.equal(decrypt(row.participant_code_enc), 'XY1234', 'normalised as the office stores it');
  assert.equal(row.participant_code_idx, PC().index('XY1234'), 'the index is the office\'s own, not the device\'s');
  const pulled = (await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).data.tables.interventions.find(x => x.id === id);
  assert.equal(pulled.participant_code_enc, 'XY1234');
  assert.ok(!('participant_code_idx' in pulled));
  // The same rules as REST: not on a visit with a client.
  const bad = randomUUID();
  const r2 = await push(nav, { tables: { interventions: [{ id: bad, client_id: clientId, user_id: navId, type: 'outreach', occurred_at: iso(), participant_code_enc: 'XY1234', created_at: iso(), updated_at: iso() }] } });
  assert.ok(r2.data.rejected.some(x => x.id === bad && /participant code on a contact with a client/.test(x.reason)));
  // Key rotation knows how to re-derive it.
  const { DERIVATIONS } = require('../scripts/rotate-index-key');
  assert.deepEqual(DERIVATIONS.interventions.derive({ participant_code_enc: 'XY1234' }), { participant_code_idx: PC().index('XY1234') });
  assert.deepEqual(DERIVATIONS.interventions.derive({}), { participant_code_idx: null });
});

// ---- prevention events ----
const ev = (over = {}) => ({ event_date: '2026-09-10', title: 'Parent night at Lincoln Middle', event_type: 'presentation', strategy: 'education', iom_category: 'universal_direct', audience: 'parents_families', location: 'Lincoln Middle School', hours: 1.5, attendance: 24, funding_source_id: fund, ...over });

test('prevention events: who may record, read, change and delete them', async () => {
  const mine = await nav.post('/api/prevention-events', ev({ notes: 'Good questions about vaping.' }));
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  const row = H.db.one(`SELECT * FROM prevention_events WHERE id=?`, mine.data.id);
  assert.equal(row.user_id, navId); assert.match(row.notes_enc, /^v1:/, 'notes stored encrypted'); assert.equal(decrypt(row.notes_enc), 'Good questions about vaping.');
  const got = (await nav2.get(`/api/prevention-events/${mine.data.id}`)).data.row;
  assert.equal(got.notes, 'Good questions about vaping.'); assert.equal(got.worker, 'pvnav'); assert.equal(got.funding_source, 'SABG prevention');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='prevention_event.create' AND entity_id=?`, mine.data.id));
  // Everyone who reads visits sees the programme's events; roles without visits do not.
  assert.equal((await nav2.get('/api/prevention-events')).status, 200);
  for (const c of [fin, ro]) {
    assert.equal((await c.get('/api/prevention-events')).status, 403);
    assert.equal((await c.post('/api/prevention-events', ev())).status, 403);
  }
  // Another worker's event: theirs, or a supervisor's, to change or delete.
  assert.equal((await nav2.put(`/api/prevention-events/${mine.data.id}`, { attendance: 30 })).status, 403);
  assert.equal((await nav2.del(`/api/prevention-events/${mine.data.id}`)).status, 403);
  assert.equal((await sup.put(`/api/prevention-events/${mine.data.id}`, { attendance: 30 })).status, 200);
  assert.equal(H.db.one(`SELECT attendance FROM prevention_events WHERE id=?`, mine.data.id).attendance, 30);
  // A navigator cannot record one as someone else's; a supervisor can.
  const asOther = await nav.post('/api/prevention-events', ev({ user_id: nav2Id }));
  assert.equal(H.db.one(`SELECT user_id FROM prevention_events WHERE id=?`, asOther.data.id).user_id, navId);
  const bySup = await sup.post('/api/prevention-events', ev({ user_id: nav2Id }));
  assert.equal(H.db.one(`SELECT user_id FROM prevention_events WHERE id=?`, bySup.data.id).user_id, nav2Id);
  // Validation: the national categories are fixed, the counts are counts.
  for (const bad of [{ strategy: 'vibes' }, { iom_category: 'everyone' }, { attendance: -3 }, { hours: -1 }, { title: '' }, { event_type: 'rave' }]) assert.equal((await nav.post('/api/prevention-events', ev(bad))).status, 400, JSON.stringify(bad));
  // Filters.
  const f = (await nav.get('/api/prevention-events?strategy=education&from=2026-09-01&to=2026-09-30')).data;
  assert.ok(f.rows.length >= 3 && f.rows.every(x => x.strategy === 'education'));
  // Its own worker deletes it.
  assert.equal((await nav.del(`/api/prevention-events/${asOther.data.id}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='prevention_events' AND id=?`, asOther.data.id));
});

test('prevention events: the lists are Settings › Lists option lists, the national ones closed to additions', async () => {
  const m = (await nav.get('/api/meta/constants')).data;
  assert.deepEqual(m.PREVENTION_STRATEGIES, ['information_dissemination', 'education', 'alternatives', 'problem_identification_referral', 'community_based_process', 'environmental']);
  assert.deepEqual(m.PREVENTION_IOM, ['universal_direct', 'universal_indirect', 'selective', 'indicated']);
  assert.equal(m.option_lists.PREVENTION_STRATEGIES.find(e => e.code === 'problem_identification_referral').label, 'Problem identification and referral');
  assert.ok(m.option_lists.PREVENTION_EVENT_TYPES.find(e => e.code === 'training').protected, 'training cannot be retired: it is the people-trained count');
  const lists = require('../server/options').describe().lists;
  assert.equal(lists.find(l => l.key === 'PREVENTION_STRATEGIES').custom_allowed, false);
  assert.equal(lists.find(l => l.key === 'PREVENTION_IOM').custom_allowed, false);
  assert.equal(lists.find(l => l.key === 'PREVENTION_EVENT_TYPES').custom_allowed, true);
});

test('sync: prevention events reach devices that read visits, and a device is held to the owner rule', async () => {
  const theirs = (await nav2.post('/api/prevention-events', ev({ title: 'Nav2 coalition meeting', event_type: 'coalition_meeting', strategy: 'community_based_process' }))).data.id;
  const pulled = (await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).data.tables.prevention_events;
  assert.ok(pulled.some(x => x.id === theirs), 'a navigator\'s device gets the programme\'s events');
  const p = pulled.find(x => x.id === theirs); assert.equal(p.notes_enc, null);
  const finPull = await fin.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
  assert.ok(finPull.status !== 200 || !(finPull.data.tables.prevention_events || []).length, 'not to a role that does not read visits');
  // A device's own new event lands; its notes are encrypted with the office key.
  const id = randomUUID();
  const r = await push(nav, { tables: { prevention_events: [{ id, user_id: navId, event_date: '2026-09-12', title: 'Pushed training', event_type: 'training', strategy: 'education', iom_category: 'selective', hours: 3, attendance: 15, notes_enc: 'Recorded offline', created_at: iso(), updated_at: iso() }] } });
  assert.ok(!r.data.rejected.length, JSON.stringify(r.data.rejected));
  assert.equal(decrypt(H.db.one(`SELECT notes_enc FROM prevention_events WHERE id=?`, id).notes_enc), 'Recorded offline');
  // Another worker's event: not this device's to change or delete.
  const row = H.db.one(`SELECT * FROM prevention_events WHERE id=?`, theirs);
  const e = await push(nav, { tables: { prevention_events: [{ ...row, attendance: 999, notes_enc: null, updated_at: iso(Date.now() + 5000) }] } });
  assert.ok(e.data.rejected.some(x => x.id === theirs && x.reason === 'not permitted'), JSON.stringify(e.data));
  const t = await push(nav, { tombstones: [{ table_name: 'prevention_events', id: theirs, deleted_at: iso(Date.now() + 5000) }] });
  assert.ok(t.data.rejected.some(x => x.id === theirs && x.reason === 'not permitted'));
  assert.ok(H.db.one(`SELECT 1 FROM prevention_events WHERE id=?`, theirs), 'still there');
  // A supervisor's device may.
  const s = await push(sup, { tombstones: [{ table_name: 'prevention_events', id: theirs, deleted_at: iso(Date.now() + 5000) }] });
  assert.ok(!s.data.rejected.length); assert.ok(!H.db.one(`SELECT 1 FROM prevention_events WHERE id=?`, theirs));
});

test('the prevention activity summary: totals by strategy and IOM category, people trained, exports; not a PPSDS file', async () => {
  H.db.run(`DELETE FROM prevention_events`);
  const add = async (c, o) => assert.equal((await c.post('/api/prevention-events', ev(o))).status, 201);
  await add(nav, { event_date: '2026-10-02', event_type: 'presentation', strategy: 'education', iom_category: 'universal_direct', hours: 1, attendance: 30 });
  await add(nav, { event_date: '2026-10-03', event_type: 'training', strategy: 'education', iom_category: 'selective', hours: 4, attendance: 12 });
  await add(nav2, { event_date: '2026-10-04', event_type: 'training', strategy: 'problem_identification_referral', iom_category: 'indicated', hours: 2.5, attendance: 8 });
  await add(nav2, { event_date: '2026-10-05', event_type: 'media_campaign', strategy: 'information_dissemination', iom_category: 'universal_indirect', hours: 6, attendance: 5000, attendance_estimated: true, audience: 'general_community' });
  await add(nav, { event_date: '2026-11-01', event_type: 'training', strategy: 'education', iom_category: 'selective', hours: 4, attendance: 99 }); // outside the period
  const Q = 'from=2026-10-01&to=2026-10-31';
  const r = await ro.get(`/api/reports/prevention?${Q}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.deepEqual(d.totals, { events: 4, hours: 13.5, attendance: 5050, attendance_estimated: 5000, people_trained: 20, training_events: 2 });
  const by = (list, code) => list.find(x => x.code === code);
  assert.deepEqual(by(d.by_strategy, 'education'), { code: 'education', label: 'Education', events: 2, hours: 5, attendance: 42 });
  assert.equal(by(d.by_strategy, 'environmental').events, 0, 'every CSAP strategy is listed, zeros included');
  assert.equal(d.by_strategy.length, 6); assert.equal(d.by_iom.length, 4);
  assert.equal(by(d.by_iom, 'universal_indirect').attendance, 5000);
  assert.equal(by(d.by_strategy_iom, 'education').cells.selective.attendance, 12);
  assert.equal(by(d.by_strategy_iom, 'education').cells.universal_direct.events, 1);
  assert.equal(by(d.by_type, 'training').attendance, 20);
  assert.match(d.ppsds_note, /not a PPSDS submission file/); assert.match(d.ppsds_note, /DHCS PPSDS data dictionary/);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.prevention'`));
  // Exports: CSV and Excel, named for what they are.
  const csv = await sup.req('GET', `/api/reports/prevention/export?${Q}`);
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /suds-prevention-activity-summary-2026-10-01_2026-10-31\.csv/);
  assert.match(csv.data, /People trained,20/); assert.match(csv.data, /Strategy \(CSAP\): Education,Attendance,42/); assert.match(csv.data, /not a PPSDS submission file/);
  assert.match(csv.headers.get('x-suds-export'), /not a PPSDS file/);
  const xlsx = await nav.raw(`/api/reports/prevention/export?${Q}&format=xlsx`);
  assert.equal(xlsx.status, 200); assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='report.prevention.export'`));
  // Export needs export:read (read-only has reports:read only).
  assert.equal((await ro.get(`/api/reports/prevention/export?${Q}`)).status, 403);
  assert.equal((await fin.get(`/api/reports/prevention/export?${Q}`)).status, 200);
  assert.equal((await ro.get('/api/reports/prevention?from=bad')).status, 400);
});
