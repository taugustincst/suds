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

const FILE_RE = /^suds-.*\.db\.enc$/;
const OFFSITE_MISSING = 'offsite directory does not exist (is the share mounted?)';

function settings() {
  const hours = Number(db.getSetting('backup_schedule_hours', '0')) || 0;
  const retain = Math.max(1, Number(db.getSetting('backup_retain_count', '14')) || 14);
  const offsiteDir = db.getSetting('backup_offsite_dir', '') || '';
  return { hours, retain, offsiteDir };
}

/** Run a scheduled backup if one is due (schedule enabled and the interval has elapsed). No-op otherwise.
 *  Never throws: a failure is recorded in last_scheduled_backup_status (and audited) for the health check. */
function runIfDue(now = Date.now()) {
  const { hours, retain, offsiteDir } = settings();
  if (!hours) return null;
  const last = db.getSetting('last_scheduled_backup_at', null);
  if (last && now - Date.parse(last) < hours * 3600_000) return null;
  return run({ retain, offsiteDir });
}

/** Take a backup now, prune old ones beyond `retain`, and copy offsite if `offsiteDir` is set. */
function run({ retain = 14, offsiteDir = '' } = {}) {
  const dir = path.join(config.dataDir, 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `suds-${stamp}.db.enc`);
  let bytes; let verified = false; let verifyError = null; let kept = 0;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Prune first: the oldest copies beyond the retention count go before the new one is written, so a
    // disk that is full of old backups has room for tonight's rather than failing on ENOSPC with all of
    // them still there. The new file is not on disk yet, so `retain` is the number of older ones to keep.
    prune(dir, Math.max(0, retain - 1));
    bytes = backup.create();
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    // A backup nobody has ever opened is a hope, not a backup. Read the file back, decrypt it with the live
    // key and open it read-only, the same way a restore would -- and record the answer where the admin looks.
    try { const info = backup.inspect(backup.decrypt(fs.readFileSync(file))); verified = info.counts.clients >= 0; }
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

  let offsiteOk = null; let offsiteError = null;
  if (offsiteDir) {
    // A missing or unreachable offsite path (an unmounted network share, most likely) must not lose the
    // local backup that already succeeded — it is recorded as a status, not thrown. The directory is
    // never created here: an unmounted share is an empty mount point, and mkdir -p would quietly put the
    // "offsite" copy on the very disk it exists to survive losing.
    try {
      let st = null; try { st = fs.statSync(offsiteDir); } catch {}
      if (!st || !st.isDirectory()) throw new Error(OFFSITE_MISSING);
      fs.copyFileSync(file, path.join(offsiteDir, path.basename(file)));
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
  audit.log({ user: { username: 'system' }, action: 'backup.scheduled', details: { bytes: bytes.length, offsite: offsiteDir ? offsiteOk : null, offsite_error: offsiteError || undefined, kept, verified } });
  return { file, bytes: bytes.length, offsiteOk, offsiteError, verified, verifyError };
}

/** Delete the oldest local backups beyond the retention count. ISO timestamps in the filename sort chronologically. */
function prune(dir, retain) {
  const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  const excess = files.length - retain;
  if (excess > 0) for (const f of files.slice(0, excess)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  return Math.min(files.length, retain);
}

module.exports = { runIfDue, run, settings };
