// Browser replacement for node:sqlite's DatabaseSync, backed by sql.js (SQLite compiled to WebAssembly).
// The database is persisted to IndexedDB after writes (debounced) and loaded before the kernel starts.
let SQL = null;
const STORE = 'suds-local'; const KEY = 'db';
export async function init(wasmUrl) {
  if (SQL) return SQL;
  const initSqlJs = (await import('sql.js')).default;
  SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return SQL;
}
function idb() { return new Promise((res, rej) => { const r = indexedDB.open(STORE, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
export async function loadBytes() { try { const d = await idb(); return await new Promise((res, rej) => { const t = d.transaction('kv', 'readonly').objectStore('kv').get(KEY); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); } catch { return null; } }
export async function saveBytes(bytes) { const d = await idb(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(bytes, KEY); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
export async function wipe() { const d = await idb(); await new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(KEY); t.oncomplete = res; }); }

let current = null; let saveTimer = null; let dirty = false;
export function flush() { if (!current || !dirty) return Promise.resolve(); dirty = false; return saveBytes(current.export()); }
function markDirty() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(() => flush().catch(e => console.error('[suds-local] save failed', e)), 400); }

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  _bind(params) { return params.map(p => (p === undefined ? null : (typeof p === 'boolean' ? (p ? 1 : 0) : p))); }
  all(...params) { const st = this.db.prepare(this.sql); try { st.bind(this._bind(params)); const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; } finally { st.free(); } }
  get(...params) { const st = this.db.prepare(this.sql); try { st.bind(this._bind(params)); return st.step() ? st.getAsObject() : undefined; } finally { st.free(); } }
  run(...params) { this.db.run(this.sql, this._bind(params)); markDirty(); return { changes: this.db.getRowsModified(), lastInsertRowid: 0 }; }
}
export class DatabaseSync {
  constructor(path, bytes) { if (!SQL) throw new Error('sqlite shim not initialised'); this.db = bytes ? new SQL.Database(bytes) : new SQL.Database(); current = this.db; }
  prepare(sql) { return new Statement(this.db, sql); }
  exec(sql) { this.db.exec(sql); markDirty(); }
  close() { flush(); }
  export() { return this.db.export(); }
}
export default { DatabaseSync, init, loadBytes, saveBytes, wipe, flush };
