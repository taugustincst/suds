'use strict';
// Unattended encrypted backups. `npm run backup` and the Administration "download backup" button both
// still work as manual options; this adds a scheduled path so a backup is not only as reliable as whoever
// remembered to run one. Runs from the same hourly housekeeping timer as audit/tombstone retention
// (server/index.js), self-throttled against last_scheduled_backup_at the same way audit verification is.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const audit = require('./audit');
const backup = require('./backup');
const lock = require('./backup-lock');

// Scheduled backups are suds-<time>.db.enc; the frequent snapshots below are suds-snap-<time>.db.enc and
// are pruned on their own count, so one never pushes the other out.
const FILE_RE = /^suds-\d.*\.db\.enc$/;
const SNAP_RE = /^suds-snap-.*\.db\.enc$/;
const OFFSITE_MISSING = 'offsite directory does not exist (is the share mounted?)';

/**
 * Where an offsite folder stands against the data directory (1.25.5, H3), resolved through symlinks, as
 * server/audit-anchor.js does for anchors. `inside`: the folder is in the data directory (its backups folder
 * included) or contains it, so it is no offsite copy at all: refused as the setting is saved, and never copied to.
 * `sameDisk`: it is on the same device (on Windows, the same volume) as the data, so a lost disk takes both: said by
 * the setting's answer, Security status and the hardening checklist. Each is the sentence to show, or null.
 */
function offsitePlacement(dir) {
  const real = (p) => { let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); } return process.platform === 'win32' ? r.toLowerCase() : r; };
  const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  const a = real(dir); const data = real(config.dataDir);
  const inside = within(a, data) || within(data, a);
  let sameDisk = false; try { sameDisk = !inside && fs.statSync(a).dev === fs.statSync(data).dev; } catch {}
  return { inside: inside ? 'is inside the data directory (or contains it), so it is not an offsite copy: choose a share on another disk or machine' : null,
    sameDisk: sameDisk ? 'is on the same disk as the data, so it is not an offsite copy: a failed disk takes both' : null };
}

function settings() {
  const hours = Number(db.getSetting('backup_schedule_hours', '0')) || 0;
  const retain = Math.max(1, Number(db.getSetting('backup_retain_count', '14')) || 14);
  const offsiteDir = db.getSetting('backup_offsite_dir', '') || '';
  // Frequent online snapshots (0 = off): every `minutes`, keep the newest `snapshotRetain`.
  const minutes = Number(db.getSetting('backup_schedule_minutes', '0')) || 0;
  const snapshotRetain = Math.max(1, Number(db.getSetting('backup_snapshot_retain', '24')) || 24);
  return { hours, retain, offsiteDir, minutes, snapshotRetain };
}

/**
 * The worst-case recovery point this configuration gives: the shorter of the backup and snapshot intervals
 * (a loss just before the next one runs costs one whole interval). Null when nothing is scheduled.
 */
function rpo(s = settings()) {
  const c = [];
  if (s.hours > 0) c.push({ minutes: s.hours * 60, by: 'scheduled backups' });
  if (s.minutes > 0) c.push({ minutes: s.minutes, by: 'online snapshots' });
  if (!c.length) return null;
  return c.sort((a, b) => a.minutes - b.minutes)[0];
}

/**
 * Day one: backups are scheduled, none has run yet, and the schedule was set less than twice its interval ago
 * (the first runs at the next hourly housekeeping pass). { hours, since, until } or null. The same window the
 * host check allows from the install (scripts/compliance/app-checks.js backupFiles); after it, "never" fails.
 */
function firstRunPending(now = Date.now()) {
  const { hours } = settings();
  if (!hours || db.getSetting('last_scheduled_backup_at', null)) return null;
  const row = db.one(`SELECT updated_at FROM settings WHERE key='backup_schedule_hours'`);
  const since = Date.parse((row && row.updated_at) || '');
  if (!Number.isFinite(since) || now - since >= 2 * hours * 3600_000) return null;
  return { hours, since: row.updated_at, until: new Date(since + 2 * hours * 3600_000).toISOString() };
}

/** Run a scheduled backup if one is due (schedule enabled and the interval has elapsed). Resolves to null
 *  otherwise. Never rejects: a failure is recorded in last_scheduled_backup_status (and audited) for the
 *  health check. */
async function runIfDue(now = Date.now()) {
  const { hours, retain, offsiteDir } = settings();
  if (!hours || lock.paused()) return null; // a restore holds the lock or waits for it: next turn
  const last = db.getSetting('last_scheduled_backup_at', null);
  if (last && now - Date.parse(last) < hours * 3600_000) return null;
  return run({ retain, offsiteDir });
}

// One scheduled backup at a time: the hourly timer, "Back up now" and a recovery drill can all ask for one,
// and the work spans many turns of the event loop.
let inFlight = null;

/**
 * Take a backup now, prune old ones beyond `retain`, and copy offsite if `offsiteDir` is set. Asynchronous
 * from end to end, because a scheduled backup runs while staff are working: the copy is SQLite's online
 * backup API, the encryption and the read-back decryption stream 4 MB at a time between the database copy
 * and the file (never the whole database in one Buffer), and the integrity check of the read-back copy runs
 * in a worker thread (server/backup.js createToFileAsync, verifyFileAsync). The synchronous path this
 * replaced held the server for 3.8 s on a 311 MB database. A call made while one is running shares its result.
 */
function run(opts = {}) {
  if (inFlight) return inFlight;
  // Under the shared lock (server/backup-lock.js): waits for a snapshot, drill or restore in flight, and a
  // restore waits for this one.
  inFlight = lock.run('backup', () => runOnce(opts)).finally(() => { inFlight = null; });
  return inFlight;
}
/** run() for a caller that already holds the lock (the recovery drill, when no backup is on disk). */
function runHeld(opts = {}) { return runOnce(opts); }

async function runOnce({ retain = 14, offsiteDir = '' } = {}) {
  const dir = path.join(config.dataDir, 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `suds-${stamp}.db.enc`);
  let bytes; let verified = false; let verifyError = null; let kept = 0; let method = null;
  console.log(`[suds] scheduled backup ${path.basename(file)} starting${offsiteDir ? `, with an offsite copy to ${offsiteDir}` : ''}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Prune first: the oldest copies beyond the retention count go before the new one is written, so a
    // disk that is full of old backups has room for tonight's rather than failing on ENOSPC with all of
    // them still there. The new file is not on disk yet, so `retain` is the number of older ones to keep.
    prune(dir, Math.max(0, retain - 1));
    const made = await backup.createToFileAsync(file);
    bytes = made.bytes; method = made.method;
    // A backup nobody has ever opened is a hope, not a backup. Read the file back, decrypt it with the live
    // key and open it read-only, the same way a restore would -- and record the answer where the admin looks.
    try { const info = await backup.verifyFileAsync(file); verified = info.counts.clients >= 0; }
    catch (e) { verifyError = String(e && e.message || e); console.error('[suds] backup written but could not be read back:', verifyError); }
  } catch (e) {
    // The failure that used to be invisible: an exception here propagated out of the housekeeping timer
    // and nothing was recorded, so the Administration page went on saying the last backup was fine.
    // Now it is the status the page and /api/health show, and an audit entry that says so.
    const reason = e && e.code === 'ENOSPC' ? `no space left on the disk holding ${dir}` : String(e && e.message || e);
    try { fs.unlinkSync(file); } catch {}
    console.error('[suds] scheduled backup failed:', reason);
    db.setSetting('last_scheduled_backup_at', db.now());
    db.setSetting('last_scheduled_backup_status', `failed: ${reason}`);
    audit.log({ user: { username: 'system' }, action: 'backup.scheduled', success: false, details: { error: reason, code: e && e.code || undefined } });
    return { file: null, bytes: 0, offsiteOk: null, verified: false, verifyError: reason, failed: true, error: reason };
  }

  let offsiteOk = null; let offsiteError = null; let offsiteFile = null; let repaired = 0;
  if (offsiteDir) {
    // A missing or unreachable offsite path (an unmounted network share, most likely) must not lose the
    // local backup that already succeeded — it is recorded as a status, not thrown. The directory is
    // never created here: an unmounted share is an empty mount point, and mkdir -p would quietly put the
    // "offsite" copy on the very disk it exists to survive losing.
    try {
      let st = null; try { st = await fs.promises.stat(offsiteDir); } catch {}
      if (!st || !st.isDirectory()) throw new Error(OFFSITE_MISSING);
      const inside = offsitePlacement(offsiteDir).inside;
      if (inside) throw new Error(`offsite directory ${inside}`);
      prunePartials(offsiteDir);
      await copyVerified(file, offsiteDir); offsiteMatched.set(path.basename(file), Date.now());
      offsiteFile = path.join(offsiteDir, path.basename(file));
      offsiteOk = true;
      repaired = await repairOffsite(dir, offsiteDir);
    } catch (e) { offsiteOk = false; offsiteError = String(e && e.message || e); }
  }
  // One line per run, whatever happened, so the server log answers "did the backups run?" (no PHI: a file name,
  // sizes and outcomes).
  (verified && offsiteOk !== false ? console.log : console.error)(`[suds] scheduled backup ${path.basename(file)}: ${bytes} bytes, ${verified ? 'verified' : 'NOT verified'}; offsite ${!offsiteDir ? 'not configured' : offsiteOk ? 'copied and checked (size and SHA-256)' : `copy FAILED: ${offsiteError}`}${repaired ? `; ${repaired} earlier offsite cop${repaired === 1 ? 'y' : 'ies'} that did not match copied again` : ''}`);

  // Every backup is also an audit anchor: the chain head it contains, sealed outside the database.
  if (!config.local) require('./audit-anchor').safeWrite('backup');
  kept = prune(dir, retain);
  db.setSetting('last_scheduled_backup_at', db.now());
  db.setSetting('last_scheduled_backup_status', !verified ? `backup written but could not be read back — ${verifyError}` : offsiteDir && offsiteOk === false ? `ok (verified) — offsite copy failed: ${offsiteError}; local backup kept` : 'ok (verified)');
  audit.log({ user: { username: 'system' }, action: 'backup.scheduled', details: { bytes, method, offsite: offsiteDir ? offsiteOk : null, offsite_error: offsiteError || undefined, offsite_repaired: repaired || undefined, kept, verified } });
  return { file, bytes, method, offsiteOk, offsiteError, offsiteFile: offsiteOk ? offsiteFile : null, repaired, verified, verifyError };
}

/** Size and SHA-256 of a file, streamed. */
async function digest(file) {
  const h = crypto.createHash('sha256'); let bytes = 0;
  for await (const c of fs.createReadStream(file)) { h.update(c); bytes += c.length; }
  return { bytes, sha256: h.digest('hex') };
}

/**
 * Copy a backup into `destDir` and prove the copy: streamed to a temporary name there, flushed to disk, renamed
 * into place, then read back and compared with the backup (size and SHA-256); a copy that does not match is
 * deleted and the error says so. Not fs.copyFile: libuv's copyfile calls fchown() on the new file before it
 * copies a byte, SUDS Server's unit denies fchown (deploy/linux/suds.service, SystemCallFilter=~@privileged), and
 * systemd killed SUDS there with SIGSYS on every run, leaving an empty offsite file (suds.systems, 1.25.3).
 */
async function copyVerified(src, destDir) {
  const dest = path.join(destDir, path.basename(src));
  const tmp = path.join(destDir, `.${path.basename(src)}.${crypto.randomBytes(4).toString('hex')}.part`);
  try {
    const out = await fs.promises.open(tmp, 'wx', 0o600);
    try { for await (const c of fs.createReadStream(src)) await out.write(c); await out.sync(); } finally { await out.close(); }
    await fs.promises.rename(tmp, dest);
  } catch (e) { await fs.promises.rm(tmp, { force: true }); throw e; }
  const [a, b] = await Promise.all([digest(src), digest(dest)]);
  if (a.bytes === b.bytes && a.sha256 === b.sha256) return b;
  await fs.promises.rm(dest, { force: true });
  throw new Error(`the offsite copy of ${path.basename(src)} did not match the backup (${b.bytes} of ${a.bytes} bytes${a.bytes === b.bytes ? ', different SHA-256' : ''}) and was deleted`);
}

// When each offsite copy last matched its local backup (name -> ms), and the local backups' SHA-256 (they are never
// changed once written, so keyed by name, size and time): each copy is read back at most once a day.
const offsiteMatched = new Map(); const localSums = new Map();
const RECHECK_MS = 24 * 3600_000;
/**
 * Copy again each offsite backup that is not the local backup of the same name: its size differs (the empty files
 * 1.25.3 and earlier left on SUDS Server) or, read back, its SHA-256 does (1.25.5, H9: a copy damaged since, at the
 * same size). A local backup that no longer decrypts is never copied over its offsite copy. Local backups are only
 * read. Resolves to how many were copied.
 */
async function repairOffsite(localDir, offsiteDir, now = Date.now()) {
  let n = 0;
  for (const f of fs.readdirSync(offsiteDir).filter((x) => FILE_RE.test(x))) {
    const src = path.join(localDir, f); const dest = path.join(offsiteDir, f);
    let a; let b; try { a = fs.lstatSync(src); b = fs.lstatSync(dest); } catch { continue; }
    if (!a.isFile() || !b.isFile() || (a.size === b.size && now - (offsiteMatched.get(f) || 0) < RECHECK_MS)) continue;
    if (a.size === b.size) {
      const id = `${f}:${a.size}:${a.mtimeMs}`;
      if (!localSums.has(id)) localSums.set(id, (await digest(src)).sha256);
      if ((await digest(dest)).sha256 === localSums.get(id)) { offsiteMatched.set(f, now); continue; }
    }
    try { await backup.verifyFileAsync(src); } catch (e) { console.error(`[suds] the offsite copy ${f} does not match its local backup, which no longer reads back either (${e.message}): neither is replaced`); continue; }
    await copyVerified(src, offsiteDir); offsiteMatched.set(f, now); n++;
  }
  return n;
}
/** Remove the temporary `.part` files of offsite copies stopped part-way (copyVerified) once they are a day old. */
function prunePartials(dir, now = Date.now()) {
  let names = []; try { names = fs.readdirSync(dir).filter((x) => /^\.suds-.*\.part$/.test(x)); } catch {}
  for (const f of names) { try { const s = fs.lstatSync(path.join(dir, f)); if (s.isFile() && now - s.mtimeMs > RECHECK_MS) fs.unlinkSync(path.join(dir, f)); } catch {} }
}

/** The newest scheduled backup in `dir` by its name (a timestamp): { newest: { file, mtime, size } | null, count },
 *  or { error } when `dir` cannot be read. lstat: a symlink planted among the backups is not followed, nor counted. */
function newest(dir) {
  let names; try { names = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort(); } catch (e) { return { error: e.code || e.message }; }
  for (let i = names.length - 1; i >= 0; i--) { try { const s = fs.lstatSync(path.join(dir, names[i])); if (s.isFile()) return { newest: { file: names[i], mtime: s.mtimeMs, size: s.size }, count: names.length }; } catch {} }
  return { newest: null, count: names.length };
}

/** Why the offsite copy `name` of `size` bytes is not a whole backup, or null: it is empty, or its size differs
 *  from the local backup of that name (the compliance check, Security status and the recovery drill ask). */
function copyProblem(name, size) {
  if (!size) return `the offsite copy ${name} is empty (0 bytes): it is not a backup`;
  let local = null; try { local = fs.lstatSync(path.join(config.dataDir, 'backups', name)).size; } catch {}
  return local !== null && local !== size ? `the offsite copy ${name} is ${size} bytes, but the local backup of that name is ${local} bytes` : null;
}

// ---- frequent online snapshots (lower RPO without new dependencies) ----
// Every backup_schedule_minutes, an encrypted copy of the whole database taken with SQLite's online backup
// API (server/backup.js createToFileAsync: it yields between page batches and streams the encryption to the
// file, so requests keep being served) is
// written to the offsite directory when one is configured (else to <data>/backups), and the oldest beyond
// backup_snapshot_retain are pruned. Each is a full copy, not a page-level increment: SQLite has no
// incremental backup, and a full copy of a county-sized database takes seconds (measurements in
// docs/security/BACKUP-AND-DR.md). They sit beside the scheduled backups, which keep their own longer
// retention and their verification read-back.
/** Run a snapshot if one is due. Resolves to the result, or null when none was due. Never rejects. */
async function snapshotIfDue(now = Date.now()) {
  const s = settings();
  if (!s.minutes || lock.current() || lock.paused()) return null;
  const last = db.getSetting('last_snapshot_at', null);
  if (last && now - Date.parse(last) < s.minutes * 60_000) return null;
  return snapshot(s);
}
async function snapshot(s = settings()) {
  // Skipped, not queued, while anything else holds the shared lock: the next minute's timer tries again.
  const release = lock.tryAcquire('snapshot');
  if (!release) return null;
  const localDir = path.join(config.dataDir, 'backups');
  let target = localDir; let where = 'local';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let file = null;
  try {
    if (s.offsiteDir) {
      // The same rule as the scheduled copy: an offsite path that is not there is never created.
      let st = null; try { st = fs.statSync(s.offsiteDir); } catch {}
      if (!st || !st.isDirectory()) throw new Error(OFFSITE_MISSING);
      target = s.offsiteDir; where = 'offsite';
    } else fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
    file = path.join(target, `suds-snap-${stamp}.db.enc`);
    const made = await backup.createToFileAsync(file, { flag: 'wx' });
    const kept = pruneMatching(target, SNAP_RE, s.snapshotRetain);
    db.setSetting('last_snapshot_at', db.now());
    db.setSetting('last_snapshot_status', `ok (${where}; ${made.method}; ${Math.round(made.bytes / 1024)} KB in ${made.copy_ms + made.encrypt_ms} ms)`);
    // Not audited one by one (every few minutes would drown the log); the hourly housekeeping pass notes a
    // failure, and the status is on Security status and /api/health.
    return { file, where, kept, bytes: made.bytes, method: made.method, copy_ms: made.copy_ms, encrypt_ms: made.encrypt_ms };
  } catch (e) {
    const reason = e && e.code === 'ENOSPC' ? `no space left on the disk holding ${target}` : String(e && e.message || e);
    if (file) { try { fs.unlinkSync(file); } catch {} }
    console.error('[suds] snapshot failed:', reason);
    const prev = db.getSetting('last_snapshot_status', '') || '';
    db.setSetting('last_snapshot_at', db.now());
    db.setSetting('last_snapshot_status', `failed: ${reason}`);
    // Audited on the change from working to failing, not on every attempt.
    if (!/^failed/.test(prev)) audit.log({ user: { username: 'system' }, action: 'backup.snapshot.failed', success: false, details: { error: reason.slice(0, 300) } });
    return { file: null, failed: true, error: reason };
  } finally { release(); }
}

/** Delete the oldest files matching `re` beyond `retain`. ISO timestamps in the names sort chronologically. */
function pruneMatching(dir, re, retain) {
  const files = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
  const excess = files.length - retain;
  if (excess > 0) for (const f of files.slice(0, excess)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  return Math.min(files.length, retain);
}

/** Delete the oldest local backups beyond the retention count. ISO timestamps in the filename sort chronologically. */
function prune(dir, retain) {
  const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  const excess = files.length - retain;
  if (excess > 0) for (const f of files.slice(0, excess)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  return Math.min(files.length, retain);
}

module.exports = { runIfDue, run, runHeld, settings, firstRunPending, rpo, snapshot, snapshotIfDue, copyVerified, repairOffsite, prunePartials, offsitePlacement, newest, copyProblem, FILE_RE, SNAP_RE };
