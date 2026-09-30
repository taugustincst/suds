'use strict';
// Fingerprint sign-in, authorization and signing with passkeys (docs/FINGERPRINT.md). The WebAuthn verification is
// server/webauthn.js; this file is what SUDS does with it: the relying party (host and origins), the challenges
// (random 32 bytes for enrolment and sign-in; for a signature or an approval, the SHA-256 of a canonical statement of
// exactly what is being signed), enrolment, sign-in and the second sign-in step, and the confirmation a signature or
// approval accepts in place of the password or authenticator code (auth.verifySigner), with its evidence kept.
//
// SUDS never receives or stores a fingerprint or any biometric template. The device matches the finger (or takes its
// screen-lock PIN: WebAuthn cannot tell which) and signs; SUDS keeps the credential's public key and id, its counter,
// transports, AAGUID, its owner's name for it and dates (the passkeys table). Office server only.
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const audit = require('./audit');
const W = require('./webauthn');
const { encrypt, decrypt, sha256, uuid } = require('./crypto');
const { HttpError, badRequest, forbidden, notFound } = require('./http');

const CHALLENGE_MS = 2 * 60_000;
const MAX_PER_USER = 10;
const TIMEOUT_MS = 120_000;
const auth = () => require('./auth');

// ---- where passkeys work ----
function hostParts(ctx) {
  const raw = String((config.trustProxy && ctx.headers['x-forwarded-host']) || ctx.headers.host || '').split(',')[0].trim();
  let url; try { url = new URL(`http://${raw}`); } catch { return null; }
  return { host: url.host, hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase() };
}
function secureRequest(ctx) {
  if (config.tls && config.tls.cert) return true;
  const proto = String(ctx.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return !!config.trustProxy && proto === 'https';
}
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];
/**
 * The relying party for this request: { rpId, origins, rpName }, or throws saying why passkeys cannot work here.
 * The RP ID is WEBAUTHN_RP_ID, else the host the request was addressed to, which must be it or one of its
 * subdomains. HTTPS is required, except plain http on localhost outside production (a developer's machine).
 */
function relyingParty(ctx) {
  if (config.local) throw new HttpError(404, 'Fingerprint sign-in is not available on this device');
  const hp = hostParts(ctx);
  if (!hp || !hp.hostname) throw badRequest('The request did not say which address it was sent to');
  const wc = config.webauthn || { rpId: '', origins: [] };
  const rpId = wc.rpId || hp.hostname;
  if (hp.hostname !== rpId && !hp.hostname.endsWith('.' + rpId)) throw new HttpError(403, `Fingerprint sign-in is set up for ${rpId}; open SUDS at that address to use it.`, { passkeyUnavailable: 'address' });
  const secure = secureRequest(ctx);
  const devLoopback = LOOPBACK.includes(hp.hostname) && !config.isProd;
  // A passkey belongs to a host name; browsers refuse an IP address as one (a LAN install opened as https://192.168.1.10).
  if (!wc.rpId && !devLoopback && (/^\d{1,3}(\.\d{1,3}){3}$/.test(hp.hostname) || hp.hostname.includes(':'))) throw new HttpError(403, 'Fingerprint sign-in needs SUDS to be opened by its name, not an IP address. Ask your administrator for the address (docs/SELF-HOSTING.md).', { passkeyUnavailable: 'address' });
  if (!secure && !devLoopback) throw new HttpError(403, 'Fingerprint sign-in needs HTTPS. Ask your administrator to turn on HTTPS for SUDS (docs/SELF-HOSTING.md).', { passkeyUnavailable: 'https' });
  const origins = wc.origins && wc.origins.length ? wc.origins : [`${secure ? 'https' : 'http'}://${hp.host}`];
  return { rpId, origins, rpName: db.getSetting('org_name', 'SUDS') || 'SUDS' };
}
/** Whether passkeys can work for this request, without throwing: { ok, reason }. */
function availability(ctx) {
  try { relyingParty(ctx); return { ok: true }; } catch (e) { return { ok: false, reason: e.message, code: (e.extra && e.extra.passkeyUnavailable) || 'unavailable' }; }
}

// ---- challenges ----
// Answered or not, a challenge is kept for an hour past its expiry (so a replay is told it was used), then deleted.
function purge() { db.run(`DELETE FROM webauthn_challenges WHERE expires_at < ?`, new Date(Date.now() - 60 * 60_000).toISOString()); }
/** Issue a challenge (base64url). With a statement, it is the statement's SHA-256; otherwise 32 random bytes. */
function issue({ purpose, userId = null, sessionId = null, statement = null }) {
  purge();
  const bytes = statement ? W.statementChallenge(statement) : crypto.randomBytes(32);
  const now = Date.now();
  db.run(`INSERT INTO webauthn_challenges(id,purpose,user_id,session_id,statement,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`,
    sha256(bytes), purpose, userId, sessionId, statement ? JSON.stringify(statement) : null, new Date(now).toISOString(), new Date(now + CHALLENGE_MS).toISOString());
  return W.b64url(bytes);
}
/** The challenge the browser signed, read from the client data (verified against the signature afterwards). */
function challengeOf(credential) {
  try {
    const cd = JSON.parse(W.fromB64url(credential.response.clientDataJSON).toString('utf8'));
    if (typeof cd.challenge === 'string' && cd.challenge.length <= 100) return cd.challenge;
  } catch { /* below */ }
  throw new W.WebAuthnError('challenge', 'The passkey response has no challenge');
}
/**
 * Use a challenge up: it must exist, be unused, unexpired, for this purpose, and (when it was issued to someone) for
 * this user and session. Taken before the signature is checked, so any answer to it, right or wrong, spends it.
 */
function take(challenge, { purpose, userId = null, sessionId = null }) {
  const id = sha256(W.fromB64url(challenge));
  const row = db.one(`SELECT * FROM webauthn_challenges WHERE id=?`, id);
  if (!row) throw new W.WebAuthnError('challenge', 'This confirmation is not one SUDS asked for. Try again.');
  const used = db.run(`UPDATE webauthn_challenges SET used_at=? WHERE id=? AND used_at IS NULL`, db.now(), id);
  if (!used.changes) throw new W.WebAuthnError('challenge_used', 'This confirmation has already been used. Try again.');
  if (Date.parse(row.expires_at) < Date.now()) throw new W.WebAuthnError('challenge_expired', 'The confirmation took too long (over two minutes). Try again.');
  if (row.purpose !== purpose) throw new W.WebAuthnError('challenge_purpose', 'This confirmation was asked for something else. Try again.');
  if (row.user_id && row.user_id !== userId) throw new W.WebAuthnError('challenge_user', 'This confirmation was asked for by another account.');
  if (row.session_id && row.session_id !== sessionId) throw new W.WebAuthnError('challenge_session', 'This confirmation was asked for in another session.');
  const statement = row.statement ? JSON.parse(row.statement) : null;
  if (statement && sha256(W.statementChallenge(statement)) !== id) throw new W.WebAuthnError('challenge', 'The stored statement does not match its challenge');
  return { ...row, statement };
}

// ---- credentials ----
const present = (p) => ({ id: p.id, name: p.name, created_at: p.created_at, last_used_at: p.last_used_at, transports: p.transports ? JSON.parse(p.transports) : [], aaguid: p.aaguid,
  algorithm: W.ALG_NAMES[p.alg] || String(p.alg), synced: !!p.backed_up, flagged: !!p.flagged_at, flagged_at: p.flagged_at || null, flag_reason: p.flag_reason || null });
function list(userId) { return db.all(`SELECT * FROM passkeys WHERE user_id=? ORDER BY created_at`, userId).map(present); }
function findByCredential(credentialId) { return typeof credentialId === 'string' && credentialId.length <= 1400 ? db.one(`SELECT * FROM passkeys WHERE credential_id=?`, credentialId) : null; }
const descriptor = (p) => ({ type: 'public-key', id: p.credential_id, ...(p.transports ? { transports: JSON.parse(p.transports) } : {}) });
const userHandle = (userId) => W.b64url(Buffer.from(String(userId), 'utf8'));
const cleanName = (name) => String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);

function requirePolicy(which) {
  const pol = auth().policy();
  if (which === 'signin' && !pol.passkeySignin) throw new HttpError(403, 'Fingerprint sign-in is turned off for this programme.', { passkeyDisabled: true });
  if (which === 'signing' && !pol.passkeySigning) throw new HttpError(403, 'Confirming with a fingerprint is turned off for this programme. Use your password or authenticator code.', { passkeyDisabled: true });
  if (which === 'any' && !pol.passkeySignin && !pol.passkeySigning) throw new HttpError(403, 'Fingerprint sign-in and signing are turned off for this programme.', { passkeyDisabled: true });
  return pol;
}

// ---- enrolment ----
/**
 * Step one of adding a passkey: a fresh password (and, with two-step verification on, the authenticator code; for an
 * account that signs in only through single sign-on, a single sign-on confirmation just made), then the creation
 * options for the browser. Every failure counts toward the account lockout and is audited (auth.confirmPassword).
 */
async function registrationOptions(ctx, { password, code }) {
  requirePolicy('any');
  const rp = relyingParty(ctx);
  const A = auth();
  const u = db.one(`SELECT id, username, display_name, password_hash, mfa_enabled, oidc_subject FROM users WHERE id=?`, ctx.user.id);
  const action = 'auth.passkey.enrol.failed';
  if (!A.hasLocalPassword(u.password_hash) && u.oidc_subject) {
    if (!A.takeSsoProof(ctx)) throw new HttpError(403, 'Confirm with single sign-on first, then add the passkey.', { reauthRequired: true, method: 'sso' });
  } else {
    if (!password) throw badRequest('Enter your password to add a passkey', { fields: { password: 'required' } });
    await A.confirmPassword(ctx, password, { action });
    if (u.mfa_enabled) {
      if (!code || !String(code).trim()) throw badRequest('Enter the code from your authenticator app as well as your password', { fields: { code: 'required' } });
      A.confirmCode(ctx, code, { action });
    }
  }
  A.clearFailures(u.id);
  const existing = db.all(`SELECT * FROM passkeys WHERE user_id=?`, u.id);
  if (existing.length >= MAX_PER_USER) throw badRequest(`You already have ${MAX_PER_USER} passkeys, the most one account may have. Remove one you no longer use first.`);
  const challenge = issue({ purpose: 'register', userId: u.id, sessionId: ctx.session.id });
  return { publicKey: {
    challenge, rp: { id: rp.rpId, name: rp.rpName }, user: { id: userHandle(u.id), name: u.username, displayName: u.display_name || u.username },
    pubKeyCredParams: [{ type: 'public-key', alg: W.ALGS.ES256 }, { type: 'public-key', alg: W.ALGS.EdDSA }, { type: 'public-key', alg: W.ALGS.RS256 }],
    timeout: TIMEOUT_MS, attestation: 'none',
    // The device's own authenticator (Touch ID, Windows Hello, an Android fingerprint), discoverable where it can be,
    // and always with user verification: a passkey used without the fingerprint (or screen lock) is refused.
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
    excludeCredentials: existing.map(descriptor),
  } };
}
/** Step two: check the new credential and keep its public key. Audited (auth.passkey.enrolled). */
function registrationFinish(ctx, { credential, name }) {
  requirePolicy('any');
  const rp = relyingParty(ctx);
  try {
    if (!credential || typeof credential !== 'object') throw new W.WebAuthnError('shape', 'The passkey response is missing');
    take(challengeOf(credential), { purpose: 'register', userId: ctx.user.id, sessionId: ctx.session.id });
    const reg = W.verifyRegistration(credential, { challenge: challengeOf(credential), rpId: rp.rpId, origins: rp.origins });
    if (findByCredential(reg.credentialId)) throw new HttpError(409, 'This passkey is already registered.');
    if (db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, ctx.user.id).n >= MAX_PER_USER) throw badRequest(`You already have ${MAX_PER_USER} passkeys.`);
    const id = uuid();
    const label = cleanName(name) || 'Passkey';
    db.run(`INSERT INTO passkeys(id,user_id,credential_id,public_key,alg,sign_count,transports,aaguid,backup_eligible,backed_up,rp_id,name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.user.id, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, JSON.stringify(reg.transports), reg.aaguid, reg.backupEligible ? 1 : 0, reg.backedUp ? 1 : 0, rp.rpId, label);
    // The name is the owner's label for their device ("Maria's iPhone"): staff information, not client information.
    audit.log({ user: ctx.user, action: 'auth.passkey.enrolled', entity: 'passkey', entityId: id, ip: ctx.ip, details: { algorithm: W.ALG_NAMES[reg.alg], aaguid: reg.aaguid, synced: reg.backedUp, count: db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, ctx.user.id).n } });
    return present(db.one(`SELECT * FROM passkeys WHERE id=?`, id));
  } catch (e) {
    if (!(e instanceof W.WebAuthnError)) throw e;
    audit.log({ user: ctx.user, action: 'auth.passkey.enrol.failed', ip: ctx.ip, success: false, details: { reason: e.code } });
    throw badRequest(`The passkey could not be added: ${e.message}`, { passkeyError: e.code });
  }
}
function rename(ctx, id, name) {
  const p = db.one(`SELECT * FROM passkeys WHERE id=? AND user_id=?`, id, ctx.user.id);
  if (!p) throw notFound('Passkey not found');
  const label = cleanName(name);
  if (!label) throw badRequest('Give the passkey a name', { fields: { name: 'required' } });
  db.run(`UPDATE passkeys SET name=? WHERE id=?`, label, p.id);
  audit.log({ user: ctx.user, action: 'auth.passkey.renamed', entity: 'passkey', entityId: p.id, ip: ctx.ip });
  return present(db.one(`SELECT * FROM passkeys WHERE id=?`, p.id));
}
/** Remove passkeys (the owner's one, an administrator's revocation, offboarding). Returns how many went. */
function remove(userId, { id = null, actor, ip, cause }) {
  const rows = id ? db.all(`SELECT id FROM passkeys WHERE id=? AND user_id=?`, id, userId) : db.all(`SELECT id FROM passkeys WHERE user_id=?`, userId);
  for (const r of rows) db.run(`DELETE FROM passkeys WHERE id=?`, r.id);
  if (rows.length) audit.log({ user: actor, action: 'auth.passkey.removed', entity: 'user', entityId: userId, ip, details: { count: rows.length, passkeys: rows.map(r => r.id), cause } });
  return rows.length;
}

// ---- assertion checks shared by sign-in and signing ----
/**
 * Check an assertion against the stored credential `pk` (already the right user's), with the challenge taken. On
 * success the counter and last use are updated. A counter that went backwards flags the credential (refused from
 * then on) and is audited as auth.passkey.clone_suspected. Throws WebAuthnError on any failure.
 */
function checkAssertion(ctx, credential, pk, rp, challenge) {
  if (pk.flagged_at) throw new W.WebAuthnError('flagged', 'This passkey has been disabled because it may have been copied. Remove it under My profile and add it again.');
  if (pk.rp_id !== rp.rpId) throw new W.WebAuthnError('rpid', `This passkey was made for ${pk.rp_id}.`);
  if (credential.rawId !== undefined && credential.rawId !== credential.id) throw new W.WebAuthnError('credential', 'The credential ids do not match');
  const uh = credential.response && credential.response.userHandle;
  if (uh && uh !== userHandle(pk.user_id)) throw new W.WebAuthnError('user_handle', 'The passkey belongs to another account');
  const r = W.verifyAssertion(credential, { publicKey: pk.public_key, alg: pk.alg, signCount: pk.sign_count }, { challenge, rpId: rp.rpId, origins: rp.origins });
  if (r.cloned) {
    db.run(`UPDATE passkeys SET flagged_at=?, flag_reason=? WHERE id=?`, db.now(), `signature counter went from ${pk.sign_count} to ${r.signCount}`, pk.id);
    audit.log({ user: { id: pk.user_id }, action: 'auth.passkey.clone_suspected', entity: 'passkey', entityId: pk.id, ip: ctx.ip, success: false, details: { stored_count: pk.sign_count, presented_count: r.signCount } });
    throw new W.WebAuthnError('counter', 'This passkey\'s counter went backwards, which can mean it was copied. It has been disabled; tell your administrator.');
  }
  db.run(`UPDATE passkeys SET sign_count=?, backed_up=?, last_used_at=? WHERE id=?`, r.signCount, r.backedUp ? 1 : 0, db.now(), pk.id);
  return r;
}

// ---- sign-in ----
/**
 * Options for "Sign in with fingerprint". Without a session: a discoverable-credential request (the browser offers the
 * device's passkeys for this site), or, with a username typed, that account's passkeys. A username nobody has gets a
 * made-up credential id, so the answer does not say which usernames exist. With a session still owing its second
 * step (a password sign-in, mfa_pending), the options are for finishing that sign-in with this account's passkeys.
 */
function loginOptions(ctx, { username } = {}) {
  requirePolicy('signin');
  const rp = relyingParty(ctx);
  const app = require('./app');
  if (!app.rateLimit(`passkey-options:${ctx.ip}`, 60, 60_000)) throw new HttpError(429, 'Too many attempts. Try again later.');
  if (ctx.user && ctx.session && ctx.session.mfa_pending) {
    const creds = db.all(`SELECT * FROM passkeys WHERE user_id=? AND flagged_at IS NULL`, ctx.user.id);
    if (!creds.length) throw badRequest('Your account has no passkey. Enter the code from your authenticator app.');
    return { purpose: 'mfa', publicKey: { challenge: issue({ purpose: 'mfa', userId: ctx.user.id, sessionId: ctx.session.id }), rpId: rp.rpId, timeout: TIMEOUT_MS, userVerification: 'required', allowCredentials: creds.map(descriptor) } };
  }
  let allow = [];
  const name = typeof username === 'string' ? username.trim().slice(0, 100) : '';
  if (name) {
    const u = db.one(`SELECT id, is_active FROM users WHERE username=?`, name);
    const creds = u && u.is_active ? db.all(`SELECT * FROM passkeys WHERE user_id=? AND flagged_at IS NULL`, u.id) : [];
    allow = creds.length ? creds.map(descriptor)
      : [{ type: 'public-key', id: W.b64url(crypto.createHmac('sha256', config.indexKey).update(`suds-no-passkey:${name.toLowerCase()}`).digest()), transports: ['internal'] }];
  }
  return { purpose: 'login', publicKey: { challenge: issue({ purpose: 'login' }), rpId: rp.rpId, timeout: TIMEOUT_MS, userVerification: 'required', allowCredentials: allow } };
}

/**
 * Finish "Sign in with fingerprint" (or the second sign-in step). The account's protections apply as to a password:
 * the per-address limit, the lockout, inactive and pending accounts, and "Require single sign-on" (refused like a
 * password, except for the named emergency accounts). A passkey with user verification is two factors: the session
 * needs no authenticator code and satisfies the roles that require two-step verification (mfa_source 'passkey').
 * Returns { token?, user, mfaPending: false } for the route to set the cookie.
 */
function loginFinish(ctx, { credential }) {
  requirePolicy('signin');
  const rp = relyingParty(ctx);
  const A = auth(); const app = require('./app'); const limit = config.loginRateLimit;
  if (app.rateLimited(`login:${ctx.ip}`, limit)) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
  if (ctx.headers['x-sync-client']) throw badRequest('A device syncs with a username and password');
  const second = !!(ctx.user && ctx.session && ctx.session.mfa_pending);
  const failedAttempt = (who, reason, message, status = 401) => {
    app.rateLimit(`login:${ctx.ip}`, limit, 15 * 60_000);
    audit.log({ user: who, action: second ? 'auth.mfa.failed' : 'auth.login.failed', ip: ctx.ip, success: false, details: { method: 'passkey', reason } });
    throw new HttpError(status, message, { passkeyError: reason });
  };
  if (!credential || typeof credential !== 'object' || !credential.response) failedAttempt(ctx.user || null, 'shape', 'The passkey response is missing', 400);
  let challenge;
  try { challenge = challengeOf(credential); take(challenge, second ? { purpose: 'mfa', userId: ctx.user.id, sessionId: ctx.session.id } : { purpose: 'login' }); }
  catch (e) { if (e instanceof W.WebAuthnError) failedAttempt(ctx.user || null, e.code, e.message); throw e; }
  const pk = findByCredential(credential.id);
  if (!pk) failedAttempt(ctx.user || null, 'unknown passkey', 'That passkey is not registered with SUDS here. Sign in with your password, then add it under My profile.');
  const user = db.one(`SELECT * FROM users WHERE id=?`, pk.user_id);
  const who = { id: user.id, username: user.username };
  if (second && user.id !== ctx.user.id) failedAttempt(who, 'another account', 'That passkey belongs to a different account.');
  if (!user.is_active) failedAttempt(who, user.access_status === 'active' ? 'inactive' : `access ${user.access_status}`, 'This account cannot sign in. Contact a SUDS administrator.', 403);
  if (A.isLocked(user)) {
    audit.log({ user: who, action: 'auth.login.locked', ip: ctx.ip, success: false, details: { method: 'passkey' } });
    throw new HttpError(423, 'Account locked. Try again later or contact an administrator.');
  }
  try { checkAssertion(ctx, credential, pk, rp, challenge); }
  catch (e) {
    if (!(e instanceof W.WebAuthnError)) throw e;
    // A signature that does not verify, or a missing fingerprint check, counts toward the account's lockout like a
    // wrong password (a flagged or copied credential does not: nothing was guessed, and it is refused anyway).
    const counts = !['flagged', 'counter', 'rpid'].includes(e.code);
    const locked = counts ? A.recordPasswordFailure(user) : false;
    failedAttempt(who, locked ? `${e.code}; locked after failures` : e.code, e.message, e.code === 'counter' || e.code === 'flagged' ? 403 : 401);
  }
  const pol = A.policy();
  if (second) {
    A.clearFailures(user.id);
    db.run(`UPDATE sessions SET mfa_pending=0, mfa_source='passkey', reauth_at=?, reauth_method='passkey' WHERE id=?`, db.now(), ctx.session.id);
    audit.log({ user: who, action: 'auth.login', ip: ctx.ip, details: { mfa: true, method: 'passkey', passkey: pk.id } });
    return { user: A.publicUser(user), mfaPending: false };
  }
  // "Require single sign-on": a passkey is refused like a password, except for the named emergency accounts.
  const emergency = pol.ssoRequired && pol.ssoEmergencyAccounts.includes(String(user.username).toLowerCase());
  if (pol.ssoRequired && !emergency) {
    audit.log({ user: who, action: 'auth.login.sso_required', ip: ctx.ip, success: false, details: { method: 'passkey' } });
    throw new HttpError(403, 'This organisation requires single sign-on. Use the county sign-in button instead.', { ssoRequired: true });
  }
  db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?`, db.now(), user.id);
  const token = A.createSession(user, ctx, { mfaPending: false, mfaSource: 'passkey', reauthMethod: 'passkey' });
  if (emergency) console.warn(`[suds] emergency (break-glass) passkey sign-in by ${user.username} while single sign-on is required`);
  audit.log({ user: who, action: 'auth.login', ip: ctx.ip, details: { method: 'passkey', passkey: pk.id, ...(emergency ? { emergency_account: true } : {}) } });
  return { token, user: A.publicUser(user), mfaPending: false, mfaSetupRequired: false, mfaSetupDeadline: null };
}

// ---- signatures and approvals ----
// What a fingerprint confirmation is bound to, per purpose: the record type, the ids, and a content hash computed
// from the record as it is now. The same function is called when the challenge is issued and again when the
// signature arrives (by the route, as `bind`), so a confirmation for record A cannot sign record B, and one for a
// record that has changed since cannot sign it either. Each checks the caller may act on what it names.
const noteHash = (n, userId) => sha256(`${n.id}|${userId}|${n.content_enc}|${n.structured_enc || ''}`);
const cosignHash = (n, userId) => sha256(`${n.id}|${userId}|cosign|${n.content_enc}|${n.structured_enc || ''}`);
const listHash = (rows) => sha256(W.canonical(rows));
function loadNote(ctx, id) {
  const n = typeof id === 'string' ? db.one(`SELECT * FROM notes WHERE id=? AND deleted_at IS NULL`, id) : null;
  if (!n) throw notFound('Note not found');
  auth().assertClientAccess(ctx, n.client_id);
  return n;
}
const idList = (ids, max) => {
  if (!Array.isArray(ids) || !ids.length || ids.length > max || ids.some(x => typeof x !== 'string' || x.length > 64)) throw badRequest(`ids must list 1 to ${max} records`);
  return [...new Set(ids)].sort();
};
const BINDINGS = {
  'note.sign': (ctx, p) => { const n = loadNote(ctx, p.note_id); if (n.author_id !== ctx.user.id) throw forbidden('Only the author can sign a note'); return { record_type: 'note', record_ids: [n.id], content: noteHash(n, ctx.user.id) }; },
  'note.cosign': (ctx, p) => { const n = loadNote(ctx, p.note_id); if (!auth().hasPerm(ctx.user, 'notes:cosign')) throw forbidden(); return { record_type: 'note', record_ids: [n.id], content: cosignHash(n, ctx.user.id) }; },
  'note.cosign-batch': (ctx, p) => {
    if (!auth().hasPerm(ctx.user, 'notes:cosign')) throw forbidden();
    const ids = idList(p.ids, 100);
    return { record_type: 'note', record_ids: ids, content: listHash(ids.map(id => { const n = db.one(`SELECT * FROM notes WHERE id=? AND deleted_at IS NULL`, id); return [id, n && auth().canAccessClient(ctx.user, n.client_id) ? cosignHash(n, ctx.user.id) : null]; })) };
  },
  'time.approve': (ctx, p) => {
    if (!auth().hasPerm(ctx.user, 'time:approve')) throw forbidden();
    const ids = idList(p.ids, 500);
    const decision = p.decision === 'rejected' ? 'rejected' : 'approved';
    return { record_type: 'time_entry', record_ids: ids, content: listHash({ decision, entries: ids.map(id => { const t = db.one(`SELECT id,user_id,work_date,minutes,category,funding_source_id,client_id,status,updated_at FROM time_entries WHERE id=?`, id); return t ? [t.id, t.user_id, t.work_date, t.minutes, t.category, t.funding_source_id, t.client_id, t.status, t.updated_at] : [id, null]; }) }) };
  },
  'expenditure.approve': (ctx, p) => {
    if (!auth().hasPerm(ctx.user, 'budget:approve')) throw forbidden();
    const e = typeof p.id === 'string' ? db.one(`SELECT id,user_id,funding_source_id,budget_line_id,amount,spent_at,status,updated_at FROM expenditures WHERE id=?`, p.id) : null;
    if (!e) throw notFound();
    const status = ['approved', 'rejected', 'reimbursed'].includes(p.status) ? p.status : 'approved';
    return { record_type: 'expenditure', record_ids: [e.id], content: listHash({ status, expenditure: [e.id, e.user_id, e.funding_source_id, e.budget_line_id, e.amount, e.spent_at, e.status, e.updated_at] }) };
  },
  'keys.download': (ctx) => { if (!auth().hasPerm(ctx.user, 'settings:manage')) throw forbidden(); return { record_type: 'keys', record_ids: ['keys-backup'], content: sha256('suds-keys-backup') }; },
};
const PURPOSES = Object.keys(BINDINGS);
/** What `purpose` binds to for these parameters, as the route computes it: { purpose, record_type, record_ids, content }. */
function bindingFor(ctx, purpose, params = {}) {
  const f = BINDINGS[purpose];
  if (!f) throw badRequest(`purpose must be one of ${PURPOSES.join(', ')}`);
  return { purpose, ...f(ctx, params || {}) };
}

/**
 * A challenge for "Confirm with fingerprint": the SHA-256 of the statement { v, purpose, record_type, record_ids,
 * content, user_id, rp_id, issued_at, nonce } in canonical JSON, bound to this user and session, single-use, two
 * minutes. The browser shows the device's prompt; the route receives the assertion as `passkey` (auth.verifySigner).
 */
function signingOptions(ctx, purpose, params) {
  requirePolicy('signing');
  const rp = relyingParty(ctx);
  const b = bindingFor(ctx, purpose, params);
  const creds = db.all(`SELECT * FROM passkeys WHERE user_id=? AND flagged_at IS NULL`, ctx.user.id);
  if (!creds.length) throw badRequest('You have no passkey yet. Add one under My profile → Fingerprint sign-in.');
  const statement = { v: 1, purpose: b.purpose, record_type: b.record_type, record_ids: b.record_ids, content: b.content, user_id: ctx.user.id, rp_id: rp.rpId,
    issued_at: new Date().toISOString(), nonce: crypto.randomBytes(16).toString('hex') };
  const challenge = issue({ purpose: `sign:${b.purpose}`, userId: ctx.user.id, sessionId: ctx.session.id, statement });
  return { statement_hash: W.fromB64url(challenge).toString('hex'), publicKey: { challenge, rpId: rp.rpId, timeout: TIMEOUT_MS, userVerification: 'required', allowCredentials: creds.map(descriptor) } };
}

/**
 * Check a fingerprint confirmation for `bind` (auth.verifySigner calls this). The challenge must be one issued to
 * this user in this session for this purpose, and its statement must name exactly the records and content `bind`
 * does now. On success the evidence is stored (signature_evidence, encrypted) and its id returned. On failure: the
 * failed-attempt audit entry `action`, the account's failure count (lockout), the quick-signing window closed.
 */
function confirm(ctx, credential, bind, { action }) {
  requirePolicy('signing');
  const rp = relyingParty(ctx);
  const A = auth();
  const refuse = (reason, message, { counts = true } = {}) => {
    const u = db.one(`SELECT id, failed_attempts FROM users WHERE id=?`, ctx.user.id);
    const locked = counts ? A.recordPasswordFailure(u) : false;
    A.clearReauth(ctx);
    audit.log({ user: ctx.user, action, ip: ctx.ip, success: false, details: { method: 'passkey', reason, ...(locked ? { locked: true } : {}) } });
    if (locked) throw new HttpError(423, `${message} The account is now locked after too many failed attempts.`);
    throw new HttpError(403, message, { passkeyError: reason });
  };
  let row, challenge;
  try {
    if (!credential || typeof credential !== 'object' || !credential.response) throw new W.WebAuthnError('shape', 'The passkey response is missing');
    challenge = challengeOf(credential);
    row = take(challenge, { purpose: `sign:${bind.purpose}`, userId: ctx.user.id, sessionId: ctx.session && ctx.session.id });
  } catch (e) { if (e instanceof W.WebAuthnError) refuse(e.code, e.message, { counts: false }); throw e; }
  const st = row.statement || {};
  if (st.record_type !== bind.record_type || W.canonical(st.record_ids) !== W.canonical(bind.record_ids)) refuse('another record', 'That fingerprint confirmation was for a different record. Confirm again for this one.', { counts: false });
  if (st.content !== bind.content) refuse('record changed', 'The record changed after you confirmed. Check it and confirm again.', { counts: false });
  if (st.user_id !== ctx.user.id || st.rp_id !== rp.rpId) refuse('statement', 'That fingerprint confirmation is not valid here.', { counts: false });
  const pk = findByCredential(credential.id);
  if (!pk || pk.user_id !== ctx.user.id) refuse('unknown passkey', 'That passkey is not one of yours on SUDS.', { counts: false });
  let r;
  try { r = checkAssertion(ctx, credential, pk, rp, challenge); }
  catch (e) { if (e instanceof W.WebAuthnError) refuse(e.code, e.message, { counts: !['flagged', 'counter', 'rpid'].includes(e.code) }); throw e; }
  A.clearFailures(ctx.user.id);
  // statement_hash: SHA-256 of the canonical statement, which is the challenge the device signed (the challenge row's
  // own id is the hash of that again: challenges are kept hashed).
  const statementHash = W.statementChallenge(st).toString('hex');
  const evidence = {
    v: 1, statement: st, statement_hash: statementHash, rp_id: rp.rpId, origin: r.clientData.origin,
    credential_id: pk.credential_id, passkey_id: pk.id, passkey_name: pk.name, public_key: pk.public_key, alg: pk.alg,
    authenticator_data: W.b64url(r.authData), client_data_json: W.b64url(r.clientDataJSON), client_data_hash: crypto.createHash('sha256').update(r.clientDataJSON).digest('hex'),
    signature: W.b64url(r.signature), flags: r.flags, sign_count: r.signCount, user_verified: r.uv, user_present: r.up, verified_at: db.now(),
  };
  const id = uuid();
  db.run(`INSERT INTO signature_evidence(id,user_id,passkey_id,purpose,record_type,record_ids,statement_hash,evidence_enc) VALUES(?,?,?,?,?,?,?,?)`,
    id, ctx.user.id, pk.id, bind.purpose, bind.record_type, JSON.stringify(bind.record_ids), statementHash, encrypt(JSON.stringify(evidence)));
  return id;
}

/** The stored evidence for a record, each re-verified (server/webauthn.js verifyEvidence). `purpose` narrows it. */
function evidenceFor(recordType, recordId, { purpose = null } = {}) {
  const rows = db.all(`SELECT * FROM signature_evidence WHERE record_type=? AND EXISTS (SELECT 1 FROM json_each(signature_evidence.record_ids) WHERE value=?) ${purpose ? 'AND purpose=?' : ''} ORDER BY created_at`,
    recordType, recordId, ...(purpose ? [purpose] : []));
  return rows.map((r) => {
    let ev = null; try { ev = JSON.parse(decrypt(r.evidence_enc)); } catch { ev = null; }
    const check = ev ? W.verifyEvidence(ev) : { ok: false, reason: 'unreadable' };
    return { id: r.id, purpose: r.purpose, user_id: r.user_id, created_at: r.created_at, statement_hash: r.statement_hash, evidence: ev, verified: check.ok, checks: check.checks, reason: check.reason };
  });
}

/** Passkey adoption, for Settings → Security status: accounts with one, and how many there are. */
function adoption() {
  const active = db.one(`SELECT COUNT(*) n FROM users WHERE is_active=1`).n;
  const withKey = db.one(`SELECT COUNT(DISTINCT p.user_id) n FROM passkeys p JOIN users u ON u.id=p.user_id WHERE u.is_active=1 AND p.flagged_at IS NULL`).n;
  const total = db.one(`SELECT COUNT(*) n FROM passkeys`).n;
  const flagged = db.one(`SELECT COUNT(*) n FROM passkeys WHERE flagged_at IS NOT NULL`).n;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const signIns = db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='auth.login' AND at >= ? AND details LIKE '%"method":"passkey"%'`, since).n;
  const signatures = db.one(`SELECT COUNT(*) n FROM signature_evidence WHERE created_at >= ?`, since).n;
  return { active, with_passkey: withKey, total, flagged, sign_ins_30d: signIns, confirmations_30d: signatures };
}

module.exports = { CHALLENGE_MS, MAX_PER_USER, PURPOSES, relyingParty, availability, issue, take, list, remove, rename, registrationOptions, registrationFinish,
  loginOptions, loginFinish, bindingFor, signingOptions, confirm, evidenceFor, adoption, userHandle };
