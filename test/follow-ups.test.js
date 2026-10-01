'use strict';
// Follow-up to-dos follow the follow-up date (released in 1.23.0; server/rules/follow-ups.js): on a
// call or text, a visit and a referral, a date set when the record is made OR added by editing it makes the to-do; a
// changed date moves it; a cleared date (or Follow-up needed unticked on a call) cancels it -- but only while the to-do
// is as SUDS made it, so a worker's own edits are never lost; saving again makes no duplicate; sync push applies the
// same rule to a device's records, finding the to-do the device sent with them rather than making a second one.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { decrypt } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
let nav, navId, clientId, resourceId;
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const tasksOf = (col, id) => H.db.all(`SELECT * FROM tasks WHERE ${col}=? ORDER BY created_at`, id);
const openOf = (col, id) => tasksOf(col, id).filter(t => t.status === 'open' || t.status === 'in_progress');

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true; // devices may sync with this office
  H.makeUser('funav', 'navigator'); H.makeUser('fusup', 'supervisor');
  navId = H.db.one(`SELECT id FROM users WHERE username='funav'`).id;
  nav = H.client(); await nav.login('funav', PW);
  const sup = H.client(); await sup.login('fusup', PW);
  clientId = ok(await nav.post('/api/clients', { first_name: 'Fern', last_name: 'Followup', status: 'active' })).id;
  resourceId = ok(await sup.post('/api/resources', { name: 'FU Detox Centre', category: 'detox_withdrawal_mgmt' })).id;
});
after(H.stop);

// Each record type: how to make one, edit its follow-up date, and clear it.
const KINDS = {
  call: {
    col: 'call_id', path: '/api/calls', title: /^Call back: FU purpose/,
    create: (due) => ({ client_id: clientId, direction: 'outbound', started_at: minutesAgo(5), purpose: 'FU purpose', ...(due ? { follow_up_needed: true, follow_up_due: due } : {}) }),
    set: (due) => ({ follow_up_needed: true, follow_up_due: due }),
    clear: () => ({ follow_up_needed: false, follow_up_due: null }),
  },
  visit: {
    col: 'intervention_id', path: '/api/interventions', title: /^Follow up: /,
    create: (due) => ({ client_id: clientId, type: 'case_management', occurred_at: minutesAgo(5), duration_minutes: 10, ...(due ? { follow_up_due: due } : {}) }),
    set: (due) => ({ follow_up_due: due }),
    clear: () => ({ follow_up_due: null }),
  },
  referral: {
    col: 'referral_id', path: '/api/referrals', title: /^Follow up on referral to FU Detox Centre$/,
    create: (due) => ({ client_id: clientId, resource_id: resourceId, referred_at: minutesAgo(5), ...(due ? { follow_up_due: due } : {}) }),
    set: (due) => ({ follow_up_due: due }),
    clear: () => ({ follow_up_due: null }),
  },
};

for (const [name, K] of Object.entries(KINDS)) {
  test(`${name}: a date set on insert makes one to-do, linked to the record, and audited`, async () => {
    const id = ok(await nav.post(K.path, K.create(inDays(3)))).id;
    const t = openOf(K.col, id);
    assert.equal(t.length, 1);
    assert.equal(t[0].due_at, inDays(3)); assert.equal(t[0].assigned_to, navId);
    assert.match(decrypt(t[0].title_enc), K.title);
    const a = H.db.one(`SELECT details FROM audit_log WHERE action='task.create' AND entity_id=?`, t[0].id);
    assert.ok(a, 'the to-do it made is in the audit trail');
    assert.equal(JSON.parse(a.details)[K.col], id);
    assert.ok(!/FU purpose|Fern/.test(a.details), 'no PHI in the audit details');
  });

  test(`${name}: a date added, changed and cleared by editing makes, moves and cancels the to-do; repeated saves make no duplicate`, async () => {
    // A referral always has a date; the others start without one.
    const id = ok(await nav.post(K.path, K.create(name === 'referral' ? inDays(14) : null))).id;
    if (name !== 'referral') {
      assert.equal(tasksOf(K.col, id).length, 0, 'no date, no to-do');
      ok(await nav.put(`${K.path}/${id}`, K.set(inDays(2))), 200);
      assert.equal(openOf(K.col, id).length, 1, 'a date added by editing makes the to-do');
      assert.equal(openOf(K.col, id)[0].due_at, inDays(2));
    }
    ok(await nav.put(`${K.path}/${id}`, K.set(inDays(5))), 200);
    let t = openOf(K.col, id);
    assert.equal(t.length, 1, 'a changed date moves the to-do rather than adding one');
    assert.equal(t[0].due_at, inDays(5));
    for (let i = 0; i < 3; i++) ok(await nav.put(`${K.path}/${id}`, K.set(inDays(5))), 200);
    assert.equal(tasksOf(K.col, id).length, 1, 'saving the same date again makes no duplicate');
    ok(await nav.put(`${K.path}/${id}`, K.clear()), 200);
    t = tasksOf(K.col, id);
    assert.equal(t.length, 1); assert.equal(t[0].status, 'cancelled', 'a cleared date cancels the untouched to-do');
    // A date set again after that makes a fresh one.
    ok(await nav.put(`${K.path}/${id}`, K.set(inDays(6))), 200);
    assert.equal(openOf(K.col, id).length, 1);
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='task.update' AND details LIKE ? AND details LIKE '%cancelled%'`, `%${id}%`), 'the cancellation is audited');
  });

  test(`${name}: a to-do the worker changed is never moved or cancelled`, async () => {
    const id = ok(await nav.post(K.path, K.create(inDays(3)))).id;
    const [t] = openOf(K.col, id);
    ok(await nav.put(`/api/tasks/${t.id}`, { due_at: inDays(4), description: 'Ask about the bed on Tuesday' }), 200);
    ok(await nav.put(`${K.path}/${id}`, K.set(inDays(8))), 200);
    let now = tasksOf(K.col, id);
    assert.equal(now.length, 1, 'no second to-do while the worker\'s own is open');
    assert.equal(now[0].due_at, inDays(4), 'the date the worker chose stands');
    ok(await nav.put(`${K.path}/${id}`, K.clear()), 200);
    now = tasksOf(K.col, id);
    assert.equal(now[0].status, 'open', 'and clearing the record\'s date leaves the worker\'s to-do for them to close');
    assert.equal(decrypt(now[0].description_enc), 'Ask about the bed on Tuesday');
  });
}

test('call: unticking Follow-up needed with the date left in the form turns the follow-up off; a new call with a date and the box unticked still makes one (1.22.0)', async () => {
  const id = ok(await nav.post('/api/calls', KINDS.call.create(inDays(3)))).id;
  ok(await nav.put(`/api/calls/${id}`, { follow_up_needed: false, follow_up_due: inDays(3) }), 200);
  const row = H.db.one(`SELECT follow_up_needed, follow_up_due FROM calls WHERE id=?`, id);
  assert.equal(row.follow_up_needed, 0); assert.equal(row.follow_up_due, null);
  assert.equal(tasksOf('call_id', id)[0].status, 'cancelled');
  const id2 = ok(await nav.post('/api/calls', { ...KINDS.call.create(null), follow_up_needed: false, follow_up_due: inDays(2) })).id;
  assert.equal(openOf('call_id', id2).length, 1);
});

test('a visit with no client makes no follow-up to-do', async () => {
  const id = ok(await nav.post('/api/interventions', { type: 'outreach', occurred_at: minutesAgo(3), follow_up_due: inDays(2) })).id;
  assert.equal(tasksOf('intervention_id', id).length, 0);
});

test('a to-do made before the link (no call_id) is found by its title and date, not duplicated', async () => {
  const id = ok(await nav.post('/api/calls', KINDS.call.create(inDays(3)))).id;
  H.db.run(`UPDATE tasks SET call_id=NULL WHERE call_id=?`, id); // as an older SUDS left it
  ok(await nav.put(`/api/calls/${id}`, { follow_up_due: inDays(9) }), 200);
  const t = openOf('call_id', id);
  assert.equal(t.length, 1, 'the old to-do is linked and moved');
  assert.equal(t[0].due_at, inDays(9));
});

test('sync push: the office runs the same rule on a device\'s calls, visits and referrals, and finds the to-do the device sent', async () => {
  const c = H.client();
  const login = await c.post('/api/auth/login', { username: 'funav', password: PW }, { 'X-Sync-Client': '1' });
  const B = { Authorization: 'Bearer ' + login.data.token, Cookie: '' };
  const push = async (tables) => { const r = await H.client().post('/api/sync/push', { tables }, B); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal((r.data.rejected || []).length, 0, JSON.stringify(r.data.rejected)); return r.data; };
  const rid = () => require('node:crypto').randomUUID();
  const now = () => new Date().toISOString();
  // An older kernel: the call and visit arrive with no to-do at all (or a to-do with no link), and the referral with none.
  const callId = rid(); const visitId = rid(); const refId = rid(); const legacyTask = rid();
  await push({
    calls: [{ id: callId, client_id: clientId, user_id: navId, direction: 'outbound', method: 'phone', started_at: minutesAgo(2), purpose_enc: 'Device purpose', follow_up_needed: 0, follow_up_due: inDays(3), created_at: now(), updated_at: now() }],
    interventions: [{ id: visitId, client_id: clientId, user_id: navId, type: 'case_management', occurred_at: minutesAgo(2), follow_up_due: inDays(4), created_at: now(), updated_at: now() }],
    referrals: [{ id: refId, client_id: clientId, resource_id: resourceId, user_id: navId, referred_at: minutesAgo(2), status: 'pending', urgency: 'urgent', created_at: now(), updated_at: now() }],
    tasks: [{ id: legacyTask, client_id: clientId, assigned_to: navId, created_by: navId, title_enc: 'Follow up: Case Management', due_at: inDays(4), priority: 'normal', status: 'open', created_at: now(), updated_at: now() }],
  });
  assert.equal(H.db.one(`SELECT follow_up_needed FROM calls WHERE id=?`, callId).follow_up_needed, 1, 'a date is a follow-up on a pushed call too');
  assert.equal(openOf('call_id', callId).length, 1, 'the office makes the call-back to-do the device left out');
  assert.equal(openOf('call_id', callId)[0].due_at, inDays(3));
  assert.deepEqual(openOf('intervention_id', visitId).map(t => t.id), [legacyTask], 'the device\'s own unlinked to-do is linked, not duplicated');
  assert.equal(H.db.one(`SELECT follow_up_due FROM referrals WHERE id=?`, refId).follow_up_due, inDays(3), 'an urgent referral with no date gets one');
  assert.equal(openOf('referral_id', refId).length, 1);
  // A new kernel: the device made the to-do itself, linked, and sends it with the record.
  const call2 = rid(); const task2 = rid();
  await push({
    calls: [{ id: call2, client_id: clientId, user_id: navId, direction: 'outbound', method: 'phone', started_at: minutesAgo(1), purpose_enc: 'Second', follow_up_needed: 1, follow_up_due: inDays(2), created_at: now(), updated_at: now() }],
    tasks: [{ id: task2, client_id: clientId, assigned_to: navId, created_by: navId, title_enc: 'Call back: Second', due_at: inDays(2), priority: 'normal', status: 'open', call_id: call2, created_at: now(), updated_at: now() }],
  });
  assert.deepEqual(tasksOf('call_id', call2).map(t => t.id), [task2], 'one to-do: the device\'s');
  // Edits pushed later: a changed date moves the to-do, a cleared one cancels it, the same date again does nothing.
  const later = () => new Date(Date.now() + 1000).toISOString();
  await push({ interventions: [{ id: visitId, client_id: clientId, user_id: navId, type: 'case_management', occurred_at: minutesAgo(2), follow_up_due: inDays(7), updated_at: later() }] });
  assert.equal(openOf('intervention_id', visitId)[0].due_at, inDays(7));
  await push({ calls: [{ id: callId, client_id: clientId, user_id: navId, direction: 'outbound', method: 'phone', started_at: minutesAgo(2), purpose_enc: 'Device purpose', follow_up_needed: 1, follow_up_due: null, updated_at: later() }] });
  assert.equal(tasksOf('call_id', callId)[0].status, 'cancelled');
  await push({ referrals: [{ id: refId, client_id: clientId, resource_id: resourceId, user_id: navId, referred_at: minutesAgo(2), status: 'pending', urgency: 'urgent', follow_up_due: inDays(3), notes_enc: 'Edited', updated_at: later() }] });
  assert.equal(tasksOf('referral_id', refId).length, 1, 'an unrelated edit makes no second to-do');
  // An outcome recorded on the device (an older kernel that leaves the to-do open) closes it at the office.
  await push({ referrals: [{ id: refId, client_id: clientId, resource_id: resourceId, user_id: navId, referred_at: minutesAgo(2), status: 'declined_by_client', urgency: 'urgent', follow_up_due: inDays(3), outcome_recorded_at: now(), closed_at: now(), updated_at: later() }] });
  assert.deepEqual(tasksOf('referral_id', refId).map(t => t.status), ['done'], 'recording the outcome closes the referral\'s to-do (review of 1.23)');
  // A to-do naming a call the office does not have keeps its place on the list, without the link.
  const orphan = rid();
  await push({ tasks: [{ id: orphan, client_id: clientId, assigned_to: navId, created_by: navId, title_enc: 'Call back: lost', due_at: inDays(2), priority: 'normal', status: 'open', call_id: rid(), created_at: now(), updated_at: now() }] });
  assert.equal(H.db.one(`SELECT call_id FROM tasks WHERE id=?`, orphan).call_id, null);
  // A to-do linked to a colleague's call keeps its place, without the link, so the office still makes theirs.
  const supId = H.db.one(`SELECT id FROM users WHERE username='fusup'`).id; const theirCall = rid();
  H.db.run(`INSERT INTO calls(id,client_id,user_id,direction,method,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, theirCall, clientId, supId, 'outbound', 'phone', minutesAgo(1), now(), now());
  const crafted = rid();
  await push({ tasks: [{ id: crafted, client_id: clientId, assigned_to: navId, created_by: navId, title_enc: 'Call back: theirs', due_at: inDays(2), priority: 'normal', status: 'open', call_id: theirCall, created_at: now(), updated_at: now() }] });
  assert.equal(H.db.one(`SELECT call_id FROM tasks WHERE id=?`, crafted).call_id, null, 'a link to someone else\'s call is dropped');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='task.create' AND ip='device' AND details LIKE ?`, `%${callId}%`), 'the office\'s to-do for a pushed call is audited');
});
