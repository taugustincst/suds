'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound, forbidden } = require('../http');
const { validate, paging } = require('../validate');
const { encrypt, decrypt, sha256, uuid } = require('../crypto');

const shape = {
  client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['clinical', 'admin'] }, format: { type: 'string', enum: C.NOTE_FORMATS },
  title: { type: 'string', maxLen: 200 }, content: { type: 'string', required: true, maxLen: 50000 }, structured: { type: 'object' }, occurred_at: { type: 'datetime', required: true },
  intervention_id: { type: 'string' }, call_id: { type: 'string' }, part2_protected: { type: 'boolean' }, source: { type: 'string', enum: ['manual', 'pocket_ai', 'onenote', 'import', 'api'] }, source_ref: { type: 'string', maxLen: 300 },
};

function kindPerm(kind, rw) { return `notes:${kind}:${rw}`; }

function canRead(ctx, note) {
  if (auth.hasPerm(ctx.user, kindPerm(note.kind, 'read')) || auth.hasPerm(ctx.user, kindPerm(note.kind, 'write'))) return true;
  if (note.kind === 'clinical' && auth.hasPerm(ctx.user, 'notes:clinical:breakglass') && ctx.headers['x-break-glass-reason']) return 'breakglass';
  return false;
}

function present(row, { withContent = true } = {}) {
  const out = { ...row };
  delete out.content_enc; delete out.structured_enc;
  if (withContent) { out.content = decrypt(row.content_enc); out.structured = row.structured_enc ? JSON.parse(decrypt(row.structured_enc)) : null; }
  return out;
}

function load(ctx, id) {
  const n = db.one(`SELECT n.*, u.display_name AS author, s.display_name AS signer FROM notes n JOIN users u ON u.id=n.author_id LEFT JOIN users s ON s.id=n.signed_by WHERE n.id=? AND n.deleted_at IS NULL`, id);
  if (!n) throw notFound('Note not found');
  auth.assertClientAccess(ctx, n.client_id);
  return n;
}

module.exports = (r) => {
  r.get('/api/notes', auth.requireAuth, auth.requirePerm('notes:admin:read', 'notes:clinical:read', 'notes:admin:write', 'notes:clinical:write'), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 500 });
    const kinds = ['admin', 'clinical'].filter(k => auth.hasPerm(ctx.user, kindPerm(k, 'read')) || auth.hasPerm(ctx.user, kindPerm(k, 'write')));
    const where = ['n.deleted_at IS NULL', `n.kind IN (${kinds.map(() => '?').join(',') || "''"})`]; const params = [...kinds];
    const cf = auth.caseloadFilter(ctx.user, 'n.client_id'); where.push(cf.sql); params.push(...cf.params);
    for (const [q, col] of [['client_id', 'n.client_id'], ['kind', 'n.kind'], ['status', 'n.status'], ['author_id', 'n.author_id'], ['source', 'n.source']]) { const v = ctx.query.get(q); if (v) { where.push(`${col}=?`); params.push(v); } }
    if (ctx.query.get('mine') === '1') { where.push('n.author_id=?'); params.push(ctx.user.id); }
    if (ctx.query.get('from')) { where.push('n.occurred_at >= ?'); params.push(ctx.query.get('from')); }
    if (ctx.query.get('to')) { where.push('n.occurred_at <= ?'); params.push(ctx.query.get('to') + 'T23:59:59.999Z'); }
    const w = 'WHERE ' + where.join(' AND ');
    const rows = db.all(`SELECT n.id,n.client_id,n.kind,n.format,n.title,n.occurred_at,n.status,n.signed_at,n.source,n.author_id,n.created_at,n.updated_at,u.display_name AS author,c.client_code,
      (SELECT COUNT(*) FROM note_addenda a WHERE a.note_id=n.id) AS addenda FROM notes n JOIN users u ON u.id=n.author_id JOIN clients c ON c.id=n.client_id ${w} ORDER BY n.occurred_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    return { rows, total: db.one(`SELECT COUNT(*) n FROM notes n ${w}`, ...params).n };
  });

  r.post('/api/notes', auth.requireAuth, (ctx) => {
    const v = validate(ctx.body, shape);
    if (!auth.hasPerm(ctx.user, kindPerm(v.kind, 'write'))) throw forbidden(`You cannot author ${v.kind} notes`);
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, v.client_id)) throw notFound('Client not found');
    auth.assertClientAccess(ctx, v.client_id);
    const id = uuid();
    db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title,content_enc,structured_enc,occurred_at,intervention_id,call_id,part2_protected,source,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, v.client_id, ctx.user.id, v.kind, v.format || 'narrative', v.title || null, encrypt(v.content), v.structured ? encrypt(JSON.stringify(v.structured)) : null, v.occurred_at,
      v.intervention_id || null, v.call_id || null, v.part2_protected ?? 1, v.source || 'manual', v.source_ref || null);
    audit.log({ user: ctx.user, action: 'note.create', entity: 'note', entityId: id, clientId: v.client_id, ip: ctx.ip, details: { kind: v.kind, format: v.format } });
    ctx.status = 201; return { id };
  });

  r.get('/api/notes/:id', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    const access = canRead(ctx, n);
    if (!access) { audit.log({ user: ctx.user, action: 'note.view.denied', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, success: false }); throw forbidden('You do not have access to this note'); }
    const addenda = db.all(`SELECT a.id,a.reason,a.created_at,a.content_enc,u.display_name AS author FROM note_addenda a JOIN users u ON u.id=a.author_id WHERE a.note_id=? ORDER BY a.created_at`, n.id).map(a => ({ ...a, content: decrypt(a.content_enc), content_enc: undefined }));
    audit.log({ user: ctx.user, action: access === 'breakglass' ? 'note.view.breakglass' : 'note.view', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: access === 'breakglass' ? { reason: String(ctx.headers['x-break-glass-reason']).slice(0, 300) } : { kind: n.kind } });
    return { note: { ...present(n), addenda } };
  });

  r.put('/api/notes/:id', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    if (n.status !== 'draft') throw badRequest('Signed notes cannot be edited; add an addendum instead');
    if (n.author_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'clients:all')) throw forbidden('Only the author can edit a draft');
    const v = validate(ctx.body, { format: shape.format, title: shape.title, content: { ...shape.content, required: false }, structured: shape.structured, occurred_at: { ...shape.occurred_at, required: false }, intervention_id: shape.intervention_id, call_id: shape.call_id, part2_protected: shape.part2_protected }, { partial: true });
    const sets = []; const params = [];
    for (const k of ['format', 'title', 'occurred_at', 'intervention_id', 'call_id', 'part2_protected']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    if (v.content !== undefined) { sets.push('content_enc=?'); params.push(encrypt(v.content)); }
    if (v.structured !== undefined) { sets.push('structured_enc=?'); params.push(v.structured ? encrypt(JSON.stringify(v.structured)) : null); }
    if (sets.length) db.run(`UPDATE notes SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, db.now(), n.id);
    audit.log({ user: ctx.user, action: 'note.update', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: { fields: Object.keys(v) } });
    return { ok: true };
  });

  // Electronic signature: locks the note and records a content hash
  r.post('/api/notes/:id/sign', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    if (n.status !== 'draft') throw badRequest('Note is already signed');
    if (n.author_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'clients:all')) throw forbidden('Only the author (or a supervisor co-signing) can sign');
    const { password } = validate(ctx.body, { password: { type: 'string', required: true, maxLen: 500 } });
    const u = db.one(`SELECT password_hash FROM users WHERE id=?`, ctx.user.id);
    if (!require('../crypto').verifyPassword(password, u.password_hash)) { audit.log({ user: ctx.user, action: 'note.sign.failed', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, success: false }); throw forbidden('Password verification failed'); }
    const hash = sha256(`${n.id}|${ctx.user.id}|${n.content_enc}|${n.structured_enc || ''}`);
    db.run(`UPDATE notes SET status='signed', signed_at=?, signed_by=?, signature_hash=?, updated_at=? WHERE id=?`, db.now(), ctx.user.id, hash, db.now(), n.id);
    audit.log({ user: ctx.user, action: 'note.sign', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: { hash } });
    return { ok: true, signature_hash: hash };
  });

  r.post('/api/notes/:id/addenda', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    const { content, reason } = validate(ctx.body, { content: { type: 'string', required: true, maxLen: 20000 }, reason: { type: 'string', maxLen: 300 } });
    const id = uuid();
    db.run(`INSERT INTO note_addenda(id,note_id,author_id,content_enc,reason) VALUES(?,?,?,?,?)`, id, n.id, ctx.user.id, encrypt(content), reason || null);
    if (n.status === 'signed') db.run(`UPDATE notes SET status='amended', updated_at=? WHERE id=?`, db.now(), n.id);
    audit.log({ user: ctx.user, action: 'note.addendum', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip });
    ctx.status = 201; return { id };
  });

  r.delete('/api/notes/:id', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    if (n.status !== 'draft') throw badRequest('Signed notes are part of the legal record and cannot be deleted');
    if (n.author_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'clients:all')) throw forbidden();
    db.run(`UPDATE notes SET deleted_at=?, updated_at=? WHERE id=?`, db.now(), db.now(), n.id);
    audit.log({ user: ctx.user, action: 'note.delete', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip });
    return { ok: true };
  });

  r.get('/api/notes/:id/verify', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!canRead(ctx, n)) throw forbidden();
    if (!n.signature_hash) return { signed: false };
    const hash = sha256(`${n.id}|${n.signed_by}|${n.content_enc}|${n.structured_enc || ''}`);
    return { signed: true, intact: hash === n.signature_hash, signed_at: n.signed_at, signer: n.signer };
  });
};
