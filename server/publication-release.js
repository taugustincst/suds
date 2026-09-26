'use strict';
// One publication release per standard period that has ended, for the whole programme (docs/HIPAA.md "Small
// cells in aggregate reports"; docs/compliance/HARM-REDUCTION-REPORTING.md).
//
// The funder report, the NDP log (by month) and the opioid settlement report for such a period are three
// views of one release. They are computed together, from one read of the data (nothing else runs while the
// figures are read), and every count of people any of them prints goes into one model of what a reader of
// all three learns (server/sdc.js): the true count behind every cell, every relationship between them, and
// what each cell shows. The audit hides cells until every sensitive count is protected, and each report then
// prints its part of the same result. Whichever report is asked for, and however often, the same data give
// the same release (the audit is deterministic), and each response carries the release's id: a digest of
// every number the release prints, identical in all three.
//
// What goes into the model (every relationship here holds for the true counts by construction; the audit
// checks that it does):
//   * people served N; five single-valued breakdowns (gender, language, housing, insurance, ethnicity), each
//     adding up to N; on MAT, referred, admitted, each at most N; race codes, each at most N, together at
//     least N (a person may report several), and "unknown" plus any other code at most N (unknown means
//     none reported);
//   * people per fund (each at most N, and at most that fund's services: a person is served at least once),
//     the fund's services (hidden with its people); a settlement fund no longer active, which the funder
//     report does not list, as an unprinted count tied to the settlement report;
//   * people per settlement allowable use: at most N, at most its services, at least the people of each fund
//     with that use and at most their sum; its services are exactly the sum of those funds' services;
//   * the overdose events E: by month (adding up to E); reversals R by month and by who gave the naloxone
//     (each adding up to R), the reversals in a month at most that month's events; fatal F and community-
//     reported C at most E; F + R at most E (an event recorded through SUDS is never both: a fatal one is
//     saved as not survived. A row imported or synced as both breaks it, and then it is left out);
//   * episodes: discharges add up by reason; the episodes opened in the period are at most those closed in it
//     plus those open at its end (every episode opened in the period is one or the other; left out for a
//     period where a stored episode closes before it opened: the close route refuses one, a back-dated fatal
//     overdose or an import can still write one), and the
//     difference is the episodes carried in from before the period, a count of people;
//   * naloxone doses: the doses used in a month's reversals (NDP log) add up to the release's total; each
//     reversal records at least one dose and at most NALOXONE_DOSES_MAX, so a month's doses lie between its
//     reversals and NALOXONE_DOSES_MAX times them; all doses used (funder report) are at least the doses used
//     in reversals and at most NALOXONE_DOSES_MAX per event, and the rest at most that per event not reversed
//     (each left out for a period whose records break it). Doses are hidden with the reversals they bound;
//   * which rows are listed: a breakdown with a fixed list of keys (every month of the period; the "given by"
//     and discharge-reason lists) lists every key, zero or not, so the rows present say nothing; a key
//     outside the list is listed only because it is not zero, and the model says so (at least 1). Rows are
//     in a fixed order (the list's, or by key), never by size, which would say which hidden count is larger.
//     A table withheld whole prints no rows.
// Counts printed nowhere but worked out from printed ones are sensitive when they are small (1 to T-1): the
// people left when on MAT, referred, admitted, a fund, a use or a race code are taken from N; a use's people
// not under one of its funds; E-R, E-F, E-C, E-R-F; each month's events that were not reversals; the
// episodes carried in.
// Kits, test strips, money and staff hours are not counts of people and bound none, so they stay out.
//
// A free-text breakdown (language, housing, insurance, ethnicity, gender, race codes) lists at most
// FR.FOLD_KEEP keys under the threshold, the first by key; the rest are combined as FR.FOLDED before the
// audit (server/funder-report.js figures), which keeps the audit small whatever an import wrote.
//
// The audit is verified (server/sdc.js): if any sensitive count is still not protected when it stops, or it
// runs past AUDIT_TIME_LIMIT_MS, the release is refused, never published unverified.
const FR = require('./funder-report');
const SC = require('./small-cells');
const SDC = require('./sdc');
const C = require('./constants');
const { HttpError } = require('./http');

const PARTITIONS = ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity'];
const DOSES_MAX = C.NALOXONE_DOSES_MAX;
// The audit runs synchronously; past this it stops and the release is refused.
const AUDIT_TIME_LIMIT_MS = 5000;

const byKey = (a, b) => { const x = String(a); const y = String(b); return x < y ? -1 : x > y ? 1 : 0; };
/** Every month (YYYY-MM) from `from` to `to`. */
function monthsOf(from, to) {
  const out = []; let y = Number(from.slice(0, 4)); let m = Number(from.slice(5, 7)); const end = to.slice(0, 7);
  while (out.length < 1200) { const k = `${y}-${String(m).padStart(2, '0')}`; if (k > end) break; out.push(k); if (++m > 12) { m = 1; y++; } }
  return out;
}
/**
 * A breakdown's rows as the release lists them: every key of its fixed list in the list's order, zero or
 * not, then any other key the data hold (by key). byKeyAll: all rows in key order instead (months).
 * Returns [{ row, fixed }]; fixed false: listed only because it is not zero.
 */
function onDomain(rows, keys, key, zero, byKeyAll = false) {
  const have = new Map(rows.map(x => [x[key], x])); const set = new Set(keys || []);
  const out = (keys || []).map(k => ({ row: have.get(k) || zero(k), fixed: true }))
    .concat(rows.filter(x => !set.has(x[key])).sort((a, b) => byKey(a[key], b[key])).map(x => ({ row: x, fixed: false })));
  return byKeyAll ? out.sort((a, b) => byKey(a.row[key], b.row[key])) : out;
}
const keyOrder = (rows) => rows.slice().sort((a, b) => ((a.k === FR.FOLDED) - (b.k === FR.FOLDED)) || byKey(a.k, b.k));
/** The funder report's figures with each breakdown listed and ordered as the release prints it. domains: { months, administered_by, discharge_reasons }. */
function prepare(raw, domains = {}) {
  const od = raw.overdose; const ep = raw.episodes;
  const months = onDomain(od.by_month, domains.months, 'month', (month) => ({ month, n: 0, reversals: 0, reversal_doses: 0 }), true);
  const by = onDomain(od.by_administered_by, domains.administered_by, 'k', (k) => ({ k, n: 0 }));
  const dis = onDomain(ep.by_discharge_reason, domains.discharge_reasons, 'k', (k) => ({ k, n: 0 }));
  return {
    ...raw,
    demographics: Object.fromEntries(Object.entries(raw.demographics).map(([k, rows]) => [k, keyOrder(rows)])),
    episodes: { ...ep, by_discharge_reason: dis.map(x => x.row) },
    overdose: { ...od, by_month: months.map(x => x.row), by_administered_by: by.map(x => x.row) },
    fixed: { months: months.map(x => x.fixed), by: by.map(x => x.fixed), dis: dis.map(x => x.fixed) },
  };
}

/** The model of one release. inputs: { funder: the funder report's figures as prepare() lists them, perFund: Map id -> { services, clients_served }, settlement: { services_by_use, fundKeys } }. */
function buildModel({ funder: raw, perFund, settlement }) {
  const vars = []; const cons = []; const derived = []; const mirror = [];
  const v = (id, value, o = {}) => { vars.push({ id, value, people: o.people !== false, total: !!o.total, table: o.table || id, published: o.published !== false }); return vars.length - 1; };
  const rel = (terms, op, rhs = 0) => cons.push({ terms, op, rhs });
  // Holds for everything recorded through SUDS, not for every row an import could write: left out when the
  // figures break it (server/sdc.js).
  const soft = (terms, op, rhs = 0) => cons.push({ terms, op, rhs, soft: true });
  const fixed = raw.fixed || {};
  const present = (idx, f = []) => idx.forEach((i, j) => { if (!f[j]) rel([[i, 1]], '>=', 1); });
  const h = {}; // handles, for printing the result
  const u = raw.unduplicated;
  const N = h.N = v('served', u.served, { total: true, table: 'unduplicated.served' });
  h.newAdm = v('new_admissions', u.new_admissions, { table: 'unduplicated.new_admissions' });
  const subset = (id, value, table, o = {}) => { const i = v(id, value, { table, ...o }); rel([[i, 1], [N, -1]], '<='); derived.push({ id: `${id}:rest`, terms: [[N, 1], [i, -1]] }); return i; };
  h.mat = subset('on_mat', u.on_mat, 'unduplicated.on_mat');
  h.ref = subset('with_a_referral', u.with_a_referral, 'unduplicated.with_a_referral');
  h.adm = subset('admitted_after_referral', u.admitted_after_referral, 'unduplicated.admitted_after_referral');
  h.dem = {};
  for (const k of PARTITIONS) {
    h.dem[k] = raw.demographics[k].map(x => v(`${k}.${x.k}`, x.n, { table: `demographics.${k}` }));
    rel([...h.dem[k].map(i => [i, 1]), [N, -1]], '=');
  }
  const race = raw.demographics.by_race_code;
  h.race = race.map(x => subset(`by_race_code.${x.k}`, x.n, 'demographics.by_race_code'));
  if (h.race.length) rel([...h.race.map(i => [i, 1]), [N, -1]], '>=');
  const unknown = race.findIndex(x => x.k === 'unknown');
  if (unknown >= 0) h.race.forEach((i, j) => { if (j !== unknown) rel([[i, 1], [h.race[unknown], 1], [N, -1]], '<='); });

  // Funds.
  const fundVars = new Map();
  h.funds = raw.by_funding_source.map(f => {
    const p = subset(`fund.${f.id}.people`, f.clients_served, 'by_funding_source');
    const s = v(`fund.${f.id}.services`, f.services, { people: false, table: 'by_funding_source' });
    rel([[p, 1], [s, -1]], '<='); mirror.push([p, s]); fundVars.set(f.id, { p, s });
    return { p, s };
  });
  // Settlement uses.
  const byUseKey = new Map();
  for (const f of settlement.fundKeys) {
    const act = perFund.get(f.id); if (!act || !act.services) continue; // no work in the period: 0, and known to be
    if (!fundVars.has(f.id)) {
      // A settlement fund the funder report does not list (no longer active): printed nowhere, tied to its use.
      const p = subset(`fund.${f.id}.people`, act.clients_served, `unpublished.fund.${f.id}`, { published: false });
      const s = v(`fund.${f.id}.services`, act.services, { people: false, table: `unpublished.fund.${f.id}`, published: false });
      rel([[p, 1], [s, -1]], '<='); fundVars.set(f.id, { p, s });
    }
    if (!byUseKey.has(f.key)) byUseKey.set(f.key, []);
    byUseKey.get(f.key).push(fundVars.get(f.id));
  }
  h.uses = settlement.services_by_use.map(x => {
    const p = subset(`use.${x.use_code}.people`, x.people, 'settlement.services_by_use');
    const s = v(`use.${x.use_code}.services`, x.services, { people: false, table: 'settlement.services_by_use' });
    rel([[p, 1], [s, -1]], '<='); mirror.push([p, s]);
    const fs = byUseKey.get(x.use_code) || [];
    if (fs.length) {
      rel([[s, 1], ...fs.map(f => [f.s, -1])], '=');
      rel([[p, 1], ...fs.map(f => [f.p, -1])], '<=');
      for (const f of fs) { rel([[p, 1], [f.p, -1]], '>='); derived.push({ id: `use.${x.use_code}-${vars[f.p].id}`, terms: [[p, 1], [f.p, -1]] }); }
    }
    return { p, s };
  });

  // Episodes.
  const ep = raw.episodes;
  h.epAdm = v('episodes.admissions', ep.admissions, { table: 'episodes.admissions' });
  h.epOpen = v('episodes.open_at_end', ep.open_at_end, { table: 'episodes.open_at_end' });
  h.D = v('episodes.discharges', ep.discharges, { total: true, table: 'episodes.discharges' });
  h.dis = ep.by_discharge_reason.map(x => v(`discharge.${x.k}`, x.n, { table: 'episodes.by_discharge_reason' }));
  rel([...h.dis.map(i => [i, 1]), [h.D, -1]], '=');
  present(h.dis, fixed.dis);
  // Opened in the period: closed in it, or still open at its end. What is left is carried in from before.
  soft([[h.epAdm, 1], [h.D, -1], [h.epOpen, -1]], '<=');
  derived.push({ id: 'episodes.carried_in', terms: [[h.D, 1], [h.epOpen, 1], [h.epAdm, -1]] });

  // Overdose.
  const od = raw.overdose;
  const E = h.E = v('overdose.events', od.events, { total: true, table: 'overdose.events' });
  const R = h.R = v('overdose.reversals', od.reversals, { total: true, table: 'overdose.reversals' });
  const F = h.F = v('overdose.fatal', od.fatal, { table: 'overdose.fatal' });
  const Cm = h.C = v('overdose.community_reported', od.community_reported, { table: 'overdose.community_reported' });
  h.n = od.by_month.map(x => v(`overdose.${x.month}.events`, x.n, { table: 'overdose.by_month.n' }));
  h.r = od.by_month.map(x => v(`overdose.${x.month}.reversals`, x.reversals, { table: 'overdose.by_month.reversals' }));
  h.by = od.by_administered_by.map(x => v(`overdose.by.${x.k}`, x.n, { table: 'overdose.by_administered_by' }));
  rel([...h.n.map(i => [i, 1]), [E, -1]], '=');
  rel([...h.r.map(i => [i, 1]), [R, -1]], '=');
  rel([...h.by.map(i => [i, 1]), [R, -1]], '=');
  present(h.n, fixed.months); present(h.by, fixed.by);
  h.n.forEach((n, m) => { rel([[h.r[m], 1], [n, -1]], '<='); derived.push({ id: `overdose.${od.by_month[m].month}.not_reversed`, terms: [[n, 1], [h.r[m], -1]] }); });
  rel([[F, 1], [E, -1]], '<='); rel([[Cm, 1], [E, -1]], '<='); soft([[F, 1], [R, 1], [E, -1]], '<=');
  derived.push({ id: 'overdose.not_reversed', terms: [[E, 1], [R, -1]] }, { id: 'overdose.not_fatal', terms: [[E, 1], [F, -1]] },
    { id: 'overdose.not_community', terms: [[E, 1], [Cm, -1]] }, { id: 'overdose.neither', terms: [[E, 1], [R, -1], [F, -1]] });

  // Naloxone doses: not people, but they bound the reversals and events they were used in.
  h.d = od.by_month.map(x => v(`ndp.${x.month}.reversal_doses`, x.reversal_doses || 0, { people: false, table: 'ndp.by_month.reversal_doses' }));
  const Dr = h.Dr = v('ndp.reversal_doses', od.by_month.reduce((a, x) => a + (x.reversal_doses || 0), 0), { people: false, total: true, table: 'ndp.reversal_doses' });
  const Dall = h.Dall = v('overdose.naloxone_doses', od.naloxone_doses || 0, { people: false, total: true, table: 'overdose.naloxone_doses' });
  rel([...h.d.map(i => [i, 1]), [Dr, -1]], '=');
  h.d.forEach((d, m) => { soft([[d, 1], [h.r[m], -1]], '>='); soft([[d, 1], [h.r[m], -DOSES_MAX]], '<='); mirror.push([h.r[m], d]); });
  soft([[Dall, 1], [Dr, -1]], '>='); soft([[Dall, 1], [E, -DOSES_MAX]], '<='); soft([[Dall, 1], [Dr, -1], [E, -DOSES_MAX], [R, DOSES_MAX]], '<=');
  mirror.push([R, Dr], [R, Dall], [E, Dall]);
  return { model: { vars, cons, derived, mirror }, h };
}

// FNV-1a (64-bit, as two 32-bit halves): a digest that runs the same in Node and in the browser kernel.
function digest(text) {
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Why a release was refused, for the person who asked for it. */
function refusalMessage(r) {
  const why = r.outOfTime ? 'the check of this period\'s figures did not finish in time'
    : 'the check could not confirm that every small count in it is protected';
  return `This period cannot be published: ${why}, so no publication release was made. Publish a longer standard period (a quarter or a year), or ask a supervisor or an administrator for an internal report or the programme's own submission, which are not for publication.`;
}

/**
 * Protect one release's figures (a pure function, so tests can attack it). inputs: { funder, perFund,
 * settlement, domains: { months, administered_by, discharge_reasons } }. Returns what each report prints:
 * { funder: the funder report's figures as suppress() returns them, uses: [{ people, services }] for the
 * settlement report's services_by_use, ndp: { rows: [{ month, reversals, reversal_doses }], reversals,
 * reversal_doses }, withheld_tables, id } - or, when the audit could not verify the release, { refused }
 * and nothing to print.
 */
function protectFigures(inputs, T, { strict = false, budget, timeLimitMs = AUDIT_TIME_LIMIT_MS } = {}) {
  const raw = prepare(inputs.funder, inputs.domains);
  const { model, h } = buildModel({ ...inputs, funder: raw });
  model.strict = strict;
  const audit = SDC.protect(model, T, { ...(budget === undefined ? {} : { budget }), timeLimitMs });
  const { status, withheldTables } = audit;
  if (!audit.verified) {
    return { refused: { out_of_time: audit.outOfTime, unprotected: audit.unprotected.length, message: refusalMessage(audit) }, withheld_tables: withheldTables, status, model };
  }
  const show = (i) => (status[i] === 'vis' ? model.vars[i].value : status[i] === 'pri' ? SC.primary(T) : status[i] === 'sec' ? SC.SECONDARY : SC.WITHHELD);
  const gone = new Set(withheldTables);
  const withheld = [];
  const demographics = {};
  for (const k of [...PARTITIONS.slice(0, 4), 'by_race_code', 'by_ethnicity']) {
    const idx = k === 'by_race_code' ? h.race : h.dem[k];
    if (gone.has(`demographics.${k}`)) { withheld.push(k); demographics[k] = []; continue; }
    demographics[k] = raw.demographics[k].map((x, i) => FR.withCell(x, 'n', show(idx[i])));
  }
  const ep = raw.episodes; const od = raw.overdose;
  // A table withheld whole prints no rows: a row, even one shown "withheld", could say its count is not 0.
  const disGone = gone.has('episodes.by_discharge_reason'); const byGone = gone.has('overdose.by_administered_by');
  const monthsGone = gone.has('overdose.by_month.n') && gone.has('overdose.by_month.reversals'); const revGone = gone.has('overdose.by_month.reversals');
  if (disGone) withheld.push('by_discharge_reason');
  if (byGone) withheld.push('by_administered_by');
  if (monthsGone) withheld.push('by_month');
  const smallGroup = ep.discharges > 0 && ep.discharges < T;
  const byFund = raw.by_funding_source.map((f, i) => ({ ...FR.withCell(f, 'clients_served', show(h.funds[i].p)), services: show(h.funds[i].s) }));
  const none = byFund.find(f => f.id === null);
  const funder = {
    unduplicated: { served: show(h.N), new_admissions: show(h.newAdm), with_a_referral: show(h.ref), admitted_after_referral: show(h.adm), on_mat: show(h.mat) },
    demographics, withheld,
    episodes: { ...ep, admissions: show(h.epAdm), discharges: show(h.D), open_at_end: show(h.epOpen), by_discharge_reason: disGone ? [] : ep.by_discharge_reason.map((x, i) => FR.withCell(x, 'n', show(h.dis[i]))),
      // A median over fewer people than the threshold is one of them.
      median_length_of_stay_days: smallGroup || show(h.D) === SC.WITHHELD ? SC.SECONDARY : ep.median_length_of_stay_days },
    overdose: { ...od, events: show(h.E), reversals: show(h.R), fatal: show(h.F), community_reported: show(h.C), naloxone_doses: show(h.Dall),
      by_month: monthsGone ? [] : od.by_month.map((x, m) => { const n = show(h.n[m]); const r = show(h.r[m]); return { month: x.month, n, reversals: r, ...(typeof n === 'number' && typeof r === 'number' ? {} : { suppressed: true }) }; }),
      by_administered_by: byGone ? [] : od.by_administered_by.map((x, i) => FR.withCell(x, 'n', show(h.by[i]))) },
    naloxone_distribution: raw.naloxone_distribution,
    by_funding_source: byFund,
    attribution: { ...raw.attribution, unattributed_clients: none ? none.clients_served : 0, unattributed_services: none ? none.services : raw.attribution.unattributed_services },
  };
  const uses = h.uses.map(x => ({ people: show(x.p), services: show(x.s) }));
  const ndp = { rows: revGone ? [] : od.by_month.map((x, m) => ({ month: x.month, reversals: show(h.r[m]), reversal_doses: show(h.d[m]) })), reversals: show(h.R), reversal_doses: show(h.Dr) };
  // Every number the release prints about people, and the figures hidden with them, in a fixed order.
  const id = digest(JSON.stringify(model.vars.map((x, i) => (x.published ? [x.id, show(i)] : null)).filter(Boolean)));
  return { funder, uses, ndp, withheld_tables: withheldTables, id, status, model };
}

// The audited release, kept for a few minutes so that the three reports of one release, and their exports,
// asked for together, run the audit once. Keyed by everything the audit reads (the true figures, the lists
// and the threshold), so a change to any figure is a different key and nothing stale is served.
const CACHE_MS = 5 * 60 * 1000; const CACHE_MAX = 4;
const cache = new Map();
function audited(inputs, T) {
  const key = JSON.stringify([T, inputs.domains, inputs.funder, [...inputs.perFund], inputs.settlement.services_by_use, inputs.settlement.fundKeys]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const p = protectFigures(inputs, T);
  cache.delete(key); cache.set(key, { p, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}
const clearCache = () => cache.clear();

/** The release for a period, and each report's part of it. counting: FR.countingMode for a publication run. */
function release(ctx, range, counting) {
  const HR = require('./harm-reduction-reports');
  const O = require('./options');
  const T = counting.threshold;
  // One read of the data: synchronous from here to the end, so nothing is written in between.
  const { raw, perFund } = FR.runSync(FR.figures(ctx, range, null, { fold: T }));
  const settle = HR.settlementFigures(range);
  const dist = HR.distributionRows(ctx, range, true);
  const domains = { months: monthsOf(range.from, range.to), administered_by: O.known('ADMINISTERED_BY'), discharge_reasons: O.known('DISCHARGE_REASONS') };
  const p = audited({ funder: raw, perFund, settlement: settle, domains }, T);
  if (p.refused) throw new HttpError(422, p.refused.message, { code: 'publication_refused' });
  const rel = { ...counting.release, id: p.id, reports: ['funder', 'naloxone-ndp', 'opioid-settlement'], withheld: p.withheld_tables };
  const withRelease = (d) => ({ ...d, release: rel });
  const { fundKeys, ...s } = settle;
  return {
    id: p.id,
    funder: withRelease({ ...FR.header(counting, range.from, range.to, null), ...p.funder }),
    settlement: withRelease({ ...s, funds: s.funds.map(({ is_active, ...f }) => f), ...HR.header(counting),
      services_by_use: s.services_by_use.map((x, i) => ({ ...FR.withCell(x, 'people', p.uses[i].people), services: p.uses[i].services })) }),
    ndp: withRelease(HR.ndpPublished(range, counting, dist, p.ndp)),
  };
}

module.exports = { release, protectFigures, buildModel, prepare, digest, monthsOf, clearCache, AUDIT_TIME_LIMIT_MS };
