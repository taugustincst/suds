'use strict';
// Describes what synchronises between a device (local kernel) and the office server.
// enc: encrypted columns (decrypted for transport over TLS, re-encrypted with the receiver's key)
// idx: blind-index columns recomputed by the receiver; clientCol: column used for caseload scoping
// writePerm: the permission a device must hold for its pushed rows to be accepted (mirrors the REST routes,
//   so syncing can never be a way around a role's limits); parent: the table a row's foreign key points at,
//   so a child is skipped when its parent was rejected rather than blowing up on a constraint.
// NOTE: the order of this array is a foreign-key ordering — a table must appear after everything it references.
// blob: columns too large to belong in a sync payload; they are fetched by id on demand instead.
module.exports = {
  settings_keys: ['org_name', 'county_name', 'program_contact', 'note_lock_days'],
  tables: [
    { name: 'users', enc: ['mfa_secret_enc'], scope: 'users', cols: null },
    { name: 'resources', enc: [], scope: 'all', writePerm: 'resources:write' },
    { name: 'resource_photos', enc: [], scope: 'all', writePerm: 'resources:write', parent: ['resources', 'resource_id'], blob: ['data_b64'] },
    { name: 'funding_sources', enc: [], scope: 'all', writePerm: 'budget:write' },
    { name: 'budget_lines', enc: [], scope: 'all', writePerm: 'budget:write', parent: ['funding_sources', 'funding_source_id'] },
    { name: 'clients', enc: ['first_name_enc', 'last_name_enc', 'preferred_name_enc', 'dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc', 'goals_enc', 'flags_enc'], scope: 'client', clientCol: 'id', idx: true, writePerm: 'clients:write' },
    { name: 'assignments', enc: [], scope: 'client', clientCol: 'client_id', writePerm: 'assignments:manage', parent: ['clients', 'client_id'] },
    { name: 'episodes', enc: ['presenting_problem_enc', 'discharge_summary_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'episodes:write', parent: ['clients', 'client_id'] },
    { name: 'interventions', enc: ['summary_enc'], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'interventions:write', parent: ['clients', 'client_id'] },
    { name: 'overdose_events', enc: ['notes_enc'], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'overdose:write', parent: ['clients', 'client_id'] },
    { name: 'calls', enc: ['contact_name_enc', 'phone_enc', 'summary_enc'], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'calls:write', parent: ['clients', 'client_id'] },
    { name: 'time_entries', enc: [], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'time:write', parent: ['clients', 'client_id'] },
    { name: 'referrals', enc: [], scope: 'client', clientCol: 'client_id', writePerm: 'referrals:write', parent: ['clients', 'client_id'] },
    { name: 'tasks', enc: [], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'tasks:write', parent: ['clients', 'client_id'] },
    { name: 'expenditures', enc: [], scope: 'client-or-null', clientCol: 'client_id', writePerm: 'budget:write', parent: ['clients', 'client_id'] },
    { name: 'notes', enc: ['content_enc', 'structured_enc', 'title_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'notes:admin:write', parent: ['clients', 'client_id'] },
    { name: 'note_addenda', enc: ['content_enc'], scope: 'via-note', writePerm: 'notes:admin:write', parent: ['notes', 'note_id'] },
    { name: 'consents', enc: ['recipient_enc', 'purpose_enc', 'scope_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    { name: 'disclosures', enc: ['recipient_enc', 'purpose_enc', 'what_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    { name: 'imports', enc: [], scope: 'all', writePerm: 'imports:write' },
    { name: 'import_items', enc: ['content_enc', 'title_enc'], scope: 'all', writePerm: 'imports:write', parent: ['imports', 'import_id'] },
    { name: 'form_templates', enc: [], scope: 'all', writePerm: 'forms:manage', blob: ['file_b64'] },
    { name: 'client_forms', enc: ['values_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'forms:write', parent: ['clients', 'client_id'] },
    { name: 'client_form_files', enc: ['data_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'forms:write', parent: ['client_forms', 'client_form_id'], blob: ['data_enc'] },
  ],
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
    ['resource_photos', 'uploaded_by'], ['form_templates', 'uploaded_by'],
    ['audit_log', 'user_id'], ['sessions', 'user_id'], ['user_prefs', 'user_id'], ['api_keys', 'created_by'], ['users', 'supervisor_id'], ['devices', 'user_id'],
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
  if (t.name === 'users') { delete o.failed_attempts; delete o.locked_until; }
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
    if (r.dob_enc !== undefined) o.dob_idx = crypto.blindIndex(r.dob_enc || '');
    if (r.phone_enc !== undefined) o.phone_idx = crypto.blindIndex(String(r.phone_enc || '').replace(/\D/g, ''));
  }
  return o;
}

module.exports.exportRow = exportRow;
module.exports.importRow = importRow;
