'use strict';
// Browser error beacon. A script error on someone's phone used to be invisible to everyone but that person;
// public/app.js now reports uncaught errors, unhandled rejections and 5xx answers here, and they go to the
// application log (server/log.js, WARN) for whoever runs the server to read. Not the audit log: these are
// diagnostics, not accesses to a record.
//
// No PHI. The browser already strips what it sends (message cut to 300 characters with long digit runs
// masked, stack reduced to file:line, the route without its query string), and everything is cleaned again
// here, because a client can send anything: the fields are re-truncated, re-masked and limited to a fixed
// shape, and nothing else from the body is written.
const auth = require('../auth');
const { HttpError } = require('../http');

const PER_MINUTE = 10;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\d{5,}/g, (m) => '#'.repeat(Math.min(m.length, 8))).slice(0, max);
// Emails and anything shaped like a phone number or SSN are masked too, whatever the page sent.
const scrub = (s) => s.replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '[email]').replace(/\b\d{3}[-. ]\d{2,3}[-. ]\d{4}\b/g, '[number]');
const FRAME = /^[\w./-]{1,80}:\d{1,6}$/;

function sanitize(body) {
  const b = body && typeof body === 'object' ? body : {};
  const frames = Array.isArray(b.stack) ? b.stack.slice(0, 5).map(f => clean(f, 90)).filter(f => FRAME.test(f)) : [];
  return {
    kind: ['error', 'rejection', 'api'].includes(b.kind) ? b.kind : 'error',
    message: scrub(clean(b.message, 300)),
    stack: frames,
    route: clean(String(b.route || '').split('?')[0], 80).replace(/[^\w#/.-]/g, ''),
    version: clean(b.version, 20).replace(/[^\w.-]/g, ''),
    browser: clean(b.browser, 40).replace(/[^\w ./-]/g, ''),
    status: Number.isInteger(b.status) && b.status >= 100 && b.status < 600 ? b.status : undefined,
  };
}

module.exports = (r) => {
  r.post('/api/client-errors', auth.requireAuth, (ctx) => {
    const { rateLimit } = require('../app');
    if (!rateLimit(`client-errors:${ctx.user.id}`, PER_MINUTE, 60_000)) throw new HttpError(429, 'Too many error reports');
    const e = sanitize(ctx.body);
    console.warn('[client-error]', JSON.stringify({ user: ctx.user.id, ...e }));
    return { ok: true };
  });
};
module.exports.sanitize = sanitize;
