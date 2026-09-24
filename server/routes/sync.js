'use strict';
// Device <-> server synchronisation. The phone runs its own copy of SUDS (local kernel) and calls these
// routes on demand. Rows are identified by UUID; the newest updated_at wins; hard deletes travel as
// tombstones. PHI columns are decrypted for transport (over TLS, authenticated) and re-encrypted with the
// receiver's key.
//
// Two rules shape this file:
//  * A device may not do through sync what its user could not do through the API. Every table carries the
//    permission its REST routes require, and caseload scoping is applied to pushed rows, not just pulled ones.
//  * One bad row must never cost a device its ability to sync. Each row is applied inside a savepoint; a
//    failure rejects that row and the rest of the batch still lands.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, forbidden } = require('../http');
const { encrypt, decrypt, blindIndex } = require('../crypto');
const SYNC = require('../sync-tables');
const { wouldCycle } = require('./budget');

const NEVER = '1970-01-01T00:00:00.000Z';
// One pull answers with at most this many rows per table. Beyond that the device is told to come back for
// more, so a first sync of a large county is many small responses instead of one that cannot be parsed.
const PULL_LIMIT = 2000;

function cols(table) { return db.all(`PRAGMA table_info(${table})`).map(c => c.name); }

// Row marshalling lives in sync-tables.js so the server and the device cannot drift apart.
const { exportRow, importRow } = SYNC;

function scopeSql(t, user, alias) {
  const cf = auth.caseloadFilter(user, `${alias}.${t.clientCol}`);
  if (t.scope === 'all' || t.scope === 'users') return { sql: '1=1', params: [] };
  // A client merged away at the office drops off the caseload (its assignments moved to the record that
  // was kept), so the device that still held it was never told and showed a duplicate for ever. The merged
  // row travels when the record it was merged into is on the caseload: the device marks it merged and
  // re-points what it holds, exactly as the office did.
  if (t.name === 'clients' && cf.sql !== '1=1') { const kf = auth.caseloadFilter(user, `${alias}.merged_into`); return { sql: `(${cf.sql} OR (${alias}.merged_into IS NOT NULL AND ${kf.sql}))`, params: [...cf.params, ...kf.params] }; }
  if (t.scope === 'via-note') { const nf = auth.caseloadFilter(user, 'n.client_id'); return { sql: `${alias}.note_id IN (SELECT n.id FROM notes n WHERE ${nf.sql})`, params: nf.params }; }
  if (t.scope === 'client-or-null') return { sql: `(${alias}.${t.clientCol} IS NULL OR ${cf.sql})`, params: cf.params };
  return cf;
}

// Pull everything changed since `since` that the user may see, in bounded pages.
//
// Paging is by updated_at, which is not unique: a bulk import can stamp thousands of rows with the same
// instant. Cutting a page in the middle of one timestamp would lose every row after the cut, because the
// next request asks for `> cursor`. So a page always ends on a timestamp boundary — and when a single
// timestamp is itself bigger than a page, that timestamp is sent whole rather than split.
function pull(user, since, { limit = PULL_LIMIT } = {}) {
  const serverNow = db.now();
  const raw = {}; const capped = [];

  for (const t of SYNC.tables) {
    const sc = scopeSql(t, user, 'x');
    // updated_at is NOT NULL on every synced table (migration 5) and indexed, so this is a range scan
    // rather than the full table scan a COALESCE would force.
    const rows = db.all(`SELECT x.* FROM ${t.name} x WHERE x.updated_at > ? AND ${sc.sql} ORDER BY x.updated_at LIMIT ?`, since, ...sc.params, limit + 1);
    if (rows.length <= limit) { raw[t.name] = rows; continue; }

    // More to come. The first row that did not fit marks the boundary; everything strictly before it is
    // safe to send, because no row of an earlier timestamp can be left behind.
    const boundary = rows[limit].updated_at;
    const safe = rows.filter(r => r.updated_at < boundary);
    if (safe.length) { raw[t.name] = safe; capped.push(safe[safe.length - 1].updated_at); continue; }

    // The whole page is one timestamp, so it cannot be split without losing rows. Send all of it.
    raw[t.name] = db.all(`SELECT x.* FROM ${t.name} x WHERE x.updated_at = ? AND ${sc.sql} ORDER BY x.updated_at`, boundary, ...sc.params);
    capped.push(boundary);
  }

  // Every table stops at the same instant, so the cursor stays a single point in time.
  const cursor = capped.length ? capped.reduce((a, b) => (a < b ? a : b)) : serverNow;
  const complete = capped.length === 0;

  // db_generation changes when the office database is restored from a backup (server/backup.js). A device
  // that sees a value it did not expect knows the office may have lost rows it had already accepted, forgets
  // what it thought was exchanged, and offers everything it holds again.
  const out = { cursor, server_now: serverNow, complete, db_generation: db.getSetting('db_generation', null), tables: {}, tombstones: [], settings: {}, skipped: [] };
  for (const t of SYNC.tables) {
    let rows = raw[t.name].filter(r => r.updated_at <= cursor);
    if (t.name === 'users') rows = rows.map(r => ({ ...(r.id === user.id ? r : { ...r, password_hash: 'scrypt$0$0$0$AA==$AA==' }), mfa_secret_enc: null, mfa_enabled: 0 })); // devices get own password hash for offline login; never MFA secrets
    if (t.name === 'notes' && !auth.hasPerm(user, 'notes:clinical:read')) rows = rows.filter(r => r.kind !== 'clinical'); // minimum necessary
    if (t.name === 'note_addenda' && !auth.hasPerm(user, 'notes:clinical:read')) rows = rows.filter(r => db.one(`SELECT kind FROM notes WHERE id=?`, r.note_id)?.kind !== 'clinical');
    const exported = [];
    for (const r of rows) {
      const e = exportRow(t, r);
      if (e) exported.push(e);
      else out.skipped.push({ table: t.name, id: r.id, reason: 'could not be decrypted on the server' });
    }
    out.tables[t.name] = exported;
  }
  out.tombstones = db.all(`SELECT table_name, id, deleted_at FROM tombstones WHERE deleted_at > ? AND deleted_at <= ? ORDER BY deleted_at`, since, cursor);
  // A device that has been away longer than tombstones are kept cannot be told what was deleted, so it is
  // sent for a full resync instead of quietly keeping rows everyone else has dropped.
  const horizon = db.getSetting('tombstone_purged_before', null);
  if (horizon && since !== NEVER && since < horizon) { out.full_resync_required = true; out.reason = 'This device has been offline longer than deletions are kept; it will rebuild from the office copy.'; }
  for (const k of SYNC.settings_keys) out.settings[k] = db.getSetting(k, null);
  return out;
}

// Apply rows from a device. Last write wins by updated_at; users are never overwritten from devices.
// Which columns a device's row would change, by name. Encrypted columns are compared as plaintext (each
// encryption uses a fresh IV, so ciphertext never matches ciphertext) and blind indexes are skipped; the
// values themselves never leave this function.
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

/** Follow a merged-away client to the record that was kept (merges can chain). */
function keeperOf(clientId) {
  let cur = clientId;
  for (let i = 0; i < 25; i++) {
    const c = db.one(`SELECT merged_into FROM clients WHERE id=?`, cur);
    if (!c || !c.merged_into) return cur;
    cur = c.merged_into;
  }
  return cur;
}

// A clients tombstone only ever comes from a hard delete on the office side — the retention purge, or
// sample data being removed — never from a device (clients are not hard-deleted through sync). Such a row
// must never come back, whatever a device's clock says about it.
const clientPurged = (clientId) => !!db.one(`SELECT 1 FROM tombstones WHERE table_name='clients' AND id=?`, clientId);

// Which user a device may say did the work. Mirrors the REST routes: crud.js's restrictOwner lets only
// clients:all set user_id on someone else's behalf, time.js uses time:all, and a note's author is the person
// who wrote it unless a manager says otherwise.
const OWNER = { interventions: ['user_id', 'clients:all'], calls: ['user_id', 'clients:all'], time_entries: ['user_id', 'time:all'], referrals: ['user_id', 'clients:all'], expenditures: ['user_id', 'clients:all'], notes: ['author_id', 'clients:all'] };

/**
 * An assignment a worker without assignments:manage may still push: their own (user_id is theirs, or a
 * device-minted id that is about to be remapped to them), as primary, on a client they created — the
 * one the device auto-created at intake, the same way POST /api/clients does at the office. The client
 * is checked against the office copy, so the clients rows of the same push (applied first, in table
 * order) count; a client someone else created, or one the office has never seen, does not qualify.
 */
function isSelfAssignment(raw, user, knownUsers, batchClients) {
  if (!raw || typeof raw.client_id !== 'string') return false;
  if (raw.user_id && raw.user_id !== user.id && knownUsers.has(raw.user_id)) return false;
  if ((raw.role_on_case || 'primary') !== 'primary') return false;
  const existing = db.one(`SELECT user_id FROM assignments WHERE id=?`, raw.id);
  if (existing && existing.user_id !== user.id) return false;
  const client = db.one(`SELECT created_by FROM clients WHERE id=?`, raw.client_id);
  if (client) return client.created_by === user.id;
  // Not at the office yet: the same push must be creating it, and by this worker (a device-minted creator
  // id is remapped to the syncing user when the client row lands).
  const inBatch = batchClients.get(raw.client_id);
  return !!inBatch && (!inBatch.created_by || inBatch.created_by === user.id || !knownUsers.has(inBatch.created_by));
}

function push(user, payload) {
  const applied = {}; const rejected = []; const conflicts = []; const warnings = [];
  // permanent: the office has ruled and a retry can never succeed, so the device stops resending the row.
  const reject = (table, id, reason, permanent = SYNC.isPermanentReason(reason)) => { rejected.push({ table, id, reason, permanent }); };
  const rejectedIds = new Map(); // `${table}:${id}` -> permanent?

  // Device clocks are not trusted: shift the device's own bookkeeping timestamps by the measured offset so
  // last-write-wins compares in server time. Only created_at and updated_at are shifted — signed_at,
  // approved_at and the rest are clinical and legal facts, not sync metadata, and rewriting them would
  // silently edit the record every time a differently-skewed device synced. The shifted updated_at is used
  // for the comparison only: what is stored is the server's own clock, so every other device's incremental
  // pull (updated_at > cursor) sees the row. A stored device timestamp in the past was invisible to them.
  const deviceNow = payload.device_now ? Date.parse(payload.device_now) : NaN;
  const offsetMs = Number.isFinite(deviceNow) ? Date.now() - deviceNow : 0;
  const shift = (ts) => { if (!ts || !offsetMs) return ts; const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t + offsetMs).toISOString() : ts; };

  // One lookup instead of one per user-reference column per row.
  const users = new Map(db.all(`SELECT id, is_active FROM users`).map(u => [u.id, u]));
  const knownUsers = new Set(users.keys());
  // client id -> the self-assignment row the device is sending for it (so the client insert does not add its own).
  const batchClients = new Map(((payload.tables || {}).clients || []).filter(r => r && typeof r.id === 'string').map(r => [r.id, r]));
  const pushedSelfAssignments = new Map(); const selfAssignmentIds = new Set();
  for (const raw of (payload.tables || {}).assignments || []) if (raw && typeof raw.id === 'string' && isSelfAssignment(raw, user, knownUsers, batchClients)) { pushedSelfAssignments.set(raw.client_id, raw); selfAssignmentIds.add(raw.id); }

  // A row that points at its own parent within the same table (e.g. a budget sub-allocation) needs that
  // parent applied first, same as t.parent does across tables — but nothing orders rows within one table's
  // batch, and a device can create a whole hierarchy offline in one sitting. Stable topological sort by
  // that self-reference column; a parent outside this batch (already synced, or simply absent) needs no
  // reordering since it is either already in the database or the row will be rejected on its own merits.
  function selfParentOrder(rows, col) {
    const ids = new Set(rows.map(r => r && r.id));
    const placed = new Set(); const out = []; let remaining = rows;
    while (remaining.length) {
      const [ready, waiting] = [[], []];
      for (const r of remaining) (!r || !r[col] || !ids.has(r[col]) || placed.has(r[col]) ? ready : waiting).push(r);
      if (!ready.length) { out.push(...waiting); break; } // a cycle within the batch — let per-row validation reject it
      for (const r of ready) { out.push(r); if (r && r.id) placed.add(r.id); }
      remaining = waiting;
    }
    return out;
  }

  db.transaction(() => {
    for (const t of SYNC.tables) {
      let rows = (payload.tables || {})[t.name]; if (!Array.isArray(rows) || !rows.length) continue;
      if (t.selfParent) rows = selfParentOrder(rows, t.selfParent);
      if (t.name === 'users') continue;
      // Shared program state the office alone keeps (supply counts): a device's copy is never the truth.
      if (t.serverOwned) {
        for (const raw of rows) if (raw && typeof raw.id === 'string') reject(t.name, raw.id, 'server-owned');
        applied[t.name] = 0;
        continue;
      }
      // Syncing is not a way around a role's limits: the same permission the REST route requires applies here.
      // One exception, mirroring POST /api/clients: a worker who creates a client is put on it as primary
      // without needing assignments:manage, and the device does exactly that offline — so the assignment it
      // then pushes (its own, on a client it created) is accepted rather than refused on every sync.
      if (t.writePerm && !auth.hasPerm(user, t.writePerm)) {
        const kept = [];
        for (const raw of rows) {
          if (!raw || typeof raw.id !== 'string') continue;
          if (t.name === 'assignments' && selfAssignmentIds.has(raw.id)) { kept.push(raw); continue; }
          reject(t.name, raw.id, `your role cannot write ${t.name}`);
        }
        if (!kept.length) { applied[t.name] = 0; continue; }
        rows = kept;
      }
      const existingCols = cols(t.name); let n = 0;
      for (const raw of rows) {
        if (!raw || typeof raw.id !== 'string') continue;
        // A device on an older kernel names a renamed column the old way; without this its value is dropped.
        SYNC.upgradeLegacyRow(t, raw);
        // A child whose parent was rejected has nothing to attach to; skipping it beats a constraint error.
        // The child inherits the parent's permanence: a child of a purged client will never land either.
        if (t.parent && raw[t.parent[1]] && rejectedIds.has(`${t.parent[0]}:${raw[t.parent[1]]}`)) {
          const permanent = rejectedIds.get(`${t.parent[0]}:${raw[t.parent[1]]}`);
          reject(t.name, raw.id, `its ${t.parent[0]} row was rejected`, permanent); rejectedIds.set(`${t.name}:${raw.id}`, permanent); continue;
        }

        const ok = db.savepoint(() => {
          // The device's own idea of when it last touched the row, in server time — for the comparison only.
          const incomingAt = shift(raw.updated_at || raw.created_at) || NEVER;
          const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, raw.id);
          // created_at is shifted once, when the office first sees the row. Re-shifting it on every round
          // trip from a differently-skewed device walked it away from the truth a little each time.
          if (existing) delete raw.created_at; else if (raw.created_at) raw.created_at = shift(raw.created_at);
          delete raw.updated_at;

          // A purged record stays purged. Nothing a device holds can bring back a client the retention
          // policy removed — not the client, and not anything that hangs off it.
          if (t.name === 'clients' && clientPurged(raw.id)) { reject(t.name, raw.id, 'purged'); return false; }
          if (t.clientCol && t.name !== 'clients' && raw[t.clientCol] && clientPurged(raw[t.clientCol])) { reject(t.name, raw.id, 'purged'); return false; }
          if (t.scope === 'via-note' && raw.note_id && db.one(`SELECT 1 FROM tombstones WHERE table_name='notes' AND id=?`, raw.note_id)) { reject(t.name, raw.id, 'purged'); return false; }

          // A merge is the office's decision about who is the same person. A device that still holds the
          // duplicate keeps working on it offline; what it sends is re-pointed at the record that was kept,
          // and an existing child never moves between clients by sync at all.
          if (t.name === 'clients' && existing && existing.merged_into) { reject(t.name, raw.id, 'merged into another record'); return false; }
          if (t.clientCol && t.name !== 'clients') {
            if (existing) raw[t.clientCol] = existing[t.clientCol];
            else if (raw[t.clientCol]) raw[t.clientCol] = keeperOf(raw[t.clientCol]);
          }
          // Caseload scoping applies to everything that carries a client, including the tables where the
          // client is optional (calls, tasks, time, expenditures) — those were previously unchecked.
          // (A self-assignment is what puts the new client on the caseload, so it cannot be judged by it.)
          if ((t.scope === 'client' || t.scope === 'client-or-null') && raw[t.clientCol] && t.name !== 'clients' && !selfAssignmentIds.has(raw.id) && !auth.canAccessClient(user, raw[t.clientCol])) { reject(t.name, raw.id, 'not on caseload'); return false; }
          if (t.name === 'clients' && existing && !auth.canAccessClient(user, raw.id)) { reject(t.name, raw.id, 'not on caseload'); return false; }
          // A self-assignment the device made for a client it created (see isSelfAssignment). A matching
          // open assignment under another id — the office's own, from a sync before this rule existed —
          // makes the device's row a duplicate, which is refused for good so the device stops offering it.
          if (t.name === 'assignments' && !existing && selfAssignmentIds.has(raw.id)) {
            const dup = db.one(`SELECT id FROM assignments WHERE client_id=? AND user_id=? AND role_on_case=? AND id<>? AND ${auth.activeAssignment()}`, raw.client_id, user.id, raw.role_on_case || 'primary', raw.id);
            if (dup) { reject(t.name, raw.id, 'conflicts with an existing record'); return false; }
          }
          // Consents, disclosures and addenda are the legal record: a device may add to it, never rewrite it.
          // A push that would resurrect a revoked consent or change who a disclosure went to is refused. The
          // one permitted change is revoking a consent that is not yet revoked, and it changes nothing else.
          let revocation = false;
          if (existing && SYNC.immutable.includes(t.name)) {
            const changed = changedColumns(t, existing, raw, existingCols);
            const onlyRevocation = t.name === 'consents' && !existing.revoked_at && raw.revoked_at && changed.every(c => ['revoked_at', 'revoked_reason', 'revoked_by'].includes(c));
            if (!onlyRevocation) { if (changed.length) reject(t.name, raw.id, 'immutable'); return false; }
            revocation = true;
            for (const k of Object.keys(raw)) if (!['id', 'revoked_at', 'revoked_reason'].includes(k)) delete raw[k];
            raw.revoked_by = user.id;
          }
          if (t.scope === 'via-note') { const note = db.one(`SELECT client_id, kind FROM notes WHERE id=?`, raw.note_id); if (!note || !auth.canAccessClient(user, note.client_id) || (note.kind === 'clinical' && !auth.hasPerm(user, 'notes:clinical:write'))) { reject(t.name, raw.id, 'not permitted'); return false; } }
          if (t.name === 'notes' && raw.kind === 'clinical' && !auth.hasPerm(user, 'notes:clinical:write')) { reject(t.name, raw.id, 'clinical notes not permitted for this role'); return false; }
          // The REST route (PUT /api/budget/lines/:id) blocks a re-parent that would create a cycle; a push
          // applies rows straight through with no such check otherwise — nothing here stops two lines each
          // pointing at the other (both already exist, so neither side hits an FK violation) from silently
          // dropping both of them out of every fund's line tree (buildLineTree only walks from roots).
          if (t.name === 'budget_lines' && raw.parent_id && wouldCycle(raw.id, raw.parent_id)) { reject(t.name, raw.id, 'would create a cycle in its allocation hierarchy'); return false; }
          // Same REST route also requires the parent to belong to the same fund. Nothing here stopped a push
          // from re-parenting into a different fund's line: wouldCycle only walks the parent chain, so two
          // lines in unrelated trees never collide. A line with a foreign parent_id keeps its own subtree
          // totals (buildLineTree falls back to treating it as a root when its parent isn't in this fund's
          // set) but drops out of its real fund's `allocated` total (it's excluded there for having a
          // non-null parent_id) — silently inflating that fund's "unallocated" figure by the line's full
          // amount while it still draws real expenditures.
          if (t.name === 'budget_lines' && raw.parent_id) {
            const parent = db.one(`SELECT funding_source_id FROM budget_lines WHERE id=?`, raw.parent_id);
            if (parent && parent.funding_source_id !== raw.funding_source_id) { reject(t.name, raw.id, 'parent allocation does not belong to this fund'); return false; }
          }
          // interventions.js's checkCost() requires budget:write to attach or change a cost/fund/line on the
          // REST route — a clinician (interventions:* but no budget permission) could otherwise use a push to
          // set the same fields verbatim, since push writes straight to SQL with none of that route's hooks.
          // Only rejected when the value is actually changing (or being set on a new row): a device re-syncing
          // an unrelated edit to a row that already, legitimately, carries a fund/line/cost must not suddenly
          // need budget:write just because that data is still sitting in the row it's sending.
          if (t.name === 'interventions' && !auth.hasPerm(user, 'budget:write')) {
            const changed = !existing || raw.cost !== existing.cost || raw.funding_source_id !== existing.funding_source_id || raw.budget_line_id !== existing.budget_line_id;
            if (changed && ((raw.cost && raw.cost > 0) || raw.funding_source_id || raw.budget_line_id)) { reject(t.name, raw.id, 'you do not have permission to attach a cost to a funding source'); return false; }
          }
          if (existing && !revocation && (existing.updated_at || existing.created_at || NEVER) >= incomingAt) {
            // The office copy is newer, so the device's edit loses. That is the rule -- but it must not lose
            // silently: the person who typed it saw "saved" on their phone. Name the columns that differ (never
            // the values) in the audit log, and tell the device so it can say so on the sync screen.
            const lost = changedColumns(t, existing, raw, existingCols);
            if (lost.length && (existing.updated_at || existing.created_at || NEVER) > incomingAt) {
              conflicts.push({ table: t.name, id: raw.id, label: t.name === 'clients' ? existing.client_code : null, columns: lost, server_updated_at: existing.updated_at, device_updated_at: incomingAt });
              audit.log({ user, action: 'sync.conflict', entity: t.name, entityId: raw.id, clientId: t.clientCol ? raw[t.clientCol] : null, ip: 'device', details: { columns: lost, server_had: existing.updated_at, device_sent: incomingAt, kept: 'office' } });
            }
            return false;
          }
          // Who did the work. A device may name another worker only when it names a real, active office
          // account and the syncing user could have done the same over REST; otherwise the row is refused
          // rather than quietly re-attributed to whoever happened to press Sync on a shared phone.
          if (OWNER[t.name]) {
            const [col, perm] = OWNER[t.name];
            const want = raw[col];
            if (existing && (!want || !auth.hasPerm(user, perm))) raw[col] = existing[col];
            else if (!want) raw[col] = user.id;
            else if (want !== user.id && want !== (existing && existing[col])) {
              const target = users.get(want);
              // An id the office has never heard of is a device-minted local account, not another worker:
              // it is remapped to the syncing user below, as every other user reference is.
              if (target && !target.is_active) { reject(t.name, raw.id, 'attributed to a user the office has deactivated'); return false; }
              if (target && !auth.hasPerm(user, perm)) { reject(t.name, raw.id, 'attributed to another user, which your role cannot do'); return false; }
            }
          }
          if (t.name === 'expenditures') { if (!existing) { raw.status = 'pending'; raw.approved_by = null; raw.approved_at = null; } else if (!auth.hasPerm(user, 'budget:approve')) { raw.status = existing.status; raw.approved_by = existing.approved_by; raw.approved_at = existing.approved_at; raw.approval_note = existing.approval_note; } }
          if (t.name === 'time_entries') { if (!existing) { raw.status = raw.status === 'submitted' ? 'submitted' : 'draft'; raw.approved_by = null; raw.approved_at = null; } else if (!auth.hasPerm(user, 'time:approve')) { raw.status = existing.status === 'approved' || existing.status === 'rejected' ? existing.status : raw.status; raw.approved_by = existing.approved_by; raw.approved_at = existing.approved_at; } }
          if (t.name === 'notes' && existing) {
            if (existing.status !== 'draft') { raw.content_enc = undefined; raw.structured_enc = undefined; raw.status = existing.status; raw.signed_by = existing.signed_by; raw.signed_at = existing.signed_at; raw.signature_hash = existing.signature_hash; } // signed notes are immutable
            // A countersignature is the supervisor's act on the office server; a device can never assert one.
            raw.cosigned_by = existing.cosigned_by; raw.cosigned_at = existing.cosigned_at; raw.cosignature_hash = existing.cosignature_hash;
          }
          if (t.name === 'notes' && !existing) { raw.cosigned_by = null; raw.cosigned_at = null; raw.cosignature_hash = null; }
          if (db.one(`SELECT 1 FROM tombstones WHERE table_name=? AND id=? AND deleted_at > ?`, t.name, raw.id, incomingAt)) return false; // deleted on server after device edit
          // A user id minted on the device means nothing here, so it becomes the syncing user.
          for (const c of SYNC.user_ref_cols) if (existingCols.includes(c) && raw[c] && !knownUsers.has(raw[c])) raw[c] = user.id;
          // A client that arrives with no creator was created by whoever is sending it (POST /api/clients
          // records the same); isSelfAssignment above relies on it.
          if (t.name === 'clients' && !existing && !raw.created_by) raw.created_by = user.id;
          const o = importRow(t, raw, existingCols);
          if (t.name === 'clients') o.client_code = freeClientCode(o.client_code, raw.id);
          // Stamped in server time so every other device's next incremental pull picks the row up.
          if (existingCols.includes('updated_at')) o.updated_at = db.now();
          const keys = Object.keys(o).filter(k => k !== 'id');
          if (existing) {
            // Last write wins at row granularity, so a device's edit can quietly revert a field someone
            // changed at the office. It still wins — that is the rule — but it no longer does so silently:
            // the columns it replaced are recorded, by name only, never their values.
            const overwritten = keys.filter(k => !['updated_at', 'created_at'].includes(k) && String(existing[k] ?? '') !== String(o[k] ?? ''));
            if (overwritten.length) {
              audit.log({ user, action: 'sync.overwrite', entity: t.name, entityId: raw.id, clientId: t.clientCol ? raw[t.clientCol] : null, ip: 'device',
                details: { columns: overwritten, server_had: existing.updated_at, device_sent: incomingAt } });
            }
            db.run(`UPDATE ${t.name} SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map(k => o[k]), raw.id);
          }
          else db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
          // A row that comes back after being deleted must not leave its tombstone behind, or the two
          // tables disagree and other devices are told to delete a row that is alive here.
          db.run(`DELETE FROM tombstones WHERE table_name=? AND id=?`, t.name, raw.id);
          // The office's own auto-assignment for a client created in the field — unless the device is sending
          // the one it made, in which case that row is the assignment and a second would be a duplicate.
          if (t.name === 'clients' && !existing && auth.caseloadRestricted(user) && !(pushedSelfAssignments.get(raw.id))) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), raw.id, user.id, 'primary', (raw.intake_date || db.now()).slice(0, 10), user.id);
          // A visit that handed out kits or strips draws down the office shelf count exactly as the REST
          // route does — by the difference from what the office already had, so a re-sent row counts once.
          if (t.name === 'interventions') {
            const supplies = require('./supplies');
            const counts = { id: raw.id };
            for (const c of Object.keys(supplies.DRAWDOWN)) counts[c] = o[c] !== undefined ? o[c] : (existing ? existing[c] : 0);
            supplies.drawDown({ user, ip: 'device' }, counts, existing);
          }
          // A person entered on a phone may already be on the office books under another spelling. The row
          // still lands (the worker cannot check from the field), but a supervisor is told to look.
          if (t.name === 'clients' && !existing) flagPossibleDuplicate(user, raw, o.client_code, warnings);
          return true;
        }, (err) => {
          // A constraint violation is this row's problem, not the batch's.
          reject(t.name, raw.id, describeError(err));
        });
        if (ok === true) n++;
        // A merged-away client is the one rejection its children do not inherit: they are re-pointed at
        // the record that was kept and applied on their own merits.
        const last = rejected.length ? rejected[rejected.length - 1] : null;
        if (ok === undefined || (ok === false && last && last.id === raw.id && last.table === t.name)) { if (last.reason !== 'merged into another record') rejectedIds.set(`${t.name}:${raw.id}`, last.permanent); }
      }
      applied[t.name] = n;
    }

    for (const ts of payload.tombstones || []) {
      const t = SYNC.tables.find(x => x.name === ts.table_name); if (!t || t.name === 'users' || typeof ts.id !== 'string') continue;
      ts.deleted_at = shift(ts.deleted_at);
      if (t.serverOwned) { reject(t.name, ts.id, 'server-owned'); continue; }
      if (t.writePerm && !auth.hasPerm(user, t.writePerm)) { reject(t.name, ts.id, `your role cannot delete ${t.name}`); continue; }
      const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, ts.id);
      if (!existing) continue;
      if (t.name === 'clients' || t.name === 'notes' || t.name === 'consents' || t.name === 'disclosures' || t.name === 'note_addenda') continue; // never hard-deleted through sync (legal record)
      const clientId = t.clientCol ? existing[t.clientCol] : null;
      if (clientId && !auth.canAccessClient(user, clientId)) { reject(t.name, ts.id, 'not on caseload'); continue; }
      if (t.scope === 'all' && !auth.hasPerm(user, 'clients:all')) continue; // shared reference data is not deleted from devices
      if (t.name === 'expenditures' && existing.status !== 'pending') continue;
      if ((existing.updated_at || existing.created_at || NEVER) < ts.deleted_at) {
        db.savepoint(() => { db.run(`DELETE FROM ${t.name} WHERE id=?`, ts.id); db.tombstone(t.name, ts.id); }, (err) => reject(t.name, ts.id, describeError(err)));
      }
    }

    // A device's audit rows are its own record of what its user did; they are re-logged here under that
    // user, with the device's free-text details kept but bounded so a device cannot write arbitrary
    // structure (or PHI) into the office audit trail.
    const auditRows = (payload.audit || []).slice(0, 5000);
    for (const a of auditRows) {
      if (!a || !a.action) continue;
      db.savepoint(() => audit.log({ user, action: `device.${String(a.action).slice(0, 80)}`, entity: a.entity ? String(a.entity).slice(0, 60) : undefined, entityId: a.entity_id, clientId: a.client_id, ip: 'device', success: a.success !== 0, details: { at: a.at, device: true, ...sanitiseDetails(a.details) } }), () => {});
    }
    applied._audit = auditRows.length;
  });
  return { applied, rejected, conflicts, warnings, server_now: db.now(), clock_offset_ms: offsetMs, audit_accepted: applied._audit || 0 };
}

/**
 * A client created on a device that matches an existing record by the same rules as the intake form's
 * duplicate check. There is no way to ask the worker in the field, so the row is accepted, audited (codes
 * and reasons only, never names) and a task is raised for a supervisor to compare the two.
 */
function flagPossibleDuplicate(user, raw, clientCode, warnings) {
  let matches = [];
  try {
    matches = require('./clients').possibleDuplicates({ first_name: raw.first_name_enc, last_name: raw.last_name_enc, dob: raw.dob_enc, phone: raw.phone_enc }, raw.id);
  } catch { return; }
  if (!matches.length) return;
  const codes = matches.map(m => m.client_code);
  audit.log({ user, action: 'client.possible_duplicate', entity: 'client', entityId: raw.id, clientId: raw.id, ip: 'device', details: { client_code: clientCode, matches: matches.map(m => ({ id: m.id, client_code: m.client_code, reasons: m.reasons })), source: 'sync' } });
  db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,priority) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), raw.id, null, user.id, encrypt(`Possible duplicate record: compare ${clientCode} with ${codes.join(', ')}`), 'high');
  warnings.push({ table: 'clients', id: raw.id, reason: `possible duplicate of ${codes.length} existing record${codes.length === 1 ? '' : 's'} (${codes.join(', ')}); a supervisor has been asked to check` });
}

/** Find a client code no other client is using. Devices generate codes offline, so collisions are normal. */
function freeClientCode(code, id) {
  let candidate = code || 'M00-0000';
  for (let i = 0; i < 100; i++) {
    const clash = db.one(`SELECT id FROM clients WHERE client_code=? AND id<>?`, candidate, id);
    if (!clash) return candidate;
    candidate = `${code}-D${i + 2}`;
  }
  return `${code}-${id.slice(0, 8)}`;
}

/** A short, non-PHI reason a row could not be applied. SQLite messages name columns, never values. */
function describeError(err) {
  const m = String(err && err.message || 'could not be applied');
  if (/FOREIGN KEY/i.test(m)) return 'refers to a record the office server does not have';
  if (/UNIQUE/i.test(m)) return 'conflicts with an existing record';
  if (/NOT NULL/i.test(m)) return 'is missing a required field';
  if (/CHECK constraint/i.test(m)) return 'has a value the office does not accept';
  return m.slice(0, 200);
}

/** Device-supplied audit detail: parsed if it is JSON, flattened to short scalars either way. */
function sanitiseDetails(d) {
  let o = d;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return { note: o.slice(0, 200) }; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 20)) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[String(k).slice(0, 40)] = v;
    else if (typeof v === 'string') out[String(k).slice(0, 40)] = v.slice(0, 200);
  }
  return out;
}

// Local mode switched off (LOCAL_MODE_ENABLED, or the setup wizard's answer in server.json) has to mean
// no device copies at all — the same setting that stops /?local=1 and /local/kernel.js being served
// (server/app.js). Without this a copy made before the switch, or a static-site build, went on pulling and
// pushing PHI after the office had said no. The kernel itself (config.local) is never refused its own routes.
function requireLocalMode() {
  const config = require('../config');
  if (!config.localModeEnabled && !config.local) throw forbidden('Local mode (offline copies on devices) is turned off on this server, so devices cannot sync. An administrator can turn it on in the server settings (LOCAL_MODE_ENABLED, or the setup answer saved in server.json).');
}

module.exports = (r) => {
  r.get('/api/sync/pull', requireLocalMode, auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:read')) throw forbidden('Your role cannot sync client data');
    const since = ctx.query.get('since') || NEVER;
    const limit = Math.min(Number(ctx.query.get('limit')) || PULL_LIMIT, PULL_LIMIT);
    const out = pull(ctx.user, since, { limit });
    audit.log({ user: ctx.user, action: 'sync.pull', ip: ctx.ip, details: { since, complete: out.complete, rows: Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]).filter(([, n]) => n)) } });
    return out;
  });

  r.post('/api/sync/push', requireLocalMode, auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:write')) throw forbidden('Your role cannot sync client data');
    if (!ctx.body || typeof ctx.body !== 'object') throw badRequest('JSON body required');
    const res = push(ctx.user, ctx.body);
    audit.log({ user: ctx.user, action: 'sync.push', ip: ctx.ip, details: { applied: res.applied, rejected: res.rejected.length } });
    return res;
  });

  // Blobs (photos, template files, form attachments) are kept out of the sync payload and fetched by id.
  r.get('/api/sync/blob/:table/:id/:column', requireLocalMode, auth.requireAuth, (ctx) => {
    const t = SYNC.tables.find(x => x.name === ctx.params.table && (x.blob || []).includes(ctx.params.column));
    if (!t) throw badRequest('Not a synchronised attachment');
    if (t.writePerm && !auth.hasPerm(ctx.user, t.writePerm.replace(/:(write|manage)$/, ':read')) && !auth.hasPerm(ctx.user, t.writePerm)) throw forbidden('You cannot read this attachment');
    const row = db.one(`SELECT * FROM ${t.name} WHERE id=?`, ctx.params.id);
    if (!row) throw require('../http').notFound();
    if (t.clientCol && row[t.clientCol]) auth.assertClientAccess(ctx, row[t.clientCol]);
    const value = row[ctx.params.column];
    // Encrypted attachments are re-encrypted by the receiver, exactly as the row payload is.
    const out = t.enc.includes(ctx.params.column) && value ? decrypt(value) : value;
    audit.log({ user: ctx.user, action: 'sync.blob', entity: t.name, entityId: row.id, clientId: t.clientCol ? row[t.clientCol] : null, ip: ctx.ip });
    return { table: t.name, id: row.id, column: ctx.params.column, value: out, updated_at: row.updated_at };
  });

  // The other direction: a device uploading an attachment it captured offline, one at a time so a large
  // one cannot wedge the whole push.
  r.post('/api/sync/blob/:table/:id/:column', requireLocalMode, auth.requireAuth, (ctx) => {
    const t = SYNC.tables.find(x => x.name === ctx.params.table && (x.blob || []).includes(ctx.params.column));
    if (!t) throw badRequest('Not a synchronised attachment');
    if (t.writePerm && !auth.hasPerm(ctx.user, t.writePerm)) throw forbidden('You cannot upload this attachment');
    const row = db.one(`SELECT * FROM ${t.name} WHERE id=?`, ctx.params.id);
    if (!row) throw require('../http').notFound('Upload the record before its attachment');
    if (t.clientCol && row[t.clientCol]) auth.assertClientAccess(ctx, row[t.clientCol]);
    const value = ctx.body && ctx.body.value;
    if (typeof value !== 'string' || !value) throw badRequest('value is required');
    const stored = t.enc.includes(ctx.params.column) ? encrypt(value) : value;
    db.run(`UPDATE ${t.name} SET ${ctx.params.column}=?, updated_at=? WHERE id=?`, stored, db.now(), row.id);
    audit.log({ user: ctx.user, action: 'sync.blob.upload', entity: t.name, entityId: row.id, clientId: t.clientCol ? row[t.clientCol] : null, ip: ctx.ip, details: { bytes: value.length } });
    return { ok: true };
  });
};
module.exports.pull = pull; module.exports.push = push;
