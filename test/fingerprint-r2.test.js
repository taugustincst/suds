'use strict';
// The second review of fingerprint sign-in and signing (docs/FINGERPRINT.md, "Second review"): N1 a device's sync
// sign-in is not asked for a fingerprint it cannot give; N2 a client merge leaves fingerprint evidence verifiable;
// N3 reset-admin removes passkeys (test/reset-admin.test.js); N4 an administrator resetting their own two-step
// verification stays signed in; N5 a waiting challenge does not keep the note's plaintext content hash.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { SoftAuthenticator } = require('./authenticator');
const { totp, encrypt } = require('../server/crypto');
const config = require('../server/config');

const PW = 'StaffPassw0rd!x';
const APW = 'AdminPassw0rd!x';
let admin, base;
const setting = (k, v) => { if (v === null) H.db.run(`DELETE FROM settings WHERE key=?`, k); else H.db.setSetting(k, v); };
const resetLimits = () => { const app = require('../server/app'); for (const k of ['passkey-options:127.0.0.1', 'login:127.0.0.1', 'passkey-options:::1', 'login:::1', 'passkey-options:::ffff:127.0.0.1', 'login:::ffff:127.0.0.1']) app.rateLimitReset(k); };

before(async () => {
  base = await H.start();
  config.localModeEnabled = true; // the device pulls
  admin = H.client(); await admin.login('admin', APW);
});
after(H.stop);

let seq = 0;
const key = () => new SoftAuthenticator({ origin: base });
async function person(role = 'navigator', { totpSecret = null } = {}) {
  const u = H.makeUser(`fpr2_${role}_${++seq}`, role);
  if (totpSecret) H.db.run(`UPDATE users SET mfa_enabled=1, mfa_secret_enc=? WHERE id=?`, encrypt(totpSecret), u.id);
  const c = H.client(); const l = await c.login(u.username, PW);
  if (l.mfaPending) assert.equal((await c.post('/api/auth/mfa/verify', { code: totp(totpSecret, Date.now() - 30_000) })).status, 200);
  return { u, c };
}
async function enrol(c, a, { password = PW, code } = {}) {
  const o = await c.post('/api/auth/passkeys/register/options', { password, code });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const r = await c.post('/api/auth/passkeys/register', { credential: a.create(o.data.publicKey), name: 'Test phone' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r;
}
async function confirmWith(c, a, purpose, params = {}) {
  const o = await c.post('/api/auth/passkeys/challenge', { purpose, ...params });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  return a.get(o.data.publicKey);
}
async function newClient() { return (await admin.post('/api/clients', { first_name: 'Second', last_name: `Review${++seq}` })).data.id; }
const draft = async (c, clientId, content = 'Met at the drop-in; talked about detox.') => (await c.post('/api/notes', { client_id: clientId, kind: 'admin', title: 'Visit', content, occurred_at: new Date().toISOString() })).data.id;

/** A device's sign-in and first pull, as local/sync.js does them (X-Sync-Client, X-Device-Id, then the bearer token). */
async function deviceSync(username, { code = null, secret = null } = {}) {
  resetLimits();
  const c = H.client(); c.setHeader('X-Sync-Client', '1'); c.setHeader('X-Device-Id', `dev-${username}`);
  const l = await c.post('/api/auth/login', { username, password: PW });
  const out = { login: l.status, mfaPending: l.data.mfaPending, mfaMethods: l.data.mfaMethods, mfaSetupRequired: l.data.mfaSetupRequired, deadline: l.data.mfaSetupDeadline, token: l.data.token };
  const bearer = { Authorization: 'Bearer ' + l.data.token, Cookie: '' };
  if (l.data.mfaPending && (code || secret)) out.verify = (await c.post('/api/auth/mfa/verify', { code: code || totp(secret, Date.now() + 30_000) }, bearer)).status;
  const p = await c.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', bearer);
  out.pull = p.status; out.pullBody = p.data;
  return out;
}

// ================================================================ N1: a device syncs as it did before passkeys
test('N1: a device sign-in by someone in a role that requires two-step verification is not asked for a fingerprint it cannot give', async () => {
  setting('mfa_required_roles', 'clinician'); setting('mfa_grace_days', '30');
  try {
    const plain = await person('clinician');
    const withKey = await person('clinician'); await enrol(withKey.c, key());
    // In the grace period: the device signs in and pulls, exactly as for someone with no passkey.
    const a = await deviceSync(plain.u.username);
    const b = await deviceSync(withKey.u.username);
    for (const r of [a, b]) {
      assert.equal(r.login, 200); assert.equal(r.mfaPending, false, 'no second step the device cannot give');
      assert.equal(r.mfaMethods, undefined); assert.equal(r.mfaSetupRequired, true); assert.ok(r.deadline, 'the enrolment deadline, as before passkeys');
      assert.equal(r.pull, 200, JSON.stringify(r.pullBody).slice(0, 200));
    }
    assert.ok(Date.parse(b.deadline) > Date.now(), 'still in the grace period');
    // The browser sign-in of the person with a passkey is unchanged: its second step is the fingerprint.
    resetLimits();
    const web = await H.client().post('/api/auth/login', { username: withKey.u.username, password: PW });
    assert.equal(web.data.mfaPending, true); assert.deepEqual(web.data.mfaMethods, ['passkey']);

    // Past the grace period: the device of someone with no passkey is stopped as before (403, set it up); the one with
    // a passkey too, and told what to do about it, as the passkey does not work for a device.
    setting('mfa_grace_days', '0');
    const a2 = await deviceSync(plain.u.username);
    const b2 = await deviceSync(withKey.u.username);
    assert.equal(a2.login, 200); assert.equal(a2.pull, 403); assert.equal(a2.pullBody.mfaSetupRequired, true);
    assert.equal(b2.login, 200); assert.equal(b2.mfaPending, false);
    assert.equal(b2.pull, 403, 'a password alone is one factor, and the passkey was not used');
    assert.equal(b2.pullBody.deviceNeedsAuthenticator, true);
    assert.match(b2.pullBody.error, /authenticator app under My profile to sync this device/);
    // The same session token without the device's headers is not a way round it (the session itself is marked).
    const r = await fetch(`${base}/api/clients?limit=1`, { headers: { Authorization: 'Bearer ' + b2.token, 'X-Requested-With': 'suds' } });
    assert.equal(r.status, 403, 'the device session cannot reach anything else either');
    // The browser: a passkey sign-in (or a password and the fingerprint) still counts, past the deadline too.
    const wc = H.client(); await wc.post('/api/auth/login', { username: withKey.u.username, password: PW });
    assert.equal((await wc.get('/api/clients?limit=1')).status, 401, 'half signed in, owing the fingerprint');
  } finally { setting('mfa_required_roles', null); setting('mfa_grace_days', null); }
});

test('N1: with an authenticator app as well as a passkey, a device sign-in asks for the code, as before passkeys', async () => {
  const s = 'JBSWY3DPEHPK3PXP';
  setting('mfa_required_roles', 'clinician'); setting('mfa_grace_days', '0');
  try {
    const plain = await person('clinician', { totpSecret: s });
    const withKey = await person('clinician', { totpSecret: s });
    await enrol(withKey.c, key(), { code: totp(s, Date.now()) });
    const a = await deviceSync(plain.u.username);
    const b = await deviceSync(withKey.u.username);
    for (const r of [a, b]) {
      assert.equal(r.login, 200); assert.equal(r.mfaPending, true); assert.equal(r.pull, 401, 'owes the code');
      assert.deepEqual(r.mfaMethods, ['totp'], 'the code only: the device cannot offer a fingerprint');
      assert.equal(r.mfaSetupRequired, false); assert.equal(r.deadline, null);
    }
    H.db.run(`UPDATE users SET totp_last_step=NULL`);
    const b2 = await deviceSync(withKey.u.username, { secret: s });
    assert.equal(b2.verify, 200); assert.equal(b2.pull, 200, 'the code finishes the device sign-in and it syncs');
  } finally { setting('mfa_required_roles', null); setting('mfa_grace_days', null); }
});

// ================================================================ N2: a client merge keeps fingerprint evidence verifiable
test('N2: a note signed with a fingerprint still verifies after its client is merged into another record', async () => {
  const keep = await newClient(); const dup = await newClient();
  const p = await person('navigator');
  const a = key(); await enrol(p.c, a);
  const note = await draft(p.c, dup, 'Signed before the merge');
  const s = await p.c.post(`/api/notes/${note}/sign`, { passkey: await confirmWith(p.c, a, 'note.sign', { note_id: note }) });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal((await p.c.get(`/api/notes/${note}/verify`)).data.fingerprint.verified, true);
  const m = await admin.post(`/api/clients/${keep}/merge`, { source_id: dup, reason: 'same person' });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(H.db.one(`SELECT client_id FROM notes WHERE id=?`, note).client_id, keep, 'the note moved to the kept record');
  const v = (await p.c.get(`/api/notes/${note}/verify`)).data;
  assert.equal(v.intact, true);
  assert.equal(v.fingerprint.verified, true, `still verified after the merge (${v.fingerprint.reason})`);
  // What the signature names: the note, not the record it is filed under.
  assert.ok(!('client_id' in require('../server/note-signature').signedContent(H.db.one(`SELECT * FROM notes WHERE id=?`, note), p.u.id)));
});

// ================================================================ N4: resetting one's own two-step verification
test('N4: an administrator who resets their own two-step verification stays signed in; their passkeys go', async () => {
  const me = await person('admin');
  const a = key(); await enrol(me.c, a);
  // Signed in with the passkey (mfa_source 'passkey'), the session the removal would otherwise end.
  resetLimits();
  const c = H.client();
  const o = await c.post('/api/auth/passkeys/login/options', {});
  assert.equal((await c.post('/api/auth/passkeys/login', { credential: a.get(o.data.publicKey) })).status, 200);
  const other = H.client(); resetLimits();
  const o2 = await other.post('/api/auth/passkeys/login/options', {});
  assert.equal((await other.post('/api/auth/passkeys/login', { credential: a.get(o2.data.publicKey) })).status, 200);
  const r = await c.put(`/api/users/${me.u.id}`, { reset_mfa: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM passkeys WHERE user_id=?`, me.u.id).n, 0, 'the passkeys are removed');
  assert.equal((await c.get('/api/auth/me')).status, 200, 'the session that did it is kept');
  assert.equal((await other.get('/api/auth/me')).status, 401, 'another session the passkey opened ends');
  // Someone else's reset still ends every session their passkey opened.
  const them = await person('navigator'); const b = key(); await enrol(them.c, b);
  resetLimits(); const tc = H.client(); const o3 = await tc.post('/api/auth/passkeys/login/options', {});
  assert.equal((await tc.post('/api/auth/passkeys/login', { credential: b.get(o3.data.publicKey) })).status, 200);
  assert.equal((await c.put(`/api/users/${them.u.id}`, { reset_mfa: true })).status, 200);
  assert.equal((await tc.get('/api/auth/me')).status, 401);
});

// ================================================================ N5: a waiting challenge keeps no content hash
test('N5: a signing challenge waiting to be answered does not store the note\'s content hash', async () => {
  const NS = require('../server/note-signature');
  const clientId = await newClient();
  const p = await person('navigator');
  const a = key(); await enrol(p.c, a);
  const ids = [await draft(p.c, clientId, 'First'), await draft(p.c, clientId, 'Second')];
  const o = await p.c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: ids[0] });
  assert.equal(o.status, 200);
  const hash = NS.contentHash(H.db.one(`SELECT * FROM notes WHERE id=?`, ids[0]), p.u.id, 'sign');
  const row = H.db.one(`SELECT * FROM webauthn_challenges WHERE user_id=? AND purpose='sign:note.sign' ORDER BY created_at DESC LIMIT 1`, p.u.id);
  assert.ok(row && row.statement, 'the challenge is kept, with what is needed to check it');
  assert.ok(!JSON.stringify(row).includes(hash), 'but not the content hash');
  // It still signs, and the evidence holds the whole statement.
  const s = await p.c.post(`/api/notes/${ids[0]}/sign`, { passkey: a.get(o.data.publicKey) });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal((await p.c.get(`/api/notes/${ids[0]}/verify`)).data.fingerprint.verified, true);
  // A countersignature batch: none of the notes' hashes are kept either.
  const sup = await person('supervisor');
  for (const id of ids.slice(1)) { await p.c.post(`/api/notes/${id}/request-cosign`, {}); }
  const b = key(); await enrol(sup.c, b);
  const cb = await sup.c.post('/api/auth/passkeys/challenge', { purpose: 'note.cosign-batch', ids });
  assert.equal(cb.status, 200);
  const row2 = H.db.one(`SELECT * FROM webauthn_challenges WHERE user_id=? AND purpose='sign:note.cosign-batch' ORDER BY created_at DESC LIMIT 1`, sup.u.id);
  for (const id of ids) assert.ok(!row2.statement.includes(NS.contentHash(H.db.one(`SELECT * FROM notes WHERE id=?`, id), sup.u.id, 'cosign')));
  // An edit after the challenge was issued is still caught.
  const o4 = await p.c.post('/api/auth/passkeys/challenge', { purpose: 'note.sign', note_id: ids[1] });
  await p.c.put(`/api/notes/${ids[1]}`, { content: 'Second, edited after confirming' });
  const changed = await p.c.post(`/api/notes/${ids[1]}/sign`, { passkey: a.get(o4.data.publicKey) });
  assert.equal(changed.status, 403); assert.equal(changed.data.passkeyError, 'record changed');
});
