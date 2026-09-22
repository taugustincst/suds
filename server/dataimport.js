'use strict';
// Spreadsheet (Excel / CSV) import definitions: which entities can be imported, their columns, aliases and validation.
const db = require('./db');
const C = require('./constants');
const { excelDate } = require('./spreadsheet');
const { blindIndex } = require('./crypto');

const yes = (v) => v === true || /^(1|y|yes|true|x)$/i.test(String(v ?? '').trim());
const dateOf = (v) => { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') return excelDate(v); const s = String(v).trim(); const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`; const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s); if (us) return `${us[3].length === 2 ? '20' + us[3] : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`; const d = new Date(s); return isNaN(d) ? undefined : d.toISOString().slice(0, 10); };
const datetimeOf = (v) => { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') { if (!Number.isFinite(v) || v < 1) return undefined; if (v % 1) return new Date(Math.round((v - 25569) * 86400000)).toISOString(); const d = excelDate(v); return d ? new Date(d + 'T12:00:00').toISOString() : undefined; } const d = new Date(String(v).trim()); if (!isNaN(d)) return d.toISOString(); const day = dateOf(v); return day ? new Date(day + 'T12:00:00').toISOString() : undefined; };
const enumOf = (list) => (v) => { if (v === null || v === undefined || v === '') return null; const k = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_'); let hit = list.find(x => x.toLowerCase() === k) || list.find(x => x.toLowerCase().replace(/_/g, '') === k.replace(/_/g, '')); if (hit === undefined) { const c = list.filter(x => x.includes(k) || k.includes(x)); if (c.length === 1) hit = c[0]; } return hit === undefined ? undefined : hit; };
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : undefined; };
const str = (max) => (v) => (v === null || v === undefined) ? null : String(v).trim().slice(0, max);

// field: { key, label, aliases, required, parse, help }
const F = (key, label, aliases, parse, extra = {}) => ({ key, label, aliases: [label, ...aliases].map(a => a.toLowerCase()), parse, ...extra });
const clientRef = F('client_ref', 'Client', ['client code', 'client', 'code', 'client id', 'name', 'client name'], str(120), { required: true, help: 'Client code (C26-0012), or "Last, First", or "First Last"' });

const ENTITIES = {
  clients: { label: 'Clients', table: 'clients', fields: [
    F('first_name', 'First name', ['first', 'given name', 'firstname'], str(100), { required: true }), F('last_name', 'Last name', ['last', 'surname', 'family name', 'lastname'], str(100), { required: true }),
    F('preferred_name', 'Preferred name', ['nickname', 'goes by'], str(100)), F('dob', 'Date of birth', ['dob', 'birth date', 'birthdate', 'birthday'], dateOf), F('phone', 'Phone', ['phone number', 'cell', 'mobile', 'telephone'], str(40)), F('email', 'Email', ['e-mail'], str(200)),
    F('address', 'Address', ['street', 'address line'], str(300)), F('city', 'City', [], str(100)), F('zip', 'ZIP', ['zip code', 'postal code'], str(12)), F('gender', 'Gender', ['sex'], str(40)), F('preferred_language', 'Language', ['preferred language'], str(60)),
    F('status', 'Status', ['program status'], enumOf(['waitlist', 'active', 'inactive', 'closed', 'deceased'])), F('intake_date', 'Intake date', ['intake', 'enrolled', 'enrollment date', 'start date'], dateOf), F('referral_source', 'Referral source', ['referred by', 'source'], str(120)),
    F('primary_substance', 'Primary substance', ['substance', 'drug of choice', 'doc'], enumOf(C.SUBSTANCES)), F('asam_level', 'ASAM level', ['asam', 'level of care'], str(20)), F('mat_status', 'MAT status', ['mat', 'moud'], enumOf(['none', 'interested', 'referred', 'active', 'discontinued', 'unknown'])),
    F('risk_level', 'Risk level', ['risk'], enumOf(['low', 'moderate', 'high', 'critical'])), F('housing_status', 'Housing', ['housing status', 'living situation'], str(60)), F('insurance', 'Insurance', ['payer', 'coverage'], str(100)),
    F('overdose_history', 'Overdose history', ['overdose', 'od history', 'prior overdose'], yes), F('naloxone_provided', 'Naloxone provided', ['naloxone', 'narcan'], yes), F('goals', 'Goals', ['client goals'], str(2000)), F('flags', 'Safety flags', ['flags', 'alerts'], str(300)),
  ] },
  resources: { label: 'Resource directory', table: 'resources', fields: [
    F('name', 'Name', ['program', 'resource', 'provider', 'service name'], str(200), { required: true }), F('category', 'Category', ['type', 'service type'], enumOf(C.RESOURCE_CATEGORIES), { required: true, help: C.RESOURCE_CATEGORIES.join(', ') }), F('organization', 'Organization', ['agency', 'org'], str(200)),
    F('phone', 'Phone', ['telephone', 'phone number'], str(40)), F('fax', 'Fax', [], str(40)), F('email', 'Email', [], str(200)), F('website', 'Website', ['url', 'web'], str(300)), F('address', 'Address', ['street'], str(300)), F('city', 'City', [], str(100)), F('zip', 'ZIP', ['zip code'], str(12)),
    F('hours', 'Hours', [], str(200)), F('eligibility', 'Eligibility', ['criteria'], str(1000)), F('services', 'Services', ['description'], str(1000)), F('languages', 'Languages', [], str(200)), F('accepts_medicaid', 'Accepts Medicaid', ['medicaid'], yes), F('accepts_uninsured', 'Accepts uninsured', ['uninsured', 'sliding scale'], yes),
    F('mat_offered', 'MAT offered', ['mat', 'moud'], str(200)), F('contact_person', 'Contact person', ['contact'], str(200)), F('summary', 'Summary', ['overview', 'about', 'profile'], str(3000)), F('service_tags', 'Service tags', ['tags', 'services offered'], str(1000), { help: 'comma separated: ' + C.SERVICE_TAGS.join(', ') }), F('levels_of_care', 'Levels of care', ['asam levels'], str(200)), F('populations', 'Populations served', ['serves', 'population'], str(500)), F('intake_process', 'Intake process', ['how to refer', 'admission process'], str(2000)), F('cost_notes', 'Cost / payment', ['cost', 'payment', 'fees'], str(1000)), F('notes', 'Notes', [], str(2000)),
  ] },
  interventions: { label: 'Visits & services', table: 'interventions', fields: [
    clientRef, F('occurred_at', 'Date', ['date of service', 'service date', 'when', 'occurred'], datetimeOf, { required: true }), F('type', 'Type', ['service', 'intervention', 'service type', 'intervention type'], enumOf(C.INTERVENTION_TYPES), { required: true, help: C.INTERVENTION_TYPES.join(', ') }),
    F('duration_minutes', 'Minutes', ['duration', 'duration minutes', 'time'], num), F('location', 'Location', ['where', 'setting'], enumOf(C.LOCATIONS)), F('modality', 'Modality', ['mode'], enumOf(C.MODALITIES)), F('outcome', 'Outcome', ['result'], enumOf(C.OUTCOMES)),
    F('naloxone_kits', 'Naloxone kits', ['naloxone', 'narcan kits'], num), F('fentanyl_strips', 'Fentanyl test strips', ['fts', 'test strips'], num), F('summary', 'Summary', ['notes', 'comment', 'description'], str(2000)),
  ] },
  calls: { label: 'Calls', table: 'calls', fields: [
    F('client_ref', 'Client', ['client code', 'client', 'code', 'client name', 'name'], str(120), { help: 'Optional for non-client calls' }), F('started_at', 'Date', ['when', 'date/time', 'call date', 'time'], datetimeOf, { required: true }), F('direction', 'Direction', ['in/out', 'inbound/outbound'], enumOf(['inbound', 'outbound']), { required: true }),
    F('contact_type', 'Who', ['contact type', 'with', 'caller'], enumOf(C.CALL_CONTACT_TYPES)), F('contact_name', 'Contact name', ['contact'], str(120)), F('phone', 'Phone', ['number'], str(40)), F('duration_minutes', 'Minutes', ['duration', 'length'], num), F('outcome', 'Outcome', ['result'], enumOf(C.CALL_OUTCOMES)),
    F('purpose', 'Purpose', ['reason', 'subject'], str(300)), F('summary', 'Summary', ['notes', 'comment'], str(4000)), F('crisis', 'Crisis', ['crisis call'], yes),
  ] },
  time_entries: { label: 'Time', table: 'time_entries', fields: [
    F('work_date', 'Date', ['work date', 'day'], dateOf, { required: true }), F('minutes', 'Minutes', ['duration', 'time', 'mins'], num, { required: true }), F('category', 'Category', ['activity', 'type'], enumOf(C.TIME_CATEGORIES)), F('client_ref', 'Client', ['client code', 'client', 'code', 'client name'], str(120)),
    F('billable', 'Billable', [], yes), F('description', 'Description', ['notes', 'comment'], str(500)),
  ] },
  tasks: { label: 'To-dos', table: 'tasks', fields: [
    F('title', 'Title', ['task', 'to-do', 'todo', 'reminder', 'subject'], str(200), { required: true }), F('client_ref', 'Client', ['client code', 'client', 'code', 'client name'], str(120)), F('due_at', 'Due', ['due date', 'due', 'deadline', 'when'], datetimeOf), F('priority', 'Priority', [], enumOf(['low', 'normal', 'high', 'urgent'])), F('description', 'Details', ['description', 'notes'], str(2000)),
  ] },
  expenditures: { label: 'Expenditures', table: 'expenditures', perm: 'budget:write', fields: [
    F('spent_at', 'Date', ['spent', 'purchase date', 'when'], dateOf, { required: true }), F('amount', 'Amount', ['cost', 'total', '$'], num, { required: true }), F('fund', 'Funding source', ['fund', 'grant', 'funding'], str(200), { required: true, help: 'Name of an existing funding source' }),
    F('category', 'Category', ['type', 'budget line', 'line'], enumOf(C.BUDGET_CATEGORIES), { required: true, help: C.BUDGET_CATEGORIES.join(', ') }), F('client_ref', 'Client', ['client code', 'client', 'code', 'client name'], str(120)), F('vendor', 'Vendor', ['payee', 'merchant', 'store'], str(200)), F('description', 'Description', ['notes', 'memo', 'purpose'], str(1000)), F('receipt_ref', 'Receipt #', ['receipt', 'invoice', 'invoice #'], str(200)),
  ] },
};

// Map spreadsheet headers to fields by label/alias (case-insensitive, punctuation-insensitive)
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function suggestMapping(entity, headers) {
  const def = ENTITIES[entity]; const used = new Set(); const mapping = {};
  for (const h of headers) {
    const n = norm(h); if (!n) continue;
    const f = def.fields.find(f => !used.has(f.key) && (f.aliases.map(norm).includes(n) || norm(f.key) === n)) || def.fields.find(f => !used.has(f.key) && f.aliases.some(a => n.includes(norm(a)) || norm(a).includes(n)) && n.length > 2);
    if (f) { mapping[h] = f.key; used.add(f.key); }
  }
  return mapping;
}

// Resolve a client reference (code, "Last, First", "First Last") to an id; returns null if not found, 'ambiguous' if several
function resolveClient(ref, ctx, auth) {
  const s = String(ref || '').trim(); if (!s) return null;
  let rows;
  if (/^[CM]\d{2}-\d+(-D)?$/i.test(s)) rows = db.all(`SELECT id FROM clients WHERE client_code=? AND deleted_at IS NULL`, s.toUpperCase());
  else { const parts = s.split(/[,\s]+/).filter(Boolean); if (parts.length < 2) rows = db.all(`SELECT id FROM clients WHERE last_name_idx=? AND deleted_at IS NULL`, blindIndex(parts[0])); else rows = db.all(`SELECT id FROM clients WHERE full_name_idx IN (?,?) AND deleted_at IS NULL`, blindIndex(parts.join('')), blindIndex([...parts].reverse().join(''))); }
  rows = rows.filter(r => auth.canAccessClient(ctx.user, r.id));
  if (rows.length === 1) return rows[0].id; if (rows.length > 1) return 'ambiguous'; return null;
}

// Validate and convert one spreadsheet row into a record; returns { record, errors: [] }
function convertRow(entity, mapping, row) {
  const def = ENTITIES[entity]; const record = {}; const errors = [];
  for (const [header, key] of Object.entries(mapping)) {
    const f = def.fields.find(x => x.key === key); if (!f) continue;
    const raw = row[header]; const v = f.parse(raw);
    if (v === undefined) errors.push(`${f.label}: "${raw}" is not a valid ${f.key.includes('date') || f.key.endsWith('_at') ? 'date' : 'value'}${f.help ? ' (' + f.help.slice(0, 80) + ')' : ''}`);
    else record[key] = v;
  }
  for (const f of def.fields) if (f.required && (record[f.key] === null || record[f.key] === undefined || record[f.key] === '')) errors.push(`${f.label} is required`);
  return { record, errors };
}

module.exports = { ENTITIES, suggestMapping, convertRow, resolveClient };
