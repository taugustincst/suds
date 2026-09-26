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
| Overdose & naloxone | `overdose_events` and the naloxone kits and test strips on visits. *Who gave the naloxone* counts reversals (naloxone used, the person survived), as the NDP log does. |

**Small-cell suppression and publication** (`purpose`, `counts`; the same for all three reports, `server/small-cells.js`; the design and its residual risks in [HIPAA.md, Small cells in aggregate reports](../HIPAA.md#small-cells-in-aggregate-reports)):

* **What a run is for** (`purpose`, in the response's `suppression.purpose` and `release`):
  * `publication` — a release to publish or share. Only for the **whole programme** (no `funding_source_id`, no caseload scope) and **one standard period that has ended**: a calendar month, a quarter (starting January, April, July or October), or a year starting on one of those quarters (a July–June or October–September fiscal year, or a calendar year). Such a run is a publication release by default; asking for `purpose=publication` on any other run is refused (400), because two runs of different scope or period can be subtracted from each other to reveal a small group (the whole programme minus one fund, January–June minus January–May).
  * `internal` — anything else (the default for a fund-filtered, custom-range, caseload-scoped or unfinished run): marked *internal, not for publication* on screen, on the About sheet and in the filename. `release.not_publishable` says why.
  * `submission` — the programme's own report to its funder (or to the NDP): not for publication either. This is how a funder gets its own fund's figures.
* **Counting** (`counts`): suppressed by default, and always for a publication release. **Every count of people** above 0 and below the threshold is reported as `<N`, in every table and headline figure. The threshold is the `small_cell_threshold` setting (default 11, from 2 to 50).
  * Counts of people: unduplicated people served and each demographic row; new admissions, people referred, admitted after a referral and on MAT; episodes opened, closed and open at the end, and each discharge reason; people per fund (including the *No funding source* row) and per settlement allowable use; overdose events (in total and per month), reversals (in total, per month and per NDP row), fatal and community-reported overdoses, and who gave the naloxone (in each reversal). An overdose or a reversal is an event that happened to one person, so it is counted as one.
  * Not counts of people, always exact: naloxone kits and doses distributed, fentanyl test strips, services (visits), staff hours and money.
  * **Complementary suppression.** A cell shown `suppressed` was hidden to protect another and is known to be at least the threshold; a `<N` cell is known to lie between 1 and N−1. Tables that share a total are protected together until nothing hidden can be worked out from everything the report publishes: the people served, the five single-valued breakdowns that add up to it, and the counts of some of those people (on MAT, referred, admitted, each fund and *No funding source*, each race code), whose complement (the people left over) is a count of people too; the overdose events, reversals, months and who gave the naloxone; discharges and their reasons; NDP reversal rows and the doses used in them. The total stays visible whenever hiding more cells is enough. When it cannot (two `<11` housing cells that make up the whole total), it is hidden, and so is at least one cell of every breakdown that would otherwise print it. A breakdown that nothing can protect is withheld whole (`withheld` lists it).
  * A median length of stay over fewer people than the threshold is shown as `suppressed`.
  * A total that is itself a small count of people is shown as `<N`. Zero is shown as 0.
* `counts=exact`: exact counts, for a run that is not for publication (`purpose=submission` or `internal`). Needs the `reports:exact` permission (supervisor, administrator, finance); the Reports page offers the choice beside the harm-reduction exports. `counts=exact` with `purpose=publication` is refused.
* The response's `suppression` (`mode`, `threshold`, `purpose`), `release` (`publishable`, `period`, `not_publishable`) and `counting_statement` say which was used; each export repeats it on its About sheet (funder report CSV: the first rows), in its filename (`…-publication-suppressed`, `…-internal-suppressed` or `…-exact-counts`) and in the `X-SUDS-Report-Counts` and `X-SUDS-Report-Purpose` headers.
* **Residual risk.** Two publication releases for nested or overlapping standard periods (a quarter and its year) can still be subtracted from each other, as can the same period run again after late entries. Publish one standard period per funder cycle, once its data are complete.

**Funding attribution.** A visit is charged to the fund the worker chooses; a new visit form is pre-filled with the worker's default fund (`users.default_fund_id`) or the programme's (`default_fund_id` setting), and a visit posted without the field (a role not shown it, an API client) is charged to that default. The report's `attribution` block counts the services with no fund and links to them (`#/interventions?funding=none`); when the programme has no default fund it says so (`default_fund_set`) and links to where one is set (`settings_link`, Settings → Programme → Reporting). The first-run setup wizard asks for the programme's main funding source (optional): it is created for the current July–June fiscal year and made the default, so a new install's visits are not all *No funding source*.

## 2. Naloxone Distribution Project log (Reports → Harm-reduction reporting)

`GET /api/reports/naloxone-ndp` (reports:read), `GET /api/reports/naloxone-ndp/export?format=xlsx|csv` (also export:read). Small cells as in section 1: reversals per row are suppressed, so a read-only account sees only suppressed rows. **Published** (a publication release, section 1), the log is **by month**: distribution by month, site type and recipient type, and reversals by month for all sites together, which are exactly the funder report's reversals by month for the same release, suppressed by the same call. The day-by-day log by site and by who gave the naloxone is for the programme's own submission to the NDP (`purpose=submission`) or internal use.

The DHCS Naloxone Distribution Project (NDP) supplies naloxone to organisations that report back on what they distributed and on the overdose reversals reported to them. SUDS already records both, so no new data entry was added:

| Column | Source in SUDS |
| --- | --- |
| Date | The day of the visit or event, in the programme's time zone. |
| Entry | *Distribution* (kits handed out) or *Reversal reported*. |
| Site type | The same coded *Location* list for both (field, community, shelter…): distribution, the visit's; reversal, the overdose form's *Where*. A place typed in before *Where* was a list is matched to a code whatever its case (*Shelter* → shelter), or else counted as *Other*; the record keeps its words. |
| Recipient type | *Community member (anonymous)* — community distribution with no client — or *Programme participant* (a client on the caseload). |
| Kits distributed | Sum of *Naloxone kits given* (`interventions.naloxone_kits`). |
| Naloxone doses distributed | Kits × the `naloxone_doses_per_kit` setting (default 2: a standard nasal-spray kit holds two doses). |
| Reversals reported | Overdose events (Overdose & naloxone form, including community reports with no client) where naloxone was used and the person survived. An event recorded as a *Reversal* had naloxone by definition: the form ticks *Naloxone was given* when Reversal is chosen, the server records it so, and one saved before that rule with the box unticked is counted too. |
| Doses used in reversals | `overdose_events.naloxone_doses`. |
| Naloxone given by | The overdose form's *Given by*. |

Rows are aggregated by day, site type and recipient type (distribution) or day, site type and who gave it (reversals); in a publication release, by month (above). A navigator's log covers community distribution and their own caseload, like every other report.

**Unverified:** the column layout follows the NDP's published reporting fields *as SUDS understands them*. It is **not** the official NDP template and must be checked against the current NDP reporting template (and its reporting period and submission method) before it is used. In particular: whether the NDP wants per-event rows or period totals, its own site-type and recipient categories, and whether it asks for doses or kits by product (4 mg nasal spray, intramuscular) — SUDS does not record the product.

## 3. Opioid settlement expenditure report (Reports → Harm-reduction reporting)

`GET /api/reports/opioid-settlement` (budget:read), `GET /api/reports/opioid-settlement/export?format=xlsx|csv` (also export:read). Small cells as in section 1: people per allowable use are suppressed, and protected against the programme's total people served in the period (which the funder report publishes), so that no use's complement can be worked out; amounts, services and kits are not. People are counted as in the funder report: a deleted client's visits are services, not a person served.

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
