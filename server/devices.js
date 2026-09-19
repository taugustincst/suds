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

module.exports = { touch, markWiped, labelFrom };
