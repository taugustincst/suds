'use strict';
// Unattended encrypted backups. `npm run backup` and the Administration "download backup" button both
// still work as manual options; this adds a scheduled path so a backup is not only as reliable as whoever
// remembered to run one. Runs from the same hourly housekeeping timer as audit/tombstone retention
// (server/index.js), self-throttled against last_scheduled_backup_at the same way audit verification is.
const fs = require('node:fs');
const path = require('node:path');
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

  let offsiteOk = null; let offsiteError = null; let offsiteFile = null;
  if (offsiteDir) {
    // A missing or unreachable offsite path (an unmounted network share, most likely) must not lose the
    // local backup that already succeeded — it is recorded as a status, not thrown. The directory is
    // never created here: an unmounted share is an empty mount point, and mkdir -p would quietly put the
    // "offsite" copy on the very disk it exists to survive losing.
    try {
      let st = null; try { st = await fs.promises.stat(offsiteDir); } catch {}
      if (!st || !st.isDirectory()) throw new Error(OFFSITE_MISSING);
      offsiteFile = path.join(offsiteDir, path.basename(file));
      await fs.promises.copyFile(file, offsiteFile);
      offsiteOk = true;
    } catch (e) {
      offsiteOk = false; offsiteError = String(e && e.message || e);
      console.error('[suds] offsite backup copy failed:', offsiteError);
    }
  }

  // Every backup is also an audit anchor: the chain head it contains, sealed outside the database.
  if (!config.local) require('./audit-anchor').safeWrite('backup');
  kept = prune(dir, retain);
  db.setSetting('last_scheduled_backup_at', db.now());
  db.setSetting('last_scheduled_backup_status', !verified ? `backup written but could not be read back — ${verifyError}` : offsiteDir && offsiteOk === false ? `ok (verified) — offsite copy failed: ${offsiteError}; local backup kept` : 'ok (verified)');
  audit.log({ user: { username: 'system' }, action: 'backup.scheduled', details: { bytes, method, offsite: offsiteDir ? offsiteOk : null, offsite_error: offsiteError || undefined, kept, verified } });
  return { file, bytes, method, offsiteOk, offsiteError, offsiteFile: offsiteOk ? offsiteFile : null, verified, verifyError };
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

module.exports = { runIfDue, run, runHeld, settings, rpo, snapshot, snapshotIfDue, FILE_RE, SNAP_RE };
