'use strict';
// Lets a locked-out administrator of an OFFICE server back in: a new random temporary password, printed once
// here, that must be changed at the next sign-in; the account's lockout, failed attempts and two-step
// verification cleared, its passkeys (fingerprint sign-in) removed; every session it had ended. Run on the server itself (shell access to the server is
// the proof of ownership):
//
//   npm run reset-admin -- <username>
//
// It changes nothing but that one administrator account, and writes `admin.reset_cli` to the audit log (never
// the password). It says first, plainly, when the account was deactivated and is now active again, and it removes
// a deny of users:manage on the account (which would leave it unable to manage anyone), saying so. An account
// that is not an administrator is refused: an administrator resets it under Settings → Users. SUDS on this device keeps its records in a browser, not here: a device's owner uses the
// recovery code on its sign-in page instead (docs/USER_GUIDE.md).
// A CLI script, so the synchronous password hashing is fine here (CLAUDE.md).
const crypto = require('node:crypto');
const db = require('../server/db');
const { hashPassword } = require('../server/crypto');
const auth = require('../server/auth');
const audit = require('../server/audit');

const username = String(process.argv[2] || '').trim();
if (!username || username.startsWith('-')) {
  console.error('Usage: npm run reset-admin -- <username>\nSets a new temporary password for that administrator, clears its lockout, two-step verification and passkeys, and prints the password once.');
  process.exit(1);
}

/** A temporary password the policy accepts: 20 random base64url characters (120 bits) plus one of each class. */
function temporaryPassword() {
  for (;;) {
    const pw = `Temp-${crypto.randomBytes(15).toString('base64url')}-${crypto.randomInt(10, 100)}x`;
    if (!auth.passwordPolicy(pw).length) return pw;
  }
}

db.open();
try {
  const u = db.one(`SELECT id, username, role, is_active, access_status, mfa_enabled, locked_until, failed_attempts FROM users WHERE username=?`, username);
  if (!u) {
    console.error(`There is no account called "${username}" on this server. To create an administrator, use: SUDS_ADMIN_USERNAME=<name> SUDS_ADMIN_PASSWORD='<password>' npm run create-admin`);
    process.exitCode = 1;
  } else if (u.role !== 'admin') {
    console.error(`"${u.username}" is not an administrator. An administrator can reset its password under Settings → Users.`);
    process.exitCode = 1;
  } else {
    const password = temporaryPassword();
    const now = db.now();
    db.run(`UPDATE users SET password_hash=?, must_change_password=1, is_active=1, failed_attempts=0, locked_until=NULL, mfa_enabled=0, mfa_secret_enc=NULL, totp_last_step=NULL, password_changed_at=?, updated_at=? WHERE id=?`,
      hashPassword(password), now, now, u.id);
    auth.revokeAllForUser(u.id);
    // Its passkeys go too, as with an administrator's reset under Settings → Users (server/routes/users.js): a passkey is
    // a way in and a second factor like the code, and the phone holding it may be why the account is being recovered.
    // Audited as auth.passkey.removed, cause 'cli reset' (server/passkeys.js remove).
    const passkeysRemoved = require('../server/config').local ? 0 : require('../server/passkeys').remove(u.id, { actor: { username: 'cli' }, ip: null, cause: 'cli reset' });
    // An administrator whose users:manage is denied could sign in and change nothing about anyone, the account
    // being reset included: the deny goes, and the output says so (security review of 1.15.3, L2).
    const denied = db.one(`SELECT 1 FROM user_permission_overrides WHERE user_id=? AND permission='users:manage' AND mode='deny'`, u.id);
    if (denied) db.run(`DELETE FROM user_permission_overrides WHERE user_id=? AND permission='users:manage' AND mode='deny'`, u.id);
    audit.log({ user: { username: 'cli' }, action: 'admin.reset_cli', entity: 'user', entityId: u.id,
      details: { username: u.username, mfa_cleared: !!u.mfa_enabled, lockout_cleared: !!(u.locked_until || u.failed_attempts), reactivated: !u.is_active, users_manage_deny_cleared: !!denied, passkeys_removed: passkeysRemoved || undefined } });
    // A deactivated administrator is usually someone who left: bringing the account back is said first, plainly.
    if (!u.is_active) {
      console.log(`WARNING: "${u.username}" was deactivated and is active again now. If it was deactivated on purpose (the person left, or the`);
      console.log('account was compromised), sign in with it only to do what you need, then deactivate it again under Settings → Users.\n');
    }
    console.log(`Temporary password for administrator "${u.username}" (shown once; it is not saved anywhere):\n\n    ${password}\n`);
    console.log('They must choose a new password when they sign in. Every session this account had has been ended.');
    if (u.mfa_enabled) console.log('Two-step verification was turned off for this account: set it up again under My profile after signing in.');
    if (passkeysRemoved) console.log(`${passkeysRemoved} passkey${passkeysRemoved === 1 ? '' : 's'} (fingerprint sign-in) ${passkeysRemoved === 1 ? 'was' : 'were'} removed from this account: add ${passkeysRemoved === 1 ? 'it' : 'them'} again under My profile if you still want ${passkeysRemoved === 1 ? 'it' : 'them'}.`);
    if (denied) console.log('This account had users:manage denied (an individual override); that deny has been removed so it can manage users again. Its other overrides are unchanged.');
    console.log('If sign-ins from this address were being refused as too many attempts, restarting SUDS clears that limit.');
  }
} finally { db.close(); }
