'use strict';
// SUDS is a single-writer, single-instance application: one SQLite file, one process. There is no shared
// session store or distributed rate limiter (both live in this process's memory — see server/app.js), and
// SQLite's own file locking is not safe across two processes writing to the same database from different
// machines (e.g. a network filesystem). A second process against the same data directory — a systemd
// restart racing the old process's shutdown, or an orchestrator mistakenly scaled to more than one replica
// against the same volume — is the actual danger this guards against, not a theoretical one: it can corrupt
// the database. Enforced with a lock file rather than documented and hoped for.
//
// A bare pid is not enough to tell a live lock from a stale one:
//   * In a container node is PID 1 on every start. After SIGKILL, an OOM kill or power loss the old lock says
//     "1", the new process is PID 1 too, and "is pid 1 running?" is always yes — a permanent crash-loop.
//   * After a reboot (systemd, bare metal) the recorded pid can have been reused by an unrelated process.
// So the lock records {pid, bootId, startTime}: the kernel's per-boot random id and the process's start time
// (clock ticks since boot, /proc/<pid>/stat field 22). A lock naming this very process's pid (and not held
// by this process), a lock from a different boot, or a lock whose pid is running but started at a different
// time is stale. Old plain-pid lock files (1.11.0 and earlier) are still read. Off Linux, where /proc is
// absent, the check falls back to "is the pid running, and is it not us".
const fs = require('node:fs');
const path = require('node:path');

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; }
  catch { return null; }
}

/** Process start time in clock ticks since boot (a string), or null when /proc is not available. */
function startTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) is in parentheses and may itself contain spaces or ')': split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] || null; // rest[0] is field 3, so field 22 is rest[19]
  } catch { return null; }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM: the process exists but belongs to another user
}

function parseLock(text) {
  const t = String(text || '').trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      const pid = Number(o.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, bootId: o.bootId || null, startTime: o.startTime != null ? String(o.startTime) : null };
    } catch { return null; }
  }
  const pid = parseInt(t, 10);
  return pid > 0 ? { pid, bootId: null, startTime: null } : null;
}

// Lock files this process currently holds: a second acquire of the same one in this process is refused.
const held = new Set();

/** Why the lock `rec` is stale, or null if it belongs to a live other process. */
function staleReason(rec) {
  if (!rec) return 'unreadable';
  // Not held by us (the caller checked), so a previous run with the same pid left it — always the case for
  // node as PID 1 in a container restarted after a kill.
  if (rec.pid === process.pid) return 'own-pid';
  const boot = bootId();
  if (rec.bootId && boot && rec.bootId !== boot) return 'previous-boot';
  if (!isRunning(rec.pid)) return 'dead-pid';
  if (rec.startTime) {
    const now = startTime(rec.pid);
    if (now && now !== rec.startTime) return 'pid-reused';
  }
  return null;
}

/**
 * Take the lock for `dataDir`, or throw a clear error if another live process already holds it. A lock left
 * behind by a process that crashed without cleaning up is taken over automatically. Returns a release
 * function; also released automatically on process exit.
 */
function acquire(dataDir) {
  if (!dataDir) return () => {};
  const file = path.join(dataDir, '.suds.lock');
  const key = path.resolve(file);
  if (held.has(key)) {
    throw new Error(`This SUDS process (pid ${process.pid}) is already running against this data directory (${dataDir}); it cannot be opened twice.`);
  }
  const mine = JSON.stringify({ pid: process.pid, bootId: bootId(), startTime: startTime(process.pid), at: new Date().toISOString() });
  for (;;) {
    try {
      fs.writeFileSync(file, mine, { mode: 0o600, flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); }
      catch (re) { if (re.code === 'ENOENT') continue; throw re; }
      const rec = parseLock(text);
      const reason = staleReason(rec);
      if (!reason) {
        throw new Error(`Another SUDS process (pid ${rec.pid}) is already running against this data directory (${dataDir}). Running more than one instance against the same database is not supported (see docs/DEPLOYMENT.md, "Single instance only") and can corrupt it. If that process has actually stopped, remove ${file} and start again.`);
      }
      // A lock from a process that is no longer running (it crashed, the container was killed, the machine
      // rebooted) is stale; take it over rather than leaving the data directory permanently locked out.
      console.warn(`[suds] instance lock: taking over a stale lock (${reason}, pid ${rec ? rec.pid : 'unknown'})`);
      try { fs.unlinkSync(file); } catch (ue) { if (ue.code !== 'ENOENT') throw ue; }
    }
  }
  held.add(key);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.delete(key);
    try { if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file); } catch {}
  };
  process.once('exit', release);
  return release;
}

module.exports = { acquire, _internals: { bootId, startTime, parseLock } };
