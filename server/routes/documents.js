'use strict';
// County policy/procedure/contract library: upload a file, describe it, find it again by title, category,
// or a phrase from inside it. No PHI here. The text of a PDF/Word/plain-text file is pulled out on upload
// with Node built-ins (server/doc-text.js) so a policy can be found by what it says; a scan or picture is
// still findable by title and description.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');
const { extractText } = require('../doc-text');

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc', 'text/plain': 'txt' };
function sniff(buf) {
  if (buf.length > 4 && buf.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (buf.length > 8 && buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) return 'application/msword';
  return null;
}
function fromDataUrl(v, maxBytes, label) {
  if (typeof v !== 'string' || !v) return null;
  const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(v); const b64 = (m ? m[2] : v).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw badRequest(`${label} must be base64`);
  const buf = Buffer.from(b64, 'base64'); if (!buf.length) throw badRequest(`${label} is empty`);
  if (buf.length > maxBytes) throw badRequest(`${label} is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  const type = sniff(buf) || (m && m[1] === 'text/plain' ? 'text/plain' : null);
  if (!type || !FILE_TYPES[type]) throw badRequest(`${label} must be a PDF, Word document, picture or text file`);
  return { b64, buf, type };
}
// Same reasoning as forms.js's SERVABLE_TYPES: an uploaded file's declared type is attacker-chosen, so only
// the types this library actually deals in are ever echoed back as a servable Content-Type.
const SERVABLE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
function safeContentType(t) { return SERVABLE_TYPES.has(String(t || '').toLowerCase().split(';')[0].trim()) ? String(t).split(';')[0].trim() : 'application/octet-stream'; }

const shape = { title: { type: 'string', required: true, maxLen: 200 }, category: { type: 'string', required: true, enum: C.DOCUMENT_CATEGORIES }, description: { type: 'string', maxLen: 2000 }, effective_date: { type: 'date' }, expires_at: { type: 'date' }, filename: { type: 'string', maxLen: 200 } };
const out = (row) => row && ({ ...row, has_file: !!row.file_b64, searchable: !!row.search_text, file_b64: undefined, search_text: undefined });

module.exports = (r) => {
  r.get('/api/documents', auth.requireAuth, auth.requirePerm('documents:read'), (ctx) => {
    const all = ctx.query.get('all') === '1' && auth.hasPerm(ctx.user, 'documents:write');
    const cat = ctx.query.get('category');
    const q = (ctx.query.get('q') || '').trim().toLowerCase();
    const where = []; const params = [];
    if (!all) where.push('is_active=1');
    if (cat) { where.push('category=?'); params.push(cat); }
    // Every word must appear somewhere in the title, description or the file's own text.
    for (const word of q.split(/\s+/).filter(Boolean)) { where.push(`(lower(title) LIKE ? ESCAPE '\\' OR lower(COALESCE(description,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(search_text,'')) LIKE ? ESCAPE '\\')`); const like = `%${word.replace(/[%_]/g, '\\$&')}%`; params.push(like, like, like); }
    const rows = db.all(`SELECT id,title,category,description,effective_date,expires_at,filename,content_type,bytes,is_active,uploaded_by,created_at,updated_at, (file_b64 IS NOT NULL) has_file, (search_text IS NOT NULL AND search_text<>'') searchable, search_text
      FROM policy_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, title`, ...params);
    // A few words around the first match, so the reader can see why this document came up.
    const snippet = (text) => { if (!q || !text) return null; const t = String(text); const i = t.toLowerCase().indexOf(q.split(/\s+/)[0]); if (i < 0) return null; const s = Math.max(0, i - 60), e = Math.min(t.length, i + 100); return (s ? '…' : '') + t.slice(s, e) + (e < t.length ? '…' : ''); };
    return { documents: rows.map(r => ({ ...r, snippet: snippet(r.search_text), search_text: undefined })), categories: C.DOCUMENT_CATEGORIES };
  });
  // A retired document is restricted to documents:write the same as the list route restricts it — reachable
  // by a bookmarked/guessed id otherwise, which would defeat the point of retiring something.
  function loadVisible(ctx, id) {
    const d = db.one(`SELECT * FROM policy_documents WHERE id=?`, id); if (!d) throw notFound();
    if (!d.is_active && !auth.hasPerm(ctx.user, 'documents:write')) throw notFound();
    return d;
  }
  r.get('/api/documents/:id', auth.requireAuth, auth.requirePerm('documents:read'), (ctx) => {
    const d = loadVisible(ctx, ctx.params.id);
    audit.log({ user: ctx.user, action: 'document.view', entity: 'policy_document', entityId: d.id, ip: ctx.ip });
    return { document: out(d) };
  });
  r.post('/api/documents', auth.requireAuth, auth.requirePerm('documents:write'), (ctx) => {
    const v = validate(ctx.body, shape);
    const file = fromDataUrl(ctx.body.file_url ?? ctx.body.file, MAX_DOCUMENT_BYTES, 'File');
    if (!file) throw badRequest('A file is required');
    const id = uuid();
    db.run(`INSERT INTO policy_documents(id,title,category,description,effective_date,expires_at,filename,content_type,bytes,file_b64,search_text,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, v.title, v.category, v.description || null, v.effective_date || null, v.expires_at || null, v.filename || `${v.title}.${FILE_TYPES[file.type]}`, file.type, file.buf.length, file.b64, extractText(file.buf, file.type) || null, ctx.user.id);
    audit.log({ user: ctx.user, action: 'document.create', entity: 'policy_document', entityId: id, ip: ctx.ip, details: { title: v.title, category: v.category, bytes: file.buf.length } });
    ctx.status = 201; return { id };
  });
  r.put('/api/documents/:id', auth.requireAuth, auth.requirePerm('documents:write'), (ctx) => {
    const d = db.one(`SELECT id, updated_at FROM policy_documents WHERE id=?`, ctx.params.id); if (!d) throw notFound();
    require('../crud').assertFresh(ctx, d, 'document');
    const v = validate(ctx.body, Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, { ...s, required: false }])), { partial: true });
    const v2 = validate({ is_active: ctx.body.is_active }, { is_active: { type: 'boolean' } }, { partial: true });
    const sets = Object.keys(v).map(k => `${k}=?`); const params = Object.keys(v).map(k => v[k]);
    for (const k of Object.keys(v2)) { sets.push(`${k}=?`); params.push(v2[k]); }
    if (ctx.body.file_url || ctx.body.file) { const file = fromDataUrl(ctx.body.file_url ?? ctx.body.file, MAX_DOCUMENT_BYTES, 'File'); sets.push('file_b64=?', 'content_type=?', 'bytes=?', 'filename=?', 'search_text=?'); params.push(file.b64, file.type, file.buf.length, v.filename || ctx.body.filename || `document.${FILE_TYPES[file.type]}`, extractText(file.buf, file.type) || null); }
    if (!sets.length) return { ok: true, updated_at: d.updated_at };
    const stamp = db.now();
    db.run(`UPDATE policy_documents SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, stamp, d.id);
    audit.log({ user: ctx.user, action: 'document.update', entity: 'policy_document', entityId: d.id, ip: ctx.ip, details: { fields: Object.keys(v).concat(Object.keys(v2)) } });
    return { ok: true, updated_at: stamp };
  });
  // Soft delete (retire), same as the form template library — the library is a record of what has been in
  // effect, so a retired contract or superseded policy stays findable rather than disappearing outright.
  r.delete('/api/documents/:id', auth.requireAuth, auth.requirePerm('documents:write'), (ctx) => {
    const d = db.one(`SELECT id FROM policy_documents WHERE id=?`, ctx.params.id); if (!d) throw notFound();
    db.run(`UPDATE policy_documents SET is_active=0, updated_at=? WHERE id=?`, db.now(), d.id);
    audit.log({ user: ctx.user, action: 'document.retire', entity: 'policy_document', entityId: d.id, ip: ctx.ip });
    return { ok: true };
  });
  r.get('/api/documents/:id/file', auth.requireAuth, auth.requirePerm('documents:read'), (ctx) => {
    const d = loadVisible(ctx, ctx.params.id); if (!d.file_b64) throw notFound('No file for this document');
    audit.log({ user: ctx.user, action: 'document.download', entity: 'policy_document', entityId: d.id, ip: ctx.ip });
    ctx.res.writeHead(200, { 'Content-Type': safeContentType(d.content_type), 'Content-Disposition': `${ctx.query.get('inline') === '1' ? 'inline' : 'attachment'}; filename="${(d.filename || 'document').replace(/["\r\n]/g, '')}"` });
    ctx.res.end(Buffer.from(d.file_b64, 'base64')); return null;
  });
};
