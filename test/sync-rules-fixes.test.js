'use strict';
// The places where sync push and the REST routes disagreed before 1.14.0, one test each, asserting what is
// stored (test/sync-rules.test.js compares the outcomes; these check the effect). Each would fail on 1.13.0.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const U = {}; const C = {};
let enc, dec;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ encrypt: enc, decrypt: dec } = require('../server/crypto'));
  for (const [k, role] of [['nav', 'navigator'], ['nav2', 'navigator'], ['sup', 'supervisor'], ['clin', 'clinician']]) {
    // The owner rules under test ("its author's, or a manager's") are for a worker without clients:all: from
    // 1.16.0 that is a navigator or clinician the programme holds to their caseload (a per-user deny).
    const u = role === 'supervisor' ? H.makeUser(`fix_${k}`, role) : H.makeCaseloadUser(`fix_${k}`, role); U[k] = u.id;
    C[k] = H.client(); await C[k].login(u.username, u.password);
  }
});
after(async () => { await H.stop(); });

function client(...owners) {
  const id = randomUUID();
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by) VALUES(?,?,?,?,?,?,?)`, id, 'F-' + id.slice(0, 8), enc('Fix'), enc('Case'), 'active', day(-30), U[owners[0]]);
  for (const o of owners) H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), id, U[o], 'primary', day(-30), U.sup);
  return id;
}
async function push(as, body, skewMs = 0) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(Date.now() + skewMs), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const later = (ms = 5000) => ({ updated_at: iso(Date.now() + ms) });

test('a device edit that wins last-write-wins cannot lift a legal hold, delete or un-merge a client', async () => {
  const id = client('nav');
  H.db.run(`UPDATE clients SET legal_hold=1, legal_hold_reason_enc=?, updated_at=? WHERE id=?`, enc('Counsel: matter 42'), iso(Date.now() - 60000), id);
  const r = await push('nav', { tables: { clients: [{ id, client_code: 'F-x', first_name_enc: 'Fix', last_name_enc: 'Case', status: 'active', city: 'Weaverville', legal_hold: 0, legal_hold_reason_enc: null, deleted_at: iso(), ...later() }] } });
  assert.deepEqual(r.rejected, []);
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, id);
  assert.equal(row.city, 'Weaverville', 'the edit itself lands');
  assert.equal(row.legal_hold, 1, 'the hold stands: lifting one is clients:legal-hold');
  assert.equal(dec(row.legal_hold_reason_enc), 'Counsel: matter 42');
  assert.equal(row.deleted_at, null, 'removing a client is clients:all');
  // A new client from the field cannot arrive already on hold either.
  const nid = randomUUID();
  await push('nav', { tables: { clients: [{ id: nid, client_code: 'F-new', first_name_enc: 'New', last_name_enc: 'Hold', status: 'active', legal_hold: 1, ...later() }] } });
  assert.equal(H.db.one(`SELECT legal_hold FROM clients WHERE id=?`, nid).legal_hold, 0);
});

test('an addendum made offline to a signed note marks the note amended, as the REST route does', async () => {
  const cid = client('nav');
  const nid = randomUUID();
  H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,signed_at,signed_by) VALUES(?,?,?,?,?,?,?,?,?)`, nid, cid, U.nav, 'admin', enc('Body'), iso(), 'signed', iso(), U.nav);
  const r = await push('nav', { tables: { note_addenda: [{ id: randomUUID(), note_id: nid, author_id: U.nav, content_enc: 'Correction', ...later() }] } });
  assert.deepEqual(r.rejected, []);
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, nid).status, 'amended');
});

test('a signed note keeps everything as signed; only its author signs, and only the author edits a draft', async () => {
  const cid = client('nav', 'nav2');
  const nid = randomUUID();
  H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,occurred_at,status,signed_at,signed_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, nid, cid, U.nav, 'admin', 'narrative', enc('As signed'), enc('Body'), '2026-01-01T10:00:00.000Z', 'signed', iso(), U.nav);
  await push('nav', { tables: { notes: [{ id: nid, client_id: cid, author_id: U.nav, kind: 'admin', format: 'handoff', title_enc: 'Rewritten', content_enc: 'Body', occurred_at: '2025-01-01T10:00:00.000Z', status: 'signed', cosign_requested: 1, ...later() }] } });
  const n = H.db.one(`SELECT * FROM notes WHERE id=?`, nid);
  assert.equal(dec(n.title_enc), 'As signed'); assert.equal(n.format, 'narrative'); assert.equal(n.occurred_at, '2026-01-01T10:00:00.000Z');
  assert.equal(n.cosign_requested, 1, 'asking a supervisor to review a signed note is still allowed');
  // A note arriving signed by someone other than its author is refused.
  const other = randomUUID();
  const r = await push('nav', { tables: { notes: [{ id: other, client_id: cid, author_id: U.nav, kind: 'admin', content_enc: 'x', occurred_at: iso(), status: 'signed', signed_at: iso(), signed_by: U.nav2, ...later() }] } });
  assert.match(r.rejected.find(x => x.id === other).reason, /only the author can sign/);
  // Another worker's draft is theirs.
  const draft = randomUUID();
  H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status) VALUES(?,?,?,?,?,?,?)`, draft, cid, U.nav2, 'admin', enc('Theirs'), iso(Date.now() - 60000), 'draft');
  const r2 = await push('nav', { tables: { notes: [{ id: draft, client_id: cid, author_id: U.nav2, kind: 'admin', content_enc: 'Mine now', occurred_at: iso(), status: 'draft', ...later() }] } });
  assert.equal(r2.rejected[0].reason, 'not permitted');
  assert.equal(dec(H.db.one(`SELECT content_enc FROM notes WHERE id=?`, draft).content_enc), 'Theirs');
});

test('a discharge made offline brings the care team and the client\'s to-dos with it, whoever held them', async () => {
  const cid = client('nav', 'nav2');
  const ep = randomUUID(); H.db.run(`INSERT INTO episodes(id,client_id,opened_at,status) VALUES(?,?,?,?)`, ep, cid, day(-20), 'open');
  const theirTask = randomUUID(); H.db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,status,updated_at) VALUES(?,?,?,?,?,?,?)`, theirTask, cid, U.nav2, U.nav2, enc('Their call'), 'open', iso(Date.now() - 60000));
  const theirs = H.db.one(`SELECT * FROM assignments WHERE client_id=? AND user_id=?`, cid, U.nav2);
  const r = await push('nav', { tables: {
    clients: [{ id: cid, client_code: 'F-d', first_name_enc: 'Fix', last_name_enc: 'Case', status: 'closed', discharge_date: day(0), discharge_reason: 'completed', ...later() }],
    assignments: [{ ...theirs, end_date: day(0), notes_enc: null, ...later() }],
    episodes: [{ id: ep, client_id: cid, opened_at: day(-20), status: 'closed', closed_at: day(0), discharge_reason: 'completed', ...later() }],
    tasks: [{ id: theirTask, client_id: cid, assigned_to: U.nav2, created_by: U.nav2, title_enc: 'Their call', status: 'cancelled', ...later() }],
  } });
  assert.deepEqual(r.rejected, [], 'none of the discharge is refused');
  assert.deepEqual(r.warnings, [], 'and none of it flagged: the episode it closes is in the same push');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, theirTask).status, 'cancelled');
  assert.equal(H.db.one(`SELECT end_date FROM assignments WHERE id=?`, theirs.id).end_date, day(0));
  // Retitling someone else's to-do is not part of any discharge.
  const r2 = await push('nav', { tables: { tasks: [{ id: theirTask, client_id: cid, assigned_to: U.nav2, created_by: U.nav2, title_enc: 'Mine now', status: 'cancelled', ...later(9000) }] } });
  assert.equal(r2.rejected[0].reason, 'not permitted');
});

test('another worker\'s referral: its outcome may be recorded by sync, as over REST, but not its details', async () => {
  const cid = client('nav', 'nav2');
  const res = randomUUID(); H.db.run(`INSERT INTO resources(id,name,category) VALUES(?,?,?)`, res, 'Detox', 'residential');
  const at = iso();
  const ref = randomUUID(); H.db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status,updated_at) VALUES(?,?,?,?,?,?,?)`, ref, cid, res, U.nav2, at, 'pending', iso(Date.now() - 60000));
  const base = { id: ref, client_id: cid, resource_id: res, user_id: U.nav2, referred_at: at, status: 'pending' };
  const r = await push('nav', { tables: { referrals: [{ ...base, status: 'declined_by_client', outcome_enc: 'Changed their mind', closed_at: iso(), ...later() }] } });
  assert.deepEqual(r.rejected, []);
  assert.equal(H.db.one(`SELECT status FROM referrals WHERE id=?`, ref).status, 'declined_by_client');
  const r2 = await push('nav', { tables: { referrals: [{ ...base, status: 'declined_by_client', urgency: 'emergent', ...later(9000) }] } });
  assert.equal(r2.rejected[0].reason, 'not permitted');
});

test('money: an approved expenditure is not rewritten by its submitter; an approver\'s ruling made offline lands', async () => {
  const fund = randomUUID(); H.db.run(`INSERT INTO funding_sources(id,name,fiscal_year_start,fiscal_year_end,total_amount) VALUES(?,?,?,?,?)`, fund, 'F', day(-100), day(100), 1000);
  const e = randomUUID(); H.db.run(`INSERT INTO expenditures(id,funding_source_id,user_id,spent_at,amount,category,status,approved_by,approved_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, e, fund, U.nav, day(-1), 20, 'supplies', 'approved', U.sup, iso(), iso(Date.now() - 60000));
  const row = { id: e, funding_source_id: fund, user_id: U.nav, spent_at: day(-1), category: 'supplies', status: 'approved' };
  const r = await push('nav', { tables: { expenditures: [{ ...row, amount: 2000, ...later() }] } });
  assert.equal(r.rejected[0].reason, 'not permitted');
  assert.equal(H.db.one(`SELECT amount FROM expenditures WHERE id=?`, e).amount, 20);
  const r2 = await push('sup', { tables: { expenditures: [{ ...row, amount: 20, status: 'reimbursed', ...later(9000) }] } });
  assert.deepEqual(r2.rejected, []);
  assert.equal(H.db.one(`SELECT status FROM expenditures WHERE id=?`, e).status, 'reimbursed');
});

test('a court order is vacated by sync but never rewritten; a §2.22 notice is never rewritten', async () => {
  const cid = client('sup');
  const o = randomUUID();
  const order = { id: o, client_id: cid, order_type: 'noncriminal_2_64', court_enc: 'Superior Court', issued_at: day(-5), purpose_enc: 'Custody', scope_enc: 'Dates', recorded_by: U.sup };
  assert.deepEqual((await push('sup', { tables: { court_orders: [{ ...order, ...later(1000) }] } })).rejected, []);
  const r = await push('sup', { tables: { court_orders: [{ ...order, scope_enc: 'Everything', ...later(5000) }] } });
  assert.equal(r.rejected[0].reason, 'immutable');
  const r2 = await push('sup', { tables: { court_orders: [{ ...order, status: 'vacated', vacated_at: iso(), vacated_reason_enc: 'Appeal granted', ...later(9000) }] } });
  assert.deepEqual(r2.rejected, []);
  const row = H.db.one(`SELECT * FROM court_orders WHERE id=?`, o);
  assert.equal(row.status, 'vacated'); assert.equal(dec(row.scope_enc), 'Dates');
  const n = randomUUID();
  const notice = { id: n, client_id: cid, given_at: day(0), method: 'in_person_paper', acknowledged: 1, given_by: U.sup };
  await push('sup', { tables: { part2_notices: [{ ...notice, ...later(1000) }] } });
  assert.equal((await push('sup', { tables: { part2_notices: [{ ...notice, method: 'mail', ...later(5000) }] } })).rejected[0].reason, 'immutable');
});

test('work recorded offline that the office would now refuse lands flagged: the device is told and the audit trail says so', async () => {
  const cid = client('nav');
  const id = randomUUID();
  const r = await push('nav', { tables: { interventions: [{ id, client_id: cid, user_id: U.nav, type: 'retired_service_code', occurred_at: iso(), ...later() }] } });
  assert.deepEqual(r.rejected, []);
  const w = r.warnings.find(x => x.id === id);
  assert.ok(w && w.flagged, 'the device is told');
  assert.match(w.reason, /^was accepted, but its type is not one of the choices/);
  assert.ok(H.db.one(`SELECT 1 FROM interventions WHERE id=?`, id), 'the visit landed');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='sync.conflict' AND entity_id=?`, id);
  assert.ok(a, 'sync.conflict is audited');
  assert.equal(JSON.parse(a.details).kept, 'device');
  assert.ok(!a.details.includes('retired_service_code'), 'by column and rule only, never the value');
});

test('a disclosure recorded on a device on a basis the office cannot confirm is kept, and flagged', async () => {
  const cid = client('nav');
  const d = randomUUID();
  const r = await push('nav', { tables: { disclosures: [{ id: d, client_id: cid, recipient_enc: 'Somebody', purpose_enc: 'Help', what_enc: 'Name', disclosed_at: iso(), disclosed_by: U.nav, basis: 'consent', source: 'manual', ...later() }] } });
  assert.deepEqual(r.rejected, []);
  assert.ok(H.db.one(`SELECT 1 FROM disclosures WHERE id=?`, d), 'the accounting of what happened is kept');
  assert.match(r.warnings.find(x => x.id === d).reason, /could not confirm the basis/);
});

test('an outcome measure keeps its instrument; an assessment is its assessor\'s or a supervisor\'s', async () => {
  const cid = client('clin', 'nav');
  const clin2 = H.makeCaseloadUser('fix_clin2', 'clinician'); H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date) VALUES(?,?,?,?,?)`, randomUUID(), cid, clin2.id, 'secondary', day(-1));
  const c2 = H.client(); await c2.login(clin2.username, clin2.password);
  const m = randomUUID();
  const row = { id: m, client_id: cid, instrument: 'phq9', administered_at: day(0), administered_by: U.clin, responses_enc: '[0,0,0,0,0,0,0,0,0]', total_score: 0 };
  await push('clin', { tables: { outcome_measures: [{ ...row, ...later(1000) }] } });
  await push('clin', { tables: { outcome_measures: [{ ...row, instrument: 'gad7', responses_enc: '[0,0,0,0,0,0,0,0,0]', ...later(5000) }] } });
  assert.equal(H.db.one(`SELECT instrument FROM outcome_measures WHERE id=?`, m).instrument, 'phq9');
  const r = await c2.post('/api/sync/push', { device_now: iso(), tables: { outcome_measures: [{ ...row, responses_enc: '[1,1,1,1,1,1,1,1,1]', ...later(9000) }] } });
  assert.equal(r.data.rejected[0].reason, 'not permitted');
});

test('patient-rights requests need patient-requests:write by sync, as over REST', () => {
  const SYNC = require('../server/sync-tables');
  assert.equal(SYNC.tables.find(t => t.name === 'patient_requests').writePerm, 'patient-requests:write');
});

test('every synchronised table has its rules, and every rules file is for a synchronised table', () => {
  const SYNC = require('../server/sync-tables');
  const rules = require('../server/rules');
  const synced = SYNC.tables.map(t => t.name).sort();
  assert.deepEqual(rules.declaredTables().slice().sort(), synced);
  for (const name of synced) assert.equal(rules.forTable(name).table, name);
  // A REST shape and the push check are the same object: a field rule added to one is in the other.
  const R = rules.forTable('calls');
  assert.equal(R.shape().direction, R.fields.direction);
});

test('SUPRT-A: a device cannot delete an assessment already in a SPARS file, and the record-management answers are the office\'s', async () => {
  H.db.setSetting('module_suprt', '1');
  const cid = client('nav');
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, cid).client_code;
  const a = randomUUID();
  const r = await push('nav', { tables: { suprt_assessments: [{ id: a, client_id: cid, assessment_type: 'baseline', assessment_date: day(0), status: 'draft', answers_enc: JSON.stringify({ A_client_id: 'SOMEONE-ELSE' }), exported_at: iso(), ...later() }] } });
  assert.deepEqual(r.rejected, []);
  const row = H.db.one(`SELECT * FROM suprt_assessments WHERE id=?`, a);
  assert.equal(JSON.parse(dec(row.answers_enc)).A_client_id, code, 'the client ID in the answers is the record\'s own');
  assert.equal(row.exported_at, null, 'a SPARS export is the office\'s act, not a device\'s');
  H.db.run(`UPDATE suprt_assessments SET exported_at=?, updated_at=? WHERE id=?`, iso(), iso(Date.now() - 60000), a);
  const t = await push('nav', { tombstones: [{ table_name: 'suprt_assessments', id: a, deleted_at: iso(Date.now() + 60000) }] });
  assert.match(t.rejected.find(x => x.id === a).reason, /^not permitted: it was put in a SPARS entry file/);
  assert.ok(H.db.one(`SELECT 1 FROM suprt_assessments WHERE id=?`, a), 'kept');
});

test('supplies: a device\'s stock movement is held to what the supply routes require', async () => {
  const item = randomUUID(); H.db.run(`INSERT INTO supply_items(id,name,category) VALUES(?,?,?)`, item, 'Fix kit', 'naloxone');
  const site = randomUUID(); H.db.run(`INSERT INTO supply_sites(id,name) VALUES(?,?)`, site, 'Fix van');
  const base = { item_id: item, site_id: site, occurred_on: day(0), user_id: U.sup };
  const damagedUp = { id: randomUUID(), ...base, kind: 'adjustment', reason: 'damaged', quantity: 5, ...later() };
  const r = await push('sup', { tables: { supply_ledger: [damagedUp] } });
  assert.match(r.rejected.find(x => x.id === damagedUp.id).reason, /damaged, expired or lost is taken off/);
  H.db.run(`UPDATE supply_sites SET is_active=0 WHERE id=?`, site);
  const received = { id: randomUUID(), ...base, kind: 'received', quantity: 5, source: 'ndp', ...later() };
  const r2 = await push('sup', { tables: { supply_ledger: [received] } });
  assert.deepEqual(r2.rejected, [], 'a delivery to a site retired while the phone was out still happened');
  assert.match(r2.warnings.find(x => x.id === received.id).reason, /no longer in use at the office/);
});
