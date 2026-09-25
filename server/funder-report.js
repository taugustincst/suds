'use strict';
// The report a funder actually asks for: how many distinct people were served in the period, counted once
// each, broken down the way a grant report is broken down. Every count on it is unduplicated — people, not
// services — because "1,400 services" and "310 people" are different questions.
//
// Speed: at 20,000 clients and 100,000 visits the earlier version took 4.4 s, holding the event loop the
// whole time, because the set of people served was a CTE recomputed by each of about nine queries. The set
// is now built once into a per-request temporary table, the per-person breakdowns are read from it in one
// pass, and the per-fund figures are one grouped pass over the period instead of three correlated subqueries
// per fund. test/funder-report.test.js holds the answers to those of the earlier version (a golden file);
// test/funder-perf.test.js holds the time.
const db = require('./db');
const auth = require('./auth');
const { badRequest, forbidden } = require('./http');
const { uuid } = require('./crypto');
// Between the report's phases the event loop is let go, so a health check or a colleague's page load waits
// for one phase (tens of milliseconds) rather than the whole report. setImmediate is not in the browser kernel.
const { defer } = require('./spreadsheet');
const breathe = () => new Promise((resolve) => defer(resolve));

const SMALL_CELL_DEFAULT = 11;
const PURPOSES = ['publication', 'submission'];

/**
 * How this run counts. Small-cell suppression is on unless the run is the programme's own submission to its
 * funder (purpose=submission) and asks for exact counts (counts=exact), which needs reports:exact
 * (supervisor, administrator, finance). Anything labelled for publication or sharing is always suppressed.
 */
function countingMode(ctx) {
  const purpose = ctx.query.get('purpose') || 'publication';
  if (!PURPOSES.includes(purpose)) throw badRequest('purpose must be publication (to publish or share) or submission (the programme\'s own report to its funder)');
  const mode = ctx.query.get('counts') || 'suppressed';
  if (!['suppressed', 'exact'].includes(mode)) throw badRequest('counts must be suppressed or exact');
  if (mode === 'exact') {
    if (purpose !== 'submission') throw badRequest('Exact counts are only for the programme\'s own submission to its funder (purpose=submission). A report to publish or share keeps small cells suppressed.');
    if (!auth.hasPerm(ctx.user, 'reports:exact')) throw forbidden('Only a supervisor, an administrator or finance can run the funder report with exact counts');
  }
  const threshold = Number(db.getSetting('small_cell_threshold', '')) || SMALL_CELL_DEFAULT;
  return { mode, threshold, purpose };
}

/** What the About sheet, the page and the CSV say about how the counts were made. */
function countingStatement(s) {
  return s.mode === 'exact'
    ? `Exact counts: every figure is the true number, including groups of fewer than ${s.threshold} people. For the programme's own submission to its funder; not for publication or sharing.`
    : `Small cells suppressed: a breakdown row counting fewer than ${s.threshold} people is shown as "<${s.threshold}" so nobody can be picked out of a small group; totals are exact. Suitable for publication or sharing.`;
}

// Demographic columns read from each person served, in one pass.
const DIMENSIONS = [['by_gender', 'gender', 'gender'], ['by_language', 'preferred_language', 'language'], ['by_housing', 'housing_status', 'housing'], ['by_insurance', 'insurance', 'insurance'], ['by_ethnicity', 'race_ethnicity', 'ethnicity']];
const byCount = (a, b) => (b.n - a.n) || String(a.k).localeCompare(String(b.k));

async function build(ctx, { from, to, ts, tsP }) {
  const counting = countingMode(ctx);
  const cf = auth.caseloadFilter(ctx.user, 'c.id');
  const fund = ctx.query.get('funding_source_id') || null;
  const fundJoin = fund ? 'AND i.funding_source_id=?' : '';
  const fundP = fund ? [fund] : [];

  // One set of people served per report, and every per-person figure below is counted within it: a service
  // (visit) or a contact (call) in the period, by a client still on the books (not deleted), in the caller's
  // caseload — and, when a funding source is chosen, only work charged to that source. A call carries no
  // funding source, so under a fund filter it cannot make someone "served by" that fund.
  // Named per request, so two reports never share it; dropped however this ends.
  const table = `report_served_${uuid().replace(/-/g, '').slice(0, 16)}`; const served = `temp.${table}`;
  db.run(`CREATE TEMP TABLE ${table} (id TEXT PRIMARY KEY) WITHOUT ROWID`);
  try {
    db.run(`INSERT OR IGNORE INTO ${served}(id) SELECT i.client_id FROM interventions i WHERE ${ts('i.occurred_at')} AND i.client_id IS NOT NULL ${fundJoin}`, ...tsP, ...fundP);
    if (!fund) db.run(`INSERT OR IGNORE INTO ${served}(id) SELECT ca.client_id FROM calls ca WHERE ${ts('ca.started_at')} AND ca.client_id IS NOT NULL`, ...tsP);
    db.run(`DELETE FROM ${served} WHERE id NOT IN (SELECT c.id FROM clients c WHERE c.deleted_at IS NULL AND ${cf.sql})`, ...cf.params);
    await breathe();

    // Everything about the people served, from one read of their records.
    // (IN, not a join: the planner then walks the clients once and probes the served set, about half the time.)
    const people = db.all(`SELECT c.gender, c.preferred_language, c.housing_status, c.insurance, c.race_ethnicity, c.race_codes, c.mat_status FROM clients c WHERE c.id IN (SELECT id FROM ${served})`);
    const demographics = {};
    for (const [key, col, label] of DIMENSIONS) {
      const n = new Map();
      for (const p of people) { const k = p[col] === null || p[col] === '' ? 'unknown' : p[col]; n.set(k, (n.get(k) || 0) + 1); }
      demographics[key] = [...n].map(([k, v]) => ({ k, n: v, dimension: label })).sort(byCount);
    }
    // race_codes is comma separated because a person may report more than one, so each is counted
    // separately and the total will exceed the number of people served. That is how funders want it.
    const byRace = new Map();
    for (const p of people) {
      const codes = String(p.race_codes || '').split(',').map(x => x.trim()).filter(Boolean);
      for (const code of (codes.length ? codes : ['unknown'])) byRace.set(code, (byRace.get(code) || 0) + 1);
    }
    demographics.by_race_code = [...byRace].map(([k, n]) => ({ k, n })).sort(byCount);
    await breathe();

    const unduplicated = {
      served: people.length,
      new_admissions: db.one(`SELECT COUNT(DISTINCT c.id) n FROM clients c WHERE c.deleted_at IS NULL AND c.intake_date BETWEEN ? AND ? AND ${cf.sql}`, from, to, ...cf.params).n,
      // Of the people served: how many were referred on, admitted somewhere, and are on MAT.
      with_a_referral: db.one(`SELECT COUNT(DISTINCT r.client_id) n FROM referrals r JOIN ${served} s ON s.id=r.client_id WHERE ${ts('r.referred_at')}`, ...tsP).n,
      admitted_after_referral: db.one(`SELECT COUNT(DISTINCT r.client_id) n FROM referrals r JOIN ${served} s ON s.id=r.client_id WHERE ${ts('r.admitted_at')}`, ...tsP).n,
      on_mat: people.filter(p => p.mat_status === 'active').length,
    };

    const episodes = {
      admissions: db.one(`SELECT COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.opened_at BETWEEN ? AND ? AND ${cf.sql}`, from, to, ...cf.params).n,
      discharges: db.one(`SELECT COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.closed_at BETWEEN ? AND ? AND ${cf.sql}`, from, to, ...cf.params).n,
      open_at_end: db.one(`SELECT COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.opened_at <= ? AND (e.closed_at IS NULL OR e.closed_at > ?) AND ${cf.sql}`, to, to, ...cf.params).n,
      by_discharge_reason: db.all(`SELECT COALESCE(e.discharge_reason,'unknown') k, COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.closed_at BETWEEN ? AND ? AND ${cf.sql} GROUP BY k ORDER BY n DESC`, from, to, ...cf.params),
      median_length_of_stay_days: (() => {
        const d = db.all(`SELECT (julianday(e.closed_at)-julianday(e.opened_at)) d FROM episodes e JOIN clients c ON c.id=e.client_id WHERE e.closed_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY d`, from, to, ...cf.params).map(x => x.d);
        return d.length ? Math.round(d[Math.floor(d.length / 2)]) : null;
      })(),
    };

    const od = db.one(`SELECT COUNT(*) events, COALESCE(SUM(CASE WHEN o.naloxone_used=1 AND o.survived=1 THEN 1 ELSE 0 END),0) reversals,
        COALESCE(SUM(CASE WHEN o.kind='fatal' OR o.survived=0 THEN 1 ELSE 0 END),0) fatal, COALESCE(SUM(CASE WHEN o.client_id IS NULL THEN 1 ELSE 0 END),0) community_reported,
        COALESCE(SUM(o.naloxone_doses),0) naloxone_doses FROM overdose_events o WHERE ${ts('o.occurred_at')}`, ...tsP);
    const overdose = {
      ...od,
      by_month: db.all(`SELECT substr(o.occurred_at,1,7) month, COUNT(*) n, SUM(CASE WHEN o.naloxone_used=1 AND o.survived=1 THEN 1 ELSE 0 END) reversals FROM overdose_events o WHERE ${ts('o.occurred_at')} GROUP BY month ORDER BY month`, ...tsP),
      by_administered_by: db.all(`SELECT COALESCE(o.administered_by,'unknown') k, COUNT(*) n FROM overdose_events o WHERE ${ts('o.occurred_at')} AND o.naloxone_used=1 GROUP BY k ORDER BY n DESC`, ...tsP),
    };

    // One grouped pass over the period's visits, read from the covering index (idx_interventions_period):
    // services and people per funding source — with an explicit "No funding source" row, since a visit
    // nobody charged to a fund used to drop out of the table silently — and the naloxone that went out the
    // door, community distribution with no identified client included. A deleted client's visits still
    // count as services, but not as a person served.
    const svc = new Map(db.all(`SELECT i.funding_source_id f, COUNT(*) services, COUNT(DISTINCT i.client_id) clients_served,
        COALESCE(SUM(i.naloxone_kits),0) kits, COALESCE(SUM(i.fentanyl_strips),0) strips, COALESCE(SUM(CASE WHEN i.client_id IS NULL THEN i.naloxone_kits ELSE 0 END),0) community_kits
      FROM interventions i WHERE ${ts('i.occurred_at')} GROUP BY i.funding_source_id`, ...tsP).map(x => [x.f, x]));
    // The few deleted clients among them, found through the client index rather than tested on every visit.
    for (const x of db.all(`SELECT i.funding_source_id f, COUNT(DISTINCT i.client_id) n FROM interventions i WHERE i.client_id IN (SELECT id FROM clients WHERE deleted_at IS NOT NULL) AND ${ts('i.occurred_at')} GROUP BY i.funding_source_id`, ...tsP)) {
      if (svc.has(x.f)) svc.get(x.f).clients_served -= x.n;
    }
    await breathe();
    const distribution = { kits: 0, strips: 0, community_kits: 0 };
    for (const x of svc.values()) if (!fund || x.f === fund) for (const k of Object.keys(distribution)) distribution[k] += x[k];
    // Staff hours: approved time is what a county would invoice; time logged and not yet approved (draft or
    // submitted; rejected time is neither) is shown beside it, so 79.5 h waiting for a supervisor reads as
    // that, not as zero.
    const hrs = new Map(db.all(`SELECT t.funding_source_id f, COALESCE(SUM(CASE WHEN t.status='approved' THEN t.minutes END),0) approved_minutes,
      COALESCE(SUM(CASE WHEN t.status IN ('draft','submitted') THEN t.minutes END),0) unapproved_minutes FROM time_entries t WHERE t.work_date BETWEEN ? AND ? GROUP BY t.funding_source_id`, from, to).map(x => [x.f, x]));
    const figures = (id) => ({ clients_served: svc.get(id)?.clients_served || 0, services: svc.get(id)?.services || 0, approved_minutes: hrs.get(id)?.approved_minutes || 0, unapproved_minutes: hrs.get(id)?.unapproved_minutes || 0 });
    const byFund = db.all(`SELECT f.id, f.name, f.grant_number, f.fiscal_year_start, f.fiscal_year_end FROM funding_sources f WHERE f.is_active=1 ORDER BY f.name`).map(f => ({ ...f, ...figures(f.id) }));
    const none = { id: null, name: 'No funding source', grant_number: null, fiscal_year_start: null, fiscal_year_end: null, ...figures(null) };
    byFund.push(none);
    let approved = 0, unapproved = 0; for (const x of hrs.values()) { approved += x.approved_minutes; unapproved += x.unapproved_minutes; }
    const attribution = {
      unattributed_services: none.services, unattributed_clients: none.clients_served,
      approved_minutes: approved, unapproved_minutes: unapproved,
      // Where to fix it: the visits in this period with no fund (public/views/interventions.js), and the time
      // sheets waiting for approval.
      fix_link: `#/interventions?from=${from}&to=${to}&funding=none`, approve_link: `#/time?from=${from}&to=${to}`,
    };

    const suppress = (rows) => (counting.mode === 'exact' ? rows : rows.map(x => (typeof x.n === 'number' && x.n > 0 && x.n < counting.threshold ? { ...x, n: `<${counting.threshold}`, suppressed: true } : x)));
    return {
      from, to, funding_source_id: fund,
      suppression: counting,
      // Kept for the screens and files that read it: the threshold applied, or null when counts are exact.
      small_cell_threshold: counting.mode === 'exact' ? null : counting.threshold,
      counting_statement: countingStatement(counting),
      unduplicated,
      demographics: Object.fromEntries(['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_race_code', 'by_ethnicity'].map(k => [k, suppress(demographics[k])])),
      episodes: { ...episodes, by_discharge_reason: suppress(episodes.by_discharge_reason) },
      overdose: { ...overdose, by_administered_by: suppress(overdose.by_administered_by) },
      naloxone_distribution: distribution,
      by_funding_source: byFund,
      attribution,
    };
  } finally { db.run(`DROP TABLE IF EXISTS ${served}`); }
}

/** The report as sheets: About (which states the counting mode), Summary, Who was served, By funding source. */
function sheets(d, ctx, fundName) {
  const hours = (m) => Math.round(m / 6) / 10;
  const about = [
    { k: 'Report', v: 'Funder report (unduplicated people served)' },
    { k: 'Period', v: `${d.from} to ${d.to}` },
    { k: 'Funding source', v: fundName || 'All funding sources' },
    { k: 'Purpose', v: d.suppression.purpose === 'submission' ? 'The programme\'s own submission to its funder' : 'Publication or sharing' },
    { k: 'Counts', v: d.counting_statement },
    { k: 'Classification', v: 'Aggregate counts: no names, client codes or dates of service.' },
    { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
  ];
  const u = d.unduplicated;
  const summary = [
    ['People served', 'Unduplicated clients served', u.served], ['People served', 'New admissions', u.new_admissions], ['People served', 'Received a referral', u.with_a_referral],
    ['People served', 'Admitted after a referral', u.admitted_after_referral], ['People served', 'On medication for opioid use disorder', u.on_mat],
    ['Episodes', 'Opened', d.episodes.admissions], ['Episodes', 'Closed', d.episodes.discharges], ['Episodes', 'Open at end of period', d.episodes.open_at_end], ['Episodes', 'Median length of stay (days)', d.episodes.median_length_of_stay_days ?? ''],
    ['Overdose & naloxone', 'Overdose events recorded', d.overdose.events], ['Overdose & naloxone', 'Reversed with naloxone', d.overdose.reversals], ['Overdose & naloxone', 'Fatal', d.overdose.fatal],
    ['Overdose & naloxone', 'Reported from the community', d.overdose.community_reported], ['Overdose & naloxone', 'Naloxone doses used', d.overdose.naloxone_doses],
    ['Overdose & naloxone', 'Naloxone kits distributed', d.naloxone_distribution.kits], ['Overdose & naloxone', 'Of those, community distribution', d.naloxone_distribution.community_kits], ['Overdose & naloxone', 'Fentanyl test strips', d.naloxone_distribution.strips],
    ['Funding attribution', 'Services with no funding source', d.attribution.unattributed_services], ['Funding attribution', 'Approved staff hours', hours(d.attribution.approved_minutes)], ['Funding attribution', 'Staff hours logged, not yet approved', hours(d.attribution.unapproved_minutes)],
  ].map(([section, measure, value]) => ({ section, measure, value }));
  const who = [];
  for (const [key, label] of [['by_race_code', 'Race'], ['by_ethnicity', 'Ethnicity'], ['by_gender', 'Gender'], ['by_language', 'Language'], ['by_housing', 'Housing'], ['by_insurance', 'Insurance']]) for (const x of d.demographics[key]) who.push({ section: label, measure: x.k, value: x.n });
  for (const x of d.episodes.by_discharge_reason) who.push({ section: 'Discharge reason', measure: x.k, value: x.n });
  for (const x of d.overdose.by_administered_by) who.push({ section: 'Naloxone given by', measure: x.k, value: x.n });
  const funds = d.by_funding_source.map(f => ({ fund: f.name, grant_number: f.grant_number || '', fiscal_year: [f.fiscal_year_start, f.fiscal_year_end].filter(Boolean).join(' to '), people: f.clients_served, services: f.services, approved_hours: hours(f.approved_minutes), unapproved_hours: hours(f.unapproved_minutes) }));
  const long = [{ key: 'section', label: 'Section' }, { key: 'measure', label: 'Measure' }, { key: 'value', label: 'Value' }];
  return {
    about, summary, who, funds,
    workbook: [
      { name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: about },
      { name: 'Summary', columns: long, rows: summary },
      { name: 'Who was served', columns: long, rows: who },
      { name: 'By funding source', columns: [{ key: 'fund', label: 'Fund' }, { key: 'grant_number', label: 'Grant number' }, { key: 'fiscal_year', label: 'Fiscal year' }, { key: 'people', label: 'People served' }, { key: 'services', label: 'Services' }, { key: 'approved_hours', label: 'Approved staff hours' }, { key: 'unapproved_hours', label: 'Staff hours logged, not yet approved' }], rows: funds },
    ],
    // CSV has no cover sheet: one long table whose first rows are the About fields, so the counting mode
    // travels with the numbers.
    csv: [...about.map(x => ({ section: 'About', measure: x.k, value: x.v })), ...summary, ...who, ...funds.flatMap(f => [
      { section: 'By funding source', measure: `${f.fund}: people served`, value: f.people }, { section: 'By funding source', measure: `${f.fund}: services`, value: f.services },
      { section: 'By funding source', measure: `${f.fund}: approved staff hours`, value: f.approved_hours }, { section: 'By funding source', measure: `${f.fund}: staff hours logged, not yet approved`, value: f.unapproved_hours }])],
    csvColumns: long,
  };
}

module.exports = { build, sheets, countingMode, countingStatement, SMALL_CELL_DEFAULT };
