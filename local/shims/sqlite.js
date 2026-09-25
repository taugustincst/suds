// Browser replacement for node:sqlite's DatabaseSync, backed by sql.js (SQLite compiled to WebAssembly).
// The database is persisted to IndexedDB after writes, sealed with the device's data-encryption key
// (local/vault.js, docs/architecture/ADR-0008-device-encryption.md); the kernel opens it after a sign-in.
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
//  * A save of the database image issues its put and a read of `epoch` together and commit()s at once, so it
//    never waits on a callback of this page (see saveBytes: a frozen page must not hold the store). It needs
//    no check before writing — it writes `db2:<myEpoch>`, which after a takeover is a key nobody reads; the
//    read tells the page afterwards that it was displaced (it stops: the paused screen) and the dead copy is
//    deleted. IndexedDB runs readwrite transactions on one store strictly in the order they were created, so
//    a claim either sees such a save (created before it: it is carried over) or makes it harmless (created
//    after: it lands on a dead key). There is no ordering in which a stale page's save replaces the current
//    holder's bytes. A write of the vault is the exception: it reads `epoch` first and writes only while
//    the epoch is still its own, otherwise it aborts.
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
/** What was stored under this page's epoch when it claimed it (acquireLock runs first); null on a new device. */
export async function loadBytes() { return claimedBytes; }

// ---- sealing: nothing is written in the clear ----
// Since encryption at rest (after 1.11) the value under `db2:<epoch>` is a sealed image (local/vault.js), never SQLite bytes. The kernel
// hands this file a sealer once it holds the data-encryption key (after a sign-in, or when the first account
// is set up); until then saves are withheld — the writes stay in memory, marked dirty — rather than written
// in the clear. `pendingExtra` is what must land in the same transaction as the first sealed save (the vault
// that can open it, and the deletion of a plaintext copy left by 1.11 or earlier): it goes with every save, urgent ones
// included, until one has committed, so no sealed image is ever stored without the vault that opens it.
let sealer = null;
let pendingExtra = null;
/** `s` = { seal: async (bytes) => value, sealSync: (bytes) => value }, or null to withhold every save. */
export function setSealer(s, { extra = null } = {}) { sealer = s; pendingExtra = extra; }
export function hasSealer() { return !!sealer; }
// A locked device has no database open, and nothing may create one by accident: server/db.js opens a fresh
// empty database on first use, which would then be sealed and saved over the real one.
let openAllowed = true;
export function setOpenAllowed(v) { openAllowed = !!v; }
let lastSave = null;
let ordinarySaveMs = 0; // the last coalesced (not unload) save's cost, which sets the next coalescing delay
/** Timings of the last save (sizes and milliseconds; never contents), for diagnostics and the performance check. */
export function saveStats() { return lastSave; }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Resolves true when `value` (and any `extra` entries: key → value, or null to delete) were stored; false
 * when the save was withheld because the store had been cleared (wiped) or another page had claimed the
 * database since (fenced). `value` null writes only the extras. See "fencing" above. With the connection
 * already open, the transaction is created before this returns, so a save started from pagehide is ordered
 * before anything the next document does.
 */
export function saveBytes(value, { urgent = false, extra = null } = {}) {
  const extras = { ...(pendingExtra || {}), ...(extra || {}) };
  const carried = pendingExtra;
  const write = (d) => new Promise((res, rej) => {
    if (myEpoch === null) { rej(new Error('the on-device database was never claimed')); return; }
    const t = d.transaction('kv', 'readwrite'); const store = t.objectStore('kv');
    const key = dbKey(myEpoch);
    let outcome = null; // 'wiped' | 'fenced'
    // A tab still running a release from before 1.9.3 writes its copy, in the clear, under `db` (it knows
    // nothing of epochs or sealing): every sealed save removes whatever such a tab has left there.
    const putAll = () => { if (value !== null) { store.put(value, key); store.delete(LEGACY_KEY); } for (const [k, v] of Object.entries(extras)) { if (v === null) store.delete(k); else store.put(v, k); } };
    const probe = store.get(EPOCH_KEY);
    const judge = () => { const e = probe.result; if (e === undefined) outcome = 'wiped'; else if (e !== myEpoch) outcome = 'fenced'; };
    // Blind: every request is issued now and the transaction committed at once, so it finishes without any
    // callback of this page having to run. That is required on the way out (no callback is guaranteed to
    // run again, and a transaction waiting for one is aborted with the document), and it is what every
    // image-only save does: a transaction that waits for a callback is held open for as long as this page
    // cannot run it — a background tab the browser froze, a page stopped in a debugger — and every other
    // page's readwrite transaction on the store queues behind it, so a window taking the database over hung
    // at "Starting SUDS on this device…" behind a frozen holder (multitab.mjs, the frozen-holder case). The
    // probe can then no longer stop the put, and need not: it goes to this page's own epoch key, which is
    // dead if the page was displaced (and is removed again below). Only a save that also writes the vault
    // checks the epoch before writing anything: a displaced page must never replace the holder's vault.
    const blind = urgent || !Object.keys(extras).length;
    if (blind) {
      putAll();
      probe.onsuccess = () => { judge(); };
    } else {
      probe.onsuccess = () => { judge(); if (outcome) { try { t.abort(); } catch {} } else putAll(); };
    }
    const settle = () => {
      if (outcome === 'wiped') { wiped = true; dirty = false; } else if (outcome === 'fenced') lose({ savedFirst: false });
      // A blind save that landed in a store cleared or claimed meanwhile left a copy under a key nobody reads.
      if (blind && value !== null) { try { const c = d.transaction('kv', 'readwrite'); c.objectStore('kv').delete(key); if (typeof c.commit === 'function') c.commit(); } catch {} }
    };
    t.oncomplete = () => {
      if (inflight === t) inflight = null;
      if (outcome) { settle(); res(false); return; }
      if (carried && pendingExtra === carried) pendingExtra = null;
      res(true);
    };
    t.onabort = () => { if (inflight === t) inflight = null; if (outcome) { settle(); res(false); } else rej(t.error || new Error('save aborted')); };
    inflight = t;
    if (blind && typeof t.commit === 'function') { try { t.commit(); } catch {} }
  });
  if (conn) { try { return write(conn); } catch (e) { conn = null; } }
  return idb().then(write);
}
/** Write `entries` (key → value, null deletes) under the fence, without the database: the vault. */
export function putMeta(entries) { return saveBytes(null, { extra: entries }); }
/** One value from the store (the vault), or null. */
export async function getMeta(key) {
  const d = await idb();
  return new Promise((res, rej) => { const g = d.transaction('kv', 'readonly').objectStore('kv').get(key); g.onsuccess = () => res(g.result === undefined ? null : g.result); g.onerror = () => rej(g.error); });
}
/** Every [key, value] in the store: used to prove, after sealing an old device, that no plaintext copy is left. */
export async function entries() {
  const d = await idb();
  return new Promise((res, rej) => {
    const s = d.transaction('kv', 'readonly').objectStore('kv'); const k = s.getAllKeys(); const v = s.getAll();
    v.onsuccess = () => res(k.result.map((key, i) => [key, v.result[i]])); v.onerror = () => rej(v.error);
  });
}
/**
 * The value this page last saved under its epoch, read back from the store (a sign-in opens the database
 * from here, not from anything kept in memory). Refuses, and stops this page, if another page has claimed
 * the database since.
 */
export async function readCurrent() {
  if (wiped || frozen || myEpoch === null) throw new Error('This window no longer holds the on-device database. Reload and try again.');
  const d = await idb();
  const { epoch, value } = await new Promise((res, rej) => {
    const s = d.transaction('kv', 'readonly').objectStore('kv'); const e = s.get(EPOCH_KEY); const v = s.get(dbKey(myEpoch));
    v.onsuccess = () => res({ epoch: e.result, value: v.result === undefined ? null : v.result }); v.onerror = () => rej(v.error);
  });
  if (epoch !== myEpoch) { lose({ savedFirst: !dirty }); throw new Error('SUDS is now open in another window on this device.'); }
  return value;
}
// The readwrite transaction currently being committed, if any, so an urgent flush can hurry it along.
let inflight = null;
/**
 * Erase the on-device database. Deleting the IndexedDB key alone was not a wipe: the copy still in memory
 * was written straight back by the next debounced save or by the pagehide flush, before the page reloaded.
 * So the timer is cancelled, the in-memory copy dropped, and every later save refused (`wiped`) until the
 * page goes away. The whole store is cleared: the current copy, the epoch, the vault, and a pre-1.9.3 `db` key.
 * Resolves only once the clear has been committed, so a reload that waits on it finds the store empty.
 */
export async function wipe() {
  wiped = true; dirty = false; clearTimeout(saveTimer); saveTimer = null; sealer = null; pendingExtra = null;
  if (saving) { try { await saving; } catch {} }
  if (current) { const c = current; current = null; try { c.close(); } catch {} }
  const d = await idb();
  await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
/** True once this page has wiped (or found wiped) the device database; nothing is saved after that. */
export function isWiped() { return wiped; }

/**
 * Replace the device database with `value` (a sealed image: restoring a device backup) and write `extra`
 * (the vault that opens it) in the same transaction, under the fence like everything else: it checks the
 * store's epoch is still this page's, claims the next one, writes the restored image under it and deletes
 * every other copy. The copy in memory is dropped, so neither the coalescing timer nor the unload flush can
 * write the old database back; the caller installs the new sealer and opens the restored database in this
 * page. Rejects, changing nothing, when another window owns the store.
 */
export async function replaceWith(value, { extra = null } = {}) {
  if (wiped || frozen || myEpoch === null) throw new Error('This window no longer holds the on-device database. Reload and try again.');
  clearTimeout(saveTimer); saveTimer = null;
  if (saving) { try { await saving; } catch {} }
  const d = await idb();
  const epoch = await new Promise((res, rej) => {
    const t = d.transaction('kv', 'readwrite'); const s = t.objectStore('kv');
    let next = null; let fenced = false;
    const g = s.get(EPOCH_KEY);
    g.onsuccess = () => {
      if (g.result !== myEpoch) { fenced = true; try { t.abort(); } catch {} return; }
      next = Math.max(myEpoch + 1, Date.now());
      s.put(next, EPOCH_KEY); s.put(value, dbKey(next));
      for (const [k, v] of Object.entries(extra || {})) { if (v === null) s.delete(k); else s.put(v, k); }
      const keys = s.getAllKeys(IDBKeyRange.bound(DB_PREFIX, DB_PREFIX + '￿'));
      keys.onsuccess = () => { for (const k of keys.result) if (k !== dbKey(next)) s.delete(k); };
    };
    t.oncomplete = () => res(next);
    t.onabort = () => rej(fenced ? new Error('SUDS is open in another window on this device; restore from that window.') : (t.error || new Error('The restore could not be written')));
    t.onerror = () => rej(t.error);
  });
  myEpoch = epoch; dirty = false; sealer = null; pendingExtra = null;
  if (current) { const c = current; current = null; try { c.close(); } catch {} }
}
/** The database as it is in memory right now (a device backup). */
export function exportCurrent() { if (!current) throw new Error('The on-device database is not open'); return current.export(); }
/** Open a copy of `bytes` read-only, off to the side, for `fn(db)` to inspect (a backup's contents). */
export function inspect(bytes, fn) {
  if (!SQL) throw new Error('sqlite shim not initialised');
  const d = new SQL.Database(bytes);
  try { return fn({ one: (sql, ...p) => { const st = d.prepare(sql); try { st.bind(p); return st.step() ? st.getAsObject() : undefined; } finally { st.free(); } } }); }
  finally { d.close(); }
}

let current = null; let saveTimer = null; let dirty = false; let saving = null; let wiped = false;
// Nesting depth of the transaction server/db.js has open, tracked by DatabaseSync.exec(): a save in the
// middle of one would end it (sql.js's export() closes and reopens the database), so writes made inside a
// transaction are saved after its COMMIT lands, not before.
let inTransaction = false;
/** Called when a save fails, so the UI can tell the user their device has stopped saving. */
let onSaveError = (e) => console.error('[suds-local] save failed', e);
export function setSaveErrorHandler(fn) { onSaveError = fn; }

// Saves are sealed asynchronously (WebCrypto), so a save can be overtaken: an urgent one issued while an
// ordinary one is still sealing. Each save takes a ticket when it exports; one whose ticket is older than the
// last save actually issued is dropped, so an older image can never land after a newer one.
let ticket = 0; let issued = 0;
/**
 * Persist the in-memory database, sealed. `urgent` is the unload path (pagehide, visibilitychange→hidden,
 * freeze): the image is sealed synchronously and the write issued before this returns, with an explicit
 * commit, and a save already in flight is told to commit too rather than waited for, because nothing can be
 * waited for after unload. `force` saves even when nothing changed (the first sealed save of a device).
 * A failure reaches onSaveError (the "stopped saving" banner) and rejects; it is never swallowed.
 */
export function flush({ urgent = false, force = false } = {}) {
  if (wiped || frozen || !current || myEpoch === null) return Promise.resolve();
  if (urgent && inflight && typeof inflight.commit === 'function') { try { inflight.commit(); } catch {} }
  if (!dirty && !force) return saving || Promise.resolve();
  if (!sealer) return Promise.resolve(); // no key to seal with yet: withheld, never written in the clear
  if (saving && !urgent) return saving.then(() => flush({ force }));
  if (inTransaction) return Promise.resolve(); // saved after the COMMIT; exporting now would end it
  clearTimeout(saveTimer); saveTimer = null;
  const seq = writeSeq; const mine = ++ticket;
  const t0 = now(); const bytes = current.export(); const t1 = now();
  const stat = (sealed, t2) => (stored) => { const t3 = now(); if (stored) { lastSave = { bytes: bytes.length, urgent, export_ms: Math.round(t1 - t0), seal_ms: Math.round(t2 - t1), write_ms: Math.round(t3 - t2), total_ms: Math.round(t3 - t0) }; if (!urgent) ordinarySaveMs = lastSave.total_ms; } return stored; };
  let p;
  if (urgent) {
    const sealed = sealer.sealSync(bytes); const t2 = now(); bytes.fill(0);
    issued = mine;
    p = saveBytes(sealed, { urgent: true }).then(stat(sealed, t2));
  } else {
    const s = sealer;
    p = s.seal(bytes).then((sealed) => {
      const t2 = now(); bytes.fill(0);
      if (mine < issued || sealer !== s) return false; // overtaken by a newer save, or the key changed meanwhile
      issued = mine;
      return saveBytes(sealed).then(stat(sealed, t2));
    });
  }
  p = p
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
// How long consecutive writes are coalesced before they are saved. Every save exports, seals and writes the
// WHOLE database (tens of milliseconds, growing with its size), so it is not done per request — 1.9.1 did,
// and a write took 40–130 ms on a large caseload. The delay stretches to twice the last save's cost (at
// most 4 s) so a large database is not re-sealed back to back. What is unsaved when the page goes away is
// written by the unload flush (pagehide / visibilitychange→hidden / freeze, in public/app.js); the next
// document of the same tab waits for this one's lock, held until it is torn down, before it reads anything
// (acquireLock), and IndexedDB orders its claim after the unload save.
const COALESCE_MS = 250;
const MAX_COALESCE_MS = 4000;
let writeSeq = 0;
function markDirty() {
  if (wiped || frozen) return;
  dirty = true; writeSeq++;
  if (inTransaction) return; // scheduled when the COMMIT lands
  const delay = Math.min(MAX_COALESCE_MS, Math.max(COALESCE_MS, ordinarySaveMs * 2));
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush().catch(() => { /* reported by onSaveError */ }); }, delay);
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
    if (!openAllowed) throw new Error('The on-device database is locked: sign in first.');
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
export default { DatabaseSync, init, loadBytes, saveBytes, putMeta, getMeta, entries, readCurrent, setSealer, hasSealer, setOpenAllowed, saveStats, wipe, isWiped, replaceWith, inspect, exportCurrent, flush, isDirty, acquireLock, lockIsStale, forceAcquireLock, hasLock, epoch, isFrozen, onLockLost, setSaveErrorHandler };
