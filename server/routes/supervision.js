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

// The client's display name on a queue row, for a role that could open that client (clients:read, and the
// client on their caseload when caseload scoping applies to them); everyone else gets the code alone. The
// encrypted name columns never leave this function.
const { withClientName, SELECT: NAME_COLS } = require('../client-name');
function named(ctx, rows) {
  return rows.map((x) => {
    const mayOpen = x.client_id && auth.canAccessClient(ctx.user, x.client_id);
    const out = withClientName(ctx, mayOpen ? x : { ...x, c_first_name_enc: null, c_last_name_enc: null });
    return out;
  });
}
// A referral whose status is itself the outcome (admitted, completed, declined, no-show, closed) has closed
// the loop; "no outcome recorded yet" is the ones still waiting to hear (contacted through scheduled).
const AWAITING_OUTCOME = ['contacted', 'accepted', 'waitlisted', 'scheduled'];

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
      out.awaiting_cosignature = named(ctx, db.all(`SELECT n.id, n.client_id, n.kind, n.occurred_at, n.signed_at, n.title_enc, n.cosign_requested, n.counseling_note, n.author_id, n.cosigned_by, u.display_name AS author, c.client_code, ${NAME_COLS}
        FROM notes n JOIN users u ON u.id=n.author_id JOIN clients c ON c.id=n.client_id
        WHERE n.deleted_at IS NULL AND n.status<>'draft' AND n.cosigned_at IS NULL AND n.author_id<>? AND ((n.cosign_required=1 AND ${sf.sql}) OR n.cosign_requested=1)
        ORDER BY n.signed_at LIMIT 100`, ctx.user.id, ...sf.params))
        // A SUD counseling note's title only for someone who may read it (server/rules/notes.js, 1.16.1).
        .map(({ counseling_note, cosigned_by, ...x }) => ({ ...x, title: x.title_enc && require('../rules/notes').mayReadCounseling(ctx.user, { counseling_note, author_id: x.author_id, cosigned_by }) ? decrypt(x.title_enc) : null, title_enc: undefined }));
      // author_id: who a "Remind author" to-do goes to (views/supervision.js, POST /api/tasks).
      out.unsigned_notes = named(ctx, db.all(`SELECT n.id, n.client_id, n.kind, n.occurred_at, n.created_at, n.author_id, u.display_name AS author, c.client_code, ${NAME_COLS},
          (n.created_at < ?) AS overdue
        FROM notes n JOIN users u ON u.id=n.author_id JOIN clients c ON c.id=n.client_id
        WHERE n.deleted_at IS NULL AND n.status='draft' AND ${sf.sql}
        ORDER BY n.created_at LIMIT 100`, staleBefore, ...sf.params));
    }
    if (auth.hasPerm(ctx.user, 'time:approve')) {
      out.time_awaiting_approval = named(ctx, db.all(`SELECT t.id, t.user_id, t.client_id, t.work_date, t.minutes, t.category, t.billable, t.submitted_at, u.display_name AS worker, c.client_code, ${NAME_COLS}, f.name AS funding_source
        FROM time_entries t JOIN users u ON u.id=t.user_id LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN funding_sources f ON f.id=t.funding_source_id
        WHERE t.status='submitted' AND t.user_id<>? AND ${tf.sql} ORDER BY t.work_date LIMIT 200`, ctx.user.id, ...tf.params));
      out.time_totals = db.one(`SELECT COUNT(*) entries, COALESCE(SUM(minutes),0) minutes FROM time_entries t WHERE t.status='submitted' AND t.user_id<>? AND ${tf.sql}`, ctx.user.id, ...tf.params);
    }
    if (auth.hasPerm(ctx.user, 'referrals:read')) {
      const cf = auth.caseloadFilter(ctx.user, 'r.client_id');
      out.referrals_awaiting_outcome = named(ctx, db.all(`SELECT r.id, r.client_id, r.referred_at, r.status, res.name AS resource, c.client_code, ${NAME_COLS}
        FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN clients c ON c.id=r.client_id
        WHERE r.outcome_recorded_at IS NULL AND r.status IN (${AWAITING_OUTCOME.map(() => '?').join(',')}) AND c.deleted_at IS NULL AND ${cf.sql} ORDER BY r.referred_at LIMIT 100`, ...AWAITING_OUTCOME, ...cf.params));
      out.referrals_consent_revoked = named(ctx, db.all(`SELECT r.id, r.client_id, res.name AS resource, c.client_code, ${NAME_COLS} FROM referrals r JOIN resources res ON res.id=r.resource_id JOIN clients c ON c.id=r.client_id WHERE r.consent_revoked=1 AND r.status NOT IN ('closed','declined_by_client','declined_by_provider') AND ${cf.sql} LIMIT 100`, ...cf.params));
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

  // Returned or reopened time is the worker's to correct, and they are told (1.16.0): a to-do on their list,
  // due now so the bell shows it, saying which day and how long, who returned it and why. The reason can name a
  // client, so it is encrypted like every to-do's text; the audit entry says only that a to-do was raised.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : d; };
  const mins = (n) => { const h = Math.floor((n || 0) / 60), m = (n || 0) % 60; return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`; };
  function tellWorker(ctx, workerId, entries, note, reopened) {
    if (!workerId || !entries.length) return null;
    const what = entries.length === 1 ? `your time for ${day(entries[0].work_date)} (${mins(entries[0].minutes)})` : `${entries.length} of your time entries (${entries.map(e => day(e.work_date)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3).join(', ')}${entries.length > 3 ? '…' : ''})`;
    const title = `Correct ${what}: ${reopened ? 'reopened' : 'returned'} by ${ctx.user.display_name || 'your supervisor'}`;
    const desc = `${reopened ? 'Reopened' : 'Returned'}: ${note}\nOpen My time, correct ${entries.length === 1 ? 'the entry' : 'them'} and submit again.`;
    const id = require('../crypto').uuid();
    db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority) VALUES(?,?,?,?,?,?,?,?)`, id, null, workerId, ctx.user.id, encrypt(title), encrypt(desc), db.now(), 'high');
    return id;
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
    require('../rules/shared').assertRulingHere('Approving or returning time');
    const t = loadEntry(ctx, ctx.params.id);
    const v = validate(ctx.body, { decision: { type: 'string', required: true, enum: ['approved', 'rejected'] }, note: { type: 'string', maxLen: 500 } });
    // The same rule as expenditures: nobody signs off their own claim.
    if (t.user_id === ctx.user.id) throw forbidden('You cannot approve your own time');
    // Nor time they recorded for someone else, or changed (security review of 1.16.0, M7). Returning it is still theirs.
    if (v.decision === 'approved' && require('../rules/shared').recordedOrChanged('time_entry', 'time_entries', t.id, ctx.user.id)) throw forbidden('Separation of duties: you recorded or changed this time, so another approver must review it');
    // Approved time is locked (server/rules/time_entries.js); returning it with a reason is how a supervisor
    // reopens it for the worker to correct and resubmit. Nothing else moves an approved entry.
    const reopening = t.status === 'approved' && v.decision === 'rejected';
    if (t.status !== 'submitted' && !reopening) throw badRequest(t.status === 'approved' ? 'This time is already approved; return it with a reason to reopen it for correction' : 'Only submitted time can be approved or returned');
    if (v.decision === 'rejected' && !v.note) throw badRequest(NO_REASON);
    // The reviewer's note can name the client ("J. was seen Tuesday"): encrypted, and not in the audit entry.
    const note = v.note ? encrypt(v.note) : null;
    db.run(`UPDATE time_entries SET status=?, approved_by=?, approved_at=?, approval_note_enc=?, updated_at=? WHERE id=?`, v.decision, ctx.user.id, db.now(), note, db.now(), t.id);
    const task = v.decision === 'rejected' ? tellWorker(ctx, t.user_id, [t], v.note, reopening) : null;
    audit.log({ user: ctx.user, action: `time.${v.decision}`, entity: 'time_entry', entityId: t.id, clientId: t.client_id, ip: ctx.ip, details: { worker: t.user_id, minutes: t.minutes, note_recorded: v.note ? true : undefined, reopened: reopening || undefined, task: task || undefined } });
    return { ok: true };
  });

  r.post('/api/time/approve-batch', auth.requireAuth, auth.requirePerm('time:approve'), (ctx) => {
    require('../rules/shared').assertRulingHere('Approving or returning time');
    const v = validate(ctx.body, { ids: { type: 'array', required: true, maxLen: 500 }, decision: { type: 'string', required: true, enum: ['approved', 'rejected'] }, note: { type: 'string', maxLen: 500 } });
    if (v.decision === 'rejected' && !v.note) throw badRequest(NO_REASON);
    let n = 0; const skipped = []; const byWorker = new Map(); const tasks = [];
    db.transaction(() => {
      for (const id of v.ids) {
        const t = db.one(`SELECT * FROM time_entries WHERE id=?`, id);
        if (!t) { skipped.push({ id, reason: 'not found' }); continue; }
        if (t.user_id === ctx.user.id) { skipped.push({ id, reason: 'your own time' }); continue; }
        if (t.status !== 'submitted') { skipped.push({ id, reason: 'not awaiting approval' }); continue; }
        if (v.decision === 'approved' && require('../rules/shared').recordedOrChanged('time_entry', 'time_entries', t.id, ctx.user.id)) { skipped.push({ id, reason: 'you recorded or changed it' }); continue; }
        db.run(`UPDATE time_entries SET status=?, approved_by=?, approved_at=?, approval_note_enc=?, updated_at=? WHERE id=?`, v.decision, ctx.user.id, db.now(), v.note ? encrypt(v.note) : null, db.now(), t.id);
        n++;
        if (v.decision === 'rejected') { if (!byWorker.has(t.user_id)) byWorker.set(t.user_id, []); byWorker.get(t.user_id).push(t); }
      }
      // One to-do per worker for what was returned to them.
      for (const [worker, entries] of byWorker) { const id = tellWorker(ctx, worker, entries, v.note, false); if (id) tasks.push(id); }
    });
    audit.log({ user: ctx.user, action: `time.${v.decision}.batch`, ip: ctx.ip, details: { count: n, skipped: skipped.length, tasks: tasks.length || undefined } });
    return { ok: true, [v.decision]: n, skipped };
  });
};
