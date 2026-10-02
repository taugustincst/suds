'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const auth = require('../server/auth');

before(async () => { await H.start(); });
after(() => H.stop());

test('migration 48 created user_permission_overrides', async () => {
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
  r = await a.del(`/api/users/${nav.id}/permissions/clients:read`, { reason: 'back to the full navigator role' });
  assert.equal(r.status, 200);
  r = await a.del(`/api/users/${nav.id}/permissions/audit:read`, { reason: 'weekly review moved elsewhere' });
  assert.equal(r.status, 200);
  // the revoke audit row carries the permission and mode of the removed override, and the lengths of the reasons
  // (1.15.4: the words stay out of the audit log)
  const rev = H.db.one(`SELECT details FROM audit_log WHERE action='user.permission.revoke' AND entity_id=? ORDER BY at DESC LIMIT 1`, nav.id);
  assert.ok(rev, 'revoke is audited');
  const revDetails = JSON.parse(rev.details);
  assert.equal(revDetails.permission, 'audit:read');
  assert.equal(revDetails.mode, 'grant');
  assert.equal(revDetails.reason, undefined);
  assert.equal(revDetails.reason_length, 'reviews the break-glass queue weekly'.length);
  assert.equal(revDetails.revoke_reason_length, 'weekly review moved elsewhere'.length);
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

  // an administrator may change their own permissions (the owner's decision after 1.23.5), audited with self: true
  r = await a.post(`/api/users/${admin.id}/permissions`, { permission: 'reports:funder', mode: 'grant', reason: 'admin grants to self' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='user.permission.grant' AND entity_id=? ORDER BY rowid DESC LIMIT 1`, admin.id).details).self, true);
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, admin.id);

  // non-admin cannot use the API at all
  r = await n.post(`/api/users/${nav.id}/permissions`, { permission: 'audit:read', mode: 'grant', reason: 'escalation attempt' });
  assert.equal(r.status, 403);

  // audit log records the denied attempts too
  const row = H.db.one(`SELECT * FROM audit_log WHERE action='user.permission.denied' AND entity_id=? ORDER BY at DESC LIMIT 1`, nav.id);
  assert.ok(row, 'denied permission change is audited');
});

test('every permission that widens what a person may read is in READ_SCOPE_PERMS, one list for sync, the device and the benchmark (1.16.1)', async () => {
  // They were listed by hand in the sync scope key, the device sign-up's caseload hold and the benchmark: the next
  // one had to be added in three or four places, and a miss leaks data or skips a re-sync.
  const { READ_SCOPE_PERMS, CASELOAD_PERMS, isKnownPermission } = require('../server/permissions');
  const SYNC = require('../server/sync-tables');
  const listed = new Set(Object.keys(READ_SCOPE_PERMS));
  for (const p of listed) assert.ok(isKnownPermission(p), `${p} is a permission`);
  for (const p of CASELOAD_PERMS) assert.ok(listed.has(p), `${p} (the caseload hold) widens reading`);
  // The sync route's own checks: each permission a pull asks about is listed, or comes from a table (readPerm,
  // redaction, unlinked.all), which the scope key adds by itself. Asked, not read from the source: every
  // hasPerm call a pull makes, by roles that take each branch (1.16.2; a regex over the file missed helpers).
  const fromTables = new Set(SYNC.tables.flatMap(t => [t.readPerm, t.redact && t.redact.perm, t.unlinked && t.unlinked.all].filter(Boolean)));
  // The key's other parts, caseload= and counseling=, carry the answers of auth.caseloadRestricted and rules/notes
  // readsCounseling, whatever permissions those read, so a permission only they ask about needs no listing. Only
  // readsCounseling's questions are recorded in `keyed` below: caseloadRestricted calls auth.js's own module-local
  // hasPerm, which this spy on the export cannot see (engineering review of 1.16.2, L3; 1.16.2's comment said both
  // were recorded). It asks clients:all, clients:read and clients:list-deidentified, and its caseload= answer is in
  // the key itself, so nothing is lost; the pull's own calls through auth.js are likewise not in `asked`.
  const asked = new Set(); const keyed = new Set(); const real = auth.hasPerm;
  const COUNSEL = require('../server/rules/notes');
  const pullAs = async (role, ...denied) => {
    const u = H.deny(H.makeUser(`scopeperm_${role}_${denied.length}`, role), ...denied);
    const c = H.client(); await c.login(u.username, 'StaffPassw0rd!x');
    let seen = null;
    auth.hasPerm = (user, p) => { if (user && user.id === u.id) { asked.add(p); seen = user; } return real(user, p); };
    const config = require('../server/config'); const was = config.localModeEnabled; config.localModeEnabled = true;
    try { assert.equal((await c.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z')).status, 200); } finally { auth.hasPerm = real; config.localModeEnabled = was; }
    auth.hasPerm = (user, p) => { keyed.add(p); return real(user, p); };
    try { auth.caseloadRestricted(seen); COUNSEL.readsCounseling(seen); } finally { auth.hasPerm = real; }
  };
  await pullAs('navigator'); await pullAs('navigator', 'clients:all', 'notes:clinical:read'); await pullAs('supervisor'); await pullAs('clinician');
  asked.delete('clients:read'); // the route's gate (who may sync at all), not how far a pull reaches
  assert.ok(asked.size >= 3, [...asked].join(', '));
  for (const p of asked) assert.ok(listed.has(p) || fromTables.has(p) || keyed.has(p), `a sync pull asks about ${p}, which is not in READ_SCOPE_PERMS`);
  const fs = require('node:fs'); const path = require('node:path');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(src('local/kernel.js'), /const SIGNUP_SCOPE = require\('\.\.\/server\/permissions\.js'\)\.CASELOAD_PERMS;/);
  assert.match(src('scripts/bench/run.js'), /const HELD = require\('\.\.\/\.\.\/server\/permissions'\)\.CASELOAD_PERMS;/);
});
