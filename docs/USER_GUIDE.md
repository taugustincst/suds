# SUDS user guide (navigators, clinicians, supervisors)

## Signing in
Use your individual username. After 5 wrong passwords the account locks for 15 minutes. You are signed out automatically after 15 minutes without activity — a banner warns you one minute before. Supervisors and administrators must enroll an authenticator app (Profile → Multi-factor authentication → scan the QR code).

## Dashboard
Shows alerts (overdue tasks, unsigned notes, imported notes waiting for review, clients with no intervention in 30 days, consents expiring), your caseload sorted by risk and last contact, and 90-day activity charts.

## Clients
* **Search** matches exact last name, "Last, First", phone number, date of birth (YYYY-MM-DD) or client code. Names are encrypted, so partial-name search is not available.
* **New client** — enter what you know; only first and last name are required. Set status *waitlist* if not yet enrolled.
* The client page has tabs: Overview, Timeline (everything in date order), Interventions, Calls, Notes, Referrals, Tasks, Consents & ROI, Time, Assistance $ and Care team.
* **Safety flags** (e.g. "no home visits alone") appear as a red badge on every page for that client.

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

## Reports
Choose a date range for program summaries, monthly trends and CSV exports. Exports use client codes rather than names.

## Privacy reminders
* Only look up clients you are serving. Every record view is logged.
* Lock your screen when you step away.
* Never email PHI; use the system or approved secure channels.
