# CalOMS Tx file layout: request for confirmation from a county

> **DRAFT — a letter or email template to be completed before it is sent.** Every `[BRACKET]` is filled in outside
> this public repository. Before sending, read DHCS's *2026 CalOMS Tx and DATAR FAQ* (September 2026 version or newer,
> <https://www.dhcs.ca.gov/fa/provgovpart/Documents/2026-CalOMSTxDATAR-FAQ.pdf>) and drop or reword any question it
> already answers; note the version read in the record (section 4). Item 5 of
> [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md). The facts below are from
> [../../compliance/CALOMS.md](../../compliance/CALOMS.md) and `server/caloms.js`, `server/caloms-spec.js`.

## 1. The message

**To:** `[COUNTY]` CalOMS Tx coordinator, `[COUNTY BEHAVIORAL HEALTH DEPARTMENT]`
**From:** `[SENDER ROLE]`, `[LICENSOR LEGAL ENTITY]` (`[CONTACT EMAIL]`)
**Subject:** Confirming the CalOMS Tx file layout produced by SUDS

Dear `[COUNTY]` CalOMS coordinator,

SUDS is case-management software used by `[substance-use treatment and harm-reduction programmes / PROGRAMME NAME, if
it has agreed to be named]` in California. For programmes that report CalOMS Tx, SUDS collects the admission,
discharge and annual update records, runs edit checks, and produces a monthly file for the county to upload through
its CalOMS process. SUDS does not submit to DHCS itself.

The **code values** in the file have been checked against the DHCS *CalOMS Tx Data Dictionary*, File Version 3.0
(October 2024). The **file layout** (file format, file split, column names and order, date and code formatting, and
the provider activity report) is SUDS's own and has **not** been confirmed against what your channel accepts. Before
any programme relies on it, we would be grateful if you could confirm the layout or tell us what to change. A sample
file built from **fictional records only** is attached, with the questions below. `[If the county prefers a short
call: we can take it in 30 minutes at your convenience.]`

Thank you for your time,
`[SENDER ROLE]`, `[LICENSOR LEGAL ENTITY]`

## 2. The questions

What SUDS produces today, and the question for each:

1. **File format.** SUDS produces **CSV** (comma-separated, a header row, CRLF line ends, UTF-8 without a byte-order
   mark, values quoted only where needed). Does your channel accept CSV, or does it need a fixed-width or XML file (and
   if so, which specification and version)?
2. **One file per record type.** SUDS writes `admissions.csv`, `discharges.csv` and `annual_updates.csv` in one zip,
   plus `provider_activity.csv` and a `README.txt`. Does your channel take one file per record type, one combined
   file, or a batch per provider?
3. **Column names and order.** The column names are SUDS's own (for example `TypeOfService`, `ReferralSource`,
   `PrimaryDrug`); the DHCS dictionary identifies elements by group-item number (ADM-4, ADM-5, ADU-1a). Should columns be
   named by group-item number, by the names in a DHCS file specification, or does the order alone matter? The full list
   is in the field mapping of [../../compliance/CALOMS.md](../../compliance/CALOMS.md).
4. **Identifying columns.** Each record starts with `RecordType`, `ProviderID`, `ProviderClientID` (the programme's
   client code), `ClientLastName`, `ClientFirstName`, `DateOfBirth`, `AdmissionDate`, then the record's own date
   (`AdmissionTransactionDate`, `DischargeDate` or `AnnualUpdateDate`). Is this the identifying set your channel
   expects? SUDS does **not** collect mother's first name, place of birth, social security number or birth name: are
   any of them required for submission?
5. **Record type codes.** `RecordType` carries the TRN-1 code: `1` admission, `4` discharge, `7` annual update. SUDS
   does not produce resubmissions or deletions (TRN-1 codes 2, 3, 5, 6, 8, 9). How should a correction or deletion
   reach DHCS through your channel: from the provider's file, or by the county directly?
6. **Dates.** Dates are written `YYYY-MM-DD`. Is another format required (for example `MMDDYYYY`)?
7. **Code formatting.** Codes are written as the dictionary lists them: for example race as `01`–`19`, drug codes
   unpadded (`0`–`20`), yes/no as `1`/`0`, and the dictionary's alternative values (`99900`–`99904`). Are leading zeros
   and these alternative values accepted as written?
8. **Multi-answer elements.** Race (up to 5 codes) and disability (up to 7) are split into numbered columns
   (`Race1`–`Race5`, `Disability1`–`Disability7`), unused ones left empty. Is that accepted?
9. **"Other (specify)" text.** When the primary or secondary drug is `99903` (Other), the dictionary has a text element
   (ADU-1b / ADU-5b). SUDS does not collect or send that text. Is it required?
10. **Provider activity / no-activity report.** SUDS writes `provider_activity.csv` per provider per month:
    `ProviderID`, `ReportMonth` (`YYYYMM`), `Admissions`, `Discharges`, `AnnualUpdates`, `NoActivity` (`Y` when nothing
    was reported that month, else `N`). The dictionary does not cover this report. What format and channel does the
    county use for it?
11. **File naming, packaging and deadline.** Is there a required file name, a zip or no zip, and what is the monthly
    deadline for providers to deliver the file to the county?
12. **Anything else** your channel checks that a provider's file commonly fails (DHCS's own cross-submission edits,
    such as duplicates across providers, are understood to come back to the county).

## 3. What SUDS sends with the request

- A **sample submission file** made from **fictional records only**: an office server seeded with fictional clients
  (`node scripts/county-sample.js --register`), CalOMS switched on with a placeholder provider ID, then **Produce
  submission file** (`POST /api/caloms/submissions`) for one month. Before it is sent, open every CSV and confirm that
  every name, date of birth and client code is fictional; the file's SHA-256 (shown on the State reporting page) is
  noted in the record. (The **preview** download is not suitable: it replaces names with `PREVIEW` / `NOT FOR
  SUBMISSION` and leaves out dates of birth, so it does not show the real layout.)
- The field mapping and code sets: [../../compliance/CALOMS.md](../../compliance/CALOMS.md) (as a PDF or a link).
- No real client record, ever.

## 4. How the answer is recorded

- A record in `docs/evidence/caloms-layout-confirmation-<county>-<YYYY-MM-DD>.md`: the county, the responder's **role**
  (not name or contact details), the date, the version of the DHCS FAQ read, each question above with the answer, and
  the SHA-256 of the sample file sent.
- Each change the answer requires becomes an issue and ships in a release; [../../compliance/CALOMS.md](../../compliance/CALOMS.md)'s
  open item then says which layout points are confirmed, for which county, and when.
- [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md) item 5 is updated.
