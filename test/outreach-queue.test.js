'use strict';
// Street outreach with no signal on the office app (1.23.0): a contact that names nobody waits on the phone
// (public/outreach-queue.js) and is sent when there is signal, with the Idempotency-Key it was first tried with.
// However often and however late it is sent, it is one contact and draws the stock down once (crud.js keyedId,
// beyond server/idempotency.js's 24 hours); the office refuses anything identifying sent from the waiting list
// (X-Suds-Queued). And "Set up this phone for the field" (server/field-request.js): the worker asks, the
// administrators get a to-do, and Approve narrows (never widens) what the worker's devices hold.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, admin2, sup, nav, nav2, navId, nav2Id, item, office;
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const onHand = () => H.db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=?`, item, office).n;
const count = (sql, ...p) => H.db.one(sql, ...p).n;
// Forget every stored answer, as server/idempotency.js does after 24 hours.
const forgetKeys = () => H.db.run(`DELETE FROM idempotency_keys`);
const body = (over = {}) => ({ type: 'outreach', occurred_at: '2026-09-20T18:00:00.000Z', location: 'street', modality: 'in_person', duration_minutes: 0, supply_site_id: office, supplies: [{ item_id: item, quantity: 2 }], ...over });
const queued = (key) => ({ 'Idempotency-Key': key, 'X-Suds-Queued': '1' });

before(async () => {
  await H.start();
  H.makeUser('oq_admin', 'admin'); H.makeUser('oq_admin2', 'admin'); H.makeUser('oq_sup', 'supervisor');
  navId = H.makeUser('oq_nav', 'navigator').id; nav2Id = H.makeUser('oq_nav2', 'navigator').id;
  admin = H.client(); await admin.login('oq_admin', 'StaffPassw0rd!x');
  admin2 = H.client(); await admin2.login('oq_admin2', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('oq_sup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('oq_nav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('oq_nav2', 'StaffPassw0rd!x');
  office = H.db.MAIN_SITE_ID;
  item = ok(await sup.post('/api/supplies/items', { name: 'Queue naloxone kit', category: 'naloxone', quick: true })).id;
  ok(await sup.post('/api/supplies/receipts', { item_id: item, site_id: office, quantity: 100, lot_number: 'Q-1', expires_on: '2030-01-01', source: 'purchase' }));
});
after(async () => { await H.stop(); });

test('a contact sent again from the waiting list is one contact, its supplies drawn once, even days later', async () => {
  const start = onHand();
  // The screen's own attempt (its answer lost with the signal), then the waiting list's, with the same key and body.
  const a = ok(await nav.post('/api/interventions', body(), { 'Idempotency-Key': 'outreach-k1' }));
  const b = await nav.post('/api/interventions', body(), queued('outreach-k1'));
  assert.equal(b.data.id, a.id, 'within a day: the stored answer');
  // Days later the office has forgotten the key (24 hours); the row's id still comes from it.
  forgetKeys();
  const c = ok(await nav.post('/api/interventions', body(), queued('outreach-k1')), 200);
  assert.equal(c.id, a.id); assert.equal(c.replayed, true);
  assert.equal(count(`SELECT COUNT(*) n FROM interventions WHERE id=?`, a.id), 1);
  assert.equal(count(`SELECT COUNT(*) n FROM interventions WHERE user_id=? AND occurred_at=?`, navId, '2026-09-20T18:00:00.000Z'), 1, 'one contact');
  assert.equal(onHand(), start - 2, 'the stock drawn down once');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='intervention.create.replayed' AND entity_id=?`, a.id), 'the repeat is audited');
  // The contact is the worker's own, as any: it counts in My shift once.
  const shift = ok(await nav.get('/api/outreach/shift?since=2026-09-20T17:00:00.000Z'), 200);
  assert.ok(shift.recent.filter(v => v.id === a.id).length <= 1);
});

test('a contact undone and then sent again from the waiting list is not made again', async () => {
  const start = onHand();
  const a = ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-21T18:00:00.000Z' }), { 'Idempotency-Key': 'outreach-k2' }));
  assert.equal(onHand(), start - 2);
  ok(await nav.del(`/api/interventions/${a.id}`), 200);
  assert.equal(onHand(), start, 'Undo put the supplies back');
  forgetKeys();
  const r = ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-21T18:00:00.000Z' }), queued('outreach-k2')), 200);
  assert.equal(r.id, a.id); assert.equal(r.deleted, true);
  assert.equal(count(`SELECT COUNT(*) n FROM interventions WHERE id=?`, a.id), 0, 'still gone');
  assert.equal(onHand(), start, 'and nothing drawn again');
});

test('a contact undone the same day and then sent from the waiting list is answered as undone, not as made (1.23.1)', async () => {
  // Within 24 hours the office still holds the first attempt's answer (server/idempotency.js); the waiting list's
  // send must not get it back as "made" when the contact has been deleted since.
  const start = onHand();
  const a = ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-24T18:00:00.000Z' }), { 'Idempotency-Key': 'outreach-k6' }));
  ok(await nav.del(`/api/interventions/${a.id}`), 200);
  const r = ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-24T18:00:00.000Z' }), queued('outreach-k6')), 200);
  assert.equal(r.id, a.id); assert.equal(r.deleted, true, JSON.stringify(r));
  assert.equal(count(`SELECT COUNT(*) n FROM interventions WHERE id=?`, a.id), 0, 'still gone');
  assert.equal(onHand(), start, 'nothing drawn again');
  // The screen's own retry (no X-Suds-Queued) is still answered from the stored answer, as before.
  assert.equal((await nav.post('/api/interventions', body({ occurred_at: '2026-09-24T18:00:00.000Z' }), { 'Idempotency-Key': 'outreach-k6' })).data.id, a.id);
});

test('a contact the office already has is answered as such even when it could not be made today (review of 1.23)', async () => {
  // The screen's attempt was made (its answer lost with the signal); since then its supply site was retired. The
  // waiting list's later send must find the contact, not be refused and leave the worker to enter it again.
  const site = require('node:crypto').randomUUID();
  H.db.run(`INSERT INTO supply_sites(id,name,kind,sort_order) VALUES(?,?,?,?)`, site, 'Queue van', 'other', 9);
  const a = ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-23T18:00:00.000Z', supply_site_id: site, supplies: [] }), { 'Idempotency-Key': 'outreach-k4' }));
  H.db.run(`UPDATE supply_sites SET is_active=0 WHERE id=?`, site);
  forgetKeys();
  const r = ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-23T18:00:00.000Z', supply_site_id: site, supplies: [] }), queued('outreach-k4')), 200);
  assert.equal(r.id, a.id); assert.equal(r.replayed, true);
  // A new contact at the retired site is still refused.
  assert.equal((await nav.post('/api/interventions', body({ occurred_at: '2026-09-23T19:00:00.000Z', supply_site_id: site, supplies: [] }), queued('outreach-k5'))).status, 400);
});

test('keys are per worker: the same key from another worker is another contact', async () => {
  const a = ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-22T18:00:00.000Z' }), queued('shared-key')));
  const b = ok(await nav2.post('/api/interventions', body({ occurred_at: '2026-09-22T18:00:00.000Z' }), queued('shared-key')));
  assert.notEqual(a.id, b.id);
  assert.equal(H.db.one(`SELECT user_id FROM interventions WHERE id=?`, b.id).user_id, nav2Id);
});

test('nothing identifying is accepted from the waiting list: no client, participant code or notes', async () => {
  const before = count(`SELECT COUNT(*) n FROM interventions`);
  const clientId = ok(await nav.post('/api/clients', { first_name: 'Queue', last_name: 'Person' })).id;
  for (const [over, field] of [[{ participant_code: 'MA0785' }, 'participant_code'], [{ summary: 'Met by the bridge' }, 'summary'], [{ client_id: clientId }, 'client_id'], [{ type: 'case_management' }, 'type']]) {
    const r = await nav.post('/api/interventions', body({ occurred_at: '2026-09-23T18:00:00.000Z', ...over }), queued(`phi-${field}`));
    assert.equal(r.status, 400, `${field}: ${JSON.stringify(r.data)}`);
    // A service that needs a client is refused by the table's rules before the waiting list's own check.
    if (field !== 'type') assert.ok(r.data.fields && r.data.fields[field], `${field} is named`);
  }
  assert.equal(count(`SELECT COUNT(*) n FROM interventions`), before, 'nothing saved');
  // The same contact typed on the screen, online, is saved as it always was (notes encrypted).
  ok(await nav.post('/api/interventions', body({ occurred_at: '2026-09-23T18:00:00.000Z', summary: 'Met by the bridge' }), { 'Idempotency-Key': 'online-with-notes' }));
});

test('set up this phone for the field: the worker asks, every administrator gets a to-do', async () => {
  const st = ok(await nav.get('/api/me/field-device'), 200);
  assert.equal(st.request, null); assert.equal(st.account_field, false); assert.deepEqual(st.devices, []);
  const r = ok(await nav.post('/api/me/field-device/request', {}));
  assert.equal(r.request.status, 'open');
  assert.ok(r.administrators >= 2, 'both administrators');
  const titles = H.db.all(`SELECT t.*, u.username FROM tasks t JOIN users u ON u.id=t.assigned_to WHERE t.created_by=? AND t.client_id IS NULL`, navId)
    .map(t => ({ who: t.username, title: require('../server/crypto').decrypt(t.title_enc) })).filter(t => /Field device/.test(t.title));
  assert.ok(titles.some(t => t.who === 'oq_admin') && titles.some(t => t.who === 'oq_admin2'), JSON.stringify(titles));
  assert.ok(!titles.some(t => t.who === 'oq_sup'), 'not a supervisor: devices are an administrator\'s');
  // Asking again while it is open makes no more to-dos.
  const again = ok(await nav.post('/api/me/field-device/request', {}), 200);
  assert.equal(again.already, true);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='device.field_request' AND user_id=?`, navId));
  // The admin's to-do is on their list.
  const due = ok(await admin.get('/api/tasks?limit=100'), 200);
  assert.ok(due.rows.some(t => /Field device/.test(t.title || '')));
});

test('only an administrator answers; Approve holds the account to the field scope (narrowing), Decline does not', async () => {
  assert.equal((await nav.get('/api/admin/field-requests')).status, 403);
  assert.equal((await sup.get('/api/admin/field-requests')).status, 403);
  assert.equal((await nav.post(`/api/admin/field-requests/${navId}/approve`, {})).status, 403);
  const list = ok(await admin.get('/api/admin/field-requests'), 200);
  assert.ok(list.requests.some(x => x.user_id === navId && x.username === 'oq_nav'));
  ok(await admin.post(`/api/admin/field-requests/${navId}/approve`, {}), 200);
  assert.equal(H.db.one(`SELECT bound_via FROM field_accounts WHERE user_id=?`, navId).bound_via, 'admin');
  assert.equal(count(`SELECT COUNT(*) n FROM tasks WHERE created_by=? AND client_id IS NULL AND status='open'`, navId), 0, 'the to-dos are done');
  assert.equal((ok(await nav.get('/api/me/field-device'), 200)).request.status, 'approved');
  assert.equal((ok(await nav.get('/api/me/field-device'), 200)).account_field, true);
  assert.equal((await admin.post(`/api/admin/field-requests/${navId}/approve`, {})).status, 404, 'answered once');
  // Decline: nothing about the account changes.
  ok(await nav2.post('/api/me/field-device/request', {}));
  ok(await admin2.post(`/api/admin/field-requests/${nav2Id}/decline`, {}), 200);
  assert.equal(H.db.one(`SELECT 1 FROM field_accounts WHERE user_id=?`, nav2Id), undefined);
  assert.equal((ok(await nav2.get('/api/me/field-device'), 200)).request.status, 'declined');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='device.field_request.decline' AND entity_id=?`, nav2Id));
  // Declined, they may ask again.
  ok(await nav2.post('/api/me/field-device/request', {}));
});

// ---- 1.23.1: the administrators' to-dos say how the request ended, and a request that can no longer be answered
// (the worker's account deactivated) is closed with its to-dos, not left open on the administrators' lists ----
const fieldTodos = (uid) => H.db.all(`SELECT * FROM tasks WHERE created_by=? AND client_id IS NULL`, uid)
  .map(t => ({ ...t, title: require('../server/crypto').decrypt(t.title_enc), details: t.description_enc ? require('../server/crypto').decrypt(t.description_enc) : '' }))
  .filter(t => /^Field device:/.test(t.title));

test('an answered request closes every administrator\'s to-do with who answered and how (1.23.1)', async () => {
  const done = fieldTodos(navId);
  assert.ok(done.length >= 2 && done.every(t => t.status === 'done' && /Approved by oq_admin/.test(t.details)), JSON.stringify(done.map(t => [t.status, t.details.slice(-60)])));
  // nav2 asked again after the decline: decline that one too, and its to-dos say so.
  ok(await admin.post(`/api/admin/field-requests/${nav2Id}/decline`, {}), 200);
  const declined = fieldTodos(nav2Id);
  assert.ok(declined.length >= 4 && declined.every(t => t.status === 'cancelled' && /Not approved by/.test(t.details)), JSON.stringify(declined.map(t => t.status)));
  assert.ok(H.db.all(`SELECT details FROM audit_log WHERE action='task.update' AND details LIKE '%field_request%'`).length >= 6, 'each closed to-do is audited');
});

test('deactivating a worker with an open field-device request closes it and the administrators\' to-dos (1.23.1)', async () => {
  const leaverId = H.makeUser('oq_leaver', 'navigator').id;
  const leaver = H.client(); await leaver.login('oq_leaver', 'StaffPassw0rd!x');
  ok(await leaver.post('/api/me/field-device/request', {}));
  assert.ok(fieldTodos(leaverId).filter(t => t.status === 'open').length >= 2);
  ok(await admin.put(`/api/users/${leaverId}`, { is_active: false }), 200);
  const todos = fieldTodos(leaverId);
  assert.ok(todos.length >= 2 && todos.every(t => t.status === 'cancelled' && /account was deactivated/.test(t.details)), JSON.stringify(todos.map(t => t.status)));
  assert.equal(JSON.parse(H.db.getSetting(`field_request:${leaverId}`)).status, 'closed');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='device.field_request.close' AND entity_id=?`, leaverId);
  assert.ok(a, 'audited'); assert.equal(JSON.parse(a.details).todos_closed, todos.length);
  assert.ok(!ok(await admin.get('/api/admin/field-requests'), 200).requests.some(x => x.user_id === leaverId));
  // Re-enabled, they may ask again.
  ok(await admin.put(`/api/users/${leaverId}`, { is_active: true }), 200);
  await leaver.login('oq_leaver', 'StaffPassw0rd!x');
  assert.equal(ok(await leaver.post('/api/me/field-device/request', {})).request.status, 'open');
});

test('SCIM deactivation closes it too, and one left open before 1.23.1 is closed when the list is read (1.23.1)', async () => {
  const scimId = H.makeUser('oq_scim', 'navigator').id;
  const s = H.client(); await s.login('oq_scim', 'StaffPassw0rd!x');
  ok(await s.post('/api/me/field-device/request', {}));
  require('../server/scim').deactivate(scimId, { username: 'system' });
  assert.equal(JSON.parse(H.db.getSetting(`field_request:${scimId}`)).status, 'closed');
  assert.equal(fieldTodos(scimId).filter(t => t.status === 'open').length, 0);
  // Before 1.23.1 a deactivation left the request open: the administrators' list closes it as it skips it.
  const oldId = H.makeUser('oq_old', 'navigator').id;
  const o = H.client(); await o.login('oq_old', 'StaffPassw0rd!x');
  ok(await o.post('/api/me/field-device/request', {}));
  H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, oldId);
  assert.ok(!ok(await admin.get('/api/admin/field-requests'), 200).requests.some(x => x.user_id === oldId));
  assert.equal(fieldTodos(oldId).filter(t => t.status === 'open').length, 0, 'its to-dos are closed');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='device.field_request.close' AND entity_id=?`, oldId));
});

test('the list of requests reads only field_request: settings (`_` is not a wildcard) (1.23.1)', async () => {
  const otherId = H.makeUser('oq_lookalike', 'navigator').id;
  H.db.setSetting(`fieldXrequest:${otherId}`, JSON.stringify({ status: 'open', at: H.db.now(), tasks: [] }));
  assert.ok(!ok(await admin.get('/api/admin/field-requests'), 200).requests.some(x => x.user_id === otherId));
});
