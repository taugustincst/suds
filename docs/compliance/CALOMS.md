# CalOMS Tx reporting in SUDS

> **Status: NOT VERIFIED AGAINST THE DHCS DATA DICTIONARY.** The DHCS *CalOMS Tx Data Collection Guide*
> (Aug 2024, v3 — the San Diego DMC-ODS copy at optumsandiego.com) and the DHCS CalOMS Tx data dictionary /
> file specification could not be retrieved when this was built (the build environment's network policy
> blocked both hosts). The record types, the data elements and the edit checks follow the structure of the
> guide as it is generally known; **every code value, element name, and the file layout is "to verify against
> the current DHCS data dictionary"**. A county must check the tables below against the dictionary DHCS has
> issued it before the first submission. All of it lives in one file, `server/caloms-spec.js`, so a
> correction is a one-file change; the layout version (`SPEC_VERSION`) is stamped into every extract's README.

## What SUDS does and does not do

| Does | Does not |
| --- | --- |
| Collect admission, discharge (standard and administrative) and annual update records for each episode of care | Submit to DHCS itself — the county uploads the files through its CalOMS channel |
| Run the edit checks below and list every problem by client code and field | Guarantee DHCS will accept a file (its own edits are authoritative) |
| Hold back every record with a fatal error from the extract | Produce the DHCS fixed-width / XML format, if that is what the county's channel needs (unconfirmed; CSV is produced) |
| Produce the monthly provider activity report, with "no activity" months | Collect the client identifiers not listed below (mother's first name, place of birth, SSN, birth name) — to verify whether the current dictionary requires them |
| Account for the extract as a disclosure required by law, per client | Bill anything (see `docs/SCOPE.md`) |

Funder reports (Reports → Funder report) are **not** a substitute for CalOMS: they count people and services;
CalOMS is a per-episode record set the state defines.

## Switching it on

**Reports → State reporting → Settings** (administrators): tick *This program reports CalOMS Tx*, list the
CalOMS provider ID(s) DHCS assigned (one per line, `ID, name`), and the date from which records are expected.
It is **off by default**: a prevention, outreach or navigation program is never asked these questions. The
settings are `caloms_enabled`, `caloms_providers` (JSON) and `caloms_start_date`; they are synchronised to
devices so the offline forms match.

When it is on:
- **Start an episode** asks the CalOMS admission questions; the episode is not opened without them.
- **Discharge** asks the CalOMS discharge status and date of last service, and the past-30-day questions
  unless the status is administrative (4, 6, 7, 8). A problem in the record undoes the discharge too.
- Each episode has **CalOMS records** (Episodes tab): what it has, each record's problems, what is still
  needed (an admission for an episode opened at intake, an annual update on each anniversary), and edit.
- **Reopen / re-admit** removes the episode's discharge record (warning if it had already been extracted).
- Intake still opens an episode without asking; it shows as *missing admission* until completed.

## Storage

`caloms_records` (migration 31): one row per record, tied to an episode. The answers — drug use, arrests,
pregnancy, disability, ZIP code and the rest — are PHI and are stored encrypted as one JSON document
(`answers_enc`). Only operational codes stay in the clear, as with `episodes.discharge_reason`: record type,
provider ID, record date, type of service and discharge status. Records are synchronised (`sync-tables.js`),
moved on a client merge, purged with the client by retention, and every read and write is audited without
the answers.

## Record types

| Record | When | Carries |
| --- | --- | --- |
| Admission (`A`) | Each episode opened on or after the start date | Admission, client, substance-use and past-30-day elements |
| Discharge (`D`) | When the episode is closed | Discharge status, date of last service; past-30-day elements for a standard discharge |
| Annual update (`U`) | Each anniversary of the admission while the episode is open; accepted from 60 days before to 30 days after (window to verify) | Past-30-day elements |
| Provider activity | Every provider ID, every month of the extract period | Counts of A/D/U; `NoActivity=Y` for a month with none |

## Field mapping (to verify against the current DHCS data dictionary)

Records: A = admission, D = discharge, U = annual update. Required: *yes* always; *standard* on admissions,
annual updates and standard discharges; *conditional* see the edit checks.

| SUDS key | Extract column (CalOMS element, to verify) | Records | Required | Values |
| --- | --- | --- | --- | --- |
| `admission_transaction` | AdmissionTransactionType | A | yes | code set ADMISSION_TRANSACTION |
| `service_type` | TypeOfService | A | yes | code set SERVICE_TYPES |
| `referral_source` | ReferralSource | A | yes | code set REFERRAL_SOURCES |
| `days_waited` | DaysWaitedToEnterTreatment | A | yes | 0–999 |
| `prior_episodes` | NumberOfPriorTreatmentEpisodes | A | yes | 0–99 |
| `mat_planned` | MedicationAssistedTreatmentPlanned | A | yes | code set YES_NO |
| `calworks` | CalWORKsRecipient | A | yes | code set YES_NO |
| `sex_at_birth` | SexAtBirth | A | yes | code set SEX_AT_BIRTH |
| `gender_identity` | GenderIdentity | A | yes | code set GENDER_IDENTITY |
| `race` | Race1–5 | A | yes | code set RACES |
| `ethnicity` | Ethnicity | A | yes | code set ETHNICITIES |
| `veteran` | VeteranStatus | A | yes | code set YES_NO_DECLINED |
| `disability` | Disability1–5 | A | yes | code set DISABILITIES |
| `zip_code` | ZipCodeAtAdmission | A | yes | 5-digit ZIP |
| `education_grade` | HighestSchoolGradeCompleted | A | yes | 0–30 |
| `children_under_18` | NumberOfChildrenUnder18 | A | yes | 0–99 |
| `children_cps` | ChildrenLivingWithOthersDueToCPS | A | yes | 0–99 |
| `pregnant` | PregnantAtAdmission | A | yes | code set YES_NO |
| `primary_drug` | PrimaryDrug | A | yes | code set DRUGS |
| `primary_route` | PrimaryDrugRoute | A | yes | code set ROUTES |
| `primary_age_first_use` | PrimaryDrugAgeOfFirstUse | A | yes | 0–99 |
| `secondary_drug` | SecondaryDrug | A | yes | code set DRUGS |
| `secondary_route` | SecondaryDrugRoute | A | conditional | code set ROUTES |
| `secondary_age_first_use` | SecondaryDrugAgeOfFirstUse | A | conditional | 0–99 |
| `iv_use_12m` | NeedleUsePast12Months | A | yes | code set YES_NO |
| `discharge_status` | DischargeStatus | D | yes | code set DISCHARGE_STATUS |
| `last_service_date` | DateOfLastService | D | yes | date |
| `primary_days_used` | PrimaryDrugFrequency | A, D, U | standard | 0–30 |
| `secondary_days_used` | SecondaryDrugFrequency | A, D, U | conditional | 0–30 |
| `alcohol_days` | AlcoholUseDays | A, D, U | standard | 0–30 |
| `iv_use_30` | NeedleUsePast30Days | A, D, U | standard | code set YES_NO |
| `employment_status` | CurrentEmploymentStatus | A, D, U | standard | code set EMPLOYMENT |
| `paid_work_days` | DaysPaidForWorkPast30 | A, D, U | standard | 0–30 |
| `school_enrolled` | EnrolledInSchool | A, D, U | standard | code set YES_NO |
| `job_training` | EnrolledInJobTraining | A, D, U | standard | code set YES_NO |
| `living_arrangement` | LivingArrangement | A, D, U | standard | code set LIVING |
| `arrests_30` | ArrestsPast30Days | A, D, U | standard | 0–99 |
| `jail_days_30` | JailDaysPast30 | A, D, U | standard | 0–30 |
| `prison_days_30` | PrisonDaysPast30 | A, D, U | standard | 0–30 |
| `er_visits_30` | EmergencyRoomVisitsPast30 | A, D, U | standard | 0–99 |
| `hospital_nights_30` | HospitalOvernightStaysPast30 | A, D, U | standard | 0–30 |
| `physical_health_days_30` | PhysicalHealthProblemDaysPast30 | A, D, U | standard | 0–30 |
| `mh_diagnosis` | DiagnosedMentalIllness | A, D, U | standard | code set YES_NO_UNKNOWN |
| `mh_er_visits_30` | MentalHealthERVisitsPast30 | A, D, U | standard | 0–99 |
| `psych_inpatient_days_30` | PsychiatricInpatientDaysPast30 | A, D, U | standard | 0–30 |
| `psych_meds` | PrescribedPsychiatricMedication | A, D, U | standard | code set YES_NO |
| `family_conflict_days_30` | FamilyConflictDaysPast30 | A, D, U | standard | 0–30 |
| `social_support_days_30` | SocialSupportRecoveryDaysPast30 | A, D, U | standard | 0–30 |
| `lives_with_user` | LivesWithSubstanceUser | A, D, U | standard | code set YES_NO |

## Code sets (to verify)

**ADMISSION_TRANSACTION**: `1` Initial admission; `2` Transfer or change in service (same provider)

**SERVICE_TYPES**: `01` Outpatient (ASAM 1.0); `02` Intensive outpatient (ASAM 2.1); `03` Partial hospitalization (ASAM 2.5); `04` Residential, clinically managed low intensity (ASAM 3.1); `05` Residential, population-specific high intensity (ASAM 3.3); `06` Residential, clinically managed high intensity (ASAM 3.5); `07` Inpatient, medically monitored (ASAM 3.7); `08` Withdrawal management, ambulatory (1-WM / 2-WM); `09` Withdrawal management, residential (3.2-WM); `10` Withdrawal management, inpatient (3.7-WM / 4-WM); `11` Narcotic treatment program — maintenance; `12` Narcotic treatment program — detoxification; `13` Recovery services

**REFERRAL_SOURCES**: `01` Individual (self); `02` Alcohol or drug treatment provider; `03` Other health care provider; `04` School; `05` Employer / EAP; `06` Other community referral; `07` Court or criminal justice (not DUI); `08` DUI / DWI; `09` Probation; `10` Parole; `11` Drug court; `12` PC 1000 (deferred entry of judgment); `13` Dependency court / child welfare services; `14` CalWORKs / social services; `15` Mental health provider; `16` Hospital or emergency department

**DRUGS**: `00` None; `01` Heroin; `02` Alcohol; `03` Barbiturates; `04` Other sedatives or hypnotics; `05` Methamphetamine; `06` Other amphetamines; `07` Other stimulants; `08` Cocaine / crack; `09` Marijuana / hashish; `10` PCP; `11` Other hallucinogens; `12` Tranquilizers (benzodiazepines); `13` Other tranquilizers; `14` Non-prescription methadone; `15` Oxycodone / OxyContin; `16` Other opiates or synthetics; `17` Inhalants; `18` Over-the-counter; `19` Ecstasy (MDMA); `20` Other club drugs; `21` Fentanyl; `99` Other

**ROUTES**: `1` Oral; `2` Smoking; `3` Inhalation (nasal); `4` Injection; `5` Other

**YES_NO**: `Y` Yes; `N` No

**YES_NO_DECLINED**: `Y` Yes; `N` No; `D` Declined to state

**YES_NO_UNKNOWN**: `Y` Yes; `N` No; `U` Unknown

**SEX_AT_BIRTH**: `M` Male; `F` Female; `X` Intersex / another sex; `D` Declined to state

**GENDER_IDENTITY**: `1` Male; `2` Female; `3` Transgender man / trans masculine; `4` Transgender woman / trans feminine; `5` Genderqueer / non-binary; `6` Another gender identity; `7` Declined to state

**RACES**: `01` White; `02` Black or African American; `03` American Indian; `04` Alaska Native; `05` Asian Indian; `06` Cambodian; `07` Chinese; `08` Filipino; `09` Guamanian; `10` Native Hawaiian; `11` Japanese; `12` Korean; `13` Laotian; `14` Samoan; `15` Vietnamese; `16` Other Asian; `17` Other Pacific Islander; `18` Other; `19` Declined to state

**ETHNICITIES**: `01` Mexican / Mexican American / Chicano; `02` Puerto Rican; `03` Cuban; `04` Other Hispanic or Latino; `05` Not Hispanic or Latino; `06` Declined to state

**DISABILITIES**: `1` None; `2` Visual; `3` Hearing; `4` Speech; `5` Mobility; `6` Mental; `7` Developmental; `8` Other; `9` Declined to state

**EMPLOYMENT**: `1` Employed full time (35+ hours a week); `2` Employed part time; `3` Unemployed, looking for work; `4` Unemployed, not looking for work; `5` Not in the labor force (student, homemaker, retired, disabled, incarcerated)

**LIVING**: `1` Homeless; `2` Dependent living (supervised, or with family); `3` Independent living

**DISCHARGE_STATUS**: `1` Completed treatment / recovery plan goals — referred; `2` Completed treatment / recovery plan goals — not referred; `3` Left before completion with satisfactory progress — standard questions; `4` Left before completion with satisfactory progress — administrative questions; `5` Left before completion with unsatisfactory progress — standard questions; `6` Left before completion with unsatisfactory progress — administrative questions; `7` Death; `8` Incarceration


## Edit checks

**Fatal** errors block saving the record (except the two cross-record ones marked †, which only block the
extract) and always hold the record back from the extract. **Warnings** are listed but do not block.

| Code | Severity | Rule |
| --- | --- | --- |
| `required` | fatal | A required element is blank (per record type; conditional ones below) |
| `invalid_code` / `too_many_codes` / `duplicate_code` | fatal | Not in the code set; more than 5 answers; the same answer twice |
| `out_of_range` / `not_a_number` | fatal | Counts and days outside their range (e.g. days in past 30: 0–30) |
| `zip_invalid`, `date_invalid` | fatal | ZIP not 5 digits; a date that is not a real date |
| `provider_missing` / `provider_unknown` | fatal | No provider ID, or one not configured for the program |
| `date_future` | fatal | Record date after today |
| `dob_missing` | fatal | Admission for a client with no date of birth |
| `admission_before_birth` | fatal | Admission date before the date of birth |
| `age_out_of_range` | fatal | Age at admission over 110 |
| `age_under_12` | warning | Age at admission under 12 |
| `first_use_after_admission` | fatal | Age of first use (primary or secondary) above the age at admission |
| `pregnant_not_female` | fatal | Pregnant = Yes when sex at birth is not Female |
| `primary_drug_none` | fatal | Primary drug = None |
| `secondary_same_as_primary` | fatal | Secondary drug equals the primary |
| conditional `required` | fatal | Secondary route and age of first use when there is a secondary drug; days used for it on later records |
| `secondary_days_without_drug` | fatal | Days secondary drug used > 0 with no secondary drug |
| `needle_use_inconsistent` | fatal | Needle use in past 30 days but not in past 12 months |
| `children_cps_exceeds` | fatal | Children living with others by protective order > children under 18 |
| `exclusive_code_combined` | fatal | Disability "None"/"Declined", or race "Declined", combined with other answers |
| `jail_prison_over_30` | fatal | Jail + prison days in past 30 > 30 |
| `inpatient_over_30` | warning | Hospital nights + psychiatric inpatient days > 30 |
| `admission_date_differs` | warning | CalOMS admission date differs from the episode's start date |
| `discharge_before_admission` | fatal | Discharge date before the admission date |
| `last_service_outside_episode` | fatal | Date of last service outside admission – discharge |
| `annual_update_too_early` | fatal | Annual update more than 60 days before the first anniversary |
| `annual_update_after_discharge` | fatal | Annual update dated after the discharge |
| `no_admission` † | fatal | Discharge or annual update with no admission record |
| `admission_has_errors` † | fatal | Discharge or annual update whose admission has a fatal error |
| `missing_admission` | fatal (report) | Episode in the period with no admission record |
| `missing_discharge` | fatal (report) | Closed episode with no discharge record |
| `annual_update_overdue` / `annual_update_due` | fatal / warning (report) | Anniversary passed (+30 days) with no annual update / due now |

**Not validated** (to add once the dictionary is confirmed): DHCS's own cross-submission edits (duplicate
admissions across providers, a discharge for an admission DHCS never accepted, transaction sequencing),
element-level edits that depend on the service type (e.g. NTP-only elements), the place-of-birth and
identifier elements SUDS does not collect, and the exact submission deadlines.

## Validation report

**Reports → State reporting**: for the period, every record dated in it is checked, and every episode active
in it (opened on or after the start date) is checked for the records it should have. Each row gives severity,
client code, record, date, field and the problem — codes and field names only, never answers or names — and
can be downloaded as CSV. Anyone who can read episodes sees it for their own caseload (`GET /api/caloms/validation`).

## Preview, submission and how to submit

The files (in both the preview and the submission):

- `admissions.csv`, `discharges.csv`, `annual_updates.csv` — identifying columns (RecordType, ProviderID,
  ProviderClientID = SUDS client code, ClientLastName, ClientFirstName, DateOfBirth, AdmissionDate), the
  record date, then the elements in the order of the mapping table above. Multi-answer elements are split
  into numbered columns (Race1–Race5, Disability1–Disability5). Dates are `YYYY-MM-DD`.
- `provider_activity.csv` — ProviderID, ReportMonth (`YYYYMM`), counts, NoActivity.
- `README.txt` — the period, counts, how many records were held back, the layout version, this warning and
  the §2.32 notice.

Every record with a fatal error is held back from both.

**Download preview** (roles with `export:identified`: supervisors and administrators;
`GET /api/caloms/extract?from=&to=`) is for checking the file, and cannot be mistaken for, or submitted as,
the real one: it downloads as `caloms-tx-PREVIEW-NOT-FOR-SUBMISSION-<from>_<to>.zip`, every file in it is
named `PREVIEW-…`, its README opens with *PREVIEW - NOT FOR SUBMISSION*, and every record carries
`PREVIEW` / `NOT FOR SUBMISSION` where the client's name goes and no date of birth. It is therefore not an
identified file (client codes and coded answers only): it is audited (`caloms.extract`, `preview: true`),
nobody's accounting changes and no record is marked as sent.

**Produce submission file** (`POST /api/caloms/submissions` with the period, `export:identified`) is the
disclosure. The file is built **once**, at that moment, and kept (table `caloms_submissions`: the zip
encrypted, its SHA-256, the period, counts and who produced it). In the same transaction each client in it
gets an accounting-of-disclosures row — basis **state_reporting**, source `caloms`, `source_ref`
`caloms:<submission id>`, recipient *California Department of Health Care Services (DHCS) — CalOMS Tx*,
purpose *State reporting (CalOMS Tx)…*, and what was sent names the file and its SHA-256 — and each included
record gets `extracted_at`. A submission naming more clients than `mass_export_threshold` opens a draft
mass-export incident. The page then downloads the file, `GET /api/caloms/submissions/:id/file`, which
serves exactly the stored bytes (checked against the stored SHA-256, sent in `X-SUDS-SHA256`; audited as
`caloms.submission.download` with the hash; a large file opens the mass-export incident again for review).
A record edited after the submission changes nothing in that file: what goes to DHCS is what was accounted.
`GET /api/caloms/submissions` lists what was produced (period, counts, hash, who and when — never names).
The stored file is kept for 90 days (`CALOMS_FILE_DAYS` in `server/retention.js`) and removed earlier if a
client in it is purged; the submission's row and hash remain, and the file endpoint answers `410`.
The audit log records counts and hashes, never names. The legal characterisation used
(`server/disclosure.js`): a disclosure required by law under HIPAA 45 CFR §164.512(a) (still subject to the
§164.528 accounting), and under 42 CFR Part 2 a disclosure to the state agency that funds and regulates the
program (§2.53) — **county counsel should confirm the Part 2 basis**.

County process:
1. Before the monthly deadline, open State reporting for last month and clear every fatal error.
2. Download the preview to check the file (it holds back anything still in error; fix and preview again).
3. Produce the submission file, and send that file unchanged (its SHA-256 is on the State reporting page).
   Convert to the DHCS upload format if the county's channel is not CSV, and upload through the county's
   CalOMS Tx process. Submit the provider activity / no-activity report for months with nothing to report.
4. Correct anything DHCS rejects in SUDS. A discharge removed by re-admission after it was extracted must
   also be corrected with DHCS.
