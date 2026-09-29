import { h, route, get, put, state, fmt, can, pageHead, bars, stat, table, downloadCsv, nav, sparkline, form, modal, toast, moduleOn, loadingFor } from '../app.js';
import { withRestrictionCheck } from './part2.js';
import { isPublishablePeriod, mayRunInternalReports, maySubmit, publicationGuidance, publicationReview } from './funder.js';

// An identified export is a disclosure: fetched here rather than followed as a link, so a refusal (no lawful
// basis, a client without consent, an agreed restriction to check) is shown as a message, not saved as a file.
// Returns the client codes the server left out of the file (under consent, clients whose consent does not
// name the recipient), so the caller can say so.
export async function fetchDownload(path) {
  let status, body, headers;
  if (state.local && window.SUDS_LOCAL) { const r = await window.SUDS_LOCAL.handle('GET', path, undefined, {}); status = r.status; body = r.body; headers = r.headers || {}; }
  else { const res = await fetch(path, { credentials: 'same-origin', headers: { 'X-Requested-With': 'suds' } }); status = res.status; body = await res.arrayBuffer(); headers = { 'content-disposition': res.headers.get('content-disposition') || '', 'content-type': res.headers.get('content-type') || '', 'x-suds-export-excluded': res.headers.get('x-suds-export-excluded') || '', 'x-suds-handoff-excluded': res.headers.get('x-suds-handoff-excluded') || '' }; }
  if (status >= 400) {
    let j = {}; try { j = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)); } catch { /* not JSON */ }
    const err = new Error(j.error || 'The export was refused'); err.status = status; err.data = j; throw err;
  }
  const name = (/filename="([^"]+)"/.exec(headers['content-disposition'] || '') || [])[1] || 'export';
  const u = URL.createObjectURL(new Blob([body], { type: headers['content-type'] || 'application/octet-stream' }));
  const a = h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000);
  return { excluded: String(headers['x-suds-export-excluded'] || headers['x-suds-handoff-excluded'] || '').split(',').filter(Boolean) };
}
/** The message after an identified file is downloaded: what it carries, and who was left out of it. */
export function downloadedMessage(done, what) {
  const out = done && done.excluded && done.excluded.length ? ` Left out (no consent on file naming this recipient): ${done.excluded.join(', ')}.` : '';
  return `${what}${out}`;
}
// What each basis needs (server/disclosure.js requireExportBasis): research, audit and a QSOA rest on the
// agreement or approval on file with the recipient (Privacy & Part 2 → Agreements); "internal" is only for
// this program or its own staff; under consent, a client whose consent does not name the recipient is left out.
const EXPORT_BASES = [
  { value: 'audit_evaluation', label: 'Audit or program evaluation (42 CFR §2.53) — approval on file with the recipient' }, { value: 'research', label: 'Research (42 CFR §2.52) — IRB approval on file with the recipient' },
  { value: 'qsoa', label: 'Qualified service organization agreement (§2.12(c)(4)) — agreement on file with the recipient' }, { value: 'internal', label: 'Within this program only (§2.12(c)(3)) — the recipient is this program or its staff' },
  { value: 'consent', label: "Each client's Part 2 consent naming this recipient (clients without one are left out)" },
];
function openIdentifiedExport(from, to) {
  const f = form([
    { name: 'recipient', label: 'Who receives this file', required: true, span: true, help: "Written to each client's accounting of disclosures." },
    { name: 'purpose', label: 'Purpose of the disclosure', required: true, span: true },
    { name: 'basis', label: 'Lawful basis', type: 'select', options: EXPORT_BASES, required: true, noBlank: true, span: true, help: "A file for a legal proceeding against a client is never a bulk export: record it on that client's Consents tab under a court order." },
  ], { submitText: 'Export (names included, audited)', onCancel: () => m.close(), onSubmit: async (v) => {
    const url = `/api/reports/export/workbook?from=${from}&to=${to}&identified=1&recipient=${encodeURIComponent(v.recipient)}&purpose=${encodeURIComponent(v.purpose)}&basis=${encodeURIComponent(v.basis)}`;
    const done = await withRestrictionCheck((extra) => fetchDownload(url + (extra.restriction_reviewed ? '&restriction_reviewed=1' : '')));
    m.close(); toast(downloadedMessage(done, 'Exported. The file carries the 42 CFR Part 2 notice on its About sheet.'), 'ok');
  } });
  const m = modal('Identified export', h('div', {}, h('div', { class: 'banner warn small' }, 'This export includes client names, dates of birth and contact details. It is a disclosure: it is recorded in the audit log and in the accounting of disclosures of every client it contains, and it needs a lawful basis under 42 CFR Part 2.'), f));
}

loadingFor('reports', () => 'Counting visits, clients, calls and referrals for the period…');
route('reports', async (r) => {
  const to = r.query.get('to') || fmt.today(); const from = r.query.get('from') || new Date(Date.parse(to) - 89 * 86400000).toISOString().slice(0, 10);
  const months = Number(r.query.get('months') || 12);
  const seesEpisodes = can('episodes:read') || can('episodes:write');
  const [d, m, eps, oc] = await Promise.all([get(`/api/reports/dashboard?from=${from}&to=${to}`), get(`/api/reports/monthly?months=${months}`),
    seesEpisodes ? get(`/api/episodes?from=${from}&to=${to}&status=all&limit=500`).catch(() => null) : null,
    moduleOn('assessments') ? get(`/api/reports/outcomes?from=${from}&to=${to}`).catch(() => null) : null]);
  // Outcome measures (PHQ-9, GAD-7, AUDIT-C, DAST-10, wellbeing): each client's first score in the period
  // against their last. Aggregate only; the export is one de-identified row per client and measure.
  const outcomesCard = () => h('div', { class: 'card mb', 'data-outcomes-report': '1' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Outcome measures'), can('export:read') ? h('button', { class: 'btn sm', 'data-export-outcomes': '1', onClick: () => downloadCsv(`/api/reports/outcomes/export?from=${from}&to=${to}`) }, 'Export (de-identified CSV)') : null),
    h('p', { class: 'small muted' }, 'Baseline is each client\'s first administration in the period and latest their last; only clients screened at least twice count toward change. Improved means the score moved in the better direction (lower for PHQ-9, GAD-7, AUDIT-C and DAST-10; higher for wellbeing).'),
    table([{ label: 'Measure', key: 'name' }, { label: 'Screened', key: 'clients_screened', num: true }, { label: 'Screened 2+ times', key: 'clients_with_followup', num: true },
      { label: 'Baseline (mean)', render: x => x.mean_baseline ?? '—', num: true }, { label: 'Latest (mean)', render: x => x.mean_latest ?? '—', num: true }, { label: 'Change (mean)', render: x => x.mean_change ?? '—', num: true },
      { label: 'Improved', render: x => (x.pct_improved === null ? '—' : `${x.improved} (${x.pct_improved}%)`), num: true }, { label: 'Worse', key: 'worse', num: true }, { label: 'Unchanged', key: 'unchanged', num: true },
      { label: 'Positive: first → last', render: x => (x.clients_with_followup ? `${x.positive_at_baseline} → ${x.positive_at_latest}` : '—') }, { label: 'PHQ-9 alerts', render: x => (x.instrument === 'phq9' ? String(x.safety_flags) : '') }],
      oc.instruments, { empty: 'No outcome measures in this period.' }));
  // Admissions and discharges in the period (GET /api/episodes). A client code opens the client only for a
  // role that can open client records.
  const clientCell = (x) => (can('clients:read') ? h('a', { href: `#/client/${x.client_id}/episodes` }, x.client_code) : h('span', { class: 'mono' }, x.client_code));
  const episodesCard = () => {
    const s = eps.summary || { opened: eps.total, still_open: eps.rows.filter(x => x.status === 'open').length, since_closed: eps.rows.filter(x => x.status === 'closed').length, discharged: 0, discharges_by_reason: [] };
    return h('div', { class: 'card mb', 'data-episodes-report': '1' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Episodes of care')),
      h('p', { class: 'small muted' }, 'Admissions are episodes opened in the period; discharges are episodes closed in the period, whenever they were opened.'),
      h('div', { class: 'grid cols-4 mb' }, stat('Admissions', s.opened), stat('Still open', s.still_open), stat('Since discharged', s.since_closed), stat('Discharges in period', s.discharged)),
      h('div', { class: 'grid cols-2' },
        h('div', {}, h('h3', { class: 'eyebrow' }, 'Discharges by reason'), bars(s.discharges_by_reason, { list: 'DISCHARGE_REASONS' })),
        h('div', {}, h('h3', { class: 'eyebrow' }, 'Admissions in the period'),
          table([{ label: 'Client', render: clientCell }, { label: 'Opened', render: x => fmt.date(x.opened_at) }, { label: 'Closed', render: x => (x.closed_at ? fmt.date(x.closed_at) : '—') }, { label: 'Reason', render: x => (x.discharge_reason ? fmt.label(x.discharge_reason) : '') }, { label: 'Funding', render: x => x.funding_source || '' }],
            eps.rows.slice(0, 50), { empty: 'No episodes opened in this period.' }),
          eps.total > Math.min(50, eps.rows.length) ? h('p', { class: 'small muted' }, `Showing ${Math.min(50, eps.rows.length)} of ${eps.total}. The Episodes export below has them all.`) : null)));
  };
  const fromI = h('input', { type: 'date', value: from }), toI = h('input', { type: 'date', value: to });
  const monthTable = () => {
    const keys = [...new Set([...m.intakes, ...m.interventions, ...m.calls, ...m.referrals, ...m.time, ...m.spend].map(x => x.month))].sort();
    const find = (arr, k, f = 'n') => (arr.find(x => x.month === k) || {})[f] || 0;
    return table([{ label: 'Month', key: 'month' }, { label: 'Intakes', key: 'intakes', num: true }, { label: 'Discharges', key: 'discharges', num: true }, { label: 'Visits', key: 'interventions', num: true }, { label: 'Clients served', key: 'served', num: true }, { label: 'Service hrs', render: x => (x.minutes / 60).toFixed(1), num: true }, { label: 'Calls', key: 'calls', num: true }, { label: 'Referrals', key: 'referrals', num: true }, { label: 'Admitted', key: 'successful', num: true }, { label: 'MAT linkages', key: 'mat', num: true }, { label: 'Naloxone kits', key: 'kits', num: true }, { label: 'Staff hrs', render: x => (x.staff / 60).toFixed(1), num: true }, can('budget:read') ? { label: 'Spend', render: x => fmt.money(x.spend), num: true } : null].filter(Boolean),
      keys.map(k => ({ month: k, intakes: find(m.intakes, k), discharges: find(m.discharges, k), interventions: find(m.interventions, k), served: find(m.interventions, k, 'clients'), minutes: find(m.interventions, k, 'minutes'), calls: find(m.calls, k), referrals: find(m.referrals, k), successful: find(m.referrals, k, 'successful'), mat: find(m.mat_linkage, k), kits: find(m.naloxone, k, 'kits'), staff: find(m.time, k, 'minutes'), spend: find(m.spend, k, 'amount') })), { empty: 'No data for this period.' });
  };
  // The exports, in three groups with what each is for, instead of one row of 17 buttons. What each button
  // exports is unchanged; only where it sits.
  const exportGroup = (title, text, attrs, ...content) => h('div', { class: 'export-group', ...attrs }, h('h3', { class: 'eyebrow' }, title), h('p', { class: 'small muted' }, text), h('div', { class: 'row' }, ...content));
  // California harm-reduction reporting (docs/compliance/HARM-REDUCTION-REPORTING.md): the Naloxone
  // Distribution Project log and the opioid settlement expenditure report, part of "Funder & programme".
  // A supervisor's or an administrator's file is the programme's own submission (exact counts, not for
  // publication) unless they choose small cells suppressed, or a publication release for a range that can be
  // one. A role that runs publication releases only (finance, read-only; a caseload-scoped role for the
  // whole-programme settlement report) gets the buttons only for a range that is one: any other is refused
  // (server/routes/reports.js requireReportRun), and a refusal fetched anyway is shown as its message.
  // Publication releases can be switched off (Settings › Program › Modules); then only submissions are made.
  const pubOn = moduleOn('publication');
  const pubRange = pubOn && isPublishablePeriod(from, to);
  const wholeProgramme = !can('clients:read') || can('clients:all');
  // reports:funder (finance): the programme's submission of both reports, for any range.
  const submissionOk = maySubmit();
  const ndpOk = submissionOk || mayRunInternalReports({ caseloadScoped: true }) || pubRange;
  const settlementOk = submissionOk || mayRunInternalReports({ caseloadScoped: false }) || (pubRange && wholeProgramme);
  const onlyPublication = h('span', { class: 'small muted', 'data-hr-publication-only': '1' }, pubOn ? ' Your role can download this only as a publication release: set the range above to one calendar month, quarter or fiscal year that has ended.' : ' Publication releases are switched off for this program, and your role runs no other kind of this report.');
  const exactOk = can('reports:exact') || can('reports:funder');
  // What kind of file: the submission (default), the submission with small cells suppressed, or a publication release.
  const hrKind = submissionOk ? h('select', { id: 'hr-kind', 'data-hr-kind': '1' },
    h('option', { value: '' }, exactOk ? 'Submission to your funder, exact counts — not for publication' : 'Submission to your funder — not for publication'),
    exactOk ? h('option', { value: 'suppressed' }, 'Submission to your funder, small cells suppressed — not for publication') : null,
    h('option', { value: 'publication', disabled: !pubRange }, !pubOn ? 'Publication release (switched off for this program)' : pubRange ? 'Publication release — to publish or share' : 'Publication release (only for a month, quarter or fiscal year that has ended)')) : null;
  const kindOf = () => (hrKind ? hrKind.value : pubRange && wholeProgramme ? 'publication' : '');
  const hrQs = () => ({ suppressed: '&counts=suppressed', publication: '&purpose=publication' }[hrKind ? hrKind.value : ''] || '');
  // A publication release's file needs the review confirmed first; the box and the guidance are shown only for one.
  const guide = h('div', { 'data-hr-publication-guidance': '1' }, pubRange ? publicationGuidance() : null);
  if (hrKind) guide.hidden = true;
  const hrReview = () => {
    const rv = publicationReview(pubRange && (submissionOk || wholeProgramme));
    if (rv.box && hrKind) { const sync = () => { rv.box.hidden = hrKind.value !== 'publication'; guide.hidden = rv.box.hidden; }; rv.box.hidden = true; hrKind.addEventListener('change', sync); }
    return rv;
  };
  const hrDownload = (rv, url) => (kindOf() === 'publication' ? rv.download(url, fetchDownload) : fetchDownload(url));
  const harmReduction = (rv = hrReview()) => h('div', { class: 'mt', 'data-harm-reduction-reports': '1' }, h('h4', { class: 'small', style: { margin: '.75rem 0 .25rem' } }, 'Harm-reduction reporting'),
      h('p', { class: 'small muted' }, 'For the range above. Aggregate counts and amounts only: no names or client codes. Kits and amounts are always exact.'),
      h('p', { class: 'small muted', 'data-hr-publication-note': '1' }, submissionOk
        ? 'A file is the program\'s own submission to its funder, not for publication, unless you choose a publication release: that is only for a range of one calendar month, quarter or fiscal year (starting in January, April, July or October) that has ended. It screens small counts, withholds any table whose protection the automatic check cannot confirm, and gives the NDP log by month for all sites.'
        : 'A file is a publication release only when the range above is one calendar month, quarter or fiscal year (starting in January, April, July or October) that has ended; the NDP log is then by month, for all sites, and small counts are screened. Any other range gives a file marked internal, not for publication.'),
      hrKind ? h('div', { class: 'field mb' }, h('label', { for: 'hr-kind' }, 'Kind of file'), hrKind) : null,
      guide,
      rv.box,
      h('div', { class: 'row mb' }, h('span', {}, h('b', {}, 'Naloxone distribution & reversal log (NDP-style)'), h('span', { class: 'small muted' }, ' — kits and doses by day, site and recipient type; reversals reported. Check the columns against the current NDP reporting template before submitting.')),
        ndpOk ? [h('button', { class: 'btn sm', 'data-ndp-export': 'xlsx', onClick: () => hrDownload(rv, `/api/reports/naloxone-ndp/export?from=${from}&to=${to}&format=xlsx${hrQs()}`) }, 'NDP log (Excel)'), h('button', { class: 'btn sm ghost', 'data-ndp-export': 'csv', onClick: () => hrDownload(rv, `/api/reports/naloxone-ndp/export?from=${from}&to=${to}${hrQs()}`) }, 'CSV')] : onlyPublication),
      // The syringe services summary is the program's own submission, never a publication release (server/ssp-report.js).
      mayRunInternalReports({ caseloadScoped: true }) ? h('div', { class: 'row mb', 'data-ssp-row': '1' }, h('span', {}, h('b', {}, 'Syringe services summary (SSP)'), h('span', { class: 'small muted' }, ' — participants, contacts, syringes distributed and returned, naloxone by product and referrals. Always the program\'s own submission; also on the Supplies page. ')),
        h('button', { class: 'btn sm', 'data-ssp-export': 'xlsx', onClick: () => downloadCsv(`/api/reports/ssp/export?from=${from}&to=${to}&format=xlsx${hrKind && hrKind.value === 'suppressed' ? '&counts=suppressed' : ''}`) }, 'SSP summary (Excel)'),
        h('button', { class: 'btn sm ghost', 'data-ssp-export': 'csv', onClick: () => downloadCsv(`/api/reports/ssp/export?from=${from}&to=${to}${hrKind && hrKind.value === 'suppressed' ? '&counts=suppressed' : ''}`) }, 'CSV')) : null,
      can('budget:read') ? h('div', { class: 'row' }, h('span', {}, h('b', {}, 'Opioid settlement expenditures'), h('span', { class: 'small muted' }, ' — spending from settlement funds by allowable use (Exhibit E) and California High Impact Abatement Activity. Categories need verification against each fund\'s agreement.')),
        (can('reports:funder') || can('reports:internal')) ? h('a', { class: 'btn sm', href: '#/settlement', 'data-settlement-outcomes-link': '1' }, 'Settlement outcomes (page)') : null,
        settlementOk ? [h('button', { class: 'btn sm', 'data-settlement-export': 'xlsx', onClick: () => hrDownload(rv, `/api/reports/opioid-settlement/export?from=${from}&to=${to}&format=xlsx${hrQs()}`) }, 'Settlement report (Excel)'), h('button', { class: 'btn sm ghost', 'data-settlement-export': 'csv', onClick: () => hrDownload(rv, `/api/reports/opioid-settlement/export?from=${from}&to=${to}${hrQs()}`) }, 'CSV')] : onlyPublication.cloneNode(true)) : null,
      // No fund is settlement money: say so here, before anyone downloads a file with nothing in it.
      can('budget:read') && !(state.allFunds || []).some(f => f.source_type === 'opioid_settlement' || f.settlement_use || f.settlement_hiaa)
        ? h('p', { class: 'small muted', 'data-settlement-none': '1' }, 'No funding source is marked as opioid settlement money, so the settlement report has nothing to list. ', can('budget:manage') ? h('a', { href: '#/budget' }, 'Set the fund\'s source type to Opioid settlement under Funding & spending') : 'An administrator sets a fund\'s source type under Funding & spending', '.') : null,
      // The same spending in the DHCS settlement expenditure layout, or a county's own template: the program's
      // own report (a submission), never a publication release.
      can('budget:read') && submissionOk ? h('div', { class: 'row mt', 'data-settlement-layouts': '1' }, h('span', {}, h('b', {}, 'For DHCS or your county'), h('span', { class: 'small muted' }, ' — the settlement spending one row per activity, in the DHCS settlement expenditure layout or your county\'s template. SUDS fills the categories, amounts and people served; the narrative columns are left for you to write.')),
        h('button', { class: 'btn sm', 'data-settlement-layout': 'dhcs', onClick: () => fetchDownload(`/api/reports/opioid-settlement/export?from=${from}&to=${to}&layout=dhcs&format=xlsx${hrKind && hrKind.value === 'suppressed' ? '&counts=suppressed' : ''}`).catch(e => toast(e.message, 'danger')) }, 'DHCS settlement expenditure layout (Excel)'),
        h('button', { class: 'btn sm ghost', 'data-settlement-layout': 'dhcs-csv', onClick: () => fetchDownload(`/api/reports/opioid-settlement/export?from=${from}&to=${to}&layout=dhcs${hrKind && hrKind.value === 'suppressed' ? '&counts=suppressed' : ''}`).catch(e => toast(e.message, 'danger')) }, 'CSV'),
        h('button', { class: 'btn sm', 'data-settlement-layout': 'county', onClick: () => fetchDownload(`/api/reports/opioid-settlement/export?from=${from}&to=${to}&layout=county&format=xlsx`).catch(e => toast(e.message, 'danger')) }, 'County template (Excel)'),
        can('budget:manage') ? h('button', { class: 'btn sm ghost', 'data-county-template': '1', onClick: () => openCountyTemplate() }, 'Set up the county template') : null) : null);
  const exportsCard = () => h('div', { class: 'card', 'data-exports': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'Export to Excel or CSV')),
    h('p', { class: 'small muted' }, 'The range above chooses the rows (clients, resources and to-dos are complete lists).'),
    exportGroup('Funder & program', 'For grant reports and the program\'s own books: everything in one workbook, staff time and the resource directory, and — for roles that see the budget — funding, budget lines and spending.', { 'data-export-group': 'programme' },
      h('button', { class: 'btn primary', onClick: () => downloadCsv(`/api/reports/export/workbook?from=${from}&to=${to}`) }, 'Everything as one Excel workbook'),
      h('a', { class: 'btn', href: '#/funder' }, 'Funder report (unduplicated counts)'),
      exportRow('time', 'Time'), exportRow('resources', 'Resources'),
      can('budget:read') ? [exportRow('expenditures', 'Expenditures'), exportRow('funds', 'Funding'), exportRow('budget_lines', 'Budget lines')] : null),
    harmReduction(),
    exportGroup('De-identified records', 'One row per record, with only the columns a de-identified file may hold: no names or free text, dates reduced to the year, and a random record id in place of the client code, new with every file.', { 'data-export-group': 'deidentified' },
      exportRow('clients', 'Clients'), exportRow('interventions', 'Visits'), exportRow('calls', 'Calls'), exportRow('referrals', 'Referrals'), exportRow('tasks', 'To-dos'), exportRow('consents', 'Consents'), exportRow('episodes', 'Episodes'), exportRow('overdose_events', 'Overdose events'), exportRow('forms', 'Client forms'), exportRow('disclosures', 'Disclosures')),
    can('export:identified') ? exportGroup('Records (identified)', 'Names, dates of birth and contact details. A disclosure: it needs a lawful basis, and it is written to the audit log and to each client\'s accounting of disclosures.', { 'data-export-group': 'identified' },
      h('button', { class: 'btn sm danger', 'data-identified-export': '1', onClick: () => openIdentifiedExport(from, to) }, 'Identified Excel workbook (names included, audited)')) : null);
  const exportRow = (kind, label) => h('span', { class: 'row', style: { gap: '.15rem', marginRight: '.5rem' } }, h('button', { class: 'btn sm', onClick: () => downloadCsv(`/api/reports/export/${kind}?from=${from}&to=${to}&format=xlsx`) }, `${label} (Excel)`), h('button', { class: 'btn sm ghost', onClick: () => downloadCsv(`/api/reports/export/${kind}?from=${from}&to=${to}`) }, 'CSV'));
  return h('div', {},
    pageHead('Reports', h('button', { class: 'btn', onClick: () => window.print() }, 'Print')),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('button', { class: 'btn', onClick: () => nav(`reports?from=${fromI.value}&to=${toI.value}&months=${months}`) }, 'Apply'), h('button', { class: 'btn ghost sm', onClick: () => nav(`reports?from=${to.slice(0, 4)}-01-01&to=${to}`) }, 'Year to date'), h('button', { class: 'btn ghost sm', onClick: () => nav(`reports?from=${to.slice(0, 8)}01&to=${to}`) }, 'This month')),
    h('h2', {}, `Program summary · ${fmt.date(from)} – ${fmt.date(to)}`),
    d.small_cells ? h('p', { class: 'small muted', 'data-small-cells': '1' }, `Counts of people from 1 to ${d.small_cells.threshold - 1} are shown as "<${d.small_cells.threshold}" for your role, as they are in the funder report.`) : null,
    h('div', { class: 'grid cols-4 mb' }, stat('Active clients', d.clients.active, '', 'clients?status=active'), stat('New intakes', d.clients.new_in_range, '', 'clients?status=all'), stat('Visits', d.interventions.total, '', `interventions?from=${from}&to=${to}`), stat('Service hours', (d.interventions.minutes / 60).toFixed(1), '', `time?from=${from}&to=${to}`), stat('Calls', d.calls.total - (d.calls.texts || 0), '', 'calls?method=phone'), stat('Text messages', d.calls.texts || 0, '', 'calls?method=text'), stat('Crisis contacts', d.calls.crisis, d.calls.crisis ? 'danger' : ''), stat('Referrals', d.referrals.total), stat('Median days to admit', d.referrals.median_days_to_admit === null ? '—' : d.referrals.median_days_to_admit.toFixed(1)), stat('Naloxone kits', d.interventions.naloxone_kits), stat('Fentanyl strips', d.interventions.fentanyl_strips), stat('No contact 30d', d.clients.no_contact_30d, d.clients.no_contact_30d ? 'warn' : ''), d.budget ? stat('Spend', fmt.money(d.budget.spent)) : null),
    h('div', { class: 'grid cols-2 mb' },
      h('div', { class: 'card' }, h('h2', {}, 'Visits by type'), bars(d.interventions.by_type, { list: 'INTERVENTION_TYPES', link: x => `interventions?type=${x.k}&from=${from}&to=${to}` })), d.interventions.by_worker ? h('div', { class: 'card' }, h('h2', {}, 'Visits by worker'), bars(d.interventions.by_worker)) : null,
      h('div', { class: 'card' }, h('h2', {}, 'Referral outcomes by category'), table([{ label: 'Category', render: x => fmt.label(x.k) }, { label: 'Referred', key: 'n', num: true }, { label: 'Admitted', key: 'successful', num: true }, { label: 'Rate', render: x => typeof x.n === 'number' && typeof x.successful === 'number' && x.n ? `${Math.round(100 * x.successful / x.n)}%` : '—', num: true }], d.referrals.by_category, { wrap: false })),
      h('div', { class: 'card' }, h('h2', {}, 'Clients by status'), bars(d.clients.by_status, { labelKey: 'status', link: x => `clients?status=${x.status}` })), h('div', { class: 'card' }, h('h2', {}, 'Primary substance (active)'), bars(d.clients.by_substance, { list: 'SUBSTANCES', link: x => `clients?status=active&substance=${x.k}` })), h('div', { class: 'card' }, h('h2', {}, 'MAT status'), bars(d.clients.mat, { link: x => `clients?status=active&mat=${x.k}` })),
      d.time ? h('div', { class: 'card' }, h('h2', {}, 'Staff time by category'), bars(d.time.by_category, { list: 'TIME_CATEGORIES', format: fmt.mins })) : null, h('div', { class: 'card' }, h('h2', {}, 'Calls and texts by outcome'), bars(d.calls.by_outcome, { list: ['CALL_OUTCOMES', 'TEXT_OUTCOMES'], link: () => 'calls' })), h('div', { class: 'card' }, h('h2', {}, 'Weekly visits'), sparkline(d.interventions.by_week.map(w => w.n)))),
    eps ? episodesCard() : null,
    oc ? outcomesCard() : null,
    // CalOMS Tx and the county EHR hand-off have their own page: they are submissions, not summaries.
    // Only for a programme that uses CalOMS or the EHR hand-off (server/programme.js).
    (seesEpisodes && moduleOn('caloms')) || (can('export:identified') && (moduleOn('caloms') || moduleOn('handoff'))) ? h('div', { class: 'card mb', 'data-state-reporting-link': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'State reporting & county EHR hand-off'), h('a', { class: 'btn sm primary', href: '#/caloms' }, 'Open')),
      h('p', { class: 'small muted' }, 'CalOMS Tx admission, discharge and annual update records: the validation report and the extract for DHCS. And the encounter hand-off for the county EHR — SUDS does not submit Drug Medi-Cal claims.')) : null,
    h('div', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h2', {}, `Monthly trend (last ${months} months)`), h('div', { class: 'row' }, [6, 12, 24].map(n => h('button', { class: `btn sm ${n === months ? 'primary' : ''}`, onClick: () => nav(`reports?from=${from}&to=${to}&months=${n}`) }, `${n}m`)))), monthTable()),
    moduleOn('suprt') && can('clients:read') ? h('div', { class: 'card mb', 'data-suprt-link': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'SUPRT-A (SOR client-level reporting)'), h('a', { class: 'btn sm primary', href: '#/suprt' }, 'Open')),
      h('p', { class: 'small muted' }, 'Completion of baselines, reassessments, annual assessments and closeouts, and the file for entry into SPARS.')) : null,
    can('export:read') ? exportsCard() : null);
});

/**
 * The county's own settlement template, matched without code: its name and, in order, each column's heading
 * and where its value comes from (a field of the DHCS layout, blank for the program to write, or fixed text).
 */
async function openCountyTemplate() {
  const d = await get('/api/reports/settlement-layout');
  const cur = d.county || { name: '', columns: [] };
  const rows = cur.columns.length ? cur.columns.map(c => ({ ...c })) : [{ label: '', source: 'exhibit_e_category' }];
  const list = h('div', { 'data-county-columns': '1' });
  const nameI = h('input', { type: 'text', id: 'county-template-name', value: cur.name, maxlength: 100, required: true, 'aria-required': 'true' });
  // Its rows: settlement activities, or one per fund of another type (a county's SABG template), 1.16.0.
  const rowsI = h('select', { id: 'county-template-rows', 'data-county-rows': '1', 'aria-describedby': 'county-template-rows-help' }, (d.fund_types || []).map(o => h('option', { value: o.value, selected: o.value === (cur.fund_type || '') }, o.label)));
  const err = h('div', { class: 'banner danger hidden', role: 'alert', tabindex: '-1' });
  const draw = () => {
    list.replaceChildren(...rows.map((c, i) => {
      const labelI = h('input', { type: 'text', id: `county-col-${i}`, value: c.label, maxlength: 100, onInput: (e) => { c.label = e.target.value; } });
      const srcI = h('select', { id: `county-src-${i}`, onChange: (e) => { c.source = e.target.value; draw(); } }, d.sources.map(o => h('option', { value: o.value, selected: o.value === c.source }, o.label)));
      const textI = c.source === 'text' ? h('input', { type: 'text', id: `county-text-${i}`, value: c.text || '', maxlength: 200, onInput: (e) => { c.text = e.target.value; } }) : null;
      return h('fieldset', { class: 'section', 'data-county-column': String(i) }, h('legend', {}, `Column ${i + 1}`),
        h('div', { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', { for: `county-col-${i}` }, 'Heading in the county template'), labelI),
          h('div', { class: 'field' }, h('label', { for: `county-src-${i}` }, 'Filled with'), srcI),
          textI ? h('div', { class: 'field' }, h('label', { for: `county-text-${i}` }, 'Text'), textI) : null),
        h('div', { class: 'row' },
          i > 0 ? h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }, `Move column ${i + 1} up`) : null,
          h('button', { class: 'btn sm ghost', type: 'button', onClick: () => { rows.splice(i, 1); draw(); } }, `Remove column ${i + 1}`)));
    }));
  };
  draw();
  const save = async (county) => {
    err.classList.add('hidden');
    try { await put('/api/reports/settlement-layout', { county }); m.close(); toast(county ? 'County template saved' : 'County template removed', 'ok'); }
    catch (e) { err.textContent = e.message; err.classList.remove('hidden'); err.focus(); }
  };
  const m = modal('County settlement template', h('div', { 'data-county-template-form': '1' },
    h('p', { class: 'small muted' }, 'Match your county\'s subrecipient report without code: name it, then give each of its columns in order, and say what SUDS fills it with. Columns SUDS cannot fill are left blank for you to write. Check the result against the county\'s current template.'),
    err,
    h('div', { class: 'field' }, h('label', { for: 'county-template-name' }, 'Template name *'), nameI),
    d.fund_types ? h('div', { class: 'field' }, h('label', { for: 'county-template-rows' }, 'Rows'), rowsI,
      h('div', { class: 'help', id: 'county-template-rows-help' }, 'Settlement activities for an opioid settlement report; one row per fund of a type for another county template, such as a block grant (SABG) report. The settlement-only columns are then left blank.')) : null,
    list,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onClick: () => { rows.push({ label: '', source: 'blank' }); draw(); list.lastElementChild?.querySelector('input')?.focus(); } }, '+ Add a column'),
      d.county ? h('button', { class: 'btn ghost', type: 'button', onClick: () => save(null) }, 'Remove the template') : null,
      h('button', { class: 'btn primary', type: 'button', 'data-county-template-save': '1', onClick: () => save({ name: nameI.value, columns: rows, fund_type: rowsI.value || null }) }, 'Save template'))), { wide: true });
}
