import { h, route, get, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav } from '../app.js';

export async function openReferralForm(values, { clientId, clientDisplay, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  const res = (await get('/api/resources?limit=1000')).rows;
  const consents = clientId || values?.client_id ? (await get(`/api/clients/${clientId || values.client_id}/consents`)).consents.filter(c => !c.revoked_at) : [];
  const f = form([
    { name: 'client_id', label: 'Client', type: 'client', required: true, value: clientId || values?.client_id, display: clientDisplay },
    { name: 'resource_id', label: 'Resource / provider', type: 'select', required: true, options: res.map(x => ({ value: x.id, label: `${x.name} (${fmt.label(x.category)})` })) },
    { name: 'referred_at', label: 'Referral date', type: 'datetime', required: true, value: values?.referred_at || new Date().toISOString() },
    { name: 'status', label: 'Status', type: 'select', options: C.REFERRAL_STATUSES, value: 'pending', noBlank: true, required: true }, { name: 'urgency', label: 'Urgency', type: 'select', options: ['routine', 'urgent', 'emergent'], value: 'routine', noBlank: true },
    { name: 'warm_handoff', label: 'Warm handoff', type: 'checkbox' }, { name: 'appointment_at', label: 'Appointment', type: 'datetime' }, { name: 'admitted_at', label: 'Admitted / started', type: 'datetime' },
    { name: 'consent_id', label: 'Consent / ROI on file (42 CFR Part 2)', type: 'select', options: consents.map(c => ({ value: c.id, label: `${fmt.label(c.type)} → ${c.recipient || '—'} (signed ${fmt.date(c.signed_at)})` })), help: 'Sharing SUD records with the provider requires written consent.' },
    { name: 'follow_up_due', label: 'Follow-up due (creates task)', type: 'date' }, { name: 'barrier', label: 'Barrier (if any)', type: 'select', options: ['none', 'transportation', 'insurance', 'waitlist', 'no_beds', 'client_declined', 'childcare', 'documentation', 'legal', 'phone_access', 'other'] },
    { name: 'outcome', label: 'Outcome', span: true }, { name: 'notes', label: 'Notes', type: 'textarea', span: true },
  ], { values: values || {}, submitText: isNew ? 'Create referral' : 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    if (isNew) await post('/api/referrals', d); else await put(`/api/referrals/${values.id}`, d);
    toast('Referral saved', 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal(isNew ? 'New referral' : 'Edit referral', f, { wide: true });
}
export function referralTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'Date', render: r => fmt.date(r.referred_at) }, showClient ? { label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}` }, r.client_code) } : null,
    { label: 'Resource', render: r => h('div', {}, r.resource_name, h('div', { class: 'small muted' }, fmt.label(r.resource_category), r.resource_phone ? ` · ${r.resource_phone}` : '')) },
    { label: 'Status', render: r => badge(fmt.label(r.status), statusKind(r.status)) }, { label: 'Urgency', render: r => r.urgency !== 'routine' ? badge(fmt.label(r.urgency), 'danger') : '' },
    { label: 'Appt', render: r => r.appointment_at ? fmt.dt(r.appointment_at) : '—' }, { label: 'Consent', render: r => r.consent_id ? badge('ROI ✓', 'ok') : badge('No ROI', 'warn') }, { label: 'Barrier', render: r => r.barrier && r.barrier !== 'none' ? fmt.label(r.barrier) : '' }, { label: 'Worker', key: 'worker' },
    { label: '', render: r => can('referrals:write') ? h('div', { class: 'row nowrap' }, h('button', { class: 'btn sm', onClick: () => openReferralForm(r, { onDone: onChange }) }, 'Update'), (r.user_id === state.user.id || can('clients:all')) ? h('button', { class: 'btn sm ghost', onClick: async () => { if (await confirmDialog('Delete referral', 'Delete this referral?', { danger: true, okText: 'Delete' })) { await del(`/api/referrals/${r.id}`); onChange && onChange(); } } }, '✕') : null) : null },
  ].filter(Boolean), rows, { empty: 'No referrals.' });
}
route('referrals', async (r) => {
  const status = r.query.get('status') || 'open';
  const qs = `limit=300${status === 'open' ? '&open=1' : status !== 'all' ? '&status=' + status : ''}`;
  const data = await get(`/api/referrals?${qs}`);
  const refresh = () => nav(`referrals?status=${status}&_=${Date.now()}`);
  const sel = h('select', { onChange: () => nav(`referrals?status=${sel.value}`) }, [['open', 'Open (pending → scheduled)'], ['all', 'All'], ...state.constants.REFERRAL_STATUSES.map(s => [s, fmt.label(s)])].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  return h('div', {},
    pageHead('Referrals', can('referrals:write') ? h('button', { class: 'btn primary', onClick: () => openReferralForm(null, { onDone: refresh }) }, '+ New referral') : null, h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/referrals?from=2000-01-01') }, 'Export CSV')),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sel)),
    h('div', { class: 'muted small mb' }, `${data.total} referrals`), referralTable(data.rows, { onChange: refresh }));
});
