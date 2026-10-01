# Data inventory and data flows

This document is for a county privacy officer, a security reviewer or a Part 2 reviewer. It covers four things:

- what personal and health information SUDS holds;
- where it is stored and how;
- every way it can leave the office server;
- how long it is kept, and the controls on each of these.

**Where it comes from.** It is written from the code, not from intentions. The sources are:

- `server/schema.sql`, the only source of schema truth;
- `server/sync-tables.js`, what devices receive;
- `server/disclosure.js` and its callers, what leaves the programme;
- `server/exports.js`, what exports carry;
- `server/fhir/`, what FHIR carries;
- `server/retention.js`, what is deleted and when.

**How it is kept honest.** `test/data-inventory.test.js` fails in three cases:

- `schema.sql` gains or loses an encrypted (`_enc`) column that the table below does not list;
- the *Devices* column disagrees with `server/sync-tables.js`;
- the *Retention* column disagrees with `server/retention.js`.

**What it is not.** It is not a legal classification. Whether a field is PHI, Part 2 information or neither in a given programme is the county's determination. This document says what SUDS stores and does with it. The shorter summary in [../HIPAA.md](../HIPAA.md), *Data classification inside the database*, points here for the detail.

Terms used below:

- **Office server.** The system of record ([../PLATFORM.md](../PLATFORM.md)).
- **Device.** A browser with local mode on, which syncs with the office server. Local mode is off unless the county turns it on.
- **SUDS on this device.** The GitHub Pages build, which never syncs. Its data stays in one browser (section 6).

## 1. Classes of data

| Class | Examples | Stored as | Tables |
| --- | --- | --- | --- |
| **Client identity and contact** | Names, preferred name, date of birth, phones, email, address, Medi-Cal ID, emergency contact, safe-contact instructions; from 1.17.0 the earlier values of a client's own details (revision history) | AES-256-GCM per field (`_enc`); a revision's changed values in one encrypted field. Blind indexes (`_idx`) for search on names, date of birth and phone | `clients`, `client_revisions` |
| **Client demographics and coded status** | Client code, city, ZIP, gender, pronouns, race/ethnicity, language, veteran, housing, insurance, substances, route of use, ASAM level, MAT status, risk level, overdose history, justice involvement, pregnancy/parenting, dates | Readable columns in the database, on the encrypted volume (section 3) | `clients`, `episodes`, `overdose_events`, `interventions` and others |
| **Clinical documentation** | Note text and structured sections, addenda, problem list with ICD-10/Z codes, care-plan goals and steps, ASAM dimension notes, PHQ-9/GAD-7/AUDIT-C/DAST-10 answers, presenting problem, discharge summary | `_enc` | `notes`, `note_addenda`, `problems`, `problem_history`, `care_plan_goals`, `care_plan_steps`, `asam_assessments`, `outcome_measures`, `episodes` |
| **SUD counseling notes** (42 CFR §2.11) | A note flagged `counseling_note` | `_enc`, like every note. Readable only by the author, the co-signer and holders of `notes:clinical:write`. Never on FHIR. Removed from devices that may no longer read it (1.16.1–1.16.4) | `notes`, `note_addenda` |
| **Service records** | Visit summaries, calls (contact name, number, purpose, summary), referral outcomes and barriers, to-dos, overdose substances and notes, time and spending descriptions, an anonymous contact's SSP participant code (1.17.0), notes on a prevention event (1.17.0) | `_enc` for free text and the participant code (with a blind index for counting); readable coded fields | `interventions`, `calls`, `referrals`, `tasks`, `overdose_events`, `time_entries`, `expenditures`, `assignments`, `prevention_events` |
| **Part 2 legal record** | Consents (recipient, purpose, scope, signer, witness), court orders, the accounting of disclosures, Part 2 notices given, the QSOA/research/audit agreement register | `_enc`. Consents, disclosures and addenda are immutable once written, even by sync (`sync-tables.js` `immutable`) | `consents`, `court_orders`, `disclosures`, `part2_notices`, `disclosure_agreements` |
| **Forms, files and imports** | Filled county forms, scanned or signed copies, file names, OneNote and Pocket AI imports before they are filed as notes | `_enc`, including file bytes and file names | `client_forms`, `client_form_files`, `imports`, `import_items` |
| **State and grant reporting** | CalOMS Tx answers and the submission file, SUPRT-A answers | `_enc` | `caloms_records`, `caloms_submissions`, `suprt_assessments` |
| **Privacy office records** | Complaints, the privacy incident register with the four-factor assessment, clients linked to an incident, break-glass reasons, patient-rights requests | `_enc`. Office server only, except patient requests | `complaints`, `privacy_incidents`, `privacy_incident_clients`, `breakglass_events`, `patient_requests` |
| **Staff accounts and secrets** | TOTP secrets; password, API-key and session-token hashes; the stored replies to retried requests | `mfa_secret_enc` and `response_enc` encrypted. Credentials only as hashes (scrypt, SHA-256) | `users`, `api_keys`, `sessions`, `idempotency_keys` |
| **Passkeys (fingerprint sign-in and signing)** | Each passkey's public key (SPKI), credential id, signature counter, transports, AAGUID (the authenticator model, as reported), its owner's name for it ("Maria's iPhone"), the host it was made for and dates; the challenges waiting for an answer (hashed, two minutes); the evidence of each fingerprint-confirmed signature or approval. **No fingerprint, face or other biometric template or measurement is ever received or stored**: the device matches the finger and signs ([FINGERPRINT.md](../FINGERPRINT.md)) | Public keys and counters readable (a public key opens nothing); challenges only as SHA-256; the evidence `_enc`. Office server only, never synchronised | `passkeys`, `webauthn_challenges`, `signature_evidence` |
| **Authenticator allow-list (passkeys; released in 1.21.0)** | The list of accepted authenticator models (a name and an AAGUID each) and the loaded FIDO Metadata Service file's number, dates and SHA-256 (settings `authn_allowlist`, `authn_allowlist_models`, `authn_mds`); what SUDS keeps of that file, per authenticator model: its description, the root certificates its attestation must chain to, its status reports and attestation types (public data about products); and, per passkey added under the list, the attestation verified at enrolment (`passkeys.attestation`: format, type, AAGUID, the file's number, when; not the attestation certificate); and (released in 1.22.0) the grace period chosen (setting `authn_allowlist_grace_days`) and, per passkey in one, when it ends (`passkeys.allowlist_grace_until`). Nothing about any person beyond which model their passkey is ([FINGERPRINT.md](../FINGERPRINT.md), "Authenticator allow-list") | Plain: none of it is PHI or a secret. Replaced whole by each upload. Office server only, never synchronised | `authenticator_metadata`, `passkeys.attestation`, `passkeys.allowlist_grace_until`, `settings` |
| **Audit trail** | Who did what to which record, when and from where | Readable, hash-chained, append-only. Details never hold names, note text or typed reasons ([LOGGING-AND-AUDIT.md](LOGGING-AND-AUDIT.md)) | `audit_log` |
| **Not client data** | Resource directory and pictures, form templates, policy documents, funds and budget lines, supply items, sites and ledger, settings | Readable | — |
| **County view** (not client data) | A programme's county signing keys (current and retired); on a county's server, its county code (`settings.county_code`), the programmes it accepts submissions from (name, active, whether an inactive one's files still count), each programme's public keys (current and replaced, a replaced one possibly marked compromised) and the submissions it imported: exact aggregate counts and money for the funds the programme chose, no client-level data ([COUNTY-VIEW.md](../COUNTY-VIEW.md)); and (released in 1.20.0) the figures the county entered for a programme not on SUDS, in the same form, with who entered them and the source document. And (released in 1.21.0) the county's publication releases of the combined figures: screened aggregates as published, with who, when, the method's parameters and a hash, and each withdrawal with its reason. The county connection (released in 1.18.0; off by default): on a county's server the connection and read tokens it issued (SHA-256 only, prefix, expiry, last use and address); on a programme's server the county's address, the token it was given and a log of what it sent (period, payload SHA-256, the county's answer; never figures) | The signing keys' private halves, each imported or entered payload, an entry's source document and the programme's saved connection token `_enc`; the county's tokens are kept only as SHA-256; the rest readable (the programme name, `generated_at` and SUDS version stored in plain columns are checked text: no control characters, bounded). Office server only | `county_signing_keys`, `county_programmes`, `county_programme_keys`, `county_submissions`, `county_publications`, `county_connect_tokens`, `county_connection`, `county_connect_sends` |

## 2. Encrypted columns, table by table

Every `_enc` column in `server/schema.sql`. Each value is AES-256-GCM under `SUDS_ENCRYPTION_KEY`, with a fresh IV per value. The format is `v1:<iv>:<tag>:<ciphertext>` ([ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md)). Key rotation finds the columns from the live schema (`scripts/rotate-key.js`).

The *Devices* column says whether a local-mode device receives the column. The *Retention* column says what happens to it. "Deleted with the client record" means the daily retention job (section 5) deletes it with the client.

| Table | Encrypted columns | Holds | Devices (local mode) | Retention |
| --- | --- | --- | --- | --- |
| `clients` | `first_name_enc`, `last_name_enc`, `preferred_name_enc`, `dob_enc`, `phone_enc`, `alt_phone_enc`, `email_enc`, `address_enc`, `medicaid_id_enc`, `emergency_contact_enc`, `goals_enc`, `flags_enc`, `contact_preferences_enc`, `legal_hold_reason_enc`, `legal_hold_cleared_reason_enc`, `removed_reason_enc`, `participant_code_enc` | Identity, contact, goals, safety flags, safe-contact notes, reasons for a legal hold or a removal; a client's SSP participant code in place of a name (released in 1.21.0), counted and found by its blind index | Yes, for every client the person may see (the whole programme under the 1.16.0 defaults; a caseload after a deny of `clients:all`). A field device (released in 1.21.0): only its worker's recent caseload, with the contact, intake, legal and clinical columns blank ([../PLATFORM.md](../PLATFORM.md), *Field devices*) | Deleted with the client record |
| `assignments` | `notes_enc` | Why a worker was put on or taken off a case | Yes, with its client | Deleted with the client record |
| `episodes` | `presenting_problem_enc`, `discharge_summary_enc`, `reopen_reason_enc` | Admission and discharge text | Yes, with its client | Deleted with the client record |
| `caloms_records` | `answers_enc` | CalOMS Tx admission, discharge and annual answers | Yes, with its client | Deleted with the client record |
| `interventions` | `summary_enc`, `participant_code_enc` | Visit or outreach summary; an anonymous contact's SSP participant code (1.17.0), built from personal details and counted by its blind index, never printed or exported | Yes, with its client (a contact with no client: its worker, or `clients:all`) | Deleted with the client record |
| `overdose_events` | `substances_enc`, `notes_enc` | What was taken, what happened | Yes, with its client (no client: its reporter, or `clients:all`) | Deleted with the client record |
| `prevention_events` | `notes_enc` | Notes on a group or community prevention event (1.17.0); the event itself holds a headcount, never names or a client | Yes, to every device whose role holds `interventions:read` | Kept: the programme's record of its prevention activity, not client data; its worker or `records:manage-others` deletes it |
| `calls` | `contact_name_enc`, `phone_enc`, `purpose_enc`, `summary_enc` | Who was called, the number, why, what was said | Yes, with its client (no client: its worker, or `clients:all`) | Deleted with the client record |
| `time_entries` | `description_enc`, `approval_note_enc` | What the time was spent on; the approver's note | Yes, with its client (no client: its worker, or `time:all`) | Kept, unlinked: the client link is removed, the hours stay |
| `consents` | `recipient_enc`, `purpose_enc`, `scope_enc`, `revoked_reason_enc`, `document_ref_enc`, `witness_enc`, `signer_name_enc` | The §2.31 consent elements | Yes, with its client; never changed by a device except a revocation | Deleted with the client record |
| `court_orders` | `court_enc`, `case_ref_enc`, `recipient_enc`, `purpose_enc`, `scope_enc`, `document_ref_enc`, `vacated_reason_enc` | Subpart E orders | Yes, with its client | Deleted with the client record |
| `part2_notices` | `notes_enc` | Notes on the §2.22 notice given | Yes, with its client | Deleted with the client record |
| `referrals` | `outcome_enc`, `barrier_enc`, `notes_enc` | Referral outcome and barriers | Yes, with its client | Deleted with the client record |
| `tasks` | `title_enc`, `description_enc` | To-do title and details (a title can reveal a diagnosis) | Yes, with its client (no client: assignee or creator, or `clients:all`) | Deleted with the client record |
| `expenditures` | `description_enc`, `approval_note_enc` | What was bought for whom; the approver's note | Yes, to a role holding `budget:read` | Kept, unlinked: the client link is removed, the amount stays |
| `notes` | `title_enc`, `content_enc`, `structured_enc`, `cosign_note_enc` | Note text, SOAP/DAP/BIRP sections, the co-signer's comment | Yes, to a role holding `notes:clinical:read` for clinical notes. SUD counseling notes go only to their author, co-signer and `notes:clinical:write` | Deleted with the client record |
| `note_addenda` | `content_enc`, `reason_enc` | Addendum text and why it was needed | Yes, with its note | Deleted with the client record |
| `disclosures` | `recipient_enc`, `purpose_enc`, `what_enc`, `justification_enc` | The accounting of disclosures (§164.528, §2.25) | Yes, with its client; never changed by a device | Deleted with the client record |
| `imports` | `filename_enc` | An imported file's name (often the person's) | Yes, to its importer only | Kept until the importer (or `records:manage-others`) purges the import; not tied to a client |
| `import_items` | `title_enc`, `content_enc`, `metadata_enc` | Imported text (OneNote page, Pocket AI transcript) and client-name hints | Yes, to its importer only | Staged and discarded items are deleted when the import is purged. Filing an item as a note clears its text, title and hints, over REST and from a device's push (1.17.0); the daily retention pass clears copies earlier versions left, and so does purging the import. Client retention hard-deletes, with a tombstone, every item filed as one of the client's notes or suggested for them |
| `client_forms` | `values_enc`, `notes_enc` | A filled form's answers | Yes, with its client | Deleted with the client record |
| `client_form_files` | `filename_enc`, `data_enc` | A signed or scanned copy and its file name | Yes, with its client; the file is fetched on demand (`blob`) | Deleted with the client record |
| `patient_requests` | `notes_enc` | Notes on a request for access, amendment, restriction or an accounting | Yes, with its client | Deleted with the client record |
| `problems` | `problem_enc`, `icd10_code_enc`, `icd10_description_enc`, `z_codes_enc` | Problem list and codes | Yes, to a role holding `careplan:read` | Deleted with the client record |
| `problem_history` | `changes_enc` | Each change to a problem | Yes, to a role holding `careplan:read` | Deleted with the client record |
| `care_plan_goals` | `goal_enc` | A goal in the client's words | Yes, to a role holding `careplan:read` | Deleted with the client record |
| `care_plan_steps` | `step_enc` | A step or intervention | Yes, to a role holding `careplan:read` | Deleted with the client record |
| `asam_assessments` | `dimension_notes_enc`, `discrepancy_notes_enc`, `summary_enc` | Six-dimension notes and summary | Yes, to a role holding `assessments:read` | Deleted with the client record |
| `outcome_measures` | `responses_enc`, `notes_enc` | Screening answers | Yes, to a role holding `assessments:read` | Deleted with the client record |
| `suprt_assessments` | `answers_enc` | SUPRT-A answers | Yes, with its client | Deleted with the client record |
| `disclosure_agreements` | `document_ref_enc` | Where a QSOA or approval is filed | Yes, to every device (pull-only) | Kept: the programme's register, not client data |
| `caloms_submissions` | `file_enc` | A CalOMS Tx file as produced for DHCS | No (office only) | The file is cleared after 90 days (`CALOMS_FILE_DAYS`), or when a client in it is purged. The record of the submission (period, hash, counts) stays |
| `client_revisions` | `changes_enc` | Each change to a client's own details, with every changed field's value before and after (1.17.0) | No (office only): a device that syncs keeps no earlier values; SUDS on this device keeps its own in that browser | Deleted with the client record, leaving no tombstone; not activity (an edit does not extend retention) |
| `referral_links` | `packet_enc`, `ack_by_enc`, `ack_note_enc` | A secure referral link's snapshot of what the recipient is shown (client's name, reason, urgency; phone and date of birth only if ticked), and who at the recipient answered and their note (1.17.0). Tokens, access codes and claim secrets are stored only as hashes | No (office only) | Deleted with the client record, leaving no tombstone |
| `breakglass_events` | `reason_enc` | Why a note was opened in an emergency | No (office only) | Deleted with the client record |
| `complaints` | `summary_enc`, `resolution_enc` | A privacy complaint and its answer | No (office only) | Kept, unlinked: the programme's record of how it answered |
| `privacy_incidents` | `title_enc`, `description_enc`, `risk_nature_enc`, `risk_recipient_enc`, `risk_acquired_enc`, `risk_mitigation_enc`, `determination_reason_enc` | The incident register and the four-factor risk assessment | No (office only) | Kept: breach documentation (§164.530(j), six years); not purged by SUDS |
| `privacy_incident_clients` | `client_name_enc` | A snapshot of an affected client's name | No (office only) | Kept after the client is purged: the link is removed, and the code and encrypted name snapshot stay, for breach documentation |
| `users` | `mfa_secret_enc` | A staff member's TOTP secret | Row only: the office sends `null` in its place, and devices never hold an MFA secret (`server/routes/sync.js`) | For the life of the account: accounts are deactivated, never deleted |
| `county_signing_keys` | `private_key_enc` | The office server's Ed25519 keys for signing county submission files (the 32-byte seed). Not PHI: a secret | No (office only) | Kept, the retired ones too (Make a new key sets `retired_at`); the public half and fingerprint stay readable |
| `county_connection` | `token_enc` | On a programme's server, the connection token its county issued for the county connection (released in 1.18.0). Not PHI: a secret, never returned to a browser once saved | No (office only) | Kept until the connection is removed or its token replaced |
| `county_submissions` | `payload_enc`, `source_ref_enc` | On a county's server, a programme's imported county submission: exact aggregate counts and money by settlement fund and category, no client-level data. Not PHI, but its small counts are exact and not for publication. For figures the county entered for a programme not on SUDS (released in 1.20.0), the same payload, and the reference to the document they came from as the county's staff typed it (`source_ref_enc`; not PHI; shown to `county:manage` only, never in the read API) | No (office only) | Kept: the county's record of what each programme submitted or the county entered, superseded and withdrawn ones included |
| `county_publications` | `reason_enc` | On a county's server (released in 1.21.0), each publication release of the combined figures and each withdrawal: the release is screened aggregates that were published (plain, with its SHA-256), the withdrawal's reason is typed text, encrypted. Not PHI | No (office only) | Kept: append-only (database triggers refuse any change or deletion but key rotation's re-encryption of the reason) |
| `county_publication_consents` | `reference_enc` | On a county's server (released in 1.22.0), each registered programme's written agreement to publication: the date of the agreement, who recorded it and when, its withdrawal; the agreement's reference as the county's staff typed it is encrypted. Not PHI | No (office only) | Kept: the county's record of what each programme agreed to; a withdrawal is recorded on the row, which stays |
| `county_publication_inputs` | `inputs_enc` | On a county's server (released in 1.22.0), for each publication release, what its small-cell audit was screened from: each programme's own counts of people and events as the combined view gave them (exact aggregates, no client-level data; not for publication, so encrypted). Used only to audit a corrected release of the same period. Not PHI | No (office only) | Kept with its release: append-only (database triggers refuse any change or deletion but key rotation's re-encryption) |
| `signature_evidence` | `evidence_enc` | The evidence of a signature or approval confirmed with a fingerprint (1.19.0, [FINGERPRINT.md](../FINGERPRINT.md)): the statement signed (purpose, record type and ids, content hash, signer, time, nonce) and the device's assertion with the passkey's public key. Ids, hashes and a public key: no PHI and no biometric data | No (office only) | Kept: the signature's proof, verifiable offline; after a client's records are purged it names ids that no longer exist |
| `idempotency_keys` | `response_enc` | The stored reply to a retried request, which may echo a record | No (each database keeps its own) | 24 hours (`server/idempotency.js`) |

## 3. Readable columns that are still sensitive

Not every sensitive column is field-encrypted. SUDS encrypts identifiers and free text. It leaves readable the coded fields that reports count and filter by.

These readable columns are protected by:

- the required encrypted volume;
- access control and caseload scoping;
- the audit log;
- in exports, by de-identification.

On a device they sit inside the sealed database image ([ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md), *On-device build*).

| Table | Readable columns a reviewer should know about |
| --- | --- |
| `clients` | `client_code` (the non-PHI identifier used in reports), `city`, `zip`, `gender`, `pronouns`, `race_ethnicity`, `race_codes`, `preferred_language`, `veteran`, `housing_status`, `insurance`, `status`, intake/discharge/referral/engagement dates, `primary_substance`, `secondary_substances`, `route_of_use`, `asam_level`, `mat_status`, `mat_medication`, overdose history, naloxone, risk level, co-occurring mental health, justice involvement, pregnant or parenting, `legal_hold` |
| `episodes`, `referrals`, `tasks`, `calls`, `interventions` | Dates, statuses, types, outcomes (coded), locations and modalities, durations, supplies given |
| `overdose_events` | When, kind, naloxone used and doses, EMS, hospitalised, survived, location type, `city` |
| `notes` | Kind, format, status, signer, signature hashes, `counseling_note` and `part2_protected` flags, dates |
| `consents`, `disclosures`, `court_orders` | Type, dates, basis, method, source, flags (for example `counseling_notes`, `legal_proceeding`) |
| `asam_assessments`, `outcome_measures` | Ratings and scores, band, safety flag |
| `audit_log` | User, action, entity and client ids, IP address, time. No names or note text |
| `users`, `sessions` | Staff names, emails, roles, sign-in times, session IP and user agent |

## 4. Blind indexes

The following columns are HMAC-SHA256 values under `SUDS_INDEX_KEY`, a key separate from the encryption key:

- on `clients`: `last_name_idx`, `full_name_idx`, `name_prefix_idx`, `name_phonetic_idx`, `first_name_idx`, `first_name_prefix_idx`, `preferred_name_idx`, `dob_idx`, `phone_idx`;
- on `interventions`: `participant_code_idx` (1.17.0), an anonymous contact's SSP participant code, for counting the different participants; `scripts/rotate-index-key.js` re-derives it.

They make exact search possible without decrypting.

They reveal which rows share a value. Anyone who holds the index key can recover low-entropy values such as a date of birth. The risk register records this ([../HIPAA.md](../HIPAA.md); [ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md), *Blind indexes and key separation*). A device recomputes indexes with its own key; indexes are never sent to it.

## 5. Where data can flow

Every path by which record data leaves the office server's database, and what controls it. "Accounted" means one accounting-of-disclosures row per client, written by `server/disclosure.js` (`record`, `recordFhir` or `recordStateReport`). Access to a client's accounting is audited.

### Out of the programme (disclosures)

| Flow | What it carries | Who can start it | Gate | Record | Code |
| --- | --- | --- | --- | --- | --- |
| **Referral** naming a client | SUDS records that the client's identity and referral went to an agency. The worker makes the referral itself (phone, email, in person); SUDS sends nothing | `referrals:write`, within the caseload | `requireBasis`: a live consent that names the agency, a court order, a medical emergency with justification, or the supervisor's override | Accounted | `server/routes/referrals.js`, `server/disclosure.js` |
| **Identified export** (CSV/Excel) | The clients dataset (names, date of birth, phone, email, address, goals, flags) and free text of visits, calls, time, referrals, to-dos, consents, disclosures and overdose events. Expenditures go only to `budget:read`. Clinical note text is never in an export | `export:identified` (supervisor, administrator) | `requireExportBasis`, which needs a named recipient and purpose. Under consent, a client whose consent does not name the recipient is left out and listed by code. A large file opens a draft privacy incident (`incidents.maybeMassExport`) | Accounted, once per client per file | `server/routes/reports.js`, `server/exports.js` |
| **County EHR hand-off** file | Name, date of birth, Medi-Cal ID; service dates, types, minutes, staff and funding | `export:identified`, with the hand-off module on | `fileConsentFor` / `requireExportBasis`; never for a legal proceeding | Accounted (`source: ehr_handoff`) | `server/routes/handoff.js` |
| **CalOMS Tx submission** to DHCS, via the county | CalOMS answers with name and date of birth | `export:identified`, with the CalOMS module on. From 1.17.0 a scheduled run may **prepare** a file (encrypted, not yet a disclosure); only a person with `export:identified` **produces** it | State reporting required by law (`STATE_REPORTING`; counsel to confirm the Part 2 characterisation). Producing is refused if a record in the prepared file has changed since | Accounted (`recordStateReport`) when produced, never when prepared. The file is kept encrypted for 90 days; the submission log (`caloms_submission_events`, no PHI) records prepared, produced, downloaded, uploaded (with the DHCS reference) and discarded | `server/routes/caloms.js`, `server/caloms.js`, `server/caloms-schedule.js` |
| **Secure referral link** (1.17.0) to an organisation not on SUDS, opened without an account | A referral packet: the client's name, reason, urgency, referral date; phone and date of birth only if the worker ticks them; the §2.32 notice. A *contact notice* names nobody | `referrals:write`, on a client the worker may see; office server only | `requireBasis`: a live consent naming the recipient, checked when the link is made and again at every open; a six-digit access code given separately; the first browser to give it claims the link; five wrong codes lock it; 1–7 days; can be withdrawn | Accounted (source `referral_link`) when the recipient first opens it; every open, refusal and answer audited | `server/referral-links.js`, `server/routes/referral-links.js`; [REFERRAL-LINKS.md](REFERRAL-LINKS.md) |
| **SUPRT-A SPARS entry file** | SUPRT-A answers of the clients the gate admits | `export:identified`, with the SUPRT-A module on | `requireExportBasis` | Accounted | `server/routes/suprt.js` |
| **FHIR R4 API and bulk export** to a registered recipient | Patient (names, date of birth, Medi-Cal ID, phones, email, address), EpisodeOfCare, Encounter, Consent (only consents covering this recipient), ServiceRequest, Task (title), Observation (risk, overdose), DocumentReference. DocumentReference covers signed notes, never SUD counseling notes, and **never note text**: the attachment says to request it under a consent | A FHIR client an administrator registers (`apikeys:manage`) with a recipient, aliases, purpose and scopes | `fhirCoverage` per client, per resource type: only clients whose consent covers the recipient and purpose. Part 2 security labels and the §2.32 notice on every response | Accounted (`recordFhir`) | `server/routes/fhir.js`, `server/fhir/`; [../integration/FHIR.md](../integration/FHIR.md) |
| **Printed consent or form** (PDF) | The consent or form as the client signs it | Whoever may open the client's consents or forms | Printed PDFs carry the Part 2 / HIPAA handling notice | Audited as a view or print | `server/pdf.js`, `server/routes/forms.js` |

### To a business associate (1.17.0)

| Flow | What it carries | Who can start it | Gate | Record | Code |
| --- | --- | --- | --- | --- | --- |
| **AI documentation copilot**, from the office server to the AI provider's API over HTTPS (`api.anthropic.com`; since 1.17.1 Amazon Bedrock or Google Vertex AI instead, by `SUDS_AI_PROVIDER`; or the gateway in `SUDS_AI_BASE_URL`). Off by default; never from a device or SUDS on this device | Only the text a person gives for one client (and, for care-plan suggestions, one chosen assessment and the active problems' wording), with that client's known identifiers replaced by placeholders and identifier-like patterns masked. **Still PHI and Part 2 information**: free text can still identify someone ([../AI-COPILOT.md](../AI-COPILOT.md), *Residual risk*) | `ai:draft` (clinicians, supervisors, navigators by default; never finance or read-only), with the permission to write what is drafted, on a client the person may see; 12 drafts a minute per person; a monthly cap per programme | An administrator records the programme's BAA with Part 2 QSOA terms and counsel's review, then switches it on; withdrawing the agreement switches it off. `ANTHROPIC_API_KEY` (or the Bedrock / Vertex AI credentials) in the server environment only; the agreement is tied to the provider it was recorded for | Audited per call (`ai.draft`: who, client, feature, model, token counts, identifiers replaced; never the text); counted in `ai_usage` (no text, no client); a note with drafted text is marked `notes.ai_assisted` and needs the author's review statement to sign. Not an accounting-of-disclosures row: a business associate's use under the BAA/QSOA | `server/ai-copilot.js`, `server/ai-prompts.js`, `server/routes/ai.js`; `test/ai-copilot.test.js` |

### Aggregate reporting (no record-level data)

| Flow | What it carries | Who | Control | Code |
| --- | --- | --- | --- | --- |
| **Funder submission** (funder report, NDP log, settlement report, settlement outcomes by fund (1.17.0), DHCS and county layouts, syringe services summary, prevention activity summary (1.17.0), SUPRT-A completion rates) | Exact aggregate counts by fund and period. No client-level data | `reports:funder` (supervisor, administrator, finance) | Audited with purpose, fund and period | `server/funder-report.js`, `server/harm-reduction-reports.js`, `server/routes/reports.js` |
| **County submission file** (Settlement outcomes › Send to the county; office server only) | The settlement outcomes page's exact aggregate figures, for the settlement funds the person ticked (only those, and totals over them alone), by fund, allowable use and in total, addressed to one county by its county code and signed with the office's current county key. No client, client code, name, date of birth or single event (`server/county.js` `PAYLOAD` allow-list). Leaves the programme for the county under the funding contract; not a Part 2 disclosure (aggregate) | `reports:funder` with `budget:read` and `export:read` (finance, supervisor, administrator) | Audited `county_submission.export` with the period, county code, key fingerprint and payload SHA-256, never the figures | `server/county.js`, `server/routes/county.js` |
| **County view** (a county's server importing its programmes' files, and its Excel/CSV of them) | The same aggregates, per programme and summed; labelled internal and exact. From 1.20.0 they may include figures the county entered for a grantee not on SUDS, marked *entered by the county — not signed by the program* in every view, file and read-API answer, and left out on request (`entered=exclude`); an entry's source document never leaves the county's server | `county:manage` imports; `county:view` (with `export:read` for the file) | For this county (its code); signature under a registered, current key of an active programme; allow-list and text checks; every import, refusal, withdrawal (with its reason), reinstatement, view and export audited without figures | `server/routes/county.js` |
| **County connection** (released in 1.18.0; off by default; office servers only) | The same signed county submission file, posted by the programme's server to the county's over HTTPS; back, the county's receipt and what it expects of that programme (periods, no figures). The county's read API returns the combined view to the county's own systems | A connection token per programme (`county:manage` issues; the file must still verify under that programme's key) and read tokens for the county's systems, SHA-256 at rest; the programme's copy of its token encrypted, set by `settings:manage`; sending needs what making the file needs | Every send (`county_submission.send`), receipt, token issue, revoke and use (`county.submission.import` with `via`, `county_connect.status`, `county.api.read`) audited without figures; the programme keeps a send log | `server/county-connect.js`, `server/county-connect-client.js`, `server/routes/county-connect.js` |
| **Publication release** (for public sharing) | Aggregate counts after small-cell screening. A whole release is refused when the check cannot confirm it, so nothing is published | Anyone who may run the report, read-only included, for the whole programme and a standard period that has ended, unless an administrator has switched publication off | Suppression below 11 with complementary suppression, checked against an attacker who knows the method. A conservative screen, not an expert determination ([../HIPAA.md](../HIPAA.md), *Small cells*) | `server/publication-release.js`, `server/sdc.js`, `server/release-audit.js` |
| **De-identified export** | Safe Harbor columns only: year-only dates, `90+`, ZIP3, coded fields held to their lists, no free text, a random record id per export | `export:read` | `DEID_COLUMNS` allow-list. `test/deid-safe-harbor.test.js` | `server/exports.js` |

### Inside the programme's own control

| Flow | What it carries | Control | Code |
| --- | --- | --- | --- |
| **Sync to a local-mode device** | The tables in section 2 marked *Yes*: what the person may see, decrypted for transport over TLS and re-encrypted on the device under its own key. Never MFA secrets, other staff's password hashes, blind indexes, or the office-only tables. A field device (released in 1.21.0) receives only its worker's recent caseload, contacts, to-dos, supplies and lists, as `server/field-scope.js` declares | Off unless the county turns it on. Scoped per person and per permission, with the per-user denies applied, and per device and account (field scope, enforced at the office on pull and push; once an account has a field device, or while the programme default is on, every device of that account is in the field scope unless an administrator marked that device "Hold everything"). What a narrowing puts out of reach is removed at the next sync (`dropped_clients`, `dropped_rows`). Every sync is audited. Devices can be revoked or remotely wiped | `server/routes/sync.js`, `server/sync-tables.js`, `server/devices.js`; [../PLATFORM.md](../PLATFORM.md) |
| **Backups** | The whole database | AES-256-GCM under `SUDS_BACKUP_KEY` (or a key derived from the encryption key). Verified on write. Copied to the county's offsite directory | `server/backup.js`, `server/scheduled-backup.js` |
| **Audit export** for an auditor | Audit entries: ids, actions, times, IPs. No names or note text | `audit:read`; itself audited; signed (Ed25519) | `server/audit-export.js` |
| **Operational logs, metrics, health** | No PHI: route, message, counts | Log files 0600, 30 days | `server/log.js`, `server/metrics.js` |
| **Browser notifications** | A change notice names the client by code, never by name (1.16.4) | — | `public/app.js` |
| **Street outreach waiting list in the office app's browser** (released in 1.23.0) | A street-outreach contact saved with no signal, kept in IndexedDB `suds-outreach-queue` until it is sent: the kind of contact, a coarse place, the time, the supplies and the supply site, the worker's account id and an Idempotency-Key. **No PHI**: never a client, participant code or notes (the screen refuses to keep them; the office refuses them from this list, `X-Suds-Queued`). Not encrypted: it is about no one, and a key that ended with the session would lose contacts the worker was told would be sent at the next sign-in | Kept per account; signing out leaves it for that worker's next sign-in, and another account on the same phone neither sees nor sends it. Sent with its Idempotency-Key, so the office makes one contact of it however late (`server/crud.js` `keyedId`); the worker can Discard one. Never used by a device's offline copy or SUDS on this device | `public/outreach-queue.js`, `server/routes/interventions.js` `checkQueued`; `test/outreach-queue.test.js`, `scripts/ui/offline-outreach.mjs` |
| **Who is signed in, for this tab** (built for 1.23.1, not yet released) | The office app's answer to "who is signed in" (the staff account, its permissions and the programme's settings) and the programme's lists (`/api/meta/constants`), kept in `sessionStorage` (`suds.tab-session`) so that a reload with no signal still knows who is signed in: Street outreach can keep a contact that names nobody, and every other page says it needs signal. **No PHI**: nothing about any client | This tab only, gone with the tab; removed as soon as nobody is signed in (sign-out, an ended session, the sign-in page); checked with the office again as soon as there is signal. Grants nothing: the office decides every request by the session cookie. Never used by a device's offline copy | `public/app.js` `keepTabSession`/`restoreTabSession`; `scripts/ui/offline-outreach.mjs` |
| **Field-device requests** (released in 1.23.0) | A worker's "Set up this phone for the field": who asked and when, kept in `settings` (`field_request:<user id>`), and a to-do for each administrator naming the worker (staff, not a client) | Office server only; answered by `users:manage`; Approve only narrows what the worker's devices hold. Audited (`device.field_request`, `.approve`, `.decline`) | `server/field-request.js`; `test/outreach-queue.test.js` |

### Into SUDS

| Flow | Data | Control |
| --- | --- | --- |
| OneNote (Microsoft Graph), Pocket AI, spreadsheet import, and from 1.17.0 a FHIR R4 Bundle or Bulk NDJSON export from the programme's EHR (patients, encounters; through the spreadsheet import's preview and checks; SUDS never connects to the EHR) | Notes and records about clients, staged encrypted in `import_items` until someone files them | `imports:write`. The shared notebook needs `graph:import`. Each record is checked against its table's rules. The county's own agreement with Microsoft or Pocket AI governs data before import ([../IMPORTS.md](../IMPORTS.md)) |
| Intake API | New records, write-only | Hashed, revocable intake keys that cannot read ([IDENTITY.md](IDENTITY.md)) |

**Nothing else leaves the server.** There is no telemetry, analytics or crash reporting to a vendor. The optional outbound connections are:

- the identity provider (no PHI);
- the release feed (no data sent);
- provider pictures (public websites; no PHI);
- a syslog collector for audit anchors (no PHI).
- the AI copilot's provider (PHI, above), only when the programme has recorded its agreement and switched it on (1.17.0).

See [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md).

## 6. SUDS on this device

The GitHub Pages build holds the same tables in one browser. It holds no office-only tables and nothing is synced.

- **Sealed at rest.** The whole database image is sealed with AES-256-GCM under a key that each device account's password unwraps.
- **Nothing leaves the browser**, except a device backup the person chooses to save. The backup is sealed under a passphrase.
- **No server-side copy.** Retention, audit review and residency are the device's and the programme's to manage.

Two things a reviewer should know:

- **Every account on the device unlocks the same key.** The rules that hide one account's rows from another are enforced by the app, not by cryptography ([THREAT-MODEL.md](THREAT-MODEL.md), *Residual risks*).
- **Nobody can recover a lost device password.** A forgotten password with no other account and no recovery code is unrecoverable without a backup ([ENCRYPTION-AND-KEYS.md](ENCRYPTION-AND-KEYS.md)).

## 7. Retention and deletion

| What | Kept | Mechanism |
| --- | --- | --- |
| A client's record: every table marked *Deleted with the client record* above | Seven years after the **last activity** on it by default (`client_retention_years`, never below six), once no episode is open. A legal hold exempts it | `server/retention.js` `purgeClient`: one transaction, daily. Deleted rows leave tombstones so devices delete them too. Audited by client code only |
| Time and spending linked to a purged client | Kept; the client link is removed | `UNLINK_TABLES` |
| Complaints; privacy incidents and their client snapshots | Kept by SUDS with no automatic purge. The county's policy decides (breach documentation: at least six years) | — |
| CalOMS Tx submission files | 90 days, then only the record | `clearOldCalomsFiles` |
| Imports | Staged and discarded items: until the importer purges the batch. Committed items: the row (with no text since 1.17.0) until its client is purged | `DELETE /api/imports/:id` (Imports → **Purge**) |
| Audit log | Seven years by default, never below six | `server/audit.js` `purge` |
| Deletion tombstones (for devices) | 180 days. A device offline longer is told to rebuild from the office | `TOMBSTONE_RETENTION_DAYS`, `server/routes/sync.js` `resyncCheck` |
| Idempotency replies | 24 hours | `server/idempotency.js` |
| Local backups | The newest 14. Offsite copies follow the county's storage policy | `backup_retain_count` |
| Device copies | Until the next sync removes what the office deleted or narrowed, or until the device is wiped. A device that never syncs again keeps what it had | [../PLATFORM.md](../PLATFORM.md) |

More detail: [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md).

## 8. Known gaps and county decisions

- **Fixed in 1.17.0: a committed import item kept its text after the client record was purged.** Found while writing this inventory (1.16.4): filing an import item made a note, but the `import_items` row kept its own encrypted copy of the text, title and client-name hints, and nothing deleted it. Now filing clears that copy at both doors (`POST /api/imports/items/:id/commit`, `server/routes/imports.js`; a device's push of a committed item, `server/rules/import_items.js`); the client retention purge hard-deletes and tombstones every item filed as one of the client's notes or suggested for them, staged or committed (`counts.import_items` on the `client.purge` audit row); purging an import batch clears the text its committed items still hold; and the daily retention pass clears copies earlier versions left on committed items (`import.committed_text_cleared`, a count only), within a day of the upgrade, with no migration (`test/import-text-retention.test.js`). Backups made before that pass still hold the old copies until they age out (below).
- **A device keeps no earlier values of a client record.** From 1.17.0 the office keeps every change as an encrypted revision (`client_revisions`, never synchronised), but values from before 1.17.0 were never kept, and the changes a discharge, an overdose event, a visit or an ASAM rating make to the record are recorded on those records, not as revisions ([QUESTIONNAIRE.md](QUESTIONNAIRE.md) #22).
- **Least privilege is a setting on an upgraded office.** A new install holds new navigators and clinicians to their caseload (1.17.0). An office upgraded from 1.16.x starts with that setting off, and until it is turned on (and applied to existing staff), navigators and clinicians see every client and their devices hold the whole programme, unless the programme denies `clients:all` per person before the first sync (#22, #45).
- **Some readable columns are sensitive** (section 3). They rely on volume encryption and access control, not field encryption. The county decides whether that is acceptable for its programme.
- **Backups made before a purge still hold the purged records** until they age out. Set the offsite store's retention to match policy ([DATA-LIFECYCLE.md](DATA-LIFECYCLE.md)).
- **Classification and legal characterisation are the county's decisions.** This includes whether CalOMS reporting is a §2.53 disclosure. SUDS records what it does.

## 9. Schema versions

The database's schema version is the number of the newest migration it has run (`server/db.js`; `server/schema.sql` is the fresh-install shape). An upgrade runs the missing ones on start, after an encrypted copy of the database is sealed beside it (`pre-migration/`). What the recent ones add to what is stored:

| Migration | Release | What it adds to what is stored |
| --- | --- | --- |
| Migration 56 | 1.18.0 | The county view: `county_signing_keys` (a programme's signing keys, private halves `_enc`) and, on a county's server, `county_programmes`, `county_programme_keys` and `county_submissions` (imported payloads `_enc`). No client data |
| Migration 57 | 1.18.0 | The county connection: `county_connect_tokens` (on a county's server, SHA-256 only), `county_connection` (on a programme's server, the token `_enc`) and `county_connect_sends` (what was sent: period and payload SHA-256, never figures). Off by default |
| Migration 58 | 1.19.0 | Passkeys: `passkeys` (public keys and credential ids; no biometric data), `webauthn_challenges` (hashes, two minutes), `signature_evidence` (`evidence_enc`), and `sessions.reauth_method` and `sessions.passkey_id` |
| Migration 59 | 1.19.0 | `sessions.sync_client`: marks a device's sync sign-in. No new data about people |
| Migration 60 | 1.20.0 | County-entered figures: `county_programmes.on_suds`, and `county_submissions` rebuilt so a row the county entered has no key or signature, with `source`, `entered_via` and `source_ref_enc` (the source document, encrypted). No client data |
| Migration 61 | 1.21.0 | County publication releases: `county_publications` (append-only by triggers: each screened release's period, method parameters, canonical JSON of aggregates and its SHA-256; a withdrawal's reason `reason_enc`). No client data |
| Migration 62 | 1.21.0 | Field devices and participant codes: `devices.sync_scope`, `scope_changed_at`, `field_applied_at`; `sessions.device_id`; `clients.participant_code_enc` and `participant_code_idx` (the SSP participant code, encrypted, with its blind index) |
| Migration 63 | 1.21.0 | The authenticator allow-list: `passkeys.attestation` (the attestation verified at enrolment under the list: format, AAGUID, trust path hash; no certificate or biometric data) and `authenticator_metadata` (what SUDS keeps of an uploaded FIDO Metadata Service file) |
| Migration 64 | 1.22.0 | Field scope follows the account: `field_accounts` (one row per staff account held to the field scope on every device: the account id, when, and how: an administrator, the account's own enrolment, the programme default, a device; no client data, office server only) and `devices.scope_set_by` (who last decided a device's scope: `default`, `enrolment`, `account`, `admin`). No PHI |
| Migration 65 | 1.22.0 | County publication governance: `county_publication_consents` (each programme's written agreement to publication: its date, the reference `reference_enc`, who recorded and withdrew it) and `county_publication_inputs` (what each release was screened from, `inputs_enc`, append-only by triggers). No client data. |
| Migration 66 | 1.22.0 | The authenticator allow-list's grace period: `passkeys.allowlist_grace_until` (when a refused passkey's grace period ends; a date, nothing about the person) |
| Migration 67 | 1.23.0 | Follow-up to-dos: `tasks.call_id` and `tasks.intervention_id` (the call or visit whose follow-up date made a to-do, so changing the date moves it; ids only, no new data about people) |

`test/doc-content-currency.test.js` fails when the newest migration, or one the newest stamped release's CHANGELOG section names, is not in this table.

## Keeping this document honest

`test/data-inventory.test.js` loads `server/schema.sql` into an in-memory database and compares each table's `_enc` columns with section 2's table, in both directions. It checks the *Devices* column against `server/sync-tables.js`:

- *Yes* for a synced table;
- *Row only* for `users`;
- *No* for office-only and per-database tables.

It checks the *Retention* column against `server/retention.js`: *Deleted with the client record* for the tables the purge deletes, *Kept, unlinked* for those it unlinks.

**Adding an encrypted column** means updating this document in the same change, and `server/sync-tables.js` too (`test/sync.test.js`).
