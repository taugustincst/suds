import { h, route, get, state, fmt, can, pageHead, stat, table, kv, nav, toast, emptyState, loadingFor } from '../app.js';
// Send to the county over the county connection (views/county-connect.js; built for 1.18.0), after the file card.
import { countySendCard } from './county-connect.js';
import { fetchDownload } from './reports.js';

// Settlement outcomes (1.17.0; server/settlement-outcomes.js, server/settlement-outcome-map.js): each opioid
// settlement fund's spending beside what the program recorded of the work charged to it, by category and by
// month, with the cost per outcome where that means something. For finance, supervisors and administrators.
// Every figure is aggregate; counts of people are small-cell suppressed as in the funder report unless exact
// counts are asked for. The files are made when the person asks for them, and SUDS sends them nowhere.
loadingFor('settlement', () => 'Adding up settlement spending and what it paid for…');

const addMonths = (ym, n) => { let y = Number(ym.slice(0, 4)); let m = Number(ym.slice(5, 7)) + n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const monthName = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
const money = (n) => (typeof n === 'number' ? fmt.money(n) : '—');
const val = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? fmt.num(v) : String(v));

route('settlement', async (r) => {
  const today = fmt.today();
  const to = r.query.get('to') || today;
  const from = r.query.get('from') || `${addMonths(today.slice(0, 7), -11)}-01`;
  const exactOk = can('reports:exact') || can('reports:funder');
  const counts = exactOk && r.query.get('counts') === 'exact' ? 'exact' : '';
  const qs = `from=${from}&to=${to}${counts ? '&counts=exact' : ''}`;
  // A period that ends before it starts is said at the dates (1.17.1), not run as an empty report: the server
  // refuses it too.
  const backwards = (f, t) => !!f && !!t && f > t;
  const rangeProblem = (f, t) => `The start date (${fmt.date(f)}) is after the end date (${fmt.date(t)}). Choose a start date on or before the end date.`;

  const fromI = h('input', { type: 'date', value: from, id: 'so-from', 'aria-describedby': 'so-range-err' }); const toI = h('input', { type: 'date', value: to, id: 'so-to', 'aria-describedby': 'so-range-err' });
  const rangeErr = h('div', { class: 'err', id: 'so-range-err', role: 'alert', 'data-so-range-error': '1', style: { flexBasis: '100%' } });
  const showRange = (msg) => {
    rangeErr.textContent = msg || '';
    for (const i of [fromI, toI]) { if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); }
  };
  for (const i of [fromI, toI]) i.addEventListener('change', () => { if (rangeErr.textContent && !backwards(fromI.value, toI.value)) showRange(''); });
  const countsSel = exactOk ? h('select', { id: 'so-counts', 'data-so-counts': '1' },
    h('option', { value: '', selected: !counts }, 'Hide small counts (as reported)'),
    h('option', { value: 'exact', selected: counts === 'exact' }, 'Exact counts (not for sharing)')) : null;
  const go = (f, t, c = countsSel ? countsSel.value : '') => (backwards(f, t) ? (showRange(rangeProblem(f, t)), fromI.focus()) : nav(`settlement?from=${f}&to=${t}${c ? `&counts=${c}` : ''}`));
  const q0 = `${today.slice(0, 5)}${String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}`;
  const controls = h('div', { class: 'filters settlement-controls' },
    h('div', { class: 'field' }, h('label', { for: 'so-from' }, 'From'), fromI), h('div', { class: 'field' }, h('label', { for: 'so-to' }, 'To'), toI),
    countsSel ? h('div', { class: 'field' }, h('label', { for: 'so-counts' }, 'Counts'), countsSel) : null,
    h('button', { class: 'btn', 'data-so-apply': '1', onClick: () => go(fromI.value, toI.value) }, 'Apply'),
    h('button', { class: 'btn ghost sm', onClick: () => go(`${q0}-01`, today) }, 'This quarter'),
    h('button', { class: 'btn ghost sm', onClick: () => go(`${today.slice(0, 4)}-01-01`, today) }, 'Year to date'),
    h('button', { class: 'btn ghost sm', onClick: () => go(`${addMonths(today.slice(0, 7), -11)}-01`, today) }, 'Last 12 months'),
    h('button', { class: 'btn ghost sm', onClick: () => { const lm = addMonths(today.slice(0, 7), -1); go(`${lm}-01`, lastDay(lm)); } }, 'Last month'),
    rangeErr);
  // Opened with such a period (a link, the address bar): the dates and what is wrong with them, and no report.
  if (backwards(from, to)) {
    showRange(rangeProblem(from, to));
    return h('div', { 'data-settlement-outcomes': '1' }, pageHead('Settlement outcomes'), controls);
  }
  const d = await get(`/api/reports/settlement-outcomes?${qs}`);
  const I = d.indicators;

  const download = (format) => fetchDownload(`/api/reports/settlement-outcomes/export?${qs}${format === 'xlsx' ? '&format=xlsx' : ''}`).then(() => toast('Downloaded. It is aggregate: no names or client codes.', 'ok')).catch(e => toast(e.message, 'error'));
  const actions = [h('button', { class: 'btn', 'data-so-print': '1', onClick: () => window.print() }, 'Print'),
    can('export:read') ? h('button', { class: 'btn primary', 'data-so-export': 'xlsx', onClick: () => download('xlsx') }, 'Download (Excel)') : null,
    can('export:read') ? h('button', { class: 'btn', 'data-so-export': 'csv', onClick: () => download('csv') }, 'CSV') : null];

  const suppressed = d.suppression.mode !== 'exact';
  const legend = suppressed ? `A count of people from 1 to ${d.suppression.threshold - 1} shows as "<${d.suppression.threshold}"; "suppressed" is hidden so that such a count cannot be worked out from the others. Money, kits, strips, syringes, contacts and hours are exact. No cost per outcome is shown beside a hidden count.` : 'Exact counts: every figure is the true number, including small groups of people. For the program\'s own use; not for publication or sharing.';
  const head = [
    pageHead('Settlement outcomes', ...actions),
    h('div', { class: 'settlement-print-head' }, h('p', {}, h('b', {}, `${state.org || ''} · Opioid settlement outcomes · ${fmt.date(from)} – ${fmt.date(to)}`), ` · ${d.suppression.label}`)),
    controls,
    h('p', { class: 'small settlement-note', 'data-so-note': '1' }, d.note),
    h('p', { class: 'small muted settlement-note', 'data-so-legend': '1' }, h('b', {}, d.suppression.label), '. ', legend),
  ];
  if (!d.funds.length) return h('div', { 'data-settlement-outcomes': '1' }, ...head, emptyState('No settlement funds', d.empty_note, can('budget:manage') ? h('a', { class: 'btn primary', href: '#/budget' }, 'Go to Funding & spending') : null));

  const t = d.total;
  const headline = ['naloxone_kits', 'reversals', 'people_served', 'people_linked', 'people_trained'];
  const totalCard = h('section', { class: 'card mb', 'aria-labelledby': 'so-total-h', 'data-so-total': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'so-total-h' }, `All settlement funds · ${fmt.date(from)} – ${fmt.date(to)}`)),
    h('div', { class: 'grid cols-4' }, stat('Spent (approved or reimbursed)', money(t.spend.approved)), stat('Pending approval', money(t.spend.pending)),
      ...headline.map(k => stat(I[k].short, val(t.values[k])))));

  const outcomesText = (x) => (x.indicators.length ? x.indicators.map(k => `${I[k].short}: ${val(x.values[k])}`).join(' · ') : 'No outcome SUDS records');
  const costText = (x) => { const k = x.indicators.find(i => I[i].cost); if (!k) return '—'; const c = x.cost_per[k]; return c === null || c === undefined ? '—' : `${fmt.money(c)} per ${I[k].unit}`; };
  const catCard = h('section', { class: 'card mb', 'aria-labelledby': 'so-cat-h', 'data-so-categories': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'so-cat-h' }, 'By settlement category')),
    h('p', { class: 'small muted' }, 'Each fund\'s spending under its own Exhibit E category, and what was recorded of the work charged to the funds in that category.'),
    table([{ label: 'Category (Exhibit E)', render: c => c.label }, { label: 'Funds', render: c => c.funds.join(', ') },
      { label: 'Spent under the category', render: c => money(c.spend_own_category), num: true }, { label: 'Outcomes', render: outcomesText }, { label: 'Cost per headline outcome', render: costText }],
    d.categories, { empty: 'No settlement categories.' }));

  const fundCard = (f) => {
    const hid = `so-fund-${f.id}`;
    const rows = f.indicators.map(k => ({ k, label: I[k].label, value: f.values[k], cost: I[k].cost ? f.cost_per[k] : undefined }));
    const trendCols = [{ label: 'Month', render: m => monthName(m.month) }, { label: 'Spent', render: m => money(m.spend), num: true },
      ...f.indicators.map(k => ({ label: I[k].short, render: m => val(m.values[k]), num: true }))];
    return h('section', { class: 'card mb settlement-fund', 'aria-labelledby': hid, 'data-so-fund': f.name },
      h('div', { class: 'card-head' }, h('h2', { id: hid }, f.name), f.is_active ? null : h('span', { class: 'badge' }, 'Inactive')),
      kv([f.grant_number ? ['Grant or agreement', f.grant_number] : null, ['Exhibit E category', `${f.schedule}: ${f.category_label}`], f.hiaa_label ? ['High Impact Abatement Activity', f.hiaa_label] : null,
        ['Kind of work', f.profile_label], ['Spent under its category', money(f.spend.own_category)], ['Spent under other categories', money(f.spend.other_categories)], ['Pending approval', money(f.spend.pending)]]),
      f.indicators.length
        ? table([{ label: 'Outcome', key: 'label' }, { label: 'Recorded', render: x => val(x.value), num: true },
          { label: 'Cost per', render: x => (x.cost === undefined ? '' : x.cost === null ? '—' : `${fmt.money(x.cost)} per ${I[x.k].unit}`), num: true }], rows, { wrap: true })
        : h('p', { class: 'small muted', 'data-so-no-outcome': '1' }, f.category === 'uncategorised' ? d.uncategorised_note : d.no_outcome_note),
      h('h3', { class: 'eyebrow mt' }, 'By month'),
      table(trendCols, f.months, { empty: 'No months in this period.' }));
  };

  return h('div', { 'data-settlement-outcomes': '1' }, ...head, totalCard, catCard, ...d.funds.map(fundCard), countyCard(from, to), countySendCard(from, to),
    h('details', { class: 'small muted' }, h('summary', {}, 'How the counts were made'), h('p', {}, d.counting_statement)));
});

// Send to the county (docs/COUNTY-VIEW.md; server/county.js): the period's figures as a signed file for the county
// that funds the programme, for whoever files its funder submission. Office server only: SUDS on this device has
// no county relationship, and its kernel has no such route.
function countyCard(from, to) {
  if (state.local || !can('reports:funder') || !can('budget:read') || !can('export:read')) return null;
  const keyBox = h('div', { 'data-so-county-key': '1' });
  const showKey = (k) => {
    keyBox.replaceChildren(k
      ? h('div', {}, kv([['This server\'s key fingerprint', h('code', { 'data-so-county-fingerprint': '1' }, k.fingerprint_display)], ['Made', fmt.date(k.created_at)]]),
        h('details', { class: 'small' }, h('summary', {}, 'Public key (to give the county once)'), h('pre', { class: 'note', 'data-so-county-pem': '1' }, k.public_key)))
      : h('p', { class: 'small muted' }, 'This server\'s signing key is made the first time a county file is made. Give the county its public key and read the fingerprint out to them, once, so they can check your files came from you.'));
  };
  get('/api/county-submission/key', { quiet: true }).then(x => showKey(x.key)).catch(() => showKey(null));
  const make = () => fetchDownload(`/api/county-submission/file?from=${from}&to=${to}`)
    .then(async () => { toast('County file made and downloaded. Send it to the county as your contract says; it holds exact counts and is not for publication.', 'ok'); try { showKey((await get('/api/county-submission/key', { quiet: true })).key); } catch { /* the file is made */ } })
    .catch(e => toast(e.message, 'error'));
  return h('section', { class: 'card mb', 'aria-labelledby': 'so-county-h', 'data-so-county': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'so-county-h' }, 'Send to the county')),
    h('p', { class: 'small' }, `Makes a file of these settlement figures for ${fmt.date(from)} – ${fmt.date(to)} for the county that funds the program, signed by this server so the county can check it came from you unchanged. It holds exact counts, small numbers included, and money: aggregate figures only, with no names, client codes, dates of birth or single events.`),
    h('p', { class: 'small', 'data-so-county-leaves': '1' }, h('b', {}, 'It leaves the program. '), 'It is for the county under your funding contract, not for publication or sharing. Making it is recorded in the audit log. SUDS sends nothing itself: you send the file the way the county asks.'),
    keyBox,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', 'data-so-county-file': '1', onClick: make }, 'Make the county file')));
}
