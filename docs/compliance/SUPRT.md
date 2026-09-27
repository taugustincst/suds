# SUPRT-A: SOR client-level reporting (SAMHSA, entered in SPARS)

What SUDS records for SAMHSA's client-level performance reporting on a **State Opioid Response (SOR)** grant,
which items it fills from the client record and which it asks, the windows its to-do list follows, how the file
for SPARS is disclosed, and **what has not been verified**. SUDS makes no claim that SAMHSA, DHCS or California's
SOR evaluators have reviewed, certified or accepted any of it.

## What SUPRT is, and what SUDS covers

Since 1 October 2025 SAMHSA's **Unified Performance Reporting Tools (SUPRT)** replace the CSAT GPRA tool for
client-level data on SOR and other CSAT and CMHS discretionary grants. California SOR contractors, including
Naloxone Distribution Project partners that provide client-level services with SOR money, collect it. SUPRT has
two parts:

* **SUPRT-A** ("Administrative"): completed by programme staff from the client's record — record management,
  behavioral health history, screenings, diagnoses, services received and (sometimes) demographics.
  **SUDS records SUPRT-A.**
* **SUPRT-C** ("Client"): a questionnaire the client answers (SAMHSA's adult baseline and reassessment tools).
  **SUDS does not reproduce SUPRT-C**: SAMHSA's own wording is the instrument. SUDS records whether it was
  completed, declined, or not offered, because SUPRT-A asks the demographics only when it was not completed.

The finding that asked for this described "SUPRT-A" as an adult interview; SAMHSA's published materials describe
SUPRT-A as the staff-completed administrative record and SUPRT-C as the client questionnaire, and that is what is
built here.

Sources SUDS relied on (public descriptions, read in September 2026): SAMHSA's SPARS announcements of SUPRT-A and
SUPRT-C (data entry live; CSV batch upload template and codebook "now available" to grantees), the California SOR
*SUPRT Handbook: Guidance for SOR Grantees* (January 2026) and *GPRA to SUPRT Tool and Transition Overview*
(29 September 2025) as indexed by californiaopioidresponse.org, and state SOR guides (Pennsylvania, Ohio,
Michigan) describing SUPRT-A's sections and windows. **SAMHSA's SUPRT-A paper tool, question-by-question guide
and codebook, and the California handbook itself, could not be opened from the environment SUDS was built in**
(the hosts were blocked). So:

* the **sections** and the **assessment points and windows** follow the public descriptions below;
* the **items, their wording, answer codes and variable names are SUDS's own**, grouped under SUPRT-A's
  sections. They must be checked against the current SUPRT handbook and SUPRT-A codebook before anything is
  entered in SPARS, and the file says so.

## Assessment points and windows

| Assessment | When (SUDS) | To-do list |
| --- | --- | --- |
| Baseline | When a client first receives a service charged to a funding source of type *SOR grant*. | Due from the first SOR-funded service; overdue 30 days after it. |
| Reassessment | 180 days after the baseline (90 if the programme's SOR contract says 3 months: Settings on the SUPRT-A page). | Window from 30 days before to 30 days after that anniversary; overdue once the anniversary passes; *window closed* (missed) after it. A reassessment recorded outside its window still counts as taken, and is reported as outside the window. |
| Annual | Every 365 days after the baseline. | Same 60-day window. |
| Closeout | When the client stops receiving SOR-funded services (SUDS: their record is closed, inactive or deceased with a discharge date). | Due within 30 days of the discharge. After a closeout, reassessments and annual assessments are not required, and a new baseline starts a new cycle. |

`server/suprt.js` `schedule()` is the whole rule, as a pure function of the dates (`test/suprt.test.js`).

## The items: derived from the record, or asked

Sections as SUPRT-A names them. **Record** means SUDS pre-fills it from the client record (the worker can change
it); **asked** means the worker asks the client or checks the record; **setting** comes from Settings.

| Section | Item (SUDS variable) | Source in SUDS |
| --- | --- | --- |
| A. Record management | `A_client_id` | Record: the SUDS client code (not a name; SPARS's client ID is chosen by the grantee). |
| | `A_grant_id`, `A_site_id` | Setting (SUPRT-A page), stamped on the record when it is saved. |
| | `A_assessment_type`, `A_assessment_date` | The assessment itself. |
| | `A_first_service_date` | Record: the earlier of the first visit and the intake date. |
| | `A_suprt_c` (SUPRT-C completed / declined / not offered) | Asked (not at closeout). Required. |
| | `A_closeout_reason` (closeout) | Record: the last closed episode's discharge reason, else the client's (*lost contact* → *no contact*). Required. |
| | `A_last_service_date` (closeout) | Record: the last visit on or before the closeout. Required. |
| B. Behavioral health history | `B_primary_substance`, `B_route_of_use` | Record. |
| | `B_overdose_ever` | Record: the overdose-history flag or any overdose event. |
| | `B_overdose_since_last` | Record: an overdose event (or the last-overdose date) since the last assessment; at baseline, in the 30 days before it. |
| | `B_moud`, `B_moud_medication` | Record: MAT status *active*, and the medication. |
| | `B_co_occurring_mh` | Record. |
| | `B_crisis_since_last`, `B_residential_tx_since_last` | Asked. |
| C. Screenings | `C_substance_use_screen` | Record: the latest DAST-10 or AUDIT-C result (Assessments module), else asked. |
| | `C_mental_health_screen` | Record: the latest PHQ-9 or GAD-7 result, else asked. |
| | `C_suicide_risk_screen` | Record: PHQ-9 item 9 above "not at all" is positive, else asked. |
| | `C_trauma_screen` | Asked. |
| D. Diagnoses | `D_icd10_codes`, `D_oud` (F11), `D_stimulant_use_disorder` (F14, F15) | Record: the ICD-10 codes on the active problem list (Care plan module), as a clinician recorded them. |
| E. Services received (reassessment, annual, closeout) | `E_case_management`, `E_peer_recovery_support`, `E_harm_reduction`, `E_naloxone`, `E_moud`, `E_treatment_referral`, `E_screening_assessment`, `E_crisis_services`, `E_housing_support`, `E_employment_education`, `E_benefits_enrollment`, `E_transportation`, `E_justice_services`, `E_family_support` | Record: the visit types since the last assessment, grouped by SUDS (naloxone also from kits given; treatment referral also from referrals; MOUD from active MAT or a referral to an OTP or OBOT). SUPRT-A's own services list may split or name these differently: check the codebook. |
| F. Demographics (baseline, only when SUPRT-C was not completed) | `F_date_of_birth`, `F_gender`, `F_race`, `F_ethnicity`, `F_language`, `F_veteran`, `F_housing`, `F_insurance` | Record. SUDS's own codes (race as CalOMS/OMB codes); SPARS's categories must be checked. |

The form (client record → **SUPRT-A** tab) groups the items by section, says under each pre-filled answer that it
came from the record, and asks the rest; it is one column on a phone. The saved record says which answers were
the record's own (`derived_keys`). An assessment can be saved as a draft; it is *complete* only when the required
items are answered.

## Storage, permissions and the to-do list

* `suprt_assessments` (migration 44, `server/schema.sql`): the answers are PHI and are kept only in
  `answers_enc` (AES-256-GCM, JSON); what stays readable is the assessment type, date, status and when it was
  last put in a SPARS file. Synchronised to devices (`server/sync-tables.js`), purged with the record
  (`server/retention.js`), and every read and write is audited (`suprt.view`, `suprt.prefill`, `suprt.create`,
  `suprt.update`, `suprt.delete`, `suprt.due.view`, `suprt.completion`, `suprt.export`).
* Who: whoever may read a client's record (`clients:read`, caseload-scoped) reads its SUPRT-A; whoever may
  change it (`clients:write`) records it. The to-do list (`GET /api/suprt/due`, on the To-dos page and the
  SUPRT-A page) and the completion rates (`GET /api/suprt/completion`) cover the caseload the role can open: a
  worker's own clients, a supervisor's team (with who has each client). Finance and read-only see neither.
* **Module switch.** SUPRT-A is a programme module (`server/programme.js`, key `suprt`): on by default for a
  programme with a funding source of type *SOR grant*, off otherwise, and switchable in Settings › Program ›
  Modules. Switched off, new records and the SPARS file are refused (403); what was recorded stays readable.

## Completion rates

For a period: of the reassessments, annual assessments and closeouts **due** in it, how many were done within
their window, done outside it, missed (window closed), or still open; the rate is *done within the window* over
those whose window has closed or that were done. Baselines recorded in the period, and clients owed one, are
counted beside it.

## The file for entry into SPARS: a disclosure

`GET /api/suprt/export?from&to&set=main|closeout&recipient&purpose&basis` (SUPRT-A page → *Make the SPARS entry
file*). One row per completed assessment dated in the period, the SUDS variables above in section order, and a
last line: *For entry into SPARS - check against the current SUPRT handbook and SUPRT-A codebook* (also in the
filename and the `X-SUDS-Export` header). `set=closeout` gives the closeouts alone: SPARS's batch upload takes
closeout records last, in a separate file. **It is not the SPARS CSV batch upload template**, whose layout is in
the codebook SAMHSA publishes to grantees; SUDS could not read it.

The file names clients (their client code, date of birth, diagnoses and services), so it is a **disclosure**,
modelled on the CalOMS Tx extract and the identified export (`server/disclosure.js`):

* only a role that may make identified exports (`export:identified`: supervisor, administrator) produces it;
* its lawful basis is each client's **Part 2 consent naming the recipient** (`basis=consent`, the default;
  recipient `SAMHSA` unless changed), or an **audit or evaluation approval on file** with the recipient
  (`basis=audit_evaluation`, 42 CFR §2.53, supervisor or administrator). Unlike CalOMS Tx, SPARS reporting is a
  condition of a federal grant, not a disclosure required by state law, so SUDS does not treat it as one: without
  a consent or an approval nothing is sent. Under consent, a client without one naming the recipient is left out
  and listed (`X-SUDS-Export-Excluded`); when no client has one the file is refused (409) and the refusal is
  audited (`suprt.export.refused`); agreed restrictions are checked as for any export;
* each client in the file gets one row in their **accounting of disclosures** (source `suprt`, method *export*),
  the assessments are marked as exported (an exported assessment is corrected, not deleted), a file naming many
  clients opens a draft incident for review like any mass identified export, and the Part 2 notice ends the file
  in a Part 2 programme.

Counsel should confirm the basis for the programme: whether its SOR contract makes SPARS reporting a use the
consent must name, or an evaluation under §2.53 with an agreement on file.

## Not done

* SUPRT-C (the client questionnaire) and the SPARS CSV batch upload file itself.
* Item-level validation against SAMHSA's skip logic and codebook values.
* Grant programs that reassess at intervals other than 3 or 6 months.
