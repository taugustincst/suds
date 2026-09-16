'use strict';
// Device ↔ server synchronisation. The phone runs its own copy of SUDS (local kernel) and calls these routes
// on demand. Rows are identified by UUID; the newest updated_at wins; hard deletes travel as tombstones.
// PHI columns are decrypted for transport (over TLS, authenticated) and re-encrypted with the receiver's key.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, forbidden } = require('../http');
const { encrypt, decrypt, blindIndex } = require('../crypto');
const SYNC = require('../sync-tables');

const NEVER = '1970-01-01T00:00:00.000Z';
function cols(table) { return db.all(`PRAGMA table_info(${table})`).map(c => c.name); }
function exportRow(t, r) { const o = { ...r }; for (const c of t.enc) if (o[c]) { try { o[c] = decrypt(o[c]); } catch { o[c] = null; } } for (const k of Object.keys(o)) if (k.endsWith('_idx')) delete o[k]; if (t.name === 'users') { delete o.failed_attempts; delete o.locked_until; } return o; }
function importRow(t, r, existingCols) {
  const o = {};
  for (const [k, v] of Object.entries(r)) if (existingCols.includes(k) && !k.endsWith('_idx')) o[k] = v;
  for (const c of t.enc) if (o[c] !== undefined && o[c] !== null) o[c] = encrypt(o[c]);
  if (t.name === 'clients') { const fn = r.first_name_enc || '', ln = r.last_name_enc || ''; o.last_name_idx = blindIndex(ln); o.full_name_idx = blindIndex(ln + fn); o.dob_idx = blindIndex(r.dob_enc || ''); o.phone_idx = blindIndex(String(r.phone_enc || '').replace(/\D/g, '')); }
  return o;
}
function scopeSql(t, user, alias) {
  const cf = auth.caseloadFilter(user, `${alias}.${t.clientCol}`);
  if (t.scope === 'all' || t.scope === 'users') return { sql: '1=1', params: [] };
  if (t.scope === 'via-note') { const nf = auth.caseloadFilter(user, 'n.client_id'); return { sql: `${alias}.note_id IN (SELECT n.id FROM notes n WHERE ${nf.sql})`, params: nf.params }; }
  if (t.scope === 'client-or-null') return { sql: `(${alias}.${t.clientCol} IS NULL OR ${cf.sql})`, params: cf.params };
  return cf;
}

// Pull everything changed since `since` that the user may see.
function pull(user, since) {
  const out = { cursor: db.now(), tables: {}, tombstones: db.all(`SELECT table_name, id, deleted_at FROM tombstones WHERE deleted_at > ?`, since), settings: {} };
  for (const t of SYNC.tables) {
    const sc = scopeSql(t, user, 'x');
    const hasUpd = cols(t.name).includes('updated_at');
    let rows = db.all(`SELECT x.* FROM ${t.name} x WHERE COALESCE(x.updated_at, x.created_at) > ? AND ${sc.sql}`, since, ...sc.params);
    if (t.name === 'users') rows = rows.map(r => (r.id === user.id ? r : { ...r, password_hash: 'scrypt$0$0$0$AA==$AA==', mfa_secret_enc: null, mfa_enabled: 0 })); // other staff: identity only, no credentials
    out.tables[t.name] = rows.map(r => exportRow(t, r));
  }
  for (const k of SYNC.settings_keys) out.settings[k] = db.getSetting(k, null);
  return out;
}

// Apply rows from a device. Last write wins by updated_at; users are never overwritten from devices.
function push(user, payload) {
  const applied = {}; const rejected = [];
  db.transaction(() => {
    for (const t of SYNC.tables) {
      const rows = (payload.tables || {})[t.name]; if (!Array.isArray(rows) || !rows.length) continue;
      if (t.name === 'users') continue;
      const existingCols = cols(t.name); let n = 0;
      for (const raw of rows) {
        if (!raw || typeof raw.id !== 'string') continue;
        if (t.scope === 'client' && raw[t.clientCol] && !auth.canAccessClient(user, raw[t.clientCol]) && t.name !== 'clients') { rejected.push({ table: t.name, id: raw.id, reason: 'not on caseload' }); continue; }
        const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, raw.id);
        const incomingAt = raw.updated_at || raw.created_at || NEVER;
        if (existing && (existing.updated_at || existing.created_at || NEVER) >= incomingAt) continue; // server copy is newer or same
        if (db.one(`SELECT 1 FROM tombstones WHERE table_name=? AND id=? AND deleted_at > ?`, t.name, raw.id, incomingAt)) continue; // deleted on server after device edit
        const o = importRow(t, raw, existingCols);
        if (t.name === 'clients' && !existing) { if (db.one(`SELECT 1 FROM clients WHERE client_code=?`, o.client_code)) o.client_code = o.client_code + '-D'; }
        const keys = Object.keys(o).filter(k => k !== 'id');
        if (existing) db.run(`UPDATE ${t.name} SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map(k => o[k]), raw.id);
        else db.run(`INSERT INTO ${t.name}(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, raw.id, ...keys.map(k => o[k]));
        if (t.name === 'clients' && !existing && auth.caseloadRestricted(user)) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, require('../crypto').uuid(), raw.id, user.id, 'primary', (raw.intake_date || db.now()).slice(0, 10), user.id);
        n++;
      }
      applied[t.name] = n;
    }
    for (const ts of payload.tombstones || []) {
      const t = SYNC.tables.find(x => x.name === ts.table_name); if (!t || t.name === 'users' || typeof ts.id !== 'string') continue;
      const existing = db.one(`SELECT * FROM ${t.name} WHERE id=?`, ts.id);
      if (existing && (existing.updated_at || existing.created_at || NEVER) < ts.deleted_at) { db.run(`DELETE FROM ${t.name} WHERE id=?`, ts.id); db.tombstone(t.name, ts.id); }
    }
    for (const a of (payload.audit || []).slice(0, 5000)) if (a && a.action) audit.log({ user, action: `device.${a.action}`, entity: a.entity, entityId: a.entity_id, clientId: a.client_id, ip: 'device', success: a.success !== 0, details: { at: a.at, device: true, ...(a.details ? safeJson(a.details) : {}) } });
  });
  return { applied, rejected };
}
function safeJson(s) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return {}; } }

module.exports = (r) => {
  r.get('/api/sync/pull', auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:read')) throw forbidden('Your role cannot sync client data');
    const since = ctx.query.get('since') || NEVER;
    const out = pull(ctx.user, since);
    audit.log({ user: ctx.user, action: 'sync.pull', ip: ctx.ip, details: { since, rows: Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length])) } });
    return out;
  });
  r.post('/api/sync/push', auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:write')) throw forbidden('Your role cannot sync client data');
    if (!ctx.body || typeof ctx.body !== 'object') throw badRequest('JSON body required');
    const res = push(ctx.user, ctx.body);
    audit.log({ user: ctx.user, action: 'sync.push', ip: ctx.ip, details: { applied: res.applied, rejected: res.rejected.length } });
    return res;
  });
};
module.exports.pull = pull; module.exports.push = push;
