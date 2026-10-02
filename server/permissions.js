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
// records; clients:list-deidentified lists every client by code (security review of 1.15.3, M1);
// records:manage-others (1.16.0) changes, deletes and records under the name of other workers' work.
const SENSITIVE = new Set(['export:identified', 'clients:all', 'records:manage-others', 'disclosures:override', 'notes:clinical:breakglass', 'clients:merge', 'clients:legal-hold',
  'assignments:manage', 'clients:read', 'clients:list-deidentified',
  // ai:draft (1.17.0) sends de-identified session text about a client to the AI provider (docs/AI-COPILOT.md).
  'ai:draft',
  // county:manage decides whose signed figures a county accepts (it registers the keys they are checked with).
  'county:manage',
  // intake:read and intake:write (1.24.0) open the names and needs of everyone referred to the programme, client or not.
  'intake:read', 'intake:write']);

const COUNTY_PERMS = ['county:view', 'county:manage'];
const EXACT_COUNTS = ['reports:exact', 'reports:funder'];
// What opens a client's identity: a record (clients:write implies clients:read, auth.hasPerm), or a file of them.
// The intake queue (1.24.0) names people referred to the programme, so it identifies them too.
const IDENTIFYING = ['clients:read', 'clients:write', 'export:identified', 'intake:read', 'intake:write'];
/**
 * Why an individual grant of `permission` does not fit an account of `role` (whose defaults are `roleDefaults`),
 * or null when it does. The same rule refuses the grant (POST /api/users/:id/permissions), removes it when the
 * role changes (PUT /api/users/:id) and ignores it at request time (auth.effectivePerms), so a row that breaks
 * it -- written before 1.15.4, or by hand -- does nothing (security review of 1.15.3, M1 and M2):
 *   - a privileged permission is an administrator's, never a grant to another role;
 *   - a de-identified role (clients:list-deidentified without clients:read: finance, readonly) knows clients by
 *     code only, and is never granted what would identify them;
 *   - clients:list-deidentified is that role's read path, not something to add to a role that opens records;
 *   - records:manage-others (1.16.0) manages other workers' client work, so it presupposes a role that records
 *     client work at all (clients:write in its defaults: navigator, clinician, supervisor, administrator).
 * Denying is always allowed: it only takes away.
 */
function grantProblem(role, roleDefaults, permission) {
  const defaults = roleDefaults || [];
  if (PRIVILEGED_PERMISSIONS.includes(permission) && role !== 'admin') return `"${permission}" can only be granted to an administrator — change their role instead`;
  const deidentified = defaults.includes('clients:list-deidentified') && !defaults.some(p => IDENTIFYING.includes(p));
  if (deidentified && IDENTIFYING.includes(permission)) return `A ${role} account knows clients by client code only (de-identified), so it cannot be granted "${permission}", which would let it identify them. If this person needs to open client records, give them a role that does.`;
  if (permission === 'records:manage-others' && !defaults.includes('clients:write')) return `"${permission}" can only be granted to a role that records client work (navigator, clinician, supervisor, administrator)`;
  if (permission === 'ai:draft' && !defaults.includes('clients:write')) return `"${permission}" can only be granted to a role that documents client work (navigator, clinician, supervisor, administrator)`;
  // The county view's figures are exact, small counts included, and not for publication: only a role that sees exact
  // aggregate counts (reports:exact or reports:funder: finance, supervisor, administrator) may hold it. Read-only's
  // reports are publication releases, and front-line roles run no submission.
  if (COUNTY_PERMS.includes(permission) && !defaults.some(p => EXACT_COUNTS.includes(p))) return `"${permission}" can only be granted to a role that sees exact aggregate counts (finance, supervisor, administrator): the county view's figures are exact and not for publication`;
  if (permission === 'clients:list-deidentified' && defaults.some(p => IDENTIFYING.includes(p))) return `"clients:list-deidentified" is how a de-identified role (finance, read-only) lists clients by code. A ${role} already opens client records; to show them every client (not only their caseload), clients:all is the permission.`;
  return null;
}

const DEFS = [
  ['users:manage', 'Manage users & permissions', 'Create/edit/deactivate accounts, change roles, grant or revoke individual permissions.'],
  ['users:read', 'See the staff directory', 'Minimal staff list for assignment dropdowns.'],
  ['settings:manage', 'Manage program settings', 'Program profile, modules, MFA policy, SCIM mapping, caseload restriction.'],
  ['audit:read', 'Read the audit log', 'Tamper-evident audit trail and the break-glass review queue.'],
  ['apikeys:manage', 'Manage API keys', 'Intake API keys and FHIR client registrations.'],
  ['clients:read', 'Open client records', 'Identified client data: every client with clients:all, otherwise only the clients assigned to them.'],
  ['clients:write', 'Edit client records', 'Create and edit identified client records. Shared: anyone who sees a client may update it, and the client\'s primary worker is told which fields changed when someone not on the care team does.'],
  ['clients:all', 'See every client', 'Every client, not only their caseload (navigators, clinicians, supervisors and administrators by default from 1.16.0), to read and add their own work to, with whole-program reports and synced devices. Deny it to hold a person to their caseload.'],
  ['records:manage-others', 'Manage other workers\' records', 'Change or delete another worker\'s visits, calls, referrals, overdose reports, to-dos, care-plan goals, assessments and draft notes; record work under another worker\'s name; remove a client record; see other workers\' staged imports. Supervisors and administrators.'],
  ['clients:list-deidentified', 'List de-identified clients', 'Client codes only, never names or identifiers.'],
  ['clients:merge', 'Merge duplicate clients', 'Combine two client records, audited.'],
  ['clients:legal-hold', 'Place a legal hold', 'Prevent deletion/merge of a client record under hold.'],
  ['interventions:*', 'Visits & services (read, log, change own)', 'Read and log visits and services; edit and delete their own. Another worker\'s need Manage other workers\' records.'],
  ['calls:*', 'Calls & texts (read, log, change own)', 'Read and log call and text records; edit and delete their own. Another worker\'s need Manage other workers\' records.'],
  ['time:read', 'See time entries', 'Own time entries.'],
  ['time:write', 'Log time', 'Create and edit own time entries.'],
  ['time:all', 'See all time entries', 'Every worker\'s time entries, any range or fund.'],
  ['time:approve', 'Approve time', 'Approve or reject others\' time entries.'],
  ['resources:*', 'Resource directory (read, add, edit)', 'Create, edit and publish community resources.'],
  ['resources:read', 'Read the resource directory', 'Community resources and referral targets.'],
  ['referrals:*', 'Referrals (read, make, change own)', 'Make referrals and record their outcomes; edit and delete their own. Another worker\'s need Manage other workers\' records.'],
  ['tasks:*', 'To-dos (read, add, change own)', 'Create, assign and complete to-dos; edit and delete the ones assigned to or made by them. Others\' need Manage other workers\' records.'],
  ['budget:read', 'See the budget', 'Funding sources, lines and expenditures.'],
  ['budget:write', 'Record spending', 'Log expenditures and attach costs to visits.'],
  ['budget:approve', 'Approve spending', 'Approve, reject or mark reimbursed (never own entries).'],
  ['budget:manage', 'Manage the budget', 'Funding sources, budget lines and allocations.'],
  ['notes:admin:read', 'Read admin notes', 'Non-clinical case notes.'],
  ['notes:admin:write', 'Write admin notes', 'Create and edit non-clinical case notes.'],
  ['notes:clinical:read', 'Read clinical notes', 'Clinical notes (clinicians, supervisors and, read only, navigators by default from 1.16.0). SUD counseling notes only for their author, the co-signer and those who write clinical notes. Deny it to keep clinical notes from a person.'],
  ['notes:clinical:write', 'Write clinical notes', 'Create and sign clinical notes.'],
  ['notes:clinical:breakglass', 'Clinical notes via break-glass', 'Open a clinical note only with a written reason; audited and queued for supervisor review.'],
  ['notes:cosign', 'Countersign notes', 'Countersign trainee notes.'],
  ['consents:*', 'Consents (read, record, revoke)', 'Record, edit and revoke Part 2 consents and disclosures.'],
  ['imports:*', 'Data imports (run and review)', 'Run and review bulk imports.'],
  ['graph:import', 'Import from OneNote', 'Fetch the shared OneNote notebook.'],
  ['reports:read', 'Read reports', 'Run aggregate reports.'],
  ['reports:internal', 'Run internal reports', 'Identified/caseload reports for program use (never publication).'],
  ['reports:exact', 'Exact counts', 'Unsuppressed counts for internal runs.'],
  ['reports:funder', 'File the funder submission', 'The program\'s own submission runs of the funder report, NDP log and settlement report: exact aggregates, no client-level data.'],
  ['assignments:manage', 'Manage caseloads', 'Assign workers to clients and move caseloads between workers.'],
  ['export:read', 'Export data', 'De-identified (Safe Harbor) exports of the clients they can see (their caseload without clients:all).'],
  ['export:identified', 'Export identified data', 'Exports with names, dates of birth, addresses. Never held with a de-identified role.'],
  ['forms:*', 'Forms (read and manage)', 'Manage the form library and client forms.'],
  ['forms:read', 'Read the form library', 'Blank form templates.'],
  ['forms:write', 'Manage form templates', 'Upload and edit form templates.'],
  ['episodes:*', 'Episodes (read, open, close)', 'Open, edit and close treatment episodes; a discharge or re-admission by the client\'s care team, the person who opened it, or a supervisor.'],
  ['overdose:*', 'Overdose events (read, record, change own)', 'Record overdose and reversal events; edit and delete their own. Another worker\'s need Manage other workers\' records.'],
  ['documents:read', 'Read documents', 'Program documents.'],
  ['documents:write', 'Manage documents', 'Upload and organize program documents.'],
  ['disclosures:override', 'Override disclosure basis', 'Record a disclosure on supervisor-override or other non-consent bases.'],
  ['patient-requests:*', 'Client rights requests (read and handle)', 'Handle access/amendment/accounting requests.'],
  ['careplan:*', 'Care plans (read, add, change own)', 'Problem list and care coordination plans. A goal\'s or step\'s wording, and deleting it, belong to the person who added it; another worker\'s need Manage other workers\' records.'],
  ['careplan:read', 'Read care plans', 'View care plans and problem lists.'],
  ['assessments:*', 'Assessments (read, record, change own)', 'ASAM assessments and scored screenings; an ASAM assessment is changed by the person who completed it, or with Manage other workers\' records.'],
  ['complaints:*', 'Grievances (read, record, resolve)', 'Record and resolve client grievances.'],
  ['incidents:*', 'Incidents (read, record, review)', 'Record and review incidents.'],
  ['court-orders:*', 'Court orders (read and manage)', 'Record and manage court orders.'],
  ['court-orders:read', 'Read court orders', 'View court orders.'],
  ['agreements:*', 'Agreements (read and manage)', 'Data-sharing and disclosure agreements.'],
  ['agreements:read', 'Read agreements', 'View agreements.'],
  ['supplies:*', 'Supplies (read and manage)', 'Items, sites, transfers, adjustments, disposal.'],
  ['supplies:read', 'See supply stock', 'Stock on hand by site and lot.'],
  ['supplies:receive', 'Receive supply deliveries', 'Record stock that arrived at a site.'],
  ['county:view', 'See the county view', 'For a county that funds programmes: the signed submissions they send, side by side and summed for a period, and its Excel or CSV file. Exact aggregate figures for authorised county staff, not for publication; never a client. Administrators, supervisors and finance by default.'],
  ['county:manage', 'Manage county submissions', 'Register the programmes whose signed submissions the county accepts (each by its public key), import their files and withdraw one. Administrators by default.'],
  ['intake:read', 'See incoming referrals', 'The intake queue: every referral to the program from a hospital, jail, detox, probation or court, another provider, the person or their family, with the person\'s name, contact details and needs, before they are a client. Not limited to a caseload. Navigators, clinicians, supervisors and administrators by default.'],
  ['intake:write', 'Work incoming referrals', 'Record a referral to the program, log attempts to reach the person, assign it, and accept it (linking or creating the client record) or close it as declined, unable to reach or referred elsewhere. Navigators, clinicians, supervisors and administrators by default.'],
  ['ai:draft', 'Use the AI documentation copilot', 'Ask the AI copilot for a draft (progress note sections, assessment narratives, care plan and CalOMS suggestions) from text they give it, with identifiers replaced before it is sent. Only while an administrator has recorded the agreement with the provider and switched the copilot on. Clinicians, supervisors and navigators by default.'],
];

const PERMISSION_CATALOG = DEFS.map(([name, label, description]) => ({
  name,
  label,
  description,
  risk: PRIVILEGED_PERMISSIONS.includes(name) ? 'privileged' : SENSITIVE.has(name) ? 'sensitive' : 'standard',
}));

// The permissions that widen what a person may read (engineering review of 1.16.0, M7: they were listed by hand in
// the sync scope key, the device sign-up's caseload hold and the benchmark). A new one goes here, and the sync
// scope key (server/routes/sync.js) re-syncs a device whose holding of it changes; test/user-permissions.test.js
// checks every permission the read scoping names is here.
const READ_SCOPE_PERMS = Object.freeze({
  'clients:all': 'every client, not only the caseload; and every worker\'s records with no client',
  'records:manage-others': 'other workers\' imports and their items',
  'notes:clinical:read': 'clinical notes and their addenda',
});
// Of those, what holds a person to their own caseload when denied (a device sign-up, local/kernel.js).
const CASELOAD_PERMS = Object.freeze(['clients:all', 'notes:clinical:read']);

const KNOWN = new Set(PERMISSION_CATALOG.map((p) => p.name));
function isKnownPermission(name) { return KNOWN.has(name); }

module.exports = { PERMISSION_CATALOG, PRIVILEGED_PERMISSIONS, READ_SCOPE_PERMS, CASELOAD_PERMS, isKnownPermission, grantProblem };
