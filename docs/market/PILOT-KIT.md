# SUDS 90-day pilot kit

A paid (or no-cost) pilot of SUDS in one non-billing programme, designed so that the county and the vendor
both finish with evidence: did it save time, did the numbers get better, and can IT live with it. It builds on
the county adoption plan in [docs/ADOPTION.md](../ADOPTION.md) (60-day pilot, drills, independent review) and
extends it to 90 days so a full reporting cycle — a month-end and most of a quarter — falls inside it.

## 1. Scope

| | |
| --- | --- |
| **Programme** | One non-billing programme: navigation, outreach, harm reduction, prevention or supply distribution. |
| **Users** | N = 5–15: navigators / outreach workers, their supervisor, a programme lead (super-user), one finance user if budgets are in scope, one administrator. |
| **Deployment** | County-hosted office server (or vendor-hosted instance when available). Local mode off. |
| **Data** | The pilot group's real caseload, supplies, resources, grants and budget. Parallel run with the existing spreadsheets for the first 30 days, then SUDS as the working record if the day-30 check-in agrees. |
| **Out of scope** | DMC billing, prescribing, the treatment medical record, other programmes, integrations beyond file exports (FHIR and the EHR hand-off can be tried with county IT, not put into production, unless agreed). |
| **Length** | 90 days from go-live, plus 2–3 weeks of setup before it. |

## 2. Eligibility check

Answer before signing. The outcome decides whether the pilot proceeds, and how.

```
Q1. Does the programme bill Drug Medi-Cal (DMC / DMC-ODS) or any insurer for the services it would record?
    ├─ Yes, for most services ──> NOT ELIGIBLE. Billing stays in the county EHR. Consider SUDS only for a
    │                              separate non-billing arm (outreach, supplies) of the same programme.
    ├─ Yes, for some services ──> ELIGIBLE WITH HAND-OFF. Record non-billable work in SUDS; billable
    │                              encounters are entered/billed in the EHR, using the encounter hand-off
    │                              export (docs/SCOPE.md) rather than double entry. Agree which services
    │                              go where before go-live.
    └─ No ─────────────────────> go to Q2.

Q2. Is the programme a federally assisted SUD programme that diagnoses, treats or refers for treatment,
    i.e. does it create 42 CFR Part 2 records?
    ├─ Yes / unsure ──> ELIGIBLE WITH PART 2 CONTROLS. Before real data: county counsel reviews the consent
    │                   form and patient notice (docs/compliance/PART2.md); a BAA + Part 2 QSOA is signed if
    │                   the vendor can access records (templates/BAA-QSOA-DRAFT.md); staff are trained on
    │                   consent-gated referrals. Go to Q3.
    └─ No (e.g. purely anonymous prevention / distribution) ──> ELIGIBLE (HIPAA controls still apply if
                        the organisation is a covered entity). Go to Q3.

Q3. Must the programme report CalOMS Tx (treatment admissions/discharges)?
    ├─ Yes, and the EHR already submits it ──> keep CalOMS in the EHR; SUDS does not submit. Go to Q4.
    ├─ Yes, and it is done by hand today ──> ELIGIBLE WITH CALOMS. Use SUDS capture, validation and extract
    │                                        (docs/compliance/CALOMS.md) for the county's submission; test
    │                                        one extract against the county's process in month 2.
    └─ No ──> go to Q4.

Q4. Will the pilot use real client information?
    ├─ Yes ──> IT gate required before go-live: hosting decision, hardening checklist, restore drill,
    │          BAA/QSOA and DPA where the vendor hosts or supports, risk register entries (BUYER-GUIDE-IT.md).
    └─ No (sample data only) ──> a "test drive", not a pilot; no success metrics can be measured.
```

Other conditions: a named programme sponsor and super-user; baseline numbers collected (section 5); the
county accepts the single-server availability model and the current attestation status (readiness, not an
audit report — see the [readiness scorecard](README.md#readiness-scorecard)).

## 3. Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| **Executive sponsor** | Programme manager / SUD administrator | Owns the decision at day 90; removes blockers. |
| **Pilot lead / super-user** | Programme lead or senior navigator | Configuration, first-line help, collects feedback, reports metrics. |
| **County IT lead** | IT analyst | Hosting, TLS, SSO, backups, restore drill, security review. |
| **Privacy officer** | County privacy / compliance | Part 2 and consent review, audit-log review, BAA/QSOA. |
| **Finance contact** | Programme fiscal staff | Funding sources, budget lines, approval rules (if in scope). |
| **Vendor implementation lead** | Vendor | Plan, import, configuration, training, weekly check-in. |
| **Vendor support** | Vendor | Defects and questions per [templates/SUPPORT-SLA.md](templates/SUPPORT-SLA.md). |

## 4. Week-by-week plan

| Week | What happens | Done when |
| --- | --- | --- |
| **−3** | Kick-off. Eligibility check signed off. Collect spreadsheets, funder requirements, forms, baseline numbers. IT: hosting decision; BAA/QSOA and DPA in review. | Baselines recorded; hosting agreed |
| **−2** | **Install and setup wizard** ([docs/INSTALL.md](../INSTALL.md)): name the programme, create the administrator, network access, local mode *No*. IT: TLS/proxy, SSO (optional), scheduled backups, hardening checklist ([docs/DEPLOYMENT.md](../DEPLOYMENT.md)). | Server reachable over HTTPS; backup scheduled |
| **−1** | **Configure**: Settings (time zone, programme contact, retention), Settings → Lists (visit types, outcomes, supplies), funding sources and budget lines, users and roles, MFA. **Import** from spreadsheets with Import → *Import from Excel or CSV* (clients, resources, visits, time, expenditures), templates and row checks ([docs/USER_GUIDE.md](../USER_GUIDE.md)). Load the starter resource directory if in region. Restore drill on a separate machine. | Imported data spot-checked by the super-user; restore drill timed |
| **0 (go-live)** | **Training**: navigators 90 min (+ Log, clients, referrals and consent, supplies, phone home-screen), supervisors 2 h (approvals, countersign, reports, audit), finance 1 h. Go-live. | All pilot users signed in with MFA |
| **1–2** | Daily 10-minute stand-up for the first week; vendor on call. Parallel run with spreadsheets. | No blocking defects |
| **2 (day 14)** | Check-in 1: usability issues, list tweaks, first data-completeness check. | Issues logged with owners |
| **4 (day 30)** | Check-in 2: first month-end report from SUDS compared with the spreadsheet version. Decide whether to stop the parallel run. Monthly audit review done by the privacy officer. | Parallel run stopped (or extended with reasons) |
| **5–8** | Normal operations. If in scope: CalOMS test extract, EHR hand-off test, FHIR walkthrough with IT. Key-rotation drill on a copy. | Drills recorded |
| **8 (day 60)** | Check-in 3: mid-point metrics against baseline. | Metrics sheet updated |
| **9–12** | Quarter-end funder report produced from SUDS. Collect staff survey. | Report submitted or ready |
| **13 (day 90)** | Evaluation (section 7) and decision: continue (contract), extend, or exit (section 6). | Decision recorded |

## 5. Success metrics

Record the baseline in week −3 (from timesheets, a one-week time study, or last quarter's records) and measure
at day 30, 60 and 90.

| Metric | How to measure | Baseline source | Target (suggested) |
| --- | --- | --- | --- |
| **Time to log a visit** | Median minutes from end of contact to record saved; 20 timed samples | One-week time study on the current process | 30% lower |
| **Grant report preparation time** | Staff hours to produce the monthly/quarterly funder report | Last report's actual hours | 50% lower |
| **Supply stock-outs** | Days any tracked item (naloxone, test strips) was out of stock | Last quarter's logs, or staff estimate | Fewer stock-outs; stock counts reconciled monthly within 5% |
| **Referral loop closure rate** | % of referrals with a recorded outcome within 30 days | Sample of 20 recent referrals from current records | ≥ 80% |
| **Data completeness** | % of visits with type, duration, outcome and funding source; % of clients with required demographics for the funder | Sample of current spreadsheet rows | ≥ 95% |
| **Adoption** | Weekly active pilot users / pilot users | — | ≥ 90% by week 4 |
| **Staff satisfaction** | 5-question survey (1–5) at day 30 and 90 | Day-0 survey on the current process | Average ≥ 4 |
| **Safety / integrity** | Records lost, shown to the wrong person, or failed audit-chain verification | — | Zero (any one is a stop criterion, [docs/ADOPTION.md](../ADOPTION.md)) |

## 6. Exit and data-return plan

The county owns its data. If the pilot ends without a contract:

1. **Export**: Reports → *Everything as one Excel workbook* (identified, by a supervisor, recipient and purpose
   recorded) and per-table CSV; FHIR bulk export where enabled. The vendor confirms completeness against
   table row counts.
2. **Hand over the database and keys** (county-hosted: they are already the county's; vendor-hosted: an
   encrypted backup file plus keys delivered to the county's key custodian by an agreed secure channel).
3. **Deletion** (vendor-hosted or vendor-supported copies): all copies, including backups, deleted within 30
   days of confirmed receipt; written certificate of deletion ([templates/DPA-DRAFT.md](templates/DPA-DRAFT.md)).
4. **Records retention**: the county keeps what its retention rules require; SUDS's own retention clock
   continues only if the county keeps running it (the software is open source and may be kept without a
   contract).
5. Revert to spreadsheets using the export, or migrate to another system.

## 7. Pilot evaluation template

Copy and fill at day 90.

```
PILOT EVALUATION — SUDS
Programme:                         County / CBO:
Pilot dates:                       Users (N):
Deployment: [ ] county-hosted  [ ] vendor-hosted
Eligibility outcome: [ ] eligible  [ ] with hand-off  [ ] with Part 2 controls  [ ] with CalOMS

METRICS                         Baseline    Day 30    Day 60    Day 90    Target    Met?
Time to log a visit (min)
Grant report prep (hours)
Supply stock-out days
Referral loop closure (%)
Data completeness (%)
Weekly active users (%)
Staff satisfaction (1-5)
Integrity incidents (count)

DRILLS AND GATES                                  Date       Result
Restore drill (time to restore)
Key-rotation drill (on a copy)
Monthly audit review
Independent / IT security review scheduled

WHAT WORKED (3 bullets)
WHAT DID NOT (3 bullets, with defect/issue refs)
OPEN RISKS AND WHO OWNS THEM
FUNDER REPORT: produced from SUDS? [ ] yes [ ] partly [ ] no — notes:

DECISION: [ ] continue under contract  [ ] extend pilot to ____  [ ] exit (section 6)
Reference/case study permission: [ ] yes [ ] anonymised only [ ] no
Signed: Sponsor ____________  IT ____________  Privacy ____________  Vendor ____________
```
