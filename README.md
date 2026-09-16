# SUDS — SUD Navigator Services Tracker

A HIPAA-oriented, zero-dependency web application for county **substance use disorder (SUD) navigation programs**. It tracks clients, interventions, calls, staff time, referrals and community resources, tasks and timelines, budget and expenditures, and clinical / administrative documentation — and imports field notes from **Pocket AI** and **Microsoft OneNote**.

* **Runtime:** Node.js ≥ 22.13 only (built-in SQLite, crypto, HTTP). No npm packages to install or audit.
* **Data protection:** AES-256-GCM field-level encryption of PHI, blind-index search, scrypt password hashing, TOTP MFA, role-based access with caseload scoping, 42 CFR Part 2 consent and disclosure accounting, and a hash-chained audit log.
* **Documentation:** [Deployment](docs/DEPLOYMENT.md) · [API reference](docs/API.md) · [HIPAA & security controls](docs/HIPAA.md) · [Importing notes (Pocket AI / OneNote)](docs/IMPORTS.md) · [User guide](docs/USER_GUIDE.md)

## Get SUDS

| | |
| --- | --- |
| **Download 1.0.0 (zip)** | https://github.com/taugustincst/suds/archive/refs/heads/release/v1.0.0.zip — unzip and double-click a launcher |
| **Git** | `git clone --branch release/v1.0.0 https://github.com/taugustincst/suds.git` (or clone `main` for the latest; upgrade later with `git pull`) |
| **Releases page** | https://github.com/taugustincst/suds/releases (populated by the Release workflow once GitHub Actions is enabled for the repository) |
| **Docker** | `docker compose up -d` |

Current release: see [CHANGELOG.md](CHANGELOG.md). Release process: [docs/RELEASE.md](docs/RELEASE.md).

## Install without a terminal (recommended for county staff)

1. Install Node.js LTS from https://nodejs.org (click *Next* through the installer).
2. Unzip SUDS somewhere permanent and double-click `launchers/Start-SUDS.bat` (Windows), `launchers/Start-SUDS.command` (Mac) or `launchers/start-suds.sh` (Linux).
3. Your browser opens the **setup wizard**: name the program, create your administrator account, and choose whether phones and tablets on the office network may connect. SUDS generates its encryption keys and an HTTPS certificate for you and shows a QR code for phones.

Full walkthrough with screenshots-free steps: [docs/INSTALL.md](docs/INSTALL.md). Everything the wizard sets can later be changed under **Administration → Network & devices / Settings / System & backups**.

**Native phone apps:** `mobile/android` (APK served to staff from `https://suds.local/app`) and `mobile/ios` (TestFlight). See [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md).

**Phones and other computers:** nothing to configure. SUDS announces itself on the office network as **https://suds.local** (built-in mDNS responder) and uses the standard HTTPS port when available. Staff open that address on any device, add it to the home screen, and their workspace — clients, reminders, note drafts saved while typing, preferences — is the same everywhere because every device talks to the same server.

## Quick start (development)

```bash
git clone <repo> suds && cd suds
npm run seed          # creates a dev database with demo users and fictional clients
npm start             # http://127.0.0.1:8080
```

Demo logins (password `Navigator2026!!`): `mrivera` / `dchen` (navigators), `kpatel` (clinician), `jwalker` (supervisor), `afinance` (finance), `admin`.

Without seeding, the first start creates an `admin` user and prints a temporary password.

## Production for IT teams

The launcher + wizard route above is production mode (`SUDS_ENV=production`) with keys in `data/keys.json` and a self-signed certificate. IT teams who prefer environment variables, a real certificate, a systemd service or Docker (`docker compose up -d`, includes a Caddy TLS proxy) should read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Environment variables always override the wizard's settings.

## What it tracks

| Area | Details |
| --- | --- |
| Clients | Encrypted demographics and contact info, substance use profile, ASAM level, MAT status, overdose / naloxone history, risk level, housing, insurance, safety flags, program status and intake/discharge |
| Interventions | 25 SUD-navigation intervention types, duration, location/modality, outcome, stage of change, naloxone kits and fentanyl test strips, funding source, cost, follow-up task creation, automatic time entry |
| Calls | Direction, contact type, duration, outcome, crisis flag, encrypted summary, follow-up scheduling |
| Time | Per-worker time entries by category and funding source, billable flag, summaries by worker / category / day / fund |
| Resources & referrals | Community resource directory (detox, residential, OTP/OBOT, housing, harm reduction, legal, …) with verification dates; referrals with status pipeline, urgency, warm handoff, consent linkage, barriers, days-to-admit |
| Tasks & timelines | Tasks with priorities, due dates, milestones; unified per-client timeline of every event |
| Budget | Funding sources (opioid settlement, SOR, SAMHSA, county…), budget lines, expenditures with approval workflow and separation of duties, burn-rate vs. period elapsed, staff-cost allocation |
| Notes | Clinical vs. administrative notes with role-based visibility, SOAP / DAP / BIRP / GIRP structured formats, electronic signature with tamper-evident hash, addenda, break-glass access for administrators |
| Consents | 42 CFR Part 2 disclosure consents, releases of information, expirations/revocations, and an accounting of disclosures |
| Imports | Pocket AI JSON/Markdown/text exports, OneNote MHT/HTML/DOCX/text exports, Microsoft Graph OneNote sync, pasted text, and an API-key intake endpoint — all staged for review and client matching before becoming notes |
| Reports | Dashboard, program summary, monthly trends, CSV exports (de-identified by default) |
| Administration | Users and roles, MFA enforcement, settings, tamper-evident audit log viewer, API keys |

## Roles

| Role | Sees | Can |
| --- | --- | --- |
| navigator | Assigned caseload | Clients, interventions, calls, time, referrals, tasks, admin notes, consents, budget entry, imports |
| clinician | Assigned caseload | Everything a navigator can plus **clinical notes** |
| supervisor | All clients | Everything, plus assignments, approvals, audit log, identified exports |
| finance | De-identified list | Funding, budget lines, expenditure approval, time summaries |
| readonly | All clients (read) | Reports and summaries; no notes |
| admin | System | Users, settings, API keys, audit; clinical notes only via audited break-glass |

## Tests

```bash
npm test
```

Runs unit tests (crypto, TOTP, importers) and API integration tests (auth, lockout, MFA, RBAC, caseload scoping, encryption at rest, note signing, consents, budget, imports, intake, audit chain).

A browser smoke test of the full navigator workflow lives in `scripts/ui-smoke.mjs` (needs a seeded running server and a global Playwright install).

## License

MIT. This software supports but does not by itself provide HIPAA compliance; see [docs/HIPAA.md](docs/HIPAA.md) for the shared-responsibility model.
