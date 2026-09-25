'use strict';
// Disaster-recovery drill: "we have backups" turned into "we restored one, and here is how long it took".
//
// Takes the newest scheduled backup (or makes one when there is none), decrypts it into a throwaway
// directory, and starts SUDS against that copy in a separate process (server/dr-drill-child.js) that has
// never been told where the live database is. The child verifies the schema, row counts, the whole audit
// chain and the anchors outside the database, decrypts a sample of every encrypted column, and signs in with
// a password and a second factor. The parent measures:
//   RTO evidence — seconds from starting the restore to the restored copy answering /api/health
//   RPO evidence — the age of the backup that was restored (what a real disaster would have lost)
// and writes a JSON report (with its SHA-256, and an HMAC under the index key so it cannot be edited
// unnoticed) plus a plain-text one into the backup directory, remembers the outcome in settings
// (dr_last_drill), and writes an audit entry. The copy is deleted whatever happens.
//
// Used by `npm run dr-drill` (scripts/dr-drill.js), Settings → System & backups → "Run a recovery drill
// now" (server/routes/security.js), and, when an administrator turns it on, monthly from housekeeping.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const audit = require('./audit');

const BACKUP_RE = /^suds-.*\.db\.enc$/;
const MONTH_MS = 30 * 86400_000;
const CHILD_TIMEOUT_MS = Number(process.env.DR_DRILL_TIMEOUT_MS || 15 * 60_000);

function backupsDir() { return path.join(config.dataDir, 'backups'); }
/** The time a backup was taken: from its name (suds-2026-09-25T02-00-00-000Z.db.enc), else its mtime. */
function backupTime(file) {
  const m = path.basename(file).match(/^suds-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (m) { const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`); if (Number.isFinite(t)) return t; }
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}
function latestBackup(dir = backupsDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort(); } catch { return null; }
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

function targets() {
  const num = (k, d) => { const v = Number(db.getSetting(k, '')); return Number.isFinite(v) && v > 0 ? v : d; };
  const schedule = Number(db.getSetting('backup_schedule_hours', '0')) || 0;
  return { rto_minutes: num('dr_rto_target_minutes', 60), rpo_hours: num('dr_rpo_target_hours', schedule || 24) };
}
function lastDrill() { try { return JSON.parse(db.getSetting('dr_last_drill', 'null')); } catch { return null; } }

// One drill at a time, per process; the Settings page polls this.
let current = null;
function status() {
  return {
    running: current ? { started_at: current.started_at, by: current.by, steps: current.steps.slice() } : null,
    last: lastDrill(),
    monthly: db.getSetting('dr_drill_monthly', '0') === '1',
    targets: targets(),
    reports: listReports().slice(-12).reverse(),
  };
}
function listReports() {
  try { return fs.readdirSync(backupsDir()).filter((f) => /^dr-drill-.*\.json$/.test(f)).sort(); } catch { return []; }
}

/** Canonical JSON for signing: keys sorted at every level. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
function seal(report, key = config.indexKey) {
  const body = canonical(report);
  return { sha256: crypto.createHash('sha256').update(body).digest('hex'), hmac_sha256: crypto.createHmac('sha256', key).update(body).digest('hex'), algorithm: 'SHA-256 and HMAC-SHA256 (index key) over the canonical JSON of "report" (keys sorted)' };
}
/** Check a written report: { report, integrity } → true when both digests match. */
function verifyReport(doc, key = config.indexKey) {
  const s = seal(doc.report, key);
  return !!doc.integrity && s.sha256 === doc.integrity.sha256 && s.hmac_sha256 === doc.integrity.hmac_sha256;
}

function runChild(tmp, dbFile, onStep) {
  const { fork } = require('node:child_process');
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH || '', SUDS_ENV: config.isTest ? 'test' : 'production', SUDS_DATA_DIR: tmp, SUDS_DB_PATH: dbFile, SUDS_SKIP_SETUP: '1', TZ: process.env.TZ || '', LOG_FORMAT: 'text', LOGIN_RATE_LIMIT: '1000' };
    if (!env.TZ) delete env.TZ;
    const child = fork(path.join(__dirname, 'dr-drill-child.js'), [], { cwd: tmp, env, execArgv: ['--no-warnings=ExperimentalWarning'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let result = null; let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-4000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, CHILD_TIMEOUT_MS);
    child.on('message', (m) => { if (m && m.type === 'progress') onStep(m.step); else if (m && m.type === 'result') result = m; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(result || { ok: false, error: signal === 'SIGKILL' ? `the restored copy did not finish within ${Math.round(CHILD_TIMEOUT_MS / 60000)} minutes` : `the drill process exited (${code ?? signal})${stderr ? ': ' + stderr.trim().split('\n').slice(-3).join(' ') : ''}`, checks: [] });
    });
    // The keys go over IPC, never in the child's environment or arguments.
    child.send({ keys: { enc: config.encryptionKey.toString('hex'), idx: config.indexKey.toString('hex') }, anchorDir: config.auditAnchorDir });
  });
}

/**
 * Run a drill. Resolves to the report document ({ report, integrity, files }). Rejects only when a drill is
 * already running; every other failure is a failed drill, recorded like a passed one.
 */
async function run({ backupFile = null, fresh = false, by = 'system', trigger = 'manual', record = true } = {}) {
  if (current) { const e = new Error('A recovery drill is already running'); e.code = 'EBUSY'; throw e; }
  const job = current = { started_at: new Date().toISOString(), by, steps: [] };
  const step = (s) => { job.steps.push({ at: new Date().toISOString(), step: s }); };
  const started = Date.now();
  const tmpRoot = path.join(config.dataDir, '.dr-drill');
  const tmp = path.join(tmpRoot, `drill-${started}-${crypto.randomBytes(4).toString('hex')}`);
  const failures = [];
  let result = { checks: [] }; let file = backupFile; let madeBackup = false; let restoreStarted = null; let restoreBytes = 0;
  try {
    // Which backup. A drill restores what a disaster would leave the county with: the newest backup on
    // disk. Only when there is none (or when asked) is one made first.
    if (!file) file = fresh ? null : latestBackup();
    if (!file) {
      step('No backup on disk; taking one first');
      const s = require('./scheduled-backup').settings();
      const made = require('./scheduled-backup').run({ retain: s.retain, offsiteDir: s.offsiteDir });
      if (!made.file) throw new Error(`a backup could not be taken: ${made.error}`);
      file = made.file; madeBackup = true;
    }
    step(`Restoring ${path.basename(file)}`);
    restoreStarted = Date.now();
    const enc = fs.readFileSync(file);
    const plain = require('./backup').decrypt(enc);
    restoreBytes = plain.length;
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(tmpRoot, 0o700); } catch {}
    const dbFile = path.join(tmp, 'suds.db');
    fs.writeFileSync(dbFile, plain, { mode: 0o600 });
    result = await runChild(tmp, dbFile, step);
    if (result.error) failures.push(result.error);
  } catch (e) {
    failures.push(String(e && e.message || e));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { failures.push(`the drill copy could not be removed from ${tmp}: ${e.message}`); }
  }
  const finished = Date.now();
  const checks = result.checks || [];
  for (const c of checks) if (!c.ok) failures.push(`${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  const taken = file ? backupTime(file) : null;
  const t = targets();
  const rtoSeconds = restoreStarted && result.ready_at ? Math.round((result.ready_at - restoreStarted) / 100) / 10 : null;
  const rpoSeconds = taken ? Math.round(((restoreStarted || started) - taken) / 1000) : null;
  // Rows the live server holds beyond the backup: what the county would re-enter after a real loss.
  const exposure = {};
  if (result.source_counts) for (const tname of ['clients', 'notes', 'interventions', 'referrals', 'tasks', 'audit_log']) {
    try { exposure[tname] = db.one(`SELECT COUNT(*) n FROM "${tname}"`).n - (result.source_counts[tname] || 0); } catch {}
  }
  const report = {
    kind: 'suds-dr-drill', version: 1,
    ok: failures.length === 0 && checks.length > 0,
    started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(), trigger, by,
    server: { version: config.version, host: require('node:os').hostname(), schema_version: db.LATEST_SCHEMA_VERSION },
    backup: { file: file ? path.basename(file) : null, taken_at: taken ? new Date(taken).toISOString() : null, made_for_drill: madeBackup, decrypted_bytes: restoreBytes, latest_record_at: result.latest_audit_at || null },
    rto: { seconds: rtoSeconds, target_minutes: t.rto_minutes, met: rtoSeconds === null ? null : rtoSeconds <= t.rto_minutes * 60, measures: 'from starting the restore (reading and decrypting the backup) to the restored copy answering /api/health' },
    rpo: { seconds: rpoSeconds, target_hours: t.rpo_hours, met: rpoSeconds === null ? null : rpoSeconds <= t.rpo_hours * 3600, measures: 'age of the newest backup at the time of the drill: what a loss at that moment would have cost' },
    elapsed_seconds: Math.round((finished - started) / 100) / 10,
    schema: { restored_from: result.source_schema_version ?? null, now: result.schema_version ?? null },
    counts: { restored: result.restored_counts || null, live_minus_backup: exposure },
    audit: { entries_verified: result.audit_entries_verified ?? null, anchors: result.anchors || null },
    decrypt_sample: result.decrypt_sample || null,
    checks, adjustments: result.adjustments || [], failures,
    live_database_untouched: true,
  };
  const doc = { report, integrity: seal(report) };
  const files = {};
  try {
    const dir = backupsDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = report.started_at.replace(/[:.]/g, '-');
    files.json = `dr-drill-${stamp}.json`; files.text = `dr-drill-${stamp}.txt`;
    fs.writeFileSync(path.join(dir, files.json), JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, files.text), textReport(doc), { mode: 0o600 });
  } catch (e) { report.failures.push(`the report could not be written: ${e.message}`); }
  if (record) {
    const summary = { at: report.finished_at, ok: report.ok, rto_seconds: rtoSeconds, rpo_seconds: rpoSeconds, rto_target_minutes: t.rto_minutes, rpo_target_hours: t.rpo_hours, backup_file: report.backup.file, backup_taken_at: report.backup.taken_at, report_file: files.json || null, sha256: doc.integrity.sha256, failures: failures.slice(0, 5), checks_passed: checks.filter((c) => c.ok).length, checks_total: checks.length, trigger };
    db.setSetting('dr_last_drill', JSON.stringify(summary));
    audit.log({ user: typeof by === 'object' ? by : { username: String(by) }, action: 'dr.drill', success: report.ok, details: { trigger, backup: report.backup.file, rto_seconds: rtoSeconds, rpo_seconds: rpoSeconds, checks_passed: summary.checks_passed, checks_total: summary.checks_total, report: files.json || null, sha256: doc.integrity.sha256 } });
  }
  if (current === job) current = null;
  return { ...doc, files };
}

function fmtDur(s) { if (s === null || s === undefined) return 'n/a'; if (s < 120) return `${s} s`; if (s < 7200) return `${(s / 60).toFixed(1)} min`; return `${(s / 3600).toFixed(1)} h`; }
function textReport({ report: r, integrity }) {
  const L = [];
  L.push(`SUDS disaster-recovery drill — ${r.ok ? 'PASSED' : 'FAILED'}`);
  L.push(`Started ${r.started_at}, finished ${r.finished_at} (${r.trigger}, by ${typeof r.by === 'object' ? r.by.username : r.by}) on ${r.server.host}, SUDS ${r.server.version}`);
  L.push('');
  L.push(`Backup restored: ${r.backup.file || 'none'}${r.backup.taken_at ? ` (taken ${r.backup.taken_at})` : ''}${r.backup.made_for_drill ? ' — made for this drill, no earlier backup was on disk' : ''}`);
  L.push(`RTO (restore to serving): ${fmtDur(r.rto.seconds)} — target ${r.rto.target_minutes} min — ${r.rto.met === null ? 'not measured' : r.rto.met ? 'met' : 'NOT MET'}`);
  L.push(`RPO (age of that backup): ${fmtDur(r.rpo.seconds)} — target ${r.rpo.target_hours} h — ${r.rpo.met === null ? 'not measured' : r.rpo.met ? 'met' : 'NOT MET'}`);
  L.push('');
  L.push('Checks:');
  for (const c of r.checks) L.push(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  for (const f of r.failures.filter((f) => !r.checks.some((c) => f.startsWith(c.name)))) L.push(`  [FAIL] ${f}`);
  if (r.adjustments.length) { L.push(''); L.push('Changed in the throwaway copy only: ' + r.adjustments.join('; ')); }
  if (r.counts.live_minus_backup && Object.keys(r.counts.live_minus_backup).length) { L.push(''); L.push('Rows the live server holds beyond this backup: ' + Object.entries(r.counts.live_minus_backup).map(([k, v]) => `${k} ${v}`).join(', ')); }
  L.push('');
  L.push('The backup was restored into a temporary directory, checked by a separate process that was never given the live database\'s path, and deleted afterwards. The live database received only this result (a settings row and an audit entry).');
  L.push(`Integrity: SHA-256 ${integrity.sha256}`);
  L.push(`           HMAC-SHA256 ${integrity.hmac_sha256}`);
  L.push('The JSON report beside this file is the record of the drill; this text is a convenience copy.');
  return L.join('\n') + '\n';
}

/** Start a drill in the background (the Settings button). Returns immediately. */
function start(opts) {
  if (current) { const e = new Error('A recovery drill is already running'); e.code = 'EBUSY'; throw e; }
  const p = run(opts).catch((e) => { console.error('[suds] recovery drill:', e && e.message || e); });
  return p;
}

/** Housekeeping: once a month when an administrator has turned the monthly drill on. Off by default. */
function runIfDue(now = Date.now()) {
  if (db.getSetting('dr_drill_monthly', '0') !== '1' || current) return null;
  const last = lastDrill();
  if (last && last.at && now - Date.parse(last.at) < MONTH_MS) return null;
  return start({ by: 'system', trigger: 'monthly' });
}

module.exports = { run, start, runIfDue, status, lastDrill, latestBackup, backupTime, verifyReport, canonical, seal, textReport, targets };
