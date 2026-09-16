import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav } from '../app.js';

export function openTaskForm(values, { clientId, clientDisplay, onDone } = {}) {
  const isNew = !values;
  const f = form([
    { name: 'title', label: 'Title', required: true, span: true }, { name: 'client_id', label: 'Client (optional)', type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    { name: 'assigned_to', label: 'Assigned to', type: 'user', value: values?.assigned_to || state.user.id }, { name: 'due_at', label: 'Due', type: 'datetime' },
    { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'urgent'], value: 'normal', noBlank: true, required: true }, { name: 'status', label: 'Status', type: 'select', options: ['open', 'in_progress', 'done', 'cancelled'], value: 'open', noBlank: true, required: true },
    { name: 'is_milestone', label: 'Milestone (shows on client timeline)', type: 'checkbox' }, { name: 'description', label: 'Details', type: 'textarea', span: true },
  ], { values: values || {}, submitText: isNew ? 'Create task' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) await post('/api/tasks', d); else await put(`/api/tasks/${values.id}`, d);
    toast('Task saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? 'New task' : 'Edit task', f);
}
export function taskTable(rows, { showClient = true, onChange } = {}) {
  const overdue = t => t.due_at && ['open', 'in_progress'].includes(t.status) && Date.parse(t.due_at) < Date.now();
  return table([
    { label: '', render: t => can('tasks:write') ? h('input', { type: 'checkbox', checked: t.status === 'done', title: 'Mark done', onChange: async (e) => { await put(`/api/tasks/${t.id}`, { status: e.target.checked ? 'done' : 'open' }); onChange && onChange(); } }) : null },
    { label: 'Task', render: t => h('div', {}, h('span', { style: t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : {} }, t.is_milestone ? '★ ' : '', t.title), t.description ? h('div', { class: 'small muted' }, t.description.slice(0, 120)) : null) },
    showClient ? { label: 'Client', render: t => t.client_id ? h('a', { href: `#/client/${t.client_id}` }, t.client_code) : '—' } : null,
    { label: 'Due', render: t => h('span', { style: overdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, t.due_at ? fmt.dt(t.due_at) : '—') },
    { label: 'Priority', render: t => badge(fmt.label(t.priority), statusKind(t.priority)) }, { label: 'Status', render: t => badge(fmt.label(t.status), statusKind(t.status)) }, { label: 'Assignee', key: 'assignee' },
    { label: '', render: t => can('tasks:write') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openTaskForm(t, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', onClick: async () => { if (await confirmDialog('Delete task', 'Delete this task?', { danger: true, okText: 'Delete' })) { await del(`/api/tasks/${t.id}`); onChange && onChange(); } } }, '✕')) : null },
  ].filter(Boolean), rows, { empty: 'No tasks.' });
}
route('tasks', async (r) => {
  const status = r.query.get('status') || 'open'; const mine = r.query.get('mine') !== '0'; const overdue = r.query.get('overdue') === '1';
  const qs = `limit=300&status=${status}${mine ? '&mine=1' : ''}${overdue ? '&overdue=1' : ''}`;
  const data = await get(`/api/tasks?${qs}`);
  const refresh = () => nav(`tasks?status=${status}&mine=${mine ? 1 : 0}${overdue ? '&overdue=1' : ''}&_=${Date.now()}`);
  if (r.query.get('id')) { const t = data.rows.find(x => x.id === r.query.get('id')); if (t) setTimeout(() => openTaskForm(t, { onDone: refresh }), 0); }
  const sel = h('select', { onChange: () => nav(`tasks?status=${sel.value}&mine=${mine ? 1 : 0}`) }, [['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => h('option', { value: v === 'all' ? '' : v, selected: (v === 'all' ? '' : v) === status }, l)));
  return h('div', {},
    pageHead('Tasks & follow-ups', can('tasks:write') ? h('button', { class: 'btn primary', onClick: () => openTaskForm(null, { onDone: refresh }) }, '+ New task') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sel), h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(`tasks?status=${status}&mine=${mine ? 0 : 1}`) }, 'Assigned to me'), h('button', { class: `btn sm ${overdue ? 'primary' : ''}`, onClick: () => nav(`tasks?status=open&mine=${mine ? 1 : 0}${overdue ? '' : '&overdue=1'}`) }, 'Overdue')),
    taskTable(data.rows, { onChange: refresh }));
});
