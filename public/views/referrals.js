import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav } from '../app.js';

export async function openReferralForm(values, { clientId, clientDisplay, resourceId, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  const res = (await get('/api/resources?limit=1000')).rows;
  const consents = clientId || values?.client_id ? (await get(`/api/clients/${clientId || values.client_id}/consents`)).consents.filter(c => !c.revoked_at) : [];
  const f = form([
    { name: 'client_id', label: 'Client', type: 'client', required: true, value: clientId || values?.client_id, display: clientDisplay },
    { name: 'resource_id', label: 'Resource / provider', type: 'select', required: true, value: resourceId || values?.resource_id, options: res.map(x => ({ value: x.id, label: `${x.name} (${fmt.label(x.category)})` })) },
    { name: 'referred_at', label: 'Referral date', type: 'datetime', required: true, value: values?.referred_at || new Date().toISOString() },
    { name: 'status', label: 'Status', type: 'select', options: C.REFERRAL_STATUSES, value: 'pending', noBlank: true, required: true }, { name: 'urgency', label: 'Urgency', type: 'select', options: ['routine', 'urgent', 'emergent'], value: 'routine', noBlank: true },
    { name: 'warm_handoff', label: 'Warm handoff', type: 'checkbox' }, { name: 'appointment_at', label: 'Appointment', type: 'datetime' }, { name: 'admitted_at', label: 'Admitted / started', type: 'datetime' },
    { name: 'consent_id', label: 'Consent / ROI on file (42 CFR Part 2)', type: 'select', options: consents.map(c => ({ value: c.id, label: `${fmt.label(c.type)} → ${c.recipient || '—'} (signed ${fmt.date(c.signed_at)})` })),
      help: 'Required before the provider is told who this client is. A referral left as "pending" with no warm handoff — just a phone number handed to the client — needs none.' },
    { name: '_disclosure_basis', label: 'If there is no consent, the lawful basis', type: 'select',
      options: [{ value: 'medical_emergency', label: 'Medical emergency' }, { value: 'court_order', label: 'Court order' }, { value: 'qsoa', label: 'Qualified service organisation agreement' }, { value: 'child_abuse_report', label: 'Mandated child abuse report' }, { value: 'crime_on_premises', label: 'Crime on the premises' }, { value: 'other', label: 'Other (explain in notes)' }],
      help: 'Leave empty unless you are relying on something other than the client\'s written consent. Whatever you choose is recorded in the accounting of disclosures.' },
    { name: '_disclosure_what', label: 'What is being shared', placeholder: 'Referral information (name, contact details and presenting need)', span: true },
    { name: 'follow_up_due', label: 'Follow-up due', type: 'date', help: 'A follow-up to-do is created either way; leave this empty and one is set for you based on urgency.' }, { name: 'barrier', label: 'Barrier (if any)', type: 'select', options: ['none', 'transportation', 'insurance', 'waitlist', 'no_beds', 'client_declined', 'childcare', 'documentation', 'legal', 'phone_access', 'other'] },
    { name: 'outcome', label: 'Outcome', span: true }, { name: 'notes', label: 'Notes', type: 'textarea', span: true },
  ], { values: values || {}, submitText: isNew ? 'Create referral' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    try {
      if (isNew) await post('/api/referrals', d); else await put(`/api/referrals/${values.id}`, d);
    } catch (e) {
      // The commonest failure by far is sharing without a consent on file; say what to do about it.
      if (/consent/i.test(e.message || '')) throw new Error(e.message + ' Record the release on the client\'s Consents tab, or choose a lawful basis above.');
      throw e;
    }
    toast('Referral saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? 'New referral' : 'Edit referral', f, { wide: true });
}
/** Close the loop: what happened, and were they admitted? This is what makes referrals reportable. */
export function openOutcomeForm(r, onDone) {
  const C = state.constants;
  const f = form([
    { name: 'status', label: 'What happened', type: 'select', noBlank: true, required: true, value: r.status, options: C.REFERRAL_STATUSES },
    { name: 'admitted_at', label: 'Admitted / started on', type: 'datetime', value: r.admitted_at || '' },
    { name: 'barrier', label: 'If it did not happen, why', type: 'select', options: ['none', 'transportation', 'insurance', 'waitlist', 'no_beds', 'client_declined', 'childcare', 'documentation', 'legal', 'phone_access', 'other'], value: r.barrier || '' },
    { name: 'outcome', label: 'Outcome in your words', type: 'textarea', span: true, value: r.outcome || '' },
  ], { submitText: 'Record outcome', onCancel: () => m.close(), onSubmit: async (d) => {
    const res = await post(`/api/referrals/${r.id}/outcome`, d);
    toast(res.admitted ? 'Recorded — counted as an admission' : 'Outcome recorded', 'ok');
    m.close(); onDone && onDone();
  } });
  const m = modal(`Referral to ${r.resource_name}`, h('div', {},
    h('p', { class: 'small muted' }, 'Recording the outcome closes the follow-up to-do and lets the programme answer how many warm handoffs actually resulted in an admission.'), f));
  return m;
}

export function referralTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'Date', render: r => fmt.date(r.referred_at) }, showClient ? { label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}` }, r.client_code) } : null,
    { label: 'Resource', render: r => h('div', {}, r.resource_name, h('div', { class: 'small muted' }, fmt.label(r.resource_category), r.resource_phone ? ` · ${r.resource_phone}` : '')) },
    { label: 'Status', render: r => badge(fmt.label(r.status), statusKind(r.status)) }, { label: 'Urgency', render: r => r.urgency !== 'routine' ? badge(fmt.label(r.urgency), 'danger') : '' },
    { label: 'Appt', render: r => r.appointment_at ? fmt.dt(r.appointment_at) : '—' }, { label: 'Consent', render: r => r.consent_revoked ? badge('Consent revoked', 'danger') : r.consent_id ? badge('ROI ✓', 'ok') : badge('No ROI', 'warn') }, { label: 'Barrier', render: r => r.barrier && r.barrier !== 'none' ? fmt.label(r.barrier) : '' }, { label: 'Worker', key: 'worker' },
    { label: 'Outcome', render: r => (r.outcome_recorded_at ? badge('Recorded', 'ok') : badge('Not yet', 'warn')) },
    { label: '', render: r => can('referrals:write') ? h('div', { class: 'row nowrap' },
      !r.outcome_recorded_at ? h('button', { class: 'btn sm primary', onClick: () => openOutcomeForm(r, onChange) }, 'Record outcome') : null,
      h('button', { class: 'btn sm', onClick: () => openReferralForm(r, { onDone: onChange }) }, 'Update'), (r.user_id === state.user.id || can('clients:all')) ? h('button', { class: 'btn sm ghost', onClick: async () => { if (await confirmDialog('Delete referral', 'Delete this referral?', { danger: true, okText: 'Delete' })) { await del(`/api/referrals/${r.id}`); onChange && onChange(); } } }, '✕') : null) : null },
  ].filter(Boolean), rows, { empty: 'No referrals.' });
}
route('referrals', async (r) => {
  const status = r.query.get('status') || 'open';
  const qs = `limit=300${status === 'open' ? '&open=1' : status !== 'all' ? '&status=' + status : ''}`;
  const data = await get(`/api/referrals?${qs}`);
  const refresh = () => nav(`referrals?status=${status}&_=${Date.now()}`);
  const sel = h('select', { onChange: () => nav(`referrals?status=${sel.value}`) }, [['open', 'Open (pending → scheduled)'], ['all', 'All'], ...state.constants.REFERRAL_STATUSES.map(s => [s, fmt.label(s)])].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  return h('div', {},
    pageHead('Referrals', can('referrals:write') ? h('button', { class: 'btn primary', onClick: () => openReferralForm(null, { onDone: refresh }) }, '+ New referral') : null, h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/referrals?from=2000-01-01&format=xlsx') }, 'Export to Excel')),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sel)),
    h('div', { class: 'muted small mb' }, `${data.total} referrals`), referralTable(data.rows, { onChange: refresh }));
});
