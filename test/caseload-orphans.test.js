'use strict';
// Deactivating a worker used to leave their caseload assigned to an account nobody can sign in to: the
// clients and to-dos stayed with them, and a supervisor could not even pick them in "Move a caseload"
// because the staff list only named active people. And an administrator creating an account or resetting a
// password ran scrypt synchronously in the request, stalling every other request for ~90 ms.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const H = require('./helpers');
const { encrypt, uuid, verifyPassword } = require('../server/crypto');

let admin, sup, nav, leaver, keeper, fin;
const PW = 'StaffPassw0rd!x';
const clients = [];
before(async () => {
  await H.start();
  H.makeUser('osup', 'supervisor'); H.makeUser('onav', 'navigator'); H.makeUser('oleaver', 'navigator'); H.makeUser('okeeper', 'navigator'); H.makeUser('ofin', 'finance');
  const id = (u) => H.db.one(`SELECT id FROM users WHERE username=?`, u).id;
  leaver = id('oleaver'); keeper = id('okeeper');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('osup', PW);
  nav = H.client(); await nav.login('onav', PW);
  fin = H.client(); await fin.login('ofin', PW);
  const lv = H.client(); await lv.login('oleaver', PW);
  for (let i = 0; i < 3; i++) clients.push((await lv.post('/api/clients', { first_name: 'Orphan', last_name: `Case${i}` })).data.id);
  for (const c of clients) assert.equal((await lv.post('/api/tasks', { client_id: c, title: 'Call back about housing', due_at: '2026-12-01', assigned_to: leaver })).status, 201);
  // A to-do with no client (a "renew my certification" reminder) is still work that would be lost.
  H.db.run(`INSERT INTO tasks(id,assigned_to,created_by,title_enc,status) VALUES(?,?,?,?, 'open')`, uuid(), leaver, leaver, encrypt('Renew CPR certificate'));
  // A finished one does not count.
  H.db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,status) VALUES(?,?,?,?,?, 'done')`, uuid(), clients[0], leaver, leaver, encrypt('Done already'));
});
after(() => H.stop());

test('the caseload a user holds is counted, without PHI, for those who manage users or assignments', async () => {
  const r = await admin.get(`/api/users/${leaver}/caseload`);
  assert.equal(r.status, 200);
  assert.equal(r.data.clients, 3, 'three open client assignments');
  assert.equal(r.data.open_tasks, 4, 'three client to-dos and one personal one; the finished one is not counted');
  assert.deepEqual(Object.keys(r.data).sort(), ['clients', 'display_name', 'id', 'is_active', 'open_tasks', 'role'], 'counts and a name only: no client or task content');
  assert.equal((await sup.get(`/api/users/${leaver}/caseload`)).status, 200, 'a supervisor (assignments:manage) can see it');
  assert.equal((await nav.get(`/api/users/${leaver}/caseload`)).status, 403, 'a navigator cannot');
  assert.equal((await fin.get(`/api/users/${leaver}/caseload`)).status, 403, 'nor can finance');
  assert.equal((await admin.get(`/api/users/${uuid()}/caseload`)).status, 404);
});

test('an inactive worker who still holds clients is listed for supervisors, and nobody else inactive is', async () => {
  H.makeUser('ogone', 'navigator');
  H.db.run(`UPDATE users SET is_active=0 WHERE username='ogone'`);
  assert.equal((await admin.put(`/api/users/${leaver}`, { is_active: false })).status, 200);
  const r = await sup.get('/api/users/caseloads');
  assert.equal(r.status, 200);
  const row = r.data.users.find(u => u.id === leaver);
  assert.ok(row, 'the deactivated worker with a caseload is listed');
  assert.equal(row.is_active, 0);
  assert.equal(row.clients, 3); assert.equal(row.open_tasks, 4);
  assert.ok(!r.data.users.some(u => u.display_name === 'ogone'), 'an inactive account holding nothing is not listed');
  assert.deepEqual(Object.keys(row).sort(), ['clients', 'display_name', 'id', 'is_active', 'open_tasks', 'role']);
  assert.equal(r.data.inactive_clients, 3, 'the total held by inactive staff, for the Home warning');
  assert.equal((await nav.get('/api/users/caseloads')).status, 403);
  // The general staff directory a supervisor loads is unchanged: active people only.
  assert.ok(!(await sup.get('/api/users')).data.users.some(u => u.id === leaver));
});

test('the deactivated worker\'s caseload and every open to-do move with the existing, audited transfer', async () => {
  const r = await sup.post('/api/caseload/transfer', { from_user_id: leaver, to_user_id: keeper, reassign_open_tasks: true, reason: 'deactivated' });
  assert.equal(r.status, 200);
  assert.equal(r.data.transferred, 3);
  assert.equal(r.data.tasks_reassigned, 4, 'the personal to-do moves too, so nothing is left with the inactive account');
  const after = (await sup.get(`/api/users/${leaver}/caseload`)).data;
  assert.equal(after.clients, 0); assert.equal(after.open_tasks, 0);
  assert.equal(H.db.one(`SELECT status FROM tasks WHERE assigned_to=? AND status='done'`, leaver).status, 'done', 'finished to-dos keep their author');
  assert.ok(!(await sup.get('/api/users/caseloads')).data.users.some(u => u.id === leaver), 'and the warning clears');
  const a = H.db.one(`SELECT * FROM audit_log WHERE action='caseload.transfer' ORDER BY rowid DESC LIMIT 1`);
  assert.ok(a && a.entity_id === leaver, 'the transfer is audited');
  assert.equal((await sup.post('/api/caseload/transfer', { from_user_id: keeper, to_user_id: leaver })).status, 400, 'nothing can be moved to an inactive account');
});

test('a partial transfer (chosen clients) leaves personal to-dos where they are', async () => {
  const t = uuid();
  H.db.run(`INSERT INTO tasks(id,assigned_to,created_by,title_enc,status) VALUES(?,?,?,?, 'open')`, t, keeper, keeper, encrypt('Keeper personal'));
  const r = await sup.post('/api/caseload/transfer', { from_user_id: keeper, to_user_id: H.db.one(`SELECT id FROM users WHERE username='onav'`).id, client_ids: [clients[0]], reassign_open_tasks: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.transferred, 1);
  assert.equal(H.db.one(`SELECT assigned_to FROM tasks WHERE id=?`, t).assigned_to, keeper);
});

test('creating a user and resetting a password never hash on the event loop', async () => {
  const orig = nodeCrypto.scryptSync; let syncCalls = 0;
  nodeCrypto.scryptSync = function (...a) { syncCalls++; return orig.apply(this, a); };
  try {
    const c = await admin.post('/api/users', { username: 'ohashed', display_name: 'Hashed', role: 'navigator' });
    assert.equal(c.status, 201);
    const pw = 'Reset-Passw0rd!x';
    assert.equal((await admin.put(`/api/users/${c.data.id}`, { password: pw })).status, 200);
    assert.equal(syncCalls, 0, 'scrypt ran on the thread pool, not synchronously in the request');
    nodeCrypto.scryptSync = orig;
    assert.ok(verifyPassword(pw, H.db.one(`SELECT password_hash FROM users WHERE id=?`, c.data.id).password_hash), 'the stored hash verifies');
    assert.ok(verifyPassword(c.data.temporary_password, H.db.one(`SELECT password_hash FROM users WHERE username='ohashed'`).password_hash) === false, 'and replaced the temporary one');
  } finally { nodeCrypto.scryptSync = orig; }
});
