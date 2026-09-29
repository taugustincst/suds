'use strict';
// Do the quarters of a fiscal year publish when the year does not? (market review of 1.16.3, finding 1.) Since
// 1.16.3 a refused year's message offers its quarters. This sweep seeds whole programmes the way the benchmark's is
// seeded (test/fixtures/funder-scale.js; the 2,000-client programme with seed 7 is the benchmark's own year,
// test/fixtures/release-small-programme.json), reads each fiscal year and each of its four quarters as a publication
// release reads them (the funder report's figures for that period, every table, not the year's figures sliced) and
// audits each with release-audit.js protectFigures at the default threshold. It holds every release to what
// refusal-band.test.js does (a refusal is whole: nothing printed, with its own period's message; a published
// release withheld nothing but by the check) and records how many years and quarters are refused and why
// (docs/PERFORMANCE.md, *Which programmes are refused*: for 1.16.4, 28 of 72 quarters). Units of work are counted,
// not time; the time backstop is set out of the way. Bounded to 18 programmes (90 audits, about 4 minutes): CI's
// thorough-sdc job (scripts/test-thorough.js SDC_SWEEPS).
const { test } = require('node:test');
const assert = require('node:assert');
require('../helpers'); // the test environment (an in-memory database, test keys), before any server module
const db = require('../../server/db');
const { ensureBootstrap } = require('../../server/bootstrap');
const scale = require('../fixtures/funder-scale');
const FR = require('../../server/funder-report');
const HR = require('../../server/harm-reduction-reports');
const O = require('../../server/options');
const RA = require('../../server/release-audit');
const SDC = require('../../server/sdc');
const { range } = require('../../server/routes/reports');

// Programmes of 1,100 to 2,600 clients (about 110 to 260 overdose events a year, around the fiscal-year refusal
// band), three seeds each; seed 7 at 2,000 clients is the benchmark programme.
const SIZES = [1100, 1400, 1700, 2000, 2300, 2600];
const SEEDS = [7, 11, 23];
const YEAR = ['2025-07-01', '2026-06-30'];
const QUARTERS = [['2025-07-01', '2025-09-30'], ['2025-10-01', '2025-12-31'], ['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30']];

function programme(clients, seedValue) {
  try { db.close(); } catch { /* the first one */ }
  db.open(':memory:'); ensureBootstrap(); db.setSetting('programme_profile', 'treatment');
  scale.seed(db, { clients, visits: clients * 5, calls: clients, notes: 0, seedValue });
}
/** A publication release's inputs for one standard period, read as server/publication-release.js reads them. */
function released([from, to]) {
  const user = db.one(`SELECT * FROM users WHERE username='admin'`);
  const ctx = { user, query: new URLSearchParams(`from=${from}&to=${to}&purpose=publication`) };
  const r = range(ctx); const counting = FR.countingMode(ctx, r);
  assert.equal(counting.purpose, 'publication', `${from} to ${to} is a publication release`);
  const { raw, perFund } = FR.runSync(FR.figures(ctx, r, null, { fold: counting.threshold }));
  const inputs = { funder: raw, perFund, settlement: HR.settlementFigures(r), domains: { months: RA.monthsOf(r.from, r.to), administered_by: O.known('ADMINISTERED_BY'), discharge_reasons: O.known('DISCHARGE_REASONS') } };
  return { T: counting.threshold, inputs, p: RA.protectFigures(inputs, counting.threshold, { timeLimitMs: 10 * 60 * 1000 }) };
}
const why = (x) => (x.backstop ? 'backstop' : x.out_of_budget ? 'budget' : x.headline ? 'headline' : 'unprotected');

test('quarters of seeded fiscal years, read for the quarter: each refusal is whole, and how many are refused is recorded', { skip: !process.env.SUDS_THOROUGH && 'thorough only (SUDS_THOROUGH=1)' }, () => {
  const years = []; const quarters = [];
  try {
    for (const clients of SIZES) {
      for (const seed of SEEDS) {
        programme(clients, seed);
        const year = { clients, seed, quarters: [] };
        for (const [i, period] of [YEAR, ...QUARTERS].entries()) {
          const { T, inputs, p } = released(period);
          const E = inputs.funder.overdose.events; const at = `${clients} clients seed ${seed} ${period.join(' to ')} E=${E}`;
          assert.equal(T, 11, 'the default threshold');
          assert.ok(p.audit.steps <= SDC.STEP_LIMIT * 1.01, `${at}: ${p.audit.steps} units of work`);
          const row = { E, served: inputs.funder.unduplicated.served, refused: p.refused ? why(p.refused) : null, steps: p.audit.steps };
          if (p.refused) {
            assert.equal(p.funder, undefined, `${at}: a refused release prints nothing`);
            assert.equal(p.uses, undefined, at); assert.equal(p.ndp, undefined, at); assert.equal(p.id, undefined, at);
            assert.match(p.refused.message, i === 0 ? /A year is the longest standard period/ : /Its fiscal year may be tried instead/, `${at}: its own period's message`);
            assert.match(p.refused.message, /github\.com\/taugustincst\/suds\/issues/, `${at}: says whom to tell`);
          } else {
            const reasons = new Map(p.withheld_reasons.map((w) => [w.table, w.reason]));
            for (const t of p.withheld_tables) assert.ok(['protect', 'check'].includes(reasons.get(t)), `${at}: ${t} withheld with a reason`);
          }
          if (i === 0) Object.assign(year, row); else { year.quarters.push(row); quarters.push({ ...row, yearRefused: !!year.refused }); }
          if (process.env.SUDS_PERF_VERBOSE) console.log(`[quarters] ${at} ${row.refused ? `refused (${row.refused})` : 'published'} ${p.audit.steps} units, withheld ${JSON.stringify(p.withheld_tables || [])}`);
        }
        years.push(year);
      }
    }
  } finally { try { db.close(); } catch { /* already closed */ } }
  const refusedYears = years.filter((y) => y.refused);
  const ofRefused = quarters.filter((q) => q.yearRefused);
  const count = (xs) => xs.reduce((m, q) => { if (q.refused) m[q.refused] = (m[q.refused] || 0) + 1; return m; }, {});
  const allFour = refusedYears.filter((y) => y.quarters.every((q) => !q.refused)).length;
  console.log(`[quarters] ${years.length} years, ${refusedYears.length} refused (overdose events ${refusedYears.map((y) => y.E).join(', ')}); `
    + `${quarters.filter((q) => q.refused).length} of ${quarters.length} quarters refused ${JSON.stringify(count(quarters))}; `
    + `of the refused years' ${ofRefused.length} quarters, ${ofRefused.filter((q) => q.refused).length} refused ${JSON.stringify(count(ofRefused))}; `
    + `${allFour} of ${refusedYears.length} refused years had all four quarters publish`);
  // The benchmark's own year (docs/PERFORMANCE.md): refused for want of budget, and its first quarter refused too,
  // for a finding (the release with the events by month withheld still failed its check), not for budget.
  const bench = years.find((y) => y.clients === 2000 && y.seed === 7);
  assert.equal(bench.E, 200); assert.equal(bench.refused, 'budget');
  assert.deepEqual(bench.quarters.map((q) => q.refused), ['unprotected', null, null, null]);
  // What the docs state (measured for 1.16.4): quarters are no sure way round a refused year. A quarter of a refused
  // year can be refused too, like the benchmark's first quarter. Recorded, not pinned: how many are refused.
  assert.ok(refusedYears.length > 0, 'some years are refused');
  assert.ok(ofRefused.some((q) => q.refused), 'a quarter of a refused year can be refused too (the docs say so)');
});
