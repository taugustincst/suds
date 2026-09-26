'use strict';
// An independent attacker on a publication release (test/publication-release.test.js). It reads the three
// reports as they are published - the funder report, the NDP log by month and the opioid settlement report -
// writes down on its own what they say (a number, "<T" = 1..T-1, "suppressed" = at least T for a count of
// people, "withheld" = unknown) and what anyone knows about how the figures relate, and then, for every
// hidden or unprinted count of people, works out exactly which values are still possible.
//
// It shares no code with the engine it attacks (server/sdc.js solves linear programs by branch and bound);
// this is a finite-domain search with bounds propagation: every variable gets a domain [lo, hi] (capped at a
// value well above anything in the data, which only makes the attacker stronger), constraints tighten the
// domains to a fixpoint, and a depth-first search splits the smallest domain in two.

/** Integer linear constraints over bounded domains: is there a solution, and which values can x take? */
function makeSolver(lo0, hi0, cons) {
  const n = lo0.length;
  const byVar = Array.from({ length: n }, () => []);
  cons.forEach((k, ci) => k.terms.forEach(([i]) => byVar[i].push(ci)));
  // Tighten domains until nothing changes; false when a domain empties.
  function propagate(lo, hi, dirty) {
    const queue = dirty ? [...dirty] : cons.map((_, i) => i); const inQ = new Set(queue);
    while (queue.length) {
      const ci = queue.shift(); inQ.delete(ci); const k = cons[ci];
      let mn = 0; let mx = 0;
      for (const [i, c] of k.terms) { if (c > 0) { mn += c * lo[i]; mx += c * hi[i]; } else { mn += c * hi[i]; mx += c * lo[i]; } }
      const le = k.op === '<=' || k.op === '='; const ge = k.op === '>=' || k.op === '=';
      if ((le && mn > k.rhs) || (ge && mx < k.rhs)) return false;
      for (const [i, c] of k.terms) {
        const own = c > 0 ? [c * lo[i], c * hi[i]] : [c * hi[i], c * lo[i]];
        let nlo = lo[i]; let nhi = hi[i];
        if (le) { const cap = k.rhs - (mn - own[0]); if (c > 0) nhi = Math.min(nhi, Math.floor(cap / c)); else nlo = Math.max(nlo, Math.ceil(cap / c)); }
        if (ge) { const floor = k.rhs - (mx - own[1]); if (c > 0) nlo = Math.max(nlo, Math.ceil(floor / c)); else nhi = Math.min(nhi, Math.floor(floor / c)); }
        if (nlo > nhi) return false;
        if (nlo !== lo[i] || nhi !== hi[i]) {
          lo[i] = nlo; hi[i] = nhi;
          for (const cj of byVar[i]) if (!inQ.has(cj)) { inQ.add(cj); queue.push(cj); }
        }
      }
    }
    return true;
  }
  let nodes = 0;
  function solve(lo, hi, dirty) {
    if (++nodes > 2e6) throw new Error('attacker search too large');
    if (!propagate(lo, hi, dirty)) return null;
    let pick = -1;
    for (let i = 0; i < n; i++) if (lo[i] < hi[i] && (pick < 0 || hi[i] - lo[i] < hi[pick] - lo[pick])) pick = i;
    if (pick < 0) return lo.slice();
    const mid = Math.floor((lo[pick] + hi[pick]) / 2);
    const a = [lo.slice(), hi.slice()]; a[1][pick] = mid;
    const r = solve(a[0], a[1], byVar[pick]); if (r) return r;
    const b = [lo.slice(), hi.slice()]; b[0][pick] = mid + 1;
    return solve(b[0], b[1], byVar[pick]);
  }
  const seen = Array.from({ length: n }, () => new Set());
  const record = (x) => x.forEach((v, i) => seen[i].add(v));
  const root = [lo0.slice(), hi0.slice()];
  if (!propagate(root[0], root[1])) throw new Error('the published release is inconsistent with the attacker model');
  return {
    lo: root[0], hi: root[1],
    /** Can x_i equal v? */
    can(i, v) {
      if (seen[i].has(v)) return true;
      if (v < root[0][i] || v > root[1][i]) return false;
      const lo = root[0].slice(); const hi = root[1].slice(); lo[i] = v; hi[i] = v;
      const x = solve(lo, hi, byVar[i]); if (x) record(x); return !!x;
    },
    /** The smallest and largest values x_i can take. */
    range(i) {
      let a = root[0][i]; while (a <= root[1][i] && !this.can(i, a)) a++;
      let b = root[1][i]; while (b >= a && !this.can(i, b)) b--;
      return [a, b];
    },
  };
}

const isNum = (v) => typeof v === 'number';

/**
 * The attacker's model of a release. pub: { funder, settlement, ndp } as published; truth: the same figures
 * exact ({ funder, settlement } from exact runs). Returns { solver, vars: [{ name, shown, truth, people }], derived }.
 */
function modelOf(pub, truth, T) {
  const vars = []; const byName = new Map(); const cons = [];
  const tf = truth.funder;
  // Every true value, by name, so the checks know which unprinted counts are small.
  const tv = new Map();
  tv.set('N', tf.unduplicated.served);
  for (const k of ['on_mat', 'with_a_referral', 'admitted_after_referral']) tv.set(k, tf.unduplicated[k]);
  for (const k of ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity', 'by_race_code']) for (const x of tf.demographics[k]) tv.set(`${k}:${x.k}`, x.n);
  for (const f of tf.by_funding_source) { tv.set(`fund:${f.id}:p`, f.clients_served); tv.set(`fund:${f.id}:s`, f.services); }
  for (const x of truth.settlement.services_by_use) { tv.set(`use:${x.use_code}:p`, x.people); tv.set(`use:${x.use_code}:s`, x.services); }
  for (const [id, x] of Object.entries(truth.inactiveFunds || {})) { tv.set(`fund:${id}:p`, x.people); tv.set(`fund:${id}:s`, x.services); }
  const od = tf.overdose;
  tv.set('E', od.events); tv.set('R', od.reversals); tv.set('F', od.fatal); tv.set('C', od.community_reported);
  for (const m of od.by_month) { tv.set(`n:${m.month}`, m.n); tv.set(`r:${m.month}`, m.reversals); }
  for (const x of od.by_administered_by) tv.set(`by:${x.k}`, x.n);
  tv.set('D', tf.episodes.discharges); for (const x of tf.episodes.by_discharge_reason) tv.set(`dis:${x.k}`, x.n);
  const CAP = Math.max(0, ...tv.values()) + 3 * T + 2;

  // A variable, and what a published symbol says about it (read again, from another report: both hold).
  const V = (name, shown, people = true) => {
    let i = byName.get(name);
    if (i === undefined) { i = vars.length; byName.set(name, i); vars.push({ name, shown: [], truth: tv.get(name), people, lo: 0, hi: CAP }); }
    const x = vars[i];
    if (shown !== undefined) {
      x.shown.push(shown);
      const [a, b] = isNum(shown) ? [shown, shown] : shown === `<${T}` ? [1, T - 1] : shown === 'suppressed' ? [people ? T : 0, CAP] : [0, CAP];
      x.lo = Math.max(x.lo, a); x.hi = Math.min(x.hi, b);
    }
    return i;
  };
  const add = (terms, op, rhs = 0) => cons.push({ terms, op, rhs });
  const derived = [];
  const rest = (name, i) => derived.push({ name: `${name} (rest)`, terms: [[V('N'), 1], [i, -1]] });

  // ---- the funder report ----
  const f = pub.funder;
  const N = V('N', f.unduplicated.served);
  for (const k of ['on_mat', 'with_a_referral', 'admitted_after_referral']) { const i = V(k, f.unduplicated[k]); add([[i, 1], [N, -1]], '<='); rest(k, i); }
  // Each single-valued breakdown adds up to the people served (a withheld one is printed as no rows: its
  // cells are unknown, but still add up).
  for (const k of ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity']) {
    const rows = f.demographics[k].length ? f.demographics[k] : tf.demographics[k].map(x => ({ k: x.k, n: 'withheld' }));
    add([...rows.map(x => [V(`${k}:${x.k}`, x.n), 1]), [N, -1]], '=');
  }
  const race = f.demographics.by_race_code.length ? f.demographics.by_race_code : tf.demographics.by_race_code.map(x => ({ k: x.k, n: 'withheld' }));
  const ri = race.map(x => V(`by_race_code:${x.k}`, x.n));
  ri.forEach((i, j) => { add([[i, 1], [N, -1]], '<='); rest(`race ${race[j].k}`, i); });
  if (ri.length) add([...ri.map(i => [i, 1]), [N, -1]], '>=');
  const unk = race.findIndex(x => x.k === 'unknown');
  if (unk >= 0) ri.forEach((i, j) => { if (j !== unk) add([[i, 1], [ri[unk], 1], [N, -1]], '<='); });
  for (const r of f.by_funding_source) {
    const p = V(`fund:${r.id}:p`, r.clients_served); const s = V(`fund:${r.id}:s`, r.services, false);
    add([[p, 1], [N, -1]], '<='); add([[p, 1], [s, -1]], '<='); rest(`fund ${r.name}`, p);
  }
  const E = V('E', f.overdose.events); const R = V('R', f.overdose.reversals); const F = V('F', f.overdose.fatal); const C = V('C', f.overdose.community_reported);
  add([...f.overdose.by_month.map(m => [V(`n:${m.month}`, m.n), 1]), [E, -1]], '=');
  add([...f.overdose.by_month.map(m => [V(`r:${m.month}`, m.reversals), 1]), [R, -1]], '=');
  for (const m of f.overdose.by_month) {
    add([[V(`r:${m.month}`), 1], [V(`n:${m.month}`), -1]], '<=');
    derived.push({ name: `${m.month} not reversed`, terms: [[V(`n:${m.month}`), 1], [V(`r:${m.month}`), -1]] });
  }
  add([...f.overdose.by_administered_by.map(x => [V(`by:${x.k}`, x.n), 1]), [R, -1]], '=');
  add([[F, 1], [E, -1]], '<='); add([[C, 1], [E, -1]], '<=');
  // Fatal and reversed events are distinct for everything recorded through SUDS (not for every imported row).
  if (od.fatal + od.reversals <= od.events) add([[F, 1], [R, 1], [E, -1]], '<=');
  derived.push({ name: 'E-R', terms: [[E, 1], [R, -1]] }, { name: 'E-F', terms: [[E, 1], [F, -1]] }, { name: 'E-C', terms: [[E, 1], [C, -1]] }, { name: 'E-R-F', terms: [[E, 1], [R, -1], [F, -1]] });
  const D = V('D', f.episodes.discharges);
  add([...f.episodes.by_discharge_reason.map(x => [V(`dis:${x.k}`, x.n), 1]), [D, -1]], '=');

  // ---- the NDP log, by month: the reversals again ----
  for (const row of pub.ndp.rows.filter(x => x.entry === 'reversal')) V(`r:${row.date}`, row.reversals);
  V('R', pub.ndp.totals.reversals);

  // ---- the settlement report ----
  const listed = new Set(f.by_funding_source.map(r => r.id));
  const byUse = new Map();
  for (const fund of pub.settlement.funds) {
    const key = fund.settlement_use || 'uncategorised';
    if (!listed.has(fund.id)) { const p = V(`fund:${fund.id}:p`); const s = V(`fund:${fund.id}:s`, undefined, false); add([[p, 1], [N, -1]], '<='); add([[p, 1], [s, -1]], '<='); }
    if (!byUse.has(key)) byUse.set(key, []);
    byUse.get(key).push(fund.id);
  }
  for (const x of pub.settlement.services_by_use) {
    const p = V(`use:${x.use_code}:p`, x.people); const s = V(`use:${x.use_code}:s`, x.services, false);
    add([[p, 1], [N, -1]], '<='); add([[p, 1], [s, -1]], '<='); rest(`use ${x.use_code}`, p);
    const ids = byUse.get(x.use_code) || [];
    add([[s, 1], ...ids.map(id => [V(`fund:${id}:s`), -1])], '=');
    add([[p, 1], ...ids.map(id => [V(`fund:${id}:p`), -1])], '<=');
    for (const id of ids) { add([[p, 1], [V(`fund:${id}:p`), -1]], '>='); derived.push({ name: `use ${x.use_code} not under ${id}`, terms: [[p, 1], [V(`fund:${id}:p`), -1]] }); }
  }
  // A use with no row served nobody: its funds served nobody either.
  for (const [key, ids] of byUse) if (!pub.settlement.services_by_use.some(x => x.use_code === key)) for (const id of ids) { add([[V(`fund:${id}:p`), 1]], '=', 0); add([[V(`fund:${id}:s`), 1]], '=', 0); }

  // Derived counts become variables tied to their definition.
  for (const d of derived) {
    const i = vars.length; vars.push({ name: d.name, shown: [], truth: d.terms.reduce((a, [j, c]) => a + c * vars[j].truth, 0), people: true, derived: true, lo: -CAP * 3, hi: CAP * 3 });
    add([[i, 1], ...d.terms.map(([j, c]) => [j, -c])], '=');
  }
  const solver = makeSolver(vars.map(x => x.lo), vars.map(x => x.hi), cons);
  return { solver, vars, CAP };
}

/**
 * Everything the attacker can pin more narrowly than the protection rule allows: a "<T" count (or an
 * unprinted or withheld count of people whose true value is 1..T-1) that cannot be both 1 and T-1, or a
 * "suppressed" count of people whose possible values span less than ceil(T/2).
 */
function attack(pub, truth, T) {
  const { solver, vars } = modelOf(pub, truth, T);
  const out = [];
  const P = Math.ceil(T / 2);
  vars.forEach((x, i) => {
    if (!x.people) return;
    const shown = x.shown;
    const small = shown.includes(`<${T}`) || ((x.derived || !shown.length || shown.every(s => s === 'withheld')) && x.truth > 0 && x.truth < T && !shown.some(isNum));
    if (small) {
      for (const v of [1, T - 1]) if (!solver.can(i, v)) out.push(`${x.name} (${shown.join('/') || 'unprinted'}, truly ${x.truth}) cannot be ${v}`);
    } else if (shown.includes('suppressed') && !shown.some(isNum)) {
      const [a, b] = solver.range(i);
      if (b - a < P) out.push(`${x.name} (suppressed, truly ${x.truth}) lies in [${a}, ${b}]`);
    }
  });
  return out;
}

module.exports = { makeSolver, modelOf, attack };
