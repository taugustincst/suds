'use strict';
// Fingerprint sign-in, signing and approvals with passkeys (docs/FINGERPRINT.md; server/passkeys.js). Office server
// only: not in the local kernel (server/app.js LOCAL_ROUTE_MODULES), and SUDS on this device never offers it.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const P = require('../passkeys');
const W = require('../webauthn');
const A = require('../attestation');
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
      available: here.ok, reason: here.ok ? null : here.reason, totp: !!db.one(`SELECT mfa_enabled FROM users WHERE id=?`, ctx.user.id).mfa_enabled,
      // The authenticator allow-list, when on: which models this programme accepts (My profile says so).
      allowlist: P.allowlist.enabled() ? { models: P.allowlist.models().map((m) => m.name) } : null,
      // Passkeys in the allow-list's grace period (1.22.0): when they stop (My profile says so).
      grace: P.graceNotice(ctx.user.id) };
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

  // ---- the authenticator allow-list (docs/FINGERPRINT.md, "Authenticator allow-list"; released in 1.21.0) ----
  // Administrators only (settings:manage). Reading it and previewing who a change would affect need nothing more;
  // changing it or loading a metadata file needs the password or authenticator code with the request, every time
  // (auth.verifySigner `fresh`, as for the key backup; a single sign-on account confirms with its provider).
  const L = P.allowlist;
  const modelsRule = { type: 'array', maxLen: L.MAX_MODELS };
  const reauthRules = { password: { type: 'string', maxLen: 500 }, code: { type: 'string', maxLen: 10 }, confirm: { type: 'boolean' } };
  const describeModels = (list) => list.map((m) => ({ ...m, ...L.modelStanding(m.aaguid) }));
  r.get('/api/admin/authenticator-allowlist', auth.requireAuth, auth.requirePerm('settings:manage'), () => {
    const st = L.status();
    return { ...st, catalog: L.catalog(), affected: L.affected({ on: st.enabled, list: L.models(), current: true }), max_models: L.MAX_MODELS,
      trust_root: { subject: 'GlobalSign Root CA - R3 (the FIDO Metadata Service\'s)', sha256: A.FIDO_MDS_ROOT_SHA256, signer: A.MDS_SIGNER_HOST }, formats: A.SUPPORTED_FORMATS };
  });
  // What saving { enabled, models, grace_days } would do, before it is saved: each model's standing in the loaded
  // metadata, and the accounts whose passkeys would stop working, and when (the grace period, 1.22.0).
  const graceRule = { type: 'number', integer: true, min: 0, max: L.GRACE_MAX_DAYS };
  r.post('/api/admin/authenticator-allowlist/preview', auth.requireAuth, auth.requirePerm('settings:manage'), (ctx) => {
    const v = validate(ctx.body || {}, { enabled: { type: 'boolean' }, models: modelsRule, grace_days: graceRule }, { partial: true });
    const list = L.normaliseModels(v.models || [], badRequest);
    const days = v.grace_days ?? L.graceDays();
    return { models: describeModels(list), affected: L.affected({ on: !!v.enabled, list, days }) };
  });
  r.put('/api/admin/authenticator-allowlist', auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    const v = validate(ctx.body || {}, { enabled: { type: 'boolean', required: true }, models: { ...modelsRule, required: true }, grace_days: graceRule, acknowledge_affected: { type: 'number', min: 0, integer: true }, ...reauthRules });
    const on = !!v.enabled;
    // The grace period (0-90 days; 14 until the administrator chooses): kept for the next change too.
    const days = v.grace_days ?? L.graceDays();
    const list = L.normaliseModels(v.models, badRequest);
    // Checked before the password is asked for, so a list that cannot work is said before anything is spent.
    if (on) {
      const meta = L.metadataInfo();
      if (!meta) throw badRequest('Load the FIDO Metadata Service file first: without it SUDS cannot check any authenticator model.', { allowlistError: 'metadata' });
      if (meta.expired) throw badRequest(`The FIDO Metadata Service file loaded is out of date (its next update was due on ${meta.next_update}). Load the current one first.`, { allowlistError: 'metadata_expired' });
      if (!list.length) throw badRequest('List at least one authenticator model to turn the list on.', { fields: { models: 'required' } });
      const bad = describeModels(list).filter((m) => m.standing !== 'ok');
      if (bad.length) throw badRequest(`${bad.map((m) => `${m.name} (${m.aaguid})`).join(', ')}: ${bad.some((m) => m.standing === 'refused') ? 'the metadata file reports a compromised or revoked status, or ' : ''}not in the loaded metadata file, so no passkey could be checked for ${bad.length === 1 ? 'it' : 'them'}. Remove ${bad.length === 1 ? 'it' : 'them'} from the list.`, { allowlistError: 'models', models: bad });
    }
    // Who it stops: the administrator confirms the number they were shown (preview), so a save cannot cut people off
    // unseen, or more people than were seen.
    const aff = L.affected({ on, list, days });
    if (aff.passkey_count && v.acknowledge_affected !== aff.passkey_count) throw new HttpError(409, `${aff.passkey_count} passkey${aff.passkey_count === 1 ? '' : 's'} of ${aff.account_count} account${aff.account_count === 1 ? '' : 's'} would stop working. Review them and confirm.`, { affected: aff });
    await auth.verifySigner(ctx, v, { action: 'security.authenticator_allowlist.failed', purpose: 'change the authenticator allow-list', fresh: true });
    const before = L.status();
    let ended = 0; let grace = { passkeys: 0, until: null };
    // The grace periods are worked out against the setting in force (who was working until now), then the new one saved.
    db.transaction(() => {
      grace = L.applyGrace({ on, list, days });
      db.setSetting('authn_allowlist_grace_days', String(days));
      db.setSetting('authn_allowlist', on ? '1' : '0'); db.setSetting('authn_allowlist_models', JSON.stringify(list));
      ended = L.endRefusedSessions({ keepSession: ctx.session && ctx.session.id });
    });
    audit.log({ user: ctx.user, action: 'security.authenticator_allowlist', ip: ctx.ip, details: { enabled: on, was_enabled: before.enabled, models: list.map((m) => m.aaguid),
      affected_accounts: aff.account_count, affected_passkeys: aff.passkey_count, affected_users: aff.accounts.slice(0, 200).map((a) => a.user_id), sessions_ended: ended || undefined, mds_no: (L.metadataInfo() || {}).no ?? null,
      grace_days: days, grace_passkeys: grace.passkeys, grace_until: grace.until, stops_now: aff.stops_now_count, only_factor_users: aff.only_factor_accounts.slice(0, 200).map((a) => a.user_id) } });
    return { ...L.status(), affected: L.affected({ on, list, current: true }) };
  });
  // The FIDO Metadata Service BLOB (blob.jwt, a few megabytes), which the administrator downloads from
  // https://mds3.fidoalliance.org/ and uploads here as text: SUDS makes no outbound call. Up to 20 MB, for an
  // administrator's session only (bodyLimitFor; every other request keeps its own cap).
  const MDS_PATH = '/api/admin/authenticator-metadata';
  require('../app').bodyLimitFor(MDS_PATH, (ctx) => (ctx.user && !(ctx.session && ctx.session.mfa_pending) && auth.hasPerm(ctx.user, 'settings:manage') ? 20 * 1024 * 1024 : null));
  r.post(MDS_PATH, auth.requireAuth, auth.requirePerm('settings:manage'), async (ctx) => {
    const v = validate(ctx.body || {}, { blob: { type: 'string', required: true, maxLen: 20 * 1024 * 1024 }, ...reauthRules });
    await auth.verifySigner(ctx, v, { action: 'security.authenticator_metadata.failed', purpose: 'load the authenticator metadata', fresh: true });
    let info;
    try { info = L.loadMetadata(v.blob); }
    catch (e) {
      if (!(e instanceof W.WebAuthnError)) throw e;
      audit.log({ user: ctx.user, action: 'security.authenticator_metadata.refused', ip: ctx.ip, success: false, details: { reason: e.code } });
      throw badRequest(`The metadata file was not loaded: ${e.message}`, { metadataError: e.code });
    }
    // A model the new file reports compromised or revoked (or no longer lists) refuses its passkeys from now on: the
    // sessions they opened end too.
    const ended = L.endRefusedSessions({ keepSession: ctx.session && ctx.session.id });
    audit.log({ user: ctx.user, action: 'security.authenticator_metadata', ip: ctx.ip, details: { no: info.no, next_update: info.next_update, entries: info.entries, sha256: info.sha256, test_root: info.test_root || undefined, sessions_ended: ended || undefined } });
    const st = L.status();
    return { metadata: info, models: st.models, affected: L.affected({ on: st.enabled, list: L.models(), current: true }) };
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
