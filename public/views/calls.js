import { h, route, get, pagedList, filterBar, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav, contactLinks, kv, mayChange, ownedNotice, viewOnly, QUICK_FOLLOW_UP } from '../app.js';

// prefill: starting values for a new record (the number just dialled from a client's page) -- unlike
// `values`, it does not make this an edit.
export function openCallForm(values, { clientId, clientDisplay, method, onDone, prefill } = {}) {
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
    { name: 'contact_type', label: 'Who', type: 'select', list: 'CALL_CONTACT_TYPES', value: 'client', noBlank: true, required: true }, { name: 'contact_name', label: 'Contact name (if not client)' }, { name: 'phone', label: isText ? 'Mobile number' : 'Phone number', type: 'tel' },
    { name: 'purpose', label: 'Purpose', span: true },
    { name: 'outcome', label: 'Outcome', type: 'select', list: isText ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES', value: isText ? 'sent' : 'reached', noBlank: true, required: true },
    { name: 'crisis', label: `Crisis ${noun}`, type: 'checkbox' }, { name: 'follow_up_needed', label: 'Follow-up needed', type: 'checkbox' }, { name: 'follow_up_due', label: isText ? 'Remind me to follow up on' : 'Remind me to call back on', type: 'date', quick: QUICK_FOLLOW_UP, help: 'A date puts a to-do on your list for that day (Follow-up needed is ticked for you).' },
    { name: 'summary', label: isText ? 'What was said (encrypted)' : 'Summary (encrypted)', type: 'textarea', span: true,
      help: isText ? 'Record what was exchanged, not a screenshot. Texting a client about treatment is a disclosure if anyone else can read their phone — keep it to arranging contact unless they have agreed otherwise.' : null },
    // Unticked on every new call (1.15.3), as on a visit: time goes on the time sheet only when someone chose it,
    // and the help says how many minutes that will be.
    isNew ? { name: 'log_time', label: 'Also log as time entry', type: 'checkbox', value: false, help: ' ' } : null,
  ].filter(Boolean), { values: values || prefill || {}, submitText: isNew ? (isText ? 'Log text' : 'Log call') : 'Save', draftKey: values ? `call:${values.id}` : `call:new:${isText ? 'text' : 'phone'}`, onCancel: () => m.close(), onSubmit: async (d) => {
    d.method = isText ? 'text' : 'phone';
    if (isNew) await post('/api/calls', d); else await put(`/api/calls/${values.id}`, { ...d, if_updated_at: values.updated_at });
    toast(isNew ? (isText ? 'Text logged' : 'Call logged') : 'Saved', 'ok'); m.close(); onDone && onDone();
  } });
  // A reminder date is a follow-up (1.22.0): the box is ticked as soon as a date is chosen, as the server also
  // does, so a date with the box left unticked no longer makes no to-do.
  const fuDate = f.inputs.follow_up_due; const fuBox = f.inputs.follow_up_needed;
  if (fuDate && fuBox) { const tick = () => { if (fuDate.value && !fuBox.checked) fuBox.checked = true; }; fuDate.addEventListener('change', tick); fuDate.addEventListener('input', tick); }
  if (f.inputs.log_time) {
    const help = f.querySelector('[data-field="log_time"] .help');
    const say = () => { const mins = Number(f.inputs.duration_minutes.value) || 0; if (help) help.textContent = f.inputs.log_time.checked ? (mins > 0 ? `Adds ${mins} min to your time (My time), as a draft to submit for approval. Check the ${isText ? 'time spent' : 'duration'} above first.` : `Nothing is logged while the ${isText ? 'time spent' : 'duration'} is 0.`) : 'No time entry is made. Tick this to put the call on your time sheet.'; };
    f.addEventListener('input', say); f.addEventListener('change', say); say();
  }
  const m = modal(isNew ? (isText ? 'Log text message' : 'Log call') : `Edit ${noun}`, f, { wide: true });
}
const deleteCall = async (r, onChange, m) => { if (await confirmDialog(r.method === 'text' ? 'Delete text' : 'Delete call', 'Delete this contact record?', { danger: true, okText: 'Delete' })) { await del(`/api/calls/${r.id}`); if (m) m.close(); onChange && onChange(); } };
const mayEditCall = (r) => can('calls:write') && mayChange(r.user_id);
/** A call or text to read in full (the list cuts its summary): Edit and Delete for its worker or a supervisor. */
export function openCallView(r, { onChange } = {}) {
  const outcomes = r.method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES';
  const m = modal(r.method === 'text' ? 'Text message' : 'Phone call', h('div', { 'data-call-view': r.id },
    mayEditCall(r) || !can('calls:write') ? null : ownedNotice(r.worker, { noun: r.method === 'text' ? 'text' : 'call' }),
    kv([['When', fmt.dt(r.started_at)], ['Client', r.client_name || r.client_code || '—'], ['Direction', r.direction === 'inbound' ? 'In' : 'Out'],
      ['Who', [fmt.label(r.contact_type, 'CALL_CONTACT_TYPES'), r.contact_name].filter(Boolean).join(' · ')], ['Phone', r.phone ? contactLinks(r.phone) : null],
      ['Minutes', String(r.duration_minutes ?? 0)], ['Outcome', fmt.label(r.outcome, outcomes)], ['Flags', [r.crisis ? 'Crisis' : null, r.follow_up_needed ? `Follow-up${r.follow_up_due ? ` by ${fmt.date(r.follow_up_due)}` : ''}` : null].filter(Boolean).join(' · ') || null],
      ['Purpose', r.purpose], ['Summary', r.summary ? h('div', { style: { whiteSpace: 'pre-wrap' } }, r.summary) : null], ['Worker', r.worker]]),
    mayEditCall(r) ? h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn danger', style: { marginRight: 'auto' }, onClick: () => deleteCall(r, onChange, m) }, r.method === 'text' ? 'Delete text' : 'Delete call'),
      h('button', { type: 'button', class: 'btn primary', onClick: () => { m.close(); openCallForm(r, { onDone: onChange }); } }, 'Edit')) : null), { wide: true });
  return m;
}
export function callTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'When', render: r => h('span', { class: 'nowrap' }, fmt.dt(r.started_at)) },
    showClient ? { label: 'Client', render: r => r.client_id ? h('a', { href: `#/client/${r.client_id}`, onClick: e => e.stopPropagation() }, r.client_name || r.client_code, r.client_name ? h('div', { class: 'muted small mono' }, r.client_code) : null) : h('span', { class: 'muted' }, r.contact_name || '—') } : null,
    { label: 'How', render: r => r.method === 'text' ? badge('💬 Text', 'purple') : badge('☎ Call', 'info') },
    { label: 'Dir', render: r => r.direction === 'inbound' ? '⇦ In' : '⇨ Out' }, { label: 'Who', render: r => [fmt.label(r.contact_type, 'CALL_CONTACT_TYPES'), r.contact_name ? h('div', { class: 'small muted' }, r.contact_name) : null, r.phone ? h('div', { class: 'small', onClick: e => e.stopPropagation() }, contactLinks(r.phone)) : null] },
    { label: 'Min', render: r => r.duration_minutes, num: true }, { label: 'Outcome', render: r => badge(fmt.label(r.outcome, r.method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES'), statusKind(r.outcome)) },
    { label: 'Flags', render: r => [r.crisis ? badge('Crisis', 'danger') : null, r.follow_up_needed ? [' ', badge('Follow-up', 'warn')] : null] },
    { label: 'Purpose / summary', render: r => h('span', { class: 'small' }, r.purpose || '', r.summary ? h('div', { class: 'muted' }, r.summary.slice(0, 140)) : null) }, { label: 'Worker', key: 'worker' },
    { label: '', render: r => !can('calls:write') ? null : mayEditCall(r) ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: (e) => { e.stopPropagation(); openCallForm(r, { onDone: onChange }); } }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': r.method === 'text' ? 'Delete this text' : 'Delete this call', onClick: (e) => { e.stopPropagation(); deleteCall(r, onChange); } }, '✕')) : viewOnly(null, { short: true }) },
  ].filter(Boolean), rows, { empty: 'No calls yet. Use + Log → Phone call after each call, even if it went to voicemail.',
    rowLabel: r => `${r.method === 'text' ? 'Text' : 'Call'} ${fmt.dt(r.started_at)}${r.client_name ? ', ' + r.client_name : ''}`,
    compact: { primary: r => [h('span', {}, showClient && r.client_id ? (r.client_name || r.client_code) : (r.contact_name || fmt.label(r.contact_type, 'CALL_CONTACT_TYPES'))), r.method === 'text' ? badge('💬 Text', 'purple') : badge('☎ Call', 'info')],
      secondary: r => [h('span', {}, fmt.dt(r.started_at)), badge(fmt.label(r.outcome, r.method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES'), statusKind(r.outcome)), r.crisis ? badge('Crisis', 'danger') : null, r.follow_up_needed ? badge('Follow-up', 'warn') : null],
      // On a phone your own call opens straight into its form; anyone else's to read, with who can change it.
      onTap: r => (mayEditCall(r) ? openCallForm(r, { onDone: onChange }) : openCallView(r, { onChange })) },
    onRow: r => openCallView(r, { onChange }) });
}
route('calls', async (r) => {
  const crisis = r.query.get('crisis') === '1', fu = r.query.get('follow_up') === '1', mine = r.query.get('mine') === '1';
  const method = ['phone', 'text'].includes(r.query.get('method')) ? r.query.get('method') : '';
  const qs = `${crisis ? '&crisis=1' : ''}${fu ? '&follow_up=1' : ''}${mine ? '&mine=1' : ''}${method ? `&method=${method}` : ''}`.replace(/^&/, '');
  const PAGE = 200;
  const data = await get(`/api/calls?limit=${PAGE}${qs ? '&' + qs : ''}`);
  const refresh = () => nav(`calls?${qs}&_=${Date.now()}`);
  const link = (over = {}) => {
    const q = { crisis: crisis ? '1' : '', follow_up: fu ? '1' : '', mine: mine ? '1' : '', method, ...over };
    return 'calls?' + Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&');
  };
  return h('div', {},
    pageHead('Calls & texts',
      can('calls:write') ? h('button', { class: 'btn primary', onClick: () => openCallForm(null, { onDone: refresh }) }, '+ Log call') : null,
      can('calls:write') ? h('button', { class: 'btn', onClick: () => openCallForm(null, { method: 'text', onDone: refresh }) }, '+ Log text') : null,
      can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/calls?from=2000-01-01&format=xlsx') }, 'Export to Excel') : null),
    filterBar([crisis, fu, mine, method].filter(Boolean).length,
      h('button', { class: `btn sm ${crisis ? 'primary' : ''}`, onClick: () => nav(link({ crisis: crisis ? '' : '1' })) }, 'Crisis only'),
      h('button', { class: `btn sm ${fu ? 'primary' : ''}`, onClick: () => nav(link({ follow_up: fu ? '' : '1' })) }, 'Needs follow-up'),
      h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(link({ mine: mine ? '' : '1' })) }, 'Mine'),
      h('button', { class: `btn sm ${method === 'phone' ? 'primary' : ''}`, onClick: () => nav(link({ method: method === 'phone' ? '' : 'phone' })) }, 'Calls'),
      h('button', { class: `btn sm ${method === 'text' ? 'primary' : ''}`, onClick: () => nav(link({ method: method === 'text' ? '' : 'text' })) }, 'Texts')),
    pagedList({ first: data, url: `/api/calls${qs ? '?' + qs : ''}`, limit: PAGE, render: (rows) => callTable(rows, { onChange: refresh }),
      summary: (rows, total) => { const texts = rows.filter(x => x.method === 'text').length; return h('div', { class: 'muted small mb' }, `${total} contact${total === 1 ? '' : 's'}${method ? '' : ` (${rows.length - texts} calls, ${texts} texts shown)`} · ${fmt.mins(rows.reduce((s, x) => s + (x.duration_minutes || 0), 0))}`); } }));
});
