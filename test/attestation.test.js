'use strict';
// The authenticator allow-list for passkeys (docs/FINGERPRINT.md, "Authenticator allow-list"; released in 1.21.0, not
// yet released): attestation verified with node:crypto alone (server/attestation.js) against root certificates from a
// FIDO Metadata Service BLOB an administrator uploads (server/authenticator-allowlist.js). Every certificate here is
// made fresh by the test helper test/x509.js (test keys only), and the BLOBs are signed under a test root that the
// server trusts only because SUDS_ENV is 'test' (SUDS_TEST_FIDO_MDS_ROOT; never in production).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const X = require('./x509');
const { SoftAuthenticator, cbor } = require('./authenticator');
const A = require('../server/attestation');
const W = require('../server/webauthn');

const PW = 'StaffPassw0rd!x';
const APW = 'AdminPassw0rd!x';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const aaguidBuf = (s) => Buffer.from(s.replace(/-/g, ''), 'hex');
const AAGUID = '5ca1ab1e-0000-4000-8000-00000000c0de';
const OTHER_AAGUID = '0ddba115-0000-4000-8000-000000000bad';
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const sized = (b) => Buffer.concat([u16(b.length), b]);

// ---- attestation statements, as authenticators make them ----
const PACKED_SUBJECT = [['C', 'US'], ['O', 'SUDS test maker'], ['OU', 'Authenticator Attestation'], ['CN', 'SUDS test batch']];
/** A `packed` full attestation: a batch certificate issued by `issuer` ({ keys, subject }), signing authData || hash. */
function packedFull(issuer, { subject = PACKED_SUBJECT, aaguid, ext = true, criticalExt = false, badSig = false, ca = false, version = 3, notAfter } = {}) {
  return (authData, cdh, a) => {
    const k = X.ecKeys();
    const der = X.cert({ subject, issuer: issuer.subject, publicKey: k.publicKey, signKey: issuer.keys.privateKey, version, notAfter,
      extensions: [X.EXT.basicConstraints(ca), ...(ext ? [X.EXT.aaguid(aaguid ? aaguidBuf(aaguid) : a.aaguid, criticalExt)] : [])] });
    let sig = crypto.sign('sha256', Buffer.concat([authData, cdh]), { key: k.privateKey, dsaEncoding: 'der' });
    if (badSig) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 1; }
    return { fmt: 'packed', attStmt: new Map([['alg', -7], ['sig', sig], ['x5c', [der]]]) };
  };
}
/** `packed` self attestation: signed with the credential's own key. */
const packedSelf = () => (authData, cdh, a) => ({ fmt: 'packed', attStmt: new Map([['alg', -7], ['sig', a.sign(Buffer.concat([authData, cdh]))]]) });
/** `fido-u2f`: one P-256 certificate, signing 0x00 || rpIdHash || hash || credential id || the public key point. */
function u2f(issuer, { keys = X.ecKeys() } = {}) {
  const der = X.cert({ subject: [['CN', 'SUDS test U2F']], issuer: issuer.subject, publicKey: keys.publicKey, signKey: issuer.keys.privateKey, extensions: [X.EXT.basicConstraints(false)] });
  return { der, fn: (authData, cdh, a) => {
    const jwk = a.keys.publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const data = Buffer.concat([Buffer.from([0]), authData.subarray(0, 32), cdh, a.credentialId, point]);
    return { fmt: 'fido-u2f', attStmt: new Map([['sig', crypto.sign('sha256', data, { key: keys.privateKey, dsaEncoding: 'der' })], ['x5c', [der]]]) };
  } };
}
/** `tpm` (TPM 2.0) for an RS256 credential: pubArea, certInfo, and the attestation identity key's certificate. */
function tpmAttest(issuer, bend = {}) {
  return (authData, cdh, a) => {
    const n = Buffer.from(a.keys.publicKey.export({ format: 'jwk' }).n, 'base64url');
    const pubArea = Buffer.concat([u16(0x0001), u16(0x000b), u32(0x00060472), sized(Buffer.alloc(0)), u16(0x0010), u16(0x0010), u16(2048), u32(0), sized(bend.otherKey ? crypto.randomBytes(256) : n)]);
    const extra = sha256(Buffer.concat([authData, bend.otherHash ? crypto.randomBytes(32) : cdh]));
    const nm = Buffer.concat([u16(0x000b), bend.otherName ? crypto.randomBytes(32) : sha256(pubArea)]);
    const certInfo = Buffer.concat([u32(bend.magic || 0xff544347), u16(0x8017), sized(Buffer.concat([u16(0x000b), crypto.randomBytes(32)])), sized(extra), Buffer.alloc(17), Buffer.alloc(8), sized(nm), sized(Buffer.concat([u16(0x000b), crypto.randomBytes(32)]))]);
    const aik = X.rsaKeys();
    const der = X.cert({ subject: bend.subject || [], issuer: issuer.subject, publicKey: aik.publicKey, signKey: issuer.keys.privateKey,
      extensions: [X.EXT.basicConstraints(false), ...(bend.noSan ? [] : [bend.san || X.EXT.sanTpm()]), ...(bend.noEku ? [] : [X.EXT.eku('2.23.133.8.3')]), X.EXT.aaguid(a.aaguid)] });
    const sig = crypto.sign('sha256', certInfo, aik.privateKey);
    return { fmt: 'tpm', attStmt: new Map([['ver', '2.0'], ['alg', -257], ['x5c', [der]], ['sig', sig], ['certInfo', certInfo], ['pubArea', pubArea]]) };
  };
}
/** `android-key`: the credential's own key certified by `issuer`, with the Android key description extension. */
function androidAttest(issuer, bend = {}) {
  return (authData, cdh, a) => {
    // otherKey: a certificate (and signature) for a key that is not the credential's.
    const other = bend.otherKey ? X.ecKeys() : null;
    const der = X.cert({ subject: [['CN', 'Android Keystore Key']], issuer: issuer.subject, publicKey: other ? other.publicKey : a.keys.publicKey, signKey: issuer.keys.privateKey,
      extensions: [X.EXT.androidKey({ challenge: bend.otherChallenge ? crypto.randomBytes(32) : cdh, allApplications: bend.allApplications, teeOrigin: bend.teeOrigin === undefined ? 0 : bend.teeOrigin, teePurpose: bend.teePurpose || [2] })] });
    const data = Buffer.concat([authData, cdh]);
    const sig = other ? crypto.sign('sha256', data, { key: other.privateKey, dsaEncoding: 'der' }) : a.sign(data);
    return { fmt: 'android-key', attStmt: new Map([['alg', -7], ['sig', sig], ['x5c', [der]]]) };
  };
}
/** The pieces verifyAttestation takes, from a soft authenticator's registration answer. */
function made(a, attest, origin = 'https://suds.example') {
  const cred = a.create({ challenge: W.b64url(crypto.randomBytes(32)), user: { id: 'dQ' } }, { attest, origin });
  const att = W.cborDecodeAll(W.fromB64url(cred.response.attestationObject));
  return { fmt: att.get('fmt'), attStmt: att.get('attStmt'), authData: att.get('authData'), clientDataHash: sha256(W.fromB64url(cred.response.clientDataJSON)) };
}
const code = (c) => (e) => { assert.equal(e.code, c, `${e.code}: ${e.message}`); return true; };

// ---------------------------------------------------------------- the verifier on its own
test('the FIDO Metadata Service root is GlobalSign Root CA - R3, with the SHA-256 the source documents', () => {
  const x = new crypto.X509Certificate(A.FIDO_MDS_ROOT_PEM);
  assert.equal(x.fingerprint256, A.FIDO_MDS_ROOT_SHA256);
  assert.equal(x.fingerprint256, 'CB:B5:22:D7:B7:F1:27:AD:6A:01:13:86:5B:DF:1C:D4:10:2E:7D:07:59:AF:63:5A:7C:F4:72:0D:C9:63:C5:3B');
  assert.match(x.subject, /OU=GlobalSign Root CA - R3/);
  assert.ok(x.ca);
  assert.equal(A.MDS_SIGNER_HOST, 'mds.fidoalliance.org');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'docs', 'FINGERPRINT.md'), 'utf8').includes(A.FIDO_MDS_ROOT_SHA256), 'FINGERPRINT.md names the same SHA-256');
});

test('packed full attestation verifies and chains to its root; each requirement on the certificate is checked', () => {
  const root = X.ca('Maker root'); const inter = X.ca('Maker batch CA', { issuer: root });
  const a = new SoftAuthenticator({ aaguid: aaguidBuf(AAGUID) });
  const r = A.verifyAttestation(made(a, packedFull(inter)));
  assert.equal(r.fmt, 'packed'); assert.equal(r.type, 'basic'); assert.equal(r.aaguid, AAGUID);
  A.verifyChain([...r.x5c, inter.der], [root.der]);
  assert.throws(() => A.verifyChain(r.x5c, [root.der]), code('chain'), 'without the intermediate the chain does not reach the root');
  assert.throws(() => A.verifyChain([...r.x5c, inter.der], [X.ca('Someone else').der]), code('chain'), 'another root is not trusted');
  assert.throws(() => A.verifyAttestation(made(a, packedFull(inter, { badSig: true }))), code('attestation_signature'), 'a tampered signature');
  assert.throws(() => A.verifyAttestation(made(a, packedFull(inter, { aaguid: OTHER_AAGUID }))), code('attestation_aaguid'), 'a certificate for another model');
  assert.throws(() => A.verifyAttestation(made(a, packedFull(inter, { criticalExt: true }))), code('attestation_cert'), 'the AAGUID extension marked critical');
  assert.throws(() => A.verifyAttestation(made(a, packedFull(inter, { subject: [['C', 'US'], ['O', 'x'], ['OU', 'Something else'], ['CN', 'y']] }))), code('attestation_cert'), 'OU is not "Authenticator Attestation"');
  assert.throws(() => A.verifyAttestation(made(a, packedFull(inter, { ca: true }))), code('attestation_cert'), 'the attestation certificate is a CA');
  assert.throws(() => A.verifyAttestation(made(a, packedFull(inter, { version: 1, ext: false }))), code('attestation_cert'), 'an X.509 version 1 certificate');
  const noExt = A.verifyAttestation(made(a, packedFull(inter, { ext: false })));
  assert.equal(noExt.aaguid, AAGUID, 'without the extension, the AAGUID is the authenticator data\'s');
});

test('packed self attestation is recognised as such; none, and formats SUDS cannot verify, are said to be', () => {
  const a = new SoftAuthenticator({ aaguid: aaguidBuf(AAGUID) });
  const r = A.verifyAttestation(made(a, packedSelf()));
  assert.equal(r.type, 'self'); assert.deepEqual(r.x5c, []);
  assert.equal(A.verifyAttestation(made(a, null)).type, 'none');
  assert.throws(() => A.verifyAttestation(made(a, () => ({ fmt: 'apple', attStmt: new Map([['x5c', []]]) }))), code('attestation_format'));
  assert.throws(() => A.verifyAttestation(made(a, () => ({ fmt: 'android-safetynet', attStmt: new Map() }))), code('attestation_format'));
  assert.deepEqual(A.SUPPORTED_FORMATS, ['packed', 'fido-u2f', 'tpm', 'android-key']);
});

test('fido-u2f: the all-zero AAGUID and the certificate\'s key identifier; a signature over anything else is refused', () => {
  const root = X.ca('U2F root');
  const a = new SoftAuthenticator({ aaguid: Buffer.alloc(16) });
  const u = u2f(root);
  const r = A.verifyAttestation(made(a, u.fn));
  assert.equal(r.aaguid, A.ZERO_AAGUID);
  assert.match(r.keyId, /^[0-9a-f]{40}$/);
  assert.equal(r.keyId, A.keyIdentifier(new crypto.X509Certificate(u.der)));
  A.verifyChain(r.x5c, [root.der]);
  const wrong = { der: u.der, fn: (ad, cdh, x) => { const m = u.fn(ad, crypto.randomBytes(32), x); return m; } };
  assert.throws(() => A.verifyAttestation(made(a, wrong.fn)), code('attestation_signature'));
  assert.throws(() => A.verifyAttestation(made(new SoftAuthenticator({ alg: 'EdDSA' }), u.fn)), (e) => !!e.code, 'a U2F credential must be ES256');
});

test('tpm: the key certified is the credential, for this registration, by an attestation identity key with a TPM certificate', () => {
  const root = X.ca('TPM maker root', { keys: X.rsaKeys() });
  const a = new SoftAuthenticator({ alg: 'RS256', aaguid: aaguidBuf(AAGUID) });
  const r = A.verifyAttestation(made(a, tpmAttest(root)));
  assert.equal(r.fmt, 'tpm'); assert.equal(r.type, 'attca'); assert.equal(r.aaguid, AAGUID);
  A.verifyChain(r.x5c, [root.der]);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { otherKey: true }))), /another key than the credential/);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { otherHash: true }))), /not for this registration/);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { otherName: true }))), /names another key/);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { magic: 0x12345678 }))), /not a TPM-generated/);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { subject: [['CN', 'not empty']] }))), /empty subject/);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { noSan: true }))), /does not name the TPM/);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { noEku: true }))), /2\.23\.133\.8\.3/);
  // A malformed name inside the subject alternative name (the device makes its own certificate before the chain is
  // checked): refused as not understood, never a crash (it was a TypeError, a 500 at enrolment).
  const sanOf = (atv) => X.ext('2.5.29.17', X.seq(X.ctx(4, X.seq(X.set(atv)))), true);
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { san: sanOf(X.seq()) }))), code('attestation_cert'), 'an empty AttributeTypeAndValue');
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { san: sanOf(X.seq(X.oid('2.23.133.2.1'))) }))), code('attestation_cert'), 'a type with no value');
  assert.throws(() => A.verifyAttestation(made(a, tpmAttest(root, { san: sanOf(X.seq(X.utf8('x'), X.utf8('y'))) }))), code('attestation_cert'), 'a value where the type should be');
});

test('android-key: the certificate is for the credential key, this challenge, generated and held by the secure hardware', () => {
  const root = X.ca('Android root');
  const a = new SoftAuthenticator({ aaguid: aaguidBuf(AAGUID) });
  const r = A.verifyAttestation(made(a, androidAttest(root)));
  assert.equal(r.fmt, 'android-key'); assert.equal(r.aaguid, AAGUID);
  A.verifyChain(r.x5c, [root.der]);
  assert.throws(() => A.verifyAttestation(made(a, androidAttest(root, { otherKey: true }))), /another key than the credential/);
  assert.throws(() => A.verifyAttestation(made(a, androidAttest(root, { otherChallenge: true }))), /not for this registration/);
  assert.throws(() => A.verifyAttestation(made(a, androidAttest(root, { allApplications: true }))), /every app/);
  assert.throws(() => A.verifyAttestation(made(a, androidAttest(root, { teeOrigin: null }))), /not generated in the device's secure hardware/);
  assert.throws(() => A.verifyAttestation(made(a, androidAttest(root, { teePurpose: [3] }))), /not a signing key/);
});

test('certificate chains: out of date, not yet valid, signed by someone else, or through a certificate that is not a CA', () => {
  const root = X.ca('Chain root'); const inter = X.ca('Chain CA', { issuer: root });
  const k = X.ecKeys();
  const leaf = (o = {}) => X.cert({ subject: PACKED_SUBJECT, issuer: (o.issuer || inter).subject, publicKey: k.publicKey, signKey: (o.issuer || inter).keys.privateKey, ...o.dates, extensions: [X.EXT.basicConstraints(false)] });
  A.verifyChain([leaf(), inter.der], [root.der]);
  assert.throws(() => A.verifyChain([leaf({ dates: { notBefore: new Date(Date.now() - 3 * 86400_000), notAfter: new Date(Date.now() - 86400_000) } }), inter.der], [root.der]), /expired or is not valid yet/);
  assert.throws(() => A.verifyChain([leaf({ dates: { notBefore: new Date(Date.now() + 86400_000), notAfter: new Date(Date.now() + 3 * 86400_000) } }), inter.der], [root.der]), /expired or is not valid yet/);
  const stranger = X.ca('Stranger CA', { issuer: root });
  assert.throws(() => A.verifyChain([leaf({ issuer: stranger }), inter.der], [root.der]), /chain is broken/);
  const notCa = { keys: X.ecKeys(), subject: [['CN', 'Not a CA']] };
  notCa.der = X.cert({ subject: notCa.subject, issuer: root.subject, publicKey: notCa.keys.publicKey, signKey: root.keys.privateKey, extensions: [X.EXT.basicConstraints(false)] });
  assert.throws(() => A.verifyChain([leaf({ issuer: notCa }), notCa.der], [root.der]), /not a certificate authority/);
  const oldRoot = X.ca('Old root', { notBefore: new Date(Date.now() - 3 * 86400_000), notAfter: new Date(Date.now() - 86400_000) });
  const underOld = X.ca('Under old', { issuer: oldRoot });
  assert.throws(() => A.verifyChain([underOld.der], [oldRoot.der]), /expired/);
  assert.throws(() => A.verifyChain([leaf(), inter.der], []), /no trusted root/);
});

test('the Metadata Service BLOB: signature chain to the root, the signer\'s name, the signature, nextUpdate', () => {
  const root = X.ca('Test MDS root', { keys: X.rsaKeys() });
  const roots = [X.pem(root.der)];
  const payload = { legalHeader: 'test', no: 7, nextUpdate: '2099-12-31', entries: [X.mdsEntry({ aaguid: AAGUID, roots: [root.der] }), X.mdsEntry({ keyIds: ['a'.repeat(40)], description: 'U2F key' }), { aaid: '4e4e#4005' }] };
  for (const keys of [X.rsaKeys(), X.ecKeys()]) {
    const s = X.mdsSigner(root, { keys });
    const got = A.verifyMdsBlob(X.mdsBlob({ payload, ...s }), { roots });
    assert.equal(got.no, 7); assert.equal(got.nextUpdate, '2099-12-31'); assert.equal(got.entries.length, 2, 'a UAF-only entry is left out');
    assert.equal(got.entries[0].aaguid, AAGUID); assert.equal(got.entries[0].roots.length, 1); assert.deepEqual(got.entries[1].keyIds, ['a'.repeat(40)]);
  }
  const s = X.mdsSigner(root);
  assert.throws(() => A.verifyMdsBlob(X.mdsBlob({ payload, ...s, tamper: (p) => { p.entries[0].statusReports = []; return p; } }), { roots }), code('mds_signature'), 'a changed payload');
  assert.throws(() => A.verifyMdsBlob(X.mdsBlob({ payload: { ...payload, nextUpdate: '2020-01-01' }, ...s }), { roots }), code('mds_expired'), 'past its nextUpdate');
  assert.throws(() => A.verifyMdsBlob(X.mdsBlob({ payload, ...s }), { roots: [A.FIDO_MDS_ROOT_PEM] }), code('mds_chain'), 'the real root does not vouch for the test chain');
  assert.throws(() => A.verifyMdsBlob(X.mdsBlob({ payload, ...X.mdsSigner(root, { host: 'www.example.com' }) }), { roots }), code('mds_chain'), 'a certificate for another site under the same root');
  assert.throws(() => A.verifyMdsBlob(X.mdsBlob({ payload, ...X.mdsSigner(root, { notAfter: new Date(Date.now() - 1000) }) }), { roots }), code('mds_chain'), 'an expired signing certificate');
  assert.throws(() => A.verifyMdsBlob('not a jwt', { roots }), code('mds'));
  assert.throws(() => A.verifyMdsBlob(X.mdsBlob({ payload: { no: 'x', entries: [] }, ...s }), { roots }), code('mds'));
  assert.deepEqual(A.refusedStatuses([{ status: 'FIDO_CERTIFIED_L1' }, { status: 'USER_VERIFICATION_BYPASS' }, { status: 'UPDATE_AVAILABLE' }]), ['USER_VERIFICATION_BYPASS']);
  for (const st of ['REVOKED', 'ATTESTATION_KEY_COMPROMISE', 'USER_KEY_REMOTE_COMPROMISE', 'USER_KEY_PHYSICAL_COMPROMISE']) assert.equal(A.refusedStatuses([{ status: st }]).length, 1, st);
});

// ---------------------------------------------------------------- the office server
let admin, base, root, rootFile, makerRoot, makerCa, signer;
let mdsNo = 100;
before(async () => {
  root = X.ca('SUDS test MDS root', { keys: X.rsaKeys() });
  rootFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'suds-mds-')), 'root.pem');
  fs.writeFileSync(rootFile, X.pem(root.der));
  process.env.SUDS_TEST_FIDO_MDS_ROOT = rootFile;
  makerRoot = X.ca('SUDS test maker root'); makerCa = X.ca('SUDS test maker CA', { issuer: makerRoot });
  signer = X.mdsSigner(root);
  base = await H.start();
  admin = H.client(); await admin.login('admin', APW);
});
after(async () => { delete process.env.SUDS_TEST_FIDO_MDS_ROOT; fs.rmSync(path.dirname(rootFile), { recursive: true, force: true }); await H.stop(); });

const blob = ({ statuses, extra = [], nextUpdate = '2099-12-31', no = ++mdsNo } = {}) => X.mdsBlob({ payload: { no, nextUpdate, legalHeader: 'test', entries: [
  X.mdsEntry({ aaguid: AAGUID, description: 'SUDS test key', roots: [makerRoot.der], ...(statuses ? { statuses } : {}) }),
  X.mdsEntry({ aaguid: OTHER_AAGUID, description: 'Another test key', roots: [makerRoot.der] }), ...extra] }, ...signer });
const key = (o = {}) => new SoftAuthenticator({ origin: base, aaguid: aaguidBuf(AAGUID), ...o });
async function person(name, role = 'navigator') { const u = H.makeUser(name, role); const c = H.client(); await c.login(name, PW); return { u, c }; }
async function enrol(c, a, bend) {
  const o = await c.post('/api/auth/passkeys/register/options', { password: PW });
  if (o.status !== 200) return o;
  const r = await c.post('/api/auth/passkeys/register', { credential: a.create(o.data.publicKey, bend), name: 'Test key' });
  return Object.assign(r, { options: o.data });
}
async function passkeyLogin(a) {
  const app = require('../server/app'); for (const k of ['passkey-options:127.0.0.1', 'login:127.0.0.1']) app.rateLimitReset(k);
  const c = H.client();
  const o = await c.post('/api/auth/passkeys/login/options', {});
  return c.post('/api/auth/passkeys/login', { credential: a.get(o.data.publicKey) });
}
const lastAudit = (action) => { const r = H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action); return r ? { ...r, details: JSON.parse(r.details || 'null') } : null; };
// The 1.21.0 tests below are about refusal at once: a grace period of 0 days (1.22.0's tests pass their own).
const setList = (body) => admin.put('/api/admin/authenticator-allowlist', { password: APW, grace_days: 0, ...body });

test('only an administrator reads or changes the allow-list; a change and a metadata upload need the password again, every time', async () => {
  const nav = await person('al_nav'); const sup = await person('al_sup', 'supervisor');
  for (const c of [nav.c, sup.c]) {
    assert.equal((await c.get('/api/admin/authenticator-allowlist')).status, 403);
    assert.equal((await c.post('/api/admin/authenticator-allowlist/preview', { enabled: true, models: [] })).status, 403);
    assert.equal((await c.put('/api/admin/authenticator-allowlist', { enabled: false, models: [], password: PW })).status, 403);
    assert.equal((await c.post('/api/admin/authenticator-metadata', { blob: blob(), password: PW })).status, 403);
  }
  const g = await admin.get('/api/admin/authenticator-allowlist');
  assert.equal(g.status, 200);
  assert.equal(g.data.enabled, false, 'off by default');
  assert.equal(g.data.metadata, null);
  assert.equal(g.data.trust_root.sha256, A.FIDO_MDS_ROOT_SHA256);
  assert.equal(g.data.grace_days, 14, 'a grace period of 14 days until the administrator chooses (1.22.0)');
  assert.equal(g.data.grace_max_days, 90);
  // The generic settings route does not reach it: the keys are not settings it accepts.
  await admin.put('/api/admin/settings', { authn_allowlist: '1', authn_allowlist_models: '[]' });
  assert.equal(H.db.getSetting('authn_allowlist', '0'), '0', 'PUT /api/admin/settings cannot turn it on');
  assert.equal((await admin.get('/api/admin/settings')).data.authn_allowlist, undefined);
  // The password, with the request.
  const none = await admin.post('/api/admin/authenticator-metadata', { blob: blob() });
  assert.equal(none.status, 403); assert.equal(none.data.reauthRequired, true); assert.equal(none.data.fresh, true);
  const before = H.db.one(`SELECT failed_attempts FROM users WHERE username='admin'`).failed_attempts;
  const wrong = await admin.post('/api/admin/authenticator-metadata', { blob: blob(), password: 'Wrong-Passw0rd!' });
  assert.equal(wrong.status, 403);
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE username='admin'`).failed_attempts, before + 1, 'a wrong password counts toward the lockout');
  assert.ok(lastAudit('security.authenticator_metadata.failed'), 'and is audited');
  assert.equal((await admin.put('/api/admin/authenticator-allowlist', { enabled: false, models: [] })).status, 403, 'a change without the password');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM authenticator_metadata`).n, 0, 'nothing was loaded');
});

test('the metadata file: loaded only when signed under the trusted root, current and not older than the one loaded; audited', async () => {
  // Turning the list on needs metadata first.
  const early = await setList({ enabled: true, models: [{ name: 'Test key', aaguid: AAGUID }] });
  assert.equal(early.status, 400); assert.equal(early.data.allowlistError, 'metadata');
  const other = X.ca('Untrusted MDS root', { keys: X.rsaKeys() });
  const bad = await admin.post('/api/admin/authenticator-metadata', { blob: X.mdsBlob({ payload: { no: 1, nextUpdate: '2099-01-01', entries: [] }, ...X.mdsSigner(other) }), password: APW });
  assert.equal(bad.status, 400); assert.equal(bad.data.metadataError, 'mds_chain');
  assert.equal(lastAudit('security.authenticator_metadata.refused').details.reason, 'mds_chain');
  const tampered = X.mdsBlob({ payload: { no: 1, nextUpdate: '2099-01-01', entries: [] }, ...signer, tamper: (p) => ({ ...p, no: 999999 }) });
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: tampered, password: APW })).data.metadataError, 'mds_signature');
  const stale = await admin.post('/api/admin/authenticator-metadata', { blob: blob({ nextUpdate: '2021-01-01' }), password: APW });
  assert.equal(stale.data.metadataError, 'mds_expired');
  const b = blob();
  const ok = await admin.post('/api/admin/authenticator-metadata', { blob: b, password: APW });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.metadata.no, mdsNo); assert.equal(ok.data.metadata.entries, 2); assert.equal(ok.data.metadata.test_root, true);
  const au = lastAudit('security.authenticator_metadata');
  assert.equal(au.details.no, mdsNo); assert.equal(au.details.sha256, sha256(Buffer.from(b)).toString('hex'));
  const older = await admin.post('/api/admin/authenticator-metadata', { blob: blob({ no: 5 }), password: APW });
  assert.equal(older.data.metadataError, 'mds_older', 'an older file cannot replace a newer one (it could hide a revocation)');
  const g = (await admin.get('/api/admin/authenticator-allowlist')).data;
  assert.deepEqual(g.catalog.map((x) => x.aaguid).sort(), [AAGUID, OTHER_AAGUID].sort());
});

test('turning it on: the administrator sees whose passkeys stop working and confirms the number; they stop at their next use, audited', async () => {
  const p = await person('al_before');
  const old = key();
  assert.equal((await enrol(p.c, old)).status, 201, 'a passkey added while the list is off');
  assert.equal((await passkeyLogin(old)).status, 200);
  const models = [{ name: 'Test key', aaguid: AAGUID.toUpperCase() }];
  const pv = await admin.post('/api/admin/authenticator-allowlist/preview', { enabled: true, models });
  assert.equal(pv.status, 200);
  assert.equal(pv.data.models[0].aaguid, AAGUID, 'AAGUIDs are kept lower-case'); assert.equal(pv.data.models[0].standing, 'ok');
  const mine = pv.data.affected.accounts.find((x) => x.username === 'al_before');
  assert.ok(mine, 'the account is listed'); assert.equal(mine.passkeys[0].reason, 'unattested'); assert.equal(mine.other_factor, false);
  assert.equal((await admin.post('/api/admin/authenticator-allowlist/preview', { enabled: true, models: [{ name: 'x', aaguid: 'not-an-aaguid' }] })).status, 400);
  const n = pv.data.affected.passkey_count;
  const unconfirmed = await setList({ enabled: true, models });
  assert.equal(unconfirmed.status, 409, 'the number must be confirmed'); assert.equal(unconfirmed.data.affected.passkey_count, n);
  assert.equal((await setList({ enabled: true, models, acknowledge_affected: n + 1 })).status, 409, 'and be the right number');
  const missing = await setList({ enabled: true, models: [...models, { name: 'Not in the file', aaguid: '11111111-2222-4333-8444-555555555555' }], acknowledge_affected: n });
  assert.equal(missing.status, 400); assert.equal(missing.data.allowlistError, 'models', 'a model the metadata does not list could never be checked');
  const on = await setList({ enabled: true, models, acknowledge_affected: n });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.enabled, true);
  const au = lastAudit('security.authenticator_allowlist');
  assert.equal(au.details.enabled, true); assert.equal(au.details.was_enabled, false); assert.deepEqual(au.details.models, [AAGUID]);
  assert.equal(au.details.affected_passkeys, n); assert.ok(au.details.affected_users.includes(p.u.id));
  // The passkey added before stops working, with the reason, at its next use.
  const r = await passkeyLogin(old);
  assert.equal(r.status, 403); assert.match(r.data.error, /not accepted any more/); assert.equal(r.data.passkeyError, 'not_allowed');
  const na = lastAudit('auth.passkey.not_allowed');
  assert.equal(na.user_id, p.u.id); assert.equal(na.details.reason, 'unattested');
  assert.equal(H.db.one(`SELECT failed_attempts FROM users WHERE id=?`, p.u.id).failed_attempts, 0, 'not a failed guess: the lockout is not counted');
  // Nor does it confirm a signature, or count as two-step verification any more.
  const ch = await p.c.post('/api/auth/passkeys/challenge', { purpose: 'keys.download' });
  assert.ok([400, 403].includes(ch.status));
  const nid = (await p.c.post('/api/clients', { first_name: 'Allow', last_name: 'List' })).data.id;
  const note = (await p.c.post('/api/notes', { client_id: nid, kind: 'admin', title: 'Visit', content: 'x', occurred_at: new Date().toISOString() })).data.id;
  const sc = await p.c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: note });
  assert.equal(sc.status, 400); assert.match(sc.data.error, /None of your passkeys is on your programme's list/);
  const mineList = (await p.c.get('/api/auth/passkeys')).data;
  assert.equal(mineList.passkeys[0].accepted, false); assert.equal(mineList.passkeys[0].not_accepted_reason, 'unattested');
  assert.deepEqual(mineList.allowlist.models, ['Test key']);
  assert.equal(require('../server/auth').passkeyCount(p.u.id), 0, 'no longer the account\'s second factor');
});

test('adding a passkey under the list: attestation asked for and verified; refused without one, self-attested, another model, or an untrusted chain', async () => {
  const p = await person('al_new');
  const opts = (await p.c.post('/api/auth/passkeys/register/options', { password: PW })).data;
  assert.equal(opts.publicKey.attestation, 'direct', 'attestation is asked for only under the list');
  assert.equal(opts.publicKey.authenticatorSelection.authenticatorAttachment, undefined, 'a security key may be offered too');
  assert.equal(opts.publicKey.authenticatorSelection.userVerification, 'required');
  const refused = async (bend, reason, a = key()) => {
    const r = await enrol(p.c, a, bend);
    assert.equal(r.status, 400, JSON.stringify(r.data)); assert.equal(r.data.passkeyError, reason, r.data.error);
    assert.equal(lastAudit('auth.passkey.enrol.failed').details.reason, reason);
  };
  await refused({}, 'allowlist_attestation');
  await refused({ attest: packedSelf() }, 'allowlist_self_attestation');
  await refused({ attest: packedFull(makerCa) }, 'allowlist_model', key({ aaguid: aaguidBuf(OTHER_AAGUID) }));
  await refused({ attest: packedFull(X.ca('Counterfeit CA')) }, 'allowlist_chain');
  await refused({ attest: packedFull(makerCa, { badSig: true }) }, 'attestation_signature');
  await refused({ attest: () => ({ fmt: 'apple', attStmt: new Map() }) }, 'attestation_format');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, p.u.id).n, 0, 'none of them was kept');
  // The listed model, its batch certificate issued under the root the metadata names for it.
  const good = key();
  const r = await enrol(p.c, good, { attest: packedFull(makerCa) });
  // The chain in x5c holds the batch certificate only; the maker's intermediate is not the root the metadata lists.
  assert.equal(r.status, 400, 'a chain that stops short of the listed root is refused');
  const withInter = (authData, cdh, a) => { const m = packedFull(makerCa)(authData, cdh, a); m.attStmt.set('x5c', [...m.attStmt.get('x5c'), makerCa.der]); return m; };
  const ok = await enrol(p.c, good, { attest: withInter });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.passkey.attested, true); assert.equal(ok.data.passkey.accepted, true);
  const row = H.db.one(`SELECT * FROM passkeys WHERE user_id=?`, p.u.id);
  const att = JSON.parse(row.attestation);
  assert.deepEqual([att.verified, att.fmt, att.type, att.aaguid, att.mds_no], [true, 'packed', 'basic', AAGUID, mdsNo]);
  assert.ok(!row.attestation.includes('BEGIN') && !('x5c' in att), 'the attestation certificate itself is not kept');
  const au = lastAudit('auth.passkey.enrolled');
  assert.deepEqual(au.details.attestation, { verified: true, fmt: 'packed', type: 'basic', mds_no: mdsNo });
  assert.equal((await passkeyLogin(good)).status, 200, 'it signs in');
  // The other formats, end to end.
  const tpmKey = key({ alg: 'RS256' });
  assert.equal((await enrol(p.c, tpmKey, { attest: (ad, cdh, a) => { const m = tpmAttest(makerCa)(ad, cdh, a); m.attStmt.set('x5c', [...m.attStmt.get('x5c'), makerCa.der]); return m; } })).status, 201, 'tpm');
  assert.equal((await enrol(p.c, key(), { attest: (ad, cdh, a) => { const m = androidAttest(makerCa)(ad, cdh, a); m.attStmt.set('x5c', [...m.attStmt.get('x5c'), makerCa.der]); return m; } })).status, 201, 'android-key');
});

test('a model the Metadata Service reports compromised: its passkeys stop, new ones are refused; an out-of-date file stops enrolment only', async () => {
  const p = await person('al_status');
  const a = key();
  const withInter = (ad, cdh, x) => { const m = packedFull(makerCa)(ad, cdh, x); m.attStmt.set('x5c', [...m.attStmt.get('x5c'), makerCa.der]); return m; };
  assert.equal((await enrol(p.c, a, { attest: withInter })).status, 201);
  assert.equal((await passkeyLogin(a)).status, 200);
  const up = await admin.post('/api/admin/authenticator-metadata', { blob: blob({ statuses: [{ status: 'FIDO_CERTIFIED_L1', effectiveDate: '2025-01-01' }, { status: 'USER_VERIFICATION_BYPASS', effectiveDate: '2026-01-01' }, { status: 'UPDATE_AVAILABLE', effectiveDate: '2026-02-01' }] }), password: APW });
  assert.equal(up.status, 200);
  assert.equal(up.data.models[0].standing, 'refused', 'the upload says the listed model is now refused');
  const r = await passkeyLogin(a);
  assert.equal(r.status, 403); assert.match(r.data.error, /compromised or revoked/);
  assert.equal(lastAudit('auth.passkey.not_allowed').details.reason, 'status');
  const again = await enrol(p.c, key(), { attest: withInter });
  assert.equal(again.data.passkeyError, 'allowlist_status');
  // Security status says so.
  const line = (await admin.get('/api/admin/security/status')).data.items.find((x) => x.name === 'Authenticator allow-list (passkeys)');
  assert.equal(line.level, 'bad'); assert.match(line.detail, /reported compromised or revoked/);
  // A current file clears it; then one past its next update stops enrolment, and passkeys already checked keep working.
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob(), password: APW })).status, 200);
  assert.equal((await passkeyLogin(a)).status, 200);
  const meta = JSON.parse(H.db.getSetting('authn_mds'));
  H.db.setSetting('authn_mds', JSON.stringify({ ...meta, next_update: '2021-01-01' }));
  const o = await p.c.post('/api/auth/passkeys/register/options', { password: PW });
  assert.equal(o.status, 400); assert.equal(o.data.passkeyError, 'allowlist_metadata_expired');
  assert.equal((await passkeyLogin(a)).status, 200, 'a passkey already proven keeps working while the file is out of date (Security status is red)');
  H.db.setSetting('authn_mds', JSON.stringify(meta));
});

test('turning it off: every passkey works again as before, and the list is kept for next time; audited', async () => {
  const p = await person('al_off');
  const unattested = H.db.one(`SELECT p.* FROM passkeys p JOIN users u ON u.id=p.user_id WHERE u.username='al_before'`);
  assert.ok(unattested);
  const off = await setList({ enabled: false, models: [{ name: 'Test key', aaguid: AAGUID }] });
  assert.equal(off.status, 200);
  assert.equal(lastAudit('security.authenticator_allowlist').details.enabled, false);
  const o = (await p.c.post('/api/auth/passkeys/register/options', { password: PW })).data;
  assert.equal(o.publicKey.attestation, 'none', 'no attestation asked for with the list off');
  assert.equal(o.publicKey.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(require('../server/passkeys').allowlist.passkeyAllowed(unattested).ok, true);
  assert.deepEqual(require('../server/passkeys').allowlist.models().map((m) => m.aaguid), [AAGUID]);
});

test('turning it on, or a metadata file that refuses a model, ends the sessions the refused passkeys opened (review fix)', async () => {
  const models = [{ name: 'Test key', aaguid: AAGUID }];
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob(), password: APW })).status, 200);
  const p = await person('al_session');
  const old = key();
  assert.equal((await enrol(p.c, old)).status, 201, 'added while the list is off (never attested)');
  const app = require('../server/app'); for (const k of ['passkey-options:127.0.0.1', 'login:127.0.0.1']) app.rateLimitReset(k);
  const byKey = H.client();
  const o = await byKey.post('/api/auth/passkeys/login/options', {});
  assert.equal((await byKey.post('/api/auth/passkeys/login', { credential: old.get(o.data.publicKey) })).status, 200);
  assert.equal((await byKey.get('/api/clients')).status, 200, 'signed in by the passkey');
  const n = (await admin.post('/api/admin/authenticator-allowlist/preview', { enabled: true, models })).data.affected.passkey_count;
  assert.equal((await setList({ enabled: true, models, acknowledge_affected: n })).status, 200);
  assert.ok(lastAudit('security.authenticator_allowlist').details.sessions_ended >= 1, 'audited');
  assert.equal((await byKey.get('/api/clients')).status, 401, 'the session the refused passkey opened has ended');
  assert.equal((await p.c.get('/api/clients')).status, 200, 'a password session of the same person is not a passkey\'s');
  assert.equal((await admin.get('/api/admin/authenticator-allowlist')).status, 200, 'nor the administrator\'s own');
  // An attested passkey's session, then a metadata file reporting its model compromised: that session ends too.
  const good = key();
  const withInter = (ad, cdh, x) => { const m = packedFull(makerCa)(ad, cdh, x); m.attStmt.set('x5c', [...m.attStmt.get('x5c'), makerCa.der]); return m; };
  assert.equal((await enrol(p.c, good, { attest: withInter })).status, 201);
  for (const k of ['passkey-options:127.0.0.1', 'login:127.0.0.1']) app.rateLimitReset(k);
  const byGood = H.client();
  const o2 = await byGood.post('/api/auth/passkeys/login/options', {});
  assert.equal((await byGood.post('/api/auth/passkeys/login', { credential: good.get(o2.data.publicKey) })).status, 200);
  assert.equal((await byGood.get('/api/clients')).status, 200);
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob({ statuses: [{ status: 'ATTESTATION_KEY_COMPROMISE', effectiveDate: '2026-01-01' }] }), password: APW })).status, 200);
  assert.equal((await byGood.get('/api/clients')).status, 401, 'ended with the model\'s standing');
  assert.ok(lastAudit('security.authenticator_metadata').details.sessions_ended >= 1);
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob(), password: APW })).status, 200);
  const n2 = (await admin.post('/api/admin/authenticator-allowlist/preview', { enabled: false, models })).data.affected.passkey_count;
  assert.equal((await setList({ enabled: false, models, acknowledge_affected: n2 })).status, 200);
});

// ---------------------------------------------------------------- the grace period (built for 1.22.0)
const withInterAttest = (ad, cdh, x) => { const m = packedFull(makerCa)(ad, cdh, x); m.attStmt.set('x5c', [...m.attStmt.get('x5c'), makerCa.der]); return m; };
async function signInWith(a) {
  const app = require('../server/app'); for (const k of ['passkey-options:127.0.0.1', 'login:127.0.0.1']) app.rateLimitReset(k);
  const c = H.client();
  const o = await c.post('/api/auth/passkeys/login/options', {});
  const r = await c.post('/api/auth/passkeys/login', { credential: a.get(o.data.publicKey) });
  return Object.assign(r, { client: c });
}
const pkOf = (userId) => H.db.one(`SELECT * FROM passkeys WHERE user_id=? ORDER BY created_at DESC LIMIT 1`, userId);
const preview = async (body) => (await admin.post('/api/admin/authenticator-allowlist/preview', body)).data.affected;
const listOff = async (models) => {
  const n = (await preview({ enabled: false, models })).passkey_count;
  assert.equal((await setList({ enabled: false, models, acknowledge_affected: n })).status, 200);
};

test('grace period: turning the list on keeps a refused passkey working until a date, told to its owner and the administrator; then it stops (fake clock), audited', async () => {
  const L = require('../server/authenticator-allowlist');
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob(), password: APW })).status, 200);
  const models = [{ name: 'Test key', aaguid: AAGUID }];
  await listOff(models);
  const p = await person('gr_only'); const old = key({ aaguid: aaguidBuf(OTHER_AAGUID) });
  assert.equal((await enrol(p.c, old)).status, 201, 'added while the list is off: the account\'s only second factor');
  const q = await person('gr_totp');
  assert.equal((await enrol(q.c, key())).status, 201, 'another, with an authenticator app as well');
  H.db.run(`UPDATE users SET mfa_enabled=1 WHERE id=?`, q.u.id);
  for (const bad of [-1, 91, 2.5]) assert.equal((await admin.post('/api/admin/authenticator-allowlist/preview', { enabled: true, models, grace_days: bad })).status, 400, `grace_days ${bad} is refused`);
  // The preview: whose, when, and who loses their only second factor.
  const t0 = Date.now();
  const pv = await preview({ enabled: true, models, grace_days: 10 });
  const mine = pv.accounts.find((x) => x.username === 'gr_only');
  assert.ok(mine && mine.only_factor, 'an account whose only second factor stops is marked');
  assert.ok(pv.only_factor_accounts.some((x) => x.username === 'gr_only'), 'and listed apart');
  assert.ok(!pv.only_factor_accounts.some((x) => x.username === 'gr_totp'), 'not one with an authenticator app');
  const stops = Date.parse(mine.passkeys[0].stops_at);
  assert.ok(Math.abs(stops - (t0 + 10 * 86400000)) < 60_000, 'it stops 10 days from now');
  assert.equal(pv.grace_days, 10); assert.ok(pv.grace_until); assert.equal(pv.stops_now_count, 0);
  // Saved: the passkey keeps working, and no session it opens outlives the grace period.
  const on = await setList({ enabled: true, models, grace_days: 10, acknowledge_affected: pv.passkey_count });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.grace_days, 10, 'the grace period is kept for next time');
  const au = lastAudit('security.authenticator_allowlist');
  assert.equal(au.details.grace_days, 10); assert.ok(au.details.grace_passkeys >= 2); assert.ok(au.details.only_factor_users.includes(p.u.id)); assert.equal(au.details.stops_now, 0);
  const until = pkOf(p.u.id).allowlist_grace_until;
  assert.ok(until && Math.abs(Date.parse(until) - stops) < 60_000);
  const s = await signInWith(old);
  assert.equal(s.status, 200, 'in its grace period the passkey still signs in');
  assert.equal(lastAudit('auth.login').details.allowlist_grace_until, until, 'and the sign-in is audited with the date');
  const sessionEnd = () => H.db.one(`SELECT expires_at FROM sessions WHERE passkey_id=? AND revoked_at IS NULL`, pkOf(p.u.id).id).expires_at;
  assert.ok(Date.parse(sessionEnd()) <= Date.parse(until), 'the session it opened expires by the end of the grace period');
  // A session lifetime longer than the grace period (an administrator's setting) is cut to it.
  H.db.run(`UPDATE sessions SET expires_at=? WHERE passkey_id=?`, new Date(Date.parse(until) + 86400000).toISOString(), pkOf(p.u.id).id);
  // Its owner is told: on every page (the session's user) and on My profile.
  const me = (await s.client.get('/api/auth/me')).data.user;
  assert.equal(me.passkey_grace.until, until); assert.equal(me.passkey_grace.totp, false); assert.equal(me.passkeys, 1, 'still the account\'s second factor for now');
  const mineList = (await p.c.get('/api/auth/passkeys')).data;
  assert.equal(mineList.grace.until, until); assert.equal(mineList.passkeys[0].accepted, true); assert.equal(mineList.passkeys[0].stops_at, until); assert.equal(mineList.passkeys[0].stop_reason, 'unattested');
  // The administrator's card shows the dates in force.
  const cur = (await admin.get('/api/admin/authenticator-allowlist')).data.affected;
  assert.equal(cur.accounts.find((x) => x.username === 'gr_only').passkeys[0].stops_at, until);
  // Saving again with a longer grace period does not lengthen it; a shorter one shortens it, and its sessions.
  const n2 = (await preview({ enabled: true, models, grace_days: 30 })).passkey_count;
  assert.equal((await setList({ enabled: true, models, grace_days: 30, acknowledge_affected: n2 })).status, 200);
  assert.equal(pkOf(p.u.id).allowlist_grace_until, until, 'a re-save never lengthens a grace period');
  assert.equal((await setList({ enabled: true, models, grace_days: 3, acknowledge_affected: n2 })).status, 200);
  const shorter = pkOf(p.u.id).allowlist_grace_until;
  assert.ok(Date.parse(shorter) < Date.parse(until) - 6 * 86400000, 'a shorter one shortens it');
  assert.equal(sessionEnd(), shorter, 'and its session ends with it');
  // The fake clock: accepted until the end, refused from it.
  const pk = pkOf(p.u.id); const end = Date.parse(shorter);
  assert.equal(L.passkeyAllowed(pk, { now: new Date(end - 1000) }).ok, true);
  assert.deepEqual(L.passkeyAllowed(pk, { now: new Date(end) }), { ok: false, reason: 'unattested' });
  assert.equal(L.expireGrace({ now: new Date(end - 1000) }).passkeys, 0, 'nothing ends before its time');
  const ex = L.expireGrace({ now: new Date(end + 1000) });
  assert.ok(ex.passkeys >= 1 && ex.sessions_ended >= 1, JSON.stringify(ex));
  const ge = lastAudit('security.authenticator_allowlist.grace_ended');
  assert.ok(ge.details.users.includes(p.u.id) && ge.details.passkey_ids.includes(pk.id)); assert.equal(ge.user_id, null);
  assert.equal(pkOf(p.u.id).allowlist_grace_until, null, 'the date is cleared');
  assert.equal((await s.client.get('/api/clients')).status, 401, 'the session it opened has ended');
  const refused = await signInWith(old);
  assert.equal(refused.status, 403); assert.equal(refused.data.passkeyError, 'not_allowed');
  assert.equal((await p.c.get('/api/auth/me')).data.user.passkey_grace, null, 'no notice once it has stopped');
  // A passkey already refused is not revived by another change with a grace period.
  const n3 = await preview({ enabled: true, models, grace_days: 14 });
  assert.equal(n3.accounts.find((x) => x.username === 'gr_only').passkeys[0].stops_at, null, 'already refused: it stops at once');
  assert.ok(n3.stops_now_count >= 1);
  assert.equal((await setList({ enabled: true, models, grace_days: 14, acknowledge_affected: n3.passkey_count })).status, 200);
  assert.equal((await signInWith(old)).status, 403);
  await listOff(models);
  assert.equal(pkOf(q.u.id).allowlist_grace_until, null, 'turning the list off clears every grace period');
});

test('grace period: never for a model reported compromised or revoked; narrowing the list gives one to a passkey it no longer lists', async () => {
  const models = [{ name: 'Test key', aaguid: AAGUID }, { name: 'Another test key', aaguid: OTHER_AAGUID }];
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob(), password: APW })).status, 200);
  await listOff(models);
  const p = await person('gr_status'); const old = key();
  assert.equal((await enrol(p.c, old)).status, 201, 'never attested; its device reports a listed model');
  let n = (await preview({ enabled: true, models, grace_days: 10 })).passkey_count;
  assert.equal((await setList({ enabled: true, models, grace_days: 10, acknowledge_affected: n })).status, 200);
  const s = await signInWith(old);
  assert.equal(s.status, 200, 'in its grace period');
  // The Metadata Service reports the model compromised: refused at once, grace or not, and its session ends.
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob({ statuses: [{ status: 'ATTESTATION_KEY_COMPROMISE', effectiveDate: '2026-01-01' }] }), password: APW })).status, 200);
  assert.equal((await s.client.get('/api/clients')).status, 401, 'its session ended with the upload');
  const r = await signInWith(old);
  assert.equal(r.status, 403); assert.equal(lastAudit('auth.passkey.not_allowed').details.reason, 'status');
  assert.equal((await p.c.get('/api/auth/passkeys')).data.passkeys[0].accepted, false);
  // A change saved while the model is reported compromised gives it no grace period.
  const pv = await preview({ enabled: true, models: [models[1]], grace_days: 10 });
  assert.equal(pv.accounts.find((x) => x.username === 'gr_status').passkeys[0].stops_at, null);
  assert.equal((await admin.post('/api/admin/authenticator-metadata', { blob: blob(), password: APW })).status, 200);
  // Narrowing: a passkey attested for a model the list then drops gets the grace period.
  const q = await person('gr_narrow'); const other = key({ aaguid: aaguidBuf(OTHER_AAGUID) });
  assert.equal((await enrol(q.c, other, { attest: withInterAttest })).status, 201, 'attested for a listed model');
  assert.equal((await signInWith(other)).status, 200);
  const nv = await preview({ enabled: true, models: [models[0]], grace_days: 5 });
  const mine = nv.accounts.find((x) => x.username === 'gr_narrow');
  assert.equal(mine.passkeys[0].reason, 'not listed'); assert.ok(mine.passkeys[0].stops_at);
  assert.equal((await setList({ enabled: true, models: [models[0]], grace_days: 5, acknowledge_affected: nv.passkey_count })).status, 200);
  assert.equal((await signInWith(other)).status, 200, 'it keeps working for the grace period');
  await listOff(models);
});

test('office server only: none of the attestation or allow-list code is in the browser kernel, and its routes are not mounted there', () => {
  const app = require('../server/app');
  assert.ok(!app.LOCAL_ROUTE_MODULES.includes('passkeys'), 'the passkey routes (the allow-list\'s too) are not in local mode');
  const kernel = fs.readFileSync(path.join(__dirname, '..', 'public', 'local', 'kernel.js'), 'utf8');
  for (const name of ['verifyMdsBlob', 'checkRegistration', 'FIDO_MDS_ROOT_PEM', 'verifyAttestation', 'passkeyAllowed', 'MIIDXzCCAkegAwIBAgILBAAAAAABIVhTCKIwDQ']) assert.ok(!kernel.includes(name), `${name} is not in the kernel`);
  const shim = fs.readFileSync(path.join(__dirname, '..', 'local', 'shims', 'passkeys.js'), 'utf8');
  assert.match(shim, /not available on this device/);
});
