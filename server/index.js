'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const config = require('./config');
const db = require('./db');
const { createHandler } = require('./app');
const { ensureBootstrap } = require('./bootstrap');

db.open();
ensureBootstrap();
const handler = createHandler();

let server;
if (config.tls.cert && config.tls.key) {
  server = https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key), minVersion: 'TLSv1.2' }, handler);
} else {
  if (config.isProd) console.warn('[suds] WARNING: TLS not configured. Run behind a TLS-terminating reverse proxy or set TLS_CERT_PATH/TLS_KEY_PATH.');
  server = http.createServer(handler);
}
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
server.listen(config.port, config.host, () => {
  console.log(`[suds] SUD Navigator Services Tracker listening on ${config.tls.cert ? 'https' : 'http'}://${config.host}:${config.port} (${config.env})`);
});

// Housekeeping: purge expired sessions and enforce audit retention hourly
setInterval(() => {
  try {
    db.run(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`, db.now(), new Date(Date.now() - 86400000).toISOString());
    db.run(`DELETE FROM audit_log WHERE at < ?`, new Date(Date.now() - config.auditRetentionDays * 86400000).toISOString());
  } catch (e) { console.error('[suds] housekeeping', e); }
}, 3600_000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
