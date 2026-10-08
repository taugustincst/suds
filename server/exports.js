'use strict';
// Table exports shared by CSV/Excel endpoints. De-identified (HIPAA Safe Harbor) unless `identified` is allowed.
const { randomBytes } = require('node:crypto');
const db = require('./db');
const auth = require('./auth');
const C = require('./constants');
const M = require('./clients-model');
const { decrypt } = require('./crypto');

// Exports are read into memory and serialised in one pass, so they are capped. A county that genuinely
// needs more than this should narrow the date range; silently truncating is worse than saying so.
const MAX_ROWS = 50000;

// ---- HIPAA Safe Harbor (45 CFR §164.514(b)(2)) ----
// A de-identified export may carry none of the eighteen identifiers of the client or of their relatives,
// employers or household members. What a service record naturally holds, and what is done with it here:
//   (B) geography: a ZIP code is cut to its first three digits, and to 000 where that three-digit area
//       holds 20,000 people or fewer (RESTRICTED_ZIP3). City is never written.
//   (C) dates: every element of a date except the year is removed ("2026", never "2026-07"), and an age
//       over 89 goes out only as "90+". Date of birth is never exported, only an age band. Durations
//       worked out from two dates (days to engagement, minutes of service) are kept: a duration is not
//       an element of a date, and with both ends cut to the year it does not reveal one. The only
//       duration Safe Harbor restricts is an age over 89, which the band already folds into 90+.
//   (R) any other unique identifying number or code: the programme's client code and the row id are
//       never written. Each row carries a record id instead, drawn at random for each export and never
//       stored. It links one client's rows within a file, is not derived from anything about the person
//       (§164.514(c)), and neither the recipient nor the programme can trace it back to the client.
//   Free text (notes, names, places, a referral source or discharge reason typed in by hand) is never
//   written. DEID_COLUMNS gives the reasoning column by column, and DEID_CODED lists the coded columns,
//   which may only carry a value from their list ("other" otherwise).
const DEID_LABEL = 'De-identified (HIPAA Safe Harbor): dates reduced to the year, ages over 89 reported as 90+, ZIP codes cut to the first three digits (000 for sparsely populated areas), city omitted, free text left out, coded fields limited to their lists, and client codes replaced by a random record id drawn for each export.';
// The three-digit ZIP areas with 20,000 or fewer residents in the 2000 Census. HHS's de-identification
// guidance on §164.514(b)(2)(i)(B) says these are reported as 000. This is the standard list; HHS has not
// published a newer one.
const RESTRICTED_ZIP3 = new Set(['036', '059', '063', '102', '203', '556', '692', '790', '821', '823', '830', '831', '878', '879', '884', '890', '893']);
const AGE_BANDS = [[0, 17, '0-17'], [18, 24, '18-24'], [25, 34, '25-34'], [35, 44, '35-44'], [45, 54, '45-54'], [55, 64, '55-64'], [65, 89, '65-89']];
function ageBand(dob, now = new Date()) {
  if (!dob) return '';
  const born = new Date(dob); if (!Number.isFinite(born.getTime())) return '';
  // Age on the programme's date of `now` (server/local-date.js), not the UTC one: a birthday starts at local midnight.
  const [y, m, d] = (require('./local-date').localDate(now) || now.toISOString().slice(0, 10)).split('-').map(Number);
  let age = y - born.getUTCFullYear();
  if (m - 1 < born.getUTCMonth() || (m - 1 === born.getUTCMonth() && d < born.getUTCDate())) age--;
  if (age >= 90) return '90+';
  const band = AGE_BANDS.find(([lo, hi]) => age >= lo && age <= hi);
  return band ? band[2] : '';
}
// Anything shaped like a date or a timestamp keeps only its year, whatever its column is called.
const DATE_LIKE = /^\d{4}-\d{2}(-\d{2})?([T ].*)?$/;
const toYear = (v) => (typeof v === 'string' && DATE_LIKE.test(v) ? v.slice(0, 4) : v);
function zip3(v) {
  if (v === null || v === undefined || v === '') return '';
  const z = String(v).replace(/\D/g, '').slice(0, 3);
  if (z.length < 3) return '';
  return RESTRICTED_ZIP3.has(z) ? '000' : z;
}
/** Apply Safe Harbor's date and geography rules to one row of a client-linked dataset. */
function deidentifyRow(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'city') continue;
    if (k === 'zip') { o[k] = zip3(v); continue; }
    o[k] = toYear(v);
  }
  return o;
}
/**
 * A new pseudonymiser for each export. A client keeps the same record id throughout the file (on every
 * sheet of a workbook) and gets a different one in the next file. The ids are random and held in memory
 * only for the one request.
 */
function pseudonymizer(prefix = 'R') {
  const ids = new Map(); const used = new Set();
  return (clientId) => {
    if (!clientId) return '';
    if (!ids.has(clientId)) { let p; do p = `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`; while (used.has(p)); used.add(p); ids.set(clientId, p); }
    return ids.get(clientId);
  };
}

// ---- Coded columns ----
// A coded column goes out only as one of its codes. Anything else in it (a value typed in before the
// field became a list, or sent by an older client that did not check) goes out as "other", so free text
// cannot reach a de-identified file through a column meant to be coded. The codes come from one of three
// places: a documentation list (Settings → Lists, including every code it has ever had), an enum the
// server validates, or, for fields the server stores as short strings, the choices the client form
// offers (public/views/clients.js).
const FORM_CHOICES = {
  gender: ['female', 'male', 'non_binary', 'transgender_female', 'transgender_male', 'other', 'declined'],
  referral_source: ['self', 'family', 'emergency_dept', 'hospital', 'ems', 'law_enforcement', 'jail', 'court_probation', 'treatment_provider', 'primary_care', 'shelter', 'outreach', 'hotline', 'school', 'other'],
  housing_status: ['stable', 'doubled_up', 'shelter', 'unsheltered', 'transitional', 'sober_living', 'incarcerated', 'treatment_facility', 'unknown'],
  insurance: ['medicaid', 'medicare', 'private', 'uninsured', 'va', 'pending', 'unknown'],
  mat_medication: ['buprenorphine', 'buprenorphine_xr', 'methadone', 'naltrexone_xr', 'naltrexone_oral', 'other'],
};
const DEID_CODED = {
  clients: { ...FORM_CHOICES, status: ['waitlist', 'active', 'inactive', 'closed', 'deceased'], primary_substance: 'SUBSTANCES', secondary_substances: { each: 'SUBSTANCES' },
    discharge_reason: 'DISCHARGE_REASONS', asam_level: C.ASAM, mat_status: ['none', 'interested', 'referred', 'active', 'discontinued', 'unknown'], risk_level: ['low', 'moderate', 'high', 'critical'] },
  interventions: { type: 'INTERVENTION_TYPES', modality: 'MODALITIES', outcome: 'OUTCOMES', stage_of_change: C.STAGES },
  calls: { direction: ['inbound', 'outbound'], contact_type: 'CALL_CONTACT_TYPES', outcome: (r) => (r.method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES') },
  time: { category: 'TIME_CATEGORIES' },
  referrals: { category: C.RESOURCE_CATEGORIES, status: 'REFERRAL_STATUSES', urgency: ['routine', 'urgent', 'emergent'] },
  tasks: { priority: ['low', 'normal', 'high', 'urgent'], status: ['open', 'in_progress', 'done', 'cancelled'] },
  forms: { status: ['draft', 'completed', 'void'] },
  consents: { type: C.CONSENT_TYPES },
  disclosures: { basis: () => require('./disclosure').BASES },
  episodes: { status: ['open', 'closed'], referral_source: FORM_CHOICES.referral_source, discharge_reason: 'DISCHARGE_REASONS' },
  overdose_events: { kind: 'OVERDOSE_KINDS', administered_by: 'ADMINISTERED_BY' },
  expenditures: { category: C.BUDGET_CATEGORIES, status: ['pending', 'approved', 'rejected', 'reimbursed'] },
};
/** Hold every coded column of a de-identified dataset to its codes (DEID_CODED); anything else is "other". */
function codeRows(kind, rows) {
  const cols = DEID_CODED[kind]; if (!cols) return rows;
  const O = require('./options'); const known = {};
  const codesFor = (spec, r) => {
    if (typeof spec === 'function') spec = spec(r);
    if (Array.isArray(spec)) return spec;
    return (known[spec] = known[spec] || O.known(spec));
  };
  const one = (v, codes) => (codes.includes(v) ? v : 'other');
  return rows.map(r => {
    const o = { ...r };
    for (const [col, spec] of Object.entries(cols)) {
      const v = o[col];
      if (v === null || v === undefined || v === '') continue;
      if (spec && spec.each) { const codes = codesFor(spec.each, r); o[col] = [...new Set(String(v).split(/[,;]/).map(s => s.trim()).filter(Boolean).map(s => one(s, codes)))].join(', '); continue; }
      o[col] = one(String(v), codesFor(spec, r));
    }
    return o;
  });
}

// ---- De-identified column allow-list ----
// A de-identified export carries only the columns listed here for its dataset; nothing else reaches the
// file. Each column was checked against Safe Harbor's identifiers and for free text:
//   record_id       random for each export (see pseudonymizer), never the client code or row id.
//   participant_ref an anonymous contact's SSP participant code, replaced likewise by a reference random for each
//                   export (P-…): contacts with the same code share it within the file. The code itself is
//                   never exported, identified or not.
//   dates           *_at, *_date, *_due: reduced to the year.
//   zip             ZIP3, or 000 for a restricted area.
//   age_band        bands, with everyone over 89 in 90+.
//   coded columns   only a code from DEID_CODED, otherwise "other": statuses, types, outcomes, reasons,
//                   substances, gender, housing, insurance, referral source, ASAM level, MAT status and
//                   medication, and the rest.
//   numbers, yes/no durations, counts, minutes, amounts, flags. None of these is an identifier.
//   source          (disclosures) set by SUDS itself (manual, referral, export, caloms, fhir…), never typed.
//   programme names worker, assignee, completed_by, created_by, disclosed_by, approver, funding_source,
//                   fund, line, resource, template_name: the programme's own staff, funds, budget lines,
//                   provider directory and form templates. None identifies the client, a relative, an
//                   employer or a household member.
// Left out because they are free text or identify someone: names, contact names, addresses, city, phone,
// email, notes, summaries, purposes, recipients, document and receipt references, vendors, visit location,
// preferred language, a consent's expiry event, a disclosure's method, an episode's discharge disposition,
// an overdose's location and substances, and goals and flags. Most of these are typed in by hand.
// Datasets with no client link (resource directory, funding sources, budget lines) hold no PHI and are
// exported as they are.
const DEID_COLUMNS = {
  clients: ['record_id', 'age_band', 'status', 'intake_date', 'discharge_date', 'discharge_reason', 'referral_source', 'referral_date', 'engagement_date', 'days_to_engagement', 'primary_substance', 'secondary_substances', 'asam_level', 'mat_status', 'mat_medication', 'risk_level', 'housing_status', 'insurance', 'overdose_history', 'naloxone_provided', 'naloxone_last_date', 'co_occurring_mh', 'justice_involved', 'pregnant_or_parenting', 'zip', 'gender'],
  interventions: ['occurred_at', 'record_id', 'participant_ref', 'type', 'duration_minutes', 'modality', 'outcome', 'stage_of_change', 'naloxone_kits', 'fentanyl_strips', 'worker', 'funding_source', 'cost', 'follow_up_due'],
  calls: ['started_at', 'record_id', 'direction', 'contact_type', 'duration_minutes', 'outcome', 'crisis', 'follow_up_needed', 'follow_up_due', 'worker'],
  time: ['work_date', 'worker', 'record_id', 'category', 'minutes', 'billable', 'funding_source'],
  referrals: ['referred_at', 'record_id', 'resource', 'category', 'status', 'urgency', 'warm_handoff', 'appointment_at', 'admitted_at', 'closed_at', 'worker'],
  tasks: ['record_id', 'assignee', 'due_at', 'priority', 'status', 'is_milestone', 'completed_at'],
  forms: ['created_at', 'record_id', 'template_name', 'status', 'completed_at', 'completed_by', 'created_by', 'attachments'],
  consents: ['record_id', 'type', 'signed_at', 'expires_at', 'revoked_at', 'redisclosure_notice_given'],
  disclosures: ['record_id', 'disclosed_at', 'basis', 'source', 'disclosed_by'],
  episodes: ['record_id', 'opened_at', 'closed_at', 'status', 'referral_source', 'discharge_reason', 'funding_source'],
  overdose_events: ['occurred_at', 'record_id', 'kind', 'naloxone_used', 'naloxone_doses', 'administered_by', 'ems_called', 'hospitalized', 'survived'],
  expenditures: ['spent_at', 'fund', 'line', 'category', 'amount', 'status', 'record_id', 'worker', 'approver'],
};
// ---- The programme's own books: spending and staff time ----
// An expenditure or a time entry with no client is the programme's bookkeeping, not health information about
// anyone: its exact date, and for spending the vendor and receipt number, are what finance reconciles a month
// and an invoice by. Up to 1.25.1 every row was cut to the year with vendor and receipt left out, so finance had
// no usable ledger (1.25.2, BO6). A row linked to a client is about that client (the date they were given a
// ride or a motel night) and keeps Safe Harbor exactly as before: year only, vendor and receipt left out (they
// are typed by hand and can name the client), a random record id. The description, free text, is never written
// to a de-identified file; finance reads it in Funding & spending.
const LEDGER = { expenditures: ['vendor', 'receipt_ref'], time: [] };
const LEDGER_LABEL = 'Spending and staff time with no client are the programme\'s own books, not health information: they keep their exact dates, vendor and receipt number. Every row linked to a client is de-identified (HIPAA Safe Harbor): its date reduced to the year, vendor and receipt number left out, and the client code replaced by a random record id drawn for each export. Descriptions are never written.';
// ---- Documentation choices, in words ----
// A coded column that comes from a documentation list goes out with the label the programme gave it under
// Settings → Lists ("Warm handoff", or whatever it was renamed to), and a programme's own choice — which
// has no built-in wording at all — with its own. Applied to the full row, before de-identification cuts it
// down, because which outcomes list a call's outcome belongs to depends on its method.
const LIST_COLUMNS = {
  interventions: { type: 'INTERVENTION_TYPES', location: 'LOCATIONS', modality: 'MODALITIES', outcome: 'OUTCOMES' },
  calls: { contact_type: 'CALL_CONTACT_TYPES', outcome: (r) => (r.method === 'text' ? 'TEXT_OUTCOMES' : 'CALL_OUTCOMES') },
  time: { category: 'TIME_CATEGORIES' },
  referrals: { status: 'REFERRAL_STATUSES', barrier: 'REFERRAL_BARRIERS' },
  episodes: { discharge_reason: 'DISCHARGE_REASONS' },
  overdose_events: { kind: 'OVERDOSE_KINDS', administered_by: 'ADMINISTERED_BY' },
  clients: { primary_substance: 'SUBSTANCES', discharge_reason: 'DISCHARGE_REASONS' },
};
function labelRows(kind, rows) {
  const cols = LIST_COLUMNS[kind]; if (!cols) return rows;
  const O = require('./options'); const maps = {};
  const mapFor = (key) => (maps[key] = maps[key] || O.labelMap(key));
  return rows.map(r => {
    const o = { ...r };
    for (const [col, list] of Object.entries(cols)) {
      const v = o[col]; if (typeof v !== 'string' || !v) continue;
      const key = typeof list === 'function' ? list(r) : list;
      o[col] = mapFor(key)[v] || (/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(v) ? O.humanize(v) : v);
    }
    return o;
  });
}

/** Keep only the allow-listed columns (plus the hidden _client_id used for accounting). */
function projectRow(r, cols) { const o = {}; for (const c of cols) if (c in r) o[c] = r[c]; if (r._client_id !== undefined) o._client_id = r._client_id; return o; }
/** Money is stored as REAL; round to cents so 25.009999 never reaches a spreadsheet. */
const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

function datasets(ctx, { from, to, ts, tsP, identified }) {
  const cf = auth.caseloadFilter(ctx.user, 'c.id'); const all = auth.hasPerm(ctx.user, 'time:all') ? 1 : 0;
  // A row with no client is its owner's (or a holder of the table's `all` permission's): the rule REST and
  // sync apply, from its one definition (sync-tables.js clientOrNullScope). Security review of 1.13.0, 4.
  const scoped = (table, alias) => require('./sync-tables').clientOrNullScope(table, ctx.user, alias, cf, auth.hasPerm);
  const sc = { interventions: scoped('interventions', 'i'), calls: scoped('calls', 'ca'), tasks: scoped('tasks', 't'), overdose_events: scoped('overdose_events', 'o') };
  // Free-text PHI is only ever decrypted for an identified export; otherwise it is marked redacted so the
  // reader knows something was there rather than assuming the field was empty.
  const phi = (v) => identified && v ? decrypt(v) : (v ? '[redacted]' : '');
  // An anonymous contact's participant code goes out as a reference random for this file, identified or not:
  // the code is built from personal details, and a count of unique participants needs only the reference.
  const participantRef = pseudonymizer('P');
  // participant_code (1.21.0): a client's syringe services participant code, identifying like a name (an identified
  // export only; a de-identified one never carries it).
  const idCols = identified ? ['last_name', 'first_name', 'participant_code', 'dob', 'phone', 'email', 'address'] : ['age_band'];
  const strip = (cols) => (identified ? cols : cols.filter(c => c !== 'city'));
  const D = {
    clients: { label: 'Clients', columns: strip(['client_code', ...idCols, 'status', 'intake_date', 'discharge_date', 'discharge_reason', 'referral_source', 'referral_date', 'engagement_date', 'days_to_engagement', 'primary_substance', 'secondary_substances', 'asam_level', 'mat_status', 'mat_medication', 'risk_level', 'housing_status', 'insurance', 'overdose_history', 'naloxone_provided', 'naloxone_last_date', 'co_occurring_mh', 'justice_involved', 'pregnant_or_parenting', 'city', 'zip', 'gender', 'preferred_language', 'goals', 'flags']),
      rows: () => db.all(`SELECT c.* FROM clients c WHERE c.deleted_at IS NULL AND ${cf.sql} ORDER BY c.client_code LIMIT ?`, ...cf.params, MAX_ROWS)
        .map(x => ({ ...M.decryptRow(x, { deidentify: !identified }), _client_id: x.id, age_band: identified ? undefined : ageBand(x.dob_enc ? decrypt(x.dob_enc) : null) }))
        .map(x => ({ ...x, days_to_engagement: M.daysToEngagement(x), goals: identified ? x.goals : (x.goals_enc ? '[redacted]' : ''), flags: identified ? x.flags : (x.flags_enc ? '[redacted]' : '') })) },
    interventions: { label: 'Visits & services', columns: ['occurred_at', 'client_code', 'participant_ref', 'type', 'duration_minutes', 'location', 'modality', 'outcome', 'stage_of_change', 'naloxone_kits', 'fentanyl_strips', 'worker', 'funding_source', 'cost', 'summary', 'follow_up_due'],
      rows: () => db.all(`SELECT i.*, c.client_code, i.client_id AS _client_id, u.display_name worker, f.name funding_source FROM interventions i LEFT JOIN clients c ON c.id=i.client_id JOIN users u ON u.id=i.user_id LEFT JOIN funding_sources f ON f.id=i.funding_source_id WHERE ${ts('i.occurred_at')} AND ${sc.interventions.sql} ORDER BY i.occurred_at LIMIT ?`, ...tsP, ...sc.interventions.params, MAX_ROWS).map(r => ({ ...r, summary: phi(r.summary_enc), participant_ref: participantRef(r.participant_code_idx) })) },
    calls: { label: 'Calls', columns: ['started_at', 'client_code', 'direction', 'contact_type', 'contact_name', 'duration_minutes', 'outcome', 'crisis', 'purpose', 'summary', 'follow_up_needed', 'follow_up_due', 'worker'],
      rows: () => db.all(`SELECT ca.*, c.client_code, ca.client_id AS _client_id, u.display_name worker FROM calls ca LEFT JOIN clients c ON c.id=ca.client_id JOIN users u ON u.id=ca.user_id WHERE ${ts('ca.started_at')} AND ${sc.calls.sql} ORDER BY ca.started_at LIMIT ?`, ...tsP, ...sc.calls.params, MAX_ROWS).map(r => ({ ...r, contact_name: phi(r.contact_name_enc), summary: phi(r.summary_enc), purpose: phi(r.purpose_enc) })) },
    time: { label: 'Time', columns: ['work_date', 'worker', 'client_code', 'category', 'minutes', 'billable', 'funding_source', 'description'],
      rows: () => db.all(`SELECT t.*, u.display_name worker, c.client_code, t.client_id AS _client_id, f.name funding_source FROM time_entries t JOIN users u ON u.id=t.user_id LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN funding_sources f ON f.id=t.funding_source_id WHERE t.work_date BETWEEN ? AND ? AND (t.user_id=? OR ?) ORDER BY t.work_date LIMIT ?`, from, to, ctx.user.id, all, MAX_ROWS)
        // Category, fund and hours only for someone else's time read by a role without clients:read (routes/time.js).
        .map(r => ({ ...r, description: require('./routes/time').mayReadDescription(ctx.user, r) ? phi(r.description_enc) : '' })) },
    referrals: { label: 'Referrals', columns: ['referred_at', 'client_code', 'resource', 'category', 'status', 'urgency', 'warm_handoff', 'appointment_at', 'admitted_at', 'closed_at', 'outcome', 'barrier', 'worker', 'notes'],
      rows: () => db.all(`SELECT r.*, c.client_code, r.client_id AS _client_id, res.name resource, res.category, u.display_name worker FROM referrals r JOIN clients c ON c.id=r.client_id JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE ${ts('r.referred_at')} AND ${cf.sql} ORDER BY r.referred_at LIMIT ?`, ...tsP, ...cf.params, MAX_ROWS).map(r => ({ ...r, outcome: phi(r.outcome_enc), barrier: phi(r.barrier_enc), notes: phi(r.notes_enc) })) },
    tasks: { label: 'To-dos', columns: ['title', 'client_code', 'assignee', 'due_at', 'priority', 'status', 'is_milestone', 'completed_at', 'description'],
      rows: () => db.all(`SELECT t.*, c.client_code, t.client_id AS _client_id, u.display_name assignee FROM tasks t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN users u ON u.id=t.assigned_to WHERE ${ts('t.created_at')} AND ${sc.tasks.sql} ORDER BY t.due_at LIMIT ?`, ...tsP, ...sc.tasks.params, MAX_ROWS).map(r => ({ ...r, title: phi(r.title_enc), description: phi(r.description_enc) })) },
    forms: { label: 'Client forms', columns: ['created_at', 'client_code', 'template_name', 'status', 'completed_at', 'completed_by', 'created_by', 'attachments'],
      rows: () => db.all(`SELECT f.created_at, c.client_code, f.client_id AS _client_id, f.template_name, f.status, f.completed_at, cu.display_name completed_by, cr.display_name created_by, (SELECT COUNT(*) FROM client_form_files x WHERE x.client_form_id=f.id) attachments FROM client_forms f JOIN clients c ON c.id=f.client_id LEFT JOIN users cu ON cu.id=f.completed_by JOIN users cr ON cr.id=f.created_by WHERE f.deleted_at IS NULL AND ${ts('f.created_at')} AND ${cf.sql} ORDER BY f.created_at DESC LIMIT ?`, ...tsP, ...cf.params, MAX_ROWS) },
    resources: { label: 'Resource directory', noClients: true, columns: ['name', 'category', 'organization', 'phone', 'fax', 'email', 'website', 'address', 'city', 'zip', 'hours', 'eligibility', 'services', 'languages', 'accepts_medicaid', 'accepts_uninsured', 'mat_offered', 'capacity_notes', 'contact_person', 'summary', 'service_tags', 'levels_of_care', 'populations', 'intake_process', 'cost_notes', 'is_active', 'last_verified_at', 'notes'],
      rows: () => db.all(`SELECT * FROM resources ORDER BY category, name LIMIT ?`, MAX_ROWS) },
    consents: { label: 'Consents', columns: ['client_code', 'type', 'recipient', 'purpose', 'scope', 'signed_at', 'expires_at', 'expires_event', 'revoked_at', 'document_ref', 'redisclosure_notice_given'],
      rows: () => db.all(`SELECT co.*, c.client_code, co.client_id AS _client_id FROM consents co JOIN clients c ON c.id=co.client_id WHERE co.signed_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY co.signed_at LIMIT ?`, from, to, ...cf.params, MAX_ROWS)
        .map(r => ({ ...r, recipient: phi(r.recipient_enc), purpose: phi(r.purpose_enc), scope: phi(r.scope_enc), document_ref: phi(r.document_ref_enc) })) },
    disclosures: { label: 'Accounting of disclosures', columns: ['client_code', 'disclosed_at', 'recipient', 'purpose', 'what', 'method', 'basis', 'justification', 'source', 'disclosed_by'],
      rows: () => db.all(`SELECT d.*, c.client_code, d.client_id AS _client_id, u.display_name disclosed_by FROM disclosures d JOIN clients c ON c.id=d.client_id JOIN users u ON u.id=d.disclosed_by WHERE ${ts('d.disclosed_at')} AND ${cf.sql} ORDER BY d.disclosed_at LIMIT ?`, ...tsP, ...cf.params, MAX_ROWS)
        .map(r => ({ ...r, recipient: phi(r.recipient_enc), purpose: phi(r.purpose_enc), what: phi(r.what_enc), justification: phi(r.justification_enc) })) },
    episodes: { label: 'Episodes of care', columns: ['client_code', 'opened_at', 'closed_at', 'status', 'referral_source', 'discharge_reason', 'discharge_disposition', 'funding_source'],
      rows: () => db.all(`SELECT e.*, c.client_code, e.client_id AS _client_id, f.name funding_source FROM episodes e JOIN clients c ON c.id=e.client_id LEFT JOIN funding_sources f ON f.id=e.funding_source_id WHERE e.opened_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY e.opened_at LIMIT ?`, from, to, ...cf.params, MAX_ROWS) },
    overdose_events: { label: 'Overdose & reversal events', columns: strip(['occurred_at', 'client_code', 'kind', 'substances', 'naloxone_used', 'naloxone_doses', 'administered_by', 'ems_called', 'hospitalized', 'survived', 'location_type', 'city']),
      rows: () => db.all(`SELECT o.*, c.client_code, o.client_id AS _client_id FROM overdose_events o LEFT JOIN clients c ON c.id=o.client_id WHERE ${ts('o.occurred_at')} AND ${sc.overdose_events.sql} ORDER BY o.occurred_at LIMIT ?`, ...tsP, ...sc.overdose_events.params, MAX_ROWS).map(r => ({ ...r, substances: phi(r.substances_enc) })) },
  };
  if (auth.hasPerm(ctx.user, 'budget:read')) {
    D.funds = { label: 'Funding sources', noClients: true, columns: ['name', 'source_type', 'grant_number', 'fiscal_year_start', 'fiscal_year_end', 'total_amount', 'restrictions', 'is_active'], rows: () => db.all(`SELECT * FROM funding_sources ORDER BY fiscal_year_start DESC`) };
    D.budget_lines = { label: 'Budget lines', noClients: true, columns: ['fund', 'category', 'label', 'allocated_amount', 'notes'], rows: () => db.all(`SELECT b.*, f.name fund FROM budget_lines b JOIN funding_sources f ON f.id=b.funding_source_id ORDER BY f.name, b.category`) };
    D.expenditures = { label: 'Expenditures', columns: ['spent_at', 'fund', 'line', 'category', 'amount', 'status', 'client_code', 'vendor', 'description', 'receipt_ref', 'worker', 'approver'],
      rows: () => db.all(`SELECT e.*, f.name fund, b.label line, c.client_code, e.client_id AS _client_id, u.display_name worker, a.display_name approver FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id LEFT JOIN budget_lines b ON b.id=e.budget_line_id LEFT JOIN clients c ON c.id=e.client_id JOIN users u ON u.id=e.user_id LEFT JOIN users a ON a.id=e.approved_by WHERE e.spent_at BETWEEN ? AND ? ORDER BY e.spent_at`, from, to).map(r => ({ ...r, amount: cents(r.amount), description: phi(r.description_enc) })) };
  }
  // Safe Harbor is applied to every client-linked dataset, uniformly, on the way out — not per column in
  // each query, where one new date column would quietly slip through. A de-identified dataset is also cut
  // down to its allow-listed columns (DEID_COLUMNS), both in the column list and in the row objects, its
  // coded columns are held to their codes (DEID_CODED), and its client code becomes a record id that is
  // random for this export and shared by every dataset in it, so a workbook's sheets still link up.
  const pseudo = pseudonymizer();
  for (const [kind, d] of Object.entries(D)) {
    const read = d.rows;
    if (identified || d.noClients) { d.rows = () => labelRows(kind, read()); continue; }
    const allowed = DEID_COLUMNS[kind];
    if (!allowed) throw new Error(`No de-identified column list is defined for the ${kind} dataset`);
    if (LEDGER[kind]) {
      const books = [...allowed, ...LEDGER[kind]];
      d.columns = d.columns.map(c => (c === 'client_code' ? 'record_id' : c)).filter(c => books.includes(c));
      d.rows = () => labelRows(kind, codeRows(kind, read()))
        .map(r => (r._client_id ? projectRow({ ...deidentifyRow(r), record_id: pseudo(r._client_id) }, allowed) : projectRow({ ...r, record_id: '' }, books)));
      continue;
    }
    d.columns = d.columns.map(c => (c === 'client_code' ? 'record_id' : c)).filter(c => allowed.includes(c));
    d.rows = () => labelRows(kind, codeRows(kind, read()))
      .map(r => projectRow({ ...deidentifyRow(r), record_id: pseudo(r._client_id) }, allowed));
  }
  return D;
}
/** Distinct client ids a set of exported rows covers (the hidden _client_id column), for the accounting. */
function clientIdsOf(rows) { return [...new Set(rows.map(r => r._client_id).filter(Boolean))]; }
/** Drop the internal columns before anything is written to a file. */
function publicRows(rows) { return rows.map(r => { const o = { ...r }; delete o._client_id; return o; }); }

module.exports = { LEDGER, LEDGER_LABEL, LIST_COLUMNS, labelRows, datasets, ageBand, deidentifyRow, pseudonymizer, zip3, toYear, codeRows, clientIdsOf, publicRows, DEID_LABEL, DEID_COLUMNS, DEID_CODED, RESTRICTED_ZIP3, cents };
