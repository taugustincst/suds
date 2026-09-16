'use strict';
// Manages the HTTP(S) listener so the setup wizard can switch from the local-only bootstrap listener to
// the configured host/port/TLS without restarting the process.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');

let server = null; let current = null;

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address });
  return out;
}

function make(handler, { host, port, certPath, keyPath }) {
  let s;
  if (certPath && keyPath) s = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), minVersion: 'TLSv1.2' }, handler);
  else s = http.createServer(handler);
  s.headersTimeout = 30_000; s.requestTimeout = 60_000;
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, () => { s.removeListener('error', reject); resolve(s); });
  });
}

function describe() {
  if (!current) return null;
  const scheme = current.certPath ? 'https' : 'http';
  const urls = [];
  if (current.host === '0.0.0.0' || current.host === '::') { urls.push(`${scheme}://localhost:${current.port}`); for (const a of lanAddresses()) urls.push(`${scheme}://${a.address}:${current.port}`); }
  else urls.push(`${scheme}://${current.host === '127.0.0.1' ? 'localhost' : current.host}:${current.port}`);
  return { scheme, host: current.host, port: current.port, tls: !!current.certPath, urls, lan: lanAddresses(), hostname: os.hostname() };
}

async function start(handler) {
  const opts = { host: config.host, port: config.port, certPath: config.tls.cert, keyPath: config.tls.key };
  try { server = await make(handler, opts); current = opts; }
  catch (e) {
    if (e.code === 'EADDRINUSE') { console.error(`[suds] Port ${opts.port} is already in use. Is SUDS already running? Open your browser to the address shown in the other window, or close it and try again.`); process.exit(1); }
    throw e;
  }
  const d = describe();
  console.log(`[suds] SUD Navigator Services Tracker listening on ${d.urls.join('  ')} (${config.env})`);
  if (!config.setupComplete) console.log('[suds] First run: open the address above in a browser to complete setup.');
  else if (!d.tls && config.isProd) console.warn('[suds] WARNING: TLS not configured. Run behind a TLS-terminating reverse proxy or enable HTTPS in Administration.');
  server._handler = handler;
  return d;
}

// Switch to new options; the old listener closes after the new one is bound. Returns the new description.
async function relisten(opts) {
  const handler = server._handler;
  const next = await make(handler, opts);
  next._handler = handler;
  const old = server; server = next; current = opts;
  setTimeout(() => { try { old.close(); old.closeAllConnections?.(); } catch {} }, 1500);
  const d = describe();
  console.log(`[suds] now listening on ${d.urls.join('  ')}`);
  return d;
}

function stop(cb) { if (server) server.close(cb); else cb && cb(); }

module.exports = { start, relisten, describe, stop, lanAddresses };
