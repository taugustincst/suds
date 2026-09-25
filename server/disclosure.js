'use strict';
// Accounting of disclosures (HIPAA §164.528 and 42 CFR Part 2 §2.13). Anything that sends identifiable
// client information outside SUDS records a row here — that is what makes consent more than a checkbox.
const db = require('./db');
const audit = require('./audit');
const { encrypt, decrypt, uuid } = require('./crypto');
const { badRequest, forbidden } = require('./http');

// Every lawful basis a disclosure can be recorded under. 'consent' needs a live consent; the Part 2
// exceptions (§2.51 medical emergency, §2.61-65 court order, §2.53 audit/evaluation, §2.52 research, §2.12(c)(5)
// crime on premises, §2.12(c)(6) child abuse reporting, §2.12(c)(3) qualified service organisation) stand on
// their own; 'other' is an override reserved for supervisors and administrators, and both it and a medical
// emergency must say why in writing. 'export' is what an identified export records and is never chosen by hand.
const BASES = ['consent', 'court_order', 'medical_emergency', 'qsoa', 'audit_evaluation', 'research', 'crime_on_premises', 'child_abuse_report', 'other'];
const NEEDS_JUSTIFICATION = ['other', 'medical_emergency'];
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

/** A consent is usable only while it exists, is unrevoked and has not expired. */
function activeConsent(clientId, consentId) {
  if (!consentId) return null;
  return db.one(`SELECT * FROM consents WHERE id=? AND client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, consentId, clientId) || null;
}

/**
 * Throws unless a valid consent covers this disclosure, or another lawful basis is given. The returned
 * object carries what record() needs, including the written justification where the basis requires one.
 */
function requireBasis(clientId, { consent_id, basis, justification, user } = {}) {
  const b = basis || 'consent';
  if (!BASES.includes(b)) throw badRequest(`"${b}" is not a lawful basis for disclosure`);
  if (b === 'consent') {
    const consent = activeConsent(clientId, consent_id);
    if (!consent) throw badRequest('A valid, unexpired consent must be selected before information can be shared. Record the consent first, or choose another lawful basis.');
    return { basis: 'consent', consent, justification: null };
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
  return { basis: b, consent: null, justification: why || null };
}

/** Write the disclosure row. Caller has already established the basis. */
function record({ clientId, consentId = null, recipient, purpose, what, method = null, basis = 'consent', justification = null, source = 'manual', sourceRef = null, disclosedAt = null, user, ip }) {
  const id = uuid();
  const at = disclosedAt || db.now();
  db.run(`INSERT INTO disclosures(id,client_id,consent_id,recipient_enc,purpose_enc,what_enc,method,disclosed_at,disclosed_by,basis,justification_enc,source,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, clientId, consentId, encrypt(String(recipient)), encrypt(String(purpose)), encrypt(String(what)), method, at, user.id, basis, justification ? encrypt(String(justification)) : null, source, sourceRef);
  // The audit trail records that a disclosure happened and under what authority — never to whom or what,
  // which is PHI and lives only in the encrypted columns above.
  audit.log({ user, action: 'disclosure.record', entity: 'disclosure', entityId: id, clientId, ip, details: { basis, source, consent_id: consentId || undefined, justified: justification ? true : undefined } });
  return id;
}

/**
 * Account for one CalOMS Tx submission: one row per client it contains, under the state-reporting basis.
 * No consent is needed or checked — the disclosure is required by law — but it is still accounted for.
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
 * The accounting of disclosures for one client (§164.528 / §2.13): what was shared, with whom, why, on what
 * authority, by whom and when — plus the consents those disclosures relied on. Audited by the caller.
 */
function accounting(clientId) {
  const client = db.one(`SELECT id, client_code FROM clients WHERE id=?`, clientId);
  const disclosures = db.all(`SELECT d.*, u.display_name AS disclosed_by_name, u.username AS disclosed_by_username FROM disclosures d JOIN users u ON u.id=d.disclosed_by WHERE d.client_id=? ORDER BY d.disclosed_at`, clientId).map(present);
  const consents = db.all(`SELECT id, type, recipient_enc, purpose_enc, signed_at, expires_at, expires_event, revoked_at FROM consents WHERE client_id=? ORDER BY signed_at`, clientId)
    .map(c => ({ id: c.id, type: c.type, recipient: c.recipient_enc ? decrypt(c.recipient_enc) : null, purpose: c.purpose_enc ? decrypt(c.purpose_enc) : null, signed_at: c.signed_at, expires_at: c.expires_at, expires_event: c.expires_event, revoked_at: c.revoked_at }));
  return { client_id: client?.id, client_code: client?.client_code, generated_at: db.now(), disclosures, consents };
}

// ---- FHIR API (server/routes/fhir.js) ----
// Every FHIR response that names a client is a disclosure to the organisation that registered the FHIR
// client. It is allowed only while that client has a live consent naming the organisation for the purpose
// the FHIR client was registered with; everyone else is left out of the answer. The rule lives here, next
// to requireBasis, so there is one definition of "consent covers this".

// Purposes of use a FHIR client can be registered for (HL7 v3 ActReason codes), and the words a consent's
// purpose must contain to cover them. A consent for "treatment, payment and health care operations" (or
// one that says "TPO") covers all three.
const FHIR_PURPOSES = {
  TREAT: { display: 'Treatment', words: ['treatment', 'care coordination', 'coordination of care', 'continuity of care'] },
  HPAYMT: { display: 'Payment', words: ['payment', 'billing', 'claims'] },
  HOPERAT: { display: 'Health care operations', words: ['operations'] },
};
// Consent types that authorise sharing with a named outside recipient. A 'treatment' consent is consent to
// be treated here, not to have records sent elsewhere.
const FHIR_CONSENT_TYPES = ['part2_disclosure', 'roi'];
const normalise = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function isTpo(purpose) {
  const p = ` ${normalise(purpose)} `;
  return / tpo /.test(p) || (p.includes('treatment') && p.includes('payment') && p.includes('operations'));
}
/** Does this (decrypted) consent name the recipient organisation and cover the purpose of use? */
function consentCovers({ recipient, purpose }, { recipients, purposeOfUse }) {
  const r = normalise(recipient);
  if (!r || !recipients.map(normalise).filter(Boolean).includes(r)) return false;
  if (isTpo(purpose)) return true;
  const p = ` ${normalise(purpose)} `;
  return (FHIR_PURPOSES[purposeOfUse]?.words || []).some(w => p.includes(` ${normalise(w)} `));
}

// The covering consents are worked out once per request from every live consent of a sharing type, and
// cached until any consent changes (a revocation stamps updated_at) or the date turns (expiry).
const coverageCache = new Map();
/**
 * Map of client id -> id of the consent that covers disclosure to this FHIR recipient for this purpose (the
 * most recently signed one). Clients who were merged away or deleted are never covered.
 */
function fhirCoverage({ cacheKey, recipients, purposeOfUse }) {
  const stamp = db.one(`SELECT COUNT(*) n, MAX(updated_at) u FROM consents`);
  const today = new Date().toISOString().slice(0, 10);
  const key = `${stamp.n}|${stamp.u}|${today}|${recipients.join('\u0001')}|${purposeOfUse}`;
  const hit = coverageCache.get(cacheKey);
  if (hit && hit.key === key) return hit.map;
  const map = new Map();
  const rows = db.all(`SELECT k.id, k.client_id, k.recipient_enc, k.purpose_enc FROM consents k JOIN clients c ON c.id=k.client_id
    WHERE k.type IN (${FHIR_CONSENT_TYPES.map(() => '?').join(',')}) AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at >= date('now'))
      AND c.deleted_at IS NULL AND c.merged_into IS NULL ORDER BY k.signed_at, k.created_at`, ...FHIR_CONSENT_TYPES);
  for (const row of rows) {
    let plain;
    try { plain = { recipient: row.recipient_enc ? decrypt(row.recipient_enc) : '', purpose: row.purpose_enc ? decrypt(row.purpose_enc) : '' }; } catch { continue; }
    if (consentCovers(plain, { recipients, purposeOfUse })) map.set(row.client_id, row.id);
  }
  if (coverageCache.size > 100) coverageCache.clear();
  coverageCache.set(cacheKey, { key, map });
  return map;
}

/**
 * Record one accounting-of-disclosures row per client for one FHIR request (or one bulk export), in one
 * transaction. `perClient` maps client id -> { consentId, what }. Returns the number of rows written.
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

// 42 CFR §2.32(a)(1): the notice that must accompany each disclosure made with the patient's consent.
const PART2_NOTICE = 'This record which has been disclosed to you is protected by Federal confidentiality rules (42 CFR part 2). '
  + 'These rules prohibit you from using or disclosing this record, or testimony that describes the information contained in this record, in any civil, criminal, administrative, or legislative proceedings by any Federal, State, or local authority, against the patient, unless authorized by the consent of the patient, except as provided at 42 CFR 2.12(c)(5) or as authorized by a court in accordance with 42 CFR 2.64 or 2.65. '
  + 'In addition, the Federal rules prohibit you from making any further disclosure of this record unless authorized by the written consent of the person to whom it pertains, or as otherwise permitted by 42 CFR part 2. '
  + 'A general authorization for the release of medical or other information is not sufficient for this purpose (see 42 CFR 2.31). '
  + 'The Federal rules restrict any use of the information to investigate or prosecute with regard to a crime any patient with a substance use disorder, except as provided at 42 CFR 2.12(c)(5) and 2.65.';

module.exports = { BASES, SYSTEM_BASES, STATE_REPORTING, recordStateReport, NEEDS_JUSTIFICATION, MIN_JUSTIFICATION, activeConsent, requireBasis, record, present, accounting, FHIR_PURPOSES, FHIR_CONSENT_TYPES, consentCovers, fhirCoverage, recordFhir, PART2_NOTICE };
