'use strict';
// The audit of a county publication release as a pure function of its figures (released in 1.21.0;
// docs/COUNTY-VIEW.md "Publication"; server/county-publication.js reads the combined view and serves the result).
// It runs in the publication audit's worker thread (server/release-audit-worker.js, kind 'county'), and inline in
// the tests that call it directly.
//
// What is published: the combined county figures for one period. Money and the outcomes that are not counts of
// people (contacts, kits, strips, syringes, education sessions, staff training hours: settlement-outcome-map.js kind
// 'count') are exact, as in a programme's own publication release. The outcomes that are counts of people or of
// events that each happen to one person (kind 'person' and 'event': people served, referrals made, people linked to
// care and to MOUD, people trained, reversals, treatment admissions) are the county totals, screened by the same
// small-cell method a programme's own release uses (server/sdc.js protect, the threshold T): a total of 1 to T-1
// shows "<T", and more is hidden until every small count is protected.
//
// Differencing (market/DATA-NETWORK.md, "The basis"): each programme may publish its own release, so a reader may
// hold every programme's own figure beside the county's total and subtract. The model gives the reader the most any
// programme's own release can say: each programme's figure for each measure is a cell that release prints (sdc.js
// `fixed`: its number when 0 or at least T, "<T" when 1 to T-1), never hidden or withheld by this audit. The county's
// totals are then hidden until every programme's small figure is protected against the totals AND every other
// programme's figures (complementary suppression, sdc.js run and consistent: the reader knows the method too). A
// reader who holds less (a programme that publishes nothing, or hides more) learns less.
//
// What goes into the model, per measure m (each measure its own table, `total.<m>`):
//   * x[p][m], each programme's figure (fixed, table `programme.<p>.<m>`); X[m], the county total; X[m] = sum x[p][m];
//   * within a programme, people linked to MOUD are among its people linked to care, and those among its people
//     served (settlement-outcome-map.js: a referral counts for a fund when the person was served under it). Soft: a
//     programme's figures the county entered need not keep them, and a relationship the figures break is left out
//     (sdc.js relationships).
// A total the check cannot protect is withheld (its table; listed with why), and the release is refused only when
// even that cannot be shown safe or the audit runs out of its budget. Deterministic: the same figures give the same
// release (sdc.js counts its budget in solver work).
const SDC = require('./sdc');
const SC = require('./small-cells');
const MAP = require('./settlement-outcome-map');

/** The measures whose county totals are screened: counts of people, and events that each happen to one person. */
const SCREENED = Object.keys(MAP.INDICATORS).filter(k => MAP.INDICATORS[k].kind !== 'count');
/** Per programme, a subset each is at most (soft: figures the county entered may break it). */
const WITHIN = [['moud_linked', 'people_linked'], ['people_linked', 'people_served']];
// A wall-clock backstop only, as for a programme's release (release-audit.js AUDIT_BACKSTOP_MS).
const AUDIT_BACKSTOP_MS = 60000;

/**
 * The measures in groups that share no relationship (WITHIN ties people served, linked and linked to MOUD; each other
 * measure stands alone). Each group is audited on its own (protectCounty): what one prints depends on its own figures
 * only, so a reader learns nothing more from them together, and a county of many programmes stays within the budget.
 */
const GROUPS = (() => {
  const parent = new Map(SCREENED.map(m => [m, m]));
  const find = (m) => (parent.get(m) === m ? m : find(parent.get(m)));
  for (const [a, b] of WITHIN) parent.set(find(a), find(b));
  const out = new Map(); for (const m of SCREENED) { const r = find(m); if (!out.has(r)) out.set(r, []); out.get(r).push(m); }
  return [...out.values()];
})();

/**
 * The model of one group of measures. inputs: { programmes: [{ values: { measure: n } }] } in a fixed order (the
 * combined view's, by name); the true figures of the screened measures only.
 */
function buildModel({ programmes }, T, measures = SCREENED) {
  const vars = []; const cons = [];
  const v = (id, value, o = {}) => { vars.push({ id, value, people: true, total: !!o.total, table: o.table, published: true, ...(o.fixed ? { fixed: true } : {}) }); return vars.length - 1; };
  const h = { x: programmes.map(() => ({})), X: {} };
  for (const m of measures) {
    const parts = programmes.map((p, i) => { const j = v(`programme.${i}.${m}`, p.values[m], { fixed: true, table: `programme.${i}.${m}` }); h.x[i][m] = j; return j; });
    const X = h.X[m] = v(`total.${m}`, programmes.reduce((n, p) => n + p.values[m], 0), { total: true, table: `total.${m}` });
    if (parts.length) cons.push({ terms: [...parts.map(j => [j, 1]), [X, -1]], op: '=', rhs: 0 });
  }
  const within = WITHIN.filter(([a, b]) => measures.includes(a) && measures.includes(b));
  programmes.forEach((p, i) => { for (const [a, b] of within) cons.push({ terms: [[h.x[i][a], 1], [h.x[i][b], -1]], op: '<=', rhs: 0, soft: true }); });
  return { model: { vars, cons, derived: [], mirror: [], keep: [] }, h };
}

// FNV-1a (64-bit, as two halves), as release-audit.js digest: the release's id, a digest of every total it prints.
const { digest } = require('./release-audit');

const WITHHELD_WHY = {
  protect: 'Too few people to show it without giving someone away, once each program\'s own figures are subtracted.',
  check: 'The automatic check could not confirm that the programs\' small figures are protected beside it, so it was left out and the rest was checked again without it.',
};

/** Why a county release was refused, for the person who prepared it. */
function refusalMessage(r) {
  const why = r.backstop ? 'the check of these figures ran past the server\'s time limit'
    : r.outOfBudget ? 'the check of these figures reached its limit before it could finish'
      : 'the check could not confirm that every program\'s small figures are protected';
  return `These figures cannot be published: ${why}, so no publication release was made. Try a longer period (a quarter or a year), or leave out the figures entered by the county. The combined view, for authorised county staff, is unaffected.`;
}

/**
 * Screen the county totals of one period. inputs: { programmes: [{ values }] }. Returns { shown: { measure: number |
 * "<T" | "suppressed" | "withheld" }, reason: { measure: 'small' | 'complementary' | 'withheld' }, withheld_tables,
 * withheld_reasons, id, audit: { steps, rounds, degraded } } or { refused: { message, out_of_budget, backstop,
 * unprotected } }.
 */
function protectCounty(inputs, T, { budget, stepLimit, timeLimitMs = AUDIT_BACKSTOP_MS, degrade = true } = {}) {
  const started = Date.now();
  const shown = {}; const reason = {}; const withheldTables = []; const withheldReasons = []; const parts = [];
  const stats = { steps: 0, rounds: 1, degraded: [] };
  for (const measures of GROUPS) {
    const { model, h } = buildModel(inputs, T, measures);
    // The wall-clock backstop is shared by the groups; the step budget (what decides the release) is each group's own.
    const left = Math.max(1, timeLimitMs - (Date.now() - started));
    const audit = SDC.protect(model, T, { ...(budget === undefined ? {} : { budget }), ...(stepLimit === undefined ? {} : { stepLimit }), timeLimitMs: left, degrade });
    stats.steps += audit.steps; stats.rounds = Math.max(stats.rounds, audit.rounds); stats.degraded.push(...(audit.degraded || []));
    parts.push({ measures, model, status: audit.status });
    if (!audit.verified) {
      return { refused: { out_of_budget: !!audit.outOfBudget, backstop: !!audit.backstop, unprotected: (audit.unprotected || []).length, message: refusalMessage(audit) }, parts, audit: stats };
    }
    const { status } = audit;
    const show = (i) => (status[i] === 'vis' ? model.vars[i].value : status[i] === 'pri' ? SC.primary(T) : status[i] === 'sec' ? SC.SECONDARY : SC.WITHHELD);
    const why = (i) => (status[i] === 'vis' ? null : status[i] === 'pri' ? 'small' : status[i] === 'sec' ? 'complementary' : 'withheld');
    for (const m of measures) { shown[m] = show(h.X[m]); const r = why(h.X[m]); if (r) reason[m] = r; }
    const degraded = new Set(audit.degraded || []);
    for (const t of [...audit.withheldTables].sort()) {
      withheldTables.push(t);
      withheldReasons.push({ table: t, measure: t.replace(/^total\./, ''), reason: degraded.has(t) ? 'check' : 'protect', why: WITHHELD_WHY[degraded.has(t) ? 'check' : 'protect'] });
    }
  }
  const id = digest(JSON.stringify(SCREENED.map(m => [m, shown[m]])));
  return { shown, reason, withheld_tables: withheldTables, withheld_reasons: withheldReasons, id, parts, audit: stats };
}

module.exports = { protectCounty, buildModel, SCREENED, WITHIN, GROUPS, refusalMessage, WITHHELD_WHY, AUDIT_BACKSTOP_MS };
