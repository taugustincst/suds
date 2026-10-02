import { h, route, get, pagedList, filterBar, post, put, del, state, form, modal, toast, table, badge, statusKind, fmt, can, pageHead, confirmDialog, downloadCsv, nav, listFilterOptions, mayChange, viewOnly, isLocalMode, QUICK_FOLLOW_UP } from '../app.js';
// A court order is recorded, and disclosed under, on the client's Consents tab (it has to name the order),
// so it is not one of the bases offered here. A referral may rest only on the client's consent (which must
// name the provider), a medical emergency, a court order or a supervisor's justified override — never a
// QSOA, research, audit or a report to the authorities (server/disclosure.js REFERRAL_BASES).
import { withRestrictionCheck, consentTypeLabel, consentFormPanel } from './part2.js';

/** The lawful bases other than consent a referral form offers this user. */
function referralBases() {
  return [{ value: 'medical_emergency', label: 'Medical emergency (42 CFR §2.51)' },
    ...(can('disclosures:override') ? [{ value: 'other', label: 'Other — supervisor override, must be justified' }] : [])];
}
/** The supervisor's override for a consent that covers this provider without naming it exactly. */
const recipientOverrideField = (name) => (can('disclosures:override') ? [{ name, label: 'Rely on this consent although it does not name this provider (supervisor override; justify below)', type: 'checkbox', span: true }] : []);

// A client's consents, marked with the ones that name this provider (names_resource) and, when exactly one
// live consent does, that one as suggested_consent_id (server/routes/consents.js).
const consentsUrl = (clientId, resourceId) => `/api/clients/${clientId}/consents${resourceId && !String(resourceId).startsWith('__') ? `?resource_id=${encodeURIComponent(resourceId)}` : ''}`;

// Statuses that mean the referral is still under way: the outcome and barrier are recorded when it closes
// (openOutcomeForm), so a new referral in one of these does not ask for them (1.14.0).
const UNDER_WAY = ['pending', 'contacted', 'accepted', 'scheduled'];
// A referral the client declined, the provider declined, or that is closed is not sent anywhere: no Secure link
// (r10 M5). A consent that names the provider does not mean the client still wants this referral sent. The
// office server refuses a link for a closed referral as well.
const NO_SECURE_LINK = ['declined_by_client', 'declined_by_provider', 'closed'];

export async function openReferralForm(values, { clientId, clientDisplay, resourceId, onDone } = {}) {
  const C = state.constants; const isNew = !values;
  const theClientId = clientId || values?.client_id;
  // Two independent reads — the provider directory and this client's consents — so fetch them together
  // rather than one after the other; on a slow connection in the field that's the difference between one
  // round trip and two before the modal is usable.
  const [resResult, consentsResult] = await Promise.all([
    get('/api/resources?limit=1000'),
    theClientId ? get(consentsUrl(theClientId, resourceId || values?.resource_id)) : Promise.resolve({ consents: [] }),
  ]);
  const res = resResult.rows;
  // A phone that has not synced yet has an empty directory, and a provider nobody has entered is not a
  // reason to abandon the referral: the picker can add one without leaving this dialog.
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
    // A consent that lacks the §2.31 elements authorises nothing (can_disclose false), so it is not offered.
    const all = (list || []).filter(c => !c.revoked_at && !(c.incomplete && c.incomplete.length));
    const valid = all.filter(c => !c.expires_at || c.expires_at >= today);
    return { clientId, all, valid, expiredOnly: !!(clientId && !valid.length && all.length), suggested: (list && list.suggested_consent_id) || null };
  };
  // The provider chosen, for "Record a consent naming <provider>": a referral can rest on a consent only when
  // it names the provider. The consent is recorded in a step of this same dialog (never a dialog on top of it).
  let providerId = resourceId || values?.resource_id || '';
  const addedNames = {};
  const providerName = () => { const x = res.find(r => r.id === providerId); return x ? x.name : (addedNames[providerId] || ''); };
  const namesProvider = (st) => st.valid.some(c => c.names_resource);
  const recordNaming = (st) => (st.clientId && providerId && !String(providerId).startsWith('__') && can('consents:write') && providerName() && !namesProvider(st)
    ? h('button', { type: 'button', class: 'btn sm', 'data-record-consent-naming': '1', onClick: (e) => recordConsentFor(st.clientId, e.currentTarget) }, `Record a consent naming ${providerName()}`) : null);
  const consentOption = (c) => ({ value: c.id, label: `${consentTypeLabel(c.type)} → ${c.recipient || '—'} (signed ${fmt.date(c.signed_at)}${c.expires_at ? `, expires ${fmt.date(c.expires_at)}` : ''})` });
  const consentHelpContent = (st) => {
    const { clientId, all, valid, expiredOnly } = st; const button = recordNaming(st);
    if (valid.length) return ['Required before the provider is told who this client is, and it must name this provider (or its organization). A referral left as "pending" with no warm handoff — just a phone number handed to the client — needs none.',
      ...(button ? [h('span', { style: { display: 'block', marginTop: '.35rem' }, 'data-no-consent-names': '1' }, `None of the consents on file names ${providerName()}. `, button)] : [])];
    if (!clientId) return ['Choose the client first to see their consents on file.'];
    return [expiredOnly ? `${all.length === 1 ? 'The consent on file has' : 'All consents on file have'} expired. ` : 'No consent is on file. ',
      button || h('a', { href: `#/client/${clientId}/consents`, 'data-add-consent': '1', onClick: () => m.close() }, 'Record a new release on the Consents tab'), ' before the provider is told who this client is.'];
  };
  consentState = consentStateFor(theClientId, Object.assign(consentsResult.consents || [], { suggested_consent_id: consentsResult.suggested_consent_id }));
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
    { name: '_disclosure_basis', label: 'If there is no consent, the lawful basis', type: 'select', options: referralBases(),
      help: 'Leave empty unless you are relying on something other than the client\'s written consent. Whatever you choose is recorded in the accounting of disclosures.' },
    ...recipientOverrideField('_recipient_override'),
    { name: '_disclosure_justification', label: 'Why sharing without consent is lawful', type: 'textarea', rows: 2, span: true, help: 'Required (at least 20 characters) for a medical emergency, for "other" and for a supervisor override. Kept, encrypted, with the disclosure record.' },
    { name: '_disclosure_what', label: 'What is being shared', placeholder: 'Referral information (name, contact details and presenting need)', span: true },
    { name: 'follow_up_due', label: 'Follow-up due', type: 'date', quick: QUICK_FOLLOW_UP, help: 'A follow-up to-do is created either way; leave this empty and one is set for you based on urgency. Changing the date later moves the to-do; clearing it cancels it.' },
    // What came of it belongs to the outcome (Record outcome); asked here only for a referral that is already
    // over when it is entered, or one that already has an answer.
    { name: 'barrier', label: 'Barrier (if any)', type: 'select', list: 'REFERRAL_BARRIERS' },
    { name: 'outcome', label: 'Outcome', span: true }, { name: 'notes', label: 'Notes', type: 'textarea', span: true },
  ], { values: values || {}, submitText: isNew ? 'Create referral' : 'Save', draftKey: isNew ? 'referral:new' : `referral:${values.id}`, onCancel: () => m.close(), onSubmit: async (d) => {
    // A barrier or outcome hidden with its status is not sent (a status changed back to "pending" drops it).
    if (!outcomeShown()) { if (isNew || !values.barrier) delete d.barrier; if (isNew || !values.outcome) delete d.outcome; }
    try {
      // An agreed restriction on the client's record is checked with the worker before anything is sent.
      await withRestrictionCheck((extra) => (isNew ? post('/api/referrals', { ...d, ...extra }) : put(`/api/referrals/${values.id}`, { ...d, ...extra, if_updated_at: values.updated_at })), '_restriction_reviewed');
    } catch (e) {
      // The commonest failure by far is sharing without a consent; say what to do about it, once (the
      // server's message already ends in its own advice, and appending ours repeated it).
      if (/valid, unexpired consent/i.test(e.message || '') || (e.data && e.data.recipientNotCovered && !namesProvider(consentState))) {
        const err = new Error(consentState.valid.length && namesProvider(consentState)
          ? 'Choose the client\'s consent under "Consent / ROI on file" before the provider is told who this client is — or, if you are relying on something else, choose the lawful basis.'
          : providerName() && can('consents:write') ? `No consent on file names ${providerName()}. Use "Record a consent naming ${providerName()}" under Consent, or choose a lawful basis above.`
          : 'This client has no valid consent on file. Record the release on the client\'s Consents tab, or choose a lawful basis above.');
        err.status = e.status; err.data = e.data; throw err;
      }
      throw e;
    }
    toast('Referral saved', 'ok'); m.close(); onDone && onDone();
  } });
  const statusSel = f.inputs.status;
  const outcomeShown = () => !UNDER_WAY.includes(statusSel.value) || (!isNew && !!(values.barrier || values.outcome));
  const syncOutcome = () => { const show = outcomeShown(); for (const n of ['barrier', 'outcome']) { const w = f.querySelector(`[data-field="${n}"]`); if (w) w.hidden = !show; } };
  statusSel.addEventListener('change', syncOutcome); syncOutcome();

  // ---- steps inside this one dialog: a consent naming the provider, or a provider not listed ----
  // The referral is set aside (hidden, kept as typed), the step takes its place, and saving or cancelling the
  // step brings the referral back with the new consent or provider chosen. Escape inside a step goes back
  // to the referral rather than closing everything.
  const stepHost = h('div', { 'data-referral-steps': '1' });
  const openStep = (key, title, intro, content, { back } = {}) => {
    const hid = `referral-step-${key}-${Math.random().toString(36).slice(2, 7)}`;
    const heading = h('h3', { id: hid, tabindex: '-1', class: 'step-heading' }, title);
    const step = h('section', { 'data-referral-step': key, 'aria-labelledby': hid }, heading, h('p', { class: 'small muted' }, intro), content);
    const done = (focusEl) => { step.remove(); f.hidden = false; const t = focusEl && focusEl.isConnected ? focusEl : null; (t || f.querySelector('select,input')).focus(); };
    step.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(back && back()); } });
    f.hidden = true; stepHost.replaceChildren(step); heading.focus();
    return done;
  };
  // "Add a provider" is an option in the list rather than a button, because on a phone the list is where
  // someone looks when the provider they want is not there. The step asks only what a referral needs; the
  // provider's full profile is finished in Resources.
  const sel = f.inputs.resource_id;
  let last = sel.value;
  sel.addEventListener('change', () => {
    if (sel.value !== ADD) { last = sel.value; return; }
    sel.value = last;
    let done;
    const pf = form([
      { name: 'name', label: 'Program / service name', required: true, span: true },
      { name: 'category', label: 'Category', type: 'select', options: C.RESOURCE_CATEGORIES, required: true },
      { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'city', label: 'City' },
    ], { submitText: 'Add provider', cancelText: 'Back to the referral', onCancel: () => done(sel), onSubmit: async (d) => {
      const id = (await post('/api/resources', d)).id; addedNames[id] = d.name;
      sel.insertBefore(h('option', { value: id }, resourceLabel({ ...d })), sel.querySelector(`option[value="${ADD}"]`));
      sel.value = id; last = id;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      done(sel); reloadConsents();
      toast('Provider added — carry on with the referral. Its full profile can be finished under Resources.', 'ok');
    } });
    done = openStep('provider', 'Add a provider that is not listed', 'Added to the resource directory for everyone; the referral waits here as you left it.', pf, { back: () => sel });
  });
  // Picking (or changing) the client, or the provider, reloads that client's consents into the list and its
  // help text. When exactly one live consent names the provider it is chosen, and the form says which
  // consent the referral will rely on — the worker can still change it, or clear it for a referral that
  // shares nothing (pending, no warm handoff). A consent the worker picked themselves is never replaced.
  const consentSel = f.inputs.consent_id;
  const consentField = consentSel.closest('.field');
  const consentHelpEl = consentField?.querySelector('.help');
  const usedLine = h('div', { class: 'small', role: 'status', 'data-consent-used': '1' });
  if (consentField) consentField.append(usedLine);
  let autoPicked = false;
  const showUsed = () => {
    const c = consentState.valid.find(x => x.id === consentSel.value);
    usedLine.dataset.consentUsed = c ? c.id : '';
    usedLine.replaceChildren(...(c
      ? [h('b', {}, 'This referral will rely on: '), consentOption(c).label, autoPicked ? ' — the one consent on file that names this provider.' : '']
      : consentState.valid.length ? ['No consent chosen. Choose one before the provider is told who this client is.'] : []));
  };
  const rebuildConsents = (st) => {
    consentState = st;
    const keep = consentSel.value;
    while (consentSel.firstChild) consentSel.firstChild.remove();
    consentSel.append(h('option', { value: '' }, st.expiredOnly ? '(expired)' : '—'), ...st.valid.map(c => { const o = consentOption(c); return h('option', { value: o.value }, o.label); }));
    const kept = st.valid.some(c => c.id === keep) && !(autoPicked && keep !== st.suggested);
    consentSel.value = kept ? keep : '';
    if (!kept) autoPicked = false;
    if (!consentSel.value && st.suggested && st.valid.some(c => c.id === st.suggested)) { consentSel.value = st.suggested; autoPicked = true; }
    if (consentHelpEl) { while (consentHelpEl.firstChild) consentHelpEl.firstChild.remove(); consentHelpEl.append(h('span', { 'data-consent-help': '1' }, consentHelpContent(st))); }
    showUsed();
  };
  consentSel.addEventListener('change', () => { autoPicked = false; showUsed(); });
  // A new referral (or one with no consent yet) takes the suggestion the first read came back with.
  if (!values?.consent_id && consentState.suggested) { consentSel.value = consentState.suggested; autoPicked = consentSel.value === consentState.suggested; }
  showUsed();
  let seq = 0;
  const reloadConsents = async () => {
    const id = f.inputs.client_id.value; const mine = ++seq;
    if (sel.value !== ADD) providerId = sel.value;
    if (!id) { rebuildConsents(consentStateFor(null, [])); return; }
    try {
      const r = await get(consentsUrl(id, sel.value));
      if (mine === seq) rebuildConsents(consentStateFor(id, Object.assign(r.consents || [], { suggested_consent_id: r.suggested_consent_id })));
    } catch (e) { if (mine === seq) rebuildConsents(consentStateFor(id, [])); toast(e.message || 'Could not load this client\'s consents', 'error'); }
  };
  f.inputs.client_id.addEventListener('change', reloadConsents);
  // The consent form as a step of this dialog, filled in for this provider; once recorded, the referral relies
  // on it. The consent rules are the consent form's own (part2.js consentFormPanel, server/disclosure.js).
  const recordConsentFor = (clientId, opener) => {
    const name = providerName();
    let done;
    const panel = consentFormPanel(clientId, {
      preset: { type: 'part2_disclosure', recipient: name, purpose: 'Referral and care coordination' }, inline: true,
      onCancel: () => done(opener), close: () => {},
      onDone: async (newId) => {
        done(consentSel);
        await reloadConsents();
        if (newId && consentState.valid.some(c => c.id === newId)) { consentSel.value = newId; autoPicked = false; consentSel.dispatchEvent(new Event('input', { bubbles: true })); showUsed(); }
        toast('Consent recorded — carry on with the referral', 'ok');
      } });
    panel.form.querySelector('.btn-row button[type=button]').textContent = 'Back to the referral';
    done = openStep('consent', `Record a consent naming ${name}`, 'The referral waits here as you left it. Once the consent is recorded, the referral relies on it.', panel, { back: () => opener });
  };
  sel.addEventListener('change', () => { if (sel.value !== ADD) reloadConsents(); });
  const m = modal(isNew ? 'Make a referral' : 'Edit referral', h('div', { 'data-referral-dialog': '1' }, f, stepHost), { wide: true });
}
/** Close the loop: what happened, and were they admitted? This is what makes referrals reportable. */
export async function openOutcomeForm(r, onDone) {
  const C = state.constants;
  // "Admitted" or "scheduled" on a referral that was only pending is the moment the agency learns who this
  // person is, so the outcome form carries the same consent choice as the referral form.
  let consents = [];
  if (!r.consent_id) { try { consents = ((await get(`/api/clients/${r.client_id}/consents`)).consents || []).filter(c => c.can_disclose); } catch { consents = []; } }
  const f = form([
    { name: 'status', label: 'What happened', type: 'select', noBlank: true, required: true, value: r.status, current: r.status, list: 'REFERRAL_STATUSES' },
    { name: 'admitted_at', label: 'Admitted / started on', type: 'datetime', value: r.admitted_at || '' },
    ...(r.consent_id ? [] : [
      { name: 'consent_id', label: 'Consent / ROI on file (42 CFR Part 2)', type: 'select', options: consents.map(c => ({ value: c.id, label: `${consentTypeLabel(c.type)} → ${c.recipient || '—'} (signed ${fmt.date(c.signed_at)})` })), help: `Needed once the provider has been told who this client is (contacted, scheduled, admitted…). It must name ${r.resource_name || 'this provider'}.` },
      { name: '_disclosure_basis', label: 'If there is no consent, the lawful basis', type: 'select', options: referralBases() },
      ...recipientOverrideField('_recipient_override'),
      { name: '_disclosure_justification', label: 'Why sharing without consent is lawful', type: 'textarea', rows: 2, span: true, help: 'Required (at least 20 characters) for a medical emergency, for "other" and for a supervisor override.' },
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
  const actions = (r) => referralActions(r, onChange);
  return table([
    { label: 'Date', render: r => h('span', { class: 'nowrap' }, fmt.date(r.referred_at)) }, showClient ? { label: 'Client', render: r => (can('clients:read') ? h('span', {}, h('a', { href: `#/client/${r.client_id}` }, r.client_name || r.client_code), r.client_name ? h('span', { class: 'small muted nowrap' }, ` ${r.client_code}`) : null) : h('span', { class: 'mono' }, r.client_code)) } : null,
    { label: 'Resource', render: r => h('div', {}, r.resource_name, h('div', { class: 'small muted' }, fmt.label(r.resource_category), r.resource_phone ? ` · ${r.resource_phone}` : '')) },
    // Urgency, the appointment and the barrier sit under the status (1.16.2): in columns of their own the
    // action buttons ended past the right-hand edge of a 1280 px window.
    { label: 'Status', render: r => h('div', {}, badge(fmt.label(r.status, 'REFERRAL_STATUSES'), statusKind(r.status)), r.urgency && r.urgency !== 'routine' ? [' ', badge(fmt.label(r.urgency), 'danger')] : null,
      r.appointment_at ? h('div', { class: 'small' }, `Appt ${fmt.dt(r.appointment_at)}`) : null, r.barrier && r.barrier !== 'none' ? h('div', { class: 'small muted' }, `Barrier: ${fmt.label(r.barrier)}`) : null) },
    // "Consent on file" only when a live Part 2 consent names this provider (server/routes/referrals.js
    // withConsentOnFile): a general release, or a consent naming someone else, does not let the referral share.
    { label: 'Consent', render: r => r.consent_revoked ? badge('Consent revoked', 'danger') : r.consent_on_file ? badge('Consent on file', 'ok') : badge('No Part 2 consent', 'warn') }, { label: 'Worker', key: 'worker' },
    { label: 'Outcome', render: r => (r.outcome_recorded_at ? badge('Recorded', 'ok') : badge('Not yet', 'warn')) },
    // "Edit" as on every other list (it said "Update"). On a colleague's referral anyone may still record the
    // outcome, so the line says that rather than "view only" beside a working button.
    { label: '', render: r => actions(r) },
  ].filter(Boolean), rows, { empty: 'No referrals.',
    // On a phone, two lines a referral (as Visits) with its buttons under them, not a 600 px card of label/value
    // pairs (r8 L4). The row holds buttons, so it is not itself one.
    compact: { primary: r => [h('span', {}, showClient ? (r.client_name || r.client_code) : r.resource_name), badge(fmt.label(r.status, 'REFERRAL_STATUSES'), statusKind(r.status))],
      secondary: r => [h('span', {}, fmt.date(r.referred_at)), showClient ? h('span', {}, r.resource_name) : null, r.urgency && r.urgency !== 'routine' ? badge(fmt.label(r.urgency), 'danger') : null,
        r.appointment_at ? h('span', {}, `Appt ${fmt.dt(r.appointment_at)}`) : null, r.consent_revoked ? badge('Consent revoked', 'danger') : null, r.worker ? h('span', {}, `by ${r.worker}`) : null,
        h('div', { class: 'compact-actions' }, actions(r))] } });
}
// ---- secure referral links (1.17.0; server/referral-links.js, docs/security/REFERRAL-LINKS.md) ----
const LINK_STATUS = { sent: ['Sent, not opened', 'info'], opened: ['Opened', 'ok'], acknowledged: ['Answered', 'ok'], expired: ['Expired', 'warn'], revoked: ['Withdrawn', 'warn'], locked: ['Locked (wrong codes)', 'danger'] };
const ACK_LABEL = { received: 'received it', accepted: 'accepted the client', scheduled: 'scheduled the client', declined: 'declined', unable_to_reach: 'could not reach the client' };
/**
 * For a provider that does not use SUDS: a one-time link the provider opens in a browser, no account. With a
 * live Part 2 consent that names the provider, it carries a minimal referral (checked again when it is opened,
 * and accounted then); without one, only a "please contact us" notice that names nobody.
 */
export async function openSecureLinkDialog(r, onChange) {
  const [links, consentsRes] = await Promise.all([get(`/api/referrals/${r.id}/links`), get(consentsUrl(r.client_id, r.resource_id))]);
  const today = fmt.today();
  const naming = (consentsRes.consents || []).filter(c => c.names_resource && !c.revoked_at && (!c.expires_at || c.expires_at >= today) && !(c.incomplete && c.incomplete.length));
  const body = h('div', { 'data-secure-link': r.id });
  const refresh = () => { m.close(); openSecureLinkDialog(r, onChange); };
  const revoke = async (l) => { if (!await confirmDialog('Withdraw this link', `Withdraw link ${l.reference}? It stops working at once.`, { danger: true, okText: 'Withdraw' })) return; await post(`/api/referral-links/${l.id}/revoke`, {}); toast('Link withdrawn', 'ok'); refresh(); };
  const shown = (res) => {
    const url = `${location.origin}${res.path}`;
    const urlBox = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Secure link', 'data-secure-link-url': '1', class: 'mono', onFocus: (e) => e.target.select() });
    return h('div', { class: 'card tight mt', 'data-secure-link-made': res.kind },
      h('h3', {}, res.kind === 'packet' ? 'Send the link and the code separately' : 'Send this link'),
      h('p', { class: 'small' }, res.kind === 'packet'
        ? 'Email or text the link to the provider. Give them the access code another way — by phone is best — so a forwarded email alone does not open it. This is the only time the link and code are shown.'
        : 'Email or text it to the provider. It names nobody: it asks them to contact you and quote the reference. This is the only time the link is shown.'),
      h('div', { class: 'field' }, h('label', {}, 'Link'), urlBox),
      res.code ? h('p', {}, 'Access code: ', h('b', { class: 'mono', 'data-secure-link-code': '1' }, res.code)) : null,
      h('p', { class: 'small muted' }, `Reference ${res.reference} · expires ${fmt.dt(res.expires_at)}.`),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: () => { m.close(); onChange && onChange(); } }, 'Done')));
  };
  const hours = (links.ttl_hours || [24, 72, 168]).map(x => ({ value: String(x), label: x === 24 ? '1 day' : x === 168 ? '7 days' : `${x / 24} days` }));
  const f = form([
    { name: 'kind', label: 'What to send', type: 'select', noBlank: true, required: true, value: naming.length ? 'packet' : 'contact_notice', span: true,
      options: [...(naming.length ? [{ value: 'packet', label: 'The referral, with the client\'s details (their consent names this provider)' }] : []), { value: 'contact_notice', label: '"Please contact us" — no client information' }],
      help: naming.length ? null : `No live Part 2 consent on file names ${r.resource_name || 'this provider'}, so only a notice that names nobody can go. Record a consent that names them on the client's Consents tab to send the referral itself.` },
    ...(naming.length ? [
      { name: 'consent_id', label: 'Consent relied on', type: 'select', noBlank: true, value: naming[0].id, span: true, options: naming.map(c => ({ value: c.id, label: `${consentTypeLabel(c.type)} → ${c.recipient} (signed ${fmt.date(c.signed_at)})` })) },
      { name: 'message', label: 'Reason for the referral (sent to the provider)', type: 'textarea', rows: 3, span: true, maxLen: 1000, help: 'Only what the provider needs to act on it. The client\'s name is always included.' },
      { name: 'include_phone', label: 'Include the client\'s phone number', type: 'checkbox' },
      { name: 'include_dob', label: 'Include the client\'s date of birth', type: 'checkbox' },
    ] : []),
    { name: 'expires_hours', label: 'Link works for', type: 'select', noBlank: true, value: String(links.default_ttl_hours || 72), options: hours },
  ], { submitText: 'Make the link', onCancel: () => m.close(), onSubmit: async (v) => {
    const payload = { kind: v.kind, expires_hours: Number(v.expires_hours) };
    if (v.kind === 'packet') Object.assign(payload, { consent_id: v.consent_id, message: v.message || undefined, include_phone: !!v.include_phone, include_dob: !!v.include_dob });
    const res = await withRestrictionCheck((extra) => post(`/api/referrals/${r.id}/links`, { ...payload, ...extra }), '_restriction_reviewed');
    f.replaceWith(shown(res));
  } });
  // Through h(): the DOM's own append writes a null (no links yet) as the text "null" (r10 H1).
  body.append(h('div', {},
    h('p', { class: 'small muted' }, `For a provider that does not use SUDS. ${r.resource_name || 'The provider'} opens the link in a browser without an account and can tell you what happened. With the client's details it needs an access code, works in one browser only, and is written to the client's accounting of disclosures when it is opened.`),
    links.rows.length ? table([
      { label: 'Sent', render: l => fmt.dt(l.created_at) }, { label: 'What', render: l => (l.kind === 'packet' ? 'Referral' : 'Contact notice') },
      { label: 'Reference', render: l => h('span', { class: 'mono' }, l.reference) },
      { label: 'Status', render: l => h('div', {}, badge(...(LINK_STATUS[l.status] || [l.status, 'info'])), l.ack_status ? h('div', { class: 'small' }, `${l.ack_by || 'They'} ${ACK_LABEL[l.ack_status] || l.ack_status}${l.ack_note ? `: ${l.ack_note}` : ''}`) : null) },
      { label: '', render: l => (['sent', 'opened', 'acknowledged'].includes(l.status) ? h('button', { class: 'btn sm ghost', 'data-revoke-link': l.id, 'aria-label': `Withdraw link ${l.reference}`, onClick: () => revoke(l) }, 'Withdraw') : null) },
    ], links.rows, { rowLabel: l => `Link ${l.reference}` }) : null,
    f));
  const m = modal(`Secure link to ${r.resource_name || 'the provider'}`, body, { wide: true });
  return m;
}

function referralActions(r, onChange) {
  return can('referrals:write') ? h('div', {}, h('div', { class: 'row' },
      !r.outcome_recorded_at ? h('button', { class: 'btn sm primary', onClick: () => openOutcomeForm(r, onChange) }, 'Record outcome') : null,
      // Office server only: a device has no address an outside provider could open.
      // And only once an administrator has switched secure referral links on (off by default: counsel reviews them first),
      // and never on a declined or closed referral.
      !isLocalMode() && state.programme && state.programme.referral_links && !NO_SECURE_LINK.includes(r.status) ? h('button', { class: 'btn sm', 'data-secure-link-open': r.id, 'aria-label': `Secure link to ${r.resource_name || 'the provider'}`, onClick: () => openSecureLinkDialog(r, onChange) }, 'Secure link') : null,
      mayChange(r.user_id) ? h('button', { class: 'btn sm', onClick: () => openReferralForm(r, { onDone: onChange }) }, 'Edit') : null, mayChange(r.user_id) ? h('button', { class: 'btn sm ghost', 'aria-label': 'Delete this referral', onClick: async () => { const also = await (await import('./tasks.js')).deleteNotice('referral_id', r); if (await confirmDialog('Delete referral', `Delete this referral?${also}`, { danger: true, okText: 'Delete' })) { await del(`/api/referrals/${r.id}`); onChange && onChange(); } } }, '✕') : null),
      mayChange(r.user_id) ? null : r.outcome_recorded_at ? viewOnly(null, { short: true })
        : h('span', { class: 'small muted', 'data-view-only': '1' }, `You can record the outcome; only ${r.worker || 'the worker who made it'} or a supervisor can change the referral.`)) : null;
}
route('referrals', async (r) => {
  const status = r.query.get('status') || 'open';
  const qs = status === 'open' ? 'open=1' : status !== 'all' ? 'status=' + status : '';
  const PAGE = 200;
  const data = await get(`/api/referrals?limit=${PAGE}${qs ? '&' + qs : ''}`);
  const refresh = () => nav(`referrals?status=${status}&_=${Date.now()}`);
  const sel = h('select', { onChange: () => nav(`referrals?status=${sel.value}`) }, [['open', 'Open (pending → scheduled)'], ['all', 'All'], ...listFilterOptions('REFERRAL_STATUSES').map(o => [o.value, o.label])].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  return h('div', {},
    // "Referrals we make": this program sending a client on to another provider (outbound). Who referred a
    // client to this program is on the client's intake ("Who referred them to us").
    pageHead('Referrals we make', can('referrals:write') ? h('button', { class: 'btn primary', onClick: () => openReferralForm(null, { onDone: refresh }) }, '+ Make a referral') : null, can('export:read') ? h('button', { class: 'btn', onClick: () => downloadCsv('/api/reports/export/referrals?from=2000-01-01&format=xlsx') }, 'Export to Excel') : null),
    can('intake:read') ? h('p', { class: 'small' }, 'Referrals to this program from a hospital, jail, court or anyone else are in ', h('a', { href: '#/incoming' }, 'Incoming referrals'), '.') : null,
    filterBar(status === 'open' ? 0 : 1, h('div', { class: 'field' }, h('label', {}, 'Status'), sel)),
    pagedList({ first: data, url: `/api/referrals${qs ? '?' + qs : ''}`, limit: PAGE, render: (rows) => referralTable(rows, { onChange: refresh }), summary: (rows, total) => h('div', { class: 'muted small mb' }, `${total} referrals`) }));
});
