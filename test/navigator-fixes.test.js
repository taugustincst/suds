'use strict';
// The navigator-facing fixes: intake opens an episode, re-admission, due-soon reminders, names on the
// to-do/call/time lists, an author asking for a co-sign, alias search, caseload sort, hand-offs, safety
// plans and the supply cupboard.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, nav, sup, fin, ro, navId, supId;
before(async () => {
  await H.start();
  navId = H.makeUser('nfnav', 'navigator').id;
  supId = H.makeUser('nfsup', 'supervisor').id;
  H.makeUser('nffin', 'finance'); H.makeUser('nfro', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nfnav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('nfsup', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('nffin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('nfro', 'StaffPassw0rd!x');
});
after(H.stop);

test('intake opens the first episode of care; no_episode and a waitlist entry do not', async () => {
  const r = await nav.post('/api/clients', { first_name: 'Ep', last_name: 'Intake', intake_date: '2026-03-01', referral_source: 'jail' });
  assert.equal(r.status, 201);
  assert.ok(r.data.episode_id, 'the response names the episode');
  const e = H.db.one(`SELECT * FROM episodes WHERE client_id=?`, r.data.id);
  assert.equal(e.status, 'open'); assert.equal(e.opened_at, '2026-03-01'); assert.equal(e.opened_by, navId); assert.equal(e.referral_source, 'jail');
  const detail = (await nav.get(`/api/clients/${r.data.id}`)).data.client;
  assert.equal(detail.counts.episodes, 1); assert.equal(detail.open_episode, true);
  assert.equal((await nav.post(`/api/clients/${r.data.id}/episodes`, {})).status, 400, 'a second open episode is refused');

  const quiet = await nav.post('/api/clients', { first_name: 'No', last_name: 'Episode', no_episode: true });
  assert.equal(quiet.data.episode_id, null);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM episodes WHERE client_id=?`, quiet.data.id).n, 0);
  const waiting = await nav.post('/api/clients', { first_name: 'Still', last_name: 'Waiting', status: 'waitlist' });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM episodes WHERE client_id=?`, waiting.data.id).n, 0, 'a waitlisted person has not been admitted');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='episode.open' AND entity_id=?`, r.data.episode_id), 'the automatic admission is audited');
});

test('a closed episode can be reopened (re-admission), which makes the client active again', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Re', last_name: 'Admit' })).data;
  const close = await nav.post(`/api/episodes/${c.episode_id}/close`, { discharge_reason: 'lost_contact' });
  assert.equal(close.status, 200);
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, c.id).status, 'closed');
  assert.equal((await nav.post(`/api/episodes/${c.episode_id}/reopen`, {})).status, 200);
  const e = H.db.one(`SELECT * FROM episodes WHERE id=?`, c.episode_id);
  assert.equal(e.status, 'open'); assert.equal(e.closed_at, null); assert.equal(e.discharge_reason, null);
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, c.id);
  assert.equal(row.status, 'active'); assert.equal(row.discharge_date, null);
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND end_date IS NULL`, c.id, navId), 'the re-admitting worker holds the case again');
  assert.equal((await nav.post(`/api/episodes/${c.episode_id}/reopen`, {})).status, 400, 'an open episode cannot be reopened');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='episode.reopen' AND entity_id=?`, c.episode_id));
  assert.equal((await ro.post(`/api/episodes/${c.episode_id}/reopen`, {})).status, 403, 'read-only cannot re-admit');
});

test('due-soon reminders: overdue and within the hour, caseload scoped, with the client\'s name', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Due', last_name: 'Soon' })).data.id;
  const soon = new Date(Date.now() + 30 * 60000).toISOString();
  const later = new Date(Date.now() + 5 * 3600000).toISOString();
  await nav.post('/api/tasks', { client_id: c, title: 'Call in 30 min', due_at: soon });
  await nav.post('/api/tasks', { client_id: c, title: 'Yesterday', due_at: '2020-01-01' });
  await nav.post('/api/tasks', { client_id: c, title: 'This afternoon', due_at: later });
  await nav.post('/api/tasks', { title: 'Own errand, overdue', due_at: '2020-01-02T09:00:00.000Z' });
  const r = await nav.get('/api/tasks/due?within=60');
  assert.equal(r.status, 200);
  const titles = r.data.rows.map(t => t.title);
  assert.ok(titles.includes('Call in 30 min') && titles.includes('Yesterday') && titles.includes('Own errand, overdue'), titles.join());
  assert.ok(!titles.includes('This afternoon'), 'five hours away is not "due soon"');
  assert.equal(r.data.overdue, 2); assert.equal(r.data.due_soon, 1);
  assert.equal(r.data.rows.find(t => t.title === 'Yesterday').overdue, true);
  assert.equal(r.data.rows.find(t => t.title === 'Call in 30 min').client_name, 'Soon, Due');
  assert.equal((await sup.get('/api/tasks/due')).data.rows.some(t => t.title === 'Yesterday'), false, 'someone else\'s to-dos are not theirs');
  assert.equal((await fin.get('/api/tasks/due')).status, 403, 'no tasks permission, no reminders');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='task.due' AND user_id=?`, navId));
  // The poll is audited when its answer changes, not on every repetition
  const audits = () => H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='task.due' AND user_id=?`, navId).n;
  const n0 = audits();
  await nav.get('/api/tasks/due?within=60'); await nav.get('/api/tasks/due?within=60');
  assert.equal(audits(), n0, 'the same answer twice more writes nothing');
  await nav.post('/api/tasks', { title: 'Another overdue one', due_at: '2020-01-03' });
  await nav.get('/api/tasks/due?within=60');
  assert.equal(audits(), n0 + 1, 'a changed answer is audited');
  // "Today" for a calendar-day deadline is the organisation's day, computed once for SQL and JS alike
  const config = require('../server/config'); const { localDate } = require('../server/routes/budget');
  const was = config.orgTimezone;
  try {
    // Kiritimati (UTC+14) and Etc/GMT+12 (UTC-12) are 26 hours apart, so their calendar dates always differ.
    const eastDay = localDate(new Date(), 'Pacific/Kiritimati');
    await nav.post('/api/tasks', { title: 'Due on the eastern day', due_at: eastDay });
    config.orgTimezone = 'Pacific/Kiritimati';
    let rows = (await nav.get('/api/tasks/due?within=0')).data.rows;
    assert.ok(rows.some(t => t.title === 'Due on the eastern day'), 'due today in the org zone');
    assert.equal(rows.find(t => t.title === 'Due on the eastern day').overdue, false, 'due today is not overdue');
    config.orgTimezone = 'Etc/GMT+12';
    rows = (await nav.get('/api/tasks/due?within=0')).data.rows;
    assert.ok(!rows.some(t => t.title === 'Due on the eastern day'), 'not yet that day in the org zone');
    const overdue = (await nav.get('/api/tasks?overdue=1')).data.rows;
    assert.ok(!overdue.some(t => t.title === 'Due on the eastern day'), 'nor overdue');
  } finally { config.orgTimezone = was; }
});

test('to-do, call and time lists carry the client\'s name, never for a de-identified role', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Named', last_name: 'Person' })).data.id;
  await nav.post('/api/tasks', { client_id: c, title: 'Named task' });
  await nav.post('/api/calls', { client_id: c, direction: 'outbound', started_at: new Date().toISOString(), duration_minutes: 3, outcome: 'reached' });
  await nav.post('/api/time', { client_id: c, work_date: new Date().toISOString().slice(0, 10), minutes: 10, category: 'direct_service' });
  const t = (await nav.get(`/api/tasks?client_id=${c}`)).data.rows[0];
  assert.equal(t.client_name, 'Person, Named'); assert.ok(t.client_code); assert.equal(t.c_first_name_enc, undefined, 'the ciphertext is not leaked');
  assert.equal((await nav.get(`/api/calls?client_id=${c}`)).data.rows[0].client_name, 'Person, Named');
  assert.equal((await nav.get(`/api/time?client_id=${c}`)).data.rows[0].client_name, 'Person, Named');
  // finance holds time:read but only a de-identified client list: the code, never the name
  const ft = (await fin.get(`/api/time?client_id=${c}`)).data.rows.find(x => x.client_id === c);
  assert.ok(ft, 'finance sees the time entry'); assert.equal(ft.client_name, null); assert.ok(ft.client_code);
});

test('an author can ask a supervisor to co-sign a note, which puts it in the queue', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Co', last_name: 'Sign' })).data.id;
  // on a draft, via the editor checkbox
  const draft = await nav.post('/api/notes', { client_id: c, kind: 'admin', title: 'Hard visit', content: 'Client disclosed something I want reviewed.', occurred_at: new Date().toISOString(), cosign_requested: true });
  assert.equal(draft.status, 201);
  let n = (await nav.get(`/api/notes/${draft.data.id}`)).data.note;
  assert.equal(n.cosign_requested, true); assert.equal(n.awaiting_cosign, false, 'not in the queue until signed');
  assert.equal((await sup.get('/api/supervision/queue')).data.awaiting_cosignature.some(x => x.id === draft.data.id), false);
  await nav.post(`/api/notes/${draft.data.id}/sign`, { password: 'StaffPassw0rd!x' });
  n = (await nav.get(`/api/notes/${draft.data.id}`)).data.note;
  assert.equal(n.awaiting_cosign, true);
  const q = (await sup.get('/api/supervision/queue')).data.awaiting_cosignature.find(x => x.id === draft.data.id);
  assert.ok(q, 'the signed note is waiting for a supervisor'); assert.equal(q.cosign_requested, 1);
  assert.ok((await sup.get('/api/notes?awaiting_cosign=1')).data.rows.some(x => x.id === draft.data.id));

  // on an already-signed note, via "Send to supervisor"
  const signed = await nav.post('/api/notes', { client_id: c, kind: 'admin', content: 'Routine.', occurred_at: new Date().toISOString() });
  await nav.post(`/api/notes/${signed.data.id}/sign`, { password: 'StaffPassw0rd!x' });
  assert.equal((await sup.get('/api/supervision/queue')).data.awaiting_cosignature.some(x => x.id === signed.data.id), false, 'a plain signed note is not queued');
  const req = await nav.post(`/api/notes/${signed.data.id}/request-cosign`, {});
  assert.equal(req.status, 200); assert.equal(req.data.awaiting_cosign, true);
  assert.ok((await sup.get('/api/supervision/queue')).data.awaiting_cosignature.some(x => x.id === signed.data.id), 'now it is');
  assert.equal((await sup.post(`/api/notes/${signed.data.id}/cosign`, { password: 'StaffPassw0rd!x' })).status, 200, 'and the supervisor countersigns it');
  assert.equal((await sup.get('/api/supervision/queue')).data.awaiting_cosignature.some(x => x.id === signed.data.id), false, 'then it leaves the queue');
  assert.equal((await nav.post(`/api/notes/${signed.data.id}/request-cosign`, {})).status, 400, 'a countersigned note needs no further review');
  // only the author (or a manager) may ask
  const other = H.client(); H.makeUser('nfnav2', 'navigator'); await other.login('nfnav2', 'StaffPassw0rd!x');
  await sup.post(`/api/clients/${c}/assignments`, { user_id: H.db.one(`SELECT id FROM users WHERE username='nfnav2'`).id, role_on_case: 'secondary' });
  assert.equal((await other.post(`/api/notes/${draft.data.id}/request-cosign`, {})).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.cosign.requested' AND entity_id=?`, signed.data.id));
});

test('a preferred name or alias finds the person, and the index follows edits', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Jamie', last_name: 'Aliased', preferred_name: 'Jaybird' })).data.id;
  const row = H.db.one(`SELECT preferred_name_idx FROM clients WHERE id=?`, c);
  assert.ok(row.preferred_name_idx, 'the blind index is written');
  assert.ok((await nav.get('/api/clients?q=Jaybird&status=all')).data.clients.some(x => x.id === c), 'search by alias');
  assert.ok((await nav.get('/api/clients?q=jaybird&status=all')).data.clients.some(x => x.id === c), 'case-insensitively');
  await nav.put(`/api/clients/${c}`, { preferred_name: 'Sparrow' });
  assert.ok(!(await nav.get('/api/clients?q=Jaybird&status=all')).data.clients.some(x => x.id === c), 'the old alias no longer matches');
  assert.ok((await nav.get('/api/clients?q=Sparrow&status=all')).data.clients.some(x => x.id === c), 'the new one does');
  await nav.put(`/api/clients/${c}`, { preferred_name: null });
  assert.equal(H.db.one(`SELECT preferred_name_idx FROM clients WHERE id=?`, c).preferred_name_idx, null, 'a cleared alias clears its index');
});

test('caseload sort: oldest contact first, overdue follow-ups, risk', async () => {
  const mk = async (last, risk) => (await nav.post('/api/clients', { first_name: 'Sort', last_name: last, risk_level: risk })).data.id;
  const stale = await mk('Stale', 'low'), fresh = await mk('Fresh', 'critical'), slipping = await mk('Slipping', 'moderate');
  await nav.post('/api/interventions', { client_id: fresh, type: 'outreach', occurred_at: new Date().toISOString(), duration_minutes: 5 });
  await nav.post('/api/interventions', { client_id: stale, type: 'outreach', occurred_at: '2024-01-01T10:00:00.000Z', duration_minutes: 5 });
  await nav.post('/api/tasks', { client_id: slipping, title: 'Late follow-up', due_at: '2020-01-01' });
  const ids = async (sort) => (await nav.get(`/api/clients?status=all&q=Sort&sort=${sort}`)).data.clients.map(x => x.id);
  const lc = await ids('last_contact');
  assert.ok(lc.indexOf(stale) < lc.indexOf(fresh), 'the person not seen since 2024 comes before the one seen today');
  assert.ok(lc.indexOf(slipping) < lc.indexOf(stale), 'never contacted sorts first of all');
  assert.equal((await ids('overdue'))[0], slipping, 'overdue follow-ups first');
  assert.equal((await ids('risk'))[0], fresh, 'critical risk first');
  const rows = (await nav.get(`/api/clients?status=all&q=Sort&sort=overdue`)).data.clients;
  assert.equal(rows.find(x => x.id === slipping).overdue_tasks, 1, 'the overdue count comes with the row');
  assert.equal((await nav.get('/api/clients?status=all&sort=nonsense')).status, 200, 'an unknown sort falls back to the default');
});

test('shift hand-off notes from the last 24 hours are listed for the team', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Hand', last_name: 'Off' })).data.id;
  const fresh = await nav.post('/api/notes', { client_id: c, kind: 'admin', format: 'handoff', title: 'Bed tomorrow', content: 'Detox bed at 8am, needs a ride.', occurred_at: new Date().toISOString() });
  assert.equal(fresh.status, 201, 'handoff is a valid note format');
  await nav.post('/api/notes', { client_id: c, kind: 'admin', format: 'handoff', title: 'Old', content: 'Last week.', occurred_at: new Date(Date.now() - 3 * 86400000).toISOString() });
  await nav.post('/api/notes', { client_id: c, kind: 'admin', format: 'contact', title: 'Not a handoff', content: 'x', occurred_at: new Date().toISOString() });
  const r = await sup.get('/api/notes/handoffs');
  assert.equal(r.status, 200);
  const titles = r.data.rows.map(x => x.title);
  assert.ok(titles.includes('Bed tomorrow')); assert.ok(!titles.includes('Old')); assert.ok(!titles.includes('Not a handoff'));
  const row = r.data.rows.find(x => x.title === 'Bed tomorrow');
  assert.equal(row.client_name, 'Off, Hand'); assert.match(row.excerpt, /Detox bed/); assert.equal(row.content_enc, undefined);
  assert.equal((await fin.get('/api/notes/handoffs')).status, 403);
});

test('a safety plan is a structured note the client overview can point at', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Safe', last_name: 'Plan' })).data.id;
  assert.equal((await nav.get(`/api/clients/${c}`)).data.client.safety_plan, null);
  const plan = { warning_signs: 'Not sleeping', coping: 'Walk', distraction: 'Cafe', people_to_ask: 'Sister', professionals: 'Crisis line 988', environment: 'Naloxone on hand', reasons_for_living: 'Kids' };
  const n = await nav.post('/api/notes', { client_id: c, kind: 'admin', format: 'safety_plan', title: 'Safety plan', content: 'see sections', structured: plan, occurred_at: '2026-09-01T10:00:00.000Z' });
  assert.equal(n.status, 201);
  // A draft is not a plan anyone should act on: the chip appears once the plan is signed.
  assert.equal((await nav.get(`/api/clients/${c}`)).data.client.safety_plan, null, 'an unsigned plan is not offered');
  assert.equal((await nav.post(`/api/notes/${n.data.id}/sign`, { password: 'StaffPassw0rd!x' })).status, 200);
  const sp = (await nav.get(`/api/clients/${c}`)).data.client.safety_plan;
  assert.equal(sp.id, n.data.id); assert.equal(sp.occurred_at, '2026-09-01T10:00:00.000Z'); assert.equal(sp.status, 'signed');
  assert.deepEqual((await nav.get(`/api/notes/${n.data.id}`)).data.note.structured, plan);
});

test('supply inventory: visit-recording roles read it, field staff change it, a visit draws it down', async () => {
  assert.equal((await ro.get('/api/supplies')).status, 403, 'read-only has no visits to record, so no cupboard to look in');
  assert.equal((await fin.post('/api/supplies', { item: 'Naloxone kit', quantity: 5 })).status, 403, 'finance cannot stock it');
  assert.equal((await ro.post('/api/supplies', { item: 'Naloxone kit', quantity: 5 })).status, 403);
  const add = await nav.post('/api/supplies', { item: 'Naloxone kit', quantity: 10 });
  assert.equal(add.status, 201);
  assert.equal((await nav.post('/api/supplies', { item: 'naloxone KIT', quantity: 12 })).status, 200, 'the same item (any case) is updated, not duplicated');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM supply_stock`).n, 1);
  const strips = (await nav.post('/api/supplies', { item: 'Fentanyl test strips', quantity: 50 })).data;
  assert.equal((await nav.put(`/api/supplies/${strips.id}`, { adjust: 25 })).data.quantity, 75, 'a delivery adjusts the count');

  const c = (await nav.post('/api/clients', { first_name: 'Kit', last_name: 'Taker' })).data.id;
  const visit = await nav.post('/api/interventions', { client_id: c, type: 'naloxone_distribution', occurred_at: new Date().toISOString(), duration_minutes: 5, naloxone_kits: 2, fentanyl_strips: 10 });
  assert.equal(visit.status, 201);
  const q = () => Object.fromEntries(H.db.all(`SELECT item, quantity FROM supply_stock`).map(x => [x.item, x.quantity]));
  assert.equal(q()['Naloxone kit'], 10); assert.equal(q()['Fentanyl test strips'], 65);
  await nav.put(`/api/interventions/${visit.data.id}`, { naloxone_kits: 3 });
  assert.equal(q()['Naloxone kit'], 9, 'editing the count only draws down the difference');
  await nav.put(`/api/interventions/${visit.data.id}`, { naloxone_kits: 1 });
  assert.equal(q()['Naloxone kit'], 11, 'and gives it back when lowered');
  await nav.post('/api/interventions', { client_id: c, type: 'naloxone_distribution', occurred_at: new Date().toISOString(), naloxone_kits: 50 });
  assert.equal(q()['Naloxone kit'], 0, 'never below zero');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.drawdown'`));
  const list = (await nav.get('/api/supplies')).data;
  assert.equal(list.drawdown.naloxone_kits, 'Naloxone kit');
  assert.ok(list.rows.every(x => x.updated_by_name));
  assert.equal((await nav.del(`/api/supplies/${strips.id}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='supply_stock' AND id=?`, strips.id));
});

test('the sample data set gives every admitted client an episode and stocks the cupboard', () => {
  const demo = require('../server/demo');
  const adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  const s = demo.seed({ actor: adminId, workers: [navId], supervisor: supId, seedValue: 7 });
  assert.ok(s.counts.episodes >= 10, `episodes seeded: ${s.counts.episodes}`);
  const missing = H.db.all(`SELECT c.client_code, c.status FROM clients c WHERE c.client_code LIKE 'DEMO-%' AND c.status <> 'waitlist' AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.client_id=c.id)`);
  assert.deepEqual(missing, []);
  assert.equal(H.db.one(`SELECT e.status FROM episodes e JOIN clients c ON c.id=e.client_id WHERE c.status='closed' AND c.client_code LIKE 'DEMO-%'`).status, 'closed');
  assert.ok(H.db.one(`SELECT 1 FROM notes WHERE format='handoff'`), 'a hand-off note');
  assert.ok(H.db.one(`SELECT 1 FROM notes WHERE format='safety_plan' AND structured_enc IS NOT NULL`), 'a safety plan');
  assert.ok(H.db.one(`SELECT 1 FROM supply_stock WHERE item='Naloxone kit'`));
  demo.remove({ actor: adminId });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE c.client_code LIKE 'DEMO-%'`).n, 0, 'removing the sample data removes its episodes');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM supply_stock WHERE item='Xylazine test strips'`).n, 0);
});
