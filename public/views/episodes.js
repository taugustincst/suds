// Episodes of care: admitting someone, discharging them, and the waitlist. Before this a client entered
// once stayed "active" forever, because there was no step that ended anything.
import { h, route, get, pagedList, post, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, confirmDialog, kv, flag } from '../app.js';
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

  // Discharging a client whose care team you are not on ends only your own part (server/routes/episodes.js): said
  // before, and after, in those words (r9 M4). `standing` as the server has it: a manager, or on the care team.
  const today = new Date().toISOString().slice(0, 10);
  const team = ((client && client.assignments) || []).filter(a => !a.end_date || a.end_date > today);
  const standing = can('records:manage-others') || team.some(a => a.user_id === state.user.id);
  const others = standing ? [] : [...new Set(team.filter(a => a.user_id !== state.user.id).map(a => a.display_name))];
  const names = (xs) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
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
      const stays = others.length > 0 && !d.keep_client_active;
      const n = (k, one) => (k ? `${k} ${one}${k === 1 ? '' : 's'}` : null);
      const done = [n(r.ended_assignments, 'assignment'), n(r.cancelled_tasks, 'to-do')].filter(Boolean);
      toast(stays ? 'Episode closed' : `Discharged.${done.length ? ` Ended: ${done.join(', ')}.` : ''}`, 'ok');
      const rest = (r.warnings || []).filter(w => !/^Others are still on this client's care team/.test(w));
      if (stays) {
        await confirmDialog('Episode closed — client stays open', `${names(others)} ${others.length === 1 ? 'is' : 'are'} still on this client's care team, so the client stays open with them. Only your own part ended; they or a supervisor discharge the client.${rest.length ? ` ${rest.join(' ')}` : ''}`, { okText: 'OK', cancelText: null });
      } else if (rest.length) {
        await confirmDialog('Discharged — still to follow up', rest.join(' '), { okText: 'I will follow up', cancelText: null });
      }
      onChange ? onChange() : nav(`client/${clientId}`);
    } });
    // The CalOMS discharge status follows from the reason unless the worker has already chosen one.
    if (calOn && f.inputs.caloms_discharge_status) f.inputs.discharge_reason.addEventListener('change', () => {
      const code = (cal.from_suds.discharge_reason || {})[f.inputs.discharge_reason.value];
      if (code && !f.inputs.caloms_discharge_status.value) f.inputs.caloms_discharge_status.value = code;
    });
    const m = modal('Discharge from this episode', h('div', {},
      standing ? h('p', { class: 'small muted' }, 'This ends the assignments on this client and closes their open to-dos, so they stop appearing on everyone\'s overdue list. Their record stays exactly as it is.')
        : h('p', { class: 'banner info small', 'data-discharge-own-part': '1' }, others.length
          ? `You are not on this client's care team. Closing this episode ends only your own part: the client stays open with ${names(others)}, and only they or a supervisor can discharge the client.`
          : 'You are not on this client\'s care team, and nobody else is: this closes the episode and the client, and your own open to-dos about them.'),
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
    box.append(emptyState('No episodes yet', `This person was entered without being admitted (for example, straight onto the waitlist). Starting an episode is the admission: funders count admissions and discharges per episode, and closing one is what takes a client off the active caseload.${can('episodes:write') ? ' Use + Start an episode above.' : ' A supervisor, clinician or anyone who may edit episodes starts one.'}`));
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
      { label: 'Waiting', render: r => flag(`${r.days_waiting} day${r.days_waiting === 1 ? '' : 's'}`, r.days_waiting > 30, 'waiting more than 30 days'), num: true },
      { label: 'Risk', render: r => badge(r.risk_level ? fmt.label(r.risk_level) : 'Not assessed', r.risk_level === 'critical' || r.risk_level === 'high' ? 'danger' : '') },
      { label: 'Substance', render: r => fmt.label(r.primary_substance || 'unknown', 'SUBSTANCES') },
      { label: 'Level of care', render: r => r.asam_level || '—' },
      { label: 'Last contact', render: r => (r.last_contact ? fmt.date(r.last_contact) : h('span', { style: { color: 'var(--danger)' } }, 'never')) },
    ], rows, { onRow: (r) => nav(`client/${r.id}`), rowLabel: (r) => `${r.display_name}, waiting ${r.days_waiting} days` }) })
      // Empty, it says what to do next (1.16.0): put someone on it, with the intake form opened on "Waitlist" for a
      // role that may add clients; anyone else is told who can.
      : emptyState('Nobody is waiting', can('clients:write')
        ? 'Clients with the status "waitlist" appear here, ordered by how long they have waited. Add someone waiting for a place, or change a client\'s status to Waitlist on their record.'
        : 'Clients with the status "waitlist" appear here, ordered by how long they have waited. Staff who add clients (navigators, clinicians, supervisors) put people on it.',
      can('clients:write')
        ? h('button', { class: 'btn primary', type: 'button', 'data-empty-action': 'waitlist-add', onClick: async () => (await import('./clients.js')).openClientForm(null, (id) => nav(id ? `client/${id}` : `waitlist?_=${Date.now()}`), { full: true, prefill: { status: 'waitlist' } }) }, 'Add someone to the waitlist')
        : h('a', { class: 'btn', 'data-empty-action': 'clients', href: '#/clients' }, 'Open the client list')));
});
