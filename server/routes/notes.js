'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound, forbidden } = require('../http');
const { validate, paging } = require('../validate');
const { encrypt, decrypt, sha256, uuid } = require('../crypto');

const shape = {
  client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['clinical', 'admin'] }, format: { type: 'string', list: 'NOTE_FORMATS' },
  title: { type: 'string', maxLen: 200 }, content: { type: 'string', required: true, maxLen: 50000 }, structured: { type: 'object' }, occurred_at: { type: 'datetime', required: true },
  intervention_id: { type: 'string' }, call_id: { type: 'string' }, part2_protected: { type: 'boolean' }, counseling_note: { type: 'boolean' }, cosign_requested: { type: 'boolean' }, source: { type: 'string', enum: ['manual', 'pocket_ai', 'onenote', 'import', 'api'] }, source_ref: { type: 'string', maxLen: 300 },
  // The problem-list entries this note addresses (CalAIM: a progress note ties the service to the problem list).
  problem_ids: { type: 'array', maxLen: 30, of: 'string' },
};

// Problem ids must be on this client's problem list; stored as a JSON array (ids only), or null for none.
function problemIds(ids, clientId) {
  if (ids === undefined) return undefined;
  if (ids === null || !ids.length) return null;
  const uniq = [...new Set(ids)];
  for (const id of uniq) { const p = db.one(`SELECT client_id FROM problems WHERE id=?`, id); if (!p || p.client_id !== clientId) throw badRequest('Validation failed', { fields: { problem_ids: 'names a problem that is not on this client\'s problem list' } }); }
  return JSON.stringify(uniq);
}
// The problems a note is linked to, with their wording for a role that may read the problem list.
function linkedProblems(ctx, n) {
  let ids = []; try { ids = n.problem_ids ? JSON.parse(n.problem_ids) : []; } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  if (!auth.hasPerm(ctx.user, 'careplan:read')) return ids.map(id => ({ id }));
  return ids.map(id => { const p = db.one(`SELECT id, problem_enc, status FROM problems WHERE id=?`, id); return p ? { id: p.id, problem: decrypt(p.problem_enc), status: p.status } : { id }; });
}

function kindPerm(kind, rw) { return `notes:${kind}:${rw}`; }
// A SUD counseling note (42 CFR §2.11) is a clinician's own analysis of a counselling session: it can only
// be a clinical note, and is disclosed only under a consent given for counseling notes alone (disclosure.js).
function checkCounseling(kind, counseling) { if (counseling && kind !== 'clinical') throw badRequest('Only a clinical note can be a SUD counseling note'); }

// Re-entering the password is the electronic-signature act itself, so it is checked the same way for a
// signature and a countersignature.
async function verifyIdentity(ctx) {
  const { password } = validate(ctx.body, { password: { type: 'string', required: true, maxLen: 500 } }, { partial: true });
  if (!password) throw badRequest('Your password is required to sign');
  const u = db.one(`SELECT password_hash FROM users WHERE id=?`, ctx.user.id);
  if (!(await require('../crypto').verifyPasswordAsync(password, u.password_hash))) {
    audit.log({ user: ctx.user, action: 'note.sign.failed', ip: ctx.ip, success: false });
    throw forbidden('Password verification failed');
  }
}

// Emergency access needs a reason a privacy officer can act on. "x" is not one: the header has to carry a
// real sentence, and every use lands in the supervision queue (breakglass_events) as well as the audit log.
const BREAK_GLASS_MIN = 15;
function breakGlassReason(ctx) {
  const raw = ctx.headers['x-break-glass-reason'];
  if (raw === undefined || raw === null || raw === '') return null;
  const reason = String(raw).trim();
  if (reason.length < BREAK_GLASS_MIN) throw badRequest(`A break-glass reason must be at least ${BREAK_GLASS_MIN} characters and say why emergency access is needed`);
  return reason.slice(0, 300);
}
// The reason is kept here, encrypted, for the supervisor's review; the audit entry carries only the event's
// id (the reason can describe the client, and audit details are plaintext that travels in auditor exports).
function recordBreakGlass(ctx, { clientId, noteId = null, reason }) {
  const id = uuid();
  db.run(`INSERT INTO breakglass_events(id,user_id,client_id,note_id,reason_enc,at) VALUES(?,?,?,?,?,?)`, id, ctx.user.id, clientId || null, noteId, encrypt(reason), db.now());
  return id;
}
function canRead(ctx, note) {
  if (auth.hasPerm(ctx.user, kindPerm(note.kind, 'read')) || auth.hasPerm(ctx.user, kindPerm(note.kind, 'write'))) return true;
  if (note.kind === 'clinical' && auth.hasPerm(ctx.user, 'notes:clinical:breakglass') && breakGlassReason(ctx)) return 'breakglass';
  return false;
}

function present(row, { withContent = true } = {}) {
  const out = { ...row };
  delete out.content_enc; delete out.structured_enc; delete out.title_enc;
  out.title = row.title_enc ? decrypt(row.title_enc) : null;
  if ('cosign_note_enc' in row) { out.cosign_note = row.cosign_note_enc ? decrypt(row.cosign_note_enc) : null; delete out.cosign_note_enc; }
  if (withContent) { out.content = decrypt(row.content_enc); out.structured = row.structured_enc ? JSON.parse(decrypt(row.structured_enc)) : null; }
  return out;
}

// A note is complete only once everyone who owes a signature has given one.
// cosign_required comes from the author's account (a trainee's every note); cosign_requested is the author
// asking for a second pair of eyes on this one. Either puts it in the supervisor's queue once signed.
function signatureState(n) {
  const wanted = !!n.cosign_required || !!n.cosign_requested;
  return { signed: n.status !== 'draft', cosign_required: !!n.cosign_required, cosign_requested: !!n.cosign_requested, cosigned: !!n.cosigned_at, awaiting_cosign: wanted && n.status !== 'draft' && !n.cosigned_at };
}

function load(ctx, id) {
  const n = db.one(`SELECT n.*, u.display_name AS author, s.display_name AS signer, cs.display_name AS cosigner
    FROM notes n JOIN users u ON u.id=n.author_id LEFT JOIN users s ON s.id=n.signed_by LEFT JOIN users cs ON cs.id=n.cosigned_by
    WHERE n.id=? AND n.deleted_at IS NULL`, id);
  if (!n) throw notFound('Note not found');
  auth.assertClientAccess(ctx, n.client_id);
  return n;
}

module.exports = (r) => {
  r.get('/api/notes', auth.requireAuth, auth.requirePerm('notes:admin:read', 'notes:clinical:read', 'notes:admin:write', 'notes:clinical:write'), (ctx) => {
    const { limit, offset } = paging(ctx.query, { limit: 100, max: 500 });
    const kinds = ['admin', 'clinical'].filter(k => auth.hasPerm(ctx.user, kindPerm(k, 'read')) || auth.hasPerm(ctx.user, kindPerm(k, 'write')));
    // Break-glass on the list, one client at a time, with the reason recorded -- the same audited exception
    // the single-note route allows, so an administrator has a way to find the note in the first place.
    const glassReason = !kinds.includes('clinical') && auth.hasPerm(ctx.user, 'notes:clinical:breakglass') && ctx.query.get('client_id') && ctx.query.get('kind') === 'clinical' ? breakGlassReason(ctx) : null;
    if (glassReason) {
      kinds.push('clinical');
      const event = recordBreakGlass(ctx, { clientId: ctx.query.get('client_id'), reason: glassReason });
      audit.log({ user: ctx.user, action: 'note.list.breakglass', clientId: ctx.query.get('client_id'), ip: ctx.ip, details: { reason_recorded: true, breakglass_event: event } });
    }
    const where = ['n.deleted_at IS NULL', `n.kind IN (${kinds.map(() => '?').join(',') || "''"})`]; const params = [...kinds];
    const cf = auth.caseloadFilter(ctx.user, 'n.client_id'); where.push(cf.sql); params.push(...cf.params);
    for (const [q, col] of [['client_id', 'n.client_id'], ['kind', 'n.kind'], ['status', 'n.status'], ['author_id', 'n.author_id'], ['source', 'n.source']]) { const v = ctx.query.get(q); if (v) { where.push(`${col}=?`); params.push(v); } }
    if (ctx.query.get('mine') === '1') { where.push('n.author_id=?'); params.push(ctx.user.id); }
    if (ctx.query.get('unsigned') === '1') where.push("n.status='draft'");
    // Notes this user owes a countersignature on: they are the author's supervisor, or they simply hold the
    // permission (a small county often has one supervisor for everyone).
    if (ctx.query.get('awaiting_cosign') === '1') {
      where.push("(n.cosign_required=1 OR n.cosign_requested=1) AND n.status<>'draft' AND n.cosigned_at IS NULL");
      if (!auth.hasPerm(ctx.user, 'notes:cosign')) { where.push('1=0'); }
    }
    if (ctx.query.get('from')) { where.push('n.occurred_at >= ?'); params.push(ctx.query.get('from')); }
    if (ctx.query.get('to')) { where.push('n.occurred_at <= ?'); params.push(ctx.query.get('to') + 'T23:59:59.999Z'); }
    const w = 'WHERE ' + where.join(' AND ');
    const rows = db.all(`SELECT n.id,n.client_id,n.kind,n.format,n.title_enc,n.occurred_at,n.status,n.signed_at,n.source,n.author_id,n.created_at,n.updated_at,
      n.cosign_required,n.cosign_requested,n.cosigned_at,n.cosigned_by,n.counseling_note,u.display_name AS author,cs.display_name AS cosigner,c.client_code,
      (SELECT COUNT(*) FROM note_addenda a WHERE a.note_id=n.id) AS addenda
      FROM notes n JOIN users u ON u.id=n.author_id LEFT JOIN users cs ON cs.id=n.cosigned_by JOIN clients c ON c.id=n.client_id ${w} ORDER BY n.occurred_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const out = rows.map(x => ({ ...x, title: x.title_enc ? decrypt(x.title_enc) : null, title_enc: undefined, ...signatureState(x) }));
    // Listing notes is a PHI read (titles are clinical narrative), so it is audited like any other.
    audit.log({ user: ctx.user, action: 'note.list', ip: ctx.ip, clientId: ctx.query.get('client_id') || null, details: { count: out.length, kinds, filter: ctx.query.get('awaiting_cosign') === '1' ? 'awaiting_cosign' : undefined } });
    return { rows: out, total: db.one(`SELECT COUNT(*) n FROM notes n ${w}`, ...params).n };
  });

  r.post('/api/notes', auth.requireAuth, (ctx) => {
    const v = validate(ctx.body, shape);
    if (!auth.hasPerm(ctx.user, kindPerm(v.kind, 'write'))) throw forbidden(`You cannot author ${v.kind} notes`);
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, v.client_id)) throw notFound('Client not found');
    auth.assertClientAccess(ctx, v.client_id);
    checkCounseling(v.kind, v.counseling_note);
    const id = uuid();
    const linked = problemIds(v.problem_ids, v.client_id) ?? null;
    const author = db.one(`SELECT requires_cosign FROM users WHERE id=?`, ctx.user.id);
    db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,structured_enc,occurred_at,intervention_id,call_id,part2_protected,source,source_ref,cosign_required,cosign_requested,problem_ids,counseling_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, v.client_id, ctx.user.id, v.kind, v.format || 'narrative', v.title ? encrypt(v.title) : null, encrypt(v.content), v.structured ? encrypt(JSON.stringify(v.structured)) : null, v.occurred_at,
      v.intervention_id || null, v.call_id || null, v.part2_protected ?? 1, v.source || 'manual', v.source_ref || null, author?.requires_cosign ? 1 : 0, v.cosign_requested ? 1 : 0, linked, v.counseling_note ? 1 : 0);
    audit.log({ user: ctx.user, action: 'note.create', entity: 'note', entityId: id, clientId: v.client_id, ip: ctx.ip, details: { kind: v.kind, format: v.format, cosign_requested: v.cosign_requested ? true : undefined, counseling_note: v.counseling_note ? true : undefined } });
    // updated_at: the version the editor's next autosave sends as if_updated_at.
    ctx.status = 201; return { id, updated_at: db.one(`SELECT updated_at FROM notes WHERE id=?`, id).updated_at };
  });

  r.get('/api/notes/:id', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    const access = canRead(ctx, n);
    if (!access) { audit.log({ user: ctx.user, action: 'note.view.denied', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, success: false }); throw forbidden('You do not have access to this note'); }
    const addenda = db.all(`SELECT a.id,a.reason_enc,a.created_at,a.content_enc,u.display_name AS author FROM note_addenda a JOIN users u ON u.id=a.author_id WHERE a.note_id=? ORDER BY a.created_at`, n.id)
      .map(a => ({ ...a, content: decrypt(a.content_enc), reason: a.reason_enc ? decrypt(a.reason_enc) : null, content_enc: undefined, reason_enc: undefined }));
    const event = access === 'breakglass' ? recordBreakGlass(ctx, { clientId: n.client_id, noteId: n.id, reason: breakGlassReason(ctx) }) : null;
    audit.log({ user: ctx.user, action: access === 'breakglass' ? 'note.view.breakglass' : 'note.view', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: access === 'breakglass' ? { reason_recorded: true, breakglass_event: event } : { kind: n.kind } });
    return { note: { ...present(n), ...signatureState(n), addenda, problems: linkedProblems(ctx, n) } };
  });

  r.put('/api/notes/:id', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    if (n.status !== 'draft') throw badRequest('Signed notes cannot be edited; add an addendum instead');
    if (n.author_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'clients:all')) throw forbidden('Only the author can edit a draft');
    require('../crud').assertFresh(ctx, n, 'note');
    const v = validate(ctx.body, { format: shape.format, title: shape.title, content: { ...shape.content, required: false }, structured: shape.structured, occurred_at: { ...shape.occurred_at, required: false }, intervention_id: shape.intervention_id, call_id: shape.call_id, part2_protected: shape.part2_protected, counseling_note: shape.counseling_note, cosign_requested: shape.cosign_requested, problem_ids: shape.problem_ids }, { partial: true, existing: n });
    checkCounseling(n.kind, v.counseling_note);
    const sets = []; const params = [];
    for (const k of ['format', 'occurred_at', 'intervention_id', 'call_id', 'part2_protected', 'counseling_note', 'cosign_requested']) if (v[k] !== undefined) { sets.push(`${k}=?`); params.push(v[k]); }
    if (v.title !== undefined) { sets.push('title_enc=?'); params.push(v.title ? encrypt(v.title) : null); }
    if (v.content !== undefined) { sets.push('content_enc=?'); params.push(encrypt(v.content)); }
    const linked = problemIds(v.problem_ids, n.client_id);
    if (linked !== undefined) { sets.push('problem_ids=?'); params.push(linked); }
    if (v.structured !== undefined) { sets.push('structured_enc=?'); params.push(v.structured ? encrypt(JSON.stringify(v.structured)) : null); }
    const stamp = sets.length ? db.now() : n.updated_at;
    if (sets.length) db.run(`UPDATE notes SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, stamp, n.id);
    audit.log({ user: ctx.user, action: 'note.update', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: { fields: Object.keys(v) } });
    return { ok: true, updated_at: stamp };
  });

  // "Send to supervisor": the author flags a note (draft or already signed) for review/co-signature. A signed
  // note is otherwise immutable, which is why this is its own route rather than part of the draft edit.
  r.post('/api/notes/:id/request-cosign', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    if (n.author_id !== ctx.user.id && !auth.hasPerm(ctx.user, 'clients:all')) throw forbidden('Only the author can ask for a review of their note');
    if (n.cosigned_at) throw badRequest('This note has already been countersigned');
    const { cosign_requested } = validate(ctx.body || {}, { cosign_requested: { type: 'boolean' } });
    const flag = cosign_requested === false ? 0 : 1;
    db.run(`UPDATE notes SET cosign_requested=?, updated_at=? WHERE id=?`, flag, db.now(), n.id);
    audit.log({ user: ctx.user, action: flag ? 'note.cosign.requested' : 'note.cosign.request_withdrawn', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip });
    return { ok: true, cosign_requested: !!flag, awaiting_cosign: !!flag && n.status !== 'draft' };
  });

  // Shift hand-off notes from the last day, for the whole team: what the next worker on needs to know.
  // Read like any other admin note (caseload scoped, audited); the text is decrypted because the card
  // exists to be read at a glance at the start of a shift.
  r.get('/api/notes/handoffs', auth.requireAuth, auth.requirePerm('notes:admin:read', 'notes:admin:write'), (ctx) => {
    const hours = Math.min(24 * 7, Math.max(1, Number(ctx.query.get('hours') || 24)));
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const cf = auth.caseloadFilter(ctx.user, 'n.client_id');
    const { withClientName, SELECT: NAME_COLS } = require('../client-name');
    const rows = db.all(`SELECT n.id, n.client_id, n.occurred_at, n.status, n.title_enc, n.content_enc, n.author_id, u.display_name AS author, c.client_code, ${NAME_COLS}
      FROM notes n JOIN users u ON u.id=n.author_id JOIN clients c ON c.id=n.client_id
      WHERE n.deleted_at IS NULL AND n.kind='admin' AND n.format='handoff' AND n.occurred_at >= ? AND ${cf.sql} ORDER BY n.occurred_at DESC LIMIT 50`, since, ...cf.params);
    const out = rows.map(x => { const o = withClientName(ctx, x); let content = ''; try { content = decrypt(x.content_enc); } catch { content = ''; } return { ...o, title: x.title_enc ? decrypt(x.title_enc) : null, excerpt: content.slice(0, 240), title_enc: undefined, content_enc: undefined }; });
    audit.log({ user: ctx.user, action: 'note.list', ip: ctx.ip, details: { count: out.length, kinds: ['admin'], filter: 'handoffs', hours } });
    return { rows: out, hours };
  });

  // Electronic signature: locks the note and records a content hash
  r.post('/api/notes/:id/sign', auth.requireAuth, async (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    if (n.status !== 'draft') throw badRequest('Note is already signed');
    // Only the person who wrote the note may sign it. A supervisor approving a trainee's work countersigns
    // (POST /cosign) — signing on their behalf would erase who actually provided the service.
    if (n.author_id !== ctx.user.id) throw forbidden('Only the author can sign a note. Supervisors countersign instead.');
    await verifyIdentity(ctx);
    const hash = sha256(`${n.id}|${ctx.user.id}|${n.content_enc}|${n.structured_enc || ''}`);
    db.run(`UPDATE notes SET status='signed', signed_at=?, signed_by=?, signature_hash=?, updated_at=? WHERE id=?`, db.now(), ctx.user.id, hash, db.now(), n.id);
    audit.log({ user: ctx.user, action: 'note.sign', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: { hash, cosign_required: !!n.cosign_required } });
    return { ok: true, signature_hash: hash, awaiting_cosign: !!n.cosign_required };
  });

  // Countersignature: a supervisor approves a note someone else wrote. Both names stay on the record.
  r.post('/api/notes/:id/cosign', auth.requireAuth, auth.requirePerm('notes:cosign'), async (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'read')) && !auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden(`You cannot read ${n.kind} notes`);
    if (n.status === 'draft') throw badRequest('The author has not signed this note yet');
    if (n.author_id === ctx.user.id) throw badRequest('A note cannot be countersigned by its own author');
    if (n.cosigned_at) throw badRequest('This note has already been countersigned');
    const { note } = validate(ctx.body, { password: { type: 'string', required: true, maxLen: 500 }, note: { type: 'string', maxLen: 1000 } });
    await verifyIdentity(ctx);
    const hash = sha256(`${n.id}|${ctx.user.id}|cosign|${n.content_enc}|${n.structured_enc || ''}`);
    db.run(`UPDATE notes SET cosigned_by=?, cosigned_at=?, cosignature_hash=?, cosign_note_enc=?, updated_at=? WHERE id=?`, ctx.user.id, db.now(), hash, note ? encrypt(note) : null, db.now(), n.id);
    // The countersigner's comment is about the client's care: encrypted on the note, never in the audit entry.
    audit.log({ user: ctx.user, action: 'note.cosign', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: { author_id: n.author_id, hash, note_recorded: note ? true : undefined } });
    return { ok: true, cosignature_hash: hash };
  });

  r.post('/api/notes/:id/addenda', auth.requireAuth, (ctx) => {
    const n = load(ctx, ctx.params.id);
    if (!auth.hasPerm(ctx.user, kindPerm(n.kind, 'write'))) throw forbidden();
    const { content, reason } = validate(ctx.body, { content: { type: 'string', required: true, maxLen: 20000 }, reason: { type: 'string', maxLen: 300 } });
    const id = uuid();
    db.run(`INSERT INTO note_addenda(id,note_id,author_id,content_enc,reason_enc) VALUES(?,?,?,?,?)`, id, n.id, ctx.user.id, encrypt(content), reason ? encrypt(reason) : null);
    if (n.status === 'signed') db.run(`UPDATE notes SET status='amended', updated_at=? WHERE id=?`, db.now(), n.id);
    audit.log({ user: ctx.user, action: 'note.addendum', entity: 'note', entityId: n.id, clientId: n.client_id, ip: ctx.ip, details: reason ? { reason_recorded: true } : undefined });
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
    if (!n.signature_hash) return { signed: false, ...signatureState(n) };
    const hash = sha256(`${n.id}|${n.signed_by}|${n.content_enc}|${n.structured_enc || ''}`);
    const out = { signed: true, intact: hash === n.signature_hash, signed_at: n.signed_at, signer: n.signer, ...signatureState(n) };
    if (n.cosignature_hash) {
      out.cosigner = n.cosigner; out.cosigned_at = n.cosigned_at;
      out.cosignature_intact = sha256(`${n.id}|${n.cosigned_by}|cosign|${n.content_enc}|${n.structured_enc || ''}`) === n.cosignature_hash;
    }
    return out;
  });
};
