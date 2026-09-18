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
  summary: { type: 'string', maxLen: 3000 }, service_tags: { type: 'string', maxLen: 1000 }, levels_of_care: { type: 'string', maxLen: 200 }, populations: { type: 'string', maxLen: 500 }, intake_process: { type: 'string', maxLen: 2000 }, cost_notes: { type: 'string', maxLen: 1000 },
};
const MAX_PHOTOS = 12, MAX_PHOTO_BYTES = 2 * 1024 * 1024, MAX_THUMB_BYTES = 96 * 1024;
const { badRequest } = require('../http');
// Accept only real picture bytes (magic numbers), never trusting the declared type.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function fromDataUrl(v, maxBytes, label) {
  if (typeof v !== 'string') throw badRequest(`${label} is required`);
  const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(v); const b64 = m ? m[2].replace(/\s+/g, '') : v.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw badRequest(`${label} must be a base64 picture`);
  const buf = Buffer.from(b64, 'base64'); if (!buf.length) throw badRequest(`${label} is empty`);
  if (buf.length > maxBytes) throw badRequest(`${label} is too large (max ${Math.round(maxBytes / 1024)} KB); the app normally shrinks pictures before sending them`);
  const type = sniff(buf); if (!type) throw badRequest(`${label} must be a JPEG, PNG or WebP picture`);
  return { b64, buf, type };
}
const b64Type = (b) => !b ? null : b.startsWith('iVBOR') ? 'image/png' : b.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
const tagList = (v, allowed) => v == null ? v : String(v).split(',').map(x => x.trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(x => allowed.includes(x)).filter((x, i, a) => a.indexOf(x) === i).join(',');
function photoRows(resourceId, withData = false) {
  // Pictures are referenced by URL, never inlined. A directory of a few hundred providers with photos
  // would otherwise make the list response tens of megabytes of base64 for a phone to parse.
  return db.all(`SELECT id, resource_id, caption, content_type, bytes, width, height, sort_order, uploaded_by, created_at, thumb_b64 IS NOT NULL AS has_thumb FROM resource_photos WHERE resource_id=? ORDER BY sort_order, created_at`, resourceId)
    .map(p => ({ ...p, has_thumb: !!p.has_thumb, thumb_url: p.has_thumb ? `/api/resources/${p.resource_id}/photos/${p.id}/thumb` : null, data_url: `/api/resources/${p.resource_id}/photos/${p.id}/image` }));
}

module.exports = (r) => {
  r.get('/api/resources', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 200, max: 1000 });
    const where = []; const params = [];
    const q = (ctx.query.get('q') || '').trim(); if (q) { where.push('(name LIKE ? OR organization LIKE ? OR services LIKE ? OR city LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const cat = ctx.query.get('category'); if (cat) { where.push('category=?'); params.push(cat); }
    if (ctx.query.get('active') !== '0') where.push('is_active=1');
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.all(`SELECT r.*, (SELECT COUNT(*) FROM referrals x WHERE x.resource_id=r.id) AS referral_count, (SELECT COUNT(*) FROM resource_photos p WHERE p.resource_id=r.id) AS photo_count, (SELECT p.id FROM resource_photos p WHERE p.resource_id=r.id AND p.thumb_b64 IS NOT NULL ORDER BY p.sort_order, p.created_at LIMIT 1) AS cover_photo_id FROM resources r ${w} ORDER BY category, name LIMIT ? OFFSET ?`, ...params, limit, offset)
      .map(r => ({ ...r, cover_url: r.cover_photo_id ? `/api/resources/${r.id}/photos/${r.cover_photo_id}/thumb` : null }));
    return { rows, total: db.one(`SELECT COUNT(*) n FROM resources r ${w}`, ...params).n };
  });
  r.get('/api/resources/:id', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), (ctx) => {
    const row = db.one(`SELECT * FROM resources WHERE id=?`, ctx.params.id); if (!row) throw notFound();
    row.referral_stats = db.all(`SELECT status, COUNT(*) n FROM referrals WHERE resource_id=? GROUP BY status`, row.id);
    row.photos = photoRows(row.id, true);
    row.recent_referrals = auth.hasPerm(ctx.user, 'clients:read') ? db.all(`SELECT r.id, r.referred_at, r.status, r.client_id, c.client_code FROM referrals r JOIN clients c ON c.id=r.client_id WHERE r.resource_id=? AND c.deleted_at IS NULL AND ${auth.caseloadFilter(ctx.user, 'c.id').sql} ORDER BY r.referred_at DESC LIMIT 10`, row.id, ...auth.caseloadFilter(ctx.user, 'c.id').params) : [];
    return { row };
  });
  // ---- photo gallery ----
  r.get('/api/resources/:id/photos', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), (ctx) => {
    if (!db.one(`SELECT id FROM resources WHERE id=?`, ctx.params.id)) throw notFound();
    return { photos: photoRows(ctx.params.id, ctx.query.get('full') === '1') };
  });
  // Pictures are served as ordinary cacheable images rather than base64 inside a JSON list. They contain
  // no PHI — they are photographs of treatment centres — but they still require a signed-in session.
  function sendPhoto(ctx, column) {
    const p = db.one(`SELECT * FROM resource_photos WHERE id=? AND resource_id=?`, ctx.params.pid, ctx.params.id);
    if (!p || !p[column]) throw notFound('Picture not found');
    const body = Buffer.from(p[column], 'base64');
    const etag = `"${require('../crypto').sha256(p.id + (p.updated_at || p.created_at) + column).slice(0, 32)}"`;
    if (ctx.headers['if-none-match'] === etag) { ctx.res.writeHead(304, { ETag: etag }); ctx.res.end(); return null; }
    ctx.res.writeHead(200, {
      'Content-Type': column === 'thumb_b64' ? b64Type(p.thumb_b64) : p.content_type,
      'Content-Length': body.length, ETag: etag,
      'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
    });
    ctx.res.end(body);
    return null;
  }
  r.get('/api/resources/:id/photos/:pid/thumb', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), (ctx) => sendPhoto(ctx, 'thumb_b64'));
  r.get('/api/resources/:id/photos/:pid/image', auth.requireAuth, auth.requirePerm('resources:read', 'resources:write'), (ctx) => sendPhoto(ctx, 'data_b64'));

  r.post('/api/resources/:id/photos', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const res = db.one(`SELECT id FROM resources WHERE id=?`, ctx.params.id); if (!res) throw notFound();
    if (db.one(`SELECT COUNT(*) n FROM resource_photos WHERE resource_id=?`, res.id).n >= MAX_PHOTOS) throw badRequest(`A resource can have at most ${MAX_PHOTOS} pictures; remove one first`);
    const v = validate(ctx.body, { caption: { type: 'string', maxLen: 200 }, width: { type: 'number', min: 1, max: 20000, integer: true }, height: { type: 'number', min: 1, max: 20000, integer: true } });
    const pic = fromDataUrl(ctx.body.data_url ?? ctx.body.data, MAX_PHOTO_BYTES, 'Picture');
    const thumb = ctx.body.thumb_url || ctx.body.thumb ? fromDataUrl(ctx.body.thumb_url ?? ctx.body.thumb, MAX_THUMB_BYTES, 'Thumbnail') : null;
    const id = uuid(); const order = (db.one(`SELECT COALESCE(MAX(sort_order), -1) m FROM resource_photos WHERE resource_id=?`, res.id).m) + 1;
    db.run(`INSERT INTO resource_photos(id,resource_id,caption,content_type,bytes,width,height,data_b64,thumb_b64,sort_order,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, res.id, v.caption || null, pic.type, pic.buf.length, v.width || null, v.height || null, pic.b64, thumb ? thumb.b64 : null, order, ctx.user.id);
    db.run(`UPDATE resources SET updated_at=? WHERE id=?`, db.now(), res.id);
    audit.log({ user: ctx.user, action: 'resource.photo.add', entity: 'resource', entityId: res.id, ip: ctx.ip, details: { photo_id: id, bytes: pic.buf.length, type: pic.type } });
    ctx.status = 201; return { id, photo: photoRows(res.id).find(p => p.id === id) };
  });
  r.put('/api/resources/:id/photos/:pid', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const p = db.one(`SELECT id, resource_id FROM resource_photos WHERE id=? AND resource_id=?`, ctx.params.pid, ctx.params.id); if (!p) throw notFound();
    const v = validate(ctx.body, { caption: { type: 'string', maxLen: 200 }, sort_order: { type: 'number', min: 0, max: 1000, integer: true } }, { partial: true });
    if (v.sort_order !== undefined && v.sort_order !== null) {
      // move to position: renumber the others around it
      const others = db.all(`SELECT id FROM resource_photos WHERE resource_id=? AND id<>? ORDER BY sort_order, created_at`, p.resource_id, p.id).map(x => x.id);
      others.splice(Math.min(v.sort_order, others.length), 0, p.id);
      others.forEach((id, i) => db.run(`UPDATE resource_photos SET sort_order=?, updated_at=? WHERE id=?`, i, db.now(), id));
    }
    if (v.caption !== undefined) db.run(`UPDATE resource_photos SET caption=?, updated_at=? WHERE id=?`, v.caption, db.now(), p.id);
    audit.log({ user: ctx.user, action: 'resource.photo.update', entity: 'resource', entityId: p.resource_id, ip: ctx.ip, details: { photo_id: p.id, fields: Object.keys(v) } });
    return { ok: true };
  });
  r.delete('/api/resources/:id/photos/:pid', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const p = db.one(`SELECT id, resource_id FROM resource_photos WHERE id=? AND resource_id=?`, ctx.params.pid, ctx.params.id); if (!p) throw notFound();
    db.run(`DELETE FROM resource_photos WHERE id=?`, p.id); db.tombstone('resource_photos', p.id);
    db.run(`UPDATE resources SET updated_at=? WHERE id=?`, db.now(), p.resource_id);
    audit.log({ user: ctx.user, action: 'resource.photo.remove', entity: 'resource', entityId: p.resource_id, ip: ctx.ip, details: { photo_id: p.id } });
    return { ok: true };
  });
  r.post('/api/resources', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const v = validate(ctx.body, shape); const id = uuid();
    if ('service_tags' in v) v.service_tags = tagList(v.service_tags, C.SERVICE_TAGS); if ('populations' in v) v.populations = tagList(v.populations, C.POPULATIONS);
    const keys = Object.keys(v);
    db.run(`INSERT INTO resources(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, id, ...keys.map(k => v[k]));
    audit.log({ user: ctx.user, action: 'resource.create', entity: 'resource', entityId: id, ip: ctx.ip });
    ctx.status = 201; return { id };
  });
  r.put('/api/resources/:id', auth.requireAuth, auth.requirePerm('resources:write'), (ctx) => {
    const row = db.one(`SELECT id FROM resources WHERE id=?`, ctx.params.id); if (!row) throw notFound();
    const v = validate(ctx.body, { ...shape, name: { ...shape.name, required: false }, category: { ...shape.category, required: false } }, { partial: true });
    if ('service_tags' in v) v.service_tags = tagList(v.service_tags, C.SERVICE_TAGS); if ('populations' in v) v.populations = tagList(v.populations, C.POPULATIONS);
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
