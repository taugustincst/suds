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

module.exports = { BASES, NEEDS_JUSTIFICATION, MIN_JUSTIFICATION, activeConsent, requireBasis, record, present, accounting };
