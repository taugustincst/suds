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
  if (existing) db.run(`UPDATE devices SET user_id=?, last_seen_at=?, last_ip=?, sync_count=sync_count+1, label=COALESCE(label, ?) WHERE id=?`, user.id, now, ctx.ip, label, deviceId);
  else db.run(`INSERT INTO devices(id,user_id,label,first_seen_at,last_seen_at,last_ip,sync_count) VALUES(?,?,?,?,?,?,1)`, deviceId, user.id, label, now, now, ctx.ip);
  return db.one(`SELECT * FROM devices WHERE id=?`, deviceId);
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

module.exports = { touch, markWiped, requestWipeForUser, labelFrom, issueWipeToken, ackWipe };
