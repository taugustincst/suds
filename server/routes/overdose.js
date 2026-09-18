'use strict';
// Overdose and reversal events. Every SUD funder asks how many overdoses and how many naloxone reversals
// happened in a period; the only record was two boolean columns on the client, which cannot answer that
// and cannot record a community event at all.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const crud = require('../crud');
const { decrypt, encrypt } = require('../crypto');

const KINDS = ['overdose', 'reversal', 'fatal'];
const ADMINISTERED_BY = ['bystander', 'first_responder', 'staff', 'self', 'family', 'unknown'];

module.exports = (r) => {
  crud.build(r, {
    table: 'overdose_events', entity: 'overdose_event', base: '/api/overdose-events', perm: 'overdose',
    dateCol: 'occurred_at', ownerCol: 'reported_by', clientRequired: false, creatorCol: 'reported_by',
    joins: 'LEFT JOIN clients c ON c.id=overdose_events.client_id LEFT JOIN users u ON u.id=overdose_events.reported_by LEFT JOIN funding_sources f ON f.id=overdose_events.funding_source_id',
    select: 'overdose_events.*, c.client_code, u.display_name AS reporter, f.name AS funding_source',
    shape: {
      // client_id stays optional: a bystander reversal reported by an outreach worker has no client.
      client_id: { type: 'string' }, occurred_at: { type: 'datetime', required: true },
      kind: { type: 'string', enum: KINDS }, substances: { type: 'string', maxLen: 200 },
      naloxone_used: { type: 'boolean' }, naloxone_doses: { type: 'number', integer: true, min: 0, max: 20 },
      administered_by: { type: 'string', enum: ADMINISTERED_BY }, ems_called: { type: 'boolean' },
      hospitalized: { type: 'boolean' }, survived: { type: 'boolean' },
      location_type: { type: 'string', maxLen: 60 }, city: { type: 'string', maxLen: 100 },
      funding_source_id: { type: 'string' }, notes: { type: 'string', maxLen: 4000 },
    },
    filters: (ctx, where, params) => {
      const kind = ctx.query.get('kind'); if (kind && kind !== 'all') { where.push('overdose_events.kind=?'); params.push(kind); }
      if (ctx.query.get('community') === '1') where.push('overdose_events.client_id IS NULL');
      if (ctx.query.get('naloxone') === '1') where.push('overdose_events.naloxone_used=1');
    },
    beforeInsert: (ctx, v) => {
      if (v.notes !== undefined) { v.notes_enc = v.notes ? encrypt(v.notes) : null; delete v.notes; }
      if (v.kind === 'fatal') v.survived = 0;
      if (v.naloxone_doses > 0) v.naloxone_used = 1;
    },
    beforeUpdate: (ctx, v) => {
      if (v.notes !== undefined) { v.notes_enc = v.notes ? encrypt(v.notes) : null; delete v.notes; }
      if (v.kind === 'fatal') v.survived = 0;
    },
    afterLoad: (ctx, row) => ({ ...row, notes: row.notes_enc ? decrypt(row.notes_enc) : null, notes_enc: undefined }),
    afterInsert: (ctx, row) => {
      // Keep the client's own summary fields in step, so the record a worker reads at the top of a file
      // still matches the events underneath it.
      if (!row.client_id) return;
      const day = String(row.occurred_at).slice(0, 10);
      db.run(`UPDATE clients SET overdose_history=1, last_overdose_date=CASE WHEN last_overdose_date IS NULL OR last_overdose_date < ? THEN ? ELSE last_overdose_date END, updated_at=? WHERE id=?`, day, day, db.now(), row.client_id);
      if (row.kind === 'fatal') db.run(`UPDATE clients SET status='deceased', updated_at=? WHERE id=?`, db.now(), row.client_id);
    },
    canEdit: crud.ownerOrManager('reported_by'),
  });

  r.get('/api/meta/overdose-options', auth.requireAuth, () => ({ kinds: KINDS, administered_by: ADMINISTERED_BY }));
};
