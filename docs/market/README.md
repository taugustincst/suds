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
county counsel has confirmed it.

### Software and documentation gaps

| Gap (from the brief) | Status after this release | Evidence | What remains |
| --- | --- | --- | --- |
| **42 CFR Part 2** (final rule) | **Addressed in software** (consent must name the recipient; non-consent bases need a record on file; see [docs/compliance/PART2.md](../compliance/PART2.md)). **County counsel review required.** Also: disclosure accounting, patient notice, complaints, breach/incident register, court-order block, separate consent for SUD counseling notes | [docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md) | County counsel review of consent and notice wording; independent Part 2 review per [ADOPTION.md](../ADOPTION.md) §6 |
| **CalOMS Tx** | **Built; the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county.** Capture, validation and extract for the county's submission | [docs/compliance/CALOMS.md](../compliance/CALOMS.md) | Verify the layout and code sets against the current DHCS data dictionary with DHCS/the county, then test an extract through a county's real submission process in a pilot; SUDS does not submit directly to DHCS |
| **DMC claims** | **Out of scope by design.** SUDS does not bill; encounter hand-off export to the county EHR, which bills | [docs/SCOPE.md](../SCOPE.md), [POSITIONING.md](POSITIONING.md) | Nothing to build. Keep saying it; qualify programmes out with the [PILOT-KIT.md](PILOT-KIT.md) decision tree |
| **Architecture / security** | **Documented with evidence.** Architecture, encryption, identity, audit anchoring, DR drill with measured RTO/RPO, SOC 2 readiness self-assessment, completed security questionnaire, container build | [docs/security/README.md](../security/README.md), `Dockerfile`, [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/HIPAA.md](../HIPAA.md) (risk register) | Independent pen test; SOC 2 audit (organisational, below). Single-server availability remains a stated design choice |
| **Clinical depth** | **Addressed for the target market.** Problem list, care plan, six-dimension assessment (ASAM-aligned; the ASAM Criteria are not included), PHQ-9 / GAD-7 / AUDIT-C outcomes, optional DAST-10 (off by default; enabled only after the programme confirms it holds rights to use it), on top of structured notes and signatures | [docs/compliance/CALAIM.md](../compliance/CALAIM.md), [docs/USER_GUIDE.md](../USER_GUIDE.md) | Deliberately not an EHR: no eMAR, eRx, labs or billing. Validate with pilot clinicians. Counsel: confirm instrument licensing (below) |
| **Interoperability** | **Addressed in software.** FHIR R4 read API and bulk export with Part 2 consent enforcement; EHR encounter hand-off; OIDC SSO; Excel/CSV | [docs/integration/FHIR.md](../integration/FHIR.md), [docs/SCOPE.md](../SCOPE.md), [docs/API.md](../API.md) | A live connection with one county EHR / HIE in a pilot; no certification (e.g. ONC) claimed |
| **Accessibility** | **Self-assessed.** WCAG 2.1 AA audit, ACR in VPAT format, accessibility statement; automated accessibility checks in the browser suite | [docs/accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md), [docs/accessibility/STATEMENT.md](../accessibility/STATEMENT.md) | Third-party accessibility review; remediate any "partially supports" items listed in the ACR |
| **County IT gate: identity** | **In place.** OIDC SSO, MFA for every role, RBAC with caseload scoping, approved sign-ups | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/HIPAA.md](../HIPAA.md), [docs/security/IDENTITY.md](../security/IDENTITY.md) | SAML is not supported (OIDC only) — confirm the county IdP offers OIDC |
| **County IT gate: audit** | **In place.** Tamper-evident hash chain, append-only in the database, anchored every 6 hours (write-once when the county points `AUDIT_ANCHOR_DIR` at WORM storage); incremental and weekly full verification, 7-year retention | [docs/HIPAA.md](../HIPAA.md), [docs/security/LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md) | Separate the audit key from the index key (listed in the risk register) |
| **County IT gate: recovery** | **Drill capability in place; scheduled and off-host backups must be configured** (production warns when they are not). Encrypted backups, UI restore, pre-migration snapshots, DR drill tooling with RTO/RPO; the county runs its own drill during the pilot | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md) | County runs its own restore drill during the pilot |
| **County IT gate: security assurance** | **Readiness only.** Evidence pack and questionnaire; no SOC 2 report or third-party pen test yet | [SOC2-READINESS.md](../security/SOC2-READINESS.md), [QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) | See organisational items below |
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
| Counsel: confirm instrument licensing — DAST-10 (© Skinner; free for non-commercial clinical use with credit, so a commercial offering needs the programme's or vendor's own permission) and the ASAM Criteria / "ASAM" trademark (SUDS stores only six dimension names and 0–4 ratings; programmes that use the Criteria need their own ASAM licence) | Vendor / company counsel | Month 0–2 (before first paid pilot) | DAST-10 is off by default and admin-enabled; ASAM feature labelled "ASAM-aligned" with a notice ([docs/compliance/CALAIM.md](../compliance/CALAIM.md)) |
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
