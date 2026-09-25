'use strict';
// The follow-up to the independent security review: anchors that must live off the data disk in production,
// Ed25519-signed evidence that verifies with a public key only, a recovery drill that proves the escrowed
// keys and the offsite copy rather than process memory, stale drill copies swept, frequent online snapshots
// for a minutes-scale RPO, and production warnings when backups are off.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-hardening-'));
process.env.SUDS_DATA_DIR = dir;
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, stop, client, makeUser, db } = require('./helpers');
const config = require('../server/config');
const audit = require('../server/audit');
const anchor = require('../server/audit-anchor');
const ex = require('../server/audit-export');
const signing = require('../server/signing');

let admin, nav, base;
before(async () => {
  base = await start();
  admin = client(); await admin.login('admin', 'AdminPassw0rd!x');
  const u = makeUser('hardnav', 'navigator');
  nav = client(); await nav.login('hardnav', u.password);
});
after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });

/** Run `fn` with config temporarily changed (the config object is read at call time everywhere). */
async function withConfig(patch, fn) {
  const saved = {}; for (const k of Object.keys(patch)) saved[k] = config[k];
  Object.assign(config, patch);
  try { return await fn(); } finally { Object.assign(config, saved); }
}
const quiet = async (fn) => { const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };

// ---- 1b: anchors on the same disk are a production failure ----

test('production: anchors left in the data directory are reported red on Security status and as a /api/health warning', async () => {
  await withConfig({ isProd: true, auditAnchorDirConfigured: false, auditAnchorDir: path.join(dir, 'audit-anchors') }, async () => {
    assert.match(anchor.placementProblem(), /AUDIT_ANCHOR_DIR is not set/);
    const s = (await admin.get('/api/admin/security/status')).data;
    const item = s.items.find((i) => i.name === 'Audit anchors outside the database');
    assert.equal(item.level, 'bad');
    assert.match(item.detail, /WORM/);
    const h = await fetch(base + '/api/health');
    const body = await h.json();
    assert.equal(h.status, 503);
    assert.ok(body.warnings.some((w) => /AUDIT_ANCHOR_DIR/.test(w)));
    assert.ok(require('../server/startup-checks').problems().some((p) => /AUDIT_ANCHOR_DIR/.test(p)), 'and the startup log says so');
  });
  // Configured, but pointing inside the data directory: the same failure.
  await withConfig({ isProd: true, auditAnchorDirConfigured: true, auditAnchorDir: path.join(dir, 'anchors-here') }, async () => {
    assert.match(anchor.placementProblem(), /inside the data directory/);
  });
  // Outside the data directory: fine.
  const worm = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-worm-'));
  try {
    await withConfig({ isProd: true, auditAnchorDirConfigured: true, auditAnchorDir: worm }, async () => {
      assert.equal(anchor.placementProblem(), null);
      const item = (await admin.get('/api/admin/security/status')).data.items.find((i) => i.name === 'Audit anchors outside the database');
      assert.notEqual(item.level, 'bad');
    });
  } finally { fs.rmSync(worm, { recursive: true, force: true }); }
  // Outside production the default directory is not a failure.
  assert.equal(anchor.placementProblem(), null);
});

// ---- 1c: Ed25519 signatures that verify with the public key only ----

test('GET /api/admin/security/signing-key publishes the Ed25519 public key (never the private one)', async () => {
  const r = await admin.get('/api/admin/security/signing-key');
  assert.equal(r.status, 200);
  assert.equal(r.data.algorithm, 'Ed25519');
  assert.match(r.data.public_key_pem, /BEGIN PUBLIC KEY/);
  assert.equal(r.data.key_id, signing.keyIdOf(r.data.public_key_pem));
  assert.ok(!JSON.stringify(r.data).includes(config.signingKey.toString('hex')), 'the private key is never served');
  assert.ok(!db.all(`SELECT value FROM settings`).some((s) => String(s.value).includes(config.signingKey.toString('hex'))), 'nor stored in the database');
  const pem = await admin.get('/api/admin/security/signing-key?format=pem');
  assert.match(pem.data, /BEGIN PUBLIC KEY/);
  assert.equal((await nav.get('/api/admin/security/signing-key')).status, 403);
});

async function rawExport() {
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'AdminPassw0rd!x' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return (await fetch(base + '/api/admin/audit/export', { headers: { Cookie: cookie } })).text();
}

test('the audit export manifest is signed: it verifies with the public key alone, and a re-MACed forgery does not', async () => {
  for (let i = 0; i < 3; i++) audit.log({ user: { username: 'system' }, action: 'test.signed-export', details: { i } });
  const text = await rawExport();
  const pub = signing.publicInfo().public_key_pem;
  const good = ex.verifyExport(text, { publicKey: pub });
  assert.equal(good.ok, true, good.errors.join('; '));
  assert.equal(good.signature.key_source, 'supplied');
  // Someone holding the index key (the database administrator) edits the manifest and recomputes its MAC:
  // the HMAC checks out, the signature does not.
  const lines = text.trim().split('\n');
  const m = JSON.parse(lines[lines.length - 1]);
  m.verify_with = 'trust me';
  m.mac = ex.manifestMac(m, config.indexKey);
  const forged = [...lines.slice(0, -1), JSON.stringify(m)].join('\n') + '\n';
  const f = ex.verifyExport(forged, { key: config.indexKey, publicKey: pub });
  assert.equal(f.ok, false);
  assert.match(f.errors.join(' '), /Ed25519 signature does not verify/);
  // A document signed by some other key does not pass for this server's.
  const other = signing.publicInfo(crypto.randomBytes(32)).public_key_pem;
  assert.equal(ex.verifyExport(text, { publicKey: other }).ok, false);
  // The offline verifier: --public-key, no secret.
  const file = path.join(dir, 'export.ndjson'); fs.writeFileSync(file, text);
  const bad = path.join(dir, 'forged.ndjson'); fs.writeFileSync(bad, forged);
  const pemFile = path.join(dir, 'signing.pem'); fs.writeFileSync(pemFile, pub);
  const { main } = require('../scripts/verify-audit-export');
  await quiet(() => {
    assert.equal(main([file, '--public-key', pemFile]), 0);
    assert.equal(main([bad, '--public-key', pemFile]), 1);
  });
});

test('a recovery-drill report is signed with Ed25519, and npm run verify-dr-report checks it with the public key only', async () => {
  const drill = require('../server/dr-drill');
  const report = { kind: 'suds-dr-drill', version: 1, signed_by: { algorithm: 'Ed25519', key_id: signing.publicInfo().key_id }, ok: true, rto: { seconds: 12 }, rpo: { seconds: 60 } };
  const doc = { report, integrity: drill.seal(report) };
  assert.ok(doc.integrity.ed25519_signature && doc.integrity.public_key_pem && doc.integrity.hmac_sha256);
  assert.equal(drill.verifyReport(doc), true);
  const dr = require('../server/dr-report');
  const pub = signing.publicInfo().public_key_pem;
  assert.equal(dr.verifyDoc(doc, { publicKeyPem: pub }).ok, true);
  // Edited, and even with the sha256 and HMAC recomputed by someone holding the index key: still refused.
  const edited = JSON.parse(JSON.stringify(doc)); edited.report.rto.seconds = 1;
  const s = drill.seal(edited.report); edited.integrity.sha256 = s.sha256; edited.integrity.hmac_sha256 = s.hmac_sha256;
  assert.equal(dr.verifyDoc(edited, { publicKeyPem: pub }).ok, false);
  // Re-signed with another key: fine against its own embedded key, refused against the published one.
  const otherSeed = crypto.randomBytes(32);
  const resigned = JSON.parse(JSON.stringify(edited));
  resigned.integrity.ed25519_signature = signing.sign(dr.canonical(resigned.report), otherSeed);
  resigned.integrity.public_key_pem = signing.publicInfo(otherSeed).public_key_pem;
  resigned.integrity.signing_key_id = signing.publicInfo(otherSeed).key_id;
  assert.equal(dr.verifyDoc(resigned, { publicKeyPem: pub }).ok, false);
  const good = path.join(dir, 'dr-good.json'); fs.writeFileSync(good, JSON.stringify(doc));
  const bad = path.join(dir, 'dr-bad.json'); fs.writeFileSync(bad, JSON.stringify(resigned));
  const pemFile = path.join(dir, 'signing2.pem'); fs.writeFileSync(pemFile, pub);
  const { main } = require('../scripts/verify-dr-report');
  await quiet(() => {
    assert.equal(main([good, '--public-key', pemFile]), 0);
    assert.equal(main([good]), 0, 'the embedded key proves integrity (with a note about origin)');
    assert.equal(main([bad, '--public-key', pemFile]), 1);
    assert.equal(main([]), 2);
  });
  assert.match(drill.textReport({ report: { ...report, started_at: 'x', finished_at: 'y', trigger: 't', by: 'b', server: { host: 'h', version: 'v' }, backup: {}, rto: { target_minutes: 60, met: true, seconds: 1 }, rpo: { target_hours: 1, met: true, seconds: 1 }, checks: [], failures: [], adjustments: [], counts: {} }, integrity: doc.integrity }), /Ed25519 signature/);
});

// ---- 2a/2b: the drill proves the escrowed keys and the offsite copy ----

const hex = (b) => b.toString('hex');
function keysFile(name, { enc = config.encryptionKey, idx = config.indexKey } = {}) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ SUDS_ENCRYPTION_KEY: hex(enc), SUDS_INDEX_KEY: hex(idx), created_at: new Date().toISOString() }), { mode: 0o600 });
  return f;
}

test('drill --keys-file: the escrowed key backup, not process memory, opens the backup — and a wrong one fails the drill', async () => {
  const drill = require('../server/dr-drill');
  const good = await drill.run({ keysFile: keysFile('keys-escrow.json'), fresh: true, by: { username: 'test' }, trigger: 'test' });
  assert.equal(good.report.ok, true, JSON.stringify(good.report.failures));
  assert.equal(good.report.keys.source, 'escrow file');
  assert.equal(good.report.keys.file, 'keys-escrow.json');
  assert.ok(good.report.checks.some((c) => c.name === 'The escrowed key file opens the backup' && c.ok));
  assert.ok(!JSON.stringify(good).includes(hex(config.encryptionKey)), 'the report carries fingerprints, never the keys');
  const bad = await drill.run({ keysFile: keysFile('keys-wrong.json', { enc: crypto.randomBytes(32), idx: crypto.randomBytes(32) }), by: { username: 'test' }, trigger: 'test' });
  assert.equal(bad.report.ok, false);
  assert.match(bad.report.failures.join(' '), /escrowed keys/);
  assert.ok(bad.report.checks.some((c) => c.name === 'The escrowed key file opens the backup' && !c.ok));
  assert.throws(() => drill.parseKeysFile('{"SUDS_ENCRYPTION_KEY":"abc"}'), /64 hex/);
  assert.throws(() => drill.parseKeysFile('not keys'), /no SUDS_ENCRYPTION_KEY/);
  assert.equal(drill.parseKeysFile(`SUDS_ENCRYPTION_KEY=${hex(config.encryptionKey)}\nSUDS_INDEX_KEY=${hex(config.indexKey)}\n`).indexKey.equals(config.indexKey), true, '.env-style lines work too');
  // The command line takes the same file.
  const { main } = require('../scripts/dr-drill');
  assert.equal(await quiet(() => main(['--keys-file', path.join(dir, 'no-such-keys.json')])), 2);
});

test('POST /api/admin/dr-drill accepts an uploaded escrowed key file (validated first, never stored)', async () => {
  assert.equal((await admin.post('/api/admin/dr-drill', { keys_file: '{"SUDS_ENCRYPTION_KEY":"nope"}' })).status, 400);
  const text = fs.readFileSync(keysFile('keys-upload.json'), 'utf8');
  const s = await admin.post('/api/admin/dr-drill', { keys_file: text, keys_file_name: 'suds-keys-KEEP-SECRET.json' });
  assert.equal(s.status, 202);
  let st;
  for (let i = 0; i < 300; i++) { st = (await admin.get('/api/admin/dr-drill')).data; if (!st.running) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(st.last.ok, true, JSON.stringify(st.last.failures));
  assert.equal(st.last.keys_source, 'uploaded escrow file');
  const logged = db.all(`SELECT details FROM audit_log WHERE action LIKE 'dr.drill%'`).map((r) => r.details).join(' ');
  assert.ok(!logged.includes(hex(config.encryptionKey)) && !logged.includes(hex(config.indexKey)), 'the keys never reach the audit log');
  assert.match(logged, /uploaded escrow file/);
});

test('with an offsite directory configured, the drill restores the offsite copy and says so; an unmounted share fails it', async () => {
  const drill = require('../server/dr-drill');
  const sb = require('../server/scheduled-backup');
  const offsite = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-offsite-'));
  try {
    db.setSetting('backup_offsite_dir', offsite);
    const made = await quiet(() => sb.run({ retain: 5, offsiteDir: offsite }));
    assert.ok(made.offsiteOk && made.offsiteFile);
    const r = await drill.run({ by: { username: 'test' }, trigger: 'test' });
    assert.equal(r.report.ok, true, JSON.stringify(r.report.failures));
    assert.equal(r.report.backup.copy, 'offsite');
    assert.equal(r.report.backup.dir, offsite);
    assert.ok(r.report.checks.some((c) => c.name === 'The offsite copy was restored' && c.ok));
    assert.match(drill.textReport(r), /the offsite copy/);
    assert.equal(drill.lastDrill().backup_copy, 'offsite');
    const loc = await drill.run({ copy: 'local', by: { username: 'test' }, trigger: 'test' });
    assert.equal(loc.report.backup.copy, 'local');
    // The share goes away: the drill still measures the local copy, and fails for the missing offsite one.
    fs.rmSync(offsite, { recursive: true, force: true });
    const gone = await drill.run({ by: { username: 'test' }, trigger: 'test' });
    assert.equal(gone.report.ok, false);
    assert.equal(gone.report.backup.copy, 'local');
    assert.match(gone.report.failures.join(' '), /not reachable/);
  } finally { db.run(`DELETE FROM settings WHERE key='backup_offsite_dir'`); fs.rmSync(offsite, { recursive: true, force: true }); }
});

// ---- 2c: decrypted copies left by a crash are swept ----

test('stale drill copies and plaintext temp files are securely removed; a drill another live process owns is left alone', async () => {
  const drill = require('../server/dr-drill');
  const root = path.join(dir, '.dr-drill'); fs.mkdirSync(root, { recursive: true });
  const mk = (name, owner) => { const d = path.join(root, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'suds.db'), 'PLAINTEXT DATABASE'); if (owner) fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify(owner)); return d; };
  const dead = mk('drill-crashed', { pid: 2147483646, started_at: new Date().toISOString() });
  const mine = mk('drill-mine-idle', { pid: process.pid, started_at: new Date().toISOString() });
  const live = mk('drill-other-live', { pid: process.ppid, started_at: new Date().toISOString() });
  const loose = path.join(dir, '.backup-1700000000000-abcdef01.db'); fs.writeFileSync(loose, 'PLAINTEXT');
  const old = (Date.now() - 2 * 3600_000) / 1000; fs.utimesSync(loose, old, old);
  const out = await quiet(() => drill.sweepStale());
  assert.ok(out.removed.includes('drill-crashed') && out.removed.includes('drill-mine-idle') && out.removed.includes('.backup-1700000000000-abcdef01.db'), JSON.stringify(out));
  assert.equal(fs.existsSync(dead), false); assert.equal(fs.existsSync(mine), false); assert.equal(fs.existsSync(loose), false);
  assert.equal(fs.existsSync(live), true, 'a drill another running process owns is not touched');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='dr.drill.swept'`));
  fs.rmSync(live, { recursive: true, force: true });
  // The overwrite really happens before the unlink: a descriptor held open sees zeros.
  const f = path.join(dir, 'secure-me.bin'); fs.writeFileSync(f, 'SECRET');
  const fd = fs.openSync(f, 'r');
  require('../server/backup').secureUnlink(f);
  const buf = Buffer.alloc(6); fs.readSync(fd, buf, 0, 6, 0); fs.closeSync(fd);
  assert.equal(buf.toString(), '\0'.repeat(6), 'the bytes were zeroed before the file was removed');
  assert.equal(fs.existsSync(f), false);
});

// ---- 2d: backups off in production ----

test('production with backups off: Security status, the Home alert and the startup log say so; the wizard defaults to every 4 hours', async () => {
  const saved = db.getSetting('backup_schedule_hours', null);
  db.run(`DELETE FROM settings WHERE key IN ('backup_schedule_hours','backup_schedule_minutes')`);
  try {
    const worm = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-worm2-'));
    await withConfig({ isProd: true, auditAnchorDirConfigured: true, auditAnchorDir: worm }, async () => {
      assert.match(require('../server/startup-checks').backupProblem(), /Scheduled backups are off/);
      assert.ok(require('../server/startup-checks').problems().some((p) => /Scheduled backups are off/.test(p)));
      const a = (await admin.get('/api/admin/security/alerts')).data.alerts;
      assert.deepEqual(a.map((x) => x.key), ['backups_off']);
      const items = (await admin.get('/api/admin/security/status')).data.items;
      const item = items.find((i) => i.name === 'Scheduled encrypted backups');
      assert.equal(item.level, 'bad'); assert.match(item.detail, /production server/);
      assert.equal(items.find((i) => i.name === 'Recovery point objective (worst case)').level, 'bad');
      assert.equal((await nav.get('/api/admin/security/alerts')).status, 403);
      const setup = require('../server/routes/setup');
      assert.deepEqual(setup.applyProductionDefaults(), ['backup_schedule_hours']);
      assert.equal(db.getSetting('backup_schedule_hours'), '4');
      assert.deepEqual(setup.applyProductionDefaults(), [], 'a choice already made is kept');
      assert.equal(require('../server/startup-checks').backupProblem(), null);
    });
    fs.rmSync(worm, { recursive: true, force: true });
    assert.deepEqual(require('../server/routes/setup').applyProductionDefaults({ isProd: false }), []);
    assert.deepEqual((await admin.get('/api/admin/security/alerts')).data.alerts, [], 'outside production nothing is raised');
  } finally { if (saved === null) db.run(`DELETE FROM settings WHERE key='backup_schedule_hours'`); else db.setSetting('backup_schedule_hours', saved); }
});

// ---- 3: frequent snapshots, RPO in minutes ----

test('backup_schedule_minutes: validated, snapshots rotate, the RPO shown is minutes, and the drill restores the newest snapshot', async () => {
  assert.equal((await admin.put('/api/admin/settings', { backup_schedule_minutes: 3 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { backup_schedule_minutes: 2.5 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { backup_snapshot_retain: 0 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { backup_schedule_minutes: 10, backup_snapshot_retain: 2, backup_schedule_hours: 24 })).status, 200);
  const sb = require('../server/scheduled-backup');
  db.run(`DELETE FROM settings WHERE key='last_snapshot_at'`);
  const first = await sb.snapshotIfDue();
  assert.ok(first && first.file, JSON.stringify(first));
  assert.equal(first.where, 'local');
  assert.equal(await sb.snapshotIfDue(), null, 'not due again for ten minutes');
  await new Promise((r) => setTimeout(r, 5)); await sb.snapshot();
  await new Promise((r) => setTimeout(r, 5)); const last = await sb.snapshot();
  const names = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(names.filter((f) => sb.SNAP_RE.test(f)).length, 2, 'rotated to backup_snapshot_retain');
  assert.ok(names.some((f) => sb.FILE_RE.test(f)), 'scheduled backups are not pruned by snapshot rotation');
  const plain = require('../server/backup').decrypt(fs.readFileSync(last.file));
  assert.equal(require('../server/backup').inspect(plain).schema_version, db.LATEST_SCHEMA_VERSION, 'a snapshot is a whole, readable database');
  const st = (await admin.get('/api/admin/security/status')).data.items;
  assert.match(st.find((i) => i.name === 'Recovery point objective (worst case)').value, /^10 min \(online snapshots\)/);
  assert.equal(st.find((i) => i.name === 'Frequent online snapshots').level, 'ok');
  const drill = require('../server/dr-drill');
  assert.equal(drill.latestBackup(), last.file, 'the newest copy, snapshot or backup, is what a drill restores');
  const r = await drill.run({ by: { username: 'test' }, trigger: 'test' });
  assert.equal(r.report.ok, true, JSON.stringify(r.report.failures));
  assert.equal(r.report.backup.file, path.basename(last.file));
  assert.ok(r.report.rpo.seconds < 60, 'the drill measures the snapshot age, not the daily backup');
  await admin.put('/api/admin/settings', { backup_schedule_minutes: 0 });
  assert.equal(await sb.snapshotIfDue(), null, 'off is off');
});
