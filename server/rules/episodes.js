'use strict';
// The rules for episodes of care, for POST /api/clients/:id/episodes, /api/episodes/:id/close and sync push.
// A client has one open episode at a time, and an episode cannot end before it began: reports count every
// episode opened in a period as closed in it or open at its end (server/publication-release.js relies on that).
// No route deletes an episode, so neither does a device's tombstone.
const db = require('../db');
const { define, refuse, flag } = require('./core');

module.exports = define({
  table: 'episodes',
  tombstone: 'never', // an admission is never deleted (no REST route does); a discharge closes it
  fields: {
    opened_at: { type: 'date' }, funding_source_id: { type: 'string' }, referral_source: { type: 'string', maxLen: 120 },
    presenting_problem: { type: 'string', maxLen: 4000 },
    discharge_reason: { type: 'string', list: 'DISCHARGE_REASONS' }, discharge_disposition: { type: 'string', maxLen: 200 }, discharge_summary: { type: 'string', maxLen: 8000 },
    closed_at: { type: 'date' },
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
});
