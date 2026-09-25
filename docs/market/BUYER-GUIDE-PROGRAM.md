# SUDS buyer guide: for SUD programme managers

For the manager of a county or CBO programme doing navigation, outreach, harm reduction, prevention or supply
distribution — usually grant-funded, usually not billing Medi-Cal. It explains what SUDS does for the work, what
a day looks like, what you get for your funders, and what we need from you. The companion guide for your IT
team is [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md).

**Is SUDS right for your programme?** Yes, if most of your work is non-billable services tracked today in
spreadsheets, paper logs or a shared drive. No, if you need a system to bill DMC, prescribe, or be your
treatment medical record — keep that in your EHR ([POSITIONING.md](POSITIONING.md), *The boundary*). The
decision tree in [PILOT-KIT.md](PILOT-KIT.md) settles the grey cases (Part 2 records, CalOMS, DMC).

## What it does for the work

| Workflow | In SUDS |
| --- | --- |
| **Caseload** | Each navigator sees their own clients, sorted by risk and last contact; supervisors see everyone. Home shows what needs attention today: overdue follow-ups, unsigned notes, no contact in 30 days, consents expiring. Waitlist ordered by real wait time; caseload transfer when someone leaves. |
| **Logging a visit** | **+ Log** (one button, bottom-right on a phone): visit, call, text, note, reminder or time. 25 navigation service types (outreach, SBIRT, warm handoff, naloxone distribution, post-overdose follow-up…). A follow-up date creates a reminder; time is logged automatically. |
| **Anonymous and community work** | Outreach and naloxone distribution can be recorded with no client named, and still count in the funder report. Overdose and reversal events, including community ones. |
| **Supplies** | A supply cupboard (naloxone kits, fentanyl test strips and other items) that each visit draws down; stock counts on the office server. |
| **Resources** | A community resource directory with verification dates (older than six months is flagged), treatment programme profiles, how to refer, pictures. A one-click starter directory (81 programmes in the eight Sacramento-area counties) to begin from. |
| **Referrals** | Status pipeline from pending to admitted/completed, warm handoff, urgency, barriers, days-to-admit, automatic follow-up — and a consent check before a client is named to an outside agency. |
| **Grants and budget** | Funding sources (opioid settlement, SOR, SAMHSA, county…), budget lines, burn rate against time elapsed, client assistance (bus passes, IDs, motel nights) charged to the right line, staff time by funding source. |
| **Approvals** | Expenditure approval (pending → approved/rejected → reimbursed) and time approval, with separation of duties: nobody approves their own. Supervisor countersignature on notes. |
| **Documentation** | Administrative and clinical notes (SOAP/DAP/BIRP/GIRP), sign-and-lock, addenda; your own county forms, pre-filled and saved with the client. Clinical depth for programmes that need it — problem list, care plan, six-dimension assessment (ASAM-aligned; the ASAM Criteria are not included — your programme needs its own ASAM licence to use them), PHQ-9 / GAD-7 / AUDIT-C outcome measures and an optional DAST-10 (off until your administrator confirms your programme holds the rights to use it) ([docs/compliance/CALAIM.md](../compliance/CALAIM.md)). |
| **Consent and Part 2** | Part 2 consents with every required element, releases of information, revocations, and an accounting of disclosures you can print for the client ([docs/HIPAA.md](../HIPAA.md), [docs/compliance/PART2.md](../compliance/PART2.md)). |
| **Getting data in** | Import clients, resources, visits, calls, time, to-dos and expenditures from your existing Excel or CSV files, with automatic column matching and row-by-row checks; import field notes from Pocket AI or OneNote ([docs/IMPORTS.md](../IMPORTS.md)). |

## Outcomes and grant reporting

- **Funder report**: unduplicated people served (people, not services) by fiscal period and funding source;
  admissions, discharges and median length of stay; demographics with race/ethnicity codes a funder can count;
  overdose and naloxone figures including community distribution. Breakdown rows counting fewer than 11 people
  are suppressed (`<11`) while totals stay exact. (Only the funder report suppresses small cells; the other
  reports show exact counts.)
- **Programme summary and monthly trends** for any date range, by calendar day in your time zone.
- **Episodes of care**: admissions and discharges by reason.
- **Referral outcomes**: how many warm handoffs led to an admission, and what got in the way.
- **Outcome measures** (PHQ-9, GAD-7, AUDIT-C, and the DAST-10 where enabled) over time, where your programme collects them.
- **CalOMS Tx** capture, validation and extract, where your programme is required to report it
  ([docs/compliance/CALOMS.md](../compliance/CALOMS.md)). Built, but the layout and code sets are NOT verified against the DHCS data dictionary; do not submit until verified with DHCS/county.
- **Excel / CSV** of every table or one workbook, de-identified (HIPAA Safe Harbor) by default: dates to the
  year, ages over 89 as 90+, three-digit ZIPs, no free text, and a random record id in place of the client code,
  new with every file. Identified exports are for supervisors, name a recipient and purpose, and are recorded as
  disclosures.

## A day in the life

**Maria, navigator, 8:30.** Opens SUDS on her phone. Home: two follow-ups due today, one client with no contact
in 30 days, a reminder that a consent expires Friday.

**10:15, outreach at the encampment.** Hands out four naloxone kits and ten test strips; two people give no
name. She logs one outreach visit with no client — the kits come off the cupboard count and will appear in the
funder report's community distribution. One person she knows asks about detox.

**10:40, referral.** On his record she checks the resource directory (the detox programme was verified last
month), confirms his Part 2 consent names that programme, and makes a warm-handoff referral. SUDS sets a
follow-up for Thursday. Time is already on her time sheet under the SOR grant.

**14:00, back at the office.** Buys a bus pass for a client and records it against the SOR client-assistance
line. It waits for her supervisor's approval.

**16:30, James, supervisor.** Approves the bus pass and the week's time, countersigns two notes, reviews the
waitlist. Moves a caseload from a navigator who is leaving.

**Quarter end, the programme manager.** Chooses the quarter and the SOR funding source in the funder report,
checks the numbers and exports the workbook. What took two days of spreadsheet reconciliation takes an hour of
checking.

## What we need from you

| From | What | When |
| --- | --- | --- |
| **Programme manager (sponsor)** | Decide scope (which programme, which staff), own the success metrics, sign off go-live. About 2 hours a week in the pilot. | Throughout |
| **A programme lead / super-user** | Configure lists (visit types, outcomes, supplies), funding sources and budget lines; first line of help for staff. About 4 hours a week in setup, 1–2 after. | Weeks 1–4 |
| **Your current spreadsheets** | Client lists, resource lists, visit logs, supply counts, budgets — so we can import rather than retype. | Week 1 |
| **Your funder requirements** | The reports and fields each grant asks for, so we can confirm the funder report covers them. | Week 1 |
| **Consent and forms** | Your current ROI / Part 2 consent forms, reviewed by your counsel. | Before go-live |
| **Staff time for training** | 90 minutes per navigator; 2 hours per supervisor. | Week 3–4 |
| **Your IT and privacy officer** | Hosting decision, security review, BAA ([BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md)). | Before real client data |
| **Baseline numbers** | How long a visit takes to log today, how long grant reports take, stock-outs last quarter ([PILOT-KIT.md](PILOT-KIT.md)). | Week 0 |

## Next steps

1. Read [POSITIONING.md](POSITIONING.md) and share [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md) with IT.
2. Run the eligibility check in [PILOT-KIT.md](PILOT-KIT.md).
3. Estimate value with [templates/ROI-CALCULATOR.md](templates/ROI-CALCULATOR.md).
4. Agree pilot terms ([templates/PRICING.md](templates/PRICING.md)) and a purchasing route ([PROCUREMENT.md](PROCUREMENT.md)).
