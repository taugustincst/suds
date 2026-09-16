import { h, route, get, post, put, del, state, form, modal, toast, table, fmt, can, pageHead, confirmDialog, downloadCsv, nav, bars, stat, badge } from '../app.js';

export function openTimeForm(values, { clientId, clientDisplay, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  const f = form([
    { name: 'work_date', label: 'Date', type: 'date', required: true, value: values?.work_date || fmt.today() }, { name: 'minutes', label: 'Minutes', type: 'number', min: 1, max: 1440, step: 1, required: true },
    { name: 'category', label: 'Category', type: 'select', options: C.TIME_CATEGORIES, value: 'direct_service', noBlank: true, required: true },
    { name: 'client_id', label: 'Client (optional)', type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    can('budget:read') ? { name: 'funding_source_id', label: 'Charge to fund', type: 'fund' } : null, { name: 'billable', label: 'Billable', type: 'checkbox' },
    { name: 'description', label: 'Description', span: true },
    can('time:all') ? { name: 'user_id', label: 'Worker', type: 'user', value: values?.user_id || state.user.id } : null,
  ].filter(Boolean), { values: values || {}, submitText: isNew ? 'Log time' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) await post('/api/time', d); else await put(`/api/time/${values.id}`, d);
    toast('Time saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? 'Log time' : 'Edit time entry', f);
}
export function timeTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'Date', render: r => fmt.date(r.work_date) }, { label: 'Worker', key: 'worker' }, showClient ? { label: 'Client', render: r => r.client_id ? h('a', { href: `#/client/${r.client_id}` }, r.client_code) : '—' } : null,
    { label: 'Category', render: r => fmt.label(r.category) }, { label: 'Minutes', key: 'minutes', num: true }, { label: 'Billable', render: r => r.billable ? badge('Yes', 'ok') : '' }, { label: 'Fund', render: r => r.funding_source || '—' },
    { label: 'Description', render: r => h('span', { class: 'small' }, r.description || '', r.intervention_id ? h('span', { class: 'muted' }, ' (from intervention)') : r.call_id ? h('span', { class: 'muted' }, ' (from call)') : null) },
    { label: '', render: r => (r.user_id === state.user.id || can('time:all')) ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openTimeForm(r, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', onClick: async () => { if (await confirmDialog('Delete entry', 'Delete this time entry?', { danger: true, okText: 'Delete' })) { await del(`/api/time/${r.id}`); onChange && onChange(); } } }, '✕')) : null },
  ].filter(Boolean), rows, { empty: 'No time entries.' });
}
route('time', async (r) => {
  const to = r.query.get('to') || fmt.today(); const from = r.query.get('from') || new Date(Date.parse(to) - 13 * 86400000).toISOString().slice(0, 10);
  const [data, sum] = await Promise.all([get(`/api/time?limit=500&from=${from}&to=${to}`), get(`/api/time/summary?from=${from}&to=${to}`)]);
  const refresh = () => nav(`time?from=${from}&to=${to}&_=${Date.now()}`);
  const fromI = h('input', { type: 'date', value: from }), toI = h('input', { type: 'date', value: to });
  const total = sum.by_category.reduce((s, x) => s + x.minutes, 0);
  return h('div', {},
    pageHead('Time tracking', can('time:write') ? h('button', { class: 'btn primary', onClick: () => openTimeForm(null, { onDone: refresh }) }, '+ Log time') : null, h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/time?from=${from}&to=${to}`) }, 'Export CSV')),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('button', { class: 'btn', onClick: () => nav(`time?from=${fromI.value}&to=${toI.value}`) }, 'Apply'),
      h('button', { class: 'btn ghost sm', onClick: () => { const d = new Date(); const day = d.getDay(); const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7)); nav(`time?from=${mon.toISOString().slice(0, 10)}&to=${fmt.today()}`); } }, 'This week'),
      h('button', { class: 'btn ghost sm', onClick: () => nav(`time?from=${to.slice(0, 8)}01&to=${to}`) }, 'This month')),
    h('div', { class: 'grid cols-4 mb' }, stat('Total', fmt.mins(total)), stat('Entries', fmt.num(data.total)), stat('Workers', fmt.num(sum.by_worker.length)), stat('Avg / day', fmt.mins(sum.by_day.length ? Math.round(total / sum.by_day.length) : 0))),
    h('div', { class: 'grid cols-3 mb' }, h('div', { class: 'card' }, h('h3', {}, 'By category'), bars(sum.by_category, { valueKey: 'minutes', labelKey: 'category', format: fmt.mins })),
      h('div', { class: 'card' }, h('h3', {}, 'By worker'), bars(sum.by_worker, { valueKey: 'minutes', labelKey: 'worker', format: fmt.mins })),
      h('div', { class: 'card' }, h('h3', {}, 'By funding source'), bars(sum.by_fund, { valueKey: 'minutes', labelKey: 'fund', format: fmt.mins }))),
    timeTable(data.rows, { onChange: refresh }));
});
