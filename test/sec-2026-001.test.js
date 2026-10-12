'use strict';
// The findings of the internal self-assessment SEC-2026-001 of 1.25.6 (not an independent penetration test):
//  F-01 (Low) the newest audit entries could be removed without a trace until a checkpoint sealed a newer head;
//  F-02 (Informational) markup was stored verbatim in client names;
//  F-03 (Informational) the session cookie's Secure flag depends on the configuration, and nothing reported it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, stop, client, db } = require('./helpers');
const config = require('../server/config');
const audit = require('../server/audit');

let admin;
before(async () => {
  await start();
  admin = client(); await admin.login('admin', 'AdminPassw0rd!x');
});
after(async () => { await stop(); });

test('F-02: a client name with < or > is refused, on create and on edit; other edits still save', async () => {
  for (const body of [{ first_name: '<script>alert(1)</script>', last_name: 'Probe' }, { first_name: 'Probe', last_name: '<img src=x onerror=alert(2)>' },
    { first_name: 'Probe', last_name: 'Person', preferred_name: '<b>' }]) {
    const r = await admin.post('/api/clients', { ...body, confirm_duplicate: true });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(Object.values(r.data.fields || {}).join(' '), /cannot contain < or >/);
  }
  const ok = await admin.post('/api/clients', { first_name: "D'Angelo", last_name: 'Ruiz-Ortega', confirm_duplicate: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const id = ok.data.id;
  assert.equal((await admin.put(`/api/clients/${id}`, { first_name: 'D<Angelo' })).status, 400, 'an edit to the name is checked too');
  assert.equal((await admin.put(`/api/clients/${id}`, { city: 'Marysville' })).status, 200, 'an edit that leaves the name alone saves');
});

test('F-03: Security status reports whether the session cookie is marked Secure, and the compliance check carries it', async () => {
  const line = async () => (await admin.get('/api/admin/security/status')).data.items.find((i) => i.name === 'Session cookie');
  const dev = await line();
  assert.equal(dev.level, 'warn', 'the test server runs without TLS, outside production mode');
  assert.match(dev.value, /not Secure/);
  assert.equal(dev.check_id, 'app.session_cookie');
  const was = config.isProd;
  config.isProd = true;
  try {
    const prod = await line();
    assert.equal(prod.level, 'ok');
    assert.match(prod.value, /Secure/);
    assert.match(require('../server/auth').cookieHeader('x'), /; Secure$/, 'the status says what the cookie really carries');
  } finally { config.isProd = was; }
  assert.equal(require('../server/compliance-rules').forItem('Session cookie').id, 'app.session_cookie');
});

test('F-01: the head advances every CHECKPOINT_EVERY entries, counted exactly; a tail deletion is then detected, and never sealed over', () => {
  audit.sealHeadAtStart();
  if (!db.getSetting('audit_head', null)) audit.checkpoint();
  const before = Number(db.getSetting('audit_head_id'));
  for (let i = 0; i < audit.CHECKPOINT_EVERY; i++) audit.log({ user: { username: 'system' }, action: 'test.sec2026001' });
  const head = Number(db.getSetting('audit_head_id'));
  assert.ok(head > before, `the head moved on (${before} -> ${head})`);
  assert.equal(Number(db.getSetting('audit_head_rows')), db.one(`SELECT COUNT(*) n FROM audit_log WHERE id <= ?`, head).n, 'its row count is exact');
  assert.equal(audit.checkHead().truncated, false);
  const max = db.one(`SELECT MAX(id) m FROM audit_log`).m;
  assert.ok(max - head < audit.CHECKPOINT_EVERY, `the unsealed window is under ${audit.CHECKPOINT_EVERY} entries (${max - head})`);
  // advanceHead, as a graceful shutdown runs it, seals up to the newest entry.
  assert.equal(audit.advanceHead().lastId, max);
  // As in the assessment: the newest three entries removed by someone holding the database file.
  audit.maintenance('test: tail truncation', () => db.run(`DELETE FROM audit_log WHERE id > ?`, max - 3));
  const h = audit.checkHead();
  assert.equal(h.truncated, true, `detected: ${JSON.stringify(h)}`);
  // Advancing (the next batch of entries, or a shutdown) does not seal over it: verification still reports it.
  audit.log({ user: { username: 'system' }, action: 'test.after' });
  assert.equal(audit.advanceHead({ quiet: true }), null);
  assert.equal(audit.checkHead().truncated, true);
  assert.equal(audit.verifyChain().ok, false, 'and the chain verification says so');
});
