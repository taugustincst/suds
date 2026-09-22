'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');
const disclosure = require('../disclosure');

// 42 CFR §2.31 lists what a written Part 2 consent must contain. Recipient and purpose were checked; the
// rest (what is covered, when it ends, that it was actually signed, and that the client was told about
// redisclosure) were free text somebody might or might not fill in. They are required now.
function requirePart2Elements(v) {
  const missing = [];
  if (!v.recipient) missing.push('the recipient');
  if (!v.purpose) missing.push('the purpose');
  if (!v.scope) missing.push('what information is covered (scope)');
  if (!v.expires_at && !v.expires_event) missing.push('an expiration date or event');
  if (!v.document_ref && !v.signed_on_paper && !v.witness) missing.push('evidence it was signed (a document reference, a witness, or "signed on paper")');
  if (!v.redisclosure_notice_given) missing.push('confirmation that the redisclosure notice was given (§2.32)');
  if (missing.length) throw badRequest(`A 42 CFR Part 2 consent must record ${missing.join('; ')}`);
}

function presentConsent(c) {
  return { ...c, recipient: c.recipient_enc ? decrypt(c.recipient_enc) : null, purpose: c.purpose_enc ? decrypt(c.purpose_enc) : null, scope: c.scope_enc ? decrypt(c.scope_enc) : null,
    recipient_enc: undefined, purpose_enc: undefined, scope_enc: undefined,
    active: !c.revoked_at && (!c.expires_at || c.expires_at >= new Date().toISOString().slice(0, 10)) };
}

module.exports = (r) => {
  r.get('/api/clients/:id/consents', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    auth.assertClientAccess(ctx, ctx.params.id);
    const consents = db.all(`SELECT c.*, u.display_name AS created_by_name FROM consents c JOIN users u ON u.id=c.created_by WHERE client_id=? ORDER BY signed_at DESC`, ctx.params.id).map(presentConsent);
    const disclosures = db.all(`SELECT d.*, u.display_name AS disclosed_by_name FROM disclosures d JOIN users u ON u.id=d.disclosed_by WHERE client_id=? ORDER BY disclosed_at DESC`, ctx.params.id)
      .map(disclosure.present);
    // Reading who a client's information may be shared with is itself a PHI read.
    audit.log({ user: ctx.user, action: 'consent.list', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { consents: consents.length, disclosures: disclosures.length } });
    return { consents, disclosures };
  });
  r.post('/api/clients/:id/consents', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, { type: { type: 'string', required: true, enum: C.CONSENT_TYPES }, recipient: { type: 'string', maxLen: 200 }, purpose: { type: 'string', maxLen: 500 }, scope: { type: 'string', maxLen: 1000 },
      signed_at: { type: 'date', required: true }, expires_at: { type: 'date' }, expires_event: { type: 'string', maxLen: 200 }, document_ref: { type: 'string', maxLen: 300 }, witness: { type: 'string', maxLen: 120 },
      signed_on_paper: { type: 'boolean' }, redisclosure_notice_given: { type: 'boolean' } });
    if (v.type === 'part2_disclosure') requirePart2Elements(v);
    const id = uuid();
    db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,expires_event,document_ref,witness,signed_on_paper,redisclosure_notice_given,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, v.type, v.recipient ? encrypt(v.recipient) : null, v.purpose ? encrypt(v.purpose) : null, v.scope ? encrypt(v.scope) : null, v.signed_at, v.expires_at || null, v.expires_event || null,
      v.document_ref || null, v.witness || null, v.signed_on_paper ? 1 : 0, v.redisclosure_notice_given ? 1 : 0, ctx.user.id);
    audit.log({ user: ctx.user, action: 'consent.create', entity: 'consent', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { type: v.type } });
    ctx.status = 201; return { id };
  });
  r.post('/api/consents/:id/revoke', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    const c = db.one(`SELECT * FROM consents WHERE id=?`, ctx.params.id); if (!c) throw notFound();
    auth.assertClientAccess(ctx, c.client_id);
    if (c.revoked_at) throw badRequest('This consent has already been revoked');
    const { reason } = validate(ctx.body, { reason: { type: 'string', maxLen: 300 } });
    // Revocation is not retroactive, but everything still in flight under this consent has to stop.
    // Flag the open referrals that relied on it so a worker sees them rather than discovering later.
    const dependent = db.all(`SELECT id, resource_id FROM referrals WHERE consent_id=? AND status NOT IN ('closed','declined')`, c.id);
    db.transaction(() => {
      db.run(`UPDATE consents SET revoked_at=?, revoked_reason=?, revoked_by=?, updated_at=? WHERE id=?`, db.now(), reason || null, ctx.user.id, db.now(), c.id);
      for (const ref of dependent) db.run(`UPDATE referrals SET consent_revoked=1, updated_at=? WHERE id=?`, db.now(), ref.id);
    });
    audit.log({ user: ctx.user, action: 'consent.revoke', entity: 'consent', entityId: c.id, clientId: c.client_id, ip: ctx.ip, details: { dependent_referrals: dependent.length } });
    return { ok: true, dependent_referrals: dependent.length };
  });
  // Accounting of disclosures (HIPAA §164.528 / 42 CFR Part 2)
  r.post('/api/clients/:id/disclosures', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, { consent_id: { type: 'string' }, disclosed_to: { type: 'string', required: true, maxLen: 200 }, purpose: { type: 'string', required: true, maxLen: 500 }, info_disclosed: { type: 'string', required: true, maxLen: 1000 },
      method: { type: 'string', maxLen: 60 }, disclosed_at: { type: 'datetime', required: true }, basis: { type: 'string', enum: disclosure.BASES }, justification: { type: 'string', maxLen: 2000 } });
    const basis = disclosure.requireBasis(ctx.params.id, { ...v, user: ctx.user });
    const id = disclosure.record({ clientId: ctx.params.id, consentId: basis.consent?.id || null, recipient: v.disclosed_to, purpose: v.purpose, what: v.info_disclosed,
      method: v.method || null, basis: basis.basis, justification: basis.justification, source: 'manual', disclosedAt: v.disclosed_at, user: ctx.user, ip: ctx.ip });
    ctx.status = 201; return { id };
  });
  // The accounting a client is entitled to on request (§164.528 / §2.13): everything shared about them,
  // in one printable document. Producing it is itself a PHI read, so it is audited as such.
  r.get('/api/clients/:id/disclosures/accounting', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=?`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const out = disclosure.accounting(ctx.params.id);
    audit.log({ user: ctx.user, action: 'disclosure.accounting', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { disclosures: out.disclosures.length } });
    return out;
  });
};
