'use strict';
// Which fiscal years a publication release refuses (engineering reviews of 1.16.2, M4, and 1.16.3, M3). The
// benchmark's 2,000-client year (test/fixtures/release-small-programme.json) is refused for want of budget since
// 1.16.2 withdrew 1.16.1's withholding rule. This sweep scales that year's overdose figures (T = 11, 12 months) and
// moves each month's events and reversals at random (seeded, so the run is the same every time), and holds each
// release to two things:
//   * a refusal is whole: nothing is printed (no funder report, NDP log or settlement figures), with the year's
//     message; never a table quietly left out by a rule;
//   * a release that publishes withheld nothing but by the check (every withheld table has its reason).
// It records which years were refused and why (for want of budget, or because the release with tables withheld
// still failed its check), with their overdose events. It pins no band: 1.16.3's docs said "about 110 to 240
// events, everything outside publishes", and months varied a little more (events and reversals moved on their own
// by up to 3 or 4) were refused at 87 to 99 events for budget and 301 to 341 for a failed check (docs/PERFORMANCE.md,
// *Which programmes are refused*). Units of work are counted, not time, so the result does not depend on the
// machine; the time backstop is set out of the way. About 6 minutes: CI's thorough-sdc job (scripts/test-thorough.js
// SDC_SWEEPS).
const { test } = require('node:test');
const assert = require('node:assert');
const RA = require('../../server/release-audit');
const SDC = require('../../server/sdc');
const base = require('../fixtures/release-small-programme.json');

// 1.16.2's sweep (12 scales from 0.2 to 1.5, 5 programmes each, the first exactly scaled, each month moved by up to 2),
// the lower edge the 1.16.2 review found below it (0.55 to 0.6), and the 1.16.3 review's runs with each month's
// events and reversals moved independently by up to J (its seeds, so the same programmes: refused at 87, 93 and 99
// events for budget, and at 301 to 341 for a failed check).
const SWEEPS = [
  { seed: 7, scales: [0.2, 0.35, 0.45, 0.55, 0.6, 0.63, 0.65, 0.68, 0.75, 1, 1.2, 1.5], reps: 5, exactFirst: true },
  { seed: 1, scales: [0.55, 0.58, 0.6], reps: 8, exactFirst: false },
  { seed: 11, scales: [0.45], reps: 6, J: 4 },
  { seed: 23, scales: [0.5], reps: 6, J: 3 },
  { seed: 5, scales: [1.5, 1.6, 1.7], reps: 6, J: 4 },
];

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
/**
 * The benchmark year with its overdose figures scaled by k. With jitter on, each month is moved by up to 2 (events
 * and reversals together), or, given J, its events and its reversals each by up to J on their own.
 */
function scaled(k, rnd, J) {
  const f = JSON.parse(JSON.stringify(base)); const od = f.inputs.funder.overdose;
  const move = (w) => (rnd ? Math.round((rnd() - 0.5) * 2 * w) : 0);
  for (const m of od.by_month) {
    const j = move(J || 2);
    m.n = Math.max(0, Math.round(m.n * k) + j);
    m.reversals = Math.min(m.n, Math.max(0, Math.round(m.reversals * k) + (J ? move(J) : j)));
    m.reversal_doses = m.reversals ? Math.max(m.reversals, Math.round(m.reversal_doses * k)) : 0;
  }
  od.events = od.by_month.reduce((a, x) => a + x.n, 0);
  const R = od.by_month.reduce((a, x) => a + x.reversals, 0); od.reversals = R;
  const by = od.by_administered_by; const tot = by.reduce((a, x) => a + x.n, 0); let s = 0;
  by.forEach((x, i) => { x.n = i < by.length - 1 ? Math.round((x.n * R) / tot) : R - s; s += x.n; });
  od.fatal = Math.min(od.events, Math.round(od.fatal * k)); od.community_reported = Math.min(od.events, Math.round(od.community_reported * k));
  od.naloxone_doses = Math.max(Math.round(od.naloxone_doses * k), od.by_month.reduce((a, x) => a + x.reversal_doses, 0));
  return f;
}

/** Every programme of the sweeps, in order: [label, the year's figures]. */
function* programmes() {
  for (const { seed, scales, reps, exactFirst, J } of SWEEPS) {
    const rnd = lcg(seed);
    for (const k of scales) for (let r = 0; r < reps; r++) yield [`seed=${seed}${J ? ` J=${J}` : ''} k=${k} r=${r}`, scaled(k, r > 0 || !exactFirst ? rnd : null, J)];
  }
}

test('fiscal years of scaled programmes: a refusal is whole, and which years are refused is recorded', { skip: !process.env.SUDS_THOROUGH && 'thorough only (SUDS_THOROUGH=1)' }, () => {
  const refused = { budget: [], check: [] }; let published = 0; let all = 0;
  for (const [label, f] of programmes()) {
    const E = f.inputs.funder.overdose.events; const at = `${label} E=${E}`; all++;
    const p = RA.protectFigures({ ...f.inputs, perFund: new Map(f.inputs.perFund) }, f.T, { timeLimitMs: 10 * 60 * 1000 });
    assert.ok(p.audit.steps <= SDC.STEP_LIMIT * 1.01, `${at}: ${p.audit.steps} units of work`);
    if (p.refused) {
      assert.equal(p.funder, undefined, `${at}: a refused release prints nothing`);
      assert.equal(p.uses, undefined, at); assert.equal(p.ndp, undefined, at); assert.equal(p.id, undefined, at);
      assert.equal(p.refused.headline, false, `${at}: the people served could be shown`);
      assert.match(p.refused.message, /A year is the longest standard period/, at);
      refused[p.refused.out_of_budget ? 'budget' : 'check'].push(E);
    } else {
      const reasons = new Map(p.withheld_reasons.map((w) => [w.table, w.reason]));
      for (const t of p.withheld_tables) assert.ok(['protect', 'check'].includes(reasons.get(t)), `${at}: ${t} withheld with a reason (${reasons.get(t)})`);
      published++;
    }
    if (process.env.SUDS_PERF_VERBOSE) console.log(`[band] ${at} ${p.refused ? `refused (${p.refused.out_of_budget ? 'budget' : 'check'})` : 'published'} ${p.audit.steps} units, withheld ${JSON.stringify(p.withheld_tables)}`);
  }
  const range = (xs) => (xs.length ? `${Math.min(...xs)} to ${Math.max(...xs)}` : 'none');
  console.log(`[band] ${all - published} of ${all} refused: ${refused.budget.length} for want of budget (overdose events ${range(refused.budget)}), ${refused.check.length} for a failed check (${range(refused.check)})`);
  assert.ok(refused.budget.includes(base.inputs.funder.overdose.events), 'the benchmark year itself (200 events) is refused for want of budget, as test/publication-release-perf.test.js says');
});
