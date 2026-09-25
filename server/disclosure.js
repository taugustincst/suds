'use strict';
// Accounting of disclosures (HIPAA §164.528 and 42 CFR Part 2 §2.25) and the gate every disclosure passes
// through. Anything that sends identifiable client information outside SUDS records a row here — that is
// what makes consent more than a checkbox. docs/compliance/PART2.md maps each rule to the code below.
const db = require('./db');
const audit = require('./audit');
const C = require('./constants');
const { encrypt, decrypt, uuid } = require('./crypto');
const { badRequest, forbidden } = require('./http');

// Every lawful basis a disclosure can be recorded under. 'consent' needs a live consent of the right kind;
// 'court_order' needs a recorded subpart E order (§§2.61-2.67); the other Part 2 exceptions (§2.51 medical
// emergency, §2.53 audit/evaluation, §2.52 research, §2.12(c)(5) crime on premises, §2.12(c)(6) child abuse
// reporting, §2.12(c)(4) qualified service organisation) stand on their own; 'other' is an override reserved
// for supervisors and administrators, and both it and a medical emergency must say why in writing.
const BASES = ['consent', 'court_order', 'medical_emergency', 'qsoa', 'audit_evaluation', 'research', 'crime_on_premises', 'child_abuse_report', 'other'];
const NEEDS_JUSTIFICATION = ['other', 'medical_emergency'];
const MIN_JUSTIFICATION = 20;
// The bases an identified export may be made under. A file covering many people cannot rest on a court
// order (one order, one patient) or an emergency; 'internal' is a communication within the programme to
// staff who need the information for their work (§2.12(c)(3)), recorded all the same.
const EXPORT_BASES = ['consent', 'audit_evaluation', 'research', 'qsoa', 'internal'];
// Required disclosures (a court order, an emergency, a mandated report, a crime on the premises) are not
// something a patient's agreed restriction can stop; every other basis is checked against one.
const RESTRICTION_EXEMPT = ['court_order', 'medical_emergency', 'child_abuse_report', 'crime_on_premises'];

/** Is this programme a 42 CFR Part 2 programme? On unless an administrator says otherwise. */
function part2Program() { return db.getSetting('part2_program', '1') !== '0'; }

/** The §2.32 notice that accompanies a disclosure, and its abbreviated label. */
function notice() { return { version: C.PART2_NOTICE_VERSION, text: C.PART2_REDISCLOSURE_NOTICE, short: C.PART2_NOTICE_SHORT }; }

/** The consent types that can authorise a disclosure in this programme. */
function disclosingConsentTypes() { return part2Program() ? C.PART2_CONSENT_TYPES : [...C.PART2_CONSENT_TYPES, 'roi', 'research']; }

/** A consent is usable only while it exists, is unrevoked and has not expired. */
function activeConsent(clientId, consentId) {
  if (!consentId) return null;
  return db.one(`SELECT * FROM consents WHERE id=? AND client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, consentId, clientId) || null;
}

/** Why a recorded court order cannot authorise a disclosure (empty when it can). */
function courtOrderProblems(o) {
  const out = [];
  if (o.status !== 'active') out.push('it has been vacated');
  if (o.expires_at && o.expires_at < new Date().toISOString().slice(0, 10)) out.push('it has expired');
  if (!o.findings_recorded) out.push('it does not record the good-cause findings the regulation requires (§2.64(d))');
  if (!o.notice_requirement_met) out.push('the notice and opportunity to respond the regulation requires was not given');
  return out;
}

/** The client's agreed restrictions on use or disclosure (§2.26 / §164.522 requests that were granted). */
function agreedRestrictions(clientId) {
  return db.one(`SELECT COUNT(*) n FROM patient_requests WHERE client_id=? AND kind='restriction' AND status='fulfilled'`, clientId).n;
}

/**
 * Throws unless a lawful basis covers this disclosure. The returned object carries what record() needs.
 *   legal_proceeding: the information is for use in a civil, criminal, administrative or legislative
 *     proceeding against the patient (§2.12(d)) — only a qualifying court order or a consent given for that
 *     alone (§2.31(d)) will do.
 *   counseling_notes: it includes SUD counseling notes (§2.11) — only a consent given for them alone, or
 *     a court order that expressly covers them.
 *   restriction_reviewed: the worker has checked the client's agreed restrictions, when there are any.
 */
function requireBasis(clientId, { consent_id, basis, justification, user, court_order_id, legal_proceeding, counseling_notes, restriction_reviewed } = {}) {
  const b = basis || 'consent';
  if (!BASES.includes(b)) throw badRequest(`"${b}" is not a lawful basis for disclosure`);
  const proceeding = !!legal_proceeding; const notes = !!counseling_notes;
  if (proceeding && !['consent', 'court_order'].includes(b)) throw badRequest('Information for use in a proceeding against the patient may only be disclosed under a court order issued under 42 CFR §2.64/§2.65, or the patient\'s written consent given for that proceeding alone (§2.12(d), §2.31(d)). A subpoena on its own is not enough.');
  if (notes && !['consent', 'court_order'].includes(b)) throw badRequest('SUD counseling notes may only be disclosed under a consent given for counseling notes alone (§2.31(b)), or a court order that expressly covers them.');

  let consent = null; let order = null;
  if (b === 'consent') {
    consent = activeConsent(clientId, consent_id);
    if (!consent) throw badRequest('A valid, unexpired consent must be selected before information can be shared. Record the consent first, or choose another lawful basis.');
    if (!disclosingConsentTypes().includes(consent.type)) {
      throw badRequest(consent.type === 'roi'
        ? 'A general release of information is not a 42 CFR Part 2 consent (§2.31, §2.32). Record a Part 2 consent with every required element, or choose another lawful basis.'
        : `A "${consent.type.replace(/_/g, ' ')}" consent does not authorise sharing information. Record a Part 2 consent, or choose another lawful basis.`);
    }
    if (proceeding && consent.type !== 'part2_proceedings') throw badRequest('Information for use in a proceeding against the patient needs a court order, or a consent given for that proceeding alone (§2.31(d)); this consent does not cover it.');
    if (!proceeding && consent.type === 'part2_proceedings') throw badRequest('A consent for use in a legal proceeding cannot be combined with any other purpose (§2.31(d)); use it only for the proceeding it names.');
    if (notes && consent.type !== 'part2_counseling_notes') throw badRequest('SUD counseling notes need a separate consent given for counseling notes alone (§2.31(b)); a treatment, payment and operations consent or a general Part 2 consent does not cover them.');
    if (!notes && consent.type === 'part2_counseling_notes') throw badRequest('A consent for SUD counseling notes covers counseling notes only (§2.31(b)); tick "includes SUD counseling notes", or rely on a different consent for other information.');
  }
  if (b === 'court_order') {
    order = court_order_id ? db.one(`SELECT * FROM court_orders WHERE id=? AND client_id=?`, court_order_id, clientId) : null;
    if (!order) throw badRequest('A disclosure under a court order must name the order: record it on the client\'s Consents tab (42 CFR subpart E) and choose it. A subpoena on its own does not authorise disclosing a Part 2 record.');
    const problems = courtOrderProblems(order);
    if (problems.length) throw badRequest(`That court order cannot authorise a disclosure: ${problems.join('; ')}.`);
    if (notes && !order.covers_counseling_notes) throw badRequest('That court order does not expressly cover SUD counseling notes.');
  }
  if (!RESTRICTION_EXEMPT.includes(b) && !restriction_reviewed && agreedRestrictions(clientId)) {
    throw badRequest('This client has an agreed restriction on how their information is shared (see their Requests tab). Check that this disclosure respects it, then confirm.', { restrictionReview: true });
  }
  const why = String(justification || '').trim();
  if (NEEDS_JUSTIFICATION.includes(b) && why.length < MIN_JUSTIFICATION) {
    throw badRequest(b === 'other'
      ? `Sharing without consent on an "other" basis needs a written justification of at least ${MIN_JUSTIFICATION} characters, which is kept with the disclosure record.`
      : `A medical emergency disclosure (42 CFR §2.51) needs a written justification of at least ${MIN_JUSTIFICATION} characters: the nature of the emergency and who was told.`);
  }
  // "Other" is not a basis anyone can tick to get past the consent check: only a supervisor or an
  // administrator, who answers for it, may record one.
  if (b === 'other' && !require('./auth').hasPerm(user, 'disclosures:override')) throw forbidden('Only a supervisor or administrator can record a disclosure on an "other" basis');
  return { basis: b, consent, court_order: order, justification: why || null, legal_proceeding: proceeding, counseling_notes: notes };
}

/**
 * The same gate for an identified export: one basis for the whole file, checked against every client in
 * it. A proceeding against a patient is never a bulk export; a consent basis needs a live Part 2 consent
 * (not one limited to counseling notes or a proceeding) for every client the file names.
 */
function requireExportBasis(clientIds, { basis, restriction_reviewed, legal_proceeding } = {}) {
  if (legal_proceeding) throw badRequest('Records for use in a legal proceeding against a patient are disclosed one client at a time, under a recorded court order or a proceedings-only consent (Consents tab → Record a disclosure), never as a bulk export.');
  if (!basis) throw badRequest(`An identified export must state its lawful basis (basis=${EXPORT_BASES.join('|')}); it is written to the accounting of disclosures for every client in the file`);
  if (!EXPORT_BASES.includes(basis)) throw badRequest(`"${basis}" is not a basis an identified export can be made under (${EXPORT_BASES.join(', ')})`);
  if (basis === 'consent' && clientIds.length) {
    const types = disclosingConsentTypes().filter(t => t !== 'part2_proceedings' && t !== 'part2_counseling_notes');
    const covered = new Set(db.all(`SELECT DISTINCT client_id FROM consents WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now')) AND type IN (${types.map(() => '?').join(',')})`, ...types).map(r => r.client_id));
    const missing = clientIds.filter(id => !covered.has(id)).length;
    if (missing) throw badRequest(`${missing} client${missing === 1 ? '' : 's'} in this export ${missing === 1 ? 'has' : 'have'} no active Part 2 consent. Narrow the export, or state another lawful basis.`, { clientsWithoutConsent: missing });
  }
  if (!restriction_reviewed && clientIds.length) {
    const restricted = new Set(db.all(`SELECT DISTINCT client_id FROM patient_requests WHERE kind='restriction' AND status='fulfilled'`).map(r => r.client_id));
    const n = clientIds.filter(id => restricted.has(id)).length;
    if (n) throw badRequest(`${n} client${n === 1 ? '' : 's'} in this export ${n === 1 ? 'has' : 'have'} an agreed restriction on how their information is shared. Check the export respects it, then confirm (restriction_reviewed=1).`, { restrictionReview: true, restrictedClients: n });
  }
  return basis;
}

/** Write the disclosure row. Caller has already established the basis. */
function record({ clientId, consentId = null, courtOrderId = null, legalProceeding = false, counselingNotes = false, recipient, purpose, what, method = null, basis = 'consent', justification = null, source = 'manual', sourceRef = null, disclosedAt = null, user, ip }) {
  const id = uuid();
  const at = disclosedAt || db.now();
  const noticeVersion = part2Program() ? C.PART2_NOTICE_VERSION : null;
  db.run(`INSERT INTO disclosures(id,client_id,consent_id,recipient_enc,purpose_enc,what_enc,method,disclosed_at,disclosed_by,basis,justification_enc,source,source_ref,court_order_id,legal_proceeding,counseling_notes,notice_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, clientId, consentId, encrypt(String(recipient)), encrypt(String(purpose)), encrypt(String(what)), method, at, user.id, basis, justification ? encrypt(String(justification)) : null, source, sourceRef,
    courtOrderId, legalProceeding ? 1 : 0, counselingNotes ? 1 : 0, noticeVersion);
  // The audit trail records that a disclosure happened and under what authority — never to whom or what,
  // which is PHI and lives only in the encrypted columns above.
  audit.log({ user, action: 'disclosure.record', entity: 'disclosure', entityId: id, clientId, ip, details: { basis, source, consent_id: consentId || undefined, court_order_id: courtOrderId || undefined, justified: justification ? true : undefined,
    legal_proceeding: legalProceeding ? true : undefined, counseling_notes: counselingNotes ? true : undefined, notice: noticeVersion || undefined } });
  return id;
}

/** Decrypt a disclosure row for display. */
function present(row) {
  if (!row) return null;
  const out = { ...row };
  out.recipient = row.recipient_enc ? decrypt(row.recipient_enc) : null;
  out.purpose = row.purpose_enc ? decrypt(row.purpose_enc) : null;
  out.what = row.what_enc ? decrypt(row.what_enc) : null;
  out.justification = row.justification_enc ? decrypt(row.justification_enc) : null;
  delete out.recipient_enc; delete out.purpose_enc; delete out.what_enc; delete out.justification_enc;
  return out;
}

/**
 * The accounting of disclosures for one client (§164.528 / §2.25): what was shared, with whom, why, on what
 * authority, by whom and when — plus the consents and court orders those disclosures relied on. Audited
 * by the caller.
 */
function accounting(clientId) {
  const client = db.one(`SELECT id, client_code FROM clients WHERE id=?`, clientId);
  const disclosures = db.all(`SELECT d.*, u.display_name AS disclosed_by_name, u.username AS disclosed_by_username, co.order_type AS court_order_type FROM disclosures d JOIN users u ON u.id=d.disclosed_by LEFT JOIN court_orders co ON co.id=d.court_order_id WHERE d.client_id=? ORDER BY d.disclosed_at`, clientId).map(present);
  const consents = db.all(`SELECT id, type, recipient_enc, purpose_enc, signed_at, expires_at, expires_event, revoked_at, rule_version FROM consents WHERE client_id=? ORDER BY signed_at`, clientId)
    .map(c => ({ id: c.id, type: c.type, recipient: c.recipient_enc ? decrypt(c.recipient_enc) : null, purpose: c.purpose_enc ? decrypt(c.purpose_enc) : null, signed_at: c.signed_at, expires_at: c.expires_at, expires_event: c.expires_event, revoked_at: c.revoked_at, rule_version: c.rule_version }));
  return { client_id: client?.id, client_code: client?.client_code, generated_at: db.now(), part2_program: part2Program(), notice: part2Program() ? notice() : null, disclosures, consents };
}

module.exports = { BASES, EXPORT_BASES, NEEDS_JUSTIFICATION, MIN_JUSTIFICATION, part2Program, notice, disclosingConsentTypes, activeConsent, courtOrderProblems, agreedRestrictions, requireBasis, requireExportBasis, record, present, accounting };
