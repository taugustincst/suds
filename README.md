# SUDS — SUD Navigator Services Tracker

A HIPAA-oriented, zero-dependency web application for county **substance use disorder (SUD) navigation programs**. It tracks clients, interventions, calls, staff time, referrals and community resources, tasks and timelines, budget and expenditures, and clinical / administrative documentation — and imports field notes from **Pocket AI** and **Microsoft OneNote**.

* **Platform:** the web application served by the office SUDS server is the only supported client and the system of record. The native phone apps and the desktop launchers are deprecated and will be removed — see [docs/PLATFORM.md](docs/PLATFORM.md).
* **Runtime:** Node.js ≥ 22.13 only (built-in SQLite, crypto, HTTP). No npm packages to install or audit on the office server. (The browser's local-mode kernel is a separate, committed bundle that does vendor a few pinned libraries in place of Node's built-ins — see [docs/WEB_APP.md](docs/WEB_APP.md#what-the-browser-kernel-is-built-from).)
* **Data protection:** AES-256-GCM field-level encryption of PHI, blind-index search, scrypt password hashing, TOTP MFA, role-based access with caseload scoping, 42 CFR Part 2 consent and disclosure accounting, and a hash-chained audit log.
* **Documentation:** [Platform policy](docs/PLATFORM.md) · [Deployment](docs/DEPLOYMENT.md) · [Browser-only web app](docs/WEB_APP.md) · [API reference](docs/API.md) · [HIPAA & security controls](docs/HIPAA.md) · [Importing notes (Pocket AI / OneNote)](docs/IMPORTS.md) · [User guide](docs/USER_GUIDE.md)

## Get SUDS

| | |
| --- | --- |
| **Download** | https://github.com/taugustincst/suds/releases/latest — `suds-v<version>.zip` (the server, which serves the web app) |
| **Git** | `git clone https://github.com/taugustincst/suds.git` (upgrade later with `git pull`) |
| **All releases** | https://github.com/taugustincst/suds/releases |
| **Docker** | `docker compose up -d` |

Current release: see [CHANGELOG.md](CHANGELOG.md). Release process: [docs/RELEASE.md](docs/RELEASE.md).

## Install

1. Install Node.js 22 LTS from https://nodejs.org.
2. Unzip SUDS somewhere permanent and start the server: `npm start` for a first look, or as a service (systemd / NSSM) or with Docker for anything staff depend on.
3. Open the address the server prints in a browser: the **setup wizard** asks you to name the program, create your administrator account, and choose whether phones, tablets and other computers on the office network may connect. SUDS generates its encryption keys and an HTTPS certificate for you and shows a QR code for the office address.

Full walkthrough: [docs/INSTALL.md](docs/INSTALL.md); service and reverse-proxy settings: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Everything the wizard sets can later be changed under **Administration → Network & devices / Settings / System & backups**.

**Phones, tablets and other computers:** nothing to install or configure. SUDS announces itself on the office network as **https://suds.local** (built-in mDNS responder) and uses the standard HTTPS port when available. Staff open that address in the browser, add it to the home screen (the `/app` page on the server walks them through it), and their workspace — clients, reminders, note drafts saved while typing, preferences — is the same everywhere because every device talks to the same server.

**Working offline (local mode):** the server can also hand out a copy of SUDS that runs inside the browser (`/?local=1`) and syncs with the office on command. It is governed by the rules in [docs/PLATFORM.md](docs/PLATFORM.md) — the office server is authoritative — and counties are advised to leave it off (`LOCAL_MODE_ENABLED=false`) unless there is a documented field-work need.

**Demo in a browser, nothing to install:** a standalone build of the same web app runs on GitHub Pages with no server at all, for trying SUDS out with sample data only. Details: [docs/WEB_APP.md](docs/WEB_APP.md).

## Quick start (development)

```bash
git clone <repo> suds && cd suds
npm run seed          # dev database with demo staff logins and the fictional sample data set (server/demo.js)
npm start             # http://127.0.0.1:8080
```

Demo logins (password `Navigator2026!!`): `mrivera` / `dchen` (navigators), `kpatel` (clinician), `jwalker` (supervisor), `afinance` (finance), `admin`.

Without a terminal, an administrator can add the same fictional data set from inside the app (**Load sample data** on the empty home screen or under Settings) and remove it again in one click; a local-mode copy offers it on its Sync screen.

Without seeding, the first start creates an `admin` user and prints a temporary password.

## Production for IT teams

The wizard route above is production mode (`SUDS_ENV=production`) with keys in `data/keys.json` and a self-signed certificate — right for an evaluation or a single workstation, not for a system other staff depend on. A county deployment runs SUDS as a service (systemd or NSSM) behind the county's own certificate or reverse proxy, with environment variables, or in Docker (`docker compose up -d`, includes a Caddy TLS proxy configured by `Caddyfile`): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), including its key rotation runbook. Environment variables always override the wizard's settings. Release downloads ship with `.sha256` checksum files.

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
| navigator | Assigned caseload | Clients, interventions, calls, time, referrals, tasks, admin notes, consents, imports, de-identified exports of their own caseload; records expenditures (grant structure itself is `budget:manage`: supervisor, finance, admin) |
| clinician | Assigned caseload | Clients, interventions, calls, time, referrals, tasks, admin and **clinical notes**, consents, imports, de-identified exports of their own caseload; reads the resource directory (no budget entry) |
| supervisor | All clients | Everything, plus assignments, approvals, audit log, break-glass review, de-identified and identified exports, consent overrides |
| finance | De-identified list | Funding, budget lines, expenditure approval, staff time approval (every submitted entry, on the Supervision page), time summaries, de-identified exports |
| readonly | De-identified list | Reports and summaries, resource directory; no client records, no notes, no exports |
| admin | System | Users, settings, API keys, audit, legal holds; clinical notes only via audited break-glass |

Nobody approves their own expenditure or their own time, administrators included; another approver must review it. Exports need `export:read` (every role but readonly) and are de-identified to the HIPAA Safe Harbor standard — each dataset carries only an allow-listed set of columns, with free text, names, references and locations left out — unless the user also holds `export:identified` (supervisor, admin) and names the recipient and purpose, which is then written to each client's accounting of disclosures (once per client per file). CSV cells that would be read as formulas are neutralised, and every export response carries its classification in an `X-SUDS-Export` header and its filename. Multi-factor authentication is required of every role by default.

## Tests

```bash
npm test
```

Runs unit tests (crypto, TOTP, importers) and API integration tests (auth, lockout, MFA, RBAC, caseload scoping, encryption at rest, note signing, consents, budget, imports, intake, audit chain).

The browser regression suite (`scripts/ui/run-all.sh`) seeds a throwaway server and drives Chromium through the desktop screens, the navigator workflow, browser local mode, two-way sync, spreadsheet import/export and sample data. CI runs it on every push; locally it needs `npm i --no-save playwright && npx playwright install chromium`.

## License

MIT. This software supports but does not by itself provide HIPAA compliance; see [docs/HIPAA.md](docs/HIPAA.md) for the shared-responsibility model.
