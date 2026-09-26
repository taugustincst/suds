'use strict';
// SUDS is a single-writer, single-instance application: one SQLite file, one process. There is no shared
// session store or distributed rate limiter (both live in this process's memory — see server/app.js), and
// SQLite's own file locking is not safe across two processes writing to the same database from different
// machines (e.g. a network filesystem). A second process against the same data directory — a systemd
// restart racing the old process's shutdown, an orchestrator mistakenly scaled to more than one replica
// against the same volume, a second host mounting the same NFS share — is the actual danger this guards
// against, not a theoretical one: it can corrupt the database. Enforced with a lock file rather than
// documented and hoped for.
//
// The lock file records {pid, hostname, rootId, pidNs, machineId, bootId, startTime, at}, and its holder
// touches it (mtime) every HEARTBEAT_MS while it runs. Whether a lock left in place is stale is decided in one
// of two ways:
//
//   * Written by THIS host or container -- the same os.hostname() AND the same container identity: a digest
//     of the root mount as /proc/self/mountinfo describes it (filesystem type, source and options: for a
//     container, its own overlay upper directory, which a restart of the same container keeps and no other
//     container has), else the pid namespace (/proc/self/ns/pid) when no root digest is recorded; and, when
//     both sides have one, the same /etc/machine-id. Hostnames alone are not enough: network_mode: host, a
//     fixed `hostname:` or a StatefulSet pod rescheduled onto another node gives two containers the same
//     hostname and the same pid (1), and up to 1.12.0 the second took the first's live lock over as "own pid"
//     (the first then stopped, and with restart policies the two alternated). Here local process facts are
//     conclusive. A lock naming this very
//     process's pid (and not held by this process — node is PID 1, or tini's child, on every container
//     start), a lock from a previous boot (kernel boot id), a pid that is not running, or a pid now owned by
//     a process that started at a different time (/proc/<pid>/stat field 22) is stale at once. Otherwise the
//     holder is alive and the lock is refused.
//   * Written by ANOTHER host or container — a different machine on shared storage, or another container
//     (a different hostname, or the same hostname with a different container identity): its pid, boot id and start time say nothing about processes here (every
//     replica's node has the same pid and they share the host's boot id), so only the heartbeat counts. The
//     lock is stale when its mtime is older than STALE_MS (3 heartbeats + margin for clock skew and a slow
//     disk). Start-up waits up to WAIT_MS for that to happen and otherwise refuses with a message naming the
//     host and the heartbeat's age.
//
// Lock files from 1.12.0 and earlier (a plain pid, or JSON without a hostname or identity) are judged as
// written on this host when the hostname matches or is absent (the rules those versions applied themselves).
// Without /proc (not Linux) there is no identity to compare, and the hostname decides, as before.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HEARTBEAT_MS = 10_000;
const STALE_MS = 3 * HEARTBEAT_MS + 15_000; // 45 s
const WAIT_MS = STALE_MS + 5_000;            // 50 s: long enough to see a lock left by a crash go stale

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; }
  catch { return null; }
}

function hostname() {
  try { return os.hostname() || null; } catch { return null; }
}

/**
 * A digest of the mount on "/" (the last one listed wins, as the kernel does): filesystem type, source and
 * super-block options, not the device number (an overlay's is allocated afresh at every mount). For a
 * container that is its own overlay upper directory: kept by a restart of the same container, never shared
 * with another. Null without /proc.
 */
function rootId() {
  try {
    let desc = null;
    for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const f = line.split(' ');
      if (f[4] !== '/') continue;
      const dash = f.indexOf('-', 6);
      if (dash > 0) desc = f.slice(dash + 1).join(' ');
    }
    return desc ? require('node:crypto').createHash('sha256').update(desc).digest('hex').slice(0, 16) : null;
  } catch { return null; }
}
/** The pid namespace, e.g. "pid:[4026532001]": a container's own, unless it shares the host's. */
function pidNs() {
  try { return fs.readlinkSync('/proc/self/ns/pid') || null; } catch { return null; }
}
function machineId() {
  try { return fs.readFileSync('/etc/machine-id', 'utf8').trim() || null; } catch { return null; }
}
function identity() {
  return { hostname: hostname(), rootId: rootId(), pidNs: pidNs(), machineId: machineId() };
}

/**
 * Was the lock `rec` written by this host or container (so local process facts apply)? The hostname must
 * match; then the machine id, when both sides have one; then the root mount digest when both have one, else
 * the pid namespace when both have one. A lock with none of these (older formats) is judged by hostname alone.
 */
function sameInstance(rec, me) {
  if (rec.hostname && rec.hostname !== me.hostname) return false;
  if (rec.machineId && me.machineId && rec.machineId !== me.machineId) return false;
  if (rec.rootId && me.rootId) return rec.rootId === me.rootId;
  if (rec.pidNs && me.pidNs) return rec.pidNs === me.pidNs;
  return true;
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
      const str = (v) => (typeof v === 'string' && v ? v : null);
      return {
        pid,
        hostname: str(o.hostname), rootId: str(o.rootId), pidNs: str(o.pidNs), machineId: str(o.machineId),
        bootId: o.bootId || null,
        startTime: o.startTime != null ? String(o.startTime) : null,
      };
    } catch { return null; }
  }
  const pid = parseInt(t, 10);
  return pid > 0 ? { pid, hostname: null, rootId: null, pidNs: null, machineId: null, bootId: null, startTime: null } : null;
}

// Lock files this process currently holds: a second acquire of the same one in this process is refused.
const held = new Set();

/** Why a lock written on this host is stale, or null if it belongs to a live other process here. */
function localStaleReason(rec) {
  // Not held by us (the caller checked), so a previous run with the same pid on this host left it — always
  // the case for node as PID 1 in a container restarted after a kill.
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

const secs = (ms) => Math.round(ms / 1000);

/**
 * Take the lock for `dataDir`, or throw a clear error if another live process already holds it. A lock left
 * behind by a process that crashed is taken over (at once on this host; once its heartbeat is stale for a
 * lock from another host or container, waiting up to `waitMs` for that). Returns a release function; also
 * released automatically on process exit. `onLost(reason)` is called if the heartbeat finds the lock is no
 * longer ours (another process took it over, e.g. after this one was suspended for longer than the stale
 * window): the caller should stop writing.
 */
function acquire(dataDir, opts = {}) {
  if (!dataDir) return () => {};
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? STALE_MS;
  const waitMs = opts.waitMs ?? WAIT_MS;
  const onLost = opts.onLost || ((why) => console.error(`[suds] instance lock: ${why}`));
  const file = path.join(dataDir, '.suds.lock');
  const key = path.resolve(file);
  if (held.has(key)) {
    throw new Error(`This SUDS process (pid ${process.pid}) is already running against this data directory (${dataDir}); it cannot be opened twice.`);
  }
  // `opts.identity` stands in for this process's own (tests).
  const ident = { ...identity(), ...(opts.identity || {}) };
  const me = ident.hostname;
  const mine = JSON.stringify({ pid: process.pid, hostname: me, rootId: ident.rootId, pidNs: ident.pidNs, machineId: ident.machineId, bootId: bootId(), startTime: startTime(process.pid), at: new Date().toISOString() });
  const started = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(file, mine, { mode: 0o600, flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let text, mtimeMs;
      try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs; }
      catch (re) { if (re.code === 'ENOENT') continue; throw re; }
      const rec = parseLock(text);
      let reason;
      if (!rec) reason = 'unreadable';
      else if (sameInstance(rec, ident)) {
        reason = localStaleReason(rec);
        if (!reason) {
          throw new Error(`Another SUDS process (pid ${rec.pid}${rec.hostname ? ` on ${rec.hostname}` : ''}) is already running against this data directory (${dataDir}). Running more than one instance against the same database is not supported (see docs/DEPLOYMENT.md, "Single instance only") and can corrupt it. If that process has actually stopped, remove ${file} and start again.`);
        }
      } else {
        // Another host or container (perhaps under the same hostname): only its heartbeat tells us whether it
        // is alive.
        const age = Math.max(0, Date.now() - mtimeMs); // negative = clock skew; treat as fresh
        const where = rec.hostname === me ? `another container or host under this same hostname "${rec.hostname}"` : `host/container "${rec.hostname}"`;
        if (age > staleMs) reason = 'heartbeat-stale';
        else {
          const waited = Date.now() - started;
          if (waited < waitMs) {
            if (!told) console.warn(`[suds] instance lock: held by pid ${rec.pid} on ${where} (last heartbeat ${secs(age)} s ago); waiting up to ${secs(waitMs)} s for it to stop or go stale (${secs(staleMs)} s without a heartbeat)`);
            told = true;
            sleepSync(Math.min(Math.max(staleMs - age + 10, 10), waitMs - waited, 1000));
            continue;
          }
          throw new Error(`Another SUDS process (pid ${rec.pid} on ${where}) is already running against this data directory (${dataDir}): its last heartbeat was ${secs(age)} s ago (waited ${secs(waited)} s). Running more than one instance against the same database is not supported (see docs/DEPLOYMENT.md, "Single instance only") and can corrupt it — stop the other instance or scale to one replica. If "${rec.hostname}" has really stopped (e.g. it crashed moments ago), this start will succeed once ${secs(staleMs)} s have passed without a heartbeat; a restart policy will retry on its own.`);
        }
      }
      // A lock from a process that is no longer running (it crashed, the container was killed, the machine
      // rebooted) is stale; take it over rather than leaving the data directory permanently locked out.
      console.warn(`[suds] instance lock: taking over a stale lock (${reason}, pid ${rec ? rec.pid : 'unknown'}${rec && rec.hostname ? ` on ${rec.hostname}` : ''})`);
      try { fs.unlinkSync(file); } catch (ue) { if (ue.code !== 'ENOENT') throw ue; }
    }
  }
  held.add(key);
  let released = false;
  // Heartbeat: touch the lock file so a process on another host or container can tell a live holder from a
  // crashed one. It also notices when the lock is no longer ours (removed by hand: re-created; replaced by
  // another process: onLost).
  const beat = setInterval(() => {
    if (released) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') {
        try { fs.writeFileSync(file, mine, { mode: 0o600, flag: 'wx' }); return; } catch {}
      }
      clearInterval(beat);
      onLost(`the lock file ${file} could not be read or re-created (${e.code || e.message}); another SUDS process may be using this data directory`);
      return;
    }
    if (text !== mine) {
      clearInterval(beat);
      const rec = parseLock(text);
      onLost(`the lock on ${dataDir} was taken over by ${rec ? `pid ${rec.pid}${rec.hostname ? ` on ${rec.hostname}` : ''}` : 'another process'}; this process must stop writing to the database`);
      return;
    }
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch {}
  }, heartbeatMs);
  beat.unref();
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    held.delete(key);
    try { if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file); } catch {}
  };
  process.once('exit', release);
  return release;
}

module.exports = { acquire, HEARTBEAT_MS, STALE_MS, WAIT_MS, _internals: { bootId, startTime, parseLock, hostname, rootId, pidNs, machineId, identity, sameInstance } };
