'use strict';
// The rules for assignments: who is on a client's care team. Managing the team is assignments:manage, with one
// exception that mirrors POST /api/clients: a worker who creates a client is put on it as primary, and the
// device does exactly that offline, so the assignment it pushes (its own, on a client it created) is taken.
const db = require('../db');
const auth = require('../auth');
const { define, refuse } = require('./core');

/**
 * An assignment a worker without assignments:manage may still push: their own (user_id is theirs, or a
 * device-minted id about to be remapped to them), as primary, on a client they created. The client is checked
 * against the office copy, so the clients rows of the same push count; a client someone else created, or one
 * the office has never seen, does not qualify.
 */
function isSelfAssignment(raw, user, knownUsers, batchClients) {
  if (!raw || typeof raw.client_id !== 'string') return false;
  if (raw.user_id && raw.user_id !== user.id && knownUsers.has(raw.user_id)) return false;
  if ((raw.role_on_case || 'primary') !== 'primary') return false;
  const existing = db.one(`SELECT user_id FROM assignments WHERE id=?`, raw.id);
  if (existing && existing.user_id !== user.id) return false;
  const client = db.one(`SELECT created_by FROM clients WHERE id=?`, raw.client_id);
  if (client) return client.created_by === user.id;
  // Not at the office yet: the same push must be creating it, and by this worker (a device-minted creator id
  // is remapped to the syncing user when the client row lands).
  const inBatch = batchClients.get(raw.client_id);
  return !!inBatch && (!inBatch.created_by || inBatch.created_by === user.id || !knownUsers.has(inBatch.created_by));
}

const ROLES = ['primary', 'secondary', 'clinician', 'peer', 'supervisor'];

/** An existing assignment whose only change is the end date a discharge (or re-admission) in this push sets. */
function endedByEpisode(raw, s) {
  if (!raw || typeof raw.client_id !== 'string' || !require('../auth').hasPerm(s.user, 'episodes:write')) return false;
  const e = db.one(`SELECT * FROM assignments WHERE id=?`, raw.id);
  if (!e || e.client_id !== raw.client_id) return false;
  const episodes = (s.tables.episodes || []).filter(x => x && x.client_id === raw.client_id);
  const dates = new Set(episodes.map(x => (x.status === 'closed' ? x.closed_at : null)));
  const same = (k) => raw[k] === undefined || String(raw[k] ?? '') === String(e[k] ?? '');
  return episodes.length > 0 && dates.has(raw.end_date ?? null) && ['user_id', 'role_on_case', 'start_date', 'ended_at'].every(same);
}

module.exports = define({
  table: 'assignments',
  fields: { user_id: { type: 'string', required: true }, role_on_case: { type: 'string', enum: ROLES }, start_date: { type: 'date' }, notes: { type: 'string', maxLen: 500 } },
  // A client is put on a worker the office knows and has not deactivated. (A device-minted account id the office
  // has never seen is the syncing user's own offline account, remapped to them when the row lands.)
  check(row, c) {
    if (row.user_id === undefined || (c.existing && row.user_id === c.existing.user_id)) return null;
    const u = db.one(`SELECT is_active FROM users WHERE id=?`, row.user_id);
    if ((!u && c.via === 'rest') || (u && !u.is_active)) return refuse('has a value the office does not accept (a worker the office has deactivated)', { message: 'Unknown or inactive worker' });
    return null;
  },
  // Decided before anything in the push is applied, against the office copy as it stands.
  prepare(s, rows) {
    const batchClients = new Map((s.tables.clients || []).filter(r => r && typeof r.id === 'string').map(r => [r.id, r]));
    const selfForClient = new Map(); const selfIds = new Set();
    for (const raw of rows) if (raw && typeof raw.id === 'string' && isSelfAssignment(raw, s.user, s.knownUsers, batchClients)) { selfForClient.set(raw.client_id, raw); selfIds.add(raw.id); }
    s.state.assignments = { selfForClient, selfIds };
  },
  // Also the care team a discharge ends (or a re-admission restores) along with the episode, which the same push
  // carries: POST /api/episodes/:id/close and /reopen do that with episodes:write alone.
  permitsWithoutWritePerm: (raw, s) => s.state.assignments.selfIds.has(raw.id) || endedByEpisode(raw, s),
  // A self-assignment is what puts the new client on the caseload, so it cannot be judged by it.
  outsideCaseload: (raw, c) => c.session.state.assignments.selfIds.has(raw.id),
  authorise(row, c) {
    // A matching open assignment under another id (the office's own, from a sync before this rule existed)
    // makes the device's row a duplicate, refused for good so the device stops offering it.
    if (c.via === 'sync' && !c.existing && c.session.state.assignments.selfIds.has(row.id)) {
      const dup = db.one(`SELECT id FROM assignments WHERE client_id=? AND user_id=? AND role_on_case=? AND id<>? AND ${auth.activeAssignment()}`, row.client_id, c.user.id, row.role_on_case || 'primary', row.id);
      if (dup) return refuse('conflicts with an existing record');
    }
    return null;
  },
});
module.exports.isSelfAssignment = isSelfAssignment;
