// Overdose and reversal events. Every SUD funder asks for these counts, and a community reversal reported
// by an outreach worker — with nobody identified — is exactly the kind a program most needs to record.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, confirmDialog, discardDraft } from '../app.js';

// The lists themselves come from GET /api/meta/overdose-options, so a kind added on the server shows up
// here; these are the plain-language labels for the known values, and the fallback if the list cannot load.
const KIND_LABELS = { overdose: 'Overdose (no naloxone given)', reversal: 'Overdose reversed with naloxone', fatal: 'Fatal overdose' };
const BY_LABELS = { bystander: 'A bystander', first_responder: 'A first responder', staff: 'Our staff', self: 'The person themselves', family: 'Family member', unknown: 'Unknown' };
const toOptions = (values, labels) => values.map(value => ({ value, label: labels[value] || fmt.label(value) }));
let KINDS = toOptions(Object.keys(KIND_LABELS), KIND_LABELS);
let BY = toOptions(Object.keys(BY_LABELS), BY_LABELS);
let optionsLoaded = false;
async function loadOptions() {
  if (optionsLoaded) return;
  try {
    const m = await get('/api/meta/overdose-options');
    if (Array.isArray(m.kinds) && m.kinds.length) KINDS = toOptions(m.kinds, KIND_LABELS);
    if (Array.isArray(m.administered_by) && m.administered_by.length) BY = toOptions(m.administered_by, BY_LABELS);
    optionsLoaded = true;
  } catch { /* keep the built-in lists */ }
}

export function openOverdoseForm(row, { clientId = null, onDone } = {}) {
  const f = form([
    { name: 'client_id', label: 'Client (leave empty for a community report)', type: 'client', span: true,
      help: 'A reversal you heard about or witnessed, with no client of ours involved, still counts — leave this blank.' },
    { name: 'occurred_at', label: 'When', type: 'datetime', required: true },
    // Chosen, not pre-filled: with 'reversal' and '1 dose' already in the form, saving it untouched used to
    // record a countable naloxone reversal that never happened.
    { name: 'kind', label: 'What happened', type: 'select', required: true, placeholder: '— choose —', options: KINDS },
    { name: 'substances', label: 'Substances involved', placeholder: 'e.g. fentanyl, benzodiazepines' },
    { name: 'naloxone_used', label: 'Naloxone was given', type: 'checkbox' },
    { name: 'naloxone_doses', label: 'Doses given', type: 'number', min: 0, max: 20 },
    { name: 'administered_by', label: 'Given by', type: 'select', options: BY },
    { name: 'ems_called', label: 'EMS was called', type: 'checkbox' },
    { name: 'hospitalized', label: 'Taken to hospital', type: 'checkbox' },
    { name: 'survived', label: 'The person survived', type: 'checkbox', value: row ? row.survived : 1 },
    { name: 'location_type', label: 'Where', placeholder: 'e.g. shelter, street, home, encampment' },
    { name: 'city', label: 'City' },
    { name: 'funding_source_id', label: 'Funding source', type: 'fund' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: true, help: 'Stored encrypted.' },
  ], {
    values: row || { client_id: clientId || '', occurred_at: new Date().toISOString(), survived: 1 },
    submitText: row ? 'Save' : 'Record event',
    draftKey: row ? `overdose:${row.id}` : 'overdose:new',
    onSubmit: async (d) => {
      if (!d.client_id) delete d.client_id;
      const wasFatal = !!(row && row.kind === 'fatal' && row.client_id);
      const isFatal = d.kind === 'fatal' && !!d.client_id;
      const sameClient = !row || (row.client_id || '') === (d.client_id || '');
      // A fatal overdose discharges the client (server/routes/overdose.js), so say so before it happens.
      if (isFatal && (!wasFatal || !sameClient)) {
        const ok = await confirmDialog('Record a fatal overdose?', 'This records the client as deceased and discharges them: their open episode is closed with the reason "deceased", their care team assignments end and their open to-dos are cancelled. If this is corrected later, changing the outcome or deleting the event puts the client back as they were.', { danger: true, okText: 'Record as fatal' });
        if (!ok) return;
      } else if (wasFatal && (!isFatal || !sameClient)) {
        const ok = await confirmDialog('No longer a fatal overdose?', 'The client will no longer be recorded as deceased: their status goes back to what it was before this event, and the episode it closed is reopened.', { okText: 'Save and restore the client' });
        if (!ok) return;
      }
      if (row) await put(`/api/overdose-events/${row.id}`, d); else await post('/api/overdose-events', d);
      toast(row ? 'Event updated' : 'Event recorded', 'ok'); m.close(); onDone && onDone();
    },
  });
  const remove = row ? h('div', { class: 'btn-row', style: { justifyContent: 'flex-start', marginTop: '.5rem' } },
    h('button', { type: 'button', class: 'btn danger', onClick: async () => {
      const fatal = row.kind === 'fatal' && row.client_id;
      const ok = await confirmDialog('Delete this event?', fatal
        ? 'The event is removed from the counts, and the client is no longer recorded as deceased: their status goes back to what it was before this event and the episode it closed is reopened.'
        : 'The event is removed from the overdose and reversal counts. This cannot be undone.', { danger: true, okText: 'Delete event' });
      if (!ok) return;
      await del(`/api/overdose-events/${row.id}`); discardDraft(`overdose:${row.id}`);
      toast('Event deleted', 'ok'); m.close(); onDone && onDone();
    } }, 'Delete event')) : null;
  const m = modal(row ? 'Edit overdose event' : 'Record an overdose or reversal', h('div', {}, f, remove), { wide: true });
  return m;
}

route('overdose', async () => {
  await loadOptions();
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const kind = params.get('kind') || 'all';
  const { rows, total } = await get(`/api/overdose-events?limit=200${kind !== 'all' ? `&kind=${kind}` : ''}`);
  const refresh = () => nav('overdose?_=' + Date.now() + (kind !== 'all' ? `&kind=${kind}` : ''));

  return h('div', {},
    pageHead('Overdose & reversals',
      can('overdose:write') ? h('button', { class: 'btn primary', onClick: () => openOverdoseForm(null, { onDone: refresh }) }, '+ Record an event') : null),
    h('p', { class: 'muted' }, 'Overdoses and naloxone reversals, including ones involving people who are not clients. These are the numbers funders ask for and the only place they can be counted.'),
    h('div', { class: 'row mb' }, ['all', 'reversal', 'overdose', 'fatal'].map(k =>
      h('button', { class: `btn sm ${k === kind ? 'primary' : ''}`, onClick: () => nav(`overdose?kind=${k}`) }, k === 'all' ? 'All' : fmt.label(k)))),
    rows.length ? table([
      { label: 'When', render: r => fmt.dt(r.occurred_at) },
      { label: 'Who', render: r => r.client_code || h('span', { class: 'muted' }, 'community report') },
      { label: 'What', render: r => badge(fmt.label(r.kind), r.kind === 'fatal' || !r.survived ? 'danger' : r.kind === 'reversal' ? 'ok' : 'warn') },
      { label: 'Naloxone', render: r => (r.naloxone_used ? `${r.naloxone_doses || 1} dose${(r.naloxone_doses || 1) === 1 ? '' : 's'}` : 'none') },
      { label: 'Given by', render: r => (r.administered_by ? fmt.label(r.administered_by) : '—') },
      { label: 'EMS', render: r => (r.ems_called ? 'yes' : 'no') },
      { label: 'Where', render: r => [r.location_type, r.city].filter(Boolean).join(', ') || '—' },
      { label: 'Reported by', render: r => r.reporter || '—' },
    ], rows, {
      onRow: can('overdose:write') ? (r) => openOverdoseForm(r, { onDone: refresh }) : null,
      rowLabel: (r) => `${fmt.label(r.kind)} on ${fmt.date(r.occurred_at)}${r.client_code ? ` for ${r.client_code}` : ''}`,
    }) : emptyState('No events recorded', 'Record an overdose or a naloxone reversal here — including ones involving people who are not clients.',
      can('overdose:write') ? h('button', { class: 'btn primary', onClick: () => openOverdoseForm(null, { onDone: refresh }) }, 'Record an event') : null),
    total > rows.length ? h('p', { class: 'small muted' }, `Showing ${rows.length} of ${total}.`) : null);
});
