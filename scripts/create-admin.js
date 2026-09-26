'use strict';
// Creates (or resets) an administrator account. Usage:
//   SUDS_ADMIN_USERNAME=guest SUDS_ADMIN_PASSWORD='...' npm run create-admin   (guest is the default name)
const db = require('../server/db');
const { hashPassword, uuid } = require('../server/crypto');
const auth = require('../server/auth');
const audit = require('../server/audit');
const username = process.env.SUDS_ADMIN_USERNAME || 'guest';
const password = process.env.SUDS_ADMIN_PASSWORD;
if (!password) { console.error('Set SUDS_ADMIN_PASSWORD'); process.exit(1); }
const errs = auth.passwordPolicy(password);
if (errs.length) { console.error('Password must contain ' + errs.join(', ')); process.exit(1); }
db.open();
const ex = db.one(`SELECT id FROM users WHERE username=?`, username);
if (ex) {
  db.run(`UPDATE users SET password_hash=?, role='admin', is_active=1, must_change_password=1, locked_until=NULL, failed_attempts=0, password_changed_at=?, updated_at=? WHERE id=?`, hashPassword(password), db.now(), db.now(), ex.id);
  auth.revokeAllForUser(ex.id);
  audit.log({ user: { username: 'cli' }, action: 'user.reset_admin', entity: 'user', entityId: ex.id, details: { username } });
  console.log(`Reset password for existing admin "${username}" (must change at next login).`);
} else {
  const id = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,?,1,?)`, id, username, hashPassword(password), 'System Administrator', 'admin', db.now());
  audit.log({ user: { username: 'cli' }, action: 'user.create_admin', entity: 'user', entityId: id, details: { username } });
  console.log(`Created admin "${username}" (must change password at first login).`);
}
db.close();
