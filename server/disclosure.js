'use strict';
// Accounting of disclosures (HIPAA §164.528 and 42 CFR Part 2 §2.13). Anything that sends identifiable
// client information outside SUDS records a row here — that is what makes consent more than a checkbox.
const db = require('./db');
const audit = require('./audit');
const { encrypt, decrypt, uuid } = require('./crypto');
const { badRequest } = require('./http');

/** A consent is usable only while it exists, is unrevoked and has not expired. */
function activeConsent(clientId, consentId) {
  if (!consentId) return null;
  return db.one(`SELECT * FROM consents WHERE id=? AND client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, consentId, clientId) || null;
}

/** Throws unless a valid consent covers this disclosure, or another lawful basis is given. */
function requireBasis(clientId, { consent_id, basis }) {
  const b = basis || 'consent';
  if (b !== 'consent') return { basis: b, consent: null };
  const consent = activeConsent(clientId, consent_id);
  if (!consent) throw badRequest('A valid, unexpired consent must be selected before information can be shared. Record the consent first, or choose another lawful basis.');
  return { basis: 'consent', consent };
}

/** Write the disclosure row. Caller has already established the basis. */
function record({ clientId, consentId = null, recipient, purpose, what, method = null, basis = 'consent', source = 'manual', sourceRef = null, disclosedAt = null, user, ip }) {
  const id = uuid();
  const at = disclosedAt || db.now();
  db.run(`INSERT INTO disclosures(id,client_id,consent_id,recipient_enc,purpose_enc,what_enc,method,disclosed_at,disclosed_by,basis,source,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, clientId, consentId, encrypt(String(recipient)), encrypt(String(purpose)), encrypt(String(what)), method, at, user.id, basis, source, sourceRef);
  // The audit trail records that a disclosure happened and under what authority — never to whom or what,
  // which is PHI and lives only in the encrypted columns above.
  audit.log({ user, action: 'disclosure.record', entity: 'disclosure', entityId: id, clientId, ip, details: { basis, source, consent_id: consentId || undefined } });
  return id;
}

/** Decrypt a disclosure row for display. */
function present(row) {
  if (!row) return null;
  const out = { ...row };
  out.recipient = row.recipient_enc ? decrypt(row.recipient_enc) : null;
  out.purpose = row.purpose_enc ? decrypt(row.purpose_enc) : null;
  out.what = row.what_enc ? decrypt(row.what_enc) : null;
  delete out.recipient_enc; delete out.purpose_enc; delete out.what_enc;
  return out;
}

module.exports = { activeConsent, requireBasis, record, present };
