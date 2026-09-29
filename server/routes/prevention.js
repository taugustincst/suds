'use strict';
// Group and community prevention events (1.17.0; server/prevention.js has the summary). SABG primary prevention
// is work with groups and communities, not services to a person, so an event has no client: a date, what kind
// of event, its CSAP strategy and IOM population category, hours, a headcount, the audience, where and the fund.
// Recorded by whoever records visits (interventions:read/write); an event is its worker's, or a manager's
// (records:manage-others), to change -- server/rules/prevention_events.js, which sync push applies too.
const crud = require('../crud');
const { encrypt, decrypt } = require('../crypto');

function encodeNotes(v) { if (v.notes !== undefined) { v.notes_enc = v.notes ? encrypt(v.notes) : null; delete v.notes; } }
function decodeNotes(row) {
  let notes = null;
  if (row.notes_enc) { try { notes = decrypt(row.notes_enc); } catch { notes = '[could not be read]'; } }
  return { ...row, notes, notes_enc: undefined };
}

module.exports = (r) => {
  crud.build(r, {
    table: 'prevention_events', entity: 'prevention_event', base: '/api/prevention-events', perm: 'interventions',
    dateCol: 'event_date', ownerCol: 'user_id', clientRequired: false, hasClient: false,
    joins: 'JOIN users u ON u.id=prevention_events.user_id LEFT JOIN funding_sources f ON f.id=prevention_events.funding_source_id',
    select: 'prevention_events.*, u.display_name AS worker, f.name AS funding_source',
    order: 'prevention_events.event_date DESC, prevention_events.created_at DESC',
    // shape, owner and canEdit: server/rules/prevention_events.js (crud.js reads them from there).
    filters: (ctx, where, params) => {
      for (const col of ['strategy', 'iom_category', 'event_type']) {
        const v = ctx.query.get(col); if (v) { where.push(`prevention_events.${col}=?`); params.push(v); }
      }
    },
    beforeInsert: (ctx, v) => {
      encodeNotes(v);
      // Nobody chose a fund (an API client left it out): the worker's default fund, else the programme's, as for a
      // visit. An explicit none (null) stays none.
      if (!('funding_source_id' in v)) { const f = require('./budget').defaultFundFor(v.user_id || ctx.user.id); if (f) v.funding_source_id = f; }
    },
    beforeUpdate: (ctx, v) => { encodeNotes(v); },
    afterLoad: (ctx, row) => decodeNotes(row),
  });
};
