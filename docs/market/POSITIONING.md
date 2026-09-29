# SUDS positioning

> **The operations system for harm-reduction and outreach programmes, prevention-funded outreach included —
> outreach encounters, naloxone and supply distribution, and grant/funder reporting — with privacy controls built
> to support 42 CFR Part 2.**

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
prevention-funded outreach and naloxone / supply distribution. It does **not** support SABG **primary-prevention**
reporting: it has no model for group or community events with attendance, CSAP strategy, IOM category
(universal, selective, indicated) or evidence-based programme, and no export for DHCS's primary-prevention data
system (confirm the current system and data dictionary with DHCS). A primary-prevention set-aside provider cannot
report its main activity from SUDS today; say so ([README.md](README.md), *Readiness scorecard*).

## Who it is for, in order

| Order | Buyer | Why them |
| --- | --- | --- |
| **1** | **Small and mid-sized harm-reduction and prevention CBOs** (roughly 3–40 staff) funded by **opioid-settlement** allocations, **SOR** / the **Naloxone Distribution Project**, or **SABG prevention** funds spent on outreach and distribution (not primary-prevention reporting) — running today on spreadsheets, shared drives and paper sign-out sheets | The pain (quarter-end reporting, supply counts, anonymous contacts) is theirs daily; the buyer is the programme director; the purchase is small enough for a programme budget |
| **2** | **Their IT partner** (a managed-IT provider, a fiscal sponsor's IT, or a staff member who runs servers) | Today SUDS is self-hosted, so every CBO customer needs one; they are the gate, not the champion |
| **3** | **Counties, as sponsors of CBO pilots** — a county SUD / behavioral-health or public-health department that funds CBOs and wants consistent, privacy-safe outcome data from them | A county can host a CBO's instance or fund the pilot; selling SUDS *to* a county as a department system is a later, slower sale (procurement 6–24+ months) and is not the first market |

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

Most EHRs a county SUD provider uses (eClinicalWorks, Epic, SmartCare and others) hold the clinical record and the
billing well. What programmes still keep on paper or in spreadsheets is the Part 2 work around them: a §2.31
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
  and secure referral links to providers that do not use SUDS.
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
- **Not a multi-tenant, high-availability platform.** One single-server instance per programme
  ([docs/architecture/ADR-0001](../architecture/ADR-0001-single-process-sqlite.md)).

## Where it sits next to an EHR

Where a CBO or county programme also has an EHR, SUDS holds the work around it: anonymous outreach, supplies
and stock, the resource directory, grant budgets and funder reports — or, for a treatment programme, the Part 2
consent-and-disclosure layer above. If some services must also be in the EHR, SUDS produces a consent-gated
hand-off file or FHIR feed instead of double entry; patients and encounters can come the other way from the
EHR's FHIR export. Most harm-reduction CBOs have no EHR at all; for them SUDS is the programme record.

## Key messages

**For programme directors (value)**

1. *Outreach you can count.* Log a contact in the field — named or anonymous — on a phone, even offline where the
   programme allows it; it counts in the funder report.
2. *Supplies you can account for.* Every kit handed out comes off the stock of the site it left from; stock-outs and reversals are
   visible before the funder asks.
3. *Funder reports from the records you already keep.* Unduplicated people served by funding source and period,
   with small-cell suppression. **How much time this saves is not yet measured** — the pilot measures it
   against your current hours ([PILOT-KIT.md](PILOT-KIT.md), section 5).
4. *Money that holds up to audit.* Expenditures and staff time against grant lines, with approvals and
   separation of duties: nobody approves their own.
5. *Privacy participants can trust.* Consent that names who may receive information, an accounting of every
   disclosure, identifiers and notes encrypted field by field.

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
Keep it for billable treatment and the clinical record. SUDS is for the outreach, supply and grant work that
lives in spreadsheets today — or, run as the Part 2 compliance module, for the consent, disclosure-accounting,
notice and breach work your EHR does not do. Where a service must also appear in the EHR, SUDS hands it over
rather than asking staff to double-enter.

**"Does this make us Part 2 compliant?"**
No software does that on its own. SUDS enforces what software can (a consent without its §2.31 elements or
naming a different recipient authorises nothing; every disclosure is accounted; the notice travels with it) and
records the rest. Your policies, training, forms and counsel's review are the other half, and SUDS holds no
certification or third-party attestation for Part 2.

**"Who sees which clients? Can a navigator read everything?"**
By default (since 1.16.0), yes to seeing: navigators and clinicians can open every client, for coverage and
on-call work, and navigators read clinical notes without writing them. SUD counseling notes are readable only by their author, the co-signer and staff who write clinical notes (clinicians, supervisors). Client records are shared:
anyone who sees a client may update it, and the client's primary worker is told which fields changed when someone
not on the client's care team does. SUDS keeps which fields were changed (in the notice and the audit log), not what
they held before: the client record has no revision history yet (planned), so an earlier value comes back only from
a backup.
Each person changes only their own visits, calls, notes, referrals and to-dos; changing or deleting another
worker's is for supervisors and administrators. Finance and read-only see client codes, never client records. A programme
that wants least privilege holds a person to their own caseload with a per-user deny of *See every client*, and
keeps clinical notes from a navigator with a deny of *Read clinical notes* (Settings → Users & permissions →
Permissions; each deny needs a reason and is audited). Set these **before** that person's records are imported
and before their device first syncs: a device holds whatever its user may see. There is no programme-wide
"start everyone scoped" switch yet, so each person is set individually ([PILOT-KIT.md](PILOT-KIT.md), week −1).
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
You don't have to. The software is free. Programmes pay, if they choose, for implementation, business-hours
support and (when offered) hosting — flat annual amounts per programme, still being validated
([templates/PRICING.md](templates/PRICING.md)).
