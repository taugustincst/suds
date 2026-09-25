# Response to the critical evaluation (September 2026)

The *SUDS Critical Evaluation* (25 September 2026, against 1.10.1) concluded: "Good prototype of a real idea;
not currently a defensible product", and offered three options — **A** portfolio piece, **B** commit to 12–18
months of compliance and security work, **C** cut the EHR-adjacent framing and reposition around one workflow.

**The owner chose B and C together**: commit to the work, and aim it at the workflow SUDS does best —
outreach, naloxone and supply distribution, and grant reporting for harm-reduction and prevention programmes.
This page answers each point with its status at 1.11.x and where the evidence is. "Addressed in software"
means the capability exists and is tested; it does not mean an auditor, a regulator or counsel has confirmed it.
Organisational items that software cannot close are marked **open**.

## Point by point

| # | Evaluation said | Status now | Evidence | Still open |
| --- | --- | --- | --- | --- |
| **5.1** | Identity problem — SUD data with no Part 2 consent/disclosure workflow; MFA/SSO only on the roadmap | **Addressed in software.** §2.31 consent elements required; a consent covers only the recipient it names; one disclosure gate for referrals, identified exports, the EHR hand-off, CalOMS and FHIR, with an accounting of disclosures; 2024 final-rule controls (patient notice, complaints, incident register, court orders, counseling-note consent). TOTP MFA required for every role by default; OIDC SSO; SCIM provisioning. Repositioning (option C) also narrows where Part 2 applies: many harm-reduction programmes are not Part 2 programmes, but get the same controls | [docs/compliance/PART2.md](../compliance/PART2.md), [ADR-0004](../architecture/ADR-0004-disclosure-gate.md), `server/disclosure.js`; `test/part2.test.js`, `test/disclosure-gates.test.js`, `test/oidc.test.js`, `test/scim.test.js`; [docs/security/IDENTITY.md](../security/IDENTITY.md) | **Open:** counsel review of consent and notice wording; independent Part 2 review; SAML only via an OIDC-bridging IdP |
| **5.2** | Architecture economics — a services business in SaaS clothing; who owns the server at 2am? | **Stated honestly; not solved.** Hosting models with who does what at 2am, what vendor hosting requires, and a unit-cost model. SUDS is sold as free software plus services, not as SaaS. First pilots are IT-partner self-hosted or county-hosted | [HOSTING.md](HOSTING.md), [templates/PRICING.md](templates/PRICING.md), [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md), [ADR-0001](../architecture/ADR-0001-single-process-sqlite.md) | **Open:** vendor-hosted tier (cloud BAA, monitoring, on-call, insurance, pen test); a second person for on-call; measured support hours per programme |
| **5.3** | Release discipline — the same defects ship twice; bugs caught by QA, not prevented; no real release gate | **Policy and gate in place; effect not yet proven.** Release cadence policy (feature releases at most monthly, fix releases without migrations, human-reviewed notes, release only from a green gate); the release gate requires CI including the browser suite and its WCAG 2.1 AA accessibility script to pass on the released commit; the four defects in the evidence log were answered in 1.10.2 with browser scripts that assert them | [docs/RELEASE.md](../RELEASE.md) (*Release cadence*), `.github/workflows/`, `scripts/ui/a11y-round4.mjs`, `scripts/ui/accessibility.mjs`, CHANGELOG 1.10.2 | **Open:** a run of releases without a repeat defect is the only real evidence; an independent QA pass on the next release |
| **5.4** | Failure modes aren't designed — single-instance lock with no TTL bricked the app; backup/restore never exercised | **Lock fixed; recovery drill built and exercised in development.** The server lock takes over a lock whose process is gone; the on-device lock has a heartbeat, a takeover and an epoch fence. Recovery: scheduled encrypted backups, offsite copy, pre-migration snapshots, and a recovery drill that restores the newest backup into a throwaway copy, verifies it and measures RTO/RPO; a CI backup/restore drill job and a committed development-environment DR drill report (`docs/evidence/`) | `server/instance-lock.js` + `test/instance-lock.test.js`; `local/shims/sqlite.js` + `scripts/ui/multitab.mjs`; `server/dr-drill.js`, `test/security-evidence.test.js`, `test/backup.test.js`; [docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md) | **Open:** a drill on a real deployment, run by its operator, during the first pilot. A development drill is not a production drill |
| **5.5** | An unvalidated wedge — pricing never validated; strong incumbents; only test accounts have ever used it | **Wedge narrowed (option C); still unvalidated.** Repositioned to harm-reduction CBOs funded by opioid settlement, SOR / NDP and SABG prevention, with counties as pilot sponsors rather than buyers; no longer framed against SmartCare/Netsmart. Per-user SaaS pricing withdrawn; services priced flat per programme, marked unvalidated. Pilot kit now has a measurement plan with baselines; unmeasured time-saving claims removed | [POSITIONING.md](POSITIONING.md), [templates/PRICING.md](templates/PRICING.md), [PILOT-KIT.md](PILOT-KIT.md) §5, [docs/SCOPE.md](../SCOPE.md) | **Open: there are still no real users.** Three pilot customers; measured results; pricing validation; funder-template checks of the new harm-reduction reports |
| **5.6** | Strategic tension with the owner's forward-deployed AI consulting plan | **Decided: B + C.** SUDS is pursued as a product, repositioned | This page; [README.md](README.md) | **Open (organisational):** how the owner's time is split between consulting and SUDS; a date to revisit the decision if the three pilots do not materialise |
| **Bus factor** (engineering review) | 171 of 202 commits AI-authored in 10 days, 37 migrations, 21 releases; no human has shown they understand sync or disclosure | **Documented.** Architecture decision records for single process + SQLite, the browser kernel, sync, the disclosure gate, encryption, audit and migrations — each with the files to read and the tests that pin it; honest AI-assisted development statement in the IT guide, SDLC and questionnaire | [docs/architecture/](../architecture/README.md), [docs/security/SDLC.md](../security/SDLC.md), [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md) | **Open:** a second person (maintainer or reviewer) who has read sync, disclosure and audit end to end; an independent code review |

## Evidence log

| Finding (evaluation) | Observed | Status now | Evidence |
| --- | --- | --- | --- |
| Resource "+ Add pictures" dead | 1.10.1 | **Changed in 1.10.1/1.10.2:** the control announces the file window; pictures can also be added from a web address, dragged or pasted. **Re-verify** the original control on the released build with the evaluator's three activation paths | CHANGELOG 1.10.1, 1.10.2; `scripts/ui/resource-profiles.mjs` |
| Inactive status missing from accessibility tree | 1.10.1 | **Fixed in 1.10.2:** badges are a list; the status reads "Status: Inactive" | CHANGELOG 1.10.2; `scripts/ui/a11y-round4.mjs` |
| "compute" typo | 1.10.1 | **Explained and fixed in 1.10.2:** a tool truncating at 100 characters read "…or compute"; the sentence is now under 100 | CHANGELOG 1.10.2 |
| Hidden duplicate text in dialogs | 1.10.1 | **Fixed in 1.10.2:** a dialog no longer copies its title into the live region | CHANGELOG 1.10.2; `scripts/ui/a11y-round4.mjs` |
| Single-instance lock with no TTL bricked app | pre-1.10 | Fixed (as the evaluation says) | `test/instance-lock.test.js`; CHANGELOG 1.9.2 |
| Calendar picker obscured | pre-1.10 | Fixed (as the evaluation says) | CHANGELOG 1.10.1 |
| Supply Save did nothing | pre-1.10 | Fixed (as the evaluation says) | CHANGELOG 1.10.1 |
| Backup/restore never attempted | — | **Exercised in development and CI**; not yet on a real deployment | [docs/security/BACKUP-AND-DR.md](../security/BACKUP-AND-DR.md), `test/security-evidence.test.js`, `docs/evidence/` |

## Organisational items still open

Software cannot close these. None is done.

| Item | Why it matters | Status |
| --- | --- | --- |
| Legal entity, W-9, vendor registration | Programmes and counties contract with entities | Not started |
| Insurance (cyber liability, tech E&O, general liability) | Contract requirement; before any paid pilot | Not started |
| Counsel review of BAA/QSOA, DPA and SLA templates | Every contract with PHI access needs them | Drafts only |
| Vendor-hosted tier | CBOs without IT partners | Planned — not offered ([HOSTING.md](HOSTING.md)) |
| Independent penetration test | IT gate; prerequisite for hosting | Not commissioned ([docs/security/PEN-TEST-SCOPE.md](../security/PEN-TEST-SCOPE.md) ready) |
| SOC 2 (Type 1, then Type 2) | Larger buyers | Readiness self-assessment only ([docs/security/SOC2-READINESS.md](../security/SOC2-READINESS.md)) |
| Real users | "A product without users is a prototype with opinions" | None yet; three pilot CBOs sought |
| Pricing validation | Willingness to pay is unknown | Hypothesis only ([templates/PRICING.md](templates/PRICING.md)) |
| Independent code review; second maintainer | Bus factor | Not started; ADRs written to make it possible |
| Strategy choice (5.6) | Time allocation | **Decided: B + C** (September 2026); revisit if pilots do not start |
