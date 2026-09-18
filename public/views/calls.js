import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav } from '../app.js';

export function openCallForm(values, { clientId, clientDisplay, method, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  // A text message is the same record as a call with different wording: its own outcomes, no minutes
  // worth arguing about, and a reminder that what you send is part of the record.
  const isText = (values?.method || method || 'phone') === 'text';
  const noun = isText ? 'text message' : 'call';
  const f = form([
    { name: 'client_id', label: `Client (optional for non-client ${isText ? 'texts' : 'calls'})`, type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    { name: 'direction', label: 'Direction', type: 'select', options: isText ? [{ value: 'outbound', label: 'Sent' }, { value: 'inbound', label: 'Received' }] : ['outbound', 'inbound'], required: true, noBlank: true, value: 'outbound' },
    { name: 'started_at', label: 'Date & time', type: 'datetime', required: true, value: values?.started_at || new Date().toISOString() },
    { name: 'duration_minutes', label: isText ? 'Time spent (minutes)' : 'Duration (minutes)', type: 'number', min: 0, step: 1, value: values?.duration_minutes ?? (isText ? 1 : 5) },
    { name: 'contact_type', label: 'Who', type: 'select', options: C.CALL_CONTACT_TYPES, value: 'client', noBlank: true, required: true }, { name: 'contact_name', label: 'Contact name (if not client)' }, { name: 'phone', label: isText ? 'Mobile number' : 'Phone number' },
    { name: 'purpose', label: 'Purpose', span: true },
    { name: 'outcome', label: 'Outcome', type: 'select', options: isText ? C.TEXT_OUTCOMES : C.CALL_OUTCOMES, value: isText ? 'sent' : 'reached', noBlank: true, required: true },
    { name: 'crisis', label: `Crisis ${noun}`, type: 'checkbox' }, { name: 'follow_up_needed', label: 'Follow-up needed', type: 'checkbox' }, { name: 'follow_up_due', label: isText ? 'Remind me to follow up on' : 'Remind me to call back on', type: 'date' },
    { name: 'summary', label: isText ? 'What was said (encrypted)' : 'Summary (encrypted)', type: 'textarea', span: true,
      help: isText ? 'Record what was exchanged, not a screenshot. Texting a client about treatment is a disclosure if anyone else can read their phone — keep it to arranging contact unless they have agreed otherwise.' : null },
    isNew ? { name: 'log_time', label: 'Also log as time entry', type: 'checkbox', value: true } : null,
  ].filter(Boolean), { values: values || {}, submitText: isNew ? (isText ? 'Log text' : 'Log call') : 'Save', draftKey: values ? `call:${values.id}` : `call:new:${isText ? 'text' : 'phone'}`, onCancel: () => m.close(), onSubmit: async (d) => {
    d.method = isText ? 'text' : 'phone';
    if (isNew) await post('/api/calls', d); else await put(`/api/calls/${values.id}`, d);
    toast(isNew ? (isText ? 'Text logged' : 'Call logged') : 'Saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? (isText ? 'Log text message' : 'Log call') : `Edit ${noun}`, f, { wide: true });
}
export function callTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'When', render: r => h('span', { class: 'nowrap' }, fmt.dt(r.started_at)) },
    showClient ? { label: 'Client', render: r => r.client_id ? h('a', { href: `#/client/${r.client_id}` }, r.client_code) : h('span', { class: 'muted' }, r.contact_name || '—') } : null,
    { label: 'How', render: r => r.method === 'text' ? badge('💬 Text', 'purple') : badge('☎ Call', 'info') },
    { label: 'Dir', render: r => r.direction === 'inbound' ? '⇦ In' : '⇨ Out' }, { label: 'Who', render: r => [fmt.label(r.contact_type), r.contact_name ? h('div', { class: 'small muted' }, r.contact_name) : null] },
    { label: 'Min', render: r => r.duration_minutes, num: true }, { label: 'Outcome', render: r => badge(fmt.label(r.outcome), statusKind(r.outcome)) },
    { label: 'Flags', render: r => [r.crisis ? badge('Crisis', 'danger') : null, r.follow_up_needed ? [' ', badge('Follow-up', 'warn')] : null] },
    { label: 'Purpose / summary', render: r => h('span', { class: 'small' }, r.purpose || '', r.summary ? h('div', { class: 'muted' }, r.summary.slice(0, 140)) : null) }, { label: 'Worker', key: 'worker' },
    { label: '', render: r => (r.user_id === state.user.id || can('clients:all')) && can('calls:write') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openCallForm(r, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': r.method === 'text' ? 'Delete this text' : 'Delete this call', onClick: async () => { if (await confirmDialog(r.method === 'text' ? 'Delete text' : 'Delete call', 'Delete this contact record?', { danger: true, okText: 'Delete' })) { await del(`/api/calls/${r.id}`); onChange && onChange(); } } }, '✕')) : null },
  ].filter(Boolean), rows, { empty: 'No calls yet. Use + Log → Phone call after each call, even if it went to voicemail.' });
}
route('calls', async (r) => {
  const crisis = r.query.get('crisis') === '1', fu = r.query.get('follow_up') === '1', mine = r.query.get('mine') === '1';
  const method = ['phone', 'text'].includes(r.query.get('method')) ? r.query.get('method') : '';
  const qs = `limit=300${crisis ? '&crisis=1' : ''}${fu ? '&follow_up=1' : ''}${mine ? '&mine=1' : ''}${method ? `&method=${method}` : ''}`;
  const data = await get(`/api/calls?${qs}`);
  const refresh = () => nav(`calls?${qs}&_=${Date.now()}`);
  const link = (over = {}) => {
    const q = { crisis: crisis ? '1' : '', follow_up: fu ? '1' : '', mine: mine ? '1' : '', method, ...over };
    return 'calls?' + Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&');
  };
  const texts = data.rows.filter(x => x.method === 'text').length;
  return h('div', {},
    pageHead('Calls & texts',
      can('calls:write') ? h('button', { class: 'btn primary', onClick: () => openCallForm(null, { onDone: refresh }) }, '+ Log call') : null,
      can('calls:write') ? h('button', { class: 'btn', onClick: () => openCallForm(null, { method: 'text', onDone: refresh }) }, '+ Log text') : null,
      h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/calls?from=2000-01-01&format=xlsx') }, 'Export to Excel')),
    h('div', { class: 'filters' },
      h('button', { class: `btn sm ${crisis ? 'primary' : ''}`, onClick: () => nav(link({ crisis: crisis ? '' : '1' })) }, 'Crisis only'),
      h('button', { class: `btn sm ${fu ? 'primary' : ''}`, onClick: () => nav(link({ follow_up: fu ? '' : '1' })) }, 'Needs follow-up'),
      h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(link({ mine: mine ? '' : '1' })) }, 'Mine'),
      h('button', { class: `btn sm ${method === 'phone' ? 'primary' : ''}`, onClick: () => nav(link({ method: method === 'phone' ? '' : 'phone' })) }, 'Calls'),
      h('button', { class: `btn sm ${method === 'text' ? 'primary' : ''}`, onClick: () => nav(link({ method: method === 'text' ? '' : 'text' })) }, 'Texts')),
    h('div', { class: 'muted small mb' }, `${data.total} contact${data.total === 1 ? '' : 's'}${method ? '' : ` (${data.rows.length - texts} calls, ${texts} texts on this page)`} · ${fmt.mins(data.rows.reduce((s, x) => s + x.duration_minutes, 0))}`),
    callTable(data.rows, { onChange: refresh }));
});
