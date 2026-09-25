// 42 CFR Part 2 on a client record: the consent form with every §2.31 element, the disclosure form (the
// basis, a subpart E court order, proceedings and counseling notes), the §2.22 patient notice and the court
// orders on file. The server (server/disclosure.js, routes/consents.js, routes/part2.js) is the gate; these
// forms say up front what it will ask for. docs/compliance/PART2.md.
import { h, get, post, state, form, modal, toast, table, badge, fmt, can, confirmDialog, flag } from '../app.js';

const C = () => state.constants || {};
const PART2_TYPES = () => C().PART2_CONSENT_TYPES || ['part2_disclosure', 'part2_tpo', 'part2_counseling_notes', 'part2_proceedings'];
const TYPE_LABELS = {
  part2_disclosure: 'Part 2 consent — a named disclosure', part2_tpo: 'Part 2 consent — treatment, payment & operations (one consent for all future TPO)',
  part2_counseling_notes: 'Part 2 consent — SUD counseling notes only', part2_proceedings: 'Part 2 consent — use in a legal proceeding only',
  roi: 'General release (ROI) — not sufficient for Part 2 records',
};
// The 2024 rule's own sufficient wording for a TPO consent (§2.31(a)(4)(iii)(B), (a)(5)(ii)).
const TPO = { recipient: 'My treating providers, health plans, third-party payers, and people helping to operate this program', purpose: 'For treatment, payment, and health care operations' };
const SIGNERS = { patient: 'The patient', parent_or_guardian: 'Parent or guardian (minor, §2.14)', personal_representative: 'Personal representative', court_appointed_guardian: 'Court-appointed guardian (§2.15)' };
const ORDER_TYPES = { noncriminal_2_64: '§2.64 — for a non-criminal purpose', criminal_patient_2_65: '§2.65 — to investigate or prosecute the patient', program_investigation_2_66: '§2.66 — to investigate the program', undercover_2_67: '§2.67 — undercover agent / informant' };
const METHODS = { in_person_paper: 'In person, on paper', electronic: 'Electronically (the client agreed)', mail: 'By mail', verbal_with_copy: 'Explained, with a copy handed over' };
// Short names for the consent types in tables and pickers ("Part2 Tpo" is what the generic label makes of them).
const SHORT = { part2_disclosure: 'Part 2 consent', part2_tpo: 'Part 2 — treatment, payment & operations', part2_counseling_notes: 'Part 2 — counseling notes', part2_proceedings: 'Part 2 — legal proceeding', roi: 'ROI' };
export const consentTypeLabel = (t) => SHORT[t] || fmt.label(t);
export const noticeShort = () => C().PART2_NOTICE_SHORT || '42 CFR part 2 prohibits unauthorized use or disclosure of these records.';

/** The label a Part 2 record carries on screen: header badge, printouts. */
export function part2Badge() { return h('span', { class: 'badge danger', 'data-part2-label': '1', title: noticeShort() }, h('span', { class: 'sr-only' }, 'Protected by '), '42 CFR Part 2'); }

/**
 * Run a save that shares information. If the client has an agreed restriction the server asks the worker to
 * check it first (restrictionReview); ask, and send again with the confirmation flag.
 */
export async function withRestrictionCheck(send, flag = 'restriction_reviewed') {
  try { return await send({}); }
  catch (e) {
    if (!(e.data && e.data.restrictionReview)) throw e;
    const ok = await confirmDialog('Agreed restriction on file', `${e.message} Only continue if this disclosure is consistent with what was agreed.`, { okText: 'I have checked — continue' });
    if (!ok) throw new Error('Not sent: check the agreed restriction first');
    return send({ [flag]: true });
  }
}

export function openConsentForm(clientId, { onDone, discloser } = {}) {
  const types = (C().CONSENT_TYPES || []).map(v => ({ value: v, label: TYPE_LABELS[v] || fmt.label(v) }));
  const P2 = ' *';
  const f = form([
    { name: 'type', label: 'Consent type', type: 'select', options: types, required: true, value: 'part2_tpo', noBlank: true,
      help: 'A Part 2 consent needs every element marked *. SUD counseling notes, and use in a legal proceeding, each need a separate consent of their own that covers nothing else.' },
    { name: 'signed_at', label: 'Date signed', type: 'date', required: true, value: fmt.today() },
    { name: 'discloser', label: 'Who may make the disclosure' + P2, value: discloser || state.org || '', span: true, help: 'This program, or the named program or person.' },
    { name: 'recipient', label: 'To whom (a name, or a class of recipients)' + P2, span: true, value: TPO.recipient },
    { name: 'purpose', label: 'Purpose of the disclosure' + P2, span: true, value: TPO.purpose, help: '"At the request of the patient" is sufficient. For a TPO consent, the wording above is what the rule allows.' },
    { name: 'scope', label: 'Information covered — specific and meaningful' + P2, type: 'textarea', span: true, rows: 2 },
    { name: 'expires_at', label: 'Expires on' + P2, type: 'date', help: 'Or name the event below.' }, { name: 'expires_event', label: 'Or expires on this event', placeholder: 'e.g. end of treatment' },
    { name: 'signer_relationship', label: 'Signed by', type: 'select', options: Object.entries(SIGNERS).map(([value, label]) => ({ value, label })), value: 'patient', noBlank: true },
    { name: 'signer_name', label: 'Name of the person who signed for the patient', help: 'Required unless the patient signed.' },
    { name: 'witness', label: 'Witness' }, { name: 'document_ref', label: 'Document location / scan ref' },
    { name: 'signed_on_paper', label: 'Signed on paper (Part 2 needs this, a witness or a document reference)', type: 'checkbox', span: true },
    { name: 'revocation_right_given', label: 'The consent states the right to revoke it in writing, and how' + P2, type: 'checkbox', span: true },
    { name: 'redisclosure_notice_given', label: 'The redisclosure statement was given (§2.32; for TPO, that HIPAA entities may redisclose except for proceedings against the patient)' + P2, type: 'checkbox', span: true },
    { name: 'refusal_consequences_given', label: 'The consent states the consequences of refusing to sign' + P2, type: 'checkbox', span: true },
  ], { submitText: 'Record consent', onCancel: () => m.close(), onSubmit: async (v) => { await post(`/api/clients/${clientId}/consents`, v); toast('Consent recorded', 'ok'); m.close(); onDone && onDone(); } });
  // The TPO wording is only a default for a TPO consent: switching type clears it, switching back restores it.
  const typeSel = f.querySelector('select[name=type]');
  typeSel.addEventListener('change', () => {
    const tpo = typeSel.value === 'part2_tpo';
    for (const k of ['recipient', 'purpose']) { const i = f.querySelector(`[name=${k}]`); if (tpo && !i.value) i.value = TPO[k]; else if (!tpo && i.value === TPO[k]) i.value = ''; }
  });
  const m = modal('Record consent / release of information', h('div', {},
    h('div', { class: 'banner small' }, '42 CFR §2.31: a Part 2 consent names the patient, who may disclose, what information, to whom (or a class), why, the right to revoke and how, when it expires (a date or an event), the signature and date, the redisclosure statement, and the consequences of refusing to sign. A general release is not enough.'),
    f), { wide: true });
}

// The lawful bases a disclosure can be recorded under (server/disclosure.js), and which of them only a
// supervisor or administrator (disclosures:override) may use.
const BASIS_LABELS = {
  consent: 'The client\'s consent (it must name the recipient)', court_order: 'Court order (42 CFR subpart E)', medical_emergency: 'Medical emergency (§2.51)',
  qsoa: 'Qualified service organization agreement (§2.12(c)(4))', audit_evaluation: 'Audit or evaluation (§2.53) — supervisor', research: 'Research (§2.52) — supervisor',
  crime_on_premises: 'Crime on the premises or against staff (§2.12(c)(5)) — supervisor', child_abuse_report: 'Mandated report of child abuse or neglect (§2.12(c)(6)) — supervisor',
  other: 'Other — supervisor override',
};
const OVERRIDE_BASES = ['other', 'research', 'audit_evaluation', 'crime_on_premises', 'child_abuse_report'];
export const AGREEMENT_KIND_LABELS = { qsoa: 'QSOA', research: 'Research approval', audit_evaluation: 'Audit / evaluation approval' };

export async function openDisclosureForm(clientId, d, { onDone } = {}) {
  const orders = (d.court_orders || []).filter(o => !o.problems.length);
  // The QSOAs and research / audit approvals on file: a disclosure on one of those bases rests on one.
  let agreements = [];
  if (can('agreements:read')) { try { agreements = ((await get('/api/disclosure-agreements')).rows || []).filter(a => a.active); } catch { agreements = []; } }
  const override = can('disclosures:override');
  const bases = Object.keys(BASIS_LABELS).filter(b => override || !OVERRIDE_BASES.includes(b));
  const f = form([
    { name: 'basis', label: 'Legal basis', type: 'select', options: bases.map(value => ({ value, label: BASIS_LABELS[value] })), value: 'consent', noBlank: true, required: true,
      help: override ? null : 'Research, audit, a report of a crime on the premises or of child abuse, and "other" are recorded by a supervisor or administrator.' },
    { name: 'consent_id', label: 'Consent relied on', type: 'select', options: d.consents.filter(x => x.can_disclose).map(x => ({ value: x.id, label: `${consentTypeLabel(x.type)} → ${x.recipient || '—'} (${fmt.date(x.signed_at)})` })),
      help: 'Only live Part 2 consents with every §2.31 element are offered. The consent covers only the recipient it names, and the information must be within its scope — no more than the purpose needs (§2.13).' },
    ...(override ? [{ name: 'recipient_override', label: 'Rely on this consent although it does not name the recipient exactly (supervisor override; justify below)', type: 'checkbox', span: true }] : []),
    { name: 'agreement_id', label: 'Agreement or approval relied on', type: 'select', options: agreements.map(a => ({ value: a.id, label: `${AGREEMENT_KIND_LABELS[a.kind] || a.kind} — ${a.organisation}${a.expires_at ? ` (until ${fmt.date(a.expires_at)})` : ''}` })),
      help: agreements.length ? 'For a QSOA, research or audit disclosure: the recipient must be the organisation it is with. Left empty, the one on file with the recipient is used.' : 'No QSOA or research / audit approval is on file. They are registered under Privacy & Part 2 → Agreements.' },
    { name: 'court_order_id', label: 'Court order relied on (42 CFR subpart E)', type: 'select', options: orders.map(o => ({ value: o.id, label: `${ORDER_TYPES[o.order_type] || o.order_type} — ${o.court || ''} ${o.case_ref || ''} (${fmt.date(o.issued_at)})` })),
      help: orders.length ? 'Required for the court order basis.' : 'No qualifying order on file — record it under Court orders first. A subpoena alone never authorises it.' },
    { name: 'legal_proceeding', label: 'For use in a legal proceeding against the client (needs a court order or a proceedings-only consent)', type: 'checkbox', span: true },
    { name: 'counseling_notes', label: 'Includes SUD counseling notes (needs a counseling-notes consent, or an order that covers them)', type: 'checkbox', span: true },
    { name: 'disclosed_at', label: 'Date disclosed', type: 'datetime', required: true, value: new Date().toISOString() }, { name: 'method', label: 'Method', type: 'select', options: ['verbal', 'phone', 'fax', 'secure_email', 'portal', 'paper', 'in_person'] },
    { name: 'disclosed_to', label: 'Disclosed to', required: true, span: true }, { name: 'purpose', label: 'Purpose', required: true, span: true },
    { name: 'info_disclosed', label: 'Information disclosed', type: 'textarea', required: true, span: true, rows: 2 },
    { name: 'justification', label: 'Justification (required for a medical emergency, a crime or child-abuse report, "other" and an override)', type: 'textarea', span: true, rows: 2, help: 'At least 20 characters. Stored encrypted with the disclosure.' },
  ], { submitText: 'Record disclosure', onCancel: () => m.close(), onSubmit: async (v) => {
    const r = await withRestrictionCheck((extra) => post(`/api/clients/${clientId}/disclosures`, { ...v, ...extra }));
    m.close();
    // A written disclosure made with consent has to carry the §2.32 notice: show it, ready to copy, and
    // refresh the tab once it is closed (refreshing first would re-render the page underneath and take it away).
    if (r && r.notice) showNotice(r.notice, onDone); else { toast('Disclosure recorded', 'ok'); onDone && onDone(); }
  } });
  const m = modal('Record a disclosure', h('div', {}, d.restrictions ? h('div', { class: 'banner warn small', 'data-restriction-banner': '1' }, 'This client has an agreed restriction on how their information is shared — see the Requests tab before recording a disclosure.') : null, f), { wide: true });
}

/** The §2.32 notice, to send with a written disclosure. */
export function showNotice(n, onClose) {
  const text = h('textarea', { id: 'disclosure-notice-text', readonly: true, rows: 8, style: { width: '100%' }, 'data-notice-text': '1' }, n.text);
  const m = modal('Send this notice with the disclosure', h('div', {},
    h('p', {}, 'Disclosure recorded. 42 CFR §2.32 requires this notice to accompany every disclosure made with the client\'s consent — include it on the fax cover, letter or email.'),
    h('label', { for: 'disclosure-notice-text' }, 'Notice to send with it'), text,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: async () => { try { await navigator.clipboard.writeText(n.text); toast('Copied', 'ok'); } catch { text.select(); } } }, 'Copy'), h('button', { class: 'btn primary', onClick: () => m.close() }, 'Done'))), { onClose: () => onClose && onClose() });
}

function openNoticeForm(clientId, onDone) {
  const f = form([
    { name: 'given_at', label: 'Given on', type: 'date', required: true, value: fmt.today() },
    { name: 'method', label: 'How', type: 'select', options: Object.entries(METHODS).map(([value, label]) => ({ value, label })), value: 'in_person_paper', noBlank: true, required: true },
    { name: 'acknowledged', label: 'The client signed an acknowledgement', type: 'checkbox', span: true },
    { name: 'ack_refused', label: 'The client declined to sign one (a good-faith attempt was made)', type: 'checkbox', span: true },
    { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 2, help: 'Stored encrypted.' },
  ], { submitText: 'Record notice given', onCancel: () => m.close(), onSubmit: async (v) => { await post(`/api/clients/${clientId}/part2-notices`, v); toast('Notice recorded', 'ok'); m.close(); onDone && onDone(); } });
  const m = modal('Patient notice given (42 CFR §2.22)', h('div', {}, h('p', { class: 'small muted' }, h('a', { href: '#/compliance?tab=notice', onClick: () => m.close() }, 'Read or print the notice'), ' — the version in force is recorded with this entry.'), f));
}

function openOrderForm(clientId, onDone) {
  const f = form([
    { name: 'order_type', label: 'Kind of order', type: 'select', options: Object.entries(ORDER_TYPES).map(([value, label]) => ({ value, label })), required: true, noBlank: true },
    { name: 'court', label: 'Court and judge', required: true }, { name: 'case_ref', label: 'Case number' },
    { name: 'issued_at', label: 'Issued', type: 'date', required: true }, { name: 'expires_at', label: 'Expires (if the order says)', type: 'date' },
    { name: 'recipient', label: 'Who may receive the information', span: true }, { name: 'purpose', label: 'Purpose the order states', required: true, span: true },
    { name: 'scope', label: 'What the order permits to be disclosed', type: 'textarea', required: true, span: true, rows: 2, help: 'Only the parts of the record essential to the order\'s purpose (§2.64(e)).' },
    { name: 'findings_recorded', label: 'The order states the good-cause findings (§2.64(d))', type: 'checkbox', span: true },
    { name: 'notice_requirement_met', label: 'The patient and program had the notice and chance to respond the section requires (or the order records why not)', type: 'checkbox', span: true },
    { name: 'covers_counseling_notes', label: 'The order expressly covers SUD counseling notes', type: 'checkbox', span: true },
    { name: 'document_ref', label: 'Where the order is filed', span: true },
  ], { submitText: 'Record court order', onCancel: () => m.close(), onSubmit: async (v) => {
    const r = await post(`/api/clients/${clientId}/court-orders`, v);
    toast(r.problems.length ? `Recorded, but it cannot authorise a disclosure yet: ${r.problems.join('; ')}` : 'Court order recorded', r.problems.length ? 'error' : 'ok'); m.close(); onDone && onDone();
  } });
  const m = modal('Record a court order (42 CFR subpart E)', h('div', {}, h('div', { class: 'banner small' }, 'A subpoena alone never authorises disclosing a Part 2 record. It takes a court order issued under 42 CFR §§2.64–2.67, with the findings those sections require. Ask county counsel before relying on one.'), f), { wide: true });
}

/** The §2.22 notice and subpart E court-order cards for a client's Consents tab. */
export function part2Cards(clientId, d, { refresh }) {
  const notices = d.notices || [];
  const noticeCard = h('div', { class: 'card', 'data-part2-notices': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'Patient notice (§2.22)'), can('consents:write') ? h('button', { class: 'btn sm primary', 'data-add-notice': '1', onClick: () => openNoticeForm(clientId, refresh) }, '+ Notice given') : null),
    notices.length ? null : h('p', { class: 'small' }, flag('No record that this client was given the program\'s notice of privacy practices.', true, 'the §2.22 notice is required', 'warn')),
    table([{ label: 'Given', render: x => fmt.date(x.given_at) }, { label: 'How', render: x => METHODS[x.method] || fmt.label(x.method) }, { label: 'Version', key: 'notice_version' }, { label: 'Acknowledged', render: x => x.acknowledged ? badge('Signed', 'ok') : x.ack_refused ? badge('Declined to sign', 'warn') : '—' }, { label: 'By', key: 'given_by_name' }, { label: 'Notes', key: 'notes' }], notices, { empty: 'None recorded.' }));
  if (!d.court_orders) return [noticeCard];
  const vacate = async (o) => { const reason = await confirmDialog('Vacate court order', 'Record that this order was vacated, withdrawn or reversed. It can no longer authorise a disclosure.', { danger: true, okText: 'Vacate', requireReason: true }); if (!reason) return; await post(`/api/court-orders/${o.id}/vacate`, { reason }); toast('Order vacated', 'ok'); refresh(); };
  const orderCard = h('div', { class: 'card', 'data-court-orders': '1' }, h('div', { class: 'card-head' }, h('h2', {}, 'Court orders (subpart E)'), can('court-orders:write') ? h('button', { class: 'btn sm', 'data-add-order': '1', onClick: () => openOrderForm(clientId, refresh) }, '+ Court order') : null),
    table([{ label: 'Kind', render: o => ORDER_TYPES[o.order_type] || o.order_type }, { label: 'Court / case', render: o => `${o.court || ''}${o.case_ref ? ' · ' + o.case_ref : ''}` }, { label: 'Issued', render: o => fmt.date(o.issued_at) }, { label: 'Permits', key: 'scope' },
      { label: 'Status', render: o => o.problems.length ? h('span', {}, badge('Cannot be relied on', 'danger'), h('div', { class: 'small muted' }, o.problems.join('; '))) : badge('In force', 'ok') },
      { label: '', render: o => o.status === 'active' && can('court-orders:write') ? h('button', { class: 'btn sm ghost', onClick: () => vacate(o) }, 'Vacate') : null }], d.court_orders, { empty: 'No court orders on file. Records are never disclosed for a legal proceeding against the client without one (or the client\'s consent for that proceeding alone).' }));
  return [noticeCard, orderCard];
}
