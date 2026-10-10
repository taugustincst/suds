'use strict';
process.env.SUDS_ENV = 'test';
process.env.SUDS_DB_PATH = ':memory:';
process.env.SUDS_ADMIN_PASSWORD = 'AdminPassw0rd!x';
// The suite's own first administrator keeps the name its tests sign in with; a real install's is "guest".
process.env.SUDS_ADMIN_USERNAME = process.env.SUDS_ADMIN_USERNAME || 'admin';
// Mandatory two-factor is enforced for real (see the dedicated test); the rest of the suite opts out so
// every other assertion is not about enrolment.
process.env.MFA_REQUIRED_ROLES = '';
const http = require('node:http');
const db = require('../server/db');
const { createHandler } = require('../server/app');
const { ensureBootstrap } = require('../server/bootstrap');
const { hashPassword, uuid } = require('../server/crypto');

let server, base;
async function start() {
  if (server) return base;
  db.open(':memory:');
  ensureBootstrap();
  db.run(`UPDATE users SET must_change_password=0`);
  // A new database is a harm-reduction programme with the clinical modules switched off (server/programme.js).
  // The suite exercises every module, so it runs as a treatment-adjacent programme; test/programme.test.js
  // covers the default and the module switches.
  db.setSetting('programme_profile', 'treatment');
  const handler = createHandler();
  server = http.createServer(handler);
  // As in production (server/listener.js): a request the test sends after a long synchronous step must not
  // meet a keep-alive connection the server is closing at that moment ("fetch failed").
  server.keepAliveTimeout = require('../server/listener').KEEP_ALIVE_MS;
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
async function stop() { if (server) { await new Promise(res => server.close(res)); server = null; } db.close(); }

function client() {
  let cookie = '';
  const headers = {};
  async function req(method, path, body, extra = {}) {
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...headers, ...extra };
    if (cookie && extra.Cookie === undefined) h.Cookie = cookie; if (h.Cookie === '') delete h.Cookie;
    const send = () => fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    // A pooled keep-alive connection the server closed as idle, at the moment it was reused: a test that holds the
    // event loop for about the keep-alive time (county-fuzz's CSV sweeps, ~64 s of synchronous work against the
    // server's 65 s) can lose that race (CI: "fetch failed" on the next request). The server had not received the
    // request, so it is sent once more, on a new connection; any other failure is the test's.
    let res;
    try { res = await send(); } catch (e) {
      const code = e && e.cause && e.cause.code;
      if (!['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(code)) { if (code) e.message += ` (${code})`; throw e; }
      res = await send();
    }
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    req, get: (p, e) => req('GET', p, undefined, e), post: (p, b, e) => req('POST', p, b, e), put: (p, b, e) => req('PUT', p, b, e), del: (p, b, e) => req('DELETE', p, b, e),
    setHeader: (k, v) => { headers[k] = v; },
    /** The fetch Response itself (for binary bodies and exact headers), with this client's session. */
    raw: (p, extra = {}) => fetch(base + p, { headers: { 'X-Requested-With': 'suds', ...headers, ...(cookie ? { Cookie: cookie } : {}), ...extra } }),
    async login(username, password) { const r = await req('POST', '/api/auth/login', { username, password }); if (r.status !== 200) throw new Error('login failed: ' + JSON.stringify(r.data)); return r.data; },
  };
}

function makeUser(username, role, password = 'StaffPassw0rd!x') {
  const id = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,password_changed_at) VALUES(?,?,?,?,?,?)`, id, username, hashPassword(password), username, role, db.now());
  return { id, username, password };
}

/**
 * Deny `perms` to a user with per-user overrides (1.15.0, server/auth.js effectivePerms), as an administrator
 * does under Settings -> Users & permissions -> Permissions.
 */
function deny(user, ...perms) {
  for (const p of perms) db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?,?,'deny','test: caseload-scoped worker') ON CONFLICT(user_id, permission) DO UPDATE SET mode='deny'`, user.id, p);
  return user;
}
/**
 * A navigator or clinician held to their caseload, as both roles were by default before 1.16.0: clients:all
 * denied, and for a navigator notes:clinical:read too. From 1.16.0 that is how a programme keeps a worker
 * caseload-scoped, so the tests of caseload scoping use it.
 */
function makeCaseloadUser(username, role, password) {
  const u = makeUser(username, role, password);
  return deny(u, 'clients:all', ...(role === 'navigator' ? ['notes:clinical:read'] : []));
}

/**
 * Register a QSOA, research or audit/evaluation approval (server/disclosure.js: the non-consent bases rest on
 * one whose organisation is the recipient) through `c`, a supervisor's or administrator's client. Returns its id.
 */
async function agreement(c, organisation, kind = 'audit_evaluation', extra = {}) {
  const r = await c.post('/api/disclosure-agreements', { kind, organisation, services: 'Test', approving_body: kind === 'qsoa' ? undefined : 'Test approving body', agreement_date: '2026-01-01', ...extra });
  if (r.status !== 201) throw new Error('agreement failed: ' + JSON.stringify(r.data));
  return r.data.id;
}

// The audit log refuses UPDATE and DELETE (schema.sql triggers). A test that plays someone tampering with
// it does what such a person would have to: drop the guard, edit, and put the guard back.
function asAttacker(fn) {
  const d = db.get();
  d.exec('DROP TRIGGER IF EXISTS audit_log_no_update; DROP TRIGGER IF EXISTS audit_log_no_delete');
  try { return fn(); }
  finally {
    const schema = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
    for (const t of schema.match(/CREATE TRIGGER IF NOT EXISTS audit_log_no_\w+ [\s\S]*?END;/g)) d.exec(t);
  }
}

/**
 * Serve the key backup from a throwaway keys file for the length of a test: config's data folder is the checkout's
 * own, shared by the test files running in parallel (one removing the file while another downloads it reset the
 * connection) and by the developer's real keys. Returns a function that restores config and removes the file.
 */
function throwawayKeys(config, keys = { SUDS_ENCRYPTION_KEY: 'c'.repeat(64) }) {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const was = { keySource: config.keySource, keysJsonPath: config.keysJsonPath };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-keys-'));
  config.keySource = 'file'; config.keysJsonPath = path.join(dir, 'keys.json');
  fs.writeFileSync(config.keysJsonPath, typeof keys === 'string' ? keys : JSON.stringify(keys));
  return () => { Object.assign(config, was); fs.rmSync(dir, { recursive: true, force: true }); };
}

/**
 * The instant (ISO) of `hour`:00 on the programme's calendar day `date`: a fixture that means "a visit on May 2nd" is on
 * May 2nd whatever zone the suite runs in. A fixed UTC instant such as T18:00:00Z is the next day east of UTC (F8).
 */
function localAt(date, hour = 12) { const LD = require('../server/local-date'); return new Date(Date.parse(LD.localMidnight(date)) + hour * 3600000).toISOString(); }
/**
 * An authenticator code from the time-step BEFORE the current one, for a test that then needs two later steps of its
 * own (each code is accepted once, in increasing steps, within ±1 step of the server's clock: server/auth.js useTotp).
 * Such a code stays inside the server's window only until the current step ends; made in the last moments of a step it
 * was two steps old by the time the request arrived, and the server rightly refused it (1.25.4, G1: a 401 on main's CI
 * that the same commit did not show elsewhere). So it is made at the start of a step when fewer than 10 s of this one
 * remain: a request to the in-process server takes milliseconds, and 10 s is ample on a loaded CI runner. A test that
 * needs only two codes uses the current step and then the next one (Date.now() + 30_000) instead, which a step
 * boundary cannot invalidate.
 */
async function totpPreviousStep(secret) {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 10_000) await new Promise((r) => setTimeout(r, left + 20));
  return require('../server/crypto').totp(secret, Date.now() - 30_000);
}
module.exports = { localAt, totpPreviousStep, throwawayKeys, start, stop, client, makeUser, makeCaseloadUser, deny, agreement, db, asAttacker };
