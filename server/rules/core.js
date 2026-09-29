'use strict';
// The building blocks of a table's rules (server/rules/<table>.js): how one is declared, what a refusal is, and
// the field checks both doors apply. A table's rules are the one statement of what may be written to it and by
// whom; the REST routes (server/crud.js and the hand-written ones) and sync push (server/rules/push.js) both
// call them, so a rule added for one door is enforced at the other.
//
// A declaration, all keys optional except `table`:
//   fields      the stored fields as the REST API names them (a validate.js shape): `x` is column `x_enc` when that
//               column is encrypted, or `column: 'name'` says otherwise; `fromColumn(v)` turns a stored value into
//               the API's form (a JSON array or object); `sync: false` marks a request-only field (log_time).
//   owner       { col, all }: the column saying who did the work, and the permission that may name someone else.
//   editableBy(user, row)   null, or a refusal: who may change an existing row (REST canEdit, push edits).
//   deletableBy(user, row)  the same for deleting it (defaults to editableBy); return 'skip' to keep it quietly.
//   othersMayChange(existing, row, changed)  true for an edit another worker's device makes as a side effect of
//               its own work (a discharge cancelling the client's to-dos) that editableBy would otherwise refuse.
//   deviceColumns  the columns besides `fields` a device may send (a status the table's rules move, a parent's
//               id); with the fields, the table's client, parent, self-parent and owner columns they are all a
//               push may write. Anything else a device sends is dropped: a column is the office's unless declared.
//   createdBy   the columns saying who created a row (created_by, disclosed_by...): on push, the syncing user
//               for a new row and the office's value after, whoever the device named. updatedBy: the syncing
//               user on every write.
//   module      the programme module (server/programme.js) whose switch gates new work in this table.
//   immutable   true: a device may add rows, never change them; allowChange(existing, row, changed, c) names the
//               one change that is allowed (a consent's revocation) by returning the columns it may write.
//   tombstone   'never': rows are never hard-deleted by sync (the legal record).
//   authorise(row, c), check(row, c)   null, a refusal, or a list of them: who may write this row, and whether its
//               values hang together. `row` is the row as stored (encrypted columns in plain text for what is
//               being written); c.existing is the stored row being changed (null for a new one), c.was(col) one
//               of its columns in plain text, c.plain(col) a column's value after this write, c.changed() the
//               columns this write changes, c.via 'rest' or 'sync' (c.session is the push, for push-only hooks).
//   normalise(row, c)   push only: columns the office keeps for itself (approvals, signatures), or derives.
//   Push-only hooks, in the order push.js calls them: prepare(session, rows) once per push, order(rows, session),
//   permitsWithoutWritePerm(row, session), outsideCaseload(row, c), beforeWrite(row, c), beforeStore(row, c),
//   storeRow(stored, row, c), afterApply(row, stored, c), afterDelete(storedRow, session) after a tombstone lands,
//   finish(session) once every row and tombstone of the push has landed; pushable: false for a table a device never
//   writes.
const { validate } = require('../validate');
const { HttpError } = require('../http');

/**
 * Why a row cannot be written. `reason` is what a device is told (phrased as one of sync-tables.js's
 * permanent reasons when a retry can never succeed); `message`, `status` and `fields` are the REST answer.
 * `flag`: on push the row still lands and the device and the audit trail are told (work done offline is not
 * thrown away because the office's lists or switches changed while the phone was out); REST always refuses.
 */
class Refusal {
  constructor(reason, { status = 400, message, fields, flag = false, permanent, extra, code } = {}) {
    this.reason = reason; this.status = status; this.message = message || reason; this.fields = fields;
    this.flag = flag; this.permanent = permanent; this.extra = extra; this.code = code;
  }
  toHttp() { return new HttpError(this.status, this.message, this.fields || this.extra ? { ...(this.extra || {}), ...(this.fields ? { fields: this.fields } : {}) } : undefined); }
}
const refuse = (reason, opts) => new Refusal(reason, opts);
const flag = (reason, opts) => new Refusal(reason, { ...opts, flag: true });
const notPermitted = (message, reason = 'not permitted') => new Refusal(reason, { status: 403, message });

/** A list of refusals from a check (null, one, or several), without the empties. */
function refusals(x) { return (Array.isArray(x) ? x : [x]).filter(Boolean); }

/** The column an API field is stored in. */
function columnOf(t, field, rule) {
  if (rule && rule.column) return rule.column;
  return t && (t.enc || []).includes(`${field}_enc`) ? `${field}_enc` : field;
}

function define(spec) {
  if (!spec || !spec.table) throw new Error('rules: a declaration needs its table');
  const SYNC = require('../sync-tables');
  const t = SYNC.tables.find(x => x.name === spec.table);
  const fields = spec.fields || {};
  const columns = {};
  for (const [k, rule] of Object.entries(fields)) if (rule.sync !== false) columns[k] = columnOf(t, k, rule);
  // Worked out once, not per pushed row: [field, column, rule] for every stored field, and their shape.
  const stored = Object.entries(columns).map(([k, col]) => [k, col, fields[k]]);
  const storedShape = Object.fromEntries(stored.map(([k, , rule]) => [k, rule]));
  // What a push may write (push.js confine): the columns above, and the row's own id and bookkeeping times.
  const writable = new Set(['id', 'created_at', 'updated_at', ...Object.values(columns), ...(spec.deviceColumns || []),
    ...(t ? [t.clientCol, t.parent && t.parent[1], t.selfParent] : []), spec.owner && spec.owner.col].filter(Boolean));
  return ({
    fields, owner: null, module: null, immutable: false, tombstone: null, createdBy: [], updatedBy: [],
    ...spec,
    sync: t || null,
    columns, stored, storedShape, writable,
    /** The REST shape: every field, request-only ones included. */
    shape(overrides = {}) { return { ...fields, ...overrides }; },
    /** The same shape with nothing required, for a partial update. */
    partialShape(overrides = {}) { return Object.fromEntries(Object.entries({ ...fields, ...overrides }).map(([k, s]) => [k, { ...s, required: false }])); },
  });
}

/** An API-form view of a stored row, for the stored fields `only` names (all when omitted). */
function apiView(R, row, only) {
  const out = {};
  for (const [k, col, rule] of R.stored) {
    if (only && !only.has(k)) continue;
    let v = row[col];
    if (v === undefined) continue;
    if (rule.fromColumn && v !== null && v !== '') { try { v = rule.fromColumn(v); } catch { v = { __unreadable: true }; } }
    out[k] = v;
  }
  return out;
}

/**
 * Check a pushed row's stored fields against the table's REST shape. A new row is checked whole; an existing
 * one only in the fields it changes (`changed`: API field names), as a REST update is. Returns refusals:
 * a wrong type, a value outside a fixed set, a range or a missing required value is refused for good; a
 * value off a programme-managed list (Settings → Lists) or over a length limit is flagged instead — the
 * device accepted it under the lists it had when it was offline, and throwing the visit away helps nobody.
 */
function checkFields(R, row, { existing = null, changed = null } = {}) {
  let shape = R.storedShape;
  if (changed) { shape = {}; for (const k of changed) shape[k] = R.fields[k]; if (!changed.size) return []; }
  const view = apiView(R, row, changed);
  const existingView = existing ? apiView(R, existing) : null;
  try { validate(view, shape, { partial: !!existing, existing: existingView }); return []; }
  catch (e) {
    const errs = (e.extra && e.extra.fields) || {};
    const out = [];
    for (const [k, msg] of Object.entries(errs)) {
      const rule = shape[k] || {};
      const v = view[k];
      const onList = rule.list && /^must be one of/.test(msg) && !(rule.enum && typeof v === 'string' && !rule.enum.includes(v.trim()));
      const tooLong = /^max length/.test(msg);
      if (msg === 'required') out.push(refuse(`is missing a required field (${k})`, { fields: { [k]: msg } }));
      else if (onList || tooLong) out.push(flag(`was accepted, but its ${k.replace(/_/g, ' ')} ${onList ? 'is not one of the choices the office offers now' : `is longer than the office allows (${msg.replace('max length ', '')} characters)`}; the office will review it`, { fields: { [k]: msg }, code: onList ? 'list' : 'length' }));
      else out.push(refuse(`has a value the office does not accept (${k}: ${/^must be one of/.test(msg) ? 'not one of the values it accepts' : msg})`, { fields: { [k]: msg } }));
    }
    return out;
  }
}

/** Throw the first refusal as an HTTP error (the REST door). */
function assertNone(x) { const r = refusals(x); if (r.length) throw r[0].toHttp(); }

module.exports = { Refusal, refuse, flag, notPermitted, refusals, define, columnOf, apiView, checkFields, assertNone };
