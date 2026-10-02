'use strict';
// The rules for the accounting of disclosures (HIPAA §164.528, 42 CFR §2.25), for POST
// /api/clients/:id/disclosures and sync push. A device may add to it, never rewrite or delete it. A referral's
// accounting row is the office's to write (server/rules/referrals.js re-checks the basis the device recorded and
// writes its own row under the same id). Any other disclosure recorded on a device is checked against the same
// gate the REST route uses (disclosure.requireBasis); one that fails it is still recorded, because the accounting
// is of something that already happened, and the office is told to look at it.
const { define, flag } = require('./core');

module.exports = define({
  table: 'disclosures',
  deviceColumns: ['source', 'source_ref', 'notice_version'], createdBy: ['disclosed_by'],
  fields: {
    consent_id: { type: 'string' }, disclosed_to: { type: 'string', required: true, maxLen: 200, column: 'recipient_enc' }, purpose: { type: 'string', required: true, maxLen: 500 },
    info_disclosed: { type: 'string', required: true, maxLen: 1000, column: 'what_enc' }, method: { type: 'string', maxLen: 60 }, disclosed_at: { type: 'datetime', required: true },
    basis: { type: 'string', enum: require('../disclosure').BASES }, justification: { type: 'string', maxLen: 2000 }, court_order_id: { type: 'string' },
    legal_proceeding: { type: 'boolean' }, counseling_notes: { type: 'boolean' },
    agreement_id: { type: 'string', sync: false }, recipient_override: { type: 'boolean', sync: false }, restriction_reviewed: { type: 'boolean', sync: false },
  },
  immutable: true, tombstone: 'never',
  // A device's accounting row the office has just replaced with its own (same id) is already on file.
  order(rows, s) {
    const done = (s.state.referrals || {}).accountedByOffice;
    return done && done.size ? rows.filter(r => !(r && done.has(r.id))) : rows;
  },
  check(row, c) {
    if (c.via !== 'sync' || c.existing || row.source === 'referral') return null;
    try {
      // A device's row carries its free text as written (rules/push.js): the purpose is checked against the consent
      // as on the office, and a supervisor's consent override the device recorded is read back from its justification.
      const D = require('../disclosure'); const over = D.parseOverride(row.justification_enc);
      D.requireBasis(row.client_id, { consent_id: row.consent_id, basis: row.basis || 'consent', justification: over.why, court_order_id: row.court_order_id,
        legal_proceeding: !!row.legal_proceeding, counseling_notes: !!row.counseling_notes, recipient: row.recipient_enc, purpose: row.purpose_enc, recipient_override: over.override, restriction_reviewed: true, user: c.user });
      return null;
    } catch (e) {
      return flag('was recorded, but the office could not confirm the basis it was made under; the privacy officer will review it', { code: 'disclosure_basis' });
    }
  },
});
