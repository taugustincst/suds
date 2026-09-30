import { h, route, get, post, put, fmt, can, pageHead, pageTabs, table, kv, nav, toast, modal, form, confirmDialog, emptyState, badge, loadingFor, announce } from '../app.js';
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
loadingFor('county', () => 'Adding up the programs\' submissions…');

const money = (n) => (typeof n === 'number' ? fmt.money(n) : '—');
const num = (n) => (typeof n === 'number' ? fmt.num(n) : '—');
const STATUS = { whole: ['Whole period', 'ok'], part: ['Part of the period', 'warn'], none: ['Not submitted', 'danger'] };
const statusBadge = (s) => badge(STATUS[s][0], STATUS[s][1]);
const periodText = (s) => `${fmt.date(s.period_from)} – ${fmt.date(s.period_to)}`;
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
  const tab = ['submissions', 'programmes'].includes(r.query.get('tab')) ? r.query.get('tab') : 'view';
  const tabs = pageTabs([['view', 'Combined view'], ['submissions', 'Submissions'], ['programmes', 'Programs']], tab,
    (k) => nav(k === 'view' ? 'county' : `county?tab=${k}`), { label: 'County view sections', wrap: true });
  const intro = h('p', { class: 'small', 'data-county-intro': '1' }, 'The settlement spending and outcomes the programs the county funds send it, each as a file its own SUDS signed. Exact aggregate figures for authorised county staff: no client of any program is ever in them, and nothing here is for publication.');
  const body = tab === 'programmes' ? await programmesTab() : tab === 'submissions' ? await submissionsTab() : await viewTab(r);
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
  const fromI = h('input', { type: 'date', value: from, id: 'cv-from', name: 'from', 'aria-describedby': 'cv-range-err' });
  const toI = h('input', { type: 'date', value: to, id: 'cv-to', name: 'to', 'aria-describedby': 'cv-range-err' });
  const P = presets(today);
  const preset = h('select', { id: 'cv-preset', 'data-cv-preset': '1', 'aria-describedby': 'cv-preset-help' }, h('option', { value: '' }, 'Choose a period…'),
    P.map(p => h('option', { value: p.key, selected: p.from === from && p.to === to }, p.label)));
  preset.addEventListener('change', () => { const p = P.find(x => x.key === preset.value); if (p) { fromI.value = p.from; toI.value = p.to; } });
  const mode = h('select', { id: 'cv-mode', 'data-cv-mode': '1' }, h('option', { value: '', selected: !by }, 'The whole period'), h('option', { value: 'quarter', selected: by === 'quarter' }, 'By quarter'));
  const rangeErr = h('div', { class: 'err', id: 'cv-range-err', role: 'alert', style: { flexBasis: '100%' } });
  const problem = (f, t) => (!f || !t ? 'Choose a start and an end date.' : f > t ? `The start date (${fmt.date(f)}) is after the end date (${fmt.date(t)}). Choose a start date on or before the end date.` : '');
  const showErr = (msg) => { rangeErr.textContent = msg; for (const i of [fromI, toI]) { if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); } };
  // A form, so Enter in a date applies it (U12); choosing a preset fills the dates and waits for Apply.
  const controls = h('form', { class: 'filters', 'data-cv-form': '1', noValidate: true, onSubmit: (e) => {
    e.preventDefault();
    const msg = problem(fromI.value, toI.value);
    if (msg) { showErr(msg); fromI.focus(); return; }
    nav(`county?from=${fromI.value}&to=${toI.value}${mode.value ? `&by=${mode.value}` : ''}`);
  } },
  h('div', { class: 'field' }, h('label', { for: 'cv-preset' }, 'Period'), preset, h('div', { class: 'help', id: 'cv-preset-help' }, 'Fiscal years run July to June; FY Q1 is July to September.')),
  h('div', { class: 'field' }, h('label', { for: 'cv-from' }, 'From'), fromI), h('div', { class: 'field' }, h('label', { for: 'cv-to' }, 'To'), toI),
  h('div', { class: 'field' }, h('label', { for: 'cv-mode' }, 'Show'), mode),
  h('button', { class: 'btn primary', type: 'submit', 'data-cv-apply': '1' }, 'Apply'),
  rangeErr);
  if (problem(from, to)) { showErr(problem(from, to)); return h('div', {}, controls); }
  const qs = `from=${from}&to=${to}`;
  const d = await get(`/api/county/view?${qs}${by ? '&by=quarter' : ''}`);
  const download = (format) => fetchDownload(`/api/county/view/export?${qs}${format ? `&format=${format}` : ''}`)
    .then(() => toast('Downloaded. Internal, exact counts: for authorised county staff, not for publication.', 'ok')).catch(e => toast(e.message, 'error'));
  const actions = can('export:read') ? h('div', { class: 'row mb', 'data-cv-actions': '1' }, h('button', { class: 'btn primary', 'data-cv-export': 'xlsx', onClick: () => download('xlsx') }, 'Download (Excel, internal)'),
    h('button', { class: 'btn', 'data-cv-export': 'csv', onClick: () => download('') }, 'CSV (internal)'),
    h('button', { class: 'btn', 'data-cv-export': 'tidy', onClick: () => download('tidy') }, 'Long CSV, one row per figure (internal)')) : null;
  const what = describe(from, to);
  const periodLine = h('p', { class: 'small', 'data-cv-period': '1' }, h('b', {}, `${fmt.date(from)} – ${fmt.date(to)}`), what ? ` (${what})` : '');
  if (by === 'quarter') return h('div', {}, controls, periodLine, caveatsCard(d), actions, quarterView(d));
  if (!d.programmes.length && !d.inactive_left_out.length) {
    return h('div', {}, controls, periodLine, caveatsCard(d), emptyState('No programs registered', 'Register each program the county funds, with the public key it gives you, under Programs. Then import the files they send under Submissions.',
      can('county:manage') ? h('a', { class: 'btn primary', href: '#/county?tab=programmes' }, 'Register a program') : null));
  }
  const shorts = shortNames(d.programmes);
  const who = h('section', { class: 'card mb', 'aria-labelledby': 'cv-who-h', 'data-cv-who': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cv-who-h' }, `Who has submitted for ${fmt.date(from)} – ${fmt.date(to)}`)),
    h('p', { 'data-cv-headline': '1' }, h('b', {}, d.headline)),
    d.inactive_left_out.length ? h('p', { class: 'small', 'data-cv-inactive': '1' }, `Left out: ${d.inactive_left_out.map(p => p.name).join(', ')} (inactive; the county chose not to keep counting ${d.inactive_left_out.length === 1 ? 'its' : 'their'} files).`) : null,
    table([{ label: 'Program', render: p => p.name }, { label: 'For this period', render: p => statusBadge(p.status) },
      { label: 'Files counted', render: p => (p.submissions.length ? p.submissions.map(s => h('div', {}, `${periodText(s)} · received ${fmt.date(s.received_at)}`)) : '—') },
      { label: 'Left out', render: p => (p.left_out.length ? p.left_out.map(s => h('div', { class: 'small' }, `${periodText(s)}: ${s.why === 'overlaps' ? 'inside a longer file that counts' : 'not wholly inside this period'}`)) : '—') }], d.programmes, { empty: 'No programs.' }));
  const figure = (x, v) => (x.money ? money(v) : num(v));
  // A program with nothing for the period has no figure: "—" and the words, never a greyed 0 alone (M6).
  const progCell = (p) => (x) => (x.by[p.id] === null ? h('span', { class: 'muted', 'data-cv-none': '1' }, '— ', h('span', { class: 'small' }, 'not submitted')) : p.status === 'part' ? h('span', {}, figure(x, x.by[p.id]), h('span', { class: 'small muted' }, ' (part)')) : figure(x, x.by[p.id]));
  const cols = [{ label: 'Measure', render: x => x.label },
    ...d.programmes.map(p => ({ label: p.name, cardLabel: shorts[p.id], num: true, render: progCell(p) })),
    { label: `Total (${d.whole} of ${d.of} programs complete)`, cardLabel: 'Total', num: true, render: x => h('b', {}, figure(x, x.total)) }];
  const group = (g, title, id, note) => {
    const rows = d.rows.filter(x => x.group === g);
    return h('section', { class: 'card mb', 'aria-labelledby': id, 'data-cv-group': g },
      h('div', { class: 'card-head' }, h('h2', { id }, title)), note ? h('p', { class: 'small muted' }, note) : null,
      table(cols, rows, { empty: 'Nothing recorded for this period.' }));
  };
  return h('div', {}, controls, periodLine, caveatsCard(d), actions, who,
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
  const cols = [{ label: 'Measure', render: x => x.label },
    ...d.quarters.map((q, i) => ({ label: `${qLabel(q)} (${q.whole} of ${q.of} complete)`, cardLabel: qLabel(q), num: true, render: x => figure(x, x.by_quarter[i]) }))];
  const section = (g, title, id) => { const rows = d.rows.filter(x => x.group === g); return rows.length ? h('section', { class: 'card mb', 'aria-labelledby': id, 'data-cv-quarter-group': g }, h('div', { class: 'card-head' }, h('h2', { id }, title)), table(cols, rows)) : null; };
  const perQuarter = h('details', { class: 'card mb', 'data-cv-per-program': '1' }, h('summary', {}, h('h2', { class: 'summary-heading' }, 'Each program\'s figures, quarter by quarter')),
    d.quarters.map((q, qi) => {
      const shorts = shortNames(q.programmes);
      const pc = [{ label: 'Measure', render: x => x.label }, ...q.programmes.map(p => ({ label: p.name, cardLabel: shorts[p.id], num: true, render: x => (x.by[p.id] === null ? h('span', { class: 'muted' }, '— ', h('span', { class: 'small' }, 'not submitted')) : figure(x, x.by[p.id])) })),
        { label: `Total (${q.whole} of ${q.of} programs complete)`, cardLabel: 'Total', num: true, render: x => h('b', {}, figure(x, x.total)) }];
      return h('div', { 'data-cv-quarter': qi }, h('h3', {}, qLabel(q)), h('p', { class: 'small' }, q.headline), table(pc, q.rows));
    }));
  return h('div', { 'data-cv-by-quarter': '1' },
    d.days_outside_quarters ? h('p', { class: 'small', 'data-cv-outside-quarters': '1' }, `${d.days_outside_quarters} day${d.days_outside_quarters === 1 ? '' : 's'} of the period ${d.days_outside_quarters === 1 ? 'is' : 'are'} not in a whole quarter and ${d.days_outside_quarters === 1 ? 'is' : 'are'} not shown here.`) : null,
    h('p', { class: 'small muted' }, 'Each quarter is combined on its own, by the same rule as the whole-period view: a file counts in a quarter only when its whole period lies inside that quarter.'),
    section('spending', 'Spending from settlement funds, by quarter', 'cq-spend-h'),
    section('use', 'Spent by allowable use (Exhibit E), by quarter', 'cq-use-h'),
    section('hiaa', 'Spent by High Impact Abatement Activity, by quarter', 'cq-hiaa-h'),
    section('outcome', 'Outcomes, by quarter', 'cq-outcome-h'),
    perQuarter);
}

// ---- submissions: import, and every file received ----
const SUB_STATUS = { current: ['Current', 'ok'], superseded: ['Replaced', ''], withdrawn: ['Withdrawn', 'warn'], key_compromised: ['Not counted: key compromised', 'danger'] };
async function submissionsTab() {
  const list = h('div', { 'data-cs-rows': '1' });
  const heading = h('h2', { id: 'cs-list-h', tabindex: '-1' }, 'Files received');
  const refresh = async () => {
    const rows = (await get('/api/county/submissions')).rows;
    list.replaceChildren(table([{ label: 'Program', render: s => s.programme }, { label: 'Period', render: periodText },
      { label: 'Made', render: s => fmt.date(s.generated_at) }, { label: 'Received', render: s => fmt.date(s.received_at) },
      { label: 'Status', render: s => badge(SUB_STATUS[s.status][0], SUB_STATUS[s.status][1]) },
      can('county:manage') ? { label: '', srLabel: 'Actions', render: s => (s.status === 'current' || s.status === 'key_compromised'
        ? h('button', { class: 'btn sm ghost', 'data-cs-withdraw': s.id, 'aria-label': `Withdraw ${s.programme}'s file for ${periodText(s)}`, onClick: () => withdraw(s, refresh, heading) }, 'Withdraw')
        : s.status === 'withdrawn' ? h('button', { class: 'btn sm ghost', 'data-cs-reinstate': s.id, 'aria-label': `Reinstate ${s.programme}'s file for ${periodText(s)}`, onClick: () => reinstate(s, refresh, heading) }, 'Reinstate') : null) } : null].filter(Boolean),
    rows, { empty: 'No files received yet.' }));
  };
  await refresh();
  return h('div', {}, can('county:manage') ? importCard(refresh) : null,
    h('section', { class: 'card mb', 'aria-labelledby': 'cs-list-h', 'data-cs-list': '1' }, h('div', { class: 'card-head' }, heading),
      h('p', { class: 'small muted' }, 'Current: the file that counts for its program and period. Replaced: a file made later for the same period counts instead. Withdrawn: taken out by the county; it can be reinstated. Which files count toward a period you choose is on the Combined view.'),
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
  const reason = await confirmDialog('Withdraw this file?', `${s.programme}'s file for ${periodText(s)} will no longer count. It is kept and can be reinstated; if it had replaced an earlier file for the same period, that one counts again.`,
    { danger: true, okText: 'Withdraw', requireReason: true, minLength: 3, maxLength: 500, reasonLabel: 'Why is it withdrawn? (kept in the audit log)' });
  if (!reason) return;
  try {
    const out = await post(`/api/county/submissions/${s.id}/withdraw`, { reason });
    await refresh(); focusList(heading);
    const msg = out.restored ? `Withdrawn. The earlier file for ${periodText(out.restored)} counts again.` : 'Withdrawn. It no longer counts.';
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
  const codeCard = h('section', { class: 'card mb', 'aria-labelledby': 'cp-code-h', 'data-cp-code-card': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cp-code-h' }, 'This county\'s code')),
    h('div', { class: 'county-code' }, h('code', { 'data-cp-code': '1' }, d.county_code)),
    h('p', { class: 'small' }, 'Give it to each program you fund. They type it on Settlement outcomes › Send to the county, so their file names this county: SUDS refuses a file made for another county. It is not a secret.'),
    h('div', { class: 'btn-row' }, copyButton(d.county_code, 'County code', { 'data-cp-code-copy': '1' })));
  return h('div', {}, codeCard,
    manage ? h('div', { class: 'row mb' }, h('button', { class: 'btn primary', 'data-cp-add': '1', onClick: () => programmeForm(null) }, 'Register a program')) : null,
    h('section', { class: 'card mb', 'aria-labelledby': 'cp-list-h', 'data-cp-list': '1' },
      h('div', { class: 'card-head' }, h('h2', { id: 'cp-list-h' }, 'Programs the county accepts files from')),
      h('p', { class: 'small muted' }, `Each is known by the public key it gave the county. ${HELP.fingerprint}`),
      table([{ label: 'Program', render: p => p.name }, { label: 'Key fingerprint', render: p => h('code', { class: 'small' }, p.fingerprint_display) },
        { label: 'Status', render: p => badge(p.active ? 'Active' : p.keep_files ? 'Inactive: files still counted' : 'Inactive: files not counted', p.active ? 'ok' : '') }, { label: 'Files counting', num: true, render: p => num(p.current_submissions) },
        { label: 'Last file received', render: p => (p.last_received ? fmt.date(p.last_received) : '—') },
        manage ? { label: '', srLabel: 'Actions', render: p => h('div', { class: 'row' }, h('button', { class: 'btn sm', 'data-cp-edit': p.id, 'aria-label': `Edit ${p.name}`, onClick: () => programmeForm(p) }, 'Edit'),
          h('button', { class: 'btn sm', 'data-cp-keys': p.id, 'aria-label': `Keys of ${p.name}`, onClick: () => keysDialog(p) }, 'Keys')) } : null].filter(Boolean),
      rows, { empty: 'No programs registered yet.' })),
    // County connection hook (views/countyconnect.js): each program's connection token, for county:manage.
    await programmeConnections(rows));
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
    extra: isNew ? null : h('div', {}, kv([['Current key fingerprint', h('code', {}, p.fingerprint_display)]]), h('p', { class: 'small muted' }, 'An inactive program\'s new files are refused. Its files already here stop counting, unless you keep them.')),
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
  const f = form([...KEY_FIELDS, { name: 'old_compromised', label: 'The old key was compromised: stop counting the files it signed', type: 'checkbox', span: true }],
    { submitText: 'Replace the key', onCancel: () => m.close(), onSubmit: async (d) => {
      await post(`/api/county/programmes/${p.id}/keys`, { public_key: d.public_key, fingerprint: d.fingerprint || undefined, compared: !!d.compared, old_compromised: !!d.old_compromised });
      m.close(); toast(`${p.name}'s key replaced. New files must be signed with it.`, 'ok'); nav('county?tab=programmes&t=' + Date.now());
    } });
  f.querySelector('[data-field=public_key]').append(fingerprintPreview(f.inputs.public_key));
  const m = modal(`Keys of ${p.name}`, h('div', { 'data-cp-keys-dialog': '1' },
    h('p', { class: 'small' }, `When ${p.name} makes a new key, add it here. Files its old key signed that are already here keep counting, unless you say the old key was compromised. New files must be signed with the current key.`),
    history, h('h3', {}, 'Replace the key'), f), { wide: true });
}
