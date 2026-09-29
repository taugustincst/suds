'use strict';
// The rules for episodes of care, for POST /api/clients/:id/episodes, /api/episodes/:id/close and sync push.
// A client has one open episode at a time, and an episode cannot end before it began: reports count every
// episode opened in a period as closed in it or open at its end (server/publication-release.js relies on that).
// No route deletes an episode, so neither does a device's tombstone.
//
// Security review of 1.16.0, M6. Discharging a client ends their whole care team and cancels every open to-do, so
// once 1.16.0 gave most staff every client it was no longer "anyone on the care team" in practice. Discharging or
// re-admitting is now for the client's care team (an active assignment), the person who opened the episode, or
// records:manage-others -- the same rule at both doors, and for the care team a device's discharge ends
// (server/rules/assignments.js endedByEpisode). And a device changes an episode only as the REST routes do: it
// opens one, discharges it or re-admits it; the admission itself (when, how funded, referred and presenting) is
// kept as the office has it, since no route edits it and reports count admissions by it.
const db = require('../db');
const auth = require('../auth');
const { define, refuse, flag, notPermitted } = require('./core');

const ADMISSION = ['opened_at', 'funding_source_id', 'referral_source', 'presenting_problem_enc'];
const DISCHARGE = ['closed_at', 'discharge_reason', 'discharge_disposition', 'discharge_summary_enc', 'reopen_reason_enc'];
const mayDischarge = (user, row) => (row.opened_by === user.id || auth.hasPerm(user, 'records:manage-others')
  || db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND ${auth.activeAssignment()}`, row.client_id, user.id)
  ? null : notPermitted('Only the client\'s care team, the person who opened this episode, or a supervisor can discharge or re-admit it'));

module.exports = define({
  table: 'episodes',
  deviceColumns: ['status', 'reopen_reason_enc'], createdBy: ['opened_by'],
  tombstone: 'never', // an admission is never deleted (no REST route does); a discharge closes it
  fields: {
    opened_at: { type: 'date' }, funding_source_id: { type: 'string' }, referral_source: { type: 'string', maxLen: 120 },
    presenting_problem: { type: 'string', maxLen: 4000 },
    discharge_reason: { type: 'string', list: 'DISCHARGE_REASONS' }, discharge_disposition: { type: 'string', maxLen: 200 }, discharge_summary: { type: 'string', maxLen: 8000 },
    closed_at: { type: 'date' },
  },
  editableBy: mayDischarge,
  check(row, c) {
    const e = c.existing || {};
    const val = (k) => (row[k] !== undefined ? row[k] : e[k]);
    const out = [];
    const opened = val('opened_at'); const closed = val('closed_at');
    if (closed && opened && String(closed).slice(0, 10) < String(opened).slice(0, 10) && (!c.existing || row.closed_at !== undefined && row.closed_at !== e.closed_at || row.opened_at !== undefined && row.opened_at !== e.opened_at)) {
      out.push(refuse('has a value the office does not accept (it closes before it was opened)', { message: `The discharge date cannot be before the episode was opened (${String(opened).slice(0, 10)})` }));
    }
    // One open episode per client. A device that opened one offline while the office opened another has two
    // records of one admission: the device's lands (the work happened) and the office is told to reconcile them.
    const opening = (val('status') || 'open') === 'open' && (!c.existing || e.status !== 'open');
    if (opening) {
      const clientId = c.existing ? e.client_id : row.client_id;
      const closing = new Set(((c.session && c.session.tables.episodes) || []).filter(x => x && x.status === 'closed').map(x => x.id));
      const other = db.all(`SELECT id FROM episodes WHERE client_id=? AND status='open' AND id<>?`, clientId, row.id || '').filter(x => !closing.has(x.id));
      if (other.length) out.push(flag('was accepted, but the client already had an open episode at the office; a supervisor should close one of the two', { code: 'second_open_episode', message: 'This client already has an open episode. Close it before opening another.' }));
    }
    return out;
  },
  normalise(row, c) {
    const e = c.existing;
    const status = row.status !== undefined ? row.status : e ? e.status : 'open';
    if (!e) { row.closed_by = status === 'closed' ? c.user.id : null; return null; }
    const differs = (k) => row[k] !== undefined && String(row[k] ?? '') !== String(c.was(k) ?? '');
    let kept = ADMISSION.some(differs);
    for (const k of ADMISSION) row[k] = k.endsWith('_enc') ? undefined : e[k];
    if (e.status === 'open' && status === 'closed') row.closed_by = c.user.id; // a discharge
    else if (e.status === 'closed' && status === 'open') { for (const k of DISCHARGE.slice(0, 4)) row[k] = null; row.closed_by = null; } // a re-admission
    else { kept = kept || DISCHARGE.some(differs); for (const k of DISCHARGE) row[k] = k.endsWith('_enc') ? undefined : e[k]; row.closed_by = e.closed_by; }
    return kept ? flag('was accepted, but only as a discharge or re-admission: the rest of an episode is kept as the office has it (no route edits an admission)', { code: 'episode_kept' }) : null;
  },
});
module.exports.mayDischarge = mayDischarge;
