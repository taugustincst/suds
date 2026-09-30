# SUDS 90-day pilot kit

A 90-day pilot of SUDS in one harm-reduction, outreach or prevention programme — typically a CBO, sometimes
sponsored by its county — designed so that the programme, its sponsor and the vendor all finish with
**measured** evidence: did it save time, did the numbers get better, and can the people running the server
live with it. Nothing in the market pack claims a time saving until a pilot has measured one. It builds on
the county adoption plan in [docs/ADOPTION.md](../ADOPTION.md) (60-day pilot, drills, independent review) and
extends it to 90 days so a full reporting cycle — a month-end and most of a quarter — falls inside it.

Sections 1–7 describe one programme's pilot. Section 8 describes the pilot the strategy prefers
([STRATEGY.md](STRATEGY.md), *Sequencing*): a **county pilot** in which a sponsoring county funds 2–3 of its CBOs'
pilots at once and the vendor delivers them as a paid implementation service (the forward-deployed, or FDE,
model). Each CBO in it still runs sections 1–7. The county's side of it (the county's own server for the county view, the key exchange, a
3-CBO timeline, the county's measures and the documents a county asks for) is the county pilot kit,
[COUNTY-KIT.md](COUNTY-KIT.md).

## 1. Scope

| | |
| --- | --- |
| **Programme** | One non-billing programme: outreach, harm reduction, naloxone / supply distribution, prevention-funded outreach or navigation. A SABG primary-prevention provider may pilot its group and community events (recorded and summarised since 1.17.0), but SUDS produces no PPSDS file: it keeps keying PPSDS itself, from the prevention activity summary. Programme profile *Harm reduction & outreach* unless the programme needs the clinical modules. |
| **Users** | N = 5–15: navigators / outreach workers, their supervisor, a programme lead (super-user), one finance user if budgets are in scope, one administrator. |
| **Deployment** | Self-hosted by the programme's IT partner, or hosted by a sponsoring county ([HOSTING.md](HOSTING.md)). Vendor hosting is not offered. Local mode off unless a documented field need is agreed; where it is, outreach phones are **field devices** (released in 1.21.0: only the worker's own recent caseload, without contact, intake, legal or clinical details; [../PLATFORM.md](../PLATFORM.md), *Field devices*), and a harm-reduction programme may turn on *participant codes first*. |
| **Data** | The pilot group's real caseload, supplies, resources, grants and budget. Parallel run with the existing spreadsheets for the first 30 days, then SUDS as the working record if the day-30 check-in agrees. |
| **Out of scope** | DMC billing, prescribing, the treatment medical record, other programmes, integrations beyond file exports (FHIR and the EHR hand-off can be tried with county IT, not put into production, unless agreed). |
| **Length** | 90 days from go-live, plus 2–3 weeks of setup before it. |

## 2. Eligibility check

Answer before signing. The outcome decides whether the pilot proceeds, and how.

```
Q0. Is the programme's main reportable work SABG primary prevention (group or community events with
    attendance, CSAP strategy, IOM category)?
    ├─ Yes ──> ELIGIBLE, with a limit: SUDS records the events (CSAP strategy, IOM category, hours,
    │          attendance) and totals them, but produces no PPSDS file (its mapping awaits the DHCS
    │          data dictionary): keep keying PPSDS yourself, from the prevention activity summary.
    └─ No ───> go to Q1.

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
| **−1** | **Configure**: Settings (time zone, programme contact, retention), Settings → Lists (visit types, outcomes, supplies), funding sources and budget lines, users and roles, MFA. **Decide who sees which clients before any import or device sync:** with the role defaults navigators and clinicians see every client and navigators read clinical notes (SUD counseling notes are readable only by their author, the co-signer and staff who write clinical notes (clinicians, supervisors)). On a new install (1.17.0) *New navigators and clinicians start held to their caseload* is already on (Settings → Users & permissions): each navigator and clinician account created from then on is held to their caseload. On an office upgraded from 1.16.x it is off: turn it on, and use *Apply to existing navigators and clinicians* (it lists who changes first). For anyone else who should see only their own caseload, deny *See every client* (`clients:all`); to let a held person see every client, revoke their deny; for each navigator who should not read clinical notes, deny *Read clinical notes* (`notes:clinical:read`) — Settings → Users & permissions → Permissions, with a reason. Assign each person's clients (care team) so the scoped ones still see theirs. If local mode is on, set these denies before anyone's device first syncs: a device holds whatever its user may see. **Import** from spreadsheets with Import → *Import a spreadsheet or EHR export* (clients, resources, visits, time, expenditures), templates and row checks ([docs/USER_GUIDE.md](../USER_GUIDE.md)). Load the starter resource directory if in region. Restore drill on a separate machine. | Denies recorded (or "everyone sees every client" agreed with the privacy lead); imported data spot-checked by the super-user; restore drill timed |
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

### Copilot arm (only where the agreement is recorded)

Only for a pilot on an office server whose programme has recorded its BAA with Part 2 QSOA terms with the AI
provider, and counsel's review, under Settings → **AI copilot** ([../AI-COPILOT.md](../AI-COPILOT.md)). Never on
SUDS on this device, and never for SUD counseling notes (the draft route refuses one). No time saving is claimed for
the copilot until this arm measures it. SUDS has no copilot report: the figures come from what it already keeps, which
the pilot lead extracts (or the IT partner, from the database) and the vendor does not.

| Metric | How, from what SUDS already records | Target (agree before go-live) |
| --- | --- | --- |
| **Time from contact to signed note, with vs without the copilot** | For signed notes in the period: `notes.signed_at` minus `notes.occurred_at` (the contact's date and time as the author entered it), split by `notes.ai_assisted` (1 = some text was drafted by the copilot and kept). Compare medians for the same staff and note kinds, and against the same measure before the copilot was switched on. Notes signed days later for reasons unrelated to writing (leave, a co-signature) are read with that in mind. Elapsed time is not effort: where the pilot can, also time the writing of 20 notes with and 20 without, as the encounter timing above is done | Recorded; a target only once a baseline exists |
| **Drafts that became notes vs discarded** | Drafts asked for: `ai.draft` audit entries with `feature` `note` and `outcome` `ok` (or `ai_usage` rows, which hold no client). Kept: signed notes with `ai_assisted` = 1 in the same period. The difference approximates drafts discarded; a note drafted more than once counts once as kept | Recorded |
| **Drafts kept as written vs edited** | **Not recorded by SUDS**: a draft's text is never stored, so no field says how much the author changed. Use a sample instead: the author ticks one of *kept as drafted*, *minor edits*, *major edits*, *discarded* on a paper or spreadsheet log for 20 consecutive drafts, at day 30 and day 90, with no client detail on the log | Share discarded or majorly edited reported, not hidden |
| **Model cost** | `ai_usage` input and output tokens for the period × the provider's price per million tokens, against the provider's invoice ([templates/ROI-CALCULATOR.md](templates/ROI-CALCULATOR.md), *AI copilot*) | Within the monthly cap |
| **Outbound review** | A supervisor's review of a sample of copilot calls: the `ai.draft` audit entries (who, client, feature, identifiers replaced; never the text) and, with counsel, whether anything identifying remained in what staff typed | Zero incidents |

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

## 8. County pilot with the FDE service

The county holds the money and needs outcome evidence from the CBOs it funds; the CBOs need implementation
capacity more than software. A county pilot puts both in one engagement. It is a proposal structure, not an
offer: the prices are [owner to decide] ([PRICING-OPTIONS.md](PRICING-OPTIONS.md)), and every organisational item in
the [readiness scorecard](README.md#organisational-gaps-owner-vendor--company) that a county will ask about
(entity, insurance, counsel-reviewed BAA/QSOA and DPA, pen test, repository controls in force) should be done
before it is proposed.

### Shape

| | |
| --- | --- |
| **Sponsor** | A county behavioural-health or public-health department that funds harm-reduction or outreach CBOs (settlement, SOR / NDP, SABG prevention-funded outreach) |
| **CBOs** | 2–3, each passing the eligibility check (section 2) on its own; at least one with a settlement-funded programme |
| **Hosting** | County-hosted (one server per CBO, on county infrastructure) or each CBO's IT partner. Vendor hosting is not offered |
| **Length** | 2–4 weeks of county discovery, then each CBO's 90-day pilot, staggered by 2–4 weeks so the vendor is not deploying three at once |
| **Paid work (FDE packages)** | Discovery (county and each CBO), deployment, data migration, training, reporting setup against each funder's template, county programme management ([PRICING-OPTIONS.md](PRICING-OPTIONS.md), model D) |
| **Out of scope** | Everything section 1 excludes; the AI copilot (1.17.0) for any CBO that has not recorded its BAA and Part 2 QSOA with the AI provider under Settings → AI copilot, after county counsel has reviewed its data flow (where a CBO has, the copilot is in scope for that CBO and section 5's copilot arm applies; never for SUD counseling notes, never on SUDS on this device); secure referral links (1.17.0; off by default) unless counsel has reviewed the link design as built and the pilot server is reachable from the internet; pooled benchmarks across CBOs, which are not built; the county view (released in 1.18.0) is in scope only on a build that has it |

### What the county gets

- Its CBOs' funder submissions for the pilot period produced from SUDS: exact aggregate counts, no client-level
  data, as its funding contracts already provide for.
- On a build with the county view (released in 1.18.0; [../COUNTY-VIEW.md](../COUNTY-VIEW.md)): those
  figures as **quarterly signed files**, one per CBO per quarter, made for the county (its county code) from only
  the settlement funds the county pays for, and imported into the county's own SUDS server, where they are
  combined per CBO, in total and by quarter. The county's server holds no client data (a county-only install).
- Its grantees that are **not** in the pilot and do not run SUDS in the same view (released in 1.20.0;
  [../COUNTY-VIEW.md](../COUNTY-VIEW.md), *County-entered figures*): county staff enter or import their figures from
  the reports they already send, marked *entered by the county — not signed by the program* everywhere, outranked by
  a signed file when a CBO starts sending them, and possible to leave out of any view or file. What the county may
  enter is for the data contribution agreement ([templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md](templates/DATA-CONTRIBUTION-AGREEMENT-DRAFT.md), section 8).
- From 1.21.0: each fund's **award amount** in the CBOs' files (spending against the award; the county's server is
  upgraded first), **reminders** on each CBO's Home when its county file is due, and, if the county wants to share
  figures, a screened **publication release** of the combined figures (County view › Publish;
  [../COUNTY-VIEW.md](../COUNTY-VIEW.md), *Publication*), recorded and never changed. The pilot agrees whether any
  release is published, and at what threshold (at least the highest its CBOs publish with).
- One security and privacy review covering every CBO's instance ([BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md)).
- A measured answer to "does this reduce our grantees' reporting burden and improve what we receive?"
- The information it needs to decide whether to act as data steward for pooled outcomes later
  ([DATA-NETWORK.md](DATA-NETWORK.md)); no data is pooled in the pilot.

### Additional roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| **County sponsor** | County SUD / behavioural-health programme manager | Chooses the CBOs, owns the county's success measures, signs the county decision |
| **County IT and privacy** | County IT security and the county privacy officer | One review for all instances; BAA/QSOA and DPA; the restore drill where the county hosts |
| **Vendor FDE lead** | Vendor | Delivers the packages; keeps the time log that measures implementation hours per CBO |

### Key exchange at kickoff (county view)

The full county package (what the county runs, data flows, timeline, the RFI answers and a draft data
contribution agreement) is [COUNTY-KIT.md](COUNTY-KIT.md).

At each CBO's kickoff meeting, where the county view is in scope: the county reads its **county code** from County
view › Programs and the CBO types it on Settlement outcomes › Send to the county; the CBO shows its key (**Show the
key for the county**), emails the public key, and **reads the fingerprint out** while the county registers the CBO
and types it (or ticks that it compared it). The CBO ticks the funds the county pays for. From then on the CBO makes
its file after each quarter ends and sends it the way the county asks; the county imports it. A lost or exposed key:
the CBO makes a new one and reads the new fingerprint out; the county replaces the key (and marks the old one
compromised if its files should stop counting).

### County measures (in addition to each CBO's section 5)

| Measure | How | Target (agree before starting) |
| --- | --- | --- |
| Funder submissions from SUDS accepted by the county without rework | Count per CBO per reporting period | Every CBO, at least one period |
| Quarterly county files received and imported on time (county view builds) | County view › Submissions: a *Current* file per CBO per quarter; the headline for the quarter | Every CBO, every pilot quarter, within the time the contract sets |
| County staff hours to combine its CBOs' figures (county view builds) | The same method as the compile-hours baseline, with the combined view and its Excel | Recorded; compared with the baseline |
| Grantees not on SUDS in the combined view (1.20.0) | County view › Submissions: entries marked *entered by the county*, each with its source document; how long an entry takes | Recorded; every non-pilot grantee the county chooses to include, with a named source document per period |
| County files made on time after a reminder (1.21.0) | Each CBO's county reporting schedule, and County view › Submissions | Every CBO, every pilot quarter, by the date the county sets |
| County staff hours to compile its grantees' figures | Baseline from the last period; same method in the pilot | Recorded; target agreed with the county |
| Settlement spending recorded with an allowable use | Settlement report, per CBO | All settlement spending categorised |
| Implementation hours per CBO against the estimate | Vendor time log | Recorded — feeds [PRICING-OPTIONS.md](PRICING-OPTIONS.md) |
| Support hours per CBO per month | Ticket log | Recorded |
| Integrity incidents | As section 5 | Zero |

### Decision at the end

The county decides whether to continue (a county agreement covering its CBOs, [PRICING-OPTIONS.md](PRICING-OPTIONS.md)
model C), extend, or stop. Each CBO decides for itself as in section 6: its data stays with whoever hosted it, and
the software stays free to keep.
