'use strict';
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const config = require('../config');
const { badRequest, notFound, forbidden, HttpError } = require('../http');
const { validate, paging } = require('../validate');
const { encrypt, decrypt, uuid, blindIndex } = require('../crypto');
const pocket = require('../importers/pocketai');
const onenote = require('../importers/onenote');
const M = require('../clients-model');

// Suggest a client for an imported item from hints (client code or "Last, First"/"First Last")
function suggestClient(ctx, hints) {
  if (!hints) return null;
  for (const code of hints.codes || []) { const c = db.one(`SELECT id FROM clients WHERE client_code=? AND deleted_at IS NULL`, code); if (c && auth.canAccessClient(ctx.user, c.id)) return c.id; }
  for (const name of hints.names || []) {
    const parts = name.split(/[,\s]+/).filter(Boolean); if (parts.length < 2) continue;
    const a = blindIndex(parts.join('')), b = blindIndex([...parts].reverse().join(''));
    const c = db.one(`SELECT id FROM clients WHERE full_name_idx IN (?,?) AND deleted_at IS NULL`, a, b); if (c && auth.canAccessClient(ctx.user, c.id)) return c.id;
  }
  return null;
}

function stage(ctx, { source, filename, items, importedBy, metadata }) {
  if (!items.length) throw badRequest('No notes were found in the input');
  if (items.length > 500) throw badRequest('Too many items in one import (max 500)');
  const id = uuid();
  db.transaction(() => {
    db.run(`INSERT INTO imports(id,source,filename,imported_by,item_count,metadata) VALUES(?,?,?,?,?,?)`, id, source, filename || null, importedBy || null, items.length, metadata ? JSON.stringify(metadata) : null);
    for (const it of items) {
      const suggested = ctx ? suggestClient(ctx, it.metadata?.hints) : null;
      db.run(`INSERT INTO import_items(id,import_id,external_id,title_enc,content_enc,captured_at,metadata,suggested_client_id) VALUES(?,?,?,?,?,?,?,?)`,
        uuid(), id, it.external_id || null, it.title ? encrypt(it.title) : null, encrypt(it.content || ''), it.captured_at || null, JSON.stringify(it.metadata || {}), suggested);
    }
  });
  return id;
}

// A captured note's title is as much PHI as its body, so it is stored encrypted and decrypted here.
function itemTitle(x) { return x.title_enc ? decrypt(x.title_enc) : null; }

function itemView(x, { withContent = true } = {}) {
  const o = { ...x, metadata: x.metadata ? JSON.parse(x.metadata) : {}, title: itemTitle(x) };
  delete o.content_enc; delete o.title_enc;
  if (withContent) o.content = decrypt(x.content_enc);
  if (o.metadata?.hints) { o.hints = o.metadata.hints; }
  return o;
}

module.exports = (r) => {
  // Upload: JSON {source, filename, text} or raw body with X-Filename (binary files like .mht/.docx)
  r.post('/api/imports/upload', auth.requireAuth, auth.requirePerm('imports:write'), (ctx) => {
    let source, filename, buf;
    if (ctx.body && ctx.body.text !== undefined) {
      const v = validate(ctx.body, { source: { type: 'string', required: true, enum: ['pocket_ai', 'onenote', 'generic'] }, filename: { type: 'string', maxLen: 200 }, text: { type: 'string', required: true, maxLen: 20_000_000 } });
      source = v.source; filename = v.filename || 'pasted.txt'; buf = Buffer.from(v.text, 'utf8');
    } else {
      source = String(ctx.query.get('source') || ctx.headers['x-import-source'] || 'generic');
      filename = String(ctx.headers['x-filename'] || ctx.query.get('filename') || 'upload');
      buf = ctx.rawBody || Buffer.alloc(0);
      if (ctx.headers['content-transfer-encoding'] === 'base64') buf = Buffer.from(buf.toString('latin1'), 'base64');
    }
    if (!buf.length) throw badRequest('Empty upload');
    let items;
    try {
      if (source === 'pocket_ai') items = pocket.parse(buf, { filename });
      else if (source === 'onenote') items = onenote.parseFile(buf, filename);
      else { const ext = filename.split('.').pop().toLowerCase(); items = ['json'].includes(ext) ? pocket.parse(buf, { filename }) : onenote.parseFile(buf, filename); }
    } catch (e) { throw badRequest('Could not parse file: ' + e.message); }
    const id = stage(ctx, { source: source === 'onenote' ? 'onenote_file' : source, filename, items, importedBy: ctx.user.id });
    // Not the filename: a OneNote export is routinely named after the person it is about, and this table
    // is kept for seven years.
    audit.log({ user: ctx.user, action: 'import.upload', entity: 'import', entityId: id, ip: ctx.ip, details: { source, extension: (/\.([A-Za-z0-9]{1,8})$/.exec(filename) || [])[1] || null, bytes: buf.length, count: items.length } });
    ctx.status = 201; return { id, count: items.length };
  });

  r.get('/api/imports', auth.requireAuth, auth.requirePerm('imports:read', 'imports:write'), (ctx) => {
    const rows = db.all(`SELECT i.*, u.display_name AS imported_by_name,
      (SELECT COUNT(*) FROM import_items x WHERE x.import_id=i.id AND x.status='staged') AS staged,
      (SELECT COUNT(*) FROM import_items x WHERE x.import_id=i.id AND x.status='committed') AS committed,
      (SELECT COUNT(*) FROM import_items x WHERE x.import_id=i.id AND x.status='discarded') AS discarded
      FROM imports i LEFT JOIN users u ON u.id=i.imported_by ${auth.hasPerm(ctx.user, 'clients:all') ? '' : 'WHERE i.imported_by=? OR i.imported_by IS NULL'} ORDER BY i.created_at DESC LIMIT 200`, ...(auth.hasPerm(ctx.user, 'clients:all') ? [] : [ctx.user.id]));
    return { imports: rows };
  });

  r.get('/api/imports/:id', auth.requireAuth, auth.requirePerm('imports:read', 'imports:write'), (ctx) => {
    const imp = db.one(`SELECT * FROM imports WHERE id=?`, ctx.params.id); if (!imp) throw notFound();
    if (imp.imported_by && imp.imported_by !== ctx.user.id && !auth.hasPerm(ctx.user, 'clients:all')) throw forbidden();
    const items = db.all(`SELECT x.*, c.client_code AS suggested_client_code FROM import_items x LEFT JOIN clients c ON c.id=x.suggested_client_id WHERE import_id=? ORDER BY captured_at, created_at`, imp.id).map(x => itemView(x));
    // decorate suggested client display names
    for (const it of items) if (it.suggested_client_id) { const c = db.one(`SELECT * FROM clients WHERE id=?`, it.suggested_client_id); it.suggested_client_name = c ? M.summary(c).display_name : null; }
    audit.log({ user: ctx.user, action: 'import.view', entity: 'import', entityId: imp.id, ip: ctx.ip });
    return { import: imp, items };
  });

  // Commit one staged item as a note
  r.post('/api/imports/items/:id/commit', auth.requireAuth, auth.requirePerm('imports:write'), (ctx) => {
    const it = db.one(`SELECT * FROM import_items WHERE id=?`, ctx.params.id); if (!it) throw notFound();
    if (it.status !== 'staged') throw badRequest('Item already processed');
    const v = validate(ctx.body, { client_id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['clinical', 'admin'] }, format: { type: 'string' }, title: { type: 'string', maxLen: 200 },
      content: { type: 'string', maxLen: 50000 }, occurred_at: { type: 'datetime' }, create_intervention: { type: 'boolean' }, intervention_type: { type: 'string' }, duration_minutes: { type: 'number', integer: true, min: 0 } });
    if (!auth.hasPerm(ctx.user, `notes:${v.kind}:write`)) throw forbidden(`You cannot author ${v.kind} notes`);
    if (!db.one(`SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL`, v.client_id)) throw notFound('Client not found');
    auth.assertClientAccess(ctx, v.client_id);
    const imp = db.one(`SELECT source FROM imports WHERE id=?`, it.import_id);
    const source = imp.source.startsWith('onenote') ? 'onenote' : imp.source === 'pocket_ai' || imp.source === 'api' ? 'pocket_ai' : 'import';
    const content = v.content ?? decrypt(it.content_enc);
    const occurred = v.occurred_at || it.captured_at || db.now();
    const noteId = uuid();
    let interventionId = null;
    db.transaction(() => {
      if (v.create_intervention) {
        interventionId = uuid();
        db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,summary_enc) VALUES(?,?,?,?,?,?,?,?)`, interventionId, v.client_id, ctx.user.id, v.intervention_type || 'case_management', occurred, v.duration_minutes || 0, 'other', encrypt((v.title || itemTitle(it) || '').slice(0, 300)));
      }
      const noteTitle = v.title || itemTitle(it) || null;
      db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,occurred_at,source,source_ref,import_item_id,intervention_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        noteId, v.client_id, ctx.user.id, v.kind, v.format || 'narrative', noteTitle ? encrypt(noteTitle) : null, encrypt(content), occurred, source, it.external_id || null, it.id, interventionId);
      db.run(`UPDATE import_items SET status='committed', note_id=? WHERE id=?`, noteId, it.id);
      const left = db.one(`SELECT COUNT(*) n FROM import_items WHERE import_id=? AND status='staged'`, it.import_id).n;
      if (left === 0) db.run(`UPDATE imports SET status='completed' WHERE id=?`, it.import_id);
    });
    audit.log({ user: ctx.user, action: 'import.commit', entity: 'note', entityId: noteId, clientId: v.client_id, ip: ctx.ip, details: { import_item: it.id, kind: v.kind, intervention: interventionId } });
    return { note_id: noteId, intervention_id: interventionId };
  });

  r.post('/api/imports/items/:id/discard', auth.requireAuth, auth.requirePerm('imports:write'), (ctx) => {
    const it = db.one(`SELECT * FROM import_items WHERE id=?`, ctx.params.id); if (!it) throw notFound();
    if (it.status !== 'staged') throw badRequest('Item already processed');
    db.run(`UPDATE import_items SET status='discarded' WHERE id=?`, it.id);
    audit.log({ user: ctx.user, action: 'import.discard', entity: 'import_item', entityId: it.id, ip: ctx.ip });
    return { ok: true };
  });

  r.delete('/api/imports/:id', auth.requireAuth, auth.requirePerm('imports:write'), (ctx) => {
    const imp = db.one(`SELECT * FROM imports WHERE id=?`, ctx.params.id); if (!imp) throw notFound();
    if (imp.imported_by !== ctx.user.id && !auth.hasPerm(ctx.user, 'clients:all')) throw forbidden();
    // Purges staged (uncommitted) PHI; committed notes are retained
    db.run(`DELETE FROM import_items WHERE import_id=? AND status<>'committed'`, imp.id);
    db.run(`UPDATE imports SET status='purged' WHERE id=?`, imp.id);
    audit.log({ user: ctx.user, action: 'import.purge', entity: 'import', entityId: imp.id, ip: ctx.ip });
    return { ok: true };
  });

  // ---- OneNote via Microsoft Graph ----
  r.get('/api/imports/onenote/status', auth.requireAuth, auth.requirePerm('imports:write'), () => ({ configured: !!(config.msGraph.tenantId && config.msGraph.clientId && config.msGraph.clientSecret && config.msGraph.user), user: config.msGraph.user ? config.msGraph.user.replace(/(.{2}).+(@.+)/, '$1***$2') : null }));
  r.get('/api/imports/onenote/notebooks', auth.requireAuth, auth.requirePerm('imports:write'), async (ctx) => {
    try { return { notebooks: await onenote.listNotebooks({ token: ctx.headers['x-ms-access-token'] }) }; }
    catch (e) { throw new HttpError(502, e.message); }
  });
  r.get('/api/imports/onenote/sections/:id/pages', auth.requireAuth, auth.requirePerm('imports:write'), async (ctx) => {
    try { return { pages: await onenote.listPages(ctx.params.id, { token: ctx.headers['x-ms-access-token'], since: ctx.query.get('since') || undefined }) }; }
    catch (e) { throw new HttpError(502, e.message); }
  });
  r.post('/api/imports/onenote/fetch', auth.requireAuth, auth.requirePerm('imports:write'), async (ctx) => {
    const { page_ids } = validate(ctx.body, { page_ids: { type: 'array', required: true } });
    if (!page_ids.length || page_ids.length > 200) throw badRequest('Select 1–200 pages');
    let items;
    try { items = await onenote.fetchPages(page_ids.map(String), { token: ctx.headers['x-ms-access-token'] }); }
    catch (e) { throw new HttpError(502, e.message); }
    const id = stage(ctx, { source: 'onenote_graph', filename: null, items, importedBy: ctx.user.id, metadata: { pages: page_ids.length } });
    audit.log({ user: ctx.user, action: 'import.onenote_graph', entity: 'import', entityId: id, ip: ctx.ip, details: { count: items.length } });
    ctx.status = 201; return { id, count: items.length };
  });

  module.exports.stage = stage;
};
module.exports.stageFn = (args) => stage(null, args);
