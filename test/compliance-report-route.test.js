'use strict';
// The host compliance report inside the app: Settings → Security status carries every app-level line with its
// check id and rules (the one list), and the last report's host checks with its date; GET
// /api/admin/security/compliance-report (settings:manage) serves the signed report, JSON or HTML, and every
// view is audited, as is the server's first sight of a new report. Also: provisioned settings
// (server/provision.js) and the app-level checks run by scripts/compliance-check.js against a real database
// file, read-only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-compliance-route-'));
process.env.SUDS_DATA_DIR = dir;
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, stop, client, makeUser, db } = require('./helpers');
const config = require('../server/config');
const cr = require('../server/compliance-report');
const rules = require('../server/compliance-rules');
const signing = require('../server/signing');

const REPO = path.join(__dirname, '..');
let admin, nav;
before(async () => {
  await start();
  admin = client(); await admin.login('admin', 'AdminPassw0rd!x');
  const u = makeUser('crnav', 'navigator');
  nav = client(); await nav.login('crnav', u.password);
});
after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });

function writeReport({ stamp = new Date().toISOString(), seed = config.signingKey, checks } = {}) {
  const c = checks || [
    { id: 'host.disk_encryption', title: 'Data on an encrypted block device', result: 'pass', rules: rules.cite(['hipaa-312a2iv']), evidence: '/var/lib/suds on /dev/mapper/suds-data (LUKS2)', remediation: 'r' },
    { id: 'host.firewall', title: 'Host firewall active with only the expected ports', result: 'fail', rules: rules.cite(['hipaa-312e1']), evidence: 'ufw is inactive', remediation: 'enable ufw' },
    { id: 'host.time_sync', title: 'Clock synchronised (audit timestamps)', result: 'not-checked', rules: rules.cite(['hipaa-312b']), evidence: 'timedatectl is not available', remediation: 'r' },
  ];
  const id = `compliance-${stamp.replace(/[:.]/g, '-')}`;
  const report = { format: cr.FORMAT, version: 1, report_id: id, generated_at: stamp, host: { hostname: 'suds1', os: 'Ubuntu 24.04', suds_version: config.version, node_version: process.version, run_as: 'root' }, config: {}, risk_accepted: [], checks: c, summary: { counts: cr.counts(c), overall: cr.overall(c) }, scope: 's' };
  const doc = { report, integrity: cr.seal(report, seed) };
  fs.mkdirSync(path.join(dir, 'compliance'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'compliance', `${id}.json`), JSON.stringify(doc));
  return { id, doc };
}

test('Security status: every line carries its check id and rules from the one catalogue', async () => {
  const r = await admin.get('/api/admin/security/status');
  assert.equal(r.status, 200);
  const app = r.data.items.filter((i) => !String(i.group).startsWith('Host'));
  for (const i of app) {
    assert.ok(i.check_id && !i.check_id.startsWith('app.other.'), `"${i.name}" is in server/compliance-rules.js`);
    if (!rules.forItem(i.name).inAppOnly) assert.ok(i.rules.length, `"${i.name}" maps to a rule`);
    for (const x of i.rules) assert.match(x.cite, /CFR|Civ\. Code/);
  }
  const host = r.data.items.find((i) => i.check_id === 'host.report');
  assert.ok(host, 'a line for the host compliance check');
  assert.match(host.value, /no report yet/);
});

test('GET /api/admin/security/compliance-report: 404 before any report, settings:manage only', async () => {
  assert.equal((await admin.get('/api/admin/security/compliance-report')).status, 404);
  assert.equal((await nav.get('/api/admin/security/compliance-report')).status, 403);
  assert.equal((await client().get('/api/admin/security/compliance-report')).status, 401);
});

test('the last report: host checks on Security status with its date; served signed as JSON and HTML; views and first sight audited', async () => {
  const { id, doc } = writeReport();
  const st = (await admin.get('/api/admin/security/status')).data;
  const head = st.items.find((i) => i.check_id === 'host.report');
  assert.equal(head.level, 'bad', 'a failed host check makes the line red');
  assert.match(head.value, /^fail on \d{4}-\d{2}-\d{2} \(0 days ago\)/);
  assert.match(head.detail, /signature verifies/);
  assert.equal(st.compliance.report_id, id);
  assert.equal(st.compliance.signature_ok, true);
  const fw = st.items.find((i) => i.check_id === 'host.firewall');
  assert.equal(fw.level, 'bad'); assert.match(fw.detail, /ufw is inactive — enable ufw/); assert.match(fw.evidence, /^as of /);
  const tsync = st.items.find((i) => i.check_id === 'host.time_sync');
  assert.equal(tsync.level, 'warn', '"could not check" is not OK'); assert.equal(tsync.value, 'could not check');
  assert.equal(st.items.find((i) => i.check_id === 'host.disk_encryption').level, 'ok');
  const gen = db.all(`SELECT * FROM audit_log WHERE action='security.compliance_report.generated' AND entity_id=?`, id);
  assert.equal(gen.length, 1, 'recorded once');
  await admin.get('/api/admin/security/status');
  assert.equal(db.all(`SELECT * FROM audit_log WHERE action='security.compliance_report.generated' AND entity_id=?`, id).length, 1, 'not twice');
  assert.equal(JSON.parse(gen[0].details).signature, 'verified');

  const j = await admin.get('/api/admin/security/compliance-report');
  assert.equal(j.status, 200);
  assert.equal(j.data.verification.ok, true);
  assert.equal(j.data.report.report_id, id);
  assert.equal(cr.verifyDoc({ report: j.data.report, integrity: j.data.integrity }, { publicKeyPem: signing.publicInfo().public_key_pem }).ok, true);
  const h = await admin.raw('/api/admin/security/compliance-report?format=html');
  assert.equal(h.status, 200);
  assert.match(h.headers.get('content-type'), /text\/html/);
  assert.match(h.headers.get('content-disposition'), new RegExp(`${id}\\.html`));
  const html = await h.text();
  assert.equal(cr.verifyHtml(html, { publicKeyPem: signing.publicInfo().public_key_pem }).ok, true, 'the downloaded page verifies offline');
  assert.deepEqual(doc.report, cr.extractFromHtml(html).report);
  const views = db.all(`SELECT * FROM audit_log WHERE action='security.compliance_report.view' ORDER BY id`);
  assert.equal(views.length, 2);
  assert.deepEqual(views.map((v) => JSON.parse(v.details).format), ['json', 'html']);
  assert.ok(views.every((v) => v.username === 'admin'));
});

test('a report that does not verify with this server\'s key is shown as such, and its host lines are not trusted', async () => {
  writeReport({ stamp: new Date(Date.now() + 1000).toISOString(), seed: crypto.randomBytes(32) });
  const st = (await admin.get('/api/admin/security/status')).data;
  const head = st.items.find((i) => i.check_id === 'host.report');
  assert.equal(head.level, 'bad'); assert.match(head.detail, /does not verify/);
  assert.equal(st.items.filter((i) => i.check_id === 'host.firewall').length, 0, 'no host lines from an unverified report');
  const gen = db.one(`SELECT details, success FROM audit_log WHERE action='security.compliance_report.generated' ORDER BY id DESC LIMIT 1`);
  assert.equal(JSON.parse(gen.details).signature, 'does not verify'); assert.equal(gen.success, 0);
  // A newer, good, all-pass report: green when recent.
  writeReport({ stamp: new Date(Date.now() + 2000).toISOString(), checks: [{ id: 'host.os', title: 'OS', result: 'pass', rules: [], evidence: 'Ubuntu', remediation: '' }] });
  const ok = (await admin.get('/api/admin/security/status')).data.items.find((i) => i.check_id === 'host.report');
  assert.equal(ok.level, 'ok', ok.detail);
});

test('provisioned settings: applied once where unset, never over an administrator\'s choice, invalid ones refused and audited', () => {
  const provision = require('../server/provision');
  const offsite = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-offsite-'));
  const f = path.join(dir, 'provision.json');
  db.run(`DELETE FROM settings WHERE key IN ('backup_schedule_hours','backup_offsite_dir','dr_drill_monthly','mfa_require_all')`);
  db.setSetting('dr_drill_monthly', '0');
  fs.writeFileSync(f, JSON.stringify({ settings: { backup_schedule_hours: '4', backup_offsite_dir: offsite, dr_drill_monthly: '1', mfa_require_all: '1', org_name: 'nope', backup_retain_count: 'lots' } }));
  const out = provision.apply({ file: f });
  assert.deepEqual(out.applied.sort(), ['backup_offsite_dir', 'backup_schedule_hours', 'mfa_require_all']);
  assert.deepEqual(out.refused.map((r) => r.key).sort(), ['backup_retain_count', 'org_name']);
  assert.equal(db.getSetting('dr_drill_monthly'), '0', 'an existing choice is kept');
  assert.equal(db.getSetting('backup_offsite_dir'), offsite);
  const a = db.one(`SELECT details FROM audit_log WHERE action='settings.provisioned' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(JSON.parse(a.details).refused.sort(), ['backup_retain_count', 'org_name']);
  db.setSetting('backup_schedule_hours', '2');
  assert.deepEqual(provision.apply({ file: f }).applied, [], 'the next start changes nothing');
  assert.equal(db.getSetting('backup_schedule_hours'), '2');
  fs.writeFileSync(f, JSON.stringify({ settings: { backup_offsite_dir: '/nonexistent/share' } }));
  db.run(`DELETE FROM settings WHERE key='backup_offsite_dir'`);
  assert.match(provision.apply({ file: f }).refused[0].reason, /is the share mounted/);
  // Nor the server's own backups folder (1.25.5, H3).
  const ownBackups = path.join(require('../server/config').dataDir, 'backups'); fs.mkdirSync(ownBackups, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ settings: { backup_offsite_dir: ownBackups } }));
  assert.match(provision.apply({ file: f }).refused[0].reason, /outside the data directory/);
  assert.equal(db.getSetting('backup_offsite_dir', null), null);
  assert.deepEqual(provision.apply({ file: path.join(dir, 'missing.json') }), { applied: [], refused: [] });
  fs.rmSync(offsite, { recursive: true, force: true });
});

test('the compliance check reads a real database read-only: app lines, the chain and anchors verified now, a signed report', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-cc-app-'));
  const data = path.join(work, 'data'); const worm = path.join(work, 'worm'); fs.mkdirSync(data); fs.mkdirSync(worm);
  const env = { ...process.env, SUDS_ENV: 'test', SUDS_DATA_DIR: data, SUDS_DB_PATH: path.join(data, 'suds.db'), AUDIT_ANCHOR_DIR: worm, SUDS_ADMIN_PASSWORD: 'AdminPassw0rd!x' };
  const mk = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', `
    const db = require(${JSON.stringify(REPO)} + '/server/db'); db.open(process.env.SUDS_DB_PATH);
    require(${JSON.stringify(REPO)} + '/server/bootstrap').ensureBootstrap();
    const audit = require(${JSON.stringify(REPO)} + '/server/audit');
    for (let i = 0; i < 5; i++) audit.log({ user: { username: 'system' }, action: 'test.entry', details: { i } });
    audit.checkpoint(); require(${JSON.stringify(REPO)} + '/server/audit-anchor').write('manual'); db.close();`], { env, encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr);
  const hash = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
  const walBytes = () => (fs.existsSync(path.join(data, 'suds.db-wal')) ? fs.statSync(path.join(data, 'suds.db-wal')).size : 0);
  const before = [hash(path.join(data, 'suds.db')), walBytes()];
  const journals = () => ['suds.db-wal', 'suds.db-shm'].filter((f) => fs.existsSync(path.join(data, f)));
  const journalsBefore = journals();
  const run = () => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(REPO, 'scripts/compliance-check.js'), '--no-host', '--no-write', '--json'], { env, encoding: 'utf8', timeout: 60000 });
  let r = run();
  assert.equal(r.status, 1, 'backups are off in this database, so the run fails');
  const doc = JSON.parse(r.stdout);
  const by = Object.fromEntries(doc.report.checks.map((c) => [c.id, c]));
  assert.equal(by['host.audit_verify'].result, 'pass', by['host.audit_verify'].evidence);
  assert.match(by['host.audit_verify'].evidence, /chain: \d+ entries verify; anchors in .*: 1 \(1 matched\)/);
  assert.equal(by['app.backups'].result, 'fail');
  assert.equal(by['host.backup_files'].result, 'fail');
  assert.equal(by['host.dr_evidence'].result, 'fail');
  assert.equal(by['app.local_mode'].result, 'pass');
  assert.ok(by['app.mfa_required'].rules.some((x) => x.cite === '45 CFR §164.312(d)'));
  assert.deepEqual([hash(path.join(data, 'suds.db')), walBytes()], before, 'the database was not written');
  // Never opened in place: as root, a reader's -wal/-shm would be root's (and SUDS could not open its database).
  assert.deepEqual(journals(), journalsBefore, 'no -wal/-shm created beside the live database');
  const pem = signing.publicInfo(crypto.createHash('sha256').update('test-signing-key').digest()).public_key_pem;
  assert.equal(cr.verifyDoc(doc, { publicKeyPem: pem }).ok, true, 'signed with this server\'s signing key');
  // An audit entry rewritten in place: the check fails the chain.
  const tamper = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.env.SUDS_DB_PATH); d.exec("DROP TRIGGER IF EXISTS audit_no_update"); for (const t of d.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_log'").all()) d.exec('DROP TRIGGER "' + t.name + '"'); d.prepare("UPDATE audit_log SET details='{}' WHERE id=2").run(); d.close();`], { env, encoding: 'utf8' });
  assert.equal(tamper.status, 0, tamper.stderr);
  r = run();
  const again = Object.fromEntries(JSON.parse(r.stdout).report.checks.map((c) => [c.id, c]));
  assert.equal(again['host.audit_verify'].result, 'fail');
  assert.match(again['host.audit_verify'].evidence, /the audit chain does not verify/);
  fs.rmSync(work, { recursive: true, force: true });
});

test('Security status verifies the report with the compliance check\'s own public key when one is configured, never the service key', async () => {
  const cseed = crypto.randomBytes(32);
  const pub = path.join(dir, 'compliance-signing-key.pub.pem'); fs.writeFileSync(pub, signing.publicInfo(cseed).public_key_pem);
  const saved = config.compliancePublicKeyFile;
  config.compliancePublicKeyFile = pub;
  try {
    const { id } = writeReport({ stamp: new Date(Date.now() + 5000).toISOString(), seed: cseed, checks: [{ id: 'host.os', title: 'OS', result: 'pass', rules: [], evidence: 'Ubuntu', remediation: '' }] });
    let head = (await admin.get('/api/admin/security/status')).data.items.find((i) => i.check_id === 'host.report');
    assert.equal(head.level, 'ok', head.detail); assert.match(head.detail, /compliance check's own key/);
    const j = await admin.get('/api/admin/security/compliance-report');
    assert.equal(j.data.report.report_id, id); assert.equal(j.data.verification.ok, true); assert.equal(j.data.verification.key_source, 'compliance');
    // A report the service could have signed itself (its own key) does not verify once the compliance key is configured.
    writeReport({ stamp: new Date(Date.now() + 6000).toISOString(), seed: config.signingKey });
    head = (await admin.get('/api/admin/security/status')).data.items.find((i) => i.check_id === 'host.report');
    assert.equal(head.level, 'bad'); assert.match(head.detail, /does not verify/);
    config.compliancePublicKeyFile = path.join(dir, 'missing.pem');
    head = (await admin.get('/api/admin/security/status')).data.items.find((i) => i.check_id === 'host.report');
    assert.match(head.detail, /cannot be read/);
  } finally { config.compliancePublicKeyFile = saved; }
});

test('app checks: the drill report name from the database is never a path, and a planted symlink is neither followed nor echoed', () => {
  const ac = require('../scripts/compliance/app-checks');
  const saved = db.getSetting('dr_last_drill', null);
  const last = (report_file) => db.setSetting('dr_last_drill', JSON.stringify({ at: new Date().toISOString(), ok: true, checks_passed: 9, checks_total: 9, report_file, backup_copy: 'offsite', keys_source: 'escrowed key file' }));
  const name = 'dr-drill-2026-09-30T00-00-00-000Z.json';
  try {
    const secret = path.join(dir, 'secret.txt'); fs.writeFileSync(secret, 'TOP-SECRET-CONTENT');
    last('../../../../etc/shadow');
    let c = ac.drEvidence({ config, now: Date.now(), keys: {}, conf: {} });
    assert.equal(c.result, 'fail'); assert.match(c.evidence, /not a drill report file name/);
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.symlinkSync(secret, path.join(dir, 'backups', name));
    last(name);
    c = ac.drEvidence({ config, now: Date.now(), keys: {}, conf: {} });
    assert.equal(c.result, 'fail'); assert.match(c.evidence, /symbolic link/); assert.ok(!c.evidence.includes('TOP-SECRET'));
    fs.unlinkSync(path.join(dir, 'backups', name));
    fs.writeFileSync(path.join(dir, 'backups', name), 'TOP-SECRET-CONTENT');
    c = ac.drEvidence({ config, now: Date.now(), keys: {}, conf: {} });
    assert.match(c.evidence, /not valid JSON/); assert.ok(!c.evidence.includes('TOP-SECRET'));
    fs.unlinkSync(path.join(dir, 'backups', name));
  } finally { db.run(`DELETE FROM settings WHERE key='dr_last_drill'`); if (saved) db.setSetting('dr_last_drill', saved); }
});

test('app checks: on a new server no backup and no drill yet is "pending first run", not a failure; later it fails', () => {
  const ac = require('../scripts/compliance/app-checks');
  const saved = db.getSetting('dr_last_drill', null);
  db.run(`DELETE FROM settings WHERE key='dr_last_drill'`);
  const now = Date.now();
  const ago = (h) => ({ installedAt: new Date(now - h * 3600_000).toISOString() });
  try {
    let c = ac.drEvidence({ config, now, keys: {}, conf: ago(1) });
    assert.equal(c.result, 'warn'); assert.match(c.evidence, /pending first run \(expected on day one\)/);
    c = ac.drEvidence({ config, now, keys: {}, conf: ago(60 * 24) });
    assert.equal(c.result, 'fail'); assert.match(c.evidence, /no recovery drill has been run/);
    assert.equal(ac.drEvidence({ config, now, keys: {}, conf: {} }).result, 'fail', 'no install date: no allowance');
    const offsite = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-offsite-'));
    db.setSetting('backup_schedule_hours', '4'); db.setSetting('backup_offsite_dir', offsite);
    fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true });
    c = ac.backupFiles({ config, db, now, conf: ago(1) });
    assert.equal(c.result, 'warn', c.evidence); assert.match(c.evidence, /pending first run/);
    c = ac.backupFiles({ config, db, now, conf: ago(48) });
    assert.equal(c.result, 'fail', 'two days on, still no backup: a failure');
    fs.rmSync(offsite, { recursive: true, force: true });
    c = ac.backupFiles({ config, db, now, conf: ago(1) });
    assert.equal(c.result, 'fail', 'an offsite share that is not there is never "pending"'); assert.match(c.evidence, /is the share mounted/);
    // The server's own backups folder as the "offsite" one (1.25.5, H3): its backups are there, and still it fails.
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true }); db.setSetting('backup_offsite_dir', path.join(dir, 'backups'));
    c = ac.backupFiles({ config, db, now, conf: ago(48) });
    assert.equal(c.result, 'fail'); assert.match(c.evidence, /inside the data directory \(or contains it\), so it is not an offsite copy/);
    db.run(`DELETE FROM settings WHERE key='backup_offsite_dir'`);
  } finally { if (saved) db.setSetting('dr_last_drill', saved); }
});

test('provisioned settings may only tighten: a weaker value is refused, never written, and never counts as chosen', () => {
  const provision = require('../server/provision');
  const f = path.join(dir, 'provision-weak.json');
  const keys = ['mfa_require_all', 'self_signup', 'dr_drill_monthly', 'backup_schedule_hours'];
  const saved = Object.fromEntries(keys.map((k) => [k, db.getSetting(k, null)]));
  db.run(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`, ...keys);
  try {
    fs.writeFileSync(f, JSON.stringify({ settings: { mfa_require_all: '0', self_signup: '1', dr_drill_monthly: '0', backup_schedule_hours: '48' } }));
    const out = provision.apply({ file: f });
    assert.deepEqual(out.applied, []);
    assert.deepEqual(out.refused.map((r) => r.key).sort(), keys.slice().sort());
    for (const r of out.refused) assert.match(r.reason, /may only tighten/);
    for (const k of keys) assert.equal(db.getSetting(k, null), null, `${k} was not written, so an administrator still chooses it`);
    assert.equal(provision.apply({ file: f }).applied.length, 0);
    // The stricter values are accepted.
    fs.writeFileSync(f, JSON.stringify({ settings: { mfa_require_all: '1', self_signup: '0', dr_drill_monthly: '1', backup_schedule_hours: '24' } }));
    assert.deepEqual(provision.apply({ file: f }).applied.sort(), keys.slice().sort());
    assert.equal(db.getSetting('self_signup'), '0');
    assert.equal(provision.KEYS.backup_schedule_hours('0'), false);
    assert.equal(provision.KEYS.backup_schedule_hours('4'), true);
  } finally {
    db.run(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`, ...keys);
    for (const [k, v] of Object.entries(saved)) if (v !== null) db.setSetting(k, v);
  }
});
