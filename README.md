# SUDS — SUD Navigator Services Tracker

A HIPAA-oriented, zero-dependency web application for county **substance use disorder (SUD) navigation programs**. It tracks clients, interventions, calls, staff time, referrals and community resources, tasks and timelines, budget and expenditures, and clinical / administrative documentation — and imports field notes from **Pocket AI** and **Microsoft OneNote**.

* **Runtime:** Node.js ≥ 22.13 only (built-in SQLite, crypto, HTTP). No npm packages to install or audit on the office server. (The phone apps' in-browser kernel is a separate, committed bundle that does vendor a few pinned libraries in place of Node's built-ins — see [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md#what-the-phone-copy-is-built-from).)
* **Data protection:** AES-256-GCM field-level encryption of PHI, blind-index search, scrypt password hashing, TOTP MFA, role-based access with caseload scoping, 42 CFR Part 2 consent and disclosure accounting, and a hash-chained audit log.
* **Documentation:** [Deployment](docs/DEPLOYMENT.md) · [Browser-only web app](docs/WEB_APP.md) · [API reference](docs/API.md) · [HIPAA & security controls](docs/HIPAA.md) · [Importing notes (Pocket AI / OneNote)](docs/IMPORTS.md) · [User guide](docs/USER_GUIDE.md)

## Get SUDS

| | |
| --- | --- |
| **Download** | https://github.com/taugustincst/suds/releases/latest — `suds-v<version>.zip` (server + launchers) and `SUDS-android.apk` (phone app) |
| **Git** | `git clone https://github.com/taugustincst/suds.git` (upgrade later with `git pull`) |
| **All releases** | https://github.com/taugustincst/suds/releases |
| **Docker** | `docker compose up -d` |

Current release: see [CHANGELOG.md](CHANGELOG.md). Release process: [docs/RELEASE.md](docs/RELEASE.md).

## Install without a terminal (recommended for county staff)

1. Install Node.js LTS from https://nodejs.org (click *Next* through the installer).
2. Unzip SUDS somewhere permanent and double-click `launchers/Start-SUDS.bat` (Windows), `launchers/Start-SUDS.command` (Mac) or `launchers/start-suds.sh` (Linux).
3. Your browser opens the **setup wizard**: name the program, create your administrator account, and choose whether phones and tablets on the office network may connect. SUDS generates its encryption keys and an HTTPS certificate for you and shows a QR code for phones.

Full walkthrough with screenshots-free steps: [docs/INSTALL.md](docs/INSTALL.md). Everything the wizard sets can later be changed under **Administration → Network & devices / Settings / System & backups**.

**Phone app (works offline, syncs on command):** the Android APK on the Releases page bundles a complete copy of SUDS. Install it, create a local account, work anywhere; tap **Sync** near the office to exchange changes both ways. The office computer does not need to be running at install time or while working. Details: [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md).

**Phones and other computers:** nothing to configure. SUDS announces itself on the office network as **https://suds.local** (built-in mDNS responder) and uses the standard HTTPS port when available. Staff open that address on any device, add it to the home screen, and their workspace — clients, reminders, note drafts saved while typing, preferences — is the same everywhere because every device talks to the same server.

**Just a browser, nothing to install:** a fully standalone build runs entirely in the browser — no office server, no Node process, no database anywhere else. Open it on any phone or computer, add it to the home screen, and it works, including offline; sync with a real office SUDS later if the county has one. Its encryption keys live in that browser profile beside the data, so it is for trying SUDS out and for sample data; real client information belongs in the phone apps or on an office server. Details: [docs/WEB_APP.md](docs/WEB_APP.md).

## Quick start (development)

```bash
git clone <repo> suds && cd suds
npm run seed          # dev database with demo staff logins and the fictional sample data set (server/demo.js)
npm start             # http://127.0.0.1:8080
```

Demo logins (password `Navigator2026!!`): `mrivera` / `dchen` (navigators), `kpatel` (clinician), `jwalker` (supervisor), `afinance` (finance), `admin`.

Without a terminal, an administrator can add the same fictional data set from inside the app (**Load sample data** on the empty home screen or under Settings) and remove it again in one click; phones offer it on their Sync screen.

Without seeding, the first start creates an `admin` user and prints a temporary password.

## Production for IT teams

The launcher + wizard route above is production mode (`SUDS_ENV=production`) with keys in `data/keys.json` and a self-signed certificate — right for an evaluation or a single workstation, not for a system other staff depend on: the launchers do not survive a closed window or a reboot. A county deployment runs SUDS as a service (systemd or NSSM) behind the county's own certificate or reverse proxy, with environment variables, or in Docker (`docker compose up -d`, includes a Caddy TLS proxy configured by `Caddyfile`): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), including its key rotation runbook. Environment variables always override the wizard's settings. Release downloads ship with `.sha256` checksum files.

## What it tracks

| Area | Details |
| --- | --- |
| Clients | Encrypted demographics and contact info, substance use profile, ASAM level, MAT status, overdose / naloxone history, risk level, housing, insurance, safety flags, program status and intake/discharge |
| Interventions | 25 SUD-navigation intervention types, duration, location/modality, outcome, stage of change, naloxone kits and fentanyl test strips, funding source, cost, follow-up task creation, automatic time entry |
| Calls | Direction, contact type, duration, outcome, crisis flag, encrypted summary, follow-up scheduling |
| Time | Per-worker time entries by category and funding source, billable flag, summaries by worker / category / day / fund |
| Starter directories | One-click load of a whole region's programs (81 across the eight Sacramento-area counties), flagged unverified until your staff confirm each one |
| County forms | Form library of the program's own forms (PDF/Word/picture) with fillable fields, pre-filled from the client record, saved encrypted to the client, printable as PDF, with the signed copy attached |
| Resources & referrals | Community resource directory (detox, residential, OTP/OBOT, housing, harm reduction, legal, …) with treatment center profiles: services-offered tags, plain-language summary, levels of care, how to refer, cost and a picture gallery; verification dates; referrals with status pipeline, urgency, warm handoff, consent linkage, barriers, days-to-admit |
| Tasks & timelines | Tasks with priorities, due dates, milestones; unified per-client timeline of every event |
| Budget | Funding sources (opioid settlement, SOR, SAMHSA, county…), budget lines, expenditures with approval workflow and separation of duties, burn-rate vs. period elapsed, staff-cost allocation |
| Notes | Clinical vs. administrative notes with role-based visibility, SOAP / DAP / BIRP / GIRP structured formats, electronic signature with tamper-evident hash, addenda, break-glass access for administrators |
| Consents | 42 CFR Part 2 disclosure consents, releases of information, expirations/revocations, and an accounting of disclosures |
| Imports | Pocket AI JSON/Markdown/text exports, OneNote MHT/HTML/DOCX/text exports, Microsoft Graph OneNote sync, pasted text, and an API-key intake endpoint — all staged for review and client matching before becoming notes |
| Reports | Dashboard, program summary, monthly trends, Excel / CSV exports of every table or one workbook (de-identified by default) |
| Spreadsheets | Import clients, resources, visits, calls, time, to-dos and expenditures from Excel or CSV with templates, automatic column matching and row validation |
| Administration | Users and roles, MFA enforcement, settings, tamper-evident audit log viewer, API keys |

## Roles

| Role | Sees | Can |
| --- | --- | --- |
| navigator | Assigned caseload | Clients, interventions, calls, time, referrals, tasks, admin notes, consents, imports; records expenditures (grant structure itself is `budget:manage`: supervisor, finance, admin) |
| clinician | Assigned caseload | Clients, interventions, calls, time, referrals, tasks, admin and **clinical notes**, consents, imports; reads the resource directory (no budget entry) |
| supervisor | All clients | Everything, plus assignments, approvals, audit log, identified exports |
| finance | De-identified list | Funding, budget lines, expenditure approval, time summaries |
| readonly | All clients (read) | Reports and summaries; no notes |
| admin | System | Users, settings, API keys, audit; clinical notes only via audited break-glass |

## Tests

```bash
npm test
```

Runs unit tests (crypto, TOTP, importers) and API integration tests (auth, lockout, MFA, RBAC, caseload scoping, encryption at rest, note signing, consents, budget, imports, intake, audit chain).

The browser regression suite (`scripts/ui/run-all.sh`) seeds a throwaway server and drives Chromium through the desktop screens, the navigator workflow, phone-only mode, two-way sync, spreadsheet import/export and sample data. CI runs it on every push; locally it needs `npm i --no-save playwright && npx playwright install chromium`.

## License

MIT. This software supports but does not by itself provide HIPAA compliance; see [docs/HIPAA.md](docs/HIPAA.md) for the shared-responsibility model.
