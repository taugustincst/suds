# Changelog

All notable changes to SUDS are documented here. The project follows semantic versioning.

## Unreleased

Compliance review fixes (HIPAA / 42 CFR Part 2) and county IT hardening. Schema 19; databases upgrade in place.

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
