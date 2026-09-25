# SUDS positioning

> **The system for the work SmartCare doesn't do well — without pretending to be another EHR.**

## Category

**Program-operations software for grant-funded SUD work.** SUDS runs the day-to-day of prevention,
harm-reduction, outreach, navigation and supply-distribution programmes: who is on each worker's caseload,
what was done for them, what was handed out, where they were referred and whether they got there, what it
cost against which grant, and who approved it. It is a complement to a county's electronic health record
(EHR), not a substitute for it.

## Who it is for

| | |
| --- | --- |
| **Market boundary** | California grant-funded, **non-billing** prevention, harm-reduction, outreach, navigation and supply-distribution programmes. |
| **Programmes** | County SUD / behavioral health programme teams and the community-based organisations (CBOs) they fund: navigators, peer workers, outreach teams, naloxone and test-strip distribution, post-overdose follow-up, SOR / opioid-settlement / SAMHSA / county-funded projects. |
| **Buyer 1: the programme team** | Programme manager or SUD administrator. They buy for **caseload, supplies, resources, grants and approvals** — and for funder reports that do not take a week of spreadsheet work. |
| **Buyer 2: county IT** | CIO, IT security, privacy officer. They are the **gate**: security assurance, identity, audit, recovery, accessibility and integration. They rarely champion SUDS but can stop it. |
| **Best first customers** | Non-billing CBOs and small programmes running on spreadsheets, shared drives and paper sign-out sheets. Then small and rural county programmes. |

## The boundary: what SUDS is not

Saying this plainly is part of the product. SUDS is:

- **Not an EHR.** It keeps structured service and clinical documentation for navigation and programme work,
  but it is not the county's legal medical record for treatment services, and it is not certified EHR technology.
- **Not a billing system.** SUDS does **not** create, submit or reconcile Drug Medi-Cal (DMC / DMC-ODS)
  claims, 837 files or any other claim. Billable treatment services stay in the county EHR. SUDS hands off
  the encounter data the EHR needs (see below) — it does not bill.
- **Not a prescribing or medication system.** No eMAR, no e-prescribing (eRx), no medication administration,
  no lab orders or results.
- **Not a replacement for SmartCare, Netsmart myAvatar/CareFabric or any other county EHR.** Do not propose
  it as one.
- **Not a multi-tenant, high-availability platform.** Each programme runs its own single-server instance
  (see *Objections*).

## The complement story

A county EHR (SmartCare, Netsmart and similar) is built around billable clinical encounters. It handles the
work around grants poorly or not at all: anonymous outreach contacts, naloxone kits handed to someone who gives
no name, a supply cupboard, a verified community resource directory, warm-handoff referral loops, staff time
by funding source, grant budgets and expenditure approvals, and unduplicated funder reports. That work lives in
spreadsheets today. SUDS is where it goes.

| The EHR does | SUDS does | How they connect |
| --- | --- | --- |
| Billable treatment encounters, DMC claims | Non-billable navigation, outreach, harm-reduction and prevention services | Encounter hand-off export for services that must be entered or billed in the EHR (`docs/SCOPE.md`) |
| Clinical record for treatment | Programme record: caseload, visits, calls/texts, referrals, supplies, time, budget | FHIR R4 read API and bulk export, with 42 CFR Part 2 consent enforced (`docs/integration/FHIR.md`) |
| CalOMS Tx for treatment admissions | CalOMS Tx capture, validation and extract where a programme is required to report it | CalOMS extract for the county's submission (`docs/compliance/CALOMS.md`); built, but the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county |
| County-wide identity | Programme accounts, or sign-in with the county identity provider | OIDC single sign-on (`docs/DEPLOYMENT.md`, *Single sign-on*) |

## Key messages

**For programme teams (value)**

1. *One place for the grant work.* Caseload, visits, supplies, referrals, resources, time and budget — not six spreadsheets.
2. *Funder reports in minutes.* Unduplicated people served by funding source and period, with demographics,
   overdose and naloxone figures, and small-cell suppression built in.
3. *Supplies you can count.* Naloxone kits and fentanyl test strips drawn down by each visit, including
   anonymous community distribution.
4. *Referrals that close the loop.* Every referral gets a follow-up; days-to-admit and barriers are reportable.
5. *Approvals that hold up to audit.* Expenditure and time approval with separation of duties; note
   countersignature; nobody approves their own.
6. *Built for the field.* Works in any browser on a phone, tablet or computer; plain-language help on every page.

**For county IT (the gate)**

1. *Small attack surface.* Node.js built-ins only — zero third-party runtime packages.
2. *PHI encrypted field by field* (AES-256-GCM) on top of disk encryption; blind-index search.
3. *Tamper-evident audit* of every PHI read and write, in a tamper-evident hash chain, append-only in the database, anchored every 6 hours; write-once when the county points `AUDIT_ANCHOR_DIR` at WORM storage.
4. *42 CFR Part 2 enforced in the software*, not only in policy: consent elements, referral gating, disclosure accounting.
5. *Your identity provider* via OIDC; MFA required for every role by default.
6. *Your infrastructure or ours.* County-hosted on a single server or container, or (planned) vendor-hosted
   per programme. Encrypted scheduled backups, restore drill, documented RTO/RPO.
7. *Evidence, not adjectives.* Security, Part 2, accessibility and integration documentation in the repository
   (see [README.md](README.md), *Readiness scorecard*).

## Objection handling

**"Why not just use SmartCare (or Netsmart)?"**
Keep using it for what it is built for: billable treatment and the clinical record. SUDS is for the
non-billing work around it — outreach, supplies, resources, referrals, grant budgets and funder reports — which
today lives in spreadsheets because the EHR does it poorly. Where a service must also appear in the EHR, SUDS
produces a hand-off export and a FHIR R4 feed rather than asking staff to double-enter. If a programme bills
DMC, the billing stays in the EHR.

**"A single server is a single point of failure."**
True, and stated openly (`docs/HIPAA.md`, *Risk register notes*). SUDS is deliberately one process and one
database per programme: it covers dozens of staff, not hundreds, and a second process is refused rather than
risk corruption. Availability comes from encrypted, scheduled, off-host backups, a tested restore (the DR drill
with measured RTO/RPO in `docs/security/`), and a health endpoint for monitoring — not from clustering. For a
non-billing programme, an outage of hours with no data loss is usually an acceptable, documented risk; confirm
that against the county's own continuity requirement.

**"What about 42 CFR Part 2?"**
Part 2 is built into the workflow: §2.31 consent elements are required, referrals that would identify a client
are refused without a valid consent or lawful basis, every disclosure is accounted for, and identified exports
are recorded per client (`docs/HIPAA.md`). Controls for the 2024 final rule — patient notice, complaints,
breach/incident register, court-order safeguards, separate consent for SUD counseling notes — are documented in
`docs/compliance/PART2.md`. County counsel should review the consent and notice wording before first use.

**"Do you have SOC 2 / HITRUST / a pen test?"**
Not yet, and we will not say otherwise. What exists today: the control documentation and SOC 2 readiness
self-assessment in `docs/security/`, a completed security questionnaire, and open source code the county can
review. A SOC 2 Type 1 audit, then Type 2, and an independent penetration test are on the vendor to-do list
([PROCUREMENT.md](PROCUREMENT.md)) with a timeline. Until then, sell to programmes whose IT will accept
readiness evidence, an independent review of the county's own deployment (`docs/ADOPTION.md`, section 6), or
county hosting.

**"Is it accessible?"**
A WCAG 2.1 AA audit and an Accessibility Conformance Report (VPAT format) are published at
`docs/accessibility/ACR-WCAG21.md`, with the accessibility statement and known issues at
`docs/accessibility/STATEMENT.md`. The report says where SUDS "supports", "partially supports" or does not
support each criterion; it is a self-assessment, not a third-party certification.

**"Who supports it? What if the vendor disappears?"**
The code is open source (MIT) and has zero runtime dependencies, so a county can always run, audit and
maintain it without the vendor — no lock-in, and the data exports are complete (Excel/CSV of every table,
FHIR bulk export). Paid support gives the county a named support desk, severity-based response times and
upgrades ([templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md)). Be honest about size: today the vendor is a
small team, which is why each contract includes an exit and data-return plan and the county's adoption plan
names a code owner (`docs/ADOPTION.md`).

**"It's open source — why pay?"**
The licence is free. The subscription pays for hosting (where the vendor hosts), implementation, data
migration from spreadsheets, training, support with response times, security updates, and the assurance work
(audits, pen tests, questionnaires) that a county cannot get from a repository.
