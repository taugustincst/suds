'use strict';
// A regression guard against the class of problem the "Fix scale" work fixed reactively (missing indexes,
// unchunked sync, blocking scrypt): seed a dataset large enough that a dropped index or an accidental
// N+1 actually shows up, then assert the pages navigators hit constantly stay fast. This is not a load
// test (no concurrency, no throughput target) — it is a tripwire that fails loudly the next time someone
// removes an index or turns an indexed lookup into a table scan, instead of that only being noticed once
// a county's real caseload is big enough to feel it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = require('./helpers').db;
const { encryptFields, uuid } = require('../server/clients-model');

const CLIENTS = 1500;
const INTERVENTIONS_PER_CLIENT = 8;
// Generous enough that a normal, healthy run on slow CI hardware never flakes, tight enough that an O(n)
// scan replacing an indexed lookup (the usual way this regresses) blows through it immediately.
const BUDGET_MS = 800;

let nav, workerId;
before(async () => {
  await H.start();
  const u = H.makeUser('perfnav', 'navigator');
  workerId = u.id;
  nav = H.client(); await nav.login('perfnav', 'StaffPassw0rd!x');

  const start = Date.now();
  db.transaction(() => {
    for (let i = 0; i < CLIENTS; i++) {
      const id = uuid();
      const last = `Surname${i % 400}`, first = `First${i}`;
      const enc = encryptFields({ first_name: first, last_name: last, dob: '1990-01-01', phone: `555010${String(i).padStart(4, '0')}` });
      enc.full_name_idx = require('../server/crypto').blindIndex(last + first);
      const cols = {
        id, client_code: `C99-${String(i).padStart(5, '0')}`, status: i % 5 === 0 ? 'waitlist' : 'active',
        risk_level: ['low', 'moderate', 'high', 'critical'][i % 4], intake_date: '2026-01-01', created_by: workerId,
        ...enc,
      };
      const keys = Object.keys(cols).filter(k => cols[k] !== undefined);
      db.run(`INSERT INTO clients(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
      db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`,
        uuid(), id, workerId, 'primary', '2026-01-01', workerId);
      for (let j = 0; j < INTERVENTIONS_PER_CLIENT; j++) {
        db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality) VALUES(?,?,?,?,?,?,?,?)`,
          uuid(), id, workerId, 'check_in', `2026-0${1 + (j % 9) % 9}-15T10:00:00.000Z`, 30, 'office', 'in_person');
      }
    }
  });
  const seedMs = Date.now() - start;
  // A slow seed is itself a signal (this loop does what the real client-creation path does), but it is
  // not what this file is testing, so only note it rather than fail on it.
  if (seedMs > 15000) console.warn(`[perf] seeding ${CLIENTS} clients took ${seedMs}ms — slower than expected`);
});
after(async () => { await H.stop(); });

async function timed(label, fn) {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  assert.ok(ms < BUDGET_MS, `${label} took ${ms}ms, over the ${BUDGET_MS}ms budget`);
  return result;
}

test(`caseload list (${CLIENTS} clients) stays fast`, async () => {
  await timed('GET /api/clients (paged)', async () => {
    const r = await nav.get('/api/clients?limit=200');
    assert.equal(r.status, 200);
    assert.equal(r.data.clients.length, 200);
  });
});

test('name search resolves through the blind index, not a scan', async () => {
  await timed('GET /api/clients?q=Surname7', async () => {
    const r = await nav.get('/api/clients?q=' + encodeURIComponent('Surname7'));
    assert.equal(r.status, 200);
    assert.ok(r.data.clients.length > 0);
  });
});

test('the dashboard aggregation query stays fast with a real-sized caseload', async () => {
  await timed('GET /api/reports/dashboard', async () => {
    const r = await nav.get('/api/reports/dashboard');
    assert.equal(r.status, 200);
  });
});

test(`the visits list (${CLIENTS * INTERVENTIONS_PER_CLIENT} rows) stays fast`, async () => {
  await timed('GET /api/interventions (paged)', async () => {
    const r = await nav.get('/api/interventions?limit=300');
    assert.equal(r.status, 200);
    assert.equal(r.data.rows.length, 300);
  });
});

test('a single client record (with counts) resolves fast regardless of table size', async () => {
  const { data } = await nav.get('/api/clients?limit=1');
  const id = data.clients[0].id;
  await timed('GET /api/clients/:id', async () => {
    const r = await nav.get(`/api/clients/${id}`);
    assert.equal(r.status, 200);
  });
});
