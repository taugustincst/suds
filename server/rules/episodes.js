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
//
// Security review of 1.16.2, M1. Opening an episode is not standing on the case: the opener off the care team may
// close their own episode, but its discharge ends only their own part (routes/episodes.js /close,
// assignments.js endedByEpisode). Ending the rest of the team, cancelling their to-dos and discharging the client
// are for the care team (an active assignment) or records:manage-others (`standing`), and a second open episode
// from a device is refused, as over REST, unless it is theirs.
const db = require('../db');
const auth = require('../auth');
const { define, refuse, flag, notPermitted } = require('./core');

const ADMISSION = ['opened_at', 'funding_source_id', 'referral_source', 'presenting_problem_enc'];
const DISCHARGE = ['closed_at', 'discharge_reason', 'discharge_disposition', 'discharge_summary_enc', 'reopen_reason_enc'];
/** On the client's care team, or a manager: who may end the team with a discharge. */
const standing = (user, clientId) => auth.hasPerm(user, 'records:manage-others')
  || !!db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND ${auth.activeAssignment()}`, clientId, user.id);
/** Does this pushed row discharge an episode the office holds open? */
const closes = (x) => !!x && x.status === 'closed' && typeof x.id === 'string' && !!db.one(`SELECT 1 FROM episodes WHERE id=? AND status='open'`, x.id);
const mayDischarge = (user, row) => (row.opened_by === user.id || standing(user, row.client_id)
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
  // A discharge is applied before an admission in the same push, so the one-open-episode check sees what landed.
  order: (rows) => { const first = new Set(rows.filter(closes)); return [...first, ...rows.filter(r => !first.has(r))]; },
  // The discharges and re-admissions that landed, for the care team they end or restore (assignments.js endedByEpisode).
  afterApply(row, o, c) {
    const e = c.existing; const st = c.session.state.assignments; if (!e || !st) return;
    const now = row.status !== undefined ? row.status : e.status;
    const k = st.episodes.get(e.client_id) || { closed: new Set(), reopened: new Set() }; st.episodes.set(e.client_id, k);
    if (e.status === 'open' && now === 'closed' && (row.closed_at || e.closed_at)) k.closed.add(row.closed_at || e.closed_at);
    else if (e.status === 'closed' && now === 'open' && e.closed_at) k.reopened.add(e.closed_at);
  },
  check(row, c) {
    const e = c.existing || {};
    const val = (k) => (row[k] !== undefined ? row[k] : e[k]);
    const out = [];
    const opened = val('opened_at'); const closed = val('closed_at');
    if (closed && opened && String(closed).slice(0, 10) < String(opened).slice(0, 10) && (!c.existing || row.closed_at !== undefined && row.closed_at !== e.closed_at || row.opened_at !== undefined && row.opened_at !== e.opened_at)) {
      out.push(refuse('has a value the office does not accept (it closes before it was opened)', { message: `The discharge date cannot be before the episode was opened (${String(opened).slice(0, 10)})` }));
    }
    // One open episode per client. A device that opened one offline while the office opened another has two
    // records of one admission: the care team's device's lands (the work happened) and the office is told to
    // reconcile them. A close earlier in the same push counts only if it landed (the closes go first: `order`), and
    // a re-admission while another episode is open is refused, as POST /reopen refuses it (security review of
    // 1.16.3, N2 and N4).
    const opening = (val('status') || 'open') === 'open' && (!c.existing || e.status !== 'open');
    if (opening) {
      const clientId = c.existing ? e.client_id : row.client_id;
      const other = db.all(`SELECT id FROM episodes WHERE client_id=? AND status='open' AND id<>?`, clientId, row.id || '');
      if (other.length && c.existing) out.push(refuse('not permitted: the client already has another open episode at the office; discharge it before re-admitting this one', { message: 'This client already has an open episode. Discharge it first, or record this as that episode.' }));
      else if (other.length && !standing(c.user, clientId)) out.push(refuse('not permitted: the client already has an open episode at the office, and only their care team or a supervisor can open another', { message: 'This client already has an open episode. Close it before opening another.' }));
      else if (other.length) out.push(flag('was accepted, but the client already had an open episode at the office; a supervisor should close one of the two', { code: 'second_open_episode', message: 'This client already has an open episode. Close it before opening another.' }));
    }
    // An admission and discharge recorded together, already over, are the care team's to record: from anyone else,
    // only one of today's (a contact opened and closed offline), never a past one reports would count (N4).
    const recent = require('../local-date').addDays(require('../local-date').today(), -1);
    if (!c.existing && val('status') === 'closed' && [opened, closed].some(d => d && String(d).slice(0, 10) < recent) && !standing(c.user, row.client_id)) {
      out.push(refuse('not permitted: only the client\'s care team or a supervisor can record a past admission and discharge', { status: 403, message: 'Only the client\'s care team or a supervisor can record a past admission and discharge' }));
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
Object.assign(module.exports, { mayDischarge, standing });
