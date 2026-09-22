'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db;

function open(dbPath = config.dbPath) {
  if (db) return db;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  initialise(db, fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'), dbPath);
  if (dbPath !== ':memory:') for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.chmodSync(f, 0o600); } catch {} }
  return db;
}

// Used by the local (in-browser) kernel: open from serialized bytes instead of a file path.
function openWith(bytes) {
  if (db) return db;
  db = new DatabaseSync(':memory:', bytes || undefined);
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch {}
  initialise(db, safeSchema());
  return db;
}
// schema.sql is the source of truth. schema-text.js is a generated copy of it, used only in the browser
// kernel where there is no filesystem; scripts/build-local.js regenerates it and CI fails if it drifts.
function safeSchema() {
  try { return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'); }
  catch { return require('./schema-text.js'); }
}

// Lightweight forward-only migrations keyed by settings.schema_version.
const addColumn = (d, table, col, def) => { const cols = d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
const tableCols = (d, table) => d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
const tableExists = (d, table) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);

// Move a plaintext column's contents into an encrypted column and drop the plaintext one.
// No-op on a database where schema.sql already created the encrypted form (a fresh install).
function encryptColumn(d, table, oldCol, newCol) {
  if (!tableExists(d, table)) return;
  const cols = tableCols(d, table);
  if (!cols.includes(oldCol)) return;
  const { encrypt } = require('./crypto');
  addColumn(d, table, newCol, 'TEXT');
  const rows = d.prepare(`SELECT id, ${oldCol} AS v FROM ${table} WHERE ${oldCol} IS NOT NULL AND ${oldCol} <> ''`).all();
  const upd = d.prepare(`UPDATE ${table} SET ${newCol}=? WHERE id=?`);
  for (const r of rows) upd.run(encrypt(String(r.v)), r.id);
  d.exec(`ALTER TABLE ${table} DROP COLUMN ${oldCol}`);
}

// Rebuild a table from its current definition in schema.sql, copying every column both versions share.
// This is the only way SQLite lets you add NOT NULL to an existing column or relax one to nullable.
// Callers run it with foreign keys disabled (see migrate) — the documented ALTER TABLE recipe.
function rebuildTable(d, schemaText, table, coalesce = {}) {
  if (!tableExists(d, table)) return;
  const m = schemaText.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error(`rebuildTable: no definition for ${table} in schema`);
  const tmp = `__new_${table}`;
  d.exec(`DROP TABLE IF EXISTS ${tmp}`);
  d.exec(`CREATE TABLE ${tmp} (${m[1]}\n)`);
  const oldCols = tableCols(d, table), newCols = tableCols(d, tmp);
  const shared = newCols.filter(c => oldCols.includes(c));
  const select = shared.map(c => coalesce[c] ? `COALESCE(${c}, ${coalesce[c]})` : c).join(', ');
  d.exec(`INSERT INTO ${tmp}(${shared.join(', ')}) SELECT ${select} FROM ${table}`);
  d.exec(`DROP TABLE ${table}`);
  d.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  // Recreate this table's indexes from the schema (DROP TABLE took the originals with it).
  for (const line of schemaText.split('\n')) {
    const im = line.match(new RegExp(`^CREATE( UNIQUE)? INDEX IF NOT EXISTS \\S+ ON ${table}\\(`));
    if (im) d.exec(line.trim());
  }
}
const migrations = [
  // 1: initial schema (created by schema.sql)
  () => {},
  // 2: sync support — updated_at on tables that lacked it, tombstones for hard deletes
  (d) => {
    for (const t of ['assignments', 'consents', 'disclosures', 'budget_lines', 'note_addenda', 'imports', 'import_items']) { addColumn(d, t, 'updated_at', 'TEXT'); d.exec(`UPDATE ${t} SET updated_at = created_at WHERE updated_at IS NULL`); }
    d.exec(`CREATE TABLE IF NOT EXISTS tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (table_name, id))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_tombstones_at ON tombstones(deleted_at)`);
  },
  // 3: treatment center profiles — summary/service tags on resources, photo gallery table
  (d) => {
    for (const [c, t] of [['summary', 'TEXT'], ['service_tags', 'TEXT'], ['levels_of_care', 'TEXT'], ['populations', 'TEXT'], ['intake_process', 'TEXT'], ['cost_notes', 'TEXT']]) addColumn(d, 'resources', c, t);
    d.exec(`CREATE TABLE IF NOT EXISTS resource_photos (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, caption TEXT, content_type TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, width INTEGER, height INTEGER, data_b64 TEXT NOT NULL, thumb_b64 TEXT, sort_order INTEGER NOT NULL DEFAULT 0, uploaded_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_resource_photos ON resource_photos(resource_id, sort_order)`);
  },
  // 4: county form library
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS form_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, category TEXT NOT NULL DEFAULT 'other', version TEXT, filename TEXT, content_type TEXT, bytes INTEGER NOT NULL DEFAULT 0, file_b64 TEXT, fields_json TEXT NOT NULL DEFAULT '[]', instructions TEXT, is_active INTEGER NOT NULL DEFAULT 1, uploaded_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    d.exec(`CREATE TABLE IF NOT EXISTS client_forms (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, template_id TEXT REFERENCES form_templates(id) ON DELETE SET NULL, template_name TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]', values_enc TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','completed','void')), completed_at TEXT, completed_by TEXT REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id), notes TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_client_forms_client ON client_forms(client_id)`);
    d.exec(`CREATE TABLE IF NOT EXISTS client_form_files (id TEXT PRIMARY KEY, client_form_id TEXT NOT NULL REFERENCES client_forms(id) ON DELETE CASCADE, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, filename TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, data_enc TEXT NOT NULL, uploaded_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_client_form_files ON client_form_files(client_form_id)`);
  },
  // 5: PHI that was still in plaintext moves into _enc columns; co-signature, time approval, episodes,
  //    overdose events, coded race, client-less interventions, and the updated_at indexes sync needs.
  (d) => {
    const schemaText = safeSchema();
    for (const [t, from, to] of [
      ['clients', 'goals', 'goals_enc'], ['clients', 'flags', 'flags_enc'],
      ['notes', 'title', 'title_enc'], ['interventions', 'summary', 'summary_enc'],
      ['import_items', 'title', 'title_enc'],
      ['consents', 'recipient', 'recipient_enc'], ['consents', 'purpose', 'purpose_enc'], ['consents', 'scope', 'scope_enc'],
      ['disclosures', 'disclosed_to', 'recipient_enc'], ['disclosures', 'purpose', 'purpose_enc'], ['disclosures', 'info_disclosed', 'what_enc'],
    ]) encryptColumn(d, t, from, to);

    addColumn(d, 'clients', 'race_codes', 'TEXT');
    addColumn(d, 'users', 'requires_cosign', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(d, 'users', 'supervisor_id', 'TEXT REFERENCES users(id)');
    for (const [c, def] of [['cosign_required', 'INTEGER NOT NULL DEFAULT 0'], ['cosigned_by', 'TEXT REFERENCES users(id)'], ['cosigned_at', 'TEXT'], ['cosignature_hash', 'TEXT'], ['cosign_note', 'TEXT']]) addColumn(d, 'notes', c, def);
    for (const [c, def] of [['status', "TEXT NOT NULL DEFAULT 'draft'"], ['submitted_at', 'TEXT'], ['approved_by', 'TEXT REFERENCES users(id)'], ['approved_at', 'TEXT'], ['approval_note', 'TEXT']]) addColumn(d, 'time_entries', c, def);
    addColumn(d, 'consents', 'revoked_by', 'TEXT REFERENCES users(id)');
    for (const [c, def] of [['consent_revoked', 'INTEGER NOT NULL DEFAULT 0'], ['outcome_recorded_at', 'TEXT'], ['episode_id', 'TEXT REFERENCES episodes(id)']]) addColumn(d, 'referrals', c, def);
    for (const [c, def] of [['source', 'TEXT'], ['source_ref', 'TEXT']]) addColumn(d, 'disclosures', c, def);

    // Tables whose updated_at was added as a nullable column in migration 2 (sync cannot index a COALESCE),
    // plus interventions, whose client_id has to become nullable for community naloxone distribution.
    for (const t of ['assignments', 'budget_lines', 'note_addenda', 'imports', 'import_items', 'consents', 'disclosures'])
      rebuildTable(d, schemaText, t, { updated_at: 'created_at' });
    rebuildTable(d, schemaText, 'interventions', { updated_at: 'created_at' });

    // episodes / overdose_events are new tables; schema.sql created them on a fresh database, and
    // exec'ing the same statements here creates them on an upgraded one.
    for (const t of ['episodes', 'overdose_events']) {
      const m = schemaText.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
      if (m) d.exec(m[0]);
    }
    for (const line of schemaText.split('\n')) if (/^CREATE( UNIQUE)? INDEX IF NOT EXISTS /.test(line.trim())) { try { d.exec(line.trim()); } catch {} }

    // Every existing client keeps being served until someone closes them out: open an episode so that
    // admissions and discharges are countable from the day this migration runs.
    if (tableExists(d, 'episodes')) {
      const { uuid } = require('./crypto');
      const open = d.prepare(`SELECT id, intake_date, created_at, created_by, referral_source, status, discharge_date, discharge_reason FROM clients WHERE deleted_at IS NULL`).all();
      const ins = d.prepare(`INSERT INTO episodes(id,client_id,opened_at,opened_by,referral_source,closed_at,discharge_reason,status) VALUES(?,?,?,?,?,?,?,?)`);
      const has = d.prepare(`SELECT 1 FROM episodes WHERE client_id=?`);
      for (const c of open) {
        if (has.get(c.id)) continue;
        const closed = c.status === 'closed' || c.status === 'deceased';
        ins.run(uuid(), c.id, c.intake_date || String(c.created_at).slice(0, 10), c.created_by, c.referral_source, closed ? (c.discharge_date || c.created_at) : null, closed ? c.discharge_reason : null, closed ? 'closed' : 'open');
      }
    }
  },
  // 6: coarse blind indexes so search tolerates typos and partial surnames, and duplicate detection has
  //    something to match on, without putting any name in the clear.
  (d) => {
    const schemaText = safeSchema();
    addColumn(d, 'clients', 'merged_into', 'TEXT REFERENCES clients(id)');
    addColumn(d, 'clients', 'name_prefix_idx', 'TEXT');
    addColumn(d, 'clients', 'name_phonetic_idx', 'TEXT');
    const { decrypt } = require('./crypto');
    const M = require('./clients-model');
    const upd = d.prepare(`UPDATE clients SET name_prefix_idx=?, name_phonetic_idx=? WHERE id=?`);
    for (const c of d.prepare(`SELECT id, last_name_enc FROM clients`).all()) {
      let last = '';
      try { last = c.last_name_enc ? decrypt(c.last_name_enc) : ''; } catch { continue; } // a row we cannot read keeps null indexes
      upd.run(M.namePrefixIndex(last), M.namePhoneticIndex(last), c.id);
    }
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_clients_name_/.test(line.trim())) d.exec(line.trim());
  },
  // 7: attachment bytes become nullable. Rows now reach a device before their bytes do — a sync payload
  //    carrying every photo and scan inline was tens of megabytes the phone could not parse — so an
  //    attachment row has to be insertable while its content is still on its way.
  (d) => {
    const schemaText = safeSchema();
    for (const t of ['resource_photos', 'client_form_files']) rebuildTable(d, schemaText, t);
  },
  // 8: assignments record the instant they were ended. Ending one used to leave the worker with the client
  //    for the rest of the day, because access was decided by date alone — not what a supervisor taking
  //    somebody off a case expects to happen.
  (d) => { addColumn(d, 'assignments', 'ended_at', 'TEXT'); },
  // 9: a logged contact says whether it was a phone call or a text message. Everything already recorded
  //    was a call, which is what the default says.
  (d) => { addColumn(d, 'calls', 'method', `TEXT NOT NULL DEFAULT 'phone' CHECK (method IN ('phone','text'))`); },
  // 10: referral and engagement dates on clients, so time-to-engagement (a common navigator KPI) can be
  //     tracked per client instead of only inferred from intake_date.
  (d) => { addColumn(d, 'clients', 'referral_date', 'TEXT'); addColumn(d, 'clients', 'engagement_date', 'TEXT'); },
  // 11: optional single sign-on. An administrator links an existing account to the county identity
  //     provider's 'sub' claim; OIDC login only ever signs in to an already-linked account.
  (d) => { addColumn(d, 'users', 'oidc_subject', 'TEXT'); d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_subject ON users(oidc_subject) WHERE oidc_subject IS NOT NULL`); },
  // 12: device tracking for local-mode phones/tablets, so a lost device can be revoked or wiped the next
  //     time it tries to sync (server/devices.js).
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_ip TEXT, sync_count INTEGER NOT NULL DEFAULT 0, wipe_requested_at TEXT, revoked_at TEXT)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)`);
  },
  // 13: nested budget allocations — a budget line can now sit inside a larger one instead of every line
  //     being a flat peer under the fund (server/routes/budget.js enforces same-fund + no cycles).
  (d) => {
    addColumn(d, 'budget_lines', 'parent_id', 'TEXT REFERENCES budget_lines(id) ON DELETE CASCADE');
    d.exec(`CREATE INDEX IF NOT EXISTS idx_budget_lines_parent ON budget_lines(parent_id)`);
  },
  // 14: an intervention with a direct cost against a fund can now name the specific allocation it draws
  //     down — interventions already had funding_source_id and cost, but nothing to point at which budget
  //     line, so recording a service never actually reduced a budget. server/routes/interventions.js now
  //     auto-posts a matching (pending) expenditure from these three columns.
  (d) => { addColumn(d, 'interventions', 'budget_line_id', 'TEXT REFERENCES budget_lines(id) ON DELETE SET NULL'); },
  // 15: county policies, procedures and contracts — an uploaded-file library (server/routes/documents.js),
  //     searched by title/category/metadata only, the same shape as the existing form template library.
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS policy_documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('policy','procedure','contract')),
      description TEXT, effective_date TEXT, expires_at TEXT, filename TEXT, content_type TEXT, bytes INTEGER NOT NULL DEFAULT 0, file_b64 TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      uploaded_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_policy_documents_cat ON policy_documents(category)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_policy_documents_updated ON policy_documents(updated_at)`);
  },
  // 16: at most one expenditure per intervention — a second one would double-count that service's cost.
  //     Before this, intervention_id was a writable field on the generic expenditures POST, so a database
  //     that saw any traffic on that route could already have duplicates; keep the most recently updated
  //     row's link and unlink the rest (they stay, just as ordinary expenditures with no linked service)
  //     rather than deleting real financial records during a migration.
  (d) => {
    const dupes = d.prepare(`SELECT intervention_id, id FROM expenditures WHERE intervention_id IS NOT NULL
      AND id NOT IN (SELECT id FROM expenditures e2 WHERE e2.intervention_id=expenditures.intervention_id ORDER BY e2.updated_at DESC LIMIT 1)`).all();
    const unlink = d.prepare(`UPDATE expenditures SET intervention_id=NULL WHERE id=?`);
    for (const row of dupes) unlink.run(row.id);
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_intervention_unique ON expenditures(intervention_id) WHERE intervention_id IS NOT NULL`);
  },
  // 17: why an expenditure was rejected. Time entries have carried this since their approval step was
  //     added; expenditures accepted a note on the approve route and then dropped it on the floor.
  (d) => { addColumn(d, 'expenditures', 'approval_note', 'TEXT'); },
  // 18: a first name on its own finds the person (the search box always said it would), and the policy
  //     library keeps the words inside each file so a policy can be found by what it says, not only its
  //     title. Existing documents are indexed by server/routes/documents.js the next time they are saved.
  (d) => {
    const schemaText = safeSchema();
    addColumn(d, 'clients', 'first_name_idx', 'TEXT');
    addColumn(d, 'clients', 'first_name_prefix_idx', 'TEXT');
    const { decrypt, blindIndex } = require('./crypto');
    const M = require('./clients-model');
    const upd = d.prepare(`UPDATE clients SET first_name_idx=?, first_name_prefix_idx=? WHERE id=?`);
    for (const c of d.prepare(`SELECT id, first_name_enc FROM clients`).all()) {
      let first = '';
      try { first = c.first_name_enc ? decrypt(c.first_name_enc) : ''; } catch { continue; }
      upd.run(blindIndex(String(first || '').trim().toLowerCase()), M.namePrefixIndex(first), c.id);
    }
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_clients_first_name/.test(line.trim())) d.exec(line.trim());
    addColumn(d, 'policy_documents', 'search_text', 'TEXT');
  },
  // 19: a client whose status is NULL or blank (rows written before the value was enforced end to end,
  //     including through sync) showed no status at all in the header and Overview. The column's default
  //     is 'active', so that is what an empty value has always meant.
  (d) => { d.exec(`UPDATE clients SET status='active' WHERE status IS NULL OR TRIM(status)=''`); },
];
// A new database is created from schema.sql, which is always current, and stamped at the latest version.
// An existing one is only ever stepped forward by migrations: replaying today's schema over yesterday's
// tables would try to index columns that do not exist yet. test/migrations.test.js asserts the two
// routes end at byte-identical schemas.
function initialise(d, schemaText, dbPath) {
  const fresh = !d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'`).get();
  if (fresh) {
    d.exec(schemaText);
    d.prepare(`INSERT INTO settings(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(migrations.length));
    return;
  }
  migrate(d, dbPath);
}

// A migration is the one operation a county cannot retry: if it goes wrong the old database is already
// rewritten. Take a consistent copy first (VACUUM INTO, so it is a real snapshot rather than a file copy
// racing a writer) and keep the last few. Only for file-backed databases — :memory: has nothing to save.
const SNAPSHOTS_KEPT = 5;
function snapshotBeforeMigration(d, dbPath, fromVersion) {
  if (!dbPath || dbPath === ':memory:') return '';
  const dir = path.join(path.dirname(dbPath), 'pre-migration');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${path.basename(dbPath)}.v${fromVersion}.${stamp}.db`);
  fs.mkdirSync(dir, { recursive: true });
  // VACUUM INTO refuses to overwrite, so a leftover with this exact name would fail the upgrade.
  try { fs.unlinkSync(file); } catch {}
  d.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { fs.chmodSync(file, 0o600); } catch {}
  try {
    const old = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(dbPath) + '.v')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - SNAPSHOTS_KEPT))) fs.unlinkSync(path.join(dir, f));
  } catch {}
  return file;
}

// A stable identity for one foreign_key_check violation, so the same pre-existing orphan can be recognised
// again after a migration step that rebuilds its table (SQLite's ALTER TABLE recipe for anything beyond
// adding a column copies every row into a new table, which reassigns rowids) — without it, a renumbered but
// otherwise unchanged orphan would look "new" on the next check.
function fkViolationKeys(d) {
  return new Set(d.prepare('PRAGMA foreign_key_check').all().map((r) => `${r.table}:${r.rowid}:${r.parent}:${r.fkid}`));
}

function migrate(d, dbPath) {
  const row = d.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get();
  let v = row ? Number(row.value) : 0;
  // A database written by a newer build has columns and tables this code does not know about. Refuse rather than
  // corrupt it: the county must upgrade SUDS (or restore the backup that matches this version).
  if (v > migrations.length) throw new Error(`This database was created by a newer version of SUDS (schema ${v}; this build understands ${migrations.length}). Upgrade SUDS before opening it.`);
  if (v < migrations.length) {
    let snapshot = '';
    try { snapshot = snapshotBeforeMigration(d, dbPath, v); }
    catch (e) { throw new Error(`Could not snapshot the database before upgrading it from schema ${v} to ${migrations.length}: ${e.message}. Free up disk space or back up ${dbPath} by hand, then start SUDS again.`); }
    if (snapshot) console.log(`[suds] upgrading schema ${v} -> ${migrations.length}; snapshot saved to ${snapshot}`);
  }
  let remaining = [];
  for (let i = v; i < migrations.length; i++) {
    // DDL is transactional in SQLite: apply the migration and stamp the version together, so a crash midway
    // can never leave a half-applied schema wearing the old version number.
    // The ALTER TABLE recipe for rebuilding a table requires foreign keys to be off, and the pragma is a
    // no-op inside a transaction, so it goes here. foreign_key_check below proves nothing new was orphaned.
    d.exec('PRAGMA foreign_keys = OFF');
    d.exec('BEGIN');
    try {
      // A foreign key already pointing at a missing row — from a bug elsewhere, an interrupted sync, or
      // manual tinkering, unrelated to this upgrade — must not brick every future boot forever, with a full
      // device wipe as the only way back in. Only an orphan this specific step introduces is treated as
      // fatal (a real bug in that migration); anything already there when the step started is tolerated and
      // reported, never silently dropped.
      const before = fkViolationKeys(d);
      migrations[i](d);
      const after = d.prepare('PRAGMA foreign_key_check').all();
      const introduced = after.filter((r) => !before.has(`${r.table}:${r.rowid}:${r.parent}:${r.fkid}`));
      if (introduced.length) throw new Error(`migration ${i + 1} introduced ${introduced.length} new orphaned row(s), first in table ${introduced[0].table}`);
      remaining = after;
      d.prepare(`INSERT INTO settings(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(String(i + 1));
      d.exec('COMMIT');
    } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
    finally { d.exec('PRAGMA foreign_keys = ON'); }
  }
  if (remaining.length) {
    const byTable = {};
    for (const r of remaining) byTable[r.table] = (byTable[r.table] || 0) + 1;
    console.warn(`[suds] this database has ${remaining.length} pre-existing orphaned reference(s), not introduced by this upgrade, by table: ${Object.entries(byTable).map(([t, n]) => `${t}=${n}`).join(', ')}. Records are otherwise intact; anything joined through the missing reference may just be absent from a report until it is repaired.`);
  }
}

function get() { if (!db) open(); return db; }
function close() { if (db) { db.close(); db = undefined; } }

// helpers
function now() { return new Date().toISOString(); }
function all(sql, ...params) { return get().prepare(sql).all(...params); }
function one(sql, ...params) { return get().prepare(sql).get(...params); }
function run(sql, ...params) { return get().prepare(sql).run(...params); }
// Transactions nest: the outermost is a real BEGIN/COMMIT, inner ones become savepoints, so a helper that
// opens its own transaction inside a route that already has one cannot silently roll the outer one back.
let txDepth = 0;
function transaction(fn) {
  const d = get();
  const depth = txDepth++;
  const sp = `sp_tx_${depth}`;
  d.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  try {
    const r = fn();
    d.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    txDepth--;
    return r;
  } catch (e) {
    txDepth--;
    try { d.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); }
    catch (rollbackError) { if (depth === 0) txDepth = 0; console.error('[suds] rollback failed:', rollbackError.message); }
    throw e;
  }
}
/** Run fn inside a savepoint. Returns what fn returned, or calls onError and returns undefined if it threw. */
function savepoint(fn, onError) {
  const d = get();
  const sp = `sp_${txDepth}_${savepoint.n = (savepoint.n || 0) + 1}`;
  d.exec(`SAVEPOINT ${sp}`);
  try { const r = fn(); d.exec(`RELEASE ${sp}`); return r; }
  catch (e) { try { d.exec(`ROLLBACK TO ${sp}`); d.exec(`RELEASE ${sp}`); } catch {} if (onError) onError(e); else throw e; }
}
// The key this database was written with, remembered on first open and checked on every open after. A
// server started with different keys (a data folder moved without its keys.json, an environment variable
// mistyped) otherwise runs looking healthy while every decrypt fails and every new write mixes two keys.
function checkKeyFingerprint() {
  const fp = require('./crypto').keyFingerprint();
  const stored = getSetting('key_fingerprint', null);
  if (!stored) { setSetting('key_fingerprint', fp); return { first: true }; }
  if (stored !== fp) throw new Error('The encryption key this server was started with is not the key this database was written with. Nothing has been changed. Restore the key backup (keys.json) saved at setup or set SUDS_ENCRYPTION_KEY to the original key, then start again. If the key was deliberately rotated with scripts/rotate-key.js, that script records the new key; a database this happened to some other way needs the original key back.');
  return { first: false };
}
function getSetting(key, def = null) { const r = one(`SELECT value FROM settings WHERE key=?`, key); return r ? r.value : def; }
function setSetting(key, value) {
  run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`, key, String(value));
}

function tombstone(table, id) { run(`INSERT OR REPLACE INTO tombstones(table_name,id,deleted_at) VALUES(?,?,?)`, table, id, now()); }
module.exports = { open, openWith, get, close, LATEST_SCHEMA_VERSION: migrations.length, now, all, one, run, transaction, savepoint, getSetting, setSetting, tombstone, checkKeyFingerprint };
