'use strict';
// Generic CRUD builder for client-scoped service records with caseload checks and audit logging.
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const { notFound, forbidden, HttpError } = require('./http');
const { validate, paging } = require('./validate');
const { uuid } = require('./crypto');

// Rows built here are presented through withClientName (client code only for a role without clients:read),
// so a de-identified role holding the table's permission (finance: expenditures, time) may still reach a row
// that names a client; auth.canAccessClient refuses it everywhere else.
const DEID = { deidentified: true };

function clientExists(id) { return !!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, id); }

// The joins a list's total needs. A LEFT JOIN on the joined table's primary key (`LEFT JOIN clients c ON
// c.id=…`) finds at most one row for each row of the list, so it cannot change how many there are; when the
// filters do not mention its alias it is left out of the COUNT. At 100,000 visits the lookups it made cost
// 90 ms on every page of the visits list (300 ms with a date range), for a number they could not change.
function countJoins(joins, where) {
  return joins.replace(/\s*LEFT JOIN (\w+) (\w+) ON \2\.id=\w+\.\w+/g, (clause, _table, alias) => (new RegExp(`\\b${alias}\\.`).test(where) ? clause : ''));
}

// ---- optimistic concurrency ----
// Two people editing the same record used to be last-write-wins, silently: the second save put back every
// field the first person had just changed. A form now sends the updated_at it was opened with as
// `if_updated_at`; if the record has changed since, the save is refused with 409 and the person is told to
// reload. A request without the token (sync, imports, API integrations, quick one-field actions such as
// ticking a to-do done) is accepted as before. Handlers are synchronous, so nothing can change the row
// between this check and the UPDATE that follows it.
const STALE_MESSAGE = 'This record was changed by someone else since you opened it. Reload to see their changes.';
function assertFresh(ctx, row, entity) {
  const token = ctx.body && typeof ctx.body === 'object' ? ctx.body.if_updated_at : undefined;
  if (token === undefined || token === null || token === '') return;
  if (row.updated_at && String(token) === String(row.updated_at)) return;
  audit.log({ user: ctx.user, action: `${entity}.update.conflict`, entity, entityId: row.id, clientId: row.client_id || (entity === 'client' ? row.id : null), ip: ctx.ip, success: false });
  throw new HttpError(409, STALE_MESSAGE, { stale: true, updated_at: row.updated_at || null });
}

/**
 * opts: { table, entity, perm, shape (default: the table's rules' fields, plus extraShape), clientRequired, dateCol, ownerCol, unlinked, joins, select, filters(ctx,where,params),
 *   beforeInsert(ctx,v), afterInsert(ctx,row), beforeUpdate(ctx,v,row), afterUpdate(ctx,mergedRow,prevRow),
 *   beforeDelete(ctx,row), afterLoad(ctx,row), canEdit(ctx,row), canDelete(ctx,row), insertResult(ctx,row),
 *   precheck(ctx,v): refuses a new row before anything else (a replay included),
 *   keyedId(ctx,v): true when a new row's id is to come from the request's Idempotency-Key }
 */
function build(r, opts) {
  const { table, entity, perm, dateCol = 'created_at', ownerCol = 'user_id', joins = '', select = `${table}.*`, clientRequired = true } = opts;
  // The table's rules (server/rules/<table>.js) are the one statement of what may be written to it and by whom:
  // its fields are this route's shape, its editableBy is canEdit, its owner rule is restrictOwner, and its check
  // runs on every create and update here exactly as sync push runs it on a device's rows.
  const rules = require('./rules');
  const R = rules.forTable(table, { optional: true });
  const shape = opts.shape || R.shape(opts.extraShape);
  const canEdit = opts.canEdit || (R.editableBy ? (ctx, row) => !R.editableBy(ctx.user, row) : null);
  // A refusal of the rules' own that is not a plain "not yours" (approved time is 409: ask a supervisor to
  // reopen it) is answered as itself; every other refusal keeps the route's 403.
  function assertMayChange(ctx, row, what) {
    if (!opts.canEdit && R.editableBy) { const no = R.editableBy(ctx.user, row); if (no && no.status !== 403 && no.toHttp) throw no.toHttp(); }
    if (canEdit && !canEdit(ctx, row)) throw forbidden(`You cannot ${what} this record`);
  }
  const ownerAll = R.owner && R.owner.col === ownerCol ? R.owner.all : 'records:manage-others';
  const restrictOwner = opts.restrictOwner !== undefined ? opts.restrictOwner : !!(R.owner && R.owner.col === ownerCol);
  const base = opts.base || `/api/${entity}s`;
  const readPerm = `${perm}:read`, writePerm = `${perm}:write`;
  // The permission a device's push of this table needs (server/sync-tables.js writePerm) is this route's: a
  // mismatch is how patient_requests came to need consents:write by sync and patient-requests:write here.
  if (R.sync && R.sync.writePerm && R.sync.writePerm !== writePerm) throw new Error(`crud.build(${table}): server/sync-tables.js says a device needs ${R.sync.writePerm}, this route ${writePerm}`);
  // A row with no client is outside caseload scoping: it is its owners' (or a holder of `all`'s). The rule
  // lives with the table's sync description (sync-tables.js `unlinked`) so a device gets exactly what REST
  // shows; an explicit opts.unlinked overrides it.
  const unlinked = opts.unlinked || (require('./sync-tables').tables.find(t => t.name === table) || {}).unlinked || null;
  const privateTo = (ctx) => (unlinked && !auth.hasPerm(ctx.user, unlinked.all) ? unlinked.owners : null);
  function assertUnlinkedOwner(ctx, row) {
    const owners = row.client_id ? null : privateTo(ctx);
    if (owners && !owners.some(c => row[c] === ctx.user.id)) {
      audit.log({ user: ctx.user, action: 'authz.denied', entity, entityId: row.id, ip: ctx.ip, success: false, details: { reason: 'not the owner' } });
      throw forbidden('That record belongs to another worker');
    }
  }

  function decorate(ctx, rows) { return opts.afterLoad ? rows.map(x => opts.afterLoad(ctx, x)) : rows; }
  function checkClient(ctx, clientId) { if (clientId) { if (!clientExists(clientId)) throw notFound('Client not found'); auth.assertClientAccess(ctx, clientId, DEID); } }

  r.get(base, auth.requireAuth, auth.requirePerm(readPerm, writePerm), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 1000 });
    const where = ['1=1']; const params = [];
    if (clientRequired || opts.hasClient !== false) {
      const cf = auth.caseloadFilter(ctx.user, `${table}.client_id`);
      if (cf.sql !== '1=1') { where.push(`(${table}.client_id IS NULL OR ${cf.sql})`); params.push(...cf.params); }
      const cid = ctx.query.get('client_id'); if (cid) { where.push(`${table}.client_id=?`); params.push(cid); }
      const owners = privateTo(ctx);
      if (owners) { where.push(`(${table}.client_id IS NOT NULL OR ${owners.map(c => `${table}.${c}=?`).join(' OR ')})`); params.push(...owners.map(() => ctx.user.id)); }
    }
    if (ownerCol && ctx.query.get('user_id')) { where.push(`${table}.${ownerCol}=?`); params.push(ctx.query.get('user_id')); }
    if (ownerCol && ctx.query.get('mine') === '1') { where.push(`${table}.${ownerCol}=?`); params.push(ctx.user.id); }
    if (ctx.query.get('from')) { where.push(`${table}.${dateCol} >= ?`); params.push(ctx.query.get('from')); }
    if (ctx.query.get('to')) { where.push(`${table}.${dateCol} <= ?`); params.push(ctx.query.get('to') + (ctx.query.get('to').length === 10 ? 'T23:59:59.999Z' : '')); }
    if (opts.filters) opts.filters(ctx, where, params);
    const w = 'WHERE ' + where.join(' AND ');
    const order = opts.order || `${table}.${dateCol} DESC`;
    const rows = db.all(`SELECT ${select} FROM ${table} ${joins} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM ${table} ${countJoins(joins, w)} ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: `${entity}.list`, ip: ctx.ip, clientId: ctx.query.get('client_id') || null, details: { count: rows.length } });
    return { rows: decorate(ctx, rows), total, limit, offset };
  });

  r.get(`${base}/:id`, auth.requireAuth, auth.requirePerm(readPerm, writePerm), (ctx) => {
    const row = db.one(`SELECT ${select} FROM ${table} ${joins} WHERE ${table}.id=?`, ctx.params.id);
    if (!row) throw notFound();
    if (row.client_id) auth.assertClientAccess(ctx, row.client_id, DEID);
    // A record with no client (a staff time entry, a crisis call from someone not yet a client) is not
    // covered by caseload scoping, so the list view's owner filter has to be applied here too — otherwise it
    // can be read by id alone.
    else assertUnlinkedOwner(ctx, row);
    audit.log({ user: ctx.user, action: `${entity}.view`, entity, entityId: row.id, clientId: row.client_id, ip: ctx.ip });
    return { row: decorate(ctx, [row])[0] };
  });

  r.post(base, auth.requireAuth, auth.requirePerm(writePerm), (ctx) => {
    const v = validate(ctx.body, shape);
    if (clientRequired && !v.client_id) throw require('./http').badRequest('client_id is required');
    checkClient(ctx, v.client_id);
    // A durable answer to a retried save (opts.keyedId, 1.23.0): the row's id is derived from the caller and their
    // Idempotency-Key, so a repeat finds the row it made even after server/idempotency.js has forgotten the key
    // (24 hours): a street-outreach contact kept on a phone while offline may be sent again days later
    // (public/outreach-queue.js). Only this caller's key gives this id. The repeat is answered with the row's id and
    // changes nothing, also when the row has since been deleted (an undone contact is not made again). It is looked
    // for before the write rules (review of 1.23.0): a contact already made is answered as made even when it could not
    // be made today (its supply site retired, its period closed meanwhile), rather than refused and entered again.
    const key = opts.keyedId && opts.keyedId(ctx, v) ? idempotencyKeyOf(ctx) : null;
    const id = key ? keyedId(table, ctx.user.id, key) : uuid();
    if (key) {
      const prior = db.one(`SELECT id, client_id FROM ${table} WHERE id=?`, id);
      const gone = !prior && !!db.one(`SELECT 1 FROM tombstones WHERE table_name=? AND id=?`, table, id);
      if (prior || gone) {
        audit.log({ user: ctx.user, action: `${entity}.create.replayed`, entity, entityId: id, clientId: (prior && prior.client_id) || null, ip: ctx.ip, details: gone ? { deleted: true } : undefined });
        ctx.status = 200; return { id, replayed: true, ...(gone ? { deleted: true } : {}) };
      }
    }
    rules.assertWrite(table, rules.toColumns(table, v), ctx);
    if (opts.precheck) opts.precheck(ctx, v);
    if (opts.beforeInsert) opts.beforeInsert(ctx, v);
    const cols = { id, ...v };
    // validate() turns a blank field into an explicit null, not undefined — an owner picker left on its
    // "defaults to you" blank option (interventions.js's Worker field) must fall back to the caller the same
    // as an owner column the request never mentioned at all, not attempt a NOT NULL insert with nothing in it.
    if (ownerCol && (cols[ownerCol] === undefined || cols[ownerCol] === null || (restrictOwner && !auth.hasPerm(ctx.user, ownerAll)))) cols[ownerCol] = ctx.user.id;
    if (opts.creatorCol) cols[opts.creatorCol] = ctx.user.id;
    const keys = Object.keys(cols).filter(k => cols[k] !== undefined && !k.startsWith('_'));
    // The insert and whatever it triggers (a time entry, a follow-up task, a client field update) are one
    // unit: a failure in the follow-on work must not leave a half-recorded service behind.
    db.transaction(() => {
      db.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
      if (opts.afterInsert) opts.afterInsert(ctx, { id, ...cols });
    });
    audit.log({ user: ctx.user, action: `${entity}.create`, entity, entityId: id, clientId: v.client_id || null, ip: ctx.ip });
    // opts.insertResult: anything the saving form should be told beside the id (a visit's kits that no
    // supply item was there to draw down).
    ctx.status = 201; return { id, ...(opts.insertResult ? opts.insertResult(ctx, { id, ...cols }) : {}) };
  });

  r.put(`${base}/:id`, auth.requireAuth, auth.requirePerm(writePerm), (ctx) => {
    const row = db.one(`SELECT * FROM ${table} WHERE id=?`, ctx.params.id);
    if (!row) throw notFound();
    if (row.client_id) auth.assertClientAccess(ctx, row.client_id, DEID); else assertUnlinkedOwner(ctx, row);
    assertMayChange(ctx, row, 'edit');
    if (!opts.noUpdatedAt) assertFresh(ctx, row, entity);
    const v = validate(ctx.body, Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true, existing: row });
    if (v.client_id && v.client_id !== row.client_id) checkClient(ctx, v.client_id);
    if (restrictOwner && v[ownerCol] !== undefined && !auth.hasPerm(ctx.user, ownerAll)) delete v[ownerCol];
    rules.assertWrite(table, { id: row.id, ...rules.toColumns(table, v) }, ctx, { existing: row });
    if (opts.beforeUpdate) opts.beforeUpdate(ctx, v, row);
    const keys = Object.keys(v).filter(k => v[k] !== undefined && !k.startsWith('_'));
    const stamp = db.now();
    if (keys.length) db.run(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(', ')}${opts.noUpdatedAt ? '' : ', updated_at=?'} WHERE id=?`, ...keys.map(k => v[k]), ...(opts.noUpdatedAt ? [] : [stamp]), row.id);
    if (opts.afterUpdate) opts.afterUpdate(ctx, { ...row, ...v }, row);
    audit.log({ user: ctx.user, action: `${entity}.update`, entity, entityId: row.id, clientId: row.client_id, ip: ctx.ip, details: { fields: keys } });
    // The new version, so a form that stays open (or saves again) sends the right if_updated_at next time.
    // Read back rather than assumed: afterUpdate may have touched the row again.
    return { ok: true, updated_at: opts.noUpdatedAt ? undefined : (db.one(`SELECT updated_at FROM ${table} WHERE id=?`, row.id) || {}).updated_at };
  });

  r.delete(`${base}/:id`, auth.requireAuth, auth.requirePerm(writePerm), (ctx) => {
    const row = db.one(`SELECT * FROM ${table} WHERE id=?`, ctx.params.id);
    if (!row) throw notFound();
    if (row.client_id) auth.assertClientAccess(ctx, row.client_id, DEID); else assertUnlinkedOwner(ctx, row);
    assertMayChange(ctx, row, 'delete');
    if (opts.canDelete && !opts.canDelete(ctx, row)) throw forbidden('You cannot delete this record');
    if (opts.beforeDelete) opts.beforeDelete(ctx, row);
    db.run(`DELETE FROM ${table} WHERE id=?`, row.id); db.tombstone(table, row.id);
    audit.log({ user: ctx.user, action: `${entity}.delete`, entity, entityId: row.id, clientId: row.client_id, ip: ctx.ip });
    return { ok: true };
  });
}

// The Idempotency-Key a request carries (server/idempotency.js checks its form), or null.
function idempotencyKeyOf(ctx) {
  const k = ctx.headers && ctx.headers['idempotency-key'];
  return typeof k === 'string' && k && k.length <= 255 && /^[\x21-\x7e]+$/.test(k) ? k : null;
}
/** A row id from (table, user, key): the same three always give the same id, shaped as a version-4 UUID. */
function keyedId(table, userId, key) {
  const x = require('./crypto').sha256(`keyed-id|${table}|${userId}|${key}`);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-${'89ab'[parseInt(x[16], 16) & 3]}${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

// owner-or-supervisor edit rule
function ownerOrManager(col = 'user_id') {
  return (ctx, row) => row[col] === ctx.user.id || auth.hasPerm(ctx.user, 'records:manage-others');
}

module.exports = { build, ownerOrManager, clientExists, assertFresh, keyedId, STALE_MESSAGE };
