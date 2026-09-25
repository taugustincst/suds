import { h, route, get, pagedList, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav, listFilterOptions } from '../app.js';
// A court order is recorded, and disclosed under, on the client's Consents tab (it has to name the order),
// so it is not one of the bases offered here.
import { withRestrictionCheck, consentTypeLabel } from './part2.js';

export async function openReferralForm(values, { clientId, clientDisplay, resourceId, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  const theClientId = clientId || values?.client_id;
  // Two independent reads — the provider directory and this client's consents — so fetch them together
  // rather than one after the other; on a slow connection in the field that's the difference between one
  // round trip and two before the modal is usable.
  const [resResult, consentsResult] = await Promise.all([
    get('/api/resources?limit=1000'),
    theClientId ? get(`/api/clients/${theClientId}/consents`) : Promise.resolve({ consents: [] }),
  ]);
  const res = resResult.rows;
  // A phone that has not synced yet has an empty directory, and a provider nobody has entered is not a
  // reason to abandon the referral: the picker can add one without leaving this form.
  const canAdd = can('resources:write');
  const resourceLabel = (x) => `${x.name}${x.city ? ` — ${x.city}` : ''} (${fmt.label(x.category)})`;
  const ADD = '__add_resource__';
  // A consent that has run out authorises nothing: it is not offered, and if none is left the form says
  // so and points at where to record one rather than presenting an empty list.
  const today = fmt.today();
  // Recomputed whenever the client changes: a referral started from a provider's page has no client yet,
  // and the consents are only known once one is picked (the list used to stay empty, and saving then
  // asked for a consent the client already had).
  let consentState;
  const consentStateFor = (clientId, list) => {
    const all = (list || []).filter(c => !c.revoked_at);
    const valid = all.filter(c => !c.expires_at || c.expires_at >= today);
    return { clientId, all, valid, expiredOnly: !!(clientId && !valid.length && all.length) };
  };
  const consentOption = (c) => ({ value: c.id, label: `${consentTypeLabel(c.type)} → ${c.recipient || '—'} (signed ${fmt.date(c.signed_at)}${c.expires_at ? `, expires ${fmt.date(c.expires_at)}` : ''})` });
  const consentHelpContent = ({ clientId, all, valid, expiredOnly }) => valid.length ? ['Required before the provider is told who this client is. A referral left as "pending" with no warm handoff — just a phone number handed to the client — needs none.']
    : clientId ? [expiredOnly ? `${all.length === 1 ? 'The consent on file has' : 'All consents on file have'} expired. ` : 'No consent is on file. ', h('a', { href: `#/client/${clientId}/consents`, 'data-add-consent': '1', onClick: () => m.close() }, 'Record a new release on the Consents tab'), ' before the provider is told who this client is.']
    : ['Choose the client first to see their consents on file.'];
  consentState = consentStateFor(theClientId, consentsResult.consents);
  const consents = consentState.valid; const expiredOnly = consentState.expiredOnly;
  const consentHelp = h('span', { 'data-consent-help': '1' }, consentHelpContent(consentState));
  const f = form([
    { name: 'client_id', label: 'Client', type: 'client', required: true, value: clientId || values?.client_id, display: clientDisplay },
    { name: 'resource_id', label: 'Resource / provider', type: 'select', required: true, value: resourceId || values?.resource_id,
      options: [...res.map(x => ({ value: x.id, label: resourceLabel(x) })), ...(canAdd ? [{ value: ADD, label: '＋ Add a provider that is not on this list…' }] : [])],
      help: res.length ? null
        : canAdd ? 'Your directory is empty — on a phone it fills up when you sync with the office. Choose "Add a provider" to enter this one now; it will sync back.'
        : 'Your directory is empty. Sync with the office to download it, or ask someone who can edit the directory to add this provider.' },
    { name: 'referred_at', label: 'Referral date', type: 'datetime', required: true, value: values?.referred_at || new Date().toISOString() },
    { name: 'status', label: 'Status', type: 'select', list: 'REFERRAL_STATUSES', value: 'pending', noBlank: true, required: true }, { name: 'urgency', label: 'Urgency', type: 'select', options: ['routine', 'urgent', 'emergent'], value: 'routine', noBlank: true },
    { name: 'warm_handoff', label: 'Warm handoff', type: 'checkbox' }, { name: 'appointment_at', label: 'Appointment', type: 'datetime' }, { name: 'admitted_at', label: 'Admitted / started', type: 'datetime' },
    { name: 'consent_id', label: 'Consent / ROI on file (42 CFR Part 2)', type: 'select', placeholder: expiredOnly ? '(expired)' : undefined, options: consents.map(consentOption),
      help: consentHelp },
    { name: '_disclosure_basis', label: 'If there is no consent, the lawful basis', type: 'select',
      options: [{ value: 'medical_emergency', label: 'Medical emergency' }, { value: 'qsoa', label: 'Qualified service organisation agreement' }, { value: 'child_abuse_report', label: 'Mandated child abuse report' }, { value: 'crime_on_premises', label: 'Crime on the premises' }, { value: 'other', label: 'Other (explain in notes)' }],
      help: 'Leave empty unless you are relying on something other than the client\'s written consent. Whatever you choose is recorded in the accounting of disclosures.' },
    { name: '_disclosure_justification', label: 'Why sharing without consent is lawful', type: 'textarea', rows: 2, span: true, help: 'Required (at least 20 characters) for a medical emergency, and for "other" — which only a supervisor or administrator may use. Kept, encrypted, with the disclosure record.' },
    { name: '_disclosure_what', label: 'What is being shared', placeholder: 'Referral information (name, contact details and presenting need)', span: true },
    { name: 'follow_up_due', label: 'Follow-up due', type: 'date', help: 'A follow-up to-do is created either way; leave this empty and one is set for you based on urgency.' }, { name: 'barrier', label: 'Barrier (if any)', type: 'select', list: 'REFERRAL_BARRIERS' },
    { name: 'outcome', label: 'Outcome', span: true }, { name: 'notes', label: 'Notes', type: 'textarea', span: true },
  ], { values: values || {}, submitText: isNew ? 'Create referral' : 'Save', draftKey: isNew ? 'referral:new' : `referral:${values.id}`, onCancel: () => m.close(), onSubmit: async (d) => {
    try {
      // An agreed restriction on the client's record is checked with the worker before anything is sent.
      await withRestrictionCheck((extra) => (isNew ? post('/api/referrals', { ...d, ...extra }) : put(`/api/referrals/${values.id}`, { ...d, ...extra, if_updated_at: values.updated_at })), '_restriction_reviewed');
    } catch (e) {
      // The commonest failure by far is sharing without a consent; say what to do about it, once (the
      // server's message already ends in its own advice, and appending ours repeated it).
      if (/valid, unexpired consent/i.test(e.message || '')) {
        const err = new Error(consentState.valid.length
          ? 'Choose the client\'s consent under "Consent / ROI on file" before the provider is told who this client is — or, if you are relying on something else, choose the lawful basis.'
          : 'This client has no valid consent on file. Record the release on the client\'s Consents tab, or choose a lawful basis above.');
        err.status = e.status; err.data = e.data; throw err;
      }
      throw e;
    }
    toast('Referral saved', 'ok'); m.close(); onDone && onDone();
  } });
  // "Add a provider" is an option in the list rather than a button, because on a phone the list is where
  // someone looks when the provider they want is not there.
  const sel = f.inputs.resource_id;
  let last = sel.value;
  sel.addEventListener('change', async () => {
    if (sel.value !== ADD) { last = sel.value; return; }
    sel.value = last;
    const { openResourceForm } = await import('./resources.js');
    openResourceForm(null, async (id) => {
      try {
        const added = (await get(`/api/resources/${id}`)).row;
        sel.insertBefore(h('option', { value: id }, resourceLabel(added)), sel.querySelector(`option[value="${ADD}"]`));
      } catch { sel.insertBefore(h('option', { value: id }, 'New provider'), sel.querySelector(`option[value="${ADD}"]`)); }
      sel.value = id; last = id;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      toast('Provider added — carry on with the referral', 'ok');
    });
  });
  // Picking (or changing) the client reloads that client's consents into the list and its help text.
  const consentSel = f.inputs.consent_id;
  const consentHelpEl = consentSel.closest('.field')?.querySelector('.help');
  const rebuildConsents = (st) => {
    consentState = st;
    const keep = consentSel.value;
    while (consentSel.firstChild) consentSel.firstChild.remove();
    consentSel.append(h('option', { value: '' }, st.expiredOnly ? '(expired)' : '—'), ...st.valid.map(c => { const o = consentOption(c); return h('option', { value: o.value }, o.label); }));
    // Never chosen for the worker: whether this referral discloses anything at all is their call.
    consentSel.value = st.valid.some(c => c.id === keep) ? keep : '';
    if (consentHelpEl) { while (consentHelpEl.firstChild) consentHelpEl.firstChild.remove(); consentHelpEl.append(h('span', { 'data-consent-help': '1' }, consentHelpContent(st))); }
  };
  let seq = 0;
  f.inputs.client_id.addEventListener('change', async () => {
    const id = f.inputs.client_id.value; const mine = ++seq;
    if (!id) { rebuildConsents(consentStateFor(null, [])); return; }
    try {
      const r = await get(`/api/clients/${id}/consents`);
      if (mine === seq) rebuildConsents(consentStateFor(id, r.consents));
    } catch (e) { if (mine === seq) rebuildConsents(consentStateFor(id, [])); toast(e.message || 'Could not load this client\'s consents', 'error'); }
  });
  const m = modal(isNew ? 'New referral' : 'Edit referral', f, { wide: true });
}
/** Close the loop: what happened, and were they admitted? This is what makes referrals reportable. */
export async function openOutcomeForm(r, onDone) {
  const C = state.constants;
  // "Admitted" or "scheduled" on a referral that was only pending is the moment the agency learns who this
  // person is, so the outcome form carries the same consent choice as the referral form.
  let consents = [];
  if (!r.consent_id) { try { consents = ((await get(`/api/clients/${r.client_id}/consents`)).consents || []).filter(c => !c.revoked_at); } catch { consents = []; } }
  const f = form([
    { name: 'status', label: 'What happened', type: 'select', noBlank: true, required: true, value: r.status, current: r.status, list: 'REFERRAL_STATUSES' },
    { name: 'admitted_at', label: 'Admitted / started on', type: 'datetime', value: r.admitted_at || '' },
    ...(r.consent_id ? [] : [
      { name: 'consent_id', label: 'Consent / ROI on file (42 CFR Part 2)', type: 'select', options: consents.map(c => ({ value: c.id, label: `${consentTypeLabel(c.type)} → ${c.recipient || '—'} (signed ${fmt.date(c.signed_at)})` })), help: 'Needed once the provider has been told who this client is (contacted, scheduled, admitted…).' },
      { name: '_disclosure_basis', label: 'If there is no consent, the lawful basis', type: 'select', options: [{ value: 'medical_emergency', label: 'Medical emergency' }, { value: 'qsoa', label: 'Qualified service organisation agreement' }, { value: 'child_abuse_report', label: 'Mandated child abuse report' }, { value: 'crime_on_premises', label: 'Crime on program premises' }, { value: 'audit_evaluation', label: 'Audit or evaluation' }, { value: 'research', label: 'Research' }, { value: 'other', label: 'Other (supervisor override, must be justified)' }] },
      { name: '_disclosure_justification', label: 'Why sharing without consent is lawful', type: 'textarea', rows: 2, span: true },
    ]),
    { name: 'barrier', label: 'If it did not happen, why', type: 'select', list: 'REFERRAL_BARRIERS', value: r.barrier || '', current: r.barrier || undefined },
    { name: 'outcome', label: 'Outcome in your words', type: 'textarea', span: true, value: r.outcome || '' },
  ], { submitText: 'Record outcome', onCancel: () => m.close(), onSubmit: async (d) => {
    const res = await withRestrictionCheck((extra) => post(`/api/referrals/${r.id}/outcome`, { ...d, ...extra }), '_restriction_reviewed');
    toast(res.admitted ? 'Recorded — counted as an admission' : 'Outcome recorded', 'ok');
    m.close(); onDone && onDone();
  } });
  const m = modal(`Referral to ${r.resource_name}`, h('div', {},
    h('p', { class: 'small muted' }, 'Recording the outcome closes the follow-up to-do and lets the program answer how many warm handoffs actually resulted in an admission.'), f));
  return m;
}

export function referralTable(rows, { showClient = true, onChange } = {}) {
  return table([
    { label: 'Date', render: r => fmt.date(r.referred_at) }, showClient ? { label: 'Client', render: r => h('a', { href: `#/client/${r.client_id}` }, r.client_code) } : null,
    { label: 'Resource', render: r => h('div', {}, r.resource_name, h('div', { class: 'small muted' }, fmt.label(r.resource_category), r.resource_phone ? ` · ${r.resource_phone}` : '')) },
    { label: 'Status', render: r => badge(fmt.label(r.status, 'REFERRAL_STATUSES'), statusKind(r.status)) }, { label: 'Urgency', render: r => r.urgency !== 'routine' ? badge(fmt.label(r.urgency), 'danger') : '' },
    { label: 'Appt', render: r => r.appointment_at ? fmt.dt(r.appointment_at) : '—' }, { label: 'Consent', render: r => r.consent_revoked ? badge('Consent revoked', 'danger') : r.consent_id ? badge('ROI ✓', 'ok') : badge('No ROI', 'warn') }, { label: 'Barrier', render: r => r.barrier && r.barrier !== 'none' ? fmt.label(r.barrier) : '' }, { label: 'Worker', key: 'worker' },
    { label: 'Outcome', render: r => (r.outcome_recorded_at ? badge('Recorded', 'ok') : badge('Not yet', 'warn')) },
    { label: '', render: r => can('referrals:write') ? h('div', { class: 'row nowrap' },
      !r.outcome_recorded_at ? h('button', { class: 'btn sm primary', onClick: () => openOutcomeForm(r, onChange) }, 'Record outcome') : null,
      h('button', { class: 'btn sm', onClick: () => openReferralForm(r, { onDone: onChange }) }, 'Update'), (r.user_id === state.user.id || can('clients:all')) ? h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this referral', onClick: async () => { if (await confirmDialog('Delete referral', 'Delete this referral?', { danger: true, okText: 'Delete' })) { await del(`/api/referrals/${r.id}`); onChange && onChange(); } } }, '✕') : null) : null },
  ].filter(Boolean), rows, { empty: 'No referrals.' });
}
route('referrals', async (r) => {
  const status = r.query.get('status') || 'open';
  const qs = status === 'open' ? 'open=1' : status !== 'all' ? 'status=' + status : '';
  const PAGE = 200;
  const data = await get(`/api/referrals?limit=${PAGE}${qs ? '&' + qs : ''}`);
  const refresh = () => nav(`referrals?status=${status}&_=${Date.now()}`);
  const sel = h('select', { onChange: () => nav(`referrals?status=${sel.value}`) }, [['open', 'Open (pending → scheduled)'], ['all', 'All'], ...listFilterOptions('REFERRAL_STATUSES').map(o => [o.value, o.label])].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  return h('div', {},
    pageHead('Referrals', can('referrals:write') ? h('button', { class: 'btn primary', onClick: () => openReferralForm(null, { onDone: refresh }) }, '+ New referral') : null, can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/referrals?from=2000-01-01&format=xlsx') }, 'Export to Excel') : null),
    h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Status'), sel)),
    pagedList({ first: data, url: `/api/referrals${qs ? '?' + qs : ''}`, limit: PAGE, render: (rows) => referralTable(rows, { onChange: refresh }), summary: (rows, total) => h('div', { class: 'muted small mb' }, `${total} referrals`) }));
});
