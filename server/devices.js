'use strict';
// Local-mode device tracking: one row per physical phone/tablet, identified by a UUID the device generates
// once (local/sync.js) and sends on every sync call. Never keyed by the sync session itself — that is
// created fresh and destroyed at the end of every single sync run (see local/sync.js's finally block).
const db = require('./db');
const { sha256, randomToken } = require('./crypto');

function labelFrom(userAgent) {
  const ua = userAgent || '';
  if (/android/i.test(ua)) return 'Android phone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/iphone/i.test(ua)) return 'iPhone';
  return 'Device';
}

/**
 * Record a device's attempt to sync, creating it on first sight. If the same device id later syncs as a
 * different user (the phone was reassigned), it is simply reattributed to whoever holds it now — this
 * tracks "who currently has this device", not a full history of every account it has ever synced as.
 */
function touch(user, deviceId, ctx) {
  const existing = db.one(`SELECT * FROM devices WHERE id=?`, deviceId);
  const label = labelFrom(ctx.headers['user-agent']);
  const now = db.now();
  if (existing) {
    db.run(`UPDATE devices SET user_id=?, last_seen_at=?, last_ip=?, sync_count=sync_count+1, label=COALESCE(label, ?) WHERE id=?`, user.id, now, ctx.ip, label, deviceId);
    // An administrator's "Hold everything" was a decision about this device in its user's hands (1.22.0). Signed in
    // as someone else, it no longer stands: the device is judged again for the person who holds it now (bind).
    if (existing.user_id !== user.id && adminFull(existing)) {
      db.run(`UPDATE devices SET scope_set_by=NULL WHERE id=?`, deviceId);
      require('./audit').log({ user, action: 'device.scope', entity: 'device', entityId: deviceId, ip: ctx.ip, details: { from: 'full', to: 'full', via: 'reattributed', admin_decision_cleared: true, previous_user: existing.user_id, device_user: user.id } });
    }
  } else {
    // A new device starts in the field scope when the programme's default says so (field_device_default, off unless
    // an administrator turned it on), or when its user's account is held to the field scope (bind, below; 1.22.0).
    const scope = db.getSetting('field_device_default', '0') === '1' ? 'field' : 'full';
    db.run(`INSERT INTO devices(id,user_id,label,first_seen_at,last_seen_at,last_ip,sync_count,sync_scope,scope_changed_at,scope_set_by) VALUES(?,?,?,?,?,?,1,?,?,'default')`, deviceId, user.id, label, now, now, ctx.ip, scope, scope === 'field' ? now : null);
  }
  const out = bind(user, db.one(`SELECT * FROM devices WHERE id=?`, deviceId), { ip: ctx.ip });
  // A device first seen now has recorded nothing under another scope, so a field device is held to the field scope
  // from its first push, not only after its first pull (field_applied_at; 1.22.0 integration review).
  if (!existing && out && out.sync_scope === 'field' && !out.field_applied_at) {
    db.run(`UPDATE devices SET field_applied_at=? WHERE id=?`, now, deviceId);
    return db.one(`SELECT * FROM devices WHERE id=?`, deviceId);
  }
  return out;
}

// ---- sync scope (released in 1.21.0; server/field-scope.js) ----
const SCOPES = ['full', 'field'];

// ---- the account's scope (built for 1.22.0, not yet released) ----
// The field scope follows the account as well as the device. A device id is the device's own word (local/sync.js
// makes one up once and sends it), so a scope kept only on the device's row could be left by sending another id, or
// none, or by enrolling again. So: once any device of an account has been a field device, or while the programme's
// default (field_device_default) is on, every sync of that account is in the field scope (field_accounts): on a new
// device id, on a device the office has never seen, and on a session that names no device at all (a device's sync
// sign-in without one is refused, server/auth.js login). The only way back to everything is an administrator marking
// one specific device "Hold everything" (scope_set_by 'admin'), and that decision is cleared if the device signs in as
// someone else. Neither the device nor its user can widen it. Revoking or wiping a device does not release its
// account: an administrator's password reset wipes every device, and the next enrolment must not come back whole.
/** Whether this account's syncs are held to the field scope (the programme's default, or field_accounts). */
function accountFieldBound(userId) {
  if (db.getSetting('field_device_default', '0') === '1') return true;
  return !!db.one(`SELECT 1 FROM field_accounts WHERE user_id=?`, userId);
}
/** Hold an account to the field scope from now on (idempotent; audited the first time). */
function bindAccount(userId, via, { actor, ip } = {}) {
  const r = db.run(`INSERT OR IGNORE INTO field_accounts(user_id, bound_at, bound_via) VALUES(?,?,?)`, userId, db.now(), via);
  if (r && r.changes) require('./audit').log({ user: actor || { id: userId }, action: 'device.account_field', entity: 'user', entityId: userId, ip, details: { via } });
}
/** An administrator decided this device holds everything (and it has not changed hands since). */
function adminFull(d) { return !!d && d.sync_scope === 'full' && d.scope_set_by === 'admin'; }
/** Whether a sync of `userId` from `device` (a devices row, or null for a session that names none) is in the field scope. */
function effectiveField(userId, device) {
  if (device && device.sync_scope === 'field') return true;
  if (adminFull(device)) return false;
  return accountFieldBound(userId);
}
/**
 * Bring a device's recorded scope into line with its account: a field device holds its account to the field scope,
 * and a device of such an account that an administrator has not marked "Hold everything" becomes a field device
 * (setScope via 'account', audited; it sends what it has first and then narrows, local/sync.js). Called as the
 * device signs in and on every sync request. Returns the device row as it now is.
 */
function bind(user, device, { ip } = {}) {
  if (!device || device.revoked_at) return device;
  if (device.sync_scope === 'field') { bindAccount(user.id, 'device', { actor: user, ip }); return device; }
  if (effectiveField(user.id, device)) return setScope(device.id, 'field', { actor: user, ip, via: 'account' }) || device;
  return device;
}

/**
 * Change what a device's sync carries. `via`: 'admin' (Settings -> Synced devices), 'enrolment' (its own user, who
 * may only narrow it to 'field': widening what a phone holds is an administrator's decision) or 'account' (the
 * office, because the device's account is held to the field scope; bind). A device made 'field' holds its account to
 * the field scope (field_accounts, 1.22.0). An administrator's 'full' is recorded as theirs (scope_set_by 'admin'),
 * which is what keeps one device whole for such an account; asked of a device already 'full' only by default, it
 * records just that decision. A change to 'field' reaches the device at its next sync: it sends what it has not sent
 * yet, then removes what is out of scope (local/sync.js). Until the office has answered a pull under the field
 * scope, field_applied_at stays empty and the device's pushes are judged as before, so nothing recorded under the old
 * scope is refused on the way in. Audited. Returns the device row, or null when nothing changed.
 */
function setScope(deviceId, scope, { actor, ip, via = 'admin' } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`setScope: unknown scope ${scope}`);
  if (!['admin', 'enrolment', 'account'].includes(via)) throw new Error(`setScope: unknown route ${via}`);
  const d = db.one(`SELECT * FROM devices WHERE id=?`, deviceId);
  if (!d) return null;
  if (via !== 'admin' && scope !== 'field') throw new Error('Only an administrator can widen what a device holds');
  if (d.sync_scope === scope) {
    if (!(via === 'admin' && scope === 'full' && d.scope_set_by !== 'admin')) return null;
    db.run(`UPDATE devices SET scope_set_by='admin' WHERE id=?`, deviceId);
  } else db.run(`UPDATE devices SET sync_scope=?, scope_changed_at=?, scope_set_by=? WHERE id=?`, scope, db.now(), via, deviceId);
  require('./audit').log({ user: actor, action: 'device.scope', entity: 'device', entityId: deviceId, ip, details: { from: d.sync_scope, to: scope, via, device_user: d.user_id } });
  if (scope === 'field') bindAccount(d.user_id, via, { actor, ip });
  return db.one(`SELECT * FROM devices WHERE id=?`, deviceId);
}
/** The device a request's session was signed in from (sessions.device_id), or null for a browser's session. */
function ofSession(ctx) {
  const id = ctx && ctx.session && ctx.session.device_id;
  return id ? db.one(`SELECT * FROM devices WHERE id=?`, id) : null;
}

/**
 * The wipe was delivered to the device and it has erased itself (or its holder has just signed in on it,
 * which is the same proof that the wipe reached the right phone) — revoke it so it cannot sync again
 * unless an administrator clears it. `wipe_requested_at` is kept: a revoked device that was once told to
 * wipe is still told to wipe if it ever shows up again (auth.js login()), because the erase may not have
 * completed the first time.
 */
function markWiped(deviceId) {
  db.run(`UPDATE devices SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?`, db.now(), deviceId);
  db.run(`DELETE FROM settings WHERE key=?`, ackKey(deviceId));
}

// ---- wipe acknowledgement ----
// A wipe instruction is answered to any request that carries a known device id, before credentials are
// checked (see auth.js for why). That must not be what *consumes* the wipe: anyone who learned a device id
// could otherwise make the server believe the phone had been erased. So the pending wipe is cleared only
// when the device proves it received it — either by signing in with working credentials, or by posting
// back a one-time token that only the wipe response carried. The token's hash lives in the settings table
// (no schema change) with a short life; the device id alone never suffices.
const ACK_TTL_MS = 15 * 60_000;
const ackKey = (deviceId) => `device_wipe_ack:${deviceId}`;
/** Mint the one-time token the deviceWipeRequired response carries. Re-issued on every delivery; the newest wins. */
function issueWipeToken(deviceId) {
  const token = randomToken(32);
  db.setSetting(ackKey(deviceId), JSON.stringify({ hash: sha256(token), expires: new Date(Date.now() + ACK_TTL_MS).toISOString() }));
  return token;
}
/** True (and the device marked wiped) when `token` is the live acknowledgement token for this device. */
function ackWipe(deviceId, token) {
  const raw = db.getSetting(ackKey(deviceId), null);
  if (!raw || typeof token !== 'string' || !token) return false;
  let rec; try { rec = JSON.parse(raw); } catch { return false; }
  if (!rec.hash || Date.parse(rec.expires || 0) < Date.now()) { db.run(`DELETE FROM settings WHERE key=?`, ackKey(deviceId)); return false; }
  const given = sha256(token);
  if (given.length !== rec.hash.length || !require('node:crypto').timingSafeEqual(Buffer.from(given), Buffer.from(rec.hash))) return false;
  markWiped(deviceId);
  return true;
}

/**
 * Ask every device this person still syncs from to erase itself at its next sync. Called when an account
 * is deactivated or its password is reset by an administrator: both mean "this person should no longer
 * hold client records", and a phone full of them that nobody thought to wipe separately was the gap.
 * A device already revoked (which is what a delivered wipe leaves behind) is left alone. Returns the
 * device ids affected; audited by the caller's action so the reason is on record.
 */
function requestWipeForUser(userId, { actor, ip, reason } = {}) {
  const rows = db.all(`SELECT id FROM devices WHERE user_id=? AND revoked_at IS NULL AND wipe_requested_at IS NULL`, userId);
  if (!rows.length) return [];
  const now = db.now();
  for (const d of rows) db.run(`UPDATE devices SET wipe_requested_at=? WHERE id=?`, now, d.id);
  require('./audit').log({ user: actor, action: 'device.wipe.requested', entity: 'user', entityId: userId, ip, details: { reason, devices: rows.map(d => d.id) } });
  return rows.map(d => d.id);
}

module.exports = { touch, markWiped, requestWipeForUser, labelFrom, issueWipeToken, ackWipe, setScope, ofSession, SCOPES, accountFieldBound, bindAccount, adminFull, effectiveField, bind };
