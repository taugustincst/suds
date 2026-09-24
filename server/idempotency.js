'use strict';
// Idempotency-Key for POSTs. A retried save used to run twice: two referrals, two disclosure-accounting
// rows and two follow-up to-dos from one referral form sent again after a dropped connection; a resent
// visit doubled the naloxone kits and the time entry. The browser (public/app.js) now sends a key per
// logical submit and reuses it when the same submission is retried. Here, the first request with a given
// (user, key) runs and its answer is kept; a repeat within 24 hours gets that answer back without running
// again. The same key sent with a different request is refused (422), because answering it with the
// first request's result would be wrong either way.
//
// Only successful answers are kept: a request refused for validation (400), permissions (403) or a
// conflict (409) did nothing, so a corrected retry must be allowed to run. The answer can name a client,
// so it is stored encrypted; the key itself is not stored, only sha256(user id | key).
//
// Used by server/app.js on the office server and by local/kernel.js on a device, around the route
// handlers. A request without the header behaves exactly as before (sync, imports, API integrations).
const db = require('./db');
const audit = require('./audit');
const { HttpError } = require('./http');
const { sha256, encrypt, decrypt } = require('./crypto');

const TTL_MS = 24 * 3600 * 1000;
const MAX_STORED_BYTES = 512 * 1024;
// Not covered: sign-in and session routes (their answers are credentials, and there is no user yet),
// the sync protocol (it has its own per-row idempotency and very large payloads), first-run setup and
// account management (answers can carry a temporary password or an API key, which must not be kept).
const EXEMPT = [/^\/api\/auth\//, /^\/api\/sync\//, /^\/api\/setup(\/|$)/, /^\/api\/users(\/|$)/, /^\/api\/admin\/(api-keys|restore|keys-backup)/, /^\/api\/me\/(password|mfa)/];

// Requests with the same key that are still running: the second waits for the first and then replays it,
// rather than both running because neither had finished storing its answer.
const inflight = new Map();
let lastPurge = 0;

function applies(ctx) {
  if (ctx.method !== 'POST' || !ctx.user) return false;
  if (!ctx.headers || ctx.headers['idempotency-key'] === undefined) return false;
  return !EXEMPT.some(re => re.test(ctx.path));
}

function requestHash(ctx) {
  const body = ctx.rawBody && ctx.rawBody.length ? sha256(ctx.rawBody) : JSON.stringify(ctx.body ?? null);
  return sha256(`${ctx.method} ${ctx.path}?${ctx.query ? ctx.query.toString() : ''}\n${body}`);
}

/**
 * Run `exec` (the route's handlers) at most once per (user, Idempotency-Key). Returns the handler result,
 * or the stored one on a repeat; sets ctx.status and ctx.idempotentReplay accordingly.
 */
async function run(ctx, exec) {
  if (!applies(ctx)) return exec();
  const key = String(ctx.headers['idempotency-key']);
  if (!key || key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) throw new HttpError(400, 'Idempotency-Key must be 1-255 printable characters');
  maybePurge();
  const id = sha256(`${ctx.user.id}|${key}`);
  const hash = requestHash(ctx);
  while (inflight.has(id)) { try { await inflight.get(id); } catch { /* the first attempt's error is its own */ } }
  const prior = db.one(`SELECT * FROM idempotency_keys WHERE id=? AND created_at > ?`, id, new Date(Date.now() - TTL_MS).toISOString());
  if (prior) {
    if (prior.request_hash !== hash || prior.user_id !== ctx.user.id) {
      audit.log({ user: ctx.user, action: 'idempotency.mismatch', ip: ctx.ip, success: false, details: { path: ctx.path } });
      throw new HttpError(422, 'This request was already sent with the same Idempotency-Key and different content. Reload the form and try again.');
    }
    // The stored answer is a read of whatever the first request returned (possibly PHI), so it is audited.
    audit.log({ user: ctx.user, action: 'idempotency.replay', ip: ctx.ip, details: { path: ctx.path, status: prior.status, first_at: prior.created_at } });
    ctx.status = prior.status; ctx.idempotentReplay = true;
    return prior.response_enc ? JSON.parse(decrypt(prior.response_enc)) : undefined;
  }
  let done; const gate = new Promise((resolve) => { done = resolve; });
  inflight.set(id, gate);
  try {
    const result = await exec();
    const status = result === undefined ? 204 : (ctx.status || 200);
    // A streamed answer (a file, a PDF) cannot be replayed; neither is anything but a success.
    if (!(ctx.res && ctx.res.headersSent) && status >= 200 && status < 300) {
      const json = result === undefined ? null : JSON.stringify(result);
      if (json === null || json.length <= MAX_STORED_BYTES) {
        db.run(`INSERT OR REPLACE INTO idempotency_keys(id,user_id,method,path,request_hash,status,response_enc,created_at) VALUES(?,?,?,?,?,?,?,?)`,
          id, ctx.user.id, ctx.method, ctx.path, hash, status, json === null ? null : encrypt(json), db.now());
      }
    }
    return result;
  } finally { inflight.delete(id); done(); }
}

/** Remove answers older than 24 hours. Called by the hourly housekeeping; returns how many went. */
function purge(now = Date.now()) {
  lastPurge = now;
  return db.run(`DELETE FROM idempotency_keys WHERE created_at <= ?`, new Date(now - TTL_MS).toISOString()).changes;
}
// A device (local mode) has no housekeeping timer, so the table is also trimmed from here, at most hourly.
function maybePurge() { if (Date.now() - lastPurge > 3600 * 1000) { try { purge(); } catch { /* never blocks a request */ } } }

module.exports = { run, purge, TTL_MS };
