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
const SC = require('./small-cells');
const breathe = () => new Promise((resolve) => defer(resolve));

const SMALL_CELL_DEFAULT = 11;
// publication: a release to publish or share (whole programme, a standard period that has ended, always
// suppressed). submission: the programme's own report to its funder. internal: anything else. Neither of
// the last two is for publication.
const PURPOSES = ['publication', 'submission', 'internal'];

// ---- what may be published ----
// Suppression inside one report cannot stop two reports being subtracted from each other: the whole programme
// minus one fund's run leaves the people served under the other funds, January–June minus January–May leaves
// those first served in June. So only one shape of run carries the publication label: the whole programme
// (no fund filter, no caseload scope) for one standard period that has ended. Standard periods are those a
// grant report covers and that tile the calendar without overlapping at their own level: a calendar month,
// a quarter (January, April, July, October) and a year starting on one of those quarters (a July–June or
// October–September fiscal year, or a calendar year). A fund-filtered, custom-range, caseload-scoped or
// unfinished run is "internal, not for publication" (docs/HIPAA.md "Small cells in aggregate reports").
const QUARTER_STARTS = [1, 4, 7, 10];
const lastDayOf = (year, month) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10); // month 1-12
/** 'month' | 'quarter' | 'year' | null. */
function standardPeriod(from, to) {
  const m = /^(\d{4})-(\d{2})-01$/.exec(from || ''); if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  const end = (months) => { const last = mo - 1 + months - 1; return lastDayOf(y + Math.floor(last / 12), (last % 12) + 1); };
  if (to === end(1)) return 'month';
  if (QUARTER_STARTS.includes(mo) && to === end(3)) return 'quarter';
  if (QUARTER_STARTS.includes(mo) && to === end(12)) return 'year';
  return null;
}
const PERIOD_LABEL = { month: 'one calendar month', quarter: 'one quarter', year: 'one year' };
/** Whether a run could be a publication release, and if not, why not. */
function release(ctx, { from, to }, { fund = null } = {}) {
  const why = [];
  const period = standardPeriod(from, to);
  if (fund) why.push('it is filtered to one funding source');
  if (auth.caseloadRestricted(ctx.user)) why.push('it counts only your caseload');
  if (!period) why.push('its period is not a calendar month, a quarter or a year starting on 1 January, April, July or October');
  else if (to >= require('./routes/budget').localDate()) why.push('its period has not ended yet');
  return { publishable: !why.length, period, not_publishable: why };
}

/**
 * How this run counts, and what it is for. A run that could be published (release above) is a publication
 * release unless asked otherwise; any other run is internal. Small-cell suppression is on unless a run that
 * is not for publication asks for exact counts (counts=exact), which needs reports:exact (supervisor,
 * administrator, finance). A publication release is always suppressed, and asking for one that could not be
 * is refused.
 */
function countingMode(ctx, period = { from: '', to: '' }, opts = {}) {
  const rel = release(ctx, period, opts);
  const purpose = ctx.query.get('purpose') || (rel.publishable ? 'publication' : 'internal');
  if (!PURPOSES.includes(purpose)) throw badRequest('purpose must be publication (a release to publish or share), submission (the programme\'s own report to its funder) or internal');
  const mode = ctx.query.get('counts') || 'suppressed';
  if (!['suppressed', 'exact'].includes(mode)) throw badRequest('counts must be suppressed or exact');
  if (mode === 'exact') {
    if (purpose === 'publication') throw badRequest('Exact counts are only for the programme\'s own submission to its funder (purpose=submission) or internal use. A report to publish or share keeps small cells suppressed.');
    if (!auth.hasPerm(ctx.user, 'reports:exact')) throw forbidden('Only a supervisor, an administrator or finance can run the funder report with exact counts');
  }
  if (purpose === 'publication' && !rel.publishable) {
    throw badRequest(`Only a report on the whole programme for one calendar month, quarter or year (starting 1 January, April, July or October) that has ended can be labelled for publication; this one cannot, because ${rel.not_publishable.join(' and ')}. Run it without purpose=publication: it is then marked internal, not for publication.`);
  }
  const threshold = Number(db.getSetting('small_cell_threshold', '')) || SMALL_CELL_DEFAULT;
  return { mode, threshold, purpose, release: rel };
}
/** The part of the counting mode a response carries as `suppression`. */
const suppressionOf = (c) => ({ mode: c.mode, threshold: c.threshold, purpose: c.purpose });

/** What the About sheet, the page and the CSV say about how the counts were made. */
function countingStatement(s) {
  const T = s.threshold;
  const how = `every count of people under ${T} (people served, each breakdown row, people per fund, episodes, discharges, overdose events and reversals, who gave the naloxone) is shown as "<${T}" so nobody can be picked out of a small group, and wherever a hidden figure could still be worked out from the figures published with it (a total, a breakdown that adds up to it, or the people left when one fund's are taken from the total) more is hidden, shown as "suppressed", the total itself only when nothing else will do, so that it cannot be worked out by subtraction. Counts of naloxone kits, doses, test strips, services, staff hours and money are not counts of people and are exact.`;
  const rel = s.release || { publishable: false, not_publishable: [] };
  const why = rel.not_publishable.length ? ` (${rel.not_publishable.join('; ')})` : '';
  if (s.mode === 'exact') {
    return `Exact counts: every figure is the true number, including groups of fewer than ${T} people. For the programme's own ${s.purpose === 'submission' ? 'submission to its funder' : 'internal use'}; not for publication or sharing.`;
  }
  if (s.purpose === 'publication') {
    return `Publication release: the whole programme, ${PERIOD_LABEL[rel.period] || 'one standard period'}. Small cells suppressed: ${how} The funder report, the NDP log and the opioid settlement report for this period are one release, audited together: nothing any of them prints says more about a small hidden count of people than "fewer than ${T}" (a count of services that would is hidden with it, and a table that cannot be protected is withheld). Suitable for publication or sharing. Publish one release per period, once: two releases for nested or overlapping periods (a quarter and the year that contains it) or the same period run again after late entries can be subtracted from each other to reveal a small group, which suppression within one release cannot prevent.`;
  }
  return `${s.purpose === 'submission' ? 'The programme\'s own submission to its funder' : 'Internal'}, not for publication${why}. Small cells suppressed: ${how} Figures from a run like this can be subtracted from a published release (the whole programme minus one fund, one period minus a shorter one) to reveal a small group, so they stay within the programme and its funder.`;
}

// Demographic columns read from each person served, in one pass.
const DIMENSIONS = [['by_gender', 'gender', 'gender'], ['by_language', 'preferred_language', 'language'], ['by_housing', 'housing_status', 'housing'], ['by_insurance', 'insurance', 'insurance'], ['by_ethnicity', 'race_ethnicity', 'ethnicity']];
const byCount = (a, b) => (b.n - a.n) || String(a.k).localeCompare(String(b.k));

// A reversal: naloxone used and the person survived. An event recorded as kind "reversal" had naloxone
// by definition, whether or not the box was ticked (older records, or rows pushed from a device).
const NALOXONE = `(o.naloxone_used=1 OR o.kind='reversal')`;
/** The period's overdose events, reversals and naloxone given, true values (the NDP log reads them too). */
function overdoseFigures(ts, tsP) {
  const od = db.one(`SELECT COUNT(*) events, COALESCE(SUM(CASE WHEN ${NALOXONE} AND o.survived=1 THEN 1 ELSE 0 END),0) reversals,
      COALESCE(SUM(CASE WHEN o.kind='fatal' OR o.survived=0 THEN 1 ELSE 0 END),0) fatal, COALESCE(SUM(CASE WHEN o.client_id IS NULL THEN 1 ELSE 0 END),0) community_reported,
      COALESCE(SUM(o.naloxone_doses),0) naloxone_doses FROM overdose_events o WHERE ${ts('o.occurred_at')}`, ...tsP);
  return {
    ...od,
    by_month: db.all(`SELECT substr(o.occurred_at,1,7) month, COUNT(*) n, SUM(CASE WHEN ${NALOXONE} AND o.survived=1 THEN 1 ELSE 0 END) reversals,
        COALESCE(SUM(CASE WHEN ${NALOXONE} AND o.survived=1 THEN o.naloxone_doses ELSE 0 END),0) reversal_doses FROM overdose_events o WHERE ${ts('o.occurred_at')} GROUP BY month ORDER BY month`, ...tsP),
    // Who gave the naloxone in each reversal (as the NDP log counts it), so the rows add up to the reversals.
    by_administered_by: db.all(`SELECT COALESCE(o.administered_by,'unknown') k, COUNT(*) n FROM overdose_events o WHERE ${ts('o.occurred_at')} AND ${NALOXONE} AND o.survived=1 GROUP BY k ORDER BY n DESC`, ...tsP),
  };
}

/**
 * The overdose figures, protected. Two stars (server/small-cells.js): the events (total, by month, and the
 * fatal, community-reported and reversed events, each some of them) and the reversals (total, by month, and
 * by who gave the naloxone). They are linked: the reversals are some of the events, in total and in each
 * month, so the difference (events not reversed) is a count of people too. Where a star hides a figure the
 * other shows, the other hides it too, and a month showing both events and reversals that differ by fewer
 * than the threshold hides its reversals; the two are run again until neither changes. Each star is audited
 * exactly; the links between them are enforced by hiding, not audited jointly. That is enough for a run that is
 * not for publication; a publication release is audited as one system instead (server/publication-release.js).
 */
function overdoseProtect(od, sc) {
  const months = od.by_month.map(x => ({ month: x.month, n: x.n, reversals: x.reversals }));
  if (sc.exact) return { events: od.events, reversals: od.reversals, fatal: od.fatal, community_reported: od.community_reported, by_month: months, by_administered_by: od.by_administered_by };
  const forceMonth = new Set(); let hideR = false;
  for (;;) {
    const r = SC.star({ total: od.reversals, partitions: [months.map(x => x.reversals), od.by_administered_by.map(x => x.n)] },
      { ...sc, hidden: { partitions: [...forceMonth].map(i => [0, i]), total: hideR } });
    const rHidden = !isNum(r.total);
    const e = SC.star({ total: od.events, partitions: [months.map(x => x.n)], subsets: [od.reversals, od.fatal, od.community_reported] },
      { ...sc, hidden: { subsets: rHidden ? [0] : [] } });
    let more = false;
    if (!isNum(e.subsets[0]) && !rHidden) { hideR = true; more = true; }
    months.forEach((x, i) => {
      if (!forceMonth.has(i) && isNum(e.partitions[0][i]) && isNum(r.partitions[0][i]) && SC.isSmall(x.n - x.reversals, sc.threshold)) { forceMonth.add(i); more = true; }
    });
    if (more) continue;
    const rows = (p) => p || [];
    return {
      events: e.total, reversals: r.total, fatal: e.subsets[1], community_reported: e.subsets[2],
      by_month: months.map((x, i) => {
        const n = rows(e.partitions[0])[i] ?? SC.WITHHELD; const rv = rows(r.partitions[0])[i] ?? SC.WITHHELD;
        return { ...x, n, reversals: rv, ...(isNum(n) && isNum(rv) ? {} : { suppressed: true }) };
      }),
      by_administered_by: od.by_administered_by.map((x, i) => withCell(x, 'n', rows(r.partitions[1])[i] ?? SC.WITHHELD)),
    };
  }
}
const isNum = (v) => typeof v === 'number';

/** People served in the period by the whole programme (the total a publication release prints). */
function servedCount(ts, tsP) {
  return db.one(`SELECT COUNT(*) n FROM clients c WHERE c.deleted_at IS NULL AND (c.id IN (SELECT i.client_id FROM interventions i WHERE ${ts('i.occurred_at')})
    OR c.id IN (SELECT ca.client_id FROM calls ca WHERE ${ts('ca.started_at')}))`, ...tsP, ...tsP).n;
}

/**
 * The report's true figures, in phases (a generator: `yield` marks where the event loop may be let go).
 * fund: a funding source to filter to, or null. Returns { raw, perFund } - perFund: services and people per
 * funding source id, every fund with work in the period (a publication release needs the inactive ones too).
 */
function* figures(ctx, { from, to, ts, tsP }, fund) {
  const cf = auth.caseloadFilter(ctx.user, 'c.id');
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
    yield;

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
    yield;

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

    const overdose = overdoseFigures(ts, tsP);

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
    yield;
    const distribution = { kits: 0, strips: 0, community_kits: 0 };
    for (const x of svc.values()) if (!fund || x.f === fund) for (const k of Object.keys(distribution)) distribution[k] += x[k];
    // Staff hours: approved time is what a county would invoice; time logged and not yet approved (draft or
    // submitted; rejected time is neither) is shown beside it, so 79.5 h waiting for a supervisor reads as
    // that, not as zero.
    const hrs = new Map(db.all(`SELECT t.funding_source_id f, COALESCE(SUM(CASE WHEN t.status='approved' THEN t.minutes END),0) approved_minutes,
      COALESCE(SUM(CASE WHEN t.status IN ('draft','submitted') THEN t.minutes END),0) unapproved_minutes FROM time_entries t WHERE t.work_date BETWEEN ? AND ? GROUP BY t.funding_source_id`, from, to).map(x => [x.f, x]));
    const fundFigures = (id) => ({ clients_served: svc.get(id)?.clients_served || 0, services: svc.get(id)?.services || 0, approved_minutes: hrs.get(id)?.approved_minutes || 0, unapproved_minutes: hrs.get(id)?.unapproved_minutes || 0 });
    // Filtered to one fund, the report is about that fund: its row, its staff hours, and no "No funding
    // source" row (a visit charged to no fund is not work charged to this one). Unfiltered, every active fund
    // and the "No funding source" row.
    const byFund = fund
      ? db.all(`SELECT f.id, f.name, f.grant_number, f.fiscal_year_start, f.fiscal_year_end FROM funding_sources f WHERE f.id=?`, fund).map(f => ({ ...f, ...fundFigures(f.id) }))
      : db.all(`SELECT f.id, f.name, f.grant_number, f.fiscal_year_start, f.fiscal_year_end FROM funding_sources f WHERE f.is_active=1 ORDER BY f.name`).map(f => ({ ...f, ...fundFigures(f.id) }));
    const none = { id: null, name: 'No funding source', grant_number: null, fiscal_year_start: null, fiscal_year_end: null, ...fundFigures(null) };
    if (!fund) byFund.push(none);
    let approved = 0, unapproved = 0;
    for (const [f, x] of hrs) if (!fund || f === fund) { approved += x.approved_minutes; unapproved += x.unapproved_minutes; }
    const attribution = {
      unattributed_services: fund ? 0 : none.services, unattributed_clients: fund ? 0 : none.clients_served,
      approved_minutes: approved, unapproved_minutes: unapproved,
      // Where to fix it: the visits in this period with no fund (public/views/interventions.js), and the time
      // sheets waiting for approval.
      fix_link: `#/interventions?from=${from}&to=${to}&funding=none`, approve_link: `#/time?from=${from}&to=${to}`,
      // With no programme default fund, a visit nobody charges goes to no fund; Settings → Programme →
      // Reporting is where one is set.
      default_fund_set: !!require('./routes/budget').defaultFundFor(null), settings_link: '#/admin?tab=settings&section=reporting',
    };

    const raw = {
      unduplicated, demographics, episodes, overdose, naloxone_distribution: distribution, by_funding_source: byFund,
      attribution: { ...attribution, unattributed_clients: fund ? 0 : none.clients_served },
    };
    return { raw, perFund: svc };
  } finally { db.run(`DROP TABLE IF EXISTS ${served}`); }
}
/** Run a phased computation straight through: nothing else runs in between, so it reads one snapshot. */
function runSync(gen) { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; }
/** Run it letting the event loop go between phases. */
async function runAsync(gen) { let r = gen.next(); while (!r.done) { await breathe(); r = gen.next(); } return r.value; }

async function build(ctx, range) {
  const { from, to } = range;
  const fund = ctx.query.get('funding_source_id') || null;
  const counting = countingMode(ctx, { from, to }, { fund });
  // A publication release is computed once for all three reports that publish from it (the funder report,
  // the NDP log and the settlement report) and audited as one (server/publication-release.js).
  if (counting.purpose === 'publication') return require('./publication-release').release(ctx, range, counting).funder;
  const { raw } = await runAsync(figures(ctx, range, fund));
  const sc = { threshold: counting.threshold, exact: counting.mode === 'exact' };
  return { ...header(counting, from, to, fund), ...suppress(raw, sc) };
}
/** What every funder report response starts with. */
function header(counting, from, to, fund = null) {
  return {
    from, to, funding_source_id: fund,
    suppression: suppressionOf(counting),
    // Whether this run could be a publication release, and if not why not.
    release: counting.release,
    // Kept for the screens and files that read it: the threshold applied, or null when counts are exact.
    small_cell_threshold: counting.mode === 'exact' ? null : counting.threshold,
    counting_statement: countingStatement(counting),
  };
}

const PARTITIONS = ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_ethnicity'];
const withCell = (x, key, v) => ({ ...x, [key]: v, ...(isNum(v) ? {} : { suppressed: true }) });
/**
 * Small-cell suppression of the report's figures (server/small-cells.js), a pure function of them so it can be
 * tested against brute force. The people served are one marginal shared by: the total; the single-valued
 * breakdowns (gender, language, housing, insurance, ethnicity), each adding up to it; counts of some of them
 * (on MAT, referred, admitted, each fund, "No funding source"), each leaving a complement anyone can work
 * out; and the race codes (a person may report several). They are protected together, to a fixpoint.
 * Exact mode returns the figures unchanged.
 */
function suppress(raw, sc) {
  const dem = raw.demographics;
  const order = ['by_gender', 'by_language', 'by_housing', 'by_insurance', 'by_race_code', 'by_ethnicity'];
  if (sc.exact) return { ...raw, withheld: [], demographics: Object.fromEntries(order.map(k => [k, dem[k]])), overdose: { ...raw.overdose, ...overdoseProtect(raw.overdose, sc) } };
  const one = (v) => SC.cell(v, sc);
  const u = raw.unduplicated; const funds = raw.by_funding_source;
  const s = SC.star({ total: u.served, partitions: PARTITIONS.map(k => dem[k].map(x => x.n)),
    subsets: [u.on_mat, u.with_a_referral, u.admitted_after_referral, ...funds.map(f => f.clients_served)],
    cover: dem.by_race_code.map(x => x.n) }, sc);
  // A breakdown no pattern of hidden cells could protect is withheld whole (listed in `withheld`).
  const demographics = {}; const withheld = [];
  PARTITIONS.forEach((k, g) => { if (!s.partitions[g]) { withheld.push(k); demographics[k] = []; } else demographics[k] = dem[k].map((x, i) => withCell(x, 'n', s.partitions[g][i])); });
  if (!s.cover) { withheld.push('by_race_code'); demographics.by_race_code = []; } else demographics.by_race_code = dem.by_race_code.map((x, i) => withCell(x, 'n', s.cover[i]));
  // People per fund also never leave one hidden fund beside visible ones.
  const fundPeople = SC.noLonely(s.subsets.slice(3));
  const byFund = funds.map((f, i) => withCell(f, 'clients_served', fundPeople[i]));
  const noneRow = byFund.find(f => f.id === null);
  const ep = raw.episodes;
  const discharges = SC.table(ep.by_discharge_reason, ['n'], { ...sc, totals: { n: ep.discharges } });
  const od = raw.overdose;
  const o = overdoseProtect(od, sc);
  // A median over fewer people than the threshold is one of them.
  const smallGroup = isNum(ep.discharges) && ep.discharges > 0 && ep.discharges < sc.threshold;
  return {
    unduplicated: { served: s.total, new_admissions: one(u.new_admissions), with_a_referral: s.subsets[1], admitted_after_referral: s.subsets[2], on_mat: s.subsets[0] },
    demographics: Object.fromEntries(order.map(k => [k, demographics[k]])), withheld,
    episodes: { ...ep, admissions: one(ep.admissions), discharges: discharges.totals.n, open_at_end: one(ep.open_at_end), by_discharge_reason: discharges.rows,
      median_length_of_stay_days: smallGroup ? SC.SECONDARY : ep.median_length_of_stay_days },
    overdose: { ...od, ...o },
    naloxone_distribution: raw.naloxone_distribution,
    by_funding_source: byFund,
    attribution: { ...raw.attribution, unattributed_clients: noneRow ? noneRow.clients_served : 0 },
  };
}

/** The report as sheets: About (which states the counting mode), Summary, Who was served, By funding source. */
function sheets(d, ctx, fundName) {
  const hours = (m) => Math.round(m / 6) / 10;
  const about = [
    { k: 'Report', v: 'Funder report (unduplicated people served)' },
    { k: 'Period', v: `${d.from} to ${d.to}` },
    { k: 'Funding source', v: fundName || 'All funding sources' },
    { k: 'Purpose', v: d.suppression.purpose === 'publication' ? 'Publication release (whole programme, one standard period)' : d.suppression.purpose === 'submission' ? 'The programme\'s own submission to its funder, not for publication' : 'Internal, not for publication' },
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

module.exports = { build, figures, runSync, runAsync, header, withCell, sheets, suppress, countingMode, countingStatement, suppressionOf, standardPeriod, release, overdoseFigures, overdoseProtect, servedCount, SMALL_CELL_DEFAULT };
