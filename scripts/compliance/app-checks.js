'use strict';
// App-level checks for scripts/compliance-check.js. The app's own controls are read through the same code as
// Settings → Security status (server/security-status.js status(), mapped by server/compliance-rules.js), on
// a READ-ONLY connection to the live database (server/db.js openReadOnly): nothing is migrated or written,
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

function newestIn(dir, re) {
  let names; try { names = fs.readdirSync(dir).filter((f) => re.test(f)); } catch (e) { return { error: e.code || e.message }; }
  let best = null;
  for (const f of names) { try { const m = fs.statSync(path.join(dir, f)).mtimeMs; if (!best || m > best.mtime) best = { file: f, mtime: m }; } catch {} }
  return { newest: best, count: names.length };
}

function backupFiles({ config, db, now }) {
  const id = 'host.backup_files';
  const sb = require('../../server/scheduled-backup');
  const s = sb.settings();
  const policyH = s.hours ? 2 * s.hours : 24;
  const local = newestIn(path.join(config.dataDir, 'backups'), sb.FILE_RE);
  const bits = []; const bad = [];
  if (local.error === 'ENOENT') bad.push('there is no backups directory: no backup has ever been taken');
  else if (local.error) return nc(id, `the backups directory cannot be read (${local.error})`);
  else if (!local.newest) bad.push('no backup file in the backups directory');
  if (local.newest) { const h = (now - local.newest.mtime) / 3600_000; bits.push(`newest local ${local.newest.file} (${h.toFixed(1)} h old; ${local.count} kept)`); if (h > policyH) bad.push(`the newest local backup is ${h.toFixed(1)} h old (policy ${policyH} h: twice the ${s.hours || 'unset'} h interval)`); }
  if (!s.hours) bad.push('scheduled backups are off');
  if (!s.offsiteDir) bad.push('no offsite directory is configured');
  else {
    const off = newestIn(s.offsiteDir, sb.FILE_RE);
    if (off.error === 'ENOENT') bad.push(`the offsite directory ${s.offsiteDir} does not exist (is the share mounted?)`);
    else if (off.error) return nc(id, `the offsite directory ${s.offsiteDir} cannot be read by this user (${off.error}); ${bits.join('; ')}`);
    else if (!off.newest) bad.push(`no backup on the offsite share ${s.offsiteDir}`);
    else { const h = (now - off.newest.mtime) / 3600_000; bits.push(`newest offsite ${off.newest.file} (${h.toFixed(1)} h old)`); if (h > policyH) bad.push(`the newest offsite copy is ${h.toFixed(1)} h old (policy ${policyH} h)`); }
  }
  void db;
  return bad.length ? { id, result: 'fail', evidence: `${bad.join('; ')}${bits.length ? ` [${bits.join('; ')}]` : ''}`, source: 'app' } : { id, result: 'pass', evidence: bits.join('; '), source: 'app' };
}

function drEvidence({ config, now, keys }) {
  const id = 'host.dr_evidence';
  const last = require('../../server/dr-drill').lastDrill();
  if (!last) return { id, result: 'fail', evidence: 'no recovery drill has been run', source: 'app' };
  const age = (now - Date.parse(last.at)) / DAY;
  const bits = [`last drill ${last.ok ? 'passed' : 'FAILED'} ${String(last.at).slice(0, 10)} (${Math.floor(age)} days ago), ${last.checks_passed}/${last.checks_total} checks, the ${last.backup_copy || 'local'} copy, keys from ${last.keys_source || 'server memory'}`];
  const bad = [];
  if (!last.ok) bad.push('the last drill failed');
  if (age > 90) bad.push(`older than 90 days`);
  let verified = null;
  if (last.report_file) {
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'backups', last.report_file), 'utf8')); } catch (e) { bad.push(`its report ${last.report_file} cannot be read (${e.code || e.message})`); }
    if (doc) {
      const pem = keys.SUDS_SIGNING_KEY ? require('../../server/signing').publicInfo().public_key_pem : null;
      const v = require('../../server/dr-report').verifyDoc(doc, { publicKeyPem: pem });
      verified = v.ok;
      if (!v.ok) bad.push(`its signed report does not verify: ${v.errors[0]}`);
      else bits.push(`report ${last.report_file} verifies${pem ? ' with this server\'s signing key' : ' (embedded key only: the signing key was not available)'}`);
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
function run({ keys, now = Date.now() }) {
  const config = require('../../server/config');
  const db = require('../../server/db');
  if (config.dbPath !== ':memory:' && !fs.existsSync(config.dbPath)) throw Object.assign(new Error(`no database at ${config.dbPath}`), { code: 'NODB' });
  db.openReadOnly(config.dbPath);
  try {
    const st = require('../../server/security-status').status({ host: false });
    const checks = fromStatus(st);
    for (const f of [backupFiles, drEvidence, auditVerify]) {
      try { checks.push(f({ config, db, now, keys })); } catch (e) { checks.push(nc(f === backupFiles ? 'host.backup_files' : f === drEvidence ? 'host.dr_evidence' : 'host.audit_verify', `the check itself failed: ${e.message}`)); }
    }
    return { checks, signingSeed: keys.SUDS_SIGNING_KEY ? config.signingKey : null, version: config.version, updateFeedUrl: config.updateFeedUrl, isProd: config.isProd };
  } finally {
    try { db.close(); } catch {}
    // A reader of a WAL database may create the -wal/-shm pair when SUDS is not running. Run as root, they
    // would be root's, and SUDS (the suds user) could not open its own database at the next start: hand
    // them to the database file's owner.
    if (config.dbPath !== ':memory:' && process.getuid && process.getuid() === 0) {
      try { const o = fs.statSync(config.dbPath); for (const f of [`${config.dbPath}-wal`, `${config.dbPath}-shm`]) { try { const s = fs.statSync(f); if (s.uid !== o.uid) fs.chownSync(f, o.uid, o.gid); } catch {} } } catch {}
    }
  }
}

module.exports = { prepareEnv, fromStatus, run, backupFiles, drEvidence, auditVerify, KEY_VARS };
