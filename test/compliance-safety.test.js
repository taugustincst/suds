'use strict';
// The compliance check runs as root over directories the suds user controls (scripts/compliance/safe-fs.js):
// it must never write, chown or read through a path that user can redirect. These tests run as an ordinary
// user; root's "is this directory owned by who it should be" check is simulated with expectUid. Also: the
// report is signed with the compliance check's own key when one is configured (never the audited service's),
// unknown options are refused, and the smaller host-check fixes (cipher_null, the journal's oldest entry, the
// release checksum's source).
const fs0 = require('node:fs'); const os0 = require('node:os'); const path0 = require('node:path');
process.env.SUDS_DATA_DIR = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'suds-cc-safety-data-'));
process.env.SUDS_ENV = 'test';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sf = require('../scripts/compliance/safe-fs');
const cc = require('../scripts/compliance-check');
const hc = require('../scripts/compliance/host-checks');
const cr = require('../server/compliance-report');
const signing = require('../server/signing');

const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-cc-safety-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(process.env.SUDS_DATA_DIR, { recursive: true, force: true }); });
const uid = process.getuid();
let n = 0;
const fresh = () => { const d = path.join(tmp, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const plan = (over = {}) => ({ expectUid: null, dirMode: 0o700, fileMode: 0o600, uid: null, gid: null, dirOwner: null, ...over });

test('reports: a report directory replaced by a symlink is refused, and nothing is written where it points', () => {
  const d = fresh();
  const victim = path.join(d, 'etc'); fs.mkdirSync(victim);
  const out = path.join(d, 'compliance'); fs.symlinkSync(victim, out);
  assert.throws(() => cc.writeReports(out, { 'compliance-x.json': '{}' }, plan()), /symbolic link/);
  assert.deepEqual(fs.readdirSync(victim), [], 'nothing was created through the link');
});

test('reports: a report file name planted as a symlink to another file is never followed or overwritten', () => {
  const d = fresh();
  const out = path.join(d, 'compliance'); fs.mkdirSync(out);
  const victim = path.join(d, 'shadow'); fs.writeFileSync(victim, 'root:secret\n');
  fs.symlinkSync(victim, path.join(out, 'compliance-x.json'));
  assert.throws(() => cc.writeReports(out, { 'compliance-x.json': '{"evil":1}' }, plan()), /EEXIST/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'root:secret\n', 'the target is untouched');
});

test('reports: a directory reached through a symlinked parent, or owned by someone unexpected, is refused', () => {
  const d = fresh();
  const real = path.join(d, 'real'); fs.mkdirSync(path.join(real, 'compliance'), { recursive: true });
  fs.symlinkSync(real, path.join(d, 'link'));
  assert.throws(() => cc.writeReports(path.join(d, 'link', 'compliance'), { 'compliance-x.json': '{}' }, plan()), /parent directory is a symbolic link/);
  // As root the dedicated directory must be root's; here the test user owns it, so "expect root" refuses it.
  assert.throws(() => cc.writeReports(path.join(real, 'compliance'), { 'compliance-x.json': '{}' }, plan({ expectUid: uid + 1 })), /not the expected uid/);
  assert.deepEqual(fs.readdirSync(path.join(real, 'compliance')), []);
  fs.chmodSync(path.join(real, 'compliance'), 0o777);
  assert.throws(() => cc.writeReports(path.join(real, 'compliance'), { 'compliance-x.json': '{}' }, plan()), /writable by everyone/);
  assert.throws(() => cc.writeReports(path.join(real, 'x'), { '../escape.json': '{}' }, plan()), /refusing the file name/);
});

test('reports: written as new files with the planned mode, in a directory made with the planned mode', () => {
  const d = fresh();
  const out = path.join(d, 'suds-compliance');
  const files = cc.writeReports(out, { 'compliance-a.json': '{}', 'compliance-a.html': '<!doctype html>' }, plan({ expectUid: uid, dirMode: 0o750, fileMode: 0o640, dirOwner: [uid, null] }));
  assert.equal(files.length, 2);
  assert.equal(fs.statSync(out).mode & 0o777, 0o750);
  for (const f of files) assert.equal(fs.statSync(f).mode & 0o777, 0o640);
  // As root: the dedicated directory is expected to be root's and its files 0640 to the suds group; the data
  // directory's own compliance folder is expected to be the data owner's.
  const root = fresh(); fs.mkdirSync(path.join(root, 'etc'));
  fs.writeFileSync(path.join(root, 'etc/passwd'), 'root:x:0:0::/root:/bin/sh\nsuds:x:990:987::/var/lib/suds:/usr/sbin/nologin\n');
  const data = fresh();
  const conf = { root, dataDir: data, serviceUser: 'suds' };
  assert.deepEqual(cc.writePlan('/var/lib/suds-compliance', conf, { uid: 0 }), { expectUid: 0, dirMode: 0o750, fileMode: 0o640, uid: 0, gid: 987, dirOwner: [0, 987] });
  const p = cc.writePlan(path.join(data, 'compliance'), conf, { uid: 0 });
  assert.equal(p.expectUid, fs.statSync(data).uid); assert.equal(p.fileMode, 0o600);
  assert.equal(cc.writePlan(path.join(data, 'compliance'), conf, { uid: 1000 }).expectUid, null, 'not root: nothing to hand over');
});

test('the database is copied through descriptors, never opened in place: no -wal/-shm beside it, a symlink refused', () => {
  const d = fresh();
  const dbf = path.join(d, 'suds.db');
  const { DatabaseSync } = require('node:sqlite');
  const w = new DatabaseSync(dbf); w.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1),(2);"); w.close();
  assert.ok(!fs.existsSync(`${dbf}-wal`) && !fs.existsSync(`${dbf}-shm`));
  const snap = sf.snapshotDb(dbf);
  const r = new DatabaseSync(snap.file, { readOnly: true }); assert.equal(r.prepare('SELECT COUNT(*) n FROM t').get().n, 2); r.close();
  fs.rmSync(snap.dir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(`${dbf}-wal`) && !fs.existsSync(`${dbf}-shm`), 'the live database gained no journal files');
  assert.equal(fs.statSync(path.dirname(snap.file), { throwIfNoEntry: false }), undefined, 'the private copy is gone');
  // With a writer holding it open (WAL content not yet checkpointed), the copy includes the WAL.
  const live = new DatabaseSync(dbf); live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (3);");
  const s2 = sf.snapshotDb(dbf);
  const r2 = new DatabaseSync(s2.file, { readOnly: true }); assert.equal(r2.prepare('SELECT COUNT(*) n FROM t').get().n, 3); r2.close();
  live.close(); fs.rmSync(s2.dir, { recursive: true, force: true });
  const link = path.join(d, 'link.db'); fs.symlinkSync(dbf, link);
  assert.throws(() => sf.snapshotDb(link), /symbolic link/);
});

test('reading a file as root: a symlink is not followed, and an error never carries the file content', () => {
  const d = fresh();
  const secret = path.join(d, 'shadow'); fs.writeFileSync(secret, 'root:$6$verysecrethash:19000:0:99999:7:::\n');
  const link = path.join(d, 'dr-drill-2026-01-01.json'); fs.symlinkSync(secret, link);
  assert.throws(() => sf.readJson(link), (e) => /symbolic link/.test(e.message) && !e.message.includes('verysecret'));
  const notJson = path.join(d, 'dr-drill-2026-01-02.json'); fs.writeFileSync(notJson, 'root:$6$verysecrethash\n');
  assert.throws(() => sf.readJson(notJson), (e) => e.message === 'not valid JSON');
  assert.throws(() => sf.readRegular(d), /not a regular file|EISDIR/);
});

test('the report is signed with the compliance check\'s own key when one is configured; never silently with the service key', () => {
  const d = fresh();
  const cseed = crypto.randomBytes(32); const sseed = crypto.randomBytes(32);
  const keyFile = path.join(d, 'compliance-signing-key'); fs.writeFileSync(keyFile, cseed.toString('hex'), { mode: 0o600 });
  const args = { opts: {}, flags: new Set() };
  let s = cc.reportSigner({ complianceKeyFile: keyFile, credentialsDir: d }, args, sseed, {});
  assert.equal(s.source, 'compliance'); assert.ok(s.seed.equals(cseed));
  s = cc.reportSigner({ complianceKeyFile: path.join(d, 'missing'), credentialsDir: d }, args, sseed, {});
  assert.equal(s.seed, null, 'configured but unreadable: unsigned, not signed with the service key'); assert.match(s.error, /cannot be read/);
  s = cc.reportSigner({ complianceKeyFile: '', credentialsDir: d }, args, sseed, {});
  assert.equal(s.source, 'service'); assert.ok(s.seed.equals(sseed));
  // End to end: a report written with --signing-key verifies with that key's public half only.
  const out = path.join(d, 'out');
  const env = { ...process.env, SUDS_SIGNING_KEY: sseed.toString('hex') }; delete env.SUDS_ENV;
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(REPO, 'scripts/compliance-check.js'), '--no-app', '--no-host', '--out', out, '--signing-key', keyFile], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Signed \(Ed25519, the compliance check's own key \(root-only\)/);
  const doc = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out).find((f) => cr.FILE_RE.test(f))), 'utf8'));
  assert.equal(cr.verifyDoc(doc, { publicKeyPem: signing.publicInfo(cseed).public_key_pem }).ok, true);
  assert.equal(cr.verifyDoc(doc, { publicKeyPem: signing.publicInfo(sseed).public_key_pem }).ok, false, 'not the service key');
  assert.match(doc.report.host.signed_with, /compliance check's own key/);
});

test('compliance-check: an unknown option is an error, not ignored', () => {
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(REPO, 'scripts/compliance-check.js'), '--no-app', '--no-host', '--no-write', '--stirct'], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /unknown option --stirct/);
  assert.deepEqual(cc.parseArgs(['--out']).errors, ['--out needs a value']);
  assert.deepEqual(cc.parseArgs(['--json=1']).errors, ['unknown option --json=1']);
});

test('a key check whose real key could not be read says "could not check", the index key included', () => {
  const checks = [{ id: 'app.index_key', result: 'pass', evidence: 'set' }, { id: 'app.phi_key', result: 'pass', evidence: 'set' }, { id: 'app.signing_key', result: 'pass', evidence: 'x' }];
  cc.markStandIns(checks, { SUDS_ENCRYPTION_KEY: 'credential store', SUDS_INDEX_KEY: null, SUDS_SIGNING_KEY: 'credential store' });
  assert.deepEqual(checks.map((c) => c.result), ['not-checked', 'pass', 'pass']);
});

const ctx = (table, conf = {}) => ({ root: '/', now: Date.parse('2026-09-30T00:00:00Z'), conf: { dataDir: '/var/lib/suds', logRetentionDays: 400, ...conf }, run: (cmd, args = []) => { const k = [cmd, ...args].join(' '); return k in table ? { code: 0, stdout: table[k], stderr: '', missing: false } : { code: 127, stdout: '', stderr: '', missing: true }; } });
test('host.disk_encryption: a dm-crypt layer with cipher_null is no encryption at all, and fails', () => {
  const t = { 'findmnt -n -o SOURCE,FSTYPE --target /var/lib/suds': '/dev/mapper/suds-data ext4\n', 'lsblk -s -n -r -o NAME,TYPE /dev/mapper/suds-data': 'suds-data crypt\nsdb disk\n' };
  let c = hc.checkDiskEncryption(ctx({ ...t, 'cryptsetup status suds-data': '  type:    LUKS2\n  cipher:  cipher_null-ecb\n  keysize: 0 bits\n' }));
  assert.equal(c.result, 'fail', c.evidence); assert.match(c.evidence, /cipher_null-ecb: no encryption at all/);
  c = hc.checkDiskEncryption(ctx({ ...t, 'cryptsetup status suds-data': '  type:    LUKS2\n  cipher:  aes-xts-plain64\n  keysize: 512 bits\n' }));
  assert.equal(c.result, 'pass', c.evidence);
});

test('host.journald: the oldest entry is evidence, and a journal younger than the target on an older server warns', () => {
  const dir = fresh(); fs.mkdirSync(path.join(dir, 'etc/systemd/journald.conf.d'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'etc/systemd/journald.conf.d/suds.conf'), '[Journal]\nStorage=persistent\nMaxRetentionSec=400d\nSystemMaxUse=8G\n');
  const now = Date.parse('2026-09-30T00:00:00Z');
  const first = (days) => ({ "sh -c journalctl -q --no-pager -o short-unix 2>/dev/null | head -n 1": `${Math.floor((now - days * 86400_000) / 1000)}.123456 host sshd[1]: some message never echoed\n` });
  const c0 = { ...ctx(first(30), { installedAt: '2025-01-01T00:00:00Z' }), root: dir };
  let c = hc.checkJournald(c0);
  assert.equal(c.result, 'warn', c.evidence); assert.match(c.evidence, /reaches back only 30 days although this server was installed \d+ days ago/); assert.ok(!c.evidence.includes('never echoed'));
  c = hc.checkJournald({ ...ctx(first(30), { installedAt: '2026-09-01T00:00:00Z' }), root: dir });
  assert.equal(c.result, 'pass', 'a young server: the journal cannot be older than it'); assert.match(c.evidence, /oldest entry 2026-08-31 \(30 days ago\)/);
  c = hc.checkJournald({ ...ctx(first(450), { installedAt: '2025-01-01T00:00:00Z' }), root: dir });
  assert.equal(c.result, 'pass', c.evidence);
  assert.equal(hc.checkJournald({ ...ctx({}, {}), root: dir }).result, 'pass', 'no journalctl: evidence says so, the configuration decides');
});

test('host.release_integrity: a checksum from the same release is a warning; the operator\'s independent one passes', () => {
  assert.equal(hc.checkReleaseIntegrity(ctx({}, { releaseChecksumSource: 'operator' })).result, 'pass');
  const w = hc.checkReleaseIntegrity(ctx({}, { releaseChecksumSource: 'same-release' }));
  assert.equal(w.result, 'warn'); assert.match(w.evidence, /same GitHub release/);
  assert.equal(hc.checkReleaseIntegrity(ctx({}, {})).result, 'not-checked');
});

test('Security status: "no report yet" is a warning only on a production server the Linux installer set up', () => {
  const ss = require('../server/security-status');
  const d = fresh(); const conf = path.join(d, 'suds-server.conf');
  assert.equal(ss.noReportLevel({ isProd: true, confFile: conf }), 'info', 'no suds-server.conf: not an installer host');
  fs.writeFileSync(conf, 'SUDS_DOMAIN=x\n');
  assert.equal(ss.noReportLevel({ isProd: true, confFile: conf }), 'warn');
  assert.equal(ss.noReportLevel({ isProd: false, confFile: conf }), 'info');
});
