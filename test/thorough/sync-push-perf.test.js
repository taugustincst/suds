'use strict';
// A device's first push after a long day offline: 10,000 rows in one request (interventions, calls and to-dos
// across a caseload, as the phone sends them). Every row goes through its table's rules (server/rules/), its
// own savepoint and the audit trail; this keeps that from creeping up. Measured in-process (push() itself),
// so what is timed is the rule pipeline and SQLite, not JSON over a socket. Run by `npm run test:thorough`.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('../helpers');
const { randomUUID } = require('node:crypto');

const ROWS = Number(process.env.SUDS_PUSH_ROWS || 10000);
// Generous: CI machines vary. The number printed is what to compare between versions.
const BUDGET_MS = Number(process.env.SUDS_PUSH_BUDGET_MS || 15000);

let user; const clients = [];
before(async () => {
  await H.start();
  const u = H.makeUser('perfnav', 'navigator');
  user = H.db.one(`SELECT * FROM users WHERE id=?`, u.id);
  const enc = require('../../server/crypto').encrypt;
  for (let i = 0; i < 50; i++) {
    const id = randomUUID(); clients.push(id);
    H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,created_by) VALUES(?,?,?,?,?,?)`, id, `P-${i}`, enc('Perf'), enc(`Client${i}`), 'active', u.id);
    H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date) VALUES(?,?,?,?,?)`, randomUUID(), id, u.id, 'primary', '2026-01-01');
  }
});
after(async () => { await H.stop(); });

test(`a ${ROWS}-row push stays within its budget`, () => {
  const now = new Date().toISOString();
  const third = Math.floor(ROWS / 3);
  const c = (i) => clients[i % clients.length];
  const tables = {
    interventions: Array.from({ length: ROWS - 2 * third }, (_, i) => ({ id: randomUUID(), client_id: c(i), user_id: user.id, type: 'case_management', occurred_at: now, duration_minutes: 15, summary_enc: `Visit ${i}`, created_at: now, updated_at: now })),
    calls: Array.from({ length: third }, (_, i) => ({ id: randomUUID(), client_id: c(i), user_id: user.id, direction: 'outbound', method: 'phone', started_at: now, outcome: 'reached', summary_enc: `Call ${i}`, created_at: now, updated_at: now })),
    tasks: Array.from({ length: third }, (_, i) => ({ id: randomUUID(), client_id: c(i), assigned_to: user.id, created_by: user.id, title_enc: `Follow up ${i}`, priority: 'normal', status: 'open', created_at: now, updated_at: now })),
  };
  const { push } = require('../../server/routes/sync');
  const t0 = process.hrtime.bigint();
  const res = push(user, { device_now: now, tables });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`[perf] push of ${ROWS} rows: ${ms.toFixed(0)} ms (${(ms / ROWS * 1000).toFixed(0)} µs/row)`);
  assert.deepEqual(res.rejected, []);
  assert.equal(res.applied.interventions + res.applied.calls + res.applied.tasks, ROWS);
  assert.ok(ms < BUDGET_MS, `push took ${ms.toFixed(0)} ms, budget ${BUDGET_MS} ms`);
});
