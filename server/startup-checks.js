'use strict';
// Production configuration problems that leave the server running but the county exposed, gathered in one
// place so the startup log, /api/health and Security status say the same thing. Each is a sentence an
// administrator can act on. Outside production (a laptop, the test suite) nothing here applies.
const config = require('./config');

/** Scheduled backups switched off on a production server. */
function backupProblem() {
  if (!config.isProd || config.local) return null;
  const s = require('./scheduled-backup').settings();
  if (s.hours > 0 || s.minutes > 0) return null;
  return 'Scheduled backups are off (backup_schedule_hours = 0): nothing is backing this database up. Turn them on under Settings → Scheduled backups (every 4 hours is the production default; docs/security/BACKUP-AND-DR.md).';
}

/**
 * The PHI key and the blind-index key given the same value. They are separate so that the one that must be
 * handed to more places (the index key also keys the audit chain, and makes DOB and phone indexes, which are
 * low-entropy, testable by brute force) never also decrypts the records (docs/security/ENCRYPTION-AND-KEYS.md).
 */
function keySeparationProblem(c = config) {
  if (!c.isProd || c.local) return null;
  const same = (a, b) => a && b && Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (same(c.encryptionKey, c.indexKey)) return 'SUDS_ENCRYPTION_KEY and SUDS_INDEX_KEY are the same value. Anyone holding the index key can then decrypt every record. Generate a separate index key (npm run gen-key) and rotate to it: NEW_INDEX_KEY=… npm run rotate-index-key (docs/DEPLOYMENT.md, "Key rotation runbook").';
  if (same(c.backupKey, c.encryptionKey) || same(c.backupKey, c.indexKey)) return 'SUDS_BACKUP_KEY is the same value as another SUDS key; give backups a key of their own (npm run gen-key).';
  return null;
}

/**
 * The installer's domain (SUDS_DOMAIN in /etc/suds/suds-server.conf, which deploy/linux/install.sh writes world-readable),
 * or '' when this is not a SUDS Server install or the file does not name one.
 */
function installedDomain(confFile = process.env.SUDS_SERVER_CONF || '/etc/suds/suds-server.conf') {
  let text = '';
  try { text = require('node:fs').readFileSync(confFile, 'utf8'); } catch { return ''; }
  let dom = '';
  for (const line of text.split('\n')) { const m = /^SUDS_DOMAIN=(.*)$/.exec(line.trim()); if (m) dom = m[1].trim(); }
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(dom) ? dom.toLowerCase() : '';
}

/**
 * Passkeys (docs/FINGERPRINT.md) switched on in production with no relying party configured: no one can add or use
 * one. deploy/linux/upgrade.sh adds WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS from 1.20.0, but a server upgraded with an
 * older release's upgrade.sh (the one installed under /opt/suds/current) was not given them, and nothing said so
 * until the compliance report. On a SUDS Server install the sentence names the exact lines, from the installer's
 * domain. `policy`: { passkeySignin, passkeySigning } (auth.policy()); both off, nothing is missing.
 */
function passkeyRpProblem({ c = config, policy = null, confFile } = {}) {
  if (!c.isProd || c.local) return null;
  const wc = c.webauthn || {};
  if (wc.rpId || (wc.origins || []).length) return null;
  const pol = policy || require('./auth').policy();
  if (!pol.passkeySignin && !pol.passkeySigning) return null;
  const dom = installedDomain(confFile);
  if (dom) return `WEBAUTHN_RP_ID is not set, so no one can add or use a passkey (fingerprint sign-in) on this server. Add these two lines to /etc/suds/suds.env and run: systemctl restart suds\n  WEBAUTHN_RP_ID=${dom}\n  WEBAUTHN_ORIGINS=https://${dom}\n(an upgrade run with the upgrade.sh of SUDS 1.19.0 or older does not add them; docs/SELF-HOSTING.md, "Upgrading").`;
  return 'WEBAUTHN_RP_ID is not set, so no one can add or use a passkey (fingerprint sign-in) on this production server. Set WEBAUTHN_RP_ID to the server\'s name, as in the address staff open and on its certificate (and WEBAUTHN_ORIGINS=https://<that name>), and restart SUDS (docs/FINGERPRINT.md).';
}

/** Every production problem that applies right now. */
function problems() {
  const out = [];
  try { const p = require('./audit-anchor').placementProblem(); if (p) out.push(p); } catch {}
  try { const p = backupProblem(); if (p) out.push(p); } catch {}
  try { const p = keySeparationProblem(); if (p) out.push(p); } catch {}
  try { const p = passkeyRpProblem(); if (p) out.push(p); } catch {}
  return out;
}

module.exports = { problems, backupProblem, keySeparationProblem, passkeyRpProblem, installedDomain };
