'use strict';
// Small-cell suppression for aggregate reports that may be published or shared (the funder report, the NDP
// log, the opioid settlement report; docs/HIPAA.md "Small cells in aggregate reports"), for runs that are not a
// publication release. A publication release (server/publication-release.js) is audited as one constraint
// system across all three reports by server/sdc.js instead; the symbols mean the same, the protection rule
// there is stricter (docs/HIPAA.md).
//
// What is a count of people: people served (in total, per fund, per allowable use, per demographic row),
// referrals, admissions, people on MAT, episodes opened, closed and open (an episode is one person's), each
// discharge reason, overdose events, reversals, fatal and community-reported overdoses (an event happens to
// one person), and who gave the naloxone. What is not: naloxone kits and doses distributed, test strips,
// services (visits), staff hours and money. Those stay exact.
//
// Two steps, in suppressed mode only:
//  * Primary: a count of people above 0 and below the threshold T is shown as "<T". Zero stays 0.
//  * Complementary (secondary): wherever a hidden count could still be worked out from everything the
//    release publishes, more is hidden, shown as "suppressed", until nothing can.
//
// The attacker is assumed to know this rule. So a "<T" cell is known to lie in [1, T-1], and a "suppressed"
// cell is known to be at least T (had it been smaller it would have shown "<T"); 1.12.0 assumed only "at
// least 1", and so let 11 + "<11" under a total of 12 through.
//
// Tables that share a total are protected together (star() below): the people served, and every table that
// adds up to it or counts some of them. A total and a complete, fully visible breakdown of it are the same
// published number, so hiding the total helps only if no breakdown still prints it. The total is kept
// visible whenever hiding more cells is enough, and hidden only when a breakdown cannot otherwise be
// protected (two "<11" cells that make up the whole total, say).
//
// A figure derived from the same small group (the naloxone doses used in a hidden reversal row) is hidden
// with it ("mirror"), and then protected the same way.

const SECONDARY = 'suppressed';
// A table or figure that no pattern of hidden cells could protect: not published at all.
const WITHHELD = 'withheld';
const primary = (T) => `<${T}`;
const isSmall = (v, T) => typeof v === 'number' && v > 0 && v < T;
const isNum = (v) => typeof v === 'number';
const BIG = 1e12; // stands in for "no upper bound" where a finite probe is needed

/** One headline count of people. */
function cell(v, { threshold, exact }) { return !exact && isSmall(v, threshold) ? primary(threshold) : v; }

/**
 * Could an attacker pin any hidden cell to one value? hidden: [{ v (true value), lo, hi }]; S: the total
 * minus the visible cells.
 */
function pinned(hidden, S) {
  if (hidden.length === 1) return true;
  const sumLo = hidden.reduce((a, c) => a + c.lo, 0); const sumHi = hidden.reduce((a, c) => a + c.hi, 0);
  return hidden.some(c => Math.max(c.lo, S - (sumHi - c.hi)) === Math.min(c.hi, S - (sumLo - c.lo)));
}

/**
 * Tables sharing one total N, protected together.
 *   partitions: lists of counts that each add up to N (each person in exactly one row: gender, housing…).
 *   subsets:    counts of some of the N (a fund, on MAT, referred…). Each leaves a complement, N - s, that is
 *               printed nowhere but is a count of people anyone can work out; it is protected like a cell.
 *   cover:      counts each of which is a subset, and which together add up to at least N (race codes: a
 *               person may report several, and everyone has at least one, if only "unknown").
 * Options: threshold, exact; fixedTotal (the total is published elsewhere and cannot be hidden here: it is
 * treated as known); hidden: { partitions: [[g, i]], subsets: [i], total: true } to hide from the start (as
 * "suppressed"), because they protect something outside this star; they must not be pinned either.
 * Returns { total, partitions, subsets, cover } as shown.
 *
 * The audit is exact for this shape: given N the tables are independent, the N that fit every table form an
 * interval, and for each hidden value the values it can take over that interval form an interval, found
 * from its ends (test/small-cell-suppression.test.js checks it against brute force).
 */
function star({ total, partitions = [], subsets = [], cover = [] }, { threshold: T, exact = false, fixedTotal = false, hidden = {} }) {
  if (exact) return { total, partitions: partitions.map(p => [...p]), subsets: [...subsets], cover: [...cover] };
  // Cells: { v, st } with st 'vis' | 'pri' | 'sec'.
  const mk = (v) => ({ v, st: isSmall(v, T) ? 'pri' : 'vis' });
  const tot = { v: total, st: isSmall(total, T) ? 'pri' : 'vis' };
  const parts = partitions.map(p => p.map(mk));
  const subs = subsets.map(mk);
  const cov = cover.map(mk);
  // A cell hidden from the start protects something outside this star (the reversals in a month that also
  // shows its overdoses), so it must not be pinned either.
  const force = (c) => { if (c && c.st === 'vis' && c.v > 0) { c.st = 'sec'; c.sens = true; } };
  for (const [g, i] of hidden.partitions || []) force(parts[g][i]);
  for (const i of hidden.subsets || []) force(subs[i]);
  if (hidden.total) force(tot);
  const lo = (c) => (c.st === 'vis' ? c.v : c.st === 'pri' ? 1 : T);
  const hi = (c) => (c.st === 'vis' ? c.v : c.st === 'pri' ? T - 1 : Infinity);
  const vis = (cs) => cs.reduce((a, c) => a + (c.st === 'vis' ? c.v : 0), 0);
  const hid = (cs) => cs.filter(c => c.st !== 'vis');
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  // Tables that cannot be protected however much is hidden (ten people who speak ten languages, under a total
  // shown as "<11": ten rows of at least one each can only be ten ones) are withheld whole.
  const withheld = new Set();
  const live = (g) => !withheld.has(g);

  // The N that fit everything published.
  function range() {
    let nlo = fixedTotal ? total : lo(tot); let nhi = fixedTotal ? total : hi(tot);
    const bounds = [];
    for (const p of parts.filter(live)) { const V = vis(p); const h = hid(p); bounds.push({ g: p, table: p, lo: V + sum(h.map(lo)), hi: V + sum(h.map(hi)) }); }
    for (const s of subs.filter(live)) bounds.push({ g: [s], lo: lo(s), hi: Infinity });
    if (cov.length && live(cov)) {
      const V = vis(cov); const h = hid(cov);
      bounds.push({ g: cov, table: cov, lo: Math.max(0, ...cov.map(lo)), hi: V + sum(h.map(hi)) });
    }
    for (const b of bounds) { nlo = Math.max(nlo, b.lo); nhi = Math.min(nhi, b.hi); }
    return { nlo, nhi, bounds };
  }
  // Every sensitive value the attacker can pin: [{ home: cells whose visible members could be hidden to fix it, own }]
  function exposures() {
    const { nlo, nhi, bounds } = range();
    const out = [];
    const smallRest = (s) => isSmall(total - s.v, T);
    if ((tot.st === 'pri' || tot.sens) && nlo === nhi) out.push({ home: [] });
    for (const p of parts.filter(live)) {
      const V = vis(p); const h = hid(p);
      for (const c of h) {
        if (c.st !== 'pri' && !c.sens) continue;
        const o = h.filter(x => x !== c);
        const a = Math.max(lo(c), nlo - V - sum(o.map(hi))); const b = Math.min(hi(c), nhi - V - sum(o.map(lo)));
        if (a === b) out.push({ home: p, table: p });
      }
    }
    for (const s of subs.filter(live)) {
      if ((s.st === 'pri' || s.sens) && lo(s) === Math.min(hi(s), nhi)) out.push({ home: [s], sub: s });
      // The rest: N - s.
      if (smallRest(s) && Math.max(0, nlo - hi(s)) === nhi - lo(s)) out.push({ home: [s], own: s, sub: s });
    }
    if (cov.length && live(cov)) {
      const probes = (k) => { const others = cov.filter(x => x !== k && x.st !== 'vis'); return [nlo, isFinite(nhi) ? nhi : BIG, ...others.map(hi).filter(x => isFinite(x) && x > nlo && x < nhi)]; };
      for (const k of cov) {
        const Vo = sum(cov.filter(x => x !== k && x.st === 'vis').map(x => x.v));
        const others = cov.filter(x => x !== k && x.st !== 'vis');
        const g = (N) => N - Vo - sum(others.map(x => Math.min(hi(x), N)));
        let a = lo(k); let b = Math.min(hi(k), nhi);
        if (k.st !== 'vis') a = Math.max(lo(k), Math.min(...probes(k).map(g)));
        else { a = k.v; b = k.v; }
        if (k.st === 'pri' && a === b) out.push({ home: cov, table: cov });
        if (smallRest(k)) {
          const restLo = k.st === 'vis' ? nlo - k.v : Math.max(0, nlo - hi(k));
          const topN = isFinite(nhi) ? nhi : BIG;
          const restHi = k.st === 'vis' ? nhi - k.v : Math.min(nhi - lo(k), Vo + sum(others.map(x => Math.min(hi(x), topN))));
          if (restLo === restHi) out.push({ home: cov, own: k, table: cov });
        }
      }
    }
    return { out, nlo, nhi, bounds };
  }
  const hideSmallest = (cs, prefer) => {
    cs = cs.filter(live);
    if (prefer && prefer.st === 'vis' && prefer.v > 0) { prefer.st = 'sec'; return true; }
    let best = null;
    for (const c of cs) if (c.st === 'vis' && c.v > 0 && (!best || c.v < best.v)) best = c;
    if (!best) return false;
    best.st = 'sec'; return true;
  };
  for (let guard = 0; guard < 10000; guard++) {
    const { out, nlo, nhi, bounds } = exposures();
    if (!out.length) break;
    const e = out[0];
    // 1. Hide more of the table the exposed value is in (the total stays visible if that is enough).
    if (hideSmallest(e.home, e.own)) continue;
    // 2. Hide the total.
    if (!fixedTotal && tot.st === 'vis' && tot.v > 0) { tot.st = 'sec'; continue; }
    // 3. The total is hidden but the tables still pin it: hide more of each table that bounds it.
    let did = false;
    for (const b of bounds) if ((b.lo === nlo || b.hi === nhi) && hideSmallest(b.g)) did = true;
    if (did) continue;
    // 4. Anything left.
    if (![...parts.flat(), ...subs, ...cov].some(c => hideSmallest([c]))) break;
  }
  // Everything is hidden and something is still pinned: withhold the table it is in, or the tables that pin
  // the total, until nothing is.
  for (let guard = 0; guard < 1000; guard++) {
    const { out, nlo, nhi, bounds } = exposures();
    if (!out.length) break;
    const e = out.find(x => x.table);
    if (e) { withheld.add(e.table); continue; }
    let did = false;
    for (const b of bounds) if (b.table && (b.lo === nlo || b.hi === nhi)) { withheld.add(b.table); did = true; }
    if (did) continue;
    for (const x of out) if (x.sub) withheld.add(x.sub);
    if (!out.some(x => x.sub)) break;
  }
  const show = (c) => (withheld.has(c) ? WITHHELD : c.st === 'vis' ? c.v : c.st === 'pri' ? primary(T) : SECONDARY);
  return { total: fixedTotal ? total : show(tot), partitions: parts.map(p => (withheld.has(p) ? null : p.map(show))), subsets: subs.map(show), cover: withheld.has(cov) ? null : cov.map(show) };
}

/** A breakdown with no total: never exactly one hidden cell beside visible ones. Works on shown values. */
function noLonely(shown) {
  const out = [...shown];
  if (out.filter(v => !isNum(v)).length !== 1) return out;
  let next = -1;
  out.forEach((v, i) => { if (isNum(v) && v > 0 && (next < 0 || v < out[next])) next = i; });
  if (next >= 0) out[next] = SECONDARY;
  return out;
}

/**
 * A table of rows, one or more count columns. keys: the columns that count people; mirror: { column: the
 * people column it is hidden with } for figures about the same group that are not themselves people;
 * totals: { column: its true total, published } (omit a column with no published total). A column with a
 * total is protected with it (star); one without never has a lone hidden cell. Returns new rows and totals.
 */
function table(rows, keys, { threshold: T, exact = false, totals = {}, mirror = {}, hidden = {} }) {
  const out = rows.map(r => ({ ...r }));
  const tot = { ...totals };
  if (exact) return { rows: out, totals: tot };
  const hiddenIdx = {};
  for (const key of keys) {
    let shown;
    if (isNum(totals[key])) {
      const s = star({ total: totals[key], partitions: [rows.map(r => r[key])] }, { threshold: T, hidden: { partitions: (hidden[key] || []).map(i => [0, i]) } });
      shown = s.partitions[0] || rows.map(() => WITHHELD); tot[key] = s.total;
    } else {
      shown = noLonely(rows.map(r => cell(r[key], { threshold: T })));
    }
    hiddenIdx[key] = new Set();
    shown.forEach((v, i) => { out[i][key] = v; if (!isNum(v)) { hiddenIdx[key].add(i); out[i].suppressed = true; } });
  }
  // A mirrored figure is not a count of people: a hidden one may be 0 or anything; one hidden to protect it
  // is known only to be at least 1.
  for (const [key, of] of Object.entries(mirror)) {
    const idx = new Set();
    // The people column was protected here, or arrives already protected (shown values).
    const src = hiddenIdx[of] || new Set(out.map((r, i) => (r[of] === null || r[of] === undefined || isNum(r[of]) ? -1 : i)).filter(i => i >= 0));
    for (const i of src) if (out[i][key] !== null && out[i][key] !== undefined) { idx.add(i); out[i][key] = SECONDARY; }
    const mirrored = new Set(idx);
    const total = tot[key]; const published = isNum(total);
    for (;;) {
      const hiddenCells = [...idx].map(i => ({ v: rows[i][key], ...(mirrored.has(i) ? { lo: 0, hi: Infinity } : { lo: 1, hi: Infinity }) }));
      if (!hiddenCells.length) break;
      const visibleSum = out.reduce((a, r, i) => a + (idx.has(i) || !isNum(r[key]) ? 0 : r[key]), 0);
      const visibleNonZero = out.some((r, i) => !idx.has(i) && isNum(r[key]) && r[key] > 0);
      const risky = published ? pinned(hiddenCells, total - visibleSum) : (hiddenCells.length === 1 && visibleNonZero);
      if (!risky) break;
      let next = -1;
      out.forEach((r, i) => { if (!idx.has(i) && isNum(r[key]) && r[key] > 0 && (next < 0 || r[key] < out[next][key])) next = i; });
      if (next < 0) { if (published) tot[key] = SECONDARY; break; }
      idx.add(next); out[next][key] = SECONDARY; out[next].suppressed = true;
    }
  }
  return { rows: out, totals: tot };
}

module.exports = { cell, table, star, noLonely, pinned, isSmall, SECONDARY, WITHHELD, primary };
