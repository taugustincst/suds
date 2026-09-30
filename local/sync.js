// Device-side sync runner (bundled into the local kernel). Talks to the office server's /api/sync routes.
//
// Three things this file has to get right:
//  * A row the server sent us must not be pushed back with a device timestamp. sync_seen records each row
//    exactly as it was last exchanged; a row that still matches it was never touched here, so the server's
//    copy always wins and no clock arithmetic is involved. Only genuinely local edits are compared in
//    server time.
//  * A payload must fit. Rows go up in chunks under a byte budget, and attachments travel separately, so a
//    phone with a few scans on it cannot end up permanently unable to sync.
//  * Nothing is marked as sent until the server says it took it — including tombstones and audit rows.
import db from '../server/db.js';
import auth from '../server/auth.js';
import audit from '../server/audit.js';
import { HttpError } from '../server/http.js';
import { encrypt, decrypt, blindIndex, uuid } from '../server/crypto.js';
import SYNC from '../server/sync-tables.js';
import FIELD from '../server/field-scope.js';
import SUPPLIES from '../server/supplies.js';
import NOTE_RULES from '../server/rules/notes.js';
import TASK_RULES from '../server/rules/tasks.js';
import { wipe as wipeLocalDb } from './shims/sqlite.js';

// A stable identity for this physical device, generated once and kept in its own local settings — separate
// from the sync session, which is created and destroyed within a single sync run (see the `finally` block
// in run() below) and so cannot itself identify "this phone" from one sync to the next. Lets the office
// server recognise a returning device (Administration -> Users -> Devices) well enough to revoke or
// remotely wipe it if it is lost or stolen.
function deviceId() {
  let id = db.getSetting('device_id', null);
  if (!id) { id = uuid(); db.setSetting('device_id', id); }
  return id;
}

const NEVER = '1970-01-01T00:00:00.000Z';
// Marks a pull cursor that carries the office's backfill position (server/routes/sync.js BF_MARK).
const BACKFILL_MARK = '~bf.';
// A safety stop, not a limit anyone should reach: 2,000 pages of at most 2,000 rows.
const MAX_BACKFILL_PAGES = 2000;
// Well under the server's body limit, leaving room for JSON overhead.
const PUSH_BYTES = 4 * 1024 * 1024;
// Attachments fetched per sync, so a first sync is not held up by every photo in the directory.
const BLOBS_PER_SYNC = 25;

// The dummy hash the office sends in place of every other user's real one (server/routes/sync.js pull).
const DUMMY_HASH = 'scrypt$0$0$0$AA==$AA==';

export function ensureTables() {
  db.get().exec(`CREATE TABLE IF NOT EXISTS sync_seen (table_name TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (table_name, id))`);
  // Tombstones the office sent us. They are recorded in the local tombstones table like any other delete so
  // the cascade works, but they are the office's deletions, not ours, and must never be echoed back.
  db.get().exec(`CREATE TABLE IF NOT EXISTS sync_server_tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (table_name, id))`);
  loadNotices();
}
// The change notices the office named in its pulls (server/routes/sync.js exportInto `notices`), with whose edit each
// reports: the device shows them as the office does, a read-only card only the worker told may mark seen (UX review
// of 1.16.3, M1). Kept in this device's settings; only the office's word makes one, never a to-do's text.
const NOTICES = 'office_notices';
function loadNotices() {
  TASK_RULES.noticeIds.clear();
  let m = {}; try { m = JSON.parse(db.getSetting(NOTICES, '{}')) || {}; } catch { m = {}; }
  for (const [id, by] of Object.entries(m)) TASK_RULES.noticeIds.set(id, typeof by === 'string' ? by : null);
}
function keepNotices(list) {
  if (!Array.isArray(list)) return;
  const ids = TASK_RULES.noticeIds;
  for (const x of list) { const [id, by] = Array.isArray(x) ? x : []; if (typeof id === 'string') ids.set(id, typeof by === 'string' ? by : null); }
  for (const id of [...ids.keys()]) if (!db.one(`SELECT 1 FROM tasks WHERE id=?`, id)) ids.delete(id);
  db.setSetting(NOTICES, JSON.stringify(Object.fromEntries(ids)));
}
/** The pull cursor is per office account: on a shared phone the second person to sync must get their own
 *  caseload from the beginning, not only what changed since a colleague's last sync. */
export const cursorKey = (userId) => `sync_cursor:${userId}`;
const scopeSettingKey = (userId) => `sync_scope:${userId}`;
export function readCursor(userId, username) {
  const own = db.getSetting(cursorKey(userId), null);
  if (own) return own;
  // One-time adoption of the pre-1.7 device-wide cursor, but only by the account that was syncing then.
  const legacy = db.getSetting('sync_cursor', null);
  if (legacy && db.getSetting('sync_username', null) === username) return legacy;
  return NEVER;
}
const seen = (t, id, at) => db.run(`INSERT OR REPLACE INTO sync_seen(table_name,id,updated_at) VALUES(?,?,?)`, t, id, at || null);
const seenAt = (t, id) => db.one(`SELECT updated_at FROM sync_seen WHERE table_name=? AND id=?`, t, id)?.updated_at ?? undefined;
const cols = (t) => db.all(`PRAGMA table_info(${t})`).map(c => c.name);
const stamp = (row) => row.updated_at || row.created_at || null;

// Row marshalling lives in server/sync-tables.js: the two copies this replaces had already drifted.
const { exportRow, importRow } = SYNC;

// Every column that points at users(id), shared with the server so the two lists cannot drift apart.
function mergeUser(localId, serverId) {
  for (const [t, c] of SYNC.user_refs) {
    if (!db.one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t)) continue;
    if (!cols(t).includes(c)) continue;
    const remap = () => db.run(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`, serverId, localId);
    // The device's own audit log is append-only (schema.sql triggers); renaming its local account to the
    // office one is the sanctioned maintenance that may touch it.
    if (t === 'audit_log') audit.maintenance('sync: the device account becomes its office account', remap); else remap();
  }
  db.run(`DELETE FROM users WHERE id=?`, localId);
  // The device's own administrator (local/kernel.js) is the same person under their office id now.
  if (db.getSetting('device_admin_user_id', null) === localId) db.setSetting('device_admin_user_id', serverId);
}

/**
 * Apply server rows locally.
 *  - untouched since the last exchange (matches sync_seen) → the server's copy wins, no clock involved
 *  - edited here since then → keep ours only if our edit is newer once converted to server time
 */
// Same reasoning as the server's copy of this (server/routes/sync.js): a row referencing its own parent
// within the same table (a nested budget line) needs that parent inserted first, and nothing else orders
// a single table's batch — the office can send a whole hierarchy created since the last sync in one go.
function selfParentOrder(rows, col) {
  const ids = new Set(rows.map(r => r && r.id));
  const placed = new Set(); const out = []; let remaining = rows;
  while (remaining.length) {
    const ready = [], waiting = [];
    for (const r of remaining) (!r || !r[col] || !ids.has(r[col]) || placed.has(r[col]) ? ready : waiting).push(r);
    if (!ready.length) { out.push(...waiting); break; } // a cycle within the batch — let the FK constraint reject it
    for (const r of ready) { out.push(r); if (r && r.id) placed.add(r.id); }
    remaining = waiting;
  }
  return out;
}

// Columns the office row would change here, by name; encrypted columns compared as plaintext, blind
// indexes skipped. Mirrors server/routes/sync.js.
function changedColumns(t, existing, raw, existingCols) {
  const out = [];
  for (const k of existingCols) {
    if (['id', 'updated_at', 'created_at'].includes(k) || k.endsWith('_idx') || raw[k] === undefined) continue;
    let was = existing[k];
    if (t.enc.includes(k) && was) { try { was = decrypt(was); } catch { was = null; } }
    if (String(was ?? '') !== String(raw[k] ?? '')) out.push(k);
  }
  return out;
}

// ---- supplies: a visit's draw-down on this device is provisional ----
// The office works out a visit's draw-down from the visit, against its own stock (server/supplies.js). This
// device draws its own copy down too, so the stock shown offline is right; those rows are never pushed, and
// when the office's draw-down for a visit arrives, this device's own rows for it are dropped and the visit is
// weighed again against the office's rows (a no-op unless the visit was edited here since it was sent).
const PROVISIONAL = `(intervention_id IS NOT NULL OR kind IN ('distributed','restored') OR COALESCE(reason,'')='shortfall')`;
const notExchanged = `NOT EXISTS (SELECT 1 FROM sync_seen s WHERE s.table_name='supply_ledger' AND s.id=supply_ledger.id)`;
function dropProvisional(visitId) {
  db.run(`DELETE FROM supply_ledger WHERE intervention_id=? AND ${notExchanged}`, visitId);
}
function settleSupplies(payload, officeUserId, skipped) {
  const visits = new Set(((payload.tables || {}).supply_ledger || []).filter(r => r && typeof r.intervention_id === 'string').map(r => r.intervention_id));
  const actor = { id: officeUserId, username: db.getSetting('sync_username', 'device') };
  for (const v of visits) {
    db.savepoint(() => {
      dropProvisional(v);
      if (db.one(`SELECT 1 FROM interventions WHERE id=?`, v)) SUPPLIES.reconcileVisit(v, actor, { ip: 'device' });
    }, (err) => skipped.push({ table: 'supply_ledger', id: v, reason: String(err && err.message || 'could not be settled').slice(0, 200) }));
  }
}

function applyPull(payload, conflicts = [], skipped = [], officeUserId = null) {
  const counts = {};
  const offset = payload.server_now ? Date.parse(payload.server_now) - Date.now() : 0;
  const toServer = (ts) => { const t = Date.parse(ts || NEVER); return Number.isFinite(t) ? new Date(t + offset).toISOString() : NEVER; };
  db.setSetting('sync_clock_offset_ms', String(offset));
  db.transaction(() => {
    for (const t of SYNC.tables) {
      let rows = payload.tables?.[t.name] || []; if (t.selfParent) rows = selfParentOrder(rows, t.selfParent); const existingCols = cols(t.name); let n = 0;
      for (const raw of rows) {
        if (!raw || typeof raw.id !== 'string') continue;
        // One row the device cannot store (a constraint this build does not expect, a reference it lacks) is
        // that row's problem. Without a savepoint it failed the whole pull, every sync, forever.
        const stored = db.savepoint(() => applyRow(t, raw, existingCols, toServer, conflicts), (err) => {
          const reason = String(err && err.message || 'could not be stored').slice(0, 200);
          skipped.push({ table: t.name, id: raw.id, reason });
          audit.log({ user: { username: db.getSetting('sync_username', 'device') }, action: 'sync.row_skipped', entity: t.name, entityId: raw.id, success: false, details: { reason } });
        });
        if (stored) n++;
      }
      counts[t.name] = (counts[t.name] || 0) + n;
    }
    for (const ts of payload.tombstones || []) {
      const t = SYNC.tables.find(x => x.name === ts.table_name); if (!t) continue;
      db.savepoint(() => applyTombstone(t, ts, toServer), (err) => skipped.push({ table: t.name, id: ts.id, reason: String(err && err.message || 'could not be deleted').slice(0, 200) }));
    }
    // The office took these clients off this person's caseload. The phone must not stay the place their
    // record lives on -- unless another account on this shared device still has them on its caseload.
    for (const id of payload.dropped_clients || []) {
      if (typeof id !== 'string') continue;
      if (!db.one(`SELECT 1 FROM clients WHERE id=?`, id)) continue; // a field device is told of every client it may not hold
      // A client with changes made here that the office has not had stays until they are sent (a field device pushes
      // before it narrows, local/sync.js run; this is the rest: a visit recorded here since).
      if (hasUnsent(id)) { skipped.push({ table: 'clients', id, reason: 'kept on this device: it has changes not yet sent to the office' }); continue; }
      if (officeUserId && db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id<>? AND ${auth.activeAssignment()}`, id, officeUserId)) continue;
      db.savepoint(() => {
        const removed = SYNC.purgeClient(db, id);
        if (removed) audit.log({ user: { username: db.getSetting('sync_username', 'device') }, action: 'sync.caseload_removed', entity: 'client', entityId: id, clientId: id, details: { rows: removed } });
      }, (err) => skipped.push({ table: 'clients', id, reason: String(err && err.message || 'could not be removed').slice(0, 200) }));
    }
    // Other records the office says this person may no longer read (their access narrowed: a clinical note
    // once clinical notes were denied, another worker's call with no client once clients:all was, a table
    // whose permission went). Removed like a dropped client: not a deletion, never echoed back.
    // Kept, as a dropped client is, while another account on this shared device may still read it; and never with
    // changes made here that the office has not had (security review of 1.16.2, M2: a navigator's sync deleted a
    // clinician's unsynced edit to a counseling note).
    // A note the office names with what now makes it a SUD counseling note (security review of 1.16.3, N1) is marked
    // so here first, without counting as an edit made here (updated_at and sync_seen untouched): whether another
    // account on this device may still read it is judged against the note as it now is, never the pre-flag copy any
    // navigator may read, and a note kept for one who may (a clinician, its author or co-signer) is hidden from
    // everyone else here by the same rule. Another account's permissions are those this device holds for it: its
    // role and active state as the last sync by anyone brought them, and its own grants and denies as of its own
    // last sync here (so a counseling permission taken from it at the office counts here only once it syncs again).
    const onDevice = (u) => (typeof u === 'string' && db.one(`SELECT 1 FROM users WHERE id=?`, u) ? u : null);
    for (const pair of payload.dropped_rows || []) {
      const [table, id, g] = Array.isArray(pair) ? pair : [];
      if (table !== 'notes' || typeof id !== 'string' || !g || typeof g !== 'object' || Number(g.counseling_note) !== 1) continue;
      db.run(`UPDATE notes SET counseling_note=1, author_id=COALESCE(?, author_id), cosigned_by=COALESCE(?, cosigned_by) WHERE id=?`, onDevice(g.author_id), onDevice(g.cosigned_by), id);
    }
    for (const pair of payload.dropped_rows || []) {
      const [table, id] = Array.isArray(pair) ? pair : [];
      const t = SYNC.tables.find(x => x.name === table); if (!t || typeof id !== 'string') continue;
      const row = db.one(`SELECT * FROM ${t.name} WHERE id=?`, id); if (!row) continue;
      if (seenAt(t.name, id) !== stamp(row)) { skipped.push({ table: t.name, id, reason: 'kept on this device: it has changes not yet sent to the office' }); continue; }
      if (anotherMayRead(t, row, officeUserId)) continue;
      db.savepoint(() => { db.run(`DELETE FROM ${t.name} WHERE id=?`, id); db.run(`DELETE FROM sync_seen WHERE table_name=? AND id=?`, t.name, id); },
        (err) => skipped.push({ table: t.name, id, reason: String(err && err.message || 'could not be removed').slice(0, 200) }));
    }
    if (payload.device_scope === 'field' && payload.field && typeof payload.field.window_start === 'string') pruneField(payload.field.window_start);
    keepNotices(payload.notices);
    if ((payload.dropped_rows || []).length) audit.log({ user: { username: db.getSetting('sync_username', 'device') }, action: 'sync.scope_removed', details: { rows: payload.dropped_rows.length } });
    // This person's own per-user grants and denies (1.15.0), so the kernel applies the permissions the office
    // does (server/auth.js effectivePerms): a navigator the office holds to their caseload is held to it here
    // too, on a device other people sign in to. An office before 1.16.0 does not send them.
    if (officeUserId && Array.isArray(payload.permission_overrides)) {
      db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, officeUserId);
      for (const o of payload.permission_overrides) {
        if (!o || typeof o.permission !== 'string' || !['grant', 'deny'].includes(o.mode)) continue;
        db.run(`INSERT OR REPLACE INTO user_permission_overrides(user_id, permission, mode, reason, granted_at) VALUES(?,?,?,?,?)`, officeUserId, o.permission, o.mode, String(o.reason || 'set at the office'), o.granted_at || db.now());
      }
    }
    for (const [k, v] of Object.entries(payload.settings || {})) if (v !== null && v !== undefined) db.setSetting(k, v);
    settleSupplies(payload, officeUserId, skipped);
  });
  return counts;
}

// ---- field devices (released in 1.21.0; server/field-scope.js) ----
// The office decides what a field device holds and sends nothing else. What this device does is tidy up what it
// already had: everything from before it became a field device (resetForField), and contacts that have since left the
// window (pruneField). Never a row with changes made here that the office has not had: those stay until they are sent.
const untouched = (table, alias = 'x') => `EXISTS (SELECT 1 FROM sync_seen s WHERE s.table_name='${table}' AND s.id=${alias}.id AND s.updated_at IS COALESCE(${alias}.updated_at, ${alias}.created_at))`;
const hasTable = (name) => !!db.one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, name);
/** Whether anything about this client was changed here and not yet sent (the client row or a row that names it). */
function hasUnsent(clientId) {
  for (const t of SYNC.tables) {
    if (!hasTable(t.name)) continue;
    const col = t.name === 'clients' ? 'id' : t.clientCol;
    if (!col) continue;
    if (db.one(`SELECT 1 FROM ${t.name} x WHERE x.${col}=? AND NOT ${untouched(t.name)} LIMIT 1`, clientId)) return true;
  }
  return false;
}
/** The rows of other tables that point at a row of `name` (so a parent is never removed from under a kept child). */
function referencesTo(name) {
  const refs = [];
  for (const t of SYNC.tables) {
    if (t.parent && t.parent[0] === name) refs.push([t.name, t.parent[1]]);
    if (t.selfParent && t.name === name) refs.push([t.name, t.selfParent]);
    if (name === 'clients' && t.clientCol && t.name !== 'clients') refs.push([t.name, t.clientCol]);
  }
  if (name === 'clients') refs.push(['clients', 'merged_into']);
  return refs.filter(([tn]) => hasTable(tn));
}
/** Remove the rows of `t` that were exchanged and not changed here since, and that nothing kept still points at. */
function removeUntouched(t, extra = '', params = []) {
  if (!hasTable(t.name)) return 0;
  const keep = referencesTo(t.name).map(([tn, col]) => `AND NOT EXISTS (SELECT 1 FROM ${tn} r WHERE r.${col}=x.id${tn === t.name ? ' AND r.id<>x.id' : ''})`).join(' ');
  const ids = db.all(`SELECT x.id FROM ${t.name} x WHERE ${untouched(t.name)} ${extra} ${keep}`, ...params).map(r => r.id);
  let n = 0;
  for (const id of ids) {
    db.savepoint(() => { db.run(`DELETE FROM ${t.name} WHERE id=?`, id); db.run(`DELETE FROM sync_seen WHERE table_name=? AND id=?`, t.name, id); n++; }, () => {});
  }
  return n;
}
/**
 * This device became a field device (the office said so as it signed in, or in its pull: `field_reset`). Everything
 * it holds that a field device may not, or holds in part, goes: the rows of every table that is not sent whole to a
 * field device, exchanged and unchanged here (children first). The pull then starts again from the beginning for
 * every account on the device and brings back exactly what the field scope allows. Tables sent whole (supplies, the
 * lists, the directory, staff accounts) are kept as they are. Rows with changes not yet sent are kept and named.
 */
export function resetForField(skipped = []) {
  const counts = {};
  db.transaction(() => {
    for (const t of [...SYNC.tables].reverse()) {
      const d = FIELD.decision(t.name);
      if (d && d.decision === 'include') continue;
      const n = removeUntouched(t);
      if (n) counts[t.name] = n;
      if (hasTable(t.name)) for (const r of db.all(`SELECT x.id FROM ${t.name} x WHERE NOT ${untouched(t.name)}`)) if (!d || d.decision === 'exclude') skipped.push({ table: t.name, id: r.id, reason: 'kept on this device: it has changes not yet sent to the office' });
    }
    db.run(`DELETE FROM settings WHERE key='sync_cursor' OR key LIKE 'sync_cursor:%' OR key LIKE 'sync_scope:%'`);
  });
  audit.log({ user: { username: db.getSetting('sync_username', 'device') }, action: 'sync.field_reset', details: { rows: counts } });
  return counts;
}
/** A field device's contacts and overdose reports that have left the window (the office sends none older). */
function pruneField(windowStart) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(windowStart)) return;
  const old = (alias) => `${alias}.occurred_at < ?`;
  if (hasTable('intervention_supplies')) removeUntouched({ name: 'intervention_supplies' }, `AND x.intervention_id IN (SELECT i.id FROM interventions i WHERE ${old('i')} AND ${untouched('interventions', 'i')})`, [windowStart]);
  removeUntouched({ name: 'interventions' }, `AND ${old('x')}`, [windowStart]);
  removeUntouched({ name: 'overdose_events' }, `AND ${old('x')}`, [windowStart]);
}
/** What this device holds, as the office last said (its This device page). */
export function scopeStatus() {
  let field = null; try { field = JSON.parse(db.getSetting('device_field', 'null')); } catch { field = null; }
  const scope = db.getSetting('device_sync_scope', null);
  return { scope, field: scope === 'field' ? field : null };
}

/** One office row into the local database. True when it was stored; false when our own edit is newer. */
function applyRow(t, raw, existingCols, toServer, conflicts) {
  const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, raw.id);
  if (t.name === 'users' && !existing) {
    // An account set up on this device under the same username IS this office account. The office row is
    // inserted first, then everything the local account owns is re-pointed at it and the local row dropped
    // -- in that order, because with foreign keys enforced nothing may point at a user that is not there yet.
    const same = db.one(`SELECT id, password_hash FROM users WHERE username=?`, raw.username);
    if (same && raw.password_hash === DUMMY_HASH && same.password_hash) raw.password_hash = same.password_hash;
    // usernames are unique, so the local row steps aside for the moment it takes to insert the office one.
    if (same) db.run(`UPDATE users SET username=? WHERE id=?`, `${raw.username}\u0000merging`, same.id);
    const o = importRow(t, raw, existingCols); const keys = Object.keys(o).filter(k => k !== 'id');
    db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
    if (same) mergeUser(same.id, raw.id);
    seen(t.name, raw.id, stamp(o));
    return true;
  }
  // The office sends a placeholder in place of everyone else's password hash. Overwriting a colleague's
  // real hash with it would lock them out of this shared phone until their own next sync.
  if (t.name === 'users' && raw.password_hash === DUMMY_HASH && existing && existing.password_hash && existing.password_hash !== DUMMY_HASH) raw.password_hash = existing.password_hash;
  if (t.name === 'clients') { const clash = db.one(`SELECT id FROM clients WHERE client_code=? AND id<>?`, raw.client_code, raw.id); if (clash) db.run(`UPDATE clients SET client_code=?, updated_at=? WHERE id=?`, raw.client_code + '-D', db.now(), clash.id); }
  // A server-owned table (supply counts) is the office's alone: whatever this device holds is replaced,
  // never weighed by timestamp — a count edited here would otherwise have stuck until the office touched it.
  if (existing && t.name !== 'users' && !t.serverOwned) {
    const known = seenAt(t.name, existing.id);
    const untouched = known !== undefined && known === stamp(existing);
    if (!untouched && toServer(stamp(existing)) > (raw.updated_at || raw.created_at || NEVER)) return false; // our edit is newer; it gets pushed
    if (!untouched) {
      // The office edit is newer, so it replaces an edit made here that was never sent. That is the
      // rule; being silent about it was not. Column names only -- the values may be PHI.
      const lost = changedColumns(t, existing, raw, existingCols);
      if (lost.length) {
        conflicts.push({ table: t.name, id: raw.id, label: t.name === 'clients' ? existing.client_code : null, columns: lost });
        audit.log({ user: { username: db.getSetting('sync_username', 'device') }, action: 'sync.conflict', entity: t.name, entityId: raw.id, clientId: t.clientCol ? raw[t.clientCol] : null, details: { columns: lost, kept: 'office' } });
      }
    }
  }
  const o = importRow(t, raw, existingCols); const keys = Object.keys(o).filter(k => k !== 'id');
  if (existing) db.run(`UPDATE ${t.name} SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map(k => o[k]), raw.id);
  else db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
  seen(t.name, raw.id, stamp(o));
  // The office merged this client into another. What this device holds against the duplicate — visits,
  // notes, tasks recorded here and not yet sent — moves to the record that was kept, exactly as the office
  // moved its own; the office re-points anything pushed under the old id anyway (server/routes/sync.js
  // keeperOf), so nothing is stamped as edited. The merged row itself stays, marked, and the lists hide it.
  if (t.name === 'clients' && o.merged_into && (!existing || existing.merged_into !== o.merged_into)) repointMergedClient(raw.id, o.merged_into);
  return true;
}

function repointMergedClient(oldId, keeper) {
  if (!db.one(`SELECT 1 FROM clients WHERE id=?`, keeper)) return; // the keeper is not on this device (yet)
  for (const t of SYNC.tables) {
    if (t.name === 'clients' || !t.clientCol || t.serverOwned) continue;
    if (!db.one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t.name)) continue;
    // A row that was already exchanged keeps matching sync_seen (its timestamp did not change), so it is
    // not re-offered; one made here and never sent goes up under the keeper's id.
    db.run(`UPDATE ${t.name} SET ${t.clientCol}=? WHERE ${t.clientCol}=?`, keeper, oldId);
  }
}

/** An office deletion. Recorded locally so the cascade works and it is never re-offered, and remembered as
 *  the office's own so it is not echoed back (see the tombstone push in run()). */
function applyTombstone(t, ts, toServer) {
  const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, ts.id);
  if (existing) {
    const known = seenAt(t.name, existing.id);
    const untouched = known !== undefined && known === stamp(existing);
    // Only drop a row we have not edited since the office last saw it; a local edit after the delete
    // is a real conflict and gets pushed instead.
    if (untouched || toServer(stamp(existing)) < ts.deleted_at) {
      db.run(`DELETE FROM ${t.name} WHERE id=?`, ts.id);
      db.run(`DELETE FROM sync_seen WHERE table_name=? AND id=?`, t.name, ts.id);
    }
  }
  db.run(`INSERT OR REPLACE INTO tombstones(table_name,id,deleted_at) VALUES(?,?,?)`, t.name, ts.id, ts.deleted_at);
  db.run(`INSERT OR REPLACE INTO sync_server_tombstones(table_name,id) VALUES(?,?)`, t.name, ts.id);
}

/** The other accounts that sign in on this shared device (the office sends everyone else a placeholder hash). */
const deviceAccounts = (officeUserId) => db.all(`SELECT * FROM users WHERE id<>? AND is_active=1 AND password_hash IS NOT NULL AND password_hash<>?`, officeUserId || '', DUMMY_HASH);
/** May `u` read this row: the table's permission, whose record, and for a note the SUD counseling rule (server/rules/notes.js). */
function mayRead(u, t, row) {
  if ((t.readPerm && !auth.hasPerm(u, t.readPerm)) || !SYNC.mayReachUnlinked(t.name, u, row, auth.hasPerm)) return false;
  const note = t.name === 'notes' ? row : t.name === 'note_addenda' ? db.one(`SELECT * FROM notes WHERE id=?`, row.note_id) : null;
  return !note || ((note.kind !== 'clinical' || auth.hasPerm(u, 'notes:clinical:read')) && NOTE_RULES.mayReadCounseling(u, note));
}
const anotherMayRead = (t, row, officeUserId) => deviceAccounts(officeUserId).some(u => mayRead(u, t, row));

/**
 * Rows this device has that the office has not seen in their current state. For a sync, `officeUserId` is the account
 * syncing: a note (or addendum) it may not read is left for the account that may -- on a shared device, a clinician's
 * unsynced counseling note is theirs to send, not refused for good under a navigator's name and then forgotten.
 */
function localRows(officeUserId = null) {
  const out = [];
  const syncing = officeUserId && db.one(`SELECT * FROM users WHERE id=?`, officeUserId);
  for (const t of SYNC.tables) {
    if (t.name === 'users' || t.serverOwned) continue; // the office alone keeps server-owned tables (supply items and sites)
    // A visit's draw-down here is provisional (see settleSupplies): the office works out its own.
    const own = t.name === 'supply_ledger' ? ` AND NOT ${PROVISIONAL.replace(/\b(intervention_id|kind|reason)\b/g, 'x.$1')}` : '';
    const rows = db.all(`SELECT x.* FROM ${t.name} x WHERE NOT EXISTS (SELECT 1 FROM sync_seen s WHERE s.table_name=? AND s.id=x.id AND s.updated_at IS COALESCE(x.updated_at, x.created_at))${own}`, t.name);
    for (const r of rows) {
      if (syncing && (t.name === 'notes' || t.name === 'note_addenda') && !mayRead(syncing, t, r)) continue;
      const e = exportRow(t, r); if (!e) continue;
      // A signed AI-assisted note carries its author's review statement: this device's own sign route (the office's
      // routes/notes.js, in the kernel) refused to sign it without one, and the office asks for it again
      // (server/rules/notes.js; security review of 1.17.0, L1).
      if (t.name === 'notes' && Number(r.ai_assisted) && r.status && r.status !== 'draft') e.ai_reviewed = true;
      out.push({ table: t.name, row: e });
    }
  }
  return out;
}

/** This device's own deletions that the office has not been told about. */
export function pendingTombstones() {
  const serverOwned = SYNC.tables.filter(t => t.serverOwned).map(t => t.name);
  return db.all(`SELECT t.table_name, t.id, t.deleted_at FROM tombstones t WHERE t.deleted_at > ?
    AND NOT EXISTS (SELECT 1 FROM sync_server_tombstones s WHERE s.table_name=t.table_name AND s.id=t.id)
    ${serverOwned.length ? `AND t.table_name NOT IN (${serverOwned.map(() => '?').join(',')})` : ''}`, db.getSetting('sync_pushed', NEVER), ...serverOwned);
}

/** Whether the office said this rejection can never succeed on a retry (an older office says nothing; then the reason decides). */
export const isPermanent = (x) => (x.permanent === true || x.permanent === false) ? x.permanent : SYNC.isPermanentReason(x.reason);

/**
 * A permanent rejection is the office's ruling: the row is marked as exchanged so it is not sent again every
 * sync for the rest of the phone's life, and the person is told once, on the sync screen, what did not go.
 * "purged" is the one that also changes what is on the phone: the office removed that record under its
 * retention policy, and this device must not be the place it lives on.
 */
export function settleRejections(rejections, chunk, conflicts) {
  for (const x of rejections) {
    if (!isPermanent(x)) continue;
    const rows = chunk[x.table] || []; const r = rows.find(y => y.id === x.id); if (!r) continue;
    const t = SYNC.tables.find(y => y.name === x.table);
    if (x.reason === 'purged') {
      db.run(`DELETE FROM ${x.table} WHERE id=?`, x.id);
      db.run(`DELETE FROM sync_seen WHERE table_name=? AND id=?`, x.table, x.id);
    } else {
      seen(x.table, x.id, stamp(r));
    }
    // A visit the office will never take draws nothing from its stock, so this device's own draw-down for it goes.
    if (x.table === 'interventions') dropProvisional(x.id);
    conflicts.push({ table: x.table, id: x.id, label: x.table === 'clients' ? r.client_code : null, columns: [], reason: x.reason });
    audit.log({ user: { username: db.getSetting('sync_username', 'device') }, action: 'sync.rejected', entity: x.table, entityId: x.id, clientId: x.table === 'clients' ? x.id : (t && t.clientCol ? r[t.clientCol] : null), details: { reason: x.reason, kept: 'office' } });
  }
}

/** Split pending rows into payloads under the byte budget, keeping each table's rows in table order. */
function chunkRows(pending, maxBytes = PUSH_BYTES) {
  const chunks = []; let current = {}; let size = 0;
  for (const { table, row } of pending) {
    const bytes = JSON.stringify(row).length;
    if (size && size + bytes > maxBytes) { chunks.push(current); current = {}; size = 0; }
    (current[table] = current[table] || []).push(row);
    size += bytes;
  }
  if (size) chunks.push(current);
  return chunks;
}

async function call(server, path, opts = {}, token) {
  let res;
  try {
    res = await fetch(server.replace(/\/$/, '') + path, { ...opts, credentials: 'omit', headers: { 'Content-Type': 'application/json', 'X-Sync-Client': '1', 'X-Device-Id': deviceId(), 'X-Requested-With': 'suds', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
  } catch (e) {
    // A failed fetch is the office being unreachable, not this device being broken -- the kernel's generic
    // 500 text ("something went wrong on this device… sync if it keeps happening") is wrong on both counts
    // here, and sits right next to the erase-this-device button.
    throw new HttpError(502, `Could not reach the office SUDS at ${server}. Check that this device is on the office Wi-Fi (or the address IT gave you) and that the address is right, then try again. Nothing on this device was changed.`, { network: true });
  }
  const ct = res.headers.get('content-type') || ''; const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw officeError(res.status, data);
  return data;
}

/**
 * What the office answered, as the error the Sync screen shows. A plain Error here became the kernel's
 * generic 500 ("Something went wrong on this device"), so a wrong office password, a revoked device and
 * a password the office wants changed all read as a fault on the phone. The office's own message and
 * status travel instead — except two signals the app shell would act on as if they were about the device's
 * own session: `mfaRequired` (it would open the device's #/mfa page) and `passwordChangeRequired` (its own
 * profile page). Those are turned into words about the office account.
 */
function officeError(status, data) {
  const body = data && typeof data === 'object' ? data : {};
  let message = body.error || (typeof data === 'string' && data.trim() ? data.trim().slice(0, 200) : `The office server answered ${status}`);
  const extra = { office: true, ...body };
  delete extra.error; delete extra.mfaRequired; delete extra.passwordChangeRequired;
  if (body.passwordChangeRequired) { message = 'Your office password has to be changed before this device can sync. Sign in at the office address, change it there, then sync again.'; extra.officePasswordChangeRequired = true; }
  if (body.mfaRequired) { message = 'The office account uses two-step verification: enter the code from your authenticator app.'; extra.officeMfaRequired = true; }
  const e = new HttpError(status, message, extra);
  e.data = data;
  return e;
}

/**
 * The on-device web app published on a static host (GitHub Pages; scripts/build-static-site.js) carries
 * window.SUDS_STATIC_HOST. It never syncs: a page served from one origin cannot call another origin's API
 * (the office server sends no CORS headers and its connect-src forbids it), so a sync attempted from it
 * could only fail. It is refused before anything is sent, credentials included. Staff whose records
 * belong on an office server use SUDS at the office address instead (docs/PLATFORM.md).
 */
export function isStaticHost() { try { return typeof window !== 'undefined' && window.SUDS_STATIC_HOST === true; } catch { return false; } }
export const STATIC_HOST_MESSAGE = 'SUDS on this device does not sync with an office server: your records stay in this browser. Keep them safe with "Download a backup" on this page. If your program runs an office SUDS server, use SUDS at its address instead.';
function assertNotStaticHost() {
  if (isStaticHost()) throw new HttpError(403, STATIC_HOST_MESSAGE, { staticSyncRefused: true });
}

/** Has this attachment already been exchanged with the office, in either direction? */
const blobKey = (table, id, col) => `sync_blob:${table}:${id}:${col}`;

/** Attachments the device is missing, fetched one at a time after the rows themselves have landed. */
async function fetchBlobs(server, token, onProgress) {
  let fetched = 0;
  for (const t of SYNC.tables) {
    for (const col of t.blob || []) {
      if (fetched >= BLOBS_PER_SYNC) return fetched;
      const rows = db.all(`SELECT id FROM ${t.name} WHERE ${col} IS NULL LIMIT ?`, BLOBS_PER_SYNC - fetched);
      for (const r of rows) {
        try {
          const got = await call(server, `/api/sync/blob/${t.name}/${r.id}/${col}`, {}, token);
          if (got.value === null || got.value === undefined) continue;
          const stored = t.enc.includes(col) ? encrypt(got.value) : got.value;
          db.run(`UPDATE ${t.name} SET ${col}=? WHERE id=?`, stored, r.id);
          // It came from the office, so the office has it: never try to upload it back. Without this the
          // device re-offered every form template it had just downloaded, and was refused each time.
          db.setSetting(blobKey(t.name, r.id, col), '1');
          fetched++;
          if (fetched % 5 === 0) onProgress(`Downloading attachments (${fetched})…`);
        } catch { /* a missing attachment is not a reason to fail the sync; the next one will retry */ }
      }
    }
  }
  return fetched;
}

/** Attachments captured here that the office does not have yet. */
async function uploadBlobs(server, token, onProgress) {
  let sent = 0;
  for (const t of SYNC.tables) {
    for (const col of t.blob || []) {
      const rows = db.all(`SELECT id, ${col} AS v FROM ${t.name} WHERE ${col} IS NOT NULL LIMIT ?`, BLOBS_PER_SYNC);
      for (const r of rows) {
        const key = blobKey(t.name, r.id, col);
        if (db.getSetting(key, null)) continue;
        // A row the office already knows about arrived from there; its attachment is not ours to push.
        if (db.one(`SELECT 1 FROM sync_seen WHERE table_name=? AND id=?`, t.name, r.id)) { db.setSetting(key, '1'); continue; }
        let value = r.v;
        if (t.enc.includes(col)) { try { value = decrypt(value); } catch { continue; } }
        try {
          await call(server, `/api/sync/blob/${t.name}/${r.id}/${col}`, { method: 'POST', body: JSON.stringify({ value }) }, token);
          db.setSetting(key, '1'); sent++;
          if (sent % 5 === 0) onProgress(`Uploading attachments (${sent})…`);
        } catch (e) { if (e.status === 404 || e.status === 403) db.setSetting(key, '1'); /* the office will never take it; stop retrying */ }
      }
    }
  }
  return sent;
}

/**
 * The office database was restored from a backup (its db_generation changed since this device last
 * synced), so rows this device had already sent — and marked as exchanged — may be gone at the office.
 * Forget what was exchanged: every row here is offered again (the office keeps whichever is newer, as
 * always), attachments are re-offered, the pull starts from the beginning for every account, and this
 * device's own deletions since the beginning are sent again.
 */
export function resetExchangeState() {
  db.run(`DELETE FROM sync_seen`);
  db.run(`DELETE FROM settings WHERE key='sync_cursor' OR key LIKE 'sync_cursor:%' OR key LIKE 'sync_blob:%'`);
  db.setSetting('sync_pushed', NEVER);
}
export const RESTORED_MESSAGE = 'The office database was restored from a backup; re-sending this device\'s records';
const generationOf = (pulled) => (pulled.db_generation === null || pulled.db_generation === undefined ? '' : String(pulled.db_generation));


/** Send everything this device has that the office has not: rows in chunks, then its deletions and its audit trail. */
async function pushAll(server, token, officeUserId, onProgress) {
  onProgress('Uploading this device\'s changes…');
  const deviceNow = db.now();
  const pending = localRows(officeUserId);
  const chunks = chunkRows(pending);
  const pushedCounts = {}; const rejected = []; const conflicts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) onProgress(`Uploading this device's changes (${i + 1} of ${chunks.length})…`);
    const res = await call(server, '/api/sync/push', { method: 'POST', body: JSON.stringify({ device_now: deviceNow, tables: chunks[i] }) }, token);
    const rejectedIds = new Set((res.rejected || []).map(x => x.table + ':' + x.id));
    rejected.push(...(res.rejected || [])); conflicts.push(...(res.conflicts || []));
    for (const w of res.warnings || []) conflicts.push({ table: w.table, id: w.id, label: null, columns: [], reason: w.reason, warning: true });
    for (const [k, v] of Object.entries(res.applied || {})) if (typeof v === 'number') pushedCounts[k] = (pushedCounts[k] || 0) + v;
    // A row counts as exchanged only if the office did not reject it -- or if it rejected it for good.
    db.transaction(() => {
      for (const [table, rows] of Object.entries(chunks[i])) for (const r of rows) if (!rejectedIds.has(table + ':' + r.id)) seen(table, r.id, stamp(r));
      settleRejections(res.rejected || [], chunks[i], conflicts);
    });
  }

  // ---- tombstones and this device's audit trail ----
  // Only our own deletions go up: one the office sent us (sync_server_tombstones) is its record, and
  // echoing it back shifted by this phone's clock offset rewrote the office's deletion time every sync.
  const tombstones = pendingTombstones();
  const auditRows = db.all(`SELECT at, action, entity, entity_id, client_id, success, details FROM audit_log WHERE at > ? AND action NOT LIKE 'sync.%' ORDER BY at, id LIMIT 2000`, db.getSetting('audit_pushed', NEVER));
  if (tombstones.length || auditRows.length) {
    const res = await call(server, '/api/sync/push', { method: 'POST', body: JSON.stringify({ device_now: deviceNow, tombstones, audit: auditRows }) }, token);
    const rejectedIds = new Set((res.rejected || []).map(x => x.table + ':' + x.id));
    rejected.push(...(res.rejected || []));
    const permanent = new Set((res.rejected || []).filter(x => isPermanent(x)).map(x => x.table + ':' + x.id));
    db.transaction(() => {
      // Only forget the tombstones the office actually accepted; a rejected delete stays pending so the
      // device does not end up silently diverging from the office copy -- unless the office has said it
      // will never take it, in which case the office copy is the truth and the next pull restores it.
      for (const ts of tombstones) if (!rejectedIds.has(ts.table_name + ':' + ts.id) || permanent.has(ts.table_name + ':' + ts.id)) db.run(`DELETE FROM tombstones WHERE table_name=? AND id=?`, ts.table_name, ts.id);
    });
    db.setSetting('sync_pushed', deviceNow);
    // Advance the audit cursor only past rows that were actually sent, never to "now" — anything above
    // the page limit has to go next time rather than being dropped.
    if (auditRows.length) db.setSetting('audit_pushed', auditRows[auditRows.length - 1].at);
  } else {
    db.setSetting('sync_pushed', deviceNow);
  }

  return { pushedCounts, rejected, conflicts };
}

/** Full sync: sign in to the office server, pull changes, push local changes, record the cursor. */
export async function run({ server, username, password, code, fieldDevice = false, onProgress = () => {} }) {
  if (!server) throw new HttpError(400, 'Office server address is required');
  assertNotStaticHost();
  onProgress('Signing in to the office server…');
  let login;
  try {
    // field_device: its user asks for this device to be a field device as they enrol it (narrowing only; server/auth.js).
    login = await call(server, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, ...(fieldDevice ? { field_device: true } : {}) }) });
  } catch (e) {
    // The office server has told this specific device (not the account) to erase itself, the moment it
    // tried to sign in — before any session or data exchange happened. Nothing else in the payload can be
    // trusted after this, so it wipes immediately rather than proceeding.
    // A revoked device whose wipe was ever requested is told to wipe too (wipeRequested), so the phone
    // never keeps records because the request and the revocation arrived in the wrong order.
    if (e.data && (e.data.deviceWipeRequired || (e.data.deviceRevoked && e.data.wipeRequested))) {
      onProgress('This device has been remotely wiped by an administrator…');
      const id = deviceId(); const ackToken = e.data.wipeAckToken;
      // The kernel's wipe (local/kernel.js wipeDevice) also drops the session token and the encryption keys
      // and stops every later save; the shim's own wipe is the fallback when running outside the kernel.
      if (typeof window !== 'undefined' && window.SUDS_LOCAL && window.SUDS_LOCAL.wipe) await window.SUDS_LOCAL.wipe(); else await wipeLocalDb();
      // Tell the office the wipe happened. The token is one-time and short-lived; it is absent when the
      // office already marked the device wiped because the sign-in credentials were valid. Best effort:
      // the wipe itself does not depend on the office hearing about it.
      if (ackToken) { try { await call(server, '/api/devices/wipe-ack', { method: 'POST', body: JSON.stringify({ device_id: id, token: ackToken }) }); } catch { /* offline or expired: the next credentialed sign-in marks it */ } }
      throw new HttpError(410, 'This device was remotely wiped by an administrator. It has been erased and must be set up again.', { wiped: true });
    }
    throw e;
  }
  const token = login.token; if (!token) throw new HttpError(400, 'The office server did not return a sync token (update the server to 1.1 or newer)');
  // `officeMfaRequired`, not `mfaRequired`: the latter is what the app shell reads as "this device's own
  // session needs a code" and it navigated the device to its own #/mfa page (public/app.js).
  if (login.mfaPending) { if (!code) throw new HttpError(401, 'The office account uses two-step verification: enter the code from your authenticator app.', { officeMfaRequired: true }); await call(server, '/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code }) }, token); }
  try {
    const demo = require('../server/demo.js');
    if (demo.status().loaded) { onProgress('Removing sample data before the first sync…'); demo.remove({ actor: null, tombstones: false }); }

    const pullConflicts = []; const skipped = []; const notices = [];
    // ---- pull, page by page ----
    const officeUserId = (login.user && login.user.id) || username;
    // The office says what this device is as it signs in (server/auth.js login). When that changed since the last sync,
    // what was recorded here goes up first, under the scope it was recorded in, so nothing is lost when the device
    // then narrows: a device that became a field device removes what it may no longer hold before pulling again.
    const officeScope = login.device && ['full', 'field'].includes(login.device.scope) ? login.device.scope : null;
    const heldScope = db.getSetting('device_sync_scope', 'full');
    let earlyPushed = {}; const earlyRejected = []; const earlyConflicts = [];
    let fieldResetDone = false;
    if (officeScope && officeScope !== heldScope) {
      onProgress(officeScope === 'field' ? 'This device is now a field device: sending its changes first…' : 'This device now holds everything again: sending its changes first…');
      // A device that has never synced has nothing the office has not had yet that belongs to it (its first pull
      // turns its own account into the office's before anything goes up), so it just starts in the new scope.
      if (db.getSetting('last_sync_at', null)) {
        const first = await pushAll(server, token, officeUserId, onProgress);
        earlyPushed = first.pushedCounts; earlyRejected.push(...first.rejected); earlyConflicts.push(...first.conflicts);
      }
      if (officeScope === 'field') {
        onProgress('Removing what a field device does not keep…');
        resetForField(skipped); fieldResetDone = true;
        notices.push('This device is now a field device: it keeps only what you need in the field. Everything else was removed from it (nothing was deleted at the office).');
      } else notices.push('This device is no longer a field device: it downloaded everything you may see.');
    }
    let since = readCursor(officeUserId, username);
    const applied = {}; let pages = 0; let serverNow = null; let generationReset = false;
    // Backfill pages (the records of clients newly assigned to this person, which the office sends in pages
    // of its own after the page that carried the assignment -- server/routes/sync.js backfillPage) are
    // counted apart from the ordinary ones: a caseload transfer can take many of them, and each is bounded.
    let backfillPages = 0;
    for (;;) {
      const backfilling = String(since).includes(BACKFILL_MARK);
      onProgress(backfilling ? `Downloading the records of newly assigned clients (page ${backfillPages + 1})…` : pages ? `Downloading changes from the office (page ${pages + 1})…` : 'Downloading changes from the office…');
      // The office's key of what this person may read, as of this device's last pull (server/routes/sync.js
      // syncScopeKey). A device that synced before 1.16.0 has none: `legacy` (it holds what the 1.15 role
      // defaults allowed). When it has changed, the office names what to remove and starts again for the rest.
      const scopeKey = since === NEVER ? null : db.getSetting(scopeSettingKey(officeUserId), null) || 'legacy';
      const pulled = await call(server, `/api/sync/pull?since=${encodeURIComponent(since)}${scopeKey ? `&scope=${encodeURIComponent(scopeKey)}` : ''}`, {}, token);
      // A restored office database (see resetExchangeState). Checked before this page is applied, so the
      // whole pull restarts from the beginning under the new generation.
      const generation = generationOf(pulled); const known = db.getSetting('office_db_generation', null);
      if (known !== null && known !== generation && !generationReset) {
        generationReset = true;
        onProgress(RESTORED_MESSAGE + '…');
        db.transaction(() => { resetExchangeState(); db.setSetting('office_db_generation', generation); });
        audit.log({ user: { username }, action: 'sync.office_restored', details: { server, from: known || null, to: generation || null } });
        notices.push(RESTORED_MESSAGE + '.');
        since = NEVER; pages++;
        continue;
      }
      if (known === null) db.setSetting('office_db_generation', generation);
      if (pulled.full_resync_required) {
        // This device has been away longer than deletions are kept, so it cannot be brought up to date
        // incrementally without silently keeping rows the office has dropped. Start over from NEVER.
        onProgress('This device has been offline a long time; rebuilding from the office copy…');
        db.run(`DELETE FROM sync_seen`);
        since = NEVER;
        db.run(`DELETE FROM settings WHERE key='sync_cursor' OR key LIKE 'sync_cursor:%'`);
        if (pages > 20) throw new HttpError(409, pulled.reason || 'This device needs to be set up again from the office server');
        pages++;
        continue;
      }
      // The office's own word that this device must start again as a field device (its scope key changed).
      if (pulled.field_reset && !fieldResetDone) { resetForField(skipped); fieldResetDone = true; }
      const counts = applyPull(pulled, pullConflicts, skipped, officeUserId);
      if (pulled.device_scope === 'field' || pulled.device_scope === 'full') {
        db.setSetting('device_sync_scope', pulled.device_scope);
        db.setSetting('device_field', JSON.stringify(pulled.device_scope === 'field' && pulled.field ? { window_days: pulled.field.window_days, holds: pulled.field.holds } : null));
      }
      for (const [k, v] of Object.entries(counts)) applied[k] = (applied[k] || 0) + v;
      serverNow = pulled.server_now;
      // The cursor is opaque here: a plain timestamp, or one carrying the office's backfill position. It is
      // stored after every page, so a sync cut short resumes where it stopped.
      since = pulled.cursor;
      db.setSetting(cursorKey(officeUserId), since);
      if (typeof pulled.scope === 'string') db.setSetting(scopeSettingKey(officeUserId), pulled.scope);
      if (pulled.scope_changed) notices.push(pulled.scope_widened ? 'Your access at the office changed: this device downloaded everything you may now see.' : 'Your access at the office changed: records you may no longer see were removed from this device.');
      if (pulled.complete) break;
      if (backfilling || pulled.backfill) { if (++backfillPages > MAX_BACKFILL_PAGES) break; continue; }
      if (++pages > 200) break;
    }

    // ---- push ----
    const { pushedCounts, rejected, conflicts: pushConflicts } = await pushAll(server, token, officeUserId, onProgress);
    const conflicts = [...pullConflicts, ...earlyConflicts, ...pushConflicts];
    rejected.unshift(...earlyRejected);
    for (const [k, v] of Object.entries(earlyPushed)) pushedCounts[k] = (pushedCounts[k] || 0) + v;

    // ---- attachments ----
    const uploaded = await uploadBlobs(server, token, onProgress);
    const downloaded = await fetchBlobs(server, token, onProgress);

    db.setSetting('last_sync_at', db.now()); db.setSetting('sync_server', server); db.setSetting('sync_username', username);
    audit.log({ user: { username }, action: 'sync.completed', details: { server, pulled: applied, pushed: pushedCounts, rejected: rejected.length, conflicts: conflicts.length, skipped: skipped.length, attachments_up: uploaded, attachments_down: downloaded } });
    return { ok: true, pulled: applied, pushed: pushedCounts, rejected, conflicts, skipped, notices, attachments: { uploaded, downloaded }, at: db.now() };
  } finally { try { await call(server, '/api/auth/logout', { method: 'POST', body: '{}' }, token); } catch {} }
}

export { applyPull, localRows, chunkRows };

export function register(router) {
  // The tables are made when the database is opened (local/kernel.js openDatabase): a locked device has none open here.
  router.post('/api/local/sync', auth.requireAuth, async (ctx) => {
    const { server, username, password, code, field_device: fieldDevice } = ctx.body || {};
    return run({ server, username: username || ctx.user.username, password, code, fieldDevice: fieldDevice === true });
  });
  router.get('/api/local/sync/status', auth.requireAuth, () => ({ last_sync_at: db.getSetting('last_sync_at', null), server: db.getSetting('sync_server', null), username: db.getSetting('sync_username', null),
    pending: localRows().length, device: scopeStatus() }));
}
