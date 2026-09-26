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
//   * discharges and their reasons; new admissions, episodes opened and open at the end stand alone.
// Counts printed nowhere but worked out from printed ones are sensitive when they are small (1 to T-1): the
// people left when on MAT, referred, admitted, a fund, a use or a race code are taken from N; a use's people
// not under one of its funds; E-R, E-F, E-C, E-R-F; each month's events that were not reversals.
// Kits, doses, test strips, money and staff hours are not counts of people and bound none, so they stay out
// (the doses used in a hidden NDP reversal month are hidden with it, as before).
const FR = require('./funder-report');
const SC = require('./small-cells');
const SDC = require('./sdc');

const PARTITIONS = ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity'];

/** The model of one release. inputs: { funder: the funder report's true figures, perFund: Map id -> { services, clients_served }, settlement: { services_by_use, fundKeys } }. */
function buildModel({ funder: raw, perFund, settlement }) {
  const vars = []; const cons = []; const derived = []; const mirror = [];
  const v = (id, value, o = {}) => { vars.push({ id, value, people: o.people !== false, total: !!o.total, table: o.table || id, published: o.published !== false }); return vars.length - 1; };
  const rel = (terms, op, rhs = 0) => cons.push({ terms, op, rhs });
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
  const byKey = new Map();
  for (const f of settlement.fundKeys) {
    const act = perFund.get(f.id); if (!act || !act.services) continue; // no work in the period: 0, and known to be
    if (!fundVars.has(f.id)) {
      // A settlement fund the funder report does not list (no longer active): printed nowhere, tied to its use.
      const p = subset(`fund.${f.id}.people`, act.clients_served, `unpublished.fund.${f.id}`, { published: false });
      const s = v(`fund.${f.id}.services`, act.services, { people: false, table: `unpublished.fund.${f.id}`, published: false });
      rel([[p, 1], [s, -1]], '<='); fundVars.set(f.id, { p, s });
    }
    if (!byKey.has(f.key)) byKey.set(f.key, []);
    byKey.get(f.key).push(fundVars.get(f.id));
  }
  h.uses = settlement.services_by_use.map(x => {
    const p = subset(`use.${x.use_code}.people`, x.people, 'settlement.services_by_use');
    const s = v(`use.${x.use_code}.services`, x.services, { people: false, table: 'settlement.services_by_use' });
    rel([[p, 1], [s, -1]], '<='); mirror.push([p, s]);
    const fs = byKey.get(x.use_code) || [];
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
  h.n.forEach((n, m) => { rel([[h.r[m], 1], [n, -1]], '<='); derived.push({ id: `overdose.${od.by_month[m].month}.not_reversed`, terms: [[n, 1], [h.r[m], -1]] }); });
  rel([[F, 1], [E, -1]], '<='); rel([[Cm, 1], [E, -1]], '<='); cons.push({ terms: [[F, 1], [R, 1], [E, -1]], op: '<=', rhs: 0, soft: true });
  derived.push({ id: 'overdose.not_reversed', terms: [[E, 1], [R, -1]] }, { id: 'overdose.not_fatal', terms: [[E, 1], [F, -1]] },
    { id: 'overdose.not_community', terms: [[E, 1], [Cm, -1]] }, { id: 'overdose.neither', terms: [[E, 1], [R, -1], [F, -1]] });
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

/**
 * Protect one release's figures (a pure function, so tests can attack it). Returns what each report prints:
 * { funder: the funder report's figures as suppress() returns them, uses: [{ people, services }] for the
 * settlement report's services_by_use, ndp: { by_month: reversals shown per od.by_month, reversals },
 * withheld_tables, id }.
 */
function protectFigures(inputs, T, { strict = false } = {}) {
  const { model, h } = buildModel(inputs);
  model.strict = strict;
  const { status, withheldTables } = SDC.protect(model, T);
  const show = (i) => (status[i] === 'vis' ? model.vars[i].value : status[i] === 'pri' ? SC.primary(T) : status[i] === 'sec' ? SC.SECONDARY : SC.WITHHELD);
  const raw = inputs.funder;
  const gone = new Set(withheldTables);
  const withheld = [];
  const demographics = {};
  for (const k of [...PARTITIONS.slice(0, 4), 'by_race_code', 'by_ethnicity']) {
    const idx = k === 'by_race_code' ? h.race : h.dem[k];
    if (gone.has(`demographics.${k}`)) { withheld.push(k); demographics[k] = []; continue; }
    demographics[k] = raw.demographics[k].map((x, i) => FR.withCell(x, 'n', show(idx[i])));
  }
  const ep = raw.episodes; const od = raw.overdose;
  const smallGroup = ep.discharges > 0 && ep.discharges < T;
  const byFund = raw.by_funding_source.map((f, i) => ({ ...FR.withCell(f, 'clients_served', show(h.funds[i].p)), services: show(h.funds[i].s) }));
  const none = byFund.find(f => f.id === null);
  const funder = {
    unduplicated: { served: show(h.N), new_admissions: show(h.newAdm), with_a_referral: show(h.ref), admitted_after_referral: show(h.adm), on_mat: show(h.mat) },
    demographics, withheld,
    episodes: { ...ep, admissions: show(h.epAdm), discharges: show(h.D), open_at_end: show(h.epOpen), by_discharge_reason: ep.by_discharge_reason.map((x, i) => FR.withCell(x, 'n', show(h.dis[i]))),
      // A median over fewer people than the threshold is one of them.
      median_length_of_stay_days: smallGroup || show(h.D) === SC.WITHHELD ? SC.SECONDARY : ep.median_length_of_stay_days },
    overdose: { ...od, events: show(h.E), reversals: show(h.R), fatal: show(h.F), community_reported: show(h.C),
      by_month: od.by_month.map((x, m) => { const n = show(h.n[m]); const r = show(h.r[m]); return { month: x.month, n, reversals: r, ...(typeof n === 'number' && typeof r === 'number' ? {} : { suppressed: true }) }; }),
      by_administered_by: od.by_administered_by.map((x, i) => FR.withCell(x, 'n', show(h.by[i]))) },
    naloxone_distribution: raw.naloxone_distribution,
    by_funding_source: byFund,
    attribution: { ...raw.attribution, unattributed_clients: none ? none.clients_served : 0, unattributed_services: none ? none.services : raw.attribution.unattributed_services },
  };
  const uses = h.uses.map(x => ({ people: show(x.p), services: show(x.s) }));
  const ndp = { by_month: h.r.map(show), reversals: show(h.R) };
  // Every number the release prints about people, and the figures hidden with them, in a fixed order.
  const id = digest(JSON.stringify(model.vars.map((x, i) => (x.published ? [x.id, show(i)] : null)).filter(Boolean)));
  return { funder, uses, ndp, withheld_tables: withheldTables, id, status, model };
}

/** The release for a period, and each report's part of it. counting: FR.countingMode for a publication run. */
function release(ctx, range, counting) {
  const HR = require('./harm-reduction-reports');
  const T = counting.threshold;
  // One read of the data: synchronous from here to the end, so nothing is written in between.
  const { raw, perFund } = FR.runSync(FR.figures(ctx, range, null));
  const settle = HR.settlementFigures(range);
  const dist = HR.distributionRows(ctx, range, true);
  const p = protectFigures({ funder: raw, perFund, settlement: settle }, T);
  const rel = { ...counting.release, id: p.id, reports: ['funder', 'naloxone-ndp', 'opioid-settlement'], withheld: p.withheld_tables };
  const withRelease = (d) => ({ ...d, release: rel });
  const { fundKeys, ...s } = settle;
  return {
    id: p.id,
    funder: withRelease({ ...FR.header(counting, range.from, range.to, null), ...p.funder }),
    settlement: withRelease({ ...s, funds: s.funds.map(({ is_active, ...f }) => f), ...HR.header(counting),
      services_by_use: s.services_by_use.map((x, i) => ({ ...FR.withCell(x, 'people', p.uses[i].people), services: p.uses[i].services })) }),
    ndp: withRelease(HR.ndpPublished(range, counting, dist, raw.overdose, p.ndp)),
  };
}

module.exports = { release, protectFigures, buildModel, digest };
