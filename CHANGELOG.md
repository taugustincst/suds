# Changelog

All notable changes to SUDS are documented here. The project follows semantic versioning.

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
