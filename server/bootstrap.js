'use strict';
// First-run bootstrap: creates the initial admin if no users exist.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const config = require('./config');
const crypto = require('node:crypto');
const { hashPassword, uuid, randomToken } = require('./crypto');

// Where a generated first-admin password is left for the operator in production, mode 0600, and removed the
// moment that password is replaced (server/routes/auth.js, server/routes/setup.js). A container's stdout is
// often not something the person deploying it ever sees.
const PASSWORD_FILE = 'first-admin-password.txt';
function passwordFilePath() { return path.join(config.dataDir, PASSWORD_FILE); }
/** Remove the first-admin password file, if it is still there. Safe to call any time. */
function discardPasswordFile() { try { fs.unlinkSync(passwordFilePath()); return true; } catch { return false; } }

// The first administrator a new office server creates gets a name nobody can guess — "admin-" and six random
// letters and digits — unless SUDS_ADMIN_USERNAME names it (1.25.7, K6). Until 1.25.6 it was "guest": with an
// account locked after five failed sign-ins, a well-known administrator name let anyone keep the one account
// that can fix things locked, again and again. The name is printed at first start and written, with a generated
// password, to the 0600 password file; it is also kept in the settings (BOOTSTRAP_NAME_SETTING), where the setup
// wizard looks for the placeholder it replaces. A server created before 1.25.7 keeps its "guest" (Security status
// asks for a rename while an active administrator is called guest or admin).
const LEGACY_ADMIN_USERNAME = 'guest';
const BOOTSTRAP_NAME_SETTING = 'bootstrap_admin_username';
const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generatedAdminUsername() { let s = 'admin-'; for (let i = 0; i < 6; i++) s += NAME_CHARS[crypto.randomInt(NAME_CHARS.length)]; return s; }
/** The first administrator's username, as created (or as it will be created, when SUDS_ADMIN_USERNAME names it). */
function adminUsername() { return db.getSetting(BOOTSTRAP_NAME_SETTING, null) || process.env.SUDS_ADMIN_USERNAME || LEGACY_ADMIN_USERNAME; }
/** What the password file holds: the username, then the temporary password (one "name: value" per line). */
function passwordFileText(username, password) { return `Username: ${username}\nTemporary password: ${password}\n`; }
/** Read the password file's text: { username, password }. A file from before 1.25.7 holds the password alone. */
function parsePasswordFile(text) {
  const t = String(text);
  const field = (k) => (t.match(new RegExp(`^${k}: (.+)$`, 'm')) || [])[1];
  return field('Temporary password') !== undefined ? { username: field('Username').trim(), password: field('Temporary password').trim() } : { username: LEGACY_ADMIN_USERNAME, password: t.trim() };
}

function ensureBootstrap() {
  const count = db.one(`SELECT COUNT(*) AS n FROM users`).n;
  if (count > 0) return null;
  const username = process.env.SUDS_ADMIN_USERNAME || generatedAdminUsername();
  const generated = !process.env.SUDS_ADMIN_PASSWORD;
  const password = process.env.SUDS_ADMIN_PASSWORD || (randomToken(12) + 'Aa1!');
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,must_change_password,password_changed_at) VALUES(?,?,?,?,?,1,?)`,
    uuid(), username, hashPassword(password), 'System Administrator', 'admin', db.now());
  db.setSetting(BOOTSTRAP_NAME_SETTING, username);
  if (!config.isTest) {
    // Written straight to stdout, not through console.log: server/log.js tees the console to a file under
    // data/logs that is kept for 30 days, and a password does not belong in a log file. (log.js refuses
    // such a line as well, in case anything else ever prints one.)
    // Under systemd, stdout is the journal, which the adm group reads and which keeps the line after the password is
    // changed (1.25.6, J12): there only the username and the 0600 file are named, unless the file cannot be written.
    const journal = !!process.env.INVOCATION_ID || (!process.stdout.isTTY && !!process.env.JOURNAL_STREAM);
    let inFile = false; let fileError = null;
    if (generated && (config.isProd || journal)) {
      try { fs.writeFileSync(passwordFilePath(), passwordFileText(username, password), { mode: 0o600 }); inFile = true; } catch (e) { fileError = e.message; }
    }
    const lines = ['==========================================================', `[suds] Created initial admin user "${username}"`];
    if (generated && journal && inFile) lines.push(`[suds] Its username and temporary password are in ${passwordFilePath()} (mode 0600; not printed here, because this output goes to the system journal). That file is deleted automatically once the password is changed.`);
    else if (generated) lines.push(`[suds] Temporary password: ${password}`);
    lines.push('[suds] You will be required to change it at first login.');
    if (generated && inFile && !journal) lines.push(`[suds] The same username and password are in ${passwordFilePath()} (mode 0600); that file is deleted automatically once the password is changed.`);
    if (fileError) lines.push(`[suds] (could not write ${passwordFilePath()}: ${fileError})`);
    lines.push('==========================================================');
    process.stdout.write(lines.join('\n') + '\n');
  }
  db.setSetting('caseload_restriction', '1');
  db.setSetting('org_name', process.env.SUDS_ORG_NAME || 'County Harm Reduction and Outreach Program');
  return { username, password };
}
module.exports = { ensureBootstrap, discardPasswordFile, passwordFilePath, PASSWORD_FILE, LEGACY_ADMIN_USERNAME, BOOTSTRAP_NAME_SETTING, adminUsername, generatedAdminUsername, passwordFileText, parsePasswordFile };
