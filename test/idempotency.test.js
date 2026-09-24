'use strict';
// Load review, item 3: a retried save created everything twice. Two identical referral POSTs made two
// referrals, two disclosure-accounting rows and two follow-up to-dos; a resent visit doubled the naloxone
// kits and the time entry. A POST carrying an Idempotency-Key is now executed once per (user, key): a
// repeat within 24 hours gets the stored answer back without running again.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;

let nav, nav2, navId, clientId, resourceId, consentId;
const count = (sql, ...p) => db.one(sql, ...p).n;
before(async () => {
  await H.start();
  navId = H.makeUser('idem_nav', 'navigator').id; H.makeUser('idem_nav2', 'navigator');
  nav = H.client(); await nav.login('idem_nav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('idem_nav2', 'StaffPassw0rd!x');
  clientId = (await nav.post('/api/clients', { first_name: 'Idem', last_name: 'Potent' })).data.id;
  resourceId = (await nav.post('/api/resources', { name: 'Retry Clinic', category: 'mat_otp' })).data.id;
  consentId = (await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'Retry Clinic', purpose: 'MAT referral', signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2027-09-01', signed_on_paper: true, redisclosure_notice_given: true })).data.id;
});
after(async () => { await H.stop(); });

test('a referral sent twice with the same key is made once: one disclosure record, one follow-up', async () => {
  const body = { client_id: clientId, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, consent_id: consentId };
  const key = { 'Idempotency-Key': 'ref-submit-1' };
  const a = await nav.post('/api/referrals', body, key);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await nav.post('/api/referrals', body, key);
  assert.equal(b.status, 201, 'the retry gets the original answer');
  assert.deepEqual(b.data, a.data, 'with the same body (the same referral id)');
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(count(`SELECT COUNT(*) n FROM referrals WHERE client_id=?`, clientId), 1, 'one referral');
  assert.equal(count(`SELECT COUNT(*) n FROM disclosures WHERE client_id=? AND source='referral'`, clientId), 1, 'one accounting-of-disclosures row');
  assert.equal(count(`SELECT COUNT(*) n FROM tasks WHERE referral_id=?`, a.data.id), 1, 'one follow-up to-do');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='idempotency.replay' AND user_id=?`, navId), 'the replay is audited');
});

test('a visit resent with the same key does not double the naloxone kits or the time entry', async () => {
  db.run(`INSERT OR IGNORE INTO supply_stock(id,item,quantity) VALUES('s-nal','Naloxone kit',50)`);
  const before = db.one(`SELECT quantity FROM supply_stock WHERE item='Naloxone kit'`)?.quantity;
  const body = { client_id: clientId, type: 'naloxone_distribution', occurred_at: '2026-09-04T10:00:00Z', duration_minutes: 30, naloxone_kits: 2, log_time: true };
  const key = { 'Idempotency-Key': 'visit-submit-1' };
  const a = await nav.post('/api/interventions', body, key);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await nav.post('/api/interventions', body, key);
  assert.equal(b.data.id, a.data.id);
  assert.equal(count(`SELECT COUNT(*) n FROM interventions WHERE client_id=? AND type='naloxone_distribution'`, clientId), 1);
  assert.equal(db.one(`SELECT SUM(naloxone_kits) n FROM interventions WHERE client_id=?`, clientId).n, 2, 'kits counted once');
  assert.equal(count(`SELECT COUNT(*) n FROM time_entries WHERE intervention_id=?`, a.data.id), 1, 'one time entry');
  assert.equal(db.one(`SELECT quantity FROM supply_stock WHERE item='Naloxone kit'`).quantity, before - 2, 'the shelf drawn down once');
});

test('two identical requests in flight at the same moment still run once', async () => {
  const body = { client_id: clientId, title: 'Race to create' };
  const key = { 'Idempotency-Key': 'task-race-1' };
  const [a, b] = await Promise.all([nav.post('/api/tasks', body, key), nav.post('/api/tasks', body, key)]);
  assert.equal(a.data.id, b.data.id);
  assert.equal(count(`SELECT COUNT(*) n FROM tasks WHERE client_id=? AND created_by=? AND due_at IS NULL AND referral_id IS NULL AND status='open' AND assigned_to IS NOT NULL AND id=?`, clientId, navId, a.data.id), 1);
  assert.equal(db.all(`SELECT title_enc FROM tasks WHERE client_id=?`, clientId).filter(t => require('../server/crypto').decrypt(t.title_enc) === 'Race to create').length, 1);
});

test('the same key with a different request is refused; failures are not remembered', async () => {
  const key = { 'Idempotency-Key': 'reused-key' };
  const a = await nav.post('/api/tasks', { client_id: clientId, title: 'First use' }, key);
  assert.equal(a.status, 201);
  const b = await nav.post('/api/tasks', { client_id: clientId, title: 'Something else' }, key);
  assert.equal(b.status, 422, 'a key cannot be reused for a different request');
  // A refused request (validation) is not stored: fixing it and sending again with the same key runs it.
  const k2 = { 'Idempotency-Key': 'fix-and-retry' };
  assert.equal((await nav.post('/api/tasks', { client_id: clientId }, k2)).status, 400);
  assert.equal((await nav.post('/api/tasks', { client_id: clientId, title: 'Fixed' }, k2)).status, 201);
});

test('keys are per user, requests without a key behave as before, and stored answers are encrypted', async () => {
  const body = { client_id: clientId, title: 'Shared key text' };
  await nav.post(`/api/clients/${clientId}/assignments`, { user_id: H.db.one(`SELECT id FROM users WHERE username='idem_nav2'`).id }).catch(() => {});
  const a = await nav.post('/api/tasks', { ...body }, { 'Idempotency-Key': 'same-text' });
  const b = await nav2.post('/api/tasks', { title: 'Another worker, own to-do' }, { 'Idempotency-Key': 'same-text' });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.notEqual(a.data.id, b.data.id, 'one user’s key never answers for another');
  const n0 = count(`SELECT COUNT(*) n FROM tasks`);
  await nav.post('/api/tasks', { title: 'No key' }); await nav.post('/api/tasks', { title: 'No key' });
  assert.equal(count(`SELECT COUNT(*) n FROM tasks`), n0 + 2, 'without a key every POST runs (API and sync compatibility)');
  const rows = db.all(`SELECT * FROM idempotency_keys`);
  assert.ok(rows.length >= 5);
  for (const r of rows) {
    assert.ok(!r.response_enc || /^v1:/.test(r.response_enc), 'the stored response is encrypted');
    assert.ok(!Object.values(r).some(v => typeof v === 'string' && v.includes('same-text')), 'the raw key is not stored either');
  }
});

test('stored answers expire after 24 hours and the housekeeping purge removes them', async () => {
  const key = { 'Idempotency-Key': 'old-key' };
  const a = await nav.post('/api/tasks', { title: 'Yesterday' }, key);
  db.run(`UPDATE idempotency_keys SET created_at=?`, new Date(Date.now() - 25 * 3600000).toISOString());
  const b = await nav.post('/api/tasks', { title: 'Yesterday' }, key);
  assert.notEqual(b.data.id, a.data.id, 'an expired key no longer answers');
  db.run(`UPDATE idempotency_keys SET created_at=?`, new Date(Date.now() - 25 * 3600000).toISOString());
  const removed = require('../server/idempotency').purge();
  assert.ok(removed >= 1);
  assert.equal(count(`SELECT COUNT(*) n FROM idempotency_keys`), 0);
});

test('retry answers stay in the database that gave them: never synchronised', async () => {
  const SYNC = require('../server/sync-tables');
  assert.ok(!SYNC.tables.some(t => t.name === 'idempotency_keys'), 'not a synchronised table');
  assert.ok(SYNC.per_database.includes('idempotency_keys'), 'and declared as kept per database');
  await nav.post('/api/tasks', { title: 'Before a pull' }, { 'Idempotency-Key': 'pull-check' });
  const pull = await nav.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z');
  assert.equal(pull.status, 200, JSON.stringify(pull.data).slice(0, 200));
  assert.ok(!('idempotency_keys' in pull.data.tables), 'a device pull never carries them');
});
