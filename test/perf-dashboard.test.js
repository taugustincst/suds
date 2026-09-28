'use strict';
// 1.14.0 performance work (docs/PERFORMANCE.md): the Home dashboard reads the clients, the period's visits and its
// calls once each, grouped, and adds its figures up from the groups (server/routes/reports.js dashGroups), where it
// used to run a query per figure. The figures and the order of every list must be exactly what those queries
// gave. The queries of 1.13 are kept here as the reference and run against the same data: NULLs, equal counts
// (whose order the old ORDER BY n DESC left in key order), anonymous visits, bare-date visits, visits outside
// the period, deleted clients, and a navigator's caseload.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;
const { uuid } = require('../server/crypto');
const auth = require('../server/auth');

const FROM = '2026-01-01'; const TO = '2026-03-31';
let admin, nav, navUser, adminUser, sup, supUser;

before(async () => {
  await H.start();
  const config = require('../server/config');
  config.orgTimezone = 'UTC';
  const navId = H.makeUser('dash_nav', 'navigator').id;
  const supId = H.makeUser('dash_sup', 'supervisor').id;
  const other = H.makeUser('dash_other', 'navigator').id;
  const statuses = ['active', 'active', 'waitlist', 'closed', 'active'];
  const substances = ['opioids', null, 'unknown', 'alcohol', 'opioids', 'stimulants'];
  const mats = [null, 'active', 'none', null];
  const risks = ['high', 'critical', null, 'low', 'moderate'];
  const clients = [];
  db.transaction(() => {
    for (let i = 0; i < 60; i++) {
      const id = uuid(); clients.push(id);
      db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,primary_substance,mat_status,risk_level,intake_date,deleted_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id, `D-${1000 + i}`, 'x', 'x', statuses[i % 5], substances[i % 6], mats[i % 4], risks[i % 5], i % 3 ? '2026-02-01' : '2025-06-01', i % 17 === 5 ? '2026-01-01T00:00:00.000Z' : null, supId);
      if (i % 2 === 0) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date) VALUES(?,?,?,?,?)`, uuid(), id, navId, 'primary', '2025-01-01');
    }
    const types = ['outreach', 'case_management', 'harm_reduction', 'peer_support'];
    const users = [navId, supId, other];
    for (let i = 0; i < 400; i++) {
      const anon = i % 11 === 0;
      const day = 1 + (i % 28); const month = 1 + (i % 4); // April is outside the period
      const at = i % 9 === 0 ? `2026-0${month}-${String(day).padStart(2, '0')}` : `2026-0${month}-${String(day).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:15:00.000Z`;
      db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,naloxone_kits,fentanyl_strips) VALUES(?,?,?,?,?,?,?,?,?)`,
        uuid(), anon ? null : clients[i % 60], users[i % 3], anon ? 'naloxone_distribution' : types[i % 4], at, i % 7 === 0 ? 0 : 10 + (i % 5), 'field', i % 4 === 0 ? 2 : 0, i % 6 === 0 ? 5 : 0);
    }
    const outcomes = ['reached', 'no_answer', 'voicemail', 'reached'];
    for (let i = 0; i < 120; i++) {
      db.run(`INSERT INTO calls(id,client_id,user_id,direction,method,started_at,duration_minutes,outcome,crisis) VALUES(?,?,?,?,?,?,?,?,?)`,
        uuid(), i % 5 ? clients[i % 60] : null, users[i % 3], i % 2 ? 'inbound' : 'outbound', i % 4 === 0 ? 'text' : 'phone', `2026-0${1 + (i % 4)}-10T10:00:00.000Z`, i % 3, outcomes[i % 4], i % 10 === 0 ? 1 : 0);
    }
  });
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('dash_nav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('dash_sup', 'StaffPassw0rd!x');
  adminUser = db.one(`SELECT * FROM users WHERE username='admin'`); navUser = db.one(`SELECT * FROM users WHERE id=?`, navId); supUser = db.one(`SELECT * FROM users WHERE id=?`, supId);
});
after(async () => { await H.stop(); });

// The 1.13 dashboard's queries for these figures, verbatim apart from the helpers they were written with.
function reference(user) {
  const { localMidnight } = require('../server/routes/budget');
  const fromTs = localMidnight(FROM);
  const toEnd = new Date(Date.parse(localMidnight(new Date(Date.parse(`${TO}T00:00:00Z`) + 86400000).toISOString().slice(0, 10))) - 1).toISOString();
  const lo = fromTs < FROM ? fromTs : FROM; const hi = toEnd > TO ? toEnd : TO;
  const ts = (col) => `(${col} BETWEEN ? AND ? AND ((length(${col})>10 AND ${col} BETWEEN ? AND ?) OR (length(${col})=10 AND ${col} BETWEEN ? AND ?)))`;
  const tsP = [lo, hi, fromTs, toEnd, FROM, TO];
  const cf = auth.caseloadFilter(user, 'c.id');
  const all = !auth.caseloadRestricted(user) || auth.hasPerm(user, 'clients:all');
  const vcf = auth.caseloadFilter(user, 'i.client_id');
  const vs = { sql: `(CASE WHEN i.client_id IS NULL THEN (i.user_id=? OR ?) ELSE ${vcf.sql} END)`, params: [user.id, all ? 1 : 0, ...vcf.params] };
  const one = (sql, ...p) => db.one(sql, ...p); const rows = (sql, ...p) => db.all(sql, ...p);
  const c = (extra, ...p) => one(`SELECT COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND ${extra} AND ${cf.sql}`, ...p, ...cf.params).n;
  return {
    clients: {
      active: c(`status='active'`), waitlist: c(`status='waitlist'`), new_in_range: c(`intake_date BETWEEN ? AND ?`, FROM, TO),
      high_risk: c(`status='active' AND c.risk_level IN ('high','critical')`),
      by_status: rows(`SELECT status, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND ${cf.sql} GROUP BY status`, ...cf.params),
      by_substance: rows(`SELECT COALESCE(primary_substance,'unknown') k, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND ${cf.sql} GROUP BY k ORDER BY n DESC`, ...cf.params),
      mat: rows(`SELECT COALESCE(mat_status,'unknown') k, COUNT(*) n FROM clients c WHERE deleted_at IS NULL AND status='active' AND ${cf.sql} GROUP BY k`, ...cf.params),
    },
    interventions: {
      ...one(`SELECT COUNT(*) total, COALESCE(SUM(duration_minutes),0) minutes, COALESCE(SUM(naloxone_kits),0) naloxone_kits, COALESCE(SUM(fentanyl_strips),0) fentanyl_strips FROM interventions i WHERE ${ts('i.occurred_at')} AND ${vs.sql}`, ...tsP, ...vs.params),
      by_type: rows(`SELECT i.type k, COUNT(*) n, SUM(duration_minutes) minutes FROM interventions i WHERE ${ts('i.occurred_at')} AND ${vs.sql} GROUP BY i.type ORDER BY n DESC`, ...tsP, ...vs.params),
      by_week: rows(`SELECT strftime('%Y-%W', i.occurred_at) k, COUNT(*) n FROM interventions i WHERE ${ts('i.occurred_at')} AND ${vs.sql} GROUP BY k ORDER BY k`, ...tsP, ...vs.params),
      by_worker: rows(`SELECT u.display_name k, COUNT(*) n, SUM(duration_minutes) minutes FROM interventions i JOIN users u ON u.id=i.user_id WHERE ${ts('i.occurred_at')} AND ${vs.sql} GROUP BY u.id ORDER BY n DESC`, ...tsP, ...vs.params),
    },
    // Calls are scoped as visits are since 1.16.0 (a caseload-scoped worker's Calls tile counted the whole
    // programme's): the 1.13 queries with the visits' scope on calls.
    calls: {
      total: one(`SELECT COUNT(*) n FROM calls i WHERE ${ts('started_at')} AND ${vs.sql}`, ...tsP, ...vs.params).n, minutes: one(`SELECT COALESCE(SUM(duration_minutes),0) n FROM calls i WHERE ${ts('started_at')} AND ${vs.sql}`, ...tsP, ...vs.params).n,
      crisis: one(`SELECT COUNT(*) n FROM calls i WHERE crisis=1 AND ${ts('started_at')} AND ${vs.sql}`, ...tsP, ...vs.params).n, by_outcome: rows(`SELECT outcome k, COUNT(*) n FROM calls i WHERE ${ts('started_at')} AND ${vs.sql} GROUP BY outcome ORDER BY n DESC`, ...tsP, ...vs.params),
      by_direction: rows(`SELECT direction k, COUNT(*) n FROM calls i WHERE ${ts('started_at')} AND ${vs.sql} GROUP BY direction`, ...tsP, ...vs.params),
      texts: one(`SELECT COUNT(*) n FROM calls i WHERE method='text' AND ${ts('started_at')} AND ${vs.sql}`, ...tsP, ...vs.params).n,
    },
  };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

for (const [who, get] of [['an administrator', () => [admin, adminUser]], ['a supervisor', () => [sup, supUser]], ['a navigator (caseload-scoped)', () => [nav, navUser]]]) {
  test(`the dashboard's figures and lists are those the 1.13 queries gave, for ${who}`, async () => {
    const [c, user] = get();
    const r = await c.get(`/api/reports/dashboard?from=${FROM}&to=${TO}`);
    assert.equal(r.status, 200);
    const ref = plain(require('../server/dashboard-mask').dashboard(user, { ...reference(user), consents_expiring: [], consents_expiring_clients: 0 }));
    for (const k of ['active', 'waitlist', 'new_in_range', 'high_risk', 'by_status', 'by_substance', 'mat']) assert.deepEqual(r.data.clients[k], ref.clients[k], `clients.${k}`);
    for (const k of ['total', 'minutes', 'naloxone_kits', 'fentanyl_strips', 'by_type', 'by_week', 'by_worker']) assert.deepEqual(r.data.interventions[k], ref.interventions[k], `interventions.${k}`);
    assert.deepEqual(r.data.calls, ref.calls, 'calls');
    // The data is meant to exercise ties and NULLs; make sure it did.
    assert.ok(ref.interventions.by_type.length >= 2 && ref.interventions.by_week.length > 10, 'several types and weeks');
    assert.ok(ref.calls.by_outcome.some((x, i, a) => i && a[i - 1].n === x.n), 'equal counts to order');
  });
}

test('dashGroups orders keys and equal counts exactly as SQLite does', () => {
  const G = require('../server/routes/reports').dashGroups;
  // Key order: NULL first, numbers before text, text by character.
  const keys = [null, 'b', 'B', 2, 'a', 10, 'unknown', 'Z'];
  const d = new (require('node:sqlite').DatabaseSync)(':memory:');
  d.exec('CREATE TABLE t(k, v)');
  const ins = d.prepare('INSERT INTO t VALUES(?,?)');
  // Counts with many ties, in an order unrelated to the keys.
  keys.forEach((k, i) => { for (let j = 0; j < 1 + (i * 5) % 3; j++) ins.run(k, j); });
  const sqlKeyOrder = d.prepare('SELECT k, COUNT(*) n FROM t GROUP BY k').all().map(x => ({ k: x.k, n: x.n }));
  const sqlByCount = d.prepare('SELECT k, COUNT(*) n FROM t GROUP BY k ORDER BY n DESC').all().map(x => ({ k: x.k, n: x.n }));
  const groups = d.prepare('SELECT k, v, COUNT(*) n FROM t GROUP BY k, v').all().map(x => ({ ...x }));
  assert.deepEqual(G.rollup(groups, g => g.k), sqlKeyOrder);
  assert.deepEqual(G.byCount(G.rollup(groups, g => g.k)), sqlByCount);
  d.close();
});

test('the dashboard reads its visits from the covering index and unsigned notes from the drafts index', () => {
  const plan = (sql, ...p) => db.all(`EXPLAIN QUERY PLAN ${sql}`, ...p).map(x => x.detail).join(' | ');
  const visits = plan(`SELECT i.type, i.user_id, strftime('%Y-%W', i.occurred_at) AS wk, COUNT(*) n, SUM(i.duration_minutes) FROM interventions i WHERE i.occurred_at BETWEEN ? AND ? AND (CASE WHEN i.client_id IS NULL THEN (i.user_id=? OR ?) ELSE 1=1 END) GROUP BY 1,2,3`, 'a', 'b', 'x', 1);
  assert.match(visits, /COVERING INDEX idx_interventions_dashboard/, visits);
  const drafts = plan(`SELECT COUNT(*) n FROM notes WHERE status='draft' AND deleted_at IS NULL AND author_id=?`, 'x');
  assert.match(drafts, /idx_notes_drafts/, drafts);
});
