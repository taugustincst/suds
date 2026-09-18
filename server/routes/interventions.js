'use strict';
const db = require('../db');
const crud = require('../crud');
const C = require('../constants');
const { uuid } = require('../crypto');

// The visit summary is clinical narrative about a named person, so it is stored encrypted like any other
// PHI field and decrypted on the way out.
function encodeSummary(v) { if (v.summary !== undefined) { v.summary_enc = v.summary ? require('../crypto').encrypt(v.summary) : null; delete v.summary; } }
function decodeSummary(row) {
  let summary = null;
  // A value that cannot be decrypted (a row written before this column was encrypted, or one whose key has
  // been rotated away) must not take the whole list down with it.
  if (row.summary_enc) { try { summary = require('../crypto').decrypt(row.summary_enc); } catch { summary = '[could not be read]'; } }
  return { ...row, summary, summary_enc: undefined };
}

module.exports = (r) => {
  crud.build(r, {
    table: 'interventions', entity: 'intervention', perm: 'interventions', clientRequired: false, dateCol: 'occurred_at', restrictOwner: true,
    joins: 'JOIN users u ON u.id=interventions.user_id LEFT JOIN clients c ON c.id=interventions.client_id LEFT JOIN funding_sources f ON f.id=interventions.funding_source_id',
    select: 'interventions.*, u.display_name AS worker, c.client_code, f.name AS funding_source',
    shape: {
      // Optional: community naloxone distribution and street outreach are services with no identified client.
      client_id: { type: 'string' }, user_id: { type: 'string' },
      type: { type: 'string', required: true, enum: C.INTERVENTION_TYPES }, occurred_at: { type: 'datetime', required: true },
      duration_minutes: { type: 'number', integer: true, min: 0, max: 1440 }, location: { type: 'string', enum: C.LOCATIONS }, modality: { type: 'string', enum: C.MODALITIES },
      outcome: { type: 'string', enum: C.OUTCOMES }, stage_of_change: { type: 'string', enum: C.STAGES }, naloxone_kits: { type: 'number', integer: true, min: 0 },
      fentanyl_strips: { type: 'number', integer: true, min: 0 }, funding_source_id: { type: 'string' }, cost: { type: 'number', min: 0 },
      summary: { type: 'string', maxLen: 2000 }, follow_up_due: { type: 'date' }, log_time: { type: 'boolean' }, time_category: { type: 'string', enum: C.TIME_CATEGORIES },
    },
    filters: (ctx, where, params) => { const t = ctx.query.get('type'); if (t) { where.push('interventions.type=?'); params.push(t); } },
    afterLoad: (ctx, row) => decodeSummary(row),
    beforeInsert: (ctx, v) => { v._log_time = v.log_time; delete v.log_time; v._time_category = v.time_category; delete v.time_category; encodeSummary(v); },
    beforeUpdate: (ctx, v) => { delete v.log_time; delete v.time_category; encodeSummary(v); },
    afterInsert: (ctx, row) => {
      // Optional automatic time entry + naloxone tracking on client
      if (row._log_time && row.duration_minutes > 0) {
        db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,funding_source_id,intervention_id,description) VALUES(?,?,?,?,?,?,?,?,?)`,
          uuid(), row.user_id, row.client_id, row.occurred_at.slice(0, 10), row.duration_minutes, row._time_category || 'direct_service', row.funding_source_id || null, row.id, row.type.replace(/_/g, ' '));
      }
      // Community distribution has no client record to update, and no client to follow up with.
      if (row.naloxone_kits > 0 && row.client_id) db.run(`UPDATE clients SET naloxone_provided=1, naloxone_last_date=?, updated_at=? WHERE id=?`, row.occurred_at.slice(0, 10), db.now(), row.client_id);
      if (row.follow_up_due && row.client_id) db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title,due_at,priority) VALUES(?,?,?,?,?,?,?)`,
        uuid(), row.client_id, row.user_id, ctx.user.id, `Follow up: ${row.type.replace(/_/g, ' ')}`, row.follow_up_due, 'normal');
    },
    canEdit: crud.ownerOrManager(),
  });
  r.get('/api/meta/constants', () => C);
};
