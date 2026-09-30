'use strict';
// Fingerprint sign-in, signing and approvals with passkeys (docs/FINGERPRINT.md; server/passkeys.js). Office server
// only: not in the local kernel (server/app.js LOCAL_ROUTE_MODULES), and SUDS on this device never offers it.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const P = require('../passkeys');
const { HttpError, badRequest, notFound } = require('../http');
const { validate } = require('../validate');

// The routes that run before a session exists: the pipeline's CSRF check only covers cookie-authenticated requests,
// so these ask for the same header (a cross-site form cannot send it without a CORS preflight SUDS never grants).
const csrf = (ctx) => { if (ctx.headers['x-requested-with'] !== 'suds') throw new HttpError(403, 'Missing CSRF header'); };
// A fully signed-in session, or one still owing its second step: enough to see the sign-in options, nothing else.
const credential = { type: 'object', required: true };

module.exports = (r) => {
  // ---- what the sign-in page may offer ----
  r.get('/api/auth/passkeys/status', (ctx) => {
    const pol = auth.policy();
    const here = P.availability(ctx);
    return { signin: pol.passkeySignin && here.ok, signing: pol.passkeySigning && here.ok, available: here.ok, reason: here.ok ? null : here.reason };
  });

  // ---- sign-in (and the second step of a password sign-in) ----
  // Discoverable passkeys only: a username sent here is ignored, so the answer says nothing about any account
  // (server/passkeys.js loginOptions). Validated still, so an old page sending one gets the same answer.
  r.post('/api/auth/passkeys/login/options', (ctx) => {
    csrf(ctx);
    validate(ctx.body || {}, { username: { type: 'string', maxLen: 100 } }, { partial: true });
    return P.loginOptions(ctx);
  });
  r.post('/api/auth/passkeys/login', (ctx) => {
    csrf(ctx);
    const v = validate(ctx.body || {}, { credential });
    const out = P.loginFinish(ctx, { credential: v.credential });
    if (out.token) ctx.res.setHeader('Set-Cookie', auth.cookieHeader(out.token));
    return { user: out.user, mfaPending: false, mfaSetupRequired: false, mfaSetupDeadline: null };
  });

  // ---- my passkeys: Settings → My profile → Fingerprint sign-in ----
  r.get('/api/auth/passkeys', (ctx) => {
    auth.requireAuth(ctx);
    const pol = auth.policy();
    const here = P.availability(ctx);
    return { passkeys: P.list(ctx.user.id), max: P.MAX_PER_USER, signin: pol.passkeySignin, signing: pol.passkeySigning, strong_required: pol.signStrongRequired,
      available: here.ok, reason: here.ok ? null : here.reason, totp: !!db.one(`SELECT mfa_enabled FROM users WHERE id=?`, ctx.user.id).mfa_enabled };
  });
  // Adding one needs the password again, and the authenticator code with two-step verification on.
  r.post('/api/auth/passkeys/register/options', async (ctx) => {
    auth.requireAuth(ctx);
    const v = validate(ctx.body || {}, { password: { type: 'string', maxLen: 500 }, code: { type: 'string', maxLen: 10 } }, { partial: true });
    return P.registrationOptions(ctx, { password: v.password, code: v.code });
  });
  r.post('/api/auth/passkeys/register', (ctx) => {
    auth.requireAuth(ctx);
    const v = validate(ctx.body || {}, { credential, name: { type: 'string', maxLen: 60 } });
    ctx.status = 201;
    return { passkey: P.registrationFinish(ctx, { credential: v.credential, name: v.name }) };
  });
  r.put('/api/auth/passkeys/:id', (ctx) => {
    auth.requireAuth(ctx);
    const v = validate(ctx.body || {}, { name: { type: 'string', required: true, maxLen: 60 } });
    return { passkey: P.rename(ctx, ctx.params.id, v.name) };
  });
  // Removing one needs the password (an account that signs in only through single sign-on confirms instead): a
  // session left open must not be able to take away the owner's second factor quietly.
  r.delete('/api/auth/passkeys/:id', async (ctx) => {
    auth.requireAuth(ctx);
    const v = validate(ctx.body || {}, { password: { type: 'string', maxLen: 500 }, confirm: { type: 'boolean' } }, { partial: true });
    const p = db.one(`SELECT id FROM passkeys WHERE id=? AND user_id=?`, ctx.params.id, ctx.user.id);
    if (!p) throw notFound('Passkey not found');
    const u = db.one(`SELECT password_hash FROM users WHERE id=?`, ctx.user.id);
    if (auth.hasLocalPassword(u.password_hash)) {
      if (!v.password) throw badRequest('Enter your password to remove a passkey', { fields: { password: 'required' } });
      await auth.confirmPassword(ctx, v.password, { action: 'auth.passkey.remove.failed' });
      auth.clearFailures(ctx.user.id);
    } else if (!v.confirm) throw badRequest('Confirm that you want to remove this passkey');
    // Any other session that passkey signed in ends with it; this one has just given the password.
    P.remove(ctx.user.id, { id: p.id, actor: ctx.user, ip: ctx.ip, cause: 'owner', keepSession: ctx.session && ctx.session.id });
    return { ok: true };
  });

  // ---- "Confirm with fingerprint": a challenge bound to exactly what is being signed or approved ----
  // purpose: note.sign | note.cosign | note.cosign-batch | time.approve | expenditure.approve | keys.download, with
  // the record(s): note_id, ids (+ decision), id (+ status). The route that receives the assertion computes the same
  // binding again (server/passkeys.js bindingFor) and refuses one that does not match.
  r.post('/api/auth/passkeys/challenge', (ctx) => {
    auth.requireAuth(ctx);
    const v = validate(ctx.body || {}, { purpose: { type: 'string', required: true, enum: P.PURPOSES }, note_id: { type: 'string', maxLen: 64 }, id: { type: 'string', maxLen: 64 },
      ids: { type: 'array', maxLen: 500, of: 'string' }, decision: { type: 'string', enum: ['approved', 'rejected'] }, status: { type: 'string', enum: ['approved', 'rejected', 'reimbursed'] } });
    return P.signingOptions(ctx, v.purpose, v);
  });

  // ---- administrators: a person's passkeys (count, names, dates) and revoking them ----
  r.get('/api/users/:id/passkeys', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const u = db.one(`SELECT id FROM users WHERE id=?`, ctx.params.id);
    if (!u) throw notFound('User not found');
    const passkeys = P.list(u.id);
    return { count: passkeys.length, passkeys };
  });
  r.delete('/api/users/:id/passkeys', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const u = db.one(`SELECT id FROM users WHERE id=?`, ctx.params.id);
    if (!u) throw notFound('User not found');
    const removed = P.remove(u.id, { actor: ctx.user, ip: ctx.ip, cause: 'administrator' });
    // Stated on its own line too, so "who took away this person's passkeys" is one audit search.
    audit.log({ user: ctx.user, action: 'user.passkeys.revoked', entity: 'user', entityId: u.id, ip: ctx.ip, details: { count: removed } });
    return { ok: true, removed };
  });
  r.delete('/api/users/:id/passkeys/:pid', auth.requireAuth, auth.requirePerm('users:manage'), (ctx) => {
    const removed = P.remove(ctx.params.id, { id: ctx.params.pid, actor: ctx.user, ip: ctx.ip, cause: 'administrator' });
    if (!removed) throw notFound('Passkey not found');
    audit.log({ user: ctx.user, action: 'user.passkeys.revoked', entity: 'user', entityId: ctx.params.id, ip: ctx.ip, details: { count: removed, passkey: ctx.params.pid } });
    return { ok: true, removed };
  });

  // ---- the evidence of a fingerprint-confirmed signature, for an auditor ----
  // Ids, hashes, the credential's public key and the assertion: no PHI. Re-verified here, and verifiable offline with
  // scripts/verify-passkey-evidence.js and nothing but Node.
  r.get('/api/admin/signature-evidence', auth.requireAuth, auth.requirePerm('audit:read'), (ctx) => {
    const type = ctx.query.get('record_type'); const id = ctx.query.get('record_id');
    if (!type || !id) throw badRequest('record_type and record_id are required');
    const rows = P.evidenceFor(String(type).slice(0, 40), String(id).slice(0, 64));
    audit.log({ user: ctx.user, action: 'signature_evidence.view', entity: type, entityId: id, ip: ctx.ip, details: { count: rows.length } });
    return { rows };
  });
};
