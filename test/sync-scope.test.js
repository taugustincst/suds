'use strict';
// A navigator's device may only ever hold what the navigator could read through the API: the clients on
// their caseload, what hangs off them, and the programme-wide rows the REST routes show everyone. These
// tests pull the way a device does -- every page, every table -- from a database full of sample data spread
// across two navigators, and check each row it was sent. Then the caseload changes under it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');
const SYNC = require('../server/sync-tables');

let navA, navB, admin, aId, bId;
const NEVER = '1970-01-01T00:00:00.000Z';

async function pullAll(c, since = NEVER, limit = 7) {
  const tables = {}; let tombstones = []; let dropped = []; let pages = 0; let cursor = since;
  for (;;) {
    const r = await c.get(`/api/sync/pull?since=${encodeURIComponent(cursor)}&limit=${limit}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (const [t, rows] of Object.entries(r.data.tables)) (tables[t] = tables[t] || []).push(...rows);
    tombstones = tombstones.concat(r.data.tombstones || []);
    dropped = dropped.concat(r.data.dropped_clients || []);
    cursor = r.data.cursor; pages++;
    if (r.data.complete || pages > 500) break;
  }
  return { tables, tombstones, dropped, cursor, pages };
}
const onCaseload = (uid) => new Set(H.db.all(`SELECT client_id FROM assignments WHERE user_id=? AND ${require('../server/auth').activeAssignment()}`, uid).map(r => r.client_id));

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  aId = H.makeUser('scopea', 'navigator').id; bId = H.makeUser('scopeb', 'navigator').id;
  const supId = H.makeUser('scopesup', 'supervisor').id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  navA = H.client(); await navA.login('scopea', 'StaffPassw0rd!x');
  navB = H.client(); await navB.login('scopeb', 'StaffPassw0rd!x');
  const adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  require('../server/demo').seed({ actor: adminId, workers: [aId, bId], clinician: null, supervisor: supId });
  // Each navigator imports a OneNote page naming someone. The REST routes show an import only to whoever
  // made it (server/routes/imports.js); sync used to send every import to every device.
  for (const [uid, who] of [[aId, 'A'], [bId, 'B']]) {
    const imp = randomUUID();
    H.db.run(`INSERT INTO imports(id,source,imported_by) VALUES(?,?,?)`, imp, 'onenote', uid);
    H.db.run(`INSERT INTO import_items(id,import_id,title_enc,content_enc) VALUES(?,?,?,?)`, randomUUID(), imp, require('../server/crypto').encrypt('Import ' + who), require('../server/crypto').encrypt('Met Private Person ' + who + ' at the shelter'));
  }
});
after(async () => { await H.stop(); });

function assertScoped(pulled, uid) {
  const mine = onCaseload(uid);
  const otherClients = H.db.all(`SELECT id FROM clients`).map(r => r.id).filter(id => !mine.has(id));
  assert.ok(mine.size > 0 && otherClients.length > 0, 'the sample data gives both navigators a caseload');
  const noteIds = new Set((pulled.tables.notes || []).map(n => n.id));
  const importIds = new Set((pulled.tables.imports || []).map(n => n.id));
  for (const t of SYNC.tables) {
    for (const row of pulled.tables[t.name] || []) {
      if (t.name === 'clients') { assert.ok(mine.has(row.id) || mine.has(row.merged_into), `client ${row.id} is not on the caseload`); continue; }
      if (t.scope === 'client') assert.ok(mine.has(row[t.clientCol]), `${t.name} ${row.id} belongs to a client off the caseload`);
      if (t.scope === 'client-or-null') assert.ok(row[t.clientCol] === null || mine.has(row[t.clientCol]), `${t.name} ${row.id} belongs to a client off the caseload`);
      if (t.scope === 'via-note') assert.ok(noteIds.has(row.note_id), `${t.name} ${row.id} hangs off a note this device was not sent`);
      if (t.name === 'imports') assert.ok(row.imported_by === uid || row.imported_by === null, `import ${row.id} belongs to someone else`);
      if (t.name === 'import_items') assert.ok(importIds.has(row.import_id), `import item ${row.id} belongs to someone else's import`);
    }
  }
  // Belt and braces: no other client's id appears anywhere in what was sent.
  const text = JSON.stringify(pulled.tables);
  for (const id of otherClients) {
    const merged = (pulled.tables.clients || []).some(c => c.id === id);
    if (!merged) assert.ok(!text.includes(id), `client ${id} (off the caseload) appears in the pull`);
  }
}

test('a navigator pulls only their caseload, across every page and every table', async () => {
  const pulled = await pullAll(navA);
  assert.ok(pulled.pages > 3, 'the small page size made the pull page');
  for (const t of ['clients', 'notes', 'consents', 'referrals', 'tasks', 'calls', 'episodes', 'interventions', 'assignments']) {
    assert.ok((pulled.tables[t] || []).length > 0, `the sample data gave ${t} rows to check`);
  }
  assertScoped(pulled, aId);
  assert.ok(!JSON.stringify(pulled.tables).includes('Private Person B'), 'another navigator\'s import never reaches this device');
  assert.equal((pulled.tables.import_items || []).length, 1, 'their own import does');
  // navigators hold no assessments:read, so ASAM ratings and outcome measures never travel to them at all
  assert.equal((pulled.tables.asam_assessments || []).length, 0);
  assertScoped(await pullAll(navB), bId);
});

test('a client taken off the caseload stops syncing and the device is told to purge it', async () => {
  const first = await pullAll(navA);
  const asg = H.db.one(`SELECT a.id, a.client_id FROM assignments a WHERE a.user_id=? AND ${require('../server/auth').activeAssignment('a.')} ORDER BY a.client_id LIMIT 1`, aId);
  // Make sure nobody else keeps navA on the case through a second assignment.
  const r = await admin.post(`/api/assignments/${asg.id}/end`, {});
  assert.equal(r.status, 200);
  assert.ok(!onCaseload(aId).has(asg.client_id));
  // A new note on the client after the change must not reach the device.
  H.db.run(`UPDATE clients SET risk_level='high', updated_at=? WHERE id=?`, H.db.now(), asg.client_id);
  const next = await pullAll(navA, first.cursor);
  assert.ok(!JSON.stringify(next.tables).includes(asg.client_id), 'nothing about the client is sent after the assignment ended');
  assert.ok(next.dropped.includes(asg.client_id), 'the device is told to remove the client it holds: ' + JSON.stringify(next.dropped));
  // Nothing on the caseload is on the purge list.
  for (const id of next.dropped) assert.ok(!onCaseload(aId).has(id));
  // A later incremental pull does not repeat it, and a fresh device never gets it at all.
  const later = await pullAll(navA, next.cursor);
  assert.ok(!later.dropped.includes(asg.client_id));
  assertScoped(await pullAll(navA), aId);
  // The other navigator is not told to purge anything of theirs.
  const b = await pullAll(navB, first.cursor);
  for (const id of b.dropped) assert.ok(!onCaseload(bId).has(id));
});

test('the device-side purge removes the client and everything that hangs off it', () => {
  // The same helper the device kernel runs (local/sync.js applyPull), exercised against a scratch database
  // built from schema.sql, so no row of the client is left orphaned on the phone.
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys=ON');
  d.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'schema.sql'), 'utf8'));
  const run = (sql, ...p) => d.prepare(sql).run(...p);
  const u = randomUUID(); run(`INSERT INTO users(id,username,password_hash,display_name,role) VALUES(?,?,?,?,?)`, u, 'x', 'h', 'x', 'navigator');
  const gone = randomUUID(); const kept = randomUUID();
  for (const [id, code] of [[gone, 'P-1'], [kept, 'P-2']]) run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,created_by) VALUES(?,?,?,?,?)`, id, code, 'x', 'y', u);
  const note = randomUUID();
  run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at) VALUES(?,?,?,?,?,?)`, note, gone, u, 'admin', 'x', '2026-01-01');
  run(`INSERT INTO note_addenda(id,note_id,author_id,content_enc) VALUES(?,?,?,?)`, randomUUID(), note, u, 'x');
  run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,summary_enc) VALUES(?,?,?,?,?,?)`, randomUUID(), gone, u, 'outbound', '2026-01-01', 'x');
  run(`INSERT INTO tasks(id,client_id,created_by,title_enc) VALUES(?,?,?,?)`, randomUUID(), gone, u, 'x');
  run(`INSERT INTO tasks(id,client_id,created_by,title_enc) VALUES(?,?,?,?)`, randomUUID(), kept, u, 'x');
  run(`CREATE TABLE sync_seen (table_name TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (table_name, id))`);
  run(`INSERT INTO sync_seen VALUES('clients',?,NULL)`, gone);
  const dbLike = { run, all: (sql, ...p) => d.prepare(sql).all(...p), one: (sql, ...p) => d.prepare(sql).get(...p) };
  const removed = SYNC.purgeClient(dbLike, gone);
  assert.ok(removed > 0);
  const count = (sql, ...p) => d.prepare(sql).get(...p).n;
  assert.equal(count(`SELECT COUNT(*) n FROM clients WHERE id=?`, gone), 0);
  for (const t of SYNC.tables) {
    if (!t.clientCol || t.name === 'clients') continue;
    assert.equal(count(`SELECT COUNT(*) n FROM ${t.name} WHERE ${t.clientCol}=?`, gone), 0, t.name);
  }
  assert.equal(count(`SELECT COUNT(*) n FROM note_addenda`), 0, 'addenda go with their note');
  assert.equal(count(`SELECT COUNT(*) n FROM calls WHERE client_id IS NULL`), 0, 'a call is deleted, not orphaned with its summary');
  assert.equal(count(`SELECT COUNT(*) n FROM sync_seen`), 0);
  assert.equal(count(`SELECT COUNT(*) n FROM tombstones`), 0, 'a caseload purge is not a deletion the device reports back');
  assert.equal(count(`SELECT COUNT(*) n FROM clients WHERE id=?`, kept), 1);
  assert.equal(count(`SELECT COUNT(*) n FROM tasks WHERE client_id=?`, kept), 1);
});

test('a client newly assigned after the last sync arrives whole on the next pull, and so does one assigned again', async () => {
  const active = require('../server/auth').activeAssignment;
  const first = await pullAll(navA);
  // One of the other navigator's clients with a history: notes, consents and visits all written long before
  // this device's cursor. Assigning it changes no client row, so a pull by updated_at alone missed all of it.
  const count = (t, id) => H.db.one(`SELECT COUNT(*) n FROM ${t} WHERE client_id=?`, id).n;
  const theirs = [...onCaseload(bId)].filter(id => !onCaseload(aId).has(id))
    .find(id => count('notes', id) && count('consents', id) && count('interventions', id));
  assert.ok(theirs, 'the sample data has a client of the other navigator with notes, consents and visits');
  // And one navA is taken off now, to be put back on after the device has synced without it.
  const asg = H.db.one(`SELECT id, client_id FROM assignments WHERE user_id=? AND ${active()} ORDER BY client_id LIMIT 1`, aId);
  assert.equal((await admin.post(`/api/assignments/${asg.id}/end`, {})).status, 200);
  const offAgain = asg.client_id;
  assert.ok(!onCaseload(aId).has(offAgain));
  const mid = await pullAll(navA, first.cursor);
  assert.ok(mid.dropped.includes(offAgain), 'the device is told to remove the client taken off');
  await new Promise(r => setTimeout(r, 5));
  for (const id of [theirs, offAgain]) assert.equal((await admin.post(`/api/clients/${id}/assignments`, { user_id: aId, role_on_case: 'secondary' })).status, 201);
  const next = await pullAll(navA, mid.cursor, 50);
  const ids = (t) => new Set((next.tables[t] || []).map(r => r.id));
  for (const id of [theirs, offAgain]) {
    assert.ok(ids('clients').has(id), `client ${id} arrives on the next pull`);
    for (const t of ['notes', 'consents', 'interventions', 'referrals', 'episodes', 'tasks', 'calls']) {
      let want = H.db.all(`SELECT * FROM ${t} WHERE client_id=?`, id);
      if (t === 'notes') want = want.filter(n => n.kind !== 'clinical'); // a navigator never gets clinical notes
      for (const r of want) assert.ok(ids(t).has(r.id), `${t} ${r.id} recorded before the assignment arrives with client ${id}`);
    }
    const notes = H.db.all(`SELECT id FROM notes WHERE client_id=? AND kind<>'clinical'`, id).map(n => n.id);
    for (const a of H.db.all(`SELECT id, note_id FROM note_addenda`)) if (notes.includes(a.note_id)) assert.ok(ids('note_addenda').has(a.id), 'addenda of its notes arrive too');
  }
  assert.ok(H.db.all(`SELECT id FROM notes WHERE client_id IN (?,?)`, theirs, offAgain).length > 0, 'the test covers old notes');
  assert.ok(!next.dropped.includes(theirs) && !next.dropped.includes(offAgain), 'neither is on the purge list');
  assertScoped(next, aId);
  // Once delivered, an unchanged client is not sent again.
  const after = await pullAll(navA, next.cursor);
  assert.ok(!(after.tables.clients || []).some(c => c.id === theirs || c.id === offAgain), 'the next pull does not resend them');
});
