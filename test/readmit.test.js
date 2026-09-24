'use strict';
// Load review, item 4: a client discharged years ago walks back in on an evening shift. The navigator on
// duty could not find them (search is caseload-scoped), could not open them (403), and intake refused with
// "outside your caseload — ask a supervisor", with no supervisor there. The duplicate check at intake now
// says an earlier, discharged record exists and lets the navigator re-admit it: they are assigned, a new
// episode opens, the audit log records it, and it lands in the supervisors' review queue (the same queue as
// break-glass access). General search is not widened, and an active client on someone else's caseload is
// still "ask a supervisor".
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;

let sup, navA, navB, fin, navBId, supId;
const person = { first_name: 'Rhea', last_name: 'Turnback', dob: '1979-05-06', phone: '555-201-7788' };
let oldId, activeId;
const REASON = 'Walked in at 7pm asking to restart services';
before(async () => {
  await H.start();
  supId = H.makeUser('ra_sup', 'supervisor').id; H.makeUser('ra_navA', 'navigator'); navBId = H.makeUser('ra_navB', 'navigator').id; H.makeUser('ra_fin', 'finance');
  sup = H.client(); await sup.login('ra_sup', 'StaffPassw0rd!x');
  navA = H.client(); await navA.login('ra_navA', 'StaffPassw0rd!x');
  navB = H.client(); await navB.login('ra_navB', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('ra_fin', 'StaffPassw0rd!x');
  // Navigator A admitted Rhea years ago and discharged her; the discharge ended A's assignment.
  const c = await navA.post('/api/clients', { ...person, intake_date: '2021-02-01' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  oldId = c.data.id;
  const ep = db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, oldId);
  assert.equal((await navA.post(`/api/episodes/${ep.id}/close`, { discharge_reason: 'lost_contact', closed_at: '2022-03-01' })).status, 200);
  // Someone else who is active on navigator A's caseload right now.
  activeId = (await navA.post('/api/clients', { first_name: 'Otto', last_name: 'Current', dob: '1990-01-01', phone: '555-201-9999' })).data.id;
});
after(async () => { await H.stop(); });

test('before: search, open and a plain intake all stay closed to a navigator off the caseload', async () => {
  const s = await navB.get('/api/clients?status=all&q=Turnback');
  assert.equal(s.data.total, 0, 'general search is not widened to other caseloads');
  assert.equal((await navB.get(`/api/clients/${oldId}`)).status, 403);
  const other = await navB.get('/api/clients?status=all&q=Current');
  assert.equal(other.data.total, 0);
});

test('the duplicate check at intake says a discharged record exists and offers to re-admit it', async () => {
  const chk = await navB.post('/api/clients/check-duplicates', person);
  assert.equal(chk.status, 200);
  assert.equal(chk.data.matches.length, 0, 'nothing from the record itself is shown');
  assert.equal(chk.data.readmit.length, 1, 'but the earlier, discharged record is offered for re-admission');
  const r = chk.data.readmit[0];
  assert.equal(r.id, oldId);
  assert.ok(r.client_code && r.discharge_date === '2022-03-01');
  assert.ok(!('display_name' in r) && !('dob' in r) && !('phone' in r), 'no name, birth date or phone from the stored record');
  const create = await navB.post('/api/clients', person);
  assert.equal(create.status, 400);
  assert.equal(create.data.readmit.length, 1, 'intake says the same instead of a dead end');
  assert.match(create.data.error, /earlier record/i);
  // An active client on someone else's caseload is not offered: that is still a supervisor's call.
  const busy = await navB.post('/api/clients/check-duplicates', { first_name: 'Otto', last_name: 'Current', dob: '1990-01-01' });
  assert.equal(busy.data.readmit.length, 0);
  assert.equal(busy.data.hidden_duplicates, 1);
});

test('re-admission needs the person’s details and a reason, and is refused for records that are not discharged', async () => {
  assert.equal((await navB.post(`/api/clients/${oldId}/readmit`, { ...person, reason: 'short' })).status, 400, 'a real reason is required');
  const nameOnly = await navB.post(`/api/clients/${oldId}/readmit`, { first_name: person.first_name, last_name: person.last_name, reason: REASON });
  assert.equal(nameOnly.status, 403, 'a name alone is not enough to take a record onto your caseload');
  const guess = await navB.post(`/api/clients/${activeId}/readmit`, { first_name: 'Otto', last_name: 'Current', dob: '1990-01-01', reason: REASON });
  assert.equal(guess.status, 409, 'an active client on another caseload cannot be taken over this way');
  assert.equal((await fin.post(`/api/clients/${oldId}/readmit`, { ...person, reason: REASON })).status, 403, 'finance cannot admit anyone');
  assert.equal(db.one(`SELECT COUNT(*) n FROM assignments WHERE client_id=? AND user_id=?`, oldId, navBId).n, 0, 'nothing was assigned by the refused attempts');
});

test('re-admitting assigns the navigator, opens an episode, is audited and lands in the supervisors’ review queue', async () => {
  const r = await navB.post(`/api/clients/${oldId}/readmit`, { ...person, reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.id, oldId);
  assert.ok(r.data.episode_id);
  // Now theirs: open it, find it.
  assert.equal((await navB.get(`/api/clients/${oldId}`)).status, 200);
  assert.equal((await navB.get('/api/clients?status=all&q=Turnback')).data.total, 1);
  const row = db.one(`SELECT status, discharge_date FROM clients WHERE id=?`, oldId);
  assert.equal(row.status, 'active'); assert.equal(row.discharge_date, null);
  assert.ok(db.one(`SELECT 1 FROM episodes WHERE client_id=? AND status='open' AND opened_by=?`, oldId, navBId), 'a new episode, opened by them');
  assert.ok(db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND end_date IS NULL`, oldId, navBId));
  const audit = db.one(`SELECT * FROM audit_log WHERE action='client.readmit' AND entity_id=?`, oldId);
  assert.ok(audit, 'audited');
  assert.ok(!String(audit.details || '').includes('7pm'), 'the reason (which may describe the person) is not in the audit details');
  // The supervisors' queue: dashboard count, and the review list naming what happened.
  const dash = (await sup.get('/api/reports/dashboard')).data;
  assert.ok(dash.breakglass_pending >= 1);
  const q = (await sup.get('/api/supervision/breakglass')).data.rows.find(x => x.client_id === oldId);
  assert.ok(q, 'in the review queue');
  assert.equal(q.kind, 'readmission');
  assert.equal(q.reason, REASON);
  assert.equal((await sup.post(`/api/supervision/breakglass/${q.id}/ack`, {})).status, 200, 'and a supervisor acknowledges it like any other');
  // Once active and on their caseload, it is no longer offered for re-admission.
  const again = await navB.post(`/api/clients/${oldId}/readmit`, { ...person, reason: REASON });
  assert.equal(again.status, 409);
});
