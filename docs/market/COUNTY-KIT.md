# County pilot kit: the county view across the CBOs a county funds

The package for a county that wants to see, in one place, what the harm-reduction and outreach CBOs it funds spent
from their opioid settlement money and what they did with it, **without any client of any CBO reaching the
county**. It is the county-facing part of the county pilot in [PILOT-KIT.md](PILOT-KIT.md), section 8: each CBO
still runs its own 90-day pilot (PILOT-KIT sections 1–7); this kit covers what the county runs, what each CBO does
for the county, the timeline, the measures and the documents a county will ask for.

The product it describes is the **county view**, released in 1.18.0 ([../COUNTY-VIEW.md](../COUNTY-VIEW.md);
Tier 1 of [DATA-NETWORK.md](DATA-NETWORK.md)). Everything below is what the software does today (county-entered figures from 1.20.0), except where a
line says **[owner to complete]**.

## Who this is for

| Reader | What they take from it |
| --- | --- |
| County SUD / behavioural-health programme manager (the sponsor) | What the county gets, the timeline, the success measures, the decisions it owns |
| County IT and security | What the county runs (one small server with no client data on it), the installer, what crosses the network |
| County privacy officer and counsel | The data flows (aggregate only), what never leaves a CBO, the draft data contribution agreement, what counsel must review |
| Each CBO's director and finance lead | The key exchange at kickoff, the quarterly file, the optional connection |
| Purchasing | The documents a county asks for, and which are still owner-pending |

## What the county gets

- **The combined view** for any period it chooses (a quarter, a fiscal year, a calendar year): each CBO's
  settlement spending by Exhibit E allowable use and by California High Impact Abatement Activity, and the thirteen
  outcomes of SUDS's Settlement outcomes page (contacts, naloxone kits, test strips, syringes, reversals reported,
  people served, referrals, people linked to care and to MOUD, admissions, education sessions, people trained,
  staff training hours), one column per CBO and the total, with a headline saying how many CBOs submitted for the
  whole period, part of it or not at all ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *What the county sees*).
- **By quarter**: the same figures quarter by quarter, each quarter combined on its own.
- **Excel, CSV and a long "tidy" CSV** for the county's own analysts, labelled *Internal — exact counts*.
- **Signed figures.** Each CBO's figures arrive as a file its own SUDS signed with a key the county registered
  after the fingerprint was read out; a file changed after it was made, made for another county or signed by an
  unregistered key is refused, with the reason, and the refusal is audited.
- **Optionally, a connection** (off by default on both sides): each CBO's server posts the same signed file to the
  county's server and sees which periods the county still expects, and the county's own systems read the combined
  view with a read token ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *Connecting*).
- **Grantees not on SUDS** (*released in 1.20.0*): a grantee that does not run SUDS can be
  registered as "not on SUDS", and the county's own staff enter its figures for a period, or import them as a CSV
  in the same tidy layout SUDS exports. They are counted by default, marked everywhere as **"entered by the county
  — not signed by the program"**, counted separately in the headline, and can be left out of any view with one
  switch. A file a grantee signs always counts over figures the county entered, and once a grantee runs SUDS the
  county enters no more of its figures ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *County-entered figures*).

What it does **not** get, and must not be promised: a published or public dashboard (the publication screen over
the combined release is planned, not built); benchmarks or rankings across CBOs (Tier 2, not built); people counted
once across CBOs (never: a person served by two CBOs counts twice, and the view says so); a check that the
figures match the county's own reporting template or DHCS's current form (not yet done: STRATEGY §2,
*Dependency*).

## What the county runs

**One county SUDS server, used only for the county view** ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *A
county-only install*). It holds no client data and no PHI: the CBOs' public keys, the signed files (aggregate
counts and money, encrypted at rest), the county code and the audit log.

| | |
| --- | --- |
| **Install** | SUDS Server on an Ubuntu 24.04 LTS or RHEL/Rocky/Alma 9 VM with the installer ([../SELF-HOSTING.md](../SELF-HOSTING.md); [../../deploy/linux/README.md](../../deploy/linux/README.md)): pinned Node.js and Caddy, TLS 1.2+, keys as systemd credentials, a LUKS data volume, backups every 4 hours to an offsite share, a monthly recovery drill and a weekly signed compliance report. A container ([../DEPLOYMENT.md](../DEPLOYMENT.md)) is the alternative |
| **Sizing** | The smallest row of [../SELF-HOSTING.md](../SELF-HOSTING.md), *Sizing*: 2 vCPU, 4 GB RAM, a 20 GB encrypted data disk. A county file is a few kilobytes; ten CBOs sending one a quarter for ten years is well under 100 MB with backups |
| **Accounts** | An administrator (`county:manage`: registers CBOs, imports and withdraws files; *and enters figures for grantees not on SUDS, 1.20.0, not yet released*) and finance or supervisor accounts for the analysts who read the view (`county:view`, with `export:read` for the files). Two-step verification for every role; SSO through the county's identity provider if wanted ([../security/IDENTITY.md](../security/IDENTITY.md)) |
| **Modules** | None of the client modules. No sample data on it (`npm run seed` is a programme's data), local mode off |
| **Network** | Staff reach it over HTTPS. Without the connection, nothing else needs to reach it: the files arrive by the county's usual file transfer. With the connection, the CBOs' servers must reach `/api/county-connect/v1/` only, through the county's TLS proxy (with `TRUST_PROXY=1`) or a VPN ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *Exposure*) |
| **Security review** | Short, because no client record is ever on it: the review questions and their evidence are in [../evidence/README.md](../evidence/README.md); the RFI answers in [templates/COUNTY-RFI-ANSWERS.md](templates/COUNTY-RFI-ANSWERS.md) |

The CBOs' own servers are separate: each CBO runs its own office server (self-hosted by its IT partner, or hosted
by the county on county infrastructure, one server per CBO: [HOSTING.md](HOSTING.md)). Vendor hosting is not
offered.

## What each CBO does

| When | What | Where in SUDS |
| --- | --- | --- |
| **Kickoff (once)** | **Key exchange.** The county reads its **county code** from County view › Programs; the CBO types it on Settlement outcomes › Send to the county. The CBO presses **Show the key for the county**, emails the public key, and **reads the fingerprint out** (by phone or in the meeting) while the county registers the CBO and types the fingerprint (or ticks that it compared it). The CBO ticks the settlement funds the county pays for; nothing is ticked until it chooses, and a city's or the state's fund stays out | [../COUNTY-VIEW.md](../COUNTY-VIEW.md), *The trust model*; PILOT-KIT §8, *Key exchange at kickoff* |
| **Each quarter** | After the quarter ends, the CBO's finance lead makes the **county file** (Make the county file: the last complete quarter is the default) and sends it the way the county asks (email is fine: the file is aggregate and signed; the county's file drop if it has one). The county imports it. *Built for 1.21.0, not yet released:* SUDS reminds the finance lead on Home when the file is due, and the file carries each fund's award, so the county upgrades to 1.21 first (a county on 1.20 reads only the older file, which the card can still make) | Settlement outcomes › Send to the county; County view › Submissions |
| **Optional: the connection** | Where the county switches the connection on and issues the CBO a connection token, the CBO's administrator saves the county's address and token; the CBO then sends the same file with **Send to the county now**, or lets automatic sending post what the county's status says is outstanding (off by default). A person still chooses the funds first | [../COUNTY-VIEW.md](../COUNTY-VIEW.md), *The programme's side* |
| **A correction** | The CBO makes the file again for the same quarter and sends it; the one made later counts, the earlier one is kept as replaced | [../COUNTY-VIEW.md](../COUNTY-VIEW.md), *Which file counts for a period* |
| **A lost or exposed key** | The CBO makes a new key and reads the new fingerprint out; the county replaces the key, and marks the old one compromised if its files should stop counting | [../COUNTY-VIEW.md](../COUNTY-VIEW.md), *Key history* |

A grantee **not on SUDS** does nothing in SUDS: it sends the county its figures the way it does today, and the
county enters them (*released in 1.20.0*).

## Data flows

**Only aggregate figures cross between a CBO and the county.** The file is built from the CBO's own Settlement
outcomes page (the same code, never a second count), checked against an allow-list of aggregate fields when it is
made and again when the county imports it ([../COUNTY-VIEW.md](../COUNTY-VIEW.md), *What the file holds*).

| Direction | What crosses | How |
| --- | --- | --- |
| CBO → county, once | The CBO's **public** signing key and its fingerprint (read out) | Email and phone, at kickoff |
| County → CBO, once | The county code (not a secret); with the connection, a connection token, shown once | In person, or the county's usual channel |
| CBO → county, each quarter | The signed county file: the programme's name, the county's code and name, the period, when it was made, and for the funds ticked only: each fund's name, grant number, Exhibit E category and HIAA, its spending and its outcomes, and (*built for 1.21.0, not yet released*) its award amount and period; the same by allowable use and in total. Exact counts, for the county under the funding contract, not for publication | Email or file drop; or, optionally, an HTTPS POST of the same file |
| County → CBO (connection only) | The county's receipt for a file, and its status for that CBO: the periods it expects and whether this CBO's files cover them. Never a figure back, never another CBO's anything | HTTPS answer to the CBO's own request |
| County's own systems ← county server (optional) | The combined view, with notes saying the figures are summed, not unduplicated, and exact, internal, not for publication | Read token, `GET /api/county-connect/v1/combined` |
| County staff → county server (*1.20.0, not yet released*) | A grantee-not-on-SUDS's figures, typed or imported as a CSV, with a reference to the source document | County view, `county:manage` |

**What never leaves a CBO:** any client record; any name, client code, participant code, date of birth or date of
service; any note, referral or consent; any single event; the figures of a fund the CBO did not tick; the CBO's
private signing key (it is encrypted with the CBO's database key and never exported). The county's server never
asks a CBO's server for anything but its own receipt and status: there is no route by which the county reads a
CBO's records.

**What the county must not do with the figures** (for the data contribution agreement): publish them (nothing on
the county view is for publication until the publication screen over the combined release exists), try to
re-identify anyone, or share them beyond the staff the agreement names. Small numbers are exact by design.

## A 3-CBO pilot timeline

Staggered so the vendor is not deploying three CBOs at once (PILOT-KIT §8). Weeks from the county's kickoff.

| Week | County | CBO A | CBO B | CBO C |
| --- | --- | --- | --- | --- |
| 0–2 | Discovery: which CBOs, which settlement funds, the county's reporting template, the success measures below; the documents list below started | | | |
| 2–3 | County server installed (SUDS Server), accounts and two-step verification, backups and the first recovery drill; county code read | Eligibility check, baseline (PILOT-KIT §2, §5) | | |
| 3–4 | Data contribution agreement drafts sent to each CBO for counsel ([templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md)) | Install and configure; **key exchange at kickoff**; funds ticked | Eligibility, baseline | |
| 5–7 | Import A's first file for the last complete quarter (from its imported history, if any) and check it against what A sent under the contract before | Go-live (PILOT-KIT §4, week 0) | Install; **key exchange** | Eligibility, baseline |
| 8–10 | Combined view with A and B | Day 30 check-in | Go-live | Install; **key exchange** |
| 13 | **First pilot quarter ends.** Files for it made and imported for every CBO; the headline says 3 of 3 for the whole period, or who did not | Quarter's file sent | Quarter's file sent | Go-live, file for its part of the quarter |
| 14–16 | County measures taken (below); the connection tried with one CBO if the county wants it | Day 60 | Day 30 | Day 14 |
| 18–22 | County decision at the end of the last CBO's 90 days (PILOT-KIT §8, *Decision at the end*) | Day 90: evaluation | Day 60 | Day 30 |

A grantee not on SUDS can join the combined view from week 5 with county-entered figures (*released in 1.20.0*), so the county sees its whole portfolio while only some of it runs SUDS.

## Success measures

Agree the targets before starting; record the baseline with the current process first (PILOT-KIT §5, *Rules*).

| Measure | How | Target (agree before starting) |
| --- | --- | --- |
| County staff hours to combine its grantees' figures for a quarter | Timed by the county analyst, current process (baseline) vs the combined view and its Excel | Recorded; a target only once a baseline exists. No time saving is claimed until measured |
| Quarterly files received and imported on time | County view › Submissions: a *Current* file per CBO per quarter; the headline for the quarter | Every pilot CBO, every pilot quarter, within the time the contract sets |
| Files refused, and why | The audit log's `county.submission.refuse` entries with their reasons | Each refusal resolved within the quarter; none for a signature or county-code mismatch after the first quarter |
| Figures that match what the CBO submitted under its contract | The county compares the combined view with the CBO's usual submission for the first pilot quarter | Every difference explained |
| Settlement spending recorded with an allowable use | The combined view's *No settlement category recorded* row | Zero by the second quarter |
| CBO finance time to make the county file | Timed by each CBO's finance lead | Recorded |
| Integrity incidents (a file accepted that should not have been, figures seen by someone not authorised) | Incident register; audit review | Zero |

## Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| **County sponsor** | County SUD / behavioural-health programme manager | Chooses the CBOs, owns the measures, signs the decision |
| **County view administrator** | A named county staff member (`county:manage`) | Registers each CBO at the key exchange (reads the fingerprint back), imports files, withdraws and reinstates, issues connection tokens if used; *enters figures for grantees not on SUDS (1.20.0, not yet released)* |
| **County analysts** | Finance or supervisor accounts (`county:view`, `export:read`) | Read the combined view; take the Excel and tidy CSV |
| **County IT** | County IT operations | The county server: install, TLS, backups, drill, patches, the proxy if the connection is used |
| **County privacy officer and counsel** | County | The data contribution agreement; what counsel must review (below) |
| **Each CBO's finance lead** | CBO | Ticks the funds, makes and sends the quarterly file, reads the fingerprint out |
| **Each CBO's administrator** | CBO or its IT partner | The CBO's own server; the connection's address and token if used |
| **Vendor FDE lead** | Vendor | Discovery, the county server's setup with county IT, each key exchange, the first imports, training; keeps the time log |

## The documents a county will ask for

| Document | Where | Status |
| --- | --- | --- |
| How the county view works, and its trust model | [../COUNTY-VIEW.md](../COUNTY-VIEW.md) | Written |
| Answers to the county's IT and privacy RFI | [templates/COUNTY-RFI-ANSWERS.md](templates/COUNTY-RFI-ANSWERS.md) | Written; organisational answers are [owner to complete] |
| Data contribution agreement (CBO ↔ county) | [templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md) | **Draft for counsel**; not reviewed |
| Security questionnaire | [../security/QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) | Written |
| Evidence index (each review question → document, test, CI job, artefact) | [../evidence/README.md](../evidence/README.md) | Written |
| SBOM and recovery-drill evidence | [../evidence/](../evidence/README.md) | Development drills, not production drills |
| Data inventory and lifecycle | [../security/DATA-INVENTORY.md](../security/DATA-INVENTORY.md), [../security/DATA-LIFECYCLE.md](../security/DATA-LIFECYCLE.md) | Written |
| Penetration test scope | [../security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) | A scope for a county-commissioned test; **no test done** |
| Accessibility conformance report | [../accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md) | Self-assessment, not a third-party review |
| BAA / Part 2 QSOA and DPA | [templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md), [templates/DPA-DRAFT.md](templates/DPA-DRAFT.md) | Drafts; not reviewed by counsel. Needed where the vendor can reach a CBO's PHI; the county server holds none |
| Support terms | [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md), [../SUPPORT.md](../SUPPORT.md) | Template |
| Pilot plan per CBO | [PILOT-KIT.md](PILOT-KIT.md) | Written |
| Pricing | [PRICING-OPTIONS.md](PRICING-OPTIONS.md) (model C, county site licence; model D, services) | Nothing decided |

## The evidence packet

Send the documents above as one packet rather than as links (built for 1.21.0, not yet released). From a clone of the repository, at the
commit (or tag) of the release the county will run:

```bash
node scripts/county-packet.js --ref <commit or tag> --out suds-county-packet --zip suds-county-packet.zip
```

It holds this kit, the security questionnaire, the RFI answers, the data contribution agreement, DPA and BAA/QSOA
drafts, the newest SBOM, the newest recovery, upgrade and installer drill evidence, SECURITY.md, the LICENSE, the
accessibility conformance report and the penetration-test scope, each at its own path, with a `README.md` saying what
each file is and which version it describes, and a `MANIFEST.sha256` of every file. The README gives the checks a
county can run itself: `sha256sum -c MANIFEST.sha256`, the same command at the same commit (it makes the same bytes,
zip included), `node scripts/sbom.js --ref <commit>` for the SBOM, `npm run verify-dr-report` and
`npm run verify-compliance-report` for the signed reports, and `npm run verify-audit-export` for an audit export from
the county's own server. The files are read from git at that commit, never from a working tree. The packet carries the
documents' limits with it (drafts not reviewed by counsel, no certification or penetration test, development-environment
drills, a self-assessed accessibility report): say them when you send it. Tested in `test/county-packet.test.js`.

## Owner-pending items

Software cannot close these. A county will ask about each; say plainly that it is open.

- **[owner to complete]: legal entity**, W-9 / Payee Data Record and county vendor registration.
- **[owner to complete]: insurance** (general liability, tech E&O, cyber liability).
- **[owner to complete]: penetration test.** None has been done; the scope is written for a county-commissioned
  test ([../security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md)).
- **[owner to complete]: pricing.** Nothing is decided ([PRICING-OPTIONS.md](PRICING-OPTIONS.md)); do not quote a
  number from this kit.
- **[owner to complete]: counsel review** of the BAA/QSOA and DPA drafts, and of the questions in
  [DATA-NETWORK.md](DATA-NETWORK.md), *What counsel must review* (items 1, 4 and 5 bear on the county view).
- **[owner to complete]: data contribution agreement.** The draft in
  [templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md) needs the
  county's and each CBO's counsel before any CBO signs it.
- **The county's template.** The file carries SUDS's settlement categories and outcomes; the county's reporting
  template and DHCS's current form have not been checked against it.
