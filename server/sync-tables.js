'use strict';
// Describes what synchronises between a device (local kernel) and the office server.
// enc: encrypted columns (decrypted for transport over TLS, re-encrypted with the receiver's key)
// idx: blind-index columns recomputed by the receiver; clientCol: column used for caseload scoping
// writePerm: the permission a device must hold for its pushed rows to be accepted (mirrors the REST routes,
//   so syncing can never be a way around a role's limits); parent: the table a row's foreign key points at,
//   so a child is skipped when its parent was rejected rather than blowing up on a constraint.
// selfParent: a column that references another row in this same table (e.g. a nested budget line's
//   parent_id) — rows are topologically sorted by it before applying, so a parent created offline in the
//   same sync batch as its children is always applied first.
// readPerm: rows are only sent to a device whose role holds this permission (see server/routes/sync.js pull).
// NOTE: the order of this array is a foreign-key ordering — a table must appear after everything it references.
// blob: columns too large to belong in a sync payload; they are fetched by id on demand instead.
// legacy: { oldColumn: newColumn } for a column a migration renamed. A device still running an older kernel
//   keeps sending the old name, which no longer exists here and would be dropped with its value (see
//   upgradeLegacyRow). The new column must be listed in enc when the move was into an encrypted column.
module.exports = {
  // caloms_*: whether this programme reports CalOMS Tx (which turns on the CalOMS questions in the admission
  // and discharge forms) and its provider IDs — a device needs both to offer the same forms offline.
  settings_keys: ['org_name', 'county_name', 'program_contact', 'note_lock_days', 'caloms_enabled', 'caloms_providers', 'caloms_start_date'],
  tables: [
    // supervisor_id points at another user: a supervisor must land before the people who report to them.
    { name: 'users', enc: ['mfa_secret_enc'], scope: 'users', cols: null, selfParent: 'supervisor_id' },
    { name: 'resources', enc: [], scope: 'all', writePerm: 'resources:write' },
    { name: 'resource_photos', enc: [], scope: 'all', writePerm: 'resources:write', parent: ['resources', 'resource_id'], blob: ['data_b64'] },
    { name: 'policy_documents', enc: [], scope: 'all', writePerm: 'documents:write', blob: ['file_b64'] },
    // Grant structure is budget:manage over REST; a device holding only budget:write must not restructure it by sync.
    { name: 'funding_sources', enc: [], scope: 'all', writePerm: 'budget:manage' },
    { name: 'budget_lines', enc: [], scope: 'all', writePerm: 'budget:manage', parent: ['funding_sources', 'funding_source_id'], selfParent: 'parent_id' },
    // merged_into points at another client: the record that was kept must land before its duplicate.
    { name: 'clients', enc: ['first_name_enc', 'last_name_enc', 'preferred_name_enc', 'dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc', 'goals_enc', 'flags_enc'], scope: 'client', clientCol: 'id', idx: true, writePerm: 'clients:write', selfParent: 'merged_into' },
    { name: 'assignments', enc: [], scope: 'client', clientCol: 'client_id', writePerm: 'assignments:manage', parent: ['clients', 'client_id'] },
    { name: 'episodes', enc: ['presenting_problem_enc', 'discharge_summary_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'episodes:write', parent: ['clients', 'client_id'] },
    // CalOMS Tx records hang off an episode: the episode must land first.
    { name: 'caloms_records', enc: ['answers_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'episodes:write', parent: ['episodes', 'episode_id'] },
    { name: 'interventions', enc: ['summary_enc'], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'interventions:write', parent: ['clients', 'client_id'] },
    { name: 'overdose_events', enc: ['notes_enc', 'substances_enc'], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'overdose:write', parent: ['clients', 'client_id'] },
    { name: 'calls', enc: ['contact_name_enc', 'phone_enc', 'summary_enc', 'purpose_enc'], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'calls:write', parent: ['clients', 'client_id'] },
    { name: 'time_entries', enc: [], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'time:write', parent: ['clients', 'client_id'] },
    // A referral may cite the consent it was made under, so consents come first.
    { name: 'consents', enc: ['recipient_enc', 'purpose_enc', 'scope_enc', 'signer_name_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    // A disclosure made under a subpart E court order cites it, so orders travel before disclosures.
    { name: 'court_orders', enc: ['court_enc', 'case_ref_enc', 'recipient_enc', 'purpose_enc', 'scope_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'court-orders:write', parent: ['clients', 'client_id'] },
    { name: 'part2_notices', enc: ['notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    { name: 'referrals', enc: ['outcome_enc', 'barrier_enc', 'notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'referrals:write', parent: ['clients', 'client_id'] },
    // Migration 24 moved tasks.description into description_enc; kernels before 1.9.3 still push `description`.
    { name: 'tasks', enc: ['title_enc', 'description_enc'], legacy: { description: 'description_enc' }, scope: 'client-or-null', clientCol: 'client_id', writePerm: 'tasks:write', parent: ['clients', 'client_id'] },
    { name: 'expenditures', enc: [], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'budget:write', parent: ['clients', 'client_id'] },
    { name: 'notes', enc: ['content_enc', 'structured_enc', 'title_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'notes:admin:write', parent: ['clients', 'client_id'] },
    { name: 'note_addenda', enc: ['content_enc'], scope: 'via-note', writePerm: 'notes:admin:write', parent: ['notes', 'note_id'] },
    { name: 'disclosures', enc: ['recipient_enc', 'purpose_enc', 'what_enc', 'justification_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    { name: 'imports', enc: [], scope: 'all', writePerm: 'imports:write' },
    { name: 'import_items', enc: ['content_enc', 'title_enc'], scope: 'all', writePerm: 'imports:write', parent: ['imports', 'import_id'] },
    { name: 'form_templates', enc: [], scope: 'all', writePerm: 'forms:manage', blob: ['file_b64'] },
    { name: 'client_forms', enc: ['values_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'forms:write', parent: ['clients', 'client_id'] },
    { name: 'client_form_files', enc: ['data_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'forms:write', parent: ['client_forms', 'client_form_id'], blob: ['data_enc'] },
    { name: 'patient_requests', enc: ['notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    // Clinical documentation (CalAIM): the problem list and its history, the care plan, ASAM assessments and
    // outcome measures. readPerm: a device whose role cannot read them (an ASAM rating on a navigator's
    // phone) is never sent them, the same minimum-necessary rule clinical notes follow.
    { name: 'problems', enc: ['problem_enc', 'icd10_code_enc', 'icd10_description_enc', 'z_codes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['clients', 'client_id'] },
    { name: 'problem_history', enc: ['changes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['problems', 'problem_id'] },
    { name: 'care_plan_goals', enc: ['goal_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['clients', 'client_id'] },
    { name: 'care_plan_steps', enc: ['step_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['care_plan_goals', 'goal_id'] },
    { name: 'asam_assessments', enc: ['dimension_notes_enc', 'discrepancy_notes_enc', 'summary_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'assessments:write', readPerm: 'assessments:read', parent: ['clients', 'client_id'] },
    { name: 'outcome_measures', enc: ['responses_enc', 'notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'assessments:write', readPerm: 'assessments:read', parent: ['clients', 'client_id'] },
    // Harm-reduction supply counts: shared program state. Pull-only (serverOwned): the office copy is the
    // one shelf count, drawn down there when a pushed visit lands (server/routes/sync.js calls the same
    // draw-down the REST route does). A device's absolute count is never accepted — two phones each
    // subtracting from their own stale copy would otherwise leave whichever synced last as the truth.
    { name: 'supply_stock', enc: [], scope: 'all', writePerm: 'interventions:write', serverOwned: true },
    // Settings → Lists (the wording and order of documentation choices): the office's configuration,
    // pull-only like supply counts. A device needs it to offer the same choices and show the same labels
    // offline; it can never change it (server/routes/options.js refuses writes in the local kernel).
    { name: 'option_overrides', enc: [], scope: 'all', writePerm: 'settings:manage', serverOwned: true },
  ],
  // Push rejection reasons that will never succeed on a retry: the office has ruled, and the device must
  // mark the row as exchanged (office wins) rather than resend it every sync forever. Anything else
  // (network, a 5xx, an unknown SQL error) is transient and is retried. Reasons are matched as prefixes.
  permanent_reasons: [
    'immutable', 'purged', 'merged into another record', 'conflicts with an existing record', 'not on caseload',
    'not permitted', 'server-owned', 'your role cannot', 'clinical notes not permitted', 'you do not have permission',
    'is missing a required field', 'refers to a record the office server does not have', 'attributed to',
    'would create a cycle', 'parent allocation does not belong', 'its ', 'has a value the office does not accept',
  ],
  // Server-side only, never synchronised: breakglass_events is the office supervisor's review queue for
  // emergency access, and a device has no supervisor to review it.
  // complaints and the privacy incident register are the privacy officer's, kept at the office likewise.
  // fhir_jwt_assertions is the FHIR token endpoint's replay guard for client assertions (office server only).
  server_only: ['breakglass_events', 'complaints', 'privacy_incidents', 'privacy_incident_clients', 'fhir_jwt_assertions'],
  // Kept by each database for itself and never synchronised in either direction: idempotency_keys holds
  // the answers to retried POSTs made against that database (server/idempotency.js). A device's retry is
  // answered by the device; the office never sees the key, only the rows the request created.
  per_database: ['idempotency_keys'],
  // Rows a device may create but never change once they exist (a consent may only be revoked). The legal
  // record of what was agreed to and what was shared cannot be rewritten by whichever phone syncs last.
  immutable: ['consents', 'disclosures', 'note_addenda', 'problem_history'],
  // Columns that reference users(id) somewhere in the schema. A device's local account id is meaningless on the
  // office server (and vice versa), so every one of these has to be remapped on both sides of a sync.
  user_refs: [
    ['clients', 'created_by'], ['assignments', 'user_id'], ['assignments', 'created_by'], ['interventions', 'user_id'],
    ['calls', 'user_id'], ['time_entries', 'user_id'], ['time_entries', 'approved_by'], ['referrals', 'user_id'],
    ['tasks', 'assigned_to'], ['tasks', 'created_by'], ['expenditures', 'user_id'], ['expenditures', 'approved_by'],
    ['episodes', 'opened_by'], ['episodes', 'closed_by'], ['overdose_events', 'reported_by'], ['consents', 'revoked_by'],
    ['notes', 'author_id'], ['notes', 'signed_by'], ['notes', 'cosigned_by'], ['note_addenda', 'author_id'],
    ['consents', 'created_by'], ['disclosures', 'disclosed_by'], ['imports', 'imported_by'],
    ['client_forms', 'created_by'], ['client_forms', 'completed_by'], ['client_form_files', 'uploaded_by'],
    ['resource_photos', 'uploaded_by'], ['form_templates', 'uploaded_by'], ['policy_documents', 'uploaded_by'],
    ['breakglass_events', 'user_id'], ['breakglass_events', 'acknowledged_by'], ['patient_requests', 'handled_by'], ['patient_requests', 'created_by'],
    ['audit_log', 'user_id'], ['sessions', 'user_id'], ['user_prefs', 'user_id'], ['api_keys', 'created_by'], ['users', 'supervisor_id'], ['devices', 'user_id'],
    ['supply_stock', 'updated_by'], ['option_overrides', 'updated_by'],
    ['problems', 'added_by'], ['problems', 'updated_by'], ['problem_history', 'changed_by'], ['care_plan_goals', 'created_by'], ['care_plan_goals', 'updated_by'],
    ['care_plan_steps', 'owner_user_id'], ['care_plan_steps', 'created_by'], ['asam_assessments', 'assessed_by'], ['outcome_measures', 'administered_by'],
    ['caloms_records', 'created_by'], ['caloms_records', 'updated_by'],
    ['court_orders', 'recorded_by'], ['part2_notices', 'given_by'], ['complaints', 'handled_by'], ['complaints', 'created_by'],
    ['privacy_incidents', 'determined_by'], ['privacy_incidents', 'reported_by'],
  ],
};
// Every column name above that points at users(id), for remapping a single pushed row.
module.exports.user_ref_cols = [...new Set(module.exports.user_refs.map(([, c]) => c))];

// ---- row marshalling ----
// These two functions decide exactly what crosses the wire. They lived in both server/routes/sync.js and
// local/sync.js, and had already drifted: one filtered undefined values and stripped lockout columns, the
// other did neither. Two copies of this cannot be allowed to disagree, so there is one.
const crypto = require('./crypto');

/**
 * Decrypt a row for transport. Returns null when a value cannot be read: sending null for a column the
 * receiver requires would fail its insert and, before per-row savepoints, take the whole batch with it.
 * Blob columns are left out — attachments are fetched by id once the rows have landed.
 */
function exportRow(t, r) {
  const o = { ...r };
  for (const c of t.enc) {
    if (!o[c]) continue;
    try { o[c] = crypto.decrypt(o[c]); }
    catch { return null; }
  }
  for (const k of Object.keys(o)) if (k.endsWith('_idx')) delete o[k];
  for (const c of t.blob || []) delete o[c];
  // access_note is an access request's free-text reason: the office's business, not a device's.
  if (t.name === 'users') { delete o.failed_attempts; delete o.locked_until; delete o.access_note; }
  return o;
}

/** Re-encrypt an incoming row with the receiver's own key and recompute its blind indexes. */
function importRow(t, r, existingCols) {
  const o = {};
  for (const [k, v] of Object.entries(r)) if (existingCols.includes(k) && !k.endsWith('_idx') && v !== undefined) o[k] = v;
  for (const c of t.enc) if (o[c] !== undefined && o[c] !== null) o[c] = crypto.encrypt(o[c]);
  if (t.name === 'clients') {
    // Only recompute an index when the plaintext it derives from was actually sent; recomputing from a
    // missing field would replace a working blind index with the hash of an empty string.
    const M = require('./clients-model');
    if (r.last_name_enc !== undefined) { o.last_name_idx = crypto.blindIndex(r.last_name_enc || ''); o.name_prefix_idx = M.namePrefixIndex(r.last_name_enc || ''); o.name_phonetic_idx = M.namePhoneticIndex(r.last_name_enc || ''); }
    if (r.last_name_enc !== undefined || r.first_name_enc !== undefined) o.full_name_idx = crypto.blindIndex((r.last_name_enc || '') + (r.first_name_enc || ''));
    if (r.first_name_enc !== undefined) { o.first_name_idx = crypto.blindIndex(String(r.first_name_enc || '').trim().toLowerCase()); o.first_name_prefix_idx = M.namePrefixIndex(r.first_name_enc || ''); }
    if (r.preferred_name_enc !== undefined) o.preferred_name_idx = M.preferredNameIndex(r.preferred_name_enc || '');
    if (r.dob_enc !== undefined) o.dob_idx = crypto.blindIndex(r.dob_enc || '');
    if (r.phone_enc !== undefined) o.phone_idx = crypto.blindIndex(String(r.phone_enc || '').replace(/\D/g, ''));
  }
  return o;
}

/**
 * Carry a pushed row's pre-migration columns over to where they live now (t.legacy), in place. A value is
 * only moved when the row does not also carry the new column (a current kernel sends that) and is not
 * empty: an old kernel never received the new column, so its null means "I do not have it", and moving
 * it would erase the office's copy of the details on every edit the device makes to anything else.
 * Encrypted targets travel as plaintext like every other _enc value; importRow encrypts them.
 */
function upgradeLegacyRow(t, r) {
  for (const [from, to] of Object.entries(t.legacy || {})) {
    if (!(from in r)) continue;
    if (r[to] === undefined && r[from] !== null && r[from] !== '') r[to] = r[from];
    delete r[from];
  }
  return r;
}

/** Whether a push rejection reason is one a retry can never fix (see permanent_reasons). */
module.exports.isPermanentReason = (reason) => module.exports.permanent_reasons.some(p => String(reason || '').startsWith(p));
module.exports.exportRow = exportRow;
module.exports.importRow = importRow;
module.exports.upgradeLegacyRow = upgradeLegacyRow;
