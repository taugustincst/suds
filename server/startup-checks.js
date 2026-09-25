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

/** Every production problem that applies right now. */
function problems() {
  const out = [];
  try { const p = require('./audit-anchor').placementProblem(); if (p) out.push(p); } catch {}
  try { const p = backupProblem(); if (p) out.push(p); } catch {}
  return out;
}

module.exports = { problems, backupProblem };
