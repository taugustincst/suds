'use strict';
// App-level checks for scripts/compliance-check.js. The app's own controls are read through the same code as
// Settings → Security status (server/security-status.js status(), mapped by server/compliance-rules.js), on
// a READ-ONLY connection to a private copy of the live database (server/db.js openReadOnly; safe-fs.js snapshotDb): nothing is migrated or written,
// and the server holding the database is not disturbed. Three checks go further than the page, because a
// weekly evidence run should re-verify rather than repeat what was recorded: the audit chain and its
// external anchors are verified now (server/audit.js verifyChain, server/audit-anchor.js verify), the last
// recovery drill's signed report is checked with the signing key (server/dr-report.js), and the backup files
// themselves are looked at, locally and on the offsite share.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DAY = 86400_000;
const KEY_VARS = ['SUDS_ENCRYPTION_KEY', 'SUDS_INDEX_KEY', 'SUDS_SIGNING_KEY', 'SUDS_BACKUP_KEY'];

/**
 * Before server/config.js is required: find each key where the service would (the environment, a *_FILE, the
 * systemd credential store, keys.json) and, for any this user cannot read, put a random stand-in in the
 * environment so config.js neither refuses to load nor writes a key file of its own. A stand-in key is never
 * used to verify or sign anything: the checks that need that key report "could not check".
 */
function prepareEnv(conf, env = process.env) {
  const avail = {};
  if (env.SUDS_ENV === 'test') { for (const k of KEY_VARS) avail[k] = 'test'; return avail; }
  env.SUDS_ENV = env.SUDS_ENV || 'production';
  if (conf.dataDir && !env.SUDS_DATA_DIR) env.SUDS_DATA_DIR = conf.dataDir;
  if (conf.anchorDir && !env.AUDIT_ANCHOR_DIR) env.AUDIT_ANCHOR_DIR = conf.anchorDir;
  let keysJson = null;
  try { keysJson = JSON.parse(fs.readFileSync(path.join(env.SUDS_DATA_DIR || conf.dataDir, 'keys.json'), 'utf8')); } catch {}
  for (const k of KEY_VARS) {
    const readable = (f) => { try { return /^[0-9a-fA-F]{64}$/.test(fs.readFileSync(f, 'utf8').trim()); } catch { return false; } };
    if (env[k]) { avail[k] = 'environment'; continue; }
    if (env[`${k}_FILE`] && readable(env[`${k}_FILE`])) { avail[k] = 'credential file'; continue; }
    const cred = conf.credentialsDir && path.join(conf.credentialsDir, k.toLowerCase());
    if (cred && readable(cred)) { env[`${k}_FILE`] = cred; avail[k] = 'credential store'; continue; }
    if (keysJson && /^[0-9a-fA-F]{64}$/.test(String(keysJson[k] || ''))) { avail[k] = 'keys.json'; continue; }
    avail[k] = null;
    delete env[`${k}_FILE`];
    if (k !== 'SUDS_BACKUP_KEY') env[k] = crypto.randomBytes(32).toString('hex');
  }
  return avail;
}

/** Security status lines → compliance checks (the app side of the one list). */
function fromStatus(st) {
  const rules = require('../../server/compliance-rules');
  const out = [];
  for (const i of st.items) {
    const entry = rules.forItem(i.name);
    if (entry.inAppOnly || String(i.group).startsWith('Host')) continue;
    out.push({ id: entry.id, title: `${i.group}: ${i.name}`, result: rules.resultOfLevel(i.level, entry), evidence: [i.value, i.detail].filter(Boolean).join(' — '), source: 'app' });
  }
  return out;
}

const nc = (id, evidence) => ({ id, result: 'not-checked', evidence, source: 'app' });

/** Hours since SUDS Server was installed (suds-server.conf SUDS_INSTALLED_AT), or null when unknown. */
function installedHoursAgo(conf, now) {
  const t = Date.parse((conf && conf.installedAt) || '');
  return Number.isFinite(t) ? (now - t) / 3600_000 : null;
}
const PENDING = require('../../server/compliance-rules').PENDING_FIRST_RUN; // pure data: safe before prepareEnv

function backupFiles({ config, db, now, conf }) {
  const id = 'host.backup_files';
  const sb = require('../../server/scheduled-backup');
  const s = sb.settings();
  const policyH = s.hours ? 2 * s.hours : 24;
  const local = sb.newest(path.join(config.dataDir, 'backups')); // lstat: a planted symlink is neither followed nor counted
  const bits = []; const bad = [];
  if (local.error === 'ENOENT') bad.push('there is no backups directory: no backup has ever been taken');
  else if (local.error) return nc(id, `the backups directory cannot be read (${local.error})`);
  else if (!local.newest) bad.push('no backup file in the backups directory');
  if (local.newest) { const h = (now - local.newest.mtime) / 3600_000; bits.push(`newest local ${local.newest.file} (${h.toFixed(1)} h old; ${local.count} kept)`); if (h > policyH) bad.push(`the newest local backup is ${h.toFixed(1)} h old (policy ${policyH} h: twice the ${s.hours || 'unset'} h interval)`); }
  if (!s.hours) bad.push('scheduled backups are off');
  if (!s.offsiteDir) bad.push('no offsite directory is configured');
  else if (sb.offsitePlacement(s.offsiteDir).inside) bad.push(`the offsite directory ${s.offsiteDir} ${sb.offsitePlacement(s.offsiteDir).inside}`);
  else {
    const off = sb.newest(s.offsiteDir);
    if (off.error === 'ENOENT') bad.push(`the offsite directory ${s.offsiteDir} does not exist (is the share mounted?)`);
    else if (off.error) return nc(id, `the offsite directory ${s.offsiteDir} cannot be read by this user (${off.error}); ${bits.join('; ')}`);
    else if (!off.newest) bad.push(`no backup on the offsite share ${s.offsiteDir}`);
    else {
      const h = (now - off.newest.mtime) / 3600_000; bits.push(`newest offsite ${off.newest.file} (${h.toFixed(1)} h old, ${off.newest.size} bytes)`);
      if (h > policyH) bad.push(`the newest offsite copy is ${h.toFixed(1)} h old (policy ${policyH} h)`);
      const problem = sb.copyProblem(off.newest.file, off.newest.size); // an empty copy "exists" but is no backup
      if (problem) bad.push(problem);
    }
  }
  void db;
  // A new server has no backup yet: the first scheduled one runs within the interval. Until twice the
  // interval has passed since the install, "nothing yet" is expected, not a failure; anything else is.
  const age = installedHoursAgo(conf, now);
  const firstRunOnly = bad.length && bad.every((b) => /no backup has ever been taken|no backup file in|no backup on the offsite share/.test(b));
  if (firstRunOnly && age !== null && age >= 0 && age < policyH) return { id, result: 'warn', evidence: `${PENDING}: installed ${age.toFixed(1)} h ago, the first scheduled backup is due within ${s.hours || '?'} h [${bad.join('; ')}${bits.length ? `; ${bits.join('; ')}` : ''}]`, source: 'app' };
  return bad.length ?{ id, result: 'fail', evidence: `${bad.join('; ')}${bits.length ? ` [${bits.join('; ')}]` : ''}`, source: 'app' } : { id, result: 'pass', evidence: bits.join('; '), source: 'app' };
}

const DRILL_REPORT_RE = /^dr-drill-[0-9A-Za-z-]+\.json$/;

function drEvidence({ config, now, keys, conf }) {
  const id = 'host.dr_evidence';
  const last = require('../../server/dr-drill').lastDrill();
  if (!last) {
    // The monthly drill runs within a month of the install (after the first backup): until then, expected.
    const age = installedHoursAgo(conf, now);
    if (age !== null && age >= 0 && age < 31 * 24) return { id, result: 'warn', evidence: `${PENDING}: installed ${Math.floor(age / 24)} days ago, no recovery drill yet; the monthly drill runs within a month, or run one now (Settings → System & backups)`, source: 'app' };
    return { id, result: 'fail', evidence: 'no recovery drill has been run', source: 'app' };
  }
  const age = (now - Date.parse(last.at)) / DAY;
  const bits = [`last drill ${last.ok ? 'passed' : 'FAILED'} ${String(last.at).slice(0, 10)} (${Math.floor(age)} days ago), ${last.checks_passed}/${last.checks_total} checks, the ${last.backup_copy || 'local'} copy, keys from ${last.keys_source || 'server memory'}`];
  const bad = [];
  if (!last.ok) bad.push('the last drill failed');
  if (age > 90) bad.push(`older than 90 days`);
  let verified = null;
  if (last.report_file) {
    // The name comes from the database, which the suds user can write: only a bare drill-report name is
    // accepted, the file is read without following a symlink, and a problem is named without its content.
    const name = path.basename(String(last.report_file));
    let doc = null;
    if (name !== String(last.report_file) || !DRILL_REPORT_RE.test(name)) bad.push('the recorded report name is not a drill report file name');
    else {
      try { doc = require('./safe-fs').readJson(path.join(config.dataDir, 'backups', name), { maxBytes: 4 * 1024 * 1024 }); } catch (e) { bad.push(`its report ${name} cannot be read (${e.code === 'ENOENT' ? 'ENOENT' : e.message})`); }
    }
    if (doc) {
      const pem = keys.SUDS_SIGNING_KEY ? require('../../server/signing').publicInfo().public_key_pem : null;
      const v = require('../../server/dr-report').verifyDoc(doc, { publicKeyPem: pem });
      verified = v.ok;
      if (!v.ok) bad.push(`its signed report does not verify: ${v.errors[0]}`);
      else bits.push(`report ${name} verifies${pem ? ' with this server\'s signing key' : ' (embedded key only: the signing key was not available)'}`);
    }
  } else bad.push('the drill wrote no report');
  if (bad.length) return { id, result: 'fail', evidence: `${bad.join('; ')} [${bits.join('; ')}]`, source: 'app' };
  if (!keys.SUDS_SIGNING_KEY && verified) return { id, result: 'warn', evidence: `${bits.join('; ')}; checked against the key embedded in the report, not this server's`, source: 'app' };
  if (!/escrow|file/i.test(last.keys_source || '') || last.backup_copy !== 'offsite') return { id, result: 'warn', evidence: `${bits.join('; ')}; run the next one with the escrowed key file against the offsite copy`, source: 'app' };
  return { id, result: 'pass', evidence: bits.join('; '), source: 'app' };
}

function auditVerify({ keys }) {
  const id = 'host.audit_verify';
  if (!keys.SUDS_INDEX_KEY) return nc(id, 'the index key is not available to this user, so the chain and anchors could not be verified (run as root, or from suds-compliance.service)');
  const chain = require('../../server/audit').verifyChain();
  const anchorMod = require('../../server/audit-anchor');
  const a = anchorMod.verify();
  const place = anchorMod.placementProblem();
  const st = anchorMod.dirStatus();
  const bits = [`chain: ${chain.ok ? `${chain.checked} entries verify` : `BROKEN at entry ${chain.firstBadId || '?'}${chain.reason ? ` (${chain.reason})` : ''}`}`,
    `anchors in ${a.dir}: ${a.total} (${a.matched} matched${a.purged ? `, ${a.purged} before a purge` : ''}${a.other_key ? `, ${a.other_key} under an earlier key` : ''})`];
  const bad = [];
  if (!chain.ok) bad.push('the audit chain does not verify');
  if (!a.ok) bad.push(`an anchor does not match: ${a.bad[0].reason} (${a.bad[0].file})`);
  if (place) bad.push(place);
  else if (!st.configured || st.inside_data_dir) bad.push('AUDIT_ANCHOR_DIR is not set to a directory outside the data directory');
  if (!st.exists) bad.push(`${a.dir} does not exist (is the WORM share mounted?)`);
  if (bad.length) return { id, result: 'fail', evidence: `${bad.join('; ')} [${bits.join('; ')}]`, source: 'app' };
  if (!a.total) return { id, result: 'warn', evidence: `${bits.join('; ')}; no anchor written yet`, source: 'app' };
  return { id, result: 'pass', evidence: bits.join('; '), source: 'app' };
}

/**
 * Load the app read-only and run every app-level check. `keys` is prepareEnv()'s answer. Returns
 * { checks, signingSeed (null unless the real key is available), version, updateFeedUrl }.
 */
function run({ keys, now = Date.now(), conf = {} }) {
  const config = require('../../server/config');
  const db = require('../../server/db');
  // Never opened in place: SQLite would create -wal/-shm files beside a WAL database for a reader, and as
  // root they would be root's (SUDS could not open its own database) or, through a symlink the suds user
  // planted, anyone's. The database and its write-ahead log are copied through descriptors into a private
  // directory (PrivateTmp= in suds-compliance.service) and the copy is opened.
  let snap = null;
  if (config.dbPath !== ':memory:') {
    if (!fs.existsSync(config.dbPath)) throw Object.assign(new Error(`no database at ${config.dbPath}`), { code: 'NODB' });
    snap = require('./safe-fs').snapshotDb(config.dbPath);
  }
  db.openReadOnly(snap ? snap.file : config.dbPath);
  try {
    const st = require('../../server/security-status').status({ host: false });
    const checks = fromStatus(st);
    for (const f of [backupFiles, drEvidence, auditVerify]) {
      try { checks.push(f({ config, db, now, keys, conf })); } catch (e) { checks.push(nc(f === backupFiles ? 'host.backup_files' : f === drEvidence ? 'host.dr_evidence' : 'host.audit_verify', `the check itself failed: ${e.message}`)); }
    }
    return { checks, signingSeed: keys.SUDS_SIGNING_KEY ? config.signingKey : null, version: config.version, updateFeedUrl: config.updateFeedUrl, isProd: config.isProd };
  } finally {
    try { db.close(); } catch {}
    if (snap) { try { require('../../server/backup').secureRemoveDir(snap.dir); } catch { fs.rmSync(snap.dir, { recursive: true, force: true }); } }
  }
}

module.exports = { prepareEnv, fromStatus, run, backupFiles, drEvidence, auditVerify, installedHoursAgo, KEY_VARS };
