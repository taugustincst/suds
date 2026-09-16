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

// Lightweight forward-only migrations keyed by settings.schema_version.
const migrations = [
  // 1: initial schema (created by schema.sql)
  () => {},
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

module.exports = { open, get, close, now, all, one, run, transaction, getSetting, setSetting };
