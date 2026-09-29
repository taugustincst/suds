'use strict';
// Security review of 1.16.1 (r7): the findings fixed in 1.16.2, each at both doors (REST and sync push) where it
// has two. The device side of M3 (a flagged note leaves the navigator's device) is test/counseling-drop-device.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const U = {}; const C = {};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
let enc, dec, sha256;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ encrypt: enc, decrypt: dec, sha256 } = require('../server/crypto'));
  for (const [k, role] of [['navA', 'navigator'], ['navB', 'navigator'], ['clin', 'clinician'], ['sup', 'supervisor'], ['sup2', 'supervisor'], ['fin', 'finance']]) {
    const u = H.makeUser(`s162_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
  H.db.setSetting('module_careplan', '1');
});
after(() => H.stop());

async function push(as, body) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const rejected = (res, id) => res.rejected.some(r => r.id === id);
function mkClient(owner) {
  const id = randomUUID();
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by) VALUES(?,?,?,?,?,?,?)`, id, 'T-' + id.slice(0, 8), enc('Pat'), enc('Sec'), 'active', day(-30), U[owner]);
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), id, U[owner], 'primary', day(-30), U.sup);
  return id;
}
const later = (s = 5) => iso(Date.now() + s * 1000);

// ---- H1: a note's signature and authorship by push ----
test('H1: a manage-others push cannot create a note signed as another clinician', async () => {
  const cid = mkClient('clin');
  const id = randomUUID();
  const res = await push('sup', { tables: { notes: [{ id, client_id: cid, author_id: U.clin, kind: 'clinical', format: 'narrative', content_enc: 'forged', occurred_at: iso(), status: 'signed', signed_by: U.clin, signed_at: iso(), signature_hash: 'x', part2_protected: 1, updated_at: iso() }] } });
  assert.ok(rejected(res, id), JSON.stringify(res));
  assert.equal(H.db.one(`SELECT 1 FROM notes WHERE id=?`, id), undefined);
  // A draft named as someone else's is recorded as the syncing user's, and flagged.
  const d = randomUUID();
  const r2 = await push('sup', { tables: { notes: [{ id: d, client_id: cid, author_id: U.clin, kind: 'clinical', format: 'narrative', content_enc: 'a draft', occurred_at: iso(), status: 'draft', part2_protected: 1, updated_at: iso() }] } });
  assert.ok(!rejected(r2, d), JSON.stringify(r2));
  assert.equal(H.db.one(`SELECT author_id FROM notes WHERE id=?`, d).author_id, U.sup);
  assert.ok(r2.warnings.some(w => w.id === d && /recorded as the work of the account that synced it/.test(w.reason)), JSON.stringify(r2.warnings));
});

test('H1: a manage-others push cannot sign (or rewrite and sign) another author\'s draft', async () => {
  const cid = mkClient('clin');
  const n = await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'clin draft', occurred_at: iso() });
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, n.data.id);
  const res = await push('sup', { tables: { notes: [{ ...row, content_enc: 'rewritten by sup', title_enc: null, structured_enc: null, cosign_note_enc: null, status: 'signed', signed_by: U.clin, signed_at: iso(), signature_hash: 'y', updated_at: later() }] } });
  assert.ok(rejected(res, n.data.id), JSON.stringify(res));
  const now = H.db.one(`SELECT * FROM notes WHERE id=?`, n.data.id);
  assert.equal(now.status, 'draft'); assert.equal(now.signed_by, null); assert.equal(dec(now.content_enc), 'clin draft');
  // Nor as themselves: only the author signs.
  const r2 = await push('sup', { tables: { notes: [{ ...row, content_enc: 'clin draft', title_enc: null, structured_enc: null, cosign_note_enc: null, status: 'signed', signed_by: U.sup, signed_at: iso(), updated_at: later(6) }] } });
  assert.ok(rejected(r2, n.data.id), JSON.stringify(r2));
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, n.data.id).status, 'draft');
});

test('H1: the author\'s own signature by sync lands with the office\'s hash, verifies, and is audited as note.sign', async () => {
  const cid = mkClient('clin');
  const n = await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'signed on a phone', occurred_at: iso() });
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, n.data.id);
  const res = await push('clin', { tables: { notes: [{ ...row, content_enc: 'signed on a phone', title_enc: null, structured_enc: null, cosign_note_enc: null, status: 'signed', signed_by: U.clin, signed_at: iso(), signature_hash: 'device-made-this-up', updated_at: later() }] } });
  assert.deepEqual(res.rejected, []);
  const s = H.db.one(`SELECT * FROM notes WHERE id=?`, n.data.id);
  assert.equal(s.status, 'signed'); assert.equal(s.signed_by, U.clin);
  assert.equal(s.signature_hash, sha256(`${s.id}|${U.clin}|${s.content_enc}|${s.structured_enc || ''}`));
  const v = await C.clin.get(`/api/notes/${n.data.id}/verify`);
  assert.equal(v.data.intact, true, JSON.stringify(v.data));
  const a = H.db.one(`SELECT user_id, details FROM audit_log WHERE action='note.sign' AND entity_id=?`, n.data.id);
  assert.ok(a, 'note.sign audited'); assert.equal(a.user_id, U.clin);
  assert.equal(JSON.parse(a.details).via, 'sync'); assert.equal(JSON.parse(a.details).hash, s.signature_hash);
  // A new note arriving already signed by its author: the same.
  const id = randomUUID();
  const r2 = await push('clin', { tables: { notes: [{ id, client_id: cid, kind: 'clinical', format: 'narrative', content_enc: 'new and signed', occurred_at: iso(), status: 'signed', signed_by: U.clin, signed_at: iso(), signature_hash: 'z', part2_protected: 1, updated_at: iso() }] } });
  assert.deepEqual(r2.rejected, []);
  const s2 = H.db.one(`SELECT * FROM notes WHERE id=?`, id);
  assert.equal(s2.signature_hash, sha256(`${id}|${U.clin}|${s2.content_enc}|${s2.structured_enc || ''}`));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.sign' AND entity_id=?`, id));
});

test('H1: countersignatures and addenda by push keep their own authors', async () => {
  const cid = mkClient('clin');
  const n = await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'to countersign', occurred_at: iso() });
  assert.equal((await C.clin.post(`/api/notes/${n.data.id}/sign`, { confirm: true, password: PW })).status, 200);
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, n.data.id);
  await push('sup', { tables: { notes: [{ ...row, content_enc: 'to countersign', title_enc: null, structured_enc: null, cosign_note_enc: null, cosigned_by: U.sup2, cosigned_at: iso(), cosignature_hash: 'q', updated_at: later() }] } });
  assert.equal(H.db.one(`SELECT cosigned_by FROM notes WHERE id=?`, n.data.id).cosigned_by, null);
  const add = randomUUID();
  const r = await push('sup', { tables: { note_addenda: [{ id: add, note_id: n.data.id, author_id: U.clin, content_enc: 'added', updated_at: iso() }] } });
  assert.deepEqual(r.rejected, []);
  assert.equal(H.db.one(`SELECT author_id FROM note_addenda WHERE id=?`, add).author_id, U.sup);
});

// ---- M1: separation of duties through a visit's or a call's side effects ----
async function fund() {
  const f = await C.sup.post('/api/budget/funds', { name: 'SoD ' + randomUUID().slice(0, 6), source_type: 'other', total_amount: 50000, fiscal_year_start: day(-200), fiscal_year_end: day(100) });
  const l = await C.sup.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'transportation', allocated_amount: 50000 });
  assert.equal(l.status, 201, JSON.stringify(l.data));
  return { f: f.data.id, l: l.data.id };
}
const approveX = (as, id) => C[as].post(`/api/budget/expenditures/${id}/approve`, { status: 'approved' });
const approveT = (as, id) => C[as].post(`/api/time/${id}/approve`, { decision: 'approved' });

test('M1: an approver cannot approve the expenditure their costed visit for another worker created', async () => {
  const { f, l } = await fund(); const cid = mkClient('navB');
  const v = await C.sup.post('/api/interventions', { client_id: cid, user_id: U.navB, type: 'transport', occurred_at: iso(), duration_minutes: 30, cost: 900, funding_source_id: f, budget_line_id: l });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  const x = H.db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, v.data.id);
  assert.equal(x.user_id, U.navB);
  assert.equal((await approveX('sup', x.id)).status, 403);
  assert.equal((await approveX('fin', x.id)).status, 200, 'another approver still can');
});

test('M1: an approver cannot approve the expenditure they caused by adding a cost to another worker\'s visit', async () => {
  const { f, l } = await fund(); const cid = mkClient('navB');
  const v = await C.navB.post('/api/interventions', { client_id: cid, type: 'transport', occurred_at: iso(), duration_minutes: 30 });
  const put = await C.sup.put(`/api/interventions/${v.data.id}`, { cost: 4000, funding_source_id: f, budget_line_id: l });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const x = H.db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, v.data.id);
  assert.equal((await approveX('sup', x.id)).status, 403);
  // Nor one whose amount they changed through the visit.
  const { f: f2, l: l2 } = await fund();
  const v2 = await C.sup.post('/api/interventions', { client_id: cid, user_id: U.navB, type: 'transport', occurred_at: iso(), cost: 10, funding_source_id: f2, budget_line_id: l2 });
  const x2 = H.db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, v2.data.id);
  assert.equal((await C.sup2.put(`/api/interventions/${v2.data.id}`, { cost: 2500 })).status, 200);
  assert.equal((await approveX('sup2', x2.id)).status, 403);
});

test('M1: an approver cannot approve time their visit or call for another worker logged, or time they submitted for them', async () => {
  const cid = mkClient('navB');
  const v = await C.sup.post('/api/interventions', { client_id: cid, user_id: U.navB, type: 'transport', occurred_at: iso(), duration_minutes: 600, log_time: true });
  const te = H.db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, v.data.id);
  assert.equal(te.user_id, U.navB);
  assert.equal((await C.navB.post(`/api/time/${te.id}/submit`, {})).status, 200);
  assert.equal((await approveT('sup', te.id)).status, 403, 'the visit logged it');
  // A call logged as navB.
  const call = await C.sup.post('/api/calls', { user_id: U.navB, client_id: cid, direction: 'outbound', method: 'phone', started_at: iso(), duration_minutes: 45, log_time: true });
  assert.equal(call.status, 201, JSON.stringify(call.data));
  const tc = H.db.one(`SELECT * FROM time_entries WHERE call_id=?`, call.data.id);
  assert.equal(tc.user_id, U.navB);
  assert.equal((await C.navB.post(`/api/time/${tc.id}/submit`, {})).status, 200);
  assert.equal((await approveT('sup', tc.id)).status, 403, 'the call logged it');
  // navB's own visit time, submitted by sup (time:all).
  const v2 = await C.navB.post('/api/interventions', { client_id: cid, type: 'transport', occurred_at: iso(), duration_minutes: 30, log_time: true });
  const t2 = H.db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, v2.data.id);
  assert.equal((await C.sup.post(`/api/time/${t2.id}/submit`, {})).status, 200);
  assert.equal((await approveT('sup', t2.id)).status, 403, 'they submitted it');
  assert.equal((await approveT('sup2', t2.id)).status, 200, 'another approver still can');
});

test('M1: an approver cannot approve time they resized by editing the visit', async () => {
  const cid = mkClient('navB');
  const v = await C.navB.post('/api/interventions', { client_id: cid, type: 'transport', occurred_at: iso(), duration_minutes: 30, log_time: true });
  const te = H.db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, v.data.id);
  assert.equal((await C.navB.post(`/api/time/${te.id}/submit`, {})).status, 200);
  assert.equal((await C.sup.put(`/api/interventions/${v.data.id}`, { duration_minutes: 720 })).status, 200);
  assert.equal(H.db.one(`SELECT minutes FROM time_entries WHERE id=?`, te.id).minutes, 720);
  assert.equal((await approveT('sup', te.id)).status, 403);
});

test('M1: the same holds for what an approver\'s device sends', async () => {
  const { f, l } = await fund(); const cid = mkClient('navB');
  // The device's visit for navB and the expenditure and time its kernel recorded with it.
  const visit = randomUUID(); const x = randomUUID(); const t = randomUUID();
  const res = await push('sup', { tables: {
    interventions: [{ id: visit, client_id: cid, user_id: U.navB, type: 'transport', occurred_at: iso(), duration_minutes: 60, cost: 50, funding_source_id: f, budget_line_id: l, updated_at: iso() }],
    expenditures: [{ id: x, funding_source_id: f, budget_line_id: l, client_id: cid, user_id: U.navB, intervention_id: visit, spent_at: day(), amount: 50, category: 'transportation', status: 'pending', updated_at: iso() }],
    time_entries: [{ id: t, user_id: U.navB, client_id: cid, work_date: day(), minutes: 60, category: 'direct_service', intervention_id: visit, status: 'draft', updated_at: iso() }],
  } });
  assert.deepEqual(res.rejected, []);
  assert.equal((await approveX('sup', x)).status, 403);
  // The device submits navB's time, then another device resizes it.
  const row = H.db.one(`SELECT * FROM time_entries WHERE id=?`, t);
  await push('sup2', { tables: { time_entries: [{ ...row, description_enc: null, approval_note_enc: null, status: 'submitted', updated_at: later() }] } });
  assert.equal(H.db.one(`SELECT status FROM time_entries WHERE id=?`, t).status, 'submitted');
  assert.equal((await approveT('sup2', t)).status, 403, 'submitted it by sync');
  const row2 = H.db.one(`SELECT * FROM time_entries WHERE id=?`, t);
  const fin2 = H.makeUser('s162_sup3', 'supervisor'); const c3 = H.client(); await c3.login(fin2.username, PW);
  const r3 = await c3.post('/api/sync/push', { device_now: iso(), tables: { time_entries: [{ ...row2, description_enc: null, approval_note_enc: null, minutes: 600, updated_at: later(10) }] } });
  assert.deepEqual(r3.data.rejected, []);
  assert.equal((await c3.post(`/api/time/${t}/approve`, { decision: 'approved' })).status, 403, 'resized it by sync');
});

// ---- M2: the change notice cannot be silenced by the editor it reports on ----
const notice = (cid, to) => H.db.all(`SELECT * FROM tasks WHERE client_id=? AND assigned_to=?`, cid, to).find(t => dec(t.description_enc || '').includes('Reference: client record change'));

test('M2: the editor cannot close or delete the change notice about their edit, at either door', async () => {
  const cid = mkClient('navB');
  const cur = await C.navA.get(`/api/clients/${cid}`);
  assert.equal((await C.navA.put(`/api/clients/${cid}`, { phone: '916-555-0123', updated_at: cur.data.updated_at || cur.data.client?.updated_at })).status, 200);
  const t = notice(cid, U.navB);
  assert.ok(t, 'a notice for the primary worker');
  assert.equal(t.created_by, U.navB, 'the primary worker\'s own, not the editor\'s');
  assert.ok(!dec(t.description_enc).includes(U.navA), 'no user id in its text');
  assert.equal((await C.navA.put(`/api/tasks/${t.id}`, { status: 'done' })).status, 403);
  assert.equal((await C.navA.put(`/api/tasks/${t.id}`, { title: 'Routine follow-up' })).status, 403, 'nor retitle it');
  assert.equal((await C.navA.del(`/api/tasks/${t.id}`)).status, 403);
  const row = H.db.one(`SELECT * FROM tasks WHERE id=?`, t.id);
  const res = await push('navA', { tables: { tasks: [{ ...row, title_enc: dec(row.title_enc), description_enc: dec(row.description_enc), status: 'done', completed_at: iso(), updated_at: later() }] } });
  assert.ok(rejected(res, t.id), JSON.stringify(res));
  const del = await push('navA', { tables: {}, tombstones: [{ table_name: 'tasks', id: t.id, deleted_at: later(6) }] });
  assert.ok(rejected(del, t.id), JSON.stringify(del));
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, t.id).status, 'open');
  // A second edit the same day is added to the same notice (found through the audit trail).
  const cur2 = await C.navA.get(`/api/clients/${cid}`);
  assert.equal((await C.navA.put(`/api/clients/${cid}`, { city: 'Fresno', updated_at: cur2.data.updated_at || cur2.data.client?.updated_at })).status, 200);
  assert.equal(H.db.all(`SELECT id FROM tasks WHERE client_id=? AND assigned_to=?`, cid, U.navB).length, 1);
  assert.match(dec(H.db.one(`SELECT title_enc FROM tasks WHERE id=?`, t.id).title_enc), /Phone, City/);
  // The primary worker closes it.
  assert.equal((await C.navB.put(`/api/tasks/${t.id}`, { status: 'done' })).status, 200);
});

// 1.16.4 (security review of 1.16.3, N5): the 1.16.1 rule is gone, so such a to-do, even with an audit entry of an edit
// of that client, is an ordinary to-do: its creator and a manager may change it, as any other.
test('M2: a to-do in the 1.16.1 notice form (recorded as the editor\'s) is an ordinary to-do from 1.16.4', async () => {
  const cid = mkClient('navB');
  const id = randomUUID();
  H.db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority) VALUES(?,?,?,?,?,?,?,?)`, id, cid, U.navB, U.navA,
    enc('s162_navA changed a record (phone)'), enc(`Changed: phone\nYou are this client's primary worker; open their record to see what changed.\nReference: client record change by ${U.navA}`), iso(), 'normal');
  // ... with the audit entry 1.16.1 wrote for the edit it reports (1.16.3: a notice is known by it, not by its text).
  require('../server/audit').log({ user: { id: U.navA, username: 's162_navA' }, action: 'client.change_notice', entity: 'client', entityId: cid, clientId: cid, details: { notified: U.navB, fields: ['phone'] } });
  assert.equal((await C.sup.put(`/api/tasks/${id}`, { status: 'done' })).status, 200, 'records:manage-others may');
  assert.equal((await C.navA.put(`/api/tasks/${id}`, { status: 'cancelled' })).status, 200, 'and so may its creator');
});

test('M7 (UX): the client\'s note count leaves out counseling notes the reader cannot read', async () => {
  const cid = mkClient('clin');
  for (const counseling of [false, true]) assert.equal((await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'n', occurred_at: iso(), counseling_note: counseling })).status, 201);
  const count = async (as) => { const d = (await C[as].get(`/api/clients/${cid}`)).data; return (d.client || d).counts.notes; };
  assert.equal(await count('clin'), 2);
  assert.equal(await count('navA'), 1, 'as the Notes list shows it');
});

// ---- M3: a note flagged as a counseling note after a navigator's device pulled it ----
test('M3: the next pull tells the navigator\'s device to drop a note (and its addenda) once it is a counseling note', async () => {
  const cid = mkClient('clin');
  const p0 = (await C.navA.get('/api/sync/pull')).data;
  const n = await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'clinical draft', occurred_at: iso() });
  const add = await C.clin.post(`/api/notes/${n.data.id}/addenda`, { content: 'an addendum' });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const p1 = (await C.navA.get(`/api/sync/pull?since=${encodeURIComponent(p0.cursor)}&scope=${encodeURIComponent(p0.scope)}`)).data;
  assert.ok(p1.tables.notes.some(r => r.id === n.data.id), 'the device has the draft');
  const u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, n.data.id).updated_at;
  assert.equal((await C.clin.put(`/api/notes/${n.data.id}`, { counseling_note: true, if_updated_at: u })).status, 200);
  const p2 = (await C.navA.get(`/api/sync/pull?since=${encodeURIComponent(p1.cursor)}&scope=${encodeURIComponent(p1.scope)}`)).data;
  assert.ok(!p2.tables.notes.some(r => r.id === n.data.id));
  const dropped = p2.dropped_rows.map(([t, id]) => `${t}:${id}`);
  assert.ok(dropped.includes(`notes:${n.data.id}`), JSON.stringify(p2.dropped_rows));
  assert.ok(dropped.includes(`note_addenda:${add.data.id}`));
  assert.ok(dropped.indexOf(`note_addenda:${add.data.id}`) < dropped.indexOf(`notes:${n.data.id}`), 'children first');
  // The clinician's own device keeps it.
  const c = (await C.clin.get(`/api/sync/pull?since=${encodeURIComponent(p1.cursor)}`)).data;
  assert.ok(c.tables.notes.some(r => r.id === n.data.id)); assert.ok(!c.dropped_rows.some(([, id]) => id === n.data.id));
});

// ---- Lows ----
test('L1: a supply line is recorded as its visit\'s worker, whoever the device names', async () => {
  const cid = mkClient('navA');
  const it = await C.sup.post('/api/supplies/items', { name: 'L1 wound care kit' });
  assert.equal(it.status, 201, JSON.stringify(it.data));
  const item = { id: it.data.id };
  const v = await C.navA.post('/api/interventions', { client_id: cid, type: 'outreach', occurred_at: iso() });
  const line = randomUUID();
  const res = await push('navA', { tables: { intervention_supplies: [{ id: line, intervention_id: v.data.id, client_id: cid, user_id: U.sup, item_id: item.id, quantity: 1, updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  assert.equal(H.db.one(`SELECT user_id FROM intervention_supplies WHERE id=?`, line).user_id, U.navA);
});

test('L2: the care plan does not count counseling notes its reader cannot read', async () => {
  const cid = mkClient('clin');
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, randomUUID(), cid, U.navA, 'secondary', day(-30), U.sup);
  const p = await C.clin.post(`/api/clients/${cid}/problems`, { problem: 'Opioid use disorder' });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  for (const counseling of [false, true]) assert.equal((await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'n', occurred_at: iso(), problem_ids: [p.data.id], counseling_note: counseling })).status, 201);
  const count = async (as) => (await C[as].get(`/api/clients/${cid}/problems`)).data.rows.find(r => r.id === p.data.id).notes;
  assert.equal(await count('clin'), 2);
  assert.equal(await count('navA'), 1);
});
