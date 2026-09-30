'use strict';
// The algorithm-aware differencing attacker on the county publication release (built for 1.21.0, not yet released;
// server/county-publication-audit.js; docs/COUNTY-VIEW.md "Publication"). One of the SDC attacker sweeps
// (scripts/test-thorough.js SDC_SWEEPS: SUDS_THOROUGH=1 runs the full families in CI's thorough-sdc job; npm test
// runs a sample).
//
// As test/fixtures/pattern-attacker.js does for a programme's own release, the attacker knows the method (SUDS is open
// source): it takes every county that could lie behind a printout (every world of a family: each programme's figure
// from 0 to a few past T), runs the real county release on each, and keeps the worlds that print the same. It also
// holds every programme's own publication release, the most that release can say: the programme's figure when it is 0
// or at least T, "<T" when 1 to T-1. The worlds left are those that print the same county release AND the same
// programme releases. Over them, for each printout:
//   * each programme's figure shown "<T" in its own release must still be able to be the lowest small value the
//     symbols alone allow (1, or as near as they allow), and its values must range over ceil(T/2) values (all of
//     them when fewer are possible);
//   * a county total shown "suppressed" must range over at least ceil(T/2) values.
// A refused release publishes nothing and is not checked (as in pattern-attacker.js).
// Every screened measure carries the same figure in a world, so the within-programme relationships (people linked to
// MOUD among those linked, and those among the people served) hold in every world.
const THOROUGH = process.env.SUDS_THOROUGH === '1';
const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers'); // the test environment (test keys), before any server module
const CPA = require('../server/county-publication-audit');

/** Every world of n programmes, each figure one of `values`. */
function worldsOf(n, values) {
  const out = []; const rec = (acc) => { if (acc.length === n) { out.push(acc); return; } for (const v of values) rec([...acc, v]); };
  rec([]);
  return out;
}
const inputsOf = (w) => ({ programmes: w.map(v => ({ values: Object.fromEntries(CPA.SCREENED.map(m => [m, v])) })) });

/** The leaks the method-aware attacker finds over a family (see above). inner(w): the worlds whose printouts are checked. */
function attack(n, values, T, { inner = () => true, protect = CPA.protectCounty } = {}) {
  const P = Math.ceil(T / 2);
  const own = (v) => (v > 0 && v < T ? `<${T}` : String(v));
  const cls = (v) => (v === 0 ? '0' : v < T ? 'small' : 'big');
  const runs = worldsOf(n, values).map(w => {
    const r = protect(inputsOf(w), T);
    return { w, inner: inner(w), refused: !!r.refused, shown: r.refused ? null : r.shown.people_served, key: r.refused ? 'REFUSED' : JSON.stringify(r.shown) + '|' + w.map(own).join(',') };
  });
  const groups = new Map();
  for (const r of runs) { if (!groups.has(r.key)) groups.set(r.key, []); groups.get(r.key).push(r); }
  const leaks = []; let checked = 0; let refused = 0;
  for (const [key, ws] of groups) {
    if (!ws.some(r => r.inner)) continue;
    if (key === 'REFUSED') { refused += ws.length; continue; }
    checked++;
    const shown = ws[0].shown; const w0 = ws[0].w;
    // The worlds whose values have the printout's classes alone: each programme's own symbol, and the county total's.
    const totalCls = typeof shown === 'number' ? cls(shown) : shown === `<${T}` ? 'small' : shown === 'suppressed' ? 'big' : null;
    const symbolic = runs.filter(r => r.w.every((v, i) => own(v) === own(w0[i])) && (!totalCls || cls(r.w.reduce((a, b) => a + b, 0)) === totalCls));
    w0.forEach((v, i) => {
      if (!(v > 0 && v < T)) return;
      const vs = [...new Set(ws.map(r => r.w[i]))].sort((a, b) => a - b);
      const sym = [...new Set(symbolic.map(r => r.w[i]))].sort((a, b) => a - b);
      const L = sym[0]; const U = sym[sym.length - 1];
      if (!vs.includes(L)) leaks.push({ T, printout: key, programme: i, values: vs, why: `cannot be ${L}` });
      else if (vs[vs.length - 1] - vs[0] < Math.min(P - 1, U - L)) leaks.push({ T, printout: key, programme: i, values: vs, why: `small values span only ${vs.length}` });
    });
    if (shown === 'suppressed') {
      const ts = ws.map(r => r.w.reduce((a, b) => a + b, 0));
      if (Math.max(...ts) - Math.min(...ts) < P) leaks.push({ T, printout: key, why: `a suppressed total spans less than ${P}`, totals: [...new Set(ts)] });
    }
  }
  return { leaks, checked, refused, worlds: runs.length };
}
/** Figures 0 to T-1 (every small value), and a few at and past T (exact in a programme's own release). */
const family = (T, big) => [...Array.from({ length: T }, (_, i) => i), ...big];

test('algorithm-aware differencing attacker: the county release beside every programme\'s own release leaks no small figure (T = 3 and 4; T = 5 and 11, and four programmes, in the thorough run)', () => {
  const run = (n, T, big) => {
    const r = attack(n, family(T, big), T);
    assert.ok(r.checked > 0, `n=${n}, T=${T}: nothing published`);
    // A refused release publishes nothing, so there is nothing to subtract (at T = 3, two programmes of 1 or 2 and no
    // other figure are refused: the hidden total could only be 3 or 4, too narrow a range). Most worlds publish.
    assert.ok(r.refused * 4 < r.worlds, `n=${n}, T=${T}: ${r.refused} of ${r.worlds} worlds refused`);
    assert.deepEqual(r.leaks.slice(0, 6), [], `n=${n}, T=${T}: ${r.leaks.length} leaks`);
  };
  // Not vacuous: a release that prints each exact total (small ones as "<T" only) leaks, and the attacker says so.
  const naive = (inputs, T) => { const shown = {}; for (const m of CPA.SCREENED) { const x = inputs.programmes.reduce((a, p) => a + p.values[m], 0); shown[m] = x > 0 && x < T ? `<${T}` : x; } return { shown }; };
  assert.ok(attack(3, family(3, [3, 4, 7]), 3, { protect: naive }).leaks.length > 0, 'the attacker finds the leaks of exact totals');
  run(3, 3, [3, 4, 7]);
  run(2, 4, [4, 5, 9]);
  if (!THOROUGH) return;
  run(3, 4, [4, 5, 9]);
  run(3, 5, [5, 6, 12]);
  run(4, 3, [3, 5]);
  run(3, 11, [11, 20]);
});
