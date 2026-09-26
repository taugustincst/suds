// The report a funder actually asks for. Every count here is unduplicated — people, not services — which
// the platform previously could not produce: it could say "1,400 services" but not "310 people".
import { h, route, get, state, fmt, can, pageHead, bars, stat, table, downloadCsv, nav, emptyState } from '../app.js';

// A suppressed small cell arrives as a string ("<11", or "suppressed" when it is hidden only so that another
// cannot be worked out from a total) and is shown as sent.
const num = (n) => (typeof n === 'string' ? n : Number(n || 0).toLocaleString());
const isNum = (n) => typeof n === 'number';

// Periods a publication release can cover (server/funder-report.js standardPeriod): a calendar month, a
// quarter, or a year starting on a quarter, once it has ended. Anything else, a fund filter or a caseload
// makes the run internal, not for publication.
const pad = (m) => String(m).padStart(2, '0');
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const span = (y, m, months) => { const last = m - 1 + months - 1; return [`${y}-${pad(m)}-01`, monthEnd(y + Math.floor(last / 12), (last % 12) + 1)]; };
function publishablePeriods() {
  const today = fmt.today(); const ty = Number(today.slice(0, 4)); const tm = Number(today.slice(5, 7));
  const lastMonth = () => (tm === 1 ? span(ty - 1, 12, 1) : span(ty, tm - 1, 1));
  const lastQuarter = () => { const q = Math.floor((tm - 1) / 3) * 3 + 1; return q === 1 ? span(ty - 1, 10, 3) : span(ty, q - 3, 3); };
  const lastYear = (startMonth) => span((tm >= startMonth ? ty : ty - 1) - 1, startMonth, 12);
  return { lastMonth, lastQuarter, lastYear };
}
/** Whether from–to is a standard period that has ended (a publication release, if run for the whole programme). */
export function isPublishablePeriod(from, to) {
  const m = /^(\d{4})-(\d{2})-01$/.exec(from || ''); if (!m || !to || to >= fmt.today()) return false;
  const y = Number(m[1]); const mo = Number(m[2]);
  return to === span(y, mo, 1)[1] || ([1, 4, 7, 10].includes(mo) && (to === span(y, mo, 3)[1] || to === span(y, mo, 12)[1]));
}
/**
 * Whether this role may run a report that is not a publication release (server/auth.js reportRunAllowed):
 * reports:internal (supervisor, administrator), or a role that opens client records itself, for a report
 * that counts only its own caseload (`caseloadScoped`). A caseload-scoped role's run of a whole-programme
 * report (the settlement report) is refused while caseloads are restricted. Finance and read-only accounts
 * run publication releases only.
 */
export function mayRunInternalReports({ caseloadScoped = true } = {}) {
  return can('reports:internal') || (can('clients:read') && (caseloadScoped || can('clients:all')));
}

route('funder', async (r) => {
  const internalOk = mayRunInternalReports();
  const { lastMonth, lastQuarter, lastYear } = publishablePeriods();
  // A role that runs publication releases only opens on the last quarter that has ended, not a year to date.
  const [dFrom, dTo] = internalOk ? [null, null] : lastQuarter();
  const to = r.query.get('to') || dTo || fmt.today();
  const from = r.query.get('from') || dFrom || `${to.slice(0, 4)}-01-01`;
  const fund = internalOk ? r.query.get('funding_source_id') || '' : '';
  // Small-cell suppression is on unless this is the programme's own submission to its funder and someone
  // allowed to (supervisor, administrator: reports:exact) asks for exact counts.
  const exact = r.query.get('counts') === 'exact' && can('reports:exact');
  const countQs = exact ? '&purpose=submission&counts=exact' : '';
  const qs = `from=${from}&to=${to}${fund ? `&funding_source_id=${fund}` : ''}${countQs}`;
  const periodButtons = (onPick) => h('div', { class: 'filters', role: 'group', 'aria-label': 'Periods you can publish', 'data-publishable-periods': '1' },
    h('span', { class: 'small muted' }, 'Periods you can publish (whole programme, ended):'),
    h('button', { class: 'btn ghost sm', 'data-period': 'month', onClick: () => onPick(lastMonth()) }, 'Last month'),
    h('button', { class: 'btn ghost sm', 'data-period': 'quarter', onClick: () => onPick(lastQuarter()) }, 'Last quarter'),
    h('button', { class: 'btn ghost sm', 'data-period': 'year-jul', onClick: () => onPick(lastYear(7)) }, 'Last fiscal year (Jul–Jun)'),
    h('button', { class: 'btn ghost sm', 'data-period': 'year-oct', onClick: () => onPick(lastYear(10)) }, 'Last fiscal year (Oct–Sep)'));
  let d;
  try { d = await get(`/api/reports/funder?${qs}`); } catch (err) {
    if (err.status !== 403) throw err;
    // A role that runs publication releases only, given a link to any other run: say why, and offer the
    // periods it can run instead of an error page.
    return h('div', {}, pageHead('Funder report'),
      h('div', { class: 'banner warn', role: 'alert', 'data-funder-refused': '1' }, err.message),
      periodButtons(([s, e]) => nav(`funder?from=${s}&to=${e}`)));
  }

  const fromI = h('input', { type: 'date', value: from, 'aria-label': 'From' });
  const toI = h('input', { type: 'date', value: to, 'aria-label': 'To' });
  const countsI = can('reports:exact') ? h('select', { 'aria-label': 'Counts', 'data-counts': '1' },
    h('option', { value: '', selected: !exact }, 'Small cells suppressed'),
    h('option', { value: 'exact', selected: exact }, 'Exact counts (our own submission to the funder)')) : null;
  const go = (f, t) => nav(`funder?from=${f}&to=${t}${fundI.value ? `&funding_source_id=${fundI.value}` : ''}${countsI && countsI.value === 'exact' ? '&counts=exact' : ''}`);
  const fundI = h('select', { 'aria-label': 'Funding source' },
    h('option', { value: '' }, 'All funding sources'),
    state.funds.map(f => h('option', { value: f.id, selected: f.id === fund }, f.name)));

  const publishable = d.suppression.purpose === 'publication';

  // Fiscal-year shortcuts, because that is the period a grant report covers.
  const fy = (startMonth) => {
    const now = new Date();
    const y = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
    const s = `${y}-${String(startMonth).padStart(2, '0')}-01`;
    const e = new Date(Date.UTC(y + 1, startMonth - 1, 0)).toISOString().slice(0, 10);
    return [s, e];
  };

  const u = d.unduplicated;
  const admitRate = isNum(u.with_a_referral) && isNum(u.admitted_after_referral) && u.with_a_referral ? Math.round((u.admitted_after_referral / u.with_a_referral) * 100) : null;

  return h('div', {},
    pageHead('Funder report',
      can('export:read') ? h('button', { class: 'btn', 'data-funder-export': 'xlsx', onClick: () => downloadCsv(`/api/reports/funder/export?${qs}&format=xlsx`) }, 'This report (Excel)') : null,
      can('export:read') ? h('button', { class: 'btn ghost', 'data-funder-export': 'csv', onClick: () => downloadCsv(`/api/reports/funder/export?${qs}`) }, 'CSV') : null,
      can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/workbook?from=${from}&to=${to}`) }, 'Export everything to Excel') : null),
    h('p', { class: 'muted' }, 'Counts of people, each counted once however many times they were served. This is the shape most grant reporting asks for. It is not a CalOMS Tx submission: CalOMS records are collected, checked and extracted under Reports → State reporting.'),
    // Which counting this run used; the exported file says the same on its About sheet.
    // Whether this run is a publication release, and if not, why not.
    h('div', { class: `banner small ${publishable ? 'info' : 'warn'}`, 'data-counting-mode': d.suppression.mode, 'data-purpose': d.suppression.purpose },
      h('strong', {}, publishable ? 'Publication release. ' : 'Internal, not for publication. '), d.counting_statement,
      publishable ? null : h('span', {}, ' To publish or share figures, run the report for all funding sources and one of the periods under "Periods you can publish".')),

    // Custom ranges, one fund and year-to-date runs are internal: offered only to a role that may run them.
    internalOk ? h('div', { class: 'filters', 'data-custom-range': '1' },
      h('div', { class: 'field' }, h('label', {}, 'From'), fromI),
      h('div', { class: 'field' }, h('label', {}, 'To'), toI),
      h('div', { class: 'field' }, h('label', {}, 'Funding source'), fundI),
      countsI ? h('div', { class: 'field' }, h('label', {}, 'Counts'), countsI) : null,
      h('button', { class: 'btn primary', onClick: () => go(fromI.value, toI.value) }, 'Apply'),
      h('button', { class: 'btn ghost sm', onClick: () => { const [s, e] = fy(7); go(s, e); } }, 'Fiscal year (Jul–Jun)'),
      h('button', { class: 'btn ghost sm', onClick: () => { const [s, e] = fy(10); go(s, e); } }, 'Fiscal year (Oct–Sep)'),
      h('button', { class: 'btn ghost sm', onClick: () => go(`${to.slice(0, 4)}-01-01`, to) }, 'Calendar year'))
      : h('p', { class: 'small muted', 'data-publication-only': '1' }, 'Your role runs publication releases: the whole programme for one month, quarter or fiscal year that has ended. Custom ranges and single funds are internal reports, run by a supervisor or administrator.',
        can('budget:read') ? ' Money and staff hours for any period or fund are on Funding & spending.' : ''),
    periodButtons(([s, e]) => { fundI.value = ''; go(s, e); }),
    d.caseload_scope_note ? h('p', { class: 'small muted', 'data-caseload-scope': '1' }, d.caseload_scope_note) : null,

    // What would otherwise be missing without a word: services charged to no fund, and staff time nobody
    // has approved yet (approved hours are what a county would invoice, so unapproved time counts as none).
    d.attribution.unattributed_services ? h('div', { class: 'banner warn small', 'data-unattributed': String(d.attribution.unattributed_services) },
      `${num(d.attribution.unattributed_services)} service${d.attribution.unattributed_services === 1 ? '' : 's'} in this period ${d.attribution.unattributed_services === 1 ? 'has' : 'have'} no funding source, so no fund reports ${d.attribution.unattributed_services === 1 ? 'it' : 'them'} (the "No funding source" row below). `,
      h('a', { href: d.attribution.fix_link }, 'Review those visits'),
      // Why it keeps happening on a new install: no programme default fund, so a visit nobody charges goes to
      // none. Settings → Programme → Reporting is where one is set.
      d.attribution.default_fund_set ? null : [' No default funding source is set for the programme, so a new visit is charged to none unless the worker chooses one. ',
        can('settings:manage') ? h('a', { href: d.attribution.settings_link, 'data-default-fund-link': '1' }, 'Set a default funding source in Settings') : 'An administrator can set one in Settings → Programme → Reporting.']) : null,
    d.attribution.unapproved_minutes ? h('div', { class: 'banner warn small', 'data-unapproved-hours': String(d.attribution.unapproved_minutes) },
      `${(d.attribution.unapproved_minutes / 60).toFixed(1)} staff hours logged in this period are not yet approved (${(d.attribution.approved_minutes / 60).toFixed(1)} approved). Only approved hours count toward a fund. `,
      can('time:approve') ? h('a', { href: d.attribution.approve_link }, 'Review time sheets') : null) : null,

    h('section', { class: 'card' },
      h('h2', {}, 'People served'),
      h('p', { class: 'small muted' }, `Between ${fmt.date(from)} and ${fmt.date(to)}${fund ? `, charged to ${state.funds.find(f => f.id === fund)?.name || 'the selected fund'}` : ''}.`),
      h('div', { class: 'grid cols-4' },
        stat('Unduplicated clients served', num(u.served)),
        stat('New admissions', num(u.new_admissions)),
        stat('Received a referral', num(u.with_a_referral)),
        stat('Admitted after a referral', num(u.admitted_after_referral), admitRate !== null && admitRate < 40 ? 'warn' : ''),
        stat('On medication for opioid use disorder', num(u.on_mat)),
        stat('Episodes opened', num(d.episodes.admissions)),
        stat('Episodes closed', num(d.episodes.discharges)),
        stat('Open at end of period', num(d.episodes.open_at_end))),
      admitRate !== null ? h('p', { class: 'small muted' }, `${admitRate}% of the people referred in this period were admitted somewhere — the question "did our warm handoffs actually land?" in one number.`) : null),

    h('section', { class: 'card' },
      h('h2', {}, 'Overdose & naloxone'),
      h('div', { class: 'grid cols-4' },
        stat('Overdose events recorded', num(d.overdose.events)),
        stat('Reversed with naloxone', num(d.overdose.reversals), 'ok'),
        stat('Fatal', num(d.overdose.fatal), d.overdose.fatal ? 'danger' : ''),
        stat('Reported from the community', num(d.overdose.community_reported)),
        stat('Naloxone doses used', num(d.overdose.naloxone_doses)),
        stat('Naloxone kits distributed', num(d.naloxone_distribution.kits)),
        stat('— of those, community distribution', num(d.naloxone_distribution.community_kits)),
        stat('Fentanyl test strips', num(d.naloxone_distribution.strips))),
      d.overdose.by_administered_by.length ? h('div', { class: 'grid cols-2 mt' },
        h('div', {}, h('h2', {}, 'Who gave the naloxone (reversals)'), bars(d.overdose.by_administered_by, { valueKey: 'n', labelKey: 'k', list: 'ADMINISTERED_BY' })),
        h('div', {}, h('h2', {}, 'By month'), bars(d.overdose.by_month.map(x => ({ k: x.month, n: x.n })), { valueKey: 'n', labelKey: 'k' }))) : null,
      d.suppression.mode === 'exact' ? null : h('p', { class: 'small muted', 'data-suppression-note': '1' }, `"<${d.suppression.threshold}" is a count of fewer than ${d.suppression.threshold} people; "suppressed" is hidden so that such a count cannot be worked out from the other figures. Kits, doses and test strips are not counts of people and are exact.`)),

    h('section', { class: 'card' },
      h('h2', {}, 'Who was served'),
      h('p', { class: 'small muted' }, 'Each person counted once. Race is recorded as codes a funder can count; because people may report more than one, those figures add up to more than the number served.'),
      d.withheld && d.withheld.length ? h('p', { class: 'small muted', 'data-withheld': d.withheld.join(',') }, 'Some breakdowns are withheld: too few people were served to show them without giving someone away.') : null,
      h('div', { class: 'grid cols-3' },
        h('div', {}, h('h2', {}, 'Race'), bars(d.demographics.by_race_code, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h2', {}, 'Ethnicity'), bars(d.demographics.by_ethnicity, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h2', {}, 'Gender'), bars(d.demographics.by_gender, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h2', {}, 'Language'), bars(d.demographics.by_language, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h2', {}, 'Housing'), bars(d.demographics.by_housing, { valueKey: 'n', labelKey: 'k' })),
        h('div', {}, h('h2', {}, 'Insurance'), bars(d.demographics.by_insurance, { valueKey: 'n', labelKey: 'k' })))),

    h('section', { class: 'card' },
      h('h2', {}, 'Discharges'),
      typeof d.episodes.median_length_of_stay_days === 'string'
        ? h('p', {}, `Median length of stay: suppressed (fewer than ${d.suppression.threshold} people were discharged).`)
        : d.episodes.median_length_of_stay_days !== null
        ? h('p', {}, `Median length of stay: ${d.episodes.median_length_of_stay_days} days.`)
        : h('p', { class: 'muted' }, 'No episodes were closed in this period.'),
      d.episodes.by_discharge_reason.length
        ? bars(d.episodes.by_discharge_reason, { valueKey: 'n', labelKey: 'k', list: 'DISCHARGE_REASONS' })
        : emptyState('Nothing to show', 'Discharge reasons appear here once episodes are closed. Close an episode from a client\'s Episodes tab.')),

    h('section', { class: 'card' },
      h('h2', {}, 'By funding source'),
      table([
        { label: 'Fund', render: f => (f.id ? f.name : h('span', { class: 'muted', 'data-no-fund-row': '1' }, f.name)) },
        { label: 'Grant number', render: f => f.grant_number || '—' },
        { label: 'Fiscal year', render: f => [f.fiscal_year_start, f.fiscal_year_end].filter(Boolean).map(fmt.date).join(' – ') || '—' },
        { label: 'People served', render: f => num(f.clients_served), num: true },
        { label: 'Services', render: f => num(f.services), num: true },
        { label: 'Approved staff hours', render: f => (f.approved_minutes / 60).toFixed(1), num: true },
        { label: 'Logged, not yet approved', render: f => (f.unapproved_minutes / 60).toFixed(1), num: true },
      ], d.by_funding_source, { empty: 'No active funding sources.' }),
      h('p', { class: 'small muted' }, 'Staff hours count only time that has been approved, so this matches what a county would invoice; time logged but still waiting for approval is shown beside it. A visit is charged to the worker\'s default fund (Settings → Users) or the programme\'s (Settings → Program) unless another is chosen.')));
});
