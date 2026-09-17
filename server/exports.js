'use strict';
// Table exports shared by CSV/Excel endpoints. De-identified (client codes) unless `identified` is allowed.
const db = require('./db');
const auth = require('./auth');
const M = require('./clients-model');
const { decrypt } = require('./crypto');

function datasets(ctx, { from, to, toEnd, identified }) {
  const cf = auth.caseloadFilter(ctx.user, 'c.id'); const all = auth.hasPerm(ctx.user, 'time:all') ? 1 : 0;
  const idCols = identified ? ['last_name', 'first_name', 'dob', 'phone', 'email', 'address'] : [];
  const D = {
    clients: { label: 'Clients', columns: ['client_code', ...idCols, 'status', 'intake_date', 'discharge_date', 'discharge_reason', 'referral_source', 'primary_substance', 'secondary_substances', 'asam_level', 'mat_status', 'mat_medication', 'risk_level', 'housing_status', 'insurance', 'overdose_history', 'naloxone_provided', 'naloxone_last_date', 'co_occurring_mh', 'justice_involved', 'pregnant_or_parenting', 'city', 'zip', 'gender', 'preferred_language', 'goals', 'flags'],
      rows: () => db.all(`SELECT c.* FROM clients c WHERE c.deleted_at IS NULL AND ${cf.sql} ORDER BY c.client_code`, ...cf.params).map(x => M.decryptRow(x, { deidentify: !identified })) },
    interventions: { label: 'Visits & services', columns: ['occurred_at', 'client_code', 'type', 'duration_minutes', 'location', 'modality', 'outcome', 'stage_of_change', 'naloxone_kits', 'fentanyl_strips', 'worker', 'funding_source', 'cost', 'summary', 'follow_up_due'],
      rows: () => db.all(`SELECT i.*, c.client_code, u.display_name worker, f.name funding_source FROM interventions i JOIN clients c ON c.id=i.client_id JOIN users u ON u.id=i.user_id LEFT JOIN funding_sources f ON f.id=i.funding_source_id WHERE i.occurred_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY i.occurred_at`, from, toEnd, ...cf.params) },
    calls: { label: 'Calls', columns: ['started_at', 'client_code', 'direction', 'contact_type', 'contact_name', 'duration_minutes', 'outcome', 'crisis', 'purpose', 'summary', 'follow_up_needed', 'follow_up_due', 'worker'],
      rows: () => db.all(`SELECT ca.*, c.client_code, u.display_name worker FROM calls ca LEFT JOIN clients c ON c.id=ca.client_id JOIN users u ON u.id=ca.user_id WHERE ca.started_at BETWEEN ? AND ? AND (ca.client_id IS NULL OR ${cf.sql}) ORDER BY ca.started_at`, from, toEnd, ...cf.params).map(r => ({ ...r, contact_name: identified && r.contact_name_enc ? decrypt(r.contact_name_enc) : (r.contact_name_enc ? '[redacted]' : ''), summary: identified && r.summary_enc ? decrypt(r.summary_enc) : (r.summary_enc ? '[redacted]' : '') })) },
    time: { label: 'Time', columns: ['work_date', 'worker', 'client_code', 'category', 'minutes', 'billable', 'funding_source', 'description'],
      rows: () => db.all(`SELECT t.*, u.display_name worker, c.client_code, f.name funding_source FROM time_entries t JOIN users u ON u.id=t.user_id LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN funding_sources f ON f.id=t.funding_source_id WHERE t.work_date BETWEEN ? AND ? AND (t.user_id=? OR ?) ORDER BY t.work_date`, from, to, ctx.user.id, all) },
    referrals: { label: 'Referrals', columns: ['referred_at', 'client_code', 'resource', 'category', 'status', 'urgency', 'warm_handoff', 'appointment_at', 'admitted_at', 'closed_at', 'outcome', 'barrier', 'worker', 'notes'],
      rows: () => db.all(`SELECT r.*, c.client_code, res.name resource, res.category, u.display_name worker FROM referrals r JOIN clients c ON c.id=r.client_id JOIN resources res ON res.id=r.resource_id JOIN users u ON u.id=r.user_id WHERE r.referred_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY r.referred_at`, from, toEnd, ...cf.params) },
    tasks: { label: 'To-dos', columns: ['title', 'client_code', 'assignee', 'due_at', 'priority', 'status', 'is_milestone', 'completed_at', 'description'],
      rows: () => db.all(`SELECT t.*, c.client_code, u.display_name assignee FROM tasks t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN users u ON u.id=t.assigned_to WHERE (t.client_id IS NULL OR ${cf.sql}) ORDER BY t.due_at`, ...cf.params) },
    forms: { label: 'Client forms', columns: ['created_at', 'client_code', 'template_name', 'status', 'completed_at', 'completed_by', 'created_by', 'attachments'],
      rows: () => db.all(`SELECT f.created_at, c.client_code, f.template_name, f.status, f.completed_at, cu.display_name completed_by, cr.display_name created_by, (SELECT COUNT(*) FROM client_form_files x WHERE x.client_form_id=f.id) attachments FROM client_forms f JOIN clients c ON c.id=f.client_id LEFT JOIN users cu ON cu.id=f.completed_by JOIN users cr ON cr.id=f.created_by WHERE f.deleted_at IS NULL AND f.created_at BETWEEN ? AND ? AND ${cf.sql} ORDER BY f.created_at DESC`, from, toEnd, ...cf.params) },
    resources: { label: 'Resource directory', columns: ['name', 'category', 'organization', 'phone', 'fax', 'email', 'website', 'address', 'city', 'zip', 'hours', 'eligibility', 'services', 'languages', 'accepts_medicaid', 'accepts_uninsured', 'mat_offered', 'capacity_notes', 'contact_person', 'summary', 'service_tags', 'levels_of_care', 'populations', 'intake_process', 'cost_notes', 'is_active', 'last_verified_at', 'notes'],
      rows: () => db.all(`SELECT * FROM resources ORDER BY category, name`) },
    consents: { label: 'Consents', columns: ['client_code', 'type', 'recipient', 'purpose', 'scope', 'signed_at', 'expires_at', 'revoked_at', 'document_ref'],
      rows: () => db.all(`SELECT co.*, c.client_code FROM consents co JOIN clients c ON c.id=co.client_id WHERE ${cf.sql} ORDER BY co.signed_at`, ...cf.params) },
  };
  if (auth.hasPerm(ctx.user, 'budget:read')) {
    D.funds = { label: 'Funding sources', columns: ['name', 'source_type', 'grant_number', 'fiscal_year_start', 'fiscal_year_end', 'total_amount', 'restrictions', 'is_active'], rows: () => db.all(`SELECT * FROM funding_sources ORDER BY fiscal_year_start DESC`) };
    D.budget_lines = { label: 'Budget lines', columns: ['fund', 'category', 'label', 'allocated_amount', 'notes'], rows: () => db.all(`SELECT b.*, f.name fund FROM budget_lines b JOIN funding_sources f ON f.id=b.funding_source_id ORDER BY f.name, b.category`) };
    D.expenditures = { label: 'Expenditures', columns: ['spent_at', 'fund', 'line', 'category', 'amount', 'status', 'client_code', 'vendor', 'description', 'receipt_ref', 'worker', 'approver'],
      rows: () => db.all(`SELECT e.*, f.name fund, b.label line, c.client_code, u.display_name worker, a.display_name approver FROM expenditures e JOIN funding_sources f ON f.id=e.funding_source_id LEFT JOIN budget_lines b ON b.id=e.budget_line_id LEFT JOIN clients c ON c.id=e.client_id JOIN users u ON u.id=e.user_id LEFT JOIN users a ON a.id=e.approved_by WHERE e.spent_at BETWEEN ? AND ? ORDER BY e.spent_at`, from, to) };
  }
  return D;
}
module.exports = { datasets };
