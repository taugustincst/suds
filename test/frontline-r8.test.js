'use strict';
// The frontline-UX review of 1.16.2 (fixed in 1.16.3), at the API: a change notice in the client's timeline is
// what happened (the editor, the fields, who was told), never the to-do's text; the record's counts say how many
// real to-dos are overdue; a notice's title names the client as the lists do; the Notes list names the client.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const C = {}; const U = {};

before(async () => {
  await H.start();
  for (const [k, role] of [['primary', 'navigator'], ['other', 'navigator'], ['sup', 'supervisor']]) {
    const u = H.makeUser(`r8_${k}`, role); U[k] = u; C[k] = H.client(); await C[k].login(u.username, PW);
  }
});
after(() => H.stop());

test('a change notice in the timeline is who changed which fields and who was told, dated by the change', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Tia', last_name: 'Timeline' })).data.id;
  assert.equal((await C.other.put(`/api/clients/${id}`, { phone: '916-555-0144' })).status, 200);
  const task = H.db.one(`SELECT * FROM tasks WHERE client_id=? AND assigned_to=?`, id, U.primary.id);
  const tl = (await C.sup.get(`/api/clients/${id}/timeline`)).data.events;
  const ev = tl.find(e => e.id === task.id);
  assert.equal(ev.notice, true); assert.equal(ev.kind, 'notice');
  assert.equal(ev.worker, U.other.display_name || 'r8_other', 'the editor, whom the audit entry names');
  assert.match(ev.title, /\(not on the care team\) changed: Phone — .+ was told$/);
  assert.equal(ev.detail, null, 'never the to-do\'s own text');
  assert.equal(ev.at, task.created_at);
  // Its title, as the primary worker's lists show it: the client's name, not the code.
  const listed = (await C.primary.get(`/api/tasks?client_id=${id}`)).data.rows.find(t => t.id === task.id);
  assert.match(listed.title, /changed Timeline, Tia's record \(Phone\)/);
});

test('the record counts overdue to-dos apart from open ones and notices', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Otto', last_name: 'Overdue' })).data.id;
  await C.other.put(`/api/clients/${id}`, { phone: '916-555-0145' });
  let counts = (await C.primary.get(`/api/clients/${id}`)).data.client.counts;
  assert.deepEqual([counts.open_tasks, counts.notices, counts.overdue_tasks], [1, 1, 0]);
  await C.primary.post('/api/tasks', { title: 'Call back', client_id: id, due_at: new Date(Date.now() - 3600e3).toISOString() });
  await C.primary.post('/api/tasks', { title: 'Later', client_id: id, due_at: new Date(Date.now() + 86400e3).toISOString() });
  counts = (await C.primary.get(`/api/clients/${id}`)).data.client.counts;
  assert.deepEqual([counts.open_tasks, counts.notices, counts.overdue_tasks], [3, 1, 1]);
});

test('the Notes list names the client for a reader who may see names', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Nia', last_name: 'Noted' })).data.id;
  assert.equal((await C.primary.post('/api/notes', { client_id: id, kind: 'admin', format: 'narrative', occurred_at: new Date().toISOString(), content: 'Met.' })).status, 201);
  const row = (await C.sup.get(`/api/notes?client_id=${id}`)).data.rows[0];
  assert.equal(row.client_name, 'Noted, Nia');
  assert.ok(row.client_code && !('c_first_name_enc' in row), 'with the code, and no encrypted columns');
});
