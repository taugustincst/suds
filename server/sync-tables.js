'use strict';
// Describes what synchronises between a device (local kernel) and the office server.
// enc: encrypted columns (decrypted for transport over TLS, re-encrypted with the receiver's key)
// idx: blind-index columns recomputed by the receiver; clientCol: column used for caseload scoping
module.exports = {
  settings_keys: ['org_name', 'county_name', 'program_contact', 'note_lock_days'],
  tables: [
    { name: 'users', enc: ['mfa_secret_enc'], scope: 'users', cols: null },
    { name: 'resources', enc: [], scope: 'all' },
    { name: 'resource_photos', enc: [], scope: 'all' },
    { name: 'funding_sources', enc: [], scope: 'all' },
    { name: 'budget_lines', enc: [], scope: 'all' },
    { name: 'clients', enc: ['first_name_enc', 'last_name_enc', 'preferred_name_enc', 'dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc'], scope: 'client', clientCol: 'id', idx: true },
    { name: 'assignments', enc: [], scope: 'client', clientCol: 'client_id' },
    { name: 'interventions', enc: [], scope: 'client', clientCol: 'client_id' },
    { name: 'calls', enc: ['contact_name_enc', 'phone_enc', 'summary_enc'], scope: 'client-or-null', clientCol: 'client_id' },
    { name: 'time_entries', enc: [], scope: 'client-or-null', clientCol: 'client_id' },
    { name: 'referrals', enc: [], scope: 'client', clientCol: 'client_id' },
    { name: 'tasks', enc: [], scope: 'client-or-null', clientCol: 'client_id' },
    { name: 'expenditures', enc: [], scope: 'client-or-null', clientCol: 'client_id' },
    { name: 'notes', enc: ['content_enc', 'structured_enc'], scope: 'client', clientCol: 'client_id' },
    { name: 'note_addenda', enc: ['content_enc'], scope: 'via-note' },
    { name: 'consents', enc: [], scope: 'client', clientCol: 'client_id' },
    { name: 'disclosures', enc: [], scope: 'client', clientCol: 'client_id' },
    { name: 'form_templates', enc: [], scope: 'all' },
    { name: 'client_forms', enc: ['values_enc'], scope: 'client', clientCol: 'client_id' },
    { name: 'client_form_files', enc: ['data_enc'], scope: 'client', clientCol: 'client_id' },
  ],
};
