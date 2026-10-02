// What is waiting on a supervisor: notes to countersign, drafts the team has left, time to approve, and
// referrals with no outcome recorded. Before this, the dashboard only counted the signed-in user's own
// unsigned notes, so none of this was visible to the person responsible for it.
import { h, route, get, post, state, toast, table, badge, fmt, can, pageHead, nav, emptyState, modal, form, announce, confirmDialog, pageTabs } from '../app.js';
import { openNote, signatureDialog, ssoReauthNotice } from './notes.js';
import { openOutcomeForm } from './referrals.js';
import { approvalProof } from '../passkey.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The last line of a "Finish and sign" reminder's details (1.23.2; the same words as server/rules/notes.js
// SIGN_REMINDER): what the worker is told, and how the queue knows that author already has an open reminder for their
// drafts on that client's record. Until 1.23.2 the line named the note's record id, which the worker read as noise; a
// reminder made with it still counts, for its note.
const SIGN_REMINDER = 'This reminder closes itself once your draft notes on this client\'s record are signed.';
const OLD_REMINDER_REF = /Reference: supervision reminder for note ([\w-]{8,})/;
const pairOf = (clientId, authorId) => `${clientId} ${authorId}`;
const hoursOf = (m) => fmt.mins(m);
// Who the row is about: the client's name for a role that may open the client (the server leaves
// client_name null for everyone else), with the code beside it; the code alone otherwise.
const clientCell = (r) => (r.client_name ? h('span', { 'data-client-name': '1' }, r.client_name, ' ', h('span', { class: 'small muted' }, `(${r.client_code})`)) : (r.client_code || '—'));
const who = (r) => (r.client_name ? `${r.client_name} (${r.client_code})` : r.client_code);
// A countersignature certifies that the supervisor read the note, so the note itself is what they sign under.
const noteBody = (n) => (n.structured
  ? h('div', {}, Object.entries(n.structured).map(([k, v]) => (v ? h('div', { class: 'mb' }, h('b', {}, k), h('div', { style: { whiteSpace: 'pre-wrap' } }, v)) : null)))
  : h('pre', { class: 'note' }, n.content || ''));

route('supervision', async (r) => {
  ssoReauthNotice(r.query); // back from a single sign-on confirmation started in the countersign dialog
  const tab = r.query.get('tab') === 'breakglass' && can('audit:read') ? 'breakglass' : 'queue';
  const q = await get('/api/supervision/queue');
  const page = h('div');

  const refresh = async () => { nav(`supervision?${tab === 'breakglass' ? 'tab=breakglass&' : ''}_=${Date.now()}`); };

  // ---- break-glass review ----
  // Every emergency access to a clinical note waits here until someone with audit rights has looked at it.
  // Acknowledging records that the review happened; it does not make the access retroactively ordinary.
  const glassCount = q.breakglass_unacknowledged || 0;
  const tabs = can('audit:read') ? pageTabs([['queue', 'Queue'], ['breakglass', `Access to review${glassCount ? ` (${glassCount})` : ''}`, { 'data-tab-breakglass': '1' }]], tab, (k) => nav(k === 'queue' ? 'supervision' : 'supervision?tab=breakglass'), { label: 'Supervision sections' }) : null;
  if (tab === 'breakglass') {
    const g = await get('/api/supervision/breakglass');
    const ack = async (row) => {
      try { await post(`/api/supervision/breakglass/${row.id}/ack`, {}); toast('Reviewed', 'ok'); refresh(); }
      catch (e) { toast(e.message, 'error'); }
    };
    page.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Access awaiting review'), badge(String(g.rows.length), g.rows.length ? 'danger' : 'ok')),
      h('p', { class: 'small muted' }, 'Two kinds of exception land here: someone outside the treating roles opened a clinical note with a break-glass reason, or a worker re-admitted a discharged client who was not on their caseload (a returning client found by the intake duplicate check). Confirm each one was appropriate (the reason, the person, the client) and acknowledge it. Every access and every acknowledgement is in the audit log.'),
      g.rows.length ? table([
        { label: 'When', render: x => fmt.dt(x.at) },
        { label: 'Who', render: x => `${x.user_name} (${fmt.label(x.user_role)})` },
        { label: 'Client', render: x => x.client_code || '—' },
        { label: 'What', render: x => x.kind === 'readmission' ? h('span', { 'data-readmission': '1' }, badge('Re-admission', 'warn'), ' ', h('a', { href: `#/client/${x.client_id}` }, 'Took a discharged client onto their caseload')) : x.note_id ? h('a', { href: `#/notes/${x.note_id}` }, 'One note') : 'Note list' },
        { label: 'Reason given', render: x => h('div', { style: { whiteSpace: 'pre-wrap' } }, x.reason) },
        { label: '', render: x => h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm primary', 'data-ack-breakglass': x.id, onClick: (e) => { e.stopPropagation(); ack(x); } }, 'Acknowledge'),
          // Not justified: acknowledged all the same, and a draft goes to the incident register (a possible breach).
          h('button', { class: 'btn sm danger', 'data-concern-breakglass': x.id, onClick: async (e) => {
            e.stopPropagation();
            const note = await confirmDialog('Flag a concern', 'What is wrong with this access? It is acknowledged, and a draft incident opens in the privacy incident register for a breach determination.', { danger: true, okText: 'Flag and open incident', requireReason: true, minLength: 10 });
            if (!note) return;
            try { await post(`/api/supervision/breakglass/${x.id}/ack`, { concern: true, note }); toast('Flagged — a draft incident is open under Privacy & Part 2', 'ok'); refresh(); } catch (err) { toast(err.message, 'error'); }
          } }, 'Flag a concern')) },
      ], g.rows, { rowLabel: (x) => `Break-glass by ${x.user_name} for ${x.client_code || 'a client'}` })
        : emptyState('Nothing waiting', 'Emergency accesses and re-admissions from outside a caseload appear here until a supervisor or privacy officer acknowledges them.')));
    return h('div', {}, pageHead('Supervision'), tabs, page);
  }

  // ---- countersignatures ----
  // One note, or several read one after the other in the same dialog: either way one confirmation (and the
  // password or code only if it has been a while), and a countersignature — hash and audit entry — per note.
  const cosign = async (rows) => {
    const notes = [];
    for (const row of rows) { try { notes.push({ row, n: (await get(`/api/notes/${row.id}`)).note }); } catch (e) { toast(e.message, 'error'); return; } }
    const one = notes.length === 1;
    // Several notes: each one gets its own optional comment, under that note. One comment copied onto every
    // note could put one client's details on another client's record (the server refuses that too).
    const commentFor = {};
    const list = h('div', { 'data-cosign-list': String(notes.length) }, notes.map(({ row, n }, i) => {
      let comment = null;
      if (!one) {
        const fid = `cosign-comment-${i}`;
        commentFor[row.id] = h('textarea', { id: fid, rows: 2, maxlength: 1000, 'data-cosign-comment': row.id, 'aria-describedby': `${fid}-help` });
        comment = h('div', { class: 'field' }, h('label', { for: fid }, `Comment on note ${i + 1} (optional)`), commentFor[row.id],
          h('div', { class: 'help small muted', id: `${fid}-help` }, 'Saved on this note only.'));
      }
      return h('section', { class: 'card tight mb', 'data-cosign-content': row.id },
        h('h3', { class: 'eyebrow' }, `${one ? '' : `${i + 1} of ${notes.length}: `}${n.title || fmt.label(n.kind)}`),
        h('p', { class: 'small' }, `Written by ${row.author} on ${fmt.date(row.occurred_at)} for ${who(row)}.`),
        h('div', { 'data-scroll-region': '1', style: { maxHeight: one ? '40vh' : '30vh', overflow: 'auto' } }, noteBody(n)),
        comment);
    }));
    signatureDialog({ title: one ? 'Countersign this note' : `Countersign ${notes.length} notes`, submitText: one ? 'Countersign' : `Countersign ${notes.length} notes`,
      intro: h('div', {}, list, h('p', { class: 'small muted' }, `Countersigning records your approval alongside the author${one ? '' : ' of each note'}. It does not replace their signature — both names stay on the record.`)),
      fields: one ? [{ name: 'note', label: 'Comment (optional)', type: 'textarea', rows: 2, span: true }] : [],
      send: async (body) => {
        if (one) { await post(`/api/notes/${notes[0].row.id}/cosign`, { ...body, note: (body.note || '').trim() || undefined }); toast('Countersigned', 'ok'); return; }
        const comments = {};
        for (const [id, el] of Object.entries(commentFor)) { const t = el.value.trim(); if (t) comments[id] = t; }
        const r = await post('/api/notes/cosign-batch', { ...body, ids: notes.map(x => x.row.id), comments });
        toast(`${plural(r.cosigned.length, 'note', 'notes')} countersigned`, 'ok');
        if (r.skipped.length) toast(`${r.skipped.length} not countersigned: ${r.skipped[0].reason}`, 'warn');
      },
      passkey: one ? { purpose: 'note.cosign', params: { note_id: notes[0].row.id } } : { purpose: 'note.cosign-batch', params: { ids: notes.map(x => x.row.id) } },
      done: refresh });
  };

  // Countersignature and the team's unsigned drafts are for someone who can countersign (notes:cosign). A
  // role that only approves time (finance) used to see both, permanently empty, with nothing it could do.
  const cosignRows = q.awaiting_cosignature || [];
  const picked = new Set();
  const pickedCount = h('span', { class: 'small muted', 'data-cosign-picked': '0' }, '');
  // "Select all": ticks (or clears) every note's box. It shows as partly ticked while only some are.
  const selectAll = h('input', { type: 'checkbox', 'data-cosign-select-all': '1', onChange: (e) => {
    for (const box of document.querySelectorAll('[data-cosign-pick]')) { box.checked = e.target.checked; if (e.target.checked) picked.add(box.dataset.cosignPick); else picked.delete(box.dataset.cosignPick); }
    showPicked(); announce(`${picked.size} selected`);
  } });
  const showPicked = () => {
    pickedCount.textContent = picked.size ? `${picked.size} selected` : ''; pickedCount.dataset.cosignPicked = String(picked.size);
    selectAll.checked = cosignRows.length > 0 && picked.size === cosignRows.length; selectAll.indeterminate = picked.size > 0 && picked.size < cosignRows.length;
  };
  if (can('notes:cosign')) page.append(h('section', { class: 'card', 'data-section': 'cosign' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Notes waiting for your countersignature'), badge(String(cosignRows.length), cosignRows.length ? 'warn' : 'ok')),
    cosignRows.length ? h('div', {}, cosignRows.length > 1 ? h('label', { class: 'check', style: { marginTop: 0 } }, selectAll, `Select all ${cosignRows.length} notes`) : null, table([
      { label: '', srLabel: 'Select', render: r => h('input', { type: 'checkbox', 'data-cosign-pick': r.id, 'aria-label': `Select the note by ${r.author} for ${r.client_code}`, onClick: (e) => e.stopPropagation(), onChange: (e) => { if (e.target.checked) picked.add(r.id); else picked.delete(r.id); showPicked(); announce(`${picked.size} selected`); } }) },
      { label: 'Client', render: clientCell },
      { label: 'Author', key: 'author' },
      { label: 'Note', render: r => [r.title || fmt.label(r.kind), r.cosign_requested ? [' ', badge('Review requested by author', 'warn')] : null] },
      { label: 'Signed', render: r => fmt.dt(r.signed_at) },
      { label: '', render: r => h('button', { class: 'btn sm primary', onClick: (e) => { e.stopPropagation(); cosign([r]); } }, 'Countersign') },
    ], cosignRows, { onRow: (r) => openNote(r.id, { onChange: refresh }) }),
    cosignRows.length > 1 ? h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', 'data-cosign-selected': '1', onClick: () => { const rows = cosignRows.filter(r => picked.has(r.id)); if (!rows.length) { toast('Select the notes to countersign first', 'error'); return; } cosign(rows); } }, 'Review and countersign selected'),
      pickedCount) : null)
      : emptyState('Nothing to countersign', 'Notes by staff who need supervision appear here once they have signed them — and any note a worker sends you for review.')));

  // ---- unsigned drafts across the team ----
  // Each draft opens in place (Open note), and its author can be sent a reminder: a to-do assigned to them on
  // the client's record, through the ordinary to-do route (POST /api/tasks: encrypted title and details,
  // audited). One open reminder per author and client: it asks for that draft and closes once the author has no
  // draft left on the client's record (server/rules/notes.js closeSignReminders), so a draft whose author already
  // has one there is not reminded again, whoever sent it. Recognised by its last line, SIGN_REMINDER, and (1.23.3) only
  // when the office says it is one (`sign_reminder`: its maker may send reminders, server/rules/notes.js isSignReminder),
  // so a to-do anyone else wrote with the line does not show a draft as reminded.
  const drafts = q.unsigned_notes || [];
  const overdue = drafts.filter(d => d.overdue).length;
  const mayRemind = can('tasks:write');
  const reminded = new Map(); // note id -> the open reminder to-do
  if (mayRemind && drafts.length) {
    try {
      const open = (await get('/api/tasks?status=open&limit=1000', { quiet: true })).rows || [];
      const byPair = new Map();
      for (const t of open) {
        if (!t.sign_reminder) continue;
        const m = OLD_REMINDER_REF.exec(t.description || '');
        if (m) reminded.set(m[1], t);
        else if ((t.description || '').includes(SIGN_REMINDER) && !byPair.has(pairOf(t.client_id, t.assigned_to))) byPair.set(pairOf(t.client_id, t.assigned_to), t);
      }
      for (const d of drafts) if (!reminded.has(d.id) && byPair.has(pairOf(d.client_id, d.author_id))) reminded.set(d.id, byPair.get(pairOf(d.client_id, d.author_id)));
    } catch { /* no reminders known: every row still offers one, and the server audits each */ }
  }
  // An author whose account is deactivated (left, or a caseload moved on) is not reminded: nobody would read it (1.23.5).
  const gone = (r) => r.author_active === 0;
  const remindable = (r) => mayRemind && r.author_id && r.author_id !== state.user.id && !gone(r);
  const remind = (r) => post('/api/tasks', {
    client_id: r.client_id, assigned_to: r.author_id,
    // It covers every draft of theirs on that client's record and closes when the last is signed (or deleted), so it
    // is about the client, not one note (market evaluation of 1.23.2, D3); the last line stays SIGN_REMINDER. The to-do
    // is on the client's record, and every list shows its client beside the title, so neither names them again (Home
    // read "…for Park, Danielle (DEMO-0007) · Park, Danielle"; market evaluation of 1.23.3, N4).
    title: 'Finish and sign your draft notes',
    description: `${state.user.display_name} asked you to finish and sign your draft notes on this client's record${r.overdue ? ' (at least one is overdue)' : ''}. Open them from the client's Notes tab. This reminder is closed for you once they are all signed.\n${SIGN_REMINDER}`,
    due_at: fmt.today(), priority: r.overdue ? 'high' : 'normal',
  });
  const remindOne = async (r, btn) => {
    if (btn) btn.disabled = true;
    try { await remind(r); toast(`Reminder sent to ${r.author}`, 'ok'); refresh(); }
    catch (e) { if (btn) btn.disabled = false; toast(e.message, 'error'); }
  };
  // The drafts to send a reminder for: none already reminded, and one per author and client.
  const toRemind = (rows) => { const seen = new Set(); return rows.filter(r => !reminded.has(r.id) && !seen.has(pairOf(r.client_id, r.author_id)) && seen.add(pairOf(r.client_id, r.author_id))); };
  const remindAll = async () => {
    const due = drafts.filter(r => r.overdue && remindable(r));
    const fresh = toRemind(due);
    const skip = due.filter(r => reminded.has(r.id)).length;
    if (!fresh.length) { toast(skip ? 'Every overdue note already has an open reminder' : 'No overdue notes to remind anyone about'); return; }
    const authors = new Set(fresh.map(r => r.author_id)).size;
    const ok = await confirmDialog('Remind all overdue authors',
      `Send ${plural(fresh.length, 'reminder', 'reminders')} — one to-do for each author and client with an overdue note (${plural(authors, 'person', 'people')}), due today.${skip ? ` ${plural(skip, 'note already has', 'notes already have')} an open reminder and ${skip === 1 ? 'is' : 'are'} not reminded again.` : ''}`,
      { okText: `Send ${plural(fresh.length, 'reminder', 'reminders')}` });
    if (!ok) return;
    let sent = 0; let failed = null;
    for (const r of fresh) { try { await remind(r); sent++; } catch (e) { failed = failed || e.message; } }
    toast(`${plural(sent, 'reminder', 'reminders')} sent`, sent ? 'ok' : 'error');
    if (failed) toast(`Not every reminder was sent: ${failed}`, 'warn');
    refresh();
  };
  const overdueToRemind = toRemind(drafts.filter(r => r.overdue && remindable(r))).length;
  const overdueUnreminded = drafts.filter(r => r.overdue && remindable(r) && !reminded.has(r.id)).length;
  if (can('notes:cosign')) page.append(h('section', { class: 'card', 'data-section': 'unsigned' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Unsigned notes across your team'),
      badge(overdue ? `${overdue} overdue` : String(drafts.length), overdue ? 'danger' : drafts.length ? 'warn' : 'ok')),
    drafts.length ? h('div', {}, table([
      { label: 'Client', render: clientCell },
      { label: 'Author', key: 'author' },
      { label: 'Kind', render: r => fmt.label(r.kind) },
      { label: 'Started', render: r => h('span', { style: r.overdue ? { color: 'var(--danger)' } : {} }, fmt.date(r.created_at), r.overdue ? ' — overdue' : '') },
      { label: 'Reminder', render: r => reminded.has(r.id) ? h('span', { 'data-reminded': r.id }, badge(`Sent ${fmt.date(reminded.get(r.id).created_at)}`, 'info')) : h('span', { class: 'small muted' }, '—') },
      { label: '', render: r => h('div', { class: 'row nowrap' },
        h('button', { class: 'btn sm', 'data-open-note': r.id, 'aria-label': `Open note — ${r.author}, ${fmt.date(r.created_at)}`, onClick: () => openNote(r.id, { onChange: refresh }) }, 'Open note'),
        remindable(r) && !reminded.has(r.id) ? h('button', { class: 'btn sm', 'data-remind-author': r.id, 'aria-label': `Remind author — ${r.author}, ${fmt.date(r.created_at)}`, onClick: (e) => remindOne(r, e.currentTarget) }, 'Remind author')
          : mayRemind && gone(r) ? h('span', { class: 'small muted', 'data-author-inactive': r.id }, 'Author no longer active') : null) },
    ], drafts),
    mayRemind && overdue ? h('div', { class: 'btn-row' },
      h('button', { class: 'btn', 'data-remind-all': String(overdueToRemind), onClick: remindAll }, 'Remind all overdue authors'),
      h('span', { class: 'small muted' }, overdueUnreminded ? `${plural(overdueUnreminded, 'overdue note has', 'overdue notes have')} no open reminder yet.` : 'Every overdue note has an open reminder.')) : null)
      : emptyState('Everything is signed', 'Draft notes left by your team would show here.')));

  // ---- staff time ----
  if (q.time_awaiting_approval) {
    const rows = q.time_awaiting_approval;
    const selected = new Set();
    const decide = async (decision, ids) => {
      if (!ids.length) { toast('Select at least one entry', 'error'); return; }
      // Returning time is confirmed and needs a reason, the same as rejecting an expenditure: the worker
      // sees it on their My time page, and there is no undo for a mis-click on "Return".
      let note;
      if (decision === 'rejected') {
        note = await confirmDialog(ids.length === 1 ? 'Return this entry' : `Return ${ids.length} entries`, `Send ${ids.length === 1 ? 'it' : 'them'} back to be corrected? The worker will see your reason.`, { okText: 'Return', requireReason: true });
        if (!note) return;
      }
      // Approving may be confirmed with a fingerprint (docs/FINGERPRINT.md): offered when this person has a passkey
      // here, and required (a fingerprint or an authenticator code) when the programme says so.
      let proof = { body: {} };
      if (decision === 'approved') {
        proof = await approvalProof({ title: ids.length === 1 ? 'Approve this time' : `Approve ${ids.length} entries`, okText: 'Approve',
          message: ids.length === 1 ? `Approve ${what(rows.find(r => r.id === ids[0]) || { minutes: 0, work_date: '', worker: '' })}?` : `Approve ${ids.length} time entries?`,
          bind: { purpose: 'time.approve', params: { ids, decision } } });
        if (!proof) return;
      }
      try {
        const r = await post('/api/time/approve-batch', { ids, decision, note, ...proof.body });
        toast(`${plural(r[decision] || 0, 'entry', 'entries')} ${decision}`, 'ok');
        if (r.skipped && r.skipped.length) toast(`${r.skipped.length} skipped (${r.skipped[0].reason})`, 'warn');
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
    // Each row's checkbox, so "Select all" can tick them; and each row's buttons named for the entry they act on
    // ("Approve 2h 30m on 28 Sep 2026 for Maria Rivera"), not a column of identical "Approve"s (1.16.0).
    const boxes = [];
    const what = (r) => `${fmt.mins(r.minutes)} on ${fmt.date(r.work_date)} for ${r.worker}`;
    const selectAll = h('input', { type: 'checkbox', id: 'time-select-all', 'data-time-select-all': '1', onChange: (e) => {
      for (const b of boxes) { b.box.checked = e.target.checked; if (e.target.checked) selected.add(b.id); else selected.delete(b.id); }
      announce(`${selected.size} selected`);
    } });
    const syncAll = () => { selectAll.checked = boxes.length > 0 && boxes.every(b => b.box.checked); selectAll.indeterminate = !selectAll.checked && boxes.some(b => b.box.checked); };
    page.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Staff time waiting for approval'),
        badge(q.time_totals ? `${plural(q.time_totals.entries, 'entry', 'entries')} · ${hoursOf(q.time_totals.minutes)}` : '0', rows.length ? 'warn' : 'ok')),
      rows.length ? h('div', {},
        h('label', { class: 'check', for: 'time-select-all' }, selectAll, `Select all (${rows.length})`),
        table([
          { label: '', render: r => { const box = h('input', { type: 'checkbox', 'aria-label': `Select ${what(r)}`, 'data-time-select': r.id, onChange: (e) => { e.stopPropagation(); if (e.target.checked) selected.add(r.id); else selected.delete(r.id); syncAll(); announce(`${selected.size} selected`); } }); boxes.push({ id: r.id, box }); return box; } },
          { label: 'Worker', key: 'worker' },
          { label: 'Date', render: r => fmt.date(r.work_date) },
          { label: 'Minutes', key: 'minutes', num: true },
          { label: 'Activity', render: r => fmt.label(r.category, 'TIME_CATEGORIES') },
          { label: 'Client', render: clientCell },
          { label: 'Fund', render: r => r.funding_source || '—' },
          { label: '', render: r => h('div', { class: 'row' },
            h('button', { class: 'btn sm primary', 'aria-label': `Approve ${what(r)}`, onClick: (e) => { e.stopPropagation(); decide('approved', [r.id]); } }, 'Approve'),
            h('button', { class: 'btn sm', 'aria-label': `Return ${what(r)}`, onClick: (e) => { e.stopPropagation(); decide('rejected', [r.id]); } }, 'Return')) },
        ], rows, { rowLabel: (r) => `${r.worker}, ${fmt.date(r.work_date)}, ${r.minutes} minutes` }),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onClick: () => decide('approved', [...selected]) }, 'Approve selected'),
          h('button', { class: 'btn', onClick: () => decide('rejected', [...selected]) }, 'Return selected'),
          h('span', { class: 'small muted' }, 'You cannot approve your own time.')))
        : emptyState('No time waiting', 'Time your staff submit for the period appears here.')));
  }

  // ---- patient-rights requests on the 30-day clock ----
  // A count, and the overdue ones by name: the request itself lives on the client's Requests tab.
  if (can('patient-requests:read')) {
    let prq = null; try { prq = (await get('/api/patient-requests?status=open&limit=500', { quiet: true })).rows; } catch { prq = null; }
    if (prq) {
      const late = prq.filter(x => x.overdue);
      page.append(h('section', { class: 'card', 'data-patient-requests': '1' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Open client rights requests'), badge(late.length ? `${prq.length} open · ${late.length} overdue` : String(prq.length), late.length ? 'danger' : prq.length ? 'warn' : 'ok')),
        h('p', { class: 'small muted' }, 'Requests for access, amendment, restriction or an accounting of disclosures. Each must be answered within 30 days of receipt.'),
        prq.length ? table([
          { label: 'Client', render: x => h('a', { href: `#/client/${x.client_id}/requests` }, x.client_code) },
          { label: 'Request', render: x => fmt.label(x.kind) },
          { label: 'Received', render: x => fmt.date(x.received_at) },
          { label: 'Due', render: x => h('span', { style: x.overdue ? { color: 'var(--danger)', fontWeight: 600 } : {} }, fmt.date(x.due_at), x.overdue ? ' — overdue' : '') },
          { label: 'Handled by', key: 'handler' },
        ], prq.slice(0, 50), { rowLabel: (x) => `${fmt.label(x.kind)} request for ${x.client_code}` })
          : emptyState('No open requests', 'Client rights requests recorded on a client\'s Requests tab appear here until they are fulfilled or denied.')));
    }
  }

  // ---- referrals that never closed the loop ----
  // "Waiting to hear what happened" (1.23.0): only referrals with no outcome at all — the provider was told and has
  // not answered, or the client had an appointment and nobody has said whether it happened (the server leaves out
  // accepted and waitlisted, which are the provider's answer). Each row has the same kind of actions as an unsigned
  // note: open the referral (the client's Referrals tab), remind the worker who made it (a to-do for them, linked to
  // the referral so recording the outcome closes it: POST /api/supervision/referrals/:id/remind), and record the
  // outcome, for a role that may. A row itself opens the outcome form (without write access, the referral).
  const mayRecord = can('referrals:write');
  const recordOutcome = async (r) => {
    try { const row = (await get(`/api/referrals/${r.id}`)).row; openOutcomeForm(row, refresh); } catch (e) { toast(e.message, 'error'); }
  };
  const openReferral = (r) => nav(r.client_name ? `client/${r.client_id}/referrals` : `referrals?client_id=${r.client_id}`);
  const onReferralRow = (r) => (mayRecord ? recordOutcome(r) : openReferral(r));
  const remindWorker = async (r, btn) => {
    if (btn) btn.disabled = true;
    try { const res = await post(`/api/supervision/referrals/${r.id}/remind`, {}); toast(`Reminder sent to ${res.worker || r.worker}`, 'ok'); refresh(); }
    catch (e) { if (btn) btn.disabled = false; toast(e.message, 'error'); }
  };
  // How long it has waited, in words: "today", "1 day", "12 days".
  const waited = (s) => { const d = Math.floor((Date.now() - new Date(s).getTime()) / 86400000); return d < 1 ? 'today' : d === 1 ? '1 day' : `${d} days`; };
  // Plain words for where it stands, instead of the status names.
  const whereItStands = (r) => (r.status === 'scheduled'
    ? h('div', { 'data-referral-stands': 'appointment' }, badge('Appointment set', 'info'), h('div', { class: 'small' }, r.appointment_at ? `${fmt.dt(r.appointment_at)} — did it happen?` : 'Did it happen?'))
    : h('div', { 'data-referral-stands': 'no-answer' }, badge('No answer yet', 'warn'), h('div', { class: 'small' }, 'The provider has not replied.')));
  const rowName = (r) => `${r.resource}, ${who(r)}`;
  const open = q.referrals_awaiting_outcome || [];
  const revoked = q.referrals_consent_revoked || [];
  if (open.length || revoked.length) {
    page.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Referrals needing attention')),
      revoked.length ? h('div', { class: 'banner error', role: 'alert' },
        `${plural(revoked.length, 'referral', 'referrals')} relied on a consent that has since been revoked. Stop sharing information and close them out.`) : null,
      revoked.length ? table([
        { label: 'Client', render: clientCell }, { label: 'Referred to', key: 'resource' },
      ], revoked, { onRow: onReferralRow }) : null,
      open.length ? h('div', { 'data-awaiting-outcome': String(open.length) }, h('h3', { class: 'mt' }, 'Waiting to hear what happened'),
        h('p', { class: 'small muted' }, 'Referrals where nobody has recorded what happened: the provider has not answered, or the client had an appointment and nobody has said whether it happened. Oldest first. A referral the provider accepted or put on its waiting list is not listed here.'),
        table([
          { label: 'Client', render: clientCell }, { label: 'Referred to', key: 'resource' },
          // How long it has waited, and who made it (1.22.0): whom to ask, and which to chase first (oldest first).
          { label: 'Waiting', render: r => h('div', {}, h('span', { 'data-referral-waiting': '1' }, waited(r.referred_at)), h('div', { class: 'small muted' }, `sent ${fmt.date(r.referred_at)}`)) },
          { label: 'Made by', render: r => r.worker || '—' },
          { label: 'Where it stands', render: whereItStands },
          { label: 'Reminder', render: r => (r.reminded_at ? h('span', { 'data-referral-reminded': r.id }, badge(`Sent ${fmt.date(r.reminded_at)}`, 'info')) : h('span', { class: 'small muted' }, '—')) },
          { label: '', render: r => h('div', { class: 'row' },
            r.client_name ? h('button', { class: 'btn sm', 'data-open-referral': r.id, 'aria-label': `Open referral — ${rowName(r)}`, onClick: (e) => { e.stopPropagation(); openReferral(r); } }, 'Open referral') : null,
            r.may_remind && !r.reminded_at ? h('button', { class: 'btn sm', 'data-remind-worker': r.id, 'aria-label': `Remind worker — ${r.worker}, ${rowName(r)}`, onClick: (e) => { e.stopPropagation(); remindWorker(r, e.currentTarget); } }, 'Remind worker') : null,
            mayRecord ? h('button', { class: 'btn sm primary', 'data-record-outcome': r.id, 'aria-label': `Record outcome — ${rowName(r)}`, onClick: (e) => { e.stopPropagation(); recordOutcome(r); } }, 'Record outcome') : null) },
        ], open, { onRow: onReferralRow })) : null));
  }

  return h('div', {},
    pageHead('Supervision'),
    tabs,
    glassCount ? h('div', { class: 'banner error', role: 'alert' }, `${plural(glassCount, 'emergency access or re-admission', 'emergency accesses and re-admissions')} ${glassCount === 1 ? 'is' : 'are'} waiting for review. `, h('a', { href: '#/supervision?tab=breakglass' }, 'Review now')) : null,
    h('p', { class: 'muted' }, can('notes:cosign') ? 'Work that is waiting on you: countersignatures, unsigned notes, staff time, and referrals that have not closed the loop.' : can('assignments:manage') ? 'Work that is waiting on you: staff time to approve, and anything else your role reviews.' : 'Staff time submitted for approval: approve it, or send it back to be corrected.'),
    page);
});
