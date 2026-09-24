'use strict';
// The load review (2,000 clients / 64k records): each test here is a weakness it found — a retention purge
// that deleted live records, names in other scripts that could not be searched for or matched as
// duplicates, a funder report whose fund filter reached half its count, report days cut at UTC midnight,
// device sync that ignored local mode being off, an audit check that froze the server, and a naloxone
// handout to a stranger that could not be recorded.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

let admin, nav, navId, resourceId;
const config = require('../server/config');

before(async () => {
  await H.start();
  H.makeUser('lnav', 'navigator');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('lnav', 'StaffPassw0rd!x');
  navId = H.db.one(`SELECT id FROM users WHERE username='lnav'`).id;
  resourceId = (await admin.post('/api/resources', { name: 'Load review agency', category: 'other' })).data.id;
});
after(async () => { await H.stop(); });

// ---- 1. retention counts every activity on the record ----
async function closedClient(first, last, { intake = '2017-01-01', discharge = '2018-01-01', status = 'closed' } = {}) {
  const id = (await admin.post('/api/clients', { first_name: first, last_name: last, status, intake_date: intake, discharge_date: discharge, confirm_duplicate: true })).data.id;
  H.db.run(`UPDATE episodes SET status='closed', closed_at=? WHERE client_id=?`, discharge, id);
  H.db.run(`UPDATE tasks SET status='cancelled' WHERE client_id=?`, id);
  return id;
}
const due = (id) => require('../server/retention').expiredClients().some(x => x.id === id);

test('retention: a visit or note logged after discharge keeps the record; a truly stale one is due', async () => {
  const live = await closedClient('Still', 'Served');
  assert.ok(due(live), 'discharged 2018 with nothing since: due');
  // Outreach to a discharged client is legitimate: it is recorded, not refused…
  const v = await admin.post('/api/interventions', { client_id: live, type: 'outreach', occurred_at: '2024-05-01T17:00:00.000Z', duration_minutes: 20 });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  // …and it restarts the clock.
  assert.ok(!due(live), 'a 2024 visit restarts the retention clock');
  assert.equal((await admin.post('/api/notes', { client_id: live, kind: 'admin', content: 'Checked in by phone', occurred_at: '2025-02-01T10:00:00.000Z' })).status, 201);
  const run = require('../server/retention').purgeExpiredClients();
  assert.ok(H.db.one(`SELECT 1 FROM clients WHERE id=?`, live), 'discharged 2018, visit 2024, note 2025: not purged');
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, live).client_code;
  assert.ok(!run.purged.includes(code));

  const stale = await closedClient('Truly', 'Stale', { intake: '2010-01-01', discharge: '2012-01-01' });
  await admin.post('/api/interventions', { client_id: stale, type: 'outreach', occurred_at: '2011-06-01T10:00:00.000Z' });
  assert.ok(due(stale));
  const run2 = require('../server/retention').purgeExpiredClients();
  assert.ok(!H.db.one(`SELECT 1 FROM clients WHERE id=?`, stale), 'truly stale: purged');
  assert.ok(run2.purged.length >= 1);
});

test('retention: every client-linked service table restarts the clock', async () => {
  const R = require('../server/retention');
  const recent = '2025-03-01';
  const cases = {
    calls: (c) => H.db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at) VALUES(?,?,?,?,?)`, randomUUID(), c, navId, 'outbound', `${recent}T10:00:00.000Z`),
    referrals: (c) => H.db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status) VALUES(?,?,?,?,?,?)`, randomUUID(), c, resourceId, navId, `${recent}T10:00:00.000Z`, 'completed'),
    tasks: (c) => H.db.run(`INSERT INTO tasks(id,client_id,created_by,title_enc,status,completed_at) VALUES(?,?,?,?,?,?)`, randomUUID(), c, navId, 'x', 'done', `${recent}T10:00:00.000Z`),
    consents: (c) => H.db.run(`INSERT INTO consents(id,client_id,type,signed_at,created_by) VALUES(?,?,?,?,?)`, randomUUID(), c, 'roi', recent, navId),
    disclosures: (c) => H.db.run(`INSERT INTO disclosures(id,client_id,recipient_enc,purpose_enc,what_enc,disclosed_at,disclosed_by) VALUES(?,?,?,?,?,?,?)`, randomUUID(), c, 'x', 'x', 'x', `${recent}T10:00:00.000Z`, navId),
    client_forms: (c) => H.db.run(`INSERT INTO client_forms(id,client_id,template_name,values_enc,status,completed_at,created_by) VALUES(?,?,?,?,?,?,?)`, randomUUID(), c, 'Form', 'x', 'completed', `${recent}T10:00:00.000Z`, navId),
    overdose_events: (c) => H.db.run(`INSERT INTO overdose_events(id,client_id,occurred_at) VALUES(?,?,?)`, randomUUID(), c, `${recent}T10:00:00.000Z`),
    patient_requests: (c) => H.db.run(`INSERT INTO patient_requests(id,client_id,kind,received_at,due_at,status,created_by,closed_at) VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), c, 'access', recent, recent, 'fulfilled', navId, recent),
    time_entries: (c) => H.db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category) VALUES(?,?,?,?,?,?)`, randomUUID(), navId, c, recent, 15, 'direct_service'),
    episodes: (c) => H.db.run(`INSERT INTO episodes(id,client_id,opened_at,closed_at,status) VALUES(?,?,?,?,?)`, randomUUID(), c, '2024-01-01', recent, 'closed'),
  };
  for (const [table, add] of Object.entries(cases)) {
    const c = await closedClient('Clock', table.replace(/_/g, ''));
    assert.ok(due(c), `${table}: due before`);
    add(c);
    assert.ok(!due(c), `${table}: activity in ${recent} keeps the record`);
  }
  // Every table with a client_id is either activity or deliberately not, so a new one cannot be forgotten.
  const tables = H.db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name)
    .filter(t => H.db.all(`PRAGMA table_info(${t})`).some(c => c.name === 'client_id') && t !== 'audit_log');
  for (const t of tables) assert.ok(t in R.ACTIVITY || R.NOT_ACTIVITY.includes(t), `${t} is classified for retention`);
});

test('retention: an inactive record is due on the same clock, from its last activity', async () => {
  const drifted = (await admin.post('/api/clients', { first_name: 'Drifted', last_name: 'Longago', status: 'inactive', intake_date: '2010-01-01', confirm_duplicate: true })).data.id;
  await admin.post('/api/interventions', { client_id: drifted, type: 'outreach', occurred_at: '2011-03-01T10:00:00.000Z' });
  H.db.run(`UPDATE tasks SET status='cancelled' WHERE client_id=?`, drifted);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM episodes WHERE client_id=? AND status='open'`, drifted).n, 1, 'never formally discharged');
  assert.ok(due(drifted), 'inactive with nothing since 2011: due, open episode or not');
  const recent = (await admin.post('/api/clients', { first_name: 'Drifted', last_name: 'Recently', status: 'inactive', intake_date: '2010-01-01', confirm_duplicate: true })).data.id;
  H.db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at) VALUES(?,?,?,?,?)`, randomUUID(), recent, navId, 'outbound', '2024-08-01T10:00:00.000Z');
  assert.ok(!due(recent), 'inactive but called last year: kept');
  const active = (await admin.post('/api/clients', { first_name: 'Never', last_name: 'Due', status: 'active', intake_date: '2010-01-01', confirm_duplicate: true })).data.id;
  assert.ok(!due(active), 'an active record is never due');
});

// ---- 2. names in every script ----
test('names outside a-z are searchable and indexed; accents and Ø/Ł fold to what staff type', async () => {
  const mk = async (first, last, extra = {}) => { const r = await nav.post('/api/clients', { first_name: first, last_name: last, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  const hasan = await mk('علي', 'حسن');
  const oster = await mk('Ingrid', 'Øster');
  const lecki = await mk('Paweł', 'Łecki');
  const ivan = await mk('Иван', 'Петров', { dob: '1985-02-03' });
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, hasan);
  for (const c of ['last_name_idx', 'full_name_idx', 'name_prefix_idx', 'name_phonetic_idx', 'first_name_idx']) assert.ok(row[c], `${c} is set for an Arabic name`);
  const find = async (q) => (await nav.get(`/api/clients?q=${encodeURIComponent(q)}`)).data.clients.map(c => c.id);
  assert.ok((await find('حسن')).includes(hasan), 'Arabic surname');
  assert.ok((await find('حَسَن')).includes(hasan), 'with vowel marks typed');
  assert.ok((await find('Oster')).includes(oster), 'Oster finds Øster');
  assert.ok((await find('Lecki')).includes(lecki), 'Lecki finds Łecki');
  assert.ok((await find('Pawel Lecki')).includes(lecki), 'full name, either way round');
  assert.ok((await find('Петров')).includes(ivan), 'Cyrillic surname');
  assert.ok((await find('Пет')).includes(ivan), 'Cyrillic prefix');
  assert.ok(!(await find('Петрова')).includes(hasan));
  // Latin phonetic matching is unchanged.
  const ng = await mk('Linh', 'Nguyen');
  assert.ok((await find('Nguyan')).includes(ng), 'a misspelled Latin surname still finds the person');
});

test('duplicates are caught for Arabic and Cyrillic names with the same date of birth', async () => {
  for (const [first, last] of [['محمد', 'العلي'], ['Иван', 'Смирнов']]) {
    const a = await nav.post('/api/clients', { first_name: first, last_name: last, dob: '1990-05-06' });
    assert.equal(a.status, 201);
    const b = await nav.post('/api/clients', { first_name: first, last_name: last, dob: '1990-05-06' });
    assert.equal(b.status, 400, `${first} ${last} a second time is flagged`);
    assert.ok(b.data.duplicates.some(d => d.id === a.data.id && d.reasons.includes('same surname and date of birth') && d.reasons.includes('same full name')), JSON.stringify(b.data));
  }
});

test('the kernel and key rotation derive name indexes with the same function', () => {
  const M = require('../server/clients-model');
  const { blindIndex } = require('../server/crypto');
  const idx = M.clientIndexes({ first_name: 'José', last_name: 'Øster', dob: '1980-01-02', phone: '(555) 010-2030' });
  assert.equal(idx.last_name_idx, blindIndex('oster'));
  assert.equal(idx.full_name_idx, blindIndex('osterjose'));
  assert.equal(idx.phone_idx, blindIndex('5550102030'));
  assert.equal(M.namePhoneticIndex('Oster'), M.namePhoneticIndex('Øster'), 'Soundex on the folded name');
  assert.equal(M.namePhoneticIndex('Петров'), blindIndex('nrm:петров'), 'non-Latin: exact normalised, not Soundex of nothing');
  assert.equal(require('../scripts/rotate-index-key').DERIVATIONS.clients.derive({ first_name_enc: 'José', last_name_enc: 'Øster', dob_enc: '1980-01-02', phone_enc: '(555) 010-2030' }).full_name_idx, idx.full_name_idx);
});

// ---- 3 & 4. the funder report: one served set per filter; report days in the org's time zone ----
test('funder report: the fund filter, deleted clients and demographics all use one served set', async () => {
  const fund = async (name) => (await admin.post('/api/budget/funds', { name, fiscal_year_start: '2023-07-01', fiscal_year_end: '2024-06-30', total_amount: 1000 })).data.id;
  const A = await fund('Grant A'), B = await fund('Grant B');
  const mk = async (last, gender) => (await admin.post('/api/clients', { first_name: 'Funder', last_name: last, gender, confirm_duplicate: true })).data.id;
  const a = await mk('Alpha', 'female'), b = await mk('Bravo', 'male'), callOnly = await mk('Charlie', 'nonbinary'), gone = await mk('Deleted', 'male');
  const visit = (client_id, funding_source_id) => admin.post('/api/interventions', { client_id, type: 'case_management', occurred_at: '2024-03-01T18:00:00.000Z', funding_source_id });
  assert.equal((await visit(a, A)).status, 201);
  assert.equal((await visit(a, A)).status, 201, 'a second visit: still one person');
  assert.equal((await visit(b, B)).status, 201);
  assert.equal((await visit(gone, A)).status, 201);
  assert.equal((await admin.post('/api/calls', { client_id: callOnly, direction: 'outbound', started_at: '2024-03-02T18:00:00.000Z', outcome: 'reached' })).status, 201);
  for (const c of [a, b, callOnly, gone]) H.db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status) VALUES(?,?,?,?,?,?)`, randomUUID(), c, resourceId, navId, '2024-03-03T18:00:00.000Z', 'pending');
  assert.equal((await admin.del(`/api/clients/${gone}`, { reason: 'entered in error' })).status, 200);

  const rep = async (q) => (await admin.get(`/api/reports/funder?from=2024-02-01&to=2024-03-31${q}`)).data;
  const all = await rep('');
  assert.equal(all.unduplicated.served, 3, 'A visit, B visit and the call-only client; not the deleted one');
  assert.equal(all.unduplicated.with_a_referral, 3, 'the deleted client\'s referral is not counted');
  const gA = await rep(`&funding_source_id=${A}`);
  assert.equal(gA.unduplicated.served, 1, 'grant A: only the person whose work was charged to A');
  assert.equal(gA.unduplicated.with_a_referral, 1);
  const gB = await rep(`&funding_source_id=${B}`);
  assert.equal(gB.unduplicated.served, 1);
  // Demographics count exactly the served set (small cells are suppressed, so compare the raw rows' presence).
  const genders = (r) => r.demographics.by_gender.map(x => x.k).sort();
  assert.deepEqual(genders(all), ['female', 'male', 'nonbinary'], 'the call-only client is in the breakdown');
  assert.deepEqual(genders(gA), ['female'], 'a fund filter narrows the breakdown too');
  assert.deepEqual(genders(gB), ['male']);
  const byFund = Object.fromEntries(all.by_funding_source.map(f => [f.id, f.clients_served]));
  assert.equal(byFund[A], 1, 'the deleted client is not counted under its fund either');
});

test('report periods are local calendar days in ORG_TIMEZONE, not UTC days', async () => {
  const was = config.orgTimezone; config.orgTimezone = 'America/Los_Angeles';
  try {
    const c = (await admin.post('/api/clients', { first_name: 'Fiscal', last_name: 'Yearend', confirm_duplicate: true })).data.id;
    // 5:30pm on June 30th in Los Angeles is 00:30 UTC on July 1st.
    assert.equal((await admin.post('/api/interventions', { client_id: c, type: 'case_management', occurred_at: '2026-07-01T00:30:00.000Z' })).status, 201);
    // 8pm on June 30th of the year before belongs to the previous fiscal year, although it is July 1st in UTC.
    const prior = (await admin.post('/api/clients', { first_name: 'Fiscal', last_name: 'Prioryear', confirm_duplicate: true })).data.id;
    assert.equal((await admin.post('/api/interventions', { client_id: prior, type: 'case_management', occurred_at: '2025-07-01T03:00:00.000Z' })).status, 201);
    // A visit stored as a bare calendar day is compared as a day.
    const bare = (await admin.post('/api/clients', { first_name: 'Fiscal', last_name: 'Bareday', confirm_duplicate: true })).data.id;
    assert.equal((await admin.post('/api/interventions', { client_id: bare, type: 'case_management', occurred_at: '2026-06-30' })).status, 201);
    const fy = (await admin.get('/api/reports/funder?from=2025-07-01&to=2026-06-30')).data;
    const served = fy.unduplicated.served;
    const d = await admin.get('/api/reports/dashboard?from=2026-06-30&to=2026-06-30');
    assert.equal(d.status, 200);
    assert.equal(d.data.interventions.total, 2, 'the dashboard\'s June 30th has the 5:30pm visit and the bare-day one');
    const julyFirst = (await admin.get('/api/reports/dashboard?from=2026-07-01&to=2026-07-01')).data;
    assert.equal(julyFirst.interventions.total, 0, 'and July 1st does not');
    // The de-identified export coarsens dates to the month, so tell the rows apart by client code.
    const code = (id) => H.db.one(`SELECT client_code FROM clients WHERE id=?`, id).client_code;
    const inFy = String((await admin.get('/api/reports/export/interventions?from=2025-07-01&to=2026-06-30')).data);
    assert.ok(inFy.includes(code(c)) && inFy.includes(code(bare)), 'the export uses the same local days');
    assert.ok(!inFy.includes(code(prior)), 'and leaves out the previous fiscal year\'s last evening');
    // The FY count includes both late-June visits and not the prior-year evening.
    const prev = (await admin.get('/api/reports/funder?from=2024-07-01&to=2025-06-30')).data.unduplicated.served;
    assert.ok(prev >= 1, 'the prior-year evening is in the prior fiscal year');
    assert.ok(served >= 2);
    const onlyThese = (await admin.get('/api/reports/funder?from=2026-06-30&to=2026-06-30')).data.unduplicated.served;
    assert.equal(onlyThese, 2, 'June 30th: the 5:30pm visit and the bare-day visit');
    assert.equal((await admin.get('/api/reports/funder?from=2025-06-30&to=2025-06-30')).data.unduplicated.served, 1, 'June 30th 2025 has the 8pm visit');
    assert.equal((await admin.get('/api/reports/funder?from=junk')).status, 400);
  } finally { config.orgTimezone = was; }
});

// ---- 5. local mode off stops sync ----
test('with local mode off, sync pull and push are refused with 403', async () => {
  const was = config.localModeEnabled;
  try {
    config.localModeEnabled = false;
    const pull = await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
    assert.equal(pull.status, 403);
    assert.match(pull.data.error, /Local mode .* turned off/);
    const push = await nav.post('/api/sync/push', { device_now: new Date().toISOString(), tables: {} });
    assert.equal(push.status, 403);
    assert.equal((await nav.get('/api/sync/blob/resource_photos/x/data_b64')).status, 403);
    config.localModeEnabled = true;
    assert.equal((await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).status, 200, 'on: allowed');
    assert.equal((await nav.post('/api/sync/push', { device_now: new Date().toISOString(), tables: {} })).status, 200);
  } finally { config.localModeEnabled = was; }
});

// ---- 6. audit verification: incremental, chunked, still catching tampering ----
test('the scheduled audit check is incremental and yields; tampering after the marker is caught, before it by a full check', async () => {
  const audit = require('../server/audit');
  for (let i = 0; i < 12; i++) audit.log({ user: { username: 'system' }, action: 'test.fill', details: { i } });
  const first = await audit.scheduledVerify({ full: true, batch: 5 });
  assert.equal(first.ok, true); assert.equal(first.mode, 'full');
  const marker = audit.verifiedMarker();
  assert.ok(marker && marker.id, 'the last verified entry is recorded');

  // It yields to the event loop between batches.
  for (let i = 0; i < 12; i++) audit.log({ user: { username: 'system' }, action: 'test.fill', details: { i } });
  let ranBetween = false; setImmediate(() => { ranBetween = true; });
  const inc = audit.verifyChainAsync({ incremental: true, batch: 3 });
  assert.equal(ranBetween, false);
  const incRes = await inc;
  assert.ok(ranBetween, 'other work ran while it verified');
  assert.equal(incRes.ok, true); assert.equal(incRes.mode, 'incremental'); assert.ok(incRes.checked < H.db.one(`SELECT COUNT(*) n FROM audit_log`).n, 'only the new entries were read');

  // Tampered after the marker: the incremental check finds it.
  const markerNow = audit.verifiedMarker().id;
  audit.log({ user: { username: 'system' }, action: 'test.after' });
  const after = H.db.one(`SELECT id, details FROM audit_log WHERE action='test.after' ORDER BY id DESC LIMIT 1`);
  assert.ok(after.id > markerNow);
  H.db.run(`UPDATE audit_log SET action='test.edited' WHERE id=?`, after.id);
  const r1 = await audit.scheduledVerify();
  assert.equal(r1.mode, 'incremental'); assert.equal(r1.ok, false); assert.equal(r1.firstBadId, after.id);
  H.db.run(`UPDATE audit_log SET action='test.after' WHERE id=?`, after.id);
  assert.equal((await audit.scheduledVerify()).ok, true, 'restored: clean again');

  // Tampered before the marker: an incremental check does not re-read it; a full check does.
  const early = H.db.one(`SELECT id, details FROM audit_log WHERE action='test.fill' ORDER BY id ASC LIMIT 1`);
  assert.ok(early.id < audit.verifiedMarker().id);
  H.db.run(`UPDATE audit_log SET details='{"i":99}' WHERE id=?`, early.id);
  assert.equal((await audit.verifyChainAsync({ incremental: true })).mode, 'incremental');
  const full = await audit.scheduledVerify({ full: true });
  assert.equal(full.ok, false); assert.equal(full.mode, 'full'); assert.equal(full.firstBadId, early.id);
  assert.equal(audit.verifyChain().firstBadId, early.id, 'the synchronous full check (CLI, rotation) agrees');
  assert.equal((await admin.get('/api/admin/audit/verify')).data.firstBadId, early.id, 'and so does the Verify button');
  H.db.run(`UPDATE audit_log SET details=? WHERE id=?`, early.details, early.id);
  assert.equal(audit.verifyChain().ok, true);
  // A marker moved by editing settings is not trusted: the next check walks everything.
  H.db.run(`UPDATE settings SET value=? WHERE key='audit_verified_id'`, String(early.id));
  assert.equal(audit.verifiedMarker(), null);
  assert.equal((await audit.verifyChainAsync({ incremental: true })).mode, 'full');
});

// ---- 7. client-less naloxone distribution; the time-entry 500 ----
test('outreach and community naloxone distribution need no client; every other service does', async () => {
  const at = new Date().toISOString();
  const nal = await nav.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: at, naloxone_kits: 5, duration_minutes: 15, log_time: true });
  assert.equal(nal.status, 201, JSON.stringify(nal.data));
  const te = H.db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, nal.data.id);
  assert.ok(te && te.client_id === null && te.minutes === 15, 'client_id omitted while logging time: a time entry, not a 500');
  assert.equal((await nav.post('/api/interventions', { type: 'outreach', occurred_at: at, duration_minutes: 10, log_time: true })).status, 201);
  const cm = await nav.post('/api/interventions', { type: 'case_management', occurred_at: at });
  assert.equal(cm.status, 400); assert.ok(cm.data.fields && cm.data.fields.client_id, 'the Client field is named');
  assert.equal((await nav.post('/api/interventions', { type: 'assessment', occurred_at: at, client_id: null })).status, 400);
  // Changing a client-less record to a type that needs a client is refused too.
  assert.equal((await nav.put(`/api/interventions/${nal.data.id}`, { type: 'case_management' })).status, 400);
  assert.equal((await nav.put(`/api/interventions/${nal.data.id}`, { naloxone_kits: 6 })).status, 200, 'an unrelated edit is fine');
  const constants = (await nav.get('/api/meta/constants')).data;
  assert.deepEqual(constants.CLIENTLESS_INTERVENTION_TYPES, ['outreach', 'naloxone_distribution']);
});
