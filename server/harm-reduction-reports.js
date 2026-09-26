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

// The calendar day an event belongs to, in the programme's time zone; a bare day stays the day it is.
function dayOf(at) {
  if (!at) return null;
  if (String(at).length === 10) return at;
  return require('./routes/budget').localDate(at);
}

/**
 * The counting mode and purpose for this run, as the funder report's: a publication release only for the
 * whole programme and one standard period that has ended; suppressed unless reports:exact asks for exact
 * counts for a run that is not for publication.
 */
function counts(ctx, period) { const counting = FR.countingMode(ctx, period); return { counting, sc: { threshold: counting.threshold, exact: counting.mode === 'exact' } }; }
const header = (counting) => ({ suppression: FR.suppressionOf(counting), release: counting.release, counting_statement: FR.countingStatement(counting) });

function ndp(ctx, { from, to, ts, tsP }) {
  const { counting, sc } = counts(ctx, { from, to });
  // Published, the log is by month, not by day: a day at one site is too fine a cell to publish, and the
  // reversals are then exactly the funder report's reversals by month for the same release, suppressed by
  // the same call, so the two cannot be subtracted from each other. The day-by-day log, by site and by who
  // gave the naloxone, is for the programme's own submission to the NDP (not for publication).
  const monthly = counting.purpose === 'publication';
  const cf = auth.caseloadFilter(ctx.user, 'c.id');
  const perKit = dosesPerKit();
  const rows = new Map();
  const add = (key, init, fn) => { if (!rows.has(key)) rows.set(key, init); fn(rows.get(key)); };
  // Community distribution has no client; a kit handed to someone on a caseload is counted for whoever may
  // see that caseload, the same scoping as every other export.
  for (const x of db.all(`SELECT i.occurred_at, i.location, i.client_id IS NULL AS anon, i.naloxone_kits kits FROM interventions i LEFT JOIN clients c ON c.id=i.client_id
      WHERE ${ts('i.occurred_at')} AND i.naloxone_kits > 0 AND (i.client_id IS NULL OR ${cf.sql})`, ...tsP, ...cf.params)) {
    const day = dayOf(x.occurred_at); const date = monthly ? day.slice(0, 7) : day; const site = x.location || 'unknown';
    const recipient = x.anon ? 'Community member (anonymous)' : 'Programme participant';
    add(`d|${date}|${site}|${recipient}`, { date, entry: 'distribution', site_type: site, recipient_type: recipient, kits: 0, doses: 0, reversals: null, reversal_doses: null, administered_by: null }, (r) => { r.kits += x.kits; r.doses += x.kits * perKit; });
  }
  if (monthly) {
    // Whole programme (a publication release has no caseload scope), so every event counts, as in the
    // funder report.
    const od = FR.overdoseFigures(ts, tsP);
    const m = FR.overdoseProtect(od, sc);
    const rev = od.by_month.map((x, i) => ({ x, shown: m.by_month[i] })).filter(({ x }) => x.reversals > 0)
      .map(({ x, shown }) => ({ date: x.month, entry: 'reversal', site_type: 'all', recipient_type: null, kits: null, doses: null, reversals: shown.reversals, reversal_doses: x.reversal_doses, administered_by: null }));
    // The doses used in a hidden month go with it, protected against the total doses.
    const totalDoses = rev.reduce((n, r) => n + r.reversal_doses, 0);
    const t = SC.table(rev, [], { ...sc, totals: { reversal_doses: totalDoses }, mirror: { reversal_doses: 'reversals' } });
    const dist = [...rows.values()];
    const list = [...dist, ...t.rows].sort((a, b) => a.date.localeCompare(b.date) || a.entry.localeCompare(b.entry) || String(a.site_type).localeCompare(String(b.site_type)));
    return { from, to, county: db.getSetting('county_name', '') || null, doses_per_kit: perKit, template_note: NDP_TEMPLATE_NOTE, rows: list, by: 'month', ...header(counting),
      totals: { kits: dist.reduce((n, r) => n + r.kits, 0), doses: dist.reduce((n, r) => n + r.doses, 0), reversals: m.reversals, reversal_doses: t.totals.reversal_doses,
        community_kits: dist.filter(r => r.recipient_type === 'Community member (anonymous)').reduce((n, r) => n + r.kits, 0) } };
  }
  for (const x of db.all(`SELECT o.occurred_at, o.location_type, o.naloxone_doses, o.administered_by FROM overdose_events o LEFT JOIN clients c ON c.id=o.client_id
      WHERE ${ts('o.occurred_at')} AND (o.naloxone_used=1 OR o.kind='reversal') AND o.survived=1 AND (o.client_id IS NULL OR ${cf.sql})`, ...tsP, ...cf.params)) {
    // The same coded site list as distribution; a place typed in before "Where" was a list is matched to
    // a code whatever its case, or counted as "other".
    const date = dayOf(x.occurred_at); const site = O.codeFor('LOCATIONS', x.location_type) || 'unknown'; const by = x.administered_by || 'unknown';
    add(`r|${date}|${site}|${by}`, { date, entry: 'reversal', site_type: site, recipient_type: null, kits: null, doses: null, reversals: 0, reversal_doses: 0, administered_by: by }, (r) => { r.reversals += 1; r.reversal_doses += x.naloxone_doses || 0; });
  }
  const list = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.entry.localeCompare(b.entry) || String(a.site_type).localeCompare(String(b.site_type)));
  const sum = (k) => list.reduce((n, r) => n + (r[k] || 0), 0);
  const totals = { kits: sum('kits'), doses: sum('doses'), reversals: sum('reversals'), reversal_doses: sum('reversal_doses'), community_kits: list.filter(r => r.recipient_type === 'Community member (anonymous)').reduce((n, r) => n + r.kits, 0) };
  // Small cells (server/small-cells.js): a reversal is an event that happened to a person, so reversals per
  // row are counts of people, protected against the published total; the doses used in a hidden reversal
  // row go with it. Kits and doses distributed are not people and stay exact.
  const rev = list.filter(r => r.entry === 'reversal');
  const t = SC.table(rev, ['reversals'], { ...sc, totals: { reversals: totals.reversals, reversal_doses: totals.reversal_doses }, mirror: { reversal_doses: 'reversals' } });
  const out = list.map(r => (r.entry === 'reversal' ? t.rows[rev.indexOf(r)] : r));
  return { from, to, county: db.getSetting('county_name', '') || null, doses_per_kit: perKit, template_note: NDP_TEMPLATE_NOTE, rows: out, by: 'day', ...header(counting),
    totals: { ...totals, reversals: t.totals.reversals, reversal_doses: t.totals.reversal_doses } };
}

const money = (n) => Math.round((n || 0) * 100) / 100;
const USE_LABEL = Object.fromEntries(C.SETTLEMENT_USES.map(x => [x.code, x]));
const HIAA_LABEL = Object.fromEntries([...C.SETTLEMENT_HIAA.map(x => [x.code, x.label]), ['none', 'Not a High Impact Abatement Activity']]);

function settlement(ctx, { from, to, ts, tsP }) {
  const { counting, sc } = counts(ctx, { from, to });
  // A settlement fund: one marked as opioid settlement money, or one given a settlement category.
  const isFund = `(f.source_type='opioid_settlement' OR f.settlement_use IS NOT NULL OR f.settlement_hiaa IS NOT NULL)`;
  const funds = db.all(`SELECT f.id, f.name, f.grant_number, f.fiscal_year_start, f.fiscal_year_end, f.total_amount, f.settlement_use, f.settlement_hiaa FROM funding_sources f WHERE ${isFund} ORDER BY f.name`);
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
  // People as in the funder report: a deleted client's visits are services, but not a person served.
  const services = db.all(`SELECT COALESCE(f.settlement_use,'uncategorised') AS use_code, COUNT(*) services, COUNT(DISTINCT CASE WHEN c.deleted_at IS NULL THEN i.client_id END) people, COALESCE(SUM(i.naloxone_kits),0) naloxone_kits
    FROM interventions i JOIN funding_sources f ON f.id=i.funding_source_id LEFT JOIN clients c ON c.id=i.client_id WHERE ${isFund} AND ${ts('i.occurred_at')} GROUP BY use_code`, ...tsP);
  // People per allowable use are some of the people the programme served in the period, a total the funder
  // report publishes: protected against it (the people left when one use's are taken from it are a count of
  // people too), and never one hidden use beside visible ones.
  let people = services.map(x => x.people);
  if (!sc.exact) {
    const served = FR.servedCount(ts, tsP);
    people = SC.noLonely(SC.star({ total: served, subsets: people.map(n => Math.min(n, served)) }, { ...sc, fixedTotal: true }).subsets);
  }
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
    // People per allowable use are counts of people (protected above); services and kits are not.
    services_by_use: services.map((x, i) => ({ ...x, people: people[i], ...(typeof people[i] === 'number' ? {} : { suppressed: true }), label: USE_LABEL[x.use_code]?.label || 'No settlement category recorded' })),
    ...header(counting),
    totals: { approved_amount: approved, pending_amount: money(exps.filter(e => e.status === 'pending').reduce((n, e) => n + e.amount, 0)), hiaa_amount: hiaaAmount,
      hiaa_share: approved ? Math.round(1000 * hiaaAmount / approved) / 10 : null, uncategorised_amount: byUse.get('uncategorised').approved_amount + byUse.get('uncategorised').pending_amount },
  };
}

// The counting mode travels with the file, as with the funder report: in the filename, a response header
// and (Excel) the About sheet.
const countsSuffix = (d) => (d.suppression.mode === 'exact' ? 'exact-counts' : d.suppression.purpose === 'publication' ? 'publication-suppressed' : 'internal-suppressed');
const purposeLine = (d) => ({ k: 'Purpose', v: d.suppression.purpose === 'publication' ? 'Publication release (whole programme, one standard period)' : d.suppression.purpose === 'submission' ? 'The programme\'s own submission, not for publication' : 'Internal, not for publication' });
function send(ctx, { body, filename, xlsx, classification, suppression }) {
  ctx.res.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'X-SUDS-Export': classification,
    'X-SUDS-Report-Counts': suppression.mode === 'exact' ? 'exact' : `suppressed (threshold ${suppression.threshold})`, 'X-SUDS-Report-Purpose': suppression.purpose });
  ctx.res.end(body);
}
const aboutSheet = (ctx, rows) => ({ name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: [...rows, { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username }] });

function routes(r, range) {
  const S = require('./spreadsheet');
  const NDP_COLUMNS = [['date', 'Date'], ['entry', 'Entry'], ['site_type', 'Site type'], ['recipient_type', 'Recipient type'], ['kits', 'Kits distributed'], ['doses', 'Naloxone doses distributed'], ['reversals', 'Reversals reported'], ['reversal_doses', 'Doses used in reversals'], ['administered_by', 'Naloxone given by']].map(([key, label]) => ({ key, label }));
  const ndpRows = (d) => d.rows.map(x => ({ ...x, entry: x.entry === 'distribution' ? 'Distribution' : 'Reversal reported', site_type: x.site_type === 'unknown' ? 'Unknown' : x.site_type === 'all' ? 'All sites' : O.labelOf('LOCATIONS', x.site_type),
    administered_by: x.administered_by ? O.labelOf('ADMINISTERED_BY', x.administered_by) : null }));

  r.get('/api/reports/naloxone-ndp', auth.requireAuth, auth.requirePerm('reports:read'), (ctx) => {
    const d = ndp(ctx, range(ctx));
    audit.log({ user: ctx.user, action: 'report.naloxone_ndp', ip: ctx.ip, details: { from: d.from, to: d.to, rows: d.rows.length, counts: d.suppression.mode, purpose: d.suppression.purpose } });
    return d;
  });
  r.get('/api/reports/naloxone-ndp/export', auth.requireAuth, auth.requirePerm('reports:read'), auth.requirePerm('export:read'), (ctx) => {
    const d = ndp(ctx, range(ctx)); const xlsx = ctx.query.get('format') === 'xlsx'; const rows = ndpRows(d);
    audit.log({ user: ctx.user, action: 'report.naloxone_ndp.export', ip: ctx.ip, details: { from: d.from, to: d.to, rows: rows.length, counts: d.suppression.mode, purpose: d.suppression.purpose, format: xlsx ? 'xlsx' : 'csv' } });
    const body = xlsx ? S.writeWorkbook([{ name: 'NDP log', columns: NDP_COLUMNS, rows }, aboutSheet(ctx, [
      { k: 'Report', v: 'Naloxone distribution and reversal log (NDP-style)' }, { k: 'Template', v: d.template_note }, { k: 'Period', v: `${d.from} to ${d.to}` }, { k: 'County', v: d.county || '' },
      { k: 'Doses per kit', v: `${d.doses_per_kit} (Settings: naloxone doses per kit)` }, { k: 'Totals', v: `${d.totals.kits} kits, ${d.totals.doses} doses distributed (${d.totals.community_kits} kits to anonymous community members); ${d.totals.reversals} reversals reported` },
      purposeLine(d), { k: 'Counts', v: d.counting_statement },
      { k: 'Classification', v: d.by === 'month' ? 'Aggregate counts by month (distribution also by site type and recipient type; reversals for all sites together): no names, client codes or record ids.' : 'Aggregate counts by day, site type and recipient type: no names, client codes or record ids.' }])]) : S.toCsv(rows, NDP_COLUMNS);
    send(ctx, { body, xlsx, suppression: d.suppression, filename: `suds-naloxone-ndp-log-${d.from}_${d.to}-${countsSuffix(d)}.${xlsx ? 'xlsx' : 'csv'}`, classification: 'NDP-style log (not the official NDP template; check it against the current NDP reporting template). Aggregate, no identifiers.' });
  });

  r.get('/api/reports/opioid-settlement', auth.requireAuth, auth.requirePerm('budget:read'), (ctx) => {
    const d = settlement(ctx, range(ctx));
    audit.log({ user: ctx.user, action: 'report.opioid_settlement', ip: ctx.ip, details: { from: d.from, to: d.to, funds: d.funds.length, counts: d.suppression.mode, purpose: d.suppression.purpose } });
    return d;
  });
  r.get('/api/reports/opioid-settlement/export', auth.requireAuth, auth.requirePerm('budget:read'), auth.requirePerm('export:read'), (ctx) => {
    const d = settlement(ctx, range(ctx)); const xlsx = ctx.query.get('format') === 'xlsx';
    audit.log({ user: ctx.user, action: 'report.opioid_settlement.export', ip: ctx.ip, details: { from: d.from, to: d.to, counts: d.suppression.mode, purpose: d.suppression.purpose, format: xlsx ? 'xlsx' : 'csv' } });
    const detailCols = [['schedule', 'Schedule'], ['use_label', 'Category'], ['hiaa_label', 'High Impact Abatement Activity'], ['approved_amount', 'Approved or reimbursed ($)'], ['pending_amount', 'Pending ($)'], ['expenditures', 'Expenditures']].map(([key, label]) => ({ key, label }));
    const body = xlsx ? S.writeWorkbook([
      aboutSheet(ctx, [{ k: 'Report', v: 'Opioid settlement expenditures by allowable use' }, { k: 'Period', v: `${d.from} to ${d.to}` }, { k: 'Funds', v: d.funds.map(f => f.name).join('; ') || 'No settlement funds' },
        { k: 'Approved or reimbursed', v: d.totals.approved_amount }, { k: 'Of which High Impact Abatement Activities', v: `${d.totals.hiaa_amount} (${d.totals.hiaa_share ?? 0}%)` }, { k: 'Sources and verification', v: d.source_note }, purposeLine(d), { k: 'Counts', v: d.counting_statement }]),
      { name: 'By allowable use', columns: [['schedule', 'Schedule'], ['label', 'Category'], ['approved_amount', 'Approved or reimbursed ($)'], ['pending_amount', 'Pending ($)'], ['expenditures', 'Expenditures']].map(([key, label]) => ({ key, label })), rows: d.by_use },
      { name: 'By HIAA', columns: [['label', 'High Impact Abatement Activity'], ['approved_amount', 'Approved or reimbursed ($)'], ['pending_amount', 'Pending ($)'], ['expenditures', 'Expenditures']].map(([key, label]) => ({ key, label })), rows: d.by_hiaa },
      { name: 'Detail', columns: detailCols, rows: d.detail },
      { name: 'Services', columns: [['label', 'Category'], ['services', 'Services'], ['people', 'People served'], ['naloxone_kits', 'Naloxone kits']].map(([key, label]) => ({ key, label })), rows: d.services_by_use },
    ]) : S.toCsv(d.detail, detailCols);
    send(ctx, { body, xlsx, suppression: d.suppression, filename: `suds-opioid-settlement-${d.from}_${d.to}-${countsSuffix(d)}.${xlsx ? 'xlsx' : 'csv'}`, classification: 'Opioid settlement expenditures by category (categories need verification against the governing agreement). No client information.' });
  });
}

module.exports = { ndp, settlement, routes, NDP_TEMPLATE_NOTE, SETTLEMENT_SOURCE_NOTE };
