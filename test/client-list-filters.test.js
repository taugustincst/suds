'use strict';
// Load review, item 1: the client list filtered its first 200 rows in the browser, so at 2,000 clients the
// Home page said "915 high-risk" and the tile opened a list of 101. The filters now run on the server,
// inside the caseload-scoped query, and the list's total is the same number the dashboard tile shows.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;
const { encryptFields, uuid } = require('../server/clients-model');
const { blindIndex, encrypt } = require('../server/crypto');

const CLIENTS = 2000;
const BUDGET_MS = 800;
const SUBSTANCES = ['opioids', 'stimulants', 'alcohol', null];
const MAT = ['none', 'active', 'interested', null];

let sup, nav, navId, supId;
before(async () => {
  await H.start();
  supId = H.makeUser('flt_sup', 'supervisor').id;
  navId = H.makeUser('flt_nav', 'navigator').id;
  const recent = new Date(Date.now() - 3 * 86400000).toISOString();
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  db.transaction(() => {
    for (let i = 0; i < CLIENTS; i++) {
      const id = uuid();
      const enc = encryptFields({ first_name: `F${i}`, last_name: `Load${i % 300}`, dob: '1985-03-03' });
      enc.full_name_idx = blindIndex(`Load${i % 300}F${i}`);
      const cols = { id, client_code: `C77-${String(i).padStart(5, '0')}`, status: i % 10 < 3 ? 'waitlist' : 'active',
        risk_level: ['low', 'moderate', 'high', 'critical'][i % 4], primary_substance: SUBSTANCES[i % 4], mat_status: MAT[(i >> 2) % 4],
        intake_date: '2026-01-01', created_by: supId, ...enc };
      const keys = Object.keys(cols).filter(k => cols[k] !== undefined);
      db.run(`INSERT INTO clients(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
      // A third of the caseload belongs to the navigator; the rest to nobody they can see.
      if (i % 3 === 0) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), id, navId, 'primary', '2026-01-01', supId);
      // Contacted recently (visit), reached by phone recently, or only long ago.
      for (let j = 0; j < 16; j++) db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes) VALUES(?,?,?,?,?,?)`, uuid(), id, supId, 'check_in', i % 5 === 0 ? recent : old, 30);
      if (i % 7 === 0) db.run(`INSERT INTO calls(id,client_id,user_id,direction,contact_type,started_at,outcome) VALUES(?,?,?,?,?,?,?)`, uuid(), id, supId, 'outbound', 'client', recent, 'reached');
      if (i % 11 === 0) db.run(`INSERT INTO consents(id,client_id,type,signed_at,expires_at,created_by,recipient_enc) VALUES(?,?,?,?,?,?,?)`, uuid(), id, 'roi', '2025-01-01', soon, supId, encrypt('Clinic'));
    }
  });
  // Signed in after the fixture, not before: loading 2,000 clients can take longer than the server's
  // keep-alive timeout when the whole suite runs in parallel, and the first request then went out on a
  // connection the server had already closed ("fetch failed").
  sup = H.client(); await sup.login('flt_sup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('flt_nav', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

async function timed(label, fn) {
  const t = Date.now(); const r = await fn(); const ms = Date.now() - t; if (process.env.SHOW_MS) console.log('#', label, ms, 'ms');
  assert.ok(ms < BUDGET_MS, `${label} took ${ms}ms at ${CLIENTS} clients (budget ${BUDGET_MS}ms)`);
  return r;
}
async function allPages(c, qs, pageSize = 400) {
  const ids = []; let total = null;
  for (let offset = 0; ; offset += pageSize) {
    const r = await c.get(`/api/clients?${qs}&limit=${pageSize}&offset=${offset}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    total = r.data.total;
    ids.push(...r.data.clients.map(x => x.id));
    if (!r.data.clients.length || ids.length >= total) break;
  }
  return { ids, total };
}

test('the high-risk tile and the list it opens report the same number', async () => {
  const dash = (await sup.get('/api/reports/dashboard')).data;
  const r = await timed('high-risk list', () => sup.get('/api/clients?status=active&risk=high&limit=200'));
  assert.equal(r.data.total, dash.clients.high_risk, 'the list total is the tile count, not a count of the first page');
  assert.ok(r.data.total > 200, 'more than one page of high-risk clients in this fixture');
  assert.ok(r.data.clients.every(c => ['high', 'critical'].includes(c.risk_level)));
  const all = await allPages(sup, 'status=active&risk=high');
  assert.equal(all.ids.length, dash.clients.high_risk, 'paging through every page reaches every client');
  assert.equal(new Set(all.ids).size, all.ids.length, 'and no client appears on two pages');
});

test('"not contacted in 30 days" uses the dashboard definition and pages', async () => {
  const dash = (await sup.get('/api/reports/dashboard')).data;
  const r = await timed('stale list', () => sup.get('/api/clients?status=active&stale=1&limit=200'));
  assert.equal(r.data.total, dash.clients.no_contact_30d);
  const cutoff = Date.now() - 30 * 86400000;
  assert.ok(r.data.clients.every(c => !c.last_contact || Date.parse(c.last_contact) < cutoff));
});

test('substance and MAT filters match the dashboard breakdowns, including "unknown"', async () => {
  const dash = (await sup.get('/api/reports/dashboard')).data;
  for (const { k, n } of dash.clients.by_substance) {
    const r = await sup.get(`/api/clients?status=active&substance=${k}&limit=1`);
    assert.equal(r.data.total, n, `substance=${k}`);
  }
  for (const { k, n } of dash.clients.mat) {
    const r = await sup.get(`/api/clients?status=active&mat=${k}&limit=1`);
    assert.equal(r.data.total, n, `mat=${k}`);
  }
});

test('consent-expiring lists every client with a consent running out, with the date', async () => {
  const expected = db.one(`SELECT COUNT(DISTINCT c.id) n FROM clients c JOIN consents co ON co.client_id=c.id WHERE c.status='active' AND c.deleted_at IS NULL AND co.revoked_at IS NULL AND co.expires_at BETWEEN date('now') AND date('now','+30 days')`).n;
  const r = await timed('consent-expiring list', () => sup.get('/api/clients?status=active&consent_expiring=1&limit=500'));
  assert.equal(r.data.total, expected);
  assert.ok(expected > 20, 'more than the dashboard card shows');
  const d = await sup.get('/api/reports/dashboard');
  assert.equal(d.data.consents_expiring_clients, r.data.total, 'the Home alert counts the clients the list shows');
  assert.ok(r.data.clients.every(c => c.consent_expires_at), 'each row carries the expiry the column shows');
});

test('filters stay inside the caseload for a caseload-restricted worker', async () => {
  const dash = (await nav.get('/api/reports/dashboard')).data;
  const mine = new Set(db.all(`SELECT client_id FROM assignments WHERE user_id=?`, navId).map(x => x.client_id));
  const hr = await allPages(nav, 'status=active&risk=high');
  assert.equal(hr.total, dash.clients.high_risk);
  assert.ok(hr.ids.every(id => mine.has(id)), 'no client outside the caseload');
  const stale = await timed('caseload stale list', () => nav.get('/api/clients?status=active&stale=1&limit=200'));
  assert.equal(stale.data.total, dash.clients.no_contact_30d);
  assert.ok(stale.data.clients.every(c => mine.has(c.id)));
});

test('filters combine with each other and with sorting', async () => {
  const r = await timed('combined', () => sup.get('/api/clients?status=active&risk=high&stale=1&substance=opioids&sort=last_contact&limit=100'));
  assert.equal(r.status, 200);
  assert.ok(r.data.clients.every(c => ['high', 'critical'].includes(c.risk_level) && c.primary_substance === 'opioids'));
});

test('the waitlist pages past 500 and reports its true size', async () => {
  const waiting = db.one(`SELECT COUNT(*) n FROM clients WHERE status='waitlist' AND deleted_at IS NULL`).n;
  assert.ok(waiting > 500, 'fixture has more than the old 500 cap');
  const first = await timed('waitlist page', () => sup.get('/api/waitlist?limit=100'));
  assert.equal(first.status, 200);
  assert.equal(first.data.rows.length, 100);
  assert.equal(first.data.total, waiting, 'total is the whole waitlist, not the page');
  const seen = new Set();
  for (let offset = 0; offset < waiting; offset += 250) {
    const p = await sup.get(`/api/waitlist?limit=250&offset=${offset}`);
    for (const x of p.data.rows) seen.add(x.id);
  }
  assert.equal(seen.size, waiting, 'every waiting client is reachable');
  const navList = await nav.get('/api/waitlist?limit=500');
  const mine = new Set(db.all(`SELECT client_id FROM assignments WHERE user_id=?`, navId).map(x => x.client_id));
  assert.ok(navList.data.rows.every(x => mine.has(x.id)), 'the waitlist is caseload-scoped');
});
