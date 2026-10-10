'use strict';
// SUDS Server under its own systemd unit, driven like an administrator would (CI's `service-sandbox` job;
// evaluation of 1.25.4, H4). From 1.18.0 to 1.25.3 every scheduled offsite backup on a real server was an empty
// file: Node's fs.copyFile called fchown(), deploy/linux/suds.service forbids it (SystemCallFilter=~@privileged),
// and the kernel killed SUDS with SIGSYS (status=31/SYS) before a byte was copied. Every test, the dr-drill job and
// the installer runs took their backups outside the unit, so nothing saw it. This check runs the server the way
// deploy/linux/install.sh does, under the unit's whole sandbox, and makes it do what the office does:
//
//   1. lay the host out as install.sh does: the release zip unpacked at /opt/suds/<version> (root-owned, read-only to
//      the service), the pinned Node at /opt/suds/node, the `suds` system account, /var/lib/suds (0700), the keys as
//      root-only files given with LoadCredential=, /etc/suds/suds.env and provision.json (backups every 4 h to the
//      offsite share, online snapshots every 5 minutes, the monthly drill, two-step verification for every role),
//      and two separate filesystems (tmpfs) for the offsite and anchor shares;
//   2. install the release's deploy/linux/suds.service UNCHANGED, plus the drop-in install.sh writes (10-site.conf:
//      the anchor and offsite shares writable), start it, and check that systemd applies the sandbox the unit asks for
//      (systemctl show: User, NoNewPrivileges, ProtectSystem, ..., and a system-call filter that refuses fchown);
//   3. over HTTP on 127.0.0.1:8080, as the first administrator (the generated password from
//      /var/lib/suds/first-admin-password.txt, changed at the first sign-in as SUDS requires): Back up now with the
//      offsite share configured, then the offsite and local copies compared (size and SHA-256); an online snapshot
//      written to the offsite share by the server's own timer; an audit anchor written to the anchor share, and the
//      audit chain verified against the anchors; a recovery drill from the offsite copy; a restore of the offsite copy
//      through Settings' restore (the setting changed after the backup goes back), sign-in again, Back up now again,
//      the chain verified again;
//   4. the service is still active, never restarted (NRestarts=0, the same main PID), stops cleanly, and neither its
//      journal nor the kernel's log shows a process killed by the filter (status=31/SYS, SIGSYS, seccomp type=1326).
// On a failure it prints systemctl status, the unit's journal and the kernel's seccomp lines.
//
//   sudo node scripts/service-sandbox-check.js --disposable-host --release-zip <suds-vX.Y.Z.zip> --node-dir <node dir>
//
// Root, systemd as PID 1, and a DISPOSABLE host only (a CI runner, a throwaway VM): it installs suds.service and
// writes /etc/suds, /opt/suds and /var/lib/suds, and refuses to run where any of them exists already. Node built-ins
// only. The parts that need no systemd (reading the unit, the drop-in, the property and journal checks) are exported
// and tested in test/service-sandbox-check.test.js.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const UNIT = 'suds.service';
// Where install.sh puts things (deploy/linux/lib.sh, deploy/linux/README.md "What it puts where"). The paths the unit
// itself names are checked against it by test/service-sandbox-check.test.js.
const LAYOUT = {
  code: '/opt/suds', data: '/var/lib/suds', etc: '/etc/suds', creds: '/etc/suds/credentials',
  unit: `/etc/systemd/system/${UNIT}`, dropInDir: `/etc/systemd/system/${UNIT}.d`,
  // The shares: mount points of their own, as install.sh requires (is_mountpoint), here two tmpfs.
  offsite: '/srv/suds-offsite', anchors: '/srv/suds-anchors',
};
const BASE = 'http://127.0.0.1:8080';
const SNAPSHOT_MINUTES = 5;

// ---- the unit file ----

/** A systemd unit file as { Section: [[key, value], ...] } (comments and blank lines dropped; no continuations used). */
function parseUnit(text) {
  const out = {}; let sec = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) { sec = s[1]; out[sec] = out[sec] || []; continue; }
    const i = line.indexOf('=');
    if (i < 0 || !sec) throw new Error(`not a unit-file line: ${line}`);
    out[sec].push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}
/** Every value of `key` in `section`, in order. */
function values(unit, section, key) { return (unit[section] || []).filter(([k]) => k === key).map(([, v]) => v); }
/** The last value of `key` in [Service] (what systemd applies for a single-valued setting). */
function last(unit, key) { const v = values(unit, 'Service', key); return v.length ? v[v.length - 1] : undefined; }
/** LoadCredential=name:path lines as [{ name, path }]. */
function credentials(unit) { return values(unit, 'Service', 'LoadCredential').map((v) => { const i = v.indexOf(':'); return { name: v.slice(0, i), path: v.slice(i + 1) }; }); }

// Settings whose effective value `systemctl show` gives as the unit file writes it (booleans as yes/no). The check
// compares each one the unit sets, so a drop-in that weakened the sandbox (here or on a server) would be seen.
const SHOWN = ['User', 'Group', 'UMask', 'NoNewPrivileges', 'ProtectSystem', 'ProtectHome', 'PrivateTmp', 'PrivateDevices',
  'ProtectKernelTunables', 'ProtectKernelModules', 'ProtectKernelLogs', 'ProtectControlGroups', 'ProtectClock',
  'ProtectHostname', 'ProtectProc', 'RestrictRealtime', 'RestrictSUIDSGID', 'LockPersonality', 'RemoveIPC'];
const yesNo = (v) => (/^(true|yes|on|1)$/i.test(v) ? 'yes' : /^(false|no|off|0)$/i.test(v) ? 'no' : v);
/** { property: expected value as systemctl show prints it } for the SHOWN settings the unit sets. */
function expectedProperties(unit) {
  const out = {};
  for (const k of SHOWN) { const v = last(unit, k); if (v !== undefined) out[k] = yesNo(v); }
  return out;
}
/** `systemctl show -p A -p B ...` output as { A: value }. */
function parseShow(text) {
  const out = {};
  for (const line of String(text).split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return out;
}
/** What differs between the unit's settings and what systemd applies: one line each, [] when none. */
function propertyProblems(expected, shown) {
  const problems = [];
  for (const [k, want] of Object.entries(expected)) {
    if (!(k in shown) || shown[k] === '') problems.push(`${k}: systemd shows nothing, the unit sets ${want}`);
    else if (yesNo(shown[k]) !== want) problems.push(`${k}: systemd applies ${shown[k]}, the unit sets ${want}`);
  }
  return problems;
}
/**
 * The effective system-call filter (systemctl show -p SystemCallFilter: the allowed calls, or ~ and the denied ones)
 * must refuse each of `denied` (fchown: the call that killed SUDS in 1.18.0 to 1.25.3). Null when it does.
 */
function syscallFilterProblem(value, denied = ['fchown']) {
  const v = String(value || '').trim();
  if (!v) return 'systemd applies no system-call filter: the unit\'s SystemCallFilter= is not in force';
  const deny = v.startsWith('~');
  const calls = new Set(v.replace(/^~/, '').split(/\s+/).filter(Boolean));
  const allowed = denied.filter((c) => (deny ? !calls.has(c) : calls.has(c)));
  return allowed.length ? `the system-call filter in force allows ${allowed.join(', ')}, which the unit's SystemCallFilter=~@privileged refuses: this is not the sandbox SUDS Server runs under` : null;
}

/** The drop-in deploy/linux/install.sh writes for the shares (without the metrics credential), as it writes it. */
function siteDropIn({ anchors, offsite }) {
  return `# This site's mounts for suds.service (deploy/linux/install.sh). The unit itself is deploy/linux/suds.service.
[Unit]
RequiresMountsFor=${anchors}
[Service]
ReadWritePaths=${anchors} -${offsite}
`;
}

/** /etc/suds/suds.env as install.sh writes it (its compliance and passkey lines left out: no compliance check runs here). */
function envFile({ anchors }) {
  return `# SUDS Server environment (non-secret), written by scripts/service-sandbox-check.js as deploy/linux/install.sh writes it.
TRUST_PROXY=1
LOCAL_MODE_ENABLED=false
MFA_REQUIRED_ROLES=admin,supervisor,clinician,navigator,finance,readonly
AUDIT_ANCHOR_DIR=${anchors}
SUDS_PROVISION_FILE=${LAYOUT.etc}/provision.json
SUDS_SKIP_SETUP=1
`;
}
/** provision.json as install.sh writes it, plus online snapshots (to the offsite share) so the server's timer takes one. */
function provisionJson({ offsite }) {
  return JSON.stringify({ settings: { backup_schedule_hours: '4', backup_offsite_dir: offsite, backup_schedule_minutes: String(SNAPSHOT_MINUTES), dr_drill_monthly: '1', mfa_require_all: '1' } }, null, 2) + '\n';
}

// x86-64 numbers of the calls a seccomp kill would most likely name (the kernel's audit line gives the number only).
const SYSCALLS = { 92: 'chown', 93: 'fchown', 94: 'lchown', 260: 'fchownat', 141: 'setpriority', 144: 'sched_setscheduler', 160: 'setrlimit', 302: 'prlimit64', 165: 'mount', 101: 'ptrace', 155: 'pivot_root', 169: 'reboot' };
/** Lines of a journal (the unit's, or the kernel's) that show a process killed by the filter, or the service killed. */
function journalProblems(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (/status=31\/SYS|SIGSYS/.test(line)) out.push(line.trim());
    else if (/type=1326\b/.test(line) || /\bseccomp\b.*\bsig=31\b/.test(line)) {
      const n = /\bsyscall=(\d+)/.exec(line);
      out.push(`${line.trim()}${n && SYSCALLS[n[1]] ? `  [syscall ${n[1]} = ${SYSCALLS[n[1]]}]` : ''}`);
    } else if (/code=killed|code=dumped/.test(line)) out.push(line.trim());
  }
  return out;
}

async function digest(file) {
  const h = crypto.createHash('sha256'); let bytes = 0;
  for await (const c of fs.createReadStream(file)) { h.update(c); bytes += c.length; }
  return { bytes, sha256: h.digest('hex') };
}

// ---- running it (root, systemd, a disposable host) ----

const log = (m) => console.log(`[service-sandbox] ${m}`);
class CheckFailed extends Error {}
function fail(m) { throw new CheckFailed(m); }
function sh(cmd, args, { quiet = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0 && !allowFail) fail(`${cmd} ${args.join(' ')} exited ${r.status === null ? r.signal : r.status}: ${(r.stderr || '').trim()}`);
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false)); s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}
function show(props) { return parseShow(sh('systemctl', ['show', UNIT, ...props.flatMap((p) => ['-p', p])], { quiet: true }).stdout); }

function layOut({ zip, nodeDir }) {
  log('laying the host out as deploy/linux/install.sh does');
  sh('useradd', ['--system', '--user-group', '--home-dir', LAYOUT.data, '--no-create-home', '--shell', '/usr/sbin/nologin', 'suds']);
  const uid = sh('id', ['-u', 'suds'], { quiet: true }).stdout.trim(); const gid = sh('id', ['-g', 'suds'], { quiet: true }).stdout.trim();
  // The release zip, unpacked and made read-only, at /opt/suds/<version>; current -> <version>.
  fs.mkdirSync(LAYOUT.code, { mode: 0o755 });
  const stage = path.join(LAYOUT.code, '.stage');
  sh('unzip', ['-q', zip, '-d', stage]);
  const [top] = fs.readdirSync(stage);
  if (!top || !/^suds-v\d+\.\d+\.\d+$/.test(top)) fail(`${zip} does not hold one suds-vX.Y.Z/ folder (found ${top})`);
  const version = JSON.parse(fs.readFileSync(path.join(stage, top, 'package.json'), 'utf8')).version;
  const tree = path.join(LAYOUT.code, version);
  fs.renameSync(path.join(stage, top), tree); fs.rmdirSync(stage);
  sh('chmod', ['-R', 'a+rX,go-w', tree]);
  fs.symlinkSync(version, path.join(LAYOUT.code, 'current'));
  // The pinned Node: the version this release's deploy/linux/pins names, at /opt/suds/node.
  const pin = /^NODE_VERSION=(\S+)$/m.exec(fs.readFileSync(path.join(tree, 'deploy/linux/pins'), 'utf8'))[1];
  const have = sh(path.join(nodeDir, 'bin', 'node'), ['--version'], { quiet: true }).stdout.trim();
  if (have !== pin) fail(`--node-dir holds Node ${have}, but deploy/linux/pins pins ${pin}`);
  sh('cp', ['-a', nodeDir, path.join(LAYOUT.code, `node-${pin}`)]);
  sh('chmod', ['-R', 'a+rX,go-w', path.join(LAYOUT.code, `node-${pin}`)]);
  fs.symlinkSync(`node-${pin}`, path.join(LAYOUT.code, 'node'));
  // The shares: their own filesystems, writable by suds only.
  for (const d of [LAYOUT.offsite, LAYOUT.anchors]) {
    fs.mkdirSync(d, { recursive: true });
    sh('mount', ['-t', 'tmpfs', '-o', `size=512m,mode=0700,uid=${uid},gid=${gid}`, 'tmpfs', d]);
  }
  sh('install', ['-d', '-m', '0700', '-o', 'suds', '-g', 'suds', LAYOUT.data]);
  // Configuration and keys: root-owned; keys 0600 in a 0700 directory, one per LoadCredential= the unit names.
  const unitText = fs.readFileSync(path.join(tree, 'deploy/linux', UNIT), 'utf8');
  const unit = parseUnit(unitText);
  fs.mkdirSync(LAYOUT.etc, { mode: 0o755 }); fs.mkdirSync(LAYOUT.creds, { mode: 0o700 });
  for (const c of credentials(unit)) fs.writeFileSync(c.path, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.writeFileSync(path.join(LAYOUT.etc, 'suds.env'), envFile(LAYOUT), { mode: 0o644 });
  fs.writeFileSync(path.join(LAYOUT.etc, 'provision.json'), provisionJson(LAYOUT), { mode: 0o644 });
  // The unit, as the release ships it (install_units copies it unchanged), and install.sh's site drop-in.
  fs.writeFileSync(LAYOUT.unit, unitText, { mode: 0o644 });
  fs.mkdirSync(LAYOUT.dropInDir, { mode: 0o755 });
  fs.writeFileSync(path.join(LAYOUT.dropInDir, '10-site.conf'), siteDropIn(LAYOUT), { mode: 0o644 });
  log(`SUDS ${version} at ${tree}, Node ${pin}, ${UNIT} from the release unchanged, shares ${LAYOUT.offsite} and ${LAYOUT.anchors} (tmpfs)`);
  return { version, unit };
}

/** One administrator's HTTP session: JSON in and out, the session cookie, the CSRF header. */
function client() {
  let cookie = '';
  async function call(method, p, body, { expect = [200] } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'suds', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).find((c) => c.startsWith('suds_session='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
    if (!expect.includes(res.status)) fail(`${method} ${p} answered ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 600)}`);
    return data;
  }
  return { call, reset() { cookie = ''; } };
}

async function waitReady(seconds) {
  for (let i = 0; i < seconds; i += 2) {
    try { const r = await fetch(`${BASE}/api/health/ready`); if (r.ok) return; } catch {}
    const st = show(['ActiveState']).ActiveState;
    if (st === 'failed') fail(`${UNIT} failed while starting`);
    await sleep(2000);
  }
  fail(`SUDS did not answer ${BASE}/api/health/ready within ${seconds} s`);
}
async function waitFor(what, seconds, fn) {
  for (let i = 0; i <= seconds; i += 2) { const v = await fn(); if (v) return v; await sleep(2000); }
  fail(`${what}: not within ${seconds} s`);
}

async function compareCopies(file) {
  const local = path.join(LAYOUT.data, 'backups', file); const off = path.join(LAYOUT.offsite, file);
  if (!fs.existsSync(off)) fail(`the offsite copy ${off} does not exist`);
  const [a, b] = await Promise.all([digest(local), digest(off)]);
  if (!a.bytes) fail(`the local backup ${local} is empty`);
  if (a.bytes !== b.bytes || a.sha256 !== b.sha256) fail(`the offsite copy of ${file} is ${b.bytes} bytes (SHA-256 ${b.sha256}), the local backup ${a.bytes} bytes (SHA-256 ${a.sha256}): the 1.18.0 to 1.25.3 defect`);
  log(`  local and offsite ${file}: ${a.bytes} bytes each, SHA-256 ${a.sha256}`);
  return off;
}

async function drive() {
  const api = client();
  // The first administrator, as an operator finds it (install.sh: "sudo cat it once").
  const pwFile = path.join(LAYOUT.data, 'first-admin-password.txt');
  await waitFor(`${pwFile} (the generated first-administrator password)`, 30, () => fs.existsSync(pwFile));
  const first = fs.readFileSync(pwFile, 'utf8').trim();
  const username = 'guest';
  const password = `Sandbox-${crypto.randomBytes(9).toString('base64url')}-7q!`;
  log('step: sign in as the first administrator and change the generated password');
  await api.call('POST', '/api/auth/login', { username, password: first });
  await api.call('POST', '/api/auth/password', { current_password: first, new_password: password });
  if (fs.existsSync(pwFile)) fail(`${pwFile} is still there after the password change`);
  const settings = await api.call('GET', '/api/admin/settings');
  if (settings.backup_offsite_dir !== LAYOUT.offsite) fail(`backup_offsite_dir is ${settings.backup_offsite_dir}, not ${LAYOUT.offsite} (provision.json was not applied)`);
  await api.call('PUT', '/api/admin/settings', { org_name: 'Service sandbox check: before the backup' });

  log('step: Back up now, with the offsite share configured');
  const b = await api.call('POST', '/api/admin/backup/run-now', {});
  if (!b.verified) fail(`the backup was not verified: ${b.verify_error}`);
  if (b.offsite_ok !== true) fail(`the offsite copy failed: ${b.offsite_error}`);
  const offsiteCopy = await compareCopies(b.file);

  log(`step: an online snapshot on the offsite share, taken by the server's own timer (every ${SNAPSHOT_MINUTES} min, checked each minute)`);
  const snap = await waitFor('a snapshot on the offsite share', 240, () => fs.readdirSync(LAYOUT.offsite).filter((f) => /^suds-snap-.*\.db\.enc$/.test(f)).find((f) => fs.statSync(path.join(LAYOUT.offsite, f)).size > 0));
  log(`  ${snap}: ${fs.statSync(path.join(LAYOUT.offsite, snap)).size} bytes`);

  log('step: an audit anchor on the anchor share, and the chain verified against the anchors');
  const a = await api.call('POST', '/api/admin/audit/anchor', {});
  if (!a.anchor || !a.anchor.file || !fs.statSync(path.join(LAYOUT.anchors, a.anchor.file)).size) fail(`no anchor file was written: ${JSON.stringify(a)}`);
  const v = await api.call('GET', '/api/admin/audit/verify');
  if (!v.ok || !v.anchors || !v.anchors.ok) fail(`the audit chain does not verify: ${JSON.stringify(v).slice(0, 600)}`);
  log(`  ${a.anchor.file}; chain ok, ${v.anchors.matched}/${v.anchors.total} anchors matched`);

  log('step: a recovery drill from the offsite copy');
  const t0 = new Date().toISOString();
  await api.call('POST', '/api/admin/dr-drill', { copy: 'offsite' }, { expect: [202] });
  const drill = await waitFor('the recovery drill to finish', 300, async () => { const s = await api.call('GET', '/api/admin/dr-drill'); return !s.running && s.last && s.last.at >= t0 ? s.last : null; });
  if (!drill.ok) fail(`the recovery drill failed: ${(drill.failures || []).join(' | ')}`);
  if (drill.backup_copy !== 'offsite') fail(`the drill restored the ${drill.backup_copy} copy, not the offsite one`);
  log(`  passed, ${drill.checks_passed}/${drill.checks_total} checks, RTO ${drill.rto_seconds} s, report ${drill.report_file}`);

  log('step: restore the offsite copy through Settings (what was changed after the backup goes back)');
  await api.call('PUT', '/api/admin/settings', { org_name: 'Service sandbox check: after the backup' });
  const file_b64 = fs.readFileSync(offsiteCopy).toString('base64');
  await api.call('POST', '/api/admin/restore/preview', { file_b64 });
  const r = await api.call('POST', '/api/admin/restore', { password, confirm: 'REPLACE', file_b64 });
  if (!r.ok) fail(`the restore did not complete: ${JSON.stringify(r).slice(0, 400)}`);
  await waitReady(60);
  const org = (await api.call('GET', '/api/auth/signup/status')).org_name;
  if (org !== 'Service sandbox check: before the backup') fail(`after the restore the organisation name is "${org}", not the one in the backup`);
  api.reset();
  await api.call('POST', '/api/auth/login', { username, password });

  log('step: after the restore, Back up now again and verify the chain again');
  const b2 = await api.call('POST', '/api/admin/backup/run-now', {});
  if (!b2.verified || b2.offsite_ok !== true) fail(`the backup after the restore: verified ${b2.verified}, offsite ${b2.offsite_ok} (${b2.offsite_error || b2.verify_error})`);
  await compareCopies(b2.file);
  const v2 = await api.call('GET', '/api/admin/audit/verify');
  if (!v2.ok || !v2.anchors || !v2.anchors.ok) fail(`the audit chain does not verify after the restore: ${JSON.stringify(v2).slice(0, 600)}`);
}

function killedLines(since) {
  const unitLog = sh('journalctl', ['-u', UNIT, '--since', since, '--no-pager', '-o', 'short-precise'], { quiet: true, allowFail: true }).stdout || '';
  const kernel = sh('journalctl', ['-k', '--since', since, '--no-pager', '-o', 'short-precise'], { quiet: true, allowFail: true }).stdout || '';
  return [...journalProblems(unitLog), ...journalProblems(kernel).filter((l) => /type=1326|seccomp/.test(l))];
}

function diagnostics(since) {
  console.log('\n[service-sandbox] ---- diagnostics ----');
  for (const [title, cmd, args] of [
    ['systemctl status', 'systemctl', ['status', UNIT, '--no-pager', '-l']],
    ['the unit\'s journal', 'journalctl', ['-u', UNIT, '--since', since, '--no-pager', '-o', 'short-precise', '-n', '300']],
    ['the kernel\'s log (seccomp kills are audit type=1326)', 'journalctl', ['-k', '--since', since, '--no-pager', '-o', 'short-precise', '--grep', 'type=1326|seccomp|audit']],
    ['the effective sandbox', 'systemctl', ['show', UNIT, '-p', 'User', '-p', 'NRestarts', '-p', 'ExecMainStatus', '-p', 'Result', '-p', 'SystemCallFilter', '-p', 'ReadWritePaths']],
    ['the data, offsite and anchor directories', 'ls', ['-la', LAYOUT.data, path.join(LAYOUT.data, 'backups'), LAYOUT.offsite, LAYOUT.anchors]],
  ]) {
    console.log(`\n[service-sandbox] ${title}: ${cmd} ${args.join(' ')}`);
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
    process.stdout.write((r.stdout || '') + (r.stderr || ''));
  }
}

async function main(argv) {
  if (!argv.includes('--disposable-host')) {
    console.error('usage: sudo node scripts/service-sandbox-check.js --disposable-host --release-zip <suds-vX.Y.Z.zip> --node-dir <pinned Node dir>\n'
      + 'Installs suds.service and writes /etc/suds, /opt/suds and /var/lib/suds: for a CI runner or a throwaway VM only, never a server.');
    return 2;
  }
  const zip = arg(argv, '--release-zip'); const nodeDir = arg(argv, '--node-dir');
  if (!zip || !fs.existsSync(zip) || !nodeDir || !fs.existsSync(path.join(nodeDir, 'bin', 'node'))) { console.error('--release-zip <zip> and --node-dir <dir with bin/node> are required'); return 2; }
  if (process.getuid() !== 0) { console.error('run it as root (sudo)'); return 2; }
  if (!fs.existsSync('/run/systemd/system')) { console.error('systemd is not PID 1 here: the check needs it'); return 2; }
  const taken = [LAYOUT.etc, LAYOUT.code, LAYOUT.data, LAYOUT.unit].filter((p) => fs.existsSync(p));
  if (taken.length) { console.error(`refused: ${taken.join(', ')} already exist(s). This host has SUDS on it; the check runs on a disposable host only.`); return 2; }
  if (await portBusy(8080)) { console.error('refused: something already listens on 127.0.0.1:8080, the port the unit gives SUDS'); return 2; }

  // journalctl --since @<epoch seconds>: no time zone to get wrong.
  const since = `@${Math.floor(Date.now() / 1000) - 1}`;
  try {
    const { unit } = layOut({ zip: path.resolve(zip), nodeDir: path.resolve(nodeDir) });
    sh('systemctl', ['daemon-reload']);
    log(`step: start ${UNIT}`);
    sh('systemctl', ['start', UNIT]);
    await waitReady(180);
    const at = show(['MainPID', 'NRestarts', 'SystemCallFilter', ...Object.keys(expectedProperties(unit))]);
    const problems = propertyProblems(expectedProperties(unit), at);
    const filter = syscallFilterProblem(at.SystemCallFilter);
    if (filter) problems.push(filter);
    if (problems.length) fail(`systemd does not apply the unit's sandbox:\n  ${problems.join('\n  ')}`);
    log(`  ready, main PID ${at.MainPID}, as ${at.User}; the unit's sandbox is in force (${Object.keys(expectedProperties(unit)).length} settings, a system-call filter that refuses fchown)`);
    await drive();

    log('step: the service is still the one started, never restarted, and nothing was killed by the filter');
    const end = show(['ActiveState', 'SubState', 'MainPID', 'NRestarts']);
    if (end.ActiveState !== 'active' || end.SubState !== 'running') fail(`${UNIT} is ${end.ActiveState}/${end.SubState}, not active/running`);
    if (end.NRestarts !== '0') fail(`${UNIT} restarted ${end.NRestarts} time(s) (Restart=always hides a crash: see the journal)`);
    if (end.MainPID !== at.MainPID) fail(`the main PID changed from ${at.MainPID} to ${end.MainPID}`);
    let killed = killedLines(since);
    if (killed.length) fail(`a process was killed:\n  ${killed.join('\n  ')}`);
    log(`step: stop ${UNIT} (a clean stop: nothing at shutdown is refused either)`);
    sh('systemctl', ['stop', UNIT]);
    const stopped = show(['Result', 'ExecMainCode', 'ExecMainStatus']);
    killed = killedLines(since);
    if (killed.length) fail(`a process was killed:\n  ${killed.join('\n  ')}`);
    if (stopped.Result !== 'success') fail(`${UNIT} stopped with Result=${stopped.Result} (ExecMainCode=${stopped.ExecMainCode}, ExecMainStatus=${stopped.ExecMainStatus})`);
    log('PASS: SUDS Server ran under its own unit\'s sandbox, non-root: Back up now with a verified offsite copy, a snapshot, an anchor, a recovery drill and a restore; no status=31/SYS, no SIGSYS, NRestarts=0');
    return 0;
  } catch (e) {
    console.log(`\n::error::service-sandbox: ${String(e && e.message || e).split('\n').join('%0A')}`);
    if (!(e instanceof CheckFailed)) console.log(e && e.stack);
    diagnostics(since);
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 1; });
module.exports = { LAYOUT, SHOWN, drive, parseUnit, values, last, credentials, expectedProperties, parseShow, propertyProblems, syscallFilterProblem, siteDropIn, envFile, provisionJson, journalProblems, SYSCALLS, digest, main };
