'use strict';
// SUDS Server compliance check: does this host, and the SUDS running on it, match the hardening policy
// (docs/SELF-HOSTING.md)? Host checks (disk encryption, permissions, keys, the unit's sandboxing, TLS,
// firewall, time sync, security updates, journald, versions: scripts/compliance/host-checks.js) and the
// app's own controls, read through the Settings → Security status code on a read-only database connection
// (scripts/compliance/app-checks.js). Each check names the HIPAA Security Rule / 42 CFR Part 2 / CMIA rule
// it produces evidence for (server/compliance-rules.js).
//
// Writes a JSON report and a self-contained HTML report, both signed (Ed25519). On SUDS Server the key is the
// compliance check's own, /etc/suds/compliance-signing-key (root 0600, never handed to suds.service), and the
// reports go to /var/lib/suds-compliance (root-owned, readable by the suds group), so the service being audited
// can neither write nor sign its own report; SUDS verifies them with the public half
// (/etc/suds/compliance-signing-key.pub.pem). Without that configuration (a wizard or Docker install) they are
// signed with the server's evidence signing key (server/signing.js) and written to <data dir>/compliance/.
// Settings → Security status shows the last one. An auditor verifies either file with the public key alone:
// npm run verify-compliance-report -- <file> --public-key <pem>.
//
// Run as root, it never follows a path the suds user controls: reports are created with O_EXCL|O_NOFOLLOW and
// changed through their descriptors, and the database is read from a private copy, never opened in place
// (scripts/compliance/safe-fs.js).
//
// Usage (as root for every check; as the suds user the root-only ones say "could not check"):
//   npm run compliance-check                      # human summary; reports in <data>/compliance/
//   npm run compliance-check -- --json            # the signed JSON document on stdout
//   npm run compliance-check -- --out /mnt/evidence/suds
//   options: --config <file> (default /etc/suds/suds-server.conf), --domain <name>, --connect-host <addr>,
//            --tls-port <n>, --http-port <n>, --ca <pem>, --latest-version <x.y.z>, --offline, --no-app,
//            --no-host, --no-write, --strict (exit 2 on any warning or could-not-check), --signing-key <file>,
//            --data-dir <dir>, --root <dir> (tests). An unknown option is an error (exit 2).
// Exit status: 1 if any check failed; 0 otherwise (2 with --strict when anything was not a pass).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_DIR = path.join(__dirname, '..');

const VALUED = ['--config', '--domain', '--connect-host', '--tls-port', '--http-port', '--ca', '--latest-version', '--out', '--root', '--data-dir', '--signing-key'];
const FLAGS = ['--json', '--offline', '--no-app', '--no-host', '--no-write', '--strict', '--help', '-h'];
function parseArgs(argv) {
  const a = { flags: new Set(), opts: {}, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], null];
    if (VALUED.includes(k)) { const val = v !== null ? v : argv[++i]; if (val === undefined || val === '') a.errors.push(`${k} needs a value`); else a.opts[k.slice(2)] = val; }
    else if (FLAGS.includes(k) && v === null) a.flags.add(k);
    else a.errors.push(`unknown option ${argv[i]}`);
  }
  return a;
}

/** The installer's non-secret settings (/etc/suds/suds-server.conf), overridden by flags. */
function loadConf(args, env = process.env) {
  const hc = require('./compliance/host-checks');
  const root = args.opts.root || env.SUDS_COMPLIANCE_ROOT || '/';
  const file = args.opts.config || path.join(root, 'etc/suds/suds-server.conf');
  let f = {}; let found = false;
  try { f = hc.parseKv(fs.readFileSync(file, 'utf8')); found = true; } catch {}
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
  const tlsMode = f.SUDS_TLS_MODE || 'caddy';
  return {
    file, found, root,
    domain: args.opts.domain || f.SUDS_DOMAIN || '',
    connectHost: args.opts['connect-host'] || f.SUDS_CONNECT_HOST || '',
    tlsPort: num(args.opts['tls-port'], 443), httpPort: num(args.opts['http-port'], 80),
    caFile: args.opts.ca || f.SUDS_CA_FILE || '',
    tlsMode,
    adminCidr: f.SUDS_ADMIN_CIDR || '',
    dataDir: args.opts['data-dir'] || f.SUDS_DATA_DIR || env.SUDS_DATA_DIR || '/var/lib/suds',
    anchorDir: f.SUDS_ANCHOR_DIR || env.AUDIT_ANCHOR_DIR || '',
    offsiteDir: f.SUDS_OFFSITE_DIR || '',
    credentialsDir: f.SUDS_CREDENTIALS_DIR || '/etc/suds/credentials',
    complianceDir: f.SUDS_COMPLIANCE_DIR || '',
    complianceKeyFile: f.SUDS_COMPLIANCE_SIGNING_KEY_FILE || '',
    installedAt: f.SUDS_INSTALLED_AT || '',
    releaseChecksumSource: f.SUDS_RELEASE_CHECKSUM_SOURCE || '',
    credentials: (f.SUDS_CREDENTIALS || 'suds_encryption_key suds_index_key suds_backup_key suds_signing_key').split(/\s+/).filter(Boolean),
    logRetentionDays: num(f.SUDS_LOG_RETENTION_DAYS, 400),
    acceptUnencryptedDisk: f.SUDS_ACCEPT_UNENCRYPTED_DISK || '',
    unit: f.SUDS_UNIT || 'suds.service',
    serviceUser: f.SUDS_SERVICE_USER || 'suds',
    appPort: num(f.SUDS_PORT, 8080),
    codeDir: ROOT_DIR,
    nodeBin: f.SUDS_NODE_BIN || process.execPath,
    sudsVersion: pkg.version,
    latestVersion: args.opts['latest-version'] || '',
  };
}

/** The signing key without loading the app (--no-app): SUDS_SIGNING_KEY, its _FILE, or the credential store. */
function signingSeedDirect(conf, env = process.env) {
  const hex = env.SUDS_SIGNING_KEY || (() => { for (const f of [env.SUDS_SIGNING_KEY_FILE, path.join(conf.credentialsDir, 'suds_signing_key')]) { try { if (f) return fs.readFileSync(f, 'utf8').trim(); } catch {} } return ''; })();
  return /^[0-9a-fA-F]{64}$/.test(hex || '') ? Buffer.from(hex, 'hex') : null;
}

/**
 * The key that signs the report: the compliance check's own key when one is configured (suds-server.conf
 * SUDS_COMPLIANCE_SIGNING_KEY_FILE, or --signing-key) — then there is no fallback, and an unreadable key
 * leaves the report unsigned — else the SUDS service's evidence signing key. { seed, source, error }.
 */
function reportSigner(conf, args, appSeed, env = process.env) {
  const file = args.opts['signing-key'] || conf.complianceKeyFile;
  if (file) {
    try {
      const hex = require('./compliance/safe-fs').readRegular(file, { maxBytes: 4096 }).toString('utf8').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { seed: null, source: 'compliance', error: `${file} is not 64 hex characters` };
      return { seed: Buffer.from(hex, 'hex'), source: 'compliance' };
    } catch (e) { return { seed: null, source: 'compliance', error: `${file} cannot be read (${e.message})` }; }
  }
  return { seed: appSeed || signingSeedDirect(conf, env), source: 'service' };
}

/** A check that needs a key this user could not read reports "could not check", never the stand-in's answer. */
function markStandIns(checks, keys) {
  const need = { 'app.phi_key': 'SUDS_ENCRYPTION_KEY', 'app.signing_key': 'SUDS_SIGNING_KEY', 'app.index_key': 'SUDS_INDEX_KEY' };
  for (const c of checks) {
    if (need[c.id] && !keys[need[c.id]]) { c.result = 'not-checked'; c.evidence = `the key is not readable by this user, so it was not checked (${c.evidence})`; }
  }
  return checks;
}

/** The primary gid of a user in <root>/etc/passwd, or null. */
function gidOf(root, user) {
  try {
    for (const line of fs.readFileSync(path.join(root || '/', 'etc/passwd'), 'utf8').split('\n')) { const f = line.split(':'); if (f[0] === user && f.length > 3) return Number(f[3]); }
  } catch {}
  return null;
}

/**
 * How the reports are written. Run as root: into a directory owned by the expected owner — the data
 * directory's owner for <data>/compliance, root anywhere else (SUDS Server's /var/lib/suds-compliance, 0750
 * root:suds) — with the files handed over through their descriptors (0600 to the data directory's owner, or
 * 0640 root:suds). As any other user: its own files, 0600, in a 0700 directory.
 */
function writePlan(outDir, conf, { uid = process.getuid ? process.getuid() : -1 } = {}) {
  if (uid !== 0) return { expectUid: null, dirMode: 0o700, fileMode: 0o600, uid: null, gid: null, dirOwner: null };
  if (path.dirname(path.resolve(outDir)) === path.resolve(conf.dataDir)) {
    const st = fs.lstatSync(conf.dataDir);
    if (!st.isDirectory()) throw new Error(`${conf.dataDir} is not a directory`);
    return { expectUid: st.uid, dirMode: 0o700, fileMode: 0o600, uid: st.uid, gid: st.gid, dirOwner: [st.uid, st.gid] };
  }
  const gid = gidOf(conf.root, conf.serviceUser);
  return { expectUid: 0, dirMode: 0o750, fileMode: gid === null ? 0o600 : 0o640, uid: 0, gid, dirOwner: [0, gid] };
}

/** Make the directory if it is missing and write each { name: content } as a new file, per the plan. */
function writeReports(outDir, files, plan) {
  const sf = require('./compliance/safe-fs');
  let missing = false;
  try { fs.lstatSync(outDir); } catch (e) { if (e.code !== 'ENOENT') throw e; missing = true; }
  if (missing) {
    fs.mkdirSync(path.dirname(path.resolve(outDir)), { recursive: true, mode: 0o755 });
    // Made just now, so ours: handed to the planned owner through its descriptor, then checked like any other.
    const d0 = sf.openDir(outDir, { create: true, mode: plan.dirMode });
    try { if (plan.dirOwner) fs.fchownSync(d0.fd, plan.dirOwner[0], plan.dirOwner[1] === null ? -1 : plan.dirOwner[1]); fs.fchmodSync(d0.fd, plan.dirMode); } finally { sf.closeDir(d0); }
  }
  const d = sf.openDir(outDir, { expectUid: plan.expectUid });
  const out = [];
  try { for (const [name, data] of Object.entries(files)) out.push(sf.writeNew(d, name, data, { mode: plan.fileMode, uid: plan.uid, gid: plan.gid })); } finally { sf.closeDir(d); }
  return out;
}

function runAs() {
  try { const u = os.userInfo(); return u.uid === 0 ? 'root' : `${u.username} (uid ${u.uid}; checks that need root say "could not check")`; } catch { return 'unknown'; }
}

/** Put the host and app results in catalogue order, with the catalogue's title, rules and remediation. */
function assemble(results, { appRan, hostRan, appError, appSkipped = false }) {
  const rules = require('../server/compliance-rules');
  const byId = new Map(results.map((r) => [r.id, r]));
  const out = [];
  const withMeta = (r, entry, title) => ({ id: r.id, title: title || entry.title, result: rules.RESULTS.includes(r.result) ? r.result : 'not-checked', rules: rules.cite(entry.rules), evidence: String(r.evidence || '').replace(/\s+/g, ' ').trim(), remediation: entry.remediation || '', ...(r.risk_accepted ? { risk_accepted: true } : {}) });
  for (const entry of rules.HOST_CHECKS) {
    const r = byId.get(entry.id);
    const live = ['host.backup_files', 'host.dr_evidence', 'host.audit_verify'].includes(entry.id);
    const why = appSkipped ? 'app checks skipped (--no-app)' : `the app could not be read${appError ? `: ${appError}` : ''}`;
    out.push(withMeta(r || { id: entry.id, result: 'not-checked', evidence: live ? (appRan ? 'not run' : why) : hostRan ? 'not run' : 'host checks skipped (--no-host)' }, entry));
    byId.delete(entry.id);
  }
  // App lines in the order Security status gives them; any catalogue line it did not produce is shown as not checked.
  const seen = new Set();
  for (const r of results.filter((x) => x.source === 'app' && byId.has(x.id))) { const entry = rules.byId.get(r.id) || { rules: [], remediation: '' }; out.push(withMeta(r, entry, r.title)); seen.add(r.id); }
  for (const entry of rules.APP_CHECKS) {
    if (entry.inAppOnly || seen.has(entry.id)) continue;
    if (appRan && entry.id === 'app.key_backup') continue; // only shown for a keys.json install
    if (appRan && entry.id === 'app.idp_mfa') continue; // only shown when SSO is configured
    out.push(withMeta({ id: entry.id, result: 'not-checked', evidence: appRan ? 'not reported by this installation' : appSkipped ? 'app checks skipped (--no-app)' : `the app could not be read${appError ? `: ${appError}` : ''}` }, entry, `App: ${entry.item}`));
  }
  return out;
}

const SCOPE = 'This report covers the technical safeguards SUDS Server can observe on this host and in this installation. It does not, and no software can, show that the organisation is compliant: the risk analysis (45 CFR §164.308(a)(1)(ii)(A)), workforce training and sanctions, contingency-plan approval, business associate agreements, facility access, workstation and media controls, incident-response procedures and policy documentation are the organisation\'s (docs/SELF-HOSTING.md, "Compliance boundary"). "Could not check" is never counted as a pass.';

async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, run } = {}) {
  const args = parseArgs(argv);
  if (args.errors.length) { stderr.write(`[compliance-check] ${args.errors.join('; ')} (see --help)\n`); return 2; }
  if (args.flags.has('--help') || args.flags.has('-h')) { stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') + '\n'); return 0; }
  const conf = loadConf(args, env);
  const hc = require('./compliance/host-checks');
  const now = Date.now();
  const results = [];
  let appRan = false; let appError = null; let seed = null; let keys = {};

  // App first: loading the app gives the signing key and the release feed for the host version check.
  if (!args.flags.has('--no-app')) {
    const ac = require('./compliance/app-checks');
    try {
      if (env.SUDS_ENV !== 'test' && !fs.existsSync(conf.dataDir)) throw new Error(`${conf.dataDir} does not exist`);
      keys = ac.prepareEnv(conf, env);
      const app = ac.run({ keys, now, conf });
      appRan = true; seed = app.signingSeed;
      for (const c of markStandIns(app.checks, keys)) results.push(c);
      if (!conf.latestVersion && app.updateFeedUrl && !args.flags.has('--offline')) {
        try { const u = await require('../server/update').checkForUpdate(); conf.latestVersion = u.latest; } catch (e) { conf.latestError = String(e.message || e).slice(0, 200); }
      }
    } catch (e) { appError = String(e.message || e).slice(0, 300); }
  }
  const signer = reportSigner(conf, args, seed, env);

  const hostRan = !args.flags.has('--no-host');
  if (hostRan) {
    const ctx = { root: conf.root, run: run || hc.realRun, now, conf };
    for (const r of await hc.run(ctx)) results.push({ ...r, source: 'host' });
  }

  const cr = require('../server/compliance-report');
  const checks = assemble(results, { appRan, hostRan, appError, appSkipped: args.flags.has('--no-app') });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const osName = hc.osInfo({ root: conf.root }).pretty;
  const report = {
    format: cr.FORMAT, version: 1, report_id: `compliance-${stamp}`, generated_at: new Date(now).toISOString(),
    host: { hostname: os.hostname(), os: osName, suds_version: conf.sudsVersion, node_version: process.version, run_as: runAs(), signed_with: signer.source === 'compliance' ? 'the compliance check\'s own key (root-only)' : 'the SUDS service\'s evidence signing key' },
    config: { config_file: conf.found ? conf.file : null, domain: conf.domain || null, tls_mode: conf.tlsMode, data_dir: conf.dataDir, anchor_dir: conf.anchorDir || null, offsite_dir: conf.offsiteDir || null, admin_cidr: conf.adminCidr || null, log_retention_days: conf.logRetentionDays, keys_available: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v ? 'yes' : 'no'])) },
    risk_accepted: checks.filter((c) => c.risk_accepted).map((c) => `${c.title}: ${c.evidence}`),
    checks,
    summary: { counts: cr.counts(checks), overall: cr.overall(checks) },
    scope: SCOPE,
  };
  const doc = { report, integrity: cr.seal(report, signer.seed) };
  if (signer.error) stderr.write(`[compliance-check] the report is NOT signed: the compliance signing key ${signer.error}\n`);

  // Written where Security status reads it, unless --no-write.
  const outDir = args.opts.out || conf.complianceDir || path.join(conf.dataDir, 'compliance');
  let written = [];
  if (!args.flags.has('--no-write')) {
    try {
      written = writeReports(outDir, { [`${report.report_id}.json`]: JSON.stringify(doc, null, 2) + '\n', [`${report.report_id}.html`]: cr.renderHtml(doc) }, writePlan(outDir, conf));
    } catch (e) { stderr.write(`[compliance-check] the report could not be written to ${outDir}: ${e.message}\n`); }
  }

  if (args.flags.has('--json')) stdout.write(JSON.stringify(doc, null, 2) + '\n');
  else {
    stdout.write(cr.renderText(report));
    stdout.write(doc.integrity.ed25519_signature ? `Signed (Ed25519, ${report.host.signed_with}, key id ${doc.integrity.signing_key_id}).\n` : 'NOT SIGNED: the signing key was not available to this user (run as root, or from suds-compliance.service).\n');
    for (const f of written) stdout.write(`Wrote ${f}\n`);
  }
  const c = report.summary.counts;
  if (c.fail) return 1;
  if (args.flags.has('--strict') && (c.warn || c['not-checked'])) return 2;
  return 0;
}

module.exports = { main, parseArgs, loadConf, assemble, signingSeedDirect, reportSigner, markStandIns, writePlan, writeReports };
if (require.main === module) main().then((code) => { process.exitCode = code; }, (e) => { console.error(`[compliance-check] ${e.stack || e}`); process.exitCode = 1; });
