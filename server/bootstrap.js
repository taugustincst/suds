'use strict';
// First-run bootstrap: creates the initial admin if no users exist.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const config = require('./config');
const { hashPassword, uuid, randomToken } = require('./crypto');

// Where a generated first-admin password is left for the operator in production, mode 0600, and removed the
// moment that password is replaced (server/routes/auth.js, server/routes/setup.js). A container's stdout is
// often not something the person deploying it ever sees.
const PASSWORD_FILE = 'first-admin-password.txt';
function passwordFilePath() { return path.join(config.dataDir, PASSWORD_FILE); }
/** Remove the first-admin password file, if it is still there. Safe to call any time. */
function discardPasswordFile() { try { fs.unlinkSync(passwordFilePath()); return true; } catch { return false; } }

function ensureBootstrap() {
  const count = db.one(`SELECT COUNT(*) AS n FROM users`).n;
  if (count > 0) return null;
  const username = process.env.SUDS_ADMIN_USERNAME || 'admin';
  const generated = !process.env.SUDS_ADMIN_PASSWORD;
  const password = process.env.SUDS_ADMIN_PASSWORD || (randomToken(12) + 'Aa1!');
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,?,1,?)`,
    uuid(), username, hashPassword(password), 'System Administrator', 'admin', db.now());
  if (!config.isTest) {
    // Written straight to stdout, not through console.log: server/log.js tees the console to a file under
    // data/logs that is kept for 30 days, and a password does not belong in a log file. (log.js refuses
    // such a line as well, in case anything else ever prints one.)
    const lines = ['==========================================================', `[suds] Created initial admin user "${username}"`];
    if (generated) lines.push(`[suds] Temporary password: ${password}`);
    lines.push('[suds] You will be required to change it at first login.');
    if (generated && config.isProd) {
      try {
        fs.writeFileSync(passwordFilePath(), `${password}\n`, { mode: 0o600 });
        lines.push(`[suds] The same password is in ${passwordFilePath()} (mode 0600); that file is deleted automatically once the password is changed.`);
      } catch (e) { lines.push(`[suds] (could not write ${passwordFilePath()}: ${e.message})`); }
    }
    lines.push('==========================================================');
    process.stdout.write(lines.join('\n') + '\n');
  }
  db.setSetting('caseload_restriction', '1');
  db.setSetting('org_name', process.env.SUDS_ORG_NAME || 'County Harm Reduction and Outreach Program');
  return { username, password };
}
module.exports = { ensureBootstrap, discardPasswordFile, passwordFilePath, PASSWORD_FILE };
