'use strict';
// Accounting of disclosures (HIPAA §164.528 and 42 CFR Part 2 §2.25) and the gate every disclosure passes
// through. Anything that sends identifiable client information outside SUDS records a row here — that is
// what makes consent more than a checkbox. docs/compliance/PART2.md maps each rule to the code below.
const db = require('./db');
const audit = require('./audit');
const C = require('./constants');
const { encrypt, decrypt, uuid } = require('./crypto');
const { badRequest, forbidden, HttpError } = require('./http');

// Every lawful basis a disclosure can be recorded under, and what each one has to stand on
// (docs/compliance/PART2.md, "The disclosure gate"):
//   consent — a live consent of a disclosing type that carries the §2.31 elements and names the recipient;
//   court_order — a recorded subpart E order (§§2.61-2.67) that qualifies;
//   medical_emergency (§2.51) — a written justification;
//   qsoa (§2.12(c)(4)) — a registered qualified service organisation agreement with the recipient;
//   research (§2.52), audit_evaluation (§2.53) — a registered approval naming the recipient, and a supervisor
//     or administrator (disclosures:override);
//   crime_on_premises (§2.12(c)(5)), child_abuse_report (§2.12(c)(6)) — a supervisor or administrator and a
//     written justification;
//   other — the override: a supervisor or administrator and a written justification.
const BASES = ['consent', 'court_order', 'medical_emergency', 'qsoa', 'audit_evaluation', 'research', 'crime_on_premises', 'child_abuse_report', 'other'];
const NEEDS_JUSTIFICATION = ['other', 'medical_emergency', 'crime_on_premises', 'child_abuse_report'];
// Bases only a role holding disclosures:override (a supervisor or an administrator) may record.
const OVERRIDE_BASES = ['other', 'research', 'audit_evaluation', 'crime_on_premises', 'child_abuse_report'];
// Bases that rest on a row of the agreements register (disclosure_agreements), and what each is called.
const AGREEMENT_KINDS = { qsoa: 'qualified service organization agreement', research: 'research approval', audit_evaluation: 'audit or evaluation approval' };
// A referral puts a named person in front of a treating agency. It can rest on the client's consent, a
// medical emergency, a court order, or the supervisor's override — never on a QSOA (a QSOA is a service
// provided to the programme, not care by a third party), research, audit, or a report to the authorities.
const REFERRAL_BASES = ['consent', 'medical_emergency', 'court_order', 'other'];
// The 2024 final rule's compliance date. A Part 2 consent recorded before the 2024 element list (a legacy
// consent, rule_version NULL) can still authorise a disclosure if it carries the pre-2024 elements SUDS
// recorded and was signed before this date; one signed on or after it must carry the 2024 elements.
const LEGACY_CONSENT_CUTOFF = '2026-02-16';
// Bases recorded by the system itself, never chosen by hand: 'export' (an identified export) and
// 'state_reporting' — the CalOMS Tx submission to DHCS (server/caloms.js). CalOMS reporting is required by
// state law of every licensed/certified or publicly funded SUD treatment programme; under HIPAA it is a
// disclosure required by law (45 CFR §164.512(a)), which is still subject to the accounting of disclosures
// (§164.528), and under Part 2 it is made to the state agency that funds and regulates the programme for
// audit and evaluation (42 CFR §2.53). Counsel should confirm the Part 2 characterisation for the county.
const SYSTEM_BASES = ['export', 'state_reporting'];
const STATE_REPORTING = {
  basis: 'state_reporting',
  recipient: 'California Department of Health Care Services (DHCS) — CalOMS Tx',
  purpose: 'State reporting (CalOMS Tx): treatment admission, discharge and annual update data required by law (HIPAA §164.512(a); 42 CFR §2.53)',
};
const MIN_JUSTIFICATION = 20;
// The bases an identified export may be made under. A file covering many people cannot rest on a court
// order (one order, one patient) or an emergency. 'internal' is a communication within the programme to
// staff who need the information for their work (§2.12(c)(3)): the stated recipient must be this programme
// (its name as set under Settings) or one of its staff — no identified file leaves as "internal".
const EXPORT_BASES = ['consent', 'audit_evaluation', 'research', 'qsoa', 'internal'];
// Required disclosures (a court order, an emergency, a mandated report, a crime on the premises) are not
// something a patient's agreed restriction can stop; every other basis is checked against one. The CalOMS
// Tx submission ('state_reporting', a disclosure required by law, §164.522(a)(1)(v)) is exempt likewise;
// it never passes through requireBasis, so it is listed here for the record.
const RESTRICTION_EXEMPT = ['court_order', 'medical_emergency', 'child_abuse_report', 'crime_on_premises', 'state_reporting'];

/** Is this programme a 42 CFR Part 2 programme? On unless an administrator says otherwise. */
function part2Program() { return db.getSetting('part2_program', '1') !== '0'; }

/** The §2.32 notice that accompanies a disclosure, and its abbreviated label. */
function notice() { return { version: C.PART2_NOTICE_VERSION, text: C.PART2_REDISCLOSURE_NOTICE, short: C.PART2_NOTICE_SHORT }; }

/** The consent types that can authorise a disclosure in this programme. */
function disclosingConsentTypes() { return part2Program() ? C.PART2_CONSENT_TYPES : [...C.PART2_CONSENT_TYPES, 'roi', 'research']; }
/**
 * The consent types that can stand behind a client's inclusion in a file of many clients (an identified
 * export, the county EHR hand-off): any disclosing consent except one limited to counseling notes or to a
 * legal proceeding, neither of which a bulk file can be.
 */
function fileConsentTypes() { return disclosingConsentTypes().filter(t => t !== 'part2_proceedings' && t !== 'part2_counseling_notes'); }

/**
 * The §2.32 notice as one line for the end of a CSV file, a README or a response header ('short' for the
 * header), or null outside a Part 2 programme.
 */
function fileNotice({ short = false } = {}) {
  if (!part2Program()) return null;
  const n = notice();
  return short ? n.short : `${n.short} NOTICE TO RECIPIENT (42 CFR §2.32): ${n.text}`;
}

// ---- §2.31: what a Part 2 consent must contain ----
/**
 * The 2024 element list (§2.31 as amended): who may disclose, the recipient (a name or a class), the purpose,
 * what information, an expiry date or event, evidence of signature, the signer's name when not the patient,
 * and the revocation, redisclosure and refusal statements. `v` holds plain values under the form's field
 * names. Returns what is missing, in words (empty when complete). Used by the consent route, by a device's
 * push (server/routes/sync.js) and, for rows already on file, at the moment of disclosure.
 */
function missingPart2Elements(v) {
  const missing = [];
  if (!v.discloser) missing.push('who may make the disclosure');
  if (!v.recipient) missing.push('the recipient (a name, or a class of recipients)');
  if (!v.purpose) missing.push('the purpose');
  if (!v.scope) missing.push('what information is covered (scope)');
  if (!v.expires_at && !v.expires_event) missing.push('an expiration date or event');
  if (!v.document_ref && !v.signed_on_paper && !v.witness) missing.push('evidence it was signed (a document reference, a witness, or "signed on paper")');
  if (v.signer_relationship !== 'patient' && !v.signer_name) missing.push('the name of the person who signed for the patient');
  if (!v.revocation_right_given) missing.push('confirmation that the consent states the right to revoke it and how');
  if (!v.redisclosure_notice_given) missing.push('confirmation that the redisclosure statement was given (§2.32)');
  if (!v.refusal_consequences_given) missing.push('confirmation that the consent states the consequences of refusing to sign');
  return missing;
}
/**
 * A legacy consent (recorded before the 2024 element list): the pre-2024 elements SUDS recorded — the
 * recipient, the purpose, what information, an expiry date or event, and evidence of signature — and a
 * signature before the 2024 rule's compliance date. (Who may disclose was this programme; the pre-2024
 * revocation statement was on the programme's printed form, which the evidence of signature points to.)
 */
function missingLegacyElements(v) {
  const missing = [];
  if (!v.recipient) missing.push('the recipient');
  if (!v.purpose) missing.push('the purpose');
  if (!v.scope) missing.push('what information is covered (scope)');
  if (!v.expires_at && !v.expires_event) missing.push('an expiration date or event');
  if (!v.document_ref && !v.signed_on_paper && !v.witness) missing.push('evidence it was signed (a document reference, a witness, or "signed on paper")');
  if (String(v.signed_at || '') >= LEGACY_CONSENT_CUTOFF) missing.push(`the 2024 elements (it was signed on or after ${LEGACY_CONSENT_CUTOFF}, when the 2024 rule's element list became mandatory)`);
  return missing;
}
const dec = (v) => { if (!v) return ''; try { return decrypt(v); } catch { return ''; } };
/** A consents row as the plain values the element checks read. */
function consentValues(row) {
  return { discloser: row.discloser, recipient: dec(row.recipient_enc), purpose: dec(row.purpose_enc), scope: dec(row.scope_enc), expires_at: row.expires_at, expires_event: row.expires_event,
    document_ref: row.document_ref, signed_on_paper: row.signed_on_paper, witness: row.witness, signer_relationship: row.signer_relationship, signer_name: dec(row.signer_name_enc),
    revocation_right_given: row.revocation_right_given, redisclosure_notice_given: row.redisclosure_notice_given, refusal_consequences_given: row.refusal_consequences_given, signed_at: row.signed_at };
}
/** What stops this consent row authorising a disclosure as a Part 2 consent (empty when nothing does). */
function consentElementProblems(row) {
  if (!C.PART2_CONSENT_TYPES.includes(row.type)) return [];
  const v = consentValues(row);
  return row.rule_version === '2024' ? missingPart2Elements(v) : missingLegacyElements(v);
}

/**
 * A consent is usable only while it exists, is unrevoked and has not expired — and, for a Part 2 consent,
 * only while it carries the §2.31 elements (consentElementProblems), however it reached the database.
 * requireBasis asks for the elements separately so that it can say which are missing.
 */
function activeConsent(clientId, consentId, { elements = true } = {}) {
  if (!consentId) return null;
  const row = db.one(`SELECT * FROM consents WHERE id=? AND client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, consentId, clientId) || null;
  if (row && elements && consentElementProblems(row).length) return null;
  return row;
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

// ---- recipients ----
// One definition of "this consent names that recipient", shared by every path a disclosure can take — a
// referral, a manual disclosure, an identified export, the county EHR hand-off and the FHIR API
// (consentCovers below) — so no human path is looser than the automated one. Names are compared
// normalised (case, accents, punctuation and spacing do not matter):
//   * a consent to a named recipient (part2_disclosure, and every other type) covers exactly the name it
//     gives — "Agency A only" does not cover "Agency A", and a list or a class does not cover its members;
//   * the 2024 single TPO consent (part2_tpo) may list several recipients or describe a class; it covers an
//     organisation it names, alone or within that wording ("County Behavioral Health and my other treating
//     providers" covers County Behavioral Health). A class with no name in it ("my treating providers")
//     covers nobody a machine can match; a supervisor may override, with a written justification;
//   * a recipient is known by its registered names: a referral's resource by its name and its organisation,
//     and any organisation on the agreements register or registered as a FHIR client by its aliases.
const normalise = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const splitAliases = (s) => String(s || '').split(/[;\n]/).map(x => x.trim()).filter(Boolean);
/** Every registered group of names for one organisation: the agreements register and FHIR client registrations. */
function aliasGroups() {
  const groups = db.all(`SELECT organisation, aliases FROM disclosure_agreements`).map(a => [a.organisation, ...splitAliases(a.aliases)]);
  for (const r of db.all(`SELECT value FROM settings WHERE key LIKE 'fhir_client:%'`)) {
    try { const reg = JSON.parse(r.value); if (reg && reg.recipient) groups.push([reg.recipient, ...(Array.isArray(reg.aliases) ? reg.aliases : [])]); } catch {}
  }
  return groups;
}
/** The names a recipient goes by: those given, plus every registered alias of an organisation they match. */
function recipientNames(recipient) {
  const given = (Array.isArray(recipient) ? recipient : [recipient]).map(x => String(x || '').trim()).filter(Boolean);
  const seen = new Set(given.map(normalise));
  const out = [...given];
  for (const group of aliasGroups()) {
    if (!group.some(n => seen.has(normalise(n)))) continue;
    for (const n of group) if (!seen.has(normalise(n))) { seen.add(normalise(n)); out.push(n); }
  }
  return out;
}
/** Does a consent (its type and plain recipient wording) name one of these recipient names? */
function consentNamesRecipient({ type, recipient }, names) {
  const r = normalise(recipient);
  const ns = names.map(normalise).filter(Boolean);
  if (!r || !ns.length) return false;
  if (type === 'part2_tpo') return ns.some(n => ` ${r} `.includes(` ${n} `));
  return ns.includes(r);
}
/** Is this recipient this programme itself, or one of its active staff? (the 'internal' export basis) */
function isInternalRecipient(recipient) {
  const r = normalise(recipient); if (!r) return false;
  if (r === normalise(db.getSetting('org_name', ''))) return true;
  return db.all(`SELECT username, display_name FROM users WHERE is_active=1`).some(u => normalise(u.username) === r || normalise(u.display_name) === r);
}

// ---- the agreements register (qsoa / research / audit_evaluation) ----
/** Why a registered agreement cannot authorise a disclosure today (empty when it can). */
function agreementProblems(a) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  if (a.status !== 'active') out.push('it has been ended');
  if (a.expires_at && a.expires_at < today) out.push('it has expired');
  if (a.agreement_date > today) out.push('it is not in force yet');
  if (a.kind !== 'qsoa' && !a.approving_body) out.push('it does not name the IRB or approving body');
  return out;
}
/** The names an agreement's organisation goes by. */
function agreementNames(a) { return [a.organisation, ...splitAliases(a.aliases)]; }
/**
 * Throws unless `agreementId` is a live registered agreement of the kind the basis needs, whose organisation
 * (or one of its aliases) is the recipient. With no id, the live agreement of that kind with the recipient is
 * found by name (the most recent, if there are several): either way the disclosure rests on one on file.
 * Returns the agreement row.
 */
function requireAgreement(basis, agreementId, recipient) {
  const label = AGREEMENT_KINDS[basis];
  let a = agreementId ? db.one(`SELECT * FROM disclosure_agreements WHERE id=?`, agreementId) : null;
  if (!agreementId) {
    const names = new Set(recipientNames(recipient).map(normalise));
    a = db.all(`SELECT * FROM disclosure_agreements WHERE kind=? AND status='active' ORDER BY agreement_date DESC, created_at DESC`, basis)
      .find(x => !agreementProblems(x).length && agreementNames(x).some(n => names.has(normalise(n)))) || null;
  }
  if (!a) {
    throw badRequest(basis === 'qsoa'
      ? 'A disclosure to a qualified service organization needs the qualified service organization agreement on file (§2.11, §2.12(c)(4)): register it under Privacy & Part 2 → Agreements, and choose it.'
      : `A ${basis === 'research' ? 'research (§2.52)' : 'audit or evaluation (§2.53)'} disclosure needs the ${label} on file — the IRB, privacy board or approving body, and its dates: register it under Privacy & Part 2 → Agreements, and choose it.`, { agreementRequired: basis });
  }
  if (a.kind !== basis) throw badRequest(`That is a ${AGREEMENT_KINDS[a.kind]}, not a ${label}.`);
  const problems = agreementProblems(a);
  if (problems.length) throw badRequest(`That ${label} cannot authorise a disclosure: ${problems.join('; ')}.`);
  const names = recipientNames(recipient);
  if (!names.length) throw badRequest('Name the recipient of the disclosure.');
  const theirs = new Set(agreementNames(a).map(normalise));
  if (!names.some(n => theirs.has(normalise(n)))) {
    throw new HttpError(409, `This ${label} is with "${a.organisation}"; it only covers disclosures to that organisation. Name it as the recipient, or choose the agreement with the organisation you are disclosing to.`, { agreementOrganisation: a.organisation });
  }
  return a;
}

/**
 * Throws unless a lawful basis covers this disclosure. The returned object carries what record() needs.
 *   recipient: who receives it — a name, or every name it goes by (a referral's resource name and
 *     organisation). Required for the consent and agreement bases.
 *   agreement_id: the registered agreement a qsoa / research / audit_evaluation disclosure rests on.
 *   recipient_override: a supervisor's decision that a consent covers a recipient it does not name in a way
 *     SUDS can match (a class, a misspelling) — disclosures:override and a written justification.
 *   allowed: the bases this path accepts (a referral: REFERRAL_BASES).
 *   legal_proceeding: the information is for use in a civil, criminal, administrative or legislative
 *     proceeding against the patient (§2.12(d)) — only a qualifying court order or a consent given for that
 *     alone (§2.31(d)) will do.
 *   counseling_notes: it includes SUD counseling notes (§2.11) — only a consent given for them alone, or
 *     a court order that expressly covers them.
 *   restriction_reviewed: the worker has checked the client's agreed restrictions, when there are any.
 */
function requireBasis(clientId, { consent_id, basis, justification, user, court_order_id, legal_proceeding, counseling_notes, restriction_reviewed, recipient, agreement_id, recipient_override, allowed } = {}) {
  const b = basis || 'consent';
  if (!BASES.includes(b)) throw badRequest(`"${b}" is not a lawful basis for disclosure`);
  if (allowed && !allowed.includes(b)) throw badRequest(`A referral can only be made with the client's consent, in a medical emergency, under a court order, or on a supervisor's justified override — not on a "${b.replace(/_/g, ' ')}" basis. Record that disclosure on the client's Consents tab instead.`);
  const canOverride = require('./auth').hasPerm(user, 'disclosures:override');
  // "Other" is not a basis anyone can tick to get past the consent check, and research, audit, a report of
  // a crime on the premises or of child abuse are decisions the programme answers for: only a supervisor or
  // an administrator may record one.
  if (OVERRIDE_BASES.includes(b) && !canOverride) {
    throw forbidden(b === 'other' ? 'Only a supervisor or administrator can record a disclosure on an "other" basis' : `Only a supervisor or administrator can record a disclosure on a "${b.replace(/_/g, ' ')}" basis`);
  }
  const proceeding = !!legal_proceeding; const notes = !!counseling_notes;
  if (proceeding && !['consent', 'court_order'].includes(b)) throw badRequest('Information for use in a proceeding against the patient may only be disclosed under a court order issued under 42 CFR §2.64/§2.65, or the patient\'s written consent given for that proceeding alone (§2.12(d), §2.31(d)). A subpoena on its own is not enough.');
  if (notes && !['consent', 'court_order'].includes(b)) throw badRequest('SUD counseling notes may only be disclosed under a consent given for counseling notes alone (§2.31(b)), or a court order that expressly covers them.');
  const why = String(justification || '').trim();

  let consent = null; let order = null; let agreement = null; let override = false;
  if (b === 'consent') {
    consent = activeConsent(clientId, consent_id, { elements: false });
    if (!consent) throw badRequest('A valid, unexpired consent must be selected before information can be shared. Record the consent first, or choose another lawful basis.');
    if (!disclosingConsentTypes().includes(consent.type)) {
      throw badRequest(consent.type === 'roi'
        ? 'A general release of information is not a 42 CFR Part 2 consent (§2.31, §2.32). Record a Part 2 consent with every required element, or choose another lawful basis.'
        : `A "${consent.type.replace(/_/g, ' ')}" consent does not authorise sharing information. Record a Part 2 consent, or choose another lawful basis.`);
    }
    // Re-checked here, whatever wrote the row: a consent that arrived by sync, by hand, or before the
    // element list existed authorises nothing unless it carries the §2.31 elements.
    const missing = consentElementProblems(consent);
    if (missing.length) throw badRequest(`This consent cannot authorise a disclosure: it does not record ${missing.join('; ')}. Record a new consent with every §2.31 element.`, { consentIncomplete: missing });
    if (proceeding && consent.type !== 'part2_proceedings') throw badRequest('Information for use in a proceeding against the patient needs a court order, or a consent given for that proceeding alone (§2.31(d)); this consent does not cover it.');
    if (!proceeding && consent.type === 'part2_proceedings') throw badRequest('A consent for use in a legal proceeding cannot be combined with any other purpose (§2.31(d)); use it only for the proceeding it names.');
    if (notes && consent.type !== 'part2_counseling_notes') throw badRequest('SUD counseling notes need a separate consent given for counseling notes alone (§2.31(b)); a treatment, payment and operations consent or a general Part 2 consent does not cover them.');
    if (!notes && consent.type === 'part2_counseling_notes') throw badRequest('A consent for SUD counseling notes covers counseling notes only (§2.31(b)); tick "includes SUD counseling notes", or rely on a different consent for other information.');
    // The consent covers the recipient it names, and no one else.
    const names = recipientNames(recipient);
    if (!names.length) throw badRequest('Name the recipient of the disclosure: the consent is checked against it.');
    const named = dec(consent.recipient_enc);
    if (!consentNamesRecipient({ type: consent.type, recipient: named }, names)) {
      if (!recipient_override) {
        throw new HttpError(409, `This consent covers disclosures to "${named}" only; it does not name ${names[0]}. Choose a consent that names this recipient, record a new one, or ask a supervisor to override with a written justification.`, { consentRecipient: named, recipientNotCovered: true });
      }
      if (!canOverride) throw forbidden('Only a supervisor or administrator can rely on a consent for a recipient it does not name');
      if (why.length < MIN_JUSTIFICATION) throw badRequest(`Relying on a consent for a recipient it does not name needs a written justification of at least ${MIN_JUSTIFICATION} characters, which is kept with the disclosure record.`);
      override = true;
    }
  }
  if (b === 'court_order') {
    order = court_order_id ? db.one(`SELECT * FROM court_orders WHERE id=? AND client_id=?`, court_order_id, clientId) : null;
    if (!order) throw badRequest('A disclosure under a court order must name the order: record it on the client\'s Consents tab (42 CFR subpart E) and choose it. A subpoena on its own does not authorise disclosing a Part 2 record.');
    const problems = courtOrderProblems(order);
    if (problems.length) throw badRequest(`That court order cannot authorise a disclosure: ${problems.join('; ')}.`);
    if (notes && !order.covers_counseling_notes) throw badRequest('That court order does not expressly cover SUD counseling notes.');
  }
  if (AGREEMENT_KINDS[b]) agreement = requireAgreement(b, agreement_id, recipient);
  if (!RESTRICTION_EXEMPT.includes(b) && !restriction_reviewed && agreedRestrictions(clientId)) {
    throw badRequest('This client has an agreed restriction on how their information is shared (see their Requests tab). Check that this disclosure respects it, then confirm.', { restrictionReview: true });
  }
  if (NEEDS_JUSTIFICATION.includes(b) && why.length < MIN_JUSTIFICATION) {
    throw badRequest(b === 'other'
      ? `Sharing without consent on an "other" basis needs a written justification of at least ${MIN_JUSTIFICATION} characters, which is kept with the disclosure record.`
      : b === 'medical_emergency'
        ? `A medical emergency disclosure (42 CFR §2.51) needs a written justification of at least ${MIN_JUSTIFICATION} characters: the nature of the emergency and who was told.`
        : `A ${b === 'crime_on_premises' ? 'report of a crime on the premises or against staff (§2.12(c)(5))' : 'mandated report of suspected child abuse or neglect (§2.12(c)(6))'} needs a written justification of at least ${MIN_JUSTIFICATION} characters: what happened, and what was reported to whom.`);
  }
  const kept = override ? `Recipient override (the consent names "${dec(consent.recipient_enc)}"): ${why}` : (why || null);
  return { basis: b, consent, court_order: order, agreement, justification: kept, legal_proceeding: proceeding, counseling_notes: notes, recipient_override: override };
}

/**
 * The same gate for an identified export: one basis for the whole file, checked against every client in
 * it. A proceeding against a patient is never a bulk export. Returns { basis, agreement, consentOf, excluded }:
 *   consent — each client is included only with a live Part 2 consent of a file type (not counseling notes
 *     or a proceeding) that carries the §2.31 elements and names the stated recipient; consentOf maps each
 *     included client to it, and `excluded` lists the rest, which the caller leaves out of the file;
 *   qsoa / research / audit_evaluation — a registered agreement with the recipient (and, for research and
 *     audit, a supervisor or administrator), covering the whole file;
 *   internal — the recipient is this programme or one of its staff.
 * Called with no client ids first (the basis alone), then with the file's clients once its rows are known.
 */
function requireExportBasis(clientIds, { basis, restriction_reviewed, legal_proceeding, recipient, agreement_id, user } = {}) {
  if (legal_proceeding) throw badRequest('Records for use in a legal proceeding against a patient are disclosed one client at a time, under a recorded court order or a proceedings-only consent (Consents tab → Record a disclosure), never as a bulk export.');
  if (!basis) throw badRequest(`An identified export must state its lawful basis (basis=${EXPORT_BASES.join('|')}); it is written to the accounting of disclosures for every client in the file`);
  if (!EXPORT_BASES.includes(basis)) throw badRequest(`"${basis}" is not a basis an identified export can be made under (${EXPORT_BASES.join(', ')})`);
  if (OVERRIDE_BASES.includes(basis) && !require('./auth').hasPerm(user, 'disclosures:override')) throw forbidden(`Only a supervisor or administrator can make an export on a "${basis.replace(/_/g, ' ')}" basis`);
  if (basis === 'internal' && !isInternalRecipient(recipient)) {
    throw badRequest(`An "internal" export stays within this program (§2.12(c)(3)): the recipient must be ${db.getSetting('org_name', '') || 'this program'} or one of its staff (their name or username). A file for anyone else needs another basis.`);
  }
  const agreement = AGREEMENT_KINDS[basis] ? requireAgreement(basis, agreement_id, recipient) : null;
  const consentOf = new Map(); const excluded = [];
  if (basis === 'consent') {
    const names = recipientNames(recipient);
    for (const id of clientIds) { const c = fileConsentFor(id, names); if (c) consentOf.set(id, c.id); else excluded.push(id); }
  }
  const out = new Set(excluded);
  requireRestrictionReview(clientIds.filter(id => !out.has(id)), restriction_reviewed);
  return { basis, agreement, consentOf, excluded };
}

/**
 * The newest live consent that can put this client in a file for this recipient: a file consent type
 * (fileConsentTypes) with the §2.31 elements that names one of `names`. Null when there is none.
 */
function fileConsentFor(clientId, names) {
  const types = fileConsentTypes();
  if (!names.length || !types.length) return null;
  const rows = db.all(`SELECT * FROM consents WHERE client_id=? AND type IN (${types.map(() => '?').join(',')}) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now')) ORDER BY signed_at DESC, created_at DESC`, clientId, ...types);
  return rows.find(c => !consentElementProblems(c).length && consentNamesRecipient({ type: c.type, recipient: dec(c.recipient_enc) }, names)) || null;
}

/**
 * Throws unless the worker has confirmed checking the agreed restrictions of every client in a file that has
 * one (restriction_reviewed=1): the file-sized form of requireBasis's restriction check.
 */
function requireRestrictionReview(clientIds, restriction_reviewed) {
  if (restriction_reviewed || !clientIds.length) return;
  const restricted = new Set(db.all(`SELECT DISTINCT client_id FROM patient_requests WHERE kind='restriction' AND status='fulfilled'`).map(r => r.client_id));
  const n = clientIds.filter(id => restricted.has(id)).length;
  if (n) throw badRequest(`${n} client${n === 1 ? '' : 's'} in this export ${n === 1 ? 'has' : 'have'} an agreed restriction on how their information is shared. Check the export respects it, then confirm (restriction_reviewed=1).`, { restrictionReview: true, restrictedClients: n });
}

/** Write the disclosure row. Caller has already established the basis. */
function record({ id: givenId = null, clientId, consentId = null, courtOrderId = null, agreementId = null, recipientOverride = false, legalProceeding = false, counselingNotes = false, recipient, purpose, what, method = null, basis = 'consent', justification = null, source = 'manual', sourceRef = null, disclosedAt = null, user, ip }) {
  // givenId: a device's own accounting row for the same disclosure (a referral made offline), so the office's
  // row replaces it rather than standing beside it (server/routes/referrals.js pushDisclosure).
  const id = givenId || uuid();
  const at = disclosedAt || db.now();
  const noticeVersion = part2Program() ? C.PART2_NOTICE_VERSION : null;
  db.run(`INSERT INTO disclosures(id,client_id,consent_id,recipient_enc,purpose_enc,what_enc,method,disclosed_at,disclosed_by,basis,justification_enc,source,source_ref,court_order_id,legal_proceeding,counseling_notes,notice_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, clientId, consentId, encrypt(String(recipient)), encrypt(String(purpose)), encrypt(String(what)), method, at, user.id, basis, justification ? encrypt(String(justification)) : null, source, sourceRef,
    courtOrderId, legalProceeding ? 1 : 0, counselingNotes ? 1 : 0, noticeVersion);
  // The audit trail records that a disclosure happened and under what authority — never to whom or what,
  // which is PHI and lives only in the encrypted columns above.
  audit.log({ user, action: 'disclosure.record', entity: 'disclosure', entityId: id, clientId, ip, details: { basis, source, consent_id: consentId || undefined, court_order_id: courtOrderId || undefined, agreement_id: agreementId || undefined,
    recipient_override: recipientOverride ? true : undefined, justified: justification ? true : undefined,
    legal_proceeding: legalProceeding ? true : undefined, counseling_notes: counselingNotes ? true : undefined, notice: noticeVersion || undefined } });
  return id;
}

/**
 * Account for one CalOMS Tx submission: one row per client it contains, under the state-reporting basis.
 * No consent is needed or checked and no agreed restriction can stop it — the disclosure is required by law
 * — but it is still accounted for, with the same fields as any other (never a proceeding, no counseling
 * notes, the version of the §2.32 notice the extract's README carries).
 */
function recordStateReport({ clientIds, what, sourceRef, user, ip }) {
  return clientIds.map(clientId => record({ clientId, recipient: STATE_REPORTING.recipient, purpose: STATE_REPORTING.purpose, what, method: 'export', basis: STATE_REPORTING.basis, source: 'caloms', sourceRef, user, ip }));
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

// ---- FHIR API (server/routes/fhir.js) ----
// Every FHIR response that names a client is a disclosure to the organisation that registered the FHIR
// client, made with no worker in the loop. It is allowed only for clients that requireBasis would let a
// worker disclose to that organisation for that purpose without asking anything further; everyone else is
// left out of the answer. The rule lives here, next to requireBasis, so there is one definition of
// "consent covers this" (docs/integration/FHIR.md, "Consent"):
//   * the consent types are those requireBasis accepts (disclosingConsentTypes): while this is a Part 2
//     programme a general release of information ('roi') is not a Part 2 consent and never covers FHIR;
//     a consent for SUD counseling notes only, or for a legal proceeding only, never does either (FHIR is
//     always treatment, payment or operations, and sends no note text);
//   * a named-recipient consent (part2_disclosure, or 'roi' outside Part 2) must name the organisation
//     (or one of its registered aliases) and cover the purpose of use;
//   * the 2024 rule's single TPO consent (part2_tpo, §2.31(a)(4)(iii)) covers every FHIR purpose of use —
//     treatment, payment and health care operations are exactly what it is for — for a recipient it names,
//     alone or within a list or class wording ("County Behavioral Health and my other treating providers").
//     A class with no name in it ("my health plans") cannot be matched by a machine and does not cover FHIR;
//   * a client with an agreed restriction (§2.26) is withheld entirely: requireBasis makes a worker confirm
//     the disclosure respects it, and there is no worker to confirm an automated one.

// Purposes of use a FHIR client can be registered for (HL7 v3 ActReason codes), and the words a consent's
// purpose must contain to cover them. A consent for "treatment, payment and health care operations" (or
// one that says "TPO") covers all three.
const FHIR_PURPOSES = {
  TREAT: { display: 'Treatment', words: ['treatment', 'care coordination', 'coordination of care', 'continuity of care'] },
  HPAYMT: { display: 'Payment', words: ['payment', 'billing', 'claims'] },
  HOPERAT: { display: 'Health care operations', words: ['operations'] },
};
// Every consent type that can ever authorise a FHIR disclosure; which of them do right now depends on the
// Part 2 programme setting (fhirConsentTypes). A 'treatment' consent is consent to be treated here, not to
// have records sent elsewhere.
const FHIR_CONSENT_TYPES = ['part2_disclosure', 'part2_tpo', 'roi'];
/** The consent types that cover a FHIR disclosure in this programme, as requireBasis would accept them. */
function fhirConsentTypes() {
  const ok = disclosingConsentTypes();
  return FHIR_CONSENT_TYPES.filter(t => ok.includes(t));
}
function isTpo(purpose) {
  const p = ` ${normalise(purpose)} `;
  return / tpo /.test(p) || (p.includes('treatment') && p.includes('payment') && p.includes('operations'));
}
/**
 * Does this (decrypted) consent name the recipient organisation and cover the purpose of use? `type` is the
 * consent's type; when it is omitted only the recipient and purpose wording are compared.
 */
function consentCovers({ type, recipient, purpose }, { recipients, purposeOfUse }) {
  if (type !== undefined && !fhirConsentTypes().includes(type)) return false;
  // The recipient is matched exactly as on every other path (consentNamesRecipient, above).
  if (!consentNamesRecipient({ type, recipient }, recipients)) return false;
  // A TPO consent covers every FHIR purpose of use: treatment, payment and operations are what it is for.
  if (type === 'part2_tpo') return !!FHIR_PURPOSES[purposeOfUse];
  if (isTpo(purpose)) return true;
  const p = ` ${normalise(purpose)} `;
  return (FHIR_PURPOSES[purposeOfUse]?.words || []).some(w => p.includes(` ${normalise(w)} `));
}
/** The FHIR purposes of use a consent of this type and purpose wording covers (for the Consent resource). */
function consentPurposeCodes({ type, purpose }) {
  return Object.keys(FHIR_PURPOSES).filter(code => type === 'part2_tpo' || consentCovers({ recipient: 'x', purpose }, { recipients: ['x'], purposeOfUse: code }));
}

// The covering consents are worked out once per request from every live consent of a sharing type, and
// cached until any consent or patient request changes (a revocation stamps updated_at, a restriction is
// agreed), the Part 2 programme setting changes, or the date turns (expiry).
const coverageCache = new Map();
/**
 * Map of client id -> id of the consent that covers disclosure to this FHIR recipient for this purpose (the
 * most recently signed one). Clients who were merged away or deleted, and clients with an agreed
 * restriction, are never covered.
 */
function fhirCoverage({ cacheKey, recipients, purposeOfUse }) {
  const stamp = db.one(`SELECT (SELECT COUNT(*) FROM consents) n, (SELECT MAX(updated_at) FROM consents) u,
    (SELECT COUNT(*) FROM patient_requests) rn, (SELECT MAX(updated_at) FROM patient_requests) ru`);
  const today = new Date().toISOString().slice(0, 10);
  const types = fhirConsentTypes();
  const key = `${stamp.n}|${stamp.u}|${stamp.rn}|${stamp.ru}|${types.join(',')}|${today}|${recipients.join('\u0001')}|${purposeOfUse}`;
  const hit = coverageCache.get(cacheKey);
  if (hit && hit.key === key) return hit.map;
  const map = new Map();
  const restricted = new Set(db.all(`SELECT DISTINCT client_id FROM patient_requests WHERE kind='restriction' AND status='fulfilled'`).map(r => r.client_id));
  const rows = types.length ? db.all(`SELECT k.* FROM consents k JOIN clients c ON c.id=k.client_id
    WHERE k.type IN (${types.map(() => '?').join(',')}) AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at >= date('now'))
      AND c.deleted_at IS NULL AND c.merged_into IS NULL ORDER BY k.signed_at, k.created_at`, ...types) : [];
  for (const row of rows) {
    if (restricted.has(row.client_id)) continue;
    // A consent without the §2.31 elements authorises nothing here either (as requireBasis re-checks them).
    if (consentElementProblems(row).length) continue;
    let plain;
    try { plain = { type: row.type, recipient: row.recipient_enc ? decrypt(row.recipient_enc) : '', purpose: row.purpose_enc ? decrypt(row.purpose_enc) : '' }; } catch { continue; }
    if (consentCovers(plain, { recipients, purposeOfUse })) map.set(row.client_id, row.id);
  }
  if (coverageCache.size > 100) coverageCache.clear();
  coverageCache.set(cacheKey, { key, map });
  return map;
}

/**
 * Record one accounting-of-disclosures row per client for one FHIR request (or one bulk export), in one
 * transaction. `perClient` maps client id -> { consentId, what }. Returns the number of rows written. A FHIR
 * disclosure is never for a proceeding and never includes counseling notes (record() stores both as 0), and
 * record() stores the version of the §2.32 notice the response carried.
 */
function recordFhir({ perClient, recipient, purposeOfUse, sourceRef, user, ip }) {
  if (!perClient.size) return 0;
  const purpose = `${FHIR_PURPOSES[purposeOfUse]?.display || purposeOfUse} (FHIR purpose of use ${purposeOfUse})`;
  db.transaction(() => {
    for (const [clientId, { consentId, what }] of perClient) {
      record({ clientId, consentId, recipient, purpose, what, method: 'FHIR API', basis: 'consent', source: 'fhir', sourceRef, user, ip });
    }
  });
  return perClient.size;
}

module.exports = { BASES, EXPORT_BASES, SYSTEM_BASES, STATE_REPORTING, NEEDS_JUSTIFICATION, OVERRIDE_BASES, REFERRAL_BASES, AGREEMENT_KINDS, LEGACY_CONSENT_CUTOFF, MIN_JUSTIFICATION, part2Program, notice, fileNotice,
  disclosingConsentTypes, fileConsentTypes, activeConsent, courtOrderProblems, agreedRestrictions, missingPart2Elements, missingLegacyElements, consentElementProblems, consentValues,
  normalise, recipientNames, consentNamesRecipient, isInternalRecipient, agreementProblems, agreementNames, requireAgreement, fileConsentFor,
  requireBasis, requireExportBasis, requireRestrictionReview, record, recordStateReport, present, accounting, FHIR_PURPOSES, FHIR_CONSENT_TYPES, fhirConsentTypes, consentCovers, consentPurposeCodes, fhirCoverage, recordFhir };
