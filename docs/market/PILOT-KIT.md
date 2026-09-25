# SUDS 90-day pilot kit

A 90-day pilot of SUDS in one harm-reduction, outreach or prevention programme — typically a CBO, sometimes
sponsored by its county — designed so that the programme, its sponsor and the vendor all finish with
**measured** evidence: did it save time, did the numbers get better, and can the people running the server
live with it. Nothing in the market pack claims a time saving until a pilot has measured one. It builds on
the county adoption plan in [docs/ADOPTION.md](../ADOPTION.md) (60-day pilot, drills, independent review) and
extends it to 90 days so a full reporting cycle — a month-end and most of a quarter — falls inside it.

## 1. Scope

| | |
| --- | --- |
| **Programme** | One non-billing programme: outreach, harm reduction, naloxone / supply distribution, prevention or navigation. Programme profile *Harm reduction & outreach* unless the programme needs the clinical modules. |
| **Users** | N = 5–15: navigators / outreach workers, their supervisor, a programme lead (super-user), one finance user if budgets are in scope, one administrator. |
| **Deployment** | Self-hosted by the programme's IT partner, or hosted by a sponsoring county ([HOSTING.md](HOSTING.md)). Vendor hosting is not offered. Local mode off unless a documented field need is agreed. |
| **Data** | The pilot group's real caseload, supplies, resources, grants and budget. Parallel run with the existing spreadsheets for the first 30 days, then SUDS as the working record if the day-30 check-in agrees. |
| **Out of scope** | DMC billing, prescribing, the treatment medical record, other programmes, integrations beyond file exports (FHIR and the EHR hand-off can be tried with county IT, not put into production, unless agreed). |
| **Length** | 90 days from go-live, plus 2–3 weeks of setup before it. |

## 2. Eligibility check

Answer before signing. The outcome decides whether the pilot proceeds, and how.

```
Q1. Does the programme bill Drug Medi-Cal (DMC / DMC-ODS) or any insurer for the services it would record?
    ├─ Yes, for most services ──> NOT ELIGIBLE. Billing stays in the EHR. Consider SUDS only for a
    │                              separate non-billing arm (outreach, supplies) of the same programme.
    ├─ Yes, for some services ──> ELIGIBLE WITH HAND-OFF. Record non-billable work in SUDS; billable
    │                              encounters are entered/billed in the EHR, using the encounter hand-off
    │                              export (docs/SCOPE.md) rather than double entry. Agree which services
    │                              go where before go-live.
    └─ No ─────────────────────> go to Q2.

Q2. Is the programme a federally assisted SUD programme that diagnoses, treats or refers for treatment,
    i.e. does it create 42 CFR Part 2 records?
    ├─ Yes / unsure ──> ELIGIBLE WITH PART 2 CONTROLS. Before real data: the programme's (or county) counsel reviews the consent
    │                   form and patient notice (docs/compliance/PART2.md); a BAA + Part 2 QSOA is signed if
    │                   the vendor can access records (templates/BAA-QSOA-DRAFT.md); staff are trained on
    │                   consent-gated referrals. Go to Q3.
    └─ No (e.g. purely anonymous prevention / distribution) ──> ELIGIBLE (HIPAA controls still apply if
                        the organisation is a covered entity). Go to Q3.

Q3. Must the programme report CalOMS Tx (treatment admissions/discharges)?
    ├─ Yes, and the EHR already submits it ──> keep CalOMS in the EHR; SUDS does not submit. Go to Q4.
    ├─ Yes, and it is done by hand today ──> ELIGIBLE, CALOMS STAYS WHERE IT IS. The SUDS CalOMS extract is
    │                                        NOT verified against the DHCS data dictionary
    │                                        (docs/compliance/CALOMS.md): keep submitting the way you do now.
    │                                        Optionally, with the county, compare a SUDS preview extract with
    │                                        the real submission in month 2 — as a test, never submitted.
    └─ No ──> go to Q4.

Q4. Will the pilot use real client information?
    ├─ Yes ──> IT gate required before go-live: hosting decision, hardening checklist, restore drill,
    │          BAA/QSOA and DPA where the vendor hosts or supports, risk register entries (BUYER-GUIDE-IT.md).
    └─ No (sample data only) ──> a "test drive", not a pilot; no success metrics can be measured.
```

Other conditions: a named programme sponsor and super-user; baseline numbers collected (section 5); the
sponsor and IT partner accept the single-server availability model and the current attestation status (readiness, not an
audit report — see the [readiness scorecard](README.md#readiness-scorecard)).

## 3. Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| **Executive sponsor** | Programme director (and the county contact, where a county sponsors) | Owns the decision at day 90; removes blockers. |
| **Pilot lead / super-user** | Programme lead or senior navigator | Configuration, first-line help, collects feedback, reports metrics. |
| **IT lead** | The programme's IT partner, or county IT when the county hosts | Hosting, TLS, SSO, backups, restore drill, security review. |
| **Privacy lead** | The programme's privacy officer (county privacy when the county sponsors) | Part 2 and consent review, audit-log review, BAA/QSOA. |
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
| **1–2** | Daily 10-minute stand-up for the first week; vendor available in business hours. Parallel run with spreadsheets. | No blocking defects |
| **2 (day 14)** | Check-in 1: usability issues, list tweaks, first data-completeness check. | Issues logged with owners |
| **4 (day 30)** | Check-in 2: first month-end funder report from SUDS compared with the spreadsheet version, and its preparation hours logged against the baseline. Decide whether to stop the parallel run. Monthly audit review done by the privacy officer. | Parallel run stopped (or extended with reasons) |
| **5–8** | Normal operations. If in scope: CalOMS preview compared with the real submission (never submitted), EHR hand-off test, FHIR walkthrough with IT. Key-rotation drill on a copy. | Drills recorded |
| **8 (day 60)** | Check-in 3: mid-point metrics against baseline. | Metrics sheet updated |
| **9–12** | Quarter-end funder report produced from SUDS. Collect staff survey. | Report submitted or ready |
| **13 (day 90)** | Evaluation (section 7) and decision: continue (contract), extend, or exit (section 6). | Decision recorded |

## 5. Measurement plan and success metrics

No time saving is claimed for SUDS until a pilot measures it. Measure the **baseline before go-live** (week −3)
with the current process, then the same way at day 30, 60 and 90. The pilot lead owns the metrics sheet; the
vendor may not fill it in.

### How to measure

| Metric | Baseline (week −3, current process) | With SUDS (day 30 / 60 / 90) | Target (suggested — agree before go-live) |
| --- | --- | --- | --- |
| **Hours to produce the monthly funder report** | Actual staff hours for the last two monthly reports, from timesheets or the preparer's log (count pulling data, reconciling, checking, formatting) | Hours for each month-end report produced from SUDS, logged by the preparer the same way | 50% fewer hours by day 90 |
| **Time to log an encounter** | Median of 20 timed samples: end of contact → record saved (paper + later re-keying counts in full) | Median of 20 timed samples in SUDS, on the phone or computer staff actually use | 30% lower |
| **Anonymous / community distribution captured** | Kits and strips handed out per the paper log vs. what reached the report last quarter | Same comparison from SUDS | Report matches the log within 5% |
| **Supply stock-out days** | Days any tracked item (naloxone, test strips) was out, last quarter | Days out, from SUDS stock counts | Fewer; monthly count reconciles within 5% |
| **Referral loop closure** | % of 20 recent referrals with a recorded outcome within 30 days | % of referrals in SUDS with an outcome within 30 days | ≥ 80% |
| **Data completeness** | % of 50 sampled spreadsheet rows with type, duration, outcome and funding source | Same fields in SUDS | ≥ 95% |
| **Expenditure approval cycle** | Days from purchase to approval, last 10 expenditures | Same, in SUDS | Shorter; no self-approvals |
| **Adoption** | — | Weekly active pilot users / pilot users | ≥ 90% by week 4 |
| **Staff satisfaction** | 5-question survey (1–5) on the current process at day 0 | Same survey at day 30 and 90 | Average ≥ 4 |
| **IT effort** | — | Hours the IT partner / county spent on the server, per month (install, patches, backups, drill, incidents) | Recorded — feeds [HOSTING.md](HOSTING.md) |
| **Vendor support effort** | — | Vendor hours per month, by ticket severity | Recorded — feeds [templates/PRICING.md](templates/PRICING.md) |
| **Safety / integrity** | — | Records lost, shown to the wrong person, or failed audit-chain verification | Zero (any one is a stop criterion, [docs/ADOPTION.md](../ADOPTION.md)) |

### Rules

- Write the baseline down **before** anyone sees SUDS numbers, and keep the raw timings.
- Time the same people doing the same kind of work; say if the pilot month was unusual (a surge, a new hire).
- Report misses as well as hits. A case study ([templates/CASE-STUDY-TEMPLATE.md](templates/CASE-STUDY-TEMPLATE.md))
  may quote only measured numbers from this sheet.

## 6. Exit and data-return plan

The programme (or the county, where it is the data owner) owns its data. If the pilot ends without a contract:

1. **Export**: Reports → *Everything as one Excel workbook* (identified, by a supervisor, recipient and purpose
   recorded) and per-table CSV; FHIR bulk export where enabled. The vendor confirms completeness against
   table row counts.
2. **Database and keys** stay with whoever hosted the pilot (the programme's IT partner or the county); they
   never left.
3. **Deletion** of any copy the vendor held for support: all copies, including backups, deleted within 30
   days of confirmed receipt; written certificate of deletion ([templates/DPA-DRAFT.md](templates/DPA-DRAFT.md)).
4. **Records retention**: the programme keeps what its retention rules require; SUDS's own retention clock
   continues only if the programme keeps running it (the software is open source and may be kept without a
   contract).
5. Revert to spreadsheets using the export, or migrate to another system.

## 7. Pilot evaluation template

Copy and fill at day 90.

```
PILOT EVALUATION — SUDS
Programme:                         County / CBO:
Pilot dates:                       Users (N):
Deployment: [ ] IT-partner self-hosted  [ ] county-hosted
Eligibility outcome: [ ] eligible  [ ] with hand-off  [ ] with Part 2 controls  [ ] CalOMS kept outside SUDS

METRICS                         Baseline    Day 30    Day 60    Day 90    Target    Met?
Funder report prep (hours)
Time to log an encounter (min)
Distribution captured vs log (%)
Supply stock-out days
Referral loop closure (%)
Data completeness (%)
Weekly active users (%)
Staff satisfaction (1-5)
IT hours / month
Vendor support hours / month
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
