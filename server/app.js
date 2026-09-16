'use strict';
// Builds the request handler (used by both the real server and tests).
const path = require('node:path');
const { URL } = require('node:url');
const config = require('./config');
const db = require('./db');
const audit = require('./audit');
const auth = require('./auth');
const { Router, HttpError, parseCookies, readBody, securityHeaders, sendJson, serveStatic } = require('./http');

// Simple in-memory rate limiter (per IP + bucket)
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 10000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  return b.count <= max;
}

function buildRouter() {
  const r = new Router();
  for (const mod of ['auth', 'users', 'clients', 'assignments', 'interventions', 'calls', 'time', 'resources', 'referrals', 'tasks', 'budget', 'notes', 'consents', 'imports', 'reports', 'admin', 'intake']) {
    require(`./routes/${mod}`)(r);
  }
  return r;
}

function createHandler() {
  db.open();
  const router = buildRouter();
  const staticHandler = serveStatic(path.join(__dirname, '..', 'public'));

  return async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const ctx = {
      req, res, method: req.method, path: url.pathname, query: url.searchParams, params: {},
      headers: req.headers, cookies: parseCookies(req.headers.cookie),
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '',
      user: null, session: null, body: null,
    };
    try {
      if (!url.pathname.startsWith('/api/')) { staticHandler(req, res); return; }
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
        const raw = await readBody(req);
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { ctx.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
        } else { ctx.rawBody = raw; ctx.body = {}; }
      }
      let result;
      for (const h of m.handlers) { result = await h(ctx); }
      if (!res.headersSent) sendJson(res, result === undefined ? 204 : (ctx.status || 200), result === undefined ? null : result);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
      } else {
        console.error(`[suds] ${req.method} ${url.pathname}:`, err);
        try { audit.log({ user: ctx.user, action: 'server.error', ip: ctx.ip, success: false, details: { path: url.pathname, message: String(err.message).slice(0, 300) } }); } catch {}
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  };
}

module.exports = { createHandler, rateLimit };
