import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav } from '../app.js';

export function openCallForm(values, { clientId, clientDisplay, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  const f = form([
    { name: 'client_id', label: 'Client (optional for non-client calls)', type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    { name: 'direction', label: 'Direction', type: 'select', options: ['outbound', 'inbound'], required: true, noBlank: true, value: 'outbound' },
    { name: 'started_at', label: 'Date & time', type: 'datetime', required: true, value: values?.started_at || new Date().toISOString() },
    { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', min: 0, step: 1, value: values?.duration_minutes ?? 5 },
    { name: 'contact_type', label: 'Who', type: 'select', options: C.CALL_CONTACT_TYPES, value: 'client', noBlank: true, required: true }, { name: 'contact_name', label: 'Contact name (if not client)' }, { name: 'phone', label: 'Phone number' },
    { name: 'purpose', label: 'Purpose', span: true }, { name: 'outcome', label: 'Outcome', type: 'select', options: C.CALL_OUTCOMES, value: 'reached', noBlank: true, required: true },
    { name: 'crisis', label: 'Crisis call', type: 'checkbox' }, { name: 'follow_up_needed', label: 'Follow-up needed', type: 'checkbox' }, { name: 'follow_up_due', label: 'Remind me to call back on', type: 'date' },
    { name: 'summary', label: 'Summary (encrypted)', type: 'textarea', span: true },
    isNew ? { name: 'log_time', label: 'Also log as time entry', type: 'checkbox', value: true } : null,
  ].filter(Boolean), { values: values || {}, submitText: isNew ? 'Log call' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) await post('/api/calls', d); else await put(`/api/calls/${values.id}`, d);
    toast(isNew ? 'Call logged' : 'Saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? 'Log call' : 'Edit call', f, { wide: true });
}
export function callTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'When', render: r => h('span', { class: 'nowrap' }, fmt.dt(r.started_at)) },
    showClient ? { label: 'Client', render: r => r.client_id ? h('a', { href: `#/client/${r.client_id}` }, r.client_code) : h('span', { class: 'muted' }, r.contact_name || '—') } : null,
    { label: 'Dir', render: r => r.direction === 'inbound' ? '⇦ In' : '⇨ Out' }, { label: 'Who', render: r => [fmt.label(r.contact_type), r.contact_name ? h('div', { class: 'small muted' }, r.contact_name) : null] },
    { label: 'Min', render: r => r.duration_minutes, num: true }, { label: 'Outcome', render: r => badge(fmt.label(r.outcome), statusKind(r.outcome)) },
    { label: 'Flags', render: r => [r.crisis ? badge('Crisis', 'danger') : null, r.follow_up_needed ? [' ', badge('Follow-up', 'warn')] : null] },
    { label: 'Purpose / summary', render: r => h('span', { class: 'small' }, r.purpose || '', r.summary ? h('div', { class: 'muted' }, r.summary.slice(0, 140)) : null) }, { label: 'Worker', key: 'worker' },
    { label: '', render: r => (r.user_id === state.user.id || can('clients:all')) && can('calls:write') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openCallForm(r, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', onClick: async () => { if (await confirmDialog('Delete call', 'Delete this call record?', { danger: true, okText: 'Delete' })) { await del(`/api/calls/${r.id}`); onChange && onChange(); } } }, '✕')) : null },
  ].filter(Boolean), rows, { empty: 'No calls yet. Use + Log → Phone call after each call, even if it went to voicemail.' });
}
route('calls', async (r) => {
  const crisis = r.query.get('crisis') === '1', fu = r.query.get('follow_up') === '1', mine = r.query.get('mine') === '1';
  const qs = `limit=300${crisis ? '&crisis=1' : ''}${fu ? '&follow_up=1' : ''}${mine ? '&mine=1' : ''}`;
  const data = await get(`/api/calls?${qs}`);
  const refresh = () => nav(`calls?${qs}&_=${Date.now()}`);
  const tog = (k, v) => nav(`calls?${crisis !== (k === 'crisis') ? 'crisis=1&' : ''}${fu !== (k === 'fu') ? 'follow_up=1&' : ''}${mine !== (k === 'mine') ? 'mine=1' : ''}`);
  return h('div', {},
    pageHead('Calls', can('calls:write') ? h('button', { class: 'btn primary', onClick: () => openCallForm(null, { onDone: refresh }) }, '+ Log call') : null, h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/calls?from=2000-01-01') }, 'Export CSV')),
    h('div', { class: 'filters' }, h('button', { class: `btn sm ${crisis ? 'primary' : ''}`, onClick: () => tog('crisis') }, 'Crisis only'), h('button', { class: `btn sm ${fu ? 'primary' : ''}`, onClick: () => tog('fu') }, 'Needs follow-up'), h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => tog('mine') }, 'Mine')),
    h('div', { class: 'muted small mb' }, `${data.total} calls · ${fmt.mins(data.rows.reduce((s, x) => s + x.duration_minutes, 0))}`),
    callTable(data.rows, { onChange: refresh }));
});
