'use strict';
// The rules for referrals. A referral that shares information is a disclosure, whichever way it reaches the
// office: a warm hand-off made offline, a pending referral progressed on the phone, or a shared one re-pointed
// at another agency passes the same gate as PUT /api/referrals/:id and is accounted here
// (routes/referrals.js pushDisclosure). A refusal is for good (the device shows it) and audited, by reason code.
const db = require('../db');
const { define, refuse, flag } = require('./core');
const { ownedBy } = require('./shared');
const FU = require('./follow-ups');

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
    // The consent names the agency but was given for another purpose: the referral was made, so it is kept and
    // accounted rather than lost, the device is told, and a supervisor reviews it (afterApply).
    return gate && gate.flagged ? flag(gate.flagged, { code: 'disclosure_purpose' }) : null;
  },
  // Every referral has a follow-up date (one by urgency when the worker set none), and its to-do follows the date
  // once the push has landed (server/rules/follow-ups.js), as over REST (routes/referrals.js).
  normalise(row, c) { if (!c.existing) FU.defaultReferralDue(row); return null; },
  finish(s) { FU.finish('referrals', s); },
  // A deleted referral's untouched follow-up to-do is cancelled before the row goes (server/rules/follow-ups.js).
  beforeDelete(row, s) { FU.pushDeleted('referrals', row, s); },
  afterApply(row, o, c) {
    FU.track('referrals', row, c);
    const gate = c.referralDisclosure;
    if (!gate) return;
    gate.account('device');
    for (const id of gate.deviceIds) c.session.state.referrals.accountedByOffice.add(id);
    if (gate.flagged) {
      const code = db.one(`SELECT client_code FROM clients WHERE id=?`, row.client_id)?.client_code || '';
      require('../routes/clients').reviewTask(c.user, row.client_id, `Review a referral synced from a device for ${code}: the consent it cites was given for another purpose. Confirm the basis, or record a consent for this purpose.`);
    }
  },
});
