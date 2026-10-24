// Group and community prevention events (1.17.0): SABG primary prevention recorded as events — presentations,
// trainings, community events, media campaigns, coalition work — with their CSAP strategy and IOM population
// category, hours and a headcount (never names), and the prevention activity summary for a period
// (server/prevention.js). Recorded by whoever records visits; an event is its worker's, or a supervisor's, to change.
import { h, route, get, post, put, del, state, form, modal, toast, table, fmt, can, pageHead, nav, emptyState, confirmDialog, discardDraft, kv, mayChange, ownedNotice, pageTabs, stat, downloadCsv } from '../app.js';

const pad = (x) => String(x).padStart(2, '0');
/** The first day of the month two months back, and today: a quarter's worth of events to start with. */
function defaultRange() {
  const t = fmt.today(); let y = Number(t.slice(0, 4)); let m = Number(t.slice(5, 7)) - 2;
  if (m < 1) { m += 12; y -= 1; }
  return [`${y}-${pad(m)}-01`, t];
}
const label = (code, list) => (code ? fmt.label(code, list) : '—');
const num = (v) => fmt.num(Number(v) || 0);
const hours = (v) => { const n = Number(v) || 0; return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')} h`; };

export function openPreventionForm(row, { onDone } = {}) {
  const funds = state.funds || [];
  const f = form([
    { name: 'event_date', label: 'Date', type: 'date', required: true },
    { name: 'title', label: 'Event', required: true, maxLen: 200, placeholder: 'e.g. Parent night on vaping, Lincoln Middle School', help: 'What it was, in a few words. No participants\' names.' },
    { name: 'event_type', label: 'Kind of event', type: 'select', list: 'PREVENTION_EVENT_TYPES', required: true, placeholder: '— choose —',
      help: `A ${fmt.label('training', 'PREVENTION_EVENT_TYPES').toLowerCase()} counts its attendance as people trained.` },
    { name: 'strategy', label: 'Strategy (CSAP)', type: 'select', list: 'PREVENTION_STRATEGIES', required: true, placeholder: '— choose —',
      help: 'The prevention strategy this event mainly used, as SABG prevention reporting groups it.' },
    { name: 'iom_category', label: 'Population (IOM category)', type: 'select', list: 'PREVENTION_IOM', required: true, placeholder: '— choose —',
      help: 'Universal: everyone in a population (direct, in person; indirect, such as media). Selective: a group at higher risk. Indicated: people already showing early signs.' },
    { name: 'audience', label: 'Audience', type: 'select', list: 'PREVENTION_AUDIENCES' },
    { name: 'location', label: 'Where', maxLen: 200, placeholder: 'e.g. Lincoln Middle School, Redding' },
    { name: 'attendance', label: 'Attendance', type: 'number', min: 0, step: 1, help: 'How many people came, or were reached. A count only: no names.' },
    { name: 'attendance_estimated', label: 'Attendance is an estimate (for example, a media campaign\'s reach)', type: 'checkbox' },
    { name: 'hours', label: 'Hours', type: 'number', min: 0, max: 1000, step: 0.25, help: 'How long the event, or the work on it, took.' },
    funds.length ? { name: 'funding_source_id', label: 'Funding source', type: 'fund' } : null,
    ...(!row && can('records:manage-others') ? [{ name: 'user_id', label: 'Worker (defaults to you)', type: 'user' }] : []),
    { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 3, help: 'Stored encrypted. No participants\' names.' },
  ].filter(Boolean), {
    // A new event is charged to the worker's default fund (or the program's), as a new visit is.
    values: row || { event_date: fmt.today(), attendance: 0, hours: 1, funding_source_id: state.defaultFundId && funds.some(x => x.id === state.defaultFundId) ? state.defaultFundId : '' },
    submitText: row ? 'Save' : 'Record event',
    draftKey: row ? `prevention:${row.id}` : 'prevention:new',
    onCancel: () => m.close(),
    onSubmit: async (d) => {
      if (!d.user_id) delete d.user_id;
      if (row) await put(`/api/prevention-events/${row.id}`, { ...d, if_updated_at: row.updated_at }); else await post('/api/prevention-events', d);
      toast(row ? 'Event updated' : `Event recorded: ${d.title}${d.event_type === 'training' ? ` (${num(d.attendance)} trained)` : ''}`, 'ok');
      m.close(); onDone && onDone();
    },
  });
  if (row) f.querySelector(':scope > .btn-row').prepend(h('button', { type: 'button', class: 'btn danger', style: { marginRight: 'auto' }, 'data-delete-prevention': '1', onClick: async () => {
    if (!(await confirmDialog('Delete this event?', 'The event is removed from the prevention activity summary. This cannot be undone.', { danger: true, okText: 'Delete event' }))) return;
    await del(`/api/prevention-events/${row.id}`); discardDraft(`prevention:${row.id}`);
    toast('Event deleted', 'ok'); m.close(); onDone && onDone();
  } }, 'Delete event'));
  if (row && row.user_id && state.user && row.user_id !== state.user.id) f.prepend(h('p', { class: 'banner info small', 'data-others-record': '1' }, `Recorded by ${row.worker || 'another worker'}. You are changing another worker's record.`));
  const m = modal(row ? 'Edit prevention event' : 'Record a prevention event', f, { wide: true });
  return m;
}

/** Another worker's event, read-only (server/rules/prevention_events.js). */
function openPreventionView(r) {
  return modal(r.title, h('div', { 'data-prevention-view': r.id },
    ownedNotice(r.worker),
    kv([['Date', fmt.date(r.event_date)], ['Kind of event', label(r.event_type, 'PREVENTION_EVENT_TYPES')], ['Strategy (CSAP)', label(r.strategy, 'PREVENTION_STRATEGIES')],
      ['Population (IOM category)', label(r.iom_category, 'PREVENTION_IOM')], ['Audience', r.audience ? label(r.audience, 'PREVENTION_AUDIENCES') : null], ['Where', r.location || null],
      ['Attendance', `${num(r.attendance)}${r.attendance_estimated ? ' (estimated)' : ''}`], ['Hours', hours(r.hours)], r.funding_source ? ['Funding source', r.funding_source] : null,
      ['Notes', r.notes ? h('div', { style: { whiteSpace: 'pre-wrap' } }, r.notes) : null], ['Recorded by', r.worker]])), { wide: true });
}

function periodFilters(from, to, go, extra = []) {
  const fromI = h('input', { type: 'date', id: 'prev-from', value: from }); const toI = h('input', { type: 'date', id: 'prev-to', value: to });
  return h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', { for: 'prev-from' }, 'From'), fromI), h('div', { class: 'field' }, h('label', { for: 'prev-to' }, 'To'), toI),
    ...extra.map(x => x.el),
    h('button', { class: 'btn', 'data-prevention-apply': '1', onClick: () => go(fromI.value, toI.value, Object.fromEntries(extra.map(x => [x.key, x.el.querySelector('select').value]))) }, 'Apply'));
}

async function eventsBody(r, from, to, refresh) {
  const strategy = r.query.get('strategy') || '';
  const q = new URLSearchParams({ limit: '200', from, to }); if (strategy) q.set('strategy', strategy);
  const { rows, total } = await get(`/api/prevention-events?${q}`);
  const strategySel = h('div', { class: 'field' }, h('label', { for: 'prev-strategy' }, 'Strategy'),
    h('select', { id: 'prev-strategy' }, h('option', { value: '' }, 'All'), ((state.constants || {}).option_lists?.PREVENTION_STRATEGIES || []).map(e => h('option', { value: e.code, selected: e.code === strategy }, e.label))));
  return h('div', { 'data-prevention-events': '1' },
    periodFilters(from, to, (f, t, x) => nav(`prevention?tab=events&from=${f}&to=${t}${x.strategy ? `&strategy=${x.strategy}` : ''}`), [{ key: 'strategy', el: strategySel }]),
    rows.length ? table([
      { label: 'Date', render: x => fmt.date(x.event_date) },
      { label: 'Event', key: 'title' },
      { label: 'Kind', render: x => label(x.event_type, 'PREVENTION_EVENT_TYPES') },
      { label: 'Strategy (CSAP)', render: x => label(x.strategy, 'PREVENTION_STRATEGIES') },
      { label: 'Population (IOM)', render: x => label(x.iom_category, 'PREVENTION_IOM') },
      { label: 'Attendance', num: true, render: x => `${num(x.attendance)}${x.attendance_estimated ? ' (est.)' : ''}` },
      { label: 'Hours', num: true, render: x => hours(x.hours) },
      { label: 'Recorded by', render: x => x.worker || '—' },
    ], rows, {
      onRow: (x) => (can('interventions:write') && mayChange(x.user_id) ? openPreventionForm(x, { onDone: refresh }) : openPreventionView(x)),
      rowLabel: (x) => `${x.title}, ${fmt.date(x.event_date)}`,
    }) : emptyState('No prevention events in this period', can('interventions:write') ? 'Record a presentation, training, community event or campaign: its strategy, population, hours and how many people came.' : 'Staff who record visits record prevention events here.',
      can('interventions:write') ? h('button', { class: 'btn primary', 'data-empty-action': 'prevention', onClick: () => openPreventionForm(null, { onDone: refresh }) }, 'Record an event') : null),
    total > rows.length ? h('p', { class: 'small muted' }, `Showing ${rows.length} of ${total}.`) : null);
}

async function summaryBody(from, to) {
  const d = await get(`/api/reports/prevention?from=${from}&to=${to}`);
  const t = d.totals;
  const file = (xlsx) => downloadCsv(`/api/reports/prevention/export?from=${d.from}&to=${d.to}${xlsx ? '&format=xlsx' : ''}`);
  const cat = (first) => [{ label: first, key: 'label' }, { label: 'Events', key: 'events', num: true }, { label: 'Hours', num: true, render: x => hours(x.hours) }, { label: 'Attendance', num: true, render: x => num(x.attendance) }];
  const iomLabels = Object.fromEntries(d.by_iom.map(x => [x.code, x.label]));
  return h('div', { 'data-prevention-summary': '1' },
    periodFilters(d.from, d.to, (f, tt) => nav(`prevention?tab=summary&from=${f}&to=${tt}`)),
    can('export:read') ? h('div', { class: 'row mb' }, h('button', { class: 'btn', 'data-prevention-export': 'xlsx', onClick: () => file(true) }, 'Prevention activity summary (Excel)'), h('button', { class: 'btn ghost', 'data-prevention-export': 'csv', onClick: () => file(false) }, 'CSV')) : null,
    h('div', { class: 'grid cols-4 mb' }, stat('Events', num(t.events)), stat('Hours', hours(t.hours)), stat('Attendance', num(t.attendance)), stat('People trained', num(t.people_trained))),
    h('p', { class: 'small muted' }, d.count_note, t.attendance_estimated ? ` ${num(t.attendance_estimated)} of the attendance was estimated.` : ''),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card', 'data-by-strategy': '1' }, h('h2', {}, 'By strategy (CSAP)'), table(cat('Strategy'), d.by_strategy, { wrap: false })),
      h('section', { class: 'card', 'data-by-iom': '1' }, h('h2', {}, 'By population (IOM category)'), table(cat('Population'), d.by_iom, { wrap: false }))),
    h('section', { class: 'card mt' }, h('h2', {}, 'Attendance by strategy and population'),
      table([{ label: 'Strategy', key: 'label' }, ...d.iom_codes.map(c => ({ label: iomLabels[c], num: true, render: x => num(x.cells[c].attendance) }))], d.by_strategy_iom)),
    h('section', { class: 'card mt' }, h('h2', {}, 'By kind of event'), table(cat('Kind of event'), d.by_type, { empty: 'No events in this period.' })),
    h('p', { class: 'small muted mt', 'data-ppsds-note': '1' }, d.ppsds_note));
}

route('prevention', async (r) => {
  const [df, dt] = defaultRange();
  const from = r.query.get('from') || df; const to = r.query.get('to') || dt;
  // Someone who reads reports but not visits (read-only) sees the summary alone.
  const tabs = [can('interventions:read') ? ['events', 'Events'] : null, can('reports:read') ? ['summary', 'Activity summary', { 'data-tab-prevention-summary': '1' }] : null].filter(Boolean);
  const tab = tabs.some(x => x[0] === r.query.get('tab')) ? r.query.get('tab') : (tabs[0] || ['events'])[0];
  const refresh = () => nav(`prevention?tab=events&from=${from}&to=${to}&_=${Date.now()}`);
  const body = tab === 'summary' ? await summaryBody(from, to) : await eventsBody(r, from, to, refresh);
  return h('div', {},
    pageHead('Prevention',
      can('interventions:write') ? h('button', { class: 'btn primary', 'data-new-prevention': '1', onClick: () => openPreventionForm(null, { onDone: refresh }) }, '+ Record an event') : null),
    h('p', { class: 'muted' }, 'Group and community prevention: presentations, trainings, community events, campaigns and coalition work, with their CSAP strategy, IOM population category, hours and how many people came. Counts only — no names.'),
    tabs.length > 1 ? pageTabs(tabs, tab, (k) => nav(`prevention?tab=${k}&from=${from}&to=${to}`), { label: 'Prevention sections' }) : null,
    body);
});
