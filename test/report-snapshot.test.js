'use strict';
// Reports that read a lot let the event loop go between their phases, and still read one state of the data
// (server/db.js readSnapshot: a read transaction on a second, read-only connection to the same file). A
// publication release is kept by the data's version, so asking again reads nothing; the monthly report reads
// a month at a time. These need a database file (an in-memory one has no second connection), so this file
// opens its own instead of test/helpers.js's.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-snapshot-'));
Object.assign(process.env, { SUDS_ENV: 'test', SUDS_DATA_DIR: DIR, SUDS_DB_PATH: path.join(DIR, 'suds.db'), SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x', SUDS_ADMIN_USERNAME: 'admin', MFA_REQUIRED_ROLES: '' });
delete process.env.SUDS_AUDIT_INLINE;
const http = require('node:http');
const db = require('../server/db');
const { createHandler } = require('../server/app');
const { ensureBootstrap } = require('../server/bootstrap');
const scale = require('./fixtures/funder-scale');

let server; let base; let cookie = '';
async function req(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: (res.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : text };
}
let fx;
before(async () => {
  db.open(process.env.SUDS_DB_PATH);
  ensureBootstrap();
  db.run(`UPDATE users SET must_change_password=0`);
  db.setSetting('programme_profile', 'treatment');
  fx = scale.seed(db, { clients: 400, visits: 3000, calls: 400, notes: 0, seedValue: 11 });
  server = http.createServer(createHandler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await req('POST', '/api/auth/login', { username: 'admin', password: 'AdminPassw0rd!x' })).status, 200);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

const count = () => db.one(`SELECT COUNT(*) n FROM interventions`).n;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a read snapshot lets the event loop go and still reads one state: a write made meanwhile is not seen until it ends', async () => {
  const before = count();
  // Scheduled outside the snapshot, so it runs on the main connection while the read is waiting.
  let wrote = false;
  const writer = new Promise((resolve) => setImmediate(() => {
    db.run(`INSERT INTO interventions(id,user_id,type,occurred_at) VALUES(?,?,?,?)`, require('../server/crypto').uuid(), fx.userId, 'outreach', '2025-08-01T12:00:00.000Z');
    wrote = true; resolve();
  }));
  const seen = await db.readSnapshot(async (canYield) => {
    assert.equal(canYield, true, 'a database file has a second connection to read from');
    assert.ok(db.inSnapshot());
    const first = count();
    for (let k = 0; k < 3 && !wrote; k++) await tick();
    assert.ok(wrote, 'the writer ran while the read was waiting');
    return [first, count()];
  });
  await writer;
  assert.deepEqual(seen, [before, before], 'the snapshot saw neither the write nor anything after it');
  assert.equal(count(), before + 1, 'the write itself went through, on the main connection');
  assert.ok(!db.inSnapshot());
  // Inside a transaction on the main connection there is no snapshot to take (its uncommitted rows would not be
  // in it): the read runs straight through on the main connection instead.
  db.transaction(() => { db.readSnapshot((canYield) => { assert.equal(canYield, false); assert.ok(!db.inSnapshot()); }); });
});

test('a publication release is kept by the data\'s version: asked again it reads nothing; a change is read afresh', async () => {
  const FR = require('../server/funder-report');
  const PR = require('../server/publication-release');
  PR.clearCache();
  const figures = FR.figures; let reads = 0;
  FR.figures = function* counted(...a) { reads++; return yield* figures(...a); };
  try {
    const FY = 'from=2025-07-01&to=2026-06-30&purpose=publication';
    const a = await req('GET', `/api/reports/funder?${FY}`);
    assert.equal(a.status, 200, JSON.stringify(a.data).slice(0, 300));
    assert.equal(reads, 1);
    // The NDP log and the settlement report of the same release, and the funder report again: nothing is read.
    const [n, s, f] = await Promise.all(['naloxone-ndp', 'opioid-settlement', 'funder'].map((x) => req('GET', `/api/reports/${x}?${FY}`)));
    for (const x of [n, s, f]) { assert.equal(x.status, 200); assert.equal(x.data.release.id, a.data.release.id); }
    assert.equal(reads, 1, 'served from the release kept under the data\'s version');
    assert.deepEqual(f.data, a.data, 'the identical release');
    // Signing in, and the audit log written by every request, are not the data a release reads.
    assert.equal((await req('GET', '/api/auth/me')).status, 200);
    await req('GET', `/api/reports/funder?${FY}`);
    assert.equal(reads, 1);
    // A visit recorded in the period changes the version: the next release reads again, and counts it.
    const client = (await req('POST', '/api/clients', { first_name: 'Snapshot', last_name: 'Client', confirm_duplicate: true })).data;
    assert.ok(client && client.id, 'a new client');
    assert.equal((await req('POST', '/api/interventions', { client_id: client.id, type: 'outreach', occurred_at: '2026-02-02T18:00:00.000Z' })).status, 201);
    const b = await req('GET', `/api/reports/funder?${FY}`);
    assert.equal(reads, 2);
    const served = (d) => d.unduplicated.served;
    if (typeof served(a.data) === 'number' && typeof served(b.data) === 'number') assert.equal(served(b.data), served(a.data) + 1);
    // So does an edit that changes no count (its updated_at): a release is never served from older data.
    db.run(`UPDATE clients SET gender='female', updated_at=? WHERE id=?`, new Date(Date.now() + 1000).toISOString(), client.id);
    await req('GET', `/api/reports/funder?${FY}`);
    assert.equal(reads, 3);
  } finally { FR.figures = figures; }
});

test('every table a publication release reads is part of the data\'s version it is kept under', async () => {
  // A table read but not in the version could change without the release being read afresh: a stale release.
  const PR = require('../server/publication-release');
  const { DatabaseSync } = require('node:sqlite');
  PR.clearCache();
  const read = new Set(); const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) { for (const m of String(sql).matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)) read.add(m[1].toLowerCase()); return prepare.call(this, sql); };
  try {
    const r = await req('GET', '/api/reports/naloxone-ndp?from=2025-07-01&to=2025-09-30&purpose=publication');
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  } finally { DatabaseSync.prototype.prepare = prepare; }
  // What else the request reads (its session and user, the audit log it writes) is not the release's data.
  const notData = new Set(['sqlite_master', 'temp', 'tombstones', 'json_each', 'sessions', 'users', 'audit_log', 'served']);
  const missing = [...read].filter(t => !notData.has(t) && !PR.VERSION_TABLES.includes(t));
  assert.ok(read.has('interventions') && read.has('funding_sources'), `the release was read: ${[...read]}`);
  assert.deepEqual(missing, [], `tables read by the request and not in the version: ${missing.join(', ')} (read: ${[...read].join(', ')})`);
});

test('the monthly report reads a month at a time and answers exactly what one pass over the visits did', async () => {
  const r = await req('GET', '/api/reports/monthly?months=24');
  assert.equal(r.status, 200);
  const start = new Date(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 23);
  const s = start.toISOString().slice(0, 10);
  // 1.13.0's three passes over the visits.
  assert.deepEqual(r.data.interventions, db.all(`SELECT substr(occurred_at,1,7) month, COUNT(*) n, SUM(duration_minutes) minutes, COUNT(DISTINCT client_id) clients FROM interventions WHERE occurred_at >= ? GROUP BY month ORDER BY month`, s).map(x => ({ ...x })));
  assert.deepEqual(r.data.naloxone, db.all(`SELECT substr(occurred_at,1,7) month, SUM(naloxone_kits) kits, SUM(fentanyl_strips) strips FROM interventions WHERE occurred_at >= ? GROUP BY month ORDER BY month`, s).map(x => ({ ...x })));
  assert.deepEqual(r.data.unduplicated_clients, db.all(`SELECT substr(occurred_at,1,7) month, COUNT(DISTINCT client_id) clients FROM interventions WHERE occurred_at >= ? AND client_id IS NOT NULL GROUP BY month ORDER BY month`, s).map(x => ({ ...x })));
  assert.ok(r.data.interventions.length >= 10, 'the fixture has visits in most months');
  // It lets the event loop go at least once a month of the window (1.13.0 read twelve months in one piece).
  const g = require('../server/routes/reports').monthlyFigures(db.one(`SELECT * FROM users WHERE username='admin'`), s);
  let pauses = 0; while (!g.next().done) pauses++;
  assert.ok(pauses >= 24, `${pauses} pauses over 24 months`);
  assert.deepEqual(Object.keys(r.data).slice(0, 12), ['intakes', 'discharges', 'interventions', 'calls', 'referrals', 'naloxone', 'overdose_events', 'episodes', 'unduplicated_clients', 'mat_linkage', 'spend', 'time']);
  // A visit dated after this month is still counted, in its own month, as before.
  const ahead = new Date(); ahead.setUTCMonth(ahead.getUTCMonth() + 2); const month = ahead.toISOString().slice(0, 7);
  db.run(`INSERT INTO interventions(id,user_id,type,occurred_at,duration_minutes) VALUES(?,?,?,?,?)`, require('../server/crypto').uuid(), fx.userId, 'outreach', `${month}-03T12:00:00.000Z`, 15);
  const later = await req('GET', '/api/reports/monthly?months=24');
  assert.deepEqual(later.data.interventions.find(x => x.month === month), { month, n: 1, minutes: 15, clients: 0 });
});
