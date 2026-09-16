# Changelog

All notable changes to SUDS are documented here. The project follows semantic versioning.

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
