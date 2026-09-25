'use strict';
// The clinical-side findings of the functional audit: legal hold survives a merge attempt, discharge
// needs a reason, client status follows the episode, a referral outcome closes only its own follow-up,
// a visit's time entry follows the visit, a merged-away id points at the keeper, patient requests reach
// the dashboard, contact details are checked, a crisis outcome sets the crisis flag, only a signed
// safety plan earns the chip, and the client-code search accepts any code prefix.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, sup, nav, navId, supId;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
before(async () => {
  await H.start();
  navId = H.makeUser('canav', 'navigator').id;
  supId = H.makeUser('casup', 'supervisor').id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('casup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('canav', 'StaffPassw0rd!x');
});
after(H.stop);

const newClient = async (who, first, last, extra = {}) => (await who.post('/api/clients', { first_name: first, last_name: last, confirm_duplicate: true, ...extra })).data;

test('H1: a merge is refused, and audited, when either record is on legal hold', async () => {
  const keep = await newClient(sup, 'Hold', 'Keeper');
  const dup = await newClient(sup, 'Hold', 'Duplicate');
  assert.equal((await admin.post(`/api/clients/${dup.id}/legal-hold`, { hold: true, reason: 'Subpoena 26-CV-118' })).status, 200);
  let r = await sup.post(`/api/clients/${keep.id}/merge`, { source_id: dup.id });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /record to merge in \(.*\) is on legal hold/);
  assert.equal(H.db.one(`SELECT deleted_at, merged_into, legal_hold FROM clients WHERE id=?`, dup.id).deleted_at, null, 'the held record is untouched');
  assert.equal(H.db.one(`SELECT legal_hold FROM clients WHERE id=?`, dup.id).legal_hold, 1, 'and still on hold');
  const refused = H.db.one(`SELECT * FROM audit_log WHERE action='client.merge.refused' AND entity_id=?`, keep.id);
  assert.ok(refused, 'the refusal is audited');
  assert.equal(refused.success, 0);
  // The other way round: the keeper on hold.
  await admin.post(`/api/clients/${dup.id}/legal-hold`, { hold: false });
  await admin.post(`/api/clients/${keep.id}/legal-hold`, { hold: true, reason: 'Records request' });
  r = await sup.post(`/api/clients/${keep.id}/merge`, { source_id: dup.id });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /This record \(.*\) is on legal hold/);
  // Hold cleared: the merge goes through as before.
  await admin.post(`/api/clients/${keep.id}/legal-hold`, { hold: false });
  assert.equal((await sup.post(`/api/clients/${keep.id}/merge`, { source_id: dup.id })).status, 200);
});

test('M6: a merged-away id answers 404 with merged_into so the client page can go to the keeper', async () => {
  const keep = await newClient(sup, 'Merge', 'Keeper');
  const dup = await newClient(sup, 'Merge', 'Duplicate');
  assert.equal((await sup.post(`/api/clients/${keep.id}/merge`, { source_id: dup.id })).status, 200);
  const r = await sup.get(`/api/clients/${dup.id}`);
  assert.equal(r.status, 404);
  assert.equal(r.data.merged_into, keep.id);
  assert.match(r.data.error, /merged into another client/);
  const gone = await sup.get(`/api/clients/${H.db.one(`SELECT lower(hex(randomblob(16))) id`).id}`);
  assert.equal(gone.status, 404); assert.equal(gone.data.merged_into, undefined, 'an unknown id carries no pointer');
});

test('M1: a discharge without a reason is refused', async () => {
  const c = await newClient(nav, 'No', 'Reason');
  const r = await nav.post(`/api/episodes/${c.episode_id}/close`, { discharge_disposition: 'unknown' });
  assert.equal(r.status, 400);
  assert.equal(r.data.fields.discharge_reason, 'required');
  assert.equal((await nav.post(`/api/episodes/${c.episode_id}/close`, { discharge_reason: '' })).status, 400, 'a blank reason is no reason');
  assert.equal(H.db.one(`SELECT status FROM episodes WHERE id=?`, c.episode_id).status, 'open');
  assert.equal((await nav.post(`/api/episodes/${c.episode_id}/close`, { discharge_reason: 'lost_contact' })).status, 200);
});

test('M2: starting an episode makes a waitlisted client active; closing through Edit is refused while an episode is open', async () => {
  const w = await newClient(nav, 'Wait', 'Listed', { status: 'waitlist' });
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, w.id).status, 'waitlist');
  assert.equal((await nav.post(`/api/clients/${w.id}/episodes`, { opened_at: day(0) })).status, 201);
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, w.id).status, 'active', 'admission takes them off the waitlist');
  for (const status of ['closed', 'deceased']) {
    const r = await nav.put(`/api/clients/${w.id}`, { status });
    assert.equal(r.status, 400, `${status} by hand is refused`);
    assert.match(r.data.error, /Episodes tab/);
    assert.equal(r.data.open_episode, true);
    assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, w.id).status, 'active');
  }
  assert.equal((await nav.put(`/api/clients/${w.id}`, { status: 'inactive' })).status, 200, 'inactive (on hold, unreachable) is still a manual choice');
  // "inactive" is deliberate and is not undone by an episode; a closed client is reactivated.
  const inactive = await newClient(nav, 'Still', 'Inactive', { status: 'inactive', no_episode: true });
  await nav.post(`/api/clients/${inactive.id}/episodes`, {});
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, inactive.id).status, 'inactive');
  // Once discharged, the status is closed and Edit may keep it so.
  const e = H.db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, w.id);
  await nav.post(`/api/episodes/${e.id}/close`, { discharge_reason: 'completed' });
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, w.id).status, 'closed');
  assert.equal((await nav.put(`/api/clients/${w.id}`, { status: 'closed', city: 'Auburn' })).status, 200, 'saving a closed client with no open episode is fine');
});

test('M3: a referral outcome closes only that referral\'s follow-up to-do; legacy title-matched tasks still close', async () => {
  assert.ok(H.db.all(`PRAGMA table_info(tasks)`).some(c => c.name === 'referral_id'), 'tasks.referral_id exists');
  const c = await newClient(nav, 'Two', 'Referrals');
  const res1 = (await sup.post('/api/resources', { name: 'Granite Detox', category: 'detox_withdrawal_mgmt' })).data;
  const res2 = (await sup.post('/api/resources', { name: 'Hope Housing', category: 'housing' })).data;
  const r1 = (await nav.post('/api/referrals', { client_id: c.id, resource_id: res1.id, referred_at: new Date().toISOString() })).data;
  const r2 = (await nav.post('/api/referrals', { client_id: c.id, resource_id: res2.id, referred_at: new Date().toISOString() })).data;
  const t1 = H.db.one(`SELECT * FROM tasks WHERE referral_id=?`, r1.id); const t2 = H.db.one(`SELECT * FROM tasks WHERE referral_id=?`, r2.id);
  assert.ok(t1 && t2, 'each referral created its own follow-up, linked to it');
  // A hand-made "Follow up on referral…" to-do with no link must not be swept up either.
  const manual = (await nav.post('/api/tasks', { client_id: c.id, title: 'Follow up on referral paperwork', due_at: day(3) })).data;
  // And a to-do from before the column existed, matched on the resource name in its title.
  const legacyRef = (await nav.post('/api/referrals', { client_id: c.id, resource_id: res1.id, referred_at: new Date().toISOString() })).data;
  H.db.run(`UPDATE tasks SET referral_id=NULL WHERE referral_id=?`, legacyRef.id);
  assert.equal((await nav.post(`/api/referrals/${r1.id}/outcome`, { status: 'declined_by_client', barrier: 'client_declined' })).status, 200);
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, t1.id).status, 'done', 'the outcome closes its own follow-up');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, t2.id).status, 'open', 'the other referral\'s follow-up is untouched');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, manual.id).status, 'open', 'a hand-written to-do is untouched');
  const legacyTask = H.db.one(`SELECT status FROM tasks WHERE client_id=? AND referral_id IS NULL AND id<>? AND status='open'`, c.id, manual.id);
  assert.ok(legacyTask, 'the unlinked legacy follow-up for the same resource is still open (its referral has had no outcome)');
  assert.equal((await nav.post(`/api/referrals/${legacyRef.id}/outcome`, { status: 'closed' })).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM tasks WHERE client_id=? AND referral_id IS NULL AND status='open' AND id<>?`, c.id, manual.id).n, 0, 'the legacy task closes by title');
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, t2.id).status, 'open');
});

test('M4: editing a visit\'s duration or date updates its unapproved time entry; deleting the visit removes it, or detaches an approved one', async () => {
  const c = await newClient(nav, 'Time', 'Follows');
  const at = new Date(Date.now() - 86400000).toISOString();
  const v = (await nav.post('/api/interventions', { client_id: c.id, type: 'outreach', occurred_at: at, duration_minutes: 30, log_time: true })).data;
  let te = H.db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, v.id);
  assert.equal(te.minutes, 30);
  assert.equal((await nav.put(`/api/interventions/${v.id}`, { duration_minutes: 45 })).status, 200);
  te = H.db.one(`SELECT * FROM time_entries WHERE intervention_id=?`, v.id);
  assert.equal(te.minutes, 45, 'the draft entry follows the corrected duration');
  const newDate = day(-3);
  await nav.put(`/api/interventions/${v.id}`, { occurred_at: `${newDate}T15:00:00.000Z` });
  assert.equal(H.db.one(`SELECT work_date FROM time_entries WHERE intervention_id=?`, v.id).work_date, newDate, 'and the corrected date');
  // Submitted but not yet approved: still corrected.
  H.db.run(`UPDATE time_entries SET status='submitted', submitted_at=? WHERE id=?`, H.db.now(), te.id);
  await nav.put(`/api/interventions/${v.id}`, { duration_minutes: 50 });
  assert.equal(H.db.one(`SELECT minutes FROM time_entries WHERE id=?`, te.id).minutes, 50);
  // Approved: a signed-off time sheet is not rewritten.
  H.db.run(`UPDATE time_entries SET status='approved', approved_by=?, approved_at=? WHERE id=?`, supId, H.db.now(), te.id);
  await nav.put(`/api/interventions/${v.id}`, { duration_minutes: 55 });
  assert.equal(H.db.one(`SELECT minutes FROM time_entries WHERE id=?`, te.id).minutes, 50, 'approved time stays as approved');
  // Deleting the visit: an approved entry is detached and marked, not deleted.
  assert.equal((await nav.del(`/api/interventions/${v.id}`)).status, 200);
  const kept = H.db.one(`SELECT * FROM time_entries WHERE id=?`, te.id);
  assert.ok(kept, 'the approved entry survives');
  assert.equal(kept.intervention_id, null);
  assert.match(require('../server/crypto').decrypt(kept.description_enc), /visit .* was deleted/);
  // A draft entry goes with its visit.
  const v2 = (await nav.post('/api/interventions', { client_id: c.id, type: 'outreach', occurred_at: at, duration_minutes: 20, log_time: true })).data;
  const te2 = H.db.one(`SELECT id FROM time_entries WHERE intervention_id=?`, v2.id);
  assert.equal((await nav.del(`/api/interventions/${v2.id}`)).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM time_entries WHERE id=?`, te2.id).n, 0, 'the draft entry is gone');
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='time_entries' AND id=?`, te2.id), 'with a tombstone so a synced copy is removed too');
  // A duration set to zero removes the draft entry too.
  const v3 = (await nav.post('/api/interventions', { client_id: c.id, type: 'outreach', occurred_at: at, duration_minutes: 20, log_time: true })).data;
  await nav.put(`/api/interventions/${v3.id}`, { duration_minutes: 0 });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM time_entries WHERE intervention_id=?`, v3.id).n, 0);
});

test('M7: the dashboard counts open patient requests, and how many are overdue, for roles that handle them', async () => {
  const c = await newClient(nav, 'Rights', 'Request');
  const before = (await nav.get('/api/reports/dashboard')).data.patient_requests;
  assert.ok(before && typeof before.n === 'number');
  await nav.post('/api/patient-requests', { client_id: c.id, kind: 'access', received_at: day(-40) });
  await nav.post('/api/patient-requests', { client_id: c.id, kind: 'amendment', received_at: day(-2) });
  const closed = (await nav.post('/api/patient-requests', { client_id: c.id, kind: 'accounting', received_at: day(-50) })).data;
  await nav.put(`/api/patient-requests/${closed.id}`, { status: 'fulfilled' });
  const d = (await nav.get('/api/reports/dashboard')).data.patient_requests;
  assert.equal(d.n, before.n + 2, 'two open requests');
  assert.equal(d.overdue, before.overdue + 1, 'one past its 30-day deadline');
  // The finance role does not handle patient requests and is not told about them.
  H.makeUser('cafin', 'finance');
  const fin = H.client(); await fin.login('cafin', 'StaffPassw0rd!x');
  assert.equal((await fin.get('/api/reports/dashboard')).data.patient_requests, null);
  // A caseload-restricted navigator only counts their own clients' requests.
  const other = H.makeUser('caother', 'navigator'); const oc = H.client(); await oc.login('caother', 'StaffPassw0rd!x');
  const mine = (await oc.get('/api/reports/dashboard')).data.patient_requests;
  assert.equal(mine.n, 0);
  assert.ok(other.id);
});

test('L1: a date of birth in the future or before 1900, a bad email and a phone with too few digits are refused', async () => {
  const bad = await nav.post('/api/clients', { first_name: 'Bad', last_name: 'Contact', dob: day(5), email: 'notanemail', phone: 'abc', alt_phone: '555-01', confirm_duplicate: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.fields.dob, 'cannot be in the future');
  assert.equal(bad.data.fields.email, 'is not a valid email address');
  assert.equal(bad.data.fields.phone, 'must contain at least 7 digits');
  assert.equal(bad.data.fields.alt_phone, 'must contain at least 7 digits');
  assert.equal((await nav.post('/api/clients', { first_name: 'Old', last_name: 'Contact', dob: '1899-12-31', confirm_duplicate: true })).data.fields.dob, 'must be after 1900');
  const ok = await nav.post('/api/clients', { first_name: 'Good', last_name: 'Contact', dob: '1980-02-29', email: 'g.contact@example.org', phone: '(530) 555-0142', confirm_duplicate: true });
  assert.equal(ok.status, 201);
  const upd = await nav.put(`/api/clients/${ok.data.id}`, { email: 'nope' });
  assert.equal(upd.status, 400); assert.equal(upd.data.fields.email, 'is not a valid email address');
  assert.equal((await nav.put(`/api/clients/${ok.data.id}`, { dob: day(1) })).data.fields.dob, 'cannot be in the future');
  assert.equal((await nav.put(`/api/clients/${ok.data.id}`, { phone: '', email: '' })).status, 200, 'clearing a field is allowed');
});

test('L3: a call whose outcome is "crisis escalated" is a crisis whether or not the box was ticked', async () => {
  const c = await newClient(nav, 'Crisis', 'Call');
  const r = await nav.post('/api/calls', { client_id: c.id, direction: 'inbound', started_at: new Date().toISOString(), contact_type: 'client', outcome: 'crisis_escalated', duration_minutes: 12 });
  assert.equal(r.status, 201);
  assert.equal(H.db.one(`SELECT crisis FROM calls WHERE id=?`, r.data.id).crisis, 1);
  const plain = (await nav.post('/api/calls', { client_id: c.id, direction: 'outbound', started_at: new Date().toISOString(), contact_type: 'client', outcome: 'reached' })).data;
  assert.equal(H.db.one(`SELECT crisis FROM calls WHERE id=?`, plain.id).crisis, 0);
  await nav.put(`/api/calls/${plain.id}`, { outcome: 'crisis_escalated' });
  assert.equal(H.db.one(`SELECT crisis FROM calls WHERE id=?`, plain.id).crisis, 1, 'and on an edit');
  assert.equal((await nav.get('/api/calls?crisis=1&client_id=' + c.id)).data.total, 2);
});

test('L6: only a signed safety plan earns the chip on the client page', async () => {
  const c = await newClient(nav, 'Safety', 'Plan');
  const draft = (await nav.post('/api/notes', { client_id: c.id, kind: 'admin', format: 'safety_plan', title: 'Safety plan', content: 'Warning signs: …', occurred_at: new Date().toISOString() })).data;
  assert.equal((await nav.get(`/api/clients/${c.id}`)).data.client.safety_plan, null, 'a draft plan is not on file yet');
  const sign = await nav.post(`/api/notes/${draft.id}/sign`, { password: 'StaffPassw0rd!x' });
  assert.equal(sign.status, 200, JSON.stringify(sign.data));
  const sp = (await nav.get(`/api/clients/${c.id}`)).data.client.safety_plan;
  assert.ok(sp && sp.id === draft.id && sp.status === 'signed');
});

test('L8: the client-code search accepts any code prefix, not only C/M', async () => {
  const c = await newClient(sup, 'Coded', 'Search');
  H.db.run(`UPDATE clients SET client_code='DEMO-0007' WHERE id=?`, c.id);
  const r = await sup.get('/api/clients?q=DEMO-0007&status=all');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.clients.map(x => x.id), [c.id]);
  assert.equal((await sup.get('/api/clients?q=demo-0007&status=all')).data.total, 1, 'case-insensitive');
  assert.equal((await sup.get(`/api/clients?q=${encodeURIComponent(c.client_code)}&status=all`)).data.total, 0, 'the old code no longer matches');
});
