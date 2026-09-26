'use strict';
// Small-cell suppression for aggregate reports that may be published or shared (the funder report, the NDP
// log, the opioid settlement report; docs/HIPAA.md "Small cells in aggregate reports").
//
// What is a count of people: people served (in total, per fund, per allowable use, per demographic row),
// referrals, admissions, people on MAT, episodes opened, closed and open (an episode is one person's), each
// discharge reason, overdose events, reversals, fatal and community-reported overdoses (an event happens to
// one person), and who gave the naloxone. What is not: naloxone kits and doses distributed, test strips,
// services (visits), staff hours and money. Those stay exact.
//
// Two steps, in suppressed mode only:
//  * Primary: a count of people above 0 and below the threshold T is shown as "<T". Zero stays 0.
//  * Complementary (secondary): wherever a hidden cell could still be worked out — by subtracting the visible
//    cells of its table from a published total, or because the bounds the others leave pin it to one value
//    (two "<11" cells under a total that leaves 2 must both be 1) — the next-smallest visible cell is hidden
//    too, shown as "suppressed"; if none is left, the total is. A breakdown with no published total still
//    never has exactly one hidden cell beside visible ones, since a related figure elsewhere might give it away.
// A figure derived from the same small group (the naloxone doses used in a hidden reversal row) is hidden
// with it ("mirror"), and then protected the same way.

const SECONDARY = 'suppressed';
const primary = (T) => `<${T}`;
const isSmall = (v, T) => typeof v === 'number' && v > 0 && v < T;
const isNum = (v) => typeof v === 'number';

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
 * A table of rows, one or more count columns. keys: the columns that count people; mirror: { column: the
 * people column it is hidden with } for figures about the same group that are not themselves people;
 * totals: { column: its published total } (omit a column with no published total). Returns new rows and totals.
 */
function table(rows, keys, { threshold: T, exact = false, totals = {}, mirror = {} }) {
  const out = rows.map(r => ({ ...r }));
  const tot = { ...totals };
  if (exact) return { rows: out, totals: tot };
  const hiddenIdx = {};
  const protect = (key, bounds) => {
    const idx = hiddenIdx[key];
    let total = tot[key];
    const published = isNum(total);
    for (;;) {
      const hidden = [...idx].map(i => ({ v: rows[i][key], ...bounds(i) }));
      if (!hidden.length) return;
      const visibleSum = out.reduce((a, r, i) => a + (idx.has(i) || !isNum(r[key]) ? 0 : r[key]), 0);
      const visibleNonZero = out.some((r, i) => !idx.has(i) && isNum(r[key]) && r[key] > 0);
      const risky = published ? pinned(hidden, total - visibleSum) : (hidden.length === 1 && visibleNonZero);
      if (!risky) return;
      // The next-smallest visible cell above zero is hidden with it.
      let next = -1;
      out.forEach((r, i) => { if (!idx.has(i) && isNum(r[key]) && r[key] > 0 && (next < 0 || r[key] < out[next][key])) next = i; });
      if (next < 0) { if (published) tot[key] = SECONDARY; return; }
      idx.add(next); out[next][key] = SECONDARY; out[next].suppressed = true;
    }
  };
  for (const key of keys) {
    // A total that is itself a small count of people is hidden; there is then nothing to subtract from.
    if (isSmall(tot[key], T)) tot[key] = primary(T);
    hiddenIdx[key] = new Set();
    rows.forEach((r, i) => { if (isSmall(r[key], T)) { hiddenIdx[key].add(i); out[i][key] = primary(T); out[i].suppressed = true; } });
    const prim = new Set(hiddenIdx[key]);
    // A cell shown as "<T" is known to lie in [1, T-1]; one hidden to protect it is known only to be at least 1.
    protect(key, (i) => (prim.has(i) ? { lo: 1, hi: T - 1 } : { lo: 1, hi: Infinity }));
  }
  for (const [key, of] of Object.entries(mirror)) {
    hiddenIdx[key] = new Set();
    for (const i of hiddenIdx[of] || []) if (out[i][key] !== null && out[i][key] !== undefined) { hiddenIdx[key].add(i); out[i][key] = SECONDARY; }
    const mirrored = new Set(hiddenIdx[key]);
    protect(key, (i) => (mirrored.has(i) ? { lo: 0, hi: Infinity } : { lo: 1, hi: Infinity }));
  }
  return { rows: out, totals: tot };
}

module.exports = { cell, table, pinned, isSmall, SECONDARY, primary };
