'use strict';
// The audit log is append-only in the database itself, not just by convention: SQLite triggers refuse an
// UPDATE or DELETE of audit_log unless the sanctioned maintenance flag (server/audit.js maintenance()) is
// raised inside the same transaction — the retention purge and index-key re-signing. The chain still
// catches anyone who drops the triggers first; this stops everything short of that (a stray UPDATE in a
// route, SQL typed into the sqlite3 shell, a restore script) from rewriting history.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { start, stop, db } = require('./helpers');
const audit = require('../server/audit');

before(async () => { await start(); for (let i = 0; i < 5; i++) audit.log({ user: { username: 'system' }, action: 'test.immutable', details: { i } }); });
after(stop);

test('an UPDATE of an audit entry is refused by the database', () => {
  const r = db.one(`SELECT id FROM audit_log ORDER BY id DESC LIMIT 1`);
  assert.throws(() => db.run(`UPDATE audit_log SET details='tampered' WHERE id=?`, r.id), /append-only/);
  assert.notEqual(db.one(`SELECT details FROM audit_log WHERE id=?`, r.id).details, 'tampered');
});

test('a DELETE of audit entries is refused by the database', () => {
  const n = db.one(`SELECT COUNT(*) n FROM audit_log`).n;
  assert.throws(() => db.run(`DELETE FROM audit_log`), /append-only/);
  assert.equal(db.one(`SELECT COUNT(*) n FROM audit_log`).n, n);
});

test('the maintenance flag is never left raised', () => {
  assert.equal(db.one(`SELECT COUNT(*) n FROM audit_maintenance`).n, 0);
  assert.throws(() => audit.maintenance('', () => {}), /purpose/);
  // A throw inside maintenance rolls the flag back with everything else.
  assert.throws(() => audit.maintenance('test', () => { throw new Error('boom'); }), /boom/);
  assert.equal(db.one(`SELECT COUNT(*) n FROM audit_maintenance`).n, 0);
});

test('the retention purge still removes old entries, inside the sanctioned maintenance window', () => {
  const oldest = db.one(`SELECT id FROM audit_log ORDER BY id LIMIT 1`).id;
  // Backdate two entries the way time would (the test goes through the flag like any maintainer).
  audit.maintenance('test backdating', () => db.run(`UPDATE audit_log SET at='2001-01-01T00:00:00.000Z' WHERE id <= ?`, oldest + 1));
  const n = audit.purge(365);
  assert.ok(n >= 2, 'the purge deleted the backdated entries');
  assert.equal(db.one(`SELECT COUNT(*) n FROM audit_maintenance`).n, 0, 'the flag is lowered afterwards');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='audit.purge'`), 'the purge is itself audited');
  assert.throws(() => db.run(`DELETE FROM audit_log`), /append-only/, 'and the guard is back');
});

test('re-signing the chain for an index-key rotation still works', () => {
  const config = require('../server/config');
  const oldKey = config.indexKey;
  const newKey = crypto.randomBytes(32);
  db.transaction(() => audit.resignChain(newKey));
  config.indexKey = newKey;
  try { assert.ok(audit.verifyChain().ok); }
  finally { db.transaction(() => audit.resignChain(oldKey)); config.indexKey = oldKey; }
  assert.ok(audit.verifyChain().ok);
});
