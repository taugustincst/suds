'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { notFound } = require('../http');
const { validate, paging } = require('../validate');
const { uuid } = require('../crypto');
const C = require('../constants');

const shape = {
  name: { type: 'string', required: true, maxLen: 200 }, category: { type: 'string', required: true, enum: C.RESOURCE_CATEGORIES }, organization: { type: 'string', maxLen: 200 },
  phone: { type: 'string', maxLen: 40 }, fax: { type: 'string', maxLen: 40 }, email: { type: 'string', maxLen: 200 }, website: { type: 'string', maxLen: 300 }, address: { type: 'string', maxLen: 300 },
  city: { type: 'string', maxLen: 100 }, zip: { type: 'string', maxLen: 12 }, hours: { type: 'string', maxLen: 200 }, eligibility: { type: 'string', maxLen: 1000 }, services: { type: 'string', maxLen: 1000 },
  languages: { type: 'string', maxLen: 200 }, accepts_medicaid: { type: 'boolean' }, accepts_uninsured: { type: 'boolean' }, mat_offered: { type: 'string', maxLen: 200 }, capacity_notes: { type: 'string', maxLen: 1000 },
  contact_person: { type: 'string', maxLen: 200 }, is_active: { type: 'boolean' }, last_verified_at: { type: 'date' }, notes: { type: 'string', maxLen: 2000 },
};

module.exports = (r) => {
  r.get('/api/resources', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 200, max: 1000 });
    const where = []; const params = [];
    const q = (ctx.query.get('q') || '').trim(); if (q) { where.push('(name LIKE ? OR organization LIKE ? OR services LIKE ? OR city LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const cat = ctx.query.get('category'); if (cat) { where.push('category=?'); params.push(cat); }
    if (ctx.query.get('active') !== '0') where.push('is_active=1');
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.all(`SELECT r.*, (SELECT COUNT(*) FROM referrals x WHERE x.resource_id=r.id) AS referral_count FROM resources r ${w} ORDER BY category, name LIMIT ? OFFSET ?`, ...params, limit, offset);
    return { rows, total: db.one(`SELECT COUNT(*) n FROM resources r ${w}`, ...params).n };
  });
  r.get('/api/resources/:id', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), (ctx) => {
    const row = db.one(`SELECT * FROM resources WHERE id=?`, ctx.params.id); if (!row) throw notFound();
    row.referral_stats = db.all(`SELECT status, COUNT(*) n FROM referrals WHERE resource_id=? GROUP BY status`, row.id);
    return { row };
  });
  r.post('/api/resources', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const v = validate(ctx.body, shape); const id = uuid();
    const keys = Object.keys(v);
    db.run(`INSERT INTO resources(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, id, ...keys.map(k => v[k]));
    audit.log({ user: ctx.user, action: 'resource.create', entity: 'resource', entityId: id, ip: ctx.ip });
    ctx.status = 201; return { id };
  });
  r.put('/api/resources/:id', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const row = db.one(`SELECT id FROM resources WHERE id=?`, ctx.params.id); if (!row) throw notFound();
    const v = validate(ctx.body, { ...shape, name: { ...shape.name, required: false }, category: { ...shape.category, required: false } }, { partial: true });
    const keys = Object.keys(v); if (!keys.length) return { ok: true };
    db.run(`UPDATE resources SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => v[k]), db.now(), row.id);
    audit.log({ user: ctx.user, action: 'resource.update', entity: 'resource', entityId: row.id, ip: ctx.ip, details: { fields: keys } });
    return { ok: true };
  });
  r.delete('/api/resources/:id', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const row = db.one(`SELECT id FROM resources WHERE id=?`, ctx.params.id); if (!row) throw notFound();
    db.run(`UPDATE resources SET is_active=0, updated_at=? WHERE id=?`, db.now(), row.id);
    audit.log({ user: ctx.user, action: 'resource.deactivate', entity: 'resource', entityId: row.id, ip: ctx.ip });
    return { ok: true };
  });
};
