# How SUDS supports the DHCS opioid settlement expenditure report

> **DRAFT sales collateral — to be checked and approved by the owner before use.** Before each reporting cycle,
> check every statement below against **the current DHCS online form and its guidance**: the form, its fields and its
> categories can change between cycles, and SUDS was built from DHCS's preview guide and training materials, not from
> the form itself. Checked against the DHCS form on: `[DATE, FORM VERSION]`. Item 12 of
> [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md). Every claim here is from
> [../../compliance/HARM-REDUCTION-REPORTING.md](../../compliance/HARM-REDUCTION-REPORTING.md), sections 3–5.

---

**California cities and counties report their opioid settlement spending to DHCS once a year**, per state fiscal year
(July to June), on the *California Opioid Settlement Expenditure Reporting Form*, an online form since SFY 2025-26.
The next report is due **`[30 September 2027, for SFY 2026-27 — confirm with DHCS]`**. Community organisations funded
with settlement money are usually asked by their county for the figures behind it.

**SUDS is case-management software for harm-reduction and SUD programmes.** Staff record outreach contacts, naloxone
and supply distribution, overdose reversals, referrals and services as they work, and charge each to the fund that
pays for it. The settlement figures come out of that same record, not out of a separate spreadsheet.

### What SUDS produces for the settlement report

- **Spending by settlement category.** For every opioid settlement fund, approved or reimbursed spending, pending
  spending and the number of expenditures in the period, grouped by **Exhibit E category** (the national settlements'
  *List of Opioid Remediation Uses*: Core Strategies A–I and Approved Uses A–L) and by **California High Impact
  Abatement Activity** (the six activities of the California State-Subdivision Agreement), with the **share of
  settlement spending that went to High Impact Abatement Activities**.
- **A file laid out like the DHCS form.** One row per activity (a fund and the category its spending went to), in the
  order of the form's fields as SUDS understands them: reporting period, funding source and grant number, Exhibit E
  schedule and category, High Impact Abatement Activity, the organisation that received the funds, amounts expended and
  pending, services delivered and people served under the activity. **People counts of 10 or fewer are written "10 or
  fewer"**, as DHCS asks. Excel or CSV, for copying into the online form.
- **What the programme still writes itself.** Which settlement(s) the money came from, which fund (CA Subdivision
  Fund, CA Abatement Accounts Fund or Plaintiff Subdivision), the activity's name and description, how it meets the
  High Impact Abatement Activity, and the outcomes narrative. The file's About sheet lists these columns.
- **The county's own template.** Where a county passes settlement money to community organisations with its own form,
  the programme sets up that form's columns once in SUDS (no code), and the same figures come out in the county's
  layout; it also works for block-grant, SOR or county general fund templates.
- **Settlement outcomes.** For each settlement fund: what it spent and what the programme recorded of the work charged
  to it (naloxone kits, reversals reported, contacts, fentanyl test strips, syringes, people served, people linked to
  care and to medication for OUD, admissions, people trained), by category, fund and month, with the cost per outcome
  where that means something.

### Privacy built in

- The settlement files hold amounts and counts, not client records; the outcomes page and file carry **no names, client
  codes, record ids or dates of service**.
- Counts of people are **suppressed by default** in the outcomes view (under 11 shown as `<11`, with whatever would
  reveal them hidden, and no cost per outcome next to a hidden count); exact counts are for the programme's own
  submission, run by finance, supervisors or administrators.
- Opening the outcomes view and downloading its file are audited with the period, the counting and the format, never
  with a figure about a person.

### What SUDS does not do

- It does not submit to DHCS or to the county; a person copies the figures into the online form or sends the file.
- It does not decide whether a cost is allowable; it groups what the programme recorded under the categories it
  chose.
- Its category lists and the High Impact Abatement share must be checked against the agreement that governs each fund,
  and its outcome mapping is SUDS's reading of each Exhibit E category: a county may define them differently.

### Try it

- **SUDS on this device** is free for real use at its official address, <https://taugustincst.github.io/suds/>, with
  records kept only on that device; a team that shares its funds and records uses an office server.
- **A 90-day pilot** of the office server: `[PUBLISHED PILOT PRICE AND TERMS, from the procurement page]`.
- **Contact:** `[CONTACT EMAIL]`, `[CONTACT URL]`. Licensor: `[LICENSOR LEGAL ENTITY]`.

---

*Before using this page: confirm each "SUDS produces" line on the current release (Reports → Harm-reduction reporting;
Settlement outcomes), confirm the DHCS due date and form fields for the cycle, fill the brackets, and remove this
note and the draft banner.*
