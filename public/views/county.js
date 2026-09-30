import { h, route, get, post, put, fmt, can, pageHead, pageTabs, table, kv, nav, toast, undoToast, modal, form, confirmDialog, emptyState, badge, loadingFor, announce, state } from '../app.js';
import { fetchDownload } from './reports.js';
import { presets, lastCompleteQuarter, monthsLabel, describe } from '../county-periods.js';
// The county connection's Connection tokens card (views/countyconnect.js; built for 1.18.0), under the programmes.
import { programmeConnections } from './countyconnect.js';

// The county view (server/county.js, server/routes/county.js; docs/COUNTY-VIEW.md). For a county that runs SUDS
// and funds programs that do too: each program sends the county a signed file of its settlement figures
// (Settlement outcomes › Send to the county); here the county registers each program's key, imports the files
// and sees them side by side and summed for a period, or by quarter. Exact aggregate figures for authorised county
// staff; never a client of any program, and nothing here is for publication.
//   #/county                   the combined view for a period (county:view); &by=quarter for the trend
//   #/county?tab=submissions   import a file, and every file received (import, withdraw, reinstate: county:manage)
//   #/county?tab=programmes    the programs whose files are accepted, their keys, and this county's code
//   #/county?tab=publish       publication releases of the combined figures (built for 1.21.0, not yet released;
//                              server/county-publication.js): prepare, review and publish (county:manage), the releases
//                              published and withdrawn (county:view), their files (export:read)
// Figures the county enters for a program not on SUDS (released in 1.20.0; server/county-entry.js): "Add a program not
// on SUDS", "Enter figures" and "Import a CSV" on Programs; everywhere they appear they are marked "entered by the
// county — not signed by the program", and the combined view can leave them out (&entered=exclude).
loadingFor('county', () => 'Adding up the programs\' submissions…');

const money = (n) => (typeof n === 'number' ? fmt.money(n) : '—');
const num = (n) => (typeof n === 'number' ? fmt.num(n) : '—');
const STATUS = { whole: ['Whole period', 'ok'], part: ['Part of the period', 'warn'], none: ['Not submitted', 'danger'] };
const statusBadge = (s) => badge(STATUS[s][0], STATUS[s][1]);
const periodText = (s) => `${fmt.date(s.period_from)} – ${fmt.date(s.period_to)}`;
const ENTERED_WORDS = 'entered by the county — not signed by the program';
const isEnteredSource = (src) => src === 'county_entered' || src === 'mixed';
/** Where a program's or a file's figures came from, in words a person reads (the marker the view and its files carry). */
function sourceTag(src) {
  if (src === 'county_entered') return h('span', { 'data-cv-source': 'county_entered' }, badge('Entered by the county', 'warn'), h('span', { class: 'small' }, ' — not signed by the program'));
  if (src === 'mixed') return h('span', { 'data-cv-source': 'mixed' }, badge('Signed files', 'ok'), h('span', { class: 'small' }, ' and figures entered by the county — not signed by the program'));
  if (src === 'signed') return h('span', { 'data-cv-source': 'signed' }, badge('Signed by the program', 'ok'));
  return '—';
}
const HELP = {
  exhibitE: 'Exhibit E is the list of opioid remediation uses the national settlement agreements allow; each fund records the one it pays for.',
  hiaa: 'High Impact Abatement Activities are the uses California asks settlement money to put first; each fund may record the one it pays for.',
  fingerprint: 'A fingerprint is a short code worked out from a key: when the one the program reads out matches the one shown here, the key is theirs.',
};
/** Short column names for a phone: each program's first word, or its initials where two would look the same. */
function shortNames(progs) {
  const first = (n) => { const w = n.split(/\s+/)[0]; return w.length > 14 ? `${w.slice(0, 13)}…` : w; };
  const initials = (n) => n.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 5);
  const firsts = progs.map(p => first(p.name));
  return Object.fromEntries(progs.map((p, i) => [p.id, firsts.filter(x => x === firsts[i]).length > 1 ? initials(p.name) : firsts[i]]));
}
/** A copy button for a value (a key, a fingerprint, the county code); says what happened. */
function copyButton(value, what, attrs = {}) {
  return h('button', { class: 'btn sm', type: 'button', ...attrs, onClick: async () => {
    try { await navigator.clipboard.writeText(value); toast(`${what} copied.`, 'ok'); } catch { toast(`Could not copy: select the ${what.toLowerCase()} and copy it yourself.`, 'error'); }
  } }, `Copy ${what.toLowerCase()}`);
}

route('county', async (r) => {
  const tab = ['submissions', 'programmes', 'publish'].includes(r.query.get('tab')) ? r.query.get('tab') : 'view';
  const tabs = pageTabs([['view', 'Combined view'], ['submissions', 'Submissions'], ['programmes', 'Programs'], ['publish', 'Publish']], tab,
    (k) => nav(k === 'view' ? 'county' : `county?tab=${k}`), { label: 'County view sections', wrap: true });
  const intro = h('p', { class: 'small', 'data-county-intro': '1' }, `The settlement spending and outcomes the programs the county funds send it, each as a file its own SUDS signed, and the figures the county's staff enter for a program not on SUDS, marked "${ENTERED_WORDS}". Exact aggregate figures for authorised county staff: no client of any program is ever in them, and nothing here is for publication.`);
  const body = tab === 'programmes' ? await programmesTab() : tab === 'submissions' ? await submissionsTab(r) : tab === 'publish' ? await publishTab() : await viewTab(r);
  return h('div', { 'data-county': tab }, pageHead('County view'), tabs, intro, body);
});

// ---- the combined view ----
function caveatsCard(d) {
  // The one-line summary is always on screen; the caveats in full are one tap away (U13: a phone shows the figures
  // without scrolling past three paragraphs first).
  return h('section', { class: 'card mb', 'aria-labelledby': 'cv-caveats-h', 'data-cv-caveats': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cv-caveats-h' }, 'Read this first')),
    h('p', { class: 'small', 'data-cv-caveat-summary': '1' }, d.caveat_summary),
    h('details', { class: 'small', 'data-cv-caveats-full': '1' }, h('summary', {}, 'The caveats in full'),
      h('ul', {}, d.caveats.map(c => h('li', {}, c))),
      h('p', { 'data-cv-publication': '1' }, h('b', {}, 'Not for publication. '), d.publication_note),
      h('p', { class: 'muted' }, d.rule)));
}
async function viewTab(r) {
  const today = fmt.today(); const lq = lastCompleteQuarter(today);
  const from = r.query.get('from') || lq.from; const to = r.query.get('to') || lq.to;
  const by = r.query.get('by') === 'quarter' ? 'quarter' : '';
  const excluded = r.query.get('entered') === 'exclude';
  const fromI = h('input', { type: 'date', value: from, id: 'cv-from', name: 'from', 'aria-describedby': 'cv-range-err' });
  const toI = h('input', { type: 'date', value: to, id: 'cv-to', name: 'to', 'aria-describedby': 'cv-range-err' });
  const P = presets(today);
  const preset = h('select', { id: 'cv-preset', 'data-cv-preset': '1', 'aria-describedby': 'cv-preset-help' }, h('option', { value: '' }, 'Choose a period…'),
    P.map(p => h('option', { value: p.key, selected: p.from === from && p.to === to }, p.label)));
  preset.addEventListener('change', () => { const p = P.find(x => x.key === preset.value); if (p) { fromI.value = p.from; toI.value = p.to; } });
  const mode = h('select', { id: 'cv-mode', 'data-cv-mode': '1' }, h('option', { value: '', selected: !by }, 'The whole period'), h('option', { value: 'quarter', selected: by === 'quarter' }, 'By quarter'));
  // Figures the county entered are counted by default; this leaves them out of this view and its files.
  const enteredI = h('input', { type: 'checkbox', id: 'cv-entered', name: 'entered', checked: excluded, 'data-cv-entered-toggle': '1', 'aria-describedby': 'cv-entered-help' });
  const enteredField = h('div', { class: 'field', 'data-cv-entered-field': '1' }, h('label', { class: 'check', for: 'cv-entered' }, enteredI, 'Leave out figures entered by the county'),
    h('div', { class: 'help', id: 'cv-entered-help' }, 'Counts only the files programs signed.'));
  const rangeErr = h('div', { class: 'err', id: 'cv-range-err', role: 'alert', style: { flexBasis: '100%' } });
  const problem = (f, t) => (!f || !t ? 'Choose a start and an end date.' : f > t ? `The start date (${fmt.date(f)}) is after the end date (${fmt.date(t)}). Choose a start date on or before the end date.` : '');
  const showErr = (msg) => { rangeErr.textContent = msg; for (const i of [fromI, toI]) { if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); } };
  // A form, so Enter in a date applies it (U12); choosing a preset fills the dates and waits for Apply.
  const controls = h('form', { class: 'filters', 'data-cv-form': '1', noValidate: true, onSubmit: (e) => {
    e.preventDefault();
    const msg = problem(fromI.value, toI.value);
    if (msg) { showErr(msg); fromI.focus(); return; }
    nav(`county?from=${fromI.value}&to=${toI.value}${mode.value ? `&by=${mode.value}` : ''}${enteredI.checked ? '&entered=exclude' : ''}`);
  } },
  h('div', { class: 'field' }, h('label', { for: 'cv-preset' }, 'Period'), preset, h('div', { class: 'help', id: 'cv-preset-help' }, 'Fiscal years run July to June; FY Q1 is July to September.')),
  h('div', { class: 'field' }, h('label', { for: 'cv-from' }, 'From'), fromI), h('div', { class: 'field' }, h('label', { for: 'cv-to' }, 'To'), toI),
  h('div', { class: 'field' }, h('label', { for: 'cv-mode' }, 'Show'), mode),
  enteredField,
  h('button', { class: 'btn primary', type: 'submit', 'data-cv-apply': '1' }, 'Apply'),
  rangeErr);
  if (problem(from, to)) { showErr(problem(from, to)); return h('div', {}, controls); }
  const qs = `from=${from}&to=${to}${excluded ? '&entered=exclude' : ''}`;
  const d = await get(`/api/county/view?${qs}${by ? '&by=quarter' : ''}`);
  // The toggle is offered once the county has entered figures for anyone (or while they are left out).
  if (!d.has_entered && !excluded) enteredField.remove();
  const download = (format) => fetchDownload(`/api/county/view/export?${qs}${format ? `&format=${format}` : ''}`)
    .then(() => toast('Downloaded. Internal, exact counts: for authorised county staff, not for publication.', 'ok')).catch(e => toast(e.message, 'error'));
  const actions = can('export:read') ? h('div', { class: 'row mb', 'data-cv-actions': '1' }, h('button', { class: 'btn primary', 'data-cv-export': 'xlsx', onClick: () => download('xlsx') }, 'Download (Excel, internal)'),
    h('button', { class: 'btn', 'data-cv-export': 'csv', onClick: () => download('') }, 'CSV (internal)'),
    h('button', { class: 'btn', 'data-cv-export': 'tidy', onClick: () => download('tidy') }, 'Long CSV, one row per figure (internal)')) : null;
  const what = describe(from, to);
  const periodLine = h('p', { class: 'small', 'data-cv-period': '1' }, h('b', {}, `${fmt.date(from)} – ${fmt.date(to)}`), what ? ` (${what})` : '');
  const enteredLine = excluded ? h('p', { class: 'banner info', role: 'status', 'data-cv-entered-excluded': '1' }, `Figures entered by the county are left out: only files the programs signed are counted${d.entered_left_out && d.entered_left_out.length ? ` (left out: ${d.entered_left_out.map(p => p.name).join(', ')})` : ''}.`) : null;
  if (by === 'quarter') return h('div', {}, controls, periodLine, caveatsCard(d), enteredLine, actions, quarterView(d));
  if (!d.programmes.length && !d.inactive_left_out.length) {
    return h('div', {}, controls, periodLine, caveatsCard(d), emptyState('No programs registered', 'Register each program the county funds, with the public key it gives you, under Programs. Then import the files they send under Submissions.',
      can('county:manage') ? h('a', { class: 'btn primary', href: '#/county?tab=programmes' }, 'Register a program') : null));
  }
  const shorts = shortNames(d.programmes);
  const who = h('section', { class: 'card mb', 'aria-labelledby': 'cv-who-h', 'data-cv-who': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cv-who-h' }, `Who has submitted for ${fmt.date(from)} – ${fmt.date(to)}`)),
    h('p', { 'data-cv-headline': '1' }, h('b', {}, d.headline)),
    d.entered_programmes ? h('p', { class: 'small', 'data-cv-entered-note': '1' }, d.entered_note) : null,
    d.inactive_left_out.length ? h('p', { class: 'small', 'data-cv-inactive': '1' }, `Left out: ${d.inactive_left_out.map(p => p.name).join(', ')} (inactive; the county chose not to keep counting ${d.inactive_left_out.length === 1 ? 'its' : 'their'} files).`) : null,
    table([{ label: 'Program', render: p => p.name }, { label: 'For this period', render: p => statusBadge(p.status) }, { label: 'Source', render: p => sourceTag(p.source) },
      { label: 'Files counted', render: p => (p.submissions.length ? p.submissions.map(s => h('div', {}, `${periodText(s)} · received ${fmt.date(s.received_at)}`)) : '—') },
      { label: 'Left out', render: p => (p.left_out.length ? p.left_out.map(s => h('div', { class: 'small', 'data-cv-left-out': s.why }, `${periodText(s)}${s.source === 'county_entered' ? ' (entered by the county)' : ''}: ${s.reason}`)) : '—') }], d.programmes, { empty: 'No programs.' }));
  const figure = (x, v) => (x.money ? money(v) : num(v));
  // A program with nothing for the period has no figure: "—" and the words, never a greyed 0 alone (M6).
  // A program's figures the county entered carry "(entered)" in every cell, and its column says what that means.
  const marks = (p) => [p.status === 'part' ? 'part' : null, isEnteredSource(p.source) ? 'entered' : null].filter(Boolean);
  const progCell = (p) => (x) => (x.by[p.id] === null ? h('span', { class: 'muted', 'data-cv-none': '1' }, '— ', h('span', { class: 'small' }, 'not submitted'))
    : marks(p).length ? h('span', {}, figure(x, x.by[p.id]), h('span', { class: 'small muted', 'data-cv-cell-entered': isEnteredSource(p.source) ? '1' : null }, ` (${marks(p).join(', ')})`)) : figure(x, x.by[p.id]));
  const progHead = (p) => (isEnteredSource(p.source) ? h('span', {}, p.name, h('span', { class: 'small muted', 'data-cv-entered-mark': p.id }, p.source === 'mixed' ? ` (some figures ${ENTERED_WORDS})` : ` (${ENTERED_WORDS})`)) : p.name);
  // The entered part goes on a line of its own under the total, and wraps: at phone width it is never one long line.
  const enteredPart = (x, v, attr) => h('div', { class: 'small muted', [attr]: '1', style: { whiteSpace: 'normal' } }, `(incl. ${figure(x, v)} entered by the county)`);
  const totalCell = (x) => h('span', {}, h('b', {}, figure(x, x.total)), x.total_entered ? enteredPart(x, x.total_entered, 'data-cv-total-entered') : null);
  // A column heading with a marker is an element, and an element can be in one table only: each table gets its own.
  const cols = () => [{ label: 'Measure', render: x => x.label },
    ...d.programmes.map(p => ({ label: progHead(p), cardLabel: isEnteredSource(p.source) ? `${shorts[p.id]} (entered)` : shorts[p.id], num: true, render: progCell(p) })),
    { label: `Total (${d.whole} of ${d.of} programs complete)`, cardLabel: 'Total', num: true, render: totalCell }];
  const group = (g, title, id, note) => {
    const rows = d.rows.filter(x => x.group === g);
    return h('section', { class: 'card mb', 'aria-labelledby': id, 'data-cv-group': g },
      h('div', { class: 'card-head' }, h('h2', { id }, title)), note ? h('p', { class: 'small muted' }, note) : null,
      table(cols(), rows, { empty: 'Nothing recorded for this period.' }));
  };
  return h('div', {}, controls, periodLine, caveatsCard(d), enteredLine, actions, who,
    group('spending', 'Spending from settlement funds', 'cv-spend-h'),
    group('use', 'Spent by allowable use (Exhibit E)', 'cv-use-h', `${HELP.exhibitE} Each fund's spending under its own category.`),
    group('hiaa', 'Spent by High Impact Abatement Activity', 'cv-hiaa-h', `${HELP.hiaa} Everything the funds marked with each activity spent (approved or reimbursed).`),
    group('outcome', 'Outcomes', 'cv-outcome-h', 'Counts of people are each program\'s own count, added up: a person served by two programs counts twice.'));
}
/** By quarter (M5): the measures down the side, the quarters across (their totals); each quarter's programs behind a disclosure. */
function quarterView(d) {
  if (d.too_many) return h('div', { class: 'banner info', role: 'status', 'data-cv-quarters-too-many': '1' }, `That is more than ${d.max_quarters} quarters. Choose a shorter period to see it by quarter.`);
  if (!d.quarters.length) return h('div', { class: 'banner info', role: 'status', 'data-cv-no-quarters': '1' }, 'No whole quarter lies inside this period. Choose a period that starts on the first day of a quarter (January, April, July or October 1) and ends on the last day of one.');
  const figure = (x, v) => (x.money ? money(v) : num(v));
  const qLabel = (q) => monthsLabel(q.from, q.to);
  const qCell = (i) => (x) => h('span', {}, figure(x, x.by_quarter[i]), x.by_quarter_entered && x.by_quarter_entered[i] ? h('div', { class: 'small muted', 'data-cq-entered': '1', style: { whiteSpace: 'normal' } }, `(incl. ${figure(x, x.by_quarter_entered[i])} entered by the county)`) : null);
  const cols = [{ label: 'Measure', render: x => x.label },
    ...d.quarters.map((q, i) => ({ label: `${qLabel(q)} (${q.whole} of ${q.of} complete${q.entered_programmes ? `; ${q.entered_programmes} entered by the county` : ''})`, cardLabel: qLabel(q), num: true, render: qCell(i) }))];
  const section = (g, title, id) => { const rows = d.rows.filter(x => x.group === g); return rows.length ? h('section', { class: 'card mb', 'aria-labelledby': id, 'data-cv-quarter-group': g }, h('div', { class: 'card-head' }, h('h2', { id }, title)), table(cols, rows)) : null; };
  const perQuarter = h('details', { class: 'card mb', 'data-cv-per-program': '1' }, h('summary', {}, h('h2', { class: 'summary-heading' }, 'Each program\'s figures, quarter by quarter')),
    d.quarters.map((q, qi) => {
      const shorts = shortNames(q.programmes);
      const pc = [{ label: 'Measure', render: x => x.label }, ...q.programmes.map(p => ({ label: isEnteredSource(p.source) ? `${p.name} (${ENTERED_WORDS})` : p.name, cardLabel: isEnteredSource(p.source) ? `${shorts[p.id]} (entered)` : shorts[p.id], num: true,
        render: x => (x.by[p.id] === null ? h('span', { class: 'muted' }, '— ', h('span', { class: 'small' }, 'not submitted')) : isEnteredSource(p.source) ? h('span', {}, figure(x, x.by[p.id]), h('span', { class: 'small muted' }, ' (entered)')) : figure(x, x.by[p.id])) })),
        { label: `Total (${q.whole} of ${q.of} programs complete)`, cardLabel: 'Total', num: true, render: x => h('b', {}, figure(x, x.total)) }];
      return h('div', { 'data-cv-quarter': qi }, h('h3', {}, qLabel(q)), h('p', { class: 'small' }, q.headline), table(pc, q.rows));
    }));
  return h('div', { 'data-cv-by-quarter': '1' },
    d.days_outside_quarters ? h('p', { class: 'small', 'data-cv-outside-quarters': '1' }, `${d.days_outside_quarters} day${d.days_outside_quarters === 1 ? '' : 's'} of the period ${d.days_outside_quarters === 1 ? 'is' : 'are'} not in a whole quarter and ${d.days_outside_quarters === 1 ? 'is' : 'are'} not shown here.`) : null,
    h('p', { class: 'small muted' }, 'Each quarter is combined on its own, by the same rule as the whole-period view: a file counts in a quarter only when its whole period lies inside that quarter.'),
    d.quarters.some(q => q.entered_programmes) ? h('p', { class: 'small', 'data-cq-entered-note': '1' }, d.entered_note) : null,
    section('spending', 'Spending from settlement funds, by quarter', 'cq-spend-h'),
    section('use', 'Spent by allowable use (Exhibit E), by quarter', 'cq-use-h'),
    section('hiaa', 'Spent by High Impact Abatement Activity, by quarter', 'cq-hiaa-h'),
    section('outcome', 'Outcomes, by quarter', 'cq-outcome-h'),
    perQuarter);
}

// ---- publication releases of the combined figures (built for 1.21.0, not yet released) ----
const PUB_STATUS = { published: ['Published', 'ok'], withdrawn: ['Withdrawn: do not use', 'danger'] };
const PUB_GROUPS = { spending: 'Spending from settlement funds', use: 'Spent by allowable use (Exhibit E)', hiaa: 'Spent by High Impact Abatement Activity', outcome: 'Outcomes' };
/** A published figure as shown: a number, or the symbol it is published as, in words (never colour alone). */
const shownValue = (x) => (typeof x.value === 'number' ? (x.money ? money(x.value) : num(x.value)) : String(x.value));
const SCREEN_NOTE = { small: 'Small', complementary: 'Suppressed: protects a program\'s small figure', withheld: 'Withheld' };
const pubPeriod = (x) => `${fmt.date(x.period_from)} – ${fmt.date(x.period_to)}`;
/** What a release would publish (or did): its programs, its figures by section, what was hidden and why, its notes. */
function releaseBody(c) {
  const entered = c.figures_entered_by_the_county;
  const sections = Object.keys(PUB_GROUPS).map(g => [g, c.rows.filter(x => x.group === g)]).filter(([, rows]) => rows.length);
  return h('div', { 'data-pub-release': '1' },
    h('h3', {}, `Programs (${c.programmes.length})`),
    h('ul', { 'data-pub-programmes': '1' }, c.programmes.map(p => h('li', {}, p.name, p.coverage === 'part' ? ' (part of the period)' : '',
      p.source === 'county_entered' || p.source === 'mixed' ? h('span', { class: 'small', 'data-pub-entered': '1' }, p.source === 'mixed' ? ` — some figures ${ENTERED_WORDS}` : ` — ${ENTERED_WORDS}`) : null))),
    !entered.counted ? h('p', { class: 'small', 'data-pub-entered-left-out': '1' }, `Figures entered by the county are left out${entered.left_out.length ? ` (${entered.left_out.join(', ')})` : ''}.`) : null,
    sections.map(([g, rows]) => h('div', { 'data-pub-group': g }, h('h3', {}, PUB_GROUPS[g]),
      table([{ label: 'Measure', render: x => x.label }, { label: 'County total', cardLabel: 'Total', num: true, render: x => h('span', { 'data-pub-value': x.key }, shownValue(x)) },
        { label: 'Screened', render: x => (x.suppressed ? h('span', { 'data-pub-suppressed': x.key }, badge(SCREEN_NOTE[x.suppressed], 'warn')) : x.screened ? 'Shown' : 'Exact') }], rows))),
    h('h3', {}, 'Suppressed or withheld, and why'),
    c.suppressed.length || c.withheld.length
      ? h('ul', { 'data-pub-why': '1' }, [...c.suppressed.map(x => h('li', {}, h('b', {}, `${x.label}: `), x.why)), ...c.withheld.map(x => h('li', {}, h('b', {}, `${x.key}: `), x.why))])
      : h('p', { class: 'small', 'data-pub-why': 'none' }, 'Nothing was suppressed or withheld.'),
    h('details', { class: 'small', 'data-pub-notes': '1' }, h('summary', {}, 'Notes and method'), h('ul', {}, c.notes.map(n => h('li', {}, n))),
      h('p', {}, `${c.method.name}. Threshold ${c.method.threshold}. Differencing: ${c.method.differencing}.`)));
}
async function publishTab() {
  const manage = can('county:manage');
  const listHeading = h('h2', { id: 'cpub-list-h', tabindex: '-1' }, 'Releases published');
  const list = h('div', { 'data-pub-rows': '1' });
  const download = (x, format) => fetchDownload(`/api/county/publications/${x.id}/export${format ? `?format=${format}` : ''}`)
    .then(() => toast(x.status === 'withdrawn' ? 'Downloaded. This release is withdrawn: do not use it.' : 'Downloaded. A publication release, screened for small cells.', 'ok')).catch(e => toast(e.message, 'error'));
  const openRelease = async (x) => {
    const rec = await get(`/api/county/publications/${x.id}`);
    modal(`Release for ${pubPeriod(rec)}`, h('div', { 'data-pub-view': rec.id },
      rec.status === 'withdrawn' ? h('p', { class: 'banner danger', 'data-pub-withdrawn': '1' }, `Withdrawn on ${fmt.date(rec.withdrawal.at)}${rec.withdrawal.by ? ` by ${rec.withdrawal.by}` : ''}: do not use these figures.${rec.withdrawal.reason ? ` Why: ${rec.withdrawal.reason}` : ''}`) : null,
      h('p', { class: 'small' }, `Published ${fmt.date(rec.published_at)}${rec.published_by ? ` by ${rec.published_by}` : ''}. SHA-256 of what was published: `, h('code', { class: 'small', style: { overflowWrap: 'anywhere' } }, rec.sha256)),
      releaseBody(rec.content)), { wide: true });
  };
  const refresh = async () => {
    const rows = (await get('/api/county/publications')).rows;
    list.replaceChildren(table([{ label: 'Period', render: pubPeriod },
      { label: 'Published', render: x => `${fmt.date(x.published_at)}${x.published_by ? ` by ${x.published_by}` : ''}` },
      { label: 'Status', render: x => h('span', { 'data-pub-status': x.status }, badge(PUB_STATUS[x.status][0], PUB_STATUS[x.status][1]), x.withdrawal ? h('span', { class: 'small' }, ` on ${fmt.date(x.withdrawal.at)}`) : null) },
      { label: 'Programs', num: true, render: x => num(x.programmes) }, { label: 'Suppressed', num: true, render: x => num(x.suppressed) },
      { label: '', srLabel: 'Actions', render: x => h('div', { class: 'row' },
        h('button', { class: 'btn sm', 'data-pub-open': x.id, 'aria-label': `View release for ${pubPeriod(x)}`, onClick: () => openRelease(x) }, 'View release'),
        can('export:read') ? [['', 'CSV'], ['xlsx', 'Excel'], ['json', 'JSON']].map(([fmtKey, label]) => h('button', { class: 'btn sm ghost', 'data-pub-export': fmtKey || 'csv', 'aria-label': `${label} of the release for ${pubPeriod(x)}`, onClick: () => download(x, fmtKey) }, label)) : null,
        manage && x.status === 'published' ? h('button', { class: 'btn sm ghost', 'data-pub-withdraw': x.id, 'aria-label': `Withdraw the release for ${pubPeriod(x)}`, onClick: () => withdrawRelease(x) }, 'Withdraw') : null) }],
    rows, { empty: 'No release published yet.' }));
  };
  const withdrawRelease = async (x) => {
    const reason = await confirmDialog('Withdraw this release?', `The release for ${pubPeriod(x)} will be marked withdrawn wherever it is listed and in its files. It is kept as it was published (it was seen), and it still stops any overlapping period from being published.`,
      { danger: true, okText: 'Withdraw', requireReason: true, minLength: 3, maxLength: 500, reasonLabel: 'Why is it withdrawn?' });
    if (!reason) return;
    try {
      await post(`/api/county/publications/${x.id}/withdraw`, { reason });
      await refresh(); listHeading.focus();
      toast('Withdrawn. The release is kept, marked withdrawn.', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  await refresh();
  const intro = h('p', { class: 'small', 'data-pub-intro': '1' }, 'A publication release is the combined figures of a period that has ended, screened for publication by the small-cell method SUDS uses for a program\'s own releases: a county total of people or events under the threshold is shown as "<" the threshold, and a total that could be subtracted with the programs\' own published figures to reveal a small one is suppressed. Money and counts that are not of people stay exact. Each release is recorded as published and never changed; it can be withdrawn.');
  return h('div', { 'data-pub': '1' }, intro, manage ? prepareCard(refresh, listHeading) : null,
    h('section', { class: 'card mb', 'aria-labelledby': 'cpub-list-h', 'data-pub-list': '1' }, h('div', { class: 'card-head' }, listHeading), list));
}
function prepareCard(refresh, listHeading) {
  const today = fmt.today(); const lq = lastCompleteQuarter(today); const P = presets(today);
  const fromI = h('input', { type: 'date', id: 'cpub-from', name: 'from', value: lq.from, 'aria-describedby': 'cpub-err' });
  const toI = h('input', { type: 'date', id: 'cpub-to', name: 'to', value: lq.to, 'aria-describedby': 'cpub-err' });
  const preset = h('select', { id: 'cpub-preset' }, h('option', { value: '' }, 'Choose a period…'), P.map(p => h('option', { value: p.key, selected: p.from === lq.from && p.to === lq.to }, p.label)));
  preset.addEventListener('change', () => { const p = P.find(x => x.key === preset.value); if (p) { fromI.value = p.from; toI.value = p.to; } });
  const enteredI = h('input', { type: 'checkbox', id: 'cpub-entered', name: 'entered', 'data-pub-exclude-entered': '1', 'aria-describedby': 'cpub-entered-help' });
  const thresholdI = h('input', { type: 'number', id: 'cpub-threshold', name: 'threshold', min: '3', max: '50', step: '1', inputmode: 'numeric', 'aria-describedby': 'cpub-threshold-help' });
  const err = h('div', { class: 'err', id: 'cpub-err', role: 'alert', style: { flexBasis: '100%' } });
  // What would be published, or why not, said where the person is: the focus moves to it.
  const result = h('div', { tabindex: '-1', class: 'hidden', 'data-pub-result': '1' });
  const show = (node, okay) => {
    result.className = okay ? 'mb' : 'banner danger mb';
    if (okay) { result.setAttribute('role', 'region'); result.setAttribute('aria-labelledby', 'cpub-result-h'); } else { result.setAttribute('role', 'alert'); result.removeAttribute('aria-labelledby'); }
    result.setAttribute('data-pub-outcome', okay ? 'prepared' : 'refused');
    result.replaceChildren(node); result.focus();
  };
  const checkBtn = h('button', { class: 'btn primary', type: 'submit', 'data-pub-prepare': '1' }, 'Check the figures');
  const reviewPanel = (p, c) => {
    const reviewed = h('input', { type: 'checkbox', id: 'cpub-reviewed', 'data-pub-reviewed': '1', 'aria-describedby': 'cpub-reviewed-err' });
    const pubErr = h('div', { class: 'err', id: 'cpub-reviewed-err', role: 'alert' });
    const pubBtn = h('button', { class: 'btn primary', type: 'button', 'data-pub-publish': '1', onClick: async () => {
      if (!reviewed.checked) { pubErr.textContent = 'Tick that you reviewed the release first.'; reviewed.setAttribute('aria-invalid', 'true'); reviewed.focus(); return; }
      pubBtn.disabled = true;
      try {
        await post('/api/county/publications', { ...c, sha256: p.sha256, reviewed: true }, { quiet: true });
        result.className = 'hidden'; result.replaceChildren();
        await refresh(); listHeading.focus();
        toast('Published. The release is recorded and is never changed.', 'ok');
      } catch (ex) { pubErr.textContent = ex.message; pubBtn.disabled = false; }
    } }, 'Publish');
    return h('section', { class: 'card', 'data-pub-review': p.sha256 },
      h('h2', { id: 'cpub-result-h' }, `What would be published for ${fmt.date(c.from)} – ${fmt.date(c.to)}`),
      h('p', { class: 'small' }, 'Nothing is published until you confirm below. Read the figures, and what was suppressed and why.'),
      releaseBody(p.content),
      h('div', { class: 'field' }, h('label', { class: 'check', for: 'cpub-reviewed' }, reviewed, p.review_confirmation), pubErr),
      h('div', { class: 'btn-row' }, pubBtn));
  };
  const f = h('form', { class: 'filters', noValidate: true, 'data-pub-form': '1', onSubmit: async (e) => {
    e.preventDefault();
    err.textContent = ''; for (const i of [fromI, toI]) i.removeAttribute('aria-invalid');
    const problem = !fromI.value || !toI.value ? 'Choose a start and an end date.' : fromI.value > toI.value ? `The start date (${fmt.date(fromI.value)}) is after the end date (${fmt.date(toI.value)}).` : '';
    if (problem) { err.textContent = problem; fromI.setAttribute('aria-invalid', 'true'); toI.setAttribute('aria-invalid', 'true'); fromI.focus(); return; }
    const c = { from: fromI.value, to: toI.value, entered: enteredI.checked ? 'exclude' : 'include', ...(thresholdI.value ? { threshold: Number(thresholdI.value) } : {}) };
    checkBtn.disabled = true;
    try { show(reviewPanel(await post('/api/county/publications/prepare', c, { quiet: true }), c), true); }
    catch (ex) { show(h('p', {}, h('b', {}, 'Not published. '), ex.message), false); }
    finally { checkBtn.disabled = false; }
  } },
  h('div', { class: 'field' }, h('label', { for: 'cpub-preset' }, 'Period'), preset),
  h('div', { class: 'field' }, h('label', { for: 'cpub-from' }, 'From'), fromI), h('div', { class: 'field' }, h('label', { for: 'cpub-to' }, 'To'), toI),
  h('div', { class: 'field' }, h('label', { for: 'cpub-threshold' }, 'Threshold (optional)'), thresholdI, h('div', { class: 'help', id: 'cpub-threshold-help' }, 'Empty: the county\'s own. It can be raised, never lowered.')),
  h('div', { class: 'field' }, h('label', { class: 'check', for: 'cpub-entered' }, enteredI, 'Leave out figures entered by the county'), h('div', { class: 'help', id: 'cpub-entered-help' }, 'Publishes only files the programs signed.')),
  checkBtn, err);
  return h('section', { class: 'card mb', 'aria-labelledby': 'cpub-prep-h', 'data-pub-preparer': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cpub-prep-h' }, 'Prepare a publication release')),
    h('p', { class: 'small' }, 'Choose a period that has ended. SUDS screens its combined figures and shows what would be published; you then confirm and publish. A period that overlaps a release already published cannot be published: the two could be subtracted.'),
    f, result);
}

// ---- submissions: import, and every file received ----
const SUB_STATUS = { current: ['Current', 'ok'], superseded: ['Replaced', ''], withdrawn: ['Withdrawn', 'warn'], key_compromised: ['Not counted: key compromised', 'danger'] };
const subSource = (s) => h('div', {}, sourceTag(s.source), s.source === 'county_entered' && s.source_ref ? h('div', { class: 'small muted', 'data-cs-source-ref': s.id }, `From: ${s.source_ref}`) : null);
async function submissionsTab(r) {
  const list = h('div', { 'data-cs-rows': '1' });
  const heading = h('h2', { id: 'cs-list-h', tabindex: '-1' }, 'Files received');
  const refresh = async () => {
    const rows = (await get('/api/county/submissions')).rows;
    list.replaceChildren(table([{ label: 'Program', render: s => s.programme }, { label: 'Period', render: periodText },
      { label: 'Made', render: s => fmt.date(s.generated_at) }, { label: 'Received', render: s => fmt.date(s.received_at) },
      { label: 'Status', render: s => badge(SUB_STATUS[s.status][0], SUB_STATUS[s.status][1]) },
      { label: 'Source', render: subSource },
      can('county:manage') ? { label: '', srLabel: 'Actions', render: s => h('div', { class: 'row' }, s.status === 'current' || s.status === 'key_compromised'
        ? h('button', { class: 'btn sm ghost', 'data-cs-withdraw': s.id, 'aria-label': `Withdraw ${s.programme}'s ${s.source === 'county_entered' ? 'figures' : 'file'} for ${periodText(s)}`, onClick: () => withdraw(s, refresh, heading) }, 'Withdraw')
        : s.status === 'withdrawn' ? h('button', { class: 'btn sm ghost', 'data-cs-reinstate': s.id, 'aria-label': `Reinstate ${s.programme}'s ${s.source === 'county_entered' ? 'figures' : 'file'} for ${periodText(s)}`, onClick: () => reinstate(s, refresh, heading) }, 'Reinstate') : null,
        // Figures of a program that has since joined SUDS can be withdrawn or reinstated, not corrected (it signs its own now).
        s.source === 'county_entered' && s.status === 'current' && s.programme_on_suds === false ? h('button', { class: 'btn sm ghost', 'data-cs-correct': s.id, 'aria-label': `Correct ${s.programme}'s figures for ${periodText(s)}`, onClick: () => correctEntry(s) }, 'Correct') : null,
        s.source === 'county_entered' && s.programme_on_suds !== false ? h('span', { class: 'small muted', 'data-cs-no-correct': s.id }, 'The program now runs SUDS: withdraw or reinstate, not correct') : null) } : null].filter(Boolean),
    rows, { empty: 'No files received yet.' }));
  };
  await refresh();
  // Arrived here after saving or importing figures (focus=list): the keyboard goes to the list they are now in (U5),
  // once the page is drawn, not to the top of the document.
  if (r && r.query.get('focus') === 'list') setTimeout(() => { if (heading.isConnected) heading.focus(); }, 0);
  return h('div', {}, can('county:manage') ? importCard(refresh) : null,
    h('section', { class: 'card mb', 'aria-labelledby': 'cs-list-h', 'data-cs-list': '1' }, h('div', { class: 'card-head' }, heading),
      h('p', { class: 'small muted' }, 'Current: the file that counts for its program and period. Replaced: a file made later for the same period counts instead. Withdrawn: taken out by the county; it can be reinstated. Which files count toward a period you choose is on the Combined view. Figures the county entered for a program not on SUDS are listed here too, marked as such.'),
      list));
}
function importCard(refresh) {
  const input = h('input', { type: 'file', id: 'cs-file', accept: '.json,application/json', 'aria-describedby': 'cs-file-help' });
  // What became of the last file: said where the person is (focus moves to it), a status when it was imported
  // and an alert when it was refused, and left on screen until the next one.
  const result = h('div', { class: 'hidden', tabindex: '-1', 'data-cs-result': '1' });
  const say = (message, ok) => {
    result.setAttribute('role', ok ? 'status' : 'alert');
    result.className = `banner ${ok ? 'info' : 'danger'}`;
    result.setAttribute('data-cs-outcome', ok ? 'ok' : 'refused');
    result.textContent = message;
    result.focus();
  };
  const btn = h('button', { class: 'btn primary', type: 'submit', 'data-cs-import': '1' }, 'Import');
  const f = h('form', { noValidate: true, onSubmit: async (e) => {
    e.preventDefault();
    const file = input.files && input.files[0];
    if (!file) { say('Choose a county submission file first.', false); return; }
    btn.disabled = true;
    try {
      const res = await post('/api/county/submissions', { text: await file.text() }, { quiet: true });
      input.value = '';
      await refresh();
      say(res.message, true);
    } catch (err) {
      say(`Not imported. ${err.message}`, false);
    } finally { btn.disabled = false; }
  } },
  h('div', { class: 'field' }, h('label', { for: 'cs-file' }, 'County submission file (.json)'), input,
    h('div', { class: 'help', id: 'cs-file-help' }, 'The file a program made under Settlement outcomes › Send to the county, unchanged. It must be made for this county and signed with the key registered for that program.')),
  h('div', { class: 'btn-row' }, btn));
  return h('section', { class: 'card mb', 'aria-labelledby': 'cs-import-h', 'data-cs-importer': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cs-import-h' }, 'Import a submission')),
    h('p', { class: 'small' }, 'SUDS checks the file was made for this county, signed with the program\'s current key and not changed since, and that its period has ended. Of two files for the same program and period, the one made later counts; the other is kept. The same file twice changes nothing.'),
    result, f);
}
/** After a withdraw or reinstate, the list is redrawn: the focus goes to its heading, not lost with the button (U5). */
const focusList = (heading) => { heading.focus(); };
async function withdraw(s, refresh, heading) {
  const what = s.source === 'county_entered' ? 'figures' : 'file';
  const reason = await confirmDialog(`Withdraw ${s.source === 'county_entered' ? 'these figures' : 'this file'}?`, `${s.programme}'s ${what} for ${periodText(s)} will no longer count. ${s.source === 'county_entered' ? 'They are' : 'It is'} kept and can be reinstated; if ${s.source === 'county_entered' ? 'they' : 'it'} had replaced earlier figures for the same period, those count again.`,
    { danger: true, okText: 'Withdraw', requireReason: true, minLength: 3, maxLength: 500, reasonLabel: 'Why is it withdrawn? (kept in the audit log)' });
  if (!reason) return;
  try {
    const out = await post(`/api/county/submissions/${s.id}/withdraw`, { reason });
    await refresh(); focusList(heading);
    const earlier = out.restored ? (out.restored.source === 'county_entered' ? `The figures entered for ${periodText(out.restored)} count again.` : `The earlier file for ${periodText(out.restored)} counts again.`) : '';
    const msg = s.source === 'county_entered' ? `Withdrawn. These figures no longer count.${earlier ? ` ${earlier}` : ''}` : `Withdrawn.${earlier ? ` ${earlier}` : ' It no longer counts.'}`;
    toast(msg, 'ok'); announce(msg);
  } catch (e) { toast(e.message, 'error'); }
}
async function reinstate(s, refresh, heading) {
  try { const out = await post(`/api/county/submissions/${s.id}/reinstate`, {}); await refresh(); focusList(heading); toast(out.message, 'ok'); }
  catch (e) { toast(e.message, 'error'); }
}

// ---- programs ----
async function programmesTab() {
  const d = await get('/api/county/programmes'); const rows = d.rows;
  const manage = can('county:manage');
  measuresCache = d.measures || measuresCache;
  const codeCard = h('section', { class: 'card mb', 'aria-labelledby': 'cp-code-h', 'data-cp-code-card': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cp-code-h' }, 'This county\'s code')),
    h('div', { class: 'county-code' }, h('code', { 'data-cp-code': '1' }, d.county_code)),
    h('p', { class: 'small' }, 'Give it to each program you fund. They type it on Settlement outcomes › Send to the county, so their file names this county: SUDS refuses a file made for another county. It is not a secret.'),
    h('div', { class: 'btn-row' }, copyButton(d.county_code, 'County code', { 'data-cp-code-copy': '1' })));
  return h('div', {}, codeCard,
    manage ? h('div', { class: 'row mb' }, h('button', { class: 'btn primary', 'data-cp-add': '1', onClick: () => programmeForm(null) }, 'Register a program'),
      h('button', { class: 'btn', 'data-cp-add-entered': '1', onClick: () => notOnSudsForm() }, 'Add a program not on SUDS')) : null,
    h('section', { class: 'card mb', 'aria-labelledby': 'cp-list-h', 'data-cp-list': '1' },
      h('div', { class: 'card-head' }, h('h2', { id: 'cp-list-h' }, 'Programs the county accepts files from')),
      h('p', { class: 'small muted' }, `Each is known by the public key it gave the county. ${HELP.fingerprint} A program not on SUDS has no key: the county enters its figures, and they are marked "${ENTERED_WORDS}".`),
      table([{ label: 'Program', render: p => p.name }, { label: 'Key fingerprint', render: p => (p.on_suds === false ? h('span', { class: 'small', 'data-cp-not-on-suds': p.id }, 'Not on SUDS: figures entered by the county') : h('code', { class: 'small' }, p.fingerprint_display)) },
        { label: 'Status', render: p => badge(p.active ? 'Active' : p.keep_files ? 'Inactive: files still counted' : 'Inactive: files not counted', p.active ? 'ok' : '') }, { label: 'Files counting', num: true, render: p => num(p.current_submissions) },
        { label: 'Last file received', render: p => (p.last_received ? fmt.date(p.last_received) : '—') },
        manage ? { label: '', srLabel: 'Actions', render: p => h('div', { class: 'row' }, h('button', { class: 'btn sm', 'data-cp-edit': p.id, 'aria-label': `Edit ${p.name}`, onClick: () => programmeForm(p) }, 'Edit'),
          p.on_suds === false ? [
            h('button', { class: 'btn sm', 'data-cp-enter': p.id, 'aria-label': `Enter figures for ${p.name}`, disabled: !p.active, onClick: () => enterFiguresDialog(p) }, 'Enter figures'),
            h('button', { class: 'btn sm', 'data-cp-import': p.id, 'aria-label': `Import a CSV of ${p.name}'s figures`, disabled: !p.active, onClick: () => importCsvDialog(p) }, 'Import a CSV'),
            h('button', { class: 'btn sm ghost', 'data-cp-join': p.id, 'aria-label': `Add its key: ${p.name} now runs SUDS`, onClick: () => keysDialog(p) }, 'Add its key')]
            : h('button', { class: 'btn sm', 'data-cp-keys': p.id, 'aria-label': `Keys of ${p.name}`, onClick: () => keysDialog(p) }, 'Keys')) } : null].filter(Boolean),
      rows, { empty: 'No programs registered yet.' })),
    // County connection hook (views/countyconnect.js): each program's connection token, for county:manage. A program
    // not on SUDS has no key and nothing to send over a connection, so it is not offered one.
    await programmeConnections(rows.filter(p => p.on_suds !== false)));
}
/** The fingerprint of the key being pasted, worked out as it is typed (debounced), to compare with the one read out (U6). */
function fingerprintPreview(keyInput) {
  const shown = h('div', { class: 'help', 'data-cp-computed': '1', role: 'status' }, 'The key\'s fingerprint shows here once you paste it.');
  let timer; let seq = 0;
  const check = async () => {
    const v = keyInput.value.trim(); const mine = ++seq;
    if (!v) { shown.textContent = 'The key\'s fingerprint shows here once you paste it.'; return; }
    try {
      const x = await post('/api/county/fingerprint', { public_key: v }, { quiet: true });
      if (mine !== seq) return;
      shown.textContent = `This key's fingerprint: ${x.fingerprint_display}. Compare it with the one the program reads out to you.${x.registered_as ? ` It is already registered, for ${x.registered_as}${x.registered_as_old_key ? ' (a key it used before)' : ''}.` : ''}`;
    } catch (e) { if (mine === seq) shown.textContent = e.message; }
  };
  keyInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 350); });
  keyInput.addEventListener('change', check);
  return shown;
}
const KEY_FIELDS = [
  { name: 'public_key', label: 'Public key', type: 'textarea', rows: 5, required: true, span: true, help: 'The block from "-----BEGIN PUBLIC KEY-----" to "-----END PUBLIC KEY-----" the program sent you.' },
  { name: 'fingerprint', label: 'Fingerprint the program read out', span: true, help: 'Eight groups of four characters. SUDS refuses a key that does not match. Or tick the box below instead.' },
  { name: 'compared', label: 'I compared the fingerprint shown above with the one the program read out, and they match', type: 'checkbox', span: true },
];
function programmeForm(p) {
  const isNew = !p;
  const fields = isNew
    ? [{ name: 'name', label: 'Program name', required: true, span: true }, ...KEY_FIELDS, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: true }]
    : [{ name: 'name', label: 'Program name', required: true, span: true }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: true },
      { name: 'active', label: 'Active: accept files from this program', type: 'checkbox', value: p.active },
      { name: 'keep_files', label: 'While inactive, keep counting the files it already sent (a program whose contract ended)', type: 'checkbox', value: p.keep_files }];
  let shown = null;
  const f = form(fields, { values: p || {}, submitText: isNew ? 'Register' : 'Save', onCancel: () => m.close(),
    extra: isNew ? null : h('div', {}, p.on_suds === false ? kv([['Key', 'None: not on SUDS. The county enters its figures.']]) : kv([['Current key fingerprint', h('code', {}, p.fingerprint_display)]]), h('p', { class: 'small muted' }, 'An inactive program\'s new files are refused. Its files already here stop counting, unless you keep them.')),
    onSubmit: async (d) => {
      if (isNew) await post('/api/county/programmes', { name: d.name, public_key: d.public_key, fingerprint: d.fingerprint || undefined, compared: !!d.compared, notes: d.notes });
      else await put(`/api/county/programmes/${p.id}`, { name: d.name, notes: d.notes, active: !!d.active, keep_files: !!d.keep_files });
      m.close(); toast(isNew ? `Registered ${d.name}.` : 'Saved.', 'ok'); nav('county?tab=programmes&t=' + Date.now());
    } });
  if (isNew) { shown = fingerprintPreview(f.inputs.public_key); f.querySelector('[data-field=public_key]').append(shown); }
  const m = modal(isNew ? 'Register a program' : `Edit ${p.name}`, f, { wide: true });
}
/** A program's keys: the history, marking a replaced key compromised (or trusted again), and replacing the key (S4). */
function keysDialog(p) {
  const history = table([{ label: 'Fingerprint', render: k => h('code', { class: 'small' }, k.fingerprint_display) }, { label: 'Added', render: k => fmt.date(k.added_at) },
    { label: 'Status', render: k => (k.current ? badge('Current', 'ok') : k.compromised_at ? badge('Replaced: compromised, its files not counted', 'danger') : badge('Replaced: its files still count', '')) },
    { label: '', srLabel: 'Actions', render: k => (k.current ? null : h('button', { class: 'btn sm', 'data-cp-key-toggle': k.id, onClick: async () => {
      if (!k.compromised_at && !(await confirmDialog('Stop counting this key\'s files?', `Every file ${p.name} signed with this old key stops counting. Do this when the program tells you the key was lost or exposed.`, { danger: true, okText: 'Old key compromised' }))) return;
      try { await put(`/api/county/programmes/${p.id}/keys/${k.id}`, { compromised: !k.compromised_at }); m.close(); toast(k.compromised_at ? 'Its files count again.' : 'Its files no longer count.', 'ok'); nav('county?tab=programmes&t=' + Date.now()); }
      catch (e) { toast(e.message, 'error'); }
    } }, k.compromised_at ? 'Trust again' : 'Old key compromised')) }], p.keys);
  // A program not on SUDS that now runs it: its first key (D5). It is then on SUDS for good: the figures the county
  // entered for it stay, marked, and can be withdrawn or reinstated but no longer corrected, and its signed files
  // outrank them wherever the two overlap.
  const joins = p.on_suds === false;
  const f = form(joins ? KEY_FIELDS : [...KEY_FIELDS, { name: 'old_compromised', label: 'The old key was compromised: stop counting the files it signed', type: 'checkbox', span: true }],
    { submitText: joins ? 'Add the key' : 'Replace the key', onCancel: () => m.close(), onSubmit: async (d) => {
      await post(`/api/county/programmes/${p.id}/keys`, { public_key: d.public_key, fingerprint: d.fingerprint || undefined, compared: !!d.compared, old_compromised: joins ? false : !!d.old_compromised });
      m.close(); toast(joins ? `${p.name} is now on SUDS. Its files must be signed with this key.` : `${p.name}'s key replaced. New files must be signed with it.`, 'ok'); nav('county?tab=programmes&t=' + Date.now());
    } });
  f.querySelector('[data-field=public_key]').append(fingerprintPreview(f.inputs.public_key));
  const m = modal(joins ? `Add ${p.name}'s key` : `Keys of ${p.name}`, h('div', { 'data-cp-keys-dialog': '1' },
    joins ? h('p', { class: 'small', 'data-cp-join-note': '1' }, `When ${p.name} starts running SUDS, add the public key it gives you. It is then on SUDS for good: it signs its own files, and a signed file outranks figures the county entered wherever the two overlap. The figures the county entered for it stay, marked "${ENTERED_WORDS}": they can be withdrawn or reinstated, but no longer corrected, and no more are entered.`)
      : h('p', { class: 'small' }, `When ${p.name} makes a new key, add it here. Files its old key signed that are already here keep counting, unless you say the old key was compromised. New files must be signed with the current key.`),
    joins ? null : history, h('h3', {}, joins ? 'Its key' : 'Replace the key'), f), { wide: true });
}

// ---- programs not on SUDS: figures the county enters (released in 1.20.0; server/county-entry.js) ----
let measuresCache = null;
/** The outcomes a submission carries, in order, with their labels (from GET /api/county/programmes). */
async function measures() {
  if (!measuresCache) measuresCache = (await get('/api/county/programmes')).measures;
  return measuresCache;
}
/** Register a grantee that does not run SUDS: a name, no key; the county then enters its figures. */
function notOnSudsForm() {
  const f = form([{ name: 'name', label: 'Program name', required: true, span: true }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: true }], {
    submitText: 'Add the program', onCancel: () => m.close(),
    onSubmit: async (d) => {
      const added = await post('/api/county/programmes', { name: d.name, notes: d.notes || undefined, not_on_suds: true });
      m.close(); nav('county?tab=programmes&t=' + Date.now());
      // The next step, offered where the person is: the toast's own Enter figures button (it holds while focused).
      undoToast(`Added ${added.name}, not on SUDS.`, () => enterFiguresDialog(added), { action: { text: 'Enter figures', key: 'enter-figures' } });
    } });
  const m = modal('Add a program not on SUDS', h('div', { 'data-cp-entered-dialog': '1' },
    h('p', { class: 'small' }, `For a grantee that does not run SUDS. It has no key, so it sends no signed file: the county's own staff enter its figures (or import them as a CSV) from what it sends. Every view and file marks them "${ENTERED_WORDS}", and the combined view can leave them out.`), f), { wide: true });
}
const FUND_TEXT = ['name', 'grant_number', 'category', 'hiaa'];
/** Exhibit E's uses, each named with its schedule as the fund form names them (budget.js settlementFields). */
const useKind = (code) => (code.startsWith('core_') ? 'Core strategy ' : code.startsWith('approved_') ? 'Approved use ' : '');
const useOptions = () => ((state.constants || {}).SETTLEMENT_USES || []).map(x => ({ value: x.code, label: `${useKind(x.code)}${x.label}` }));
const SPEND = [['spend_own_category', 'Spent under the fund\'s own category ($)'], ['spend_other_categories', 'Spent under other categories ($)'], ['spend_pending', 'Pending approval ($)']];
/**
 * The form's values from an entry to correct ({ from, to, funds }): "funds.0.contacts" and so on. The source
 * document is not carried over: a correction comes from a document of its own (the earlier one is said under it).
 */
function flatEntry(e) {
  const v = { from: e.from, to: e.to, source_ref: '' };
  e.funds.forEach((f, i) => { for (const [k, x] of Object.entries(f)) v[`funds.${i}.${k}`] = x === null || x === undefined ? '' : String(x); });
  return v;
}
/**
 * Enter figures for a program not on SUDS, for one period: the period, the document they come from, and for each
 * fund its Exhibit E category, HIAA, spending and outcomes. The server checks every figure (strict numbers, the
 * allow-list, a period that has ended) and says what is wrong at the field. Saving figures for a period that already
 * has some replaces them (the earlier ones are kept, no longer counting). `initial`: an entry to correct.
 */
async function enterFiguresDialog(p, { initial = null } = {}) {
  const M = await measures();
  const C = state.constants || {};
  // The blank choice is "no category" (uncategorised) and "not recorded": the server's defaults for them.
  const useOpts = useOptions();
  const hiaaOpts = [...(C.SETTLEMENT_HIAA || []).map(x => ({ value: x.code, label: x.label })), { value: 'none', label: 'Not a High Impact Abatement Activity' }];
  const lq = lastCompleteQuarter(fmt.today());
  let values = initial ? flatEntry(initial) : { from: lq.from, to: lq.to };
  let n = initial ? Math.max(1, initial.funds.length) : 1;
  const holder = h('div', { 'data-ce-dialog': '1' });
  const numeric = [...SPEND.map(([k]) => k), ...M.map(x => x.key)];
  const build = () => {
    const fields = [
      { type: 'section', label: 'The period and where the figures come from' },
      { name: 'from', label: 'From', type: 'date', required: true },
      { name: 'to', label: 'To', type: 'date', required: true },
      { name: 'source_ref', label: 'Source document', required: true, span: true, maxLen: 200,
        help: initial ? `Which document the corrected figures come from: for example "Corrected Q2 report emailed 20 July 2026".${initial.source_ref ? ` The figures being corrected came from: ${initial.source_ref}.` : ''}` : 'Which document the figures come from, so anyone can check them later: for example "Q2 report emailed 3 July 2026".' },
    ];
    for (let i = 0; i < n; i++) {
      const pre = `funds.${i}.`;
      fields.push({ type: 'section', label: `Fund ${i + 1}` },
        { name: `${pre}name`, label: 'Fund name', required: true, maxLen: 200 },
        { name: `${pre}grant_number`, label: 'Grant or agreement number (optional)', maxLen: 100 },
        { name: `${pre}category`, label: 'Exhibit E allowable use', type: 'select', options: useOpts, placeholder: 'No settlement category recorded', span: true },
        { name: `${pre}hiaa`, label: 'High Impact Abatement Activity', type: 'select', options: hiaaOpts, placeholder: '— not recorded —', span: true },
        ...SPEND.map(([k, label]) => ({ name: `${pre}${k}`, label, required: true })),
        { type: 'section', label: `Fund ${i + 1}: outcomes` },
        ...M.map(x => ({ name: `${pre}${x.key}`, label: x.label, required: true })));
    }
    const more = h('div', { class: 'btn-row', 'data-ce-funds': String(n) },
      h('button', { class: 'btn sm', type: 'button', 'data-ce-add-fund': '1', onClick: () => { values = f.read(true); n++; build(); const el = holder.querySelector(`[name="funds.${n - 1}.name"]`); if (el) el.focus(); announce(`Fund ${n} added.`); } }, 'Add another fund'),
      n > 1 ? h('button', { class: 'btn sm ghost', type: 'button', 'data-ce-remove-fund': '1', onClick: () => { values = f.read(true); n--; build(); const el = holder.querySelector('[data-ce-add-fund]'); if (el) el.focus(); announce(`Fund ${n + 1} removed.`); } }, 'Remove the last fund') : null);
    const f = form(fields, { values, submitText: 'Save the figures', onCancel: () => m.close(), extra: more,
      onSubmit: async (d) => {
        const funds = Array.from({ length: n }, (_, i) => Object.fromEntries([...FUND_TEXT, ...numeric].map(k => [k, d[`funds.${i}.${k}`] ?? ''])));
        const res = await post(`/api/county/programmes/${p.id}/entries`, { from: d.from, to: d.to, source_ref: d.source_ref, funds });
        m.close(); toast(res.message, 'ok'); nav(`county?tab=submissions&focus=list&t=${Date.now()}`);
      } });
    // Figures are typed as text so SUDS, not the browser, says what is wrong with "1,200" or "$5". Every one is
    // required (marked *, as every form marks a required field): 0 where the program reported none.
    for (let i = 0; i < n; i++) for (const k of numeric) { const el = f.inputs[`funds.${i}.${k}`]; if (el) el.setAttribute('inputmode', 'decimal'); }
    holder.replaceChildren(h('p', { class: 'small' }, `Figures ${ENTERED_WORDS}: every view and file marks them so. Fields marked * are required. Type each figure as digits (up to two decimals for money and hours), 0 where the program reported none. Saving figures for a period that already has some replaces them; the earlier ones are kept.`), f);
  };
  build();
  const m = modal(`${initial ? 'Correct' : 'Enter'} figures for ${p.name}`, holder, { wide: true });
}
/** Correct entered figures: the same dialog, filled in with them; saving replaces them for their period. */
async function correctEntry(s) {
  try {
    const e = await get(`/api/county/entries/${s.id}`);
    await enterFiguresDialog({ id: e.programme_id, name: s.programme }, { initial: e });
  } catch (err) { toast(err.message, 'error'); }
}
/**
 * Import a CSV of a program's figures, in the long ("tidy") layout the combined view downloads (or the template
 * offered here). Check the file first: its problems are listed by row and column (nothing is saved), or what it
 * holds is shown, with each fund's Exhibit E category and HIAA to choose (the layout has neither). Then import:
 * every period at once, or none. Only this program's rows are read; another program's are said in one line and
 * never imported. Choosing another file clears the check; Import makes sure the file chosen is still the one checked.
 */
function importCsvDialog(p) {
  const C = state.constants || {};
  const fileI = h('input', { type: 'file', id: 'ci-file', accept: '.csv,text/csv', 'aria-describedby': 'ci-file-help' });
  const refI = h('input', { type: 'text', id: 'ci-ref', maxlength: 200, autocomplete: 'off', 'aria-required': 'true', 'aria-describedby': 'ci-ref-help' });
  const result = h('div', { class: 'hidden', tabindex: '-1', 'data-ci-result': '1' });
  const previewBox = h('div', { 'data-ci-preview': '1' });
  // What was checked: the text sent for the preview, and which file it came from (name, size, time), so Import
  // sends exactly what was previewed, and only while that file is still the one chosen.
  let text = ''; let preview = null; let selects = []; let checked = null;
  const say = (message, ok, extra = null) => {
    result.setAttribute('role', ok ? 'status' : 'alert'); result.className = `banner ${ok ? 'info' : 'danger'}`; result.setAttribute('data-ci-outcome', ok ? 'ok' : 'refused');
    result.replaceChildren(...[h('p', {}, message), extra].filter(Boolean)); result.focus();
  };
  const clear = () => {
    text = ''; preview = null; selects = []; checked = null;
    previewBox.replaceChildren();
    result.replaceChildren(); result.className = 'hidden'; result.removeAttribute('role'); result.removeAttribute('data-ci-outcome');
  };
  // A new file chosen: the last one's check, preview and categories no longer apply.
  fileI.addEventListener('change', clear);
  const sameFile = (f) => !!(f && checked && f.name === checked.name && f.size === checked.size && f.lastModified === checked.lastModified);
  const errorsTable = (errors) => (errors && errors.length ? table([{ label: 'Row', render: e => (e.row ? String(e.row) : '—') }, { label: 'Column', render: e => e.column || '—' }, { label: 'Problem', render: e => e.message }], errors, { wrap: false }) : null);
  const funds = () => selects.map(x => ({ name: x.fund.name, grant_number: x.fund.grant_number, category: x.cat.value || 'uncategorised', hiaa: x.hiaa.value || null }));
  const importBtn = h('button', { class: 'btn primary', type: 'button', 'data-ci-import': '1', onClick: async () => {
    refI.removeAttribute('aria-invalid');
    const file = fileI.files && fileI.files[0];
    // The file chosen must be the one checked, unchanged: otherwise what was previewed is not what would be saved.
    let same = sameFile(file) && !!preview;
    if (same) { try { same = (await file.text()) === text; } catch { same = false; } }
    if (!same) { clear(); say('The file chosen is not the one that was checked (or it changed since). Nothing was saved. Check the file again, then import it.', false); fileI.focus(); return; }
    if (refI.value.trim().length < 3) { refI.setAttribute('aria-invalid', 'true'); say('Say which document the figures come from (Source document), then import.', false); refI.focus(); return; }
    importBtn.disabled = true;
    try {
      const res = await post(`/api/county/programmes/${p.id}/entries/import`, { text, source_ref: refI.value, funds: funds() }, { quiet: true });
      m.close(); toast(res.message, 'ok', { ms: 8000 }); nav(`county?tab=submissions&focus=list&t=${Date.now()}`);
    } catch (err) {
      const d = err.data || {};
      if (d.fields && d.fields.source_ref) refI.setAttribute('aria-invalid', 'true');
      say(err.message, false, errorsTable(d.errors));
    } finally { importBtn.disabled = false; }
  } }, 'Import');
  const showPreview = (pv) => {
    const useOpts = [...useOptions().map(x => [x.value, x.label]), ['uncategorised', 'No settlement category recorded']];
    const hiaaOpts = [['', '— not recorded —'], ...(C.SETTLEMENT_HIAA || []).map(x => [x.code, x.label]), ['none', 'Not a High Impact Abatement Activity']];
    selects = pv.funds.map((fund, i) => ({ fund,
      cat: h('select', { id: `ci-cat-${i}`, 'data-ci-category': String(i) }, useOpts.map(([v, l]) => h('option', { value: v, selected: v === 'uncategorised' }, l))),
      hiaa: h('select', { id: `ci-hiaa-${i}`, 'data-ci-hiaa': String(i) }, hiaaOpts.map(([v, l]) => h('option', { value: v }, l))) }));
    const money = (n) => fmt.money(n);
    previewBox.replaceChildren(...[h('h3', {}, 'What the file holds'),
      (pv.warnings || []).length ? h('div', { class: 'banner warn', 'data-ci-warnings': '1' }, pv.warnings.map(w => h('p', {}, w))) : null,
      table([{ label: 'Period', render: x => `${fmt.date(x.from)} – ${fmt.date(x.to)}` }, { label: 'Funds', render: x => x.funds.map(f => f.name).join('; ') },
        { label: 'Spent (approved)', num: true, render: x => money(x.total.spend_approved) }, { label: 'Pending', num: true, render: x => money(x.total.spend_pending) },
        { label: 'People served', num: true, render: x => fmt.num(x.total.values.people_served) }], pv.periods, { wrap: false }),
      h('h3', {}, 'Each fund\'s category'),
      h('p', { class: 'small' }, 'The CSV layout does not carry them: choose each fund\'s Exhibit E allowable use and High Impact Abatement Activity.'),
      ...selects.map((x, i) => h('fieldset', { class: 'mb', 'data-ci-fund': String(i) }, h('legend', {}, x.fund.grant_number ? `${x.fund.name} (${x.fund.grant_number})` : x.fund.name),
        h('div', { class: 'field' }, h('label', { for: `ci-cat-${i}` }, 'Exhibit E allowable use'), x.cat),
        h('div', { class: 'field' }, h('label', { for: `ci-hiaa-${i}` }, 'High Impact Abatement Activity'), x.hiaa))),
      h('div', { class: 'btn-row' }, importBtn)].filter(Boolean));
  };
  const checkBtn = h('button', { class: 'btn primary', type: 'submit', 'data-ci-check': '1' }, 'Check the file');
  const f = h('form', { noValidate: true, onSubmit: async (e) => {
    e.preventDefault();
    const file = fileI.files && fileI.files[0];
    clear();
    if (!file) { say('Choose a CSV file first.', false); fileI.focus(); return; }
    checkBtn.disabled = true;
    try {
      const t = await file.text();
      const pv = await post(`/api/county/programmes/${p.id}/entries/import`, { text: t, preview: true }, { quiet: true });
      text = t; preview = pv; checked = { name: file.name, size: file.size, lastModified: file.lastModified };
      showPreview(pv);
      say(`The file holds ${pv.periods.length} period${pv.periods.length === 1 ? '' : 's'} of ${p.name}'s figures (${pv.rows} rows). Nothing is saved until you import it.`, true);
    } catch (err) {
      say(err.message, false, errorsTable(err.data && err.data.errors));
    } finally { checkBtn.disabled = false; }
  } },
  h('div', { class: 'field' }, h('label', { for: 'ci-file' }, 'CSV file *'), fileI,
    h('div', { class: 'help', id: 'ci-file-help' }, `Columns program, period_from, period_to, fund, grant_number, measure_code, measure_label, value (the Long CSV the Combined view downloads, or the template below). Every figure of every fund is needed. Only rows whose program is ${p.name} are read; another program's rows are never imported.`)),
  h('div', { class: 'field' }, h('label', { for: 'ci-ref' }, 'Source document *'), refI,
    h('div', { class: 'help', id: 'ci-ref-help' }, 'Which document the figures come from: for example "FY 2025-26 report, emailed 3 July 2026".')),
  h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onClick: () => m.close() }, 'Cancel'), checkBtn));
  // A template for this program: its name, the last complete quarter (change the dates for another period), its
  // funds as last entered, every measure, and the values left for the county to fill in from the program's report.
  const lq = lastCompleteQuarter(fmt.today());
  const template = h('button', { class: 'btn sm', type: 'button', 'data-ci-template': '1', onClick: () => fetchDownload(`/api/county/programmes/${p.id}/entries/template?from=${lq.from}&to=${lq.to}`)
    .then(() => toast(`Downloaded a template of ${p.name}'s figures for ${fmt.date(lq.from)} – ${fmt.date(lq.to)}.`, 'ok')).catch(e => toast(e.message, 'error')) }, 'Download a template for this program');
  const m = modal(`Import a CSV of ${p.name}'s figures`, h('div', { 'data-ci-dialog': '1' },
    h('p', { class: 'small' }, `Figures ${ENTERED_WORDS}: every view and file marks them so. A period that already has figures is replaced (the earlier ones are kept). Fields marked * are required.`),
    h('div', { class: 'btn-row mb' }, template, h('span', { class: 'small muted' }, `${fmt.date(lq.from)} – ${fmt.date(lq.to)}, with ${p.name}'s funds as last entered; change the dates in it for another period.`)),
    result, f, previewBox), { wide: true });
}
