'use strict';
// Statistical disclosure control for a publication release: the audit that decides what may be shown
// (docs/HIPAA.md "Small cells in aggregate reports"; server/publication-release.js builds the model).
//
// The model is what an attacker knows after reading everything one release publishes:
//   * variables: the true integer count behind every cell, hidden ones included, and a few that are printed
//     nowhere but are tied to printed ones (the people under a settlement fund that is no longer active);
//   * constraints: every additive relationship between them (a breakdown adds up to its total, a subset is
//     at most its total, the reversals in a month are at most that month's events, ...);
//   * what each cell shows: a number (an equality), "<T" (1 to T-1: zero is printed as 0), "suppressed"
//     (at least T for a count of people, since a smaller one would have been "<T"; at least 0 for a figure
//     hidden with it, such as the services of a hidden fund), "withheld" or nothing (at least 0).
//
// The protection rule (why: docs/HIPAA.md):
//   * a cell shown "<T" must be able to be 1 and T-1 - or as near them as the printout's symbols alone allow
//     (served "<T" beside women "<T" and men "<T" says there are at most T-2 women, whatever is printed);
//   * a count of people not printed but tied to printed figures (a withheld cell; the people left when a
//     fund's are taken from the total; the events in a month that were not reversals) is sensitive whenever
//     the printout lets it be from 1 to T-1 - decided from its feasible range, never from its true value -
//     and must then be able to be 1 and T-1 in the same sense;
//   * a cell hidden to protect another ("suppressed", a count of people) must keep a range at least ceil(T/2)
//     wide, so it cannot be read off.
// Checked over the INTEGER solutions. A linear-programming bound is only an outer bound: the integer range is
// contained in the LP range, so a wide LP range does not prove a wide integer range. Each question is
// answered by branch and bound over a small dense simplex (below). A search that exceeds its node budget
// answers "not protected" (the cautious direction), never "protected".
//
// Suppression (run) runs to a fixpoint: the primary rule hides every count of people from 1 to T-1 as "<T";
// a total whose every part is "<T" is hidden with the counts of at least T that are part of it; then, while
// a sensitive count is under-protected, one more cell is hidden - among the cells in the relationships that
// bind it, in a fixed structural order (nearest first, a breakdown's cells before its total, people before
// other figures, then the model's order: table order, then key order; never by value), the first that fixes
// it, else the first that helps, else the first - and the audit runs again. When nothing visible is left to
// hide, a table that binds it is withheld whole. Cells only ever go from shown to hidden, so it stops.
//
// The pattern of what is hidden is itself published, and SUDS is open source: an attacker can run this code
// on every programme that could lie behind a printout and keep those that print the same. The checks in
// run() ask only what the printout allows; consistent() then asks what the worlds that print the same
// release allow, by finding such worlds and running them through run() (docs/HIPAA.md "The pattern of what
// is hidden").
//
// The result says whether all passed (`verified`); one that is not verified - a check that could not be
// settled, nothing left to withhold, the step, search or time limit reached - must not be published
// (server/publication-release.js refuses it). Everything is deterministic: the same data give the same
// release, whichever report asks for it.
const EPS = 1e-9;
const FEAS = 1e-7;

// ---------------------------------------------------------------------------------------------------------
// A dense two-phase simplex with Bland's rule (no cycling). maximize c.x subject to rows
// { a: number[n], op: '<=' | '>=' | '=', b } and lb <= x <= ub (ub may be Infinity).
// Returns { status: 'optimal' | 'infeasible' | 'unbounded', x, value }.
function simplex(n, rows, lb, ub, c) {
  const R = [];
  for (const r of rows) {
    let b = r.b; for (let j = 0; j < n; j++) b -= r.a[j] * lb[j];
    R.push({ a: r.a.slice(), op: r.op, b });
  }
  for (let j = 0; j < n; j++) {
    if (ub[j] === Infinity) continue;
    if (ub[j] < lb[j] - FEAS) return { status: 'infeasible' };
    const a = new Array(n).fill(0); a[j] = 1; R.push({ a, op: '<=', b: ub[j] - lb[j] });
  }
  for (const r of R) if (r.b < 0) { r.a = r.a.map(x => -x); r.b = -r.b; r.op = r.op === '<=' ? '>=' : r.op === '>=' ? '<=' : '='; }
  const m = R.length;
  let nS = 0; let nA = 0;
  for (const r of R) { if (r.op !== '=') nS++; if (r.op !== '<=') nA++; }
  const W = n + nS + nA;
  const T = []; const basis = []; const isArt = new Uint8Array(W);
  let s = n; let a = n + nS;
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(W + 1); const r = R[i];
    for (let j = 0; j < n; j++) row[j] = r.a[j];
    row[W] = r.b;
    if (r.op === '<=') { row[s] = 1; basis.push(s); s++; } else if (r.op === '>=') { row[s] = -1; s++; row[a] = 1; isArt[a] = 1; basis.push(a); a++; } else { row[a] = 1; isArt[a] = 1; basis.push(a); a++; }
    T.push(row);
  }
  const pivot = (z, pi, pj) => {
    const p = T[pi]; const v = p[pj];
    for (let k = 0; k <= W; k++) p[k] /= v;
    for (let i = 0; i < m; i++) {
      if (i === pi) continue; const f = T[i][pj]; if (Math.abs(f) < EPS) continue;
      const row = T[i]; for (let k = 0; k <= W; k++) row[k] -= f * p[k];
    }
    const f = z[pj]; if (Math.abs(f) > EPS) for (let k = 0; k <= W; k++) z[k] -= f * p[k];
    basis[pi] = pj;
  };
  // z[j] = reduced cost of column j; z[W] = -(objective value).
  const phase = (d, allowed) => {
    const z = new Float64Array(W + 1);
    for (let j = 0; j < W; j++) z[j] = d[j] || 0;
    for (let i = 0; i < m; i++) { const db = d[basis[i]] || 0; if (db) for (let k = 0; k <= W; k++) z[k] -= db * T[i][k]; }
    for (let iter = 0; iter < 50000; iter++) {
      let pj = -1;
      for (let j = 0; j < W; j++) if (allowed(j) && z[j] > FEAS) { pj = j; break; }
      if (pj < 0) return { z, bounded: true };
      let pi = -1; let best = Infinity;
      for (let i = 0; i < m; i++) {
        const t = T[i][pj]; if (t <= FEAS) continue;
        const ratio = T[i][W] / t;
        if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && basis[i] < basis[pi])) { best = ratio; pi = i; }
      }
      if (pi < 0) return { z, bounded: false };
      pivot(z, pi, pj);
    }
    throw new Error('simplex did not converge');
  };
  if (nA) {
    const d = new Array(W).fill(0); for (let j = 0; j < W; j++) if (isArt[j]) d[j] = -1;
    const { z } = phase(d, () => true);
    if (-z[W] < -FEAS) return { status: 'infeasible' };
    // Drive the artificials out of the basis (a row that cannot is redundant and stays at 0).
    for (let i = 0; i < m; i++) {
      if (!isArt[basis[i]]) continue;
      for (let j = 0; j < W; j++) if (!isArt[j] && Math.abs(T[i][j]) > FEAS) { pivot(new Float64Array(W + 1), i, j); break; }
    }
  }
  const d = new Array(W).fill(0); for (let j = 0; j < n; j++) d[j] = c[j] || 0;
  const { z, bounded } = phase(d, (j) => !isArt[j]);
  if (!bounded) return { status: 'unbounded' };
  const x = lb.slice();
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] += T[i][W];
  let value = 0; for (let j = 0; j < n; j++) value += (c[j] || 0) * x[j];
  return { status: 'optimal', x, value };
}

// ---------------------------------------------------------------------------------------------------------
// Integer optimisation by branch and bound. prob: { n, rows, lb, ub }. Maximises c.x over the integer points
// (c integer, so the optimum is an integer). `known`: an integer feasible point to start from, or null.
// `enough`: stop as soon as the incumbent reaches it. Returns { value, exact, x }: x the best integer point
// found (null if none); exact false when the node budget ran out (value is then the best found, a lower bound
// on the maximum, -Infinity if none was found).
function intMax(prob, c, known, { enough = Infinity, budget = 4000, deadline = Infinity } = {}) {
  const dot = (x) => c.reduce((s, cj, j) => s + cj * x[j], 0);
  let best = known ? Math.round(dot(known)) : -Infinity;
  let bestX = known ? known.slice() : null;
  if (best >= enough) return { value: best, exact: true, x: bestX };
  const stack = [[prob.lb.slice(), prob.ub.slice()]];
  let nodes = 0;
  while (stack.length) {
    if (++nodes > budget || Date.now() > deadline) return { value: best, exact: false, x: bestX };
    const [lb, ub] = stack.pop();
    const r = simplex(prob.n, prob.rows, lb, ub, c);
    if (r.status === 'infeasible') continue;
    if (r.status === 'unbounded') return { value: Infinity, exact: true, x: null }; // only at the root: a bounded LP stays bounded when narrowed
    const bound = Math.floor(r.value + 1e-6);
    if (bound <= best) continue;
    let fj = -1;
    for (let j = 0; j < prob.n; j++) if (Math.abs(r.x[j] - Math.round(r.x[j])) > 1e-6) { fj = j; break; }
    if (fj < 0) {
      const v = Math.round(r.value);
      if (v > best) { best = v; bestX = r.x.map(Math.round); }
      if (best >= enough) return { value: best, exact: true, x: bestX };
      continue;
    }
    const f = Math.floor(r.x[fj]);
    const up = [lb.slice(), ub.slice()]; up[0][fj] = f + 1;
    const down = [lb.slice(), ub.slice()]; down[1][fj] = f;
    stack.push(up, down);
  }
  return { value: best, exact: true, x: bestX };
}
/** Is there an integer point with lo <= c.x <= hi? (Branch and bound on feasibility.) */
function intFeasibleIn(prob, c, lo, hi, { budget = 4000, deadline = Infinity } = {}) {
  const rows = lo === hi ? [...prob.rows, { a: c, op: '=', b: lo }] : [...prob.rows, { a: c, op: '>=', b: lo }, { a: c, op: '<=', b: hi }];
  const zero = new Array(prob.n).fill(0);
  const stack = [[prob.lb.slice(), prob.ub.slice()]];
  let nodes = 0;
  while (stack.length) {
    if (++nodes > budget || Date.now() > deadline) return { feasible: false, exact: false };
    const [lb, ub] = stack.pop();
    const r = simplex(prob.n, rows, lb, ub, zero);
    if (r.status !== 'optimal') { if (r.status === 'unbounded') return { feasible: true, exact: true }; continue; }
    let fj = -1;
    for (let j = 0; j < prob.n; j++) if (Math.abs(r.x[j] - Math.round(r.x[j])) > 1e-6) { fj = j; break; }
    if (fj < 0) return { feasible: true, exact: true };
    const f = Math.floor(r.x[fj]);
    const up = [lb.slice(), ub.slice()]; up[0][fj] = f + 1;
    const down = [lb.slice(), ub.slice()]; down[1][fj] = f;
    stack.push(up, down);
  }
  return { feasible: false, exact: true };
}
/** Is there an integer point with c.x = v? */
const intFeasible = (prob, c, v, opts) => intFeasibleIn(prob, c, v, v, opts);

// ---------------------------------------------------------------------------------------------------------
// The audit.
//
// model: {
//   vars: [{ id, value, people, total, table, published }]   published false: printed nowhere (no symbol)
//   cons: [{ terms: [[varIndex, coef]], op, rhs, soft }]
//   derived: [{ id, terms: [[varIndex, coef]] }]              counts of people printed nowhere
//   mirror: [[peopleIndex, figureIndex]]                        a figure hidden whenever its people cell is
// }
// status per var: 'vis' | 'pri' | 'sec' | 'withheld' | 'unpub'.
//
// run(values) is the suppression for one world (one set of true values); it is also what the attacker runs.
// Which counts must be protected is decided from their feasible range given what would be printed, never
// from their true value; candidates are taken in a fixed structural order; no search starts from a true
// value (a search's answer is then a function of the printout alone). What no such rule can avoid is that a
// decision taken while a cell was still shown read that cell, which is then hidden (served 12 beside "<11"
// on MAT is hidden, 25 is not, so a hidden one is under 21): consistent() checks the release against that.
function auditor(model, T, { budget, deadline }) {
  const { vars, derived = [], mirror = [] } = model;
  const P = Math.ceil(T / 2);
  const small = (x) => x > 0 && x < T;
  const opt = { budget, deadline };
  const tableOf = new Map(); vars.forEach((v, i) => { if (!tableOf.has(v.table)) tableOf.set(v.table, []); tableOf.get(v.table).push(i); });
  const cache = new Map(); // by the content of the question, so worlds that ask the same question share the answer

  // A relationship the data do not satisfy would make the audit wrong. One that holds for everything SUDS
  // records but not for every row an import could write (soft) is left out when it fails: an attacker who
  // assumed it would be reasoning from something false. Any other is a bug in the model.
  function relationships(values) {
    const cons = []; const dropped = [];
    model.cons.forEach((k, ci) => {
      const lhs = k.terms.reduce((s, [i, c]) => s + c * values[i], 0);
      const ok = k.op === '=' ? lhs === k.rhs : k.op === '<=' ? lhs <= k.rhs : lhs >= k.rhs;
      if (!ok && model.strict && !k.soft) throw new Error(`the truth violates ${JSON.stringify(k.terms.map(([i, c]) => [vars[i].id, c]))} ${k.op} ${k.rhs}`);
      if (ok) cons.push(k); else dropped.push(ci);
    });
    const byVar = vars.map(() => []); cons.forEach((k, ci) => { for (const [i] of k.terms) byVar[i].push(ci); });
    return { cons, byVar, sig: dropped.join(',') };
  }

  function world(values) {
    const { cons, byVar, sig } = relationships(values);
    const applyMirror = (s) => { for (const [p, f] of mirror) if ((s[p] === 'pri' || s[p] === 'sec') && s[f] === 'vis') s[f] = 'sec'; else if (s[p] === 'withheld' && s[f] === 'vis') s[f] = 'withheld'; };
    const bounds = (s, i) => {
      switch (s[i]) {
        case 'vis': return [values[i], values[i]];
        case 'pri': return [1, T - 1];
        case 'sec': return vars[i].people ? [T, Infinity] : [0, Infinity];
        default: return [0, Infinity];
      }
    };
    // The problem restricted to what can move with the quantity: the non-fixed variables reachable from it
    // through constraints, and every constraint that touches them (fixed variables become constants). With
    // all = true, every hidden variable (a whole world). Only printed values enter it.
    function problem(s, terms, all = false) {
      const idx = new Map(); const queue = [];
      const add = (i) => { if (s[i] !== 'vis' && !idx.has(i)) { idx.set(i, idx.size); queue.push(i); } };
      if (all) vars.forEach((_, i) => add(i)); else for (const [i] of terms) add(i);
      for (let q = 0; q < queue.length; q++) for (const ci of byVar[queue[q]]) for (const [j] of cons[ci].terms) add(j);
      const members = queue; const n = members.length;
      const touched = new Set(); for (const i of members) for (const ci of byVar[i]) touched.add(ci);
      const order = [...touched].sort((a, b) => a - b);
      const rhs = order.map(ci => { let b = cons[ci].rhs; for (const [j, c] of cons[ci].terms) if (!idx.has(j)) b -= c * values[j]; return b; });
      let constant = 0;
      for (const [i, co] of terms) if (!idx.has(i)) constant += co * values[i];
      const key = `${sig}|${members.map(i => i + s[i]).join(',')}|${rhs.join(',')}|${constant}`;
      let prob = null; let c = null;
      // The dense form is built only when a question is not answered from the cache.
      const build = () => {
        const rows = order.map((ci, r) => { const a = new Array(n).fill(0); for (const [j, co] of cons[ci].terms) if (idx.has(j)) a[idx.get(j)] += co; return { a, op: cons[ci].op, b: rhs[r] }; });
        prob = { n, rows, lb: members.map(i => bounds(s, i)[0]), ub: members.map(i => bounds(s, i)[1]) };
        c = new Array(n).fill(0); for (const [i, co] of terms) if (idx.has(i)) c[idx.get(i)] += co;
      };
      return { get prob() { if (!prob) build(); return prob; }, get c() { if (!c) build(); return c; }, constant, key, n, members, idx };
    }
    // Can the quantity take a value from 1 to T-1 at all, given the printout? (A search that runs out of
    // budget answers yes, the cautious direction.)
    function reaches(p) {
      if (p.n === 0) return small(p.constant);
      const r = intFeasibleIn(p.prob, p.c, 1 - p.constant, T - 1 - p.constant, opt);
      return r.feasible || !r.exact;
    }
    // The values a small count must still be able to take: 1 and T-1, or as near them as its symbols alone
    // allow. The symbols of a printout (a count of people printed as 0, as "<T", or as a number or
    // "suppressed", both at least T) say some things whatever else it prints: served "<T" beside women "<T"
    // and men "<T" says there are at most T-2 women. The release must not narrow a count further than that.
    // The range is that of the linear relaxation with every printed number replaced by its class, which
    // contains the integer range, so the targets are never nearer each other than they should be.
    const classCode = (s, i) => (s[i] === 'pri' ? 's' : s[i] === 'vis' ? (values[i] === 0 ? '0' : vars[i].people ? 'b' : 'a') : s[i] === 'sec' && vars[i].people ? 'b' : 'a');
    const classSigs = new WeakMap();
    function targets(s, q) {
      // Cached by the classes of every count (the symbols), which is all the answer depends on.
      if (!classSigs.has(s)) classSigs.set(s, vars.map((_, i) => classCode(s, i)).join(''));
      const quick = `${sig}|sym|${q.id}|${classSigs.get(s)}`;
      if (cache.has(quick)) return cache.get(quick);
      const out = targetsOf(s, q);
      cache.set(quick, out);
      return out;
    }
    function targetsOf(s, q) {
      const cls = (i) => {
        if (s[i] === 'pri') return [1, T - 1];
        if (s[i] === 'vis') return values[i] === 0 ? [0, 0] : vars[i].people ? [T, Infinity] : [0, Infinity];
        if (s[i] === 'sec' && vars[i].people) return [T, Infinity];
        return [0, Infinity];
      };
      const idx = new Map(); const queue = [];
      const add = (i) => { if (!idx.has(i)) { idx.set(i, idx.size); queue.push(i); } };
      for (const [i] of q.terms) add(i);
      for (let k = 0; k < queue.length; k++) { const [lo, hi] = cls(queue[k]); if (lo === hi) continue; for (const ci of byVar[queue[k]]) for (const [j] of cons[ci].terms) add(j); }
      const key = `${sig}|sym|${q.id}|${queue.map(i => `${i}:${cls(i).join(':')}`).join(',')}`;
      if (cache.has(key)) return cache.get(key);
      const n = queue.length;
      const touched = new Set(); for (const i of queue) { const [lo, hi] = cls(i); if (lo !== hi) for (const ci of byVar[i]) touched.add(ci); }
      const rows = [...touched].sort((a, b) => a - b).map(ci => { const a = new Array(n).fill(0); for (const [j, c] of cons[ci].terms) a[idx.get(j)] += c; return { a, op: cons[ci].op, b: cons[ci].rhs }; });
      const lb = queue.map(i => cls(i)[0]); const ub = queue.map(i => cls(i)[1]);
      const c = new Array(n).fill(0); for (const [i, co] of q.terms) c[idx.get(i)] += co;
      const hi = simplex(n, rows, lb, ub, c); const lo = simplex(n, rows, lb, ub, c.map(x => -x));
      const a = lo.status === 'optimal' ? Math.max(1, Math.ceil(-lo.value - 1e-6)) : 1;
      const b = hi.status === 'optimal' ? Math.min(T - 1, Math.floor(hi.value + 1e-6)) : T - 1;
      const out = a > b ? [] : a === b ? [a] : [a, b];
      // Whether its symbols alone let it be T or more: then the printout must not rule that out either.
      out.open = hi.status !== 'optimal' || hi.value >= T - 1e-6;
      cache.set(key, out);
      return out;
    }
    // How far a sensitive quantity is from protected: 0 when protected.
    //   pri: a "<T" cell, always sensitive: must be able to be 1 and T-1 (targets());
    //   cond: a withheld, unprinted or derived count: sensitive when the printout lets it be small at all,
    //         and then it must be able to be 1 and T-1 (targets());
    //   sec: a suppressed count of people: its feasible range must span at least P.
    function deficit(s, q) {
      const p = problem(s, q.terms);
      const t = q.kind === 'sec' ? null : targets(s, q);
      const key = `${q.id}|${q.kind}|${p.key}|${t ? `${t.join(',')}:${t.open}` : ''}`;
      if (cache.has(key)) return cache.get(key);
      let d = 0;
      if (q.kind === 'pri' || q.kind === 'cond') {
        if (q.kind === 'cond' && !reaches(p)) d = 0;
        else if (p.n === 0) d = t.filter(v => p.constant !== v).length + (q.kind === 'cond' && t.open ? 1 : 0);
        else {
          d = t.filter(v => !intFeasible(p.prob, p.c, v - p.constant, opt).feasible).length;
          // An unprinted count the symbols let be T or more, which the numbers printed beside them say is
          // under T, is shown to be small (12 served beside "<11" on MAT says the rest are 2 to 11; 11
          // served says 1 to 10). The audit hides more there too, so that hiding the total does not in turn
          // say that it is not T (see consistent()).
          if (q.kind === 'cond' && t.open && intMax(p.prob, p.c, null, { ...opt, enough: T - p.constant }).value + p.constant < T) d += 1;
        }
      } else {
        const lo = -intMax(p.prob, p.c.map(x => -x), null, opt).value + p.constant;
        const hi = intMax(p.prob, p.c, null, { ...opt, enough: lo - p.constant + P }).value + p.constant;
        d = hi - lo >= P ? 0 : Number.isFinite(hi - lo) ? P - (hi - lo) : P + 1;
      }
      cache.set(key, d);
      return d;
    }
    // The sensitive quantities under a status assignment, in a fixed order. Which ones there are depends on
    // the statuses and the structure only.
    function quantities(s) {
      const out = [];
      vars.forEach((v, i) => {
        if (!v.people) return;
        if (s[i] === 'pri') out.push({ id: v.id, terms: [[i, 1]], kind: 'pri', home: [i] });
        else if (s[i] === 'sec') out.push({ id: v.id, terms: [[i, 1]], kind: 'sec', home: [i] });
        else if ((s[i] === 'withheld' || s[i] === 'unpub') && byVar[i].length) out.push({ id: v.id, terms: [[i, 1]], kind: 'cond', home: [i] });
      });
      for (const q of derived) out.push({ id: q.id, terms: q.terms, kind: 'cond', derived: true, home: q.terms.map(([i]) => i) });
      return out;
    }
    // Variables near a quantity, level by level through the constraints.
    function levels(q) {
      const level = new Map(); let frontier = [...new Set(q.home)];
      frontier.forEach(i => level.set(i, 0));
      for (let d = 1; frontier.length; d++) {
        const next = [];
        for (const i of frontier) for (const ci of byVar[i]) for (const [j] of cons[ci].terms) if (!level.has(j)) { level.set(j, d); next.push(j); }
        frontier = next;
      }
      return level;
    }
    return { applyMirror, problem, deficit, quantities, levels, reaches, targets, values, cons, byVar };
  }

  const TRIES = 12;
  // Seeded corners tried for each value a count must be shown able to take (consistent()).
  const WITNESS_TRIES = 8;
  // At most this many worlds are run through the audit to check one release (consistent()).
  const WORLD_RUNS = 400;
  // ... and at most this many for one value of one count.
  const WITNESS_RUNS = 24;
  /** The suppression for one world. */
  function run(values) {
    const w = world(values);
    const withheldTables = new Set();
    // A zero is printed as 0 and never hidden; the primary rule hides every count of people from 1 to T-1.
    const hideable = (s, i) => s[i] === 'vis' && vars[i].published && values[i] > 0 && !withheldTables.has(vars[i].table);
    const withStatus = (s, i, x) => { const t = s.slice(); t[i] = x; w.applyMirror(t); return t; };
    const withTable = (s, table) => { const t = s.slice(); for (const i of tableOf.get(table)) if (vars[i].published) t[i] = 'withheld'; w.applyMirror(t); return t; };
    let s = vars.map((v, i) => (!v.published ? 'unpub' : v.people && small(values[i]) ? 'pri' : 'vis'));
    // A total whose every part that is not 0 is shown "<T" (women <11, men <11) is hidden too, whatever it is:
    // printed, it would say how the small parts add up, and hiding it only when that pins them (served 12,
    // not 11) would say by the hiding that it is not 11. Decided by the symbols alone.
    for (const k of w.cons) {
      if (k.op !== '=' || k.rhs !== 0) continue;
      const tot = k.terms.filter(([, c]) => c === -1); const parts = k.terms.filter(([, c]) => c === 1);
      if (tot.length !== 1 || parts.length + 1 !== k.terms.length || parts.length < 2) continue;
      const t = tot[0][0];
      if (!vars[t].people || s[t] !== 'vis' || values[t] === 0) continue;
      if (parts.every(([i]) => s[i] === 'pri' || (s[i] === 'vis' && values[i] === 0)) && parts.some(([i]) => s[i] === 'pri')) s[t] = 'sec';
    }
    // ... and so is every count of at least T that is part of such a total (the people under a fund, on MAT):
    // printed, it would bound the total from below, and hiding it only when it is near the total would say so.
    const hiddenTotals = new Set(vars.map((_, i) => i).filter(i => s[i] === 'sec'));
    for (const k of w.cons) {
      if (k.op !== '<=' || k.rhs !== 0 || k.terms.length !== 2) continue;
      const [[a, ca], [b, cb]] = k.terms; const [sub, tot] = ca === 1 && cb === -1 ? [a, b] : ca === -1 && cb === 1 ? [b, a] : [null, null];
      if (sub !== null && hiddenTotals.has(tot) && vars[sub].people && s[sub] === 'vis' && values[sub] >= T) s[sub] = 'sec';
    }
    w.applyMirror(s);
    let outOfTime = false;
    // A count that passed is not asked again until a cell it depends on changes: hiding a cell changes only
    // the questions whose relationships hold it (its class, "at least T", stays what it was).
    const passed = new Map();
    const touchOf = (st, q) => {
      const p = w.problem(st, q.terms); const t = new Set(q.terms.map(([i]) => i));
      for (const i of p.members) { t.add(i); for (const ci of w.byVar[i]) for (const [j] of w.cons[ci].terms) t.add(j); }
      for (const [i] of q.terms) for (const ci of w.byVar[i]) for (const [j] of w.cons[ci].terms) t.add(j);
      return t;
    };
    for (let guard = 0; guard < 5000; guard++) {
      if (Date.now() > deadline) { outOfTime = true; break; }
      let bad = null; let bd = 0;
      for (const q of w.quantities(s)) {
        if (passed.has(q.id)) continue;
        const d = w.deficit(s, q);
        if (d > 0) { bad = q; bd = d; break; }
        passed.set(q.id, touchOf(s, q));
      }
      if (!bad) break;
      const level = w.levels(bad);
      // Nearest first, a breakdown's cells before its total, people before other figures, then the model's
      // order (table order, then key order). Never by value: an order by size says which hidden count is larger.
      const cands = [...level.keys()].filter(i => hideable(s, i))
        .sort((a, b) => (level.get(a) - level.get(b)) || (vars[a].total - vars[b].total) || (vars[b].people - vars[a].people) || (a - b));
      // In that order, the first that fixes it, else the first that helps, else the first.
      if (cands.length) {
        let choice = null; let helped = null;
        for (const i of cands.slice(0, TRIES)) {
          const t = withStatus(s, i, 'sec');
          const d = w.deficit(t, bad);
          if (d === 0) { choice = t; break; }
          if (d < bd && !helped) helped = t;
        }
        const next = choice || helped || withStatus(s, cands[0], 'sec');
        const changed = []; next.forEach((x, i) => { if (x !== s[i]) changed.push(i); });
        for (const [id, touch] of passed) if (changed.some(i => touch.has(i))) passed.delete(id);
        s = next;
        continue;
      }
      // Nothing visible left near it: withhold a table that binds it, nearest first.
      const tables = []; const seen = new Set();
      for (const i of [...level.keys()].sort((a, b) => (level.get(a) - level.get(b)) || (a - b))) {
        const t = vars[i].table; if (seen.has(t) || withheldTables.has(t) || !vars[i].published) continue;
        seen.add(t); tables.push(t);
      }
      if (!tables.length) break; // nothing left to withhold: the check below refuses the release
      let pick = null; let helped = null;
      for (const t of tables.slice(0, TRIES)) {
        const d = w.deficit(withTable(s, t), bad);
        if (d === 0) { pick = t; break; }
        if (d < bd && !helped) helped = t;
      }
      const t = pick || helped || tables[0];
      withheldTables.add(t); s = withTable(s, t); passed.clear();
    }
    // The loop ends when nothing is under-protected - or when it gives up (its step limit, nothing left to
    // withhold, the time limit). So every sensitive count is checked again here, all of them, each exactly.
    const unprotected = [];
    // (A count that passed and whose relationships have not changed since is not asked again: the answer is the same.)
    if (!outOfTime) for (const q of w.quantities(s)) { if (!passed.has(q.id) && w.deficit(s, q) > 0) unprotected.push(q.id); if (Date.now() > deadline) { outOfTime = true; break; } }
    return { status: s, withheldTables: [...withheldTables], verified: !outOfTime && !unprotected.length, unprotected, outOfTime, world: w };
  }

  // -------------------------------------------------------------------------------------------------------
  // Consistency. The check in run() asks what the printout allows: every world with those numbers and those
  // symbols. An attacker who knows the method knows more: of those worlds, only the ones on which run()
  // prints the same release can be behind it. So a count is protected only if worlds that print the same
  // release show it can take the values the rule asks for: for each sensitive count, candidate worlds (the
  // same figures, with the hidden counts linked to it changed as little as possible) are found by the solver,
  // each is run through run(), and it counts only if it prints the identical release. A count that no such
  // world shows able to be small enough, or large enough, is not protected, and the release is refused.
  // This is asked of every cell the release hides ("<T", suppressed, withheld, and the cells of a fund no
  // longer active). Counts printed nowhere but worked out from printed ones (the people not on MAT) are
  // held to the rule against the printout in run(), not here: asking it of them here refused ordinary
  // releases for want of a world, not for a leak found (docs/HIPAA.md, residual risks).
  // What this proves: each such world prints this release through run() - the suppression. That it would
  // also pass this check itself is not proved (the search starts from this release's own figures, so
  // another world's search starts elsewhere); the tests run the whole release on every world of small
  // families (test/fixtures/pattern-attacker.js).
  function consistent(base) {
    const S = base.status; const tables = [...base.withheldTables].sort().join('|');
    const w = base.world; const truth = w.values;
    const G = [truth]; const seen = new Map([[truth.join(','), true]]);
    let outOfTime = false; let gaveUp = false;
    const valueOf = (vals, terms) => terms.reduce((a, [i, c]) => a + c * vals[i], 0);
    const same = (r) => r.verified && [...r.withheldTables].sort().join('|') === tables && r.status.every((x, i) => x === S[i]);
    const tryWorld = (vals) => {
      const key = vals.join(',');
      if (seen.has(key)) return seen.get(key);
      // A bounded search: past WORLD_RUNS worlds tried, the answer is "not shown" (the cautious one).
      if (seen.size >= WORLD_RUNS) { gaveUp = true; return false; }
      let ok = false;
      try { ok = same(run(vals)); } catch { ok = false; }
      seen.set(key, ok); if (ok) G.push(vals);
      if (Date.now() > deadline) outOfTime = true;
      return ok;
    };
    // Candidate worlds with the quantity at v: only the hidden counts linked to it move. The nearest to this
    // release's own figures first (fewest people moved), then the nearest to each world already found to print
    // the same, then corners (every count as low as it can be, not zero where the printout allows; the counts
    // printed nowhere as small as they can be; weights from a generator seeded by the question).
    function* candidates(q, v) {
      const p = w.problem(S, q.terms);
      if (!p.n) return;
      const n = p.n;
      const prob = { ...p.prob, rows: [...p.prob.rows, { a: p.c, op: '=', b: v - p.constant }] };
      const worldOf = (x) => { const vals = truth.slice(); p.members.forEach((i, j) => { vals[i] = x[j]; }); return vals; };
      // First, keeping every other hidden count, and every count printed nowhere, in the class it has here (0,
      // 1 to T-1, or T and more): which counts are hidden mostly follows from those classes.
      const cls = (x) => (x === 0 ? [0, 0] : x < T ? [1, T - 1] : [T, Infinity]);
      const keep = { ...prob, rows: prob.rows.slice(), lb: prob.lb.slice(), ub: prob.ub.slice() };
      p.members.forEach((i, j) => { if (vars[i].people && !q.terms.some(([t]) => t === i)) { const [a, b] = cls(truth[i]); keep.lb[j] = Math.max(keep.lb[j], a); keep.ub[j] = Math.min(keep.ub[j], b); } });
      for (const dq of derived) {
        if (dq.id === q.id) continue;
        const a = new Array(n).fill(0); let k = 0; let moves = false;
        for (const [i, co] of dq.terms) { if (p.idx.has(i)) { a[p.idx.get(i)] += co; moves = true; } else k += co * truth[i]; }
        if (!moves) continue;
        const [lo, hi] = cls(valueOf(truth, dq.terms));
        keep.rows.push({ a, op: '>=', b: lo - k }); if (hi !== Infinity) keep.rows.push({ a, op: '<=', b: hi - k });
      }
      const nearest = (pr, anchor) => {
        const pad = new Array(n).fill(0);
        const rows = pr.rows.map(r => ({ a: [...r.a, ...pad], op: r.op, b: r.b }));
        p.members.forEach((i, j) => {
          const up = new Array(2 * n).fill(0); up[j] = 1; up[n + j] = -1; rows.push({ a: up, op: '<=', b: anchor[i] });
          const dn = new Array(2 * n).fill(0); dn[j] = -1; dn[n + j] = -1; rows.push({ a: dn, op: '<=', b: -anchor[i] });
        });
        const r = intMax({ n: 2 * n, rows, lb: [...pr.lb, ...pad], ub: [...pr.ub, ...new Array(n).fill(Infinity)] }, [...pad, ...new Array(n).fill(-1)], null, opt);
        return r.x ? r.x.slice(0, n) : null;
      };
      for (const pr of [keep, prob]) {
        for (const anchor of [truth, ...G.slice(1).slice(-3).reverse()]) {
          if (outOfTime || gaveUp) return;
          const x = nearest(pr, anchor); if (x) yield worldOf(x);
        }
      }
      // Then, keeping the classes, each other hidden count of people as high, then as low, as it can go.
      let k = 0;
      for (const i of p.members) {
        if (!vars[i].people || q.terms.some(([t]) => t === i) || k++ >= 6) continue;
        for (const dir of [1, -1]) {
          if (outOfTime || gaveUp) return;
          const o = new Array(n).fill(0); o[p.idx.get(i)] = dir;
          const r = intMax(keep, o, null, opt);
          if (r.x && Number.isFinite(r.value)) yield worldOf(r.x);
        }
      }
      const own = new Set(q.terms.map(([i]) => i));
      const nonzero = { ...prob, lb: p.members.map((i, j) => (vars[i].people && !own.has(i) ? Math.max(1, prob.lb[j]) : prob.lb[j])) };
      const down = p.members.map(() => -1);
      const tight = down.slice();
      for (const dq of derived) for (const [i, co] of dq.terms) if (p.idx.has(i)) tight[p.idx.get(i)] -= 4 * co;
      let seed = 2166136261; for (const ch of `${q.id}|${v}`) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
      const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
      const corners = [[nonzero, down], [nonzero, tight], [prob, tight], [prob, down]];
      for (let k = 0; k < WITNESS_TRIES; k++) corners.push([nonzero, p.members.map(() => -(1 + Math.floor(rnd() * 8)))]);
      for (const [pr, o] of corners) {
        if (outOfTime || gaveUp) return;
        const r = intMax(pr, o, null, opt);
        if (r.x) yield worldOf(r.x);
      }
      // Last, a line search: each of the first few other hidden counts of people set in turn to each value
      // from its lowest, the rest as near this release's figures as they can be.
      let m = 0;
      for (const i of p.members) {
        if (!vars[i].people || own.has(i) || m++ >= 4) continue;
        const j = p.idx.get(i);
        for (let x = prob.lb[j]; x <= prob.lb[j] + 2 * T && x <= prob.ub[j]; x++) {
          if (outOfTime || gaveUp) return;
          const fixed = { ...prob, lb: prob.lb.slice(), ub: prob.ub.slice() }; fixed.lb[j] = x; fixed.ub[j] = x;
          const y = nearest(fixed, truth); if (y) yield worldOf(y);
        }
      }
    }
    // At most WITNESS_RUNS new worlds are run for one value; past that the value counts as not shown.
    const witness = (q, v, cap = WITNESS_RUNS) => {
      if (G.some(vals => valueOf(vals, q.terms) === v)) return true;
      let runs = 0;
      for (const vals of candidates(q, v)) {
        const fresh = !seen.has(vals.join(','));
        if (tryWorld(vals) && valueOf(vals, q.terms) === v) return true;
        if (fresh && ++runs >= cap) return false;
      }
      return false;
    };
    const unprotected = [];
    for (const q of w.quantities(S)) {
      if (outOfTime || Date.now() > deadline) { outOfTime = true; break; }
      if (gaveUp) { unprotected.push(q.id); continue; }
      let ok = true;
      if (q.kind === 'pri' || (q.kind === 'cond' && !q.derived)) {
        // A "<T" cell, or a withheld one (or one printed nowhere) when the printout lets it be small: worlds
        // that print the same must show it can be the lowest value its symbols allow (1: the one person)
        // and a value at least P-1 above it (the highest when the range is shorter): a range of P values. run()
        // asks for 1 and T-1 against the printout alone; against the method a hidden total that is shown
        // only when large can take T-1 off a "<T" part (discharges 12 to 20 hidden beside "moved <11" say
        // at most 9 moved), which says nothing about who is in it.
        const t = q.kind === 'pri' || w.reaches(w.problem(S, q.terms)) ? w.targets(S, q) : [];
        if (t.length) {
          const [L, U] = [t[0], t[t.length - 1]];
          const top = Math.min(U, L + P - 1);
          ok = witness(q, L);
          const high = () => G.some(vals => { const x = valueOf(vals, q.terms); return x >= top && x <= U; });
          for (let v = U; ok && !high() && v >= top && !outOfTime; v--) witness(q, v);
          ok = ok && high();
        }
      } else if (q.kind === 'sec') {
        // A suppressed count: worlds that print the same with it at least P apart. From its value here, step
        // down, then up, while each next value is shown by such a world.
        const p = w.problem(S, q.terms);
        const x = valueOf(truth, q.terms);
        const lo = -intMax(p.prob, p.c.map(c => -c), null, opt).value + p.constant;
        const hi = intMax(p.prob, p.c, null, opt).value + p.constant;
        const found = G.map(vals => valueOf(vals, q.terms));
        let a = Math.min(x, ...found); let b = Math.max(x, ...found);
        for (let v = a - 1; b - a < P && v >= lo && v >= x - 2 * T && !outOfTime && witness(q, v, 8); v--) a = v;
        for (let v = b + 1; b - a < P && v <= hi && v <= x + 2 * T && !outOfTime && witness(q, v, 8); v++) b = v;
        ok = b - a >= P;
      }
      if (!ok) unprotected.push(q.id);
    }
    return { ok: !outOfTime && !gaveUp && !unprotected.length, unprotected, outOfTime, worlds: G.length, tried: seen.size, G };
  }
  return { run, consistent };
}

/**
 * Protect one release: suppress (run), then check that the printout protects every sensitive count over the
 * worlds that print it (consistent). Returns { status, withheldTables, verified, unprotected, outOfTime };
 * one that is not verified must not be published (server/publication-release.js refuses it).
 */
function protect(model, T, { budget = 4000, timeLimitMs = Infinity, consistency = true, debug = false } = {}) {
  const deadline = Date.now() + timeLimitMs;
  const a = auditor(model, T, { budget, deadline });
  const base = a.run(model.vars.map(v => v.value));
  const { world, ...out } = base;
  if (!base.verified || !consistency) return out;
  const c = a.consistent(base);
  return { ...out, verified: c.ok, unprotected: c.unprotected, outOfTime: c.outOfTime, consistency: { worlds: c.worlds, tried: c.tried }, ...(debug ? { G: c.G } : {}) };
}


module.exports = { simplex, intMax, intFeasible, intFeasibleIn, protect };
