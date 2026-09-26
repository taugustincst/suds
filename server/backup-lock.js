'use strict';
// One lock for everything that copies or replaces the whole database: the scheduled backup (and its offsite
// copy), the frequent online snapshot, the recovery drill and the restore. Each of these spans many turns of
// the event loop (SQLite's online backup API yields between page batches), and before this they only kept out
// copies of themselves: a restore that swapped the file while a backup was copying it half-failed (the swap
// happened, then recording the new sync generation threw "database is locked"; the restore anchor was not
// written; the backup being written was corrupt).
//
// A FIFO async mutex, in this process's memory (ADR-0001: one process per data directory). Timers ask
// paused() first and skip their turn while a restore holds the lock or is waiting for it, so a restore is not
// starved by the next snapshot and nothing scheduled runs against a file that is being swapped.

const WHAT = {
  backup: 'A scheduled backup is running',
  snapshot: 'An online snapshot of the database is being taken',
  'dr-drill': 'A recovery drill is running',
  restore: 'A restore is running',
};

let holder = null;       // { name, since }
const queue = [];        // [{ name, grant }]

function busyError(name, forWhat) {
  const e = new Error(`${WHAT[name] || `${name} is running`}; the ${forWhat || 'operation'} was not started. Try again when it has finished.`);
  e.code = 'EBUSY'; e.holder = name;
  return e;
}

function grantNext() {
  holder = null;
  const next = queue.shift();
  if (next) next.grant();
}

function makeRelease(name) {
  let done = false;
  return () => { if (done) return; done = true; if (holder && holder.name === name) grantNext(); };
}

/** Take the lock now or not at all: a release function, or null when it is held (or others are queued). */
function tryAcquire(name) {
  if (holder || queue.length) return null;
  holder = { name, since: Date.now() };
  return makeRelease(name);
}

/**
 * Wait for the lock (first come, first served). Resolves to a release function. With `waitMs`, rejects with
 * code EBUSY (naming what holds it) when it is not granted in time, and leaves the queue.
 */
function acquire(name, { waitMs = Infinity, forWhat } = {}) {
  const now = tryAcquire(name);
  if (now) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    let timer = null;
    const entry = { name, grant: () => { if (timer) clearTimeout(timer); holder = { name, since: Date.now() }; resolve(makeRelease(name)); } };
    queue.push(entry);
    if (Number.isFinite(waitMs)) {
      timer = setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i < 0) return;
        queue.splice(i, 1);
        reject(busyError(holder ? holder.name : 'backup', forWhat));
      }, Math.max(0, waitMs));
      if (timer.unref) timer.unref();
    }
  });
}

/** Run `fn` holding the lock; released however it ends. */
async function run(name, fn, opts) {
  const release = await acquire(name, opts);
  try { return await fn(); } finally { release(); }
}

/** What holds the lock now, or null. */
function current() { return holder ? { ...holder } : null; }

/** True while a restore holds the lock or waits for it: timers skip their turn. */
function paused() { return (!!holder && holder.name === 'restore') || queue.some((q) => q.name === 'restore'); }

module.exports = {
  tryAcquire, acquire, run, current, paused, busyError,
  // How long a restore from the Administration page waits for work in flight before it is refused with a 409.
  // A scheduled backup of a county-sized database takes seconds to a minute; a recovery drill can take longer.
  restoreWaitMs: 120_000,
};
