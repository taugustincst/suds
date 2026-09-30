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
// The authenticator allow-list (docs/FINGERPRINT.md, "Authenticator allow-list"; off by default): which passkeys may
// be added and used when a programme accepts only certain authenticator models.
const L = require('./authenticator-allowlist');
const { encrypt, decrypt, sha256, uuid } = require('./crypto');
const { HttpError, badRequest, forbidden, notFound } = require('./http');

const CHALLENGE_MS = 2 * 60_000;
const MAX_PER_USER = 10;
const TIMEOUT_MS = 120_000;
// Challenges nobody has signed in for yet (the sign-in page's options): at most this many waiting per address, and
// this many in all, so a script asking for options cannot fill the table.
const MAX_OPEN_PER_IP = 20;
const MAX_OPEN_TOTAL = 5000;
const PURGE_EVERY_MS = 60 * 60_000;
const auth = () => require('./auth');

// ---- where passkeys work ----
/**
 * The host a request was addressed to. `forwarded`: behind a trusted proxy, the host the browser used (X-Forwarded-Host)
 * — used only to check the address and build the page's origin, never to choose the relying party ID: a header must
 * not decide which host passkeys are made for.
 */
function hostParts(ctx, { forwarded = true } = {}) {
  const raw = String((forwarded && config.trustProxy && ctx.headers['x-forwarded-host']) || ctx.headers.host || '').split(',')[0].trim();
  let url; try { url = new URL(`http://${raw}`); } catch { return null; }
  return { host: url.host, hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase() };
}
/** The relying party ID the configuration sets: WEBAUTHN_RP_ID, else the host of the first of WEBAUTHN_ORIGINS. '' for none. */
function configuredRpId() {
  const wc = config.webauthn || {};
  if (wc.rpId) return wc.rpId;
  for (const o of wc.origins || []) { try { const h = new URL(o).hostname.toLowerCase(); if (h) return h; } catch { /* next */ } }
  return '';
}
function secureRequest(ctx) {
  if (config.tls && config.tls.cert) return true;
  const proto = String(ctx.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return !!config.trustProxy && proto === 'https';
}
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];
/**
 * The relying party for this request: { rpId, origins, rpName }, or throws saying why passkeys cannot work here.
 * The RP ID is WEBAUTHN_RP_ID (or the host of WEBAUTHN_ORIGINS), which production REQUIRES: without it no options are
 * issued and Settings → Security status says so in red (the owner's decision, docs/FINGERPRINT.md). Outside production
 * it falls back to the Host header (never X-Forwarded-Host). The request's host must be the RP ID or one of its
 * subdomains. HTTPS is required, except plain http on localhost outside production (a developer's machine).
 */
function relyingParty(ctx) {
  if (config.local) throw new HttpError(404, 'Fingerprint sign-in is not available on this device');
  const hp = hostParts(ctx);
  if (!hp || !hp.hostname) throw badRequest('The request did not say which address it was sent to');
  const wc = config.webauthn || { rpId: '', origins: [] };
  const configured = configuredRpId();
  if (!configured && config.isProd) throw new HttpError(503, 'Fingerprint sign-in is not set up on this server yet: its administrator must set WEBAUTHN_RP_ID to the server\'s name, as in the address staff open (docs/SELF-HOSTING.md). Sign in with your password.', { passkeyUnavailable: 'config' });
  const own = configured ? null : hostParts(ctx, { forwarded: false });
  const rpId = configured || (own && own.hostname);
  if (!rpId) throw badRequest('The request did not say which address it was sent to');
  if (hp.hostname !== rpId && !hp.hostname.endsWith('.' + rpId)) throw new HttpError(403, `Fingerprint sign-in is set up for ${rpId}; open SUDS at that address to use it.`, { passkeyUnavailable: 'address' });
  const secure = secureRequest(ctx);
  const devLoopback = LOOPBACK.includes(hp.hostname) && !config.isProd;
  // A passkey belongs to a host name; browsers refuse an IP address as one (a LAN install opened as https://192.168.1.10).
  if (!configured && !devLoopback && (/^\d{1,3}(\.\d{1,3}){3}$/.test(hp.hostname) || hp.hostname.includes(':'))) throw new HttpError(403, 'Fingerprint sign-in needs SUDS to be opened by its name, not an IP address. Ask your administrator for the address (docs/SELF-HOSTING.md).', { passkeyUnavailable: 'address' });
  if (!secure && !devLoopback) throw new HttpError(403, 'Fingerprint sign-in needs HTTPS. Ask your administrator to turn on HTTPS for SUDS (docs/SELF-HOSTING.md).', { passkeyUnavailable: 'https' });
  const origins = wc.origins && wc.origins.length ? wc.origins : [`${secure ? 'https' : 'http'}://${hp.host}`];
  return { rpId, origins, rpName: db.getSetting('org_name', 'SUDS') || 'SUDS' };
}
/** Whether passkeys can work for this request, without throwing: { ok, reason }. */
function availability(ctx) {
  try { relyingParty(ctx); return { ok: true }; } catch (e) { return { ok: false, reason: e.message, code: (e.extra && e.extra.passkeyUnavailable) || 'unavailable' }; }
}

// ---- challenges ----
// Answered or not, a challenge is kept for an hour past its expiry (so a replay is told it was used), then deleted,
// by a sweep at most once an hour (purgeDue) rather than on every request.
let lastPurge = 0;
function purge() { lastPurge = Date.now(); return db.run(`DELETE FROM webauthn_challenges WHERE expires_at < ?`, new Date(Date.now() - 60 * 60_000).toISOString()).changes; }
function purgeDue() { if (Date.now() - lastPurge >= PURGE_EVERY_MS) purge(); }
// What a waiting challenge keeps of its statement: everything but the content hashes (`content`, and a batch's `items`).
// A note's content hash is an unkeyed SHA-256 of its plaintext, so it is not left in a table outside the encrypted
// evidence for the challenge's hour; confirm() recomputes it from the record (bind) and checks that the statement
// rebuilt from both hashes to the challenge.
const HASHED_FIELDS = ['content', 'items'];
const withoutHashes = (st) => Object.fromEntries(Object.entries(st).filter(([k]) => !HASHED_FIELDS.includes(k)));
/**
 * Issue a challenge (base64url). With a statement, it is the statement's SHA-256 (the statement is kept without its
 * content hashes: withoutHashes); otherwise 32 random bytes. One for
 * nobody yet (`userId` null: the sign-in page) records the address that asked, and is refused past MAX_OPEN_PER_IP
 * waiting from that address or MAX_OPEN_TOTAL in all.
 */
function issue({ purpose, userId = null, sessionId = null, statement = null, ip = null }) {
  purgeDue();
  const nowIso = new Date().toISOString();
  if (!userId) {
    const open = db.one(`SELECT COUNT(*) n, SUM(CASE WHEN ip IS ? THEN 1 ELSE 0 END) mine FROM webauthn_challenges WHERE user_id IS NULL AND used_at IS NULL AND expires_at > ?`, ip, nowIso);
    if ((open.mine || 0) >= MAX_OPEN_PER_IP || open.n >= MAX_OPEN_TOTAL) throw new HttpError(429, 'Too many fingerprint sign-ins are waiting to be answered. Try again in two minutes.');
  }
  const bytes = statement ? W.statementChallenge(statement) : crypto.randomBytes(32);
  const now = Date.now();
  db.run(`INSERT INTO webauthn_challenges(id,purpose,user_id,session_id,statement,ip,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)`,
    sha256(bytes), purpose, userId, sessionId, statement ? JSON.stringify(withoutHashes(statement)) : null, ip, new Date(now).toISOString(), new Date(now + CHALLENGE_MS).toISOString());
  return W.b64url(bytes);
}
/**
 * The challenge the browser says it signed, read from the client data: only to find the stored challenge (take), by
 * its hash. The assertion is then checked against the stored one (verifyAssertion's challengeHash), not against this.
 */
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
  // The statement as kept (without its content hashes): confirm() completes it from the record and checks its hash.
  const statement = row.statement ? JSON.parse(row.statement) : null;
  // challengeHash: what the assertion's challenge must hash to (webauthn.js verifyAssertion), from the stored row.
  return { ...row, statement, challengeHash: row.id };
}

// ---- credentials ----
// `accepted`: whether the authenticator allow-list lets it be used now (always, with the list off); `attested`: its
// model was proven at enrolment (attestation verified under the list).
const attestedOf = (p) => { try { const a = JSON.parse(p.attestation || 'null'); return !!(a && a.verified); } catch { return false; } };
const present = (p) => { const al = L.passkeyAllowed(p); return { id: p.id, name: p.name, created_at: p.created_at, last_used_at: p.last_used_at, transports: p.transports ? JSON.parse(p.transports) : [], aaguid: p.aaguid,
  algorithm: W.ALG_NAMES[p.alg] || String(p.alg), synced: !!p.backed_up, flagged: !!p.flagged_at, flagged_at: p.flagged_at || null, flag_reason: p.flag_reason || null,
  attested: attestedOf(p), accepted: al.ok, not_accepted_reason: al.ok ? null : al.reason }; };
/** The passkeys of an account that can be used now: not disabled as a possible copy, and accepted by the allow-list. */
function usable(userId) { return db.all(`SELECT * FROM passkeys WHERE user_id=? AND flagged_at IS NULL`, userId).filter((p) => L.passkeyAllowed(p).ok); }
/** How many (auth.passkeyCount: whether a passkey counts as the account's second factor). */
function usableCount(userId) { return L.enabled() ? usable(userId).length : db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=? AND flagged_at IS NULL`, userId).n; }
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
  // Under the authenticator allow-list the device is asked to prove its model (attestation 'direct'), and any
  // authenticator may be offered (a security key too): the list, not the kind of authenticator, decides. Without
  // current metadata nothing could be checked, so no options are issued.
  const allowlist = L.enabled();
  if (allowlist) {
    const meta = L.metadataInfo();
    if (!meta || meta.expired) throw badRequest(meta ? `Your programme accepts only certain authenticator models, and the FIDO Metadata Service file SUDS checks them against is out of date (its next update was due on ${meta.next_update}). Ask your administrator to load the current one.` : 'Your programme accepts only certain authenticator models, and its administrator has not loaded the FIDO Metadata Service file SUDS checks them against yet. Ask your administrator.', { passkeyError: meta ? 'allowlist_metadata_expired' : 'allowlist_metadata' });
  }
  const challenge = issue({ purpose: 'register', userId: u.id, sessionId: ctx.session.id });
  return { publicKey: {
    challenge, rp: { id: rp.rpId, name: rp.rpName }, user: { id: userHandle(u.id), name: u.username, displayName: u.display_name || u.username },
    pubKeyCredParams: [{ type: 'public-key', alg: W.ALGS.ES256 }, { type: 'public-key', alg: W.ALGS.EdDSA }, { type: 'public-key', alg: W.ALGS.Ed25519 }, { type: 'public-key', alg: W.ALGS.RS256 }],
    timeout: TIMEOUT_MS, attestation: allowlist ? 'direct' : 'none',
    // The device's own authenticator (Touch ID, Windows Hello, an Android fingerprint), discoverable where it can be,
    // and always with user verification: a passkey used without the fingerprint (or screen lock) is refused.
    authenticatorSelection: { ...(allowlist ? {} : { authenticatorAttachment: 'platform' }), residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
    excludeCredentials: existing.map(descriptor),
  }, ...(allowlist ? { allowlist: { models: L.models().map((m) => m.name) } } : {}) };
}
/** Step two: check the new credential and keep its public key. Audited (auth.passkey.enrolled). */
function registrationFinish(ctx, { credential, name }) {
  requirePolicy('any');
  const rp = relyingParty(ctx);
  try {
    if (!credential || typeof credential !== 'object') throw new W.WebAuthnError('shape', 'The passkey response is missing');
    const row = take(challengeOf(credential), { purpose: 'register', userId: ctx.user.id, sessionId: ctx.session.id });
    const reg = W.verifyRegistration(credential, { challengeHash: row.challengeHash, rpId: rp.rpId, origins: rp.origins });
    if (findByCredential(reg.credentialId)) throw new HttpError(409, 'This passkey is already registered.');
    if (db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, ctx.user.id).n >= MAX_PER_USER) throw badRequest(`You already have ${MAX_PER_USER} passkeys.`);
    // The authenticator allow-list: the attestation verified against the model's roots in the loaded metadata.
    const attestation = L.enabled() ? L.checkRegistration(reg.attestation) : null;
    const id = uuid();
    const label = cleanName(name) || 'Passkey';
    db.run(`INSERT INTO passkeys(id,user_id,credential_id,public_key,alg,sign_count,transports,aaguid,backup_eligible,backed_up,rp_id,name,attestation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.user.id, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, JSON.stringify(reg.transports), attestation ? attestation.aaguid : reg.aaguid, reg.backupEligible ? 1 : 0, reg.backedUp ? 1 : 0, rp.rpId, label,
      attestation ? JSON.stringify(attestation) : null);
    // The name is the owner's label for their device ("Maria's iPhone"): kept out of the audit entry, as the key is.
    // The entry anchors the key instead: the SHA-256 of its SPKI and of the credential id, in the hash-chained log,
    // so a signature's evidence can be tied to the key accepted here (evidenceFor, scripts/verify-passkey-evidence.js).
    audit.log({ user: ctx.user, action: 'auth.passkey.enrolled', entity: 'passkey', entityId: id, ip: ctx.ip, details: { algorithm: W.ALG_NAMES[reg.alg], alg: reg.alg, aaguid: attestation ? attestation.aaguid : reg.aaguid, synced: reg.backedUp,
      ...(attestation ? { attestation: { verified: true, fmt: attestation.fmt, type: attestation.type, mds_no: attestation.mds_no } } : {}),
      ...W.credentialFingerprints({ publicKey: reg.publicKey, credentialId: reg.credentialId }), count: db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, ctx.user.id).n } });
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
/**
 * Remove passkeys (the owner's one, an administrator's revocation, a two-step reset, a password reset, offboarding).
 * The sessions those passkeys opened end with them (sessions.passkey_id; with every passkey gone, every session a
 * passkey opened): a lost phone's passkey taken away must not leave that phone signed in. `keepSession`: the owner's
 * own session, which has just given the password to remove it. Returns how many passkeys went.
 */
function remove(userId, { id = null, actor, ip, cause, keepSession = null }) {
  const rows = id ? db.all(`SELECT id FROM passkeys WHERE id=? AND user_id=?`, id, userId) : db.all(`SELECT id FROM passkeys WHERE user_id=?`, userId);
  for (const r of rows) db.run(`DELETE FROM passkeys WHERE id=?`, r.id);
  let ended = 0;
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const which = id ? `passkey_id IN (SELECT value FROM json_each(?))` : `(passkey_id IN (SELECT value FROM json_each(?)) OR mfa_source='passkey' OR reauth_method='passkey')`;
    ended = db.run(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${which} AND id IS NOT ?`, db.now(), userId, JSON.stringify(ids), keepSession).changes;
    audit.log({ user: actor, action: 'auth.passkey.removed', entity: 'user', entityId: userId, ip, details: { count: rows.length, passkeys: ids, cause, sessions_ended: ended || undefined } });
  }
  return rows.length;
}

// ---- assertion checks shared by sign-in and signing ----
/**
 * Check an assertion against the stored credential `pk` (already the right user's), with the challenge taken. On
 * success the counter and last use are updated. A counter that went backwards flags the credential (refused from
 * then on) and is audited as auth.passkey.clone_suspected. Throws WebAuthnError on any failure.
 */
function checkAssertion(ctx, credential, pk, rp, challengeHash) {
  if (pk.flagged_at) throw new W.WebAuthnError('flagged', 'This passkey has been disabled because it may have been copied. Remove it under My profile and add it again.');
  if (pk.rp_id !== rp.rpId) throw new W.WebAuthnError('rpid', `This passkey was made for ${pk.rp_id}.`);
  if (credential.rawId !== undefined && credential.rawId !== credential.id) throw new W.WebAuthnError('credential', 'The credential ids do not match');
  const uh = credential.response && credential.response.userHandle;
  if (uh && uh !== userHandle(pk.user_id)) throw new W.WebAuthnError('user_handle', 'The passkey belongs to another account');
  const r = W.verifyAssertion(credential, { publicKey: pk.public_key, alg: pk.alg, signCount: pk.sign_count }, { challengeHash, rpId: rp.rpId, origins: rp.origins });
  if (r.cloned) {
    db.run(`UPDATE passkeys SET flagged_at=?, flag_reason=? WHERE id=?`, db.now(), `signature counter went from ${pk.sign_count} to ${r.signCount}`, pk.id);
    audit.log({ user: { id: pk.user_id }, action: 'auth.passkey.clone_suspected', entity: 'passkey', entityId: pk.id, ip: ctx.ip, success: false, details: { stored_count: pk.sign_count, presented_count: r.signCount } });
    throw new W.WebAuthnError('counter', 'This passkey\'s counter went backwards, which can mean it was copied. It has been disabled; tell your administrator.');
  }
  // The authenticator allow-list: a passkey whose model was not proven for a listed model at enrolment (every one
  // added while the list was off), or whose model is now reported compromised, is refused at its next use. Checked
  // once the signature has verified, so only the passkey's holder learns why.
  const allowed = L.passkeyAllowed(pk);
  if (!allowed.ok) {
    audit.log({ user: { id: pk.user_id }, action: 'auth.passkey.not_allowed', entity: 'passkey', entityId: pk.id, ip: ctx.ip, success: false, details: { reason: allowed.reason, aaguid: pk.aaguid } });
    throw new W.WebAuthnError('not_allowed', L.refusalMessage(allowed.reason));
  }
  db.run(`UPDATE passkeys SET sign_count=?, backed_up=?, last_used_at=? WHERE id=?`, r.signCount, r.backedUp ? 1 : 0, db.now(), pk.id);
  return r;
}

// ---- sign-in ----
/**
 * Options for "Sign in with fingerprint". Without a session: a discoverable-credential request only (no
 * allowCredentials): the browser offers the device's passkeys for this site, and the answer is the same whoever is
 * asking, so it says nothing about which usernames exist or which credentials an account has. A username sent with
 * the request is ignored. With a session still owing its second step (a password sign-in, mfa_pending), the person is
 * known: the options list this account's passkeys, so a passkey that is not discoverable finishes it too.
 */
function loginOptions(ctx) {
  requirePolicy('signin');
  const rp = relyingParty(ctx);
  const app = require('./app');
  if (!app.rateLimit(`passkey-options:${ctx.ip}`, 60, 60_000)) throw new HttpError(429, 'Too many attempts. Try again later.');
  if (ctx.user && ctx.session && ctx.session.mfa_pending) {
    const creds = usable(ctx.user.id);
    if (!creds.length) throw badRequest(L.enabled() ? 'Your account has no passkey your programme accepts. Enter the code from your authenticator app.' : 'Your account has no passkey. Enter the code from your authenticator app.');
    return { purpose: 'mfa', publicKey: { challenge: issue({ purpose: 'mfa', userId: ctx.user.id, sessionId: ctx.session.id }), rpId: rp.rpId, timeout: TIMEOUT_MS, userVerification: 'required', allowCredentials: creds.map(descriptor) } };
  }
  return { purpose: 'login', publicKey: { challenge: issue({ purpose: 'login', ip: ctx.ip || null }), rpId: rp.rpId, timeout: TIMEOUT_MS, userVerification: 'required', allowCredentials: [] } };
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
  let row;
  try { row = take(challengeOf(credential), second ? { purpose: 'mfa', userId: ctx.user.id, sessionId: ctx.session.id } : { purpose: 'login' }); }
  catch (e) { if (e instanceof W.WebAuthnError) failedAttempt(ctx.user || null, e.code, e.message); throw e; }
  const pk = findByCredential(credential.id);
  if (!pk) failedAttempt(ctx.user || null, 'unknown passkey', 'No fingerprint sign-in for SUDS was found on this device. Sign in with your password, then add one under My profile.');
  const user = db.one(`SELECT * FROM users WHERE id=?`, pk.user_id);
  const who = { id: user.id, username: user.username };
  if (second && user.id !== ctx.user.id) failedAttempt(who, 'another account', 'That passkey belongs to a different account.');
  if (!user.is_active) failedAttempt(who, user.access_status === 'active' ? 'inactive' : `access ${user.access_status}`, 'This account cannot sign in. Contact a SUDS administrator.', 403);
  if (A.isLocked(user)) {
    audit.log({ user: who, action: 'auth.login.locked', ip: ctx.ip, success: false, details: { method: 'passkey' } });
    throw new HttpError(423, 'Account locked. Try again later or contact an administrator.');
  }
  try { checkAssertion(ctx, credential, pk, rp, row.challengeHash); }
  catch (e) {
    if (!(e instanceof W.WebAuthnError)) throw e;
    // A signature that does not verify, or a missing fingerprint check, counts toward the account's lockout like a
    // wrong password (a flagged or copied credential does not: nothing was guessed, and it is refused anyway).
    const counts = !['flagged', 'counter', 'rpid', 'not_allowed'].includes(e.code);
    const locked = counts ? A.recordPasswordFailure(user) : false;
    failedAttempt(who, locked ? `${e.code}; locked after failures` : e.code, e.message, ['counter', 'flagged', 'not_allowed'].includes(e.code) ? 403 : 401);
  }
  const pol = A.policy();
  if (second) {
    A.clearFailures(user.id);
    db.run(`UPDATE sessions SET mfa_pending=0, mfa_source='passkey', reauth_at=?, reauth_method='passkey', passkey_id=? WHERE id=?`, db.now(), pk.id, ctx.session.id);
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
  const token = A.createSession(user, ctx, { mfaPending: false, mfaSource: 'passkey', reauthMethod: 'passkey', passkeyId: pk.id });
  if (emergency) console.warn(`[suds] emergency (break-glass) passkey sign-in by ${user.username} while single sign-on is required`);
  audit.log({ user: who, action: 'auth.login', ip: ctx.ip, details: { method: 'passkey', passkey: pk.id, ...(emergency ? { emergency_account: true } : {}) } });
  return { token, user: A.publicUser(user), mfaPending: false, mfaSetupRequired: false, mfaSetupDeadline: null };
}

// ---- signatures and approvals ----
// What a fingerprint confirmation is bound to, per purpose: the record type, the ids, and a content hash computed
// from the record as it is now. The same function is called when the challenge is issued and again when the
// signature arrives (by the route, as `bind`), so a confirmation for record A cannot sign record B, and one for a
// record that has changed since cannot sign it either. Each checks the caller may act on what it names.
// A note is bound by its PLAINTEXT content hash (server/note-signature.js contentHash), which a key rotation does not
// change, so the evidence verifies afterwards (the owner's decision, docs/FINGERPRINT.md).
const NS = require('./note-signature');
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
  'note.sign': (ctx, p) => { const n = loadNote(ctx, p.note_id); if (n.author_id !== ctx.user.id) throw forbidden('Only the author can sign a note'); return { record_type: 'note', record_ids: [n.id], content: NS.contentHash(n, ctx.user.id, 'sign') }; },
  'note.cosign': (ctx, p) => { const n = loadNote(ctx, p.note_id); if (!auth().hasPerm(ctx.user, 'notes:cosign')) throw forbidden(); return { record_type: 'note', record_ids: [n.id], content: NS.contentHash(n, ctx.user.id, 'cosign') }; },
  // Each note's own content hash is in the statement (`items`), and `content` is the hash of that list: the evidence
  // then shows, for any one note, that its hash was among those countersigned (verifyNoteEvidence, step 5).
  'note.cosign-batch': (ctx, p) => {
    if (!auth().hasPerm(ctx.user, 'notes:cosign')) throw forbidden();
    const ids = idList(p.ids, 100);
    const items = ids.map(id => { const n = db.one(`SELECT * FROM notes WHERE id=? AND deleted_at IS NULL`, id); return [id, n && auth().canAccessClient(ctx.user, n.client_id) ? NS.contentHash(n, ctx.user.id, 'cosign') : null]; });
    return { record_type: 'note', record_ids: ids, content: listHash(items), items };
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
  const creds = usable(ctx.user.id);
  if (!creds.length) throw badRequest(L.enabled() && db.one(`SELECT 1 FROM passkeys WHERE user_id=? AND flagged_at IS NULL`, ctx.user.id) ? 'None of your passkeys is on your programme\'s list of accepted authenticators. Use your password or authenticator code, or add a passkey on an accepted authenticator under My profile → Fingerprint sign-in.' : 'You have no passkey yet. Add one under My profile → Fingerprint sign-in.');
  const statement = { v: 1, purpose: b.purpose, record_type: b.record_type, record_ids: b.record_ids, content: b.content, ...(b.items ? { items: b.items } : {}), user_id: ctx.user.id, rp_id: rp.rpId,
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
  let row;
  try {
    if (!credential || typeof credential !== 'object' || !credential.response) throw new W.WebAuthnError('shape', 'The passkey response is missing');
    row = take(challengeOf(credential), { purpose: `sign:${bind.purpose}`, userId: ctx.user.id, sessionId: ctx.session && ctx.session.id });
  } catch (e) { if (e instanceof W.WebAuthnError) refuse(e.code, e.message, { counts: false }); throw e; }
  const kept = row.statement || {};
  if (kept.record_type !== bind.record_type || W.canonical(kept.record_ids) !== W.canonical(bind.record_ids)) refuse('another record', 'That fingerprint confirmation was for a different record. Confirm again for this one.', { counts: false });
  if (kept.user_id !== ctx.user.id || kept.rp_id !== rp.rpId) refuse('statement', 'That fingerprint confirmation is not valid here.', { counts: false });
  // The statement completed with the content hashes of the record as it is now: it hashes to the challenge only when
  // the record has not changed since the challenge was issued (the challenge's id is the hash of that hash).
  const st = { ...kept, content: bind.content, ...(bind.items ? { items: bind.items } : {}) };
  if (sha256(W.statementChallenge(st)) !== row.id) refuse('record changed', 'The record changed after you confirmed. Check it and confirm again.', { counts: false });
  const pk = findByCredential(credential.id);
  if (!pk || pk.user_id !== ctx.user.id) refuse('unknown passkey', 'That passkey is not one of yours on SUDS.', { counts: false });
  let r;
  try { r = checkAssertion(ctx, credential, pk, rp, row.challengeHash); }
  catch (e) { if (e instanceof W.WebAuthnError) refuse(e.code, e.message, { counts: !['flagged', 'counter', 'rpid', 'not_allowed'].includes(e.code) }); throw e; }
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

/**
 * The enrolment record of a passkey, from the hash-chained audit log (auth.passkey.enrolled): { audit_id, at, user_id,
 * spki_sha256, credential_sha256 }, or null. It outlives the passkey (the audit log is kept), so evidence can still be
 * tied to the key accepted at enrolment once the passkey is removed.
 */
function enrolmentOf(passkeyId) {
  if (!passkeyId) return null;
  const a = db.one(`SELECT id, at, user_id, details FROM audit_log WHERE action='auth.passkey.enrolled' AND entity='passkey' AND entity_id=? ORDER BY id LIMIT 1`, passkeyId);
  if (!a) return null;
  let d = {}; try { d = JSON.parse(a.details || '{}'); } catch { d = {}; }
  if (!d.spki_sha256 || !d.credential_sha256) return null;
  return { audit_id: a.id, at: a.at, user_id: a.user_id, spki_sha256: d.spki_sha256, credential_sha256: d.credential_sha256 };
}
/**
 * The stored evidence for a record, each re-verified (server/webauthn.js verifyEvidence) against the enrolment
 * record of its passkey (the key in the evidence must be the one enrolled, by the signer). `purpose` narrows it.
 */
function evidenceFor(recordType, recordId, { purpose = null } = {}) {
  const rows = db.all(`SELECT * FROM signature_evidence WHERE record_type=? AND EXISTS (SELECT 1 FROM json_each(signature_evidence.record_ids) WHERE value=?) ${purpose ? 'AND purpose=?' : ''} ORDER BY created_at`,
    recordType, recordId, ...(purpose ? [purpose] : []));
  return rows.map((r) => {
    let ev = null; try { ev = JSON.parse(decrypt(r.evidence_enc)); } catch { ev = null; }
    const enrolment = ev ? enrolmentOf(ev.passkey_id) : null;
    const anchor = enrolment && enrolment.user_id === r.user_id ? enrolment : null;
    const check = ev ? W.verifyEvidence(ev, { anchor }) : { ok: false, reason: 'unreadable' };
    const signerOk = !!ev && !!ev.statement && ev.statement.user_id === r.user_id;
    const verified = check.ok && signerOk;
    return { id: r.id, purpose: r.purpose, user_id: r.user_id, created_at: r.created_at, statement_hash: r.statement_hash, evidence: ev, enrolment, verified, checks: check.checks,
      reason: verified ? null : !signerOk && check.ok ? 'signer' : check.reason };
  });
}
/**
 * A note's fingerprint evidence, checked against the note as it is now (GET /api/notes/:id/verify, step 5): the
 * evidence verifies, names this note, was given by `signerId`, and its statement's content is the note's plaintext
 * content hash now — directly for a signature or a countersignature, and for a countersignature given with others
 * (note.cosign-batch) as this note's entry in the statement's list, whose hash is the statement's content.
 * Returns { verified, at, reason } for the latest such evidence, or null when there is none.
 */
function noteEvidence(n, act, signerId) {
  const purposes = act === 'sign' ? ['note.sign'] : ['note.cosign', 'note.cosign-batch'];
  const all = purposes.flatMap(p => evidenceFor('note', n.id, { purpose: p })).filter(e => e.user_id === signerId).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const ev = all.pop();
  if (!ev) return null;
  const st = ev.evidence && ev.evidence.statement;
  const want = NS.contentHash(n, signerId, act);
  let content = false;
  if (st && st.record_ids.includes(n.id)) {
    if (ev.purpose === 'note.cosign-batch') content = Array.isArray(st.items) && listHash(st.items) === st.content && st.items.some(x => Array.isArray(x) && x[0] === n.id && x[1] === want);
    else content = st.content === want;
  }
  const verified = ev.verified && content;
  return { verified, at: ev.created_at, content_hash: want, reason: verified ? null : !ev.verified ? ev.reason : 'content' };
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

module.exports = { CHALLENGE_MS, MAX_PER_USER, MAX_OPEN_PER_IP, PURPOSES, relyingParty, configuredRpId, availability, issue, take, purge, list, remove, rename, registrationOptions, registrationFinish,
  loginOptions, loginFinish, bindingFor, signingOptions, confirm, evidenceFor, enrolmentOf, noteEvidence, adoption, userHandle, usable, usableCount, allowlist: L };
