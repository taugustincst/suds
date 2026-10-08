'use strict';
const LD = require('../server/local-date'); // the programme's calendar, as the server dates things
// Day-to-day usefulness for frontline workers (1.22.0, docs/USER_GUIDE.md), what the server decides:
//   * a call or text with a "remind me to call back on" date is a follow-up whether or not the box was ticked too,
//     so the to-do is made (a date with the box left unticked used to make none);
//   * Street outreach's Undo takes back a contact its worker just saved: the worker may delete their own anonymous
//     visit, the supplies go back on the stock, it is audited, and no one else's contact can be taken back that way;
//   * the supervision queue says who made each referral still waiting for an outcome, so a supervisor knows whom to ask.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
let sup, nav, nav2, clientId, office;
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const tomorrow = () => LD.addDays(LD.today(), 1);

before(async () => {
  await H.start();
  H.makeUser('wusup', 'supervisor'); H.makeUser('wunav', 'navigator'); H.makeUser('wunav2', 'navigator');
  sup = H.client(); await sup.login('wusup', PW);
  nav = H.client(); await nav.login('wunav', PW);
  nav2 = H.client(); await nav2.login('wunav2', PW);
  clientId = ok(await nav.post('/api/clients', { first_name: 'Wren', last_name: 'Usefulness', status: 'active' })).id;
  office = H.db.MAIN_SITE_ID;
});
after(H.stop);

const callTasks = (purposeWord) => H.db.all(`SELECT * FROM tasks WHERE client_id=?`, clientId)
  .filter(t => require('../server/crypto').decrypt(t.title_enc).includes(purposeWord));

test('a call-back date makes the follow-up to-do even when "Follow-up needed" was not ticked', async () => {
  const due = tomorrow();
  const c = ok(await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: minutesAgo(5), purpose: 'Bedcheck', outcome: 'voicemail', follow_up_due: due }));
  const row = H.db.one(`SELECT follow_up_needed, follow_up_due FROM calls WHERE id=?`, c.id);
  assert.equal(row.follow_up_needed, 1, 'the date marks the call as needing a follow-up');
  const t = callTasks('Bedcheck');
  assert.equal(t.length, 1, 'and its to-do is on the worker\'s list');
  assert.equal(t[0].due_at, due);
  // A text works the same way, and a call with no date makes no to-do.
  ok(await nav.post('/api/calls', { client_id: clientId, method: 'text', direction: 'outbound', started_at: minutesAgo(4), purpose: 'Textcheck', follow_up_needed: false, follow_up_due: due }));
  assert.equal(callTasks('Textcheck').length, 1);
  const none = ok(await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: minutesAgo(3), purpose: 'Nodate' }));
  assert.equal(H.db.one(`SELECT follow_up_needed FROM calls WHERE id=?`, none.id).follow_up_needed, 0);
  assert.equal(callTasks('Nodate').length, 0);
  // Adding a date to a call later marks it too.
  ok(await nav.put(`/api/calls/${none.id}`, { follow_up_due: due }), 200);
  assert.equal(H.db.one(`SELECT follow_up_needed FROM calls WHERE id=?`, none.id).follow_up_needed, 1);
});

test('Undo on Street outreach: a worker takes back their own contact, the stock comes back, and it is audited', async () => {
  const kit = ok(await sup.post('/api/supplies/items', { name: 'WU naloxone kit', category: 'naloxone', quick: true })).id;
  ok(await sup.post('/api/supplies/receipts', { item_id: kit, site_id: office, quantity: 10, lot_number: 'WU-1', expires_on: '2030-01-01', source: 'purchase' }));
  const onHand = () => H.db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=?`, kit, office).n;
  const contact = (c) => c.post('/api/interventions', { type: 'outreach', occurred_at: minutesAgo(1), location: 'street', modality: 'in_person', supply_site_id: office, supplies: [{ item_id: kit, quantity: 2 }] });
  const a = ok(await contact(nav));
  assert.equal(onHand(), 8);
  const shift = async () => ok(await nav.get('/api/outreach/shift'), 200).contacts;
  const before = await shift();
  // Someone else's contact cannot be taken back by another navigator.
  const other = ok(await contact(nav2));
  assert.equal((await nav.del(`/api/interventions/${other.id}`)).status, 403);
  ok(await nav.del(`/api/interventions/${a.id}`), 200);
  assert.equal(H.db.one(`SELECT id FROM interventions WHERE id=?`, a.id), undefined, 'the contact is gone');
  assert.equal(onHand(), 8, 'its two kits are back on the stock (the colleague\'s two are still out)');
  assert.equal(await shift(), before - 1, 'and My shift no longer counts it');
  const audit = H.db.one(`SELECT * FROM audit_log WHERE action='intervention.delete' AND entity_id=?`, a.id);
  assert.ok(audit, 'the deletion is in the audit log');
});

test('the supervision queue names who made each referral still waiting for an outcome', async () => {
  const res = ok(await sup.post('/api/resources', { name: 'WU Detox', category: 'detox_withdrawal_mgmt' })).id;
  ok(await sup.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'WU Detox', purpose: 'Referral', ...ELEMENTS }));
  const consent = H.db.one(`SELECT id FROM consents WHERE client_id=? ORDER BY created_at DESC LIMIT 1`, clientId).id;
  const ref = ok(await nav.post('/api/referrals', { client_id: clientId, resource_id: res, referred_at: minutesAgo(60 * 24 * 9), status: 'contacted', consent_id: consent }));
  const row = ok(await sup.get('/api/supervision/queue'), 200).referrals_awaiting_outcome.find(x => x.id === ref.id);
  assert.ok(row, 'the referral is waiting for its outcome');
  const navUser = H.db.one(`SELECT id, display_name FROM users WHERE username='wunav'`);
  assert.equal(row.worker_id, navUser.id);
  assert.equal(row.worker, navUser.display_name, 'with the name of the worker who made it');
});
