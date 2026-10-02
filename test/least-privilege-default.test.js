'use strict';
// 1.17.0: the programme-wide least-privilege default (server/caseload-default.js). With "New navigators and
// clinicians start held to their caseload" on (a new install's default), every path that makes an account a
// navigator or a clinician on the office server gives it a per-user deny of clients:all with the reason
// "programme default: held to caseload", audited: an administrator creating it, an approved access request,
// and a role change into those roles. (SCIM and single sign-on: test/least-privilege-sso.test.js; SUDS on this
// device: test/least-privilege-device.test.js; an upgraded office starts with it off: test/migrations.test.js.)
// Nothing else changes: a navigator keeps reading clinical notes. Existing accounts change only through the
// one-off "Apply to existing navigators and clinicians", which changes exactly the people it was given.
// And the deny does what a hand-made one does: the REST list, search and sync pull keep to the caseload.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const CD = require('../server/caseload-default');

const PW = 'StaffPassw0rd!x';
let admin, supU, sup, navOld, clinOld;
const ids = {};
const expect = (r, status, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`); return r.data; };
const override = (userId) => H.db.one(`SELECT mode, reason FROM user_permission_overrides WHERE user_id=? AND permission='clients:all'`, userId);
const audits = (action, userId) => H.db.all(`SELECT details FROM audit_log WHERE action=? AND entity_id=? ORDER BY id`, action, userId).map(r => JSON.parse(r.details));
const signIn = async (username, password = PW) => { const c = H.client(); await c.login(username, password); return c; };
async function createUser(username, role, extra = {}) {
  const d = expect(await admin.post('/api/users', { username, display_name: username, role, password: PW, ...extra }), 201, `create ${username}`);
  H.db.run(`UPDATE users SET must_change_password=0 WHERE id=?`, d.id);
  return d;
}

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  // Accounts from before the setting existed (made directly, as an upgraded office's are): never changed by it.
  supU = H.makeUser('lp_sup', 'supervisor'); navOld = H.makeUser('lp_navold', 'navigator'); clinOld = H.makeUser('lp_clinold', 'clinician');
  sup = await signIn('lp_sup');
  ids.a = expect(await admin.post('/api/clients', { first_name: 'Lena', last_name: 'Lpassigned', dob: '1981-01-01' }), 201, 'client a').id;
  ids.b = expect(await admin.post('/api/clients', { first_name: 'Otto', last_name: 'Lpother', dob: '1982-02-02' }), 201, 'client b').id;
});
after(() => H.stop());

test('a new install starts with the default on; only an administrator (users:manage) reads or changes it', async () => {
  assert.equal(H.db.getSetting(CD.SETTING), '1', 'fresh database: on');
  const d = expect(await admin.get('/api/users/caseload-default'), 200, 'read');
  assert.equal(d.enabled, true); assert.equal(d.reason, 'programme default: held to caseload'); assert.deepEqual(d.roles, ['navigator', 'clinician']);
  assert.equal(d.caseload_restriction, true);
  const nav = await signIn('lp_navold');
  for (const c of [sup, nav]) {
    assert.equal((await c.get('/api/users/caseload-default')).status, 403);
    assert.equal((await c.put('/api/users/caseload-default', { enabled: false })).status, 403);
    assert.equal((await c.post('/api/users/caseload-default/apply', { user_ids: [navOld.id] })).status, 403);
  }
  assert.equal(H.db.getSetting(CD.SETTING), '1', 'unchanged by the refused requests');
  assert.equal(override(navOld.id), undefined, 'nobody was held by a refused request');
  assert.equal((await admin.put('/api/users/caseload-default', {})).status, 400, 'enabled is required');
});

test('an administrator creates a navigator: held to their caseload (clients:all denied, reason and audit), clinical notes kept', async () => {
  const d = await createUser('lp_newnav', 'navigator');
  ids.newNav = d.id;
  assert.equal(d.held_to_caseload, true);
  assert.deepEqual(override(d.id), { mode: 'deny', reason: 'programme default: held to caseload' });
  const a = audits('user.permission.deny', d.id);
  assert.equal(a.length, 1); assert.equal(a[0].permission, 'clients:all'); assert.equal(a[0].cause, 'created'); assert.equal(a[0].reason, 'programme default: held to caseload');
  const p = expect(await admin.get(`/api/users/${d.id}/permissions`), 200, 'permissions');
  assert.ok(p.denied.includes('clients:all')); assert.ok(p.effective.includes('notes:clinical:read'), 'a navigator keeps reading clinical notes (1.16.0)');
  assert.equal(p.overrides.length, 1, 'only the one deny: the role\'s other grants are untouched');
  const nav = await signIn('lp_newnav');
  const me = expect(await nav.get('/api/auth/me'), 200, 'me').user;
  assert.equal(me.caseload_restricted, true);
  assert.deepEqual(me.denied_permissions, ['clients:all']);
});

test('a clinician is held too; a supervisor, finance or read-only account is not', async () => {
  const c = await createUser('lp_newclin', 'clinician'); ids.newClin = c.id;
  assert.equal(c.held_to_caseload, true); assert.equal(override(c.id).reason, CD.REASON);
  for (const role of ['supervisor', 'finance', 'readonly', 'admin']) {
    const u = await createUser(`lp_new_${role}`, role);
    assert.equal(u.held_to_caseload, false, role); assert.equal(override(u.id), undefined, role);
  }
});

test('held by the default, the caseload scoping holds: the client list, search, a record and sync pull', async () => {
  expect(await sup.post(`/api/clients/${ids.a}/assignments`, { user_id: ids.newNav, role_on_case: 'primary' }), 201, 'assign');
  const nav = await signIn('lp_newnav');
  const list = expect(await nav.get('/api/clients?status=all&limit=100'), 200, 'list').clients.map(c => c.id);
  assert.deepEqual(list, [ids.a], 'the list is their caseload');
  assert.equal(expect(await nav.get('/api/clients?q=Lpother'), 200, 'search').clients.length, 0, 'search does not find another client');
  assert.equal(expect(await nav.get('/api/clients?q=Lpassigned'), 200, 'search own').clients.length, 1);
  assert.equal((await nav.get(`/api/clients/${ids.b}`)).status, 403, 'another client\'s record is refused');
  const pulled = []; let cursor = '';
  for (let i = 0; i < 50; i++) {
    const r = expect(await nav.get('/api/sync/pull' + (cursor ? '?since=' + encodeURIComponent(cursor) : '')), 200, 'pull');
    pulled.push(...(r.tables.clients || []).map(c => c.id)); cursor = r.cursor; if (r.complete) break;
  }
  assert.deepEqual([...new Set(pulled)], [ids.a], 'a device carries only the caseload');
  // An account from before the setting (a navigator made directly) still sees every client.
  const old = await signIn('lp_navold');
  assert.ok(expect(await old.get('/api/clients?status=all&limit=100'), 200, 'old list').clients.length >= 2);
});

test('the user list says who is held to their caseload, and whether by the programme default', async () => {
  const { users } = expect(await admin.get('/api/users'), 200, 'users');
  const by = Object.fromEntries(users.map(u => [u.username, u.client_scope]));
  assert.deepEqual(by.lp_newnav, { scope: 'caseload', held_by_default: true });
  assert.deepEqual(by.lp_navold, { scope: 'all' });
  assert.deepEqual(by.lp_sup, { scope: 'all' });
  assert.deepEqual(by.lp_new_finance, { scope: 'codes' });
  // A hand-made deny is shown as held, but not as the default's.
  const held = H.deny(H.makeUser('lp_handheld', 'navigator'), 'clients:all');
  const again = expect(await admin.get('/api/users'), 200, 'users').users.find(u => u.id === held.id);
  assert.deepEqual(again.client_scope, { scope: 'caseload', held_by_default: false });
  // The staff directory (users:read) is not given it.
  assert.ok(!('client_scope' in expect(await sup.get('/api/users'), 200, 'directory').users[0]));
});

test('an approved access request as a navigator or clinician is held; approved as a supervisor it is not', async () => {
  const anon = H.client();
  for (const [username, role] of [['lp_req_nav', 'navigator'], ['lp_req_clin', 'clinician'], ['lp_req_sup', 'supervisor']]) {
    expect(await anon.post('/api/auth/signup', { display_name: username, username, password: 'Request-Passw0rd!', reason: 'new outreach staff' }), 202, `request ${username}`);
    const id = H.db.one(`SELECT id FROM users WHERE username=?`, username).id;
    assert.equal(override(id), undefined, 'a waiting request holds nothing');
    const r = expect(await admin.post(`/api/users/${id}/approve`, { role }), 200, `approve ${username}`);
    assert.equal(r.held_to_caseload, role !== 'supervisor', username);
    if (role === 'supervisor') { assert.equal(override(id), undefined); continue; }
    assert.equal(override(id).reason, CD.REASON);
    assert.equal(audits('user.permission.deny', id)[0].cause, 'access_request_approved');
    const c = H.client(); await c.login(username, 'Request-Passw0rd!');
    assert.equal(expect(await c.get('/api/auth/me'), 200, 'me').user.caseload_restricted, true);
  }
});

test('a role change into navigator or clinician applies the default; out of them its own deny goes, an administrator\'s stays', async () => {
  const s = await createUser('lp_rolechg', 'supervisor');
  let r = expect(await admin.put(`/api/users/${s.id}`, { role: 'navigator' }), 200, 'to navigator');
  assert.equal(r.caseload_default, 'held'); assert.equal(override(s.id).reason, CD.REASON);
  assert.equal(audits('user.permission.deny', s.id).at(-1).cause, 'role_change');
  r = expect(await admin.put(`/api/users/${s.id}`, { role: 'clinician' }), 200, 'to clinician');
  assert.equal(r.caseload_default, undefined, 'already held: nothing changes'); assert.equal(override(s.id).reason, CD.REASON);
  r = expect(await admin.put(`/api/users/${s.id}`, { role: 'supervisor' }), 200, 'to supervisor');
  assert.equal(r.caseload_default, 'lifted'); assert.equal(override(s.id), undefined, 'a supervisor sees every client');
  const rev = audits('user.permission.revoke', s.id).at(-1);
  assert.equal(rev.permission, 'clients:all'); assert.equal(rev.cause, 'role_change'); assert.equal(rev.from, 'clinician'); assert.equal(rev.to, 'supervisor');
  // An administrator's own deny of clients:all (a decision about this person) is not the default's to lift.
  expect(await admin.post(`/api/users/${s.id}/permissions`, { permission: 'clients:all', mode: 'deny', reason: 'kept to own caseload by the director' }), 200, 'hand deny');
  expect(await admin.put(`/api/users/${s.id}`, { role: 'navigator' }), 200, 'to navigator');
  expect(await admin.put(`/api/users/${s.id}`, { role: 'supervisor' }), 200, 'back to supervisor');
  assert.deepEqual(override(s.id), { mode: 'deny', reason: 'kept to own caseload by the director' });
});

test('with the setting off, nobody new is held; turning it on or off is audited and changes no existing account', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM user_permission_overrides`).n;
  expect(await admin.put('/api/users/caseload-default', { enabled: false }), 200, 'off');
  assert.equal(H.db.getSetting(CD.SETTING), '0');
  const a = H.db.all(`SELECT details FROM audit_log WHERE action='settings.caseload_default' ORDER BY id`).map(x => JSON.parse(x.details)).at(-1);
  assert.deepEqual(a, { enabled: false, was: true });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM user_permission_overrides`).n, before, 'turning it off lifts nobody\'s deny');
  const n = await createUser('lp_off_nav', 'navigator'); ids.offNav = n.id;
  assert.equal(n.held_to_caseload, false); assert.equal(override(n.id), undefined);
  const s = await createUser('lp_off_sup', 'supervisor');
  assert.equal(expect(await admin.put(`/api/users/${s.id}`, { role: 'clinician' }), 200, 'role').caseload_default, undefined);
  assert.equal(override(s.id), undefined); ids.offClin = s.id;
  expect(await admin.put('/api/users/caseload-default', { enabled: true }), 200, 'on');
  assert.equal(override(n.id), undefined, 'turning it on changes no existing account');
  assert.equal(override(navOld.id), undefined);
});

test('"Apply to existing navigators and clinicians": lists who would change, changes exactly those confirmed, audited per person', async () => {
  // An administrator's grant of clients:all is a decision about the person: listed as kept, never changed.
  const granted = H.makeUser('lp_granted', 'navigator');
  expect(await admin.post(`/api/users/${granted.id}/permissions`, { permission: 'clients:all', mode: 'grant', reason: 'covers the whole county on weekends' }), 200, 'grant');
  const d = expect(await admin.get('/api/users/caseload-default'), 200, 'read');
  const would = d.would_change.map(u => u.username).sort();
  for (const u of ['lp_navold', 'lp_clinold', 'lp_off_nav', 'lp_off_sup']) assert.ok(would.includes(u), `${u} would change: ${would}`);
  for (const u of ['lp_newnav', 'lp_newclin', 'lp_handheld', 'lp_granted', 'lp_sup', 'lp_new_supervisor', 'admin']) assert.ok(!would.includes(u), `${u} would not change`);
  assert.deepEqual(d.kept.map(u => u.username), ['lp_granted']);
  assert.ok(d.already_held >= 4);
  // Bad requests change nothing.
  assert.equal((await admin.post('/api/users/caseload-default/apply', {})).status, 400);
  assert.equal((await admin.post('/api/users/caseload-default/apply', { user_ids: [] })).status, 400);
  assert.equal((await admin.post('/api/users/caseload-default/apply', { user_ids: [42] })).status, 400);
  const self = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  // The administrator's own account may be listed (the owner's decision after 1.23.5): not a navigator or clinician,
  // it is skipped like any other account that is not eligible.
  assert.deepEqual((await admin.post('/api/users/caseload-default/apply', { user_ids: [self] })).data, { ok: true, changed: 0, skipped: 1 });
  assert.equal(override(navOld.id), undefined);
  // The confirmation listed three people, plus ids that are not eligible (a supervisor, the granted navigator).
  const r = expect(await admin.post('/api/users/caseload-default/apply', { user_ids: [navOld.id, clinOld.id, ids.offNav, supU.id, granted.id] }), 200, 'apply');
  assert.deepEqual({ changed: r.changed, skipped: r.skipped }, { changed: 3, skipped: 2 });
  for (const u of [navOld.id, clinOld.id, ids.offNav]) {
    assert.deepEqual(override(u), { mode: 'deny', reason: CD.REASON });
    assert.equal(audits('user.permission.deny', u).at(-1).cause, 'applied_to_existing');
  }
  assert.equal(override(supU.id), undefined, 'a supervisor is not changed');
  assert.equal(override(granted.id).mode, 'grant', 'the individual grant stands');
  assert.equal(override(ids.offClin), undefined, 'someone not confirmed is not changed');
  const sum = H.db.all(`SELECT details FROM audit_log WHERE action='users.caseload_default.applied'`).map(x => JSON.parse(x.details)).at(-1);
  assert.deepEqual(sum, { changed: 3, requested: 5, skipped: 2 });
  const old = await signIn('lp_navold');
  assert.equal(expect(await old.get('/api/clients?status=all&limit=100'), 200, 'list').clients.length, 0, 'held now: no clients on their caseload');
  // Applying again changes nobody.
  assert.equal(expect(await admin.post('/api/users/caseload-default/apply', { user_ids: [navOld.id] }), 200, 'again').changed, 0);
});

test('with caseload restriction off (Settings -> Program) the list says so: a deny then limits nobody', async () => {
  H.db.setSetting('caseload_restriction', '0');
  try {
    assert.equal(expect(await admin.get('/api/users/caseload-default'), 200, 'read').caseload_restriction, false);
    const u = expect(await admin.get('/api/users'), 200, 'users').users.find(x => x.username === 'lp_newnav');
    assert.deepEqual(u.client_scope, { scope: 'all' });
  } finally { H.db.setSetting('caseload_restriction', '1'); }
});
