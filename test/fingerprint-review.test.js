'use strict';
const LD = require('../server/local-date'); // the programme's calendar, as the server dates things
// The review of fingerprint sign-in and signing (docs/FINGERPRINT.md, "Review of 1.19.0's fingerprint work"): each
// finding's fix, tested where it can be seen (the route, the sync push, the verifier on its own), with outside test
// vectors (test/fixtures/webauthn: real browser and authenticator responses from py_webauthn's suite, and RFC 8949's
// CBOR examples) beside the software authenticator (test/authenticator.js). Every test sets up what it needs.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const { SoftAuthenticator, cbor, b64url, fromB64url } = require('./authenticator');
const W = require('../server/webauthn');
const { totp, encrypt, decrypt } = require('../server/crypto');
const config = require('../server/config');

const PW = 'StaffPassw0rd!x';
const APW = 'AdminPassw0rd!x';
let admin, base;
const today = () => LD.today();
const yearFrom = (years) => { const [y, m, d] = LD.today().split('-').map(Number); return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10); };
const setting = (k, v) => { if (v === null) H.db.run(`DELETE FROM settings WHERE key=?`, k); else H.db.setSetting(k, v); };
const resetLimits = () => { const app = require('../server/app'); for (const k of ['passkey-options:127.0.0.1', 'login:127.0.0.1', 'passkey-options:::1', 'login:::1', 'passkey-options:::ffff:127.0.0.1', 'login:::ffff:127.0.0.1']) app.rateLimitReset(k); };

before(async () => {
  base = await H.start();
  config.localModeEnabled = true; // the sync push tests
  admin = H.client(); await admin.login('admin', APW);
});
after(H.stop);

let seq = 0;
const key = (o = {}) => new SoftAuthenticator({ origin: base, ...o });
async function person(role = 'navigator', { totpSecret = null } = {}) {
  const u = H.makeUser(`fpr_${role}_${++seq}`, role);
  if (totpSecret) H.db.run(`UPDATE users SET mfa_enabled=1, mfa_secret_enc=? WHERE id=?`, encrypt(totpSecret), u.id);
  const c = H.client(); const l = await c.login(u.username, PW);
  if (l.mfaPending) assert.equal((await c.post('/api/auth/mfa/verify', { code: totp(totpSecret, Date.now() - 30_000) })).status, 200);
  return { u, c };
}
async function enrol(c, a, { password = PW, code, name = 'Test phone', bend } = {}) {
  const o = await c.post('/api/auth/passkeys/register/options', { password, code });
  if (o.status !== 200) return o;
  return c.post('/api/auth/passkeys/register', { credential: a.create(o.data.publicKey, bend), name });
}
async function confirmWith(c, a, purpose, params = {}, bend) {
  const o = await c.post('/api/auth/passkeys/challenge', { purpose, ...params });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  return a.get(o.data.publicKey, bend);
}
async function passkeyLogin(a, { bend, client: c = H.client(), body = {} } = {}) {
  resetLimits();
  const o = await c.post('/api/auth/passkeys/login/options', body);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const r = await c.post('/api/auth/passkeys/login', { credential: a.get(o.data.publicKey, bend) });
  return { r, c, options: o.data };
}
async function newClient() { return (await admin.post('/api/clients', { first_name: 'Review', last_name: `Client${++seq}` })).data.id; }
const draft = async (c, clientId, content = 'Met at the drop-in; talked about detox.') => (await c.post('/api/notes', { client_id: clientId, kind: 'admin', title: 'Visit', content, occurred_at: new Date().toISOString() })).data.id;
const stale = (userId) => H.db.run(`UPDATE sessions SET reauth_at=? WHERE user_id=? AND revoked_at IS NULL`, new Date(Date.now() - 60 * 60000).toISOString(), userId);

// ================================================================ finding 1: a code that is given must verify
test('finding 1: a password with a made-up code never signs or approves, anywhere; with the policy on, the password alone never does', async () => {
  const s = 'JBSWY3DPEHPK3PXP';
  const clientId = await newClient();
  const w = await person('navigator', { totpSecret: s });
  const sup = await person('supervisor', { totpSecret: s });
  const other = await person('navigator');
  const notes = [];
  for (let i = 0; i < 3; i++) { const id = await draft(w.c, clientId, `Cosign me ${i}`); await w.c.post(`/api/notes/${id}/request-cosign`, {}); assert.equal((await w.c.post(`/api/notes/${id}/sign`, { confirm: true })).status, 200); notes.push(id); }
  const fund = (await admin.post('/api/budget/funds', { name: `Review fund ${seq}`, source_type: 'other', fiscal_year_start: yearFrom(-1), fiscal_year_end: yearFrom(1), total_amount: 100000 })).data.id;
  const mkTime = async () => { const t = (await other.c.post('/api/time', { work_date: today(), minutes: 30, category: 'documentation' })).data.id; await other.c.post(`/api/time/${t}/submit`, {}); return t; };
  const mkExp = async () => (await other.c.post('/api/budget/expenditures', { funding_source_id: fund, spent_at: today(), amount: 5, category: 'client_assistance' })).data.id;
  const junk = { password: PW, code: '000000' };
  const keyAdmin = await person('admin', { totpSecret: s });
  const restoreKeys = H.throwawayKeys(config);
  try {
    for (const strong of ['1', '0']) {
      setting('sign_strong_required', strong);
      stale(w.u.id); stale(sup.u.id); stale(keyAdmin.u.id);
      const n = await draft(w.c, clientId);
      const t1 = await mkTime(); const t2 = await mkTime(); const t3 = await mkTime(); const e = await mkExp();
      const tries = [
        ['note sign', () => w.c.post(`/api/notes/${n}/sign`, junk), () => H.db.one(`SELECT status FROM notes WHERE id=?`, n).status === 'draft'],
        ['countersign', () => sup.c.post(`/api/notes/${notes[0]}/cosign`, junk), () => !H.db.one(`SELECT cosigned_at FROM notes WHERE id=?`, notes[0]).cosigned_at],
        ['countersign batch', () => sup.c.post('/api/notes/cosign-batch', { ids: [notes[1], notes[2]], ...junk }), () => !H.db.one(`SELECT cosigned_at FROM notes WHERE id=?`, notes[1]).cosigned_at],
        ['time approve', () => sup.c.post(`/api/time/${t1}/approve`, { decision: 'approved', ...junk }), () => H.db.one(`SELECT status FROM time_entries WHERE id=?`, t1).status === 'submitted'],
        ['time approve-batch', () => sup.c.post('/api/time/approve-batch', { ids: [t2, t3], decision: 'approved', ...junk }), () => H.db.one(`SELECT status FROM time_entries WHERE id=?`, t2).status === 'submitted'],
        ['expenditure approve', () => sup.c.post(`/api/budget/expenditures/${e}/approve`, { status: 'approved', ...junk }), () => H.db.one(`SELECT status FROM expenditures WHERE id=?`, e).status !== 'approved'],
        ['key backup', () => keyAdmin.c.post('/api/admin/keys-backup', junk), () => true],
      ];
      for (const [what, send, unchanged] of tries) {
        H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL`);
        const r = await send();
        assert.ok(r.status >= 400, `${what} (policy ${strong}): password + a made-up code is refused (${r.status} ${JSON.stringify(r.data).slice(0, 160)})`);
        assert.ok(unchanged(), `${what} (policy ${strong}): nothing changed`);
      }
      assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.sign.failed' AND user_id=? AND details LIKE '%totp%'`, w.u.id), 'the wrong code is audited as a failed attempt');
    }
    // With the policy on, the password alone is refused everywhere a password was accepted, and the right code signs.
    setting('sign_strong_required', '1');
    const n = await draft(w.c, clientId);
    stale(w.u.id);
    const pw = await w.c.post(`/api/notes/${n}/sign`, { password: PW });
    assert.equal(pw.status, 403); assert.equal(pw.data.strongRequired, true);
    const ok = await w.c.post(`/api/notes/${n}/sign`, { password: PW, code: totp(s, Date.now() + 30_000) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, n).details).identity, 'totp', 'the code is what counted');
    // Someone with no authenticator app who sends a code is told how to sign, and nothing is signed.
    const n2 = await draft(other.c, clientId);
    const none = await other.c.post(`/api/notes/${n2}/sign`, { password: PW, code: '123456' });
    assert.equal(none.status, 400); assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, n2).status, 'draft');
    // A fingerprint with a password or code beside it: one proof at a time.
    const a = key(); assert.equal((await enrol(other.c, a)).status, 201);
    const both = await other.c.post(`/api/notes/${n2}/sign`, { passkey: await confirmWith(other.c, a, 'note.sign', { note_id: n2 }), code: '000000' });
    assert.equal(both.status, 400);
  } finally { setting('sign_strong_required', null); restoreKeys(); H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL`); }
});

// ================================================================ finding 2 (D2): a signed note by sync push under the policy
test('finding 2: with "Require fingerprint or authenticator for signing" on, a note pushed as signed lands as a draft, flagged and audited', async () => {
  const clientId = await newClient();
  const w = await person('navigator');
  const iso = (ms = Date.now()) => new Date(ms).toISOString();
  const row = (id) => ({ id, client_id: clientId, author_id: w.u.id, kind: 'admin', format: 'narrative', content_enc: 'Signed on the phone, offline', occurred_at: iso(), status: 'signed', signed_by: w.u.id, signed_at: iso(), part2_protected: 1, updated_at: iso() });
  setting('sign_strong_required', '1');
  try {
    const id = crypto.randomUUID();
    const r = await w.c.post('/api/sync/push', { device_now: iso(), tables: { notes: [row(id)] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const n = H.db.one(`SELECT status, signed_by, signed_at, signature_hash FROM notes WHERE id=?`, id);
    assert.ok(n, 'the note landed');
    assert.deepEqual({ ...n }, { status: 'draft', signed_by: null, signed_at: null, signature_hash: null }, 'as a draft, with no signature');
    const warn = (r.data.warnings || []).find(x => x.id === id);
    assert.ok(warn && warn.flagged && /draft, not signed/.test(warn.reason) && /fingerprint or an authenticator code/.test(warn.reason), `the device is told why: ${JSON.stringify(r.data.warnings)}`);
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='sync.conflict' AND entity_id=? AND details LIKE '%strong_signing%'`, id), 'flagged in the audit trail');
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.sign.failed' AND entity_id=? AND success=0 AND details LIKE '%"via":"sync"%'`, id), 'and the refused signature audited');
    assert.ok(!H.db.one(`SELECT 1 FROM audit_log WHERE action='note.sign' AND entity_id=?`, id), 'no signature is recorded');
    // The same device editing a draft it already has, and signing it: still a draft.
    const id2 = crypto.randomUUID();
    await w.c.post('/api/sync/push', { device_now: iso(), tables: { notes: [{ ...row(id2), status: 'draft', signed_by: null, signed_at: null }] } });
    await w.c.post('/api/sync/push', { device_now: iso(), tables: { notes: [{ ...row(id2), updated_at: iso(Date.now() + 2000) }] } });
    assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, id2).status, 'draft');
  } finally { setting('sign_strong_required', null); }
  // With the policy off, a device's signature stands as before.
  const id3 = crypto.randomUUID();
  await w.c.post('/api/sync/push', { device_now: iso(), tables: { notes: [row(id3)] } });
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, id3).status, 'signed');
});

// ================================================================ finding 3: weak keys
test('finding 3: an RSA key under 2048 bits or with an exponent other than 65537, an EC key off P-256 or off the curve, and a short Ed25519 key are refused', async () => {
  // A 128-bit modulus padded with zero bytes to look like 2048 bits, with e = 1 (every "signature" would verify).
  const n = Buffer.alloc(256); crypto.randomBytes(16).copy(n, 240); n[240] |= 0x80; n[255] |= 1;
  assert.throws(() => W.coseToKey(new Map([[1, 3], [3, -257], [-1, n], [-2, Buffer.from([1])]])), (e) => e.code === 'cose' && /2048 bits or more with the exponent 65537/.test(e.message), '128-bit, e=1');
  const rsa = (bits, e) => { const k = crypto.generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: e }).publicKey.export({ format: 'jwk' }); return new Map([[1, 3], [3, -257], [-1, fromB64url(k.n)], [-2, fromB64url(k.e)]]); };
  assert.throws(() => W.coseToKey(rsa(2048, 3)), /65537/, 'e = 3');
  assert.throws(() => W.coseToKey(rsa(1024, 65537)), /2048/, '1024 bits');
  assert.equal(W.coseToKey(rsa(2048, 65537)).alg, -257, 'a proper RS256 key is accepted');
  assert.throws(() => W.coseToKey(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 2)]])), /P-256/, 'a point that is not on the curve');
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
  assert.throws(() => W.coseToKey(new Map([[1, 2], [3, -7], [-1, 2], [-2, fromB64url(p384.x)], [-3, fromB64url(p384.y)]])), /P-256/, 'another curve');
  assert.throws(() => W.coseToKey(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.alloc(31, 7)]])), /Ed25519/, 'a 31-byte Ed25519 key');
  // At enrolment: the weak key is refused and nothing is stored.
  const { u, c } = await person();
  class WeakRsa extends SoftAuthenticator { coseKey() { return new Map([[1, 3], [3, -257], [-1, n], [-2, Buffer.from([1])]]); } }
  const r = await enrol(c, new WeakRsa({ origin: base, alg: 'RS256' }));
  assert.equal(r.status, 400); assert.equal(r.data.passkeyError, 'cose');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, u.id).n, 0);
  // A weak key in stored evidence does not verify either (keyFromSpki checks it as enrolment does).
  const weakSpki = crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: 'AQ' }, format: 'jwk' }).export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => W.keyFromSpki(weakSpki, -257), /2048/);
});

// ================================================================ finding 4 (D1): the relying party must be configured in production
test('finding 4: in production passkeys need WEBAUTHN_RP_ID (or WEBAUTHN_ORIGINS); X-Forwarded-Host never chooses the RP ID', async () => {
  const P = require('../server/passkeys');
  const ctx = (host, extra = {}) => ({ headers: { host, ...extra } });
  const saved = { ...config.webauthn }; const wasProxy = config.trustProxy; const wasProd = config.isProd;
  try {
    config.trustProxy = true; config.webauthn.rpId = ''; config.webauthn.origins = [];
    // Outside production, the Host header is the fallback, and a forwarded host does not replace it.
    assert.equal(P.relyingParty(ctx('localhost:8080')).rpId, 'localhost');
    let rp = null; try { rp = P.relyingParty(ctx('localhost:8080', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })); } catch (e) { rp = { refused: e.message }; }
    assert.notEqual(rp.rpId, 'evil.example', 'X-Forwarded-Host never sets the RP ID');
    // Production without it: refused, with a message for the administrator.
    config.isProd = true;
    assert.throws(() => P.relyingParty(ctx('suds.county.example', { 'x-forwarded-proto': 'https' })), (e) => e.status === 503 && /WEBAUTHN_RP_ID/.test(e.message) && e.extra.passkeyUnavailable === 'config');
    // WEBAUTHN_ORIGINS alone (the public URL) is enough: its host is the RP ID.
    config.webauthn.origins = ['https://suds.county.example'];
    assert.equal(P.relyingParty(ctx('suds.county.example', { 'x-forwarded-proto': 'https' })).rpId, 'suds.county.example');
    config.webauthn.origins = []; config.webauthn.rpId = 'suds.county.example';
    assert.deepEqual(P.relyingParty(ctx('suds.county.example', { 'x-forwarded-proto': 'https' })).origins, ['https://suds.county.example']);
    // Through the routes and Security status.
    config.webauthn.rpId = '';
    resetLimits();
    const st = (await H.client().get('/api/auth/passkeys/status')).data;
    assert.equal(st.available, false); assert.match(st.reason, /WEBAUTHN_RP_ID/);
    const opts = await H.client().post('/api/auth/passkeys/login/options', {});
    assert.equal(opts.status, 503); assert.equal(opts.data.passkeyUnavailable, 'config');
    const item = (await admin.get('/api/admin/security/status')).data.items.find(i => i.name === 'Fingerprint sign-in (passkeys)');
    assert.equal(item.level, 'bad', 'Security status shows it in red'); assert.match(`${item.value} ${item.detail}`, /WEBAUTHN_RP_ID/);
  } finally { Object.assign(config.webauthn, saved); config.trustProxy = wasProxy; config.isProd = wasProd; }
});

// ================================================================ finding 5 (D3): plaintext binding, enrolment anchor, evidence checks
async function signedWithFingerprint() {
  const clientId = await newClient();
  const p = await person();
  const a = key(); assert.equal((await enrol(p.c, a)).status, 201);
  const note = await draft(p.c, clientId, `Signed with a fingerprint ${seq}`);
  const r = await p.c.post(`/api/notes/${note}/sign`, { passkey: await confirmWith(p.c, a, 'note.sign', { note_id: note }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const evId = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, note).details).evidence;
  return { ...p, a, note, clientId, evId, signatureHash: r.data.signature_hash };
}
test('finding 5: a fingerprint signature is bound to the note\'s plaintext content hash, and the enrolment audit entry anchors the key', async () => {
  const NS = require('../server/note-signature');
  const s = await signedWithFingerprint();
  const n = H.db.one(`SELECT * FROM notes WHERE id=?`, s.note);
  const ev = JSON.parse(decrypt(H.db.one(`SELECT evidence_enc FROM signature_evidence WHERE id=?`, s.evId).evidence_enc));
  assert.equal(ev.statement.content, NS.contentHash(n, s.u.id, 'sign'), 'the statement names the plaintext content hash');
  assert.notEqual(ev.statement.content, n.signature_hash, 'not the ciphertext hash');
  assert.equal(NS.signatureHash(n, s.u.id), n.signature_hash, 'the note still carries its ciphertext signature hash (back-compatibility)');
  // The enrolment entry records the key's and the credential's SHA-256, and nothing that opens anything.
  const enrolled = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='auth.passkey.enrolled' AND entity_id=?`, ev.passkey_id).details);
  assert.equal(enrolled.spki_sha256, crypto.createHash('sha256').update(Buffer.from(ev.public_key, 'base64')).digest('hex'));
  assert.equal(enrolled.credential_sha256, crypto.createHash('sha256').update(fromB64url(ev.credential_id)).digest('hex'));
  const v = (await s.c.get(`/api/notes/${s.note}/verify`)).data;
  assert.equal(v.fingerprint.verified, true); assert.equal(v.fingerprint.content_hash, ev.statement.content);
  // Evidence re-signed with another key (someone with the database and the key rewrites it): the enrolment says no.
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const data = Buffer.concat([fromB64url(ev.authenticator_data), crypto.createHash('sha256').update(fromB64url(ev.client_data_json)).digest()]);
  const forged = { ...ev, public_key: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature: b64url(crypto.sign('sha256', data, { key: other.privateKey, dsaEncoding: 'der' })) };
  assert.equal(W.verifyEvidence(forged).ok, true, 'on its own the forged evidence is self-consistent');
  H.db.run(`UPDATE signature_evidence SET evidence_enc=? WHERE id=?`, encrypt(JSON.stringify(forged)), s.evId);
  const after = (await s.c.get(`/api/notes/${s.note}/verify`)).data;
  assert.equal(after.fingerprint.verified, false, 'but it is not the key enrolled'); assert.equal(after.fingerprint.reason, 'anchor');
  const exp = (await admin.get(`/api/admin/signature-evidence?record_type=note&record_id=${s.note}`)).data;
  assert.equal(exp.rows[0].verified, false); assert.ok(exp.rows[0].enrolment && exp.rows[0].enrolment.spki_sha256, 'the export carries the enrolment record');
});

test('finding 5: the evidence check refuses another RP ID in the statement, a plain-http origin, an embedded page and a new credential in an assertion', () => {
  const a = new SoftAuthenticator({ origin: 'https://suds.county.example' });
  const make = ({ origin = 'https://suds.county.example', crossOrigin, topOrigin, statementRp = 'suds.county.example', at = false } = {}) => {
    const statement = { v: 1, purpose: 'note.sign', record_type: 'note', record_ids: ['n1'], content: 'c'.repeat(64), user_id: 'u1', rp_id: statementRp, issued_at: new Date().toISOString(), nonce: 'ab' };
    const got = a.get({ challenge: b64url(W.statementChallenge(statement)) }, { origin, crossOrigin, topOrigin, at });
    return { v: 1, statement, rp_id: 'suds.county.example', origin, credential_id: a.id, public_key: a.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), alg: -7,
      authenticator_data: got.response.authenticatorData, client_data_json: got.response.clientDataJSON, signature: got.response.signature };
  };
  assert.equal(W.verifyEvidence(make()).ok, true, 'a good one verifies');
  assert.equal(W.verifyEvidence(make({ crossOrigin: false })).ok, true, 'crossOrigin false is fine');
  for (const [bend, check] of [[{ statementRp: 'other.example' }, 'rp'], [{ origin: 'http://suds.county.example' }, 'origin'], [{ crossOrigin: true }, 'origin'], [{ topOrigin: 'https://evil.example' }, 'origin'], [{ at: true }, 'flags']]) {
    const r = W.verifyEvidence(make(bend));
    assert.equal(r.ok, false, JSON.stringify(bend)); assert.equal(r.reason, check, JSON.stringify(bend));
  }
  const local = new SoftAuthenticator({ origin: 'http://localhost:8080' });
  const st = { v: 1, purpose: 'keys.download', record_type: 'keys', record_ids: ['keys-backup'], content: 'x', user_id: 'u', rp_id: 'localhost', issued_at: 't', nonce: 'n' };
  const g = local.get({ challenge: b64url(W.statementChallenge(st)) });
  assert.equal(W.verifyEvidence({ statement: st, rp_id: 'localhost', public_key: local.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), alg: -7, authenticator_data: g.response.authenticatorData, client_data_json: g.response.clientDataJSON, signature: g.response.signature }).ok, true, 'http://localhost is a developer\'s machine');
});

test('finding 5: a key rotation (scripts/rotate-key.js, on a copy of the database) leaves fingerprint evidence verifying and signed notes intact', async () => {
  const NS = require('../server/note-signature');
  const s = await signedWithFingerprint();
  // A note changed after it was signed (tampered in the database): it must still read as changed after rotation.
  const tampered = await draft(s.c, s.clientId, 'Signed, then changed behind SUDS\'s back');
  stale(s.u.id);
  assert.equal((await s.c.post(`/api/notes/${tampered}/sign`, { passkey: await confirmWith(s.c, s.a, 'note.sign', { note_id: tampered }) })).status, 200);
  H.db.run(`UPDATE notes SET content_enc=? WHERE id=?`, encrypt('Rewritten afterwards'), tampered);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-rotate-'));
  const file = path.join(dir, 'copy.db');
  try {
    H.db.get().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const newKey = crypto.randomBytes(32);
    const out = require('node:child_process').spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'scripts', 'rotate-key.js')], {
      env: { ...process.env, SUDS_ENV: 'test', SUDS_DB_PATH: file, SUDS_ENCRYPTION_KEY: config.encryptionKey.toString('hex'), SUDS_INDEX_KEY: config.indexKey.toString('hex'), NEW_ENCRYPTION_KEY: newKey.toString('hex') }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.match(out.stdout, /signature hash(es)? recomputed/);
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(file, { readOnly: true });
    try {
      const evRow = d.prepare(`SELECT evidence_enc FROM signature_evidence WHERE id=?`).get(s.evId);
      assert.throws(() => decrypt(evRow.evidence_enc), 'the evidence is under the new key');
      const ev = JSON.parse(decrypt(evRow.evidence_enc, newKey));
      assert.equal(W.verifyEvidence(ev).ok, true, 'the evidence still verifies');
      const n = d.prepare(`SELECT * FROM notes WHERE id=?`).get(s.note);
      const plain = { ...n, content_enc: encrypt(decrypt(n.content_enc, newKey)), title_enc: n.title_enc ? encrypt(decrypt(n.title_enc, newKey)) : null, structured_enc: n.structured_enc ? encrypt(decrypt(n.structured_enc, newKey)) : null };
      assert.equal(NS.contentHash(plain, s.u.id, 'sign'), ev.statement.content, 'its statement still names the note\'s content hash, read under the new key');
      assert.equal(NS.signatureHash(n, n.signed_by), n.signature_hash, 'the note\'s ciphertext signature hash was recomputed: it reads intact');
      assert.notEqual(n.signature_hash, s.signatureHash, 'and it is a new hash');
      const t = d.prepare(`SELECT * FROM notes WHERE id=?`).get(tampered);
      assert.notEqual(NS.signatureHash(t, t.signed_by), t.signature_hash, 'a note that was not intact before is not made intact by the rotation');
      const au = d.prepare(`SELECT details FROM audit_log WHERE action='security.key_rotated' ORDER BY id DESC LIMIT 1`).get();
      assert.ok(JSON.parse(au.details).signature_hashes_left_broken >= 1, 'and the rotation records how many it left');
    } finally { d.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('finding 5: a countersignature given with others verifies only while the note\'s own content hash is among those signed', async () => {
  const clientId = await newClient();
  const w = await person('navigator'); const sup = await person('supervisor');
  const a = key(); await enrol(sup.c, a);
  const ids = [];
  for (let i = 0; i < 2; i++) { const id = await draft(w.c, clientId, `Batch ${i}`); await w.c.post(`/api/notes/${id}/request-cosign`, {}); await w.c.post(`/api/notes/${id}/sign`, { confirm: true }); ids.push(id); }
  stale(sup.u.id);
  const r = await sup.c.post('/api/notes/cosign-batch', { ids, passkey: await confirmWith(sup.c, a, 'note.cosign-batch', { ids }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = (await sup.c.get(`/api/notes/${ids[0]}/verify`)).data;
  assert.equal(v.cosign_fingerprint.verified, true, JSON.stringify(v.cosign_fingerprint));
  const ev = require('../server/passkeys').evidenceFor('note', ids[0], { purpose: 'note.cosign-batch' })[0].evidence;
  assert.equal(ev.statement.items.length, 2, 'the statement lists each note with its own hash');
  // The note's text changed afterwards: its hash is no longer among those countersigned.
  H.db.run(`UPDATE notes SET content_enc=? WHERE id=?`, encrypt('Changed after the countersignature'), ids[0]);
  const after = (await sup.c.get(`/api/notes/${ids[0]}/verify`)).data;
  assert.equal(after.cosign_fingerprint.verified, false); assert.equal(after.cosign_fingerprint.reason, 'content');
  assert.equal((await sup.c.get(`/api/notes/${ids[1]}/verify`)).data.cosign_fingerprint.verified, true, 'the other note in the batch still verifies');
});

test('finding 5: the offline verifier checks the enrolment record, from the evidence export or a verified audit export', async () => {
  const s = await signedWithFingerprint();
  const { run } = require('../scripts/verify-passkey-evidence');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-fpv-'));
  try {
    const exp = (await admin.get(`/api/admin/signature-evidence?record_type=note&record_id=${s.note}`)).data;
    const file = path.join(dir, 'evidence.json');
    fs.writeFileSync(file, JSON.stringify(exp));
    const content = exp.rows[0].evidence.statement.content;
    const good = run([file, '--content', content]);
    assert.equal(good.code, 0, good.lines.join('\n')); assert.match(good.lines.join('\n'), /enrolled key matches/);
    // With the audit export (verified first), the enrolment record comes from the hash-chained log.
    const auditRes = await admin.raw('/api/admin/audit/export');
    const auditFile = path.join(dir, 'audit.ndjson'); fs.writeFileSync(auditFile, Buffer.from(await auditRes.arrayBuffer()));
    const withAudit = run([file, '--audit', auditFile]);
    assert.equal(withAudit.code, 0, withAudit.lines.join('\n')); assert.match(withAudit.lines.join('\n'), /read from the audit export/);
    // The key swapped in the evidence export (and its enrolment record with it): the audit export still says no.
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ev = exp.rows[0].evidence;
    const data = Buffer.concat([fromB64url(ev.authenticator_data), crypto.createHash('sha256').update(fromB64url(ev.client_data_json)).digest()]);
    ev.public_key = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    ev.signature = b64url(crypto.sign('sha256', data, { key: other.privateKey, dsaEncoding: 'der' }));
    exp.rows[0].enrolment = { ...exp.rows[0].enrolment, ...W.credentialFingerprints({ publicKey: ev.public_key, credentialId: ev.credential_id }) };
    fs.writeFileSync(file, JSON.stringify(exp));
    assert.equal(run([file]).code, 0, 'the evidence export alone can be rewritten consistently');
    const caught = run([file, '--audit', auditFile]);
    assert.equal(caught.code, 1); assert.match(caught.lines.join('\n'), /enrolled key DOES NOT MATCH/);
    // No enrolment record at all: not verified.
    delete exp.rows[0].enrolment; fs.writeFileSync(file, JSON.stringify(exp));
    assert.match(run([file]).lines.join('\n'), /NO ENROLMENT RECORD/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================ finding 6: resets remove passkeys; revoking ends their sessions
test('finding 6: resetting two-step verification or the password removes the person\'s passkeys (audited); revoking passkeys ends the sessions they opened', async () => {
  const one = await person();
  await enrol(one.c, key());
  assert.equal((await admin.put(`/api/users/${one.u.id}`, { reset_mfa: true })).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, one.u.id).n, 0, 'reset_mfa removes them');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.passkey.removed' AND entity_id=? AND details LIKE '%two-step verification reset%'`, one.u.id));
  const two = await person();
  await enrol(two.c, key());
  assert.equal((await admin.put(`/api/users/${two.u.id}`, { password: 'Reset-Passw0rd!x', wipe_devices: false })).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, two.u.id).n, 0, 'a password reset by an administrator removes them');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.passkey.removed' AND entity_id=? AND details LIKE '%password reset%'`, two.u.id));
  // An administrator revokes them: the sessions a passkey opened end; a password session does not.
  const three = await person();
  const a = key(); await enrol(three.c, a);
  const { r, c: viaKey } = await passkeyLogin(a);
  assert.equal(r.status, 200);
  assert.equal((await viaKey.get('/api/auth/me')).status, 200);
  assert.equal((await admin.del(`/api/users/${three.u.id}/passkeys`)).status, 200);
  assert.equal((await viaKey.get('/api/auth/me')).status, 401, 'the session the passkey opened has ended');
  assert.equal((await three.c.get('/api/auth/me')).status, 200, 'the password session goes on');
  // The owner removes one: the other sessions that passkey opened end, their own (which gave the password) does not.
  const four = await person();
  const k1 = key(); const k2 = key(); await enrol(four.c, k1); await enrol(four.c, k2);
  const s1 = (await passkeyLogin(k1)).c; const s2 = (await passkeyLogin(k2)).c;
  const pid = H.db.one(`SELECT id FROM passkeys WHERE credential_id=?`, k1.id).id;
  assert.equal((await s2.del(`/api/auth/passkeys/${pid}`, { password: PW })).status, 200);
  assert.equal((await s1.get('/api/auth/me')).status, 401, 'the session k1 opened has ended');
  assert.equal((await s2.get('/api/auth/me')).status, 200, 'the session that removed it goes on');
  const pid2 = H.db.one(`SELECT id FROM passkeys WHERE credential_id=?`, k2.id).id;
  assert.equal((await s2.del(`/api/auth/passkeys/${pid2}`, { password: PW })).status, 200);
  assert.equal((await s2.get('/api/auth/me')).status, 200, 'even when it was opened by the passkey it removed');
});

// ================================================================ finding 7: sign-in options say nothing about accounts
test('finding 7: sign-in options are for discoverable passkeys only, whatever username is sent; the second step lists the account\'s own', async () => {
  const { u, c } = await person('clinician');
  const a = key(); await enrol(c, a);
  resetLimits();
  const named = (await H.client().post('/api/auth/passkeys/login/options', { username: u.username })).data;
  const nobody = (await H.client().post('/api/auth/passkeys/login/options', { username: 'nobody_here_at_all' })).data;
  const none = (await H.client().post('/api/auth/passkeys/login/options', {})).data;
  for (const o of [named, nobody, none]) { assert.deepEqual(o.publicKey.allowCredentials, [], 'no credential ids'); assert.deepEqual(Object.keys(o.publicKey).sort(), ['allowCredentials', 'challenge', 'rpId', 'timeout', 'userVerification']); }
  // A discoverable passkey signs in with no username.
  assert.equal((await passkeyLogin(a)).r.status, 200);
  // The second step of a password sign-in knows the account, so it lists its passkeys.
  setting('mfa_required_roles', 'clinician');
  try {
    const c2 = H.client(); const l = await c2.login(u.username, PW);
    assert.equal(l.mfaPending, true);
    resetLimits();
    const o = await c2.post('/api/auth/passkeys/login/options', {});
    assert.equal(o.data.purpose, 'mfa'); assert.deepEqual(o.data.publicKey.allowCredentials.map(x => x.id), [a.id]);
    assert.equal((await c2.post('/api/auth/passkeys/login', { credential: a.get(o.data.publicKey) })).status, 200);
  } finally { setting('mfa_required_roles', null); }
});

// ================================================================ finding 8: hardening
test('finding 8: unanswered sign-in challenges are capped per address, and expired ones are swept', async () => {
  const P = require('../server/passkeys');
  H.db.run(`DELETE FROM webauthn_challenges WHERE user_id IS NULL`);
  resetLimits();
  const statuses = [];
  for (let i = 0; i < P.MAX_OPEN_PER_IP + 1; i++) statuses.push((await H.client().post('/api/auth/passkeys/login/options', {})).status);
  assert.deepEqual(statuses.slice(0, P.MAX_OPEN_PER_IP), Array(P.MAX_OPEN_PER_IP).fill(200));
  assert.equal(statuses[P.MAX_OPEN_PER_IP], 429, 'one more waiting from the same address is refused');
  assert.ok(H.db.one(`SELECT ip FROM webauthn_challenges WHERE user_id IS NULL LIMIT 1`).ip, 'each records the address that asked');
  // Expired over an hour ago: swept.
  H.db.run(`UPDATE webauthn_challenges SET expires_at=? WHERE user_id IS NULL`, new Date(Date.now() - 2 * 3600_000).toISOString());
  assert.ok(P.purge() >= P.MAX_OPEN_PER_IP);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM webauthn_challenges WHERE user_id IS NULL`).n, 0);
  resetLimits();
  assert.equal((await H.client().post('/api/auth/passkeys/login/options', {})).status, 200, 'and asking works again');
  H.db.run(`DELETE FROM webauthn_challenges WHERE user_id IS NULL`);
});

test('finding 8: an assertion from a page embedded in another site (topOrigin), claiming a backup without eligibility, or carrying a new credential is refused', async () => {
  const { c } = await person();
  const a = key(); await enrol(c, a);
  for (const [bend, code] of [[{ topOrigin: 'https://evil.example' }, 'origin'], [{ bs: true }, 'flags'], [{ at: true }, 'authdata']]) {
    H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL`);
    const { r } = await passkeyLogin(a, { bend });
    assert.equal(r.status, 401, JSON.stringify(bend)); assert.equal(r.data.passkeyError, code, JSON.stringify(bend));
  }
  H.db.run(`UPDATE users SET failed_attempts=0, locked_until=NULL`);
  assert.equal((await passkeyLogin(a, { bend: { topOrigin: base } })).r.status, 200, 'a top origin that is SUDS\'s own page is fine');
  assert.equal((await passkeyLogin(a, { bend: { be: true, bs: true } })).r.status, 200, 'and so is a synced passkey that may be');
  assert.equal((await enrol(c, key(), { bend: { bs: true } })).data.passkeyError, 'flags', 'at enrolment too');
});

test('finding 8: CBOR — duplicate byte-string keys, invalid UTF-8, tags and reserved additional information are refused; Ed25519 named -19 is EdDSA', async () => {
  const dup = cbor(new Map([[Buffer.from('ab'), 1], [Buffer.from('ab'), 2]]));
  assert.throws(() => W.cborDecodeAll(dup), /duplicate key/);
  assert.throws(() => W.cborDecodeAll(Buffer.from([0x62, 0xc3, 0x28])), /UTF-8/);
  assert.throws(() => W.cborDecodeAll(Buffer.from('c11a514b67b0', 'hex')), /tags/);
  for (const b of [0x1c, 0x1d, 0x1e]) assert.throws(() => W.cborDecodeAll(Buffer.from([b])), /reserved/, `additional information ${b & 31}`);
  assert.throws(() => W.cborDecodeAll(Buffer.from([0xfc])), /reserved/);
  assert.throws(() => W.cborDecodeAll(Buffer.from([0x1f])), /indefinite/);
  // Enrol and sign in with an Ed25519 key reported as -19.
  const { c } = await person();
  const a = key({ alg: 'EdDSA', coseAlg: -19 });
  const r = await enrol(c, a);
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.passkey.algorithm, 'EdDSA');
  assert.equal((await passkeyLogin(a)).r.status, 200);
  assert.ok((await c.post('/api/auth/passkeys/register/options', { password: PW })).data.publicKey.pubKeyCredParams.some(p => p.alg === -19), 'and it is asked for');
});

// ================================================================ finding 9: outside test vectors
test('finding 9: RFC 8949 Appendix A — every example decodes to its value, or is refused for a reason SUDS gives', () => {
  const { vectors } = require('./fixtures/webauthn/rfc8949-appendix-a.json');
  const plain = (v) => {
    if (Buffer.isBuffer(v)) return { hex: v.toString('hex') };
    if (Array.isArray(v)) return v.map(plain);
    if (v instanceof Map) return [...v.keys()].every(k => typeof k === 'string') ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : { map: [...v].map(([k, x]) => [plain(k), plain(x)]) };
    return v;
  };
  assert.ok(vectors.length >= 80);
  for (const x of vectors) {
    const buf = Buffer.from(x.hex, 'hex');
    if (x.accept) assert.deepEqual(plain(W.cborDecodeAll(buf)), x.decoded, x.hex);
    else assert.throws(() => W.cborDecodeAll(buf), (e) => e.code === 'cbor' && e.message.startsWith(x.reason), `${x.hex}: ${x.reason}`);
  }
});

test('finding 9: real browser and authenticator responses (py_webauthn\'s vectors) verify, or are refused for the reason SUDS gives', () => {
  const V = require('./fixtures/webauthn/py-webauthn-vectors.json');
  assert.match(V.license, /Redistribution and use in source and binary forms/);
  for (const r of V.registration) {
    const got = W.verifyRegistration(r.credential, { challenge: r.challenge, rpId: r.rp_id, origins: r.origins });
    assert.equal(got.alg, r.expect.alg); assert.equal(got.aaguid, r.expect.aaguid); assert.equal(got.signCount, r.expect.sign_count);
    assert.equal(got.credentialId, r.credential.id);
    assert.equal(W.coseToKey(W.cborDecodeAll(fromB64url(r.expect.credential_public_key))).spki, got.publicKey, 'the public key is the one py_webauthn extracts');
    assert.throws(() => W.verifyRegistration(r.credential, { challenge: b64url(crypto.randomBytes(64)), rpId: r.rp_id, origins: r.origins }), /challenge/);
    assert.throws(() => W.verifyRegistration(r.credential, { challenge: r.challenge, rpId: 'example.com', origins: r.origins }), /RP ID/);
  }
  const algs = new Set();
  for (const x of V.assertion) {
    const k = W.coseToKey(W.cborDecodeAll(fromB64url(x.credential_public_key)));
    algs.add(k.alg);
    assert.equal(k.alg, x.expect.alg, x.name);
    const r = x.credential.response;
    assert.equal(W.verifySignature(k.alg, k.key, fromB64url(r.authenticatorData), fromB64url(r.clientDataJSON), fromB64url(r.signature)), x.expect.signature_valid, `${x.name}: signature`);
    const run = () => W.verifyAssertion(x.credential, { publicKey: k.spki, alg: k.alg, signCount: x.stored_sign_count }, { challenge: x.challenge, rpId: x.rp_id, origins: x.origins });
    if (x.expect.ok) {
      const out = run();
      assert.equal(out.uv, true); assert.equal(out.cloned, false);
      if (x.expect.new_sign_count !== undefined) assert.equal(out.signCount, x.expect.new_sign_count);
      // The same response against a stored challenge it was not for.
      assert.throws(() => W.verifyAssertion(x.credential, { publicKey: k.spki, alg: k.alg, signCount: x.stored_sign_count }, { challengeHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), rpId: x.rp_id, origins: x.origins }), /challenge/);
    } else assert.throws(run, (e) => e.code === x.expect.code, `${x.name}: refused as ${x.expect.code}`);
  }
  assert.deepEqual([...algs].sort((x, y) => x - y), [-257, -8, -7], 'ES256, EdDSA and RS256 from outside SUDS');
});

// ================================================================ finding 10: the stored challenge, not the response's own
test('finding 10: an assertion is checked against the challenge SUDS stored, never one read from the response', () => {
  const a = new SoftAuthenticator({ origin: 'https://suds.county.example' });
  const stored = { publicKey: a.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), alg: -7, signCount: 0 };
  const opts = { rpId: 'suds.county.example', origins: ['https://suds.county.example'] };
  const mine = crypto.randomBytes(32);
  const got = a.get({ challenge: b64url(crypto.randomBytes(32)) }); // answering a challenge SUDS did not issue
  assert.throws(() => W.verifyAssertion(got, stored, { ...opts, challengeHash: crypto.createHash('sha256').update(mine).digest('hex') }), /challenge does not match/);
  assert.throws(() => W.verifyAssertion(got, stored, opts), /No expected challenge/, 'and with no expected challenge nothing is accepted');
  const right = a.get({ challenge: b64url(mine) });
  assert.equal(W.verifyAssertion(right, stored, { ...opts, challengeHash: crypto.createHash('sha256').update(mine).digest('hex') }).uv, true);
});

// ================================================================ finding 11: a passkey counts as MFA only while passkey sign-in is allowed
test('finding 11: the account says whether its passkey counts as two-step verification, which it does only while fingerprint sign-in is allowed', async () => {
  const { c } = await person();
  await enrol(c, key());
  const me = (await c.get('/api/auth/me')).data.user;
  assert.equal(me.passkeys, 1); assert.equal(me.passkey_mfa, true);
  setting('passkey_signin', '0');
  try { assert.equal((await c.get('/api/auth/me')).data.user.passkey_mfa, false); } finally { setting('passkey_signin', null); }
});

// ================================================================ finding 13: user references
test('finding 13: a challenge\'s user is a user reference like any other (sync-tables user_refs, a foreign key)', () => {
  const SYNC = require('../server/sync-tables');
  assert.ok(SYNC.user_refs.some(([t, c]) => t === 'webauthn_challenges' && c === 'user_id'));
  assert.ok(H.db.all(`PRAGMA foreign_key_list(webauthn_challenges)`).some(f => f.from === 'user_id' && f.table === 'users'));
  assert.ok(H.db.all(`PRAGMA table_info(sessions)`).some(c => c.name === 'passkey_id'), 'a session records the passkey that opened it');
});

// ================================================================ finding 14: SUDS on this device has none of it
test('finding 14: the browser kernel is built without the WebAuthn code; a stand-in refuses everything as not available', () => {
  const kernel = fs.readFileSync(path.join(__dirname, '..', 'public', 'local', 'kernel.js'), 'utf8');
  for (const name of ['verifyAssertion', 'verifyRegistration', 'cborDecodeAll', 'signingOptions', 'registrationOptions']) assert.ok(!kernel.includes(name), `${name} is not in the kernel`);
  assert.ok(kernel.includes('local/shims/passkeys.js'), 'the stand-in is');
  const shim = require('../local/shims/passkeys.js');
  assert.throws(() => shim.confirm(), (e) => e.status === 404 && /not available on this device/.test(e.message));
  assert.equal(shim.remove('someone', {}), 0);
});
