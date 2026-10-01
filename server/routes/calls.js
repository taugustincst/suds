'use strict';
const db = require('../db');
const crud = require('../crud');
const C = require('../constants');
const { encrypt, decrypt, uuid } = require('../crypto');
const { withClientName, SELECT: NAME_COLS } = require('../client-name');
const FU = require('../rules/follow-ups');

module.exports = (r) => {
  crud.build(r, {
    table: 'calls', entity: 'call', perm: 'calls', dateCol: 'started_at', clientRequired: false,
    joins: 'JOIN users u ON u.id=calls.user_id LEFT JOIN clients c ON c.id=calls.client_id',
    select: `calls.*, u.display_name AS worker, c.client_code, ${NAME_COLS}`,
    // shape, owner, canEdit and the outcome-list check: server/rules/calls.js (crud.js reads them from there).
    filters: (ctx, where, params) => {
      const method = ctx.query.get('method'); if (C.CONTACT_METHODS.includes(method)) { where.push('calls.method=?'); params.push(method); }
      if (ctx.query.get('crisis') === '1') where.push('calls.crisis=1');
      if (ctx.query.get('follow_up') === '1') where.push('calls.follow_up_needed=1');
    },
    beforeInsert: (ctx, v) => {
      const method = v.method || 'phone';
      // The column defaults to 'reached', which is a call's word: a text with no outcome was simply sent.
      if (method === 'text' && !v.outcome) v.outcome = 'sent';
      deriveCrisis(v); FU.deriveCallFollowUp(v, null); encAll(v);
    },
    beforeUpdate: (ctx, v, row) => { deriveCrisis(v); FU.deriveCallFollowUp(v, row); encAll(v); },
    afterInsert: (ctx, row) => {
      const what = row.method === 'text' ? 'text message' : 'call';
      if (row._log_time && row.duration_minutes > 0) {
        const te = uuid();
        db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,call_id,description_enc) VALUES(?,?,?,?,?,?,?,?)`,
          te, row.user_id, row.client_id || null, row.started_at.slice(0, 10), row.duration_minutes, 'direct_service', row.id, encrypt(`${row.direction} ${what}`));
        // The caller's, for separation of duties (rules/shared.js recordedOrChanged), as routes/interventions.js does.
        require('../audit').log({ user: ctx.user, action: 'time_entry.create', entity: 'time_entry', entityId: te, clientId: row.client_id || null, ip: ctx.ip, details: { call_id: row.id, for: row.user_id !== ctx.user.id ? row.user_id : undefined } });
      }
      // The call-back to-do, made, moved or cancelled by the one rule sync push also runs (server/rules/follow-ups.js).
      FU.reconcile('calls', row, null, ctx);
    },
    afterUpdate: (ctx, row, prev) => { FU.reconcile('calls', row, prev, ctx); },
    afterLoad: (ctx, x) => ({ ...withClientName(ctx, x), contact_name: x.contact_name_enc ? decrypt(x.contact_name_enc) : null, phone: x.phone_enc ? decrypt(x.phone_enc) : null, summary: x.summary_enc ? decrypt(x.summary_enc) : null, purpose: x.purpose_enc ? decrypt(x.purpose_enc) : null, contact_name_enc: undefined, phone_enc: undefined, summary_enc: undefined, purpose_enc: undefined }),
  });
  // "Crisis escalated" is a crisis whether or not the box was ticked; the crisis flag is what the reports
  // and the follow-up priority read, so it follows from the outcome rather than depending on a second click.
  function deriveCrisis(v) { if (v.outcome === 'crisis_escalated') v.crisis = 1; }
  // A "remind me to call back on" date is a follow-up whether or not the box was ticked too (1.22.0), and unticking
  // the box on a call that had one turns it off (1.23.0): server/rules/follow-ups.js deriveCallFollowUp, which sync
  // push applies to a device's calls too.
  function encAll(v) {
    // The purpose of a call ("detox bed", "MAT intake") names the client's situation, so it is encrypted like the
    // summary (the follow-up to-do's title reads it back from purpose_enc).
    for (const f of ['contact_name', 'phone', 'summary', 'purpose']) if (v[f] !== undefined) { v[`${f}_enc`] = v[f] === null ? null : encrypt(v[f]); delete v[f]; }
    v._log_time = v.log_time; delete v.log_time;
  }
};
