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

const NEVER = '1970-01-01T00:00:00.000Z';
// Well under the server's body limit, leaving room for JSON overhead.
const PUSH_BYTES = 4 * 1024 * 1024;
// Attachments fetched per sync, so a first sync is not held up by every photo in the directory.
const BLOBS_PER_SYNC = 25;

export function ensureTables() { db.get().exec(`CREATE TABLE IF NOT EXISTS sync_seen (table_name TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (table_name, id))`); }
const seen = (t, id, at) => db.run(`INSERT OR REPLACE INTO sync_seen(table_name,id,updated_at) VALUES(?,?,?)`, t, id, at || null);
const seenAt = (t, id) => db.one(`SELECT updated_at FROM sync_seen WHERE table_name=? AND id=?`, t, id)?.updated_at ?? undefined;
const cols = (t) => db.all(`PRAGMA table_info(${t})`).map(c => c.name);
const stamp = (row) => row.updated_at || row.created_at || null;

function exportRow(t, r) {
  const o = { ...r };
  for (const c of t.enc) {
    if (!o[c]) continue;
    try { o[c] = decrypt(o[c]); }
    catch { return null; } // undecryptable here would arrive as null and break a NOT NULL column there
  }
  for (const k of Object.keys(o)) if (k.endsWith('_idx')) delete o[k];
  for (const c of t.blob || []) delete o[c];
  if (t.name === 'users') { delete o.failed_attempts; delete o.locked_until; }
  return o;
}

function importRow(t, r, existingCols) {
  const o = {};
  for (const [k, v] of Object.entries(r)) if (existingCols.includes(k) && !k.endsWith('_idx') && v !== undefined) o[k] = v;
  for (const c of t.enc) if (o[c] !== undefined && o[c] !== null) o[c] = encrypt(o[c]);
  if (t.name === 'clients') {
    if (r.last_name_enc !== undefined) o.last_name_idx = blindIndex(r.last_name_enc || '');
    if (r.last_name_enc !== undefined || r.first_name_enc !== undefined) o.full_name_idx = blindIndex((r.last_name_enc || '') + (r.first_name_enc || ''));
    if (r.dob_enc !== undefined) o.dob_idx = blindIndex(r.dob_enc || '');
    if (r.phone_enc !== undefined) o.phone_idx = blindIndex(String(r.phone_enc || '').replace(/\D/g, ''));
  }
  return o;
}

// Every column that points at users(id), shared with the server so the two lists cannot drift apart.
function mergeUser(localId, serverId) {
  for (const [t, c] of SYNC.user_refs) {
    if (!db.one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t)) continue;
    if (!cols(t).includes(c)) continue;
    db.run(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`, serverId, localId);
  }
  db.run(`DELETE FROM users WHERE id=?`, localId);
}

/**
 * Apply server rows locally.
 *  - untouched since the last exchange (matches sync_seen) → the server's copy wins, no clock involved
 *  - edited here since then → keep ours only if our edit is newer once converted to server time
 */
function applyPull(payload) {
  const counts = {};
  const offset = payload.server_now ? Date.parse(payload.server_now) - Date.now() : 0;
  const toServer = (ts) => { const t = Date.parse(ts || NEVER); return Number.isFinite(t) ? new Date(t + offset).toISOString() : NEVER; };
  db.setSetting('sync_clock_offset_ms', String(offset));
  db.transaction(() => {
    for (const t of SYNC.tables) {
      const rows = payload.tables?.[t.name] || []; const existingCols = cols(t.name); let n = 0;
      for (const raw of rows) {
        const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, raw.id);
        if (t.name === 'users' && !existing) { const same = db.one(`SELECT id FROM users WHERE username=?`, raw.username); if (same) mergeUser(same.id, raw.id); }
        if (t.name === 'clients') { const clash = db.one(`SELECT id FROM clients WHERE client_code=? AND id<>?`, raw.client_code, raw.id); if (clash) db.run(`UPDATE clients SET client_code=?, updated_at=? WHERE id=?`, raw.client_code + '-D', db.now(), clash.id); }
        if (existing && t.name !== 'users') {
          const known = seenAt(t.name, existing.id);
          const untouched = known !== undefined && known === stamp(existing);
          if (!untouched && toServer(stamp(existing)) > (raw.updated_at || raw.created_at || NEVER)) continue; // our edit is newer; it gets pushed
        }
        const o = importRow(t, raw, existingCols); const keys = Object.keys(o).filter(k => k !== 'id');
        if (existing) db.run(`UPDATE ${t.name} SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map(k => o[k]), raw.id);
        else db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
        seen(t.name, raw.id, stamp(o));
        n++;
      }
      counts[t.name] = (counts[t.name] || 0) + n;
    }
    for (const ts of payload.tombstones || []) {
      const t = SYNC.tables.find(x => x.name === ts.table_name); if (!t) continue;
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
    }
    for (const [k, v] of Object.entries(payload.settings || {})) if (v !== null && v !== undefined) db.setSetting(k, v);
  });
  return counts;
}

/** Rows this device has that the office has not seen in their current state. */
function localRows() {
  const out = [];
  for (const t of SYNC.tables) {
    if (t.name === 'users') continue;
    const rows = db.all(`SELECT x.* FROM ${t.name} x WHERE NOT EXISTS (SELECT 1 FROM sync_seen s WHERE s.table_name=? AND s.id=x.id AND s.updated_at IS COALESCE(x.updated_at, x.created_at))`, t.name);
    for (const r of rows) { const e = exportRow(t, r); if (e) out.push({ table: t.name, row: e }); }
  }
  return out;
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
  const res = await fetch(server.replace(/\/$/, '') + path, { ...opts, credentials: 'omit', headers: { 'Content-Type': 'application/json', 'X-Sync-Client': '1', 'X-Requested-With': 'suds', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
  const ct = res.headers.get('content-type') || ''; const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error((data && data.error) || `Server returned ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

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
        const key = `sync_blob:${t.name}:${r.id}:${col}`;
        if (db.getSetting(key, null)) continue;
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

/** Full sync: sign in to the office server, pull changes, push local changes, record the cursor. */
export async function run({ server, username, password, code, onProgress = () => {} }) {
  if (!server) throw new HttpError(400, 'Office server address is required');
  onProgress('Signing in to the office server…');
  const login = await call(server, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  const token = login.token; if (!token) throw new HttpError(400, 'The office server did not return a sync token (update the server to 1.1 or newer)');
  if (login.mfaPending) { if (!code) throw new HttpError(401, 'MFA code required', { mfaRequired: true }); await call(server, '/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code }) }, token); }
  try {
    const demo = require('../server/demo.js');
    if (demo.status().loaded) { onProgress('Removing sample data before the first sync…'); demo.remove({ actor: null, tombstones: false }); }

    // ---- pull, page by page ----
    let since = db.getSetting('sync_cursor', NEVER);
    const applied = {}; let pages = 0; let serverNow = null;
    for (;;) {
      onProgress(pages ? `Downloading changes from the office (page ${pages + 1})…` : 'Downloading changes from the office…');
      const pulled = await call(server, `/api/sync/pull?since=${encodeURIComponent(since)}`, {}, token);
      if (pulled.full_resync_required) {
        // This device has been away longer than deletions are kept, so it cannot be brought up to date
        // incrementally without silently keeping rows the office has dropped. Start over from NEVER.
        onProgress('This device has been offline a long time; rebuilding from the office copy…');
        db.run(`DELETE FROM sync_seen`);
        since = NEVER;
        db.setSetting('sync_cursor', NEVER);
        if (pages > 20) throw new HttpError(409, pulled.reason || 'This device needs to be set up again from the office server');
        pages++;
        continue;
      }
      const counts = applyPull(pulled);
      for (const [k, v] of Object.entries(counts)) applied[k] = (applied[k] || 0) + v;
      serverNow = pulled.server_now;
      since = pulled.cursor;
      db.setSetting('sync_cursor', since);
      pages++;
      if (pulled.complete || pages > 200) break;
    }

    // ---- push, in chunks ----
    onProgress('Uploading this device\'s changes…');
    const deviceNow = db.now();
    const pending = localRows();
    const chunks = chunkRows(pending);
    const pushedCounts = {}; const rejected = [];
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) onProgress(`Uploading this device's changes (${i + 1} of ${chunks.length})…`);
      const res = await call(server, '/api/sync/push', { method: 'POST', body: JSON.stringify({ device_now: deviceNow, tables: chunks[i] }) }, token);
      const rejectedIds = new Set((res.rejected || []).map(x => x.table + ':' + x.id));
      rejected.push(...(res.rejected || []));
      for (const [k, v] of Object.entries(res.applied || {})) if (typeof v === 'number') pushedCounts[k] = (pushedCounts[k] || 0) + v;
      // A row counts as exchanged only if the office did not reject it.
      db.transaction(() => {
        for (const [table, rows] of Object.entries(chunks[i])) for (const r of rows) if (!rejectedIds.has(table + ':' + r.id)) seen(table, r.id, stamp(r));
      });
    }

    // ---- tombstones and this device's audit trail ----
    const tombstones = db.all(`SELECT table_name, id, deleted_at FROM tombstones WHERE deleted_at > ?`, db.getSetting('sync_pushed', NEVER));
    const auditRows = db.all(`SELECT at, action, entity, entity_id, client_id, success, details FROM audit_log WHERE at > ? AND action NOT LIKE 'sync.%' ORDER BY at, id LIMIT 2000`, db.getSetting('audit_pushed', NEVER));
    if (tombstones.length || auditRows.length) {
      const res = await call(server, '/api/sync/push', { method: 'POST', body: JSON.stringify({ device_now: deviceNow, tombstones, audit: auditRows }) }, token);
      const rejectedIds = new Set((res.rejected || []).map(x => x.table + ':' + x.id));
      rejected.push(...(res.rejected || []));
      db.transaction(() => {
        // Only forget the tombstones the office actually accepted; a rejected delete stays pending so the
        // device does not end up silently diverging from the office copy.
        for (const ts of tombstones) if (!rejectedIds.has(ts.table_name + ':' + ts.id)) db.run(`DELETE FROM tombstones WHERE table_name=? AND id=?`, ts.table_name, ts.id);
      });
      db.setSetting('sync_pushed', deviceNow);
      // Advance the audit cursor only past rows that were actually sent, never to "now" — anything above
      // the page limit has to go next time rather than being dropped.
      if (auditRows.length) db.setSetting('audit_pushed', auditRows[auditRows.length - 1].at);
    } else {
      db.setSetting('sync_pushed', deviceNow);
    }

    // ---- attachments ----
    const uploaded = await uploadBlobs(server, token, onProgress);
    const downloaded = await fetchBlobs(server, token, onProgress);

    db.setSetting('last_sync_at', db.now()); db.setSetting('sync_server', server); db.setSetting('sync_username', username);
    audit.log({ user: { username }, action: 'sync.completed', details: { server, pulled: applied, pushed: pushedCounts, rejected: rejected.length, attachments_up: uploaded, attachments_down: downloaded } });
    return { ok: true, pulled: applied, pushed: pushedCounts, rejected, attachments: { uploaded, downloaded }, at: db.now() };
  } finally { try { await call(server, '/api/auth/logout', { method: 'POST', body: '{}' }, token); } catch {} }
}

export function register(router) {
  ensureTables();
  router.post('/api/local/sync', auth.requireAuth, async (ctx) => {
    const { server, username, password, code } = ctx.body || {};
    return run({ server, username: username || ctx.user.username, password, code });
  });
  router.get('/api/local/sync/status', auth.requireAuth, () => ({ last_sync_at: db.getSetting('last_sync_at', null), server: db.getSetting('sync_server', null), username: db.getSetting('sync_username', null),
    pending: localRows().length }));
}
