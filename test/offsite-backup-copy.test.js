'use strict';
// The offsite copy of each scheduled backup (suds.systems, SUDS 1.25.3, HANDOFF 2026-10-09): every file on the
// offsite share was 0 bytes. Node's fs.copyFile (libuv uv_fs_copyfile) creates the destination, then calls
// fchown() on it before copying a byte; SUDS Server's unit denies fchown (deploy/linux/suds.service,
// SystemCallFilter=~@privileged), so systemd killed SUDS with SIGSYS at that point on every run. The run never
// finished: no log line, no status, last_scheduled_backup_at stuck at the installer's first backup (taken outside
// the unit), so a backup was "due" at every hourly pass after the restart. These tests simulate the copy that
// leaves an empty file (a stubbed fs.promises.copyFile) and check what 1.25.4 does instead: a streamed copy, read
// back and compared (size and SHA-256), empty copies left by earlier versions copied again, and every surface
// (the compliance check, Security status, the recovery drill) refusing an empty or short offsite copy.
process.env.SUDS_ENV = 'test';
process.env.SUDS_ENCRYPTION_KEY = '55'.repeat(32);
process.env.SUDS_INDEX_KEY = '66'.repeat(32);
process.env.SUDS_ADMIN_USERNAME = 'admin';
process.env.SUDS_ADMIN_PASSWORD = 'AdminPassw0rd!x';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-offsite-copy-'));
process.env.SUDS_DATA_DIR = dir;
process.env.SUDS_DB_PATH = path.join(dir, 'suds.db');

const db = require('../server/db');
const config = require('../server/config');
const backup = require('../server/backup');
const scheduled = require('../server/scheduled-backup');
const local = path.join(dir, 'backups');
let offsite;

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const backupsIn = (d) => fs.readdirSync(d).filter((f) => scheduled.FILE_RE.test(f)).sort();
const item = (name) => require('../server/security-status').status({ host: false }).items.find((i) => i.name === name);
/** Run `fn` with console output captured; resolves to [result, lines]. */
async function quietly(fn) {
  const lines = []; const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.join(' '));
  try { return [await fn(), lines]; } finally { Object.assign(console, saved); }
}

before(() => { db.open(); require('../server/bootstrap').ensureBootstrap(); });
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  for (const k of ['backup_schedule_hours', 'backup_offsite_dir', 'last_scheduled_backup_at', 'last_scheduled_backup_status', 'dr_last_drill']) db.run(`DELETE FROM settings WHERE key=?`, k);
  fs.rmSync(local, { recursive: true, force: true });
  if (offsite) fs.rmSync(offsite, { recursive: true, force: true });
  offsite = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-offsite-share-'));
});

test('the offsite copy is the whole backup (size and SHA-256), even where fs.copyFile would leave an empty file', async () => {
  // The suds.systems failure, simulated in-process: a copyFile that creates the destination and writes nothing.
  const real = fs.promises.copyFile;
  fs.promises.copyFile = async (src, dest) => { fs.writeFileSync(dest, ''); };
  try {
    const [out, lines] = await quietly(() => scheduled.run({ retain: 14, offsiteDir: offsite }));
    const copy = path.join(offsite, path.basename(out.file));
    assert.equal(out.offsiteOk, true, out.offsiteError);
    assert.equal(fs.statSync(copy).size, fs.statSync(out.file).size, 'the offsite file is the same size as the local backup');
    assert.ok(fs.statSync(copy).size > 0);
    assert.equal(sha(copy), sha(out.file), 'and byte for byte the same');
    assert.deepEqual(fs.readdirSync(offsite), [path.basename(out.file)], 'no temporary file is left on the share');
    assert.equal(db.getSetting('last_scheduled_backup_status', ''), 'ok (verified)');
    // One line per run in the server log, with the word "backup", what was written and what happened offsite.
    const line = lines.find((l) => /scheduled backup suds-.*: \d+ bytes, verified; offsite copied and checked/.test(l));
    assert.ok(line, `a result line is logged: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => /scheduled backup suds-\S+ starting/.test(l)), 'and a line when the run starts');
  } finally { fs.promises.copyFile = real; }
});

test('an offsite copy that does not read back the same is deleted and reported, and the local backup is kept', async () => {
  // Whatever the cause, a short copy must never be recorded as a good one: here the copy is truncated on the share.
  const realRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => { await realRename(from, to); if (to.startsWith(offsite)) fs.truncateSync(to, 100); };
  try {
    const [out, lines] = await quietly(() => scheduled.run({ retain: 14, offsiteDir: offsite }));
    assert.equal(out.offsiteOk, false);
    assert.match(out.offsiteError, /did not match the backup \(100 of \d+ bytes\) and was deleted/);
    assert.deepEqual(backupsIn(offsite), [], 'the bad copy is gone');
    assert.ok(fs.existsSync(out.file) && out.verified, 'the local backup is kept');
    assert.match(db.getSetting('last_scheduled_backup_status', ''), /^ok \(verified\) — offsite copy failed: the offsite copy of suds-.* did not match/);
    assert.ok(lines.some((l) => /scheduled backup .*offsite copy FAILED: the offsite copy/.test(l)), 'the failure is in the log line');
    db.setSetting('backup_offsite_dir', offsite);
    assert.equal(item('Offsite copy').level, 'bad', 'Security status (and the compliance check\'s app.offsite) shows it');
    const audited = db.one(`SELECT details FROM audit_log WHERE action='backup.scheduled' ORDER BY id DESC LIMIT 1`);
    assert.equal(JSON.parse(audited.details).offsite, false);
  } finally { fs.promises.rename = realRename; }
});

test('empty offsite copies left by 1.25.3 and earlier are copied again on the next run; local backups are kept', async () => {
  const [first] = await quietly(() => scheduled.run({ retain: 14 }));
  const name = path.basename(first.file);
  fs.writeFileSync(path.join(offsite, name), '');                    // the empty copy, as on suds.systems
  fs.writeFileSync(path.join(offsite, 'suds-2026-10-01T00-00-00-000Z.db.enc'), ''); // its local backup pruned long ago
  const [out, lines] = await quietly(() => scheduled.run({ retain: 14, offsiteDir: offsite }));
  assert.equal(out.offsiteOk, true, out.offsiteError);
  assert.equal(out.repaired, 1);
  assert.equal(fs.statSync(path.join(offsite, name)).size, fs.statSync(first.file).size, 'the empty copy now holds the backup');
  assert.equal(sha(path.join(offsite, name)), sha(first.file));
  assert.equal(fs.statSync(path.join(offsite, 'suds-2026-10-01T00-00-00-000Z.db.enc')).size, 0, 'one with no local backup is left alone');
  assert.deepEqual(backupsIn(local), [name, path.basename(out.file)].sort(), 'no local backup was deleted');
  assert.ok(lines.some((l) => /1 earlier offsite copy that did not match copied again/.test(l)), 'the count is logged');
  const audited = db.one(`SELECT details FROM audit_log WHERE action='backup.scheduled' ORDER BY id DESC LIMIT 1`);
  assert.equal(JSON.parse(audited.details).offsite_repaired, 1);
});

test('the compliance check fails an empty or short offsite copy, and its "last backup" is the newest actual backup', async () => {
  const [first] = await quietly(() => scheduled.run({ retain: 14 }));
  const name = path.basename(first.file);
  db.setSetting('backup_schedule_hours', '4');
  db.setSetting('backup_offsite_dir', offsite);
  // What suds.systems showed: runs that never finished, so the last recorded run is the installer's.
  db.setSetting('last_scheduled_backup_at', '2026-10-08T21:51:50.377Z');
  db.setSetting('last_scheduled_backup_status', 'ok (verified)');
  fs.writeFileSync(path.join(offsite, name), '');
  const { backupFiles, fromStatus } = require('../scripts/compliance/app-checks');
  // File times are the kernel's, the clock may be shifted (scripts/test-evening.sh): the files are dated now.
  const host = () => { for (const f of [first.file, path.join(offsite, name)]) fs.utimesSync(f, new Date(), new Date()); return backupFiles({ config, db, now: Date.now(), conf: {} }); };
  let r = host();
  assert.equal(r.result, 'fail');
  assert.match(r.evidence, new RegExp(`the offsite copy ${name.replace(/\./g, '\\.')} is empty \\(0 bytes\\): it is not a backup`));

  fs.writeFileSync(path.join(offsite, name), fs.readFileSync(first.file).subarray(0, 1000));
  r = host();
  assert.equal(r.result, 'fail');
  assert.match(r.evidence, /is 1000 bytes, but the local backup of that name is \d+ bytes/);

  const app = (id) => fromStatus(require('../server/security-status').status({ host: false })).find((x) => x.id === id);
  assert.equal(app('app.offsite').result, 'fail');
  assert.match(app('app.offsite').evidence, /is 1000 bytes, but the local backup/);
  const b = app('app.backups');
  assert.ok(b.evidence.includes(`last ${new Date(fs.statSync(first.file).mtimeMs).toISOString()} (${name})`), b.evidence);
  assert.doesNotMatch(b.evidence, /last 2026-10-08/);
  assert.match(b.evidence, /newer than the last backup run that finished \(2026-10-08T21:51:50\.377Z\)/);
  assert.equal(b.result, 'fail', 'the runs that did not finish still fail the check');

  fs.copyFileSync(first.file, path.join(offsite, name));
  assert.equal(host().result, 'pass', host().evidence);
  assert.equal(app('app.offsite').result, 'pass');
});

test('the recovery drill refuses an empty offsite copy as its restore source', async () => {
  const [first] = await quietly(() => scheduled.run({ retain: 14 }));
  db.setSetting('backup_offsite_dir', offsite);
  fs.writeFileSync(path.join(offsite, path.basename(first.file)), '');
  const [r] = await quietly(() => require('../server/dr-drill').run({ copy: 'offsite', by: { username: 'test' }, trigger: 'test' }));
  assert.equal(r.report.ok, false);
  assert.match(r.report.failures.join(' '), /the offsite copy suds-\S+ is empty \(0 bytes\): it is not a backup, so it was not restored/);
  assert.equal(r.report.backup.copy, 'local', 'the empty file was not restored');
});

test('a restore from the Administration page does not use fs.copyFileSync (killed by the unit\'s system-call filter)', async () => {
  const real = fs.copyFileSync;
  fs.copyFileSync = () => { throw new Error('fs.copyFileSync calls fchown(): SIGSYS under deploy/linux/suds.service'); };
  try {
    const [info] = await quietly(() => backup.restoreWhenIdle(backup.decrypt(backup.create())));
    assert.ok(fs.statSync(info.previous_database_kept_at).size > 0, 'the database set aside is a real copy');
  } finally { fs.copyFileSync = real; }
});

test('a copy across two filesystems (the data disk and a tmpfs) is whole', { skip: !fs.existsSync('/dev/shm') && 'no /dev/shm' }, async (t) => {
  let shm; try { shm = fs.mkdtempSync('/dev/shm/suds-offsite-'); } catch { return t.skip('/dev/shm is not writable'); }
  try {
    if (fs.statSync(shm).dev === fs.statSync(dir).dev) return t.skip('/dev/shm is on the same filesystem here');
    const [out] = await quietly(() => scheduled.run({ retain: 14, offsiteDir: shm }));
    assert.equal(out.offsiteOk, true, out.offsiteError);
    const copy = path.join(shm, path.basename(out.file));
    assert.equal(fs.statSync(copy).size, fs.statSync(out.file).size);
    assert.equal(sha(copy), sha(out.file));
  } finally { fs.rmSync(shm, { recursive: true, force: true }); }
});

test('nothing SUDS runs inside its systemd unit calls a file copy or chown that the unit\'s system-call filter kills', () => {
  // The tests above stub the copy; this keeps the cause out. fs.copyFile/copyFileSync and fs.cp call fchown()
  // (libuv uv_fs_copyfile), and fchown/chown are in @privileged, which deploy/linux/suds.service denies: systemd
  // kills the whole server with SIGSYS, with nothing in its log. The installer's test harness stubs systemd, so
  // only a check like this one catches a new call before a real server does.
  const BANNED = /\b(?:copyFile(?:Sync)?|cp(?:Sync)?|[fl]?chown(?:Sync)?)\s*\(/;
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''); if (BANNED.test(code)) hits.push(`${path.relative(path.join(__dirname, '..'), p)}:${i + 1}: ${l.trim()}`); }); } };
  walk(path.join(__dirname, '..', 'server'));
  assert.deepEqual(hits, [], 'server/ uses a call that SUDS Server\'s unit kills; copy with streams (server/scheduled-backup.js copyVerified)');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'deploy/linux/suds.service'), 'utf8'), /^SystemCallFilter=~@privileged/m, 'the filter this guards against is still there');
});
