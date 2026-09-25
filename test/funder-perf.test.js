'use strict';
// The funder report is the page a programme is judged on, and at 20,000 clients / 100,000 visits it took
// 4.4 s — during which the server answered nothing else, /api/health included — because the set of people
// served was a CTE recomputed by each of about nine queries, and the report-period predicate was read as two
// index scans merged row by row. This seeds half that size (10,000 clients, 50,000 visits, 10,000 calls).
//
// The bound is relative, so that a slow or busy machine (npm test runs files in parallel) does not flake it
// and a fast one does not hide a regression: one evaluation of the earlier implementation's served set — the
// unit the old report paid about nine times over — is timed on the same data, and the whole report must
// come in under three of those units (it takes about one). An absolute ceiling catches anything pathological.
// `node test/fixtures/funder-scale.js` measures at the full size.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const scale = require('./fixtures/funder-scale');

const UNITS = 3;
const CEILING_MS = 8000;
let admin, base;
before(async () => {
  base = await H.start();
  scale.seed(H.db, { clients: 10000, visits: 50000, calls: 10000, notes: 0, seedValue: 11 });
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
});
after(async () => { await H.stop(); });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
// The earlier implementation's served set, verbatim (its OR-of-two-ranges period predicate included).
function oldServedUnit(from, to, fromTs, toEnd) {
  const ts = (col) => `((length(${col})>10 AND ${col} BETWEEN ? AND ?) OR (length(${col})=10 AND ${col} BETWEEN ? AND ?))`;
  const p = [fromTs, toEnd, from, to];
  const sql = `WITH served(id) AS (SELECT DISTINCT i.client_id AS id FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND c.deleted_at IS NULL AND 1=1
    UNION SELECT ca.client_id FROM calls ca JOIN clients c ON c.id=ca.client_id WHERE ${ts('ca.started_at')} AND c.deleted_at IS NULL AND 1=1) SELECT COUNT(*) n FROM served`;
  const t = process.hrtime.bigint(); H.db.one(sql, ...p, ...p); return Number(process.hrtime.bigint() - t) / 1e6;
}

test('a fiscal-year funder report over 10,000 clients and 50,000 visits costs about one pass, not nine', async () => {
  const { range } = require('../server/routes/reports');
  // A full fiscal year, where the served set is the cost (a short period is dominated by fixed costs).
  for (const q of ['from=2025-07-01&to=2026-06-30', 'from=2025-07-01&to=2026-06-30&purpose=submission&counts=exact']) {
    const p = range({ query: new URLSearchParams(q) });
    const runs = []; const units = []; let health = 0; // health: reported only (SUDS_PERF_VERBOSE)
    for (let k = 0; k < 3; k++) {
      units.push(oldServedUnit(p.from, p.to, p.fromTs, p.toEnd));
      const t = Date.now();
      const report = admin.get(`/api/reports/funder?${q}`);
      // Sent while the report runs: answered between the report's phases, not after the whole of it.
      const h0 = Date.now(); const hms = await fetch(`${base}/api/health`).then(() => Date.now() - h0);
      const r = await report; runs.push(Date.now() - t); health = Math.max(health, hms);
      assert.equal(r.status, 200);
      assert.ok(r.data.unduplicated.served > 5000);
    }
    const ms = median(runs), unit = median(units);
    assert.ok(ms < UNITS * unit + 50, `funder report (${q}) took ${ms} ms; one old served-set pass takes ${unit.toFixed(0)} ms here, and the report must stay under ${UNITS} of them`);
    assert.ok(ms < CEILING_MS, `funder report (${q}) took ${ms} ms`);
    if (process.env.SUDS_PERF_VERBOSE) console.log(`[perf] ${q}: report ${ms} ms, old served-set pass ${unit.toFixed(0)} ms, /api/health waited ${health} ms`);
  }
});
