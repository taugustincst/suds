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
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SECURE_DELETE);
    initialise(db, fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'), dbPath);
    sealSnapshots(dbPath);
  } catch (e) {
    // A file this build refuses (a newer schema, a failed migration) must not be left as the open handle:
    // every later db.get() would then serve the rejected database as if the open had succeeded.
    try { db.close(); } catch {}
    db = undefined;
    throw e;
  }
  if (dbPath !== ':memory:') for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.chmodSync(f, 0o600); } catch {} }
  openedPath = dbPath;
  return db;
}

// Used by the local (in-browser) kernel: open from serialized bytes instead of a file path. Always opens
// what it is given: a copy already open is closed first (the browser shim drops it unsaved), because the
// caller has just read these bytes as the current database and a page that kept its earlier in-memory copy
// would later save that stale copy over them (1.9.2: taking a window back did exactly that).
function openWith(bytes) {
  if (db) { try { db.close(); } catch {} db = undefined; }
  openedPath = null;
  db = bytes ? new DatabaseSync(':memory:', bytes) : new DatabaseSync(':memory:');
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch {}
  try { db.exec(SECURE_DELETE); } catch {}
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

// Deleted and overwritten content is zeroed, not left in the file's free pages and freelist, where anyone with
// the database file could read it back without the key: a plaintext column dropped by encryptColumn, a row
// the retention purge removed, the previous value of an edited field. Security review of 1.13.0, finding 3
// (all 50 file names of a 1.12 install were still readable in suds.db after migration 42 encrypted them).
// Measured on a SUDS-like write mix (20,000 ~600-byte rows inserted one transaction each, half updated, a
// quarter deleted, WAL mode): within the run-to-run noise of about 7% either way, so it is on for every
// connection, not only around migrations (docs/security/ENCRYPTION-AND-KEYS.md).
const SECURE_DELETE = 'PRAGMA secure_delete = ON';
// Set by encryptColumn when it moved a column: the upgrade then ends with a VACUUM (scrubFreePages).
let encryptedColumns = 0;

// Move a plaintext column's contents into an encrypted column and drop the plaintext one.
// No-op on a database where schema.sql already created the encrypted form (a fresh install).
function encryptColumn(d, table, oldCol, newCol) {
  if (!tableExists(d, table)) return;
  const cols = tableCols(d, table);
  if (!cols.includes(oldCol)) return;
  encryptedColumns++;
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
// Numbering (ADR-0007, "Numbering across branches"). A migration's position in this array is the schema
// version it moves a database to, so once released it keeps that position and its code for good. Each entry is
// headed by a comment `// N: what it does` at two spaces' indent, N being its position from 1; a new one is
// appended at the end with the next number, and a branch that meets another branch's migration of the same
// number renumbers its own (write migrations self-contained and idempotent so they can be). Continuation lines
// of a header are indented further. scripts/migration-order.js (test/migration-order.test.js) fails when a
// released migration moved, changed or went, or a header does not carry its position.
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
    // Errors ignored here on purpose: some of these indexes name columns a later migration adds. Anything
    // still missing once every migration has run is created, or reported, by ensureIndexes() below.
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
  // 19: compliance review. Free text that reveals a named person's diagnosis moves into _enc columns
  //     (call purposes, referral outcomes/barriers/notes, task titles, overdose substances); Part 2 consents
  //     record their expiry event, paper signature and redisclosure notice; disclosures made without consent
  //     carry an encrypted justification; clients can be placed on legal hold; break-glass events queue
  //     for supervisor review; patient-rights requests get a table with a 30-day clock.
  (d) => {
    const schemaText = safeSchema();
    for (const [t, from, to] of [
      ['calls', 'purpose', 'purpose_enc'], ['referrals', 'outcome', 'outcome_enc'], ['referrals', 'barrier', 'barrier_enc'], ['referrals', 'notes', 'notes_enc'],
      ['overdose_events', 'substances', 'substances_enc'],
    ]) encryptColumn(d, t, from, to);
    // tasks.title is NOT NULL, and stays so: every row (even a blank title) is encrypted before the
    // plaintext goes, then the table is rebuilt so the new column carries the constraint.
    // The rebuild takes today's schema.sql, which no longer has the plaintext tasks.description (migration
    // 24), and copies only the columns both share — so the details are encrypted here first, or a database
    // older than 19 would lose them in this step before 24 could move them.
    encryptColumn(d, 'tasks', 'description', 'description_enc');
    if (tableExists(d, 'tasks') && tableCols(d, 'tasks').includes('title')) {
      const { encrypt } = require('./crypto');
      addColumn(d, 'tasks', 'title_enc', 'TEXT');
      const upd = d.prepare(`UPDATE tasks SET title_enc=? WHERE id=?`);
      for (const r of d.prepare(`SELECT id, title FROM tasks`).all()) upd.run(encrypt(String(r.title ?? '')), r.id);
      d.exec(`ALTER TABLE tasks DROP COLUMN title`);
      rebuildTable(d, schemaText, 'tasks');
    }
    addColumn(d, 'clients', 'legal_hold', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(d, 'clients', 'legal_hold_reason', 'TEXT');
    addColumn(d, 'consents', 'expires_event', 'TEXT');
    addColumn(d, 'consents', 'signed_on_paper', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(d, 'consents', 'redisclosure_notice_given', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(d, 'disclosures', 'justification_enc', 'TEXT');
    for (const t of ['breakglass_events', 'patient_requests']) {
      const m = schemaText.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
      if (m) d.exec(m[0]);
    }
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_(breakglass|patient_requests)/.test(line.trim())) d.exec(line.trim());
  },
  // 20: navigator field tools — a preferred name / alias finds the person too; an author can ask a
  //     supervisor to review/co-sign a note; and a harm-reduction supply inventory that visits draw down.
  (d) => {
    const schemaText = safeSchema();
    addColumn(d, 'clients', 'preferred_name_idx', 'TEXT');
    const { decrypt } = require('./crypto');
    const M = require('./clients-model');
    const upd = d.prepare(`UPDATE clients SET preferred_name_idx=? WHERE id=?`);
    for (const c of d.prepare(`SELECT id, preferred_name_enc FROM clients WHERE preferred_name_enc IS NOT NULL`).all()) {
      let pref = '';
      try { pref = decrypt(c.preferred_name_enc); } catch { continue; }
      upd.run(M.preferredNameIndex(pref), c.id);
    }
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_clients_preferred_name/.test(line.trim())) d.exec(line.trim());
    addColumn(d, 'notes', 'cosign_requested', 'INTEGER NOT NULL DEFAULT 0');
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS supply_stock \([\s\S]*?\n\);/);
    if (m) d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_supply_stock/.test(line.trim())) d.exec(line.trim());
  },
  // 21: a client whose status is NULL or blank (rows written before the value was enforced end to end,
  //     including through sync) showed no status at all in the header and Overview. The column's default
  //     is 'active', so that is what an empty value has always meant.
  (d) => { d.exec(`UPDATE clients SET status='active' WHERE status IS NULL OR TRIM(status)=''`); },
  // 22: spreadsheet import idempotency — a hash per imported row (import_rows), so the same file imported
  //     twice does not double every visit, call, hour and expenditure it holds.
  (d) => {
    const schemaText = safeSchema();
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS import_rows \([\s\S]*?\n\);/);
    if (m) d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_import_rows/.test(line.trim())) d.exec(line.trim());
  },
  // 23: a referral's follow-up to-do remembers which referral it belongs to. Recording one referral's
  //     outcome used to close every "Follow up on referral…" to-do on the client, by title prefix.
  (d) => { addColumn(d, 'tasks', 'referral_id', 'TEXT REFERENCES referrals(id) ON DELETE SET NULL'); },
  // 24: a to-do's details ("detox bed at Granite on Tuesday; bring the MAT letter") reveal as much as its
  //     title, which has been encrypted since 19. tasks.description moves into description_enc and the
  //     plaintext column goes; the table is rebuilt from schema.sql so it matches a fresh install.
  (d) => {
    if (!tableExists(d, 'tasks') || !tableCols(d, 'tasks').includes('description')) return;
    encryptColumn(d, 'tasks', 'description', 'description_enc');
    rebuildTable(d, safeSchema(), 'tasks');
  },
  // 25: self sign-up. A request for an account is a users row that cannot sign in until an administrator
  //     approves it (access_status 'pending'); every existing account is 'active'.
  (d) => {
    addColumn(d, 'users', 'access_status', `TEXT NOT NULL DEFAULT 'active' CHECK (access_status IN ('active','pending','declined'))`);
    addColumn(d, 'users', 'access_note', 'TEXT');
    addColumn(d, 'users', 'requested_at', 'TEXT');
  },
  // 26: name search and duplicate detection work in every script. Blind indexes used to keep only a-z and
  //     0-9, so an Arabic or Cyrillic name indexed as nothing (unsearchable, never flagged as a duplicate)
  //     and "Øster"/"Łecki" lost a letter; they now fold accents, transliterate Ø/Ł/ß/Æ… and keep every
  //     Unicode letter (server/crypto.js foldText). Every client's indexes are re-derived from the decrypted
  //     values with the same function key rotation uses (clients-model clientIndexes). A migration can
  //     decrypt: the keys are loaded (config) before the database is opened, here and in the local kernel.
  //     A row that cannot be decrypted keeps the indexes it had. No schema change.
  (d) => {
    const { decrypt } = require('./crypto');
    const M = require('./clients-model');
    const cols = ['last_name_idx', 'full_name_idx', 'name_prefix_idx', 'name_phonetic_idx', 'first_name_idx', 'first_name_prefix_idx', 'preferred_name_idx', 'dob_idx', 'phone_idx'];
    const upd = d.prepare(`UPDATE clients SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`);
    for (const c of d.prepare(`SELECT id, first_name_enc, last_name_enc, preferred_name_enc, dob_enc, phone_enc FROM clients`).all()) {
      let plain;
      try { plain = { first_name: decrypt(c.first_name_enc), last_name: decrypt(c.last_name_enc), preferred_name: decrypt(c.preferred_name_enc), dob: decrypt(c.dob_enc), phone: decrypt(c.phone_enc) }; }
      catch { continue; }
      const idx = M.clientIndexes(plain);
      upd.run(...cols.map(k => idx[k]), c.id);
    }
  },
  // 27:
  //     idempotency_keys, so a retried POST is answered once instead of creating everything twice; and
  //     breakglass_events.kind, because the supervisors' review queue now also receives re-admissions of
  //     discharged clients by a worker whose caseload they were not on (POST /api/clients/:id/readmit).
  (d) => {
    addColumn(d, 'breakglass_events', 'kind', "TEXT NOT NULL DEFAULT 'clinical_note'");
    const schemaText = safeSchema();
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS idempotency_keys \([\s\S]*?\n\);/);
    if (m) d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_idempotency/.test(line.trim())) d.exec(line.trim());
  },
  // 28: Settings → Lists. An administrator's changes to the choices on documentation forms (a renamed,
  //     reordered or retired choice, or a programme's own addition) are kept in option_overrides; the
  //     built-in choices stay in code (server/options.js). An existing database starts with none.
  (d) => {
    const schemaText = safeSchema();
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS option_overrides \([\s\S]*?\n\);/);
    if (m) d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_option_overrides/.test(line.trim())) d.exec(line.trim());
  },
  // 29: clinical depth for CalAIM documentation — the problem list
  //     and its change history, the care coordination plan (goals and steps), ASAM six-dimension
  //     assessments and scored outcome measures; and notes.problem_ids, the problems a note addresses.
  //     New tables only, plus one nullable column, so an existing database starts with none of them.
  (d) => {
    addColumn(d, 'notes', 'problem_ids', 'TEXT');
    const schemaText = safeSchema();
    for (const t of ['problems', 'problem_history', 'care_plan_goals', 'care_plan_steps', 'asam_assessments', 'outcome_measures']) {
      const m = schemaText.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
      if (!m) throw new Error(`migration 29: no definition for ${t} in schema`);
      d.exec(m[0]);
      for (const line of schemaText.split('\n')) if (new RegExp(`^CREATE( UNIQUE)? INDEX IF NOT EXISTS \\S+ ON ${t}\\(`).test(line.trim())) d.exec(line.trim());
    }
  },
  // 30: CalOMS Tx state reporting. caloms_records holds each episode's
  //     admission, discharge and annual update records (answers encrypted); an existing database starts
  //     with none and with CalOMS reporting switched off (settings caloms_enabled / caloms_providers).
  (d) => {
    const schemaText = safeSchema();
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS caloms_records \([\s\S]*?\n\);/);
    if (m) d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_caloms_records/.test(line.trim())) d.exec(line.trim());
  },
  // 31: 42 CFR Part 2 (2024 final rule). Consents record the rest of the §2.31 elements (who may disclose,
  //     who signed if not the patient, the revocation and refusal statements, which rule version they were
  //     taken against); subpart E court orders get a table that disclosures point at; a disclosure says
  //     whether it is for a proceeding against the patient, includes SUD counseling notes, and which §2.32
  //     notice went with it; notes can be SUD counseling notes (§2.11); the §2.22 patient notice is
  //     recorded per client; and a complaint log (§2.4) and a breach/incident register. Existing consents
  //     keep rule_version NULL (recorded before the 2024 element list) and are shown as such.
  (d) => {
    const schemaText = safeSchema();
    for (const [c, def] of [['discloser', 'TEXT'], ['signer_relationship', 'TEXT'], ['signer_name_enc', 'TEXT'],
      ['revocation_right_given', 'INTEGER NOT NULL DEFAULT 0'], ['refusal_consequences_given', 'INTEGER NOT NULL DEFAULT 0'], ['rule_version', 'TEXT']]) addColumn(d, 'consents', c, def);
    addColumn(d, 'notes', 'counseling_note', 'INTEGER NOT NULL DEFAULT 0');
    for (const t of ['court_orders', 'part2_notices', 'complaints', 'privacy_incidents', 'privacy_incident_clients']) {
      const m = schemaText.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
      if (m) d.exec(m[0]);
    }
    // After court_orders exists: ADD COLUMN may carry a REFERENCES clause as long as its default is NULL.
    for (const [c, def] of [['court_order_id', 'TEXT REFERENCES court_orders(id) ON DELETE SET NULL'], ['legal_proceeding', 'INTEGER NOT NULL DEFAULT 0'],
      ['counseling_notes', 'INTEGER NOT NULL DEFAULT 0'], ['notice_version', 'TEXT']]) addColumn(d, 'disclosures', c, def);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_(court_orders|part2_notices|complaints|privacy_incident)/.test(line.trim())) d.exec(line.trim());
  },
  // 32: FHIR SMART Backend Services (private_key_jwt). fhir_jwt_assertions remembers each client assertion's
  //     jti until it expires, so an assertion cannot be replayed (server/fhir/jwt.js). A new table only; an
  //     existing database starts with it empty.
  (d) => {
    const schemaText = safeSchema();
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS fhir_jwt_assertions \([\s\S]*?\n\);/);
    if (!m) throw new Error('migration 32: no definition for fhir_jwt_assertions in schema');
    d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_fhir_jwt_assertions/.test(line.trim())) d.exec(line.trim());
  },
  // 33: the audit log becomes append-only in the database (triggers that refuse UPDATE
  //     and DELETE outside the sanctioned maintenance window, server/audit.js maintenance()); accounts
  //     remember when the identity provider last vouched for them and SCIM's id for them; a session records
  //     whether its second factor came from the identity provider.
  (d) => {
    const schemaText = safeSchema();
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS audit_maintenance \([\s\S]*?\n\);/);
    if (m) d.exec(m[0]);
    for (const t of schemaText.match(/CREATE TRIGGER IF NOT EXISTS audit_log_no_\w+ [\s\S]*?END;/g) || []) d.exec(t);
    addColumn(d, 'users', 'idp_seen_at', 'TEXT');
    addColumn(d, 'users', 'scim_external_id', 'TEXT');
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_scim_external_id ON users(scim_external_id) WHERE scim_external_id IS NOT NULL`);
    addColumn(d, 'sessions', 'mfa_source', 'TEXT');
  },
  // 34: the disclosure gate closed where a review found it open (docs/compliance/PART2.md). A register of the
  //     QSOAs and research / audit approvals the non-consent bases rest on (disclosure_agreements); an
  //     incident's title is encrypted, and an incident can be opened by switching the Part 2 programme off;
  //     an incident's link to a client survives the client's purge as a snapshot (code, encrypted name)
  //     instead of being deleted with the record — breach documentation is kept six years.
  (d) => {
    const schemaText = safeSchema();
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS disclosure_agreements \([\s\S]*?\n\);/);
    if (m) d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_disclosure_agreements/.test(line.trim())) d.exec(line.trim());
    // Every title (even an empty one) is encrypted before the plaintext goes, then the table is rebuilt so
    // title_enc carries NOT NULL and the source list gains part2_program_off. Migration 31 creates the table
    // from today's schema on a database that never had it, so either form may be here.
    if (tableExists(d, 'privacy_incidents')) {
      if (tableCols(d, 'privacy_incidents').includes('title')) {
        const { encrypt } = require('./crypto');
        addColumn(d, 'privacy_incidents', 'title_enc', 'TEXT');
        const upd = d.prepare(`UPDATE privacy_incidents SET title_enc=? WHERE id=?`);
        for (const r of d.prepare(`SELECT id, title FROM privacy_incidents`).all()) upd.run(encrypt(String(r.title ?? '')), r.id);
        d.exec(`ALTER TABLE privacy_incidents DROP COLUMN title`);
      }
      rebuildTable(d, schemaText, 'privacy_incidents');
    }
    if (tableExists(d, 'privacy_incident_clients')) {
      for (const c of ['client_code', 'client_name_enc', 'client_purged_at']) addColumn(d, 'privacy_incident_clients', c, 'TEXT');
      const { snapshotOf } = require('./incidents');
      const upd = d.prepare(`UPDATE privacy_incident_clients SET client_code=?, client_name_enc=? WHERE id=?`);
      for (const x of d.prepare(`SELECT x.id, c.client_code, c.first_name_enc, c.last_name_enc FROM privacy_incident_clients x JOIN clients c ON c.id=x.client_id WHERE x.client_code IS NULL`).all()) {
        const snap = snapshotOf(x); upd.run(snap.client_code, snap.client_name_enc, x.id);
      }
      rebuildTable(d, schemaText, 'privacy_incident_clients');
    }
  },
  // 35: a further disclosure review (docs/compliance/PART2.md). A consent records the categories of
  //     information it covers (consents.info_categories), which the FHIR API honours; and a CalOMS Tx
  //     submission is produced once and kept (caloms_submissions), so the file sent is the file accounted.
  //     An existing consent's scope is free text: it is given the 'all' category only when that text says
  //     plainly that it covers everything (GENERAL_SCOPE below); every other one stays NULL and covers nothing
  //     automated until a new consent is recorded with its categories — the conservative reading.
  (d) => {
    const schemaText = safeSchema();
    addColumn(d, 'consents', 'info_categories', 'TEXT');
    const m = schemaText.match(/CREATE TABLE IF NOT EXISTS caloms_submissions \([\s\S]*?\n\);/);
    if (!m) throw new Error('migration 35: no definition for caloms_submissions in schema');
    d.exec(m[0]);
    for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_caloms_submissions/.test(line.trim())) d.exec(line.trim());
    const { decrypt } = require('./crypto');
    const { generalScope } = require('./disclosure');
    const upd = d.prepare(`UPDATE consents SET info_categories='all' WHERE id=?`);
    for (const r of d.prepare(`SELECT id, scope_enc FROM consents WHERE scope_enc IS NOT NULL AND info_categories IS NULL`).all()) {
      let scope = ''; try { scope = decrypt(r.scope_enc); } catch { continue; }
      if (generalScope(scope)) upd.run(r.id);
    }
  },
  // 36: free-text reasons out of plaintext. A court order's vacated reason and a legal hold's reason move into
  //     encrypted columns; a record's delete/merge reason, a legal hold's clearing reason and an episode's
  //     reopen reason get encrypted columns of their own, and the audit entry records only that a reason was
  //     given. (Existing audit entries are hash-chained and append-only, so they are left as they are.)
  (d) => {
    encryptColumn(d, 'court_orders', 'vacated_reason', 'vacated_reason_enc');
    if (tableExists(d, 'court_orders')) addColumn(d, 'court_orders', 'vacated_reason_enc', 'TEXT');
    encryptColumn(d, 'clients', 'legal_hold_reason', 'legal_hold_reason_enc');
    for (const c of ['legal_hold_reason_enc', 'legal_hold_cleared_reason_enc', 'removed_reason_enc']) addColumn(d, 'clients', c, 'TEXT');
    if (tableExists(d, 'episodes')) addColumn(d, 'episodes', 'reopen_reason_enc', 'TEXT');
  },
  // 37: the rest of the free text typed about a client or a note leaves plaintext: an addendum's reason, a
  //     consent's revocation reason, a countersignature note, an assignment's notes (a caseload transfer's
  //     reason), a time entry's or expenditure's description and reviewer's note, a client form's notes and
  //     a client's contact preferences ("safe contact" notes). Staff-only text with no client (a fund's notes,
  //     a list label, a template's description) stays as it is.
  (d) => {
    for (const [t, from, to] of [
      ['note_addenda', 'reason', 'reason_enc'], ['consents', 'revoked_reason', 'revoked_reason_enc'], ['notes', 'cosign_note', 'cosign_note_enc'],
      ['assignments', 'notes', 'notes_enc'], ['time_entries', 'description', 'description_enc'], ['time_entries', 'approval_note', 'approval_note_enc'],
      ['expenditures', 'description', 'description_enc'], ['expenditures', 'approval_note', 'approval_note_enc'], ['client_forms', 'notes', 'notes_enc'],
      ['clients', 'contact_preferences', 'contact_preferences_enc'],
    ]) encryptColumn(d, t, from, to);
  },
  // 38: funding attribution and harm-reduction reporting (docs/compliance/HARM-REDUCTION-REPORTING.md). A
  //     worker's default fund (users.default_fund_id; the programme's is the default_fund_id setting), and the
  //     opioid settlement allowable-use and High Impact Abatement Activity categories on a fund and on an
  //     expenditure. Nothing to backfill: every existing row stays uncategorised until someone chooses.
  (d) => {
    addColumn(d, 'users', 'default_fund_id', 'TEXT');
    for (const t of ['funding_sources', 'expenditures']) for (const c of ['settlement_use', 'settlement_hiaa']) addColumn(d, t, c, 'TEXT');
    // The funder report read a year of visits through a date-only index and a table lookup per visit; the
    // covering index answers it from the index alone (server/funder-report.js). It makes the old one redundant.
    d.exec(`DROP INDEX IF EXISTS idx_interventions_occurred`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_interventions_period ON interventions(occurred_at, funding_source_id, client_id, naloxone_kits, fentanyl_strips)`);
  },
  // 39: the last free text about a person held in plaintext. A consent's witness is usually someone the
  //     client knows (a parent, a partner), and an imported note's metadata carries the client-name hints
  //     sniffed from its text ("Met with J. Smith").
  (d) => {
    encryptColumn(d, 'consents', 'witness', 'witness_enc');
    encryptColumn(d, 'import_items', 'metadata', 'metadata_enc');
  },
  // 40: a session remembers when it last proved who is using it (sessions.reauth_at), so signing a note
  //     shortly after the sign-in, or after the last password given, needs a confirmation rather than the
  //     password typed again. Existing sessions have none and ask for the password the first time.
  (d) => { addColumn(d, 'sessions', 'reauth_at', 'TEXT'); },
  // 41: an authenticator code is accepted once (users.totp_last_step, the last RFC 6238 time-step used), so
  //     a code seen over a shoulder or on the screen cannot sign a note or complete a sign-in again.
  (d) => { addColumn(d, 'users', 'totp_last_step', 'INTEGER'); },
  // 42: names people type or upload leave plaintext: a form attachment's file name and an import's (a scan
  //     or OneNote export is routinely named after the person), and a consent's document reference
  //     ("ROI binder, J. Smith"). A device on an older kernel still sends the old names (sync-tables legacy).
  (d) => {
    encryptColumn(d, 'client_form_files', 'filename', 'filename_enc');
    encryptColumn(d, 'imports', 'filename', 'filename_enc');
    encryptColumn(d, 'consents', 'document_ref', 'document_ref_enc');
  },
  // 43: the same document reference on a court order and on a registered agreement ("court order, J. Smith
  //     case file") was still plaintext. Moved as migration 42 moved a consent's; the API keeps the name
  //     document_ref, and a device on an older kernel still sends it (sync-tables legacy).
  (d) => {
    encryptColumn(d, 'court_orders', 'document_ref', 'document_ref_enc');
    encryptColumn(d, 'disclosure_agreements', 'document_ref', 'document_ref_enc');
  },
  // 44: SUPRT-A records for a State Opioid Response grant (server/suprt.js). A new table; nothing to backfill.
  //     Self-contained and idempotent, so it can be renumbered when merged beside other 1.14.0 migrations.
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS suprt_assessments (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      assessment_type TEXT NOT NULL CHECK (assessment_type IN ('baseline','reassessment','annual','closeout')), assessment_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','complete')), answers_enc TEXT, derived_keys TEXT, exported_at TEXT,
      created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_suprt_assessments_client ON suprt_assessments(client_id, assessment_date)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_suprt_assessments_date ON suprt_assessments(assessment_date)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_suprt_assessments_updated ON suprt_assessments(updated_at)`);
  },
  // 45: supplies by item, site and lot (docs/SUPPLIES.md). The single-number cupboard (supply_stock) becomes
  //     items (supply_items), sites (supply_sites; one, "Main office", to start with) and an append-only stock
  //     ledger (supply_ledger) whose sum is what is on hand; each old count is carried in as an opening
  //     balance at the main office, and each old item keeps its id. A visit records any item it hands out
  //     (intervention_supplies), the site it drew from, and the syringes and sharps brought back.
  //     Self-contained and idempotent: every step checks what is already there.
  (d) => migrateSupplies(d, safeSchema()),
  // 46: the sample data (server/demo.js) wrote a client's preferred name but not its search index until 1.14.0,
  //     so a sample client could not be found by the name it goes by. Every client with a preferred name and no
  //     index gets the index its name derives (clients-model preferredNameIndex, as a save writes it). Only
  //     those rows: an index already written is left alone, and a second run finds nothing to do. A row that
  //     cannot be decrypted keeps what it had (as migration 26). updated_at is not touched: the index is
  //     derived, never synchronised, and each device's own copy of this migration fills in its own.
  (d) => {
    const { decrypt } = require('./crypto');
    const M = require('./clients-model');
    const upd = d.prepare(`UPDATE clients SET preferred_name_idx=? WHERE id=? AND preferred_name_idx IS NULL`);
    for (const c of d.prepare(`SELECT id, preferred_name_enc FROM clients WHERE preferred_name_enc IS NOT NULL AND preferred_name_idx IS NULL`).all()) {
      let name; try { name = decrypt(c.preferred_name_enc); } catch { continue; }
      const idx = M.preferredNameIndex(name);
      if (idx) upd.run(idx, c.id);
    }
  },
  // 47: indexes for what was slow at 20,000 clients, 100,000 visits and 200,000 notes (docs/PERFORMANCE.md): a
  //     worker's caseload, a device's sync pull (client and updated_at together), the Home dashboard's visits
  //     and unsigned notes, a note's addenda, a caseload's notes list, the merged duplicates of a caseload, and
  //     supplies on hand read from the index alone. Four indexes become wider ones and are dropped.
  //     Self-contained and idempotent: each index is created from its line in schema.sql only when missing, so
  //     it can be renumbered beside other 1.14.0 migrations.
  (d) => {
    for (const old of ['idx_intervention_supplies_client', 'idx_supply_ledger_stock', 'idx_notes_client', 'idx_assign_user']) d.exec(`DROP INDEX IF EXISTS ${old}`);
    createIndexesFromSchema(d, safeSchema(), PERF_INDEXES_47);
  },
  // 48: per-user permission overrides — grants and denies on top of the role's PERMS
  // (server/auth.js effectivePerms). One row per (user, permission); mode says which.
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('grant','deny')),
      reason TEXT NOT NULL,
      granted_by TEXT REFERENCES users(id),
      granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, permission)
    )`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_user_perm_overrides_user ON user_permission_overrides(user_id)`);
  },
  // 49: reserved; no schema change in 1.17.0's least-privilege default (server/caseload-default.js keeps its
  //     setting in a settings row, written at first start, so it needed no migration). A documented no-op, kept
  //     so that the numbers below stay as released.
  (d) => { void d; },
  // 50: client-record revision history (1.17.0, server/client-revisions.js): one row per change to a client's
  //     record, with each changed field's value before and after, encrypted. A new table; nothing to backfill
  //     (the values a record held before this release were never kept). Created from schema.sql's own text, so an
  //     upgraded database and a fresh one match; self-contained and idempotent, so it can be renumbered.
  (d) => {
    const text = safeSchema();
    const m = text.match(/CREATE TABLE IF NOT EXISTS client_revisions \([\s\S]*?\n\);/);
    if (!m) throw new Error('migration 50: no definition for client_revisions in schema');
    d.exec(m[0]);
    createIndexesFromSchema(d, text, ['idx_client_revisions_client']);
  },
];
const PERF_INDEXES_47 = ['idx_assign_caseload', 'idx_interventions_sync', 'idx_interventions_dashboard', 'idx_calls_sync', 'idx_notes_list', 'idx_notes_sync', 'idx_notes_drafts', 'idx_note_addenda_note',
  'idx_clients_merged', 'idx_intervention_supplies_sync', 'idx_supply_ledger_onhand', 'idx_supply_ledger_item_created', 'idx_suprt_assessments_sync'];
/** Create the named indexes exactly as schema.sql declares them (so a fresh and an upgraded database match). */
function createIndexesFromSchema(d, schemaText, names) {
  for (const name of names) {
    const line = schemaText.split('\n').map(l => l.trim()).find(l => l.startsWith(`CREATE INDEX IF NOT EXISTS ${name} ON `));
    if (!line) throw new Error(`migration: no definition for index ${name} in schema`);
    d.exec(line);
  }
}

// The site every install starts with: created with this fixed id on a fresh database and by migration 45, so
// an office and every device that syncs with it hold the same row (a device never creates sites of its own).
const MAIN_SITE_ID = 'site-main';
function ensureMainSite(d) {
  d.prepare(`INSERT OR IGNORE INTO supply_sites(id,name,kind,sort_order) VALUES(?,?,?,0)`).run(MAIN_SITE_ID, 'Main office', 'office');
}
function migrateSupplies(d, schemaText) {
  for (const t of ['supply_sites', 'supply_items', 'intervention_supplies', 'supply_ledger']) {
    const m = schemaText.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`));
    if (!m) throw new Error(`migration 45: no definition for ${t} in schema`);
    d.exec(m[0]);
  }
  for (const line of schemaText.split('\n')) if (/^CREATE INDEX IF NOT EXISTS idx_(supply_sites|supply_items|intervention_supplies|supply_ledger)_/.test(line.trim())) d.exec(line.trim());
  addColumn(d, 'users', 'default_site_id', 'TEXT');
  addColumn(d, 'interventions', 'supply_site_id', 'TEXT');
  addColumn(d, 'interventions', 'syringes_returned', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'interventions', 'returns_estimated', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'interventions', 'sharps_returned_litres', 'REAL');
  ensureMainSite(d);
  if (!tableExists(d, 'supply_stock')) return;
  // The old cupboard: one row per item with a count. The item keeps its id (a device that still shows the
  // old row by id finds the item), its category is read from its name, and a count above zero becomes an
  // opening balance at the main office, dated the day it was last changed and recorded by who changed it.
  const { categoryFromName, unitFor } = require('./supply-names');
  const anyone = d.prepare(`SELECT id FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, created_at LIMIT 1`).get();
  const known = new Set(d.prepare(`SELECT id FROM users`).all().map((u) => u.id));
  const addItem = d.prepare(`INSERT OR IGNORE INTO supply_items(id,name,category,unit,quick,sort_order,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const addEntry = d.prepare(`INSERT OR IGNORE INTO supply_ledger(id,item_id,site_id,kind,quantity,lot_number,expires_on,occurred_on,reason,user_id,created_at,updated_at) VALUES(?,?,?,'opening',?,'',NULL,?,?,?,?,?)`);
  const now = new Date().toISOString();
  let order = 0;
  for (const s of d.prepare(`SELECT * FROM supply_stock ORDER BY item COLLATE NOCASE`).all()) {
    const category = categoryFromName(s.item);
    const by = s.updated_by && known.has(s.updated_by) ? s.updated_by : (anyone ? anyone.id : null);
    addItem.run(s.id, String(s.item).trim(), category, unitFor(category, s.item), ['naloxone', 'fentanyl_test_strips'].includes(category) ? 1 : 0, order++, by, s.created_at || now, now);
    if (Number(s.quantity) > 0) addEntry.run(`opening-${s.id}`, s.id, MAIN_SITE_ID, Math.trunc(Number(s.quantity)), String(s.updated_at || now).slice(0, 10), 'carried over from the single-number supply count', by, now, now);
  }
  d.exec(`DROP TABLE supply_stock`);
  d.exec(`DELETE FROM tombstones WHERE table_name='supply_stock'`);
}
// A new database is created from schema.sql, which is always current, and stamped at the latest version.
// An existing one is only ever stepped forward by migrations: replaying today's schema over yesterday's
// tables would try to index columns that do not exist yet. test/migrations.test.js asserts the two
// routes end at byte-identical schemas.
function initialise(d, schemaText, dbPath) {
  const fresh = !d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'`).get();
  if (fresh) {
    d.exec(schemaText);
    d.prepare(`INSERT INTO settings(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(migrations.length));
    // Nothing was ever deleted from a new database, so there is nothing in its free pages to scrub.
    d.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('${SCRUBBED}',?)`).run(new Date().toISOString());
    // A new install is a harm-reduction & outreach programme until someone says otherwise (the setup
    // wizard asks; Settings › Programme changes it). server/programme.js.
    d.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('programme_profile',?)`).run(require('./programme').DEFAULT_PROFILE);
    // New navigators and clinicians start held to their caseload on a new install (server/caseload-default.js).
    d.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('caseload_hold_new_staff','1')`).run();
    ensureMainSite(d);
  } else {
    encryptedColumns = 0;
    migrate(d, dbPath);
    // An upgrade that encrypted a column, and (once) any database from before 1.14.0 — a 1.13.0 install at
    // schema 43 already carries the plaintext its upgrades left in free pages — is vacuumed. Data hygiene,
    // not schema: a setting records it, like reindexNameParts below; no migration.
    if (encryptedColumns || !d.prepare(`SELECT 1 FROM settings WHERE key='${SCRUBBED}'`).get()) scrubFreePages(d, encryptedColumns ? 'column encrypted' : 'once, after upgrading to 1.14.0');
    // A database from before programme profiles: decided once from what it holds, so an upgrade never hides
    // a module the programme was using (server/programme.js defaultForExisting). Data, not schema.
    if (!d.prepare(`SELECT 1 FROM settings WHERE key='programme_profile'`).get()) {
      d.prepare(`INSERT INTO settings(key,value) VALUES('programme_profile',?)`).run(require('./programme').defaultForExisting(d));
    }
    // A database from before 1.17.0: the least-privilege default starts off, recorded once, so an upgrade
    // changes nobody's access silently; Users & permissions recommends turning it on (server/caseload-default.js).
    d.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES('caseload_hold_new_staff','0')`).run();
  }
  reindexNameParts(d);
  ensureIndexes(d, schemaText);
}

// Rebuild the file so nothing deleted survives in it: VACUUM writes every live page afresh and drops the free
// ones (secure_delete zeroes what is deleted from now on, but not what earlier versions left behind), then the
// WAL is checkpointed and truncated so the old pages are not kept there either. A failure (no disk space for
// the copy VACUUM needs) is logged and leaves the setting unset, to be tried at the next start.
const SCRUBBED = 'free_pages_scrubbed_at';
function scrubFreePages(d, reason) {
  const t0 = Date.now();
  try {
    d.exec('VACUUM');
    try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    d.prepare(`INSERT INTO settings(key,value) VALUES('${SCRUBBED}',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(new Date().toISOString());
    try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    console.log(`[suds] ${JSON.stringify({ event: 'db.free_pages_scrubbed', reason, ms: Date.now() - t0 })}`);
  } catch (e) {
    console.warn(`[suds] ${JSON.stringify({ event: 'db.free_pages_scrub_failed', reason, error: String(e && e.message || e).slice(0, 200) })}`);
  }
}

// Once per database: a compound surname ("Quintero-Vasquez") is found by either part, because its
// name_phonetic_idx now carries each part's tokens (clients-model namePhoneticIndex). Clients written before
// that are re-derived here, from the decrypted surname, the way migration 26 rebuilt every index. Data, not
// schema, so it is not a numbered migration; the setting records that it ran. A row that cannot be decrypted
// keeps what it had; a failure leaves the setting unset, to be tried at the next start.
function reindexNameParts(d) {
  try {
    if (d.prepare(`SELECT 1 FROM settings WHERE key='name_parts_indexed'`).get()) return;
    const { decrypt } = require('./crypto');
    const M = require('./clients-model');
    const upd = d.prepare(`UPDATE clients SET name_phonetic_idx=? WHERE id=?`);
    let n = 0, read = 0, unreadable = 0;
    d.exec('BEGIN');
    try {
      for (const c of d.prepare(`SELECT id, last_name_enc, name_phonetic_idx FROM clients`).all()) {
        let last; try { last = decrypt(c.last_name_enc); read++; } catch { unreadable++; continue; }
        if (!M.nameParts(last).length) continue;
        const idx = M.namePhoneticIndex(last);
        if (idx !== c.name_phonetic_idx) { upd.run(idx, c.id); n++; }
      }
      // Nothing readable at all (the wrong keys for this file) is not "done": try again next time.
      if (!unreadable || read) d.prepare(`INSERT INTO settings(key,value) VALUES('name_parts_indexed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(new Date().toISOString());
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    if (n) console.log(`[suds] ${JSON.stringify({ event: 'db.name_parts_reindexed', clients: n })}`);
  } catch (e) {
    console.warn(`[suds] ${JSON.stringify({ event: 'db.name_parts_reindex_failed', error: String(e && e.message || e).slice(0, 200) })}`);
  }
}

// Every index schema.sql declares, checked at every open. Migration 5 creates them all with the errors
// ignored (some index columns a later migration adds), so an index that could not be created at all — a
// UNIQUE index over rows that already break it — used to vanish silently: slow queries, or the duplicates it
// exists to prevent. Anything missing is created now; what still fails is logged (index name and SQLite's
// message, never row values) and reported by /api/health and Security status (indexProblems()).
let lastIndexProblems = [];
function ensureIndexes(d, schemaText) {
  const problems = [];
  for (const raw of schemaText.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\S+) ON /);
    if (!m) continue;
    if (d.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(m[1])) continue;
    try { d.exec(line); }
    catch (e) {
      const error = String(e && e.message || e).slice(0, 200);
      problems.push({ index: m[1], error });
      console.warn(`[suds] ${JSON.stringify({ event: 'db.index_missing', index: m[1], error })}`);
    }
  }
  lastIndexProblems = problems;
  return problems;
}
/** Indexes schema.sql declares that the open database lacks and could not be created: [{ index, error }]. */
function indexProblems() { return lastIndexProblems.slice(); }

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

// After a successful open (every migration applied and checked), the snapshots are sealed: each plaintext
// one is encrypted with the backup key into `<name>.enc`, the frame every SUDS backup uses (it is restored
// like one: `node scripts/backup.js --restore <file>.enc`), and the plaintext is overwritten and removed. A
// sealed snapshot is kept SNAPSHOT_KEEP_DAYS, then deleted; off-host backups are the long-term copies. So a
// plaintext snapshot exists only from the start of an upgrade until the upgrade has succeeded; if one fails,
// it stays as it is for the operator (docs/INSTALL.md), and is sealed at the next successful start. Up to
// 1.13.0 they stayed in plaintext, five at a time, forever: every value a later migration encrypted was
// readable in them (security review of 1.13.0, finding 3). Best effort: a failure is logged, never fatal.
const SNAPSHOT_KEEP_DAYS = 14;
function sealSnapshots(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;
  const backup = require('./backup');
  sealRestoreAsides(dbPath, backup);
  const dir = path.join(path.dirname(dbPath), 'pre-migration');
  let files; try { files = fs.readdirSync(dir); } catch { return; }
  const base = path.basename(dbPath) + '.v';
  for (const f of files.filter(n => n.startsWith(base) && n.endsWith('.db'))) {
    const plain = path.join(dir, f); const sealed = `${plain}.enc`;
    try {
      try { fs.unlinkSync(sealed); } catch {}
      backup.encryptFileSync(plain, sealed);
      backup.secureUnlink(plain);
      sealErrors.delete(plain); console.log(`[suds] ${JSON.stringify({ event: 'db.snapshot_sealed', file: path.basename(sealed) })}`);
    } catch (e) {
      noteSealError(plain, e); console.warn(`[suds] ${JSON.stringify({ event: 'db.snapshot_seal_failed', file: f, error: String(e && e.message || e).slice(0, 200) })}`);
    }
  }
  const cutoff = Date.now() - SNAPSHOT_KEEP_DAYS * 86400000;
  for (const f of files.filter(n => n.startsWith(base) && n.endsWith('.db.enc'))) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); console.log(`[suds] ${JSON.stringify({ event: 'db.snapshot_expired', file: f, days: SNAPSHOT_KEEP_DAYS })}`); } } catch {}
  }
}

// The databases a browser restore set aside (`suds.db.before-restore-<time>`, server/backup.js restoreHeld):
// sealed there as soon as the restore has taken; any still plain (set aside by 1.13.0 or earlier, or a seal
// that failed) are sealed here, and sealed ones are deleted after SNAPSHOT_KEEP_DAYS like the snapshots.
function sealRestoreAsides(dbPath, backup) {
  // Not while a restore is running: it reopens the database it just wrote, and its rollback needs the copy it
  // set aside in plaintext until it has finished; it seals that copy itself.
  if (require('./backup-lock').current()?.name === 'restore') return;
  const dir = path.dirname(dbPath); const base = path.basename(dbPath) + '.before-restore-';
  let files; try { files = fs.readdirSync(dir).filter(n => n.startsWith(base)); } catch { return; }
  const cutoff = Date.now() - SNAPSHOT_KEEP_DAYS * 86400000;
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      if (f.endsWith('.enc')) {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); console.log(`[suds] ${JSON.stringify({ event: 'db.restore_aside_expired', file: f, days: SNAPSHOT_KEEP_DAYS })}`); }
        continue;
      }
      const sealed = `${p}.enc`;
      try { fs.unlinkSync(sealed); } catch {}
      backup.encryptFileSync(p, sealed); backup.secureUnlink(p);
      sealErrors.delete(p); console.log(`[suds] ${JSON.stringify({ event: 'db.restore_aside_sealed', file: path.basename(sealed) })}`);
    } catch (e) {
      noteSealError(p, e); console.warn(`[suds] ${JSON.stringify({ event: 'db.restore_aside_seal_failed', file: f, error: String(e && e.message || e).slice(0, 200) })}`);
    }
  }
}

// A copy of the whole database still in plaintext beside it, once the server is running, means a seal above
// (or restore()'s own) failed: a restore aside or a pre-migration snapshot. Until 1.16.0 that was one warning
// line in the log, and the copy stayed plain until the next start. Now housekeeping retries the seal every hour
// (sealPlaintextCopies), and each copy still plain is reported on Settings → Security status and by
// /api/health, by file name, with what to do (server/security-status.js). `plaintextCopies` lists them; the
// last seal error for each is kept in memory to say why.
const sealErrors = new Map();
function noteSealError(file, e) { sealErrors.set(file, { at: new Date().toISOString(), error: String(e && e.message || e).slice(0, 200) }); }
function plaintextCopies(dbPath = openedPath) {
  if (!dbPath || dbPath === ':memory:') return [];
  if (require('./backup-lock').current()?.name === 'restore') return []; // a restore's own copy, needed plain until it finishes
  const out = [];
  const add = (dir, f, kind) => { const p = path.join(dir, f); let since = null; try { since = fs.statSync(p).mtime.toISOString(); } catch { return; } out.push({ file: f, path: p, kind, since, error: sealErrors.get(p) || null }); };
  const dir = path.dirname(dbPath);
  try { for (const f of fs.readdirSync(dir)) if (f.startsWith(path.basename(dbPath) + '.before-restore-') && !f.endsWith('.enc')) add(dir, f, 'restore'); } catch {}
  const snaps = path.join(dir, 'pre-migration');
  try { for (const f of fs.readdirSync(snaps)) if (f.startsWith(path.basename(dbPath) + '.v') && f.endsWith('.db')) add(snaps, f, 'snapshot'); } catch {}
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
/** Retry sealing every plaintext copy (housekeeping, hourly); returns what is still plain afterwards. */
function sealPlaintextCopies(dbPath = openedPath) {
  if (!dbPath || dbPath === ':memory:') return [];
  if (plaintextCopies(dbPath).length) sealSnapshots(dbPath);
  return plaintextCopies(dbPath);
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

// A read that lets the event loop go between its phases must still read one state of the data. The server
// has one connection, so a transaction on it would take in every other request's writes (and a rollback would
// undo them). readSnapshot(fn) opens a second, read-only connection to the same file instead, begins a read
// transaction on it - in WAL mode that is a snapshot: writers on the main connection carry on, and this reader
// sees none of their commits until it ends - and runs fn with every db call made in fn's own asynchronous
// context (AsyncLocalStorage) answered from it; other requests, interleaved while fn waits, use the main
// connection as before. fn(true) may yield. Where there is no second connection to open - an in-memory
// database (the tests), the browser kernel (no node:async_hooks), or a caller inside a transaction on the main
// connection, whose uncommitted rows a snapshot would not see - fn(false) runs on the main connection and must
// not yield: nothing else runs in between, so it reads one state too (server/publication-release.js).
let snapshotStore = null;
try { const { AsyncLocalStorage } = require('node:async_hooks'); if (typeof AsyncLocalStorage === 'function') snapshotStore = new AsyncLocalStorage(); } catch { snapshotStore = null; }
let openedPath = null;
async function readSnapshot(fn) {
  const file = db && openedPath && openedPath !== ':memory:' ? openedPath : null;
  if (!snapshotStore || !file || txDepth > 0 || snapshotStore.getStore()) return fn(false);
  let conn;
  try {
    conn = new DatabaseSync(file, { readOnly: true });
    conn.exec('PRAGMA busy_timeout = 5000');
    conn.exec('BEGIN');
    // A deferred transaction takes its snapshot at its first read: take it now, before fn yields.
    conn.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (e) {
    try { if (conn) conn.close(); } catch {}
    console.warn('[suds] a read snapshot could not be opened; reading without letting the event loop go:', e && e.message);
    return fn(false);
  }
  try { return await snapshotStore.run(conn, () => fn(true)); }
  finally { try { conn.exec('COMMIT'); } catch {} try { conn.close(); } catch {} }
}
/** Is the code running now inside readSnapshot's snapshot (so its reads come from the second connection)? */
const inSnapshot = () => !!(snapshotStore && snapshotStore.getStore());

function get() { const s = snapshotStore && snapshotStore.getStore(); if (s) return s; if (!db) open(); return db; }
function close() { if (db) { stmts = new Map(); stmtsFor = null; db.close(); db = undefined; openedPath = null; } }
/** Is a database handle open now? Does not open one (unlike get()) — /api/health/ready asks this. */
function isOpen() { return !!db; }

// helpers
function now() { return new Date().toISOString(); }
// Prepared statements are kept and reused, per open handle. Compiling a statement costs several times what
// running a simple one does (a settings read: 9 µs prepared each time, under 2 µs reused; the client list's
// query: 75 µs to compile), and a request runs dozens. Each call below runs its statement to completion
// (all, get and run reset it before returning), so a kept statement holds no read snapshot and the same one
// can serve a nested call. SQLite recompiles a kept statement itself when the schema changes under it. The
// cache is dropped whenever the handle changes (close, reopen, a device loading its copy) and when it fills,
// since SQL built with a variable number of placeholders would otherwise grow it without bound.
const STMT_CACHE_MAX = 2000;
let stmts = new Map(); let stmtsFor = null;
function prepared(sql) {
  // Inside readSnapshot the reads go to its own short-lived connection: prepared there, not cached, so the
  // main connection's statements are neither mixed with its own nor dropped each time a snapshot read runs.
  const snap = snapshotStore && snapshotStore.getStore();
  if (snap) return snap.prepare(sql);
  const d = get();
  if (stmtsFor !== d) { stmts = new Map(); stmtsFor = d; }
  let st = stmts.get(sql);
  if (!st) {
    st = d.prepare(sql);
    if (stmts.size >= STMT_CACHE_MAX) stmts.clear();
    stmts.set(sql, st);
  }
  return st;
}
function all(sql, ...params) { return prepared(sql).all(...params); }
function one(sql, ...params) { return prepared(sql).get(...params); }
function run(sql, ...params) { return prepared(sql).run(...params); }
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
module.exports = { open, openWith, get, close, isOpen, readSnapshot, inSnapshot, indexProblems, plaintextCopies, sealPlaintextCopies, noteSealError, LATEST_SCHEMA_VERSION: migrations.length, MAIN_SITE_ID, migrateSupplies, now, all, one, run, transaction, savepoint, getSetting, setSetting, tombstone, checkKeyFingerprint, reindexNameParts };
