'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const auth = require('../server/auth');

before(async () => { await H.start(); });
after(() => H.stop());

test('migration 46 created user_permission_overrides', async () => {
  const t = H.db.one(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_permission_overrides'`);
  assert.ok(t, 'user_permission_overrides table exists');
  // The overrides table references users(id): use a real user so the foreign key holds.
  const u = H.makeUser('permtest', 'clinician');
  H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'reports:read', 'grant', 'schema test')`, u.id);
  assert.throws(() => H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'reports:read', 'grant', 'dup')`, u.id), 'PRIMARY KEY(user_id, permission) rejects duplicates');
  assert.throws(() => H.db.run(`INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'reports:read', 'maybe', 'bad mode')`, u.id), 'CHECK(mode) rejects anything but grant/deny');
  H.db.run(`DELETE FROM users WHERE id=?`, u.id);
  assert.strictEqual(H.db.one(`SELECT COUNT(*) AS c FROM user_permission_overrides WHERE user_id=?`, u.id).c, 0, 'ON DELETE CASCADE cleans up overrides');
});

test('permission catalog covers every string in PERMS exactly once', async () => {
  const { PERMISSION_CATALOG, isKnownPermission, PRIVILEGED_PERMISSIONS } = require('../server/permissions');
  const auth = require('../server/auth');
  const inPerms = new Set(Object.values(auth.PERMS).flat());
  const inCatalog = new Set(PERMISSION_CATALOG.map((p) => p.name));
  assert.deepEqual([...inCatalog].sort(), [...inPerms].sort(), 'catalog matches PERMS exactly (deduped)');
  assert.ok(isKnownPermission('reports:funder'));
  assert.ok(!isKnownPermission('clients:reed'), 'typos are not known');
  assert.ok(!isKnownPermission('reports:*'), 'bare wildcards are not grantable entries');
  assert.deepEqual(PRIVILEGED_PERMISSIONS.sort(), ['apikeys:manage', 'settings:manage', 'users:manage']);
  for (const p of PERMISSION_CATALOG) {
    assert.ok(p.label && p.description, `${p.name} has label and description`);
    assert.ok(['standard', 'sensitive', 'privileged'].includes(p.risk), `${p.name} has a valid risk`);
  }
});

test('permissions API: grant, deny, revoke round-trip', async () => {
  const admin = H.makeUser('permadmin', 'admin');
  const nav = H.makeUser('permnav', 'navigator');
  const a = H.client(); await a.login(admin.username, admin.password);
  const n = H.client(); await a.login(admin.username, admin.password); // admin client
  await n.login(nav.username, nav.password); // navigator client

  // grant audit:read → the break-glass queue (server/routes/supervision.js:87 requires audit:read) opens
  let r = await a.post(`/api/users/${nav.id}/permissions`, { permission: 'audit:read', mode: 'grant', reason: 'reviews the break-glass queue weekly' });
  assert.equal(r.status, 200);
  r = await n.get('/api/supervision/breakglass');
  assert.equal(r.status, 200, 'grant takes effect over HTTP: navigator can read the break-glass queue');

  // deny clients:read → client list is forbidden (fail-closed: 403, not an empty list)
  r = await a.post(`/api/users/${nav.id}/permissions`, { permission: 'clients:read', mode: 'deny', reason: 'read-only outreach worker' });
  assert.equal(r.status, 200);
  r = await n.get('/api/clients');
  assert.equal(r.status, 403, 'client list forbidden after deny');

  // revoke → exactly back to role defaults
  r = await a.del(`/api/users/${nav.id}/permissions/clients:read`);
  assert.equal(r.status, 200);
  r = await a.del(`/api/users/${nav.id}/permissions/audit:read`);
  assert.equal(r.status, 200);
  // the revoke audit row carries the permission, mode, and reason of the removed override
  const rev = H.db.one(`SELECT details FROM audit_log WHERE action='user.permission.revoke' AND entity_id=? ORDER BY at DESC LIMIT 1`, nav.id);
  assert.ok(rev, 'revoke is audited');
  const revDetails = JSON.parse(rev.details);
  assert.equal(revDetails.permission, 'audit:read');
  assert.equal(revDetails.mode, 'grant');
  assert.equal(revDetails.reason, 'reviews the break-glass queue weekly');
  r = await a.get(`/api/users/${nav.id}/permissions`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.overrides, [], 'no override rows remain');
  const fresh = H.makeUser('permnav2', 'navigator');
  assert.deepEqual(r.data.role_permissions.sort(), auth.rolePerms('navigator').sort(), 'effective matches untouched role defaults');
});

test('permissions API: guards', async () => {
  const admin = H.makeUser('permadmin2', 'admin');
  const nav = H.makeUser('permnav3', 'navigator');
  const a = H.client(); await a.login(admin.username, admin.password);
  const n = H.client(); await n.login(nav.username, nav.password);

  // unknown permission
  let r = await a.post(`/api/users/${nav.id}/permissions`, { permission: 'clients:reed', mode: 'grant', reason: 'a typo should never persist' });
  assert.equal(r.status, 400);

  // reason too short
  r = await a.post(`/api/users/${nav.id}/permissions`, { permission: 'audit:read', mode: 'grant', reason: 'x' });
  assert.equal(r.status, 400);

  // privileged permission to a non-admin role
  r = await a.post(`/api/users/${nav.id}/permissions`, { permission: 'users:manage', mode: 'grant', reason: 'wants to be a user manager' });
  assert.equal(r.status, 400);

  // self-edit blocked
  r = await a.post(`/api/users/${admin.id}/permissions`, { permission: 'reports:funder', mode: 'grant', reason: 'admin grants to self' });
  assert.equal(r.status, 400);

  // non-admin cannot use the API at all
  r = await n.post(`/api/users/${nav.id}/permissions`, { permission: 'audit:read', mode: 'grant', reason: 'escalation attempt' });
  assert.equal(r.status, 403);

  // audit log records the denied attempts too
  const row = H.db.one(`SELECT * FROM audit_log WHERE action='user.permission.denied' AND entity_id=? ORDER BY at DESC LIMIT 1`, nav.id);
  assert.ok(row, 'denied permission change is audited');
});
