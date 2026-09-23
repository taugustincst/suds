'use strict';
// Minimal HTTP framework: routing, JSON bodies, cookies, errors, security headers, static files.
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const badRequest = (m, extra) => new HttpError(400, m, extra);
const unauthorized = (m = 'Authentication required') => new HttpError(401, m);
const forbidden = (m = 'Forbidden') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// A request target the URL parser refuses (`GET /%` and friends) used to throw before any try/catch in
// the static server, which took the whole process down; `GET //x` parsed as a protocol-relative URL and
// answered for the wrong path. Leading slashes are collapsed and a target that still cannot be parsed
// is a 400, on both the office server (server/app.js) and the static-site server (scripts/serve-static.js).
function parseRequestUrl(rawUrl, base = 'http://localhost') {
  const target = String(rawUrl || '/').replace(/^\/{2,}/, '/');
  let url;
  try { url = new URL(target.startsWith('/') ? target : '/' + target, base); } catch { throw new HttpError(400, 'Malformed request URL'); }
  try { decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Malformed request URL'); }
  return url;
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
    return this;
  }
  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }
  match(method, pathname) {
    let pathMatched = false; let best = null;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      if (best && best.r.keys.length <= r.keys.length) continue; // prefer static segments over params
      best = { r, m };
    }
    if (best) {
      const params = {};
      best.r.keys.forEach((k, i) => { params[k] = decodeURIComponent(best.m[i + 1]); });
      return { params, handlers: best.r.handlers };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit = config.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        // Stop keeping the bytes, but do not tear the socket down here: a reset while the client is still
        // sending makes it discard the 413 that explains what happened. The remainder is drained and thrown
        // away, the response goes out with Connection: close (server/app.js), and the socket ends after it.
        chunks.length = 0;
        req.removeListener('data', onData);
        req.resume();
        reject(new HttpError(413, 'Payload too large'));
      } else chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (config.tls.cert) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// The local-mode kernel and its WebAssembly are the two big downloads a phone makes (over a megabyte
// each, uncompressed). `npm run build:local` writes a .gz and a .br beside each; a request whose
// Accept-Encoding allows one gets it, with Content-Encoding set, and anything else gets the plain file.
const PRECOMPRESSED = [['br', '.br'], ['gzip', '.gz']];
function pickEncoding(req, filePath) {
  const accept = String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  for (const [enc, ext] of PRECOMPRESSED) {
    if (!new RegExp(`(^|,)\\s*${enc}\\s*(;|,|$)`).test(accept)) continue;
    if (fs.existsSync(filePath + ext)) return { enc, file: filePath + ext };
  }
  return null;
}

// Cache policy for a static file. Everything is `no-store` by default (securityHeaders) so a shared computer
// keeps nothing; the two kernel assets are the exception when they are requested with a version query
// (`/local/kernel.js?v=1.8.0`): the URL changes with every release, so the copy may be kept for good. The
// HTML shell, the app modules and anything without a version stay no-store.
function cachePolicy(url) {
  if (url && url.pathname.startsWith('/local/') && url.searchParams.get('v')) return 'public, max-age=31536000, immutable';
  return null;
}

function sendFile(res, filePath, { req, url } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  const cache = cachePolicy(url); if (cache) headers['Cache-Control'] = cache;
  const pre = req ? pickEncoding(req, filePath) : null;
  if (pre) { headers['Content-Encoding'] = pre.enc; headers.Vary = 'Accept-Encoding'; }
  const data = fs.readFileSync(pre ? pre.file : filePath);
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(data);
}

function serveStatic(root) {
  root = path.resolve(root);
  return (req, res) => {
    let url;
    try { url = parseRequestUrl(req.url, 'http://x'); } catch (e) { sendJson(res, e.status || 400, { error: e.message }); return true; }
    let p = decodeURIComponent(url.pathname);
    if (p === '/app' || p === '/app/') p = '/get-app.html';
    else if (p === '/' || !path.extname(p)) p = '/index.html'; // SPA fallback
    const file = path.resolve(path.join(root, p));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      sendJson(res, 404, { error: 'Not found' }); return true;
    }
    sendFile(res, file, { req, url }); return true;
  };
}

module.exports = { Router, HttpError, badRequest, unauthorized, forbidden, notFound, conflict, parseCookies, parseRequestUrl, readBody, securityHeaders, sendJson, sendFile, serveStatic };
