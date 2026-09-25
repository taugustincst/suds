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
