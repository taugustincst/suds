'use strict';
// The algorithm-aware attacker (test/publication-release.test.js; docs/HIPAA.md "Small cells in aggregate
// reports", "The pattern of what is hidden").
//
// SUDS is open source, so an attacker knows the audit as well as the rule. This one does not reason about a
// printout with constraints: it takes every programme that could lie behind it (every world of a family that
// anyone who knows the structure - the period, the lists, the funds - has to consider), runs the real release
// on each, and keeps the worlds whose printout is identical, character for character, to the one it holds.
// What is left is exactly what the release says to someone who knows the method. For each printout, every
// count of people it hides must still range as the rule against the method demands over the worlds left:
//   * a cell shown "<T", or withheld, or printed nowhere (a fund no longer active) when some world left has
//     it from 1 to T-1: some world left has it at the lowest small value its symbols allow (1: the one
//     person), and its small values over the worlds left range over at least ceil(T/2) values (all of them when fewer
//     are possible);
//   * a count shown "suppressed": its values over the worlds left span at least ceil(T/2);
//   * a count printed nowhere but worked out from printed ones (the people not on MAT; the events not
//     reversed; ...), when some world left has it from 1 to T-1: its small values range over at least ceil(T/2) values.
// The release check itself (server/sdc.js consistent()) asks the rules for cells on every release; counts
// printed nowhere it holds to the printout only, and this attacker checks them against the method on the
// families below. Against the printout alone the audit asks more: 1 and T-1 (release-attacker.js).
// "Small values" are 1 to T-1, or as near them as the printout's symbols alone allow (served "<T" beside
// women "<T" and men "<T" says there are at most T-2 women, whatever else is printed): the attacker works
// that out on its own, from the worlds whose values have the classes the printout shows (0, "<T", or at
// least T for a number or "suppressed" of people), whatever the audit would print for them.
// A refused release publishes nothing and is not checked. A family is enumerated beyond the sizes whose
// printouts are checked (`inner`), so that a printout's worlds are not cut off at the edge of the family.
const PR = require('../../server/publication-release');

function runAll(worlds, T) {
  return worlds.map(w => {
    const p = PR.protectFigures(w.inputs, T);
    const m = p.model;
    const value = new Map(m.vars.map(v => [v.id, v.value]));
    for (const d of m.derived) value.set(d.id, d.terms.reduce((a, [i, c]) => a + c * m.vars[i].value, 0));
    const table = new Map(m.vars.map(v => [v.id, v.table]));
    const key = p.refused ? 'REFUSED' : JSON.stringify({ f: p.funder, u: p.uses, n: p.ndp, w: p.withheld_tables });
    return { label: w.label, inner: w.inner !== false, p, value, table, key };
  });
}

/** The leaks: for each printout of an inner world, each hidden count whose values over the worlds left break the rule. */
function attackAll(worlds, T, { limit = 20 } = {}) {
  const P = Math.ceil(T / 2);
  const all = runAll(worlds, T);
  const groups = new Map();
  for (const r of all) { if (!groups.has(r.key)) groups.set(r.key, []); groups.get(r.key).push(r); }
  const leaks = []; let checked = 0; let refused = 0;
  for (const [key, ws] of groups) {
    if (!ws.some(w => w.inner)) continue;
    if (key === 'REFUSED') { refused += ws.filter(w => w.inner).length; continue; }
    checked++;
    const { p } = ws[0]; const m = p.model;
    const gone = new Set(p.withheld_tables);
    // What each printed cell's symbol says, alone: its class.
    const cls = new Map(m.vars.map((v, i) => {
      const st = p.status[i];
      if (st === 'vis') return [v.id, v.value === 0 ? '0' : v.people ? 'big' : 'any'];
      if (st === 'pri') return [v.id, 'small'];
      if (st === 'sec' && v.people) return [v.id, 'big'];
      return [v.id, 'any'];
    }));
    const fits = (x, c) => (c === '0' ? x === 0 : c === 'small' ? x > 0 && x < T : c === 'big' ? x >= T : true);
    // The worlds whose values have the printout's classes (the audit aside).
    const symbolic = all.filter(w => [...cls].every(([id, c]) => fits(w.value.has(id) ? w.value.get(id) : 0, c))
      && [...w.table].every(([id, t]) => cls.has(id) || gone.has(t) || w.value.get(id) === 0));
    const range = (set, id) => { const vs = set.map(w => (w.value.has(id) ? w.value.get(id) : 0)); return [Math.min(...vs), Math.max(...vs)]; };
    const valuesOf = (id) => [...new Set(ws.map(w => (w.value.has(id) ? w.value.get(id) : 0)))].sort((a, b) => a - b);
    const cells = m.vars.map((v, i) => ({ id: v.id, people: v.people, status: p.status[i], constrained: m.cons.some(k => k.terms.some(([j]) => j === i)) }))
      .concat(m.derived.map(d => ({ id: d.id, people: true, status: 'derived', constrained: true })));
    for (const c of cells) {
      if (!c.people || c.status === 'vis' || !c.constrained) continue;
      const vs = valuesOf(c.id);
      let bad = null;
      if (c.status === 'sec') { if (vs[vs.length - 1] - vs[0] < P) bad = `a suppressed count that spans less than ${P}`; }
      else if (c.status === 'pri' || vs.some(x => x > 0 && x < T)) {
        const [a, b] = range(symbolic, c.id);
        const L = Math.max(1, a); const U = Math.min(T - 1, b);
        if (L <= U) {
          const small = vs.filter(x => x >= L && x <= U);
          const span = small.length ? small[small.length - 1] - small[0] : -1;
          if (c.status !== 'derived' && !vs.includes(L)) bad = `a hidden cell that cannot be ${L}`;
          else if (span < Math.min(P - 1, U - L)) bad = `a hidden count whose small values span only ${span + 1} of ${Math.min(P, U - L + 1)}`;
        }
      }
      if (bad) leaks.push({ T, cell: c.id, status: c.status, values: vs, why: bad, worlds: ws.slice(0, 4).map(w => w.label), n: ws.length });
      if (leaks.length >= limit) return { leaks, checked, refused };
    }
  }
  return { leaks, checked, refused };
}

module.exports = { attackAll };
