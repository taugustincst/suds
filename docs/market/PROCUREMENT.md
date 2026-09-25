# Buying SUDS: a procurement guide for counties and CBOs

How a California county (or a CBO it funds) can buy SUDS subscriptions, implementation and support, what the
contract needs, and what the vendor still has to do to be buyable through each route.

> This is general guidance, not legal or procurement advice. Every county sets its own purchasing thresholds
> and rules in its purchasing ordinance and policy manual. **Confirm local limits and required forms with the
> county purchasing agent and county counsel before relying on any route below.**

## Routes, from quickest to broadest

### 1. Small purchase / informal procurement

Most counties let a department buy below a set dollar threshold with informal quotes (often one to three) or a
purchase order, instead of a formal RFP. Thresholds vary widely by county and by what is bought (goods,
services, IT, professional services), and IT or software purchases often need IT approval regardless of amount.

- **Fits:** a paid pilot ([PILOT-KIT.md](PILOT-KIT.md)), and small programmes (for example, 10 users at the
  pricing hypothesis is roughly $4,200–5,900 a year, [templates/PRICING.md](templates/PRICING.md)).
- **Watch for:** splitting a purchase to stay under a threshold is prohibited; multi-year terms count in full;
  software may still require an IT security review and a BAA whatever the amount.
- **CBOs** buying with grant money follow their own procurement policy and the funder's rules (for federal
  funds, 2 CFR 200.317–.327 procurement standards, including micro-purchase and small-purchase thresholds).
- **Ask purchasing:** the informal threshold for software/SaaS and services; whether sole-source justification
  is needed; which contract template and insurance limits apply below the threshold.

### 2. CMAS (California Multiple Award Schedules)

CMAS is run by the Department of General Services (DGS) Procurement Division. State agencies and local
government agencies, including counties, may buy from a supplier's CMAS contract without running their own
competitive solicitation (local agencies confirm this against their own rules). It is the route that makes
SUDS easy for a county to buy above its small-purchase limit.

**What the vendor must do to get a CMAS contract** (vendor to-do; confirm current requirements on the DGS
CMAS pages before applying):

- [ ] Hold a **base contract** that CMAS can be built on — typically a federal GSA Multiple Award Schedule, or
      another competitively awarded contract that DGS accepts. SUDS currently has none; obtaining one (or a
      qualifying base) is the first step.
- [ ] Register in **Cal eProcure** (California's procurement portal) and obtain the supplier ID.
- [ ] Apply for **Small Business (SB)** and, if eligible, **Disabled Veteran Business Enterprise (DVBE)**
      certification with DGS — optional, but it opens the state SB/DVBE option and scores well in solicitations.
- [ ] Prepare the CMAS application: products/services and prices drawn from the base contract, labour
      categories for implementation and training, IT and cloud terms, and required forms (Payee Data Record,
      Darfur and Iran contracting certifications, and others DGS lists).
- [ ] Accept the **DGS IT general provisions and cloud computing (SaaS) special provisions** that apply to
      the CMAS category, including their accessibility, security and data-location terms.
- [ ] Plan for the **timeline**: base contract first (often months), then CMAS review. Treat CMAS as a
      Phase 3 goal (county pilots), not a prerequisite for the first CBO references.

### 3. Formal solicitation (RFI / RFP / RFQ)

A county may issue an RFI to learn the market, then an RFP. Respond to every relevant RFI (boilerplate below):
it is how the county learns SUDS exists, and it can shape an RFP toward non-billing programme operations
rather than "an EHR".

### 4. Cooperative purchasing — CalMHSA (later channel)

The California Mental Health Services Authority (CalMHSA) is a joint powers authority of California counties
that procures and administers shared programmes and technology for its member counties, including the
semi-statewide EHR. A CalMHSA arrangement could let many counties adopt SUDS under one agreement.

- **Timing:** later. CalMHSA is unlikely to engage before SUDS has county references, a SOC 2 report, a
  third-party pen test and the insurance a JPA requires.
- **Positioning:** a complement to the EHR CalMHSA already administers — the programme-operations layer for
  grant-funded, non-billing work, with the encounter hand-off and FHIR feed into the EHR. Never a competitor to it.
- **Other cooperatives** (for example, national cooperative purchasing contracts some counties accept) are
  worth checking once the company has a contract to piggyback.

## RFI response boilerplate

Replace everything in `[brackets]`. Keep answers short and point to evidence; never claim a certification SUDS
does not hold.

```
1. COMPANY OVERVIEW
   Legal name: [Company legal name]            Entity type / state: [e.g. California LLC]
   Address: [ ]                                Year founded: [ ]
   Primary contact: [name, title, email, phone]
   Employees: [ ]                              California SB/DVBE: [certified / applied / not applicable]
   Relevant customers: [CBO / county references, or "pilot in progress with ___"]
   Insurance: [general liability, professional/E&O, cyber — limits] (certificates on request)

2. SOLUTION SUMMARY
   SUDS is program-operations software for California's grant-funded, non-billing SUD programmes —
   navigation, outreach, harm reduction, prevention and supply distribution. It tracks caseloads, services,
   supplies, resources and referrals, grants and approvals, and produces unduplicated funder reports.
   It complements the county EHR (SmartCare, Netsmart and others) and does not bill Drug Medi-Cal.

3. DEPLOYMENT AND HOSTING
   County-hosted (single server or container; Node.js 22, no third-party runtime packages) or
   vendor-hosted [available from ___ / planned]. See docs/market/BUYER-GUIDE-IT.md.

4. SECURITY
   Field-level AES-256-GCM encryption of PHI; TLS 1.2+; MFA required for every role; OIDC SSO;
   role-based access with caseload scoping; hash-chained, daily-sealed audit log.
   Evidence: docs/HIPAA.md, docs/security/. Attestation: SOC 2 Type 1 [readiness complete; audit
   planned for ___]; independent penetration test [planned for ___]. Security questionnaire: docs/security/.

5. PRIVACY AND 42 CFR PART 2
   Part 2 consent elements enforced; consent-gated referrals; accounting of disclosures; final-rule
   controls. Evidence: docs/HIPAA.md, docs/compliance/PART2.md. BAA and Part 2 QSOA: provided.

6. STATE REPORTING AND INTEGRATION
   CalOMS Tx capture/validation/extract (docs/compliance/CALOMS.md); encounter hand-off to the county
   EHR (docs/SCOPE.md); FHIR R4 read API and bulk export with Part 2 consent enforcement
   (docs/integration/FHIR.md); OIDC SSO; Excel/CSV import and export.

7. ACCESSIBILITY
   WCAG 2.1 AA self-assessment and ACR (VPAT format): docs/accessibility/ACR-WCAG21.md;
   statement and known issues: docs/accessibility/STATEMENT.md.

8. BACKUP, RECOVERY AND AVAILABILITY
   Scheduled encrypted backups with off-host copy; restore from the UI; DR drill with measured
   RTO/RPO ([docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md)). Single-instance architecture per programme (no clustering), stated as
   a design choice. Uptime target for vendor-hosted: see templates/SUPPORT-SLA.md.

9. SUPPORT AND IMPLEMENTATION
   Implementation: setup, spreadsheet import, configuration, training (docs/market/PILOT-KIT.md).
   Support: severity-based response targets (docs/market/templates/SUPPORT-SLA.md).
   Source code: open source (MIT) — no licence lock-in; full data export on exit.

10. PRICING
    [Per user per month, volume-tiered; implementation fee; pilot terms] — see templates/PRICING.md.
```

## Contract exhibits the county will expect

| Exhibit | Notes | Starting point |
| --- | --- | --- |
| **Business Associate Agreement (HIPAA)** | Required when the vendor creates, receives, maintains or transmits PHI — vendor hosting, or support staff who can see production data. | [templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md) |
| **42 CFR Part 2 Qualified Service Organization Agreement** | For Part 2 programmes; the vendor agrees to be bound by Part 2 and to resist unauthorised access in judicial proceedings. Usually combined with the BAA. | [templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md) |
| **Data processing / data protection addendum** | Data ownership, US data location, subprocessors, return and deletion, breach notice timing, no secondary use. | [templates/DPA-DRAFT.md](templates/DPA-DRAFT.md) |
| **DGS IT general provisions / cloud computing SaaS special provisions** | Counties often borrow the state's terms; CMAS contracts include them. Read the current versions from DGS; they cover security, data location, breach notice, termination and transition. | DGS website (confirm current versions) |
| **Accessibility (ADA / Section 508 / Gov. Code §7405 & §11135)** | State and many county contracts require conformance to WCAG 2.x AA / Section 508 and remediation of reported barriers. Offer an **accessibility warranty**: conformance as stated in the ACR, and remediation of confirmed barriers within an agreed time. | [docs/accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md) |
| **Insurance** | Commercial general liability, professional / technology errors and omissions, **cyber liability** (privacy breach, notification costs), workers' compensation, auto if on-site. County sets the limits; certificates naming the county as additional insured. | Vendor to-do |
| **Support SLA** | Severity levels, response and resolution targets, uptime for vendor-hosted. | [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md) |
| **Pricing schedule** | Tiers, implementation fee, pilot terms, price holds. | [templates/PRICING.md](templates/PRICING.md) |
| **Exit / transition** | Data return format and timing, deletion certificate, transition assistance. | [PILOT-KIT.md](PILOT-KIT.md), section 6; DPA |
| **County forms** | W-9 / Payee Data Record, conflict-of-interest, anti-discrimination, debarment, Iran/Darfur certifications as applicable. | County purchasing |

## Vendor to-do list

Owner: **vendor / company**. These are organisational tasks the software cannot do.

| # | Item | Why | Suggested timing |
| --- | --- | --- | --- |
| 1 | **Legal entity** (e.g. LLC or corporation) with a business bank account | Counties contract with entities, not individuals | Now (Phase 1) |
| 2 | **W-9, Payee Data Record, EIN**, county vendor registration | Required to be paid | Now |
| 3 | **Insurance**: general liability, tech E&O, cyber liability (common county asks are $1M–$5M per claim; confirm) | Contract exhibit; also protects the company | Before first paid pilot |
| 4 | **Signed-off BAA/QSOA and DPA templates**, reviewed by the vendor's own counsel | Every PHI contract needs them | Before first paid pilot |
| 5 | **Support SLA** staffed: support mailbox/portal, on-call for Sev 1, named escalation | Contract exhibit | Before first paid pilot |
| 6 | **Vendor-hosted environment** (US region, BAA with the cloud provider, one instance per customer, backups, monitoring) | CBOs without servers | Phase 1–2 (months 1–4) |
| 7 | **Independent penetration test** of the application and the hosted environment, findings remediated, letter of attestation | County IT gate | Phase 1 (months 2–4) |
| 8 | **SOC 2 Type 1** (from the readiness assessment in `docs/security/`), scoped to the hosted service | County IT gate | Months 4–8 |
| 9 | **SOC 2 Type 2** (observation period typically 3–12 months after Type 1) | Larger counties, CalMHSA | Months 10–18 |
| 10 | **Third-party accessibility review** of the ACR | Strengthens the accessibility warranty | Phase 2 |
| 11 | **2–3 CBO references** with signed case-study permission ([templates/CASE-STUDY-TEMPLATE.md](templates/CASE-STUDY-TEMPLATE.md)) | Every county asks | Phase 2 (months 3–9) |
| 12 | **Cal eProcure registration; SB (and DVBE if eligible) certification** | Small-business preferences, CMAS | Phase 2 |
| 13 | **Base contract and CMAS application** | County purchases above small-purchase limits | Phase 3 (months 9–18) |
| 14 | **CalMHSA conversation** | Multi-county channel | After references + SOC 2 Type 1 |
