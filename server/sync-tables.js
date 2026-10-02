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
  // default_fund_id: the fund a visit recorded on the device is charged to when the worker has none of their own.
  // default_supply_site_id, supply_*: the site a visit draws from when its worker has none, when an expiry is
  // flagged, and how a returned sharps container is counted (server/supplies.js).
  settings_keys: ['org_name', 'county_name', 'program_contact', 'note_lock_days', 'caloms_enabled', 'caloms_providers', 'caloms_start_date', 'default_fund_id',
    // SUPRT-A's grant and site IDs and reassessment interval: a device pre-fills and schedules the same way.
    'suprt_grant_id', 'suprt_site_id', 'suprt_reassessment_months',
    'default_supply_site_id', 'supply_expiry_warn_days', 'supply_syringes_per_litre',
    // Caseload restriction (1.16.0): with each person's own grants and denies (pull's permission_overrides), a
    // device holds a person the office holds to their caseload to it too (server/auth.js caseloadRestricted).
    'caseload_restriction',
    // Whether new clients and outreach contacts start with a participant code instead of a name (1.21.0): a device's
    // forms start the way its office's do. (A field device's scope and window are the office's alone: server/field-scope.js.)
    'participant_code_default',
    // The programme profile and module switches (server/programme.js): a device shows what its office shows.
    ...require('./programme').SETTING_KEYS],
  tables: [
    // supervisor_id points at another user: a supervisor must land before the people who report to them.
    { name: 'users', enc: ['mfa_secret_enc'], scope: 'users', cols: null, selfParent: 'supervisor_id' },
    { name: 'resources', enc: [], scope: 'all', writePerm: 'resources:write' },
    { name: 'resource_photos', enc: [], scope: 'all', writePerm: 'resources:write', parent: ['resources', 'resource_id'], blob: ['data_b64'] },
    { name: 'policy_documents', enc: [], scope: 'all', writePerm: 'documents:write', blob: ['file_b64'] },
    // Grant structure is budget:manage over REST; a device holding only budget:write must not restructure it by sync.
    // Funds and lines travel to every device (visits and time entries point at them, and a device enforces
    // foreign keys), but their money and grant details only to one whose role holds budget:read (redact).
    { name: 'funding_sources', enc: [], scope: 'all', writePerm: 'budget:manage', redact: { perm: 'budget:read', cols: { total_amount: 0, grant_number: null, restrictions: null, notes: null } } },
    { name: 'budget_lines', enc: [], scope: 'all', writePerm: 'budget:manage', parent: ['funding_sources', 'funding_source_id'], selfParent: 'parent_id', redact: { perm: 'budget:read', cols: { allocated_amount: 0, notes: null } } },
    // merged_into points at another client: the record that was kept must land before its duplicate.
    // participant_code_enc (1.21.0): a client known by an SSP participant code instead of a name; its blind index is
    // recomputed by the receiver (importRow below), in the same domain as a visit's code.
    { name: 'clients', enc: ['first_name_enc', 'last_name_enc', 'preferred_name_enc', 'dob_enc', 'phone_enc', 'alt_phone_enc', 'email_enc', 'address_enc', 'medicaid_id_enc', 'emergency_contact_enc', 'goals_enc', 'flags_enc', 'legal_hold_reason_enc', 'legal_hold_cleared_reason_enc', 'removed_reason_enc', 'contact_preferences_enc', 'participant_code_enc'], legacy: { legal_hold_reason: 'legal_hold_reason_enc', contact_preferences: 'contact_preferences_enc' }, scope: 'client', clientCol: 'id', idx: true, writePerm: 'clients:write', selfParent: 'merged_into' },
    { name: 'assignments', enc: ['notes_enc'], legacy: { notes: 'notes_enc' }, scope: 'client', clientCol: 'client_id', writePerm: 'assignments:manage', parent: ['clients', 'client_id'] },
    { name: 'episodes', enc: ['presenting_problem_enc', 'discharge_summary_enc', 'reopen_reason_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'episodes:write', parent: ['clients', 'client_id'] },
    // CalOMS Tx records hang off an episode: the episode must land first.
    { name: 'caloms_records', enc: ['answers_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'episodes:write', parent: ['episodes', 'episode_id'] },
    // unlinked: a row with no client is outside caseload scoping, so it is its owners' (these columns) or a
    // holder of `all`'s -- over REST (crud.js) and by sync alike. Their free text (a caller's name and number,
    // an outreach summary, a bystander's overdose) can name someone.
    // participant_code_enc: an anonymous contact's SSP participant code (server/participant-code.js); its blind
    // index is recomputed by the receiver (importRow below), like a client's name indexes.
    { name: 'interventions', enc: ['summary_enc', 'participant_code_enc'], scope: 'client-or-null', clientCol: 'client_id', unlinked: { owners: ['user_id'], all: 'clients:all' }, writePerm: 'interventions:write', parent: ['clients', 'client_id'] },
    { name: 'overdose_events', enc: ['notes_enc', 'substances_enc'], scope: 'client-or-null', clientCol: 'client_id', unlinked: { owners: ['reported_by'], all: 'clients:all' }, writePerm: 'overdose:write', parent: ['clients', 'client_id'] },
    // Group and community prevention events (server/prevention.js): the programme's, with no client, so every
    // device of someone who may read visits gets them (attendance is a headcount; nothing names a person). Written
    // as visits are (interventions:write), each its worker's or a manager's to change (server/rules/prevention_events.js).
    { name: 'prevention_events', enc: ['notes_enc'], scope: 'all', writePerm: 'interventions:write', readPerm: 'interventions:read' },
    { name: 'calls', enc: ['contact_name_enc', 'phone_enc', 'summary_enc', 'purpose_enc'], scope: 'client-or-null', clientCol: 'client_id', unlinked: { owners: ['user_id'], all: 'clients:all' }, writePerm: 'calls:write', parent: ['clients', 'client_id'] },
    { name: 'time_entries', enc: ['description_enc', 'approval_note_enc'], legacy: { description: 'description_enc', approval_note: 'approval_note_enc' }, scope: 'client-or-null', clientCol: 'client_id', unlinked: { owners: ['user_id'], all: 'time:all' }, writePerm: 'time:write', parent: ['clients', 'client_id'] },
    // A referral may cite the consent it was made under, so consents come first.
    { name: 'consents', enc: ['recipient_enc', 'purpose_enc', 'scope_enc', 'signer_name_enc', 'revoked_reason_enc', 'witness_enc', 'document_ref_enc'], legacy: { revoked_reason: 'revoked_reason_enc', witness: 'witness_enc', document_ref: 'document_ref_enc' }, scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    // A disclosure made under a subpart E court order cites it, so orders travel before disclosures.
    { name: 'court_orders', enc: ['court_enc', 'case_ref_enc', 'recipient_enc', 'purpose_enc', 'scope_enc', 'vacated_reason_enc', 'document_ref_enc'], legacy: { vacated_reason: 'vacated_reason_enc', document_ref: 'document_ref_enc' }, scope: 'client', clientCol: 'client_id', writePerm: 'court-orders:write', parent: ['clients', 'client_id'] },
    { name: 'part2_notices', enc: ['notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    { name: 'referrals', enc: ['outcome_enc', 'barrier_enc', 'notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'referrals:write', parent: ['clients', 'client_id'] },
    // Migration 42 moved client_form_files.filename, imports.filename and consents.document_ref likewise.
    // Migration 39 moved consents.witness and import_items.metadata into witness_enc and metadata_enc.
  // Migration 37 moved the free text on assignments, time entries, consents (revocation), expenditures, notes
    // (countersignature), addenda, client forms and clients (contact preferences) into _enc columns likewise.
    // Migration 24 moved tasks.description into description_enc; kernels before 1.9.3 still push `description`.
    { name: 'tasks', enc: ['title_enc', 'description_enc'], legacy: { description: 'description_enc' }, scope: 'client-or-null', clientCol: 'client_id', unlinked: { owners: ['assigned_to', 'created_by'], all: 'clients:all' }, writePerm: 'tasks:write', parent: ['clients', 'client_id'] },
    { name: 'expenditures', enc: ['description_enc', 'approval_note_enc'], legacy: { description: 'description_enc', approval_note: 'approval_note_enc' }, scope: 'client-or-null', clientCol: 'client_id', unlinked: { owners: ['user_id'], all: 'budget:approve' }, writePerm: 'budget:write', readPerm: 'budget:read', parent: ['clients', 'client_id'] },
    { name: 'notes', enc: ['content_enc', 'structured_enc', 'title_enc', 'cosign_note_enc'], legacy: { cosign_note: 'cosign_note_enc' }, scope: 'client', clientCol: 'client_id', writePerm: 'notes:admin:write', parent: ['clients', 'client_id'] },
    { name: 'note_addenda', enc: ['content_enc', 'reason_enc'], legacy: { reason: 'reason_enc' }, scope: 'via-note', writePerm: 'notes:admin:write', parent: ['notes', 'note_id'] },
    { name: 'disclosures', enc: ['recipient_enc', 'purpose_enc', 'what_enc', 'justification_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'consents:write', parent: ['clients', 'client_id'] },
    // An import (a OneNote page, a Pocket AI transcript) is its importer's until it is filed against a client:
    // the REST routes show it only to them (or to records:manage-others), and a device gets the same -- scope 'importer'.
    { name: 'imports', enc: ['filename_enc'], legacy: { filename: 'filename_enc' }, scope: 'importer', writePerm: 'imports:write' },
    { name: 'import_items', enc: ['content_enc', 'title_enc', 'metadata_enc'], legacy: { metadata: 'metadata_enc' }, scope: 'via-import', writePerm: 'imports:write', parent: ['imports', 'import_id'] },
    { name: 'form_templates', enc: [], scope: 'all', writePerm: 'forms:manage', blob: ['file_b64'] },
    { name: 'client_forms', enc: ['values_enc', 'notes_enc'], legacy: { notes: 'notes_enc' }, scope: 'client', clientCol: 'client_id', writePerm: 'forms:write', parent: ['clients', 'client_id'] },
    { name: 'client_form_files', enc: ['data_enc', 'filename_enc'], legacy: { filename: 'filename_enc' }, scope: 'client', clientCol: 'client_id', writePerm: 'forms:write', parent: ['client_forms', 'client_form_id'], blob: ['data_enc'] },
    // Patient-rights requests are patient-requests:write over REST (1.13.0 said consents:write here; every role held both).
    { name: 'patient_requests', enc: ['notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'patient-requests:write', parent: ['clients', 'client_id'] },
    // Clinical documentation (CalAIM): the problem list and its history, the care plan, ASAM assessments and
    // outcome measures. readPerm: a device whose role cannot read them (an ASAM rating on a navigator's
    // phone) is never sent them, the same minimum-necessary rule clinical notes follow.
    { name: 'problems', enc: ['problem_enc', 'icd10_code_enc', 'icd10_description_enc', 'z_codes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['clients', 'client_id'] },
    { name: 'problem_history', enc: ['changes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['problems', 'problem_id'] },
    { name: 'care_plan_goals', enc: ['goal_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['clients', 'client_id'] },
    { name: 'care_plan_steps', enc: ['step_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'careplan:write', readPerm: 'careplan:read', parent: ['care_plan_goals', 'goal_id'] },
    { name: 'asam_assessments', enc: ['dimension_notes_enc', 'discrepancy_notes_enc', 'summary_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'assessments:write', readPerm: 'assessments:read', parent: ['clients', 'client_id'] },
    { name: 'outcome_measures', enc: ['responses_enc', 'notes_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'assessments:write', readPerm: 'assessments:read', parent: ['clients', 'client_id'] },
    // SUPRT-A records (server/suprt.js): recorded on a visit, offline too, by whoever works with the client.
    { name: 'suprt_assessments', enc: ['answers_enc'], scope: 'client', clientCol: 'client_id', writePerm: 'clients:write', parent: ['clients', 'client_id'] },
    // Supplies (docs/SUPPLIES.md). Items and sites are the office's, pull-only like Settings → Lists: a device
    // offers the same items and sites offline and cannot change them (server/routes/supplies.js refuses it in
    // the local kernel). A visit's items travel with the visit and are checked like it (server/supplies.js
    // linePushProblem). The stock ledger is append-only: a device may add stock received, moved, adjusted or
    // disposed of (checked by ledgerPushProblem, and a lot taken below zero is recorded as a flagged shortfall
    // by settlePushedEntry), never change a row; a visit's draw-down is the office's to work out from the
    // visit (settlePushedVisit), so a device keeps its own only until the office's arrives (local/sync.js).
    { name: 'supply_sites', enc: [], scope: 'all', writePerm: 'supplies:manage', serverOwned: true },
    { name: 'supply_items', enc: [], scope: 'all', writePerm: 'supplies:manage', serverOwned: true },
    { name: 'intervention_supplies', enc: [], scope: 'client-or-null', clientCol: 'client_id', unlinked: { owners: ['user_id'], all: 'clients:all' }, writePerm: 'interventions:write', parent: ['interventions', 'intervention_id'] },
    { name: 'supply_ledger', enc: [], scope: 'all', writePerm: 'supplies:receive', readPerm: 'supplies:read' },
    // Settings → Lists (the wording and order of documentation choices): the office's configuration,
    // pull-only like supply items and sites. A device needs it to offer the same choices and show the same labels
    // offline; it can never change it (server/routes/options.js refuses writes in the local kernel).
    { name: 'option_overrides', enc: [], scope: 'all', writePerm: 'settings:manage', serverOwned: true },
    // The QSOA / research / audit register the non-consent disclosure bases rest on (server/disclosure.js):
    // the office's, pull-only, so a device can offer the same agreements on its disclosure form offline.
    // Migration 43 moved its document_ref (and court_orders') into document_ref_enc.
    { name: 'disclosure_agreements', enc: ['document_ref_enc'], legacy: { document_ref: 'document_ref_enc' }, scope: 'all', writePerm: 'agreements:write', serverOwned: true },
  ],
  // Push rejection reasons that will never succeed on a retry: the office has ruled, and the device must
  // mark the row as exchanged (office wins) rather than resend it every sync forever. Anything else
  // (network, a 5xx, an unknown SQL error) is transient and is retried. Reasons are matched as prefixes.
  permanent_reasons: [
    'immutable', 'purged', 'merged into another record', 'conflicts with an existing record', 'not on caseload',
    'not permitted', 'server-owned', 'your role cannot', 'clinical notes not permitted', 'you do not have permission',
    'is missing a required field', 'refers to a record the office server does not have', 'attributed to',
    'would create a cycle', 'parent allocation does not belong', 'its ', 'has a value the office does not accept',
    'needs a lawful basis for disclosure', 'drawn down at the office',
    // A field device writing outside its scope (server/field-scope.js, server/rules/push.js fieldRefusal).
    'outside this field device',
  ],
  // Server-side only, never synchronised: breakglass_events is the office supervisor's review queue for
  // emergency access, and a device has no supervisor to review it.
  // complaints and the privacy incident register are the privacy officer's, kept at the office likewise.
  // fhir_jwt_assertions is the FHIR token endpoint's replay guard for client assertions (office server only).
  // caloms_submissions holds each CalOMS Tx file as produced for DHCS, which only the office sends, and
  // caloms_submission_events its log. referral_links are served to outside organisations by the office only
  // (a device has no address a recipient could reach, and the tokens must live in one place to be single-use).
  // client_revisions (1.17.0) holds every earlier value of a client's record (changes_enc): minimum necessary, it
  // stays at the office. A device's own edits are recorded there when its push lands (server/rules/clients.js
  // afterApply, via 'sync'); a device that syncs with an office keeps none and says the history is at the office
  // (server/client-revisions.js keptHere). SUDS on this device, with no office, keeps its own.
  // ai_usage counts the AI copilot's calls for the programme's monthly cap (server/ai-copilot.js); a device has no copilot.
  // county_* (the county view, docs/COUNTY-VIEW.md): the office's own county signing key, and on a county's server
  // the programmes it accepts submissions from and the submissions it imported. A device makes and imports none.
  server_only: ['breakglass_events', 'complaints', 'privacy_incidents', 'privacy_incident_clients', 'fhir_jwt_assertions', 'caloms_submissions', 'client_revisions', 'ai_usage', 'caloms_submission_events', 'referral_links',
    'county_signing_keys', 'county_programmes', 'county_programme_keys', 'county_submissions',
    // county_publications (released in 1.21.0): the county's published releases and their withdrawals.
    'county_publications',
    // county_publication_consents and county_publication_inputs (released in 1.22.0): each programme's written consent
    // to publication, and what each release was screened from. On the county's server only.
    'county_publication_consents', 'county_publication_inputs',
    // county_connect_* and county_connection (the county connection, docs/COUNTY-VIEW.md "Connecting"): the machine
    // tokens a county issues, and on a programme's server the county it sends to and its send log. A device has none.
    'county_connect_tokens', 'county_connection', 'county_connect_sends',
    // passkeys, webauthn_challenges and signature_evidence (fingerprint sign-in and signing, docs/FINGERPRINT.md): a
    // passkey is made for the office server's host and answers only there; SUDS on a device does not offer it.
    'passkeys', 'webauthn_challenges', 'signature_evidence',
    // authenticator_metadata (the authenticator allow-list, docs/FINGERPRINT.md): what the office keeps of the FIDO
    // Metadata Service file its administrator uploaded. Public data about authenticator models; a device has no passkeys.
    'authenticator_metadata',
    // incoming_referrals and incoming_referral_attempts (1.24.0, server/incoming-referrals.js): the intake queue of people
    // referred to the programme who are not clients yet. It is the office's: a field device never holds the names of
    // people nobody has met, and a device that syncs with an office refuses the routes (the office keeps the queue);
    // SUDS on this device, with no office, keeps its own. An accepted referral's client travels as every client does.
    'incoming_referrals', 'incoming_referral_attempts'],
  // The encrypted columns of the tables that never synchronise (server_only above, per_database below), declared
  // like a synchronised table's: key rotation finds every _enc column by itself, and test/sync.test.js checks this
  // list against the schema, so a table with PHI is always either synchronised or deliberately kept apart.
  unsynced_enc: {
    breakglass_events: ['reason_enc'], complaints: ['summary_enc', 'resolution_enc'],
    privacy_incidents: ['title_enc', 'description_enc', 'risk_nature_enc', 'risk_recipient_enc', 'risk_acquired_enc', 'risk_mitigation_enc', 'determination_reason_enc'],
    privacy_incident_clients: ['client_name_enc'], fhir_jwt_assertions: [], caloms_submissions: ['file_enc'], client_revisions: ['changes_enc'], ai_usage: [],
    caloms_submission_events: [], referral_links: ['packet_enc', 'ack_by_enc', 'ack_note_enc'],
    county_signing_keys: ['private_key_enc'], county_programmes: [], county_programme_keys: [], county_submissions: ['payload_enc', 'source_ref_enc'], county_publications: ['reason_enc'],
    county_publication_consents: ['reference_enc'], county_publication_inputs: ['inputs_enc'],
    county_connect_tokens: [], county_connection: ['token_enc'], county_connect_sends: [],
    passkeys: [], webauthn_challenges: [], signature_evidence: ['evidence_enc'], authenticator_metadata: [],
    incoming_referrals: ['referrer_name_enc', 'referrer_phone_enc', 'referrer_email_enc', 'reason_enc', 'first_name_enc', 'last_name_enc', 'dob_enc', 'phone_enc', 'notes_enc', 'outcome_reason_enc'],
    incoming_referral_attempts: ['notes_enc'],
    idempotency_keys: ['response_enc'],
  },
  // Kept by each database for itself and never synchronised in either direction: idempotency_keys holds
  // the answers to retried POSTs made against that database (server/idempotency.js). A device's retry is
  // answered by the device; the office never sees the key, only the rows the request created.
  per_database: ['idempotency_keys'],
  // Rows a device may create but never change once they exist (a consent may only be revoked). The legal
  // record of what was agreed to and what was shared cannot be rewritten by whichever phone syncs last.
  // The stock ledger likewise: on hand is its sum, and a correction is another row (docs/SUPPLIES.md).
  immutable: ['consents', 'disclosures', 'note_addenda', 'problem_history', 'supply_ledger'],
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
    ['audit_log', 'user_id'], ['sessions', 'user_id'], ['user_prefs', 'user_id'], ['api_keys', 'created_by'], ['users', 'supervisor_id'], ['devices', 'user_id'], ['field_accounts', 'user_id'],
    ['supply_sites', 'updated_by'], ['supply_items', 'updated_by'], ['intervention_supplies', 'user_id'], ['supply_ledger', 'user_id'], ['option_overrides', 'updated_by'],
    ['problems', 'added_by'], ['problems', 'updated_by'], ['problem_history', 'changed_by'], ['care_plan_goals', 'created_by'], ['care_plan_goals', 'updated_by'],
    ['care_plan_steps', 'owner_user_id'], ['care_plan_steps', 'created_by'], ['asam_assessments', 'assessed_by'], ['outcome_measures', 'administered_by'],
    ['caloms_records', 'created_by'], ['caloms_records', 'updated_by'], ['suprt_assessments', 'created_by'], ['suprt_assessments', 'updated_by'],
    ['court_orders', 'recorded_by'], ['part2_notices', 'given_by'], ['complaints', 'handled_by'], ['complaints', 'created_by'],
    ['privacy_incidents', 'determined_by'], ['privacy_incidents', 'reported_by'], ['disclosure_agreements', 'created_by'], ['caloms_submissions', 'created_by'], ['ai_usage', 'user_id'],
    ['user_permission_overrides', 'user_id'], ['user_permission_overrides', 'granted_by'], ['client_revisions', 'changed_by'], ['prevention_events', 'user_id'],
    ['caloms_submissions', 'uploaded_by'], ['caloms_submission_events', 'user_id'], ['referral_links', 'created_by'], ['referral_links', 'revoked_by'],
    ['county_signing_keys', 'created_by'], ['county_signing_keys', 'retired_by'], ['county_programmes', 'created_by'], ['county_programme_keys', 'added_by'], ['county_programme_keys', 'replaced_by'],
    ['county_programme_keys', 'compromised_by'], ['county_submissions', 'received_by'], ['county_submissions', 'withdrawn_by'], ['county_publications', 'created_by'],
    ['county_publication_consents', 'recorded_by'], ['county_publication_consents', 'withdrawn_by'],
    ['county_connect_tokens', 'created_by'], ['county_connect_tokens', 'revoked_by'], ['county_connection', 'updated_by'], ['county_connect_sends', 'sent_by'],
    ['passkeys', 'user_id'], ['signature_evidence', 'user_id'], ['webauthn_challenges', 'user_id'],
    ['incoming_referrals', 'assigned_to'], ['incoming_referrals', 'closed_by'], ['incoming_referrals', 'created_by'], ['incoming_referral_attempts', 'user_id'],
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
  // access_note is an access request's free-text reason: the office's business, not a device's. The
  // lockout counters and the last authenticator time-step are the office's own sign-in state.
  if (t.name === 'users') { delete o.failed_attempts; delete o.locked_until; delete o.access_note; delete o.totp_last_step; }
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
    if (r.participant_code_enc !== undefined) o.participant_code_idx = require('./participant-code').index(r.participant_code_enc);
  }
  // An anonymous contact's SSP participant code is counted by its blind index, under the receiver's own key.
  if (t.name === 'interventions' && r.participant_code_enc !== undefined) o.participant_code_idx = require('./rules/interventions').participantCode(r.participant_code_enc).idx;
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

/**
 * Remove a client, and every row that hangs off it, from a device's database -- the office took the client off
 * this person's caseload (server/routes/sync.js pull, dropped_clients). `d` is a { run, all, one } database.
 * It is not a deletion: no tombstone is written, so nothing is echoed back to the office, and sync_seen is
 * cleared so a later reassignment brings the client back whole. Children are removed explicitly rather than
 * left to ON DELETE SET NULL, which would keep a call's summary or a task on the phone with no client.
 * Shared with local/sync.js so the kernel and its test cannot drift. Returns the number of rows removed.
 */
function purgeClient(d, clientId, depth = 0) {
  let n = 0;
  const has = (t) => !!d.one(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`, t);
  const seenTable = has('sync_seen');
  const drop = (table, id) => {
    const r = d.run(`DELETE FROM ${table} WHERE id=?`, id); n += Number((r && r.changes) || 0);
    if (seenTable) d.run(`DELETE FROM sync_seen WHERE table_name=? AND id=?`, table, id);
  };
  // A duplicate merged into this client travelled only because this client was on the caseload.
  if (depth < 25) for (const m of d.all(`SELECT id FROM clients WHERE merged_into=?`, clientId)) n += purgeClient(d, m.id, depth + 1);
  // Reverse table order is child-before-parent (the array is in foreign-key order).
  for (const t of [...module.exports.tables].reverse()) {
    if (!has(t.name)) continue;
    if (t.scope === 'via-note') { for (const r of d.all(`SELECT id FROM ${t.name} WHERE note_id IN (SELECT id FROM notes WHERE client_id=?)`, clientId)) drop(t.name, r.id); continue; }
    if (!t.clientCol || t.name === 'clients') continue;
    for (const r of d.all(`SELECT id FROM ${t.name} WHERE ${t.clientCol}=?`, clientId)) drop(t.name, r.id);
  }
  drop('clients', clientId);
  return n;
}

/**
 * The rows of a client-or-null table (calls, visits, overdose events, to-dos, time, expenditures) a user may
 * see, as SQL on `alias`: a row with a client when `cf` (the caller's auth.caseloadFilter on that client)
 * admits it; a row with no client only when the user owns it (the table's `unlinked.owners`) or holds its
 * `unlinked.all`. One rule for REST (crud.js reads `unlinked` from here), devices (routes/sync.js pull; server/rules/push.js through
 * mayReachUnlinked below) and
 * exports (exports.js), so none can show what another refuses. `hasPerm` is auth.hasPerm, passed in so this
 * file stays free of the auth module (the browser kernel loads it too).
 */
function clientOrNullScope(tableName, user, alias, cf, hasPerm) {
  const t = module.exports.tables.find(x => x.name === tableName);
  if (!t) throw new Error(`clientOrNullScope: ${tableName} is not a synchronised table`);
  const col = `${alias}.${t.clientCol || 'client_id'}`;
  const u = t.unlinked && !hasPerm(user, t.unlinked.all) ? t.unlinked : null;
  if (!u) return { sql: `(${col} IS NULL OR ${cf.sql})`, params: [...cf.params] };
  const own = u.owners.map(c => `${alias}.${c}=?`).join(' OR ');
  return { sql: `((${col} IS NULL AND (${own})) OR (${col} IS NOT NULL AND ${cf.sql}))`, params: [...u.owners.map(() => user.id), ...cf.params] };
}
module.exports.clientOrNullScope = clientOrNullScope;
/**
 * The same owner rule for one stored row (clientOrNullScope is its SQL form): may `user` reach this row of a
 * client-or-null table? A row with a client is caseload scoping's to decide, so this answers only for a row with
 * none: its owners' (`unlinked.owners`), or a holder of `unlinked.all`'s. sync push (server/rules/push.js) asks it
 * before a device changes or deletes such a row.
 */
function mayReachUnlinked(tableName, user, row, hasPerm) {
  const t = module.exports.tables.find(x => x.name === tableName);
  if (!t || !t.unlinked || row[t.clientCol || 'client_id']) return true;
  return hasPerm(user, t.unlinked.all) || t.unlinked.owners.some(c => row[c] === user.id);
}
module.exports.mayReachUnlinked = mayReachUnlinked;

/** Whether a push rejection reason is one a retry can never fix (see permanent_reasons). */
module.exports.isPermanentReason = (reason) => module.exports.permanent_reasons.some(p => String(reason || '').startsWith(p));
module.exports.exportRow = exportRow;
module.exports.importRow = importRow;
module.exports.upgradeLegacyRow = upgradeLegacyRow;
module.exports.purgeClient = purgeClient;
