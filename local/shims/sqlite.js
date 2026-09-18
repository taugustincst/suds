// Browser replacement for node:sqlite's DatabaseSync, backed by sql.js (SQLite compiled to WebAssembly).
// The database is persisted to IndexedDB after writes and loaded before the kernel starts.
//
// Three hazards this file has to handle, because a phone is not a server:
//  * Two tabs. Each would hold its own copy in memory and persist by overwriting the whole database, so
//    whichever flushed last would silently erase the other's work. One tab holds a lock; the others refuse.
//  * A crash inside the debounce window. Writes are persisted eagerly after a transaction commits, not only
//    on a timer, so a killed WebView loses nothing that was actually committed.
//  * A failed write. The dirty flag is cleared only after IndexedDB confirms the save, and a failure is
//    surfaced to the user instead of going to the console where nobody will see it.
let SQL = null;
const STORE = 'suds-local'; const KEY = 'db';
export async function init(wasmUrl) {
  if (SQL) return SQL;
  const initSqlJs = (await import('sql.js')).default;
  SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return SQL;
}

// ---- single-writer lock ----
// Web Locks are held for as long as the page lives and released automatically when it goes away, which is
// exactly the lifetime we want. Where they are unavailable the app still works; it just cannot detect a
// second tab, which is the behaviour this replaces.
let haveLock = false;
export async function acquireLock() {
  if (!navigator.locks || !navigator.locks.request) { haveLock = true; return true; }
  return new Promise((resolve) => {
    navigator.locks.request('suds-local-db', { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return; }
      haveLock = true;
      resolve(true);
      // Hold it until the page is gone.
      return new Promise(() => {});
    }).catch(() => { haveLock = true; resolve(true); });
  });
}
export function hasLock() { return haveLock; }

function idb() { return new Promise((res, rej) => { const r = indexedDB.open(STORE, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
export async function loadBytes() { try { const d = await idb(); return await new Promise((res, rej) => { const t = d.transaction('kv', 'readonly').objectStore('kv').get(KEY); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); } catch { return null; } }
export async function saveBytes(bytes) { const d = await idb(); await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(bytes, KEY); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
export async function wipe() { const d = await idb(); await new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(KEY); t.oncomplete = res; }); }

let current = null; let saveTimer = null; let dirty = false; let saving = null;
/** Called when a save fails, so the UI can tell the user their device has stopped saving. */
let onSaveError = (e) => console.error('[suds-local] save failed', e);
export function setSaveErrorHandler(fn) { onSaveError = fn; }

export function flush() {
  if (!current || !dirty) return Promise.resolve();
  if (saving) return saving.then(() => flush()); // a save is in flight; queue behind it
  const bytes = current.export();
  saving = saveBytes(bytes)
    .then(() => { dirty = false; })
    // The flag stays set on failure, so the next write retries rather than dropping the snapshot silently.
    .catch((e) => { onSaveError(e); throw e; })
    .finally(() => { saving = null; });
  return saving;
}
function markDirty() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch(() => {}), 1500);
}
/** Persist now rather than on the timer — used at the end of a write transaction. */
function persistSoon() { clearTimeout(saveTimer); flush().catch(() => {}); }

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
  exec(sql) {
    this.db.exec(sql);
    markDirty();
    // A committed transaction is work the user believes is saved. Write it out now instead of waiting for
    // the debounce, so an OS kill of the WebView cannot lose it.
    if (/^\s*(COMMIT|RELEASE)\b/i.test(sql)) persistSoon();
  }
  close() { return flush(); }
  export() { return this.db.export(); }
}
export default { DatabaseSync, init, loadBytes, saveBytes, wipe, flush, acquireLock, hasLock, setSaveErrorHandler };
