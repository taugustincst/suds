'use strict';
// The rules for referrals. A referral that shares information is a disclosure, whichever way it reaches the
// office: a warm hand-off made offline, a pending referral progressed on the phone, or a shared one re-pointed
// at another agency passes the same gate as PUT /api/referrals/:id and is accounted here
// (routes/referrals.js pushDisclosure). A refusal is for good (the device shows it) and audited, by reason code.
const db = require('../db');
const { define, refuse } = require('./core');
const { ownedBy } = require('./shared');

const OTHERS = ['status', 'outcome_enc', 'barrier_enc', 'admitted_at', 'closed_at', 'outcome_recorded_at', 'consent_id', 'consent_revoked'];

module.exports = define({
  table: 'referrals',
  deviceColumns: ['consent_revoked', 'outcome_recorded_at'],
  fields: {
    client_id: { type: 'string', required: true }, resource_id: { type: 'string', required: true }, user_id: { type: 'string' }, referred_at: { type: 'datetime', required: true },
    status: { type: 'string', list: 'REFERRAL_STATUSES' }, urgency: { type: 'string', enum: ['routine', 'urgent', 'emergent'] }, appointment_at: { type: 'datetime' }, admitted_at: { type: 'datetime' },
    closed_at: { type: 'datetime' }, outcome: { type: 'string', maxLen: 500 }, barrier: { type: 'string', maxLen: 300 }, warm_handoff: { type: 'boolean' }, consent_id: { type: 'string' },
    follow_up_due: { type: 'date' }, notes: { type: 'string', maxLen: 2000 }, episode_id: { type: 'string' },
  },
  owner: { col: 'user_id', all: 'records:manage-others' },
  editableBy: ownedBy(['user_id'], 'records:manage-others'),
  // What anyone on the caseload may change on someone else's referral: its outcome (POST /api/referrals/:id/outcome
  // is not the maker's alone), and the flag a consent's revocation sets on the referrals that relied on it.
  othersMayChange: (existing, row, changed) => changed.every(col => OTHERS.includes(col)),
  check(row, c) {
    const e = c.existing || {};
    const resource = row.resource_id !== undefined ? row.resource_id : e.resource_id;
    if ((!c.existing || resource !== e.resource_id) && !db.one(`SELECT 1 FROM resources WHERE id=?`, resource)) return refuse('refers to a record the office server does not have', { message: 'Unknown resource' });
    // The consent a referral cites is this client's: citing another client's consent would let one person's
    // agreement stand for another's disclosure.
    const consent = row.consent_id !== undefined ? row.consent_id : e.consent_id;
    const clientId = c.existing ? e.client_id : row.client_id;
    if (consent && consent !== e.consent_id && !db.one(`SELECT 1 FROM consents WHERE id=? AND client_id=?`, consent, clientId)) return refuse('has a value the office does not accept (the consent it cites is another client\'s)', { message: 'That consent belongs to a different client' });
    return null;
  },
  // The accounting rows a device's own referral gate wrote offline, by referral id: the office re-checks the
  // basis they record and writes its own row in their place.
  prepare(s) {
    const byReferral = new Map();
    for (const d of s.tables.disclosures || []) {
      if (!d || typeof d.id !== 'string' || d.source !== 'referral' || typeof d.source_ref !== 'string') continue;
      if (!byReferral.has(d.source_ref)) byReferral.set(d.source_ref, []);
      byReferral.get(d.source_ref).push(d);
    }
    s.state.referrals = { byReferral, accountedByOffice: new Set() };
  },
  beforeWrite(row, c) {
    const st = c.session.state.referrals;
    const deviceRows = (st.byReferral.get(row.id) || []).filter(d => !db.one(`SELECT 1 FROM disclosures WHERE id=?`, d.id));
    const gate = require('../routes/referrals').pushDisclosure(c.user, row, c.existing, deviceRows);
    if (gate && gate.refused) {
      const r = refuse(gate.refused, { permanent: true });
      r.audit = { action: 'sync.disclosure_refused', entity: 'referrals', entityId: row.id, clientId: row.client_id, details: { reason: gate.code } };
      return r;
    }
    c.referralDisclosure = gate;
    return null;
  },
  afterApply(row, o, c) {
    const gate = c.referralDisclosure;
    if (!gate) return;
    gate.account('device');
    for (const id of gate.deviceIds) c.session.state.referrals.accountedByOffice.add(id);
  },
});
