'use strict';
const config = require('./config');
const db = require('./db');
const { createHandler } = require('./app');
const { ensureBootstrap } = require('./bootstrap');
const listener = require('./listener');

db.open();
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
function housekeeping() {
  try {
    db.run(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`, db.now(), new Date(Date.now() - 86400000).toISOString());
    require('./audit').purge(config.auditRetentionDays);
    require('./audit').purgeTombstones(config.tombstoneRetentionDays);
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
