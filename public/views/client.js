import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, parseHash, kv, stat, clientPicker } from '../app.js';
import { openClientForm } from './clients.js';
import { openInterventionForm, openRepeatInterventionForm, interventionTable } from './interventions.js';
import { openCallForm, callTable } from './calls.js';
import { openTimeForm, timeTable } from './time.js';
import { openReferralForm, referralTable } from './referrals.js';
import { openTaskForm, taskTable } from './tasks.js';
import { openNoteForm, noteTable } from './notes.js';
import { openExpenditureForm, expenditureTable } from './budget.js';

route('client', async (r) => {
  const id = r.id; const tab = r.sub || 'overview';
  const { client: c } = await get(`/api/clients/${id}`);
  const disp = `${c.display_name} (${c.client_code})`;
  // A modal's onDone fires asynchronously, after its POST/PUT resolves — by then the worker may already
  // have clicked to a different tab, or away from this client entirely. Re-reading the hash here (instead
  // of closing over `tab`) means a slow save refreshes wherever the worker actually is now rather than
  // silently navigating them back to the tab that was open when they started the save; and it no-ops
  // instead of firing at all once they've left this client's page.
  const refresh = () => { const h = parseHash(); if (h.name === 'client' && h.id === id) nav(`client/${id}/${h.sub || 'overview'}?_=${Date.now()}`); };
  const ctxOpts = { clientId: id, clientDisplay: disp, onDone: refresh };
  const tabs = [['overview', 'Overview'], ['timeline', 'Timeline'], ['interventions', `Interventions (${c.counts.interventions})`], ['calls', `Calls (${c.counts.calls})`], ['notes', `Notes (${c.counts.notes})`], ['referrals', `Referrals (${c.counts.referrals})`], ['forms', `Forms (${c.counts.forms || 0})`], ['tasks', `Tasks (${c.counts.open_tasks})`], ['episodes', 'Episodes'], ['consents', 'Consents & ROI'], ['time', 'Time'], can('budget:read') ? ['budget', 'Assistance $'] : null, ['team', 'Care team']].filter(Boolean);
  const body = h('div', {});
  const view = h('div', {},
    h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, c.display_name, ' ', h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '1rem' } }, c.client_code)),
      h('div', { class: 'row' }, badge(fmt.label(c.status), statusKind(c.status)), badge(`Risk: ${fmt.label(c.risk_level)}`, statusKind(c.risk_level)), c.primary_substance ? badge(fmt.label(c.primary_substance)) : null, c.mat_status && c.mat_status !== 'none' ? badge(`MAT: ${fmt.label(c.mat_status)}`, 'purple') : null, c.overdose_history ? badge('OD history', 'danger') : null, c.naloxone_provided ? badge('Naloxone ✓', 'ok') : badge('No naloxone', 'warn'), c.flags ? badge(`⚠ ${c.flags}`, 'danger') : null)),
      h('div', { class: 'row' },
        can('interventions:write') ? h('button', { class: 'btn primary', onClick: () => openInterventionForm(null, ctxOpts) }, '+ Intervention') : null,
        can('interventions:write') && c.counts.interventions ? h('button', { class: 'btn', title: 'Prefill from their most recent visit — same type, location and supplies, with today\'s date and a blank summary', onClick: () => openRepeatInterventionForm(id, disp, refresh) }, '↻ Repeat last visit') : null,
        can('calls:write') ? h('button', { class: 'btn', onClick: () => openCallForm(null, ctxOpts) }, '+ Call') : null,
        can('calls:write') ? h('button', { class: 'btn', onClick: () => openCallForm(null, { ...ctxOpts, method: 'text' }) }, '+ Text') : null,
        (can('notes:admin:write') || can('notes:clinical:write')) ? h('button', { class: 'btn', onClick: () => openNoteForm(null, ctxOpts) }, '+ Note') : null,
        can('tasks:write') ? h('button', { class: 'btn', onClick: () => openTaskForm(null, ctxOpts) }, '+ Task') : null,
        can('clients:write') ? h('button', { class: 'btn', onClick: () => openClientForm(c, refresh) }, 'Edit') : null)),
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onClick: () => nav(`client/${id}/${k}`) }, l))),
    body);

  const T = {
    async overview() {
      const age = c.dob ? Math.floor((Date.now() - Date.parse(c.dob)) / (365.25 * 86400000)) : null;
      return h('div', { class: 'grid cols-2' },
        h('div', { class: 'card' }, h('h3', {}, 'Identity & contact'), kv([['Name', `${c.first_name} ${c.last_name}${c.preferred_name ? ` ("${c.preferred_name}")` : ''}`], ['DOB', c.dob ? `${fmt.date(c.dob)} (${age})` : null], ['Gender / pronouns', [c.gender && fmt.label(c.gender), c.pronouns].filter(Boolean).join(' · ')], ['Phone', [c.phone, c.alt_phone].filter(Boolean).join(' / ')], ['Email', c.email], ['Address', [c.address, c.city, c.zip].filter(Boolean).join(', ')], ['Language', c.preferred_language], ['Contact rules', [c.ok_to_text ? 'OK to text' : 'No texting', c.ok_to_voicemail ? 'OK to voicemail' : 'No voicemail', c.contact_preferences].filter(Boolean).join(' · ')], ['Emergency contact', c.emergency_contact], ['Housing', c.housing_status && fmt.label(c.housing_status)], ['Insurance', [c.insurance && fmt.label(c.insurance), c.medicaid_id && `ID ${c.medicaid_id}`].filter(Boolean).join(' · ')], ['Veteran', c.veteran ? 'Yes' : 'No']])),
        h('div', { class: 'card' }, h('h3', {}, 'Substance use & clinical'), kv([['Primary substance', fmt.label(c.primary_substance)], ['Secondary', c.secondary_substances], ['Route', c.route_of_use && fmt.label(c.route_of_use)], ['ASAM level', c.asam_level], ['MAT', [c.mat_status && fmt.label(c.mat_status), c.mat_medication && fmt.label(c.mat_medication)].filter(Boolean).join(' — ')], ['Overdose history', c.overdose_history ? `Yes${c.last_overdose_date ? ', last ' + fmt.date(c.last_overdose_date) : ''}` : 'No'], ['Naloxone', c.naloxone_provided ? `Provided${c.naloxone_last_date ? ' ' + fmt.date(c.naloxone_last_date) : ''}` : 'Not provided'], ['Co-occurring MH', c.co_occurring_mh ? 'Yes' : 'No'], ['Justice involved', c.justice_involved ? 'Yes' : 'No'], ['Pregnant / parenting', c.pregnant_or_parenting ? 'Yes' : 'No'], ['Goals', c.goals]])),
        h('div', { class: 'card' }, h('h3', {}, 'Program'), kv([['Status', fmt.label(c.status)], ['Intake', fmt.date(c.intake_date)], ['Referral source', c.referral_source && fmt.label(c.referral_source)], ['Referral date', c.referral_date && fmt.date(c.referral_date)], ['Engagement date', c.engagement_date && fmt.date(c.engagement_date)],
          ['Time until engaged', c.days_to_engagement === null ? (c.referral_date || c.engagement_date ? h('span', { class: 'muted' }, 'needs both dates') : null) : h('span', { style: c.days_to_engagement < 0 ? { color: 'var(--danger)' } : {} }, `${c.days_to_engagement} day${Math.abs(c.days_to_engagement) === 1 ? '' : 's'}`)],
          ['Discharge', c.discharge_date ? `${fmt.date(c.discharge_date)} — ${c.discharge_reason || ''}` : null], ['Care team', c.assignments.filter(a => !a.end_date).map(a => `${a.display_name} (${fmt.label(a.role_on_case)})`).join(', ') || 'Unassigned'], ['Active consents', c.active_consents.length ? c.active_consents.map(x => `${fmt.label(x.type)}${x.recipient ? ' → ' + x.recipient : ''}`).join('; ') : h('span', { style: { color: 'var(--warn)' } }, 'None on file')]])),
        h('div', { class: 'grid cols-4', style: { gridColumn: '1 / -1' } }, stat('Interventions', c.counts.interventions, '', `client/${id}/interventions`), stat('Calls', c.counts.calls, '', `client/${id}/calls`), stat('Service time', fmt.mins(c.counts.minutes), '', `client/${id}/time`), stat('Open tasks', c.counts.open_tasks, c.counts.open_tasks ? 'warn' : '', `client/${id}/tasks`), can('budget:read') ? stat('Assistance spent', fmt.money(c.counts.spent), '', `client/${id}/budget`) : null, stat('Referrals', c.counts.referrals, '', `client/${id}/referrals`)));
    },
    async timeline() {
      const { events } = await get(`/api/clients/${id}/timeline`);
      if (!events.length) return h('div', { class: 'empty' }, 'No activity yet.');
      return h('div', { class: 'card' }, h('ul', { class: 'timeline' }, events.map(e => h('li', { class: e.kind }, h('div', { class: 't' }, e.at ? fmt.dt(e.at) : '', e.worker ? ` · ${e.worker}` : ''),
        h('div', { class: 'h' }, e.kind === 'note' ? h('a', { href: '#', onClick: async (ev) => { ev.preventDefault(); (await import('./notes.js')).openNote(e.id, { onChange: refresh }); } }, e.title) : (e.kind === 'intervention' ? fmt.label(e.title) : e.title), ' ', e.meta?.status ? badge(fmt.label(e.meta.status), statusKind(e.meta.status)) : null, e.meta?.outcome ? badge(fmt.label(e.meta.outcome), statusKind(e.meta.outcome)) : null, e.meta?.duration ? h('span', { class: 'muted small' }, ` ${fmt.mins(e.meta.duration)}`) : null, e.meta?.crisis ? badge('Crisis', 'danger') : null),
        e.detail ? h('div', { class: 'd' }, String(e.detail).slice(0, 300)) : null))));
    },
    async interventions() { const d = await get(`/api/interventions?client_id=${id}&limit=500`); return interventionTable(d.rows, { showClient: false, onChange: refresh }); },
    async calls() { const d = await get(`/api/calls?client_id=${id}&limit=500`); return callTable(d.rows, { showClient: false, onChange: refresh }); },
    async notes() { const d = await get(`/api/notes?client_id=${id}&limit=500`); return h('div', {}, !can('notes:clinical:read') ? h('div', { class: 'banner small' }, 'Clinical notes are hidden from your role.') : null, noteTable(d.rows, { showClient: false, onChange: refresh })); },
    async referrals() { const d = await get(`/api/referrals?client_id=${id}&limit=500`); return h('div', {}, h('div', { class: 'row mb' }, can('referrals:write') ? h('button', { class: 'btn primary', onClick: () => openReferralForm(null, ctxOpts) }, '+ New referral') : null), referralTable(d.rows, { showClient: false, onChange: refresh })); },
    async tasks() { const d = await get(`/api/tasks?client_id=${id}&limit=500`); return taskTable(d.rows, { showClient: false, onChange: refresh }); },
    async time() { const d = await get(`/api/time?client_id=${id}&limit=500`); return h('div', {}, h('div', { class: 'row mb' }, can('time:write') ? h('button', { class: 'btn primary', onClick: () => openTimeForm(null, ctxOpts) }, '+ Log time') : null), timeTable(d.rows, { showClient: false, onChange: refresh })); },
    async budget() { const d = await get(`/api/budget/expenditures?client_id=${id}&limit=500`); return h('div', {}, h('div', { class: 'row mb' }, can('budget:write') ? h('button', { class: 'btn primary', onClick: () => openExpenditureForm(null, ctxOpts) }, '+ Record client assistance') : null, h('span', { class: 'muted' }, `Total approved: ${fmt.money(c.counts.spent)}`)), expenditureTable(d.rows, { showClient: false, onChange: refresh })); },
    async forms() { return (await import('./forms.js')).clientFormsTab(id, { refresh }); },
    async episodes() { return (await import('./episodes.js')).episodesPanel(id, { onChange: refresh }); },
    async consents() {
      const d = await get(`/api/clients/${id}/consents`); const C = state.constants;
      const addConsent = () => { const f = form([{ name: 'type', label: 'Consent type', type: 'select', options: C.CONSENT_TYPES, required: true }, { name: 'signed_at', label: 'Signed', type: 'date', required: true, value: fmt.today() }, { name: 'expires_at', label: 'Expires', type: 'date' }, { name: 'recipient', label: 'Recipient (who may receive info)', span: true }, { name: 'purpose', label: 'Purpose of disclosure', span: true }, { name: 'scope', label: 'Information covered', type: 'textarea', span: true, rows: 2 }, { name: 'witness', label: 'Witness' }, { name: 'document_ref', label: 'Document location / scan ref' }], { submitText: 'Record consent', onCancel: () => m.close(), onSubmit: async (v) => { await post(`/api/clients/${id}/consents`, v); toast('Consent recorded', 'ok'); m.close(); refresh(); } }); const m = modal('Record consent / release of information', h('div', {}, h('div', { class: 'banner small' }, '42 CFR Part 2: a written consent must name the recipient, purpose, and information to be disclosed, and include an expiration.'), f)); };
      const addDisclosure = () => { const f = form([{ name: 'basis', label: 'Legal basis', type: 'select', options: ['consent', 'medical_emergency', 'court_order', 'qsoa', 'audit_evaluation', 'research', 'crime_on_premises', 'child_abuse_report', 'other'], value: 'consent', noBlank: true, required: true }, { name: 'consent_id', label: 'Consent relied on', type: 'select', options: d.consents.filter(x => !x.revoked_at).map(x => ({ value: x.id, label: `${fmt.label(x.type)} → ${x.recipient || '—'} (${fmt.date(x.signed_at)})` })) }, { name: 'disclosed_at', label: 'Date disclosed', type: 'datetime', required: true, value: new Date().toISOString() }, { name: 'method', label: 'Method', type: 'select', options: ['verbal', 'phone', 'fax', 'secure_email', 'portal', 'paper', 'in_person'] }, { name: 'disclosed_to', label: 'Disclosed to', required: true, span: true }, { name: 'purpose', label: 'Purpose', required: true, span: true }, { name: 'info_disclosed', label: 'Information disclosed', type: 'textarea', required: true, span: true, rows: 2 }], { submitText: 'Record disclosure', onCancel: () => m.close(), onSubmit: async (v) => { await post(`/api/clients/${id}/disclosures`, v); toast('Disclosure recorded', 'ok'); m.close(); refresh(); } }); const m = modal('Record a disclosure', f); };
      const revokedRefs = (d.consents || []).some(x => x.revoked_at);
      return h('div', { class: 'grid cols-2' },
        revokedRefs ? h('div', { class: 'banner warn span', role: 'status', style: { gridColumn: '1 / -1' } },
          'A consent on this client has been revoked. Any referral that relied on it is flagged — stop sharing information under it and close those referrals out.') : null,
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Consents & releases'), can('consents:write') ? h('button', { class: 'btn sm primary', onClick: addConsent }, '+ Consent') : null),
          table([{ label: 'Type', render: x => fmt.label(x.type) }, { label: 'Recipient', key: 'recipient' }, { label: 'Purpose', key: 'purpose' }, { label: 'Signed', render: x => fmt.date(x.signed_at) }, { label: 'Expires', render: x => x.expires_at ? h('span', { style: Date.parse(x.expires_at) < Date.now() ? { color: 'var(--danger)' } : {} }, fmt.date(x.expires_at)) : '—' }, { label: 'Status', render: x => x.revoked_at ? badge('Revoked', 'danger') : (x.expires_at && Date.parse(x.expires_at) < Date.now()) ? badge('Expired', 'warn') : badge('Active', 'ok') },
            { label: '', render: x => !x.revoked_at && can('consents:write') ? h('button', { class: 'btn sm ghost', onClick: async () => { const reason = await confirmDialog('Revoke consent', 'Record that the client revoked this consent?', { danger: true, okText: 'Revoke', requireReason: true }); if (reason) { await post(`/api/consents/${x.id}/revoke`, { reason }); refresh(); } } }, 'Revoke') : null }], d.consents, { empty: 'No consents on file. SUD records cannot be shared without written consent.' })),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Accounting of disclosures'), can('consents:write') ? h('button', { class: 'btn sm primary', onClick: addDisclosure }, '+ Disclosure') : null),
          table([{ label: 'Date', render: x => fmt.dt(x.disclosed_at) }, { label: 'To', key: 'recipient' }, { label: 'Purpose', key: 'purpose' }, { label: 'What', key: 'what' }, { label: 'Basis', render: x => fmt.label(x.basis) }, { label: 'How it was recorded', render: x => fmt.label(x.source || 'manual') }, { label: 'By', key: 'disclosed_by_name' }], d.disclosures, { empty: 'No disclosures recorded. Every time identifiable information leaves this programme, it is recorded here.' })));
    },
    async team() {
      const assign = () => { const f = form([{ name: 'user_id', label: 'Worker', type: 'user', required: true }, { name: 'role_on_case', label: 'Role', type: 'select', options: ['primary', 'secondary', 'clinician', 'peer', 'supervisor'], value: 'primary', noBlank: true }, { name: 'start_date', label: 'Start', type: 'date', value: fmt.today() }, { name: 'notes', label: 'Notes', span: true }], { submitText: 'Assign', onCancel: () => m.close(), onSubmit: async (v) => { await post(`/api/clients/${id}/assignments`, v); toast('Assigned', 'ok'); m.close(); refresh(); } }); const m = modal('Assign worker', f); };
      return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Care team assignments'), can('assignments:manage') ? h('button', { class: 'btn sm primary', onClick: assign }, '+ Assign worker') : null),
        table([{ label: 'Worker', key: 'display_name' }, { label: 'Staff role', render: a => fmt.label(a.user_role) }, { label: 'Role on case', render: a => fmt.label(a.role_on_case) }, { label: 'Start', render: a => fmt.date(a.start_date) }, { label: 'End', render: a => a.end_date ? fmt.date(a.end_date) : badge('Current', 'ok') }, { label: 'Notes', key: 'notes' }, { label: '', render: a => !a.end_date && can('assignments:manage') ? h('button', { class: 'btn sm ghost', onClick: async () => { if (await confirmDialog('End assignment', `Remove ${a.display_name} from this case?`, { okText: 'End' })) { await post(`/api/assignments/${a.id}/end`, {}); refresh(); } } }, 'End') : null }], c.assignments, { empty: 'No workers assigned.' }),
        can('clients:merge') ? h('div', { class: 'card mt' },
          h('h3', {}, 'Merge a duplicate into this record'),
          h('p', { class: 'small muted' }, 'If the same person was entered twice, merge the other record into this one. Everything attached to it — visits, calls, notes, referrals, forms — moves here, and anything this record is missing is filled in from the duplicate. The other record is kept, marked as merged, so old links still work.'),
          (() => {
            const picker = clientPicker('merge_source', '', { placeholder: 'Find the duplicate record…' });
            return h('div', {}, picker, h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: async () => {
              const sourceId = picker.value;
              if (!sourceId) { toast('Choose the duplicate record first', 'error'); return; }
              if (sourceId === id) { toast('That is this record', 'error'); return; }
              const reason = await confirmDialog('Merge duplicate', 'Everything on the other record moves onto this one. This cannot be undone from the app. Continue?', { danger: true, okText: 'Merge', requireReason: true });
              if (!reason) return;
              try { const r = await post(`/api/clients/${id}/merge`, { source_id: sourceId, reason }); toast(`Merged. ${Object.values(r.moved).filter(n => typeof n === 'number').reduce((a, b) => a + b, 0)} record(s) moved.`, 'ok'); refresh(); }
              catch (e) { toast(e.message, 'error'); }
            } }, 'Merge into this record')));
          })()) : null,
        can('clients:all') && can('clients:write') ? h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: async () => { const reason = await confirmDialog('Delete client record', 'This soft-deletes the client and hides all records. Retention rules still apply. Continue?', { danger: true, okText: 'Delete', requireReason: true }); if (reason) { await del(`/api/clients/${id}`, { reason }); toast('Client deleted'); nav('clients'); } } }, 'Delete client record')) : null);
    },
  };
  body.append(await (T[tab] || T.overview)());
  return view;
});
