# SUDS user guide (navigators, clinicians, supervisors)

## The three things to know
1. **Home** shows what needs attention today and where you left off — on any device.
2. **+ Log** (blue button; bottom-right on a phone) records a visit, call, note, reminder or time.
3. The **search box** at the top finds a client by last name, phone or code. Open a client to see their whole story.

Every page has a **?** that explains it in plain language. Records are never truly deleted, so you cannot break anything.

## Phone, tablet and computer stay in sync
Use SUDS wherever you are: on the office computer, or in the browser on your phone or tablet at **https://suds.local** (office Wi-Fi). There is no app to install: open the address, sign in, and add it to your home screen once — iPhone: Safari **Share → Add to Home Screen**; Android: browser menu **⋮ → Install app**. The `/app` page (**https://suds.local/app**) shows these steps. Your clients, notes, reminders and even half-written note drafts are the same everywhere, because every device talks to the same office SUDS.

SUDS needs a connection to the office. Without one, a banner says so and nothing can be saved until you reconnect. If your programme has approved an offline copy for field work (local mode), your administrator will set it up with you; the office SUDS is always the master copy, and anything it refuses on sync is final.

## Signing in
Use your individual username. After 5 wrong passwords the account locks for 15 minutes. You are signed out automatically after 15 minutes without activity — a banner warns you one minute before. Supervisors and administrators must enroll an authenticator app (Profile → Multi-factor authentication → scan the QR code).

## Dashboard
Shows alerts (overdue tasks, unsigned notes, imported notes waiting for review, clients with no intervention in 30 days, consents expiring, open patient-rights requests and how many are past their 30-day deadline), your caseload sorted by risk and last contact, and 90-day activity charts. The same open-requests count appears on the Supervision page.

## Clients
* **Search** matches exact last name, "Last, First", phone number, date of birth (YYYY-MM-DD) or client code. Names are encrypted, so partial-name search is not available.
* **New client** — enter what you know; only first and last name are required. Set status *waitlist* if not yet enrolled.
* The client page has tabs: Overview, Timeline (everything in date order), Interventions, Calls, Notes, Referrals, Tasks, Consents & ROI, Time, Assistance $ and Care team.
* **Safety flags** (e.g. "no home visits alone") appear as a red badge on every page for that client.
* **Status and episodes.** Starting an episode of care makes the client *active* (including someone taken off the waitlist). While an episode is open, *Closed* and *Deceased* cannot be chosen on the Edit form: discharge on the Episodes tab instead — that closes the episode, ends the care team and clears open to-dos. The discharge dialog has no default reason; choose one.
* **After a discharge**, a navigator whose only link to the client was their assignment loses access to the record the next day (the discharge ends every assignment). If you need to look back at a discharged client — to answer a records request, or when they return — ask a supervisor to assign you again, or to look it up for you. Supervisors and administrators see every record.
* **Duplicates.** Merge a duplicate from the Care team tab. The record merged away is kept, marked as merged, and an old link to it opens the record it was merged into. A record on **legal hold** cannot be merged, in either direction, until an administrator clears the hold.
* **Legal hold** can only be placed or cleared by an administrator (it usually comes from counsel). A supervisor who needs one placed should ask the administrator; the hold, its reason and who set it are in the audit log.
* **Contact details** are checked when saved: a date of birth cannot be in the future or before 1900, an email must look like one, and a phone number needs at least seven digits.

## Logging work
* **+ Intervention** — the core service record. Pick the type (outreach, SBIRT screening, warm handoff, naloxone distribution, post-overdose follow-up…), duration, location, outcome. Enter naloxone kits / fentanyl strips given — they roll up into reports and update the client's naloxone status. Set a follow-up date to create a task automatically. Leave *Also log as time entry* checked so your time sheet fills itself.
* **+ Call** — inbound/outbound, who, duration, outcome (reached, voicemail…), crisis flag, encrypted summary, follow-up.
* **Time tracking** — non-client time (documentation, travel, meetings, training) is logged here; choose the funding source when the grant requires effort reporting.
* **Tasks & follow-ups** — your to-do list; mark milestones (★) to show them on the client timeline.

## Referrals and resources
The **Resource Directory** holds treatment providers, MAT clinics, shelters, harm reduction, legal aid, transport, etc. Keep *Last verified* current (entries older than 6 months are flagged). Create a **referral** from the client's Referrals tab, link the **consent / ROI** that authorizes sharing, then update the status as it moves: pending → contacted → accepted/waitlisted → scheduled → admitted → completed. Record barriers so the program can report on them.

## Notes
* **Administrative / contact notes** — visible to the whole care team; use for contacts, coordination, logistics.
* **Clinical notes** — only clinicians and supervisors can write or read them; use SOAP/DAP/BIRP/GIRP formats (sections auto-build the narrative).
* Notes are saved as **drafts**. **Sign & lock** (re-enter your password) when complete. Signed notes cannot be edited or deleted; add an **addendum** for corrections or late entries.
* Do not put names or other identifiers in intervention *summary* fields — they are not encrypted. Use notes for anything sensitive.

## Consents & ROI (42 CFR Part 2)
Before sharing SUD information with a provider, family member or agency, record a **consent** naming the recipient, purpose, information covered and expiration. Every time information is shared, record a **disclosure** (who, what, why, how, on what basis). Revoke consents when the client withdraws them.

## Budget
Record client assistance (bus passes, IDs, motel nights, phone minutes…) against the correct funding source and budget line; attach the client so per-client spending is visible. A supervisor or finance staff approves; you cannot approve your own entries.

## Importing notes
See *Import Notes* in the sidebar and [docs/IMPORTS.md](IMPORTS.md).

## Reports and Excel
Choose a date range for program summaries and monthly trends. **Export to Excel** (or CSV) is available on Reports (every table, or everything as one workbook) and on the Clients, Resources, Visits, Calls, Time, Referrals and Budget pages. Exports use client codes rather than names; supervisors can produce an identified workbook, which is recorded in the audit log.

## Importing spreadsheets
Import → *Import from Excel or CSV*. Choose what you are importing (clients, resources, visits, calls, time, to-dos, expenditures), download the template or upload the spreadsheet you already keep. SUDS matches your column names automatically (you can adjust them), checks every row, tells you exactly what is wrong with any row, flags people who already exist, and only saves when you click Import. For visits, calls and other client records, refer to the client by code (C26-0012) or "Last, First".

## Privacy reminders
* Only look up clients you are serving. Every record view is logged.
* Lock your screen when you step away.
* Never email PHI; use the system or approved secure channels.
