'use strict';
// The permission catalog: every permission string the codebase grants, in one place, so the
// admin UI can list them and the override API can validate them. Derived from the PERMS map in
// server/auth.js (which stays the source of the *role defaults*); the test in
// test/user-permissions.test.js fails if the two drift apart.
// risk: 'privileged' = full-administration powers (grantable only to role=admin, enforced in
//   server/routes/users.js); 'sensitive' = PHI-identifying or disclosure powers, or ones that decide whose
//   records a person reaches (shown with a warning in the admin UI); 'standard' = everything else.
const PRIVILEGED_PERMISSIONS = ['users:manage', 'settings:manage', 'apikeys:manage'];

// assignments:manage decides who is on a client's care team (and so who reaches the record); clients:read opens
// records; clients:list-deidentified lists every client by code (security review of 1.15.3, M1).
const SENSITIVE = new Set(['export:identified', 'clients:all', 'disclosures:override', 'notes:clinical:breakglass', 'clients:merge', 'clients:legal-hold',
  'assignments:manage', 'clients:read', 'clients:list-deidentified']);

// What opens a client's identity: a record (clients:write implies clients:read, auth.hasPerm), or a file of them.
const IDENTIFYING = ['clients:read', 'clients:write', 'export:identified'];
/**
 * Why an individual grant of `permission` does not fit an account of `role` (whose defaults are `roleDefaults`),
 * or null when it does. The same rule refuses the grant (POST /api/users/:id/permissions), removes it when the
 * role changes (PUT /api/users/:id) and ignores it at request time (auth.effectivePerms), so a row that breaks
 * it -- written before 1.15.4, or by hand -- does nothing (security review of 1.15.3, M1 and M2):
 *   - a privileged permission is an administrator's, never a grant to another role;
 *   - a de-identified role (clients:list-deidentified without clients:read: finance, readonly) knows clients by
 *     code only, and is never granted what would identify them;
 *   - clients:list-deidentified is that role's read path, not something to add to a role that opens records.
 * Denying is always allowed: it only takes away.
 */
function grantProblem(role, roleDefaults, permission) {
  const defaults = roleDefaults || [];
  if (PRIVILEGED_PERMISSIONS.includes(permission) && role !== 'admin') return `"${permission}" can only be granted to an administrator — change their role instead`;
  const deidentified = defaults.includes('clients:list-deidentified') && !defaults.some(p => IDENTIFYING.includes(p));
  if (deidentified && IDENTIFYING.includes(permission)) return `A ${role} account knows clients by client code only (de-identified), so it cannot be granted "${permission}", which would let it identify them. If this person needs to open client records, give them a role that does.`;
  if (permission === 'clients:list-deidentified' && defaults.some(p => IDENTIFYING.includes(p))) return `"clients:list-deidentified" is how a de-identified role (finance, read-only) lists clients by code. A ${role} already opens the records on their caseload; to show them every client, grant clients:all instead.`;
  return null;
}

const DEFS = [
  ['users:manage', 'Manage users & permissions', 'Create/edit/deactivate accounts, change roles, grant or revoke individual permissions.'],
  ['users:read', 'See the staff directory', 'Minimal staff list for assignment dropdowns.'],
  ['settings:manage', 'Manage program settings', 'Program profile, modules, MFA policy, SCIM mapping, caseload restriction.'],
  ['audit:read', 'Read the audit log', 'Tamper-evident audit trail and the break-glass review queue.'],
  ['apikeys:manage', 'Manage API keys', 'Intake API keys and FHIR client registrations.'],
  ['clients:read', 'Open client records', 'Identified client data for clients on the caseload (or all, with clients:all).'],
  ['clients:write', 'Edit client records', 'Create and edit identified client records.'],
  ['clients:all', 'See every client', 'Bypasses caseload scoping; required for whole-program internal reports.'],
  ['clients:list-deidentified', 'List de-identified clients', 'Client codes only, never names or identifiers.'],
  ['clients:merge', 'Merge duplicate clients', 'Combine two client records, audited.'],
  ['clients:legal-hold', 'Place a legal hold', 'Prevent deletion/merge of a client record under hold.'],
  ['interventions:*', 'Visits & services (all)', 'Log, edit and delete visits and services.'],
  ['calls:*', 'Calls & texts (all)', 'Log, edit and delete call and text records.'],
  ['time:read', 'See time entries', 'Own time entries.'],
  ['time:write', 'Log time', 'Create and edit own time entries.'],
  ['time:all', 'See all time entries', 'Every worker\'s time entries, any range or fund.'],
  ['time:approve', 'Approve time', 'Approve or reject others\' time entries.'],
  ['resources:*', 'Resource directory (all)', 'Create, edit and publish community resources.'],
  ['resources:read', 'Read the resource directory', 'Community resources and referral targets.'],
  ['referrals:*', 'Referrals (all)', 'Create, edit and record outcomes on referrals.'],
  ['tasks:*', 'To-dos (all)', 'Create, assign and complete to-dos.'],
  ['budget:read', 'See the budget', 'Funding sources, lines and expenditures.'],
  ['budget:write', 'Record spending', 'Log expenditures and attach costs to visits.'],
  ['budget:approve', 'Approve spending', 'Approve, reject or mark reimbursed (never own entries).'],
  ['budget:manage', 'Manage the budget', 'Funding sources, budget lines and allocations.'],
  ['notes:admin:read', 'Read admin notes', 'Non-clinical case notes.'],
  ['notes:admin:write', 'Write admin notes', 'Create and edit non-clinical case notes.'],
  ['notes:clinical:read', 'Read clinical notes', 'Clinical notes and assessments content.'],
  ['notes:clinical:write', 'Write clinical notes', 'Create and sign clinical notes.'],
  ['notes:clinical:breakglass', 'Clinical notes via break-glass', 'Open a clinical note only with a written reason; audited and queued for supervisor review.'],
  ['notes:cosign', 'Countersign notes', 'Countersign trainee notes.'],
  ['consents:*', 'Consents (all)', 'Record, edit and revoke Part 2 consents and disclosures.'],
  ['imports:*', 'Data imports (all)', 'Run and review bulk imports.'],
  ['graph:import', 'Import from OneNote', 'Fetch the shared OneNote notebook.'],
  ['reports:read', 'Read reports', 'Run aggregate reports.'],
  ['reports:internal', 'Run internal reports', 'Identified/caseload reports for program use (never publication).'],
  ['reports:exact', 'Exact counts', 'Unsuppressed counts for internal runs.'],
  ['reports:funder', 'File the funder submission', 'The program\'s own submission runs of the funder report, NDP log and settlement report: exact aggregates, no client-level data.'],
  ['assignments:manage', 'Manage caseloads', 'Assign workers to clients and move caseloads between workers.'],
  ['export:read', 'Export data', 'De-identified (Safe Harbor) exports, caseload-scoped.'],
  ['export:identified', 'Export identified data', 'Exports with names, dates of birth, addresses. Never held with a de-identified role.'],
  ['forms:*', 'Forms (all)', 'Manage the form library and client forms.'],
  ['forms:read', 'Read the form library', 'Blank form templates.'],
  ['forms:write', 'Manage form templates', 'Upload and edit form templates.'],
  ['episodes:*', 'Episodes (all)', 'Open, edit and close treatment episodes.'],
  ['overdose:*', 'Overdose events (all)', 'Record overdose and reversal events.'],
  ['documents:read', 'Read documents', 'Program documents.'],
  ['documents:write', 'Manage documents', 'Upload and organize program documents.'],
  ['disclosures:override', 'Override disclosure basis', 'Record a disclosure on supervisor-override or other non-consent bases.'],
  ['patient-requests:*', 'Client rights requests (all)', 'Handle access/amendment/accounting requests.'],
  ['careplan:*', 'Care plans (all)', 'Problem list and care coordination plans.'],
  ['careplan:read', 'Read care plans', 'View care plans and problem lists.'],
  ['assessments:*', 'Assessments (all)', 'ASAM assessments and scored screenings.'],
  ['complaints:*', 'Grievances (all)', 'Record and resolve client grievances.'],
  ['incidents:*', 'Incidents (all)', 'Record and review incidents.'],
  ['court-orders:*', 'Court orders (all)', 'Record and manage court orders.'],
  ['court-orders:read', 'Read court orders', 'View court orders.'],
  ['agreements:*', 'Agreements (all)', 'Data-sharing and disclosure agreements.'],
  ['agreements:read', 'Read agreements', 'View agreements.'],
  ['supplies:*', 'Supply cupboard (all)', 'Items, sites, transfers, adjustments, disposal.'],
  ['supplies:read', 'See supply stock', 'Stock on hand by site and lot.'],
  ['supplies:receive', 'Receive supply deliveries', 'Record stock that arrived at a site.'],
];

const PERMISSION_CATALOG = DEFS.map(([name, label, description]) => ({
  name,
  label,
  description,
  risk: PRIVILEGED_PERMISSIONS.includes(name) ? 'privileged' : SENSITIVE.has(name) ? 'sensitive' : 'standard',
}));

const KNOWN = new Set(PERMISSION_CATALOG.map((p) => p.name));
function isKnownPermission(name) { return KNOWN.has(name); }

module.exports = { PERMISSION_CATALOG, PRIVILEGED_PERMISSIONS, isKnownPermission, grantProblem };
