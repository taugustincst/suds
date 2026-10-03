'use strict';
// Scheduled backups on SUDS on this device (released in 1.24.0; docs/WEB_APP.md, "Scheduled
// backups"). The schedule and file-name helpers in local/backup.js, a file made with the kept key opening with the
// passphrase like any backup, and the kernel's routes (test/fixtures/kernel-harness.js): the passphrase's key kept
// sealed in the vault and never in the database, a backup or the audit log; a file the page could not write not
// counted as a backup; old files to remove named; the restore drill; and only the device administrator.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let B; let L; let cleanup; let call;
before(async () => {
  B = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '..', 'local', 'backup.js')).toString('base64'));
  ({ L, cleanup } = await loadKernel({ staticHost: true }));
  call = kernelCaller(L);
});
after(async () => { if (cleanup) cleanup(); });

const PW = 'Lantern-Harbor-2026!'; const NAV_PW = 'Copper-Window-2026!';
const PASS = 'a backup passphrase for the folder';
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
const signIn = async (username, password) => expect(await call('POST', '/api/auth/login', { username, password }), 200, `sign in as ${username}`);
const signOut = async () => { await call('POST', '/api/auth/logout', {}); };
const device = async () => expect(await call('GET', '/api/local/device'), 200, 'device');
const run = async (body) => { const r = await L.handle('POST', '/api/local/backup/run', body); return { status: r.status, json: r.json, body: r.body, headers: r.headers || {} }; };
const at = (s) => new Date(s).getTime();
const stored = () => new Promise((res) => {
  const r = globalThis.indexedDB.open('suds-local', 1);
  r.onsuccess = () => { const s = r.result.transaction('kv', 'readonly').objectStore('kv'); const k = s.getAllKeys(); const v = s.getAll(); v.onsuccess = () => res(k.result.map((key, i) => [key, v.result[i]])); };
});

test('the schedule: due once the chosen number of calendar days has begun, overdue a day later', () => {
  const s = B.scheduleState(null, 1);
  assert.deepStrictEqual([s.due, s.overdue, s.days], [true, true, null], 'never backed up: due and overdue');
  const evening = new Date(2026, 9, 1, 17, 0).toISOString();
  assert.equal(B.scheduleState(evening, 1, at(new Date(2026, 9, 1, 23, 0))).due, false, 'daily: not again the same day');
  const next = B.scheduleState(evening, 1, at(new Date(2026, 9, 2, 8, 0)));
  assert.deepStrictEqual([next.due, next.overdue, next.days], [true, false, 1], 'daily: due the next morning, not at 17:00');
  assert.equal(B.scheduleState(evening, 1, at(new Date(2026, 9, 3, 8, 0))).overdue, true, 'and overdue the day after');
  assert.equal(B.scheduleState(evening, 3, at(new Date(2026, 9, 3, 8, 0))).due, false, 'every 3 days: not after 2');
  assert.equal(B.scheduleState(evening, 3, at(new Date(2026, 9, 4, 8, 0))).due, true, 'every 3 days: due on the third');
  assert.equal(B.scheduleState(evening, 3).next_due !== null, true);
  assert.equal(B.scheduleState(evening, 3, at(new Date(2026, 9, 1, 18, 0))).next_due, '2026-10-04');
  assert.equal(B.scheduleState(evening, 30).every_days, 7, 'an unknown interval falls back to weekly, the floor');
  assert.equal(B.scheduleState(evening, undefined).every_days, B.DEFAULT_EVERY_DAYS);
  assert.equal(B.DEFAULT_EVERY_DAYS, 7, 'a device that never chose keeps the weekly reminder it had');
  assert.deepStrictEqual(B.SCHEDULES, [1, 3, 7]);
});

test('file names: dated and timed, only SUDS\'s own files are ever chosen for removal, oldest first', () => {
  const n = B.fileName('2026-10-01T15:30:12.345Z');
  assert.equal(n, 'suds-device-backup-2026-10-01-153012.sudsbackup');
  assert.ok(B.isBackupName(n) && B.isBackupName('suds-device-backup-2026-09-01.sudsbackup'), 'a scheduled and a downloaded backup are both ours');
  assert.ok(!B.isBackupName('notes.txt') && !B.isBackupName('suds-device-backup-2026-10-01.sudsbackup.txt') && !B.isBackupName('../suds-device-backup-2026-10-01.sudsbackup'));
  const names = ['notes.txt', 'suds-device-backup-2026-09-30-090000.sudsbackup', 'suds-device-backup-2026-09-01.sudsbackup', 'suds-device-backup-2026-10-01-080000.sudsbackup', 'suds-device-backup-2026-10-01-170000.sudsbackup', 'Client list.xlsx'];
  assert.deepStrictEqual(B.toRemove(names, 2), ['suds-device-backup-2026-09-01.sudsbackup', 'suds-device-backup-2026-09-30-090000.sudsbackup']);
  assert.deepStrictEqual(B.toRemove(names, 10), [], 'fewer than the number kept: nothing removed');
  assert.deepStrictEqual(B.toRemove(names, 0).length, 2, 'never fewer than two kept');
  assert.equal(B.newest(names), 'suds-device-backup-2026-10-01-170000.sudsbackup');
  assert.equal(B.newest(['notes.txt']), null);
});

test('a file made with the kept key is an ordinary backup: it opens with the passphrase, and only with it', async () => {
  const derived = await B.deriveKey(PASS);
  assert.equal(derived.raw.length, 32); assert.equal(derived.iterations, B.ITERATIONS);
  await assert.rejects(B.deriveKey('too short'), (e) => e.code === 'weak');
  const bytes = new Uint8Array(4096); bytes.set(new TextEncoder().encode('SQLite format 3\0'));
  const meta = { keys: { enc: 'a'.repeat(64), idx: 'b'.repeat(64) }, created_at: '2026-10-01T00:00:00.000Z' };
  const one = await B.createWithKey({ bytes, meta, derived, appVersion: 'test' });
  const two = await B.createWithKey({ bytes, meta, derived, appVersion: 'test' });
  assert.notDeepStrictEqual(B.readHeader(one).header.iv, B.readHeader(two).header.iv, 'a fresh IV for every file');
  const opened = await B.open(two, PASS);
  assert.deepStrictEqual(opened.bytes, bytes);
  await assert.rejects(B.open(one, 'not the passphrase at all'), (e) => e.code === 'passphrase');
  await assert.rejects(B.createWithKey({ bytes, meta, derived: { ...derived, raw: new Uint8Array(5) }, appVersion: 'x' }), (e) => e.code === 'key');
});

let navCreated = false;
test('kernel: a new device is due, with no passphrase kept; a run needs one', async () => {
  expect(await call('POST', '/api/local/signup', { display_name: 'Device Owner', username: 'owner', password: PW, role: 'admin', storage_ack: true }), 200, 'first account');
  await signIn('owner', PW);
  expect(await call('POST', '/api/clients', { first_name: 'Zebedee', last_name: 'Backupson', status: 'active' }), 201, 'a client');
  const d = await device();
  assert.equal(d.backup.every_days, 7); assert.equal(d.backup.due, true); assert.equal(d.backup.passphrase_kept, false); assert.equal(d.backup.last_at, null); assert.equal(d.backup.check, null);
  const r = await run({ to: 'download' });
  assert.equal(r.status, 409); assert.equal(r.json.backupPassphraseNeeded, true);
  expect(await call('POST', '/api/local/backup/schedule', { passphrase: 'short' }), 400, 'a short passphrase');
  expect(await call('POST', '/api/local/backup/schedule', { passphrase: PASS, every_days: 5 }), 400, 'an interval not offered');
  expect(await call('PUT', '/api/local/device', { backup_every_days: 14 }), 400, 'longer than weekly is not offered');
});

let fileOne;
test('kernel: scheduled backups on; a run to a folder names the old files to remove, and counts only once written', async () => {
  const on = expect(await call('POST', '/api/local/backup/schedule', { passphrase: PASS, every_days: 1, keep: 3 }), 200, 'turn on');
  assert.equal(on.backup.passphrase_kept, true); assert.equal(on.backup.every_days, 1); assert.equal(on.backup.keep, 3); assert.equal(on.backup.schedule_chosen, true);
  const existing = ['notes.txt', 'suds-device-backup-2026-01-01-000000.sudsbackup', 'suds-device-backup-2026-01-02.sudsbackup', 'suds-device-backup-2026-01-03-000000.sudsbackup', 'suds-device-backup-2026-01-04-000000.sudsbackup'];
  const r = await run({ to: 'folder', trigger: 'schedule', existing });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const name = /filename="([^"]+)"/.exec(r.headers['content-disposition'])[1];
  assert.ok(B.isBackupName(name) && /-\d{6}\.sudsbackup$/.test(name), 'a dated and timed name');
  assert.deepStrictEqual(JSON.parse(r.headers['x-suds-backup-remove']), ['suds-device-backup-2026-01-01-000000.sudsbackup', 'suds-device-backup-2026-01-02.sudsbackup'], 'keeping 3 with the new one: the two oldest of ours, never notes.txt');
  fileOne = Uint8Array.from(r.body);
  const opened = await B.open(fileOne, PASS);
  assert.equal(opened.meta.clients, 1);
  assert.ok(!JSON.stringify(opened.meta).includes('backup_key'), 'the kept key does not travel in the backup');
  assert.equal((await device()).backup.last_at, null, 'not the device\'s last backup until the page says it was written');
  const done = expect(await call('POST', '/api/local/backup/run/done', { ok: true, removed: 2 }), 200, 'written');
  assert.ok(done.backup.last_at); assert.equal(done.backup.last_to, 'folder'); assert.equal(done.backup.due, false);
  expect(await call('POST', '/api/local/backup/run/done', { ok: true }), 409, 'a second "done" for the same file');
});

test('kernel: a file the page could not write changes nothing but the audit log', async () => {
  const before = (await device()).backup.last_at;
  expect(await run({ to: 'folder', trigger: 'schedule' }), 200, 'run');
  expect(await call('POST', '/api/local/backup/run/done', { ok: false, problem: 'permission' }), 200, 'not written');
  assert.equal((await device()).backup.last_at, before);
  // A download is counted when the page hands it over.
  expect(await run({ to: 'download', trigger: 'now' }), 200, 'run');
  const d = expect(await call('POST', '/api/local/backup/run/done', { ok: true }), 200, 'downloaded').backup;
  assert.equal(d.last_to, 'download');
});

test('kernel: the restore drill opens a backup, checks its database and records the result', async () => {
  const wrong = expect(await call('POST', '/api/local/backup/check', { file_b64: Buffer.from(fileOne).toString('base64'), passphrase: 'not the right passphrase' }), 200, 'wrong passphrase');
  assert.equal(wrong.ok, false); assert.equal(wrong.problem, 'passphrase'); assert.match(wrong.message, /passphrase/);
  assert.equal((await device()).backup.check.ok, false);
  const bent = Buffer.from(fileOne); bent[bent.length - 30] ^= 1;
  const tampered = expect(await call('POST', '/api/local/backup/check', { file_b64: bent.toString('base64'), passphrase: PASS }), 200, 'tampered');
  assert.equal(tampered.ok, false); assert.equal(tampered.problem, 'tampered');
  const good = expect(await call('POST', '/api/local/backup/check', { file_b64: Buffer.from(fileOne).toString('base64'), passphrase: PASS }), 200, 'right passphrase');
  assert.equal(good.ok, true, JSON.stringify(good)); assert.equal(good.clients, 1); assert.deepStrictEqual(good.missing, []); assert.ok(good.tables > 20);
  const d = await device();
  assert.equal(d.backup.check.ok, true); assert.ok(d.backup.check.backup_created_at);
});

test('kernel: the kept key survives a sign-out and in; turning it off stops runs', async () => {
  await signOut(); assert.equal(L.phase(), 'locked');
  await signIn('owner', PW);
  expect(await run({ to: 'download', trigger: 'schedule' }), 200, 'run after signing in again');
  expect(await call('POST', '/api/local/backup/run/done', { ok: true }), 200, 'done');
  const entries = await stored();
  const vaultRec = (entries.find(([k]) => k === 'vault') || [])[1];
  assert.ok(vaultRec && vaultRec.backup_key && vaultRec.backup_key.ct instanceof Uint8Array, 'the key is in the vault, sealed');
  const all = Buffer.concat(entries.map(([, v]) => Buffer.from(JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('latin1') : x)))));
  assert.ok(!all.includes(Buffer.from(PASS)), 'the passphrase is stored nowhere');
  const off = expect(await call('DELETE', '/api/local/backup/schedule'), 200, 'turn off').backup;
  assert.equal(off.passphrase_kept, false);
  assert.equal((await run({ to: 'download' })).status, 409);
});

test('kernel: only the device administrator sets up, runs or checks backups', async () => {
  expect(await call('POST', '/api/local/signup', { display_name: 'Second Navigator', username: 'nav', password: NAV_PW }), 200, 'a second account'); navCreated = true;
  await signOut(); await signIn('nav', NAV_PW);
  assert.equal((await call('POST', '/api/local/backup/schedule', { passphrase: PASS })).status, 403);
  assert.equal((await run({ to: 'download' })).status, 403);
  assert.equal((await call('POST', '/api/local/backup/run/done', { ok: true })).status, 403);
  assert.equal((await call('POST', '/api/local/backup/check', { file_b64: Buffer.from(fileOne).toString('base64'), passphrase: PASS })).status, 403);
  assert.equal((await call('PUT', '/api/local/device', { backup_every_days: 1 })).status, 403);
  await signOut(); await signIn('owner', PW);
});

test('kernel: every backup written, every failure, every drill and the schedule are audited without PHI or the passphrase', async () => {
  assert.ok(navCreated);
  const log = expect(await call('GET', '/api/admin/audit?limit=1000'), 200, 'audit').rows;
  const created = log.filter(x => x.action === 'device.backup.created');
  assert.equal(created.length, 3, 'the folder file, the download and the one after signing in again');
  assert.ok(created.some(x => x.details.to === 'folder' && x.details.trigger === 'schedule' && x.details.old_files_removed === 2 && x.details.clients === 1));
  assert.ok(log.some(x => x.action === 'device.backup.failed' && x.details.problem === 'permission' && x.details.to === 'folder'));
  assert.equal(log.filter(x => x.action === 'device.backup.checked').length, 3);
  assert.ok(log.some(x => x.action === 'device.backup.checked' && x.details.ok === true && Array.isArray(x.details.missing_tables)));
  assert.ok(log.some(x => x.action === 'device.backup.schedule' && x.details.on === true && x.details.every_days === 1));
  assert.ok(log.some(x => x.action === 'device.backup.schedule' && x.details.on === false));
  const text = JSON.stringify(log.filter(x => /^device\.backup\./.test(x.action)));
  assert.ok(!text.includes('Zebedee') && !text.includes('Backupson'), 'no client name');
  assert.ok(!text.includes(PASS), 'no passphrase');
  assert.ok(!/sudsbackup/.test(text), 'no file names');
});
