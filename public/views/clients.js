import { h, route, get, post, put, state, form, modal, confirmDialog, toast, nav, table, pagedList, badge, statusKind, fmt, can, pageHead, clear, clientStatus, flag } from '../app.js';

// hasEpisodes: an existing client whose discharge lives on the Episodes tab (the New client form never
// shows discharge fields: intake opens an episode, and discharging is what closes it).
export function clientFields(C, { isNew = true, hasEpisodes = false, openEpisode = false } = {}) {
  // While an episode is open, closing the record (or recording a death) is a discharge, and the discharge
  // is what closes the episode, ends the care team and clears the to-dos — so those two are taken off the
  // menu here and the help text says where they went. The server refuses them too.
  const statusOptions = ['waitlist', 'active', 'inactive', 'closed', 'deceased'].map(sv => ({ value: sv, label: fmt.label(sv), disabled: openEpisode && (sv === 'closed' || sv === 'deceased'), title: openEpisode && (sv === 'closed' || sv === 'deceased') ? 'Discharge on the Episodes tab' : null }));
  return [
    { type: 'section', label: 'Who they are', collapsible: true, open: true, hint: 'only first and last name are required' },
    { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name', required: true }, { name: 'preferred_name', label: 'Preferred name' },
    { name: 'dob', label: 'Date of birth', type: 'date', max: fmt.today(), min: '1900-01-01' }, { name: 'gender', label: 'Gender', type: 'select', options: ['female', 'male', 'non_binary', 'transgender_female', 'transgender_male', 'other', 'declined'] }, { name: 'pronouns', label: 'Pronouns' },
    { name: 'race_ethnicity', label: 'Race / ethnicity' }, { name: 'preferred_language', label: 'Preferred language', value: 'English' }, { name: 'veteran', label: 'Veteran', type: 'checkbox' },
    { type: 'section', label: 'How to reach them', collapsible: true, open: true },
    { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'alt_phone', label: 'Alternate phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'address', label: 'Address', span: true }, { name: 'city', label: 'City' }, { name: 'zip', label: 'ZIP' },
    { name: 'ok_to_text', label: 'OK to text', type: 'checkbox' }, { name: 'ok_to_voicemail', label: 'OK to leave voicemail', type: 'checkbox' }, { name: 'contact_preferences', label: 'Contact preferences / safe contact notes', span: true },
    { name: 'emergency_contact', label: 'Emergency contact (name, relation, phone)', span: true },
    { type: 'section', label: 'Program status', collapsible: true, open: true },
    { name: 'status', label: 'Status', type: 'select', options: statusOptions, value: 'active', required: true, noBlank: true, help: openEpisode ? 'An episode of care is open, so "Closed" and "Deceased" are set by discharging on the Episodes tab: that closes the episode, ends the care team and clears open to-dos.' : hasEpisodes ? 'To discharge, use the Episodes tab: it closes the episode, ends the care team and clears open to-dos.' : (isNew ? 'Anyone not on the waitlist is admitted: intake opens their first episode of care.' : undefined) },
    { name: 'intake_date', label: 'Intake date', type: 'date', value: fmt.today() },
    { name: 'referral_source', label: 'Referral source', type: 'select', options: ['self', 'family', 'emergency_dept', 'hospital', 'ems', 'law_enforcement', 'jail', 'court_probation', 'treatment_provider', 'primary_care', 'shelter', 'outreach', 'hotline', 'school', 'other'] },
    { name: 'referral_date', label: 'Referral date', type: 'date', help: 'When this person was referred in — not necessarily the same as intake.' },
    { name: 'engagement_date', label: 'Engagement date', type: 'date', help: 'When they first actually engaged with services. Together with the referral date, this tracks time-to-engagement.' },
    { name: 'housing_status', label: 'Housing status', type: 'select', options: ['stable', 'doubled_up', 'shelter', 'unsheltered', 'transitional', 'sober_living', 'incarcerated', 'treatment_facility', 'unknown'] },
    { name: 'insurance', label: 'Insurance', type: 'select', options: ['medicaid', 'medicare', 'private', 'uninsured', 'va', 'pending', 'unknown'] }, { name: 'medicaid_id', label: 'Medicaid ID' },
    { name: 'risk_level', label: 'Risk level', type: 'select', options: ['low', 'moderate', 'high', 'critical'], value: 'moderate', noBlank: true, required: true },
    ...(!isNew && !hasEpisodes ? [{ name: 'discharge_date', label: 'Discharge date', type: 'date' }, { name: 'discharge_reason', label: 'Discharge reason', type: 'select', list: 'DISCHARGE_REASONS' }] : []),
    { type: 'section', label: 'Substance use & health details', collapsible: true, hint: 'fill in what you know; you can come back later' },
    { name: 'primary_substance', label: 'Primary substance', type: 'select', list: 'SUBSTANCES' }, { name: 'secondary_substances', label: 'Secondary substances' }, { name: 'route_of_use', label: 'Route of use', type: 'select', options: ['oral', 'smoked', 'snorted', 'injected', 'multiple', 'unknown'] },
    { name: 'asam_level', label: 'ASAM level of care', type: 'select', options: C.ASAM }, { name: 'mat_status', label: 'MAT status', type: 'select', options: ['none', 'interested', 'referred', 'active', 'discontinued', 'unknown'] }, { name: 'mat_medication', label: 'MAT medication', type: 'select', options: ['buprenorphine', 'buprenorphine_xr', 'methadone', 'naltrexone_xr', 'naltrexone_oral', 'other'] },
    { name: 'overdose_history', label: 'History of overdose', type: 'checkbox' }, { name: 'last_overdose_date', label: 'Last overdose date', type: 'date' },
    { name: 'naloxone_provided', label: 'Naloxone provided', type: 'checkbox' }, { name: 'naloxone_last_date', label: 'Naloxone last given', type: 'date' },
    { name: 'co_occurring_mh', label: 'Co-occurring mental health', type: 'checkbox' }, { name: 'justice_involved', label: 'Justice involved', type: 'checkbox' }, { name: 'pregnant_or_parenting', label: 'Pregnant or parenting', type: 'checkbox' },
    { name: 'goals', label: 'Client goals', type: 'textarea', span: true }, { name: 'flags', label: 'Safety flags (comma separated)', span: true, help: 'e.g. no home visits alone, allergy: naltrexone, do not contact via family' },
  ];
}

// The same checks the server makes (server/routes/clients.js checkContactFields), so a typo is caught
// before the round trip and shown under the field it belongs to.
export function checkClientFields(d) {
  const fields = {};
  if (d.dob) { if (d.dob > fmt.today()) fields.dob = 'cannot be in the future'; else if (d.dob < '1900-01-01') fields.dob = 'must be after 1900'; }
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) fields.email = 'is not a valid email address';
  for (const f of ['phone', 'alt_phone']) if (d[f] && String(d[f]).replace(/\D/g, '').length < 7) fields[f] = 'must contain at least 7 digits';
  if (Object.keys(fields).length) { const e = new Error('Check the highlighted fields.'); e.data = { fields }; throw e; }
}

export function openClientForm(values, onDone) {
  const isNew = !values;
  // Shown when the server thinks this person may already be on the caseload. Entering the same person
  // twice used to be caught on import but not on direct entry, which is how one client ends up as three
  // records under three spellings.
  const dupBox = h('div');
  let confirmedDuplicate = false;

  // A returning client whose earlier record was discharged and is on nobody's caseload (so this worker cannot
  // open it): the server offers it for re-admission instead of a dead end. Only the client code and the
  // discharge are shown — nothing from the stored record that the person at the desk has not just said.
  const readmit = async (x, btn) => {
    const read = (n) => f.querySelector(`[name="${n}"]`)?.value || undefined;
    const reason = await confirmDialog('Re-admit this person', `The earlier record ${x.client_code} comes onto your caseload, a new episode of care opens, and a supervisor reviews the re-admission. Say why (for example "walked in asking to restart services").`, { okText: 'Re-admit', requireReason: true, minLength: 15 });
    if (!reason) return;
    btn.disabled = true;
    try {
      const r = await post(`/api/clients/${x.id}/readmit`, { first_name: read('first_name'), last_name: read('last_name'), dob: read('dob'), phone: read('phone'), referral_source: read('referral_source'), reason });
      f.finished(); toast(`${r.client_code} re-admitted to your caseload`, 'ok'); m.close(); onDone ? onDone(r.id) : nav(`client/${r.id}`);
    } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
  };
  const readmitBanner = (offers) => offers.length ? h('div', { class: 'banner warn', role: 'alert', 'data-readmit-offer': '1' },
    h('div', {},
      h('b', {}, offers.length === 1 ? 'An earlier record exists for this person, and they were discharged.' : 'Earlier records exist for this person, and they were discharged.'),
      h('ul', { class: 'tight' }, offers.map(x => h('li', {},
        h('span', { class: 'mono' }, x.client_code), ' ', h('span', { class: 'muted small' }, x.discharge_date ? `discharged ${fmt.date(x.discharge_date)}${x.discharge_reason ? ` (${fmt.label(x.discharge_reason, 'DISCHARGE_REASONS')})` : ''}` : fmt.label(x.status)),
        h('div', { class: 'small muted' }, `Matched on ${x.reasons.join(' and ')}.`),
        h('button', { class: 'btn sm primary', type: 'button', 'data-readmit': x.id, onClick: (e) => readmit(x, e.currentTarget) }, 'Re-admit this person')))),
      h('p', { class: 'small' }, 'It is not on your caseload, so you cannot open it — but re-admitting carries on their record instead of starting a second one. It is logged and a supervisor reviews it.'))) : null;

  const showDuplicates = (matches, offers = []) => {
    clear(dupBox);
    confirmedDuplicate = false;
    if (offers.length) dupBox.append(readmitBanner(offers));
    if (!matches.length) { dupBox.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
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

  const f = form(clientFields(state.constants, { isNew, hasEpisodes: !!(values && values.counts && values.counts.episodes), openEpisode: !!(values && values.open_episode) }), { values: values || {}, submitText: isNew ? 'Create client' : 'Save changes', onCancel: () => m.close(), extra: dupBox, draftKey: isNew ? 'client:new' : `client:${values.id}`, onSubmit: async (d) => {
    checkClientFields(d);
    if (isNew) {
      try {
        const r = await post('/api/clients', { ...d, confirm_duplicate: confirmedDuplicate || undefined });
        toast(`Client ${r.client_code} created`, 'ok'); m.close(); onDone ? onDone(r.id) : nav(`client/${r.id}`);
      } catch (e) {
        if (e.data && e.data.duplicates) { showDuplicates(e.data.duplicates, e.data.readmit || []); throw new Error('Check the possible match below before continuing.'); }
        if (e.data && e.data.readmit && e.data.readmit.length) { showDuplicates([], e.data.readmit); throw new Error('This person has an earlier record. Re-admit it below.'); }
        throw e;
      }
    } else {
      // Only what this person changed goes to the server, with the version they opened: a save used to send
      // every field on the form, so it quietly put back whatever a colleague had changed in the meantime.
      const changed = f.changedKeys();
      if (!changed.length) { toast('No changes to save', 'ok'); f.finished(); m.close(); return; }
      const body = Object.fromEntries(changed.map(k => [k, d[k]]));
      await put(`/api/clients/${values.id}`, { ...body, if_updated_at: values.updated_at });
      toast('Client updated', 'ok'); m.close(); onDone && onDone(values.id);
    }
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
        if (r.matches.length || (r.readmit && r.readmit.length)) showDuplicates(r.matches, r.readmit || []); else clear(dupBox);
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
  // Every filter runs on the server, inside the caseload-scoped query, so the total is the real number (the
  // same one the Home tile counts) and "Load more" reaches every match. It used to fetch 200 rows and
  // filter those here: a tile of 915 high-risk clients opened a list of 101.
  const risk = r.query.get('risk'), substance = r.query.get('substance'), mat = r.query.get('mat');
  const stale = r.query.get('stale') === '1', consentExpiring = r.query.get('consent_expiring') === '1';
  const wantRequests = r.query.get('patient_requests') === '1' && can('patient-requests:read');
  const params = { status, q, assigned_to: assigned, sort, risk, substance, mat, stale: stale ? '1' : '', consent_expiring: consentExpiring ? '1' : '', patient_requests: wantRequests ? '1' : '' };
  const listUrl = '/api/clients?' + Object.entries(params).filter(([, x]) => x).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join('&');
  const PAGE = 200;
  const data = await get(`${listUrl}&limit=${PAGE}`);
  const expiring = consentExpiring;
  // The Home card for open patient-rights requests lands here, narrowed (on the server) to the clients that
  // have one; the requests themselves are fetched for the "Request due" column.
  let requests = null;
  if (wantRequests) {
    const rq = await get('/api/patient-requests?status=open&limit=1000');
    requests = new Map(); for (const x of rq.rows) requests.set(x.client_id, [...(requests.get(x.client_id) || []), x]);
  }
  const activeFilters = [requests ? 'open patient request' : null, stale ? 'no contact in 30 days' : null, risk ? `risk: ${risk === 'high' ? 'high or critical' : risk}` : null, substance ? `substance: ${fmt.label(substance, 'SUBSTANCES')}` : null, mat ? `MAT: ${fmt.label(mat)}` : null, expiring ? 'consent expiring soon' : null].filter(Boolean);
  const deid = !can('clients:read');
  const search = h('input', { type: 'search', value: q, placeholder: 'Name or preferred name (partial or misspelled OK), "Last, First", client code, DOB (YYYY-MM-DD) or exact phone', onKeydown: (e) => { if (e.key === 'Enter') nav(link({ q: search.value.trim() })); } });
  const statusSel = h('select', { onChange: () => nav(link({ status: statusSel.value })) }, ['active', 'waitlist', 'inactive', 'closed', 'deceased', 'all'].map(s => h('option', { value: s, selected: s === status }, fmt.label(s))));
  const sortSel = h('select', { 'aria-label': 'Sort', 'data-sort': '1', onChange: () => nav(link({ sort: sortSel.value })) }, SORTS.map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
  const assignSel = !state.user.caseload_restricted ? h('select', { onChange: () => nav(link({ assigned_to: assignSel.value })) }, h('option', { value: '' }, 'Any worker'), h('option', { value: state.user.id, selected: assigned === state.user.id }, 'Me'), state.users.filter(u => u.id !== state.user.id && ['navigator', 'clinician', 'supervisor'].includes(u.role)).map(u => h('option', { value: u.id, selected: u.id === assigned }, u.display_name))) : null;
  return h('div', {},
    pageHead('My clients', can('clients:write') ? h('button', { class: 'btn primary', onClick: () => openClientForm(null) }, '+ New client') : null, can('export:read') ? h('button', { class: 'btn', onClick: () => { const { downloadCsv } = window.__suds; downloadCsv('/api/reports/export/clients?format=xlsx'); } }, 'Export to Excel') : null, can('clients:write') ? h('a', { class: 'btn ghost', href: '#/imports' }, 'Import from Excel') : null),
    state.user.caseload_restricted ? h('div', { class: 'banner small' }, 'You are viewing your assigned caseload only. Ask a supervisor to assign additional clients.') : null,
    h('div', { class: 'filters' }, h('div', { class: 'field grow' }, h('label', {}, 'Search'), search), h('div', { class: 'field' }, h('label', {}, 'Status'), statusSel), assignSel ? h('div', { class: 'field' }, h('label', {}, 'Assigned to'), assignSel) : null, h('div', { class: 'field' }, h('label', {}, 'Sort'), sortSel), h('button', { class: 'btn', onClick: () => nav(link({ q: search.value.trim() })) }, 'Search'), q ? h('button', { class: 'btn ghost', onClick: () => nav(link({ q: '' })) }, 'Clear') : null),
    h('div', { class: 'muted small mb row', 'data-client-total': String(data.total) }, `${fmt.num(data.total)} client${data.total === 1 ? '' : 's'}${activeFilters.length ? ' match' : ''}`, activeFilters.map(f => badge(f, 'info')), activeFilters.length ? h('a', { href: `#/clients?status=${status}`, class: 'small' }, 'clear filters') : null),
    pagedList({ first: data, url: listUrl, key: 'clients', limit: PAGE, render: (rows) => table([
      { label: 'Client', render: c => h('div', {}, h('b', {}, c.display_name), h('div', { class: 'muted small' }, c.client_code, c.dob && !deid ? ` · DOB ${fmt.date(c.dob)}` : '')) },
      { label: 'Status', render: c => badge(fmt.label(clientStatus(c)), statusKind(clientStatus(c))) },
      { label: 'Risk', render: c => badge(fmt.label(c.risk_level), statusKind(c.risk_level)) },
      { label: 'Primary substance', render: c => fmt.label(c.primary_substance, 'SUBSTANCES') },
      { label: 'MAT', render: c => fmt.label(c.mat_status) },
      { label: 'Assigned', key: 'assigned_workers' },
      { label: 'Intake', render: c => fmt.date(c.intake_date) },
      { label: 'Time to engage', render: c => c.days_to_engagement === null ? '—' : flag(`${c.days_to_engagement}d`, c.days_to_engagement < 0, 'engagement date is before the referral date') },
      { label: 'Last contact', render: c => [flag(fmt.ago(c.last_contact), !c.last_contact || Date.now() - Date.parse(c.last_contact) > 30 * 86400000, 'no contact in the last 30 days', 'warn'), c.overdue_tasks ? [' ', badge(`${c.overdue_tasks} overdue`, 'danger')] : null] },
      expiring ? { label: 'Consent expires', render: c => fmt.date(c.consent_expires_at) } : null,
      requests ? { label: 'Request due', render: c => h('a', { href: `#/client/${c.id}/requests` }, (requests.get(c.id) || []).map(x => h('div', { style: x.overdue ? { color: 'var(--danger)', fontWeight: 600 } : {} }, `${fmt.label(x.kind)} · ${fmt.date(x.due_at)}${x.overdue ? ' — overdue' : ''}`))) } : null,
    ].filter(Boolean), rows, { onRow: deid ? null : (c) => nav(`client/${c.id}`), rowLabel: c => `${c.display_name}, ${fmt.label(c.status)}`,
    compact: { primary: c => [h('span', {}, c.display_name), badge(fmt.label(c.risk_level), statusKind(c.risk_level))], secondary: c => [h('span', {}, 'last contact ', fmt.ago(c.last_contact)), h('span', {}, '· ', fmt.label(c.status)), c.overdue_tasks ? badge(`${c.overdue_tasks} overdue`, 'danger') : null, deid ? null : h('span', { class: 'mono' }, c.client_code)] },
    empty: q ? 'No one matches. Names are stored encrypted, so search only works from the start of the last name (misspellings are tolerated) — try just the first few letters, the full phone number, date of birth (YYYY-MM-DD) or the client code.' : (activeFilters.length ? 'No clients match these filters.' : status === 'active' ? 'No active clients yet. Click + New client to add your first.' : 'No clients with this status.') }) }));
});
