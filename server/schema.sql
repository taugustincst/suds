-- SUDS schema. Fields suffixed _enc hold AES-256-GCM ciphertext (see server/crypto.js).
-- Fields suffixed _idx hold HMAC blind indexes used for equality search without decrypting.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  title TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor','clinician','navigator','finance','readonly')),
  is_active INTEGER NOT NULL DEFAULT 1,
  mfa_secret_enc TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT,
  last_login_at TEXT,
  hourly_cost REAL,
  -- Supervision: an unlicensed or trainee worker's notes need a supervisor's countersignature to stand as
  -- a billable clinical record. author_id is never reassigned, so both names appear on the note.
  requires_cosign INTEGER NOT NULL DEFAULT 0,
  supervisor_id TEXT REFERENCES users(id),
  -- Set by an administrator (Users → edit) to link this account to a single sign-on identity, never by the
  -- login itself: OIDC signs a user in only once this is already set, it never creates or promotes an
  -- account on its own. The 'sub' claim from the county's identity provider, matched against config.oidc's
  -- single configured issuer — not itself an issuer/subject pair, since this server only ever trusts one IdP.
  oidc_subject TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_subject ON users(oidc_subject) WHERE oidc_subject IS NOT NULL;

-- One row per physical phone/tablet running local mode, identified by a UUID the device itself generates
-- once and sends on every sync call (never by the short-lived sync session, which starts and ends within a
-- single sync run). "Wipe" here means the closest thing an offline-first app can offer to a real MDM remote
-- wipe: the *next time this specific device attempts to sync*, it is told to erase its local database and
-- its access is revoked in the same moment (server/auth.js login()). A device that is never opened again
-- cannot be reached this way — that limitation is inherent to working offline, not a bug.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_ip TEXT,
  sync_count INTEGER NOT NULL DEFAULT 0,
  wipe_requested_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the bearer token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  mfa_pending INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'intake',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  client_code TEXT NOT NULL UNIQUE,    -- non-PHI identifier for reports / de-identified views
  first_name_enc TEXT NOT NULL,
  last_name_enc TEXT NOT NULL,
  last_name_idx TEXT,
  full_name_idx TEXT,
  -- Coarse blind indexes that make search tolerant of typos and partial names without storing any name in
  -- the clear: the first three letters of the surname, and its Soundex code, each HMAC'd with the index
  -- key. They are lower entropy than the exact indexes, but anyone holding the index key can already test
  -- a specific name against those, and both live in the same database as the ciphertext.
  name_prefix_idx TEXT,
  name_phonetic_idx TEXT,
  first_name_idx TEXT,
  first_name_prefix_idx TEXT,
  preferred_name_enc TEXT,
  preferred_name_idx TEXT,             -- blind index of the preferred name / alias, so "Jay" finds Jamie
  dob_enc TEXT,
  dob_idx TEXT,
  phone_enc TEXT,
  phone_idx TEXT,
  alt_phone_enc TEXT,
  email_enc TEXT,
  address_enc TEXT,
  city TEXT,
  zip TEXT,
  gender TEXT,
  pronouns TEXT,
  race_ethnicity TEXT,
  race_codes TEXT,                     -- comma separated CalOMS/OMB race codes (reportable; race_ethnicity stays for free text)
  preferred_language TEXT DEFAULT 'English',
  veteran INTEGER DEFAULT 0,
  housing_status TEXT,
  insurance TEXT,
  medicaid_id_enc TEXT,
  emergency_contact_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('waitlist','active','inactive','closed','deceased')),
  intake_date TEXT,
  discharge_date TEXT,
  discharge_reason TEXT,
  referral_source TEXT,
  referral_date TEXT,                  -- when this person was referred in, distinct from intake_date (when services actually started)
  engagement_date TEXT,                -- when they first actually engaged with services; time-to-engagement = engagement_date - referral_date
  primary_substance TEXT,
  secondary_substances TEXT,
  route_of_use TEXT,
  asam_level TEXT,
  mat_status TEXT,                     -- none, interested, referred, active, discontinued
  mat_medication TEXT,
  overdose_history INTEGER DEFAULT 0,
  last_overdose_date TEXT,
  naloxone_provided INTEGER DEFAULT 0,
  naloxone_last_date TEXT,
  risk_level TEXT DEFAULT 'moderate',
  justice_involved INTEGER DEFAULT 0,
  pregnant_or_parenting INTEGER DEFAULT 0,
  co_occurring_mh INTEGER DEFAULT 0,
  goals_enc TEXT,
  flags_enc TEXT,                      -- comma separated safety flags, encrypted
  contact_preferences TEXT,
  ok_to_text INTEGER DEFAULT 0,
  ok_to_voicemail INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  -- Set when this record was merged into another as a duplicate; the row is kept so old references and the
  -- audit trail still resolve, but it no longer appears anywhere staff work.
  merged_into TEXT REFERENCES clients(id),
  -- A legal hold (litigation, investigation, a patient's own request) exempts the record from the retention
  -- purge in server/retention.js and from deletion until an administrator clears it.
  legal_hold INTEGER NOT NULL DEFAULT 0,
  legal_hold_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_last_name ON clients(last_name_idx);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone_idx);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role_on_case TEXT NOT NULL DEFAULT 'primary' CHECK (role_on_case IN ('primary','secondary','clinician','peer','supervisor')),
  start_date TEXT NOT NULL,
  end_date TEXT,
  -- Set only when somebody ends the assignment there and then (a supervisor taking a worker off a case).
  -- Access stops at this instant; a plain end_date runs out at the end of that day instead.
  ended_at TEXT,
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_assignments_updated ON assignments(updated_at);
CREATE INDEX IF NOT EXISTS idx_assign_client ON assignments(client_id);
CREATE INDEX IF NOT EXISTS idx_assign_user ON assignments(user_id);

CREATE TABLE IF NOT EXISTS funding_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'other',
  grant_number TEXT,
  fiscal_year_start TEXT NOT NULL,
  fiscal_year_end TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  restrictions TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id TEXT PRIMARY KEY,
  funding_source_id TEXT NOT NULL REFERENCES funding_sources(id) ON DELETE CASCADE,
  -- A budget line can sit inside a larger one (a grant broken into program-level allocations broken into
  -- line items) instead of every line being a flat peer under the fund. Always within the same fund; the
  -- application enforces that plus cycle-safety, since SQLite has no way to express either as a constraint.
  parent_id TEXT REFERENCES budget_lines(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  label TEXT,
  allocated_amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_budget_lines_updated ON budget_lines(updated_at);
CREATE INDEX IF NOT EXISTS idx_budget_lines_parent ON budget_lines(parent_id);

CREATE TABLE IF NOT EXISTS interventions (
  id TEXT PRIMARY KEY,
  -- nullable: community naloxone distribution and street outreach are real services with no identified client
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  location TEXT DEFAULT 'office',
  modality TEXT DEFAULT 'in_person',
  outcome TEXT,
  stage_of_change TEXT,
  naloxone_kits INTEGER DEFAULT 0,
  fentanyl_strips INTEGER DEFAULT 0,
  funding_source_id TEXT REFERENCES funding_sources(id),
  -- Which allocation the cost below actually draws down. Nullable: a worker can log a direct cost against
  -- just the fund with no specific line, the same as expenditures.budget_line_id already allows.
  budget_line_id TEXT REFERENCES budget_lines(id) ON DELETE SET NULL,
  cost REAL DEFAULT 0,
  summary_enc TEXT,
  follow_up_due TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_interventions_client ON interventions(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_interventions_user ON interventions(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_interventions_occurred ON interventions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_interventions_updated ON interventions(updated_at);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  -- A phone call or a text message. Both are contacts with the same shape; only the wording,
  -- the outcomes and whether minutes are worth recording differ.
  method TEXT NOT NULL DEFAULT 'phone' CHECK (method IN ('phone','text')),
  started_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  contact_type TEXT NOT NULL DEFAULT 'client',
  contact_name_enc TEXT,
  phone_enc TEXT,
  purpose_enc TEXT,                    -- why the call was made names the client's situation; encrypted
  outcome TEXT NOT NULL DEFAULT 'reached',
  crisis INTEGER NOT NULL DEFAULT 0,
  follow_up_needed INTEGER NOT NULL DEFAULT 0,
  follow_up_due TEXT,
  summary_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_client ON calls(client_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at);
CREATE INDEX IF NOT EXISTS idx_calls_updated ON calls(updated_at);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  work_date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'direct_service',
  billable INTEGER NOT NULL DEFAULT 0,
  funding_source_id TEXT REFERENCES funding_sources(id),
  intervention_id TEXT REFERENCES interventions(id) ON DELETE SET NULL,
  call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_at TEXT,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_time_status ON time_entries(status, work_date);
CREATE INDEX IF NOT EXISTS idx_time_updated ON time_entries(updated_at);
CREATE INDEX IF NOT EXISTS idx_time_client ON time_entries(client_id);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  organization TEXT,
  phone TEXT,
  fax TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  zip TEXT,
  hours TEXT,
  eligibility TEXT,
  services TEXT,
  languages TEXT,
  accepts_medicaid INTEGER DEFAULT 0,
  accepts_uninsured INTEGER DEFAULT 0,
  mat_offered TEXT,
  capacity_notes TEXT,
  contact_person TEXT,
  summary TEXT,                         -- plain-language overview shown on the profile
  service_tags TEXT,                    -- comma separated SERVICE_TAGS
  levels_of_care TEXT,                  -- comma separated ASAM levels
  populations TEXT,                     -- who they serve (comma separated POPULATIONS)
  intake_process TEXT,
  cost_notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_resources_cat ON resources(category);

CREATE TABLE IF NOT EXISTS resource_photos (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  caption TEXT,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER, height INTEGER,
  -- Nullable: an attachment row reaches a device before its bytes do. Attachments are fetched by id once
  -- the rows have landed, because inlining every photo made a sync payload the phone could not parse.
  data_b64 TEXT,                       -- downscaled picture (JPEG/PNG/WebP), base64
  thumb_b64 TEXT,                       -- small JPEG thumbnail for lists, base64
  sort_order INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_resource_photos ON resource_photos(resource_id, sort_order);

-- County policies, procedures and contracts: an uploaded-file library, searched by title/category/metadata
-- only (no PHI in here, and no text extracted from the files themselves).
CREATE TABLE IF NOT EXISTS policy_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('policy','procedure','contract')),
  description TEXT,
  effective_date TEXT,
  expires_at TEXT,
  filename TEXT,
  content_type TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  file_b64 TEXT,
  search_text TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_policy_documents_cat ON policy_documents(category);
CREATE INDEX IF NOT EXISTS idx_policy_documents_updated ON policy_documents(updated_at);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  referred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  urgency TEXT DEFAULT 'routine',
  appointment_at TEXT,
  admitted_at TEXT,
  closed_at TEXT,
  outcome_enc TEXT,                    -- free text about a named person's treatment: encrypted
  barrier_enc TEXT,
  warm_handoff INTEGER DEFAULT 0,
  consent_id TEXT REFERENCES consents(id) ON DELETE SET NULL,
  -- set when the consent this referral relied on is revoked, so the worker is told to stop sharing
  consent_revoked INTEGER NOT NULL DEFAULT 0,
  follow_up_due TEXT,
  outcome_recorded_at TEXT,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  notes_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_client ON referrals(client_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  title_enc TEXT NOT NULL,             -- "Call about detox bed" reveals a diagnosis: encrypted
  description TEXT,
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  is_milestone INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- the referral whose follow-up this is, so recording that referral's outcome closes this to-do and no other
  referral_id TEXT REFERENCES referrals(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id);

CREATE TABLE IF NOT EXISTS expenditures (
  id TEXT PRIMARY KEY,
  funding_source_id TEXT NOT NULL REFERENCES funding_sources(id),
  budget_line_id TEXT REFERENCES budget_lines(id) ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  intervention_id TEXT REFERENCES interventions(id) ON DELETE SET NULL,
  spent_at TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL,
  vendor TEXT,
  description TEXT,
  receipt_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','reimbursed')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_fund ON expenditures(funding_source_id, spent_at);
CREATE INDEX IF NOT EXISTS idx_exp_client ON expenditures(client_id);
-- At most one expenditure per intervention (NULL excluded, so ordinary manually-entered expenditures with
-- no linked service are unaffected) — a second row for the same service would double-count its cost.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_intervention_unique ON expenditures(intervention_id) WHERE intervention_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('clinical','admin')),
  format TEXT NOT NULL DEFAULT 'narrative',
  title_enc TEXT,
  content_enc TEXT NOT NULL,
  structured_enc TEXT,                 -- JSON of SOAP/DAP/BIRP sections, encrypted
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','amended')),
  signed_at TEXT,
  signed_by TEXT REFERENCES users(id),
  signature_hash TEXT,                 -- sha256 over content at signing time (tamper evidence)
  -- Co-signature: a supervisor countersigns a trainee's note. author_id is never reassigned, so the
  -- record always shows who wrote it and who approved it as two separate people.
  cosign_required INTEGER NOT NULL DEFAULT 0,
  cosigned_by TEXT REFERENCES users(id),
  cosigned_at TEXT,
  cosignature_hash TEXT,
  cosign_note TEXT,
  -- The author asked a supervisor to review/co-sign this note (a navigator flagging a difficult contact),
  -- separate from cosign_required, which the account's supervision setting imposes on every note.
  cosign_requested INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  import_item_id TEXT,
  intervention_id TEXT REFERENCES interventions(id) ON DELETE SET NULL,
  call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  part2_protected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_client ON notes(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_notes_author ON notes(author_id);

CREATE TABLE IF NOT EXISTS note_addenda (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content_enc TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_note_addenda_updated ON note_addenda(updated_at);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                  -- part2_disclosure, roi, treatment, telehealth, contact, research
  recipient_enc TEXT,
  purpose_enc TEXT,
  scope_enc TEXT,
  signed_at TEXT NOT NULL,
  expires_at TEXT,
  -- 42 CFR §2.31 lets a consent expire on an event ("on discharge from the program") instead of a date.
  expires_event TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  document_ref TEXT,
  witness TEXT,
  signed_on_paper INTEGER NOT NULL DEFAULT 0,
  -- The client was told that what is disclosed under this consent may not be redisclosed (§2.32).
  redisclosure_notice_given INTEGER NOT NULL DEFAULT 0,
  revoked_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_consents_client ON consents(client_id);
CREATE INDEX IF NOT EXISTS idx_consents_updated ON consents(updated_at);
CREATE INDEX IF NOT EXISTS idx_consents_client ON consents(client_id);

CREATE TABLE IF NOT EXISTS disclosures (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  consent_id TEXT REFERENCES consents(id) ON DELETE SET NULL,
  recipient_enc TEXT NOT NULL,
  purpose_enc TEXT NOT NULL,
  what_enc TEXT NOT NULL,
  method TEXT,
  disclosed_at TEXT NOT NULL,
  disclosed_by TEXT NOT NULL REFERENCES users(id),
  basis TEXT,                          -- consent, court_order, medical_emergency, qsoa, audit, research, export
  -- Why a disclosure was made without consent (required for 'other' and 'medical_emergency'); PHI, encrypted.
  justification_enc TEXT,
  source TEXT,                         -- referral, export, manual: what caused the disclosure to be recorded
  source_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_disclosures_client ON disclosures(client_id);
CREATE INDEX IF NOT EXISTS idx_disclosures_updated ON disclosures(updated_at);
CREATE INDEX IF NOT EXISTS idx_disclosures_client ON disclosures(client_id);

-- County form library: templates (blank forms + fillable field definitions) and forms filled out for a client
CREATE TABLE IF NOT EXISTS form_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  version TEXT,
  filename TEXT,                       -- original county form file (PDF/Word/image), optional
  content_type TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  file_b64 TEXT,
  fields_json TEXT NOT NULL DEFAULT '[]', -- [{key,label,type,required,options,autofill,help}]
  instructions TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS client_forms (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES form_templates(id) ON DELETE SET NULL,
  template_name TEXT NOT NULL,         -- snapshot so the record survives template changes
  fields_json TEXT NOT NULL DEFAULT '[]', -- snapshot of the field definitions used
  values_enc TEXT NOT NULL,            -- encrypted JSON {key: value} (PHI)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','completed','void')),
  completed_at TEXT,
  completed_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_forms_client ON client_forms(client_id);
CREATE TABLE IF NOT EXISTS client_form_files (
  id TEXT PRIMARY KEY,
  client_form_id TEXT NOT NULL REFERENCES client_forms(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  data_enc TEXT,                       -- encrypted base64 of the signed / scanned copy (PHI); nullable, see resource_photos.data_b64
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_client_form_files ON client_form_files(client_form_id);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                -- pocket_ai, onenote_file, onenote_graph, generic, api
  filename TEXT,
  imported_by TEXT REFERENCES users(id),
  item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'staged',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_imports_updated ON imports(updated_at);

CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  external_id TEXT,
  title_enc TEXT,
  content_enc TEXT NOT NULL,
  captured_at TEXT,
  metadata TEXT,
  suggested_client_id TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','committed','discarded')),
  note_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_import_items_updated ON import_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_import_items ON import_items(import_id, status);

-- Spreadsheet import provenance (server/routes/dataimport.js): one row per imported spreadsheet row, keyed
-- by a hash of the kind of import, the row's position and what it held, so importing the same file twice
-- skips what is already in instead of doubling every visit, call, hour and expenditure. Server-side only.
CREATE TABLE IF NOT EXISTS import_rows (
  row_hash TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  record_id TEXT,
  imported_by TEXT,                    -- the user id; no FK, this table is server-side bookkeeping only
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_import_rows_entity ON import_rows(entity, imported_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  client_id TEXT,
  ip TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  details TEXT,
  prev_hash TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_client ON audit_log(client_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, key)
);

-- Sync reads every table by updated_at; without these indexes each pull is a full scan of every table.
CREATE INDEX IF NOT EXISTS idx_clients_updated ON clients(updated_at);
CREATE INDEX IF NOT EXISTS idx_clients_full_name_idx ON clients(full_name_idx);
CREATE INDEX IF NOT EXISTS idx_clients_name_prefix ON clients(name_prefix_idx);
CREATE INDEX IF NOT EXISTS idx_clients_name_phonetic ON clients(name_phonetic_idx);
CREATE INDEX IF NOT EXISTS idx_clients_first_name ON clients(first_name_idx);
CREATE INDEX IF NOT EXISTS idx_clients_first_name_prefix ON clients(first_name_prefix_idx);
CREATE INDEX IF NOT EXISTS idx_clients_preferred_name ON clients(preferred_name_idx);
CREATE INDEX IF NOT EXISTS idx_resources_updated ON resources(updated_at);
CREATE INDEX IF NOT EXISTS idx_resource_photos_updated ON resource_photos(updated_at);
CREATE INDEX IF NOT EXISTS idx_funding_sources_updated ON funding_sources(updated_at);
CREATE INDEX IF NOT EXISTS idx_referrals_updated ON referrals(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_expenditures_updated ON expenditures(updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_form_templates_updated ON form_templates(updated_at);
CREATE INDEX IF NOT EXISTS idx_client_forms_updated ON client_forms(updated_at);
CREATE INDEX IF NOT EXISTS idx_client_form_files_updated ON client_form_files(updated_at);
CREATE INDEX IF NOT EXISTS idx_users_updated ON users(updated_at);

-- Episodes of care. A client may be served more than once; funders count admissions and discharges per
-- episode, not per person, and a closed episode is what makes a caseload shrink.
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  funding_source_id TEXT REFERENCES funding_sources(id),
  opened_at TEXT NOT NULL,
  opened_by TEXT REFERENCES users(id),
  referral_source TEXT,
  presenting_problem_enc TEXT,
  closed_at TEXT,
  closed_by TEXT REFERENCES users(id),
  discharge_reason TEXT,               -- completed, transferred, incarcerated, moved, lost_contact, declined, deceased, other
  discharge_disposition TEXT,          -- where the client went (level of care, program)
  discharge_summary_enc TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_client ON episodes(client_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_updated ON episodes(updated_at);

-- Overdose and reversal events. Every SUD funder asks for these counts; they were previously only
-- inferable from two boolean columns on the client record, which cannot answer "how many this quarter".
CREATE TABLE IF NOT EXISTS overdose_events (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,   -- null for a community/bystander report
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'overdose' CHECK (kind IN ('overdose','reversal','fatal')),
  substances_enc TEXT,                 -- what a named person took: encrypted
  naloxone_used INTEGER NOT NULL DEFAULT 0,
  naloxone_doses INTEGER NOT NULL DEFAULT 0,
  administered_by TEXT,                -- bystander, first_responder, staff, self, unknown
  ems_called INTEGER NOT NULL DEFAULT 0,
  hospitalized INTEGER NOT NULL DEFAULT 0,
  survived INTEGER NOT NULL DEFAULT 1,
  location_type TEXT,
  city TEXT,
  funding_source_id TEXT REFERENCES funding_sources(id),
  notes_enc TEXT,
  reported_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_overdose_client ON overdose_events(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_overdose_occurred ON overdose_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_overdose_updated ON overdose_events(updated_at);

-- Harm-reduction supply inventory (naloxone kits, test strips…). A visit that records kits or strips
-- handed out decrements the matching item, so the count on hand is what is actually left in the cupboard.
CREATE TABLE IF NOT EXISTS supply_stock (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL UNIQUE COLLATE NOCASE,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_supply_stock_updated ON supply_stock(updated_at);

-- Hard deletes travel to devices as tombstones (created by migration 2 on databases predating 1.2).
CREATE TABLE IF NOT EXISTS tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (table_name, id));
CREATE INDEX IF NOT EXISTS idx_tombstones_at ON tombstones(deleted_at);

-- Emergency ("break-glass") access to clinical notes by someone outside the treating roles. Each use is
-- queued here for a supervisor or privacy officer to review and acknowledge; the audit log has the same
-- event, but a queue that empties is what makes the review actually happen. Server-side only, not synced.
CREATE TABLE IF NOT EXISTS breakglass_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  note_id TEXT,
  reason_enc TEXT NOT NULL,            -- the stated reason may name the client or their situation: encrypted
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_breakglass_open ON breakglass_events(acknowledged_at, at);

-- Patient-rights requests (HIPAA §164.524 access, §164.526 amendment, §164.522 restriction, §164.528
-- accounting of disclosures). Each has a 30-day clock from receipt, which is what due_at records.
CREATE TABLE IF NOT EXISTS patient_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access','amendment','restriction','accounting')),
  received_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','denied')),
  notes_enc TEXT,
  handled_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_patient_requests_client ON patient_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_patient_requests_updated ON patient_requests(updated_at);
