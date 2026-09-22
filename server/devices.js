'use strict';
// Local-mode device tracking: one row per physical phone/tablet, identified by a UUID the device generates
// once (local/sync.js) and sends on every sync call. Never keyed by the sync session itself — that is
// created fresh and destroyed at the end of every single sync run (see local/sync.js's finally block).
const db = require('./db');

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

/** The wipe was just delivered to the device (it is about to erase itself) — revoke it so it cannot sync again unless an administrator clears it. */
function markWiped(deviceId) { db.run(`UPDATE devices SET revoked_at=?, wipe_requested_at=NULL WHERE id=?`, db.now(), deviceId); }

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

module.exports = { touch, markWiped, requestWipeForUser, labelFrom };
