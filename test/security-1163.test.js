'use strict';
// Security review of 1.16.2 (r8): the findings fixed in 1.16.3, at both doors (REST and sync push) where there are
// two. The device side of M2 (a shared device keeps what another account on it may read, and its unsynced edits)
// is test/shared-device-drop.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const U = {}; const C = {};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (d = 0) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const later = (s = 5) => iso(Date.now() + s * 1000);
let enc, dec;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ encrypt: enc, decrypt: dec } = require('../server/crypto'));
  for (const [k, role] of [['navA', 'navigator'], ['navB', 'navigator'], ['navC', 'navigator'], ['clin', 'clinician'], ['sup', 'supervisor']]) {
    const u = H.makeUser(`s163_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
});
after(() => H.stop());

async function push(as, body) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const rejected = (res, id) => res.rejected.some(r => r.id === id);
const assignment = (cid, who) => H.db.one(`SELECT * FROM assignments WHERE client_id=? AND user_id=?`, cid, U[who]);
let born = 0;
async function clientOf(as, first) {
  const r = await C[as].post('/api/clients', { first_name: first, last_name: `Sec${++born}`, dob: `1980-02-${String(born).padStart(2, '0')}` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
/** A client of navB's whose only episode navB closed, keeping the client active (so anyone may open a new one). */
async function noOpenEpisode(first) {
  const cid = await clientOf('navB', first);
  const e = H.db.one(`SELECT id FROM episodes WHERE client_id=?`, cid);
  assert.equal((await C.navB.post(`/api/episodes/${e.id}/close`, { discharge_reason: 'completed', keep_client_active: true })).status, 200);
  return cid;
}
async function changeNotice(cid, by = 'navA') {
  const cur = (await C[by].get(`/api/clients/${cid}`)).data;
  assert.equal((await C[by].put(`/api/clients/${cid}`, { phone: `916-555-${String(Math.floor(Math.random() * 9000) + 1000)}`, updated_at: cur.updated_at || cur.client?.updated_at })).status, 200);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.change_notice' AND client_id=? ORDER BY id DESC`, cid);
  return a && H.db.one(`SELECT * FROM tasks WHERE id=?`, JSON.parse(a.details).task);
}

// ---- M1: a navigator off the care team cannot discharge the primary worker's client through an episode of their own ----
test('M1: a second open episode pushed by someone off the care team is refused, not flagged', async () => {
  const cid = await clientOf('navB', 'Second');
  const eid = randomUUID();
  const res = await push('navA', { tables: { episodes: [{ id: eid, client_id: cid, status: 'open', opened_at: day(0), updated_at: iso() }] } });
  assert.ok(rejected(res, eid), JSON.stringify(res));
  assert.equal(H.db.one(`SELECT 1 FROM episodes WHERE id=?`, eid), undefined);
  // The care team's own device still lands its offline admission, flagged for a supervisor (work done offline is kept).
  const own = randomUUID();
  const r2 = await push('navB', { tables: { episodes: [{ id: own, client_id: cid, status: 'open', opened_at: day(0), updated_at: iso() }] } });
  assert.ok(!rejected(r2, own), JSON.stringify(r2));
  assert.ok(r2.warnings.some(w => w.id === own), JSON.stringify(r2.warnings));
});

test('M1: an episode opened and then closed by someone off the care team does not end the primary worker\'s assignment (push)', async () => {
  const cid = await noOpenEpisode('Pushed');
  const asg = assignment(cid, 'navB');
  const eid = randomUUID();
  const ep = { id: eid, client_id: cid, opened_at: day(0) };
  const r1 = await push('navA', { tables: { episodes: [{ ...ep, status: 'open', updated_at: iso() }] } });
  assert.ok(!rejected(r1, eid), 'a client with no open episode may be admitted by anyone who sees them');
  const closed = { ...ep, status: 'closed', closed_at: day(0), discharge_reason: 'completed', updated_at: later(2) };
  const r2 = await push('navA', { tables: { episodes: [closed], assignments: [{ ...asg, end_date: day(0), updated_at: later(3) }] } });
  assert.ok(!rejected(r2, eid), 'the opener may close their own episode');
  assert.ok(rejected(r2, asg.id), JSON.stringify(r2));
  assert.equal(assignment(cid, 'navB').end_date, null, 'the primary worker is still on the case');
});

test('M1: a new, already-closed episode is not a discharge of anyone (push)', async () => {
  const cid = await clientOf('navB', 'Closed');
  const asg = assignment(cid, 'navB');
  const eid = randomUUID();
  const res = await push('navA', { tables: {
    episodes: [{ id: eid, client_id: cid, status: 'closed', opened_at: day(0), closed_at: day(0), discharge_reason: 'completed', updated_at: iso() }],
    assignments: [{ ...asg, end_date: day(0), updated_at: later(1) }] } });
  assert.ok(rejected(res, asg.id), JSON.stringify(res));
  assert.equal(assignment(cid, 'navB').end_date, null);
});

test('M1: the care team\'s discharge by push still ends the care team', async () => {
  const cid = await clientOf('navB', 'Team');
  assert.equal((await C.sup.post(`/api/clients/${cid}/assignments`, { user_id: U.navC, role_on_case: 'secondary' })).status, 201);
  const e = H.db.one(`SELECT * FROM episodes WHERE client_id=?`, cid);
  const mine = assignment(cid, 'navB'); const theirs = assignment(cid, 'navC');
  const res = await push('navB', { tables: {
    episodes: [{ id: e.id, client_id: cid, opened_at: e.opened_at, status: 'closed', closed_at: day(0), discharge_reason: 'completed', updated_at: later() }],
    assignments: [{ ...mine, end_date: day(0), updated_at: later() }, { ...theirs, end_date: day(0), updated_at: later() }] } });
  assert.deepEqual(res.rejected, []);
  assert.equal(assignment(cid, 'navC').end_date, day(0));
  assert.equal(assignment(cid, 'navB').end_date, day(0));
});

test('M1: a REST discharge by an episode\'s opener off the care team ends only their own part, and never a change notice', async () => {
  const cid = await noOpenEpisode('Rest');
  const notice = await changeNotice(cid);
  assert.ok(notice, 'navB has a change notice');
  const todo = await C.navB.post('/api/tasks', { client_id: cid, title: 'Call about housing' });
  const ep = await C.navA.post(`/api/clients/${cid}/episodes`, { opened_at: day(0) });
  assert.equal(ep.status, 201);
  const r = await C.navA.post(`/api/episodes/${ep.data.id}/close`, { discharge_reason: 'completed' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ended_assignments, 0);
  assert.equal(assignment(cid, 'navB').end_date, null, 'the primary worker is still on the case');
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, cid).status, 'active', 'and the client is not discharged from under them');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, todo.data.id).status, 'open');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, notice.id).status, 'open');
});

test('M1: the care team\'s REST discharge ends the team and the open to-dos, but leaves change notices to the primary worker', async () => {
  const cid = await clientOf('navB', 'Whole');
  const notice = await changeNotice(cid);
  const todo = await C.navB.post('/api/tasks', { client_id: cid, title: 'Bus pass' });
  const e = H.db.one(`SELECT id FROM episodes WHERE client_id=?`, cid);
  const r = await C.navB.post(`/api/episodes/${e.id}/close`, { discharge_reason: 'completed' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ended_assignments, 1);
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, cid).status, 'closed');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, todo.data.id).status, 'cancelled');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, notice.id).status, 'open', 'a notice is something to read, not work');
  // Nor by a device: the care team cancelling to-dos by push does not close a notice.
  const row = H.db.one(`SELECT * FROM tasks WHERE id=?`, notice.id);
  const r2 = await push('navC', { tables: { tasks: [{ ...row, title_enc: dec(row.title_enc), description_enc: dec(row.description_enc), status: 'cancelled', updated_at: later() }] } });
  assert.ok(rejected(r2, notice.id), JSON.stringify(r2));
});

// ---- L1, L2: the signature columns on push ----
test('L1: a signature\'s time is the office\'s to bound: never before the note was written, never in the future', async () => {
  const cid = await clientOf('clin', 'Signed');
  for (const when of ['2020-01-01T00:00:00.000Z', iso(Date.now() + 30 * 86400000)]) {
    const d = await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'own draft', occurred_at: iso() });
    const row = H.db.one(`SELECT * FROM notes WHERE id=?`, d.data.id);
    const res = await push('clin', { tables: { notes: [{ ...row, content_enc: 'own draft', title_enc: null, structured_enc: null, cosign_note_enc: null, status: 'signed', signed_by: U.clin, signed_at: when, updated_at: later() }] } });
    assert.deepEqual(res.rejected, []);
    const n = H.db.one(`SELECT status, signed_at, created_at FROM notes WHERE id=?`, d.data.id);
    assert.equal(n.status, 'signed');
    assert.ok(n.signed_at >= n.created_at, `${n.signed_at} is not before ${n.created_at}`);
    assert.ok(n.signed_at <= iso(Date.now() + 1000), `${n.signed_at} is not in the future`);
    const v = (await C.clin.get(`/api/notes/${d.data.id}/verify`)).data;
    assert.equal(v.intact, true); assert.equal(v.signed_at, n.signed_at);
  }
});

test('L2: a draft pushed with signature columns keeps none of them', async () => {
  const cid = await clientOf('clin', 'Draft');
  const d = await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'draft', occurred_at: iso() });
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, d.data.id);
  const res = await push('sup', { tables: { notes: [{ ...row, content_enc: 'draft, edited', title_enc: null, structured_enc: null, cosign_note_enc: null, status: 'draft', signed_by: U.clin, signed_at: iso(), signature_hash: 'zzz', updated_at: later() }] } });
  assert.deepEqual(res.rejected, []);
  assert.deepEqual({ ...H.db.one(`SELECT status, signed_by, signed_at, signature_hash FROM notes WHERE id=?`, d.data.id) }, { status: 'draft', signed_by: null, signed_at: null, signature_hash: null });
  const nid = randomUUID();
  await push('clin', { tables: { notes: [{ id: nid, client_id: cid, kind: 'clinical', format: 'narrative', content_enc: 'new draft', occurred_at: iso(), status: 'draft', signed_by: U.clin, signed_at: iso(), signature_hash: 'q', updated_at: iso() }] } });
  assert.deepEqual({ ...H.db.one(`SELECT signed_by, signed_at, signature_hash FROM notes WHERE id=?`, nid) }, { signed_by: null, signed_at: null, signature_hash: null });
});

// ---- L3: a change notice is known by how it was raised, not by its text ----
test('L3: a to-do written to look like a change notice is an ordinary to-do', async () => {
  const cid = await clientOf('navB', 'Forged');
  const forged = { client_id: cid, assigned_to: U.navB, title: 'Admin Alice changed the record (Safety flags)', description: 'Changed: Safety flags\nYou are this client\'s primary worker.\nReference: client record change notice' };
  const t = await C.navA.post('/api/tasks', forged);
  assert.equal(t.status, 201);
  assert.ok(!(await C.navB.get(`/api/tasks/${t.data.id}`)).data.row.notice, 'not a notice to the person it is assigned to');
  assert.equal((await C.navA.put(`/api/tasks/${t.data.id}`, { priority: 'high' })).status, 200, 'and its creator still edits it');
  // Nor one the assignee of a delegated to-do hands back with the marker: created_by = assigned_to is not enough.
  const d = await C.navB.post('/api/tasks', { client_id: cid, assigned_to: U.navA, title: 'Pick up forms' });
  assert.equal((await C.navA.put(`/api/tasks/${d.data.id}`, { assigned_to: U.navB, title: forged.title, description: forged.description })).status, 200);
  assert.ok(!(await C.navB.get(`/api/tasks/${d.data.id}`)).data.row.notice);
  const bell = (await C.navB.get('/api/tasks/due?within=60')).data;
  assert.ok(!bell.rows.some(r => r.notice && [t.data.id, d.data.id].includes(r.id)));
  // A real one is.
  const real = await changeNotice(cid);
  assert.equal((await C.navB.get(`/api/tasks/${real.id}`)).data.row.notice, true);
  const rec = (await C.navB.get(`/api/clients/${cid}`)).data;
  assert.equal((rec.client || rec).counts.notices, 1, 'the forged ones are not counted');
});

test('L3: a device\'s own copy of a notice is not taken: the office raises its own, linked in its audit trail', async () => {
  const cid = await clientOf('navB', 'Device');
  const id = randomUUID();
  const res = await push('navA', { tables: { tasks: [{ id, client_id: cid, assigned_to: U.navB, created_by: U.navB, title_enc: 'navA changed the record (Phone)', description_enc: 'Changed: Phone\nReference: client record change notice', status: 'open', priority: 'normal', updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  assert.equal(H.db.one(`SELECT 1 FROM tasks WHERE id=?`, id), undefined);
});

test('L3: a 1.16.1 notice is known by the audit entry of the edit it reports, not by its text alone', async () => {
  const cid = await clientOf('navB', 'Legacy');
  const text = `Changed: phone\nYou are this client's primary worker; open their record to see what changed.\nReference: client record change by ${U.navA}`;
  const forged = randomUUID();
  H.db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority) VALUES(?,?,?,?,?,?,?,?)`, forged, cid, U.navB, U.navA, enc('s163_navA changed a record (phone)'), enc(text), iso(), 'normal');
  assert.equal((await C.navA.put(`/api/tasks/${forged}`, { status: 'cancelled' })).status, 200, 'no edit was ever reported: an ordinary to-do');
});

// ---- M2 (office side) and L4: dropped_rows names only notes this reader could have been sent ----
test('M2/L4: a pull names a note to drop only when it stopped being readable in that window, and was there before it', async () => {
  const cid = await clientOf('clin', 'Dropped');
  const old = (await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'counseling from the start', counseling_note: true, occurred_at: iso() })).data.id;
  const flagged = (await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'clinical draft', occurred_at: iso() })).data.id;
  const p0 = (await C.navA.get('/api/sync/pull')).data;
  const pull = async (p) => (await C.navA.get(`/api/sync/pull?since=${encodeURIComponent(p.cursor)}&scope=${encodeURIComponent(p.scope)}`)).data;
  const named = (p) => p.dropped_rows.filter(([t]) => t === 'notes').map(([, id]) => id);
  // A counseling note edited at the office, and a new one written: the navigator's device never held either.
  let u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, old).updated_at;
  assert.equal((await C.clin.put(`/api/notes/${old}`, { content: 'edited', if_updated_at: u })).status, 200);
  const fresh = (await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'new counseling note', counseling_note: true, occurred_at: iso() })).data.id;
  const p1 = await pull(p0);
  assert.ok(!named(p1).includes(old), 'an edit is not a change in who may read it');
  assert.ok(!named(p1).includes(fresh), 'a note the device was never sent is not named to it (L4)');
  // Flagged after the device pulled it: named, by REST and by push.
  u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, flagged).updated_at;
  assert.equal((await C.clin.put(`/api/notes/${flagged}`, { counseling_note: true, if_updated_at: u })).status, 200);
  const p2 = await pull(p1);
  assert.deepEqual(named(p2), [flagged]);
  const viaPush = (await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'another draft', occurred_at: iso() })).data.id;
  const p3 = await pull(p2);
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, viaPush);
  const res = await push('clin', { tables: { notes: [{ ...row, content_enc: 'another draft', title_enc: null, structured_enc: null, cosign_note_enc: null, counseling_note: 1, updated_at: later() }] } });
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(named(await pull(p3)), [viaPush]);
});
