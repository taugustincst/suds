'use strict';
// The reports a California harm-reduction programme owes besides its funder report
// (docs/compliance/HARM-REDUCTION-REPORTING.md, which also says what here is unverified):
//
//  * The Naloxone Distribution Project (DHCS NDP) distribution and reversal log. Built from what SUDS
//    already records: kits handed out on a visit or in community distribution (interventions.naloxone_kits,
//    the visit's location as the site type, a client or none as the recipient type) and overdose reversals
//    reported back (overdose_events with naloxone used and the person surviving). Aggregated by day, site
//    type and recipient type: no names, client codes or record ids.
//  * The opioid settlement expenditure report: spending from settlement funds grouped by the national
//    settlement's Exhibit E allowable uses and California's High Impact Abatement Activities
//    (constants.SETTLEMENT_USES / SETTLEMENT_HIAA; a fund's category, unless an expenditure has its own).
//    Also as the DHCS settlement expenditure layout (1.14.0): one row per activity (a settlement fund and the
//    Exhibit E category and HIAA its spending went to), in the order DHCS's Opioid Settlement Expenditure
//    Reporting Form asks, with the narrative fields left for the programme to write; and as a county's own
//    subrecipient template, matched by a column mapping an administrator or finance sets without code
//    (settlement_county_layout).
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const C = require('./constants');
const O = require('./options');
const FR = require('./funder-report');
const SC = require('./small-cells');

const NDP_TEMPLATE_NOTE = 'The column layout follows the fields the DHCS Naloxone Distribution Project (NDP) asks distributors to report, as SUDS understands them (date, site type, recipient type, kits and doses distributed, overdose reversals reported). It is not the official NDP template: it must be checked against the current NDP reporting template before it is submitted.';
const SETTLEMENT_SOURCE_NOTE = 'Categories follow Exhibit E ("List of Opioid Remediation Uses") of the national opioid settlement agreements and California\'s High Impact Abatement Activities list, as summarised by DHCS. Both need verification against the agreement governing each fund before the report is submitted; SUDS does not decide whether a cost is allowable.';

const dosesPerKit = () => Number(db.getSetting('naloxone_doses_per_kit', '')) || 2;

// The calendar day an event belongs to, in the programme's time zone; a bare day stays the day it is. One
// reader per report: the time zone is looked up and its formatter built once, not once per row (at 10,000
// kit rows that was most of a year's publication release).
function dayReader() {
  const B = require('./routes/budget'); const tz = B.orgTimezone();
  let fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { fmt = null; }
  return (at) => {
    if (!at) return null;
    if (String(at).length === 10) return at;
    if (!fmt) return B.localDate(at, tz);
    const d = new Date(at); return Number.isFinite(d.getTime()) ? fmt.format(d) : null;
  };
}

/**
 * The counting mode and purpose for this run, as the funder report's: a publication release only for the
 * whole programme and one standard period that has ended; suppressed unless reports:exact asks for exact
 * counts for a run that is not for publication.
 */
function counts(ctx, period) { const counting = FR.countingMode(ctx, period); return { counting, sc: { threshold: counting.threshold, exact: counting.mode === 'exact' } }; }
const header = (counting) => ({ suppression: FR.suppressionOf(counting), release: counting.release, counting_statement: FR.countingStatement(counting) });

/** Naloxone distributed (kits and doses: not people), by day or by month, site type and recipient type. */
function distributionRows(ctx, { ts, tsP }, monthly) {
  const cf = auth.caseloadFilter(ctx.user, 'c.id');
  const perKit = dosesPerKit(); const dayOf = dayReader();
  const rows = new Map();
  // The day-by-day log (the program's submission to the NDP) also says which naloxone product went out, where
  // the visit recorded it (its naloxone items, docs/SUPPLIES.md); kits recorded as a count alone, as every visit
  // before 1.14 was, are "not recorded", and stay so when such a visit is edited later (the part of an item
  // recorded before items existed, intervention_supplies.untracked). The published log by month does not split by product.
  const products = new Map();
  if (!monthly) {
    for (const x of db.all(`SELECT l.intervention_id, it.product, SUM(l.quantity - l.untracked) q FROM intervention_supplies l JOIN supply_items it ON it.id=l.item_id JOIN interventions i ON i.id=l.intervention_id
        WHERE ${ts('i.occurred_at')} AND it.category='naloxone' GROUP BY l.intervention_id, it.product`, ...tsP)) {
      if (!products.has(x.intervention_id)) products.set(x.intervention_id, []);
      products.get(x.intervention_id).push({ product: x.product || null, kits: x.q });
    }
  }
  // Community distribution has no client; a kit handed to someone on a caseload is counted for whoever may
  // see that caseload, the same scoping as every other export.
  for (const x of db.all(`SELECT i.id, i.occurred_at, i.location, i.client_id IS NULL AS anon, i.naloxone_kits kits FROM interventions i LEFT JOIN clients c ON c.id=i.client_id
      WHERE ${ts('i.occurred_at')} AND i.naloxone_kits > 0 AND (i.client_id IS NULL OR ${cf.sql})`, ...tsP, ...cf.params)) {
    const day = dayOf(x.occurred_at); const date = monthly ? day.slice(0, 7) : day; const site = x.location || 'unknown';
    const recipient = x.anon ? 'Community member (anonymous)' : 'Program participant';
    // The visit's kits by product: what its naloxone items say, and the rest as not recorded.
    const parts = [];
    if (!monthly) {
      let left = x.kits;
      for (const p of products.get(x.id) || []) { const k = Math.min(left, p.kits); if (k > 0 && p.product) { parts.push({ product: p.product, kits: k }); left -= k; } }
      if (left > 0) parts.push({ product: null, kits: left });
    } else parts.push({ kits: x.kits });
    for (const part of parts) {
      const key = monthly ? `d|${date}|${site}|${recipient}` : `d|${date}|${site}|${recipient}|${part.product || ''}`;
      if (!rows.has(key)) rows.set(key, { date, entry: 'distribution', site_type: site, recipient_type: recipient, ...(monthly ? {} : { product: part.product }), kits: 0, doses: 0, reversals: null, reversal_doses: null, administered_by: null });
      const r = rows.get(key); r.kits += part.kits; r.doses += part.kits * perKit;
    }
  }
  return rows;
}
const byDate = (a, b) => a.date.localeCompare(b.date) || a.entry.localeCompare(b.entry) || String(a.site_type).localeCompare(String(b.site_type));

/**
 * The published log (a publication release, server/publication-release.js): by month, not by day - a day at
 * one site is too fine a cell to publish - with the reversals by month for all sites together, which are the
 * funder report's reversals by month in the same release, shown the same way. Every month of the period has
 * a reversal row, zero or not (a row only for the months with a reversal would say which months had one),
 * and the doses used in them are cells of the same audited release. dist: distributionRows by month; shown:
 * { rows: [{ month, reversals, reversal_doses }] (none when the table is withheld), reversals, reversal_doses }.
 */
/** The settings the published log prints (read with the rest of a release, from its snapshot). */
const ndpSettings = () => ({ county: db.getSetting('county_name', '') || null, doses_per_kit: dosesPerKit() });
function ndpPublished({ from, to }, counting, dist, shown, settings = ndpSettings()) {
  const rev = shown.rows.map(x => ({ date: x.month, entry: 'reversal', site_type: 'all', recipient_type: null, kits: null, doses: null, reversals: x.reversals, reversal_doses: x.reversal_doses, administered_by: null,
    ...(typeof x.reversals === 'number' && typeof x.reversal_doses === 'number' ? {} : { suppressed: true }) }));
  const d = [...dist.values()];
  return { from, to, county: settings.county, doses_per_kit: settings.doses_per_kit, template_note: NDP_TEMPLATE_NOTE, rows: [...d, ...rev].sort(byDate), by: 'month', ...header(counting),
    totals: { kits: d.reduce((n, r) => n + r.kits, 0), doses: d.reduce((n, r) => n + r.doses, 0), reversals: shown.reversals, reversal_doses: shown.reversal_doses,
      community_kits: d.filter(r => r.recipient_type === 'Community member (anonymous)').reduce((n, r) => n + r.kits, 0) } };
}

async function ndp(ctx, range) {
  const { from, to, ts, tsP } = range;
  const { counting, sc } = counts(ctx, { from, to });
  // Published, the log is part of the period's publication release, computed and audited with the funder
  // report and the settlement report. The day-by-day log, by site and by who gave the naloxone, is for the
  // programme's own submission to the NDP (not for publication).
  if (counting.purpose === 'publication') return (await require('./publication-release').release(ctx, range, counting)).ndp;
  const cf = auth.caseloadFilter(ctx.user, 'c.id');
  const rows = distributionRows(ctx, range, false); const dayOf = dayReader();
  const add = (key, init, fn) => { if (!rows.has(key)) rows.set(key, init); fn(rows.get(key)); };
  for (const x of db.all(`SELECT o.occurred_at, o.location_type, o.naloxone_doses, o.administered_by FROM overdose_events o LEFT JOIN clients c ON c.id=o.client_id
      WHERE ${ts('o.occurred_at')} AND (o.naloxone_used=1 OR o.kind='reversal') AND o.survived=1 AND (o.client_id IS NULL OR ${cf.sql})`, ...tsP, ...cf.params)) {
    // The same coded site list as distribution; a place typed in before "Where" was a list is matched to
    // a code whatever its case, or counted as "other".
    const date = dayOf(x.occurred_at); const site = O.codeFor('LOCATIONS', x.location_type) || 'unknown'; const by = x.administered_by || 'unknown';
    add(`r|${date}|${site}|${by}`, { date, entry: 'reversal', site_type: site, recipient_type: null, kits: null, doses: null, reversals: 0, reversal_doses: 0, administered_by: by }, (r) => { r.reversals += 1; r.reversal_doses += x.naloxone_doses || 0; });
  }
  const list = [...rows.values()].sort(byDate);
  const sum = (k) => list.reduce((n, r) => n + (r[k] || 0), 0);
  const totals = { kits: sum('kits'), doses: sum('doses'), reversals: sum('reversals'), reversal_doses: sum('reversal_doses'), community_kits: list.filter(r => r.recipient_type === 'Community member (anonymous)').reduce((n, r) => n + r.kits, 0) };
  // Small cells (server/small-cells.js): a reversal is an event that happened to a person, so reversals per
  // row are counts of people, protected against the published total; the doses used in a hidden reversal
  // row go with it. Kits and doses distributed are not people and stay exact.
  const rev = list.filter(r => r.entry === 'reversal');
  const t = SC.table(rev, ['reversals'], { ...sc, totals: { reversals: totals.reversals, reversal_doses: totals.reversal_doses }, mirror: { reversal_doses: 'reversals' } });
  const out = list.map(r => (r.entry === 'reversal' ? t.rows[rev.indexOf(r)] : r));
  return { from, to, county: db.getSetting('county_name', '') || null, doses_per_kit: dosesPerKit(), template_note: NDP_TEMPLATE_NOTE, rows: out, by: 'day', ...header(counting),
    totals: { ...totals, reversals: t.totals.reversals, reversal_doses: t.totals.reversal_doses } };
}

const money = (n) => Math.round((n || 0) * 100) / 100;
const USE_LABEL = Object.fromEntries(C.SETTLEMENT_USES.map(x => [x.code, x]));
const HIAA_LABEL = Object.fromEntries([...C.SETTLEMENT_HIAA.map(x => [x.code, x.label]), ['none', 'Not a High Impact Abatement Activity']]);

/**
 * The settlement report's true figures. People per allowable use are true counts here; fundKeys: every
 * settlement fund's id, its allowable use as the people are grouped (or 'uncategorised') and whether it is
 * active (the funder report lists active funds only).
 */
function settlementFigures({ from, to, ts, tsP }) {
  // A settlement fund: one marked as opioid settlement money, or one given a settlement category.
  const isFund = `(f.source_type='opioid_settlement' OR f.settlement_use IS NOT NULL OR f.settlement_hiaa IS NOT NULL)`;
  const funds = db.all(`SELECT f.id, f.name, f.grant_number, f.fiscal_year_start, f.fiscal_year_end, f.total_amount, f.settlement_use, f.settlement_hiaa, f.is_active FROM funding_sources f WHERE ${isFund} ORDER BY f.name`);
  const exps = db.all(`SELECT e.amount, e.status, COALESCE(e.settlement_use, f.settlement_use) AS use_code, COALESCE(e.settlement_hiaa, f.settlement_hiaa) AS hiaa_code, f.id AS fund_id
    FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE ${isFund} AND e.spent_at BETWEEN ? AND ? AND e.status IN ('pending','approved','reimbursed')`, from, to);
  const bucket = () => ({ approved_amount: 0, pending_amount: 0, expenditures: 0 });
  const byUse = new Map([...C.SETTLEMENT_USES.map(x => [x.code, bucket()]), ['uncategorised', bucket()]]);
  const byHiaa = new Map([...C.SETTLEMENT_HIAA.map(x => [x.code, bucket()]), ['none', bucket()], ['uncategorised', bucket()]]);
  const detail = new Map();
  for (const e of exps) {
    const use = e.use_code && byUse.has(e.use_code) ? e.use_code : 'uncategorised'; const hiaa = e.hiaa_code && byHiaa.has(e.hiaa_code) ? e.hiaa_code : 'uncategorised';
    const key = `${use}|${hiaa}`; if (!detail.has(key)) detail.set(key, { use, hiaa, ...bucket() });
    for (const b of [byUse.get(use), byHiaa.get(hiaa), detail.get(key)]) {
      if (e.status === 'pending') b.pending_amount += e.amount; else b.approved_amount += e.amount;
      b.expenditures += 1;
    }
  }
  // Services charged to a settlement fund, by the fund's allowable use: what the money paid for, in people.
  // People as in the funder report: a deleted client's visits are services, but not a person served. The
  // period's visits are read once and each fund looked up (CROSS JOIN fixes that order): left to itself the
  // planner took each fund in turn and read the whole period's visits again for it, 1.1 s with 60 settlement
  // funds at 20,000 clients (0.1 s this way).
  const services = db.all(`SELECT COALESCE(f.settlement_use,'uncategorised') AS use_code, COUNT(*) services, COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL THEN i.client_id END) people, COALESCE(SUM(i.naloxone_kits),0) naloxone_kits
    FROM interventions i CROSS JOIN funding_sources f ON f.id=i.funding_source_id LEFT JOIN clients c ON c.id=i.client_id WHERE ${isFund} AND ${ts('i.occurred_at')} GROUP BY use_code`, ...tsP);
  const fix = (m) => [...m].map(([code, b]) => ({ code, ...b, approved_amount: money(b.approved_amount), pending_amount: money(b.pending_amount) }));
  const useRows = fix(byUse).map(x => ({ ...x, schedule: USE_LABEL[x.code]?.schedule || 'Uncategorised', label: USE_LABEL[x.code]?.label || 'No settlement category recorded' }));
  const hiaaRows = fix(byHiaa).map(x => ({ ...x, label: HIAA_LABEL[x.code] || 'No High Impact Abatement Activity recorded' }));
  const approved = money(exps.filter(e => e.status !== 'pending').reduce((n, e) => n + e.amount, 0));
  const hiaaAmount = money(hiaaRows.filter(x => /^hiaa_/.test(x.code)).reduce((n, x) => n + x.approved_amount, 0));
  return {
    from, to, source_note: SETTLEMENT_SOURCE_NOTE, funds,
    by_use: useRows, by_hiaa: hiaaRows,
    detail: [...detail.values()].map(x => ({ ...x, approved_amount: money(x.approved_amount), pending_amount: money(x.pending_amount), schedule: USE_LABEL[x.use]?.schedule || 'Uncategorised', use_label: USE_LABEL[x.use]?.label || 'No settlement category recorded', hiaa_label: HIAA_LABEL[x.hiaa] || 'No High Impact Abatement Activity recorded' }))
      .sort((a, b) => a.schedule.localeCompare(b.schedule) || a.use.localeCompare(b.use) || a.hiaa.localeCompare(b.hiaa)),
    // People per allowable use are counts of people (protected in settlement() below); services and kits are not.
    // In key order, never by size: a release lists rows in a fixed order (server/publication-release.js).
    services_by_use: services.map(x => ({ ...x, label: USE_LABEL[x.use_code]?.label || 'No settlement category recorded' })).sort((a, b) => (a.use_code < b.use_code ? -1 : a.use_code > b.use_code ? 1 : 0)),
    fundKeys: funds.map(f => ({ id: f.id, key: f.settlement_use || 'uncategorised', active: !!f.is_active })),
    totals: { approved_amount: approved, pending_amount: money(exps.filter(e => e.status === 'pending').reduce((n, e) => n + e.amount, 0)), hiaa_amount: hiaaAmount,
      hiaa_share: approved ? Math.round(1000 * hiaaAmount / approved) / 10 : null, uncategorised_amount: byUse.get('uncategorised').approved_amount + byUse.get('uncategorised').pending_amount },
  };
}

async function settlement(ctx, range) {
  const { from, to, ts, tsP } = range;
  const { counting, sc } = counts(ctx, { from, to });
  // Published, the report is part of the period's publication release (server/publication-release.js).
  if (counting.purpose === 'publication') return (await require('./publication-release').release(ctx, range, counting)).settlement;
  const { fundKeys, ...d } = settlementFigures(range);
  // People per allowable use are some of the people the programme served in the period: protected against
  // that total (the people left when one use's are taken from it are a count of people too), and never one
  // hidden use beside visible ones.
  let people = d.services_by_use.map(x => x.people);
  if (!sc.exact) {
    const served = FR.servedCount(ts, tsP);
    people = SC.noLonely(SC.star({ total: served, subsets: people.map(n => Math.min(n, served)) }, { ...sc, fixedTotal: true }).subsets);
  }
  return { ...d, funds: d.funds.map(({ is_active, ...f }) => f), services_by_use: d.services_by_use.map((x, i) => FR.withCell(x, 'people', people[i])), ...header(counting) };
}

// The counting mode travels with the file, as with the funder report: in the filename, a response header
// and (Excel) the About sheet.
const countsSuffix = (d) => (d.suppression.mode === 'exact' ? 'exact-counts' : d.suppression.purpose === 'publication' ? 'publication-screened-review-before-sharing' : 'internal-suppressed');
const purposeLine = (d) => ({ k: 'Purpose', v: d.suppression.purpose === 'publication' ? `${FR.PUBLICATION_LABEL} (whole program, one standard period)` : d.suppression.purpose === 'submission' ? 'The program\'s own submission, not for publication' : 'Internal, not for publication' });
// The About rows every file of a run carries about what it is for (and, for a publication release, what to do before sharing it).
const purposeRows = (d) => [purposeLine(d), ...(d.suppression.purpose === 'publication' ? [{ k: 'Before publishing', v: FR.PUBLICATION_GUIDANCE }] : [])];
function send(ctx, { body, filename, xlsx, classification, suppression }) {
  ctx.res.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'X-SUDS-Export': classification,
    'X-SUDS-Report-Counts': suppression.mode === 'exact' ? 'exact' : `suppressed (threshold ${suppression.threshold})`, 'X-SUDS-Report-Purpose': suppression.purpose });
  ctx.res.end(body);
}
const aboutSheet = (ctx, rows) => ({ name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: [...rows, { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username }] });

// Why the settlement report is empty, in words, when it is: a file with a header row and nothing under it
// said nothing (a fund the first-run wizard created was never settlement money, so this was every new install's).
const NO_SETTLEMENT_FUNDS = 'No funding source is marked as opioid settlement money, so there is nothing to report. Under Funding & spending, set the fund\'s source type to Opioid settlement and choose the allowable use it pays for.';
const NO_SETTLEMENT_SPENDING = 'No spending from opioid settlement funds was recorded in this period.';
function withNote(d) {
  const note = !d.funds.length ? NO_SETTLEMENT_FUNDS : !d.detail.length ? NO_SETTLEMENT_SPENDING : null;
  return note ? { ...d, note } : d;
}

// ---- the DHCS settlement expenditure layout, and a county's own template ----
// DHCS's California Opioid Settlement Expenditure Reporting Form (an online form since SFY 2025-26; its
// Preview & Guide and training say what it asks) is completed per activity or program: the settlement and
// fund the money came from, the activity, the Exhibit E category that best matches it, the High Impact
// Abatement Activity it counts toward (one, with a rationale of no more than 200 words), the organisations
// that received funds, and the amounts. SUDS fills what it holds and leaves the rest, marked, for the
// programme to write: docs/compliance/HARM-REDUCTION-REPORTING.md says which is which. DHCS asks that no
// number of people of 10 or fewer be reported (it may identify someone), so people served are given as
// "10 or fewer" below 11 whatever the run's counting.
const TO_COMPLETE = '';
const DHCS_FIELDS = [
  { key: 'period', label: 'Reporting period', filled: true },
  { key: 'settlement', label: 'Settlement(s) the funds came from (to complete)', filled: false },
  { key: 'fund_type', label: 'Fund (CA Subdivision Fund, CA Abatement Accounts Fund or Plaintiff Subdivision) (to complete)', filled: false },
  { key: 'fund_name', label: 'Funding source in SUDS', filled: true },
  { key: 'grant_number', label: 'Grant or agreement number', filled: true },
  { key: 'activity_name', label: 'Activity or program name (to complete)', filled: false },
  { key: 'activity_description', label: 'Description of the activity (to complete)', filled: false },
  { key: 'exhibit_e_schedule', label: 'Exhibit E schedule', filled: true },
  { key: 'exhibit_e_category', label: 'Exhibit E category (opioid remediation use)', filled: true },
  { key: 'hiaa', label: 'High Impact Abatement Activity', filled: true },
  { key: 'hiaa_rationale', label: 'How the activity meets the HIAA, 200 words at most (to complete)', filled: false },
  { key: 'funded_organization', label: 'Organization(s) that received the funds', filled: true },
  { key: 'approved_amount', label: 'Amount expended ($, approved or reimbursed)', filled: true },
  { key: 'pending_amount', label: 'Amount pending approval ($)', filled: true },
  { key: 'expenditures', label: 'Expenditures (count)', filled: true },
  { key: 'services', label: 'Services charged to the fund (count, whole fund)', filled: true },
  { key: 'people_served', label: 'People served by the fund\'s services (whole fund; 10 or fewer not reported)', filled: true },
  { key: 'outcomes', label: 'Outcomes and narrative (to complete)', filled: false },
];
const DHCS_KEYS = DHCS_FIELDS.map(f => f.key);
const DHCS_NOTE = 'Laid out after the fields of the DHCS California Opioid Settlement Expenditure Reporting Form as SUDS understands them from DHCS\'s published guide (one row per activity: a settlement fund and the Exhibit E category and HIAA its spending went to). It is not the DHCS form, which is completed online: copy each row into it, and write the columns marked "to complete". Check the categories against the agreement governing each fund.';
/** DHCS: do not report a number of people of 10 or fewer. */
const dhcsPeople = (v) => (typeof v === 'number' && v > 0 && v <= 10 ? '10 or fewer' : v);

/**
 * The DHCS layout's rows for this run (never a publication release: this is the programme's own report).
 * People per fund are counts of people: protected like people per allowable use in a suppressed run, and
 * under DHCS's own rule in every run.
 */
function dhcsRows(ctx, { from, to, ts, tsP }, sc) {
  const isFund = `(f.source_type='opioid_settlement' OR f.settlement_use IS NOT NULL OR f.settlement_hiaa IS NOT NULL)`;
  const funds = db.all(`SELECT f.id, f.name, f.grant_number, f.settlement_use, f.settlement_hiaa FROM funding_sources f WHERE ${isFund} ORDER BY f.name`);
  const exps = db.all(`SELECT e.amount, e.status, COALESCE(e.settlement_use, f.settlement_use) AS use_code, COALESCE(e.settlement_hiaa, f.settlement_hiaa) AS hiaa_code, f.id AS fund_id
    FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id WHERE ${isFund} AND e.spent_at BETWEEN ? AND ? AND e.status IN ('pending','approved','reimbursed')`, from, to);
  const svc = new Map(db.all(`SELECT i.funding_source_id fid, COUNT(*) services, COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL THEN i.client_id END) people
    FROM interventions i JOIN funding_sources f ON f.id=i.funding_source_id LEFT JOIN clients c ON c.id=i.client_id WHERE ${isFund} AND ${ts('i.occurred_at')} GROUP BY i.funding_source_id`, ...tsP).map(x => [x.fid, x]));
  let people = funds.map(f => (svc.get(f.id) || { people: 0 }).people);
  if (!sc.exact) {
    const served = FR.servedCount(ts, tsP);
    people = SC.noLonely(SC.star({ total: served, subsets: people.map(n => Math.min(n, served)) }, { ...sc, fixedTotal: true }).subsets);
  }
  const peopleOf = new Map(funds.map((f, i) => [f.id, dhcsPeople(people[i])]));
  const org = db.getSetting('org_name', '') || '';
  const rows = new Map();
  const key = (fid, use, hiaa) => `${fid}|${use}|${hiaa}`;
  const rowFor = (f, use, hiaa) => {
    const k = key(f.id, use, hiaa);
    if (!rows.has(k)) {
      rows.set(k, { period: `${from} to ${to}`, settlement: TO_COMPLETE, fund_type: TO_COMPLETE, fund_name: f.name, grant_number: f.grant_number || '', activity_name: TO_COMPLETE, activity_description: TO_COMPLETE,
        exhibit_e_schedule: USE_LABEL[use]?.schedule || 'Uncategorised: choose the Exhibit E category in SUDS (Funding)', exhibit_e_category: USE_LABEL[use]?.label || 'No settlement category recorded',
        hiaa: HIAA_LABEL[hiaa] || 'No High Impact Abatement Activity recorded', hiaa_rationale: TO_COMPLETE, funded_organization: org,
        approved_amount: 0, pending_amount: 0, expenditures: 0, services: (svc.get(f.id) || { services: 0 }).services, people_served: peopleOf.get(f.id), outcomes: TO_COMPLETE, _fund: f.id, _use: use, _hiaa: hiaa });
    }
    return rows.get(k);
  };
  const byId = new Map(funds.map(f => [f.id, f]));
  for (const e of exps) {
    const use = e.use_code && USE_LABEL[e.use_code] ? e.use_code : 'uncategorised'; const hiaa = e.hiaa_code && HIAA_LABEL[e.hiaa_code] ? e.hiaa_code : 'uncategorised';
    const r = rowFor(byId.get(e.fund_id), use, hiaa);
    if (e.status === 'pending') r.pending_amount += e.amount; else r.approved_amount += e.amount;
    r.expenditures += 1;
  }
  // A fund that provided services but spent nothing in the period still has an activity to report: its own category.
  for (const f of funds) if (svc.has(f.id) && ![...rows.values()].some(r => r._fund === f.id)) rowFor(f, f.settlement_use && USE_LABEL[f.settlement_use] ? f.settlement_use : 'uncategorised', f.settlement_hiaa && HIAA_LABEL[f.settlement_hiaa] ? f.settlement_hiaa : 'uncategorised');
  return [...rows.values()].map(r => ({ ...r, approved_amount: money(r.approved_amount), pending_amount: money(r.pending_amount) }))
    .sort((a, b) => a.fund_name.localeCompare(b.fund_name) || a._use.localeCompare(b._use) || a._hiaa.localeCompare(b._hiaa))
    .map(({ _fund, _use, _hiaa, ...r }) => r);
}

/**
 * A county's own subrecipient template, matched without code: its name and its columns in order, each taken
 * from one DHCS-layout field (source), left blank for the programme to write ('blank'), or the same text on
 * every row ('text', e.g. the programme's contract number). Stored as JSON in settlement_county_layout.
 */
function countyLayout() {
  try { const v = JSON.parse(db.getSetting('settlement_county_layout', '') || 'null'); return v && Array.isArray(v.columns) ? v : null; } catch { return null; }
}
function checkCountyLayout(v) {
  const { badRequest } = require('./http');
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badRequest('The layout must be an object with a name and its columns');
  const name = String(v.name || '').trim();
  if (!name || name.length > 100) throw badRequest('Name the county template (at most 100 characters)', { fields: { name: 'is required' } });
  if (!Array.isArray(v.columns) || !v.columns.length || v.columns.length > 60) throw badRequest('A county template has from 1 to 60 columns', { fields: { columns: 'from 1 to 60' } });
  const seen = new Set();
  const columns = v.columns.map((c, i) => {
    const label = String((c && c.label) || '').trim(); const source = String((c && c.source) || '').trim();
    if (!label || label.length > 100) throw badRequest(`Column ${i + 1} needs a heading of at most 100 characters`, { fields: { [`columns.${i}.label`]: 'is required' } });
    if (seen.has(label.toLowerCase())) throw badRequest(`Two columns are headed "${label}"`, { fields: { [`columns.${i}.label`]: 'must be unique' } });
    seen.add(label.toLowerCase());
    if (![...DHCS_KEYS, 'blank', 'text'].includes(source)) throw badRequest(`Column "${label}": its source must be one of ${[...DHCS_KEYS, 'blank', 'text'].join(', ')}`, { fields: { [`columns.${i}.source`]: 'is not a field SUDS fills' } });
    const text = source === 'text' ? String((c && c.text) || '').slice(0, 200) : undefined;
    return { label, source, ...(source === 'text' ? { text } : {}) };
  });
  return { name, columns };
}
/** The DHCS rows as a county template's columns. */
function countyRows(layout, rows) {
  const columns = layout.columns.map((c, i) => ({ key: `c${i}`, label: c.label }));
  const out = rows.map(r => Object.fromEntries(layout.columns.map((c, i) => [`c${i}`, c.source === 'blank' ? '' : c.source === 'text' ? c.text || '' : r[c.source] ?? ''])));
  return { columns, rows: out };
}

/** Settings for the county template: read (budget:read) and set (budget:manage: finance, supervisors, administrators). */
function layoutRoutes(r) {
  r.get('/api/reports/settlement-layout', auth.requireAuth, auth.requirePerm('budget:read'), () => ({
    dhcs_fields: DHCS_FIELDS, sources: [...DHCS_FIELDS.map(f => ({ value: f.key, label: f.label })), { value: 'blank', label: 'Blank (the program writes it)' }, { value: 'text', label: 'Fixed text (the same on every row)' }],
    county: countyLayout(), dhcs_note: DHCS_NOTE }));
  r.put('/api/reports/settlement-layout', auth.requireAuth, auth.requirePerm('budget:manage'), (ctx) => {
    const body = ctx.body || {};
    if (body.county === null) { db.run(`DELETE FROM settings WHERE key='settlement_county_layout'`); audit.log({ user: ctx.user, action: 'settings.settlement_layout', ip: ctx.ip, details: { cleared: true } }); return { county: null }; }
    const v = checkCountyLayout(body.county);
    db.setSetting('settlement_county_layout', JSON.stringify(v));
    audit.log({ user: ctx.user, action: 'settings.settlement_layout', ip: ctx.ip, details: { name: v.name, columns: v.columns.length } });
    return { county: v };
  });
}

function routes(r, range) {
  const S = require('./spreadsheet');
  // The day log (the program's submission) says which naloxone product went out; the published log by month does not.
  const ndpColumns = (d) => NDP_COLUMNS.filter(c => c.key !== 'product' || d.by !== 'month');
  const NDP_COLUMNS = [['date', 'Date'], ['entry', 'Entry'], ['site_type', 'Site type'], ['recipient_type', 'Recipient type'], ['product', 'Naloxone product'], ['kits', 'Kits distributed'], ['doses', 'Naloxone doses distributed'], ['reversals', 'Reversals reported'], ['reversal_doses', 'Doses used in reversals'], ['administered_by', 'Naloxone given by']].map(([key, label]) => ({ key, label }));
  const SN = require('./supply-names');
  const productLabel = (x) => (x.entry !== 'distribution' || !('product' in x) ? null : x.product ? SN.labelOf(SN.NALOXONE_PRODUCTS, x.product) : 'Not recorded');
  const ndpRows = (d) => d.rows.map(x => ({ ...x, product: productLabel(x), entry: x.entry === 'distribution' ? 'Distribution' : 'Reversal reported', site_type: x.site_type === 'unknown' ? 'Unknown' : x.site_type === 'all' ? 'All sites' : O.labelOf('LOCATIONS', x.site_type),
    administered_by: x.administered_by ? O.labelOf('ADMINISTERED_BY', x.administered_by) : null }));

  r.get('/api/reports/naloxone-ndp', auth.requireAuth, auth.requirePerm('reports:read'), async (ctx) => {
    const d = await ndp(ctx, range(ctx));
    audit.log({ user: ctx.user, action: 'report.naloxone_ndp', ip: ctx.ip, details: { from: d.from, to: d.to, rows: d.rows.length, counts: d.suppression.mode, purpose: d.suppression.purpose } });
    return d;
  });
  r.get('/api/reports/naloxone-ndp/export', auth.requireAuth, auth.requirePerm('reports:read'), auth.requirePerm('export:read'), async (ctx) => {
    const d = await ndp(ctx, range(ctx)); const xlsx = ctx.query.get('format') === 'xlsx'; const rows = ndpRows(d);
    FR.requirePublicationReview(ctx, d, 'naloxone-ndp');
    audit.log({ user: ctx.user, action: 'report.naloxone_ndp.export', ip: ctx.ip, details: { from: d.from, to: d.to, rows: rows.length, counts: d.suppression.mode, purpose: d.suppression.purpose, format: xlsx ? 'xlsx' : 'csv' } });
    const body = xlsx ? S.writeWorkbook([{ name: 'NDP log', columns: ndpColumns(d), rows }, aboutSheet(ctx, [
      { k: 'Report', v: 'Naloxone distribution and reversal log (NDP-style)' }, { k: 'Template', v: d.template_note }, { k: 'Period', v: `${d.from} to ${d.to}` }, { k: 'County', v: d.county || '' },
      { k: 'Doses per kit', v: `${d.doses_per_kit} (Settings: naloxone doses per kit)` }, { k: 'Totals', v: `${d.totals.kits} kits, ${d.totals.doses} doses distributed (${d.totals.community_kits} kits to anonymous community members); ${d.totals.reversals} reversals reported` },
      ...purposeRows(d), { k: 'Counts', v: d.counting_statement },
      { k: 'Classification', v: d.by === 'month' ? 'Aggregate counts by month (distribution also by site type and recipient type; reversals for all sites together): no names, client codes or record ids.' : 'Aggregate counts by day, site type and recipient type: no names, client codes or record ids.' }])]) : S.toCsv(rows, ndpColumns(d));
    send(ctx, { body, xlsx, suppression: d.suppression, filename: `suds-naloxone-ndp-log-${d.from}_${d.to}-${countsSuffix(d)}.${xlsx ? 'xlsx' : 'csv'}`, classification: 'NDP-style log (not the official NDP template; check it against the current NDP reporting template). Aggregate, no identifiers.' });
  });

  r.get('/api/reports/opioid-settlement', auth.requireAuth, auth.requirePerm('budget:read'), async (ctx) => {
    const d = withNote(await settlement(ctx, range(ctx)));
    audit.log({ user: ctx.user, action: 'report.opioid_settlement', ip: ctx.ip, details: { from: d.from, to: d.to, funds: d.funds.length, counts: d.suppression.mode, purpose: d.suppression.purpose } });
    return d;
  });
  r.get('/api/reports/opioid-settlement/export', auth.requireAuth, auth.requirePerm('budget:read'), auth.requirePerm('export:read'), async (ctx) => {
    const layout = ctx.query.get('layout') || '';
    if (layout && !['dhcs', 'county'].includes(layout)) throw require('./http').badRequest('layout must be dhcs (the DHCS settlement expenditure layout) or county (the county template set under Reports)');
    if (layout && ctx.query.get('purpose') === 'publication') throw require('./http').badRequest('The DHCS and county layouts are the program\'s own report to DHCS or its county, not a publication release: run them without purpose=publication.');
    if (layout === 'county' && !countyLayout()) throw require('./http').badRequest('No county template is set up yet: set its columns under Reports \u203a Harm-reduction reporting \u203a County template.');
    const rg = range(ctx);
    const d = withNote(await settlement(ctx, rg)); const xlsx = ctx.query.get('format') === 'xlsx';
    if (layout) {
      if (d.suppression.purpose === 'publication') throw require('./http').badRequest('The DHCS and county layouts are the program\'s own report, not a publication release: your role can run only publication releases of this report.');
      const sc = { threshold: d.suppression.threshold, exact: d.suppression.mode === 'exact' };
      const rows = dhcsRows(ctx, rg, sc);
      const county = layout === 'county' ? countyLayout() : null;
      const t = county ? countyRows(county, rows) : { columns: DHCS_FIELDS.map(f => ({ key: f.key, label: f.label })), rows };
      audit.log({ user: ctx.user, action: 'report.opioid_settlement.export', ip: ctx.ip, details: { from: d.from, to: d.to, counts: d.suppression.mode, purpose: d.suppression.purpose, format: xlsx ? 'xlsx' : 'csv', layout, rows: rows.length } });
      const title = county ? `County template: ${county.name}` : 'DHCS settlement expenditure layout';
      const toComplete = county ? county.columns.filter(c => c.source === 'blank' || (DHCS_FIELDS.find(f => f.key === c.source) || {}).filled === false).map(c => c.label) : DHCS_FIELDS.filter(f => !f.filled).map(f => f.label);
      const body = xlsx ? S.writeWorkbook([{ name: county ? 'County template' : 'DHCS layout', columns: t.columns, rows: t.rows }, aboutSheet(ctx, [
        { k: 'Report', v: `Opioid settlement expenditures: ${title}` }, { k: 'Period', v: `${d.from} to ${d.to}` }, { k: 'Layout', v: county ? `${county.name}, as mapped in SUDS (Reports \u203a County template) from the DHCS layout's fields. Check it against the county's current template.` : DHCS_NOTE },
        { k: 'Filled by SUDS', v: 'Period, funding source, grant number, Exhibit E schedule and category, HIAA, the receiving organization (this program), amounts, expenditures, services and people served.' },
        { k: 'For the program to write', v: toComplete.join('; ') || 'Nothing' },
        { k: 'People served', v: 'People served by the fund\'s services, counted once each; a number of 10 or fewer is not reported (DHCS asks that none be).' },
        { k: 'Sources and verification', v: d.source_note }, ...purposeRows(d), { k: 'Counts', v: d.counting_statement }])]) : S.toCsv(t.rows, t.columns);
      return send(ctx, { body, xlsx, suppression: d.suppression, filename: `suds-opioid-settlement-${layout === 'county' ? 'county-template' : 'dhcs-layout'}-${d.from}_${d.to}-${countsSuffix(d)}.${xlsx ? 'xlsx' : 'csv'}`,
        classification: `${title} (check against the current ${county ? 'county template' : 'DHCS reporting form'}; columns marked to complete are for the program). Aggregate, no client information.` });
    }
    FR.requirePublicationReview(ctx, d, 'opioid-settlement');
    audit.log({ user: ctx.user, action: 'report.opioid_settlement.export', ip: ctx.ip, details: { from: d.from, to: d.to, counts: d.suppression.mode, purpose: d.suppression.purpose, format: xlsx ? 'xlsx' : 'csv' } });
    const detailCols = [['schedule', 'Schedule'], ['use_label', 'Category'], ['hiaa_label', 'High Impact Abatement Activity'], ['approved_amount', 'Approved or reimbursed ($)'], ['pending_amount', 'Pending ($)'], ['expenditures', 'Expenditures']].map(([key, label]) => ({ key, label }));
    const body = xlsx ? S.writeWorkbook([
      aboutSheet(ctx, [{ k: 'Report', v: 'Opioid settlement expenditures by allowable use' }, { k: 'Period', v: `${d.from} to ${d.to}` }, { k: 'Funds', v: d.funds.map(f => f.name).join('; ') || 'No settlement funds' }, ...(d.note ? [{ k: 'Note', v: d.note }] : []),
        { k: 'Approved or reimbursed', v: d.totals.approved_amount }, { k: 'Of which High Impact Abatement Activities', v: `${d.totals.hiaa_amount} (${d.totals.hiaa_share ?? 0}%)` }, { k: 'Sources and verification', v: d.source_note }, ...purposeRows(d), { k: 'Counts', v: d.counting_statement }]),
      { name: 'By allowable use', columns: [['schedule', 'Schedule'], ['label', 'Category'], ['approved_amount', 'Approved or reimbursed ($)'], ['pending_amount', 'Pending ($)'], ['expenditures', 'Expenditures']].map(([key, label]) => ({ key, label })), rows: d.by_use },
      { name: 'By HIAA', columns: [['label', 'High Impact Abatement Activity'], ['approved_amount', 'Approved or reimbursed ($)'], ['pending_amount', 'Pending ($)'], ['expenditures', 'Expenditures']].map(([key, label]) => ({ key, label })), rows: d.by_hiaa },
      { name: 'Detail', columns: detailCols, rows: d.detail },
      { name: 'Services', columns: [['label', 'Category'], ['services', 'Services'], ['people', 'People served'], ['naloxone_kits', 'Naloxone kits']].map(([key, label]) => ({ key, label })), rows: d.services_by_use },
    ]) : S.toCsv(d.detail.length ? d.detail : [{ schedule: 'Note', use_label: d.note }], detailCols);
    send(ctx, { body, xlsx, suppression: d.suppression, filename: `suds-opioid-settlement-${d.from}_${d.to}-${countsSuffix(d)}.${xlsx ? 'xlsx' : 'csv'}`, classification: 'Opioid settlement expenditures by category (categories need verification against the governing agreement). No client information.' });
  });
}

module.exports = { ndp, settlement, settlementFigures, distributionRows, ndpPublished, ndpSettings, header, routes, layoutRoutes, dhcsRows, countyRows, checkCountyLayout, countyLayout, DHCS_FIELDS, DHCS_NOTE, dhcsPeople, NDP_TEMPLATE_NOTE, SETTLEMENT_SOURCE_NOTE };
