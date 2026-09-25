'use strict';
// Excel / CSV import: templates, preview (mapping + validation), commit.
const db = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const S = require('../spreadsheet');
const DI = require('../dataimport');
const { badRequest, notFound, forbidden } = require('../http');
const { encrypt, blindIndex, uuid, sha256 } = require('../crypto');
const M = require('../clients-model');

// What makes an imported row "the same row again": the kind of import and every mapped field the file
// gave it (values as text, keys sorted). Internal bookkeeping (_n, the raw client_ref) is left out; the
// resolved client_id is in, since "Doe, Jane" and "C26-0001" naming the same person are the same row.
// Position in the file is not part of it, so a re-sorted or trimmed copy of the same sheet is still
// recognised. Two genuinely identical rows in one upload (two bus passes, same day, same fare) both go
// in: the hashes are only written once the whole batch has been, so a row is checked against earlier
// uploads, not against its twin a few lines up.
function rowHash(entity, rec) {
  const def = DI.ENTITIES[entity];
  const keys = [...def.fields.map(f => f.key), 'client_id', 'funding_source_id'].filter(k => k !== 'client_ref' && rec[k] !== undefined && rec[k] !== null && rec[k] !== '').sort();
  return sha256(JSON.stringify([entity, keys.map(k => [k, String(rec[k])])]));
}

const permFor = (entity) => ({ clients: 'clients:write', resources: 'resources:write', interventions: 'interventions:write', calls: 'calls:write', time_entries: 'time:write', tasks: 'tasks:write', expenditures: 'budget:write' }[entity]);

module.exports = (r) => {
  r.get('/api/imports/data/entities', auth.requireAuth, (ctx) => ({ entities: Object.entries(DI.ENTITIES).filter(([k]) => auth.hasPerm(ctx.user, permFor(k))).map(([k, e]) => ({ key: k, label: e.label, fields: e.fields.map(f => ({ key: f.key, label: f.label, required: !!f.required, help: f.help || null })) })) }));

  // Empty template with headers and one example row. Not an export (it holds no data), so it is gated
  // by the import permission and the entity's own write permission rather than export:read.
  r.get('/api/imports/data/template/:entity', auth.requireAuth, auth.requirePerm('imports:read'), (ctx) => {
    const def = DI.ENTITIES[ctx.params.entity]; if (!def) throw notFound();
    if (!auth.hasPerm(ctx.user, permFor(ctx.params.entity))) throw forbidden();
    const example = { clients: { first_name: 'Jane', last_name: 'Doe', dob: '1990-05-01', phone: '555-0100', status: 'active', intake_date: '2026-09-01', primary_substance: 'opioids_fentanyl', risk_level: 'high' }, resources: { name: 'County Opioid Treatment Program', category: 'mat_otp', phone: '555-0200', accepts_medicaid: 'yes' }, interventions: { client_ref: 'C26-0001', occurred_at: '2026-09-10 14:00', type: 'outreach', duration_minutes: 30, location: 'field' }, calls: { client_ref: 'C26-0001', started_at: '2026-09-10 09:15', direction: 'outbound', contact_type: 'client', duration_minutes: 10, outcome: 'reached' }, time_entries: { work_date: '2026-09-10', minutes: 45, category: 'documentation' }, tasks: { title: 'Bring ID documents', client_ref: 'C26-0001', due_at: '2026-09-20', priority: 'normal' }, expenditures: { spent_at: '2026-09-10', amount: 25, fund: 'Opioid Settlement – Navigation FY26', category: 'transportation', client_ref: 'C26-0001', vendor: 'Metro Transit' } }[ctx.params.entity] || {};
    const fmt = ctx.query.get('format') === 'csv' ? 'csv' : 'xlsx';
    const columns = def.fields.map(f => ({ key: f.key, label: f.label + (f.required ? ' *' : ''), width: 18 }));
    const rows = [Object.fromEntries(def.fields.map(f => [f.key, example[f.key] ?? '']))];
    const body = fmt === 'csv' ? S.toCsv(rows, columns) : S.writeWorkbook([{ name: def.label, columns, rows }, { name: 'Instructions', columns: [{ key: 'a', label: 'How to use this template', width: 90 }], rows: [{ a: 'Fill one row per record; delete the example row. Columns marked * are required.' }, { a: 'Dates: YYYY-MM-DD or M/D/YYYY. Yes/no columns: yes or no.' }, ...def.fields.filter(f => f.help).map(f => ({ a: `${f.label}: ${f.help}` }))] }]);
    ctx.res.writeHead(200, { 'Content-Type': fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="suds-${ctx.params.entity}-template.${fmt}"` });
    ctx.res.end(body);
  });

  // Preview: parse the file, suggest a mapping, validate every row (raw body; entity + optional mapping in query)
  r.post('/api/imports/data/preview', auth.requireAuth, (ctx) => {
    const entity = ctx.query.get('entity'); const def = DI.ENTITIES[entity]; if (!def) throw badRequest('Unknown entity');
    if (!auth.hasPerm(ctx.user, permFor(entity))) throw forbidden();
    const buf = ctx.rawBody && ctx.rawBody.length ? ctx.rawBody : (ctx.body && ctx.body.text ? Buffer.from(ctx.body.text, 'utf8') : null);
    if (!buf) throw badRequest('Upload a .xlsx or .csv file');
    let parsed; try { parsed = S.parseFile(buf, ctx.headers['x-filename'] || ''); } catch (e) { throw badRequest('Could not read the file: ' + e.message); }
    const sheetIdx = Number(ctx.query.get('sheet') || 0); const sheet = parsed.sheets[sheetIdx] || parsed.sheets[0]; if (!sheet) throw badRequest('The file has no sheets');
    let mapping = null; try { mapping = ctx.query.get('mapping') ? JSON.parse(ctx.query.get('mapping')) : null; } catch { mapping = null; }
    if (!mapping) mapping = DI.suggestMapping(entity, sheet.headers.map(h => h.replace(/\s*\*$/, '')));
    // headers in the template carry a trailing " *"; map both spellings
    const normalizedMapping = {}; for (const h of sheet.headers) { const clean = h.replace(/\s*\*$/, ''); if (mapping[h]) normalizedMapping[h] = mapping[h]; else if (mapping[clean]) normalizedMapping[h] = mapping[clean]; }
    const rows = sheet.rows.slice(0, 2000).map((row, i) => {
      const { record, errors } = DI.convertRow(entity, normalizedMapping, row);
      if (record.client_ref !== undefined) { const id = DI.resolveClient(record.client_ref, ctx, auth); if (record.client_ref && !id) errors.push(`Client "${record.client_ref}" not found (use the client code or "Last, First")`); else if (id === 'ambiguous') errors.push(`Client "${record.client_ref}" matches several clients; use the client code`); else record.client_id = id || null; }
      if (entity === 'expenditures' && record.fund) { const f = db.one(`SELECT id FROM funding_sources WHERE name=? COLLATE NOCASE AND is_active=1`, record.fund); if (!f) errors.push(`Funding source "${record.fund}" not found`); else record.funding_source_id = f.id; }
      if (entity === 'clients' && record.first_name && record.last_name && !errors.length) { const dup = db.one(`SELECT client_code FROM clients WHERE full_name_idx=? AND deleted_at IS NULL`, blindIndex(record.last_name + record.first_name)); if (dup) record._duplicate_of = dup.client_code; }
      return { n: i + 2, record, errors };
    });
    audit.log({ user: ctx.user, action: 'import.data.preview', ip: ctx.ip, details: { entity, rows: rows.length, sheet: sheet.name } });
    return { entity, sheets: parsed.sheets.map(s => ({ name: s.name, rows: s.rows.length })), sheet: sheetIdx, headers: sheet.headers, mapping: normalizedMapping, fields: def.fields.map(f => ({ key: f.key, label: f.label, required: !!f.required })), rows, valid: rows.filter(x => !x.errors.length).length, invalid: rows.filter(x => x.errors.length).length, truncated: sheet.rows.length > 2000 };
  });

  // Commit validated rows (client sends back the records from the preview; server re-validates)
  r.post('/api/imports/data/commit', auth.requireAuth, (ctx) => {
    const { entity, records, skip_duplicates } = ctx.body || {}; const def = DI.ENTITIES[entity]; if (!def) throw badRequest('Unknown entity');
    if (!auth.hasPerm(ctx.user, permFor(entity))) throw forbidden();
    if (!Array.isArray(records) || !records.length) throw badRequest('No rows to import'); if (records.length > 2000) throw badRequest('Import at most 2000 rows at a time');
    let created = 0, skipped = 0, skippedDuplicates = 0; const errors = []; const imported = [];
    db.transaction(() => {
      records.forEach((rec, i) => {
        try {
          if (rec.client_ref !== undefined && !rec.client_id) { const id = DI.resolveClient(rec.client_ref, ctx, auth); if (rec.client_ref && (!id || id === 'ambiguous')) throw new Error(`client "${rec.client_ref}" not found`); rec.client_id = id || null; }
          if (rec.client_id) auth.assertClientAccess(ctx, rec.client_id);
          // Already imported (this file, or an earlier upload of it): skip, and say so, rather than double it.
          const hash = rowHash(entity, rec);
          if (db.one(`SELECT 1 FROM import_rows WHERE row_hash=?`, hash)) { skippedDuplicates++; return; }
          const id = uuid(); const now = db.now();
          switch (entity) {
            case 'clients': {
              if (skip_duplicates && db.one(`SELECT 1 FROM clients WHERE full_name_idx=? AND deleted_at IS NULL`, blindIndex((rec.last_name || '') + (rec.first_name || '')))) { skipped++; return; }
              const enc = M.encryptFields(rec); enc.full_name_idx = blindIndex((rec.last_name || '') + (rec.first_name || ''));
              const cols = { id, client_code: M.nextClientCode(), ...enc, created_by: ctx.user.id, intake_date: rec.intake_date || now.slice(0, 10) };
              for (const f of M.PLAIN_FIELDS) if (rec[f] !== undefined && rec[f] !== null) cols[f] = rec[f];
              const keys = Object.keys(cols).filter(k => cols[k] !== undefined);
              db.run(`INSERT INTO clients(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
              if (auth.caseloadRestricted(ctx.user) || ['navigator', 'clinician'].includes(ctx.user.role)) db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,created_by) VALUES(?,?,?,?,?,?)`, uuid(), id, ctx.user.id, 'primary', cols.intake_date, ctx.user.id);
              break; }
            case 'resources': { const keys = ['name', 'category', 'organization', 'phone', 'fax', 'email', 'website', 'address', 'city', 'zip', 'hours', 'eligibility', 'services', 'languages', 'accepts_medicaid', 'accepts_uninsured', 'mat_offered', 'contact_person', 'notes'].filter(k => rec[k] !== undefined && rec[k] !== null); if (!rec.name || !rec.category) throw new Error('name and category are required'); db.run(`INSERT INTO resources(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, id, ...keys.map(k => rec[k])); break; }
            case 'interventions': { if (!rec.client_id || !rec.occurred_at || !rec.type) throw new Error('client, date and type are required'); db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome,naloxone_kits,fentanyl_strips,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, rec.client_id, ctx.user.id, rec.type, rec.occurred_at, rec.duration_minutes || 0, rec.location || 'office', rec.modality || 'in_person', rec.outcome || null, rec.naloxone_kits || 0, rec.fentanyl_strips || 0, rec.summary ? require('../crypto').encrypt(rec.summary) : null); break; }
            case 'calls': { if (!rec.started_at || !rec.direction) throw new Error('date and direction are required'); db.run(`INSERT INTO calls(id,client_id,user_id,direction,started_at,duration_minutes,contact_type,contact_name_enc,phone_enc,purpose_enc,outcome,crisis,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, rec.client_id || null, ctx.user.id, rec.direction, rec.started_at, rec.duration_minutes || 0, rec.contact_type || 'client', rec.contact_name ? encrypt(rec.contact_name) : null, rec.phone ? encrypt(rec.phone) : null, rec.purpose ? encrypt(rec.purpose) : null, rec.outcome || 'reached', rec.crisis ? 1 : 0, rec.summary ? encrypt(rec.summary) : null); break; }
            case 'time_entries': { if (!rec.work_date || !rec.minutes) throw new Error('date and minutes are required'); db.run(`INSERT INTO time_entries(id,user_id,client_id,work_date,minutes,category,billable,description_enc) VALUES(?,?,?,?,?,?,?,?)`, id, ctx.user.id, rec.client_id || null, rec.work_date, Math.round(rec.minutes), rec.category || 'direct_service', rec.billable ? 1 : 0, rec.description ? encrypt(String(rec.description)) : null); break; }
            case 'tasks': { if (!rec.title) throw new Error('title is required'); db.run(`INSERT INTO tasks(id,client_id,assigned_to,created_by,title_enc,description_enc,due_at,priority) VALUES(?,?,?,?,?,?,?,?)`, id, rec.client_id || null, ctx.user.id, ctx.user.id, encrypt(String(rec.title)), rec.description ? encrypt(String(rec.description)) : null, rec.due_at || null, rec.priority || 'normal'); break; }
            case 'expenditures': { const f = rec.funding_source_id ? db.one(`SELECT id FROM funding_sources WHERE id=?`, rec.funding_source_id) : db.one(`SELECT id FROM funding_sources WHERE name=? COLLATE NOCASE AND is_active=1`, rec.fund); if (!f || !rec.spent_at || !rec.amount || !rec.category) throw new Error('date, amount, funding source and category are required'); db.run(`INSERT INTO expenditures(id,funding_source_id,client_id,user_id,spent_at,amount,category,vendor,description_enc,receipt_ref) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, f.id, rec.client_id || null, ctx.user.id, rec.spent_at, rec.amount, rec.category, rec.vendor || null, rec.description ? encrypt(String(rec.description)) : null, rec.receipt_ref || null); break; }
          }
          created++; imported.push([hash, id]);
        } catch (e) { errors.push({ n: rec._n || i + 1, error: e.message }); }
      });
      if (errors.length && !ctx.body.partial) throw badRequest(`${errors.length} row(s) could not be imported; nothing was saved`, { rows: errors });
      for (const [hash, id] of imported) db.run(`INSERT OR IGNORE INTO import_rows(row_hash,entity,record_id,imported_by) VALUES(?,?,?,?)`, hash, entity, id, ctx.user.id);
    });
    audit.log({ user: ctx.user, action: 'import.data.commit', ip: ctx.ip, details: { entity, created, skipped, skipped_duplicates: skippedDuplicates, errors: errors.length } });
    return { created, skipped, skipped_duplicates: skippedDuplicates, errors };
  });
};
