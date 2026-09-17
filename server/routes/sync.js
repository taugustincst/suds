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

const NEVER = '1970-01-01T00:00:00.000Z';
// One pull answers with at most this many rows per table. Beyond that the device is told to come back for
// more, so a first sync of a large county is many small responses instead of one that cannot be parsed.
const PULL_LIMIT = 2000;

function cols(table) { return db.all(`PRAGMA table_info(${table})`).map(c => c.name); }

/**
 * Decrypt a row for transport. Returns null if a column that must not be null could not be decrypted —
 * emitting null for a NOT NULL column would fail the receiver's insert and take the whole batch with it.
 * The usual cause is a device whose encryption key was cleared while its database survived.
 */
function exportRow(t, r) {
  const o = { ...r };
  for (const c of t.enc) {
    if (!o[c]) continue;
    try { o[c] = decrypt(o[c]); }
    catch { return null; }
  }
  for (const k of Object.keys(o)) if (k.endsWith('_idx')) delete o[k];
  // Large binary columns do not belong in a sync payload; they are fetched by id when the device needs them.
  for (const c of t.blob || []) delete o[c];
  if (t.name === 'users') { delete o.failed_attempts; delete o.locked_until; }
  return o;
}

function importRow(t, r, existingCols) {
  const o = {};
  for (const [k, v] of Object.entries(r)) if (existingCols.includes(k) && !k.endsWith('_idx') && v !== undefined) o[k] = v;
  for (const c of t.enc) if (o[c] !== undefined && o[c] !== null) o[c] = encrypt(o[c]);
  if (t.name === 'clients') {
    // Only recompute an index when the plaintext it is derived from was actually sent. Recomputing from a
    // missing field would quietly replace a working blind index with the hash of an empty string.
    if (r.last_name_enc !== undefined) o.last_name_idx = blindIndex(r.last_name_enc || '');
    if (r.last_name_enc !== undefined || r.first_name_enc !== undefined) o.full_name_idx = blindIndex((r.last_name_enc || '') + (r.first_name_enc || ''));
    if (r.dob_enc !== undefined) o.dob_idx = blindIndex(r.dob_enc || '');
    if (r.phone_enc !== undefined) o.phone_idx = blindIndex(String(r.phone_enc || '').replace(/\D/g, ''));
  }
  return o;
}

function scopeSql(t, user, alias) {
  const cf = auth.caseloadFilter(user, `${alias}.${t.clientCol}`);
  if (t.scope === 'all' || t.scope === 'users') return { sql: '1=1', params: [] };
  if (t.scope === 'via-note') { const nf = auth.caseloadFilter(user, 'n.client_id'); return { sql: `${alias}.note_id IN (SELECT n.id FROM notes n WHERE ${nf.sql})`, params: nf.params }; }
  if (t.scope === 'client-or-null') return { sql: `(${alias}.${t.clientCol} IS NULL OR ${cf.sql})`, params: cf.params };
  return cf;
}

// Pull everything changed since `since` that the user may see, in bounded pages.
function pull(user, since, { limit = PULL_LIMIT } = {}) {
  const serverNow = db.now();
  const raw = {}; const capped = [];
  for (const t of SYNC.tables) {
    const sc = scopeSql(t, user, 'x');
    // updated_at is NOT NULL on every synced table (migration 5) and indexed, so this is a range scan
    // rather than the full table scan a COALESCE would force.
    const rows = db.all(`SELECT x.* FROM ${t.name} x WHERE x.updated_at > ? AND ${sc.sql} ORDER BY x.updated_at LIMIT ?`, since, ...sc.params, limit + 1);
    if (rows.length > limit) { rows.length = limit; capped.push(rows[rows.length - 1].updated_at); }
    raw[t.name] = rows;
  }
  // If any table filled its page, stop every table at the same instant so the cursor stays a single point
  // in time; the device pulls again from there.
  const cursor = capped.length ? capped.reduce((a, b) => (a < b ? a : b)) : serverNow;
  const complete = capped.length === 0;

  const out = { cursor, server_now: serverNow, complete, tables: {}, tombstones: [], settings: {}, skipped: [] };
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
function push(user, payload) {
  const applied = {}; const rejected = [];
  const reject = (table, id, reason) => { rejected.push({ table, id, reason }); };
  const rejectedIds = new Set();

  // Device clocks are not trusted: shift the device's own bookkeeping timestamps by the measured offset so
  // last-write-wins compares in server time. Only created_at and updated_at are shifted — signed_at,
  // approved_at and the rest are clinical and legal facts, not sync metadata, and rewriting them would
  // silently edit the record every time a differently-skewed device synced.
  const deviceNow = payload.device_now ? Date.parse(payload.device_now) : NaN;
  const offsetMs = Number.isFinite(deviceNow) ? Date.now() - deviceNow : 0;
  const shift = (ts) => { if (!ts || !offsetMs) return ts; const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t + offsetMs).toISOString() : ts; };
  const TS_COLS = ['created_at', 'updated_at'];

  // One lookup instead of one per user-reference column per row.
  const knownUsers = new Set(db.all(`SELECT id FROM users`).map(u => u.id));

  db.transaction(() => {
    for (const t of SYNC.tables) {
      const rows = (payload.tables || {})[t.name]; if (!Array.isArray(rows) || !rows.length) continue;
      if (t.name === 'users') continue;
      // Syncing is not a way around a role's limits: the same permission the REST route requires applies here.
      if (t.writePerm && !auth.hasPerm(user, t.writePerm)) {
        for (const raw of rows) if (raw && typeof raw.id === 'string') reject(t.name, raw.id, `your role cannot write ${t.name}`);
        applied[t.name] = 0;
        continue;
      }
      const existingCols = cols(t.name); let n = 0;
      for (const raw of rows) {
        if (!raw || typeof raw.id !== 'string') continue;
        // A child whose parent was rejected has nothing to attach to; skipping it beats a constraint error.
        if (t.parent && raw[t.parent[1]] && rejectedIds.has(`${t.parent[0]}:${raw[t.parent[1]]}`)) { reject(t.name, raw.id, `its ${t.parent[0]} row was rejected`); rejectedIds.add(`${t.name}:${raw.id}`); continue; }

        const ok = db.savepoint(() => {
          for (const c of TS_COLS) if (raw[c]) raw[c] = shift(raw[c]);
          // Caseload scoping applies to everything that carries a client, including the tables where the
          // client is optional (calls, tasks, time, expenditures) — those were previously unchecked.
          if ((t.scope === 'client' || t.scope === 'client-or-null') && raw[t.clientCol] && t.name !== 'clients' && !auth.canAccessClient(user, raw[t.clientCol])) { reject(t.name, raw.id, 'not on caseload'); return false; }
          const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, raw.id);
          if (t.name === 'clients' && existing && !auth.canAccessClient(user, raw.id)) { reject(t.name, raw.id, 'not on caseload'); return false; }
          if (t.scope === 'via-note') { const note = db.one(`SELECT client_id, kind FROM notes WHERE id=?`, raw.note_id); if (!note || !auth.canAccessClient(user, note.client_id) || (note.kind === 'clinical' && !auth.hasPerm(user, 'notes:clinical:write'))) { reject(t.name, raw.id, 'not permitted'); return false; } }
          if (t.name === 'notes' && raw.kind === 'clinical' && !auth.hasPerm(user, 'notes:clinical:write')) { reject(t.name, raw.id, 'clinical notes not permitted for this role'); return false; }
          const incomingAt = raw.updated_at || raw.created_at || NEVER;
          if (existing && (existing.updated_at || existing.created_at || NEVER) >= incomingAt) return false; // server copy is newer or same
          // Records from a device are attributed to the syncing user unless they manage all clients
          const OWNER = { interventions: 'user_id', calls: 'user_id', time_entries: 'user_id', referrals: 'user_id', expenditures: 'user_id', notes: 'author_id' }[t.name];
          if (OWNER && !auth.hasPerm(user, 'clients:all')) { if (!existing) raw[OWNER] = user.id; else raw[OWNER] = existing[OWNER]; }
          if (t.name === 'expenditures') { if (!existing) { raw.status = 'pending'; raw.approved_by = null; raw.approved_at = null; } else if (!auth.hasPerm(user, 'budget:approve')) { raw.status = existing.status; raw.approved_by = existing.approved_by; raw.approved_at = existing.approved_at; } }
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
          const o = importRow(t, raw, existingCols);
          if (t.name === 'clients') o.client_code = freeClientCode(o.client_code, raw.id);
          const keys = Object.keys(o).filter(k => k !== 'id');
          if (existing) db.run(`UPDATE ${t.name} SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map(k => o[k]), raw.id);
          else db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
          // A row that comes back after being deleted must not leave its tombstone behind, or the two
          // tables disagree and other devices are told to delete a row that is alive here.
          db.run(`DELETE FROM tombstones WHERE table_name=? AND id=?`, t.name, raw.id);
          if (t.name === 'clients' && !existing && auth.caseloadRestricted(user)) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), raw.id, user.id, 'primary', (raw.intake_date || db.now()).slice(0, 10), user.id);
          return true;
        }, (err) => {
          // A constraint violation is this row's problem, not the batch's.
          reject(t.name, raw.id, describeError(err));
        });
        if (ok === true) n++;
        if (ok === undefined || (ok === false && rejected.length && rejected[rejected.length - 1].id === raw.id)) rejectedIds.add(`${t.name}:${raw.id}`);
      }
      applied[t.name] = n;
    }

    for (const ts of payload.tombstones || []) {
      const t = SYNC.tables.find(x => x.name === ts.table_name); if (!t || t.name === 'users' || typeof ts.id !== 'string') continue;
      ts.deleted_at = shift(ts.deleted_at);
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
  return { applied, rejected, server_now: db.now(), clock_offset_ms: offsetMs, audit_accepted: applied._audit || 0 };
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

module.exports = (r) => {
  r.get('/api/sync/pull', auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:read')) throw forbidden('Your role cannot sync client data');
    const since = ctx.query.get('since') || NEVER;
    const limit = Math.min(Number(ctx.query.get('limit')) || PULL_LIMIT, PULL_LIMIT);
    const out = pull(ctx.user, since, { limit });
    audit.log({ user: ctx.user, action: 'sync.pull', ip: ctx.ip, details: { since, complete: out.complete, rows: Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]).filter(([, n]) => n)) } });
    return out;
  });

  r.post('/api/sync/push', auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:write')) throw forbidden('Your role cannot sync client data');
    if (!ctx.body || typeof ctx.body !== 'object') throw badRequest('JSON body required');
    const res = push(ctx.user, ctx.body);
    audit.log({ user: ctx.user, action: 'sync.push', ip: ctx.ip, details: { applied: res.applied, rejected: res.rejected.length } });
    return res;
  });

  // Blobs (photos, template files, form attachments) are kept out of the sync payload and fetched by id.
  r.get('/api/sync/blob/:table/:id/:column', auth.requireAuth, (ctx) => {
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
  r.post('/api/sync/blob/:table/:id/:column', auth.requireAuth, (ctx) => {
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
