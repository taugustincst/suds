'use strict';
// The rules for consents: the legal record of what a client agreed to share. A device may record one, and may
// revoke one; it can never rewrite one. A new consent needs what the consent form requires (the §2.31 elements
// for a Part 2 consent, 2024 or the pre-2024 list for a legacy row signed before the 2024 rule's compliance
// date); disclosure.requireBasis re-checks the elements whenever one is relied on, however it arrived.
const C = require('../constants');

// A recipient may be a list of named partner agencies (the consent form's directory picker), so up to 2,000.
const RECIPIENT_MAX = 2000;
const { define, refuse } = require('./core');

/** Why a new consents row (encrypted columns in plain text) cannot be accepted, or null. */
function consentProblem(row) {
  const disclosure = require('../disclosure');
  if (!C.CONSENT_TYPES.includes(row.type)) return refuse(`has a value the office does not accept (consent type "${String(row.type).slice(0, 40)}")`);
  // The coded categories of information it covers (what the FHIR API honours): known codes only.
  const cats = String(row.info_categories || '').split(',').map(x => x.trim()).filter(Boolean);
  const unknownCat = cats.find(x => !C.CONSENT_INFO_CATEGORIES.includes(x));
  if (unknownCat) return refuse(`has a value the office does not accept (information category "${unknownCat.slice(0, 40)}")`);
  if (!C.PART2_CONSENT_TYPES.includes(row.type)) return null;
  const v = { discloser: row.discloser, recipient: row.recipient_enc, purpose: row.purpose_enc, scope: row.scope_enc, expires_at: row.expires_at, expires_event: row.expires_event, document_ref: row.document_ref_enc ?? row.document_ref,
    signed_on_paper: row.signed_on_paper, witness: row.witness_enc ?? row.witness, signer_relationship: row.signer_relationship, signer_name: row.signer_name_enc, revocation_right_given: row.revocation_right_given,
    redisclosure_notice_given: row.redisclosure_notice_given, refusal_consequences_given: row.refusal_consequences_given, signed_at: row.signed_at };
  const missing = row.rule_version === '2024' ? disclosure.missingPart2Elements(v) : disclosure.missingLegacyElements(v);
  if (missing.length) return refuse(`is missing a required field: a 42 CFR Part 2 consent must record ${missing.join('; ')}`);
  if (row.expires_at && row.signed_at && row.expires_at < row.signed_at) return refuse('has a value the office does not accept (it expires before it was signed)', { message: 'A consent cannot expire before it was signed' });
  return null;
}

module.exports = define({
  table: 'consents',
  deviceColumns: ['revoked_at', 'revoked_reason_enc', 'rule_version', 'info_categories'], createdBy: ['created_by'],
  fields: {
    type: { type: 'string', required: true, enum: C.CONSENT_TYPES }, recipient: { type: 'string', maxLen: RECIPIENT_MAX }, purpose: { type: 'string', maxLen: 500 }, scope: { type: 'string', maxLen: 1000 },
    signed_at: { type: 'date', required: true }, expires_at: { type: 'date' }, expires_event: { type: 'string', maxLen: 200 }, document_ref: { type: 'string', maxLen: 300 }, witness: { type: 'string', maxLen: 120 },
    signed_on_paper: { type: 'boolean' }, redisclosure_notice_given: { type: 'boolean' },
    discloser: { type: 'string', maxLen: 200 }, signer_relationship: { type: 'string', enum: C.CONSENT_SIGNERS }, signer_name: { type: 'string', maxLen: 200 },
    revocation_right_given: { type: 'boolean' }, refusal_consequences_given: { type: 'boolean' },
  },
  immutable: true, tombstone: 'never',
  // The one permitted change: revoking a consent that is not yet revoked, which changes nothing else.
  allowChange(existing, row, changed, c) {
    if (existing.revoked_at || !row.revoked_at || !changed.every(col => ['revoked_at', 'revoked_reason_enc', 'revoked_by'].includes(col))) return null;
    row.revoked_by = c.user.id;
    return ['revoked_at', 'revoked_reason_enc', 'revoked_by'];
  },
  check(row, c) { return c.existing ? null : consentProblem(row); },
});
module.exports.consentProblem = consentProblem;
module.exports.RECIPIENT_MAX = RECIPIENT_MAX;
