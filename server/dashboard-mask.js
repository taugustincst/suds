'use strict';
// What the Home page and the Reports dashboard show a role that runs publication releases only.
//
// The funder report, the NDP log and the settlement report give read-only accounts publication releases
// only, and finance those and the programme's own submission (reports:funder, 1.14.0: aggregate counts for its
// funder, not an insider view of the people; server/routes/reports.js requireReportRun). Neither holds
// reportRunAllowed, so both keep the masked screens below: a count of people from 1 to T-1 is printed as "<T". The dashboard (GET /api/reports/dashboard) and the monthly trends
// (GET /api/reports/monthly) used to print the same people exactly, for any date range, on the next page
// along ("Opioids Heroin 1"). Those accounts are insiders (docs/HIPAA.md "Whom suppression protects
// against"), so this is display-level consistency, not a disclosure control: the screens must not
// contradict each other. The same threshold as the reports (setting small_cell_threshold, default 11); zero
// stays 0; counts that are not of people (visits, calls, naloxone kits, test strips, hours, money) stay exact,
// as they do in the reports (server/small-cells.js says which is which).
//
// A named staff member's activity (visits by worker) is shown only to a role that supervises staff
// (assignments:manage: supervisors and administrators). A front-line worker's own caseload roles
// (navigator, clinician) may run internal reports of their caseload, so their figures are not masked here.
const auth = require('./auth');
const db = require('./db');

const threshold = () => Number(db.getSetting('small_cell_threshold', '')) || 11;
/** Does this user see counts of people masked below the threshold? */
const masks = (user) => !auth.reportRunAllowed(user, { caseloadScoped: true });
/** Does this user see per-worker rows? */
const seesWorkers = (user) => auth.hasPerm(user, 'assignments:manage');

function maskerFor(user) {
  if (!masks(user)) return null;
  const T = threshold();
  const small = `<${T}`;
  const one = (v) => (typeof v === 'number' && v > 0 && v < T ? small : v);
  const rows = (list, ...keys) => (Array.isArray(list) ? list.map(r => { const o = { ...r }; for (const k of keys) o[k] = one(o[k]); return o; }) : list);
  return { T, one, rows };
}

/** The dashboard's response, as this user is shown it. */
function dashboard(user, out) {
  const m = maskerFor(user);
  const res = { ...out };
  if (res.interventions && !seesWorkers(user)) res.interventions = { ...res.interventions, by_worker: null };
  // Consents naming a client (client code, recipient) are for roles that work with consents.
  if (!auth.hasPerm(user, 'consents:read')) { res.consents_expiring = []; res.consents_expiring_clients = null; }
  if (!m) return res;
  const c = res.clients || {};
  res.clients = { ...c, active: m.one(c.active), waitlist: m.one(c.waitlist), new_in_range: m.one(c.new_in_range), high_risk: m.one(c.high_risk), no_contact_30d: m.one(c.no_contact_30d),
    by_status: m.rows(c.by_status, 'n'), by_substance: m.rows(c.by_substance, 'n'), mat: m.rows(c.mat, 'n') };
  if (res.referrals) {
    const r = res.referrals;
    const admitted = (r.by_category || []).reduce((s, x) => s + (Number(x.successful) || 0), 0);
    // A median over fewer people than the threshold is one of them.
    res.referrals = { ...r, total: m.one(r.total), open: m.one(r.open), by_status: m.rows(r.by_status, 'n'), by_category: m.rows(r.by_category, 'n', 'successful'),
      median_days_to_admit: admitted < m.T ? null : r.median_days_to_admit };
  }
  if (res.patient_requests) res.patient_requests = { ...res.patient_requests, n: m.one(res.patient_requests.n), overdue: m.one(res.patient_requests.overdue) };
  if (typeof res.part2_notice_missing === 'number') res.part2_notice_missing = m.one(res.part2_notice_missing);
  if (typeof res.consents_expiring_clients === 'number') res.consents_expiring_clients = m.one(res.consents_expiring_clients);
  res.small_cells = { threshold: m.T, masked: true };
  return res;
}

/** The monthly trends, as this user is shown them. */
function monthly(user, out) {
  const m = maskerFor(user);
  if (!m) return out;
  return { ...out,
    intakes: m.rows(out.intakes, 'n'), discharges: m.rows(out.discharges, 'n'), interventions: m.rows(out.interventions, 'clients'),
    referrals: m.rows(out.referrals, 'n', 'successful'), overdose_events: m.rows(out.overdose_events, 'n', 'reversals', 'fatal'),
    episodes: m.rows(out.episodes, 'admissions', 'discharges'), unduplicated_clients: m.rows(out.unduplicated_clients, 'clients'), mat_linkage: m.rows(out.mat_linkage, 'n'),
    small_cells: { threshold: m.T, masked: true } };
}

/** The outcome measures summary (GET /api/reports/outcomes), as this user is shown it: counts of clients
 *  masked, and a mean or percentage over fewer clients than the threshold withheld (it describes them). */
function outcomes(user, instruments) {
  const m = maskerFor(user);
  if (!m) return instruments;
  return instruments.map(x => {
    const few = x.clients_with_followup < m.T;
    return { ...x, clients_screened: m.one(x.clients_screened), clients_with_followup: m.one(x.clients_with_followup),
      mean_baseline: few ? null : x.mean_baseline, mean_latest: few ? null : x.mean_latest, mean_change: few ? null : x.mean_change, pct_improved: few ? null : x.pct_improved,
      improved: m.one(x.improved), worse: m.one(x.worse), unchanged: m.one(x.unchanged), positive_at_baseline: m.one(x.positive_at_baseline), positive_at_latest: m.one(x.positive_at_latest), safety_flags: m.one(x.safety_flags) };
  });
}

module.exports = { dashboard, monthly, outcomes, masks, seesWorkers };
