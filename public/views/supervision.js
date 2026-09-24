// What is waiting on a supervisor: notes to countersign, drafts the team has left, time to approve, and
// referrals with no outcome recorded. Before this, the dashboard only counted the signed-in user's own
// unsigned notes, so none of this was visible to the person responsible for it.
import { h, route, get, post, state, toast, table, badge, fmt, can, pageHead, nav, emptyState, modal, form, announce, confirmDialog } from '../app.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const hoursOf = (m) => fmt.mins(m);

route('supervision', async (r) => {
  const tab = r.query.get('tab') === 'breakglass' && can('audit:read') ? 'breakglass' : 'queue';
  const q = await get('/api/supervision/queue');
  const page = h('div');

  const refresh = async () => { nav(`supervision?${tab === 'breakglass' ? 'tab=breakglass&' : ''}_=${Date.now()}`); };

  // ---- break-glass review ----
  // Every emergency access to a clinical note waits here until someone with audit rights has looked at it.
  // Acknowledging records that the review happened; it does not make the access retroactively ordinary.
  const glassCount = q.breakglass_unacknowledged || 0;
  const tabs = can('audit:read') ? h('div', { class: 'tabs' },
    h('button', { class: tab === 'queue' ? 'active' : '', onClick: () => nav('supervision') }, 'Queue'),
    h('button', { class: tab === 'breakglass' ? 'active' : '', 'data-tab-breakglass': '1', onClick: () => nav('supervision?tab=breakglass') }, `Access to review${glassCount ? ` (${glassCount})` : ''}`)) : null;
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
        { label: '', render: x => h('button', { class: 'btn sm primary', 'data-ack-breakglass': x.id, onClick: (e) => { e.stopPropagation(); ack(x); } }, 'Acknowledge') },
      ], g.rows, { rowLabel: (x) => `Break-glass by ${x.user_name} for ${x.client_code || 'a client'}` })
        : emptyState('Nothing waiting', 'Emergency accesses and re-admissions from outside a caseload appear here until a supervisor or privacy officer acknowledges them.')));
    return h('div', {}, pageHead('Supervision'), tabs, page);
  }

  // ---- countersignatures ----
  const cosign = async (row) => {
    let password, note;
    // A countersignature certifies that the supervisor reviewed the note, so the note itself has to be
    // in front of them here -- not just who wrote it and when.
    let n = null; try { n = (await get(`/api/notes/${row.id}`)).note; } catch (e) { toast(e.message, 'error'); return; }
    const content = n.structured
      ? h('div', {}, Object.entries(n.structured).map(([k, v]) => v ? h('div', { class: 'mb' }, h('b', {}, k), h('div', { style: { whiteSpace: 'pre-wrap' } }, v)) : null))
      : h('pre', { class: 'note' }, n.content || '');
    const m = modal('Countersign this note', h('div', {},
      h('p', {}, `${n.title ? n.title + ' — ' : ''}written by ${row.author} on ${fmt.date(row.occurred_at)} for ${row.client_code}.`),
      h('div', { class: 'card tight mb', 'data-cosign-content': '1', style: { maxHeight: '40vh', overflow: 'auto' } }, content),
      h('p', { class: 'small muted' }, 'Countersigning records your approval alongside the author. It does not replace their signature — both names stay on the record.'),
      h('div', { class: 'field' }, h('label', { for: 'cosign-note' }, 'Comment (optional)'), note = h('textarea', { id: 'cosign-note', rows: 3 })),
      h('div', { class: 'field' }, h('label', { for: 'cosign-pw' }, 'Your password *'), password = h('input', { id: 'cosign-pw', type: 'password', autocomplete: 'current-password' })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: async () => {
          if (!password.value) { password.focus(); toast('Your password is required to countersign', 'error'); return; }
          try {
            await post(`/api/notes/${row.id}/cosign`, { password: password.value, note: note.value.trim() || undefined });
            toast('Countersigned', 'ok'); m.close(); refresh();
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Countersign'))), { wide: true });
  };

  const cosignRows = q.awaiting_cosignature || [];
  page.append(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Notes waiting for your countersignature'), badge(String(cosignRows.length), cosignRows.length ? 'warn' : 'ok')),
    cosignRows.length ? table([
      { label: 'Client', key: 'client_code' },
      { label: 'Author', key: 'author' },
      { label: 'Note', render: r => [r.title || fmt.label(r.kind), r.cosign_requested ? [' ', badge('Review requested by author', 'warn')] : null] },
      { label: 'Signed', render: r => fmt.dt(r.signed_at) },
      { label: '', render: r => h('button', { class: 'btn sm primary', onClick: (e) => { e.stopPropagation(); cosign(r); } }, 'Countersign') },
    ], cosignRows, { onRow: (r) => nav(`notes/${r.id}`), rowLabel: (r) => `Note by ${r.author} for ${r.client_code}` })
      : emptyState('Nothing to countersign', 'Notes by staff who need supervision appear here once they have signed them — and any note a worker sends you for review.')));

  // ---- unsigned drafts across the team ----
  const drafts = q.unsigned_notes || [];
  const overdue = drafts.filter(d => d.overdue).length;
  page.append(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Unsigned notes across your team'),
      badge(overdue ? `${overdue} overdue` : String(drafts.length), overdue ? 'danger' : drafts.length ? 'warn' : 'ok')),
    drafts.length ? table([
      { label: 'Client', key: 'client_code' },
      { label: 'Author', key: 'author' },
      { label: 'Kind', render: r => fmt.label(r.kind) },
      { label: 'Started', render: r => h('span', { style: r.overdue ? { color: 'var(--danger)' } : {} }, fmt.date(r.created_at)) },
    ], drafts, { onRow: (r) => nav(`notes/${r.id}`), rowLabel: (r) => `Draft by ${r.author} for ${r.client_code}` })
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
          { label: 'Activity', render: r => fmt.label(r.category) },
          { label: 'Client', render: r => r.client_code || '—' },
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
  const open = q.referrals_awaiting_outcome || [];
  const revoked = q.referrals_consent_revoked || [];
  if (open.length || revoked.length) {
    page.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Referrals needing attention')),
      revoked.length ? h('div', { class: 'banner error', role: 'alert' },
        `${plural(revoked.length, 'referral', 'referrals')} relied on a consent that has since been revoked. Stop sharing information and close them out.`) : null,
      revoked.length ? table([
        { label: 'Client', key: 'client_code' }, { label: 'Referred to', key: 'resource' },
      ], revoked, { onRow: (r) => nav(`referrals?client_id=${r.client_id}`) }) : null,
      open.length ? h('div', {}, h('h3', { class: 'mt' }, 'No outcome recorded yet'),
        table([
          { label: 'Client', key: 'client_code' }, { label: 'Referred to', key: 'resource' },
          { label: 'Sent', render: r => fmt.date(r.referred_at) }, { label: 'Status', render: r => badge(fmt.label(r.status)) },
        ], open, { onRow: (r) => nav(`referrals?client_id=${r.client_id}`), rowLabel: (r) => `Referral for ${r.client_code} to ${r.resource}` })) : null));
  }

  return h('div', {},
    pageHead('Supervision'),
    tabs,
    glassCount ? h('div', { class: 'banner error', role: 'alert' }, `${plural(glassCount, 'emergency access or re-admission', 'emergency accesses and re-admissions')} ${glassCount === 1 ? 'is' : 'are'} waiting for review. `, h('a', { href: '#/supervision?tab=breakglass' }, 'Review now')) : null,
    h('p', { class: 'muted' }, 'Work that is waiting on you: countersignatures, unsigned notes, staff time, and referrals that have not closed the loop.'),
    page);
});
