-- expect: {"version":"1.11.0","schema_version":37,"client":{"id":"1ae3b51c-d7ea-483f-bb13-1bc14887cff2","first_name":"Wren","last_name":"Fixture","dob":"1988-04-12"},"visit":{"id":"26774fbf-77ea-43e5-9da5-857e212d64f4","summary":"Kits handed over at the library","naloxone_kits":2},"note":{"id":"9540fc97-1355-41ea-8a5c-5f0703b34866","content":"Asked about MAT; prefers texts."},"consent":{"id":"d243337b-d423-477d-83f2-2c928043d72e","recipient":"County OTP"},"referral":{"id":"e1ce0361-b4e0-4705-bf27-287986d8fe40","resource_id":"f75d5902-7f2a-4d28-9ba9-ae5cd49ac431"}}
-- SUDS 1.11.0 database (schema 37) made by test/fixtures/make-release-fixture.js. Fictional data, test keys.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO "settings"("key","value","updated_at") VALUES('schema_version','37','2026-09-26T18:08:30.064Z');
INSERT INTO "settings"("key","value","updated_at") VALUES('caseload_restriction','1','2026-09-26T18:08:30.171Z');
INSERT INTO "settings"("key","value","updated_at") VALUES('org_name','County SUD Navigation Program','2026-09-26T18:08:30.171Z');
INSERT INTO "settings"("key","value","updated_at") VALUES('client_code_counter:C26-','1','2026-09-26T18:08:30.452Z');
CREATE TABLE users (
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
  scim_external_id TEXT
);
INSERT INTO "users"("id","username","password_hash","display_name","email","title","role","is_active","mfa_secret_enc","mfa_enabled","failed_attempts","locked_until","must_change_password","password_changed_at","last_login_at","hourly_cost","requires_cosign","supervisor_id","oidc_subject","access_status","access_note","requested_at","created_at","updated_at","idp_seen_at","scim_external_id") VALUES('6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','scrypt$32768$8$1$DYuU0zTdExr6IyyqN9cS/A==$+n8BhSZaxbotdAWsMJvA//68J8MawzuuoaDKsxgo5ZtEqepI8RjOXVfOCMY4cLia7lDrLOr0UHYGFKzbfvzNGw==','System Administrator',NULL,NULL,'admin',1,NULL,0,0,NULL,0,'2026-09-26T18:08:30.169Z','2026-09-26T18:08:30.427Z',NULL,0,NULL,NULL,'active',NULL,NULL,'2026-09-26T18:08:30.170Z','2026-09-26T18:08:30.170Z',NULL,NULL);
CREATE TABLE devices (
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
CREATE TABLE sessions (
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
CREATE TABLE api_keys (
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
CREATE TABLE clients (
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
INSERT INTO "clients"("id","client_code","first_name_enc","last_name_enc","last_name_idx","full_name_idx","name_prefix_idx","name_phonetic_idx","first_name_idx","first_name_prefix_idx","preferred_name_enc","preferred_name_idx","dob_enc","dob_idx","phone_enc","phone_idx","alt_phone_enc","email_enc","address_enc","city","zip","gender","pronouns","race_ethnicity","race_codes","preferred_language","veteran","housing_status","insurance","medicaid_id_enc","emergency_contact_enc","status","intake_date","discharge_date","discharge_reason","referral_source","referral_date","engagement_date","primary_substance","secondary_substances","route_of_use","asam_level","mat_status","mat_medication","overdose_history","last_overdose_date","naloxone_provided","naloxone_last_date","risk_level","justice_involved","pregnant_or_parenting","co_occurring_mh","goals_enc","flags_enc","contact_preferences_enc","ok_to_text","ok_to_voicemail","created_by","merged_into","legal_hold","legal_hold_reason_enc","legal_hold_cleared_reason_enc","removed_reason_enc","created_at","updated_at","deleted_at") VALUES('1ae3b51c-d7ea-483f-bb13-1bc14887cff2','C26-0001','v1:ScOwNHhTHZW8C4Ds:2IT9e+Yov7lI5Vu0KgBucw==:bQZf2A==','v1:vaT5Htg4NZ0Oal5X:TD9QiUU7lCT3Cu1JaolNow==:ToJjbo8quQ==','d937786d783cc7d97d27d7b45d00995d6d3bf654b31e273cbde646ed3b30f086','0b18fd73ab66a6bd1e611148e3204e53815248c79940dba9e256c38d1fc10736','7064ad8db172f5a8ea96174675757fc4050a6fe8ba8a742ce236e6bec345f299','d7813d8d23bf6b948526b3218c421f0ba5d38d10ee9e35ff3bf35153fbf3f6b0','ad0bf3b0bc8cdf37710fa82f5cdc99f32bd02e87d4892bd321a7c4b6dad027f4','402d8963f97a9682de368d50898fd1c72e60cb7fd57a42d1fa860d5f0d03faef',NULL,NULL,'v1:i/FE37nPdW+Un5ln:CefenToM33p3iobqsqkLPg==:f+F616mviXFBmg==','540d49604e89d70f2cceb59cb862c3fca1035c03d4eb85afd7aa8cbcdab61bb6','v1:cd21tj/vECpeGzlr:cNO3gsWHfHq0nLRc/qyRbg==:SwMW5m2xuVgS8DKB1v0=','63dcf790b61a8078c340ffd5e532281bdfdf362e0bb4522034ff72ff96ccd01f',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'English',0,NULL,NULL,NULL,NULL,'active','2026-08-01',NULL,NULL,NULL,NULL,NULL,'opioids_fentanyl',NULL,NULL,NULL,NULL,NULL,0,NULL,1,'2026-08-02','high',0,0,0,NULL,NULL,NULL,0,0,'6927e20d-52a2-4935-9ee7-f8538b3c80ab',NULL,0,NULL,NULL,NULL,'2026-09-26T18:08:30.453Z','2026-09-26T18:08:30.462Z',NULL);
CREATE TABLE assignments (
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
CREATE TABLE funding_sources (
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
CREATE TABLE budget_lines (
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
CREATE TABLE interventions (
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
INSERT INTO "interventions"("id","client_id","user_id","type","occurred_at","duration_minutes","location","modality","outcome","stage_of_change","naloxone_kits","fentanyl_strips","funding_source_id","budget_line_id","cost","summary_enc","follow_up_due","created_at","updated_at") VALUES('26774fbf-77ea-43e5-9da5-857e212d64f4','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','6927e20d-52a2-4935-9ee7-f8538b3c80ab','naloxone_distribution','2026-08-02T15:00:00.000Z',20,'office','in_person',NULL,NULL,2,0,NULL,NULL,0,'v1:g7Bw1jNIwLajxP44:sQ7aYVgLAVKX0PcgRbYXJQ==:/JYQZr/CDGZ/srdqTH4xj/XLe5pk/hfYJydLWQXclg==',NULL,'2026-09-26T18:08:30.461Z','2026-09-26T18:08:30.461Z');
CREATE TABLE calls (
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
CREATE TABLE time_entries (
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
CREATE TABLE resources (
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
INSERT INTO "resources"("id","name","category","organization","phone","fax","email","website","address","city","zip","hours","eligibility","services","languages","accepts_medicaid","accepts_uninsured","mat_offered","capacity_notes","contact_person","summary","service_tags","levels_of_care","populations","intake_process","cost_notes","is_active","last_verified_at","notes","created_at","updated_at") VALUES('f75d5902-7f2a-4d28-9ba9-ae5cd49ac431','County OTP','mat_otp',NULL,'555-0199',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL,'2026-09-26T18:08:30.479Z','2026-09-26T18:08:30.479Z');
CREATE TABLE resource_photos (
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
CREATE TABLE policy_documents (
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
CREATE TABLE referrals (
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
INSERT INTO "referrals"("id","client_id","resource_id","user_id","referred_at","status","urgency","appointment_at","admitted_at","closed_at","outcome_enc","barrier_enc","warm_handoff","consent_id","consent_revoked","follow_up_due","outcome_recorded_at","episode_id","notes_enc","created_at","updated_at") VALUES('e1ce0361-b4e0-4705-bf27-287986d8fe40','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','f75d5902-7f2a-4d28-9ba9-ae5cd49ac431','6927e20d-52a2-4935-9ee7-f8538b3c80ab','2026-08-03T09:00:00.000Z','pending','urgent',NULL,NULL,NULL,NULL,NULL,1,'d243337b-d423-477d-83f2-2c928043d72e',0,'2026-09-29',NULL,NULL,NULL,'2026-09-26T18:08:30.485Z','2026-09-26T18:08:30.485Z');
CREATE TABLE tasks (
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
INSERT INTO "tasks"("id","client_id","assigned_to","created_by","title_enc","description_enc","due_at","priority","status","is_milestone","completed_at","created_at","updated_at","referral_id") VALUES('e1c54825-2623-4b43-8a91-ec30b6de3e33','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','6927e20d-52a2-4935-9ee7-f8538b3c80ab','6927e20d-52a2-4935-9ee7-f8538b3c80ab','v1:XEghOlWDk7I1QSqD:k9Ia7r2OlZtk+juFcGdGEA==:TmY41gb3326r/WlXLIIGfgSv0NRAZI5Vq/u12I5kMU0rSkI=',NULL,'2026-09-29','normal','open',0,NULL,'2026-09-26T18:08:30.486Z','2026-09-26T18:08:30.486Z','e1ce0361-b4e0-4705-bf27-287986d8fe40');
CREATE TABLE expenditures (
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','reimbursed')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE notes (
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
INSERT INTO "notes"("id","client_id","author_id","kind","format","title_enc","content_enc","structured_enc","occurred_at","status","signed_at","signed_by","signature_hash","cosign_required","cosigned_by","cosigned_at","cosignature_hash","cosign_note_enc","cosign_requested","source","source_ref","import_item_id","intervention_id","call_id","part2_protected","counseling_note","created_at","updated_at","deleted_at","problem_ids") VALUES('9540fc97-1355-41ea-8a5c-5f0703b34866','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','narrative','v1:a5dDS+dJAz3irRfE:bCEr7YqVL3fSVzSUQtzqqg==:CAVywYBo4iPBZ80=','v1:JAPkT4n6aTf6iZ8M:dZ6Y6KdFM+FwpNbZAHA4yA==:4SWK4JL4iUcSIccqZf+2Cezp4nOGsrU9yRrXIknppw==',NULL,'2026-08-02T15:30:00.000Z','draft',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,0,'manual',NULL,NULL,NULL,NULL,1,0,'2026-09-26T18:08:30.469Z','2026-09-26T18:08:30.469Z',NULL,NULL);
CREATE TABLE note_addenda (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content_enc TEXT NOT NULL,
  reason_enc TEXT,                     -- why the addendum was needed (free text): encrypted
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE consents (
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
INSERT INTO "consents"("id","client_id","type","recipient_enc","purpose_enc","scope_enc","signed_at","expires_at","expires_event","revoked_at","revoked_reason_enc","document_ref","witness","signed_on_paper","redisclosure_notice_given","discloser","signer_relationship","signer_name_enc","revocation_right_given","refusal_consequences_given","rule_version","info_categories","revoked_by","created_by","created_at","updated_at") VALUES('d243337b-d423-477d-83f2-2c928043d72e','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','part2_disclosure','v1:zkztyhbMyaJOd4DD:rsXvZHYhk0qfv9Qjzho0Gg==:eepKCNWpW7pYfw==','v1:c3PjhOfetE/eRUzg:gwDcH3FBjQ8f9ncqirpOmg==:b2lQlE4+94Mx1Lhc','v1:1ucjmrMnpL6hvBnU:z+l8stKFy7Fq0zsK/VL/ig==:DPWKGsLibgp5Sw8hCNnV1BGHj6NTbau2hZo65xN4+w==','2026-08-01','2027-08-01',NULL,NULL,NULL,NULL,NULL,1,1,'County SUD Navigation Program','patient',NULL,1,1,'2024',NULL,NULL,'6927e20d-52a2-4935-9ee7-f8538b3c80ab','2026-09-26T18:08:30.475Z','2026-09-26T18:08:30.475Z');
CREATE TABLE court_orders (
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
CREATE TABLE disclosures (
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
INSERT INTO "disclosures"("id","client_id","consent_id","recipient_enc","purpose_enc","what_enc","method","disclosed_at","disclosed_by","basis","justification_enc","source","source_ref","court_order_id","legal_proceeding","counseling_notes","notice_version","created_at","updated_at") VALUES('47bf7d82-2c62-4369-a1d6-30f8b4917ffc','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','d243337b-d423-477d-83f2-2c928043d72e','v1:S9aTGZs3KNojTtlp:S2zK/DhdOOtVy4rT4l0zdA==:jn/UdaX3hrJyIw==','v1:UCPNCzam8YmF4crd:P8kpob0tvqKZ0NFaB4BSSA==:hrrNJLkIJhToAIP65mTe3vqnvlYe','v1:qbcrT7322Z/DXOUy:4lw/b9PQDLKtVnunCMmCDQ==:2M3iOh+g7XmL5065fNKG0ENuaCFIX3wAnMK6ft4/hdN71QoUM5hu89UnzuFEQE2FbnHCFWXhEm+eUvFsaehpKA==','warm handoff','2026-09-26T18:08:30.485Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','consent',NULL,'referral','e1ce0361-b4e0-4705-bf27-287986d8fe40',NULL,0,0,'2024','2026-09-26T18:08:30.485Z','2026-09-26T18:08:30.485Z');
CREATE TABLE form_templates (
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
CREATE TABLE client_forms (
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
CREATE TABLE client_form_files (
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
CREATE TABLE imports (
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
CREATE TABLE import_items (
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
CREATE TABLE import_rows (
  row_hash TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  record_id TEXT,
  imported_by TEXT,                    -- the user id; no FK, this table is server-side bookkeeping only
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE audit_log (
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
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(1,'2026-09-26T18:08:30.430Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','auth.login',NULL,NULL,NULL,'127.0.0.1',1,NULL,'GENESIS','v2:f8e34425330bf55a34a7d704c9d8df48b3d6abc1ed4d29f4bdd12c380532ded4');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(2,'2026-09-26T18:08:30.454Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','client.create','client','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','127.0.0.1',1,'{"episode":"5a3ce2e3-1e99-41f1-9014-e188a0c03d60"}','v2:f8e34425330bf55a34a7d704c9d8df48b3d6abc1ed4d29f4bdd12c380532ded4','v2:bd569cbbd996a14392932c5ec44091cbd9050364155a5fd12bc12395457f4f00');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(3,'2026-09-26T18:08:30.455Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','episode.open','episode','5a3ce2e3-1e99-41f1-9014-e188a0c03d60','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','127.0.0.1',1,'{"at_intake":true}','v2:bd569cbbd996a14392932c5ec44091cbd9050364155a5fd12bc12395457f4f00','v2:ddd0d807b5d75f3e8c34cc3627eb90ea862ccb440132c50b72c5fa4531908e51');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(4,'2026-09-26T18:08:30.463Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','intervention.create','intervention','26774fbf-77ea-43e5-9da5-857e212d64f4','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','127.0.0.1',1,NULL,'v2:ddd0d807b5d75f3e8c34cc3627eb90ea862ccb440132c50b72c5fa4531908e51','v2:4cdbae496f5867b8b7749882c7f21e2a6b695134e5ddda11cb339b4fbf5fe5df');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(5,'2026-09-26T18:08:30.470Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','note.create','note','9540fc97-1355-41ea-8a5c-5f0703b34866','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','127.0.0.1',1,'{"kind":"admin"}','v2:4cdbae496f5867b8b7749882c7f21e2a6b695134e5ddda11cb339b4fbf5fe5df','v2:32e12fbe41506ba066ce714c01101da21b4a29fa23f04bd76b29e0801f2c2e87');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(6,'2026-09-26T18:08:30.475Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','consent.create','consent','d243337b-d423-477d-83f2-2c928043d72e','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','127.0.0.1',1,'{"type":"part2_disclosure","rule_version":"2024"}','v2:32e12fbe41506ba066ce714c01101da21b4a29fa23f04bd76b29e0801f2c2e87','v2:a2fd362bda1ee6bd7e9ae3be5955b4d1a125087d66e2786561f58ea709c35e1c');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(7,'2026-09-26T18:08:30.479Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','resource.create','resource','f75d5902-7f2a-4d28-9ba9-ae5cd49ac431',NULL,'127.0.0.1',1,NULL,'v2:a2fd362bda1ee6bd7e9ae3be5955b4d1a125087d66e2786561f58ea709c35e1c','v2:345c859a694e15c73ddce812be131219430db0658d1f44c2d70a0834ab6b4a4b');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(8,'2026-09-26T18:08:30.486Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','disclosure.record','disclosure','47bf7d82-2c62-4369-a1d6-30f8b4917ffc','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','127.0.0.1',1,'{"basis":"consent","source":"referral","consent_id":"d243337b-d423-477d-83f2-2c928043d72e","notice":"2024"}','v2:345c859a694e15c73ddce812be131219430db0658d1f44c2d70a0834ab6b4a4b','v2:38c4042f465caf614ffb30e330023ce159fd021f3025ab612968d2b4f89d5343');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(9,'2026-09-26T18:08:30.487Z','6927e20d-52a2-4935-9ee7-f8538b3c80ab','admin','referral.create','referral','e1ce0361-b4e0-4705-bf27-287986d8fe40','1ae3b51c-d7ea-483f-bb13-1bc14887cff2','127.0.0.1',1,NULL,'v2:38c4042f465caf614ffb30e330023ce159fd021f3025ab612968d2b4f89d5343','v2:99a27c10cbc568f042a17d84d86f88101b5bf53eeb5485fe93a7de5c7b5a5a96');
CREATE TABLE audit_maintenance (
  purpose TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE user_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, key)
);
CREATE TABLE episodes (
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
INSERT INTO "episodes"("id","client_id","funding_source_id","opened_at","opened_by","referral_source","presenting_problem_enc","closed_at","closed_by","discharge_reason","discharge_disposition","discharge_summary_enc","reopen_reason_enc","status","created_at","updated_at") VALUES('5a3ce2e3-1e99-41f1-9014-e188a0c03d60','1ae3b51c-d7ea-483f-bb13-1bc14887cff2',NULL,'2026-08-01','6927e20d-52a2-4935-9ee7-f8538b3c80ab',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'open','2026-09-26T18:08:30.453Z','2026-09-26T18:08:30.453Z');
CREATE TABLE caloms_records (
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
CREATE TABLE caloms_submissions (
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
CREATE TABLE overdose_events (
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
CREATE TABLE supply_stock (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL UNIQUE COLLATE NOCASE,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (table_name, id));
CREATE TABLE breakglass_events (
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
CREATE TABLE patient_requests (
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
CREATE TABLE idempotency_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE option_overrides (
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
CREATE TABLE problems (
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
CREATE TABLE problem_history (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created','updated')),
  changes_enc TEXT,
  changed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE care_plan_goals (
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
CREATE TABLE care_plan_steps (
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
CREATE TABLE asam_assessments (
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
CREATE TABLE outcome_measures (
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
CREATE TABLE part2_notices (
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
CREATE TABLE complaints (
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
CREATE TABLE privacy_incidents (
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
CREATE TABLE privacy_incident_clients (
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
CREATE TABLE fhir_jwt_assertions (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  jti_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, jti_hash)
);
CREATE TABLE disclosure_agreements (
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
CREATE UNIQUE INDEX idx_users_oidc_subject ON users(oidc_subject) WHERE oidc_subject IS NOT NULL;
CREATE UNIQUE INDEX idx_users_scim_external_id ON users(scim_external_id) WHERE scim_external_id IS NOT NULL;
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_clients_last_name ON clients(last_name_idx);
CREATE INDEX idx_clients_phone ON clients(phone_idx);
CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_assignments_updated ON assignments(updated_at);
CREATE INDEX idx_assign_client ON assignments(client_id);
CREATE INDEX idx_assign_user ON assignments(user_id);
CREATE INDEX idx_budget_lines_updated ON budget_lines(updated_at);
CREATE INDEX idx_budget_lines_parent ON budget_lines(parent_id);
CREATE INDEX idx_interventions_client ON interventions(client_id, occurred_at);
CREATE INDEX idx_interventions_user ON interventions(user_id, occurred_at);
CREATE INDEX idx_interventions_occurred ON interventions(occurred_at);
CREATE INDEX idx_interventions_updated ON interventions(updated_at);
CREATE INDEX idx_calls_client ON calls(client_id, started_at);
CREATE INDEX idx_calls_user ON calls(user_id, started_at);
CREATE INDEX idx_calls_started ON calls(started_at);
CREATE INDEX idx_calls_updated ON calls(updated_at);
CREATE INDEX idx_time_user ON time_entries(user_id, work_date);
CREATE INDEX idx_time_status ON time_entries(status, work_date);
CREATE INDEX idx_time_updated ON time_entries(updated_at);
CREATE INDEX idx_time_client ON time_entries(client_id);
CREATE INDEX idx_resources_cat ON resources(category);
CREATE INDEX idx_resource_photos ON resource_photos(resource_id, sort_order);
CREATE INDEX idx_policy_documents_cat ON policy_documents(category);
CREATE INDEX idx_policy_documents_updated ON policy_documents(updated_at);
CREATE INDEX idx_referrals_client ON referrals(client_id);
CREATE INDEX idx_referrals_status ON referrals(status);
CREATE INDEX idx_tasks_assignee ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_client ON tasks(client_id);
CREATE INDEX idx_exp_fund ON expenditures(funding_source_id, spent_at);
CREATE INDEX idx_exp_client ON expenditures(client_id);
CREATE UNIQUE INDEX idx_exp_intervention_unique ON expenditures(intervention_id) WHERE intervention_id IS NOT NULL;
CREATE INDEX idx_notes_client ON notes(client_id, occurred_at);
CREATE INDEX idx_notes_author ON notes(author_id);
CREATE INDEX idx_note_addenda_updated ON note_addenda(updated_at);
CREATE INDEX idx_consents_client ON consents(client_id);
CREATE INDEX idx_consents_updated ON consents(updated_at);
CREATE INDEX idx_court_orders_client ON court_orders(client_id);
CREATE INDEX idx_court_orders_updated ON court_orders(updated_at);
CREATE INDEX idx_disclosures_client ON disclosures(client_id);
CREATE INDEX idx_disclosures_updated ON disclosures(updated_at);
CREATE INDEX idx_client_forms_client ON client_forms(client_id);
CREATE INDEX idx_client_form_files ON client_form_files(client_form_id);
CREATE INDEX idx_imports_updated ON imports(updated_at);
CREATE INDEX idx_import_items_updated ON import_items(updated_at);
CREATE INDEX idx_import_items ON import_items(import_id, status);
CREATE INDEX idx_import_rows_entity ON import_rows(entity, imported_at);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_client ON audit_log(client_id);
CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  WHEN NOT EXISTS (SELECT 1 FROM audit_maintenance)
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: entries cannot be changed'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  WHEN NOT EXISTS (SELECT 1 FROM audit_maintenance)
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: entries are removed only by the retention purge'); END;
CREATE INDEX idx_clients_updated ON clients(updated_at);
CREATE INDEX idx_clients_full_name_idx ON clients(full_name_idx);
CREATE INDEX idx_clients_name_prefix ON clients(name_prefix_idx);
CREATE INDEX idx_clients_name_phonetic ON clients(name_phonetic_idx);
CREATE INDEX idx_clients_first_name ON clients(first_name_idx);
CREATE INDEX idx_clients_first_name_prefix ON clients(first_name_prefix_idx);
CREATE INDEX idx_clients_preferred_name ON clients(preferred_name_idx);
CREATE INDEX idx_resources_updated ON resources(updated_at);
CREATE INDEX idx_resource_photos_updated ON resource_photos(updated_at);
CREATE INDEX idx_funding_sources_updated ON funding_sources(updated_at);
CREATE INDEX idx_referrals_updated ON referrals(updated_at);
CREATE INDEX idx_tasks_updated ON tasks(updated_at);
CREATE INDEX idx_expenditures_updated ON expenditures(updated_at);
CREATE INDEX idx_notes_updated ON notes(updated_at);
CREATE INDEX idx_form_templates_updated ON form_templates(updated_at);
CREATE INDEX idx_client_forms_updated ON client_forms(updated_at);
CREATE INDEX idx_client_form_files_updated ON client_form_files(updated_at);
CREATE INDEX idx_users_updated ON users(updated_at);
CREATE INDEX idx_episodes_client ON episodes(client_id, opened_at);
CREATE INDEX idx_episodes_status ON episodes(status);
CREATE INDEX idx_episodes_updated ON episodes(updated_at);
CREATE INDEX idx_caloms_records_episode ON caloms_records(episode_id, record_type);
CREATE INDEX idx_caloms_records_date ON caloms_records(record_date);
CREATE INDEX idx_caloms_records_updated ON caloms_records(updated_at);
CREATE UNIQUE INDEX idx_caloms_records_one_per_episode ON caloms_records(episode_id, record_type) WHERE record_type IN ('admission','discharge');
CREATE INDEX idx_caloms_submissions_created ON caloms_submissions(created_at);
CREATE INDEX idx_overdose_client ON overdose_events(client_id, occurred_at);
CREATE INDEX idx_overdose_occurred ON overdose_events(occurred_at);
CREATE INDEX idx_overdose_updated ON overdose_events(updated_at);
CREATE INDEX idx_supply_stock_updated ON supply_stock(updated_at);
CREATE INDEX idx_tombstones_at ON tombstones(deleted_at);
CREATE INDEX idx_breakglass_open ON breakglass_events(acknowledged_at, at);
CREATE INDEX idx_patient_requests_client ON patient_requests(client_id);
CREATE INDEX idx_patient_requests_updated ON patient_requests(updated_at);
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
CREATE INDEX idx_option_overrides_updated ON option_overrides(updated_at);
CREATE INDEX idx_problems_client ON problems(client_id, status);
CREATE INDEX idx_problems_updated ON problems(updated_at);
CREATE INDEX idx_problem_history_problem ON problem_history(problem_id, created_at);
CREATE INDEX idx_problem_history_updated ON problem_history(updated_at);
CREATE INDEX idx_care_plan_goals_client ON care_plan_goals(client_id, status);
CREATE INDEX idx_care_plan_goals_updated ON care_plan_goals(updated_at);
CREATE INDEX idx_care_plan_steps_goal ON care_plan_steps(goal_id);
CREATE INDEX idx_care_plan_steps_updated ON care_plan_steps(updated_at);
CREATE INDEX idx_asam_client ON asam_assessments(client_id, assessed_at);
CREATE INDEX idx_asam_updated ON asam_assessments(updated_at);
CREATE INDEX idx_outcome_measures_client ON outcome_measures(client_id, instrument, administered_at);
CREATE INDEX idx_outcome_measures_updated ON outcome_measures(updated_at);
CREATE INDEX idx_part2_notices_client ON part2_notices(client_id);
CREATE INDEX idx_part2_notices_updated ON part2_notices(updated_at);
CREATE INDEX idx_complaints_status ON complaints(status, received_at);
CREATE INDEX idx_complaints_client ON complaints(client_id);
CREATE INDEX idx_privacy_incidents_status ON privacy_incidents(status, discovered_at);
CREATE INDEX idx_privacy_incident_clients_client ON privacy_incident_clients(client_id);
CREATE INDEX idx_fhir_jwt_assertions_expires ON fhir_jwt_assertions(expires_at);
CREATE INDEX idx_disclosure_agreements_updated ON disclosure_agreements(updated_at);
COMMIT;
