'use strict';
// Referrals are where client information actually leaves the county's control, so this is the route that
// has to take consent seriously: no identifiable information reaches an outside agency without a lawful
// basis, and every one that does leaves a disclosure record behind.
const db = require('../db');
const crud = require('../crud');
const audit = require('../audit');
const C = require('../constants');
const disclosure = require('../disclosure');
const CN = require('../client-name');
const { encrypt, decrypt } = require('../crypto');
const FU = require('../rules/follow-ups');

// A referral at these statuses means the agency has been contacted about this person by name.
const SHARED_STATUSES = ['contacted', 'accepted', 'waitlisted', 'scheduled', 'admitted', 'completed'];
const CLOSED_STATUSES = ['completed', 'closed', 'declined_by_client', 'declined_by_provider'];
const BASES = disclosure.BASES;
// Free text on a referral describes a named person's treatment, so it lives in _enc columns; the API keeps
// the plain field names.
const ENC = ['outcome', 'barrier', 'notes'];

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
/** Every name the receiving agency goes by — its name and its organisation — for the consent's recipient check. */
function resourceNames(resourceId) {
  const r = db.one(`SELECT name, organization FROM resources WHERE id=?`, resourceId);
  return r ? [r.name, r.organization].filter(Boolean) : [];
}

/**
 * Is there a live consent on file that names this referral's provider (the check the disclosure gate makes:
 * a Part 2 consent, every §2.31 element, unexpired and not revoked)? The referral list says "Consent on file"
 * only then: a general release, or a TPO consent that names someone else, is not one. Worked out once per
 * client and provider in a request.
 */
function withConsentOnFile(ctx, row) {
  const cache = ctx._consentOnFile || (ctx._consentOnFile = new Map());
  const key = `${row.client_id}|${row.resource_id}`;
  if (!cache.has(key)) {
    const names = disclosure.recipientNames(resourceNames(row.resource_id));
    const today = new Date().toISOString().slice(0, 10);
    const types = disclosure.disclosingConsentTypes();
    cache.set(key, !!names.length && db.all(`SELECT * FROM consents WHERE client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`, row.client_id, today)
      .some(c => types.includes(c.type) && !disclosure.consentElementProblems(c).length && disclosure.consentNamesRecipient({ type: c.type, recipient: c.recipient_enc ? decrypt(c.recipient_enc) : null }, names)));
  }
  return { ...row, consent_on_file: cache.get(key) };
}

function encFields(v) { for (const f of ENC) if (v[f] !== undefined) { v[`${f}_enc`] = v[f] === null || v[f] === '' ? null : encrypt(String(v[f])); delete v[f]; } }
function present(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of ENC) { out[f] = row[`${f}_enc`] ? decrypt(row[`${f}_enc`]) : null; delete out[`${f}_enc`]; }
  return out;
}

/**
 * What disclosure.requireBasis needs from a referral form: the consent, or the other basis and its order —
 * checked against the agency the referral goes to, and limited to the bases a referral may rest on.
 */
function gate(ctx, v, row = {}) {
  return { consent_id: v.consent_id || row.consent_id, basis: v._disclosure_basis, justification: v._disclosure_justification, court_order_id: v._court_order_id,
    recipient: resourceNames(v.resource_id || row.resource_id), recipient_override: v._recipient_override, allowed: disclosure.REFERRAL_BASES,
    restriction_reviewed: v._restriction_reviewed, user: ctx.user };
}

/**
 * The one place a referral's disclosure is written: from create, update and the outcome route alike.
 * Nothing identifiable goes out without a basis, and a basis that is not consent has to be justified.
 */
function recordDisclosure(ctx, row, v = {}) {
  const basis = disclosure.requireBasis(row.client_id, gate(ctx, v, row));
  disclosure.record({ clientId: row.client_id, consentId: basis.consent?.id || null, courtOrderId: basis.court_order?.id || null, recipientOverride: basis.recipient_override, recipient: resourceName(v.resource_id || row.resource_id),
    purpose: 'Referral for services', what: v._disclosure_what || 'Referral information (name, contact details and presenting need)',
    method: (v.warm_handoff ?? row.warm_handoff) ? 'warm handoff' : 'referral', basis: basis.basis, justification: basis.justification, source: 'referral', sourceRef: row.id, user: ctx.user, ip: ctx.ip });
}

/**
 * A referral row arriving by sync (server/routes/sync.js) meets the same gate as one saved over REST: when
 * it shares information and nothing has been accounted for this recipient yet — a new warm hand-off, a
 * pending referral progressed offline, or a shared referral re-pointed at another agency — the basis is
 * re-checked here against the agency it now goes to. A device that made the referral offline also pushes
 * the accounting row its own copy of this gate wrote (`deviceRows`: disclosures in the same batch with
 * source 'referral' for this referral); its basis, consent, order and justification are what is re-checked,
 * under the syncing user's own permissions. Without one, only the consent the referral cites can stand.
 * Returns null (nothing to disclose), { refused } (a short reason with no PHI in it) or { account(ip) },
 * which writes the office's accounting row — under the device row's id, so the two copies stay one row.
 */
const OVERRIDE_PREFIX = /^Recipient override \(the consent names "[\s\S]*?"\): /;
function pushDisclosure(user, raw, existing, deviceRows = []) {
  if (!sharesInformation(raw, existing || {})) return null;
  const recipientChanged = !!existing && !!raw.resource_id && raw.resource_id !== existing.resource_id;
  if (existing && !recipientChanged && existingDisclosure(raw.id)) return null;
  const dev = deviceRows.length ? deviceRows[deviceRows.length - 1] : null;
  const just = dev && dev.justification_enc ? String(dev.justification_enc) : '';
  const resourceId = raw.resource_id || existing?.resource_id;
  let basis;
  try {
    basis = disclosure.requireBasis(raw.client_id, { consent_id: (dev && dev.consent_id) || raw.consent_id, basis: (dev && dev.basis) || 'consent', justification: just.replace(OVERRIDE_PREFIX, '') || null,
      court_order_id: dev && dev.court_order_id, recipient: resourceNames(resourceId), recipient_override: OVERRIDE_PREFIX.test(just), allowed: disclosure.REFERRAL_BASES,
      // The device's gate asked the worker to confirm an agreed restriction before it wrote its row.
      restriction_reviewed: !!dev, user });
  } catch (e) {
    const x = e && e.extra || {};
    const why = x.recipientNotCovered ? 'the consent it cites does not name the agency it is sent to'
      : x.restrictionReview ? 'the client has an agreed restriction on sharing, which has to be confirmed at the office'
        : x.consentIncomplete ? 'the consent it cites does not carry every §2.31 element'
          : 'it needs a live consent that names the agency, or another basis recorded at the office';
    return { refused: `needs a lawful basis for disclosure the office accepts: ${why}`, code: x.recipientNotCovered ? 'recipient_not_covered' : x.restrictionReview ? 'restriction' : x.consentIncomplete ? 'consent_incomplete' : 'no_basis' };
  }
  return {
    deviceIds: deviceRows.map(d => d.id),
    account(ip) {
      return disclosure.record({ id: dev ? dev.id : undefined, clientId: raw.client_id, consentId: basis.consent?.id || null, courtOrderId: basis.court_order?.id || null, recipientOverride: basis.recipient_override,
        recipient: resourceName(resourceId), purpose: 'Referral for services', what: (dev && dev.what_enc) || 'Referral information (name, contact details and presenting need)',
        method: (raw.warm_handoff ?? existing?.warm_handoff) ? 'warm handoff' : 'referral', basis: basis.basis, justification: basis.justification, source: 'referral', sourceRef: raw.id,
        disclosedAt: (dev && dev.disclosed_at) || null, user, ip });
    },
  };
}

module.exports = (r) => {
  crud.build(r, {
    table: 'referrals', entity: 'referral', perm: 'referrals', dateCol: 'referred_at',
    joins: 'JOIN users u ON u.id=referrals.user_id JOIN clients c ON c.id=referrals.client_id JOIN resources res ON res.id=referrals.resource_id',
    // The client's name for a role that can open the client (client-name.js); the code for any other.
    select: `referrals.*, u.display_name AS worker, c.client_code, ${CN.SELECT}, res.name AS resource_name, res.category AS resource_category, res.phone AS resource_phone`,
    // The stored fields, owner, canEdit and the resource/consent checks: server/rules/referrals.js. Not columns:
    // how this disclosure is justified, and what was actually sent.
    extraShape: {
      _disclosure_basis: { type: 'string', enum: BASES }, _disclosure_what: { type: 'string', maxLen: 1000 }, _disclosure_justification: { type: 'string', maxLen: 2000 },
      _court_order_id: { type: 'string' }, _restriction_reviewed: { type: 'boolean' }, _recipient_override: { type: 'boolean' },
    },
    filters: (ctx, where, params) => {
      const s = ctx.query.get('status'); if (s && s !== 'all') { where.push('referrals.status=?'); params.push(s); }
      if (ctx.query.get('open') === '1') where.push(`referrals.status IN ('pending','contacted','accepted','waitlisted','scheduled')`);
      if (ctx.query.get('consent_revoked') === '1') where.push('referrals.consent_revoked=1');
      if (ctx.query.get('awaiting_outcome') === '1') where.push(`referrals.status IN ('admitted','scheduled') AND referrals.outcome_recorded_at IS NULL`);
      const res = ctx.query.get('resource_id'); if (res) { where.push('referrals.resource_id=?'); params.push(res); }
    },
    afterLoad: (ctx, row) => present(withConsentOnFile(ctx, CN.withClientName(ctx, row))),
    beforeInsert: (ctx, v) => {
      // Nothing identifiable goes out without a basis. A "pending" referral with no warm handoff is just a
      // phone number handed to the client, so it needs none.
      if (sharesInformation(v)) disclosure.requireBasis(v.client_id, gate(ctx, v));
      // Closing the loop is the point of a referral: every one gets a follow-up date whether or not the
      // worker set one, so "we referred them and never found out" stops being possible.
      // (server/rules/follow-ups.js, which sync push applies to a device's referrals too.)
      FU.defaultReferralDue(v);
      encFields(v);
    },
    beforeUpdate: (ctx, v, row) => {
      // A referral that was only "pending" and is now being progressed starts sharing information now. One
      // that already shares and is re-pointed at another agency tells that agency who this person is: the
      // basis is checked against the new recipient (as creating the referral there would be) and the new
      // disclosure is accounted — the old row still stands for the agency that was told first.
      const recipientChanged = !!v.resource_id && v.resource_id !== row.resource_id;
      if (sharesInformation(v, row) && (recipientChanged || !existingDisclosure(row.id))) recordDisclosure(ctx, row, v);
      if (v.status && CLOSED_STATUSES.includes(v.status) && !v.closed_at && !row.closed_at) v.closed_at = db.now();
      if (v.status === 'admitted' && !v.admitted_at && !row.admitted_at) v.admitted_at = db.now();
      // An outcome is what makes the referral answerable in a funder report.
      if ((v.outcome !== undefined || v.status === 'admitted' || (v.status && CLOSED_STATUSES.includes(v.status))) && !row.outcome_recorded_at) v.outcome_recorded_at = db.now();
      encFields(v);
    },
    afterInsert: (ctx, row) => {
      if (sharesInformation(row)) recordDisclosure(ctx, row, row);
      FU.reconcile('referrals', row, null, ctx);
    },
    // A follow-up date changed or cleared by editing the referral moves or cancels its to-do (server/rules/follow-ups.js).
    afterUpdate: (ctx, row, prev) => { FU.reconcile('referrals', row, prev, ctx); },
  });

  // Close the loop explicitly: what happened, and was the client admitted?
  r.post('/api/referrals/:id/outcome', require('../auth').requireAuth, require('../auth').requirePerm('referrals:write'), (ctx) => {
    const row = db.one(`SELECT * FROM referrals WHERE id=?`, ctx.params.id);
    if (!row) throw require('../http').notFound('Referral not found');
    require('../auth').assertClientAccess(ctx, row.client_id);
    const { validate } = require('../validate');
    const v = validate(ctx.body, {
      status: { type: 'string', required: true, list: 'REFERRAL_STATUSES' },
      outcome: { type: 'string', maxLen: 500 }, barrier: { type: 'string', maxLen: 300 }, admitted_at: { type: 'datetime' },
      consent_id: { type: 'string' }, _disclosure_basis: { type: 'string', enum: BASES }, _disclosure_what: { type: 'string', maxLen: 1000 }, _disclosure_justification: { type: 'string', maxLen: 2000 },
      _court_order_id: { type: 'string' }, _restriction_reviewed: { type: 'boolean' }, _recipient_override: { type: 'boolean' },
    }, { existing: row });
    // The table's rules (server/rules/referrals.js): the consent it cites is this client's. Recording an outcome is
    // anyone's on the caseload, not only the referral's maker (editable: false), as it is by sync.
    require('../rules').assertWrite('referrals', { id: row.id, status: v.status, consent_id: v.consent_id }, ctx, { existing: row, editable: false });
    const admitted = v.status === 'admitted' || !!v.admitted_at;
    db.transaction(() => {
      // Recording "admitted" or "scheduled" on a referral that was only ever pending is the moment the agency
      // was told who this person is — exactly the same gate the update route applies.
      if (sharesInformation(v, row) && !existingDisclosure(row.id)) recordDisclosure(ctx, row, v);
      db.run(`UPDATE referrals SET status=?, outcome_enc=?, barrier_enc=?, admitted_at=?, closed_at=?, outcome_recorded_at=?, consent_id=COALESCE(?, consent_id), updated_at=? WHERE id=?`,
        v.status, v.outcome ? encrypt(v.outcome) : row.outcome_enc, v.barrier ? encrypt(v.barrier) : row.barrier_enc, admitted ? (v.admitted_at || row.admitted_at || db.now()) : row.admitted_at,
        CLOSED_STATUSES.includes(v.status) ? (row.closed_at || db.now()) : row.closed_at, db.now(), v.consent_id || null, db.now(), row.id);
      // This referral's follow-up task has served its purpose once the outcome is known — this one's, not
      // every referral follow-up the client has. A task created before tasks carried referral_id is matched
      // on the resource's name in its title instead (titles are encrypted, so they are read back, not LIKEd).
      const closed = db.run(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE referral_id=? AND status IN ('open','in_progress')`, db.now(), db.now(), row.id).changes;
      if (!closed) {
        const legacyTitle = `Follow up on referral to ${resourceName(row.resource_id)}`;
        for (const t of db.all(`SELECT id, title_enc FROM tasks WHERE client_id=? AND referral_id IS NULL AND status IN ('open','in_progress')`, row.client_id)) {
          let title = ''; try { title = t.title_enc ? decrypt(t.title_enc) : ''; } catch { continue; }
          if (title === legacyTitle) db.run(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`, db.now(), db.now(), t.id);
        }
      }
    });
    audit.log({ user: ctx.user, action: 'referral.outcome', entity: 'referral', entityId: row.id, clientId: row.client_id, ip: ctx.ip, details: { status: v.status, admitted } });
    return { ok: true, admitted };
  });
};
module.exports.present = present;
module.exports.pushDisclosure = pushDisclosure;
