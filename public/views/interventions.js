import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav } from '../app.js';

export function openInterventionForm(values, { clientId, clientDisplay, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  const f = form([
    { name: 'client_id', label: 'Client', type: 'client', required: true, value: clientId || values?.client_id, display: clientDisplay },
    { name: 'type', label: 'What did you do?', type: 'select', options: C.INTERVENTION_TYPES, required: true },
    { name: 'occurred_at', label: 'Date & time', type: 'datetime', required: true, value: values?.occurred_at || new Date().toISOString() },
    { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', min: 0, max: 1440, step: 1, value: values?.duration_minutes ?? 30 },
    { name: 'location', label: 'Location', type: 'select', options: C.LOCATIONS, value: 'office' }, { name: 'modality', label: 'Modality', type: 'select', options: C.MODALITIES, value: 'in_person' },
    { name: 'outcome', label: 'Outcome', type: 'select', options: C.OUTCOMES }, { name: 'stage_of_change', label: 'Stage of change', type: 'select', options: C.STAGES },
    { name: 'naloxone_kits', label: 'Naloxone kits given', type: 'number', min: 0, step: 1, value: 0 }, { name: 'fentanyl_strips', label: 'Fentanyl test strips given', type: 'number', min: 0, step: 1, value: 0 },
    can('budget:read') ? { name: 'funding_source_id', label: 'Funding source', type: 'fund' } : null, can('budget:read') ? { name: 'cost', label: 'Direct cost ($)', type: 'number', min: 0, step: 0.01 } : null,
    { name: 'summary', label: 'Short summary (no names or health details here — put those in a Note)', type: 'textarea', span: true, rows: 3 },
    { name: 'follow_up_due', label: 'Remind me to follow up on', type: 'date' },
    isNew ? { name: 'log_time', label: 'Also log this as a time entry', type: 'checkbox', value: true } : null,
    isNew ? { name: 'time_category', label: 'Time category', type: 'select', options: C.TIME_CATEGORIES, value: 'direct_service' } : null,
    isNew && can('clients:all') ? { name: 'user_id', label: 'Worker (defaults to you)', type: 'user' } : null,
  ].filter(Boolean), { values: values || {}, submitText: isNew ? 'Save' : 'Save changes', draftKey: values ? `intervention:${values.id}` : 'intervention:new', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) await post('/api/interventions', d); else await put(`/api/interventions/${values.id}`, d);
    toast(isNew ? 'Intervention logged' : 'Saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? 'Record a visit or service' : 'Edit visit / service', f, { wide: true });
}

export function interventionTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'Date', render: r => h('span', { class: 'nowrap' }, fmt.dt(r.occurred_at)) },
    showClient ? { label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}`, onClick: e => e.stopPropagation() }, r.client_code) } : null,
    { label: 'Type', render: r => fmt.label(r.type) }, { label: 'Duration', render: r => fmt.mins(r.duration_minutes), num: true },
    { label: 'Where', render: r => `${fmt.label(r.location)} · ${fmt.label(r.modality)}` }, { label: 'Outcome', render: r => r.outcome ? badge(fmt.label(r.outcome), statusKind(r.outcome)) : '—' },
    { label: 'Supplies', render: r => [r.naloxone_kits ? badge(`${r.naloxone_kits} naloxone`, 'ok') : null, r.fentanyl_strips ? [' ', badge(`${r.fentanyl_strips} FTS`, 'info')] : null] },
    { label: 'Worker', key: 'worker' }, { label: 'Summary', render: r => h('span', { class: 'small' }, (r.summary || '').slice(0, 120)) },
    { label: '', render: r => (r.user_id === state.user.id || can('clients:all')) && can('interventions:write') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: (e) => { e.stopPropagation(); openInterventionForm(r, { onDone: onChange }); } }, 'Edit'), h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this intervention', onClick: async (e) => { e.stopPropagation(); if (await confirmDialog('Delete intervention', 'Delete this intervention record? This is logged.', { danger: true, okText: 'Delete' })) { await del(`/api/interventions/${r.id}`); toast('Deleted'); onChange && onChange(); } } }, '✕')) : null },
  ].filter(Boolean), rows, { empty: 'Nothing recorded yet. Use + Log to record a visit, screening, warm handoff or other service.' });
}

route('interventions', async (r) => {
  const type = r.query.get('type') || ''; const from = r.query.get('from') || ''; const to = r.query.get('to') || ''; const mine = r.query.get('mine') === '1';
  const qs = `limit=300${type ? '&type=' + type : ''}${from ? '&from=' + from : ''}${to ? '&to=' + to : ''}${mine ? '&mine=1' : ''}`;
  const data = await get(`/api/interventions?${qs}`);
  const refresh = () => nav(`interventions?${qs}&_=${Date.now()}`);
  const C = state.constants;
  const typeSel = h('select', { onChange: () => nav(`interventions?type=${typeSel.value}&from=${from}&to=${to}${mine ? '&mine=1' : ''}`) }, h('option', { value: '' }, 'All types'), C.INTERVENTION_TYPES.map(t => h('option', { value: t, selected: t === type }, fmt.label(t))));
  const fromI = h('input', { type: 'date', value: from }), toI = h('input', { type: 'date', value: to });
  const mineI = h('input', { type: 'checkbox', checked: mine });
  const apply = () => nav(`interventions?type=${type}&from=${fromI.value}&to=${toI.value}${mineI.checked ? '&mine=1' : ''}`);
  const totalMin = data.rows.reduce((s, x) => s + (x.duration_minutes || 0), 0);
  return h('div', {},
    pageHead('Visits & services', can('interventions:write') ? h('button', { class: 'btn primary', onClick: () => openInterventionForm(null, { onDone: refresh }) }, '+ Log a visit or service') : null, h('button', { class: 'btn', onClick: () => downloadCsv(`/api/reports/export/interventions?from=${from || '2000-01-01'}&to=${to || fmt.today()}&format=xlsx`) }, 'Export to Excel')),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Type'), typeSel), h('div', { class: 'field' }, h('label', {}, 'From'), fromI), h('div', { class: 'field' }, h('label', {}, 'To'), toI), h('label', { class: 'check', style: { marginTop: 0 } }, mineI, 'Mine only'), h('button', { class: 'btn', onClick: apply }, 'Apply')),
    h('div', { class: 'muted small mb' }, `${data.total} interventions · ${fmt.mins(totalMin)} shown`),
    interventionTable(data.rows, { onChange: refresh }));
});
