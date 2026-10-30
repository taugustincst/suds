'use strict';
// SEC-2026-002 (internal evaluation of 1.28.0, finding 1, HIGH): the audit chain could be rewritten without
// the index key. matches() still accepts a plain (unkeyed) SHA-256 for a row, so someone holding the database
// file but not the key could downgrade a keyed row — rewrite its content, recompute an unkeyed hash and the
// chain after it — and the in-database walk accepted it; deleting the audit_head* settings then made checkHead
// answer the benign "not checkpointed" rather than reporting tampering, and the next start re-sealed the
// shortened chain. The fix pins a keyed boundary (the id of the last legacy row, 0 on a keyed-native install):
// a row above it must be keyed, and a missing head over a surviving boundary is tampering, never re-sealed.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, stop, db, asAttacker } = require('./helpers');
const config = require('../server/config');
const audit = require('../server/audit');
const { sha256 } = require('../server/crypto');
const { payloadOf } = require('../server/audit-export');

before(async () => { await start(); });
after(async () => { await stop(); });

// Reset to a clean, sealed, keyed-native chain with a pinned boundary — as a started office server has.
function freshSealedChain() {
  asAttacker(() => db.run(`DELETE FROM audit_log`));
  db.run(`DELETE FROM settings WHERE key LIKE 'audit_head%' OR key LIKE 'audit_keyed_boundary%' OR key LIKE 'audit_verified%'`);
  audit.sealHeadAtStart();            // seals the head AND pins the keyed boundary (= 0, no legacy rows)
  for (let i = 0; i < 4; i++) audit.log({ user: { username: 'system' }, action: 'phi.read', clientId: `C-${i}`, details: { who: 'nav' } });
  audit.checkpoint();
}

// Downgrade from `fromId` on, the way someone with the database file but NOT the index key would: unkeyed
// SHA-256 hashes (no 'v2:' prefix), chained so the linkage still holds, with one row's content changed.
function downgradeFrom(fromId, change) {
  const rows = db.all(`SELECT * FROM audit_log WHERE id >= ? ORDER BY id`, fromId);
  let prev = db.one(`SELECT hash FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 1`, fromId)?.hash || rows[0].prev_hash;
  for (const r of rows) {
    const row = { ...r, prev_hash: prev, ...(r.id === fromId ? change : {}) };
    const hash = sha256(payloadOf(row));          // plain SHA-256 — no key needed, no 'v2:' prefix
    asAttacker(() => db.run(`UPDATE audit_log SET details=?, prev_hash=?, hash=? WHERE id=?`, row.details, prev, hash, r.id));
    prev = hash;
  }
}

test('a keyed-native chain with a pinned boundary verifies, and the boundary is 0', () => {
  freshSealedChain();
  assert.equal(audit.verifyChain().ok, true);
  assert.equal(audit.keyedBoundary(), 0, 'no legacy rows, so every row must be keyed');
});

test('downgrading a keyed row to unkeyed and deleting the head is now caught in the database', () => {
  freshSealedChain();
  const target = db.one(`SELECT id FROM audit_log WHERE action='phi.read' ORDER BY id LIMIT 1`).id;
  // The PoC: alter who viewed a client, recompute the chain unkeyed, then delete the sealed head.
  downgradeFrom(target, { details: JSON.stringify({ who: 'someone-else' }) });
  asAttacker(() => db.run(`DELETE FROM settings WHERE key LIKE 'audit_head%'`));
  const v = audit.verifyChain();
  assert.equal(v.ok, false, 'the downgraded row above the boundary is rejected');
  assert.equal(v.firstBadId, target, `first bad entry is the downgraded row (${JSON.stringify(v)})`);
  // The boundary seal itself was not touched and still verifies under the key.
  assert.equal(audit.keyedBoundary(), 0);
});

test('deleting only the sealed head, with the chain intact, is tampering — not a benign "not checkpointed"', () => {
  freshSealedChain();
  asAttacker(() => db.run(`DELETE FROM settings WHERE key LIKE 'audit_head%'`));
  const h = audit.checkHead();
  assert.equal(h.truncated, true, `a missing head over a surviving boundary is reported: ${JSON.stringify(h)}`);
  assert.equal(audit.verifyChain().ok, false, 'and the verdict says the chain is broken');
});

test('the vanished head is never auto-re-sealed over (advanceHead stands down)', () => {
  freshSealedChain();
  asAttacker(() => db.run(`DELETE FROM settings WHERE key LIKE 'audit_head%'`));
  assert.equal(audit.advanceHead({ quiet: true }), null, 'no new head is sealed over the gap');
  assert.equal(db.getSetting('audit_head', null), null, 'the head stays absent for an operator to notice');
  assert.equal(audit.checkHead().truncated, true);
});

test('a genuine legacy row at or below the boundary is still accepted (no false positive on an upgraded install)', () => {
  // Simulate a pre-1.24 install: unkeyed rows, then the boundary pinned over them, then keyed rows after.
  asAttacker(() => db.run(`DELETE FROM audit_log`));
  db.run(`DELETE FROM settings WHERE key LIKE 'audit_head%' OR key LIKE 'audit_keyed_boundary%' OR key LIKE 'audit_verified%'`);
  // Two legacy (unkeyed) rows written directly, chained the old way.
  let prev = 'GENESIS';
  for (const action of ['legacy.one', 'legacy.two']) {
    const at = db.now();
    const payload = [at, '', 'system', action, '', '', '', '', 1, '', prev].join('|');
    const hash = sha256(payload);
    db.run(`INSERT INTO audit_log(at,username,action,success,details,prev_hash,hash) VALUES(?,?,?,?,?,?,?)`, at, 'system', action, 1, null, prev, hash);
    prev = hash;
  }
  audit.sealHeadAtStart();   // pins the boundary at the last legacy id
  const boundary = audit.keyedBoundary();
  assert.ok(boundary >= 2, `the boundary sits at the last legacy row (${boundary})`);
  // New keyed rows after the boundary, as log() always writes.
  for (let i = 0; i < 3; i++) audit.log({ user: { username: 'system' }, action: 'phi.read', clientId: `C-${i}` });
  audit.checkpoint();
  assert.equal(audit.verifyChain().ok, true, 'legacy rows below the boundary and keyed rows above it both verify');
});
