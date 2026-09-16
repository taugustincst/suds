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

// Verify chain integrity; returns {ok, checked, firstBadId}
function verifyChain() {
  const rows = db.all(`SELECT * FROM audit_log ORDER BY id ASC`);
  let prevHash = 'GENESIS';
  for (const r of rows) {
    const payload = [r.at, r.user_id || '', r.username || '', r.action, r.entity || '', r.entity_id || '', r.client_id || '', r.ip || '', r.success ? 1 : 0, r.details || '', r.prev_hash].join('|');
    if (r.prev_hash !== prevHash || sha256(payload) !== r.hash) return { ok: false, checked: rows.length, firstBadId: r.id };
    prevHash = r.hash;
  }
  return { ok: true, checked: rows.length };
}

module.exports = { log, verifyChain };
