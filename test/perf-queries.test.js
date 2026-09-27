'use strict';
// 1.14.0 performance work (docs/PERFORMANCE.md), the rest of it: the client list, the notes list and the timeline
// find their page before reading its rows; a list's total leaves out the lookups that cannot change it; the
// Supplies page adds up the ledger once; migration 46's indexes; and the prepared-statement cache in server/db.js.
// Each is checked against what the code it replaced produced (the 1.13 query, kept here as the reference).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;
const { uuid, encrypt } = require('../server/crypto');

let admin, nav, navId, supId;
const clients = [];
before(async () => {
  await H.start();
  navId = H.makeUser('pq_nav', 'navigator').id;
  supId = H.makeUser('pq_sup', 'supervisor').id;
  const past = (d) => new Date(Date.now() - d * 86400000).toISOString();
  db.transaction(() => {
    for (let i = 0; i < 90; i++) {
      const id = uuid(); clients.push(id);
      // Many share an updated_at and a risk level, and many have no contact at all: ties the order must break by id.
      db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,risk_level,intake_date,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        id, `PQ-${1000 + i}`, encrypt('A'), encrypt('B'), i % 9 ? 'active' : 'waitlist', ['low', 'high', 'critical', 'moderate', null][i % 5], '2026-01-01', supId, past(i % 4));
      if (i % 2) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date) VALUES(?,?,?,?,?)`, uuid(), id, navId, 'primary', '2025-01-01');
      if (i % 3) db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,summary_enc) VALUES(?,?,?,?,?,?,?,?)`, uuid(), id, i % 2 ? navId : supId, 'outreach', past(i % 11), 10, 'field', encrypt(`visit ${i}`));
      if (i % 4 === 0) db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,outcome) VALUES(?,?,?,?,?,?)`, uuid(), id, navId, 'inbound', past(i % 7), i % 8 ? 'reached' : 'no_answer');
      if (i % 5 === 0) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,status) VALUES(?,?,?,?,?,?,?)`, uuid(), id, navId, navId, encrypt('Follow up'), past(3).slice(0, 10), 'open');
      for (let n = 0; n < 1 + (i % 3); n++) db.run(`INSERT INTO notes(id,client_id,author_id,kind,content_enc,occurred_at,status) VALUES(?,?,?,?,?,?,?)`, uuid(), id, n % 2 ? navId : supId, 'admin', encrypt('note'), past((i + n) % 13), n ? 'signed' : 'draft');
    }
  });
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('pq_nav', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

// The 1.13 client list query (server/routes/clients.js), unfiltered.
function clientListReference(user, sort, limit, offset) {
  const auth = require('../server/auth');
  const cf = auth.caseloadFilter(user);
  const order = { last_contact: 'last_contact IS NOT NULL, last_contact ASC', overdue: 'overdue_tasks DESC, last_contact ASC',
    risk: `CASE c.risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, last_contact ASC` }[sort] || 'c.updated_at DESC';
  return db.all(`SELECT c.id, (SELECT MAX(t) FROM (SELECT MAX(occurred_at) t FROM interventions i WHERE i.client_id=c.id UNION ALL SELECT MAX(started_at) FROM calls ca WHERE ca.client_id=c.id AND ca.outcome IN ('reached','replied'))) AS last_contact,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id=c.id AND t.status IN ('open','in_progress') AND (CASE WHEN length(t.due_at)=10 THEN t.due_at < date('now','localtime') ELSE t.due_at < ? END)) AS overdue_tasks
      FROM clients c WHERE c.deleted_at IS NULL AND c.merged_into IS NULL AND ${cf.sql} ORDER BY ${order}, c.id LIMIT ? OFFSET ?`, db.now(), ...cf.params, limit, offset);
}

test('the client list pages, in every sort order, are the rows and order the one-query list gave', async () => {
  const users = { admin: db.one(`SELECT * FROM users WHERE username='admin'`), nav: db.one(`SELECT * FROM users WHERE id=?`, navId) };
  for (const [who, c] of [['admin', admin], ['nav', nav]]) {
    for (const sort of ['', 'last_contact', 'overdue', 'risk']) {
      for (const offset of [0, 20, 40]) {
        const r = await c.get(`/api/clients?limit=20&offset=${offset}${sort ? `&sort=${sort}` : ''}`);
        assert.equal(r.status, 200);
        const ref = clientListReference(users[who], sort, 20, offset);
        assert.deepEqual(r.data.clients.map(x => x.id), ref.map(x => x.id), `${who} sort=${sort || 'default'} offset=${offset}`);
        assert.deepEqual(r.data.clients.map(x => [x.last_contact, x.overdue_tasks]), ref.map(x => [x.last_contact, x.overdue_tasks]), `${who} sort=${sort || 'default'} columns`);
      }
    }
  }
  const withConsent = await admin.get('/api/clients?limit=10&consent_expiring=1');
  assert.equal(withConsent.status, 200);
});

test('the notes list page is the one the one-query list gave, and its total counts the same notes', async () => {
  for (const [c, uid, scoped] of [[admin, null, false], [nav, navId, true]]) {
    const r = await c.get('/api/notes?limit=15&offset=5');
    assert.equal(r.status, 200);
    const cf = scoped ? `AND n.client_id IN (SELECT client_id FROM assignments WHERE user_id='${uid}')` : '';
    const ref = db.all(`SELECT n.id, n.occurred_at FROM notes n JOIN users u ON u.id=n.author_id JOIN clients c ON c.id=n.client_id WHERE n.deleted_at IS NULL AND n.kind IN ('admin','clinical') ${cf} ORDER BY n.occurred_at DESC`);
    assert.deepEqual(r.data.rows.map(x => x.occurred_at), ref.slice(5, 20).map(x => x.occurred_at), 'the page, in date order');
    assert.equal(r.data.total, ref.length);
    assert.ok(r.data.rows.every(x => typeof x.addenda === 'number' && 'author' in x && 'client_code' in x), 'each row has its columns');
  }
});

test('a list\'s total leaves out the lookups that cannot change it, and still counts what the list shows', async () => {
  const r = await admin.get('/api/interventions?limit=5');
  assert.equal(r.data.total, db.one(`SELECT COUNT(*) n FROM interventions`).n);
  const n = await nav.get('/api/interventions?limit=5');
  assert.equal(n.data.total, db.one(`SELECT COUNT(*) n FROM interventions i WHERE i.client_id IN (SELECT client_id FROM assignments WHERE user_id=?) OR (i.client_id IS NULL AND i.user_id=?)`, navId, navId).n);
  const ranged = await admin.get(`/api/interventions?limit=5&from=${new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)}`);
  assert.equal(ranged.data.total, db.one(`SELECT COUNT(*) n FROM interventions WHERE occurred_at >= ?`, new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)).n);
  // The SQL itself: a LEFT JOIN on a primary key is dropped from the COUNT unless the filters name its alias.
  const statements = [];
  const orig = db.one; db.one = (sql, ...p) => { statements.push(sql); return orig(sql, ...p); };
  try { await admin.get('/api/interventions?limit=5'); await admin.get('/api/calls?limit=5'); } finally { db.one = orig; }
  const counts = statements.filter(s => /^SELECT COUNT\(\*\) n FROM (interventions|calls)/.test(s));
  assert.equal(counts.length, 2);
  for (const s of counts) { assert.doesNotMatch(s, /LEFT JOIN/, s); assert.match(s, /JOIN users u/, 'an inner join stays: it decides which rows the list has'); }
});

test('timeline pages are slices of the one merged, date-ordered history, decrypted only for the page', async () => {
  const id = clients[4];
  const whole = await admin.get(`/api/clients/${id}/timeline?limit=500`);
  assert.equal(whole.status, 200);
  const kinds = new Set(whole.data.events.map(e => e.kind));
  assert.ok(kinds.has('intervention') && kinds.has('note') && kinds.has('milestone'), [...kinds].join());
  const a = await admin.get(`/api/clients/${id}/timeline?limit=2&offset=0`);
  const b = await admin.get(`/api/clients/${id}/timeline?limit=2&offset=2`);
  assert.deepEqual([...a.data.events, ...b.data.events], whole.data.events.slice(0, 4));
  assert.equal(a.data.more, whole.data.events.length > 2);
  const visit = whole.data.events.find(e => e.kind === 'intervention');
  assert.equal(visit.detail, 'visit 4', 'a summary on the page is decrypted');
  // A value that cannot be decrypted off the page no longer fails the page it is not on.
  let decrypts = 0;
  const crypto = require('../server/crypto'); const orig = crypto.decrypt;
  crypto.decrypt = (...x) => { decrypts++; return orig(...x); };
  try { await admin.get(`/api/clients/${id}/timeline?limit=1`); } finally { crypto.decrypt = orig; }
  assert.ok(decrypts <= 2, `only the page's values are decrypted (${decrypts})`);
});

test('the Supplies page adds the ledger up once, and its stock and alerts are what the per-item sums gave', async () => {
  const S = require('../server/supplies');
  const item = uuid(); const item2 = uuid(); const site2 = uuid();
  db.run(`INSERT INTO supply_items(id,name,category,unit,low_stock) VALUES(?,?,?,?,?)`, item, 'Narcan (perf)', 'naloxone', 'each', 50);
  db.run(`INSERT INTO supply_items(id,name,category,unit,low_stock) VALUES(?,?,?,?,?)`, item2, 'Strips (perf)', 'fentanyl_test_strips', 'each', 5);
  db.run(`INSERT INTO supply_sites(id,name,kind) VALUES(?,?,?)`, site2, 'Van (perf)', 'van');
  const actor = db.one(`SELECT * FROM users WHERE username='admin'`);
  const today = S.today();
  S.addEntry({ item_id: item, site_id: 'site-main', kind: 'received', quantity: 40, lot_number: 'A', expires_on: S.addDays(today, 10), occurred_on: today }, actor);
  S.addEntry({ item_id: item, site_id: 'site-main', kind: 'received', quantity: 30, lot_number: 'B', expires_on: S.addDays(today, -5), occurred_on: today }, actor);
  S.addEntry({ item_id: item, site_id: site2, kind: 'received', quantity: 10, lot_number: 'C', expires_on: null, occurred_on: today }, actor);
  S.addEntry({ item_id: item, site_id: site2, kind: 'distributed', quantity: -10, lot_number: 'C', expires_on: null, occurred_on: today }, actor); // a lot that adds up to nothing
  S.addEntry({ item_id: item2, site_id: site2, kind: 'received', quantity: 3, occurred_on: today }, actor);
  S.drawFEFO(item, 'site-main', 45, { date: today }, actor);
  // The 1.13 computations.
  const lots = db.all(`SELECT item_id, site_id, lot_number, expires_on, SUM(quantity) quantity FROM supply_ledger GROUP BY item_id, site_id, lot_number, expires_on HAVING SUM(quantity) <> 0`);
  const st = S.stock({ date: today });
  assert.deepEqual(st.lots.map(({ state, ...l }) => ({ ...l })), lots.map(l => ({ ...l })));
  const low = [];
  for (const it of db.all(`SELECT id, name, low_stock FROM supply_items WHERE is_active=1 AND low_stock IS NOT NULL`)) {
    for (const s of db.all(`SELECT id, name FROM supply_sites WHERE is_active=1 AND id IN (SELECT site_id FROM supply_ledger WHERE item_id=?)`, it.id)) {
      const q = db.one(`SELECT COALESCE(SUM(quantity),0) n FROM supply_ledger WHERE item_id=? AND site_id=?`, it.id, s.id).n; if (q <= it.low_stock) low.push({ item_id: it.id, site_id: s.id, quantity: q, low_stock: it.low_stock });
    }
  }
  assert.deepEqual(S.alerts({ date: today }).low, low);
  assert.ok(low.some(l => l.site_id === site2 && l.item_id === item && l.quantity === 0), 'a site whose lots add up to nothing is still low at 0');
  // The page reads the ledger's sums once.
  const statements = [];
  const orig = db.all; db.all = (sql, ...p) => { statements.push(sql); return orig(sql, ...p); };
  let page;
  try { page = await admin.get('/api/supplies'); } finally { db.all = orig; }
  assert.equal(page.status, 200);
  assert.equal(statements.filter(s => /SUM\(quantity\) quantity FROM supply_ledger GROUP BY/.test(s)).length, 1, 'one pass over the ledger');
  assert.deepEqual(page.data.alerts.low, low);
  assert.equal(JSON.stringify(page.data).includes('onHandOf'), false);
  const plan = db.all(`EXPLAIN QUERY PLAN SELECT item_id, site_id, lot_number, expires_on, SUM(quantity) quantity FROM supply_ledger GROUP BY item_id, site_id, lot_number, expires_on`).map(p => p.detail).join(' | ');
  assert.match(plan, /COVERING INDEX idx_supply_ledger_onhand/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
});

test('migration 46: the wider indexes replace the narrow ones, on a fresh database as on an upgraded one', () => {
  const names = db.all(`SELECT name FROM sqlite_master WHERE type='index'`).map(x => x.name);
  for (const n of ['idx_interventions_sync', 'idx_interventions_dashboard', 'idx_calls_sync', 'idx_notes_list', 'idx_notes_sync', 'idx_notes_drafts', 'idx_note_addenda_note',
    'idx_clients_merged', 'idx_intervention_supplies_sync', 'idx_supply_ledger_onhand', 'idx_supply_ledger_item_created', 'idx_suprt_assessments_sync']) assert.ok(names.includes(n), n);
  for (const n of ['idx_notes_client', 'idx_intervention_supplies_client', 'idx_supply_ledger_stock']) assert.ok(!names.includes(n), `${n} was replaced`);
  // The notes list and a note's addenda are read from indexes.
  const plan = (sql, ...p) => db.all(`EXPLAIN QUERY PLAN ${sql}`, ...p).map(x => x.detail).join(' | ');
  assert.match(plan(`SELECT COUNT(*) FROM note_addenda a WHERE a.note_id=?`, 'x'), /idx_note_addenda_note/);
  assert.match(plan(`SELECT COUNT(*) n FROM notes n WHERE n.deleted_at IS NULL AND n.kind IN ('admin') AND n.client_id=?`, 'x'), /COVERING INDEX idx_notes_list/);
});

test('the statement cache: a new handle starts afresh, a schema change is seen, and a failed statement can run again', () => {
  const dbm = require('../server/db');
  assert.equal(dbm.one(`SELECT 1 AS x`).x, 1);
  // A statement kept from before a column was added returns the new column (SQLite recompiles it).
  dbm.run(`CREATE TABLE perf_cache_t (id TEXT PRIMARY KEY, a TEXT)`);
  dbm.run(`INSERT INTO perf_cache_t VALUES('1','x')`);
  assert.deepEqual(Object.keys(dbm.one(`SELECT * FROM perf_cache_t`)), ['id', 'a']);
  dbm.get().exec(`ALTER TABLE perf_cache_t ADD COLUMN b TEXT`);
  assert.deepEqual(Object.keys(dbm.one(`SELECT * FROM perf_cache_t`)), ['id', 'a', 'b']);
  // A constraint failure leaves the kept statement usable.
  assert.throws(() => dbm.run(`INSERT INTO perf_cache_t(id,a) VALUES(?,?)`, '1', 'dup'));
  dbm.run(`INSERT INTO perf_cache_t(id,a) VALUES(?,?)`, '2', 'ok');
  assert.equal(dbm.one(`SELECT COUNT(*) n FROM perf_cache_t`).n, 2);
  // Nested use of the same statement (a helper calling the same query while the outer result is in hand).
  const outer = dbm.all(`SELECT id FROM perf_cache_t ORDER BY id`);
  const inner = outer.map(r => dbm.one(`SELECT a FROM perf_cache_t WHERE id=?`, r.id).a);
  assert.deepEqual(inner, ['x', 'ok']);
  dbm.run(`DROP TABLE perf_cache_t`);
  assert.throws(() => dbm.one(`SELECT * FROM perf_cache_t`), /no such table/);
});
