'use strict';
// The check's step over one value (server/sdc.js widen; docs/architecture/ADR-0009, "One value skipped"): at most one
// value is skipped per count, so a count that passes with a span of P = ceil(T/2) has at least P distinct values that
// worlds printing the same release show, one fewer than the P+1 a step without skips asks for, never more
// (engineering review of the 1.17.0 candidate, M1: a skip at every step let a range alternate hole, value, hole, and
// published cells stood behind 2 values at T = 3 and T = 4). server/sdc.js tells probe.onWiden each range it widened.
// SUDS_THOROUGH=1 adds the three-month family and T = 4 (scripts/test-thorough.js runs it with the SDC sweeps).
const THOROUGH = process.env.SUDS_THOROUGH === '1';
const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers'); // the test environment (test keys), before any server module
const SDC = require('../server/sdc');
const PR = require('../server/publication-release');
const { pattern } = require('./fixtures/release-worlds');

function widened(worlds, T) {
  const seen = [];
  SDC.probe.onWiden = (e) => seen.push(e);
  try { for (const w of worlds) PR.protectFigures(w.inputs, T); } finally { SDC.probe.onWiden = null; }
  return seen;
}

function check(name, worlds, T, { expectSkips = false } = {}) {
  const seen = widened(worlds, T);
  assert.ok(seen.length > 0, `${name}, T=${T}: the step ran`);
  const skipped = seen.filter(e => e.holes.length);
  if (expectSkips) assert.ok(skipped.length > 0, `${name}, T=${T}: some count was widened over a value no world shows (the case the skip is for)`);
  for (const e of seen) {
    assert.ok(e.holes.length <= 1, `${name}, T=${T}: ${e.id} skipped ${e.holes.length} values (${e.holes}) widening ${e.from} to ${e.range}`);
    for (const v of e.holes) assert.ok(!e.shown.includes(v), `${name}: a skipped value is one no world showed`);
    // A count the step lets pass (a span of P or more) stands behind at least P distinct values: the P+1 of a
    // range without skips, less the one value it may have skipped.
    if (e.range[1] - e.range[0] >= e.P) {
      assert.ok(e.shown.length >= e.P, `${name}, T=${T}: ${e.id} passes over ${e.range} with only ${e.shown.length} distinct values (${e.shown}), fewer than P = ${e.P}`);
      if (e.holes.length) assert.ok(e.shown.length >= e.range[1] - e.range[0], `${name}, T=${T}: ${e.id}: every value of ${e.range} but the one skipped is shown (${e.shown})`);
    }
  }
  return { widened: seen.length, skipped: skipped.length };
}

test('widenRange: one value skipped per count, over both directions; never two, whatever values are missing', () => {
  const T = 11; const P = 6; const x = 20;
  const base = { a: x, b: x, lo: 0, hi: 100, x, T, P };
  // Every value shown: P+1 contiguous values.
  assert.deepEqual(SDC.widenRange({ ...base, shows: () => true }), { range: [14, 20], holes: [] });
  // One value missing below: stepped over once.
  assert.deepEqual(SDC.widenRange({ ...base, shows: (v) => v !== 18 }), { range: [14, 20], holes: [18] });
  // Every other value missing (the alternation 1.17.0's first version allowed, a hole at each step): one skip, then
  // the step stops going down and goes up, where the same holds; the span stays short and the count does not pass.
  const odd = SDC.widenRange({ ...base, shows: (v) => v % 2 === 0 });
  assert.equal(odd.holes.length, 1, JSON.stringify(odd));
  assert.ok(odd.range[1] - odd.range[0] < P, `alternating holes do not reach the span P: ${JSON.stringify(odd)}`);
  // A hole below and another above: the second is not skipped.
  const two = SDC.widenRange({ ...base, a: 18, b: 22, shows: (v) => v !== 17 && v !== 23 && v >= 15 });
  assert.deepEqual(two.holes, [17]);
  assert.equal(two.range[1], 22, 'the hole above is not stepped over after one below was');
  // Whatever values are missing, a range that reaches the span P has at least P values shown.
  let rnd = 12345; const next = () => { rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0; return rnd / 2 ** 32; };
  for (let k = 0; k < 2000; k++) {
    const Tk = 3 + Math.floor(next() * 20); const Pk = Math.ceil(Tk / 2); const miss = new Set(); const xk = 30;
    for (let v = 0; v < 70; v++) if (v !== xk && next() < 0.3) miss.add(v);
    const r = SDC.widenRange({ a: xk, b: xk, lo: 0, hi: 69, x: xk, T: Tk, P: Pk, shows: (v) => !miss.has(v) });
    assert.ok(r.holes.length <= 1);
    if (r.range[1] - r.range[0] >= Pk) {
      let shown = 0; for (let v = r.range[0]; v <= r.range[1]; v++) if (!miss.has(v)) shown++;
      assert.ok(shown >= Pk, `T=${Tk}: ${shown} values shown in ${r.range}`);
    }
  }
});

test('the check\'s step skips at most one value per count, so a count it passes stands behind at least P values', () => {
  // Race codes at T = 3: the people served range over 3 to 6 without 5 in some printouts (a value no world shows).
  check('race codes', pattern.race(2, 5), 3, { expectSkips: true });
  check('two months', pattern.months(2, 5), 3, { expectSkips: true });
  if (!THOROUGH) return;
  check('two months, reversed, fatal and neither', pattern.monthsOutcome(2, 5), 4, { expectSkips: true });
  check('three months', pattern.months3(2, 5), 3, { expectSkips: true });
});
