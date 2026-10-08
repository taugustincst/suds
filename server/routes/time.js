'use strict';
const db = require('../db');
const auth = require('../auth');
const crud = require('../crud');
const C = require('../constants');
const { withClientName, SELECT: NAME_COLS } = require('../client-name');
const { encrypt, decrypt } = require('../crypto');
const audit = require('../audit');
const { HttpError, notFound, forbidden, badRequest } = require('../http');
const { validate } = require('../validate');
const TE = require('../rules/time_entries');

// What the time was spent on ("Drove J. to detox intake") and the reviewer's note on it are free text that
// can name the client: both are encrypted (migration 37). The API keeps the plain names description and
// approval_note.
function encDescription(v) {
  if (v.description !== undefined) { v.description_enc = v.description ? encrypt(String(v.description)) : null; delete v.description; }
}
/** Decrypt a time entry row's free text, for this route and the places that read time entries outside it. */
function presentTime(t) {
  if (!t) return t;
  const o = { ...t };
  if ('description_enc' in t) { o.description = t.description_enc ? decrypt(t.description_enc) : null; delete o.description_enc; }
  if ('approval_note_enc' in t) { o.approval_note = t.approval_note_enc ? decrypt(t.approval_note_enc) : null; delete o.approval_note_enc; }
  return o;
}

/**
 * What a reader may see of an entry's description. A role without clients:read (finance: time:all, to approve
 * hours) sees another worker's time as category, fund and hours only (security review of 1.13.0, 7): the
 * description is free text about the work and can name the client. Its own entries keep their description.
 * exports.js applies the same rule (mayReadDescription); a role without clients:read cannot sync at all.
 */
const mayReadDescription = (user, entry) => auth.hasPerm(user, 'clients:read') || entry.user_id === user.id;
function withheldFor(user, t) {
  if (!t || mayReadDescription(user, t)) return t;
  return { ...t, description: null, description_withheld: !!(t.description || t.description_enc) };
}

// Time is personal: an entry with no client can only be read by the worker who logged it, or a manager
// (time:all) -- sync-tables.js `unlinked`, which crud.js applies to these routes.
const JOINS = 'JOIN users u ON u.id=time_entries.user_id LEFT JOIN clients c ON c.id=time_entries.client_id LEFT JOIN funding_sources f ON f.id=time_entries.funding_source_id';
const SELECT = `time_entries.*, u.display_name AS worker, c.client_code, f.name AS funding_source, ${NAME_COLS}`;
// source (1.14.0): where the entry came from — 'visit' (logged with a visit: "Also log this as a time
// entry"), 'call' (logged with a call) or 'manual' — so a list can mark the generated ones and the time
// form can warn before the same work is logged twice.
const present = (ctx, x) => ({ ...withheldFor(ctx.user, presentTime(withClientName(ctx, x))), source: x.intervention_id ? 'visit' : x.call_id ? 'call' : 'manual' });

// ---- possible duplicates (1.24.0; server/rules/time_entries.js duplicatesOf) ----
/** May this user read this stored entry (the GET /api/time/:id rule)? */
function mayRead(ctx, row) {
  if (row.client_id) return auth.canAccessClient(ctx.user, row.client_id, { deidentified: true });
  return row.user_id === ctx.user.id || auth.hasPerm(ctx.user, 'time:all');
}
/** Whose time a new entry is: crud.js's owner rule for this table (only time:all names someone else). */
const ownerOf = (ctx, v) => (auth.hasPerm(ctx.user, 'time:all') && v.user_id ? v.user_id : ctx.user.id);
const asked = (ctx) => !!(ctx.body && typeof ctx.body === 'object' && ctx.body.save_anyway === true);
/**
 * The duplicate question for a save: the candidates this user may read, presented as the list shows them (the
 * description withheld where the list withholds it). Entries the user may not read are never shown or counted in
 * the question; the save goes ahead and is marked for review against the first of them (duplicate_of).
 */
function duplicateQuestion(ctx, e) {
  const found = TE.duplicatesOf(e);
  if (!found.length) return { found, shown: [], hidden: [] };
  const readable = found.filter(d => mayRead(ctx, d.row));
  const hidden = found.filter(d => !readable.includes(d));
  const rows = readable.length ? db.all(`SELECT ${SELECT} FROM time_entries ${JOINS} WHERE time_entries.id IN (${readable.map(() => '?').join(',')})`, ...readable.map(d => d.row.id)) : [];
  const R = require('../rules').forTable('time_entries');
  const shown = readable.map(d => {
    const x = present(ctx, rows.find(y => y.id === d.row.id));
    const locked = d.row.status === 'approved';
    return { id: x.id, work_date: x.work_date, start_time: x.start_time || null, minutes: x.minutes, category: x.category, client_id: x.client_id, client_code: x.client_code, client_name: x.client_name || null,
      funding_source: x.funding_source || null, worker: x.worker, description: x.description, description_withheld: !!x.description_withheld, status: x.status || 'draft', source: x.source,
      updated_at: x.updated_at, locked, may_merge: !locked && !R.editableBy(ctx.user, d.row), reasons: d.reasons };
  });
  return { found, shown, hidden };
}
const DUPLICATE = 'This looks like time already logged: the same worker and day, with overlapping times or the same minutes and description. Merge it into the entry already there, save it anyway, or cancel.';
/** Ask (409, { duplicate, candidates }) unless the request says save_anyway: true. */
function askUnlessAnswered(ctx, q, entityId) {
  if (!q.shown.length || asked(ctx)) return;
  // Showing a candidate is a read of it (its description can name the client): each is audited, reasons only.
  for (const x of q.shown) audit.log({ user: ctx.user, action: 'time_entry.duplicate.warn', entity: 'time_entry', entityId: x.id, clientId: x.client_id || null, ip: ctx.ip, details: { reasons: x.reasons, for: entityId || 'new' } });
  throw new HttpError(409, DUPLICATE, { duplicate: true, candidates: q.shown });
}
/** The answer "save anyway", once the save has happened: audited with the candidates' ids, never their text. */
function overridden(ctx, id, clientId) {
  const q = ctx.timeDuplicates;
  if (q && q.shown.length && asked(ctx)) audit.log({ user: ctx.user, action: 'time_entry.duplicate.override', entity: 'time_entry', entityId: id, clientId: clientId || null, ip: ctx.ip, details: { candidates: q.shown.map(x => x.id), reasons: [...new Set(q.shown.flatMap(x => x.reasons))] } });
}
/** The GET /api/time/:id reach rule for a stored entry: its client's caseload, or (no client) its worker or time:all. */
function reach(ctx, row) {
  if (row.client_id) { auth.assertClientAccess(ctx, row.client_id, { deidentified: true }); return; }
  if (row.user_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'time:all')) throw forbidden('That record belongs to another worker');
}
const clearMarksTo = TE.clearMarksTo;
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

module.exports = (r) => {
  crud.build(r, {
    table: 'time_entries', entity: 'time_entry', base: '/api/time', perm: 'time', dateCol: 'work_date', clientRequired: false,
    joins: JOINS,
    select: SELECT,
    afterLoad: present,
    // shape, owner (time:all), canEdit and the fund-period check: server/rules/time_entries.js.
    filters: (ctx, where, params) => {
      // non-managers see only their own time
      if (!auth.hasPerm(ctx.user, 'time:all')) { where.push('time_entries.user_id=?'); params.push(ctx.user.id); }
      const cat = ctx.query.get('category'); if (cat) { where.push('time_entries.category=?'); params.push(cat); }
      // A manager's own view of one worker's time (the time form's overlap check for a worker they log for).
      const uid = ctx.query.get('user_id'); if (uid) { where.push('time_entries.user_id=?'); params.push(uid); }
      // source=visit|call|manual: the entries a visit or a call logged, or the ones entered by hand.
      const src = ctx.query.get('source');
      if (src === 'visit') where.push('time_entries.intervention_id IS NOT NULL');
      else if (src === 'call') where.push('time_entries.call_id IS NOT NULL');
      else if (src === 'manual') where.push('time_entries.intervention_id IS NULL AND time_entries.call_id IS NULL');
    },
    // Reassigning whose hours these are is a time:all action (see public/views/time.js, which only shows the
    // Worker picker when can('time:all')): the rules' owner, which crud.js applies on insert and update alike.
    // A likely duplicate (1.24.0) is asked about (409, { duplicate, candidates }) unless the request says
    // save_anyway: true, which is audited as an override. Matches the user may not read never block.
    beforeInsert: (ctx, v) => {
      const q = duplicateQuestion(ctx, { user_id: ownerOf(ctx, v), work_date: v.work_date, start_time: v.start_time, minutes: v.minutes, description: v.description });
      askUnlessAnswered(ctx, q, null);
      ctx.timeDuplicates = q;
      if (q.hidden.length && !q.shown.length) v.duplicate_of = q.hidden[0].row.id;
      encDescription(v);
    },
    afterInsert: (ctx, row) => { overridden(ctx, row.id, row.client_id); },
    beforeUpdate: (ctx, v, row) => {
      const was = presentTime({ description_enc: row.description_enc }).description;
      const pick = (k, cur) => (v[k] !== undefined ? v[k] : cur);
      const after = { id: row.id, user_id: v.user_id || row.user_id, work_date: pick('work_date', row.work_date), start_time: pick('start_time', row.start_time), minutes: pick('minutes', row.minutes), description: pick('description', was) };
      const before = { user_id: row.user_id, work_date: row.work_date, start_time: row.start_time, minutes: row.minutes, description: was };
      // Only an edit that changes what the check looks at is asked about (fixing a category is not a new entry).
      if (Object.keys(before).some(k => String(after[k] ?? '') !== String(before[k] ?? ''))) {
        const q = duplicateQuestion(ctx, after);
        askUnlessAnswered(ctx, q, row.id);
        ctx.timeDuplicates = q;
        // Answered (saved anyway) or nothing found: the entry has been looked at, so an earlier mark goes; a match
        // the user may not read marks it for review instead.
        v.duplicate_of = q.hidden.length && !q.shown.length ? q.hidden[0].row.id : null;
      }
      encDescription(v);
    },
    afterUpdate: (ctx, merged) => { overridden(ctx, merged.id, merged.client_id); },
    // An entry deleted is no longer anyone's possible duplicate.
    beforeDelete: (ctx, row) => { clearMarksTo(row.id); },
  });

  // ---- merge (1.24.0) ----
  // POST /api/time/:id/merge keeps entry :id (the one already there) and folds into it either a new entry that was
  // never saved ({ entry: {...the form's values} }, from the "possible duplicate" question) or another stored entry
  // ({ from_id }, a pair marked for review), which is then deleted. Both must be the same worker's, on the same day.
  // What the kept entry ends up with:
  //   description  its own, then the other's on a new line (once, when they say the same thing);
  //   times        times: 'union' (the default): when both have a start time and the ranges overlap or touch, the
  //                span of both (09:00-10:00 and 09:30-10:30 make 09:00-10:30, 90 minutes: never the 120 of the two
  //                added); otherwise the kept entry's own minutes, taking the other's start time if it had none.
  //                times: 'keep' leaves the kept entry's start and minutes as they are;
  //   client, fund, visit or call link   its own, or the other's where it had none; billable if either was.
  // Whoever may edit both entries may merge them (the worker, or time:all); approved time is locked (409) on either
  // side: a supervisor returns it first. Audited as time_entry.merge (ids and field names, never the text).
  r.post('/api/time/:id/merge', auth.requireAuth, auth.requirePerm('time:write'), (ctx) => {
    const R = require('../rules');
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const kept = db.one(`SELECT * FROM time_entries WHERE id=?`, ctx.params.id);
    if (!kept) throw notFound('Time entry not found');
    reach(ctx, kept);
    R.assertEditable('time_entries', ctx, kept);
    crud.assertFresh(ctx, kept, 'time_entry');
    const times = body.times === undefined ? 'union' : body.times;
    if (!['union', 'keep'].includes(times)) throw badRequest('times must be "union" or "keep"');
    if (!body.from_id && !body.entry) throw badRequest('Send from_id (a stored entry), entry (a new one), or both (a stored entry as it is being edited)');
    if (body.entry !== undefined && (!body.entry || typeof body.entry !== 'object')) throw badRequest('entry must be an object');
    let other; let fromId = null;
    if (body.from_id) {
      if (body.from_id === kept.id) throw badRequest('An entry cannot be merged into itself');
      const stored = db.one(`SELECT * FROM time_entries WHERE id=?`, String(body.from_id));
      if (!stored) throw notFound('Time entry not found');
      reach(ctx, stored);
      R.assertEditable('time_entries', ctx, stored, { deleting: true });
      other = { ...stored, description: presentTime({ description_enc: stored.description_enc }).description };
      fromId = stored.id;
      // The stored entry as its form has it now (an edit that was asked about): its values, checked as an update is.
      if (body.entry) {
        const v = validate(body.entry, TE.partialShape(), { partial: true, existing: stored });
        if (!auth.hasPerm(ctx.user, 'time:all')) delete v.user_id;
        if (v.client_id && v.client_id !== stored.client_id) { if (!crud.clientExists(v.client_id)) throw notFound('Client not found'); auth.assertClientAccess(ctx, v.client_id, { deidentified: true }); }
        for (const [k, x] of Object.entries(v)) if (x !== undefined) other[k] = x;
      }
    } else {
      const v = validate(body.entry, TE.shape());
      if (v.client_id) { if (!crud.clientExists(v.client_id)) throw notFound('Client not found'); auth.assertClientAccess(ctx, v.client_id, { deidentified: true }); }
      R.assertWrite('time_entries', R.toColumns('time_entries', v), ctx);
      other = { ...v, user_id: ownerOf(ctx, v) };
    }
    if (other.user_id !== kept.user_id || other.work_date !== kept.work_date) throw badRequest('Only entries for the same worker on the same day can be merged');
    const keptNote = presentTime({ description_enc: kept.description_enc }).description || '';
    const otherNote = other.description || '';
    const note = !otherNote || TE.sameNote(keptNote, otherNote) ? keptNote : !keptNote ? otherNote : `${keptNote}\n${otherNote}`;
    if (note.length > 500) throw badRequest('Together the two descriptions are longer than 500 characters. Shorten one of them first, then merge.', { fields: { description: 'max length 500' } });
    const set = {};
    if (note !== keptNote) set.description = note;
    if (times === 'union') {
      const a = TE.rangeOf(kept), b = TE.rangeOf(other);
      if (a && b && a[0] <= b[1] && b[0] <= a[1]) {
        const start = Math.min(a[0], b[0]), end = Math.max(a[1], b[1]);
        if (end - start > 1440) throw badRequest('Together the two entries are longer than a day');
        if (start !== a[0]) set.start_time = fmtMin(start);
        if (end - start !== kept.minutes) set.minutes = end - start;
      } else if (!kept.start_time && other.start_time) set.start_time = other.start_time;
    }
    for (const k of ['client_id', 'funding_source_id', 'intervention_id', 'call_id']) if (!kept[k] && other[k]) set[k] = other[k];
    if (!kept.billable && other.billable) set.billable = 1;
    if (set.client_id) auth.assertClientAccess(ctx, set.client_id, { deidentified: true });
    R.assertWrite('time_entries', { id: kept.id, ...R.toColumns('time_entries', set) }, ctx, { existing: kept });
    const fields = Object.keys(set);
    const cols = { ...set }; encDescription(cols);
    const keys = Object.keys(cols);
    db.transaction(() => {
      db.run(`UPDATE time_entries SET ${keys.map(k => `${k}=?, `).join('')}duplicate_of=NULL, updated_at=? WHERE id=?`, ...keys.map(k => cols[k]), db.now(), kept.id);
      if (fromId) {
        clearMarksTo(fromId, kept.id);
        db.run(`DELETE FROM time_entries WHERE id=?`, fromId); db.tombstone('time_entries', fromId);
      }
    });
    if (fromId) audit.log({ user: ctx.user, action: 'time_entry.delete', entity: 'time_entry', entityId: fromId, clientId: other.client_id || null, ip: ctx.ip, details: { merged_into: kept.id } });
    audit.log({ user: ctx.user, action: 'time_entry.merge', entity: 'time_entry', entityId: kept.id, clientId: kept.client_id || set.client_id || null, ip: ctx.ip, details: { merged: fromId || 'new entry', times, fields } });
    const now = db.one(`SELECT minutes, start_time, updated_at FROM time_entries WHERE id=?`, kept.id);
    return { ok: true, id: kept.id, merged: fromId, ...now };
  });

  // ---- not a duplicate (1.24.0) ----
  // Clears the "possible duplicate" mark a device's push left (or a match the worker could not see). The worker, a
  // manager (time:all) or an approver (time:approve) may: it changes no hours, so approved time may be cleared too.
  // The mark (duplicate_of) is the office's and sync never carries it (rules/time_entries.js), so on a device that
  // syncs with an office clearing it would look done and come back at the next pull: it is refused there, as a
  // ruling is (shared.js assertRulingHere). SUDS on this device, which has no office, clears its own.
  r.post('/api/time/:id/not-duplicate', auth.requireAuth, auth.requirePerm('time:write', 'time:approve'), (ctx) => {
    require('../rules/shared').assertRulingHere('Clearing a possible-duplicate mark');
    const row = db.one(`SELECT * FROM time_entries WHERE id=?`, ctx.params.id);
    if (!row) throw notFound('Time entry not found');
    reach(ctx, row);
    if (row.user_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'time:all') && !auth.hasPerm(ctx.user, 'time:approve')) throw forbidden('Only the worker, a manager or an approver can clear this');
    if (!row.duplicate_of) return { ok: true, unchanged: true };
    db.run(`UPDATE time_entries SET duplicate_of=NULL, updated_at=? WHERE id=?`, db.now(), row.id);
    audit.log({ user: ctx.user, action: 'time_entry.duplicate.dismiss', entity: 'time_entry', entityId: row.id, clientId: row.client_id || null, ip: ctx.ip, details: { was: row.duplicate_of } });
    return { ok: true };
  });

  r.get('/api/time/summary', auth.requireAuth, auth.requirePerm('time:read', 'time:write'), (ctx) => {
    const to = ctx.query.get('to') || require('../local-date').today();
    const from = ctx.query.get('from') || require('../local-date').addDays(require('../local-date').today(), -30);
    const all = auth.hasPerm(ctx.user, 'time:all');
    const scope = all ? '' : 'AND t.user_id=?'; const p = all ? [] : [ctx.user.id];
    return {
      from, to,
      by_worker: db.all(`SELECT u.display_name AS worker, t.user_id, SUM(t.minutes) minutes, SUM(CASE WHEN t.billable THEN t.minutes ELSE 0 END) billable_minutes, COUNT(DISTINCT t.client_id) clients FROM time_entries t JOIN users u ON u.id=t.user_id WHERE t.work_date BETWEEN ? AND ? ${scope} GROUP BY t.user_id ORDER BY minutes DESC`, from, to, ...p),
      by_category: db.all(`SELECT category, SUM(minutes) minutes FROM time_entries t WHERE work_date BETWEEN ? AND ? ${scope} GROUP BY category ORDER BY minutes DESC`, from, to, ...p),
      by_day: db.all(`SELECT work_date, SUM(minutes) minutes FROM time_entries t WHERE work_date BETWEEN ? AND ? ${scope} GROUP BY work_date ORDER BY work_date`, from, to, ...p),
      by_fund: db.all(`SELECT COALESCE(f.name,'Unallocated') fund, SUM(t.minutes) minutes FROM time_entries t LEFT JOIN funding_sources f ON f.id=t.funding_source_id WHERE t.work_date BETWEEN ? AND ? ${scope} GROUP BY f.name ORDER BY minutes DESC`, from, to, ...p),
    };
  });
};
module.exports.presentTime = presentTime;
module.exports.mayReadDescription = mayReadDescription;
