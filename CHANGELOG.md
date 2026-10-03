# Changelog

All notable changes to SUDS are documented here. The project follows semantic versioning.

## Unreleased

### Security

Fixes from an owner-authorised white-box pen test of 1.23.6. No migration, permission or route is added.

* **M1 — the disclosure gate now checks purpose.** A consent covers the purpose it states, as well as the recipient
  it names: a referral "for treatment services" was accepted on a consent given for "billing and payment processing
  only", and so was a manual disclosure. `requireBasis` (`server/disclosure.js`) now compares the disclosure's
  purpose with the consent's, using the same rule as the FHIR API (`consentCoversPurposeOfUse`). Treatment, payment
  and health care operations are recognised by their words. A referral counts as treatment (45 CFR §164.501), as do
  an intake, an admission, MAT/MOUD and withdrawal management, which the FHIR API now also recognises as treatment.
  The single TPO consent covers all three. A purpose outside them (housing, a court case) is covered only by a
  consent that states it. A consent "at the request of the patient" (§2.31(a)(4)) covers what a worker discloses at
  the patient's request, but never the FHIR API's automated feed. A mismatch is refused with **409**, and the
  message gives the consent's purpose. A supervisor or administrator may override with the existing consent
  override (`recipient_override` / `_recipient_override`, now labelled "does not name the recipient or was given
  for another purpose") and a written justification of at least 20 characters. The justification is kept with the
  accounting row ("Purpose override …"), and the audit entry carries `purpose_override: true`. The check covers
  referrals (REST, the outcome route and a device's push), manual disclosures (REST, and a device's disclosure
  rows, which are flagged for the privacy officer), secure referral links, identified exports, the SPARS file and
  the county EHR hand-off. Files have no override: a client whose consent does not cover the file's purpose is left
  out and listed by code. The referral form no longer suggests a consent that names the provider but was given for
  another purpose, and it offers "Record a consent naming …" instead. The hand-off preview checks the purpose too.
  Test data that relied on mismatched purposes was corrected. Before you upgrade, check whether your consents state
  their purpose in other words: from this release, a referral on such a consent needs a supervisor's override or a
  new consent.
* **M1, widened after review — everyday purposes are covered** (review of the combined 1.24.0 tree: the first version
  refused everyday flows). A **referral's purpose is what it is for**, from the provider's directory category
  (`disclosure.referralPurpose`: "Referral for housing services", "Referral for outpatient treatment"; "Referral for
  services" for *other*), and the accounting row records it. A consent naming Hope Housing for "Housing assistance",
  "Linkage to housing and benefits", "Case management" or "Coordinate services" now covers a referral to Hope Housing
  (it was refused with 409). **Treatment** is also named by medication, prescriber, primary care / PCP, doctor,
  physician, therapy, recovery services and discharge planning and, for a person's disclosure, by coordinate, case
  management, discharge, follow-up, appointment and counseling. Case management, care coordination, coordinating
  services and service linkage are **broad coordination purposes**: they cover a referral or coordination for
  services (treatment, housing, employment, school, benefits, family support), never payment, operations, a court,
  research, marketing or the media. The **TPO consent** (or one stating TPO) covers any purpose not plainly outside
  TPO, so "Coordinate care with primary care doctor", "Discharge planning", "Medication management with prescriber"
  and "Follow-up appointment" go on it. An explicit **non-TPO list** — housing, employment, court / legal / probation /
  law enforcement, school, benefits eligibility, research, marketing, media, family or personal — wins over every
  other word and still needs a consent that names it: **a TPO consent alone no longer covers a referral to a housing,
  shelter, sober-living, employment, legal-aid, benefits or family-support provider** (it did when every referral was
  "Referral for services"); record a consent naming that purpose, or a supervisor overrides. The sample data's TPO
  consents now name the housing, shelter and legal-aid referrals they make. One rule still serves every path: the FHIR
  API reads it with its own words only, so no coordination word, coordination consent or patient's request widens an
  automated feed, the clinical words count there only in a purpose naming nothing outside TPO, and "Referral to
  housing" no longer covers `TREAT` (stricter). "Billing and payment processing only" still covers no treatment
  referral. A **device's referral** on a consent that names the agency but not this purpose is now **kept at the
  office** with its accounting row (audited `purpose_unconfirmed: true`), flagged to the device (`sync.conflict`,
  flagged `disclosure_purpose`) and given a supervisor's high-priority review task, instead of being refused and
  living only on the device; any other refusal is unchanged. A **secure referral link** withheld because its consent
  no longer covers the referral's purpose is audited as `purpose_not_covered` (it said `consent_not_valid`), and the
  referral's link list now says, for each link a provider could still open, why it would be withheld. Links made
  before are held to the same rule. docs/compliance/PART2.md *Purpose match* and docs/integration/FHIR.md describe it;
  `test/purpose-matrix.test.js` is the table of cases.
* **M2 — an office deletion stands.** A device's push with a fresh `updated_at` could bring back a row the office had
  deleted and remove its tombstone. Sync push (`server/rules/push.js`) now refuses any row whose tombstone is on file,
  whatever the device's clock says. It is reported to the device as a permanent rejection (`deleted at the office`),
  and the device removes its own copy rather than resending it, as it does for a purged record
  (`local/sync.js`). Each refusal is audited as the new action `sync.resurrect_refused`, with only the table and the
  record id. A purged client's rows are still refused as `purged`. A row the office deleted while a device had
  unsent edits to it no longer silently disappears from the push either: the device is told.
* **L3 — a push that edits a signed note is refused.** A push that changed a signed note was counted as applied while
  the office quietly kept what was signed. It is now rejected, with the REST route's own message ("not permitted:
  Signed notes cannot be edited; add an addendum instead"), so the device shows it on the sync screen and stops
  resending it. A signed note sent back unchanged (for example, asking for a review) still lands.

### Security: the Low findings of the white-box pen test of 1.23.6

No migration and no new permission. What an administrator should know: passwords that pass the character rule but
contain the username or the person's name, or are a very common password dressed up ("Summer2026!!", "P@ssw0rd2026!"),
are now refused wherever a password is set; failed sign-ins are limited per username from an address (with a much
higher per-address ceiling, `LOGIN_IP_RATE_LIMIT`), so one person's wrong guesses no longer lock out everyone behind
the office's NAT address; and a device's sync sign-in can no longer manage the account.

* **L1 — password policy.** Besides 12+ characters with upper and lower case, a number and a symbol, a password must
  not contain the username (or its part before an @) or a part of the person's name (3 characters or more; a part of
  exactly 3 only as a word of its own), must not be one of a short built-in list of very common passwords and keyboard
  patterns with digits and symbols around them (look-alike characters such as `@` for `a` and `0` for `o` included),
  and must use at least 5 different characters (`server/password-strength.js`, `auth.passwordProblem`). It applies to
  office sign-up, the set-up wizard, an administrator creating or resetting an account (a generated temporary password
  is drawn again in the rare case it would trip it), a password change, `npm run create-admin`, and on SUDS on this
  device to the first account, sign-up and recovery. The refusal says which rule, under the password field too.
  Existing passwords are not affected until they are next changed. On SUDS on this device, *Try it with sample data*
  now creates its "sample" account with the password `Look-Around-2026` (the old one contained the username).
* **L2 — sign-in limit.** `POST /api/auth/login` counted failures per source address only, and past 20 refused every
  sign-in from it, right passwords included. Failures now count per username from an address (`LOGIN_RATE_LIMIT`,
  default 20, as before) and per address whatever the username (`LOGIN_IP_RATE_LIMIT`, default ten times that, 200),
  as the backstop against spraying; account lockout is unchanged, and a username nobody has is counted exactly like
  one that exists. The same two limits now cover every other place a password or passkey is tried
  (`auth.signInLimiter`): the password given again to sign or approve, or to change it or turn two-step verification
  off, counts per account from the address, and fingerprint sign-in per passkey (its second step per account), each
  with the per-address ceiling behind it. These had still counted per address alone, so one person's 20 wrong signing
  passwords refused every colleague's signature and sign-in from the same address. Settings › Security status's
  hardening checklist says so.
* **L4 — paging.** A `limit` or `offset` that is not a number answered 500 on every list route; it is now a 400 that
  says which (`limit must be a whole number`), absent or empty takes the default, and a fraction is rounded down
  (`server/validate.js` `paging`, now also used by the supplies ledger). A non-numeric `hours` on
  `/api/notes/handoffs` takes the default instead of a 500, and the sync pull's `limit` can no longer be negative.
* **L5 — audit tail.** The audit chain's head is sealed, and its first anchor written (reason `first-start`), at the
  office server's start whenever none exists yet, instead of waiting for the first housekeeping pass: until then the
  newest entries of a new install could be deleted without a trace. A database with no audit entry gets one first
  (`audit.started`). docs/security/LOGGING-AND-AUDIT.md now says that tail-truncation detection depends on the hourly
  housekeeping running.
* **L6 — sync sessions.** Every device's sync session, not only a field device's, now reaches under `/api/auth/`
  only signing in, the second step and signing out: changing the password, two-step verification (whose first step
  returned a new secret), passkeys, `/api/auth/me` and the session list and ending other sessions answer 403
  (`syncSession: true`, "use a web browser"). A whole device's session still reaches the rest of the API.
* **L7 — `client_id` filters.** `GET /api/episodes` and `GET /api/notes/handoffs` accepted `client_id` and ignored
  it; it now narrows them to that client, within the caller's caseload as before (a client off the caseload gives an
  empty list, as the generic list routes do). docs/API.md says so.

### Scheduled backups for SUDS on this device (built for 1.24.0, not yet released)

Built on a feature branch for 1.24.0, which comes no earlier than 2026-10-29 and through the release gate; nothing
here is in a release yet. The 1.23.1 market evaluation rated device-only use 2.75/5 because its backups were
manual: a programme on SUDS on this device lost everything if nobody remembered to download a file before the
browser's storage went.

- Added: **scheduled backups** on SUDS on this device (This device → Keep your records safe → Scheduled backups).
  The device's manager chooses every day, every 3 days or every week (a device that never chose keeps the weekly
  reminder, which is also the longest interval) and types a backup passphrase once. The kernel keeps the key
  derived from it in the vault, sealed under the device key: never the passphrase, never in the database or a
  backup, dropped by a restore (`local/backup.js` `deriveKey`/`createWithKey`, `local/vault.js` `sealBackupKey`).
  Each file is an ordinary encrypted version-1 device backup that opens with the passphrase.
- Added: where the browser has the File System Access API (Chrome, Edge on a computer), **a folder chosen once**
  receives each due backup by itself — when Home opens after a sign-in, when the page is hidden after a day's
  work, and hourly while open — keeping the newest 7 (or the number chosen) and removing only older files SUDS
  named. When the browser withholds the folder after a restart, Home shows one **Back up to “folder” now** button.
  Where there is no such API (Safari, Firefox, iPhone and iPad), a due backup is one **Download the backup** button
  on Home, and the card says why.
- Added: **Last backup** says when and where (*today, to the folder “SUDS backups”*, *downloaded*), with the next
  due date; a backup counts only once it was written. **Check a backup**, the restore drill, opens the newest
  backup with its passphrase and checks its database, keys and tables without changing anything; This device
  shows the last result.
- Added: audit actions `device.backup.failed`, `device.backup.checked` and `device.backup.schedule`;
  `device.backup.created` now records where the file went and what made it (no PHI, file or folder name). New
  device routes `POST`/`DELETE /api/local/backup/schedule`, `POST /api/local/backup/run`,
  `POST /api/local/backup/run/done` and `POST /api/local/backup/check` (the device administrator only); no
  migration (settings rows and the vault). Tests: `test/device-backup-schedule.test.js`; `scripts/ui/signup.mjs`
  drives a folder browser, a browser that must be asked again and one with no folder API; `accessibility.mjs`
  audits the new dialogs, This device and Home.

### Possible duplicate time (built for 1.24.0, not yet released)

Feature work for 1.24.0, on its own branch; it goes through the release gate after the stabilisation period (not before 2026-10-29).

#### Added: possible duplicate time

* **Time already logged is noticed before it is saved.** Saving a time entry (or an edit that changes its date, start time, minutes or description) that matches another of the same worker's entries on the same day — **overlapping times**, or **the same minutes and the same description** — is not saved straight away. The time form asks, inside the form, *This may be time already logged*, naming the entry already there (its times, category, client and description) and why it matched, with **Merge**, **Save anyway** and **Cancel**. Cancel saves nothing and leaves the form open; Save anyway saves it and records that the warning was overridden (`time_entry.duplicate.override`). Descriptions are compared decrypted, ignoring case and spacing, and never written to the audit trail or a log; a blank description matches nothing. Only entries you may read are shown: a match you may not read (a client no longer on your caseload) never blocks the save, and the entry is marked for review instead.
* **Merge** keeps the entry already there and folds the new one into it (`POST /api/time/:id/merge`): its description is added on a new line (once, when they say the same thing); when both have a start time and the ranges overlap, the kept entry covers both (09:00–10:00 and 09:30–10:30 become 09:00–10:30, 90 minutes, never the 120 of the two added), or keeps its own times if you choose; a client, fund or visit link it lacked is taken from the other. The time counts once on the time list, the approval queue, the funder report's staff hours and the summaries. Approved time is never merged into (or merged away): a supervisor reopens it first. Audited as `time_entry.merge`, naming ids and field names only.
* **Start time.** A time entry may say when it started (*Start time (optional)*, HH:MM); the time list shows the range under the date. Without one, only the same minutes and description can match.
* **A device's entry is never refused for this.** A device cannot answer the question, so its pushed entry lands and is marked **Possible duplicate** of the earlier one (`time_entries.duplicate_of`, set by the office only); the device is told (a flagged warning, audited as `sync.conflict` flagged `duplicate`). The mark shows on the time list and, for an entry waiting for approval, on the Supervision page's staff-time queue with the other entry's hours, where **Merge** combines the pair and **Not a duplicate** clears the mark (`POST /api/time/:id/not-duplicate`, also for an approver without `time:write`).
* **The mark is the office's.** Sync never carries `duplicate_of`, so clearing it on a device that syncs with an office would only clear the device's copy and come back at the next pull: there **Not a duplicate** is refused (403, `rulingAtOffice`, "is done on the office SUDS"), as an approval is, and the time list and queue say *Not a duplicate? Clear the mark on the office SUDS.* instead of the button. SUDS on this device, with no office, clears its own. **Merge** works on such a device: it is an edit of the entry kept and a deletion of the other, which sync carries, and the office ends with no mark (`test/time-duplicates.test.js`, `test/kernel-sync-parity.test.js`).
* **A deleted entry leaves no mark behind.** A visit's own time entry, deleted with the visit or when the visit's duration was cleared, was removed without clearing the marks pointing at it, so the other entry kept *Possible duplicate* and its Merge answered 404. Those deletes now clear the marks first, as every other path that deletes an entry does (`server/routes/interventions.js`). The retention purge and a client merge keep time entries (the purge only removes their client link), so they leave no mark dangling.
* Schema: migration 68 adds `time_entries.start_time` and `time_entries.duplicate_of` (no data about people). API: `docs/API.md` *Possible duplicate time*. Audit actions `time_entry.duplicate.warn`, `.override`, `.dismiss` and `time_entry.merge` are catalogued in `docs/security/LOGGING-AND-AUDIT.md`. Tests: `test/time-duplicates.test.js`; the browser script `ux13` asks, cancels, saves anyway, merges, checks the approved lock and merges a device's duplicate from the queue, with axe on the question, the time list and the queue.

### A sign reminder opens its draft (built for 1.24.0, not yet released)

Feature work for 1.24.0, on its own branch (`feature/1.24-todo-note-link`); it goes through the release gate after the
stabilisation period (not before 2026-10-29). Nothing here is in a release yet.

#### Added: a "finish and sign" reminder opens the draft it is about

- Added: a supervisor's *Finish and sign* reminder now names the draft it was sent about (`tasks.note_id`) and offers
  **Open the draft**, which opens that note as the Notes list does (**Edit draft**, **Sign & lock**), over the page the
  worker is on: on the to-do itself (beside **Open <client>'s notes**, which stays), on its row on a phone, and when its
  title is tapped in Home's *To-dos for today*. Until now (1.23.3) it could only take the worker to the client's drafts
  list. Who may open the note is unchanged: the office checks it as for any note (a SUD counseling note is still only
  its author's, its co-signer's and holders of *Write clinical notes*).
- **Remind author** on a draft's row in Supervision links the reminder to that draft. **Remind all overdue authors**,
  which sends one reminder per author and client, links each to the **oldest overdue** draft of that author on that
  client (decided: the one most in need of finishing, rather than no link; the reminder still covers all of them).
- **Closing is unchanged (1.23.3):** the reminder covers all the author's drafts on that client's record and closes by
  itself when the **last** of them is signed (done) or deleted (cancelled). Signing or deleting the **linked** draft while
  others are left keeps the reminder open and drops its link, so it offers **Open <client>'s notes** again (the
  remaining drafts) rather than a note with nothing left to finish; it is not re-pointed at another draft. A reminder
  sent before has no link and works as before.
- Who may set the link (server/rules/tasks.js, both doors): only someone who may send a sign reminder (*Countersign
  notes*, `notes:cosign`), only on a to-do that is a sign reminder, and only to a draft the to-do's assignee wrote on
  the to-do's client; anything else is refused (403 for a navigator or the reminder's assignee re-pointing it, 400 for
  another client's or another author's draft or an ordinary to-do). A link to a note that is not a live draft
  (unknown, deleted or signed) is dropped and the reminder kept; so is a link that no longer fits after the to-do is
  given to someone else or moved to another client. A device carries the link in sync push under the same rules (a
  refused link refuses the row, as over the web app; a dead one is dropped). The assignee may still edit the reminder
  otherwise, and may clear the link.
- Schema: **migration 69** adds `tasks.note_id` (an id, no data about people; no `REFERENCES`, so a device that does
  not hold the note still stores the reminder). It follows migration 68 (possible duplicate time, above). `scripts/migration-order.js`
  acknowledges the new `tasks` definition (migrations 19 and 24 read it). No new route, permission or audit action:
  setting the link is a `task.create`/`task.update` (with `note_id` in its `fields`), and dropping it when the linked
  draft is signed or deleted is part of that `note.sign`/`note.delete`.
- Tests: `test/todo-note-link.test.js` (a supervisor sets it; a navigator, the assignee and wrong client or author are
  refused; deleted and unknown notes dropped; signing or deleting the linked draft; sync push), the 1.22.0 first-start
  fixture in `test/migrations.test.js` (fresh and upgraded identical; `note_id` NULL on every old to-do), and the browser
  script `ui-eval` (Remind author and Remind all set the link, **Open the draft** on the to-do, Home's title and a phone
  row, the fallback after the linked draft is deleted, with axe on each).

### Incoming referrals: an intake queue for referrals to the program (built for 1.24.0, not yet released)

Feature work for 1.24.0, on its own branch (`feature/1.24-incoming-referrals`), from the persona tests (county buyers:
SUDS tracks referrals *out*, not referrals *in* from the ER, jail, detox, probation and courts, other providers, the
person or their family). It goes through the release gate after the stabilisation period. Nothing here is in a release yet.

#### Added

- Added: **Incoming referrals**, an intake queue (`#/incoming`, in the menu; under *More* for a front-line worker, in the
  main list for a supervisor). A referral records its source (emergency department or hospital, jail or re-entry, detox or
  withdrawal management, probation/parole/court, another provider, self, family or friend, other), the referring
  organisation, the referrer's name, phone and email, when and how it arrived (phone, fax, email, walk-in, eReferral),
  the reason and needs, urgency (routine, soon, urgent), the person's name, date of birth and phone, and notes; and who it
  is assigned to. **+ Incoming referral** on the queue and in **+ Log**.
- The workflow: *new* → *contacting* (each attempt to reach the person logged with when, how and what happened) →
  *accepted* (linked to a client: an existing record found by the intake duplicate check on the referral's details, only
  records the worker may open, or with the client search; or a new client made with *New client — full intake* filled in
  from the referral, its own duplicate check included) / *declined* (why) / *unable to reach* / *referred elsewhere*
  (where). A closed referral other than an accepted one can be reopened.
- **Time to first contact**: the first attempt's time is kept (`first_contact_at`); each referral shows the hours from
  received to it, and the queue and Supervision show the median over the last 90 days and how many were tried within 24
  hours.
- Home: *N new referrals* (red when one is urgent) and *N incoming referrals assigned to you*. Supervision: an *Incoming
  referrals* card (the queue in numbers and the time to first contact). The *Referrals we make* page points to the queue.
- Permissions: **`intake:read`** (*See incoming referrals*) and **`intake:write`** (*Work incoming referrals*), held by
  navigators, clinicians, supervisors and administrators; never finance or read-only (both are identifying, so
  `grantProblem` refuses them to a de-identified role), marked sensitive, editable per person on the Permissions page
  like the others. Working the queue needs both (a denied read leaves nothing to write). Accepting also needs
  *Open client records* (`clients:read`), and a new client *Edit client records*.
- **Visibility (decided):** everyone with `intake:read` sees every open referral, a caseload-scoped worker included: a
  referred person is nobody's client yet, and intake is a shared desk. An accepted referral's client is reached as every
  client is (accepting into an existing record needs one the worker may open, else 403 and `authz.denied`). An
  accepted referral is the client's: a worker held to their caseload lists it, finds it by surname and opens it (with
  its attempts and its duplicate check) only when that client is on their caseload, and is otherwise refused 403 ("This
  client is not on your caseload", audited `authz.denied`) as for the client itself. Before the review of the 1.24.0
  tree the queue showed such a worker the name, date of birth, phone, reason, notes, attempts and client code of every
  accepted referral. The counts on Home, the queue's header and Supervision name nobody and still cover the whole queue.
- **Part 2 / HIPAA (decided):** receiving a referral is not a disclosure, so it writes no accounting row. SUDS builds **no
  send-back to the referrer** (no "let the referrer know"): telling them the person became a client would be a
  disclosure, made under the person's consent on their Consents tab like any other.
- **Not synchronised (decided):** `incoming_referrals` and `incoming_referral_attempts` are office-only
  (`server/sync-tables.js` `server_only`, their `_enc` columns in `unsynced_enc`): a field device never holds the names
  of people nobody has met. The route module is in the browser kernel, so SUDS on this device keeps its own queue; a
  device that syncs with an office refuses the routes (403, `officeOnly`) and hides Home's count and the + Log entry.
- Schema: **migration 70** adds the two tables and their indexes. The person's name, date of birth, phone, the reason,
  notes, the outcome reason, each attempt's note and the referrer's name, phone and email are `_enc`; `last_name_idx` is
  the queue's surname search (a blind index, re-derived by `scripts/rotate-index-key.js`); the referring organisation
  is readable (it names an agency, never the person).
- Retention: an accepted referral is the client record's (activity on it from `received_at`; deleted with it, with its
  attempts, leaving no tombstone); one closed without a client is deleted the retention period after it closed
  (`purgeExpiredIncomingReferrals`, daily, audited as a count); an open one is never due.
- Routes: `GET/POST /api/incoming-referrals`, `GET /api/incoming-referrals/summary`, `GET/PUT /api/incoming-referrals/:id`,
  `POST /api/incoming-referrals/:id/attempts`, `GET /api/incoming-referrals/:id/matches`, `POST /api/incoming-referrals/:id/accept`,
  `/close` and `/reopen`. Audit actions `incoming_referral.*` (create, read, list, update, assign, attempt, accept, close,
  reopen, purge) and `client.duplicate_check` with `source: incoming_referral`: ids, statuses and field names, never a value.
- Tests: `test/incoming-referrals.test.js` (roles allowed and denied, per-person denies, validation, encryption at rest,
  audit rows without PHI, filters and search, attempts and first contact, edit and assign, close/reopen, accept into an
  existing client and a new one, caseload limits on linking, retention, the synced device); `test/migrations.test.js`
  (migration 70; fresh and upgraded identical); `test/data-inventory.test.js`, `test/doc-content-currency.test.js`,
  `test/role-expansion.test.js`; the browser script `incoming-referrals` (record one, Home and the queue, an attempt, accept
  into a new client; with it the suite is now 60 scripts) and the accessibility audit of the queue, a referral and its form.

### Security & procurement page and hardening checklist (built for 1.24.0, not yet released)

Feature work for 1.24.0, on its own branch (`feature/1.24-procurement-hardening`), from the live persona tests ("zero
procurement surface in the live app — no BAA, pricing, SLA, or vendor contact anywhere a buyer can find"; "MFA and
hardening ship unset with nothing prompting the admin to turn them on"). It goes through the release gate after the
stabilisation period. Nothing here is in a release yet. No migration and no schema change: the new values are
settings rows.

#### Added: a Security & procurement page for organizations evaluating SUDS

- Added: `procurement.html`, reachable with no account from the sign-in page's footer (beside *Accessibility*), the
  menu's foot beside *Help* once signed in, the accessibility statement and the phone/tablet page, on an office server
  and on SUDS on this device alike. It says what SUDS is and the two ways to run it, and links the buyer guides, the
  procurement guide, the 90-day pilot kit, the security questionnaire, the threat model, the data inventory, identity
  and access, the security pack, the Accessibility Conformance Report, and the BAA/QSOA, DPA and support-SLA templates.
  It states the penetration test as it is: **not yet commissioned**, with the scope ready
  (`docs/security/PEN-TEST-SCOPE.md`), and that SUDS holds no SOC 2, ISO 27001, HITRUST, StateRAMP or FedRAMP
  attestation.
- The documents are linked on the SUDS repository's default branch (the static build ships no `docs/`, and the office
  server does not serve them), from one setting: `repository_url` (and `default_branch`) in `public/procurement.json`.
- Its **Contact and terms** block (legal entity, contact, email, web page, pricing, support and service levels) is the
  maintainer's to publish and SUDS never fills it in: each blank line reads *Not yet published by the maintainer*. On an
  office server an administrator publishes them under **Settings › Program › Security & procurement page** (settings
  `procurement_legal_entity`, `procurement_contact_name`, `procurement_contact_email`, `procurement_contact_url`,
  `procurement_pricing`, `procurement_sla`; `settings:manage`, audited as `settings.update`; an email must be one, the
  web page `https://`, the two texts up to 2,000 characters). The page reads them from the new public route
  `GET /api/procurement`, which answers without a session and carries exactly those six values (no program contact,
  organization name, version or configuration). On SUDS on this device the owner fills the same six keys in
  `public/procurement.json`, which ships with every one blank; an office server's settings win where both are set.
- Plain HTML with its script in `procurement.js` (the CSP forbids inline scripts); in the service worker's shell, so it
  opens offline; checked with axe on both builds (`scripts/ui/accessibility.mjs`) and end to end in
  `scripts/ui/static-site.mjs` and `scripts/ui/review-fixes.mjs`.

#### Added: the hardening checklist on Home and Security status

- Added: `GET /api/admin/security/hardening` (`settings:manage`; office server only, `server/hardening.js`): the
  security settings an office server ships with off, unset or merely defaulted, each with what it is, why it matters,
  its state now, and a link to the exact setting. Every item is **computed from the configuration in force**, never
  ticked by hand: it ticks itself off the moment the setting is saved (or the server restarts with the environment
  variable set), and comes back if someone turns it off. The items: two-step verification **required for
  administrators and supervisors and set up by every such account**; scheduled backups, **and an offsite copy**; the
  monthly restore drill (asked for once backups are scheduled); the automatic sign-out after inactivity, **confirmed**
  and 15 minutes or less; a fingerprint or authenticator code to sign and approve (`sign_strong_required`, off by
  default); HTTPS (served by SUDS or a proxy, `TRUST_PROXY`); the audit log's anchors off the database disk
  (`AUDIT_ANCHOR_DIR`); audit retention of at least six years; the sign-in rate limit; and the **weekly host compliance
  check** (SUDS Server's `suds-compliance.timer`): its last signed report's result and date, or that none has arrived
  (asked for on a server SUDS Server installed). The authenticator allow-list and required single sign-on are listed as
  options, not gaps.
- Changed: Home's **Finish setting up** (administrators, office server) lists the recommended items not yet done, in
  place of its two earlier steps for backups and two-step verification; each button opens Settings at that setting,
  its section open and the field focused (`#/admin?tab=settings&section=security|backups|sso|procurement&field=<key>`).
  The audit-anchor item is left off Home when the production banner above already says it.
- Added: **Settings › Security status** starts with a **Hardening checklist** card listing every item, done or not,
  with which are server settings for IT.

### Fixes from the persona test of 1.23.6 (built for 1.24.0, not yet released)

Fixes from the persona test of 1.23.6, for 1.24.0. No migration and no new permission name.

- **Assessments and the care plan no longer lose work when the module is off.** The six-dimension assessment, the
  screenings, the problem list and the care plan's goals and steps were offered on a client's record even while their
  programme module was switched off, and from an address naming the tab; the server refused the save (403) and what
  had been typed was gone. Switched off, a tab named in the address now shows the records made before, read only, with
  a notice saying the module is off and where it is switched on; no add or edit button is shown and no form opens. The
  page's own check of a module (`moduleOn`) now treats an unknown programme as off rather than on, and fetches the
  programme once (`GET /api/auth/me`) and draws the page again if a session came without it.
- **Long clinical forms keep a draft.** The six-dimension assessment, each screening, and the problem, goal and step
  forms keep what was typed when the dialog is closed or a save fails, as the visit, call and referral forms do: in
  the tab's memory only, never browser storage, cleared on sign-out (the same drafts as every other form).
- **A failed save is said where the person is.** On a form long enough that its error banner is more than half a
  screen above the Save button, the message is shown beside the button too, and the focus goes there (or to the
  first field to fix), as well as being announced. Every form built with the shared form helper gets this.
- **Add to waitlist is always in the Waitlist page's header** for a role that may add clients, not only while the
  list is empty; the page also says that someone already in SUDS goes on the list by setting their status.
- **A departed worker's draft notes can be handed on.** A supervisor or administrator (`records:manage-others`) can
  give the unsigned drafts of a worker whose account is inactive to another worker, who becomes the author and
  finishes and signs them: Settings › Move a caseload › *Draft notes left by departed workers*. New routes (office
  server only): `GET /api/notes/departed-drafts` (counts only), `POST /api/notes/:id/reassign { to_user_id }` and
  `POST /api/notes/reassign-drafts { from_user_id, to_user_id }`. A signed note is refused, as is an active author's
  draft, an inactive target, a target who may not write that kind of note or open the client, and a SUD counseling
  note to anyone without `notes:clinical:write`. The rule lives in `server/rules/notes.js` (`reassignRefusal`); sync
  push cannot change a note's author at all. Each move is audited as the new action `note.reassign` (the old and new
  author's ids, no title or text); a reminder to sign the old author's drafts on that record is cancelled once none
  is left.
- **Accessibility:** the global search box is now in a search landmark (axe "region").

## 1.23.6 — 2026-10-02

A patch of 1.23.5 that ships **with an owner-approved policy exception** (docs/RELEASE.md, *Stabilisation (from
1.23.1)*, and *Record: 1.23.6*). It is not a security fix: the owner decided that an administrator may change their
own permissions, their own role and their own account during the feature freeze, which widens what an administrator
may do, and the stabilisation commitment allows no new or widened permission in a patch. No migration, no permission
name and no route is added or changed, so the release-policy check passes on its own (`node scripts/release-policy.js
--version 1.23.6 --previous v1.23.5 --previous-ref 382278a` passes: 224 lines added outside docs, tests and generated
files, of the 1,500 a patch may add); the exception is recorded by hand, here, in *Record: 1.23.6* and in the
exceptions table, because no check can see it. Upgrading needs nothing beyond replacing the files and restarting. What
an administrator should know: whoever holds *Manage users & permissions* (`users:manage`, an administrator) may now
change their own individual permissions, their own role and their own account (including deactivating it), and
include themselves in *Apply to existing navigators and clinicians*, through the same dialogs and routes as for
anyone else; Users & permissions confirms each change to your own access first and applies it at once. A lockout
guard refuses any change, to yourself or to anyone, that would leave no active account able to manage users and
permissions ("This would leave no active administrator who can manage users. Give another account that access
first."). Each change to your own account is audited as one to anyone else's, with `self: true` in its details
(`user.permission.grant`, `.deny`, `.revoke`, `user.update`, which now also records a role change as
`role: { from, to }`; on a device, `local.account.role`); a change the guard refuses is `user.permission.denied`, or
the new audit action `user.update.denied`. A per-user deny placed on an administrator is now advisory, since the
administrator may remove it themselves (audited): to restrict an administrator, change their role. SCIM provisioning
and single sign-on deprovisioning are not held back by the lockout guard: the identity provider decides who has
left, and the emergency accounts provisioning never touches are the way back in. An office administrator who steps
down cannot promote themselves back (1.15.4 M2 still holds); on SUDS on this device the person who manages the
device keeps managing it whatever role they choose, and may take the administrator role back themselves.

### Administrators can change their own permissions, role and account

The owner's request: "Admin needs to be able to change all permissions
including their own." Until now an administrator could not change their own individual permissions, their own role,
deactivate their own account, or include themselves in *Apply to existing navigators and clinicians*; on SUDS on this
device the person who manages it could not change their own role. Each of those is now allowed, through the same
dialogs and routes (`PUT /api/users/:id`, `POST`/`DELETE /api/users/:id/permissions`,
`POST /api/users/caseload-default/apply`, `PUT /api/local/accounts/:id`). Who may do it is unchanged: whoever holds
*Manage users & permissions* (`users:manage`), which only an administrator can hold. No new permission, route or
migration.

- **Lockout guard.** Any change, to yourself or to someone else (a role change, a deny, removing an override, a
  deactivation), that would leave the programme with no active account able to manage users and permissions is
  refused: "This would leave no active administrator who can manage users. Give another account that access first."
  Deactivating yourself is allowed only while another active administrator remains (`server/auth.js`
  `lockoutProblem`). SCIM provisioning and single sign-on deprovisioning are not held back by it: the identity
  provider decides who has left, and the emergency accounts provisioning never touches are the way back in.
- **Confirmed first, effective at once.** Users & permissions confirms every change to your own access, naming what
  you lose or gain, and applies it to your session immediately (permissions are worked out at every request). If you
  remove your own user management, or step down from administrator, the page closes and you go to Home; deactivating
  yourself signs you out. A demoted administrator cannot promote themselves back (1.15.4 M2 still holds).
- **Audited the same way.** `user.permission.grant`, `.deny`, `.revoke` and `user.update` (now with
  `role: { from, to }`) carry `self: true` for a change to your own account; a refusal by the lockout guard is
  `user.permission.denied` or the new `user.update.denied`. On a device, `local.account.role` carries `self: true`.
- **Unchanged.** Approving your own time or spending, acknowledging your own break-glass access and other
  separation-of-duties rules stay refused. Permission changes ask for no re-authentication, for yourself or anyone,
  as before.
- Tests: `test/admin-self-permissions.test.js` (new), `test/device-signup-scope.test.js`, and the earlier refusals in
  `test/security-1154.test.js`, `test/user-permissions.test.js` and `test/least-privilege-default.test.js` updated;
  browser: `scripts/ui/permissions-admin.mjs` (confirmation, applied at once, the lockout message, leaving the page,
  axe on both dialogs), `ui-eval.mjs`, `signup.mjs`. Documentation: USER_GUIDE (*Users & permissions*),
  docs/security/IDENTITY.md, LOGGING-AND-AUDIT.md, THREAT-MODEL.md and QUESTIONNAIRE.md.

### Fixed in the security review of administrators changing their own access

- Fixed: two administrators demoting each other at the same moment, each also resetting the other's password, could
  both pass the lockout guard (the password was hashed between the check and the write) and leave nobody able to
  manage users; the password is hashed first, and the check and the write now run without a pause between them.
- Fixed: an administrator deactivating their own account and choosing someone to take their caseload had the move
  dropped without a word (their sessions ended first); the caseload now moves first, and if that fails nothing is
  deactivated.
- Changed: a refused permission change (`user.permission.denied`) is recorded as unsuccessful, as other refusals are.
- Documented: a per-user deny on an administrator is advisory now that administrators may change their own access;
  to restrict an administrator, change their role (docs/security/IDENTITY.md).

## 1.23.5 — 2026-10-02

A patch of 1.23.4 under the *Stabilisation* commitments (docs/RELEASE.md, *Stabilisation (from 1.23.1)*, and *Record:
1.23.5*): fixes from the market evaluation of 1.23.4, tests and documentation, with no migration, no new or widened
permission and no new route (`node scripts/release-policy.js --version 1.23.5 --previous v1.23.4 --previous-ref
598d08b` passes: 91 lines added outside docs, tests and generated files, of the 1,500 a patch may add). It passes the
release policy with no exception. It lets a call or text be deleted on a phone, shows a *Finish and sign* reminder's
**Assigned to** and **Client** fixed to whoever may not change them, shows the To-dos list's toggles (and the other
filters and one-of-several choices) as on or off by more than colour, and asks before a sign reminder is ticked done
while drafts are left. Upgrading needs nothing beyond replacing the files and restarting. What an administrator should
know: a *Finish and sign* reminder closed because its author signed their last draft on that record now writes a
`task.update` of its own (status `done`, cause `signed`, the note's id; `via: sync` from a device), as a delete and a
transfer already did, so signing writes one more audit entry per reminder it closes; the result of **Move a caseload**
(and of **Move and deactivate**) says how many sign reminders it cancelled: `caseload.transfer` counts them, and
`POST /api/caseload/transfer` returns the count in a new response field, `reminders_cancelled`; the supervision queue
no longer offers **Remind author** for a draft whose author's account is inactive (its unsigned drafts carry
`author_active`); and ticking a *Finish and sign* reminder done while you still have draft notes on its client's
record now asks first (the office still lets it be marked done).

### Fixed: deleting a call on a phone, a sign reminder's fixed fields, toggle state, and reminders on signing and transfer

- Fixed: on a phone a call or text could not be deleted from **Calls & texts**: a tap on your own opens its edit form,
  which had only Cancel and Save, and **Delete call** was only on the card a computer opens. The edit form now has
  **Delete call** (**Delete text**), for whoever may change it, with the same confirmation (what happens to its
  follow-up to-do). Visits and referrals already had Delete on a phone.
- Fixed: the worker given a *Finish and sign* reminder could change **Assigned to** and **Client** in its form, only to
  be refused on Save. For anyone but its maker or someone who countersigns notes the two fields are now shown fixed,
  with the reason under them; and the refusal (over the API or a device's sync) now reads "Only the supervisor who sent
  this reminder, or someone who countersigns notes, can …", since either may.
- Fixed (accessibility, WCAG 1.4.1 and 4.1.2): the To-dos list's **Assigned to me** and **Overdue** showed whether they
  were on by colour alone, and a screen reader could not tell. They are toggle buttons now (`aria-pressed`) and show a
  check mark when on; so are the filters on Calls & texts and the one-of-several choices on Spending, Overdose response
  and Reports' monthly trend.
- Fixed: a reminder closed because its author signed their last draft on that record had no audit entry of its own,
  only its id in `note.sign`; it now has a `task.update` (status `done`, cause `signed`, the note's id), over the web
  app and a device's sync, as a delete and a transfer already had.
- Fixed: after **Move a caseload** the result said how many to-dos were reassigned but not that sign reminders were
  cancelled; it now says how many (and so does deactivating someone with **Move and deactivate**). The supervision
  queue no longer offers **Remind author** (or counts in **Remind all overdue authors**) for a draft whose author's
  account is inactive: the row says *Author no longer active*. The drafts are not reassigned (that is for 1.24).
- Fixed: on SUDS on this device, typing `#/localsetup` while signed in showed a Sign up form inside the app; it now
  goes to Home.
- Fixed: ticking a *Finish and sign* reminder done while you still had draft notes on its client's record closed it
  with the work undone. On Home and the To-dos list it now asks first ("You still have N unsigned draft notes on this
  record. Mark the reminder done anyway?"); **Cancel** leaves it open. The office still lets it be marked done.

### Fixed in the review of the 1.23.5 integration

- Fixed: ticking a to-do on Home read the to-do again first (an audited `task.view`) to learn whether it was a reminder
  to sign notes; Home's list now says so itself (`sign_reminder`), still without the to-do's details.
- Fixed: **Mark selected done** on the To-dos page and **Status: Done** in a to-do's form closed a reminder to sign
  notes without the question the box asks; the form now asks it, and the bulk confirmation names the reminders selected.
- Fixed: a sign reminder's Client box lost its own error description when it was given the reason it cannot be changed.

## 1.23.4 — 2026-10-01

A patch of 1.23.3 under the *Stabilisation* commitments (docs/RELEASE.md, *Stabilisation (from 1.23.1)*, and *Record:
1.23.4*): fixes from the market evaluation of 1.23.3 and the integration review, tests and documentation, with no
migration, no new or widened permission and no new route (`node scripts/release-policy.js --version 1.23.4 --previous
v1.23.3 --previous-ref c02a261` passes: 111 lines added outside docs, tests and generated files, of the 1,500 a patch
may add). It passes the release policy with no exception. It keeps a supervisor's *Finish and sign* reminder with the
author and client it was sent for, keeps Home's keyboard focus when Home is laid out again, lists the to-do just done
first when **View in Done** opens the Done list, says what deleting a draft, call, visit or referral does to its
to-dos, and offers a to-do's tick box only where you may mark it done. Upgrading needs nothing beyond replacing the
files and restarting. What an administrator should know: no new audit action; a *Finish and sign* reminder can now be
given to someone else, or moved to another client, only by whoever made it or someone who holds *Countersign notes*
(`notes:cosign`), over the web app or a device's sync (its assignee can still change its date, priority, status and
details); the To-dos list shows a to-do's tick box only where the office would let you mark it done (your own, one
you made, or anyone's if you manage others' records); and at the office, each reminder cancelled because its author's
last draft was deleted now writes one more audit entry of its own (`task.update`, status `cancelled`, cause
`deleted`, the note's id), as a device's sync already did.

### Fixed: a moved sign reminder, Home's focus, and what a delete does to its to-dos

- Fixed: the worker a *Finish and sign* reminder was given to could reassign it to a colleague, or move it to another
  client, and it still counted there: Supervision showed the colleague's draft as reminded (**Sent**, with no **Remind
  author**) and **Remind all** skipped it. Only the supervisor who sent it, or someone who may send one, now changes
  who or which client it is about; anyone else is refused (403 over the web app; a device's change is not taken). Its
  assignee can still change its due date, priority, status and details, and an ordinary to-do is passed on as before.
- Fixed: deleting a draft that closed a supervisor's reminder (the author's last draft on that client's record)
  wrote only `note.delete` over the web app, with the reminder's id in it; the reminder now has its own `task.update`
  entry, as on a device's sync.
- Fixed: when Home was laid out again at the 640 px breakpoint (a window resized, or zoomed past it) with the keyboard
  focus on its heading, the focus fell to the page itself, and a keyboard or screen-reader user lost their place. It
  now moves to the new Home's heading.
- Fixed: a *Finish and sign* reminder named its client twice on Home ("Finish and sign your draft notes for Park,
  Danielle (DEMO-0007) · Park, Danielle"), and its details named them with their code. A new reminder is titled *Finish
  and sign your draft notes*, its client shown beside it as for every to-do, and its details say "this client's
  record". It is still recognised by its last line; reminders already sent keep their words.
- Fixed: on a client's Notes tab showing your drafts, once the last of them was signed or deleted the page said "You
  have no draft notes on this record" and then "No notes yet…" for a client with notes. It now says only *No draft
  notes left to sign on this record.*, with **Show all notes**; and signing or deleting a draft there stays on your
  drafts rather than going back to every note.
- Fixed: every call's delete confirmation said "(a follow-up to-do someone has edited is left open)", whether or not
  the follow-up had been edited. It now says the open follow-up is cancelled when it is as SUDS made it, and that it is
  left open only when it has been changed (reassigned, started, its date or title changed, or details added): the
  office's own rule. The same for a visit or a referral.
- Fixed: deleting a draft note said only "Delete this draft note?", though deleting your last draft on a client's
  record cancels the supervisor's reminder to sign them. The confirmation now says so when it does.
- Fixed: **View in Done** opened the Done list in due-date order, oldest first, so on a phone the to-do just ticked off
  could be below the first screen and look missing (seen once in about seven tries in the evaluation of 1.23.3; the
  save itself always finished before the button appeared). The to-do just done is now listed first in Done, marked
  *Just done*, and is read on its own if the list does not have it.

### Fixed in the review of the 1.23.4 integration

- Fixed: the To-dos list offered a tick box on a colleague's to-do and said "you can mark it done", but the office
  refuses that (only whoever it is assigned to or made it, or someone who manages others' records, may change it,
  marking it done included); the box and the promise are gone where it would be refused (`public/views/tasks.js`).
- Fixed: moving a worker's caseload (Supervision › Transfer caseload) handed their supervisor's "finish and sign"
  reminders to the receiving worker, where they passed for reminders about the receiver's drafts. They are cancelled
  instead, since the drafts stay the departing author's, audited as `task.update` with `cause: transferred`.
- Fixed: a delete confirmation could say a follow-up to-do was cancelled when the office kept it (one retitled since),
  and called another to-do linked to the record a follow-up; it now says the follow-up is cancelled "unless it has been
  changed since it was made", and leaves other linked to-dos out.
- Fixed: deleting someone else's draft could say their supervisor's reminder was cancelled when the office, counting
  drafts the deleter cannot see, kept it; that sentence is now shown only to the draft's author.

## 1.23.3 — 2026-10-01

A patch of 1.23.2 under the *Stabilisation* commitments (docs/RELEASE.md, *Stabilisation (from 1.23.1)*, and *Record:
1.23.3*): fixes from the external retest of 1.23.2 and the integration review, tests and documentation, with no
migration, no new or widened permission and no new route (`node scripts/release-policy.js --version 1.23.3 --previous
v1.23.2 --previous-ref a45c716` passes: 187 lines added outside docs, tests and generated files, of the 1,500 a patch
may add). It passes the release policy with no exception. It adds **View in Done** beside **Undo** when a to-do is
marked done, lays Home out again when the screen's width crosses 640 px (a phone's first sign-in no longer keeps the
computer's layout), and gives a *Finish and sign* reminder a way to the drafts it asks about (**Open <client>'s
notes**). Upgrading needs nothing beyond replacing the files and restarting. What an administrator should know: no new
audit action; a to-do whose details end with the *Finish and sign* reminder's line is now accepted only from someone
who holds *Countersign notes* (`notes:cosign`, as **Remind author** needs), over the web app or a device's sync, and
only such a supervisor's reminder counts as one (Supervision shows it, signing closes it; one made by anyone else,
before 1.23.3 included, is an ordinary to-do); Home follows the screen's width, but waits while someone is working in
it; the "Done" message has **View in Done**, which opens the To-dos list showing Done; and a reminder closed because
the author's last draft was deleted is now *cancelled* (`task.update`, cause `deleted`), not done.

### Fixed: View in Done, Home on a phone's first sign-in, and supervisors' sign reminders

- Fixed: after a to-do was marked done there was no way to the Done list. The "Done" message, on Home, on the To-dos
  list and on its phone rows, now has **View in Done** beside **Undo**: it opens To-dos showing Done, with the to-do in
  it, keeping the list's own *Assigned to me* choice (Home's to-dos are your own, so from Home it is yours). The
  message stays while either button has the keyboard focus or the pointer is over it, and Tab moves between them.
  **Undo** still puts the to-do back as it was (an in-progress to-do stays in progress), now from the To-dos list too,
  whose message said only "Marked done".
- Fixed: on a phone's first sign-in, *To-dos for today* was on the first screen on some loads and about 800 px down on
  others (an external retest at 390 × 844: 2 of 4 loads). Home chose its phone or computer layout once, from the
  screen's width when its figures came back, and a phone browser whose window was still at another width at that
  moment kept the computer's layout. Home now follows the width: when it crosses 640 px (the window settling, a phone
  turned, a window resized), Home is laid out again, unless someone is working in it, in which case it waits for them
  to leave the control. Reproduced and checked in a browser: 6 of 10 cold sign-ins in the top 700 px before, 10 of 10
  after.
- Fixed: any staff member could make a to-do for a colleague ending with the sign reminder's line; Supervision then
  showed the colleague's draft as reminded (hiding **Remind author**), and signing closed it. Only someone with
  *Countersign notes* can now write that line into a to-do, new or edited, over the web app or a sync push, and only
  their reminders are recognised by Supervision and closed by signing; one made by anyone else, including before
  1.23.3, is an ordinary to-do.
- Fixed: a *Finish and sign* reminder had no way to the drafts it asks about: on a phone it opened as Edit to-do. It
  now offers **Open <client>'s notes**, which opens the client's Notes tab on your own drafts there (**Show all notes**
  goes back), and tapping it on Home goes straight there.
- Fixed: the reminder's title named one note ("…note from Aug 26") and its details said "this draft note", but it
  covers all the author's drafts on that client's record. It is now "Finish and sign your draft notes for <client>",
  and says it closes once they are all signed. Reminders with the old wording still work.
- Fixed: Home's to-do checkbox was drawn at 13 px on a phone since 1.23.2 (its label lost the class that sized it).
  It is 24 px again, inside its 44 px target.
- Fixed: a reminder closed because the author's last draft was deleted was marked done; it is now cancelled. Deleting
  a call, text, visit or referral now says, when it has one, that its open follow-up to-do (and for a referral, a
  supervisor's reminder to record its outcome) is cancelled too.

### Fixed in the review of the 1.23.3 integration

- Fixed: the assignee of a supervisor's ordinary to-do could still append a "finish and sign" reminder's line as it was
  written before 1.23.2 ("Reference: supervision reminder for note …") and pass the to-do for a reminder; the write
  check now refuses either line, as recognition reads either (`server/rules/notes.js` `hasReminderLine`).
- Fixed: a Home redraw for a change of width could land just after the router had drawn Home, taking the focus the
  router gave the heading; a render by the router now supersedes a redraw in flight.
- Fixed: **View in Done** while **Undo** was still saving opened the Done list without the to-do; it waits now.
- Fixed: the delete confirmation took a worker's own to-do titled like a supervisor's referral reminder for one.
- Known: a supervisor's open "finish and sign" reminder is recognised by its maker's permission as it is now, so if the
  supervisor no longer countersigns notes, it stays open until the worker ticks it off.

## 1.23.2 — 2026-10-01

A patch of 1.23.1 under the *Stabilisation* commitments (docs/RELEASE.md, *Stabilisation (from 1.23.1)*, and *Record:
1.23.2*): fixes from the evaluation of 1.23.1 and its integration review, tests and documentation, with no migration,
no new or widened permission and no new route (`node scripts/release-policy.js --version 1.23.2 --previous v1.23.1
--previous-ref 3bff36f` passes: 188 lines added outside docs, tests and generated files, of the 1,500 a patch may add).
It passes the release policy with no exception. It fixes Home's *To-dos for today* on a phone (tapping a title no
longer marks the to-do done; **Undo** reopens it as it was), the follow-up to-dos of a call with no purpose, a deleted
referral's reminder and a follow-up left open by a sync push that moved and deleted its record at once, a clinician's
new note type, and controls hidden under the floating **+ Log** button. Upgrading needs nothing beyond replacing the
files and restarting. What an administrator should know: no new audit action; a supervisor's *Finish and sign*
reminder now covers an author's drafts on one client's record, so *Remind all overdue authors* sends one per author
and client, and it closes when they are all signed or the last is deleted (a reminder made by 1.23.0 or 1.23.1 still
closes when its note is signed); only the to-do's maker can make a to-do a sign reminder by its last line; and
deleting a referral, at the office or from a device, cancels its supervisor's reminder (`task.update`, cause
`deleted`).

### Fixed: Home's to-dos, follow-up titles, reminders and the phone layout

- Fixed: on Home's *To-dos for today*, tapping a to-do's title marked it done, because the title was inside the
  checkbox's label and the box saves at once. Now only the box marks it done (named "Mark done: <title>" for a screen
  reader), the title is a button that opens the to-do, or the call, visit or referral it came from, as *Open the call*
  does on the To-dos page, and the "Done" message has an **Undo** that reopens it. Each is at least 24 px to hit, and
  44 px on a touch screen.
- Fixed: a to-do from a call, visit or referral offered its record only inside Edit on a phone. The phone To-dos list
  now has **Open the call** (or visit, or referral) on the row itself.
- Fixed: a call or text with no Purpose gave a follow-up to-do titled "Call back: client", the stored value. It is now
  "Call back" (or "Text back") for the client, whom the to-do names already, and "Call back: Family" (the call form's
  words) for anyone else. A to-do made by 1.23.0 or 1.23.1 with the old title is still SUDS's own: changing the call's
  date moves it.
- Fixed: with offline copies off on the office server, *Set up this phone for the field* said both that the worker may
  make the phone a field device themselves and that an administrator decides first. It now says only the second.
- Fixed: on a phone, a link or button brought into view from the keyboard could stop under the floating **+ Log**
  button; the page now scrolls it clear. The browser suite checks that nothing is left under the button at the end of
  Home (its cards open) and the main lists at 390 × 844.
- Fixed: a clinician's new note, with no format remembered, started as a narrative and was read as an administrative
  one. A holder of `notes:clinical:write` now starts a **Clinical** note in the **Progress** format (while Progress is
  on the programme's list); an administrative note still starts as a narrative, and a navigator's form is unchanged.
- Fixed: a sync push that changed a call's, visit's or referral's follow-up date and deleted it in the same batch left
  its follow-up to-do open, with its link cleared: the delete looked for a to-do due on the new date, which the office
  had not moved it to yet. The to-do is now found by its link and the date it had before the push, and cancelled
  (audited as `task.update` with cause `deleted`), as for any other deletion.
- Fixed: a supervisor's reminder to record a referral's outcome (*Remind worker*) stayed open when the referral was
  deleted. Deleting the referral, at the office or from a device, now cancels it, audited as `task.update` with cause
  `deleted`. The reminder is still recognised by its `referral.remind` audit entry, now in one place
  (server/rules/follow-ups.js) for the queue and the delete.
- Fixed: a supervisor's *Finish and sign* reminder ended "Reference: supervision reminder for note <record id>", which
  the worker read as noise. Its last line now says what closes it: once the author's draft notes on that client's
  record are signed (at the office or on a device), it closes. One reminder covers an author's drafts on one client's
  record, so *Remind all overdue authors* sends one per author and client. A reminder made by 1.23.0 or 1.23.1, with the
  id line, still closes when its note is signed.
- Docs: docs/QUICK-START-WORKERS.md names a call's button **Log call** (and a text's **Log text**), not "Save", and
  describes Home's to-dos and the new note type; docs/market/EVALUATION-RESPONSE.md and STRATEGY.md state 1.23.1 as
  the latest release.

### Fixed in the review of the 1.23.2 integration

- Fixed: a worker could paste a "finish and sign" reminder's last line into any to-do someone else gave them on a
  client, which then passed for a supervisor's reminder (keeping **Remind** away) and closed when they signed. Only the
  to-do's maker can now put that line into it, at the office and from a device (`server/rules/tasks.js`).
- Fixed: a "finish and sign" reminder whose last draft was deleted rather than signed stayed open; deleting the
  author's last draft on that record now closes it, audited as `task.update` from a device (`note.delete` lists it).
- Fixed: **Undo** on Home's "Done" reopened an in-progress to-do as open, and took the worker back to Home if they had
  moved on; it now reopens it as it was, where they are.
- Fixed: a worker's own to-do titled just "Call back" or "Text back" could be taken for a call's follow-up and moved
  or cancelled with it; only a to-do linked to the call, or with a purpose in its title, is.

## 1.23.1 — 2026-10-01

A stabilisation patch of 1.23.0: fixes, tests, documentation and evidence, with no migration, no new or widened
permission and no new route (`node scripts/release-policy.js --version 1.23.1 --previous v1.23.0 --previous-ref 9877d07`
passes: 501 lines added outside docs, tests and generated files, of the 1,500 a patch may add). It is the first release
under the new *Stabilisation* commitments (docs/RELEASE.md, *Stabilisation (from 1.23.1)*, and *Record: 1.23.1*) and
passes the release policy with no exception: a feature freeze until 2026-10-29, no policy exception except a security
fix, 1.23.x as the supported line, every release tagged by the owner and published by `release.yml`, and CI checking
the release policy on every push. It closes the open items 1.23.0 left (a field-device request left open by a
deactivated account; a deleted call, visit or referral's follow-up to-do), a device's to-do linked to a colleague's
referral, an outreach contact undone after it reached the office, the office app's service worker stalling on a
server with offline copies off, and the worker-facing rough edges of 1.23.0 on a phone; and it adds the recovery
drill, upgrade drill and installer run on the released 1.23.0. Upgrading needs nothing beyond replacing the files and
restarting. What an administrator should know: one new audit action, `device.field_request.close`; field-device
requests and to-dos left open by a deactivated account close the next time an administrator opens the list; and the
office app now keeps, for the open tab only, who is signed in and the programme's lists in `sessionStorage` (no PHI),
so a reload with no signal still opens Street outreach (docs/security/DATA-INVENTORY.md).

### Release discipline: the policy checked on every push, and the stabilisation commitments

- Fixed: the release policy was checked only in `release.yml`'s gate, which no release since 1.16.2 has been through,
  so nothing turned red when work after a release broke it. CI's new `release-policy` job
  (`scripts/release-policy-ci.js`) runs it on every push against the newest release (its tag, or while the tags are
  owed the commit `docs/evidence/RELEASE-HANDOFF.md` records): a patch that adds a migration, permission or route, or
  more than the patch size limit, fails, and so does a minor within 28 days of the previous feature release unless a
  security exception is recorded.
- Fixed: docs/RELEASE.md had no commitment after ten releases in two days under exceptions. Its new *Stabilisation
  (from 1.23.1)* section sets a feature freeze (1.24.0 no earlier than 2026-10-29, through the gate), no policy
  exception but a security fix, 1.23.x as the supported line, and every release tagged by the owner and published by
  `release.yml`, with no direct `gh-pages` push once the owed tags exist. The tag hand-off and HANDOFF.md now lead with
  the owner's tag push, the action that unblocks self-hosting and the gate; QUESTIONNAIRE #36 and #39 and the IT buyer
  guide state the freeze and support window.
- Fixed: workers had no short plain-language help: docs/QUICK-START-WORKERS.md has one-screen task cards (log a
  contact, street outreach with or without signal, follow-ups and to-dos, notes, referrals, a phone as a field device)
  in the app's own words, and the pilot kit has a measurement worksheet and a worker-feedback procedure built on what
  SUDS already records.

### Fixed: to-dos left open after their reason went, the outreach waiting list, and device links to a colleague's referral

No migration, no new route and no new permission; one new audit action, `device.field_request.close`.

- **Fixed: a field-device request left open when the worker's account is deactivated** dropped off Settings › Synced
  devices but left every administrator's to-do open. Deactivating the account (Users & permissions, SCIM, or SSO
  deprovisioning) now closes the request and cancels those to-dos, with a line in each saying why, audited as
  `device.field_request.close` (and `task.update` per to-do); a request left open this way before 1.23.1 is closed
  the next time an administrator opens the list. Approve and Decline also add a line to each administrator's to-do
  saying who answered and how. The list of requests no longer reads `_` in `field_request:` as a wildcard
  (`server/field-request.js`).
- **Fixed: deleting a call or text, a visit or a referral left its follow-up to-do open** with only the link cleared.
  It is now cancelled by the follow-up rule (`server/rules/follow-ups.js` `cancelForDeleted`) when still as SUDS made
  it, at both doors (the REST delete and a device's sync deletion, through a new push-only `beforeDelete` hook in
  the tables' rules), audited as `task.update` with `cause: deleted`; a to-do the worker has changed or added details
  to is left for them to close.
- **Fixed: the outreach waiting list counted a contact the worker had undone as "sent".** A contact the office had
  received (its answer lost with the signal) and that was deleted since is not recorded again; the waiting list now
  says *1 waiting contact was not recorded: it had been undone since it was first saved*. Within 24 hours the office
  used to answer the waiting list's send from the first attempt's stored Idempotency-Key answer ("made"); a send from
  the waiting list (`X-Suds-Queued`) is now answered by the route's own durable rule, which knows the contact was
  deleted (`server/idempotency.js`, `public/outreach-queue.js`).
- **Fixed: a to-do from a device could link to a colleague's referral** (`tasks.referral_id`), the same crafted link
  1.23.0 closed for calls and visits: it could keep the colleague's follow-up to-do from being made, or, with the
  reminder's reference line in its details, pass for a supervisor's reminder in *Waiting to hear what happened*. A
  link a device sets or changes now stands only when the referral is the to-do's worker's own (a link the office made,
  sent back unchanged, is kept), and the queue counts as a reminder only a to-do someone else gave the worker
  (`server/rules/tasks.js`, `server/routes/supervision.js`).

### Fixed: field-device messages, to-do names and the phone layout

- Fixed: approving a field-device request while offline copies are off on the office server (the default) told the
  administrator the person's "devices are field devices from their next sync" and told the worker "every phone you
  sync is a field device", though no phone could keep an offline copy. Synced devices now says offline copies are off
  and what turns them on (`LOCAL_MODE_ENABLED=true`, or `"localModeEnabled": true` in `data/server.json`, then a
  restart), in the request card, the Approve dialog and the result; the worker's *Set up this phone for the field*
  says *Approved, but not ready yet* — their account is set as a field account, their office has not turned on
  offline copies, and to ask their SUDS administrator. Messages only; no route or setting changed.
- Fixed: on a phone, a to-do row's Open button was heard as "Open Call about detox bedUrgent"; it is now
  "Open: Call about detox bed (Urgent)" (every phone list whose row has its own control).
- Fixed: unticking **Follow-up needed** on the call form left the date showing, though the server clears it on save;
  the form now clears it too.
- Fixed (phone, 390 px): a banner (the 2-step reminder) sat over the open menu's brand and programme name; the menu
  now covers the banners. The offline banner is one short line and a **Working offline** link (it was five lines;
  the full explanation is still said to a screen reader once). The **+ Log** button no longer covers the Part 2
  notice badge on Home: the alert badges stop short of its column and wrap.
- Fixed: Home's **To-dos for today** had no cap (nine rows pushed *Continue where you left off* far down a phone); it
  shows at most five, overdue first, then **N more due to-dos**, which opens To-dos.
- Fixed: clinicians lost **Notes** from the phone menu in 1.23.0 though their day is notes; anyone who writes
  clinical notes keeps it in the phone's main menu, and **Supplies** folds into More for them instead (still at most
  12 top-level entries; navigators unchanged).

### Evidence on 1.23.0: recovery drill, upgrade drill and installer run

Evidence and tests only; no change to what SUDS does. One finding for the owner, recorded and not fixed here.

- **Recovery drill on 1.23.0** (docs/evidence/dr-drill-2026-10-01-v1.23.0/): `scripts/dr-exercise.js --clients 20000`
  on the released tree (`9877d07`, schema 67, 79 tables): 11 of 11 checks, drill RTO 4.5 s, host-procedure RTO 3 s,
  RPO 5 s, within a second of the five earlier drills; the signed report verifies with the public key beside it.
- **Upgrade drill to 1.23.0** (docs/evidence/upgrade-drill-2026-10-01-v1.23.0/): databases written by 1.21.0 and
  1.22.0 (20,000 fictional clients each) opened by 1.23.0, migrations 64 to 67 and 67. The driver now has the older
  release narrow a device to the field scope, turn the authenticator allow-list on (a metadata file signed under the
  TEST-ONLY root) with a passkey enrolled before it and an attested one under it, make follow-up to-dos from a call and
  a visit, send a supervisor's reminder to sign a draft, record each programme's consent to publication (1.22.0) and
  publish a county release. 1.23.0 keeps every one of those rows unchanged by the columns the older release had; tells
  the field device, and its account's next new device, `field`; refuses the passkey from before the list after 1.21.0
  and honours its grace period after 1.22.0; moves the to-dos when their dates change, with no second one; closes the
  reminder when the draft is signed; and publishes a corrected release of the older release's period after 1.22.0
  (refused after 1.21.0, which kept no inputs, as documented). Schema identical to a fresh install, nothing lost; 28 of
  28 steps and 11 of 11 drill checks each.
- **`test/fixtures/release-v1.22.0.sql`** (`make-release-fixture.js --rich` from `8b136df`; the maker now writes a
  release's county publication releases, withdrawal, consents and corrected release through that release's API, since
  their CHECKs refuse made-up rows) joins the release-fixture upgrade test, and `test/migrations.test.js` checks 1.23.0's
  first start on it: the county publication tables, the field device and its account, the passkeys (attested, and in a
  grace period), the sessions, the follow-up to-dos and a reminder come through unchanged by 1.22.0's columns; the new
  `tasks` columns are NULL; an old to-do is linked and moved the first time its call's or visit's date changes; the
  reminder closes; the audit chain verifies.
- **Installer run on 1.23.0** (docs/evidence/installer-container-run-2026-10-01-v1.23.0/): `install.sh` 1.23.0 on
  Ubuntu 24.04 with systemd in a container (38 pass, 1 fail: the container's clock; drills 11 of 11 and, with the
  escrowed key file, 12 of 12); `upgrade.sh` 1.22.0 → 1.23.0 with the installed 1.22.0 script (exit 0, migration 67,
  the same compliance result). The 1.21.0 run's findings are closed: under the service's sandbox SUDS logs "listening
  on", with no unhandled rejection, and `/api/setup/status` and `/api/app/info` answer 200 for a signed-in session;
  the dry run from a zip names the possible hand-over; the staging line names the operator's checksum. **Finding:**
  1.22.0 and 1.23.0 ship the same `upgrade.sh` and `lib.sh`, so the installed upgrader rightly ran the upgrade itself
  and the hand-over between two real releases has still not been seen; it was exercised again with a probe build.

### Fixed: the office app with no signal, to-dos that open their record, and the sample referrals

- Fixed: the office app's service worker never finished installing on an office server with local mode off (the
  default): the server rightly answers 404 for `local/*`, and `Cache.add()` and its retry left those answers unread,
  each holding one of the browser's six connections to the server, so the install stopped at 19 of 62 files and every
  later request from the worker (`/api/health` included) waited for ever; with no signal, pages then failed and a
  reload did not load at all. The worker now fetches each file itself and cancels every answer it does not keep
  (`public/sw.js`; `test/sw-phi.test.js`).
- Fixed: with no signal, a page that needs the office showed the browser's "Failed to fetch dynamically imported
  module …"; it now shows a plain *You're offline* page with a link to Street outreach (any other failure keeps its own
  message). A reload with no signal loads the app from the worker's copy and keeps the person signed in on that tab
  (who is signed in and the programme's lists, in `sessionStorage`, no PHI; checked with the office again when the
  signal is back), so Street outreach's waiting list still works (docs/security/DATA-INVENTORY.md).
  `scripts/ui/offline-outreach.mjs` now covers the office app's worker and the app offline.
- Fixed: a to-do that came from a call, a visit or a referral did not open it. Its row and **Edit to-do** now offer
  **Open the call**, **Open the visit** or **Open the referral**; a supervisor's reminder opens the referral's
  **Record outcome** form. The reminder's details no longer end with the referral's record id and give the date as the
  app does ("Jun 19, 2026"); a reminder made by 1.23.0 is still recognised (`test/supervision-referrals.test.js`).
- Fixed: none of the sample referrals (`npm run seed`, Load sample data) cited a consent or had its accounting row, so
  editing an open one, even only its follow-up date, asked for a consent. They now cite the client's consent and have
  their accounting rows (`test/demo.test.js`). And an edit that changes only a shared referral's follow-up date or
  notes, which tells the provider nothing new, no longer asks for a disclosure basis, over REST or by sync; any change
  that does (status, provider, warm hand-off, appointment, urgency, what is shared) still passes the consent gate
  (`test/disclosure-gates.test.js`).

### Fixed in the review of the 1.23.1 integration

- Fixed: a to-do someone else gave a worker, renamed by the worker to the reminder's title, passed for a supervisor's
  reminder and kept **Remind worker** away. A reminder is now the to-do its `referral.remind` audit entry names
  (every reminder 1.23.0 made has one), whatever its title or details say (`server/routes/supervision.js`).
- Fixed: a tab reloaded with no signal, restored from its own copy of who was signed in, could send the phone's
  waiting contacts as soon as the signal came back, before the office had said who the cookie belonged to; on a
  shared phone where someone else had since signed in in another tab they would have been recorded as theirs.
  Nothing waiting is sent until the office has answered (`public/app.js`, `public/outreach-queue.js`).
- Fixed: moving only the follow-up date of a referral that has a barrier or an outcome from a device was still
  refused for want of a consent: the device's free text was compared with the office's ciphertext
  (`server/routes/referrals.js`).
- Fixed: the release-state check did not read a patch's hand-off row, whose stamp cannot name its own hash
  (`scripts/release-state.js`).

## 1.23.0 — 2026-10-01

A feature release (migration 67; new routes `POST /api/supervision/referrals/:id/remind`, `GET /api/me/field-device`,
`POST /api/me/field-device/request`, `GET /api/admin/field-requests` and `POST /api/admin/field-requests/:userId/approve`
and `…/decline`; no new permission), released under a policy exception inside 1.22.0's 28 days (docs/RELEASE.md,
*Record: 1.23.0*). It goes on making the day of the people who use SUDS most easier: a follow-up date added or changed
by editing a call, a visit or a referral now makes, moves or cancels its to-do; the menu is built for the worker's role
and programme (Street outreach in the main menu of navigators and clinicians in the street profiles) and a phone's Home
opens on today's to-dos; a street-outreach contact that names nobody waits on the phone when the office app has no
signal, and is counted once however late it is sent; a worker can ask for their phone to be set up for the field; and a
supervisor sees the referrals still waiting to hear what happened, with **Remind worker** and **Record outcome**. It
also brings the documents up to the latest container run and fixes what the integration review found. Upgrading runs
migration 67 on start (two nullable columns on `tasks`). What an administrator should know: **the menus change for
front-line roles** (navigators, peer navigators and clinicians: Street outreach moves up in the harm-reduction and
treatment-adjacent profiles, the Waitlist moves under More in a harm-reduction programme, Notes under More on a phone,
and *Funding & spending* and *Policies & contracts* appear under More; permissions are unchanged, and supervisors,
finance, read-only and administrators keep their menus); **a phone's Home opens on To-dos for today**, with the
program-wide cards folded until opened; **the office app now keeps something in the browser**: a street-outreach
contact saved with no signal waits in IndexedDB until it is sent, held to a contact that names nobody (no client,
participant code or notes, which the office refuses from the waiting list), not encrypted, per account, and kept
through sign-out for that worker's next sign-in (docs/security/DATA-INVENTORY.md); and **workers can ask for a field
device** (*Set up this phone for the field*): every administrator gets a to-do, and **Approve** under **Settings ›
Synced devices** holds the worker's account to the field scope on every device it syncs from, which only narrows what
those devices keep (docs/PLATFORM.md, *Field devices*).

### Fixed: follow-up to-dos follow the follow-up date

Released in 1.23.0. Migration 67 (`tasks.call_id`, `tasks.intervention_id`). A follow-up date added by
editing a call or text, or a visit, made no to-do, and a changed date left the to-do on the old day; the call form's
help said "A date puts a to-do on your list". Now one rule (`server/rules/follow-ups.js`) makes, moves and cancels the
follow-up to-do of a call or text, a visit and a referral, on insert and on update: a date set makes the to-do (when the
record has no open one), a changed date moves it, a cleared date (or **Follow-up needed** unticked on a call, which now
also clears the date) cancels it, and saving the same date again does nothing. It changes only a to-do SUDS made that
is still as SUDS made it (open, the record's worker's, SUDS's title, the record's previous follow-up date; to cancel it,
no details added), so a worker's own edits to a to-do are never lost. The REST routes and sync push both run it: the
office reconciles a device's calls, visits and referrals once the whole push has landed, finding the to-do the device
sent (linked by `call_id`/`intervention_id`, or, from an older kernel or before migration 67, by its title, client,
worker and date) instead of making a second one. A to-do SUDS makes, moves or cancels this way is audited
(`task.create`/`task.update`, with `from` and the record's id; no PHI). The call, visit and referral forms' help says
what a date does. docs/USER_GUIDE.md, *Follow-up dates and your to-dos*.

### Supervision: referrals waiting to hear what happened; My profile at 1366 px; documentation currency

Released in 1.23.0. No migration and no new permission; one new route,
`POST /api/supervision/referrals/:id/remind`.

- **Supervision › Referrals needing attention › Waiting to hear what happened** (it was *No outcome recorded
  yet*). Only referrals with no outcome at all are listed: **No answer yet** (contacted: the provider has not
  replied) and **Appointment set** (scheduled, with the appointment's date: nobody has said whether it happened).
  Accepted and waitlisted referrals are no longer listed: by the referral's loop-closure rules they are the
  provider's answer, and they stay open on the worker's own list with the referral's follow-up to-do (decision, with
  that conservative reading: docs/USER_GUIDE.md, *Supervision*). The plain status words replace "(contacted through
  scheduled)"; the oldest is first, with how long it has waited in days.
- **Row actions, as for unsigned notes.** **Open referral** (the client's Referrals tab), **Remind worker** and
  **Record outcome** (for a role with `referrals:write`; the row itself opens the form, or the referral without it).
  Remind worker gives the worker who made the referral a to-do on the client's record, due today, linked to the
  referral (`tasks.referral_id`), so recording the outcome closes it. Its text names the provider, as the
  referral's own follow-up to-do already does, who asked and when the referral was sent; nothing from the
  referral's notes or outcome. Title and details are encrypted; the audit entry `referral.remind` names the
  referral, client, worker and to-do by id. One open reminder per referral, whoever sent it (the queue's rows carry
  `reminded_at`). Only a supervisor of that worker's team may send one, by the queue's existing scoping: a holder of
  `notes:cosign` or `assignments:manage` with `referrals:read` and `tasks:write`, of every worker with `clients:all`,
  otherwise of staff who name them as supervisor; never to themselves or to a closed account (`may_remind` on each
  row). Navigators and finance are refused (403, audited).
- **My profile at a 1366 px laptop.** *Active sessions* takes the grid's whole width; in one of three columns its
  table ran about 150 px past its card and had to be scrolled sideways. A phone still shows one card per session.
- **Documentation currency.** The market scorecard's SUDS Server row, STRATEGY, HOSTING, BUYER-GUIDE-IT, the
  security ARCHITECTURE and the README now cite the latest container run (1.21.0, 2026-10-01) and say that 1.22.0
  fixed what it found (the listener under the service sandbox, the upgrade dry run) and that 1.22.0 itself has not
  been run in the container; they said 1.20.0 fixed what "that run" found and cited the 1.19.0 run. The
  accessibility conformance report is revised for 1.22.0 (no conformance level changes; 1.22.0's screens are audited
  by axe in `scripts/ui/worker-usefulness.mjs`; screen-reader testing still not done, as of 1.22.0).
  LOGGING-AND-AUDIT names `referral.remind`.
- Tests: `test/supervision-referrals.test.js` (which statuses are listed and in what order; the reminder's to-do,
  encryption, audit entry, one-at-a-time rule and closing with the outcome; who may and may not send one);
  `scripts/ui/worker-usefulness.mjs` (the heading and plain status words, the three row actions, a reminder sent
  and shown, the outcome form, the table fitting at 1366 px, My profile at 1366 and 390 px, axe on each).

### Street outreach with no signal on the office app; "Set up this phone for the field" (no migration)

Released in 1.23.0. New routes: `GET /api/me/field-device`, `POST /api/me/field-device/request`,
`GET /api/admin/field-requests`, `POST /api/admin/field-requests/:userId/approve` and `…/decline` (`users:manage`).
No new permission.

- **A contact that names nobody waits on the phone.** On the office app, a street-outreach contact saved with no signal
  used to stay in the form until there was signal again. A contact with no client, participant code or notes is now
  kept on the phone (IndexedDB, `public/outreach-queue.js`) and sent by itself when the phone is back online or the
  worker next signs in; **N contacts waiting to send** in the header says how many, and Street outreach lists them with
  **Send now** and **Discard**. A contact with a participant code or notes is not kept (no PHI in the office app's
  browser storage, 42 CFR Part 2, shared phones); the screen says so and offers **Keep it without the code and notes**.
- **Counted once, however late.** Each contact carries one Idempotency-Key from its first attempt; an anonymous visit's
  id is derived from the account and that key (`server/crud.js` `keyedId`), so a contact sent again after the 24-hour
  idempotency window, or after it was undone, is answered with the same id and draws no stock again. The office
  refuses a client, participant code, notes, cost or a client service from the waiting list (`X-Suds-Queued: 1`,
  `server/routes/interventions.js` `checkQueued`). The save is audited as before; a repeat as
  `intervention.create.replayed`.
- **The offline banner** no longer links office users to *Use SUDS on this device* (get-app.html, a different SUDS that
  cannot send the contact in hand to the office). It says what is kept and points at **Set up this phone for the field**.
- **Set up this phone for the field** (`#/field-phone`, `server/field-request.js`): what a field device keeps and who
  decides (a worker may narrow; only an administrator widens), how to set the phone up yourself where offline copies are
  allowed (**Keep only what I need in the field** on This device › Sync, as before), and **Ask my administrator**, which
  gives every administrator a to-do. **Settings › Synced devices** lists the requests with **Approve** (every device the
  worker syncs from becomes a field device: narrowing only) and **Decline**. Audited as `device.field_request`,
  `device.field_request.approve` and `.decline`.
- **Undo of an outreach contact** also puts **Same as last contact** back to the bundle before it, or hides it when
  there was none; it used to keep offering the undone bundle.
- Tests: `test/outreach-queue.test.js`; `scripts/ui/offline-outreach.mjs` (offline with Playwright's `setOffline`, the
  header count, sent once, axe); `worker-usefulness`, `r10-outreach` and `navigator-fixes` follow the new behaviour;
  the accessibility script audits `#/field-phone`.

### Worker-first menu and phone Home

Released in 1.23.0. No migration, no new permission or route (the folded cards are a preference,
`home_folded`, in the existing `/api/me/prefs`).

* **The menu by role and programme profile, from one table** (`public/nav.js`, new: the pages and where each goes;
  `public/app.js` builds the menu from it). **Street outreach is in the main menu** of navigators and clinicians
  (a peer navigator uses the navigator role) in the harm-reduction and treatment-adjacent profiles; it was under More
  for every front-line role. The **Waitlist** moves under More in a harm-reduction programme, and **Notes** under More
  on a phone (the ☰ menu, up to 900 px wide), where Home's *Continue where you left off* and its unsigned-notes link
  lead to them. **Funding & spending** and **Policies & contracts**, which a navigator may open (a navigator records
  spending) but which were in no menu, are under their More. Reports, the funder report, State reporting, SUPRT-A
  and Import stay under More. Supervisors, finance, read-only and administrators keep their menus. Permissions are
  unchanged. Phone menu, top-level entries with More as one (before → after): navigator, peer navigator and
  clinician 12 → 12 (treatment-adjacent, Street outreach now among them), 12 → 11 (harm reduction), 11 → 10 (Part 2
  layer); supervisor 11 (unchanged). The menu crosses the phone width on its own when the window does.
  `test/nav-menu.test.js` checks every role × profile × module switches × phone or computer: every page a role may
  open is in its menu (main list or More) and none it may not; a front-line phone menu has at most 12 top-level
  entries; Street outreach leads in the street profiles.
* **Phone Home is triage.** At 390 px Home opens on **To-dos for today**, then the status links in one compact row
  (unsigned notes, clients to contact, Part 2 notices), then *Continue where you left off*; the welcome card, the
  check-in list and the program-wide figures come after, and the **Update this page every 90 seconds** switch moves
  to the foot. The program-wide cards (*at a glance*, the visits chart, the team's hand-offs, consents expiring)
  **fold**, folded on a phone and open on a computer until the person chooses, and the choice is remembered per user
  (prefs `home_folded`). The welcome card has a **×** beside *Got it*; either puts it away for that user on every
  device. A computer keeps its layout. Measured on the seed at 390 × 844, first sign-in with the welcome showing:
  "To-dos for today" at 799 px → 235 px from the top (on the first screen); Home 3,308 → 2,577 px tall for a
  navigator, 3,685 → 2,954 px for a peer navigator (2,326 and 2,703 px once the welcome is dismissed). At 1,280 px
  the navigator's Home without the welcome is 1,644 → 1,635 px.
* Browser checks: `scripts/ui/menu-home.mjs` (new, in the suite) — the menu as drawn for a navigator, a peer
  navigator, a clinician and a supervisor in each profile at 390 px, Street outreach opening from the peer's menu,
  "To-dos for today" in the top 700 px on a first sign-in, the welcome's ×, the folded state after a reload, the
  desktop order, and axe on the phone Home and the open phone menu. `programme.mjs` and `r7.mjs` follow the new
  menu and the folded tiles. With `menu-home.mjs` and `offline-outreach.mjs` the suite is now 59 scripts.

### Fixed in the review of the 1.23.0 integration

* **An outcome recorded by editing a referral closes its to-dos.** Setting a referral's status to admitted,
  completed, declined or closed from its edit form (or on a device) records its outcome, but left its follow-up to-do
  and a supervisor's *Remind worker* to-do open, although the referral had left *Waiting to hear what happened*; only
  **Record outcome** closed them. Both doors now close them the same way (`server/rules/follow-ups.js`, audited as
  `task.update`). Tests: `test/supervision-referrals.test.js`, `test/follow-ups.test.js`.
* **Send now with an ended session.** A street-outreach contact waiting on the phone, sent with **Send now** after
  the session had ended (timed out, or signed out elsewhere), was answered *Still no signal*, and nothing asked the
  worker to sign in. It now says the session has ended and opens the sign-in screen; the contacts stay on the phone
  and are sent as soon as the worker has signed in again (not up to 20 seconds later). The waiting list no longer
  throws when the session ends while it is being read, and never shows one account's list to the next one signed
  in. `scripts/ui/offline-outreach.mjs` checks it (52 checks).
* **A waiting contact the office already has is found, not refused.** When the screen's own attempt had reached
  the office (its answer lost with the signal) and the contact could no longer be made by the time the waiting list
  sent it again (its supply site retired, or its period closed, a day or more later), the office refused it and the
  phone marked it *Not accepted*, inviting the worker to enter it a second time. The contact's keyed id is now looked
  for before the write rules (`server/crud.js`), so it is answered as already made. `test/outreach-queue.test.js`.
* **A device's to-do can no longer be linked to a colleague's call or visit.** A to-do sent from a device that
  names a call or visit of another worker (`call_id`, `intervention_id`) keeps the to-do and drops the link, so it
  cannot stop the office making that colleague's follow-up to-do (`server/rules/tasks.js` `beforeStore`,
  `test/follow-ups.test.js`).

## 1.22.0 — 2026-10-01

A feature release (migrations 64, 65 and 66; the county publication consent routes; no new permission), released
under a policy exception inside 1.21.0's 28 days (docs/RELEASE.md, *Record: 1.22.0*). It makes the day of the people
who use SUDS most easier: a call-back date that always makes its to-do, quick dates, where a client stands at the top
of the Overview, Undo and *Same as last contact* in street outreach, notes that start in the author's last format, and
the sync state in the header of a device that syncs with the office. It binds the field scope to the account rather
than to a device id, records each programme's consent before the county publishes figures that name it, lets a
withdrawn release be corrected, pro-rates awards to the period, gives the authenticator allow-list a grace period and
makes a county file version 2 only when the county is known to read it. It also scopes the penetration test from the
threat model, says plainly that 1.16.3 to 1.21.0 were published without a tag, fills out the county packet, revises
the accessibility conformance report, re-runs the evidence on 1.21.0 and fixes the SUDS Server listener under its
sandbox. Upgrading runs migrations 64 to 66 on start. What an administrator should know: **the field scope now follows
the account**, so a whole device of an account held to the field scope (one of its devices was ever a field device,
or **New devices start as field devices** is on) becomes a field device at its next sync, after sending what it
recorded, unless an administrator marks it **Keep everything** first (docs/PLATFORM.md, *Field devices*); **a county
file made by hand is version 1** unless the county's connection says it reads version 2 or the programme answers that
the county runs SUDS 1.21 or later (docs/COUNTY-VIEW.md, *Which version a file is made in*); and **the authenticator
allow-list's grace period is 14 days by default** (0 stops a refused passkey at once, as under 1.21.0;
docs/FINGERPRINT.md, *Grace period*).

### Fixed: SUDS Server problems the installer run on 1.21.0 found

Released in 1.22.0. No migration.

- **The listener no longer fails to start under SUDS Server's sandbox.** `deploy/linux/suds.service` restricts the
  address families to IPv4, IPv6 and Unix sockets, so `os.networkInterfaces()` throws there; `server/listener.js`
  read it on every start, which logged an unhandled rejection, never printed "listening on", left the setup wizard's
  listener switch without its handler, and gave signed-in staff a 500 on `/api/setup/status` and `/api/app/info` (the
  *Get the app* page stayed empty). Behind Caddy the LAN addresses are not needed: they are now "none" when the list
  cannot be read (`test/listener-sandbox.test.js`). The sandbox stays as tight as it was.
- **`upgrade.sh --dry-run` from a zip says the release's own upgrader may take over**, since a dry run does not unpack
  the zip and so cannot compare them; before, it showed only the installed upgrader's plan.
- **The release zip's checksum note names the operator's checksum** ("matches the checksum given with
  --release-sha256"), not "the pinned checksum", which is Node.js's and Caddy's.

### Field devices: the scope follows the account (released in 1.22.0)

- **The field scope can no longer be left through the device id.** The id a device sends is its own word, and
  before this a sync sign-in with no id, or a new one, got the whole scope. Now, once any device of an account has
  been a field device (an administrator, its user enrolling it, the programme default), or while **New devices start
  as field devices** is on, the account is held to the field scope on every device (migration **64**,
  `field_accounts`): a new, reinstalled or unknown device id is registered as a field device at its first sign-in
  (nothing for the worker to do); a whole device of that account becomes a field device at its next sync (it sends
  what it recorded first, as any change to the field scope does); a session with no device that calls the sync
  routes is sent, and held to, the field scope. Revoking or wiping a device does not release the account.
- **A device's sync sign-in that names no device is refused** for such an account (*this sync did not say which
  device it is from*; audited `auth.login.device_unidentified`), rather than registered: there is nothing stable to
  register, narrow, revoke or wipe. SUDS on a device always sends its id. Owner decision, conservative default.
- **Full scope is an administrator's decision about one device.** *Hold everything* under **Settings › Synced
  devices**, or the new *Keep everything* on a whole device of an account held to the field scope, records
  `devices.scope_set_by = 'admin'` (migration 64), and only that keeps a device whole for such an account (for
  example a supervisor's office computer). It is per device, not a per-person flag, so a new or reinstalled device
  starts in the field scope until an administrator marks it; it is cleared if the device signs in as someone else.
  Upgrading: a device an administrator had already made whole again keeps that decision; any other whole device of
  an account held to the field scope (including, with the programme default on, a device first seen before it was
  turned on) becomes a field device at its next sync. Owner decision, conservative default.
- **A field device's sync session reaches less of `/api/auth/`:** signing in, the second step and signing out, which
  is all SUDS on a device uses. Changing the password, two-step verification, fingerprint sign-in or sessions from it
  is refused with a message to use a web browser (`server/auth.js` `assertSyncSessionReach`, checked for every
  request, not only routes that call `requireAuth`).
- Docs say exactly what is enforced: docs/PLATFORM.md *Field devices*, THREAT-MODEL (field rows and residual risk 20:
  the scope bounds the device's offline copy, not what the account may reach in a browser), DATA-INVENTORY
  (migration 64), LOGGING-AND-AUDIT (`device.account_field`, `auth.login.device_unidentified`, the `device.scope`
  routes). Tests: `test/field-device.test.js` (a missing id with the default on, a rotated id, an administrator's
  whole device, a user who cannot widen, the `/api/auth/` narrowing); `scripts/ui/field-device.mjs`.

### Security documents: the pen-test scope from the threat model, honest release integrity, a fuller county packet (no migration, permission or route)

Released in 1.22.0. These fix findings of the market evaluation of 1.21.0.

- **Penetration-test scope** (`docs/security/PEN-TEST-SCOPE.md`). A merge had duplicated four county rows; those
  are gone. QUESTIONNAIRE #38 claimed rows that did not exist, and they are now added:
  - *Field devices and participant codes*: scope enforcement, where a session's scope comes from (a sync sign-in
    with no `X-Device-Id`, a fresh id or another device's id), push refusals, and the sync session's reach into
    `/api/auth/*`;
  - *Authenticator allow-list and metadata upload*: attestation formats, synced passkeys refused, the FIDO
    Metadata Service file's chain, rollback and test root;
  - *County file version 2: award amounts*;
  - *SUDS Server upgrade hand-over*;
  - *SUDS on this device*;
  - *Data at rest and keys*.

  Input handling, disclosure controls, audit integrity and the release pipeline now include the threats the threat
  model lists for them. `test/pen-test-scope.test.js` maps every row of the threat model's mitigation tables to a
  scope row through an explicit table. It fails on a threat with no row, on a stale mapping and on a duplicated
  row, and checks that #38 names only rows the scope has.
- **Release integrity, said plainly.** QUESTIONNAIRE #36 and #39, the RFI template, BUYER-GUIDE-IT and the threat
  model now say that 1.16.3 to 1.21.0 were published without a tag, without a GitHub Release and without the release
  gate's approval: direct pushes to `gh-pages`, recorded as policy exceptions. They say what that means for a county
  verifying a build, and how to verify one against its commit instead: rebuild the zip and compare its SHA-256 with
  the tag hand-off, and run `scripts/release-site-check.js` against the commit. That check was run on 1 October 2026
  against 1.20.0's site and commit `8f365b4`, and the 71 built files matched byte for byte. The RFI template has a new
  *Release integrity* answer.
- **The authenticator allow-list and synced passkeys.** QUESTIONNAIRE #19a and the RFI now say that with the
  allow-list on, synced passkeys (iCloud Keychain, Google Password Manager: attestation `none` or `apple`) cannot be
  added, and that turning it on ends unproven passkeys: at once under 1.21.0, and after the grace period below from
  1.22.0.
- **`scripts/release-state.js`**: a new check fails while released versions are untagged and QUESTIONNAIRE #36,
  #39 or the RFI's *Release integrity* answer does not say they were "published without a tag" and name the first
  and last of them (`untagged-undisclosed`, `untagged-range`). Untagged versions come from the hand-off's owed tags,
  and from origin's tags when it can be reached. Tested with synthetic documents, and against the repository's own
  answers with the phrase removed.
- **County evidence packet** (`scripts/county-packet.js`): now also holds THREAT-MODEL, DATA-INVENTORY,
  LOGGING-AND-AUDIT, COUNTY-VIEW, BACKUP-AND-DR and INCIDENT-RESPONSE. Its README flags every file that states a
  release of an older minor line than the packet's as **Older than this release**: today the accessibility report
  (levels established on 1.11.0) and the recovery, upgrade and installer evidence and latest drill (1.20.0). The
  flag appears in a list above the table and in the file's row.
- **Accessibility conformance report** (`docs/accessibility/ACR-WCAG21.md`), revised for 1.21.0 with a dated note.
  The automated axe audits now cover the screens 1.21.0 added: the Publish tab and its dialogs, the field-device
  settings and device screens, participant-code mode, the authenticator allow-list card, the award fields and the
  county reminders. The note names the script and the widths for each. For these screens neither the manual review
  nor any screen-reader testing was done, and screen-reader testing of the product is still pending (an owner item).
  No conformance level changed.

### Safer defaults: the authenticator allow-list's grace period and the county file version

Released in 1.22.0. Migration 66 (`passkeys.allowlist_grace_until`).

- **A grace period before the authenticator allow-list stops a passkey.** Under 1.21.0, turning the allow-list on (or
  taking a model off it) stopped every passkey it refused at once, which could lock out an account whose only second
  factor was its passkey. Now a passkey the new setting refuses that was working until then keeps working for a grace
  period the administrator sets on the card: **14 days by default, 0 to 90; 0 stops it at once** as before. The end is
  a date stored on each passkey, so it is exact and tested with a fake clock; saving again never lengthens a grace
  period already running, a shorter one shortens it, and turning the list off clears them. **Never for a model the
  FIDO Metadata Service reports compromised or revoked**: such a passkey is refused at once, grace period or not, and
  its sessions end. A session a passkey in its grace period opens expires when the grace period ends, and the hourly
  housekeeping ends any left, audited as `security.authenticator_allowlist.grace_ended`.
- **Everyone is told.** The person whose passkey is in a grace period sees, on every page from sign-in on and on My
  profile, which passkey stops, on what date, and how to keep signing in (add a passkey on an accepted authenticator,
  or sign in with the password and an authenticator-app code). The administrator's preview says when each passkey
  stops, and lists first, apart, the accounts whose only second factor stops, warning that they will need their
  password and an authenticator-app code or a new accepted passkey. The card states that synced passkeys (iCloud
  Keychain, Google Password Manager) cannot be added while the list is on. Docs: FINGERPRINT.md, *Grace period*.
- **The county file is version 2 only when the county is known to read it.** Under 1.21.0 a programme exchanging files
  by hand made version 2 unless someone ticked a box, and a county still on SUDS 1.20 refused it. The Send to the
  county card now asks, **once for each county code**, which SUDS the county runs (1.21 or later, 1.20 or earlier, or
  don't know) and remembers it. The file is version 2 when the county connection's `/status` says that county reads it
  or the programme answered "1.21 or later"; otherwise version 1, and the card says that award amounts need the county
  on SUDS 1.21 or later. A version asked for by name still wins; the connection's own answer wins over the
  programme's. The export audit records why (`version_source`). Docs: COUNTY-VIEW.md, *Which version a file is made
  in*.

### County publication governance and award pro-rating

Released in 1.22.0. Migration 65 (`county_publication_consents`, `county_publication_inputs`; office
server only). No new permission: everything here is `county:manage`, and reading is `county:view`.

- **Each programme's consent to publication, recorded and enforced.** County view › Programs shows, per programme,
  whether it agreed in writing to the county publishing figures that name it ("Agreed in writing" and the date, or
  "No consent recorded"); a county manager records the date of the agreement and its reference (encrypted; shown to
  `county:manage` only), or withdraws it, in the Publication consent dialog (audited
  `county.publication.consent.record` and `.withdraw`, never with the reference). A publication release that would
  name a programme without a current consent is refused, naming the programmes; the preparer may instead tick
  **Leave out programs with no consent to publication**, and the release then states which were left out and why
  (docs/COUNTY-VIEW.md, *Publication*, decisions 7 and 8). Before, the publication screen published any registered
  programme, while the data contribution agreement draft forbade publication without the programme's written
  agreement.
- **A withdrawn release can be corrected.** A period that overlaps any release, withdrawn or not, is still refused,
  except exactly the same period once every release of it is withdrawn: the corrected release is audited with every
  total the withdrawn ones printed as known to the reader (`sdc.js` `fixed` cells beside the programmes' own figures
  then and now), so nothing new can be worked out by setting the two side by side, and it says what it corrects. A
  brute-force differencing test across the withdrawn and corrected releases pins it. Each release now keeps what it
  was screened from (encrypted) for this; a release published before 1.22.0 kept nothing, so its period stays
  closed (decision 3).
- **Award pro-rated to the period.** Next to "Spent against the award (%)", the combined view, the by-quarter view,
  the CSV and Excel and the read API show **"Award pro-rated to the period"** (award × days of the period inside the
  award period ÷ days in the award period) and **"Spent against the pro-rated award (%)"**, so a quarter is no longer
  read as under-spending a year's award. The whole-award figures are unchanged (docs/COUNTY-VIEW.md, *Award amounts*).
- **Documents.** The data contribution agreement draft's section 4.2 now describes publication with the consent
  record (it said SUDS had no publication function); COUNTY-KIT, DATA-NETWORK and DEMO-SCRIPT no longer call the
  publication screen or the field device scope unbuilt or planned. `test/doc-content-currency.test.js` now fails when
  a buyer, market or security document says a feature the CHANGELOG lists as released is "not built", "planned", "not
  yet" or exists only "until" something.

### Day to day for frontline workers

With `worker-usefulness.mjs` the suite is now 57 scripts.

Released in 1.22.0. No migration, permission or new route; one response gains fields (the supervision
queue's referrals say who made them) and the call routes derive one flag. From a walk-through of a navigator's,
an outreach worker's, a peer's, a counselor's and a supervisor's day at 390 px and on a desktop
(docs/USER_GUIDE.md has each change where workers read about it).

- **Fixed: a call-back date with "Follow-up needed" left unticked made no to-do.** The call and text form's
  *Remind me to call back on* (*to follow up on*) date now ticks the box when a date is chosen, and the call routes
  treat a date as the follow-up whichever way the call is saved (`server/routes/calls.js` `deriveFollowUp`, beside
  `deriveCrisis`). Before, the date was stored and the reminder silently never made.
- **Quick dates.** A to-do's Due date has *Today*, *Tomorrow*, *In 3 days*, *In a week*; the follow-up dates on a
  visit, a call or text and a referral have *Tomorrow* to *In 2 weeks*. One tap instead of four or five in a phone's
  date picker; a labelled group of buttons, and the date chosen is announced (`public/app.js` `quickDates`, a
  `quick` option on any date field). A new to-do's form no longer asks for a Status (a new to-do is open).
- **Where things stand.** A client's Overview opens with the last contact (how long ago, what, who), the next
  to-do (overdue in red) and the open referrals, read from the timeline the page already loads (no new request, no
  new data, the same audit entry). At 390 px it used to sit some 3,000 px down, below the identity details.
- **Street outreach.** *Save contact* stays at the foot of the screen while the counts are filled in; **Undo** for
  10 seconds after a save takes the contact back (the worker's own delete, so the supplies return to the stock and
  the deletion is audited as before) without taking the keyboard focus off the form (`undoToast` `focus: false`);
  **Same as last contact** fills in the last bundle handed out in one tap (only item ids and counts are remembered,
  in the worker's own preferences, never anything about the person).
- **Notes.** A new note starts in the format its author last saved a new note of that type in (per user, while the
  format is still on the programme's list); the structured sections' boxes (SOAP, DAP, BIRP, GIRP, safety plan)
  are now labelled for screen readers (they were four unnamed text boxes); *My notes* says whether it is on
  (`aria-pressed`).
- **Supervision.** *No outcome recorded yet* says who made each referral and how long ago it was sent
  (`GET /api/supervision/queue` `referrals_awaiting_outcome[].worker`, `worker_id`).
- **A device that syncs with the office** shows in the header, on every page, whether changes are waiting to be
  sent (**⇅ 3 to send**, **Synced 2d ago**, **Not synced yet**; on a phone **⇅ 3** or **⇅ ✓**, with the words kept
  for a screen reader), opening This device. Read from the device's own kernel; not on SUDS on this device.
- **The search box's hint fits a phone** (*Name, code or exact phone…*; it was cut off at "name, c").
- Tests: `test/worker-usefulness.test.js` (the call follow-up, Undo's delete and stock, the queue's worker);
  `scripts/ui/worker-usefulness.mjs` (51 checks, axe on every new state, at 390 px where workers use it), added to
  `scripts/ui/run-all.sh`. `scripts/ui/r10-ai.mjs` now chooses *narrative* for its narrative-note step, since a new
  note starts in the clinician's last format.

### Evidence on 1.21.0: recovery drill, upgrade drill and installer run

Evidence and tests only; no change to what SUDS does. Two findings for the owner, recorded and not fixed here.

- **Recovery drill on 1.21.0** (docs/evidence/dr-drill-2026-10-01-v1.21.0/): `scripts/dr-exercise.js --clients 20000`
  on the released tree (`348e18c`, schema 63, 76 tables): 11 of 11 checks, drill RTO 4 s, host-procedure RTO 3.9 s,
  RPO 5 s; the signed report verifies with the public key beside it.
- **Upgrade drill to 1.21.0** (docs/evidence/upgrade-drill-2026-10-01-v1.21.0/): databases written by 1.16.2, 1.19.0
  and 1.20.0 (20,000 fictional clients each) opened by 1.21.0, migrations 61 to 63 included. The driver now has the
  older release also enrol and use a passkey (1.19.0 on), sign in a sync device, and (1.20.0) enter a county quarter
  for a programme not on SUDS; 1.21.0 keeps every county row, session, device and passkey unchanged, gives devices
  `sync_scope` full, no client a participant code, no passkey an attestation and no older session a `device_id`,
  signs the passkey and the device in again and publishes a screened county release. Schema identical to a fresh
  install, nothing lost; 25 of 25, 27 of 27 and 27 of 27 steps, 11 of 11 drill checks each.
- **`test/fixtures/release-v1.20.0.sql`** (`make-release-fixture.js --rich` from `8f365b4`; the maker now writes the
  county rows of a release with county-entered figures through that release's API, since its CHECK refuses made-up
  ones) joins the release-fixture upgrade test, and `test/migrations.test.js` checks 1.21.0's first start on it:
  county rows, a county-entered one included, survive unchanged; the passkey, the device and the sessions keep their
  values with the new columns' defaults; the audit chain verifies.
- **Installer run on 1.21.0** (docs/evidence/installer-container-run-2026-10-01-v1.21.0/): `install.sh` 1.21.0 on
  Ubuntu 24.04 with systemd in a container (38 pass, 1 fail: the container's clock; drills 11 of 11); `upgrade.sh`
  1.20.0 → 1.21.0 with 1.21.0's own script, as documented, and with the installed 1.20.0 one (the same result);
  1.19.0 → 1.21.0 with the installed 1.19.0 script, where 1.21.0 names the two `WEBAUTHN_*` lines at start and in
  `app.passkeys`; the hand-over exercised with a probe build. **Findings:** `deploy/linux/suds.service` lacks
  `AF_NETLINK` in `RestrictAddressFamilies`, so `os.networkInterfaces()` throws in `server/listener.js`: an unhandled
  rejection at every start and HTTP 500 from `/api/setup/status` and `/api/app/info` for a signed-in session (since
  1.19.0 at least); and `upgrade.sh --dry-run` from a zip does not show the hand-over.
- Citations moved to this evidence: the evidence index, BACKUP-AND-DR, the questionnaire's recovery and installer
  bullets and the county RFI answers.

### Integration review of the 1.22.0 streams

Released in 1.22.0. No migration, permission or route.

- **A brand-new device of an account held to the field scope is held from its first push.** Before, a new device id
  became a field device at sign-in but its pushes were judged by the full scope until its first pull; a device first
  seen has nothing recorded under another scope, so it is now held at once (`server/devices.js` `touch`,
  `test/field-device.test.js`).
- **Fixed: a device revoked, or told to erase itself, kept syncing on a session it already had open.** Revoking and
  wiping were checked only when a device signed in, so a sync session open at that moment went on pulling and pushing
  until it expired, and a whole device's session reached the rest of the API; a revoked device's session was not even
  narrowed to its account's field scope. Now the next request on such a session is refused (`403`, `deviceRevoked` or
  `wipeRequested`) and the session ends; signing out still works, and signing in again delivers the wipe as before
  (`server/auth.js` `assertSyncSessionReach`; `test/field-device.test.js`).
- **Fixed: a corrected or new publication release could name a programme whose consent was withdrawn while it was
  being published.** The consent was checked when the release was screened, not where it is written; publishing now
  checks again in the same transaction and refuses (`409`, `no_consent`) a release that would name a programme whose
  consent was withdrawn in between (`server/county-publication.js` `record`; `test/county-publication.test.js`).
- **The Send to the county card offers periods by the server's date** (the programme's time zone, as the file
  route and the reminders judge "ended"), not the browser's clock.
- **Browser suite:** `county-connect.mjs` and `county.mjs` read the quarter from the server when they use it and
  choose it on the card by name, so a run across midnight on a quarter's last day no longer sends one quarter and
  looks for another; `scripts/county-sample.js` takes `--today`.
- **Documents:** QUESTIONNAIRE #19a, the RFI template, the threat model, the market README and BUYER-GUIDE-IT no
  longer say the allow-list stops unproven passkeys with no grace period (a check in
  `test/doc-content-currency.test.js` keeps it so); PLATFORM and the threat model say a user can reuse the id of their
  own *Hold everything* device; COUNTY-VIEW's owner decisions say which are 1.22.0's, and two notes no longer call
  migration 64 another branch's or unneeded; LOGGING-AND-AUDIT lists the publication consent actions once.

## 1.21.0 — 2026-09-30

A feature release (migrations 61, 62 and 63; the county publication, field-device, authenticator allow-list and
county reminder routes; no new permission), released under a policy exception inside 1.20.0's 28 days
(docs/RELEASE.md, *Record: 1.21.0*). It builds what the documents called planned: a screened **publication release**
of the combined county figures, **field devices** that hold only what a field worker needs, with **participant
codes first** for outreach, an **authenticator allow-list** for passkeys, **award amounts** in the county file
(version 2) and **reminders** when a county file is due. It adds a threat model and fuzz tests for the county
surface and SUDS Server, a check of the release documents against the repository, a county evidence packet, the
evidence re-run on 1.20.0, and a test that keeps the documents' content current. Upgrading runs migrations 61 to 63
on start; field devices, participant codes first and the allow-list are off until an administrator turns them on.
Upgrade a county's server before its programmes send version 2 files (docs/COUNTY-VIEW.md, *Award amounts*).

### Security: the county surface's threat model and fuzz tests

Released in 1.21.0. No migration.

- **Threat model brought to the current release.** `docs/security/THREAT-MODEL.md` was brought to 1.20.0, the
  release then current (at this stamp it is on 1.21.0, with the surfaces 1.21.0 adds), and models the county surface
  in full (*The county surface*: its entry points, the signed-versus-entered trust model, the
  CSV import and its parser, correct, withdraw and reinstate, who sees the source document, how every view, file
  and the read API mark entered figures, the refusal throttle, the county connection and read API, the signed-file
  verifier) and SUDS Server (*SUDS Server: the installed host*: the installer's supply chain and checksum channels,
  staged releases, LUKS, the service account and its sandbox, Caddy, upgrade rollback, compliance report signing),
  each mitigation pointing at its code and tests, with new residual risks 15–19. `PEN-TEST-SCOPE.md` points each
  county and SUDS Server area at those sections and tests, adds the installer and upgrade as an area, and says what
  the suite already fuzzes.
- **Fuzz and property tests for the county surface** (`test/county-fuzz.test.js`, Node built-ins only, seeded:
  `SUDS_FUZZ_SEED` replays a run): the county-entered figures' CSV import and entry form under random bytes, random
  CSV structure, formula text, Unicode and malformed numbers (nothing but a structured refusal is thrown; nothing
  invalid is accepted; accepted figures are exact; other programmes' rows are never read), the county view's tidy
  CSV imported back (the same payload; no CSV, tidy CSV, read API or Excel cell is a formula), the signed county
  file's verifier (tampered bytes, signature, fingerprint or key never accepted), a pasted public key, and the county
  connection's request parsing and push route. `npm test` runs a small fixed-seed pass in a few seconds; the
  `thorough` CI job runs twenty times as many iterations with a fresh seed (it reads `SUDS_THOROUGH`, so
  `scripts/test-thorough.js` finds it); `SUDS_FUZZ_ITERATIONS` sets the size by hand.
- **Fixed: an object in a field of the county entry form was a 500.** A JSON body can carry an object whose
  `toString` is not a function (`{"toString": 1}`); in a date, category or HIAA field (and, through the text cleaner,
  a name, grant number, source document or an import's fund choice) the form answered 500, unaudited and outside the
  refusal throttle. Only text, numbers and booleans are now read as text (`server/county.js` `textOf`); anything else
  is refused at its field (400, audited). Found by the fuzz tests; regression test in `test/county-entry.test.js`.
- **Fixed: a name beginning with a quote before a formula character did not survive the long CSV.** A programme,
  fund or grant named `'=x` (or `'+`, `'-`, `'@`) went out of the tidy CSV unguarded and came back without its quote,
  so the programme's own rows were read as another programme's and a fund came back renamed. The CSV formula guard
  (`server/spreadsheet.js` `toCsv`, every SUDS CSV export) now also adds one quote to text that begins with quotes
  before such a character (`''=x`), and the county import takes exactly one off (`UNGUARD`), so every exported name
  reads back as itself; no exported cell is a formula either way. Found by the fuzz tests; regression tests in
  `test/spreadsheet.test.js` and `test/county-entry.test.js`.

### Release-state check and the county evidence packet (tooling; no migration, permission or route)

- **The release documents are checked against what is true** (released in 1.21.0).
  `node scripts/release-state.js` compares what the questionnaire, the evidence index, docs/RELEASE.md (supported
  versions, records, the exceptions ledger, the tags owed), the tag hand-off, HANDOFF.md's *Release waiting* entry and
  the dated CHANGELOG sections say about the releases with the CHANGELOG, `main`'s history, `git ls-remote --tags
  origin` and the `version.json` `gh-pages` serves, and prints each finding as `file:line` with a fix: a hand-off commit
  that is missing, not on `main` or not "Release X.Y.Z" (or the SBOM commit after it); a tag the documents call pending
  that is pushed; a stamped version nobody will tag; "live on GitHub Pages" for a version that is not; a dated CHANGELOG
  section calling another minor "the latest minor". `--offline` and `--docs-only` say what they could not check. CI
  runs it as the advisory `release-state` job; docs/RELEASE.md's stamp checklist says when to run it. On 1.20.0's
  documents it finds five stale lines in the 1.20.0 CHANGELOG section and the evidence index calling 1.19.0 live.
- **The county evidence packet** (released in 1.21.0). `node scripts/county-packet.js --ref <commit>
  [--zip <file>]` puts the questionnaire, the county kit, the RFI answers, the agreement drafts, the newest SBOM and
  drill evidence, SECURITY.md, the LICENSE, the accessibility report and the pen-test scope in one folder with a README
  (what each file is, which version it describes, the verify commands) and a SHA-256 manifest; the same commit gives
  the same bytes, zip included (docs/market/COUNTY-KIT.md, *The evidence packet*).
- **Tests:** `test/release-state.test.js` (the checks on synthetic documents and git facts; the repository's own
  documents raise no finding but the known ones) and `test/county-packet.test.js` (two runs, identical bytes; every
  listed file present; the manifest and the zip's directory right).

### County view: award amounts in the county file, and reminders when a county file is due

Released in 1.21.0 (docs/COUNTY-VIEW.md, *Award amounts* and *Reminders on the programme's side*). No
migration.

- **Schema version 2 of the county submission file**: each fund carries its award (the award or contract amount and
  the award period, from its fund record; null when none is recorded), signed with the rest. A county reads versions 1
  and 2; the combined view, its CSV, Excel and long CSV, and the read API add *Spending against the award* (the award,
  what was spent under the funds that carry one, and the share spent), each total over the programmes whose files
  carry an award only, and "award not in file" for a programme whose files are version 1. The envelope's version must
  be the signed payload's. County-entered figures take the award too (three optional fields per fund in Enter
  figures; `award_amount`, `award_from`, `award_to` in the long CSV and the per-program template).
- **Upgrade order: the county first.** A county on SUDS 1.20 reads version 1 only. The Send to the county card can
  still make a version 1 file (a box for a county on 1.20 or earlier); over the county connection, the county's
  `/status` now says which versions it reads (`accepts_schema_versions`), and a county that does not say is sent
  version 1 automatically, with a warning on the card.
- **Reporting-cadence reminders**: Home tells whoever makes the county file which county file is due by when and not
  yet made or sent, from the connected county's own schedule (its `/status` now carries `due_days` and each period's
  `due_by`; the county sets the days on County connections) or a schedule the programme records on Settlement
  outcomes (*County reporting schedule*). A period is done when its file is made (or, for the connected county,
  received or sent and accepted). Office server only.

### Documentation: the documents' content brought up to 1.20.0, and a test that keeps it there

No code, migration, permission or route. The market review of 1.20.0 found that "the documents brought up to 1.20.0"
was mostly their version lines: county-entered figures, 1.20.0's feature, was missing from most buyer and security
documents, and several still said 1.19.0 was current.

- **Test:** `test/doc-content-currency.test.js` fails when an audit action the server writes (collected from
  `server/**/*.js`) is not in `docs/security/LOGGING-AND-AUDIT.md`, or its catalogue names one the code no longer
  writes; when the newest migration, or one the newest stamped CHANGELOG section names, is not in
  `docs/security/DATA-INVENTORY.md`; when a line that says which release it is current for ("describes X.Y.Z",
  "Current status (X.Y.Z)", "State on … (X.Y.Z)", "the history of X.Y.Z", "X.Y.Z, the latest release", the threat
  model's *Version.*, README's *What's new*) is not on the stamped minor; and when a buyer document never names
  the stamped minor. `test/release-wording.test.js` now fails on any "X.Y.Z, not yet released" for a stamped
  version, not only "built for X.Y.Z, not yet released". Both fail on `be5a48f`.
- **LOGGING-AND-AUDIT:** an *Audit action catalogue* of every action the server writes, by area, and the
  `county.entry.*` actions of county-entered figures (what each records; never a figure or the source document).
- **DATA-INVENTORY:** *Schema versions* (migrations 56 to 60, what each adds to what is stored); the county view's
  flow names county-entered figures.
- **County-entered figures described** in the questionnaire (#5 no third party or connection; #8 kept on the county's
  server; #25 the action catalogue), DATA-LIFECYCLE (what a county's server holds, and its retention), the security
  ARCHITECTURE (a component, the third way in, a flow row, trust boundary 7), BUYER-GUIDE-IT and -PROGRAM, the pilot
  kit's county section (what the county gets, a measure), the market README's scorecard (a row, with D1–D5),
  STRATEGY's *Built vs planned*, POSITIONING, DATA-NETWORK (which also no longer lists key replacement as not built),
  the user guide's County view, SECURITY.md's scope and README's *What's new* (now 1.18.0 to 1.20.0).
- **The decisions labelled:** docs/COUNTY-VIEW.md, *Owner-default decisions (D1–D5)*, each with its rule, code and
  test, so RELEASE.md's and HANDOFF.md's citations are true.
- **Stale lines fixed:** the county kit's three lines calling 1.20.0 unreleased; 1.20.0's CHANGELOG section's
  leftover 1.19.x lines (supported versions, the SBOM, a line saying the documents were on 1.19.0, "no change to what
  SUDS does" in a section with a migration); HOSTING's *Current status* (no version now); EVALUATION-RESPONSE and STRATEGY to 1.20.0; the
  authorship figures recounted at the 1.20.0 stamp (`66a616b`: 662 of 681 commits, 649 authored by the assistant and
  13 co-authored; QUESTIONNAIRE #36a, SDLC, BUYER-GUIDE-IT, the evidence index, EVALUATION-RESPONSE); the threat
  model's version line (1.20.0, saying what it does not yet model); PLATFORM's list of direct `gh-pages` pushes;
  RELEASE.md's hand-off line; RELEASE-HANDOFF's `main` version and recheck example; the evidence index's 1.20.0
  SBOM commit (it named 1.19.0's), tag hand-off (seven tags) and installer-run row; INSTALLER-VM-RUN (the latest
  release, with 1.20.0's day-one expectations); the "fake root only" installer wording in README, SELF-HOSTING,
  ARCHITECTURE, the market README, STRATEGY, HOSTING and BUYER-GUIDE-IT (a container run exists); the container
  run's findings marked fixed in 1.20.0; HANDOFF.md's 1.20.0 entry; the RFI answers' security contact points at
  SECURITY.md.

### Evidence on 1.20.0: recovery drill, upgrade drill and installer run

Evidence and tests only; no change to what SUDS does.

- **Recovery drill on 1.20.0** (docs/evidence/dr-drill-2026-09-30-v1.20.0/): `scripts/dr-exercise.js --clients 20000`
  on the released tree (`8f365b4`, schema 60): 11 of 11 checks, drill RTO 3.6 s, host-procedure RTO 2.8 s, RPO 5 s;
  the signed report verifies with the public key beside it.
- **Upgrade drill to 1.20.0** (docs/evidence/upgrade-drill-2026-09-30-v1.20.0/): databases written by 1.16.2, 1.18.0
  and 1.19.0 (20,000 fictional clients each) opened by 1.20.0. The driver now has the older release import its own
  signed county files (one superseded) before the upgrade, so migration 60 rebuilds `county_submissions` with rows
  in it: every row kept unchanged as `signed`, `on_suds` 1, listed and counted by 1.20.0's API, and county-entered
  figures accepted in the rebuilt table. Schema identical to a fresh install, nothing lost; 11 of 11 drill checks each.
- **`test/fixtures/release-v1.19.0.sql`** (`make-release-fixture.js --rich` from `3dc20dc`) joins the release-fixture
  upgrade test, and `test/migrations.test.js` checks 1.20.0's first start on it: county submissions survive migration
  60 as signed with their payloads, sessions 1.19.0 opened still sign in, the audit chain verifies.
- **Installer run on 1.20.0** (docs/evidence/installer-container-run-2026-09-30-v1.20.0/): `install.sh` 1.20.0 and
  `upgrade.sh` 1.19.0 → 1.20.0 on Ubuntu 24.04 with systemd in a container, as the 1.19.0 run. The four 1.19.0
  findings are fixed on a new install (one refusal for both shares, nothing staged; the checksum source kept after a
  run stopped after staging; the first backup and drill at install, `/api/health` 200; `WEBAUTHN_RP_ID` set; 37 pass,
  1 fail: the container's clock). **New finding:** the documented upgrade from 1.19.0 runs the installed 1.19.0
  `upgrade.sh`, which does not add `WEBAUTHN_RP_ID` and runs its compliance check without `suds.env` (`app.passkeys`
  and `app.https` fail on its report); 1.20.0's own `upgrade.sh`, or the two lines added by hand, fixes both. The
  1.19.0 run's README says which findings 1.20.0 fixed.
- Citations moved to this evidence: the evidence index, BACKUP-AND-DR, the questionnaire's recovery answer and the
  county RFI answers (drills; the security contact now cites SECURITY.md, the named address still owner-pending).

### Field devices and minimal personal information

Released in 1.21.0. Migration 62 (61 is kept for another 1.21.0 change). Both features are off unless
an administrator turns them on.

- **Field devices.** A device can be made a *field device* (Settings › Synced devices; its user may choose it when
  enrolling, narrowing only; or Settings › Program › *New devices start as field devices*). Its sync then carries
  only its worker's own caseload assigned or seen in the last 90 days (a setting, 7 to 365), with contact, intake,
  legal and clinical columns blank, those clients' and the worker's own contacts and overdose reports in that window,
  the worker's own to-dos, supplies, sites and lists: no notes, documents, consents, episodes or assessments. Every
  synchronised table has an explicit decision in `server/field-scope.js`, and a test fails when one has none. The
  office enforces it on pull and push from its own record of the device the session signed in from
  (`sessions.device_id`): a field device cannot pull or push outside it (caseload transfers and merges included),
  a blank column it sends back never clears the office's value, and its sync session reaches only the sync routes.
  A device that changes scope sends its changes first, then removes what it may no longer hold (nothing is deleted
  at the office). Settings › Synced devices shows what each device holds; This device says *Field device: holds
  only …*. Changes are audited (`device.scope`).
- **Participant code first.** Settings › Program › Minimal personal information › *Outreach records use a
  participant code by default* (offered by the setup wizard to a harm-reduction programme, answered No unless
  changed). With it on, New client asks for the participant code and keeps the name, date of birth and phone
  behind *Add a name*; Street outreach asks for the code right under the kind of contact; a new visit with no
  client starts with its code open. A client may be known by a code alone (`clients.participant_code_enc`,
  encrypted, with a blind index in the same domain as a visit's code): shown as *Participant CODE*, found by the
  code in the client search and the duplicate check, counted as a client, and counted once in the syringe
  services summary when the same code is given at an anonymous contact.

### Added: an authenticator allow-list for passkeys (office server; released in 1.21.0)

The option FINGERPRINT.md described and left unbuilt. Settings → **Authenticator allow-list (passkeys)**, off by
default, administrators only: with it on, a passkey can be added only on an authenticator model the programme lists
(by AAGUID), and the authenticator must prove its model. Registration then asks for attestation `'direct'` (only
then), and SUDS verifies it with `node:crypto` alone (`server/attestation.js`): `packed` (full attestation; self
attestation is refused), `fido-u2f` (the all-zero AAGUID), `tpm` (TPM 2.0) and `android-key`; `none`, `apple` and
`android-safetynet` are refused with the reason. The certificate chain must reach the roots the **FIDO Metadata
Service** lists for that model, from the Metadata Service file (`blob.jwt`) the administrator downloads and loads on
the card: SUDS makes no outbound call, checks the file's signature chain to the FIDO Alliance's root (GlobalSign Root
CA - R3, embedded with its SHA-256), that it is signed for mds.fidoalliance.org, its `nextUpdate`, and that it is not
older than the one loaded, and refuses models reported compromised or revoked. Passkeys added before the list was on
were never proven, so they stop working for sign-in and signing at their next use, with a message saying why and the
audit entry `auth.passkey.not_allowed`; the administrator sees which accounts that affects before saving and must
confirm the number. Changing the list and loading the file take the password (or code) again every time, and are
audited (`security.authenticator_allowlist`, `security.authenticator_metadata`). Settings → Security status has a line
for it (red when the file is out of date: no passkey can be added until the current one is loaded). SUDS on this
device is unchanged: it has no passkeys. Migration 63 (`passkeys.attestation`, `authenticator_metadata`); 61 and 62
are held as no-ops on this branch for the other 1.21.0 migrations. Tests: `test/attestation.test.js` (certificates
made by `test/x509.js`), `scripts/ui/fingerprint.mjs` part 7. Documents: FINGERPRINT.md ("Authenticator
allow-list", with the owner's decisions), QUESTIONNAIRE #19a, DATA-INVENTORY.

### County publication releases (released in 1.21.0)

The publication screen over the combined county release (docs/COUNTY-VIEW.md, *Publication*): County view › Publish
makes a screened, publishable release of a county's combined figures for a period, records it, and never changes it.

- **The same small-cell method as a programme's own release** (`server/sdc.js`), audited over the county totals and
  against every programme's own release they could be differenced against: each programme's figure is modelled as a
  cell its own release prints (its number when 0 or at least T, `<T` when small), so a county total that would give a
  small programme's figure away once the others' are subtracted is suppressed. `sdc.js` gains `fixed` cells (printed
  by another release, never hidden or withheld by this audit); a programme's own releases are unchanged. Money and
  counts that are not of people stay exact. A release the check cannot protect is refused.
- **Prepare, review, publish** (`county:manage`; no new permission): what would be published is shown first, and
  publishing needs the review ticked and the figures unchanged since (the hash reviewed). Each release is recorded
  with who, when, the period, the method's parameters and the SHA-256 of what was published, in `county_publications`
  (migration 61), append-only in the database itself; **withdraw** is a record of its own. A period that overlaps a
  release already published, withdrawn or not, is refused.
- **Figures the county entered** count by the combined view's rule (a signed file outranks them), are named in the
  release, and can be left out.
- **Files**: on screen, CSV, Excel with a Notes sheet (what was suppressed and why, never the value) and JSON; the read
  API's `GET /api/county-connect/v1/publications`. Audited `county.publication.prepare|publish|refuse|export|withdraw`,
  never with a figure.
- Tests: `test/county-publication.test.js` (permissions, screening, a differencing attack, refusal, determinism, the
  record, withdrawal, entered figures, files, the read API) and the algorithm-aware differencing attacker
  `test/county-publication-sdc.test.js`, one of the SDC sweeps. Browser script `scripts/ui/county-publication.mjs`
  (the suite is now 56 scripts, with `field-device.mjs`), and the Publish tab and its dialogs in `scripts/ui/accessibility.mjs`.

### Fixed: defects found by the integration review

- **Upgrading from 1.19.0 left passkeys unconfigured** (the finding of the 1.20.0 installer run): the documented
  command ran the installed 1.19.0 `upgrade.sh`, which does not add `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS`.
  `deploy/linux/upgrade.sh` now hands over to the new release's own `upgrade.sh` once that release is staged and its
  checksum checked (same arguments, before anything is stopped; the upgrade.sh of 1.20.0 and older cannot, so
  docs/SELF-HOSTING.md *Upgrading* now says to run the new release's `upgrade.sh` from its unpacked zip). A production
  server with passkeys on and no relying party says so at every start and on Security status (so in the compliance
  report's `app.passkeys`), with the two exact lines for `/etc/suds/suds.env` from the installer's domain
  (`server/startup-checks.js` passkeyRpProblem). Tests: test/deploy-linux-real.test.js, test/passkey-rp-startup.test.js.
- **Authenticator allow-list: a malformed TPM certificate crashed enrolment** (a 500): a subject alternative name
  whose AttributeTypeAndValue had no type or value threw a TypeError before the chain was checked; it is now refused
  as not understood (`attestation_cert`). Test: test/attestation.test.js.
- **Authenticator allow-list: a session opened by a passkey the list now refuses stayed signed in** until it expired
  (its passkey was refused only "at its next use"). Saving the list, or loading a metadata file that refuses a model,
  now ends the sessions those passkeys opened (`sessions_ended` in the audit entry), as removing a passkey does; the
  administrator's own session is kept. Test: test/attestation.test.js.
- **AI drafting sent a client's participant code to the provider.** The de-identification replaced names and the
  client code only; a client known by a participant code (often with no name) had the code sent as typed. It is now
  masked as `[CLIENT_CODE]`, with or without separators. Test: test/ai-copilot.test.js.
- **Merging a coded client with the same person's named record lost what the kept record lacked**: its name (a named
  duplicate merged into a coded record left it nameless and unsearchable by name), or its participant code and index
  (so the SSP summary counted that person's anonymous visits as someone else's). The kept record now takes either.
  Test: test/participant-code-default.test.js.
- **The county evidence packet shipped the 1.19.0 drill, upgrade and installer evidence**: the 1.20.0 re-runs are in
  folders named `<kind>-2026-09-30-v1.20.0`, which its match did not read. It now takes the latest date, then the
  latest release re-run that day. Test: test/county-packet.test.js.
- **A client known only by a participant code, wherever a record leaves the screen.**
  - A referral packet, and lists that show a client's name, say "Participant CODE", never a blank; the consent checks
    (server/disclosure.js) are unchanged.
  - CalOMS Tx needs the legal first and last name: such a record gets a fatal `name_missing` issue naming what is
    missing and stays out of the submission file until the name is added (it can still be saved).
  - A FHIR Patient carries the code as an identifier (`urn:suds:participant-code`) and has no `name` rather than an
    empty one.
  - The identified client export has a `participant_code` column; the de-identified one never does.
  - A merge of two records with different participant codes keeps the kept record's code and records the other in
    the merge's revision (encrypted; "Put back" makes it the record's own), never in the audit details. The new
    `GET /api/clients/:id/merge/preview?source_id=` (clients:merge; audited) and the merge answer say so first.
  Test: test/participant-code-outputs.test.js.
- **`scripts/release-state.js` failed on the repository** (CI's advisory job): a 1.20.0 CHANGELOG line recording the
  questionnaire's earlier check read as stale. Reworded; test/release-state.test.js now tolerates no finding.

## 1.20.0 — 2026-09-30

A feature release (migration 60 and the county-entered figures routes), released under a policy exception inside
1.19.0's 28 days (docs/RELEASE.md, *Record: 1.20.0*). A county can now enter or import figures for a grantee not on
SUDS, clearly marked as county-entered and always outranked by a signed file; SUDS Server's installer and first day
are fixed after a real install; the county-contract kit is added; and the documents are brought up to 1.19.0 (see below). Upgrading runs
migration 60 on start; nothing else for an administrator to do.

### Fixed: installer and day-one problems found by a real install in a systemd container (SUDS Server)

The run of `deploy/linux/install.sh` and `upgrade.sh` on Ubuntu 24.04 with systemd, as root, on 2026-09-30
(evidence branch `evidence/1191-drill`, `docs/evidence/installer-container-run-2026-09-30/`) found these. Each has a
test that failed before the fix, in the real-execution harness (`test/deploy-linux-real.test.js`) where it applies.

- **The record of how the release zip was checked survives an interrupted first run.** A run that stopped after
  staging the release (the share refusals did, twice) left the next runs writing `SUDS_RELEASE_CHECKSUM_SOURCE=`
  empty, so `host.release_integrity` said *could not check* until the next upgrade. The source (`operator`,
  `same-release`, `local-tree`) is now written into the staged release (`/opt/suds/<version>/.suds-release-checksum`,
  covered by its manifest and marker) and read back whenever a later run or an upgrade reuses that stage.
- **Both shares checked at once, as a `suds` account that exists.** The installer creates the service account
  before its checks (it existed only after a first run), tests the anchor and the offsite share as it together, and
  refuses once, naming every share that is not writable with its owner and mode, the account's uid and gid, and the
  `chown suds:suds <dir> && chmod 0700 <dir>` or `setfacl -m u:suds:rwx <dir>` that fixes it (or the uid/gid to grant
  on an NFS/SMB server): one fix and one more run, not three runs, and nothing is staged or installed before it.
  `--dry-run` reads the modes and warns.
- **Day one is not red.** The installer now runs the first backup and recovery drill once SUDS is up
  (`scripts/dr-drill.js --offsite`, as `suds` with the service's keys): the drill takes the first scheduled backup,
  copies it offsite and restores that copy, so the first compliance report has both. As the fallback, a first backup
  or drill that has not run yet is *pending first run (expected on day one)*, a warning, on every surface, not only in
  the host checks: `app.backups` and `app.dr_drill` (Settings → Security status) for twice the backup interval and 31
  days after the schedule and the monthly drill were turned on, and `/api/health` answers **200, `ok: true`**, with
  the pending backup in `warnings` (it was 503 for up to the first 4 hours, which a monitor alarms on). After the
  window a missing backup or drill fails, and `/api/health` answers 503, as before.
- **A new server's first drill no longer fails for the offsite copy it has just made.** With an offsite share and no
  backup anywhere, `server/dr-drill.js` recorded "the offsite directory holds no backup", then took a backup, copied
  it there and restored that copy — and still failed. The failure now stands only when the offsite copy was not
  restored.
- **`app.https` failed on the installer's report and passed on the weekly one.** The installer (and `upgrade.sh`) ran
  the compliance check without `/etc/suds/suds.env`, so it saw no `TRUST_PROXY` (nor `WEBAUTHN_RP_ID`,
  `MFA_REQUIRED_ROLES`, `LOCAL_MODE_ENABLED`); the weekly `suds-compliance.service` has them. The check now runs with
  every line of that file, `SUDS_ENV=production` and `SUDS_DATA_DIR`, as the unit does, and only once
  `https://<domain>/api/health/ready` answers through Caddy (up to 90 s: Caddy starting, or obtaining its ACME
  certificate), warning if it does not.
- **Passkeys work on a new install.** The installer writes `WEBAUTHN_RP_ID=<domain>` and
  `WEBAUTHN_ORIGINS=https://<domain>` into `/etc/suds/suds.env` from `--domain`, and `upgrade.sh` adds them to a
  server installed before; an operator's own `WEBAUTHN_RP_ID` or `WEBAUTHN_ORIGINS` is kept (a re-run of the
  installer used to drop it with the rest of the file). `app.passkeys` no longer fails on every new install.
- **Where the release checksum is.** The refusal without `--release-sha256` and the `host.release_integrity`
  remediation (and so the browser kernel) said "the CHANGELOG entry at the release tag", which cannot hold it: the zip
  is built from the tagged commit. They now say the SHA-256 published in the GitHub Release notes and recorded in the
  version's CHANGELOG section on `main`, which must agree (docs/RELEASE.md, *The zip's SHA-256 in two places*);
  SELF-HOSTING.md and deploy/linux/README.md likewise.

### Documentation, evidence and repository metadata

- **Buyer and security documents brought up to 1.19.0's features, their version lines to 1.20.0.** The
  market-readiness review of 1.19.0 found them two releases behind. (What 1.20.0 itself added, county-entered
  figures, reached COUNTY-VIEW, API, DATA-INVENTORY, PEN-TEST-SCOPE, the demo script and the questionnaire's #7, but
  not the other buyer and security documents; the market review of 1.20.0 found that, and it is corrected after
  the release: *Unreleased*.) The IT buyer guide no longer says the county view is "one file, carried by people, not a connection": it
  describes the optional county connection (off by default; the CBO's push with a county-issued token *and* the
  file's Ed25519 signature; status; the county's read API with expiring read tokens; `TRUST_PROXY=1`; only the
  aggregate file leaves), SUDS Server and its compliance report, and fingerprint sign-in. The security
  questionnaire is checked against 1.20.0 (its previous check, before the stamp, was of 1.19.0 at `3dc20dc`): #5 names the county connection (outbound from a CBO) and the
  county server's inbound push and read endpoints, and the AI copilot's Bedrock and Vertex AI providers; #6 the
  `LICENSE`; #7, #8, #29, #39 and #48 what 1.18.0 and 1.19.0 changed; #36a the AI-authorship figures recounted
  from git (643 of 662 commits written with the assistant: 630 as author, 13 as co-author; the method is stated).
  ARCHITECTURE (components, a county data-flow diagram, flows, trust boundaries 7 to 9), DATA-LIFECYCLE (what a
  county receives; retention of passkeys, challenges, signature evidence, county data and compliance reports) and
  LOGGING-AND-AUDIT (the audit actions added in 1.18.0 and 1.19.0; signature evidence and compliance reports as
  signed evidence) cover the county view, the county connection, SUDS Server's compliance reports and passkeys.
  The market README's rules no longer call the county view planned, and its scorecard has rows for the county view,
  the county connection, SUDS Server and fingerprint sign-in; STRATEGY's *Built vs planned* has SUDS Server and
  passkeys. README.md's *What's new* covered 1.18.0 and 1.19.0; EVALUATION-RESPONSE (through 1.19.0), HOSTING
  (current status 1.19.0), THREAT-MODEL's version line and SDLC's authorship figures followed to 1.19.0 (not to
  1.20.0: corrected after the release, *Unreleased*).
- **Supported versions** (docs/RELEASE.md): 1.20.x is the latest minor, 1.19.x the previous (security fixes for 30
  days from 1.20.0's tag, not yet pushed; plan as if from its publication on 2026-09-30), 1.18.x and older get
  nothing.
- **Evidence.** A CycloneDX SBOM for 1.19.0 from its release commit (`docs/evidence/sbom-1.19.0.cdx.json`) and one
  for 1.20.0 from its stamp (`docs/evidence/sbom-1.20.0.cdx.json`, added by the commit after the stamp; the 1.16.4,
  1.17.0 and 1.19.0 SBOMs stay as history), linked everywhere the 1.17.0 one was. The evidence index describes
  1.20.0, with sections for the county view and connection, SUDS Server's signed compliance report
  (`npm run verify-compliance-report`) and fingerprint signature evidence (`npm run verify-passkey-evidence`).
- **Tag hand-off** (`docs/evidence/RELEASE-HANDOFF.md`): the seven untagged releases 1.16.3 to 1.20.0, their tag
  commands and one push, what each tag's workflow runs will do (which need a `policy_exception`, which `Web app` run
  to approve), and the SHA-256 of each release zip, rebuilt from its commit as `release.yml` builds it (the same
  method reproduces the published `v1.15.4` and `v1.16.2` checksums), for the release notes and the CHANGELOG on
  `main`: the second channel SUDS Server's upgrades need. SELF-HOSTING and RELEASE no longer say that checksum is in
  the CHANGELOG *at the tag*, which cannot hold it.
- **LICENSE** (MIT, "Copyright (c) 2026 The SUDS contributors") and **SECURITY.md** (supported versions, private
  vulnerability reporting, what to include, never real PHI, response targets for the owner to confirm, the scope:
  office server, SUDS on this device, the SUDS Server installer, the county connection, passkeys). SUPPORT.md points
  to it instead of an `[owner to complete]` contact. The owner turns on private vulnerability reporting
  (docs/RELEASE.md, *Owner: repository settings*, step 8).
- **Test:** `test/doc-currency.test.js` fails once `package.json`'s version is stamped while the questionnaire's
  *Checked against*, the evidence index's *Version.* or the newest SBOM is not on that version's minor line, or a
  document outside the evidence index links an older SBOM (docs/RELEASE.md, stamp checklist). It fails on `3dc20dc`.

The drills and the installer run below were recorded on 1.19.0, before this release's code changes (migration 60,
the county-entered figures routes, the installer fixes): they are 1.19.0's evidence, carried in this release, not
runs of 1.20.0.

- **Recovery drill on 1.19.0** (docs/evidence/dr-drill-2026-09-30/): `scripts/dr-exercise.js --clients 20000` on
  the released tree (`3dc20dc`), as the 1.16.2 drill was run: 11 of 11 checks, drill RTO 5 s, host-procedure RTO
  3.7 s, RPO 5 s; the signed report, its public key, the transcript. BACKUP-AND-DR.md, the evidence index and the
  questionnaire name it as the latest.
- **Upgrade drill** (docs/evidence/upgrade-drill-2026-09-30/): databases written by 1.16.2 and by 1.18.0 through
  their own code and API (20,000 clients, a signed and countersigned note, a TOTP user) opened by 1.19.0: schema
  identical to a fresh install, no rows lost, every sampled value decrypts, the note and the audit chain verify,
  the old sessions and TOTP still work; then backed up, restored and drilled, 11 of 11 each.
- **Migration tests**: `test/migrations.test.js` upgrades a database 1.18.0 wrote (`test/fixtures/release-v1.18.0.sql`,
  with rows in the county tables of migrations 56 and 57), and checks that sessions 1.18.0 opened come through
  migrations 58 and 59 as browser sessions that still sign their holder in. The fixture maker handles a single-row
  table (`county_connection`).
- **Installer run** (docs/evidence/installer-container-run-2026-09-30/): `deploy/linux/install.sh`, and `upgrade.sh`
  from 1.18.0 to 1.19.0, run for real on Ubuntu 24.04 with systemd in a container (not a VM), with a recovery drill
  on the installed server and the signed compliance reports; RHEL 9 could not be run. Its four findings are fixed in this
  release (*Fixed: installer and day-one problems*, above). The run on real Ubuntu 24.04 and RHEL 9 VMs is owner-pending: docs/evidence/INSTALLER-VM-RUN.md.

### Added: county-entered figures for grantees not on SUDS (docs/COUNTY-VIEW.md; released in 1.20.0)

Migration 60 and new routes; no new permission (`county:manage` enters,
`county:view` sees). Office server only.

- **A program not on SUDS.** County view › Programs › **Add a program not on SUDS** registers a grantee with no key
  (`county_programmes.on_suds`). It gets no connection token; when it starts running SUDS, adding its key makes it an
  ordinary programme and its entered figures stay, marked.
- **Enter figures** for a period, per fund: Exhibit E allowable use, HIAA, spending and the thirteen outcomes, with the
  source document they come from. **Import a CSV** in the combined view's own long "tidy" layout: **Check the file**
  lists every problem by row and column and saves nothing, or shows what the file holds and asks each fund's category;
  **Import** enters every period or none. Both build a payload of the signed files' own allow-list (`checkPayload`),
  with strict numbers, the period rules and the signed files' text rules (`server/county-entry.js`).
- **Stored and counted as county submissions** with `source` `county_entered`: no key or signature (a CHECK keeps the
  two kinds apart), the figures and the source document encrypted, who entered them, when and how. The combined view's
  own counting (`countingSubs`, `coverage`, `filesCount`), supersession, withdraw and reinstate are reused, not
  re-implemented; **Correct** reopens the form with the figures.
- **Marked "entered by the county — not signed by the program"** in the combined view (a Source column, "(entered)"
  in every figure and heading, the entered part under each total), by quarter, the Excel and CSV (column headings, an
  *Of the total* column, the Submissions sheet's Source, an About row), the tidy CSV (a ninth column, `source`) and
  the read API (`source` per programme and submission, `total_entered` per row, `on_suds` and `source` on
  `/v1/programs`). The headline counts them separately. **Leave out figures entered by the county** (and
  `&entered=exclude` on the view, its files and `/v1/combined`) takes exactly them away.
- **Audited without figures or typed text:** `county.entry.create`, `.update`, `.import`, `.refuse`, `.withdraw`,
  `.reinstate`, `.template`, `.throttled`.
- **A signed file always outranks county-entered figures.** For one period it counts whatever either's
  `generated_at` (`resettle`); in the combined view entered figures never push a signed file out as an overlap, and
  where they overlap one they are left out, "a signed file covers this" (`left_out[].why: "signed_covers"`, with a
  `reason` on every left-out file). The county connection's `/v1/status` counts only signed files as received, and
  each received item carries `source`.
- **Once a programme joins SUDS** (County view › Programs › **Add its key**) its entered figures can be withdrawn and
  reinstated but not corrected, and no more are entered; the dialog and the Submissions list say so
  (`programme_on_suds`).
- **Names are unique**: registering either kind of programme, or renaming one, to a name already registered
  (whatever the case or spacing) is refused (`409`, `duplicate_name`).
- **The source document** of entered figures is shown to `county:manage` only (not to someone who may only view, and
  never in the read API); **Correct** does not carry the old one over.
- **The CSV import** reads only the programme's own rows (another programme's are never imported, and are said in one
  line), warns in the preview when a row's `source` says `signed`, says a figure that is not a number once (not also
  "has no …"), and offers **Download a template for this program**. Choosing another file clears the check, and
  **Import** refuses a file that is not the one checked. The long CSV's `source` is a code (`signed`,
  `county_entered`, as the read API says it), with `source_label` in words.
- **Refused entries and imports are throttled** per person as refused files are (`429`); `entered=` takes only
  `include` or `exclude` (anything else `400`) on the view, its files and `/v1/combined`; the export's *Report* line
  names entered figures only when the file has some.
- The page: the combined view's introduction mentions entered figures; the entered part of a total sits on its own
  line and wraps at phone width; Exhibit E's uses say their schedule; every figure is marked required; the keyboard
  goes to the Submissions list after Save and Import; the message that a programme was added offers **Enter
  figures** (`undoToast` takes an `action`).
- docs/API.md's narrative lives in `scripts/gen-api-docs.js` (the passkeys paragraph included), and
  `test/api-docs.test.js` fails when the file is not exactly what the script writes (`--check`).
- `node scripts/county-sample.js --register` adds a fourth sample programme, not on SUDS, with entered figures for the
  same two quarters.
- The penetration test scope has a row for the CSV import parser; the pricing options say the feature is released in
  1.20.0.

### Documentation: the county-contract kit

No code, migration, permission or route: documents for a county that funds several CBOs and wants the county view
(released in 1.18.0) across them.

- **The county pilot kit** (docs/market/COUNTY-KIT.md): who it is for; what the county runs (one SUDS Server for the
  county view only, 2 vCPU / 4 GB / 20 GB, no client data on it) and what each CBO does (the key exchange at
  kickoff, the quarterly signed file, the optional connection); a 3-CBO pilot timeline; success measures; roles;
  the data flows (aggregate only, and what never leaves a CBO); the documents a county will ask for, linked; and
  the owner-pending items said plainly ([owner to complete]: entity, insurance, pen test, pricing, counsel review,
  the data contribution agreement).
- **Answers to a county's IT and privacy RFI** (docs/market/templates/COUNTY-RFI-ANSWERS.md): hosting, residency,
  encryption, keys, MFA/SSO and passkeys, audit and retention, backups and DR with the drill evidence, vulnerability
  management and the SBOM, incident response, accessibility, Part 2/HIPAA/CMIA roles, subprocessors, data ownership,
  exit and support, each with the file in the repository that shows it; no certification claimed.
- **A data contribution agreement draft** between a CBO and its county for Tier 1
  (docs/market/templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md): purpose, aggregate exact counts not for publication,
  no re-identification, retention and deletion, security, the key exchange and a lost key, county-entered figures
  (only for a programme registered as not on SUDS), term. **A draft for counsel**, not reviewed.
- The first-meeting walkthrough's county-funder path adds county-entered figures, marked released in 1.20.0 (DEMO-SCRIPT.md); the penetration test scope has rows of its own for the county push endpoint and the
  county read API (PEN-TEST-SCOPE.md); the pilot kit and pricing options point at the county kit.

## 1.19.0 — 2026-09-30

A feature release (migrations 58 and 59 and the passkey routes), released under a policy exception inside 1.18.0's
28 days (docs/RELEASE.md, *Record: 1.19.0*).

### Added: fingerprint sign-in, authorization and signing with passkeys (docs/FINGERPRINT.md; released in 1.19.0)

For the feature release after 1.18.0 (a migration and new routes; no new permission). Office server only.

- **No biometric data.** Staff sign in, sign and approve with a WebAuthn passkey on their device's own authenticator
  (Touch ID, Windows Hello, an Android fingerprint, or the device's screen lock). The device matches the finger; SUDS
  receives a signature and stores only each passkey's public key, credential id, signature counter, transports,
  AAGUID, its owner's name for it and dates — no fingerprint, template or measurement, so no biometric retention
  schedule applies (FINGERPRINT.md sets out the CCPA/CPRA, BIPA and HIPAA position for counsel).
- **Verified with `node:crypto` alone** (`server/webauthn.js`): a CBOR decoder, authenticator data, COSE keys for
  ES256, EdDSA and RS256, registration and assertion checks. User verification is required and its flag checked (the
  device may use its PIN instead of the finger: the screens say "fingerprint (or your device's screen lock)"). The
  relying party is the server's host (`WEBAUTHN_RP_ID`), HTTPS only (plain http on localhost in development), never
  an IP address; the origin is checked and `crossOrigin` refused. Attestation `none`; the AAGUID is recorded.
  Challenges are stored hashed, single-use, two minutes, bound to purpose, user and session. A signature counter that
  goes backwards disables the passkey and is audited (`auth.passkey.clone_suspected`).
- **Enrolment** (My profile → Fingerprint sign-in): the password again, and the authenticator code with two-step
  verification on; at most ten per account; rename, remove (the password again). Administrators see the count and
  revoke them (`users:manage`); deactivation, SCIM deprovisioning and deprovisioning by absence remove them. Audited:
  `auth.passkey.enrolled`, `.renamed`, `.removed`, `.enrol.failed`, `user.passkeys.revoked`.
- **Sign-in**: "Sign in with fingerprint" (a discoverable passkey, or the typed username's), the username field's
  passkey suggestions (conditional UI), and the fingerprint as the second step of a password sign-in. A passkey with UV
  is multi-factor (NIST SP 800-63B, AAL2): it satisfies `MFA_REQUIRED_ROLES`, and an account with one is not given an
  enrolment deadline. Lockout, rate limits, inactive accounts and "Require single sign-on" (emergency accounts
  excepted) apply as to passwords. Audited `auth.login` with `method: "passkey"`.
- **Signing and approvals**: "Confirm with fingerprint" beside the password or code for signing, countersigning (one
  and batch), approving time (one and batch) and spending, and the key backup. The challenge is SHA-256 over a
  canonical statement of exactly what is signed (purpose, record type and ids, the content hash or version, the
  signer, the time, a nonce); the route recomputes it from the record as it is, so a confirmation for record A cannot
  sign record B or a record changed since. The evidence (statement, assertion, public key) is stored encrypted
  (`signature_evidence.evidence_enc`) and re-verifies offline even after the passkey is removed: Verify signature
  shows it, auditors export it (`GET /api/admin/signature-evidence`, `audit:read`) and check it with
  `npm run verify-passkey-evidence`. A fingerprint opens the quick-signing window as a password does. Audit entries
  carry `identity`/`method: "passkey"` and the evidence id.
- **Settings → Security policy**: *Allow fingerprint sign-in* and *Allow fingerprint to confirm signatures and
  approvals* (on), *Require fingerprint or authenticator for signing* (off; when on, the password alone no longer
  signs or approves, and only a quick-signing window opened by a fingerprint or code counts; time and spending
  approval, which asked for no proof before, then need a fingerprint or code). Audited `security.passkey_policy`.
  Security status reports passkey adoption and counts passkeys as two-step verification.
- **SUDS on this device: deferred** (unlocking the vault with the WebAuthn PRF extension); no fingerprint is offered
  there, and the passkey routes are not in the local kernel.
- **Migration 58**: `passkeys`, `webauthn_challenges`, `signature_evidence` (office only, `server_only` in
  sync-tables) and `sessions.reauth_method`.
- Also: a dialog opened over another (the signature dialog over a note) no longer has the one below take its Tab and
  Escape keys (`public/app.js` `modal`).
- Tests: `test/fingerprint.test.js` with a software authenticator (`test/authenticator.js`: ES256, EdDSA, RS256);
  browser script `scripts/ui/fingerprint.mjs` with Chromium's virtual authenticator (the suite is now 54 scripts), and
  the new dialogs in the accessibility audit.
- Docs: FINGERPRINT.md, USER_GUIDE, API.md, HIPAA.md (§164.312(d)), DEPLOYMENT and SELF-HOSTING (`WEBAUTHN_RP_ID`,
  HTTPS), security/THREAT-MODEL, DATA-INVENTORY, PEN-TEST-SCOPE, QUESTIONNAIRE, IDENTITY.

### Security: the fingerprint review (r1; before release; docs/FINGERPRINT.md, *Review of the fingerprint work*)

- **A code must verify.** Wherever a password and an authenticator code are both sent (note sign, countersign one and
  batch, time approve one and batch, spending approve, key backup), both are checked; a password with a made-up code
  was accepted as the password, and under *Require fingerprint or authenticator for signing* counted as the code. A
  fingerprint sent with a password or code is refused. The policy covers the key backup's password too.
- **A note signed on a device under that policy** lands as a draft at the office, flagged to the device and audited
  (`server/rules/notes.js`, the owner's decision D2).
- **Keys**: RSA needs 2048 bits (counted by the key) and exponent 65537 (a padded 128-bit key with e = 1 was accepted);
  EC on P-256; Ed25519 32 bytes, also as COSE `-19`.
- **The relying party** is required in production (`WEBAUTHN_RP_ID`, or `WEBAUTHN_ORIGINS`): without it no options,
  a clear message and a red Security status line (D1). `X-Forwarded-Host` never sets the RP ID.
- **Evidence** is bound to the note's plaintext content hash (`server/note-signature.js`, one helper where there were
  four copies of the hash), so it verifies after a key rotation (D3); `npm run rotate-key` now recomputes the notes'
  ciphertext signature hashes that were intact (they used to read "changed" after every rotation) and leaves broken ones
  broken. The enrolment audit entry records the SHA-256 of the key and the credential id, and Verify signature and
  `verify-passkey-evidence` (new `--audit`) check the evidence's key against it, and the statement's RP ID, an https
  origin, no embedding, and, for a batch countersignature, that the note's hash is among those signed.
- **Resetting two-step verification or a password** removes the person's passkeys; removing passkeys ends the
  sessions they opened (`sessions.passkey_id`, migration 58).
- **Sign-in options** list no credentials (discoverable passkeys only); the second step still lists the account's.
- **Hardening**: unanswered sign-in challenges capped per address and swept hourly; `topOrigin`; `BS` without `BE`;
  `AT` in an assertion; CBOR duplicate byte-string keys, invalid UTF-8, tags and reserved encodings; the assertion
  checked against the stored challenge. A passkey counts toward the MFA banner only while fingerprint sign-in is allowed
  (`passkey_mfa`, D4: no authenticator allow-list).
- **Screens**: the second step offers "No fingerprint sign-in on this device?" and no code field to an account without
  an authenticator app; a required fingerprint-or-code with neither set up shows no Sign button and links to My
  profile; the signature dialog puts the fingerprint first (the one primary button, focused), "Or use your password"
  after it, and beside "Confirm with single sign-on"; approvals ask only when the policy requires it or the person
  opted in, and not inside the quick-signing window; the focus returns to the fingerprint button after a failure
  (`aria-disabled` while waiting), said once; plain words on the sign-in page and My profile, the device marked, a
  better default name, an SVG icon, and a specific toast on revocation.
- **Tests**: `test/fingerprint-review.test.js`, with outside vectors (py_webauthn's real responses, RFC 8949 Appendix
  A); `test/fingerprint.test.js` order-independent, with no fixed dates; `scripts/ui/fingerprint.mjs` for the screens.

### Security: the fingerprint review, second pass (r2; before release; docs/FINGERPRINT.md, *Second review*)

- **Devices sync as before passkeys.** A device's sync sign-in (`X-Sync-Client`, now recorded on the session:
  `sessions.sync_client`, migration 59) is never given the fingerprint as its second step, which it cannot take: with an
  authenticator app it is asked for the code; without one, in a role that requires two-step verification, it syncs in
  the grace period and is then stopped, told to add an authenticator app under My profile. Before, a clinician in such a
  role who added a passkey could no longer sync at all.
- **A client merge no longer breaks fingerprint evidence**: the note's plaintext content hash does not include the
  client it is filed under (the note id names the record).
- **`npm run reset-admin` removes the administrator's passkeys** (audited, cause `cli reset`).
- **An administrator resetting their own two-step verification stays signed in** (their other passkey sessions end).
- **A waiting signature challenge no longer keeps the note's content hash** (an unkeyed SHA-256 of its plaintext); the
  statement is completed from the record when the confirmation arrives.
- **Docs**: notes an earlier key rotation left "not intact" are not repaired, and how an administrator tells them from
  changed notes; the quick-signing window skips the opt-in approval prompt whatever opened it when the policy is off.
- **Tests**: `test/fingerprint-r2.test.js`; `test/fingerprint-regression.test.js`, the flows of people without
  passkeys compared with a table produced on 1.18.0, under every fingerprint setting.
  The browser kernel is now built without the WebAuthn code. The browser suite is still 54 scripts: 1.18.0's
  documents said 53, which was right for 1.18.0 (the review counted the `assert.mjs` helper); a test now also checks
  the newest count in HANDOFF.md and CHANGELOG.md.
- **Single sign-on without multi-factor asks for the fingerprint.** Someone in a role that requires two-step
  verification whose only second factor is a passkey, signing in through an identity provider that did not assert
  multi-factor, is taken to the same second step as after a password (the fingerprint, or the code with an
  authenticator app). With multi-factor asserted by a trusted provider nothing changes (`test/fingerprint-sso.test.js`).
- **Without a fingerprint the signature dialog reads as in 1.18.0**: its password field is "Re-enter your password to
  …" again; "Your password" is used only under the fingerprint's "Or use your password:".
- **Tests use a throwaway key file** instead of the checkout's `data/keys.json`, which parallel test files created and
  removed under each other and which could delete a developer's real keys.

## 1.18.0 — 2026-09-30

A feature release (migrations 56 and 57, the `county:view` and `county:manage` permissions and new routes), released
under a policy exception inside 1.17.0's 28 days (docs/RELEASE.md, *Record: 1.18.0*).

### Added: the county connection (docs/COUNTY-VIEW.md, *Connecting*; released in 1.18.0)

- **Optional, off by default on both sides.** A county that runs the county view can switch on a connection
  (`county_connect_enabled`, County connections, `county:manage` and `settings:manage`); while off its routes answer
  404. It carries only the same signed county submission file the download makes: the "no link between servers"
  default stays, and the link, where a county turns it on, adds nothing a programme did not already send.
- **Connection tokens** per registered programme (County view › Programmes; `county:manage`): 256 random bits,
  shown once in a dialog with a Copy button, kept as SHA-256, optionally expiring, revocable, last use and address
  recorded. `POST /api/county-connect/v1/submissions` takes the signed file as its body (256 KB, capped before it is
  read and only for a live connection token) and imports it through `county.js`'s own `parseFile`/`importParsed`; a
  file signed by another programme than the token's is rolled back and refused (`wrong_programme`). The answer is
  the county's receipt (status, reason, SHA-256, received time), never figures. `GET /api/county-connect/v1/status`
  says what the county expects of that programme (its code, the cadence: calendar quarters, state fiscal quarters or
  months; the last year of periods, which are outstanding) and nothing of any other programme.
- **Read tokens** (`county.read`; 90 days by default, at most a year) for the county's own systems:
  `GET /api/county-connect/v1/combined` (JSON or tidy CSV, from the combined-view builder, with notes: summed, not
  unduplicated; exact, internal, not for publication) and `/v1/programs`. A token is never a session, and a session
  never opens these routes. Rate limited per token, per address, for wrong tokens and in all; refusals audited and
  throttled; `county.api.read`, `county_connect.status`, `county.submission.import` with `via: "county-connect"`.
- **The programme's side** (Settlement outcomes › Send to the county over the connection): an administrator saves
  the county's address and token (encrypted, never returned); **Test connection** shows what the county expects;
  **Send to the county now** (whoever may make the county file) sends it and shows the receipt, with a send log
  (no figures); audited `county_submission.send`. Automatic sending of outstanding periods, once a day, is off by
  default. Outbound: https only, no redirects, a timeout, a 64 KB answer cap, private addresses refused in production
  unless `SUDS_COUNTY_ALLOW_PRIVATE=1`, public ones through `server/outbound.js`.
- **One set of rules with the county view.** The push is `county.js`'s own import, so its refusals and their reasons
  (`recipient`, `retired_key`, …) and its words (an `older` file kept, not counting) reach the programme as they are;
  `/status` counts as the combined view counts (`county.js` `countingSubs`/`coverage`: withdrawn, replaced and
  compromised-key files do not count) and names periods with the same helpers as the county pages and the card
  (`server/county-periods.js`, from which `scripts/gen-county-periods.js` generates the browser's
  `public/county-periods.js`); `/v1/programs` gives the current key's fingerprint and the key history. **Send to the
  county now** sends exactly what **Make the county file** downloads for the card's period, county name and ticked
  funds, addressed to the county code the county's `/status` gives (a code typed on the card must match it; a county
  that gives none gets nothing), and never "every fund".
- **Migration 57**: `county_connect_tokens`, `county_connection` (`token_enc`), `county_connect_sends`. Office server
  only; not on SUDS on this device.
- Tests: `test/county-periods.test.js` (the generated copy is current and answers the same), `test/county-connect.test.js` (tokens, push, refusals, the 256 KB cap, limits, scopes and sessions, status,
  the read API, the programme's side with a 307, a timeout and a private address, and a programme server sending to
  a county server over HTTP end to end), `test/county-connect-device.test.js`; browser script
  `scripts/ui/county-connect.mjs` (the suite is now 53 scripts), and the County connections page and its dialogs in
  the accessibility audit.
- Docs: COUNTY-VIEW *Connecting*, API.md, DEPLOYMENT (outbound to the county; inbound on the county's server),
  THREAT-MODEL, DATA-INVENTORY, PEN-TEST-SCOPE, DATA-NETWORK and STRATEGY (Tier 1 has an API), USER_GUIDE.

### Security: the county connection API review (r1; before release)

- **No lockout by made-up tokens (Medium).** Calls without a good token are checked against their own limits first
  (20 per address, 1,000 from all addresses per 10 minutes) and never count towards the limits of calls with a good
  token (per address, all addresses, per token), so a flood of garbage tokens from many addresses can no longer make
  a programme's real token wait (`server/routes/county-connect.js` `machine`).
- **Automatic sending checks the county's `outstanding` periods (Medium).** Each must be real dates, start on or
  before its end, have ended, span at most a year, and be one of the periods the county's cadence produces in the
  last two years (`server/county-periods.js`); any other is skipped and audited (`county_submission.auto_skip`, no
  figures) and never stops the rest; an error making one period's file is caught for that period.
- **The county's code and name are not trusted (Medium).** They must pass a file recipient's checks (length, control
  characters) before they are stored or signed. A `/status` giving a different county code from the saved one is not
  taken: automatic sending switches itself off, nothing is sent, it is audited (`county_connect.county_code.changed`)
  and the card asks an administrator to confirm the new code (`confirm_county_code`, audited
  `county_connect.county_code.confirm`). Automatic sending refuses without a person's fund choice for that county
  code, and never rewrites a remembered choice.
- **`SUDS_COUNTY_ALLOW_PRIVATE` resolves and pins (Medium).** Under the flag a county's name is resolved, every
  address checked and the connection pinned to a checked one (`server/outbound.js` `privateNetworkFetch`): RFC 1918
  and IPv6 unique-local addresses are allowed (a normal name through split DNS works), loopback, link-local,
  metadata, `0.0.0.0`/`::` and their IPv4-mapped forms are refused, and TLS verifies the county's host name.
- **One deadline for the whole exchange (Low/Medium).** Requests to the county end at 15 seconds even when the answer
  is dripped a byte at a time (`AbortSignal.timeout`); the automatic run is always released.
- **Low:** a deactivated programme's connection tokens are refused and deactivation revokes them, audited; an unknown
  key and another programme's key are one refusal reason to the token holder (`not_this_programme`), the county's
  audit keeping which; the hourly housekeeping writes the summary of throttled refusals whose hour is over.
- **Docs:** PEN-TEST-SCOPE (the programme's server facing a hostile county), THREAT-MODEL, DEPLOYMENT (`TRUST_PROXY`
  is required for the county connection behind a proxy; County connections warns when calls arrive with
  `X-Forwarded-For` and it is unset), COUNTY-VIEW *Connecting*.

### Added: the county view (docs/COUNTY-VIEW.md; DATA-NETWORK Tier 1)

- **Send to the county** (Settlement outcomes; office server only). Whoever files the funder submission
  (`reports:funder`, with `budget:read` and `export:read`) makes a **county submission file** for a period and one
  county: the Settlement outcomes page's own exact figures (`figures()`, not a second count) **for the settlement
  funds they tick** (nothing is ticked the first time; the choice is remembered per county; every total is over the
  chosen funds alone), per fund, per Exhibit E allowable use and in total, with spending and the thirteen outcomes.
  The file names its **recipient**: the county code the county gives out (County view › Programs) and the county's
  name. The card has its own **period**: the last complete calendar quarter by default, each quarter also named as
  its California fiscal-year quarter (July–September is FY Q1), whole fiscal years and the last calendar year; the
  period is shown beside the button, a non-quarter period is warned about, and one that ends today or later is
  refused. Aggregate only: the payload is an allow-list checked when the file is made and again on import; no
  client, client code, participant code, name, date of birth or single event. Signed with an **Ed25519 key of this
  office server**, its private half encrypted with the database key (`county_signing_keys.private_key_enc`). **Show
  the key for the county** makes it without a file; the fingerprint and public key each have a Copy button, and the
  key wraps on a phone. **Make a new key** retires it and shows the new fingerprint to read to the county (audited
  `county_submission.key.rotate`). The file is named after the program. Audited `county_submission.export` (period,
  county code, fingerprint, payload SHA-256; never figures).
- **County view** (`#/county`; office server only): for a county that runs SUDS (a county-only install holds no
  client data). **Programs**: the county code; register each program by its public key, with the fingerprint shown
  as the key is typed and either the fingerprint read out typed (a mismatch refuses the key) or "I compared it"
  ticked; **key history** per program (replace the key; files an old key signed keep counting unless it is marked
  compromised; a new file must use the current key; one program is always one column); deactivate (its new files
  refused and its files no longer counted, unless the county keeps counting them). **Submissions**: import signed
  files (size, JSON, schema and allow-list, typed text free of control characters and bounded, `generated_at`
  strict ISO-8601 UTC, the SUDS version a version, the period ended, **made for this county**, a registered current
  key of an active program, the signature; every refusal says why, is audited `county.submission.refuse` and is
  throttled per person, and a throttled attempt is audited once per window); of one program's files for a period
  **the one made last counts** (by the signed time, whatever order they arrive in: an older one is kept already
  replaced); the same file twice changes nothing (per program); **withdraw** a current file with a reason (whatever
  it had replaced counts again) and **reinstate** a withdrawn one; each file *Current*, *Replaced*, *Withdrawn* or
  *Not counted: key compromised*. **Combined view** for a period (a form, Enter applies; presets for the last
  quarter, the fiscal year and its quarters, the calendar year and the year to date): the headline "N of M programs
  submitted for the whole period, K for part of it, J not at all", who submitted, spending by allowable use and by
  High Impact Abatement Activity, and each outcome, one column per program and **Total (N of M programs complete)**,
  "— not submitted" in words for a program with nothing for the period; people labelled "each program's own count,
  summed" (never "unduplicated"); the caveats behind an always-visible one-line summary; **by quarter** (measures by
  quarter, each quarter combined by the same rule, each program's figures behind a disclosure); Excel, CSV and a
  long **tidy CSV** (program, period, fund, grant number, measure, value), labelled internal and exact. Only files
  wholly inside the chosen period count, the longer of two overlapping ones; nothing is pro-rated. Everything
  audited without figures.
- **Permissions** `county:view` (administrators, supervisors, finance) and `county:manage` (administrators; sensitive).
  Neither can be granted to a role without exact aggregate counts (read-only, navigators, clinicians). The County
  view entry shows to `county:view` once any program is registered (active or not), and to `county:manage` always.
- **Migration 56**: `county_signing_keys`, `county_programmes`, `county_programme_keys`, `county_submissions`
  (payload encrypted, `payload_enc`; one submission per program and payload). Office server only
  (`server/sync-tables.js` `server_only`); not in the local kernel's routes, so SUDS on this device neither makes nor
  imports a county file.
- `scripts/county-sample.js`: three fictional programs' keys and signed files. `--register` sets up a development
  server's county view in one command (refused on production); `<dir> --county-code …` writes the files for a
  county. `npm run seed` stays a program's data.
- Tests: `test/county.test.js` (each test stands on its own; the payload's fields frozen for schema version 1),
  `test/county-device.test.js`; browser script `scripts/ui/county.mjs` (the 52nd script; `county-connect.mjs` is the 53rd; 1.17.1 had
  51), and the county pages, the program, keys, withdraw and new-key dialogs and the settlement card's public key in
  the accessibility audit (`A11Y_PAGES` audits one area in every pass).
- Docs: `docs/COUNTY-VIEW.md` (new); DATA-NETWORK Tier 1 status, STRATEGY *Built vs planned*, POSITIONING, the market
  README, buyer guides, demo script (Path 2), pricing (model C), pilot kit (§8), README *At a glance*, USER_GUIDE,
  API.md, DATA-INVENTORY, THREAT-MODEL, PEN-TEST-SCOPE (the import parser).

### Deferred

- The publication screen over the combined release (so nothing from the county view is publishable); benchmarks
  (Tier 2); county-entered unsigned figures for grantees not on SUDS; award and contract amounts per fund (a schema
  version 2); reporting-cadence reminders on the program's side; checking the file against a county's own template.
  Unduplication across programs is ruled out, not deferred.

### SUDS Server: a hardened self-hosted install, and a compliance check that records it

- **Review fixes (before release).** The compliance check, run as root, no longer follows any path the `suds` user
  controls: reports are created `O_EXCL|O_NOFOLLOW` in a checked directory and handed over by descriptor, the database
  is read from a private copy (no root-owned `-wal`/`-shm`), the drill report named in the database must be a bare
  file name, and errors never carry file content. Reports go to `/var/lib/suds-compliance` (root:suds 0750) signed with
  the check's own root-only key (`/etc/suds/compliance-signing-key`), which SUDS verifies but never holds. The
  installer makes every directory with an explicit mode (under umask 077 the Node and Caddy directories were 0700), and
  is now tested for real into a fake root (`test/deploy-linux-real.test.js`). An upgrade's rollback restores with
  `scripts/backup.js --restore-in-place`, which never opens the (possibly migrated) live database; `--restore` only
  decrypts to a separate file. The SSH lock-out guard works under `sudo` (`who -m`, parent processes, `ss`) and refuses
  when it cannot tell. A release zip needs `--release-sha256` from another channel (or `--trust-release-checksum`,
  reported by `host.release_integrity`), is copied before hashing, and is staged via `<version>.partial` with a
  manifest. Installer input is whitelisted; `provision.json` may only tighten settings; chrony is kept on Ubuntu,
  `--ntp-server`; the offsite share's outage no longer stops SUDS; `upgrade.sh` updates and restarts Caddy; journal
  size cap `--journal-max-use` and the oldest entry as evidence; `--ca-file`, `--connect-host`, and
  `suds-server.conf` keeps unknown lines; a new server's first backup and drill are *pending first run*, not failures.
  Also: `cipher_null` fails, `app.index_key` is *could not check* without the key, unknown compliance-check options are
  an error, the compliance unit has a capability bounding set, the Docker image runs as uid/gid 10001 (existing
  volumes: `chown -R 10001:10001 /data /anchors` once, deploy/docker/README.md), and SELF-HOSTING.md's compliance
  boundary names a check for every *Implements* row, with an operator checklist.

- **One-command install on a Linux VM** (`deploy/linux/install.sh`; Ubuntu 24.04 LTS, RHEL/Rocky/Alma 9). Idempotent,
  `--dry-run` prints every action. Installs the Node.js release CI tests on and a static Caddy, each checked against a
  pinned checksum (`deploy/linux/pins`; never `curl | sh`); the code root-owned and read-only in `/opt/suds/<version>`;
  the `suds` user and `/var/lib/suds` 0700; the four keys generated as root-only systemd credentials
  (`/etc/suds/credentials`, `LoadCredential=`), never in an environment file, with a one-time key-escrow instruction;
  Caddy with the repository's `Caddyfile` (TLS 1.2+, HSTS, port 80 only for redirects and ACME) or a county
  certificate; ufw or firewalld (443, 80 with ACME, SSH only from `--admin-cidr`); time sync; security-only automatic
  updates; a persistent journal kept 400 days; local mode off, MFA for every role, `TRUST_PROXY`, scheduled backups to
  the offsite share and audit anchors on the WORM share. It **refuses** a data directory not on a LUKS/dm-crypt volume
  (unless `--accept-unencrypted-disk=<reason>`, printed as an accepted risk on every compliance report), anchors or
  offsite copies inside the data directory, unmounted shares, and an SSH session its firewall would cut off.
- **`deploy/linux/upgrade.sh <version>`**: stage and verify the release, stop, back up with the service's own
  credentials, swap `current`, start, wait for `/api/health/ready`, and roll back (code, Node, units and the database
  from that backup) if it does not come up; never a downgrade. `uninstall.sh` never removes data or keys.
- **The systemd unit has one source**, `deploy/linux/suds.service`; docs/DEPLOYMENT.md refers to it instead of carrying
  a copy (`test/deploy-linux.test.js`).
- **`npm run compliance-check`** (`scripts/compliance-check.js`; weekly from `suds-compliance.timer`): data directory and
  database permissions, disk encryption, keys out of readable files and the environment, the unit's effective
  sandbox, TLS (1.2+, 1.0/1.1 refused, certificate > 14 days, HSTS) and the HTTP redirect, loopback-only binding,
  firewall, clock offset, security updates, journal retention, auditd, the pinned Node, a supported SUDS release, the
  newest local and offsite backups, the last recovery drill's signed report, and the audit chain and anchors verified
  now — plus every line of Settings → Security status, read through the same code on a read-only database
  connection. Each check names the HIPAA Security Rule, 42 CFR §2.16 or CMIA §56.101 rule it evidences
  (`server/compliance-rules.js`), what it observed and how to fix it. "Could not check" is never a pass; exit 1 on
  any failure. JSON and self-contained HTML reports signed with the compliance check's own key;
  `npm run verify-compliance-report` checks either with the public key alone (the HTML is re-rendered and compared).
- **Settings → Security status** shows the rule each control evidences and a *Host (last compliance check)* section
  from the latest report, with its date and whether its signature verifies. New route
  `GET /api/admin/security/compliance-report` (`settings:manage`; `?format=html`), audited
  (`security.compliance_report.view`); the server records each new report (`security.compliance_report.generated`).
- **Secrets from files**: every key and secret can be `<NAME>_FILE` (Docker/Kubernetes secrets, systemd credentials)
  or a systemd credential named after it in `$CREDENTIALS_DIRECTORY`; the value is never copied into the process
  environment (`server/config.js`). `deploy/docker/` covers where a container's guarantees differ from the VM's, with
  a secrets override for `docker-compose.yml`.
- **Provisioned settings** (`SUDS_PROVISION_FILE`, `server/provision.js`): an installer's choice of backup schedule,
  offsite directory, monthly drill and MFA-for-every-role, applied only where no administrator has chosen, and audited
  (`settings.provisioned`).
- **Docs:** [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) — sizing, prerequisites, what the installer does and why,
  upgrade, backup, drills, monitoring, the compliance check, and an honest compliance boundary: which HIPAA and Part 2
  safeguards SUDS Server implements, which it supports with evidence, and which are the organisation's.

## 1.17.1 — 2026-09-29

### Security (review of 1.17.0, r11; all Low)

- **AI copilot monthly cap under concurrency.** A draft on its way to the provider is reserved before anything
  is sent and counted until its outcome is recorded, so concurrent requests at the last draft of the month can no
  longer overshoot the cap (`server/ai-copilot.js`).
- **AI-assisted mark for a note not saved yet.** A copilot note draft asked for without a saved note is remembered
  (in memory, for 120 minutes) for its author and client; the next note that author writes text into for that
  client, over REST or sync push, is marked AI-assisted by the office whatever the browser sends, so signing it
  needs the review statement and it cannot be a SUD counseling note (`server/rules/notes.js`).
- **Referral links and their creator.** A packet is withheld at open when the worker who made the link has been
  deactivated or can no longer reach the client; deactivating a worker (Users, SCIM, SSO deprovisioning) withdraws
  the links they made that could still be opened, each audited (`server/referral-links.js`).
- **Referral link refusals throttled.** A forwarded link opened again and again, a withheld packet and an
  acknowledgement from an unclaimed browser are audited through the per-link refusal throttle.
- **No redirects to the AI provider.** The provider request never follows a redirect; one is refused (not retried)
  and the draft fails closed.

### AI copilot: providers and cost (owner request for 1.17.1)

- **Amazon Bedrock and Google Vertex AI.** `SUDS_AI_PROVIDER` chooses Anthropic's API (the default), Amazon Bedrock
  (InvokeModel, AWS Signature Version 4) or Vertex AI (rawPredict, a service account's signed JWT exchanged for an
  access token), so a county can use the copilot under the business associate agreement it already has with its
  cloud provider. Node's built-in `crypto` only: still no dependencies (`server/ai-providers.js`). Every gate is the
  same on each: the recorded agreement, counsel, the caps, identifier replacement, audit without the text, and no
  redirects. The agreement now records which provider the server was set up for, and drafts stop
  (`provider_changed`) if the server is later pointed at another until an administrator records that agreement.
- **Estimated cost in dollars.** An administrator can enter the price per million input and output tokens, and
  the *This month* card shows the month's estimated cost; an optional monthly spending limit pauses drafts like
  the draft limit (`server/ai-cost.js`; audited as `ai.settings.update`). An estimate, not a bill.
  `docs/AI-COPILOT.md` gains *Providers* and *Cost*, including what to confirm with each provider and counsel.

### Frontline (review of 1.17.0, UX)

- Care plan suggestions: *Add problem*, *Add goal* and *Add as a step* keep keyboard focus and announce what was
  added. Street outreach: *Save contact* keeps focus (on the contact type after a save, on the error after a
  failure), and the offline message is said once.
- The CalOMS discharge copilot asks for discharge or last-session notes, not intake notes; each panel's "what is
  sent" is worded for what it drafts. *Apply* and the six-dimension rating buttons name the question or dimension
  and announce what they set. *Draft* and *Suggest* are *Draft with AI* and *Suggest with AI*.
- Settlement outcomes refuses a start date after the end date, on the page and from the server (400, page and
  export), instead of showing a report of zeros.
- The import card is *Import a spreadsheet or EHR export*: spreadsheet templates are hidden for an EHR file and
  its errors are announced. Prevention has its own navigation icon; the outreach start-page checkbox is 44 px on
  a touch screen. The AI agreement's messages are full sentences.

### Engineering (review of 1.17.0)

- **No older release over a newer one.** Pushing the 1.16.x tags after 1.17.0 was on GitHub Pages would have
  published 1.16.4 over it and locked out every device whose database 1.17.0 had upgraded. The release gate now
  refuses a version older than `main`'s (as run by any release's workflow), a release is Latest only if it is the
  newest version, and `web-app.yml` refuses to publish a version older than the one on `gh-pages`
  (`scripts/pages-version-check.js`). RELEASE.md and HANDOFF.md give the one-push tag order.
- CalOMS: the scheduled run no longer prepares a second file for a provider whose file was produced or
  discarded, *Produce* refuses records already sent, and the "uploaded on" check measures from when the file
  was produced.
- A client revision whose earlier value is a list choice retired since can be put back.
- Rules written twice now live once in `server/rules/`: the AI review statement, the AI-assisted mark, and the
  SSP participant code (REST, sync push and import agree; `test/rules-parity.test.js`).
- Browser suite: multitab's queued-work case tells a save that reached the store before the takeover from the
  race it tests (it failed intermittently on a loaded machine).
- Supported versions, the security questionnaire and the evidence page describe 1.17; changelog counts corrected.

### Market and documentation (review of 1.17.0)

- README: *What's new in 1.17.0* and the new features in *At a glance*. "Built for 1.17.0" wording corrected
  everywhere, and the wording test now fails on "built for" a released version. SBOM for 1.17.0.
- Sample data fills the outreach, SSP participant code, settlement, prevention and CalOMS screens (no new sample
  clients or funds). `docs/market/DEMO-SCRIPT.md`: a 20-minute first-meeting walkthrough for a CBO director and a
  county funder.
- PILOT-KIT measures the copilot from data SUDS already keeps; the pen-test scope covers referral links and the
  copilot routes; the DPA and BAA/QSOA drafts carry an AI-provider clause; POSITIONING compares with AI
  documentation tools and EHR add-ons (prices left for the owner to verify); the ROI worksheet has a copilot section.

## 1.17.0 — 2026-09-29

### AI documentation copilot

An optional module, **off by default** and **office server only**, that drafts documentation for staff to review
(`docs/AI-COPILOT.md`). A person always reviews and decides: the copilot never saves, signs or submits anything.

- **What it drafts.** Progress notes: from the author's own session notes or transcript, the sections of a DAP,
  SOAP, BIRP or GIRP note, or a narrative for the other formats (not a safety plan), in a folded "Draft with the AI
  copilot" section of the note form. Six-dimension assessments: a narrative and a *suggested* 0–4 rating per
  dimension; the clinician chooses each rating and must tick "reviewed" for all six before saving. Care plan:
  problem, goal, objective and intervention suggestions from an assessment and/or notes, each added one at a time
  through the ordinary care plan routes ("Suggest with AI"). CalOMS: suggested answers in the admission and
  discharge dialogs, each applied only on **Apply** and checked against the CalOMS code sets (read-only use of
  `server/caloms-spec.js`).
- **Review before signing.** Drafts show under "AI draft — review before signing". A note with AI-drafted text is
  marked `ai_assisted` (never cleared, kept as signed, shown as an **AI-assisted** badge), and signing it requires
  the author's statement that they reviewed and corrected it (`ai_reviewed`; the `note.sign` audit entry records
  both).
- **Gating.** An administrator must first record the programme's agreement with the provider — who signed, the
  date, the reference, and confirmation of a BAA with 42 CFR Part 2 QSOA terms and counsel's review — under
  Settings → **AI copilot**, then switch it on (`POST|DELETE /api/ai/attestation`, `GET|PUT /api/ai/settings`;
  audited). The provider key is `ANTHROPIC_API_KEY` in the server environment only. Model setting (default
  `claude-opus-5-5`) and a monthly cap per programme (default 500). Withdrawing the agreement switches it off.
  SUDS on this device and local mode have no copilot and say why (the route module is not in the kernel).
- **What is sent.** Only the text given for one client (and, for care plan suggestions, the one assessment chosen
  and the active problem wording), after the client's names, date of birth, phones, email, address, city, ZIP,
  Medi-Cal number, emergency contact, client code and the author's name are replaced with placeholders and phone,
  email, SSN, URL, street-address and long-number patterns are masked; names are put back on the server after.
  Never another client's data or anyone else's notes; a signed note cannot be redrafted. Documented as not
  de-identification, with the residual risks.
- **Permission** `ai:draft` ("Use the AI documentation copilot"): clinicians, supervisors and navigators by default
  (a navigator drafts administrative notes, care plan and CalOMS suggestions, not clinical notes or assessments, as each draft also needs the permission
  to write what it drafts); not administrators; never grantable to finance or read-only.
- **Provider call** with Node's built-in `fetch` (no new dependency): the Messages API with structured outputs,
  cached system instructions, a 180-second timeout, and for the default model effort `medium` and the provider's
  refusal fallback. Timeouts, rate limits, provider outages, refusals and unreadable answers are said in words
  and leave the form unchanged; each call is audited (`ai.draft`: who, client, feature, model, token counts,
  identifiers replaced — never the text) and counted in `ai_usage`. One person may ask for 12 drafts a minute.
- **Prompts** in one module, `server/ai-prompts.js`: SUD-specific, draft only from what is given, never invent,
  `[needs clinician input]` for gaps, person-first non-stigmatizing language, placeholders kept, the session text
  treated as material rather than instructions.
- **Migration 53**: `notes.ai_assisted`, and the `ai_usage` table (office server only, never synchronised).
  Migration 49 is a documented no-op and 52 is reserved for the publication-release change (no-op until then).
- Tests: `test/ai-copilot.test.js` (permission, gating, attestation, the request body, de-identification, audit,
  usage and cap, provider failures against a local fake provider, a draft never saved or signed). Browser script
  `scripts/ui/r10-ai.mjs` against a fake provider, with axe on the panels, dialogs and the Settings tab (one of
  the suite's 51 scripts). Docs: `docs/AI-COPILOT.md`; HIPAA, Part 2, architecture, data lifecycle, deployment, user
  guide and buyer guides updated.

### Access

- **A programme-wide least-privilege default.** Settings → Users & permissions (administrators) has *New navigators
  and clinicians start held to their caseload*. While it is on, every account that becomes a navigator or clinician
  is given a per-user deny of *See every client* (`clients:all`) with the reason "programme default: held to
  caseload", each one audited (`user.permission.deny`, with its cause): an administrator creating the account
  (`POST /api/users`), an approved access request (`POST /api/users/:id/approve`), SCIM provisioning, a role change
  into navigator or clinician by an administrator or by SCIM, and, on SUDS on this device, the device administrator
  creating an account or making one a navigator or clinician. Single sign-on creates no account (its first sign-in
  links the account SCIM provisioned, which was held then). A device sign-up is held to its caseload as before,
  whatever the setting says (and denied clinical notes too). The reset-admin script makes administrators only.
  Only `clients:all` is denied: a navigator keeps reading clinical notes (the 1.16.0 decision); deny *Read clinical
  notes* per person. An individual decision already recorded about `clients:all` (a grant or a deny) is left alone,
  and moving an account out of navigator and clinician lifts the default's own deny, never an administrator's.
- **On for a new install; off for an upgraded office.** A new database starts with the setting on. A database from
  an earlier release starts with it off, recorded once at the first start (a settings row, `caseload_hold_new_staff`;
  no migration), so an upgrade changes nobody's access; while it is off, Users & permissions recommends turning it on.
  Turning it on or off changes no existing account (audited, `settings.caseload_default`).
- **Apply to existing navigators and clinicians.** A one-off action on the same card: a confirmation lists exactly
  who will be held (and who is left alone because they were granted *See every client* individually), and only
  those people change, each audited (`cause: applied_to_existing`), with a summary entry
  (`users.caseload_default.applied`).
- **Who is held, at a glance.** The user list has a *Clients* column: *Every client*, *Caseload only* (with *program
  default* when the setting did it), or *Client codes only* for finance and read-only.
- New routes: `GET`/`PUT /api/users/caseload-default` and `POST /api/users/caseload-default/apply` (`users:manage`).
  No new permission, no migration. Tests: `test/least-privilege-default.test.js` (every office path, role changes,
  apply-to-existing, and that the REST list, search, a record and sync pull then keep to the caseload),
  `test/least-privilege-sso.test.js` (SCIM and single sign-on), `test/least-privilege-device.test.js` (the browser
  kernel), `test/migrations.test.js` (off after an upgrade); browser script `scripts/ui/r10-lp.mjs`.
- Docs: QUESTIONNAIRE #22, IDENTITY.md, HIPAA.md, SOC2-READINESS.md, PART2.md, CALAIM.md, USER_GUIDE.md and the
  buyer pack (market/README.md, BUYER-GUIDE-IT.md, POSITIONING.md, PROCUREMENT.md, PILOT-KIT.md), with the
  threat model, the data inventory and the evidence index, no longer list
  "least privilege is not the default" as a gap for new installs; for upgraded offices it is a setting to turn on.

### Client records

- **Revision history with revert (market review r7 finding 3, r9 1.17.0 item 2).** Since 1.16.1 anyone who can see a
  client may change the record, and the primary worker was told only which fields changed; SUDS kept no earlier
  values, so a wrong date of birth came back only from a backup. Every change to a client's own details is now kept
  as a revision (`client_revisions`, migration 50): who made it, when, how it arrived (`rest`, `sync`, or the gaps a
  `merge` filled in on the record kept) and each changed field's value before and after, encrypted
  (`changes_enc`; the audit entry `client.revision` names the revision and the fields, never a value). Written by
  `PUT /api/clients/:id`, by a device's edit when its push lands (`server/rules/clients.js`) and by a merge; imports
  only create clients. `server/client-revisions.js`.
  - **Who reads it (minimum necessary):** the client's care team (an active assignment, any role on the case) and
    `records:manage-others` (supervisors, administrators), on the record's new **History** tab
    (`GET /api/clients/:id/history`, audited `client.history.view`). Anyone else who can open the record sees it as
    it is now; asking for its history is refused and audited.
  - **Put this change back** (`POST /api/clients/:id/history/:rev/revert`): the primary worker or
    `records:manage-others`. Only while the change's fields still hold what it set (otherwise 409, naming the fields,
    never a value); the same rules as any edit; a new revision naming the one it reverts (`client.revert`), and a
    change notice when the reverter is off the care team. Nothing in the history is updated or deleted.
  - **The change notice links to it.** Its audit entry names the revision; the card's **See what changed** opens the
    History at the changes it reports (`notice_revisions`), for the primary worker and supervisors.
  - **Kept at the office.** Revisions never synchronise (`server/sync-tables.js` `server_only`): a device that syncs
    keeps no earlier values and its History tab says to open the record at the office; its edits are recorded there
    when they land. SUDS on this device, which has no office, keeps its own.
  - **Retention:** purged with the client, leaving no tombstone; not activity (an edit does not extend a record's
    retention). Key rotation re-encrypts `changes_enc` like every `_enc` column.
  - Changes a discharge, an overdose event, a visit or an ASAM rating makes to the record (status, overdose history,
    naloxone, level of care) are recorded on those records, not as revisions. Values from before this release were
    never kept and are not in the history.
  - `server/sync-tables.js` now declares the encrypted columns of the tables that never synchronise too
    (`unsynced_enc`), and `test/sync.test.js` checks it against the schema. Migration 49 is a no-op (1.17.0's
    least-privilege default needed no schema change); this one is 50.
  - Docs: USER_GUIDE (*A client record's History*), HIPAA.md (integrity, amendment, retention), PART2.md (§2.16),
    QUESTIONNAIRE #22, POSITIONING, BUYER-GUIDE-IT and BUYER-GUIDE-PROGRAM (earlier values are now kept). Tests:
    `test/client-revisions.test.js`; browser: `scripts/ui/r10-hist.mjs`.

### Prevention and syringe services

A feature release item (1.17.0): migration 51, one new table, two new columns, new routes, no new permission.

- **Anonymous SSP participant code.** A contact with no client record (outreach, community distribution) can carry
  the participant code the person builds the same way each time by the programme's recipe (the visit form suggests
  one; SUDS stores only the code, never the details it is built from). It is kept in one form (capitals, letters and
  digits, 4–20 characters), **encrypted** (`interventions.participant_code_enc`) and counted by its **blind index**
  (`participant_code_idx`, HMAC under the index key; `scripts/rotate-index-key.js` re-derives it). A code on a
  contact with a client is refused, over REST and by sync alike (`server/rules/interventions.js`); a device's code is
  normalised and indexed with the office's key (`server/sync-tables.js` importRow), and a pull never sends the index.
  The **SSP summary** (`GET /api/reports/ssp`) now counts **Anonymous participants** — the different codes at the
  period's anonymous contacts — beside the participants served (clients), never added to them, under the same
  small-cell rule, with the anonymous contacts that had a code; its files print no code. A visits export,
  de-identified or identified, carries a **participant reference** (`P-…`, random for each file) instead of the
  code. The count is not part of any publication release. The docs no longer say that no field holds a participant
  code ([docs/SUPPLIES.md](docs/SUPPLIES.md), *Participant codes*).
- **Group and community prevention events** (SABG primary prevention). A **Prevention** page
  (`/api/prevention-events`, `interventions:read`/`interventions:write`; another worker's event is theirs or a
  holder of `records:manage-others`'s to change or delete, from a device as over REST —
  `server/rules/prevention_events.js`): date, what it was, kind of event, **CSAP strategy**, **IOM population
  category**, audience, place, hours, attendance (a headcount, marked when estimated; never names), fund and notes
  (encrypted). The strategies, IOM categories, kinds of event and audiences are Settings › Lists option lists with
  codes and labels; the CSAP strategies and IOM categories can be reworded but not added to, and *Training* cannot be
  retired. The table synchronises to every device whose role reads visits.
- **Prevention activity summary** (`GET /api/reports/prevention`, `reports:read`; `/export?format=xlsx|csv`, also
  `export:read`): events, hours, attendance and **people trained** (the attendance of training events) for a period,
  by strategy, by IOM category, by both and by kind of event. It is **not a PPSDS file**: the PPSDS field mapping
  awaits the DHCS PPSDS data dictionary, and the file and the page say so. Audited (`report.prevention`,
  `report.prevention.export`).
- Docs: the buyer guides, POSITIONING, SCOPE, the market scorecard (the SABG primary-prevention row now says
  exactly what exists and what does not), PILOT-KIT Q0, PROCUREMENT, HIPAA data classification and the USER_GUIDE.
  Browser script `scripts/ui/r10-prev.mjs` (one of the suite's 51 scripts); API tests in `test/prevention.test.js`.

**Not in this change:** a PPSDS-shaped export (needs the DHCS PPSDS data dictionary); an evidence-based programme
field and attendance by demographic group (only if the dictionary asks for them); anonymous participants in a
publication release (a new count of people in the release's audit needs the statistical review first).

### Part 2 layer, CalOMS and referrals

Schema migration 55 (52 and 54 are documented no-ops for the publication-release and settlement/outreach changes). New routes,
each with API tests; no new permission.

- **SUDS as the Part 2 layer beside an EHR.** A third programme profile, **Part 2 compliance module (beside an
  EHR)** (`part2_layer`; Settings › Program, and the setup wizard), for a treatment programme whose EHR
  (eClinicalWorks, Epic, SmartCare…) stays the clinical record: the care plan, assessments, CalOMS and the hand-off
  are off by default, the FHIR API on; Supplies, Street outreach, Overdose, My time, Funding, Settlement outcomes and the
  funder report leave the sidebar;
  Privacy & Part 2 leads it and opens on a new **Part 2 layer** tab — consents (live, expiring, pre-2024 form, active
  clients without one), disclosures by source, the §2.32 notice, counseling notes, patient requests and their
  deadlines, breaches and complaints, secure referrals and the EHR integration, as counts (`GET /api/part2/layer`,
  caseload-scoped). Every Part 2 control is the same in every profile.
- **Import from the EHR.** Import offers *Patients from your EHR* and *Encounters from your EHR*: a FHIR R4 Bundle or
  Bulk Data NDJSON is turned into the rows a spreadsheet would give and goes through the spreadsheet import's own
  preview, validation, duplicate check and commit (`POST /api/imports/ehr/preview`; `server/importers/fhir-ehr.js`).
  SUDS never connects to the EHR.
- **FHIR Provenance.** Each Consent the FHIR API serves has a `Provenance` (`consent-<id>`: who holds it, when it
  was signed and recorded, and §2.31/§2.32 as policy), listed exactly when its Consent is and accounted the same way.
- **Integration guide and positioning.** docs/integration/EHR-PART2-LAYER.md (what to connect, data flows, what
  stays in the EHR); docs/market/POSITIONING.md gains "the disclosure-compliance module your EHR doesn't have",
  stating plainly that it is software support for Part 2 controls, not a certification.
- **CalOMS Tx monthly automation.** An administrator can have SUDS check the previous month on a set day and
  **prepare** its submission file — program-wide, every implemented edit check — one file or one per provider ID. A
  prepared file is not a disclosure: nothing is accounted or stamped until someone with `export:identified`
  **produces** it (`POST /api/caloms/submissions/:id/produce`), which accounts exactly those bytes and sets
  `extracted_at` as a hand-produced submission does, and is refused if any record in it changed since (then
  **discard** and prepare again). A **worklist** assigns each validation error to the record's owner
  (`GET /api/caloms/worklist`; *Mine* / *Everyone's*). A **submission log** records who prepared, produced,
  downloaded, recorded the upload to DHCS (with the portal's reference) or discarded each file
  (`caloms_submission_events`). SUDS still does not submit to DHCS and holds no DHCS credentials.
- **County mode, the safe part.** Each CalOMS provider ID can carry its legal name and NPI (check digit verified), and
  a submission can be made for one provider. SUDS has no multi-organisation concept; several unrelated provider
  organisations on one server is not supported. The design for it is docs/architecture/COUNTY-MULTI-TENANT.md (until
  then: one instance per provider, hosted by the county).
- **Secure referral links.** A referral to an organisation not on SUDS can go as a one-time link the provider opens
  without an account (*Secure link* on a referral; `/referral-link.html`). With a live Part 2 consent naming the
  provider it carries a minimal referral (name, reason, urgency; phone and date of birth only if ticked), behind an
  access code given separately and claimed by the first browser; the consent is re-checked at every open and the
  disclosure is accounted when it is first opened. Without one, only a "please contact us" notice that names nobody.
  Tokens are 256-bit, in the URL fragment (never in a server log or Referer), stored hashed; links last 1–7 days, can
  be withdrawn, lock after five wrong codes, and every open is audited. The provider can say what happened, which
  gives the worker a to-do to record the outcome, and is invited to receive referrals through SUDS. Office server
  only. Threat model: docs/security/REFERRAL-LINKS.md.
- **Secure referral links are a programme setting, off by default** (market review of the 1.17.0 candidate): a new
  install and an upgrade start with it off; an administrator switches it on under Privacy & Part 2 → *Secure
  referral links* (`PUT /api/referral-links/settings { enabled }`, audited as `settings.update`; `GET` says whether
  it is on, and `GET /api/auth/me` tells the browser, which hides *Secure link* while it is off). Off, making a link
  is refused (`409`) and links already sent stop opening. The documents say counsel reviews the design as built
  before a programme switches it on, and that the office server must then be reachable from the internet.
  `test/referral-links.test.js`.
- Browser suite: `scripts/ui/r10-part2.mjs`.

### Settlement outcomes and street outreach

Two features for 1.17.0. No migration and no new permission; three new routes (`GET /api/reports/settlement-outcomes`,
`GET /api/reports/settlement-outcomes/export`, `GET /api/outreach/shift`).

- **Settlement outcomes** (sidebar → *Settlement outcomes*, for finance, supervisors and administrators:
  `reports:funder` or `reports:internal`, with `budget:read`). For each opioid settlement fund, each on its own (a
  county's, a city's and the state's share), what it spent beside what the programme recorded of the work charged to
  it: naloxone kits distributed and reversals reported for overdose-reversal spending; contacts, test strips and
  syringes for harm reduction; people served, admissions, referrals and people linked to care and to medication for
  OUD for treatment and recovery; education sessions, people trained and staff training hours for prevention and
  training. By Exhibit E category, by fund and by month, with the cost per outcome (spending under the fund's own
  category divided by it) where that means something. Which outcomes each category shows is one module,
  `server/settlement-outcome-map.js`, with its own tests. Every count of people goes through the funder report's
  small-cell rules and counting modes, protected across the settlement total, each category, each fund and each
  fund's months; the page and its files are **suppressed by default, for finance too** (`<11`, `suppressed`), exact
  on request for the roles the funder report allows, never a publication release, and **no cost per outcome is
  shown beside a hidden count**. Excel, CSV and a printed page, made when the signed-in person asks and audited
  (`report.settlement_outcomes`, `.export`); SUDS sends nothing anywhere. It says what it is: the programme's own
  figures, not an official state reporting system (docs/compliance/HARM-REDUCTION-REPORTING.md, section 5).
- **Street outreach** (**+ Log → Street outreach contact**, or the sidebar). One phone screen for anonymous field
  contacts, one-handed at 390 px with targets of 48 px: the kind of contact (the services that need no client), −
  count + for naloxone kits, test strips, syringes, wound care and the programme's other usual items (any other item
  from the supplies catalog one choice away), a coarse place and the supply site, and a line of notes without
  identifiers. A contact is an anonymous visit through `POST /api/interventions`: its supplies come off the stock by
  the supply rules, it syncs like any visit, and the funder report, the NDP log and the syringe services summary
  count it. It works with no connection on SUDS on this device and on a device that syncs with an office (the
  office draws its own stock down once, at the next sync). **My shift** (`GET /api/outreach/shift`) counts the
  worker's own contacts since the start of the day or of the shift they started, without notes. A worker can make it
  their start page (on the screen, or **My profile → Start page**; the `start_page` preference), used after
  sign-in and when SUDS is opened with no page in the address. The screen takes the anonymous SSP participant code
  (*Prevention and syringe services* above) as the visit form does, and **My shift** counts the different codes
  among the worker's contacts (`participants`, by blind index; never a code). Under the Part 2 compliance module
  profile both pages leave the sidebar, as Supplies and Funding & spending do.
- **Tests:** `test/settlement-outcome-map.test.js` (the mapping, the cost per outcome and the small-cell protection
  as pure functions), `test/settlement-outcomes.test.js` (the routes, roles, counting and files),
  `test/outreach.test.js` (contacts, stock, the shift summary, reports), `test/outreach-device.test.js` and
  `test/outreach-kernel-sync.test.js` (the browser kernel with no office, and a device that syncs with one), and the
  browser script `scripts/ui/r10-outreach.mjs` (one of the suite's 51 scripts).

### Privacy

- **A filed import page no longer outlives its note or its client.** When an imported page (a OneNote export, a
  Pocket AI transcript) was filed as a note, its `import_items` row kept its own encrypted copy of the text, title and
  the client-name hints sniffed from it. A client's retention purge only unlinked the row's suggested client, and
  purging the import deleted only staged and discarded pages, so the text stayed indefinitely after the record it
  belonged to was gone (evidence-pack review of 1.16.4). Now filing clears the item's text, title and hints (the note
  is the record; nothing needs the copy, as no import is deduplicated by its text), at both doors: `POST
  /api/imports/items/:id/commit` and a device's sync push of a committed item (`server/rules/import_items.js`).
  Purging a client hard-deletes (and tombstones) every import item filed as one of its notes or suggested for it,
  staged or committed (`counts.import_items` on the `client.purge` audit row, replacing `import_items_unlinked`).
  The daily retention pass clears the copies earlier versions left on committed items (`import.committed_text_cleared`,
  audited with a count only), and purging an import batch clears them for its committed items too. No migration: it
  is a data cleanup in the retention pass, done the next time it runs (within a day of the upgrade).
  The data inventory, the threat model and QUESTIONNAIRE #13 no longer list it as a gap. Tests:
  `test/import-text-retention.test.js`; `test/sync.test.js` now expects a purged client's import items deleted and
  tombstoned.

### Engineering

Release machinery and CI only: nothing here changes what SUDS does for a user, and no administrator action is needed
on a SUDS install. The owner has repository settings to make (below).

- **The repository settings are checked every week** (engineering reviews of 1.16.1 M2, 1.16.2 L5, 1.16.3 L6). A new
  workflow, *Repository settings* (`.github/workflows/settings-check.yml`, weekly and *Run workflow*, read-only, no
  action), reads through the GitHub API the settings RELEASE.md asks the owner to make (the rulesets for `main`,
  `maint/*`, `v*` tags and `gh-pages`, the `release` environment's reviewers and deployment refs, immutable
  releases, the default workflow token and allowed actions, the deploy key and its secret, stale `release/v*`
  branches) and fails, with one row per setting in the run summary, when a setting is off **or cannot be read**:
  a refused request is "cannot verify", never a pass. The workflow's own token cannot read the admin-only settings,
  so until the owner gives it a read-only token the run stays red on those rows. **Owner:** RELEASE.md, *Owner:
  repository settings*, step 9 (a fine-grained, read-only token as `SETTINGS_READ_TOKEN` in a `settings-check`
  environment limited to `main`). Ruleset bypass lists, which no read-only token can see, are listed to check by hand.
- **A 1.16.x security fix can be released after 1.17.0** (engineering review of 1.16.1, M3). A patch of a minor
  older than `main`'s may now be released from that minor's `maint/X.Y` branch: the gate accepts a commit on
  `origin/maint/X.Y` only for such a version, the release policy measures it against the previous tag on its own
  line (1.16.5 against v1.16.4), and the release is not marked Latest and does not publish the web app;
  `web-app.yml` now publishes only the newest release tag. **Owner:** add `maint/*` to the `main` ruleset and a ruleset
  that lets only an administrator create a `maint/*` branch (RELEASE.md, step 2); the procedure for making the
  branch and releasing a backport is in RELEASE.md, *Backports*.
- **The migration check also watches what released migrations depend on** (engineering review of 1.16.0, M6).
  `scripts/migration-order.js` fingerprints the helpers each released migration runs (`rebuildTable`,
  `encryptColumn`, functions it requires) and the `schema.sql` definitions it reads, and fails CI when one changed
  since the previous release unless the change is acknowledged, with a reason, in `DEPENDENCY_CHANGES`. Run over
  history it would have stopped 1.13.0 and 1.14.0 for such changes.
- **Workflow tests read the YAML as data** (engineering reviews of 1.16.1 L6, 1.16.3 L7). `scripts/workflow-yaml.js`
  parses the YAML the workflows use, with no new dependency (it gives the same data as PyYAML on all four), and
  refuses anything else with a line number; `test/workflow-yaml.test.js` checks write scopes, environments,
  triggers, actions and the required jobs as data. Checks of what a step's shell script does stay text matches.
  `actionlint` 1.7.7 is clean on all four workflows; it is not yet a CI step.
- **The browser suite gives `accessibility` 1,800 s** (about 600 s on CI, up to about 1,200 s on a loaded development
  container); every other script keeps the 900 s per-script limit, and `SUDS_SCRIPT_TIMEOUT` still overrides both
  (`scripts/ui/run-all.sh`).

Fixes from the engineering review of the 1.17.0 candidate (at `c1a3578`, before the stamp). Unlike the items above,
three change what a user sees: where the participant code sits on the visit form, and the AI copilot's cap and
messages. No migration, permission or route.

- **The whole browser suite is green on the merged candidate** (H1). Two streams had broken older scripts nobody
  re-ran after the merges, so the candidate's required `browser` job failed: `spreadsheets` looked for the Import
  page's file input by an accept list the FHIR import had grown (it now finds the input of the import card), and
  the SSP participant code put an eighth field on a new outreach or naloxone-distribution visit at 390 px (ux13's
  budget of seven): it now sits folded under **Participant code (optional)**, right below Client, one tap away,
  opening by itself when the visit or a resumed draft has a code or for an error. RELEASE.md: when several streams
  are merged, the whole suite must be green on the final merge commit before the stamp.
- **The check's step skips at most one value per count** (M1, `server/sdc.js` `widenRange`). As first merged it
  could skip at every step, never two in a row, so a count passing with a span of P = ceil(T/2) could alternate hole,
  value, hole and stand behind ceil(P/2)+1 values rather than P+1. With one skip a passing count has at least P.
  Every skip the review measured was a single one, so no publication rate changes. `test/sdc-skip-one.test.js`
  tests the step alone (random holes, the alternation) and on the attacker's families (in `SDC_SWEEPS`); ADR-0009
  says what the skip costs and corrects the enumeration-margin rationale (above).
- **The publication perf test** (M2) no longer asserts a wall-clock bound in `npm test` (the 1,500 ms event-loop
  bound runs in the thorough job only), and the server's worker-thread offload is tested again: since 1.17.0 the
  5,000-person year audits too lightly to tell the worker from the inline path, so a deliberately heavy release
  (`test/fixtures/heavy-audit.js`, about 30 million units) is audited both ways and the worker must hold the event
  loop under half as long.
- **A 1.16.4 upgrade fixture** (M3): `test/fixtures/release-v1.16.4.sql`, a `--rich` database the released 1.16.4
  (`6491308`) wrote, with a permission override, an import item filed with its text and CalOMS submissions. 1.17.0's
  first start on it is tested: the least-privilege default recorded off, every account's role, status and overrides
  unchanged (also after a restart), migration 55's defaults on the existing submissions, the retention pass clearing
  the filed item's text and keeping staged ones', and fresh and upgraded structurally identical.
- **AI copilot provider calls** (M4, `server/ai-copilot.js`). A failed call (rate limited, unavailable, timed out,
  refused as a request) is recorded and shown but **no longer counts against the monthly cap**, which counts drafts
  the provider returned (including one it declined or cut off). A 400 or 404 says the provider refused the request
  and to check the model setting (a 413 says to shorten the text), not "shorten the text". The deadline is 180 s (a
  non-streamed request of up to 16,000 output tokens from a model that always thinks), and it covers
  **one retry** after a 429, 5xx or 529 or a failed connection, after the provider's `retry-after` when that is at
  most 10 s. Settings shows failed calls apart from drafts used.
- **The settings check warns rather than fails until its token exists** (M6). With only the workflow's own token, a
  setting that token is refused is "cannot verify (add SETTINGS_READ_TOKEN)", a warning; a setting it reads and finds
  off still fails. With `SETTINGS_READ_TOKEN`, cannot-verify fails as before. The check also reads the
  `settings-check` environment's deployment rule (`main` only), and RELEASE.md step 9 gives the order: create the
  environment, limit it to `main`, then add the secret.
- **The maintainer map describes 1.17.0** (M5): `docs/architecture/README.md` has a row per new module (rule file or
  routes, tests, office-only or not); `docs/PERFORMANCE.md` describes the device's audit worker.
- **The device audit runner hands the worker one audit at a time** (L1), so its 75 s backstop counts an audit's own
  time, not the time it queued behind another; a worker that was only slow to start is tried once more before the
  page is used for the session. ADR-0009 says why the device's backstop is 75 s and the server's 60 s.
- **The CalOMS scheduled run is idempotent per provider** (L2): a provider whose file the schedule already prepared
  (still waiting to be produced) is not prepared again, and one whose file could not be prepared leaves the month
  open, so the next hourly pass tries only that provider instead of preparing every file twice.
- **CI's browser job has 50 minutes** (L3; it had 75): the 51 scripts take 23 to 27 minutes on CI, accessibility
  595 to 634 s.
- **1.16.4 is recorded as `6491308`** (H2), the commit on `main` that is live on GitHub Pages, not `d95b69a` (not on
  `main`, its CI failed, never published): the evidence README, the questionnaire, the SBOM (regenerated from it)
  and HANDOFF. RELEASE.md records its publication by a direct `gh-pages` push at the owner's request, and that until
  the owner tags `v1.16.3` (`fc5e9d7`) and `v1.16.4` (`6491308`) the release policy, the migration baseline and the
  backport procedure measure from `v1.16.2`.

### Security

Fixes from the security review of the 1.17.0 candidate (r10) and the copilot and referral-link rules from the market
review. No migration, no new permission, no new route; each with a test that failed first
(`test/security-1170.test.js`, `test/ai-copilot.test.js`, `test/referral-links.test.js`).

- **M1: the import previews no longer say whether someone is a client here.** The spreadsheet and EHR previews
  (`POST /api/imports/data/preview`, `/api/imports/ehr/preview`) matched each name against every record and gave
  back the client code, so a worker held to their caseload could learn that a person they cannot open is a client,
  and their code. Now they apply the live duplicate check's rule: a match the caller may open is shown; one they
  may not reads as no match, and a supervisor gets a review task on that record instead (not on the caller's list).
  At commit, *skip duplicates* skips only a visible match: a hidden one is imported and flagged for a supervisor to
  compare, as at intake. A preview of clients counts against the duplicate check's per-worker limit (60 per 15
  minutes), and its audit entry records counts only.
- **L1: an AI-assisted note is signed only with the review statement, by sync too.** A device's push could sign an
  `ai_assisted` note without the author's statement that they reviewed the drafted text. The notes rules now refuse
  it (`server/rules/notes.js`; the device sends the statement its own sign route asked for, and the `note.sign`
  audit records `ai_assisted`/`ai_reviewed` as over REST). A draft asked for in a saved note (`note_id`) now marks
  that note AI-assisted on the server; the `ai.draft` audit entry, with the note's id, is the authoritative record
  (docs/AI-COPILOT.md).
- **The copilot does not draft SUD counseling notes** (§2.11; market review): the draft route refuses a note flagged
  as one, or one being written with the box ticked, and the note form hides the copilot while it is ticked; a note
  with copilot text cannot be flagged as a counseling note (web and sync). As the strategy's risk table says, until
  counsel says otherwise.
- **L2: a referral link is not opened for a removed or merged record, or a closed referral**, and the recipient's
  names are kept with the packet when the link is made: the consent is re-checked against them and the accounting
  names that recipient, so renaming the directory entry afterwards changes neither.
- **L3: the public referral-link routes cannot flood a worker's list or the audit log.** A recipient's repeated
  answers update the link's one to-do rather than adding one each; refused opens are written one by one only for
  the first 10 an hour per link (and for unknown tokens together), then counted and summarised hourly with the
  busiest addresses; and all addresses together are limited (600 per 10 minutes) as well as each one.
- **L4: CalOMS files and a worker held to a caseload.** The submission list, download, log, discard and "uploaded"
  routes now apply the same rule as prepare and produce: a worker held to a caseload reaches only the files they
  produced themselves from their own caseload, not the whole programme's.
- **L5: copilot de-identification catches more of what SUDS knows.** Names match without accents or apostrophes
  (José/Jose, O'Brien/OBrien) and with a hyphen or a space; the date of birth in more forms (ordinals, year first,
  dots, day first, words); the street abbreviated or in lower case (Old Mill Rd); and any date written after "DOB"
  or "born". The author's surname alone is masked only written as a name (not "Patricia Jones", not "the jones
  family"). Still not de-identification: docs/AI-COPILOT.md lists what it misses.
- **L6: no copilot for a client with an agreed restriction.** SUDS cannot tell whether a granted §164.522 / §2.26
  restriction covers sending the client's text to the AI provider, so every draft for that client is refused before
  anything is sent, and audited.
- `server/caloms-schedule.js`: a prepared file is described as "checked against SUDS's own edits", not
  "submission-ready".

### Documentation

Evidence for county IT and procurement review, and the 1.17.0 go-to-market documents. Documentation only: no
migration, no new permission, no new route.

- **A software bill of materials.** `scripts/sbom.js` (Node built-ins and git only) writes a CycloneDX 1.5 SBOM of
  a tag or the working tree:
  - the Node.js release CI pins, with its tarball hash, and the built-ins the server uses (it fails if `server/`
    ever requires anything else);
  - the Docker base image;
  - SUDS's own `server/`, `public/` and `scripts/` trees;
  - the vendored and generated browser files (the kernel, `sql-wasm.wasm`, their compressed copies, `qr.js`,
    `schema-text.js`) with SHA-256 and SHA-512;
  - the seven npm packages bundled into the kernel, and the SQLite release inside the wasm;
  - separately, scoped *excluded*, the build tooling, the test-only tools CI installs and the pinned GitHub
    Actions.

  `docs/evidence/sbom-1.16.4.cdx.json` is generated from the released 1.16.4 commit (`6491308`; until the review of
  the 1.17.0 candidate it named `d95b69a`, an earlier 1.16.4 stamp that is not on `main` and was not released).
  `test/sbom.test.js` regenerates it and requires the same bytes wherever that commit is in the clone (in CI,
  once the tag exists), and runs the script on the current tree.
- **A threat model** (`docs/security/THREAT-MODEL.md`) covers:
  - the office server, local-mode sync as a second door, SUDS on this device, publication releases and the
    release pipeline;
  - the actors, and the threats and mitigations by area, each with its file and test;
  - the attack classes the project's reviews found and fixed from 1.15.4 to 1.16.4;
  - the residual risks, stated plainly: the owner's repository settings are not in force; there is one
    maintainer and no independent review; there has been no penetration test; shared devices separate accounts
    by rule, not by key; least privilege is a setting an upgraded office must turn on (the 1.17.0 default below).
- **A data inventory for privacy review** (`docs/security/DATA-INVENTORY.md`) gives:
  - every encrypted column by table, whether devices receive it and what retention does to it;
  - the readable columns that are still sensitive, and the blind indexes;
  - every flow out of the database, with who can start it, its gate and its record;
  - retention, and the known gaps.

  `test/data-inventory.test.js` fails when `schema.sql` gains or loses an `_enc` column the inventory does not
  list, or when the inventory disagrees with `server/sync-tables.js` or `server/retention.js`. Writing it found one
  gap: a committed import item kept its encrypted text after its client was purged, and nothing deleted it (fixed
  in 1.17.0, *Privacy* above).
- **The security questionnaire was checked against 1.16.4.**
  - Every answer cites its file or test, and owner items are marked.
  - New answers #46–#50 cover the SBOM, the threat model and data flows, vulnerability disclosure, support, and
    accessibility.
  - Corrected: the commit count (480 of 512 AI-assisted), the incident register's location, and the fact that
    there is no `LICENSE` file yet.
- **An evidence index** (`docs/evidence/README.md`) maps each common county IT review question to its documents,
  tests and CI jobs, and lists what is owner-pending.
- **Support, said once** (`docs/SUPPORT.md`): the programme's administrator, whoever runs the server, the public
  issue tracker and private vulnerability reports.
  - The SLA template's values are now all `[owner to complete: …]`, and the template is marked as an owner template
    that is not in force.
  - The IT buyer guide, the scorecard and the RFI boilerplate were brought in line.
- SDLC.md and VULNERABILITY-MANAGEMENT.md describe the current release flow and the SBOM. HIPAA.md's summary table
  points to the inventory, and no longer calls visit summaries and time and spending descriptions plaintext. The
  pen-test scope adds the 1.16.3–1.16.4 classes.
- **Go-to-market strategy for 1.17.0** (`docs/market/`). New: `STRATEGY.md` (the owner's strategy: segments, the
  create / capture / defend wedges, sequencing with the AI documentation copilot first, the forward-deployed
  (FDE) delivery model, built vs planned stated exactly, risks and metrics), `PRICING-OPTIONS.md` (pricing models
  for the owner to decide, with a worksheet; nothing decided, no competitor prices) and `DATA-NETWORK.md` (the
  de-identified outcomes dataset and the referral network as a design, not built, with the HIPAA §164.514, 42 CFR
  Part 2 §2.52–§2.54 and California analysis and what counsel must review). Positioning now leads with the Part 2
  layer beside the EHR, field-ready outreach and funder outcomes (`POSITIONING.md`, the pack's `README.md`, the
  top-level README); `PILOT-KIT.md` adds a county pilot delivered with the FDE service; the buyer guides, the
  pricing hypothesis and `docs/PLATFORM.md` say what is planned and what is built but not yet released (the copilot, *AI documentation copilot*
  above, is office-server only). The CalOMS extract is described as checked by SUDS's own edits and still to be verified
  against the DHCS data dictionary; SUDS does not submit to DHCS.
- **Pre-release corrections (market review of the 1.17.0 candidate).**
  - Secure referral links: `docs/market/DATA-NETWORK.md` says what was built (the client's name and reason behind a
    six-digit code, no account, a first-browser claim) and why it departs from the sign-in design, and that counsel
    reviews it before a programme switches it on; REFERRAL-LINKS.md and DEPLOYMENT.md say the office server must
    then be reachable from the internet; PILOT-KIT and the pack's README no longer call the links "not built".
  - The Part 2 layer's scope: POSITIONING and `docs/integration/EHR-PART2-LAYER.md` say SUDS gates and accounts only
    the disclosures made through SUDS, and that disclosures the EHR makes are recorded by hand (Consents tab →
    *+ Disclosure*, `POST /api/clients/:id/disclosures`); the unsourced claim about what EHRs lack is softened.
  - `STRATEGY.md` brought up to date: what is built for 1.17.0 under Create 1–3 and Capture 4–6, the refusal band
    1.17.0 leaves, the sequencing steps, and a risk table that is now true (counseling notes excluded); the pack's
    README (rules, the Finance row, the counsel rows), EVALUATION-RESPONSE's status line and the top-level README's
    profiles likewise.
  - One phrase for an unreleased feature, "built for X.Y.Z, not yet released", and `test/release-wording.test.js`,
    which fails once the version is stamped while a document still says so (added to docs/RELEASE.md's stamp
    checklist).

### Publication

Programmes with roughly 90 to 340 overdose events a year were refused a publication release whole (1.16.2 to
1.16.4), because the check of each month's overdose events not reversed failed at a cost the audit's budget could not
meet. No migration; no new permission or route.

- **The overdose events by month are no longer part of a publication release** (a choice of method, the same for
  every period and programme, made before any figure is read, so leaving them out says nothing about anyone). A
  release prints the period's events, reversals, fatal and community-reported totals, the reversals by month (the
  funder report's months and the NDP log's, one table) and the doses; the programme's own submission to its funder
  still has the events by month. The page, the release (`release.not_published`) and the funder report's About sheet
  say so. Why it is sound: without them a reader knows only that the reversals are at most the events, which the
  audit now states; each month's events not reversed can be anything up to the period's, which the audit already
  protects, and the algorithm-aware attacker checks every month's true events and events not reversed as hidden
  counts (docs/architecture/ADR-0009, *Events by month: not published*, with the options weighed: events by quarter
  still refused the benchmark year, a data-dependent choice is the 1.16.1 case, a reserved degrade budget cannot
  pay for the validation). Measured at the default threshold on the same programmes: the benchmark's 2,000-client
  year publishes in 0.25 million units of work (1.16.4 refused it after 400 million, about 9 s); 4 of 114 scaled
  fiscal years are refused (1.16.4: 34), none of 18 seeded years (6) and 11 of their 72 quarters (28). Not every
  period gains: 3 quarters that 1.16.4 published are refused now, among them the benchmark's last; what is still
  refused is small overdose counts beside small reversals by month, and tiny programmes at small thresholds are
  often refused as before (docs/PERFORMANCE.md, *Which programmes are refused*). The two thorough sweeps run in about
  1 and 3 minutes instead of 6 to 20 and 4 to 9. Of 300 tiny random programmes (1 to 12 people, T = 3 to 5), 182 are
  refused (212). **Do not publish again a period published under 1.16.x**: the two
  releases hide differently and can be set side by side (docs/HIPAA.md, *Across releases*).
- **The check steps over one value** (`server/sdc.js`): a suppressed count's range, stepped outward from its value,
  no longer stops at a single value no world that prints the release has (a month's reversals printed exactly when
  the other months' small reversals add up to the threshold), which refused quarters whose count ranged widely on
  both sides of it. It steps over **at most one value per count**, so a count that passes stands behind at least
  ceil(T/2) values that worlds printing the release show, one fewer than without the step (below, *Engineering*).
  The rule (the span of the values) is unchanged, and every value counted is still shown by a world found and run.
- **The audit log records what a release withheld, and why a release was refused.** Every report of a publication
  release (`report.funder`, `report.naloxone_ndp`, `report.opioid_settlement` and their exports) records the
  release's id and each withheld table with its reason code (`withheld: [{table, reason}]`, `protect` or `check`);
  a refused release writes `report.publication.refused` (not a success) with why (`budget`, `backstop`, `headline`
  or `unprotected`), how many counts the check could not show protected, the tables it had withheld and the
  audit's work. Table names and codes only, never a count of people; the person is still told why in words
  (`test/publication-audit-log.test.js`).
- **On a device the audit runs in a Web Worker**, off the page's thread (engineering reviews of 1.13.0 to 1.16.3:
  it ran on the page for up to the 60-second backstop and could hold a phone). The worker is a second generated
  bundle, `public/local/audit-worker.js` (built by `npm run build:local` beside the kernel, with its `.gz` and `.br`,
  precached by the service worker under the kernel's version); `local/audit-runner.js` starts one long-lived worker,
  refuses an audit it stops answering within 75 s and stops it, and where no worker can start (no Web Workers, the
  script does not load or does not start within 10 s) the audit runs on the page as before. The same code and budget
  either way, so a device's release is the office's (`test/device-audit-worker.test.js` runs the committed worker
  as a browser does).
- The degrade fixture is a new one (`test/fixtures/degraded-release.json`: 11 people at T = 4, the funding-source
  table withheld); 1.16.4's, degraded to the reversals total, is refused now (its degraded release could not be checked).
  The attacker's families gain three with months (three months; reversed, fatal and neither events with community
  reports; one or two doses a reversal), and every family with months checks the months' events and events not
  reversed. The attacker found no leak at T = 3, 5 and 11 in the existing families or the new ones (at T = 11, two
  months with 24 events, every split of events and reversals); a first run of the new outcome family, enumerated only
  two events past the sizes it checked, reported a suppressed total of 3 or 4 whose worlds, run further, include 6:
  a false alarm. The attacker is monotone (more worlds only widen what it holds possible), so a family enumerated
  too short can only raise false alarms, never hide a leak; the families are enumerated a few past, and a reported
  leak is enumerated further before it is acted on (docs/architecture/ADR-0009, *Known limits*).
  The month families run in a file of their own (`test/publication-release-months.test.js`, in `SDC_SWEEPS`) beside
  the others; `node scripts/test-thorough.js --part sdc` took 9.6 minutes on CI (the months file 5 minutes), inside
  the thorough-sdc job's 60 (about 27 minutes on a loaded 4-core development container).

### Frontline

Fixes from the frontline-UX review of the 1.17.0 candidate (round 10). No migration and no new permission or route;
the revert route takes an optional `fields`, the Notes list returns `ai_assisted`, and the referral-link open route
refuses a code that is not six digits without counting it.

- **No "null" on screen (H1).** *My shift* showed "nullnull" at the start of every shift, every AI copilot panel and
  the care plan suggestions showed "null", and so did the Secure link dialog: the DOM's own `append()` and
  `replaceChildren()` write a null as text, where `h()` leaves it out. Those calls (and the same shape in the
  signature check, the role baseline and the recovery drill card) now go through `h()` or `.filter(Boolean)`.
  `test/no-null-append.test.js` finds that shape in the browser code, and `STRAY_TEXT_PROBE` in `scripts/ui/assert.mjs`
  checks every page and dialog the accessibility audit and the r10 scripts open for "null", "undefined", NaN or
  "[object Object]" shown as text or in a name.
- **An AI draft never replaces what the clinician wrote without asking (H2).** An empty section is filled. When
  sections already hold the clinician's words, the panel asks, naming them (*You have already written in S
  (Subjective) and P (Plan). Keep what you wrote?*): **Keep mine, add the draft below it** (the default, where the
  focus lands), **Keep mine, fill only the empty ones**, **Replace what I wrote** or **Cancel**, which leaves the note
  as it was. The banner's **Undo: take the draft out** puts every section back. The six-dimension assessment follows the
  same rule for each dimension's notes.
- **Street outreach is logged where it happens (M1).** *Where* starts at Street (or the field, or the first place that
  is not the office), not the program's office default, and is asked right after *Contact*, before the supplies. The
  place is remembered as soon as it is chosen, not only after the first save.
- **Nothing covers the counters on a phone (M2).** The floating **+ Log** button is not shown on Street outreach (the
  screen is the logger), and **Start a new shift** is a 48 px target.
- **The AI copilot is out of sight while it is off (M3).** With no agreement recorded, the copilot switched off, or no
  provider configured, no panel is shown on the note, assessment or CalOMS forms and there is no **Suggest with AI** on
  the care plan; the administrator's Settings › AI copilot says staff see nothing of it until it is on. A monthly
  limit reached still says so in the panel; a cap of 0 reads *The AI copilot is paused for this program*.
- **Care plan suggestions are the clinician's before they are added (M4).** Each problem, goal and step is in a box to
  edit. **Add** waits, and says why beside it, while the text still holds *[needs clinician input…]*; a goal is added to
  a problem (the suggestion's own once it is added, or one already on the list: **The goal addresses**), and a step to
  its goal. The banner reads *AI suggestions — review before adding*.
- **No Secure link on a declined or closed referral (M5).** A referral the client or the provider declined, or one that
  is closed, has no **Secure link** button.
- **CalOMS provider IDs as rows (M6).** State reporting › Settings has a row of fields per provider — Provider ID, site
  or program name, legal name, NPI — with **+ Add a provider** and **Remove this provider**, in place of one line of
  "ID, name | legal name | NPI". A problem names the provider and what was typed (*Provider 2: 1234567890 is not a
  valid NPI (its check digit does not match)*), on that row, with the focus on the field; never *providers.0.npi*.
- **Focus follows the draft (M7).** **Draft** is no longer disabled while it works (which dropped the focus to the
  page); the focus moves to the draft's banner once the draft is in, on the note, the assessment, the care plan
  suggestions and the CalOMS suggestions.
- **Lows.** One review step for an AI-assisted note: the banner's **I have reviewed the draft** button (which did
  nothing) is gone; the statement ticked when signing is the review, and its message starts with a capital (L1). The
  Notes list and a client's Notes tab mark each **AI-assisted** note (L2). A put-back blocked by a later change names
  the field whether or not the History was opened before that change (*Phone has been changed again since, so it
  cannot be put back… City can still be put back on its own*), and offers **Put back that field** for the others (L3).
  The help under *What kind of program is this?* follows the choice before saving (L4). CalOMS says *1 client*, *12
  fatal errors*, *2 files* (not "(s)"), gives the problems' dates as the page does (*May 2, 2026*), shows an upload's
  log entry as *Uploaded on Sep 29, 2026 · DHCS reference BATCH-42*, and the produce dialog says how many records with
  fatal errors are held back and left out of the file (L5). The referral recipient page shows dates without seconds
  and the urgency in words (*Routine*); a code that is not six digits is caught in the browser, never sent, and the
  server refuses one without using up a try; the field takes 7 characters, not 12 (L6). The outreach toast and My shift
  say *2 Naloxone kits*, *1 Naloxone kit*, and the stat is *Fentanyl test strips*; the participant code's help says
  spaces and dashes are dropped (L7). Settlement outcomes' Counts choice fits a phone (*Hide small counts (as
  reported)*, *Exact counts (not for sharing)*) (L8). US spelling on the 1.17.0 screens: the AI settings and their
  messages say *program* and *organization*, Settlement outcomes *Uncategorized* (L9). The AI cap's help says *resets
  on the 1st of each month*, without "UTC" (L10). Saving a new assessment says *Assessment saved* (L11).
- **Browser checks:** r10-outreach, r10-ai, r10-part2, r10-hist, r10-lp and r10-prev check every page and dialog they
  open for stray "null" text, and each fix above; caloms fills the provider rows.
- **Not in this release:** the Settlement outcomes page's by-month cards and the message when the only fund is
  uncategorized (L8), "Check and prepare" on a part month (L5), and a divider line between the clinician's text and a
  draft added below it.

## 1.16.4 — 2026-09-29

### Security

Fixes from the security review of 1.16.3 (r9), and two findings of its UX review that are access rules. No migration,
no new permission, no new route.

- **A flagged SUD counseling note leaves a shared device (N1).** When the office tells a device to remove a note that
  became a SUD counseling note after the device pulled it, the device kept it whenever another account signed in
  there "may read it", judged against the device's own pre-flag copy, which every navigator may read: on a device two
  navigators share it stayed, unflagged, for good. The office now sends what makes the note unreadable
  (`counseling_note`, `author_id`, `cosigned_by`) with the instruction; the device marks its copy first and judges
  the other accounts against that. A device only navigators use removes it; one a clinician, the author or the
  co-signer also signs in to keeps it, hidden from everyone else there. Another account's permissions on the device
  are those the device last received for it: its role and active state as of anyone's last sync, its own grants and
  denies as of its own last sync there (so a counseling permission taken away at the office counts on that device
  once that person syncs again there, or their account is deactivated).
- **Standing on a case cannot be regained by sync (N2).** A worker without `assignments:manage` could push their own
  primary assignment on any client they had ever created, at any time: a worker a supervisor had taken off the case
  put themselves back on it (and, held to their caseload, regained the record), then discharged the client. The
  exception is now only for a client the same push creates (offline intake). A push's re-admission restored every
  assignment its discharge had ended even when the re-admission itself was refused or only flagged: the care team a
  discharge ends or a re-admission restores is now judged by the episode change that landed (those assignment rows
  wait for it), a re-admission while another episode is open is refused, as `POST /api/episodes/:id/reopen` refuses
  it, and a re-admission that leaves nobody on the team gives the worker who made it the case, as that route does.
  Every assignment a push creates, ends or restores is audited (`assignment.create`, `.end`, `.restore`,
  `via: sync`), and restoring an ended assignment needs the same reach as adding one.
- **Another worker's to-dos are closed by push only by a discharge (N3).** Any worker's device could mark any other
  worker's to-do done or cancelled (REST refused it): now only as part of a discharge of that to-do's client that
  landed in the same push, by the client's care team or a manager; a to-do with no client, never.
- **One open episode, counting only closes that land (N4).** A push that "closed" the open episode (refused) and
  opened a second one (accepted, because the close was counted) left two open, the second from someone off the
  team. Closes are applied first and only those that landed count. A new episode pushed already closed with past
  dates (an admission and discharge reports would count) is the care team's or a manager's.
- **The 1.16.1 notice rule is gone (N5).** A to-do reading "Reference: client record change by <user id>", followed by
  an edit of the client by that user within a minute (or, by push, backdated to one), was taken for a 1.16.1 change
  notice, a card naming whoever its title named. Without a migration to link the 1.16.1 notices to their audit
  entries, such a to-do is now an ordinary to-do (its assignee and its creator may change it). A notice's card names
  who made the change from the audit entry that raised it (`notice_by`), never from its title.
- **A paged pull names a flagged note on the page that carries it (N6).** Only a note flagged after the page's own
  start was named, so one flagged early in a pull of several pages and edited later stayed on the device. The pull
  cursor now carries where the pull started (`~from.`), until the pull completes.
- **Change notices (UX review of 1.16.3, M1 and M2).** Only the worker a notice was sent to marks it seen, at both
  doors; a supervisor may delete one (for a worker who has left) but no longer mark it seen for them. A notice pulled
  to a device is a notice there too: each pull names the notices among its to-dos, with whose edit each reports
  (`notices`), and the device takes the office's word for those rows only (never a to-do's text).
- **Smaller fixes (N7).** A flag found by the note's id whatever client its audit entry names. A device to-do that
  merely contains the notice line is stored as an ordinary to-do instead of being dropped without a word (only a
  device's own copy of a notice, which the office raises itself, is not taken). A new note's creation time from a
  device is never after the office's now (a future one hid the note from a later flag's removal). A desktop or
  lock-screen notification of a change notice names the client by code, never by name. The two-step enrolment link
  falls back to "SUDS" as its issuer when a programme name in a non-Latin script cannot be shortened to fit the QR
  code.

### Engineering

Fixes to the release process from the engineering review of 1.16.3. No migration, no new permission, no new route.

- **A GitHub Release someone else made for the owner's tag is refused (H1).** Anyone with write access can create
  a GitHub Release for an existing tag (no ruleset covers Releases), and until now the release job, finding a zip
  and checksum already attached, replaced nothing and went green, so a collaborator's zip could have been the
  release, for good once releases are immutable. `scripts/release-existing.js` (main's copy) now checks any Release
  that exists for the tag in the gate, before the owner is asked to approve, again in the release job, and once
  more after publishing: it must be made by `github-actions[bot]`, carry only the zip and its checksum, and each file
  it carries must be byte for byte the one built from the tag (`git archive` is reproducible). A draft the workflow
  itself left behind is published once checked (L1); any other is refused. A refusal says how to recover: delete
  that Release, keeping the tag, and run the release again, or release the next patch if it is immutable.
- **npm runs where there is nothing to steal (M5).** `release.yml` is three jobs: the gate; `verify`, which runs
  `npm ci`, the tests and the kernel drift check with a read-only token and no environment; and `release`, after
  the owner's approval, the only job with a write token, which runs no npm and none of the released commit's code.
  It builds the zip with `git archive` itself, and the policy exception's paragraph for the notes now comes from the
  gate. `ci.yml` runs with a read-only token (L4).
- **The published web app is checked against the tag (M2).** `web-app.yml`'s build job packs and uploads the site
  straight after building it, before Playwright and its apt packages run, fails if the kernel it rebuilt differs
  from the committed one, and runs its boot test on a copy unpacked from the archive. The publish job checks the site
  byte for byte against what the tag's own `public/` builds to (`scripts/release-site-check.js`, which loads no npm
  package: `build-static-site.js`'s page, service-worker and boot-script steps are now `stageShell()`, which it
  reuses); only the provider pictures, which only a download can make, are allowed besides, as JPEG, PNG or WebP
  files and a manifest.
- **The deploy key has a new name (M1).** It is `PAGES_PUBLISH_KEY`: the `v1.16.2` copy of `web-app.yml` read
  `PAGES_DEPLOY_KEY` in a job that also runs npm and Playwright, so approving a run on that tag would have handed
  it over. Each tag's web-app runs now queue on their own, so a run on another tag can no longer displace the real
  publish waiting for approval. The key file is removed however the step ends (L3).
- **Owner settings and hand-over (M4, L2).** docs/RELEASE.md: *Prevent self-review* stays off while the owner is the
  only reviewer (it made every release impossible to approve), with the trade-off explained; step 6 uses the new
  secret name and checks `v1.16.2` as well as `v1.16.0`; step 5's check includes the release's author; *Owner control*
  says what write access can still do. *Handing a release to the owner* gives the exact commands, tagging an
  explicit SHA after checking its CI, and says plainly that the maintaining assistant cannot push tags, so security
  releases wait for the owner until a backup releaser is named. A CHANGELOG date is the stamp's date; the release
  date is the tag's. HANDOFF.md has a *Release waiting* note: 1.16.3 at `fc5e9d7` awaits the owner's tag.

- **Quarters are measured (`test/thorough/refusal-quarters.test.js`, CI's `thorough-sdc` job).** 18 programmes
  seeded as the benchmark's is (1,100 to 2,600 clients, three seeds each); each fiscal year and each quarter is read
  as a publication release reads it, every table for that period, and audited. Every refusal is checked to be whole
  (nothing printed) with its own period's message; published releases withhold only by the check. The counts are
  recorded, not pinned. About 4 minutes.
- **The fiscal-year sweep (`test/thorough/refusal-band.test.js`) adds the 1.16.3 review's runs** (events and
  reversals moved independently by up to 3 or 4; 114 years, 34 refused), accepts a refusal for a failed check as
  well as for budget, still requires every refusal to be whole, and no longer fails when refusals leave a band.

### Documentation

- **A refused quarter no longer sends the person back to the year (market review of 1.16.3, finding 1).** A refused
  year's message offered its quarters, and a refused quarter's said "publish a longer standard period (a year)":
  year, quarters, year. Each now has its own step. A year's says its quarters *may be tried*, each checked on its
  own and possibly refused too, never beside the year. A quarter's says its year may be tried once it has ended,
  unless the year was refused too or another quarter of it is already published; otherwise the quarter cannot be
  published in this version. Both now say whom to tell: whoever supports the programme's SUDS (IT partner or
  county), or, for a programme with no one, the SUDS issue tracker (the period and the message only, never a
  client's details). The funder submission is unaffected, as before. The `protectFigures` docstring names all four
  ways a release is refused (headline, budget, backstop, and a release that fails its check with tables withheld).
- **No refusal band is quoted any more (engineering review of 1.16.3, M3).** 1.16.2 and 1.16.3 said a fiscal year
  with about 110 to 240 overdose events can be refused, and everything outside publishes. With each month's events
  and reversals moved independently, the review found refusals at 87 to 99 events (budget) and 301 to 341 (a
  failed check). PERFORMANCE.md, ADR-0009, HIPAA.md, the user guide and the buyer pack now say refusals were seen
  from under 100 to over 300 events in sampled programmes, that no size is guaranteed to publish, and that a
  refusal is always whole and safe.
- **"Quarters can be published instead" is replaced by what was measured.** Of 18 seeded programmes, 6 years and 28
  of 72 quarters were refused, and every refused year had at least one quarter refused too (PERFORMANCE.md, *Which
  programmes are refused*). BUYER-GUIDE-PROGRAM, BUYER-GUIDE-IT, the market scorecard and security questionnaire
  #16 now say quarters may be tried and are no sure way round. BUYER-GUIDE-PROGRAM also says a programme's own
  overdose events decide it, not its client count: a syringe services programme with many overdoses can be
  refused with far fewer clients.
- Questionnaire #37 points at the owner's CodeQL setting (RELEASE.md, step 8), not yet turned on. A CodeQL
  workflow was not added: uploading results needs a write-scoped token, and the owner's default setup needs no
  workflow at all.
- EVALUATION-RESPONSE's status line says "through 1.16.3" and no longer points at an *Unreleased* section.

### Frontline

Fixes from the frontline-UX review of 1.16.3. No migration, no new permission, no new route.

- **Only the person told marks a change notice seen (M2).** The notice card offers **Mark as seen** only to the primary
  worker it was sent to. Anyone else who opens it (a supervisor, the editor) sees *A change to a client's record*,
  **Sent to** *David Chen* and *Not seen yet by David Chen*, and no button; "your client" is said only to the one told. In
  the to-do list, a notice sent to someone else has no box to tick it off with. (The server enforces the same rule:
  see Security.)
- **The 2-step bar goes as soon as 2-step verification is on (M3).** It, and the header's **🔐 2-step** link, stayed until
  a reload, still saying access would end. My profile, the set-up dialog and the sign-in step now say *2-step
  verification*: **Set up 2-step verification**, **Turn on 2-step**, *2-step verification is on*, **Turn off 2-step**
  (the API names are unchanged).
- **Discharging from off the care team says what it does (M4).** Before submit, someone not on the client's care team is
  told that closing the episode ends only their own part and that the client stays open with the care team, by name.
  Afterwards a one-button dialog, *Episode closed — client stays open*, says who is still on the care team; the toast
  says *Episode closed*, and no discharge toast lists "0 assignment(s) ended, 0 to-do(s) closed" any more (only the
  counts that are not zero). The loose-ends dialog after an ordinary discharge has one button too.
- **Lows.** The timeline names a notice's editor once (L1). *· N changes to review* on the Open to-dos tile is shown only
  to the primary worker (L2). Cancelling the signature after **Save & sign** says the note is saved as a draft (L3). A
  table wider than its card says so above it, in words (every table in the frame, not only Reports), and the Outcome
  measures headings are shorter (L4). On a phone, Notes' **Import** is under **More** and the counseling-notes line is
  one line, so the first note is higher (L5). *Your first day* is not shown to someone who logged a visit or wrote a note
  before today (L6). Finance's Supervision page describes staff time, not countersignatures (L7).
- **Browser checks:** `scripts/ui/r9.mjs` (in the suite, now 44 scripts); r8, ux13 and signup follow the new wording.
- **Not in this release:** telling the primary worker when someone off the care team closes the client's only open
  episode, or reactivates a closed client by starting one (M4's last point, L8).

## 1.16.3 — 2026-09-29

### Engineering

Fixes from the engineering review of 1.16.2. No migration, no new permission, no new route.

- **One way to release, and the owner's settings fit it (M1).** 1.16.0 to 1.16.2 were released by *Run workflow* on
  a `release/v*` branch, and the workflow created the tag itself with the workflow token. The settings guide in
  docs/RELEASE.md then limited the `release` environment to `main` and `v*` tags, and let only the owner create
  `v*` tags: applied as written, the next release would have stopped after its approval. Now a release is always
  a `v*` tag the owner pushes at the version-stamp commit on `main` once its CI is green; the release workflow
  refuses a run on anything but a `v*` tag (its gate's first step), never creates a tag (`gh release create
  --verify-tag`), and checks the tag against `package.json` on every run. *Run workflow* only re-runs an existing
  tag (a retry, or with `policy_exception`). The guide limits the environment to `v*` tags only, no `release/v*`
  branch is made any more (a tag serves the same zip; *Release tags*), and *Cutting a release* says so.
- **The gh-pages deploy key is read only by a job that runs no third-party code (M2).** `web-app.yml` is two jobs:
  `build` (no environment, no secret, a read-only token) runs `npm ci`, Playwright and its apt packages and builds
  and checks the site; `publish` (the `release` environment) checks out nothing and installs nothing, takes the
  site as an artifact (GitHub's own `actions/upload-artifact` and `actions/download-artifact`, pinned to a commit:
  the only actions any workflow uses), checks its checksum and that it holds only files and directories (no link,
  no `.git`, no parent or absolute path), commits it with git's global and system configuration and hooks off, and
  pushes it with `PAGES_DEPLOY_KEY`. The run summary names the credential that pushed (the key, with its
  fingerprint, or the workflow token), and without the key a guarded `gh-pages` fails with a message saying what
  to add, not an opaque `GH013`. The guide now does the `main` and `v*` rulesets before the key (a write deploy key
  can push every ref no ruleset guards), and says the rulesets' *Deploy keys* bypass admits every write deploy key,
  so this must be the only one.
- **Immutable releases (M3).** A new settings step turns on GitHub's release immutability, which stops anyone
  replacing a published zip or checksum: every tag from v1.1.0 to v1.15.4 carries a `release.yml` whose *Run
  workflow* rebuilt the zip and uploaded it over the published one (`--clobber`), with no approval, and a
  collaborator could edit a release's files by hand. It applies to releases published after it is on; the guide
  says how to record the older releases' checksums.
- **The fiscal-year refusal band, corrected and tested (M4).** 1.16.2 said a year was refused with 126 to 237
  overdose events and published with 125 or fewer; the reviewer's runs refused 125, 123 and 113. It is **about 110
  to 240** (sampled; not a guarantee). `test/thorough/refusal-band.test.js` (CI's `thorough-sdc`) runs 84 scaled
  programmes: 23 refused, with 113 to 237 events; it checks that every refusal publishes nothing and every
  published release withheld only by its check, and fails when the band leaves 100 to 260. **Correction to the
  1.16.2 notes** (Engineering, H1, "What changes for a programme"): the band there, 126 to 237 events, is 110 to 240,
  and programmes of 110 to 125 events can be refused too. A refused year's message now says what to do (next
  section).
- **A flake in `npm test` (L1).** `test/release-worker-timeout.test.js` timed its first audit from the post, which
  included starting the worker: under load its 400 ms backstop refused it. The worker is now started before
  anything is timed, and the backstops leave room for the workers the queued audits move to.
- **The fixed-wait lint sees `new Promise(r => setTimeout(r, N))` (L2)**, in the script or in the page. The waits it
  found are replaced by `settle()` (ux13's two 1 s waits and ux-forms' 900 ms: a preference's debounced save counts
  as the page's work) or say why they stay (`// intentional:`: device-audit waiting for the next TOTP step and for a
  later timestamp; local-mode's slowed server and its proof that no second render lands); the allowlist entries
  that remain give their reason.
- **The stamp warning is in the run summary (L4)**, where the person approving the `release` environment sees it,
  not only in the log.
- **Docs drift (L8).** The architecture README's release-governance row and `web-app.yml`'s header describe the tag
  check, the stamp warning, the deploy key and the two jobs.
- **Not in this release:** a scheduled check that the owner's settings are in force (L5); recording the withheld
  tables and the refusal reason in a publication release's audit entry; a sound, affordable check for the overdose
  events by month (1.17.0 work). The owner's settings themselves are still the owner's to make: none is in force
  until then.

### Documentation

- **The fiscal-year refusal band is in the buyer pack (market review of 1.16.2, finding 2).** BUYER-GUIDE-PROGRAM,
  BUYER-GUIDE-IT, the market scorecard and its deferred table, and security questionnaire #16 now say that a whole
  publication release can be refused (not a table withheld), for a fiscal year with about 110 to 240 overdose events,
  and what to do: the exact funder submission is unaffected, and the year's quarters, each checked on its own, can
  be published instead.
- **The refusal message for a year says what to do.** It suggested only telling "whoever supports your SUDS server";
  it now offers the year's four quarters, each once its figures are complete and each checked on its own, warns not
  to publish the year beside them, and keeps the support step for a quarter that is refused too.
- **Finding a 1.16.1 release made under the withdrawn rule (HIPAA.md).** Neither the audit log nor the exported files
  say which tables a release withheld; the page did. HIPAA.md now says how to find one: list the publication releases
  made while 1.16.1 was installed from the audit log, and check each period's exact figures against the rule's
  condition (at least 12*T* overdose events and a month of 1 to *T*−1 events or not reversed); and what to do.
- **A recovery drill on the released 1.16.2** (`docs/evidence/dr-drill-2026-09-29.md`): the development exercise at
  20,000 clients, from the release's own files, passed 11/11 checks (drill RTO 3.8 s, host restore 4 s, RPO 7 s,
  schema 48); still a development exercise, not a production drill.
- EVALUATION-RESPONSE's status line reads "through 1.16.2"; the user guide's heading is "When someone not on the
  care team changes your client's record".

### Frontline

- **Two-step verification can be set up whatever the programme is called.** The enrolment link carries the
  programme's name twice; past about 40 characters it no longer fit the QR code and setup failed ("Data too long for
  QR generator"). The name in the link is now shortened from the end until it fits (`server/crypto.js`).

Fixes from the frontline-UX review of 1.16.2 (round 8). No migration, no new permission, no new route.

- **A change notice reads as what happened, wherever it shows (M1).** In a client's Recent activity it read as a
  to-do by the primary worker, with the text written to them ("You are this client's primary worker…") and its
  reference line, shown to everyone who opened the record. It now reads *"Maria Rivera (not on the care team)
  changed: Phone, Risk level — David Chen was told"*, attributed to the editor (whom the `client.change_notice`
  audit entry names), dated by the change, and opens the notice card. The timeline marks it `notice: true`. The
  Overview's **Open to-dos** tile leaves notices out ("· 1 change to review"), and warns only when a real to-do is
  overdue (`counts.overdue_tasks`).
- **The bell keeps notices apart (M2).** They are listed first under *Changes to your clients*, marked **New**
  (not "today"), and are not in the due count on the badge, which says "new" when a notice is all there is; the
  button's name says both ("9 to-dos due or overdue, 1 change to your clients"). A notice's title names the client
  as the lists do (the name where the reader may see names, else the code), and the card shows the name once
  with the code. On a device the bell asks again right after a sync instead of after its minute's cache.
- **+ Log on a client's record carries the client (M3).** Note, Log a visit, Call, Text, To-do, Make a referral,
  Time and Overdose from the floating + Log (and the top bar's) start with the client whose record is open, as the
  record's own buttons and the `n` shortcut already did; on a phone a note no longer failed "Client is required".
- **The notice card's When is the change (L2),** not the moment it was marked seen.
- **Notes name the client and say they open (L3),** as Visits, Calls and To-dos do (`client_name` on
  `GET /api/notes`, by code alone under break-glass), with an **Open** button on each row.
- **Notes and Referrals are two-line rows on a phone (L4),** as Visits are; a referral's buttons sit under its
  row.
- **Filters fold away on a phone (L5).** Visits, Notes, Referrals and Calls put their filters behind a
  **Filters** button (saying how many are on), so the first rows are on the first screen.
- **The floating + Log no longer sits on the first rows (L6).** With the filters folded, the first rows are above
  it; the page already had room below the last row to scroll it clear (now checked in the browser suite).
- **SOAP, DAP, BIRP, GIRP and safety plans ask for the text once (L7).** The Narrative box, built from the
  sections, folds away under them as *Narrative text (built from the sections)* and is not required; a draft whose
  narrative is still the built one keeps being built from its sections.
- **A clinician's new note starts as Clinical (L8)** (anyone who may write clinical notes).
- **Finance and Read-only are not told that what they add shows up elsewhere (L9).**
- **The development seed's programme is named for its profile (L1):** "County Treatment and Outreach Program"
  beside the treatment profile, not the harm-reduction default name. Behaviour is unchanged.

### Security

Fixes from the security review of 1.16.2. No migration, no new permission, no new route.

- **Opening an episode is not a way to take a client off their care team (M1).** A navigator off the care team
  could open an episode of their own on another worker's client (a second one, by sync, was only flagged), close
  it, and with it end the primary worker's assignment, or over REST discharge the client, cancel every open to-do
  including the change notice, and tell nobody. The opener of an episode may still close it, but ending the rest
  of the care team, cancelling their to-dos and discharging the client are for the care team (an active
  assignment) or `records:manage-others`; the opener's discharge ends only their own assignment and to-dos, and a
  client someone else is still working with stays open (the answer says so). A device's push ends an assignment
  only with a real discharge of an episode the office holds open (one it pushes new, even already closed,
  discharges nobody), and another worker's only for the care team or a manager; a second open episode from
  someone off the care team is refused, as over REST. No discharge, by anyone, cancels a change notice: it is
  the primary worker's to read.
- **A shared device keeps what another account on it may read, and every unsynced edit (M2).** When the office named
  a counseling note in `dropped_rows`, the next account to sync on a shared device deleted it, with a clinician's
  unsynced edit to it; and the office named every counseling note changed since the last pull, not only those that
  had become unreadable. Now the office names only a note flagged as a counseling note since that device's last pull
  and written before it (which also stops it naming counseling notes the device was never sent: L4); a device keeps
  a named row while another account signed in on it may read it, never deletes one with changes not yet sent (it
  says so), and a sync sends only the notes the syncing account may read, leaving a clinician's to them rather than
  having them refused for good under a navigator's account.
- **A signature's time is bounded (L1), and a draft carries no signature (L2).** A note signed by sync keeps the
  device's signing time, but never before the note was written nor after the office's now; a draft pushed with
  `signed_by`, `signed_at` or `signature_hash` stores none of them.
- **A change notice is known by how it was raised, not by its text (L3).** Anyone could write a to-do with the
  notice's wording and have it shown, to the worker it was assigned to, as a system notice naming someone else as
  the editor. A to-do is a notice only when the `client.change_notice` audit entry of the edit it reports names it
  and the worker it told (a notice raised by 1.16.1: the entry of its editor's edit, telling that worker about that
  client as it was written). The web app trusts only the API's `notice: true`, no longer the text. A device's own
  copy of a notice is not taken by the office, which raises its own when the edit arrives; on a device, a notice
  pulled from the office reads as an ordinary to-do.

## 1.16.2 — 2026-09-29

### Security

Fixes from the security review of 1.16.1. No migration, no new permission, no new route.

- **Nobody signs a note in someone else's name by sync (H1).** A push from a supervisor or administrator
  (`records:manage-others`) could create a note already signed in a clinician's name, or take a clinician's draft,
  rewrite it and push it back signed by them; the only trace was a `sync.overwrite`. A note's author is now the
  account that syncs it, as over REST (`records:manage-others` does not let anyone author as someone else), a
  signature arriving by sync is refused unless that account wrote the note and is signing it themselves, and the
  office works the signature hash out itself (a device's value is ignored) and audits it as `note.sign` (`via:
  sync`). Countersignatures were already never taken from a device; addenda keep their syncing author.
- **Separation of duties sees what a visit or call does (M1).** An approver could record a costed visit, or a visit
  or call that logs time, in another worker's name, add a cost to a colleague's visit, resize a colleague's
  submitted time by editing the visit, or submit a colleague's time for them, and then approve the expenditure or
  time that resulted. The expenditure and time entry a visit or call records or changes are now audited as the
  caller's (`expenditure.create`/`.update`, `time_entry.create`/`.update`), and submitting someone else's time
  counts as changing it, so the approval routes refuse them as they refuse an entry one recorded directly. The
  same writes from a device were already counted (`sync.record`, `sync.overwrite`).
- **The change notice cannot be silenced by the editor it reports on (M2).** The to-do that tells a client's
  primary worker that someone off the care team changed the record was recorded as the editor's, so the editor
  could close, retitle or delete it before it was seen. It is now the primary worker's own, and a change notice,
  including one raised by 1.16.1, is changed, closed or deleted only by its assignee or `records:manage-others`,
  over REST and by sync alike (a care-team member's discharge still closes it). Its text no longer carries a user
  id (a fixed reference line marks it; which editor it reports on is read from the `client.change_notice` audit
  entry, which now names the to-do), names the fields by the client form's labels ("ASAM level of care"), still
  never their values, and it has no due date: it is not overdue work in the bell, the check-in list, the
  supervisor's overdue count or `?overdue=1`. The bell lists open notices first (`notice: true`, and a `notices`
  count); every to-do the API returns says `notice: true` when it is one, and a client's `counts.notices` says how
  many of its open to-dos are notices. A notice raised by 1.16.1 keeps the due date it was given.
- **A note flagged as a SUD counseling note leaves the devices that may no longer read it (M3).** A clinical draft a
  navigator's device had pulled, then flagged as a counseling note, stayed on that device as it was. The next pull
  now names it, and its addenda, in `dropped_rows`; unflagged, it and its addenda come back.
- **A client's note count leaves out counseling notes its reader cannot read.** The Notes tab said 5 where the
  list, rightly, showed 4, which also told a navigator that a counseling note existed; the count now follows the
  list's rule.
- **Lows.** A supply line's worker is its visit's and is no longer a column a device may send (it was already set
  from the visit). The care plan's count of notes per problem leaves out counseling notes its reader cannot read.

### Frontline

Fixes from the frontline-UX review of 1.16.1 (round 7). No migration, no new permission, no new route.

- **A client-change notice is something to read (H2, M2).** The to-do the primary worker gets when someone off the
  care team changes their client's record opened as the full Edit to-do form, with a reference line holding a user
  id. It now opens as a card: who changed which fields (by the client form's labels), when, **View client** and
  **Mark as seen**, and that SUDS keeps which fields changed, not their earlier values. The to-do list shows
  *View change* instead of Edit and Delete, and never shows a notice as overdue. The bell's link opens the same card.
  Notices are recognised by one function (`changeNotice()` in `public/views/tasks.js`), from the task's `notice` flag
  (the text of a notice from an older server as a fallback); **Mark as seen** is offered only to the person it was sent to
  and to supervisors and administrators. The client **Edit** form
  tells someone off the care team that the primary worker will be told which fields they change.
- **Visits on a phone are two-line rows (M3)**, as Calls and To-dos are: who and what, then when, what was handed
  out and by whom. A row opens the visit.
- **Referrals fit a 1280 px window (M4).** Urgency, the appointment and the barrier sit under the status; the
  action buttons no longer end past the right-hand edge.
- **An anonymous visit says "Anonymous" (M5).** A naloxone distribution with no client was drawn as an empty link to
  `#/client/null` (an accessibility failure) and an empty Client row on a phone. The accessibility audit now logs one
  before it checks Visits.
- **A colleague's referral says what you can do (M6):** *"You can record the outcome; only David Chen or a supervisor
  can change the referral"*, not "view only" beside a working **Record outcome** button.
- **Smaller fixes.** The role select lists roles by name, and the chosen role's whole summary shows under it (it was
  cut off in the closed select); *My hours logged* is under *Your own work*, not among the program's tiles; Visits
  name the client (name and code, where the person may see names) as Calls and To-dos do; a new visit, when this
  browser has none remembered, starts at the programme's default location (the street for a harm-reduction
  programme), as before; a row whose Worker column names its owner says only *View only*; a supervisor editing a colleague's
  overdose event is told whose it is; no permission is labelled "(all)" (*Care plans (read, add, change own)*, and
  what the others allow); the Home welcome tips leave out what the person cannot do (Finance and Read-only log
  nothing and open no client record); New to-do does not offer Finance or Read-only accounts as assignees; the
  two-step verification reminder is one short line on a phone, still saying by when.

### Documentation

- The user guide no longer says navigators read SUD counseling notes (they have not since 1.16.1); the README's
  role table says the same. The client record keeps which fields were changed, not their earlier values: said in the
  user guide, POSITIONING, both buyer guides and the security questionnaire (#22), with revision history planned.
- A change notice is sent when the editor is not on the client's care team (POSITIONING and the buyer guides said
  "someone else").
- INSTALL's *Working offline* agrees with the wizard and Step 4: recommended for harm-reduction outreach, not for a
  treatment-adjacent programme without a field-work need.
- "Prevention" is qualified in the README and the RFI solution summary (prevention-funded outreach; SABG
  primary-prevention reporting is not supported), the README no longer speaks of a supply cupboard, and "built to
  the 42 CFR Part 2 standard" now reads "built to support 42 CFR Part 2".
- The pen-test scope lists the classes fixed in 1.16.1 and 1.16.2 for a tester to confirm: stored-file serving, sync
  attribution and column smuggling, separation of duties, SUD counseling-note access, note signatures via sync and
  client-change notices.
- The browser suite is 42 scripts (`scripts/ui/r7.mjs`).

### Engineering

Fixes from the engineering and release-process review of 1.16.1. No migration, no new permission, no new route.

- **1.16.1's published withholding rule is withdrawn: it leaked (H1).** 1.16.1 withheld the overdose events by
  month from the start, in a period of at least 12T overdose events with a month of 1 to T-1 events or not
  reversed, and its check counted every world that printed the same through the suppression and for which the rule
  decided the same, including worlds whose own release was refused. The project's own algorithm-aware attacker,
  run by the reviewer at the rule's gate (T = 3, two months, 36 events, every split: 9,139 worlds), found 6
  printouts that told it a month's events not reversed were not 1. Validating each such world by its own release,
  as the degrade step does, cost more than the budget wherever the rule fired (the benchmark's 2,000-client year:
  55 worlds at about 72 million units each), and one level of it still leaked in the suite's smallest two-month
  family with the gate lowered. So there is no published rule: `server/sdc.js` `protect` is 1.16.0's again, and
  the same attacker finds 0 leaks in all 4,883 printouts of the reviewer's family that print the 36 events
  (`test/publication-release.test.js`; the part with 0 to 2 and 32 reversals in the thorough run).
  **What changes for a programme:** a year like the benchmark's 2,000-client one is refused whole again, as in
  1.16.0 (refusal publishes nothing, so it is safe; the submission to the funder is unaffected). On scaled copies
  of that year at T = 11, 17 of 60 were refused, all with 126 to 237 overdose events in the year; more budget does
  not help, so there is no degrade-round budget floor (M1; docs/PERFORMANCE.md, *Which programmes are refused*).
  **A 1.16.1 publication release whose overdose events by month were withheld by that rule is unverified**
  (docs/HIPAA.md). ADR-0009, PERFORMANCE.md and HIPAA.md say what is actually guaranteed.
- **Release gate (M2, M3, L7).** The notes step runs the policy script from the same `main` commit the gate ran
  (a job output), not `main`'s tip at publish time; a pushed tag that is not `v<package.json version>` is refused by
  the gate, before the approval; the gate warns when the released commit is not the version-stamp commit.
  docs/RELEASE.md now says exactly what running `main`'s copy of the gate guarantees and what it does not (the
  workflow file at the released ref decides, the policy runs the released tree's server code, a loosening merged
  to `main` governs its own release), that there is no backport path yet (with a proposal), and that the released
  commit must be the version-stamp commit.
- **Pages publishing and repository settings (H2).** Refs made before 1.16.1 carry a `web-app.yml` that publishes
  to the public URL with no approval. `web-app.yml` now pushes `gh-pages` with a deploy key held as a secret of the
  `release` environment when there is one, and docs/RELEASE.md, *Owner: repository settings*, gives the owner the
  exact steps: the `release` environment's reviewer and refs, branch protection on `main`, a `v*` tag ruleset, a
  read-only default token, a `gh-pages` ruleset that admits only that key, stale branches, and CodeQL (optional).
  None of it is in force until the owner makes those settings.
- **Tests (L1, L2, L4).** The device-recovery test counts only the backoff's own timers; the browser suite's
  `r5` script waits for the draft to be kept instead of 700 ms, and `test/ui-fixed-waits.test.js` fails on a new
  fixed wait of 300 ms or more that does not say why; the `READ_SCOPE_PERMS` test records the permissions a real
  sync pull asks about instead of reading `sync.js` with a regular expression.
- **Release record (L5).** docs/RELEASE.md records the behaviour changes the owner decided inside 1.16.1 (the
  to-do for a client changed off the care team, the counseling-note restriction) as owner decisions within a patch.

## 1.16.1 — 2026-09-29

### Security

Fixes from the security review of 1.16.0. No migration, no new permission, no new route. With 1.16.0 most staff
see every client, so "who may change this row" can no longer be left to the caseload; these say it.

- **Stored files are never pages of this origin (H1).** A device could push a resource photo with the type
  `text/html` or `text/javascript`, upload a page or a script as its bytes, and have it served as this origin's
  (stored XSS, with a link from the resource's website field). A resource photo's type is now read from its bytes,
  and anything that is not a picture is an opaque download; every stored file (photos and thumbnails, form
  attachments, policy documents, the form library) is served with `nosniff`, a `Content-Disposition`,
  `Cross-Origin-Resource-Policy: same-origin` and `Content-Security-Policy: sandbox; default-src 'none'` (a PDF
  keeps the app's policy: browsers do not show one in a sandbox); sync refuses a photo whose type is not a picture
  or an attachment whose type the form library does not take, and the blob upload checks a photo's bytes.
- **A device writes only the columns a table's rules declare (H2).** Sync push stored every column a device
  sent, so it could make another worker's goal its own and then delete it, or name someone else as the person who
  made a disclosure (the §2.25 / §164.528 accounting). Anything a table's rules do not declare is now the office's,
  and who created a record (`created_by`, `disclosed_by`, `given_by`, `recorded_by`, `opened_by`, `uploaded_by`...)
  is the account that syncs it, kept as the office has it afterwards; a device that names someone else is told.
  This replaces 1.14.0's "a creator column arrives as the device recorded it" (docs/architecture/README.md).
- **Attachments follow their form (M1, M2).** The blob upload route replaced any attachment, including the signed
  copy on another worker's completed form. A device now fills in only the file of a row it created, while empty;
  replacing a file is its creator's or `records:manage-others`', never on a completed form. Nothing is removed from
  a completed form but by a supervisor (the signed copy is still attached after completing it), and voiding or removing a form, or removing an attachment, is
  the person's who started the form or added the file, or `records:manage-others'`, by REST as by sync.
- **Supply lines are their visit's (M3).** A device could add or remove the supplies on another worker's visit
  (changing its kit counts and the stock); a line now follows the visit's own edit rule.
- **Import items (M4).** Committing a staged import item is its importer's or `records:manage-others'`, as
  viewing, discarding and purging it already were.
- **SUPRT-A and CalOMS deletes (M5).** Deleting an assessment or a CalOMS record is its recorder's or
  `records:manage-others'`; a CalOMS record already sent to DHCS is corrected, never deleted, by anyone (it used to
  be deleted with a warning). Re-admitting a discharge made in error still takes its discharge record with it.
- **Episodes (M6).** A device changes an episode only as the REST routes do (open, discharge, re-admit); when,
  how and why a client was admitted is kept as the office has it, and `closed_by` is the account that discharged.
  Discharging or re-admitting, which ends the whole care team and cancels its to-dos, is for the client's care
  team, the person who opened the episode, or `records:manage-others` — at both doors, and for the care team a
  device's discharge ends.
- **Separation of duties (M7).** An approver could record spending or time under a colleague's name, or raise a
  colleague's pending amount, and then approve it. Approving is now refused to anyone who recorded or changed the
  entry, read from the audit trail (without a migration there is no creator column on these rows); a device's
  entry recorded for someone else is audited for it (`sync.record`). Returning an entry is unchanged.
- **SUD counseling notes are restricted by design** (the owner's decision). A counseling note (42 CFR §2.11) is
  read only by its author, its co-signer and staff who write clinical notes (`notes:clinical:write`); a navigator's
  `notes:clinical:read` reads every other clinical note, never a counseling note, and break-glass does not open one.
  Enforced on the note, note lists, the client timeline, the supervision queue and sync: a navigator's device is not
  sent one or its addenda, and a device that received them before is told to remove them at its next sync.
- **Changes to a client's record are told to their primary worker** (the owner's decision). Anyone who can see a
  client may still update the record; when the editor is not on the client's care team, the primary worker gets a
  to-do (the bell) naming who changed which fields, never the values. An edit arriving by sync does the same.
- **Smaller fixes (L1–L5).** A problem-list change arriving by sync is kept in the problem's history; a device
  cannot ask for a review of another worker's signed note; a spreadsheet import needs `imports:write` (as the
  Import page does), checks each record against its table's shape and rules, and audits each record; a goal's or
  step's wording is its author's or `records:manage-others'` to change (they keep no history); a resource photo
  removed by sync is removed, as over REST, instead of being dropped quietly.

### Frontline

Fixes from the frontline review of 1.16.0: the "see every client, change your own work" rule is now explained
wherever it applies. Screens and wording only: no migration, permission or route, and nobody can do more or less
than before.

- **Overdose & reversals.** Another worker's event opens read-only (it opened as a form that could be filled in and
  then refused the save), with *Reported by … Only they or a supervisor or administrator can change it*. On a phone,
  **Delete event** no longer covers **Save**: it now sits on the left of the form's own button row.
- **A colleague's visit or call can be read in full.** A row on Visits (and a client's Visits tab) opens the whole
  visit: summary, supplies, outcome, follow-up and funding. Only 120 characters of the summary showed before, and
  there was nothing to open. A desktop call opens the same way. Edit and Delete are in that dialog for the person
  who recorded it, or a supervisor or administrator.
- **Why Edit is missing.** Where Edit and Delete are hidden, the row says *Recorded by … — view only* (Visits, Calls &
  texts, Referrals), and a to-do says *Assigned to … — view only; you can mark it done*. A colleague's draft note says
  that only its author or a supervisor can finish, sign or delete it. A care-plan goal someone else added says who
  can delete it. On a phone, someone else's to-do opens to read, not as a form. The server's refusal of a change to
  someone else's record now says who can make it and what to do instead.
- **Roles described once.** New user, Edit user, approving an access request, a device's first account and the
  Permissions dialog use the same role summaries: what the role sees, what it records, and whether it changes other
  workers' records (only supervisors and administrators do). They follow the owner's decisions for this release: a
  client record is shared (anyone who sees a client may update it, and the primary worker is notified), and SUD
  counseling notes are read only by their author, the co-signer and staff who write clinical notes. Notes (and a
  client's Notes tab) say so to a navigator, where counseling notes are no longer listed. The device sign-up no longer says a clinician does
  "everything a navigator does": a navigator records spending and a clinician does not. The Permissions dialog no
  longer starts with "Since 1.16.0". Permission names say what they cover: *Visits & services (read, log, change
  own)* rather than *(all)*, and the same for calls, referrals, to-dos and overdose events.
- **Visits fit a 1280 px window.** Where-and-how and the start of the summary sit under the visit type, so the Edit
  column is no longer past the right edge.
- **Home** titles its tiles *The whole program at a glance* (or *Your caseload at a glance* for a person held to
  their caseload), and the check-in list is *Your clients who need a check-in*.
- **Smaller fixes.** The to-do list's two checkbox columns are headed *Done* and *Select* (both were read out as
  "Actions"). Referrals say **Edit**, not **Update**. The Supplies tabs wrap onto rows on a phone instead of
  scrolling past the edge. The client header says whose client it is (for example *David Chen's client (primary worker)*).
- **Setup wizard.** The offline-copy question now says what a copy holds: with the default roles, the whole
  program's records, clinical notes included, unless the person is denied *See every client* before their device
  first syncs.
- Tests: the browser script `scripts/ui/r6.mjs` (48 checks, including WCAG 2.1 AA on each changed dialog); the
  accessibility audit now opens a visit, a call and an overdose event from their rows.

### Documentation

- **The market and security pack now describes the 1.16.0 defaults.** The IT and programme buyer guides, the RFI
  boilerplate, the readiness scorecard, security questionnaire items 22 and 45, SOC 2 readiness CC6.3, the
  security architecture, CalAIM and the README said "caseload scoping" and "clinical notes restricted to clinical
  roles" as if they were the defaults. They now say that navigators and clinicians see every client,
  navigators read clinical notes but not SUD counseling notes, client records are shared with changes reported to
  the primary worker, and least privilege is a per-user deny, not the default.
- **"Who sees which clients?"** is a new objection answer in POSITIONING.md. The pilot kit's week −1 now decides
  per-user denies before any import or device sync.
- **Offline copies, said the same way everywhere.** The IT guide and questionnaire now match the setup wizard and
  INSTALL.md: local mode is off unless the wizard or IT turns it on, the wizard recommends it for outreach, and a
  device then holds the whole program's records under the default roles.
- **"Prevention", precisely.** SUDS supports prevention-funded outreach and distribution, not SABG
  primary-prevention (PPSDS) reporting. This is now stated in the positioning, scope, buyer guide, scorecard (as
  a known gap) and the pilot kit's eligibility check (new Q0). The scorecard also lists "least privilege by
  default" as a gap.
- **Supported versions** (RELEASE.md, VULNERABILITY-MANAGEMENT.md): the latest minor gets every fix; the previous
  minor gets security fixes for 30 days after the next minor; best effort, one maintainer.
- POSITIONING.md no longer calls supplies a "cupboard" (items, sites and lots), nor does the permission catalog.

### Engineering

Fixes from the engineering and release-process review of 1.16.0. No migration, no new permission, no new route.

- **A programme's year can be published again when a few months' overdoses were almost all reversed.** A
  2,000-person programme's fiscal-year publication release was refused whole: three months had 1, 2 and 3
  overdose events not reversed. The disclosure check had to try every candidate for those months, and the step
  that withholds a table instead of refusing ran out of budget re-running that check. Now, in a period with at
  least 12 × the threshold of overdose events, **Overdoses by month** is withheld from the start by a published
  rule whenever a month has 1 to T−1 events, or 1 to T−1 not reversed. The rest is published as before. That year
  now publishes in under a second with only that table withheld. A 20,000-client year is unchanged, and smaller
  periods are checked as before (docs/architecture/ADR-0009, *Withheld by rule*; docs/HIPAA.md).
- **A refused year says what to do.** The refusal told someone who had asked for a fiscal year to "publish a
  longer standard period". For a year it now says a year is the longest standard period and to tell whoever
  supports the server which period was refused; for a quarter it suggests a year. A refusal because the check ran
  out of budget is now logged on the server with the check's work (steps, rounds, tables withheld), as a refusal
  by the time limit was.
- **The web app (SUDS on this device) is published only from a release, with the owner's approval.** A bare `v*`
  tag push or a `release` event published it beside the release workflow rather than after it, so a tag whose
  gate failed, or that nobody approved, still reached the public site. A dispatch on a branch published
  unreleased code. `web-app.yml` now runs only when dispatched on a `v*` tag, and only if that tag's GitHub Release
  exists at the same commit. It runs in the `release` environment.
- **A published release's files are never replaced.** The release workflow refuses a version already tagged at
  another commit. When the GitHub Release exists, it no longer uploads over its zip and checksum (it did, with
  `--clobber`). Before, running the workflow on `main` after a release, without bumping the version, replaced the
  published zip and checksum with ones built from a different commit.
- **The release gate does not trust the commit it judges.** It runs `main`'s copy of `release-gate.js` and
  `release-policy.js` against the released tree, so a commit cannot relax the checks that release it. It refuses a
  commit that is not on `main`, whatever the policy exception. The 28-day feature-release check now fails when the
  previous feature release's date cannot be read (it only warned). Its refusal gives the exact time (after 1.16.0:
  2026-10-27 03:16 UTC).
- **One list of the permissions that widen reading.** `server/permissions.js` `READ_SCOPE_PERMS` and
  `CASELOAD_PERMS` replace hand-kept copies in the sync scope key, the device sign-up's caseload hold and the
  benchmark. A test checks that every permission the sync pull asks about is in the list or comes from a table.
- **The browser kernel builds to the same bytes anywhere.** It now builds through a worktree's symlinked
  `node_modules`, and from any directory. 1.16.0's release commit had to be rebuilt for this.
- **Browser suite:** the unsent-visit checks wait for the draft to be kept, not a fixed 700 ms. The accessibility
  reflow checks wait for the resized layout to settle, not 150 ms, which is the likely cause of an intermittent
  reflow failure.
- **Docs:** RELEASE.md records 1.15.0's policy exception, has a table of every exception, and corrects what it
  said about 1.15.1. The architecture overview no longer says a sync tombstone of shared data needs `clients:all`
  (it needs `records:manage-others`). ADR-0009 no longer claims the degrade step has a budget of its own or that
  no programme's release is refused. PERFORMANCE.md calls the 2,000-client refusal the defect it was. HANDOFF.md
  gives the right end of the feature freeze.

## 1.16.0 — 2026-09-29

### Roles and permissions

A feature release: the owner widened two roles' defaults. Expansion only: nobody loses a permission, and
supervisor, administrator, finance and read-only keep exactly what they could do (finance still never holds
`clients:read` or `export:identified`). One new permission string, `records:manage-others`, splits "manage other
workers' records" off `clients:all`; supervisors and administrators hold it. No migration, no new route; the sync
pull answer gains fields (below).

| Role | Added | Not added |
|---|---|---|
| navigator | `clients:all` (outreach engages whoever walks in, not only their caseload); `notes:clinical:read` | `notes:clinical:write`, `records:manage-others` |
| clinician | `clients:all` (coverage and on-call); `budget:read` (programme spending) | `budget:write`, `records:manage-others` |
| supervisor, administrator | `records:manage-others` (what `clients:all` gave them before; no new power) | |

**Administrators: upgrade note.** After upgrading, every navigator and clinician sees every client in the
program, and navigators can read clinical notes (SUD counseling notes included). To keep the old scoping for a
person, deny *See every client* (`clients:all`) — and, for a navigator, *Read clinical notes*
(`notes:clinical:read`) — under **Settings → Users & permissions → Permissions** (1.15.0), with a reason; do it
before their devices next sync if your program uses local mode (below). With **Caseload restriction** on (Program settings; the default), that person
is then held to their caseload everywhere it applied before: client list and search, a record and its timeline,
the duplicate check at intake, exports, the dashboard and reports, and what their devices sync
(`test/role-expansion.test.js`). Minimum necessary for navigators and clinicians is from now on the programme's
own per-user choice (docs/HIPAA.md).

What follows from `clients:all`, for a navigator or clinician who holds it:

- **Every client**, over REST, search, exports (de-identified, as before), the dashboard and the funder, NDP and
  settlement reports (their first run stays *internal, suppressed*; they may also ask for a publication release
  of the whole programme; still no exact counts), and in sync. A client they create is still assigned to them,
  now from a device as well as over REST, so a later deny leaves it on their caseload.
- **Seeing is not managing: `records:manage-others`** (new permission string, the owner's decision). A navigator
  or clinician sees every client and adds their own work to any record (a visit, a call, a note, a referral, a
  to-do), and sees another worker's records with no client (an anonymous call or outreach contact). They do NOT
  change or delete another worker's visits, calls, referrals, overdose reports, to-dos, care-plan goals and steps,
  assessments, outcome measures, rights requests or draft notes; record work under another worker's name; remove a
  client record; or see another worker's staged imports. Those powers were carried by `clients:all` and are now
  `records:manage-others`, held by supervisors and administrators (who held them through `clients:all` before, so
  nobody loses anything). It is used by `server/crud.js` (`ownerOrManager`, the owner column on insert), every
  `server/rules/*` `owner`/`editableBy`/`deletableBy` (so sync push refuses the same edits, deletions and
  attributions as REST), client removal (`DELETE /api/clients/:id` and the device's equivalent, and the button on
  the client page), a device's deletion of shared reference data, supply lines on another worker's visit with no
  client, the imports list, Home's staged-imports count and which imports a device pulls. The screens show Edit,
  Delete and Update only where the person may use them. In the catalog it is *Manage other workers' records*,
  rated sensitive; a grant through the 1.15.0 overrides is refused for a role without `clients:write` (finance,
  read-only), by the same rule as 1.15.4's other grants a role may not hold (`server/permissions.js`
  `grantProblem`): it is also removed when the person's role changes to one of those (audited as
  `user.permission.revoke`, `cause: "role_change"`) and ignored at request time, so a stray row does nothing (Users
  & permissions marks it *No effect*). `test/role-expansion.test.js`: a default navigator and clinician get 403 over REST and a refusal by
  sync push; a supervisor and an administrator still succeed. The sync-rules characterisation is back to its 1.15
  outcomes for another worker's records (the 1.16.0 `was:` notes remain only for "client off the caseload").
- **Clinical notes for navigators**: listed, opened, on the timeline and synced to their devices; still not written,
  signed or added to. That includes notes marked as SUD counseling notes (42 CFR §2.11), by the owner's decision: a
  programme whose policy keeps those to the treating clinician denies the navigator *Read clinical notes*
  (`notes:clinical:read`) under Settings → Users & permissions → Permissions (docs/compliance/PART2.md). Assessments
  stay clinicians' and supervisors'. An administrator still reads a clinical note only by break-glass; every Part 2
  disclosure rule is unchanged.
- **Budget for clinicians**: Funding & spending and the settlement report open; recording spending does not.
- **Home**: a navigator's or clinician's activity card counts the program's visits and says so (*What the team has
  been doing*), as the dashboard follows what a person can see. Their to-do counts, and the overdue pill, stay
  their own: the team's are for someone who countersigns and sees every client (a supervisor or administrator,
  as before; `tasks.team` in `GET /api/reports/dashboard`).
- **Devices (local mode).** A navigator's first sync is now the whole programme: at 20,000 clients, 503,742 rows in
  120 pages (29.3 MB on the wire, 460.3 MB of JSON, 19.3 s of server time) against 104,000 rows for a 2,000-client
  caseload (docs/PERFORMANCE.md, measured with `scripts/bench/run.js`, which now measures both). A programme that
  uses local mode should deny `clients:all` to the people who sync devices unless it is small.
- **A device follows a change to what its person may read** (new; before, it did not). A pull used to send only
  rows changed since the device's cursor, so a device that synced before a permission change kept what the person
  could no longer read, and received what they newly could only as its rows happened to change. Each pull answer
  now carries `scope` (a key of caseload scoping and the permissions sync depends on) and the device sends back
  the one it last saw: after a narrowing (a deny of `clients:all` or `notes:clinical:read`, a role change) the
  office names what to remove (`dropped_clients`, and `dropped_rows` for clinical notes, another worker's records
  with no client, another worker's imports, a table whose read permission went) and the device removes it, never
  echoing it back; after a widening the pull starts again from the beginning and the device receives the rest.
  A device that synced before 1.16.0 sends `legacy`, compared with the 1.15 role defaults: at its first sync after
  the upgrade a navigator's or clinician's device downloads the whole programme, unless the person was held to
  their caseload first (then nothing changes). `server/routes/sync.js` `syncScopeKey`, `local/sync.js`;
  `test/sync-scope-change.test.js` (the browser kernel against an office), `test/role-expansion.test.js`.
  Removing 18,000 clients after a deny names them in one 1.1 MB answer (159 ms at the office); the device's removal
  was not measured in a browser.
- **A device applies the office's per-user overrides and caseload restriction.** Each pull carries the person's
  own grants and denies (`permission_overrides`) and the office's `caseload_restriction`, and the device's kernel
  applies them, so on a local-mode browser that several office accounts sign in to, a person held to their
  caseload sees only their caseload there too. Before, overrides stayed at the office and a local-mode browser's
  caseload restriction was off (set so at its first account): the device was scoped only by what each account had
  pulled.
- **SUDS on this device.** The first account (the device administrator) keeps its role's defaults. Anyone who
  signs up on a shared device after it is given per-user denies of `clients:all` and `notes:clinical:read`, so they
  still see only their own clients; so is every such account on a device that upgrades. The denies stay if the
  device administrator makes the account a navigator or clinician, and go if it is made a supervisor or an
  administrator (`local/kernel.js`, `test/device-signup-scope.test.js`).

The sign-up and new-user role descriptions, the Caseload restriction setting, the permission catalog (*See every
client*, *Read clinical notes*, *Export data*), the Permissions dialog's role baseline for a navigator or clinician
(what widened, and the deny that holds someone to their caseload) and a clinician's first-day checklist (*Open the
client list*, or *Open your caseload* for one held to it) say what the roles now see. SUD counseling notes: whether
navigators read them is a programme policy decision (docs/compliance/PART2.md).
Tests that exercise caseload scoping use a navigator or clinician held to their caseload (`H.makeCaseloadUser`);
the sync-rules characterisation records the new outcomes with `was:` notes; `test/role-expansion.test.js` checks
the matrix against 1.15.3's (only the four grants moved) and that a deny restores caseload scoping in REST, search,
the duplicate check, exports, dashboard, reports and sync. The 1.15.3 ranked-search test now scopes a navigator held
to their caseload (`test/ux13.test.js`), as do the 1.15.4 caseload tests that relied on a navigator's old
defaults (`test/security-1154.test.js`). Caseload scoping still follows `clients:all` alone (1.15.4, M1), so a
per-user deny of it is what holds a navigator or clinician to their caseload, and a supervisor held to a caseload
cannot assign themselves past it, over REST or from a device (`test/role-expansion.test.js`).

### Engineering

Engineering and governance findings from the independent review of 1.15.3. These add no migration, permission or
route.

- **The release gate sees the device routes.** `scripts/release-policy.js` read only the server's route modules,
  so a patch release could add a route to the browser kernel unnoticed: 1.15.1 added three
  (`POST /api/local/recover`, `/api/local/recovery`, `/api/local/recovery/saved`), which the check now refuses
  as it refuses any new route in a patch release. The routes `local/kernel.js` and `local/sync.js` register are
  read from their source and added to the inventory it compares.
- **Patch releases stay small.** A patch release that adds more than 1,500 lines outside docs, tests and
  generated files (`git diff --numstat` against the previous tag) is refused like one that adds a migration,
  permission or route, naming its largest files; `policy_exception` remains the recorded override
  (docs/RELEASE.md, "Patch releases stay small"). 1.14.1, 1.15.1, 1.15.2 and 1.15.3 scored 24, 488, 176 and 649.
- **The owner is in the release path.** The release job runs in a `release` environment, so a required reviewer
  can hold it for the owner's approval; `.github/CODEOWNERS` names the owner for the release and CI files and for
  `server/auth.js`, `server/permissions.js`, `server/disclosure.js`, `server/crypto.js` and `local/vault.js`; and
  the release notes end with who released it (`github.actor`, and who re-ran it). The GitHub settings that make
  these binding (branch protection on `main` with pull requests, CI and code-owner review; the environment's
  required reviewer; a tag rule) are the owner's to turn on and are listed in docs/RELEASE.md, "Owner control over
  releases".
- **Migration numbering is checked.** A released migration keeps its position in `server/db.js` for good (the
  position is the schema version a database records). `scripts/migration-order.js`, run by
  `test/migration-order.test.js`, fails when a released migration moved, changed or was removed against the
  previous release tag, or a `// N:` header does not carry its position, so two branches that each add
  "migration 49" cannot both land unnoticed. CI's `test` job fetches the release tags for it. The convention is
  written above the array and in ADR-0007.
- **An upgrade test from a 1.15.x database.** `test/fixtures/release-v1.15.3.sql` was written by 1.15.3's own code
  (schema 48; its sample data, clients with names in other scripts, and at least three rows in each of the 36
  tables with an encrypted column); `test/migrations.test.js` opens it and checks every value still decrypts and
  every blind index still matches.
- **The thorough tests are two CI jobs.** The full-size SDC attacker sweeps took most of the `thorough` job's
  30 minutes; they now run in `thorough-sdc` (60-minute limit: on its own the sweep took 27 minutes on the
  development container, the rest 17 seconds), and the performance checks in `thorough`. Both
  are required by the release gate (`scripts/test-thorough.js --part sdc|rest`; `npm run test:thorough` still runs
  everything).
- **The permissions-admin browser script runs in CI.** It was not in `scripts/ui/run-all.sh`'s default list, so
  it never ran; the suite is now 39 scripts, and a test fails if a script in `scripts/ui/` is left out again.
- **Benchmarks.** `scripts/bench/run.js` measures a publication release for a fiscal year at 20,000 clients (wall
  time, and the longest the server's main thread was held), and a navigator's client list while one is audited;
  docs/PERFORMANCE.md records the numbers and re-measured first-load figures.
- **README** listed the Node 24 job as advisory; it has been required since 1.11.0. It now names the required
  jobs as the release gate does.
- **A restore's undo copy that cannot be encrypted is reported, and sealed later.** When a restore could not seal
  the copy of the database it set aside, the only sign was a warning in the log, and the whole database stayed
  beside the live one in plaintext until the next start. Now Settings → Security status shows *Unencrypted database
  copies* (bad) with the file, why the seal failed and what to do, `/api/health` answers 503 naming the file, and
  housekeeping tries to seal it (and any plaintext pre-migration snapshot) every hour.

The Frontline and Reporting and market sections are fixes from the independent frontline-UX and market reviews of
1.15.3. They add no migration or permission and change no role's permissions: finance's new reach (below) goes
through the existing `reports:funder` check. No new API route; the browser has one new page address (`#/ssp`, the
syringe services summary on its own page) over the existing `GET /api/reports/ssp`. One new setting:
`API_RATE_LIMIT`.

### Frontline

- **Repeat last visit copies what kind of visit it was, never how much.** It copied the last visit's supply lines
  and quantities (another worker's included), so a repeated visit nobody changed drew stock and counted kits a
  second time; the only warning was a tooltip. The same items are now on the form with every quantity empty, the
  kits and strips counts and any direct cost start at nothing, and a note at the top says whose visit it was
  copied from and when (*Copied from Jordan Walker's visit on 26 Sep 2026 … Supplies start at zero … This visit is
  recorded as yours*).
- **The bell's panel no longer says "null".** With eight or fewer to-dos due it showed the word *null* under the
  list. Four other places wrote a missing element into the page the same way and now do not: the profile's
  two-step card when two-step verification is required, the SCIM card without a token list or deprovisioning
  report, and the setup wizard's finished page without a key file.
- **A yes/no question nobody asked is "Not asked", not "No".** Veteran, history of overdose, justice involved,
  pregnant or parenting and co-occurring mental health were stored as *No* whenever they were left out, and
  SUPRT-A then pre-filled *no*. Like risk's *Not assessed* in 1.15.3: a client created by the intake form, Quick
  add, an import (a blank cell) or a device's sync without an answer stores none, the record shows **Not asked**,
  and the form asks **Yes / No / Not asked** instead of a checkbox. SUPRT-A pre-fills only what was recorded:
  *ever had an overdose* is *no* only when the record says so. Clients recorded before this keep their answers.
  An import whose yes/no column said "no" failed its row (*cannot be bound*); it now imports.
- **SUPRT-A is complete only when it is.** A baseline could be saved *complete* with its screenings, diagnoses and
  crisis questions blank. Every question of each section the assessment point asks is now needed (sections B-D at
  a baseline, reassessment or annual assessment, E at the follow-ups, F at a baseline without SUPRT-C; not the free
  text, nor the date of birth; the medication when MOUD is *yes*), each has a *Don't know / not recorded* or *Not
  screened* answer, and saving names every question still to answer, once, with each marked where it is. Gender,
  housing, insurance and route of use are lists with labels, not text boxes holding codes. With no grant ID set,
  the form says so and links to where it is set. The tab no longer says a baseline "is due once…" beside *Due
  now*. SUDS's reading of the handbook: verify it against the current SUPRT-A handbook.
- **Returned or reopened time is a to-do for the worker.** A supervisor returning (or reopening) time now puts a
  to-do on the worker's list, due at once so the bell shows it: which day and how long, who returned it and why
  (encrypted; one to-do per worker for a batch). The approval queue has **Select all**, and every row's buttons
  say which entry they act on (*Approve 2h 30m on 28 Sep 2026 for Maria Rivera*), on Supervision and the time page.
- **The note viewer names the client.** Its link read *view*; `GET /api/notes/:id` now carries the client code,
  and the name for a reader who may open the record, and the link says *Rivera, Maria (C26-0012)*.
- **Search says what it found.** A polite live region announces *3 clients and 1 resource found* or *No match*,
  the Down arrow moves into the results (Up, Down, Escape back to the box), and the box says *Find a client or
  resource* where the reader may see the directory.
- **Home's Calls tile counts what the worker may see**, as the visits tile does: their caseload's calls and their
  own calls with no client (it counted the whole programme's). A role that sees every client sees every call.
- **Signing a note closes its "Finish and sign your note" reminder**, at the office and when the signature arrives
  from a device; the author's other reminders stay.
- **Wording.** An error is said once: a message of its own (*Password must contain…*, *That recovery code is not
  right*, SUPRT-A's) no longer repeats the field messages shown under each field. The setup wizard's username help
  (the *guest* default stays) goes away once another name is typed, and its finished page points to *Settings →
  System & backups*. A production Home no longer suggests loading sample data. Read-only is described as
  *reports and de-identified lists; cannot open client records*. *Continue where you left off* does not promise
  "from any device" on SUDS on this device. The overdose form's help names the reversal choice as the list shows
  it. A supervisor's time page is **Staff time**. The consent recorded from a referral says so once. New time is
  charged to the worker's default fund, as a new visit is. On a client's record the `n` shortcut logs a visit for
  that client. The audit-anchor notice keeps its place (a security finding) and now says plainly that nothing in
  SUDS fixes it and what to ask IT, with **Copy the request for IT**.
- **From the live retest of 1.15.3.** The expiring-consent alert on a client's Overview read *the Part 2 consent
  consent to …*: "consent" is now said once (and still added for a type whose name lacks it). An empty
  **Waitlist** offers **Add someone to the waitlist** (the intake form, opened on the status Waitlist) to a role
  that may add clients, and tells anyone else who does. An inactive resource's profile was checked in the browser at
  1280 and 390 px: its badge is an item of the badge list, read as *Status: Inactive*, and the browser suite now
  asserts it. So is the unsent-visit offer after navigating away: *Resume your unsent visit?* restores the fields,
  and Discard clears them.
- **A publication release does not offer "Export everything to Excel"**, the program's own record-level workbook
  for internal checking; the submission run still does.

### Reporting and market

- **Settlement people served per activity.** The DHCS layout and county templates repeated a fund's whole count
  of services and people on every one of its activity rows. Services and people are now on the row of the
  activity they fall under, the fund's own Exhibit E category and HIAA; a fund's other rows carry its spending.
- **County templates map more.** A column can take the naloxone kits and test strips distributed and the
  reversals charged to the activity's fund (10 or fewer written "10 or fewer"). A template's rows can be one per
  fund of another type (a block grant (SABG), SOR or county general fund report), with the settlement-only columns
  left blank and every active fund of that type listed.
- **Finance runs the syringe services summary and SUPRT-A completion rates**, aggregate only, through the existing
  `reports:funder` check: the summary as the programme's own submission of the whole programme (an internal run is
  refused), from a link on the funder report (`#/ssp`); the completion rates of the whole programme, not the
  follow-ups due, which name clients.
- **`API_RATE_LIMIT`** (default 600 requests a minute per address) joins `LOGIN_RATE_LIMIT` as a setting, and
  DEPLOYMENT.md says how an office behind one NAT address raises both for a day of bulk imports.
- The market pack: the scorecard has SUPRT-A, supplies and syringe services, and finance reporting rows (SUPRT-A
  with its "verify against the handbook" caveat), EVALUATION-RESPONSE.md runs through 1.16.0, the programme
  buyer guide describes supplies by item, site and lot, and what is deferred is listed with why.
- **Deferred:** publication for programmes serving 20-40 people (a change to the disclosure method needs the
  independent statistical review first); SSP participants from anonymous contacts (no field holds a participant
  code; adding one is a schema change); the SUPRT-A codebook and SPARS batch file, and the official NDP and SSP
  templates (not available to check against); people trained (SUDS does not record training).

## 1.15.4 — 2026-09-29

### Security

Fixes from an independent security review of 1.15.3, for the 1.15.4 security release. No migration, no new
permission, no change to which roles hold a permission, and no new route.

**Advisory:** SUDS 1.15.3 and earlier are affected. H1, H2 and the self-assignment in M1 affect every release up to
and including 1.15.3; the permission-override findings (M1, M2, L2) affect 1.15.0–1.15.3; the recovery code (L1)
affects 1.15.1–1.15.3. Upgrade to 1.15.4.

- **H1 (High) — a device could approve time and spending, its owner's own included.** Sync push kept the status a
  device sent for a time entry, so a navigator's phone could push its own hours as *approved*, and a supervisor's
  could approve the supervisor's own; an approver's device could approve (or reimburse) the approver's own
  expenditure, which `POST /api/budget/expenditures/:id/approve` refuses. Rulings are now the office's alone, in
  the rules both doors share (`server/rules/shared.js` `officeRuling`, used by `server/rules/time_entries.js` and
  `server/rules/expenditures.js`): a push may submit time (draft → submitted, and resubmit time it was shown
  returned) and keeps everything else about the status, approver, date and note as the office has it. A ruling
  in a pushed row is not applied and not silently dropped: the row lands without it and is **flagged** to the
  device's sync screen and the audit trail (`sync.conflict`, `flagged: "ruling"`). The same holds for a note's
  countersignature (never taken from a device, now flagged) and for whether a note needs one: a trainee's device
  could push `cosign_required = 0` and escape countersigning; it now comes from the author's account, as over
  REST. On a device that syncs with an office, the approve, approve-batch, expenditure-approve and countersign
  routes answer 403 *done on the office SUDS* up front. The other columns that record the office's own acts were
  checked: a CalOMS record's extract date could be cleared by a push (putting the record in the next DHCS extract
  again) or set; it is now the office's, like a SUPRT-A assessment's SPARS export date, and a device that asserts
  either is flagged (`flagged: "office_mark"`). Note signatures (the author's own), referral outcomes (anyone on
  the caseload, as over REST) and the accounting of disclosures (append-only) take nothing more from a device
  than their REST routes do.
- **H2 (High) — a de-identified role could find out whether a named person is a client.** Finance and read-only
  accounts could search `GET /api/clients?q=` by name, date of birth or phone (including `rank=1`), and a match
  told them that person is a client — without showing a name, but 42 CFR Part 2 protects the fact itself. For a
  role without `clients:read`, `q` now matches an exact client code only; anything else finds nobody, in the same
  shape as no match, and the search box says to search by code. Every client search is audited by the field it
  looked in (`searched`: name, dob, phone or client_code; `search_refused` for a de-identified identifier search),
  never by what was typed.
- **M1 (Medium) — permission overrides broke caseload scoping.** Holding `clients:list-deidentified` exempted
  anyone from caseload scoping, so a navigator granted it saw every client's record; finance or read-only could be
  granted `clients:read` or `export:identified`; and `assignments:manage` let its holder put themselves on any
  client, which undid a deny of `clients:all`. Caseload scoping now follows `clients:all` alone (a de-identified
  account, which can open no record, is the only one not held to a caseload), so denying `clients:all` puts a
  person back on their caseload in lists, records, search, exports, sync pull, the dashboard and reports. One rule
  (`server/permissions.js` `grantProblem`) refuses, at grant time, `clients:read`, `clients:write` or
  `export:identified` to a de-identified role and `clients:list-deidentified` to a role that opens records, and
  `auth.effectivePerms` ignores such a grant at every request, so an older row does nothing (Users & permissions
  marks it *No effect*). Adding (or ending) a care-team assignment needs a client the actor can reach, or
  `clients:all`, at both doors (`server/rules/assignments.js`), and **Move a caseload** moves only such clients
  (the rest are counted as `not_on_caseload`, not named). `assignments:manage`, `clients:read` and `clients:list-deidentified` are rated
  *sensitive* in the permission catalog (risk labels only).
- **M2 (Medium) — privileged grants survived a role change, so a demoted account could promote itself.** An
  administrator granted `users:manage` and then made a navigator kept the grant, and could set their own role back
  to administrator. Grants a role may not hold are now ignored at every request (`effectivePerms`) and removed
  when the role changes (each audited as `user.permission.revoke`, `cause: "role_change"`), and nobody can change
  their own role (`PUT /api/users/:id`), up or down.
- **L1 (Low) — the recovery code outlived the device administrator.** On SUDS on this device, deactivating the
  person who manages the device left their recovery code working, and it made them a new administrator account.
  Now the code stops working the moment that account is deactivated or removed (audited
  `device.recovery_code.dropped`), the administrator who made the change becomes the one who manages the device,
  and Home and **This device** ask them to make a new code. The code screen offers **Print it** first and
  **Save to another device (as a file)**, and says to keep the file off the device.
- **L2 (Low) — override hygiene.** An override's reason is 10 to 300 characters, the form says to keep client
  details out of it, and the audit log records its length and SHA-256, not its words. Revoking an override needs a reason
  (`DELETE /api/users/:id/permissions/:permission` with `{ reason }`; the Revoke dialog asks). A deny is audited as
  `user.permission.deny` (it was logged as a grant). `npm run reset-admin` removes a deny of `users:manage` on the
  account it resets and says so, and says first, plainly, when it reactivates a deactivated administrator.
- **L3 (Low) — unsent visit drafts stayed in a signed-out tab's memory.** Choosing **Sign out** now clears
  what was being typed at once (and a form left open before it cannot put it back when the same person signs in
  again); after a sign-out for inactivity it is kept for 15 minutes for the same person to resume, then cleared.

## 1.15.3 — 2026-09-29

Fixes from QA of 1.15.2. No migration, no new permission, no change to which roles hold a permission, and no new
route.

- **Approved time is locked.** `PUT /api/time/:id` on an approved entry answered 200 and changed its minutes while it
  stayed *approved* — a signed-off time sheet could be rewritten. An approved entry can no longer be edited or
  deleted by anyone (the worker, or a manager with `time:all`): the API answers 409 *ask a supervisor to reopen it*,
  and a device's sync push of the same edit or deletion is refused for good (`not permitted`). The rule is in
  `server/rules/time_entries.js`, so both doors apply it. To correct approved time, a supervisor (`time:approve`,
  not their own time) presses **Reopen** on it in **My time** and gives a reason: the existing
  `POST /api/time/:id/approve` now accepts `decision: "rejected"` for an approved entry (audited `time.rejected`,
  `reopened: true`), and the worker corrects it and submits it again. Submitted time is still its worker's to
  correct until it is ruled on. Approved expenditures were already locked at both doors (checked by a new test).
- **Risk is "Not assessed" until someone assesses it.** A client created without a risk level was stored and shown
  as *Moderate* (the column's default). The intake form's Risk level now starts blank (*Not assessed*); a client
  created or imported without one has none, and badges, the client list, Home's caseload and the waitlist say
  *Not assessed*. The client list takes `risk=not_assessed`; the high-risk count and filter are unchanged. Clients
  already recorded as Moderate are left as they are.
- **Resource pictures: a photograph saved as PNG uploads.** A PNG stayed a PNG when shrunk and was still several MB
  at 1600 px, over the 2 MB picture limit, so the upload was refused and the Pictures card went blank — choosing a
  picture seemed to do nothing, on the office server and on this device. Such a picture is now sent as a JPEG that
  fits, and the card lists any picture that could not be added and why.
- **"Inactive" is read out where it is shown.** A deactivated resource's *Inactive* badge sat alone in a list column
  with no heading (a screen reader announced it under "Actions"), a directory card did not show it at all, and on
  its profile it ran into the other badges. It now sits with the name (the card's link and the list row's button
  say *Status: Inactive*) and the profile's badges are a list, as on a client's record. A list row's open button is
  no longer built from decorative text alone (a resource with no picture got a button with no name), and a funding
  source's status keeps its heading on a phone. The accessibility script checks resources, users and clients at
  1280 and 390 px.
- **Typos.** *the batch that expires first first* (Supplies help and the visit form) now reads *expires soonest
  first*; screen text uses US spelling throughout: *license* in the ASAM notices, and *program* / *organize* in the
  permission names and descriptions, a Settings field error, the publication refusal, a printed form starter, the
  device sync notice and the page description.
- The browser suite checks that a clinician's client record on a treatment-adjacent program shows **Care plan** and
  **Assessments** as tabs, not under More, at 1280 and 390 px (1.15.2's promotion; it holds).

Usability fixes (1.15.3). No migration, no new permission, no change to which roles hold a permission, and no new
route: the server changes are a query parameter on an existing route (`POST /api/clients/:id/assignments?restores=`,
the Undo after ending an assignment), a ranking option on another (`GET /api/clients?rank=1`) and three audit action
names for the undos.

- **Time is logged from a visit or call only when asked.** *Also log this as a time entry* starts unticked on every
  new visit (it started ticked and then remembered the last choice, so a duration nobody checked went on time
  sheets as hours worked), and so does a call's *Also log as time entry*. Ticked, its help says how many minutes of
  which category it adds; saving with the visit's prefilled 30 minutes untouched asks **Log this time?** (*Log 30
  minutes* or *Change the duration*, which returns to the field with nothing saved). **Log time** by hand for a day
  and client that a visit *or call* already logged time for now asks **Log this time as well?** on Save, as well as
  saying so while it is filled in (it looked only at visits, and never asked). The `visit_log_time` preference is
  no longer read. Help text and the user guide no longer say it starts on.
- **The bell keeps up.** It polled every five minutes; it now asks once a minute, a moment after anything is saved,
  and when the window gets focus or the tab comes back into view (`/api/tasks/due` still writes an audit entry only
  when its answer changes). The bell is a button that opens a panel: what is due (the first eight, overdue marked),
  **Updated just now / n min ago**, **Refresh** (announced) and *All to-dos due*.
- **Search ranks what it finds.** A name search lists exact name matches first, then the clients the searcher worked
  with lately (the same activity as Home's *Recent clients*), then names starting the same way, then sound-alikes.
  The search box at the top of every page (`?rank=1`) leaves sound-alikes out when anything matched better — a
  misspelling with no better match still finds them — also lists matching resource directory programs, and marks
  each result *Client* or *Resource* in words (the icon is hidden from screen readers). Caseload scoping and the
  `client.list` audit entry are exactly as before; only the order, and with `rank=1` the minimum, change.
- **An expiring consent is at the top of the Overview.** A consent that expires within 30 days is named, with its
  date and how many days are left, above everything else on a client's Overview, with a link to the Consents tab;
  one that has already expired while an open referral still relies on it is named too.
- **An unsent visit is offered back.** A new visit's draft now keeps everything — every field (a required one still
  empty, or a date half typed, no longer stops it being kept), the supply lines and a note's sections. Opening *Log
  a visit* again asks **Resume your unsent visit?** (*Resume* / *Discard*) instead of filling it in unasked, and after
  signing back in the same question is at the top of the page. Drafts stay where the design has always kept them —
  in the page's memory, never in browser storage (a reload loses them, as before) — and they are now the typist's
  only: another person signing in on the same tab starts with none (they used to be offered the previous person's
  drafts), and a save still queued when someone signs out cannot land in the next person's.
- **The same visit twice asks first.** Saving a new visit for a client who already has one of the same kind that day
  (read through the ordinary visits list, so it sees exactly what the worker may see) asks **Save another visit?**,
  saying when and by whom; *Cancel* keeps the form open with nothing saved.
- **A quicker visit form.** *Where & how* (location and modality, filled in from the last visit) is folded on a new
  visit, its heading saying what it holds, so a new visit of any type shows seven fields at 390 px before its
  sections: client, what was done, date & time, the supply picker's usual items and the summary. An edit shows it
  open.
- **Keyboard shortcuts.** **/** finds a client, **n** logs a visit, **?** lists the shortcuts, and **Ctrl/⌘ + Enter**
  saves the open form (it presses the form's own Save). The single keys act only outside text fields and dialogs, and
  **My profile → Keyboard shortcuts** turns them off for that person on every device (WCAG 2.1.4; the ACR now says
  *Supports*).
- **Undo instead of a question, where it can be undone.** Deactivating a resource, retiring a policy or contract and
  ending a care-team assignment now happen at once with an **Undo** toast (10 seconds, held while pointed at or
  focused, focus on Undo, announced through the live region). Undo reactivates the resource or document through its
  edit route (audited `resource.reactivate` / `document.reactivate`) or puts the same worker back on the case in the
  same role (`assignment.restore`, naming the assignment it undoes; the ended one stays in the history). Actions
  that cannot be undone keep their confirmation dialogs unchanged.
- **Empty lists say what to do next, or who can:** the care plan's problems and goals, incidents, documents,
  resources, supply stock, overdose events, the caseload on Home, "all caught up", the waitlist, the funder report's
  discharge reasons, CalOMS records, episodes, a client's forms and SUPRT-A switched off.
- **Your first day.** The welcome card on Home holds three first steps for the person's role (navigator, clinician,
  supervisor, finance, read-only), each with the button that does it and a tick box, counted as they are done
  (preference `first_day`); the old tips are folded under *A few things that help*. An administrator gets none: their
  *Finish setting up* card is that list. The role homes are otherwise unchanged.
- **Inline help** on the Part 2 consent form (*Is this consent a valid basis for sharing?*) and on Adjust stock,
  Dispose of and Move stock (*when to adjust, dispose or move*). The funder report's *Which file do I send?* (1.15.2)
  already covers the third.
- **200% zoom.** Settings' tab strip wraps onto a second row instead of scrolling tabs past the right-hand edge at
  640 CSS px (`pageTabs(…, { wrap: true })`); the client record (supervisor and clinician), the funder report and
  Supplies already reflowed and are now checked at 640×400 with device scale 2.
- A confirmation closed with ✕ or Escape now answers *Cancel*, so a form waiting on it is not left with Save disabled.
- Tests: `test/ux13.test.js` (search ranking, caseload scoping and audit, the three undos and their audit and
  permissions, time only when asked, the lists the duplicate checks read); browser script `scripts/ui/ux13.mjs`
  (the suite has 38 scripts); `ux-forms`, `frontline-review` and `review-fixes` follow the folded *Where & how* and
  the unticked time box.

## 1.15.2 — 2026-09-28

Fixes from a UI evaluation of all six roles (about 120 pages). No migration, no new permission, no change to
which roles hold a permission, and no new route: a reminder is an ordinary to-do (`POST /api/tasks`).

- **Supervision: act on the unsigned notes, not just see them.** Each draft under *Unsigned notes across your
  team* has **Open note** (the note opens over the queue, as countersigning does) and **Remind author**, which
  gives the author a to-do on that client's record, due today (high priority when overdue), asking them to finish
  and sign it. The to-do names the kind of note and the day it was started, nothing from the note; its title and
  details are encrypted like every to-do's, and creating it is audited (`task.create`). **Remind all overdue
  authors** confirms first and sends one reminder per overdue note, skipping any note whose author already has an
  open reminder for it (whoever sent it); a row with an open reminder shows *Sent* and its date instead of the
  button. You are never offered a reminder for your own draft. The queue's unsigned notes now carry `author_id`.
- **Individual permissions have their own place.** Settings → Users & permissions has a **Permissions** button on
  every row and a badge (*1 override*, *2 overrides*) on rows with individual overrides (`GET /api/users` counts
  them, for user managers only). It opens a Permissions dialog with exactly what the Edit dialog used to hold at
  its bottom: the role baseline, effective permissions with their provenance, the overrides and their reasons, and
  the grant/deny form with its risk flags and 10-character reason; deny still wins and every change is audited as
  before. The Edit dialog points to it (**Permissions…**).
- **Overrides in one trip.** Creating a user no longer ends with "Save the user first to manage individual
  permissions": once the temporary password has been noted, the new user's Permissions dialog opens, ready to
  grant or deny.
- **A supervisor's sidebar is their job.** Home, then **Supervision**, then Clients, Waitlist, To-dos, Visits,
  Calls & texts, Notes, Referrals and Settings (moving a caseload, the audit log): 10 entries instead of 23. The
  rest — Reports, the Funder report, Funding & spending, Policies & contracts, Supplies, Overdose & reversals,
  Forms, My time, the Resource directory, Privacy & Part 2, Import, State reporting and SUPRT-A — is under
  **More**, one click away; nothing is hidden. Decided from permissions (`supervising()` in `public/app.js`:
  countersigns and moves caseloads, but does not manage users or settings), not the role name. Administrators'
  and front-line sidebars are unchanged.
- **A read-only Home that does not talk to an actor.** An account that holds nothing but reading, reports and
  exports (decided with the deny-aware `can()`, not the role name) gets **Your reports** first — the Funder
  report, Reports and the Resource directory — above the figures it may see, and no *To-dos for today* or
  *Continue where you left off* card. Those two cards now follow `tasks:read` and client or note access, so a
  finance account no longer sees them either.
- **Client tabs by role.** Beside the six everyday tabs, a clinician's strip shows **Care plan** and
  **Assessments**, a supervisor's **Episodes** and **Care team** (when the modules are on); the rest stay under
  More. The tab strip still measures the row after promoting and folds what does not fit at 200% text (the
  1.15.1 reflow fix is untouched).
- **Funder report: which file do I send?** The three downloads are grouped under that heading, each with a line
  saying what it is for: **This report (Excel)** is the submission workbook for the funder (for a publication
  release, the file to publish once reviewed), **CSV** the same figures for a funder portal or data system, and
  **Export everything to Excel** every program sheet for your own checking, not for sending. The buttons and the
  publication review's gating are unchanged.
- Tests: `test/ui-eval.test.js` (the reminder through `POST /api/tasks`: assignee, creator, client, encrypted
  title and details, audit, found again by its reference, gone once done; the override count on the users list
  for user managers only). Browser: new `scripts/ui/ui-eval.mjs` (106 checks, with axe on each changed page),
  registered in `run-all.sh` (38 scripts); `ux-nav`, `programme` and `permissions-admin` follow the deliberate
  sidebar and Permissions-button changes.

## 1.15.1 — 2026-09-28

A way back in for the owner of SUDS on this device who has forgotten the password, and for an office
administrator who is locked out. No migration and no change on the office server's database; three new device
routes (`POST /api/local/recovery`, `POST /api/local/recover`, and `POST /api/local/recovery/saved`) that exist
only in the browser kernel, and one command-line script.

- **Recovery code for SUDS on this device.** When a device is set up, right after its first account is created,
  SUDS shows a recovery code once: seven groups of four letters and numbers. Download it as a text file or print
  it, keep it somewhere safe away from the device, and tick *I have saved my recovery code* to go on. SUDS never
  stores the code and can never show it again. Whoever has it can open every record on the device, like a key.
- **"Can't sign in?" on the device sign-in page** lists every way back in and says which keep the records:
  **Use your recovery code** (keeps every record: type the code and a new password; you are signed in and given
  a new code, and the one you used stops working), **Restore from a backup** (the backup's records, accounts
  and passwords; anything since the backup is lost) and **Start over on this device** (erases everything). A
  wrong code gets a plain message and each further try waits a little longer; after several the message says to
  check the saved file.
- **This device → Recovery code** shows whether the device has a code and when it was made. The person who
  manages the device can make a new one after typing their password again; the old code stops working at once.
- **Devices set up before this release have no recovery code.** When the person who manages one next signs in,
  Home asks them to make one. The reminder can be dismissed, but comes back at every sign-in until a code has
  been made and saved. Other accounts are not asked, and cannot make one.
- Using the code sets a new password for the person who manages the device, clears that account's lockout and
  turns off its two-step verification on the device (set it up again with the new phone). If that account has
  been removed or deactivated, the username typed becomes a new administrator account that manages the device.
  The audit log records who made or used a code (`device.recovery_code.created`, `device.recovered`), never the
  code.
- **Office server: `npm run reset-admin -- <username>`** lets whoever runs the server let a locked-out
  administrator back in (forgotten password, too many wrong attempts, or a lost authenticator phone). It prints a
  new temporary password once, which must be changed at the next sign-in, clears the lockout and two-step
  verification, ends the account's sessions and writes `admin.reset_cli` to the audit log. Having a shell on the
  server is the proof of ownership; there is still no shared or stock administrator password.

- **Client tabs fit at 200% text.** When the section you are on would have been under **More**, it took the place of
  the last tab that fitted but could be wider, and the row then ran past the screen (WCAG 1.4.10 reflow; found by
  the accessibility script at 200% text on a 1280 px screen). The row is now checked again after the swap.

## 1.15.0 — 2026-09-28

**Released under a policy exception.** 1.15.0 is a feature release one day after 1.14.0, where the release
policy allows one a month (docs/RELEASE.md). The owner approved the exception: the admin-managed per-user
permission overrides below are finished, reviewed and regression-tested, and a patch release cannot carry
them — they add schema migration 48 and five new API routes.

- **Per-user permission overrides.** The six fixed roles stay as defaults. An admin can now grant or revoke a
  single permission for one user, see their effective permissions with provenance (role / granted / denied),
  and every change is audit-logged with the reason, grantor and timestamp. Deny always wins, nobody can edit
  their own permissions, privileged grants stay admin-only, and reasons need at least 10 characters.
- **Deny-aware enforcement everywhere.** Effective permissions are recomputed on every request, on the server
  and in the browser kernel alike; the app's `can()` matches the server's deny ordering.
- **Mid-session refresh.** A signed-in user picks up permission changes from their profile without signing out
  and back in; `GET /api/me` serves the effective snapshot.
- "Users & roles" is now **Users & permissions**; per-user overrides are documented in
  `docs/security/IDENTITY.md`.
- The schema moves to version 48 (`user_permission_overrides`).

Note: overrides are not synced between the office server and devices — that sync needs its own design.

## 1.14.1 — 2026-09-28

A fix release from the retest of 1.14.0 on the live site. No migration, permission or route.

- **Home no longer blanks while it refreshes.** Home's 90-second refresh redrew the whole page, which showed
  "Loading…" with no heading until the figures came back, and each redraw started another refresh timer
  without stopping the last, so refreshes multiplied the longer Home stayed open. There is now one timer, and a
  refresh builds the new Home first and swaps it in whole, only while nobody is working in the page.
- The sign-in page's line reads "…with the privacy that substance-use records need".
- The phone/tablet page offers **Open SUDS** once; the notice that records stay on the device no longer
  repeats the link.

## 1.14.0 — 2026-09-27

**Released under a policy exception.** 1.14.0 is a feature release one day after 1.13.0, where the release
policy allows one a month (docs/RELEASE.md). The owner approved the exception so that the findings of the four
reviews of 1.13.0 (frontline, security, engineering, market) and of a usability evaluation ship together, with
the market gaps they named. The release gate now checks the monthly limit, so this exception is recorded, not
an oversight.

**Upgrade notes for administrators.** Four migrations run on start (schema 43 → 47), after the usual
pre-migration snapshot, which is now encrypted like a backup once the upgrade succeeds and deleted after 14 days:
44 adds SUPRT-A records; 45 moves supplies from one number per item to items, sites, lots and a stock ledger
(each 1.13 count becomes an opening balance at the Main office); 46 fills in a missing search index for sample
clients' preferred names; 47 adds indexes (the first start takes a few seconds longer on a large database).
The first start also compacts the database once, so values encrypted by earlier upgrades are not left in its
free pages. New permissions: `reports:funder` (finance, supervisor, administrator), `supplies:read`,
`supplies:receive` (navigator, clinician) and `supplies:*` (supervisor, administrator). Setting a supply count
now needs a supervisor or administrator. Downloading the key backup asks for the password or authenticator code
every time. Turning two-step verification off needs a current code.

### Frontline

- Home and the Reports dashboard now count visits recorded with no client — community naloxone distribution and street outreach. They used to leave them out, so an anonymous hand-out of ten kits appeared as two kits on Home while the funder report and NDP log said twelve. A supervisor's or administrator's visits, kits and test strips now match the funder report for the same period. A navigator's figures are their caseload's visits plus the anonymous outreach they logged themselves.
- The program's usual consent (Home → Finish setting up) now lets the administrator tick referral partners from the resource directory. Nothing is ticked in advance and crisis lines are not offered; ticked partners are remembered when the consent is reopened. It previously pre-filled six arbitrary directory entries, including 211 and 988, into a recipient too long to save. A consent's recipient can now be up to 2,000 characters. Form errors now say what to change in plain words ("… is too long: keep it under 2,000 characters") instead of "Validation failed: … max length 300".
- The setup wizard now asks what kind of funding the main fund is. For opioid settlement money it also asks the allowable use and California High Impact Abatement Activity, so the fund appears in the opioid settlement report. Previously every wizard fund was created as "other". When no fund is settlement money, or nothing was spent in the period, the settlement report now says so on the Reports page and in the file, instead of producing a header row with nothing under it.
- The overdose list now shows the naloxone doses that were recorded, and "given, doses not recorded" when none were entered. It used to show "1 dose" where the reports counted 0. The confirmation message now includes the doses, and a new overdose event starts on the worker's default fund, as a visit does.
- Home's setup checklist now has "Add your supplies": one click adds Naloxone kit and Fentanyl test strips to Supplies, and Supplies offers the same when they are missing. A visit that hands out kits or strips when the cupboard has no item for them now says they were not taken off Supplies, instead of silently leaving the count unchanged.
- Coded choices now read as words everywhere, exports included: "Court / probation", "EMS", "VA", "Opioids (fentanyl)", "Buprenorphine XR", "Non-binary", "24/7 crisis", "Co-occurring", "Read-only", "SOR grant", "SAMHSA". Patient-rights requests are now called client rights requests.
- A production server no longer offers "Load sample data" on Home; it remains under Settings › Program. The audit-anchor finding is now a plain sentence at the top of an administrator's Home, saying what is wrong, who fixes it and where the steps are, with a link to Security status. It is amber, turns red if an audit check has failed, and cannot be dismissed.
- A new account that must change its password no longer triggers a series of refused requests on the password page. "+ Log" now includes "Overdose or reversal". Home's activity card is headed for the role viewing it: finance and read-only no longer see "What you have been doing" over the program's visits. Countersigning several notes has a "Select all" checkbox.

### Usability: forms

- Recording a visit is a field note. The visit form shows what every visit has: who (optional for anonymous outreach and naloxone distribution), what was done, when, where and how, the supplies given and a short summary. Outcome & follow-up, Syringe services, Funding & cost, Time, Recorded by and Add a note are folded sections, opened from their headings with a mouse or the keyboard. A section opens by itself when it holds something or a field in it needs fixing, and otherwise stays as you last left it; folded, it says what it holds. A cost with no budget line is caught in the form. Nothing was removed.
- A new visit starts where your last one did. Your last visit's type, location and modality fill a new visit. Until you have one, the program's default location is used.
- The time a visit logs is visible, and not counted twice. "Also log this as a time entry" says what it adds ("adds 20 min of direct service to your time"). It is on the first time, because supervisors approve hours from these entries, and then keeps your last choice. Logging time by hand for a day and client a visit already covered says so before you save. Time entries now carry where they came from (visit, call or manual) in the API, so lists can mark them.
- A visit's note in the same dialog. "Add a note" in the visit form writes the note the summary cannot hold. It is saved with the visit in one step, as a draft on the client's record linked to the visit, with the Note form's permissions, formats, Part 2 flag, encryption and audit. If the note is refused, nothing is saved.
- Supplies with no item are said up front. When Supplies has no naloxone kit or fentanyl test strip item, the visit form says so before saving: the kits count on the visit and in reports but come off no stock. A supervisor or administrator can add the items right there. Kits are always entered in the one "Supplies given" list; the plain number fields appear only when the program keeps no supply items at all.
- New client is Quick add. "+ New client" asks for the name (or the name they go by), and a date of birth or phone if given. It creates the record and opens it, where "Add details" carries on with the rest of the intake. "Full intake" opens the whole form with what you typed. When an earlier discharged record is offered for re-admission, the reason is asked for in the same dialog. It needs 8 characters, not 15: that was the break-glass minimum, a different act. The offer rules and the supervisor's review are unchanged.
- A referral stays in one dialog. Recording a consent that names the provider, or adding a provider not in the directory, is now a step of the referral dialog, never a second dialog on top; Escape goes back. A new referral asks for its outcome and barrier only when it is entered as already over; otherwise they are recorded with "Record outcome".
- A consent asks what it covers once. The ticked categories are what a consent covers: SUDS enforces them, and they are written into the consent as its scope. Anything else the signed form says goes in an optional note marked "not enforced". What is enforced is unchanged, and no existing consent was changed.
- Referrals in and out. A client's intake asks "Who referred them to us"; the Referrals page is "Referrals we make".
- Save stays on screen. In every dialog, at every width, the row with Save and Cancel stays at the bottom of the screen while the dialog is longer than it. Tab and screen-reader order are unchanged.

### Usability: navigation and wording

- Reports, the funder report, Funding & spending, State reporting and SUPRT-A now say what they are working out while they load ("Checking small counts before the release is shown…") instead of a bare "Loading…". The funder report's submission is read from one snapshot of the data, as a publication release already was, so a visit saved while it runs can no longer appear in one table and not the next. (A reported 4–6 s load could not be reproduced: at seed size these pages open in under 0.4 s, and at 20,000 clients in about half a second.)
- The sidebar puts each role's daily pages first. A navigator's main list now includes Waitlist. The funder report is under their More menu, run for their own caseload, where it used to be missing. State reporting (CalOMS Tx and the county EHR hand-off) and SUPRT-A have their own menu entries whenever the program uses those modules.
- Every screen uses the same words for the same action: "Log a visit", "Make a referral", "Clients", and "To-dos for today" on Home. + Log and the client record's buttons both offer "Make a referral", which opens the referral form for that client with their consents.
- The client record shows the six sections used on every visit (Overview, Visits, Notes, To-dos, Consents, Referrals) on every screen size, with the rest under More. Care plan, Assessments and SUPRT-A tabs appear only when the module is on and the client has something in it or you can add to it. The Timeline tab is now "Recent activity" at the end of the Overview, and "All activity" opens the full history.
- The first-sign-in welcome is a single card on Home instead of a five-step dialog covering it, so a new worker can log a visit straight away. "Got it" puts it away, and "Help" at the foot of the menu brings it back.
- Your own overdue to-dos are counted in one place, the bell, and listed under To-dos for today. A supervisor's Home still shows the team's count, now labelled as such.
- Supplies has a "Hand out" button, on the page and on each item, for supplies given on the street. It opens the visit form as a naloxone distribution (or outreach for other supplies) with the item already on it, and the client optional. Home's "Naloxone kits given" now opens the visits that handed out kits, of any visit type, and those visits add up to the number shown.
- On a phone, tab strips that scroll sideways show a chevron on the side with more tabs, and the Supplies tab now reads "SSP report" instead of being cut off. The top bar's client-list shortcut now says "Clients", and the to-do bell's count stays inside the bell.

### Supplies and syringe services

- Supplies are kept by item, site and lot. An item has a category, and naloxone items record the product. Sites can be the office, a van, a drop-in or a partner site. Lots carry a lot number and an expiry date. Stock received, moved between sites, adjusted with a reason and disposed of is recorded in an append-only ledger, and what is on hand is its sum. Each count from 1.13 is carried in as an opening balance at the Main office.
- A visit or an anonymous outreach contact can record any item handed out, with the program's usual items one tap away. Stock is drawn from the visit's site, earliest expiry first. When the books hold less than was handed out, the difference is recorded as a flagged shortfall for a supervisor rather than the count going below zero. The naloxone and test-strip counts every report reads are now the sums of the visit's items; figures for visits recorded before 1.14 do not change.
- Visits record syringes and sharps returned, counted or estimated from the container's volume. A new syringe services summary gives participants, contacts, syringes out and back, the return ratio, sharps containers, naloxone by product, test strips and referrals, as CSV or Excel. Counts of people are small-cell suppressed.
- Expired and expiring lots, low stock and shortfalls appear on Home for supervisors and administrators. The NDP day log now names the naloxone product where the visit recorded it.
- Navigators and clinicians see the stock and record deliveries at their site. Items, sites, transfers, adjustments and disposal are for supervisors and administrators. Setting a count through the older supply routes now needs a supervisor or administrator.
- A device syncs supplies. Deliveries and counts recorded offline are checked at the office, and a visit's draw-down is worked out there once. The device's own draw-down shows correct stock in the field until the office's figures arrive.

### Reporting

- Finance can now write the funder report. A finance account runs the program's own submission of the funder report, the NDP log and the opioid settlement report: exact counts, for any date range or a single funding source. It still cannot open a client record, make an identified export or run an internal report, and its Home and Reports screens still show small counts as "<11". Before this, a small organisation's grants or finance person needed the supervisor role, which opens every client record. Each run is audited with who ran it, the purpose, the fund and the period.
- Publication releases can be switched off. Settings › Program › Modules › Publication releases is on by default. An administrator can switch it off while the program waits for an outside review of the small-cell method. Publication runs and their files are then refused with a message explaining why. Submissions to funders carry on, and read-only accounts are told they have nothing to run until releases are switched back on.
- SUPRT-A for State Opioid Response programs. Programs with a SOR grant funding source get SAMHSA's SUPRT-A record (baseline, reassessment, annual assessment and closeout) on each client's SUPRT-A tab. Answers SUDS already holds are filled in, and follow-ups due appear on the To-dos page. The SUPRT-A page shows completion rates and makes a file for entry into SPARS. That file names clients, so it needs each client's consent naming SAMHSA (or an evaluation approval on file) and is written to each client's accounting of disclosures. It uses SUDS's own item names and must be checked against the current SUPRT handbook; SUDS does not reproduce SUPRT-C.
- Settlement spending for DHCS or your county. The opioid settlement report can be downloaded in the DHCS settlement expenditure layout: one row per activity, with categories, amounts and people served filled in and the narrative left for the program to write. It can also be downloaded in a county's own template, which finance or an administrator sets up by listing the county's columns, with no code needed.

### Security

- Returning clients at intake: The intake duplicate check no longer offers a discharged record the worker cannot open when only the phone number matches. The surname and date of birth must match, and the offer says only that an earlier record exists and that a supervisor will review it: no client code, and not when or why the person was discharged. Each offer puts a review task on the record for a supervisor. The check is limited to 60 per worker in 15 minutes and every check is audited. Before this, typing phone numbers into a new-client form could reveal who had been discharged and why.
- Continue where you left off: The Home page's list of drafts and to-dos due today now leaves out clients the person can no longer open. Before, after an assignment ended, it still showed the client's name and to-do titles.
- Exports and unlinked records: Exports of calls, visits, to-dos and overdose events now follow the rule the screens already followed: a record with no client belongs to the worker who made it, or to a role that sees everyone. Before, a navigator's export could include another worker's crisis call that the screen refused to open.
- Time descriptions: Finance and other roles without access to client records now see another worker's time as category, fund and minutes, without the free-text description, which can name the client. Expense descriptions stay visible to finance, which approves spending by them, and the expense form now reminds staff not to name a client there.
- Password change and two-step verification: Wrong current passwords when changing a password or turning two-step verification off now count toward the account lockout and are audited, as they are at sign-in. Turning two-step verification off also needs a current code from the authenticator app. Before, these screens took unlimited guesses.
- Key backup: Downloading the encryption key backup now asks for the password or authenticator code every time, even just after signing in. Administrators who sign in through single sign-on confirm with the county sign-in, which covers one download.
- Plaintext left on disk after upgrades: SUDS now erases deleted data from the database file as it goes. After an upgrade that encrypted a field, it compacts the file so the old unencrypted values do not remain, and does this once on the first start of this release. The copy of the database taken before an upgrade is now encrypted like a backup once the upgrade has succeeded, and deleted after 14 days. Before, values encrypted by earlier upgrades could still be read from the file and from those copies.
- SUDS on this device, shared web addresses: The offline copy of the app now reads and clears only its own stored files, never those of other sites on the same web address (it used to delete other sites' caches on activate). The documentation recommends giving SUDS on this device a web address of its own, such as a custom domain, because browsers share stored data between sites on the same address.
- Publication releases: If one publication release check runs too long, only that release is refused. Others requested at the same time are no longer failed with it.
- The database a browser restore replaces is now kept encrypted like a backup (`suds.db.before-restore-<time>.enc`, opened with `node scripts/backup.js --restore`) and deleted after 14 days; copies an earlier version left in plaintext are sealed on the next start. Up to 1.13.0 it stayed beside the live database in plaintext.

### Sync

- Each table's write rules are now written once and enforced both by the office's screens and API and by a device's sync. Before, the sync code repeated each rule by hand and had drifted from the routes. Adding a rule to a table's rules file now applies it on both.
- A device's sync can no longer do what its user couldn't do in the app. It can't edit or delete another worker's visit, call, time entry, to-do, referral, expense, draft note or assessment, rewrite a court order or a Part 2 notice, change a signed note, or lift a client's legal hold. Work that belongs to a worker's own action still syncs: a discharge closing the client's to-dos and ending the care team, or recording a referral's outcome.
- Values the office would reject over the API are now rejected from devices too: unknown categories, out-of-range numbers, missing required fields, a cost without its budget line, a referral citing another client's consent, over-allocated budget lines. Work recorded offline that the office now rejects only because its lists, modules or fund periods changed while the phone was out is kept, shown on the device's sync screen, and recorded in the audit log for the office to review.
- An addendum written on a device now marks the signed note "amended" at the office, as it does in the office app. A disclosure recorded on a device is checked against the same consent rules as one recorded at the office, and flagged to the office if its basis can't be confirmed.
- Patient-rights (client rights) requests need the patient-requests permission to sync, the same one the office app needs.
- A large sync from a device is faster: a 10,000-row upload uses about a third less server time than in 1.13.0.
- SUPRT-A assessments recorded on a device pass the same checks as ones recorded at the office. Answers the instrument doesn't ask are refused. An assessment recorded while the module was on, dated ahead, or completed with answers missing is kept and flagged for the office to review. A device can't delete an assessment already sent in a SPARS file, and the client ID, grant and site in its answers are always the office's.
- Stock movements recorded on a device are held to what the Supplies page requires: damaged, expired or lost stock is only taken off, and a fund is named only on a purchase. A delivery to an item or site the office has since retired is kept and flagged.
- On a new program's Home page, "Add naloxone kits and test strips" adds the two standard supply items.

### Performance

- A device's first sync is much faster and a fraction of the download. The office server used to read every row of the caseload again on each page, and when newly assigned clients arrived it looked them up again for every table. A 2,000-client caseload took 19 seconds and 80 MB, and held the server for up to 4 seconds at a time. The server now finds where each page ends from its indexes and reads only the rows it sends: 5.5 seconds, 5 MB on the network, and no page holds the server for more than a quarter of a second. A sync with nothing new takes 23 ms instead of 160.
- Large answers from the office server are compressed. JSON answers of 1 kB or more are sent compressed (brotli, else gzip) whenever the browser or device says it can take them. That cuts a sync, the Supplies page and the lists to a tenth or less of what crossed the network. The compression runs off the server's main thread. Exports and file downloads are sent exactly as before.
- SUDS opens faster on a phone. The sign-in page used to download all 900 kB of the app first. It now loads the sign-in page and Home up front and fetches every other page the first time it is opened, compressed. The browser keeps the app's files and checks they are current rather than downloading them again. On a phone over a mobile connection the sign-in page is usable in 1.5 seconds instead of 5.8, and a return visit downloads 8 kB instead of 954. Signing in now draws Home once (it drew it twice), and Home asks for everything at once, so an administrator's Home appears in 2.2 seconds instead of 9.2.
- Home and the Reports dashboard are four times faster with a large program: 0.4 seconds instead of 1.6 for a fiscal year at 20,000 clients, holding up other people's requests for at most 0.15 seconds instead of 0.36. The figures are unchanged.
- The Supplies page and the supply alerts on Home open in a tenth of the time with a large stock ledger (37 ms instead of 306 at 50,000 entries). Saving a visit that hands out supplies takes half as long.
- The notes list, the visits list, deep pages of the client list and long client timelines are 3–12 times faster at 20,000 clients and 200,000 notes. With 50 people working at once the office server handles 48% more requests, and typical waits fall by a third to a half.
- For administrators: the upgrade adds indexes (migration 47), so the first start after it takes a few seconds longer on a large database (9 seconds at 20,000 clients, mostly the usual pre-migration snapshot). The app's own code files and icons are now sent Cache-Control: no-cache with an ETag instead of no-store, so browsers revalidate them rather than download them each time. They contain no client information. Pages, the service worker, version.json and every API answer stay no-store.
- For maintainers: scripts/bench/run.js seeds a 20,000-client program and measures the server, and scripts/bench/frontend.mjs measures a phone's first load (docs/PERFORMANCE.md).

### Engineering

- Small funds combined. A publication release now lists every fund that served fewer people than the threshold together in one row, "Other funds (n combined)". The row shows how many funds it holds and their staff hours; their people and services are withheld, as 1.13.0 already hid them. A year with 60, 80 or 120 small funds used to be refused because the check ran out of budget; it now publishes in a fraction of a second. The check's work budget now also counts the work of setting up each question and has been re-measured: 400 million units, about 2 to 7 seconds of one core.
- Reports no longer freeze the server. The publication release reads the database from one consistent snapshot in steps, so other users' requests keep being answered. A release that was already worked out is served without reading anything again, until the data changes. At 20,000 clients the longest pause fell from 0.6–1.5 s to 0.1–0.2 s, and a repeat request takes about 15 ms. The monthly report reads a month at a time (0.3 s → under 0.05 s). The opioid settlement report's services query is ten times faster with many settlement funds.
- Feature releases are checked too. The release workflow now refuses a minor or major release less than 28 days after the previous feature release, unless an administrator gives a policy exception. `policy_exception` is the new name for `allow_patch_changes`, which still works, and its reason is printed at the top of the release notes.
- Node 22 pinned. CI and the release run an exact, checksum-verified Node 22 release, as the Node 24 job already did. The deployment guide gives the plan for Node 22's end of life (30 April 2027): move to Node 24 LTS.
- Sample data search fix: preferred-name search index now written (and backfilled by migration 46 if done).
- Tests. Upgrade tests now use 1.13.0 and 1.11.0 databases with rows in every encrypted table. The browser-kernel parity tests now also cover the dashboard, a publication release and a full sync round trip.
- Idle keep-alive connections kept 65 s.

### Known limits

- The SUPRT-A items and variable names and the DHCS settlement layout were built from published summaries; the
  official SUPRT handbook and the DHCS reporting form could not be read from the build environment. Both exports
  say "check against the current handbook / form", and should be checked before a program relies on them.
- On a device (SUDS on this device, or a phone's copy), the publication release check still runs on the page's
  own thread (ADR-0009); the office server runs it in a worker.

## 1.13.0 — 2026-09-26

- A request that reaches the on-device database after it has locked (sign-out, idle, or a report still running) is answered as signed out and sends the person to sign-in, instead of logging an error.

### Frontline

From a second hands-on frontline review of 1.12.4.

- **A consent that backs a referral, from the referral.** When no live consent names the provider, the
  referral form offers **Record a consent naming <provider>**: the consent form opens filled in for it (a Part
  2 consent to disclose, the provider as recipient, "Referral and care coordination", and what the program's
  usual consent covers and when it expires), and on saving the worker is back in the referral with the new
  consent chosen. It used to open on the TPO class wording, which names nobody, so the referral was refused and
  the worker had to leave it and start again. Home's **Finish setting up** asks an administrator to save the
  program's usual consent naming its referral partners (filled in from the directory).
- **Small counts of people on Home and Reports for finance and read-only.** Those accounts run the funder
  report as publication releases only, yet the dashboard, monthly trends and outcome measures showed them exact
  small counts for any range. They now see a count of people from 1 to 10 as "<11" (the report's threshold),
  and a mean or rate over fewer people not at all; visits, calls, kits, hours and money stay exact. **Visits by
  worker** is shown only to supervisors and administrators. Consents expiring (client codes, recipients) are for
  roles that work with consents. Display-level consistency for insiders (docs/HIPAA.md), in
  `server/dashboard-mask.js`.
- **Client tabs in working order:** Overview, Visits, Notes, To-dos, Consents, Referrals, then the rest, on
  every width; Overview is no longer moved after Forms when the strip overflows. The tab is called **Consents**.
- **Referral list:** the client's name for roles that can open the client; **Consent on file** only when a live
  Part 2 consent names the provider, otherwise **No Part 2 consent** (was "ROI ✓" for any consent); **+ Referral**.
- **Finish setting up** also asks for a **default fund** when none is set, and for **the opioid-settlement
  category** of each settlement fund the settlement report would list as *Uncategorised*.
- **Wording:** "visit(s)" for the remaining "intervention(s)" (the Visits page count, Delete visit, imports'
  "Also log a visit"); **Program** for "Programme" in the screens and the user guide (code and setting keys
  unchanged); proper labels for coded choices ("Court or Probation", "Declined by Client", "Detox / Withdrawal
  Management", "Screening (SBIRT)", …) from `CODE_LABELS` in server/constants.js; badges wrap between words,
  never inside one, and stay on one line in a table on a wide screen.
- **Field defaults and small fixes:** a new Location, **Street / Outdoor**, is where a harm-reduction
  program's visits and overdose events start (the office for a treatment-adjacent one); the overdose *Where*
  never offers Phone or Telehealth; an overdose saved with *Doses given* empty no longer fails with a server
  error, and the confirmation says what was recorded; the client picker lists nobody until something is typed
  and closes when someone is chosen or focus moves on (a late answer no longer reopens it); either part of a
  double surname finds the client (*Vasquez* finds *Quintero-Vasquez*: each part's blind-index tokens are kept
  in `name_phonetic_idx`, no schema change, and existing clients are re-indexed once at start-up); a device copy
  no longer says "Also signed in on another computer … stays in sync"; the two-step verification bar, once
  dismissed, becomes a small **🔐 2-step** link in the header on every device instead of a 50 px bar.

### Funder reporting

- **The submission to your funder comes first.** A supervisor's or an administrator's funder report, NDP log
  and settlement report now open as the programme's own *Submission to your funder — not for publication*, with
  exact counts (what a funder asks for; *Small cells suppressed* is a choice). 1.12.4 opened a publication
  release whenever the period could be one, so the first click was often a refusal or a blank headline.
  Publication is an explicit step, **Prepare a publication release**, which lists anything withheld with the
  reason and asks for the review confirmation before a file is exported. Finance and read-only accounts, which
  run publication releases only, are told so and shown the release. The page says first, prominently, which kind
  of run it is; the notice above the figures is two plain lines, with the full counting statement behind *Why
  some numbers are hidden*. On Reports, *Kind of file* beside the NDP log and the settlement report offers the
  same three. **API:** with no `purpose`, a `reports:internal` role now gets `purpose=submission` (and
  `counts=exact` where it holds `reports:exact`; `counts=suppressed` turns it off); ask for
  `purpose=publication` to get a release. `suppression.label` names the kind of run.
- **Ordinary quarters publish again.** 1.12.4 refused the publication release of most quarters of 60 to 100
  people (the reviewer's simulation: 7 of 8 at 60, 6 of 8 at 80) and the fiscal year. The cause was the race
  codes: a code hidden beside a small one was hidden only when it pinned it, which said the small one was at
  least 2, and the check rightly refused. That hiding is now decided from the printout alone. The same
  simulation now publishes every quarter and month of 40 to 200 people with the headline shown and nothing
  withheld (docs/HIPAA.md has the table). The algorithm-aware attacker has a complete race-code family; it found
  a leak 1.12.4 published at a threshold of 3, and none now.
- **Degrade, don't refuse.** A table the check cannot show protected is withheld (listed, with a short reason, in
  `release.withheld_reasons` and on the page) and the rest is checked again and published; the release is refused
  only when even people served cannot be shown safely, when the degraded release fails too, or when the audit
  reaches its budget. A degraded release is checked against worlds that would have been degraded the same way.
- **The headline is never hidden beside figures that bound it.** When people served is hidden, new admissions
  and episodes opened are hidden with it (a 13-person programme printed served `suppressed` beside 13 new
  admissions).
- **Deterministic, and off the main thread.** The audit's budget is counted in solver work, not seconds, so the
  same figures give the same answer on an idle or a busy server (a 60-second backstop remains, logged). It runs in
  a worker thread: during a 5,000-person year's release the event loop is held about 120 ms (the read), not
  640 ms. The browser kernel runs it inline.
- **Reports dashboard.** A fiscal year's dashboard at 20,000 clients let the event loop go only at the end (0.7 to
  1.0 s held); it now yields after each query (about 0.18 s at most).
- **Docs.** docs/architecture/ADR-0009-publication-release.md records the design, its tests, its known limits and
  the pending independent statistical review.

### Engineering

- **Liveness and readiness probes.** `GET /api/health/live` (the process is up and its database answers) and
  `GET /api/health/ready` (database open, at this build's schema, no restore in progress) are new, and are
  what the Dockerfile `HEALTHCHECK` and the new `docker-compose.yml` healthcheck call. `/api/health` is
  unchanged but is for alerting only: it answers 503 for warnings a restart cannot fix (a certificate near
  expiry, a failed backup), so as a liveness probe it restart-looped SUDS. **Administrators:** point
  Kubernetes/ECS/load-balancer probes at the new endpoints (DEPLOYMENT.md, 4b). New routes, no migration.
- **Release policy enforced.** The release gate refuses a patch release that adds a schema migration, a
  permission or a route, unless the release is run with `allow_patch_changes` (the reason is printed at the top
  of the release notes). RELEASE.md records that 1.12.0–1.12.4 broke the cadence policy.
- **Tests.** Timing-dependent tests use condition waits and bounds relative to the machine; pure performance
  checks moved to `test/thorough/`, run by the `thorough` CI job (`npm run test:thorough`) instead of
  `npm test`. Migrations are now also tested from databases written by 1.9.4 and 1.11.0 (records present,
  ciphertext decrypts, audit chain verifies). A new test runs the browser kernel under sql.js in Node and
  requires the same answers as the office server for sign-up, client, visit, note, consent, referral and the
  funder report. It found a device defect, now fixed: a background save that landed while the funder report
  was running on a device (sql.js's export drops temporary tables) failed the report with "Something went
  wrong on this device"; saves now wait for the report to finish.
- **CI.** The Node 24 job installs a pinned version checked against a pinned SHA-256 (RELEASE.md says how to
  bump it). The WebKit job reports two service-worker cache checks that Playwright's WebKit on Linux cannot
  reproduce as skipped, with their diagnostics; iPhone offline-after-update is on the real-device checklist.
- **Docs.** The architecture overview describes the code after 1.12.4; RELEASE.md gives the browser suite's
  real size (31 scripts).

### Security

Fixes from the security review of 1.12.4.

- **Two-step enrolment can no longer be used to guess an existing code (high).** `POST /api/auth/mfa/enable`
  checked only that a user was attached to the session: someone with the password alone could skip
  `/mfa/verify` and its rate limit, guess the account's code there without limit or audit, and a right guess
  finished the sign-in. Enrolment is now only for a fully signed-in session of an account without two-step
  verification (forced enrolment after the grace period still works), shares the 10-per-10-minutes limit,
  is audited (`auth.mfa.enable.failed`), and every wrong code — at sign-in, enrolment or signing — counts
  toward the account lockout; for an account with two-step verification only the second factor clears it.
- **readonly (the default role for an unmapped SCIM user) can no longer open clients' filled forms (high).**
  `forms:read` is now the form library only; a client's forms, their PDFs and attachments need `clients:read`
  and the client on the caseload, and no single-client check passes for a role without `clients:read`
  except where the answer is keyed by client code only (finance's expenditures and time). A new test hits
  every GET route as finance and readonly with real ids and fails on any identifier. `scim_default_role`
  stays readonly, which can now be shown to identify nobody.
- **FHIR search no longer says whether an unconsented person is a client (medium).** Pages are drawn from
  consent-covered resources only, and a patient-type search with `_count=0` never has a `next` link.
- **A record with no client is its owner's (medium).** Unlinked calls (a crisis caller's name, number and
  words), outreach visits, community overdose reports, to-dos, time entries and expenditures were readable by
  every caseload-restricted worker, over the API and by sync. They are now visible to, and changeable by, the
  worker who recorded (or is assigned) them and roles with `clients:all` (`time:all`, `budget:approve`), the
  same over REST, sync pull and sync push.
- **SUDS on this device carries a Content-Security-Policy and a frame guard; `connect-src` is `'self'`
  (medium).** The static build had no CSP and could be framed; every page now has the office server's policy
  as a `<meta>` and `frame-guard.js` first. The office server's `connect-src` drops `https:` (every outside
  fetch is the server's). Local-mode sync defaults to the page's own origin; on a device a picture can be
  added from an address on this site only.
- **Sync sends only what the role could read (low).** Expenditures need `budget:read`; fund and budget-line
  amounts and grant details are left out for devices without it.
- **File names and document references are encrypted (low, migration 42).** A form attachment's and an
  import's file name and a consent's document reference move to `filename_enc` / `document_ref_enc`.
- **The key backup needs recent re-authentication.** `POST /api/admin/keys-backup` (was `GET`) asks for the
  password or authenticator code again, or a confirmation within the signing window, and is audited with the
  method; failures as `keys.download.failed`.
- **The shared OneNote notebook is for supervisors and administrators.** Browsing and fetching it needs the new
  `graph:import` permission; others import what they upload themselves.
- **The intake duplicate check no longer reveals clients on other caseloads.** It used to count them
  (`hidden_duplicates`) and refuse the intake. Now the worker's answer is the same as for no match, the intake
  goes ahead, and a supervisor gets a review task on the existing record. Visible matches and re-admission of
  a discharged record are unchanged; a device's warning names only records its user may open.
- **Outbound requests connect to the address that was checked.** The SSRF guard resolved and checked a name,
  then let `fetch()` resolve it again (DNS rebinding). Without a proxy the connection is now pinned to the
  checked address (Host and TLS name unchanged); a name that cannot be resolved is refused unless a proxy is
  really in use (`HTTPS_PROXY` *and* `NODE_USE_ENV_PROXY=1`), and then only for `ENOTFOUND`/`EAI_AGAIN`.
- **Purpose-separated subkeys.** New uses of `SUDS_INDEX_KEY` get an HKDF-SHA256 subkey (`crypto.subkey`); the
  single sign-on state cookie is the first. The audit chain and blind indexes keep the index key
  (docs/security/ENCRYPTION-AND-KEYS.md).
- **Audit anchors hourly by default (`AUDIT_ANCHOR_HOURS`, was 6).** Entries written after the newest anchor
  are what someone holding the database and the index key could delete undetected; the window is now
  documented (docs/security/LOGGING-AND-AUDIT.md). A year of hourly anchors is about 4 MB; writing one takes
  ~0.1 s and a full verification ~0.2 s.
- **A court order's and a registered agreement's document reference are encrypted (migration 43)**, as a consent's was: `document_ref` ("court order, J. Smith case file") moves to `document_ref_enc`; the API field keeps its name, and older kernels' pushes are mapped (sync-tables legacy).

## 1.12.4 — 2026-09-26

- **The first user is "guest".** A new office server creates its first administrator as `guest`
  (`SUDS_ADMIN_USERNAME` still names another); its password stays random per install, printed once and
  changed at the first sign-in, so no working credential is shared between installs. The setup wizard and the
  on-device first-account form suggest `guest`; the person chooses the password.
- `npm test` runs a sample of the publication-release disclosure sweeps; the full sweeps (`SUDS_THOROUGH=1`)
  run in a new CI job, `thorough`, which the release gate requires.

- **The pattern of what a publication release hides no longer gives counts away to someone who knows the
  method.** SUDS is open source, so an attacker can run the audit on every programme that could lie behind a
  printout and keep those that print the same. Against 1.12.3 that worked: 12 served beside "on MAT <11"
  was printed only when one person was on MAT (two or more hid the total), events 12 beside reversals "<11"
  meant one reversal, and a withheld table said the total was not 1, or that everyone served was on MAT.
  The audit decided which unprinted counts to protect, and which cell to hide first, from true values it
  does not print. Now:
  - whether a count must be protected is decided from its feasible range given what would be printed, never
    from its true value, and the cells hidden to protect it are taken in a fixed structural order;
  - a total whose every part is "<T" is hidden by the symbols alone, with the counts of at least T under it;
  - every cell a release hides is checked against the method: SUDS finds worlds with the same printed
    figures, runs them through the same suppression, and keeps those that print the identical release; the
    cell must be shown by those worlds able to be 1 and to range over half the threshold, or the release is
    refused. Against the printout alone the audit still asks for 1 and T-1, as near them as the printout's
    symbols allow (served "<11" beside women and men "<11" says there are at most 9 women whatever else is
    printed).
  A new test enumerates every world of small families (people served and a subset up to 25 people, women
  and men and MAT, overdose events and reversals in one and two months, two funds; thresholds 3, 5 and 11),
  runs the real release on each and checks every hidden cell over the worlds that print the same; it finds
  the reviewer's cases in 1.12.3 and nothing in this version. The price: a small programme at a small
  threshold is refused more often (publish a longer period); a 5,000-person year is still published: read, audited
  and checked in 0.6 to 1 s (0.15 s before the check). What the check does not prove, and what it leaves to the tests, is in
  docs/HIPAA.md ("The pattern of what is hidden" and the residual risks).
- **Publication releases are labelled for what they are.** "Suitable for publication" is gone: a release is
  *Publication release — small cells screened; review before sharing* on screen, in its counting statement,
  on its files' About sheet and in their filenames (`…-publication-screened-review-before-sharing`). Its
  files download only after the person ticks *I have reviewed the withheld and small figures before sharing*;
  the API needs `reviewed=1` on a publication release's export (428 otherwise) and writes
  `report.publication.reviewed` to the audit log with the report, the period and the release id. Internal and
  submission files are unchanged, and the `X-SUDS-Report-Purpose` header still says `publication`.
- docs/HIPAA.md states that any deterministic suppression pattern can leak to an attacker who knows the
  method, what this version does about it, what remains, and that the method is a conservative default, not
  an expert determination (45 CFR 164.514(b)(1)). docs/market/EVALUATION-RESPONSE.md is brought up to date
  through this version: the release gate, the instance lock, device encryption, and the published small-cell
  counts as open pending an independent statistical review.

## 1.12.3 — 2026-09-26

- **Which rows a publication release lists no longer gives anything away.** An independent attack on 1.12.2
  read the rows themselves: the NDP log listed only the months with a reversal, and the funder report only
  the months, discharge reasons and "given by" codes that were used, so ten rows marked `withheld` beside
  "staff <11" meant exactly one reversal a month. A publication release now lists every month of the period
  and every code of those lists, zero or not, in a fixed order (never by size, which told which hidden cell
  was larger), and a table withheld whole prints no rows. Episodes opened, closed and open at the end, and
  the naloxone doses used (every reversal records one to twenty), are now part of the audit, so they can no
  longer narrow a hidden count; doses are hidden with the reversals they would reveal. Closing an episode
  before the day it opened is refused.
- **A release the audit cannot verify is refused, not published.** Every hidden count is checked again when
  the audit stops; if any is still exposed, or the audit runs past 5 s, the three reports answer that the
  period cannot be published (internal runs are unaffected). The audited release is shared by the three
  reports, and rare typed-in values beyond the first ten per breakdown are combined as "Other (combined)":
  800 one-person languages audit in milliseconds instead of 20 s per report.
- The funder report, the Reports page and every publication file's About sheet say what to do before sharing
  a release: publish each period once and never nested or overlapping periods, review what is withheld, and
  treat the suppression as a conservative default, not an expert determination.
- docs/HIPAA.md no longer says read-only accounts hold `export:read` or that the monthly trends report is
  not audited.

## 1.12.2 — 2026-09-26

- **A publication release is audited as a whole.** An independent check of 1.12.1 still recovered hidden
  counts: the settlement report printed a total the funder report had hidden, and a month's reversals (never
  more than its overdose events) pinned a hidden cell. Protecting table by table kept missing links. Now a
  period's funder report, naloxone log and settlement report form one release, computed from one reading of
  the data. Every number the three print goes into one set of constraints (breakdowns add up, subsets and
  reversals are bounded, a settlement use lies between its funds). An exact integer solver (`server/sdc.js`,
  no dependencies) then checks how far each hidden cell could still range. Cells are hidden until none can be
  narrowed below the protection rule, or the table is withheld. A separately written attacker, searching all
  three reports of 250 random programmes, cannot pin a hidden cell. A year for 5,000 clients audits in about
  0.15 s. The price: a small programme sees more cells hidden and some sparse tables withheld.
- **Who the suppression protects is stated plainly** (docs/HIPAA.md): the recipients of a published release.
  Staff with reporting or export access can already see de-identified rows and exact figures; permissions and
  the audit log govern them. As defence in depth, internal and submission runs now need `reports:internal`
  (supervisors and administrators; navigators and clinicians for their own caseload). Read-only and finance
  accounts get publication releases, with money and hours exact. The monthly trends report is now audited.
- A navigator's caseload report counted overdoses and people per fund for the whole programme; it now counts
  the caseload only, and says so.
- "Back up now" reports why a backup failed instead of answering with a server error.
- On a device restored from a backup, an account dropped at the key change is told what happened and who can
  let it back in; the device audit names the accounts dropped.
- The multitab browser test now waits until the first window is really frozen before a second one takes
  over; an idle window never stopped at the debugger's pause, so that case sometimes tested nothing and then
  failed when it tried to resume.

## 1.12.1 — 2026-09-26

- **Small cells: publication releases that hold up.** Two leaks in 1.12.0's "suitable for publication" counts
  are closed. (1) Differencing across reports: a run filtered to one fund, or for a custom range, could be
  subtracted from the whole-programme report to reveal a small group. Only the whole programme, for one
  calendar month, quarter or year (starting January, April, July or October) that has ended, is now a
  publication release; every other run is *internal, not for publication* and asking to label it for
  publication is refused. (2) Within one report the total was hidden too late: a complete breakdown still
  printed it. Tables sharing a total are now protected together to a fixpoint, keeping the total visible
  when hiding more cells is enough, and the attacker is assumed to know that a `suppressed` cell is at least
  the threshold. Published, the NDP log is by month and matches the funder report's reversals; "Who gave the
  naloxone" counts reversals. Cross-period differencing (a quarter and its year) remains a documented
  residual risk (docs/HIPAA.md, *Small cells in aggregate reports*).
- **Restore and backups share one lock.** A restore while a scheduled backup, snapshot or recovery drill was
  running swapped the database, then failed to record the new sync generation and the restore's audit anchor
  (and the concurrent backup was written damaged). Backup, snapshot, drill, offsite copy and restore now take
  turns; a restore waits up to two minutes, then says what is running; after the swap the generation and the
  anchor are written or the previous database is put back.
- **Sync pages the history of newly assigned clients.** Up to 1.12.0 it all rode on one page (one client with
  40,000 visits: 40,531 rows, 25 MB); it now follows in pages within the limit, and older device builds keep
  working.
- **Instance lock tells containers apart.** Two containers with the same hostname (host networking, a fixed
  `hostname:`, a rescheduled pod) and the same process id are no longer taken for the same process: the lock
  also records the container's root filesystem and machine identity.
- **A restored device moves to a fresh key** the first time a backed-up account signs in, so the key inside
  the backup file no longer opens what the device records afterwards.
- **Sample data never has a time in the future.** "Today at 5 pm" was written before 5 pm, and such a record
  reached no device until its time came; the sync test that caught it failed now and then, depending on the
  time of day.

## 1.12.0 — 2026-09-26

Answers the critical evaluation. The owner chose to commit (its option B) and to reposition SUDS around
what it does best (option C): the operations system for harm-reduction and prevention programmes —
outreach, naloxone and supply distribution, and grant reporting — with Part 2-grade privacy. The clinical
modules stay, as options. Point-by-point response: `docs/market/EVALUATION-RESPONSE.md`.

- **Programme profile.** "Harm reduction & outreach" (new installs) or "Treatment-adjacent" (an upgraded
  database that holds any clinical record keeps everything visible). Care plan, assessments, CalOMS Tx, the
  FHIR API and the EHR hand-off can each be switched on or off in Settings › Programme; an off module refuses
  new work on the server and the FHIR API closes. Records already made stay readable.
- **Front-line screens.** Navigators and clinicians get a ten-item menu; programme pages sit in a Programme
  section for the roles that run it. One word per concept: Visit, To-do. On a phone the client page puts its
  actions under one "Add…" button and shows five tabs. Settings folds into sections; Reports groups its exports.
- **Notes and supervision.** "Save & sign" in the note editor; within 10 minutes of signing in (a setting)
  signing needs only a confirmation, otherwise the password or authenticator code. Supervisors see client
  names they may already open, rows open the record, and several notes can be countersigned at once.
- **Consent and referral.** A referral pre-selects the one live consent that names the provider; a duplicate
  consent is flagged; a programme can save its usual consent as a template.
- **Grant reporting.** The funder report runs about ten times faster (4.9 s to under 0.5 s at 20,000
  clients) and no longer stalls the server. Small cells are suppressed by default; the programme's own
  submission may use exact counts (`reports:exact`). Visits take the worker's or programme's default fund;
  unfunded visits and logged-but-unapproved hours are shown with warnings. New: a naloxone distribution and
  reversal log in the shape of the DHCS Naloxone Distribution Project's reporting, and opioid settlement
  spending by allowable-use and High Impact Abatement Activity category — both marked for checking against
  the current templates (`docs/compliance/HARM-REDUCTION-REPORTING.md`).
- **On-device records are encrypted at rest.** The device database and its field keys are sealed with
  AES-256-GCM under a key each device account's password unlocks (PBKDF2, 600,000 iterations); the app is
  locked after every reload until someone signs in; existing devices are sealed at the next sign-in and the
  plain copies erased. A forgotten password on a standalone device is unrecoverable without another account
  or a backup, and the app says so (`docs/architecture/ADR-0008-device-encryption.md`).
- **Release gate and recovery evidence.** A release is refused unless CI — tests, Node 24, the full browser
  suite and a backup-and-restore drill — passed on that exact commit. CI restores a 20,000-client backup
  into a fresh server on every push; a development-environment drill report is in `docs/evidence/`.
- **Reliability.** The instance lock no longer refuses to start after a crash when the server is process 1
  (Docker) or after a reboot; scheduled backups no longer block the server (longest pause 16 ms on a 311 MB
  database); a missing index is rebuilt or reported; a browser window frozen in the middle of a save can no
  longer hang another window that takes over. The browser job that failed on 1.11.0's main-branch CI was the
  multitab script unable to fetch the 1.9.0 build in a shallow clone; it now fetches that release's tag, and
  the suite repeats each failed script's last lines at the end of its log.
- **Security.** Two sync leaks closed (staged imports went to every device; ending an assignment never left
  the device) and a newly assigned client now arrives with its whole history; one guard for every outbound
  fetch (region pictures, OIDC, FHIR JWKS) closes an IPv4-mapped-IPv6 bypass; the service worker never caches
  FHIR or SCIM; download names with non-Latin characters no longer fail; HSTS behind a TLS proxy; a consent's
  witness and imported name hints are encrypted; new accounts have 3 days, not 14, to set up two-step
  verification; a later device sign-up cannot make itself administrator.
- **Honest documents.** Pitch rewritten around harm reduction; the software is MIT-licensed and free, paid
  offers are services priced as unvalidated hypotheses; a realistic business-hours support template; a
  hosting model saying who is called at 2am (`docs/market/HOSTING.md`); unmeasured time savings turned into
  a pilot measurement plan; development described as AI-assisted with automated gates. Architecture decision
  records for a new maintainer in `docs/architecture/`; feature releases at most monthly.
- **Found by an independent re-evaluation before release, and fixed:**
  - The instance lock records the host and the holder refreshes it every 10 s: a second replica or a second
    host on shared storage is refused while the holder lives (a crashed one is taken over after 45 s), and the
    same container restarting after a crash is let straight in.
  - A funder report filtered to one fund showed the whole programme's staff hours and unfunded counts.
  - Counts "suitable for publication" now hide every small count of people in every table — per fund,
    overdoses by month, the naloxone log, the settlement report — with complementary suppression so no hidden
    cell can be worked out from a total; kits, doses, services, hours and money stay exact.
  - A reversal is always counted as naloxone used, and its location uses the same list as distribution.
  - Wrong signature passwords count toward account lockout; an authenticator code is accepted once; staff who
    sign in through the county's single sign-on can confirm a signature with it.
  - Batch countersign takes a comment per note and refuses one comment across different clients.
  - Completing the setup wizard on the same computer no longer loops and rate-limits the first sign-in.
  - Harm-reduction wording on sign-in and the tour; flag labels instead of codes; a one-line two-step banner
    on phones; the wizard recommends offline copies for outreach programmes and can create the main fund.
- Schema migrations 38 (default funds, settlement categories), 39 (witness and import hints encrypted),
  40 (recent re-authentication), 41 (single-use authenticator codes).

## 1.11.0 — 2026-09-25

Answers the California county marketability review: SUDS as the operations system for grant-funded,
non-billing prevention, harm-reduction and outreach programmes, beside the county EHR. Market pack in
`docs/market/README.md` (positioning, buyer guides, pilot kit, procurement, readiness scorecard, draft
BAA/QSOA, DPA, SLA and pricing for counsel review).

- **42 CFR Part 2 (2024 final rule)** — control matrix in `docs/compliance/PART2.md`.
  - Consents record every §2.31 element (who may disclose, signer, right to revoke, consequences of refusing)
    and print as a PDF; a single consent for treatment, payment and operations; separate consents for SUD
    counseling notes and for legal proceedings. A general ROI is no longer accepted as Part 2 consent in a Part 2
    programme (`part2_program`, on by default).
  - Disclosures under a court order need a recorded, qualifying subpart E order; information for a proceeding
    against the client needs one (or a proceedings-only consent); counseling notes need their own consent;
    agreed restrictions must be confirmed before sharing. Identified exports state their lawful basis.
  - One 2024 §2.32 notice travels with every disclosure: referrals, exports (Excel About sheet, CSV last row,
    header), form and consent PDFs, printed accounting and notes, FHIR responses, the CalOMS extract and the
    county EHR hand-off. Client records carry a "42 CFR Part 2" label.
  - Privacy & Part 2 page: the §2.22 patient notice (editable, versioned, recorded per client, Home reminder), a
    §2.4 complaint log, and an incident/breach register with the 60-day, HHS and media notification clock. A
    failed audit check, audit anchors that no longer match, a flagged emergency access, or a very large
    identified export open a draft incident. An incident keeps its own snapshot of the clients affected, and
    its title is encrypted.
  - A consent covers a disclosure only when it names that recipient; a disclosure under any other basis (a
    qualified service organisation, research, audit or evaluation) needs an agreement on file in the new
    Agreements register. The §2.31 elements are checked again at the moment of disclosure and on consents that
    arrive by sync, not only in the form. Turning `part2_program` off needs a recorded reason.
  - Changing a referral's agency re-checks the consent against the new agency and accounts it; a referral
    pushed from a device (a new warm hand-off, one progressed offline, a new agency) passes the same gate.
  - De-identified exports now meet HIPAA Safe Harbor: dates to the year, ages over 89 as `90+`, restricted
    three-digit ZIP areas as `000`, coded values only (free text never leaves), and record ids drawn at random
    for each export. A client's discharge reason is chosen from a list. Row-level exports and most aggregate
    reports do not suppress small cells, and the docs say so.
- **County IT evidence** — `docs/security/` (architecture, encryption and keys, identity, audit, backup and DR,
  data lifecycle, vulnerability management, SDLC, incident response, SOC 2 readiness mapping, pre-answered
  questionnaire, pen-test scope). SUDS holds no SOC 2/ISO/HITRUST attestation and says so.
  - Recovery drill (`npm run dr-drill`, or Settings → System & backups): restores the newest backup into a
    temporary copy, never the live database, checks it end to end including a two-step sign-in, measures RTO and
    RPO against targets and writes a signed report; optional monthly schedule.
  - Audit anchors: the audit chain's head is sealed to `AUDIT_ANCHOR_DIR` (point it at write-once storage;
    optionally syslog) every 6 hours, at every backup and after a restore, so a rewrite of the whole log by a key holder is
    detected. Two anchors in the same millisecond no longer collide (one was silently dropped).
  - Auditor export of the audit log with a signed manifest, verifiable offline (`npm run verify-audit-export`).
  - "Require single sign-on" with named break-glass administrators; "Require two-step verification for every
    role"; a report of accounts without it. Settings → Security status: a read-only page for IT reviewers.
  - The audit log is append-only in the database itself: triggers refuse UPDATE and DELETE outside the
    retention purge. In production, anchors on the data disk are reported as a failure. Drill reports and audit
    exports are signed with Ed25519.
  - The drill can prove the escrowed keys (`--keys-file`) and restore from the offsite copy; stale drill copies
    are swept at startup. Snapshots every few minutes (`backup_schedule_minutes`); a warning when backups are off.
  - Audit retention cannot be set below six years (a lower setting is raised and reported). Reasons typed
    when deleting, merging, holding or reopening a record, or vacating a court order, are stored encrypted and
    kept out of the audit log; so are addendum and revocation reasons, countersignature and reviewer notes,
    transfer notes, time and expenditure descriptions, form notes and safe-contact notes.
  - Identity: trust the identity provider's MFA claim (opt-in; `mfa`, two factors of different kinds, or a
    configured `acr` — a lone one-time code is not enough), deprovision accounts not seen at the IdP for N
    days, and SCIM 2.0 user provisioning at `/scim/v2`. SAML is not supported (OIDC only).
  - Hardened Docker image, compose file and systemd unit; deployment guidance for county VMs, Azure Government /
    AWS GovCloud tenants and a warm standby.
- **Clinical depth (CalAIM documentation redesign)** — `docs/compliance/CALAIM.md`.
  - Problem list with optional ICD-10-CM and social-determinant Z codes, full change history; notes record the
    problems they address.
  - Care coordination plan: goals in the client's words, review dates with an overdue alert, steps that can
    create to-dos; printable.
  - ASAM-aligned six-dimension ratings (not an ASAM-endorsed instrument) with recommended vs referred level of care.
  - PHQ-9, GAD-7, AUDIT-C, DAST-10 (optional, off by default until the county confirms its licence) and a
    wellbeing rating, scored automatically with trends; PHQ-9 item 9 above
    zero raises a safety alert. Reports → Outcome measures with a de-identified export.
  - New permissions `careplan:*` and `assessments:*`; assessments sync only to roles that can read them.
  - No eMAR, e-prescribing or claims (out of scope).
- **CalOMS Tx and the billing boundary** — `docs/compliance/CALOMS.md`, `docs/SCOPE.md`.
  - Admission, discharge and annual-update records per episode (off by default; Reports → State reporting),
    DHCS-style edit checks with a validation report, and an extract with the monthly provider activity report;
    records with fatal errors are held back. The preview names nobody and cannot be submitted; "Produce submission
    file" builds the file once, keeps it encrypted with its hash, accounts each client in it as a state-reporting
    disclosure and serves exactly those bytes again. **The
    code sets and layout are not yet verified against the current DHCS data dictionary** (the spec could not be
    fetched); verify before a county submits.
  - County EHR hand-off: encounters per client per day for entry into SmartCare or billing, identified and
    accounted; a file-wide basis is a consent, QSOA or internal, never "other". SUDS does not submit Drug Medi-Cal (837/Short-Doyle) claims.
- **FHIR R4** — `docs/integration/FHIR.md`. A read-only API at `/fhir/R4` (Patient, EpisodeOfCare, Encounter,
  Consent, ServiceRequest, Task, Observation, DocumentReference metadata, the resource directory) with Bulk Data
  `$export`, SMART Backend Services sign-in (private_key_jwt, RS384/ES384) or a client secret usable only at the
  token endpoint, scopes and rate limits (Settings → FHIR clients). Bulk output is encrypted at rest, re-checked
  against consent at download and accounted at first download; export jobs survive a restart. Resources
  validate against US Core. A consent records the categories of information it covers, and FHIR serves only
  those; an existing consent covers everything over FHIR only when its wording plainly says so. The no-redisclosure label is now `NORDSCLCD` (HL7 retired `NORDSLCD`). A client's records are
  returned only under a live Part 2 consent naming the organisation for its purpose; counseling notes and
  restricted clients are never served; a search for one person never reveals whether they were withheld; every
  client disclosed gets an accounting row.
- **Accessibility (WCAG 2.1 AA)** — `docs/accessibility/ACR-WCAG21.md` (VPAT 2.5), `STATEMENT.md`, and an
  accessibility statement page linked from sign-in and the menu.
  - `scripts/ui/accessibility.mjs` (axe-core, test-only) audits every page, client tab, Settings tab and about
    60 dialogs for all roles on both builds, at desktop and phone widths, light and dark, and 200% text, plus
    keyboard-only walkthroughs; it runs in the browser suite and CI and fails on any finding.
  - Every page has its own title; focus goes to the new page's heading; dialogs make the page behind them inert;
    tabs are navigation with the current section marked; colour is never the only cue; dark-theme contrast,
    3:1 field borders and a clear focus ring; reflow at 320 px and 200% text; the idle warning has "Stay signed
    in"; Home's refresh can be turned off.
  - The conformance report says how each criterion was evaluated; 4.1.2 and 4.1.3 are "Partially Supports"
    until screen-reader testing is done. Scrolling tables keep a tab stop at 200% text.
  - Remaining partials are stated: untagged generated PDFs, uncaptioned pictures, the administrator's maximum
    session length, and screen-reader testing still to do.
- **Security fixes found along the way:** an intake API key must now carry the intake scope (any key could stage
  notes before).
- **Market documents say only what is true:** claims qualified throughout `docs/market/` and `docs/security/`.
- Reference lists (funding types and the like) no longer go empty for a moment while they reload.
- Schema migrations 29 (clinical depth), 30 (CalOMS), 31 (Part 2), 32 (FHIR sign-in), 33 (append-only audit and
  identity), 34 (disclosure gate), 35 (consent categories, CalOMS submissions), 36 and 37 (typed text encrypted).

## 1.10.2 — 2026-09-25

- **Pictures without the file window.** A resource's Pictures card has **Add from a web address** (an https
  address of a picture, or of a web page whose preview picture is used), and picture files can be dragged onto
  the card or pasted on the page. The office server downloads the address with the same checks as provider
  pictures and records only the site name in the audit log; on SUDS on this device the browser fetches it and
  explains when a site does not allow that. New route `POST /api/resources/:id/photos/from-url`
  (resources:write). **+ Add pictures** is unchanged.
- **Downloads refuse names that point inside the county network.** Provider pictures and "Add from a web
  address" now resolve each address (every redirect hop) before connecting and refuse loopback, private,
  link-local and similar addresses; before, only the name was checked, so a public-looking name that resolved
  to an internal server was fetched.
- **QA round 4 (what an automated tester reading the accessibility tree reported on 1.10.1).**
  - Home's numbers and bars link only to pages the viewer may open; a read-only account no longer lands on
    "Not available for your role".
  - The client header's badges are a list, and the status reads "Status: Inactive" to a screen reader instead
    of running into the risk badge.
  - A dialog no longer copies its title into the page's live region (a second "Add resource" / "New task" in
    the accessibility tree).
  - The Home empty-state sentence is under 100 characters (a tool that cuts text at 100 read "…or compute").
  - Sample data has a read-only account (`rreader`); new browser script `a11y-round4`.

## 1.10.1 — 2026-09-25

- **Signing out no longer draws the sign-in page twice.** The second draw blanked the screen for a moment (or,
  on a slow device, showed two sign-in forms); it is also what made the local-mode browser check fail
  intermittently in CI, where the click landed on the screen-reader status region during the blank. Full-screen
  pages (sign-in, set-up, MFA) are now built first and swapped in whole, and only the latest render wins.
  The same screen already showing is kept rather than replaced, so a re-render never throws away what was
  being typed into the sign-in form.
- **QA retest fixes (reproduced on the published build, as the tester uses it).**
  - SUDS on this device: supply items can be added and counted again — it has no office, so it no longer
    refuses supply changes with "kept at the office". On a device that syncs with an office, the Supplies
    buttons are disabled with the reason shown, and save errors also appear as a toast.
  - `#/getapp`, `#/phone`, `#/app` and `#/install` open "Use SUDS on your phone or tablet"; `#/devices` opens
    This device (on the office server, Settings › Synced devices for administrators).
  - Home and the welcome tour greet people by their whole display name, not its first word.
  - Date fields accept years 1900–2100, so Chrome's year box takes four digits, and a garbled date such as
    0006-09-05 is refused with a message instead of saved. Each date field has its own calendar button.
    Toasts no longer take taps or clicks meant for the page or dialog under them (a "saved" toast could sit
    over a dialog's date field).
  - "+ Add pictures" says a file window has opened (and when none was chosen). The import drop zones can be
    used from the keyboard and by screen readers.
  - Settings: new **Organisation time zone**, which overrides `ORG_TIMEZONE` for visit dates, report periods
    and "today", is sent to synced devices, and defaults to the browser's zone on SUDS on this device. Device
    copies no longer show the server backup schedule (it read "every 0 hours / keep 0") and link to This
    device (backup and restore) and the phone/tablet page instead. The office backup schedule says whether it
    is on and links to System & backups.

## 1.10.0 — 2026-09-24

- **The GitHub Pages build is now SUDS on this device, a production web app — not a demo.** The
  "Demo/evaluation build" banner and its `--demo-banner-h` layout machinery are gone, and no screen calls it a
  demo or an evaluation copy. It keeps its records encrypted in the browser that holds them, never syncs, and
  says so honestly (`docs/WEB_APP.md`, *Where your records live*). "Try it with sample data" remains, folded
  away below the Sign up form, and sample data is now only offered to an empty device (as on an office
  server), never mixed in with real records.
- **Log in / Sign up on the sign-in page**, on both builds: a two-option tab list (arrow keys, 44px targets on
  a phone), deep-linkable as `#/login?mode=login|signup`, with the programme contact in the footer.
  - *Office server:* Sign up requests an account (name, username, optional email, password, a line about the
    role). `POST /api/auth/signup` is unauthenticated, needs the CSRF header, is rate limited per address
    (`SIGNUP_RATE_LIMIT`, default 5/hour), answers the same whether or not the username exists, and is audited
    as `user.signup.requested`. The account cannot sign in until an administrator approves it under
    **Settings → Users & roles → Access requests (N)** (`POST /api/users/:id/approve` with the role and an
    optional supervisor, or `/decline`); the correct password on a pending account is told it is waiting,
    anything else gets the ordinary failure. The MFA grace period runs from approval. Home and the Users tab
    show administrators how many requests wait. New setting `self_signup` (on by default); off, Sign up says to
    ask an administrator and the route answers 403.
  - *On this device:* the first Sign up is the first-run set-up and makes that account the device's manager;
    later sign-ups create navigator accounts at once, and from the second account on everyone sees only their
    own caseload. The manager can turn sign-ups off (`/api/local/signup`, `/api/local/device`).
- **Safeguards for records that live only on a device.** First-run Sign up states once where records are kept
  and that clearing site data or losing the device loses them, and requires a checkbox. **This device** (the
  page formerly called Sync on this build) shows whether the browser has granted persistent storage
  (requested at account creation) and the last backup. **Download a backup** makes a passphrase-encrypted
  file (WebCrypto PBKDF2-SHA256, 600,000 iterations → AES-256-GCM; `local/backup.js`) holding the database and
  the keys that read it; **Restore from a backup** (also on an empty device's sign-in page) checks the
  passphrase and the file, shows what it holds, requires typing RESTORE, and writes the database under a newly
  claimed epoch (`local/shims/sqlite.js` `replaceWith`). Home reminds the device's manager after 7 days
  without a backup (dismissible for the day).
- **Settings:** `mfa_grace_days` is now on the form; `program_contact` is shown on the sign-in page; the unused
  `default_funding_source_id` is no longer accepted.
- Migration 25 adds `users.access_status`, `users.access_note` and `users.requested_at`. `access_note` is not
  sent to devices by sync.
- The browser suite gains `scripts/ui/signup.mjs`; `run-all.sh` takes `SUDS_UI_TMP` and `SETUP_BOOT_PORT` so two
  suites can run side by side. Docs: `WEB_APP.md` and `PLATFORM.md` rewritten for the two ways to run SUDS;
  README, INSTALL, HIPAA (risk register), DEPLOYMENT updated.
- **Completeness fixes.**
  - Local mode and SUDS on this device: "Everything as one Excel workbook" now works (no `setImmediate`; the
    zip falls back to synchronous compression).
  - A fatal overdose discharges the client as deceased after confirmation; changing the outcome or deleting
    the event restores the client, episode, care team and to-dos. Overdose events can be deleted.
  - Signed notes have **Verify signature** ("Signature intact" / "Changed after signing") and show the full
    hash on demand.
  - Finance no longer sees client links that lead to a 403; the client page says "Not available for your role".
  - Patient-rights requests can be edited and deleted from the client's Requests tab.
  - Reports: an Episodes of care card (admissions, discharges by reason) and single-table exports for
    episodes, overdose events, client forms and disclosures. `GET /api/episodes` returns period counts.
  - Discharge reasons, overdose options and request kinds come from the server's meta lists.
  - Supervision hides the note sections from roles that cannot countersign.
  - Imports: a staged item can only be discarded by the person who imported it, or a manager.
  - Docs: `API.md` regenerated; user guide updated.
- **Load-review fixes (2,000 clients, 64,000 records).**
  - Retention: the purge clock now runs from the last activity on a record (visits, calls, notes, referrals,
    to-dos, consents, disclosures, forms, overdose events, patient requests, time, expenditures, episodes,
    intake/discharge), not from the discharge date alone — a client discharged in 2018 but visited in 2024 is
    no longer purged in 2025. Records left inactive are now purged on the same clock (an unclosed episode does
    not exempt them); active and waitlisted records never are.
  - Search and duplicate detection work for names in any script and ignore accents: Arabic and Cyrillic names
    are searchable and flagged as duplicates, "Oster" finds "Øster", "Lecki" finds "Łecki". Migration 26
    rebuilds existing clients' name indexes.
  - Funder report: "people served" is one set per filter (visit or call in the period, deleted clients
    excluded, and only visits charged to the fund when a funding source is chosen), and every demographic
    breakdown and per-person count uses it.
  - Reports, the dashboard and exports treat from/to as calendar days in `ORG_TIMEZONE`: an evening visit on
    the last day of a fiscal year is in that year. A malformed date is refused.
  - With local mode off, device sync (pull, push, attachments) is refused with 403.
  - The daily audit-chain check is incremental and runs in batches that no longer freeze the server; the whole
    chain is still checked weekly and by the Verify button.
  - Outreach and community naloxone distribution can be recorded without a client; other types still require
    one, and the server enforces the same rule. Logging time on a visit with no client no longer fails.
  - Deactivating a user says how many clients and open to-dos are still assigned to them, and anyone who can
    manage assignments can move them to an active worker in the same step (audited as `caseload.transfer`).
    Move a caseload lists deactivated staff who still hold clients, marked "(inactive)", and Home warns
    supervisors when clients are assigned to inactive staff. New `GET /api/users/:id/caseload` and
    `GET /api/users/caseloads` (counts only). Moving a whole caseload also moves to-dos that name no client.
  - Creating a user, resetting a password and the setup wizard no longer hash passwords on the event loop.
  - Client list: the risk, no-contact-in-30-days, substance, MAT, consent-expiring and open-patient-request
    filters run on the server (`server/client-filters.js`, shared with the Home tiles), so a tile and the list
    it opens count the same people and every match is reachable. Client, visit, note, referral, call and
    waitlist lists have "Load more"; the waitlist is no longer capped at 500. The consent alert on Home counts
    clients, like the list it opens.
  - Saving a record someone else changed since you opened it is refused with "This record was changed by
    someone else since you opened it. Reload to see their changes." (409, `if_updated_at`) instead of silently
    overwriting their changes. The client form sends only the fields you changed.
  - A save retried after a dropped connection no longer creates duplicates (`Idempotency-Key`, remembered for
    24 hours, answers stored encrypted and never synchronised): one referral, one disclosure record, one
    follow-up, one visit and time entry.
  - Returning clients: when intake finds a discharged record outside your caseload (surname and date of birth,
    or phone), you can re-admit it yourself with a reason. It is assigned to you, opens a new episode, is
    audited, and goes to supervisors for review alongside emergency accesses.
  - Migration 27 adds `idempotency_keys` and `breakglass_events.kind`.
- **Settings → Lists: change the choices on documentation forms without a code change.** Administrators can
  reword, reorder, hide and add to the choices for visit type, location, modality and outcome, call and text
  outcomes and who was called, referral status ("What happened") and barrier, overdose "What happened" and
  "Given by", time category, note format, primary substance and discharge reason, or restore the defaults.
  Stored codes never change, so history and reports stay consistent; the wording is used on forms, lists,
  reports and Excel/CSV exports, and imports accept either. Choices SUDS acts on (a fatal overdose, a reached
  call, the visit types that need no client…) can be reworded but not hidden. A hidden choice is no longer
  offered on new records; editing a record that already has it keeps it. Referral statuses and overdose
  outcomes take no additions (each drives a rule or a count); reporting code sets (race, ethnicity, ASAM,
  consent types, patient-rights requests) are not editable and the page says why. Every change is audited.
- **Funding sources** can be added, renamed and deactivated from Settings → Lists; a **Manage** link sits
  beside every Funding source field for budget managers, and **Edit this list** beside list-driven fields for
  administrators. Editing a record charged to a deactivated funding source now keeps that source instead of
  clearing it.
- Migration 28 adds `option_overrides`, which devices receive from the office and cannot change.
- **"Download provider pictures" works, and the pictures show.**
  - On SUDS on this device, a browser cannot download pictures from providers' websites (no CORS), so every
    one failed. The site is now published with each starter-directory provider's picture, fetched at build
    time (`scripts/fetch-region-pictures.js`, `SUDS_REGION_PICTURES`); a program the build has no picture
    for says so.
  - A downloaded picture now shows on the directory card: the browser makes a real thumbnail instead of the
    card keeping the generated placeholder. Pressing the button again repairs pictures downloaded earlier.
  - The result (how many, and why the rest are missing) stays on screen and is shown as a toast. On a device
    that syncs with an office server the button is replaced by a note that pictures arrive with sync.
  - An office server that cannot reach the internet says so and names `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`
    (or `NODE_EXTRA_CA_CERTS`), instead of "fetch failed" for every program (`DEPLOYMENT.md`, *Outbound
    internet*).
  - API: `POST /api/regions/:id/pictures` results include `photo_id`/`resource_id`; `GET` returns `thumbs`;
    `PUT /api/resources/:id/photos/:pid` accepts `thumb_url`.

## 1.9.4 — 2026-09-24

- **The paused screen tells the truth in every event order.** A displaced tab says its work was "saved first"
  exactly when nothing is left unsaved (a save refused by the fence leaves it unsaved), on every path that
  pauses it; before, a frozen tab that had saved on its `freeze` event said "may need to be re-entered" or
  "saved first" depending on which of its queued callbacks ran first on waking (seen once in three CI runs).
  `scripts/ui/multitab.mjs` now expects the truthful answer for both variants and fails on the old code.
- **Safari: a record saved and the page reloaded straight away was lost.** The new WebKit CI job caught it:
  Safari's engine drops the last write made while a page unloads, and 1.9.3 batches saves every 250 ms. An
  explicit save from the interface now waits for the on-device write before the page says it is saved;
  background writes (note autosave, preferences, polls) stay batched. On a very large on-device caseload an
  explicit save takes a few tens of milliseconds longer.
- Safari's engine could leave the offline shell empty after an update and miss a cached page offline: the
  worker now falls back to a plain fetch-and-store when its reload-mode precache is refused, never skips its
  handler if building a request throws, and ignores `Vary` when looking up the shell offline.
- WebKit smoke checks report what the shell cache holds instead of crashing, and wait for the worker to finish
  filling it.

## 1.9.3 — 2026-09-24

Fixes from the critical review of 1.9.2, re-checked by an independent verifier with its own multi-tab, frozen-tab, old-tab-upgrade and phone scripts before release (no data loss in any scenario). **Upgrade note:** local mode is now off by default on the office server; a county that relies on it sets `LOCAL_MODE_ENABLED=true` (or answers Yes in the setup wizard). Schema 24 (`tasks.description` encrypted).

- The update banner appears only when the release running in the page differs from the published one (no banner right after an update); the build stamp is shown under the page title on phones; Home's overdue badge and due date wrap at 200% text instead of running off the screen.


- **The demo build loads sample data beside clients you already entered.** On the static (GitHub Pages)
  build, "Load sample data" no longer refuses once a client exists; the sample rows are tagged and "Remove
  sample data" takes away only them. An office server, and a browser copy it hands out, still offer it
  only to an empty program (`server/demo.js` `loadRefusal`/`offer`, `local/kernel.js`). The "local mode is
  off" page now names the setup wizard's answer and `server.json` `localModeEnabled`, not only the
  variable. Leftover native-app branches (`SudsNative`, `__sudsSecrets`, the `suds:` and Android WebView
  hosts) are gone from the web app.
- **Browser suite: order-independent, condition waits, summary table.** `scripts/ui/run-all.sh` reseeds
  and restarts the office server before every script that uses it, prints a per-script table (checks,
  result, seconds) and exits non-zero on any failure; its readiness probe no longer waits out 20 s on a
  401. Fixed sleeps are replaced by `settle()` / `saved()` (`scripts/ui/assert.mjs`), which wait on
  `window.__sudsActivity` (requests in flight, the pending prefs save and Home tour, the last rendered
  address) and on the kernel's unsaved state; the few sleeps left wait for time to pass on purpose.
- **Local mode is off by default on the office server.** `/?local=1` serves a short explanation unless the
  setup wizard's new question — *Allow staff to keep an offline copy on their devices? Recommended: No* —
  is answered Yes (stored in `data/server.json` as `localModeEnabled`) or `LOCAL_MODE_ENABLED=true` is set;
  the variable overrides the wizard either way. **Upgrading counties that rely on local mode must set
  `LOCAL_MODE_ENABLED=true`** (or add `"localModeEnabled": true` to `server.json`). The GitHub Pages demo
  is unaffected. `server/config.js`, `server/routes/setup.js`, `public/views/setup.js`;
  `test/local-mode-default.test.js`, `scripts/ui/setup.mjs`.
- **To-do details are encrypted.** `tasks.description` moves into `description_enc` (migration 24; the
  migration-19 rebuild now encrypts it first so a 1.6.x upgrade keeps it). The API field is still
  `description`; de-identified exports never include it, identified exports decrypt it; sync declares it.
  A 1.9.2 device that pushes a to-do's plaintext `description` has it carried into `description_enc` by
  the office (a `legacy` column map in `server/sync-tables.js`); an old kernel's empty value never erases
  the office copy. `test/task-description.test.js`, `test/sync.test.js`.
- **The native apps and launchers are removed** (`mobile/`, `launchers/`, `mobile-android.yml`,
  `mobile-ios.yml`, `probe.yml`, `scripts/android-keystore.sh`, `scripts/print-url.js`) and the native
  key-store lookups in `local/shims/config.js`; the code stays in git history. PLATFORM.md's roadmap had
  said they were deleted in 1.9.0; it now records 1.9.3.
- **The public demo is published on releases only** (`v*` tags, published releases, and `release.yml`'s
  explicit `gh workflow run web-app.yml --ref <tag>`), never on a push to `main`. Each run names the version
  it publishes; release QA checks the on-screen version (RELEASE.md, WEB_APP.md).
- **CI:** advisory `node24` job (`npm test` on Node 24 from the official tarball) and advisory `webkit` job
  (static-site and qa-retest in Playwright WebKit via the new `SUDS_BROWSER` variable). Dependabot ignores
  esbuild and sql.js (updated by hand with `npm run build:local`) and groups the other devDependencies monthly.
- **Docs:** new `docs/ADOPTION.md` (code owner, pilot, staged releases, real-device checklist, drills,
  independent review, staffing); HIPAA.md *Risk register notes* (blind-index leakage, index key also keying
  the audit chain, single instance, local-mode keys beside the data); Node 24 migration plan in DEPLOYMENT.md.
- **Phone review of the demo build (UX polish).** Dialogs start below the demo banner (`--demo-banner-h`),
  so titles and ✕ stay visible at any text size; Back closes the open dialog instead of leaving the page;
  a referral started from a provider page loads the chosen client's consents (and says what to do once);
  Home's "Load sample data" loads it in place; the demo no longer promises a sync it never does (setup,
  tour, Sync page) and offers "Try it with sample data"; the first screen says what SUDS is; 44px touch
  targets for to-do boxes and chart rows; text sizes in rem and no sideways overflow at 200% text; Title
  Case note formats and "Part 2 disclosure"; "<Field> is required"; 4.5:1 green badges; the last tour
  step says Done; greetings use the given name ("Dr. Patel" kept whole); `get-app.html` installs the app.
  Covered by `scripts/ui/ux-polish.mjs`.
- **Two windows can no longer erase each other's work on a device (fencing).** 1.9.2's takeover lost
  confirmed records four ways: taking a window back kept its stale in-memory copy and saved it over the
  other window's work; a tab still on 1.9.0/1.9.1 kept saving after being displaced; a frozen background
  tab was taken over without asking and saved over the new holder when it woke; a duplicated tab took over
  silently. Now every holder claims an `epoch` in IndexedDB, saves only under `db2:<its epoch>`, and an
  ordinary save checks the epoch in the same transaction as its put (a displaced page pauses instead);
  the unload save writes a key nobody reads once the page is displaced. The first start moves the database
  from the old `db` key, which older releases keep writing to unread — so work typed into a tab still on an
  old release after another took over is not carried across. Nothing is taken over without asking except
  a reload of the same tab, which waits for its previous page to let go. "Use SUDS here instead" reloads the
  page. The paused screen closes open dialogs, survives hash changes and the dashboard refresh, and says
  "saved first" only when it was. `local/shims/sqlite.js`, `local/kernel.js`, `server/db.js` (`openWith`
  always opens what it is given), `public/app.js`; `scripts/ui/multitab.mjs` (new), `scripts/ui/local-mode.mjs`.
- **Writes on a device answer in about 1–3 ms again** (1.9.1 exported the whole database on every write:
  ~37 ms at 1,500 clients). Saves are coalesced (250 ms) and the page saves on pagehide, when hidden and on
  `freeze`; the next page of the same tab waits for the lock before reading, so an edit made just before
  navigating away still survives (`scripts/ui/device-audit.mjs`, under the service worker). A failed save
  still raises the "stopped saving" banner.
- **A new release no longer reloads the page under someone.** When a new service worker takes over, or
  `version.json` (new; written by `npm run build:local`, never cached) names another version, the page
  shows *A new version of SUDS is ready — Reload*, and reloads on its own only when hidden or at the next
  page change — never with a dialog open, a form half-filled or a sync running, and once per release.
- **Build stamp**: "SUDS <version>" on the sign-in/start screens and in the sidebar.
- **Error beacon**: uncaught errors, unhandled rejections and 5xx answers are reported without PHI (message
  cut to 300 characters with long digit runs masked, file:line frames, route without query, version,
  browser family). The office app posts them to `POST /api/client-errors` (signed-in session, 10 a minute
  per person, application log at WARN, not the audit log); a device keeps the last 50 and lists them on its
  Sync page under *Errors on this device*. `server/routes/client-errors.js`, `test/client-errors.test.js`.
- **Service worker**: the office server's `no-store` is passed through instead of being weakened to
  `no-cache`, and a re-headed response no longer carries the original `Content-Encoding`/`Content-Length`.

## 1.9.2 — 2026-09-23

- **No more "SUDS is already open in another window" dead end on a phone.** The single-writer lock stays
  (two tabs writing the same on-device database would overwrite each other), but the screen now offers
  *Use SUDS in this window*: the other tab is asked to write out and step aside, is shown a "paused" screen
  with a way to take it back, and refuses every request from then on. A reload of the tab that holds the
  lock, or a holder whose heartbeat has stopped, takes over on its own with no screen at all; the case the
  release-time reload made common. `local/shims/sqlite.js`, `local/kernel.js`, `public/app.js`; covered by
  `scripts/ui/local-mode.mjs`.

## 1.9.1 — 2026-09-23

Second external retest of the published (static, always-local) build, in a browser profile that had been
set up on a build from before the first round of fixes. Replayed by `scripts/ui/qa-retest.mjs`
("upgraded profile": the static site of the old commit, then this build at the same origin) and
`scripts/ui/static-site.mjs`.

- **Stale app files after a release on a static host.** A host that sends `max-age` (GitHub Pages: ten
  minutes) let a plain reload keep running the previous build's `app.js` and views from the browser's own
  caches, with the service worker never asked — every fix of the first retest looked "still broken" for
  as long as that lasted. The worker now fills its shell with `cache: 'reload'`, fetches app files with
  `cache: 'no-cache'`, and hands the page every app file marked `no-cache` so the next reload comes back
  to it; a new worker taking control reloads the page once. Offline, `index.html` stands in only for a
  navigation; a missing script or image is a real failure. `get-app.html` is in the shell.
- **A write on the device is on disk before it answers.** With the worker answering navigations from its cache, the next page could arrive before the previous page's unload write was committed; every write request now persists before responding, so an edit made in the instant before leaving survives.
- **"+ Add pictures" is now a label over the file input itself** (`.file-btn`): a tap on the button is a tap
  on the input, so the picker opens as a direct gesture everywhere and an automated click aimed at the
  input is no longer "obscured" by the button that used to forward to it.
- **The greeting uses a one- or two-word display name whole** ("QA Tester", "QATEST"); only a longer formal
  name is shortened to the first name (`greetingName`). Never re-cased; username fallback.
- **The demo banner no longer intercepts taps** on a dialog scrolled up under it (`pointer-events: none`).
- **"Use SUDS on your phone or tablet" on the static build**: linked as `get-app.html` from the login tip,
  the Home card and the Settings card (a static host has no `/app` rewrite); the page hides the
  certificate download and office-address wording there and shows the offline-copy section.
  `scripts/serve-static.js` now behaves like a plain static host (no rewrites, real 404s).

## 1.9.0 — 2026-09-23

A hardening and audit release. Schema 23 (migrations 19–23); databases upgrade in place on first start — take a backup first. This is the first release under the web-first platform policy (`docs/PLATFORM.md`): the office server's web app is the only supported client; the native apps and launchers no longer build or ship.

Compliance review fixes (HIPAA / 42 CFR Part 2) and county IT hardening.

- **Web-first: native apps and launchers deprecated.** The web application served by the office SUDS
  server is the only supported client and the system of record; everything is managed and documented
  against it (`docs/PLATFORM.md`). The Android and iOS apps and the desktop launchers are deprecated and
  will be removed in a later release: their workflows run only by hand and attach nothing, the release
  carries the server zip alone, the office server no longer hosts an APK (`GET /api/app/android.apk`,
  `POST/DELETE /api/admin/app/android` and the `android` field of `/api/app/info` are gone), and Settings no
  longer offers an upload. `scripts/gen-schema-text.js` no longer stamps `build.gradle.kts` or
  `Info.plist`. `/app` is now "Use SUDS on your phone or tablet" (browser, home screen, certificate) and
  mentions the offline copy only when the server reports `local_mode`. Browser local mode stays, under the
  rules in PLATFORM.md; existing phone-app installs should sync once more and be uninstalled.

- **Sync cannot rewrite the legal record.** Consents, disclosures and note addenda are insert-only through
  `POST /api/sync/push`; the only change a device may make to an existing consent is to revoke it, and the
  revocation is attributed to the syncing user. Anything else is rejected as `immutable`.
- **Referral outcomes are consent-gated.** `POST /api/referrals/:id/outcome` applies the same lawful-basis
  check and disclosure record as creating or updating a referral.
- **Safe Harbor de-identification.** De-identified exports reduce every date to year-month, ZIP codes to
  three digits, omit city, band ages (DOB is never exported) and are labelled as such (CSV comment line,
  Excel *About* sheet). The funder report suppresses breakdown rows under 11 (`<11`). Exports now require
  `export:read` (supervisor, finance, admin); an identified export must name `recipient` and `purpose` and
  writes one accounting-of-disclosures row (basis `export`) per client it contains.
- **Disclosures without consent must be justified.** A medical-emergency basis needs a written justification
  (20+ characters, stored encrypted); "other" additionally needs the new `disclosures:override` permission
  (supervisor, admin).
- **Part 2 consents carry every §2.31 element.** A `part2_disclosure` consent requires recipient, purpose,
  scope, an expiry date or event, evidence of signature (document reference, witness or signed on paper) and
  confirmation that the redisclosure notice was given.
- **Break-glass review.** The reason must be at least 15 characters; every use is queued in
  `breakglass_events` and shown under Supervision → Break-glass access, with a count on the supervisor's
  home page, until acknowledged (`GET /api/supervision/breakglass`, `POST …/:id/ack`; nobody can acknowledge
  their own).
- **Audit head checkpoint.** After each scheduled verification and each purge the newest entry's id, hash
  and the row count are HMAC-sealed into settings and written to the log; verification reports `truncated`
  when the newest entries have been deleted.
- **Retention, legal hold and patient rights.** `clients.legal_hold` with `POST /api/clients/:id/legal-hold`
  (admin only); a `patient_requests` table and `/api/patient-requests` CRUD with a 30-day due date and a
  *Requests* tab on the client page; `GET /api/clients/:id/disclosures/accounting` and a *Print accounting*
  button; a daily retention job (`server/retention.js`, `client_retention_years`, default 7, minimum 6) that
  hard-deletes discharged records across every table unless held.
- **More columns encrypted.** `calls.purpose`, `referrals.outcome/barrier/notes`, `tasks.title` and
  `overdose_events.substances` move to `_enc` columns (API field names unchanged).
- **Roles and defaults.** `readonly` sees the de-identified client list and reports only (no `clients:all`,
  no exports); MFA is required of every role by default; `LOCAL_MODE_ENABLED=false` makes the server serve an
  explanation instead of the in-browser kernel; `CLIENT_RETENTION_YEARS` configures retention.

Schema 20. Navigator-facing fixes from a hands-on field review.

- **Tap to call, text or navigate.** Every phone number on the client page, the contact lists, the
  calls list and the resource directory is a `tel:` link with a `sms:` "Text" beside it; addresses open
  in maps. Call / Text buttons on the client page dial and then open the log, prefilled.
- **Offline is said out loud.** A save with no signal keeps the dialog open and says so in plain words; a
  persistent banner points at the phone app, including on a sign-in screen served from the cached shell.
- **Names, not codes**, on the to-do list, Calls & texts and My time (`client_name` on those list routes,
  never for a de-identified role). Compact two-line rows for Clients, To-do and Calls on a phone; the
  client page's tabs fold into a keyboard-accessible "More" menu instead of scrolling off the edge.
- **Intake opens the first episode of care** (`no_episode: true` opts out); the New client form no longer
  asks for a discharge; a closed episode can be reopened (`POST /api/episodes/:id/reopen`, re-admission).
- **Ask for a co-sign.** An author can request supervisor review on a draft or signed note
  (`notes.cosign_requested`, `POST /api/notes/:id/request-cosign`); it joins the countersignature queue.
- **Reminders that reach you**: a bell in the header with the count due within the hour or overdue
  (`GET /api/tasks/due`), an opt-in browser notification (Profile), and Home labels overdue items first.
- Accessibility: the closed phone drawer is `inert`; 44px tap targets on touch screens; warning text
  meets 4.5:1 in both themes. The + Log button clears the last card, hides behind the drawer, and toasts
  sit above it.
- Preferred name / alias search (`clients.preferred_name_idx`); caseload sort (last contact, overdue
  follow-ups, risk); shift hand-off notes with a Home card; a structured safety plan note shown as a chip on
  the client page; and a supply cupboard (`supply_stock`, `/api/supplies`) that visits draw down.

- Fixes from the outside retest of the published web app (local mode): "Add resource" saved nothing
  because a DOM error was thrown before the request (every form error now reaches the dialog's banner);
  Settings crashed on the device over a config key the local kernel's config shim did not define; a due
  date entered without a time was silently dropped (date & time fields are now a date plus an optional
  time, and a date-only value is kept as the calendar day); a client with a blank status showed no status
  (rendered as Active; migration 21 backfills such rows); the client search list no longer floats over
  the field below it, which blocked the date picker on phones; the greeting uses the display name as
  typed (username if blank); dialog titles no longer linger in the accessibility tree via the live
  region. Covered by `scripts/ui/qa-retest.mjs` on both the static build and `/?local=1`.

Sync and data integrity (from the weakness review).

- **Offline work reaches every device.** Rows a device pushes are stored with the office's clock, so other devices' incremental pulls receive them; the pull cursor is per office user, so a second person on a shared device gets their whole caseload.
- **Purged and merged records stay that way.** A push for a client the retention job purged (or any of its records) is refused as `purged` and the tombstone kept; the device deletes its copy. Records of a merged-away duplicate are re-pointed to the keeper and a pushed row can never move a record between clients.
- **Rejections say whether they are final.** Every rejection carries `permanent`; the device settles a permanent one (office wins), shows it once on the Sync page and never resends it. Transient failures still retry.
- **Supply stock is server-owned**: devices cannot push counts; a pushed visit draws stock down on the office by the delta, and deleting a visit restores it.
- Device-supplied owners are honoured only when the syncing user may act for them; creation timestamps no longer drift with the device clock; device pull applies row by row with savepoints, foreign keys are on for every open, and office tombstones are never echoed back.
- A restore from backup stamps a database generation; devices notice it on the next pull, reset their exchange state and re-offer their records, so nothing created on a phone is lost to a restore.
- Client codes are generated from a numeric counter (a collision rename no longer poisons the sequence; codes past 9999 work).

Security, exports, backups and finance (from the weakness review).

- Index-key rotation re-seals the audit head under the new key (it failed after the first scheduled verification). A pending device wipe is no longer consumed by anyone who knows the device id: the office answers the wipe instruction without changing state until valid credentials arrive on that device or the device acknowledges with a one-time token; the device now erases itself completely (the in-memory copy no longer writes itself back) and a revoke that carried a wipe wipes too.
- Navigators and clinicians can export de-identified data again; every Export button is permission-gated; the identified workbook asks for recipient and purpose and writes one accounting-of-disclosures row per client. CSV exports have no comment line and neutralise formula-triggering cells; de-identified datasets use explicit per-dataset column lists. The duplicate check on client create no longer reveals people outside the caller's caseload.
- A refused restore leaves the original database in place; a backup that fails to write is recorded, audited and surfaced by `/api/health`; the offsite copy is reported as failed when the share is not mounted rather than silently written to the local disk; a backup from a newer SUDS is refused with a plain message.
- Service dates use the organisation's time zone (`ORG_TIMEZONE`) for fiscal-period checks; expenditure approval follows a strict state machine (pending → approved | rejected, approved → reimbursed) with a supervisor-only overspend override and no self-approval for any role; money is rounded to cents on write and in every sum; budget structure is checked (period order, sub-allocations within their parent, lines within the fund); a pending expenditure cannot be moved outside the period.
- Re-importing a spreadsheet skips rows already imported; the due-reminder poll no longer floods the audit log; failed sign-ins for unknown usernames are audited hashed.

Functional audit before this release (every workflow walked by role, in the browser).

- **Settings no longer blank the policy on a fresh install**: saving any field used to store empty values and disable MFA for every role. Unset settings render their defaults; an empty MFA-roles value means "default", never "nobody"; the save is all-or-nothing.
- Returning a time entry requires a reason, shown to the worker; the time-approval queue shows all submitted time to finance and admins; `mfa_grace_days = 0` means immediately.
- Legal hold blocks merge in both directions; a discharge needs a reason; opening an episode makes the client active and a client with an open episode cannot be closed through Edit; a referral outcome closes only its own follow-up; editing or deleting a visit keeps the auto-created time entry in step; merged-away links redirect to the keeper; open patient-rights requests and overdue ones are counted on Home and in Supervision; contact-field validation (DOB, email, phone); expired consents are not offered for referrals; a crisis-escalated call is counted as a crisis.
- Forms no longer re-save a draft after a successful submit (the New client dialog reopened pre-filled with the person just created). Dialogs sit above banners on phones; the break-glass dialog enforces the reason length; unhandled errors surface as a toast; unknown routes show "Page not found".
- Local mode: idle sign-out fires even while the reminders poll runs; office-side sync errors show their real message; an office account with MFA is asked for its code inline instead of being sent to the device's own MFA screen; the service worker is registered in local mode and precaches the kernel so a home-screen install opens offline; writes in the last moments before leaving the page are flushed; field-created clients no longer trip an "assignments" rejection; a merged-away client is re-pointed on the device; a device-side edit of a server-owned supply count is overwritten by the office. The kernel and WebAssembly ship precompressed with immutable caching (Slow 3G cold start 57 s → 31 s). Sync from the demo site is refused up front with an honest message.
- Operations: a full disk answers 507 with a plain message; a double leading slash in a URL no longer hangs a request; `.webmanifest` has the right type; device revoke and user deactivation ask for confirmation; the restore-complete dialog has one action, "Sign in again"; the wizard hides the port when `PORT` is set by the environment.

## 1.8.0 — 2026-09-18

- **A fully standalone, browser-only web app.** No office server, no Node process, no database anywhere
  but the visitor's own browser — the same "local mode" the phone apps run, packaged as a static site and
  published to a public URL (GitHub Pages, or any static host). Open it on any phone or computer, add it
  to the home screen, and it works, including offline; sync with a real office SUDS later if the county
  has one. `docs/WEB_APP.md`; built by `scripts/build-static-site.js`; deployed by
  `.github/workflows/web-app.yml`; covered end to end by `scripts/ui/static-site.mjs`.

## 1.7.1 — 2026-09-18

Production-readiness fixes found by running the first-run wizard the way a county does, and by inspecting
what 1.7.0 added.

- **Username validation was silently off** on the setup wizard and the add-staff form. The HTML pattern
  reached the browser with an unescaped `-`, which modern Chrome rejects, logs, and ignores — so any
  string was accepted as a username. Fixed in both forms.
- **The database's write-ahead log and shared-memory files were world-readable** on a production server:
  SQLite creates them itself, and only the database file was being made private. In production the
  process now creates every file private by default, and existing `-wal`/`-shm` files are fixed on open.
- **Releasing from the Actions tab never built the Android app.** The tag the release workflow creates
  raises no push event, so the Android workflow's tag trigger never fired and the APK was quietly
  missing from every release started that way. The release workflow now starts the Android build itself.
  (The APK is attached only when the signing secrets are set — see docs/MOBILE_APPS.md.)
- **The first-run wizard is part of the browser suite** (`scripts/ui/setup.mjs`, run against an
  unconfigured production server): wizard, HTTPS restart, first sign-in, key-backup prompt, first
  backup, and that setup cannot be run twice. The desktop crawl also covers the screens 1.7.0 added
  (Supervision, Waitlist, Overdose, Funder report, Forms, the Texts filter). The suite refuses to start
  on a port a stale server is holding, instead of reporting an app defect that is not one.
- `scripts/android-keystore.sh` creates the county's Android signing key once, with the checks and the
  warnings that key deserves; keystores are ignored by git.

## 1.7.0 — 2026-09-17

This release came out of a detailed review of the platform. It fixes things that could break a county's
data, closes gaps between what the app recorded and what it actually enforced, and adds the workflows the
data model had no process around.

### Things that could have lost or leaked data

- **Sync could wedge itself permanently.** One unusable row aborted an entire push, and the device retried
  the same payload forever. Each row is now applied on its own: a bad one is rejected with a plain reason
  and everything else still lands. Three reproduced ways this happened are now covered by tests — a county
  form completed offline, the third device to create a client without a signal, and a record whose
  encryption could not be read.
- **Key rotation destroyed form PHI.** Re-keying the database skipped completed county forms and their
  attachments, so following the documented procedure made them permanently unreadable. The columns to
  re-encrypt are now read from the database itself, so a new one cannot be missed.
- **Sync let a device do what its user could not.** A navigator could write resources, funding sources and
  form templates through sync, and caseload limits were not applied at all to calls, to-dos, time entries
  or spending. Both are enforced now.
- **Finance could export identified client data.** The role kept its de-identified access but no longer
  holds the permission that turns names on.
- **A phone with two tabs open lost work.** Each kept its own copy of the database and saved by overwriting
  the whole thing. One window now holds it and the others say so. A committed change is written out
  immediately rather than on a timer, a failed save is reported instead of disappearing into the console,
  and a device whose security key has been cleared says so instead of silently making everything on it
  unreadable.
- **Restoring a backup no longer needs a terminal.** Administration can check what a backup contains and
  then restore it, keeping the replaced database aside. Backup, restore and key rotation had no tests at
  all; they do now.

### Consent, supervision and discharge

- **Consent is enforced where information actually leaves.** A referral that names a client to an outside
  agency is refused without a valid consent or another lawful basis, and writes the disclosure record that
  HIPAA §164.528 requires. Revoking a consent flags the open referrals that relied on it.
- **Countersignatures.** Only the author signs a note; a supervisor countersigns. Both names stay on the
  record — signing on a trainee's behalf used to erase who actually provided the service.
- **Supervision** (new menu item): notes waiting for a countersignature, drafts the team has not finished,
  staff time to approve, and referrals with no outcome recorded.
- **Staff time is submitted and approved**, in bulk or per entry, with the same rule expenditures have:
  nobody approves their own.
- **Episodes of care and discharge.** Closing an episode ends the assignments, closes the open to-dos that
  would otherwise sit overdue forever, and records why and where the client went. Reopening service brings
  a returning client back. There is a **waitlist** ordered by how long people have actually waited, and a
  **caseload transfer** that moves every client and open to-do at once when a worker leaves.
- **Referral outcomes.** Every referral gets a follow-up date whether or not one was set, and recording the
  outcome closes the loop, so "how many warm handoffs resulted in an admission" is answerable.

### Reporting

- **Funder report** (new menu item): unduplicated counts — people, not services — by fiscal period and
  funding source, with admissions, discharges, median length of stay, demographics and overdose figures.
- **Overdose & reversals** (new menu item): an event log including community reversals with nobody
  identified, which previously could not be recorded at all. Community naloxone distribution can be
  recorded as a service with no client attached.
- Race and ethnicity are recorded as codes a funder can count, alongside the free-text field.

### Contacts, referrals and the phone

- **Text messages are logged like calls.** + Log offers **Text message**, and a client's page has a
  **+ Text** button. A text has its own outcomes — replied, sent, no reply, undeliverable, wrong number,
  opted out — so "voicemail" and "busy" no longer stand in for them, and the two sets cannot be mixed up.
  A reply counts as having reached the client (an unanswered text does not), so texting somebody no longer
  leaves them on the *no contact in 30 days* list. What was said is encrypted like any other PHI, and the
  form says plainly that texting a client about treatment is itself a disclosure if someone else can read
  their phone.
- **A referral is no longer blocked by an empty directory.** On a phone that has not synced yet, the
  provider list was empty, offered only "—", and had nothing to type into. It now offers adding a provider
  without leaving the referral, and says why the list is empty.
- **The floating "+ Log" button no longer covers the last control on a phone screen**, and a long value can
  no longer push a page wider than the phone — which put buttons out of reach entirely.

### Working with client records

- **Entering the same person twice is caught.** A matching surname and date of birth, phone number or full
  name is flagged while you type — compared through blind indexes, so no name is ever in the clear.
  Duplicates that do get in can be **merged**.
- **Search tolerates typos and partial surnames**: "Ngu" and "Nguyan" both find Nguyen.
- **Starter forms**, including a 42 CFR Part 2 consent with the elements the rule requires. A new
  installation used to have no consent form at all.
- Unsaved work in a form is kept if the dialog is closed or an idle sign-out happens.

### Accessibility

- Clickable rows and the client picker were mouse-only. Rows are keyboard-reachable, the picker is a real
  combobox with arrow keys and Enter, dialogs keep Tab inside them and return focus where it came from, and
  validation errors are announced and focused rather than shown only as a red outline.

### Under the hood

- **The audit chain is keyed.** It is an HMAC over the previous entry rather than a plain hash, so somebody
  who can write to the database cannot recompute a chain that covers their changes. Entries written by
  earlier versions still verify, and the whole chain is checked daily.
- **The database is snapshotted before a migration runs** (`data/pre-migration/`, last five kept). A
  migration is the one operation a county cannot retry, and if the snapshot cannot be written the upgrade
  stops rather than proceeding unprotected.
- **Ending an assignment now takes effect at once.** Access was decided by date alone, so a worker a
  supervisor had just taken off a case kept the client until midnight.
- **Local mode in a plain browser says what it is.** Without a Keystore or Keychain it keeps its encryption
  keys in that browser profile beside the data, so the Sync screen and the documentation now say so: it is
  for trying SUDS out, not for real client information.
- Downloading pictures for a whole region is bounded by one time budget, so a slow provider website cannot
  outlive the request.
- Signing in no longer blocks every other request while the password is hashed.
- Pictures are served as cacheable images instead of base64 inside list responses, sync is paged and
  chunked, attachments travel separately, and the tables sync reads are indexed — a first sync used to be a
  single 40MB response the phone could not parse.
- Mandatory two-step verification is actually enforced, after a grace period so a new administrator is not
  locked out before they can enrol.
- There is a real health check, logs are written to dated files and rotated, and an unhandled error no
  longer takes down an unsupervised county workstation.
- Release builds fail if the committed phone kernel is stale, if tests fail (a shell precedence bug let a
  release publish with failing tests), or if an Android release is about to be signed with a throwaway key
  that would stop staff installing the update.

## 1.6.1 — 2026-09-17

### One record, one date, everywhere
- A reminder due on a calendar day (for example a follow-up from a call) showed as that day at noon on the client timeline but as the evening before on the To-do list and Home. Every screen now reads dates through one rule: a bare day is a day in your time zone, a timestamp is an instant, and something is "overdue" only after the day has ended. The server applies the same rule to overdue counts and to what Home lists as due today, and no longer turns a chosen day into midnight UTC when saving.
- The timeline shows task and note titles exactly as typed instead of re-capitalising them.
- Choosing **All** in the To-do list status filter returned nothing; it now lists everything (the same fix covers the expenditure and referral filters).
- On phones, list tables (to-do, referrals, calls, visits, time, spending) become stacked cards with a label on each value instead of seven columns squeezed into the screen width.
- The offline app shell now includes the Forms, Import and Sync screens.

## 1.6.0 — 2026-09-17

### Sacramento region starter directory
- **Add 81 programs in one click.** The Resource directory now offers a starter directory for the extended Sacramento metro: Sacramento, Yolo, Placer, El Dorado, Sutter, Yuba, Nevada and Colusa counties. It covers opioid treatment programs, office-based buprenorphine, residential treatment and detox, intensive outpatient and outpatient, sober living, shelters and day centres, harm reduction and naloxone, county access and crisis lines, community health centres, peer and recovery communities, food, legal aid, benefits offices and transport. Each entry carries a plain-language summary written for a navigator, service tags, populations served, how to refer, cost notes and contact details. Granite Wellness Centers appears as six separate programs (withdrawal management, Hope House, Serenity House, outpatient and MAT, adolescent, Truckee).
- **Loaded unverified, on purpose.** These programs were compiled from public web sources and were not confirmed with the providers. Every entry loads with no verification date, is flagged "needs verification" in the directory, and carries a staff note recording where it came from plus anything that needs checking, for example a conflicting address or a phone number that may belong to a commercial directory rather than the provider. Staff confirm each one and press "Verified today".
- **Never overwrites your work.** Loading fills in blanks on programs you already typed and adopts matching entries instead of duplicating them. Re-running checks for updates. Removing takes out only the programs nobody has used or verified; anything with a referral or a verification date is kept and simply deactivated.
- **Pictures.** Every program gets a category-coloured cover card generated on the spot, so the directory looks complete offline. **Download provider pictures** then visits each program's own website, finds the picture that site advertises for itself, and saves it as the main picture where it works. Programs whose site publishes nothing keep the generated card.

## 1.5.0 — 2026-09-17

### County form library
- **Forms** (new menu item): administrators and supervisors upload the county forms the program uses (PDF, Word or a picture of the paper form) and describe the fields to fill out. Fillable PDFs have their fields detected automatically; a "usual client header fields" button adds name, date of birth, phone, address, date and navigator in one click. Fields can be short or long answers, dates, numbers, checkboxes, choice lists, typed signatures, section headings and instruction text, marked required, and set to **pre-fill from the client record** (name, DOB, phone, address, insurance, Medicaid ID, client code, primary substance, worker name, program name, today's date).
- **Fill out from a client record** (new Forms tab, or "Fill out for a client" in the library): the form opens pre-filled from the chart, saves as you type, checks required fields when you mark it completed, and becomes read-only (supervisors can reopen). Every filled form is stored encrypted with the client record, prints to a clean **PDF**, and can hold the **signed or scanned copy** (photo or PDF, also encrypted). The original county form can always be downloaded to print blank; a blank PDF is generated for forms uploaded without a file.
- Forms sync to phones like everything else and work in the phone-only app. Client forms appear in exports (de-identified) and in the client's counts. Sample data includes three county forms and filled examples.

### Interactive cards
- Summary cards on Home, Reports, the client overview, Funding and System are now links: click "High-risk clients", "Open referrals", "Naloxone kits given", a fund's "Pending" and so on to jump to the matching filtered list. Chart bars (visits by type, clients by status or substance, MAT status, calls by outcome) are clickable too. The client list shows the active filter with a one-click clear.

## 1.4.0 — 2026-09-17

### Treatment center profiles
- Every resource in the directory now has a **profile page** (`#/resource/<id>`): a plain-language summary at the top, **services offered** as tick-box tags (detox, residential, IOP, MAT by medication, peer support, housing, telehealth, walk-in, 24/7 crisis and more), levels of care, populations served, how to refer, cost and capacity notes, contact details, referral outcomes and the recent referrals you may see.
- **Pictures**: staff with resource-edit rights add photos of the building, entrance and rooms from a phone or computer. Pictures are shrunk in the browser before saving (max 1600 px, plus a small thumbnail), checked on the server by their real bytes (JPEG/PNG/WebP only, 2 MB cap, 12 per resource), can be captioned, reordered (make main picture) and removed, and sync between phones and the office like any other record.
- The directory shows **cards with cover pictures** (or a list, your choice is remembered) and can be filtered by service. Referrals can be started from a profile.
- Excel/CSV import and export include the new profile columns. Sample data resources now come with summaries, tags and drawn placeholder pictures.
- Android app: the system photo picker opens for picture uploads.

## 1.3.0 — 2026-09-16

### Sample data
- **Load sample data** (Settings → Settings on the office SUDS; the Sync screen on a phone-only copy) adds 12 fictional clients with visits, calls, time, notes in several formats, referrals, reminders, consents, disclosures, resources, two funding sources and spending, so a new program can explore every screen. It is only offered while there are no clients yet, every record is tagged (`DEMO-` client codes) and **Remove sample data** deletes all of it in one click. A phone removes its sample data automatically before its first sync so it never reaches the office.
- The empty dashboard points new users at it. `npm run seed` uses the same generator (plus demo staff accounts) for development.

### Sync
- Device clock differences no longer decide conflicts: the office normalises timestamps using each device's reported time, and phones track exactly which rows were sent so nothing is re-sent or lost.
- Local database saves are flushed when the app goes to the background.

### Fixes
- Pages a role cannot use (for example Settings for a navigator) now show a clear message instead of failing requests.
- Collapsed sections in the new-client form are opened by the browser tests; the tour no longer opens on top of another screen.

### Build & test
- Browser regression suite (`scripts/ui/run-all.sh`, seven Playwright scripts covering desktop, the navigator workflow, UX features, phone-only mode, two-way sync, spreadsheets and sample data) runs in CI on every push.
- iOS simulator build workflow (`mobile-ios.yml`) compiles the SwiftUI wrapper on every release.

## 1.2.1 — 2026-09-16

### Security review fixes
- Sync: a device can no longer overwrite clients outside its user's caseload, delete rows it may not access, attribute work to other staff, self-approve spending, alter signed notes, or hard-delete clients, notes, consents or disclosures. Clinical notes are only synced to roles allowed to read them; MFA secrets never leave the server.
- Phone apps: database keys now live in the Android Keystore-backed encrypted store / iOS Keychain instead of web storage.
- iOS: the bundled app is served through a custom URL scheme so modules, fetch and WebAssembly work (file:// could not run the kernel).
- Local mode hides server-only settings (network, API keys, backups) and phone-connection cards.

## 1.2.0 — 2026-09-16

### Excel and CSV import / export
- **Export**: every table (clients, visits & services, calls, time, referrals, to-dos, resources, consents, funding, budget lines, expenditures) to Excel (.xlsx) or CSV, plus "Everything as one Excel workbook". De-identified by client code; an audited identified workbook for users with export rights. Buttons on Reports, Clients, Resources, Budget and the record lists.
- **Import**: Excel or CSV for clients, resources, visits & services, calls, time, to-dos and expenditures. Download a template with the exact columns, or upload your own file: columns are matched by name (with aliases such as "Surname", "DOB", "Drug of choice"), every row is validated with plain-language problems, clients are matched by code or name, duplicates are flagged, and nothing is saved until you confirm. Works in the phone app too.
- Spreadsheet engine implemented with built-ins only (CSV parser/writer, .xlsx reader incl. shared strings and Excel dates, .xlsx writer with frozen header and filters).

## 1.1.0 — 2026-09-16

### Phone app works on its own; sync on command
- The complete SUDS app now runs inside the phone app (local kernel: the server logic bundled with SQLite-in-WebAssembly and pure-JS encryption). Install from the APK, create a local account, and start working — no office computer needed at install time or while working.
- **Sync** screen: exchanges clients, visits, calls, time, notes, referrals, reminders, consents, funding and resources with the office SUDS in both directions when the user chooses. Newest change wins; deletions travel as tombstones; encrypted fields are re-encrypted with each side's own key; device audit entries are appended to the office audit log.
- First sync merges the device account into the office account with the same username; offline-created clients get `M` codes so they never collide with office `C` codes.
- Server: `/api/sync/pull` and `/api/sync/push` (caseload-scoped, role-checked), bearer-token login for sync clients, `updated_at` on all synced tables, tombstones table.
- Android: web app bundled as assets and launched directly in local mode; native bridge for office-server discovery, QR scan and file saving. iOS project updated the same way.
- Local mode can be tried in any browser at `/?local=1` on a SUDS server (data stays in that browser).

## 1.0.0 — 2026-09-16

First production release.

### Core
- Client records with encrypted identifiers, substance use profile, ASAM level, MAT status, overdose and naloxone history, risk level and safety flags
- Visits & services (25 navigation intervention types), calls, staff time, referrals with status pipeline, resource directory, to-do list and per-client timeline
- Funding sources, budget lines and expenditures with approval workflow and separation of duties
- Clinical and administrative notes (SOAP / DAP / BIRP / GIRP), electronic signature with tamper-evident hash, addenda, audited break-glass access
- 42 CFR Part 2 consents, releases of information and accounting of disclosures
- Import of notes from Pocket AI (JSON / Markdown / text), OneNote (MHT / HTML / DOCX / text), Microsoft Graph OneNote sync, pasted text and an API-key intake endpoint, all staged for review
- Dashboard, program summary, monthly trends and de-identified CSV exports

### Security and compliance
- AES-256-GCM field encryption with blind-index search, scrypt passwords, TOTP MFA with QR enrollment, lockout and rate limiting, 15-minute idle sign-out, role-based access with caseload scoping, CSRF and CSP protection
- Hash-chained audit log with integrity verification and retention purge
- Encrypted backups, key rotation, self-signed HTTPS generated in-app

### Zero-configuration deployment
- Browser setup wizard, double-click launchers for Windows, macOS and Linux
- Built-in mDNS responder (`https://suds.local`), standard HTTPS port with fallback
- Progressive web app with home-screen install on phones; per-user workspace and note drafts synchronized across devices
