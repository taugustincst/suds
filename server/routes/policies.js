'use strict';
// Policy sign-offs (docs/integration/POWERDMS.md): which policies each person must sign, whether they have signed the
// current revision, and the PowerDMS report that says so. Office server only (server/app.js): the record of staff
// compliance is the programme's, and a device has its own accounts. No client data: staff, policies and dates.
//
//   GET    /api/policies/mine                   everyone: the policies their role must sign, and their status
//   GET    /api/policies/compliance             policies:manage: every required policy against every active account
//   POST   /api/policies/report/preview         policies:manage: read a PowerDMS report and say what it would record
//   POST   /api/policies/report/import          policies:manage: record what the report shows signed
//   GET    /api/policies/imports                policies:manage: the reports imported
//   POST   /api/policies/acknowledgements       policies:manage: record one sign-off by hand
//   DELETE /api/policies/acknowledgements/:id   policies:manage: remove one recorded in error
const crypto = require('node:crypto');
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const { badRequest, notFound } = require('../http');
const { validate } = require('../validate');
const { uuid } = require('../crypto');
const P = require('../powerdms');

const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 500;

const activeUsers = () => db.all(`SELECT id, username, email, display_name, role FROM users WHERE is_active=1 AND access_status='active' ORDER BY display_name, username`);
const documents = () => db.all(`SELECT id, title, category, powerdms_url, revision, ack_roles, is_active FROM policy_documents`);

/** The report file in a request: { buf, filename }. A data: URL or plain base64, CSV or Excel, at most 5 MB. */
function reportFile(body) {
  const v = body && (body.file_url ?? body.file);
  if (typeof v !== 'string' || !v) throw badRequest('Choose the PowerDMS report file (Excel or CSV)');
  const m = /^data:[\w.+/-]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(v);
  const b64 = (m ? m[1] : v).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw badRequest('The report must be sent as base64');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw badRequest('The report is empty');
  if (buf.length > MAX_REPORT_BYTES) throw badRequest('The report is too large (max 5 MB): export it for a shorter period or fewer documents');
  const filename = typeof body.filename === 'string' ? body.filename.slice(0, 200) : 'powerdms-report';
  return { buf, filename };
}

/** Read and match a report against this server's staff and policies. */
function readReport(body) {
  const { buf, filename } = reportFile(body);
  let parsed;
  try { parsed = require('../spreadsheet').parseFile(buf, filename); } catch { throw badRequest('This file could not be read as an Excel workbook or a CSV file'); }
  const sheet = (parsed.sheets || []).find(s => (s.rows || []).length) || (parsed.sheets || [])[0];
  if (!sheet) throw badRequest('The file has no sheet with rows in it');
  const have = new Set(db.all(`SELECT document_id, user_id, revision FROM policy_acknowledgements`).map(a => `${a.document_id}|${a.user_id}|${a.revision}`));
  let match;
  try { match = P.matchReport(sheet, { users: activeUsers(), documents: documents().filter(d => d.is_active), have }); }
  catch (e) { throw badRequest(e.message); }
  return { ...match, filename, sha256: crypto.createHash('sha256').update(buf).digest('hex'), sheet: sheet.name };
}

const OUTCOME_LABELS = {
  record: 'Will be recorded', already: 'Already recorded', not_signed: 'Not signed (by its status)', unknown_staff: 'No SUDS account matches',
  ambiguous_staff: 'More than one SUDS account has this name', unknown_document: 'No policy here matches', no_date: 'No signed date',
};

module.exports = (r) => {
  r.get('/api/policies/mine', auth.requireAuth, (ctx) => {
    const me = ctx.user;
    const docs = documents().filter(d => d.is_active && P.rolesOf(d.ack_roles).includes(me.role));
    const acks = db.all(`SELECT id, document_id, user_id, revision, acknowledged_at, source FROM policy_acknowledgements WHERE user_id=?`, me.id);
    const c = P.compliance(docs, [{ id: me.id, display_name: me.display_name, role: me.role }], acks);
    const items = (c.staff[0] ? c.staff[0].items : []);
    const policies = docs.map(d => {
      const s = items.find(x => x.document_id === d.id) || {};
      return { id: d.id, title: d.title, category: d.category, revision: d.revision || null, powerdms_url: d.powerdms_url || null, signed: !!s.current, acknowledgement: s.acknowledgement || null };
    }).sort((a, b) => Number(a.signed) - Number(b.signed) || a.title.localeCompare(b.title));
    return { policies, outstanding: policies.filter(p => !p.signed).length };
  });

  r.get('/api/policies/compliance', auth.requireAuth, auth.requirePerm('policies:manage'), (ctx) => {
    const acks = db.all(`SELECT id, document_id, user_id, revision, acknowledged_at, source FROM policy_acknowledgements`);
    const c = P.compliance(documents(), activeUsers(), acks);
    const staff = c.staff.filter(s => s.required);
    audit.log({ user: ctx.user, action: 'policy.compliance_view', entity: 'policy_acknowledgement', ip: ctx.ip, details: { documents: c.documents.length, staff: staff.length } });
    return { documents: c.documents, staff, outstanding: staff.reduce((n, s) => n + (s.required - s.signed), 0) };
  });

  r.post('/api/policies/report/preview', auth.requireAuth, auth.requirePerm('policies:manage'), (ctx) => {
    const m = readReport(ctx.body);
    audit.log({ user: ctx.user, action: 'policy.report_preview', entity: 'policy_ack_import', ip: ctx.ip, details: { sha256: m.sha256, rows: m.rows.length, counts: m.counts } });
    return { filename: m.filename, sheet: m.sheet, columns: m.columns, counts: m.counts, labels: OUTCOME_LABELS, rows: m.rows.slice(0, PREVIEW_ROWS), truncated: m.rows.length > PREVIEW_ROWS, total: m.rows.length };
  });

  r.post('/api/policies/report/import', auth.requireAuth, auth.requirePerm('policies:manage'), (ctx) => {
    const m = readReport(ctx.body);
    const toRecord = m.rows.filter(x => x.outcome === 'record');
    const id = uuid(); const now = db.now();
    const unmatched = m.rows.filter(x => !['record', 'already', 'not_signed'].includes(x.outcome)).length;
    db.transaction(() => {
      db.run(`INSERT INTO policy_ack_imports(id,filename,sha256,rows_read,recorded,already,unmatched,imported_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        id, m.filename, m.sha256, m.rows.length, toRecord.length, m.counts.already || 0, unmatched, ctx.user.id, now);
      for (const x of toRecord) {
        db.run(`INSERT OR IGNORE INTO policy_acknowledgements(id,document_id,user_id,revision,acknowledged_at,source,import_id,recorded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          uuid(), x.document_id, x.user_id, x.revision || '', x.acknowledged_at, 'powerdms', id, ctx.user.id, now);
      }
    });
    audit.log({ user: ctx.user, action: 'policy.report_import', entity: 'policy_ack_import', entityId: id, ip: ctx.ip, details: { sha256: m.sha256, rows: m.rows.length, recorded: toRecord.length, counts: m.counts } });
    ctx.status = 201;
    return { id, recorded: toRecord.length, counts: m.counts, labels: OUTCOME_LABELS };
  });

  r.get('/api/policies/imports', auth.requireAuth, auth.requirePerm('policies:manage'), () => ({
    imports: db.all(`SELECT i.id, i.filename, i.rows_read, i.recorded, i.already, i.unmatched, i.created_at, u.display_name imported_by_name FROM policy_ack_imports i LEFT JOIN users u ON u.id=i.imported_by ORDER BY i.created_at DESC LIMIT 50`),
  }));

  r.post('/api/policies/acknowledgements', auth.requireAuth, auth.requirePerm('policies:manage'), (ctx) => {
    const v = validate(ctx.body, { document_id: { type: 'string', required: true, maxLen: 64 }, user_id: { type: 'string', required: true, maxLen: 64 }, revision: { type: 'string', maxLen: 60 }, acknowledged_at: { type: 'date', required: true } });
    const doc = db.one(`SELECT id, is_active FROM policy_documents WHERE id=?`, v.document_id);
    if (!doc || !doc.is_active) throw badRequest('Choose a policy in effect', { fields: { document_id: 'not a policy in effect' } });
    const user = db.one(`SELECT id FROM users WHERE id=? AND is_active=1`, v.user_id);
    if (!user) throw badRequest('Choose an active staff account', { fields: { user_id: 'not an active account' } });
    // The programme's today, not the UTC date, which is tomorrow's after 5 pm in California (1.26.1, L2).
    if (v.acknowledged_at > require('../local-date').today()) throw badRequest('A sign-off cannot be dated in the future', { fields: { acknowledged_at: 'in the future' } });
    const exists = db.one(`SELECT id FROM policy_acknowledgements WHERE document_id=? AND user_id=? AND revision=?`, v.document_id, v.user_id, v.revision || '');
    if (exists) throw badRequest('This sign-off is already recorded for that revision');
    const id = uuid();
    db.run(`INSERT INTO policy_acknowledgements(id,document_id,user_id,revision,acknowledged_at,source,recorded_by) VALUES(?,?,?,?,?,?,?)`, id, v.document_id, v.user_id, v.revision || '', v.acknowledged_at, 'manual', ctx.user.id);
    audit.log({ user: ctx.user, action: 'policy.acknowledge', entity: 'policy_acknowledgement', entityId: id, ip: ctx.ip, details: { document_id: v.document_id, user_id: v.user_id, revision: v.revision || '', source: 'manual' } });
    ctx.status = 201; return { id };
  });

  r.delete('/api/policies/acknowledgements/:id', auth.requireAuth, auth.requirePerm('policies:manage'), (ctx) => {
    const a = db.one(`SELECT id, document_id, user_id, revision, source FROM policy_acknowledgements WHERE id=?`, ctx.params.id);
    if (!a) throw notFound();
    db.run(`DELETE FROM policy_acknowledgements WHERE id=?`, a.id);
    audit.log({ user: ctx.user, action: 'policy.acknowledgement_remove', entity: 'policy_acknowledgement', entityId: a.id, ip: ctx.ip, details: { document_id: a.document_id, user_id: a.user_id, revision: a.revision, source: a.source } });
    return { ok: true };
  });
};
