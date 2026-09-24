'use strict';
// Episodes of care, case closure, and moving a caseload when a worker leaves.
//
// Clients previously accumulated forever: there was no discharge workflow, so "active" meant "was entered
// at some point", and a funder asking for admissions and discharges in a quarter could not be answered.
// An episode is one period of service. A client may have several over the years; counts are per episode,
// which is what CalOMS and most grants actually ask for.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound, forbidden } = require('../http');
const { validate, paging } = require('../validate');
const { encrypt, decrypt, uuid } = require('../crypto');

const DISCHARGE_REASONS = ['completed', 'transferred', 'incarcerated', 'moved', 'lost_contact', 'declined', 'deceased', 'administrative', 'other'];

function present(e) {
  const o = { ...e };
  o.presenting_problem = e.presenting_problem_enc ? decrypt(e.presenting_problem_enc) : null;
  o.discharge_summary = e.discharge_summary_enc ? decrypt(e.discharge_summary_enc) : null;
  delete o.presenting_problem_enc; delete o.discharge_summary_enc;
  return o;
}

module.exports = (r) => {
  r.get('/api/clients/:id/episodes', auth.requireAuth, auth.requirePerm('episodes:read', 'episodes:write'), (ctx) => {
    auth.assertClientAccess(ctx, ctx.params.id);
    const rows = db.all(`SELECT e.*, o.display_name AS opened_by_name, cb.display_name AS closed_by_name, f.name AS funding_source
      FROM episodes e LEFT JOIN users o ON o.id=e.opened_by LEFT JOIN users cb ON cb.id=e.closed_by LEFT JOIN funding_sources f ON f.id=e.funding_source_id
      WHERE e.client_id=? ORDER BY e.opened_at DESC`, ctx.params.id);
    audit.log({ user: ctx.user, action: 'episode.list', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { count: rows.length } });
    return { episodes: rows.map(present) };
  });

  r.post('/api/clients/:id/episodes', auth.requireAuth, auth.requirePerm('episodes:write'), (ctx) => {
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id)) throw notFound('Client not found');
    auth.assertClientAccess(ctx, ctx.params.id);
    const v = validate(ctx.body, {
      opened_at: { type: 'date' }, funding_source_id: { type: 'string' }, referral_source: { type: 'string', maxLen: 120 },
      presenting_problem: { type: 'string', maxLen: 4000 },
    });
    if (db.one(`SELECT 1 FROM episodes WHERE client_id=? AND status='open'`, ctx.params.id)) throw badRequest('This client already has an open episode. Close it before opening another.');
    const id = uuid();
    db.transaction(() => {
      db.run(`INSERT INTO episodes(id,client_id,funding_source_id,opened_at,opened_by,referral_source,presenting_problem_enc) VALUES(?,?,?,?,?,?,?)`,
        id, ctx.params.id, v.funding_source_id || null, v.opened_at || new Date().toISOString().slice(0, 10), ctx.user.id, v.referral_source || null, v.presenting_problem ? encrypt(v.presenting_problem) : null);
      // Opening an episode is the admission, so the client is active from here: a returning client should
      // not stay "closed" (that status only exists paired with a discharge, which this episode undoes) and a
      // waitlisted person has now started services. "inactive" is a different, deliberate choice (on hold,
      // unreachable, incarcerated) with no discharge attached to clear, and a worker who set it did not stop
      // meaning it just because someone opened an episode — so it is left alone, as is "deceased".
      db.run(`UPDATE clients SET status=CASE WHEN status IN ('closed','waitlist') THEN 'active' ELSE status END, discharge_date=NULL, discharge_reason=NULL, updated_at=? WHERE id=?`, db.now(), ctx.params.id);
    });
    audit.log({ user: ctx.user, action: 'episode.open', entity: 'episode', entityId: id, clientId: ctx.params.id, ip: ctx.ip });
    ctx.status = 201; return { id };
  });

  // Discharge. This is the step that was missing entirely: it closes the episode, sets the client's status,
  // ends the assignments, and cleans up the open work that no longer has anyone to do it.
  r.post('/api/episodes/:id/close', auth.requireAuth, auth.requirePerm('episodes:write'), (ctx) => {
    const e = db.one(`SELECT * FROM episodes WHERE id=?`, ctx.params.id);
    if (!e) throw notFound('Episode not found');
    auth.assertClientAccess(ctx, e.client_id);
    if (e.status === 'closed') throw badRequest('This episode is already closed');
    const v = validate(ctx.body, {
      discharge_reason: { type: 'string', required: true, enum: DISCHARGE_REASONS },
      discharge_disposition: { type: 'string', maxLen: 200 }, discharge_summary: { type: 'string', maxLen: 8000 },
      closed_at: { type: 'date' }, keep_client_active: { type: 'boolean' },
    });
    const when = v.closed_at || new Date().toISOString().slice(0, 10);
    const openNotes = db.one(`SELECT COUNT(*) n FROM notes WHERE client_id=? AND status='draft' AND deleted_at IS NULL`, e.client_id).n;
    let endedAssignments = 0; let cancelledTasks = 0; let openReferrals = 0;
    db.transaction(() => {
      db.run(`UPDATE episodes SET status='closed', closed_at=?, closed_by=?, discharge_reason=?, discharge_disposition=?, discharge_summary_enc=?, updated_at=? WHERE id=?`,
        when, ctx.user.id, v.discharge_reason, v.discharge_disposition || null, v.discharge_summary ? encrypt(v.discharge_summary) : null, db.now(), e.id);
      if (!v.keep_client_active) {
        const status = v.discharge_reason === 'deceased' ? 'deceased' : 'closed';
        db.run(`UPDATE clients SET status=?, discharge_date=?, discharge_reason=?, updated_at=? WHERE id=?`, status, when, v.discharge_reason, db.now(), e.client_id);
        endedAssignments = db.run(`UPDATE assignments SET end_date=?, updated_at=? WHERE client_id=? AND (end_date IS NULL OR end_date > ?)`, when, db.now(), e.client_id, when).changes;
        // Open to-dos for a discharged client are nobody's work any more; leaving them makes every
        // worker's overdue list permanently wrong.
        cancelledTasks = db.run(`UPDATE tasks SET status='cancelled', updated_at=? WHERE client_id=? AND status IN ('open','in_progress')`, db.now(), e.client_id).changes;
      }
      openReferrals = db.one(`SELECT COUNT(*) n FROM referrals WHERE client_id=? AND status IN ('pending','contacted','accepted','waitlisted','scheduled')`, e.client_id).n;
    });
    audit.log({ user: ctx.user, action: 'episode.close', entity: 'episode', entityId: e.id, clientId: e.client_id, ip: ctx.ip, details: { reason: v.discharge_reason, ended_assignments: endedAssignments, cancelled_tasks: cancelledTasks } });
    return { ok: true, ended_assignments: endedAssignments, cancelled_tasks: cancelledTasks,
      warnings: [
        openNotes ? `${openNotes} note(s) are still unsigned for this client.` : null,
        openReferrals ? `${openReferrals} referral(s) are still open; record their outcome.` : null,
      ].filter(Boolean) };
  });

  // Re-admit: a person discharged in error, or back within days of leaving, is reopened on the same episode
  // rather than counted as a fresh admission. Someone genuinely returning after a gap gets a new episode
  // (POST /api/clients/:id/episodes), which is a new period of service.
  r.post('/api/episodes/:id/reopen', auth.requireAuth, auth.requirePerm('episodes:write'), (ctx) => {
    const e = db.one(`SELECT * FROM episodes WHERE id=?`, ctx.params.id);
    if (!e) throw notFound('Episode not found');
    auth.assertClientAccess(ctx, e.client_id);
    if (e.status !== 'closed') throw badRequest('This episode is still open');
    if (db.one(`SELECT 1 FROM episodes WHERE client_id=? AND status='open'`, e.client_id)) throw badRequest('This client already has an open episode. Discharge it first, or record this as that episode.');
    const { reason } = validate(ctx.body || {}, { reason: { type: 'string', maxLen: 300 } });
    db.transaction(() => {
      db.run(`UPDATE episodes SET status='open', closed_at=NULL, closed_by=NULL, discharge_reason=NULL, discharge_disposition=NULL, discharge_summary_enc=NULL, updated_at=? WHERE id=?`, db.now(), e.id);
      // Re-admission is an explicit act, so the client is active again whatever status the discharge left.
      db.run(`UPDATE clients SET status='active', discharge_date=NULL, discharge_reason=NULL, updated_at=? WHERE id=?`, db.now(), e.client_id);
      // The discharge ended the care team on its date; re-admission restores them. Failing that, the worker
      // who re-admits the person picks the case up themselves.
      if (e.closed_at) db.run(`UPDATE assignments SET end_date=NULL, updated_at=? WHERE client_id=? AND end_date=? AND ended_at IS NULL`, db.now(), e.client_id, e.closed_at);
      if (!db.one(`SELECT 1 FROM assignments WHERE client_id=? AND end_date IS NULL AND ended_at IS NULL`, e.client_id) && (auth.caseloadRestricted(ctx.user) || ['navigator', 'clinician'].includes(ctx.user.role))) {
        db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), e.client_id, ctx.user.id, 'primary', new Date().toISOString().slice(0, 10), ctx.user.id);
      }
    });
    audit.log({ user: ctx.user, action: 'episode.reopen', entity: 'episode', entityId: e.id, clientId: e.client_id, ip: ctx.ip, details: { reason: reason || undefined, was_discharged: e.discharge_reason } });
    return { ok: true };
  });

  // Program-wide view: who was admitted and discharged in a period, and who is waiting.
  r.get('/api/episodes', auth.requireAuth, auth.requirePerm('episodes:read', 'episodes:write'), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 500 });
    const cf = auth.caseloadFilter(ctx.user, 'e.client_id');
    const where = [cf.sql]; const params = [...cf.params];
    const status = ctx.query.get('status'); if (status && status !== 'all') { where.push('e.status=?'); params.push(status); }
    if (ctx.query.get('from')) { where.push('e.opened_at >= ?'); params.push(ctx.query.get('from')); }
    if (ctx.query.get('to')) { where.push('e.opened_at <= ?'); params.push(ctx.query.get('to')); }
    const w = 'WHERE ' + where.join(' AND ');
    const rows = db.all(`SELECT e.id, e.client_id, e.opened_at, e.closed_at, e.status, e.discharge_reason, e.discharge_disposition, c.client_code, c.status AS client_status, f.name AS funding_source
      FROM episodes e JOIN clients c ON c.id=e.client_id LEFT JOIN funding_sources f ON f.id=e.funding_source_id ${w} ORDER BY e.opened_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    // Counts for the whole period, not just the page: admissions (opened in the period) by where they stand
    // now, and discharges (closed in the period, whenever opened) by reason — what a funder asks for.
    const opened = db.one(`SELECT COUNT(*) n, SUM(e.status='open') open, SUM(e.status='closed') closed FROM episodes e JOIN clients c ON c.id=e.client_id ${w}`, ...params);
    const dWhere = [cf.sql, `e.status='closed'`]; const dParams = [...cf.params];
    if (ctx.query.get('from')) { dWhere.push('e.closed_at >= ?'); dParams.push(ctx.query.get('from')); }
    if (ctx.query.get('to')) { dWhere.push('e.closed_at <= ?'); dParams.push(ctx.query.get('to')); }
    const byReason = db.all(`SELECT COALESCE(e.discharge_reason,'not_recorded') k, COUNT(*) n FROM episodes e JOIN clients c ON c.id=e.client_id WHERE ${dWhere.join(' AND ')} GROUP BY 1 ORDER BY n DESC, k`, ...dParams);
    audit.log({ user: ctx.user, action: 'episode.list', ip: ctx.ip, details: { count: rows.length } });
    return { rows, total: opened.n, limit, offset,
      summary: { opened: opened.n, still_open: opened.open || 0, since_closed: opened.closed || 0, discharged: byReason.reduce((s, x) => s + x.n, 0), discharges_by_reason: byReason } };
  });

  // The waitlist, ordered by how long people have been waiting — the question a program asks every morning.
  r.get('/api/waitlist', auth.requireAuth, auth.requirePerm('clients:read'), (ctx) => {
    const cf = auth.caseloadFilter(ctx.user, 'c.id');
    const rows = db.all(`SELECT c.id, c.client_code, c.intake_date, c.risk_level, c.primary_substance, c.asam_level, c.referral_source,
        CAST(julianday('now') - julianday(COALESCE(c.intake_date, date(c.created_at))) AS INTEGER) AS days_waiting,
        (SELECT MAX(occurred_at) FROM interventions i WHERE i.client_id=c.id) AS last_contact
      FROM clients c WHERE c.deleted_at IS NULL AND c.status='waitlist' AND ${cf.sql}
      ORDER BY c.risk_level='critical' DESC, c.risk_level='high' DESC, days_waiting DESC LIMIT 500`, ...cf.params);
    const M = require('../clients-model');
    const full = rows.map(x => ({ ...x, ...M.summary(db.one(`SELECT * FROM clients WHERE id=?`, x.id), { deidentify: !auth.hasPerm(ctx.user, 'clients:read') }) }));
    audit.log({ user: ctx.user, action: 'waitlist.view', ip: ctx.ip, details: { count: rows.length } });
    return { rows: full, total: rows.length };
  });

  // Moving a caseload. When a navigator leaves, someone has to pick up every client they held; doing that
  // one client at a time through the assignments API is how clients get missed.
  r.post('/api/caseload/transfer', auth.requireAuth, auth.requirePerm('assignments:manage'), (ctx) => {
    const v = validate(ctx.body, {
      from_user_id: { type: 'string', required: true }, to_user_id: { type: 'string', required: true },
      role_on_case: { type: 'string', enum: ['primary', 'secondary', 'clinician', 'peer', 'supervisor'] },
      effective_date: { type: 'date' }, client_ids: { type: 'array', maxLen: 1000, of: 'string' },
      reassign_open_tasks: { type: 'boolean' }, reason: { type: 'string', maxLen: 300 },
    });
    if (v.from_user_id === v.to_user_id) throw badRequest('Choose a different worker to transfer to');
    const from = db.one(`SELECT id, display_name FROM users WHERE id=?`, v.from_user_id);
    const to = db.one(`SELECT id, display_name, is_active FROM users WHERE id=?`, v.to_user_id);
    if (!from || !to) throw notFound('Worker not found');
    if (!to.is_active) throw badRequest('That worker\'s account is not active');
    const when = v.effective_date || new Date().toISOString().slice(0, 10);
    // end_date is the departing worker's last day, inclusive, and access is granted through the end of that
    // day. Their last day is therefore the day before the receiving worker starts, or a transfer effective
    // today would leave both of them holding the client until midnight.
    const lastDay = new Date(Date.parse(when) - 86400000).toISOString().slice(0, 10);

    const scope = v.client_ids && v.client_ids.length
      ? { sql: `AND a.client_id IN (${v.client_ids.map(() => '?').join(',')})`, params: v.client_ids }
      : { sql: '', params: [] };
    const open = db.all(`SELECT a.* FROM assignments a JOIN clients c ON c.id=a.client_id
      WHERE a.user_id=? AND (a.end_date IS NULL OR a.end_date >= ?) AND a.ended_at IS NULL AND c.deleted_at IS NULL ${scope.sql}`, from.id, when, ...scope.params);

    let moved = 0; let tasks = 0; const skipped = [];
    db.transaction(() => {
      for (const a of open) {
        if (db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND (end_date IS NULL OR end_date >= ?)`, a.client_id, to.id, when)) {
          // The receiving worker already holds this client; just release the departing one.
          db.run(`UPDATE assignments SET end_date=?, updated_at=? WHERE id=?`, lastDay, db.now(), a.id);
          skipped.push({ client_id: a.client_id, reason: 'already assigned to the receiving worker' });
          continue;
        }
        db.run(`UPDATE assignments SET end_date=?, updated_at=? WHERE id=?`, lastDay, db.now(), a.id);
        db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,notes,created_by) VALUES(?,?,?,?,?,?,?)`,
          uuid(), a.client_id, to.id, v.role_on_case || a.role_on_case, when, v.reason ? `Transferred from ${from.display_name}: ${v.reason}` : `Transferred from ${from.display_name}`, ctx.user.id);
        moved++;
      }
      if (v.reassign_open_tasks !== 0 && moved) {
        const ids = open.map(a => a.client_id);
        if (ids.length) tasks = db.run(`UPDATE tasks SET assigned_to=?, updated_at=? WHERE assigned_to=? AND status IN ('open','in_progress') AND client_id IN (${ids.map(() => '?').join(',')})`, to.id, db.now(), from.id, ...ids).changes;
      }
    });
    audit.log({ user: ctx.user, action: 'caseload.transfer', entity: 'user', entityId: from.id, ip: ctx.ip, details: { to: to.id, clients: moved, tasks, skipped: skipped.length, effective_date: when } });
    return { ok: true, transferred: moved, tasks_reassigned: tasks, skipped, from: from.display_name, to: to.display_name };
  });

  r.get('/api/meta/discharge-reasons', auth.requireAuth, () => ({ discharge_reasons: DISCHARGE_REASONS }));
};
