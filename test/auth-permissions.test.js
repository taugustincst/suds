'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const auth = require('../server/auth');

before(async () => { await H.start(); });
after(() => H.stop());

function userWith(role, id) { return { id, role }; }

test('effectivePerms: role defaults with no overrides', async () => {
  const e = auth.effectivePerms(userWith('navigator', 'no-such-user'));
  assert.ok(e.allow.includes('clients:read'), 'role default present');
  assert.ok(!e.allow.includes('audit:read'), 'absent permission not present');
  assert.deepEqual(e.deny, []);
});

test('effectivePerms: grant adds, deny removes, deny beats wildcard', async () => {
  const u = H.makeUser('pw', 'navigator');
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'audit:read', 'grant', 'reviews break-glass queue')`, u.id);
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'calls:*', 'deny', 'front-desk only by phone')`, u.id);
  const e = auth.effectivePerms(userWith('navigator', u.id));
  assert.ok(e.allow.includes('audit:read'), 'grant added');
  assert.ok(!e.allow.includes('calls:*'), 'exact deny removed the wildcard entry');
  assert.deepEqual(e.deny, ['calls:*']);
  assert.ok(auth.hasPerm(userWith('navigator', u.id), 'audit:read'), 'hasPerm sees the grant');
  assert.ok(!auth.hasPerm(userWith('navigator', u.id), 'calls:write'), 'deny of calls:* blocks calls:write through the wildcard');
});

test('effectivePerms: deny of x:write also denies x:read (write implies read)', async () => {
  const u = H.makeUser('pw2', 'navigator');
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'clients:write', 'deny', 'read-only for this user')`, u.id);
  const w = userWith('navigator', u.id);
  assert.ok(!auth.hasPerm(w, 'clients:write'), 'write denied');
  assert.ok(!auth.hasPerm(w, 'clients:read'), 'read denied too, because write implies read');
});

test('effectivePerms: unknown permission rows are ignored', async () => {
  const u = H.makeUser('pw3', 'navigator');
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'clients:reed', 'grant', 'typo row')`, u.id);
  const w = userWith('navigator', u.id);
  assert.ok(!auth.hasPerm(w, 'clients:reed'));
  assert.ok(auth.hasPerm(w, 'clients:read'), 'real permissions unaffected');
});

test('effectivePerms: computed per request, not cached across requests', async () => {
  const u = H.makeUser('pw4', 'navigator');
  const w = userWith('navigator', u.id);
  assert.ok(!auth.hasPerm(w, 'audit:read'));
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'audit:read', 'grant', 'mid-session grant')`, u.id);
  // a fresh user object (what resolveSession builds on the next request) sees the grant
  assert.ok(auth.hasPerm(userWith('navigator', u.id), 'audit:read'), 'next request enforces the change');
});

test('publicUser sends effective permissions and denies', async () => {
  const u = H.makeUser('pw5', 'readonly');
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'reports:funder', 'grant', 'files the submission')`, u.id);
  const p = auth.publicUser({ ...u, role: 'readonly', caseload_restricted: 1 });
  assert.ok(p.permissions.includes('reports:funder'), 'grant in permissions');
  assert.ok(Array.isArray(p.denied_permissions), 'denied_permissions present');
});

test('GET /api/me returns effective permissions including denies', async () => {
  const nav = H.makeUser('menav', 'navigator');
  const n = H.client(); await n.login(nav.username, nav.password);
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'audit:read', 'grant', 'me check grant')`, nav.id);
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'clients:read', 'deny', 'me check deny')`, nav.id);
  const r = await n.get('/api/me');
  assert.equal(r.status, 200);
  assert.ok(r.data.permissions.includes('audit:read'), 'grant visible in own snapshot');
  assert.ok(r.data.permissions.includes('time:read'), 'role defaults present');
  assert.ok(!r.data.permissions.includes('clients:read'), 'deny removed from the effective list');
  assert.ok((r.data.denied_permissions || []).includes('clients:read'), 'deny visible in denied_permissions');
  assert.ok('caseload_restricted' in r.data, 'snapshot carries caseload_restricted');
});
