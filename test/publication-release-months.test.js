'use strict';
// Since 1.17.0 no publication release prints the overdose events by month (docs/architecture/ADR-0009, "Events by
// month: not published"). The algorithm-aware attacker (test/fixtures/pattern-attacker.js) holds each month's true
// events and events not reversed, printed nowhere, to the rule over every world of the families with months. A file of
// its own (SUDS_THOROUGH=1 runs the full families: scripts/test-thorough.js SDC_SWEEPS), so that CI's thorough-sdc job
// runs it beside test/publication-release.test.js rather than after it.
const THOROUGH = process.env.SUDS_THOROUGH === '1';
const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers'); // the test environment (test keys), before any server module
const { pattern } = require('./fixtures/release-worlds');
const { attackAll } = require('./fixtures/pattern-attacker');

function assertNoPatternLeak(name, worlds, T) {
  const { leaks, checked } = attackAll(worlds, T);
  assert.ok(checked > 0, `${name}: nothing published`);
  assert.deepEqual(leaks, [], `${name}, T=${T}: ${JSON.stringify(leaks.slice(0, 6), null, 1)}`);
}

test('algorithm-aware attacker: since 1.17.0 the events by month are printed nowhere - each month\'s events and events not reversed range as the rule asks, over every world (T = 3, and 11 in the thorough run; T = 5 in publication-release.test.js's two-month family)', () => {
  // docs/architecture/ADR-0009, "Events by month: not published". The model has no cell for them, and states what the
  // months said instead: the reversals are at most the events.
  const RA = require('../server/release-audit');
  const { T: T11, inputs } = require('./fixtures/release-small-programme.json');
  const { model } = RA.buildModel({ ...inputs, perFund: new Map(inputs.perFund), funder: RA.prepare(inputs.funder, inputs.domains) }, T11);
  assert.ok(!model.vars.some(v => v.table === 'overdose.by_month.n'), 'no events by month in the model');
  const E = model.vars.findIndex(v => v.id === 'overdose.events'); const R = model.vars.findIndex(v => v.id === 'overdose.reversals');
  assert.ok(model.cons.some(k => !k.soft && k.op === '<=' && k.rhs === 0 && k.terms.length === 2 && k.terms.some(([i, c]) => i === R && c === 1) && k.terms.some(([i, c]) => i === E && c === -1)), 'R <= E');
  // Every family with months checks each month's true events (a count printed nowhere: it must be able to be its
  // lowest small value, and range) and events not reversed (its small values must range) over the worlds that print
  // the same (pattern-attacker.js, monthTruth); the two-month families above do too. Each family is enumerated at
  // least three events beyond the sizes checked: the check's step over one value (server/sdc.js) looks that far.
  assertNoPatternLeak('three months', pattern.months3(2, 5), 3);
  if (!THOROUGH) return;
  assertNoPatternLeak('three months', pattern.months3(3, 6), 3);
  assertNoPatternLeak('two months, reversed, fatal and neither', pattern.monthsOutcome(3, 6, false), 3);
  assertNoPatternLeak('two months, reversed, fatal and neither, community-reported', pattern.monthsOutcome(2, 5), 3);
  assertNoPatternLeak('two months, one or two doses a reversal', pattern.monthsDoses(3, 6), 3);
  // At the default threshold: two months with 24 events between them (printed, so every world behind such a
  // printout is in the family), every split of the events and of the reversals.
  const all = Array.from({ length: 25 }, (_, i) => i);
  const { leaks, checked } = attackAll(pattern.monthsWith(24, all), 11, { only: (p) => p.funder.overdose.events === 24 });
  assert.ok(checked > 0, 'two months, 24 events, T = 11: nothing published');
  assert.deepEqual(leaks, [], `two months, 24 events, T = 11: ${JSON.stringify(leaks.slice(0, 6), null, 1)}`);
});
