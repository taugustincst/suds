'use strict';
// Builds the request handler (used by both the real server and tests).
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const audit = require('./audit');
const auth = require('./auth');
const idempotency = require('./idempotency');
const { Router, HttpError, parseCookies, parseRequestUrl, readBody, securityHeaders, sendJson, serveStatic } = require('./http');

// Simple in-memory rate limiter (per IP + bucket). Deliberately process-local, not shared across
// instances: SUDS runs as exactly one process per database (server/instance-lock.js enforces this at
// startup), so there is only ever one process's memory for it to live in. Do not "fix" this into a
// distributed limiter without first making SUDS support more than one instance — it does not.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 10000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  return b.count <= max;
}
// Is this key already over its limit? Does not count an attempt; the caller counts only the ones it wants
// to (failed sign-ins, say -- a whole office signing in at 8 a.m. from behind one router is not an attack).
function rateLimited(key, max) { const b = buckets.get(key); return !!b && Date.now() <= b.reset && b.count >= max; }
function rateLimitReset(key) { buckets.delete(key); }

// Every route module, in one place. The local kernel builds its router from LOCAL_ROUTE_MODULES below and
// fails loudly if it is missing a loader for one, so adding a route file cannot silently leave the feature
// out of the local-mode kernel.
const ROUTE_MODULES = ['setup', 'auth', 'oidc', 'me', 'app', 'sync', 'dataimport', 'users', 'clients', 'assignments', 'episodes',
  'interventions', 'overdose', 'calls', 'time', 'supervision', 'resources', 'referrals', 'tasks', 'budget', 'notes',
  'consents', 'patient-requests', 'careplan', 'assessments', 'forms', 'documents', 'imports', 'reports', 'caloms', 'handoff', 'admin', 'options', 'regions', 'intake', 'client-errors', 'fhir'];

// Not on a device: setup and app are office-server concerns (first-run wizard, connection info), sync is the
// device's own runner, intake is an inbound API for other systems to call, and oidc needs a live identity
// provider to redirect to — meaningless (and always disabled) on a device with no office server behind it.
// fhir is the office server's integration surface for the county EHR (docs/integration/FHIR.md): a device
// is nobody's system of record and discloses to no one.
const LOCAL_ROUTE_MODULES = ROUTE_MODULES.filter(m => !['setup', 'app', 'sync', 'intake', 'oidc', 'client-errors', 'fhir'].includes(m));

// Served in place of the app shell when local mode is off (the wizard's answer in server.json, or LOCAL_MODE_ENABLED). No scripts, nothing to configure.
const LOCAL_DISABLED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SUDS — local mode is off</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222;line-height:1.5}h1{font-size:1.4rem}a{color:#0b5}</style></head>
<body><h1>Local mode is turned off on this server</h1>
<p>Running SUDS inside the browser (<code>?local=1</code>) keeps a copy of client records and the keys to them in this browser's own storage. This installation's administrator has disabled it.</p>
<p>Use the office sign-in at <a href="/">the main address</a>, and ask your administrator before working offline (docs/PLATFORM.md).</p>
<p>For the administrator: this follows the answer given to <i>Allow staff to keep an offline copy on their devices?</i> in the first-run setup wizard, which is saved as <code>"localModeEnabled"</code> in <code>server.json</code> in the SUDS data folder. To change it, set that to <code>true</code> or <code>false</code> and restart SUDS. A <code>LOCAL_MODE_ENABLED</code> environment variable, where one is set, takes precedence over the file (see docs/DEPLOYMENT.md).</p></body></html>`;

function buildRouter() {
  const r = new Router();
  for (const mod of ROUTE_MODULES) require(`./routes/${mod}`)(r);
  return r;
}

// How much request body a route may send, decided before a byte of it is read — and after the session has
// been resolved, so the cap depends on who is asking. Everything used to get the 60 MB upload cap, which
// let anyone who could reach the port make the server buffer 60 MB per connection with no account at all.
//
// Only the routes that genuinely move files get the large cap, and only for a signed-in session that has
// cleared its second factor; every other authenticated JSON route gets 1 MB, and a request with no session
// (sign-in, setup, health, the inbound intake API) gets 64 KB. Order matters: a body is buffered before the
// handler runs, so a route's own size check (documents.js, resources.js) is a second line, not the first.
const LARGE_BODY_ROUTES = [
  /^\/api\/documents(\/|$)/,                 // client documents (PDF/Word/pictures, up to 20 MB)
  /^\/api\/forms\/templates(\/|$)/,          // county form templates
  /^\/api\/forms\/[^/]+\/files(\/|$)/,       // attachments on a completed form
  /^\/api\/resources\/[^/]+\/photos(\/|$)/,  // provider pictures
  /^\/api\/imports\//,                       // OneNote / spreadsheet / data imports
  /^\/api\/sync\/(push|blob)(\/|$)/,         // a local-mode device's sync payload and attachments
];
function bodyLimit(ctx) {
  const authed = !!ctx.user && !ctx.session?.mfa_pending;
  if (!authed) return ctx.path.startsWith('/api/intake/') ? config.maxJsonBodyBytes : config.maxUnauthBodyBytes;
  if (ctx.path.startsWith('/api/admin/restore')) return config.maxRestoreBodyBytes;
  if (LARGE_BODY_ROUTES.some(re => re.test(ctx.path))) return config.maxBodyBytes;
  return config.maxJsonBodyBytes;
}

// The client address, as seen by the audit log and the rate limiter. Behind a trusted proxy it comes from
// X-Forwarded-For, and from that header's LAST entry: a proxy appends the address it saw the connection
// come from, so the rightmost value is the one the proxy itself vouches for. The first entry is whatever
// the client chose to send, which made the rate limit and the audit trail trivially spoofable.
function clientIp(req) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket?.remoteAddress || '';
}

// node:sqlite reports SQLITE_FULL as errcode 13 with the library's own message; a wrapped error may carry
// only the message, so both are checked.
function isDiskFull(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_FULL' || err.errcode === 13 || err.code === 'ENOSPC') return true;
  return /database or disk is full/i.test(String(err.message || '')) || /database or disk is full/i.test(String(err.errstr || ''));
}

function createHandler() {
  db.open();
  const router = buildRouter();
  const staticHandler = serveStatic(path.join(__dirname, '..', 'public'));

  return async function handle(req, res) {
    securityHeaders(res);
    // Parsed before the try below used to mean a target the parser refused hung the socket; see parseRequestUrl.
    let url;
    try { url = parseRequestUrl(req.url, 'http://localhost'); } catch (e) { sendJson(res, e.status || 400, { error: e.message }); return; }
    const ctx = {
      req, res, method: req.method, path: url.pathname, query: url.searchParams, params: {},
      headers: req.headers, cookies: parseCookies(req.headers.cookie),
      ip: clientIp(req),
      user: null, session: null, body: null,
    };
    try {
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/fhir/')) {
        // Local mode switched off: the shell page for /?local=1 and the kernel it would load are replaced by a
        // short explanation, so the browser copy of SUDS cannot start on this server.
        if (!config.localModeEnabled && (url.searchParams.get('local') === '1' || url.pathname.startsWith('/local/'))) {
          if (url.pathname.startsWith('/local/')) { sendJson(res, 404, { error: 'Local mode is disabled on this server' }); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(LOCAL_DISABLED_PAGE); return;
        }
        staticHandler(req, res); return;
      }
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      ctx.params = m.params;

      // Global API rate limit
      if (!rateLimit(`api:${ctx.ip}`, 600, 60_000)) throw new HttpError(429, 'Too many requests');

      ctx.user = auth.resolveSession(ctx);

      // CSRF: cookie-authenticated state-changing requests must carry the custom header (cannot be sent cross-site without CORS preflight)
      if (ctx.user && ctx.cookies[auth.COOKIE] && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'suds') {
        throw new HttpError(403, 'Missing CSRF header');
      }

      if (!['GET', 'HEAD'].includes(req.method)) {
        const raw = await readBody(req, bodyLimit(ctx));
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { ctx.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
        } else { ctx.rawBody = raw; ctx.body = {}; }
      }
      // A POST with an Idempotency-Key runs once per (user, key); a retry gets the stored answer (idempotency.js).
      const result = await idempotency.run(ctx, async () => { let out; for (const h of m.handlers) { out = await h(ctx); } return out; });
      if (ctx.idempotentReplay && !res.headersSent) res.setHeader('Idempotent-Replayed', 'true');
      if (!res.headersSent) sendJson(res, result === undefined ? 204 : (ctx.status || 200), result === undefined ? null : result);
    } catch (err) {
      // Routes that stream (exports, PDFs, backups, certificates) may already have written a header. A
      // second write here would throw inside the catch and take the process down, so it is guarded: the
      // request is simply cut off and the error is still logged.
      if (err instanceof HttpError && url.pathname.startsWith('/fhir/')) {
        // The FHIR API answers every failure as an OperationOutcome (an unknown path, a 405, the global rate limit).
        if (err.status === 413 && !res.headersSent) res.setHeader('Connection', 'close');
        require('./fhir/common').sendError(res, err.status, err.message);
      } else if (err instanceof HttpError) {
        // An over-limit body is still arriving (readBody stopped keeping it, not reading it); close the
        // connection once the answer is out rather than keep draining a stream nobody wants.
        if (err.status === 413 && !res.headersSent) res.setHeader('Connection', 'close');
        if (!res.headersSent) sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
        else res.destroy();
      } else if (isDiskFull(err)) {
        // SQLite could not write because the disk under the database is full. Nothing the person at the
        // keyboard did caused it and nothing they can do fixes it; say what is wrong and who to tell.
        console.error(`[suds] ${req.method} ${url.pathname}: disk full:`, err.message);
        if (!res.headersSent) sendJson(res, 507, { error: "The server's disk is full; contact IT", diskFull: true });
        else res.destroy();
      } else {
        console.error(`[suds] ${req.method} ${url.pathname}:`, err);
        try { audit.log({ user: ctx.user, action: 'server.error', ip: ctx.ip, success: false, details: { path: url.pathname, message: String(err.message).slice(0, 300) } }); } catch {}
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
        else res.destroy();
      }
    }
  };
}

module.exports = { createHandler, rateLimit, rateLimited, rateLimitReset, ROUTE_MODULES, LOCAL_ROUTE_MODULES };
