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
/** The time a backup was taken: from its name (suds-[snap-]2026-09-25T02-00-00-000Z.db.enc), else its mtime. */
function backupTime(file) {
  const m = path.basename(file).match(/^suds-(?:snap-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (m) { const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`); if (Number.isFinite(t)) return t; }
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}
/** The newest backup or snapshot in `dir`, by the time it was taken (snapshots and backups sort apart by name). */
function latestBackup(dir = backupsDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)); } catch { return null; }
  let best = null; let bestT = -Infinity;
  for (const n of names) { const f = path.join(dir, n); const t = backupTime(f) ?? -Infinity; if (t > bestT || (t === bestT && n > path.basename(best))) { best = f; bestT = t; } }
  return best;
}

/**
 * The escrowed key backup a drill can be told to use instead of the keys in this process's memory: the
 * keys.json that Settings -> System & backups -> "Download key backup" gives (or the setup wizard saved), or a
 * .env-style file of the same names. Returns { encryptionKey, indexKey, backupKey } as Buffers (backupKey may
 * be null). Throws with a sentence when the file is not one.
 */
function parseKeysFile(text) {
  const t = String(text || '').trim();
  let obj = null;
  if (t.startsWith('{')) { try { obj = JSON.parse(t); } catch { throw new Error('The key file is not valid JSON'); } }
  else { obj = {}; for (const line of t.split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*["']?([0-9a-fA-F]+)["']?\s*$/); if (m) obj[m[1]] = m[2]; } }
  const hex = (k, required) => {
    const v = obj[k];
    if (v === undefined || v === null || v === '') { if (required) throw new Error(`The key file has no ${k}`); return null; }
    if (!/^[0-9a-fA-F]{64}$/.test(String(v))) throw new Error(`${k} in the key file is not 64 hex characters`);
    return Buffer.from(String(v), 'hex');
  };
  return { encryptionKey: hex('SUDS_ENCRYPTION_KEY', true), indexKey: hex('SUDS_INDEX_KEY', true), backupKey: hex('SUDS_BACKUP_KEY', false) };
}
const fingerprint = (buf) => crypto.createHash('sha256').update(Buffer.concat([Buffer.from('suds-drill-key:'), buf])).digest('hex').slice(0, 12);

// ---- stale drill copies ----
// A drill decrypts a backup into <data>/.dr-drill/drill-*/ and removes it when it finishes. A process that
// dies mid-drill (a crash, a kill, a power cut) leaves a plaintext copy of the whole database behind. Every
// drill directory carries owner.json (pid, start time); one whose owner is gone, or that is older than any
// drill can run, is overwritten and removed -- at startup and before every drill. Plaintext temporary copies
// (.backup-*.db, .inspect-*.db) left in the data directory the same way are swept too, once an hour old.
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } }
function sweepStale({ now = Date.now(), except = null } = {}) {
  const backup = require('./backup');
  const root = path.join(config.dataDir, '.dr-drill');
  const out = { removed: [], files: 0 };
  let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch {}
  for (const d of dirs) {
    if (except && path.resolve(d) === path.resolve(except)) continue;
    let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(d, 'owner.json'), 'utf8')); } catch {}
    let age = 0; try { age = now - fs.statSync(d).mtimeMs; } catch {}
    // This process's own drill directory is live only while that drill is running.
    const mineIdle = owner && owner.pid === process.pid && !current;
    const orphaned = owner ? (mineIdle || !pidAlive(owner.pid) || now - Date.parse(owner.started_at) > CHILD_TIMEOUT_MS * 2) : age > 60_000;
    if (!orphaned) continue;
    out.files += backup.secureRemoveDir(d);
    out.removed.push(path.basename(d));
  }
  let loose = []; try { loose = fs.readdirSync(config.dataDir).filter((f) => /^\.(backup|inspect)-\d+-[0-9a-f]+\.db(-wal|-shm|-journal)?$/.test(f)); } catch {}
  for (const f of loose) {
    const p = path.join(config.dataDir, f);
    let age = 0; try { age = now - fs.statSync(p).mtimeMs; } catch { continue; }
    if (age > 3600_000 && backup.secureUnlink(p)) { out.removed.push(f); out.files++; }
  }
  if (out.removed.length) {
    console.warn(`[suds] removed ${out.removed.length} stale decrypted copy(ies) left by an interrupted drill or backup: ${out.removed.join(', ')}`);
    try { audit.log({ user: { username: 'system' }, action: 'dr.drill.swept', details: { removed: out.removed.slice(0, 20), files: out.files } }); } catch {}
  }
  return out;
}

function targets() {
  const num = (k, d) => { const v = Number(db.getSetting(k, '')); return Number.isFinite(v) && v > 0 ? v : d; };
  // The default RPO target is the interval actually configured: the snapshot interval when snapshots run.
  const r = require('./scheduled-backup').rpo();
  return { rto_minutes: num('dr_rto_target_minutes', 60), rpo_hours: num('dr_rpo_target_hours', r ? Math.round(r.minutes / 60 * 1000) / 1000 : 24) };
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

const { canonical } = require('./dr-report');
// Signed with the Ed25519 signing key (server/signing.js), which anyone can check with the public key alone
// (npm run verify-dr-report); the HMAC under the index key is kept for checks on the server itself.
function seal(report, key = config.indexKey) {
  const body = canonical(report);
  const signing = require('./signing');
  const pub = signing.publicInfo();
  return { sha256: crypto.createHash('sha256').update(body).digest('hex'), hmac_sha256: crypto.createHmac('sha256', key).update(body).digest('hex'),
    ed25519_signature: signing.sign(body), signing_key_id: pub.key_id, public_key_pem: pub.public_key_pem,
    algorithm: 'SHA-256, HMAC-SHA256 (index key) and an Ed25519 signature (signing key) over the canonical JSON of "report" (keys sorted)' };
}
/** Check a written report: { report, integrity } → true when the digest, the HMAC and the signature all match. */
function verifyReport(doc, key = config.indexKey) {
  if (!doc || !doc.integrity) return false;
  const s = seal(doc.report, key);
  const signed = require('./dr-report').verifyDoc(doc, { publicKeyPem: require('./signing').publicInfo().public_key_pem });
  return s.sha256 === doc.integrity.sha256 && s.hmac_sha256 === doc.integrity.hmac_sha256 && signed.ok;
}

function runChild(tmp, dbFile, onStep, keys = { enc: config.encryptionKey, idx: config.indexKey }) {
  const { fork } = require('node:child_process');
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH || '', SUDS_ENV: config.isTest ? 'test' : 'production', SUDS_DATA_DIR: tmp, SUDS_DB_PATH: dbFile, SUDS_SKIP_SETUP: '1', TZ: process.env.TZ || '', LOG_FORMAT: 'text', LOGIN_RATE_LIMIT: '1000',
      // The live server's anchor directory, read (never written) by the copy's anchor check. Named here so the
      // copy's /api/health does not report the placement of its own (unused) default directory.
      AUDIT_ANCHOR_DIR: config.auditAnchorDir };
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
    child.send({ keys: { enc: keys.enc.toString('hex'), idx: keys.idx.toString('hex'), sig: config.signingKey.toString('hex') }, anchorDir: config.auditAnchorDir });
  });
}

/**
 * Run a drill. Resolves to the report document ({ report, integrity, files }). Rejects only when a drill is
 * already running; every other failure is a failed drill, recorded like a passed one.
 */
/**
 * `keysFile` / `keysText`: the escrowed key backup (a path, or its contents as uploaded from Settings). When
 * given, the backup is decrypted and the copy is started with those keys only -- so a pass proves the keys
 * the county holds offline open the backup, not merely the keys this process already has in memory.
 * `copy`: 'auto' (the offsite copy when an offsite directory is configured, else the local one), 'offsite'
 * or 'local'.
 */
async function run({ backupFile = null, fresh = false, by = 'system', trigger = 'manual', record = true, keysFile = null, keysText = null, keysLabel = null, copy = 'auto' } = {}) {
  if (current) { const e = new Error('A recovery drill is already running'); e.code = 'EBUSY'; throw e; }
  const job = current = { started_at: new Date().toISOString(), by, steps: [] };
  const step = (s) => { job.steps.push({ at: new Date().toISOString(), step: s }); };
  const started = Date.now();
  const tmpRoot = path.join(config.dataDir, '.dr-drill');
  const tmp = path.join(tmpRoot, `drill-${started}-${crypto.randomBytes(4).toString('hex')}`);
  const failures = [];
  let result = { checks: [] }; let file = backupFile; let madeBackup = false; let restoreStarted = null; let restoreBytes = 0;
  const sched = require('./scheduled-backup').settings();
  let source = { copy: backupFile ? 'given' : null, dir: backupFile ? path.dirname(backupFile) : null, offsite_configured: !!sched.offsiteDir };
  let keyInfo = { source: 'server memory', note: 'the keys this server process holds; run with an escrowed key file to prove the offline copy of the keys' };
  let escrow = null;
  try {
    // Copies a previous drill left behind (a crash mid-drill) are removed before a new one is made.
    try { sweepStale({ except: tmp }); } catch {}
    if (keysFile || (keysText !== null && keysText !== undefined)) {
      const uploaded = keysText !== null && keysText !== undefined;
      escrow = parseKeysFile(uploaded ? keysText : fs.readFileSync(keysFile, 'utf8'));
      keyInfo = { source: uploaded ? 'uploaded escrow file' : 'escrow file', file: keysLabel || (keysFile ? path.basename(keysFile) : null),
        encryption_key_fingerprint: fingerprint(escrow.encryptionKey), index_key_fingerprint: fingerprint(escrow.indexKey), backup_key: !!escrow.backupKey,
        same_as_running_server: escrow.encryptionKey.equals(config.encryptionKey) && escrow.indexKey.equals(config.indexKey) };
      step(`Using the escrowed keys from ${keyInfo.file || 'the uploaded file'}, not the keys in this server's memory`);
    }
    // Which backup. A drill restores what a disaster would leave the county with: the newest copy that
    // would survive the loss of this server -- the offsite copy when there is one. Only when there is none
    // (or when asked) is one made first.
    if (!file && !fresh) {
      if (copy === 'offsite' || (copy === 'auto' && sched.offsiteDir)) {
        let st = null; try { st = sched.offsiteDir ? fs.statSync(sched.offsiteDir) : null; } catch {}
        const off = st && st.isDirectory() ? latestBackup(sched.offsiteDir) : null;
        if (off) { file = off; source = { ...source, copy: 'offsite', dir: sched.offsiteDir }; }
        else {
          failures.push(!sched.offsiteDir ? 'an offsite copy was asked for but no offsite directory is configured' : !st ? `the offsite directory ${sched.offsiteDir} is not reachable (is the share mounted?), so the offsite copy could not be restored` : `the offsite directory ${sched.offsiteDir} holds no backup`);
          step('The offsite copy is not available; restoring the local copy instead');
        }
      }
      if (!file) { file = latestBackup(); if (file) source = { ...source, copy: 'local', dir: backupsDir() }; }
    }
    if (!file) {
      step('No backup on disk; taking one first');
      const made = require('./scheduled-backup').run({ retain: sched.retain, offsiteDir: sched.offsiteDir });
      if (!made.file) throw new Error(`a backup could not be taken: ${made.error}`);
      madeBackup = true;
      if (made.offsiteFile && copy !== 'local') { file = made.offsiteFile; source = { ...source, copy: 'offsite', dir: sched.offsiteDir }; }
      else { file = made.file; source = { ...source, copy: 'local', dir: backupsDir() }; }
    }
    step(`Restoring ${path.basename(file)} (${source.copy} copy)`);
    restoreStarted = Date.now();
    const enc = fs.readFileSync(file);
    const plain = require('./backup').decrypt(enc, escrow ? { escrow } : {});
    restoreBytes = plain.length;
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(tmpRoot, 0o700); } catch {}
    fs.writeFileSync(path.join(tmp, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date(started).toISOString() }), { mode: 0o600 });
    const dbFile = path.join(tmp, 'suds.db');
    fs.writeFileSync(dbFile, plain, { mode: 0o600 });
    plain.fill(0);
    result = await runChild(tmp, dbFile, step, escrow ? { enc: escrow.encryptionKey, idx: escrow.indexKey } : undefined);
    if (result.error) failures.push(result.error);
  } catch (e) {
    failures.push(String(e && e.message || e));
  } finally {
    // Overwritten, not just unlinked: the copy is the whole database in the clear.
    try { require('./backup').secureRemoveDir(tmp); if (fs.existsSync(tmp)) throw new Error('it is still there'); } catch (e) { failures.push(`the drill copy could not be removed from ${tmp}: ${e.message}`); }
  }
  const extraChecks = [];
  if (escrow) extraChecks.push({ name: 'The escrowed key file opens the backup', ok: restoreBytes > 0, detail: `${keyInfo.source}${keyInfo.file ? ` ${keyInfo.file}` : ''}; encryption key ${keyInfo.encryption_key_fingerprint}, index key ${keyInfo.index_key_fingerprint}` });
  if (source.offsite_configured && copy !== 'local') extraChecks.push({ name: 'The offsite copy was restored', ok: source.copy === 'offsite' || source.copy === 'given', detail: source.copy === 'offsite' ? source.dir : source.copy === 'given' ? 'a backup file was named explicitly' : 'the local copy was restored instead' });
  if (extraChecks.length) result.checks = [...extraChecks, ...(result.checks || [])];
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
    signed_by: { algorithm: 'Ed25519', key_id: require('./signing').publicInfo().key_id },
    ok: failures.length === 0 && checks.length > 0,
    started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(), trigger, by,
    server: { version: config.version, host: require('node:os').hostname(), schema_version: db.LATEST_SCHEMA_VERSION },
    backup: { file: file ? path.basename(file) : null, copy: source.copy, dir: source.dir, offsite_configured: source.offsite_configured, taken_at: taken ? new Date(taken).toISOString() : null, made_for_drill: madeBackup, decrypted_bytes: restoreBytes, latest_record_at: result.latest_audit_at || null },
    keys: keyInfo,
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
    const summary = { at: report.finished_at, ok: report.ok, rto_seconds: rtoSeconds, rpo_seconds: rpoSeconds, rto_target_minutes: t.rto_minutes, rpo_target_hours: t.rpo_hours, backup_file: report.backup.file, backup_copy: source.copy, keys_source: keyInfo.source, backup_taken_at: report.backup.taken_at, report_file: files.json || null, sha256: doc.integrity.sha256, failures: failures.slice(0, 5), checks_passed: checks.filter((c) => c.ok).length, checks_total: checks.length, trigger };
    db.setSetting('dr_last_drill', JSON.stringify(summary));
    audit.log({ user: typeof by === 'object' ? by : { username: String(by) }, action: 'dr.drill', success: report.ok, details: { trigger, backup: report.backup.file, copy: source.copy, keys: keyInfo.source, rto_seconds: rtoSeconds, rpo_seconds: rpoSeconds, checks_passed: summary.checks_passed, checks_total: summary.checks_total, report: files.json || null, sha256: doc.integrity.sha256 } });
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
  L.push(`Backup restored: ${r.backup.file || 'none'}${r.backup.copy ? ` — the ${r.backup.copy} copy${r.backup.dir ? ` in ${r.backup.dir}` : ''}` : ''}${r.backup.taken_at ? ` (taken ${r.backup.taken_at})` : ''}${r.backup.made_for_drill ? ' — made for this drill, no earlier backup was on disk' : ''}`);
  if (r.keys) L.push(`Keys used: ${r.keys.source}${r.keys.file ? ` (${r.keys.file})` : ''}${r.keys.source === 'server memory' ? ' — this does not prove the escrowed key backup works; run the drill with the key file (--keys-file)' : ''}`);
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
  if (integrity.ed25519_signature) {
    L.push(`           Ed25519 signature ${integrity.ed25519_signature}`);
    L.push(`           signing key ${integrity.signing_key_id} (public key published at GET /api/admin/security/signing-key)`);
    L.push('Verify with the public key only: npm run verify-dr-report -- <the .json report> --public-key <signing-key.pem>');
  }
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

module.exports = { run, start, runIfDue, status, lastDrill, latestBackup, backupTime, verifyReport, canonical, seal, textReport, targets, parseKeysFile, sweepStale };
