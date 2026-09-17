'use strict';
// Tamper-evident audit log: every row carries a SHA-256 hash chained to the previous row.
const db = require('./db');
const { sha256 } = require('./crypto');

function log({ user, action, entity, entityId, clientId, ip, success = true, details }) {
  const prev = db.one(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`);
  const prevHash = prev ? prev.hash : 'GENESIS';
  const at = db.now();
  const detailsStr = details === undefined ? null : JSON.stringify(details);
  const payload = [at, user?.id || '', user?.username || '', action, entity || '', entityId || '', clientId || '', ip || '', success ? 1 : 0, detailsStr || '', prevHash].join('|');
  const hash = sha256(payload);
  db.run(`INSERT INTO audit_log(at,user_id,username,action,entity,entity_id,client_id,ip,success,details,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    at, user?.id || null, user?.username || null, action, entity || null, entityId || null, clientId || null, ip || null, success ? 1 : 0, detailsStr, prevHash, hash);
}

// Verify chain integrity; returns {ok, checked, firstBadId, anchoredAt}.
// The chain is anchored at the oldest surviving row (retention purges remove the oldest rows and record an
// 'audit.purge' entry whose details carry the hash the chain continues from).
// Read in batches: at seven years of retention this table is millions of rows, and loading it whole to
// answer an admin's "verify" click would stall the whole server.
const VERIFY_BATCH = 5000;
function verifyChain() {
  let prevHash = null; let anchoredAt = null; let checked = 0; let afterId = 0;
  for (;;) {
    const rows = db.all(`SELECT * FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?`, afterId, VERIFY_BATCH);
    if (!rows.length) break;
    if (prevHash === null) { prevHash = rows[0].prev_hash; anchoredAt = rows[0].id; }
    for (const r of rows) {
      const payload = [r.at, r.user_id || '', r.username || '', r.action, r.entity || '', r.entity_id || '', r.client_id || '', r.ip || '', r.success ? 1 : 0, r.details || '', r.prev_hash].join('|');
      checked++;
      if (r.prev_hash !== prevHash || sha256(payload) !== r.hash) return { ok: false, checked, firstBadId: r.id, anchoredAt };
      prevHash = r.hash;
    }
    afterId = rows[rows.length - 1].id;
    if (rows.length < VERIFY_BATCH) break;
  }
  if (!checked) return { ok: true, checked: 0 };
  return { ok: true, checked, anchoredAt };
}

// Tombstones tell devices what was deleted. They are kept long enough that any device still in use will
// have seen them, then dropped — and the horizon is recorded, so a device that has been away longer is
// sent for a full resync instead of silently keeping rows everyone else has dropped.
function purgeTombstones(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const n = db.run(`DELETE FROM tombstones WHERE deleted_at < ?`, cutoff).changes;
  if (n) {
    const prior = db.getSetting('tombstone_purged_before', null);
    if (!prior || prior < cutoff) db.setSetting('tombstone_purged_before', cutoff);
    log({ user: { username: 'system' }, action: 'tombstones.purge', details: { purged: n, before: cutoff } });
  }
  return n;
}

// Retention purge: deletes entries older than `days`, then records the purge so the gap is explained.
function purge(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const last = db.one(`SELECT id, hash FROM audit_log WHERE at < ? ORDER BY id DESC LIMIT 1`, cutoff);
  if (!last) return 0;
  const n = db.run(`DELETE FROM audit_log WHERE at < ?`, cutoff).changes;
  log({ user: { username: 'system' }, action: 'audit.purge', details: { purged: n, before: cutoff, last_purged_id: last.id, last_purged_hash: last.hash } });
  return n;
}

module.exports = { log, verifyChain, purge, purgeTombstones };
