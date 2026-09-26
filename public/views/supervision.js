// What is waiting on a supervisor: notes to countersign, drafts the team has left, time to approve, and
// referrals with no outcome recorded. Before this, the dashboard only counted the signed-in user's own
// unsigned notes, so none of this was visible to the person responsible for it.
import { h, route, get, post, state, toast, table, badge, fmt, can, pageHead, nav, emptyState, modal, form, announce, confirmDialog, pageTabs } from '../app.js';
import { openNote, signatureDialog } from './notes.js';
import { openOutcomeForm } from './referrals.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
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
      done: refresh });
  };

  // Countersignature and the team's unsigned drafts are for someone who can countersign (notes:cosign). A
  // role that only approves time (finance) used to see both, permanently empty, with nothing it could do.
  const cosignRows = q.awaiting_cosignature || [];
  const picked = new Set();
  const pickedCount = h('span', { class: 'small muted', 'data-cosign-picked': '0' }, '');
  const showPicked = () => { pickedCount.textContent = picked.size ? `${picked.size} selected` : ''; pickedCount.dataset.cosignPicked = String(picked.size); };
  if (can('notes:cosign')) page.append(h('section', { class: 'card', 'data-section': 'cosign' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Notes waiting for your countersignature'), badge(String(cosignRows.length), cosignRows.length ? 'warn' : 'ok')),
    cosignRows.length ? h('div', {}, table([
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
  const drafts = q.unsigned_notes || [];
  const overdue = drafts.filter(d => d.overdue).length;
  if (can('notes:cosign')) page.append(h('section', { class: 'card', 'data-section': 'unsigned' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Unsigned notes across your team'),
      badge(overdue ? `${overdue} overdue` : String(drafts.length), overdue ? 'danger' : drafts.length ? 'warn' : 'ok')),
    drafts.length ? table([
      { label: 'Client', render: clientCell },
      { label: 'Author', key: 'author' },
      { label: 'Kind', render: r => fmt.label(r.kind) },
      { label: 'Started', render: r => h('span', { style: r.overdue ? { color: 'var(--danger)' } : {} }, fmt.date(r.created_at), r.overdue ? ' — overdue' : '') },
    ], drafts, { onRow: (r) => openNote(r.id, { onChange: refresh }) })
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
      try {
        const r = await post('/api/time/approve-batch', { ids, decision, note });
        toast(`${plural(r[decision] || 0, 'entry', 'entries')} ${decision}`, 'ok');
        if (r.skipped && r.skipped.length) toast(`${r.skipped.length} skipped (${r.skipped[0].reason})`, 'warn');
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
    page.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Staff time waiting for approval'),
        badge(q.time_totals ? `${plural(q.time_totals.entries, 'entry', 'entries')} · ${hoursOf(q.time_totals.minutes)}` : '0', rows.length ? 'warn' : 'ok')),
      rows.length ? h('div', {},
        table([
          { label: '', render: r => h('input', { type: 'checkbox', 'aria-label': `Select ${r.worker}, ${fmt.date(r.work_date)}`, onChange: (e) => { e.stopPropagation(); if (e.target.checked) selected.add(r.id); else selected.delete(r.id); announce(`${selected.size} selected`); } }) },
          { label: 'Worker', key: 'worker' },
          { label: 'Date', render: r => fmt.date(r.work_date) },
          { label: 'Minutes', key: 'minutes', num: true },
          { label: 'Activity', render: r => fmt.label(r.category, 'TIME_CATEGORIES') },
          { label: 'Client', render: clientCell },
          { label: 'Fund', render: r => r.funding_source || '—' },
          { label: '', render: r => h('div', { class: 'row' },
            h('button', { class: 'btn sm primary', onClick: (e) => { e.stopPropagation(); decide('approved', [r.id]); } }, 'Approve'),
            h('button', { class: 'btn sm', onClick: (e) => { e.stopPropagation(); decide('rejected', [r.id]); } }, 'Return')) },
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
        h('div', { class: 'card-head' }, h('h2', {}, 'Open patient requests'), badge(late.length ? `${prq.length} open · ${late.length} overdue` : String(prq.length), late.length ? 'danger' : prq.length ? 'warn' : 'ok')),
        h('p', { class: 'small muted' }, 'Requests for access, amendment, restriction or an accounting of disclosures. Each must be answered within 30 days of receipt.'),
        prq.length ? table([
          { label: 'Client', render: x => h('a', { href: `#/client/${x.client_id}/requests` }, x.client_code) },
          { label: 'Request', render: x => fmt.label(x.kind) },
          { label: 'Received', render: x => fmt.date(x.received_at) },
          { label: 'Due', render: x => h('span', { style: x.overdue ? { color: 'var(--danger)', fontWeight: 600 } : {} }, fmt.date(x.due_at), x.overdue ? ' — overdue' : '') },
          { label: 'Handled by', key: 'handler' },
        ], prq.slice(0, 50), { rowLabel: (x) => `${fmt.label(x.kind)} request for ${x.client_code}` })
          : emptyState('No open requests', 'Patient-rights requests recorded on a client\'s Requests tab appear here until they are fulfilled or denied.')));
    }
  }

  // ---- referrals that never closed the loop ----
  // A row opens that referral's outcome form (what closes the loop); without write access, the client's
  // referrals list.
  const openReferral = async (r) => {
    if (!can('referrals:write')) { nav(`referrals?client_id=${r.client_id}`); return; }
    try { const row = (await get(`/api/referrals/${r.id}`)).row; openOutcomeForm(row, refresh); } catch (e) { toast(e.message, 'error'); }
  };
  const open = q.referrals_awaiting_outcome || [];
  const revoked = q.referrals_consent_revoked || [];
  if (open.length || revoked.length) {
    page.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Referrals needing attention')),
      revoked.length ? h('div', { class: 'banner error', role: 'alert' },
        `${plural(revoked.length, 'referral', 'referrals')} relied on a consent that has since been revoked. Stop sharing information and close them out.`) : null,
      revoked.length ? table([
        { label: 'Client', render: clientCell }, { label: 'Referred to', key: 'resource' },
      ], revoked, { onRow: openReferral }) : null,
      open.length ? h('div', { 'data-awaiting-outcome': String(open.length) }, h('h2', { class: 'mt' }, 'No outcome recorded yet'),
        h('p', { class: 'small muted' }, 'Referrals the provider has been told about (contacted through scheduled) where nobody has recorded what happened.'),
        table([
          { label: 'Client', render: clientCell }, { label: 'Referred to', key: 'resource' },
          { label: 'Sent', render: r => fmt.date(r.referred_at) }, { label: 'Status', render: r => badge(fmt.label(r.status, 'REFERRAL_STATUSES')) },
        ], open, { onRow: openReferral })) : null));
  }

  return h('div', {},
    pageHead('Supervision'),
    tabs,
    glassCount ? h('div', { class: 'banner error', role: 'alert' }, `${plural(glassCount, 'emergency access or re-admission', 'emergency accesses and re-admissions')} ${glassCount === 1 ? 'is' : 'are'} waiting for review. `, h('a', { href: '#/supervision?tab=breakglass' }, 'Review now')) : null,
    h('p', { class: 'muted' }, can('notes:cosign') ? 'Work that is waiting on you: countersignatures, unsigned notes, staff time, and referrals that have not closed the loop.' : 'Work that is waiting on you: staff time to approve, and anything else your role reviews.'),
    page);
});
