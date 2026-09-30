'use strict';
// The field-device sync scope (released in 1.21.0; docs/PLATFORM.md "Field devices").
//
// A device syncs in one of two scopes (devices.sync_scope). 'full' carries everything its user may read, as every
// device did before. 'field' carries only what a field worker needs: the clients on the worker's OWN caseload who
// were assigned or seen in a recent window (field_device_window_days, 90 by default), with the minimum of their
// record; the worker's recent outreach contacts and overdose reports; supplies, sites and the programme's lists;
// the worker's own to-dos. Not clinical notes, documents, consents, intake details, other workers' clients.
//
// Every synchronised table has an explicit decision below, as data: 'include' (as the full scope sends it),
// 'exclude' (never sent to a field device, and a field device's writes to it are refused), or 'reduce' (fewer rows,
// `rows`, and/or columns sent blank, `blank`). test/field-device.test.js fails when a table in server/sync-tables.js
// has no decision here, so a new table cannot reach a field device by default.
//
// The office enforces it: server/routes/sync.js pull filters by it, server/rules/push.js refuses a field device's
// writes outside it and never lets a blanked column overwrite the office's value, and a field device's sync session
// reaches nothing but the sync routes (server/auth.js requireAuth). The device only tidies what it already holds
// (local/sync.js); it is never trusted to filter. Pure data and SQL builders: the browser kernel bundles it too.

const WINDOW_DEFAULT = 90;
const WINDOW_MIN = 7;
const WINDOW_MAX = 365;

// Columns of a client's record a field device is sent blank: contact and identity details, intake, legal and
// clinical details a worker in the street does not need to find, recognise and help the person.
const CLIENT_BLANK = ['dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc', 'goals_enc',
  'contact_preferences_enc', 'legal_hold_reason_enc', 'legal_hold_cleared_reason_enc', 'removed_reason_enc',
  'zip', 'insurance', 'justice_involved', 'pregnant_or_parenting', 'co_occurring_mh', 'asam_level', 'mat_medication', 'discharge_reason',
  'referral_source', 'race_ethnicity', 'race_codes', 'veteran'];

const include = (why) => ({ decision: 'include', why });
const exclude = (why) => ({ decision: 'exclude', why });
const reduce = (why, { rows = null, blank = [] } = {}) => ({ decision: 'reduce', why, rows, blank });

const TABLES = {
  users: include('staff accounts: who recorded what, and the worker\'s own sign-in on the device'),
  resources: include('the referral directory, to hand someone a place to go'),
  resource_photos: include('pictures of the directory\'s places'),
  policy_documents: exclude('office policies are read at the office'),
  funding_sources: include('a contact is charged to a fund (amounts redacted as for any role without budget:read)'),
  budget_lines: include('a contact may name a budget line'),
  clients: reduce('only the worker\'s own recent caseload, with contact, intake, legal and clinical details blank', { rows: 'field_clients', blank: CLIENT_BLANK }),
  assignments: reduce('who is on the case, for the worker\'s recent clients only; the transfer notes blank', { rows: 'client', blank: ['notes_enc'] }),
  episodes: exclude('episodes of care are the office\'s intake and discharge record'),
  caloms_records: exclude('state reporting'),
  interventions: reduce('the worker\'s recent clients\' contacts in the window, and the worker\'s own anonymous contacts', { rows: 'contacts' }),
  overdose_events: reduce('overdose reports in the window: the worker\'s recent clients\', and those the worker reported with no client', { rows: 'overdoses' }),
  prevention_events: exclude('group prevention events are recorded at the office'),
  calls: exclude('phone calls, with callers\' names and numbers'),
  time_entries: exclude('timesheets are the office\'s'),
  consents: exclude('consents are the legal record, kept at the office'),
  court_orders: exclude('court orders'),
  part2_notices: exclude('Part 2 notices'),
  referrals: exclude('referrals name the client to another organisation'),
  tasks: reduce('the worker\'s own to-dos, about their recent clients or no client; a referral link blank', { rows: 'own_tasks', blank: ['referral_id'] }),
  expenditures: exclude('spending'),
  notes: exclude('notes, clinical or not'),
  note_addenda: exclude('addenda to notes'),
  disclosures: exclude('the accounting of disclosures'),
  imports: exclude('imported pages and transcripts'),
  import_items: exclude('imported pages and transcripts'),
  form_templates: exclude('form templates'),
  client_forms: exclude('completed forms (intake and others)'),
  client_form_files: exclude('form attachments'),
  patient_requests: exclude('patient-rights requests'),
  problems: exclude('the problem list'),
  problem_history: exclude('the problem list\'s history'),
  care_plan_goals: exclude('the care plan'),
  care_plan_steps: exclude('the care plan'),
  asam_assessments: exclude('ASAM assessments'),
  outcome_measures: exclude('scored screenings'),
  suprt_assessments: exclude('SUPRT-A records'),
  supply_sites: include('where supplies come from'),
  supply_items: include('what can be handed out'),
  intervention_supplies: reduce('the items handed out on the contacts the device holds', { rows: 'contact_items' }),
  supply_ledger: include('stock on hand (no client on it)'),
  option_overrides: include('the programme\'s wording of its lists'),
  disclosure_agreements: exclude('disclosure agreements'),
};

function decision(table) { return TABLES[table] || null; }
function excluded(table) { const d = TABLES[table]; return !d || d.decision === 'exclude'; }
function blankColumns(table) { const d = TABLES[table]; return (d && d.blank) || []; }

/** The window in days (the programme's setting, bounded), from a getSetting function. */
function windowDays(getSetting) {
  const n = Math.floor(Number(getSetting('field_device_window_days', String(WINDOW_DEFAULT))));
  return Number.isFinite(n) && n >= WINDOW_MIN && n <= WINDOW_MAX ? n : WINDOW_DEFAULT;
}
/** The field context of one sync: whose device, and the start of the window (ISO, and its calendar date). */
function context(userId, days, now = Date.now()) {
  const start = new Date(now - days * 86400000).toISOString();
  return { userId, days, windowStart: start, windowDate: start.slice(0, 10) };
}

/**
 * The clients a field device holds, as SQL: on the worker's own caseload (an active assignment to them, whatever
 * else their role lets them read) and assigned or seen in the window (the assignment started or was made in it, or
 * the client has a contact in it). `active` is auth.activeAssignment('a.').
 */
function clientSetSql(f, active) {
  return { sql: `SELECT a.client_id FROM assignments a WHERE a.user_id=? AND ${active} AND (a.start_date >= ? OR a.created_at >= ? OR EXISTS (SELECT 1 FROM interventions fi WHERE fi.client_id=a.client_id AND fi.occurred_at >= ?))`,
    params: [f.userId, f.windowDate, f.windowStart, f.windowStart] };
}

/** The extra condition a table's rows meet on a field device (on `alias`), or null for none. */
function rowSql(table, alias, f, active) {
  const d = TABLES[table];
  if (!d || d.decision === 'exclude') return { sql: '0=1', params: [] };
  if (!d.rows) return null;
  const set = clientSetSql(f, active);
  const x = alias;
  switch (d.rows) {
    case 'field_clients':
      return { sql: `(${x}.id IN (${set.sql}) OR (${x}.merged_into IS NOT NULL AND ${x}.merged_into IN (${set.sql})))`, params: [...set.params, ...set.params] };
    case 'client':
      return { sql: `${x}.client_id IN (${set.sql})`, params: set.params };
    case 'contacts':
      return { sql: `(${x}.occurred_at >= ? AND ((${x}.client_id IS NULL AND ${x}.user_id=?) OR ${x}.client_id IN (${set.sql})))`, params: [f.windowStart, f.userId, ...set.params] };
    case 'overdoses':
      return { sql: `(${x}.occurred_at >= ? AND ((${x}.client_id IS NULL AND ${x}.reported_by=?) OR ${x}.client_id IN (${set.sql})))`, params: [f.windowStart, f.userId, ...set.params] };
    case 'contact_items':
      return { sql: `${x}.intervention_id IN (SELECT ci.id FROM interventions ci WHERE ci.occurred_at >= ? AND ((ci.client_id IS NULL AND ci.user_id=?) OR ci.client_id IN (${set.sql})))`, params: [f.windowStart, f.userId, ...set.params] };
    case 'own_tasks':
      return { sql: `((${x}.assigned_to=? OR (${x}.assigned_to IS NULL AND ${x}.created_by=?)) AND (${x}.client_id IS NULL OR ${x}.client_id IN (${set.sql})))`, params: [f.userId, f.userId, ...set.params] };
    default: throw new Error(`field-scope: unknown row rule ${d.rows}`);
  }
}

/** What a device is told about its own scope (the pull answer's `field`, shown on its This device page). */
function describe(f) {
  return {
    window_days: f.days, window_start: f.windowStart,
    holds: 'the clients on your own caseload assigned or seen in the last ' + f.days + ' days (name, participant code and safety flags; no contact, intake, legal or clinical details), your outreach contacts and overdose reports from that time, your own to-dos, supplies and sites, and the program\'s lists',
    excluded: Object.entries(TABLES).filter(([, d]) => d.decision === 'exclude').map(([t]) => t),
    reduced: Object.fromEntries(Object.entries(TABLES).filter(([, d]) => d.decision === 'reduce').map(([t, d]) => [t, d.blank || []])),
    windowed: Object.entries(TABLES).filter(([, d]) => ['contacts', 'overdoses', 'contact_items'].includes(d.rows)).map(([t]) => t),
  };
}

module.exports = { TABLES, CLIENT_BLANK, WINDOW_DEFAULT, WINDOW_MIN, WINDOW_MAX, decision, excluded, blankColumns, windowDays, context, clientSetSql, rowSql, describe };
