import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, kv, mayChange, ownedNotice, viewOnly } from '../app.js';

export function openTaskForm(values, { clientId, clientDisplay, onDone } = {}) {
  const isNew = !values;
  const f = form([
    { name: 'title', label: 'Title', required: true, span: true }, { name: 'client_id', label: 'Client (optional)', type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    { name: 'assigned_to', label: 'Assigned to', type: 'user', value: values?.assigned_to || state.user.id, exceptRoles: ['finance', 'readonly'] }, { name: 'due_at', label: 'Due', type: 'datetime' },
    { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'urgent'], value: 'normal', noBlank: true, required: true }, { name: 'status', label: 'Status', type: 'select', options: ['open', 'in_progress', 'done', 'cancelled'], value: 'open', noBlank: true, required: true },
    { name: 'is_milestone', label: 'Milestone (shows on client timeline)', type: 'checkbox' }, { name: 'description', label: 'Details', type: 'textarea', span: true },
  ], { values: values || {}, submitText: isNew ? 'Create to-do' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) await post('/api/tasks', d); else await put(`/api/tasks/${values.id}`, { ...d, if_updated_at: values.updated_at });
    toast('To-do saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? 'New to-do' : 'Edit to-do', f);
}
// A to-do is changed by whoever it is assigned to or made it, or someone who manages others' records
// (server/rules/tasks.js editableBy); anyone who can write to-dos may still mark it done.
const mayChangeTask = (t) => mayChange(t.assigned_to, t.created_by);
/** Someone else's to-do on a phone, to read: it used to open as a form whose Save was then refused. */
function openTaskView(t) {
  modal('To-do', h('div', { 'data-task-view': t.id }, can('tasks:write') ? ownedNotice(t.assignee, { verb: 'Assigned to' }) : null,
    kv([['To-do', t.title], ['Client', t.client_name || t.client_code || null], ['Due', t.due_at ? fmt.dt(t.due_at) : null], ['Priority', fmt.label(t.priority)], ['Status', fmt.label(t.status)],
      ['Assigned to', t.assignee], ['Details', t.description ? h('div', { style: { whiteSpace: 'pre-wrap' } }, t.description) : null]]),
    can('tasks:write') ? h('p', { class: 'small muted' }, 'You can still mark it done with its box in the list.') : null));
}
// ---- Client-change notices (1.16.1) ----
// When someone off a client's care team changes the client's record, the primary worker gets a to-do saying who
// changed which fields (server/rules/clients.js notifyPrimary). It is something to read, not to edit, so it opens
// as a card. The server marks it (`notice: true`, server/rules/tasks.js isNotice); a to-do from a server before that is
// known by its text. This is the one place that decides it.
/** { editor, code, fields } for a change notice, or null for an ordinary to-do. */
export function changeNotice(t) {
  if (!t || !(t.notice === true || /You are this client's primary worker/.test(t.description || ''))) return null;
  const m = /^(.+?) changed (.+?)'s record\b/.exec(t.title || '') || [];
  const listed = (/^Changed: (.*)$/m.exec(t.description || '') || /\((.*)\)\s*$/.exec(t.title || '') || [])[1] || '';
  return { editor: m[1] || 'Someone off the care team', code: m[2] || t.client_code || 'the client', fields: listed.split(', ').map(x => x.trim()).filter(Boolean) };
}
/** A change notice, read-only: who changed which fields, the client, and Mark as seen for the person told. */
export async function openChangeNotice(t, { onDone } = {}) {
  const n = changeNotice(t); if (!n) return null;
  // The client form's own labels ("ASAM level of care"), where a field is named the way the form names it.
  let labels = {}; try { labels = Object.fromEntries((await import('./clients.js')).clientFields(state.constants, { isNew: false }).filter(f => f.name && f.label).map(f => [f.name, f.label])); } catch { /* the names as given */ }
  const label = (x) => labels[x.replace(/ /g, '_')] || (x.charAt(0).toUpperCase() + x.slice(1));
  const who = t.client_name || n.code;
  const open = ['open', 'in_progress'].includes(t.status);
  const seen = async () => { await put(`/api/tasks/${t.id}`, { status: 'done' }); toast('Marked as seen', 'ok'); m.close(); onDone && onDone(); };
  const m = modal('A change to your client\'s record', h('div', { 'data-change-notice': t.id },
    h('p', {}, `${n.editor} changed ${who}'s record. They are not on this client's care team, so the primary worker is told.`),
    kv([['Changed by', n.editor], ['Client', t.client_id ? h('span', {}, who, t.client_name ? h('span', { class: 'small muted mono' }, ` ${n.code}`) : null) : who],
      ['When', fmt.dt(t.updated_at || t.created_at)], ['Fields changed', h('ul', { 'data-notice-fields': '1', style: { margin: 0, paddingLeft: '1.2rem' } }, n.fields.map(x => h('li', {}, label(x))))], ['Status', open ? 'Not seen yet' : 'Seen']]),
    h('p', { class: 'small muted' }, `The record shows each field as it is now. SUDS keeps which fields were changed, not what they held before, so if something looks wrong, ask ${n.editor}.`),
    h('div', { class: 'btn-row' },
      t.client_id ? h('a', { class: 'btn', href: `#/client/${t.client_id}`, 'data-notice-client': '1', onClick: () => m.close() }, 'View client') : null,
      open && can('tasks:write') && mayChange(t.assigned_to) ? h('button', { type: 'button', class: 'btn primary', 'data-notice-seen': '1', onClick: seen }, 'Mark as seen') : null)));
  return m;
}
export function taskTable(rows, { showClient = true, onChange, bulk = false } = {}) {
  const overdue = t => t.due_at && ['open', 'in_progress'].includes(t.status) && fmt.isPast(t.due_at) && !changeNotice(t);
  const canBulk = bulk && can('tasks:write');
  // Closing out a list of to-dos one checkbox at a time is the common case; select several and clear
  // them in one request each instead of one round trip per box.
  const bulkable = rows.filter(t => t.status !== 'done');
  const selected = new Set();
  const boxes = new Map();
  const countEl = h('span', { class: 'small muted' }, '0 selected');
  const markBtn = h('button', { class: 'btn sm primary', disabled: true, onClick: async () => {
    const ids = [...selected];
    // Several to-dos at once is exactly where a stray tap does the most damage, so say how many first.
    if (!(await confirmDialog('Mark selected done', `Mark ${ids.length} to-do${ids.length === 1 ? '' : 's'} as done?`, { okText: `Mark ${ids.length} done` }))) return;
    markBtn.disabled = true;
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
    // Named columns ("Done", "Select"): two blank-headed boxes side by side were both read out as "Actions".
    { label: 'Done', render: t => can('tasks:write') ? h('input', {
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
    canBulk ? { label: 'Select', render: t => { if (t.status === 'done') return null; const box = h('input', { type: 'checkbox', 'aria-label': `Select "${t.title}"`, onChange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); updateCount(); } }); boxes.set(t.id, box); return box; } } : null,
    { label: 'To-do', render: t => h('div', {}, h('span', { style: t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : {} }, t.is_milestone ? '★ ' : '', t.title), changeNotice(t) ? h('div', { class: 'small muted' }, `Changed: ${changeNotice(t).fields.join(', ')}`) : t.description ? h('div', { class: 'small muted' }, t.description.slice(0, 120)) : null) },
    showClient ? { label: 'Client', render: t => t.client_id ? h('a', { href: `#/client/${t.client_id}` }, t.client_name || t.client_code, t.client_name ? h('div', { class: 'muted small mono' }, t.client_code) : null) : '—' } : null,
    { label: 'Due', render: t => h('span', { style: overdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, t.due_at ? fmt.dt(t.due_at) : '—', overdue(t) ? ' — overdue' : '') },
    { label: 'Priority', render: t => badge(fmt.label(t.priority), statusKind(t.priority)) }, { label: 'Status', render: t => badge(fmt.label(t.status), statusKind(t.status)) }, { label: 'Assignee', key: 'assignee' },
    { label: '', render: t => changeNotice(t) ? h('button', { class: 'btn sm', 'data-open-notice': t.id, onClick: () => openChangeNotice(t, { onDone: onChange }) }, 'View change') : !can('tasks:write') ? null : !mayChangeTask(t) ? viewOnly(t.assignee, { verb: 'Assigned to', more: '; you can mark it done' }) : h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openTaskForm(t, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this to-do', onClick: async () => { if (await confirmDialog('Delete to-do', 'Delete this to-do?', { danger: true, okText: 'Delete' })) { await del(`/api/tasks/${t.id}`); onChange && onChange(); } } }, '✕')) },
  ].filter(Boolean), rows, { empty: 'Nothing here. To-dos you add, and follow-ups from visits and calls, will show up in this list.',
    rowLabel: t => t.title,
    // The done box stays on the phone row: a to-do list you cannot tick off one-handed is not a to-do list.
    compact: { primary: t => [h('span', { class: 'row nowrap', style: { gap: '.4rem', minWidth: 0 } }, // Inside a 44px label (.tap-target): the box itself is 24px, and a near miss used to open the to-do
      // (the row) instead of ticking it off.
      can('tasks:write') ? h('label', { class: 'tap-target', onClick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': `Mark "${t.title}" ${t.status === 'done' ? 'not done' : 'done'}`, onClick: (e) => e.stopPropagation(), onChange: async (e) => {
        const wanted = e.target.checked; e.target.disabled = true;
        try { await put(`/api/tasks/${t.id}`, { status: wanted ? 'done' : 'open' }); toast(wanted ? 'Marked done' : 'Reopened', 'ok'); onChange && onChange(); }
        catch (err) { e.target.checked = !wanted; toast(err.message || 'Could not update this to-do. Check your connection and try again.', 'error'); }
        finally { e.target.disabled = false; }
      } })) : null, h('span', { style: t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : {} }, t.is_milestone ? '★ ' : '', t.title)), badge(fmt.label(t.priority), statusKind(t.priority))],
      secondary: t => [showClient && t.client_id ? h('span', {}, t.client_name || t.client_code) : null, changeNotice(t) ? h('span', {}, `Changed: ${changeNotice(t).fields.join(', ')}`) : h('span', { style: overdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, t.due_at ? (overdue(t) ? 'overdue · ' : 'due ') + fmt.dt(t.due_at) : 'no due date'), t.status === 'done' ? badge('Done', 'ok') : null],
      onTap: t => (changeNotice(t) ? openChangeNotice(t, { onDone: onChange }) : can('tasks:write') && mayChangeTask(t) ? openTaskForm(t, { onDone: onChange }) : openTaskView(t)) } });
  return toolbar ? h('div', {}, toolbar, tbl) : tbl;
}
route('tasks', async (r) => {
  const status = r.query.get('status') || 'open'; const mine = r.query.get('mine') !== '0'; const overdue = r.query.get('overdue') === '1';
  const qs = `limit=300&status=${status}${mine ? '&mine=1' : ''}${overdue ? '&overdue=1' : ''}`;
  const data = await get(`/api/tasks?${qs}`);
  const refresh = () => nav(`tasks?status=${status}&mine=${mine ? 1 : 0}${overdue ? '&overdue=1' : ''}&_=${Date.now()}`);
  if (r.query.get('id')) { const t = data.rows.find(x => x.id === r.query.get('id')); if (t) setTimeout(() => (changeNotice(t) ? openChangeNotice(t, { onDone: refresh }) : openTaskForm(t, { onDone: refresh })), 0); }
  const sel = h('select', { onChange: () => nav(`tasks?status=${sel.value}&mine=${mine ? 1 : 0}`) }, [['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  // SUPRT-A follow-ups due (a reassessment, annual assessment, baseline or closeout), for a program with SOR money.
  const suprtDue = await (await import('./suprt.js')).suprtDueCard();
  return h('div', {},
    pageHead('To-dos', can('tasks:write') ? h('button', { class: 'btn primary', onClick: () => openTaskForm(null, { onDone: refresh }) }, '+ Add a to-do') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sel), h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(`tasks?status=${status}&mine=${mine ? 0 : 1}`) }, 'Assigned to me'), h('button', { class: `btn sm ${overdue ? 'primary' : ''}`, onClick: () => nav(`tasks?status=open&mine=${mine ? 1 : 0}${overdue ? '' : '&overdue=1'}`) }, 'Overdue')),
    suprtDue,
    taskTable(data.rows, { onChange: refresh, bulk: true }));
});
