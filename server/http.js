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

// HSTS: sent when this process terminates TLS itself, and when a trusted proxy (TRUST_PROXY) says the
// request reached it over https -- not every county runs the bundled Caddyfile, which adds it too.
function behindTls(req) {
  if (!req || !config.trustProxy) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}
function securityHeaders(res, req) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', require('./csp').CSP);
  if (config.tls.cert || behindTls(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/**
 * A Content-Disposition value for a download whose name someone typed (an upload's file name, a template
 * name, a client code). The quoted filename is plain ASCII with quotes, backslashes, semicolons and control
 * characters (CR/LF: header injection) removed; the real name, when it differs, travels percent-encoded in
 * filename* (RFC 6266 / 5987), which no character can break out of. Node refuses a header value outside
 * Latin-1, so a Chinese file name used to make the download a 500.
 */
function contentDisposition(type, filename, fallback = 'download') {
  const name = String(filename ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || fallback;
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\;%/]/g, '_').trim() || fallback;
  const star = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type === 'inline' ? 'inline' : 'attachment'}; filename="${ascii}"${ascii !== name ? `; filename*=UTF-8''${star}` : ''}`;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ---- compression ----
// A JSON answer of any size used to go out as it was: a device's first sync of a 2,000-client caseload was
// 30 pages and 80 MB, a Supplies page half a megabyte. JSON is mostly repeated keys and short values and
// compresses to a tenth or less, so an answer of at least COMPRESS_MIN bytes goes out compressed when the
// request says it can take it (Accept-Encoding: br is preferred, then gzip), and exactly as before otherwise.
// The work runs on libuv's thread pool (zlib's asynchronous API), not the event loop, so a large page does not
// hold up anyone else's request while it is squeezed. Not used by the device kernel, which answers its own
// pages in memory (local/kernel.js) and has no thread pool.
// Not a BREACH risk (guessing a secret from compressed sizes): that needs the victim's browser to send
// authenticated cross-site requests that reflect attacker-chosen text, and the session cookie is
// SameSite=Strict (server/auth.js), so a cross-site request carries no session at all
// (docs/PERFORMANCE.md, "Compressed responses").
const zlib = require('node:zlib');
const COMPRESS_MIN = 1024;
const BR_QUALITY = 4; // measured on a 3.2 MB sync page: 15 ms off the event loop, a seventh smaller than gzip -6
/** Whether `req` accepts content-coding `enc` (a q=0 entry refuses it). */
function accepts(req, enc) {
  const header = String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';').map(x => x.trim());
    if (name !== enc) continue;
    const q = params.find(x => x.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}
/** The encoding to answer `req` with, of those this server can produce (br, then gzip), or null. */
function chooseEncoding(req) {
  if (typeof zlib.brotliCompress !== 'function' || typeof zlib.gzip !== 'function') return null;
  if (accepts(req, 'br')) return 'br';
  if (accepts(req, 'gzip')) return 'gzip';
  return null;
}
function compress(buf, enc, { quality = BR_QUALITY, level = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const done = (err, out) => (err ? reject(err) : resolve(out));
    if (enc === 'br') zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, done);
    else zlib.gzip(buf, { level }, done);
  });
}
/**
 * sendJson for the request pipeline (server/app.js): the same answer, compressed when it is at least
 * COMPRESS_MIN bytes and `req` accepts it. Returns a promise when it compresses (the caller awaits it).
 */
function sendJsonTo(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj ?? null));
  const big = body.length >= COMPRESS_MIN;
  const enc = big ? chooseEncoding(req) : null;
  const plain = () => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length };
    if (big) headers.Vary = 'Accept-Encoding';
    res.writeHead(status, headers); res.end(body);
  };
  if (!enc) { plain(); return undefined; }
  return compress(body, enc).then((out) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': enc, Vary: 'Accept-Encoding', 'Content-Length': out.length });
    res.end(out);
  }, (err) => {
    // Compression failing is not the request failing: the answer goes out as it is.
    console.error('[suds] compressing a response failed; sending it uncompressed:', err && err.message);
    if (!res.headersSent && !res.destroyed) plain();
  });
}

// The local-mode kernel and its WebAssembly are the two big downloads a phone makes (over a megabyte
// each, uncompressed). `npm run build:local` writes a .gz and a .br beside each; a request whose
// Accept-Encoding allows one gets it, with Content-Encoding set, and anything else gets the plain file.
const PRECOMPRESSED = [['br', '.br'], ['gzip', '.gz']];
function pickEncoding(req, filePath) {
  for (const [enc, ext] of PRECOMPRESSED) {
    if (!accepts(req, enc)) continue;
    if (fs.existsSync(filePath + ext)) return { enc, file: filePath + ext };
  }
  return null;
}

// Cache policy for a static file. The HTML pages, the service worker, version.json and an unversioned kernel
// keep securityHeaders' `no-store`: a page must never come from a cache after a release, and version.json is
// how an open page learns of one. The two kernel assets requested with a version query
// (`/local/kernel.js?v=1.8.0`) change URL with every release, so they may be kept for good. The app's modules,
// stylesheet and icons are `no-cache` with an ETag: the browser keeps a copy and asks each time whether it is
// still current, so an unchanged file costs a 304 with no body instead of the whole file again (they were
// 900 kB, downloaded again on every visit). None of these files holds anything about a client, and the
// service worker already keeps the same files in its own cache for offline use (public/sw.js).
const REVALIDATE = new Set(['.js', '.css', '.svg', '.png', '.ico', '.woff2', '.webmanifest']);
const NO_STORE_FILES = new Set(['sw.js', 'version.json']);
function cachePolicy(url, filePath) {
  if (url && url.pathname.startsWith('/local/') && url.searchParams.get('v')) return 'public, max-age=31536000, immutable';
  if (!url || !filePath || url.pathname.startsWith('/local/')) return null;
  if (NO_STORE_FILES.has(path.basename(filePath)) || !REVALIDATE.has(path.extname(filePath).toLowerCase())) return null;
  return 'no-cache';
}

// Static files are read once and kept in memory with their ETag and compressed copies, checked against the
// file's size and modification time on every request (an upgrade that replaces a file is seen at once). A text
// file with no precompressed copy beside it is compressed here, once per file and encoding — brotli at its
// best setting, since it happens once, on the thread pool — so the app's modules go out at about a third of
// their size.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.md', '.webmanifest', '.ico']);
const FILE_CACHE_MAX = 400;
const fileCache = new Map();
function cachedFile(filePath) {
  const st = fs.statSync(filePath);
  let e = fileCache.get(filePath);
  if (e && e.size === st.size && e.mtimeMs === st.mtimeMs) return e;
  const data = fs.readFileSync(filePath);
  e = { size: st.size, mtimeMs: st.mtimeMs, data, variants: new Map(),
    etag: `W/"${require('node:crypto').createHash('sha256').update(data).digest('base64url').slice(0, 32)}"` };
  if (fileCache.size >= FILE_CACHE_MAX) fileCache.clear();
  fileCache.set(filePath, e);
  return e;
}
function compressedVariant(e, enc) {
  if (!e.variants.has(enc)) {
    e.variants.set(enc, compress(e.data, enc, { quality: zlib.constants.BROTLI_MAX_QUALITY, level: 9 })
      .then((out) => (out.length < e.data.length ? out : null), () => null));
  }
  return e.variants.get(enc);
}
// If-None-Match: a list of entity tags, or *. Compared weakly (RFC 9110 §13.1.2), as a conditional GET is.
function notModified(req, etag) {
  const inm = req && req.headers && req.headers['if-none-match'];
  if (!inm) return false;
  const opaque = (t) => t.trim().replace(/^W\//, '');
  return String(inm).split(',').some(t => opaque(t) === '*' || opaque(t) === opaque(etag));
}

/** Send a static file. Returns a promise while it compresses the file on the way out, otherwise nothing. */
function sendFile(res, filePath, { req, url } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  const cache = cachePolicy(url, filePath); if (cache) headers['Cache-Control'] = cache;
  const pre = req ? pickEncoding(req, filePath) : null;
  if (pre) {
    headers['Content-Encoding'] = pre.enc; headers.Vary = 'Accept-Encoding';
    const data = fs.readFileSync(pre.file);
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers); res.end(data);
    return undefined;
  }
  const e = cachedFile(filePath);
  const compressible = COMPRESSIBLE.has(ext) && e.data.length >= COMPRESS_MIN;
  if (compressible) headers.Vary = 'Accept-Encoding';
  if (cache === 'no-cache') {
    // Every encoding of a file is the same content, so one weak tag serves them all; the 304 carries no body.
    headers.ETag = e.etag;
    if (notModified(req, e.etag)) { delete headers['Content-Type']; res.writeHead(304, headers); res.end(); return undefined; }
  }
  const plain = () => { headers['Content-Length'] = e.data.length; res.writeHead(200, headers); res.end(e.data); };
  const enc = compressible && req ? chooseEncoding(req) : null;
  if (!enc) { plain(); return undefined; }
  return compressedVariant(e, enc).then((out) => {
    if (res.headersSent || res.destroyed) return;
    if (!out) { plain(); return; }
    headers['Content-Encoding'] = enc; headers['Content-Length'] = out.length;
    res.writeHead(200, headers); res.end(out);
  });
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
    const pending = sendFile(res, file, { req, url });
    if (pending) pending.catch((e) => { console.error('[suds] static file:', e && e.message); if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' }); else res.destroy(); });
    return true;
  };
}

module.exports = { Router, HttpError, badRequest, unauthorized, forbidden, notFound, conflict, parseCookies, parseRequestUrl, readBody, securityHeaders, contentDisposition, sendJson, sendJsonTo, sendFile, serveStatic, chooseEncoding, COMPRESS_MIN };
