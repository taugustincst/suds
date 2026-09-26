'use strict';
// An independent attacker on a publication release (test/publication-release.test.js). It reads the three
// reports as they are published - the funder report, the NDP log by month and the opioid settlement report -
// writes down on its own what they say (a number, "<T" = 1..T-1, "suppressed" = at least T for a count of
// people, "withheld" = unknown) and what anyone knows about how the figures relate, and then, for every
// hidden or unprinted count of people, works out exactly which values are still possible.
//
// Besides the numbers it reads which rows are listed (a table that lists only its non-zero rows says each
// listed row is at least 1 and each missing key is 0), the order they are listed in (by size says which is
// larger), the episodes (opened in the period at most closed plus open at the end) and the naloxone doses
// (1 to 20 per reversal, at most 20 per event). With those, it finds the leaks of 1.12.2.
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
// The most doses one event may record (server/routes/overdose.js validates it; the attacker knows the rule).
const DOSES_MAX = 20;
const FOLDED = 'Other (combined)';
const plainOrder = (a, b) => { const x = String(a); const y = String(b); return x < y ? -1 : x > y ? 1 : 0; };

/**
 * What the rows a breakdown lists say, whatever the publisher's rule, as long as it is one of the two SUDS
 * has used: list every key of a fixed list (the months of the period, a code list) zero or not, plus any
 * other key that is not zero; or list only the keys that are not zero. printed: keys printed; domain: the
 * fixed list (public: the period and the code lists); gone: the table is withheld and printed nothing;
 * truthKeys: the true keys, used only for a withheld table (the attacker is assumed to know them, which only
 * makes it stronger). Returns { keys to model, atLeast1: keys known not to be 0, zero: keys known to be 0 }.
 */
function listing(printed, shownZero, domain, gone, truthKeys) {
  const pk = new Set(printed);
  const keys = [...new Set([...domain, ...printed, ...(gone && !printed.length ? truthKeys : [])])];
  const out = { keys, atLeast1: [], zero: [] };
  if (printed.length) {
    const full = domain.length > 0 && domain.every(k => pk.has(k));
    if (full) out.atLeast1 = printed.filter(k => !domain.includes(k)); // outside the list: listed because not 0
    else if (!shownZero) { out.atLeast1 = printed; out.zero = keys.filter(k => !pk.has(k)); } // only rows that are not 0
  } else if (!gone) out.zero = keys; // nothing printed and nothing withheld: all 0
  else out.atLeast1 = truthKeys.filter(k => !domain.includes(k));
  return out;
}
/** Consecutive rows in an order that is not the fixed one (list order, then key) are in order of size. */
function sizeOrdered(keys, domain, fixedLast) {
  const rank = (k) => { const i = domain.indexOf(k); return i >= 0 ? i : domain.length; };
  const fixed = keys.slice().sort((a, b) => ((a === fixedLast) - (b === fixedLast)) || (rank(a) - rank(b)) || plainOrder(a, b));
  return fixed.some((k, i) => k !== keys[i]);
}

/**
 * The attacker's model of a release. pub: { funder, settlement, ndp, domains: { months, administered_by,
 * discharge_reasons }, withheld: table ids } as published; truth: the same figures exact ({ funder, settlement }
 * from exact runs). Returns { solver, vars: [{ name, shown, truth, people }] }.
 */
function modelOf(pub, truth, T, { symbolic = false } = {}) {
  const vars = []; const byName = new Map(); const cons = [];
  const tf = truth.funder;
  const dom = { months: [], administered_by: [], discharge_reasons: [], ...(pub.domains || {}) };
  const gone = new Set(pub.withheld || (pub.funder.release && pub.funder.release.withheld) || []);
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
  tv.set('Dall', od.naloxone_doses || 0); tv.set('Dr', od.by_month.reduce((a, m) => a + (m.reversal_doses || 0), 0));
  for (const m of od.by_month) { tv.set(`n:${m.month}`, m.n); tv.set(`r:${m.month}`, m.reversals); tv.set(`d:${m.month}`, m.reversal_doses || 0); }
  for (const x of od.by_administered_by) tv.set(`by:${x.k}`, x.n);
  const te = tf.episodes;
  tv.set('D', te.discharges); tv.set('A', te.admissions); tv.set('O', te.open_at_end); for (const x of te.by_discharge_reason) tv.set(`dis:${x.k}`, x.n);
  const CAP = Math.max(0, ...tv.values()) + 3 * T + 2;
  // A key the data do not hold is truly 0.
  const truthOf = (name) => (tv.has(name) ? tv.get(name) : /^(n|r|d|by|dis):/.test(name) ? 0 : undefined);

  // A variable, and what a published symbol says about it (read again, from another report: both hold).
  const V = (name, shown, people = true) => {
    let i = byName.get(name);
    if (i === undefined) { i = vars.length; byName.set(name, i); vars.push({ name, shown: [], truth: truthOf(name), people, lo: 0, hi: CAP }); }
    const x = vars[i];
    if (shown !== undefined) {
      x.shown.push(shown);
      // symbolic: what the symbols alone say - a number only as its class (0, or at least T for people).
      const num = (v) => (!symbolic ? [v, v] : v === 0 ? [0, 0] : people ? [T, CAP] : [0, CAP]);
      const [a, b] = isNum(shown) ? num(shown) : shown === `<${T}` ? [1, T - 1] : shown === 'suppressed' ? [people ? T : 0, CAP] : [0, CAP];
      x.lo = Math.max(x.lo, a); x.hi = Math.min(x.hi, b);
    }
    return i;
  };
  const add = (terms, op, rhs = 0) => cons.push({ terms, op, rhs });
  // A relationship that holds for what SUDS records but not for every imported row: the attacker assumes it
  // whenever the truth satisfies it (an attacker assuming it otherwise would reason from something false).
  const holds = (terms, op, rhs) => { const s = terms.reduce((a, [i, c]) => a + c * vars[i].truth, 0); return op === '<=' ? s <= rhs : op === '>=' ? s >= rhs : s === rhs; };
  const addIfTrue = (terms, op, rhs = 0) => { if (holds(terms, op, rhs)) add(terms, op, rhs); };
  const derived = [];
  const rest = (name, i) => derived.push({ name: `${name} (rest)`, terms: [[V('N'), 1], [i, -1]] });
  const atLeast = (i, v) => { vars[i].lo = Math.max(vars[i].lo, v); };
  const exactly = (i, v) => { vars[i].lo = Math.max(vars[i].lo, v); vars[i].hi = Math.min(vars[i].hi, v); };
  // Which rows are listed, and in what order, is a publisher's choice, not a symbol: what the symbols alone
  // say reads a list as if every key of it were listed, in the fixed order.
  const ordered = (idx) => { if (symbolic) return; for (let j = 0; j + 1 < idx.length; j++) add([[idx[j], 1], [idx[j + 1], -1]], '>='); };
  const list = (printed, shownZero, domain, gone, truthKeys) => {
    const L = listing(printed, shownZero, domain, gone, truthKeys);
    if (symbolic) { L.atLeast1 = L.atLeast1.filter(k => !domain.includes(k)); L.zero = []; }
    return L;
  };

  // ---- the funder report ----
  const f = pub.funder;
  const N = V('N', f.unduplicated.served);
  for (const k of ['on_mat', 'with_a_referral', 'admitted_after_referral']) { const i = V(k, f.unduplicated[k]); add([[i, 1], [N, -1]], '<='); rest(k, i); }
  // Each single-valued breakdown adds up to the people served (a withheld one is printed as no rows: its
  // cells are unknown, but still add up). Rows listed by size say which hidden count is larger.
  for (const k of ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity']) {
    const rows = f.demographics[k].length ? f.demographics[k] : tf.demographics[k].map(x => ({ k: x.k, n: 'withheld' }));
    const idx = rows.map(x => V(`${k}:${x.k}`, x.n));
    add([...idx.map(i => [i, 1]), [N, -1]], '=');
    if (f.demographics[k].length && sizeOrdered(rows.map(x => x.k), [], FOLDED)) ordered(idx);
  }
  const race = f.demographics.by_race_code.length ? f.demographics.by_race_code : tf.demographics.by_race_code.map(x => ({ k: x.k, n: 'withheld' }));
  const ri = race.map(x => V(`by_race_code:${x.k}`, x.n));
  ri.forEach((i, j) => { add([[i, 1], [N, -1]], '<='); rest(`race ${race[j].k}`, i); });
  if (ri.length) add([...ri.map(i => [i, 1]), [N, -1]], '>=');
  if (f.demographics.by_race_code.length && sizeOrdered(race.map(x => x.k), [], FOLDED)) ordered(ri);
  const unk = race.findIndex(x => x.k === 'unknown');
  if (unk >= 0) ri.forEach((i, j) => { if (j !== unk) add([[i, 1], [ri[unk], 1], [N, -1]], '<='); });
  for (const r of f.by_funding_source) {
    const p = V(`fund:${r.id}:p`, r.clients_served); const s = V(`fund:${r.id}:s`, r.services, false);
    add([[p, 1], [N, -1]], '<='); add([[p, 1], [s, -1]], '<='); rest(`fund ${r.name}`, p);
  }

  // Overdose events, by month, in the funder report and again in the NDP log.
  const E = V('E', f.overdose.events); const R = V('R', f.overdose.reversals); const F = V('F', f.overdose.fatal); const C = V('C', f.overdose.community_reported);
  const ndpRows = pub.ndp.rows.filter(x => x.entry === 'reversal');
  const monthsGone = !f.overdose.by_month.length && gone.has('overdose.by_month.n') && gone.has('overdose.by_month.reversals');
  const ndpGone = !ndpRows.length && gone.has('overdose.by_month.reversals');
  const truthMonths = od.by_month.map(m => m.month);
  const fl = list(f.overdose.by_month.map(m => m.month), f.overdose.by_month.some(m => m.n === 0), dom.months, monthsGone, truthMonths);
  const nl = list(ndpRows.map(x => x.date), ndpRows.some(x => x.reversals === 0), dom.months, ndpGone, truthMonths);
  const months = [...new Set([...fl.keys, ...nl.keys, ...(monthsGone || ndpGone ? truthMonths : [])])].sort();
  const n = (m) => V(`n:${m}`); const r = (m) => V(`r:${m}`); const d = (m) => V(`d:${m}`, undefined, false);
  for (const m of f.overdose.by_month) { V(`n:${m.month}`, m.n); V(`r:${m.month}`, m.reversals); }
  for (const x of ndpRows) { V(`r:${x.date}`, x.reversals); V(`d:${x.date}`, x.reversal_doses, false); }
  add([...months.map(m => [n(m), 1]), [E, -1]], '=');
  add([...months.map(m => [r(m), 1]), [R, -1]], '=');
  for (const m of months) {
    add([[r(m), 1], [n(m), -1]], '<=');
    derived.push({ name: `${m} not reversed`, terms: [[n(m), 1], [r(m), -1]] });
  }
  // Which months are listed: in the funder report a month is listed for its events; in the NDP log, when it
  // does not list every month, for its reversals.
  for (const m of fl.atLeast1) atLeast(n(m), 1);
  for (const m of fl.zero) exactly(n(m), 0);
  const ndpFull = dom.months.length > 0 && dom.months.every(m => ndpRows.some(x => x.date === m));
  for (const m of nl.atLeast1) atLeast(ndpFull ? n(m) : r(m), 1);
  for (const m of nl.zero) exactly(r(m), 0);
  add([[F, 1], [E, -1]], '<='); add([[C, 1], [E, -1]], '<=');
  // Fatal and reversed events are distinct for everything recorded through SUDS (not for every imported row).
  addIfTrue([[F, 1], [R, 1], [E, -1]], '<=');
  derived.push({ name: 'E-R', terms: [[E, 1], [R, -1]] }, { name: 'E-F', terms: [[E, 1], [F, -1]] }, { name: 'E-C', terms: [[E, 1], [C, -1]] }, { name: 'E-R-F', terms: [[E, 1], [R, -1], [F, -1]] });
  // Who gave the naloxone: adds up to the reversals.
  const byRows = f.overdose.by_administered_by;
  const bl = list(byRows.map(x => x.k), byRows.some(x => x.n === 0), dom.administered_by, !byRows.length && gone.has('overdose.by_administered_by'), od.by_administered_by.map(x => x.k));
  for (const x of byRows) V(`by:${x.k}`, x.n);
  add([...bl.keys.map(k => [V(`by:${k}`), 1]), [R, -1]], '=');
  for (const k of bl.atLeast1) atLeast(V(`by:${k}`), 1);
  for (const k of bl.zero) exactly(V(`by:${k}`), 0);
  if (byRows.length && sizeOrdered(byRows.map(x => x.k), dom.administered_by)) ordered(byRows.map(x => V(`by:${x.k}`)));

  // Naloxone doses: each reversal records 1 to DOSES_MAX, and every event at most DOSES_MAX.
  const Dall = V('Dall', f.overdose.naloxone_doses, false); const Dr = V('Dr', pub.ndp.totals.reversal_doses, false);
  add([...months.map(m => [d(m), 1]), [Dr, -1]], '=');
  for (const m of months) { addIfTrue([[d(m), 1], [r(m), -1]], '>='); addIfTrue([[d(m), 1], [r(m), -DOSES_MAX]], '<='); }
  addIfTrue([[Dall, 1], [Dr, -1]], '>='); addIfTrue([[Dall, 1], [E, -DOSES_MAX]], '<='); addIfTrue([[Dall, 1], [Dr, -1], [E, -DOSES_MAX], [R, DOSES_MAX]], '<=');

  // Episodes: discharges add up by reason; every episode opened in the period is closed in it or open at its
  // end, so the episodes carried in from before are D + O - A >= 0.
  const D = V('D', f.episodes.discharges); const A = V('A', f.episodes.admissions); const O = V('O', f.episodes.open_at_end);
  const disRows = f.episodes.by_discharge_reason;
  const dl = list(disRows.map(x => x.k), disRows.some(x => x.n === 0), dom.discharge_reasons, !disRows.length && gone.has('episodes.by_discharge_reason'), te.by_discharge_reason.map(x => x.k));
  for (const x of disRows) V(`dis:${x.k}`, x.n);
  add([...dl.keys.map(k => [V(`dis:${k}`), 1]), [D, -1]], '=');
  for (const k of dl.atLeast1) atLeast(V(`dis:${k}`), 1);
  for (const k of dl.zero) exactly(V(`dis:${k}`), 0);
  if (disRows.length && sizeOrdered(disRows.map(x => x.k), dom.discharge_reasons)) ordered(disRows.map(x => V(`dis:${x.k}`)));
  addIfTrue([[A, 1], [D, -1], [O, -1]], '<=');
  derived.push({ name: 'episodes carried in', terms: [[D, 1], [O, 1], [A, -1]] });

  // ---- the NDP log's total reversals ----
  V('R', pub.ndp.totals.reversals);

  // ---- the settlement report ----
  const listed = new Set(f.by_funding_source.map(x => x.id));
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
  for (const dv of derived) {
    const i = vars.length; vars.push({ name: dv.name, shown: [], truth: dv.terms.reduce((a, [j, c]) => a + c * vars[j].truth, 0), people: true, derived: true, lo: -CAP * 3, hi: CAP * 3 });
    add([[i, 1], ...dv.terms.map(([j, c]) => [j, -c])], '=');
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
  // "1 and T-1", or as near them as the symbols alone allow: served "<T" beside women "<T" and men "<T" says
  // there are at most T-2 women whatever else is printed (the numbers read only as their class).
  const sym = modelOf(pub, truth, T, { symbolic: true }).solver;
  const targets = (i) => {
    let a = 1; while (a < T && !sym.can(i, a)) a++;
    let b = T - 1; while (b > a && !sym.can(i, b)) b--;
    return a >= T ? [] : [...new Set([a, b])];
  };
  const out = [];
  const P = Math.ceil(T / 2);
  vars.forEach((x, i) => {
    if (!x.people || x.truth === undefined) return;
    const shown = x.shown;
    const small = shown.includes(`<${T}`) || ((x.derived || !shown.length || shown.every(s => s === 'withheld')) && x.truth > 0 && x.truth < T && !shown.some(isNum));
    if (small) {
      for (const v of targets(i)) if (!solver.can(i, v)) out.push(`${x.name} (${shown.join('/') || 'unprinted'}, truly ${x.truth}) cannot be ${v}`);
    } else if (shown.includes('suppressed') && !shown.some(isNum)) {
      const [a, b] = solver.range(i);
      if (b - a < P) out.push(`${x.name} (suppressed, truly ${x.truth}) lies in [${a}, ${b}]`);
    }
  });
  return out;
}

module.exports = { makeSolver, modelOf, attack };
