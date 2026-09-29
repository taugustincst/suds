# First-meeting walkthrough (20 minutes)

Two paths through SUDS for a first meeting, on the fictional sample data: one for a **CBO director**, one for a
**county funder**. Each is about 20 minutes, leaves time for questions, and shows only what is released (1.17.0).
It is a walkthrough of the real product with made-up records, not a special build: the product shows no banner or
special mode for it, and nothing here should be presented as a trial edition.

**Rules for the presenter** (the pack's rules apply, [README.md](README.md), *Rules for anyone using this pack*):

- Use only the sample data. Never open a real programme's records in a meeting, and never type a real person's
  details into a walkthrough server.
- Claim no time saving: no pilot has measured one. Say "the pilot measures this" ([PILOT-KIT.md](PILOT-KIT.md), section 5).
- Say "each layout is to be checked against the funder's current template" whenever a report is on screen.
- Planned capabilities (the county funder view across CBOs, the referral network, the outcomes dataset, a field
  device scope) are named as planned, never shown as mock-ups.

## Before the meeting (15 minutes, once)

1. **A walkthrough server.** An office server on a laptop or a staging machine, never one holding real records:
   `npm run seed && npm start` (the development seed: fictional staff and clients, and the treatment-adjacent
   profile so State reporting is present), or a fresh install where an administrator chooses **Load sample data**
   on the empty Home screen or under Settings. The seed's logins (password `Navigator2026!!`): `mrivera` and
   `dchen` (navigators), `kpatel` (clinician), `jwalker` (supervisor), `afinance` (finance), `rreader` (read-only).
2. **What the sample data holds** ([server/demo.js](../../server/demo.js)): 12 fictional clients (client codes
   `DEMO-…`) with visits, calls, notes, referrals, consents and to-dos; a resource directory; supplies in lots at
   the main office; an opioid settlement fund with its Exhibit E category and High Impact Abatement Activity, a SOR
   grant, and expenditures, some tagged with their own settlement category; about thirty anonymous street-outreach
   contacts over the last ten weeks, most with an encrypted SSP participant code; seven group and community
   prevention events; and CalOMS Tx records for three episodes (no provider ID yet, so they appear on the worklist
   once CalOMS reporting is on).
3. **Settings to prepare for the funder path:** as the administrator, open **State reporting** and, in its
   settings, switch CalOMS reporting on and enter a provider ID (any six digits for the walkthrough). On a fresh
   install in the *Harm reduction & outreach* profile, first switch the CalOMS module on under Settings › Program ›
   Modules. Leave the AI copilot and secure
   referral links **off**: the walkthrough shows their gates, not a live call.
4. Open two browser windows: a desktop window, and a phone-sized one (the browser's device toolbar at 390 px)
   signed in as `mrivera`.

## Path 1: CBO director (20 minutes)

What they need to leave with: their outreach counts without a spreadsheet, their supplies reconcile, their funder
report comes from the same records, and client privacy is designed in.

| Minutes | Show | Say |
| --- | --- | --- |
| 0–2 | Home as `jwalker`: what needs attention, expiring stock, the team's activity | "This is a programme record for outreach and harm reduction, beside an EHR or without one. It is not an EHR and does not bill." |
| 2–6 | Phone window as `mrivera`: **+ Log → Street outreach contact**. Tap two naloxone kits and three test strips, choose *Shelter*, save. Show **My shift** count the contact | "An anonymous contact still counts. Nothing asks who the person is; the notes line says to leave identifiers out. On a device the programme allows, this works with no connection and syncs later." |
| 6–8 | The next contact with a participant code: the optional code field on the same screen (also under *Participant code (optional)* in **Visits → + Log a visit** for an outreach contact with no client) | "The participant builds the code the same way each time. SUDS stores it encrypted and counts it by a blind index; no report or file prints it." |
| 8–11 | Desktop as `jwalker`: **Supplies**: stock by site and lot, the expiring lot, then the **SSP report** tab for the last three months: anonymous participants counted from codes, beside the clients served, never added to them | "Stock comes off first-expiry-first-out when a contact is logged. The SSP summary is one of the layouts to check against your funder's current template." |
| 11–14 | **Funder report** for the last quarter: people served, kits, the NDP log, the settlement report by allowable use; switch between *exact, for your own submission* and *screened for publication* | "Your submission to your funder uses exact counts. Anything published is screened for small cells first." |
| 14–17 | A client (`DEMO-0001`): the timeline, a consent that names the recipient, **Privacy & Part 2** → the accounting of disclosures | "Part 2 is built in: consent names who may receive what, there is one disclosure gate, and every disclosure is in the accounting. Every read and change is in a tamper-evident audit log." |
| 17–20 | Settings → **AI copilot** (as administrator): the agreement form and the switch it unlocks. Do not record an agreement | "An optional copilot drafts notes for a person to review and sign. It runs only on an office server, stays off until you record your BAA and Part 2 QSOA with the AI provider, is never used for SUD counseling notes, and your counsel reviews it first. The pilot measures whether it saves time." |

## Path 2: county funder (20 minutes)

What they need to leave with: grantees' figures arrive consistently and exactly, settlement spending is
categorised and tied to outcomes, and the county's privacy and IT reviewers have evidence to read.

| Minutes | Show | Say |
| --- | --- | --- |
| 0–2 | The evidence index ([../evidence/README.md](../evidence/README.md)) and the one-page positioning ([POSITIONING.md](POSITIONING.md)) | "Open source, runs on your or your grantee's server, no vendor hosting today. Here is what exists and what does not, including no independent audit yet." |
| 2–7 | As `afinance`: **Settlement outcomes**: the settlement fund's card, spending by Exhibit E category beside the outcomes recorded for it, the cost per outcome, counts of people shown as `<11` by default; download the Excel | "Each fund on its own, a county's share and the state's share kept apart. Small counts of people are hidden, and no cost per outcome appears beside a hidden count. It is not a state reporting system; your template is the authority." |
| 7–10 | **Funding & spending** → an expenditure with its own settlement category and High Impact Abatement Activity; then **Funder report** → the settlement report and the DHCS layout | "Spending carries the allowable use when it differs from the fund's. The layouts are to be checked against the current DHCS and county templates." |
| 10–13 | **Prevention** as `jwalker`: the events, then the summary for the last three months by CSAP strategy and IOM category, people trained | "Group and community prevention is recorded with its strategy, IOM category, hours and attendance. It is not a PPSDS file: that mapping waits for the DHCS data dictionary." |
| 13–17 | **State reporting** as administrator: the CalOMS worklist (the sample records ask for their provider ID), *Check and prepare (not sent)*, and the submission log | "SUDS checks and prepares the CalOMS Tx file each month; nothing is disclosed until someone with the right permission produces it, and SUDS never submits to DHCS. The layout is still to verify against the DHCS data dictionary." |
| 17–20 | Where SUDS sits: next to SmartCare or another EHR (*Where it sits next to an EHR*), the FHIR import from an EHR export, secure referral links (off by default, counsel reviews them first), and the county pilot shape ([PILOT-KIT.md](PILOT-KIT.md), section 8) | "A funder-facing view across the CBOs you fund is planned, not built. A county pilot runs two or three CBOs for 90 days and measures reporting hours." |

## After the meeting

- Send the buyer guide that fits ([BUYER-GUIDE-PROGRAM.md](BUYER-GUIDE-PROGRAM.md) or
  [BUYER-GUIDE-IT.md](BUYER-GUIDE-IT.md)) and, for a funder, the pilot kit.
- Remove the sample data (Settings → **Remove sample data**) or discard the walkthrough server. Never turn a
  walkthrough server into a programme's production server.
- Record the questions you could not answer; they belong in the owner's pipeline notes, not in a promise.
