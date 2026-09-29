'use strict';
// The rules for assignments: who is on a client's care team. Managing the team is assignments:manage, with the
// exceptions that mirror the REST routes that change a team without it: a worker who creates a client is put on it
// as primary (POST /api/clients, and a device does that offline), and a discharge ends the care team and a
// re-admission restores it (POST /api/episodes/:id/close and /reopen).
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { define, refuse, notPermitted } = require('./core');

/**
 * An assignment a worker without assignments:manage may still push: their own (user_id is theirs, or a
 * device-minted id about to be remapped to them), as primary, on a client the same push creates -- one the office
 * has not seen, created on the device by this worker (a device-minted creator id is remapped to the syncing user
 * when the client row lands). Not on a client already at the office, even one they created: that let a worker a
 * supervisor had taken off the case put themselves back on it at any time (security review of 1.16.3, N2).
 */
function isSelfAssignment(raw, user, knownUsers, batchClients) {
  if (!raw || typeof raw.client_id !== 'string') return false;
  if (raw.user_id && raw.user_id !== user.id && knownUsers.has(raw.user_id)) return false;
  if ((raw.role_on_case || 'primary') !== 'primary') return false;
  if (db.one(`SELECT 1 FROM clients WHERE id=?`, raw.client_id)) return false;
  const inBatch = batchClients.get(raw.client_id);
  return !!inBatch && (!inBatch.created_by || inBatch.created_by === user.id || !knownUsers.has(inBatch.created_by));
}

const ROLES = ['primary', 'secondary', 'clinician', 'peer', 'supervisor'];

/**
 * An existing assignment whose only change is the end date a discharge (or re-admission) in this push set. The
 * discharges and re-admissions are those that landed (server/rules/episodes.js afterApply records them; these rows
 * wait for them: `later`), never those a push only asked for (security review of 1.16.3, N2). Another worker's
 * part is ended only by the client's care team or a manager (episodes.js standing, as it stood before the push);
 * an opener off the team ends their own, as POST /api/episodes/:id/close does.
 */
function endedByEpisode(raw, s) {
  if (!raw || typeof raw.client_id !== 'string' || !auth.hasPerm(s.user, 'episodes:write')) return false;
  const e = db.one(`SELECT * FROM assignments WHERE id=?`, raw.id);
  if (!e || e.client_id !== raw.client_id) return false;
  const same = (k) => raw[k] === undefined || String(raw[k] ?? '') === String(e[k] ?? '');
  const k = s.state.assignments.episodes.get(e.client_id);
  if (!k || !['user_id', 'role_on_case', 'start_date', 'ended_at'].every(same)) return false;
  if (raw.end_date === null) return !!e.end_date && k.reopened.has(e.end_date); // a re-admission restores the team
  return k.closed.has(raw.end_date) && (e.user_id === s.user.id || s.state.assignments.standing(e.client_id));
}
/** A worker's own active assignment sent again as it is (a retry, or a device re-offering it): a no-op, taken. */
function ownAsItIs(raw, s) {
  const e = raw && db.one(`SELECT * FROM assignments WHERE id=? AND user_id=? AND end_date IS NULL AND ended_at IS NULL`, raw.id, s.user.id);
  const same = (k) => raw[k] === undefined || String(raw[k] ?? '') === String(e[k] ?? '');
  return !!e && ['client_id', 'role_on_case', 'start_date', 'end_date', 'ended_at'].every(same) && (raw.user_id === undefined || raw.user_id === s.user.id || !s.knownUsers.has(raw.user_id));
}
/** A re-admission that landed, and left nobody on the team: the worker who re-admitted picks the case up (/reopen). */
function readmitsSelf(raw, s) {
  const k = s.state.assignments.episodes.get(raw && raw.client_id);
  return !!k && k.reopened.size > 0 && !db.one(`SELECT 1 FROM assignments WHERE id=?`, raw.id) && (!raw.user_id || raw.user_id === s.user.id || !s.knownUsers.has(raw.user_id))
    && (raw.role_on_case || 'primary') === 'primary' && !db.one(`SELECT 1 FROM assignments WHERE client_id=? AND ${auth.activeAssignment()}`, raw.client_id);
}

module.exports = define({
  table: 'assignments',
  deviceColumns: ['end_date', 'ended_at'], createdBy: ['created_by'],
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
    // The clients whose episodes this push changes, and whether this worker stands on each before any of it lands.
    const touched = new Set();
    for (const x of s.tables.episodes || []) {
      if (!x || typeof x.id !== 'string') continue;
      const o = db.one(`SELECT client_id FROM episodes WHERE id=?`, x.id); const id = o ? o.client_id : x.client_id;
      if (typeof id === 'string') touched.add(id);
    }
    const standing = new Map([...touched].map(id => [id, require('./episodes').standing(s.user, id)]));
    s.state.assignments = { selfForClient, selfIds, touched, episodes: new Map(),
      standing: (id) => { if (!standing.has(id)) standing.set(id, require('./episodes').standing(s.user, id)); return standing.get(id); } };
  },
  // The team of a client whose episode this push changes waits for that change to land (or not).
  later: (raw, s) => !!raw && typeof raw.id === 'string' && !s.state.assignments.selfIds.has(raw.id) && s.state.assignments.touched.has(raw.client_id),
  // Also the care team a discharge ends (or a re-admission restores) along with the episode, which the same push
  // carries: POST /api/episodes/:id/close and /reopen do that with episodes:write alone.
  permitsWithoutWritePerm: (raw, s) => s.state.assignments.selfIds.has(raw.id) || endedByEpisode(raw, s) || readmitsSelf(raw, s) || ownAsItIs(raw, s),
  // A self-assignment is what puts the new client on the caseload, so it cannot be judged by it.
  outsideCaseload: (raw, c) => c.session.state.assignments.selfIds.has(raw.id),
  authorise(row, c) {
    // Putting someone on a care team is how they reach the record, so it is for a client the actor can reach
    // (or anyone, with clients:all): assignments:manage let its holder put themselves on any client, which undid
    // a deny of clients:all (security review of 1.15.3, M1). Sync push also checks the caseload before this; a
    // worker's own assignment on a client they just created (selfIds) is what puts it on their caseload.
    // Restoring an ended assignment puts its worker back on the case just as adding one does.
    const restoring = c.existing && (c.existing.end_date || c.existing.ended_at) && row.end_date === null && !(row.ended_at !== undefined ? row.ended_at : c.existing.ended_at);
    if ((!c.existing || restoring) && !(c.via === 'sync' && c.session.state.assignments.selfIds.has(row.id)) && !auth.hasPerm(c.user, 'clients:all') && !auth.canAccessClient(c.user, row.client_id || c.existing.client_id)) {
      return notPermitted('This client is not on your caseload, so you cannot change who works with them. Ask a supervisor who can see every client.', 'not on caseload');
    }
    // A matching open assignment under another id (the office's own, from a sync before this rule existed)
    // makes the device's row a duplicate, refused for good so the device stops offering it.
    if (c.via === 'sync' && !c.existing && c.session.state.assignments.selfIds.has(row.id)) {
      const dup = db.one(`SELECT id FROM assignments WHERE client_id=? AND user_id=? AND role_on_case=? AND id<>? AND ${auth.activeAssignment()}`, row.client_id, c.user.id, row.role_on_case || 'primary', row.id);
      if (dup) return refuse('conflicts with an existing record');
    }
    return null;
  },
  // Who a push puts on a care team, takes off it or puts back, in the audit trail as the REST routes record it.
  afterApply(row, o, c) {
    const e = c.existing; const val = (k) => (row[k] !== undefined ? row[k] : e && e[k]);
    const was = !!e && !!(e.end_date || e.ended_at); const ended = !!(val('end_date') || val('ended_at'));
    const action = !e ? 'assignment.create' : was && !ended ? 'assignment.restore' : !was && ended ? 'assignment.end' : null;
    if (action) audit.log({ user: c.user, action, entity: 'assignment', entityId: row.id, clientId: val('client_id'), ip: 'device', details: { user_id: val('user_id'), role: val('role_on_case') || 'primary', via: 'sync' } });
  },
});
module.exports.isSelfAssignment = isSelfAssignment;
