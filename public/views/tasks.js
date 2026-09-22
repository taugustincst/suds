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
export function taskTable(rows, { showClient = true, onChange, bulk = false } = {}) {
  const overdue = t => t.due_at && ['open', 'in_progress'].includes(t.status) && fmt.isPast(t.due_at);
  const canBulk = bulk && can('tasks:write');
  // Closing out a list of to-dos one checkbox at a time is the common case; select several and clear
  // them in one request each instead of one round trip per box.
  const bulkable = rows.filter(t => t.status !== 'done');
  const selected = new Set();
  const boxes = new Map();
  const countEl = h('span', { class: 'small muted' }, '0 selected');
  const markBtn = h('button', { class: 'btn sm primary', disabled: true, onClick: async () => {
    const ids = [...selected]; markBtn.disabled = true;
    const results = await Promise.allSettled(ids.map(id => put(`/api/tasks/${id}`, { status: 'done' })));
    const failed = results.filter(x => x.status === 'rejected').length;
    toast(failed ? `${ids.length - failed} of ${ids.length} marked done — ${failed} failed. Check your connection and try again.` : `${ids.length} marked done`, failed ? 'error' : 'ok');
    onChange && onChange();
  } }, 'Mark selected done');
  const selectAll = h('input', { type: 'checkbox', 'aria-label': 'Select all' });
  const updateCount = () => {
    countEl.textContent = `${selected.size} selected`; markBtn.disabled = selected.size === 0;
    selectAll.checked = bulkable.length > 0 && selected.size === bulkable.length;
    selectAll.indeterminate = selected.size > 0 && selected.size < bulkable.length;
  };
  selectAll.addEventListener('change', () => {
    for (const t of bulkable) { const box = boxes.get(t.id); if (!box) continue; box.checked = selectAll.checked; if (selectAll.checked) selected.add(t.id); else selected.delete(t.id); }
    updateCount();
  });
  const toolbar = canBulk && bulkable.length ? h('div', { class: 'row mb', style: { alignItems: 'center', gap: '.6rem' } }, h('label', { class: 'check', style: { marginTop: 0 } }, selectAll, 'Select all'), countEl, markBtn) : null;

  const tbl = table([
    { label: '', render: t => can('tasks:write') ? h('input', {
      type: 'checkbox', checked: t.status === 'done', title: 'Mark done',
      'aria-label': `Mark "${t.title}" ${t.status === 'done' ? 'not done' : 'done'}`,
      onChange: async (e) => {
        const wanted = e.target.checked;
        e.target.disabled = true;
        try {
          await put(`/api/tasks/${t.id}`, { status: wanted ? 'done' : 'open' });
          toast(wanted ? 'Marked done' : 'Reopened', 'ok');
          onChange && onChange();
        } catch (err) {
          // Silently reverting used to leave the worker believing a to-do was ticked off when it was not.
          e.target.checked = !wanted;
          toast(err.message || 'Could not update this to-do. Check your connection and try again.', 'error');
        } finally { e.target.disabled = false; }
      },
    }) : null },
    canBulk ? { label: '', render: t => { if (t.status === 'done') return null; const box = h('input', { type: 'checkbox', 'aria-label': `Select "${t.title}"`, onChange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); updateCount(); } }); boxes.set(t.id, box); return box; } } : null,
    { label: 'Task', render: t => h('div', {}, h('span', { style: t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : {} }, t.is_milestone ? '★ ' : '', t.title), t.description ? h('div', { class: 'small muted' }, t.description.slice(0, 120)) : null) },
    showClient ? { label: 'Client', render: t => t.client_id ? h('a', { href: `#/client/${t.client_id}` }, t.client_name || t.client_code, t.client_name ? h('div', { class: 'muted small mono' }, t.client_code) : null) : '—' } : null,
    { label: 'Due', render: t => h('span', { style: overdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, t.due_at ? fmt.dt(t.due_at) : '—') },
    { label: 'Priority', render: t => badge(fmt.label(t.priority), statusKind(t.priority)) }, { label: 'Status', render: t => badge(fmt.label(t.status), statusKind(t.status)) }, { label: 'Assignee', key: 'assignee' },
    { label: '', render: t => can('tasks:write') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openTaskForm(t, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this task', onClick: async () => { if (await confirmDialog('Delete task', 'Delete this task?', { danger: true, okText: 'Delete' })) { await del(`/api/tasks/${t.id}`); onChange && onChange(); } } }, '✕')) : null },
  ].filter(Boolean), rows, { empty: 'Nothing here. Reminders you add, and follow-ups from visits and calls, will show up in this list.',
    rowLabel: t => t.title,
    // The done box stays on the phone row: a to-do list you cannot tick off one-handed is not a to-do list.
    compact: { primary: t => [h('span', { class: 'row nowrap', style: { gap: '.4rem', minWidth: 0 } }, can('tasks:write') ? h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': `Mark "${t.title}" ${t.status === 'done' ? 'not done' : 'done'}`, onClick: (e) => e.stopPropagation(), onChange: async (e) => {
        const wanted = e.target.checked; e.target.disabled = true;
        try { await put(`/api/tasks/${t.id}`, { status: wanted ? 'done' : 'open' }); toast(wanted ? 'Marked done' : 'Reopened', 'ok'); onChange && onChange(); }
        catch (err) { e.target.checked = !wanted; toast(err.message || 'Could not update this to-do. Check your connection and try again.', 'error'); }
        finally { e.target.disabled = false; }
      } }) : null, h('span', { style: t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : {} }, t.is_milestone ? '★ ' : '', t.title)), badge(fmt.label(t.priority), statusKind(t.priority))],
      secondary: t => [showClient && t.client_id ? h('span', {}, t.client_name || t.client_code) : null, h('span', { style: overdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, t.due_at ? (overdue(t) ? 'overdue · ' : 'due ') + fmt.dt(t.due_at) : 'no due date'), t.status === 'done' ? badge('Done', 'ok') : null],
      onTap: t => can('tasks:write') ? openTaskForm(t, { onDone: onChange }) : null } });
  return toolbar ? h('div', {}, toolbar, tbl) : tbl;
}
route('tasks', async (r) => {
  const status = r.query.get('status') || 'open'; const mine = r.query.get('mine') !== '0'; const overdue = r.query.get('overdue') === '1';
  const qs = `limit=300&status=${status}${mine ? '&mine=1' : ''}${overdue ? '&overdue=1' : ''}`;
  const data = await get(`/api/tasks?${qs}`);
  const refresh = () => nav(`tasks?status=${status}&mine=${mine ? 1 : 0}${overdue ? '&overdue=1' : ''}&_=${Date.now()}`);
  if (r.query.get('id')) { const t = data.rows.find(x => x.id === r.query.get('id')); if (t) setTimeout(() => openTaskForm(t, { onDone: refresh }), 0); }
  const sel = h('select', { onChange: () => nav(`tasks?status=${sel.value}&mine=${mine ? 1 : 0}`) }, [['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  return h('div', {},
    pageHead('To-do list', can('tasks:write') ? h('button', { class: 'btn primary', onClick: () => openTaskForm(null, { onDone: refresh }) }, '+ Add a reminder') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sel), h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(`tasks?status=${status}&mine=${mine ? 0 : 1}`) }, 'Assigned to me'), h('button', { class: `btn sm ${overdue ? 'primary' : ''}`, onClick: () => nav(`tasks?status=open&mine=${mine ? 1 : 0}${overdue ? '' : '&overdue=1'}`) }, 'Overdue')),
    taskTable(data.rows, { onChange: refresh, bulk: true }));
});
