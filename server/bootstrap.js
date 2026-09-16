'use strict';
// First-run bootstrap: creates the initial admin if no users exist.
const db = require('./db');
const config = require('./config');
const { hashPassword, uuid, randomToken } = require('./crypto');

function ensureBootstrap() {
  const count = db.one(`SELECT COUNT(*) AS n FROM users`).n;
  if (count > 0) return null;
  const username = process.env.SUDS_ADMIN_USERNAME || 'admin';
  const password = process.env.SUDS_ADMIN_PASSWORD || (randomToken(12) + 'Aa1!');
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,?,1,?)`,
    uuid(), username, hashPassword(password), 'System Administrator', 'admin', db.now());
  if (!config.isTest) {
    console.log('==========================================================');
    console.log(`[suds] Created initial admin user "${username}"`);
    if (!process.env.SUDS_ADMIN_PASSWORD) console.log(`[suds] Temporary password: ${password}`);
    console.log('[suds] You will be required to change it at first login.');
    console.log('==========================================================');
  }
  db.setSetting('caseload_restriction', '1');
  db.setSetting('org_name', process.env.SUDS_ORG_NAME || 'County SUD Navigation Program');
  return { username, password };
}
module.exports = { ensureBootstrap };
