'use strict';
// Checks more than one table's rules make.
const auth = require('../auth');
const { flag, notPermitted } = require('./core');

/**
 * A date charged to a fund must fall in its period and not in the future (routes/budget.js assertInPeriod).
 * Flagged on push: the device checked the same thing against the fund as it had it, and a period changed at the
 * office (or a phone clock a day ahead) is no reason to throw away hours or spending recorded in the field.
 */
function periodProblem(fund, date, what) {
  try { require('../routes/budget').assertInPeriod(fund, date, what); return null; }
  catch (err) { return flag(`was accepted, but its ${what.toLowerCase()} is outside the period of the fund it is charged to, or in the future; the office will review it`, { message: err.message, code: 'fund_period' }); }
}

/** An editableBy for a record that is its owner's (any of `cols`) unless the user holds `all`. */
const ownedBy = (cols, all, message = 'You cannot edit this record') => (user, row) => (cols.some(c => row[c] === user.id) || auth.hasPerm(user, all) ? null : notPermitted(message));

/**
 * An office ruling on a pushed row (security review of 1.15.3, H1). Approving, returning or reimbursing work is
 * a person's act at the office, through the route that checks it is not their own (POST /api/time/:id/approve,
 * POST /api/budget/expenditures/:id/approve); a device never makes one, whoever holds it. So on push the
 * ruling's columns keep the office's values: `status` moves only as `mayMove(from, to, row, existing)` allows
 * (submitting one's own work), and `cols` (who ruled, when) and `enc` (their note) are the office's. A new row
 * starts as `initial(sentStatus)` with no ruling. A ruling the device asked for (a status in `rulings`, or a
 * ruler, date or note the office does not have) is not silently dropped: the row lands without it and is
 * flagged, so the device's sync screen and the audit trail (sync.conflict, flagged: 'ruling') say so.
 * Returns that flag, or null.
 */
function officeRuling(row, c, { initial, mayMove = () => false, rulings, cols = [], enc = [], what }) {
  const e = c.existing;
  const sent = row.status;
  const has = (v) => v !== undefined && v !== null && v !== '';
  let ruled = false;
  if (!e) {
    const start = initial(sent);
    if (has(sent) && sent !== start && rulings.includes(sent)) ruled = true;
    row.status = start;
    for (const k of cols) { if (has(row[k])) ruled = true; row[k] = null; }
    for (const k of enc) { if (has(row[k])) ruled = true; row[k] = undefined; }
  } else {
    if (has(sent) && sent !== e.status && !mayMove(e.status, sent, row, e)) { if (rulings.includes(sent)) ruled = true; row.status = e.status; }
    for (const k of cols) { if (has(row[k]) && String(row[k]) !== String(e[k] ?? '')) ruled = true; row[k] = e[k]; }
    for (const k of enc) { if (has(row[k]) && String(row[k]) !== String(c.was(k) ?? '')) ruled = true; row[k] = undefined; }
  }
  return ruled ? flag(`was accepted, but not the ruling on it (approved, returned or reimbursed): ${what} is ruled on at the office, never by sync, so the office's decision stands`, { code: 'ruling' }) : null;
}

/**
 * The office's own record of its own act on a row -- when it went into a state extract or a SPARS file -- kept as
 * the office has it on push (none on a new row). A device that asserts another value is flagged: clearing a CalOMS
 * record's extract date would put it in the next extract again (security review of 1.15.3, H1 follow-up).
 */
function officeMarks(row, c, cols, what) {
  const e = c.existing; let asserted = false;
  for (const k of cols) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== '' && String(v) !== String((e && e[k]) ?? '')) asserted = true;
    row[k] = e ? e[k] : null;
  }
  return asserted ? flag(`was accepted, but not ${what}: that is the office's record of its own act, never set by sync`, { code: 'office_mark' }) : null;
}

/**
 * On a device that syncs with an office (not SUDS on this device, which has no office), a ruling -- approving or
 * returning time or spending, countersigning a note -- is refused up front: sync never carries one to the office
 * (officeRuling above), so making it here would look done and then be undone at the next sync.
 */
function assertRulingHere(what) {
  const config = require('../config');
  const staticHost = typeof window !== 'undefined' && window.SUDS_STATIC_HOST === true;
  if (config.local && !staticHost) throw new (require('../http').HttpError)(403, `${what} is done on the office SUDS, not on this device: sync does not carry it there.`, { rulingAtOffice: true });
}

/**
 * Separation of duties (security review of 1.16.0, M7): did `userId` record this entry, or change it? The row
 * names only whose work it is (user_id), and an approver who may name someone else could record an entry under
 * a colleague's name, or raise a colleague's pending amount, and then approve it. Who did is in the audit trail:
 * the REST create and update (`<entity>.create`, `.update`, a spreadsheet import's per-record entry too), and a
 * device's (sync.overwrite; sync.record, logged by the table's afterApply for an entry it records for someone
 * else). No migration: the audit trail is the record, and the retention purge keeps it far past an approval.
 * From 1.16.2 (security review of 1.16.1, M1) the entries a visit or call writes as a side effect (its expenditure,
 * its time entry, and their resizing when the visit is edited) are audited as `<entity>.create`/`.update` too, and
 * submitting someone else's time for them (time.submit by a time:all holder: the approver is never the worker)
 * counts as changing it. From 1.24.0 merging another entry into it (`<entity>.merge`, POST /api/time/:id/merge) does too.
 */
function recordedOrChanged(entity, table, id, userId) {
  return !!require('../db').one(`SELECT 1 FROM audit_log WHERE user_id=? AND entity_id=? AND ((entity=? AND action IN (?,?,?,?)) OR (entity=? AND action IN ('sync.overwrite','sync.record'))) LIMIT 1`,
    userId, id, entity, `${entity}.create`, `${entity}.update`, entity === 'time_entry' ? 'time.submit' : `${entity}.create`, `${entity}.merge`, table);
}
/** The push side of recordedOrChanged: an entry a device records under someone else's name is logged as its user's. */
function logRecordedFor(table, row, c) {
  if (!c.existing && row.user_id && row.user_id !== c.user.id) require('../audit').log({ user: c.user, action: 'sync.record', entity: table, entityId: row.id, clientId: row.client_id || null, ip: 'device', details: { for: row.user_id } });
}

module.exports = { periodProblem, ownedBy, officeRuling, officeMarks, assertRulingHere, recordedOrChanged, logRecordedFor };
