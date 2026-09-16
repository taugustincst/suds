// Device-side sync runner (bundled into the local kernel). Talks to the office server's /api/sync routes.
import db from '../server/db.js';
import auth from '../server/auth.js';
import audit from '../server/audit.js';
import { HttpError } from '../server/http.js';
import { encrypt, decrypt, blindIndex, uuid } from '../server/crypto.js';
import SYNC from '../server/sync-tables.js';

const NEVER = '1970-01-01T00:00:00.000Z';
// sync_seen records each row exactly as last exchanged with the server (table, id, updated_at); a row is only
// uploaded when it no longer matches, so pulled rows are never echoed back and device clocks do not matter.
export function ensureTables() { db.get().exec(`CREATE TABLE IF NOT EXISTS sync_seen (table_name TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (table_name, id))`); }
const seen = (t, id, at) => db.run(`INSERT OR REPLACE INTO sync_seen(table_name,id,updated_at) VALUES(?,?,?)`, t, id, at || null);
const cols = (t) => db.all(`PRAGMA table_info(${t})`).map(c => c.name);

function exportRow(t, r) { const o = { ...r }; for (const c of t.enc) if (o[c]) { try { o[c] = decrypt(o[c]); } catch { o[c] = null; } } for (const k of Object.keys(o)) if (k.endsWith('_idx')) delete o[k]; return o; }
function importRow(t, r, existingCols) {
  const o = {}; for (const [k, v] of Object.entries(r)) if (existingCols.includes(k) && !k.endsWith('_idx')) o[k] = v;
  for (const c of t.enc) if (o[c] !== undefined && o[c] !== null) o[c] = encrypt(o[c]);
  if (t.name === 'clients') { const fn = r.first_name_enc || '', ln = r.last_name_enc || ''; o.last_name_idx = blindIndex(ln); o.full_name_idx = blindIndex(ln + fn); o.dob_idx = blindIndex(r.dob_enc || ''); o.phone_idx = blindIndex(String(r.phone_enc || '').replace(/\D/g, '')); }
  return o;
}
// Columns that reference users.id across the schema (for merging a device account into the office account)
const USER_REFS = [['clients', 'created_by'], ['assignments', 'user_id'], ['assignments', 'created_by'], ['interventions', 'user_id'], ['calls', 'user_id'], ['time_entries', 'user_id'], ['referrals', 'user_id'], ['tasks', 'assigned_to'], ['tasks', 'created_by'], ['expenditures', 'user_id'], ['expenditures', 'approved_by'], ['notes', 'author_id'], ['notes', 'signed_by'], ['note_addenda', 'author_id'], ['consents', 'created_by'], ['disclosures', 'disclosed_by'], ['imports', 'imported_by'], ['audit_log', 'user_id'], ['sessions', 'user_id'], ['user_prefs', 'user_id'], ['api_keys', 'created_by']];
function mergeUser(localId, serverId) {
  for (const [t, c] of USER_REFS) db.run(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`, serverId, localId);
  db.run(`DELETE FROM users WHERE id=?`, localId);
}
// Apply server rows locally: server wins on equal timestamps; users are replaced wholesale (credentials for offline login).
function applyPull(payload) {
  const counts = {};
  // Server timestamps are authoritative; local rows carry device time. Compare in server time using the measured offset.
  const offset = payload.server_now ? Date.parse(payload.server_now) - Date.now() : 0;
  const toServer = (ts) => { const t = Date.parse(ts || NEVER); return Number.isFinite(t) ? new Date(t + offset).toISOString() : NEVER; };
  db.setSetting('sync_clock_offset_ms', String(offset));
  db.transaction(() => {
    for (const t of SYNC.tables) {
      const rows = payload.tables?.[t.name] || []; const existingCols = cols(t.name); let n = 0;
      for (const raw of rows) {
        let existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, raw.id);
        if (t.name === 'users' && !existing) { const same = db.one(`SELECT id FROM users WHERE username=?`, raw.username); if (same) mergeUser(same.id, raw.id); }
        if (t.name === 'clients') { const clash = db.one(`SELECT id FROM clients WHERE client_code=? AND id<>?`, raw.client_code, raw.id); if (clash) db.run(`UPDATE clients SET client_code=?, updated_at=? WHERE id=?`, raw.client_code + '-D', db.now(), clash.id); }
        const incomingAt = raw.updated_at || raw.created_at || NEVER;
        if (existing && t.name !== 'users' && toServer(existing.updated_at || existing.created_at) > incomingAt) continue; // local edit is newer (in server time); it will be pushed
        const o = importRow(t, raw, existingCols); const keys = Object.keys(o).filter(k => k !== 'id');
        if (existing) db.run(`UPDATE ${t.name} SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map(k => o[k]), raw.id);
        else db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
        seen(t.name, raw.id, o.updated_at || o.created_at || null);
        n++;
      }
      counts[t.name] = n;
    }
    for (const ts of payload.tombstones || []) { const t = SYNC.tables.find(x => x.name === ts.table_name); if (!t) continue; const localDeleted = new Date(Date.parse(ts.deleted_at) - offset).toISOString(); db.run(`DELETE FROM ${t.name} WHERE id=? AND COALESCE(updated_at, created_at) < ?`, ts.id, localDeleted); db.run(`INSERT OR REPLACE INTO tombstones(table_name,id,deleted_at) VALUES(?,?,?)`, t.name, ts.id, ts.deleted_at); }
    for (const [k, v] of Object.entries(payload.settings || {})) if (v !== null && v !== undefined) db.setSetting(k, v);
  });
  return counts;
}
function localChanges(since) {
  const tables = {};
  for (const t of SYNC.tables) { if (t.name === 'users') continue; const rows = db.all(`SELECT x.* FROM ${t.name} x WHERE NOT EXISTS (SELECT 1 FROM sync_seen s WHERE s.table_name=? AND s.id=x.id AND s.updated_at IS COALESCE(x.updated_at, x.created_at))`, t.name); if (rows.length) tables[t.name] = rows.map(r => exportRow(t, r)); }
  const tombstones = db.all(`SELECT table_name, id, deleted_at FROM tombstones WHERE deleted_at > ?`, since);
  const auditRows = db.all(`SELECT at, action, entity, entity_id, client_id, success, details FROM audit_log WHERE at > ? AND action NOT LIKE 'sync.%' ORDER BY id LIMIT 5000`, since);
  return { tables, tombstones, audit: auditRows, device_now: db.now() };
}

async function call(server, path, opts = {}, token) {
  const res = await fetch(server.replace(/\/$/, '') + path, { ...opts, credentials: 'omit', headers: { 'Content-Type': 'application/json', 'X-Sync-Client': '1', 'X-Requested-With': 'suds', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
  const ct = res.headers.get('content-type') || ''; const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error((data && data.error) || `Server returned ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
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
    const since = db.getSetting('sync_cursor', NEVER);
    onProgress('Downloading changes from the office…');
    const pulled = await call(server, `/api/sync/pull?since=${encodeURIComponent(since)}`, {}, token);
    const applied = applyPull(pulled);
    onProgress('Uploading this device\'s changes…');
    const changes = localChanges(db.getSetting('sync_pushed', NEVER));
    const pushed = await call(server, '/api/sync/push', { method: 'POST', body: JSON.stringify(changes) }, token);
    const rejectedIds = new Set((pushed.rejected || []).map(r => r.table + ':' + r.id));
    db.transaction(() => { for (const [t, rows] of Object.entries(changes.tables)) for (const r of rows) if (!rejectedIds.has(t + ':' + r.id)) seen(t, r.id, r.updated_at || r.created_at || null); db.run(`DELETE FROM tombstones WHERE deleted_at <= ?`, changes.device_now); });
    db.setSetting('sync_cursor', pulled.cursor); db.setSetting('sync_pushed', db.now()); db.setSetting('last_sync_at', db.now()); db.setSetting('sync_server', server); db.setSetting('sync_username', username);
    audit.log({ user: { username }, action: 'sync.completed', details: { server, pulled: applied, pushed: pushed.applied, rejected: pushed.rejected?.length || 0 } });
    return { ok: true, pulled: applied, pushed: pushed.applied, rejected: pushed.rejected || [], at: db.now() };
  } finally { try { await call(server, '/api/auth/logout', { method: 'POST', body: '{}' }, token); } catch {} }
}

export function register(router) {
  ensureTables();
  router.post('/api/local/sync', auth.requireAuth, async (ctx) => {
    const { server, username, password, code } = ctx.body || {};
    return run({ server, username: username || ctx.user.username, password, code });
  });
  router.get('/api/local/sync/status', auth.requireAuth, () => ({ last_sync_at: db.getSetting('last_sync_at', null), server: db.getSetting('sync_server', null), username: db.getSetting('sync_username', null),
    pending: SYNC.tables.filter(t => t.name !== 'users').reduce((n, t) => n + db.one(`SELECT COUNT(*) n FROM ${t.name} WHERE COALESCE(updated_at, created_at) > ?`, db.getSetting('sync_pushed', NEVER)).n, 0) }));
}
