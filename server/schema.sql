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
  -- Self sign-up (POST /api/auth/signup): a request for an account is a users row that cannot sign in
  -- (is_active=0, access_status='pending') until an administrator approves it under Settings -> Users &
  -- roles. access_note is the requester's own "why I need access" (staff text, never client information);
  -- requested_at is when they asked. Every account created any other way is 'active' from the start.
  access_status TEXT NOT NULL DEFAULT 'active' CHECK (access_status IN ('active','pending','declined')),
  access_note TEXT,
  requested_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Identity-provider lifecycle (server/deprovision.js, server/routes/scim.js). idp_seen_at: the last time the
  -- county identity provider vouched for this account (an SSO sign-in, or a SCIM create/update that left it
  -- active); an SSO-linked account not seen for sso_deprovision_days is disabled. scim_external_id: the
  -- provider's own id for the person (Entra objectId / Okta user id), set when SCIM provisions the account.
  idp_seen_at TEXT,
  scim_external_id TEXT,
  -- The fund this worker's visits are charged to unless they choose another (migration 38). Blank: the
  -- programme's default (settings.default_fund_id). No REFERENCES: users sync to a device before funds do.
  default_fund_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_subject ON users(oidc_subject) WHERE oidc_subject IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_scim_external_id ON users(scim_external_id) WHERE scim_external_id IS NOT NULL;

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
  revoked_at TEXT,
  -- How this session's second factor was satisfied: NULL (none or SUDS's own TOTP) or 'idp' — the identity
  -- provider asserted multi-factor sign-in (amr/acr) and the administrator chose to trust it (server/routes/oidc.js).
  mfa_source TEXT
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
  contact_preferences_enc TEXT,             -- "safe contact" notes (who must not be told, when to call): encrypted
  ok_to_text INTEGER DEFAULT 0,
  ok_to_voicemail INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  -- Set when this record was merged into another as a duplicate; the row is kept so old references and the
  -- audit trail still resolve, but it no longer appears anywhere staff work.
  merged_into TEXT REFERENCES clients(id),
  -- A legal hold (litigation, investigation, a patient's own request) exempts the record from the retention
  -- purge in server/retention.js and from deletion until an administrator clears it.
  legal_hold INTEGER NOT NULL DEFAULT 0,
  -- Free-text reasons can name the person or their situation, so they are encrypted here and the audit entry
  -- records only that one was given: why the hold was placed, why it was last cleared, and why the record
  -- was deleted or merged away.
  legal_hold_reason_enc TEXT,
  legal_hold_cleared_reason_enc TEXT,
  removed_reason_enc TEXT,
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
  notes_enc TEXT,                      -- free text about the client (a transfer's reason): encrypted
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
  -- Opioid settlement funds (migration 38): the allowable use (constants.SETTLEMENT_USES — national
  -- settlement Exhibit E) and the California High Impact Abatement Activity (constants.SETTLEMENT_HIAA, or
  -- 'none') that spending from this fund counts toward, unless an expenditure says otherwise.
  settlement_use TEXT,
  settlement_hiaa TEXT,
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
-- The report period's index (migration 38 replaced idx_interventions_occurred with it): the date leads, and
-- the columns the funder report counts ride along, so a year of visits is read from the index alone.
CREATE INDEX IF NOT EXISTS idx_interventions_period ON interventions(occurred_at, funding_source_id, client_id, naloxone_kits, fentanyl_strips);
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
  -- What the time was spent on and the reviewer's note: free text that can name the client, so encrypted.
  description_enc TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_at TEXT,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note_enc TEXT,
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
  description_enc TEXT,                -- the details say even more than the title: encrypted too
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
  -- What was bought, for whom, and the reviewer's note: free text that can name the client, so encrypted.
  description_enc TEXT,
  receipt_ref TEXT,
  -- This expenditure's own opioid settlement category, when it differs from its fund's (migration 38).
  settlement_use TEXT,
  settlement_hiaa TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','reimbursed')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note_enc TEXT,
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
  cosign_note_enc TEXT,                -- the countersigner's comment on the note: encrypted
  -- The author asked a supervisor to review/co-sign this note (a navigator flagging a difficult contact),
  -- separate from cosign_required, which the account's supervision setting imposes on every note.
  cosign_requested INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  import_item_id TEXT,
  intervention_id TEXT REFERENCES interventions(id) ON DELETE SET NULL,
  call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  part2_protected INTEGER NOT NULL DEFAULT 1,
  -- A SUD counseling note (42 CFR §2.11, 2024 rule): a clinician's notes analysing a counselling session,
  -- kept apart from the rest of the record. Disclosed only under a consent given for counseling notes alone.
  counseling_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  -- The problem-list entries this note addresses: a JSON array of problems.id (CalAIM progress notes tie
  -- each service to the problem list). Ids only, never the problem text.
  problem_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_client ON notes(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_notes_author ON notes(author_id);

CREATE TABLE IF NOT EXISTS note_addenda (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content_enc TEXT NOT NULL,
  reason_enc TEXT,                     -- why the addendum was needed (free text): encrypted
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
  revoked_reason_enc TEXT,             -- why the client revoked it (free text): encrypted
  document_ref TEXT,
  witness TEXT,
  signed_on_paper INTEGER NOT NULL DEFAULT 0,
  -- The client was told that what is disclosed under this consent may not be redisclosed (§2.32).
  redisclosure_notice_given INTEGER NOT NULL DEFAULT 0,
  -- The rest of the 42 CFR §2.31 (2024 rule) elements (migration 29): who may make the disclosure, who
  -- signed when it was not the patient (a parent, guardian or personal representative, §2.14/§2.15; the
  -- name is PHI), and that the consent stated the right to revoke and the consequences of refusing to sign.
  -- rule_version is '2024' for a consent recorded against that element list; NULL is an earlier record.
  discloser TEXT,
  signer_relationship TEXT,
  signer_name_enc TEXT,
  revocation_right_given INTEGER NOT NULL DEFAULT 0,
  refusal_consequences_given INTEGER NOT NULL DEFAULT 0,
  rule_version TEXT,
  -- The coded categories of information the consent covers, comma-separated (migration 35; the codes are
  -- CONSENT_INFO_CATEGORIES in server/constants.js, 'all' for everything). Not PHI: it is what the signed
  -- form's scope says in machine-readable form, so an automated disclosure (the FHIR API) can honour it.
  -- NULL on a consent recorded before categories existed: its free-text scope cannot be read by a machine,
  -- so it covers nothing automated (docs/integration/FHIR.md) unless the migration found it was general.
  info_categories TEXT,
  revoked_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_consents_client ON consents(client_id);
CREATE INDEX IF NOT EXISTS idx_consents_updated ON consents(updated_at);
CREATE INDEX IF NOT EXISTS idx_consents_client ON consents(client_id);

-- Court orders authorising disclosure under 42 CFR Part 2 subpart E (§§2.61-2.67). A subpoena alone never
-- authorises disclosure of a Part 2 record; an order recorded here is what the 'court_order' basis, and any
-- disclosure for use in a proceeding against the patient, must point at (server/disclosure.js). Every
-- descriptive field names the patient's legal matter, so it is encrypted.
CREATE TABLE IF NOT EXISTS court_orders (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  order_type TEXT NOT NULL CHECK (order_type IN ('noncriminal_2_64','criminal_patient_2_65','program_investigation_2_66','undercover_2_67')),
  court_enc TEXT NOT NULL,
  case_ref_enc TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  recipient_enc TEXT,
  purpose_enc TEXT NOT NULL,
  scope_enc TEXT NOT NULL,             -- what the order permits: limited to the parts of the record essential to its purpose (§2.64(e))
  findings_recorded INTEGER NOT NULL DEFAULT 0,       -- the order states the good-cause findings (§2.64(d))
  notice_requirement_met INTEGER NOT NULL DEFAULT 0,  -- the patient/program had the notice and chance to respond the section requires
  covers_counseling_notes INTEGER NOT NULL DEFAULT 0,
  document_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','vacated')),
  vacated_at TEXT,
  vacated_reason_enc TEXT,             -- free text that can describe the case: encrypted
  recorded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_court_orders_client ON court_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_court_orders_updated ON court_orders(updated_at);

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
  -- Migration 29: the subpart E order relied on, whether the information is for use in a proceeding
  -- against the patient (§2.12(d)), whether it includes SUD counseling notes (§2.31(b)), and which
  -- wording of the §2.32 notice went with it.
  court_order_id TEXT REFERENCES court_orders(id) ON DELETE SET NULL,
  legal_proceeding INTEGER NOT NULL DEFAULT 0,
  counseling_notes INTEGER NOT NULL DEFAULT 0,
  notice_version TEXT,
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
  notes_enc TEXT,                      -- free text about this client's form: encrypted
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
-- The audit log is append-only in the database itself. An UPDATE or DELETE of audit_log is refused unless
-- a row in audit_maintenance says a sanctioned maintenance step is running — the retention purge and the
-- index-key re-signing (server/audit.js maintenance()), which insert that row and delete it again inside
-- the same transaction, so it is never committed and no other connection ever sees it. Anyone who can drop
-- these triggers can also edit the file; the keyed hash chain and the anchors written outside the database
-- (server/audit-anchor.js) are what catch that.
CREATE TABLE IF NOT EXISTS audit_maintenance (
  purpose TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  WHEN NOT EXISTS (SELECT 1 FROM audit_maintenance)
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: entries cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  WHEN NOT EXISTS (SELECT 1 FROM audit_maintenance)
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: entries are removed only by the retention purge'); END;

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
  reopen_reason_enc TEXT,              -- why a closed episode was reopened (free text: encrypted, not in the audit entry)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_client ON episodes(client_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_updated ON episodes(updated_at);

-- CalOMS Tx state reporting (server/caloms.js, server/caloms-spec.js): one row per admission, discharge or
-- annual update record of an episode of care. The answers (drug use, arrests, pregnancy, disability, ZIP…)
-- are PHI about a named person and are held encrypted as one JSON document; only the operational codes a
-- list needs without decrypting are in the clear, like episodes.discharge_reason. At most one admission and
-- one discharge per episode; annual updates repeat. extracted_at is when a record last went into a state
-- extract (the accounting of that disclosure is in disclosures).
CREATE TABLE IF NOT EXISTS caloms_records (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK (record_type IN ('admission','discharge','annual_update')),
  provider_id TEXT,                    -- the CalOMS provider ID (Settings -> State reporting) the record is reported under
  record_date TEXT NOT NULL,           -- admission date, discharge date, or the annual update's date
  service_type TEXT,                   -- admission only: CalOMS type of service code
  discharge_status TEXT,               -- discharge only: CalOMS discharge status code
  answers_enc TEXT,                    -- encrypted JSON of the coded answers
  extracted_at TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_caloms_records_episode ON caloms_records(episode_id, record_type);
CREATE INDEX IF NOT EXISTS idx_caloms_records_date ON caloms_records(record_date);
CREATE INDEX IF NOT EXISTS idx_caloms_records_updated ON caloms_records(updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_caloms_records_one_per_episode ON caloms_records(episode_id, record_type) WHERE record_type IN ('admission','discharge');

-- CalOMS Tx submissions (migration 35). Producing a submission is the disclosure to DHCS: the file is built
-- once, accounted for per client (disclosures, source 'caloms', source_ref 'caloms:<id>'), and kept here so
-- what is downloaded and sent is exactly what was accounted — identified by its SHA-256. The file itself
-- (a zip of identified records) is encrypted and kept only until it is no longer needed (retention.js
-- clears file_enc after CALOMS_FILE_DAYS, and when a client in it is purged); the row stays as the record
-- of the submission. Office server only, never synchronised.
CREATE TABLE IF NOT EXISTS caloms_submissions (
  id TEXT PRIMARY KEY,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  clients INTEGER NOT NULL DEFAULT 0,
  counts TEXT,                         -- JSON: records per type, and how many were held back
  file_enc TEXT,                       -- base64 of the zip, encrypted; NULL once cleared
  file_cleared_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_caloms_submissions_created ON caloms_submissions(created_at);

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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- What the exception was: 'clinical_note' (a clinical note opened with a break-glass reason) or
  -- 'readmission' (a discharged client outside the worker's caseload re-admitted by them at intake).
  kind TEXT NOT NULL DEFAULT 'clinical_note'
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

-- A retried POST (a double tap, a save resent after the connection dropped, a phone that lost signal
-- between sending and hearing back) is answered from here instead of being executed a second time.
-- One row per (user, Idempotency-Key): id is sha256 of both, so the key the browser chose is not kept.
-- The stored answer can name a client, so it is encrypted. Rows older than 24 hours are purged by the
-- hourly housekeeping (server/idempotency.js). Never synchronised: each database answers its own retries.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

-- The wording, order and availability of the choices on documentation forms ("What did you do?", "What
-- happened", "Outcome"…), set by an administrator under Settings → Lists. The built-in choices live in code
-- (server/options.js); a row here only records what differs: a new label, a position, a retired (hidden)
-- choice, or a programme's own addition (is_custom). The stored code never changes, so old records and
-- reports keep their meaning. Not PHI. Synchronised to devices pull-only: the office's lists are the lists.
CREATE TABLE IF NOT EXISTS option_overrides (
  id TEXT PRIMARY KEY,
  list_key TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT,
  sort_order INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  is_custom INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (list_key, code)
);
CREATE INDEX IF NOT EXISTS idx_option_overrides_updated ON option_overrides(updated_at);

-- CalAIM problem list: the client's current problems and needs, kept up to date as they change. The text
-- and any code are PHI (a diagnosis code says as much as the words), so all of it is encrypted; status,
-- dates and source are what the list is sorted and counted by. Never deleted: a problem that no longer
-- applies is resolved or made inactive, and problem_history keeps who changed what.
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  problem_enc TEXT NOT NULL,           -- the problem or need, in words
  icd10_code_enc TEXT,                 -- optional ICD-10-CM code (format-checked, no bundled code set)
  icd10_description_enc TEXT,
  z_codes_enc TEXT,                    -- optional social determinant codes (Z55-Z65), comma separated
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','inactive')),
  onset_date TEXT,
  resolved_date TEXT,
  source TEXT NOT NULL DEFAULT 'self_report' CHECK (source IN ('self_report','assessment','referral','other')),
  added_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_problems_client ON problems(client_id, status);
CREATE INDEX IF NOT EXISTS idx_problems_updated ON problems(updated_at);

-- Every change to a problem-list entry: who, when, and each field's old and new value (encrypted JSON,
-- because the values are the problem text and codes). Append-only.
CREATE TABLE IF NOT EXISTS problem_history (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created','updated')),
  changes_enc TEXT,
  changed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_problem_history_problem ON problem_history(problem_id, created_at);
CREATE INDEX IF NOT EXISTS idx_problem_history_updated ON problem_history(updated_at);

-- Care coordination plan: goals in the client's own words, each tied (optionally) to a problem, with a
-- review date that shows as overdue once it passes; and the steps toward each goal, with who does them
-- and by when. A step can create a to-do (task_id) so it lands on someone's list.
CREATE TABLE IF NOT EXISTS care_plan_goals (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  problem_id TEXT REFERENCES problems(id) ON DELETE SET NULL,
  goal_enc TEXT NOT NULL,              -- the goal as the client puts it
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','met','partially_met','not_met','discontinued')),
  start_date TEXT,
  target_date TEXT,
  review_date TEXT,
  reviewed_at TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_care_plan_goals_client ON care_plan_goals(client_id, status);
CREATE INDEX IF NOT EXISTS idx_care_plan_goals_updated ON care_plan_goals(updated_at);

CREATE TABLE IF NOT EXISTS care_plan_steps (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES care_plan_goals(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  step_enc TEXT NOT NULL,              -- the step or intervention
  owner_role TEXT NOT NULL DEFAULT 'staff' CHECK (owner_role IN ('client','staff','family_support','other_provider')),
  owner_user_id TEXT REFERENCES users(id),
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_care_plan_steps_goal ON care_plan_steps(goal_id);
CREATE INDEX IF NOT EXISTS idx_care_plan_steps_updated ON care_plan_steps(updated_at);

-- ASAM multidimensional assessment: a 0-4 risk rating for each of the six dimensions, with the reasoning
-- (encrypted), the level of care recommended and the level actually referred to, and why they differ.
-- Only the dimension names and ratings are stored; the ASAM Criteria text is not reproduced.
CREATE TABLE IF NOT EXISTS asam_assessments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  assessed_at TEXT NOT NULL,
  assessed_by TEXT REFERENCES users(id),
  d1_rating INTEGER NOT NULL CHECK (d1_rating BETWEEN 0 AND 4),
  d2_rating INTEGER NOT NULL CHECK (d2_rating BETWEEN 0 AND 4),
  d3_rating INTEGER NOT NULL CHECK (d3_rating BETWEEN 0 AND 4),
  d4_rating INTEGER NOT NULL CHECK (d4_rating BETWEEN 0 AND 4),
  d5_rating INTEGER NOT NULL CHECK (d5_rating BETWEEN 0 AND 4),
  d6_rating INTEGER NOT NULL CHECK (d6_rating BETWEEN 0 AND 4),
  dimension_notes_enc TEXT,            -- JSON {d1..d6: reasoning}
  recommended_loc TEXT,
  actual_loc TEXT,
  discrepancy_reason TEXT,
  discrepancy_notes_enc TEXT,
  summary_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_asam_client ON asam_assessments(client_id, assessed_at);
CREATE INDEX IF NOT EXISTS idx_asam_updated ON asam_assessments(updated_at);

-- Outcome measures: standardized screening instruments (PHQ-9, GAD-7, AUDIT-C, DAST-10, a 0-10 wellbeing
-- rating) scored automatically (server/clinical.js). The answers are encrypted; the total and band stay
-- readable so a trend and the programme outcomes report can be computed. safety_flag marks a PHQ-9 whose
-- item 9 was answered above "Not at all".
CREATE TABLE IF NOT EXISTS outcome_measures (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  instrument TEXT NOT NULL CHECK (instrument IN ('phq9','gad7','auditc','dast10','wellbeing')),
  administered_at TEXT NOT NULL,
  administered_by TEXT REFERENCES users(id),
  responses_enc TEXT NOT NULL,         -- JSON array of the answers
  total_score INTEGER NOT NULL,
  band TEXT,
  positive INTEGER,
  variant TEXT,
  safety_flag INTEGER NOT NULL DEFAULT 0,
  notes_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_outcome_measures_client ON outcome_measures(client_id, instrument, administered_at);
CREATE INDEX IF NOT EXISTS idx_outcome_measures_updated ON outcome_measures(updated_at);

-- 42 CFR §2.22 (2024 rule): each patient is given the program's notice of privacy practices. One row per
-- time it was given — when, how, by whom, which version of the notice, and whether the patient signed an
-- acknowledgement (or declined to). The notice text itself is a setting (Privacy & Part 2 page).
CREATE TABLE IF NOT EXISTS part2_notices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  given_at TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('in_person_paper','electronic','mail','verbal_with_copy')),
  notice_version TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  ack_refused INTEGER NOT NULL DEFAULT 0,
  notes_enc TEXT,
  given_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_part2_notices_client ON part2_notices(client_id);
CREATE INDEX IF NOT EXISTS idx_part2_notices_updated ON part2_notices(updated_at);

-- Privacy complaints (42 CFR §2.4; HIPAA §164.530(d)): anyone may complain to the program or to HHS, and
-- nobody may be retaliated against for it. client_id is null for an anonymous complaint or one from
-- someone who is not a client. Server-side only (a supervisor's register), not synchronised.
CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  received_at TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in_person' CHECK (channel IN ('in_person','phone','mail','email','web','other')),
  complainant TEXT NOT NULL DEFAULT 'client' CHECK (complainant IN ('client','representative','staff','anonymous','other')),
  summary_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','closed')),
  resolution_enc TEXT,
  resolved_at TEXT,
  hhs_referral_given INTEGER NOT NULL DEFAULT 0,      -- told they may also complain to the HHS Secretary (OCR)
  retaliation_reviewed INTEGER NOT NULL DEFAULT 0,    -- someone checked no adverse action followed the complaint
  handled_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status, received_at);
CREATE INDEX IF NOT EXISTS idx_complaints_client ON complaints(client_id);

-- Privacy / security incident register. The 2024 Part 2 rule applies the HIPAA Breach Notification Rule
-- (45 CFR §§164.400-414) to Part 2 records: a breach is presumed unless a four-factor risk assessment shows
-- a low probability of compromise, and notice is due without unreasonable delay and within 60 days of
-- discovery. Deadlines are computed from discovered_at (server/incidents.js). Server-side only.
CREATE TABLE IF NOT EXISTS privacy_incidents (
  id TEXT PRIMARY KEY,
  -- A short label. Encrypted (migration 32): a title is typed by a person in a hurry, and "Fax about Jane
  -- Doe sent to the wrong clinic" is exactly what one would type.
  title_enc TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  occurred_at TEXT,
  -- part2_program_off: an administrator switched the programme's Part 2 protections off (routes/part2.js).
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','audit_chain','breakglass','mass_export','part2_program_off')),
  source_ref TEXT,
  description_enc TEXT,
  part2_records INTEGER NOT NULL DEFAULT 1,
  affected_count INTEGER NOT NULL DEFAULT 0,
  max_in_one_state INTEGER NOT NULL DEFAULT 0,
  risk_nature_enc TEXT,                -- factor 1: nature and extent of the information, likelihood of re-identification
  risk_recipient_enc TEXT,             -- factor 2: the unauthorised person who used it or to whom it went
  risk_acquired_enc TEXT,              -- factor 3: whether it was actually acquired or viewed
  risk_mitigation_enc TEXT,            -- factor 4: the extent to which the risk has been mitigated
  determination TEXT NOT NULL DEFAULT 'pending' CHECK (determination IN ('pending','breach','not_breach')),
  determination_reason_enc TEXT,
  determined_by TEXT REFERENCES users(id),
  determined_at TEXT,
  law_enforcement_delay_until TEXT,    -- §164.412: a law-enforcement request to delay notice
  individuals_notified_at TEXT,
  hhs_notified_at TEXT,
  media_notified_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at TEXT,
  reported_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_privacy_incidents_status ON privacy_incidents(status, discovered_at);
-- The documentation of a breach is kept for six years (45 CFR §164.530(j)), which can outlast the client's
-- record: when retention purges the client, the link is unset (never deleted) and the snapshot taken when
-- the client was linked stays — the client code, the name (encrypted: the privacy officer must be able to
-- show whom the incident affected and was notified, §164.414; a keyed hash would not survive an index-key
-- rotation once the record it came from is gone) and when the record was purged (migration 32).
CREATE TABLE IF NOT EXISTS privacy_incident_clients (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES privacy_incidents(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  client_code TEXT,
  client_name_enc TEXT,
  client_purged_at TEXT,
  notified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (incident_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_privacy_incident_clients_client ON privacy_incident_clients(client_id);

-- FHIR SMART Backend Services: each client assertion (private_key_jwt) may be used once. The hash of its jti
-- is kept until the assertion expires (a few minutes), so a captured assertion cannot be replayed, even
-- across a restart. Office server only, never synchronised (server/fhir/jwt.js).
CREATE TABLE IF NOT EXISTS fhir_jwt_assertions (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  jti_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, jti_hash)
);
CREATE INDEX IF NOT EXISTS idx_fhir_jwt_assertions_expires ON fhir_jwt_assertions(expires_at);

-- The register of what the non-consent bases of 42 CFR Part 2 rest on (server/disclosure.js): qualified
-- service organisation agreements (§2.11, §2.12(c)(4)), and the approvals behind research (§2.52: an IRB or
-- privacy board) and audit or evaluation (§2.53: the oversight body). A disclosure on one of those bases
-- names a row here whose organisation (or one of its aliases) is the recipient. Organisations and
-- agreements, not clients: nothing here is PHI. Kept by supervisors and administrators; pulled to devices.
CREATE TABLE IF NOT EXISTS disclosure_agreements (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('qsoa','research','audit_evaluation')),
  organisation TEXT NOT NULL,
  aliases TEXT,                        -- other names the organisation goes by, one per line
  services TEXT,                       -- a QSOA's services; a study's or audit's title
  approving_body TEXT,                 -- the IRB, privacy board or oversight body (research / audit)
  reference TEXT,                      -- protocol or approval number
  agreement_date TEXT NOT NULL,        -- signed / approved
  expires_at TEXT,
  document_ref TEXT,                   -- where the signed agreement or approval letter is kept
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  ended_at TEXT,
  ended_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_disclosure_agreements_updated ON disclosure_agreements(updated_at);
