// Episodes of care: admitting someone, discharging them, and the waitlist. Before this a client entered
// once stayed "active" forever, because there was no step that ended anything.
import { h, route, get, pagedList, post, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, confirmDialog, kv } from '../app.js';
import { calomsConfig, calomsFields, splitCaloms, calomsDefaults, calomsEpisodeDialog } from './caloms.js';

// The discharge reasons are a documentation list (Settings → Lists): offered and worded as the office set
// them up, with a reason retired since an episode was closed still shown on that episode.

/** The episodes panel shown on a client's page. */
export async function episodesPanel(clientId, { onChange, client = null } = {}) {
  const { episodes } = await get(`/api/clients/${clientId}/episodes`);
  // A programme that reports CalOMS Tx (Reports → State reporting) gets the CalOMS questions in the
  // admission and discharge dialogs, and each episode's CalOMS records; one that does not sees none of it.
  const cal = await calomsConfig({ fresh: true });
  const calOn = !!(cal && cal.enabled);
  const open = episodes.find(e => e.status === 'open');
  const box = h('section', { class: 'card' });

  const openEpisode = () => {
    const f = form([
      { name: 'opened_at', label: 'Date services started', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
      { name: 'referral_source', label: 'Referred by', placeholder: 'e.g. jail release, hospital, self' },
      { name: 'funding_source_id', label: 'Funding source', type: 'fund' },
      { name: 'presenting_problem', label: 'What brought them in', type: 'textarea', span: true, help: 'Stored encrypted, like the rest of the record.' },
      ...(calOn ? calomsFields(cal, 'admission', { values: calomsDefaults(cal, client) }) : []),
    ], { submitText: 'Open episode', onSubmit: async (d) => {
      const { plain, caloms } = calOn ? splitCaloms(cal, 'admission', d) : { plain: d, caloms: null };
      await post(`/api/clients/${clientId}/episodes`, caloms ? { ...plain, caloms } : plain); toast('Episode opened', 'ok'); m.close(); onChange ? onChange() : nav(`client/${clientId}`);
    } });
    const m = modal('Start an episode of care', calOn ? h('div', {}, h('p', { class: 'small muted', 'data-caloms-admission': '1' }, 'This program reports CalOMS Tx: answer the CalOMS admission questions below. They are sent to the state (DHCS) in the monthly extract.'), f) : f, { wide: calOn });
  };

  const closeEpisode = (e) => {
    const f = form([
      // No default: "Completed the program" is a claim the funder report counts, not something a worker
      // should be able to record by clicking straight through.
      { name: 'discharge_reason', label: 'Reason for discharge', type: 'select', required: true, placeholder: 'Choose a reason…', list: 'DISCHARGE_REASONS' },
      { name: 'discharge_disposition', label: 'Where are they going?', placeholder: 'e.g. outpatient at County OTP, residential, unknown' },
      { name: 'closed_at', label: 'Discharge date', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'discharge_summary', label: 'Discharge summary', type: 'textarea', rows: 5, span: true },
      { name: 'keep_client_active', label: 'Keep this client active (they are still being served under another episode)', type: 'checkbox', span: true },
      ...(calOn ? calomsFields(cal, 'discharge', { standardHint: true }) : []),
    ], { submitText: 'Discharge', onSubmit: async (d) => {
      const { plain, caloms } = calOn ? splitCaloms(cal, 'discharge', d) : { plain: d, caloms: null };
      const r = await post(`/api/episodes/${e.id}/close`, caloms ? { ...plain, caloms } : plain);
      m.close();
      toast(`Discharged. ${r.ended_assignments} assignment(s) ended, ${r.cancelled_tasks} to-do(s) closed.`, 'ok');
      if (r.warnings && r.warnings.length) {
        await confirmDialog('Discharged, with loose ends', r.warnings.join(' '), { okText: 'I will follow up' });
      }
      onChange ? onChange() : nav(`client/${clientId}`);
    } });
    // The CalOMS discharge status follows from the reason unless the worker has already chosen one.
    if (calOn && f.inputs.caloms_discharge_status) f.inputs.discharge_reason.addEventListener('change', () => {
      const code = (cal.from_suds.discharge_reason || {})[f.inputs.discharge_reason.value];
      if (code && !f.inputs.caloms_discharge_status.value) f.inputs.caloms_discharge_status.value = code;
    });
    const m = modal('Discharge from this episode', h('div', {},
      h('p', { class: 'small muted' }, 'This ends the assignments on this client and closes their open to-dos, so they stop appearing on everyone\'s overdue list. Their record stays exactly as it is.'),
      calOn ? h('p', { class: 'small muted', 'data-caloms-discharge': '1' }, 'This program reports CalOMS Tx: the CalOMS discharge status and date of last service are required; the past-30-day questions are required unless the status is administrative (4, 6, 7 or 8).') : null, f), { wide: calOn });
  };

  // Re-admit on the same episode: for a discharge made in error or a return within days. A genuine return
  // after a gap is a new admission, which is "+ Start a new episode" instead.
  const reopenEpisode = async (e) => {
    const reason = await confirmDialog('Re-admit on this episode', `Reopen the episode from ${fmt.date(e.opened_at)} (discharged ${fmt.date(e.closed_at)})? The client becomes active again and their care team is restored. Use "Start a new episode" instead if this is a genuine return after a gap — funders count that as a new admission.`, { okText: 'Reopen & re-admit', requireReason: true });
    if (!reason) return;
    try { const r = await post(`/api/episodes/${e.id}/reopen`, { reason }); toast(r.warnings && r.warnings.length ? `Re-admitted. ${r.warnings.join(' ')}` : 'Re-admitted — the episode is open again', 'ok'); onChange ? onChange() : nav(`client/${clientId}`); }
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
      { label: 'Discharge', render: e => (e.discharge_reason ? fmt.label(e.discharge_reason, 'DISCHARGE_REASONS') : '—') },
      { label: 'Going to', render: e => e.discharge_disposition || '—' },
      { label: 'Fund', render: e => e.funding_source || '—' },
      calOn ? { label: 'CalOMS', render: e => h('button', { class: 'btn sm', 'data-caloms-episode-open': e.id, onClick: (ev) => { ev.stopPropagation(); calomsEpisodeDialog(e, { onChange }); } }, 'CalOMS records') } : null,
      { label: '', render: e => e.status === 'closed' && !open && can('episodes:write') ? h('button', { class: 'btn sm', 'data-reopen': e.id, onClick: (ev) => { ev.stopPropagation(); reopenEpisode(e); } }, 'Reopen / re-admit') : null },
    ].filter(Boolean), rows, {
      onRow: (e) => modal(`Episode from ${fmt.date(e.opened_at)}`, h('div', {}, kv([
        ['Opened', `${fmt.date(e.opened_at)} by ${e.opened_by_name || '—'}`],
        ['Referred by', e.referral_source ? fmt.label(e.referral_source) : '—'],
        ['What brought them in', e.presenting_problem || '—'],
        ['Closed', e.closed_at ? `${fmt.date(e.closed_at)} by ${e.closed_by_name || '—'}` : 'Still open'],
        ['Reason', e.discharge_reason ? fmt.label(e.discharge_reason, 'DISCHARGE_REASONS') : '—'],
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
  const PAGE = 200;
  const first = await get(`/api/waitlist?limit=${PAGE}`);
  return h('div', {},
    pageHead('Waitlist'),
    h('p', { class: 'muted' }, 'Everyone waiting for a place, longest and highest risk first. This is the list to work through each morning.'),
    first.rows.length ? pagedList({ first, url: '/api/waitlist', limit: PAGE, summary: (rows, total) => h('div', { class: 'muted small mb' }, `${total} waiting`), render: (rows) => table([
      { label: 'Client', render: r => r.display_name },
      { label: 'Code', key: 'client_code' },
      { label: 'Waiting', render: r => h('span', { style: r.days_waiting > 30 ? { color: 'var(--danger)' } : {} }, `${r.days_waiting} day${r.days_waiting === 1 ? '' : 's'}`), num: true },
      { label: 'Risk', render: r => badge(fmt.label(r.risk_level || 'unknown'), r.risk_level === 'critical' || r.risk_level === 'high' ? 'danger' : '') },
      { label: 'Substance', render: r => fmt.label(r.primary_substance || 'unknown', 'SUBSTANCES') },
      { label: 'Level of care', render: r => r.asam_level || '—' },
      { label: 'Last contact', render: r => (r.last_contact ? fmt.date(r.last_contact) : h('span', { style: { color: 'var(--danger)' } }, 'never')) },
    ], rows, { onRow: (r) => nav(`client/${r.id}`), rowLabel: (r) => `${r.display_name}, waiting ${r.days_waiting} days` }) })
      : emptyState('Nobody is waiting', 'Clients with the status "waitlist" appear here, ordered by how long they have waited.'));
});
