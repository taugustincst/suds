// SUDS local kernel: runs the SUDS server logic inside the browser/WebView with an on-device encrypted SQLite
// database, so the phone app works with no server. Exposes window.SUDS_LOCAL.handle(method, path, body, headers).
import sqlite from 'node:sqlite';
import db from '../server/db.js';
import { Router, HttpError } from '../server/http.js';
import auth from '../server/auth.js';
import audit from '../server/audit.js';
import idempotency from '../server/idempotency.js';
import * as sync from './sync.js';
import * as backup from './backup.js';

// The list itself comes from the server so the two cannot drift; only the loaders live here, because
// esbuild needs static import specifiers to bundle them.
import { LOCAL_ROUTE_MODULES } from '../server/app.js';
const routeLoaders = {
  auth: () => import('../server/routes/auth.js'), me: () => import('../server/routes/me.js'), users: () => import('../server/routes/users.js'), clients: () => import('../server/routes/clients.js'),
  assignments: () => import('../server/routes/assignments.js'), episodes: () => import('../server/routes/episodes.js'), interventions: () => import('../server/routes/interventions.js'),
  overdose: () => import('../server/routes/overdose.js'), calls: () => import('../server/routes/calls.js'), time: () => import('../server/routes/time.js'), supervision: () => import('../server/routes/supervision.js'),
  resources: () => import('../server/routes/resources.js'), referrals: () => import('../server/routes/referrals.js'), tasks: () => import('../server/routes/tasks.js'), budget: () => import('../server/routes/budget.js'),
  notes: () => import('../server/routes/notes.js'), consents: () => import('../server/routes/consents.js'), 'patient-requests': () => import('../server/routes/patient-requests.js'), careplan: () => import('../server/routes/careplan.js'), assessments: () => import('../server/routes/assessments.js'), forms: () => import('../server/routes/forms.js'), documents: () => import('../server/routes/documents.js'), regions: () => import('../server/routes/regions.js'), imports: () => import('../server/routes/imports.js'), dataimport: () => import('../server/routes/dataimport.js'), reports: () => import('../server/routes/reports.js'), admin: () => import('../server/routes/admin.js'), options: () => import('../server/routes/options.js'),
};

let router; let token = localStorage.getItem('suds.local.session') || '';
const RESTORED_KEY = 'suds.local.restored';

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
  // ---- accounts on this device: sign up, the device administrator, sign-ups on or off ----
  // The first account on a device is its administrator (the person who set it up): the one who may take a
  // backup, restore one, and turn further sign-ups off. Recorded at set-up; a device set up before 1.9.5
  // falls back to the earliest account with a usable password (an office account pulled down by a sync
  // carries a blanked hash and can never be it).
  const deviceAdminId = () => db.getSetting('device_admin_user_id', null)
    || (db.one(`SELECT id FROM users WHERE password_hash NOT LIKE 'scrypt$0$%' ORDER BY created_at, rowid LIMIT 1`) || {}).id || null;
  const isDeviceAdmin = (u) => !!u && u.id === deviceAdminId();
  const userCount = () => db.one(`SELECT COUNT(*) n FROM users`).n;
  const clientCount = () => db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n;
  // Later sign-ups are for the published on-device app, where nobody else issues accounts. A copy the
  // office server hands out (/?local=1) gets its accounts from the office and has one person on it.
  const signupEnabled = () => sync.isStaticHost() && db.getSetting('local_signup', '1') !== '0';
  router.get('/api/local/status', () => ({ local: true, static: sync.isStaticHost(), users: userCount(), signup_enabled: userCount() === 0 || signupEnabled(), last_sync: db.getSetting('last_sync_at', null), sync_server: db.getSetting('sync_server', null), program_contact: db.getSetting('program_contact', '') || '' }));
  const { validate } = require('../server/validate.js');
  const accountShape = { display_name: { type: 'string', required: true, maxLen: 120 }, username: { type: 'string', required: true, maxLen: 60, pattern: /^[a-zA-Z0-9._@-]+$/ }, password: { type: 'string', required: true, maxLen: 500 }, org_name: { type: 'string', maxLen: 200 }, role: { type: 'string', enum: ['navigator', 'clinician', 'supervisor', 'admin'] }, storage_ack: { type: 'boolean' } };
  function createFirstAccount(body) {
    if (userCount() > 0) throw new HttpError(403, 'Already set up');
    // The role is asked for, not assumed. Hard-coding 'navigator' meant a clinician who set the app up on
    // their phone silently lost access to clinical notes — their own work.
    const v = validate(body, accountShape);
    // The on-device app keeps records nowhere else. The person confirms they have read where that is
    // before the first record can exist (the set-up form's checkbox); said once, there, not as a banner.
    if (sync.isStaticHost() && !v.storage_ack) throw new HttpError(400, 'Confirm that you understand where your records are kept before creating the account.', { storageAckRequired: true });
    const errs = auth.passwordPolicy(v.password); if (errs.length) throw new HttpError(400, 'Password must contain ' + errs.join(', '));
    const { hashPassword, uuid } = require('../server/crypto.js');
    const id = uuid();
    db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,?,0,?)`, id, v.username, hashPassword(v.password), v.display_name, v.role || 'navigator', db.now());
    db.setSetting('org_name', v.org_name || 'SUDS on this device'); db.setSetting('caseload_restriction', '0'); db.setSetting('local_mode', '1');
    db.setSetting('device_admin_user_id', id);
    // SUDS on this device has no office server to take a time zone from: the programme's calendar is the
    // one this browser is set to when the device is set up (Settings → Program settings changes it).
    if (sync.isStaticHost() && !db.getSetting('org_timezone', null)) { try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz) db.setSetting('org_timezone', tz); } catch { /* the default applies */ } }
    audit.log({ user: { id, username: v.username }, action: 'local.setup' });
    return { ok: true, device_admin: true };
  }
  router.post('/api/local/setup', (ctx) => createFirstAccount(ctx.body));
  // "Sign up" on the sign-in page. With no account yet it is the first-run set-up above. After that, on
  // the on-device app and while the device administrator allows it, it creates a navigator account at
  // once: caseload-scoped like any navigator, so the new person sees only the clients they record (or are
  // assigned) — never the records of whoever else uses this browser.
  router.post('/api/local/signup', (ctx) => {
    if (userCount() === 0) return createFirstAccount(ctx.body);
    if (!signupEnabled()) throw new HttpError(403, sync.isStaticHost() ? 'Sign-ups are turned off on this device. Ask the person who manages it to turn them back on.' : 'This device is already set up. Accounts come from the office SUDS.', { signupDisabled: true });
    const v = validate(ctx.body, { display_name: accountShape.display_name, username: accountShape.username, password: accountShape.password });
    const errs = auth.passwordPolicy(v.password); if (errs.length) throw new HttpError(400, 'Password must contain ' + errs.join(', '));
    if (db.one(`SELECT 1 FROM users WHERE username=?`, v.username)) throw new HttpError(400, 'That username cannot be used here. Choose another.');
    const { hashPassword, uuid } = require('../server/crypto.js');
    const id = uuid();
    db.transaction(() => {
      db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,'navigator',0,?)`, id, v.username, hashPassword(v.password), v.display_name, db.now());
      // A second person on the device: from now on each navigator and clinician sees only their own caseload.
      db.setSetting('caseload_restriction', '1');
    });
    audit.log({ user: { id, username: v.username }, action: 'local.signup', entity: 'user', entityId: id });
    return { ok: true, role: 'navigator' };
  });
  // What the "This device" page shows: the last backup, whether further sign-ups are allowed, and whether
  // the signed-in person manages the device.
  router.get('/api/local/device', (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    return { static: sync.isStaticHost(), device_admin: isDeviceAdmin(ctx.user), signup_enabled: signupEnabled(), users: userCount(), clients: clientCount(), last_backup_at: db.getSetting('last_backup_at', null) };
  });
  router.put('/api/local/device', (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    if (!isDeviceAdmin(ctx.user)) throw new HttpError(403, 'Only the person who manages this device can change this.');
    const v = validate(ctx.body, { signup_enabled: { type: 'boolean' } });
    if (v.signup_enabled !== undefined) db.setSetting('local_signup', v.signup_enabled ? '1' : '0');
    audit.log({ user: ctx.user, action: 'local.device.settings', details: { signup_enabled: v.signup_enabled } });
    return { ok: true };
  });

  // ---- device backup and restore (local/backup.js) ----
  // The whole device — every account's records, not one caseload — so only its administrator may take a
  // backup or put one back. A device with no account yet (just erased, or a new phone) may restore without
  // signing in: that is how a lost device's records come back.
  const keysHex = () => { const c = require('./shims/config.js'); return { enc: Buffer.from(c.encryptionKey).toString('hex'), idx: Buffer.from(c.indexKey).toString('hex') }; };
  const mayRestore = (ctx) => { if (userCount() === 0) return; if (!ctx.user) throw new HttpError(401, 'Sign in first'); if (!isDeviceAdmin(ctx.user)) throw new HttpError(403, 'Only the person who manages this device can restore a backup.'); };
  const asHttp = async (fn) => { try { return await fn(); } catch (e) { if (e instanceof backup.BackupError) throw new HttpError(400, e.message, { backupError: e.code }); throw e; } };
  router.post('/api/local/backup', async (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    if (!isDeviceAdmin(ctx.user)) throw new HttpError(403, 'Only the person who manages this device can download its backup.');
    const v = validate(ctx.body, { passphrase: { type: 'string', required: true, maxLen: 500 } });
    if (v.passphrase.length < backup.MIN_PASSPHRASE) throw new HttpError(400, `Choose a passphrase of at least ${backup.MIN_PASSPHRASE} characters.`);
    const at = db.now();
    const previous = db.getSetting('last_backup_at', null);
    // Recorded before the export, so a device restored from this file knows when its backup was taken.
    db.setSetting('last_backup_at', at);
    const clients = clientCount();
    audit.log({ user: ctx.user, action: 'device.backup.created', details: { clients } });
    const meta = { keys: keysHex(), org_name: db.getSetting('org_name', ''), clients, users: userCount(), schema_version: Number(db.getSetting('schema_version', '0')), created_at: at };
    let file;
    try { file = await asHttp(() => backup.create({ bytes: sqlite.exportCurrent(), meta, passphrase: v.passphrase, appVersion: require('./shims/config.js').version })); }
    catch (e) { if (previous) db.setSetting('last_backup_at', previous); else db.run(`DELETE FROM settings WHERE key='last_backup_at'`); throw e; }
    const name = `suds-device-backup-${at.slice(0, 10)}.sudsbackup`;
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
    ctx.res.end(Buffer.from(file));
  });
  async function openUpload(ctx) {
    const v = validate(ctx.body, { file_b64: { type: 'string', required: true, maxLen: 400 * 1024 * 1024 }, passphrase: { type: 'string', required: true, maxLen: 500 }, confirm: { type: 'string', maxLen: 40 } });
    const file = Uint8Array.from(Buffer.from(v.file_b64.replace(/^data:[^,]*,/, ''), 'base64'));
    const out = await asHttp(() => backup.open(file, v.passphrase));
    const damaged = () => new HttpError(400, 'This backup file is damaged or has been altered, so it cannot be restored.', { backupError: 'tampered' });
    let info;
    try {
      info = sqlite.inspect(out.bytes, (d) => ({
        schema_version: Number((d.one(`SELECT value FROM settings WHERE key='schema_version'`) || {}).value || 0),
        clients: d.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n, users: d.one(`SELECT COUNT(*) n FROM users`).n,
        fingerprint: (d.one(`SELECT value FROM settings WHERE key='encryption_key_fingerprint'`) || {}).value || null }));
    } catch { throw damaged(); }
    if (info.schema_version > db.LATEST_SCHEMA_VERSION) throw new HttpError(400, 'This backup was made by a newer version of SUDS. Update SUDS on this device, then try again.');
    const { sha256 } = require('../server/crypto.js');
    if (info.fingerprint && info.fingerprint !== sha256('suds-key-check:' + out.meta.keys.enc).slice(0, 32)) throw damaged();
    return { v, out, info };
  }
  router.post('/api/local/restore/preview', async (ctx) => {
    mayRestore(ctx);
    const { out, info } = await openUpload(ctx);
    return { created_at: out.meta.created_at || out.header.created_at, app_version: out.header.app_version, org_name: out.meta.org_name || '', clients: info.clients, users: info.users, schema_version: info.schema_version, current: { clients: userCount() ? clientCount() : 0 } };
  });
  router.post('/api/local/restore', async (ctx) => {
    mayRestore(ctx);
    const { v, out, info } = await openUpload(ctx);
    if (v.confirm !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm that everything on this device will be replaced.');
    // The keys go in first and come back out if the database cannot be written: the restored bytes are
    // unreadable without them, and this device's own records are unreadable with them.
    const before = { enc: localStorage.getItem('suds.local.enc'), idx: localStorage.getItem('suds.local.idx') };
    localStorage.setItem('suds.local.enc', out.meta.keys.enc); localStorage.setItem('suds.local.idx', out.meta.keys.idx);
    try { await sqlite.replaceWith(out.bytes); }
    catch (e) {
      for (const [k, val] of [['suds.local.enc', before.enc], ['suds.local.idx', before.idx]]) { if (val === null) localStorage.removeItem(k); else localStorage.setItem(k, val); }
      throw new HttpError(409, e.message);
    }
    // Everyone signs in again, as an account from the backup. The restore is written into the restored
    // database's own audit trail when it next opens (start(), below): this database is already gone.
    try { localStorage.removeItem('suds.local.session'); localStorage.setItem(RESTORED_KEY, JSON.stringify({ at: new Date().toISOString(), backup_created_at: out.meta.created_at || null, by: ctx.user ? ctx.user.username : null, clients: info.clients })); } catch {}
    token = '';
    return { ok: true, clients: info.clients, users: info.users };
  });
  // Sample data on a device: the device user may be a navigator, so expose it here (not behind
  // settings:manage). As at the office, only on a device with no clients yet: the on-device app holds real
  // records, and fictional ones are never mixed in with them (1.9.4 added them alongside on the static
  // build, when it was a demonstration; it is not one any more).
  const demo = require('../server/demo.js');
  const demoOpts = () => ({ alongside: false });
  router.get('/api/local/demo', (ctx) => { if (!ctx.user) throw new HttpError(401, 'Sign in first'); return demo.offer(demoOpts()); });
  router.post('/api/local/demo', (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    const refused = demo.loadRefusal(demo.status(), demoOpts());
    if (refused) throw new HttpError(400, refused);
    return demo.seed({ actor: ctx.user.id, workers: [ctx.user.id], clinician: null, supervisor: ctx.user.id });
  });
  router.delete('/api/local/demo', (ctx) => { if (!ctx.user) throw new HttpError(401, 'Sign in first'); return demo.remove({ actor: ctx.user.id }); });
  // A restore finished just before this start (the page reloads straight after one): record it in the
  // restored database's own audit trail, which is the one that carries on.
  try { const r = localStorage.getItem(RESTORED_KEY); if (r) { localStorage.removeItem(RESTORED_KEY); const d = JSON.parse(r); audit.log({ user: { username: d.by || 'device' }, action: 'device.restore', details: { at: d.at, backup_created_at: d.backup_created_at, clients: d.clients } }); } } catch {}
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
    // A backup has just been put in place: the page is about to reload into it, and nothing may touch the
    // copy it replaced.
    if (sqlite.isReplaced()) throw new HttpError(409, 'A backup has just been restored on this device. Reload to continue.', { restored: true });
    // Another window took the database over (see local/shims/sqlite.js): this page must not write, and a
    // read here could show what that window has since changed. The page shows its own explanation.
    if (sqlite.isFrozen()) throw new HttpError(409, 'SUDS is now open in another window on this device. Use that window, or take it back here.', { frozen: true });
    // Harm-reduction supply counts on a device that syncs with an office are the office's shelf count
    // (server/sync-tables.js serverOwned): a change made here would never be sent and would be silently
    // overwritten at the next sync, so it is refused up front instead of looking saved (the Supplies page
    // disables its buttons there and says why). Visits recorded here still draw the office shelf down
    // when they sync. SUDS on this device (the static build) has no office: its cupboard is its own, and
    // refusing it there left "Add a supply item" failing on every save.
    if (method !== 'GET' && !sync.isStaticHost() && /^\/api\/supplies(\/|$)/.test(url.pathname)) throw new HttpError(403, 'Supply counts are kept at the office and cannot be changed on this device. Visits you record here draw the office count down when you sync.', { serverOwned: true });
    const m = router.match(method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    ctx.params = m.params;
    if (token) ctx.headers.authorization = 'Bearer ' + token;
    ctx.user = auth.resolveSession(ctx);
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) { ctx.rawBody = Buffer.from(body); ctx.body = {}; }
    else if (typeof body === 'string') { ctx.rawBody = Buffer.from(body); ctx.body = {}; }
    else ctx.body = body || {};
    // Same as the office server (server/app.js): a retried POST with the same Idempotency-Key runs once.
    const result = await idempotency.run(ctx, async () => { let out; for (const h of m.handlers) out = await h(ctx); return out; });
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
