'use strict';
// County form library: administrators upload the program's forms (PDF/Word/image) and describe the fields to fill;
// staff open a form from a client record, it is pre-filled from the chart, completed, saved encrypted, printed as a
// PDF, and a signed/scanned copy can be attached. Every read of a filled form is PHI access and is audited.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const C = require('../constants');
const { badRequest, notFound } = require('../http');
const { validate, paging } = require('../validate');
const { uuid, encrypt, decrypt } = require('../crypto');
const M = require('../clients-model');
const pdf = require('../pdf');

const MAX_TEMPLATE_BYTES = 12 * 1024 * 1024, MAX_ATTACH_BYTES = 10 * 1024 * 1024, MAX_FIELDS = 150;
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
  const type = sniff(buf) || (m && m[1] === 'text/plain' ? 'text/plain' : null); if (!type || !FILE_TYPES[type]) throw badRequest(`${label} must be a PDF, Word document, picture or text file`);
  return { b64, buf, type };
}
// Field definitions: [{ key, label, type, required, options, autofill, help }]
function cleanFields(list) {
  if (!Array.isArray(list)) throw badRequest('fields must be a list');
  if (list.length > MAX_FIELDS) throw badRequest(`At most ${MAX_FIELDS} fields`);
  const keys = new Set(); const out = [];
  list.forEach((f, i) => {
    if (!f || typeof f !== 'object') throw badRequest(`field ${i + 1} is invalid`);
    const type = C.FORM_FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const label = String(f.label || '').trim().slice(0, 200); if (!label) throw badRequest(`field ${i + 1} needs a label`);
    let key = String(f.key || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `field_${i + 1}`;
    if (type !== 'section' && type !== 'note') { let k = key, n = 2; while (keys.has(k)) k = `${key}_${n++}`; key = k; keys.add(key); }
    const o = { key, label, type };
    if (f.required && !['section', 'note', 'checkbox'].includes(type)) o.required = true;
    if (type === 'select') o.options = String(Array.isArray(f.options) ? f.options.join(',') : f.options || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean).slice(0, 50);
    if (f.autofill && C.FORM_AUTOFILL.includes(f.autofill)) o.autofill = f.autofill;
    if (f.help) o.help = String(f.help).slice(0, 300);
    out.push(o);
  });
  return out;
}
// Best-effort: pull AcroForm field names out of an (uncompressed) PDF so admins do not have to type them.
function detectPdfFields(buf) {
  const s = buf.toString('latin1'); const out = []; const seen = new Set();
  for (const chunk of s.split('endobj')) {
    if (out.length >= MAX_FIELDS) break;
    const t = /\/T\s*\(([^)]{1,80})\)/.exec(chunk); const ft = /\/FT\s*\/(Tx|Btn|Ch)/.exec(chunk); if (!t || !ft) continue;
    const name = t[1].replace(/\\(.)/g, '$1').trim(); if (!name || seen.has(name)) continue; seen.add(name);
    const type = ft[1] === 'Btn' ? 'checkbox' : ft[1] === 'Ch' ? 'select' : /\/Ff\s+(4096|\d*[4-9]\d{3,})/.test(chunk) ? 'textarea' : 'text';
    out.push({ key: name, label: name.replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase()), type });
  }
  return out;
}
const guessAutofill = (label) => { const l = label.toLowerCase(); if (/\b(full|client|participant|patient)?\s*name\b/.test(l) && !/worker|staff|navigator|witness|contact|parent|guardian/.test(l)) return 'client.full_name'; if (/first name/.test(l)) return 'client.first_name'; if (/last name/.test(l)) return 'client.last_name'; if (/\b(dob|birth)/.test(l)) return 'client.dob'; if (/phone|telephone/.test(l)) return 'client.phone'; if (/e-?mail/.test(l)) return 'client.email'; if (/address|street/.test(l)) return 'client.address'; if (/\bcity\b/.test(l)) return 'client.city'; if (/\bzip/.test(l)) return 'client.zip'; if (/medicaid/.test(l)) return 'client.medicaid_id'; if (/insurance/.test(l)) return 'client.insurance'; if (/client (id|code|number)|case (id|number)/.test(l)) return 'client.client_code'; if (/\b(today|date)\b/.test(l) && !/birth|dob/.test(l)) return 'today'; if (/navigator|worker|staff|case manager|counselor/.test(l)) return 'worker.name'; return undefined; };

function autofillValues(fields, clientRow, user) {
  const c = M.decryptRow(clientRow); const today = new Date().toISOString().slice(0, 10);
  const src = {
    'client.full_name': [c.first_name, c.last_name].filter(Boolean).join(' '), 'client.first_name': c.first_name, 'client.last_name': c.last_name, 'client.preferred_name': c.preferred_name, 'client.dob': c.dob, 'client.phone': c.phone, 'client.email': c.email,
    'client.address': [c.address, [c.city, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), 'client.city': c.city, 'client.zip': c.zip, 'client.client_code': c.client_code, 'client.gender': c.gender, 'client.pronouns': c.pronouns, 'client.insurance': c.insurance, 'client.medicaid_id': c.medicaid_id,
    'client.emergency_contact': c.emergency_contact, 'client.primary_substance': c.primary_substance ? require('../options').labelOf('SUBSTANCES', c.primary_substance) : null, 'client.mat_status': c.mat_status, 'client.intake_date': c.intake_date,
    'worker.name': user.display_name, 'worker.title': user.title || '', 'org.name': db.getSetting('org_name', 'SUDS'), 'org.county': db.getSetting('county_name', ''), today,
  };
  const values = {};
  for (const f of fields) { if (f.autofill && src[f.autofill] != null && src[f.autofill] !== '') values[f.key] = src[f.autofill]; else if (f.type === 'date' && f.autofill === 'today') values[f.key] = today; }
  return values;
}
function cleanValues(fields, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw badRequest('values must be an object');
  const out = {};
  for (const f of fields) {
    if (f.type === 'section' || f.type === 'note') continue;
    let v = values[f.key]; if (v === undefined) continue;
    if (f.type === 'checkbox') v = (v === true || v === 1 || v === '1' || v === 'true'); else if (v === null) v = null; else v = String(v).slice(0, f.type === 'textarea' ? 5000 : 500);
    out[f.key] = v;
  }
  return out;
}
const missingRequired = (fields, values) => fields.filter(f => f.required && (values[f.key] === undefined || values[f.key] === null || values[f.key] === '')).map(f => f.label);
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const tpl = (row, withFile = false) => row && ({ ...row, fields: parseJson(row.fields_json, []), fields_json: undefined, file_url: withFile && row.file_b64 ? `data:${row.content_type};base64,${row.file_b64}` : undefined, has_file: !!row.file_b64, file_b64: undefined });
function loadForm(ctx, id) {
  const f = db.one(`SELECT * FROM client_forms WHERE id=? AND deleted_at IS NULL`, id); if (!f) throw notFound();
  auth.assertClientAccess(ctx, f.client_id); return f;
}
// A form's notes are free text about the client ("signed at her sister's house"): encrypted like its values.
const formNotes = (f) => (f.notes_enc ? decrypt(f.notes_enc) : null);
const formOut = (f, { values = true } = {}) => ({ ...f, fields: parseJson(f.fields_json, []), fields_json: undefined, values: values ? parseJson(decrypt(f.values_enc), {}) : undefined, values_enc: undefined, notes: formNotes(f), notes_enc: undefined });

// An uploaded file's declared type is attacker-chosen. Echoing it back on download would let someone
// store text/html on this origin and have the browser run it as a same-origin page, so only the types the
// form library actually deals in are served; anything else is downloaded as opaque bytes.
const SERVABLE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
function safeContentType(t) { return SERVABLE_TYPES.has(String(t || '').toLowerCase().split(';')[0].trim()) ? String(t).split(';')[0].trim() : 'application/octet-stream'; }

// A printed client form is a Part 2 record wherever it goes next: in a Part 2 programme it carries the label
// and the §2.32 notice (the full text, so it can accompany the page if it is sent on).
function printFooter() {
  const disclosure = require('../disclosure'); const n = disclosure.notice();
  const printed = `Printed from SUDS ${new Date().toISOString().slice(0, 10)}.`;
  return disclosure.part2Program() ? `${printed} PROTECTED BY 42 CFR PART 2. ${n.short} If this record is disclosed, this notice must accompany it (42 CFR §2.32): ${n.text}`
    : `${printed} Contains protected health information; handle per HIPAA.`;
}

module.exports = (r) => {
  // ---------- template library ----------
  // Starter templates, so a new installation is not left with an empty form library and no consent form.
  r.get('/api/forms/starters', auth.requireAuth, auth.requirePerm('forms:manage'), () => ({ starters: require('../form-starters').list() }));
  r.post('/api/forms/starters', auth.requireAuth, auth.requirePerm('forms:manage'), (ctx) => {
    const keys = Array.isArray(ctx.body && ctx.body.keys) ? ctx.body.keys.filter(k => typeof k === 'string') : null;
    const out = require('../form-starters').install({ keys: keys && keys.length ? keys : null, actor: ctx.user.id });
    audit.log({ user: ctx.user, action: 'forms.starters.request', ip: ctx.ip, details: { added: out.added.length } });
    return out;
  });

  r.get('/api/forms/templates', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write', 'forms:manage'), (ctx) => {
    const all = ctx.query.get('active') === '0' && auth.hasPerm(ctx.user, 'forms:manage');
    const rows = db.all(`SELECT t.id, t.name, t.description, t.category, t.version, t.filename, t.content_type, t.bytes, t.fields_json, t.instructions, t.is_active, t.updated_at, t.created_at, (t.file_b64 IS NOT NULL) has_file, (SELECT COUNT(*) FROM client_forms f WHERE f.template_id=t.id AND f.deleted_at IS NULL) use_count FROM form_templates t ${all ? '' : 'WHERE t.is_active=1'} ORDER BY t.category, t.name`);
    return { templates: rows.map(t => ({ ...t, fields: parseJson(t.fields_json, []), fields_json: undefined, field_count: parseJson(t.fields_json, []).filter(f => !['section', 'note'].includes(f.type)).length })), categories: C.FORM_CATEGORIES, field_types: C.FORM_FIELD_TYPES, autofill: C.FORM_AUTOFILL };
  });
  r.get('/api/forms/templates/:id', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write', 'forms:manage'), (ctx) => {
    const t = db.one(`SELECT * FROM form_templates WHERE id=?`, ctx.params.id); if (!t) throw notFound();
    return { template: tpl(t, ctx.query.get('file') === '1') };
  });
  // Upload a county form: file (optional) + field definitions. If a PDF with form fields is uploaded and no fields are given, they are detected.
  r.post('/api/forms/templates', auth.requireAuth, auth.requirePerm('forms:manage'), (ctx) => {
    const v = validate(ctx.body, { name: { type: 'string', required: true, maxLen: 200 }, description: { type: 'string', maxLen: 1000 }, category: { type: 'string', enum: C.FORM_CATEGORIES }, version: { type: 'string', maxLen: 40 }, filename: { type: 'string', maxLen: 200 }, instructions: { type: 'string', maxLen: 3000 } });
    const file = fromDataUrl(ctx.body.file_url ?? ctx.body.file, MAX_TEMPLATE_BYTES, 'Form file');
    let fields = Array.isArray(ctx.body.fields) && ctx.body.fields.length ? cleanFields(ctx.body.fields) : [];
    let detected = 0;
    if (!fields.length && file && file.type === 'application/pdf') { fields = cleanFields(detectPdfFields(file.buf).map(f => ({ ...f, autofill: guessAutofill(f.label) }))); detected = fields.length; }
    const id = uuid();
    db.run(`INSERT INTO form_templates(id,name,description,category,version,filename,content_type,bytes,file_b64,fields_json,instructions,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, v.name, v.description || null, v.category || 'other', v.version || null, file ? (v.filename || `${v.name}.${FILE_TYPES[file.type]}`) : null, file ? file.type : null, file ? file.buf.length : 0, file ? file.b64 : null, JSON.stringify(fields), v.instructions || null, ctx.user.id);
    audit.log({ user: ctx.user, action: 'form_template.create', entity: 'form_template', entityId: id, ip: ctx.ip, details: { name: v.name, fields: fields.length, detected, bytes: file ? file.buf.length : 0 } });
    ctx.status = 201; return { id, fields, detected };
  });
  r.put('/api/forms/templates/:id', auth.requireAuth, auth.requirePerm('forms:manage'), (ctx) => {
    const t = db.one(`SELECT id, updated_at FROM form_templates WHERE id=?`, ctx.params.id); if (!t) throw notFound();
    require('../crud').assertFresh(ctx, t, 'form_template');
    const v = validate(ctx.body, { name: { type: 'string', maxLen: 200 }, description: { type: 'string', maxLen: 1000 }, category: { type: 'string', enum: C.FORM_CATEGORIES }, version: { type: 'string', maxLen: 40 }, filename: { type: 'string', maxLen: 200 }, instructions: { type: 'string', maxLen: 3000 }, is_active: { type: 'boolean' } }, { partial: true });
    const sets = Object.keys(v).map(k => `${k}=?`); const params = Object.keys(v).map(k => v[k]);
    if (ctx.body.fields !== undefined) { sets.push('fields_json=?'); params.push(JSON.stringify(cleanFields(ctx.body.fields))); }
    if (ctx.body.file_url || ctx.body.file) { const file = fromDataUrl(ctx.body.file_url ?? ctx.body.file, MAX_TEMPLATE_BYTES, 'Form file'); sets.push('file_b64=?', 'content_type=?', 'bytes=?', 'filename=?'); params.push(file.b64, file.type, file.buf.length, v.filename || ctx.body.filename || `form.${FILE_TYPES[file.type]}`); }
    if (ctx.body.remove_file) { sets.push('file_b64=NULL', 'content_type=NULL', 'bytes=0', 'filename=NULL'); }
    if (!sets.length) return { ok: true, updated_at: t.updated_at };
    const stamp = db.now();
    db.run(`UPDATE form_templates SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...params, stamp, t.id);
    audit.log({ user: ctx.user, action: 'form_template.update', entity: 'form_template', entityId: t.id, ip: ctx.ip, details: { fields: Object.keys(v).concat(ctx.body.fields !== undefined ? ['fields'] : [], ctx.body.file_url || ctx.body.file ? ['file'] : []) } });
    return { ok: true, updated_at: stamp };
  });
  r.delete('/api/forms/templates/:id', auth.requireAuth, auth.requirePerm('forms:manage'), (ctx) => {
    const t = db.one(`SELECT id FROM form_templates WHERE id=?`, ctx.params.id); if (!t) throw notFound();
    db.run(`UPDATE form_templates SET is_active=0, updated_at=? WHERE id=?`, db.now(), t.id);
    audit.log({ user: ctx.user, action: 'form_template.retire', entity: 'form_template', entityId: t.id, ip: ctx.ip });
    return { ok: true };
  });
  r.get('/api/forms/templates/:id/file', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write', 'forms:manage'), (ctx) => {
    const t = db.one(`SELECT * FROM form_templates WHERE id=?`, ctx.params.id); if (!t || !t.file_b64) throw notFound('No file for this form');
    ctx.res.writeHead(200, { 'Content-Type': safeContentType(t.content_type), 'Content-Disposition': `${ctx.query.get('inline') === '1' ? 'inline' : 'attachment'}; filename="${(t.filename || 'form').replace(/["\r\n]/g, '')}"` });
    ctx.res.end(Buffer.from(t.file_b64, 'base64')); return null;
  });
  // A blank, printable version drawn from the field definitions (for forms uploaded without a file, or to hand-fill)
  r.get('/api/forms/templates/:id/blank.pdf', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write', 'forms:manage'), (ctx) => {
    const t = db.one(`SELECT * FROM form_templates WHERE id=?`, ctx.params.id); if (!t) throw notFound();
    const body = pdf.renderForm({ title: t.name, subtitle: t.description, org: db.getSetting('org_name', 'SUDS'), meta: [t.version ? `Version ${t.version}` : null], fields: parseJson(t.fields_json, []), values: {}, footer: 'Blank form printed from SUDS' });
    ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${t.name.replace(/[^\w.-]+/g, '_')}-blank.pdf"` }); ctx.res.end(body); return null;
  });

  // ---------- forms filled out for a client ----------
  r.get('/api/clients/:id/forms', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write'), (ctx) => {
    auth.assertClientAccess(ctx, ctx.params.id);
    const rows = db.all(`SELECT f.id, f.template_id, f.template_name, f.status, f.completed_at, f.created_at, f.updated_at, f.notes_enc, cu.display_name completed_by_name, cr.display_name created_by_name, (SELECT COUNT(*) FROM client_form_files x WHERE x.client_form_id=f.id) attachments FROM client_forms f LEFT JOIN users cu ON cu.id=f.completed_by JOIN users cr ON cr.id=f.created_by WHERE f.client_id=? AND f.deleted_at IS NULL ORDER BY f.updated_at DESC`, ctx.params.id)
      .map(f => ({ ...f, notes: formNotes(f), notes_enc: undefined }));
    audit.log({ user: ctx.user, action: 'client_form.list', entity: 'client', entityId: ctx.params.id, clientId: ctx.params.id, ip: ctx.ip, details: { count: rows.length } });
    return { forms: rows };
  });
  // Start a form for a client: pre-filled from the chart
  r.post('/api/clients/:id/forms', auth.requireAuth, auth.requirePerm('forms:write'), (ctx) => {
    const client = db.one(`SELECT * FROM clients WHERE id=? AND deleted_at IS NULL`, ctx.params.id); if (!client) throw notFound();
    auth.assertClientAccess(ctx, client.id);
    const { template_id } = validate(ctx.body, { template_id: { type: 'string', required: true } });
    const t = db.one(`SELECT * FROM form_templates WHERE id=? AND is_active=1`, template_id); if (!t) throw notFound('Form not found');
    const fields = parseJson(t.fields_json, []); const values = { ...autofillValues(fields, client, ctx.user), ...(ctx.body.values ? cleanValues(fields, ctx.body.values) : {}) };
    const id = uuid();
    db.run(`INSERT INTO client_forms(id,client_id,template_id,template_name,fields_json,values_enc,status,created_by) VALUES(?,?,?,?,?,?,'draft',?)`, id, client.id, t.id, t.name + (t.version ? ` (v${t.version})` : ''), JSON.stringify(fields), encrypt(JSON.stringify(values)), ctx.user.id);
    audit.log({ user: ctx.user, action: 'client_form.create', entity: 'client_form', entityId: id, clientId: client.id, ip: ctx.ip, details: { template: t.name } });
    ctx.status = 201; return { id, fields, values };
  });
  r.get('/api/forms/:id', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write'), (ctx) => {
    const f = loadForm(ctx, ctx.params.id);
    audit.log({ user: ctx.user, action: 'client_form.view', entity: 'client_form', entityId: f.id, clientId: f.client_id, ip: ctx.ip });
    const files = db.all(`SELECT id, filename, content_type, bytes, created_at, uploaded_by FROM client_form_files WHERE client_form_id=? ORDER BY created_at`, f.id);
    const t = f.template_id ? db.one(`SELECT id, name, instructions, (file_b64 IS NOT NULL) has_file, content_type FROM form_templates WHERE id=?`, f.template_id) : null;
    return { form: { ...formOut(f), files, template: t } };
  });
  r.put('/api/forms/:id', auth.requireAuth, auth.requirePerm('forms:write'), (ctx) => {
    const f = loadForm(ctx, ctx.params.id);
    if (f.status === 'completed' && !auth.hasPerm(ctx.user, 'forms:manage')) throw badRequest('This form is completed. Ask a supervisor to reopen it.');
    require('../crud').assertFresh(ctx, f, 'client_form');
    const fields = parseJson(f.fields_json, []);
    const v = validate(ctx.body, { status: { type: 'string', enum: ['draft', 'completed', 'void'] }, notes: { type: 'string', maxLen: 2000 } }, { partial: true });
    let values = parseJson(decrypt(f.values_enc), {});
    if (ctx.body.values !== undefined) values = { ...values, ...cleanValues(fields, ctx.body.values) };
    const stamp = db.now();
    const sets = ['values_enc=?', 'updated_at=?']; const params = [encrypt(JSON.stringify(values)), stamp];
    if (v.notes !== undefined) { sets.push('notes_enc=?'); params.push(v.notes ? encrypt(v.notes) : null); }
    if (v.status) {
      if (v.status === 'completed') { const miss = missingRequired(fields, values); if (miss.length) { db.run(`UPDATE client_forms SET values_enc=?, updated_at=? WHERE id=?`, params[0], params[1], f.id); throw badRequest(`Please fill in: ${miss.join(', ')}`, { updated_at: stamp }); } sets.push('status=?', 'completed_at=?', 'completed_by=?'); params.push('completed', db.now(), ctx.user.id); }
      else { sets.push('status=?', 'completed_at=NULL', 'completed_by=NULL'); params.push(v.status); }
    }
    db.run(`UPDATE client_forms SET ${sets.join(', ')} WHERE id=?`, ...params, f.id);
    audit.log({ user: ctx.user, action: v.status === 'completed' ? 'client_form.complete' : 'client_form.update', entity: 'client_form', entityId: f.id, clientId: f.client_id, ip: ctx.ip, details: { status: v.status, fields_changed: ctx.body.values ? Object.keys(ctx.body.values).length : 0 } });
    return { ok: true, missing: missingRequired(fields, values), updated_at: stamp };
  });
  r.delete('/api/forms/:id', auth.requireAuth, auth.requirePerm('forms:write'), (ctx) => {
    const f = loadForm(ctx, ctx.params.id);
    if (f.status === 'completed' && !auth.hasPerm(ctx.user, 'forms:manage')) throw badRequest('Completed forms can only be removed by a supervisor');
    db.run(`UPDATE client_forms SET deleted_at=?, updated_at=? WHERE id=?`, db.now(), db.now(), f.id);
    audit.log({ user: ctx.user, action: 'client_form.delete', entity: 'client_form', entityId: f.id, clientId: f.client_id, ip: ctx.ip });
    return { ok: true };
  });
  // Printable / downloadable PDF of the filled form
  r.get('/api/forms/:id/pdf', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write'), (ctx) => {
    const f = loadForm(ctx, ctx.params.id); const client = M.decryptRow(db.one(`SELECT * FROM clients WHERE id=?`, f.client_id));
    const values = parseJson(decrypt(f.values_enc), {}); const by = f.completed_by ? db.one(`SELECT display_name FROM users WHERE id=?`, f.completed_by) : null;
    audit.log({ user: ctx.user, action: 'client_form.print', entity: 'client_form', entityId: f.id, clientId: f.client_id, ip: ctx.ip });
    const body = pdf.renderForm({ title: f.template_name, org: db.getSetting('org_name', 'SUDS'), meta: [`Client: ${client.first_name} ${client.last_name} (${client.client_code})`, f.status === 'completed' ? `Completed ${f.completed_at.slice(0, 10)}${by ? ' by ' + by.display_name : ''}` : 'DRAFT'], fields: parseJson(f.fields_json, []), values, footer: printFooter() });
    ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `${ctx.query.get('download') === '1' ? 'attachment' : 'inline'}; filename="${client.client_code}-${f.template_name.replace(/[^\w.-]+/g, '_')}.pdf"` }); ctx.res.end(body); return null;
  });
  // Signed / scanned copies attached to the filled form (stored encrypted)
  r.post('/api/forms/:id/files', auth.requireAuth, auth.requirePerm('forms:write'), (ctx) => {
    const f = loadForm(ctx, ctx.params.id);
    if (db.one(`SELECT COUNT(*) n FROM client_form_files WHERE client_form_id=?`, f.id).n >= 10) throw badRequest('At most 10 attachments per form');
    const v = validate(ctx.body, { filename: { type: 'string', maxLen: 200 } });
    const file = fromDataUrl(ctx.body.file_url ?? ctx.body.file, MAX_ATTACH_BYTES, 'Attachment'); if (!file) throw badRequest('Attachment is required');
    const id = uuid(); const name = (v.filename || `signed.${FILE_TYPES[file.type]}`).replace(/[\r\n"]/g, '');
    db.run(`INSERT INTO client_form_files(id,client_form_id,client_id,filename,content_type,bytes,data_enc,uploaded_by) VALUES(?,?,?,?,?,?,?,?)`, id, f.id, f.client_id, name, file.type, file.buf.length, encrypt(file.b64), ctx.user.id);
    const stamp = db.now();
    db.run(`UPDATE client_forms SET updated_at=? WHERE id=?`, stamp, f.id);
    audit.log({ user: ctx.user, action: 'client_form.attach', entity: 'client_form', entityId: f.id, clientId: f.client_id, ip: ctx.ip, details: { file_id: id, bytes: file.buf.length, type: file.type } });
    // form_updated_at: the form's new version, so the open filler's next autosave is not refused as stale.
    ctx.status = 201; return { id, filename: name, content_type: file.type, bytes: file.buf.length, form_updated_at: stamp };
  });
  r.get('/api/forms/:id/files/:fid', auth.requireAuth, auth.requirePerm('forms:read', 'forms:write'), (ctx) => {
    const f = loadForm(ctx, ctx.params.id); const x = db.one(`SELECT * FROM client_form_files WHERE id=? AND client_form_id=?`, ctx.params.fid, f.id); if (!x) throw notFound();
    audit.log({ user: ctx.user, action: 'client_form.file.view', entity: 'client_form', entityId: f.id, clientId: f.client_id, ip: ctx.ip, details: { file_id: x.id } });
    ctx.res.writeHead(200, { 'Content-Type': safeContentType(x.content_type), 'Content-Disposition': `${ctx.query.get('download') === '1' ? 'attachment' : 'inline'}; filename="${String(x.filename).replace(/["\r\n]/g, '')}"`, 'X-Content-Type-Options': 'nosniff' }); ctx.res.end(Buffer.from(decrypt(x.data_enc), 'base64')); return null;
  });
  r.delete('/api/forms/:id/files/:fid', auth.requireAuth, auth.requirePerm('forms:write'), (ctx) => {
    const f = loadForm(ctx, ctx.params.id); const x = db.one(`SELECT id FROM client_form_files WHERE id=? AND client_form_id=?`, ctx.params.fid, f.id); if (!x) throw notFound();
    const stamp = db.now();
    db.run(`DELETE FROM client_form_files WHERE id=?`, x.id); db.tombstone('client_form_files', x.id); db.run(`UPDATE client_forms SET updated_at=? WHERE id=?`, stamp, f.id);
    audit.log({ user: ctx.user, action: 'client_form.file.remove', entity: 'client_form', entityId: f.id, clientId: f.client_id, ip: ctx.ip, details: { file_id: x.id } });
    return { ok: true, form_updated_at: stamp };
  });
};
