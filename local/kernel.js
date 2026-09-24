// SUDS local kernel: runs the SUDS server logic inside the browser/WebView with an on-device encrypted SQLite
// database, so the phone app works with no server. Exposes window.SUDS_LOCAL.handle(method, path, body, headers).
import sqlite from 'node:sqlite';
import db from '../server/db.js';
import { Router, HttpError } from '../server/http.js';
import auth from '../server/auth.js';
import audit from '../server/audit.js';
import * as sync from './sync.js';

// The list itself comes from the server so the two cannot drift; only the loaders live here, because
// esbuild needs static import specifiers to bundle them.
import { LOCAL_ROUTE_MODULES } from '../server/app.js';
const routeLoaders = {
  auth: () => import('../server/routes/auth.js'), me: () => import('../server/routes/me.js'), users: () => import('../server/routes/users.js'), clients: () => import('../server/routes/clients.js'),
  assignments: () => import('../server/routes/assignments.js'), episodes: () => import('../server/routes/episodes.js'), interventions: () => import('../server/routes/interventions.js'),
  overdose: () => import('../server/routes/overdose.js'), calls: () => import('../server/routes/calls.js'), time: () => import('../server/routes/time.js'), supervision: () => import('../server/routes/supervision.js'),
  resources: () => import('../server/routes/resources.js'), referrals: () => import('../server/routes/referrals.js'), tasks: () => import('../server/routes/tasks.js'), budget: () => import('../server/routes/budget.js'),
  notes: () => import('../server/routes/notes.js'), consents: () => import('../server/routes/consents.js'), 'patient-requests': () => import('../server/routes/patient-requests.js'), forms: () => import('../server/routes/forms.js'), documents: () => import('../server/routes/documents.js'), regions: () => import('../server/routes/regions.js'), imports: () => import('../server/routes/imports.js'), dataimport: () => import('../server/routes/dataimport.js'), reports: () => import('../server/routes/reports.js'), admin: () => import('../server/routes/admin.js'),
};

let router; let token = localStorage.getItem('suds.local.session') || '';

class FakeRes {
  constructor() { this.status = 200; this.headers = {}; this.chunks = []; this.headersSent = false; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  writeHead(status, headers = {}) { this.status = status; for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v; this.headersSent = true; }
  end(body) { if (body !== undefined && body !== null) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body))); this.headersSent = true; }
}

export async function start({ wasmUrl, onSaveError, onLockLost, force } = {}) {
  await sqlite.init(wasmUrl);

  // Only one page may write this device's database: every save writes the whole of it, so two pages would
  // erase each other's work. A page that cannot get the lock is told so and the person chooses; the one
  // exception, the same tab loading again, waits for its previous document to let go instead of stealing.
  // `force` is the person's own "use SUDS in this window": the holder is asked to write out and step aside,
  // then displaced, and the fence (local/shims/sqlite.js) keeps anything it still saves from landing.
  if (onLockLost) sqlite.onLockLost(onLockLost);
  const locked = await sqlite.acquireLock({ force: !!force });
  if (!locked) {
    const e = new Error('SUDS is open in another window on this device.');
    e.code = 'SUDS_ALREADY_OPEN';
    e.stale = sqlite.lockIsStale();
    throw e;
  }
  if (onSaveError) sqlite.setSaveErrorHandler(onSaveError);

  const bytes = await sqlite.loadBytes();
  db.openWith(bytes ? new Uint8Array(bytes) : null);

  // The encryption key and the database live in different browser stores, and browsers clear them
  // independently. If the key store was cleared, a fresh key would be generated and every record on the
  // device would become permanently unreadable — silently, until the next sync failed. Compare a
  // fingerprint of the key against the one recorded when this database was created, and stop if it moved.
  // Via server/crypto.js, so the bundler's config alias applies — importing server/config.js from here
  // would pull in the real Node configuration instead of the device shim.
  const { keyFingerprint } = require('../server/crypto.js');
  const fingerprint = keyFingerprint();
  const stored = db.getSetting('encryption_key_fingerprint', null);
  const hasData = db.one(`SELECT COUNT(*) n FROM users`).n > 0;
  if (!stored) { if (hasData) db.setSetting('encryption_key_fingerprint', fingerprint); else db.setSetting('encryption_key_fingerprint', fingerprint); }
  else if (stored !== fingerprint) {
    const e = new Error('This device\'s security key has been cleared, so the records stored here can no longer be read. Set the app up again and sync from the office server to restore them.');
    e.code = 'SUDS_KEY_LOST';
    throw e;
  }

  router = new Router();
  const missing = LOCAL_ROUTE_MODULES.filter(n => !routeLoaders[n]);
  if (missing.length) throw new Error(`local kernel has no loader for route module(s): ${missing.join(', ')} — add them to routeLoaders in local/kernel.js`);
  for (const name of LOCAL_ROUTE_MODULES) { const mod = (await routeLoaders[name]()).default; mod(router); }
  sync.register(router);
  router.get('/api/local/status', () => ({ local: true, users: db.one(`SELECT COUNT(*) n FROM users`).n, last_sync: db.getSetting('last_sync_at', null), sync_server: db.getSetting('sync_server', null) }));
  router.post('/api/local/setup', (ctx) => {
    if (db.one(`SELECT COUNT(*) n FROM users`).n > 0) throw new HttpError(403, 'Already set up');
    const { validate } = require('../server/validate.js');
    // The role is asked for, not assumed. Hard-coding 'navigator' meant a clinician who set the app up on
    // their phone silently lost access to clinical notes — their own work.
    const v = validate(ctx.body, { display_name: { type: 'string', required: true, maxLen: 120 }, username: { type: 'string', required: true, maxLen: 60, pattern: /^[a-zA-Z0-9._@-]+$/ }, password: { type: 'string', required: true, maxLen: 500 }, org_name: { type: 'string', maxLen: 200 }, role: { type: 'string', enum: ['navigator', 'clinician', 'supervisor', 'admin'] } });
    const errs = auth.passwordPolicy(v.password); if (errs.length) throw new HttpError(400, 'Password must contain ' + errs.join(', '));
    const { hashPassword, uuid } = require('../server/crypto.js');
    db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,?,0,?)`, uuid(), v.username, hashPassword(v.password), v.display_name, v.role || 'navigator', db.now());
    db.setSetting('org_name', v.org_name || 'SUDS on this device'); db.setSetting('caseload_restriction', '0'); db.setSetting('local_mode', '1');
    audit.log({ user: { username: v.username }, action: 'local.setup' });
    return { ok: true };
  });
  // Sample data on the phone: the device user is a navigator, so expose it here (not behind settings:manage)
  const demo = require('../server/demo.js');
  router.get('/api/local/demo', (ctx) => { if (!ctx.user) throw new HttpError(401, 'Sign in first'); return demo.status(); });
  router.post('/api/local/demo', (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    const st = demo.status();
    if (st.loaded) throw new HttpError(400, 'Sample data is already loaded');
    if (st.clients_total > 0) throw new HttpError(400, 'Sample data can only be added while this device has no clients yet');
    return demo.seed({ actor: ctx.user.id, workers: [ctx.user.id], clinician: null, supervisor: ctx.user.id });
  });
  router.delete('/api/local/demo', (ctx) => { if (!ctx.user) throw new HttpError(401, 'Sign in first'); return demo.remove({ actor: ctx.user.id }); });
  window.SUDS_LOCAL = { handle, flush: (opts) => sqlite.flush(opts), isDirty: () => sqlite.isDirty(), epoch: () => sqlite.epoch(), wipe: wipeDevice, sync: (opts) => sync.run(opts), isWiped: () => sqlite.isWiped(), isFrozen: () => sqlite.isFrozen() };
  return window.SUDS_LOCAL;
}

/**
 * Erase everything SUDS keeps in this browser profile: the database (and the in-memory copy, so nothing
 * writes it back), the sign-in token, and the encryption keys — so even a stale copy of the database that
 * somehow survives is unreadable. The device id lives inside the database and goes with it; the office is
 * told the wipe happened with the id captured before the erase (local/sync.js), and the next set-up on
 * this browser registers as a new device. Resolves once the delete has been committed to IndexedDB.
 */
async function wipeDevice() {
  await sqlite.wipe();
  for (const k of ['suds.local.session', 'suds.local.enc', 'suds.local.idx', 'suds.prefs']) { try { localStorage.removeItem(k); } catch {} }
  token = '';
}

async function handle(method, path, body, headers = {}) {
  const url = new URL(path, 'http://local');
  const res = new FakeRes();
  const ctx = { req: { socket: { remoteAddress: '127.0.0.1' } }, res, method, path: url.pathname, query: url.searchParams, params: {}, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), cookies: {}, ip: 'device', user: null, session: null, body: null, rawBody: null };
  try {
    // Nothing runs against an erased database: the page is about to reload into first-run setup.
    if (sqlite.isWiped()) throw new HttpError(410, 'This device has been erased and needs to be set up again.', { wiped: true });
    // Another window took the database over (see local/shims/sqlite.js): this page must not write, and a
    // read here could show what that window has since changed. The page shows its own explanation.
    if (sqlite.isFrozen()) throw new HttpError(409, 'SUDS is now open in another window on this device. Use that window, or take it back here.', { frozen: true });
    // Harm-reduction supply counts are the office's shelf count (server/sync-tables.js serverOwned): a
    // change made here would never be sent and would be silently overwritten at the next sync, so it is
    // refused up front instead of looking saved. Visits recorded here still draw the office shelf down
    // when they sync.
    if (method !== 'GET' && /^\/api\/supplies(\/|$)/.test(url.pathname)) throw new HttpError(403, 'Supply counts are kept at the office and cannot be changed on this device. Visits you record here draw the office count down when you sync.', { serverOwned: true });
    const m = router.match(method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    ctx.params = m.params;
    if (token) ctx.headers.authorization = 'Bearer ' + token;
    ctx.user = auth.resolveSession(ctx);
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) { ctx.rawBody = Buffer.from(body); ctx.body = {}; }
    else if (typeof body === 'string') { ctx.rawBody = Buffer.from(body); ctx.body = {}; }
    else ctx.body = body || {};
    let result;
    for (const h of m.handlers) result = await h(ctx);
    // Not saved here: exporting the whole database on every write cost 40-130 ms a request on a large
    // caseload (1.9.1). The shim saves on a short coalescing timer, the page saves on its way out
    // (pagehide / hidden / freeze), and the next document of this tab waits for this one's lock before it
    // reads, so a write made just before leaving is still there. A failed save is reported by onSaveError.
    // login/logout manage the bearer token that replaces the cookie
    const setCookie = res.headers['set-cookie'];
    if (setCookie) { const mm = /suds_session=([^;]*)/.exec(setCookie); token = mm && mm[1] ? mm[1] : ''; if (token) localStorage.setItem('suds.local.session', token); else localStorage.removeItem('suds.local.session'); }
    if (res.headersSent) return { status: res.status, headers: res.headers, body: Buffer.concat(res.chunks) };
    return { status: result === undefined ? 204 : (ctx.status || 200), headers: { 'content-type': 'application/json' }, json: result === undefined ? null : result };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, headers: { 'content-type': 'application/json' }, json: { error: err.message, ...(err.extra || {}) } };
    // Same as the office server: log the detail, tell the caller nothing. The message can carry SQL, file
    // paths, or fragments of the record being written.
    console.error('[suds-local]', method, path, err);
    return { status: 500, headers: { 'content-type': 'application/json' }, json: { error: 'Something went wrong on this device. Try again, and sync if it keeps happening.' } };
  }
}
