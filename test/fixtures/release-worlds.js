'use strict';
// Programmes as records, and their figures computed the way the reports count them, for the publication-release
// tests (test/publication-release.test.js): the property tests' programmes, and the small families of worlds the
// algorithm-aware attacker enumerates (test/fixtures/pattern-attacker.js).
const C = require('../../server/constants');

const count = (people, f) => { const m = new Map(); for (const p of people) for (const k of [].concat(f(p))) m.set(k, (m.get(k) || 0) + 1); return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => (b.n - a.n) || String(a.k).localeCompare(String(b.k))); };
const QUARTER = ['2025-01', '2025-02', '2025-03'];
const lastDay = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
/**
 * A programme's figures, computed from its records the way the reports count them. people: [{ gender, ...,
 * visits: { fundId|null: services } }]; anon: { fundId|null: services with no client }; events: [{ month,
 * reversed, fatal, community, by, doses }]; discharges: [reason] (episodes opened before the period, closed
 * in it); episodes: [{ opened: 'before'|'in', state: 'closed'|'open', reason }]; funds: [{ id, use (null: not
 * settlement), active }]; period: the months of the period (the release lists every one). fold: { T, keep }
 * to combine the small funds of the fund table beyond the first `keep` as a publication release does
 * (server/funder-report.js foldFunds; the server keeps FOLD_KEEP, the tests fewer so that small families fold).
 */
function figuresOf({ people, anon = {}, events = [], discharges = [], episodes = [], funds, period = QUARTER, fold = null }) {
  const eps = [...discharges.map(reason => ({ opened: 'before', state: 'closed', reason })), ...episodes];
  const closed = eps.filter(e => e.state === 'closed');
  const doses = (e) => (e.doses !== undefined ? e.doses : e.reversed ? 1 : 0);
  const perFund = new Map();
  for (const f of [...funds.map(x => x.id), null]) {
    const services = people.reduce((a, p) => a + (p.visits[f] || 0), 0) + (anon[f] || 0);
    const clients = people.filter(p => p.visits[f]).length;
    if (services) perFund.set(f, { services, clients_served: clients });
  }
  const months = [...new Set(events.map(e => e.month))].sort();
  const raw = {
    unduplicated: { served: people.length, new_admissions: 0, with_a_referral: people.filter(p => p.referred).length, admitted_after_referral: people.filter(p => p.admitted).length, on_mat: people.filter(p => p.mat).length },
    demographics: { by_gender: count(people, p => p.gender), by_language: count(people, p => p.language), by_housing: count(people, p => p.housing), by_insurance: count(people, p => p.insurance), by_ethnicity: count(people, p => p.ethnicity), by_race_code: count(people, p => (p.race.length ? p.race : ['unknown'])) },
    episodes: { admissions: eps.filter(e => e.opened === 'in').length, discharges: closed.length, open_at_end: eps.filter(e => e.state === 'open').length, by_discharge_reason: count(closed.map(e => ({ k: e.reason })), x => x.k), median_length_of_stay_days: null },
    overdose: { events: events.length, reversals: events.filter(e => e.reversed).length, fatal: events.filter(e => e.fatal).length, community_reported: events.filter(e => e.community).length, naloxone_doses: events.reduce((a, e) => a + doses(e), 0),
      by_month: months.map(m => ({ month: m, n: events.filter(e => e.month === m).length, reversals: events.filter(e => e.month === m && e.reversed).length, reversal_doses: events.filter(e => e.month === m && e.reversed).reduce((a, e) => a + doses(e), 0) })),
      by_administered_by: count(events.filter(e => e.reversed), e => e.by) },
    naloxone_distribution: { kits: 0, strips: 0, community_kits: 0 },
    by_funding_source: [...funds.filter(f => f.active).map(f => ({ id: f.id, name: f.id, ...(perFund.get(f.id) || { services: 0, clients_served: 0 }) })), { id: null, name: 'No funding source', ...(perFund.get(null) || { services: 0, clients_served: 0 }) }]
      .map(f => ({ ...f, approved_minutes: 0, unapproved_minutes: 0 })),
    attribution: { unattributed_services: perFund.get(null)?.services || 0, unattributed_clients: perFund.get(null)?.clients_served || 0, approved_minutes: 0, unapproved_minutes: 0 },
  };
  const uses = [...new Set(funds.filter(f => f.use).map(f => f.use))].sort();
  const services_by_use = uses.map(u => {
    const ids = funds.filter(f => f.use === u).map(f => f.id);
    return { use_code: u, services: ids.reduce((a, id) => a + (perFund.get(id)?.services || 0), 0), people: people.filter(p => ids.some(id => p.visits[id])).length, naloxone_kits: 0 };
  }).filter(x => x.services > 0);
  const settlement = { services_by_use, fundKeys: funds.filter(f => f.use).map(f => ({ id: f.id, key: f.use, active: f.active })) };
  const inactiveFunds = Object.fromEntries(funds.filter(f => !f.active).map(f => [f.id, { people: perFund.get(f.id)?.clients_served || 0, services: perFund.get(f.id)?.services || 0 }]));
  const domains = { months: period, administered_by: C.ADMINISTERED_BY, discharge_reasons: C.DISCHARGE_REASONS };
  // Every fund's true people and services (the combined ones are not in the fund table).
  const fundTruth = Object.fromEntries(funds.map(f => [f.id, { people: perFund.get(f.id)?.clients_served || 0, services: perFund.get(f.id)?.services || 0 }]));
  let combined = [];
  if (fold) {
    const FR = require('../../server/funder-report');
    const rows = raw.by_funding_source.filter(f => f.id !== null).map(f => ({ ...f, group: funds.find(x => x.id === f.id).use || null }));
    const unionOf = (ids) => people.filter(p => ids.some(id => p.visits[id])).length;
    const folded = FR.foldFunds(rows, fold.T, unionOf, { keep: fold.keep });
    if (folded) {
      raw.by_funding_source = [...folded.rows.map(({ group, ...f }) => f), raw.by_funding_source.find(f => f.id === null)];
      raw.fund_fold = folded.fold; combined = folded.fold.members;
    }
  }
  return { inputs: { funder: raw, perFund, settlement, domains }, inactiveFunds, fundTruth, combined, funds, range: { from: `${period[0]}-01`, to: lastDay(period[period.length - 1]) } };
}

const person = (over = {}) => ({ gender: 'm', language: 'en', housing: 'u', insurance: 'a', ethnicity: 'u', race: [], visits: { C: 1 }, ...over });
/** A person served with no service charged to any fund (seen on a call, say): who is served under which fund is
 * not known from the other tables, and a family where everyone is would tell its attacker more than a reader
 * knows. */
const plain = (over = {}) => person({ visits: {}, ...over });
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
/** [label, spec, size] -> { label, inputs, inner }: inner when its size is at most `inner`. */
const worldsOf = (list, inner = Infinity) => list.map(([label, spec, size]) => ({ label, inner: size <= inner, inputs: figuresOf({ funds: [], ...spec }).inputs }));

/**
 * Small families of worlds, each every programme of its shape up to a size (`outer`): what an attacker who
 * knows the structure (the period, the lists, the funds) has to consider. The printouts of the worlds up to
 * `inner` are the ones checked; the rest are there so that their worlds are not cut off at the edge.
 * Each returns [{ label, inputs, inner }].
 */
const pattern = {
  // People served N and a subset (on MAT, or referred): the reviewer's "12 beside <11 means exactly 1".
  subset: (inner, outer, attr) => {
    const out = [];
    for (let n = 1; n <= outer; n++) for (let k = 0; k <= n; k++) out.push([`N=${n} ${attr}=${k}`, { people: many(n, i => plain({ [attr]: i < k })) }, n]);
    return worldsOf(out, inner);
  },
  // Women, men and MAT: the withheld-table shapes ("served <11" with MAT and gender withheld said N >= 2;
  // with MAT "<11" too it said everyone served was on MAT).
  genderMat: (inner, outer) => {
    const out = [];
    for (let f = 0; f <= outer; f++) for (let m = 0; f + m <= outer; m++) for (let k = 0; k <= f + m; k++) {
      if (!(f + m)) continue;
      out.push([`f=${f} m=${m} mat=${k}`, { people: [...many(f, () => plain({ gender: 'f' })), ...many(m, () => plain())].map((x, i) => ({ ...x, mat: i < k })) }, f + m]);
    }
    return worldsOf(out, inner);
  },
  // Overdose events and reversals in one month (the reviewer's "events 12, reversals <11" meaning exactly 1).
  events: (inner, outer, served) => {
    const out = [];
    for (let e = 0; e <= outer; e++) for (let r = 0; r <= e; r++) out.push([`E=${e} R=${r}`, { period: ['2025-01'], people: many(served, () => plain()), events: many(e, i => ({ month: '2025-01', reversed: i < r, by: 'staff', doses: i < r ? 1 : 0 })) }, e]);
    return worldsOf(out, inner);
  },
  // Two months, events and reversals in each.
  months: (inner, outer) => {
    const out = []; const ev = (month, n, r) => many(n, i => ({ month, reversed: i < r, by: 'staff', doses: i < r ? 1 : 0 }));
    for (let a = 0; a <= outer; a++) for (let b = 0; a + b <= outer; b++) for (let ra = 0; ra <= a; ra++) for (let rb = 0; rb <= b; rb++) out.push([`E=${a}+${b} R=${ra}+${rb}`, { period: ['2025-01', '2025-02'], people: many(30, () => plain()), events: [...ev('2025-01', a, ra), ...ev('2025-02', b, rb)] }, a + b]);
    return worldsOf(out, inner);
  },
  // Two months with exactly `events` events between them (printed, so every world of the family has it), every
  // split of them and of their reversals whose total is in `inner` (checked) or `outer` (enumerated beside them,
  // so that a printout that hides the reversals is not cut off): the engineering reviewer's case for the rule of
  // 1.16.1 (T = 3, 36 events = 12T), in which the attacker found six printouts that leaked.
  monthsWith: (events, inner, outer = []) => {
    const out = []; const ev = (month, n, r) => many(n, i => ({ month, reversed: i < r, by: 'staff', doses: i < r ? 1 : 0 }));
    for (let a = 0; a <= events; a++) for (let ra = 0; ra <= a; ra++) for (let rb = 0; rb <= events - a; rb++) {
      if (!inner.includes(ra + rb) && !outer.includes(ra + rb)) continue;
      out.push([`E=${a}+${events - a} R=${ra}+${rb}`, { period: ['2025-01', '2025-02'], people: many(30, () => plain()), events: [...ev('2025-01', a, ra), ...ev('2025-02', events - a, rb)] }, inner.includes(ra + rb) ? 0 : 1]);
    }
    return worldsOf(out, 0);
  },
  // Race codes, a cover (a person may report several, so the codes add up to at least the people served): people
  // with code a alone, b alone, both, and none reported ("unknown"). Every set of codes a person can have is in
  // the family, so it tells its attacker no more than a reader knows (a is at most the people served, a, b and
  // unknown together at least, unknown and a at most, ...). A small code beside a large one is pinned from below
  // unless another is hidden, and hiding it only when it pins would say so (1.12.4 refused such quarters).
  race: (inner, outer) => {
    const out = [];
    for (let a = 0; a <= outer; a++) for (let b = 0; a + b <= outer; b++) for (let ab = 0; a + b + ab <= outer; ab++) for (let u = 0; a + b + ab + u <= outer; u++) {
      if (!(a + b + ab + u)) continue;
      out.push([`a=${a} b=${b} ab=${ab} none=${u}`, { people: [...many(a, () => plain({ race: ['a'] })), ...many(b, () => plain({ race: ['b'] })), ...many(ab, () => plain({ race: ['a', 'b'] })), ...many(u, () => plain())] }, a + b + ab + u]);
    }
    return worldsOf(out, inner);
  },
  // Two funds that a release combines when they are small (fold: nothing kept, so both are combined when both
  // are under T, one alone when only it is): people under A only, B only, both, and neither. uses: the
  // settlement allowable use of each fund (null: not a settlement fund), whose people and services the
  // settlement report prints. Services are not one per person: a reader does not know how many visits each
  // person had, so a family where every person had one would tell its attacker the people from the services
  // printed for a use. extra: [inner, outer] services beyond one a person, charged to A with no client (as
  // community distribution is), so that the services printed do not count the people: 0 to outer in the
  // family, 0 to inner in the worlds whose printouts are checked.
  combinedFunds: (inner, outer, T, uses = [null, null], keep = 0, extra = [0, 0]) => {
    const out = [];
    const funds = [{ id: 'A', use: uses[0], active: true }, { id: 'B', use: uses[1], active: true }];
    for (let a = 0; a <= outer; a++) for (let b = 0; a + b <= outer; b++) for (let ab = 0; a + b + ab <= outer; ab++) for (let c = 0; a + b + ab + c <= outer; c++) for (let e = 0; e <= extra[1]; e++) {
      if (!(a + b + ab + c)) continue;
      const spec = { funds, fold: { T, keep }, anon: e ? { A: e } : {}, people: [...many(a, () => plain({ visits: { A: 1 } })), ...many(b, () => plain({ visits: { B: 1 } })), ...many(ab, () => plain({ visits: { A: 1, B: 1 } })), ...many(c, () => plain())] };
      const prog = figuresOf(spec);
      out.push({ label: `A=${a} B=${b} AB=${ab} none=${c} extra=${e}`, inner: a + b + ab + c <= inner && e <= extra[0], inputs: prog.inputs, fundTruth: prog.fundTruth, combined: prog.combined });
    }
    return out;
  },
  // Two funds: people under A only, B only, both, and neither.
  funds: (inner, outer) => {
    const out = [];
    for (let a = 0; a <= outer; a++) for (let b = 0; a + b <= outer; b++) for (let ab = 0; a + b + ab <= outer; ab++) for (let c = 0; a + b + ab + c <= outer; c++) {
      if (!(a + b + ab + c)) continue;
      out.push([`A=${a} B=${b} AB=${ab} none=${c}`, { funds: [{ id: 'A', use: null, active: true }, { id: 'B', use: null, active: true }], people: [...many(a, () => plain({ visits: { A: 1 } })), ...many(b, () => plain({ visits: { B: 1 } })), ...many(ab, () => plain({ visits: { A: 1, B: 1 } })), ...many(c, () => plain())] }, a + b + ab + c]);
    }
    return worldsOf(out, inner);
  },
};

module.exports = { figuresOf, QUARTER, lastDay, person, plain, many, worldsOf, pattern };
