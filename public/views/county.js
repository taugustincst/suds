import { h, route, get, post, put, fmt, can, pageHead, pageTabs, table, kv, nav, toast, modal, form, confirmDialog, emptyState, badge, loadingFor } from '../app.js';
import { fetchDownload } from './reports.js';

// The county view (server/county.js, server/routes/county.js; docs/COUNTY-VIEW.md). For a county that runs SUDS
// and funds programmes that do too: each programme sends the county a signed file of its settlement figures
// (Settlement outcomes › Send to the county); here the county registers each programme's key, imports the files
// and sees them side by side and summed for a period. Exact aggregate figures for authorised county staff; never
// a client of any programme, and nothing here is for publication.
//   #/county                   the combined view for a period (county:view)
//   #/county?tab=submissions   import a file, and every file received (import and withdraw: county:manage)
//   #/county?tab=programmes    the programmes whose files are accepted (register and change: county:manage)
loadingFor('county', () => 'Adding up the programmes\' submissions…');

const money = (n) => (typeof n === 'number' ? fmt.money(n) : '—');
const num = (n) => (typeof n === 'number' ? fmt.num(n) : '—');
const addMonths = (ym, n) => { let y = Number(ym.slice(0, 4)); let m = Number(ym.slice(5, 7)) + n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
/** The last complete calendar quarter before today. */
function lastQuarter(today) {
  const q0 = `${today.slice(0, 4)}-${String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}`;
  const start = addMonths(q0, -3);
  return { from: `${start}-01`, to: lastDay(addMonths(start, 2)) };
}
const STATUS = { whole: ['Submitted', 'ok'], part: ['Part of the period', 'warn'], none: ['Not submitted', 'danger'] };
const statusBadge = (s) => badge(STATUS[s][0], STATUS[s][1]);
const periodText = (s) => `${fmt.date(s.period_from)} – ${fmt.date(s.period_to)}`;

route('county', async (r) => {
  const tab = ['submissions', 'programmes'].includes(r.query.get('tab')) ? r.query.get('tab') : 'view';
  const tabs = pageTabs([['view', 'Combined view'], ['submissions', 'Submissions'], ['programmes', 'Programmes']], tab,
    (k) => nav(k === 'view' ? 'county' : `county?tab=${k}`), { label: 'County view sections' });
  const intro = h('p', { class: 'small', 'data-county-intro': '1' }, 'The settlement spending and outcomes the programmes the county funds send it, each as a file its own SUDS signed. Exact aggregate figures for authorised county staff: no client of any programme is ever in them, and nothing here is for publication.');
  const body = tab === 'programmes' ? await programmesTab() : tab === 'submissions' ? await submissionsTab() : await viewTab(r);
  return h('div', { 'data-county': tab }, pageHead('County view'), tabs, intro, body);
});

// ---- the combined view ----
async function viewTab(r) {
  const today = fmt.today(); const lq = lastQuarter(today);
  const from = r.query.get('from') || lq.from; const to = r.query.get('to') || lq.to;
  const fromI = h('input', { type: 'date', value: from, id: 'cv-from', 'aria-describedby': 'cv-range-err' });
  const toI = h('input', { type: 'date', value: to, id: 'cv-to', 'aria-describedby': 'cv-range-err' });
  const rangeErr = h('div', { class: 'err', id: 'cv-range-err', role: 'alert', style: { flexBasis: '100%' } });
  const go = (f, t) => {
    if (f && t && f > t) { rangeErr.textContent = `The start date (${fmt.date(f)}) is after the end date (${fmt.date(t)}). Choose a start date on or before the end date.`; for (const i of [fromI, toI]) i.setAttribute('aria-invalid', 'true'); fromI.focus(); return; }
    nav(`county?from=${f}&to=${t}`);
  };
  const y = Number(today.slice(0, 4));
  const controls = h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', { for: 'cv-from' }, 'From'), fromI), h('div', { class: 'field' }, h('label', { for: 'cv-to' }, 'To'), toI),
    h('button', { class: 'btn', 'data-cv-apply': '1', onClick: () => go(fromI.value, toI.value) }, 'Apply'),
    h('button', { class: 'btn ghost sm', onClick: () => go(lq.from, lq.to) }, 'Last quarter'),
    h('button', { class: 'btn ghost sm', onClick: () => go(`${y - 1}-01-01`, `${y - 1}-12-31`) }, `Year ${y - 1}`),
    h('button', { class: 'btn ghost sm', onClick: () => { const lm = addMonths(today.slice(0, 7), -1); go(`${addMonths(lm, -11)}-01`, lastDay(lm)); } }, 'Last 12 full months'),
    rangeErr);
  if (from > to) { rangeErr.textContent = `The start date (${fmt.date(from)}) is after the end date (${fmt.date(to)}). Choose a start date on or before the end date.`; return h('div', {}, controls); }
  const d = await get(`/api/county/view?from=${from}&to=${to}`);
  const caveats = h('section', { class: 'card mb', 'aria-labelledby': 'cv-caveats-h', 'data-cv-caveats': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cv-caveats-h' }, 'Read this first')),
    h('ul', {}, d.caveats.map(c => h('li', {}, c))),
    h('p', { class: 'small', 'data-cv-publication': '1' }, h('b', {}, 'Not for publication. '), d.publication_note),
    h('p', { class: 'small muted' }, d.rule));
  const download = (format) => fetchDownload(`/api/county/view/export?from=${from}&to=${to}${format === 'xlsx' ? '&format=xlsx' : ''}`)
    .then(() => toast('Downloaded. Internal, exact counts: for authorised county staff, not for publication.', 'ok')).catch(e => toast(e.message, 'error'));
  const actions = can('export:read') ? h('div', { class: 'row mb' }, h('button', { class: 'btn primary', 'data-cv-export': 'xlsx', onClick: () => download('xlsx') }, 'Download (Excel, internal)'),
    h('button', { class: 'btn', 'data-cv-export': 'csv', onClick: () => download('csv') }, 'CSV (internal)')) : null;
  if (!d.programmes.length) {
    return h('div', {}, controls, caveats, emptyState('No programmes registered', 'Register each programme the county funds, with the public key it gives you, under Programmes. Then import the files they send under Submissions.',
      can('county:manage') ? h('a', { class: 'btn primary', href: '#/county?tab=programmes' }, 'Register a programme') : null));
  }
  const who = h('section', { class: 'card mb', 'aria-labelledby': 'cv-who-h', 'data-cv-who': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cv-who-h' }, `Who has submitted for ${fmt.date(from)} – ${fmt.date(to)}`)),
    h('p', { class: 'small' }, `${d.submitted} of ${d.programmes.length} programme${d.programmes.length === 1 ? '' : 's'} submitted${d.not_submitted ? `; ${d.not_submitted} did not` : ''}.`),
    table([{ label: 'Programme', render: p => p.name }, { label: 'For this period', render: p => statusBadge(p.status) },
      { label: 'Submissions counted', render: p => (p.submissions.length ? p.submissions.map(s => h('div', {}, `${periodText(s)} · received ${fmt.date(s.received_at)}`)) : '—') },
      { label: 'Left out', render: p => (p.left_out.length ? p.left_out.map(s => h('div', { class: 'small' }, `${periodText(s)}: ${s.why === 'overlaps' ? 'inside a longer submission that counts' : 'not wholly inside this period'}`)) : '—') },
      { label: 'Key fingerprint', render: p => h('code', { class: 'small' }, p.fingerprint_display) }], d.programmes, { empty: 'No programmes.' }));
  const cols = [{ label: 'Measure', render: x => x.label }, ...d.programmes.map(p => ({ label: p.name, num: true, render: x => (x.money ? money(x.by[p.id]) : num(x.by[p.id])) })),
    { label: 'Total (summed)', num: true, render: x => h('b', {}, x.money ? money(x.total) : num(x.total)) }];
  const group = (g, title, id, note) => {
    const rows = d.rows.filter(x => x.group === g);
    return h('section', { class: 'card mb', 'aria-labelledby': id, 'data-cv-group': g },
      h('div', { class: 'card-head' }, h('h2', { id }, title)), note ? h('p', { class: 'small muted' }, note) : null,
      table(cols, rows, { empty: 'Nothing recorded for this period.' }));
  };
  return h('div', {}, controls, caveats, actions, who,
    group('spending', 'Spending from settlement funds', 'cv-spend-h'),
    group('use', 'Spent by allowable use (Exhibit E)', 'cv-use-h', 'Each fund\'s spending under its own Exhibit E category.'),
    group('hiaa', 'Spent by High Impact Abatement Activity', 'cv-hiaa-h', 'Everything the funds marked with each activity spent (approved or reimbursed).'),
    group('outcome', 'Outcomes', 'cv-outcome-h', 'People are counted by each programme and added up: a person served by two programmes counts twice. Not unduplicated across programmes.'));
}

// ---- submissions: import, and every file received ----
async function submissionsTab() {
  const list = h('div', { 'data-cs-rows': '1' });
  const refresh = async () => {
    const rows = (await get('/api/county/submissions')).rows;
    list.replaceChildren(table([{ label: 'Programme', render: s => s.programme }, { label: 'Period', render: periodText }, { label: 'Received', render: s => fmt.date(s.received_at) },
      { label: 'Status', render: s => badge(s.status === 'current' ? 'Counts' : s.status === 'superseded' ? 'Replaced by a later file' : 'Withdrawn', s.status === 'current' ? 'ok' : '') },
      { label: 'Key fingerprint', render: s => h('code', { class: 'small' }, s.fingerprint_display) },
      can('county:manage') ? { label: '', srLabel: 'Actions', render: s => (s.status === 'withdrawn' ? null : h('button', { class: 'btn sm ghost', 'data-cs-withdraw': s.id, 'aria-label': `Withdraw ${s.programme}'s file for ${periodText(s)}`, onClick: () => withdraw(s, refresh) }, 'Withdraw')) } : null].filter(Boolean),
    rows, { empty: 'No files received yet.' }));
  };
  await refresh();
  return h('div', {}, can('county:manage') ? importCard(refresh) : null,
    h('section', { class: 'card mb', 'aria-labelledby': 'cs-list-h', 'data-cs-list': '1' }, h('div', { class: 'card-head' }, h('h2', { id: 'cs-list-h' }, 'Files received')), list));
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
    h('div', { class: 'help', id: 'cs-file-help' }, 'The file a programme made under Settlement outcomes › Send to the county, unchanged. It must be signed with the key registered for that programme.')),
  h('div', { class: 'btn-row' }, btn));
  return h('section', { class: 'card mb', 'aria-labelledby': 'cs-import-h', 'data-cs-importer': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cs-import-h' }, 'Import a submission')),
    h('p', { class: 'small' }, 'SUDS checks the file was signed with the programme\'s registered key and not changed since, and that its period has ended. A second file for the same programme and period replaces the first, which is kept. The same file twice changes nothing.'),
    result, f);
}
async function withdraw(s, refresh) {
  const ok = await confirmDialog('Withdraw this file?', `${s.programme}'s file for ${periodText(s)} will no longer count in the combined view. It is kept, and the programme can send a new one.`, { danger: true, okText: 'Withdraw' });
  if (!ok) return;
  try { await post(`/api/county/submissions/${s.id}/withdraw`, {}); await refresh(); toast('Withdrawn. It no longer counts.', 'ok'); }
  catch (e) { toast(e.message, 'error'); }
}

// ---- programmes ----
async function programmesTab() {
  const rows = (await get('/api/county/programmes')).rows;
  const manage = can('county:manage');
  return h('div', {},
    manage ? h('div', { class: 'row mb' }, h('button', { class: 'btn primary', 'data-cp-add': '1', onClick: () => programmeForm(null) }, 'Register a programme')) : null,
    h('section', { class: 'card mb', 'aria-labelledby': 'cp-list-h', 'data-cp-list': '1' },
      h('div', { class: 'card-head' }, h('h2', { id: 'cp-list-h' }, 'Programmes the county accepts files from')),
      h('p', { class: 'small muted' }, 'Each is known by the public key it gave the county. Compare the fingerprint with the one the programme reads out from its Settlement outcomes page before trusting a key.'),
      table([{ label: 'Programme', render: p => p.name }, { label: 'Key fingerprint', render: p => h('code', { class: 'small' }, p.fingerprint_display) },
        { label: 'Status', render: p => badge(p.active ? 'Active' : 'Inactive', p.active ? 'ok' : '') }, { label: 'Files counting', num: true, render: p => num(p.current_submissions) },
        { label: 'Last file received', render: p => (p.last_received ? fmt.date(p.last_received) : '—') },
        manage ? { label: '', srLabel: 'Actions', render: p => h('button', { class: 'btn sm', 'data-cp-edit': p.id, 'aria-label': `Edit ${p.name}`, onClick: () => programmeForm(p) }, 'Edit') } : null].filter(Boolean),
      rows, { empty: 'No programmes registered yet.' })));
}
function programmeForm(p) {
  const isNew = !p;
  const shown = h('div', { class: 'help', 'data-cp-computed': '1', role: 'status' }, isNew ? 'The key\'s fingerprint shows here once you paste it.' : '');
  const fields = isNew
    ? [{ name: 'name', label: 'Programme name', required: true, span: true },
      { name: 'public_key', label: 'Public key', type: 'textarea', rows: 5, required: true, span: true, help: 'The block from "-----BEGIN PUBLIC KEY-----" to "-----END PUBLIC KEY-----" the programme sent you.' },
      { name: 'fingerprint', label: 'Fingerprint the programme read out (optional)', span: true, help: 'Eight groups of four characters. If you type it, SUDS refuses a key that does not match.' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: true }]
    : [{ name: 'name', label: 'Programme name', required: true, span: true }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: true },
      { name: 'active', label: 'Active: accept files from this programme', type: 'checkbox', value: p.active }];
  const f = form(fields, { values: p || {}, submitText: isNew ? 'Register' : 'Save', onCancel: () => m.close(), extra: isNew ? shown : h('div', {}, kv([['Key fingerprint', h('code', {}, p.fingerprint_display)]])),
    onSubmit: async (d) => {
      if (isNew) await post('/api/county/programmes', d);
      else await put(`/api/county/programmes/${p.id}`, { name: d.name, notes: d.notes, active: !!d.active });
      m.close(); toast(isNew ? `Registered ${d.name}.` : 'Saved.', 'ok'); nav('county?tab=programmes&t=' + Date.now());
    } });
  if (isNew) {
    const key = f.inputs.public_key;
    const check = async () => {
      const v = key.value.trim();
      if (!v) { shown.textContent = 'The key\'s fingerprint shows here once you paste it.'; return; }
      try {
        const x = await post('/api/county/fingerprint', { public_key: v }, { quiet: true });
        shown.textContent = `This key's fingerprint: ${x.fingerprint_display}. Check it with the programme before registering.${x.registered_as ? ` It is already registered, for ${x.registered_as}.` : ''}`;
      } catch (e) { shown.textContent = e.message; }
    };
    key.addEventListener('change', check); key.addEventListener('blur', check);
  }
  const m = modal(isNew ? 'Register a programme' : `Edit ${p.name}`, f, { wide: true });
}
