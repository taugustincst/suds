'use strict';
// The owner's recovery code on SUDS on this device (docs/architecture/ADR-0008-device-encryption.md, "Recovery
// code"): the browser kernel bundled from the current sources and run in Node (test/fixtures/kernel-harness.js).
// Set a device up, make its code, lock it, get back in with the code (the records open, the old password and
// the used code stop working), wrong codes refused and slowed, a new code replacing the old one, only the
// device administrator making one, a device whose administrator is deactivated (the code stops working and the
// administrator who took over makes a new one: 1.15.4), and the code never in the audit log
// or anything stored. The routes are the kernel's alone: an office server answers 404 (the last test).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { loadKernel, kernelCaller } = require('./fixtures/kernel-harness');

let L; let cleanup; let call;
before(async () => { ({ L, cleanup } = await loadKernel({ staticHost: true })); call = kernelCaller(L); });
after(async () => { if (cleanup) cleanup(); });

const PW = 'Lantern-Harbor-2026!'; const PW2 = 'Copper-Kettle-2026!'; const NAV_PW = 'Willow-Canyon-2026!';
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const codes = []; // every code this test was shown, to look for afterwards
const norm = (c) => c.replace(/-/g, '');
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
const signIn = async (username, password) => expect(await call('POST', '/api/auth/login', { username, password }), 200, `sign in as ${username}`);
const signOut = async () => { await call('POST', '/api/auth/logout', {}); assert.equal(L.phase(), 'locked', 'signing out locks the device'); };
const recover = (body) => call('POST', '/api/local/recover', body);
// A code of the right shape that is not this device's.
const otherCode = () => { const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let s = ''; for (let i = 0; i < 28; i++) s += A[(i * 7 + 3) % 32]; return s.match(/.{4}/g).join('-'); };
// Everything the fake IndexedDB holds, as [key, value] pairs.
const stored = () => new Promise((res) => {
  const r = globalThis.indexedDB.open('suds-local', 1);
  r.onsuccess = () => { const s = r.result.transaction('kv', 'readonly').objectStore('kv'); const k = s.getAllKeys(); const v = s.getAll(); v.onsuccess = () => res(k.result.map((key, i) => [key, v.result[i]])); };
});
function bytesOf(x, out = []) {
  if (x instanceof Uint8Array || Buffer.isBuffer(x)) out.push(Buffer.from(x)); else if (x instanceof ArrayBuffer) out.push(Buffer.from(new Uint8Array(x)));
  else if (typeof x === 'string') out.push(Buffer.from(x)); else if (x && typeof x === 'object') for (const y of Object.values(x)) bytesOf(y, out);
  return out;
}

let ownerId; let clientId; let code1; let code2;

test('set-up: the device administrator makes a recovery code after re-entering their password', async () => {
  expect(await call('POST', '/api/local/signup', { display_name: 'Device Owner', username: 'owner', password: PW, role: 'admin', storage_ack: true }), 200, 'first account');
  const me = await signIn('owner', PW); ownerId = me.user.id;
  const dev = expect(await call('GET', '/api/local/device'), 200, 'device');
  assert.equal(dev.device_admin, true);
  assert.deepStrictEqual(dev.recovery, { exists: false, created_at: null, saved: false }, 'a new device has no code until one is made');
  const wrong = await call('POST', '/api/local/recovery', { password: 'Not-The-Password-1!' });
  assert.equal(wrong.status, 401, 'the wrong password makes no code');
  assert.ok(!wrong.data.code);
  expect(await call('POST', '/api/local/recovery', {}), 400, 'no password, no code');
  const made = expect(await call('POST', '/api/local/recovery', { password: PW }), 200, 'make the code');
  assert.match(made.code, CODE_SHAPE, 'seven groups of four Crockford base32 symbols (140 bits)');
  assert.equal(made.replaced, false);
  code1 = made.code; codes.push(code1);
  const after1 = expect(await call('GET', '/api/local/device'), 200, 'device');
  assert.equal(after1.recovery.exists, true); assert.equal(after1.recovery.saved, false, 'not yet confirmed as saved');
  assert.ok(Date.parse(after1.recovery.created_at) > Date.now() - 60000, 'the date it was made is kept (not the code)');
  expect(await call('POST', '/api/local/recovery/saved', {}), 200, '"I have saved my recovery code"');
  assert.equal(expect(await call('GET', '/api/local/device'), 200, 'device').recovery.saved, true);
  const c = expect(await call('POST', '/api/clients', { first_name: 'Recoverable', last_name: 'Record', status: 'active' }), 201, 'a client');
  clientId = c.id;
});

test('only the device administrator may make or confirm a recovery code', async () => {
  expect(await call('POST', '/api/local/signup', { display_name: 'Second Navigator', username: 'nav', password: NAV_PW }), 200, 'a second account');
  await signOut();
  await signIn('nav', NAV_PW);
  assert.equal(expect(await call('GET', '/api/local/device'), 200, 'device').device_admin, false);
  const r = await call('POST', '/api/local/recovery', { password: NAV_PW });
  assert.equal(r.status, 403, 'a navigator cannot make one'); assert.ok(!r.data.code);
  assert.equal((await call('POST', '/api/local/recovery/saved', {})).status, 403, 'nor mark one saved');
  await signOut();
  assert.equal((await call('POST', '/api/local/recovery', { password: PW })).status, 401, 'nor can anyone signed out');
});

test('locked: the sign-in page learns a code exists; wrong codes are refused, slowed, and capped per page', async () => {
  const st = expect(await call('GET', '/api/local/status'), 200, 'status');
  assert.equal(st.locked, true); assert.equal(st.recovery, true);
  const weak = await recover({ code: code1, password: 'short' });
  assert.equal(weak.status, 400, 'a password the policy refuses is refused before any code is tried');
  assert.equal(L.phase(), 'locked');
  const malformed = await recover({ code: 'ABCD-1234', password: PW2 });
  assert.equal(malformed.status, 400); assert.ok(malformed.data.fields && malformed.data.fields.code, 'a code of the wrong shape is said so');
  assert.ok(!malformed.data.wrongRecoveryCode, 'and does not count as a wrong code');
  // The waits the kernel schedules, not wall time: a busy machine stretches the PBKDF2 derivation each guess
  // costs by more than the backoff's steps, so timing the whole call measured the machine, not the backoff.
  // Only the backoff's own timers count (local/kernel.js missed(): 250 ms times the misses so far, at most 5 s),
  // not any other timer the kernel sets meanwhile.
  const waits = []; const realSetTimeout = global.setTimeout;
  const backoff = (ms) => ms >= 250 && ms <= 5000 && ms % 250 === 0 && /\bat missed \(/.test(new Error().stack);
  global.setTimeout = (fn, ms, ...a) => { if (backoff(ms)) waits.push(ms); return realSetTimeout(fn, ms, ...a); };
  try { for (let i = 1; i <= 3; i++) {
    const r = await recover({ code: otherCode(), password: PW2 });
    assert.equal(r.status, 400); assert.equal(r.data.wrongRecoveryCode, true); assert.equal(r.data.attempts, i);
    if (i < 3) assert.match(r.data.error, /not right\. Check it and try again/);
    else assert.match(r.data.error, /file you downloaded or the page you printed/, 'after several, the message says to check the saved file');
    assert.equal(L.phase(), 'locked', 'the device stays locked');
  } } finally { global.setTimeout = realSetTimeout; }
  assert.equal(waits.length, 3, `one wait per wrong code (${waits.join(', ')} ms)`);
  for (let i = 1; i < 3; i++) assert.equal(waits[i], Math.min(5000, waits[i - 1] + 250), `each wrong code waits 250 ms longer, up to 5 s (${waits.join(', ')} ms)`);
});

test('the recovery code opens the device: new password, records there, used code replaced, old password gone', async () => {
  // Typed in lower case without dashes, with an O for a zero and an l for a one where they occur.
  const typed = norm(code1).toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l');
  const mismatch = await recover({ code: typed, username: 'someone-else', password: PW2 });
  assert.equal(mismatch.status, 400, 'a username that is not the device administrator\'s is refused');
  assert.equal(mismatch.data.adminUsername, 'owner', 'and the code holder is told whose it is');
  assert.equal(L.phase(), 'locked', 'the device is locked again after the refusal');
  const r = expect(await recover({ code: typed, username: 'OWNER', password: PW2 }), 200, 'recover');
  assert.equal(r.user.id, ownerId); assert.equal(r.account, 'reset'); assert.equal(r.username, 'owner');
  assert.match(r.recovery_code, CODE_SHAPE, 'a new code at once');
  assert.notEqual(r.recovery_code, code1);
  code2 = r.recovery_code; codes.push(code2);
  assert.equal(L.phase(), 'open');
  const c = expect(await call('GET', `/api/clients/${clientId}`), 200, 'signed in, the records open');
  assert.equal((c.client || c).last_name, 'Record');
  const dev = expect(await call('GET', '/api/local/device'), 200, 'device');
  assert.equal(dev.device_admin, true); assert.equal(dev.recovery.exists, true); assert.equal(dev.recovery.saved, false, 'the new code is still to be confirmed as saved');
  await signOut();
  assert.equal((await call('POST', '/api/auth/login', { username: 'owner', password: PW })).status, 401, 'the forgotten password no longer opens the device');
  const used = await recover({ code: code1, password: PW2 });
  assert.equal(used.status, 400, 'the code that was used no longer works'); assert.equal(used.data.wrongRecoveryCode, true);
  await signIn('owner', PW2);
  const other = await signOut().then(() => signIn('nav', NAV_PW));
  assert.ok(other.user, 'the other account still opens the device with its own password');
  await signOut();
});

test('a new code replaces the old one; recovery clears a lockout and two-step verification', async () => {
  await signIn('owner', PW2);
  const made = expect(await call('POST', '/api/local/recovery', { password: PW2 }), 200, 'a new code');
  assert.equal(made.replaced, true);
  const code3 = made.code; codes.push(code3);
  // Then the owner turns on two-step verification and loses the authenticator, and the account is locked out
  // on the device after too many wrong passwords.
  const setup = expect(await call('POST', '/api/auth/mfa/setup', {}), 200, 'two-step set-up');
  expect(await call('POST', '/api/auth/mfa/enable', { code: require('../server/crypto').totp(setup.secret) }), 200, 'two-step on');
  let last;
  for (let i = 0; i < 5; i++) last = await call('POST', '/api/auth/password', { current_password: 'Wrong-Password-99!', new_password: 'Whatever-Else-2026!' });
  assert.equal(last.status, 423, 'the account is now locked out');
  await signOut();
  assert.equal((await call('POST', '/api/auth/login', { username: 'owner', password: PW2 })).status, 423, 'even the right password is refused while it is locked out');
  assert.equal(L.phase(), 'locked');
  const stale = await recover({ code: code2, password: PW });
  assert.equal(stale.status, 400, 'the previous code stopped working when the new one was made');
  const r = expect(await recover({ code: code3, password: PW }), 200, 'the newest code works');
  codes.push(r.recovery_code);
  assert.equal(r.user.mfa_enabled, false, 'two-step verification is off on this device (set it up again with a new authenticator)');
  assert.ok(!r.mfaPending, 'and the sign-in is complete');
  expect(await call('GET', `/api/clients/${clientId}`), 200, 'the lockout is cleared: the records open');
  await signOut();
});

test('the device administrator deactivated: their code stops working, and the administrator who did it is asked for a new one (1.15.4, L1)', async () => {
  // The owner makes the navigator an administrator, who then deactivates the owner's account: someone who has
  // just lost their access must not keep a key to every record here (security review of 1.15.3, L1).
  await signIn('owner', PW);
  const navRow = expect(await call('GET', '/api/local/accounts'), 200, 'accounts').rows.find(u => u.username === 'nav');
  expect(await call('PUT', `/api/local/accounts/${navRow.id}`, { role: 'admin' }), 200, 'promote');
  await signOut();
  await signIn('nav', NAV_PW);
  assert.equal(expect(await call('GET', '/api/local/device'), 200, 'device').device_admin, false, 'not yet the device administrator');
  expect(await call('PUT', `/api/users/${ownerId}`, { is_active: false }), 200, 'deactivate the owner');
  const dev = expect(await call('GET', '/api/local/device'), 200, 'device');
  assert.equal(dev.device_admin, true, 'the administrator who deactivated them now manages the device');
  assert.equal(dev.recovery.exists, false, 'the old code is gone');
  assert.equal(dev.recovery.dropped.reason, 'device_admin_changed', 'and the device says why');
  expect(await call('GET', '/api/local/status'), 200, 'status');
  await signOut();
  assert.equal(expect(await call('GET', '/api/local/status'), 200, 'status').recovery, false, 'the sign-in page offers no recovery code');
  const old = await recover({ code: codes[codes.length - 1], username: 'takeover', password: PW2, display_name: 'Former owner' });
  assert.equal(old.status, 404, `the deactivated owner's code opens nothing (${JSON.stringify(old.data)})`);
  assert.equal(old.data.noRecoveryCode, true);
  assert.equal(L.phase(), 'locked');
  // The new administrator makes a new code (Home prompts them), which works for them.
  await signIn('nav', NAV_PW);
  const made = expect(await call('POST', '/api/local/recovery', { password: NAV_PW }), 200, 'a new code');
  assert.equal(made.replaced, false, 'there was none left to replace');
  codes.push(made.code);
  assert.equal(expect(await call('GET', '/api/local/device'), 200, 'device').recovery.dropped, undefined, 'the reason goes once a new code is made');
  await signOut();
  const r = expect(await recover({ code: made.code, username: 'nav', password: PW2 }), 200, 'the new administrator recovers with it');
  assert.equal(r.account, 'reset'); assert.equal(r.user.username, 'nav');
  codes.push(r.recovery_code);
  expect(await call('GET', `/api/clients/${clientId}`), 200, 'and the records are there');
});

test('the audit log records who recovered and how, and no code appears in it or in anything stored', async () => {
  const log = expect(await call('GET', '/api/admin/audit?limit=1000'), 200, 'audit').rows;
  const recovered = log.filter(x => x.action === 'device.recovered');
  assert.equal(recovered.length, 3, 'each recovery is audited');
  assert.ok(recovered.every(x => x.details.method === 'recovery_code'));
  assert.deepStrictEqual(recovered.map(x => x.details.account).sort(), ['reset', 'reset', 'reset']);
  const dropped = log.filter(x => x.action === 'device.recovery_code.dropped');
  assert.equal(dropped.length, 1, 'the code dropped when the device administrator was deactivated is audited');
  assert.equal(dropped[0].details.reason, 'device_admin_deactivated'); assert.equal(dropped[0].username, 'nav');
  assert.ok(recovered.some(x => x.details.mfa_cleared === true && x.details.lockout_cleared === true), 'clearing two-step verification and a lockout is recorded');
  assert.ok(log.some(x => x.action === 'device.recovery_code.created' && x.details.replaced === false && x.username === 'owner'), 'making a code is audited, with who');
  assert.ok(log.some(x => x.action === 'device.recovery_code.failed' && x.success === 0), 'a wrong password when making one is audited');
  const text = JSON.stringify(log).toUpperCase();
  for (const c of codes) { assert.ok(!text.includes(c), 'no code in the audit log'); assert.ok(!text.includes(norm(c)), 'not even without its dashes'); }
  await L.flush({ force: true });
  const all = await stored();
  const hay = Buffer.concat(all.flatMap(([k, v]) => [Buffer.from(String(k)), ...bytesOf(v)]));
  for (const c of codes) for (const form of [c, norm(c), c.toLowerCase(), norm(c).toLowerCase()]) assert.ok(!hay.includes(Buffer.from(form)), 'no code anywhere in IndexedDB');
  const vaultRec = all.find(([k]) => k === 'vault')[1];
  assert.equal(vaultRec.wraps.filter(w => w.recovery).length, 1, 'one recovery wrap, however many codes were made');
  assert.ok(vaultRec.wraps.filter(w => w.recovery).every(w => w.user_id === undefined), 'belonging to no account');
  const ls = JSON.stringify(Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))])));
  for (const c of codes) assert.ok(!ls.includes(c) && !ls.includes(norm(c)), 'nor in localStorage');
});

test('ten wrong codes in one page load and the page must be reloaded', async () => {
  await signOut();
  for (let i = 0; i < 10; i++) await recover({ code: otherCode(), password: PW2 });
  const r = await recover({ code: codes[codes.length - 1], password: PW2 });
  assert.equal(r.status, 429, 'even the right code is not tried after that');
  assert.equal(r.data.tooManyRecoveryCodes, true);
  assert.equal(L.phase(), 'locked');
});

test('an office server has none of the device recovery routes', async () => {
  await H.start();
  try {
    const c = H.client(); await c.login('admin', 'AdminPassw0rd!x');
    for (const p of ['/api/local/recovery', '/api/local/recovery/saved', '/api/local/recover']) {
      const r = await c.post(p, { password: 'AdminPassw0rd!x', code: codes[0] || otherCode() });
      assert.equal(r.status, 404, `${p} on the office server`);
    }
  } finally { await H.stop(); }
});
