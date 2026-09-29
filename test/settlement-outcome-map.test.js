'use strict';
// The outcomes shown for each opioid settlement category (server/settlement-outcome-map.js), and the small-cell
// protection of the settlement outcomes figures (server/settlement-outcomes.js protect), as pure functions.
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../server/constants');
const MAP = require('../server/settlement-outcome-map');
const SO = require('../server/settlement-outcomes');

test('every Exhibit E allowable use and every HIAA maps to a profile, and every profile to known indicators', () => {
  for (const u of C.SETTLEMENT_USES) assert.ok(MAP.PROFILES[MAP.BY_USE[u.code]], `${u.code} has a profile`);
  for (const h of C.SETTLEMENT_HIAA) assert.ok(MAP.PROFILES[MAP.BY_HIAA[h.code]], `${h.code} has a profile`);
  for (const [k, p] of Object.entries(MAP.PROFILES)) for (const i of p.indicators) assert.ok(MAP.INDICATORS[i], `${k}: ${i} is an indicator`);
  for (const [k, i] of Object.entries(MAP.INDICATORS)) {
    assert.ok(['count', 'event', 'person'].includes(i.kind), `${k} has a kind`);
    if (i.cost) assert.ok(i.unit, `${k}: a cost per needs a unit to say what it is per`);
  }
});

test('the mapping says what each kind of spending is measured by', () => {
  assert.deepEqual(MAP.indicatorsFor('core_a', null), ['naloxone_kits', 'reversals', 'contacts'], 'naloxone spending: kits distributed and reversals reported');
  assert.equal(MAP.profileFor('core_h', null), 'harm_reduction'); assert.equal(MAP.profileFor('approved_h', null), 'harm_reduction');
  for (const u of ['core_b', 'approved_a']) assert.ok(MAP.indicatorsFor(u, null).includes('people_linked') && MAP.indicatorsFor(u, null).includes('people_served'), `${u}: treatment spending is measured by people served and linked`);
  for (const u of ['core_e', 'approved_b', 'approved_c']) assert.ok(MAP.indicatorsFor(u, null).includes('referrals_made'), `${u}: connections to care count referrals`);
  assert.equal(MAP.indicatorsFor('approved_k', null)[0], 'people_trained', 'training spending: people trained first');
  for (const u of ['approved_j', 'core_i', 'approved_l', 'none']) assert.deepEqual(MAP.indicatorsFor(u, null), [], `${u}: nothing SUDS records measures it`);
  // No allowable use recorded: the HIAA decides; neither: nothing.
  assert.equal(MAP.profileFor(null, 'hiaa_6'), 'naloxone');
  assert.equal(MAP.profileFor(null, 'hiaa_4'), 'harm_reduction');
  assert.equal(MAP.profileFor('core_b', 'hiaa_6'), 'treatment', 'the allowable use wins over the HIAA');
  assert.equal(MAP.profileFor(null, null), 'none');
  assert.equal(MAP.profileFor('made_up', null), 'none');
});

test('cost per outcome: to the cent, and never beside a hidden or zero figure', () => {
  assert.equal(MAP.costPer(1200, 24), 50);
  assert.equal(MAP.costPer(1000, 3), 333.33);
  assert.equal(MAP.costPer(1000, 0), null);
  assert.equal(MAP.costPer(0, 12), null, 'nothing spent: no cost per');
  assert.equal(MAP.costPer(1000, '<11'), null, 'dividing exact money by a hidden count would give it away');
  assert.equal(MAP.costPer(1000, 'suppressed'), null);
  assert.equal(MAP.costPer(1000, 'withheld'), null);
});

test('monthsOf lists every month of the period, across a year end', () => {
  assert.deepEqual(SO.monthsOf('2025-11-15', '2026-02-03'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(SO.monthsOf('2026-03-01', '2026-03-31'), ['2026-03']);
});

// ---- small cells in protect() ----
const zero = () => Object.fromEntries(Object.keys(MAP.INDICATORS).map(k => [k, 0]));
function raw({ funds, total, months = ['2026-03', '2026-04'] }) {
  return {
    from: '2026-03-01', to: '2026-04-30', months,
    funds: funds.map((f, i) => ({ id: `f${i}`, name: f.name, category: f.use, indicators: MAP.indicatorsFor(f.use, null), spend: { own_category: f.spend || 0, other_categories: 0, approved: f.spend || 0, pending: 0 },
      values: { ...zero(), ...f.values }, months: months.map((m, j) => ({ month: m, spend: 0, values: { ...zero(), ...(f.months ? f.months[j] : {}) } })) })),
    categories: funds.map((f) => ({ key: f.use, indicators: MAP.indicatorsFor(f.use, null), spend_own_category: f.spend || 0, funds: [f.name], values: { ...zero(), ...f.values } })),
    total: { spend: { approved: 0, pending: 0 }, values: { ...zero(), ...total }, months: months.map(m => ({ month: m, spend: 0, values: zero() })) },
  };
}
const PEOPLE = Object.keys(MAP.INDICATORS).filter(k => MAP.INDICATORS[k].kind !== 'count');
const small = (v) => typeof v === 'number' && v > 0 && v < 11;
function noSmall(d) {
  const cells = [d.total.values, ...d.categories.map(c => c.values), ...d.funds.map(f => f.values), ...d.funds.flatMap(f => f.months.map(m => m.values)), ...d.total.months.map(m => m.values)];
  for (const v of cells) for (const k of PEOPLE) assert.ok(!small(v[k]), `${k} = ${v[k]} is a small count of people shown`);
}

test('protect: small counts of people are hidden, kits stay exact, and no cost per sits beside a hidden count', () => {
  const r = raw({
    funds: [
      { name: 'County', use: 'core_a', spend: 1200, values: { naloxone_kits: 24, contacts: 12, reversals: 3 }, months: [{ naloxone_kits: 16, reversals: 3 }, { naloxone_kits: 8 }] },
      { name: 'State', use: 'approved_k', spend: 900, values: { people_trained: 3, education_contacts: 3, people_served: 3 } },
      { name: 'City', use: 'approved_a', spend: 3000, values: { people_served: 40, people_linked: 20, moud_linked: 12, treatment_admissions: 15 } },
    ],
    total: { naloxone_kits: 24, contacts: 12, reversals: 3, people_trained: 3, education_contacts: 3, people_served: 43, people_linked: 20, moud_linked: 12, treatment_admissions: 15 },
  });
  const d = SO.protect(r, { threshold: 11, exact: false }, 60);
  noSmall(d);
  const [county, state, city] = d.funds;
  assert.equal(county.values.naloxone_kits, 24, 'kits are not people: exact');
  assert.equal(county.cost_per.naloxone_kits, 50, '1,200 spent for 24 kits');
  assert.equal(county.months[0].values.naloxone_kits, 16);
  assert.equal(county.values.reversals, '<11');
  assert.equal(county.cost_per.reversals, null, 'no cost per beside a hidden count');
  assert.equal(state.values.people_trained, '<11');
  assert.equal(state.cost_per.people_trained, null);
  assert.equal(state.values.education_contacts, 3, 'sessions are not people');
  assert.equal(state.cost_per.education_contacts, 300);
  assert.equal(city.values.people_linked, 20);
  assert.equal(city.cost_per.people_linked, 150);
  // A hidden month beside a visible one would give it away against the fund's total: never exactly one.
  // (A lone hidden month beside zeros is the period's own figure, hidden there too.)
  for (const f of d.funds) for (const k of PEOPLE) {
    const hidden = f.months.filter(m => typeof m.values[k] !== 'number');
    if (hidden.length === 1) assert.ok(typeof f.values[k] !== 'number' && f.months.every(m => typeof m.values[k] !== 'number' || m.values[k] === 0), `${f.name} ${k} by month`);
  }
  // Exact counts: the true figures.
  const e = SO.protect(r, { threshold: 11, exact: true }, 60);
  assert.equal(e.funds[1].values.people_trained, 3);
  assert.equal(e.funds[1].cost_per.people_trained, 300);
  assert.equal(e.funds[0].values.reversals, 3);
});

test('protect: a count one fund\'s figure would let be worked out from the total is hidden too', () => {
  // Two funds of reversals, 30 in all: one fund has 4 (hidden as "<11"), so the other's 26 would give it away.
  const r = raw({
    funds: [{ name: 'A', use: 'core_a', values: { reversals: 4 } }, { name: 'B', use: 'approved_h', values: { reversals: 26 } }],
    total: { reversals: 30 },
  });
  const d = SO.protect(r, { threshold: 11, exact: false }, 0);
  assert.equal(d.funds[0].values.reversals, '<11');
  assert.ok(typeof d.funds[1].values.reversals !== 'number' || typeof d.total.values.reversals !== 'number', 'B or the total is hidden as well');
  noSmall(d);
});
