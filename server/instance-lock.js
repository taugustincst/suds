'use strict';
// SUDS is a single-writer, single-instance application: one SQLite file, one process. There is no shared
// session store or distributed rate limiter (both live in this process's memory — see server/app.js), and
// SQLite's own file locking is not safe across two processes writing to the same database from different
// machines (e.g. a network filesystem). A second process against the same data directory — a systemd
// restart racing the old process's shutdown, or an orchestrator mistakenly scaled to more than one replica
// against the same volume — is the actual danger this guards against, not a theoretical one: it can corrupt
// the database. Enforced with a pidfile rather than documented and hoped for.
const fs = require('node:fs');
const path = require('node:path');

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * Take the lock for `dataDir`, or throw a clear error if another live process already holds it. A lock left
 * behind by a process that crashed without cleaning up (dead pid) is taken over automatically. Returns a
 * release function; also released automatically on process exit.
 */
function acquire(dataDir) {
  if (!dataDir) return () => {};
  const file = path.join(dataDir, '.suds.lock');
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { mode: 0o600, flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      if (pid && isRunning(pid)) {
        throw new Error(`Another SUDS process (pid ${pid}) is already running against this data directory (${dataDir}). Running more than one instance against the same database is not supported (see docs/DEPLOYMENT.md, "Single instance only") and can corrupt it. If that process has actually stopped, remove ${file} and start again.`);
      }
      // A lock from a process that is no longer running (it crashed, or the machine was killed) is stale;
      // take it over rather than leaving the data directory permanently locked out.
      try { fs.unlinkSync(file); } catch {}
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch {}
  };
  process.once('exit', release);
  return release;
}

module.exports = { acquire };
