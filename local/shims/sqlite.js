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
// exactly the lifetime we want in the ordinary case. But that guarantee is about the *browser*, not the
// *device*: a browser process that gets killed outright (not just the one tab closing), or that simply never
// tears the lock down cleanly, can leave it held with nobody left to release it — and there is no way to ask
// Web Locks "is the holder still alive?". So whoever holds the lock also stamps a heartbeat in localStorage
// every few seconds. A failed acquire only offers a way past it once that heartbeat has gone quiet long
// enough that a live tab could not plausibly have missed several beats — at which point continuing anyway
// cannot race an actual second writer, only a truly abandoned lock.
const HEARTBEAT_KEY = 'suds-local-lock-heartbeat';
const HEARTBEAT_MS = 4000;
const STALE_MS = 20000;
let haveLock = false;
let heartbeatTimer = null;
function beat() { try { localStorage.setItem(HEARTBEAT_KEY, String(Date.now())); } catch { /* no localStorage: nothing to fall back to either */ } }
async function acquireWebLock() {
  if (!navigator.locks || !navigator.locks.request) return true;
  return new Promise((resolve) => {
    navigator.locks.request('suds-local-db', { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      // Hold it until the page is gone.
      return new Promise(() => {});
    }).catch(() => resolve(true));
  });
}
export async function acquireLock() {
  const got = await acquireWebLock();
  if (!got) return false;
  haveLock = true;
  beat();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  return true;
}
/** True once whoever holds the lock has gone quiet for long enough that they cannot still be an active tab. */
export function lockIsStale() {
  try {
    const last = Number(localStorage.getItem(HEARTBEAT_KEY) || 0);
    return last > 0 && (Date.now() - last) > STALE_MS;
  } catch { return false; }
}
/** Only meant to be called after lockIsStale() — proceeds without the previous holder's cooperation because
 *  its silence is itself the evidence that it is gone, not because Web Locks granted anything. */
export function forceAcquireLock() {
  haveLock = true;
  beat();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}
export function hasLock() { return haveLock; }

// One open connection, kept for the life of the page: a save must be able to start its transaction
// synchronously (see saveBytes), which an open() that resolves on a later task cannot offer.
let conn = null;
function idb() {
  if (conn) return Promise.resolve(conn);
  return new Promise((res, rej) => {
    const r = indexedDB.open(STORE, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { conn = r.result; conn.onclose = () => { conn = null; }; conn.onversionchange = () => { try { conn.close(); } catch {} conn = null; }; res(conn); };
    r.onerror = () => rej(r.error);
  });
}
export async function loadBytes() { try { const d = await idb(); const bytes = await new Promise((res, rej) => { const t = d.transaction('kv', 'readonly').objectStore('kv').get(KEY); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); if (bytes) hadPersisted = true; return bytes; } catch { return null; } }
// Whether a database has ever been written to this store by this page. Once it has, a store that turns
// out to be empty at save time means someone deleted it from under us (the "Reset this device" dialog in
// public/app.js, which talks to IndexedDB directly) — and a deleted database is never written back.
let hadPersisted = false;
// Resolves true when the bytes were stored, false when the store had been emptied and the save was withheld.
// With the connection already open, the transaction and its put are issued before this returns — so a
// save started from pagehide is committed by the browser even though the page is going away. The probe
// runs first in the same transaction; if it finds the store emptied, the transaction is aborted and the
// put with it.
export function saveBytes(bytes, { urgent = false } = {}) {
  const write = (d) => new Promise((res, rej) => {
    const t = d.transaction('kv', 'readwrite'); const store = t.objectStore('kv');
    let withheld = false;
    const probe = store.get(KEY);
    store.put(bytes, KEY);
    probe.onsuccess = () => { if (hadPersisted && probe.result === undefined) { withheld = true; wiped = true; try { t.abort(); } catch {} } };
    t.oncomplete = () => { if (inflight === t) inflight = null; hadPersisted = true; res(true); };
    t.onabort = () => { if (inflight === t) inflight = null; if (withheld) res(false); else rej(t.error || new Error('save aborted')); };
    t.onerror = () => { if (!withheld) rej(t.error); };
    inflight = t;
    // On the way out of the page (pagehide) no JavaScript callback is guaranteed to run again, and a
    // transaction that waits for its request callbacks before auto-committing is aborted with the
    // document. An explicit commit() tells the browser to commit as soon as the requests are done, with no
    // callback needed — at the cost of the probe above not being able to withhold the write, which is why
    // it is only asked for from the unload path, where nothing can have been erased in the meantime.
    if (urgent && typeof t.commit === 'function') { try { t.commit(); } catch {} }
  });
  if (conn) { try { return write(conn); } catch (e) { conn = null; } }
  return idb().then(write);
}
// The readwrite transaction currently being committed, if any, so an urgent flush can hurry it along.
let inflight = null;
/**
 * Erase the on-device database. Deleting the IndexedDB key alone was not a wipe: the copy still in memory
 * was written straight back by the next debounced save or by the pagehide flush, before the page reloaded.
 * So the timer is cancelled, the in-memory copy dropped, and every later save refused (`wiped`) until the
 * page goes away. Resolves only once the delete transaction has completed, so a reload that waits on it
 * finds the store empty.
 */
export async function wipe() {
  wiped = true; dirty = false; clearTimeout(saveTimer); saveTimer = null;
  if (saving) { try { await saving; } catch {} }
  if (current) { try { current.close(); } catch {} current = null; }
  const d = await idb();
  await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(KEY); t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  hadPersisted = false;
}
/** True once this page has wiped (or found wiped) the device database; nothing is saved after that. */
export function isWiped() { return wiped; }

let current = null; let saveTimer = null; let dirty = false; let saving = null; let wiped = false;
// Nesting depth of the transaction server/db.js has open, tracked by DatabaseSync.exec(): a save in the
// middle of one would end it (sql.js's export() closes and reopens the database), so writes made inside a
// transaction are persisted when its COMMIT lands, not before.
let inTransaction = false;
/** Called when a save fails, so the UI can tell the user their device has stopped saving. */
let onSaveError = (e) => console.error('[suds-local] save failed', e);
export function setSaveErrorHandler(fn) { onSaveError = fn; }

/**
 * Persist the in-memory database. `urgent` is the unload path (pagehide, visibilitychange→hidden): the
 * write is issued synchronously, before this returns, with an explicit commit, and a save already in
 * flight is told to commit too rather than waited for, because nothing can be waited for after unload.
 */
export function flush({ urgent = false } = {}) {
  if (wiped || !current) return Promise.resolve();
  if (urgent && inflight && typeof inflight.commit === 'function') { try { inflight.commit(); } catch {} }
  if (!dirty) return saving || Promise.resolve();
  if (saving && !urgent) return saving.then(() => flush()); // a save is in flight; queue behind it
  if (inTransaction) return Promise.resolve(); // the COMMIT will persist; exporting now would abort it
  clearTimeout(saveTimer); saveTimer = null;
  const seq = writeSeq;
  const bytes = current.export();
  const p = saveBytes(bytes, { urgent })
    // Clean only if nothing was written while the save was in flight; a write during the save used to be
    // marked as saved by the save that had started before it, and sat unsaved until the next write.
    .then((stored) => { if (stored && writeSeq === seq) dirty = false; })
    // The flag stays set on failure, so the next write retries rather than dropping the snapshot silently.
    .catch((e) => { onSaveError(e); throw e; })
    .finally(() => { if (saving === p) saving = null; });
  saving = p;
  return p;
}
// How long consecutive writes are coalesced before they are persisted. Short, because anything written
// and not yet saved is lost if the page goes away first; the pagehide/visibilitychange flush catches the
// tail, but a navigation that skips those (a document opened in the same tab) cannot be relied on.
const COALESCE_MS = 100;
let writeSeq = 0;
function markDirty() {
  if (wiped) return;
  dirty = true; writeSeq++;
  if (inTransaction) return; // persisted at COMMIT
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush().catch(() => {}); }, COALESCE_MS);
}
/** Persist now rather than on the timer — used at the end of a write transaction. */
function persistSoon() { if (wiped) return; clearTimeout(saveTimer); saveTimer = null; flush().catch(() => {}); }

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  _bind(params) { return params.map(p => (p === undefined ? null : (typeof p === 'boolean' ? (p ? 1 : 0) : p))); }
  all(...params) { const st = this.db.prepare(this.sql); try { st.bind(this._bind(params)); const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; } finally { st.free(); } }
  get(...params) { const st = this.db.prepare(this.sql); try { st.bind(this._bind(params)); return st.step() ? st.getAsObject() : undefined; } finally { st.free(); } }
  run(...params) { this.db.run(this.sql, this._bind(params)); markDirty(); return { changes: this.db.getRowsModified(), lastInsertRowid: 0 }; }
}
export class DatabaseSync {
  constructor(path, bytes) {
    if (!SQL) throw new Error('sqlite shim not initialised');
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    // node:sqlite enforces foreign keys by default; sql.js does not, and the pragma is per connection, so
    // an existing database reopened here (the schema's own PRAGMA only runs on a fresh one) had no
    // cascades and no referential checks at all.
    this.db.exec('PRAGMA foreign_keys = ON');
    current = this.db;
  }
  prepare(sql) { return new Statement(this.db, sql); }
  exec(sql) {
    this.db.exec(sql);
    // A committed transaction is work the user believes is saved. Write it out now instead of waiting for
    // the debounce, so an OS kill of the WebView cannot lose it. Only when the OUTERMOST transaction ends,
    // though: sql.js's export() closes and reopens the database, which silently ends any transaction still
    // open -- so persisting on a savepoint released inside a BEGIN (a per-row savepoint during a sync pull)
    // left the enclosing COMMIT with nothing to commit and failed every sync.
    const ended = this._transactionEnded(sql);
    inTransaction = !!this._began || (this._spDepth || 0) > 0;
    markDirty();
    if (ended) persistSoon();
  }
  // server/db.js issues exactly BEGIN / COMMIT / ROLLBACK, SAVEPOINT x / RELEASE x and ROLLBACK TO x (with
  // or without a trailing RELEASE x); the depth is tracked from those, and only from statements that start
  // with one of them, so a word in a comment or a string can never be mistaken for transaction control.
  _transactionEnded(sql) {
    const head = sql.trimStart().slice(0, 12).toUpperCase();
    if (/^BEGIN\b/.test(head)) { this._began = true; this._spDepth = 0; return false; }
    if (/^(COMMIT|END)\b/.test(head)) { this._began = false; this._spDepth = 0; return true; }
    if (/^ROLLBACK TO\b/.test(head)) { this._spDepth = Math.max(0, (this._spDepth || 0) - (sql.match(/\bRELEASE\b/gi) || []).length); return !this._began && this._spDepth === 0 && /\bRELEASE\b/i.test(sql); }
    if (/^ROLLBACK\b/.test(head)) { this._began = false; this._spDepth = 0; return false; }
    if (/^SAVEPOINT\b/.test(head)) { this._spDepth = (this._spDepth || 0) + 1; return false; }
    if (/^RELEASE\b/.test(head)) { this._spDepth = Math.max(0, (this._spDepth || 0) - 1); return !this._began && this._spDepth === 0; }
    return false;
  }
  close() { return flush(); }
  export() { return this.db.export(); }
}
export default { DatabaseSync, init, loadBytes, saveBytes, wipe, isWiped, flush, acquireLock, lockIsStale, forceAcquireLock, hasLock, setSaveErrorHandler };
