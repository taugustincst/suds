'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');

module.exports = (r) => {
  r.get('/api/clients/:id/consents', auth.requireAuth, auth.requirePerm('consents:read', 'consents:write'), (ctx) => {
    auth.assertClientAccess(ctx, ctx.params.id);
    return { consents: db.all(`SELECT c.*, u.display_name AS created_by_name FROM consents c JOIN users u ON u.id=c.created_by WHERE client_id=? ORDER BY signed_at DESC`, ctx.params.id),
      disclosures: db.all(`SELECT d.*, u.display_name AS disclosed_by_name FROM disclosures d JOIN users u ON u.id=d.disclosed_by WHERE client_id=? ORDER BY disclosed_at DESC`, ctx.params.id) };
  });
  r.post('/api/clients/:id/consents', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, { type: { type: 'string', required: true, enum: C.CONSENT_TYPES }, recipient: { type: 'string', maxLen: 200 }, purpose: { type: 'string', maxLen: 500 }, scope: { type: 'string', maxLen: 1000 },
      signed_at: { type: 'date', required: true }, expires_at: { type: 'date' }, document_ref: { type: 'string', maxLen: 300 }, witness: { type: 'string', maxLen: 120 } });
    if (v.type === 'part2_disclosure' && (!v.recipient || !v.purpose)) throw badRequest('42 CFR Part 2 consent requires recipient and purpose');
    const id = uuid();
    db.run(`INSERT INTO consents(id,client_id,type,recipient,purpose,scope,signed_at,expires_at,document_ref,witness,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, v.type, v.recipient || null, v.purpose || null, v.scope || null, v.signed_at, v.expires_at || null, v.document_ref || null, v.witness || null, ctx.user.id);
    audit.log({ user: ctx.user, action: 'consent.create', entity: 'consent', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { type: v.type } });
    ctx.status = 201; return { id };
  });
  r.post('/api/consents/:id/revoke', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    const c = db.one(`SELECT * FROM consents WHERE id=?`, ctx.params.id); if (!c) throw notFound();
    auth.assertClientAccess(ctx, c.client_id);
    const { reason } = validate(ctx.body, { reason: { type: 'string', maxLen: 300 } });
    db.run(`UPDATE consents SET revoked_at=?, revoked_reason=? WHERE id=?`, db.now(), reason || null, c.id);
    audit.log({ user: ctx.user, action: 'consent.revoke', entity: 'consent', entityId: c.id, clientId: c.client_id, ip: ctx.ip });
    return { ok: true };
  });
  // Accounting of disclosures (HIPAA §164.528 / 42 CFR Part 2)
  r.post('/api/clients/:id/disclosures', auth.requireAuth, auth.requirePerm('consents:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound();
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, { consent_id: { type: 'string' }, disclosed_to: { type: 'string', required: true, maxLen: 200 }, purpose: { type: 'string', required: true, maxLen: 500 }, info_disclosed: { type: 'string', required: true, maxLen: 1000 },
      method: { type: 'string', maxLen: 60 }, disclosed_at: { type: 'datetime', required: true }, basis: { type: 'string', enum: ['consent', 'court_order', 'medical_emergency', 'qsoa', 'audit_evaluation', 'research', 'crime_on_premises', 'child_abuse_report', 'other'] } });
    if (v.basis === 'consent' || !v.basis) {
      const consent = v.consent_id ? db.one(`SELECT * FROM consents WHERE id=? AND client_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= date('now'))`, v.consent_id, ctx.params.id) : null;
      if (!consent) throw badRequest('A valid, unexpired consent must be selected when the basis is consent');
    }
    const id = uuid();
    db.run(`INSERT INTO disclosures(id,client_id,consent_id,disclosed_to,purpose,info_disclosed,method,disclosed_at,disclosed_by,basis) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, v.consent_id || null, v.disclosed_to, v.purpose, v.info_disclosed, v.method || null, v.disclosed_at, ctx.user.id, v.basis || 'consent');
    audit.log({ user: ctx.user, action: 'disclosure.record', entity: 'disclosure', entityId: id, clientId: ctx.params.id, ip: ctx.ip, details: { to: v.disclosed_to, basis: v.basis } });
    ctx.status = 201; return { id };
  });
};
