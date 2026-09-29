# SUDS market and procurement pack

For the people selling, buying and approving SUDS. The short version:

> **The operations system for harm-reduction and outreach programmes, prevention-funded outreach included —
> outreach encounters, naloxone and supply distribution, and grant/funder reporting — with privacy controls built
> to support 42 CFR Part 2.**
> For community-based organisations funded by opioid-settlement, SOR / Naloxone Distribution Project and SABG
> prevention money spent on outreach and distribution, and for the counties that sponsor them. SABG
> primary-prevention (PPSDS) reporting is not supported. Clinical modules (care plan, assessments, CalOMS Tx,
> FHIR, EHR hand-off) are optional, for programmes that need them. It is not an EHR, does not bill, and is not a
> hosted service today.

**Strategy (September 2026).** A critical evaluation offered three options: keep SUDS as a portfolio piece (A),
commit to the compliance and security work (B), or cut the EHR-adjacent framing and reposition around one
workflow (C). The owner chose **B and C together**: do the work, and aim it at harm-reduction outreach, supply
and grant reporting. [EVALUATION-RESPONSE.md](EVALUATION-RESPONSE.md) answers each point with its status.

## Index

| Document | For | What it covers |
| --- | --- | --- |
| [POSITIONING.md](POSITIONING.md) | Everyone | Category, buyer order, core vs optional modules, the boundary, key messages, objection handling |
| [BUYER-GUIDE-PROGRAM.md](BUYER-GUIDE-PROGRAM.md) | Programme directors | Outreach, supplies and funder reporting in SUDS, a day in the life, what we need from you |
| [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md) | IT partners, county IT, security, privacy | Deployment options, identity, data flows, controls with evidence, questionnaire, accessibility, integration, support |
| [HOSTING.md](HOSTING.md) | Programme directors, IT partners, vendor | Hosting models, who does what at 2am, what vendor hosting requires, a unit-cost model, current status |
| [PILOT-KIT.md](PILOT-KIT.md) | Sponsor, pilot lead, vendor | 90-day pilot: scope, eligibility decision tree, roles, week-by-week plan, **measurement plan**, exit plan, evaluation template |
| [PROCUREMENT.md](PROCUREMENT.md) | Purchasing, counsel, vendor | Small purchase, CMAS, RFI/RFP, CalMHSA; RFI boilerplate; contract exhibits; vendor to-do list |
| [EVALUATION-RESPONSE.md](EVALUATION-RESPONSE.md) | Owner, reviewers | Point-by-point response to the critical evaluation, with evidence and what is still open |
| [templates/BAA-QSOA-DRAFT.md](templates/BAA-QSOA-DRAFT.md) | Counsel | HIPAA BAA + 42 CFR Part 2 QSOA elements (**DRAFT — for counsel review, not legal advice**) |
| [templates/DPA-DRAFT.md](templates/DPA-DRAFT.md) | Counsel | Data processing addendum (**DRAFT — for counsel review, not legal advice**) |
| [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md) | IT, purchasing, counsel | Business-hours support, severity levels, response targets; hosted-tier terms only when offered (**template for counsel review**) |
| [templates/PRICING.md](templates/PRICING.md) | Buyers, vendor | Free software; paid services at flat annual amounts per programme (**unvalidated hypothesis**) |
| [templates/ROI-CALCULATOR.md](templates/ROI-CALCULATOR.md) | Programme directors | Worksheet: staff time, report hours, supply waste — with measured pilot numbers only |
| [templates/CASE-STUDY-TEMPLATE.md](templates/CASE-STUDY-TEMPLATE.md) | Vendor, reference CBOs | Structure for the first CBO case studies |

The product documentation these point to: [README](../../README.md) · [PLATFORM](../PLATFORM.md) ·
[INSTALL](../INSTALL.md) · [DEPLOYMENT](../DEPLOYMENT.md) · [ADOPTION](../ADOPTION.md) · [HIPAA](../HIPAA.md) ·
[WEB_APP](../WEB_APP.md) · [USER_GUIDE](../USER_GUIDE.md) · [IMPORTS](../IMPORTS.md) · [API](../API.md) ·
[architecture](../architecture/README.md) · [SUPPORT](../SUPPORT.md). For county IT and procurement review, start at the
[evidence index](../evidence/README.md): each review question mapped to its evidence, with the SBOM, the threat
model and the data inventory.

## The route to market

| Phase | Goal | Done when |
| --- | --- | --- |
| **1. Become sellable** | Legal entity, insurance, counsel-reviewed templates; release gate and recovery drill evidenced; independent penetration test; harm-reduction reports checked against real funder templates | Vendor to-do items 1–5 done; pen test report in hand |
| **2. Three pilot CBOs** | Small/mid harm-reduction or prevention CBOs with an IT partner or a county sponsor; measured pilots ([PILOT-KIT.md](PILOT-KIT.md)); pricing tested ([templates/PRICING.md](templates/PRICING.md)) | Three pilots evaluated with measured baselines; at least two signed case studies; pricing hypotheses updated with what was learned |
| **3. County sponsorship** | Counties sponsor or host CBO instances; respond to RFIs; decide on vendor hosting from measured support hours ([HOSTING.md](HOSTING.md)) | One county sponsoring more than one CBO; hosting decision recorded |
| **Later** | Direct county department sales, CMAS, CalMHSA channel, SOC 2 | Only after the above |

## Readiness scorecard

Each gap the marketability brief identified, its status after this release, and where the evidence is. "In
software" means the capability exists in SUDS and is documented; it does not mean an auditor, a regulator or
county counsel has confirmed it.

### Software and documentation gaps

| Gap (from the brief) | Status after this release | Evidence | What remains |
| --- | --- | --- | --- |
| **42 CFR Part 2** (final rule) | **Addressed in software** (consent must name the recipient; non-consent bases need a record on file; see [docs/compliance/PART2.md](../compliance/PART2.md)). **County counsel review required.** Also: disclosure accounting, patient notice, complaints, breach/incident register, court-order block, separate consent for SUD counseling notes | [docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md) | County counsel review of consent and notice wording; independent Part 2 review per [ADOPTION.md](../ADOPTION.md) §6 |
| **SABG primary prevention** | **Not supported (known gap).** No model for group or community events with attendance, CSAP strategy, IOM category or evidence-based programme, and no export for DHCS's primary-prevention data system; *people trained* (naloxone trainings) is not recorded either | [POSITIONING.md](POSITIONING.md), *"Prevention", precisely*; [PILOT-KIT.md](PILOT-KIT.md) eligibility Q0 | One design for group and community events with attendance, built only against the DHCS data dictionary (a feature release) |
| **Least privilege by default** | **The default for new installs; a setting for upgraded offices (1.17.0).** *New navigators and clinicians start held to their caseload* (Settings → Users & permissions): on for a new install, off for an office upgraded from 1.16.x (with a recommendation to turn it on). When on, every account that becomes a navigator or clinician (admin, approved sign-up, SCIM; an SSO sign-in links the SCIM account and creates none; a role change) is denied *See every client*, audited; existing staff change only through a confirmed *Apply to existing*. It does not take clinical notes from navigators (a per-user deny does; SUD counseling notes stay with their author, the co-signer and clinical staff). Role defaults are unchanged: an account the setting did not hold sees every client | [POSITIONING.md](POSITIONING.md), *Who sees which clients?*; [docs/security/QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) #22 | Upgraded offices: turn the setting on and run *Apply to existing navigators and clinicians*; decide per navigator whether to deny *Read clinical notes* |
| **CalOMS Tx** | **Built; the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county.** Capture, validation and extract for the county's submission | [docs/compliance/CALOMS.md](../compliance/CALOMS.md) | Verify the layout and code sets against the current DHCS data dictionary with DHCS/the county, then test an extract through a county's real submission process in a pilot; SUDS does not submit directly to DHCS |
| **DMC claims** | **Out of scope by design.** SUDS does not bill; encounter hand-off export to the county EHR, which bills | [docs/SCOPE.md](../SCOPE.md), [POSITIONING.md](POSITIONING.md) | Nothing to build. Keep saying it; qualify programmes out with the [PILOT-KIT.md](PILOT-KIT.md) decision tree |
| **Architecture / security** | **Documented with evidence.** Architecture, threat model, data inventory (test-checked against the schema), CycloneDX SBOM (test-checked), encryption, identity, audit anchoring, DR drill with measured RTO/RPO, SOC 2 readiness self-assessment, completed security questionnaire, container build | [docs/evidence/README.md](../evidence/README.md), [docs/security/README.md](../security/README.md), `Dockerfile`, [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/HIPAA.md](../HIPAA.md) (risk register) | Independent pen test; SOC 2 audit (organisational, below). Single-server availability remains a stated design choice |
| **Clinical depth** | **Addressed for the target market.** Problem list, care plan, six-dimension assessment (ASAM-aligned; the ASAM Criteria are not included), PHQ-9 / GAD-7 / AUDIT-C outcomes, optional DAST-10 (off by default; enabled only after the programme confirms it holds rights to use it), on top of structured notes and signatures | [docs/compliance/CALAIM.md](../compliance/CALAIM.md), [docs/USER_GUIDE.md](../USER_GUIDE.md) | Deliberately not an EHR: no eMAR, eRx, labs or billing. Validate with pilot clinicians. Counsel: confirm instrument licensing (below) |
| **Interoperability** | **Addressed in software.** FHIR R4 read API and bulk export with Part 2 consent enforcement; EHR encounter hand-off; OIDC SSO; Excel/CSV | [docs/integration/FHIR.md](../integration/FHIR.md), [docs/SCOPE.md](../SCOPE.md), [docs/API.md](../API.md) | A live connection with one county EHR / HIE in a pilot; no certification (e.g. ONC) claimed |
| **Accessibility** | **Self-assessed.** WCAG 2.1 AA audit, ACR in VPAT format, accessibility statement; automated accessibility checks in the browser suite | [docs/accessibility/ACR-WCAG21.md](../accessibility/ACR-WCAG21.md), [docs/accessibility/STATEMENT.md](../accessibility/STATEMENT.md) | Third-party accessibility review; remediate any "partially supports" items listed in the ACR |
| **County IT gate: identity** | **In place, with a caveat.** OIDC SSO, MFA for every role, RBAC, approved sign-ups. Role defaults (1.16.0): navigators and clinicians see every client; caseload scoping is a per-user deny, which from 1.17.0 a programme setting gives every new navigator and clinician (on for new installs, off until turned on for upgraded offices) | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/HIPAA.md](../HIPAA.md), [docs/security/IDENTITY.md](../security/IDENTITY.md) | SAML is not supported (OIDC only) — confirm the county IdP offers OIDC |
| **County IT gate: audit** | **In place.** Tamper-evident hash chain, append-only in the database, anchored every hour (write-once when the county points `AUDIT_ANCHOR_DIR` at WORM storage); incremental and weekly full verification, 7-year retention | [docs/HIPAA.md](../HIPAA.md), [docs/security/LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md) | Separate the audit key from the index key (listed in the risk register) |
| **County IT gate: recovery** | **Drill capability in place; scheduled and off-host backups must be configured** (production warns when they are not). Encrypted backups, UI restore, pre-migration snapshots, DR drill tooling with RTO/RPO; the county runs its own drill during the pilot | [docs/DEPLOYMENT.md](../DEPLOYMENT.md), [docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md) | County runs its own restore drill during the pilot |
| **County IT gate: security assurance** | **Readiness only.** Evidence pack and questionnaire; no SOC 2 report or third-party pen test yet | [SOC2-READINESS.md](../security/SOC2-READINESS.md), [QUESTIONNAIRE.md](../security/QUESTIONNAIRE.md) | See organisational items below |
| **Vendor-hosted option** | **Planned — not offered.** Self-hosted (IT partner) and county-hosted are available now | [HOSTING.md](HOSTING.md), [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md) | The HOSTING.md checklist: cloud BAA, US region, offsite backups, monitoring, on-call, insurance, pen test |
| **SUPRT-A (SOR client-level reporting)** | **Built; items and answer codes NOT verified against SAMHSA's SUPRT-A handbook and codebook.** Baseline, reassessment, annual and closeout records with pre-fill from the client record, due windows, completion rates (also for finance, aggregate) and a SPARS entry file that goes through the disclosure gate. A record is complete only with every section its assessment point asks (1.16.0); unasked yes/no questions are not pre-filled as "no" | [docs/compliance/SUPRT.md](../compliance/SUPRT.md), `server/suprt.js`, `test/suprt.test.js` | Verify item wording, codes and variable names against the current SUPRT-A handbook and codebook; a SPARS batch-upload layout needs the official codebook; test with a SOR programme in a pilot |
| **Supplies and syringe services** | **Built.** Items, sites and lots with a stock ledger; visits and anonymous contacts draw stock down (earliest expiry first); syringe returns counted or estimated; syringe services summary (not an official CDPH template); NDP log names the naloxone product | [docs/SUPPLIES.md](../SUPPLIES.md), `server/supplies.js`, `server/ssp-report.js`, `test/supplies.test.js` | Check the SSP summary against a CDPH-authorised programme's actual reporting; participants from anonymous contacts need a participant code (deferred: a schema change) |
| **Finance and funder reporting** | **Built; templates not certified.** Finance runs the programme's own submissions with exact counts and no client access: funder report, NDP log, settlement report, DHCS settlement layout and county templates (settlement activities, or one row per fund of another type such as SABG), syringe services summary and SUPRT-A completion rates. Publication releases screen small cells (not an expert determination); a whole publication release can be refused (sampled: fiscal years from under 100 to over 300 overdose events; no size is guaranteed to publish; the funder submission is unaffected; the quarters may be tried, and in a sweep 28 of 72 were refused too) | [docs/compliance/HARM-REDUCTION-REPORTING.md](../compliance/HARM-REDUCTION-REPORTING.md), `server/harm-reduction-reports.js`, `server/funder-report.js`, `test/harm-reduction-reports.test.js` | Check each layout against the funder's or county's current template; independent statistical review of the publication method; publication for programmes serving 20-40 people, and for fiscal years in the refused band (deferred: see below) |
| **Positioning (evaluation 5.5, option C)** | **Repositioned** around outreach, supply and grant reporting for harm-reduction programmes; clinical modules optional behind a programme profile | [POSITIONING.md](POSITIONING.md), [docs/SCOPE.md](../SCOPE.md) | Validate with three pilot CBOs |
| **Maintainability / bus factor** | **Documented.** Architecture decision records with files to read and tests that pin each decision; release-cadence policy | [docs/architecture/](../architecture/README.md), [docs/RELEASE.md](../RELEASE.md) | A second person who has reviewed sync, disclosure and audit end to end |

### Deferred from the market review of 1.15.3

Five findings are not changed in software yet, each for a reason that software alone cannot settle:

| Finding | Why it waits | What unblocks it |
| --- | --- | --- |
| **Small-programme publication**: a programme serving 20-40 people sees its headline count suppressed in a publication release; rounding or banding was suggested | Changing how counts are disclosed changes the method the publication screen defends ([docs/HIPAA.md](../HIPAA.md#small-cells-in-aggregate-reports)): a new method needs the same independent statistical review the current one is waiting for. Until then such a programme sends its funder the exact *submission*, which is not suppressed | The independent statistical / expert review (45 CFR 164.514(b)(1)); then banding or rounding as a reviewed option |
| **Publication releases refused whole** (1.16.2; engineering and market reviews of 1.16.2 and 1.16.3): in sampled programmes, fiscal years with from under 100 to over 300 overdose events were refused, and 28 of 72 quarters of seeded years; no size is guaranteed to publish, and a programme's own overdose events decide it, not its client count. Nothing is published, not a table withheld (always safe) | 1.16.1 published such years by withholding the overdose events by month under a rule whose check leaked, so 1.16.2 withdrew it; a sound check of that table costs more than the audit's budget, and more budget does not help. The exact *submission* to the funder is unaffected; the year's quarters may be tried, each checked on its own (not beside the year), but are no sure way round | A cheaper sound check of the overdose-by-month table, or a reviewed coarsening, in a feature release (1.17.0 work), measured on `test/thorough/refusal-band.test.js` and `test/thorough/refusal-quarters.test.js` |
| **SSP participants from anonymous contacts** | A visit has no field that could carry an anonymous participant code (the summary is free text, encrypted, and not fit to count by); adding one is a schema change | A participant-code column (with a blind index), in a release that may carry a migration |
| **SUPRT-A codebook and SPARS batch file** | SAMHSA's SUPRT-A codebook and batch-upload template could not be read; SUDS's variable names and codes are its own | The official codebook, then a SPARS batch layout |
| **NDP and SSP official templates** | The NDP log and the syringe services summary follow the fields as SUDS understands them; the current official templates were not available | The templates from DHCS (NDP) and CDPH (SSP), checked in a pilot |

### Organisational gaps (owner: vendor / company)

Software cannot close these. Suggested timeline from the start of Phase 1.

| Item | Owner | Suggested timeline | Status |
| --- | --- | --- | --- |
| Legal entity, W-9 / Payee Data Record, county vendor registration | Vendor / company | Month 0–1 | Not started |
| Insurance: general liability, tech E&O, cyber liability | Vendor / company | Month 1–2 (before first paid pilot) | Not started |
| BAA/QSOA and DPA templates reviewed by vendor counsel | Vendor / company | Month 1–2 | Drafts in [templates/](templates/) |
| Support (business hours) and SLA template reviewed by counsel | Vendor / company | Month 1–2 | Owner template drafted (`[owner to complete]` placeholders); today's channels are the public issue tracker and private vulnerability reports ([../SUPPORT.md](../SUPPORT.md)) |
| Vendor-hosted environment ([HOSTING.md](HOSTING.md) checklist) | Vendor / company | After 3 pilots measure support hours | Planned — not offered |
| Pricing validated with 3 pilot customers | Vendor / company | Phase 2 | Unvalidated hypothesis ([templates/PRICING.md](templates/PRICING.md)) |
| Independent penetration test, findings remediated | Vendor / company | Month 2–4 | Not started |
| SOC 2 Type 1 | Vendor / company | Month 4–8 | Readiness self-assessment in `docs/security/` |
| SOC 2 Type 2 | Vendor / company | Month 10–18 | Not started |
| Third-party accessibility review | Vendor / company | Month 3–9 | Self-assessment published |
| Counsel: confirm instrument licensing — DAST-10 (© Skinner; free for non-commercial clinical use with credit, so a commercial offering needs the programme's or vendor's own permission) and the ASAM Criteria / "ASAM" trademark (SUDS stores only six dimension names and 0–4 ratings; programmes that use the Criteria need their own ASAM licence) | Vendor / company counsel | Month 0–2 (before first paid pilot) | DAST-10 is off by default and admin-enabled; ASAM feature labelled "ASAM-aligned" with a notice ([docs/compliance/CALAIM.md](../compliance/CALAIM.md)) |
| 3 pilot CBOs with measured results; 2–3 case studies | Vendor / company | Month 3–9 | Measurement plan and template ready; no users yet |
| Cal eProcure registration; SB/DVBE certification | Vendor / company | Month 3–9 | Not started |
| Base contract and CMAS application | Vendor / company | Month 9–18 | Not started |
| CalMHSA channel conversation | Vendor / company | After references and SOC 2 Type 1 | Not started |

## Rules for anyone using this pack

- Never claim a certification, attestation or audit SUDS does not have. Say "readiness", "self-assessment" or
  "planned", with a date.
- Never describe SUDS as an EHR, a SmartCare/Netsmart replacement, or able to bill DMC.
- Legal templates are drafts for counsel; pricing is an unvalidated hypothesis; the SLA is a template.
- Never claim a time saving, a report "in minutes" or any outcome that a pilot has not measured.
- Never describe SUDS as hosted, or promise 24×7 support or an uptime figure, until [HOSTING.md](HOSTING.md) says it is offered.
- Lead with outreach, supplies and funder reporting; clinical modules are optional, not the pitch.
- Keep this pack in step with the product: when a workstream changes status, update the scorecard.
