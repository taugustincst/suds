// What is waiting on a supervisor: notes to countersign, drafts the team has left, time to approve, and
// referrals with no outcome recorded. Before this, the dashboard only counted the signed-in user's own
// unsigned notes, so none of this was visible to the person responsible for it.
import { h, route, get, post, state, toast, table, badge, fmt, can, pageHead, nav, emptyState, modal, form, announce } from '../app.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const hoursOf = (m) => fmt.mins(m);

route('supervision', async () => {
  const q = await get('/api/supervision/queue');
  const page = h('div');

  const refresh = async () => { nav('supervision?_=' + Date.now()); };

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
      { label: 'Note', render: r => r.title || fmt.label(r.kind) },
      { label: 'Signed', render: r => fmt.dt(r.signed_at) },
      { label: '', render: r => h('button', { class: 'btn sm primary', onClick: (e) => { e.stopPropagation(); cosign(r); } }, 'Countersign') },
    ], cosignRows, { onRow: (r) => nav(`notes/${r.id}`), rowLabel: (r) => `Note by ${r.author} for ${r.client_code}` })
      : emptyState('Nothing to countersign', 'Notes by staff who need supervision appear here once they have signed them.')));

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
      try {
        const r = await post('/api/time/approve-batch', { ids, decision });
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
    h('p', { class: 'muted' }, 'Work that is waiting on you: countersignatures, unsigned notes, staff time, and referrals that have not closed the loop.'),
    page);
});
