'use strict';
// The period helpers (server/county-periods.js) and the browser's generated copy of them (public/county-periods.js,
// scripts/gen-county-periods.js): one set of rules, so the county view, the Send to the county card and the county
// connection's status name a period the same way.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const P = require('../server/county-periods');
const G = require('../scripts/gen-county-periods');

test('the browser\'s copy is generated from the server\'s and is current', async () => {
  assert.equal(fs.readFileSync(G.DEST, 'utf8'), G.generate(fs.readFileSync(G.SRC, 'utf8')), 'run `npm run build:local` (or node scripts/gen-county-periods.js) and commit public/county-periods.js');
  // Loaded as the browser loads it (an ES module; copied to a temporary .mjs, since this package is CommonJS), it
  // exports the same functions, and they answer the same.
  const tmp = require('node:path').join(fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'suds-periods-')), 'county-periods.mjs');
  fs.writeFileSync(tmp, fs.readFileSync(G.DEST, 'utf8'));
  const B = await import(require('node:url').pathToFileURL(tmp).href);
  assert.deepEqual(Object.keys(B).sort(), Object.keys(P).sort());
  for (const day of ['2026-01-01', '2026-07-01', '2026-09-30', '2027-03-31']) {
    assert.deepEqual(B.presets(day), P.presets(day), day);
    assert.deepEqual(B.submissionPeriods(day), P.submissionPeriods(day), day);
    assert.deepEqual(B.completeMonths(day), P.completeMonths(day), day);
  }
  fs.rmSync(require('node:path').dirname(tmp), { recursive: true, force: true });
});

test('periods: quarters, months, fiscal labels', () => {
  assert.deepEqual(P.lastCompleteQuarter('2026-09-30'), { from: '2026-04-01', to: '2026-06-30' });
  assert.deepEqual(P.lastCompleteQuarter('2026-01-01'), { from: '2025-10-01', to: '2025-12-31' });
  assert.deepEqual(P.completeQuarters('2026-09-30', 4).map(q => q.from), ['2026-04-01', '2026-01-01', '2025-10-01', '2025-07-01']);
  assert.deepEqual(P.completeMonths('2026-03-15', 3).map(q => `${q.from}/${q.to}`), ['2026-02-01/2026-02-28', '2026-01-01/2026-01-31', '2025-12-01/2025-12-31']);
  assert.equal(P.describe('2026-04-01', '2026-06-30'), 'calendar Q2 2026 · FY 2025-26 Q4');
  assert.equal(P.monthsLabel('2026-04-01', '2026-06-30'), 'Apr – Jun 2026');
  assert.equal(P.monthsLabel('2026-02-01', '2026-02-28'), 'Feb 2026');
  assert.equal(P.fyLabel(2025), 'FY 2025-26');
});
