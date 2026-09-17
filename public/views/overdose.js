// Overdose and reversal events. Every SUD funder asks for these counts, and a community reversal reported
// by an outreach worker — with nobody identified — is exactly the kind a programme most needs to record.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, confirmDialog } from '../app.js';

const KINDS = [
  { value: 'overdose', label: 'Overdose (no naloxone given)' },
  { value: 'reversal', label: 'Overdose reversed with naloxone' },
  { value: 'fatal', label: 'Fatal overdose' },
];
const BY = [
  { value: 'bystander', label: 'A bystander' }, { value: 'first_responder', label: 'A first responder' },
  { value: 'staff', label: 'Our staff' }, { value: 'self', label: 'The person themselves' },
  { value: 'family', label: 'Family member' }, { value: 'unknown', label: 'Unknown' },
];

export function openOverdoseForm(row, { clientId = null, onDone } = {}) {
  const f = form([
    { name: 'client_id', label: 'Client (leave empty for a community report)', type: 'client', span: true,
      help: 'A reversal you heard about or witnessed, with no client of ours involved, still counts — leave this blank.' },
    { name: 'occurred_at', label: 'When', type: 'datetime', required: true },
    { name: 'kind', label: 'What happened', type: 'select', noBlank: true, options: KINDS },
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
    values: row || { client_id: clientId || '', occurred_at: new Date().toISOString(), kind: 'reversal', survived: 1, naloxone_used: 1, naloxone_doses: 1 },
    submitText: row ? 'Save' : 'Record event',
    onSubmit: async (d) => {
      if (!d.client_id) delete d.client_id;
      if (row) await put(`/api/overdose-events/${row.id}`, d); else await post('/api/overdose-events', d);
      toast(row ? 'Event updated' : 'Event recorded', 'ok'); m.close(); onDone && onDone();
    },
  });
  const m = modal(row ? 'Edit overdose event' : 'Record an overdose or reversal', f, { wide: true });
  return m;
}

route('overdose', async () => {
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
