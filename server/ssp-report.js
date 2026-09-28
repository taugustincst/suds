'use strict';
// The syringe services program (SSP) summary for a period (docs/SUPPLIES.md): participants served, contacts,
// syringes handed out and brought back (counted, or estimated from the container's volume) and the return
// ratio, sharps containers, naloxone by product, test strips, the other supplies, and referrals. The layout
// follows what a CDPH-authorized SSP reports as SUDS understands it; it is not an official template and must
// be checked against the program's current reporting requirements before it is submitted.
//
// A contact is a visit or an anonymous outreach contact at which supplies were handed out or sharps brought
// back. Counts of people (participants served, people referred, referrals) are small-cell suppressed as the
// funder report's are (server/small-cells.js), with the same counting modes (server/funder-report.js); counts
// of supplies and of contacts are not counts of people and are exact. It is never a publication release: it
// is the program's own submission (or internal), so it is run by those who may run such reports
// (auth.reportRunAllowed), counting a caseload-scoped role's own caseload and anonymous contacts.
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const FR = require('./funder-report');
const SC = require('./small-cells');
const N = require('./supply-names');
const { badRequest, forbidden } = require('./http');

const TEMPLATE_NOTE = 'The layout follows what a CDPH-authorized syringe services program reports, as SUDS understands it (contacts, participants, syringes distributed and returned, sharps containers, naloxone and test strips, referrals). It is not an official template: check it against your current reporting requirements before submitting it.';
const RETURNS_NOTE = 'Syringes returned are counted, or estimated from the volume of the sharps container brought back (Supplies settings: syringes per litre). The estimated part is shown separately.';

/**
 * A run by a role that writes the funder report (reports:funder: finance) without client-level access (1.16.0):
 * the programme's own submission, aggregate counts of the whole programme, as its funder report is. Nothing
 * client-level is in the summary, so it follows the funder report's rule (routes/reports.js requireReportRun).
 */
const funderOnly = (user) => !auth.reportRunAllowed(user, { caseloadScoped: true }) && auth.submissionRunAllowed(user);

/** This run's counting mode: never a publication release; the program's submission for a role that may run one. */
function counting(ctx, period) {
  if (ctx.query.get('purpose') === 'publication') throw badRequest('The syringe services summary is the program\'s own submission (or internal), not a publication release. Run it without purpose=publication.');
  if (funderOnly(ctx.user) && ctx.query.get('purpose') && ctx.query.get('purpose') !== 'submission') throw forbidden('Your role runs the syringe services summary as the program\'s own submission to its funder (purpose=submission). Internal runs are for staff who work with clients, supervisors and administrators.');
  const q = new URLSearchParams(ctx.query);
  if (!q.get('purpose')) q.set('purpose', auth.hasPerm(ctx.user, 'reports:internal') || funderOnly(ctx.user) ? 'submission' : 'internal');
  const c = FR.countingMode({ ...ctx, query: q }, period);
  return { counting: c, sc: { threshold: c.threshold, exact: c.mode === 'exact' } };
}

// The calendar month an event belongs to, in the program's time zone (one formatter per run).
function monthReader() {
  const B = require('./routes/budget'); const tz = B.orgTimezone();
  let fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { fmt = null; }
  return (at) => { const s = String(at || ''); if (s.length === 10) return s.slice(0, 7); const d = new Date(s); return !Number.isFinite(d.getTime()) ? s.slice(0, 7) : (fmt ? fmt.format(d) : B.localDate(s)).slice(0, 7); };
}

/** The period's true figures. */
function figures(ctx, { ts, tsP }) {
  // The funder-report role counts the whole programme, as its funder report does; anyone else what they may see.
  const cf = funderOnly(ctx.user) ? { sql: '1=1', params: [] } : auth.caseloadFilter(ctx.user, 'c.id');
  const scope = `(i.client_id IS NULL OR ${cf.sql})`;
  const activity = `(EXISTS (SELECT 1 FROM intervention_supplies l WHERE l.intervention_id=i.id) OR i.syringes_returned > 0 OR i.naloxone_kits > 0 OR i.fentanyl_strips > 0)`;
  const visits = db.all(`SELECT i.id, i.client_id, i.occurred_at, i.supply_site_id, i.naloxone_kits, i.fentanyl_strips, i.syringes_returned, i.returns_estimated, c.deleted_at
    FROM interventions i LEFT JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND ${activity} AND ${scope}`, ...tsP, ...cf.params);
  const lines = db.all(`SELECT l.intervention_id, l.quantity, l.untracked, it.id AS item_id, it.name, it.category, it.product, it.unit FROM intervention_supplies l
    JOIN supply_items it ON it.id=l.item_id JOIN interventions i ON i.id=l.intervention_id LEFT JOIN clients c ON c.id=i.client_id WHERE ${ts('i.occurred_at')} AND ${scope}`, ...tsP, ...cf.params);
  const monthOf = monthReader();
  const byVisit = new Map(); for (const l of lines) { if (!byVisit.has(l.intervention_id)) byVisit.set(l.intervention_id, []); byVisit.get(l.intervention_id).push(l); }
  const sumCat = (ls, cat) => ls.filter(l => l.category === cat).reduce((n, l) => n + l.quantity, 0);
  const participants = new Set(visits.filter(v => v.client_id && !v.deleted_at).map(v => v.client_id));
  const month = new Map(); const site = new Map();
  const bucket = () => ({ contacts: 0, anonymous_contacts: 0, syringes_distributed: 0, syringes_returned: 0, naloxone_kits: 0 });
  const t = { contacts: 0, anonymous_contacts: 0, syringes_distributed: 0, syringes_returned: 0, syringes_returned_estimated: 0, sharps_containers: 0, naloxone_kits: 0, fentanyl_strips: 0, xylazine_strips: 0 };
  for (const v of visits) {
    const ls = byVisit.get(v.id) || [];
    const syr = sumCat(ls, 'syringes');
    const add = (b) => { b.contacts++; if (!v.client_id) b.anonymous_contacts++; b.syringes_distributed += syr; b.syringes_returned += v.syringes_returned || 0; b.naloxone_kits += v.naloxone_kits || 0; };
    const m = monthOf(v.occurred_at); if (!month.has(m)) month.set(m, bucket()); add(month.get(m));
    const s = v.supply_site_id || ''; if (!site.has(s)) site.set(s, bucket()); add(site.get(s));
    add(t);
    if (v.returns_estimated) t.syringes_returned_estimated += v.syringes_returned || 0;
    t.sharps_containers += sumCat(ls, 'sharps_container'); t.fentanyl_strips += v.fentanyl_strips || 0; t.xylazine_strips += sumCat(ls, 'xylazine_test_strips');
  }
  // Naloxone by product: the visits' naloxone items, and the kits recorded without one (before items, or a
  // count with no naloxone item kept) as "not recorded".
  const inScope = new Set(visits.map(v => v.id));
  const products = new Map();
  let recorded = 0;
  for (const l of lines) { const q = l.quantity - (l.untracked || 0); if (l.category !== 'naloxone' || !inScope.has(l.intervention_id) || q <= 0) continue; const k = l.product || 'unspecified'; products.set(k, (products.get(k) || 0) + q); recorded += q; }
  if (t.naloxone_kits > recorded) products.set('not_recorded', (products.get('not_recorded') || 0) + t.naloxone_kits - recorded);
  const items = new Map();
  for (const l of lines) { if (!inScope.has(l.intervention_id)) continue; if (!items.has(l.item_id)) items.set(l.item_id, { item: l.name, category: l.category, unit: l.unit, quantity: 0 }); items.get(l.item_id).quantity += l.quantity; }
  // Referrals made in the period for the participants served (a referral is one person's).
  const ids = JSON.stringify([...participants]);
  const ref = db.one(`SELECT COUNT(*) n, COUNT(DISTINCT r.client_id) people FROM referrals r WHERE ${ts('r.referred_at')} AND r.client_id IN (SELECT value FROM json_each(?))`, ...tsP, ids);
  const sites = new Map(db.all(`SELECT id, name FROM supply_sites`).map(s => [s.id, s.name]));
  const ratio = (r, d) => (d ? Math.round((r / d) * 100) / 100 : null);
  return {
    totals: { ...t, participants: participants.size, referrals: ref.n, people_referred: ref.people, return_ratio: ratio(t.syringes_returned, t.syringes_distributed) },
    by_month: [...month].sort(([a], [b]) => a.localeCompare(b)).map(([m, b]) => ({ month: m, ...b, return_ratio: ratio(b.syringes_returned, b.syringes_distributed) })),
    by_site: [...site].map(([id, b]) => ({ site_id: id || null, site: id ? sites.get(id) || 'Unknown site' : 'No site recorded', ...b, return_ratio: ratio(b.syringes_returned, b.syringes_distributed) })).sort((a, b) => a.site.localeCompare(b.site)),
    by_item: [...items.values()].map(x => ({ ...x, category_label: N.labelOf(N.CATEGORIES, x.category) })).sort((a, b) => a.category_label.localeCompare(b.category_label) || a.item.localeCompare(b.item)),
    naloxone_by_product: [...products].map(([code, kits]) => ({ product: code, label: code === 'not_recorded' ? 'Product not recorded' : code === 'unspecified' ? 'Naloxone (product not set on the item)' : N.labelOf(N.NALOXONE_PRODUCTS, code), kits })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

async function build(ctx, range) {
  const { from, to } = range;
  const { counting: c, sc } = counting(ctx, { from, to });
  const f = figures(ctx, range);
  const t = f.totals;
  // People: participants served, and the people referred among them (a subset, so its complement is protected
  // too); the referrals themselves are one person's each.
  const s = SC.star({ total: t.participants, subsets: [t.people_referred] }, sc);
  const scoped = auth.caseloadRestricted(ctx.user) && !funderOnly(ctx.user);
  return {
    from, to, template_note: TEMPLATE_NOTE, returns_note: RETURNS_NOTE,
    suppression: FR.suppressionOf(c), release: c.release, counting_statement: FR.countingStatement(c),
    caseload_scope_note: scoped ? 'Counts only your caseload and anonymous contacts: participants are clients on your caseload; contacts with no client (anonymous outreach) are the whole program\'s.' : null,
    totals: { ...t, participants: s.total, people_referred: s.subsets[0], referrals: SC.cell(t.referrals, sc) },
    by_month: f.by_month, by_site: f.by_site, by_item: f.by_item, naloxone_by_product: f.naloxone_by_product,
  };
}

function sheets(d, ctx) {
  const t = d.totals;
  const about = [
    { k: 'Report', v: 'Syringe services program (SSP) summary' }, { k: 'Template', v: d.template_note }, { k: 'Period', v: `${d.from} to ${d.to}` },
    { k: 'County', v: db.getSetting('county_name', '') || '' },
    { k: 'Purpose', v: d.suppression.purpose === 'submission' ? 'The program\'s own submission, not for publication' : 'Internal, not for publication' },
    { k: 'Counts', v: d.counting_statement }, { k: 'Returns', v: d.returns_note },
    ...(d.caseload_scope_note ? [{ k: 'Scope', v: d.caseload_scope_note }] : []),
    { k: 'Classification', v: 'Aggregate counts: no names, client codes or dates of service.' },
    { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
  ];
  const summary = [
    ['People', 'Participants served (unduplicated)', t.participants], ['People', 'Participants referred to services', t.people_referred], ['People', 'Referrals made', t.referrals],
    ['Contacts', 'Contacts (visits and outreach at which supplies were given or sharps returned)', t.contacts], ['Contacts', 'Of those, anonymous', t.anonymous_contacts],
    ['Syringe services', 'Syringes distributed', t.syringes_distributed], ['Syringe services', 'Syringes returned', t.syringes_returned],
    ['Syringe services', 'Of those, estimated from container volume', t.syringes_returned_estimated], ['Syringe services', 'Returned per syringe distributed', t.return_ratio ?? ''],
    ['Syringe services', 'Sharps containers given', t.sharps_containers],
    ['Naloxone & testing', 'Naloxone kits', t.naloxone_kits], ['Naloxone & testing', 'Fentanyl test strips', t.fentanyl_strips], ['Naloxone & testing', 'Xylazine test strips', t.xylazine_strips],
  ].map(([section, measure, value]) => ({ section, measure, value }));
  const long = [{ key: 'section', label: 'Section' }, { key: 'measure', label: 'Measure' }, { key: 'value', label: 'Value' }];
  const monthCols = [['month', 'Month'], ['contacts', 'Contacts'], ['anonymous_contacts', 'Anonymous contacts'], ['syringes_distributed', 'Syringes distributed'], ['syringes_returned', 'Syringes returned'], ['return_ratio', 'Returned per syringe distributed'], ['naloxone_kits', 'Naloxone kits']].map(([key, label]) => ({ key, label }));
  const siteCols = [['site', 'Site'], ...monthCols.slice(1).map(c => [c.key, c.label])].map(x => (Array.isArray(x) ? { key: x[0], label: x[1] } : x));
  const itemCols = [['category_label', 'Category'], ['item', 'Item'], ['unit', 'Unit'], ['quantity', 'Quantity given']].map(([key, label]) => ({ key, label }));
  const prodCols = [['label', 'Naloxone product'], ['kits', 'Kits']].map(([key, label]) => ({ key, label }));
  return {
    workbook: [
      { name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: about },
      { name: 'Summary', columns: long, rows: summary },
      { name: 'By month', columns: monthCols, rows: d.by_month.map(r => ({ ...r, return_ratio: r.return_ratio ?? '' })) },
      { name: 'By site', columns: siteCols, rows: d.by_site.map(r => ({ ...r, return_ratio: r.return_ratio ?? '' })) },
      { name: 'Supplies', columns: itemCols, rows: d.by_item },
      { name: 'Naloxone by product', columns: prodCols, rows: d.naloxone_by_product },
    ],
    csv: [...about.map(x => ({ section: 'About', measure: x.k, value: x.v })), ...summary,
      ...d.by_month.flatMap(r => [{ section: `Month ${r.month}`, measure: 'Contacts', value: r.contacts }, { section: `Month ${r.month}`, measure: 'Syringes distributed', value: r.syringes_distributed }, { section: `Month ${r.month}`, measure: 'Syringes returned', value: r.syringes_returned }]),
      ...d.by_item.map(r => ({ section: 'Supplies given', measure: `${r.item} (${r.unit})`, value: r.quantity })),
      ...d.naloxone_by_product.map(r => ({ section: 'Naloxone by product', measure: r.label, value: r.kits }))],
    csvColumns: long,
  };
}

/** Who may run it: a role that may run a report that is not a publication release, counting what it may see. */
function allowed(ctx) {
  if (auth.reportRunAllowed(ctx.user, { caseloadScoped: true }) || auth.submissionRunAllowed(ctx.user)) return;
  audit.log({ user: ctx.user, action: 'authz.denied', ip: ctx.ip, success: false, details: { perms: ['reports:internal|reports:funder'], path: ctx.path } });
  throw forbidden('The syringe services summary counts participants and is the program\'s own submission, so it is run by staff who work with clients, supervisors, administrators and whoever writes the funder report.');
}

function routes(r, range) {
  r.get('/api/reports/ssp', auth.requireAuth, auth.requirePerm('reports:read'), allowed, async (ctx) => {
    const d = await build(ctx, range(ctx));
    audit.log({ user: ctx.user, action: 'report.ssp', ip: ctx.ip, details: { from: d.from, to: d.to, contacts: d.totals.contacts, counts: d.suppression.mode, purpose: d.suppression.purpose } });
    return d;
  });
  r.get('/api/reports/ssp/export', auth.requireAuth, auth.requirePerm('reports:read'), auth.requirePerm('export:read'), allowed, async (ctx) => {
    const d = await build(ctx, range(ctx)); const xlsx = ctx.query.get('format') === 'xlsx';
    const sh = sheets(d, ctx); const S = require('./spreadsheet');
    audit.log({ user: ctx.user, action: 'report.ssp.export', ip: ctx.ip, details: { from: d.from, to: d.to, counts: d.suppression.mode, purpose: d.suppression.purpose, format: xlsx ? 'xlsx' : 'csv' } });
    const mode = d.suppression.mode === 'exact' ? 'exact-counts' : 'internal-suppressed';
    ctx.res.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-ssp-summary-${d.from}_${d.to}-${mode}.${xlsx ? 'xlsx' : 'csv'}"`,
      'X-SUDS-Export': 'Syringe services summary (not an official template; check it against your reporting requirements). Aggregate, no identifiers.',
      'X-SUDS-Report-Counts': d.suppression.mode === 'exact' ? 'exact' : `suppressed (threshold ${d.suppression.threshold})`, 'X-SUDS-Report-Purpose': d.suppression.purpose });
    ctx.res.end(xlsx ? S.writeWorkbook(sh.workbook) : S.toCsv(sh.csv, sh.csvColumns));
  });
}

module.exports = { build, figures, sheets, routes, TEMPLATE_NOTE };
