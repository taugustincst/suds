'use strict';
// Every case here is a way sync used to break permanently or leak. They are written as the device would
// actually send them: whole rows, PHI decrypted for transport, ids minted locally.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

let admin, nav, nav2, navBearer, clientId, otherClientId, navId, nav2Id;

const iso = (ms) => new Date(ms).toISOString();
async function push(client, body, headers) { return client.post('/api/sync/push', { device_now: iso(Date.now()), ...body }, headers); }

before(async () => {
  await H.start();
  H.makeUser('snav', 'navigator'); H.makeUser('snav2', 'navigator'); H.makeUser('ssup', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('snav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('snav2', 'StaffPassw0rd!x');
  navId = H.db.one(`SELECT id FROM users WHERE username='snav'`).id;
  nav2Id = H.db.one(`SELECT id FROM users WHERE username='snav2'`).id;
  clientId = (await nav.post('/api/clients', { first_name: 'Sync', last_name: 'Subject' })).data.id;
  otherClientId = (await nav2.post('/api/clients', { first_name: 'Other', last_name: 'Caseload' })).data.id;

  // A bearer session is what the device actually holds.
  const bare = H.client();
  const l = await bare.post('/api/auth/login', { username: 'snav', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' });
  navBearer = { client: bare, headers: { Authorization: 'Bearer ' + l.data.token, Cookie: '' } };
});
after(async () => { await H.stop(); });

test('a row referencing a user the office does not know is remapped, not rejected', async () => {
  // completed_by and uploaded_by were missing from the remap list, so one county form filled in offline
  // made every later sync from that device fail with a foreign key error.
  const ghost = randomUUID();
  const formId = randomUUID();
  const r = await push(nav, { tables: { client_forms: [{
    id: formId, client_id: clientId, template_name: 'Release of Information', fields_json: '[]',
    values_enc: '{"a":1}', status: 'completed', completed_at: iso(Date.now()), completed_by: ghost, created_by: ghost,
    created_at: iso(Date.now()), updated_at: iso(Date.now()),
  }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rejected, [], 'the row should be applied, not rejected');
  const row = H.db.one(`SELECT * FROM client_forms WHERE id=?`, formId);
  assert.ok(row, 'the form landed');
  assert.equal(row.completed_by, navId, 'the unknown device user became the syncing user');
  assert.equal(row.created_by, navId);
  assert.match(row.values_enc, /^v1:/, 're-encrypted with the office key');
});

test('a third device colliding on a client code is accepted, not wedged', async () => {
  // The old code appended "-D" exactly once and only on insert, so the third offline-created client hit a
  // UNIQUE violation that killed the entire push, permanently.
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const id = randomUUID();
    const r = await push(nav, { tables: { clients: [{ id, client_code: 'M26-0001', first_name_enc: 'Dev' + i, last_name_enc: 'Collide', status: 'active', created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.rejected, [], `device ${i + 1} should not be rejected`);
    codes.push(H.db.one(`SELECT client_code FROM clients WHERE id=?`, id).client_code);
  }
  assert.equal(new Set(codes).size, 3, 'each device got a distinct client code');
  assert.ok(codes.includes('M26-0001'));
});

test('one unusable row is rejected and the rest of the batch still lands', async () => {
  const goodTask = randomUUID(); const badCall = randomUUID(); const goodCall = randomUUID();
  const r = await push(nav, { tables: {
    calls: [
      { id: badCall, client_id: randomUUID(), user_id: navId, direction: 'inbound', started_at: iso(Date.now()), created_at: iso(Date.now()), updated_at: iso(Date.now()) },
      { id: goodCall, client_id: clientId, user_id: navId, direction: 'outbound', started_at: iso(Date.now()), created_at: iso(Date.now()), updated_at: iso(Date.now()) },
    ],
    tasks: [{ id: goodTask, client_id: clientId, created_by: navId, title: 'Still applied', created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
  } });
  assert.equal(r.status, 200);
  assert.equal(r.data.rejected.length, 1, 'only the unusable row is rejected');
  assert.equal(r.data.rejected[0].id, badCall);
  assert.ok(H.db.one(`SELECT 1 FROM tasks WHERE id=?`, goodTask), 'an unrelated row in the same push survived');
  assert.ok(H.db.one(`SELECT 1 FROM calls WHERE id=?`, goodCall), 'a later row in the same table survived');
  assert.ok(!H.db.one(`SELECT 1 FROM calls WHERE id=?`, badCall));
});

test('a device cannot push past its role or its caseload', async () => {
  // Per-table permissions: a navigator has no forms:manage, so it cannot install a form template by sync.
  const tmpl = randomUUID();
  const t = await push(nav, { tables: { form_templates: [{ id: tmpl, name: 'Injected', category: 'other', fields_json: '[]', created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  assert.equal(t.data.rejected.length, 1);
  assert.match(t.data.rejected[0].reason, /role cannot write/);
  assert.ok(!H.db.one(`SELECT 1 FROM form_templates WHERE id=?`, tmpl));

  // client-or-null tables were not caseload checked at all, so a task or call could be written onto
  // another worker's client.
  const task = randomUUID(); const call = randomUUID();
  const r = await push(nav, { tables: {
    tasks: [{ id: task, client_id: otherClientId, created_by: navId, title: 'Not mine', created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
    calls: [{ id: call, client_id: otherClientId, user_id: navId, direction: 'inbound', started_at: iso(Date.now()), created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
  } });
  assert.equal(r.data.rejected.length, 2, 'both cross-caseload rows are refused');
  assert.ok(r.data.rejected.every(x => /caseload/.test(x.reason)));
  assert.ok(!H.db.one(`SELECT 1 FROM tasks WHERE id=?`, task));
  assert.ok(!H.db.one(`SELECT 1 FROM calls WHERE id=?`, call));
});

test('a skewed device clock never rewrites a clinical timestamp', async () => {
  // Only created_at and updated_at are shifted into server time. signed_at is a legal fact about when a
  // clinician put their name to a note, and re-pushing it from a skewed device used to move it.
  const noteId = randomUUID();
  const signedAt = '2026-03-04T15:30:00.000Z';
  const skew = 40 * 60 * 1000;
  const r = await nav.post('/api/sync/push', {
    device_now: iso(Date.now() + skew),
    tables: { notes: [{ id: noteId, client_id: clientId, author_id: navId, kind: 'admin', content_enc: 'body', occurred_at: signedAt, status: 'signed', signed_at: signedAt, signed_by: navId, created_at: iso(Date.now() + skew), updated_at: iso(Date.now() + skew) }] },
  });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.data.clock_offset_ms + skew) < 5000, 'the offset was measured');
  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, noteId);
  assert.ok(row, 'the note landed');
  assert.equal(row.signed_at, signedAt, 'signed_at is untouched by clock normalisation');
  assert.ok(row.updated_at < iso(Date.now() + skew - 60000), 'updated_at was normalised into server time');
});

test('a device cannot assert a countersignature', async () => {
  const noteId = randomUUID();
  await push(nav, { tables: { notes: [{ id: noteId, client_id: clientId, author_id: navId, kind: 'admin', content_enc: 'x', occurred_at: iso(Date.now()), status: 'draft', cosigned_by: navId, cosigned_at: iso(Date.now()), cosignature_hash: 'forged', created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  const row = H.db.one(`SELECT cosigned_by, cosignature_hash FROM notes WHERE id=?`, noteId);
  assert.equal(row.cosigned_by, null);
  assert.equal(row.cosignature_hash, null);
});

test('a row that comes back from the dead does not leave its tombstone behind', async () => {
  const id = randomUUID();
  await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title: 'Round trip', created_at: iso(Date.now() - 10000), updated_at: iso(Date.now() - 10000) }] } });
  assert.equal((await nav.del(`/api/tasks/${id}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='tasks' AND id=?`, id), 'deleting left a tombstone');
  // The device edited it after the delete, so the edit wins and the tombstone must go.
  await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title: 'Edited after delete', created_at: iso(Date.now()), updated_at: iso(Date.now() + 1000) }] } });
  assert.ok(H.db.one(`SELECT 1 FROM tasks WHERE id=?`, id), 'the row is alive again');
  assert.ok(!H.db.one(`SELECT 1 FROM tombstones WHERE table_name='tasks' AND id=?`, id), 'and the stale tombstone is gone');
});

test('device audit rows are accepted but cannot inject arbitrary structure', async () => {
  const r = await push(nav, { audit: [{ at: iso(Date.now()), action: 'client.view', entity: 'client', entity_id: clientId, client_id: clientId, success: 1, details: JSON.stringify({ note: 'ok', nested: { deep: 'dropped' }, arr: [1, 2] }) }] });
  assert.equal(r.status, 200);
  const row = H.db.one(`SELECT * FROM audit_log WHERE action='device.client.view' ORDER BY id DESC LIMIT 1`);
  assert.ok(row, 'the device event was recorded');
  const details = JSON.parse(row.details);
  assert.equal(details.device, true);
  assert.equal(details.note, 'ok');
  assert.equal(details.nested, undefined, 'nested structure is dropped');
  assert.equal(details.arr, undefined);
});

test('a pull is paged and never inlines attachment bytes', async () => {
  const pull = (await navBearer.client.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z&limit=5', navBearer.headers)).data;
  assert.ok('complete' in pull, 'the device is told whether more pages follow');
  assert.ok(pull.cursor);
  for (const [name, rows] of Object.entries(pull.tables)) assert.ok(rows.length <= 5, `${name} respected the page limit`);
  if (!pull.complete) {
    const next = (await navBearer.client.get(`/api/sync/pull?since=${encodeURIComponent(pull.cursor)}&limit=5`, navBearer.headers)).data;
    assert.ok(next.cursor >= pull.cursor, 'the cursor moves forward');
  }
});

test('a pull skips a row the server cannot decrypt instead of sending null', async () => {
  // A NOT NULL encrypted column arriving as null used to fail the receiver's insert and take the batch
  // down with it.
  const id = randomUUID();
  H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at) VALUES(?,?,?,?,?,?)`, id, clientId, navId, 'admin', 'v1:not:valid:ciphertext', iso(Date.now()));
  const pull = (await navBearer.client.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', navBearer.headers)).data;
  assert.ok(!pull.tables.notes.some(n => n.id === id), 'the undecryptable row is not sent');
  assert.ok(pull.skipped.some(s => s.id === id), 'and the device is told it was skipped');
  H.db.run(`DELETE FROM notes WHERE id=?`, id);
});

test('the sync table description matches the actual schema', () => {
  // Three separate defects came from this description drifting from the database: an _enc column that was
  // never listed (so PHI crossed the wire encrypted with the wrong key), a user-reference column that was
  // never remapped, and a parent table named in the wrong order.
  const SYNC = require('../server/sync-tables');
  const problems = [];
  const colsOf = (t) => H.db.all(`PRAGMA table_info(${t})`).map(c => c.name);
  const tableExists = (t) => !!H.db.one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t);
  const seen = new Set();

  for (const t of SYNC.tables) {
    if (!tableExists(t.name)) { problems.push(`${t.name} is synchronised but does not exist`); continue; }
    const cols = colsOf(t.name);
    for (const c of t.enc) if (!cols.includes(c)) problems.push(`${t.name}.${c} is listed as encrypted but is not a column`);
    for (const c of cols) if (c.endsWith('_enc') && !t.enc.includes(c)) problems.push(`${t.name}.${c} is encrypted PHI but is not declared in sync-tables`);
    for (const c of t.blob || []) if (!cols.includes(c)) problems.push(`${t.name}.${c} is listed as a blob but is not a column`);
    if (t.clientCol && !cols.includes(t.clientCol)) problems.push(`${t.name}.${t.clientCol} is the caseload column but is not a column`);
    if (t.name !== 'users' && !cols.includes('updated_at')) problems.push(`${t.name} has no updated_at, so changes to it can never sync`);
    if (t.parent) {
      if (!seen.has(t.parent[0])) problems.push(`${t.name} is listed before its parent ${t.parent[0]}; rows would fail their foreign key`);
      if (!cols.includes(t.parent[1])) problems.push(`${t.name}.${t.parent[1]} is the parent link but is not a column`);
    }
    seen.add(t.name);
  }
  for (const [table, col] of SYNC.user_refs) {
    if (!tableExists(table)) { problems.push(`user_refs names missing table ${table}`); continue; }
    if (!colsOf(table).includes(col)) problems.push(`user_refs names missing column ${table}.${col}`);
  }
  // Every column in the database that points at users(id) must be remappable.
  for (const t of H.db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
    for (const fk of H.db.all(`PRAGMA foreign_key_list(${t.name})`)) {
      if (fk.table !== 'users') continue;
      if (!SYNC.user_refs.some(([tt, cc]) => tt === t.name && cc === fk.from)) problems.push(`${t.name}.${fk.from} references users(id) but is not in user_refs`);
    }
  }
  assert.deepEqual(problems, []);
});

test('a time entry with no client cannot be read by another worker', async () => {
  // Caseload scoping protects records that carry a client. A staff time entry with no client carried
  // nothing, so knowing its id was enough to read it.
  const mine = await nav.post('/api/time', { work_date: '2026-09-02', minutes: 45, category: 'supervision' });
  assert.equal(mine.status, 201);
  assert.equal((await nav.get(`/api/time/${mine.data.id}`)).status, 200, 'the worker can read their own');
  assert.equal((await nav2.get(`/api/time/${mine.data.id}`)).status, 403, 'another worker cannot');
  assert.equal((await admin.get(`/api/time/${mine.data.id}`)).status, 200, 'a manager can');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='authz.denied' AND entity_id=?`, mine.data.id), 'and the refusal is audited');
});
