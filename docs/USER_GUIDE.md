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
* **Search** matches exact last name, "Last, First", phone number, date of birth (YYYY-MM-DD) or client code, plus the first few letters of a surname and (for names in the Latin alphabet) close misspellings. Names in any script work — Arabic, Cyrillic, Chinese and so on — and accents do not matter: *Oster* finds *Øster*, *Lecki* finds *Łecki*, *Jose* finds *José*.
* **New client** — enter what you know; only first and last name are required. Set status *waitlist* if not yet enrolled.
* The client page has tabs: Overview, Timeline (everything in date order), Interventions, Calls, Notes, Referrals, Forms, Tasks, Episodes, Consents & ROI, Requests, Time, Assistance $ (for roles that see the budget) and Care team.
* **Requests** records patient-rights requests (access, amendment, restriction, accounting of disclosures), each due 30 days after it was received. Mark one *Fulfilled* or *Denied* when answered; **Edit** corrects its kind, dates or notes (or reopens it); **Delete** is only for a request recorded in error — a request you are refusing is marked *Denied* so it stays on file. Edits and deletions are in the audit log.
* **Safety flags** (e.g. "no home visits alone") appear as a red badge on every page for that client.
* **Status and episodes.** Starting an episode of care makes the client *active* (including someone taken off the waitlist). While an episode is open, *Closed* and *Deceased* cannot be chosen on the Edit form: discharge on the Episodes tab instead — that closes the episode, ends the care team and clears open to-dos. The discharge dialog has no default reason; choose one.
* **After a discharge**, a navigator whose only link to the client was their assignment loses access to the record the next day (the discharge ends every assignment). If you need to look back at a discharged client — to answer a records request, or when they return — ask a supervisor to assign you again, or to look it up for you. Supervisors and administrators see every record.
* **Duplicates.** Merge a duplicate from the Care team tab. The record merged away is kept, marked as merged, and an old link to it opens the record it was merged into. A record on **legal hold** cannot be merged, in either direction, until an administrator clears the hold.
* **Legal hold** can only be placed or cleared by an administrator (it usually comes from counsel). A supervisor who needs one placed should ask the administrator; the hold, its reason and who set it are in the audit log.
* **Contact details** are checked when saved: a date of birth cannot be in the future or before 1900, an email must look like one, and a phone number needs at least seven digits.

## Logging work
* **+ Intervention** — the core service record. Pick the type (outreach, SBIRT screening, warm handoff, naloxone distribution, post-overdose follow-up…), duration, location, outcome. Enter naloxone kits / fentanyl strips given — they roll up into reports and update the client's naloxone status. Set a follow-up date to create a task automatically. *Client* is optional for **outreach** and **naloxone distribution** (a kit handed to someone who gives no name counts in the funder report's community distribution); every other type needs the client. Leave *Also log as time entry* checked so your time sheet fills itself.
* **+ Call** — inbound/outbound, who, duration, outcome (reached, voicemail…), crisis flag, encrypted summary, follow-up.
* **Overdose & reversals** (sidebar) — record every overdose and naloxone reversal, including community ones with no client. Recording a **fatal** overdose for a client discharges them as deceased: after you confirm, their open episode is closed with the reason *deceased*, the care team ends and open to-dos are cancelled. If that was a mistake, change the outcome or **Delete** the event (in the event's dialog): the client goes back to the status they had, the episode is reopened, and the care team and to-dos are restored.
* **Time tracking** — non-client time (documentation, travel, meetings, training) is logged here; choose the funding source when the grant requires effort reporting.
* **Tasks & follow-ups** — your to-do list; mark milestones (★) to show them on the client timeline.

## Referrals and resources
The **Resource Directory** holds treatment providers, MAT clinics, shelters, harm reduction, legal aid, transport, etc. Keep *Last verified* current (entries older than 6 months are flagged). Create a **referral** from the client's Referrals tab, link the **consent / ROI** that authorizes sharing, then update the status as it moves: pending → contacted → accepted/waitlisted → scheduled → admitted → completed. Record barriers so the program can report on them.

## Notes
* **Administrative / contact notes** — visible to the whole care team; use for contacts, coordination, logistics.
* **Clinical notes** — only clinicians and supervisors can write or read them; use SOAP/DAP/BIRP/GIRP formats (sections auto-build the narrative).
* Notes are saved as **drafts**. **Sign & lock** (re-enter your password) when complete. Signed notes cannot be edited or deleted; add an **addendum** for corrections or late entries.
* **Verify signature** on a signed note checks the note as it is stored now against what was signed: *Signature intact* means it is exactly as signed; *Changed after signing* means the stored note no longer matches — report it to your privacy officer. Click the signature hash to see it in full.
* Do not put names or other identifiers in intervention *summary* fields — they are not encrypted. Use notes for anything sensitive.

## Consents & ROI (42 CFR Part 2)
Before sharing SUD information with a provider, family member or agency, record a **consent** naming the recipient, purpose, information covered and expiration. Every time information is shared, record a **disclosure** (who, what, why, how, on what basis). Revoke consents when the client withdraws them.

## Budget
Finance staff see client codes on Budget and Time but not client records; the codes are not links for them, and opening a client link says *Not available for your role*.

Record client assistance (bus passes, IDs, motel nights, phone minutes…) against the correct funding source and budget line; attach the client so per-client spending is visible. A supervisor or finance staff approves; you cannot approve your own entries.

## Changing the choices on forms (administrators)
**Settings → Lists** holds the drop-down choices on documentation forms, grouped by form and named the way the forms name them: *What did you do?*, Location, Modality and Outcome on visits; *Who* and the call and text outcomes; referral *Status / What happened* and *If it did not happen, why*; the overdose form's *What happened* and *Given by*; time categories; note formats; primary substance; reasons for discharge. An administrator (the `settings:manage` permission) can, for each list:

* **Reword a choice.** Type the new wording and press Save (or Enter). Forms, lists, filters, reports and Excel/CSV exports all use it. Only the wording changes: records keep the same stored value, so old records and reports mean what they always did. Clear the box and save to go back to the built-in wording.
* **Reorder** with the ↑ and ↓ buttons.
* **Hide (retire) a choice** the programme does not use. It is no longer offered on new records; records that already have it still show it, and editing one keeps it (shown as *no longer offered*). **Show** brings it back.
* **Add a choice** of your own. SUDS makes its stored value from the wording, and never one that a built-in choice already uses. A choice you added can be reworded or hidden like any other.
* **Restore defaults**: the built-in wording and order, with every built-in choice offered again. Choices you added are hidden, not deleted, because records may use them.

Choices marked **Used by SUDS** drive a count or an automatic step — for example a call *reached* or a text *replied* counts as contact with the client, a *fatal* overdose or a *deceased* discharge marks the client deceased, outreach and naloxone distribution can be recorded without a client — so they can be reworded but not hidden. Referral statuses and the overdose *What happened* choices can be reworded and reordered but not added to, because each one means something to the consent check and the counts. Race and ethnicity, ASAM level, stage of change, consent types, patient-rights requests and funding types are national or legal code sets and are not editable; the page lists them and says why.

An administrator sees a small **Edit this list** link beside each of these drop-downs on the forms themselves, which opens that list. Staff see changes the next time they sign in or reload. The lists belong to the office SUDS: a device that syncs with it receives them and cannot change them; SUDS on this device (with no office) keeps its own.

**Funding sources** are at the bottom of the same tab for anyone who manages the budget (`budget:manage`: administrators, supervisors, finance — finance uses **Funding & spending**, which has the same controls): add one quickly (name, type, period and total award; budget lines and the rest are on Funding & spending), rename it, or deactivate it so it is no longer offered on new records (records already charged to it keep it). A **Manage** link beside every *Funding source* drop-down opens it.

## Importing notes
Use **Import** in the sidebar and see [docs/IMPORTS.md](IMPORTS.md).

## Reports and Excel
Choose a date range for program summaries and monthly trends. The dates are calendar days where the programme is (the server's `ORG_TIMEZONE`), so an evening visit on the last day of a quarter is in that quarter. In the funder report, *people served* is everyone with a visit or a call in the period (only visits charged to it, when a funding source is chosen), and every per-person count and breakdown on the page is counted within that same group. **Episodes of care** shows admissions in the period (and how many are still open), discharges in the period by reason, and the list of admissions; a client code opens the client only for roles that can see client records. **Export to Excel** (or CSV) is available on Reports (every table — including episodes, overdose events, client forms and disclosures — or everything as one workbook, which also works in local mode) and on the Clients, Resources, Visits, Calls, Time, Referrals and Budget pages. Exports use client codes rather than names; supervisors can produce an identified workbook, which is recorded in the audit log.

## Importing spreadsheets
Import → *Import from Excel or CSV*. Choose what you are importing (clients, resources, visits, calls, time, to-dos, expenditures), download the template or upload the spreadsheet you already keep. SUDS matches your column names automatically (you can adjust them), checks every row, tells you exactly what is wrong with any row, flags people who already exist, and only saves when you click Import. For visits, calls and other client records, refer to the client by code (C26-0012) or "Last, First".

## Privacy reminders
* Only look up clients you are serving. Every record view is logged.
* Lock your screen when you step away.
* Never email PHI; use the system or approved secure channels.
