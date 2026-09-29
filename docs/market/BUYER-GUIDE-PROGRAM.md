# SUDS buyer guide: for harm-reduction and prevention programme directors

For the director of a harm-reduction, outreach or prevention programme — usually a community-based
organisation funded by opioid-settlement money, SOR / the Naloxone Distribution Project, or SABG prevention
funds, and usually not billing Medi-Cal. (SABG primary-prevention events — group and community events with
attendance, CSAP strategy and IOM category — are recorded and summarised; SUDS does not produce a PPSDS file: see
[POSITIONING.md](POSITIONING.md), *"Prevention", precisely*.) It explains what SUDS does for outreach, supplies and funder reporting,
what a day looks like, and what we need from you. The companion guide for your IT partner or county IT is
[BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md); who runs the server is in [HOSTING.md](HOSTING.md).

**Is SUDS right for your programme?** Yes, if your work is outreach contacts, naloxone and supply
distribution and grant reporting tracked today in spreadsheets, paper logs or a shared drive — **and** you have
an IT partner (or a county sponsor) who can run a small server; SUDS is not a hosted service yet. No, if you need
a system to bill DMC, prescribe, or be your treatment medical record — keep that in your EHR
([POSITIONING.md](POSITIONING.md), *The boundary*). The decision tree in [PILOT-KIT.md](PILOT-KIT.md) settles the
grey cases (Part 2 records, CalOMS, DMC).

**If your county funds you.** The route we prefer is a county-sponsored pilot: your county funds the
implementation for you and one or two other CBOs it funds, and the vendor does the setup, import, training and
funder-report checks with your team ([PILOT-KIT.md](PILOT-KIT.md), section 8). Ask your county contract manager
whether that is possible.

**What is available, and what is planned.** The AI documentation copilot is available from 1.17.0
(below: office server only, off unless your administrator turns it on after a BAA and QSOA with the AI
provider). A county view of its grantees' outcomes, a field device scope for street outreach and a referral
network partner organisations join (beyond the 1.17.0 one-time secure links) are planned and not scheduled ([STRATEGY.md](STRATEGY.md)). Choose SUDS
for what it does today.

## What it does for the work

| Workflow | In SUDS |
| --- | --- |
| **Outreach encounters** | **+ Log** (one button, bottom-right on a phone): visit, call, text, note, to-do or time. Outreach, naloxone distribution, post-overdose follow-up, warm hand-off and the other navigation service types. A follow-up date creates a reminder; time is logged automatically. |
| **Street outreach** (1.17.0) | One phone screen for anonymous field contacts, used with one hand: the kind of contact, − count + for naloxone, test strips, syringes, wound care and your other supplies, roughly where, and a line of notes without identifiers. It saves as an anonymous visit, so the kits come off the stock and every report counts it; *My shift* counts what the worker has logged. On a phone with an offline copy it works with no signal and syncs later. A worker can make it the screen SUDS opens on. |
| **Anonymous and community work** | Outreach and naloxone distribution can be recorded with no client named, and still count in the funder report. Overdose and reversal events, including community ones. |
| **Naloxone and supplies** | Supplies kept by **item, site and lot** (1.14.0): naloxone by product, fentanyl test strips, syringes, sharps containers and whatever else you list; sites for the office, a van, a drop-in or a partner; lot numbers and expiry dates. Deliveries, moves between sites, counts and disposal are recorded in a stock ledger. Each visit or anonymous outreach contact draws the items it hands out from its site, earliest expiry first; expiring lots, low stock and shortfalls show on Home. A repeated visit copies what kind of visit it was, never the quantities. Syringes and sharps brought back are recorded too, counted or estimated from the container ([docs/SUPPLIES.md](../SUPPLIES.md)). |
| **Grants and budget** | Funding sources (opioid settlement, SOR, SABG, county…), budget lines, burn rate against time elapsed, client assistance (bus passes, IDs, motel nights) charged to the right line, staff time by funding source. |
| **Approvals** | Expenditure approval (pending → approved/rejected → reimbursed) and time approval, with separation of duties: nobody approves their own. |
| **Caseload** | For people you do follow: each worker's own clients, sorted by risk and last contact (by default navigators and clinicians can open every client, for coverage, and change only their own work — client records are shared, and the primary worker is told which fields changed when someone not on the client's care team updates one, and from 1.17.0 the record's History keeps what each field held before and after, with a way to put a change back; the programme can hold a person to their caseload — see *Who sees which clients* in [POSITIONING.md](POSITIONING.md)); Home shows overdue follow-ups, no contact in 30 days, consents expiring. Caseload transfer when someone leaves. |
| **Referrals and resources** | A community resource directory with verification dates (older than six months is flagged); referrals from pending to admitted/completed, warm hand-off, barriers, days-to-admit, automatic follow-up — and a consent check before a client is named to an outside agency. |
| **Consent and privacy** | Consents built to support 42 CFR Part 2, with every element the rule requires, releases of information, revocations, and an accounting of disclosures you can print for the participant ([docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md)). |
| **Getting data in** | Import clients, resources, visits, calls, time, to-dos and expenditures from your Excel or CSV files, with automatic column matching and row-by-row checks ([docs/IMPORTS.md](../IMPORTS.md)). |

**Optional modules, for programmes that need them.** A *programme profile* setting chooses **Harm reduction &
outreach** (the default, clinical screens hidden) or **Treatment-adjacent**. Treatment-adjacent shows the
clinical modules: structured clinical notes (SOAP/DAP/BIRP/GIRP) with signature and countersignature, problem
list, care plan, six-dimension assessment (ASAM-aligned; the ASAM Criteria are not included — your programme
needs its own ASAM licence to use them), PHQ-9 / GAD-7 / AUDIT-C and an optional DAST-10 (off until your
administrator confirms your programme holds the rights to use it) ([docs/compliance/CALAIM.md](../compliance/CALAIM.md)),
CalOMS Tx, and the county EHR hand-off. Most harm-reduction programmes will not need them.

**AI documentation copilot (optional, 1.17.0; off by default).** On an office server, staff can ask an AI
model to draft a progress note's sections from their own session notes, the six assessment dimensions from
intake notes, care plan suggestions and CalOMS answers. It drafts only: a person reviews, corrects and signs,
and signed notes record that they were AI-assisted. What it needs from you: your own **business associate
agreement with Part 2 (QSOA) terms with the AI provider**, your **counsel's review**, and the provider's usage
charges (your contract with the provider, not with SUDS). SUDS replaces the client's known identifiers before
sending, but free text can still identify someone, and drafts can be wrong — it saves documentation time, it
does not certify anything. Not available in SUDS on this device. ([docs/AI-COPILOT.md](../AI-COPILOT.md))

## Funder and grant reporting

- **Funder report**: unduplicated people served (people, not services) by fiscal period and funding source;
  demographics with race/ethnicity codes a funder can count; overdose and naloxone figures including community
  distribution. A programme manager's report opens as the programme's own *submission to your funder*, with
  exact counts, marked not for publication. For figures to be shared publicly, *Prepare a publication release*:
  every count of people under 11 is suppressed (`<11`), with complementary suppression across every table that
  shares a total, checked by an automated audit that tries to work each hidden cell out from everything the release prints (a conservative screen, not an expert determination, and not yet independently reviewed); kits, doses and money
  stay exact. Only a run for the whole programme and one month, quarter or fiscal year that has ended can be a
  publication release, labelled *small cells screened; review before sharing*: a table whose protection the
  automatic check cannot confirm is withheld and listed with the reason, and the file downloads only after the
  person confirms they reviewed the withheld and small figures; it is a conservative screen, not a guarantee or
  an expert determination. **A whole publication release can also be refused**, not a table withheld: when the
  check cannot finish within its work limit, or cannot confirm the release even with tables withheld, nothing is
  published. No size is guaranteed to publish. Until 1.16.4 most fiscal years of programmes with about 90 to 340
  overdose events were refused; since 1.17.0 a publication release gives overdose events as totals for the period
  and reversals by month, not the events by month (those stay in the exact *submission*), and in the same sweeps 4 of
  114 scaled fiscal years were refused (1.16.4: 34), none of 18 seeded years (1.16.4: 6) and 11 of their 72 quarters
  (1.16.4: 28; 3 quarters 1.16.4 published are among the 11). What decides it is your programme's own overdose
  figures (small counts of reversals by month), not how many clients it serves. A refusal is whole and safe, and
  the exact *submission* to the funder is unaffected; the year's quarters may be tried instead, each checked on its
  own (and never beside the year) ([docs/PERFORMANCE.md](../PERFORMANCE.md), *Which programmes are refused*). Two releases for nested periods (a quarter and its year) can still be subtracted from each other,
  so publish one period per funder cycle ([docs/HIPAA.md](../HIPAA.md#small-cells-in-aggregate-reports)).
  (Only the funder report, the naloxone log and the settlement report suppress small cells; the other reports
  show exact counts.)
- **Settlement outcomes** (1.17.0), for finance, supervisors and administrators: each opioid settlement fund (a
  county's, a city's and the state's share, each on its own) with what it spent beside what the programme recorded
  of the work it paid for — naloxone kits and reversals reported for naloxone spending, people served, referrals and
  people linked to treatment for treatment and recovery spending, people trained for training — by category and by
  month, with the cost per outcome where that means something. Counts of people are small-cell suppressed as in the
  funder report (finance sees `<11` too) and no cost per outcome is shown beside a hidden count; an Excel or CSV
  file and a printed page are made when someone asks for them, and nothing is sent anywhere. These are the
  programme's own figures from its own records: **not an official state report**, and the outcome each category is
  measured by is SUDS's reading, to check against your agreement.
- **Naloxone distribution log** in the style of the DHCS Naloxone Distribution Project reporting, and an
  **opioid-settlement expenditure report** by allowable-use category, also in the DHCS settlement expenditure
  layout (one row per activity, people served on the activity their services fall under) or your county's own
  template, matched without code: its columns can take kits, test strips and reversals as well, and its rows can
  be one per fund of another type, such as a block-grant (SABG) report. A **syringe services program summary**
  (participants, contacts, syringes out and back, sharps containers, naloxone by product, test strips, referrals).
  Anonymous participants are counted too (1.17.0): a contact with no client record can carry the participant code
  the person builds the same way each time, stored encrypted and counted without being printed anywhere.
- **Prevention events** (1.17.0): presentations, trainings, community events, campaigns and coalition work, each
  with its CSAP strategy, IOM population category, hours and attendance (a headcount, never names), and a
  *prevention activity summary* by strategy and IOM category with the people trained, as CSV or Excel. It is not a
  PPSDS file: the PPSDS field mapping awaits the DHCS data dictionary, so key PPSDS from the summary.
  All are built from the records above; **check each against the funder's current template** before you submit
  — templates change, and SUDS has not been certified by DHCS or any funder.
- **SUPRT-A**, for State Opioid Response (SOR) programmes: SAMHSA's client-level record (baseline, reassessment,
  annual assessment and closeout) on each client's SUPRT-A tab, with what the record already holds filled in, the
  follow-ups due and their windows, completion rates, and a file for entry into SPARS. **SUDS's items and codes
  are its reading of SAMHSA's public descriptions: verify them against the current SUPRT-A handbook and
  codebook before anything is entered in SPARS** ([docs/compliance/SUPRT.md](../compliance/SUPRT.md)).
- **Finance** runs the programme's own submissions without seeing a client: the funder report, the NDP log, the
  settlement report and its layouts, the syringe services summary and SUPRT-A completion rates, all aggregate.
- **Programme summary and monthly trends** for any date range, by calendar day in your time zone.
- **Referral outcomes**: how many warm hand-offs led to an admission, and what got in the way.
- **Excel / CSV** of every table or one workbook, de-identified (HIPAA Safe Harbor) by default: dates to the
  year, ages over 89 as 90+, three-digit ZIPs, no free text, and a random record id in place of the client code,
  new with every file. Identified exports are for supervisors, name a recipient and purpose, and are recorded as
  disclosures.
- *Treatment-adjacent profile only:* episodes of care (admissions, discharges, length of stay), outcome measures
  over time, and **CalOMS Tx** capture, validation and extract ([docs/compliance/CALOMS.md](../compliance/CALOMS.md)) —
  built, but the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until
  verified with DHCS/county.

## A day in the life

**Maria, navigator, 8:30.** Opens SUDS on her phone. Home: two follow-ups due today, one client with no contact
in 30 days, a reminder that a consent expires Friday.

**10:15, outreach at the encampment.** Hands out four naloxone kits and ten test strips; two people give no
name. She logs one outreach visit with no client — the kits come off the van's stock, oldest lot first, and will appear in the
funder report's community distribution. One person she knows asks about detox.

**10:40, referral.** On his record she checks the resource directory (the detox programme was verified last
month), confirms his consent names that programme, and makes a warm-handoff referral. SUDS sets a
follow-up for Thursday. Time is already on her time sheet under the SOR grant.

**14:00, back at the office.** Buys a bus pass for a client and records it against the SOR client-assistance
line. It waits for her supervisor's approval.

**16:30, James, supervisor.** Approves the bus pass and the week's time, reviews the
list of people waiting for a follow-up. Moves a caseload from a navigator who is leaving.

**Quarter end, the programme manager.** Chooses the quarter and the SOR funding source in the funder report.
It opens as the programme's own *submission to your funder*, with exact counts, which is what the funder asks
for; she checks the numbers and exports the workbook (marked not for publication). Only for figures that will be
shared publicly - a board pack, a county dashboard - does she use *Prepare a publication release*, which screens
small counts, lists anything withheld and asks her to confirm she has reviewed it. How long that takes compared with today's spreadsheet
reconciliation is **not yet measured**: it is the pilot's main metric, against the hours your last report
actually took ([PILOT-KIT.md](PILOT-KIT.md), section 5).

## What we need from you

| From | What | When |
| --- | --- | --- |
| **Programme manager (sponsor)** | Decide scope (which programme, which staff), own the success metrics, sign off go-live. About 2 hours a week in the pilot. | Throughout |
| **A programme lead / super-user** | Configure lists (visit types, outcomes, supplies), funding sources and budget lines; first line of help for staff. About 4 hours a week in setup, 1–2 after. | Weeks 1–4 |
| **Your current spreadsheets** | Client lists, resource lists, visit logs, supply counts, budgets — so we can import rather than retype. | Week 1 |
| **Your funder requirements** | The reports and fields each grant asks for, so we can confirm the funder report covers them. | Week 1 |
| **Consent and forms** | Your current ROI / Part 2 consent forms, reviewed by your counsel. | Before go-live |
| **Staff time for training** | 90 minutes per navigator; 2 hours per supervisor. | Week 3–4 |
| **Your IT partner (or county IT) and privacy lead** | Who runs the server ([HOSTING.md](HOSTING.md)), security review, BAA where the vendor can access records ([BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md)). | Before real client data |
| **Baseline numbers** | Hours your last monthly funder report took, how long an encounter takes to log today, supply stock-outs last quarter ([PILOT-KIT.md](PILOT-KIT.md), section 5). | Week −3 |

## Next steps

1. Read [POSITIONING.md](POSITIONING.md) and share [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md) with IT.
2. Run the eligibility check in [PILOT-KIT.md](PILOT-KIT.md).
3. Estimate value with [templates/ROI-CALCULATOR.md](templates/ROI-CALCULATOR.md).
4. Agree pilot terms ([templates/PRICING.md](templates/PRICING.md)) and a purchasing route ([PROCUREMENT.md](PROCUREMENT.md)).
