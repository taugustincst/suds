# SUDS positioning

> **Privacy controls built to support 42 CFR Part 2, for the outreach and harm-reduction work that happens beside
> an EHR — or without one: field-ready outreach (named or anonymous, on a phone, offline where the programme
> allows), naloxone and supply distribution, and outcome reporting to the people who fund it, opioid-settlement
> funders included.**

Three leads, in this order, each stated no further than the software goes:

1. **The Part 2 layer beside the EHR.** SUDS holds the outreach, navigation and referral records an EHR does not,
   under consent that names the recipient, one disclosure gate and an accounting of disclosures, and hands the EHR
   what it needs (a FHIR R4 feed with Part 2 consent enforcement, an encounter hand-off file). It is a Part 2 layer
   for the records SUDS holds; it does not manage consent for records kept in the EHR. No live EHR connection has
   been made yet; the first is to be tested in a pilot.
2. **Field-ready outreach.** One **+ Log** button on a phone, anonymous contacts that still count, supplies drawn
   from the van or site they left, and an offline copy that syncs with the office where the programme turns it on.
   The Street outreach screen and the SSP participant code are released in 1.17.0; a field device scope and
   minimal-personal-information defaults beyond that are planned, not built.
3. **Funder outcomes.** Funder report, NDP log, settlement expenditure report by allowable use and the layouts for
   DHCS and county settlement reporting, as exact submissions or screened publication releases. Each layout is to
   be checked against the funder's current template. A county view across the CBOs a county funds is released in 1.18.0:
   each CBO sends a signed file of its exact aggregates and a county running SUDS combines
   them, internal only, people counted as each CBO's own count, summed ([docs/COUNTY-VIEW.md](../COUNTY-VIEW.md)).
   A published county dashboard is planned, not built: it needs the publication screen over the combined release.

What comes next, and what is only planned, is in [STRATEGY.md](STRATEGY.md): the AI documentation copilot is
**released in 1.17.0** (office server only, off by default, gated on a BAA and QSOA, identifiers removed before
sending, drafts only, a person signs, never for SUD counseling notes). Show it only to a programme that runs an office server and can record the BAA and QSOA with the AI
provider; do not show it for SUDS on this device, and do not promise it for SUD counseling notes.

## Category

**Programme-operations software for harm-reduction, outreach and prevention work.** SUDS runs three jobs that
these programmes do every day and that no EHR does well:

1. **Outreach encounters** — contacts in the street, at an encampment, a syringe-services site or a
   post-overdose visit, with a named client or with nobody named at all; follow-ups and referrals that close.
2. **Naloxone and supply distribution** — supplies kept by item, site and lot (naloxone kits, fentanyl test
   strips and whatever other items the programme lists), drawn down by each encounter, including anonymous community distribution, with
   stock counts and reversals reported.
3. **Grant and funder reporting** — unduplicated people served by funding source and period, supply and
   naloxone figures, expenditures against budget lines with approvals, staff time by grant.

It does this with privacy controls built to support **42 CFR Part 2** (consent that names the recipient,
a disclosure gate and accounting, field-level encryption of identifiers and notes, an append-only audit log),
so a programme whose records *are* Part 2 records has software support for the controls the rule calls for (its own policies, training, agreements and counsel's review are the rest), and one whose records are not gets the same care. Whether a programme's own records and workflows meet Part 2 is for its counsel to confirm; the control matrix (docs/compliance/PART2.md) has not had an independent legal review.

**"Prevention", precisely.** SUDS serves harm-reduction, outreach and navigation work, including
prevention-funded outreach and naloxone / supply distribution. Since 1.17.0 it also records SABG
**primary-prevention events**: group and community events with their date, kind, CSAP strategy (the six), IOM
population category (universal direct, universal indirect, selective, indicated), audience, place, hours,
attendance (a headcount, marked when estimated) and fund, and totals them for a period in a *prevention activity
summary* (by strategy, by IOM category, by the two together, by kind of event, and the people trained — the
attendance of training events), as CSV or Excel. What it does **not** do: produce a **PPSDS** submission file (the
field mapping to DHCS's Primary Prevention SUD Data Service awaits the DHCS PPSDS data dictionary; say "prevention
activity summary", never "PPSDS export"), record an evidence-based programme's name or registry, break attendance
down by age, race or gender, or keep a list of who attended. A primary-prevention set-aside provider can keep its
event record in SUDS and key PPSDS from the summary; it cannot submit from SUDS ([README.md](README.md),
*Readiness scorecard*).

## Who it is for, in order

| Order | Buyer | Why them |
| --- | --- | --- |
| **1** | **Small and mid-sized harm-reduction and prevention CBOs** (roughly 3–40 staff) funded by **opioid-settlement** allocations, **SOR** / the **Naloxone Distribution Project**, or **SABG prevention** funds spent on outreach and distribution (not primary-prevention reporting) — running today on spreadsheets, shared drives and paper sign-out sheets | The pain (quarter-end reporting, supply counts, anonymous contacts) is theirs daily; the buyer is the programme director; the purchase is small enough for a programme budget |
| **2** | **Their IT partner** (a managed-IT provider, a fiscal sponsor's IT, or a staff member who runs servers) | Today SUDS is self-hosted, so every CBO customer needs one; they are the gate, not the champion |
| **3** | **Counties, as sponsors of CBO pilots** — a county SUD / behavioral-health or public-health department that funds CBOs and wants consistent, privacy-safe outcome data from them | The county holds the money (settlement allocations, SABG, county funds) and needs outcome evidence from its grantees: "sell to the money". A county can host its CBOs' instances or fund their implementation, and is the natural steward of any pooled outcome data ([DATA-NETWORK.md](DATA-NETWORK.md)). The first county sale is a sponsored pilot of 2–3 CBOs with paid implementation ([PILOT-KIT.md](PILOT-KIT.md)); selling SUDS *to* a county as a department system is a later, slower sale (procurement 6–24+ months) |

**Hosting, honestly.** SUDS is not a hosted service today. A CBO runs it through its **IT partner** (a VM, an
office server or a container), or a **sponsoring county hosts it**. A **vendor-hosted single-tenant tier** is
planned and will not be offered until the checklist in [HOSTING.md](HOSTING.md) is done. A CBO with neither an
IT partner nor a county sponsor is **not yet a fit** — say so rather than sell to it.

## Core, and optional modules

The pitch is the three jobs above. Everything else is there for programmes that need it:

| Core (every programme) | Optional modules (programmes that need them) |
| --- | --- |
| Outreach encounters, calls and texts, anonymous contacts, overdose and reversal events | Care plan, problem list, six-dimension assessment (ASAM-aligned; the ASAM Criteria are not included), PHQ-9 / GAD-7 / AUDIT-C, optional DAST-10 |
| Supplies by item, site and lot; naloxone / test-strip distribution | Clinical notes (SOAP/DAP/BIRP/GIRP) with signature and countersignature |
| Referrals with consent check, warm hand-off and loop closure; verified resource directory | CalOMS Tx capture and extract (**not verified against the DHCS data dictionary**; do not submit until verified) |
| Funding sources, budget lines, expenditures and approvals, staff time by grant | FHIR R4 read API and the county EHR encounter hand-off |
| Funder report; naloxone distribution log in the style of the DHCS Naloxone Distribution Project; opioid-settlement expenditure report by allowable-use category (**each to be checked against the funder's current template**) | County forms library |
| Consents, accounting of disclosures, audit, MFA, SSO | |

A **programme profile** setting chooses between **Harm reduction & outreach** (the default: the clinical
modules are hidden), **Treatment-adjacent** (they are shown) and, from 1.17.0, **Part 2 compliance module
(beside an EHR)** (below). Changing it hides or shows screens; it does not delete records.

## A second use: the disclosure-compliance module your EHR doesn't have

> **For a SUD treatment programme that already has an EHR: SUDS as the 42 CFR Part 2 layer beside it — consent,
> the accounting of disclosures, redisclosure notices and breach tracking — without replacing the EHR.**

EHRs a county SUD provider uses (eClinicalWorks, Epic, SmartCare and others) hold the clinical record and the
billing. Many programmes still keep on paper or in spreadsheets the Part 2 work around them: a §2.31
consent that names each recipient, checked *before* information leaves; an accounting of every disclosure a
patient can ask for; the §2.32 notice travelling with each one; SUD counseling notes kept apart; the breach
register with its 60-day clock; patient requests with their deadlines; and referrals to organisations that are
not on any shared system. SUDS already does all of that for its own records. The **Part 2 compliance module**
profile makes it the programme's Part 2 layer:

- **What the EHR keeps**: the clinical record, orders, medications, billing and claims. SUDS does not replace
  any of it and is not certified EHR technology.
- **What SUDS keeps**: consents (with every §2.31 element, recipient-named, revocable), the disclosure gate and
  the accounting of disclosures, the §2.32 notice on every disclosure, the §2.22 patient notice, counseling notes,
  the incident and breach register, complaints, patient requests (access, amendment, restriction, accounting),
  and secure referral links to providers that do not use SUDS (off by default; counsel reviews them first).
- **What SUDS gates and accounts**: only the disclosures made **through SUDS** (a referral, an export, the FHIR
  API, a referral link). A disclosure the EHR or a member of staff makes outside SUDS is neither checked nor
  accounted by SUDS, which cannot see or stop it; for the accounting a patient receives to be complete, staff
  record it by hand (the client's Consents tab → *+ Disclosure*, `POST /api/clients/:id/disclosures`, which runs
  the same gate).
- **How they connect**: patients and encounters come in from the EHR's own FHIR R4 export (or a spreadsheet);
  the EHR reads consents and their provenance from SUDS's FHIR R4 API, consent-gated and accounted.
  [docs/integration/EHR-PART2-LAYER.md](../integration/EHR-PART2-LAYER.md) is the integration guide.

Say plainly what this is and is not: **software support for Part 2 controls**, not a certification, an
attestation or legal advice. SUDS is not ONC-certified and has not been reviewed by counsel or an auditor as a
Part 2 compliance product; the control matrix ([docs/compliance/PART2.md](../compliance/PART2.md)) says what
each control does and what remains the programme's policy and counsel's judgement. No EHR vendor has certified
or endorsed the integration; the import reads standard FHIR R4 Patient and Encounter resources, and has been
tested against SUDS's own fixtures, not against a named vendor's export.

Who it is for: a treatment programme (or a county on behalf of its providers) that has an EHR, handles Part 2
records, and wants the consent-and-disclosure controls in software rather than in a binder. It is the same
product and the same install as the harm-reduction use; only the profile differs.

## The boundary: what SUDS is not

- **Not an EHR** and not certified EHR technology. It is not a treatment programme's legal medical record.
- **Not a billing system.** No Drug Medi-Cal (DMC / DMC-ODS) or other claims, no 837 files. Programmes that bill
  keep billing in their EHR; SUDS can hand encounters to it ([docs/SCOPE.md](../SCOPE.md)).
- **Not a prescribing or medication system.** No eMAR, e-prescribing, medication administration or labs.
- **Not a replacement for SmartCare, Netsmart or any county EHR.** Do not propose it as one.
- **Not an official state reporting system.** The funder, NDP, settlement and settlement-outcome reports are
  built from what the programme records in SUDS, laid out as SUDS understands the forms. None is a verified state
  template until someone has checked it against the current one ([docs/compliance/HARM-REDUCTION-REPORTING.md](../compliance/HARM-REDUCTION-REPORTING.md)),
  and SUDS submits nothing to the state or a county: people download the files and submit them.
- **Not a multi-tenant, high-availability platform.** One single-server instance per programme
  ([docs/architecture/ADR-0001](../architecture/ADR-0001-single-process-sqlite.md)).

## Where it sits next to an EHR

Where a CBO or county programme also has an EHR, SUDS holds the work around it: anonymous outreach, supplies
and stock, the resource directory, grant budgets and funder reports — or, for a treatment programme, the Part 2
consent-and-disclosure layer above. If some services must also be in the EHR, SUDS produces a consent-gated
hand-off file or FHIR feed instead of double entry; patients and encounters can come the other way from the
EHR's FHIR export. Most harm-reduction CBOs have no EHR at all; for them SUDS is the programme record.

## What a buyer will compare it with

Five categories come up. The examples are names a buyer is likely to mention, not a market survey. What each
product does changes often: describe a competitor only from its current public material or the buyer's own
experience of it, never from this page, and never quote a feature or a price from memory. No figure below is a
price; where one would go it says so.

| Category | Examples a buyer may name | What they are for | How SUDS differs | Price |
| --- | --- | --- | --- | --- |
| **AI documentation tools for behavioural health** | Eleos, Nabla, and similar ambient-listening or note-drafting products | Drafting clinical notes, some from a recorded session, inside or beside a clinician's EHR | SUDS is not an AI product. Its copilot (released in 1.17.0) is one optional module of a programme record: office server only, off until the programme records its own BAA and Part 2 QSOA with the provider, drafts from text the worker gives (session notes or a transcript; SUDS records no audio), never for SUD counseling notes, every call audited without its text, and a person signs. A programme that wants ambient scribing for therapists should compare those products on their own terms; SUDS does not compete there | `[owner to verify public pricing]` |
| **EHR vendors' AI add-ons** | The drafting and summarising features EHR vendors add to their own products | Documentation help inside the EHR the programme already bills from | Where the clinical note lives in the EHR, its own add-on is usually the natural choice for that note. SUDS's copilot is for the records SUDS holds (outreach, navigation, care-coordination notes, CalOMS answers) and is never offered on SUDS on this device | `[owner to verify public pricing]` |
| **County EHRs** | SmartCare (through CalMHSA), Netsmart (myAvatar), and the EHRs county SUD providers use | The clinical record, DMC-ODS billing and, often, CalOMS submission for the providers on them | Not a replacement, and never proposed as one (*The boundary*). SUDS holds the non-billing work beside them, or acts as the Part 2 consent-and-disclosure layer; it can import patients and encounters from a FHIR file the EHR exports and hand encounters back, and it never connects to the EHR or bills | `[owner to verify public pricing]` |
| **CBO case management platforms** | Apricot (Bonterra) and similar configurable case-management and outcomes tools | General case management, intake forms and outcomes reporting for many kinds of nonprofit programme | SUDS is narrower and built for this work: anonymous contacts that still count, supplies by item, site and lot, naloxone and SSP reporting, settlement spending by Exhibit E category, and Part 2 controls (consent that names the recipient, one disclosure gate, an accounting of disclosures) that a general platform leaves to configuration. It is open source, runs on the programme's or county's own server, and the programme pays, if it chooses, for services rather than licences | `[owner to verify public pricing]` |
| **Harm-reduction trackers** | Spreadsheets and paper logs, SSP data tools, and the forms a funder or clearinghouse supplies | Counting distribution and participants for one funder's report | SUDS keeps the same counts as part of one record: an anonymous contact on a phone, offline where allowed, with an encrypted participant code, draws down stock and reaches the funder report, NDP log, SSP summary and settlement report. Each layout is still to be checked against the funder's current template | `[owner to verify public pricing]` |

The honest line for every row: SUDS is one maintainer's open-source software with no independent audit yet, and
the incumbents in the first four rows are established companies. Where the buyer's need is inside one of those
categories, say so and point them there.

## Key messages

**For programme directors (value)**

1. *Outreach you can count.* Log a contact in the field — named or anonymous — on a phone, even offline where the
   programme allows it; it counts in the funder report. Street outreach (1.17.0) is one screen for it, one-handed:
   what kind of contact, what was handed out, roughly where.
2. *Supplies you can account for.* Every kit handed out comes off the stock of the site it left from; stock-outs and reversals are
   visible before the funder asks.
3. *Funder reports from the records you already keep.* Unduplicated people served by funding source and period,
   with small-cell suppression. **How much time this saves is not yet measured** — the pilot measures it
   against your current hours ([PILOT-KIT.md](PILOT-KIT.md), section 5).
4. *Money that holds up to audit.* Expenditures and staff time against grant lines, with approvals and
   separation of duties: nobody approves their own.
5. *Privacy participants can trust.* Consent that names who may receive information, an accounting of every
   disclosure, identifiers and notes encrypted field by field.
6. *Settlement money you can show the results of* (1.17.0). Each settlement fund's spending beside what the
   programme recorded of the work it paid for — kits and reversals, people served and linked to treatment, people
   trained — with small counts hidden as in the funder report. Say it plainly: SUDS reports what the programme
   records; it is not the state's outcome measure and not a state report.

**For the IT partner or county IT (the gate)**

1. *Small attack surface.* Node.js built-ins only — no third-party runtime packages on the server.
2. *Identifiers and free text encrypted field by field* (AES-256-GCM) on top of disk encryption; blind-index search.
   Coded reporting fields (status, substance, risk) rely on disk encryption ([docs/HIPAA.md](../HIPAA.md)).
3. *Tamper-evident audit* of PHI reads and writes, sign-ins, exports, disclosures and configuration changes:
   hash-chained, append-only in the database, anchored outside it every hour.
4. *42 CFR Part 2 controls built into the software*: consent elements, recipient-named consent, one disclosure gate,
   accounting ([docs/architecture/ADR-0004](../architecture/ADR-0004-disclosure-gate.md)).
5. *Your identity provider* via OIDC; MFA required for every role by default.
6. *You run it; we help.* One server or container per programme; encrypted scheduled backups; a recovery drill
   that measures RTO/RPO. Who does what at 2am: [HOSTING.md](HOSTING.md).
7. *Evidence, not adjectives.* Security, Part 2, accessibility and architecture documentation in the repository,
   with the tests that pin each claim ([README.md](README.md), *Readiness scorecard*).

## Objection handling

**"We already have an EHR / the county has SmartCare."**
Keep it for billable treatment and the clinical record; SUDS does not compete with it. SUDS is the Part 2-controlled
layer for the outreach, supply, referral and grant work that lives in spreadsheets today — or, run as the Part 2
compliance module, for the consent, disclosure-accounting, notice and breach work your EHR does not do. Where a
service must also appear in the EHR, SUDS hands it over (encounter hand-off file, FHIR R4 feed with Part 2 consent
enforcement) rather than asking staff to double-enter. No live EHR connection has been made yet; the first is a
pilot task.

**"Does this make us Part 2 compliant?"**
No software does that on its own. SUDS enforces what software can (a consent without its §2.31 elements or
naming a different recipient authorises nothing; every disclosure is accounted; the notice travels with it) and
records the rest. Your policies, training, forms and counsel's review are the other half, and SUDS holds no
certification or third-party attestation for Part 2.

**"Who sees which clients? Can a navigator read everything?"**
By default (since 1.16.0), yes to seeing: navigators and clinicians can open every client, for coverage and
on-call work, and navigators read clinical notes without writing them. SUD counseling notes are readable only by their author, the co-signer and staff who write clinical notes (clinicians, supervisors). Client records are shared:
anyone who sees a client may update it, and the client's primary worker is told which fields changed when someone
not on the client's care team does. From 1.17.0 SUDS keeps what the fields held before and after
each change (the record's History, for its care team, supervisors and administrators), and the primary worker or a
supervisor can put a change back, as a new change: nothing in the history is removed.
Each person changes only their own visits, calls, notes, referrals and to-dos; changing or deleting another
worker's is for supervisors and administrators. Finance and read-only see client codes, never client records. A programme
that wants least privilege holds a person to their own caseload with a per-user deny of *See every client*, and
keeps clinical notes from a navigator with a deny of *Read clinical notes* (Settings → Users & permissions →
Permissions; each deny needs a reason and is audited). Set these **before** that person's records are imported
and before their device first syncs: a device holds whatever its user may see. From 1.17.0 a programme setting starts
every new navigator and clinician held to their caseload: on for a new install, off for an office upgraded from
1.16.x until an administrator turns it on (and, once, applies it to existing staff); clinical notes stay a per-person
deny ([PILOT-KIT.md](PILOT-KIT.md), week −1).
Whether that internal-use limit on SUD counseling notes meets the programme's own reading of 42 CFR §2.31(b) is a
question for its counsel ([docs/compliance/PART2.md](../compliance/PART2.md)).

**"Who runs the server?"**
Today, your IT partner or a sponsoring county — not the vendor. SUDS makes that job small (one process, built-in
backups, a restore drill, a health endpoint), but it is a real job; [HOSTING.md](HOSTING.md) lists it. A
vendor-hosted tier is planned, not offered.

**"A single server is a single point of failure."**
True, and stated openly. Availability comes from encrypted, scheduled, off-host backups, a tested restore and a
warm-standby procedure — not clustering. For an outreach programme an outage of hours with no data loss is
usually acceptable; confirm that against your own continuity needs.

**"What about 42 CFR Part 2?"**
Built into the workflow: §2.31 consent elements are required, a consent covers only the recipient it names,
referrals and exports pass one disclosure gate and are accounted for, and 2024 final-rule controls are mapped in
[docs/compliance/PART2.md](../compliance/PART2.md). County counsel or the programme's counsel should review the
consent and notice wording before first use.

**"Do you have SOC 2 / HITRUST / a pen test?"**
No, and we will not say otherwise. What exists: control documentation and a SOC 2 readiness self-assessment in
`docs/security/`, a pre-answered questionnaire, and open source code anyone can review. An independent
penetration test and SOC 2 are open vendor items ([EVALUATION-RESPONSE.md](EVALUATION-RESPONSE.md)).

**"Is it accessible?"**
A WCAG 2.1 AA self-assessment and an Accessibility Conformance Report (VPAT format) are published at
`docs/accessibility/`; the browser suite runs automated accessibility checks. It is a self-assessment, not a
third-party certification.

**"Who supports it? What if the vendor disappears?"**
The vendor is one person today; say so. The code is MIT-licensed with no runtime dependencies, so a programme can
keep running and maintaining it without the vendor, and the exports are complete. The architecture decision
records ([docs/architecture/](../architecture/README.md)) are written so a new maintainer can take over. Paid
support is business-hours ([templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md)).

**"It's open source — why pay?"**
You don't have to. The software is free. Programmes and counties pay, if they choose, for the people around it:
implementation delivered alongside your team (discovery, deployment, data migration, training, reporting setup),
business-hours support and (when offered) hosting. The current hypothesis is flat annual amounts per programme
([templates/PRICING.md](templates/PRICING.md)); other models (per active user, county site licence) are options
the owner has not decided ([PRICING-OPTIONS.md](PRICING-OPTIONS.md)). Nothing is a quote.

**"Will an AI read our clients' records?"**
Only if you turn it on. An AI documentation copilot is available from 1.17.0 ([docs/AI-COPILOT.md](../AI-COPILOT.md)). It runs only from an
office server, is off until an administrator turns it on, cannot be turned on until the programme records a BAA and
a Part 2 QSOA with the AI provider, removes the identifiers SUDS holds before sending, and returns drafts that a
person edits and signs. Removing known identifiers does not make free text de-identified (a note can still name a
place or another person), which is why the agreements are required. Your counsel should review it before use
([STRATEGY.md](STRATEGY.md), *Create 1*).
