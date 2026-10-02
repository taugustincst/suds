'use strict';
// An administrator changes their own access (the owner's decision after 1.23.5: "Admin needs to be able to change
// all permissions including their own"). Whoever holds users:manage may change anyone's role, permissions and
// account, their own included, through the same routes; a change that would leave no active account able to manage
// users and permissions is refused, whoever it is made to (auth.lockoutProblem); self-changes are audited like any
// other, marked self: true; and approving one's own time or spending stays refused.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

before(async () => { await H.start(); });
after(() => H.stop());

const REASON = 'Covers the programme director role this quarter';
const LOCKOUT = /no active administrator who can manage users/;
const lastAudit = (action, entityId) => {
  const row = H.db.one(`SELECT details FROM audit_log WHERE action=? AND entity_id=? ORDER BY rowid DESC LIMIT 1`, action, entityId);
  return row ? JSON.parse(row.details || '{}') : null;
};
// Leave `keep` as the only active administrators: every other active admin is set inactive, and given back after.
async function onlyAdmins(keep, fn) {
  const others = H.db.all(`SELECT id FROM users WHERE role='admin' AND is_active=1`).map(r => r.id).filter(id => !keep.includes(id));
  for (const id of others) H.db.run(`UPDATE users SET is_active=0 WHERE id=?`, id);
  try { await fn(); } finally { for (const id of others) H.db.run(`UPDATE users SET is_active=1 WHERE id=?`, id); }
}
async function signIn(u) { const c = H.client(); await c.login(u.username, u.password); return c; }

test('an administrator grants and denies their own permissions, audited with self: true, effective on the next request', async () => {
  const me = H.makeUser('selfperm_a', 'admin');
  const c = await signIn(me);
  // Deny: audit:read leaves at once (the next request), and the audit row says it was their own.
  let r = await c.post(`/api/users/${me.id}/permissions`, { permission: 'audit:read', mode: 'deny', reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.self, true);
  let a = lastAudit('user.permission.deny', me.id);
  assert.equal(a.self, true); assert.equal(a.permission, 'audit:read');
  assert.ok(!JSON.stringify(a).includes('programme director'), 'the reason itself stays out of the audit log');
  assert.equal((await c.get('/api/me')).data.denied_permissions.includes('audit:read'), true, '/api/me reflects it');
  assert.equal((await c.get('/api/admin/audit')).status, 403, 'and the server enforces it on the next request');
  // Revoke the deny (a reason needed, as for anyone): back.
  r = await c.del(`/api/users/${me.id}/permissions/audit:read`, { reason: 'Back to the full administrator role' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(lastAudit('user.permission.revoke', me.id).self, true);
  assert.equal((await c.get('/api/admin/audit')).status, 200);
  // Grant: allowed for an administrator as for anyone (privileged ones only to the admin role: they are one).
  r = await c.post(`/api/users/${me.id}/permissions`, { permission: 'notes:clinical:read', mode: 'grant', reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(lastAudit('user.permission.grant', me.id).self, true);
  assert.ok((await c.get('/api/me')).data.permissions.includes('notes:clinical:read'));
  // A change to someone else carries no self mark.
  const nav = H.makeUser('selfperm_nav', 'navigator');
  assert.equal((await c.post(`/api/users/${nav.id}/permissions`, { permission: 'audit:read', mode: 'grant', reason: REASON })).status, 200);
  assert.equal(lastAudit('user.permission.grant', nav.id).self, undefined);
});

test('an administrator changes their own role while another administrator remains, audited with self: true', async () => {
  const me = H.makeUser('selfrole_a', 'admin');
  const c = await signIn(me);
  const r = await c.put(`/api/users/${me.id}`, { role: 'supervisor' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = lastAudit('user.update', me.id);
  assert.equal(a.self, true); assert.deepEqual(a.role, { from: 'admin', to: 'supervisor' });
  assert.equal(H.db.one(`SELECT role FROM users WHERE id=?`, me.id).role, 'supervisor');
  // The same session now holds the supervisor's permissions: user management is gone at once.
  const meNow = (await c.get('/api/me')).data;
  assert.equal(meNow.role, 'supervisor'); assert.ok(!meNow.permissions.includes('users:manage'));
  assert.equal((await c.get(`/api/users/${me.id}/permissions`)).status, 403);
  // And cannot promote itself back: users:manage is an administrator's (security review of 1.15.3, M2).
  assert.equal((await c.put(`/api/users/${me.id}`, { role: 'admin' })).status, 403);
});

test('the bulk "hold to caseload" may include the administrator\'s own account', async () => {
  const me = H.makeUser('selfbulk_a', 'admin');
  const nav = H.makeUser('selfbulk_nav', 'navigator');
  const c = await signIn(me);
  const r = await c.post('/api/users/caseload-default/apply', { user_ids: [me.id, nav.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.changed, 1, 'the navigator is held; an administrator is not a navigator or clinician, so is left as is');
  assert.equal(r.data.skipped, 1);
  H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, nav.id);
});

test('lockout guard: the last administrator cannot deny their own users:manage, demote or deactivate themselves', async () => {
  const me = H.makeUser('selflast_a', 'admin');
  const c = await signIn(me);
  await onlyAdmins([me.id], async () => {
    let r = await c.post(`/api/users/${me.id}/permissions`, { permission: 'users:manage', mode: 'deny', reason: REASON });
    assert.equal(r.status, 400); assert.match(r.data.error, LOCKOUT); assert.equal(r.data.lockout, true);
    const d = lastAudit('user.permission.denied', me.id);
    assert.equal(d.self, true); assert.match(d.reason, LOCKOUT);
    r = await c.put(`/api/users/${me.id}`, { role: 'navigator' });
    assert.equal(r.status, 400); assert.match(r.data.error, LOCKOUT);
    assert.equal(lastAudit('user.update.denied', me.id).self, true);
    r = await c.put(`/api/users/${me.id}`, { is_active: false });
    assert.equal(r.status, 400, 'self-deactivation refused when it is the last'); assert.match(r.data.error, LOCKOUT);
    const row = H.db.one(`SELECT role, is_active FROM users WHERE id=?`, me.id);
    assert.deepEqual({ ...row }, { role: 'admin', is_active: 1 }, 'nothing changed');
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM user_permission_overrides WHERE user_id=?`, me.id).n, 0);
    // Changes that leave them a user manager still go through: a deny of something else, their own title.
    assert.equal((await c.post(`/api/users/${me.id}/permissions`, { permission: 'graph:import', mode: 'deny', reason: REASON })).status, 200);
    assert.equal((await c.put(`/api/users/${me.id}`, { title: 'Director' })).status, 200);
    H.db.run(`DELETE FROM user_permission_overrides WHERE user_id=?`, me.id);
  });
});

test('lockout guard: the last administrator cannot be demoted, denied or deactivated by anyone else either', async () => {
  const me = H.makeUser('selfother_a', 'admin');
  const other = H.makeUser('selfother_b', 'admin');
  const c = await signIn(me);
  // Two administrators, me and other; every other administrator is set aside for the test.
  await onlyAdmins([me.id, other.id], async () => {
    const o = await signIn(other);
    // other denies me users:manage: allowed (other remains).
    assert.equal((await o.post(`/api/users/${me.id}/permissions`, { permission: 'users:manage', mode: 'deny', reason: REASON })).status, 200);
    assert.equal((await c.get('/api/users/' + me.id + '/permissions')).status, 403, 'me lost it at once');
    // Now other is the last: other cannot deactivate or demote themselves.
    assert.match((await o.put(`/api/users/${other.id}`, { is_active: false })).data.error, LOCKOUT);
    // Revoking me's deny gives the access back (never refused: it only adds).
    assert.equal((await o.del(`/api/users/${me.id}/permissions/users:manage`, { reason: 'Back as a full administrator now' })).status, 200);
    // Two again: other may now deactivate themselves (me remains), audited with self: true.
    const r = await o.put(`/api/users/${other.id}`, { is_active: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(lastAudit('user.update', other.id).self, true);
    assert.equal((await o.get('/api/me')).status, 401, 'their own sessions end with the account');
    // me is now the last administrator, and cannot demote themselves.
    assert.match((await c.put(`/api/users/${me.id}`, { role: 'supervisor' })).data.error, LOCKOUT);
    H.db.run(`UPDATE users SET is_active=1 WHERE id=?`, other.id);
    // With other back, me demoting other is allowed; then other is not an admin, so other cannot demote me.
    assert.equal((await c.put(`/api/users/${other.id}`, { role: 'supervisor' })).status, 200);
    assert.match((await c.post(`/api/users/${me.id}/permissions`, { permission: 'users:manage', mode: 'deny', reason: REASON })).data.error, LOCKOUT);
  });
});

test('a non-administrator still cannot change anyone\'s permissions or role, their own included', async () => {
  const sup = H.makeUser('selfnon_sup', 'supervisor');
  const nav = H.makeUser('selfnon_nav', 'navigator');
  const c = await signIn(sup);
  assert.equal((await c.post(`/api/users/${sup.id}/permissions`, { permission: 'audit:read', mode: 'deny', reason: REASON })).status, 403);
  assert.equal((await c.post(`/api/users/${nav.id}/permissions`, { permission: 'audit:read', mode: 'grant', reason: REASON })).status, 403);
  assert.equal((await c.put(`/api/users/${sup.id}`, { role: 'admin' })).status, 403);
  assert.equal((await c.put(`/api/users/${nav.id}`, { role: 'supervisor' })).status, 403);
  assert.equal((await c.post('/api/users/caseload-default/apply', { user_ids: [nav.id] })).status, 403);
});

test('separation of duties that is not about permissions stays: an administrator cannot approve their own time', async () => {
  const me = H.makeUser('selfsod_a', 'admin');
  const c = await signIn(me);
  const id = require('node:crypto').randomUUID();
  H.db.run(`INSERT INTO time_entries(id, user_id, work_date, minutes, status) VALUES(?,?,?,30,'submitted')`, id, me.id, new Date().toISOString().slice(0, 10));
  const r = await c.post(`/api/time/${id}/approve`, { decision: 'approved' });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error, /your own time/);
});

// Security review of the self-edit change: the route hashed a new password between the lockout check and the write, so
// two administrators demoting each other at the same moment, each with a password reset, could both pass the check.
test('lockout guard: two administrators demoting each other at once, with password resets, leave one administrator', async () => {
  const a = H.makeUser('race_a', 'admin'); const b = H.makeUser('race_b', 'admin');
  const ca = await signIn(a); const cb = await signIn(b);
  await onlyAdmins([a.id, b.id], async () => {
    const pw = 'Race-Condition-Pass-2026!';
    const [ra, rb] = await Promise.all([ca.put(`/api/users/${b.id}`, { role: 'navigator', password: pw }), cb.put(`/api/users/${a.id}`, { role: 'navigator', password: pw })]);
    const admins = H.db.one(`SELECT COUNT(*) n FROM users WHERE id IN (?,?) AND role='admin' AND is_active=1`, a.id, b.id).n;
    assert.equal(admins, 1, `one administrator is left (${ra.status}, ${rb.status})`);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 400]);
    H.db.run(`UPDATE users SET role='admin' WHERE id IN (?,?)`, a.id, b.id);
  });
});
