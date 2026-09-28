'use strict';
// 1.15.3 (the UX fixes): the ranked search behind the box at the top of every page, the Undo behind a
// reversible action (ending an assignment, deactivating a resource, retiring a document), and the server side
// of the time and visit checks the forms make (time is logged only when asked; the lists the duplicate checks
// read).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, nav, sup, navId, supId;
before(async () => {
  await H.start();
  navId = H.makeUser('u13nav', 'navigator').id;
  supId = H.makeUser('u13sup', 'supervisor').id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('u13nav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('u13sup', 'StaffPassw0rd!x');
});
after(H.stop);

const names = (r) => r.data.clients.map(c => c.display_name);

test('search ranking: exact name first, then this person\'s recent clients, then partial, then sound-alikes', async () => {
  const mk = async (first, last) => (await admin.post('/api/clients', { first_name: first, last_name: last, no_episode: true })).data.id;
  await mk('Bea', 'Smyth'); // sounds like Smith (Soundex S530), no shared first three letters
  await mk('Cal', 'Smithers'); // starts with "smi"
  const recent = await mk('Dee', 'Smithson'); // starts with "smi", and the supervisor opened it
  await mk('Alex', 'Smith'); // the exact surname, created last so "most recently updated" cannot explain its place
  assert.equal((await sup.get(`/api/clients/${recent}`)).status, 200);

  const all = await sup.get('/api/clients?status=all&q=smith');
  assert.equal(all.status, 200);
  assert.deepStrictEqual(names(all), ['Smith, Alex', 'Smithson, Dee', 'Smithers, Cal', 'Smyth, Bea'], 'exact, recent, partial, sound-alike');
  // The same order for someone who has opened none of them, except that nobody is "recent".
  assert.deepStrictEqual(names(await admin.get('/api/clients?status=all&q=smith')).slice(0, 1), ['Smith, Alex']);

  // ?rank=1 (the global search box) sets a minimum: the sound-alike is dropped when anything matched better.
  const ranked = await sup.get('/api/clients?status=all&rank=1&q=smith');
  assert.deepStrictEqual(names(ranked), ['Smith, Alex', 'Smithson, Dee', 'Smithers, Cal']);
  assert.equal(ranked.data.total, 3, 'the total counts what is listed');
  // A misspelling with nothing better keeps its sound-alikes: they are the answer.
  const typo = await sup.get('/api/clients?status=all&rank=1&q=smeeth');
  assert.deepStrictEqual(names(typo).sort(), ['Smith, Alex', 'Smyth, Bea']);
});

test('search ranking keeps caseload scoping and the audit entry exactly as before', async () => {
  // Not on the navigator's caseload: an exact match they may not see stays out, however well it matches.
  await admin.post('/api/clients', { first_name: 'Hidden', last_name: 'Quenby', no_episode: true });
  const mine = (await nav.post('/api/clients', { first_name: 'Mine', last_name: 'Quenbyson' })).data.id;
  const r = await nav.get('/api/clients?status=all&rank=1&q=quenby');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data.clients.map(c => c.id), [mine], 'only the client on their caseload');
  const a = H.db.one(`SELECT * FROM audit_log WHERE user_id=? AND action='client.list' ORDER BY rowid DESC LIMIT 1`, navId);
  const d = JSON.parse(a.details);
  assert.equal(d.q, '[redacted]', 'what was searched for is not written to the audit log');
  assert.equal(d.count, 1);
  assert.ok(!/quenby/i.test(a.details));
});

test('ending an assignment can be undone: the same worker back on the case, audited as a restore', async () => {
  const c = (await admin.post('/api/clients', { first_name: 'Undo', last_name: 'Assign', no_episode: true })).data.id;
  const add = await sup.post(`/api/clients/${c}/assignments`, { user_id: navId, role_on_case: 'primary' });
  assert.equal(add.status, 201);
  assert.equal((await sup.post(`/api/assignments/${add.data.id}/end`, {})).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='assignment.end' AND entity_id=?`, add.data.id));
  // Restoring an assignment that is still current, or one from another client, is refused.
  const other = (await admin.post('/api/clients', { first_name: 'Other', last_name: 'Client', no_episode: true })).data.id;
  assert.equal((await sup.post(`/api/clients/${other}/assignments?restores=${add.data.id}`, { user_id: navId, role_on_case: 'primary' })).status, 400);
  assert.equal((await nav.post(`/api/clients/${c}/assignments?restores=${add.data.id}`, { user_id: navId, role_on_case: 'primary' })).status, 403, 'undo needs assignments:manage, like the End it undoes');
  const undo = await sup.post(`/api/clients/${c}/assignments?restores=${add.data.id}`, { user_id: navId, role_on_case: 'primary' });
  assert.equal(undo.status, 201);
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE id=? AND client_id=? AND user_id=? AND end_date IS NULL`, undo.data.id, c, navId), 'back on the case');
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE id=? AND end_date IS NOT NULL`, add.data.id), 'the ended one stays in the history');
  const a = H.db.one(`SELECT * FROM audit_log WHERE action='assignment.restore' AND entity_id=?`, undo.data.id);
  assert.ok(a, 'the undo is audited as a restore');
  assert.equal(JSON.parse(a.details).restores, add.data.id);
  assert.equal((await sup.post(`/api/clients/${c}/assignments?restores=${add.data.id}`, { user_id: supId, role_on_case: 'primary' })).status, 400, 'only the same worker can be restored');
});

test('deactivating a resource and retiring a document are undone through the edit route, audited as reactivations', async () => {
  const res = (await sup.post('/api/resources', { name: 'Undo Clinic', category: 'outpatient' })).data.id;
  assert.equal((await sup.del(`/api/resources/${res}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='resource.deactivate' AND entity_id=?`, res));
  assert.equal((await sup.put(`/api/resources/${res}`, { is_active: true })).status, 200);
  assert.equal(H.db.one(`SELECT is_active FROM resources WHERE id=?`, res).is_active, 1);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='resource.reactivate' AND entity_id=?`, res));
  // An ordinary edit of an active resource is still an update.
  assert.equal((await sup.put(`/api/resources/${res}`, { summary: 'Walk-in Tuesdays.' })).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='resource.update' AND entity_id=?`, res));

  const created = await admin.post('/api/documents', { title: 'Undo Policy', category: 'policy', file_url: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64'), filename: 'undo.pdf' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const doc = created.data.id;
  assert.equal((await admin.del(`/api/documents/${doc}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='document.retire' AND entity_id=?`, doc));
  assert.equal((await admin.put(`/api/documents/${doc}`, { is_active: true })).status, 200);
  assert.equal(H.db.one(`SELECT is_active FROM policy_documents WHERE id=?`, doc).is_active, 1);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='document.reactivate' AND entity_id=?`, doc));
  assert.equal((await nav.put(`/api/documents/${doc}`, { is_active: true })).status, 403, 'undo needs documents:write, like Retire');
});

test('a visit or call logs time only when asked, and the lists the forms\' duplicate checks read', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Time', last_name: 'Check' })).data.id;
  const day = new Date(); day.setHours(10, 0, 0, 0);
  const v1 = await nav.post('/api/interventions', { client_id: c, type: 'case_management', occurred_at: day.toISOString(), duration_minutes: 30 });
  assert.equal(v1.status, 201);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM time_entries WHERE intervention_id=?`, v1.data.id).n, 0, 'no log_time, no time entry');
  const v2 = await nav.post('/api/interventions', { client_id: c, type: 'case_management', occurred_at: day.toISOString(), duration_minutes: 45, log_time: true });
  assert.equal(H.db.one(`SELECT minutes FROM time_entries WHERE intervention_id=?`, v2.data.id).minutes, 45);
  const call = await nav.post('/api/calls', { client_id: c, direction: 'outbound', started_at: day.toISOString(), duration_minutes: 5, contact_type: 'client', outcome: 'reached' });
  assert.equal(call.status, 201);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM time_entries WHERE call_id=?`, call.data.id).n, 0, 'a call without log_time logs none');

  // The visit form's "Save another visit?": the same client, type and local day, through the ordinary list.
  const from = new Date(day); from.setHours(0, 0, 0, 0); const to = new Date(day); to.setHours(23, 59, 59, 999);
  const same = await nav.get(`/api/interventions?client_id=${c}&type=case_management&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=5`);
  assert.equal(same.status, 200); assert.equal(same.data.rows.length, 2);
  const otherType = await nav.get(`/api/interventions?client_id=${c}&type=outreach&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=5`);
  assert.equal(otherType.data.rows.length, 0);
  // The time form's overlap notice: the day's entries, with where each came from.
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const t = await nav.get(`/api/time?from=${ymd}&to=${ymd}&limit=200`);
  assert.deepStrictEqual(t.data.rows.filter(r => r.client_id === c).map(r => r.source), ['visit']);
});
