import { h, route, get, post, state, form, modal, toast, nav, table, badge, statusKind, fmt, can, pageHead, clear, clientStatus } from '../app.js';

// hasEpisodes: an existing client whose discharge lives on the Episodes tab (the New client form never
// shows discharge fields: intake opens an episode, and discharging is what closes it).
export function clientFields(C, { isNew = true, hasEpisodes = false } = {}) {
  return [
    { type: 'section', label: 'Who they are', collapsible: true, open: true, hint: 'only first and last name are required' },
    { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name', required: true }, { name: 'preferred_name', label: 'Preferred name' },
    { name: 'dob', label: 'Date of birth', type: 'date' }, { name: 'gender', label: 'Gender', type: 'select', options: ['female', 'male', 'non_binary', 'transgender_female', 'transgender_male', 'other', 'declined'] }, { name: 'pronouns', label: 'Pronouns' },
    { name: 'race_ethnicity', label: 'Race / ethnicity' }, { name: 'preferred_language', label: 'Preferred language', value: 'English' }, { name: 'veteran', label: 'Veteran', type: 'checkbox' },
    { type: 'section', label: 'How to reach them', collapsible: true, open: true },
    { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'alt_phone', label: 'Alternate phone', type: 'tel' }, { name: 'email', label: 'Email' },
    { name: 'address', label: 'Address', span: true }, { name: 'city', label: 'City' }, { name: 'zip', label: 'ZIP' },
    { name: 'ok_to_text', label: 'OK to text', type: 'checkbox' }, { name: 'ok_to_voicemail', label: 'OK to leave voicemail', type: 'checkbox' }, { name: 'contact_preferences', label: 'Contact preferences / safe contact notes', span: true },
    { name: 'emergency_contact', label: 'Emergency contact (name, relation, phone)', span: true },
    { type: 'section', label: 'Program status', collapsible: true, open: true },
    { name: 'status', label: 'Status', type: 'select', options: ['waitlist', 'active', 'inactive', 'closed', 'deceased'], value: 'active', required: true, noBlank: true, help: hasEpisodes ? 'To discharge, use the Episodes tab: it closes the episode, ends the care team and clears open to-dos.' : (isNew ? 'Anyone not on the waitlist is admitted: intake opens their first episode of care.' : undefined) },
    { name: 'intake_date', label: 'Intake date', type: 'date', value: fmt.today() },
    { name: 'referral_source', label: 'Referral source', type: 'select', options: ['self', 'family', 'emergency_dept', 'hospital', 'ems', 'law_enforcement', 'jail', 'court_probation', 'treatment_provider', 'primary_care', 'shelter', 'outreach', 'hotline', 'school', 'other'] },
    { name: 'referral_date', label: 'Referral date', type: 'date', help: 'When this person was referred in — not necessarily the same as intake.' },
    { name: 'engagement_date', label: 'Engagement date', type: 'date', help: 'When they first actually engaged with services. Together with the referral date, this tracks time-to-engagement.' },
    { name: 'housing_status', label: 'Housing status', type: 'select', options: ['stable', 'doubled_up', 'shelter', 'unsheltered', 'transitional', 'sober_living', 'incarcerated', 'treatment_facility', 'unknown'] },
    { name: 'insurance', label: 'Insurance', type: 'select', options: ['medicaid', 'medicare', 'private', 'uninsured', 'va', 'pending', 'unknown'] }, { name: 'medicaid_id', label: 'Medicaid ID' },
    { name: 'risk_level', label: 'Risk level', type: 'select', options: ['low', 'moderate', 'high', 'critical'], value: 'moderate', noBlank: true, required: true },
    ...(!isNew && !hasEpisodes ? [{ name: 'discharge_date', label: 'Discharge date', type: 'date' }, { name: 'discharge_reason', label: 'Discharge reason' }] : []),
    { type: 'section', label: 'Substance use & health details', collapsible: true, hint: 'fill in what you know; you can come back later' },
    { name: 'primary_substance', label: 'Primary substance', type: 'select', options: C.SUBSTANCES }, { name: 'secondary_substances', label: 'Secondary substances' }, { name: 'route_of_use', label: 'Route of use', type: 'select', options: ['oral', 'smoked', 'snorted', 'injected', 'multiple', 'unknown'] },
    { name: 'asam_level', label: 'ASAM level of care', type: 'select', options: C.ASAM }, { name: 'mat_status', label: 'MAT status', type: 'select', options: ['none', 'interested', 'referred', 'active', 'discontinued', 'unknown'] }, { name: 'mat_medication', label: 'MAT medication', type: 'select', options: ['buprenorphine', 'buprenorphine_xr', 'methadone', 'naltrexone_xr', 'naltrexone_oral', 'other'] },
    { name: 'overdose_history', label: 'History of overdose', type: 'checkbox' }, { name: 'last_overdose_date', label: 'Last overdose date', type: 'date' },
    { name: 'naloxone_provided', label: 'Naloxone provided', type: 'checkbox' }, { name: 'naloxone_last_date', label: 'Naloxone last given', type: 'date' },
    { name: 'co_occurring_mh', label: 'Co-occurring mental health', type: 'checkbox' }, { name: 'justice_involved', label: 'Justice involved', type: 'checkbox' }, { name: 'pregnant_or_parenting', label: 'Pregnant or parenting', type: 'checkbox' },
    { name: 'goals', label: 'Client goals', type: 'textarea', span: true }, { name: 'flags', label: 'Safety flags (comma separated)', span: true, help: 'e.g. no home visits alone, allergy: naltrexone, do not contact via family' },
  ];
}

export function openClientForm(values, onDone) {
  const isNew = !values;
  // Shown when the server thinks this person may already be on the caseload. Entering the same person
  // twice used to be caught on import but not on direct entry, which is how one client ends up as three
  // records under three spellings.
  const dupBox = h('div');
  let confirmedDuplicate = false;

  const showDuplicates = (matches) => {
    clear(dupBox);
    confirmedDuplicate = false;
    dupBox.append(h('div', { class: 'banner warn', role: 'alert' },
      h('div', {},
        h('b', {}, matches.length === 1 ? 'This person may already be on file.' : 'These people may already be on file.'),
        h('ul', { class: 'tight' }, matches.map(x => h('li', {},
          h('a', { href: `#/client/${x.id}`, onClick: () => m.close() }, x.display_name || x.client_code),
          ' ', h('span', { class: 'muted small' }, x.client_code, x.dob ? ` · born ${fmt.date(x.dob)}` : '', ` · ${fmt.label(clientStatus(x))}`),
          h('div', { class: 'small muted' }, `Matched on ${x.reasons.join(' and ')}.`)))),
        h('p', { class: 'small' }, 'Open the existing record if it is the same person. If it really is somebody different, confirm below.'),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', onChange: (e) => { confirmedDuplicate = e.target.checked; } }),
          ' This is a different person — create a new record anyway'))));
    dupBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const f = form(clientFields(state.constants, { isNew, hasEpisodes: !!(values && values.counts && values.counts.episodes) }), { values: values || {}, submitText: isNew ? 'Create client' : 'Save changes', onCancel: () => m.close(), extra: dupBox, draftKey: isNew ? 'client:new' : `client:${values.id}`, onSubmit: async (d) => {
    if (isNew) {
      try {
        const r = await post('/api/clients', { ...d, confirm_duplicate: confirmedDuplicate || undefined });
        toast(`Client ${r.client_code} created`, 'ok'); m.close(); onDone ? onDone(r.id) : nav(`client/${r.id}`);
      } catch (e) {
        if (e.data && e.data.duplicates) { showDuplicates(e.data.duplicates); throw new Error('Check the possible match below before continuing.'); }
        throw e;
      }
    } else { await (await import('../app.js')).put(`/api/clients/${values.id}`, d); toast('Client updated', 'ok'); m.close(); onDone && onDone(values.id); }
  } });

  // Check while they are still typing, so the match appears before the form is finished.
  if (isNew) {
    let timer;
    const check = async () => {
      const read = (n) => f.querySelector(`[name="${n}"]`)?.value || '';
      const body = { first_name: read('first_name'), last_name: read('last_name'), dob: read('dob'), phone: read('phone') };
      if (!body.last_name || (!body.dob && !body.phone && !body.first_name)) return;
      try {
        const r = await post('/api/clients/check-duplicates', body, { quiet: true });
        if (r.matches.length) showDuplicates(r.matches); else clear(dupBox);
      } catch { /* a failed check must never block entering a client */ }
    };
    for (const n of ['last_name', 'dob', 'phone']) {
      const el = f.querySelector(`[name="${n}"]`);
      if (el) el.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(check, 250); });
    }
  }

  const m = modal(isNew ? 'New client' : `Edit ${values.display_name}`, f, { wide: true });
}

const SORTS = [['', 'Recently updated'], ['last_contact', 'Last contact (oldest first)'], ['overdue', 'Overdue follow-ups'], ['risk', 'Risk']];
route('clients', async (r) => {
  const q = r.query.get('q') || ''; const status = r.query.get('status') || 'active'; const assigned = r.query.get('assigned_to') || '';
  const sort = SORTS.some(([k]) => k === r.query.get('sort')) ? r.query.get('sort') : '';
  const link = (o = {}) => { const v = { status, q, assigned_to: assigned, sort, ...o }; return 'clients?' + Object.entries(v).filter(([, x]) => x).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join('&'); };
  const data = await get(`/api/clients?limit=200&status=${encodeURIComponent(status)}${q ? '&q=' + encodeURIComponent(q) : ''}${assigned ? '&assigned_to=' + assigned : ''}${sort ? '&sort=' + sort : ''}`);
  let rows = data.clients;
  if (r.query.get('stale') === '1') rows = rows.filter(c => !c.last_contact || Date.now() - Date.parse(c.last_contact) > 30 * 86400000);
  const risk = r.query.get('risk'), substance = r.query.get('substance'), mat = r.query.get('mat');
  if (risk) rows = rows.filter(c => risk === 'high' ? ['high', 'critical'].includes(c.risk_level) : c.risk_level === risk);
  if (substance) rows = rows.filter(c => c.primary_substance === substance);
  if (mat) rows = rows.filter(c => (c.mat_status || 'none') === mat);
  // Same dashboard alert badge everything else links to a filtered view here, so this one does too,
  // instead of dropping onto the unfiltered caseload.
  let expiring = null;
  if (r.query.get('consent_expiring') === '1') {
    const rep = await get('/api/reports/dashboard');
    expiring = new Map(rep.consents_expiring.map(x => [x.client_id, x.expires_at]));
    rows = rows.filter(c => expiring.has(c.id));
  }
  const activeFilters = [r.query.get('stale') === '1' ? 'no contact in 30 days' : null, risk ? `risk: ${risk === 'high' ? 'high or critical' : risk}` : null, substance ? `substance: ${fmt.label(substance)}` : null, mat ? `MAT: ${fmt.label(mat)}` : null, expiring ? 'consent expiring soon' : null].filter(Boolean);
  const deid = !can('clients:read');
  const search = h('input', { type: 'search', value: q, placeholder: 'Name or preferred name (partial or misspelled OK), "Last, First", client code, DOB (YYYY-MM-DD) or exact phone', onKeydown: (e) => { if (e.key === 'Enter') nav(link({ q: search.value.trim() })); } });
  const statusSel = h('select', { onChange: () => nav(link({ status: statusSel.value })) }, ['active', 'waitlist', 'inactive', 'closed', 'deceased', 'all'].map(s => h('option', { value: s, selected: s === status }, fmt.label(s))));
  const sortSel = h('select', { 'aria-label': 'Sort', 'data-sort': '1', onChange: () => nav(link({ sort: sortSel.value })) }, SORTS.map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
  const assignSel = !state.user.caseload_restricted ? h('select', { onChange: () => nav(link({ assigned_to: assignSel.value })) }, h('option', { value: '' }, 'Any worker'), h('option', { value: state.user.id, selected: assigned === state.user.id }, 'Me'), state.users.filter(u => u.id !== state.user.id && ['navigator', 'clinician', 'supervisor'].includes(u.role)).map(u => h('option', { value: u.id, selected: u.id === assigned }, u.display_name))) : null;
  return h('div', {},
    pageHead('My clients', can('clients:write') ? h('button', { class: 'btn primary', onClick: () => openClientForm(null) }, '+ New client') : null, h('button', { class: 'btn', onClick: () => { const { downloadCsv } = window.__suds; downloadCsv('/api/reports/export/clients?format=xlsx'); } }, 'Export to Excel'), can('clients:write') ? h('a', { class: 'btn ghost', href: '#/imports' }, 'Import from Excel') : null),
    state.user.caseload_restricted ? h('div', { class: 'banner small' }, 'You are viewing your assigned caseload only. Ask a supervisor to assign additional clients.') : null,
    h('div', { class: 'filters' }, h('div', { class: 'field grow' }, h('label', {}, 'Search'), search), h('div', { class: 'field' }, h('label', {}, 'Status'), statusSel), assignSel ? h('div', { class: 'field' }, h('label', {}, 'Assigned to'), assignSel) : null, h('div', { class: 'field' }, h('label', {}, 'Sort'), sortSel), h('button', { class: 'btn', onClick: () => nav(link({ q: search.value.trim() })) }, 'Search'), q ? h('button', { class: 'btn ghost', onClick: () => nav(link({ q: '' })) }, 'Clear') : null),
    h('div', { class: 'muted small mb row' }, `${activeFilters.length ? rows.length + ' of ' : ''}${data.total} client${data.total === 1 ? '' : 's'}`, activeFilters.map(f => badge(f, 'info')), activeFilters.length ? h('a', { href: `#/clients?status=${status}`, class: 'small' }, 'clear filters') : null),
    table([
      { label: 'Client', render: c => h('div', {}, h('b', {}, c.display_name), h('div', { class: 'muted small' }, c.client_code, c.dob && !deid ? ` · DOB ${fmt.date(c.dob)}` : '')) },
      { label: 'Status', render: c => badge(fmt.label(clientStatus(c)), statusKind(clientStatus(c))) },
      { label: 'Risk', render: c => badge(fmt.label(c.risk_level), statusKind(c.risk_level)) },
      { label: 'Primary substance', render: c => fmt.label(c.primary_substance) },
      { label: 'MAT', render: c => fmt.label(c.mat_status) },
      { label: 'Assigned', key: 'assigned_workers' },
      { label: 'Intake', render: c => fmt.date(c.intake_date) },
      { label: 'Time to engage', render: c => c.days_to_engagement === null ? '—' : h('span', { style: c.days_to_engagement < 0 ? { color: 'var(--danger)' } : {} }, `${c.days_to_engagement}d`) },
      { label: 'Last contact', render: c => [h('span', { style: !c.last_contact || Date.now() - Date.parse(c.last_contact) > 30 * 86400000 ? { color: 'var(--warn)' } : {} }, fmt.ago(c.last_contact)), c.overdue_tasks ? [' ', badge(`${c.overdue_tasks} overdue`, 'danger')] : null] },
      expiring ? { label: 'Consent expires', render: c => fmt.date(expiring.get(c.id)) } : null,
    ].filter(Boolean), rows, { onRow: deid ? null : (c) => nav(`client/${c.id}`), rowLabel: c => `${c.display_name}, ${fmt.label(c.status)}`,
    compact: { primary: c => [h('span', {}, c.display_name), badge(fmt.label(c.risk_level), statusKind(c.risk_level))], secondary: c => [h('span', {}, 'last contact ', fmt.ago(c.last_contact)), h('span', {}, '· ', fmt.label(c.status)), c.overdue_tasks ? badge(`${c.overdue_tasks} overdue`, 'danger') : null, deid ? null : h('span', { class: 'mono' }, c.client_code)] },
    empty: q ? 'No one matches. Names are stored encrypted, so search only works from the start of the last name (misspellings are tolerated) — try just the first few letters, the full phone number, date of birth (YYYY-MM-DD) or the client code.' : (status === 'active' ? 'No active clients yet. Click + New client to add your first.' : 'No clients with this status.') }));
});
