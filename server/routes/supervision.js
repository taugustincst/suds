'use strict';
// What a supervisor owes attention to. The dashboard only ever counted the signed-in user's own unsigned
// notes (author_id = me), so a supervisor had no way to see what their team had left unfinished, and
// staff time had no approval step at all despite expenditures having one.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, notFound, forbidden } = require('../http');
const { validate } = require('../validate');
const { decrypt, encrypt } = require('../crypto');

/** Staff this user supervises: those who name them, plus everyone if they hold the given "see all" permission. */
function supervisedIds(user, allPerm = 'clients:all') {
  if (auth.hasPerm(user, allPerm)) return null; // null means "no restriction"
  return db.all(`SELECT id FROM users WHERE supervisor_id=?`, user.id).map(u => u.id);
}
function staffFilter(user, col, allPerm) {
  const ids = supervisedIds(user, allPerm);
  if (ids === null) return { sql: '1=1', params: [] };
  if (!ids.length) return { sql: '1=0', params: [] };
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

module.exports = (r) => {
  // One place that answers "what is waiting on me?" for a supervisor.
  r.get('/api/supervision/queue', auth.requireAuth, auth.requirePerm('notes:cosign', 'time:approve', 'assignments:manage'), (ctx) => {
    const sf = staffFilter(ctx.user, 'n.author_id');
    // Time is scoped by time:all, not clients:all: finance approves staff time but supervises nobody, so
    // scoping its queue to "staff who name me as supervisor" left it permanently empty while the approve
    // button itself worked.
    const tf = staffFilter(ctx.user, 't.user_id', 'time:all');
    const lockDays = Number(db.getSetting('note_lock_days', '3'));
    const staleBefore = new Date(Date.now() - lockDays * 86400000).toISOString();

    const out = {};
    if (auth.hasPerm(ctx.user, 'notes:cosign')) {
      // A note is here because the author's account requires countersignature, or because the author asked
      // for a review of this one (cosign_requested) -- a navigator flagging a hard contact is a request
      // to any supervisor, so the supervised-staff filter does not narrow those.
      out.awaiting_cosignature = db.all(`SELECT n.id, n.client_id, n.kind, n.occurred_at, n.signed_at, n.title_enc, n.cosign_requested, u.display_name AS author, c.client_code
        FROM notes n JOIN users u ON u.id=n.author_id JOIN clients c ON c.id=n.client_id
        WHERE n.deleted_at IS NULL AND n.status<>'draft' AND n.cosigned_at IS NULL AND n.author_id<>? AND ((n.cosign_required=1 AND ${sf.sql}) OR n.cosign_requested=1)
        ORDER BY n.signed_at LIMIT 100`, ctx.user.id, ...sf.params)
        .map(x => ({ ...x, title: x.title_enc ? decrypt(x.title_enc) : null, title_enc: undefined }));
      out.unsigned_notes = db.all(`SELECT n.id, n.client_id, n.kind, n.occurred_at, n.created_at, u.display_name AS author, c.client_code,
          (n.created_at < ?) AS overdue
        FROM notes n JOIN users u ON u.id=n.author_id JOIN clients c ON c.id=n.client_id
        WHERE n.deleted_at IS NULL AND n.status='draft' AND ${sf.sql}
        ORDER BY n.created_at LIMIT 100`, staleBefore, ...sf.params);
    }
    if (auth.hasPerm(ctx.user, 'time:approve')) {
      out.time_awaiting_approval = db.all(`SELECT t.id, t.user_id, t.work_date, t.minutes, t.category, t.billable, t.submitted_at, u.display_name AS worker, c.client_code, f.name AS funding_source
        FROM time_entries t JOIN users u ON u.id=t.user_id LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN funding_sources f ON f.id=t.funding_source_id
        WHERE t.status='submitted' AND t.user_id<>? AND ${tf.sql} ORDER BY t.work_date LIMIT 200`, ctx.user.id, ...tf.params);
      out.time_totals = db.one(`SELECT COUNT(*) entries, COALESCE(SUM(minutes),0) minutes FROM time_entries t WHERE t.status='submitted' AND t.user_id<>? AND ${tf.sql}`, ctx.user.id, ...tf.params);
    }
    if (auth.hasPerm(ctx.user, 'referrals:read')) {
      const cf = auth.caseloadFilter(ctx.user, 'r.client_id');
      out.referrals_awaiting_outcome = db.all(`SELECT r.id, r.client_id, r.referred_at, r.status, res.name AS resource, c.client_code
        FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN clients c ON c.id=r.client_id
        WHERE r.outcome_recorded_at IS NULL AND r.status NOT IN ('pending','closed') AND ${cf.sql} ORDER BY r.referred_at LIMIT 100`, ...cf.params);
      out.referrals_consent_revoked = db.all(`SELECT r.id, r.client_id, res.name AS resource, c.client_code FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN clients c ON c.id=r.client_id WHERE r.consent_revoked=1 AND r.status NOT IN ('closed','declined_by_client','declined_by_provider') AND ${cf.sql} LIMIT 100`, ...cf.params);
    }
    if (auth.hasPerm(ctx.user, 'audit:read')) out.breakglass_unacknowledged = db.one(`SELECT COUNT(*) n FROM breakglass_events WHERE acknowledged_at IS NULL`).n;
    audit.log({ user: ctx.user, action: 'supervision.queue', ip: ctx.ip, details: { cosign: out.awaiting_cosignature?.length || 0, time: out.time_awaiting_approval?.length || 0 } });
    return out;
  });

  // ---- break-glass review ----
  // Every emergency access to a clinical note lands here until someone with audit rights has looked at it
  // and said so. Acknowledging does not approve anything; it records that the review happened.
  r.get('/api/supervision/breakglass', auth.requireAuth, auth.requirePerm('audit:read'), (ctx) => {
    const all = ctx.query.get('all') === '1';
    const rows = db.all(`SELECT b.*, u.display_name AS user_name, u.role AS user_role, c.client_code, a.display_name AS acknowledged_by_name
      FROM breakglass_events b JOIN users u ON u.id=b.user_id LEFT JOIN clients c ON c.id=b.client_id LEFT JOIN users a ON a.id=b.acknowledged_by
      WHERE ${all ? '1=1' : 'b.acknowledged_at IS NULL'} ORDER BY b.at DESC LIMIT 200`)
      .map(b => { let reason = ''; try { reason = b.reason_enc ? decrypt(b.reason_enc) : ''; } catch { reason = '[could not be read]'; } return { ...b, reason, reason_enc: undefined }; });
    audit.log({ user: ctx.user, action: 'breakglass.review', ip: ctx.ip, details: { count: rows.length, all } });
    return { rows, unacknowledged: db.one(`SELECT COUNT(*) n FROM breakglass_events WHERE acknowledged_at IS NULL`).n };
  });
  r.post('/api/supervision/breakglass/:id/ack', auth.requireAuth, auth.requirePerm('audit:read'), (ctx) => {
    const b = db.one(`SELECT * FROM breakglass_events WHERE id=?`, ctx.params.id);
    if (!b) throw notFound('Break-glass event not found');
    if (b.acknowledged_at) throw badRequest('This event has already been reviewed');
    // Reviewing your own emergency access is not a review.
    if (b.user_id === ctx.user.id) throw forbidden('You cannot acknowledge your own break-glass access');
    // The reviewer may find the access was not justified: that is a possible breach, and it goes to the
    // incident register as a draft (with the reviewer's note, encrypted) rather than ending at "reviewed".
    const v = validate(ctx.body || {}, { concern: { type: 'boolean' }, note: { type: 'string', maxLen: 2000 } });
    if (v.concern && String(v.note || '').trim().length < 10) throw badRequest('Say what is wrong with this access (at least 10 characters); it opens a draft incident');
    db.run(`UPDATE breakglass_events SET acknowledged_by=?, acknowledged_at=?, updated_at=? WHERE id=?`, ctx.user.id, db.now(), db.now(), b.id);
    const incident = v.concern ? require('../incidents').draft({ source: 'breakglass', sourceRef: b.id, title: 'Emergency access flagged at review', description: v.note, user: ctx.user }) : null;
    if (incident && b.client_id) require('../incidents').linkClient(incident, b.client_id);
    audit.log({ user: ctx.user, action: 'breakglass.acknowledge', entity: 'breakglass_event', entityId: b.id, clientId: b.client_id, ip: ctx.ip, details: { accessed_by: b.user_id, note_id: b.note_id || undefined, incident: incident || undefined } });
    return { ok: true, incident };
  });

  // ---- staff time approval (mirrors the expenditure separation of duties) ----
  // Returned time with no reason leaves the worker guessing what to fix, the same as a rejected expenditure.
  const NO_REASON = 'Say why this time is being returned, so the worker knows what to correct';
  function loadEntry(ctx, id) {
    const t = db.one(`SELECT * FROM time_entries WHERE id=?`, id);
    if (!t) throw notFound('Time entry not found');
    return t;
  }

  r.post('/api/time/:id/submit', auth.requireAuth, auth.requirePerm('time:write'), (ctx) => {
    const t = loadEntry(ctx, ctx.params.id);
    if (t.user_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'time:all')) throw forbidden('Only the worker can submit their own time');
    if (t.status !== 'draft' && t.status !== 'rejected') throw badRequest('This time entry has already been submitted');
    db.run(`UPDATE time_entries SET status='submitted', submitted_at=?, updated_at=? WHERE id=?`, db.now(), db.now(), t.id);
    audit.log({ user: ctx.user, action: 'time.submit', entity: 'time_entry', entityId: t.id, clientId: t.client_id, ip: ctx.ip, details: { minutes: t.minutes } });
    return { ok: true };
  });

  // Submit a whole period at once — nobody submits a fortnight of time one row at a time.
  r.post('/api/time/submit-period', auth.requireAuth, auth.requirePerm('time:write'), (ctx) => {
    const v = validate(ctx.body, { from: { type: 'date', required: true }, to: { type: 'date', required: true } });
    const res = db.run(`UPDATE time_entries SET status='submitted', submitted_at=?, updated_at=? WHERE user_id=? AND work_date BETWEEN ? AND ? AND status IN ('draft','rejected')`, db.now(), db.now(), ctx.user.id, v.from, v.to);
    audit.log({ user: ctx.user, action: 'time.submit.period', ip: ctx.ip, details: { from: v.from, to: v.to, entries: res.changes } });
    return { ok: true, submitted: res.changes };
  });

  r.post('/api/time/:id/approve', auth.requireAuth, auth.requirePerm('time:approve'), (ctx) => {
    const t = loadEntry(ctx, ctx.params.id);
    const v = validate(ctx.body, { decision: { type: 'string', required: true, enum: ['approved', 'rejected'] }, note: { type: 'string', maxLen: 500 } });
    // The same rule as expenditures: nobody signs off their own claim.
    if (t.user_id === ctx.user.id) throw forbidden('You cannot approve your own time');
    if (t.status !== 'submitted') throw badRequest('Only submitted time can be approved or returned');
    if (v.decision === 'rejected' && !v.note) throw badRequest(NO_REASON);
    // The reviewer's note can name the client ("J. was seen Tuesday"): encrypted, and not in the audit entry.
    const note = v.note ? encrypt(v.note) : null;
    db.run(`UPDATE time_entries SET status=?, approved_by=?, approved_at=?, approval_note_enc=?, updated_at=? WHERE id=?`, v.decision, ctx.user.id, db.now(), note, db.now(), t.id);
    audit.log({ user: ctx.user, action: `time.${v.decision}`, entity: 'time_entry', entityId: t.id, clientId: t.client_id, ip: ctx.ip, details: { worker: t.user_id, minutes: t.minutes, note_recorded: v.note ? true : undefined } });
    return { ok: true };
  });

  r.post('/api/time/approve-batch', auth.requireAuth, auth.requirePerm('time:approve'), (ctx) => {
    const v = validate(ctx.body, { ids: { type: 'array', required: true, maxLen: 500 }, decision: { type: 'string', required: true, enum: ['approved', 'rejected'] }, note: { type: 'string', maxLen: 500 } });
    if (v.decision === 'rejected' && !v.note) throw badRequest(NO_REASON);
    let n = 0; const skipped = [];
    db.transaction(() => {
      for (const id of v.ids) {
        const t = db.one(`SELECT * FROM time_entries WHERE id=?`, id);
        if (!t) { skipped.push({ id, reason: 'not found' }); continue; }
        if (t.user_id === ctx.user.id) { skipped.push({ id, reason: 'your own time' }); continue; }
        if (t.status !== 'submitted') { skipped.push({ id, reason: 'not awaiting approval' }); continue; }
        db.run(`UPDATE time_entries SET status=?, approved_by=?, approved_at=?, approval_note_enc=?, updated_at=? WHERE id=?`, v.decision, ctx.user.id, db.now(), v.note ? encrypt(v.note) : null, db.now(), t.id);
        n++;
      }
    });
    audit.log({ user: ctx.user, action: `time.${v.decision}.batch`, ip: ctx.ip, details: { count: n, skipped: skipped.length } });
    return { ok: true, [v.decision]: n, skipped };
  });
};
