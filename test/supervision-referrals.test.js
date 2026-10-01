'use strict';
// Supervision › "Waiting to hear what happened" (1.23.0, docs/USER_GUIDE.md › Supervision):
//   * only referrals that truly lack an outcome are listed: contacted (the provider has not answered) and
//     scheduled (nobody has recorded whether the appointment happened); accepted and waitlisted are the
//     provider's answer and are not; oldest first;
//   * a supervisor can remind the worker who made one: a to-do for that worker, on the client's record and linked
//     to the referral (recording the outcome closes it), encrypted, audited, one open reminder per referral;
//   * only a supervisor of that worker's team may (the queue's own scoping): not a navigator, not finance, not a
//     supervisor held to their own team for a worker outside it, and never to themselves.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
let sup, scoped, nav, nav2, fin, clientId, res, consent, navUser, nav2User, scopedUser;
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

before(async () => {
  await H.start();
  H.makeUser('srsup', 'supervisor');
  scopedUser = H.deny(H.makeUser('srscoped', 'supervisor'), 'clients:all');
  navUser = H.makeUser('srnav', 'navigator'); nav2User = H.makeUser('srnav2', 'navigator'); H.makeUser('srfin', 'finance');
  sup = H.client(); await sup.login('srsup', PW);
  scoped = H.client(); await scoped.login('srscoped', PW);
  nav = H.client(); await nav.login('srnav', PW);
  nav2 = H.client(); await nav2.login('srnav2', PW);
  fin = H.client(); await fin.login('srfin', PW);
  clientId = ok(await nav.post('/api/clients', { first_name: 'Sable', last_name: 'Remindwell', status: 'active' })).id;
  // The scoped supervisor has this client on their caseload, so only the team rule decides.
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date) VALUES(?,?,?,?,?)`, require('node:crypto').randomUUID(), clientId, scopedUser.id, 'supervisor', '2026-01-01');
  res = ok(await sup.post('/api/resources', { name: 'Remind Detox', category: 'detox_withdrawal_mgmt' })).id;
  ok(await sup.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'Remind Detox', purpose: 'Referral', ...ELEMENTS }));
  consent = H.db.one(`SELECT id FROM consents WHERE client_id=? ORDER BY created_at DESC LIMIT 1`, clientId).id;
});
after(H.stop);

const refer = async (c, status, days) => ok(await c.post('/api/referrals', { client_id: clientId, resource_id: res, referred_at: daysAgo(days), status, consent_id: consent })).id;
const queue = async (c = sup) => ok(await c.get('/api/supervision/queue'), 200).referrals_awaiting_outcome;

test('only contacted and scheduled referrals are waiting to hear what happened, oldest first', async () => {
  const scheduled = await refer(nav, 'scheduled', 3);
  const contacted = await refer(nav, 'contacted', 12);
  const accepted = await refer(nav, 'accepted', 20);
  const waitlisted = await refer(nav, 'waitlisted', 25);
  const rows = await queue();
  const ids = rows.map(x => x.id);
  assert.ok(ids.includes(scheduled) && ids.includes(contacted), 'contacted and scheduled are listed');
  assert.ok(!ids.includes(accepted) && !ids.includes(waitlisted), 'accepted and waitlisted are the provider\'s answer, not a missing outcome');
  assert.ok(ids.indexOf(contacted) < ids.indexOf(scheduled), 'the older one first');
  const row = rows.find(x => x.id === contacted);
  assert.equal(row.may_remind, true, 'a supervisor may remind the worker who made it');
  assert.equal(row.reminded_at, null);
});

test('a supervisor reminds the worker: an encrypted, audited to-do linked to the referral, one at a time', async () => {
  const id = await refer(nav, 'contacted', 9);
  const r = ok(await sup.post(`/api/supervision/referrals/${id}/remind`, {}), 200);
  const t = H.db.one(`SELECT * FROM tasks WHERE id=?`, r.task);
  assert.equal(t.assigned_to, navUser.id); assert.equal(t.client_id, clientId); assert.equal(t.referral_id, id); assert.equal(t.status, 'open');
  assert.ok(!t.title_enc.includes('Remind Detox') && !String(t.description_enc).includes('Remind Detox'), 'title and details are encrypted');
  // The worker sees it on their list, saying what to do and nothing about the client.
  const mine = ok(await nav.get('/api/tasks?status=open&limit=1000'), 200).rows.find(x => x.id === r.task);
  assert.match(mine.title, /Record what happened with your referral to Remind Detox/);
  assert.ok(!/Sable|Remindwell/.test(mine.title + mine.description), 'no client name in the reminder');
  const a = H.db.one(`SELECT * FROM audit_log WHERE action='referral.remind' AND entity_id=?`, id);
  assert.ok(a, 'the reminder is audited');
  assert.equal(a.client_id, clientId);
  assert.ok(!/Sable|Remindwell|Remind Detox/.test(a.details || ''), 'the audit entry names records, not people or providers');
  // The queue says it was sent, and a second reminder is refused while the first is open.
  assert.ok((await queue()).find(x => x.id === id).reminded_at);
  assert.equal((await sup.post(`/api/supervision/referrals/${id}/remind`, {})).status, 400);
  // Recording the outcome closes it.
  ok(await nav.post(`/api/referrals/${id}/outcome`, { status: 'admitted' }), 200);
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE id=?`, r.task).status, 'done');
  assert.ok(!(await queue()).some(x => x.id === id), 'and the referral leaves the list');
  assert.equal((await sup.post(`/api/supervision/referrals/${id}/remind`, {})).status, 400, 'a referral with an outcome needs no reminder');
});

test('only a supervisor of the worker\'s team may send one', async () => {
  const id = await refer(nav, 'scheduled', 6);
  assert.equal((await nav2.post(`/api/supervision/referrals/${id}/remind`, {})).status, 403, 'a navigator may not');
  assert.equal((await fin.post(`/api/supervision/referrals/${id}/remind`, {})).status, 403, 'finance may not');
  // A supervisor held to their own team (clients:all denied) may not remind someone outside it…
  assert.equal((await queue(scoped)).find(x => x.id === id).may_remind, false);
  assert.equal((await scoped.post(`/api/supervision/referrals/${id}/remind`, {})).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='authz.denied' AND user_id=?`, H.db.one(`SELECT id FROM users WHERE username='srnav2'`).id), 'refusals are audited');
  // …and may once the worker names them as supervisor.
  H.db.run(`UPDATE users SET supervisor_id=? WHERE id=?`, scopedUser.id, navUser.id);
  assert.equal((await queue(scoped)).find(x => x.id === id).may_remind, true);
  ok(await scoped.post(`/api/supervision/referrals/${id}/remind`, {}), 200);
  H.db.run(`UPDATE users SET supervisor_id=NULL WHERE id=?`, navUser.id);
});

test('a supervisor is not offered a reminder to themselves, and an unknown referral is not found', async () => {
  const own = await refer(sup, 'contacted', 4);
  assert.equal((await queue()).find(x => x.id === own).may_remind, false);
  assert.equal((await sup.post(`/api/supervision/referrals/${own}/remind`, {})).status, 400);
  assert.equal((await sup.post('/api/supervision/referrals/no-such-referral/remind', {})).status, 404);
  // A worker whose account is closed cannot be reminded.
  const gone = await refer(nav2, 'contacted', 5);
  H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, nav2User.id);
  assert.equal((await queue()).find(x => x.id === gone).may_remind, false);
  assert.equal((await sup.post(`/api/supervision/referrals/${gone}/remind`, {})).status, 400);
});
