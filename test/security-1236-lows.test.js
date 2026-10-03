'use strict';
// The Low findings of the white-box pen test of 1.23.6, fixed in 1.24: L1 (passwords that pass the character
// classes but are the username, the person's name or a very common password), L4 (a non-numeric ?limit= or
// ?offset= answered 500), L6 (a whole device's sync session reached account management under /api/auth/) and
// L7 (/api/notes/handoffs and /api/episodes accepted ?client_id= and ignored it). L2 is in test/api.test.js
// (sign-in limits) and L5 in test/audit-head-at-start.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const auth = require('../server/auth');

const PW = 'StaffPassw0rd!x';
let admin;
before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
});
after(async () => { await H.stop(); });

const is400 = (r, re, what) => { assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.data)}`); if (re) assert.match(r.data.error, re, what); };

// ---- L1 ----
test('L1: the password policy refuses the username, the person\'s name and very common passwords', () => {
  const who = { username: 'mrivera', display_name: 'Maria Rivera' };
  assert.equal(auth.passwordProblem('Navigator2026!!', who), null, 'the seed staff password still passes');
  assert.equal(auth.passwordProblem('correct-Horse-battery-9', who), null);
  assert.match(auth.passwordProblem('short', who), /^Password must contain at least 12 characters/);
  for (const pw of ['Mrivera2026!!', 'xx-MRIVERA-99!', 'MR1vera-2026!!']) assert.match(auth.passwordProblem(pw, who), /username/, pw);
  for (const pw of ['Rivera-Family-1!', 'M@ria-Spring-1984', 'River-Maria-2026!']) assert.match(auth.passwordProblem(pw, who), /name/, pw);
  for (const pw of ['Password2026!', 'P@ssw0rd2026!', 'Summer2026!!', 'Qwerty123456!', 'Welcome2026!!', '!Letmein12345', 'PasswordPassword1!', 'Admin1234567!'])
    assert.match(auth.passwordProblem(pw, {}) || '', /too common/, pw);
  // One or two extra letters do not make a common word uncommon (eval of 1.24.0, D3); a real word that only
  // starts with a listed one still passes.
  for (const pw of ['Summer2026!!x', 'Welcome2026!x', 'Password2026!x', 'P@ssw0rd2026!a', 'Qwerty123456!x', 'xSummer2026!!', 'aWelcome2026!b'])
    assert.match(auth.passwordProblem(pw, {}) || '', /too common/, pw);
  for (const pw of ['Navigator2026!!', 'Summertime-Lamp-4!', 'xxSummer2026!!x', 'Passwordless-9!x']) assert.equal(auth.passwordProblem(pw, {}), null, pw);
  assert.match(auth.passwordProblem('Aa1!Aa1!Aa1!', {}), /too few different characters/);
  // A name part shorter than 3 characters is not looked for (it would refuse half of every dictionary).
  assert.equal(auth.passwordProblem('Rotating-Lamp-77!', { username: 'jo', display_name: 'Jo Li' }), null);
});

test('L1: office sign-up, an administrator creating or resetting an account, and a password change apply it', async () => {
  is400(await H.client().post('/api/auth/signup', { display_name: 'Pat Example', username: 'pexample', password: 'Pexample-2026!' }), /username/, 'sign-up with the username');
  is400(await H.client().post('/api/auth/signup', { display_name: 'Pat Example', username: 'pexample', password: 'Summer2026!!' }), /too common/, 'sign-up with a common one');
  assert.equal((await H.client().post('/api/auth/signup', { display_name: 'Pat Example', username: 'pexample', password: 'Lantern-Orbit-73!' })).status, 202);

  is400(await admin.post('/api/users', { username: 'l1new', display_name: 'Quinn Lowell', role: 'navigator', password: 'Password2026!' }), /too common/, 'create, common');
  const named = await admin.post('/api/users', { username: 'l1new', display_name: 'Quinn Lowell', role: 'navigator', password: 'Lowell-Harbor-9!' });
  is400(named, /name/, 'create, the person\'s name');
  assert.equal(named.data.fields.password, named.data.error, 'said under the field too');
  const made = await admin.post('/api/users', { username: 'l1new', display_name: 'Quinn Lowell', role: 'navigator' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(auth.passwordProblem(made.data.temporary_password, { username: 'l1new', display_name: 'Quinn Lowell' }), null, 'the generated one passes');
  is400(await admin.put(`/api/users/${made.data.id}`, { password: 'L1new-Harbor-9!' }), /username/, 'reset, the username');
  is400(await admin.put(`/api/users/${made.data.id}`, { username: 'qlowell2', password: 'Qlowell2-Harbor!' }), /username/, 'reset, the new username');
  assert.equal((await admin.put(`/api/users/${made.data.id}`, { password: 'Harbor-Lantern-9!' })).status, 200);

  const u = H.makeUser('l1self', 'navigator', PW);
  const c = H.client(); await c.login(u.username, PW);
  is400(await c.post('/api/auth/password', { current_password: PW, new_password: 'Qwerty123456!' }), /too common/, 'change, common');
  is400(await c.post('/api/auth/password', { current_password: PW, new_password: 'My-l1self-pass9!' }), /username/, 'change, the username');
  assert.equal((await c.post('/api/auth/password', { current_password: PW, new_password: 'Harbor-Lantern-9!' })).status, 200);
});

// ---- L4 ----
test('L4: a ?limit= or ?offset= that is not a number is a 400 that says so, not a 500', async () => {
  for (const path of ['/api/clients?limit=abc', '/api/clients?offset=abc', '/api/episodes?limit=abc', '/api/notes?limit=NaN', '/api/tasks?limit=Infinity', '/api/waitlist?offset=x', '/api/admin/audit?limit=abc', '/api/supplies/ledger?limit=abc']) {
    const r = await admin.get(path);
    assert.equal(r.status, 400, `${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    assert.match(r.data.error, /(limit|offset) must be a whole number/, path);
  }
  for (const path of ['/api/clients?limit=', '/api/clients?limit=2.7&offset=0', '/api/clients?limit=-5', '/api/clients']) assert.equal((await admin.get(path)).status, 200, path);
  assert.equal((await admin.get('/api/clients?limit=2.7')).data.limit, 2, 'a fraction is rounded down');
  assert.equal((await admin.get('/api/notes/handoffs?hours=abc')).status, 200, 'a non-numeric hours is the default, not a 500');
});

// ---- L6 ----
test('L6: a whole device\'s sync session reaches signing in and out under /api/auth/, not account management', async () => {
  const u = H.makeUser('l6dev', 'supervisor', PW);
  const c = H.client(); c.setHeader('X-Sync-Client', '1'); c.setHeader('X-Device-Id', require('../server/crypto').uuid());
  const login = await c.post('/api/auth/login', { username: u.username, password: PW });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.notEqual(login.data.device && login.data.device.scope, 'field', 'a whole device, not a field one');
  c.setHeader('Authorization', 'Bearer ' + login.data.token);
  for (const [m, path, body] of [['get', '/api/auth/sessions'], ['post', '/api/auth/sessions/revoke-others', {}],
    ['post', '/api/auth/password', { current_password: PW, new_password: 'Harbor-Lantern-9!' }], ['post', '/api/auth/mfa/setup', {}], ['post', '/api/auth/mfa/enable', { code: '000000' }],
    ['post', '/api/auth/mfa/disable', { password: PW, code: '000000' }], ['get', '/api/auth/passkeys'], ['post', '/api/auth/passkeys/register/options', {}], ['get', '/api/auth/reauth'], ['get', '/api/auth/me']]) {
    const r = await c[m](path, body);
    assert.equal(r.status, 403, `${m} ${path}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.syncSession, true, path); assert.equal(r.data.useBrowser, true, path);
    assert.ok(!('secret' in (r.data || {})) && !('otpauth' in (r.data || {})), 'no new authenticator secret');
  }
  assert.ok(!H.db.one(`SELECT mfa_secret_enc FROM users WHERE id=?`, u.id).mfa_secret_enc, 'enrolment did not start');
  // What a device's sync uses still works, and so does the rest of the API for a whole device.
  assert.equal((await c.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).status, 200);
  assert.equal((await c.get('/api/clients')).status, 200);
  assert.equal((await c.post('/api/auth/logout', {})).status, 200);
  // The same account in a browser manages itself as before.
  const b = H.client(); await b.login(u.username, PW);
  assert.equal((await b.get('/api/auth/sessions')).status, 200);
  assert.equal((await b.post('/api/auth/mfa/setup', {})).status, 200);
});

// ---- L7 ----
test('L7: /api/episodes and /api/notes/handoffs filter by ?client_id=, within the caseload', async () => {
  const mk = async (c, last) => { const r = await c.post('/api/clients', { first_name: 'Lseven', last_name: last, status: 'active' }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  const nav = H.makeCaseloadUser('l7nav', 'navigator', PW);
  const n = H.client(); await n.login(nav.username, PW);
  const mine = await mk(n, 'Mine');
  const other = await mk(admin, 'Other');
  for (const [c, id] of [[n, mine], [admin, other]]) {
    const r = await c.post('/api/notes', { client_id: id, kind: 'admin', format: 'handoff', title: 'Hand-off', content: 'For the next shift.', occurred_at: new Date().toISOString() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const ep = await admin.get(`/api/episodes?client_id=${other}&status=all`);
  assert.equal(ep.status, 200);
  assert.ok(ep.data.rows.length >= 1 && ep.data.rows.every(x => x.client_id === other), JSON.stringify(ep.data.rows.map(x => x.client_id)));
  assert.equal(ep.data.total, ep.data.rows.length, 'the counts are the client\'s too');
  const ho = await admin.get(`/api/notes/handoffs?client_id=${other}`);
  assert.equal(ho.status, 200);
  assert.ok(ho.data.rows.length >= 1 && ho.data.rows.every(x => x.client_id === other), JSON.stringify(ho.data.rows.map(x => x.client_id)));
  assert.ok((await admin.get('/api/notes/handoffs')).data.rows.some(x => x.client_id === mine), 'without the filter, everyone\'s');
  // A caseload-held worker asking for a client not theirs gets nothing, as the caseload filter always gave.
  assert.deepEqual((await n.get(`/api/episodes?client_id=${other}&status=all`)).data.rows, []);
  assert.deepEqual((await n.get(`/api/notes/handoffs?client_id=${other}`)).data.rows, []);
  assert.ok((await n.get(`/api/episodes?client_id=${mine}&status=all`)).data.rows.every(x => x.client_id === mine));
  assert.equal((await n.get(`/api/notes/handoffs?client_id=${mine}`)).data.rows.length, 1);
});
