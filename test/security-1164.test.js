'use strict';
const LD = require('../server/local-date'); // the programme's calendar, as the server dates things
// Security review of 1.16.3 (r9): the findings fixed in 1.16.4, at both doors (REST and sync push) where there are
// two. The device side of N1 (a shared device and a note flagged as a SUD counseling note) is
// test/shared-device-drop.test.js; the enrolment link with a non-Latin programme name is test/otpauth-qr.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const U = {}; const C = {};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const day = (d = 0) => LD.addDays(LD.today(), d);
const later = (s = 5) => iso(Date.now() + s * 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let dec;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ decrypt: dec } = require('../server/crypto'));
  for (const [k, role] of [['navA', 'navigator'], ['navB', 'navigator'], ['navC', 'navigator'], ['clin', 'clinician'], ['sup', 'supervisor']]) {
    const u = H.makeUser(`s164_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
  const s = H.makeCaseloadUser('s164_scoped', 'navigator'); U.scoped = s.id; C.scoped = H.client(); await C.scoped.login(s.username, PW);
});
after(() => H.stop());

async function push(as, body) {
  const r = await C[as].post('/api/sync/push', { device_now: iso(), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const rejected = (res, id) => res.rejected.some(r => r.id === id);
const assignment = (cid, who) => H.db.one(`SELECT * FROM assignments WHERE client_id=? AND user_id=? ORDER BY created_at DESC, rowid DESC`, cid, U[who]);
let born = 0;
async function clientOf(as, first, extra = {}) {
  const r = await C[as].post('/api/clients', { first_name: first, last_name: `Nine${++born}`, dob: `1981-03-${String(born).padStart(2, '0')}`, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
const taskRow = (id, set) => { const r = H.db.one(`SELECT * FROM tasks WHERE id=?`, id); return { ...r, title_enc: dec(r.title_enc), description_enc: r.description_enc ? dec(r.description_enc) : null, ...set, updated_at: later() }; };
const status = (table, id) => H.db.one(`SELECT status FROM ${table} WHERE id=?`, id)?.status;

// ---- N2 (a): the creator's self-assignment is for a client created in the same push, not for ever ----
test('N2: a worker taken off a client they created cannot put themselves back by push', async () => {
  const cid = await clientOf('scoped', 'Removed');
  assert.equal((await C.sup.post(`/api/clients/${cid}/assignments`, { user_id: U.navB, role_on_case: 'primary' })).status, 201);
  assert.equal((await C.sup.post(`/api/assignments/${assignment(cid, 'scoped').id}/end`, {})).status, 200);
  assert.equal((await C.scoped.get(`/api/clients/${cid}`)).status, 403);
  const id = randomUUID();
  const res = await push('scoped', { tables: { assignments: [{ id, client_id: cid, user_id: U.scoped, role_on_case: 'primary', start_date: day(0), updated_at: iso() }] } });
  assert.ok(rejected(res, id), JSON.stringify(res));
  assert.equal(H.db.one(`SELECT 1 FROM assignments WHERE id=?`, id), undefined);
  assert.equal((await C.scoped.get(`/api/clients/${cid}`)).status, 403, 'still off the case');
});

test('N2: a client created offline still arrives with its creator\'s own assignment, and the push audits it', async () => {
  const cid = randomUUID(); const aid = randomUUID();
  const res = await push('scoped', { tables: {
    clients: [{ id: cid, client_code: `OFF-${cid.slice(0, 6)}`, first_name_enc: 'Off', last_name_enc: 'Line', status: 'active', intake_date: day(0), created_by: U.scoped, updated_at: iso() }],
    assignments: [{ id: aid, client_id: cid, user_id: U.scoped, role_on_case: 'primary', start_date: day(0), updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  assert.equal(H.db.one(`SELECT user_id FROM assignments WHERE id=?`, aid).user_id, U.scoped);
  assert.equal((await C.scoped.get(`/api/clients/${cid}`)).status, 200);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='assignment.create' AND entity_id=?`, aid);
  assert.ok(a, 'the assignment the push created is in the audit trail');
  assert.equal(JSON.parse(a.details).via, 'sync');
});

// ---- N2 (b): a re-admission by push restores the team only when it lands; a second open episode is refused ----
async function dischargedThenReassigned(who) {
  const cid = await clientOf(who, 'Readmit', { intake_date: day(-10) });
  H.db.run(`UPDATE episodes SET opened_at=? WHERE client_id=?`, day(-10), cid);
  const E = H.db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, cid);
  assert.equal((await C[who].post(`/api/episodes/${E.id}/close`, { discharge_reason: 'completed', closed_at: day(-1) })).status, 200);
  assert.equal((await C.sup.post(`/api/clients/${cid}/assignments`, { user_id: U.navB, role_on_case: 'primary' })).status, 201);
  return { cid, E: H.db.one(`SELECT * FROM episodes WHERE id=?`, E.id), mine: assignment(cid, who) };
}
const reopenRow = (E) => ({ ...E, status: 'open', presenting_problem_enc: null, discharge_summary_enc: null, reopen_reason_enc: null, updated_at: later() });

test('N2: a push re-admission while another episode is open is refused, and restores nobody (T9)', async () => {
  for (const who of ['navA', 'scoped']) {
    const { cid, E, mine } = await dischargedThenReassigned(who);
    assert.equal((await C.navB.post(`/api/clients/${cid}/episodes`, {})).status, 201, 'navB admits the client again');
    const res = await push(who, { tables: { episodes: [reopenRow(E)], assignments: [{ ...mine, notes_enc: null, end_date: null, updated_at: later() }] } });
    assert.ok(rejected(res, E.id), `${who}: ${JSON.stringify(res)}`);
    assert.ok(rejected(res, mine.id), `${who}: ${JSON.stringify(res)}`);
    assert.equal(status('episodes', E.id), 'closed');
    assert.equal(H.db.all(`SELECT 1 FROM episodes WHERE client_id=? AND status='open'`, cid).length, 1);
    assert.ok(H.db.one(`SELECT end_date FROM assignments WHERE id=?`, mine.id).end_date, `${who}'s assignment stays ended`);
  }
});

test('N2: a push re-admission that lands restores the team it ended, as POST /reopen does, and audits it', async () => {
  const { cid, E, mine } = await dischargedThenReassigned('navA');
  const res = await push('navA', { tables: { episodes: [reopenRow(E)], assignments: [{ ...mine, notes_enc: null, end_date: null, updated_at: later() }] } });
  assert.deepEqual(res.rejected, []);
  assert.equal(status('episodes', E.id), 'open');
  assert.equal(H.db.one(`SELECT end_date FROM assignments WHERE id=?`, mine.id).end_date, null);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='assignment.restore' AND entity_id=?`, mine.id);
  assert.ok(a && JSON.parse(a.details).via === 'sync', 'the restored assignment is in the audit trail');
  assert.equal(H.db.one(`SELECT client_id FROM audit_log WHERE action='assignment.restore' AND entity_id=?`, mine.id).client_id, cid);
});

test('N2: an assignment restore rides only on a re-admission that landed, not one the push asked for', async () => {
  const { E, mine } = await dischargedThenReassigned('navA');
  // navC is not the opener and not on the team: the re-open is refused, so the restore it names is too.
  const res = await push('navC', { tables: { episodes: [reopenRow(E)], assignments: [{ ...mine, notes_enc: null, end_date: null, updated_at: later() }] } });
  assert.ok(rejected(res, E.id), JSON.stringify(res));
  assert.ok(rejected(res, mine.id), JSON.stringify(res));
  assert.ok(H.db.one(`SELECT end_date FROM assignments WHERE id=?`, mine.id).end_date);
});

// ---- N3: another worker's to-do is closed by push only by a discharge of its client, by the care team ----
test('N3: a push cannot cancel or complete another worker\'s to-do outside a discharge (T2)', async () => {
  const cid = await clientOf('navB', 'Todo');
  const t = (await C.navB.post('/api/tasks', { title: 'Naloxone refill', client_id: cid, assigned_to: U.navB, due_at: later(86400) })).data.id;
  assert.equal((await C.navA.put(`/api/tasks/${t}`, { status: 'cancelled' })).status, 403, 'REST refuses');
  const r1 = await push('navA', { tables: { tasks: [taskRow(t, { status: 'cancelled' })] } });
  assert.ok(rejected(r1, t), JSON.stringify(r1));
  assert.equal(status('tasks', t), 'open');
  const own = (await C.navB.post('/api/tasks', { title: 'personal to-do', assigned_to: U.navB })).data.id;
  const r2 = await push('navA', { tables: { tasks: [taskRow(own, { status: 'done', completed_at: iso() })] } });
  assert.ok(rejected(r2, own), JSON.stringify(r2));
  assert.equal(status('tasks', own), 'open');
});

test('N3: the care team\'s discharge by push still cancels the client\'s to-dos; a refused discharge cancels none', async () => {
  const cid = await clientOf('navB', 'Close');
  const t1 = (await C.navC.post('/api/tasks', { title: 'Bus pass', client_id: cid, assigned_to: U.navC })).data.id;
  const e = H.db.one(`SELECT * FROM episodes WHERE client_id=?`, cid);
  const close = { id: e.id, client_id: cid, opened_at: e.opened_at, status: 'closed', closed_at: day(0), discharge_reason: 'completed', updated_at: later() };
  // navA is off the team and did not open the episode: the discharge is refused, and so is the cancellation.
  const r1 = await push('navA', { tables: { episodes: [close], tasks: [taskRow(t1, { status: 'cancelled' })] } });
  assert.ok(rejected(r1, e.id) && rejected(r1, t1), JSON.stringify(r1));
  assert.equal(status('tasks', t1), 'open');
  const r2 = await push('navB', { tables: { episodes: [close], tasks: [taskRow(t1, { status: 'cancelled' })] } });
  assert.deepEqual(r2.rejected, []);
  assert.equal(status('tasks', t1), 'cancelled');
});

// ---- N4: the second-episode check counts only closes that land; a closed episode is not fabricated off the team ----
test('N4: a second open episode off the team is refused even when the push also "closes" the open one (T5)', async () => {
  const cid = await clientOf('navB', 'Twice');
  const E1 = H.db.one(`SELECT * FROM episodes WHERE client_id=? AND status='open'`, cid);
  const E2 = randomUUID();
  const res = await push('navA', { tables: { episodes: [
    { id: E2, client_id: cid, status: 'open', opened_at: day(0), updated_at: iso() },
    { ...E1, status: 'closed', closed_at: day(0), discharge_reason: 'completed', presenting_problem_enc: null, discharge_summary_enc: null, reopen_reason_enc: null, updated_at: later() }] } });
  assert.ok(rejected(res, E1.id), JSON.stringify(res));
  assert.ok(rejected(res, E2), JSON.stringify(res));
  assert.deepEqual(H.db.all(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, cid).map(x => x.id), [E1.id]);
  // The care team's own device, closing the old admission and opening a new one in one push: both land, unflagged.
  const E3 = randomUUID();
  const r2 = await push('navB', { tables: { episodes: [
    { id: E3, client_id: cid, status: 'open', opened_at: day(0), updated_at: iso() },
    { ...E1, status: 'closed', closed_at: day(0), discharge_reason: 'completed', presenting_problem_enc: null, discharge_summary_enc: null, reopen_reason_enc: null, updated_at: later() }] } });
  assert.deepEqual(r2.rejected, []);
  assert.ok(!r2.warnings.some(w => w.id === E3), JSON.stringify(r2.warnings));
});

test('N4: an already-closed episode with past dates is not pushed onto a client off the team', async () => {
  const cid = await clientOf('navB', 'Fabricated');
  const E = randomUUID();
  const res = await push('navA', { tables: { episodes: [{ id: E, client_id: cid, status: 'closed', opened_at: day(-400), closed_at: day(-300), discharge_reason: 'completed', updated_at: iso() }] } });
  assert.ok(rejected(res, E), JSON.stringify(res));
  assert.equal(H.db.one(`SELECT 1 FROM episodes WHERE id=?`, E), undefined);
  // The care team recording an admission and discharge made offline is kept.
  const own = randomUUID();
  const r2 = await push('navB', { tables: { episodes: [{ id: own, client_id: cid, status: 'closed', opened_at: day(-20), closed_at: day(-19), discharge_reason: 'completed', updated_at: iso() }] } });
  assert.ok(!rejected(r2, own), JSON.stringify(r2));
});

// ---- N5: the 1.16.1 legacy notice rule is gone; the card names the editor from the audit trail ----
test('N5: a to-do with 1.16.1 notice text, followed by an edit within the minute, is an ordinary to-do', async () => {
  const cid = await clientOf('navB', 'Legacy');
  const t = await C.navA.post('/api/tasks', { client_id: cid, assigned_to: U.navB, title: 'Admin Alice changed the record (Safety flags)', description: `Changed: Safety flags\nReference: client record change by ${U.navA}` });
  assert.equal(t.status, 201);
  const cur = (await C.navA.get(`/api/clients/${cid}`)).data;
  assert.equal((await C.navA.put(`/api/clients/${cid}`, { phone: '916-555-0101', updated_at: cur.updated_at || cur.client?.updated_at })).status, 200);
  assert.ok(!(await C.navB.get(`/api/tasks/${t.data.id}`)).data.row.notice);
  assert.equal((await C.navA.put(`/api/tasks/${t.data.id}`, { priority: 'high' })).status, 200, 'its creator edits it');
});

test('N5: a notice says who made the change from its audit entry, whatever its title says', async () => {
  const cid = await clientOf('navB', 'Named');
  const cur = (await C.navA.get(`/api/clients/${cid}`)).data;
  assert.equal((await C.navA.put(`/api/clients/${cid}`, { phone: '916-555-0102', updated_at: cur.updated_at || cur.client?.updated_at })).status, 200);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.change_notice' AND client_id=? ORDER BY id DESC`, cid);
  const id = JSON.parse(a.details).task;
  H.db.run(`UPDATE tasks SET title_enc=? WHERE id=?`, require('../server/crypto').encrypt('Supervisor Sam changed the record (Diagnosis)'), id);
  const row = (await C.navB.get(`/api/tasks/${id}`)).data.row;
  assert.equal(row.notice, true);
  assert.equal(row.notice_by, 's164_navA');
  const due = (await C.navB.get('/api/tasks/due?within=60')).data.rows.find(r => r.id === id);
  assert.equal(due.notice_by, 's164_navA');
});

// ---- N6: a note flagged in a paged pull's window is named on whichever page carries it ----
test('N6: a paged pull still names a note flagged after the device pulled it', async () => {
  const cid = await clientOf('clin', 'Paged');
  const n = (await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'draft', occurred_at: iso() })).data.id;
  const pull = async (since, limit) => (await C.navA.get(`/api/sync/pull?since=${encodeURIComponent(since)}${limit ? `&limit=${limit}` : ''}`)).data;
  let p = await pull('1970-01-01T00:00:00.000Z');
  for (let i = 0; !p.complete && i < 50; i++) p = await pull(p.cursor);
  const since = p.cursor;
  await sleep(5);
  let u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, n).updated_at;
  assert.equal((await C.clin.put(`/api/notes/${n}`, { counseling_note: true, if_updated_at: u })).status, 200);
  for (let i = 0; i < 6; i++) { await sleep(3); await C.navB.post('/api/tasks', { title: `filler ${i}`, client_id: cid }); }
  await sleep(5);
  u = H.db.one(`SELECT updated_at FROM notes WHERE id=?`, n).updated_at;
  assert.equal((await C.clin.put(`/api/notes/${n}`, { content: 'edited after the flag', if_updated_at: u })).status, 200);
  let s = since; let named = false; let pages = 0;
  for (;;) { const q = await pull(s, 3); pages++; if (q.dropped_rows.some(x => x[1] === n)) named = true; if (q.complete || pages > 30) break; s = q.cursor; }
  assert.ok(pages > 1, 'the pull was paged');
  assert.ok(named, 'the note is named on the page that carries it');
});

// ---- the minor findings ----
test('a flag pushed without the note\'s client is still named to a device that held the note', async () => {
  const cid = await clientOf('clin', 'NoClient');
  const n = (await C.clin.post('/api/notes', { client_id: cid, kind: 'clinical', content: 'draft two', occurred_at: iso() })).data.id;
  const p0 = (await C.navA.get('/api/sync/pull')).data;
  let p = p0; for (let i = 0; !p.complete && i < 50; i++) p = (await C.navA.get(`/api/sync/pull?since=${encodeURIComponent(p.cursor)}`)).data;
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, n);
  const sent = { ...row, content_enc: 'draft two', title_enc: null, structured_enc: null, cosign_note_enc: null, counseling_note: 1, updated_at: later() };
  delete sent.client_id;
  assert.deepEqual((await push('clin', { tables: { notes: [sent] } })).rejected, []);
  const q = (await C.navA.get(`/api/sync/pull?since=${encodeURIComponent(p.cursor)}`)).data;
  assert.ok(q.dropped_rows.some(x => x[1] === n), JSON.stringify(q.dropped_rows));
});

test('a device to-do that merely contains the notice line is kept as an ordinary to-do, not dropped', async () => {
  const cid = await clientOf('navA', 'Marker');
  const mine = randomUUID(); const theirs = randomUUID();
  const res = await push('navA', { tables: { tasks: [
    { id: mine, client_id: cid, assigned_to: U.navA, title_enc: 'Look up', description_enc: 'What does "Reference: client record change notice" mean?', status: 'open', priority: 'normal', updated_at: iso() },
    { id: theirs, client_id: cid, assigned_to: U.navB, title_enc: 'Please check', description_enc: 'Reference: client record change notice\nsee above', status: 'open', priority: 'normal', updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  assert.ok(H.db.one(`SELECT 1 FROM tasks WHERE id=?`, mine), 'kept');
  assert.ok(H.db.one(`SELECT 1 FROM tasks WHERE id=?`, theirs), 'kept');
  assert.ok(!(await C.navB.get(`/api/tasks/${theirs}`)).data.row.notice, 'and not a notice');
});

test('a new note\'s created_at from a device is never in the future', async () => {
  const cid = await clientOf('clin', 'Future');
  const id = randomUUID();
  const res = await push('clin', { tables: { notes: [{ id, client_id: cid, kind: 'clinical', format: 'narrative', content_enc: 'future', occurred_at: iso(), status: 'draft', created_at: iso(Date.now() + 30 * 86400000), updated_at: iso() }] } });
  assert.deepEqual(res.rejected, []);
  assert.ok(H.db.one(`SELECT created_at FROM notes WHERE id=?`, id).created_at <= iso(Date.now() + 1000));
});

// ---- UX review of 1.16.3, M2: a notice is marked seen only by the worker it was sent to ----
test('a supervisor may remove a change notice but not mark it seen for the primary worker, at either door', async () => {
  const cid = await clientOf('navB', 'Seen');
  const cur = (await C.navA.get(`/api/clients/${cid}`)).data;
  assert.equal((await C.navA.put(`/api/clients/${cid}`, { phone: '916-555-0103', updated_at: cur.updated_at || cur.client?.updated_at })).status, 200);
  const id = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='client.change_notice' AND client_id=? ORDER BY id DESC`, cid).details).task;
  assert.equal((await C.sup.put(`/api/tasks/${id}`, { status: 'done' })).status, 403, 'REST');
  const res = await push('sup', { tables: { tasks: [taskRow(id, { status: 'done', completed_at: iso() })] } });
  assert.ok(rejected(res, id), JSON.stringify(res));
  assert.equal(status('tasks', id), 'open');
  assert.equal((await C.navB.put(`/api/tasks/${id}`, { status: 'done' })).status, 200, 'the worker told marks it seen');
  assert.equal(status('tasks', id), 'done');
  assert.equal((await C.navA.del(`/api/tasks/${id}`)).status, 403, 'the editor cannot remove it');
  assert.equal((await C.sup.del(`/api/tasks/${id}`)).status, 200, 'a supervisor removes it (a worker who has left)');
});
