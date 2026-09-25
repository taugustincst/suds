import { h, route, get, state, fmt, can, pageHead, bars, stat, table, downloadCsv, nav, sparkline, form, modal, toast } from '../app.js';
import { withRestrictionCheck } from './part2.js';

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

route('reports', async (r) => {
  const to = r.query.get('to') || fmt.today(); const from = r.query.get('from') || new Date(Date.parse(to) - 89 * 86400000).toISOString().slice(0, 10);
  const months = Number(r.query.get('months') || 12);
  const seesEpisodes = can('episodes:read') || can('episodes:write');
  const [d, m, eps, oc] = await Promise.all([get(`/api/reports/dashboard?from=${from}&to=${to}`), get(`/api/reports/monthly?months=${months}`),
    seesEpisodes ? get(`/api/episodes?from=${from}&to=${to}&status=all&limit=500`).catch(() => null) : null,
    get(`/api/reports/outcomes?from=${from}&to=${to}`).catch(() => null)]);
  // Outcome measures (PHQ-9, GAD-7, AUDIT-C, DAST-10, wellbeing): each client's first score in the period
  // against their last. Aggregate only; the export is one de-identified row per client and measure.
  const outcomesCard = () => h('div', { class: 'card mb', 'data-outcomes-report': '1' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Outcome measures'), can('export:read') ? h('button', { class: 'btn sm', 'data-export-outcomes': '1', onClick: () => downloadCsv(`/api/reports/outcomes/export?from=${from}&to=${to}`) }, 'Export (de-identified CSV)') : null),
    h('p', { class: 'small muted' }, 'Baseline is each client\'s first administration in the period and latest their last; only clients screened at least twice count toward change. Improved means the score moved in the better direction (lower for PHQ-9, GAD-7, AUDIT-C and DAST-10; higher for wellbeing).'),
    table([{ label: 'Measure', key: 'name' }, { label: 'Clients screened', key: 'clients_screened', num: true }, { label: 'Screened twice or more', key: 'clients_with_followup', num: true },
      { label: 'Mean baseline', render: x => x.mean_baseline ?? '—', num: true }, { label: 'Mean latest', render: x => x.mean_latest ?? '—', num: true }, { label: 'Mean change', render: x => x.mean_change ?? '—', num: true },
      { label: 'Improved', render: x => (x.pct_improved === null ? '—' : `${x.improved} (${x.pct_improved}%)`), num: true }, { label: 'Worse', key: 'worse', num: true }, { label: 'Unchanged', key: 'unchanged', num: true },
      { label: 'Positive at baseline → latest', render: x => (x.clients_with_followup ? `${x.positive_at_baseline} → ${x.positive_at_latest}` : '—') }, { label: 'PHQ-9 safety alerts', render: x => (x.instrument === 'phq9' ? String(x.safety_flags) : '') }],
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
    return table([{ label: 'Month', key: 'month' }, { label: 'Intakes', key: 'intakes', num: true }, { label: 'Discharges', key: 'discharges', num: true }, { label: 'Interventions', key: 'interventions', num: true }, { label: 'Clients served', key: 'served', num: true }, { label: 'Service hrs', render: x => (x.minutes / 60).toFixed(1), num: true }, { label: 'Calls', key: 'calls', num: true }, { label: 'Referrals', key: 'referrals', num: true }, { label: 'Admitted', key: 'successful', num: true }, { label: 'MAT linkages', key: 'mat', num: true }, { label: 'Naloxone kits', key: 'kits', num: true }, { label: 'Staff hrs', render: x => (x.staff / 60).toFixed(1), num: true }, can('budget:read') ? { label: 'Spend', render: x => fmt.money(x.spend), num: true } : null].filter(Boolean),
      keys.map(k => ({ month: k, intakes: find(m.intakes, k), discharges: find(m.discharges, k), interventions: find(m.interventions, k), served: find(m.interventions, k, 'clients'), minutes: find(m.interventions, k, 'minutes'), calls: find(m.calls, k), referrals: find(m.referrals, k), successful: find(m.referrals, k, 'successful'), mat: find(m.mat_linkage, k), kits: find(m.naloxone, k, 'kits'), staff: find(m.time, k, 'minutes'), spend: find(m.spend, k, 'amount') })), { empty: 'No data for this period.' });
  };
  const exportRow = (kind, label) => h('span', { class: 'row', style: { gap: '.15rem', marginRight: '.5rem' } }, h('button', { class: 'btn sm', onClick: () => downloadCsv(`/api/reports/export/${kind}?from=${from}&to=${to}&format=xlsx`) }, `${label} (Excel)`), h('button', { class: 'btn sm ghost', onClick: () => downloadCsv(`/api/reports/export/${kind}?from=${from}&to=${to}`) }, 'CSV'));
  return h('div', {},
    pageHead('Reports', h('button', { class: 'btn', onClick: () => window.print() }, 'Print')),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('button', { class: 'btn', onClick: () => nav(`reports?from=${fromI.value}&to=${toI.value}&months=${months}`) }, 'Apply'), h('button', { class: 'btn ghost sm', onClick: () => nav(`reports?from=${to.slice(0, 4)}-01-01&to=${to}`) }, 'Year to date'), h('button', { class: 'btn ghost sm', onClick: () => nav(`reports?from=${to.slice(0, 8)}01&to=${to}`) }, 'This month')),
    h('h2', {}, `Program summary · ${fmt.date(from)} – ${fmt.date(to)}`),
    h('div', { class: 'grid cols-4 mb' }, stat('Active clients', d.clients.active, '', 'clients?status=active'), stat('New intakes', d.clients.new_in_range, '', 'clients?status=all'), stat('Interventions', d.interventions.total, '', `interventions?from=${from}&to=${to}`), stat('Service hours', (d.interventions.minutes / 60).toFixed(1), '', `time?from=${from}&to=${to}`), stat('Calls', d.calls.total - (d.calls.texts || 0), '', 'calls?method=phone'), stat('Text messages', d.calls.texts || 0, '', 'calls?method=text'), stat('Crisis contacts', d.calls.crisis, d.calls.crisis ? 'danger' : ''), stat('Referrals', d.referrals.total), stat('Median days to admit', d.referrals.median_days_to_admit === null ? '—' : d.referrals.median_days_to_admit.toFixed(1)), stat('Naloxone kits', d.interventions.naloxone_kits), stat('Fentanyl strips', d.interventions.fentanyl_strips), stat('No contact 30d', d.clients.no_contact_30d, d.clients.no_contact_30d ? 'warn' : ''), d.budget ? stat('Spend', fmt.money(d.budget.spent)) : null),
    h('div', { class: 'grid cols-2 mb' },
      h('div', { class: 'card' }, h('h2', {}, 'Interventions by type'), bars(d.interventions.by_type, { list: 'INTERVENTION_TYPES', link: x => `interventions?type=${x.k}&from=${from}&to=${to}` })), h('div', { class: 'card' }, h('h2', {}, 'Interventions by worker'), bars(d.interventions.by_worker)),
      h('div', { class: 'card' }, h('h2', {}, 'Referral outcomes by category'), table([{ label: 'Category', render: x => fmt.label(x.k) }, { label: 'Referred', key: 'n', num: true }, { label: 'Admitted', key: 'successful', num: true }, { label: 'Rate', render: x => x.n ? `${Math.round(100 * x.successful / x.n)}%` : '—', num: true }], d.referrals.by_category, { wrap: false })),
      h('div', { class: 'card' }, h('h2', {}, 'Clients by status'), bars(d.clients.by_status, { labelKey: 'status', link: x => `clients?status=${x.status}` })), h('div', { class: 'card' }, h('h2', {}, 'Primary substance (active)'), bars(d.clients.by_substance, { list: 'SUBSTANCES', link: x => `clients?status=active&substance=${x.k}` })), h('div', { class: 'card' }, h('h2', {}, 'MAT status'), bars(d.clients.mat, { link: x => `clients?status=active&mat=${x.k}` })),
      d.time ? h('div', { class: 'card' }, h('h2', {}, 'Staff time by category'), bars(d.time.by_category, { list: 'TIME_CATEGORIES', format: fmt.mins })) : null, h('div', { class: 'card' }, h('h2', {}, 'Calls and texts by outcome'), bars(d.calls.by_outcome, { list: ['CALL_OUTCOMES', 'TEXT_OUTCOMES'], link: () => 'calls' })), h('div', { class: 'card' }, h('h2', {}, 'Weekly interventions'), sparkline(d.interventions.by_week.map(w => w.n)))),
    eps ? episodesCard() : null,
    oc ? outcomesCard() : null,
    // CalOMS Tx and the county EHR hand-off have their own page: they are submissions, not summaries.
    seesEpisodes || can('export:identified') ? h('div', { class: 'card mb', 'data-state-reporting-link': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'State reporting & county EHR hand-off'), h('a', { class: 'btn sm primary', href: '#/caloms' }, 'Open')),
      h('p', { class: 'small muted' }, 'CalOMS Tx admission, discharge and annual update records: the validation report and the extract for DHCS. And the encounter hand-off for the county EHR — SUDS does not submit Drug Medi-Cal claims.')) : null,
    // California harm-reduction reporting (docs/compliance/HARM-REDUCTION-REPORTING.md): the Naloxone
    // Distribution Project log and the opioid settlement expenditure report, for the range above.
    can('export:read') ? h('div', { class: 'card mb', 'data-harm-reduction-reports': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'Harm-reduction reporting')),
      h('p', { class: 'small muted' }, 'For the range above. Aggregate counts and amounts only: no names or client codes.'),
      h('div', { class: 'row mb' }, h('span', {}, h('b', {}, 'Naloxone distribution & reversal log (NDP-style)'), h('span', { class: 'small muted' }, ' — kits and doses by day, site and recipient type; reversals reported. Check the columns against the current NDP reporting template before submitting.')),
        h('button', { class: 'btn sm', 'data-ndp-export': 'xlsx', onClick: () => downloadCsv(`/api/reports/naloxone-ndp/export?from=${from}&to=${to}&format=xlsx`) }, 'NDP log (Excel)'), h('button', { class: 'btn sm ghost', 'data-ndp-export': 'csv', onClick: () => downloadCsv(`/api/reports/naloxone-ndp/export?from=${from}&to=${to}`) }, 'CSV')),
      can('budget:read') ? h('div', { class: 'row' }, h('span', {}, h('b', {}, 'Opioid settlement expenditures'), h('span', { class: 'small muted' }, ' — spending from settlement funds by allowable use (Exhibit E) and California High Impact Abatement Activity. Categories need verification against each fund\'s agreement.')),
        h('button', { class: 'btn sm', 'data-settlement-export': 'xlsx', onClick: () => downloadCsv(`/api/reports/opioid-settlement/export?from=${from}&to=${to}&format=xlsx`) }, 'Settlement report (Excel)'), h('button', { class: 'btn sm ghost', 'data-settlement-export': 'csv', onClick: () => downloadCsv(`/api/reports/opioid-settlement/export?from=${from}&to=${to}`) }, 'CSV')) : null) : null,
    h('div', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h2', {}, `Monthly trend (last ${months} months)`), h('div', { class: 'row' }, [6, 12, 24].map(n => h('button', { class: `btn sm ${n === months ? 'primary' : ''}`, onClick: () => nav(`reports?from=${from}&to=${to}&months=${n}`) }, `${n}m`)))), monthTable()),
    can('export:read') ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Export to Excel or CSV'), h('button', { class: 'btn primary', onClick: () => downloadCsv(`/api/reports/export/workbook?from=${from}&to=${to}`) }, 'Everything as one Excel workbook')),
      h('p', { class: 'small muted' }, 'De-identified exports carry only the columns a de-identified file may hold: no names or free text, dates reduced to the year, and a random record id in place of the client code, new with every file. The range above chooses the rows (clients, resources and to-dos are complete lists).'),
      h('div', { class: 'row' }, exportRow('clients', 'Clients'), exportRow('interventions', 'Visits & services'), exportRow('calls', 'Calls'), exportRow('referrals', 'Referrals'), exportRow('time', 'Time'), exportRow('tasks', 'To-dos'), exportRow('resources', 'Resources'), exportRow('consents', 'Consents'), exportRow('episodes', 'Episodes'), exportRow('overdose_events', 'Overdose events'), exportRow('forms', 'Client forms'), exportRow('disclosures', 'Disclosures'), can('budget:read') ? [exportRow('expenditures', 'Expenditures'), exportRow('funds', 'Funding'), exportRow('budget_lines', 'Budget lines')] : null),
      can('export:identified') ? h('div', { class: 'mt' }, h('button', { class: 'btn sm danger', 'data-identified-export': '1', onClick: () => openIdentifiedExport(from, to) }, 'Identified Excel workbook (names included, audited)')) : null) : null);
});
