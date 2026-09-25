# SUDS market and procurement pack

For the people selling, buying and approving SUDS. The short version:

> **SUDS is the system for the work SmartCare doesn't do well — without pretending to be another EHR.**
> Program-operations software for California's grant-funded, **non-billing** prevention, harm-reduction,
> outreach, navigation and supply-distribution programmes. It complements the county EHR (SmartCare, Netsmart
> and others); it does not bill Drug Medi-Cal, prescribe, or replace the medical record.

## Index

| Document | For | What it covers |
| --- | --- | --- |
| [POSITIONING.md](POSITIONING.md) | Everyone | Category, who it is for, the boundary, the complement story, key messages, objection handling |
| [BUYER-GUIDE-PROGRAM.md](BUYER-GUIDE-PROGRAM.md) | SUD programme managers | Workflows, outcomes and grant reporting, a day in the life, what we need from you |
| [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md) | County IT, security, privacy | Deployment options, identity, data flows, controls with evidence, questionnaire, accessibility, integration, support, who hosts what |
| [PILOT-KIT.md](PILOT-KIT.md) | Sponsor, pilot lead, vendor | 90-day pilot: scope, eligibility decision tree, roles, week-by-week plan, metrics, exit plan, evaluation template |
| [PROCUREMENT.md](PROCUREMENT.md) | Purchasing, counsel, vendor | Small purchase, CMAS, RFI/RFP, CalMHSA; RFI boilerplate; contract exhibits; vendor to-do list |
| [templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md) | Counsel | HIPAA BAA + 42 CFR Part 2 QSOA elements (**DRAFT — for county counsel review, not legal advice**) |
| [templates/DPA-DRAFT.md](templates/DPA-DRAFT.md) | Counsel | Data processing addendum (**DRAFT — for county counsel review, not legal advice**) |
| [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md) | IT, purchasing | Severity levels, response targets, uptime for vendor-hosted vs county-hosted |
| [templates/PRICING.md](templates/PRICING.md) | Buyers, vendor | Tiers, pilot terms, implementation fee, what is included (**hypothesis to validate**) |
| [templates/ROI-CALCULATOR.md](templates/ROI-CALCULATOR.md) | Programme managers | Worksheet: staff time saved, report hours, supply waste |
| [templates/CASE-STUDY-TEMPLATE.md](templates/CASE-STUDY-TEMPLATE.md) | Vendor, reference CBOs | Structure for the first CBO case studies |

The product documentation these point to: [README](../../README.md) · [PLATFORM](../PLATFORM.md) ·
[INSTALL](../INSTALL.md) · [DEPLOYMENT](../DEPLOYMENT.md) · [ADOPTION](../ADOPTION.md) · [HIPAA](../HIPAA.md) ·
[WEB_APP](../WEB_APP.md) · [USER_GUIDE](../USER_GUIDE.md) · [IMPORTS](../IMPORTS.md) · [API](../API.md).

## The route to market

| Phase | Goal | Done when |
| --- | --- | --- |
| **1. Become sellable** | Part 2 final-rule controls, security evidence, WCAG 2.1 AA / ACR, an assurance path; legal entity, insurance, contract templates | The software gaps in the scorecard below are closed; the vendor to-do items 1–5 are done |
| **2. Land 2–3 CBO references** | Non-billing organisations on spreadsheets; paid pilots ([PILOT-KIT.md](PILOT-KIT.md)) | Two signed case studies with measured results; pen test done; SOC 2 Type 1 under way |
| **3. County pilots** | Small or rural county programme; respond to RFIs; CMAS eligibility; then CalMHSA as a channel | One county pilot converted; CMAS application filed |

## Readiness scorecard

Each gap the marketability brief identified, its status after this release, and where the evidence is. "In
software" means the capability exists in SUDS and is documented; it does not mean an auditor, a regulator or
county counsel has confirmed it. Evidence paths under `docs/compliance/`, `docs/security/`,
`docs/integration/`, `docs/accessibility/` and `docs/SCOPE.md` arrive with the parallel workstreams of this
release.

### Software and documentation gaps

| Gap (from the brief) | Status after this release | Evidence | What remains |
| --- | --- | --- | --- |
| **42 CFR Part 2** (final rule) | **Addressed in software.** Consent elements, consent-gated referrals, disclosure accounting (existing); patient notice, complaints, breach/incident register, court-order block, separate consent for SUD counseling notes (new) | [docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md) | County counsel review of consent and notice wording; independent Part 2 review per [ADOPTION.md](../ADOPTION.md) §6 |
| **CalOMS Tx** | **Addressed in software.** Capture, validation and extract for the county's submission | [docs/compliance/CALOMS.md](../compliance/CALOMS.md) | Test an extract against a county's real submission process and DHCS acceptance in a pilot; SUDS does not submit directly to DHCS |
| **DMC claims** | **Out of scope by design.** SUDS does not bill; encounter hand-off export to the county EHR, which bills | [docs/SCOPE.md](../SCOPE.md), [POSITIONING.md](POSITIONING.md) | Nothing to build. Keep saying it; qualify programmes out with the [PILOT-KIT.md](PILOT-KIT.md) decision tree |
| **Architecture / security** | **Documented with evidence.** Architecture, encryption, identity, audit anchoring, DR drill with measured RTO/RPO, SOC 2 readiness self-assessment, completed security questionnaire, container build | [docs/security/](../security/), `Dockerfile`, [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/HIPAA.md](../HIPAA.md) (risk register) | Independent pen test; SOC 2 audit (organisational, below). Single-server availability remains a stated design choice |
| **Clinical depth** | **Addressed for the target market.** Problem list, care plan, ASAM dimensions, PHQ-9 / GAD-7 / AUDIT-C / DAST-10 outcomes, on top of structured notes and signatures | [docs/compliance/CALAIM.md](../compliance/CALAIM.md), [docs/USER_GUIDE.md](../USER_GUIDE.md) | Deliberately not an EHR: no eMAR, eRx, labs or billing. Validate with pilot clinicians |
| **Interoperability** | **Addressed in software.** FHIR R4 read API and bulk export with Part 2 consent enforcement; EHR encounter hand-off; OIDC SSO; Excel/CSV | [docs/integration/FHIR.md](../integration/FHIR.md), [docs/SCOPE.md](../SCOPE.md), [docs/API.md](../API.md) | A live connection with one county EHR / HIE in a pilot; no certification (e.g. ONC) claimed |
| **Accessibility** | **Self-assessed.** WCAG 2.1 AA audit, ACR in VPAT format, accessibility statement; automated accessibility checks in the browser suite | [docs/accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md), [docs/accessibility/STATEMENT.md](../accessibility/STATEMENT.md) | Third-party accessibility review; remediate any "partially supports" items listed in the ACR |
| **County IT gate: identity** | **In place.** OIDC SSO, MFA for every role, RBAC with caseload scoping, approved sign-ups | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/HIPAA.md](../HIPAA.md), [docs/security/](../security/) | SAML is not supported (OIDC only) — confirm the county IdP offers OIDC |
| **County IT gate: audit** | **In place.** Hash-chained audit, daily sealed head, incremental and weekly full verification, 7-year retention | [docs/HIPAA.md](../HIPAA.md), [docs/security/](../security/) | Separate the audit key from the index key (listed in the risk register) |
| **County IT gate: recovery** | **In place and drilled.** Scheduled encrypted off-host backups, UI restore, pre-migration snapshots, DR drill with RTO/RPO | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/security/](../security/) | County runs its own restore drill during the pilot |
| **County IT gate: security assurance** | **Readiness only.** Evidence pack and questionnaire; no SOC 2 report or third-party pen test yet | [docs/security/](../security/) | See organisational items below |
| **Vendor-hosted option** | **Planned.** County-hosted is available now | [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md) | Hosting environment, cloud BAA, monitoring, SLA staffing |

### Organisational gaps (owner: vendor / company)

Software cannot close these. Suggested timeline from the start of Phase 1.

| Item | Owner | Suggested timeline | Status |
| --- | --- | --- | --- |
| Legal entity, W-9 / Payee Data Record, county vendor registration | Vendor / company | Month 0–1 | Not started |
| Insurance: general liability, tech E&O, cyber liability | Vendor / company | Month 1–2 (before first paid pilot) | Not started |
| BAA/QSOA and DPA templates reviewed by vendor counsel | Vendor / company | Month 1–2 | Drafts in [templates/](templates/) |
| Support desk and SLA staffing | Vendor / company | Month 1–2 | SLA template drafted |
| Vendor-hosted environment | Vendor / company | Month 1–4 | Planned |
| Independent penetration test, findings remediated | Vendor / company | Month 2–4 | Not started |
| SOC 2 Type 1 | Vendor / company | Month 4–8 | Readiness self-assessment in `docs/security/` |
| SOC 2 Type 2 | Vendor / company | Month 10–18 | Not started |
| Third-party accessibility review | Vendor / company | Month 3–9 | Self-assessment published |
| 2–3 CBO references with case studies | Vendor / company | Month 3–9 | Template ready |
| Cal eProcure registration; SB/DVBE certification | Vendor / company | Month 3–9 | Not started |
| Base contract and CMAS application | Vendor / company | Month 9–18 | Not started |
| CalMHSA channel conversation | Vendor / company | After references and SOC 2 Type 1 | Not started |

## Rules for anyone using this pack

- Never claim a certification, attestation or audit SUDS does not have. Say "readiness", "self-assessment" or
  "planned", with a date.
- Never describe SUDS as an EHR, a SmartCare/Netsmart replacement, or able to bill DMC.
- Legal templates are drafts for county counsel; pricing is a hypothesis.
- Keep this pack in step with the product: when a workstream changes status, update the scorecard.
