'use strict';
// Table exports shared by CSV/Excel endpoints. De-identified (client codes) unless `identified` is allowed.
const db = require('./db');
const auth = require('./auth');
const M = require('./clients-model');
const { decrypt } = require('./crypto');

// Exports are read into memory and serialised in one pass, so they are capped. A county that genuinely
// needs more than this should narrow the date range; silently truncating is worse than saying so.
const MAX_ROWS = 50000;

// ---- HIPAA Safe Harbor (§164.514(b)(2)) ----
// A de-identified export may carry none of the eighteen identifiers. Client codes are not one, but the rest
// of what a service record naturally holds is: every date but the year, ZIP codes beyond the first three
// digits, town names, and an age once it passes 89. So a de-identified dataset has every date reduced to
// its month, every ZIP cut to three digits, its city column dropped, and its date of birth replaced by an
// age band. Free text was already redacted.
const DEID_LABEL = 'De-identified (HIPAA Safe Harbor): dates reduced to year-month, ZIP codes to the first three digits, city omitted, ages banded, free text redacted.';
const AGE_BANDS = [[0, 17, '0-17'], [18, 24, '18-24'], [25, 34, '25-34'], [35, 44, '35-44'], [45, 54, '45-54'], [55, 64, '55-64'], [65, 89, '65-89']];
function ageBand(dob, now = new Date()) {
  if (!dob) return '';
  const born = new Date(dob); if (!Number.isFinite(born.getTime())) return '';
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age--;
  if (age >= 90) return '90+';
  const band = AGE_BANDS.find(([lo, hi]) => age >= lo && age <= hi);
  return band ? band[2] : '';
}
const isDateCol = (k) => /(_at|_date|_due|_on)$/.test(k) || k === 'date';
const toMonth = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 7) : v);
const zip3 = (v) => (v ? String(v).replace(/\D/g, '').slice(0, 3) : v);
/** Apply Safe Harbor to one row of a client-linked dataset. */
function deidentifyRow(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'city') continue;
    if (k === 'zip') { o[k] = zip3(v); continue; }
    o[k] = isDateCol(k) ? toMonth(v) : v;
  }
  return o;
}

// ---- De-identified column allow-list ----
// Safe Harbor used to be applied by column *name* (dates, zip, city) with free text "redacted" in place —
// which left every column whose name did not match: a visit's location, a consent's document reference,
// an expenditure's vendor and receipt number, a call's contact name. A de-identified export now carries
// only the columns listed here for its dataset, and nothing else survives to the file. Free text, names,
// references and locations are not on the list. Datasets with no client link (resource directory,
// funding sources, budget lines) are not PHI and are unaffected.
const DEID_COLUMNS = {
  clients: ['client_code', 'age_band', 'status', 'intake_date', 'discharge_date', 'discharge_reason', 'referral_source', 'referral_date', 'engagement_date', 'days_to_engagement', 'primary_substance', 'secondary_substances', 'asam_level', 'mat_status', 'mat_medication', 'risk_level', 'housing_status', 'insurance', 'overdose_history', 'naloxone_provided', 'naloxone_last_date', 'co_occurring_mh', 'justice_involved', 'pregnant_or_parenting', 'zip', 'gender', 'preferred_language'],
  interventions: ['occurred_at', 'client_code', 'type', 'duration_minutes', 'modality', 'outcome', 'stage_of_change', 'naloxone_kits', 'fentanyl_strips', 'worker', 'funding_source', 'cost', 'follow_up_due'],
  calls: ['started_at', 'client_code', 'direction', 'contact_type', 'duration_minutes', 'outcome', 'crisis', 'follow_up_needed', 'follow_up_due', 'worker'],
  time: ['work_date', 'worker', 'client_code', 'category', 'minutes', 'billable', 'funding_source'],
  referrals: ['referred_at', 'client_code', 'resource', 'category', 'status', 'urgency', 'warm_handoff', 'appointment_at', 'admitted_at', 'closed_at', 'worker'],
  tasks: ['client_code', 'assignee', 'due_at', 'priority', 'status', 'is_milestone', 'completed_at'],
  forms: ['created_at', 'client_code', 'template_name', 'status', 'completed_at', 'completed_by', 'created_by', 'attachments'],
  consents: ['client_code', 'type', 'signed_at', 'expires_at', 'expires_event', 'revoked_at', 'redisclosure_notice_given'],
  disclosures: ['client_code', 'disclosed_at', 'method', 'basis', 'source', 'disclosed_by'],
  episodes: ['client_code', 'opened_at', 'closed_at', 'status', 'referral_source', 'discharge_reason', 'discharge_disposition', 'funding_source'],
  overdose_events: ['occurred_at', 'client_code', 'kind', 'naloxone_used', 'naloxone_doses', 'administered_by', 'ems_called', 'hospitalized', 'survived', 'location_type'],
  expenditures: ['spent_at', 'fund', 'line', 'category', 'amount', 'status', 'client_code', 'worker', 'approver'],
};
/** Keep only the allow-listed columns (plus the hidden _client_id used for accounting). */
function projectRow(r, cols) { const o = {}; for (const c of cols) if (c in r) o[c] = r[c]; if (r._client_id !== undefined) o._client_id = r._client_id; return o; }
/** Money is stored as REAL; round to cents so 25.009999 never reaches a spreadsheet. */
const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

function datasets(ctx, { from, to, toEnd, identified }) {
  const cf = auth.caseloadFilter(ctx.user, 'c.id'); const all = auth.hasPerm(ctx.user, 'time:all') ? 1 : 0;
  // Free-text PHI is only ever decrypted for an identified export; otherwise it is marked redacted so the
  // reader knows something was there rather than assuming the field was empty.
  const phi = (v) => identified && v ? decrypt(v) : (v ? '[redacted]' : '');
  const idCols = identified ? ['last_name', 'first_name', 'dob', 'phone', 'email', 'address'] : ['age_band'];
  const strip = (cols) => (identified ? cols : cols.filter(c => c !== 'city'));
  const D = {
    clients: { label: 'Clients', columns: strip(['client_code', ...idCols, 'status', 'intake_date', 'discharge_date', 'discharge_reason', 'referral_source', 'referral_date', 'engagement_date', 'days_to_engagement', 'primary_substance', 'secondary_substances', 'asam_level', 'mat_status', 'mat_medication', 'risk_level', 'housing_status', 'insurance', 'overdose_history', 'naloxone_provided', 'naloxone_last_date', 'co_occurring_mh', 'justice_involved', 'pregnant_or_parenting', 'city', 'zip', 'gender', 'preferred_language', 'goals', 'flags']),
      rows: () => db.all(`SELECT c.* FROM clients c WHERE c.deleted_at IS NULL AND ${cf.sql} ORDER BY c.client_code LIMIT ?`, ...cf.params, MAX_ROWS)
        .map(x => ({ ...M.decryptRow(x, { deidentify: !identified }), _client_id: x.id, age_band: identified ? undefined : ageBand(x.dob_enc ? decrypt(x.dob_enc) : null) }))
        .map(x => ({ ...x, days_to_engagement: M.daysToEngagement(x), goals: identified ? x.goals : (x.goals_enc ? '[redacted]' : ''), flags: identified ? x.flags : (x.flags_enc ? '[redacted]' : '') })) },
    interventions: { label: 'Visits & services', columns: ['occurred_at', 'client_code', 'type', 'duration_minutes', 'location', 'modality', 'outcome', 'stage_of_change', 'naloxone_kits', 'fentanyl_strips', 'worker', 'funding_source', 'cost', 'summary', 'follow_up_due'],
      rows: () => db.all(`SELECT i.*, c.client_code, i.client_id AS _client_id, u.display_name worker, f.name funding_source FROM interventions i LEFT JOIN clients c ON c.id=i.client_id JOIN users u ON u.id=i.user_id LEFT JOIN funding_sources f ON f.id=i.funding_source_id WHERE i.occurred_at BETWEEN ? AND ? AND (i.client_id IS NULL OR ${cf.sql}) ORDER BY i.occurred_at LIMIT ?`, from, toEnd, ...cf.params, MAX_ROWS).map(r => ({ ...r, summary: phi(r.summary_enc) })) },
    calls: { label: 'Calls', columns: ['started_at', 'client_code', 'direction', 'contact_type', 'contact_name', 'duration_minutes', 'outcome', 'crisis', 'purpose', 'summary', 'follow_up_needed', 'follow_up_due', 'worker'],
      rows: () => db.all(`SELECT ca.*, c.client_code, ca.client_id AS _client_id, u.display_name worker FROM calls ca LEFT JOIN clients c ON c.id=ca.client_id JOIN users u ON u.id=ca.user_id WHERE ca.started_at BETWEEN ? AND ? AND (ca.client_id IS NULL OR ${cf.sql}) ORDER BY ca.started_at LIMIT ?`, from, toEnd, ...cf.params, MAX_ROWS).map(r => ({ ...r, contact_name: phi(r.contact_name_enc), summary: phi(r.summary_enc), purpose: phi(r.purpose_enc) })) },
    time: { label: 'Time', columns: ['work_date', 'worker', 'client_code', 'category', 'minutes', 'billable', 'funding_source', 'description'],
      rows: () => db.all(`SELECT t.*, u.display_name worker, c.client_code, t.client_id AS _client_id, f.name funding_source FROM time_entries t JOIN users u ON u.id=t.user_id LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN funding_sources f ON f.id=t.funding_source_id WHERE t.work_date BETWEEN ? AND ? AND (t.user_id=? OR ?) ORDER BY t.work_date LIMIT ?`, from, to, ctx.user.id, all, MAX_ROWS) },
    referrals: { label: 'Referrals', columns: ['referred_at', 'client_code', 'resource', 'category', 'status', 'urgency', 'warm_handoff', 'appointment_at', 'admitted_at', 'closed_at', 'outcome', 'barrier', 'worker', 'notes'],
      rows: () => db.all(`SELECT r.*, c.client_code, r.client_id AS _client_id, res.name resource, res.category, u.display_name worker FROM referrals r JOIN clients c ON c.id=r.client_id JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY r.referred_at LIMIT ?`, from, toEnd, ...cf.params, MAX_ROWS).map(r => ({ ...r, outcome: phi(r.outcome_enc), barrier: phi(r.barrier_enc), notes: phi(r.notes_enc) })) },
    tasks: { label: 'To-dos', columns: ['title', 'client_code', 'assignee', 'due_at', 'priority', 'status', 'is_milestone', 'completed_at', 'description'],
      rows: () => db.all(`SELECT t.*, c.client_code, t.client_id AS _client_id, u.display_name assignee FROM tasks t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN users u ON u.id=t.assigned_to WHERE t.created_at BETWEEN ? AND ? AND (t.client_id IS NULL OR ${cf.sql}) ORDER BY t.due_at LIMIT ?`, from, toEnd, ...cf.params, MAX_ROWS).map(r => ({ ...r, title: phi(r.title_enc), description: phi(r.description_enc) })) },
    forms: { label: 'Client forms', columns: ['created_at', 'client_code', 'template_name', 'status', 'completed_at', 'completed_by', 'created_by', 'attachments'],
      rows: () => db.all(`SELECT f.created_at, c.client_code, f.client_id AS _client_id, f.template_name, f.status, f.completed_at, cu.display_name completed_by, cr.display_name created_by, (SELECT COUNT(*) FROM client_form_files x WHERE x.client_form_id=f.id) attachments FROM client_forms f JOIN clients c ON c.id=f.client_id LEFT JOIN users cu ON cu.id=f.completed_by JOIN users cr ON cr.id=f.created_by WHERE f.deleted_at IS NULL AND f.created_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY f.created_at DESC LIMIT ?`, from, toEnd, ...cf.params, MAX_ROWS) },
    resources: { label: 'Resource directory', noClients: true, columns: ['name', 'category', 'organization', 'phone', 'fax', 'email', 'website', 'address', 'city', 'zip', 'hours', 'eligibility', 'services', 'languages', 'accepts_medicaid', 'accepts_uninsured', 'mat_offered', 'capacity_notes', 'contact_person', 'summary', 'service_tags', 'levels_of_care', 'populations', 'intake_process', 'cost_notes', 'is_active', 'last_verified_at', 'notes'],
      rows: () => db.all(`SELECT * FROM resources ORDER BY category, name LIMIT ?`, MAX_ROWS) },
    consents: { label: 'Consents', columns: ['client_code', 'type', 'recipient', 'purpose', 'scope', 'signed_at', 'expires_at', 'expires_event', 'revoked_at', 'document_ref', 'redisclosure_notice_given'],
      rows: () => db.all(`SELECT co.*, c.client_code, co.client_id AS _client_id FROM consents co JOIN clients c ON c.id=co.client_id WHERE co.signed_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY co.signed_at LIMIT ?`, from, to, ...cf.params, MAX_ROWS)
        .map(r => ({ ...r, recipient: phi(r.recipient_enc), purpose: phi(r.purpose_enc), scope: phi(r.scope_enc) })) },
    disclosures: { label: 'Accounting of disclosures', columns: ['client_code', 'disclosed_at', 'recipient', 'purpose', 'what', 'method', 'basis', 'justification', 'source', 'disclosed_by'],
      rows: () => db.all(`SELECT d.*, c.client_code, d.client_id AS _client_id, u.display_name disclosed_by FROM disclosures d JOIN clients c ON c.id=d.client_id JOIN users u ON u.id=d.disclosed_by WHERE d.disclosed_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY d.disclosed_at LIMIT ?`, from, toEnd, ...cf.params, MAX_ROWS)
        .map(r => ({ ...r, recipient: phi(r.recipient_enc), purpose: phi(r.purpose_enc), what: phi(r.what_enc), justification: phi(r.justification_enc) })) },
    episodes: { label: 'Episodes of care', columns: ['client_code', 'opened_at', 'closed_at', 'status', 'referral_source', 'discharge_reason', 'discharge_disposition', 'funding_source'],
      rows: () => db.all(`SELECT e.*, c.client_code, e.client_id AS _client_id, f.name funding_source FROM episodes e JOIN clients c ON c.id=e.client_id LEFT JOIN funding_sources f ON f.id=e.funding_source_id WHERE e.opened_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY e.opened_at LIMIT ?`, from, to, ...cf.params, MAX_ROWS) },
    overdose_events: { label: 'Overdose & reversal events', columns: strip(['occurred_at', 'client_code', 'kind', 'substances', 'naloxone_used', 'naloxone_doses', 'administered_by', 'ems_called', 'hospitalized', 'survived', 'location_type', 'city']),
      rows: () => db.all(`SELECT o.*, c.client_code, o.client_id AS _client_id FROM overdose_events o LEFT JOIN clients c ON c.id=o.client_id WHERE o.occurred_at BETWEEN ? AND ? AND (o.client_id IS NULL OR ${cf.sql}) ORDER BY o.occurred_at LIMIT ?`, from, toEnd, ...cf.params, MAX_ROWS).map(r => ({ ...r, substances: phi(r.substances_enc) })) },
  };
  if (auth.hasPerm(ctx.user, 'budget:read')) {
    D.funds = { label: 'Funding sources', noClients: true, columns: ['name', 'source_type', 'grant_number', 'fiscal_year_start', 'fiscal_year_end', 'total_amount', 'restrictions', 'is_active'], rows: () => db.all(`SELECT * FROM funding_sources ORDER BY fiscal_year_start DESC`) };
    D.budget_lines = { label: 'Budget lines', noClients: true, columns: ['fund', 'category', 'label', 'allocated_amount', 'notes'], rows: () => db.all(`SELECT b.*, f.name fund FROM budget_lines b JOIN funding_sources f ON f.id=b.funding_source_id ORDER BY f.name, b.category`) };
    D.expenditures = { label: 'Expenditures', columns: ['spent_at', 'fund', 'line', 'category', 'amount', 'status', 'client_code', 'vendor', 'description', 'receipt_ref', 'worker', 'approver'],
      rows: () => db.all(`SELECT e.*, f.name fund, b.label line, c.client_code, e.client_id AS _client_id, u.display_name worker, a.display_name approver FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id LEFT JOIN budget_lines b ON b.id=e.budget_line_id LEFT JOIN clients c ON c.id=e.client_id JOIN users u ON u.id=e.user_id LEFT JOIN users a ON a.id=e.approved_by WHERE e.spent_at BETWEEN ? AND ? ORDER BY e.spent_at`, from, to).map(r => ({ ...r, amount: cents(r.amount) })) };
  }
  // Safe Harbor is applied to every client-linked dataset, uniformly, on the way out — not per column in
  // each query, where one new date column would quietly slip through. A de-identified dataset is also cut
  // down to its allow-listed columns (DEID_COLUMNS), both in the column list and in the row objects.
  for (const [kind, d] of Object.entries(D)) {
    const raw = d.rows;
    if (identified || d.noClients) { d.rows = raw; continue; }
    const allowed = DEID_COLUMNS[kind];
    if (!allowed) throw new Error(`No de-identified column list is defined for the ${kind} dataset`);
    d.columns = d.columns.filter(c => allowed.includes(c));
    d.rows = () => raw().map(r => projectRow(deidentifyRow(r), allowed));
  }
  return D;
}
/** Distinct client ids a set of exported rows covers (the hidden _client_id column), for the accounting. */
function clientIdsOf(rows) { return [...new Set(rows.map(r => r._client_id).filter(Boolean))]; }
/** Drop the internal columns before anything is written to a file. */
function publicRows(rows) { return rows.map(r => { const o = { ...r }; delete o._client_id; return o; }); }

module.exports = { datasets, ageBand, deidentifyRow, clientIdsOf, publicRows, DEID_LABEL, DEID_COLUMNS, cents };
