'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const config = require('./config');
const db = require('./db');
const { createHandler } = require('./app');
const { ensureBootstrap } = require('./bootstrap');
const listener = require('./listener');

db.open();
ensureBootstrap();
const handler = createHandler();
listener.start(handler);

// Housekeeping: purge expired sessions and enforce audit retention hourly
setInterval(() => {
  try {
    db.run(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`, db.now(), new Date(Date.now() - 86400000).toISOString());
    require('./audit').purge(config.auditRetentionDays);
  } catch (e) { console.error('[suds] housekeeping', e); }
}, 3600_000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { listener.stop(() => { db.close(); process.exit(0); }); });
