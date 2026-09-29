'use strict';
// Client-record revision history (1.17.0). Since 1.16.1 anyone who can see a client may change the record, and the
// primary worker is told which fields changed (server/rules/clients.js notifyPrimary). This keeps what they held:
// one row per change in client_revisions, with each changed field's value before and after, encrypted
// (changes_enc, AES-256-GCM like every other _enc column; key rotation finds it by its name). Nothing about the
// values is ever written in plain text -- not in the row's other columns, not in an audit entry (which names the
// revision and the fields), not in a log line.
//
// Written on every path that changes a client's own fields: PUT /api/clients/:id (via 'rest', which a revert also
// takes), a device's edit when its push lands (via 'sync', server/rules/clients.js afterApply) and the gaps a merge
// fills in on the record that is kept (via 'merge'). Imports only ever create clients, so they write none. The
// status and dates an episode, an overdose event or a visit sets as a consequence of recording them are recorded
// there (their own rows and audit entries), not here: putting one of those back belongs to that record.
//
// Who sees it (minimum necessary: earlier values are more than the record shows today): the client's care team (an
// active assignment, any role on the case) and whoever holds records:manage-others (supervisors, administrators).
// Someone who can open the record but is not on its care team sees it as it is now, as before.
// Who puts a change back: the primary worker, or records:manage-others -- and clients:write, since it is an edit.
// A revert goes through the same rules as any edit (server/rules/clients.js) and is itself a new revision: history
// is never changed or deleted, only added to. Rows go only with the client, in the retention purge.
//
// Where it is kept: at the office. It is never synchronised (server/sync-tables.js server_only): a device that
// syncs with an office keeps no earlier values of anyone's record, and its History tab says to open the record at
// the office. SUDS on this device, which has no office, keeps its own.
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const { encrypt, decrypt, uuid } = require('./crypto');

/** Whether this database keeps revisions: the office, and SUDS on this device; not a device that syncs with one. */
function keptHere() {
  const config = require('./config');
  let staticHost = false; try { staticHost = globalThis.SUDS_STATIC_HOST === true; } catch { staticHost = false; }
  return !(config.local && !staticHost);
}
const OFFICE_ONLY = 'A client\'s change history is kept at the office. Open this record in the office SUDS to see what changed or to put a change back.';

/** The client fields a revision records: the client form's (server/rules/clients.js FIELDS). */
const fieldNames = () => Object.keys(require('./rules/clients').fields);
/** A field's value as a revision holds it: a yes/no as 1 or 0, nothing as null. */
function norm(v) {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
const same = (a, b) => String(norm(a) ?? '') === String(norm(b) ?? '');

/**
 * { field: { before, after } } for the fields `after` names whose value differs from `before`'s (both plain maps
 * of the client's API fields). Fields outside the client form are left out.
 */
function diff(before, after) {
  const known = new Set(fieldNames());
  const out = {};
  for (const [k, v] of Object.entries(after || {})) {
    if (!known.has(k) || v === undefined) continue;
    if (!same(before ? before[k] : null, v)) out[k] = { before: norm(before ? before[k] : null), after: norm(v) };
  }
  return out;
}

/**
 * Keep one change to a client's record. Returns the revision's id, or null when nothing changed (or this database
 * keeps none). Audited by revision and field names only.
 */
function record({ user, clientId, changes, via, reverts = null, ip }) {
  if (!changes || !Object.keys(changes).length || !keptHere()) return null;
  const id = uuid();
  db.run(`INSERT INTO client_revisions(id,client_id,changed_by,via,reverts,changes_enc,created_at) VALUES(?,?,?,?,?,?,?)`,
    id, clientId, user && user.id && db.one(`SELECT 1 FROM users WHERE id=?`, user.id) ? user.id : null, via, reverts, encrypt(JSON.stringify(changes)), db.now());
  audit.log({ user, action: 'client.revision', entity: 'client', entityId: clientId, clientId, ip, details: { revision: id, via, fields: Object.keys(changes), reverts: reverts || undefined } });
  return id;
}

const onCareTeam = (user, clientId) => !!db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND ${auth.activeAssignment()}`, clientId, user.id);
const isPrimary = (user, clientId) => !!db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND role_on_case='primary' AND ${auth.activeAssignment()}`, clientId, user.id);
/** May `user` read this client's earlier values? The care team and records:manage-others (see the top). */
function mayRead(user, clientId) {
  return auth.hasPerm(user, 'clients:read') && (auth.hasPerm(user, 'records:manage-others') || onCareTeam(user, clientId));
}
/** May `user` put one of this client's changes back? The primary worker and records:manage-others, with clients:write. */
function mayRevert(user, clientId) {
  return auth.hasPerm(user, 'clients:write') && auth.hasPerm(user, 'clients:read') && (auth.hasPerm(user, 'records:manage-others') || isPrimary(user, clientId));
}
/** What the record tells its reader about the history (GET /api/clients/:id). */
function access(user, clientId) {
  return { read: mayRead(user, clientId), revert: mayRevert(user, clientId), office_only: !keptHere() };
}

/** One stored revision, decrypted: { id, at, via, reverts, changed_by, by, changes }. */
function present(r, names) {
  let changes = {};
  try { changes = JSON.parse(decrypt(r.changes_enc)); } catch { changes = {}; }
  const label = require('./rules/clients').fieldLabel;
  return {
    id: r.id, at: r.created_at, via: r.via, reverts: r.reverts || null, changed_by: r.changed_by,
    by: (r.changed_by && names.get(r.changed_by)) || 'Someone no longer on the system',
    changes: Object.entries(changes).map(([field, c]) => ({ field, label: label(field), before: c.before ?? null, after: c.after ?? null })),
  };
}
/** A client's revisions, newest first, with which later revision reverted each (reverted_by). */
function list(clientId) {
  const rows = db.all(`SELECT * FROM client_revisions WHERE client_id=? ORDER BY created_at DESC, rowid DESC`, clientId);
  const names = new Map(db.all(`SELECT id, display_name, username FROM users WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify([...new Set(rows.map(r => r.changed_by).filter(Boolean))])).map(u => [u.id, u.display_name || u.username]));
  const out = rows.map(r => present(r, names));
  const by = new Map(out.map(r => [r.id, r]));
  for (const r of out) if (r.reverts && by.has(r.reverts)) (by.get(r.reverts).reverted_by = by.get(r.reverts).reverted_by || []).push(r.id);
  return out;
}
/** One revision of this client's, or null. */
function one(clientId, id) {
  const r = db.one(`SELECT * FROM client_revisions WHERE id=? AND client_id=?`, id, clientId);
  if (!r) return null;
  const names = new Map(r.changed_by ? [[r.changed_by, (db.one(`SELECT display_name FROM users WHERE id=?`, r.changed_by) || {}).display_name]] : []);
  return present(r, names);
}

module.exports = { keptHere, OFFICE_ONLY, diff, norm, same, record, mayRead, mayRevert, access, list, one, onCareTeam, isPrimary };
