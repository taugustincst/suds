'use strict';
// Generic CRUD builder for client-scoped service records with caseload checks and audit logging.
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const { notFound, forbidden } = require('./http');
const { validate, paging } = require('./validate');
const { uuid } = require('./crypto');

function clientExists(id) { return !!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, id); }

/**
 * opts: { table, entity, perm, shape, clientRequired, dateCol, ownerCol, joins, select, filters(ctx,where,params), beforeInsert(ctx,v), afterLoad(ctx,row), canEdit(ctx,row) }
 */
function build(r, opts) {
  const { table, entity, perm, shape, dateCol = 'created_at', ownerCol = 'user_id', joins = '', select = `${table}.*`, clientRequired = true } = opts;
  const base = opts.base || `/api/${entity}s`;
  const readPerm = `${perm}:read`, writePerm = `${perm}:write`;

  function decorate(ctx, rows) { return opts.afterLoad ? rows.map(x => opts.afterLoad(ctx, x)) : rows; }
  function checkClient(ctx, clientId) { if (clientId) { if (!clientExists(clientId)) throw notFound('Client not found'); auth.assertClientAccess(ctx, clientId); } }

  r.get(base, auth.requireAuth, auth.requirePerm(readPerm, writePerm), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 1000 });
    const where = ['1=1']; const params = [];
    if (clientRequired || opts.hasClient !== false) {
      const cf = auth.caseloadFilter(ctx.user, `${table}.client_id`);
      if (cf.sql !== '1=1') { where.push(`(${table}.client_id IS NULL OR ${cf.sql})`); params.push(...cf.params); }
      const cid = ctx.query.get('client_id'); if (cid) { where.push(`${table}.client_id=?`); params.push(cid); }
    }
    if (ownerCol && ctx.query.get('user_id')) { where.push(`${table}.${ownerCol}=?`); params.push(ctx.query.get('user_id')); }
    if (ownerCol && ctx.query.get('mine') === '1') { where.push(`${table}.${ownerCol}=?`); params.push(ctx.user.id); }
    if (ctx.query.get('from')) { where.push(`${table}.${dateCol} >= ?`); params.push(ctx.query.get('from')); }
    if (ctx.query.get('to')) { where.push(`${table}.${dateCol} <= ?`); params.push(ctx.query.get('to') + (ctx.query.get('to').length === 10 ? 'T23:59:59.999Z' : '')); }
    if (opts.filters) opts.filters(ctx, where, params);
    const w = 'WHERE ' + where.join(' AND ');
    const order = opts.order || `${table}.${dateCol} DESC`;
    const rows = db.all(`SELECT ${select} FROM ${table} ${joins} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = db.one(`SELECT COUNT(*) n FROM ${table} ${joins} ${w}`, ...params).n;
    audit.log({ user: ctx.user, action: `${entity}.list`, ip: ctx.ip, clientId: ctx.query.get('client_id') || null, details: { count: rows.length } });
    return { rows: decorate(ctx, rows), total, limit, offset };
  });

  r.get(`${base}/:id`, auth.requireAuth, auth.requirePerm(readPerm, writePerm), (ctx) => {
    const row = db.one(`SELECT ${select} FROM ${table} ${joins} WHERE ${table}.id=?`, ctx.params.id);
    if (!row) throw notFound();
    if (row.client_id) auth.assertClientAccess(ctx, row.client_id);
    // A record with no client (a staff time entry, a program to-do) is not covered by caseload scoping, so
    // the list view's owner filter has to be applied here too — otherwise it can be read by id alone.
    else if (opts.ownerOnly && row[ownerCol] !== ctx.user.id && !auth.hasPerm(ctx.user, opts.ownerOnly)) {
      audit.log({ user: ctx.user, action: 'authz.denied', entity, entityId: row.id, ip: ctx.ip, success: false, details: { reason: 'not the owner' } });
      throw forbidden('That record belongs to another worker');
    }
    audit.log({ user: ctx.user, action: `${entity}.view`, entity, entityId: row.id, clientId: row.client_id, ip: ctx.ip });
    return { row: decorate(ctx, [row])[0] };
  });

  r.post(base, auth.requireAuth, auth.requirePerm(writePerm), (ctx) => {
    const v = validate(ctx.body, shape);
    if (clientRequired && !v.client_id) throw require('./http').badRequest('client_id is required');
    checkClient(ctx, v.client_id);
    if (opts.beforeInsert) opts.beforeInsert(ctx, v);
    const id = uuid();
    const cols = { id, ...v };
    if (ownerCol && (cols[ownerCol] === undefined || (opts.restrictOwner && !auth.hasPerm(ctx.user, 'clients:all')))) cols[ownerCol] = ctx.user.id;
    if (opts.creatorCol) cols[opts.creatorCol] = ctx.user.id;
    const keys = Object.keys(cols).filter(k => cols[k] !== undefined && !k.startsWith('_'));
    // The insert and whatever it triggers (a time entry, a follow-up task, a client field update) are one
    // unit: a failure in the follow-on work must not leave a half-recorded service behind.
    db.transaction(() => {
      db.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
      if (opts.afterInsert) opts.afterInsert(ctx, { id, ...cols });
    });
    audit.log({ user: ctx.user, action: `${entity}.create`, entity, entityId: id, clientId: v.client_id || null, ip: ctx.ip });
    ctx.status = 201; return { id };
  });

  r.put(`${base}/:id`, auth.requireAuth, auth.requirePerm(writePerm), (ctx) => {
    const row = db.one(`SELECT * FROM ${table} WHERE id=?`, ctx.params.id);
    if (!row) throw notFound();
    if (row.client_id) auth.assertClientAccess(ctx, row.client_id);
    if (opts.canEdit && !opts.canEdit(ctx, row)) throw forbidden('You cannot edit this record');
    const v = validate(ctx.body, Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true });
    if (v.client_id && v.client_id !== row.client_id) checkClient(ctx, v.client_id);
    if (opts.restrictOwner && v[ownerCol] !== undefined && !auth.hasPerm(ctx.user, 'clients:all')) delete v[ownerCol];
    if (opts.beforeUpdate) opts.beforeUpdate(ctx, v, row);
    const keys = Object.keys(v).filter(k => v[k] !== undefined && !k.startsWith('_'));
    if (keys.length) db.run(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(', ')}${opts.noUpdatedAt ? '' : ', updated_at=?'} WHERE id=?`, ...keys.map(k => v[k]), ...(opts.noUpdatedAt ? [] : [db.now()]), row.id);
    audit.log({ user: ctx.user, action: `${entity}.update`, entity, entityId: row.id, clientId: row.client_id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true };
  });

  r.delete(`${base}/:id`, auth.requireAuth, auth.requirePerm(writePerm), (ctx) => {
    const row = db.one(`SELECT * FROM ${table} WHERE id=?`, ctx.params.id);
    if (!row) throw notFound();
    if (row.client_id) auth.assertClientAccess(ctx, row.client_id);
    if (opts.canEdit && !opts.canEdit(ctx, row)) throw forbidden('You cannot delete this record');
    if (opts.canDelete && !opts.canDelete(ctx, row)) throw forbidden('You cannot delete this record');
    db.run(`DELETE FROM ${table} WHERE id=?`, row.id); db.tombstone(table, row.id);
    audit.log({ user: ctx.user, action: `${entity}.delete`, entity, entityId: row.id, clientId: row.client_id, ip: ctx.ip });
    return { ok: true };
  });
}

// owner-or-supervisor edit rule
function ownerOrManager(col = 'user_id') {
  return (ctx, row) => row[col] === ctx.user.id || auth.hasPerm(ctx.user, 'clients:all');
}

module.exports = { build, ownerOrManager, clientExists };
