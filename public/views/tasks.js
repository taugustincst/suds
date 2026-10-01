import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, kv, mayChange, ownedNotice, viewOnly, undoToast } from '../app.js';

// Where a to-do just marked done went (1.23.3): the To-dos list showing Done. `mine` keeps the list's own "Assigned to
// me" choice where there is one; elsewhere (Home, a client's to-dos) it is "mine" when the to-do is assigned to this
// person, so the list shown has it in it.
export const doneListHash = (t, mine) => `tasks?status=done&mine=${(mine ?? t.assigned_to === state.user.id) ? 1 : 0}`;
// The "Done" message after a to-do is ticked off: Undo puts it back as it was (an in-progress to-do stays in progress,
// 1.23.2), and "View in Done" opens the Done list with it, first and marked "Just done" (`focus`; 1.23.4). `onUndone` redraws the page it was done on, and only while
// the person is still on that page (Undo after moving on reopens it where they are).
export function doneToast(t, { mine, onUndone } = {}) {
  const page = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  return undoToast(`Done: ${t.title}`, async () => {
    await put(`/api/tasks/${t.id}`, { status: t.status === 'in_progress' ? 'in_progress' : 'open' });
    if (onUndone && (location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard') === page) onUndone();
  }, { also: { text: 'View in Done', key: 'view-done', onClick: () => nav(`${doneListHash(t, mine)}&focus=${encodeURIComponent(t.id)}&_=${Date.now()}`) } });
}

export function openTaskForm(values, { clientId, clientDisplay, onDone } = {}) {
  const isNew = !values;
  const f = form([
    { name: 'title', label: 'Title', required: true, span: true }, { name: 'client_id', label: 'Client (optional)', type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    { name: 'assigned_to', label: 'Assigned to', type: 'user', value: values?.assigned_to || state.user.id, exceptRoles: ['finance', 'readonly'] }, { name: 'due_at', label: 'Due', type: 'datetime', quick: true },
    { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'urgent'], value: 'normal', noBlank: true, required: true },
    // A new to-do is open (1.22.0: the Status choice is on the edit form only; nobody makes a to-do already done).
    isNew ? null : { name: 'status', label: 'Status', type: 'select', options: ['open', 'in_progress', 'done', 'cancelled'], value: 'open', noBlank: true, required: true },
    { name: 'is_milestone', label: 'Milestone (shows on client timeline)', type: 'checkbox' }, { name: 'description', label: 'Details', type: 'textarea', span: true },
  ].filter(Boolean), { values: values || {}, submitText: isNew ? 'Create to-do' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) await post('/api/tasks', d); else await put(`/api/tasks/${values.id}`, { ...d, if_updated_at: values.updated_at });
    toast('To-do saved', 'ok'); m.close(); onDone && onDone();
  } });
  const src = isNew ? null : sourceButton(values, () => m.close(), onDone);
  const m = modal(isNew ? 'New to-do' : 'Edit to-do', src ? h('div', {}, h('p', { class: 'btn-row' }, src), f) : f);
}
// ---- the record a to-do came from (1.23.1) ----
// A follow-up from a call or a visit, a referral's to-do and a supervisor's reminder to record a referral's outcome
// carry that record's id (tasks.call_id, intervention_id, referral_id), so the to-do opens it: a call or a visit as
// the call's or visit's own card (with Edit), a referral on the client's Referrals tab, and a supervisor's reminder
// (server/routes/supervision.js) straight in the referral's Record outcome form, which is what it asks for.
const REMINDER = /^Record what happened with your referral to /;
const SOURCES = [['referral_id', 'referral', 'referrals:read', '/api/referrals/'], ['intervention_id', 'visit', 'interventions:read', '/api/interventions/'], ['call_id', 'call', 'calls:read', '/api/calls/']];
// A supervisor's reminder to finish and sign notes (1.23.3; the office's `sign_reminder` mark, server/rules/notes.js
// isSignReminder) has no note id (that would be a new column), but it is about the author's drafts on its client's
// record: it opens the client's Notes tab showing the reader's own drafts. It used to open only as Edit to-do, with no way
// to the notes it asks for (market evaluation of 1.23.2, D2).
const readsNotes = () => ['notes:admin:read', 'notes:clinical:read', 'notes:admin:write', 'notes:clinical:write'].some(p => can(p));
function sourceOf(t) {
  if (t && t.sign_reminder && t.client_id && readsNotes()) return { id: t.client_id, noun: 'notes', label: `Open ${t.client_name || t.client_code || 'the client'}'s notes` };
  for (const [col, noun, perm, url] of SOURCES) if (t && t[col] && can(perm)) return { id: t[col], noun, url };
  return null;
}
async function openSource(t, onDone) {
  const s = sourceOf(t);
  if (s.noun === 'notes') { nav(`client/${encodeURIComponent(s.id)}/notes?drafts=mine`); return; }
  let row;
  try { row = (await get(s.url + encodeURIComponent(s.id))).row; } catch (e) { toast(e && e.status === 404 ? `That ${s.noun} is no longer there.` : (e && e.message) || `The ${s.noun} could not be opened.`, 'error'); return; }
  if (s.noun === 'call') (await import('./calls.js')).openCallView(row, { onChange: onDone });
  else if (s.noun === 'visit') (await import('./interventions.js')).openVisitView(row, { onChange: onDone });
  else if (REMINDER.test(t.title || '') && !row.outcome_recorded_at && can('referrals:write')) (await import('./referrals.js')).openOutcomeForm(row, onDone);
  else nav(`client/${row.client_id}/referrals`);
}
/**
 * What deleting a call, visit or referral does to its to-dos, as a sentence for the confirmation (1.23.3), or '' when
 * it has none open: its follow-up to-do is cancelled while it is as SUDS made it, and a referral's supervisor's
 * reminder to record its outcome is cancelled (server/rules/follow-ups.js cancelForDeleted). `col` is the to-do's link.
 */
export async function deleteNotice(col, rec) {
  if (!rec || !rec.id || !rec.client_id || !can('tasks:read')) return '';
  let rows; try { rows = (await get(`/api/tasks?client_id=${encodeURIComponent(rec.client_id)}&status=open&limit=500`, { quiet: true })).rows || []; } catch { return ''; }
  const linked = rows.filter(t => t[col] === rec.id);
  const isReminder = (t) => col === 'referral_id' && REMINDER.test(t.title || '') && t.created_by && t.created_by !== t.assigned_to;
  const reminder = linked.some(isReminder);
  const followUps = linked.filter(t => !isReminder(t));
  const followUp = followUps.some(t => untouched(col, rec, t));
  const edited = followUps.some(t => !untouched(col, rec, t));
  if (!followUp && !reminder && !edited) return '';
  const what = [followUp ? 'its open follow-up to-do' : null, reminder ? 'the supervisor\'s reminder to record its outcome' : null].filter(Boolean).join(' and ');
  // Said only when a follow-up has been changed (it read "(a follow-up to-do someone has edited is left open)" on every
  // call; market evaluation of 1.23.3, N4).
  return `${what ? ` ${what[0].toUpperCase()}${what.slice(1)} ${followUp && reminder ? 'are' : 'is'} cancelled too.` : ''}${edited ? ` ${followUp ? 'A follow-up to-do someone has changed' : 'Its follow-up to-do has been changed since it was made, so it'} is left open.` : ''}`;
}
// Whether a follow-up to-do is still as SUDS made it, so deleting its record cancels it: the office's rule
// (server/rules/follow-ups.js, "untouched"): open, not started; its record's worker's; SUDS's title; due on the record's
// follow-up date; no details added.
const FOLLOW_UP_TITLE = { call_id: /^(Call|Text) back(:|$)/, intervention_id: /^Follow up: /, referral_id: /^Follow up on referral to / };
function untouched(col, rec, t) {
  const due = col === 'call_id' ? (rec.follow_up_needed ? rec.follow_up_due : null) : rec.follow_up_due;
  return t.status === 'open' && t.assigned_to === rec.user_id && !t.description && !!due && String(t.due_at || '').slice(0, 10) === String(due).slice(0, 10)
    && (!FOLLOW_UP_TITLE[col] || FOLLOW_UP_TITLE[col].test(t.title || ''));
}
/** The same on a phone's to-do row (1.23.2), which opens the to-do itself on a tap: this button opens the record,
 *  named with the to-do's title for a screen reader ("Open the call: Call back"). */
function rowSource(t, onDone) {
  const b = sourceButton(t, null, onDone); if (!b) return null;
  b.setAttribute('aria-label', `${b.textContent}: ${t.title}`);
  b.addEventListener('click', (e) => e.stopPropagation());
  return b;
}
/** "Open the call", "Open the visit" or "Open the referral" for a to-do that came from one ("Open <client>'s notes" for a
 *  reminder to sign them), else null. */
export function sourceButton(t, close, onDone) {
  const s = sourceOf(t);
  if (!s) return null;
  return h('button', { type: 'button', class: 'btn sm', 'data-task-source': s.noun, onClick: () => { if (close) close(); openSource(t, onDone); } }, s.label || `Open the ${s.noun}`);
}
// A to-do is changed by whoever it is assigned to or made it, or someone who manages others' records
// (server/rules/tasks.js editableBy); anyone who can write to-dos may still mark it done.
const mayChangeTask = (t) => mayChange(t.assigned_to, t.created_by);
/**
 * Open a to-do from a list that shows only its title (Home's "To-dos for today", 1.23.2): the call, visit or referral
 * it came from when it has one (as "Open the call" does), a change notice as its card, otherwise the to-do itself:
 * its form, or read-only when it is someone else's. Home's list carries only the title, so the to-do is fetched first.
 */
export async function openTodo(id, onDone) {
  let t;
  try { t = (await get(`/api/tasks/${encodeURIComponent(id)}`)).row; } catch (e) { toast(e && e.status === 404 ? 'That to-do is no longer there.' : (e && e.message) || 'The to-do could not be opened.', 'error'); return; }
  if (changeNotice(t)) return openChangeNotice(t, { onDone });
  if (sourceOf(t)) return openSource(t, onDone);
  return can('tasks:write') && mayChangeTask(t) ? openTaskForm(t, { onDone }) : openTaskView(t);
}
/** Someone else's to-do on a phone, to read: it used to open as a form whose Save was then refused. */
function openTaskView(t) {
  const src = sourceButton(t, () => m.close());
  const m = modal('To-do', h('div', { 'data-task-view': t.id }, can('tasks:write') ? ownedNotice(t.assignee, { verb: 'Assigned to' }) : null, src ? h('p', { class: 'btn-row' }, src) : null,
    kv([['To-do', t.title], ['Client', t.client_name || t.client_code || null], ['Due', t.due_at ? fmt.dt(t.due_at) : null], ['Priority', fmt.label(t.priority)], ['Status', fmt.label(t.status)],
      ['Assigned to', t.assignee], ['Details', t.description ? h('div', { style: { whiteSpace: 'pre-wrap' } }, t.description) : null]]),
    can('tasks:write') ? h('p', { class: 'small muted' }, 'You can still mark it done with its box in the list.') : null));
}
// ---- Client-change notices (1.16.1) ----
// When someone off a client's care team changes the client's record, the primary worker gets a to-do saying who
// changed which fields (server/rules/clients.js notifyPrimary). It is something to read, not to edit, so it opens
// as a card. Only the server's mark (`notice: true`, server/rules/tasks.js isNotice: how the to-do was raised) makes
// one: its text is anyone's to type (security review of 1.16.2, L3). This is the one place that decides it.
/** { editor, code, fields } for a change notice, or null for an ordinary to-do. */
export function changeNotice(t) {
  if (!t || t.notice !== true) return null;
  const m = /^(.+?) changed (.+?)'s record\b/.exec(t.title || '') || [];
  const listed = (/^Changed: (.*)$/m.exec(t.description || '') || /\((.*)\)\s*$/.exec(t.title || '') || [])[1] || '';
  // Who made the change is the audit entry's (`notice_by`), never the title's words, which its holder can edit (r9 N5).
  return { editor: t.notice_by || 'Someone off the care team', code: m[2] || t.client_code || 'the client', fields: listed.split(', ').map(x => x.trim()).filter(Boolean) };
}
/** A change notice, read-only: who changed which fields, the client, and Mark as seen for the person told (only them:
 * anyone else who opens it, a supervisor or the editor, sees who it was sent to, r9 M2). */
export async function openChangeNotice(t, { onDone } = {}) {
  const n = changeNotice(t); if (!n) return null;
  // The client form's own labels ("ASAM level of care"), where a field is named the way the form names it.
  let labels = {}; try { labels = Object.fromEntries((await import('./clients.js')).clientFields(state.constants, { isNew: false }).filter(f => f.name && f.label).map(f => [f.name, f.label])); } catch { /* the names as given */ }
  const label = (x) => labels[x.replace(/ /g, '_')] || (x.charAt(0).toUpperCase() + x.slice(1));
  const who = t.client_name || n.code;
  const open = ['open', 'in_progress'].includes(t.status);
  const mine = t.assigned_to === state.user.id; const sentTo = t.assignee || 'the primary worker';
  // "See what changed": the record's History, with this notice's changes brought into view.
  const revs = Array.isArray(t.notice_revisions) ? t.notice_revisions.filter(x => /^[\w-]+$/.test(String(x))) : [];
  const seeWhat = t.client_id && revs.length && (mine || can('records:manage-others')) ? `#/client/${t.client_id}/history?rev=${revs.map(encodeURIComponent).join(',')}` : null;
  const seen = async () => { await put(`/api/tasks/${t.id}`, { status: 'done' }); toast('Marked as seen', 'ok'); m.close(); onDone && onDone(); };
  const m = modal(mine ? 'A change to your client\'s record' : 'A change to a client\'s record', h('div', { 'data-change-notice': t.id },
    h('p', {}, `${n.editor} changed ${who}'s record. They are not on this client's care team, so ${mine ? 'you, the primary worker, are' : 'the primary worker is'} told.`),
    kv([['Changed by', n.editor], ['Client', t.client_id ? h('span', {}, who, t.client_name ? h('span', { class: 'small muted mono' }, ` ${t.client_code || n.code}`) : null) : who],
      ['When', fmt.dt(t.created_at || t.updated_at)], ['Fields changed', h('ul', { 'data-notice-fields': '1', style: { margin: 0, paddingLeft: '1.2rem' } }, n.fields.map(x => h('li', {}, label(x))))], mine ? null : ['Sent to', sentTo], ['Status', open ? (mine ? 'Not seen yet' : `Not seen yet by ${sentTo}`) : 'Seen']].filter(Boolean)),
    // What the fields held before and hold now is on the record's History (1.17.0), for the primary worker and
    // supervisors: the notice links to the changes it reports (server/client-revisions.js).
    h('p', { class: 'small muted' }, seeWhat ? 'See what changed shows each field\'s value before and after, and lets you put a change back.' : `The record's History shows what each field held before and after${mine ? '' : ', for the client\'s care team and supervisors'}.`),
    h('div', { class: 'btn-row' },
      seeWhat ? h('a', { class: 'btn', href: seeWhat, 'data-notice-history': '1', onClick: () => m.close() }, 'See what changed') : null,
      t.client_id ? h('a', { class: 'btn', href: `#/client/${t.client_id}`, 'data-notice-client': '1', onClick: () => m.close() }, 'View client') : null,
      open && can('tasks:write') && mine ? h('button', { type: 'button', class: 'btn primary', 'data-notice-seen': '1', onClick: seen }, 'Mark as seen') : null)));
  return m;
}
// `mine`: the list's "Assigned to me" choice, kept by "View in Done" (doneToast).
// `justDone`: the to-do View in Done came for, marked so it is found at once.
export function taskTable(rows, { showClient = true, onChange, bulk = false, mine, justDone = null } = {}) {
  const fresh = (t) => (justDone && t.id === justDone ? h('span', { 'data-just-done': t.id }, badge('Just done', 'ok')) : null);
  // Ticked off: "Done" with Undo and View in Done; unticked: reopened.
  const tick = async (t, wanted) => {
    await put(`/api/tasks/${t.id}`, { status: wanted ? 'done' : 'open' });
    if (wanted) doneToast(t, { mine, onUndone: onChange }); else toast('Reopened', 'ok');
    onChange && onChange();
  };
  const overdue = t => t.due_at && ['open', 'in_progress'].includes(t.status) && fmt.isPast(t.due_at) && !changeNotice(t);
  const canBulk = bulk && can('tasks:write');
  // A change notice is marked seen only by the person it was sent to (r9 M2): nobody else gets its box.
  const tickable = t => can('tasks:write') && !(changeNotice(t) && t.assigned_to !== state.user.id);
  // Closing out a list of to-dos one checkbox at a time is the common case; select several and clear
  // them in one request each instead of one round trip per box.
  const bulkable = rows.filter(t => t.status !== 'done' && tickable(t));
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
    { label: 'Done', render: t => tickable(t) ? h('input', {
      type: 'checkbox', checked: t.status === 'done', title: 'Mark done',
      'aria-label': `Mark "${t.title}" ${t.status === 'done' ? 'not done' : 'done'}`,
      onChange: async (e) => {
        const wanted = e.target.checked;
        e.target.disabled = true;
        try { await tick(t, wanted); } catch (err) {
          // Silently reverting used to leave the worker believing a to-do was ticked off when it was not.
          e.target.checked = !wanted;
          toast(err.message || 'Could not update this to-do. Check your connection and try again.', 'error');
        } finally { e.target.disabled = false; }
      },
    }) : null },
    canBulk ? { label: 'Select', render: t => { if (t.status === 'done' || !tickable(t)) return null; const box = h('input', { type: 'checkbox', 'aria-label': `Select "${t.title}"`, onChange: (e) => { if (e.target.checked) selected.add(t.id); else selected.delete(t.id); updateCount(); } }); boxes.set(t.id, box); return box; } } : null,
    { label: 'To-do', render: t => h('div', {}, h('span', { style: t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : {} }, t.is_milestone ? '★ ' : '', t.title), fresh(t) ? [' ', fresh(t)] : null, changeNotice(t) ? h('div', { class: 'small muted' }, `Changed: ${changeNotice(t).fields.join(', ')}`) : t.description ? h('div', { class: 'small muted' }, t.description.slice(0, 120)) : null) },
    showClient ? { label: 'Client', render: t => t.client_id ? h('a', { href: `#/client/${t.client_id}` }, t.client_name || t.client_code, t.client_name ? h('div', { class: 'muted small mono' }, t.client_code) : null) : '—' } : null,
    { label: 'Due', render: t => h('span', { style: overdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, t.due_at ? fmt.dt(t.due_at) : '—', overdue(t) ? ' — overdue' : '') },
    { label: 'Priority', render: t => badge(fmt.label(t.priority), statusKind(t.priority)) }, { label: 'Status', render: t => badge(fmt.label(t.status), statusKind(t.status)) }, { label: 'Assignee', key: 'assignee' },
    { label: '', render: t => changeNotice(t) ? h('button', { class: 'btn sm', 'data-open-notice': t.id, onClick: () => openChangeNotice(t, { onDone: onChange }) }, 'View change') : !can('tasks:write') ? sourceButton(t, null, onChange) : !mayChangeTask(t) ? h('div', {}, sourceButton(t, null, onChange), viewOnly(t.assignee, { verb: 'Assigned to', more: '; you can mark it done' })) : h('div', { class: 'row nowrap' }, sourceButton(t, null, onChange), h('button', { class: 'btn sm', onClick: () => openTaskForm(t, { onDone: onChange }) }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this to-do', onClick: async () => { if (await confirmDialog('Delete to-do', 'Delete this to-do?', { danger: true, okText: 'Delete' })) { await del(`/api/tasks/${t.id}`); onChange && onChange(); } } }, '✕')) },
  ].filter(Boolean), rows, { empty: 'Nothing here. To-dos you add, and follow-ups from visits and calls, will show up in this list.',
    rowLabel: t => t.title,
    // The done box stays on the phone row: a to-do list you cannot tick off one-handed is not a to-do list.
    compact: { primary: t => [h('span', { class: 'row nowrap', style: { gap: '.4rem', minWidth: 0 } }, // Inside a 44px label (.tap-target): the box itself is 24px, and a near miss used to open the to-do
      // (the row) instead of ticking it off.
      tickable(t) ? h('label', { class: 'tap-target', onClick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': `Mark "${t.title}" ${t.status === 'done' ? 'not done' : 'done'}`, onClick: (e) => e.stopPropagation(), onChange: async (e) => {
        const wanted = e.target.checked; e.target.disabled = true;
        try { await tick(t, wanted); }
        catch (err) { e.target.checked = !wanted; toast(err.message || 'Could not update this to-do. Check your connection and try again.', 'error'); }
        finally { e.target.disabled = false; }
      } })) : null, h('span', { style: t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : {} }, t.is_milestone ? '★ ' : '', t.title)), badge(fmt.label(t.priority), statusKind(t.priority))],
      // The record it came from, a tap away on the row itself (1.23.2): it was only inside Edit.
      secondary: t => [showClient && t.client_id ? h('span', {}, t.client_name || t.client_code) : null, changeNotice(t) ? h('span', {}, `Changed: ${changeNotice(t).fields.join(', ')}`) : h('span', { style: overdue(t) ? { color: 'var(--danger)', fontWeight: 600 } : {} }, t.due_at ? (overdue(t) ? 'overdue · ' : 'due ') + fmt.dt(t.due_at) : 'no due date'), t.status === 'done' ? badge('Done', 'ok') : null, fresh(t),
        changeNotice(t) ? null : rowSource(t, onChange)],
      onTap: t => (changeNotice(t) ? openChangeNotice(t, { onDone: onChange }) : can('tasks:write') && mayChangeTask(t) ? openTaskForm(t, { onDone: onChange }) : openTaskView(t)) } });
  return toolbar ? h('div', {}, toolbar, tbl) : tbl;
}
route('tasks', async (r) => {
  const status = r.query.get('status') || 'open'; const mine = r.query.get('mine') !== '0'; const overdue = r.query.get('overdue') === '1';
  const qs = `limit=300&status=${status}${mine ? '&mine=1' : ''}${overdue ? '&overdue=1' : ''}`;
  const data = await get(`/api/tasks?${qs}`);
  // View in Done (doneToast) names the to-do just done: it comes first, marked, rather than wherever its due date puts
  // it in the list (the oldest due first: a phone showed older to-dos and not the one just ticked, external retest of
  // 1.23.3), and is read on its own if the list does not have it.
  const focus = status === 'done' ? r.query.get('focus') : null;
  if (focus) {
    let t = data.rows.find(x => x.id === focus);
    if (!t) { try { const one = (await get(`/api/tasks/${encodeURIComponent(focus)}`, { quiet: true })).row; if (one && one.status === 'done') t = one; } catch { /* gone: the list as it is */ } }
    if (t) data.rows = [t, ...data.rows.filter(x => x.id !== focus)];
  }
  const refresh = () => nav(`tasks?status=${status}&mine=${mine ? 1 : 0}${overdue ? '&overdue=1' : ''}&_=${Date.now()}`);
  if (r.query.get('id')) { const t = data.rows.find(x => x.id === r.query.get('id')); if (t) setTimeout(() => (changeNotice(t) ? openChangeNotice(t, { onDone: refresh }) : openTaskForm(t, { onDone: refresh })), 0); }
  const sel = h('select', { onChange: () => nav(`tasks?status=${sel.value}&mine=${mine ? 1 : 0}`) }, [['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  // SUPRT-A follow-ups due (a reassessment, annual assessment, baseline or closeout), for a program with SOR money.
  const suprtDue = await (await import('./suprt.js')).suprtDueCard();
  return h('div', {},
    pageHead('To-dos', can('tasks:write') ? h('button', { class: 'btn primary', onClick: () => openTaskForm(null, { onDone: refresh }) }, '+ Add a to-do') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sel), h('button', { class: `btn sm ${mine ? 'primary' : ''}`, onClick: () => nav(`tasks?status=${status}&mine=${mine ? 0 : 1}`) }, 'Assigned to me'), h('button', { class: `btn sm ${overdue ? 'primary' : ''}`, onClick: () => nav(`tasks?status=open&mine=${mine ? 1 : 0}${overdue ? '' : '&overdue=1'}`) }, 'Overdue')),
    suprtDue,
    taskTable(data.rows, { onChange: refresh, bulk: true, mine, justDone: focus }));
});
