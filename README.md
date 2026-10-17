# SUDS — SUD Navigator Services Tracker

**Privacy controls built to support 42 CFR Part 2, for the outreach and harm-reduction work that happens beside an
EHR — or without one: field-ready outreach (named or anonymous, on a phone, offline where the programme allows),
naloxone and supply distribution, and outcome reporting to the people who fund it, opioid-settlement funders
included.**

SUDS is for community-based organisations and county programmes doing outreach, harm reduction, naloxone and
test-strip distribution and SUD navigation, usually on opioid-settlement, SOR / Naloxone Distribution Project or SABG
prevention funding. It records outreach contacts (named or anonymous), draws supplies down from stock kept by item,
site and lot, tracks referrals and a verified resource directory, holds grant budgets, expenditures and staff time with
approvals, and produces the funder reports that go with them. Its Part 2 controls: consents that name the recipient,
one disclosure gate with an accounting of disclosures, AES-256-GCM encryption of client identifiers and free text, and
a tamper-evident audit log. Treatment-adjacent programmes can switch on clinical modules (care plan, assessments,
structured notes, CalOMS Tx, FHIR R4), or use SUDS as a Part 2 layer beside their EHR. SUDS is **not** an EHR, does
not create Drug Medi-Cal claims, and has no eMAR or e-prescribing.

It is proprietary software of AugustInnovations LLC, with its source visible ([LICENSE](LICENSE)): SUDS on this device
is free for real use at its official address, and the office server runs under a signed licence agreement after a
90-day evaluation, on the programme's own server or on an isolated instance AugustInnovations LLC hosts (no customer is
hosted yet).

| Start here | |
| --- | --- |
| **[Brochure](docs/BROCHURE.md)** | What SUDS does, the ways to run it, plans and prices, where things stand |
| **[Technical specifications](docs/TECH-SPECS.md)** | Platform, sizing, security, recovery, standards, on one page |
| **[Documentation map](docs/README.md)** | Every document, by reader: buyers, reviewers, staff, IT, maintainers, the business |
| **Try it free** | SUDS on this device: https://taugustincst.github.io/suds/ |
| **Contact** | Licensing, AugustInnovations LLC, info@suds.systems; security reports: [SECURITY.md](SECURITY.md) |

## What's new in 1.26.0

* **PowerDMS policy sign-offs:** a policy in Policies & contracts can be the county's PowerDMS document, with the
  revision staff must sign and who signs it; **Policy sign-offs** shows each person what they owe, and supervisors import
  PowerDMS's signature report to record who signed (office server; no client data; no live PowerDMS connection)
  ([docs/integration/POWERDMS.md](docs/integration/POWERDMS.md)). Migration 72 runs at start-up.
* Released twelve days after 1.25.0 on a recorded owner exception to the 28 days between feature releases
  ([docs/RELEASE.md](docs/RELEASE.md), *Stabilisation*, point 2).

## What was new in 1.25 (1.25.0 to 1.25.9)

* **1.25.0:** CalOMS Tx code sets rewritten and verified against the DHCS Data Dictionary v3.0 (the upload file layout
  is still the county's to confirm) ([docs/compliance/CALOMS.md](docs/compliance/CALOMS.md)).
* **1.25.1 to 1.25.6:** the fixes from five rounds of evaluation and from the launch of the vendor's own SUDS Server:
  safer installer defaults, offsite backups read back after every copy, recovery from a failing browser engine on
  SUDS on this device, and the release checksum published in two places.
* **1.25.7:** a revoked Part 2 consent can no longer stay in force through the FHIR consent cache; each new server's
  first administrator gets a random name.
* **1.25.8:** the audit log's head is sealed every 500 entries and at shutdown; client names refuse markup; Security
  status reports the session cookie's Secure flag (the fixes of the internal self-assessment SEC-2026-001, the vendor's
  own and not an independent test); the published plans, with vendor hosting included.
* **1.25.9:** the Security & procurement page names the vendor's contact.

Every change, release by release: [CHANGELOG.md](CHANGELOG.md).

## Two ways to run it

| | **On an office server** | **On this device** (no server) |
| --- | --- | --- |
| What | Install SUDS on an office computer ([docs/INSTALL.md](docs/INSTALL.md)); staff open it in any browser, and every phone, tablet and computer sees the same records. | Open the published web app (GitHub Pages) in a browser and start. Records are kept encrypted in that browser on that device, and nowhere else. |
| For | A programme whose staff share records. The office server is the system of record. | One navigator, or a few people sharing one device, with no office server. |
| Keeping records safe | The server's scheduled, encrypted backups. | **Download a backup** regularly (the *This device* page); Home reminds you. Read [where your records live](docs/WEB_APP.md#where-your-records-live) first. |

## Log in or sign up

The sign-in page has two options, **Log in** and **Sign up** (link straight to either with `#/login?mode=login` or `#/login?mode=signup`).

* **Office server:** *Sign up* asks for an account — your name, a username, the password you choose and a line about your role. An administrator approves it under **Settings → Users & permissions → Access requests** and chooses your role; then you *Log in*. Administrators can turn Sign up off; the page then says to ask them.
* **On this device:** the first *Sign up* creates your account and makes you the person who manages the device, once you confirm you understand where the records are kept. Anyone else sharing the device can *Sign up* for their own account (they see only their own clients) until you turn sign-ups off.

## At a glance

* **Platform:** the web application only, served by an office SUDS server or published as SUDS on this device; it
  imports field notes from Pocket AI and Microsoft OneNote ([docs/PLATFORM.md](docs/PLATFORM.md)).
* **Runtime:** Node.js ≥ 22.13 built-ins only; no npm packages on the server
  ([docs/WEB_APP.md](docs/WEB_APP.md#what-the-browser-kernel-is-built-from) for the browser engine's pinned libraries).
* **Data protection:** field-level AES-256-GCM, blind-index search, scrypt, TOTP MFA or a passkey, role-based access
  with caseload scoping, Part 2 consents and disclosure accounting, a hash-chained audit log
  ([docs/HIPAA.md](docs/HIPAA.md), [docs/security/README.md](docs/security/README.md)).
* **For funders:** the funder report, an NDP-style log, a syringe services summary, settlement outcomes by fund, and the
  county view built from each programme's signed aggregate file ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md)).
* **In the field:** a one-handed street-outreach screen for anonymous contacts, supplies drawn from stock by lot, an SSP
  participant code, field devices and offline copies where allowed ([docs/SUPPLIES.md](docs/SUPPLIES.md)).
* **Optional, off by default:** the AI documentation copilot (drafts for a person to review and sign;
  [docs/AI-COPILOT.md](docs/AI-COPILOT.md)), the county connection, one-time secure referral links, passkey
  allow-lists, FHIR import from an EHR, CalOMS scheduling.
* **Servers:** a hardened Linux installer with a weekly signed compliance check
  ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)), a Windows server zip ([docs/WINDOWS-SERVER.md](docs/WINDOWS-SERVER.md)),
  Docker ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

The full specifications: [docs/TECH-SPECS.md](docs/TECH-SPECS.md). Every document: [docs/README.md](docs/README.md).

## Get SUDS

| | |
| --- | --- |
| **Download** | https://github.com/taugustincst/suds/releases/latest — `suds-v<version>.zip` (the server, which serves the web app) |
| **Git** | `git clone https://github.com/taugustincst/suds.git` (upgrade later with `git pull`) |
| **All releases** | https://github.com/taugustincst/suds/releases |
| **Docker** | `docker compose up -d` |
| **Windows server** | `suds-<version>-windows-x64.zip` from the release: unzip, then `suds service install` and `suds service start`. No Node.js to install ([docs/WINDOWS-SERVER.md](docs/WINDOWS-SERVER.md)) |
| **SUDS Server (Linux VM)** | `sudo deploy/linux/install.sh --domain=… --admin-cidr=… --offsite=… --anchors=…`: hardened install on Ubuntu 24.04 or RHEL 9, with a weekly signed compliance check ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)) |

Current release: see [CHANGELOG.md](CHANGELOG.md). Release process: [docs/RELEASE.md](docs/RELEASE.md).

## Install

1. Install Node.js 22 LTS from https://nodejs.org.
2. Unzip SUDS somewhere permanent and start the server: `npm start` for a first look, or as a service (systemd) or with Docker for anything staff depend on. On Windows, use the Windows server zip instead (no Node.js needed): `suds service install`, then `suds service start` ([docs/WINDOWS-SERVER.md](docs/WINDOWS-SERVER.md)).
3. Open the address the server prints in a browser: the **setup wizard** asks you to name the program, create your administrator account, choose whether phones, tablets and other computers on the office network may connect, and whether staff may keep an offline copy on their devices (recommended: No). SUDS generates its encryption keys and an HTTPS certificate for you and shows a QR code for the office address.

Full walkthrough: [docs/INSTALL.md](docs/INSTALL.md); service and reverse-proxy settings: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). A county or CBO with a Linux VM installs **SUDS Server** instead — one command, hardened, and checked weekly against the policy by `npm run compliance-check`: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md), including what that does and does not make compliant. Everything the wizard sets can later be changed under **Administration → Network & devices / Settings / System & backups**.

**Phones, tablets and other computers:** nothing to install or configure. SUDS announces itself on the office network as **https://suds.local** (built-in mDNS responder) and uses the standard HTTPS port when available. Staff open that address in the browser, add it to the home screen (the `/app` page on the server walks them through it), and their workspace — clients, reminders, note drafts saved while typing, preferences — is the same everywhere because every device talks to the same server.

**Working offline (local mode):** the server can also hand out a copy of SUDS that runs inside the browser (`/?local=1`) and syncs with the office on command. It is **off by default**: it is turned on by answering *Yes* in the setup wizard or with `LOCAL_MODE_ENABLED=true`, and counties are advised to do so only for a documented field-work need. It is governed by the rules in [docs/PLATFORM.md](docs/PLATFORM.md) — the office server is authoritative.

**No server at all — SUDS on this device:** the same web app is published on GitHub Pages and runs entirely in the browser, keeping each person's records encrypted on their own device, with device backups and a backup reminder. It is republished only when a release is cut, so it always serves a released version. Details, including exactly where the records live and what that means: [docs/WEB_APP.md](docs/WEB_APP.md).

## Try it on your own computer

To test SUDS on a Windows 11 PC (or a Mac or Linux machine) with fictional sample data, install Node.js 22 LTS, download and extract SUDS, and run `npm run try` in its folder. It prints the address and the sample sign-ins. You do not need `npm install`. This is for testing only, not for real client records: the licence allows evaluation for up to 90 days with fictional data ([LICENSE](LICENSE), section 2). Step by step: [docs/TRY-ON-WINDOWS.md](docs/TRY-ON-WINDOWS.md).

## Quick start (development)

```bash
git clone <repo> suds && cd suds
npm run seed          # dev database with sample staff logins and the fictional sample data set (server/demo.js)
npm start             # http://127.0.0.1:8080
```

Sample logins (password `Navigator2026!!`): `mrivera` / `dchen` (navigators), `kpatel` (clinician), `jwalker` (supervisor), `afinance` (finance). The first administrator is named by `SUDS_ADMIN_USERNAME`, or else gets a random name (`admin-` and six letters and digits, from 1.25.7), which the seed prints; its password is printed once when the database is created, unless `SUDS_ADMIN_PASSWORD` sets it.

Without a terminal, an administrator can add the same fictional data set from inside the app (**Load sample data** on the empty home screen or under Settings) and remove it again in one click; a local-mode copy offers it on its Sync screen.

Without seeding, the first start creates the first administrator (`SUDS_ADMIN_USERNAME`, or a random `admin-…` name) and prints its name and a temporary password; the setup wizard then replaces it with the account you choose.

## Production for IT teams

The wizard route above is production mode (`SUDS_ENV=production`) with keys in `data/keys.json` and a self-signed certificate — right for an evaluation or a single workstation, not for a system other staff depend on. A county deployment runs SUDS as a service (systemd, or the Windows service of the Windows server zip) behind the county's own certificate or reverse proxy, with environment variables, or in Docker (`docker compose up -d`, includes a Caddy TLS proxy configured by `Caddyfile`): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), including its key rotation runbook. Environment variables always override the wizard's settings. Release downloads ship with `.sha256` checksum files.

## What it tracks

| Area | Details |
| --- | --- |
| Outreach & visits | Anonymous or named encounters in the field on a phone, naloxone kits and fentanyl test strips given, referrals made, follow-ups; works offline on an encrypted device copy |
| Supplies | Any harm-reduction or syringe-services item (naloxone by product, fentanyl and xylazine test strips, syringes by size, sharps containers, safer-use, wound-care and hygiene supplies) kept at sites you set up (office, van, drop-in, partner site) in lots with an expiry date; a receiving log (NDP, CDPH clearinghouse, purchase with a fund, donation), transfers between sites, adjustments with a reason and disposal of expired stock, as an append-only ledger; visits and anonymous contacts draw stock down first-expiry-first-out, a shortfall is flagged rather than going below zero, and expiring or expired lots are on Home for supervisors; syringes and sharps returned (counted or estimated from the container), and a syringe services (SSP) summary with CSV/Excel export ([docs/SUPPLIES.md](docs/SUPPLIES.md)) |
| Overdoses & reversals | Overdose and reversal reports (who gave naloxone, doses, where), linked to a client or anonymous |
| Grant reporting | Funder report (unduplicated people, services, hours, spending by fund; exact counts for your own submission, small-cell screened for publication), a Naloxone Distribution Project-style log (with the naloxone product where the visit recorded it), a syringe services summary and opioid-settlement spending by allowable use — each layout to be checked against the current official template |
| Clients | Encrypted demographics and contact info, substance use profile, ASAM level, MAT status, overdose / naloxone history, risk level, housing, insurance, safety flags, program status and intake/discharge |
| Visits | 25 SUD-navigation visit (intervention) types, duration, location/modality, outcome, stage of change, naloxone kits and fentanyl test strips, funding source, cost, follow-up to-do creation, time entry from the visit when ticked |
| Calls | Direction, contact type, duration, outcome, crisis flag, encrypted summary, follow-up scheduling |
| Time | Per-worker time entries by category and funding source, billable flag, summaries by worker / category / day / fund |
| Starter directories | One-click load of a whole region's programs (81 across the eight Sacramento-area counties), flagged unverified until your staff confirm each one |
| County forms | Form library of the program's own forms (PDF/Word/picture) with fillable fields, pre-filled from the client record, saved encrypted to the client, printable as PDF, with the signed copy attached |
| Resources & referrals | Community resource directory (detox, residential, OTP/OBOT, housing, harm reduction, legal, …) with treatment center profiles: services-offered tags, plain-language summary, levels of care, how to refer, cost and a picture gallery; verification dates; referrals with status pipeline, urgency, warm handoff, consent linkage, barriers, days-to-admit |
| To-dos & timelines | To-dos with priorities, due dates, milestones; unified per-client timeline of every event |
| Budget | Funding sources (opioid settlement, SOR, SAMHSA, county…), budget lines, expenditures with approval workflow and separation of duties, burn-rate vs. period elapsed, staff-cost allocation |
| Notes | Administrative and clinical notes (the structured clinical formats matter to treatment-adjacent programmes; outreach staff mostly write short administrative notes) with role-based visibility, SOAP / DAP / BIRP / GIRP structured formats, electronic signature with tamper-evident hash, addenda, break-glass access for administrators |
| Consents | 42 CFR Part 2 disclosure consents, releases of information, expirations/revocations, and an accounting of disclosures |
| Imports | Pocket AI JSON/Markdown/text exports, OneNote MHT/HTML/DOCX/text exports, Microsoft Graph OneNote sync, pasted text, and an API-key intake endpoint — all staged for review and client matching before becoming notes |
| EHR integration | *Treatment-adjacent module, off by default (Settings › Program › Modules).* Read-only FHIR R4 API (Patient, EpisodeOfCare, Encounter, Consent, ServiceRequest, Task, Observation, DocumentReference, the resource directory, Bulk Data `$export`) for the county EHR or an HIE, with OAuth2 client-credentials clients and scopes; a client's records are shared only under a live 42 CFR Part 2 consent naming the recipient, labelled and recorded in the accounting of disclosures (docs/integration/FHIR.md) |
| Reports | Dashboard, program summary, monthly trends, Excel / CSV exports of every table or one workbook (de-identified by default) |
| Spreadsheets | Import clients, resources, visits, calls, time, to-dos and expenditures from Excel or CSV with templates, automatic column matching and row validation |
| Administration | Users & permissions, MFA enforcement, settings, tamper-evident audit log viewer, API keys |

## Roles

| Role | Sees | Can |
| --- | --- | --- |
| navigator | All clients (`clients:all`, 1.16.0; an administrator can hold a person to their caseload by denying it) | Clients, visits, calls, time, referrals, to-dos (their own work; changing another worker's records is `records:manage-others`, supervisors and administrators), admin notes, reads clinical notes except SUD counseling notes (`notes:clinical:read`, 1.16.0; counseling notes only for their author, the co-signer and those who write clinical notes, 1.16.1; cannot write them), consents, imports, de-identified exports; records expenditures (grant structure itself is `budget:manage`: supervisor, finance, admin); sees the supply stock and records deliveries received (items, sites, transfers, adjustments and disposal are `supplies:manage`: supervisor, admin) |
| clinician | All clients (`clients:all`, 1.16.0, for coverage and on-call; deniable per person) | Clients, visits, calls, time, referrals, to-dos (their own work, on any client), admin and **clinical notes**, consents, imports, de-identified exports; reads the resource directory; sees the budget and spending (`budget:read`, 1.16.0; no budget entry); sees the supply stock and records deliveries received |
| supervisor | All clients | Everything, plus changing or removing other workers' records (`records:manage-others`), assignments, approvals, audit log, break-glass review, de-identified and identified exports, consent overrides |
| finance | De-identified list | Funding, budget lines, expenditure approval, staff time approval (every submitted entry, on the Supervision page), time summaries, de-identified exports; writes the funder report (`reports:funder`): the program's own submission of the funder report, NDP log and settlement report (also in the DHCS and county settlement layouts) — exact aggregate counts, by fund and any range, no client-level data — and publication releases |
| readonly | De-identified list | Reports and summaries (funder, NDP and settlement reports as publication releases only), resource directory; no client records, no notes, no exports |
| admin | System | Users, settings, API keys, audit, legal holds; clinical notes only via audited break-glass |

Nobody approves their own expenditure or their own time, administrators included; another approver must review it. Exports need `export:read` (every role but readonly) and are de-identified to the HIPAA Safe Harbor standard — dates reduced to the year, ages over 89 as `90+`, ZIP codes to three digits (`000` for sparsely populated areas), client codes replaced by a record id drawn at random for each export, and each dataset limited to an allow-listed set of columns with free text, names, references and locations left out — unless the user also holds `export:identified` (supervisor, admin) and names the recipient and purpose, which is then written to each client's accounting of disclosures (once per client per file). CSV cells that would be read as formulas are neutralised, and every export response carries its classification in an `X-SUDS-Export` header and its filename. Multi-factor authentication is required of every role by default.

## Tests

```bash
npm test
```

Runs unit tests (crypto, TOTP, importers) and API integration tests (auth, lockout, MFA, RBAC, caseload scoping, encryption at rest, note signing, consents, budget, imports, intake, audit chain).

The browser regression suite (`scripts/ui/run-all.sh`) seeds a throwaway server and drives Chromium through the desktop screens, the navigator workflow, browser local mode, two-way sync, spreadsheet import/export and sample data. CI runs it on every push; locally it needs `npm i --no-save playwright && npx playwright install chromium`. CI's required jobs — the ones the release gate checks before anything is published ([docs/RELEASE.md](docs/RELEASE.md#release-gate)) — are `test`, `thorough`, `thorough-sdc` (the full-size disclosure sweeps, `npm run test:thorough`), `browser`, `node24` (`npm test` on Node 24), `dr-drill` and `evening` (`npm test` at 9pm in Los Angeles, `scripts/test-evening.sh`). Two jobs are advisory: a WebKit smoke subset (`SUDS_BROWSER=webkit SCRIPTS="static-site qa-retest device-recovery" scripts/ui/run-all.sh`, after `npx playwright install --with-deps webkit`), and `release-state`, which compares what the release documents say with origin's tags, `main` and GitHub Pages (`node scripts/release-state.js`; [docs/RELEASE.md](docs/RELEASE.md), stamp checklist). A `windows` job runs `npm run try` and the OS-sensitive tests on `windows-2025` ([docs/TRY-ON-WINDOWS.md](docs/TRY-ON-WINDOWS.md)); like `release-policy` it is not on the release gate's list, but a red run fails CI. No CI job replaces the real-device checklist in [docs/ADOPTION.md](docs/ADOPTION.md).

## License

Proprietary: Copyright (c) 2026 AugustInnovations LLC. All rights reserved. The source is visible. SUDS on this device may be used free of charge, real records included, at its official GitHub Pages address (LICENSE section 2A); anyone may evaluate an unmodified copy of the rest, the office server included, for up to 90 days with fictional data only; and production use of the office server, modification and redistribution need a signed licence agreement ([LICENSE](LICENSE)). Versions 1.24.0 and earlier were published under the MIT License, and copies of them keep those rights. Third-party components keep their own licences ([NOTICE](NOTICE), also shipped in the Pages build and the Windows zip). Report security vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. This software supports but does not by itself provide HIPAA compliance; see [docs/HIPAA.md](docs/HIPAA.md) for the shared-responsibility model.
