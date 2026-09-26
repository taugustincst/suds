-- expect: {"version":"1.9.4","schema_version":24,"client":{"id":"4dc53092-ff63-4993-a0a8-c55cadd189bc","first_name":"Wren","last_name":"Fixture","dob":"1988-04-12"},"visit":{"id":"37d8f7c6-fd8f-4885-8f65-dcf755493ba4","summary":"Kits handed over at the library","naloxone_kits":2},"note":{"id":"0bf6b343-e1d5-442d-80ee-b0da380a5a67","content":"Asked about MAT; prefers texts."},"consent":{"id":"0278fb9e-97c3-4c51-b747-2b31db28fb38","recipient":"County OTP"},"referral":{"id":"ec55aee7-d512-4529-bf7b-c9c3d91bce93","resource_id":"d614ac47-2e5d-423d-b8bd-b64de507c860"}}
-- SUDS 1.9.4 database (schema 24) made by test/fixtures/make-release-fixture.js. Fictional data, test keys.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO "settings"("key","value","updated_at") VALUES('schema_version','24','2026-09-26T18:08:30.643Z');
INSERT INTO "settings"("key","value","updated_at") VALUES('caseload_restriction','1','2026-09-26T18:08:30.733Z');
INSERT INTO "settings"("key","value","updated_at") VALUES('org_name','County SUD Navigation Program','2026-09-26T18:08:30.733Z');
INSERT INTO "settings"("key","value","updated_at") VALUES('client_code_counter:C26-','1','2026-09-26T18:08:30.945Z');
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO "users"("id","username","password_hash","display_name","email","title","role","is_active","mfa_secret_enc","mfa_enabled","failed_attempts","locked_until","must_change_password","password_changed_at","last_login_at","hourly_cost","requires_cosign","supervisor_id","oidc_subject","created_at","updated_at") VALUES('3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','scrypt$32768$8$1$tNUjGIihXQBT5oEIbjalMA==$W4ZSkk7aOhjCqyhEo5tfZZgTSV2MyzavliA/qaZpi4GTWkmTZHQ6+Y52DagF3TKwnkrHjcTyO/wqI1shdL+26A==','System Administrator',NULL,NULL,'admin',1,NULL,0,0,NULL,0,'2026-09-26T18:08:30.731Z','2026-09-26T18:08:30.927Z',NULL,0,NULL,NULL,'2026-09-26T18:08:30.732Z','2026-09-26T18:08:30.732Z');
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
  revoked_at TEXT
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
INSERT INTO "clients"("id","client_code","first_name_enc","last_name_enc","last_name_idx","full_name_idx","name_prefix_idx","name_phonetic_idx","first_name_idx","first_name_prefix_idx","preferred_name_enc","preferred_name_idx","dob_enc","dob_idx","phone_enc","phone_idx","alt_phone_enc","email_enc","address_enc","city","zip","gender","pronouns","race_ethnicity","race_codes","preferred_language","veteran","housing_status","insurance","medicaid_id_enc","emergency_contact_enc","status","intake_date","discharge_date","discharge_reason","referral_source","referral_date","engagement_date","primary_substance","secondary_substances","route_of_use","asam_level","mat_status","mat_medication","overdose_history","last_overdose_date","naloxone_provided","naloxone_last_date","risk_level","justice_involved","pregnant_or_parenting","co_occurring_mh","goals_enc","flags_enc","contact_preferences","ok_to_text","ok_to_voicemail","created_by","merged_into","legal_hold","legal_hold_reason","created_at","updated_at","deleted_at") VALUES('4dc53092-ff63-4993-a0a8-c55cadd189bc','C26-0001','v1:Nt/+S7kLnRPxzElK:lXpEFpRZOgOj+G7MckQ+aA==:IPPxAQ==','v1:pqfzPY3gwwP5a77i:kZbhDPpR6cJ6Pj8C8qi4yA==:hoA5MBaLFQ==','d937786d783cc7d97d27d7b45d00995d6d3bf654b31e273cbde646ed3b30f086','0b18fd73ab66a6bd1e611148e3204e53815248c79940dba9e256c38d1fc10736','7064ad8db172f5a8ea96174675757fc4050a6fe8ba8a742ce236e6bec345f299','d7813d8d23bf6b948526b3218c421f0ba5d38d10ee9e35ff3bf35153fbf3f6b0','ad0bf3b0bc8cdf37710fa82f5cdc99f32bd02e87d4892bd321a7c4b6dad027f4','402d8963f97a9682de368d50898fd1c72e60cb7fd57a42d1fa860d5f0d03faef',NULL,NULL,'v1:5nt8DBcR6hQrxIH6:D6wm6FkNUmDib5MQH4ik+w==:UxR45IWs2A529w==','540d49604e89d70f2cceb59cb862c3fca1035c03d4eb85afd7aa8cbcdab61bb6','v1:lKFtHaWKXZRJzmq+:fe85kcyPoYTlWpG/CnpY3Q==:JO+M1ovxfcSq2QDfLBI=','63dcf790b61a8078c340ffd5e532281bdfdf362e0bb4522034ff72ff96ccd01f',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'English',0,NULL,NULL,NULL,NULL,'active','2026-08-01',NULL,NULL,NULL,NULL,NULL,'opioids_fentanyl',NULL,NULL,NULL,NULL,NULL,0,NULL,1,'2026-08-02','high',0,0,0,NULL,NULL,NULL,0,0,'3670ca01-0ebf-4cc1-ac2a-73d1c81d2163',NULL,0,NULL,'2026-09-26T18:08:30.946Z','2026-09-26T18:08:30.952Z',NULL);
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
  notes TEXT,
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
INSERT INTO "interventions"("id","client_id","user_id","type","occurred_at","duration_minutes","location","modality","outcome","stage_of_change","naloxone_kits","fentanyl_strips","funding_source_id","budget_line_id","cost","summary_enc","follow_up_due","created_at","updated_at") VALUES('37d8f7c6-fd8f-4885-8f65-dcf755493ba4','4dc53092-ff63-4993-a0a8-c55cadd189bc','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','naloxone_distribution','2026-08-02T15:00:00.000Z',20,'office','in_person',NULL,NULL,2,0,NULL,NULL,0,'v1:EUvHPoeh4NBaobFO:iNjvxq7YuqBJ/wsnKZdZmA==:MQpJBZGqVVUK1JA6yuFJVSDynaxUPmBMBSIIyppmhg==',NULL,'2026-09-26T18:08:30.952Z','2026-09-26T18:08:30.952Z');
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
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_at TEXT,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
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
INSERT INTO "resources"("id","name","category","organization","phone","fax","email","website","address","city","zip","hours","eligibility","services","languages","accepts_medicaid","accepts_uninsured","mat_offered","capacity_notes","contact_person","summary","service_tags","levels_of_care","populations","intake_process","cost_notes","is_active","last_verified_at","notes","created_at","updated_at") VALUES('d614ac47-2e5d-423d-b8bd-b64de507c860','County OTP','mat_otp',NULL,'555-0199',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL,'2026-09-26T18:08:30.970Z','2026-09-26T18:08:30.970Z');
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
INSERT INTO "referrals"("id","client_id","resource_id","user_id","referred_at","status","urgency","appointment_at","admitted_at","closed_at","outcome_enc","barrier_enc","warm_handoff","consent_id","consent_revoked","follow_up_due","outcome_recorded_at","episode_id","notes_enc","created_at","updated_at") VALUES('ec55aee7-d512-4529-bf7b-c9c3d91bce93','4dc53092-ff63-4993-a0a8-c55cadd189bc','d614ac47-2e5d-423d-b8bd-b64de507c860','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','2026-08-03T09:00:00.000Z','pending','urgent',NULL,NULL,NULL,NULL,NULL,1,'0278fb9e-97c3-4c51-b747-2b31db28fb38',0,'2026-09-29',NULL,NULL,NULL,'2026-09-26T18:08:30.974Z','2026-09-26T18:08:30.974Z');
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
INSERT INTO "tasks"("id","client_id","assigned_to","created_by","title_enc","description_enc","due_at","priority","status","is_milestone","completed_at","created_at","updated_at","referral_id") VALUES('804763ac-506f-446d-b830-fdf81e792a45','4dc53092-ff63-4993-a0a8-c55cadd189bc','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','v1:6gIO04exUDzeI01e:Nl1Ts79bX9jYw3XvVcy5Zg==:RVSHJ/Fk2J4xjGMoIiIapd3Vgi5ncg6qOnp9BBhf3VvdJs4=',NULL,'2026-09-29','normal','open',0,NULL,'2026-09-26T18:08:30.975Z','2026-09-26T18:08:30.975Z','ec55aee7-d512-4529-bf7b-c9c3d91bce93');
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
  description TEXT,
  receipt_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','reimbursed')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  approval_note TEXT,
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
INSERT INTO "notes"("id","client_id","author_id","kind","format","title_enc","content_enc","structured_enc","occurred_at","status","signed_at","signed_by","signature_hash","cosign_required","cosigned_by","cosigned_at","cosignature_hash","cosign_note","cosign_requested","source","source_ref","import_item_id","intervention_id","call_id","part2_protected","created_at","updated_at","deleted_at") VALUES('0bf6b343-e1d5-442d-80ee-b0da380a5a67','4dc53092-ff63-4993-a0a8-c55cadd189bc','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','narrative','v1:FZvaJFCGt3ezcpDK:5jp8oxMqdqokkHd4dLa2nA==:1+rB45ITpMPNuRc=','v1:BZjpbvOKyitkhKVH:v0tlZ9Zax0m/a9OGGofA2w==:8cs10y8iC9f/eJNrMBsmS3wNIbcyogB/jwCy5nA7DQ==',NULL,'2026-08-02T15:30:00.000Z','draft',NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,0,'manual',NULL,NULL,NULL,NULL,1,'2026-09-26T18:08:30.957Z','2026-09-26T18:08:30.957Z',NULL);
CREATE TABLE note_addenda (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content_enc TEXT NOT NULL,
  reason TEXT,
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
INSERT INTO "consents"("id","client_id","type","recipient_enc","purpose_enc","scope_enc","signed_at","expires_at","expires_event","revoked_at","revoked_reason","document_ref","witness","signed_on_paper","redisclosure_notice_given","revoked_by","created_by","created_at","updated_at") VALUES('0278fb9e-97c3-4c51-b747-2b31db28fb38','4dc53092-ff63-4993-a0a8-c55cadd189bc','part2_disclosure','v1:dTv5JKg8JLejnk6a:fdl7zdxB9FD1OxK8uygpPg==:TWDBM4sfzU1+Hg==','v1:gFygN5xoEGuLSwjc:rfU2Wc6Ep5Cj5ubjP9uKlg==:/6aNXOfbOQXiEuFe','v1:hCTLFr7O5JUF7lTn:3n2o0+e7V86wEqCVzYLDwQ==:ZQekS+YxwQbp07Y4aAWybb34e5hdSs/0FKWT5IKIrw==','2026-08-01','2027-08-01',NULL,NULL,NULL,NULL,NULL,1,1,NULL,'3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','2026-09-26T18:08:30.966Z','2026-09-26T18:08:30.966Z');
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO "disclosures"("id","client_id","consent_id","recipient_enc","purpose_enc","what_enc","method","disclosed_at","disclosed_by","basis","justification_enc","source","source_ref","created_at","updated_at") VALUES('2805cb89-22d2-47eb-95c6-dc57aad16e6d','4dc53092-ff63-4993-a0a8-c55cadd189bc','0278fb9e-97c3-4c51-b747-2b31db28fb38','v1:5ef814sypWJrgq78:YoF4tnLP3K0Nml7d9KuYMg==:ZvxQrR+RHKDqSA==','v1:qi3olhG+SWKdTSnb:Fzr2X/uB1RxFZ9m2C+/IPA==:Uxa5+KK6AF/33Aj/f1cJRU+MSkov','v1:FrSaOkuuRnKROZJl:YFazVGg9zuAtFrYgDPGOag==:ZSOpaW1zp+2dSlF+0MOX7yViu49lRmEh8C6mjlYzadcetLbo9IaLCFsiMNlLGEpTmAB9I3ZczLVpOhCJsfVvAA==','warm handoff','2026-09-26T18:08:30.974Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','consent',NULL,'referral','ec55aee7-d512-4529-bf7b-c9c3d91bce93','2026-09-26T18:08:30.975Z','2026-09-26T18:08:30.975Z');
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
  notes TEXT,
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
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(1,'2026-09-26T18:08:30.929Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','auth.login',NULL,NULL,NULL,'127.0.0.1',1,NULL,'GENESIS','v2:791a0fca39327c5ba4e22181e6235529d80c2328d603448f26c38d8872cf207d');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(2,'2026-09-26T18:08:30.947Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','client.create','client','4dc53092-ff63-4993-a0a8-c55cadd189bc','4dc53092-ff63-4993-a0a8-c55cadd189bc','127.0.0.1',1,'{"episode":"718a4644-3f63-49b1-90fd-662680416204"}','v2:791a0fca39327c5ba4e22181e6235529d80c2328d603448f26c38d8872cf207d','v2:811821978b48cc0cdc8b1a66604008fbf154abd899e4919bff7810d97dda8aee');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(3,'2026-09-26T18:08:30.947Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','episode.open','episode','718a4644-3f63-49b1-90fd-662680416204','4dc53092-ff63-4993-a0a8-c55cadd189bc','127.0.0.1',1,'{"at_intake":true}','v2:811821978b48cc0cdc8b1a66604008fbf154abd899e4919bff7810d97dda8aee','v2:a7cffd60fe398ca27f5e51daf5004d13ab121cbfb31cfb0f7c3da791aed4c40c');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(4,'2026-09-26T18:08:30.954Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','intervention.create','intervention','37d8f7c6-fd8f-4885-8f65-dcf755493ba4','4dc53092-ff63-4993-a0a8-c55cadd189bc','127.0.0.1',1,NULL,'v2:a7cffd60fe398ca27f5e51daf5004d13ab121cbfb31cfb0f7c3da791aed4c40c','v2:55e0e7fbf1b97bc97072cad24811ee52a045f1e5fb77127ef3482401560b3719');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(5,'2026-09-26T18:08:30.958Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','note.create','note','0bf6b343-e1d5-442d-80ee-b0da380a5a67','4dc53092-ff63-4993-a0a8-c55cadd189bc','127.0.0.1',1,'{"kind":"admin"}','v2:55e0e7fbf1b97bc97072cad24811ee52a045f1e5fb77127ef3482401560b3719','v2:72041575da7ac55d372252b62c9a36bcd99c77950979913cf42a6a74800a16e8');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(6,'2026-09-26T18:08:30.966Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','consent.create','consent','0278fb9e-97c3-4c51-b747-2b31db28fb38','4dc53092-ff63-4993-a0a8-c55cadd189bc','127.0.0.1',1,'{"type":"part2_disclosure"}','v2:72041575da7ac55d372252b62c9a36bcd99c77950979913cf42a6a74800a16e8','v2:f72f6c0431cecbae78da0974b0dc8f61a2937595c0270635a5820f7bde8869e1');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(7,'2026-09-26T18:08:30.971Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','resource.create','resource','d614ac47-2e5d-423d-b8bd-b64de507c860',NULL,'127.0.0.1',1,NULL,'v2:f72f6c0431cecbae78da0974b0dc8f61a2937595c0270635a5820f7bde8869e1','v2:3f88047da465f386188e2f1742e56b44a696b8eaf05b2a361267fb38124de2cd');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(8,'2026-09-26T18:08:30.975Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','disclosure.record','disclosure','2805cb89-22d2-47eb-95c6-dc57aad16e6d','4dc53092-ff63-4993-a0a8-c55cadd189bc','127.0.0.1',1,'{"basis":"consent","source":"referral","consent_id":"0278fb9e-97c3-4c51-b747-2b31db28fb38"}','v2:3f88047da465f386188e2f1742e56b44a696b8eaf05b2a361267fb38124de2cd','v2:a7b713de69e0beef9014985412b5e866c71e2b131b07210512293ac674d83bf0');
INSERT INTO "audit_log"("id","at","user_id","username","action","entity","entity_id","client_id","ip","success","details","prev_hash","hash") VALUES(9,'2026-09-26T18:08:30.976Z','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163','admin','referral.create','referral','ec55aee7-d512-4529-bf7b-c9c3d91bce93','4dc53092-ff63-4993-a0a8-c55cadd189bc','127.0.0.1',1,NULL,'v2:a7b713de69e0beef9014985412b5e866c71e2b131b07210512293ac674d83bf0','v2:f298bba8d37648939289cb562acfe56e89e4e62ea83cedea433ffb40353a4ad6');
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
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO "episodes"("id","client_id","funding_source_id","opened_at","opened_by","referral_source","presenting_problem_enc","closed_at","closed_by","discharge_reason","discharge_disposition","discharge_summary_enc","status","created_at","updated_at") VALUES('718a4644-3f63-49b1-90fd-662680416204','4dc53092-ff63-4993-a0a8-c55cadd189bc',NULL,'2026-08-01','3670ca01-0ebf-4cc1-ac2a-73d1c81d2163',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'open','2026-09-26T18:08:30.946Z','2026-09-26T18:08:30.946Z');
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
CREATE UNIQUE INDEX idx_users_oidc_subject ON users(oidc_subject) WHERE oidc_subject IS NOT NULL;
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
CREATE INDEX idx_overdose_client ON overdose_events(client_id, occurred_at);
CREATE INDEX idx_overdose_occurred ON overdose_events(occurred_at);
CREATE INDEX idx_overdose_updated ON overdose_events(updated_at);
CREATE INDEX idx_supply_stock_updated ON supply_stock(updated_at);
CREATE INDEX idx_tombstones_at ON tombstones(deleted_at);
CREATE INDEX idx_breakglass_open ON breakglass_events(acknowledged_at, at);
CREATE INDEX idx_patient_requests_client ON patient_requests(client_id);
CREATE INDEX idx_patient_requests_updated ON patient_requests(updated_at);
COMMIT;
