# SUDS — SUD Navigator Services Tracker

**Privacy controls built to support 42 CFR Part 2, for the outreach and harm-reduction work that happens beside an
EHR — or without one: field-ready outreach (named or anonymous, on a phone, offline where the programme allows),
naloxone and supply distribution, and outcome reporting to the people who fund it, opioid-settlement funders
included.**

SUDS is for community-based organisations and county programmes doing outreach, harm reduction, naloxone and
test-strip distribution and prevention-funded outreach, usually on opioid-settlement, SOR / Naloxone Distribution
Project or SABG prevention funding (group and community prevention events are recorded with their CSAP strategy,
IOM category, hours and attendance, and summarised for a period; a PPSDS submission file is not produced — its
mapping awaits the DHCS data dictionary; [POSITIONING.md](docs/market/POSITIONING.md)). It records outreach contacts
(named or anonymous), draws supplies down from stock kept by item, site and lot, tracks referrals and a verified
resource directory, holds grant budgets, expenditures and staff time with approvals, and produces the funder reports that go with them. Its privacy controls are built to support
42 CFR Part 2: consents that name the recipient, one disclosure gate with an accounting of disclosures, AES-256-GCM
encryption of client identifiers and free text, and a tamper-evident audit log of PHI reads and writes, sign-ins,
exports, disclosures and configuration changes.

**Optional modules.** Programmes that are treatment-adjacent can switch the *programme profile* from **Harm
reduction & outreach** (the default) to **Treatment-adjacent** to show the clinical modules: care plan, problem
list and assessments, structured clinical notes, CalOMS Tx (extract not yet verified against the DHCS data
dictionary), a FHIR R4 feed and a county EHR encounter hand-off. A programme whose EHR stays the clinical record
can choose **Part 2 compliance module (beside an EHR)** instead: the consent, disclosure and breach work leads,
with patients and encounters imported from the EHR ([docs/integration/EHR-PART2-LAYER.md](docs/integration/EHR-PART2-LAYER.md)). SUDS is **not** an EHR, does not create Drug
Medi-Cal claims, and has no eMAR or e-prescribing. It is free, MIT-licensed software that the programme (or its IT
partner, or its county) runs; it is not a hosted service. Positioning, buyer guides, hosting models, the pilot kit
and the readiness scorecard: [docs/market/README.md](docs/market/README.md). How it is built, for maintainers:
[docs/architecture/README.md](docs/architecture/README.md).

## What's new in 1.18.0 to 1.22.0

**1.22.0**

* **Easier days for frontline workers** ([docs/USER_GUIDE.md](docs/USER_GUIDE.md)): a call-back date on a call or text
  now always makes its to-do (before, a date with *Follow-up needed* left unticked made none); *Today*, *Tomorrow*,
  *In a week* and other quick dates on to-dos and follow-ups; **Where things stand** at the top of a client's Overview
  (the last contact, the next to-do, open referrals); in street outreach *Save contact* stays in reach, **Undo** for
  10 seconds and **Same as last contact**; a new note starts in your usual format; supervisors see who made each
  referral still awaiting an outcome; a device that syncs with the office shows in the header whether changes are
  waiting to be sent.
* **The field scope follows the account**: once a worker's device is a field device, every device of that account is
  held to the field scope, whatever device id it sends; only an administrator can keep one device whole (*Keep
  everything*). **On upgrade, a whole device of such an account becomes a field device at its next sync** unless an
  administrator marks it first ([docs/PLATFORM.md](docs/PLATFORM.md#field-devices)).
* **County publication consent and corrections**: a release names only programmes whose written consent the county
  has recorded; a withdrawn release's period can be published again as an audited correction; awards are also
  pro-rated to the period ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#publication)).
* **Safer defaults**: the authenticator allow-list stops a passkey it newly refuses only after a grace period (14 days
  by default; [docs/FINGERPRINT.md](docs/FINGERPRINT.md#grace-period)), and a county file made by hand is version 1
  unless the county is known to read version 2.
* The penetration-test scope drawn from the threat model, release integrity stated plainly (1.16.3 to 1.22.0 were
  published without a tag), the SUDS Server listener fixed under its sandbox, and the evidence re-run on 1.21.0.
  Upgrading runs migrations 64 to 66 on start.

**1.21.0**

* **County publication releases**: County view › Publish makes a screened, publishable release of a county's
  combined figures for a period, with the programme's own small-cell method audited against every programme's own
  release (so a county total cannot give a small programme's figure away by subtraction), shown for review first,
  recorded with its SHA-256 and never changed; withdrawal is a record of its own. Office server only; no new
  permission ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#publication)).
* **Award amounts and reminders in the county file**: the county file (schema version 2) carries each fund's award,
  and the combined view shows spending against the award; Home reminds whoever makes the county file which one is
  due. **Upgrade a county's server before its programmes send version 2 files**
  ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#award-amounts-schema-version-2)).
* **Field devices and participant codes first**: a device can hold only its worker's own recent caseload, without
  contact, intake, legal or clinical details, enforced by the office on every sync; outreach records can start from a
  participant code, with the name behind *Add a name*. Both off until an administrator turns them on
  ([docs/PLATFORM.md](docs/PLATFORM.md#field-devices)).
* **An authenticator allow-list for passkeys**: a programme can accept only the authenticator models it lists, each
  proven by its attestation against a FIDO Metadata Service file the administrator loads (no outbound call). Off by
  default; office server only ([docs/FINGERPRINT.md](docs/FINGERPRINT.md#authenticator-allow-list)).
* A threat model and fuzz tests for the county surface and SUDS Server, a check of the release documents against the
  repository, and a county evidence packet. Upgrading runs migrations 61 to 63 on start.

**1.20.0**

* **County-entered figures for grantees not on SUDS**: a county registers a grantee that does not run SUDS and
  enters its figures for a period, or imports them from a CSV in the combined view's own layout, with the source
  document they came from. They are marked *entered by the county — not signed by the program* in every view, file
  and read-API answer, a signed file from the programme always outranks them, and the county can leave them out.
  Office server only; no new permission ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#county-entered-figures)).
* **SUDS Server's installer and first day**, fixed after a real install in a systemd container: both shares checked
  in one refusal, the first backup and recovery drill run by the installer, `/api/health` not red while the first
  scheduled backup is pending, passkeys' `WEBAUTHN_RP_ID` set from `--domain`, and the release-checksum record kept
  across an interrupted run ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)).
* **The county-contract kit** for a county that funds several programmes: a pilot kit, answers to a county's IT and
  privacy RFI, and a data contribution agreement draft for counsel ([docs/market/COUNTY-KIT.md](docs/market/COUNTY-KIT.md)).

**1.19.0**

* **Fingerprint sign-in, authorization and signing** with passkeys (WebAuthn): sign in, finish two-step
  verification, and confirm note signatures, countersignatures and time and spending approvals with the device's own
  fingerprint reader, face unlock or screen lock. No biometric data reaches SUDS (the device matches the finger); a
  passkey with user verification counts as two-step verification; each fingerprint-confirmed signature keeps signed
  evidence an auditor re-verifies offline. Office server only, not SUDS on this device; needs HTTPS and
  `WEBAUTHN_RP_ID` set before anyone enrols; each use can be switched off in Settings → Security policy
  ([docs/FINGERPRINT.md](docs/FINGERPRINT.md)).

**1.18.0**

* **County view**: a programme sends its county a signed, aggregate quarterly file of its settlement outcomes (no
  client-level data), and a county running SUDS, even a county-only install with no client records, sees its
  programmes side by side. Internal and exact, not for publication; office server only
  ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md)).
* **County connection** (optional, off by default on both sides): the programme's server posts the same signed file
  to the county's with a county-issued token and sees which periods the county still expects; the county's own
  reporting tools read the combined view with expiring read tokens
  ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#connecting)).
* **SUDS Server**: a one-command hardened install on an Ubuntu 24.04 or RHEL 9 VM, with a weekly compliance check
  whose signed report shows what it observed against the HIPAA Security Rule and 42 CFR §2.16, and lists what it
  cannot see. Evidence, not a certification; the installer has been run for real on Ubuntu 24.04 in a systemd
  container (1.20.0 fixes what that run found), but not yet on a real VM or on RHEL 9 by the project, so try it on a
  staging VM first
  ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)).

1.17.0 and 1.17.1 added the AI documentation copilot (Anthropic, and from 1.17.1 Amazon Bedrock or Google Vertex AI;
off by default), the street outreach screen, settlement outcomes, the Part 2 layer beside an EHR and least
privilege by default for new installs. Everything, release by release: [CHANGELOG.md](CHANGELOG.md).

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

* **Platform:** the web application — served by an office SUDS server (the system of record for its programme), or published as SUDS on this device. It also imports field notes from **Pocket AI** and **Microsoft OneNote**. The native phone apps and the desktop launchers were removed in 1.9.3 (their source remains in git history) — see [docs/PLATFORM.md](docs/PLATFORM.md).
* **Runtime:** Node.js ≥ 22.13 only (built-in SQLite, crypto, HTTP). No npm packages to install or audit on the office server. (The browser's local-mode kernel is a separate, committed bundle that does vendor a few pinned libraries in place of Node's built-ins — see [docs/WEB_APP.md](docs/WEB_APP.md#what-the-browser-kernel-is-built-from).)
* **Data protection:** AES-256-GCM field-level encryption of client identifiers and free text (coded reporting fields rely on disk encryption — [docs/HIPAA.md](docs/HIPAA.md), *Data classification*), blind-index search, scrypt password hashing, TOTP MFA or a passkey (fingerprint, 1.19.0), role-based access (caseload scoping by per-user deny), 42 CFR Part 2 consent and disclosure accounting, and a hash-chained audit log.
* **AI documentation copilot (1.17.0, optional):** drafts for a person to review and sign (notes, six-dimension assessments, care plan and CalOMS suggestions). Office server only, never on SUDS on this device or an offline copy; off until an administrator records the programme's BAA with Part 2 QSOA terms and counsel's review, then switches it on; identifiers SUDS holds are replaced before sending (not de-identification); never for SUD counseling notes or a client with an agreed restriction; a monthly cap, each call audited without its text ([docs/AI-COPILOT.md](docs/AI-COPILOT.md)).
* **Settlement outcomes (1.17.0):** per opioid-settlement fund, spending by Exhibit E category beside the outcomes recorded for it, with cost per outcome; counts of people suppressed by default, never a publication release.
* **County view (released in 1.18.0):** a programme sends the county a signed quarterly file of its settlement outcomes' exact aggregates for the funds that county pays for (no client-level data), and a county running SUDS imports its programmes' files and sees them side by side, summed and by quarter. Internal and exact (from 1.21.0 published only as a screened release, County view › Publish), people counted as each programme's own count, summed; office server only ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md)).
* **County connection (released in 1.18.0, optional):** off by default on both sides. The programme's server posts the same signed aggregate file to its county's SUDS server over HTTPS with a county-issued connection token (the file must still verify under the programme's registered key) and sees which periods are outstanding; the county's own systems read the combined view with read tokens that expire. Behind a proxy the county sets `TRUST_PROXY=1`; office servers only ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#connecting)).
* **SUDS Server (released in 1.18.0):** `deploy/linux/install.sh` for Ubuntu 24.04 or RHEL 9 (LUKS data disk, pinned Node and Caddy, a sandboxed service, keys as root-only credentials, firewall), upgrades that need the release zip's SHA-256 from a second channel, and a weekly compliance report signed with the check's own key (`npm run verify-compliance-report`). It shows what it observed; it does not make a programme compliant. Run for real on Ubuntu 24.04 in a systemd container ([docs/evidence/installer-container-run-2026-09-30/](docs/evidence/installer-container-run-2026-09-30/README.md); the installer fixes it led to are in 1.20.0) and in a fake root in CI; not yet on a real VM or on RHEL 9 by the project ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)).
* **County-entered figures (released in 1.20.0):** a county enters or imports the figures of a grantee not on SUDS, marked as entered by the county, never signed, always outranked by a signed file, and possible to leave out; office server only ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#county-entered-figures)).
* **Fingerprint sign-in and signing (released in 1.19.0):** passkeys on the device's own authenticator for sign-in, two-step verification and confirming signatures and approvals; no biometric data held; signed evidence verifiable offline (`npm run verify-passkey-evidence`). Office server only, HTTPS and `WEBAUTHN_RP_ID` required ([docs/FINGERPRINT.md](docs/FINGERPRINT.md)).
* **County publication releases (released in 1.21.0):** a screened, publishable release of the county's combined figures for a period, audited against every programme's own release, recorded and never changed; office server only ([docs/COUNTY-VIEW.md](docs/COUNTY-VIEW.md#publication)).
* **Field devices and participant codes first (released in 1.21.0, optional):** a device that holds only its worker's own recent caseload without contact, intake, legal or clinical details, enforced at the office; outreach records that start from a participant code; both off until an administrator turns them on ([docs/PLATFORM.md](docs/PLATFORM.md#field-devices)).
* **Authenticator allow-list (released in 1.21.0, optional):** passkeys only on the authenticator models the programme lists, proven by attestation against a FIDO Metadata Service file; off by default; office server only ([docs/FINGERPRINT.md](docs/FINGERPRINT.md#authenticator-allow-list)).
* **Street outreach (1.17.0):** a one-handed phone screen for anonymous contacts that draws supplies from stock, works offline where offline copies are allowed, and counts the worker's shift.
* **SSP participant code (1.17.0, optional):** an anonymous contact can carry the participant's self-built code, stored encrypted and counted by blind index, so the syringe services summary counts anonymous participants; no file prints a code ([docs/SUPPLIES.md](docs/SUPPLIES.md)).
* **Secure referral links (1.17.0):** a one-time link, with a separate access code, to an organisation not on SUDS, carrying a minimal referral only under a Part 2 consent naming it. Office server only, **off by default**; counsel reviews the design before a programme switches it on ([docs/security/REFERRAL-LINKS.md](docs/security/REFERRAL-LINKS.md)).
* **FHIR EHR import (1.17.0):** patients and encounters from a FHIR R4 Bundle or Bulk Data NDJSON file the EHR exports, through the spreadsheet import's preview and duplicate check. SUDS never connects to the EHR ([docs/integration/EHR-PART2-LAYER.md](docs/integration/EHR-PART2-LAYER.md)).
* **CalOMS scheduling (1.17.0):** SUDS can check last month on a set day and prepare the submission file, with a worklist of errors by owner and a submission log. A prepared file is disclosed only when someone produces it; SUDS does not submit to DHCS, and the layout is not yet verified against the DHCS data dictionary ([docs/compliance/CALOMS.md](docs/compliance/CALOMS.md)).
* **Documentation:** [Platform policy](docs/PLATFORM.md) · [Adopting SUDS (for a county CIO)](docs/ADOPTION.md) · [Deployment](docs/DEPLOYMENT.md) · [SUDS Server: self-hosting and the compliance boundary](docs/SELF-HOSTING.md) · [SUDS on this device (GitHub Pages)](docs/WEB_APP.md) · [API reference](docs/API.md) · [HIPAA & security controls](docs/HIPAA.md) · [Importing notes (Pocket AI / OneNote)](docs/IMPORTS.md) · [User guide](docs/USER_GUIDE.md) · [Market & procurement pack](docs/market/README.md) · [Security evidence package for county IT](docs/security/README.md)

## Get SUDS

| | |
| --- | --- |
| **Download** | https://github.com/taugustincst/suds/releases/latest — `suds-v<version>.zip` (the server, which serves the web app) |
| **Git** | `git clone https://github.com/taugustincst/suds.git` (upgrade later with `git pull`) |
| **All releases** | https://github.com/taugustincst/suds/releases |
| **Docker** | `docker compose up -d` |
| **SUDS Server (Linux VM)** | `sudo deploy/linux/install.sh --domain=… --admin-cidr=… --offsite=… --anchors=…`: hardened install on Ubuntu 24.04 or RHEL 9, with a weekly signed compliance check ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)) |

Current release: see [CHANGELOG.md](CHANGELOG.md). Release process: [docs/RELEASE.md](docs/RELEASE.md).

## Install

1. Install Node.js 22 LTS from https://nodejs.org.
2. Unzip SUDS somewhere permanent and start the server: `npm start` for a first look, or as a service (systemd / NSSM) or with Docker for anything staff depend on.
3. Open the address the server prints in a browser: the **setup wizard** asks you to name the program, create your administrator account, choose whether phones, tablets and other computers on the office network may connect, and whether staff may keep an offline copy on their devices (recommended: No). SUDS generates its encryption keys and an HTTPS certificate for you and shows a QR code for the office address.

Full walkthrough: [docs/INSTALL.md](docs/INSTALL.md); service and reverse-proxy settings: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). A county or CBO with a Linux VM installs **SUDS Server** instead — one command, hardened, and checked weekly against the policy by `npm run compliance-check`: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md), including what that does and does not make compliant. Everything the wizard sets can later be changed under **Administration → Network & devices / Settings / System & backups**.

**Phones, tablets and other computers:** nothing to install or configure. SUDS announces itself on the office network as **https://suds.local** (built-in mDNS responder) and uses the standard HTTPS port when available. Staff open that address in the browser, add it to the home screen (the `/app` page on the server walks them through it), and their workspace — clients, reminders, note drafts saved while typing, preferences — is the same everywhere because every device talks to the same server.

**Working offline (local mode):** the server can also hand out a copy of SUDS that runs inside the browser (`/?local=1`) and syncs with the office on command. It is **off by default**: it is turned on by answering *Yes* in the setup wizard or with `LOCAL_MODE_ENABLED=true`, and counties are advised to do so only for a documented field-work need. It is governed by the rules in [docs/PLATFORM.md](docs/PLATFORM.md) — the office server is authoritative.

**No server at all — SUDS on this device:** the same web app is published on GitHub Pages and runs entirely in the browser, keeping each person's records encrypted on their own device, with device backups and a backup reminder. It is republished only when a release is cut, so it always serves a released version. Details, including exactly where the records live and what that means: [docs/WEB_APP.md](docs/WEB_APP.md).

## Quick start (development)

```bash
git clone <repo> suds && cd suds
npm run seed          # dev database with demo staff logins and the fictional sample data set (server/demo.js)
npm start             # http://127.0.0.1:8080
```

Demo logins (password `Navigator2026!!`): `mrivera` / `dchen` (navigators), `kpatel` (clinician), `jwalker` (supervisor), `afinance` (finance). The first administrator is `guest` (or `SUDS_ADMIN_USERNAME`); its password is printed once when the database is created, unless `SUDS_ADMIN_PASSWORD` sets it.

Without a terminal, an administrator can add the same fictional data set from inside the app (**Load sample data** on the empty home screen or under Settings) and remove it again in one click; a local-mode copy offers it on its Sync screen.

Without seeding, the first start creates the administrator `guest` (or `SUDS_ADMIN_USERNAME`) and prints a temporary password; the setup wizard then replaces it with the account you choose.

## Production for IT teams

The wizard route above is production mode (`SUDS_ENV=production`) with keys in `data/keys.json` and a self-signed certificate — right for an evaluation or a single workstation, not for a system other staff depend on. A county deployment runs SUDS as a service (systemd or NSSM) behind the county's own certificate or reverse proxy, with environment variables, or in Docker (`docker compose up -d`, includes a Caddy TLS proxy configured by `Caddyfile`): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), including its key rotation runbook. Environment variables always override the wizard's settings. Release downloads ship with `.sha256` checksum files.

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

The browser regression suite (`scripts/ui/run-all.sh`) seeds a throwaway server and drives Chromium through the desktop screens, the navigator workflow, browser local mode, two-way sync, spreadsheet import/export and sample data. CI runs it on every push; locally it needs `npm i --no-save playwright && npx playwright install chromium`. CI's required jobs — the ones the release gate checks before anything is published ([docs/RELEASE.md](docs/RELEASE.md#release-gate)) — are `test`, `thorough`, `thorough-sdc` (the full-size disclosure sweeps, `npm run test:thorough`), `browser`, `node24` (`npm test` on Node 24) and `dr-drill`. Two jobs are advisory: a WebKit smoke subset (`SUDS_BROWSER=webkit SCRIPTS="static-site qa-retest" scripts/ui/run-all.sh`, after `npx playwright install --with-deps webkit`), and `release-state`, which compares what the release documents say with origin's tags, `main` and GitHub Pages (`node scripts/release-state.js`; [docs/RELEASE.md](docs/RELEASE.md), stamp checklist). No CI job replaces the real-device checklist in [docs/ADOPTION.md](docs/ADOPTION.md).

## License

MIT: see [LICENSE](LICENSE). Report security vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. This software supports but does not by itself provide HIPAA compliance; see [docs/HIPAA.md](docs/HIPAA.md) for the shared-responsibility model.
