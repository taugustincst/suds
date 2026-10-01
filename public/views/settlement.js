import { h, route, get, post, put, del, state, fmt, can, pageHead, stat, table, kv, nav, toast, emptyState, loadingFor, confirmDialog, announce, badge } from '../app.js';
// Send to the county over the county connection (views/countyconnect.js; built for 1.18.0), after the file card.
import { countySendCard } from './countyconnect.js';
import { fetchDownload } from './reports.js';
import { submissionPeriods, monthsLabel, isQuarter } from '../county-periods.js';

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

  // The county card's choices (period, county code and name, funds), shared with the connection's Send so that Send
  // now sends exactly the file Download makes.
  const countyChoice = {};
  const schedule = scheduleCard(countyChoice);
  // Arrived from a reminder on Home (?card=schedule): the keyboard goes to the reporting schedule once it is drawn.
  if (schedule && r && r.query && r.query.get('card') === 'schedule') setTimeout(() => { const el = schedule.querySelector('#so-schedule-h'); if (el && el.isConnected) { el.focus(); el.scrollIntoView({ block: 'start' }); } }, 0);
  return h('div', { 'data-settlement-outcomes': '1' }, ...head, totalCard, catCard, ...d.funds.map(fundCard), countyCard(from, to, countyChoice), countySendCard(countyChoice), schedule,
    h('details', { class: 'small muted' }, h('summary', {}, 'How the counts were made'), h('p', {}, d.counting_statement)));
});

// Send to the county (docs/COUNTY-VIEW.md; server/county.js): a quarter's figures, for the settlement funds the
// county pays for, as a signed file for that county, for whoever files the program's funder submission. It has its
// own period (a quarter that has ended, by default the last one), apart from the dates the page shows. Office server
// only: SUDS on this device has no county relationship, and its kernel has no such route.
function countyCard(pageFrom, pageTo, choice = {}) {
  if (state.local || !can('reports:funder') || !can('budget:read') || !can('export:read')) return null;
  const today = fmt.today();
  const body = h('div', { 'data-so-county-body': '1' }, h('p', { class: 'small muted' }, 'Loading…'));
  const card = h('section', { class: 'card mb', 'aria-labelledby': 'so-county-h', 'data-so-county': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'so-county-h' }, 'Send to the county')),
    h('p', { class: 'small' }, 'Makes a file of the program\'s settlement figures for a period, for the county that funds it, signed by this server so the county can check it came from you unchanged. It holds exact counts, small numbers included, and money: aggregate figures only, with no names, client codes, dates of birth or single events.'),
    h('p', { class: 'small', 'data-so-county-leaves': '1' }, h('b', {}, 'It leaves the program. '), 'It is for the county under your funding contract, not for publication or sharing. Making it is recorded in the audit log. SUDS sends nothing itself: you send the file the way the county asks.'),
    body);
  Promise.all([get('/api/county-submission/key', { quiet: true }), get('/api/county-submission/options', { quiet: true }), get('/api/county-submission/reminders', { quiet: true }).catch(() => null)])
    .then(([k, o, rem]) => body.replaceChildren(countyForm(k, o, today, pageFrom, pageTo, choice, rem)))
    .catch(e => body.replaceChildren(h('p', { class: 'err', role: 'alert' }, e.message)));
  return card;
}
function countyForm(k, o, today, pageFrom, pageTo, choice, rem = null) {
  const last = o.counties[0] || null;
  // The period: the quarters that have ended (the last one first, and chosen), fiscal years, the last calendar year,
  // and the dates on this page when they have ended and are not already offered.
  const periods = submissionPeriods(today);
  if (pageTo < today && pageFrom <= pageTo && !periods.some(p => p.from === pageFrom && p.to === pageTo)) periods.push({ key: 'page', label: `The dates on this page (${monthsLabel(pageFrom, pageTo)})`, from: pageFrom, to: pageTo });
  const periodSel = h('select', { id: 'so-county-period', 'data-so-county-period-select': '1', 'aria-describedby': 'so-county-period-warn' }, periods.map(p => h('option', { value: p.key, selected: !!p.default }, p.label)));
  const chosen = () => periods.find(p => p.key === periodSel.value) || periods[0];
  const periodShown = h('strong', { 'data-so-county-period': '1' });
  const warn = h('div', { class: 'help', id: 'so-county-period-warn', 'data-so-county-period-warn': '1' });
  const makeBtn = h('button', { class: 'btn primary', type: 'submit', 'data-so-county-file': '1' });
  const showPeriod = () => {
    const p = chosen();
    periodShown.textContent = `${fmt.date(p.from)} – ${fmt.date(p.to)}`;
    makeBtn.textContent = `Make the county file for ${monthsLabel(p.from, p.to)}`;
    warn.textContent = isQuarter(p.from, p.to) ? '' : '⚠ This is not a single quarter. The county counts a file only when its whole period lies inside the period it looks at, so a longer file never counts toward one quarter. Send quarters unless the county asked for this period.';
  };
  periodSel.addEventListener('change', () => { showPeriod(); if (choice.onChange) choice.onChange(); });
  const codeI = h('input', { id: 'so-county-code', name: 'county_code', value: last ? last.code_display : '', autocomplete: 'off', 'aria-describedby': 'so-county-code-help', 'data-so-county-code': '1' });
  const nameI = h('input', { id: 'so-county-name', name: 'county_name', value: last ? last.name : '', autocomplete: 'off', maxlength: 200, 'data-so-county-name': '1' });
  const picked = new Set(last ? last.fund_ids : []);
  const fundBoxes = o.funds.map(f => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'so-county-fund', value: f.id, checked: picked.has(f.id), 'data-so-county-fund': f.id }),
    `${f.name}${f.grant_number ? ` (${f.grant_number})` : ''}${f.is_active ? '' : ' (inactive)'}`));
  const funds = h('fieldset', { class: 'field span', 'data-so-county-funds': '1', 'aria-describedby': 'so-county-funds-help' },
    h('legend', {}, 'Settlement funds this county pays for'),
    o.funds.length ? fundBoxes : h('p', { class: 'small muted' }, 'No funding source is marked as opioid settlement money.'),
    h('div', { class: 'help', id: 'so-county-funds-help' }, 'Only the funds you tick go into the file, and every total in it is over them alone: a fund another funder pays for stays out. Nothing is ticked until you choose; SUDS remembers your choice for this county.'));
  // The file's version (1.22.0; server/county.js chooseVersion, which this mirrors): version 2, with each fund's award,
  // only when the county is known to read it — the county connection says so for this county code, or the program
  // answered that the county runs SUDS 1.21 or later. Otherwise version 1, which a county on SUDS 1.20 or earlier reads
  // too (it refuses version 2). Asked once for each county code, and remembered with it.
  const conn = (rem && rem.connection) || { connected: false };
  const SCHEMA_V = o.schema_version || 2;
  const norm = (v) => String(v || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const known = () => o.counties.find(c => c.code === norm(codeI.value)) || null;
  const connReads = () => (conn.connected && conn.county_code && norm(conn.county_code) === norm(codeI.value) && Array.isArray(conn.county_reads) && conn.county_reads.length ? conn.county_reads : null);
  const olderHere = () => { const r = connReads(); return !!(r && !r.includes(SCHEMA_V)); };
  const SUDS_CHOICES = [['1.21+', 'SUDS 1.21 or later'], ['1.20-', 'SUDS 1.20 or earlier'], ['unknown', 'Don\'t know']];
  const radios = SUDS_CHOICES.map(([value]) => h('input', { type: 'radio', name: 'so-county-suds', id: `so-county-suds-${value.replace(/\W/g, '')}`, value, 'data-so-county-suds': value }));
  const answer = () => (radios.find(r => r.checked) || {}).value || null;
  const versionNow = () => {
    const r = connReads();
    if (r) return { version: r.includes(SCHEMA_V) ? SCHEMA_V : 1, source: 'connection' };
    const a = answer();
    return a === '1.21+' ? { version: SCHEMA_V, source: 'answer' } : { version: 1, source: a ? 'answer' : 'unknown' };
  };
  const olderNote = h('div', { class: 'banner warn small', 'data-so-county-older': '1', hidden: !olderHere() }, conn.county_older_note || '');
  const asked = h('p', { class: 'small', 'data-so-county-suds-ask': '1' }, 'SUDS asks this once for each county code and remembers your answer.');
  const outcome = h('p', { class: 'small', role: 'status', 'aria-live': 'polite', 'data-so-county-version-made': '' });
  const showVersion = (fromCode) => {
    if (fromCode) { const k = known(); for (const r of radios) r.checked = !!(k && k.county_suds === r.value); }
    olderNote.hidden = !olderHere();
    asked.hidden = !!(known() && known().county_suds) || !!connReads();
    const v = versionNow();
    outcome.setAttribute('data-so-county-version-made', String(v.version));
    outcome.textContent = v.version >= 2
      ? `This file will be version ${v.version}, with each fund's award or contract amount and award period${v.source === 'connection' ? ' (the county connection says this county\'s SUDS reads it)' : ''}.`
      : `This file will be version 1, without award amounts: award amounts need the county on SUDS 1.21 or later${v.source === 'connection' ? ', and the county connection says this county\'s SUDS reads version 1 only' : answer() === '1.20-' ? '' : ' (choose "SUDS 1.21 or later" once you know it is)'}. Ask the county to upgrade if it has not.`;
  };
  codeI.addEventListener('change', () => showVersion(true));
  for (const r of radios) r.addEventListener('change', () => showVersion(false));
  const version = h('fieldset', { class: 'field span', 'data-so-county-version': '1', 'aria-describedby': 'so-county-suds-help' },
    h('legend', {}, 'Which SUDS does this county run?'),
    olderNote, asked,
    SUDS_CHOICES.map(([value, label], i) => h('label', { class: 'check', for: radios[i].id }, radios[i], label)),
    h('div', { class: 'help', id: 'so-county-suds-help' }, 'The county\'s SUDS reads the file. SUDS 1.21 or later reads version 2, which carries each fund\'s award or contract amount and award period (from Funding & spending), so the county can see spending against the award. SUDS 1.20 or earlier refuses version 2, so unless you know the county runs 1.21 or later the file is version 1, without the award. The county\'s County view shows its version (Help › About).'),
    outcome);
  showVersion(true);
  const err = h('div', { class: 'err', role: 'alert', 'data-so-county-error': '1' });
  const keyBox = h('div', { 'data-so-county-key': '1' });
  const showKey = (key, retired, fresh) => keyBox.replaceChildren(key
    ? h('div', {},
      fresh ? h('div', { class: 'banner info', role: 'status', 'data-so-county-newkey': '1' }, `New key made. Read its fingerprint to the county, and send it the public key, before you send a file signed with it: ${key.fingerprint_display}`) : null,
      kv([['This server\'s key fingerprint', h('span', {}, h('code', { 'data-so-county-fingerprint': '1' }, key.fingerprint_display), ' ', copyBtn(key.fingerprint_display, 'Fingerprint', 'data-so-county-copy-fingerprint'))], ['Made', fmt.date(key.created_at)]]),
      h('p', { class: 'small muted' }, 'A fingerprint is a short code worked out from the key. Read it out to the county (by phone, at a meeting) so it knows the key is yours.'),
      h('details', { class: 'small' }, h('summary', {}, 'Public key (to give the county once)'),
        h('pre', { class: 'note county-pem', 'data-so-county-pem': '1' }, key.public_key), copyBtn(key.public_key, 'Public key', 'data-so-county-copy-pem')),
      retired && retired.length ? h('p', { class: 'small muted', 'data-so-county-retired': '1' }, `Keys retired: ${retired.map(r => `${r.fingerprint_display} (retired ${fmt.date(r.retired_at)})`).join('; ')}.`) : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn ghost sm', type: 'button', 'data-so-county-newkey-btn': '1', onClick: newKey }, 'Make a new key')))
    : h('div', {}, h('p', { class: 'small muted' }, 'This server has no county signing key yet. Show it to give the county its public key and read the fingerprint out to them, once, so they can check your files came from you.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', 'data-so-county-show-key': '1', onClick: async () => {
        try { const x = await post('/api/county-submission/key', {}); showKey(x.key, x.retired); const c = keyBox.querySelector('[data-so-county-fingerprint]'); announce(`This server's key fingerprint: ${x.key.fingerprint_display}`); if (c) c.closest('dd').querySelector('button').focus(); }
        catch (e) { toast(e.message, 'error'); }
      } }, 'Show the key for the county'))));
  async function newKey() {
    const ok = await confirmDialog('Make a new key?', 'The current key is retired and a new one made. Files you make from now on are signed with the new key, and the county must register it (you read its fingerprint to them again) before it can import them. Do this when the key may have been lost or exposed, or when the county asks.', { danger: true, okText: 'Make a new key' });
    if (!ok) return;
    try { const x = await post('/api/county-submission/key/new', {}); showKey(x.key, x.retired, true); keyBox.querySelector('[data-so-county-newkey]').setAttribute('tabindex', '-1'); keyBox.querySelector('[data-so-county-newkey]').focus(); }
    catch (e) { toast(e.message, 'error'); }
  }
  showKey(k.key, k.retired);
  showPeriod();
  const tickedFunds = () => fundBoxes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value);
  /** The choices checked as Make the county file checks them: null, with the problem said and focused, if one is missing. */
  const checked = () => {
    const ids = tickedFunds();
    const problem = !codeI.value.trim() ? [codeI, 'Type the county code the county gave you (County view › Programs on its SUDS shows it).']
      : !nameI.value.trim() ? [nameI, 'Type the county\'s name.'] : !ids.length ? [funds.querySelector('input') || funds, 'Tick the settlement funds this county pays for.'] : null;
    for (const i of [codeI, nameI]) i.removeAttribute('aria-invalid');
    if (problem) { err.textContent = problem[1]; if (problem[0].tagName === 'INPUT' && problem[0].type !== 'checkbox') problem[0].setAttribute('aria-invalid', 'true'); problem[0].focus(); return null; }
    err.textContent = '';
    const p = chosen();
    return { from: p.from, to: p.to, funds: ids, county_code: codeI.value.trim(), county_name: nameI.value.trim() };
  };
  // For the county connection's Send (views/countyconnect.js): the same choices, the same checks.
  choice.checked = checked;
  choice.period = () => chosen();
  if (choice.onChange) choice.onChange();
  const f = h('form', { noValidate: true, 'data-so-county-form': '1', onSubmit: (e) => {
    e.preventDefault();
    const c = checked(); if (!c) return;
    // Asked once per county code: which SUDS the county runs ("Don't know" is an answer), unless its connection says.
    // Only for a file made here: the connection's Send makes what the county's /status says it reads.
    if (!connReads() && !answer()) { err.textContent = 'Choose which SUDS the county runs — "Don\'t know" is fine: the file is then version 1, which every county reads.'; radios[0].focus(); return; }
    const ids = c.funds; const p = chosen();
    const a = answer(); const v = versionNow();
    makeBtn.disabled = true;
    fetchDownload(`/api/county-submission/file?from=${p.from}&to=${p.to}&county_code=${encodeURIComponent(codeI.value.trim())}&county_name=${encodeURIComponent(nameI.value.trim())}&funds=${ids.map(encodeURIComponent).join(',')}${a ? `&county_suds=${encodeURIComponent(a)}` : ''}`)
      .then(async () => {
        // Remembered for this county code (the server keeps it with the county's name and funds).
        const k = known(); if (k) k.county_suds = a || k.county_suds; else o.counties.unshift({ code: norm(codeI.value), county_suds: a });
        showVersion(false);
        toast(`County file for ${monthsLabel(p.from, p.to)} made and downloaded${v.version < 2 ? ' (version 1, without the award)' : ''}. Send it to the county as your contract says; it holds exact counts and is not for publication.`, 'ok'); if (choice.onMade) choice.onMade(); try { const x = await get('/api/county-submission/key', { quiet: true }); showKey(x.key, x.retired); } catch { /* the file is made */ } })
      .catch(e2 => { err.textContent = e2.message; })
      .finally(() => { makeBtn.disabled = false; });
  } },
  h('div', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', { for: 'so-county-code' }, 'County code'), codeI, h('div', { class: 'help', id: 'so-county-code-help' }, 'Eight letters and digits the county gives you (its County view › Programs page shows it). The county refuses a file made for another county.')),
    h('div', { class: 'field' }, h('label', { for: 'so-county-name' }, 'County name'), nameI),
    funds,
    h('div', { class: 'field span' }, h('label', { for: 'so-county-period' }, 'Period'), periodSel, warn),
    version),
  h('p', { class: 'county-period' }, 'Period: ', periodShown),
  err,
  h('div', { class: 'btn-row' }, makeBtn));
  return h('div', {}, f, h('h3', {}, 'This server\'s key'), keyBox);
}
function copyBtn(value, what, attr) {
  return h('button', { class: 'btn sm', type: 'button', [attr]: '1', onClick: async () => {
    try { await navigator.clipboard.writeText(value); toast(`${what} copied.`, 'ok'); } catch { toast(`Could not copy: select the ${what.toLowerCase()} and copy it yourself.`, 'error'); }
  } }, `Copy ${what.toLowerCase()}`);
}

// The county's reporting schedule (released in 1.21.0; server/county-schedule.js): which periods each
// county expects, by when, and whether the file for each was made or sent. Home shows the same reminders. A county
// connected over the county connection says its own schedule (and what it received); for any other county the program
// records it here. Office server only, for whoever makes the county file.
const STATE_WORDS = { received: ['Received by the county', 'ok'], sent: ['Sent', 'ok'], made: ['Made', 'ok'], made_not_sent: ['Made, not yet received', 'warn'], due: ['Not yet made', 'warn'], overdue: ['Overdue', 'danger'] };
function scheduleCard(choice = {}) {
  if (state.local || !can('reports:funder') || !can('budget:read') || !can('export:read')) return null;
  const body = h('div', { 'data-so-schedule-body': '1' }, h('p', { class: 'small muted' }, 'Loading…'));
  const heading = h('h2', { id: 'so-schedule-h', tabindex: '-1' }, 'County reporting schedule');
  const card = h('section', { class: 'card mb', 'aria-labelledby': 'so-schedule-h', 'data-so-schedule': '1' }, h('div', { class: 'card-head' }, heading),
    h('p', { class: 'small' }, 'The periods each county expects a file for, when each is due, and whether it was made or sent. Home reminds you of a file not yet made. A county connected to this server says its own schedule; for any other county, record it here.'),
    body);
  const load = async (focusResult) => {
    try { draw(await get('/api/county-submission/reminders', { quiet: true }), focusResult); }
    catch (e) { body.replaceChildren(h('p', { class: 'err', role: 'alert' }, e.message)); }
  };
  const draw = (d, focusResult) => {
    const result = h('div', { class: 'hidden', tabindex: '-1', 'data-so-schedule-result': '1' });
    const lists = d.counties.map(c => h('div', { class: 'mb', 'data-so-schedule-county': c.county_code },
      h('h3', {}, `${c.county_name || 'County'} (county code ${c.county_code_display})`),
      h('p', { class: 'small' }, `${c.cadence_label}; each file due ${c.due_days} day${c.due_days === 1 ? '' : 's'} after its period ends. `,
        c.source === 'county' ? h('span', { 'data-so-schedule-source': 'county' }, `Said by the county through the connection${c.checked_at ? ` (last asked ${fmt.date(c.checked_at)})` : ''}.`) : h('span', { 'data-so-schedule-source': 'programme' }, `Recorded here; reminders from ${fmt.date(c.start)}.`)),
      table([{ label: 'Period', render: p => p.label || `${fmt.date(p.from)} – ${fmt.date(p.to)}` }, { label: 'Due by', render: p => fmt.date(p.due_by) },
        { label: 'File', render: p => h('span', { 'data-so-schedule-state': p.state }, badge(STATE_WORDS[p.state][0], STATE_WORDS[p.state][1]), p.made && p.state !== 'received' ? h('span', { class: 'small muted' }, ` made ${fmt.date(p.made.at)}${p.made.schema_version === 1 ? ' (version 1)' : ''}`) : null) }],
      c.periods, { empty: 'No period has ended since reminders start.' }),
      c.schedule ? h('div', { class: 'btn-row' }, h('button', { class: 'btn sm ghost', type: 'button', 'data-so-schedule-remove': c.county_code, 'aria-label': `Stop reminders for ${c.county_name || c.county_code_display}`, onClick: async () => {
        if (!await confirmDialog('Stop these reminders?', `Home stops reminding you of files for ${c.county_name || c.county_code_display}${c.source === 'county' ? ' that this server recorded (the connected county\'s own schedule still applies)' : ''}.`, { okText: 'Stop reminders' })) return;
        try { await del(`/api/county-submission/schedules/${encodeURIComponent(c.county_code)}`); toast('Reminders stopped.', 'ok'); await load(); heading.focus(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Stop reminders')) : null));
    // Record a schedule: the county's code and name (the card's, by default), how often, when due, and the first period.
    const codeI = h('input', { id: 'so-schedule-code', name: 'county_code', autocomplete: 'off', 'aria-describedby': 'so-schedule-code-help', 'data-so-schedule-code': '1', value: (document.getElementById('so-county-code') || {}).value || '' });
    const nameI = h('input', { id: 'so-schedule-name', name: 'county_name', autocomplete: 'off', maxlength: 200, 'data-so-schedule-name': '1', value: (document.getElementById('so-county-name') || {}).value || '' });
    const cadI = h('select', { id: 'so-schedule-cadence', name: 'cadence', 'data-so-schedule-cadence': '1' }, d.cadences.map(x => h('option', { value: x.value }, x.label)));
    const dueI = h('input', { id: 'so-schedule-due', name: 'due_days', type: 'number', min: 1, max: d.due_days_max, value: String(d.due_days_default), inputmode: 'numeric', 'aria-describedby': 'so-schedule-due-help', 'data-so-schedule-due': '1' });
    const startI = h('input', { id: 'so-schedule-start', name: 'start', type: 'date', 'aria-describedby': 'so-schedule-start-help', 'data-so-schedule-start': '1' });
    const err = h('div', { class: 'err', role: 'alert', id: 'so-schedule-err', 'data-so-schedule-error': '1' });
    const inputs = { county_code: codeI, county_name: nameI, cadence: cadI, due_days: dueI, start: startI };
    const f = h('form', { noValidate: true, 'data-so-schedule-form': '1', onSubmit: async (e) => {
      e.preventDefault();
      for (const i of Object.values(inputs)) i.removeAttribute('aria-invalid');
      err.textContent = '';
      const code = codeI.value.trim().replace(/[\s-]/g, '');
      if (!code) { err.textContent = 'Type the county code the county gave you.'; codeI.setAttribute('aria-invalid', 'true'); codeI.focus(); return; }
      try {
        const out = await put(`/api/county-submission/schedules/${encodeURIComponent(code)}`, { county_name: nameI.value.trim(), cadence: cadI.value, due_days: dueI.value === '' ? undefined : Number(dueI.value), start: startI.value || undefined }, { quiet: true });
        draw(out, true);
      } catch (x) {
        const fields = (x.data && x.data.fields) || {};
        const first = Object.keys(fields).find(k => inputs[k]);
        err.textContent = x.message;
        for (const k of Object.keys(fields)) if (inputs[k]) inputs[k].setAttribute('aria-invalid', 'true');
        (first ? inputs[first] : codeI).focus();
      }
    } },
    h('div', { class: 'form-grid' },
      h('div', { class: 'field' }, h('label', { for: 'so-schedule-code' }, 'County code'), codeI, h('div', { class: 'help', id: 'so-schedule-code-help' }, 'The code on the Send to the county card above.')),
      h('div', { class: 'field' }, h('label', { for: 'so-schedule-name' }, 'County name'), nameI),
      h('div', { class: 'field' }, h('label', { for: 'so-schedule-cadence' }, 'The county expects a file'), cadI),
      h('div', { class: 'field' }, h('label', { for: 'so-schedule-due' }, 'Days after a period ends that its file is due'), dueI, h('div', { class: 'help', id: 'so-schedule-due-help' }, `1 to ${d.due_days_max}, as your contract says (${d.due_days_default} if you are not sure).`)),
      h('div', { class: 'field' }, h('label', { for: 'so-schedule-start' }, 'Remind from (optional)'), startI, h('div', { class: 'help', id: 'so-schedule-start-help' }, 'Periods starting before this day are never reminded about. Left empty: the last period that has ended, so files you sent before are not called missing.'))),
    err,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'submit', 'data-so-schedule-save': '1' }, 'Save the schedule')));
    body.replaceChildren(result, ...(lists.length ? lists : [h('p', { class: 'small muted', 'data-so-schedule-none': '1' }, 'No county schedule yet: Home has nothing to remind you of.')]),
      h('details', { 'data-so-schedule-add': '1', open: !lists.length }, h('summary', {}, 'Record a county\'s schedule'), f));
    if (focusResult) {
      result.setAttribute('role', 'status'); result.className = 'banner info'; result.textContent = d.reminders.length ? `Saved. ${d.reminders.length} file${d.reminders.length === 1 ? ' is' : 's are'} not yet made or sent.` : 'Saved. Every file due so far is made or sent.';
      result.focus();
    }
  };
  choice.onMade = () => load();
  load();
  return card;
}
