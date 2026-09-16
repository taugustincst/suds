'use strict';
// Manages the HTTP(S) listener so the setup wizard can switch from the local-only bootstrap listener to
// the configured host/port/TLS without restarting the process.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const mdns = require('./mdns');
const SUDS_NAME = 'suds';

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
  const std = (scheme === 'https' && current.port === 443) || (scheme === 'http' && current.port === 80);
  const p = std ? '' : `:${current.port}`;
  const urls = []; let friendly = null;
  if (current.host === '0.0.0.0' || current.host === '::') {
    if (mdns.active()) { friendly = `${scheme}://${SUDS_NAME}.local${p}`; urls.push(friendly); }
    for (const a of lanAddresses()) urls.push(`${scheme}://${a.address}${p}`);
    urls.push(`${scheme}://localhost${p}`);
  } else urls.push(`${scheme}://${current.host === '127.0.0.1' ? 'localhost' : current.host}${p}`);
  return { scheme, host: current.host, port: current.port, tls: !!current.certPath, urls, friendly, lan: lanAddresses(), hostname: os.hostname(), mdns: mdns.active() };
}
// Try the standard port first (https 443 / http 80) so the address needs no port number; fall back to 8443/8080.
async function makeWithFallback(handler, opts) {
  const std = opts.certPath ? 443 : 80; const alt = opts.certPath ? 8443 : 8080;
  const ports = opts.port === 'auto' ? [std, alt, alt + 1] : [opts.port];
  let lastErr;
  for (const port of ports) { try { const s = await make(handler, { ...opts, port }); return { s, port }; } catch (e) { lastErr = e; if (e.code !== 'EACCES' && e.code !== 'EADDRINUSE') throw e; } }
  throw lastErr;
}
function updateMdns() { if (current && (current.host === '0.0.0.0' || current.host === '::')) mdns.start([SUDS_NAME, os.hostname()]); else mdns.stop(); }

async function start(handler) {
  const opts = { host: config.host, port: config.port, certPath: config.tls.cert, keyPath: config.tls.key };
  try { const r = await makeWithFallback(handler, opts); server = r.s; current = { ...opts, port: r.port }; updateMdns(); }
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
  const { s: next, port } = await makeWithFallback(handler, opts);
  next._handler = handler;
  const old = server; server = next; current = { ...opts, port }; updateMdns();
  setTimeout(() => { try { old.close(); old.closeAllConnections?.(); } catch {} }, 1500);
  const d = describe();
  console.log(`[suds] now listening on ${d.urls.join('  ')}`);
  return d;
}

function stop(cb) { mdns.stop(); if (server) server.close(cb); else cb && cb(); }

module.exports = { start, relisten, describe, stop, lanAddresses };
