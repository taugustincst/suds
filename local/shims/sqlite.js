// Browser replacement for node:sqlite's DatabaseSync, backed by sql.js (SQLite compiled to WebAssembly).
// The database is persisted to IndexedDB after writes and loaded before the kernel starts.
//
// Four hazards this file has to handle, because a phone is not a server:
//  * Two tabs. Each would hold its own copy in memory and persist by overwriting the whole database, so
//    whichever saved last would silently erase the other's work. One page holds a lock, and every save is
//    fenced by an epoch in IndexedDB so a page that has lost the database cannot write over it (below).
//  * A page going away with writes not yet saved. Writes are coalesced for a moment and then saved; the
//    unload path (pagehide, hidden, freeze) saves at once with an explicit commit.
//  * A failed write. The dirty flag is cleared only after IndexedDB confirms the save, and a failure is
//    surfaced to the user instead of going to the console where nobody will see it.
//  * An erased store. A store cleared under a running page ("Reset this device") is never written back.
let SQL = null;
const STORE = 'suds-local';
export async function init(wasmUrl) {
  if (SQL) return SQL;
  const initSqlJs = (await import('sql.js')).default;
  SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return SQL;
}

// ---- fencing: where the database lives in IndexedDB ----
// Every save writes the WHOLE database, so two pages that each hold a copy in memory erase each other's work:
// whichever saves last wins. The Web Lock below keeps a second page from starting, but a lock alone cannot
// stop a page that has *already* loaded its copy — one frozen in the background and woken later, one whose
// lock was stolen while it was not looking, or one running an older release that never heard of the
// handover. So the store itself is fenced:
//
//  * `epoch` is a number kept in the same object store. Taking the lock (any path) claims the next epoch in
//    one readwrite transaction (claimEpoch), and the page remembers it as `myEpoch`.
//  * The database bytes live under `db2:<epoch>`, and a page only ever writes the key of ITS epoch. Claiming
//    reads the previous holder's key and copies it to the new one in that same transaction, and deletes every
//    other `db2:*` key. Nothing reads an old key again.
//  * An ordinary save reads `epoch` first, in the same readwrite transaction as its put, and issues the put
//    only from that read's callback, only while the epoch is still its own; otherwise it aborts the
//    transaction and the page stops (the paused screen).
//  * The unload save (pagehide / hidden / freeze) cannot wait for a callback: it commit()s at once, after
//    which nothing can abort it. It needs no check — it writes `db2:<myEpoch>`, which after a takeover is a
//    key nobody reads; at worst it leaves a dead copy that the next claim deletes. IndexedDB runs readwrite
//    transactions on one store strictly in the order they were created, so a claim either sees such a
//    save (created before it: it is carried over) or makes it harmless (created after: it lands on a dead
//    key). There is no ordering in which a stale page's save replaces the current holder's bytes.
//  * 1.9.0–1.9.2 kept the database under `db` and know nothing of epochs. The first claim on a store with no
//    `epoch` migrates `db` to `db2:<epoch>` and `db` is never read again, so a tab still running one of those
//    releases after a deploy writes only to a dead key: its late saves cannot erase anything. What is typed
//    into such a tab after a new one took over is not carried across (that tab cannot know it was displaced).
//  * A store without `epoch` after this page claimed one has been cleared ("Reset this device" clears the
//    whole store): nothing is written back. Epochs are at least Date.now(), so a claim after such a clear is
//    still above any epoch an older page could remember.
const LEGACY_KEY = 'db';
const EPOCH_KEY = 'epoch';
const DB_PREFIX = 'db2:';
const dbKey = (e) => DB_PREFIX + e;
let myEpoch = null;
let claimedBytes = null;

// ---- single-writer lock ----
// The Web Lock is held for as long as the page lives and released when it goes away. A page that cannot get
// it is never given the database without the person saying so ("Use SUDS in this window"): a holder that
// looks dead — a quiet heartbeat, no answer on the channel — is, on a phone, usually a background tab the
// browser has throttled or frozen, and it wakes up again. The one exception is this same tab loading again
// (a reload, or a navigation within it): the previous document holds the lock only until it is torn down,
// so the new one waits for it briefly instead of stealing. A duplicated tab carries this tab's
// sessionStorage and so waits too — but the original is alive, the wait runs out, and the person is asked.
const LOCK_NAME = 'suds-local-db';
const HEARTBEAT_KEY = 'suds-local-lock-heartbeat';
const HELD_KEY = 'suds-local-held'; // sessionStorage: a document of this tab held the lock
const CHANNEL = 'suds-local-lock';
const HEARTBEAT_MS = 4000;
const STALE_MS = 20000;
const ACK_WAIT_MS = 3000; // how long "Use SUDS in this window" waits for the holder to write out and answer
const SAME_TAB_WAIT_MS = 3000; // how long a reload waits for its own previous document to let go
// Per document, not per tab: sessionStorage is copied into a duplicated tab, so an id kept there could not
// tell the two apart (1.9.2 did, and a duplicated tab took the database over silently).
const docId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
let haveLock = false;
let frozen = false; // this page gave the database up: nothing here may save again
let steppingAside = false; // writing out for a takeover: requests are refused, the final save still runs
let heartbeatTimer = null;
let channel = null;
let lostHandler = null;
let lostNotified = false;
function beat() { try { localStorage.setItem(HEARTBEAT_KEY, String(Date.now())); } catch { /* no localStorage: nothing to fall back to either */ } }
function stopHolding() { haveLock = false; clearInterval(heartbeatTimer); heartbeatTimer = null; }
/** This page no longer owns the database: stop, save nothing more, and let the page say so (once). */
function lose(info) {
  stopHolding(); frozen = true; steppingAside = false;
  clearTimeout(saveTimer); saveTimer = null;
  try { sessionStorage.removeItem(HELD_KEY); } catch {}
  if (lostNotified) return; lostNotified = true;
  if (lostHandler) { try { lostHandler(info); } catch {} }
}
function openChannel() {
  if (channel || typeof BroadcastChannel !== 'function') return;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async (ev) => {
    const m = ev.data || {};
    if (m.type !== 'takeover' || m.from === docId || !haveLock || frozen || steppingAside) return;
    // Another window asked for the database. Write out what this page has now — safe, because that window
    // claims a new epoch only after this answers (or it gives up waiting), and a save that finds the epoch
    // already moved is refused by the fence anyway — then answer, and stop for good.
    steppingAside = true; clearInterval(heartbeatTimer); heartbeatTimer = null;
    clearTimeout(saveTimer); saveTimer = null;
    let savedFirst = false;
    // A save that reaches the store while this page's epoch is current clears `dirty`; one refused by the
    // fence (or written to a key a newer claim has left behind) leaves it set. So "nothing left unsaved" is
    // exactly "this page's work was carried into the new owner's copy" — the same test on every path.
    try { await flush(); savedFirst = !dirty && !wiped; } catch {}
    try { channel.postMessage({ type: 'takeover-ack', to: m.from, saved: savedFirst }); } catch {}
    lose({ savedFirst });
  };
}
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
}
function requestWebLock(opts) {
  if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
  return new Promise((resolve) => {
    let granted = false;
    navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ...opts }, (lock) => {
      if (!lock) { resolve(false); return; }
      granted = true; resolve(true);
      return new Promise(() => {}); // held until the page is gone
    }).catch(() => {
      // Settling after it was granted means another page stole it. That page's claim has moved (or is about
      // to move) the epoch, so nothing here could be saved anyway: stop now, not at the next refused save.
      if (granted) { if (haveLock || steppingAside) lose({ savedFirst: !dirty && !wiped }); }
      else resolve(false); // a wait that timed out
    });
  });
}
function askHolderToStepAside() {
  if (!channel) return Promise.resolve(false);
  return new Promise((res) => {
    const onAck = (ev) => { const d = ev.data || {}; if (d.type === 'takeover-ack' && d.to === docId) { clearTimeout(timer); channel.removeEventListener('message', onAck); res(true); } };
    const timer = setTimeout(() => { channel.removeEventListener('message', onAck); res(false); }, ACK_WAIT_MS);
    channel.addEventListener('message', onAck);
    try { channel.postMessage({ type: 'takeover', from: docId }); } catch { clearTimeout(timer); channel.removeEventListener('message', onAck); res(false); }
  });
}
function previousDocumentOfThisTab() {
  try { if (sessionStorage.getItem(HELD_KEY) === '1') return true; } catch {}
  try { const nav = performance.getEntriesByType('navigation')[0]; return !!nav && nav.type === 'reload'; } catch { return false; }
}
/**
 * Take the single-writer lock and claim the next epoch. Without `force`, only a lock nobody holds is taken —
 * or, for this same tab loading again, one its previous document is about to let go of. With `force` (the
 * person chose "Use SUDS in this window") the holder is asked to write out and answer; after the answer or
 * ACK_WAIT_MS, whichever comes first, the lock is stolen and the epoch moved, which fences the old holder
 * off whether or not it ever answered. Resolves false when the lock is held elsewhere.
 */
export async function acquireLock({ force = false } = {}) {
  openChannel();
  let got = await requestWebLock({ ifAvailable: true });
  if (!got && force) { await askHolderToStepAside(); got = await requestWebLock({ steal: true }); }
  else if (!got && previousDocumentOfThisTab()) got = await requestWebLock({ signal: timeoutSignal(SAME_TAB_WAIT_MS) });
  if (!got) return false;
  haveLock = true; frozen = false; steppingAside = false; lostNotified = false;
  const claim = await claimEpoch();
  myEpoch = claim.epoch; claimedBytes = claim.bytes;
  try { sessionStorage.setItem(HELD_KEY, '1'); } catch {}
  beat();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  return true;
}
function claimEpoch() {
  return idb().then((d) => new Promise((res, rej) => {
    const t = d.transaction('kv', 'readwrite'); const s = t.objectStore('kv');
    let epoch = null; let bytes = null; let migrated = false;
    const g = s.get(EPOCH_KEY);
    g.onsuccess = () => {
      const prev = typeof g.result === 'number' ? g.result : null;
      epoch = Math.max((prev || 0) + 1, Date.now());
      const src = s.get(prev === null ? LEGACY_KEY : dbKey(prev));
      src.onsuccess = () => {
        bytes = src.result || null; migrated = prev === null && !!bytes;
        s.put(epoch, EPOCH_KEY);
        if (bytes) s.put(bytes, dbKey(epoch));
        const keys = s.getAllKeys(IDBKeyRange.bound(DB_PREFIX, DB_PREFIX + '￿'));
        keys.onsuccess = () => { for (const k of keys.result) if (k !== dbKey(epoch)) s.delete(k); };
      };
    };
    t.oncomplete = () => res({ epoch, bytes, migrated });
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('could not claim the on-device database'));
  }));
}
/** True once whoever holds the lock has not stamped a heartbeat for a while (it may be frozen, not gone). */
export function lockIsStale() {
  try {
    const last = Number(localStorage.getItem(HEARTBEAT_KEY) || 0);
    return last > 0 && (Date.now() - last) > STALE_MS;
  } catch { return false; }
}
/** "Use SUDS in this window" (see acquireLock). Kept for callers of the old name. */
export function forceAcquireLock() { return acquireLock({ force: true }); }
export function hasLock() { return haveLock; }
/** The fence token this page claimed (tests and diagnostics). */
export function epoch() { return myEpoch; }
/** True once this page has handed the database over (or is doing so); every request is refused. */
export function isFrozen() { return frozen || steppingAside; }
/** Called once when this page stops owning the database, with { savedFirst }: was its last work written out? */
export function onLockLost(fn) { lostHandler = fn; }

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
/** The bytes read when this page claimed its epoch (acquireLock runs first); null on a new device. */
export async function loadBytes() { return claimedBytes; }
/**
 * Resolves true when the bytes were stored; false when the save was withheld because the store had been
 * cleared (wiped) or another page had claimed the database since (fenced). See "fencing" above. With the
 * connection already open, the transaction is created before this returns, so a save started from pagehide
 * is ordered before anything the next document does.
 */
export function saveBytes(bytes, { urgent = false } = {}) {
  const write = (d) => new Promise((res, rej) => {
    if (myEpoch === null) { rej(new Error('the on-device database was never claimed')); return; }
    const t = d.transaction('kv', 'readwrite'); const store = t.objectStore('kv');
    const key = dbKey(myEpoch);
    let outcome = null; // 'wiped' | 'fenced'
    const probe = store.get(EPOCH_KEY);
    const judge = () => { const e = probe.result; if (e === undefined) outcome = 'wiped'; else if (e !== myEpoch) outcome = 'fenced'; };
    if (urgent) {
      // On the way out no callback is guaranteed to run again, and a transaction that waits for one is
      // aborted with the document: commit() finishes it without. The probe can then no longer stop the
      // put, and need not — it goes to this page's own epoch key, which is dead if the page was displaced.
      store.put(bytes, key);
      probe.onsuccess = () => { judge(); };
    } else {
      probe.onsuccess = () => { judge(); if (outcome) { try { t.abort(); } catch {} } else store.put(bytes, key); };
    }
    const settle = () => { if (outcome === 'wiped') { wiped = true; dirty = false; } else if (outcome === 'fenced') lose({ savedFirst: false }); };
    t.oncomplete = () => { if (inflight === t) inflight = null; if (outcome) { settle(); res(false); } else res(true); };
    t.onabort = () => { if (inflight === t) inflight = null; if (outcome) { settle(); res(false); } else rej(t.error || new Error('save aborted')); };
    inflight = t;
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
 * page goes away. The whole store is cleared: the current copy, the epoch, and a pre-1.9.3 `db` key.
 * Resolves only once the clear has been committed, so a reload that waits on it finds the store empty.
 */
export async function wipe() {
  wiped = true; dirty = false; clearTimeout(saveTimer); saveTimer = null;
  if (saving) { try { await saving; } catch {} }
  if (current) { const c = current; current = null; try { c.close(); } catch {} }
  const d = await idb();
  await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
/** True once this page has wiped (or found wiped) the device database; nothing is saved after that. */
export function isWiped() { return wiped; }

let current = null; let saveTimer = null; let dirty = false; let saving = null; let wiped = false;
// Nesting depth of the transaction server/db.js has open, tracked by DatabaseSync.exec(): a save in the
// middle of one would end it (sql.js's export() closes and reopens the database), so writes made inside a
// transaction are saved after its COMMIT lands, not before.
let inTransaction = false;
/** Called when a save fails, so the UI can tell the user their device has stopped saving. */
let onSaveError = (e) => console.error('[suds-local] save failed', e);
export function setSaveErrorHandler(fn) { onSaveError = fn; }

/**
 * Persist the in-memory database. `urgent` is the unload path (pagehide, visibilitychange→hidden, freeze):
 * the write is issued synchronously, before this returns, with an explicit commit, and a save already in
 * flight is told to commit too rather than waited for, because nothing can be waited for after unload.
 * A failure reaches onSaveError (the "stopped saving" banner) and rejects; it is never swallowed.
 */
export function flush({ urgent = false } = {}) {
  if (wiped || frozen || !current || myEpoch === null) return Promise.resolve();
  if (urgent && inflight && typeof inflight.commit === 'function') { try { inflight.commit(); } catch {} }
  if (!dirty) return saving || Promise.resolve();
  if (saving && !urgent) return saving.then(() => flush()); // a save is in flight; queue behind it
  if (inTransaction) return Promise.resolve(); // saved after the COMMIT; exporting now would end it
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
/** Is there anything written in memory and not yet saved? */
export function isDirty() { return dirty; }
// How long consecutive writes are coalesced before they are saved. Every save exports and writes the whole
// database (tens of milliseconds, growing with its size), so it is not done per request — 1.9.1 did, and a
// write took 40–130 ms on a large caseload. What is unsaved when the page goes away is written by the
// unload flush (pagehide / visibilitychange→hidden / freeze, in public/app.js); the next document of the
// same tab waits for this one's lock, held until it is torn down, before it reads anything (acquireLock),
// and IndexedDB orders its claim after the unload save.
const COALESCE_MS = 250;
let writeSeq = 0;
function markDirty() {
  if (wiped || frozen) return;
  dirty = true; writeSeq++;
  if (inTransaction) return; // scheduled when the COMMIT lands
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush().catch(() => { /* reported by onSaveError */ }); }, COALESCE_MS);
}

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
    // Saved on the coalescing timer like any other write, but only once the OUTERMOST transaction has ended:
    // sql.js's export() closes and reopens the database, which silently ends any transaction still open --
    // so saving on a savepoint released inside a BEGIN (a per-row savepoint during a sync pull) left the
    // enclosing COMMIT with nothing to commit and failed every sync.
    this._transactionEnded(sql);
    inTransaction = !!this._began || (this._spDepth || 0) > 0;
    markDirty();
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
  // Closing drops this copy without saving it: server/db.js closes the open database before opening another
  // (openWith), and a copy being replaced must never be written over the one replacing it.
  close() { if (current === this.db) { current = null; dirty = false; clearTimeout(saveTimer); saveTimer = null; } try { this.db.close(); } catch {} }
  export() { return this.db.export(); }
}
export default { DatabaseSync, init, loadBytes, saveBytes, wipe, isWiped, flush, isDirty, acquireLock, lockIsStale, forceAcquireLock, hasLock, epoch, isFrozen, onLockLost, setSaveErrorHandler };
