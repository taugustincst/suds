'use strict';
const config = require('./config');
const db = require('./db');
const { createHandler } = require('./app');
const { ensureBootstrap } = require('./bootstrap');
const listener = require('./listener');

// Everything this process creates holds PHI or the keys to it — the database, its WAL and shared-memory
// files, logs, snapshots. Make private the default rather than chasing each file with chmod: SQLite
// creates -wal and -shm itself, and they were coming out world-readable.
if (config.isProd && typeof process.umask === 'function') process.umask(0o077);

// Start logging before anything else, so a failure during startup is recorded rather than lost with the
// window it was printed in.
if (config.dbPath !== ':memory:') require('./log').start(config.dataDir);

// One process per database, enforced (server/instance-lock.js) — not just documented — because a second
// one against the same data directory can corrupt it, not merely waste resources.
if (config.dbPath !== ':memory:') {
  try { require('./instance-lock').acquire(config.dataDir); }
  catch (e) { console.error(`[suds] ${e.message}`); process.exit(1); }
}

db.open();
try { db.checkKeyFingerprint(); } catch (e) { console.error(`[suds] ${e.message}`); process.exit(1); }
ensureBootstrap();
const handler = createHandler();
listener.start(handler);

// A county workstation has no supervisor process watching this one: if an error escapes a request (or
// escapes asynchronous work started outside one), the window simply disappears and SUDS is gone. Log it
// and keep serving instead — a half-broken server staff can still reach beats no server at all.
process.on('unhandledRejection', (reason) => { console.error('[suds] unhandled rejection:', reason && reason.stack || reason); });
process.on('uncaughtException', (err) => {
  console.error('[suds] uncaught exception:', err && err.stack || err);
  // An exception thrown while the process is already shutting down, or one that leaves the database
  // unusable, is not survivable; anything else, keep going.
  if (err && /SQLITE_CORRUPT|SQLITE_NOTADB/.test(String(err.code || err.message))) { console.error('[suds] the database appears to be damaged; stopping so it is not written to further.'); process.exit(1); }
});

// Housekeeping: expired sessions, audit retention, tombstone retention.
let verifying = false;
function housekeeping() {
  try {
    db.run(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`, db.now(), new Date(Date.now() - 86400000).toISOString());
    require('./audit').purge(config.auditRetentionDays);
    require('./audit').purgeTombstones(config.tombstoneRetentionDays);
    require('./log').purge();
    // Retry answers (Idempotency-Key) are kept for 24 hours only.
    require('./idempotency').purge();
    // Record retention: discharged clients past the county's retention period are hard-deleted, every
    // table at once, unless the record is on legal hold (server/retention.js). Once a day.
    require('./retention').runIfDue();
    // Verify the audit chain once a day. Tamper-evidence that nobody checks is not evidence of anything.
    // Incremental from the last verified entry (the whole chain weekly), in batches that yield to other
    // requests — it runs on after this pass returns, and never twice at once.
    const lastVerify = db.getSetting('audit_verified_at', null);
    if (!verifying && (!lastVerify || Date.now() - Date.parse(lastVerify) > 86400000)) {
      verifying = true;
      require('./audit').scheduledVerify().catch((e) => console.error('[suds] audit verification', e && e.message || e)).finally(() => { verifying = false; });
    }
    // Scheduled backup, if an administrator has turned it on under Settings → System & backups. A failure
    // here (disk full, unreachable offsite share) must not stop the rest of housekeeping.
    require('./scheduled-backup').runIfDue();
  } catch (e) { console.error('[suds] housekeeping', e && e.message || e); }
}
setInterval(housekeeping, 3600_000).unref();

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log('[suds] shutting down…');
  listener.stop(() => { try { db.close(); } catch {} process.exit(0); });
});
