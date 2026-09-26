'use strict';
// A client newly on a device's caseload arrives whole (ADR-0003) -- and, since 1.12.1, in pages. Up to 1.12.0
// the whole record set of every newly assigned client rode on the one page that carried the assignment: one
// client with 40,000 visits made a single pull of 40,531 rows (25.5 MB of JSON, 810 ms of synchronous work)
// against a page limit of 2,000, and a bulk caseload transfer did the same for every client moved. The
// backfill now has its own keyset cursor, carried inside the pull cursor, so every page stays within the limit
// and a device -- including an older kernel that only echoes the cursor back until `complete` -- receives
// the whole record set over successive pulls.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');
const { encrypt } = require('../server/crypto');

const NEVER = '1970-01-01T00:00:00.000Z';
let admin, navA, aId, bId;

const pageRows = (data) => Object.values(data.tables).reduce((n, rows) => n + rows.length, 0);
/** Pull the way a device does (older kernels included): echo the cursor back until complete. */
async function pullAll(c, since, limit, { maxPages = 1000 } = {}) {
  const tables = {}; let cursor = since; let pages = 0; const sizes = []; let complete = false;
  for (;;) {
    const r = await c.get(`/api/sync/pull?since=${encodeURIComponent(cursor)}&limit=${limit}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (const [t, rows] of Object.entries(r.data.tables)) (tables[t] = tables[t] || new Map()) && rows.forEach((row) => tables[t].set(row.id, row));
    sizes.push(pageRows(r.data));
    for (const [t, rows] of Object.entries(r.data.tables)) assert.ok(rows.length <= limit, `${t}: ${rows.length} rows on one page, over the limit of ${limit}`);
    cursor = r.data.cursor; pages++; complete = !!r.data.complete;
    if (complete || pages >= maxPages) break;
  }
  return { tables, cursor, pages, sizes, complete };
}
const has = (pulled, t, id) => !!(pulled.tables[t] && pulled.tables[t].has(id));

// A client of navigator B with a long history, every row stamped long before any device's cursor.
function oldClient(visits, notes) {
  const id = randomUUID();
  const old = '2025-03-01T10:00:00.000Z';
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,created_at,updated_at) VALUES(?,?,?,?,?,?)`, id, `BF-${id.slice(0, 8)}`, encrypt('Back'), encrypt('Fill'), old, old);
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, randomUUID(), id, bId, 'primary', '2025-03-01', old, old);
  H.db.transaction(() => {
    for (let i = 0; i < visits; i++) {
      const at = new Date(Date.parse(old) + i * 1000).toISOString();
      H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, randomUUID(), id, bId, 'outreach_contact', at, at, at);
    }
    for (let i = 0; i < notes; i++) H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), id, bId, 'admin', encrypt('note ' + i), old, old, old);
  });
  return id;
}

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  aId = H.makeUser('bfa', 'navigator').id; bId = H.makeUser('bfb', 'navigator').id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  navA = H.client(); await navA.login('bfa', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('one newly assigned client with thousands of visits arrives over several pages, each within the limit, and whole', async () => {
  const big = oldClient(3000, 40);
  const first = await pullAll(navA, NEVER, 200);
  assert.ok(first.complete && !has(first, 'clients', big), 'not on the caseload yet');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await admin.post(`/api/clients/${big}/assignments`, { user_id: aId, role_on_case: 'secondary' })).status, 201);

  const next = await pullAll(navA, first.cursor, 200);
  assert.ok(next.complete, 'the pull completes');
  assert.ok(next.pages >= 15, `the backfill was paged (${next.pages} pages)`);
  assert.ok(Math.max(...next.sizes) <= 200, `no page carried more than the limit (largest ${Math.max(...next.sizes)})`);
  assert.ok(has(next, 'clients', big), 'the client arrives');
  for (const r of H.db.all(`SELECT id FROM interventions WHERE client_id=?`, big)) assert.ok(has(next, 'interventions', r.id), `visit ${r.id} arrives`);
  for (const r of H.db.all(`SELECT id FROM notes WHERE client_id=?`, big)) assert.ok(has(next, 'notes', r.id), `note ${r.id} arrives`);

  // Delivered once: the next sync does not start the backfill again.
  const again = await pullAll(navA, next.cursor, 200);
  assert.ok(!has(again, 'interventions', H.db.one(`SELECT id FROM interventions WHERE client_id=? LIMIT 1`, big).id));
  assert.equal(again.pages, 1);
});

test('a sync cut short mid-backfill (an older kernel stops after so many pages) finishes on the next sync from the stored cursor', async () => {
  const c = oldClient(1200, 5);
  const start = await pullAll(navA, NEVER, 150);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await admin.post(`/api/clients/${c}/assignments`, { user_id: aId, role_on_case: 'secondary' })).status, 201);
  const part = await pullAll(navA, start.cursor, 150, { maxPages: 3 });
  assert.equal(part.complete, false, 'stopped before the backfill was done');
  const rest = await pullAll(navA, part.cursor, 150);
  assert.ok(rest.complete);
  const got = new Set([...(part.tables.interventions?.keys() || []), ...(rest.tables.interventions?.keys() || [])]);
  for (const r of H.db.all(`SELECT id FROM interventions WHERE client_id=?`, c)) assert.ok(got.has(r.id), `visit ${r.id} arrives across the two syncs`);
});

test('a bulk caseload transfer of many clients is paged too, and every moved client arrives whole', async () => {
  const cId = H.makeUser('bfc', 'navigator').id;
  const navC = H.client(); await navC.login('bfc', 'StaffPassw0rd!x');
  const moved = [];
  for (let i = 0; i < 40; i++) moved.push(oldClient(30, 3));
  const start = await pullAll(navC, NEVER, 100);
  assert.ok(!moved.some((id) => has(start, 'clients', id)));
  await new Promise((r) => setTimeout(r, 5));
  const t = await admin.post('/api/caseload/transfer', { from_user_id: bId, to_user_id: cId, client_ids: moved });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const next = await pullAll(navC, start.cursor, 100);
  assert.ok(next.complete);
  assert.ok(Math.max(...next.sizes) <= 100, `no page carried more than the limit (largest ${Math.max(...next.sizes)})`);
  for (const id of moved) {
    assert.ok(has(next, 'clients', id), `client ${id} arrives`);
    for (const r of H.db.all(`SELECT id FROM interventions WHERE client_id=?`, id)) assert.ok(has(next, 'interventions', r.id));
    for (const r of H.db.all(`SELECT id FROM notes WHERE client_id=?`, id)) assert.ok(has(next, 'notes', r.id));
  }
});

test('a forged or damaged backfill cursor is refused, not trusted', async () => {
  const r = await navA.get(`/api/sync/pull?since=${encodeURIComponent('2026-01-01T00:00:00.000Z~bf.not-base64-json')}`);
  assert.equal(r.status, 400);
});
