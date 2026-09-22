import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, nav, parseHash, kv, stat, clientPicker, clear, contactLinks, mapLink, openHref, tabStrip } from '../app.js';
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
  const tabs = [['overview', 'Overview'], ['timeline', 'Timeline'], ['interventions', `Interventions (${c.counts.interventions})`], ['calls', `Calls (${c.counts.calls})`], ['notes', `Notes (${c.counts.notes})`], ['referrals', `Referrals (${c.counts.referrals})`], ['forms', `Forms (${c.counts.forms || 0})`], ['tasks', `Tasks (${c.counts.open_tasks})`], ['episodes', 'Episodes'], ['consents', 'Consents & ROI'], ['requests', 'Requests'], ['time', 'Time'], can('budget:read') ? ['budget', 'Assistance $'] : null, ['team', 'Care team']].filter(Boolean);
  const body = h('div', {});
  const view = h('div', {},
    h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, c.display_name, ' ', h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '1rem' } }, c.client_code)),
      h('div', { class: 'row' }, badge(fmt.label(c.status), statusKind(c.status)), badge(`Risk: ${fmt.label(c.risk_level)}`, statusKind(c.risk_level)), c.primary_substance ? badge(fmt.label(c.primary_substance)) : null, c.mat_status && c.mat_status !== 'none' ? badge(`MAT: ${fmt.label(c.mat_status)}`, 'purple') : null, c.overdose_history ? badge('OD history', 'danger') : null, c.naloxone_provided ? badge('Naloxone ✓', 'ok') : badge('No naloxone', 'warn'), c.flags ? badge(`⚠ ${c.flags}`, 'danger') : null, c.legal_hold ? badge('Legal hold', 'purple') : null,
        // A safety plan on file is worth seeing before anything else on a bad day; the chip opens it.
        c.safety_plan ? h('button', { class: 'chip', type: 'button', 'data-safety-plan': c.safety_plan.id, title: 'Open the safety plan', onClick: async () => (await import('./notes.js')).openNote(c.safety_plan.id, { onChange: refresh }) }, `🛟 Safety plan on file (${fmt.date(c.safety_plan.occurred_at)})`) : null)),
      h('div', { class: 'row' },
        can('interventions:write') ? h('button', { class: 'btn primary', onClick: () => openInterventionForm(null, ctxOpts) }, '+ Intervention') : null,
        can('interventions:write') && c.counts.interventions ? h('button', { class: 'btn', title: 'Prefill from their most recent visit — same type, location and supplies, with today\'s date and a blank summary', onClick: () => openRepeatInterventionForm(id, disp, refresh) }, '↻ Repeat last visit') : null,
        can('calls:write') ? h('button', { class: 'btn', onClick: () => openCallForm(null, ctxOpts) }, '+ Call') : null,
        can('calls:write') ? h('button', { class: 'btn', onClick: () => openCallForm(null, { ...ctxOpts, method: 'text' }) }, '+ Text') : null,
        (can('notes:admin:write') || can('notes:clinical:write')) ? h('button', { class: 'btn', onClick: () => openNoteForm(null, ctxOpts) }, '+ Note') : null,
        can('tasks:write') ? h('button', { class: 'btn', onClick: () => openTaskForm(null, ctxOpts) }, '+ Task') : null,
        can('clients:write') ? h('button', { class: 'btn', onClick: () => openClientForm(c, refresh) }, 'Edit') : null)),
    tabStrip(tabs, tab, (k) => nav(`client/${id}/${k}`)),
    body);

  // Free text such as "Rosa (sister) 555-0134" gets its number turned into a tel: link.
  const linkifyPhones = (text) => {
    if (!text) return null;
    const parts = String(text).split(/(\+?\d[\d\-\s().]{6,}\d)/);
    return parts.length > 1 ? h('span', {}, parts.map((x, i) => (i % 2 ? contactLinks(x.trim()) : x))) : text;
  };
  // Tap the number to call or text; the buttons also open the log so the contact is recorded straight after.
  const phoneRow = (phone) => {
    if (!phone) return null;
    const logAfter = (method) => { openHref(`${method === 'text' ? 'sms' : 'tel'}:${String(phone).replace(/[^\d+]/g, '')}`); if (can('calls:write')) openCallForm(null, { ...ctxOpts, method, prefill: { phone, contact_type: 'client', direction: 'outbound' } }); };
    return h('span', { class: 'row', style: { gap: '.4rem', display: 'inline-flex' } }, contactLinks(phone),
      can('calls:write') ? h('button', { class: 'btn sm', type: 'button', 'data-call': phone, onClick: () => logAfter('phone') }, '☎ Call') : null,
      can('calls:write') && c.ok_to_text !== 0 ? h('button', { class: 'btn sm', type: 'button', 'data-text': phone, onClick: () => logAfter('text') }, '💬 Text') : null);
  };

  const T = {
    async overview() {
      const age = c.dob ? Math.floor((Date.now() - Date.parse(c.dob)) / (365.25 * 86400000)) : null;
      return h('div', { class: 'grid cols-2' },
        h('div', { class: 'card' }, h('h3', {}, 'Identity & contact'), kv([['Name', `${c.first_name} ${c.last_name}${c.preferred_name ? ` ("${c.preferred_name}")` : ''}`], ['DOB', c.dob ? `${fmt.date(c.dob)} (${age})` : null], ['Gender / pronouns', [c.gender && fmt.label(c.gender), c.pronouns].filter(Boolean).join(' · ')], ['Phone', c.phone || c.alt_phone ? h('div', { class: 'row', style: { gap: '.5rem' } }, phoneRow(c.phone), c.alt_phone ? h('span', {}, h('span', { class: 'muted small' }, 'alt: '), phoneRow(c.alt_phone)) : null) : null], ['Email', c.email ? h('a', { href: `mailto:${c.email}` }, c.email) : null], ['Address', mapLink([c.address, c.city, c.zip].filter(Boolean).join(', '))], ['Language', c.preferred_language], ['Contact rules', [c.ok_to_text ? 'OK to text' : null, c.ok_to_voicemail ? 'OK to voicemail' : null, c.contact_preferences].filter(Boolean).join(' · ') || 'Not recorded — ask before texting or leaving a voicemail'], ['Emergency contact', linkifyPhones(c.emergency_contact)], ['Housing', c.housing_status && fmt.label(c.housing_status)], ['Insurance', [c.insurance && fmt.label(c.insurance), c.medicaid_id && `ID ${c.medicaid_id}`].filter(Boolean).join(' · ')], ['Veteran', c.veteran ? 'Yes' : 'No']])),
        h('div', { class: 'card' }, h('h3', {}, 'Substance use & clinical'), kv([['Primary substance', fmt.label(c.primary_substance)], ['Secondary', c.secondary_substances], ['Route', c.route_of_use && fmt.label(c.route_of_use)], ['ASAM level', c.asam_level], ['MAT', [c.mat_status && fmt.label(c.mat_status), c.mat_medication && fmt.label(c.mat_medication)].filter(Boolean).join(' — ')], ['Overdose history', c.overdose_history ? `Yes${c.last_overdose_date ? ', last ' + fmt.date(c.last_overdose_date) : ''}` : 'No'], ['Naloxone', c.naloxone_provided ? `Provided${c.naloxone_last_date ? ' ' + fmt.date(c.naloxone_last_date) : ''}` : 'Not provided'], ['Co-occurring MH', c.co_occurring_mh ? 'Yes' : 'No'], ['Justice involved', c.justice_involved ? 'Yes' : 'No'], ['Pregnant / parenting', c.pregnant_or_parenting ? 'Yes' : 'No'], ['Goals', c.goals]])),
        h('div', { class: 'card' }, h('h3', {}, 'Program'), kv([['Status', fmt.label(c.status)], ['Intake', fmt.date(c.intake_date)], ['Referral source', c.referral_source && fmt.label(c.referral_source)], ['Referral date', c.referral_date && fmt.date(c.referral_date)], ['Engagement date', c.engagement_date && fmt.date(c.engagement_date)],
          ['Time until engaged', c.days_to_engagement === null ? (c.referral_date || c.engagement_date ? h('span', { class: 'muted' }, 'needs both dates') : null) : h('span', { style: c.days_to_engagement < 0 ? { color: 'var(--danger)' } : {} }, `${c.days_to_engagement} day${Math.abs(c.days_to_engagement) === 1 ? '' : 's'}`)],
          ['Episode', c.open_episode ? h('a', { href: `#/client/${id}/episodes` }, 'Open — ', c.counts.episodes > 1 ? `${c.counts.episodes} episodes` : 'first episode') : c.counts.episodes ? h('a', { href: `#/client/${id}/episodes`, style: { color: 'var(--warn)' } }, 'Discharged — re-admit on the Episodes tab') : h('a', { href: `#/client/${id}/episodes`, style: { color: 'var(--warn)' } }, 'None open — start one on the Episodes tab')],
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
    async notes() {
      const d = await get(`/api/notes?client_id=${id}&limit=500`);
      // An administrator holds break-glass but had nowhere to use it except a note link they could not see.
      const breakGlass = !can('notes:clinical:read') && can('notes:clinical:breakglass') ? h('button', { class: 'btn sm danger', onClick: async () => {
        const reason = await confirmDialog('Break-glass access', 'Clinical notes are outside your normal role. Emergency access is permitted only with a documented reason and is reported to the privacy officer.', { danger: true, okText: 'Show clinical notes', requireReason: true });
        if (!reason) return;
        const cl = await get(`/api/notes?client_id=${id}&kind=clinical&limit=500`, { headers: { 'X-Break-Glass-Reason': reason } });
        const box = document.getElementById('breakglass-notes'); clear(box).append(h('h4', {}, 'Clinical notes (emergency access — logged)'), noteTable(cl.rows, { showClient: false, onChange: refresh }));
      } }, 'Emergency access to clinical notes') : null;
      return h('div', {}, !can('notes:clinical:read') ? h('div', { class: 'banner small' }, 'Clinical notes are hidden from your role. ', breakGlass) : null, noteTable(d.rows, { showClient: false, onChange: refresh }), h('div', { id: 'breakglass-notes', class: 'mt' }));
    },
    async referrals() { const d = await get(`/api/referrals?client_id=${id}&limit=500`); return h('div', {}, h('div', { class: 'row mb' }, can('referrals:write') ? h('button', { class: 'btn primary', onClick: () => openReferralForm(null, ctxOpts) }, '+ New referral') : null), referralTable(d.rows, { showClient: false, onChange: refresh })); },
    async tasks() { const d = await get(`/api/tasks?client_id=${id}&limit=500`); return taskTable(d.rows, { showClient: false, onChange: refresh }); },
    async time() { const d = await get(`/api/time?client_id=${id}&limit=500`); return h('div', {}, h('div', { class: 'row mb' }, can('time:write') ? h('button', { class: 'btn primary', onClick: () => openTimeForm(null, ctxOpts) }, '+ Log time') : null), timeTable(d.rows, { showClient: false, onChange: refresh })); },
    async budget() { const d = await get(`/api/budget/expenditures?client_id=${id}&limit=500`); return h('div', {}, h('div', { class: 'row mb' }, can('budget:write') ? h('button', { class: 'btn primary', onClick: () => openExpenditureForm(null, ctxOpts) }, '+ Record client assistance') : null, h('span', { class: 'muted' }, `Total approved: ${fmt.money(c.counts.spent)}`)), expenditureTable(d.rows, { showClient: false, onChange: refresh })); },
    async forms() { return (await import('./forms.js')).clientFormsTab(id, { refresh }); },
    async episodes() { return (await import('./episodes.js')).episodesPanel(id, { onChange: refresh }); },
    async consents() {
      const d = await get(`/api/clients/${id}/consents`); const C = state.constants;
      // Every element 42 CFR §2.31 requires of a Part 2 consent is on the form and marked; the server refuses a
      // part2_disclosure consent that lacks any of them.
      const P2 = ' (required for Part 2)';
      const addConsent = () => { const f = form([{ name: 'type', label: 'Consent type', type: 'select', options: C.CONSENT_TYPES, required: true }, { name: 'signed_at', label: 'Signed', type: 'date', required: true, value: fmt.today() }, { name: 'expires_at', label: 'Expires on' + P2, type: 'date', help: 'Or name the event below.' }, { name: 'expires_event', label: 'Or expires on this event', placeholder: 'e.g. discharge from the program' }, { name: 'recipient', label: 'Recipient (who may receive info)' + P2, span: true }, { name: 'purpose', label: 'Purpose of disclosure' + P2, span: true }, { name: 'scope', label: 'Information covered' + P2, type: 'textarea', span: true, rows: 2 }, { name: 'witness', label: 'Witness' }, { name: 'document_ref', label: 'Document location / scan ref' }, { name: 'signed_on_paper', label: 'Signed on paper (Part 2 needs this, a witness or a document reference)', type: 'checkbox', span: true }, { name: 'redisclosure_notice_given', label: 'The client was given the prohibition-on-redisclosure notice (§2.32)' + P2, type: 'checkbox', span: true }], { submitText: 'Record consent', onCancel: () => m.close(), onSubmit: async (v) => { await post(`/api/clients/${id}/consents`, v); toast('Consent recorded', 'ok'); m.close(); refresh(); } }); const m = modal('Record consent / release of information', h('div', {}, h('div', { class: 'banner small' }, '42 CFR Part 2: a written consent must name the recipient, purpose and information to be disclosed, say when it expires (a date or an event), show that it was signed, and the client must be told that what is shared may not be redisclosed.'), f)); };
      const addDisclosure = () => { const f = form([{ name: 'basis', label: 'Legal basis', type: 'select', options: ['consent', 'medical_emergency', 'court_order', 'qsoa', 'audit_evaluation', 'research', 'crime_on_premises', 'child_abuse_report', 'other'], value: 'consent', noBlank: true, required: true }, { name: 'consent_id', label: 'Consent relied on', type: 'select', options: d.consents.filter(x => !x.revoked_at).map(x => ({ value: x.id, label: `${fmt.label(x.type)} → ${x.recipient || '—'} (${fmt.date(x.signed_at)})` })) }, { name: 'disclosed_at', label: 'Date disclosed', type: 'datetime', required: true, value: new Date().toISOString() }, { name: 'method', label: 'Method', type: 'select', options: ['verbal', 'phone', 'fax', 'secure_email', 'portal', 'paper', 'in_person'] }, { name: 'disclosed_to', label: 'Disclosed to', required: true, span: true }, { name: 'purpose', label: 'Purpose', required: true, span: true }, { name: 'info_disclosed', label: 'Information disclosed', type: 'textarea', required: true, span: true, rows: 2 }, { name: 'justification', label: 'Justification (required for a medical emergency, and for "other")', type: 'textarea', span: true, rows: 2, help: 'At least 20 characters. "Other" may only be recorded by a supervisor or administrator. Stored encrypted with the disclosure.' }], { submitText: 'Record disclosure', onCancel: () => m.close(), onSubmit: async (v) => { await post(`/api/clients/${id}/disclosures`, v); toast('Disclosure recorded', 'ok'); m.close(); refresh(); } }); const m = modal('Record a disclosure', f); };
      // The accounting a client may ask for (§164.528): one printable page, produced (and audited) on demand.
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
      const printAccounting = async () => {
        const a = await get(`/api/clients/${id}/disclosures/accounting`);
        const rows = a.disclosures.map(x => `<tr><td>${esc(fmt.dt(x.disclosed_at))}</td><td>${esc(x.recipient)}</td><td>${esc(x.purpose)}</td><td>${esc(x.what)}</td><td>${esc(fmt.label(x.basis))}${x.justification ? '<br><small>' + esc(x.justification) + '</small>' : ''}</td><td>${esc(x.method || '')}</td><td>${esc(x.disclosed_by_name)}</td></tr>`).join('');
        const cons = a.consents.map(x => `<tr><td>${esc(fmt.label(x.type))}</td><td>${esc(x.recipient || '')}</td><td>${esc(x.purpose || '')}</td><td>${esc(fmt.date(x.signed_at))}</td><td>${esc(x.expires_at ? fmt.date(x.expires_at) : (x.expires_event || '—'))}</td><td>${x.revoked_at ? 'Revoked ' + esc(fmt.date(x.revoked_at)) : ''}</td></tr>`).join('');
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Accounting of disclosures — ${esc(a.client_code)}</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%;font-size:.85rem;margin-bottom:1.5rem}th,td{border:1px solid #999;padding:.3rem .5rem;text-align:left;vertical-align:top}h1{font-size:1.3rem}p{font-size:.85rem}</style></head><body>
<h1>Accounting of disclosures — client ${esc(a.client_code)}</h1>
<p>Name: ${esc(c.display_name)}. Generated ${esc(fmt.dt(a.generated_at))} by ${esc(state.user.display_name)}. Covers every disclosure of this client's information recorded by the program (HIPAA §164.528; 42 CFR §2.13). Contains information protected by federal confidentiality rules (42 CFR Part 2); redisclosure is prohibited without the client's written consent.</p>
<h2>Disclosures (${a.disclosures.length})</h2><table><tr><th>Date</th><th>To</th><th>Purpose</th><th>What</th><th>Basis</th><th>Method</th><th>By</th></tr>${rows || '<tr><td colspan="7">None recorded.</td></tr>'}</table>
<h2>Consents relied on (${a.consents.length})</h2><table><tr><th>Type</th><th>Recipient</th><th>Purpose</th><th>Signed</th><th>Expires</th><th>Status</th></tr>${cons || '<tr><td colspan="6">None recorded.</td></tr>'}</table></body></html>`;
        const w = window.open('', '_blank');
        if (!w) { toast('Allow pop-ups to print the accounting', 'error'); return; }
        w.document.open(); w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
      };
      const revokedRefs = (d.consents || []).some(x => x.revoked_at);
      return h('div', { class: 'grid cols-2' },
        revokedRefs ? h('div', { class: 'banner warn span', role: 'status', style: { gridColumn: '1 / -1' } },
          'A consent on this client has been revoked. Any referral that relied on it is flagged — stop sharing information under it and close those referrals out.') : null,
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Consents & releases'), can('consents:write') ? h('button', { class: 'btn sm primary', onClick: addConsent }, '+ Consent') : null),
          table([{ label: 'Type', render: x => fmt.label(x.type) }, { label: 'Recipient', key: 'recipient' }, { label: 'Purpose', key: 'purpose' }, { label: 'Signed', render: x => fmt.date(x.signed_at) }, { label: 'Expires', render: x => x.expires_at ? h('span', { style: Date.parse(x.expires_at) < Date.now() ? { color: 'var(--danger)' } : {} }, fmt.date(x.expires_at)) : '—' }, { label: 'Status', render: x => x.revoked_at ? badge('Revoked', 'danger') : (x.expires_at && Date.parse(x.expires_at) < Date.now()) ? badge('Expired', 'warn') : badge('Active', 'ok') },
            { label: '', render: x => !x.revoked_at && can('consents:write') ? h('button', { class: 'btn sm ghost', onClick: async () => { const reason = await confirmDialog('Revoke consent', 'Record that the client revoked this consent?', { danger: true, okText: 'Revoke', requireReason: true }); if (reason) { await post(`/api/consents/${x.id}/revoke`, { reason }); refresh(); } } }, 'Revoke') : null }], d.consents, { empty: 'No consents on file. SUD records cannot be shared without written consent.' })),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Accounting of disclosures'), h('div', { class: 'row' }, h('button', { class: 'btn sm', 'data-print-accounting': '1', onClick: printAccounting }, 'Print accounting'), can('consents:write') ? h('button', { class: 'btn sm primary', onClick: addDisclosure }, '+ Disclosure') : null)),
          table([{ label: 'Date', render: x => fmt.dt(x.disclosed_at) }, { label: 'To', key: 'recipient' }, { label: 'Purpose', key: 'purpose' }, { label: 'What', key: 'what' }, { label: 'Basis', render: x => h('span', {}, fmt.label(x.basis), x.justification ? h('div', { class: 'small muted' }, x.justification) : null) }, { label: 'How it was recorded', render: x => fmt.label(x.source || 'manual') }, { label: 'By', key: 'disclosed_by_name' }], d.disclosures, { empty: 'No disclosures recorded. Every time identifiable information leaves this program, it is recorded here.' })));
    },
    // Patient-rights requests: access, amendment, restriction, accounting — each on a 30-day clock.
    async requests() {
      const d = await get(`/api/patient-requests?client_id=${id}&status=all&limit=200`);
      const KINDS = [{ value: 'access', label: 'Access to their record (§164.524)' }, { value: 'amendment', label: 'Amendment of their record (§164.526)' }, { value: 'restriction', label: 'Restriction on use or disclosure (§164.522)' }, { value: 'accounting', label: 'Accounting of disclosures (§164.528)' }];
      const add = () => { const f = form([{ name: 'kind', label: 'Request', type: 'select', options: KINDS, required: true, noBlank: true }, { name: 'received_at', label: 'Received on', type: 'date', required: true, value: fmt.today() }, { name: 'notes', label: 'What was asked for, and how', type: 'textarea', span: true, rows: 3, help: 'Stored encrypted.' }], { submitText: 'Record request', onCancel: () => m.close(), onSubmit: async (v) => { await post('/api/patient-requests', { ...v, client_id: id }); toast('Request recorded — due in 30 days', 'ok'); m.close(); refresh(); } }); const m = modal('Record a patient request', f); };
      const close = async (x, status) => { const note = await confirmDialog(status === 'fulfilled' ? 'Mark fulfilled' : 'Mark denied', status === 'fulfilled' ? 'Record how the request was fulfilled.' : 'Record the reason for denial (the client is entitled to it in writing).', { okText: status === 'fulfilled' ? 'Fulfilled' : 'Denied', danger: status === 'denied', requireReason: true }); if (!note) return; await put(`/api/patient-requests/${x.id}`, { status, notes: [x.notes, `${status === 'fulfilled' ? 'Fulfilled' : 'Denied'} ${fmt.today()}: ${note}`].filter(Boolean).join('\n') }); refresh(); };
      return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Patient-rights requests'), can('patient-requests:write') ? h('button', { class: 'btn sm primary', 'data-add-request': '1', onClick: add }, '+ Request') : null),
        h('p', { class: 'small muted' }, 'A client may ask to see their record, have it corrected, restrict how it is shared, or receive the accounting of disclosures. Each must be answered within 30 days of receipt.'),
        table([{ label: 'Request', render: x => fmt.label(x.kind) }, { label: 'Received', render: x => fmt.date(x.received_at) }, { label: 'Due', render: x => h('span', { style: x.overdue ? { color: 'var(--danger)', fontWeight: 600 } : {} }, fmt.date(x.due_at), x.overdue ? ' — overdue' : '') }, { label: 'Status', render: x => badge(fmt.label(x.status), x.status === 'open' ? (x.overdue ? 'danger' : 'warn') : x.status === 'fulfilled' ? 'ok' : '') }, { label: 'Notes', render: x => h('div', { style: { whiteSpace: 'pre-wrap' } }, x.notes || '') }, { label: 'Handled by', key: 'handler' },
          { label: '', render: x => x.status === 'open' && can('patient-requests:write') ? h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onClick: () => close(x, 'fulfilled') }, 'Fulfilled'), h('button', { class: 'btn sm', onClick: () => close(x, 'denied') }, 'Denied')) : null }], d.rows, { empty: 'No requests recorded for this client.' }));
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
        can('clients:legal-hold') || c.legal_hold ? h('div', { class: 'card mt' },
          h('h3', {}, 'Legal hold'),
          c.legal_hold ? h('p', {}, badge('On hold', 'purple'), ' ', c.legal_hold_reason || '', h('span', { class: 'small muted' }, ' — this record cannot be deleted and is exempt from the retention purge until the hold is cleared.')) : h('p', { class: 'small muted' }, 'Not on hold. Records are purged automatically once they pass the retention period set in Administration; a hold (litigation, an investigation, a client request) stops that.'),
          can('clients:legal-hold') ? h('div', { class: 'btn-row' }, c.legal_hold
            ? h('button', { class: 'btn', onClick: async () => { if (await confirmDialog('Clear legal hold', 'The record becomes subject to retention rules again.', { okText: 'Clear hold' })) { await post(`/api/clients/${id}/legal-hold`, { hold: false }); toast('Legal hold cleared', 'ok'); refresh(); } } }, 'Clear hold')
            : h('button', { class: 'btn', onClick: async () => { const reason = await confirmDialog('Place legal hold', 'Name the matter or request this hold relates to.', { okText: 'Place hold', requireReason: true }); if (reason) { await post(`/api/clients/${id}/legal-hold`, { hold: true, reason }); toast('Legal hold placed', 'ok'); refresh(); } } }, 'Place legal hold')) : null) : null,
        can('clients:all') && can('clients:write') ? h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onClick: async () => { const reason = await confirmDialog('Delete client record', 'This soft-deletes the client and hides all records. Retention rules still apply. Continue?', { danger: true, okText: 'Delete', requireReason: true }); if (reason) { await del(`/api/clients/${id}`, { reason }); toast('Client deleted'); nav('clients'); } } }, 'Delete client record')) : null);
    },
  };
  body.append(await (T[tab] || T.overview)());
  return view;
});
