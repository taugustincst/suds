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
const FATAL_APPLIED = 'overdose_event.fatal_outcome';
const FATAL_REVERTED = 'overdose_event.fatal_reverted';

// A fatal overdose is a discharge: it goes the same way as closing an episode with reason 'deceased'
// (server/routes/episodes.js) — the open episode closes on the day of the event, the client becomes
// deceased, the care team's assignments end and the client's open to-dos are cancelled. What it changed is
// kept in the audit entry (ids and the previous status fields; no clinical text), so that correcting the
// event — changing its outcome or deleting it — puts the client back exactly as they were.
function applyFatal(ctx, event) {
  if (!event.client_id) return;
  const c = db.one(`SELECT id, status, discharge_date, discharge_reason FROM clients WHERE id=?`, event.client_id);
  if (!c || c.status === 'deceased') return; // already recorded as deceased: nothing of ours to undo later
  const when = String(event.occurred_at).slice(0, 10);
  const details = { prior_status: c.status, prior_discharge_date: c.discharge_date || null, prior_discharge_reason: c.discharge_reason || null, episode_id: null, assignment_ids: [], task_ids: [] };
  db.transaction(() => {
    const ep = db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1`, c.id);
    if (ep) {
      db.run(`UPDATE episodes SET status='closed', closed_at=?, closed_by=?, discharge_reason='deceased', discharge_disposition=?, updated_at=? WHERE id=?`, when, ctx.user.id, 'Fatal overdose recorded', db.now(), ep.id);
      details.episode_id = ep.id;
    }
    db.run(`UPDATE clients SET status='deceased', discharge_date=?, discharge_reason='deceased', updated_at=? WHERE id=?`, when, db.now(), c.id);
    // [id, what it was before] pairs, so the undo restores each one as it stood.
    details.assignment_ids = db.all(`SELECT id, end_date FROM assignments WHERE client_id=? AND (end_date IS NULL OR end_date > ?)`, c.id, when).map(a => [a.id, a.end_date || null]);
    for (const [id] of details.assignment_ids) db.run(`UPDATE assignments SET end_date=?, updated_at=? WHERE id=?`, when, db.now(), id);
    details.task_ids = db.all(`SELECT id, status FROM tasks WHERE client_id=? AND status IN ('open','in_progress')`, c.id).map(t => [t.id, t.status]);
    for (const [id] of details.task_ids) db.run(`UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?`, db.now(), id);
  });
  audit.log({ user: ctx.user, action: FATAL_APPLIED, entity: 'overdose_event', entityId: event.id, clientId: c.id, ip: ctx.ip, details });
}

/** The fatal outcome this event applied and has not since undone, or null. */
function appliedFatal(eventId) {
  const last = db.one(`SELECT action, details FROM audit_log WHERE entity='overdose_event' AND entity_id=? AND action IN (?,?) ORDER BY id DESC LIMIT 1`, eventId, FATAL_APPLIED, FATAL_REVERTED);
  if (!last || last.action !== FATAL_APPLIED) return null;
  try { return JSON.parse(last.details); } catch { return null; }
}

function revertFatal(ctx, event) {
  if (!event.client_id) return;
  const applied = appliedFatal(event.id);
  if (!applied) return; // this event did not make the client deceased (they already were, or it came from a device)
  // Another fatal report for the same person still stands: the client stays deceased.
  if (db.one(`SELECT 1 FROM overdose_events WHERE client_id=? AND kind='fatal' AND id<>?`, event.client_id, event.id)) return;
  const c = db.one(`SELECT id, status FROM clients WHERE id=?`, event.client_id);
  // Someone has changed the status by hand since; theirs is the later decision.
  if (!c || c.status !== 'deceased') return;
  let reopened = null;
  db.transaction(() => {
    db.run(`UPDATE clients SET status=?, discharge_date=?, discharge_reason=?, updated_at=? WHERE id=?`, applied.prior_status || 'active', applied.prior_discharge_date || null, applied.prior_discharge_reason || null, db.now(), c.id);
    const ep = applied.episode_id && db.one(`SELECT id, status FROM episodes WHERE id=?`, applied.episode_id);
    if (ep && ep.status === 'closed' && !db.one(`SELECT 1 FROM episodes WHERE client_id=? AND status='open'`, c.id)) {
      db.run(`UPDATE episodes SET status='open', closed_at=NULL, closed_by=NULL, discharge_reason=NULL, discharge_disposition=NULL, discharge_summary_enc=NULL, updated_at=? WHERE id=?`, db.now(), ep.id);
      reopened = ep.id;
    }
    for (const [id, endDate] of applied.assignment_ids || []) db.run(`UPDATE assignments SET end_date=?, updated_at=? WHERE id=? AND ended_at IS NULL`, endDate, db.now(), id);
    for (const [id, status] of applied.task_ids || []) db.run(`UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status='cancelled'`, status, db.now(), id);
  });
  audit.log({ user: ctx.user, action: FATAL_REVERTED, entity: 'overdose_event', entityId: event.id, clientId: c.id, ip: ctx.ip, details: { restored_status: applied.prior_status || 'active', reopened_episode: reopened } });
}
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
      // Required: an empty form saved by accident used to become a countable reversal.
      kind: { type: 'string', enum: KINDS, required: true }, substances: { type: 'string', maxLen: 200 },
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
      if (v.substances !== undefined) { v.substances_enc = v.substances ? encrypt(v.substances) : null; delete v.substances; }
      if (v.kind === 'fatal') v.survived = 0;
      if (v.naloxone_doses > 0) v.naloxone_used = 1;
    },
    beforeUpdate: (ctx, v) => {
      if (v.notes !== undefined) { v.notes_enc = v.notes ? encrypt(v.notes) : null; delete v.notes; }
      if (v.substances !== undefined) { v.substances_enc = v.substances ? encrypt(v.substances) : null; delete v.substances; }
      if (v.kind === 'fatal') v.survived = 0;
    },
    afterLoad: (ctx, row) => ({ ...row, notes: row.notes_enc ? decrypt(row.notes_enc) : null, substances: row.substances_enc ? decrypt(row.substances_enc) : null, notes_enc: undefined, substances_enc: undefined }),
    afterInsert: (ctx, row) => {
      // Keep the client's own summary fields in step, so the record a worker reads at the top of a file
      // still matches the events underneath it.
      if (!row.client_id) return;
      const day = String(row.occurred_at).slice(0, 10);
      db.run(`UPDATE clients SET overdose_history=1, last_overdose_date=CASE WHEN last_overdose_date IS NULL OR last_overdose_date < ? THEN ? ELSE last_overdose_date END, updated_at=? WHERE id=?`, day, day, db.now(), row.client_id);
      if (row.kind === 'fatal') applyFatal(ctx, row);
    },
    afterUpdate: (ctx, row, prev) => {
      const wasFatal = prev.kind === 'fatal' && prev.client_id;
      const isFatal = row.kind === 'fatal' && row.client_id;
      const sameClient = prev.client_id === row.client_id;
      if (wasFatal && (!isFatal || !sameClient)) revertFatal(ctx, prev);
      if (isFatal && (!wasFatal || !sameClient)) {
        const day = String(row.occurred_at).slice(0, 10);
        db.run(`UPDATE clients SET overdose_history=1, last_overdose_date=CASE WHEN last_overdose_date IS NULL OR last_overdose_date < ? THEN ? ELSE last_overdose_date END, updated_at=? WHERE id=?`, day, day, db.now(), row.client_id);
        applyFatal(ctx, row);
      }
    },
    beforeDelete: (ctx, row) => { if (row.kind === 'fatal') revertFatal(ctx, row); },
    canEdit: crud.ownerOrManager('reported_by'),
  });

  r.get('/api/meta/overdose-options', auth.requireAuth, () => ({ kinds: KINDS, administered_by: ADMINISTERED_BY }));
};
