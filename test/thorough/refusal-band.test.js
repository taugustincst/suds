'use strict';
// Which fiscal years a publication release refuses (engineering review of 1.16.2, M4). The benchmark's
// 2,000-client year (test/fixtures/release-small-programme.json) is refused for want of budget since 1.16.2
// withdrew 1.16.1's withholding rule. This sweep scales that year's overdose figures (T = 11, 12 months) from 0.2
// to 1.5 times, moving every month's events and reversals by up to 2 at random (seeded, so the run is the same
// every time), and holds each release to two things:
//   * a refusal is whole: nothing is printed (no funder report, NDP log or settlement figures), for want of
//     budget, with the year's message; never a table quietly left out by a rule;
//   * a release that publishes withheld nothing but by the check (every withheld table has its reason).
// It then records the refusal band and fails when it moves outside the one the docs state ("about 110 to 240
// overdose events", docs/PERFORMANCE.md, *Which programmes are refused*), so a change to the band is seen and the
// docs follow it. Units of work are counted, not time, so the result does not depend on the machine; the time
// backstop is set out of the way. Several minutes: CI's thorough-sdc job (scripts/test-thorough.js SDC_SWEEPS).
const { test } = require('node:test');
const assert = require('node:assert');
const RA = require('../../server/release-audit');
const SDC = require('../../server/sdc');
const base = require('../fixtures/release-small-programme.json');

// The band the docs state, with a margin. Measured for 1.16.3: 23 of 84 refused, with 113 to 237 events (and
// many programmes inside that range published: the band is where refusals happen, not a clean cut). About 4.5 min.
const DOC_LOW = 100; const DOC_HIGH = 260;
// Two sweeps: 1.16.2's (12 scales from 0.2 to 1.5, 5 programmes each, the first exactly scaled; 17 of 60 refused,
// 126 to 237 events), and the lower edge the review found below it (0.55 to 0.6, 8 jittered programmes each).
const SWEEPS = [
  { seed: 7, scales: [0.2, 0.35, 0.45, 0.55, 0.6, 0.63, 0.65, 0.68, 0.75, 1, 1.2, 1.5], reps: 5, exactFirst: true },
  { seed: 1, scales: [0.55, 0.58, 0.6], reps: 8, exactFirst: false },
];

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
/** The benchmark year with its overdose figures scaled by k, each month moved by up to 2 when jitter is on. */
function scaled(k, rnd) {
  const f = JSON.parse(JSON.stringify(base)); const od = f.inputs.funder.overdose;
  for (const m of od.by_month) {
    const j = rnd ? Math.round((rnd() - 0.5) * 4) : 0;
    m.n = Math.max(0, Math.round(m.n * k) + j);
    m.reversals = Math.min(m.n, Math.max(0, Math.round(m.reversals * k) + j));
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
  for (const { seed, scales, reps, exactFirst } of SWEEPS) {
    const rnd = lcg(seed);
    for (const k of scales) for (let r = 0; r < reps; r++) yield [`seed=${seed} k=${k} r=${r}`, scaled(k, r > 0 || !exactFirst ? rnd : null)];
  }
}

test('fiscal years of scaled programmes: a refusal is whole, and the refusal band is the one the docs state', { skip: !process.env.SUDS_THOROUGH && 'thorough only (SUDS_THOROUGH=1)' }, () => {
  const refused = []; const published = [];
  for (const [label, f] of programmes()) {
    const E = f.inputs.funder.overdose.events; const at = `${label} E=${E}`;
    const p = RA.protectFigures({ ...f.inputs, perFund: new Map(f.inputs.perFund) }, f.T, { timeLimitMs: 10 * 60 * 1000 });
    assert.ok(p.audit.steps <= SDC.STEP_LIMIT * 1.01, `${at}: ${p.audit.steps} units of work`);
    if (p.refused) {
      assert.equal(p.funder, undefined, `${at}: a refused release prints nothing`);
      assert.equal(p.uses, undefined, at); assert.equal(p.ndp, undefined, at); assert.equal(p.id, undefined, at);
      assert.equal(p.refused.out_of_budget, true, `${at}: refused for want of budget, not for a finding`);
      assert.match(p.refused.message, /A year is the longest standard period/, at);
      refused.push(E);
    } else {
      const reasons = new Map(p.withheld_reasons.map((w) => [w.table, w.reason]));
      for (const t of p.withheld_tables) assert.ok(['protect', 'check'].includes(reasons.get(t)), `${at}: ${t} withheld with a reason (${reasons.get(t)})`);
      published.push(E);
    }
    if (process.env.SUDS_PERF_VERBOSE) console.log(`[band] ${at} ${p.refused ? 'refused' : 'published'} ${p.audit.steps} units, withheld ${JSON.stringify(p.withheld_tables)}`);
  }
  const lo = Math.min(...refused); const hi = Math.max(...refused);
  console.log(`[band] ${refused.length} of ${refused.length + published.length} refused, overdose events ${lo} to ${hi}`);
  assert.ok(refused.includes(base.inputs.funder.overdose.events), 'the benchmark year itself (200 events) is refused, as test/publication-release-perf.test.js says');
  assert.ok(lo >= DOC_LOW && hi <= DOC_HIGH, `the band ${lo} to ${hi} is outside the one the docs state (about 110 to 240): update docs/PERFORMANCE.md, ADR-0009, HIPAA.md and the buyer docs, then this test`);
  assert.ok(published.some((e) => e < lo) && published.some((e) => e > hi), 'programmes on both sides of the band publish');
});
