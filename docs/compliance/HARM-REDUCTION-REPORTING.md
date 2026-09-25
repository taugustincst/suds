# Harm-reduction reporting (California)

What SUDS produces for the reports a California harm-reduction or prevention programme owes, where each figure comes from, and **what has not been verified** against the funder's current template. Nothing here is an official form: each file says so, and each must be checked against the funder's current instructions before it is submitted.

All three reports are aggregate. None contains names, client codes, dates of birth or record ids, and none is a disclosure under 42 CFR Part 2; running or exporting any of them is recorded in the audit log.

## 1. Funder report (Reports → Funder report)

`GET /api/reports/funder` (reports:read), `GET /api/reports/funder/export?format=xlsx|csv` (also export:read).

| Figure | Source |
| --- | --- |
| Unduplicated clients served | Clients (not deleted, within the caller's caseload) with a visit or a call in the period; with a fund chosen, only visits charged to it. Each person once. |
| Demographic breakdowns | Those people's gender, language, housing, insurance, race codes (a person may report several) and ethnicity. |
| By funding source | Visits in the period grouped by `interventions.funding_source_id`, with an explicit **No funding source** row; staff time from `time_entries` in the period: *approved* minutes and *logged, not yet approved* (draft or submitted) minutes. With a fund chosen, the table, the staff hours on the page and on the Summary sheet, and the attribution figures are that fund's alone (visits charged to no fund are not in a report about one fund). |
| Overdose & naloxone | `overdose_events` and the naloxone kits and test strips on visits. |

**Small-cell suppression** (`purpose`, `counts`):

* Default, and always for `purpose=publication` (to publish or share): a breakdown row counting fewer people than the threshold is reported as `<N`; totals stay exact. The threshold is the `small_cell_threshold` setting (default 11, from 2 to 50).
* `purpose=submission&counts=exact`: the programme's own submission to its funder, with exact counts. Needs the `reports:exact` permission (supervisor, administrator, finance). `counts=exact` with `purpose=publication` is refused.
* The response's `suppression` (`mode`, `threshold`, `purpose`) and `counting_statement` say which was used; the export repeats it on its About sheet (CSV: the first rows), in its filename (`…-suppressed` / `…-exact-counts`) and in the `X-SUDS-Report-Counts` header.

**Funding attribution.** A visit is charged to the fund the worker chooses; a new visit form is pre-filled with the worker's default fund (`users.default_fund_id`) or the programme's (`default_fund_id` setting), and a visit posted without the field (a role not shown it, an API client) is charged to that default. The report's `attribution` block counts the services with no fund and links to them (`#/interventions?funding=none`).

## 2. Naloxone Distribution Project log (Reports → Harm-reduction reporting)

`GET /api/reports/naloxone-ndp` (reports:read), `GET /api/reports/naloxone-ndp/export?format=xlsx|csv` (also export:read).

The DHCS Naloxone Distribution Project (NDP) supplies naloxone to organisations that report back on what they distributed and on the overdose reversals reported to them. SUDS already records both, so no new data entry was added:

| Column | Source in SUDS |
| --- | --- |
| Date | The day of the visit or event, in the programme's time zone. |
| Entry | *Distribution* (kits handed out) or *Reversal reported*. |
| Site type | Distribution: the visit's *Location* (field, community, shelter…). Reversal: the overdose event's location type. |
| Recipient type | *Community member (anonymous)* — community distribution with no client — or *Programme participant* (a client on the caseload). |
| Kits distributed | Sum of *Naloxone kits given* (`interventions.naloxone_kits`). |
| Naloxone doses distributed | Kits × the `naloxone_doses_per_kit` setting (default 2: a standard nasal-spray kit holds two doses). |
| Reversals reported | Overdose events (Overdose & naloxone form, including community reports with no client) where naloxone was used and the person survived. |
| Doses used in reversals | `overdose_events.naloxone_doses`. |
| Naloxone given by | The overdose form's *Given by*. |

Rows are aggregated by day, site type and recipient type (distribution) or day, site type and who gave it (reversals). A navigator's log covers community distribution and their own caseload, like every other report.

**Unverified:** the column layout follows the NDP's published reporting fields *as SUDS understands them*. It is **not** the official NDP template and must be checked against the current NDP reporting template (and its reporting period and submission method) before it is used. In particular: whether the NDP wants per-event rows or period totals, its own site-type and recipient categories, and whether it asks for doses or kits by product (4 mg nasal spray, intramuscular) — SUDS does not record the product.

## 3. Opioid settlement expenditure report (Reports → Harm-reduction reporting)

`GET /api/reports/opioid-settlement` (budget:read), `GET /api/reports/opioid-settlement/export?format=xlsx|csv` (also export:read).

A **settlement fund** is a funding source whose type is *Opioid settlement*, or one given a settlement category. Each fund has an **allowable use** and a **California High Impact Abatement Activity** (`funding_sources.settlement_use`, `settlement_hiaa`; migration 38); an expenditure has its own (`expenditures.settlement_use`, `settlement_hiaa`) only when it differs from its fund's. `none` means "not one of these" (for example an administrative cost, or spending that is not a High Impact Abatement Activity).

| Output | Meaning |
| --- | --- |
| By allowable use | Approved or reimbursed amount, pending amount and number of expenditures in the period, per Exhibit E category, plus *uncategorised*. Rejected spending is left out. |
| By HIAA | The same per High Impact Abatement Activity, with *none* and *uncategorised*. |
| HIAA share | Approved spending on High Impact Abatement Activities as a percentage of approved settlement spending. |
| Services | Visits charged to settlement funds, by the fund's allowable use: services, people, naloxone kits. |

The category lists are in `server/constants.js` (`SETTLEMENT_USES`, `SETTLEMENT_HIAA`), with their sources in a comment:

* **Allowable uses**: Exhibit E, *List of Opioid Remediation Uses*, of the national opioid settlement agreements — Schedule A *Core Strategies* (A–I) and Schedule B *Approved Uses* (A–L). Labels are abbreviated.
* **High Impact Abatement Activities**: the six activities in the California State-Subdivision Agreement, as summarised by DHCS.

**Unverified:** both lists, their wording and the High Impact Abatement share a participating subdivision must meet should be checked against the agreement that governs each fund (later settlements reuse Exhibit E, but a county's own reporting template may group categories differently). SUDS does not decide whether a cost is allowable; it groups what the programme recorded.
