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

/** Every production problem that applies right now. */
function problems() {
  const out = [];
  try { const p = require('./audit-anchor').placementProblem(); if (p) out.push(p); } catch {}
  try { const p = backupProblem(); if (p) out.push(p); } catch {}
  try { const p = keySeparationProblem(); if (p) out.push(p); } catch {}
  return out;
}

module.exports = { problems, backupProblem, keySeparationProblem };
