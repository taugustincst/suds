'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

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
