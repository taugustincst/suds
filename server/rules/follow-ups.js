'use strict';
// Follow-up to-dos (released in 1.23.0; docs/USER_GUIDE.md, *Follow-up dates and your to-dos*). A
// worker who sets a follow-up date on a call or text, a visit or a referral gets a to-do for that day, whether the
// date was set when the record was made or added by editing it later. Both doors run this one rule: the REST routes
// after they write the record (routes/calls.js, interventions.js, referrals.js), and sync push once a device's whole
// batch has landed (the tables' rules below, `track` and `finish`), so a device on an older kernel, or one that
// leaves the to-do out, gets the same to-do as the office would have made.
//
// The rule, for one record, comparing its follow-up date before and after a write:
//   * a date set (on a new record, or one that had none), or changed: if the record has no open follow-up to-do, one
//     is made (assigned to the record's worker, due that day); if it has one SUDS made that is still untouched, its
//     due date moves to the new date. One the worker has changed is left as they left it.
//   * the date cleared (or, on a call, Follow-up needed unticked): an untouched follow-up to-do is cancelled; one the
//     worker has changed, or added details to, is left open for them to close.
//   * the same date saved again: nothing (no duplicate to-do, however often the record is saved).
// "Untouched" means as SUDS made it: still open (not started, done or cancelled), still assigned to the record's
// worker, with SUDS's title and the record's previous follow-up date as its due date (and, to cancel it, no details
// added). A worker's own edits to a to-do are therefore never overwritten or thrown away.
//
// Which to-do belongs to which record: tasks.call_id, tasks.intervention_id (migration 67) and tasks.referral_id. A
// to-do made before those links (or by an older kernel, which does not set call_id or intervention_id) is matched by
// what SUDS wrote on it -- the same client, worker, title and due date, with no link -- and linked the first time.
const db = require('../db');
const audit = require('../audit');
const { uuid, encrypt, decrypt } = require('../crypto');

const CLOSED_REFERRAL = ['completed', 'closed', 'declined_by_client', 'declined_by_provider'];
const OPEN = ['open', 'in_progress'];
const day = (v) => (v ? String(v).slice(0, 10) : null);
const plain = (v) => { if (!v) return null; try { return decrypt(v); } catch { return null; } };
// Titles compare without case or surrounding space: an older SUDS wrote some labels in another case.
const norm = (t) => (t === null || t === undefined ? null : String(t).trim().toLowerCase());
// A call's title with no purpose (1.23.2) is too plain to recognise a to-do by: a worker's own "Call back" is not taken
// for a follow-up unless it is linked to the call (review of 1.23.2).
const GENERIC = new Set(['call back', 'text back']);
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

const SPECS = {
  calls: {
    link: 'call_id', from: 'call',
    due: (r) => (truthy(r.follow_up_needed) && r.follow_up_due ? day(r.follow_up_due) : null),
    // "Call back: <purpose>"; with no purpose, who it is for in the words the call form uses ("Text back: Family"),
    // and nothing more for the client, whom the to-do names already (1.23.2: it read "Call back: client").
    title: (r) => { const what = plain(r.purpose_enc) || (r.contact_type && r.contact_type !== 'client' ? require('../options').labelOf('CALL_CONTACT_TYPES', r.contact_type) : null); return `${r.method === 'text' ? 'Text back' : 'Call back'}${what ? `: ${what}` : ''}`; },
    // What 1.23.0 and 1.23.1 wrote with no purpose (the stored value, "Call back: client"): still SUDS's own title.
    oldTitle: (r) => (!plain(r.purpose_enc) && r.contact_type ? `${r.method === 'text' ? 'Text back' : 'Call back'}: ${r.contact_type}` : null),
    priority: (r) => (truthy(r.crisis) ? 'urgent' : 'normal'),
    mayCreate: () => true,
    ours: () => true,
  },
  interventions: {
    link: 'intervention_id', from: 'visit',
    // A visit with no client (community distribution, an anonymous outreach contact) has no one to follow up with.
    due: (r) => (r.client_id && r.follow_up_due ? day(r.follow_up_due) : null),
    title: (r) => `Follow up: ${require('../options').labelOf('INTERVENTION_TYPES', r.type)}`,
    priority: () => 'normal',
    mayCreate: () => true,
    ours: () => true,
  },
  referrals: {
    link: 'referral_id', from: 'referral',
    due: (r) => day(r.follow_up_due),
    title: (r) => `Follow up on referral to ${(db.one(`SELECT name FROM resources WHERE id=?`, r.resource_id) || {}).name || 'referral recipient'}`,
    priority: (r) => (r.urgency === 'emergent' ? 'urgent' : 'normal'),
    // A closed referral, or one whose outcome is recorded, has nothing left to follow up: its date may still be
    // corrected, but no new to-do is made.
    mayCreate: (r) => !CLOSED_REFERRAL.includes(r.status) && !r.outcome_recorded_at,
    // A secure referral link's to-do carries the referral too (server/referral-links.js); it is not the follow-up.
    ours: (t, title) => title !== null && title.startsWith('Follow up on referral to '),
  },
};

/**
 * Make, move or cancel the follow-up to-do of one record after a write. `row` is the record as stored now and `prev`
 * as it was before (null for a new one), both in stored form (encrypted columns encrypted). `user` and `ip` are who
 * caused it, for the audit trail. Returns what was done ('created', 'moved', 'cancelled'), or null.
 */
function reconcile(table, row, prev, { user, ip }, extra = {}, earlier = null) {
  const S = SPECS[table];
  if (!S || !row || !row.id) return null;
  const log = (action, id, details) => audit.log({ user, action, entity: 'task', entityId: id, clientId: row.client_id || null, ip, details: { from: S.from, [S.link]: row.id, automatic: true, ...extra, ...details } });
  // A referral whose outcome this write recorded (its status set to admitted, completed, declined or closed by
  // editing it, at the office or on a device) has served its to-dos, as POST /api/referrals/:id/outcome closes them:
  // its follow-up and a supervisor's reminder to record the outcome (routes/supervision.js). Review of 1.23.0.
  if (table === 'referrals' && prev && !prev.outcome_recorded_at && row.outcome_recorded_at) {
    const now = db.now(); let done = null;
    for (const t of db.all(`SELECT id FROM tasks WHERE referral_id=? AND status IN ('open','in_progress')`, row.id)) {
      db.run(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`, now, now, t.id);
      log('task.update', t.id, { status: 'done' });
      done = 'closed';
    }
    return done;
  }
  const want = S.due(row); const was = prev ? S.due(prev) : null;
  if (prev && want === was) return null;
  if (!want && !was) return null;
  // `earlier`: the record before a sync push that changed it and then deleted it (cancelForDeleted): its to-do may
  // still carry the title, worker and date it had then, the office not having moved it yet.
  const rows = [row, prev, earlier].filter(Boolean);
  const titles = new Set(rows.flatMap(r => [S.title(r), S.oldTitle ? S.oldTitle(r) : null]).filter(Boolean).map(norm));
  const workers = new Set(rows.map(r => r.user_id).filter(Boolean));
  const dates = new Set([was, earlier ? S.due(earlier) : null].filter(Boolean));
  let linked = db.all(`SELECT * FROM tasks WHERE ${S.link}=?`, row.id).map(t => ({ ...t, _title: plain(t.title_enc) })).filter(t => S.ours(t, t._title));
  if (!linked.length) {
    // A to-do from before the link (or from an older kernel): SUDS's title and date on this client's, for this worker.
    const lookFor = new Set(dates.size ? dates : [want]);
    const cand = db.all(`SELECT * FROM tasks WHERE ${S.link} IS NULL AND ${row.client_id ? 'client_id=?' : 'client_id IS NULL'} AND assigned_to IN (${[...workers].map(() => '?').join(',')})`,
      ...(row.client_id ? [row.client_id] : []), ...workers)
      .map(t => ({ ...t, _title: plain(t.title_enc) }))
      .filter(t => titles.has(norm(t._title)) && !GENERIC.has(norm(t._title)) && lookFor.has(day(t.due_at)) && OPEN.includes(t.status) && S.ours(t, t._title));
    if (cand.length) {
      const t = cand[0];
      db.run(`UPDATE tasks SET ${S.link}=?, updated_at=? WHERE id=?`, row.id, db.now(), t.id);
      linked = [{ ...t, [S.link]: row.id }];
    }
  }
  const open = linked.filter(t => OPEN.includes(t.status));
  // As SUDS made it: open, the record's worker's, SUDS's title, and still due on the record's previous date.
  const untouched = open.filter(t => t.status === 'open' && workers.has(t.assigned_to) && titles.has(norm(t._title)) && dates.has(day(t.due_at)));

  if (want) {
    if (open.length) {
      if (!was || !untouched.length) return null; // the worker's own to-do, or the one already made for this date
      const t = untouched[0];
      db.run(`UPDATE tasks SET due_at=?, updated_at=? WHERE id=?`, want, db.now(), t.id);
      log('task.update', t.id, { fields: ['due_at'] });
      return 'moved';
    }
    if (!S.mayCreate(row)) return null;
    const id = uuid();
    db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,due_at,priority,${S.link}) VALUES(?,?,?,?,?,?,?,?)`,
      id, row.client_id || null, row.user_id, user.id, encrypt(S.title(row)), want, S.priority(row), row.id);
    log('task.create', id, { for: row.user_id !== user.id ? row.user_id : undefined });
    return 'created';
  }
  // The date was cleared: an untouched to-do goes; one with the worker's details on it stays for them to close.
  let done = null;
  for (const t of untouched) {
    if (t.description_enc) continue;
    db.run(`UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?`, db.now(), t.id);
    log('task.update', t.id, { status: 'cancelled' });
    done = 'cancelled';
  }
  return done;
}

/**
 * A call or text, a visit or a referral about to be deleted (1.23.1): its follow-up to-do goes as if the date had been
 * cleared -- cancelled while it is still as SUDS made it (the rule above), left for the worker to close when they have
 * changed it. Both doors call this BEFORE the row is deleted (the link is ON DELETE SET NULL): the REST routes'
 * beforeDelete (crud.js) and sync push's tombstone (the tables' beforeDelete, push.js, through pushDeleted). Audited as
 * task.update with cause 'deleted'.
 * The to-do is found by its link (1.23.2): a push that changed the record's follow-up date and then deleted it reaches
 * here before the office has moved the to-do (that happens once the batch has landed, `finish`), so `earlier`, the
 * record as it was before that push, gives the date the to-do still has. A supervisor's reminder to record a deleted
 * referral's outcome (routes/supervision.js) is cancelled too: there is no outcome left to record.
 */
function cancelForDeleted(table, row, ctx, earlier = null) {
  if (!SPECS[table] || !row || !row.id) return null;
  const done = reconcile(table, { ...row, follow_up_due: null, follow_up_needed: 0 }, row, ctx, { cause: 'deleted' }, earlier);
  if (table !== 'referrals') return done;
  let gone = null;
  for (const t of reminderTasks([row.id])) {
    db.run(`UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?`, db.now(), t.id);
    audit.log({ user: ctx.user, action: 'task.update', entity: 'task', entityId: t.id, clientId: row.client_id || null, ip: ctx.ip, details: { from: 'referral', referral_id: row.id, automatic: true, cause: 'deleted', status: 'cancelled' } });
    gone = 'cancelled';
  }
  return done || gone;
}
/** Sync push's tombstone for a call, visit or referral (the tables' beforeDelete): cancelForDeleted, with the record
 *  as it stood before this push if the push changed it first. */
function pushDeleted(table, row, s) {
  const x = s && s.state && s.state.followUps && s.state.followUps.get(`${table}:${row.id}`);
  return cancelForDeleted(table, row, { user: s.user, ip: 'device' }, x ? x.prev : null);
}

/**
 * A supervisor's reminders to record these referrals' outcomes that are still open, oldest first: { id, referral_id,
 * client_id, created_at }. A reminder is the referral's to-do (tasks.referral_id) that its `referral.remind` audit entry
 * names (details.task; POST /api/supervision/referrals/:id/remind), never one recognised by its title or details, which
 * are the worker's to edit. Reads no PHI: the to-dos' links and the reminders' audit entries (found by client, indexed).
 */
function reminderTasks(ids) {
  if (!ids.length) return [];
  const open = db.all(`SELECT id, referral_id, client_id, created_at FROM tasks WHERE referral_id IN (${ids.map(() => '?').join(',')}) AND status IN ('open','in_progress') AND created_by<>assigned_to ORDER BY created_at`, ...ids);
  const clients = [...new Set(open.map(t => t.client_id).filter(Boolean))];
  if (!clients.length) return [];
  const made = new Set();
  for (const a of db.all(`SELECT entity_id, details FROM audit_log WHERE client_id IN (${clients.map(() => '?').join(',')}) AND action='referral.remind'`, ...clients)) {
    try { const d = JSON.parse(a.details); if (d && d.task) made.add(`${a.entity_id} ${d.task}`); } catch { /* not a reminder's entry */ }
  }
  return open.filter(t => made.has(`${t.referral_id} ${t.id}`));
}

// ---- sync push: the tables' rules record each record a push writes (afterApply), and reconcile them all once every
// row of the batch has landed (finish), so a to-do the device sent with the record is found rather than duplicated.
function tracked(s) { return s.state.followUps || (s.state.followUps = new Map()); }
/** Remember a pushed record and how it stood before the push's first write to it. */
function track(table, row, c) {
  if (!c || !c.session || typeof row.id !== 'string') return;
  const m = tracked(c.session); const k = `${table}:${row.id}`;
  if (!m.has(k)) m.set(k, { table, id: row.id, prev: c.existing || null });
}
/** Reconcile this table's pushed records: one record's failure is the device's to hear about, the rest stand. */
function finish(table, s) {
  for (const x of tracked(s).values()) {
    if (x.table !== table) continue;
    const row = db.one(`SELECT * FROM ${table} WHERE id=?`, x.id);
    if (!row) continue;
    db.savepoint(() => reconcile(table, row, x.prev, { user: s.user, ip: 'device' }),
      (err) => s.warnings.push({ table, id: x.id, reason: `follow-up to-do not updated: ${String(err && err.message || err).slice(0, 160)}` }));
  }
}

/**
 * A call's follow-up flag and date, as both doors store them. A date is a follow-up whether or not the box was
 * ticked (1.22.0). On an existing call, Follow-up needed unticked with the date left as it was turns the follow-up
 * off and clears the date; a new or changed date wins over the box. `v` is the write (REST body or pushed row),
 * `existing` the stored call or null.
 */
function deriveCallFollowUp(v, existing) {
  const unticked = v.follow_up_needed !== undefined && v.follow_up_needed !== null && !truthy(v.follow_up_needed);
  if (existing && unticked && truthy(existing.follow_up_needed) && (v.follow_up_due === undefined || day(v.follow_up_due) === day(existing.follow_up_due))) { v.follow_up_due = null; v.follow_up_needed = 0; return; }
  if (v.follow_up_due) v.follow_up_needed = 1;
}
/** A new referral's follow-up date when the worker set none: every referral gets one, by urgency. */
function defaultReferralDue(v) {
  if (v.follow_up_due) return;
  const days = v.urgency === 'emergent' ? 1 : v.urgency === 'urgent' ? 3 : 14;
  v.follow_up_due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

module.exports = { reconcile, cancelForDeleted, pushDeleted, reminderTasks, track, finish, deriveCallFollowUp, defaultReferralDue, SPECS };
