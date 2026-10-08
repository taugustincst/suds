import { h, route, get, post, put, del, state, form, modal, toast, table, fmt, can, pageHead, confirmDialog, downloadCsv, nav, bars, stat, badge, announce, NOT_SAVED, addDaysLocal } from '../app.js';

// ---- possible duplicates (1.24.0) ----
// A start time with minutes is a range ("09:00–10:00"); the server compares ranges and descriptions
// (server/rules/time_entries.js duplicatesOf) and answers a likely duplicate with 409 { duplicate, candidates }.
const toMin = (t) => (/^\d{2}:\d{2}/.test(t || '') ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const timeRange = (r) => { const s = toMin(r.start_time); return s === null ? '' : `${hhmm(s)}–${hhmm(s + (Number(r.minutes) || 0))}`; };
const isDuplicate = (e) => e && e.status === 409 && e.data && e.data.duplicate === true && Array.isArray(e.data.candidates);
const whyMatched = (reasons) => reasons.map(x => (x === 'overlap' ? 'the times overlap' : 'the same minutes and description')).join(' and ');
/** One existing entry as the question names it: "1h 0m, 09:00–10:00, Admin — Outreach at the shelter". */
function candidateText(c) {
  const what = [fmt.mins(c.minutes), timeRange(c) || null, fmt.label(c.category, 'TIME_CATEGORIES'), c.client_name || c.client_code || null].filter(Boolean).join(', ');
  const note = c.description ? ` — ${c.description}` : c.description_withheld ? ' — description not shown to your role' : '';
  return `${what}${note}`;
}
/**
 * The question, asked inside the form (not a second dialog): which entry it may duplicate and why, then Merge, Save
 * anyway or Cancel. Resolves 'cancel', 'anyway' or { merge: candidateId, times: 'union' | 'keep' }.
 */
function askDuplicate(f, d, candidates) {
  return new Promise((resolve) => {
    const mergeable = candidates.filter(c => c.may_merge);
    const id = `time-dup-${Date.now()}`;
    const title = h('h3', { id, class: 'time-dup-title', tabindex: '-1' }, candidates.length === 1 ? 'This may be time already logged' : `This may be time already logged (${candidates.length} entries)`);
    const list = h('ul', { class: 'small' }, ...candidates.map(c => h('li', { 'data-time-dup-candidate': c.id },
      candidateText(c), h('span', { class: 'muted' }, ` (${whyMatched(c.reasons)})`),
      c.locked ? h('span', {}, ' ', badge('Approved: cannot be merged into', 'ok')) : null)));
    // Which entry to merge into, when there is more than one that can be.
    let target = mergeable[0] ? mergeable[0].id : null;
    const pickTarget = mergeable.length > 1 ? h('fieldset', { class: 'time-dup-choice' }, h('legend', {}, 'Merge into'),
      ...mergeable.map((c, i) => h('label', { class: 'check' }, h('input', { type: 'radio', name: `${id}-target`, value: c.id, checked: i === 0, onChange: () => { target = c.id; paintTimes(); } }), candidateText(c)))) : null;
    // When both say when they started and the times differ: combine both ranges (the default) or keep the existing one's.
    let times = 'union';
    const timesBox = h('div', {});
    const paintTimes = () => {
      timesBox.replaceChildren();
      const c = candidates.find(x => x.id === target);
      const a = c ? toMin(c.start_time) : null, b = toMin(d.start_time);
      if (a === null || b === null || (a === b && Number(c.minutes) === Number(d.minutes))) { times = 'union'; return; }
      const ae = a + Number(c.minutes), be = b + Number(d.minutes);
      if (!(a <= be && b <= ae)) { times = 'union'; return; }
      const s = Math.min(a, b), e = Math.max(ae, be);
      timesBox.append(h('fieldset', { class: 'time-dup-choice', 'data-time-dup-times': '' }, h('legend', {}, 'Times after merging'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: `${id}-times`, value: 'union', checked: times === 'union', onChange: () => { times = 'union'; } }), `Combine both: ${hhmm(s)}–${hhmm(e)} (${fmt.mins(e - s)})`),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: `${id}-times`, value: 'keep', checked: times === 'keep', onChange: () => { times = 'keep'; } }), `Keep the existing entry's: ${timeRange(c)} (${fmt.mins(c.minutes)})`)));
    };
    paintTimes();
    const done = (answer) => { box.remove(); resolve(answer); };
    const box = h('section', { class: 'banner warn span time-dup', 'aria-labelledby': id, 'data-time-duplicate': '' },
      title, list,
      h('p', { class: 'small' }, mergeable.length ? 'Merge keeps the entry already there and adds this one\'s description to it, so the time counts once. Save anyway keeps both.' : 'The entry already logged is approved, so this cannot be merged into it. Save anyway keeps both, or cancel and change this one.'),
      pickTarget, timesBox,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', 'data-time-dup-answer': 'cancel', 'aria-label': 'Cancel: do not save this entry', onClick: () => done('cancel') }, 'Cancel'),
        h('button', { type: 'button', class: 'btn', 'data-time-dup-answer': 'anyway', onClick: () => done('anyway') }, 'Save anyway'),
        mergeable.length ? h('button', { type: 'button', class: 'btn primary', 'data-time-dup-answer': 'merge', onClick: () => done({ merge: target, times }) }, 'Merge') : null));
    const row = f.querySelector(':scope > .btn-row');
    if (row) row.before(box); else f.append(box);
    announce(`${title.textContent}. ${candidates.map(candidateText).join('; ')}`);
    title.focus();
  });
}

export function openTimeForm(values, { clientId, clientDisplay, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  // New time is charged to the worker's default fund (or the programme's), as a new visit is (1.16.0).
  const defaultFund = state.defaultFundId && state.funds?.some(x => x.id === state.defaultFundId) ? state.defaultFundId : '';
  const seed = values || (defaultFund && can('budget:read') ? { funding_source_id: defaultFund } : {});
  const f = form([
    { name: 'work_date', label: 'Date', type: 'date', required: true, value: values?.work_date || fmt.today() }, { name: 'minutes', label: 'Minutes', type: 'number', min: 1, max: 1440, step: 1, required: true },
    { name: 'start_time', label: 'Start time (optional)', type: 'time', help: 'When it started — just type it, e.g. 14:30 or 2:30p. With the minutes, it lets SUDS notice time logged twice.' },
    { name: 'category', label: 'Category', type: 'select', list: 'TIME_CATEGORIES', value: 'direct_service', noBlank: true, required: true },
    { name: 'client_id', label: 'Client (optional)', type: 'client', value: clientId || values?.client_id, display: clientDisplay },
    can('budget:read') ? { name: 'funding_source_id', label: 'Charge to fund', type: 'fund' } : null, { name: 'billable', label: 'Billable', type: 'checkbox' },
    { name: 'description', label: 'Description', span: true, help: 'What the time was for. Managers who approve time without access to client records see only the category, fund and minutes.' },
    can('time:all') ? { name: 'user_id', label: 'Worker', type: 'user', value: values?.user_id || state.user.id } : null,
  ].filter(Boolean), { values: seed, submitText: isNew ? 'Log time' : 'Save', draftKey: isNew ? 'time:new' : `time:${values.id}`, onCancel: () => m.close(), onSubmit: async (d) => {
    // The same day and client as time a visit or call already logged: asked once more before saving (the
    // notice above said so already), never refused, since a second session with the same person is real time.
    if (isNew && d.client_id) await overlap.check();
    if (isNew && d.client_id && overlap.sameClient && !(await confirmDialog('Log this time as well?', `${overlap.text} Log ${d.minutes} more minutes anyway?`, { okText: 'Log it anyway', cancelText: 'Go back' }))) return NOT_SAVED;
    const send = (extra = {}) => (isNew ? post('/api/time', { ...d, ...extra }) : put(`/api/time/${values.id}`, { ...d, if_updated_at: values.updated_at, ...extra }));
    try { await send(); }
    catch (e) {
      // Time that looks already logged (1.24.0): asked here, in the form. Cancel saves nothing and leaves the form
      // open; Save anyway saves it (the server records the override); Merge folds it into the entry already there.
      if (!isDuplicate(e)) throw e;
      const answer = await askDuplicate(f, d, e.data.candidates);
      if (answer === 'cancel') { announce('Not saved.'); return NOT_SAVED; }
      if (answer === 'anyway') { await send({ save_anyway: true }); toast('Time saved', 'ok'); m.close(); onDone && onDone(); return; }
      const into = e.data.candidates.find(c => c.id === answer.merge);
      await post(`/api/time/${into.id}/merge`, { ...(isNew ? { entry: d } : { from_id: values.id, entry: d }), times: answer.times, if_updated_at: into.updated_at });
      toast('Merged into the entry already logged', 'ok'); m.close(); onDone && onDone(); return;
    }
    toast('Time saved', 'ok'); m.close(); onDone && onDone();
  } });
  const overlap = isNew ? overlapHint(f) : null;
  const m = modal(isNew ? 'Log time' : 'Edit time entry', f);
}
// A visit or a call logs its own time entry ("Also log this as a time entry"), so time typed in by hand for the
// same day (and client) may be the same work twice. Said before saving, never a block: a second session with
// the same person is real time too. Reads the day's entries and keeps those a visit or call logged (source).
// Returns { sameClient, text }, kept current, for the question asked on Save.
function overlapHint(f) {
  const state_ = { sameClient: false, text: '' };
  const hint = h('div', { class: 'banner warn small span hidden', role: 'status', 'data-time-overlap': '' });
  f.querySelector('[data-field="minutes"]').closest('.form-grid').append(hint);
  let seq = 0;
  const check = async () => {
    const mine = ++seq; const workDateInput = f.inputs.work_date; const day = (workDateInput && typeof workDateInput.parsedDate === 'function' ? workDateInput.parsedDate() : workDateInput && workDateInput.value) || ''; const client = f.inputs.client_id?.value || '';
    const worker = f.inputs.user_id?.value || state.user.id;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { hint.classList.add('hidden'); return; }
    let rows = [];
    try { rows = (await get(`/api/time?from=${day}&to=${day}&limit=200${can('time:all') ? `&user_id=${encodeURIComponent(worker)}` : ''}`, { quiet: true })).rows || []; } catch { rows = []; }
    if (mine !== seq) return;
    rows = rows.filter(r => (r.source === 'visit' || r.source === 'call') && r.user_id === worker);
    const same = client ? rows.filter(r => r.client_id === client) : rows;
    const whose = worker === state.user.id ? 'your' : `${(state.users.find(u => u.id === worker) || {}).display_name || 'this worker'}'s`;
    state_.sameClient = !!client && same.length > 0;
    if (!same.length) { hint.classList.add('hidden'); hint.dataset.timeOverlap = ''; hint.textContent = ''; state_.text = ''; return; }
    const mins = same.reduce((n, r) => n + (r.minutes || 0), 0);
    const visits = same.filter(r => r.source === 'visit').length; const calls = same.length - visits;
    const by = [visits ? (visits === 1 ? 'a visit' : `${visits} visits`) : null, calls ? (calls === 1 ? 'a call' : `${calls} calls`) : null].filter(Boolean).join(' and ');
    hint.dataset.timeOverlap = String(same.length);
    state_.text = `${fmt.mins(mins)} of ${whose} time on ${fmt.date(day)} was already logged by ${by}${client ? ' with this client' : ''}.`;
    hint.textContent = `${state_.text} Log this only if it is different time, or it counts twice.`;
    hint.classList.remove('hidden');
  };
  // A client chosen from the search list sets its value without a change event, so a click is checked too.
  const soon = () => setTimeout(check, 0);
  f.addEventListener('change', soon); f.addEventListener('click', (e) => { if (e.target.closest('[data-field="client_id"]')) setTimeout(check, 50); });
  check();
  state_.check = check;
  return state_;
}
const statusBadge = (r) => {
  const s = r.status || 'draft';
  if (s === 'approved') return badge('Approved', 'ok');
  if (s === 'submitted') return badge('Awaiting approval', 'warn');
  // The reason is on the page, not hidden in a tooltip nobody hovers: it is what the worker needs to fix.
  if (s === 'rejected') return h('span', {}, badge('Returned', 'danger'), r.approval_note ? h('div', { class: 'small', 'data-return-reason': '1' }, `Returned: ${r.approval_note}`) : null);
  return badge('Draft');
};

/**
 * Review a pair marked as a possible duplicate (a device's push, 1.24.0): merge this entry into the one it may
 * duplicate (the server keeps that one, combining the notes and times), or say it is not a duplicate. Used by the
 * time list and the approval queue (views/supervision.js).
 */
export function duplicateActions(r, what, onChange) {
  const mine = r.user_id === state.user.id;
  const mayMerge = can('time:write') && (mine || can('time:all')) && r.status !== 'approved' && r.duplicate_status !== 'approved';
  // On a device that syncs with an office the mark is the office's (sync does not carry clearing it), so it is cleared
  // there; SUDS on this device has no office and clears its own. Merge is an ordinary edit and deletion, which sync carries.
  const officeDevice = !!state.local && !window.SUDS_STATIC_HOST;
  const mayClear = !officeDevice && ((can('time:write') && (mine || can('time:all'))) || can('time:approve'));
  return h('div', { class: 'row nowrap' },
    mayMerge ? h('button', { class: 'btn sm', 'data-time-dup-merge': r.id, 'aria-label': `Merge ${what} into the entry it may duplicate`, onClick: async () => {
      if (!await confirmDialog('Merge these entries', 'Keep the earlier entry, add this one\'s description to it, combine their times, and delete this one?', { okText: 'Merge' })) return;
      try { await post(`/api/time/${r.duplicate_of}/merge`, { from_id: r.id }); toast('Merged', 'ok'); onChange && onChange(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Merge') : null,
    mayClear ? h('button', { class: 'btn sm', 'data-time-dup-clear': r.id, 'aria-label': `${what} is not a duplicate`, onClick: async () => {
      try { await post(`/api/time/${r.id}/not-duplicate`, {}); toast('Marked as not a duplicate', 'ok'); onChange && onChange(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Not a duplicate') : null,
    officeDevice ? h('span', { class: 'small muted', 'data-time-dup-office': r.id }, 'Not a duplicate? Clear the mark on the office SUDS.') : null);
}
export function timeTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'Date', render: r => h('span', {}, fmt.date(r.work_date), timeRange(r) ? h('div', { class: 'muted small', 'data-time-range': '' }, timeRange(r)) : null) }, { label: 'Worker', key: 'worker' }, showClient ? { label: 'Client', render: r => r.client_id ? h(can('clients:read') ? 'a' : 'span', can('clients:read') ? { href: `#/client/${r.client_id}` } : { class: 'client-plain' }, r.client_name || r.client_code, r.client_name ? h('div', { class: 'muted small mono' }, r.client_code) : null) : '—' } : null,
    { label: 'Category', render: r => fmt.label(r.category, 'TIME_CATEGORIES') }, { label: 'Minutes', key: 'minutes', num: true }, { label: 'Billable', render: r => r.billable ? badge('Yes', 'ok') : '' }, { label: 'Fund', render: r => r.funding_source || '—' },
    // Another worker's description is not sent to a role without access to client records (it can name the
    // client); the cell says so rather than looking empty.
    { label: 'Description', render: r => h('span', { class: 'small' }, r.description || (r.description_withheld ? h('span', { class: 'muted' }, 'Not shown to your role') : ''), (r.source || (r.intervention_id ? 'visit' : r.call_id ? 'call' : '')) === 'visit' ? h('span', { class: 'muted', 'data-time-source': 'visit' }, ' (from visit)') : (r.source === 'call' || r.call_id) ? h('span', { class: 'muted', 'data-time-source': 'call' }, ' (from call)') : null) },
    // A device's entry the office marked as a possible duplicate (1.24.0): said beside its status, for review.
    { label: 'Status', render: r => h('span', {}, statusBadge(r), r.duplicate_of ? h('div', { 'data-time-dup-mark': '' }, badge('Possible duplicate', 'warn')) : null) },
    { label: '', render: r => {
      const mine = r.user_id === state.user.id;
      const locked = r.status === 'approved';
      // Every row's buttons say which entry they act on (a screen reader's button list is otherwise "Approve,
      // Approve, Approve"): "Reopen 2h 30m on 28 Sep 2026 for Maria Rivera".
      const what = `${fmt.mins(r.minutes)} on ${fmt.date(r.work_date)}${mine ? '' : ` for ${r.worker}`}`;
      return h('div', { class: 'row nowrap' },
        // Submitted or approved time is a claim someone else has acted on; editing it silently would
        // undermine the approval it already carries.
        can('time:write') && (mine || can('time:all')) && !locked ? h('button', { class: 'btn sm', 'aria-label': `Edit ${what}`, onClick: () => openTimeForm(r, { onDone: onChange }) }, 'Edit') : null,
        mine && (r.status === 'draft' || r.status === 'rejected') ? h('button', { class: 'btn sm primary', 'aria-label': `Submit ${what}`, onClick: async () => {
          try { await post(`/api/time/${r.id}/submit`, {}); toast('Submitted for approval', 'ok'); onChange && onChange(); }
          catch (e) { toast(e.message, 'error'); }
        } }, 'Submit') : null,
        can('time:approve') && r.status === 'submitted' && !mine ? h('div', { class: 'row nowrap' },
          h('button', { class: 'btn sm primary', 'aria-label': `Approve ${what}`, onClick: async () => { try { await post(`/api/time/${r.id}/approve`, { decision: 'approved' }); toast('Approved', 'ok'); onChange && onChange(); } catch (e) { toast(e.message, 'error'); } } }, 'Approve'),
          h('button', { class: 'btn sm', 'aria-label': `Return ${what}`, onClick: async () => { const why = await confirmDialog('Return this entry', 'Send it back to the worker to correct?', { okText: 'Return', requireReason: true }); if (!why) return; try { await post(`/api/time/${r.id}/approve`, { decision: 'rejected', note: why }); toast('Returned', 'ok'); onChange && onChange(); } catch (e) { toast(e.message, 'error'); } } }, 'Return')) : null,
        // Approved time is locked (nobody edits or deletes it); a supervisor reopens it by returning it with a reason.
        can('time:approve') && locked && !mine ? h('button', { class: 'btn sm', 'data-time-reopen': '', 'aria-label': `Reopen ${what}`, onClick: async () => { const why = await confirmDialog('Reopen this entry', 'Approved time cannot be changed. Return it to the worker to correct and resubmit?', { okText: 'Reopen', requireReason: true }); if (!why) return; try { await post(`/api/time/${r.id}/approve`, { decision: 'rejected', note: why }); toast('Reopened for correction', 'ok'); onChange && onChange(); } catch (e) { toast(e.message, 'error'); } } }, 'Reopen') : null,
        r.duplicate_of ? duplicateActions(r, what, onChange) : null,
        can('time:write') && (mine || can('time:all')) && !locked ? h('button', { class: 'btn sm ghost', 'aria-label': `Delete ${what}`, onClick: async () => { if (await confirmDialog('Delete entry', 'Delete this time entry?', { danger: true, okText: 'Delete' })) { try { await del(`/api/time/${r.id}`); toast('Entry deleted', 'ok'); onChange && onChange(); } catch (e) { toast(e.message, 'error'); } } } }, '✕') : null);
    } },
  ].filter(Boolean), rows, { empty: 'No time entries.' });
}
route('time', async (r) => {
  const to = r.query.get('to') || fmt.today(); const from = r.query.get('from') || new Date(Date.parse(to) - 13 * 86400000).toISOString().slice(0, 10);
  const [data, sum] = await Promise.all([get(`/api/time?limit=500&from=${from}&to=${to}`), get(`/api/time/summary?from=${from}&to=${to}`)]);
  const refresh = () => nav(`time?from=${from}&to=${to}&_=${Date.now()}`);
  const fromI = h('input', { type: 'date', value: from }), toI = h('input', { type: 'date', value: to });
  const total = sum.by_category.reduce((s, x) => s + x.minutes, 0);
  return h('div', {},
    // Someone who sees everyone's time (time:all) is not looking at "My time".
    pageHead(can('time:all') ? 'Staff time' : 'My time',
      can('time:write') ? h('button', { class: 'btn primary', onClick: () => openTimeForm(null, { onDone: refresh }) }, '+ Log time') : null,
      // Nobody submits a fortnight of time one row at a time.
      can('time:write') ? h('button', { class: 'btn', onClick: async () => {
        if (!await confirmDialog('Submit this period', `Send every draft entry between ${fmt.date(from)} and ${fmt.date(to)} for approval?`, { okText: 'Submit' })) return;
        try { const res = await post('/api/time/submit-period', { from, to }); toast(res.submitted ? `${res.submitted} entr${res.submitted === 1 ? 'y' : 'ies'} submitted` : 'Nothing was waiting to be submitted', res.submitted ? 'ok' : ''); refresh(); }
        catch (e) { toast(e.message, 'error'); }
      } }, 'Submit period for approval') : null,
      can('time:approve') ? h('button', { class: 'btn', onClick: () => nav('supervision'), title: 'Approval happens on the Supervision page' }, 'Go to time approval') : null,
      can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/time?from=${from}&to=${to}&format=xlsx`) }, 'Export to Excel') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('button', { class: 'btn', onClick: () => nav(`time?from=${fromI.value}&to=${toI.value}`) }, 'Apply'),
      h('button', { class: 'btn ghost sm', onClick: () => { nav(`time?from=${addDaysLocal(-((new Date().getDay() + 6) % 7))}&to=${fmt.today()}`); } }, 'This week'),
      h('button', { class: 'btn ghost sm', onClick: () => nav(`time?from=${to.slice(0, 8)}01&to=${to}`) }, 'This month')),
    h('div', { class: 'grid cols-4 mb' }, stat('Total', fmt.mins(total)), stat('Entries', fmt.num(data.total)), stat('Workers', fmt.num(sum.by_worker.length)), stat('Avg / day', fmt.mins(sum.by_day.length ? Math.round(total / sum.by_day.length) : 0))),
    h('div', { class: 'grid cols-3 mb' }, h('div', { class: 'card' }, h('h2', {}, 'By category'), bars(sum.by_category, { valueKey: 'minutes', labelKey: 'category', format: fmt.mins, list: 'TIME_CATEGORIES' })),
      h('div', { class: 'card' }, h('h2', {}, 'By worker'), bars(sum.by_worker, { valueKey: 'minutes', labelKey: 'worker', format: fmt.mins })),
      h('div', { class: 'card' }, h('h2', {}, 'By funding source'), bars(sum.by_fund, { valueKey: 'minutes', labelKey: 'fund', format: fmt.mins }))),
    timeTable(data.rows, { onChange: refresh }));
});
