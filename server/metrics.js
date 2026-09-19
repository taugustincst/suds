'use strict';
// Prometheus-style plain text metrics (GET /api/metrics, server/routes/app.js) — off by default, and
// bearer-token gated when enabled (server/config.js's metricsToken). No PHI: aggregate counts only, the
// same kind of operational numbers Administration -> System already shows an authenticated admin.
const fs = require('node:fs');
const db = require('./db');
const config = require('./config');

function render() {
  const lines = [];
  const metric = (name, help, type, value, labels = '') => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${labels} ${value}`);
  };
  metric('suds_up', 'Whether the SUDS server process is up.', 'gauge', 1);
  metric('suds_uptime_seconds', 'Seconds since the process started.', 'gauge', Math.round(process.uptime()));
  try {
    metric('suds_build_info', 'Build metadata. Always 1; the version and schema are in its labels.', 'gauge', 1, `{version="${config.version}",schema_version="${db.getSetting('schema_version', '0')}"}`);
    metric('suds_users_active', 'Active user accounts.', 'gauge', db.one(`SELECT COUNT(*) n FROM users WHERE is_active=1`).n);
    metric('suds_clients_total', 'Clients not soft-deleted.', 'gauge', db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n);
    metric('suds_sessions_active', 'Currently active (unexpired, unrevoked) sessions.', 'gauge', db.one(`SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?`, db.now()).n);
    metric('suds_audit_log_rows', 'Rows currently in the audit log.', 'gauge', db.one(`SELECT COUNT(*) n FROM audit_log`).n);
    metric('suds_devices_total', 'Local-mode devices that have ever synced.', 'gauge', db.one(`SELECT COUNT(*) n FROM devices`).n);
    metric('suds_database_up', 'Whether the database answered a query just now.', 'gauge', 1);
  } catch { metric('suds_database_up', 'Whether the database answered a query just now.', 'gauge', 0); }
  try {
    metric('suds_database_bytes', 'Size of the SQLite database file.', 'gauge', fs.statSync(config.dbPath).size);
  } catch { /* :memory: has no file to stat */ }
  try {
    const fsinfo = fs.statfsSync(config.dataDir);
    metric('suds_disk_free_bytes', 'Free space on the volume holding the data directory.', 'gauge', fsinfo.bavail * fsinfo.bsize);
  } catch { /* :memory: or a platform without statfs */ }
  return lines.join('\n') + '\n';
}

module.exports = { render };
