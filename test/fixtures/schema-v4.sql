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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

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
  preferred_name_enc TEXT,
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
  goals TEXT,
  flags TEXT,                          -- comma separated safety flags
  contact_preferences TEXT,
  ok_to_text INTEGER DEFAULT 0,
  ok_to_voicemail INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id),
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
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
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
  category TEXT NOT NULL,
  label TEXT,
  allocated_amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS interventions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
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
  cost REAL DEFAULT 0,
  summary TEXT,
  follow_up_due TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_interventions_client ON interventions(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_interventions_user ON interventions(user_id, occurred_at);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  started_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  contact_type TEXT NOT NULL DEFAULT 'client',
  contact_name_enc TEXT,
  phone_enc TEXT,
  purpose TEXT,
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id, work_date);
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
  data_b64 TEXT NOT NULL,               -- downscaled picture (JPEG/PNG/WebP), base64
  thumb_b64 TEXT,                       -- small JPEG thumbnail for lists, base64
  sort_order INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_resource_photos ON resource_photos(resource_id, sort_order);

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
  outcome TEXT,
  barrier TEXT,
  warm_handoff INTEGER DEFAULT 0,
  consent_id TEXT,
  follow_up_due TEXT,
  notes TEXT,
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
  title TEXT NOT NULL,
  description TEXT,
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  is_milestone INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_fund ON expenditures(funding_source_id, spent_at);
CREATE INDEX IF NOT EXISTS idx_exp_client ON expenditures(client_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('clinical','admin')),
  format TEXT NOT NULL DEFAULT 'narrative',
  title TEXT,
  content_enc TEXT NOT NULL,
  structured_enc TEXT,                 -- JSON of SOAP/DAP/BIRP sections, encrypted
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','amended')),
  signed_at TEXT,
  signed_by TEXT REFERENCES users(id),
  signature_hash TEXT,                 -- sha256 over content at signing time (tamper evidence)
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                  -- part2_disclosure, roi, treatment, telehealth, contact, research
  recipient TEXT,
  purpose TEXT,
  scope TEXT,
  signed_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  document_ref TEXT,
  witness TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_consents_client ON consents(client_id);

CREATE TABLE IF NOT EXISTS disclosures (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  consent_id TEXT REFERENCES consents(id) ON DELETE SET NULL,
  disclosed_to TEXT NOT NULL,
  purpose TEXT NOT NULL,
  info_disclosed TEXT NOT NULL,
  method TEXT,
  disclosed_at TEXT NOT NULL,
  disclosed_by TEXT NOT NULL REFERENCES users(id),
  basis TEXT,                          -- consent, court_order, medical_emergency, qsoa, audit, research
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
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
  data_enc TEXT NOT NULL,              -- encrypted base64 of the signed / scanned copy (PHI)
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  external_id TEXT,
  title TEXT,
  content_enc TEXT NOT NULL,
  captured_at TEXT,
  metadata TEXT,
  suggested_client_id TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','committed','discarded')),
  note_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_import_items ON import_items(import_id, status);

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

-- ---- state added by migrations 2-4 of SUDS 1.6.1 ----
ALTER TABLE assignments ADD COLUMN updated_at TEXT;
ALTER TABLE consents ADD COLUMN updated_at TEXT;
ALTER TABLE disclosures ADD COLUMN updated_at TEXT;
ALTER TABLE budget_lines ADD COLUMN updated_at TEXT;
ALTER TABLE note_addenda ADD COLUMN updated_at TEXT;
ALTER TABLE imports ADD COLUMN updated_at TEXT;
ALTER TABLE import_items ADD COLUMN updated_at TEXT;
CREATE TABLE IF NOT EXISTS tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (table_name, id));
CREATE INDEX IF NOT EXISTS idx_tombstones_at ON tombstones(deleted_at);
INSERT INTO settings(key,value) VALUES('schema_version','4') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
