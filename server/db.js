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
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  if (dbPath !== ':memory:') { try { fs.chmodSync(dbPath, 0o600); } catch {} }
  return db;
}

// Used by the local (in-browser) kernel: open from serialized bytes instead of a file path.
function openWith(bytes) {
  if (db) return db;
  db = new DatabaseSync(':memory:', bytes || undefined);
  db.exec(fs.readFileSync ? safeSchema() : '');
  migrate(db);
  return db;
}
function safeSchema() { try { return require('./schema-text.js'); } catch { return require('node:fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'); } }

// Lightweight forward-only migrations keyed by settings.schema_version.
const addColumn = (d, table, col, def) => { const cols = d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
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
];
function migrate(d) {
  const row = d.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get();
  let v = row ? Number(row.value) : 0;
  for (let i = v; i < migrations.length; i++) {
    migrations[i](d);
    d.prepare(`INSERT INTO settings(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(String(i + 1));
  }
}

function get() { if (!db) open(); return db; }
function close() { if (db) { db.close(); db = undefined; } }

// helpers
function now() { return new Date().toISOString(); }
function all(sql, ...params) { return get().prepare(sql).all(...params); }
function one(sql, ...params) { return get().prepare(sql).get(...params); }
function run(sql, ...params) { return get().prepare(sql).run(...params); }
function transaction(fn) {
  const d = get();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}
function getSetting(key, def = null) { const r = one(`SELECT value FROM settings WHERE key=?`, key); return r ? r.value : def; }
function setSetting(key, value) {
  run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`, key, String(value));
}

function tombstone(table, id) { run(`INSERT OR REPLACE INTO tombstones(table_name,id,deleted_at) VALUES(?,?,?)`, table, id, now()); }
module.exports = { open, openWith, get, close, now, all, one, run, transaction, getSetting, setSetting, tombstone };
