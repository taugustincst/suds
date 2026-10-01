'use strict';
// Device <-> server synchronisation. The phone runs its own copy of SUDS (local kernel) and calls these
// routes on demand. Rows are identified by UUID; the newest updated_at wins; hard deletes travel as
// tombstones. PHI columns are decrypted for transport (over TLS, authenticated) and re-encrypted with the
// receiver's key.
//
// Two rules shape this file and server/rules/push.js, which applies what a device sends:
//  * A device may not do through sync what its user could not do through the API. Each table's rules
//    (server/rules/<table>.js) are the ones its REST routes enforce, and caseload scoping is applied to pushed
//    rows, not just pulled ones.
//  * One bad row must never cost a device its ability to sync. Each row is applied inside a savepoint; a
//    failure rejects that row and the rest of the batch still lands.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, forbidden } = require('../http');
const { encrypt, decrypt } = require('../crypto');
const SYNC = require('../sync-tables');
const FS = require('../field-scope');

const NEVER = '1970-01-01T00:00:00.000Z';
// One pull answers with at most this many rows per table. Beyond that the device is told to come back for
// more, so a first sync of a large county is many small responses instead of one that cannot be parsed.
const PULL_LIMIT = 2000;

function cols(table) { return db.all(`PRAGMA table_info(${table})`).map(c => c.name); }

// Row marshalling lives in sync-tables.js so the server and the device cannot drift apart.
const { exportRow, importRow } = SYNC;

// `field`: a field device's context (server/field-scope.js context), or null for the full scope. A field device's
// rows are the full scope's AND its table's field rule: an excluded table sends nothing at all.
function scopeSql(t, user, alias, field = null) {
  const base = baseScopeSql(t, user, alias);
  if (!field) return base;
  const extra = FS.rowSql(t.name, alias, field, auth.activeAssignment('a.'));
  if (!extra) return base;
  return { sql: `(${base.sql}) AND ${extra.sql}`, params: [...base.params, ...extra.params] };
}
function baseScopeSql(t, user, alias) {
  const cf = auth.caseloadFilter(user, `${alias}.${t.clientCol}`);
  if (t.scope === 'all' || t.scope === 'users') return { sql: '1=1', params: [] };
  // Imports are their importer's until filed (server/routes/imports.js shows them to nobody else without
  // records:manage-others, 1.16.0; before, clients:all). They used to travel to every device, other people's OneNote pages included.
  if (t.scope === 'importer' || t.scope === 'via-import') {
    if (auth.hasPerm(user, 'records:manage-others')) return { sql: '1=1', params: [] };
    if (t.scope === 'importer') return { sql: `(${alias}.imported_by=? OR ${alias}.imported_by IS NULL)`, params: [user.id] };
    return { sql: `${alias}.import_id IN (SELECT i.id FROM imports i WHERE i.imported_by=? OR i.imported_by IS NULL)`, params: [user.id] };
  }
  // A client merged away at the office drops off the caseload (its assignments moved to the record that
  // was kept), so the device that still held it was never told and showed a duplicate for ever. The merged
  // row travels when the record it was merged into is on the caseload: the device marks it merged and
  // re-points what it holds, exactly as the office did.
  if (t.name === 'clients' && cf.sql !== '1=1') { const kf = auth.caseloadFilter(user, `${alias}.merged_into`); return { sql: `(${cf.sql} OR (${alias}.merged_into IS NOT NULL AND ${kf.sql}))`, params: [...cf.params, ...kf.params] }; }
  if (t.scope === 'via-note') { const nf = auth.caseloadFilter(user, 'n.client_id'); return { sql: `${alias}.note_id IN (SELECT n.id FROM notes n WHERE ${nf.sql})`, params: nf.params }; }
  if (t.scope === 'client-or-null') {
    // A row with no client is its owners' unless the role holds the table's `all` permission (crud.js applies
    // the same rule to the REST routes, exports.js to exports).
    return SYNC.clientOrNullScope(t.name, user, alias, cf, auth.hasPerm);
  }
  return cf;
}

// Clients this person's device holds but may no longer: an assignment of theirs ended (or ran out) since the
// device last pulled, and nothing else keeps the client in scope. Ending an assignment changes no client row,
// so without this the device kept the record -- and everything written about the client -- for good. The
// device removes them (sync-tables.js purgeClient); it is not a deletion and is never echoed back.
function droppedClients(user, since, field = null) {
  if (field) return fieldDroppedClients(user, since, field);
  if (!auth.caseloadRestricted(user) || since === NEVER) return [];
  const ids = db.all(`SELECT DISTINCT client_id FROM assignments WHERE user_id=? AND NOT ${auth.activeAssignment()}
    AND (ended_at > ? OR (ended_at IS NULL AND (updated_at > ? OR end_date >= date(?))))`, user.id, since, since, since).map(r => r.client_id);
  const sc = scopeSql(SYNC.tables.find(t => t.name === 'clients'), user, 'c');
  return ids.filter(id => !db.one(`SELECT 1 FROM clients c WHERE c.id=? AND ${sc.sql}`, id, ...sc.params));
}

// A field device holds only the clients of its worker's own recent caseload (server/field-scope.js), a set that changes
// with no row changing at all: a client whose last contact leaves the window, one moved to another worker (the
// assignment ends), one merged into a record that is not in the set. Every client this worker has ever been assigned
// that is not in the set now is named, and so is any client merged since the last pull whose kept record is not: the
// device removes the ones it holds (sync-tables.js purgeClient), and a client it does not hold costs it one lookup.
function fieldDroppedClients(user, since, field) {
  if (since === NEVER) return [];
  const set = FS.clientSetSql(field, auth.activeAssignment('a.'));
  const inSet = new Set(db.all(set.sql, ...set.params).map(r => r.client_id));
  const ever = db.all(`SELECT DISTINCT client_id FROM assignments WHERE user_id=?`, user.id).map(r => r.client_id);
  const merged = db.all(`SELECT id FROM clients WHERE merged_into IS NOT NULL AND updated_at > ?`, since).map(r => r.id);
  const out = new Set([...ever, ...merged].filter(id => !inSet.has(id)));
  // A duplicate merged into a record that leaves travelled only because that record was in the set (merges chain).
  for (let frontier = [...out], i = 0; frontier.length && i < 25; i++) {
    frontier = db.all(`SELECT id FROM clients WHERE merged_into IN (SELECT value FROM json_each(?))`, JSON.stringify(frontier)).map(r => r.id).filter(id => !out.has(id) && !inSet.has(id));
    for (const id of frontier) out.add(id);
  }
  return [...out];
}

// ---- what a device may hold changes with its user's permissions (1.16.0) ----
// A pull sends rows changed since the device's cursor, so a change to what the person may read (their role, a
// per-user grant or deny, 1.15.0; the 1.16.0 widening of the navigator and clinician defaults) reached a device
// that had already synced only in part: newly readable clients arrived whenever something about them happened
// to change, and records the person may no longer read stayed on the device for good. The answer now carries
// `scope`, a key of everything that decides what a pull sends (caseload scoping and the permissions the tables
// read: clients:all, notes:clinical:read, each table's readPerm, redact and unlinked `all` permissions), and
// the device sends back the key it last saw (?scope=; `legacy` from a device that synced before 1.16.0 and so
// holds what the 1.15 role defaults allowed, auth.asBefore1_16). When the key differs:
//  * anything the person may no longer read is named, for the device to remove (not a deletion: nothing is
//    echoed back): clients off their caseload in `dropped_clients` as an ended assignment does, and other rows
//    (clinical notes and their addenda, another worker's records with no client, another worker's imports,
//    a table whose readPerm went) in `dropped_rows`, as [table, id] pairs;
//  * anything newly readable is sent by starting this pull again from the beginning (`scope_widened`); the
//    device keeps what it has and receives the rest, as at its first sync. A redacted table whose permission
//    changed either way is re-sent the same way, so the device holds the amounts, or the placeholders, it may.
const SCOPE_V = 'v1';
const COUNSEL = require('../rules/notes');
const TASKS = require('../rules/tasks');
function scopePerms() {
  const s = new Set(Object.keys(require('../permissions').READ_SCOPE_PERMS));
  for (const t of SYNC.tables) { if (t.readPerm) s.add(t.readPerm); if (t.redact) s.add(t.redact.perm); if (t.unlinked) s.add(t.unlinked.all); }
  return [...s].sort();
}
function syncScopeKey(user, field = null) {
  // counseling: whether every SUD counseling note is readable (1.16.1, server/rules/notes.js readsCounseling).
  // field: 0 for the full scope, or a field device's window in days (1.21.0, server/field-scope.js).
  return [SCOPE_V, `caseload=${auth.caseloadRestricted(user) ? 1 : 0}`, ...scopePerms().map(p => `${p}=${auth.hasPerm(user, p) ? 1 : 0}`), `counseling=${COUNSEL.readsCounseling(user) ? 1 : 0}`, `field=${field ? field.days : 0}`].join(';');
}
function parseScopeKey(key) {
  const parts = String(key || '').split(';');
  if (parts[0] !== SCOPE_V) return null;
  const m = {};
  for (const x of parts.slice(1)) {
    const [k, v] = x.split('=');
    if (k === 'field') { if (/^\d{1,3}$/.test(v || '')) m.field = Number(v); continue; }
    if (k && (v === '0' || v === '1')) m[k] = v === '1';
  }
  return m;
}
/** How the scope changed from the key a device sent: { widened, redacted, caseloadNarrowed, lost: Set }; null when unchanged or unknown. */
function scopeChange(user, sent, field = null) {
  if (!sent) return null;
  const prevKey = sent === 'legacy' ? syncScopeKey(auth.asBefore1_16(user)) : sent;
  const prev = parseScopeKey(prevKey); const cur = parseScopeKey(syncScopeKey(user, field));
  if (!prev) return null;
  // A device that synced before 1.16.1 was sent the counseling notes of every clinical note it could read.
  if (!('counseling' in prev)) prev.counseling = prev['notes:clinical:read'] !== false;
  const change = { widened: false, redacted: false, caseloadNarrowed: false, lost: new Set(), fieldReset: false };
  // A device that became a field device (or whose window changed) starts again from the beginning under the field
  // scope and first removes what it holds (local/sync.js resetForField); one that stopped being one is sent the rest.
  // A key from before 1.21.0 has no `field`: that device was syncing in the full scope.
  const wasField = prev.field || 0; const isField = cur.field || 0;
  delete prev.field; delete cur.field;
  if (isField && isField !== wasField) change.fieldReset = true;
  else if (!isField && wasField) change.widened = true;
  const redactPerms = new Set(SYNC.tables.filter(t => t.redact).map(t => t.redact.perm));
  for (const [k, now] of Object.entries(cur)) {
    if (!(k in prev) || prev[k] === now) continue; // a key an older server did not send is not a change
    if (k === 'caseload') { if (now) change.caseloadNarrowed = true; else change.widened = true; continue; }
    if (now) change.widened = true; else change.lost.add(k);
    if (redactPerms.has(k)) change.redacted = true;
  }
  return change.widened || change.redacted || change.caseloadNarrowed || change.lost.size || change.fieldReset ? change : null;
}
/** What a device must remove after its person's scope narrowed (scopeChange). */
function scopeDrops(user, change, field = null) {
  const clients = [];
  const rows = [];
  if (change.fieldReset) return { clients, rows }; // the device removes everything it holds from the office and starts again
  if (change.caseloadNarrowed) {
    const sc = scopeSql(SYNC.tables.find(t => t.name === 'clients'), user, 'c', field);
    clients.push(...db.all(`SELECT c.id FROM clients c WHERE NOT (${sc.sql})`, ...sc.params).map(r => r.id));
  }
  const lost = change.lost;
  for (const t of SYNC.tables) {
    if (t.readPerm && lost.has(t.readPerm)) {
      const sc = scopeSql(t, user, 'x', field);
      rows.push(...db.all(`SELECT x.id FROM ${t.name} x WHERE ${sc.sql}`, ...sc.params).map(r => [t.name, r.id]));
      continue;
    }
    if (t.unlinked && lost.has(t.unlinked.all)) {
      const sc = scopeSql(t, user, 'x', field);
      rows.push(...db.all(`SELECT x.id FROM ${t.name} x WHERE x.${t.clientCol || 'client_id'} IS NULL AND NOT (${sc.sql})`, ...sc.params).map(r => [t.name, r.id]));
    }
    if ((t.scope === 'importer' || t.scope === 'via-import') && lost.has('records:manage-others')) {
      const sc = scopeSql(t, user, 'x', field);
      rows.push(...db.all(`SELECT x.id FROM ${t.name} x WHERE NOT (${sc.sql})`, ...sc.params).map(r => [t.name, r.id]));
    }
  }
  if (lost.has('notes:clinical:read') && !auth.hasPerm(user, 'notes:clinical:read')) {
    const cf = auth.caseloadFilter(user, 'n.client_id');
    const notes = db.all(`SELECT n.id FROM notes n WHERE n.kind='clinical' AND ${cf.sql}`, ...cf.params).map(r => r.id);
    // Addenda first: the device removes children before what they hang off.
    for (const id of notes) for (const a of db.all(`SELECT id FROM note_addenda WHERE note_id=?`, id)) rows.push(['note_addenda', a.id]);
    for (const id of notes) rows.push(['notes', id]);
  }
  if (lost.has('counseling') && !COUNSEL.readsCounseling(user)) {
    const cf = auth.caseloadFilter(user, 'n.client_id'); const sud = COUNSEL.counselingFilter(user, 'n');
    const notes = db.all(`SELECT n.id, n.author_id, n.cosigned_by FROM notes n WHERE n.kind='clinical' AND NOT ${sud.sql} AND ${cf.sql}`, ...sud.params, ...cf.params);
    for (const n of notes) for (const a of db.all(`SELECT id FROM note_addenda WHERE note_id=?`, n.id)) rows.push(['note_addenda', a.id]);
    for (const n of notes) rows.push(['notes', n.id, gate(n)]);
  }
  // Children before parents, in the tables' foreign-key order reversed (as sync-tables.js purgeClient).
  const order = new Map(SYNC.tables.map((t, i) => [t.name, i]));
  const kidsFirst = rows.map((r, i) => [r, i]).sort((a, b) => (order.get(b[0][0]) - order.get(a[0][0])) || (a[1] - b[1])).map(x => x[0]);
  return { clients, rows: kidsFirst };
}

// Clients that came onto this person's caseload after the device's cursor: an active assignment of theirs was
// created (or re-opened, or otherwise changed) in this page's window (since, cursor], and no assignment of
// theirs that was already active before `since` kept the client in scope then. Assigning an existing client
// changes no client row, so a pull by updated_at alone sent the assignment and nothing else: the client, and
// every note, consent and visit recorded before the assignment, never reached the device. Those rows follow
// as backfill pages (below). Detected per page window, not against the first `since`, because the device's
// cursor moves on after every page. As SQL, so the backfill can re-derive the same set on every page
// without carrying a list of client ids.
function newlyInScopeSql(user, since, cursor, field = null) {
  if (field) return newlyInFieldSql(since, field);
  return { sql: `SELECT DISTINCT a.client_id FROM assignments a WHERE a.user_id=? AND ${auth.activeAssignment('a.')} AND a.updated_at > ? AND a.updated_at <= ?
    AND NOT EXISTS (SELECT 1 FROM assignments b WHERE b.client_id=a.client_id AND b.user_id=? AND b.updated_at <= ? AND ${auth.activeAssignment('b.')})`,
  params: [user.id, since, cursor, user.id, since] };
}
// A field device's clients arrive when they join its set (server/field-scope.js): a new assignment, as above, or a
// contact that brings a client of the worker's own caseload back into the window. In the set now, and not in it as of
// `since` (the window as it stood then, and only what had been recorded by then). An assignment changed since then
// (re-opened, or moved by a merge onto the record that was kept) counts as new, as it does for any device above.
function newlyInFieldSql(since, field) {
  const active = auth.activeAssignment('a.');
  const now = FS.clientSetSql(field, active);
  const then = FS.context(field.userId, field.days, Date.parse(since));
  return { sql: `SELECT DISTINCT n.client_id FROM (${now.sql}) n WHERE n.client_id NOT IN (SELECT a.client_id FROM assignments a WHERE a.user_id=? AND ${active} AND a.updated_at <= ?
      AND (a.start_date >= ? OR a.created_at >= ? OR EXISTS (SELECT 1 FROM interventions fi WHERE fi.client_id=a.client_id AND fi.created_at <= ? AND fi.occurred_at >= ?)))`,
  params: [...now.params, field.userId, since, then.windowDate, then.windowStart, since, then.windowStart] };
}
function newlyInScope(user, since, cursor, field = null) {
  if ((!auth.caseloadRestricted(user) && !field) || since === NEVER) return [];
  const q = newlyInScopeSql(user, since, cursor, field);
  return db.all(q.sql, ...q.params).map(r => r.client_id);
}

// ---- backfill: the rows of newly assigned clients, in pages ----
// Up to 1.12.0 the whole record set of every newly assigned client rode on the page that carried the
// assignment, whatever its size: one client with 40,000 visits made a single pull of 40,531 rows (25.5 MB of
// JSON, 810 ms of synchronous work) against a page limit of 2,000, and a bulk caseload transfer did the same
// for every client moved. Now the page that finds new clients says so and ends there; the backfill follows in
// pages of at most `limit` rows in all, walked table by table in a keyset order (the row's client -- or note,
// for addenda -- then its id), and resumed from a position carried inside the pull cursor:
//
//     <timestamp>~bf.<base64url JSON { v: 1, from, t, k, i }>
//
// `timestamp` is the page's own cursor (the end of the window the clients arrived in), `from` the start of
// that window (only rows not newer than it are backfilled; anything newer comes with the ordinary pages), `t`
// the table and `k`/`i` the last key sent. While a backfill is under way the ordinary pages wait; when it is
// done the cursor is the plain timestamp again and the device carries on from there. An older kernel stores
// and echoes the cursor without reading it and loops until `complete`, so it receives the same pages; if it
// stops early (its page cap), its stored cursor resumes the backfill at the next sync. The position is only a
// place in a keyset: every row still passes the table's scope and read rules, so a forged cursor cannot
// fetch anything a full resync would not.
const BF_MARK = '~bf.';
function backfillKey(t) {
  if (t.name === 'clients') return { key: 'id', where: (arrived) => `x.id IN (${arrived})` };
  if ((t.scope === 'client' || t.scope === 'client-or-null') && t.clientCol) return { key: t.clientCol, where: (arrived) => `x.${t.clientCol} IN (${arrived})` };
  if (t.scope === 'via-note') return { key: 'note_id', where: (arrived) => `x.note_id IN (SELECT n.id FROM notes n WHERE n.client_id IN (${arrived}))` };
  return null;
}
const bfTables = () => SYNC.tables.filter(backfillKey);
function encodeCursor(ts, bf) { return ts + BF_MARK + Buffer.from(JSON.stringify({ v: 1, ...bf })).toString('base64url'); }
// A pull of several pages carries where its first page started (`~from.<timestamp>`, after the rest), so a note
// flagged as a SUD counseling note after the device last pulled is named on whichever page carries it (flaggedSince;
// security review of 1.16.3, N6). A device that finishes the pull gets a plain cursor again.
const FROM_MARK = '~from.';
const withFrom = (cursor, from) => (from ? cursor + FROM_MARK + from : cursor);
function parseCursor(whole) {
  const f = whole.indexOf(FROM_MARK);
  const raw = f < 0 ? whole : whole.slice(0, f);
  const cut = f < 0 ? null : whole.slice(f + FROM_MARK.length);
  const from = cut && cut.length <= 40 && !Number.isNaN(Date.parse(cut)) && cut <= raw.split(BF_MARK)[0] ? cut : null;
  return { ...parseBackfill(raw), from };
}
function parseBackfill(raw) {
  const at = raw.indexOf(BF_MARK);
  if (at < 0) return { since: raw, bf: null };
  const since = raw.slice(0, at);
  let bf = null;
  try { bf = JSON.parse(Buffer.from(raw.slice(at + BF_MARK.length), 'base64url').toString('utf8')); } catch { bf = null; }
  const str = (v) => typeof v === 'string' && v.length <= 200;
  const ok = bf && typeof bf === 'object' && bf.v === 1 && str(bf.from) && bf.from < since && bfTables().some(t => t.name === bf.t)
    && (bf.k === null || str(bf.k)) && (bf.i === null || str(bf.i)) && (bf.k === null) === (bf.i === null);
  if (!ok) throw badRequest('This device\'s sync position is damaged. Sync again; if this repeats, reset the device\'s sync from This device.');
  return { since, bf: { from: bf.from, t: bf.t, k: bf.k, i: bf.i } };
}
/** One backfill page: at most `limit` rows in all, from position `bf`. Returns { raw, next } (next null when done). */
function backfillPage(user, until, bf, limit, field = null) {
  // Which clients arrived is worked out once for the page and handed to each table's query as a list; it used
  // to be a subquery run again for every table (45 times a page, 0.3 s each at a 2,000-client caseload).
  const q = newlyInScopeSql(user, bf.from, until, field);
  const arrivedQ = { sql: 'SELECT value FROM json_each(?)', params: [JSON.stringify(db.all(q.sql, ...q.params).map(r => r.client_id))] };
  const tables = bfTables();
  const raw = {}; let budget = limit; let next = null;
  for (let ti = tables.findIndex(t => t.name === bf.t); ti < tables.length; ti++) {
    const t = tables[ti]; const { key, where } = backfillKey(t);
    const resume = t.name === bf.t && bf.k !== null;
    if (budget <= 0) { next = resume ? { ...bf } : { from: bf.from, t: t.name, k: null, i: null }; break; }
    const sc = scopeSql(t, user, 'x', field);
    const after = resume ? `AND (x.${key} > ? OR (x.${key} = ? AND x.id > ?))` : '';
    const rows = db.all(`SELECT x.* FROM ${t.name} x WHERE ${where(arrivedQ.sql)} AND x.updated_at <= ? AND ${sc.sql} ${after} ORDER BY x.${key}, x.id LIMIT ?`,
      ...arrivedQ.params, bf.from, ...sc.params, ...(resume ? [bf.k, bf.k, bf.i] : []), budget + 1);
    if (rows.length > budget) {
      // More in this table than the page has room for: send what fits and remember where it stopped.
      const sent = rows.slice(0, budget); const last = sent[sent.length - 1];
      raw[t.name] = sent;
      next = { from: bf.from, t: t.name, k: last[key], i: last.id };
      break;
    }
    raw[t.name] = rows; budget -= rows.length;
  }
  return { raw, next };
}

// Pull everything changed since `since` that the user may see, in bounded pages.
//
// Paging is by updated_at, which is not unique: a bulk import can stamp thousands of rows with the same
// instant. Cutting a page in the middle of one timestamp would lose every row after the cut, because the
// next request asks for `> cursor`. So a page always ends on a timestamp boundary — and when a single
// timestamp is itself bigger than a page, that timestamp is sent whole rather than split.
function pull(user, sinceRaw, { limit = PULL_LIMIT, scope = null, field = null } = {}) {
  const serverNow = db.now();
  let { since, bf, from } = parseCursor(String(sinceRaw || NEVER));
  // A device that has pulled before may hold a note that has since become one it may not read (exportInto dropSince):
  // one flagged since the pull began, on its first page (`from`) or this one.
  const dropFrom = since === NEVER ? null : from || since;
  // What the person may read changed since this device last pulled (see syncScopeKey above).
  const change = since !== NEVER ? scopeChange(user, scope, field) : null;
  const drops = change ? scopeDrops(user, change, field) : null;
  if (change && (change.widened || change.redacted || change.fieldReset)) { since = NEVER; bf = null; }
  const carry = (out) => { if (!out.complete && dropFrom && since !== NEVER) out.cursor = withFrom(out.cursor, dropFrom); return out; };
  const withScope = (out) => {
    out.scope = syncScopeKey(user, field);
    // What the device is: a field device is told what it holds and the window, for its This device page and to tidy
    // up contacts that have left the window (local/sync.js pruneField). Never trusted: the office filtered already.
    out.device_scope = field ? 'field' : 'full';
    if (field) out.field = FS.describe(field);
    if (drops) {
      out.dropped_clients = [...new Set([...(out.dropped_clients || []), ...drops.clients])];
      out.dropped_rows = [...drops.rows, ...(out.dropped_rows || [])];
      out.scope_changed = true;
      if (change.widened || change.redacted) out.scope_widened = true;
      if (change.fieldReset) out.field_reset = true;
    }
    return out;
  };
  if (bf) return withScope(carry(pullBackfill(user, since, bf, limit, serverNow, field)));
  return withScope(carry(pullPage(user, since, limit, serverNow, since === NEVER ? null : dropFrom, field)));
}
function pullPage(user, since, limit, serverNow, dropFrom = null, field = null) {
  const raw = {}; const capped = []; const scopes = new Map();

  // Where the page ends, in two passes. Up to 1.13 each table's first `limit` rows were read whole, and most of
  // them were then thrown away, because another table's page ended earlier and every table stops at the same
  // instant: a first sync of a 2,000-client caseload read every one of its clients' rows again on each of 30
  // pages. The first pass reads only timestamps, from the indexes (updated_at, and client_id with it for the
  // big tables: schema.sql, "sync reads"), to find each table's boundary; the second reads whole rows only
  // for what this page sends. The pages, cursors and rows are exactly those the one-pass version produced.
  //
  // A table with nothing newer than `since` at all (MAX(updated_at) is one index lookup) is left out of both
  // passes: in an incremental sync that is most of them.
  for (const t of SYNC.tables) {
    const newest = db.one(`SELECT MAX(updated_at) m FROM ${t.name}`).m;
    if (newest === null || newest === undefined || newest <= since) continue;
    if (field && FS.excluded(t.name)) continue;
    const sc = scopeSql(t, user, 'x', field); scopes.set(t.name, sc);
    // updated_at is NOT NULL on every synced table (migration 5) and indexed, so this is a range scan
    // rather than the full table scan a COALESCE would force.
    const stamps = db.all(`SELECT x.updated_at u FROM ${t.name} x WHERE x.updated_at > ? AND ${sc.sql} ORDER BY x.updated_at LIMIT ?`, since, ...sc.params, limit + 1);
    if (stamps.length <= limit) continue;
    // More to come. The first row that did not fit marks the boundary; everything strictly before it is
    // safe to send, because no row of an earlier timestamp can be left behind.
    const boundary = stamps[limit].u;
    let lastSafe = null;
    for (const s of stamps) { if (s.u < boundary) lastSafe = s.u; else break; }
    // The whole page is one timestamp, so it cannot be split without losing rows: all of it is sent
    // (the second pass reads every row of that instant).
    capped.push(lastSafe !== null ? lastSafe : boundary);
  }

  // Every table stops at the same instant, so the cursor stays a single point in time.
  const cursor = capped.length ? capped.reduce((a, b) => (a < b ? a : b)) : serverNow;
  // The rows this page sends: (since, cursor] of each table. For a table that was cut short these are the
  // rows before its boundary (or every row of a single-timestamp page); for the rest, everything they had.
  for (const [name, sc] of scopes) raw[name] = db.all(`SELECT x.* FROM ${name} x WHERE x.updated_at > ? AND x.updated_at <= ? AND ${sc.sql} ORDER BY x.updated_at`, since, cursor, ...sc.params);
  const out = baseAnswer(cursor, serverNow, capped.length === 0);
  exportInto(out, user, raw, cursor, dropFrom, field);
  // Newly assigned clients arrive whole: everything recorded about them before `since` as well, in the
  // backfill pages that follow this one (backfillPage). The cursor carries where they start.
  if (newlyInScope(user, since, cursor, field).length) {
    out.cursor = encodeCursor(cursor, { from: since, t: bfTables()[0].name, k: null, i: null });
    out.complete = false;
    out.backfill = true;
  }
  out.dropped_clients = droppedClients(user, since, field);
  out.tombstones = db.all(`SELECT table_name, id, deleted_at FROM tombstones WHERE deleted_at > ? AND deleted_at <= ? ORDER BY deleted_at`, since, cursor);
  resyncCheck(out, since);
  return out;
}

// db_generation changes when the office database is restored from a backup (server/backup.js). A device
// that sees a value it did not expect knows the office may have lost rows it had already accepted, forgets
// what it thought was exchanged, and offers everything it holds again.
function baseAnswer(cursor, serverNow, complete) {
  const out = { cursor, server_now: serverNow, complete, db_generation: db.getSetting('db_generation', null), tables: {}, tombstones: [], settings: {}, skipped: [], dropped_clients: [], dropped_rows: [] };
  for (const k of SYNC.settings_keys) out.settings[k] = db.getSetting(k, null);
  out.settings.caseload_restriction = db.getSetting('caseload_restriction', '1'); // unset means on (server/auth.js)
  // The office's calendar goes to its devices, so "today" and a visit's service date are the same day on
  // both (the zone in force: the setting, else ORG_TIMEZONE).
  out.settings.org_timezone = require('./budget').orgTimezone() || null;
  return out;
}
// A device that has been away longer than tombstones are kept cannot be told what was deleted, so it is
// sent for a full resync instead of quietly keeping rows everyone else has dropped.
function resyncCheck(out, since) {
  const horizon = db.getSetting('tombstone_purged_before', null);
  if (horizon && since !== NEVER && since < horizon) { out.full_resync_required = true; out.reason = 'This device has been offline longer than deletions are kept; it will rebuild from the office copy.'; }
}
/** A backfill page (backfillPage): rows only -- the ordinary page before it carried the tombstones and drops. */
function pullBackfill(user, since, bf, limit, serverNow, field = null) {
  const { raw, next } = backfillPage(user, since, bf, limit, field);
  const out = baseAnswer(next ? encodeCursor(since, next) : since, serverNow, false);
  out.backfill = !!next;
  exportInto(out, user, raw, null, null, field);
  resyncCheck(out, bf.from);
  return out;
}
// dropSince: a note changed in this window that the person may not read is named in `dropped_rows` (with its
// addenda, first) rather than left out in silence, for a device that may hold an earlier copy: a clinical draft
// flagged as a SUD counseling note after a navigator's device pulled it (security review of 1.16.1, M3). Only a note
// flagged in this window, and written before it: an edit to a counseling note, or a new one, is nothing the device
// was ever sent, and naming it both told the device that one was written and removed it from a shared device where
// a clinician was working on it (security review of 1.16.2, M2 and L4).
// The flag is found by the note's id, whichever client its audit entry names (N7: a push need not send client_id).
function flaggedSince(n, since) {
  if (!n.created_at || n.created_at > since) return false;
  const flagged = `AND entity_id=? AND at > ? AND ((action='note.update' AND details LIKE '%"counseling_note_set":true%')
    OR (action='sync.overwrite' AND entity='notes' AND details LIKE '%"counseling_note"%'))`;
  return !!(db.one(`SELECT 1 FROM audit_log WHERE client_id=? ${flagged}`, n.client_id, n.id, since) || db.one(`SELECT 1 FROM audit_log WHERE client_id IS NULL ${flagged}`, n.id, since));
}
/** What makes a note a SUD counseling note, sent with its drop: a shared device judges its other accounts by it (local/sync.js). */
const gate = (n) => ({ counseling_note: 1, author_id: n.author_id, cosigned_by: n.cosigned_by || null });
function exportInto(out, user, raw, cursor, dropSince = null, field = null) {
  for (const t of SYNC.tables) {
    let rows = raw[t.name] || [];
    if (field && FS.excluded(t.name)) rows = []; // never to a field device, whatever reached this far
    // A field device's reduced columns travel blank (server/field-scope.js): it never holds them.
    const blank = field ? FS.blankColumns(t.name) : [];
    if (blank.length) rows = rows.map(r => { const o = { ...r }; for (const c of blank) if (c in o) o[c] = null; return o; });
    if (cursor) rows = rows.filter(r => r.updated_at <= cursor);
    if (t.name === 'users') rows = rows.map(r => ({ ...(r.id === user.id ? r : { ...r, password_hash: 'scrypt$0$0$0$AA==$AA==' }), mfa_secret_enc: null, mfa_enabled: 0 })); // devices get own password hash for offline login; never MFA secrets
    if (t.name === 'notes' && !auth.hasPerm(user, 'notes:clinical:read')) rows = rows.filter(r => r.kind !== 'clinical'); // minimum necessary
    if (t.name === 'notes') { // SUD counseling notes (1.16.1)
      const hidden = rows.filter(r => !COUNSEL.mayReadCounseling(user, r));
      if (hidden.length) rows = rows.filter(r => COUNSEL.mayReadCounseling(user, r));
      if (dropSince) for (const n of hidden.filter(x => flaggedSince(x, dropSince))) out.dropped_rows.push(...db.all(`SELECT id FROM note_addenda WHERE note_id=?`, n.id).map(a => ['note_addenda', a.id]), ['notes', n.id, gate(n)]);
    }
    if (t.readPerm && !auth.hasPerm(user, t.readPerm)) rows = []; // minimum necessary (clinical assessments, the care plan, spending)
    if (t.redact && !auth.hasPerm(user, t.redact.perm)) rows = rows.map(r => ({ ...r, ...t.redact.cols })); // fund names without their money
    if (t.name === 'note_addenda' && !auth.hasPerm(user, 'notes:clinical:read')) rows = rows.filter(r => db.one(`SELECT kind FROM notes WHERE id=?`, r.note_id)?.kind !== 'clinical');
    if (t.name === 'note_addenda' && !COUNSEL.readsCounseling(user)) rows = rows.filter(r => { const n = db.one(`SELECT counseling_note, author_id, cosigned_by FROM notes WHERE id=?`, r.note_id); return !n || COUNSEL.mayReadCounseling(user, n); });
    // Which of these to-dos are change notices, and whose edit each reports: a device's audit trail cannot say
    // (UX review of 1.16.3, M1), so it takes the office's word for the rows it is sent (local/sync.js keepNotices).
    if (t.name === 'tasks') out.notices = rows.map(r => [r.id, TASKS.noticeEntry(r)]).filter(([, a]) => a).map(([id, a]) => [id, a.user_id]);
    const exported = [];
    for (const r of rows) {
      const e = exportRow(t, r);
      if (e) exported.push(e);
      else out.skipped.push({ table: t.name, id: r.id, reason: 'could not be decrypted on the server' });
    }
    out.tables[t.name] = exported;
  }
}

// Applying a device's rows is server/rules/push.js: a short loop that puts each row through its table's rules
// (server/rules/<table>.js), the same rules the REST routes enforce.
const { push } = require('../rules/push');

// Local mode switched off (LOCAL_MODE_ENABLED, or the setup wizard's answer in server.json) has to mean
// no device copies at all — the same setting that stops /?local=1 and /local/kernel.js being served
// (server/app.js). Without this a copy made before the switch, or a static-site build, went on pulling and
// pushing PHI after the office had said no. The kernel itself (config.local) is never refused its own routes.
function requireLocalMode() {
  const config = require('../config');
  if (!config.localModeEnabled && !config.local) throw forbidden('Local mode (offline copies on devices) is turned off on this server, so devices cannot sync. An administrator can turn it on in the server settings (LOCAL_MODE_ENABLED, or the setup answer saved in server.json).');
}

// ---- field devices (released in 1.21.0; server/field-scope.js) ----
const DEVICES = require('../devices');
/** The field context of a pull from this device, or null when it syncs in the full scope. */
function fieldContext(user, device) {
  if (!device || device.sync_scope !== 'field') return null;
  return FS.context(user.id, FS.windowDays(db.getSetting));
}
/**
 * The device a sync request's session signed in from, bound to its account's scope (server/devices.js bind, 1.22.0),
 * and whether the request is in the field scope. The scope follows the account as well as the device: a session that
 * names no device (a browser's, or an older sign-in) is in the field scope when its account is held to it
 * (devices.js accountFieldBound); a device in the field scope unless an administrator marked it "Hold everything".
 * Never the request's word.
 */
function syncScope(ctx) {
  const device = DEVICES.bind(ctx.user, DEVICES.ofSession(ctx), { ip: ctx.ip });
  const field = device ? device.sync_scope === 'field' : DEVICES.accountFieldBound(ctx.user.id);
  return { device, field };
}
/**
 * What a push from this device is held to: { scope, blank }. `scope` (the field context) once the office has answered
 * the device under the field scope (field_applied_at): before that the device has not heard, and what it sends was
 * recorded under the old scope. `blank` whenever the device holds field-shaped rows, including just after it stopped
 * being a field device: a column it was sent blank is never written back blank over the office's value.
 */
function pushField(user, device, field = !!device && device.sync_scope === 'field') {
  // A session with no device, for an account held to the field scope (1.22.0): it was only ever sent the field scope.
  if (!device) return field ? { scope: FS.context(user.id, FS.windowDays(db.getSetting)), blank: true } : null;
  if (!device.field_applied_at) return null;
  return { scope: device.sync_scope === 'field' ? FS.context(user.id, FS.windowDays(db.getSetting)) : null, blank: true };
}
/** An attachment of a table a field device is never sent is not fetched or uploaded by one either. */
function assertFieldTable(ctx, t) {
  if (syncScope(ctx).field && FS.excluded(t.name)) throw forbidden('This is outside what a field device holds');
}

module.exports = (r) => {
  r.get('/api/sync/pull', requireLocalMode, auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:read')) throw forbidden('Your role cannot sync client data');
    const since = ctx.query.get('since') || NEVER;
    const limit = Math.min(Number(ctx.query.get('limit')) || PULL_LIMIT, PULL_LIMIT);
    // The device's scope is the office's record of the device this session signed in from, never the request's word.
    const s = syncScope(ctx); const device = s.device;
    const field = s.field ? FS.context(ctx.user.id, FS.windowDays(db.getSetting)) : null;
    const out = pull(ctx.user, since, { limit, scope: ctx.query.get('scope'), field });
    // From the first field-scope answer on, the device's pushes are held to the field scope (server/rules/push.js);
    // once a full-scope pull has completed after it, its rows are whole again and nothing of it is blanked on the way in.
    if (device && field && !device.field_applied_at) db.run(`UPDATE devices SET field_applied_at=? WHERE id=?`, db.now(), device.id);
    if (device && !field && device.field_applied_at && out.complete) db.run(`UPDATE devices SET field_applied_at=NULL WHERE id=?`, device.id);
    // The person's own per-user grants and denies (1.15.0): the device's kernel applies the same permissions
    // as the office (server/auth.js effectivePerms), so a navigator held to their caseload at the office is
    // held to it on a device other people also sign in to (local/sync.js applyPull).
    out.permission_overrides = db.all(`SELECT permission, mode, reason, granted_at FROM user_permission_overrides WHERE user_id=? ORDER BY permission`, ctx.user.id);
    audit.log({ user: ctx.user, action: 'sync.pull', ip: ctx.ip, details: { since: since.split('~')[0], backfill: since.includes(BF_MARK) || undefined, complete: out.complete, scope_changed: out.scope_changed || undefined, field: field ? true : undefined, field_reset: out.field_reset || undefined, dropped: out.scope_changed ? { clients: out.dropped_clients.length, rows: out.dropped_rows.length } : undefined, rows: Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]).filter(([, n]) => n)) } });
    return out;
  });

  r.post('/api/sync/push', requireLocalMode, auth.requireAuth, (ctx) => {
    if (!auth.hasPerm(ctx.user, 'clients:write')) throw forbidden('Your role cannot sync client data');
    if (!ctx.body || typeof ctx.body !== 'object') throw badRequest('JSON body required');
    const { device, field: inField } = syncScope(ctx);
    const pf = pushField(ctx.user, device, inField);
    const res = push(ctx.user, ctx.body, pf);
    audit.log({ user: ctx.user, action: 'sync.push', ip: ctx.ip, details: { applied: res.applied, rejected: res.rejected.length, field: pf ? true : undefined } });
    return res;
  });

  // Blobs (photos, template files, form attachments) are kept out of the sync payload and fetched by id.
  r.get('/api/sync/blob/:table/:id/:column', requireLocalMode, auth.requireAuth, (ctx) => {
    const t = SYNC.tables.find(x => x.name === ctx.params.table && (x.blob || []).includes(ctx.params.column));
    if (!t) throw badRequest('Not a synchronised attachment');
    if (t.writePerm && !auth.hasPerm(ctx.user, t.writePerm.replace(/:(write|manage)$/, ':read')) && !auth.hasPerm(ctx.user, t.writePerm)) throw forbidden('You cannot read this attachment');
    assertFieldTable(ctx, t);
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
    assertFieldTable(ctx, t);
    const row = db.one(`SELECT * FROM ${t.name} WHERE id=?`, ctx.params.id);
    if (!row) throw require('../http').notFound('Upload the record before its attachment');
    if (t.clientCol && row[t.clientCol]) auth.assertClientAccess(ctx, row[t.clientCol]);
    const value = ctx.body && ctx.body.value;
    if (typeof value !== 'string' || !value) throw badRequest('value is required');
    // Whose file this is (security review of 1.16.0, M1). A device fills in the file of a row its own push
    // created, while it is still empty; anything else replaces a stored file, which is a change to the record:
    // its table's rules (a completed form is a supervisor's), and its creator's or records:manage-others'. A
    // completed form's signed copy is never replaced this way.
    const R = require('../rules').forTable(t.name);
    const mine = !!R.createdBy[0] && row[R.createdBy[0]] === ctx.user.id;
    if (!(row[ctx.params.column] == null && mine)) {
      if (row[ctx.params.column] != null && R.fileFrozen && R.fileFrozen(row)) throw forbidden('This file belongs to a completed form and cannot be replaced');
      require('../rules').assertEditable(t.name, ctx, row);
      if (!mine && !auth.hasPerm(ctx.user, 'records:manage-others')) throw forbidden('Only the person who added this file, or a supervisor, can replace it');
    }
    // The bytes are checked as the upload routes check them: a resource photo is a picture, whatever the row says.
    if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) throw badRequest('value must be base64');
    const buf = Buffer.from(value, 'base64');
    const sets = { [ctx.params.column]: t.enc.includes(ctx.params.column) ? encrypt(value) : value, bytes: buf.length };
    if (t.name === 'resource_photos') {
      sets.content_type = require('./resources').sniffPicture(buf);
      if (!sets.content_type) throw badRequest('A picture must be a JPEG, PNG or WebP image');
    }
    db.run(`UPDATE ${t.name} SET ${Object.keys(sets).map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...Object.values(sets), db.now(), row.id);
    audit.log({ user: ctx.user, action: 'sync.blob.upload', entity: t.name, entityId: row.id, clientId: t.clientCol ? row[t.clientCol] : null, ip: ctx.ip, details: { bytes: value.length } });
    return { ok: true };
  });
};
module.exports.pull = pull; module.exports.push = push; module.exports.fieldContext = fieldContext;
// For test/perf-sync.test.js, which checks the two-pass page against the one-pass algorithm it replaced.
module.exports.scopeSql = scopeSql;
