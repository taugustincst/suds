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

/** What to do before sharing a publication release (docs/HIPAA.md "Small cells in aggregate reports"). */
export function publicationGuidance() {
  return h('div', { class: 'small', 'data-publication-guidance': '1' },
    h('p', { class: 'mb' }, h('strong', {}, 'Before you publish: ')),
    h('ul', {},
      h('li', {}, 'Publish each period once. Never publish two periods that overlap or where one contains the other, such as a quarter and its year: they can be subtracted to reveal a small group.'),
      h('li', {}, 'Review the tables marked withheld or suppressed before you release the figures.'),
      h('li', {}, 'This suppression is a cautious automatic default, not a statistical expert determination.')));
}

/**
 * The confirmation a publication release's files need (server: reviewed=1, recorded in the audit log with the
 * release id). Returns { box, download(url, fetcher) }: box is null when no confirmation is needed; download
 * runs the export only once the box is ticked, and otherwise says why and moves focus to it.
 */
let reviewSeq = 0;
export function publicationReview(needed) {
  if (!needed) return { box: null, download: (url, fetcher) => fetcher(url) };
  const id = `publication-reviewed-${++reviewSeq}`;
  const input = h('input', { type: 'checkbox', id, 'data-publication-reviewed': '1', 'aria-describedby': `${id}-why` });
  const why = h('p', { class: 'small', id: `${id}-why`, 'data-publication-review-why': '1' }, 'Small cells are screened automatically, which is not a guarantee. The export of a publication release is recorded with your confirmation.');
  const box = h('div', { class: 'field mb', 'data-publication-review': '1' },
    h('label', { for: id, class: 'row', style: { gap: '.4rem', alignItems: 'center' } }, input, h('span', {}, 'I have reviewed the withheld and small figures before sharing')), why);
  return {
    box,
    download: (url, fetcher) => {
      if (!input.checked) { why.textContent = 'Tick "I have reviewed the withheld and small figures before sharing" first: the file is a publication release.'; why.setAttribute('role', 'alert'); input.focus(); return; }
      fetcher(`${url}&reviewed=1`);
    },
  };
}

/**
 * What kind of run this is, prominently: a submission to the funder (the default for a supervisor or an
 * administrator), an internal run, or a publication release. The label comes from the server
 * (suppression.label), which puts the same words on the file's About sheet.
 */
export function runKindBanner(d, extra = null) {
  const kind = d.suppression.purpose; const T = d.suppression.threshold;
  const exact = d.suppression.mode === 'exact';
  const label = d.suppression.label || (kind === 'publication' ? 'Publication release — small cells screened; review before sharing' : kind === 'submission' ? 'Submission to your funder — not for publication' : 'Internal — not for publication');
  // Two plain lines; the full statement (the same words as the file's About sheet) is one click away.
  const line = exact
    ? 'Exact counts, including groups of fewer than ' + T + ' people. Send it to your funder; do not publish or share it further.'
    : kind === 'publication'
      ? `Counts of fewer than ${T} people show as "<${T}", and a few more are hidden so they cannot easily be worked out from the other figures. Review it before you share it.`
      : `Counts of fewer than ${T} people show as "<${T}", and a few more are hidden so they cannot easily be worked out from the other figures. It stays within the program${kind === 'submission' ? ' and its funder' : ''}.`;
  return h('div', { class: `banner run-kind ${kind === 'publication' ? 'info' : 'warn'}`, 'data-counting-mode': d.suppression.mode, 'data-purpose': kind, 'data-run-kind': kind },
    h('h2', { class: 'run-kind-title' }, label),
    h('p', { class: 'run-kind-line' }, line),
    h('details', { class: 'small', 'data-counting-details': '1' }, h('summary', {}, exact ? 'About these counts' : 'Why some numbers are hidden'), h('p', {}, d.counting_statement)),
    extra);
}

/** The tables a publication release withheld, each with the reason (server/release-audit.js withheldReasons). */
export function withheldTables(d) {
  const list = (d.release && d.release.withheld_reasons) || [];
  return h('div', { class: 'mb', 'data-withheld-tables': String(list.length) },
    list.length
      ? [h('p', { class: 'small' }, h('strong', {}, `Withheld from this release (${list.length}): `), 'they are left out of every report of this release (the funder report, the NDP log and the settlement report); the reason is beside each.'),
        h('ul', { class: 'small' }, list.map(x => h('li', { 'data-withheld-table': x.table }, h('strong', {}, x.label), ` — ${x.why}`)))]
      : h('p', { class: 'small' }, h('strong', {}, 'Nothing was withheld: '), 'every table of this release is shown, with small counts screened.'));
}

route('funder', async (r) => {
  const internalOk = mayRunInternalReports();
  // A supervisor or an administrator opens the programme's own submission to its funder; publication is a step
  // they choose ("Prepare a publication release"). Finance and read-only accounts run publication releases only.
  const submissionOk = can('reports:internal');
  const { lastMonth, lastQuarter, lastYear } = publishablePeriods();
  const wantPublication = submissionOk && r.query.get('purpose') === 'publication';
  // A role that runs publication releases only opens on the last quarter that has ended, not a year to date.
  const [dFrom, dTo] = internalOk ? [null, null] : lastQuarter();
  const to = r.query.get('to') || dTo || fmt.today();
  const from = r.query.get('from') || dFrom || `${to.slice(0, 4)}-01-01`;
  const fund = internalOk && !wantPublication ? r.query.get('funding_source_id') || '' : '';
  // A submission counts exactly for a role that holds reports:exact (the server's default); it can choose
  // small cells suppressed instead. counts=exact (older links) is the default already.
  const suppressedAsked = r.query.get('counts') === 'suppressed' && can('reports:exact');
  const countQs = wantPublication ? '&purpose=publication' : suppressedAsked ? '&counts=suppressed' : '';
  const qs = `from=${from}&to=${to}${fund ? `&funding_source_id=${fund}` : ''}${countQs}`;
  const periodButtons = (onPick, label = 'Periods you can publish (whole program, ended):') => h('div', { class: 'filters', role: 'group', 'aria-label': 'Periods you can publish', 'data-publishable-periods': '1' },
    h('span', { class: 'small muted' }, label),
    h('button', { class: 'btn ghost sm', 'data-period': 'month', onClick: () => onPick(lastMonth()) }, 'Last month'),
    h('button', { class: 'btn ghost sm', 'data-period': 'quarter', onClick: () => onPick(lastQuarter()) }, 'Last quarter'),
    h('button', { class: 'btn ghost sm', 'data-period': 'year-jul', onClick: () => onPick(lastYear(7)) }, 'Last fiscal year (Jul–Jun)'),
    h('button', { class: 'btn ghost sm', 'data-period': 'year-oct', onClick: () => onPick(lastYear(10)) }, 'Last fiscal year (Oct–Sep)'));
  const publish = ([s, e]) => nav(`funder?from=${s}&to=${e}&purpose=publication`);
  const backToSubmission = () => h('button', { class: 'btn', 'data-back-to-submission': '1', onClick: () => nav(`funder?from=${from}&to=${to}`) }, 'Back to the submission to your funder');
  let d;
  try { d = await get(`/api/reports/funder?${qs}`); } catch (err) {
    // 422: the period's release could not be verified, so it is not published (server/publication-release.js).
    if (err.status !== 403 && err.status !== 422 && err.status !== 400) throw err;
    // A role that runs publication releases only, given a link to any other run, or a publication release that
    // was refused: say why, and offer what can be run instead of an error page.
    return h('div', {}, pageHead('Funder report'),
      h('div', { class: 'banner warn', role: 'alert', 'data-funder-refused': '1' }, err.message),
      submissionOk ? h('p', {}, backToSubmission()) : null,
      periodButtons(submissionOk ? publish : ([s, e]) => nav(`funder?from=${s}&to=${e}`)));
  }

  const fromI = h('input', { type: 'date', value: from, 'aria-label': 'From' });
  const toI = h('input', { type: 'date', value: to, 'aria-label': 'To' });
  const countsI = can('reports:exact') ? h('select', { 'aria-label': 'Counts', 'data-counts': '1' },
    h('option', { value: '', selected: !suppressedAsked }, 'Exact counts (for your funder)'),
    h('option', { value: 'suppressed', selected: suppressedAsked }, 'Small cells suppressed')) : null;
  const go = (f, t) => nav(`funder?from=${f}&to=${t}${fundI.value ? `&funding_source_id=${fundI.value}` : ''}${countsI && countsI.value === 'suppressed' ? '&counts=suppressed' : ''}`);
  const fundI = h('select', { 'aria-label': 'Funding source' },
    h('option', { value: '' }, 'All funding sources'),
    state.funds.map(f => h('option', { value: f.id, selected: f.id === fund }, f.name)));

  const publishable = d.suppression.purpose === 'publication';
  // A table withheld whole has no rows; say so where it would have been.
  const withheldNote = (keys, text) => { const w = (d.withheld || []).filter(k => keys.includes(k)); return w.length ? h('p', { class: 'small muted', 'data-withheld': w.join(',') }, text) : null; };

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

  const review = publicationReview(publishable && can('export:read'));
  // "Prepare a publication release": only to publish or share beyond the funder. It covers the whole programme
  // for one standard period that has ended; the current range when it is one, or one of the periods offered.
  const canPublishThis = isPublishablePeriod(from, to) && !fund;
  const preparePublication = submissionOk && !publishable ? h('section', { class: 'card', 'data-prepare-publication': '1' },
    h('h2', {}, 'Prepare a publication release'),
    h('p', { class: 'small muted' }, 'Only when figures will be published or shared beyond your funder: a public dashboard, a board pack, a county website. A publication release covers the whole program for one month, quarter or fiscal year that has ended. Small counts are screened; a table the automatic check cannot confirm is protected is withheld and listed with the reason; and you confirm you have reviewed it before its files are exported. The submission above is what your funder asks for.'),
    canPublishThis ? h('p', {}, h('button', { class: 'btn', 'data-prepare-publication-button': '1', onClick: () => publish([from, to]) }, `Prepare a publication release for ${fmt.date(from)} – ${fmt.date(to)}`)) : null,
    periodButtons(publish, canPublishThis ? 'Or another period (whole program, ended):' : 'Choose a period (whole program, ended):')) : null;
  return h('div', {},
    pageHead('Funder report',
      can('export:read') ? h('button', { class: 'btn', 'data-funder-export': 'xlsx', onClick: () => review.download(`/api/reports/funder/export?${qs}&format=xlsx`, downloadCsv) }, 'This report (Excel)') : null,
      can('export:read') ? h('button', { class: 'btn ghost', 'data-funder-export': 'csv', onClick: () => review.download(`/api/reports/funder/export?${qs}`, downloadCsv) }, 'CSV') : null,
      can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/workbook?from=${from}&to=${to}`) }, 'Export everything to Excel') : null),
    // Which kind of run this is, first: the exported file says the same on its About sheet.
    runKindBanner(d, publishable || submissionOk ? null : h('p', { class: 'small' }, 'To publish or share figures, a supervisor or an administrator prepares a publication release.')),
    h('p', { class: 'muted' }, 'Counts of people, each counted once however many times they were served. This is the shape most grant reporting asks for. It is not a CalOMS Tx submission: CalOMS records are collected, checked and extracted under Reports → State reporting.'),
    // A publication release: what was withheld and why, what to do before sharing it, and the confirmation its files need.
    publishable ? h('section', { class: 'card', 'data-publication-review-step': '1' },
      h('h2', {}, 'Review before you share it'),
      withheldTables(d), publicationGuidance(), review.box,
      submissionOk ? backToSubmission() : null) : null,

    // Custom ranges, one fund and year-to-date runs are not publication releases: offered only to a role that may run them.
    internalOk && !publishable ? h('div', { class: 'filters', 'data-custom-range': '1' },
      h('div', { class: 'field' }, h('label', {}, 'From'), fromI),
      h('div', { class: 'field' }, h('label', {}, 'To'), toI),
      h('div', { class: 'field' }, h('label', {}, 'Funding source'), fundI),
      countsI ? h('div', { class: 'field' }, h('label', {}, 'Counts'), countsI) : null,
      h('button', { class: 'btn primary', onClick: () => go(fromI.value, toI.value) }, 'Apply'),
      h('button', { class: 'btn ghost sm', onClick: () => { const [s, e] = fy(7); go(s, e); } }, 'Fiscal year (Jul–Jun)'),
      h('button', { class: 'btn ghost sm', onClick: () => { const [s, e] = fy(10); go(s, e); } }, 'Fiscal year (Oct–Sep)'),
      h('button', { class: 'btn ghost sm', onClick: () => go(`${to.slice(0, 4)}-01-01`, to) }, 'Calendar year'))
      : null,
    internalOk ? null : h('p', { class: 'small muted', 'data-publication-only': '1' }, 'Your role runs publication releases only: the whole program for one month, quarter or fiscal year that has ended, with small counts screened. The program\'s submission to its funder, custom ranges and single funds are run by a supervisor or administrator.',
      can('budget:read') ? ' Money and staff hours for any period or fund are on Funding & spending.' : ''),
    // Other periods: a supervisor preparing a release picks another period to publish; a publication-only role
    // runs one of them; a caseload-scoped role's runs are internal, so it gets none.
    publishable ? periodButtons(submissionOk ? publish : ([s, e]) => nav(`funder?from=${s}&to=${e}`)) : internalOk ? null : periodButtons(([s, e]) => nav(`funder?from=${s}&to=${e}`)),
    preparePublication,
    d.caseload_scope_note ? h('p', { class: 'small muted', 'data-caseload-scope': '1' }, d.caseload_scope_note) : null,

    // What would otherwise be missing without a word: services charged to no fund, and staff time nobody
    // has approved yet (approved hours are what a county would invoice, so unapproved time counts as none).
    d.attribution.unattributed_services ? h('div', { class: 'banner warn small', 'data-unattributed': String(d.attribution.unattributed_services) },
      `${num(d.attribution.unattributed_services)} service${d.attribution.unattributed_services === 1 ? '' : 's'} in this period ${d.attribution.unattributed_services === 1 ? 'has' : 'have'} no funding source, so no fund reports ${d.attribution.unattributed_services === 1 ? 'it' : 'them'} (the "No funding source" row below). `,
      h('a', { href: d.attribution.fix_link }, 'Review those visits'),
      // Why it keeps happening on a new install: no programme default fund, so a visit nobody charges goes to
      // none. Settings → Programme → Reporting is where one is set.
      d.attribution.default_fund_set ? null : [' No default funding source is set for the program, so a new visit is charged to none unless the worker chooses one. ',
        can('settings:manage') ? h('a', { href: d.attribution.settings_link, 'data-default-fund-link': '1' }, 'Set a default funding source in Settings') : 'An administrator can set one in Settings → Program → Reporting.']) : null,
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
      // A publication release lists every code and every month, zero or not; nothing to draw if all are 0.
      d.overdose.by_administered_by.some(x => x.n !== 0) ? h('div', { class: 'grid cols-2 mt' },
        h('div', {}, h('h2', {}, 'Who gave the naloxone (reversals)'), bars(d.overdose.by_administered_by, { valueKey: 'n', labelKey: 'k', list: 'ADMINISTERED_BY' })),
        h('div', {}, h('h2', {}, 'By month'), bars(d.overdose.by_month.map(x => ({ k: x.month, n: x.n })), { valueKey: 'n', labelKey: 'k' }))) : null,
      withheldNote(['by_administered_by', 'by_month'], 'Who gave the naloxone, or the overdoses by month, are withheld: they could not be shown without giving someone away.'),
      d.suppression.mode === 'exact' ? null : h('p', { class: 'small muted', 'data-suppression-note': '1' }, `"<${d.suppression.threshold}" is a count of fewer than ${d.suppression.threshold} people; "suppressed" is hidden so that such a count cannot be worked out from the other figures. Kits and test strips are not counts of people and are exact; doses are hidden when they would show how many reversals there were.`)),

    h('section', { class: 'card' },
      h('h2', {}, 'Who was served'),
      h('p', { class: 'small muted' }, 'Each person counted once. Race is recorded as codes a funder can count; because people may report more than one, those figures add up to more than the number served.'),
      withheldNote(['by_race_code', 'by_ethnicity', 'by_gender', 'by_language', 'by_housing', 'by_insurance'], 'Some breakdowns are withheld: too few people were served to show them without giving someone away.'),
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
      withheldNote(['by_discharge_reason'], 'Discharge reasons are withheld: they could not be shown without giving someone away.'),
      d.episodes.by_discharge_reason.some(x => x.n !== 0)
        ? bars(d.episodes.by_discharge_reason, { valueKey: 'n', labelKey: 'k', list: 'DISCHARGE_REASONS' })
        : (d.withheld || []).includes('by_discharge_reason') ? null : emptyState('Nothing to show', 'Discharge reasons appear here once episodes are closed. Close an episode from a client\'s Episodes tab.')),

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
      h('p', { class: 'small muted' }, 'Staff hours count only time that has been approved, so this matches what a county would invoice; time logged but still waiting for approval is shown beside it. A visit is charged to the worker\'s default fund (Settings → Users) or the program\'s (Settings → Program) unless another is chosen.')));
});
