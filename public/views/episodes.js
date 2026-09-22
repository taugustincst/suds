// Episodes of care: admitting someone, discharging them, and the waitlist. Before this a client entered
// once stayed "active" forever, because there was no step that ended anything.
import { h, route, get, post, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, confirmDialog, kv } from '../app.js';

const REASONS = [
  ['completed', 'Completed the program'],
  ['transferred', 'Transferred to another provider'],
  ['incarcerated', 'Incarcerated'],
  ['moved', 'Moved out of the area'],
  ['lost_contact', 'Lost contact'],
  ['declined', 'Declined further services'],
  ['deceased', 'Deceased'],
  ['administrative', 'Administrative closure'],
  ['other', 'Other'],
];

/** The episodes panel shown on a client's page. */
export async function episodesPanel(clientId, { onChange } = {}) {
  const { episodes } = await get(`/api/clients/${clientId}/episodes`);
  const open = episodes.find(e => e.status === 'open');
  const box = h('section', { class: 'card' });

  const openEpisode = () => {
    const f = form([
      { name: 'opened_at', label: 'Date services started', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
      { name: 'referral_source', label: 'Referred by', placeholder: 'e.g. jail release, hospital, self' },
      { name: 'funding_source_id', label: 'Funding source', type: 'fund' },
      { name: 'presenting_problem', label: 'What brought them in', type: 'textarea', span: true, help: 'Stored encrypted, like the rest of the record.' },
    ], { submitText: 'Open episode', onSubmit: async (d) => { await post(`/api/clients/${clientId}/episodes`, d); toast('Episode opened', 'ok'); m.close(); onChange ? onChange() : nav(`client/${clientId}`); } });
    const m = modal('Start an episode of care', f);
  };

  const closeEpisode = (e) => {
    const f = form([
      { name: 'discharge_reason', label: 'Reason for discharge', type: 'select', noBlank: true, required: true, options: REASONS.map(([value, label]) => ({ value, label })) },
      { name: 'discharge_disposition', label: 'Where are they going?', placeholder: 'e.g. outpatient at County OTP, residential, unknown' },
      { name: 'closed_at', label: 'Discharge date', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'discharge_summary', label: 'Discharge summary', type: 'textarea', rows: 5, span: true },
      { name: 'keep_client_active', label: 'Keep this client active (they are still being served under another episode)', type: 'checkbox', span: true },
    ], { submitText: 'Discharge', onSubmit: async (d) => {
      const r = await post(`/api/episodes/${e.id}/close`, d);
      m.close();
      toast(`Discharged. ${r.ended_assignments} assignment(s) ended, ${r.cancelled_tasks} to-do(s) closed.`, 'ok');
      if (r.warnings && r.warnings.length) {
        await confirmDialog('Discharged, with loose ends', r.warnings.join(' '), { okText: 'I will follow up' });
      }
      onChange ? onChange() : nav(`client/${clientId}`);
    } });
    const m = modal('Discharge from this episode', h('div', {},
      h('p', { class: 'small muted' }, 'This ends the assignments on this client and closes their open to-dos, so they stop appearing on everyone\'s overdue list. Their record stays exactly as it is.'), f));
  };

  // Re-admit on the same episode: for a discharge made in error or a return within days. A genuine return
  // after a gap is a new admission, which is "+ Start a new episode" instead.
  const reopenEpisode = async (e) => {
    const reason = await confirmDialog('Re-admit on this episode', `Reopen the episode from ${fmt.date(e.opened_at)} (discharged ${fmt.date(e.closed_at)})? The client becomes active again and their care team is restored. Use "Start a new episode" instead if this is a genuine return after a gap — funders count that as a new admission.`, { okText: 'Reopen & re-admit', requireReason: true });
    if (!reason) return;
    try { await post(`/api/episodes/${e.id}/reopen`, { reason }); toast('Re-admitted — the episode is open again', 'ok'); onChange ? onChange() : nav(`client/${clientId}`); }
    catch (err) { toast(err.message, 'error'); }
  };

  const rows = episodes.map(e => ({ ...e }));
  box.append(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Episodes of care'),
      h('div', { class: 'small muted' }, 'Intake opens the first episode automatically. Discharge closes it (ending the care team and open to-dos); a returning client gets a new episode, or is re-admitted on the last one if they were discharged by mistake.')),
    can('episodes:write') && !open ? h('button', { class: 'btn sm primary', onClick: openEpisode }, rows.length ? '+ Start a new episode' : '+ Start an episode') : null,
    can('episodes:write') && open ? h('button', { class: 'btn sm', onClick: () => closeEpisode(open) }, 'Discharge') : null));

  if (!rows.length) {
    // The card-head button above already offers this when there is no open episode, so the empty state
    // itself does not repeat it — two adjacent "Start an episode" buttons doing the same thing.
    box.append(emptyState('No episodes yet', 'This person was entered without being admitted (for example, straight onto the waitlist). Starting an episode is the admission: funders count admissions and discharges per episode, and closing one is what takes a client off the active caseload.'));
  } else {
    box.append(table([
      { label: 'Opened', render: e => fmt.date(e.opened_at) },
      { label: 'Closed', render: e => (e.closed_at ? fmt.date(e.closed_at) : badge('Open', 'ok')) },
      { label: 'Referred by', render: e => e.referral_source ? fmt.label(e.referral_source) : '—' },
      { label: 'Discharge', render: e => (e.discharge_reason ? fmt.label(e.discharge_reason) : '—') },
      { label: 'Going to', render: e => e.discharge_disposition || '—' },
      { label: 'Fund', render: e => e.funding_source || '—' },
      { label: '', render: e => e.status === 'closed' && !open && can('episodes:write') ? h('button', { class: 'btn sm', 'data-reopen': e.id, onClick: (ev) => { ev.stopPropagation(); reopenEpisode(e); } }, 'Reopen / re-admit') : null },
    ], rows, {
      onRow: (e) => modal(`Episode from ${fmt.date(e.opened_at)}`, h('div', {}, kv([
        ['Opened', `${fmt.date(e.opened_at)} by ${e.opened_by_name || '—'}`],
        ['Referred by', e.referral_source ? fmt.label(e.referral_source) : '—'],
        ['What brought them in', e.presenting_problem || '—'],
        ['Closed', e.closed_at ? `${fmt.date(e.closed_at)} by ${e.closed_by_name || '—'}` : 'Still open'],
        ['Reason', e.discharge_reason ? fmt.label(e.discharge_reason) : '—'],
        ['Going to', e.discharge_disposition || '—'],
        ['Discharge summary', e.discharge_summary || '—'],
      ]))),
      rowLabel: (e) => `Episode opened ${fmt.date(e.opened_at)}${e.closed_at ? `, closed ${fmt.date(e.closed_at)}` : ', still open'}`,
    }));
  }
  return box;
}

// ---- the waitlist ----
route('waitlist', async () => {
  const { rows } = await get('/api/waitlist');
  return h('div', {},
    pageHead('Waitlist'),
    h('p', { class: 'muted' }, 'Everyone waiting for a place, longest and highest risk first. This is the list to work through each morning.'),
    rows.length ? table([
      { label: 'Client', render: r => r.display_name },
      { label: 'Code', key: 'client_code' },
      { label: 'Waiting', render: r => h('span', { style: r.days_waiting > 30 ? { color: 'var(--danger)' } : {} }, `${r.days_waiting} day${r.days_waiting === 1 ? '' : 's'}`), num: true },
      { label: 'Risk', render: r => badge(fmt.label(r.risk_level || 'unknown'), r.risk_level === 'critical' || r.risk_level === 'high' ? 'danger' : '') },
      { label: 'Substance', render: r => fmt.label(r.primary_substance || 'unknown') },
      { label: 'Level of care', render: r => r.asam_level || '—' },
      { label: 'Last contact', render: r => (r.last_contact ? fmt.date(r.last_contact) : h('span', { style: { color: 'var(--danger)' } }, 'never')) },
    ], rows, { onRow: (r) => nav(`client/${r.id}`), rowLabel: (r) => `${r.display_name}, waiting ${r.days_waiting} days` })
      : emptyState('Nobody is waiting', 'Clients with the status "waitlist" appear here, ordered by how long they have waited.'));
});
