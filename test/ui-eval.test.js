'use strict';
// The UI evaluation fixes (1.15.2) that rest on the server: the supervision queue names each draft's author so
// a supervisor can send them a reminder to-do through the ordinary to-do route, and the users list counts each
// person's individual permission overrides for the badge on their row. No new route: the reminder is a task.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, sup, nav, navId, supId;
before(async () => {
  await H.start();
  navId = H.makeUser('uenav', 'navigator').id;
  supId = H.makeUser('uesup', 'supervisor').id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('uesup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('uenav', 'StaffPassw0rd!x');
});
after(H.stop);

test('supervision queue: an overdue draft names its author, and a reminder to-do reaches them', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Remind', last_name: 'Author' })).data.id;
  const draft = await nav.post('/api/notes', { client_id: c, kind: 'admin', content: 'Unfinished.', occurred_at: new Date().toISOString() });
  assert.equal(draft.status, 201);
  // Started well before the lock window, so it is overdue.
  H.db.run(`UPDATE notes SET created_at=? WHERE id=?`, new Date(Date.now() - 10 * 86400000).toISOString(), draft.data.id);
  const q = (await sup.get('/api/supervision/queue')).data;
  const row = q.unsigned_notes.find(x => x.id === draft.data.id);
  assert.ok(row, 'the draft is in the supervisor\'s queue');
  assert.equal(row.author_id, navId, 'with its author\'s id, for the reminder');
  assert.equal(row.overdue, 1);

  // "Remind author": POST /api/tasks for the author on the note's client, with the reference line.
  const ref = `Reference: supervision reminder for note ${draft.data.id}`;
  const title = 'Finish and sign your admin note from 1 Jan';
  const t = await sup.post('/api/tasks', { client_id: c, assigned_to: navId, title, description: `uesup asked you to finish and sign this draft note.\n${ref}`, due_at: new Date().toISOString().slice(0, 10), priority: 'high' });
  assert.equal(t.status, 201);
  const stored = H.db.one(`SELECT * FROM tasks WHERE id=?`, t.data.id);
  assert.equal(stored.assigned_to, navId, 'assigned to the author');
  assert.equal(stored.created_by, supId, 'made by the supervisor');
  assert.equal(stored.client_id, c, 'on the note\'s client');
  assert.ok(stored.title_enc && !String(stored.title_enc).includes('Finish'), 'the title is encrypted');
  assert.ok(stored.description_enc && !String(stored.description_enc).includes('Reference'), 'and so are the details');
  assert.ok(!('title' in stored), 'there is no plaintext title column');
  const a = H.db.one(`SELECT * FROM audit_log WHERE action='task.create' AND entity_id=?`, t.data.id);
  assert.ok(a, 'creating the reminder is audited');
  assert.equal(a.user_id, supId); assert.equal(a.client_id, c);

  // The author sees it among their own to-dos.
  const mine = (await nav.get('/api/tasks?mine=1&status=open')).data.rows;
  const got = mine.find(x => x.id === t.data.id);
  assert.ok(got, 'the author has the reminder'); assert.equal(got.title, title);
  // The supervisor's list of open to-dos carries the reference, which is how the queue knows not to remind twice.
  const open = (await sup.get('/api/tasks?status=open&limit=1000')).data.rows;
  assert.ok(open.some(x => (x.description || '').includes(ref)), 'the open reminder is found by its reference');
  // The author cannot tick it off with the draft unsigned (1.24.1, D6); once the supervisor closes it, the reference is
  // no longer among the open to-dos, so a new reminder can go.
  assert.equal((await nav.put(`/api/tasks/${t.data.id}`, { status: 'done' })).status, 409);
  assert.equal((await sup.put(`/api/tasks/${t.data.id}`, { status: 'done' })).status, 200);
  const after = (await sup.get('/api/tasks?status=open&limit=1000')).data.rows;
  assert.ok(!after.some(x => (x.description || '').includes(ref)), 'a finished reminder is not an open one');
});

test('users list: the override count is shown to user managers only', async () => {
  const target = H.makeUser('ueoverride', 'navigator');
  assert.equal((await admin.post(`/api/users/${target.id}/permissions`, { permission: 'audit:read', mode: 'grant', reason: 'reviews the break-glass queue' })).status, 200);
  assert.equal((await admin.post(`/api/users/${target.id}/permissions`, { permission: 'clients:read', mode: 'deny', reason: 'outreach only, no client records' })).status, 200);
  const list = (await admin.get('/api/users')).data.users;
  assert.equal(list.find(u => u.id === target.id).override_count, 2, 'two overrides counted');
  assert.equal(list.find(u => u.id === navId).override_count, 0, 'none for someone on their role alone');
  // A supervisor's directory (users:read) is minimal: no permission detail.
  const dir = (await sup.get('/api/users')).data.users;
  assert.ok(dir.length && dir.every(u => !('override_count' in u)), 'the staff directory does not carry it');
  assert.equal((await admin.del(`/api/users/${target.id}/permissions/audit:read`, { reason: 'Review finished, back to the role' })).status, 200);
  assert.equal((await admin.get('/api/users')).data.users.find(u => u.id === target.id).override_count, 1, 'and it follows a revoke');
});
