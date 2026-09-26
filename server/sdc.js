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
//   * a sensitive count of people - a cell shown "<T", or a count of people with a true value from 1 to T-1
//     that is not printed but is tied to printed figures (the people left when a fund's are taken from the
//     total, the events in a month that were not reversals, a withheld cell) - is protected only if the
//     release is consistent with it being 1 AND with it being T-1: the release says nothing about it beyond
//     "fewer than T";
//   * a cell hidden to protect another ("suppressed", a count of people) must keep a feasible range at least
//     ceil(T/2) wide, so it cannot be read off.
// Both are checked over the INTEGER solutions, exactly. A linear-programming bound is only an outer bound:
// the integer range is contained in the LP range, so a wide LP range does not prove a wide integer range.
// Each question is answered by branch and bound over a small dense simplex (below): the LP gives a bound,
// and a fractional solution is split on one variable until the bound is met by an integer point. The
// relationships are almost all +-1 sums, so most LPs are integral at once and the search is tiny. A search
// that exceeds its node budget answers "not protected" (the cautious direction), never "protected".
//
// Suppression runs to a fixpoint: while a sensitive value is under-protected, one more cell is hidden -
// among the cells in the relationships that bind it, nearest first, a breakdown's cells before its total,
// the first (smallest) that fixes it, else the first that helps, else the smallest - and the audit runs
// again. When nothing visible is left to hide, the table that pins it is withheld whole. Everything is
// deterministic: the same data give the same release, whichever report asks for it.

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
// (c integer, so the optimum is an integer). `known` is an integer feasible point (the truth), the starting
// incumbent. `enough`: stop as soon as the incumbent reaches it. Returns { value, exact } - exact false when
// the node budget ran out (value is then the best integer point found, a valid lower bound on the maximum).
function intMax(prob, c, known, { enough = Infinity, budget = 4000 } = {}) {
  const dot = (x) => c.reduce((s, cj, j) => s + cj * x[j], 0);
  let best = known ? Math.round(dot(known)) : -Infinity;
  if (best >= enough) return { value: best, exact: true };
  const stack = [[prob.lb.slice(), prob.ub.slice()]];
  let nodes = 0;
  while (stack.length) {
    if (++nodes > budget) return { value: best, exact: false };
    const [lb, ub] = stack.pop();
    const r = simplex(prob.n, prob.rows, lb, ub, c);
    if (r.status === 'infeasible') continue;
    if (r.status === 'unbounded') return { value: Infinity, exact: true }; // only at the root: a bounded LP stays bounded when narrowed
    const bound = Math.floor(r.value + 1e-6);
    if (bound <= best) continue;
    let fj = -1;
    for (let j = 0; j < prob.n; j++) if (Math.abs(r.x[j] - Math.round(r.x[j])) > 1e-6) { fj = j; break; }
    if (fj < 0) { best = Math.max(best, Math.round(r.value)); if (best >= enough) return { value: best, exact: true }; continue; }
    const f = Math.floor(r.x[fj]);
    const up = [lb.slice(), ub.slice()]; up[0][fj] = f + 1;
    const down = [lb.slice(), ub.slice()]; down[1][fj] = f;
    stack.push(up, down);
  }
  return { value: best, exact: true };
}
/** Is there an integer point with c.x = v? (Branch and bound on feasibility.) */
function intFeasible(prob, c, v, { budget = 4000 } = {}) {
  const rows = [...prob.rows, { a: c, op: '=', b: v }];
  const zero = new Array(prob.n).fill(0);
  const stack = [[prob.lb.slice(), prob.ub.slice()]];
  let nodes = 0;
  while (stack.length) {
    if (++nodes > budget) return { feasible: false, exact: false };
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

// ---------------------------------------------------------------------------------------------------------
// The audit.
//
// model: {
//   vars: [{ id, value, people, total, table, published }]   published false: printed nowhere (no symbol)
//   cons: [{ terms: [[varIndex, coef]], op, rhs }]
//   derived: [{ id, terms: [[varIndex, coef]] }]              counts of people printed nowhere
//   mirror: [[peopleIndex, figureIndex]]                        a figure hidden whenever its people cell is
// }
// status per var: 'vis' | 'pri' | 'sec' | 'withheld' | 'unpub'.

function protect(model, T, { budget = 4000 } = {}) {
  const { vars, derived = [], mirror = [] } = model;
  // A relationship the data do not satisfy would make the audit wrong. One that holds for everything SUDS
  // records but not for every row an import could write (soft) is left out when it fails: an attacker who
  // assumed it would be reasoning from something false. Any other is a bug in the model.
  const cons = model.cons.filter(k => {
    const lhs = k.terms.reduce((s, [i, c]) => s + c * vars[i].value, 0);
    const ok = k.op === '=' ? lhs === k.rhs : k.op === '<=' ? lhs <= k.rhs : lhs >= k.rhs;
    if (!ok && model.strict && !k.soft) throw new Error(`the truth violates ${JSON.stringify(k.terms.map(([i, c]) => [vars[i].id, c]))} ${k.op} ${k.rhs}`);
    return ok;
  });
  const P = Math.ceil(T / 2);
  const nv = vars.length;
  const st = vars.map(v => (!v.published ? 'unpub' : v.people && v.value > 0 && v.value < T ? 'pri' : 'vis'));
  const small = (x) => x > 0 && x < T;
  const byVar = vars.map(() => []); cons.forEach((k, ci) => { for (const [i] of k.terms) byVar[i].push(ci); });
  const tableOf = new Map(); vars.forEach((v, i) => { if (!tableOf.has(v.table)) tableOf.set(v.table, []); tableOf.get(v.table).push(i); });
  const withheldTables = new Set();

  const applyMirror = (s) => { for (const [p, f] of mirror) if ((s[p] === 'pri' || s[p] === 'sec') && s[f] === 'vis') s[f] = 'sec'; else if (s[p] === 'withheld' && s[f] === 'vis') s[f] = 'withheld'; };
  const bounds = (s, i) => {
    const v = vars[i];
    switch (s[i]) {
      case 'vis': return [v.value, v.value];
      case 'pri': return [1, T - 1];
      case 'sec': return v.people ? [T, Infinity] : [0, Infinity];
      default: return [0, Infinity];
    }
  };
  // The problem restricted to what can move with the quantity: the non-fixed variables reachable from it
  // through constraints, and every constraint that touches them (fixed variables become constants).
  function problem(s, terms) {
    const idx = new Map(); const queue = [];
    for (const [i] of terms) if (s[i] !== 'vis' && !idx.has(i)) { idx.set(i, idx.size); queue.push(i); }
    for (let q = 0; q < queue.length; q++) {
      for (const ci of byVar[queue[q]]) for (const [j] of cons[ci].terms) if (s[j] !== 'vis' && !idx.has(j)) { idx.set(j, idx.size); queue.push(j); }
    }
    const members = queue; const n = members.length;
    const touched = new Set(); for (const i of members) for (const ci of byVar[i]) touched.add(ci);
    const rows = [...touched].sort((a, b) => a - b).map(ci => {
      const k = cons[ci]; const a = new Array(n).fill(0); let rhs = k.rhs;
      for (const [j, c] of k.terms) { if (idx.has(j)) a[idx.get(j)] += c; else rhs -= c * vars[j].value; }
      return { a, op: k.op, b: rhs };
    });
    const lb = members.map(i => bounds(s, i)[0]); const ub = members.map(i => bounds(s, i)[1]);
    const c = new Array(n).fill(0); let constant = 0;
    for (const [i, co] of terms) { if (idx.has(i)) c[idx.get(i)] += co; else constant += co * vars[i].value; }
    const truth = members.map(i => vars[i].value);
    const key = members.map(i => `${i}:${s[i]}`).join(',');
    return { prob: { n, rows, lb, ub }, c, constant, truth, key, n };
  }
  const cache = new Map();
  // How far a sensitive quantity is from protected: 0 when protected.
  function deficit(s, q) {
    const p = problem(s, q.terms);
    const key = `${q.id}|${q.kind}|${p.key}`;
    if (cache.has(key)) return cache.get(key);
    let d = 0;
    if (p.n === 0) {
      d = q.kind === 'small' ? (p.constant === 1 ? 0 : 1) + (p.constant === T - 1 ? 0 : 1) : P;
    } else if (q.kind === 'small') {
      for (const v of [1, T - 1]) {
        if (q.truth === v) continue;
        const r = intFeasible(p.prob, p.c, v - p.constant, { budget });
        if (!r.feasible) d += 1;
      }
    } else {
      const lo = -intMax(p.prob, p.c.map(x => -x), p.truth, { budget }).value + p.constant;
      const hiR = intMax(p.prob, p.c, p.truth, { budget, enough: lo - p.constant + P });
      const hi = hiR.value + p.constant;
      d = Math.max(0, P - (hi - lo));
    }
    cache.set(key, d);
    return d;
  }
  // The sensitive quantities under a status assignment, in a fixed order.
  function quantities(s) {
    const out = [];
    vars.forEach((v, i) => {
      if (!v.people) return;
      if (s[i] === 'pri') out.push({ id: v.id, terms: [[i, 1]], kind: 'small', truth: v.value, home: [i] });
      else if (s[i] === 'sec') out.push({ id: v.id, terms: [[i, 1]], kind: 'sec', truth: v.value, home: [i] });
      else if ((s[i] === 'withheld' || s[i] === 'unpub') && small(v.value) && byVar[i].length) out.push({ id: v.id, terms: [[i, 1]], kind: 'small', truth: v.value, home: [i] });
    });
    for (const q of derived) {
      const truth = q.terms.reduce((a, [i, c]) => a + c * vars[i].value, 0);
      if (small(truth)) out.push({ id: q.id, terms: q.terms, kind: 'small', truth, home: q.terms.map(([i]) => i) });
    }
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
  const hideable = (s, i) => s[i] === 'vis' && vars[i].published && vars[i].value > 0 && !withheldTables.has(vars[i].table);
  const withStatus = (s, i, x) => { const t = s.slice(); t[i] = x; applyMirror(t); return t; };
  const withTable = (s, table) => { const t = s.slice(); for (const i of tableOf.get(table)) if (vars[i].published) t[i] = 'withheld'; applyMirror(t); return t; };
  const TRIES = 12;

  applyMirror(st);
  let s = st;
  for (let guard = 0; guard < 5000; guard++) {
    let bad = null; let bd = 0;
    for (const q of quantities(s)) { const d = deficit(s, q); if (d > 0) { bad = q; bd = d; break; } }
    if (!bad) break;
    const level = levels(bad);
    const cands = [...level.keys()].filter(i => hideable(s, i))
      .sort((a, b) => (level.get(a) - level.get(b)) || (vars[a].total - vars[b].total) || (vars[b].people - vars[a].people) || (vars[a].value - vars[b].value) || (a - b));
    let choice = null;
    if (cands.length) {
      let helped = null;
      for (const i of cands.slice(0, TRIES)) {
        const t = withStatus(s, i, 'sec');
        const d = deficit(t, bad);
        if (d === 0) { choice = t; break; }
        if (d < bd && !helped) helped = t;
      }
      s = choice || helped || withStatus(s, cands[0], 'sec');
      continue;
    }
    // Nothing visible left near it: withhold a table that binds it, nearest first.
    const tables = []; const seen = new Set();
    for (const i of [...level.keys()].sort((a, b) => (level.get(a) - level.get(b)) || (a - b))) {
      const t = vars[i].table; if (seen.has(t) || withheldTables.has(t) || !vars[i].published) continue;
      seen.add(t); tables.push(t);
    }
    if (!tables.length) break; // cannot happen: with everything withheld nothing is tied to anything printed
    let pick = null; let helped = null;
    for (const t of tables.slice(0, TRIES)) {
      const d = deficit(withTable(s, t), bad);
      if (d === 0) { pick = t; break; }
      if (d < bd && !helped) helped = t;
    }
    const t = pick || helped || tables[0];
    withheldTables.add(t); s = withTable(s, t);
  }
  return { status: s, withheldTables: [...withheldTables] };
}


module.exports = { simplex, intMax, intFeasible, protect };
