'use strict';
// Settlement outcomes (1.17.0, docs/compliance/HARM-REDUCTION-REPORTING.md "Settlement outcomes"): for each
// opioid settlement fund, what its money was spent on and what SUDS records of the work charged to it, side by
// side, by category and by month, with the cost per outcome where that means something. The outcomes per
// category are server/settlement-outcome-map.js.
//
// It is the programme's own view of its settlement money, for the people who account for it (finance,
// supervisors, administrators: reports:funder or reports:internal), on screen and as a file they download.
// SUDS sends it nowhere, and it is not a state report: what a state or county asks for is the settlement
// expenditure report and its DHCS and county layouts (server/harm-reduction-reports.js).
//
// Everything is aggregate. Counts of people (people served, linked, trained, referrals, reversals, admissions)
// go through the funder report's small-cell rules (server/small-cells.js) with the funder report's counting
// modes (server/funder-report.js countingMode): small counts are shown as "<11" and whatever would let one be
// worked out is hidden too. The page shows them suppressed unless exact counts are asked for, by a role the
// funder report lets run them. A cost per outcome is never shown beside a hidden count (the money is exact, so
// the division would give the count away). Money, kits, strips, syringes, contacts and hours are exact.
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const C = require('./constants');
const FR = require('./funder-report');
const SC = require('./small-cells');
const MAP = require('./settlement-outcome-map');
const { badRequest, forbidden } = require('./http');

const NOTE = 'What the program recorded in SUDS for the work charged to each opioid settlement fund, beside what the fund spent. SUDS reports what the program records; it is not an official state reporting system, and these figures are not the DHCS settlement expenditure report (Reports › Harm-reduction reporting has that, in the DHCS layout). Outcomes are counted for visits, overdose events, episodes and time charged to the fund, and for referrals of the people it served; spending under the fund\'s own category is what a cost per outcome divides.';
const MOUD = ['mat_otp', 'mat_obot'];
const LINKED = ['admitted', 'completed'];
const money = (n) => Math.round((n || 0) * 100) / 100;
const isFund = `(f.source_type='opioid_settlement' OR f.settlement_use IS NOT NULL OR f.settlement_hiaa IS NOT NULL)`;
const USE = Object.fromEntries(C.SETTLEMENT_USES.map(x => [x.code, x]));
const HIAA = Object.fromEntries([...C.SETTLEMENT_HIAA.map(x => [x.code, x.label]), ['none', 'Not a High Impact Abatement Activity']]);
const KEYS = Object.keys(MAP.INDICATORS);
const PEOPLE = KEYS.filter(k => MAP.INDICATORS[k].kind !== 'count');

/** Who may run it: whoever writes the funder report (reports:funder) or runs internal reports (reports:internal). */
function allowed(ctx) {
  if (auth.hasPerm(ctx.user, 'reports:internal') || auth.submissionRunAllowed(ctx.user)) return;
  audit.log({ user: ctx.user, action: 'authz.denied', ip: ctx.ip, success: false, details: { perms: ['reports:internal|reports:funder'], path: ctx.path } });
  throw forbidden('Settlement outcomes are for the people who account for the program\'s settlement money: finance, supervisors and administrators.');
}

/**
 * This run's counting: the funder report's (FR.countingMode), never a publication release, and with small
 * cells suppressed unless counts=exact is asked for (which the funder report's rules then allow or refuse).
 */
function counting(ctx, period) {
  const asked = ctx.query.get('purpose');
  if (asked === 'publication') throw badRequest('Settlement outcomes are the program\'s own figures, not a publication release. Run them without purpose=publication.');
  if (asked && asked !== 'submission' && !auth.hasPerm(ctx.user, 'reports:internal')) throw forbidden('Your role runs settlement outcomes as the program\'s own figures (purpose=submission).');
  const q = new URLSearchParams(ctx.query);
  if (!asked) q.set('purpose', 'submission');
  if (!q.get('counts')) q.set('counts', 'suppressed');
  const c = FR.countingMode({ ...ctx, query: q }, period);
  return { counting: c, sc: { threshold: c.threshold, exact: c.mode === 'exact' } };
}

// The calendar month something happened in, in the programme's time zone (one formatter per run).
function monthReader() {
  const B = require('./routes/budget'); const tz = B.orgTimezone();
  let fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { fmt = null; }
  return (at) => { const s = String(at || ''); if (s.length === 10) return s.slice(0, 7); const d = new Date(s); return !Number.isFinite(d.getTime()) ? s.slice(0, 7) : (fmt ? fmt.format(d) : B.localDate(s)).slice(0, 7); };
}
/** Every month from `from` to `to`, so a month with nothing in it is listed as 0 rather than left out. */
function monthsOf(from, to) {
  const out = []; let y = Number(from.slice(0, 4)); let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let guard = 0; guard < 600; guard++) { const k = `${y}-${String(m).padStart(2, '0')}`; if (k > end) break; out.push(k); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

const bucket = () => ({ contacts: 0, naloxone_kits: 0, fentanyl_strips: 0, syringes: 0, reversals: 0, treatment_admissions: 0, education_contacts: 0, staff_minutes: 0,
  refs: new Set(), served: new Set(), linked: new Set(), moud: new Set(), trained: new Set(), spend: 0 });
/** A bucket's figures, as numbers. */
const values = (b) => ({ contacts: b.contacts, naloxone_kits: b.naloxone_kits, fentanyl_strips: b.fentanyl_strips, syringes: b.syringes, reversals: b.reversals,
  treatment_admissions: b.treatment_admissions, education_contacts: b.education_contacts, staff_training_hours: Math.round(b.staff_minutes / 6) / 10,
  referrals_made: b.refs.size, people_served: b.served.size, people_linked: b.linked.size, moud_linked: b.moud.size, people_trained: b.trained.size });

/**
 * The period's true figures: every settlement fund (active, or with anything in the period), each with its
 * spending and its figures for the period and by month; the same by category (the fund's own Exhibit E
 * allowable use) and for all settlement funds together. Pure data, no protection (protect() below). With
 * fundIds, only those funds (a county submission, server/county.js).
 */
function figures({ from, to, ts, tsP }, { fundIds = null } = {}) {
  const monthOf = monthReader(); const months = monthsOf(from, to);
  // fundIds (a county submission, server/county.js): only these funds, and every total over them alone. Every
  // count below goes through F, so a fund left out adds to nothing: not its own row, its category or the total.
  const funds = db.all(`SELECT f.id, f.name, f.grant_number, f.source_type, f.settlement_use, f.settlement_hiaa, f.is_active, f.total_amount, f.fiscal_year_start, f.fiscal_year_end FROM funding_sources f WHERE ${isFund}${fundIds ? ' AND f.id IN (SELECT value FROM json_each(?))' : ''} ORDER BY f.name, f.id`, ...(fundIds ? [JSON.stringify(fundIds)] : []));
  const F = new Map(funds.map(f => [f.id, { f, period: bucket(), months: new Map(months.map(m => [m, bucket()])), own: 0, other: 0, pending: 0, active: false }]));
  const catKey = (f) => (f.settlement_use && USE[f.settlement_use] ? f.settlement_use : 'uncategorised');
  const cats = new Map(); const total = bucket(); const totalMonths = new Map(months.map(m => [m, bucket()]));
  for (const x of F.values()) if (!cats.has(catKey(x.f))) cats.set(catKey(x.f), bucket());
  // Apply fn to every bucket this fund's item of `month` counts in: the fund's period and month, its
  // category, and all settlement funds together (period and month).
  const add = (fid, month, fn) => {
    const x = F.get(fid); if (!x) return; x.active = true;
    fn(x.period); fn(cats.get(catKey(x.f))); fn(total);
    if (x.months.has(month)) { fn(x.months.get(month)); fn(totalMonths.get(month)); }
  };
  // Spending: approved or reimbursed counts as spent; pending is shown apart. What is spent under the fund's
  // own category is what the outcomes of the work charged to the fund are divided by.
  for (const e of db.all(`SELECT e.funding_source_id fid, e.spent_at, e.amount, e.status, COALESCE(e.settlement_use, f.settlement_use) use_code FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id
      WHERE ${isFund} AND e.spent_at BETWEEN ? AND ? AND e.status IN ('pending','approved','reimbursed')`, from, to)) {
    const x = F.get(e.fid); if (!x) continue; x.active = true;
    if (e.status === 'pending') { x.pending += e.amount; continue; }
    const own = (e.use_code || null) === (x.f.settlement_use || null);
    if (own) x.own += e.amount; else x.other += e.amount;
    const m = String(e.spent_at).slice(0, 7);
    x.period.spend += e.amount; total.spend += e.amount;
    if (own) cats.get(catKey(x.f)).spend += e.amount;
    if (x.months.has(m)) { x.months.get(m).spend += e.amount; totalMonths.get(m).spend += e.amount; }
  }
  // Visits charged to a settlement fund: contacts, kits, strips, education sessions, and the people served and
  // trained (a deleted client's visit is a service, not a person served, as in the funder report).
  const syringes = new Map(db.all(`SELECT l.intervention_id id, SUM(l.quantity) q FROM intervention_supplies l JOIN supply_items it ON it.id=l.item_id JOIN interventions i ON i.id=l.intervention_id
      JOIN funding_sources f ON f.id=i.funding_source_id WHERE ${isFund} AND ${ts('i.occurred_at')} AND it.category='syringes' GROUP BY l.intervention_id`, ...tsP).map(x => [x.id, x.q]));
  const servedBy = new Map();
  for (const v of db.all(`SELECT i.id, i.funding_source_id fid, i.occurred_at, i.type, i.client_id, c.deleted_at, i.naloxone_kits, i.fentanyl_strips FROM interventions i JOIN funding_sources f ON f.id=i.funding_source_id
      LEFT JOIN clients c ON c.id=i.client_id WHERE ${isFund} AND ${ts('i.occurred_at')}`, ...tsP)) {
    const person = v.client_id && !v.deleted_at ? v.client_id : null;
    add(v.fid, monthOf(v.occurred_at), (b) => {
      b.contacts++; b.naloxone_kits += v.naloxone_kits || 0; b.fentanyl_strips += v.fentanyl_strips || 0; b.syringes += syringes.get(v.id) || 0;
      if (v.type === 'education') { b.education_contacts++; if (person) b.trained.add(person); }
      if (person) b.served.add(person);
    });
    if (person) { if (!servedBy.has(person)) servedBy.set(person, new Set()); servedBy.get(person).add(v.fid); }
  }
  // Reversals reported and charged to the fund (naloxone used and the person survived, as the NDP log counts them).
  for (const o of db.all(`SELECT o.funding_source_id fid, o.occurred_at FROM overdose_events o JOIN funding_sources f ON f.id=o.funding_source_id LEFT JOIN clients c ON c.id=o.client_id
      WHERE ${isFund} AND ${ts('o.occurred_at')} AND (o.naloxone_used=1 OR o.kind='reversal') AND o.survived=1 AND (o.client_id IS NULL OR c.deleted_at IS NULL)`, ...tsP)) {
    add(o.fid, monthOf(o.occurred_at), (b) => { b.reversals++; });
  }
  // Treatment admissions: episodes of care opened in the period and charged to the fund.
  for (const e of db.all(`SELECT e.funding_source_id fid, e.opened_at FROM episodes e JOIN funding_sources f ON f.id=e.funding_source_id JOIN clients c ON c.id=e.client_id
      WHERE ${isFund} AND c.deleted_at IS NULL AND ${ts('e.opened_at')}`, ...tsP)) {
    add(e.fid, monthOf(e.opened_at), (b) => { b.treatment_admissions++; });
  }
  // Referrals made in the period for the people each fund served in it; linked when admitted or completed.
  if (servedBy.size) {
    for (const r of db.all(`SELECT r.id, r.client_id, r.referred_at, r.status, res.category FROM referrals r JOIN resources res ON res.id=r.resource_id
        WHERE ${ts('r.referred_at')} AND r.client_id IN (SELECT value FROM json_each(?))`, ...tsP, JSON.stringify([...servedBy.keys()]))) {
      const linked = LINKED.includes(r.status); const moud = linked && MOUD.includes(r.category);
      for (const fid of servedBy.get(r.client_id) || []) add(fid, monthOf(r.referred_at), (b) => { b.refs.add(r.id); if (linked) b.linked.add(r.client_id); if (moud) b.moud.add(r.client_id); });
    }
  }
  // Staff training: approved time recorded as Training and charged to the fund.
  for (const t of db.all(`SELECT t.funding_source_id fid, t.work_date, t.minutes FROM time_entries t JOIN funding_sources f ON f.id=t.funding_source_id
      WHERE ${isFund} AND t.category='training' AND t.status='approved' AND t.work_date BETWEEN ? AND ?`, from, to)) {
    add(t.fid, String(t.work_date).slice(0, 7), (b) => { b.staff_minutes += t.minutes || 0; });
  }
  // A fund chosen for a county file is in it even with nothing in the period (the county sees it reported, at 0).
  const shownFunds = [...F.values()].filter(x => x.f.is_active || x.active || fundIds);
  const fundRows = shownFunds.map(x => {
    const profile = MAP.profileFor(x.f.settlement_use, x.f.settlement_hiaa);
    return { id: x.f.id, name: x.f.name, grant_number: x.f.grant_number || null, is_active: !!x.f.is_active, category: catKey(x.f), hiaa: x.f.settlement_hiaa || null,
      category_label: USE[x.f.settlement_use]?.label || 'No settlement category recorded', schedule: USE[x.f.settlement_use]?.schedule || 'Uncategorized',
      hiaa_label: x.f.settlement_hiaa ? HIAA[x.f.settlement_hiaa] || null : null, profile, profile_label: MAP.PROFILES[profile].label, indicators: MAP.PROFILES[profile].indicators,
      spend: { own_category: money(x.own), other_categories: money(x.other), approved: money(x.own + x.other), pending: money(x.pending) },
      // The fund's award as its record gives it (the amount and the award period): a county file of schema version 2
      // carries it (county.js awardFrom decides whether it is one).
      award: { amount: x.f.total_amount, from: String(x.f.fiscal_year_start || '').slice(0, 10), to: String(x.f.fiscal_year_end || '').slice(0, 10) },
      values: values(x.period), months: months.map(m => ({ month: m, spend: money(x.months.get(m).spend), values: values(x.months.get(m)) })) };
  });
  const catRows = [...cats].filter(([k]) => shownFunds.some(x => catKey(x.f) === k)).map(([k, b]) => {
    const profile = k === 'uncategorised' ? 'none' : MAP.profileFor(k, null);
    return { key: k, label: USE[k]?.label || 'No settlement category recorded', schedule: USE[k]?.schedule || 'Uncategorized', profile, profile_label: MAP.PROFILES[profile].label,
      indicators: MAP.PROFILES[profile].indicators, funds: shownFunds.filter(x => catKey(x.f) === k).map(x => x.f.name), spend_own_category: money(b.spend), values: values(b) };
  }).sort((a, b) => (a.key === 'uncategorised') - (b.key === 'uncategorised') || a.schedule.localeCompare(b.schedule) || a.key.localeCompare(b.key));
  return {
    from, to, months,
    funds: fundRows, categories: catRows,
    total: { spend: { approved: money(shownFunds.reduce((n, x) => n + x.own + x.other, 0)), pending: money(shownFunds.reduce((n, x) => n + x.pending, 0)) },
      values: values(total), months: months.map(m => ({ month: m, spend: money(totalMonths.get(m).spend), values: values(totalMonths.get(m)) })) },
  };
}

/**
 * Small cells (server/small-cells.js), a pure function of the true figures: each count of people is protected
 * across every place it is shown - all settlement funds, each category and each fund - and each fund's months
 * against the fund's period. served: the programme's people served in the period (the total the funder report
 * prints), which people served under settlement funds are some of. Then the cost per outcome, only beside a
 * figure that is shown.
 */
function protect(raw, sc, served) {
  const out = { ...raw, total: { ...raw.total, values: { ...raw.total.values }, months: raw.total.months.map(m => ({ ...m, values: { ...m.values } })) }, categories: raw.categories.map(c => ({ ...c, values: { ...c.values } })),
    funds: raw.funds.map(f => ({ ...f, values: { ...f.values }, months: f.months.map(m => ({ ...m, values: { ...m.values } })) })) };
  if (!sc.exact) {
    for (const k of PEOPLE) {
      const cats = raw.categories.map(c => c.values[k]); const funds = raw.funds.map(f => f.values[k]); const tot = raw.total.values[k];
      let shownTot; let shownCats; let shownFunds;
      if (MAP.INDICATORS[k].kind === 'event') {
        // Each event is one fund's, and each fund in one category: both lists add up to the total.
        const s = SC.star({ total: tot, partitions: [cats, funds] }, sc);
        shownTot = s.total; shownCats = s.partitions[0] || cats.map(() => SC.WITHHELD); shownFunds = s.partitions[1] || funds.map(() => SC.WITHHELD);
      } else if (k === 'people_served') {
        // Some of the people the programme served, whose number the funder report prints.
        const N = Math.max(served, tot);
        const s = SC.star({ total: N, subsets: [tot, ...cats, ...funds].map(n => Math.min(n, N)) }, { ...sc, fixedTotal: true });
        shownTot = s.subsets[0]; shownCats = s.subsets.slice(1, 1 + cats.length); shownFunds = s.subsets.slice(1 + cats.length);
      } else {
        // People (or their referrals) who may count under more than one fund: each list is some of the total.
        const s = SC.star({ total: tot, subsets: [...cats, ...funds].map(n => Math.min(n, tot)) }, sc);
        shownTot = s.total; shownCats = s.subsets.slice(0, cats.length); shownFunds = s.subsets.slice(cats.length);
      }
      shownCats = SC.noLonely(shownCats); shownFunds = SC.noLonely(shownFunds);
      out.total.values[k] = shownTot;
      out.categories.forEach((c, i) => { c.values[k] = shownCats[i]; });
      out.funds.forEach((f, i) => { f.values[k] = shownFunds[i]; });
      // A unit's months against its period: known where it is shown (fixed), kept hidden where it is not.
      const byMonth = (list, periodTrue, periodShown) => {
        const vals = list.map(m => m.values[k]);
        const fixed = typeof periodShown === 'number';
        const opts = { ...sc, ...(fixed ? { fixedTotal: true } : { hidden: { total: true } }) };
        const s = MAP.INDICATORS[k].kind === 'event' ? SC.star({ total: periodTrue, partitions: [vals] }, opts) : SC.star({ total: periodTrue, subsets: vals.map(n => Math.min(n, periodTrue)) }, opts);
        const shown = SC.noLonely(MAP.INDICATORS[k].kind === 'event' ? (s.partitions[0] || vals.map(() => SC.WITHHELD)) : s.subsets);
        list.forEach((m, i) => { m.values[k] = shown[i]; });
      };
      out.funds.forEach((f, i) => byMonth(f.months, raw.funds[i].values[k], f.values[k]));
      byMonth(out.total.months, tot, shownTot);
    }
  }
  const cost = (spend, v, keys) => Object.fromEntries(keys.filter(k => MAP.INDICATORS[k].cost).map(k => [k, MAP.costPer(spend, v[k])]));
  for (const f of out.funds) f.cost_per = cost(f.spend.own_category, f.values, f.indicators);
  for (const c of out.categories) c.cost_per = cost(c.spend_own_category, c.values, c.indicators);
  return out;
}

async function build(ctx, range) {
  const { from, to, ts, tsP } = range;
  const { counting: c, sc } = counting(ctx, { from, to });
  const raw = await db.readSnapshot(async () => figures(range));
  const d = protect(raw, sc, sc.exact ? 0 : FR.servedCount(ts, tsP));
  return {
    ...d, note: NOTE, indicators: MAP.INDICATORS, profiles: MAP.PROFILES, no_outcome_note: MAP.NO_OUTCOME_NOTE, uncategorised_note: MAP.UNCATEGORISED_NOTE,
    empty_note: d.funds.length ? null : 'No funding source is marked as opioid settlement money. Under Funding & spending, set the fund\'s source type to Opioid settlement and choose the allowable use it pays for.',
    suppression: FR.suppressionOf(c), counting_statement: FR.countingStatement(c),
  };
}

// ---- the file: an Excel workbook or a CSV, made when the signed-in user asks for it ----
const shown = (v) => (v === null || v === undefined ? '' : v);
function sheets(d, ctx) {
  const L = (k) => MAP.INDICATORS[k].label;
  const about = [
    { k: 'Report', v: 'Opioid settlement outcomes: spending and what the program recorded, by fund and category' }, { k: 'Period', v: `${d.from} to ${d.to}` },
    { k: 'Organization', v: db.getSetting('org_name', '') || '' }, { k: 'What this is', v: d.note },
    { k: 'Funds', v: d.funds.map(f => f.name).join('; ') || 'No settlement funds' },
    { k: 'Purpose', v: 'The program\'s own figures, not for publication' }, { k: 'Counts', v: d.counting_statement },
    { k: 'Cost per outcome', v: 'Spending under the fund\'s own settlement category (approved or reimbursed) divided by the figure; not shown where the figure is 0 or hidden.' },
    { k: 'Classification', v: 'Aggregate figures only: no names, client codes, record ids or dates of service.' },
    { k: 'Generated', v: db.now() }, { k: 'Generated by', v: ctx.user.display_name || ctx.user.username },
  ];
  const long = [];
  const unit = (section, fund, category, spend, v, cost, keys) => {
    long.push({ section, fund, category, measure: 'Spent under this category ($, approved or reimbursed)', value: spend, cost_per: '' });
    for (const k of keys) long.push({ section, fund, category, measure: L(k), value: shown(v[k]), cost_per: cost && cost[k] !== undefined ? shown(cost[k]) : '' });
  };
  long.push({ section: 'All settlement funds', fund: 'All', category: 'All', measure: 'Spent ($, approved or reimbursed)', value: d.total.spend.approved, cost_per: '' });
  long.push({ section: 'All settlement funds', fund: 'All', category: 'All', measure: 'Pending approval ($)', value: d.total.spend.pending, cost_per: '' });
  for (const k of KEYS) long.push({ section: 'All settlement funds', fund: 'All', category: 'All', measure: L(k), value: shown(d.total.values[k]), cost_per: '' });
  for (const c of d.categories) unit('By category', c.funds.join('; '), c.label, c.spend_own_category, c.values, c.cost_per, c.indicators);
  for (const f of d.funds) {
    unit('By fund', f.name, f.category_label, f.spend.own_category, f.values, f.cost_per, f.indicators);
    long.push({ section: 'By fund', fund: f.name, category: f.category_label, measure: 'Spent under other categories ($)', value: f.spend.other_categories, cost_per: '' });
    long.push({ section: 'By fund', fund: f.name, category: f.category_label, measure: 'Pending approval ($)', value: f.spend.pending, cost_per: '' });
  }
  const trend = [];
  for (const f of d.funds) for (const m of f.months) {
    trend.push({ fund: f.name, month: m.month, measure: 'Spent ($, approved or reimbursed)', value: m.spend });
    for (const k of f.indicators) trend.push({ fund: f.name, month: m.month, measure: L(k), value: shown(m.values[k]) });
  }
  const longCols = [['section', 'Section'], ['fund', 'Fund'], ['category', 'Category (Exhibit E)'], ['measure', 'Measure'], ['value', 'Value'], ['cost_per', 'Cost per ($)']].map(([key, label]) => ({ key, label }));
  const trendCols = [['fund', 'Fund'], ['month', 'Month'], ['measure', 'Measure'], ['value', 'Value']].map(([key, label]) => ({ key, label }));
  const fundCols = [['name', 'Fund'], ['grant_number', 'Grant or agreement number'], ['schedule', 'Exhibit E schedule'], ['category_label', 'Exhibit E category'], ['hiaa_label', 'High Impact Abatement Activity'],
    ['own', 'Spent under its category ($)'], ['other', 'Spent under other categories ($)'], ['pending', 'Pending ($)']].map(([key, label]) => ({ key, label }));
  return {
    workbook: [
      { name: 'About', columns: [{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }], rows: about },
      { name: 'Outcomes', columns: longCols, rows: long },
      { name: 'Funds', columns: fundCols, rows: d.funds.map(f => ({ ...f, grant_number: f.grant_number || '', hiaa_label: f.hiaa_label || '', own: f.spend.own_category, other: f.spend.other_categories, pending: f.spend.pending })) },
      { name: 'By month', columns: trendCols, rows: trend },
    ],
    csv: [...about.map(x => ({ section: 'About', fund: '', category: '', measure: x.k, value: x.v, cost_per: '' })), ...long, ...trend.map(t => ({ section: `Month ${t.month}`, fund: t.fund, category: '', measure: t.measure, value: t.value, cost_per: '' }))],
    csvColumns: longCols,
  };
}

function routes(r, range) {
  // A period that ends before it starts is a mistake to say, not an empty report to show (1.17.1).
  const period = (ctx) => {
    const p = range(ctx);
    if (p.from > p.to) throw badRequest(`The start date (${p.from}) is after the end date (${p.to}). Choose a start date on or before the end date.`);
    return p;
  };
  r.get('/api/reports/settlement-outcomes', auth.requireAuth, auth.requirePerm('reports:read'), auth.requirePerm('budget:read'), allowed, async (ctx) => {
    const d = await build(ctx, period(ctx));
    audit.log({ user: ctx.user, action: 'report.settlement_outcomes', ip: ctx.ip, details: { from: d.from, to: d.to, funds: d.funds.length, counts: d.suppression.mode, purpose: d.suppression.purpose } });
    return d;
  });
  // The same figures as a file, made on request for the signed-in user (nothing is sent anywhere).
  r.get('/api/reports/settlement-outcomes/export', auth.requireAuth, auth.requirePerm('reports:read'), auth.requirePerm('budget:read'), auth.requirePerm('export:read'), allowed, async (ctx) => {
    const d = await build(ctx, period(ctx)); const xlsx = ctx.query.get('format') === 'xlsx';
    const sh = sheets(d, ctx); const S = require('./spreadsheet');
    audit.log({ user: ctx.user, action: 'report.settlement_outcomes.export', ip: ctx.ip, details: { from: d.from, to: d.to, funds: d.funds.length, counts: d.suppression.mode, purpose: d.suppression.purpose, format: xlsx ? 'xlsx' : 'csv' } });
    const mode = d.suppression.mode === 'exact' ? 'exact-counts' : 'internal-suppressed';
    ctx.res.writeHead(200, { 'Content-Type': xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="suds-settlement-outcomes-${d.from}_${d.to}-${mode}.${xlsx ? 'xlsx' : 'csv'}"`,
      'X-SUDS-Export': 'Opioid settlement outcomes (the program\'s own figures; not an official state report). Aggregate, no identifiers.',
      'X-SUDS-Report-Counts': d.suppression.mode === 'exact' ? 'exact' : `suppressed (threshold ${d.suppression.threshold})`, 'X-SUDS-Report-Purpose': d.suppression.purpose });
    ctx.res.end(xlsx ? S.writeWorkbook(sh.workbook) : S.toCsv(sh.csv, sh.csvColumns));
  });
}

module.exports = { figures, protect, build, sheets, routes, monthsOf, NOTE };
