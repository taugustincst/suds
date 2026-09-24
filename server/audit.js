'use strict';
// Tamper-evident audit log: every row carries a SHA-256 hash chained to the previous row.
const db = require('./db');
const config = require('./config');
const crypto = require('node:crypto');
const { sha256 } = require('./crypto');

// The chain was a plain SHA-256 over data that lives in the same database, so anyone who could edit a row
// could recompute every hash after it and leave no trace. New entries are keyed with HMAC against a key
// held outside the database, which an attacker with file access does not have. Rows written before this
// change still verify under the old scheme — the 'v2:' prefix says which is which, so an existing chain
// stays verifiable rather than being declared broken by an upgrade.
const KEYED_PREFIX = 'v2:';
function chainHash(payload, key = config.indexKey) { return KEYED_PREFIX + crypto.createHmac('sha256', key).update(payload).digest('hex'); }
function matches(stored, payload, key = config.indexKey) {
  if (typeof stored !== 'string') return false;
  const expected = stored.startsWith(KEYED_PREFIX) ? chainHash(payload, key) : sha256(payload);
  // Both sides are hex of the same length whenever the scheme matches, so a timing-safe compare is cheap.
  return stored.length === expected.length && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(expected));
}
const payloadOf = (r) => [r.at, r.user_id || '', r.username || '', r.action, r.entity || '', r.entity_id || '', r.client_id || '', r.ip || '', r.success ? 1 : 0, r.details || '', r.prev_hash].join('|');

function log({ user, action, entity, entityId, clientId, ip, success = true, details }) {
  const prev = db.one(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`);
  const prevHash = prev ? prev.hash : 'GENESIS';
  const at = db.now();
  const detailsStr = details === undefined ? null : JSON.stringify(details);
  const payload = [at, user?.id || '', user?.username || '', action, entity || '', entityId || '', clientId || '', ip || '', success ? 1 : 0, detailsStr || '', prevHash].join('|');
  const hash = chainHash(payload);
  db.run(`INSERT INTO audit_log(at,user_id,username,action,entity,entity_id,client_id,ip,success,details,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    at, user?.id || null, user?.username || null, action, entity || null, entityId || null, clientId || null, ip || null, success ? 1 : 0, detailsStr, prevHash, hash);
}

// ---- head checkpoint ----
// A hash chain proves nothing was changed *inside* it. It cannot tell that the newest rows were simply
// deleted, because the chain is still perfect up to whatever is now the last row. So the head is pinned:
// after every scheduled verification (and every purge) the id and hash of the newest row, and how many rows
// stand at or before it, are sealed with the index key, which lives outside the database. Anyone who
// truncates the table cannot re-seal a shorter chain, and the same line goes to the log file, which is
// collected off the box, so even deleting the setting leaves evidence.
function headPayload(lastId, lastHash, rowCount) { return `${lastId}|${lastHash}|${rowCount}`; }
function sealHead(lastId, lastHash, rowCount, key = config.indexKey) { return crypto.createHmac('sha256', key).update(headPayload(lastId, lastHash, rowCount)).digest('hex'); }
/** Seal the current head. `key` defaults to the index key in use; key rotation passes the new key explicitly. */
function checkpoint({ key = config.indexKey } = {}) {
  const last = db.one(`SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1`);
  if (!last) return null;
  const rowCount = db.one(`SELECT COUNT(*) n FROM audit_log WHERE id <= ?`, last.id).n;
  const head = sealHead(last.id, last.hash, rowCount, key);
  db.setSetting('audit_head', head);
  db.setSetting('audit_head_id', String(last.id));
  db.setSetting('audit_head_rows', String(rowCount));
  db.setSetting('audit_head_at', db.now());
  // Never PHI: two integers and an HMAC. Written at info level so it lands in the collected log file.
  console.log(`[suds] audit checkpoint id=${last.id} rows=${rowCount} head=${head}`);
  return { lastId: last.id, rowCount, head };
}
/** Compare the chain as it stands now with the last sealed head. */
function checkHead({ key = config.indexKey } = {}) {
  const head = db.getSetting('audit_head', null);
  const lastId = Number(db.getSetting('audit_head_id', 0));
  const rowCount = Number(db.getSetting('audit_head_rows', 0));
  if (!head || !lastId) return { checkpointed: false };
  const out = { checkpointed: true, checkpointId: lastId, checkpointAt: db.getSetting('audit_head_at', null) };
  const max = db.one(`SELECT MAX(id) m FROM audit_log`).m || 0;
  if (lastId > max) return { ...out, truncated: true, reason: `the newest ${lastId - max} entries since the checkpoint are gone` };
  const row = db.one(`SELECT hash FROM audit_log WHERE id=?`, lastId);
  const nowCount = row ? db.one(`SELECT COUNT(*) n FROM audit_log WHERE id <= ?`, lastId).n : 0;
  const expected = sealHead(lastId, row ? row.hash : '', nowCount, key);
  if (!row || expected.length !== head.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(head))) return { ...out, truncated: true, reason: row ? 'entries at or before the checkpoint were removed or altered' : 'the checkpointed entry itself is gone' };
  return { ...out, truncated: false };
}

// Verify chain integrity; returns {ok, checked, firstBadId, anchoredAt, truncated, ...}.
// The chain is anchored at the oldest surviving row (retention purges remove the oldest rows and record an
// 'audit.purge' entry whose details carry the hash the chain continues from).
// Read in batches: at seven years of retention this table is millions of rows, and loading it whole to
// answer an admin's "verify" click would stall the whole server.
const VERIFY_BATCH = 5000;
/**
 * The walk itself, as a generator that yields after every batch: verifyChain runs it straight through,
 * verifyChainAsync gives the event loop a turn at each yield. `afterId`/`prevHash` start the walk part-way
 * along the chain (an incremental check from the last verified entry); the default is the whole chain.
 */
function* walk({ key, afterId = 0, prevHash = null, batch = VERIFY_BATCH }) {
  let anchoredAt = null; let checked = 0;
  for (;;) {
    const rows = db.all(`SELECT * FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?`, afterId, batch);
    if (!rows.length) break;
    if (prevHash === null) prevHash = rows[0].prev_hash;
    if (anchoredAt === null) anchoredAt = rows[0].id;
    for (const r of rows) {
      checked++;
      if (r.prev_hash !== prevHash || !matches(r.hash, payloadOf(r), key)) return { ok: false, checked, firstBadId: r.id, anchoredAt };
      prevHash = r.hash;
    }
    afterId = rows[rows.length - 1].id;
    if (rows.length < batch) break;
    yield;
  }
  return { ok: true, checked, anchoredAt, lastId: afterId || null, lastHash: prevHash };
}
function verdict(res, { key, skipHead }) {
  const { lastHash, ...out } = res;
  if (!out.ok) return { ...out, ...(skipHead ? {} : checkHead({ key })) };
  const head = skipHead ? { checkpointed: false } : checkHead({ key });
  if (head.truncated) return { ...out, ok: false, ...head };
  if (!out.checked) return { ok: true, checked: 0, ...head, lastId: out.lastId };
  return { ...out, ...head };
}
// `skipHead` leaves the sealed head out of the verdict: key rotation re-signs the rows under the new key
// before the head is re-sealed, so between those two steps the head (sealed under the old key) would
// read as "truncated" although nothing is missing.
/** The whole chain, synchronously — for the CLI, key rotation and tests. The server uses verifyChainAsync. */
function verifyChain({ key = config.indexKey, skipHead = false, batch } = {}) {
  const it = walk({ key, batch });
  let step = it.next();
  while (!step.done) step = it.next();
  return verdict(step.value, { key, skipHead });
}

// The event loop turn between batches. The local-mode kernel runs in a browser, which has no setImmediate.
const defer = globalThis.setImmediate ? (f) => setImmediate(f) : (f) => setTimeout(f, 0);
const breathe = () => new Promise((resolve) => defer(resolve));

// ---- incremental verification ----
// The daily check used to walk every row synchronously — nine seconds with the server frozen at a million
// rows. It now resumes from the last entry it verified: that entry's id and hash, sealed with the index key
// (like the head checkpoint) so the marker cannot be moved forward by someone editing settings. A row
// altered *before* the marker is not re-read by an incremental check; it is caught by the full walk, which
// still runs weekly (FULL_EVERY_DAYS), on the Verify button, and whenever the marker is missing or does
// not check out.
const FULL_EVERY_DAYS = 7;
function sealVerified(id, hash, key = config.indexKey) { return crypto.createHmac('sha256', key).update(`verified|${id}|${hash}`).digest('hex'); }
function setVerifiedMarker(id, hash) {
  if (!id) return;
  db.setSetting('audit_verified_id', String(id));
  db.setSetting('audit_verified_seal', sealVerified(id, hash));
}
function clearVerifiedMarker() { db.run(`DELETE FROM settings WHERE key IN ('audit_verified_id','audit_verified_seal')`); }
/** Where an incremental check can resume, or null when only a full walk will do. */
function verifiedMarker({ key = config.indexKey } = {}) {
  const id = Number(db.getSetting('audit_verified_id', 0)); const seal = db.getSetting('audit_verified_seal', null);
  if (!id || !seal) return null;
  const row = db.one(`SELECT id, hash FROM audit_log WHERE id=?`, id);
  if (!row) return null;
  const expected = sealVerified(row.id, row.hash, key);
  if (expected.length !== seal.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(seal))) return null;
  return { id: row.id, hash: row.hash };
}

/**
 * Verify without holding the event loop: `batch` rows at a time with a yield in between. With
 * `incremental`, resume from the sealed last-verified marker when there is one (falling back to the whole
 * chain when there is not). Resolves to the same shape as verifyChain, plus `mode` ('full'|'incremental')
 * and, for an incremental check, `from` (the id it resumed after).
 */
async function verifyChainAsync({ key = config.indexKey, skipHead = false, incremental = false, batch } = {}) {
  const marker = incremental ? verifiedMarker({ key }) : null;
  const it = walk({ key, batch, ...(marker ? { afterId: marker.id, prevHash: marker.hash } : {}) });
  let step = it.next();
  while (!step.done) { await breathe(); step = it.next(); }
  const res = verdict(step.value, { key, skipHead });
  if (res.ok) {
    const last = step.value.lastId ? { id: step.value.lastId, hash: step.value.lastHash } : marker;
    if (last) setVerifiedMarker(last.id, last.hash);
  }
  return { ...res, mode: marker ? 'incremental' : 'full', ...(marker ? { from: marker.id } : {}) };
}

/**
 * Re-key the chain: every keyed ('v2:') row's hash is recomputed under `newKey`, in id order, with each
 * row's prev_hash rewritten to the re-signed hash before it so continuity is preserved. Rows from before
 * keyed hashing (plain SHA-256) are left as they are; they never depended on a key.
 *
 * This is the one place other than the retention purge that writes to existing audit rows, and it exists
 * only because the chain key is SUDS_INDEX_KEY: without it, rotating that key would turn every entry
 * into a "tampered" one. Called by scripts/rotate-index-key.js with the server stopped, inside its own
 * transaction, and only after the chain has verified under the old key — a chain that already fails is
 * evidence and is not touched.
 */
function resignChain(newKey) {
  const before = verifyChain();
  if (!before.ok) throw new Error(`The audit chain does not verify under the current key (first bad entry ${before.firstBadId}); it will not be re-signed`);
  const upd = db.get().prepare(`UPDATE audit_log SET prev_hash=?, hash=? WHERE id=?`);
  let prevHash = null; let afterId = 0; let resigned = 0;
  for (;;) {
    const rows = db.all(`SELECT * FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?`, afterId, VERIFY_BATCH);
    if (!rows.length) break;
    if (prevHash === null) prevHash = rows[0].prev_hash;   // the anchor (GENESIS, or the hash a purge continued from) is kept
    for (const r of rows) {
      const row = { ...r, prev_hash: prevHash };
      // A legacy row normally follows legacy rows, so its hash stands; one that somehow follows a keyed row
      // is recomputed under its own (unkeyed) scheme so it still verifies with its new prev_hash.
      const hash = String(r.hash).startsWith(KEYED_PREFIX) ? chainHash(payloadOf(row), newKey) : (prevHash === r.prev_hash ? r.hash : sha256(payloadOf(row)));
      if (hash !== r.hash || prevHash !== r.prev_hash) { upd.run(prevHash, hash, r.id); resigned++; }
      prevHash = hash;
    }
    afterId = rows[rows.length - 1].id;
    if (rows.length < VERIFY_BATCH) break;
  }
  // The sealed head still carries the old key's HMAC, so the rows are verified without it and then the
  // head is re-sealed under the new key in the same transaction — a rotation must leave the chain both
  // verifiable and pinned, or the next scheduled verification reports truncation that never happened.
  const after = verifyChain({ key: newKey, skipHead: true });
  if (!after.ok) throw new Error(`The audit chain does not verify under the new key after re-signing (first bad entry ${after.firstBadId})`);
  const hadHead = db.getSetting('audit_head', null);
  if (hadHead) checkpoint({ key: newKey });
  // Every hash changed, and the verified marker was sealed under the old key: the next check walks it all.
  clearVerifiedMarker();
  const pinned = verifyChain({ key: newKey });
  if (!pinned.ok) throw new Error(`The audit head does not verify under the new key after re-sealing (${pinned.reason || `first bad entry ${pinned.firstBadId}`})`);
  return { resigned, checked: after.checked };
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
  // The purge legitimately changed the row count behind the sealed head; re-seal it or the next
  // verification would read the purge as truncation.
  checkpoint();
  return n;
}

/**
 * Verify the chain on a schedule and record the result. "Tamper-evident" means nothing if nobody ever
 * looks: this was only ever checked when an administrator happened to click the button. Incremental
 * (from the last verified entry) on most days, the whole chain once every FULL_EVERY_DAYS or when asked
 * (`full`), and in both cases in batches that let other requests run in between. Returns a promise.
 */
async function scheduledVerify({ full = false, batch } = {}) {
  const lastFull = db.getSetting('audit_full_verified_at', null);
  const fullDue = full || !lastFull || Date.now() - Date.parse(lastFull) > FULL_EVERY_DAYS * 86400000;
  const r = await verifyChainAsync({ incremental: !fullDue, batch });
  if (r.ok) {
    db.setSetting('audit_verified_at', db.now());
    if (r.mode === 'full') db.setSetting('audit_full_verified_at', db.now());
    checkpoint(); return r;
  }
  // Recorded rather than thrown: the entry itself is evidence, and the server must keep serving.
  console.error(`[suds] AUDIT CHAIN BROKEN ${r.truncated ? `(truncated: ${r.reason})` : `at entry ${r.firstBadId}`} — investigate immediately`);
  log({ user: { username: 'system' }, action: 'audit.verify.failed', success: false, details: { first_bad_id: r.firstBadId, checked: r.checked, truncated: r.truncated || undefined, reason: r.reason, mode: r.mode } });
  db.setSetting('audit_verify_failed_at', db.now());
  return r;
}

module.exports = { log, verifyChain, verifyChainAsync, verifiedMarker, resignChain, scheduledVerify, purge, purgeTombstones, checkpoint, checkHead };
