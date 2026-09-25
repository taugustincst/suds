'use strict';
// The evidence county IT asks for: audit anchors outside the database (a wholesale rewrite of the chain by
// someone holding the database and its key is caught), the auditor's export and its offline verifier, the
// disaster-recovery drill (restores a real backup into a throwaway copy, never the live database), the
// identity settings (SSO required with break-glass accounts, MFA for every role) and Security status.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-evidence-'));
process.env.SUDS_DATA_DIR = dir;
process.env.AUDIT_ANCHOR_DIR = path.join(dir, 'worm');
fs.mkdirSync(process.env.AUDIT_ANCHOR_DIR);
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { start, stop, client, makeUser, db } = require('./helpers');
const config = require('../server/config');
const audit = require('../server/audit');
const anchor = require('../server/audit-anchor');
const ex = require('../server/audit-export');

let admin, nav, navUser;
// The helper client parses anything JSON-ish; an export is NDJSON text, so it is fetched raw.
async function rawExport(query = '') {
  const base = await start();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'AdminPassw0rd!x' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(base + '/api/admin/audit/export' + query, { headers: { Cookie: cookie } });
  return { status: res.status, headers: res.headers, data: await res.text() };
}
before(async () => {
  await start();
  admin = client(); await admin.login('admin', 'AdminPassw0rd!x');
  navUser = makeUser('evnav', 'navigator');
  nav = client(); await nav.login('evnav', navUser.password);
});
after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });

// Rewrite the chain from `fromId` on, the way someone holding the database and the index key could.
function rewriteChainFrom(fromId, change) {
  const rows = db.all(`SELECT * FROM audit_log WHERE id >= ? ORDER BY id`, fromId);
  let prev = db.one(`SELECT hash FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 1`, fromId)?.hash || rows[0].prev_hash;
  for (const r of rows) {
    const row = { ...r, prev_hash: prev, ...(r.id === fromId ? change : {}) };
    const hash = 'v2:' + crypto.createHmac('sha256', config.indexKey).update(ex.payloadOf(row)).digest('hex');
    db.run(`UPDATE audit_log SET details=?, prev_hash=?, hash=? WHERE id=?`, row.details, prev, hash, r.id);
    prev = hash;
  }
  audit.checkpoint();
}
function cleanAnchors() { for (const f of fs.readdirSync(config.auditAnchorDir)) { const p = path.join(config.auditAnchorDir, f); fs.chmodSync(p, 0o600); fs.unlinkSync(p); } }

test('the export payload is the one the audit chain hashes', () => {
  audit.log({ user: { username: 'system' }, action: 'test.payload', details: { n: 1 } });
  const r = db.one(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 1`);
  assert.equal(r.hash, 'v2:' + crypto.createHmac('sha256', config.indexKey).update(ex.payloadOf(r)).digest('hex'));
  const a = { v: 1, kind: 'suds-audit-anchor', at: 'x', reason: 'r', head_id: 1, head_hash: 'h', first_id: 1, rows: 1, host: 'h', key_id: 'k', prev_mac: null };
  assert.equal(ex.anchorMac(a, config.indexKey), anchor.macOf(a), 'the offline verifier computes anchor MACs the same way');
});

test('anchors: written to the configured directory, write-once, and they verify', () => {
  cleanAnchors();
  const a1 = anchor.write('manual');
  audit.log({ user: { username: 'system' }, action: 'test.between' });
  const a2 = anchor.write('schedule');
  assert.ok(a1 && a2 && a2.head_id > a1.head_id);
  assert.equal(a2.prev_mac, a1.mac, 'each anchor names the one before it');
  const files = fs.readdirSync(config.auditAnchorDir);
  assert.equal(files.length, 2);
  assert.equal(fs.statSync(path.join(config.auditAnchorDir, files[0])).mode & 0o222, 0, 'anchor files are made read-only');
  const v = anchor.verify();
  assert.equal(v.ok, true, JSON.stringify(v.bad));
  assert.equal(v.matched, 2);
});

test('two anchors of the same head in the same millisecond are both written, in order', () => {
  cleanAnchors();
  audit.log({ user: { username: 'system' }, action: 'test.same-ms' });
  // Many back-to-back pairs: before the fix, a pair landing in one millisecond shared a file name and the
  // second anchor (a restore's, in the flaky case) was silently dropped.
  for (let i = 0; i < 50; i++) { anchor.write('manual'); anchor.write('restore'); }
  const files = anchor.list();
  assert.equal(files.length, 100);
  const ats = files.map((f) => Date.parse(f.anchor.at));
  assert.ok(ats.every((t, i) => i === 0 || t > ats[i - 1]), 'anchor times strictly increase in file order');
  assert.equal(files.filter((f) => f.anchor.reason === 'restore').length, 50);
  assert.equal(anchor.verify().ok, true);
  cleanAnchors();
});

test('anchors catch a chain rewritten wholesale with the key, which the in-database checks cannot', () => {
  cleanAnchors();
  for (let i = 0; i < 3; i++) audit.log({ user: { username: 'system' }, action: 'test.fill', details: { i } });
  const target = db.one(`SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 2`).id;
  anchor.write('schedule');
  audit.log({ user: { username: 'system' }, action: 'test.after' });
  rewriteChainFrom(target, { details: JSON.stringify({ i: 'rewritten' }) });
  assert.equal(audit.verifyChain().ok, true, 'the rewritten chain passes every check inside the database');
  const v = anchor.verify();
  assert.equal(v.ok, false, 'but not against the anchor written before the rewrite');
  assert.match(v.bad[0].reason, /rewritten/);
});

test('anchors catch truncation, a removed anchor file and a forged one; a retention purge is not tampering', async () => {
  cleanAnchors();
  audit.log({ user: { username: 'system' }, action: 'test.t1' });
  const a1 = anchor.write('manual');
  audit.log({ user: { username: 'system' }, action: 'test.t2' });
  const a2 = anchor.write('manual');
  audit.log({ user: { username: 'system' }, action: 'test.t3' });
  anchor.write('manual');
  assert.equal(anchor.verify().ok, true);
  // Remove the middle anchor: the sequence breaks.
  const mid = fs.readdirSync(config.auditAnchorDir).sort()[1];
  const midPath = path.join(config.auditAnchorDir, mid); const midBody = fs.readFileSync(midPath, 'utf8');
  fs.chmodSync(midPath, 0o600); fs.unlinkSync(midPath);
  assert.match(anchor.verify().bad[0].reason, /sequence/);
  fs.writeFileSync(midPath, midBody);
  // A forged anchor (edited hash, MAC left as it was) does not verify.
  const forged = JSON.parse(midBody); forged.head_hash = 'v2:' + '0'.repeat(64);
  fs.writeFileSync(midPath, JSON.stringify(forged));
  assert.match(anchor.verify().bad.map((b) => b.reason).join(' '), /does not verify/);
  fs.writeFileSync(midPath, midBody);
  assert.equal(anchor.verify().ok, true);
  // A drill restoring an older copy: anchors beyond it are "newer", not truncation, only when told so.
  assert.ok(a2.head_id > a1.head_id);
  // Truncation of the newest entries (the head checkpoint is re-sealed, as a key holder could).
  const max = db.one(`SELECT MAX(id) m FROM audit_log`).m;
  db.run(`DELETE FROM audit_log WHERE id > ?`, a2.head_id - 1);
  audit.checkpoint();
  const t = anchor.verify();
  assert.equal(t.ok, false);
  assert.match(t.bad.map((b) => b.reason).join(' '), /removed|ends at entry/);
  assert.equal(anchor.verify({ tolerateNewer: true }).bad.some((b) => /ends at entry/.test(b.reason)), false);
  assert.ok(max > a2.head_id - 1);
  // Put a consistent state back for the tests after this one.
  db.run(`DELETE FROM audit_log`); audit.log({ user: { username: 'system' }, action: 'test.reset' }); audit.checkpoint(); cleanAnchors();
  // A retention purge removes anchored entries legitimately, and records that it did.
  audit.log({ user: { username: 'system' }, action: 'test.old' });
  anchor.write('manual');
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(audit.purge(0) > 0);
  const p = anchor.verify();
  assert.equal(p.ok, true, JSON.stringify(p.bad));
  assert.equal(p.purged, 1);
  assert.equal(audit.verifyChain().ok, true);
  // A restore replaces the database (a new generation): the older anchors cannot match it, and are
  // accepted only once the restore itself has been anchored.
  audit.log({ user: { username: 'system' }, action: 'test.before-restore' });
  anchor.write('manual');
  const gen = db.getSetting('db_generation', null);
  db.setSetting('db_generation', crypto.randomUUID());
  assert.match(anchor.verify().bad[0].reason, /no restore was anchored/);
  anchor.write('restore');
  const rv = anchor.verify();
  assert.equal(rv.ok, true, JSON.stringify(rv.bad));
  // The restored chain is a prefix of the old one, so an anchor inside it must still match: a restore
  // cannot be used to launder a rewrite.
  const anchoredEarlier = db.one(`SELECT MIN(id) m FROM audit_log`).m;
  audit.log({ user: { username: 'system' }, action: 'test.after-restore' });
  const firstPre = fs.readdirSync(config.auditAnchorDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(config.auditAnchorDir, f), 'utf8'))).find((x) => x.reason !== 'restore' && x.head_id >= anchoredEarlier);
  assert.ok(firstPre);
  rewriteChainFrom(firstPre.head_id, { details: JSON.stringify({ laundered: true }) });
  assert.match(anchor.verify().bad.map((b) => b.reason).join(' '), /rewritten/);
  if (gen === null) db.run(`DELETE FROM settings WHERE key='db_generation'`); else db.setSetting('db_generation', gen);
  // Anchors of another installation sharing the directory are counted, not checked.
  const inst = db.getSetting('audit_anchor_install');
  db.setSetting('audit_anchor_install', 'someone-else');
  const ov = anchor.verify();
  assert.equal(ov.ok, true); assert.equal(ov.other_install, ov.total);
  db.setSetting('audit_anchor_install', inst);
  cleanAnchors();
});

test('an anchor directory that is configured but missing is reported, never created', () => {
  const saved = config.auditAnchorDir;
  config.auditAnchorDir = path.join(dir, 'not-mounted');
  try {
    assert.equal(anchor.safeWrite('schedule'), null);
    assert.equal(fs.existsSync(config.auditAnchorDir), false);
    assert.match(db.getSetting('audit_anchor_last_status'), /^failed: .*does not exist/);
  } finally { config.auditAnchorDir = saved; }
});

test('GET /api/admin/audit/export: NDJSON with a manifest that verifies offline, and is audited', async () => {
  cleanAnchors();
  for (let i = 0; i < 5; i++) audit.log({ user: { username: 'system' }, action: 'test.export', details: { i } });
  anchor.write('manual');
  audit.log({ user: { username: 'system' }, action: 'test.export.after' });
  const r = await rawExport();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /ndjson/);
  const lines = r.data.trim().split('\n');
  assert.equal(JSON.parse(lines[0]).type, 'header');
  const manifest = JSON.parse(lines[lines.length - 1]);
  assert.equal(manifest.type, 'manifest');
  assert.equal(manifest.anchors.length, 1, 'the anchor inside the range travels with the export');
  const withKey = ex.verifyExport(r.data, { key: config.indexKey });
  assert.equal(withKey.ok, true, withKey.errors.join('; '));
  assert.ok(withKey.keyed_checked > 5 && withKey.anchors_matched === 1);
  const noKey = ex.verifyExport(r.data);
  assert.equal(noKey.ok, true, noKey.errors.join('; '));
  assert.ok(noKey.keyed_unchecked > 0, 'without the key, keyed entries are linkage-checked only, and it says so');
  // An edited entry: the digest, and with the key the entry itself, give it away.
  const tampered = r.data.replace('"test.export"', '"test.exporx"');
  assert.equal(ex.verifyExport(tampered, { key: config.indexKey }).ok, false);
  assert.equal(ex.verifyExport(tampered).ok, false);
  // A cut-short file has no manifest.
  assert.equal(ex.verifyExport(lines.slice(0, -1).join('\n')).ok, false);
  const logged = db.one(`SELECT details FROM audit_log WHERE action='audit.export' ORDER BY id DESC LIMIT 1`);
  assert.ok(logged, 'the export is itself audited');
  // A range by id.
  const first = JSON.parse(lines[1]).id;
  const part = await rawExport(`?from_id=${first + 1}&to_id=${first + 2}`);
  const pv = ex.verifyExport(part.data, { key: config.indexKey });
  assert.equal(pv.entries, 2); assert.equal(pv.ok, true, pv.errors.join('; '));
  assert.equal((await admin.get('/api/admin/audit/export?from_id=abc')).status, 400);
  assert.equal((await nav.get('/api/admin/audit/export')).status, 403, 'audit:read only');
});

test('npm run verify-audit-export: exit 0 on a good export, 1 on a tampered one', async () => {
  const r = await rawExport();
  const good = path.join(dir, 'good.ndjson'); fs.writeFileSync(good, r.data);
  const bad = path.join(dir, 'bad.ndjson'); fs.writeFileSync(bad, r.data.replace('"test.export"', '"test.exporx"'));
  const { main } = require('../scripts/verify-audit-export');
  const log = console.log; console.log = () => {};
  try {
    assert.equal(main([good, '--key', config.indexKey.toString('hex'), '--anchors', config.auditAnchorDir]), 0);
    assert.equal(main([good]), 0);
    assert.equal(main([bad, '--key', config.indexKey.toString('hex')]), 1);
    assert.equal(main([]), 2);
  } finally { console.log = log; }
});

test('POST /api/admin/audit/anchor writes an anchor; GET verify reports the anchors', async () => {
  const w = await admin.post('/api/admin/audit/anchor', {});
  assert.equal(w.status, 200); assert.ok(w.data.anchor.head_id);
  const v = await admin.get('/api/admin/audit/verify');
  assert.equal(v.status, 200);
  assert.equal(v.data.anchors.ok, true);
  assert.ok(v.data.anchors.matched >= 1);
  assert.equal((await nav.post('/api/admin/audit/anchor', {})).status, 403);
});

test('recovery drill: restores the newest backup into a throwaway copy, proves it, and never touches the live database', async () => {
  const drill = require('../server/dr-drill');
  assert.equal((await nav.post('/api/admin/dr-drill', {})).status, 403);
  assert.equal((await nav.get('/api/admin/dr-drill')).status, 403);
  const before = { users: db.one(`SELECT COUNT(*) n FROM users`).n, clients: db.one(`SELECT COUNT(*) n FROM clients`).n };
  const { encrypt } = require('../server/crypto');
  db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc) VALUES(?,?,?,?)`, crypto.randomUUID(), 'C26-DR01', encrypt('Drill'), encrypt('Person'));
  before.clients++;
  const s = await admin.post('/api/admin/dr-drill', {});
  assert.equal(s.status, 202);
  assert.equal((await admin.post('/api/admin/dr-drill', {})).status, 409, 'one drill at a time');
  let st;
  for (let i = 0; i < 300; i++) { st = (await admin.get('/api/admin/dr-drill')).data; if (!st.running) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(st.running, null, 'the drill finished');
  const last = st.last;
  assert.ok(last, 'and was recorded');
  assert.equal(last.ok, true, JSON.stringify(last.failures));
  assert.ok(last.checks_total >= 8 && last.checks_passed === last.checks_total);
  assert.ok(last.rto_seconds > 0 && last.rpo_seconds >= 0);
  // The report on disk is signed and verifies; an edited one does not.
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'backups', last.report_file), 'utf8'));
  assert.equal(drill.verifyReport(doc), true);
  assert.ok(fs.existsSync(path.join(dir, 'backups', last.report_file.replace(/\.json$/, '.txt'))));
  assert.equal(doc.report.backup.made_for_drill, true, 'with no backup on disk, one was taken first');
  assert.equal(doc.report.counts.restored.clients, before.clients);
  assert.ok(doc.report.checks.some((c) => /second-factor/.test(c.name) && c.ok));
  assert.ok(doc.report.decrypt_sample.tried >= 2 && doc.report.decrypt_sample.failed === 0);
  doc.report.rto.seconds = 1;
  assert.equal(drill.verifyReport(doc), false);
  // The live database: no drill account, the same rows, and the throwaway copy is gone.
  assert.equal(db.one(`SELECT COUNT(*) n FROM users WHERE username LIKE 'dr-drill-%'`).n, 0);
  assert.equal(db.one(`SELECT COUNT(*) n FROM users`).n, before.users);
  assert.equal(db.one(`SELECT COUNT(*) n FROM clients`).n, before.clients);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.dr-drill')), []);
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='dr.drill' AND success=1`));
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='dr.drill.start'`));
});

test('recovery drill: a backup made with other keys fails the drill, and the failure is recorded', async () => {
  const drill = require('../server/dr-drill');
  const bogus = path.join(dir, 'backups', 'suds-2020-01-01T00-00-00-000Z.db.enc');
  fs.writeFileSync(bogus, crypto.randomBytes(200));
  const out = await drill.run({ backupFile: bogus, by: { username: 'test' }, trigger: 'test' });
  fs.unlinkSync(bogus);
  assert.equal(out.report.ok, false);
  assert.match(out.report.failures.join(' '), /could not be read/);
  assert.equal(drill.lastDrill().ok, false);
  const s = (await admin.get('/api/admin/security/status')).data;
  assert.equal(s.items.find((i) => i.name === 'Last recovery drill').level, 'bad');
});

test('monthly drill is off by default and is a validated setting', async () => {
  const drill = require('../server/dr-drill');
  assert.equal(drill.runIfDue(), null);
  assert.equal((await admin.put('/api/admin/settings', { dr_drill_monthly: 'yes' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { dr_rto_target_minutes: -1 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { dr_drill_monthly: '0', dr_rto_target_minutes: 30, dr_rpo_target_hours: 24 })).status, 200);
  assert.deepEqual(drill.targets(), { rto_minutes: 30, rpo_hours: 24 });
});

test('MFA for every role is an explicit switch, and the report lists who has not enrolled', async () => {
  assert.equal((await admin.put('/api/admin/settings', { mfa_require_all: '1' })).status, 200);
  const s = (await admin.get('/api/admin/settings')).data;
  assert.deepEqual([...s.policy.mfaRequiredRoles].sort(), ['admin', 'clinician', 'finance', 'navigator', 'readonly', 'supervisor']);
  assert.equal(s.policy.mfaRequireAll, true);
  const rep = await admin.get('/api/admin/security/mfa-report');
  assert.equal(rep.status, 200);
  const row = rep.data.without.find((u) => u.username === 'evnav');
  assert.ok(row && row.required === true && row.deadline);
  assert.ok(rep.data.coverage_pct < 100);
  assert.equal((await nav.get('/api/admin/security/mfa-report')).status, 403);
  assert.equal((await admin.put('/api/admin/settings', { mfa_require_all: '0' })).status, 200);
});

test('SSO required: refused until OIDC is configured and a break-glass admin is named; then passwords work only for that account', async () => {
  assert.equal((await admin.put('/api/admin/settings', { sso_required: '1', sso_emergency_accounts: 'admin' })).status, 400, 'no identity provider configured');
  const saved = { ...config.oidc };
  config.oidc.enabled = true; config.oidc.issuer = 'https://idp.example.gov';
  try {
    assert.equal((await admin.put('/api/admin/settings', { sso_required: '1' })).status, 400, 'no emergency account named');
    assert.equal((await admin.put('/api/admin/settings', { sso_required: '1', sso_emergency_accounts: 'evnav' })).status, 400, 'the emergency account must be an administrator');
    assert.equal((await admin.put('/api/admin/settings', { sso_required: '1', sso_emergency_accounts: 'admin' })).status, 200);
    const n = client(); const r = await n.post('/api/auth/login', { username: 'evnav', password: navUser.password });
    assert.equal(r.status, 403); assert.equal(r.data.ssoRequired, true);
    assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='auth.login.sso_required' AND username='evnav'`));
    const bad = await client().post('/api/auth/login', { username: 'evnav', password: 'wrong-Passw0rd!' });
    assert.equal(bad.status, 401, 'a wrong password still gets the ordinary answer');
    const a = client(); const ok = await a.post('/api/auth/login', { username: 'admin', password: 'AdminPassw0rd!x' });
    assert.equal(ok.status, 200, 'the break-glass administrator can still sign in with a password');
    const row = db.one(`SELECT details FROM audit_log WHERE action IN ('auth.login','auth.login.mfa_pending') AND username='admin' ORDER BY id DESC LIMIT 1`);
    assert.equal(JSON.parse(row.details).emergency_account, true, 'and that sign-in is marked as break-glass');
    const st = (await admin.get('/api/admin/security/status')).data;
    assert.match(st.items.find((i) => i.name === 'Password sign-in').value, /disabled except/);
  } finally {
    await admin.put('/api/admin/settings', { sso_required: '0' });
    Object.assign(config.oidc, saved);
  }
  const back = await client().post('/api/auth/login', { username: 'evnav', password: navUser.password });
  assert.equal(back.status, 200, 'switched off again, passwords work for everyone');
});

test('Security status: every group reported, admin only, and honest about attestation', async () => {
  const r = await admin.get('/api/admin/security/status');
  assert.equal(r.status, 200);
  const groups = new Set(r.data.items.map((i) => i.group));
  for (const g of ['Identity', 'Backups and recovery', 'Audit', 'Encryption and keys', 'Data lifecycle', 'Platform']) assert.ok(groups.has(g), g);
  for (const name of ['Two-step verification coverage', 'Single sign-on (OIDC)', 'Password policy', 'Session timeouts', 'Scheduled encrypted backups', 'Offsite copy', 'Last recovery drill', 'Audit chain verification', 'Audit anchors outside the database', 'PHI encryption key', 'Client record retention', 'HTTPS', 'Local mode (offline copies on devices)', 'Version'])
    assert.ok(r.data.items.some((i) => i.name === name), name);
  for (const i of r.data.items) assert.ok(['ok', 'warn', 'bad', 'info'].includes(i.level));
  assert.match(r.data.attestation, /no SOC 2/);
  assert.equal((await nav.get('/api/admin/security/status')).status, 403);
});
