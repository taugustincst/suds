'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');
const disclosure = require('../disclosure');
const M = require('../clients-model');

// 42 CFR §2.31 (as amended in 2024) lists what a written Part 2 consent must contain: the patient's name
// (the client record), who may make the disclosure, what information, to whom (a name or a class), for
// what purpose, the right to revoke and how, an expiration date or event, the signature (of the patient or
// the person §2.14/§2.15 allows) and its date, the redisclosure statement, and the consequences of refusing
// to sign. A consent of any part2_* type is refused unless every one is recorded.
const PART2_TYPES = C.PART2_CONSENT_TYPES;
function requirePart2Elements(v) {
  const missing = disclosure.missingPart2Elements(v);
  if (missing.length) throw badRequest(`A 42 CFR Part 2 consent must record ${missing.join('; ')}`, { missing });
}

function presentConsent(c) {
  const today = new Date().toISOString().slice(0, 10);
  const active = !c.revoked_at && (!c.expires_at || c.expires_at >= today);
  return { ...c, recipient: c.recipient_enc ? decrypt(c.recipient_enc) : null, purpose: c.purpose_enc ? decrypt(c.purpose_enc) : null, scope: c.scope_enc ? decrypt(c.scope_enc) : null,
    signer_name: c.signer_name_enc ? decrypt(c.signer_name_enc) : null, revoked_reason: c.revoked_reason_enc ? decrypt(c.revoked_reason_enc) : null,
    witness: c.witness_enc ? decrypt(c.witness_enc) : null,
    // The coded categories it covers, as a list ([] when none were recorded: it covers nothing automated).
    info_categories: [...disclosure.parseCategories(c.info_categories)],
    recipient_enc: undefined, purpose_enc: undefined, scope_enc: undefined, signer_name_enc: undefined, revoked_reason_enc: undefined, witness_enc: undefined,
    // A consent that lacks the §2.31 elements (one that arrived by sync or by hand, or a legacy one) is shown,
    // but cannot be chosen to authorise a disclosure: incomplete says why.
    active, part2: PART2_TYPES.includes(c.type), incomplete: disclosure.consentElementProblems(c),
    can_disclose: active && disclosure.disclosingConsentTypes().includes(c.type) && !disclosure.consentElementProblems(c).length,
    // Recorded before the 2024 element list: still in force, but shown so it can be renewed on the new form.
    legacy_elements: PART2_TYPES.includes(c.type) && c.rule_version !== '2024' };
}

/** What a form needs to offer the court orders on file (never the order's encrypted detail beyond a label). */
function presentOrder(o) {
  return { ...o, court: o.court_enc ? decrypt(o.court_enc) : null, case_ref: o.case_ref_enc ? decrypt(o.case_ref_enc) : null, recipient: o.recipient_enc ? decrypt(o.recipient_enc) : null,
    purpose: o.purpose_enc ? decrypt(o.purpose_enc) : null, scope: o.scope_enc ? decrypt(o.scope_enc) : null,
    vacated_reason: o.vacated_reason_enc ? decrypt(o.vacated_reason_enc) : null,
    court_enc: undefined, case_ref_enc: undefined, recipient_enc: undefined, purpose_enc: undefined, scope_enc: undefined, vacated_reason_enc: undefined, problems: disclosure.courtOrderProblems(o) };
}

module.exports = (r) => {
  r.get('/api/clients/:id/consents', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    auth.assertClientAccess(ctx, ctx.params.id);
    const consents = db.all(`SELECT c.*, u.display_name AS created_by_name FROM consents c JOIN users u ON u.id=c.created_by WHERE client_id=? ORDER BY signed_at DESC`, ctx.params.id).map(presentConsent);
    const disclosures = db.all(`SELECT d.*, u.display_name AS disclosed_by_name FROM disclosures d JOIN users u ON u.id=d.disclosed_by WHERE client_id=? ORDER BY disclosed_at DESC`, ctx.params.id)
      .map(disclosure.present);
    const orders = auth.hasPerm(ctx.user, 'court-orders:read') ? db.all(`SELECT * FROM court_orders WHERE client_id=? ORDER BY issued_at DESC`, ctx.params.id).map(presentOrder) : null;
    const notices = db.all(`SELECT n.*, u.display_name AS given_by_name FROM part2_notices n JOIN users u ON u.id=n.given_by WHERE n.client_id=? ORDER BY n.given_at DESC`, ctx.params.id)
      .map(n => ({ ...n, notes: n.notes_enc ? decrypt(n.notes_enc) : null, notes_enc: undefined }));
    // Reading who a client's information may be shared with is itself a PHI read.
    audit.log({ user: ctx.user, action: 'consent.list', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { consents: consents.length, disclosures: disclosures.length, court_orders: orders ? orders.length : undefined, notices: notices.length } });
    return { consents, disclosures, court_orders: orders, notices, restrictions: disclosure.agreedRestrictions(ctx.params.id), part2_program: disclosure.part2Program(), notice: disclosure.notice() };
  });
  r.post('/api/clients/:id/consents', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, { type: { type: 'string', required: true, enum: C.CONSENT_TYPES }, recipient: { type: 'string', maxLen: 300 }, purpose: { type: 'string', maxLen: 500 }, scope: { type: 'string', maxLen: 1000 },
      signed_at: { type: 'date', required: true }, expires_at: { type: 'date' }, expires_event: { type: 'string', maxLen: 200 }, document_ref: { type: 'string', maxLen: 300 }, witness: { type: 'string', maxLen: 120 },
      signed_on_paper: { type: 'boolean' }, redisclosure_notice_given: { type: 'boolean' },
      discloser: { type: 'string', maxLen: 200 }, signer_relationship: { type: 'string', enum: C.CONSENT_SIGNERS }, signer_name: { type: 'string', maxLen: 200 },
      revocation_right_given: { type: 'boolean' }, refusal_consequences_given: { type: 'boolean' } });
    // The categories of information it covers, as codes (C.CONSENT_INFO_CATEGORIES): what an automated
    // disclosure (the FHIR API) honours. A list or comma-separated text; an unknown code is refused rather
    // than dropped, since dropping it would narrow the consent without anyone noticing. None is allowed —
    // the consent then covers nothing automated.
    const rawCats = ctx.body && ctx.body.info_categories;
    const catList = rawCats === undefined || rawCats === null || rawCats === '' ? [] : Array.isArray(rawCats) ? rawCats.map(String) : String(rawCats).split(',');
    const cats = [...new Set(catList.map(x => x.trim()).filter(Boolean))];
    const unknown = cats.filter(x => !C.CONSENT_INFO_CATEGORIES.includes(x));
    if (unknown.length) throw badRequest('Validation failed', { fields: { info_categories: `has a category SUDS does not know (${unknown.map(x => x.slice(0, 40)).join(', ')}); choose from ${C.CONSENT_INFO_CATEGORIES.join(', ')}` } });
    const infoCategories = cats.length ? (cats.includes('all') ? 'all' : C.CONSENT_INFO_CATEGORIES.filter(x => cats.includes(x)).join(',')) : null;
    const part2 = PART2_TYPES.includes(v.type);
    if (part2) {
      // Who may disclose is this programme unless the form names someone else; the signer is the patient
      // unless the form says a parent, guardian or representative signed.
      if (!v.discloser) v.discloser = db.getSetting('org_name', null) || null;
      if (!v.signer_relationship) v.signer_relationship = 'patient';
      requirePart2Elements(v);
      if (v.expires_at && v.expires_at < v.signed_at) throw badRequest('A consent cannot expire before it was signed');
    }
    const id = uuid();
    db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,expires_event,document_ref,witness_enc,signed_on_paper,redisclosure_notice_given,
        discloser,signer_relationship,signer_name_enc,revocation_right_given,refusal_consequences_given,rule_version,created_by,info_categories) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, v.type, v.recipient ? encrypt(v.recipient) : null, v.purpose ? encrypt(v.purpose) : null, v.scope ? encrypt(v.scope) : null, v.signed_at, v.expires_at || null, v.expires_event || null,
      v.document_ref || null, v.witness ? encrypt(v.witness) : null, v.signed_on_paper ? 1 : 0, v.redisclosure_notice_given ? 1 : 0,
      v.discloser || null, v.signer_relationship || null, v.signer_name ? encrypt(v.signer_name) : null, v.revocation_right_given ? 1 : 0, v.refusal_consequences_given ? 1 : 0, part2 ? '2024' : null, ctx.user.id, infoCategories);
    audit.log({ user: ctx.user, action: 'consent.create', entity: 'consent', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { type: v.type, rule_version: part2 ? '2024' : undefined, info_categories: infoCategories || undefined } });
    ctx.status = 201; return { id };
  });
  r.post('/api/consents/:id/revoke', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    const c = db.one(`SELECT * FROM consents WHERE id=?`, ctx.params.id); if (!c) throw notFound();
    auth.assertClientAccess(ctx, c.client_id);
    if (c.revoked_at) throw badRequest('This consent has already been revoked');
    const { reason } = validate(ctx.body, { reason: { type: 'string', maxLen: 300 } });
    // Revocation is not retroactive, but everything still in flight under this consent has to stop.
    // Flag the open referrals that relied on it so a worker sees them rather than discovering later.
    const dependent = db.all(`SELECT id, resource_id FROM referrals WHERE consent_id=? AND status NOT IN ('closed','declined')`, c.id);
    db.transaction(() => {
      db.run(`UPDATE consents SET revoked_at=?, revoked_reason_enc=?, revoked_by=?, updated_at=? WHERE id=?`, db.now(), reason ? encrypt(reason) : null, ctx.user.id, db.now(), c.id);
      for (const ref of dependent) db.run(`UPDATE referrals SET consent_revoked=1, updated_at=? WHERE id=?`, db.now(), ref.id);
    });
    audit.log({ user: ctx.user, action: 'consent.revoke', entity: 'consent', entityId: c.id, clientId: c.client_id, ip: ctx.ip, details: { dependent_referrals: dependent.length, reason_recorded: reason ? true : undefined } });
    return { ok: true, dependent_referrals: dependent.length };
  });
  // The consent as a printable record: every §2.31 element, as recorded, with the §2.32 statement.
  r.get('/api/consents/:id/pdf', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    const row = db.one(`SELECT c.*, u.display_name AS created_by_name FROM consents c JOIN users u ON u.id=c.created_by WHERE c.id=?`, ctx.params.id); if (!row) throw notFound();
    auth.assertClientAccess(ctx, row.client_id);
    const c = presentConsent(row); const client = M.decryptRow(db.one(`SELECT * FROM clients WHERE id=?`, row.client_id));
    const n = disclosure.notice(); const yes = (b) => (b ? 'Yes' : 'Not recorded');
    const fields = [
      { type: 'section', label: 'Consent (42 CFR §2.31)' },
      { key: 'patient', label: '1. Name of the patient' }, { key: 'discloser', label: '2. Who may make the disclosure' }, { key: 'scope', label: '3. Information to be disclosed' },
      { key: 'recipient', label: '4. To whom (name or class of recipients)' }, { key: 'purpose', label: '5. Purpose of the disclosure' },
      { key: 'revoke', label: '6. The consent states the right to revoke it in writing, and how' }, { key: 'expires', label: '7. Expires on (date or event)' },
      { key: 'signer', label: '8. Signed by' }, { key: 'signed', label: '9. Date signed' }, { key: 'redisclosure', label: '10. Redisclosure statement given (§2.32)' },
      { key: 'refusal', label: '11. The consent states the consequences of refusing to sign' }, { key: 'evidence', label: 'Evidence of signature' },
      { type: 'section', label: 'Status' }, { key: 'status', label: 'Status' },
    ];
    const values = { patient: `${client.first_name} ${client.last_name} (${client.client_code})`, discloser: c.discloser || '', scope: c.scope || '', recipient: c.recipient || '', purpose: c.purpose || '',
      revoke: yes(c.revocation_right_given), expires: c.expires_at || c.expires_event || '', signer: c.signer_relationship && c.signer_relationship !== 'patient' ? `${c.signer_name || ''} (${String(c.signer_relationship).replace(/_/g, ' ')})` : 'The patient',
      signed: c.signed_at, redisclosure: yes(c.redisclosure_notice_given), refusal: yes(c.refusal_consequences_given),
      evidence: [c.signed_on_paper ? 'Signed on paper' : null, c.witness ? `Witness: ${c.witness}` : null, c.document_ref ? `Document: ${c.document_ref}` : null].filter(Boolean).join('; '),
      status: c.revoked_at ? `Revoked ${c.revoked_at.slice(0, 10)}${c.revoked_reason ? ` (${c.revoked_reason})` : ''}` : c.active ? 'Active' : 'Expired' };
    audit.log({ user: ctx.user, action: 'consent.print', entity: 'consent', entityId: c.id, clientId: c.client_id, ip: ctx.ip });
    const body = require('../pdf').renderForm({ title: `Consent to disclose: ${String(c.type).replace(/_/g, ' ')}`, org: db.getSetting('org_name', 'SUDS'),
      meta: [`Recorded by ${row.created_by_name}`, c.legacy_elements ? 'Recorded before the 2024 element list' : null], fields, values,
      footer: disclosure.part2Program() ? `${n.short} NOTICE TO RECIPIENT (42 CFR §2.32): ${n.text}` : 'Contains protected health information; handle per HIPAA.' });
    ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': require('../http').contentDisposition('inline', `${client.client_code}-consent-${c.id.slice(0, 8)}.pdf`) }); ctx.res.end(body); return null;
  });
  // Accounting of disclosures (HIPAA §164.528 / 42 CFR §2.25). Recording one runs the same gate as a
  // referral or an export: disclosure.requireBasis.
  r.post('/api/clients/:id/disclosures', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, { consent_id: { type: 'string' }, disclosed_to: { type: 'string', required: true, maxLen: 200 }, purpose: { type: 'string', required: true, maxLen: 500 }, info_disclosed: { type: 'string', required: true, maxLen: 1000 },
      method: { type: 'string', maxLen: 60 }, disclosed_at: { type: 'datetime', required: true }, basis: { type: 'string', enum: disclosure.BASES }, justification: { type: 'string', maxLen: 2000 },
      court_order_id: { type: 'string' }, agreement_id: { type: 'string' }, recipient_override: { type: 'boolean' },
      legal_proceeding: { type: 'boolean' }, counseling_notes: { type: 'boolean' }, restriction_reviewed: { type: 'boolean' } });
    // The consent, or the registered agreement, is checked against the recipient typed here.
    const basis = disclosure.requireBasis(ctx.params.id, { ...v, recipient: v.disclosed_to, user: ctx.user });
    const id = disclosure.record({ clientId: ctx.params.id, consentId: basis.consent?.id || null, courtOrderId: basis.court_order?.id || null, agreementId: basis.agreement?.id || null,
      recipientOverride: basis.recipient_override, legalProceeding: basis.legal_proceeding, counselingNotes: basis.counseling_notes,
      recipient: v.disclosed_to, purpose: v.purpose, what: v.info_disclosed, method: v.method || null, basis: basis.basis, justification: basis.justification, source: 'manual', disclosedAt: v.disclosed_at, user: ctx.user, ip: ctx.ip });
    // The §2.32 statement the worker must send with it (written disclosures) — returned so the form can show it.
    ctx.status = 201; return { id, notice: disclosure.part2Program() && basis.basis === 'consent' ? disclosure.notice() : null };
  });
  // The accounting a client is entitled to on request (§164.528 / §2.25): everything shared about them,
  // in one printable document. Producing it is itself a PHI read, so it is audited as such.
  r.get('/api/clients/:id/disclosures/accounting', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=?`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const out = disclosure.accounting(ctx.params.id);
    audit.log({ user: ctx.user, action: 'disclosure.accounting', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { disclosures: out.disclosures.length } });
    return out;
  });
};
module.exports.presentOrder = presentOrder;
