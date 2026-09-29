'use strict';
// `npm run reset-admin -- <username>` (scripts/reset-admin.js): an office administrator who is locked out —
// forgotten password, a lockout, a lost authenticator — is let back in by whoever has a shell on the server.
// Run as the operator would, against a database of its own in a temporary data directory.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-reset-admin-'));
const env = { ...process.env, SUDS_ENV: 'test', SUDS_DATA_DIR: dir, SUDS_DB_PATH: path.join(dir, 'suds.db') };
const node = (args, extra = {}) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
// A few lines against the same database, in a process of its own (the scripts open and close it themselves).
const inDb = (code) => {
  const r = node(['-e', `const db = require('./server/db'); db.open(); const out = (() => { ${code} })(); db.close(); process.stdout.write(JSON.stringify(out ?? null));`]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('reset-admin gives a locked-out administrator a temporary password, clears the lockout and two-step verification, and audits it', () => {
  try {
    const made = node(['scripts/create-admin.js'], { SUDS_ADMIN_USERNAME: 'boss', SUDS_ADMIN_PASSWORD: 'Original-Pass-2026!' });
    assert.equal(made.status, 0, made.stderr);
    // Locked out, with two-step verification on and a session open; and a navigator beside it.
    inDb(`db.run("UPDATE users SET locked_until=?, failed_attempts=4, mfa_enabled=1, mfa_secret_enc='x', must_change_password=0 WHERE username='boss'", new Date(Date.now() + 3600e3).toISOString());
      const u = db.one("SELECT id FROM users WHERE username='boss'");
      db.run("INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at) VALUES('s1',?,?,?,?)", u.id, db.now(), db.now(), new Date(Date.now() + 3600e3).toISOString());
      db.run("INSERT INTO users(id,username,password_hash,display_name,role) VALUES('n1','nav','x','Nav','navigator')");`);

    const usage = node(['scripts/reset-admin.js']);
    assert.equal(usage.status, 1); assert.match(usage.stderr, /Usage: npm run reset-admin -- <username>/);
    const unknown = node(['scripts/reset-admin.js', 'nobody']);
    assert.equal(unknown.status, 1); assert.match(unknown.stderr, /no account called "nobody".*create-admin/s);
    const notAdmin = node(['scripts/reset-admin.js', 'nav']);
    assert.equal(notAdmin.status, 1); assert.match(notAdmin.stderr, /not an administrator/);

    const r = node(['scripts/reset-admin.js', 'boss']);
    assert.equal(r.status, 0, r.stderr);
    const pw = (/\n {4}(\S+)\n/.exec(r.stdout) || [])[1];
    assert.ok(pw, r.stdout);
    assert.match(r.stdout, /Two-step verification was turned off/);
    const u = inDb(`const u = db.one("SELECT * FROM users WHERE username='boss'"); const { verifyPassword } = require('./server/crypto');
      return { policy: require('./server/auth').passwordPolicy(${JSON.stringify(pw)}), ok: verifyPassword(${JSON.stringify(pw)}, u.password_hash), old: verifyPassword('Original-Pass-2026!', u.password_hash), must: u.must_change_password, mfa: u.mfa_enabled, secret: u.mfa_secret_enc, locked: u.locked_until, failed: u.failed_attempts,
        sessions: db.one("SELECT COUNT(*) n FROM sessions WHERE user_id=? AND revoked_at IS NULL", u.id).n,
        audit: db.all("SELECT username, action, details FROM audit_log WHERE action='admin.reset_cli'") };`);
    assert.deepStrictEqual(u.policy, [], 'the temporary password meets the password policy');
    assert.equal(u.ok, true, 'the printed password signs in'); assert.equal(u.old, false, 'the old one does not');
    assert.equal(u.must, 1, 'and must be changed at the next sign-in');
    assert.equal(u.mfa, 0); assert.equal(u.secret, null, 'two-step verification is off');
    assert.equal(u.locked, null); assert.equal(u.failed, 0, 'the lockout is cleared');
    assert.equal(u.sessions, 0, 'every session it had is ended');
    assert.equal(u.audit.length, 1, 'audited once');
    assert.equal(u.audit[0].username, 'cli');
    assert.deepStrictEqual(JSON.parse(u.audit[0].details), { username: 'boss', mfa_cleared: true, lockout_cleared: true, reactivated: false, users_manage_deny_cleared: false });
    assert.doesNotMatch(r.stdout, /reactivated|deny/i, 'nothing said about what did not happen');
    assert.ok(!JSON.stringify(u.audit).includes(pw), 'never the password');
    const again = node(['scripts/reset-admin.js', 'boss']);
    assert.notEqual((/\n {4}(\S+)\n/.exec(again.stdout) || [])[1], pw, 'a new random password each time');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reset-admin says loudly when it reactivates a deactivated administrator, and clears a deny of users:manage on that account (1.15.4, L2)', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-reset-admin-'));
  const env2 = { SUDS_DATA_DIR: dir2, SUDS_DB_PATH: path.join(dir2, 'suds.db') };
  const inDb2 = (code) => { const r = node(['-e', `const db = require('./server/db'); db.open(); const out = (() => { ${code} })(); db.close(); process.stdout.write(JSON.stringify(out ?? null));`], env2); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  try {
    assert.equal(node(['scripts/create-admin.js'], { ...env2, SUDS_ADMIN_USERNAME: 'gone', SUDS_ADMIN_PASSWORD: 'Original-Pass-2026!' }).status, 0);
    // Deactivated (they left), and with users:manage denied: a reset used to bring the account back silently,
    // and back without the power to manage users -- so the person resetting could not fix anything either.
    inDb2(`const u = db.one("SELECT id FROM users WHERE username='gone'"); db.run("UPDATE users SET is_active=0 WHERE id=?", u.id);
      db.run("INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'users:manage', 'deny', 'left the organisation')", u.id);
      db.run("INSERT INTO user_permission_overrides(user_id, permission, mode, reason) VALUES(?, 'audit:read', 'deny', 'kept as it was')", u.id);`);
    const r = node(['scripts/reset-admin.js', 'gone'], env2);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /WARNING.*was deactivated.*is active again/s, 'the reactivation is said first and plainly');
    assert.match(r.stdout, /deactivate it again under Settings/);
    assert.match(r.stdout, /users:manage.*denied.*removed/s, 'and the cleared deny is said');
    const after = inDb2(`const u = db.one("SELECT * FROM users WHERE username='gone'"); return { active: u.is_active, overrides: db.all("SELECT permission, mode FROM user_permission_overrides WHERE user_id=? ORDER BY permission", u.id), audit: db.all("SELECT details FROM audit_log WHERE action='admin.reset_cli'") };`);
    assert.equal(after.active, 1);
    assert.deepStrictEqual(after.overrides, [{ permission: 'audit:read', mode: 'deny' }], 'only the users:manage deny is removed');
    const d = JSON.parse(after.audit[0].details);
    assert.equal(d.reactivated, true); assert.equal(d.users_manage_deny_cleared, true);
  } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
});
