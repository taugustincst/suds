// Overdose and reversal events. Every SUD funder asks for these counts, and a community reversal reported
// by an outreach worker — with nobody identified — is exactly the kind a program most needs to record.
import { h, route, get, post, put, del, state, form, modal, toast, table, badge, fmt, can, pageHead, nav, emptyState, confirmDialog, discardDraft, listEntries } from '../app.js';

// "Where" is the visit form's Location list, so the NDP log counts reversals and distribution by the same
// sites. An event recorded when it was free text keeps its words, shown as typed.
const where = (v) => (v && listEntries('LOCATIONS').some(e => e.code === v) ? fmt.label(v, 'LOCATIONS') : v);

// "What happened" and "Given by" are documentation lists (Settings → Lists): the choices and their wording
// come from the office's setup with the rest of the lists (GET /api/meta/constants; the same lists are on
// GET /api/meta/overdose-options for other callers).

export function openOverdoseForm(row, { clientId = null, onDone } = {}) {
  const f = form([
    { name: 'client_id', label: 'Client (leave empty for a community report)', type: 'client', span: true,
      help: 'A reversal you heard about or witnessed, with no client of ours involved, still counts — leave this blank.' },
    { name: 'occurred_at', label: 'When', type: 'datetime', required: true },
    // Chosen, not pre-filled: with 'reversal' and '1 dose' already in the form, saving it untouched used to
    // record a countable naloxone reversal that never happened.
    { name: 'kind', label: 'What happened', type: 'select', required: true, placeholder: '— choose —', list: 'OVERDOSE_KINDS' },
    { name: 'substances', label: 'Substances involved', placeholder: 'e.g. fentanyl, benzodiazepines' },
    // A reversal is a naloxone reversal: choosing it ticks this box, and the server records it so either way
    // (an unticked reversal used to be saved and then counted nowhere).
    { name: 'naloxone_used', label: 'Naloxone was given', type: 'checkbox', help: 'A reversal means naloxone was given, so choosing "Reversal" above ticks this and it is counted as a naloxone reversal.' },
    { name: 'naloxone_doses', label: 'Doses given', type: 'number', min: 0, max: 20 },
    { name: 'administered_by', label: 'Given by', type: 'select', list: 'ADMINISTERED_BY' },
    { name: 'ems_called', label: 'EMS was called', type: 'checkbox' },
    { name: 'hospitalized', label: 'Taken to hospital', type: 'checkbox' },
    { name: 'survived', label: 'The person survived', type: 'checkbox', value: row ? row.survived : 1 },
    { name: 'location_type', label: 'Where', type: 'select', placeholder: '— choose —', list: 'LOCATIONS', help: 'The same places as a visit\'s Location, so the naloxone log counts reversals and kits by the same sites. Somewhere not on the list: choose Other and say where in the notes.' },
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
      if (row) await put(`/api/overdose-events/${row.id}`, { ...d, if_updated_at: row.updated_at }); else await post('/api/overdose-events', d);
      toast(row ? 'Event updated' : 'Event recorded', 'ok'); m.close(); onDone && onDone();
    },
  });
  const kindI = f.inputs.kind; const naloxoneI = f.inputs.naloxone_used;
  if (kindI && naloxoneI) kindI.addEventListener('change', () => { if (kindI.value === 'reversal') naloxoneI.checked = true; });
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
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const kind = params.get('kind') || 'all';
  const { rows, total } = await get(`/api/overdose-events?limit=200${kind !== 'all' ? `&kind=${kind}` : ''}`);
  const refresh = () => nav('overdose?_=' + Date.now() + (kind !== 'all' ? `&kind=${kind}` : ''));

  return h('div', {},
    pageHead('Overdose & reversals',
      can('overdose:write') ? h('button', { class: 'btn primary', onClick: () => openOverdoseForm(null, { onDone: refresh }) }, '+ Record an event') : null),
    h('p', { class: 'muted' }, 'Overdoses and naloxone reversals, including ones involving people who are not clients. These are the numbers funders ask for and the only place they can be counted.'),
    h('div', { class: 'row mb' }, ['all', 'reversal', 'overdose', 'fatal'].map(k =>
      h('button', { class: `btn sm ${k === kind ? 'primary' : ''}`, onClick: () => nav(`overdose?kind=${k}`) }, k === 'all' ? 'All' : fmt.label(k, 'OVERDOSE_KINDS')))),
    rows.length ? table([
      { label: 'When', render: r => fmt.dt(r.occurred_at) },
      { label: 'Who', render: r => r.client_code || h('span', { class: 'muted' }, 'community report') },
      { label: 'What', render: r => badge(fmt.label(r.kind, 'OVERDOSE_KINDS'), r.kind === 'fatal' || !r.survived ? 'danger' : r.kind === 'reversal' ? 'ok' : 'warn') },
      { label: 'Naloxone', render: r => (r.naloxone_used ? `${r.naloxone_doses || 1} dose${(r.naloxone_doses || 1) === 1 ? '' : 's'}` : 'none') },
      { label: 'Given by', render: r => (r.administered_by ? fmt.label(r.administered_by, 'ADMINISTERED_BY') : '—') },
      { label: 'EMS', render: r => (r.ems_called ? 'yes' : 'no') },
      { label: 'Where', render: r => [where(r.location_type), r.city].filter(Boolean).join(', ') || '—' },
      { label: 'Reported by', render: r => r.reporter || '—' },
    ], rows, {
      onRow: can('overdose:write') ? (r) => openOverdoseForm(r, { onDone: refresh }) : null,
      rowLabel: (r) => `${fmt.label(r.kind, 'OVERDOSE_KINDS')} on ${fmt.date(r.occurred_at)}${r.client_code ? ` for ${r.client_code}` : ''}`,
    }) : emptyState('No events recorded', 'Record an overdose or a naloxone reversal here — including ones involving people who are not clients.',
      can('overdose:write') ? h('button', { class: 'btn primary', onClick: () => openOverdoseForm(null, { onDone: refresh }) }, 'Record an event') : null),
    total > rows.length ? h('p', { class: 'small muted' }, `Showing ${rows.length} of ${total}.`) : null);
});
