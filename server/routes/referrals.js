'use strict';
// Referrals are where client information actually leaves the county's control, so this is the route that
// has to take consent seriously: no identifiable information reaches an outside agency without a lawful
// basis, and every one that does leaves a disclosure record behind.
const db = require('../db');
const crud = require('../crud');
const audit = require('../audit');
const C = require('../constants');
const disclosure = require('../disclosure');
const { badRequest } = require('../http');
const { uuid } = require('../crypto');

// A referral at these statuses means the agency has been contacted about this person by name.
const SHARED_STATUSES = ['contacted', 'accepted', 'waitlisted', 'scheduled', 'admitted', 'completed'];
const CLOSED_STATUSES = ['completed', 'closed', 'declined_by_client', 'declined_by_provider'];
const BASES = ['consent', 'court_order', 'medical_emergency', 'qsoa', 'audit_evaluation', 'research', 'crime_on_premises', 'child_abuse_report', 'other'];

/** Does this referral, as submitted, put the client's identity in front of the receiving agency? */
function sharesInformation(v, row = {}) {
  const status = v.status || row.status || 'pending';
  const warm = v.warm_handoff !== undefined ? v.warm_handoff : row.warm_handoff;
  return !!warm || SHARED_STATUSES.includes(status);
}

/** The referral's own disclosure row, if one has already been written. */
function existingDisclosure(referralId) {
  return db.one(`SELECT id FROM disclosures WHERE source='referral' AND source_ref=?`, referralId);
}

function resourceName(resourceId) {
  return db.one(`SELECT name FROM resources WHERE id=?`, resourceId)?.name || 'referral recipient';
}

module.exports = (r) => {
  crud.build(r, {
    table: 'referrals', entity: 'referral', perm: 'referrals', dateCol: 'referred_at', restrictOwner: true,
    joins: 'JOIN users u ON u.id=referrals.user_id JOIN clients c ON c.id=referrals.client_id JOIN resources res ON res.id=referrals.resource_id',
    select: 'referrals.*, u.display_name AS worker, c.client_code, res.name AS resource_name, res.category AS resource_category, res.phone AS resource_phone',
    shape: {
      client_id: { type: 'string', required: true }, resource_id: { type: 'string', required: true }, user_id: { type: 'string' }, referred_at: { type: 'datetime', required: true },
      status: { type: 'string', enum: C.REFERRAL_STATUSES }, urgency: { type: 'string', enum: ['routine', 'urgent', 'emergent'] }, appointment_at: { type: 'datetime' }, admitted_at: { type: 'datetime' },
      closed_at: { type: 'datetime' }, outcome: { type: 'string', maxLen: 500 }, barrier: { type: 'string', maxLen: 300 }, warm_handoff: { type: 'boolean' }, consent_id: { type: 'string' },
      follow_up_due: { type: 'date' }, notes: { type: 'string', maxLen: 2000 }, episode_id: { type: 'string' },
      // Not columns: how this disclosure is justified, and what was actually sent.
      _disclosure_basis: { type: 'string', enum: BASES }, _disclosure_what: { type: 'string', maxLen: 1000 },
    },
    filters: (ctx, where, params) => {
      const s = ctx.query.get('status'); if (s && s !== 'all') { where.push('referrals.status=?'); params.push(s); }
      if (ctx.query.get('open') === '1') where.push(`referrals.status IN ('pending','contacted','accepted','waitlisted','scheduled')`);
      if (ctx.query.get('consent_revoked') === '1') where.push('referrals.consent_revoked=1');
      if (ctx.query.get('awaiting_outcome') === '1') where.push(`referrals.status IN ('admitted','scheduled') AND referrals.outcome_recorded_at IS NULL`);
      const res = ctx.query.get('resource_id'); if (res) { where.push('referrals.resource_id=?'); params.push(res); }
    },
    beforeInsert: (ctx, v) => {
      if (!db.one(`SELECT 1 FROM resources WHERE id=?`, v.resource_id)) throw badRequest('Unknown resource');
      if (v.consent_id && !db.one(`SELECT 1 FROM consents WHERE id=? AND client_id=?`, v.consent_id, v.client_id)) throw badRequest('That consent belongs to a different client');
      // Nothing identifiable goes out without a basis. A "pending" referral with no warm handoff is just a
      // phone number handed to the client, so it needs none.
      if (sharesInformation(v)) disclosure.requireBasis(v.client_id, { consent_id: v.consent_id, basis: v._disclosure_basis });
      // Closing the loop is the point of a referral: every one gets a follow-up date whether or not the
      // worker set one, so "we referred them and never found out" stops being possible.
      if (!v.follow_up_due) {
        const days = v.urgency === 'emergent' ? 1 : v.urgency === 'urgent' ? 3 : 14;
        v.follow_up_due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      }
    },
    beforeUpdate: (ctx, v, row) => {
      if (v.consent_id && !db.one(`SELECT 1 FROM consents WHERE id=? AND client_id=?`, v.consent_id, row.client_id)) throw badRequest('That consent belongs to a different client');
      // A referral that was only "pending" and is now being progressed starts sharing information now.
      if (sharesInformation(v, row) && !existingDisclosure(row.id)) {
        const basis = disclosure.requireBasis(row.client_id, { consent_id: v.consent_id || row.consent_id, basis: v._disclosure_basis });
        disclosure.record({ clientId: row.client_id, consentId: basis.consent?.id || null, recipient: resourceName(v.resource_id || row.resource_id),
          purpose: 'Referral for services', what: v._disclosure_what || 'Referral information (name, contact details and presenting need)',
          method: (v.warm_handoff ?? row.warm_handoff) ? 'warm handoff' : 'referral', basis: basis.basis, source: 'referral', sourceRef: row.id, user: ctx.user, ip: ctx.ip });
      }
      if (v.status && CLOSED_STATUSES.includes(v.status) && !v.closed_at && !row.closed_at) v.closed_at = db.now();
      if (v.status === 'admitted' && !v.admitted_at && !row.admitted_at) v.admitted_at = db.now();
      // An outcome is what makes the referral answerable in a funder report.
      if ((v.outcome !== undefined || v.status === 'admitted' || (v.status && CLOSED_STATUSES.includes(v.status))) && !row.outcome_recorded_at) v.outcome_recorded_at = db.now();
    },
    afterInsert: (ctx, row) => {
      if (sharesInformation(row)) {
        const basis = disclosure.requireBasis(row.client_id, { consent_id: row.consent_id, basis: row._disclosure_basis });
        disclosure.record({ clientId: row.client_id, consentId: basis.consent?.id || null, recipient: resourceName(row.resource_id),
          purpose: 'Referral for services', what: row._disclosure_what || 'Referral information (name, contact details and presenting need)',
          method: row.warm_handoff ? 'warm handoff' : 'referral', basis: basis.basis, source: 'referral', sourceRef: row.id, user: ctx.user, ip: ctx.ip });
      }
      db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title,due_at,priority) VALUES(?,?,?,?,?,?,?)`,
        uuid(), row.client_id, row.user_id, ctx.user.id, `Follow up on referral to ${resourceName(row.resource_id)}`, row.follow_up_due, row.urgency === 'emergent' ? 'urgent' : 'normal');
    },
    canEdit: crud.ownerOrManager(),
  });

  // Close the loop explicitly: what happened, and was the client admitted?
  r.post('/api/referrals/:id/outcome', require('../auth').requireAuth, require('../auth').requirePerm('referrals:write'), (ctx) => {
    const row = db.one(`SELECT * FROM referrals WHERE id=?`, ctx.params.id);
    if (!row) throw require('../http').notFound('Referral not found');
    require('../auth').assertClientAccess(ctx, row.client_id);
    const { validate } = require('../validate');
    const v = validate(ctx.body, {
      status: { type: 'string', required: true, enum: C.REFERRAL_STATUSES },
      outcome: { type: 'string', maxLen: 500 }, barrier: { type: 'string', maxLen: 300 }, admitted_at: { type: 'datetime' },
    });
    const admitted = v.status === 'admitted' || !!v.admitted_at;
    db.run(`UPDATE referrals SET status=?, outcome=?, barrier=?, admitted_at=?, closed_at=?, outcome_recorded_at=?, updated_at=? WHERE id=?`,
      v.status, v.outcome || row.outcome, v.barrier || row.barrier, admitted ? (v.admitted_at || row.admitted_at || db.now()) : row.admitted_at,
      CLOSED_STATUSES.includes(v.status) ? (row.closed_at || db.now()) : row.closed_at, db.now(), db.now(), row.id);
    // The follow-up task has served its purpose once the outcome is known.
    db.run(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE client_id=? AND status<>'done' AND title LIKE 'Follow up on referral%'`, db.now(), db.now(), row.client_id);
    audit.log({ user: ctx.user, action: 'referral.outcome', entity: 'referral', entityId: row.id, clientId: row.client_id, ip: ctx.ip, details: { status: v.status, admitted } });
    return { ok: true, admitted };
  });
};
