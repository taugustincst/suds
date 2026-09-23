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
function updateMdns() { if (current && (current.host === '0.0.0.0' || current.host === '::')) mdns.start([SUDS_NAME, os.hostname()], { port: current.port, tls: !!current.certPath }); else mdns.stop(); }

async function start(handler) {
  const opts = { host: config.host, port: config.port, certPath: config.tls.cert, keyPath: config.tls.key };
  try { const r = await makeWithFallback(handler, opts); server = r.s; current = { ...opts, port: r.port }; updateMdns(); }
  catch (e) {
    if (e.code === 'EADDRINUSE') { console.error(`[suds] Port ${opts.port} is already in use. Is SUDS already running? Open your browser to the address shown in the other window, or close it and try again.`); process.exit(1); }
    throw e;
  }
  const d = describe();
  console.log(`[suds] SUD Navigator Services Tracker listening on ${d.urls.join('  ')} (${config.env})`);
  // "Complete setup" only when the wizard is actually the way in: a server configured by environment
  // variables (keys from env, SUDS_SKIP_SETUP) or one whose administrator already exists never shows it,
  // and telling someone to open a wizard that will not appear sends them looking for a fault.
  let setupNeeded = false; try { setupNeeded = require('./routes/setup').isNeeded(); } catch { setupNeeded = !config.setupComplete; }
  if (setupNeeded) console.log('[suds] First run: open the address above in a browser to complete setup.');
  else if (!d.tls && config.isProd) console.warn('[suds] WARNING: TLS not configured. Run behind a TLS-terminating reverse proxy or enable HTTPS in Administration.');
  server._handler = handler;
  return d;
}

// Switch to new options; the old listener closes after the new one is bound. Returns the new description.
async function relisten(opts) {
  const handler = server._handler;
  const old = server;
  // Rebinding the port already in use (the port is fixed by PORT in the environment and setup is switching
  // HTTPS on, or opening the listener to the network) needs the old listener to let go of it first.
  // close() stops accepting new connections and releases the port; the connection carrying this very
  // request stays open until its response has gone out, and is cut with the rest below.
  const samePort = !!current && Number(opts.port) === Number(current.port);
  if (samePort) { old.close(); await new Promise(r => setTimeout(r, 150)); }
  let next, port;
  try { ({ s: next, port } = await makeWithFallback(handler, opts)); }
  catch (e) {
    // Put the old listener back, so a port that could not be bound does not leave the server unreachable.
    if (samePort) { try { server = await make(handler, current); server._handler = handler; } catch {} }
    throw e;
  }
  next._handler = handler;
  server = next; current = { ...opts, port }; updateMdns();
  setTimeout(() => { try { old.close(); old.closeAllConnections?.(); } catch {} }, 1500);
  const d = describe();
  console.log(`[suds] now listening on ${d.urls.join('  ')}`);
  return d;
}

// Close cleanly, but do not hang: a browser tab holding a keep-alive connection would otherwise stop
// server.close() from ever calling back, and Ctrl+C would look like a freeze.
function stop(cb) {
  mdns.stop();
  if (!server) { cb && cb(); return; }
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); cb && cb(); };
  const timer = setTimeout(finish, 3000);
  timer.unref?.();
  server.close(finish);
  try { server.closeAllConnections?.(); } catch {}
}

module.exports = { start, relisten, describe, stop, lanAddresses };
