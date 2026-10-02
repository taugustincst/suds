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
import * as vault from './vault.js';
import { auditRunner } from './audit-runner.js';
import publicationRelease from '../server/publication-release.js';
import { gcm } from '@noble/ciphers/aes';

// The list itself comes from the server so the two cannot drift; only the loaders live here, because
// esbuild needs static import specifiers to bundle them.
import { LOCAL_ROUTE_MODULES } from '../server/app.js';
const routeLoaders = {
  auth: () => import('../server/routes/auth.js'), me: () => import('../server/routes/me.js'), users: () => import('../server/routes/users.js'), clients: () => import('../server/routes/clients.js'),
  assignments: () => import('../server/routes/assignments.js'), episodes: () => import('../server/routes/episodes.js'), interventions: () => import('../server/routes/interventions.js'),
  overdose: () => import('../server/routes/overdose.js'), prevention: () => import('../server/routes/prevention.js'), calls: () => import('../server/routes/calls.js'), time: () => import('../server/routes/time.js'), supervision: () => import('../server/routes/supervision.js'),
  resources: () => import('../server/routes/resources.js'), referrals: () => import('../server/routes/referrals.js'), tasks: () => import('../server/routes/tasks.js'), budget: () => import('../server/routes/budget.js'),
  notes: () => import('../server/routes/notes.js'), consents: () => import('../server/routes/consents.js'), 'patient-requests': () => import('../server/routes/patient-requests.js'), part2: () => import('../server/routes/part2.js'), compliance: () => import('../server/routes/compliance.js'), careplan: () => import('../server/routes/careplan.js'), assessments: () => import('../server/routes/assessments.js'), suprt: () => import('../server/routes/suprt.js'), forms: () => import('../server/routes/forms.js'), documents: () => import('../server/routes/documents.js'), regions: () => import('../server/routes/regions.js'), imports: () => import('../server/routes/imports.js'), dataimport: () => import('../server/routes/dataimport.js'), reports: () => import('../server/routes/reports.js'), admin: () => import('../server/routes/admin.js'), options: () => import('../server/routes/options.js'), caloms: () => import('../server/routes/caloms.js'), handoff: () => import('../server/routes/handoff.js')
};

// The session token lives in this page's memory only: a reload signs out (and locks the device).
let router; let token = '';
const RESTORED_KEY = 'suds.local.restored'; // written by 1.9.5–1.11 around a restore; cleared at start
let reportError = (e) => console.error('[suds-local]', e);

class FakeRes {
  constructor() { this.status = 200; this.headers = {}; this.chunks = []; this.headersSent = false; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  writeHead(status, headers = {}) { this.status = status; for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v; this.headersSent = true; }
  end(body) { if (body !== undefined && body !== null) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body))); this.headersSent = true; }
}

// ---- encryption at rest: the device's key, and when the database is open ----
// docs/architecture/ADR-0008-device-encryption.md. The database image in IndexedDB is sealed under a random
// data-encryption key (DEK); the DEK is wrapped once per device account under a key derived from that
// account's password (local/vault.js). So after every page load the device is LOCKED — no database in
// memory, no key, no column keys — until an account signs in; signing out or going idle locks it again.
//   phase  'fresh'   no account yet: an empty database under a new DEK, nothing saved until the first one
//          'legacy'  a database stored in the clear by 1.11 or earlier: open, never saved again until it is sealed
//          'locked'  sealed and closed; only status, sign-in and (with someone to vouch) sign-up answer
//          'open'    unsealed in memory after a sign-in; every save is sealed
const VAULT_KEY = 'vault';
const LEGACY_KEYS = ['suds.local.enc', 'suds.local.idx'];
let phase = 'starting';
let dek = null; let dekKey = null; let theVault = null;
let lastActivity = Date.now();
let unlockFailures = 0;
// Wrong recovery codes typed since this page loaded (lockedAnswer, /api/local/recover). Each one waits like a
// wrong password (missed); after MAX_RECOVERY_MISSES the page must be reloaded before another is tried.
let recoveryMisses = 0; let missesBeforeRecovery = 0; // the count the last right code cleared, for the audit
const MAX_RECOVERY_MISSES = 10;
const sealer = () => ({ seal: (bytes) => vault.seal(dekKey, bytes), sealSync: (bytes) => vault.sealSync(gcm, dek, bytes) });
function config() { return require('./shims/config.js'); }
function setKeys(k) { const c = config(); c.encryptionKey = Buffer.from(k.enc, 'hex'); c.indexKey = Buffer.from(k.idx, 'hex'); }
function keysHex() { const c = config(); return { enc: Buffer.from(c.encryptionKey).toString('hex'), idx: Buffer.from(c.indexKey).toString('hex') }; }
function clearKeys() { const c = config(); for (const k of ['encryptionKey', 'indexKey']) { try { if (c[k]) c[k].fill(0); } catch {} c[k] = null; } }
const randomHex = () => Buffer.from(vault.newDek()).toString('hex');
/** The column keys a device set up by 1.11 or earlier kept in localStorage (a random pair if they are gone: see openDatabase). */
function legacyKeys() {
  let enc = null; let idx = null; try { enc = localStorage.getItem(LEGACY_KEYS[0]); idx = localStorage.getItem(LEGACY_KEYS[1]); } catch {}
  return { enc: /^[0-9a-f]{64}$/.test(enc || '') ? enc : randomHex(), idx: /^[0-9a-f]{64}$/.test(idx || '') ? idx : randomHex() };
}
/** A new DEK for this page and the given column keys (new random ones when null). Nothing is stored yet. */
async function newKeyMaterial(keys) { dropKey(); dek = vault.newDek(); dekKey = await vault.importDek(dek); setKeys(keys || { enc: randomHex(), idx: randomHex() }); }
function dropKey() { if (dek) dek.fill(0); dek = null; dekKey = null; }

/**
 * Open `bytes` (plain SQLite, or null for a new database) as the device database, with the column keys
 * already set. The encryption key and the database used to live in different browser stores, and a key
 * cleared on its own made every record unreadable; the fingerprint recorded with the database still catches
 * a database opened under the wrong keys.
 */
function openDatabase(bytes) {
  sqlite.setOpenAllowed(true);
  db.openWith(bytes ? new Uint8Array(bytes) : null);
  // Via server/crypto.js, so the bundler's config alias applies — importing server/config.js from here
  // would pull in the real Node configuration instead of the device shim.
  const { keyFingerprint } = require('../server/crypto.js');
  const fingerprint = keyFingerprint();
  const stored = db.getSetting('encryption_key_fingerprint', null);
  if (!stored) db.setSetting('encryption_key_fingerprint', fingerprint);
  else if (stored !== fingerprint) {
    try { db.close(); } catch {}
    const e = new Error('This device\'s security key has been cleared, so the records stored here can no longer be read. Set the app up again and sync from the office server to restore them.');
    e.code = 'SUDS_KEY_LOST';
    throw e;
  }
  sync.ensureTables();
  scopeEarlierSignups();
}

// A person who signs up on a shared device (the second account and later) sees only the clients they record or
// are assigned, and no clinical notes, as a navigator always did here: from 1.16.0 a navigator and a clinician
// hold clients:all, and a navigator notes:clinical:read, by default (server/auth.js PERMS), which on a device
// several people share would open each person's clients to the others. So a device sign-up is given per-user
// denies of both (the 1.15.0 overrides, server/auth.js effectivePerms), recorded with this reason. They stay
// when the device administrator makes the account a navigator or a clinician, and go when it is made a
// supervisor or an administrator (roles that see every client); an administrator account may also lift them one
// by one under Settings -> Users & permissions -> Permissions. The device administrator (the first account, who
// can back up and restore the whole device) keeps the role's defaults.
const SIGNUP_SCOPE = require('../server/permissions.js').CASELOAD_PERMS;
const SIGNUP_SCOPE_REASON = 'Signed up on a shared device: sees only their own caseload until the device administrator decides otherwise';
function deviceAdminId() {
  return db.getSetting('device_admin_user_id', null)
    || (db.one(`SELECT id FROM users WHERE password_hash NOT LIKE 'scrypt$0$%' ORDER BY created_at, rowid LIMIT 1`) || {}).id || null;
}
function scopeSignup(userId, by) {
  for (const p of SIGNUP_SCOPE) db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason, granted_by) VALUES(?,?,'deny',?,?) ON CONFLICT(user_id, permission) DO NOTHING`, userId, p, SIGNUP_SCOPE_REASON, by || null);
}
// A device upgraded from before 1.16.0 (or a backup made then, restored): the accounts that signed up on it get
// the same denies, once, so the upgrade does not open anyone's clients to the others on the device.
function scopeEarlierSignups() {
  if (!sync.isStaticHost() || db.getSetting('signup_scope_v1_16', null) !== null) return;
  const admin = deviceAdminId();
  db.transaction(() => {
    if (admin) for (const u of db.all(`SELECT id FROM users WHERE role IN ('navigator','clinician') AND password_hash NOT LIKE 'scrypt$0$%' AND id<>?`, admin)) scopeSignup(u.id, admin);
    db.setSetting('signup_scope_v1_16', '1');
  });
}

/** What the locked sign-in page may know without the key: no names, no records. */
function hints() {
  const users = db.one(`SELECT COUNT(*) n FROM users WHERE is_active=1 AND password_hash NOT LIKE 'scrypt$0$%'`).n;
  return { users, signup_enabled: sync.isStaticHost() && db.getSetting('local_signup', '1') !== '0', program_contact: db.getSetting('program_contact', '') || '' };
}
// Vault writes are serialised: two requests changing wraps at once must not each write a copy without the other's.
let vaultQueue = Promise.resolve();
function saveVault(next) {
  const run = vaultQueue.then(async () => { await sqlite.putMeta({ [VAULT_KEY]: next }); theVault = next; });
  vaultQueue = run.catch(() => {});
  return run;
}

/**
 * Let `password` open this device for account `userId` from now on: wrap the DEK for it (replacing any
 * earlier wrap of that account). The first account on a new device, or one set up by 1.11 or earlier, also creates the vault, and
 * its first sealed save carries the vault and the deletion of every plaintext copy in one transaction.
 */
async function enrol(userId, username, password) {
  if (!dek || !userId || typeof password !== 'string' || !password) return;
  const base = theVault && theVault.format === vault.VAULT_FORMAT ? theVault : await vault.create(dekKey, keysHex());
  const wrap = await vault.wrapDek(dek, password, { userId, name: await vault.nameHash(base.salt, username) });
  const next = { ...vault.withWrap(base, wrap), hints: hints() };
  if (phase === 'open' && sqlite.hasSealer()) { await saveVault(next); return; }
  // First account: from here on every save is sealed, and the first one also stores the vault and deletes
  // a pre-1.9.3 plaintext copy (`db`). The column keys leave localStorage only once that has committed.
  theVault = next;
  sqlite.setSealer(sealer(), { extra: { [VAULT_KEY]: next, db: null } });
  await sqlite.flush({ force: true });
  const wasLegacy = phase === 'legacy';
  phase = 'open';
  if (wasLegacy) await eraseLegacyCopies();
}
/**
 * After a restore from a backup that carried its accounts' wraps, the device runs under the key written in
 * that backup (vault.fromBackupRecord). The first time a backed-up account proves its password here (its own
 * sign-in, or vouching for someone), move the device to a fresh key (vault.rekeyAfterRestore): the image is
 * re-sealed under it and stored with the new vault in one write, so a key the backup's holder knows never
 * opens anything recorded from then on. Serialised with the other vault writes. If the write does not land,
 * nothing changes (the device stays on the old key and the next backed-up sign-in tries again).
 */
async function rekeyIfRestored(userId, username, password) {
  if (phase !== 'open' || !theVault || theVault.rekey !== 'restore' || !dek || typeof password !== 'string') return false;
  const run = vaultQueue.then(async () => {
    if (phase !== 'open' || !theVault || theVault.rekey !== 'restore') return false;
    const out = await vault.rekeyAfterRestore(theVault, dek, username, password, { userId, keys: keysHex(), hints: hints() });
    if (!out) return false;
    const before = { dek, dekKey, theVault };
    dek = out.dek; dekKey = out.key; theVault = out.vault;
    sqlite.setSealer(sealer(), { extra: { [VAULT_KEY]: out.vault } });
    // Landed means the new vault went with a sealed save: the shim drops its pending extras only when that
    // transaction commits. A failed save leaves them pending (and the next save would carry them).
    try { await sqlite.flush({ force: true }); } catch { /* judged below */ }
    if (sqlite.hasPendingExtra()) {
      // Nothing under the new key was stored (the vault goes with the first sealed save, or not at all): go back.
      out.dek.fill(0);
      dek = before.dek; dekKey = before.dekKey; theVault = before.theVault;
      sqlite.setSealer(sealer());
      return false;
    }
    before.dek.fill(0);
    // Which accounts lost their key (account ids: staff accounts, not clients), so whoever reads the device's
    // audit knows who will need to be let in again, not merely how many.
    audit.log({ user: { username: 'device' }, action: 'device.key_rotated', details: { reason: 'restore', carried_accounts_waiting: out.vault.wraps.filter(w => w.chained).length, wraps_dropped: out.dropped.length, dropped_accounts: out.dropped, ...(out.vault.recovery_dropped_at ? { recovery_code_dropped: true } : {}) } });
    return true;
  });
  vaultQueue = run.catch(() => {});
  return run;
}
/** After sealing a device set up by 1.11 or earlier: remove the plaintext keys, and prove no plaintext database is left. */
async function eraseLegacyCopies() {
  for (const k of LEGACY_KEYS) { try { localStorage.removeItem(k); } catch {} }
  const left = vault.plaintextLeft(await sqlite.entries());
  let keysLeft = false; try { keysLeft = LEGACY_KEYS.some(k => localStorage.getItem(k) !== null); } catch {}
  if (left.length || keysLeft) {
    // Not expected (the sealed save replaced this page's copy and deleted the old key); said, not hidden.
    const e = new Error(`A plaintext copy of the device database is still stored (${left.join(', ') || 'keys'}).`);
    console.error('[suds-local]', e.message);
    throw e;
  }
  audit.log({ user: { username: 'device' }, action: 'device.encrypted_at_rest', details: { migrated: true } });
}

/** Unseal the database with `dekRaw` (from a wrap) and open it in this page. */
async function unlockWith(dekRaw) {
  dropKey(); dek = dekRaw; dekKey = await vault.importDek(dek);
  try {
    theVault = (await sqlite.getMeta(VAULT_KEY)) || theVault;
    setKeys(await vault.openKeys(dekKey, theVault.keys));
    const sealed = await sqlite.readCurrent();
    const plain = await vault.open(dekKey, sealed);
    openDatabase(plain); plain.fill(0);
    sqlite.setSealer(sealer());
    phase = 'open'; lastActivity = Date.now();
  } catch (e) { dropKey(); clearKeys(); sqlite.setOpenAllowed(false); throw e; }
}
/** Try a username and password against the vault; the DEK and the wrap it opened, or null. */
async function tryUnwrap(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return null;
  const r = await vault.unlock(theVault, username, password);
  if (r) { unlockFailures = 0; return r; }
  await missed();
  return null;
}
/** Each guess already costs a PBKDF2 derivation; repeated misses also wait, a little longer each time. */
async function missed() {
  unlockFailures++;
  await new Promise(res => setTimeout(res, Math.min(5000, 250 * unlockFailures)));
}
/**
 * Try a recovery code against the vault's recovery wrap (local/vault.js). { dek } when it opens the device,
 * or { status, message, extra } to answer with. A code that cannot be one (wrong length or letters) is said
 * so at once and not counted; a wrong one waits like a wrong password and counts towards the page's limit.
 * The code is never logged, stored or audited.
 */
async function tryRecovery(code) {
  const field = (message) => ({ fields: { code: message } });
  if (!vault.recoveryWrap(theVault)) return { status: 404, message: 'This device has no recovery code. Restore a backup, or start over on this device.', extra: { noRecoveryCode: true } };
  if (recoveryMisses >= MAX_RECOVERY_MISSES) return { status: 429, message: 'Too many wrong recovery codes. Reload this page before you try again, and check the code against the file you saved or printed.', extra: { tooManyRecoveryCodes: true, ...field('Too many wrong codes: reload the page') } };
  if (!vault.normalizeRecoveryCode(code)) return { status: 400, message: 'A recovery code is 28 letters and numbers in seven groups of four, like 7K3M-Q9TD-…. Check what you typed.', extra: field('28 letters and numbers, in groups of four') };
  const dek = await vault.unlockRecovery(theVault, code);
  if (dek) { unlockFailures = 0; missesBeforeRecovery = recoveryMisses; recoveryMisses = 0; return { dek }; }
  recoveryMisses++;
  await missed();
  const hint = recoveryMisses >= 3
    ? ' Check it against the recovery code file you downloaded or the page you printed: only the newest code works, and making a new one replaced any older one.'
    : ' Check it and try again.';
  return { status: 400, message: 'That recovery code is not right.' + hint, extra: { wrongRecoveryCode: true, attempts: recoveryMisses, ...field('That code is not right') } };
}
/** The shape of a recovery request, checked before any code is tried: a mistake here costs no attempt. */
function recoveryRequestProblem(b) {
  if (typeof b.password !== 'string' || !b.password) return { message: 'Choose a new password.', extra: { fields: { password: 'Required' } } };
  const errs = auth.passwordPolicy(b.password);
  if (errs.length) return { message: 'Password must contain ' + errs.join(', '), extra: { fields: { password: 'Must contain ' + errs.join(', ') } } };
  if (b.username !== undefined && b.username !== null && b.username !== '' && (typeof b.username !== 'string' || b.username.length > 60 || !/^[a-zA-Z0-9._@-]+$/.test(b.username.trim()))) return { message: 'A username is letters, numbers and . _ @ - only.', extra: { fields: { username: 'Letters, numbers and . _ @ - only' } } };
  return null;
}
/**
 * A new recovery code for this device, replacing any earlier one (its wrap goes in the same vault write, so
 * the old code stops opening the device at once). Returns the code, which the caller hands to the person
 * once and keeps nowhere.
 */
async function replaceRecoveryCode() {
  if (phase !== 'open' || !dek || !theVault || theVault.format !== vault.VAULT_FORMAT || !vault.hasAccounts(theVault) || !sqlite.hasSealer()) {
    throw new HttpError(409, 'This device cannot make a recovery code right now. Sign out, sign in again and try once more.');
  }
  const code = vault.newRecoveryCode();
  const wrap = await vault.wrapRecovery(dek, code, theVault.salt);
  const replaced = !!vault.recoveryWrap(theVault);
  const next = vault.withRecovery(theVault, wrap);
  delete next.recovery_dropped_at; delete next.recovery_dropped_reason;
  await saveVault(next);
  return { code, created_at: wrap.created_at, replaced };
}
/**
 * Lock: save (sealed), close the database, forget the keys. Only a device with an account that can open it
 * again is locked — one with none (a restore nobody has signed in to yet) would lock its records away for
 * good. If the save fails the database stays open and the person stays signed out: the next attempt saves.
 */
async function lockDevice() {
  token = '';
  if (phase !== 'open' || !vault.hasAccounts(theVault) || sqlite.isFrozen() || sqlite.isWiped()) return false;
  try { await sqlite.flush(); } catch { return false; }
  if (sqlite.isDirty()) return false;
  sqlite.setSealer(null);
  try { db.close(); } catch {}
  sqlite.setOpenAllowed(false);
  dropKey(); clearKeys();
  phase = 'locked';
  return true;
}
// Idle: the page signs out after the session's idle limit (public/app.js); this is the kernel's own backstop,
// for a page whose timers the browser has slowed. Unlocked with nobody signed in (a sign-up that did not go on
// to sign in) is given two minutes.
const IDLE_CHECK_MS = 15000;
function idleCheck() {
  if (phase !== 'open') return;
  const limit = token ? auth.policy().idleMinutes * 60000 : 120000;
  if (Date.now() - lastActivity > limit) lockDevice().catch(() => {});
}

/**
 * The recovery code is the device administrator's. When that account is deactivated or removed (by another
 * administrator here, or by the office in a sync), whoever held the code -- the person who has just lost their
 * access -- could still open every record with it and make themselves a new administrator account. So the code
 * stops working at once (its wrap goes, security review of 1.15.3, L1), and the administrator who made the change
 * becomes the one who manages the device, and is asked (Home, This device) to make a new code. A sync or anyone
 * else leaves the device with nobody managing it until an administrator signs in here and deactivates or changes
 * nothing more: the code is gone either way. Audited, never the code.
 */
async function retireRecoveryIfAdminGone(ctx) {
  const adminId = db.getSetting('device_admin_user_id', null);
  if (!adminId) return;
  const admin = db.one(`SELECT id, is_active FROM users WHERE id=?`, adminId);
  if (admin && admin.is_active) return;
  const actor = ctx && ctx.user && ctx.user.id !== adminId && auth.hasPerm(ctx.user, 'users:manage') ? ctx.user : null;
  if (actor) db.setSetting('device_admin_user_id', actor.id);
  if (!vault.recoveryWrap(theVault)) return;
  const next = vault.withRecovery(theVault, null);
  next.recovery_dropped_at = new Date().toISOString(); next.recovery_dropped_reason = 'device_admin_changed';
  await saveVault(next);
  audit.log({ user: actor ? { id: actor.id, username: actor.username } : { username: 'device' }, action: 'device.recovery_code.dropped',
    details: { reason: admin ? 'device_admin_deactivated' : 'device_admin_removed', new_device_admin: actor ? actor.id : null } });
}

/**
 * Keep the wraps in step with the accounts after a change: a wrap whose account was removed or deactivated
 * goes (never the last one); one whose username changed gets the new lookup name; an account merged into
 * an office account by a sync (new id, same username) keeps its wrap under the new id. The sign-in page's
 * hints are refreshed too.
 */
async function reconcileVault(ctx = null) {
  if (phase !== 'open' || !vault.hasAccounts(theVault)) return;
  await retireRecoveryIfAdminGone(ctx);
  const users = db.all(`SELECT id, username, is_active FROM users`);
  const byId = new Map(users.map(u => [u.id, u]));
  const byName = new Map(); for (const u of users) byName.set(await vault.nameHash(theVault.salt, u.username), u);
  let changed = false; const wraps = [];
  for (const w of theVault.wraps) {
    // The recovery code's wrap belongs to no account: it stays until a new code replaces it.
    if (w.recovery) { wraps.push(w); continue; }
    const u = byId.get(w.user_id) || byName.get(w.name);
    if (!u || !u.is_active) { changed = true; continue; }
    const name = await vault.nameHash(theVault.salt, u.username);
    if (name !== w.name || u.id !== w.user_id) { changed = true; wraps.push({ ...w, user_id: u.id, name }); } else wraps.push(w);
  }
  const h = hints();
  if (JSON.stringify(h) !== JSON.stringify(theVault.hints || {})) changed = true;
  if (changed) await saveVault({ ...theVault, wraps: wraps.some(w => !w.recovery) ? wraps : theVault.wraps, hints: h });
}
/**
 * After a request that set or proved a password, wrap the DEK for it. Every one of these is a moment the
 * new password is known and the device is open: a sign-in (enrols an account that has no wrap yet — after
 * a restore, on a device set up by 1.11 or earlier, or vouched for by someone who could unlock), a password change, an
 * administrator setting a password here, an account created here, and a sync that brought the office's
 * password for this account down (it replaces the local one, so the wrap follows it).
 */
async function afterPasswordEvent(method, path, body, ctx, result) {
  const b = body || {};
  const { verifyPasswordAsync } = require('../server/crypto.js');
  const byName = (name) => db.one(`SELECT id, username, password_hash, is_active FROM users WHERE username=?`, name);
  if (method !== 'POST' && method !== 'PUT') return;
  if (path === '/api/auth/login') {
    const u = ctx.user || (result && result.user) || byName(b.username);
    const id = u && u.id; if (!id) return;
    // The first backed-up account to sign in after a restore moves the device to a key the backup never held.
    await rekeyIfRestored(id, u.username || b.username, b.password);
    // No wrap of its own yet (a device set up by 1.11 or earlier, a restore, someone vouched for it), or only one carried
    // over by a restore: this password becomes the account's own wrap of the device key.
    if (phase !== 'open' || !theVault || !theVault.wraps.some(w => w.user_id === id && !w.chained)) await enrol(id, (u.username || b.username), b.password);
  } else if (path === '/api/auth/password' && ctx.user) await enrol(ctx.user.id, ctx.user.username, b.new_password);
  else if ((path === '/api/local/signup' || path === '/api/local/setup') && b.username) { const u = byName(b.username); if (u) await enrol(u.id, u.username, b.password); }
  else if (path === '/api/users' && result && result.id) { const u = db.one(`SELECT id, username FROM users WHERE id=?`, result.id); if (u) await enrol(u.id, u.username, b.password || result.temporary_password); }
  else if (/^\/api\/users\/[^/]+$/.test(path) && b.password) { const u = db.one(`SELECT id, username FROM users WHERE id=?`, path.split('/').pop()); if (u) await enrol(u.id, u.username, b.password); }
  else if (path === '/api/local/sync' && b.password) {
    await reconcileVault();
    const u = byName(b.username || (ctx.user && ctx.user.username));
    if (u && u.is_active && await verifyPasswordAsync(b.password, u.password_hash)) await enrol(u.id, u.username, b.password);
  }
}
const PASSWORD_PATHS = /^\/api\/(auth\/login|auth\/password|local\/signup|local\/setup|local\/sync|users(\/[^/]+)?)$/;

const DROPPED_AT_RESTORE = 'This device was restored from a backup and moved to a new key; your sign-in on this device must be re-approved by someone who can already sign in here. Ask them to type their username and password below.';
/** The locked device's answers: status, a sign-in that unlocks, and a sign-up someone vouches for. */
async function lockedAnswer(method, path, body) {
  const b = body || {};
  if (method === 'GET' && path === '/api/local/status') {
    const h = (theVault && theVault.hints) || {};
    return { done: true, json: { local: true, static: sync.isStaticHost(), locked: true, users: h.users || theVault.wraps.filter(w => !w.recovery).length, signup_enabled: !!h.signup_enabled, last_sync: null, sync_server: null, program_contact: h.program_contact || '', recovery: !!vault.recoveryWrap(theVault) } };
  }
  const refused = (status, error, extra = {}) => ({ done: true, status, json: { error, locked: true, ...extra } });
  if (method === 'POST' && path === '/api/auth/login') {
    let r = await tryUnwrap(b.username, b.password);
    if (!r && b.sponsor_username) {
      r = await tryUnwrap(b.sponsor_username, b.sponsor_password);
      if (!r) return refused(401, 'The account unlocking this device could not sign in: check its username and password.', { sponsorRequired: true });
    }
    if (!r && await vault.droppedAfterRestore(theVault, b.username)) {
      // Enrolled after a restore, before the key rotation that followed it (rekeyIfRestored), which dropped
      // this account's key: its password is not wrong, and it should not be told so.
      return refused(401, DROPPED_AT_RESTORE, { sponsorRequired: true, droppedAfterRestore: true });
    }
    if (!r) return refused(401, 'Username or password is incorrect.', { sponsorRequired: !(await vault.wrapsFor(theVault, b.username)).length });
    await unlockWith(r.dek);
    // Vouched for by a backed-up account after a restore: its password rotates the key too.
    if (b.sponsor_username && r.wrap.chained) { try { await rekeyIfRestored(r.wrap.user_id, b.sponsor_username, b.sponsor_password); } catch (e) { reportError(e); } }
    return { done: false, relockOnFail: true };
  }
  if (method === 'POST' && path === '/api/local/recover') {
    // "Forgot the password? Use your recovery code": the owner's code opens the device (its own wrap), and the
    // route below sets the device administrator's new password and signs them in (ADR-0008, "Recovery code").
    const pre = recoveryRequestProblem(b);
    if (pre) return refused(400, pre.message, pre.extra);
    const r = await tryRecovery(b.code);
    if (!r.dek) return refused(r.status, r.message, r.extra);
    await unlockWith(r.dek);
    return { done: false, relockOnFail: true, recovered: true };
  }
  if (method === 'POST' && path === '/api/local/signup') {
    // A new account would get the key to every record on the device, so someone who can already open it
    // has to vouch for them: an existing account's username and password, typed on the sign-up form.
    if (!b.sponsor_username || !b.sponsor_password) return refused(403, 'Someone who already has an account on this device must type their username and password to let you sign up here.', { sponsorRequired: true });
    const r = await tryUnwrap(b.sponsor_username, b.sponsor_password);
    if (!r) return refused(401, 'The account unlocking this device could not sign in: check its username and password.', { sponsorRequired: true });
    await unlockWith(r.dek);
    // The vouching account must still be allowed in, not merely have been once.
    const { verifyPasswordAsync } = require('../server/crypto.js');
    const s = db.one(`SELECT password_hash, is_active, locked_until FROM users WHERE id=?`, r.wrap.user_id);
    if (!s || !s.is_active || (s.locked_until && s.locked_until > db.now()) || !(await verifyPasswordAsync(b.sponsor_password, s.password_hash))) {
      await lockDevice();
      return refused(401, 'The account unlocking this device could not sign in: check its username and password.', { sponsorRequired: true });
    }
    if (r.wrap.chained) { try { await rekeyIfRestored(r.wrap.user_id, b.sponsor_username, b.sponsor_password); } catch (e) { reportError(e); } }
    return { done: false, relockOnFail: true };
  }
  return refused(401, 'This device is locked. Sign in to continue.');
}

export async function start({ wasmUrl, auditWorkerUrl, onSaveError, onLockLost, force } = {}) {
  await sqlite.init(wasmUrl);
  // A publication release's audit runs in a Web Worker (public/local/audit-worker.js), not on this page's thread
  // (local/audit-runner.js; server/publication-release.js falls back to the page where no worker can start).
  if (auditWorkerUrl) publicationRelease.setDeviceAuditRunner(auditRunner(auditWorkerUrl));

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
  if (onSaveError) { sqlite.setSaveErrorHandler(onSaveError); reportError = onSaveError; }

  // What this page found in the store decides where it starts (docs/architecture/ADR-0008-device-encryption.md):
  //  * a sealed database and a vault with accounts: LOCKED until a device account signs in;
  //  * a database in the clear (a device set up by 1.11 or earlier): opened with the keys from localStorage, and
  //    sealed — then those copies erased — at the next successful sign-in (LEGACY);
  //  * nothing (a new device), or a sealed database that no account can open (a restore nobody signed in
  //    to before the page closed): an empty database under a new key, sealed once the first account exists.
  const stored = await sqlite.loadBytes();
  theVault = await sqlite.getMeta(VAULT_KEY);
  // Sessions and restore markers are no longer kept in localStorage: every page load starts signed out.
  for (const k of ['suds.local.session', RESTORED_KEY]) { try { localStorage.removeItem(k); } catch {} }
  if (vault.isSealed(stored) && vault.hasAccounts(theVault)) {
    phase = 'locked'; sqlite.setOpenAllowed(false);
  } else if (stored && !vault.isSealed(stored)) {
    phase = 'legacy'; await newKeyMaterial(legacyKeys());
    openDatabase(stored);
  } else {
    phase = 'fresh'; theVault = null; await newKeyMaterial(null);
    openDatabase(null);
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
  const isDeviceAdmin = (u) => !!u && u.id === deviceAdminId();
  const userCount = () => db.one(`SELECT COUNT(*) n FROM users`).n;
  const clientCount = () => db.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n;
  // Later sign-ups are for the published on-device app, where nobody else issues accounts. A copy the
  // office server hands out (/?local=1) gets its accounts from the office and has one person on it.
  const signupEnabled = () => sync.isStaticHost() && db.getSetting('local_signup', '1') !== '0';
  router.get('/api/local/status', () => ({ local: true, static: sync.isStaticHost(), users: userCount(), signup_enabled: userCount() === 0 || signupEnabled(), last_sync: db.getSetting('last_sync_at', null), sync_server: db.getSetting('sync_server', null), program_contact: db.getSetting('program_contact', '') || '', recovery: !!vault.recoveryWrap(theVault) }));
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
  // once, caseload-scoped (SIGNUP_SCOPE above), so the new person sees only the clients they record (or are
  // assigned) — never the records of whoever else uses this browser.
  router.post('/api/local/signup', (ctx) => {
    if (userCount() === 0) return createFirstAccount(ctx.body);
    if (!signupEnabled()) throw new HttpError(403, sync.isStaticHost() ? 'Sign-ups are turned off on this device. Ask the person who manages it to turn them back on.' : 'This device is already set up. Accounts come from the office SUDS.', { signupDisabled: true });
    const v = validate(ctx.body, { display_name: accountShape.display_name, username: accountShape.username, password: accountShape.password, role: accountShape.role });
    // Only the first account chooses its role. Anyone else who signs up here is a navigator until the
    // device administrator gives them another role (PUT /api/local/accounts/:id) — a sign-up asking to be
    // an administrator, or anything else, is refused rather than quietly granted or quietly ignored.
    if (v.role && v.role !== 'navigator') throw new HttpError(403, 'A new account on this device starts as a navigator. The person who manages this device can change its role afterwards.', { roleNotAllowed: true });
    const errs = auth.passwordPolicy(v.password); if (errs.length) throw new HttpError(400, 'Password must contain ' + errs.join(', '));
    if (db.one(`SELECT 1 FROM users WHERE username=?`, v.username)) throw new HttpError(400, 'That username cannot be used here. Choose another.');
    const { hashPassword, uuid } = require('../server/crypto.js');
    const id = uuid();
    db.transaction(() => {
      db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,'navigator',0,?)`, id, v.username, hashPassword(v.password), v.display_name, db.now());
      // A second person on the device: from now on caseload scoping is on, and this person is held to it
      // (SIGNUP_SCOPE above; a role holding clients:all is not caseload-scoped, server/auth.js caseloadRestricted).
      db.setSetting('caseload_restriction', '1');
      scopeSignup(id, deviceAdminId());
    });
    audit.log({ user: { id, username: v.username }, action: 'local.signup', entity: 'user', entityId: id, details: { denied: SIGNUP_SCOPE } });
    return { ok: true, role: 'navigator' };
  });
  // The accounts made on this device, for its administrator to see and give roles to. Accounts that came
  // down from the office in a sync (blanked password) are the office's to manage, and a copy handed out by
  // an office server gets its accounts from there, so this is the on-device app's alone.
  const DEVICE_ROLES = ['navigator', 'clinician', 'supervisor', 'admin'];
  const deviceAccounts = () => db.all(`SELECT id, username, display_name, role, created_at FROM users WHERE password_hash NOT LIKE 'scrypt$0$%' ORDER BY created_at, rowid`);
  const mayManageAccounts = (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    if (!sync.isStaticHost()) throw new HttpError(404, 'Accounts on this copy come from the office SUDS.');
    if (!isDeviceAdmin(ctx.user)) throw new HttpError(403, 'Only the person who manages this device can change accounts.');
  };
  router.get('/api/local/accounts', (ctx) => {
    mayManageAccounts(ctx);
    const admin = deviceAdminId();
    return { rows: deviceAccounts().map(u => ({ ...u, device_admin: u.id === admin })), roles: DEVICE_ROLES };
  });
  router.put('/api/local/accounts/:id', (ctx) => {
    mayManageAccounts(ctx);
    const v = validate(ctx.body, { role: { type: 'string', required: true, enum: DEVICE_ROLES } });
    const u = deviceAccounts().find(x => x.id === ctx.params.id);
    if (!u) throw new HttpError(404, 'No such account on this device');
    // The device administrator may change their own role too (the owner's decision after 1.23.5): who manages the
    // device stays them whatever their role (deviceAdminId), and, as at the office, no change may leave the device
    // with no active account that can manage users and permissions (auth.lockoutProblem).
    const self = u.id === ctx.user.id;
    const locked = u.role !== v.role ? auth.lockoutProblem({ userId: u.id, role: v.role }) : null;
    if (locked) {
      audit.log({ user: ctx.user, action: 'local.account.role.denied', entity: 'user', entityId: u.id, success: false, details: { from: u.role, to: v.role, reason: 'lockout', ...(self ? { self: true } : {}) } });
      throw new HttpError(400, locked, { lockout: true });
    }
    db.run(`UPDATE users SET role=?, updated_at=? WHERE id=?`, v.role, db.now(), u.id);
    // A supervisor or an administrator sees every client: the sign-up's caseload denies go with the promotion.
    const lifted = v.role === 'supervisor' || v.role === 'admin'
      ? db.run(`DELETE FROM user_permission_overrides WHERE user_id=? AND mode='deny' AND reason=? AND permission IN (${SIGNUP_SCOPE.map(() => '?').join(',')})`, u.id, SIGNUP_SCOPE_REASON, ...SIGNUP_SCOPE).changes : 0;
    // Made a navigator or a clinician: the programme's least-privilege default applies as at the office (an
    // account that signed up here is held already); made a supervisor or an administrator, its deny goes
    // (server/caseload-default.js, audited per person).
    const caseload = require('../server/caseload-default.js').onRoleChange(u.id, u.role, v.role, { actor: ctx.user });
    // A role change takes effect on the next sign-in: end that person's sessions. One's own takes effect at once
    // (permissions are worked out at every request), so the session it is made from stays and the others end.
    if (self && ctx.session) db.run(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?`, db.now(), u.id, ctx.session.id);
    else auth.revokeAllForUser(u.id);
    audit.log({ user: ctx.user, action: 'local.account.role', entity: 'user', entityId: u.id, details: { from: u.role, to: v.role, ...(lifted ? { denies_lifted: SIGNUP_SCOPE } : {}), ...(self ? { self: true } : {}) } });
    return { ok: true, role: v.role, ...(caseload ? { caseload_default: caseload } : {}) };
  });
  // What the "This device" page shows: the last backup, whether further sign-ups are allowed, and whether
  // the signed-in person manages the device.
  router.get('/api/local/device', (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    return { static: sync.isStaticHost(), device_admin: isDeviceAdmin(ctx.user), signup_enabled: signupEnabled(), users: userCount(), clients: clientCount(), last_backup_at: db.getSetting('last_backup_at', null), backup: backupInfo(), recovery: recoveryInfo() };
  });
  router.put('/api/local/device', (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    if (!isDeviceAdmin(ctx.user)) throw new HttpError(403, 'Only the person who manages this device can change this.');
    const v = validate(ctx.body, { signup_enabled: { type: 'boolean' }, backup_every_days: { type: 'number', integer: true }, backup_keep: { type: 'number', integer: true, min: backup.MIN_KEEP, max: backup.MAX_KEEP } });
    if (v.backup_every_days !== undefined && !backup.SCHEDULES.includes(v.backup_every_days)) throw new HttpError(400, `Back up every ${backup.SCHEDULES.join(', ')} days.`, { fields: { backup_every_days: `One of ${backup.SCHEDULES.join(', ')}` } });
    if (v.signup_enabled !== undefined) db.setSetting('local_signup', v.signup_enabled ? '1' : '0');
    if (v.backup_every_days !== undefined) db.setSetting('backup_every_days', String(v.backup_every_days));
    if (v.backup_keep !== undefined) db.setSetting('backup_keep', String(v.backup_keep));
    audit.log({ user: ctx.user, action: 'local.device.settings', details: { signup_enabled: v.signup_enabled, backup_every_days: v.backup_every_days, backup_keep: v.backup_keep } });
    return { ok: true, backup: backupInfo() };
  });

  // ---- the owner's recovery code (local/vault.js; docs/architecture/ADR-0008-device-encryption.md) ----
  // Whether the device has one and when it was made (never the code: it is not stored), and whether its maker
  // said they saved it. Home and This device ask the device administrator to make one until both are true.
  // dropped: when the last code stopped working without a new one being made (a restore, or the device
  // administrator changing: retireRecoveryIfAdminGone), so the prompt can say why a code is needed again.
  const recoveryInfo = () => {
    const w = vault.recoveryWrap(theVault);
    const out = { exists: !!w, created_at: w ? w.created_at : null, saved: !!(w && w.saved_at) };
    if (!w && theVault && theVault.recovery_dropped_at) out.dropped = { at: theVault.recovery_dropped_at, reason: theVault.recovery_dropped_reason || 'restore' };
    return out;
  };
  const mayManageRecovery = (ctx) => {
    auth.requireAuth(ctx);
    if (!isDeviceAdmin(ctx.user)) throw new HttpError(403, 'Only the person who manages this device can make its recovery code.');
  };
  // Make a new code (replacing any earlier one). The device administrator's password again first, with the
  // sign-in's protections (auth.confirmPassword: limit, failure count, lockout, audit of a failure).
  router.post('/api/local/recovery', async (ctx) => {
    mayManageRecovery(ctx);
    const v = validate(ctx.body, { password: { type: 'string', required: true, maxLen: 500 } });
    await auth.confirmPassword(ctx, v.password, { action: 'device.recovery_code.failed' });
    auth.clearFailures(ctx.user.id);
    const out = await replaceRecoveryCode();
    audit.log({ user: ctx.user, action: 'device.recovery_code.created', details: { replaced: out.replaced } });
    return { code: out.code, created_at: out.created_at, replaced: out.replaced };
  });
  // "I have saved my recovery code", ticked on the screen that showed it.
  router.post('/api/local/recovery/saved', async (ctx) => {
    mayManageRecovery(ctx);
    const w = vault.recoveryWrap(theVault);
    if (!w) throw new HttpError(404, 'This device has no recovery code yet.');
    if (!w.saved_at) await saveVault(vault.withRecovery(theVault, { ...w, saved_at: new Date().toISOString() }));
    return { ok: true, recovery: recoveryInfo() };
  });
  // Use it: on the locked sign-in page the kernel has already opened the device with the code (lockedAnswer,
  // ctx.recoveryProven); on a device that is open anyway (after a restore, before anyone signs in) the code is
  // checked here. Sets the device administrator's new password, clears their lockout and two-step
  // verification on this device, wraps the device key for the new password, replaces the code that was used
  // with a new one (returned once, to be shown once) and signs them in. With no device administrator account
  // left at all, the username given becomes a new administrator account that manages the device (and gets a new
  // code at once). A deactivated administrator's code does not work (retireRecoveryIfAdminGone).
  router.post('/api/local/recover', async (ctx) => {
    const v = validate(ctx.body, { code: { type: 'string', required: true, maxLen: 200 }, username: { type: 'string', maxLen: 60 }, password: { type: 'string', required: true, maxLen: 500 }, display_name: { type: 'string', maxLen: 120 } });
    const pre = recoveryRequestProblem(v);
    if (pre) throw new HttpError(400, pre.message, pre.extra);
    if (!ctx.recoveryProven) {
      if (phase !== 'open') throw new HttpError(409, 'This device is not ready. Reload the page and try again.');
      const r = await tryRecovery(v.code);
      if (!r.dek) throw new HttpError(r.status, r.message, r.extra);
      r.dek.fill(0);
    }
    const wrongBefore = missesBeforeRecovery;
    const { hashPasswordAsync, uuid } = require('../server/crypto.js');
    const typed = (v.username || '').trim();
    const adminId = deviceAdminId();
    let target = adminId ? db.one(`SELECT id, username, is_active, password_hash, mfa_enabled, locked_until FROM users WHERE id=?`, adminId) : null;
    // A code whose administrator was deactivated is not a way back in for them (L1): retireRecoveryIfAdminGone
    // drops it when that happens; this is the backstop, for a device where it has not run yet.
    if (target && !target.is_active) {
      await retireRecoveryIfAdminGone(null);
      throw new HttpError(403, 'The account that managed this device has been deactivated, so its recovery code no longer works. An administrator who uses this device can sign in and make a new one; otherwise restore a backup.', { recoveryRetired: true });
    }
    if (target && /^scrypt\$0\$/.test(target.password_hash)) target = null;
    let created = false;
    const hash = await hashPasswordAsync(v.password);
    if (target) {
      // The code holder can open every record here anyway, so naming the account is no disclosure.
      if (typed && typed.toLowerCase() !== target.username.toLowerCase()) throw new HttpError(400, `The account that manages this device is called “${target.username}”. Type that username, or leave the username empty.`, { adminUsername: target.username, fields: { username: `This device is managed by “${target.username}”` } });
      db.run(`UPDATE users SET password_hash=?, must_change_password=0, password_changed_at=?, failed_attempts=0, locked_until=NULL, mfa_enabled=0, mfa_secret_enc=NULL, totp_last_step=NULL, updated_at=? WHERE id=?`, hash, db.now(), db.now(), target.id);
      auth.revokeAllForUser(target.id);
    } else {
      if (!typed) throw new HttpError(400, 'Nobody manages this device any more. Choose a username for a new administrator account.', { usernameRequired: true, fields: { username: 'Choose a username for the new administrator account' } });
      if (db.one(`SELECT 1 FROM users WHERE username=?`, typed)) throw new HttpError(400, 'That username is already used on this device. Choose another for the new administrator account.', { fields: { username: 'Already used on this device' } });
      const id = uuid();
      db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,'admin',0,?)`, id, typed, hash, (v.display_name || '').trim() || typed, db.now());
      db.setSetting('device_admin_user_id', id);
      target = { id, username: typed, mfa_enabled: 0, locked_until: null };
      created = true;
    }
    // The new password opens the device from now on; the code that was used stops, replaced by a new one.
    await enrol(target.id, target.username, v.password);
    const next = await replaceRecoveryCode();
    audit.log({ user: { id: target.id, username: target.username }, action: 'device.recovered', entity: 'user', entityId: target.id,
      details: { method: 'recovery_code', account: created ? 'created' : 'reset', mfa_cleared: !!target.mfa_enabled, lockout_cleared: !!target.locked_until, wrong_codes_before: wrongBefore } });
    audit.log({ user: { id: target.id, username: target.username }, action: 'device.recovery_code.created', details: { replaced: true, reason: 'recovered' } });
    const result = await auth.login({ username: target.username, password: v.password, ctx });
    ctx.res.setHeader('Set-Cookie', auth.cookieHeader(result.token));
    return { user: result.user, mfaPending: result.mfaPending, mfaSetupRequired: result.mfaSetupRequired, mfaSetupDeadline: result.mfaSetupDeadline, username: target.username, account: created ? 'created' : 'reset', recovery_code: next.code, recovery_created_at: next.created_at };
  });

  // ---- device backup and restore (local/backup.js) ----
  // The whole device — every account's records, not one caseload — so only its administrator may take a
  // backup or put one back. A device with no account yet (just erased, or a new phone) may restore without
  // signing in: that is how a lost device's records come back.
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
    const previousTo = db.getSetting('last_backup_to', null);
    db.setSetting('last_backup_to', 'download');
    const clients = clientCount();
    audit.log({ user: ctx.user, action: 'device.backup.created', details: { clients, to: 'download', trigger: 'passphrase' } });
    const meta = { keys: keysHex(), org_name: db.getSetting('org_name', ''), clients, users: userCount(), schema_version: Number(db.getSetting('schema_version', '0')), created_at: at };
    // So the accounts in it can unlock the device it is restored onto, with the passwords they have now
    // (local/vault.js backupRecord): their wraps and a fresh key for that device, never this device's key.
    if (vault.hasAccounts(theVault) && dekKey) { const nextDek = vault.newDek(); meta.device = await vault.backupRecord(theVault, dekKey, nextDek); nextDek.fill(0); }
    let file;
    try { file = await asHttp(() => backup.create({ bytes: sqlite.exportCurrent(), meta, passphrase: v.passphrase, appVersion: require('./shims/config.js').version })); }
    catch (e) { putBack('last_backup_at', previous); putBack('last_backup_to', previousTo); throw e; }
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
    // The restored database gets a key of its own and replaces this one, with a vault that holds its column
    // keys, in one transaction, and this page switches to it in place (no reload): the first account to log
    // in gets a wrap of its own there (afterPasswordEvent). See docs/architecture/ADR-0008-device-encryption.md.
    const keys = { enc: out.meta.keys.enc, idx: out.meta.keys.idx };
    const restoreHints = { users: info.users, signup_enabled: false, program_contact: '' };
    // A backup made since encryption at rest carries its accounts' wraps and a key for this device: they
    // log in with the passwords they had then (vault.backupRecord). An older one has none, and the first of
    // its accounts to log in, in this page, gets a wrap.
    const carried = await vault.fromBackupRecord(out.meta.device, keys, restoreHints).catch(() => null);
    const nextDek = carried ? carried.dek : vault.newDek(); const nextKey = carried ? carried.key : await vault.importDek(nextDek);
    const nextVault = carried ? carried.vault : await vault.create(nextKey, keys, restoreHints);
    const sealed = await vault.seal(nextKey, out.bytes);
    try { await sqlite.replaceWith(sealed, { extra: { [VAULT_KEY]: nextVault, db: null } }); }
    catch (e) { nextDek.fill(0); throw new HttpError(409, e.message); }
    const wasLegacy = phase === 'legacy';
    const by = ctx.user ? ctx.user.username : null;
    dropKey(); dek = nextDek; dekKey = nextKey; theVault = nextVault; setKeys(keys);
    sqlite.setSealer(sealer());
    openDatabase(out.bytes); out.bytes.fill(0);
    phase = 'open'; token = ''; lastActivity = Date.now();
    // Everyone signs in again, as an account from the backup. The restore goes into the restored database's
    // own audit trail, which is the one that carries on.
    audit.log({ user: { username: by || 'device' }, action: 'device.restore', details: { at: new Date().toISOString(), backup_created_at: out.meta.created_at || null, clients: info.clients } });
    if (wasLegacy) { try { await eraseLegacyCopies(); } catch (e) { reportError(e); } }
    return { ok: true, clients: info.clients, users: info.users, reload: false };
  });

  // ---- scheduled backups (1.24.0; docs/WEB_APP.md, "Scheduled backups") ----
  // The device administrator chooses how often (daily, every 3 days, weekly) and, once, a backup passphrase; the
  // key derived from it is kept sealed under the device key in the vault (local/vault.js sealBackupKey), so a due
  // backup is made without the passphrase being typed or stored. The page writes the file: to a folder the person
  // picked (File System Access API, where the browser has it), or as a download from one button where it does
  // not. The kernel never learns the folder. A file is the device's last backup only once the page says it landed
  // (/done): until then nothing durable changes, so a write refused by the browser is not mistaken for a backup.
  const putBack = (key, value) => { if (value === null || value === undefined) db.run(`DELETE FROM settings WHERE key=?`, key); else db.setSetting(key, value); };
  const keepCount = () => Math.min(backup.MAX_KEEP, Math.max(backup.MIN_KEEP, Number(db.getSetting('backup_keep', String(backup.DEFAULT_KEEP))) || backup.DEFAULT_KEEP));
  function backupInfo() {
    const last = db.getSetting('last_backup_at', null);
    const st = backup.scheduleState(last, Number(db.getSetting('backup_every_days', String(backup.DEFAULT_EVERY_DAYS))));
    const k = theVault && theVault.backup_key;
    const checkAt = db.getSetting('backup_check_at', null);
    return { ...st, last_at: last, last_to: db.getSetting('last_backup_to', null), keep: keepCount(), schedule_chosen: db.getSetting('backup_every_days', null) !== null,
      passphrase_kept: !!k, passphrase_since: k ? k.created_at : null,
      check: checkAt ? { at: checkAt, ok: db.getSetting('backup_check_ok', '0') === '1', problem: db.getSetting('backup_check_problem', null) || null, backup_created_at: db.getSetting('backup_check_backup_at', null) } : null };
  }
  const mayBackUp = (ctx, what = 'make its backups') => {
    if (!ctx.user) throw new HttpError(401, 'Sign in first');
    if (!isDeviceAdmin(ctx.user)) throw new HttpError(403, `Only the person who manages this device can ${what}.`);
  };
  router.post('/api/local/backup/schedule', async (ctx) => {
    mayBackUp(ctx, 'set up its backups');
    const v = validate(ctx.body, { passphrase: { type: 'string', required: true, maxLen: 500 }, every_days: { type: 'number', integer: true }, keep: { type: 'number', integer: true, min: backup.MIN_KEEP, max: backup.MAX_KEEP } });
    if (v.every_days !== undefined && !backup.SCHEDULES.includes(v.every_days)) throw new HttpError(400, `Back up every ${backup.SCHEDULES.join(', ')} days.`, { fields: { every_days: `One of ${backup.SCHEDULES.join(', ')}` } });
    if (v.passphrase.length < backup.MIN_PASSPHRASE) throw new HttpError(400, `Choose a passphrase of at least ${backup.MIN_PASSPHRASE} characters.`, { fields: { passphrase: `At least ${backup.MIN_PASSPHRASE} characters` } });
    if (phase !== 'open' || !dekKey || !vault.hasAccounts(theVault) || !sqlite.hasSealer()) throw new HttpError(409, 'This device cannot keep a backup passphrase right now. Sign out, sign in again and try once more.');
    const derived = await asHttp(() => backup.deriveKey(v.passphrase));
    const rec = await vault.sealBackupKey(dekKey, derived); derived.raw.fill(0);
    const replaced = !!theVault.backup_key;
    await saveVault({ ...theVault, backup_key: rec });
    if (v.every_days !== undefined) db.setSetting('backup_every_days', String(v.every_days));
    if (v.keep !== undefined) db.setSetting('backup_keep', String(v.keep));
    audit.log({ user: ctx.user, action: 'device.backup.schedule', details: { on: true, replaced, every_days: backupInfo().every_days, keep: keepCount() } });
    return { ok: true, backup: backupInfo() };
  });
  router.delete('/api/local/backup/schedule', async (ctx) => {
    mayBackUp(ctx, 'set up its backups');
    if (theVault && theVault.backup_key) { const next = { ...theVault }; delete next.backup_key; await saveVault(next); }
    audit.log({ user: ctx.user, action: 'device.backup.schedule', details: { on: false } });
    return { ok: true, backup: backupInfo() };
  });
  // Make a backup with the kept key. `to` is where the page will put it; `existing` the names of the files already
  // in that folder, so the answer can say which old ones to remove (only files SUDS named, oldest first, keeping
  // `keep`). `trigger` says whether the schedule made it or the person asked. The answer is the file itself.
  let pendingRun = null;
  router.post('/api/local/backup/run', async (ctx) => {
    mayBackUp(ctx);
    const v = validate(ctx.body, { to: { type: 'string', required: true, enum: ['folder', 'download'] }, trigger: { type: 'string', enum: ['schedule', 'now'] }, existing: { type: 'array', maxLen: 5000, of: 'string' } });
    const rec = theVault && theVault.backup_key;
    const derived = rec && dekKey ? await vault.openBackupKey(dekKey, rec) : null;
    if (!derived) throw new HttpError(409, 'Type the backup passphrase again to carry on with scheduled backups (This device › Keep your records safe).', { backupPassphraseNeeded: true });
    const at = db.now();
    const clients = clientCount();
    const meta = { keys: keysHex(), org_name: db.getSetting('org_name', ''), clients, users: userCount(), schema_version: Number(db.getSetting('schema_version', '0')), created_at: at };
    if (vault.hasAccounts(theVault) && dekKey) { const nextDek = vault.newDek(); meta.device = await vault.backupRecord(theVault, dekKey, nextDek); nextDek.fill(0); }
    // The file records itself as the device's last backup (a device restored from it knows when it was taken),
    // but this device does not, until the page says the file landed.
    const previous = db.getSetting('last_backup_at', null); const previousTo = db.getSetting('last_backup_to', null);
    let bytes;
    try { db.setSetting('last_backup_at', at); db.setSetting('last_backup_to', v.to); bytes = sqlite.exportCurrent(); }
    finally { putBack('last_backup_at', previous); putBack('last_backup_to', previousTo); }
    let file;
    try { file = await asHttp(() => backup.createWithKey({ bytes, meta, derived, appVersion: require('./shims/config.js').version })); }
    finally { derived.raw.fill(0); bytes.fill(0); }
    const name = backup.fileName(at);
    pendingRun = { at, to: v.to, trigger: v.trigger || 'now', clients, name };
    const remove = v.to === 'folder' ? backup.toRemove([...(v.existing || []).filter(n => n !== name), name], keepCount()) : [];
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Suds-Backup-Remove': JSON.stringify(remove) });
    ctx.res.end(Buffer.from(file));
  });
  // The page wrote the file (or could not). Each backup written is audited (where, how many clients, never a
  // name or the folder); one that could not be written is audited as such and changes nothing else.
  router.post('/api/local/backup/run/done', (ctx) => {
    mayBackUp(ctx);
    const v = validate(ctx.body, { ok: { type: 'boolean' }, removed: { type: 'number', integer: true, min: 0, max: 5000 }, problem: { type: 'string', enum: ['permission', 'write', 'space', 'other'] } });
    if (!pendingRun) throw new HttpError(409, 'No backup is waiting to be written. Make a new one.');
    const p = pendingRun; pendingRun = null;
    if (v.ok === 1) {
      db.setSetting('last_backup_at', p.at); db.setSetting('last_backup_to', p.to);
      audit.log({ user: ctx.user, action: 'device.backup.created', details: { clients: p.clients, to: p.to, trigger: p.trigger, old_files_removed: v.removed || 0 } });
    } else audit.log({ user: ctx.user, action: 'device.backup.failed', details: { to: p.to, trigger: p.trigger, problem: v.problem || 'other' } });
    return { ok: true, backup: backupInfo() };
  });
  // The restore drill: open a backup with its passphrase, as a restore would, and check what is inside — the
  // database reads, passes SQLite's own check, belongs to the keys it carries and has every table this version
  // of SUDS expects — without changing anything on the device. The result is kept (This device shows it) and
  // audited: counts, table names and the problem found, never a record.
  const CORE_TABLES = ['settings', 'users', 'clients', 'audit_log'];
  router.post('/api/local/backup/check', async (ctx) => {
    mayBackUp(ctx, 'check its backups');
    const v = validate(ctx.body, { file_b64: { type: 'string', required: true, maxLen: 400 * 1024 * 1024 }, passphrase: { type: 'string', required: true, maxLen: 500 } });
    const file = Uint8Array.from(Buffer.from(v.file_b64.replace(/^data:[^,]*,/, ''), 'base64'));
    let out = null; let info = null; let problem = null; let message = null; let missing = [];
    try { out = await backup.open(file, v.passphrase); }
    catch (e) { if (!(e instanceof backup.BackupError)) throw e; problem = e.code; message = e.message; }
    if (out) {
      try {
        info = sqlite.inspect(out.bytes, (d) => ({
          integrity: Object.values(d.one('PRAGMA quick_check') || {})[0] || null,
          tables: String((d.one(`SELECT group_concat(name, '|') AS n FROM sqlite_master WHERE type='table'`) || {}).n || '').split('|').filter(Boolean),
          schema_version: Number((d.one(`SELECT value FROM settings WHERE key='schema_version'`) || {}).value || 0),
          clients: d.one(`SELECT COUNT(*) n FROM clients WHERE deleted_at IS NULL`).n, users: d.one(`SELECT COUNT(*) n FROM users`).n,
          fingerprint: (d.one(`SELECT value FROM settings WHERE key='encryption_key_fingerprint'`) || {}).value || null }));
      } catch { problem = 'tampered'; message = 'This backup file is damaged: its database cannot be read.'; }
      out.bytes.fill(0);
    }
    if (info) {
      const live = String((db.one(`SELECT group_concat(name, '|') AS n FROM sqlite_master WHERE type='table'`) || {}).n || '').split('|').filter(Boolean);
      const current = Number(db.getSetting('schema_version', '0'));
      // A backup from this version must have every table this device has; an older one (a restore upgrades it) the core ones.
      missing = (info.schema_version === current ? live : CORE_TABLES).filter(t => !info.tables.includes(t));
      const { sha256 } = require('../server/crypto.js');
      if (info.schema_version > db.LATEST_SCHEMA_VERSION) { problem = 'version'; message = 'This backup was made by a newer version of SUDS: this device could not restore it until SUDS is updated.'; }
      else if (info.integrity !== 'ok') { problem = 'tampered'; message = 'This backup file is damaged: SQLite found errors in its database.'; }
      else if (info.fingerprint && info.fingerprint !== sha256('suds-key-check:' + out.meta.keys.enc).slice(0, 32)) { problem = 'keys'; message = 'This backup does not carry the keys its records were written with, so it could not be restored.'; }
      else if (missing.length) { problem = 'tables'; message = `This backup is missing part of the database (${missing.length} table${missing.length === 1 ? '' : 's'}), so a restore would not bring everything back.`; }
    }
    const ok = !problem;
    const createdAt = out ? (out.meta.created_at || out.header.created_at || null) : null;
    db.setSetting('backup_check_at', db.now()); db.setSetting('backup_check_ok', ok ? '1' : '0'); putBack('backup_check_problem', problem); putBack('backup_check_backup_at', createdAt);
    audit.log({ user: ctx.user, action: 'device.backup.checked', details: { ok, problem, backup_created_at: createdAt, clients: info ? info.clients : null, tables: info ? info.tables.length : null, missing_tables: missing } });
    return { ok, problem, message, created_at: createdAt, app_version: out ? out.header.app_version : null, clients: info ? info.clients : null, users: info ? info.users : null, tables: info ? info.tables.length : null, missing, backup: backupInfo() };
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
  setInterval(idleCheck, IDLE_CHECK_MS);
  window.SUDS_LOCAL = { handle, flush: (opts) => sqlite.flush(opts), isDirty: () => sqlite.isDirty(), epoch: () => sqlite.epoch(), wipe: wipeDevice, sync: (opts) => sync.run(opts), isWiped: () => sqlite.isWiped(), isFrozen: () => sqlite.isFrozen(),
    // Diagnostics only: whether the database is open, and the sizes and timings of the last save (no contents);
    // whether a restored device still runs under the key its backup carried (no key material).
    phase: () => phase, saveStats: () => sqlite.saveStats(), lock: () => lockDevice(), rekeyPending: () => !!(theVault && theVault.rekey),
    // The folder scheduled backups are written to (1.24.0): a File System Access directory handle, kept with the
    // device's other stored values so that erasing the device forgets it too. No record and no key: the files
    // written there are encrypted backups (local/backup.js).
    backupFolder: { get: () => sqlite.getMeta('backup_folder'), set: (handle) => sqlite.putMeta({ backup_folder: handle || null }) } };
  return window.SUDS_LOCAL;
}

/**
 * Erase everything SUDS keeps in this browser profile: the sealed database (and the in-memory copy, so
 * nothing writes it back), the vault with every account's wrap of its key, the key in memory, and any
 * keys a 1.11-or-earlier device left in localStorage — so even a stale copy of the database that somehow survives is
 * unreadable. The device id lives inside the database and goes with it; the office is
 * told the wipe happened with the id captured before the erase (local/sync.js), and the next set-up on
 * this browser registers as a new device. Resolves once the delete has been committed to IndexedDB.
 */
async function wipeDevice() {
  await sqlite.wipe();
  for (const k of ['suds.local.session', ...LEGACY_KEYS, 'suds.prefs']) { try { localStorage.removeItem(k); } catch {} }
  token = ''; dropKey(); clearKeys(); theVault = null; phase = 'wiped';
}

/** Wraps, locking and the sign-in page's hints after a request that succeeded. Never fails the request. */
async function afterSuccess(method, path, body, ctx, result) {
  try {
    if (PASSWORD_PATHS.test(path)) await afterPasswordEvent(method, path, body, ctx, result);
    if (method === 'POST' && path === '/api/auth/logout') await lockDevice();
    else if (method !== 'GET' && /^\/api\/(users|local|admin|auth)(\/|$)/.test(path)) await reconcileVault(ctx);
  } catch (e) { reportError(e); }
}

/**
 * A route that stored a new password and then failed must not leave the device key wrapped only under the
 * old one (the account could then never unlock the device again): if the stored hash now matches the new
 * password, wrap it anyway.
 */
async function afterFailedPasswordWrite(method, path, body, ctx) {
  try {
    if (phase !== 'open' || !body || typeof body !== 'object') return;
    let id = null; let password = null;
    if (method === 'POST' && path === '/api/auth/password' && ctx.user) { id = ctx.user.id; password = body.new_password; }
    else if (method === 'PUT' && /^\/api\/users\/[^/]+$/.test(path) && body.password) { id = path.split('/').pop(); password = body.password; }
    if (!id || typeof password !== 'string') return;
    const u = db.one(`SELECT id, username, password_hash FROM users WHERE id=?`, id);
    const { verifyPasswordAsync } = require('../server/crypto.js');
    if (u && await verifyPasswordAsync(password, u.password_hash)) await enrol(u.id, u.username, password);
  } catch (e) { reportError(e); }
}

async function handle(method, path, body, headers = {}) {
  const url = new URL(path, 'http://local');
  const res = new FakeRes();
  const ctx = { req: { socket: { remoteAddress: '127.0.0.1' } }, res, method, path: url.pathname, query: url.searchParams, params: {}, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), cookies: {}, ip: 'device', user: null, session: null, body: null, rawBody: null };
  let relockOnFail = false; let recovered = false;
  try {
    // Nothing runs against an erased database: the page is about to reload into first-run setup.
    if (sqlite.isWiped()) throw new HttpError(410, 'This device has been erased and needs to be set up again.', { wiped: true });
    // Another window took the database over (see local/shims/sqlite.js): this page must not write, and a
    // read here could show what that window has since changed. The page shows its own explanation.
    if (sqlite.isFrozen()) throw new HttpError(409, 'SUDS is now open in another window on this device. Use that window, or take it back here.', { frozen: true });
    // Supplies on a device that syncs with an office: its items, sites and supply settings are the office's
    // (server/sync-tables.js serverOwned) and server/routes/supplies.js refuses to change them here; stock
    // received, moved, counted or disposed of here is recorded and pushed to the office, which checks it.
    if (!ctx.headers['x-background']) lastActivity = Date.now();
    // Locked (after a reload, a sign-out or idle): the database is not open, and only a sign-in (or a sign-up
    // someone vouches for) can open it. See the encryption-at-rest section at the top of this file.
    if (phase === 'locked') {
      const a = await lockedAnswer(method, url.pathname, body);
      if (a.done) return { status: a.status || 200, headers: { 'content-type': 'application/json' }, json: a.json };
      relockOnFail = a.relockOnFail; recovered = !!a.recovered;
    }
    // The vouching account's password is the kernel's business only: it never reaches a route (or its logs).
    if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && ('sponsor_password' in body || 'sponsor_username' in body)) { body = { ...body }; delete body.sponsor_username; delete body.sponsor_password; }
    const m = router.match(method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    ctx.params = m.params;
    if (token) ctx.headers.authorization = 'Bearer ' + token;
    ctx.user = auth.resolveSession(ctx);
    // Opened with the recovery code by lockedAnswer just now (never anything a request can claim for itself).
    ctx.recoveryProven = recovered && url.pathname === '/api/local/recover';
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) { ctx.rawBody = Buffer.from(body); ctx.body = {}; }
    else if (typeof body === 'string') { ctx.rawBody = Buffer.from(body); ctx.body = {}; }
    else ctx.body = body || {};
    // Same as the office server (server/app.js): a retried POST with the same Idempotency-Key runs once.
    const result = await idempotency.run(ctx, async () => { let out; for (const h of m.handlers) out = await h(ctx); return out; });
    // Not saved here: exporting the whole database on every write cost 40-130 ms a request on a large
    // caseload (1.9.1). The shim saves on a short coalescing timer, the page saves on its way out
    // (pagehide / hidden / freeze), and the next document of this tab waits for this one's lock before it
    // reads, so a write made just before leaving is still there. A failed save is reported by onSaveError.
    // login/logout manage the bearer token that replaces the cookie. In memory only: a reload signs out.
    const setCookie = res.headers['set-cookie'];
    if (setCookie) { const mm = /suds_session=([^;]*)/.exec(setCookie); token = mm && mm[1] ? mm[1] : ''; }
    const status = res.headersSent ? res.status : (result === undefined ? 204 : (ctx.status || 200));
    if (status < 400) await afterSuccess(method, url.pathname, body, ctx, result);
    else if (relockOnFail) await lockDevice();
    if (res.headersSent) return { status: res.status, headers: res.headers, body: Buffer.concat(res.chunks) };
    return { status, headers: { 'content-type': 'application/json' }, json: result === undefined ? null : result };
  } catch (err) {
    // A sign-in that unlocked the device and then failed (a wrong password for this account, a locked-out
    // account) closes it again, after saving what the attempt recorded (the audit entry, the failed count).
    if (relockOnFail) { try { await lockDevice(); } catch {} }
    else await afterFailedPasswordWrite(method, url.pathname, body, ctx);
    if (err instanceof HttpError) return { status: err.status, headers: { 'content-type': 'application/json' }, json: { error: err.message, ...(err.extra || {}) } };
    // The device locked while this request was on its way (sign-out, idle, a page-load before sign-in, or a
    // report that yields between queries and resumes after the lock): an expected state, answered like any
    // signed-out request, which sends the app to sign-in. Not an error worth a console line.
    if (err && err.code === 'DEVICE_LOCKED') return { status: 401, headers: { 'content-type': 'application/json' }, json: { error: 'This device is locked. Sign in to continue.', locked: true } };
    // Same as the office server: log the detail, tell the caller nothing. The message can carry SQL, file
    // paths, or fragments of the record being written.
    console.error('[suds-local]', method, path, err);
    return { status: 500, headers: { 'content-type': 'application/json' }, json: { error: 'Something went wrong on this device. Try again, and sync if it keeps happening.' } };
  }
}
