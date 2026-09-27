'use strict';
// 1.14.0 performance work (docs/PERFORMANCE.md): a sync pull finds where its page ends in a first pass over
// timestamps (from the (client_id, updated_at) indexes), then reads whole rows only for what it sends, and skips
// a table with nothing newer than the device's cursor. The one-pass algorithm it replaced is kept here as the
// reference: walking every page of a first sync and of later syncs, with a small page limit, both must produce
// the same cursors, the same `complete` flags and the same rows, including a timestamp shared by more rows
// than a page holds, rows of other workers' anonymous visits, and a row stamped in the future.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;
const { uuid, encrypt } = require('../server/crypto');

let navUser, adminUser;
before(async () => {
  await H.start();
  const navId = H.makeUser('psync_nav', 'navigator').id;
  const other = H.makeUser('psync_other', 'navigator').id;
  const stamp = (i) => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 3600000).toISOString();
  const clients = [];
  db.transaction(() => {
    for (let i = 0; i < 24; i++) {
      const id = uuid(); clients.push(id);
      db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?)`, id, `PS-${100 + i}`, encrypt('A'), encrypt('B'), 'active', '2026-01-01', navId, stamp(i * 3));
      if (i % 3) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,updated_at) VALUES(?,?,?,?,?,?)`, uuid(), id, navId, 'primary', '2025-01-01', stamp(1));
    }
    for (let i = 0; i < 90; i++) {
      // A burst of 12 notes written at one instant (more than a page of 5), and the rest spread out.
      const at = i >= 30 && i < 42 ? stamp(40) : stamp(i);
      db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status,updated_at) VALUES(?,?,?,?,?,?,?,?)`, uuid(), clients[i % 24], navId, 'admin', encrypt('n'), at, 'signed', at);
    }
    for (let i = 0; i < 70; i++) {
      const anon = i % 7 === 0;
      db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
        uuid(), anon ? null : clients[(i * 5) % 24], i % 2 ? navId : other, anon ? 'naloxone_distribution' : 'outreach', stamp(i * 2), 10, 'field', stamp(i * 2 + 1));
    }
    for (let i = 0; i < 20; i++) db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,updated_at) VALUES(?,?,?,?,?,?)`, uuid(), i % 4 ? clients[i % 24] : null, i % 3 ? navId : other, 'inbound', stamp(i), stamp(i * 7));
    // A row a device's wrong clock stamped next year: never sent before its time, by either algorithm.
    db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,updated_at) VALUES(?,?,?,?,?,?)`, uuid(), clients[1], navId, 'inbound', stamp(3), '2099-01-01T00:00:00.000Z');
  });
  navUser = db.one(`SELECT * FROM users WHERE id=?`, navId);
  adminUser = db.one(`SELECT * FROM users WHERE username='admin'`);
});
after(async () => { await H.stop(); });

// The 1.13 page: each table's first `limit` rows read whole, cut at a timestamp boundary, and every table then
// filtered to the earliest boundary (server/routes/sync.js before 1.14.0).
function onePass(user, since, limit, serverNow) {
  const S = require('../server/routes/sync'); const SYNC = require('../server/sync-tables');
  const raw = {}; const capped = [];
  for (const t of SYNC.tables) {
    const sc = S.scopeSql(t, user, 'x');
    const rows = db.all(`SELECT x.* FROM ${t.name} x WHERE x.updated_at > ? AND ${sc.sql} ORDER BY x.updated_at LIMIT ?`, since, ...sc.params, limit + 1);
    if (rows.length <= limit) { raw[t.name] = rows; continue; }
    const boundary = rows[limit].updated_at;
    const safe = rows.filter(r => r.updated_at < boundary);
    if (safe.length) { raw[t.name] = safe; capped.push(safe[safe.length - 1].updated_at); continue; }
    raw[t.name] = db.all(`SELECT x.* FROM ${t.name} x WHERE x.updated_at = ? AND ${sc.sql} ORDER BY x.updated_at`, boundary, ...sc.params);
    capped.push(boundary);
  }
  const cursor = capped.length ? capped.reduce((a, b) => (a < b ? a : b)) : serverNow;
  const ids = {};
  for (const [name, rows] of Object.entries(raw)) ids[name] = rows.filter(r => r.updated_at <= cursor).map(r => r.id).sort();
  return { cursor, complete: capped.length === 0, ids };
}

for (const [who, user] of [['a navigator (caseload and own anonymous visits)', () => navUser], ['an administrator (everything)', () => adminUser]]) {
  test(`every page of a sync, first and later, is what the one-pass pull produced, for ${who}`, () => {
    const { pull } = require('../server/routes/sync');
    for (const start of ['1970-01-01T00:00:00.000Z', '2026-01-02T05:00:00.000Z', '2026-01-03T00:00:00.000Z']) {
      let since = start; let pages = 0; let sent = 0;
      for (;;) {
        const got = pull(user(), since, { limit: 5 });
        const ref = onePass(user(), since, 5, got.server_now);
        const gotIds = Object.fromEntries(Object.entries(got.tables).map(([k, rows]) => [k, rows.map(r => r.id).sort()]));
        for (const name of new Set([...Object.keys(ref.ids), ...Object.keys(gotIds)])) assert.deepEqual(gotIds[name] || [], ref.ids[name] || [], `${name}, page ${pages + 1} from ${start}`);
        assert.equal(got.complete, ref.complete, `complete, page ${pages + 1} from ${start}`);
        assert.equal(got.cursor, ref.cursor, `cursor, page ${pages + 1} from ${start}`);
        for (const rows of Object.values(got.tables)) sent += rows.length;
        pages++;
        if (got.complete) break;
        since = got.cursor;
        assert.ok(pages < 200, 'the walk ends');
      }
      assert.ok(pages > 3 && sent > 0, `several pages were walked from ${start} (${pages})`);
    }
  });
}

test('a table with nothing newer than the cursor is skipped, and a pull with nothing new reads no rows', () => {
  const { pull } = require('../server/routes/sync');
  const statements = [];
  const orig = db.all;
  db.all = (sql, ...p) => { statements.push(sql); return orig(sql, ...p); };
  try { pull(navUser, '2098-01-01T00:00:00.000Z'); } finally { db.all = orig; }
  // Only the row stamped in 2099 is newer: the calls table is looked at, nothing else is.
  const tables = statements.filter(s => /FROM (\w+) x WHERE x\.updated_at > \?/.test(s)).map(s => s.match(/FROM (\w+) x/)[1]);
  assert.deepEqual([...new Set(tables)], ['calls'], tables.join(', '));
});

test('the first pass reads timestamps from the (client_id, updated_at) indexes, never the rows', () => {
  const S = require('../server/routes/sync'); const SYNC = require('../server/sync-tables');
  for (const name of ['notes', 'interventions', 'calls', 'intervention_supplies', 'suprt_assessments']) {
    const t = SYNC.tables.find(x => x.name === name);
    const sc = S.scopeSql(t, navUser, 'x');
    const plan = db.all(`EXPLAIN QUERY PLAN SELECT x.updated_at u FROM ${name} x WHERE x.updated_at > ? AND ${sc.sql} ORDER BY x.updated_at LIMIT ?`, '1970', ...sc.params, 5).map(p => p.detail).join(' | ');
    assert.match(plan, new RegExp(`COVERING INDEX idx_${name}_sync`), `${name}: ${plan}`);
  }
});

test('who came onto a caseload is looked up by worker and client together, not by scanning the worker\'s assignments per row', () => {
  const auth = require('../server/auth');
  const sql = `SELECT DISTINCT a.client_id FROM assignments a WHERE a.user_id=? AND ${auth.activeAssignment('a.')} AND a.updated_at > ? AND a.updated_at <= ?
    AND NOT EXISTS (SELECT 1 FROM assignments b WHERE b.client_id=a.client_id AND b.user_id=? AND b.updated_at <= ? AND ${auth.activeAssignment('b.')})`;
  const plan = db.all(`EXPLAIN QUERY PLAN ${sql}`, 'u', '1970', '2030', 'u', '1970').map(p => p.detail).join(' | ');
  assert.match(plan, /idx_assign_caseload \(user_id=\? AND client_id=\?\)/, plan);
  // And a caseload filter is answered from the index alone.
  const cf = auth.caseloadFilter({ id: 'u', role: 'navigator' }, 'c.id');
  const p2 = db.all(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM clients c WHERE ${cf.sql}`, ...cf.params).map(p => p.detail).join(' | ');
  assert.match(p2, /COVERING INDEX idx_assign_caseload/, p2);
});
