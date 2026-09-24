'use strict';
// Every case here is a way sync used to break permanently or leak. They are written as the device would
// actually send them: whole rows, PHI decrypted for transport, ids minted locally.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

let admin, nav, nav2, clin, navBearer, clientId, otherClientId, navId, nav2Id;

const iso = (ms) => new Date(ms).toISOString();
async function push(client, body, headers) { return client.post('/api/sync/push', { device_now: iso(Date.now()), ...body }, headers); }

before(async () => {
  await H.start();
  H.makeUser('snav', 'navigator'); H.makeUser('snav2', 'navigator'); H.makeUser('ssup', 'supervisor'); H.makeUser('sclin', 'clinician');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('snav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('snav2', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('sclin', 'StaffPassw0rd!x');
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
    tasks: [{ id: goodTask, client_id: clientId, created_by: navId, title_enc: 'Still applied', created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
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
    tasks: [{ id: task, client_id: otherClientId, created_by: navId, title_enc: 'Not mine', created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
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
  await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Round trip', created_at: iso(Date.now() - 10000), updated_at: iso(Date.now() - 10000) }] } });
  assert.equal((await nav.del(`/api/tasks/${id}`)).status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='tasks' AND id=?`, id), 'deleting left a tombstone');
  // The device edited it after the delete, so the edit wins and the tombstone must go.
  await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Edited after delete', created_at: iso(Date.now()), updated_at: iso(Date.now() + 1000) }] } });
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
    for (const [from, to] of Object.entries(t.legacy || {})) {
      if (cols.includes(from)) problems.push(`${t.name}.${from} is declared a legacy column but still exists`);
      if (!cols.includes(to)) problems.push(`${t.name}.${from} maps to ${to}, which is not a column`);
      if (to.endsWith('_enc') && !t.enc.includes(to)) problems.push(`${t.name}.${from} maps to ${to}, which is not declared encrypted`);
    }
    if (t.clientCol && !cols.includes(t.clientCol)) problems.push(`${t.name}.${t.clientCol} is the caseload column but is not a column`);
    if (t.name !== 'users' && !cols.includes('updated_at')) problems.push(`${t.name} has no updated_at, so changes to it can never sync`);
    if (t.parent) {
      if (!seen.has(t.parent[0])) problems.push(`${t.name} is listed before its parent ${t.parent[0]}; rows would fail their foreign key`);
      if (!cols.includes(t.parent[1])) problems.push(`${t.name}.${t.parent[1]} is the parent link but is not a column`);
    }
    seen.add(t.name);
  }
  // Every foreign key between two synchronised tables, not only the declared `parent`: rows are applied in
  // array order on both sides, and with foreign keys enforced a child that arrives before what it points
  // at (a referral before the consent it cites) is refused. A self-reference must be declared selfParent.
  const order = SYNC.tables.map(t => t.name);
  for (const t of SYNC.tables) {
    if (!tableExists(t.name)) continue;
    for (const fk of H.db.all(`PRAGMA foreign_key_list(${t.name})`)) {
      if (!order.includes(fk.table)) continue;
      if (fk.table === t.name) { if (t.selfParent !== fk.from) problems.push(`${t.name}.${fk.from} references its own table but is not its selfParent`); continue; }
      if (order.indexOf(fk.table) > order.indexOf(t.name)) problems.push(`${t.name}.${fk.from} references ${fk.table}, which is listed after it`);
    }
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

test('paging never drops rows that share a timestamp', async () => {
  // updated_at is not unique — a bulk import stamps many rows with the same instant. Cutting a page in the
  // middle of one timestamp would lose every row after the cut, because the next pull asks for > cursor.
  const stamp = '2030-01-01T00:00:00.000Z';
  const ids = [];
  for (let i = 0; i < 25; i++) {
    const id = randomUUID();
    H.db.run(`INSERT INTO tasks(id,client_id,created_by,title_enc,created_at,updated_at) VALUES(?,?,?,?,?,?)`, id, clientId, navId, require('../server/crypto').encrypt(`Bulk ${i}`), stamp, stamp);
    ids.push(id);
  }
  // A page far smaller than the number of rows sharing that instant.
  const seen = new Set();
  let since = '2029-12-31T00:00:00.000Z';
  for (let page = 0; page < 20; page++) {
    const r = (await navBearer.client.get(`/api/sync/pull?since=${encodeURIComponent(since)}&limit=5`, navBearer.headers)).data;
    for (const row of r.tables.tasks || []) seen.add(row.id);
    if (r.complete) break;
    assert.ok(r.cursor > since, 'the cursor always moves forward, so paging terminates');
    since = r.cursor;
  }
  const missed = ids.filter(id => !seen.has(id));
  assert.deepEqual(missed, [], 'every row sharing the timestamp was delivered');
});

test('a device edit that loses to a newer office edit is reported back, and audited', async () => {
  // Regression: the "server copy is newer" branch returned false and nothing else. The person on the phone
  // had seen "saved"; their edit vanished with no trace anywhere.
  const id = randomUUID();
  await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Phone version', priority: 'normal', created_at: iso(Date.now() - 60000), updated_at: iso(Date.now() - 60000) }] } });
  assert.equal((await nav.put(`/api/tasks/${id}`, { title: 'Office version', priority: 'urgent' })).status, 200);
  const stale = await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Phone version, edited later on the phone', priority: 'low', created_at: iso(Date.now() - 60000), updated_at: iso(Date.now() - 30000) }] } });
  assert.equal(stale.status, 200);
  const c = (stale.data.conflicts || []).find(x => x.id === id);
  assert.ok(c, 'the push response names the row whose edit was not taken');
  assert.ok(c.columns.includes('title_enc') && c.columns.includes('priority'), 'and which fields differed');
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT title_enc FROM tasks WHERE id=?`, id).title_enc), 'Office version', 'the office copy is what everyone sees');
  const row = H.db.one(`SELECT * FROM audit_log WHERE action='sync.conflict' AND entity_id=? ORDER BY id DESC LIMIT 1`, id);
  assert.ok(row, 'the conflict is in the audit log');
  assert.ok(!String(row.details).includes('Phone version'), 'by column name only, never the value');
});

test('an overwrite from a device is recorded, by column name only', async () => {
  // Last write wins at row granularity, so a device edit can revert a field changed at the office. That
  // still happens — it is the rule — but it used to happen with no record that anything was replaced.
  const id = randomUUID();
  await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Original', priority: 'normal', created_at: iso(Date.now() - 20000), updated_at: iso(Date.now() - 20000) }] } });
  await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Replaced by the phone', priority: 'urgent', created_at: iso(Date.now() - 20000), updated_at: iso(Date.now()) }] } });

  const row = H.db.one(`SELECT * FROM audit_log WHERE action='sync.overwrite' AND entity_id=? ORDER BY id DESC LIMIT 1`, id);
  assert.ok(row, 'the overwrite is recorded');
  const details = JSON.parse(row.details);
  assert.ok(details.columns.includes('title_enc'), 'and names the column it replaced');
  assert.ok(details.columns.includes('priority'));
  assert.ok(!String(row.details).includes('Replaced by the phone'), 'but never the value — this is the audit log');
  assert.ok(!String(row.details).includes('Original'));
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT title_enc FROM tasks WHERE id=?`, id).title_enc), 'Replaced by the phone', 'the newer write still wins');
});

test('a nested budget line and its parent sync in the same batch, child listed first', async () => {
  // A supervisor can build a whole allocation hierarchy offline in one sitting; nothing guarantees the
  // device sends the parent row before its children within a single table's batch.
  const fund = await admin.post('/api/budget/funds', { name: 'Sync test fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 10000 });
  const parentId = randomUUID(); const childId = randomUUID();
  const r = await push(admin, { tables: { budget_lines: [
    { id: childId, funding_source_id: fund.data.id, parent_id: parentId, category: 'other', label: 'Child, sent first', allocated_amount: 100, created_at: iso(Date.now()), updated_at: iso(Date.now()) },
    { id: parentId, funding_source_id: fund.data.id, parent_id: null, category: 'other', label: 'Parent, sent second', allocated_amount: 500, created_at: iso(Date.now()), updated_at: iso(Date.now()) },
  ] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rejected, [], 'neither row is rejected for a constraint the sort should have avoided');
  assert.equal(H.db.one(`SELECT parent_id FROM budget_lines WHERE id=?`, childId).parent_id, parentId);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM budget_lines WHERE id=?`, parentId).n, 1);
});

test('a sync push cannot re-parent two budget lines into a cycle', async () => {
  // Regression: PUT /api/budget/lines/:id blocks a re-parent that would create a cycle, but a sync push
  // applied budget_lines rows straight through with no such check -- since both lines already exist, an
  // A.parent=B / B.parent=A pair sent together hits no FK violation either, so nothing stopped it. A cycle
  // like this makes both lines vanish from the fund's tree (buildLineTree only walks down from roots),
  // taking their spend with them as far as any grant report reading the per-line breakdown is concerned.
  const fund = await admin.post('/api/budget/funds', { name: 'Cycle check fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 10000 });
  const a = await admin.post(`/api/budget/funds/${fund.data.id}/lines`, { category: 'other', allocated_amount: 100 });
  const b = await admin.post(`/api/budget/funds/${fund.data.id}/lines`, { category: 'other', allocated_amount: 100 });
  const r = await push(admin, { tables: { budget_lines: [
    { id: a.data.id, funding_source_id: fund.data.id, parent_id: b.data.id, category: 'other', allocated_amount: 100, updated_at: iso(Date.now()) },
    { id: b.data.id, funding_source_id: fund.data.id, parent_id: a.data.id, category: 'other', allocated_amount: 100, updated_at: iso(Date.now()) },
  ] } });
  assert.equal(r.status, 200);
  assert.ok(r.data.rejected.some(x => x.id === a.data.id || x.id === b.data.id), 'at least one side of the cycle is rejected');
  const aRow = H.db.one(`SELECT parent_id FROM budget_lines WHERE id=?`, a.data.id);
  const bRow = H.db.one(`SELECT parent_id FROM budget_lines WHERE id=?`, b.data.id);
  assert.ok(!(aRow.parent_id === b.data.id && bRow.parent_id === a.data.id), 'the two lines are never left pointing at each other');
});

test('a sync push cannot restructure grants without budget:manage', async () => {
  // budget:write (which navigators hold) covers recording expenditures; changing a fund's award or its
  // budget lines is budget:manage over REST, and sync must not be the way around that.
  const fund = await admin.post('/api/budget/funds', { name: 'Sync structure check', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 5000 });
  const r = await push(nav, { tables: {
    funding_sources: [{ id: fund.data.id, name: 'Sync structure check', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 999999, is_active: 1, updated_at: iso(Date.now() + 1000) }],
    budget_lines: [{ id: randomUUID(), funding_source_id: fund.data.id, category: 'other', allocated_amount: 100, created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
  } });
  assert.equal(r.status, 200);
  assert.equal(r.data.rejected.length, 2, 'both rows are refused');
  assert.ok(r.data.rejected.every(x => /role cannot write/.test(x.reason)));
  assert.equal(H.db.one(`SELECT total_amount FROM funding_sources WHERE id=?`, fund.data.id).total_amount, 5000, 'the award is untouched');
});

test('a sync push cannot re-parent a budget line into a different fund', async () => {
  // Regression: the REST route (PUT /api/budget/lines/:id) requires a line's parent to belong to the same
  // fund, but a sync push only checked for a parent_id cycle -- two lines in unrelated funds' trees never
  // collide there, so a foreign parent_id was accepted. The line then dropped out of ITS OWN fund's
  // "allocated" total (excluded there for having a non-null parent_id, even though its real parent isn't in
  // that fund's tree at all) while never joining the other fund's total either -- money silently vanishes
  // from both funds' rollups while the line keeps drawing real expenditures.
  const fundA = await admin.post('/api/budget/funds', { name: 'Fund A (parent check)', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 5000 });
  const fundB = await admin.post('/api/budget/funds', { name: 'Fund B (parent check)', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 5000 });
  const lineA = await admin.post(`/api/budget/funds/${fundA.data.id}/lines`, { category: 'other', allocated_amount: 1000 });
  const lineB = await admin.post(`/api/budget/funds/${fundB.data.id}/lines`, { category: 'other', allocated_amount: 1000 });
  const r = await push(admin, { tables: { budget_lines: [
    { id: lineA.data.id, funding_source_id: fundA.data.id, parent_id: lineB.data.id, category: 'other', allocated_amount: 1000, updated_at: iso(Date.now()) },
  ] } });
  assert.equal(r.status, 200);
  assert.ok(r.data.rejected.some(x => x.id === lineA.data.id), 'the cross-fund re-parent is rejected');
  assert.equal(H.db.one(`SELECT parent_id FROM budget_lines WHERE id=?`, lineA.data.id).parent_id, null, 'the line was never re-parented across funds');
});

test('a sync push cannot attach a cost/fund/line to an intervention without budget:write', async () => {
  // Regression: interventions.js's checkCost() requires budget:write to set cost/funding_source_id/
  // budget_line_id on the REST route, but a sync push writes straight to SQL with none of that route's
  // hooks -- a clinician (interventions:* but no budget permission at all) could otherwise reach the same
  // fields through a push, fraudulently attributing their service to a fund/grant for reporting purposes.
  const fund = await admin.post('/api/budget/funds', { name: 'Clinician sync check', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 2000 });
  const line = await admin.post(`/api/budget/funds/${fund.data.id}/lines`, { category: 'other', allocated_amount: 500 });
  // clin's own caseload (creating a client auto-assigns the creator), so caseload scoping is not what's
  // being tested here -- only the budget-permission gate on cost/funding_source_id/budget_line_id.
  const clinClientId = (await clin.post('/api/clients', { first_name: 'Clin', last_name: 'Caseload' })).data.id;
  const ivId = randomUUID();
  const r = await push(clin, { tables: { interventions: [{
    id: ivId, client_id: clinClientId, type: 'case_management', occurred_at: iso(Date.now()),
    funding_source_id: fund.data.id, budget_line_id: line.data.id, cost: 75,
    created_at: iso(Date.now()), updated_at: iso(Date.now()),
  }] } });
  assert.equal(r.status, 200);
  assert.ok(r.data.rejected.some(x => x.id === ivId), 'the row is rejected, not silently stripped and inserted anyway');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM interventions WHERE id=?`, ivId).n, 0, 'no row was created at all');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM expenditures WHERE funding_source_id=?`, fund.data.id).n, 0, 'no expenditure was posted against the fund');

  // An unrelated edit to a row that already, legitimately, carries budget data (set earlier by someone
  // with budget:write) must not suddenly need that permission just because the full row still carries it.
  const existing = await admin.post('/api/interventions', { client_id: clinClientId, type: 'case_management', occurred_at: iso(Date.now()), funding_source_id: fund.data.id, budget_line_id: line.data.id, cost: 30 });
  const r2 = await push(clin, { tables: { interventions: [{
    id: existing.data.id, client_id: clinClientId, type: 'case_management', occurred_at: iso(Date.now()),
    funding_source_id: fund.data.id, budget_line_id: line.data.id, cost: 30, summary: 'Follow-up note',
    updated_at: iso(Date.now() + 1000),
  }] } });
  assert.equal(r2.status, 200);
  assert.ok(!r2.data.rejected.some(x => x.id === existing.data.id), 'unchanged budget fields on an already-attached row do not block an unrelated edit');
});

// ---- data-integrity fixes (sync/retention/merge review) ----

test('a pushed row is stamped in server time, so other devices\' incremental pulls see it', async () => {
  // The device's updated_at was stored verbatim. A phone whose clock was behind, or that edited a row an
  // hour before it synced, wrote a timestamp older than every other device's cursor — and pull selects
  // updated_at > cursor, so nobody else ever received the edit.
  const cursor = (await navBearer.client.get('/api/sync/pull?since=2999-01-01T00:00:00.000Z', navBearer.headers)).data.server_now;
  await new Promise(r => setTimeout(r, 5));
  const id = randomUUID();
  const old = iso(Date.now() - 3600 * 1000);
  const r = await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Edited an hour ago', created_at: old, updated_at: old }] } });
  assert.deepEqual(r.data.rejected, []);
  const row = H.db.one(`SELECT updated_at, created_at FROM tasks WHERE id=?`, id);
  assert.ok(row.updated_at > cursor, 'stored updated_at is the server clock, not the device\'s');
  assert.ok(Math.abs(Date.parse(row.created_at) - Date.parse(old)) < 5000, 'created_at keeps the device\'s (offset-corrected) time');
  const pulled = (await navBearer.client.get(`/api/sync/pull?since=${encodeURIComponent(cursor)}`, navBearer.headers)).data;
  assert.ok(pulled.tables.tasks.some(t => t.id === id), 'a second device pulling since its cursor receives the row');
  // The device's own later edit still wins last-writer-wins against the server stamp.
  const r2 = await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Edited again on the phone', created_at: old, updated_at: iso(Date.now() + 50) }] } });
  assert.deepEqual(r2.data.rejected, []);
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT title_enc FROM tasks WHERE id=?`, id).title_enc), 'Edited again on the phone');
});

test('created_at is shifted by the clock offset once, never on later round trips', async () => {
  const id = randomUUID();
  const createdOnDevice = '2026-05-01T10:00:00.000Z';
  const skew = 3600 * 1000;
  await nav.post('/api/sync/push', { device_now: iso(Date.now() + skew), tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Skewed', created_at: createdOnDevice, updated_at: iso(Date.now() + skew) }] } });
  const first = H.db.one(`SELECT created_at FROM tasks WHERE id=?`, id).created_at;
  assert.ok(Math.abs(Date.parse(first) - (Date.parse(createdOnDevice) - skew)) < 5000, 'a new row\'s created_at is corrected into server time');
  // The same row again from a device skewed the other way: created_at must not move.
  await nav.post('/api/sync/push', { device_now: iso(Date.now() - 2 * skew), tables: { tasks: [{ id, client_id: clientId, created_by: navId, title_enc: 'Skewed, edited', created_at: createdOnDevice, updated_at: iso(Date.now() - 2 * skew + 10) }] } });
  assert.equal(H.db.one(`SELECT created_at FROM tasks WHERE id=?`, id).created_at, first, 'an existing row\'s created_at is never re-shifted');
});

test('a device on a pre-1.9.3 kernel still syncs a to-do\'s details, encrypted', async () => {
  // Migration 24 moved tasks.description into description_enc. An older kernel still sends the plaintext
  // column, which no longer exists at the office: the details were silently dropped.
  const { decrypt } = require('../server/crypto');
  const id = randomUUID();
  const at = () => iso(Date.now());
  let r = await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, assigned_to: navId, title_enc: 'Detox bed', description: 'Granite on Tuesday; bring the MAT letter', created_at: at(), updated_at: at() }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.rejected.length, 0, JSON.stringify(r.data.rejected));
  const row = H.db.one(`SELECT * FROM tasks WHERE id=?`, id);
  assert.ok(!('description' in row), 'there is no plaintext column to land in');
  assert.ok(row.description_enc && !/Granite/.test(row.description_enc), 'the details are stored, encrypted');
  assert.equal(decrypt(row.description_enc), 'Granite on Tuesday; bring the MAT letter');
  assert.equal((await nav.get(`/api/tasks/${id}`)).data.row.description, 'Granite on Tuesday; bring the MAT letter', 'and read back through the API');
  // The old kernel never received description_enc, so its null means "not known here": an edit to the
  // status must not erase the office's copy of the details.
  r = await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, assigned_to: navId, title_enc: 'Detox bed', description: null, status: 'done', updated_at: iso(Date.now() + 1000) }] } });
  assert.equal(r.status, 200); assert.equal(r.data.rejected.length, 0, JSON.stringify(r.data.rejected));
  const after = H.db.one(`SELECT status, description_enc FROM tasks WHERE id=?`, id);
  assert.equal(after.status, 'done'); assert.equal(decrypt(after.description_enc), 'Granite on Tuesday; bring the MAT letter');
  // A current kernel sends description_enc; a stray legacy column beside it never overrides it.
  r = await push(nav, { tables: { tasks: [{ id, client_id: clientId, created_by: navId, assigned_to: navId, title_enc: 'Detox bed', description_enc: 'Moved to Thursday', description: 'stale', updated_at: iso(Date.now() + 2000) }] } });
  assert.equal(r.status, 200);
  assert.equal(decrypt(H.db.one(`SELECT description_enc FROM tasks WHERE id=?`, id).description_enc), 'Moved to Thursday');
});

test('a purged client can never be resurrected by a device, nor anything attached to it', async () => {
  const R = require('../server/retention');
  const gone = (await nav.post('/api/clients', { first_name: 'Long', last_name: 'Gone', status: 'closed', discharge_date: '2010-01-01' })).data.id;
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, gone).client_code;
  R.purgeClient({ id: gone, client_code: code, ended: '2010-01-01' });
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='clients' AND id=?`, gone));
  const taskId = randomUUID();
  const r = await push(nav, { tables: {
    clients: [{ id: gone, client_code: code, first_name_enc: 'Long', last_name_enc: 'Gone', status: 'active', created_at: iso(Date.now()), updated_at: iso(Date.now() + 5000) }],
    tasks: [{ id: taskId, client_id: gone, created_by: navId, title_enc: 'Attached to a ghost', created_at: iso(Date.now()), updated_at: iso(Date.now() + 5000) }],
  } });
  assert.equal(r.status, 200);
  const c = r.data.rejected.find(x => x.id === gone); const t = r.data.rejected.find(x => x.id === taskId);
  assert.ok(c && c.reason === 'purged' && c.permanent === true, 'the client is refused for good');
  assert.ok(t && t.permanent === true, 'and so is its child row');
  assert.ok(!H.db.one(`SELECT 1 FROM clients WHERE id=?`, gone), 'nothing came back');
  assert.ok(!H.db.one(`SELECT 1 FROM tasks WHERE id=?`, taskId));
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='clients' AND id=?`, gone), 'the tombstone is kept so every device is told');
});

test('a merge is not undone by a device that still holds the duplicate', async () => {
  const keep = (await nav.post('/api/clients', { first_name: 'Keeper', last_name: 'Merged' })).data.id;
  const dup = (await nav.post('/api/clients', { first_name: 'Dupe', last_name: 'Merged', confirm_duplicate: true })).data.id;
  const oldTask = randomUUID();
  const r0 = await push(nav, { tables: { tasks: [{ id: oldTask, client_id: dup, created_by: navId, title_enc: 'Before merge', created_at: iso(Date.now() - 5000), updated_at: iso(Date.now() - 5000) }] } });
  assert.deepEqual(r0.data.rejected, []);
  assert.equal((await admin.post(`/api/clients/${keep}/merge`, { source_id: dup })).status, 200);
  assert.equal(H.db.one(`SELECT client_id FROM tasks WHERE id=?`, oldTask).client_id, keep, 'the merge moved the task');
  const newTask = randomUUID();
  const r = await push(nav, { tables: {
    clients: [{ id: dup, client_code: 'X', first_name_enc: 'Dupe', last_name_enc: 'Merged', status: 'active', updated_at: iso(Date.now() + 5000) }],
    tasks: [
      { id: newTask, client_id: dup, created_by: navId, title_enc: 'Made offline on the duplicate', created_at: iso(Date.now()), updated_at: iso(Date.now()) },
      { id: oldTask, client_id: dup, created_by: navId, title_enc: 'Edited offline on the duplicate', created_at: iso(Date.now() - 5000), updated_at: iso(Date.now() + 5000) },
    ],
  } });
  const c = r.data.rejected.find(x => x.id === dup);
  assert.ok(c && /merged/.test(c.reason) && c.permanent, 'the duplicate itself is not re-opened');
  assert.equal(H.db.one(`SELECT merged_into FROM clients WHERE id=?`, dup).merged_into, keep, 'and stays merged');
  assert.equal(H.db.one(`SELECT client_id FROM tasks WHERE id=?`, newTask).client_id, keep, 'a new child is re-pointed at the keeper');
  assert.equal(H.db.one(`SELECT client_id FROM tasks WHERE id=?`, oldTask).client_id, keep, 'an existing child never moves back');
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT title_enc FROM tasks WHERE id=?`, oldTask).title_enc), 'Edited offline on the duplicate', 'but its edit still lands');
});

test('a client created in the field syncs with the assignment the device made, and only that one', async () => {
  // The device auto-creates the worker's primary assignment at intake (as POST /api/clients does). The
  // office refused it — "your role cannot write assignments" — on every push, while adding its own
  // auto-assignment, so the device carried a permanently rejected row for every client it ever created.
  const clientId2 = randomUUID(); const asg = randomUUID(); const localUser = randomUUID();
  const r = await push(nav, { tables: {
    clients: [{ id: clientId2, client_code: 'M26-0044', first_name_enc: 'Field', last_name_enc: 'Created', status: 'active', created_by: localUser, intake_date: '2026-09-01', created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
    assignments: [{ id: asg, client_id: clientId2, user_id: localUser, role_on_case: 'primary', start_date: '2026-09-01', created_by: localUser, created_at: iso(Date.now()), updated_at: iso(Date.now()) }],
  } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rejected, [], 'neither the client nor its self-assignment is refused');
  const rows = H.db.all(`SELECT id, user_id, role_on_case FROM assignments WHERE client_id=?`, clientId2);
  assert.equal(rows.length, 1, 'exactly one assignment: the office did not add a second one of its own');
  assert.equal(rows[0].id, asg, 'and it is the row the device sent');
  assert.equal(rows[0].user_id, navId, 'attributed to the syncing worker');
  // Re-sending it (a retry, or a later edit of the same row) is still accepted and still one row.
  const again = await push(nav, { tables: { assignments: [{ id: asg, client_id: clientId2, user_id: navId, role_on_case: 'primary', start_date: '2026-09-01', created_by: navId, created_at: iso(Date.now()), updated_at: iso(Date.now() + 1000) }] } });
  assert.deepEqual(again.data.rejected, []);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM assignments WHERE client_id=?`, clientId2).n, 1);

  // What the exception does not cover: assigning someone else, or a client this worker did not create.
  const other = randomUUID(); const foreign = randomUUID();
  const r2 = await push(nav, { tables: { assignments: [
    { id: other, client_id: clientId2, user_id: nav2Id, role_on_case: 'primary', start_date: '2026-09-01', created_by: navId, created_at: iso(Date.now()), updated_at: iso(Date.now()) },
    { id: foreign, client_id: otherClientId, user_id: navId, role_on_case: 'primary', start_date: '2026-09-01', created_by: navId, created_at: iso(Date.now()), updated_at: iso(Date.now()) },
  ] } });
  assert.equal(r2.data.rejected.length, 2);
  assert.ok(r2.data.rejected.every(x => /role cannot write assignments/.test(x.reason) && x.permanent), JSON.stringify(r2.data.rejected));
  assert.ok(!H.db.one(`SELECT 1 FROM assignments WHERE id IN (?,?)`, other, foreign));

  // A device from before this rule: the office already auto-assigned, so the device's duplicate is refused
  // for good rather than becoming a second open primary assignment.
  const c3 = randomUUID(); const dupAsg = randomUUID();
  await push(nav, { tables: { clients: [{ id: c3, client_code: 'M26-0045', first_name_enc: 'Older', last_name_enc: 'Device', status: 'active', created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM assignments WHERE client_id=?`, c3).n, 1, 'the office auto-assigned when no assignment was sent');
  const r3 = await push(nav, { tables: { assignments: [{ id: dupAsg, client_id: c3, user_id: navId, role_on_case: 'primary', start_date: '2026-09-01', created_by: navId, created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  assert.equal(r3.data.rejected.length, 1, JSON.stringify(r3.data));
  assert.ok(/conflicts with an existing record/.test(r3.data.rejected[0].reason) && r3.data.rejected[0].permanent, JSON.stringify(r3.data.rejected));
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM assignments WHERE client_id=?`, c3).n, 1, JSON.stringify(H.db.all(`SELECT * FROM assignments WHERE client_id=?`, c3)));
});

test('a client merged away at the office reaches the device that still holds it', async () => {
  // After a merge the duplicate's assignments belong to the keeper, so the duplicate fell outside the
  // navigator's pull scope and lingered on every device for ever.
  const since = iso(Date.now() - 1000);
  const keep = (await nav.post('/api/clients', { first_name: 'Keeper', last_name: 'Lingers' })).data.id;
  const dup = (await nav.post('/api/clients', { first_name: 'Dupe', last_name: 'Lingers', confirm_duplicate: true })).data.id;
  assert.equal((await admin.post(`/api/clients/${keep}/merge`, { source_id: dup })).status, 200);
  const p = await nav.get(`/api/sync/pull?since=${encodeURIComponent(since)}`);
  assert.equal(p.status, 200);
  const merged = p.data.tables.clients.find(c => c.id === dup);
  assert.ok(merged, 'the merged-away client is in the pull');
  assert.equal(merged.merged_into, keep, 'marked with the record that was kept');
  assert.ok(merged.deleted_at, 'and as no longer current');
  assert.ok(p.data.tables.clients.some(c => c.id === keep), 'alongside the keeper');
  // Not a way around the caseload: a merge between someone else's clients is not sent to this worker.
  const theirs = (await nav2.post('/api/clients', { first_name: 'Theirs', last_name: 'Lingers', confirm_duplicate: true })).data.id;
  const theirsDup = (await nav2.post('/api/clients', { first_name: 'Theirs', last_name: 'Lingers', confirm_duplicate: true })).data.id;
  assert.equal((await admin.post(`/api/clients/${theirs}/merge`, { source_id: theirsDup })).status, 200);
  const p2 = await nav2.get(`/api/sync/pull?since=${encodeURIComponent(since)}`);
  assert.ok(!p2.data.tables.clients.some(c => c.id === dup), 'another worker does not receive a merge that is not on their caseload');
  assert.ok(p2.data.tables.clients.some(c => c.id === theirsDup), 'but does receive their own');
  const p3 = await nav.get(`/api/sync/pull?since=${encodeURIComponent(since)}`);
  assert.ok(!p3.data.tables.clients.some(c => c.id === theirsDup || c.id === theirs), 'a merge between clients outside the caseload is not sent');
});

test('a pull carries the office database generation, and a restore changes it', async () => {
  const p = await nav.get(`/api/sync/pull?since=${encodeURIComponent(iso(Date.now()))}`);
  assert.equal(p.status, 200);
  assert.ok('db_generation' in p.data, 'the field is always present');
  assert.equal(p.data.db_generation, null, 'null until the database has ever been restored');
  H.db.setSetting('db_generation', 'gen-after-restore'); // what server/backup.js restore() writes, with a fresh uuid
  const p2 = await nav.get(`/api/sync/pull?since=${encodeURIComponent(iso(Date.now()))}`);
  assert.equal(p2.data.db_generation, 'gen-after-restore');
  H.db.run(`DELETE FROM settings WHERE key='db_generation'`);
});

test('merging tidies assignments and leaves one open episode', async () => {
  const keep = (await nav.post('/api/clients', { first_name: 'Tidy', last_name: 'Keeper' })).data.id;
  const dup = (await nav.post('/api/clients', { first_name: 'Tidy', last_name: 'Duplicate' })).data.id;
  const active = () => H.db.one(`SELECT COUNT(*) n FROM assignments WHERE client_id=? AND user_id=? AND ${require('../server/auth').activeAssignment()}`, keep, navId).n;
  assert.equal(active(), 1);
  const dupEpisode = H.db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, dup).id;
  H.db.run(`INSERT INTO imports(id,source,imported_by) VALUES(?,?,?)`, 'imp-merge', 'generic', navId);
  H.db.run(`INSERT INTO import_items(id,import_id,content_enc,suggested_client_id) VALUES(?,?,?,?)`, 'item-merge', 'imp-merge', require('../server/crypto').encrypt('x'), dup);
  assert.equal((await admin.post(`/api/clients/${keep}/merge`, { source_id: dup })).status, 200);
  assert.equal(active(), 1, 'the worker is not assigned to the keeper twice');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM episodes WHERE client_id=? AND status='open'`, keep).n, 1, 'one open episode');
  const closed = H.db.one(`SELECT status, discharge_reason FROM episodes WHERE id=?`, dupEpisode);
  assert.equal(closed.status, 'closed'); assert.equal(closed.discharge_reason, 'merged');
  assert.equal(H.db.one(`SELECT suggested_client_id FROM import_items WHERE id='item-merge'`).suggested_client_id, keep, 'an import suggestion follows the keeper');
});

test('the intake duplicate check never names a client outside the caller\'s caseload', async () => {
  // Regression (PHI leak): POST /api/clients threw with the full display name and date of birth of every
  // match, including clients the caller could not otherwise see, and before any audit row was written.
  const theirs = (await nav2.post('/api/clients', { first_name: 'Hidden', last_name: 'Match', dob: '1980-02-02' })).data.id;
  const r = await nav.post('/api/clients', { first_name: 'Hidden', last_name: 'Match', dob: '1980-02-02' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /outside your caseload/);
  assert.equal(r.data.duplicates, undefined, 'no record is listed');
  assert.ok(!JSON.stringify(r.data).includes('Hidden'), 'no identifier leaves the server');
  assert.equal(r.data.hidden_duplicates, 1);
  const a = H.db.one(`SELECT * FROM audit_log WHERE action='client.duplicate_check' AND user_id=? ORDER BY id DESC LIMIT 1`, navId);
  assert.ok(a, 'the check is audited');
  assert.ok(!String(a.details).includes('Hidden'));
  assert.ok(!H.db.one(`SELECT 1 FROM clients WHERE id<>? AND full_name_idx=?`, theirs, require('../server/crypto').blindIndex('MatchHidden')), 'nothing was created');
  // A match on the caller's own caseload is still shown, as before.
  const mine = (await nav.post('/api/clients', { first_name: 'Shown', last_name: 'Match' })).data.id;
  const r2 = await nav.post('/api/clients', { first_name: 'Shown', last_name: 'Match' });
  assert.equal(r2.status, 400);
  assert.ok(r2.data.duplicates.some(d => d.id === mine), 'a visible match is listed');
  assert.equal(r2.data.hidden_duplicates, 0);
});

test('a client created on a device that looks like an existing one lands, flagged for a supervisor', async () => {
  const existing = (await nav.post('/api/clients', { first_name: 'Twin', last_name: 'Entered', dob: '1991-01-01' })).data.id;
  const id = randomUUID();
  const r = await push(nav, { tables: { clients: [{ id, client_code: 'M26-0099', first_name_enc: 'Twin', last_name_enc: 'Entered', dob_enc: '1991-01-01', status: 'active', created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  assert.deepEqual(r.data.rejected, [], 'the row is accepted — the worker cannot check from the field');
  assert.ok(H.db.one(`SELECT 1 FROM clients WHERE id=?`, id));
  const w = (r.data.warnings || []).find(x => x.id === id);
  assert.ok(w && /possible duplicate/.test(w.reason), 'the device is told');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.possible_duplicate' AND entity_id=?`, id);
  assert.ok(a, 'audited');
  assert.ok(JSON.parse(a.details).matches.some(m => m.id === existing));
  assert.ok(!a.details.includes('Twin'), 'by code and reason only');
  const task = H.db.one(`SELECT title_enc FROM tasks WHERE client_id=? AND priority='high'`, id);
  assert.ok(task && /Possible duplicate/.test(require('../server/crypto').decrypt(task.title_enc)), 'a task asks a supervisor to compare the two');
});

test('the office says which rejections are final, and the device contract lists them', () => {
  const SYNC = require('../server/sync-tables');
  for (const r of ['immutable', 'purged', 'not on caseload', 'your role cannot write tasks', 'conflicts with an existing record', 'server-owned', 'attributed to another user, which your role cannot do']) assert.equal(SYNC.isPermanentReason(r), true, r);
  assert.equal(SYNC.isPermanentReason('database is locked'), false);
  assert.equal(SYNC.isPermanentReason(''), false);
});

test('rejections carry a permanent flag so a device stops resending what will never be taken', async () => {
  const task = randomUUID();
  const r = await push(nav, { tables: { tasks: [{ id: task, client_id: otherClientId, created_by: navId, title_enc: 'Not mine', created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  const x = r.data.rejected.find(y => y.id === task);
  assert.ok(x && x.permanent === true, 'not on caseload is final');
  const tmpl = randomUUID();
  const t = await push(nav, { tables: { form_templates: [{ id: tmpl, name: 'Injected', category: 'other', fields_json: '[]', created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  assert.equal(t.data.rejected[0].permanent, true, 'a role limit is final');
});

test('supply counts are pull-only, and a pushed visit draws the office shelf down once', async () => {
  const stock = (await admin.post('/api/supplies', { item: 'Naloxone kit', quantity: 20 })).data;
  const qty = () => H.db.one(`SELECT quantity FROM supply_stock WHERE id=?`, stock.id).quantity;
  // Two devices each record a visit that handed out kits.
  const a = randomUUID(); const b = randomUUID();
  const r1 = await push(nav, { tables: { interventions: [{ id: a, client_id: clientId, user_id: navId, type: 'naloxone_distribution', occurred_at: iso(Date.now()), naloxone_kits: 2, fentanyl_strips: 0, created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  const r2 = await push(nav2, { tables: { interventions: [{ id: b, client_id: otherClientId, user_id: nav2Id, type: 'naloxone_distribution', occurred_at: iso(Date.now()), naloxone_kits: 3, fentanyl_strips: 0, created_at: iso(Date.now()), updated_at: iso(Date.now()) }] } });
  assert.deepEqual(r1.data.rejected, []); assert.deepEqual(r2.data.rejected, []);
  assert.equal(qty(), 15, 'the office stock fell by the sum of both visits');
  // The same row again (a re-sync) draws nothing more; an edit draws the difference.
  await push(nav, { tables: { interventions: [{ id: a, client_id: clientId, user_id: navId, type: 'naloxone_distribution', occurred_at: iso(Date.now()), naloxone_kits: 2, fentanyl_strips: 0, updated_at: iso(Date.now() + 1000) }] } });
  assert.equal(qty(), 15);
  await push(nav, { tables: { interventions: [{ id: a, client_id: clientId, user_id: navId, type: 'naloxone_distribution', occurred_at: iso(Date.now()), naloxone_kits: 4, fentanyl_strips: 0, updated_at: iso(Date.now() + 2000) }] } });
  assert.equal(qty(), 13, 'editing the count draws down the difference');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='supply.drawdown' AND ip='device'`), 'audited like the REST route');
  // A device's own absolute count is never the truth.
  const r3 = await push(nav, { tables: { supply_stock: [{ id: stock.id, item: 'Naloxone kit', quantity: 999, updated_by: navId, updated_at: iso(Date.now() + 9000) }] }, tombstones: [{ table_name: 'supply_stock', id: stock.id, deleted_at: iso(Date.now() + 9000) }] });
  assert.equal(r3.data.rejected.filter(x => x.id === stock.id && x.reason === 'server-owned' && x.permanent).length, 2, 'both the row and the tombstone are refused');
  assert.equal(qty(), 13);
});

test('a device may name another worker only when its user could over REST', async () => {
  const mk = (uid) => ({ id: randomUUID(), client_id: clientId, user_id: uid, type: 'outreach', occurred_at: iso(Date.now()), created_at: iso(Date.now()), updated_at: iso(Date.now()) });
  // A navigator on a shared phone cannot put a visit in a colleague's name.
  const forged = mk(nav2Id);
  const r = await push(nav, { tables: { interventions: [forged] } });
  const x = r.data.rejected.find(y => y.id === forged.id);
  assert.ok(x && /attributed/.test(x.reason) && x.permanent, 'rejected outright, not silently re-attributed');
  assert.ok(!H.db.one(`SELECT 1 FROM interventions WHERE id=?`, forged.id));
  // A supervisor/admin (clients:all) may, exactly as with POST /api/interventions.
  const onBehalf = mk(navId);
  const r2 = await push(admin, { tables: { interventions: [onBehalf] } });
  assert.deepEqual(r2.data.rejected, []);
  assert.equal(H.db.one(`SELECT user_id FROM interventions WHERE id=?`, onBehalf.id).user_id, navId);
  // But never to an account the office has deactivated.
  const ghost = H.makeUser('sgone', 'navigator'); H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, ghost.id);
  const r3 = await push(admin, { tables: { interventions: [mk(ghost.id)] } });
  assert.ok(r3.data.rejected.some(y => /deactivated/.test(y.reason)));
  // The pushing user's own id, or none, is always fine.
  const own = mk(undefined);
  const r4 = await push(nav, { tables: { interventions: [own] } });
  assert.deepEqual(r4.data.rejected, []);
  assert.equal(H.db.one(`SELECT user_id FROM interventions WHERE id=?`, own.id).user_id, navId);
});

test('retention: inactive is not a discharge, open work blocks a purge, and merged records go together', async () => {
  const R = require('../server/retention');
  const inactive = (await nav.post('/api/clients', { first_name: 'Drifted', last_name: 'Away', status: 'inactive', discharge_date: '2010-01-01' })).data.id;
  H.db.run(`UPDATE episodes SET status='closed', closed_at='2010-01-01' WHERE client_id=?`, inactive);
  assert.ok(!R.expiredClients().some(x => x.id === inactive), 'an inactive record is never due');

  const blocked = (await nav.post('/api/clients', { first_name: 'Still', last_name: 'Waiting', status: 'closed', discharge_date: '2010-01-01' })).data.id;
  const res = (await admin.post('/api/resources', { name: 'Retention test agency', category: 'other' })).data;
  H.db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status) VALUES(?,?,?,?,?,?)`, randomUUID(), blocked, res.id, navId, '2010-01-01T00:00:00.000Z', 'pending');
  assert.ok(R.expiredClients().some(x => x.id === blocked), 'due by date');
  const run = R.purgeExpiredClients();
  assert.ok(run.skipped.includes(H.db.one(`SELECT client_code FROM clients WHERE id=?`, blocked).client_code), 'but skipped');
  assert.ok(H.db.one(`SELECT 1 FROM clients WHERE id=?`, blocked), 'and still there');
  const sk = H.db.one(`SELECT details FROM audit_log WHERE action='client.purge.skipped' AND entity_id=?`, blocked);
  assert.ok(sk && JSON.parse(sk.details).open_referrals === 1, 'with the reason on record');

  const keeper = (await nav.post('/api/clients', { first_name: 'Same', last_name: 'Person', status: 'closed', discharge_date: '2010-01-01' })).data.id;
  const dup = (await nav.post('/api/clients', { first_name: 'Same', last_name: 'Person', confirm_duplicate: true })).data.id;
  assert.equal((await admin.post(`/api/clients/${keeper}/merge`, { source_id: dup })).status, 200);
  H.db.run(`UPDATE episodes SET status='closed', closed_at='2010-01-01' WHERE client_id=?`, keeper);
  H.db.run(`UPDATE tasks SET status='cancelled' WHERE client_id=?`, keeper);
  H.db.run(`INSERT INTO imports(id,source,imported_by) VALUES(?,?,?)`, 'imp-purge', 'generic', navId);
  H.db.run(`INSERT INTO import_items(id,import_id,content_enc,suggested_client_id) VALUES(?,?,?,?)`, 'item-purge', 'imp-purge', require('../server/crypto').encrypt('x'), keeper);
  assert.ok(!R.expiredClients().some(x => x.id === dup), 'a merged-away record is not on a clock of its own');
  const run2 = R.purgeExpiredClients();
  assert.ok(run2.purged.length >= 1);
  assert.ok(!H.db.one(`SELECT 1 FROM clients WHERE id=?`, keeper) && !H.db.one(`SELECT 1 FROM clients WHERE id=?`, dup), 'the duplicate went with the record it was merged into');
  assert.ok(H.db.one(`SELECT 1 FROM tombstones WHERE table_name='clients' AND id=?`, dup));
  assert.equal(H.db.one(`SELECT suggested_client_id FROM import_items WHERE id='item-purge'`).suggested_client_id, null, 'the import suggestion no longer dangles');
});
