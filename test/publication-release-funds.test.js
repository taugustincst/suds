'use strict';
// Small funds combined in "Other funds (n combined)" (1.13.1), against the algorithm-aware attacker
// (test/fixtures/pattern-attacker.js): every world of a family of two small funds, through the real release,
// grouped by printout. A file of its own so that its families, the largest of which takes minutes in the
// thorough run, run beside test/publication-release.test.js rather than after it. SUDS_THOROUGH=1 runs every
// family at T = 3 and two at T = 5; the default run, the family whose settlement report prints the most.
// docs/HIPAA.md "Small funds, combined"; docs/architecture/ADR-0009-publication-release.md.
const THOROUGH = process.env.SUDS_THOROUGH === '1';
const { test } = require('node:test');
const assert = require('node:assert');
const { pattern } = require('./fixtures/release-worlds');
const { attackAll } = require('./fixtures/pattern-attacker');
const PR = require('../server/publication-release');

function assertNoPatternLeak(name, worlds, T, residual = null) {
  const all = attackAll(worlds, T, { limit: 200 });
  const leaks = all.leaks.filter(l => !(residual && l.status === 'derived' && residual.test(l.cell)));
  assert.ok(all.checked > 0, `${name}: nothing published`);
  assert.deepEqual(leaks, [], `${name}, T=${T}: ${JSON.stringify(leaks.slice(0, 6), null, 1)}`);
}

// Not settlement funds, one of each, funds of two allowable uses, and both funds of one use, whose people and
// services the settlement report prints.
const families = THOROUGH
  ? [[3, [null, null]], [3, ['u1', 'u1']], [3, ['u1', null]], [3, ['u1', 'u2']], [5, [null, null]], [5, ['u1', 'u1']]]
  : [[3, ['u1', 'u1']]];
for (const [T, uses] of families) {
  test(`algorithm-aware attacker: two small funds combined (${uses.map(u => u || 'no settlement use').join(', ')}) at T = ${T}`, () => {
    // The use's services are printed. In a family where every person has one visit per fund they would count
    // the people, which no reader knows, and at T = 5 the attacker "found" the funds from them (combined or
    // listed alike): there the family gives some visits beyond one a person (0 to T; up to 1 in the worlds
    // whose printouts are checked), and is enumerated a size less far to stay in time. (Enumerated less far
    // still - services beyond one a person up to 2 or 3, or people up to 2T-2 - the worlds at the edge of the
    // family print what only they could, and the attacker "finds" what the family's own bounds say.)
    const oneUse = uses[0] === 'u1' && uses[1] === 'u1' && T === 5;
    const worlds = pattern.combinedFunds(T + 1, oneUse ? 2 * T - 1 : 2 * T, T, uses, 0, oneUse ? [1, T] : [0, 0]);
    assert.ok(worlds.some(w => w.inner && w.combined.length === 2 && !PR.protectFigures(w.inputs, T).refused), `${uses}: two funds combined and published`);
    // The people not under that use (people served minus the use's), a count printed nowhere, is pinned by what
    // the method does in a few printouts at T = 5 - with the funds combined or listed (as 1.13.0 listed them)
    // alike. Counts printed nowhere are held to the rule against the printout only (docs/HIPAA.md, residual
    // risks); every fund's own people, and every cell, are protected.
    assertNoPatternLeak(`two small funds combined, ${uses}`, worlds, T, oneUse ? /^use\.u1\.people:rest$/ : null);
  });
}
