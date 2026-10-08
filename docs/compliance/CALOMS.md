# CalOMS Tx reporting in SUDS

> **Status: code values VERIFIED 2026-10-05 against the DHCS *CalOMS Tx Data Dictionary*, File Version 3.0
> (October 2024).** Every code set in `server/caloms-spec.js` now carries the dictionary's values
> (asserted in `test/caloms-dictionary.test.js`); the verification report is
> [docs/evidence/caloms-dictionary-verification.md](evidence/caloms-dictionary-verification.md), and the
> 1.25.0 correction is described below. The dictionary copy used is the October 2024 v3.0 PDF
> (SHA-256 recorded in the report). Two corrections to the report itself came out of the
> PDF re-check: the report's ADM-5 referral labels were wrong (the dictionary's 14 values are now in
> the spec), MHD-1 is `1`/`0`/`99900`/`99904` (not `99901`), MHD-4 is a 0–30 day count (not yes/no),
> EMPLOYMENT/LIVING labels follow the dictionary, and race allows at most 5 codes (CID-15 p.53) while
> disability allows 7 (CID-18 p.57).
>
> **Open item before the first submission:** the code *values* are verified, but the extract's column
> names and file layout are SUDS's own and have **not** been verified against the DHCS file
> specification. The county must convert the CSV files to the DHCS upload format if the county's
> channel needs something else (fixed-width / XML unconfirmed). The same holds for the provider activity
> report (`provider_activity.csv`, its `NoActivity` column `Y`/`N`): the dictionary has no element for it, so
> its format is SUDS's own and unverified. DHCS's own cross-submission edits
> (duplicates across providers, transaction sequencing) are the county's to clear as they come back.

## What SUDS does and does not do

| Does | Does not |
| --- | --- |
| Collect admission, discharge (standard and administrative) and annual update records for each episode of care | Submit to DHCS itself — the county uploads the files through its CalOMS channel. SUDS has no DHCS connection, API or credentials; it records the upload a person made |
| Run the edit checks below and list every problem by client code and field | Guarantee DHCS will accept a file (its own edits are authoritative) |
| Hold back every record with a fatal error from the extract | Produce the DHCS fixed-width / XML format, if that is what the county's channel needs (unconfirmed; CSV is produced) |
| Produce the monthly provider activity report, with "no activity" months | Collect the client identifiers not listed below (mother's first name, place of birth, SSN, birth name) — to verify whether the current dictionary requires them |
| Account for the extract as a disclosure required by law, per client | Bill anything (see `docs/SCOPE.md`) |

Funder reports (Reports → Funder report) are **not** a substitute for CalOMS: they count people and services;
CalOMS is a per-episode record set the state defines.

## Switching it on

**Reports → State reporting → Settings** (administrators): tick *This program reports CalOMS Tx*, list the
CalOMS provider ID(s) DHCS assigned (one per line, `ID, name`, optionally followed by `| legal name | NPI` — the
NPI's check digit is verified), and the date from which records are expected.
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

| Record | Code (TRN-1, dictionary p.104) | When | Carries |
| --- | --- | --- | --- |
| Admission | `1` | Each episode opened on or after the start date | Admission, client, substance-use and past-30-day elements |
| Discharge | `4` | When the episode is closed | Discharge status, date of last service; past-30-day elements for a standard discharge |
| Annual update | `7` | Each anniversary of the admission while the episode is open; accepted from 60 days before to 30 days after (window to verify) | Past-30-day elements |
| Provider activity | — (not a TRN-1 form type) | Every provider ID, every month of the extract period | Counts of 1/4/7; `NoActivity=Y` for a month with none (SUDS's own column, not in the dictionary) |

## What changed in 1.25.0 (the dictionary correction)

The spec had been built from the Data Collection Guide's structure "as generally known", without the
Data Dictionary. Every code value is now set from the dictionary (group-item and page cited in
`server/caloms-spec.js`):

- **Service types** are the dictionary's ADM-4 codes 1–7 (Non-Residential … Narcotic Treatment Program),
  not the old ASAM-style 01–13. The ASAM level SUDS records now only *suggests* a starting value
  (outpatient → 1, residential/inpatient → 2, OTP → 7); the worker confirms it.
- **Referral sources** are ADM-5 codes 1–14 (the dictionary's own list, which differs from the old one).
- **Yes/no is numeric**: every yes/no element is `1`/`0` with its per-element 999xx specials
  (99900 declined, 99901 not sure, 99904 unable — whichever the element allows). No dictionary element uses
  Y/N, and neither do the admission, discharge and annual update files. The provider activity report's
  `NoActivity` column does (`Y`/`N`): the dictionary does not govern it (*Preview, submission and how to
  submit*). (Until the evaluation of 1.25.0, E9, this said "There is no Y/N anywhere".)
- **Two "yes/no" fields are really day counts**: needle use in the past 30 days (ADU-10, 0–30) and days
  lived with someone who uses (SOC-3, 0–30); prescribed psychiatric medication is also a day count
  (MHD-4, 0–30).
- **Numeric elements accept the dictionary's 999xx alternative values** (declined / not sure / unable /
  not applicable, per element); the form offers them beside the number.
- **Four elements added**: criminal justice status (LEG-1), medication prescribed as part of treatment
  (MED-7, replacing the old MAT-planned yes/no), consent for future contact (CID-19, required) and sexual
  orientation (CID-20). Sex at birth is removed — the dictionary has no such element; gender is CID-3.
- **New edit checks from the dictionary**: veteran under 17 at admission; pregnant only when gender allows;
  criminal-justice status against the referral source (a DUI/AB-109/court referral means involvement);
  days with physical health problems > 0 when ER visits or hospital nights are reported; primary drug None
  not allowed on an admission.
- **Data migration 71** remaps stored answers to the new codes (Y/N→1/0, unpadded drug codes, the service
  and referral remaps, etc.). Answers with no dictionary counterpart (e.g. "Yes" to a question that is now
  a day count) are dropped so validation flags them for the worker to re-ask; out-of-range numbers are kept
  so the edit checks flag them. A list that maps two old codes to one new code keeps it once: old race 17
  (Other Pacific Islander) and 18 (Other) both become 17 (Other Race). As released in 1.25.0 the migration kept
  both (`["17","17"]`, a fatal duplicate the worker never entered; evaluation of 1.25.0, E7); SUDS now reads and
  saves race and disability as distinct codes, so a record migrated that way is read, checked and extracted as
  `["17"]`, and stored that way the next time it is saved. A repeated code is never an error. The migration is
  **not idempotent** (race 18 and 19, gender 6 and referral sources 10–14 are codes in both sets with different
  meanings) and runs exactly once: SUDS stamps schema 71 in the transaction that runs it, and a released
  migration can never move (`scripts/migration-order.js`, `test/migrations.test.js`).

### Upgrading from 1.24.x or earlier: re-ask every old admission

After the upgrade, **every admission recorded before 1.25.0 has fatal errors** until someone re-asks it, because
the four elements 1.25.0 added are required on every admission and no old admission has them: medication
prescribed as part of treatment (MED-7), criminal justice status (LEG-1), sexual orientation (CID-20) and consent
for future contact (CID-19). Each shows as "… is required" on the validation report and the worklist, and the
record is held back from the submission file, with every discharge and annual update that follows it
(`admission_has_errors`). The answers migration 71 dropped (a "Yes" to a question that is now a day count; an
"Unknown" mental-illness diagnosis) are listed the same way. Expect several rows per old admission, one per
missing answer: an evaluation upgrade showed 42 worklist rows for 3 records. Before the next monthly file, ask
each client with an open episode, record the answers on the client's Episodes tab (**CalOMS records**), and work
the worklist to empty. The worklist on State reporting says this in one line.

## Field mapping

Records: A = admission, D = discharge, U = annual update. Required: *yes* always; *standard* on admissions,
annual updates and standard discharges; *conditional* see the edit checks. "Values" gives the dictionary
element; the 999xx codes are the alternative values the element accepts instead of a number. The extract
column names are SUDS's own (open item above).

| SUDS key | Extract column | Records | Required | Values (dictionary element) |
| --- | --- | --- | --- | --- |
| `admission_transaction` | AdmissionTransactionType | A | yes | `1`–`2` |
| `service_type` | TypeOfService | A | yes | ADM-4: `1`–`7` |
| `referral_source` | ReferralSource | A | yes | ADM-5: `1`–`14` |
| `days_waited` | DaysWaitedToEnterTreatment | A | yes | ADM-6: 0–999, or 99901/99904 |
| `prior_episodes` | NumberOfPriorTreatmentEpisodes | A | yes | ADM-7: 0–99, or 99900/99901/99904 |
| `medication` | MedicationPrescribedAsPartOfTreatment | A | yes | MED-7: `1`–`5`, 99903 |
| `calworks` | CalWORKsRecipient | A | yes | ADM-8: `1`/`0`/`99901` |
| `criminal_justice` | CriminalJusticeStatus | A | yes | LEG-1: `1`–`7`, 99904 |
| `gender_identity` | GenderIdentity | A | yes | CID-3: `1`–`6`, 99900/99903 |
| `sexual_orientation` | SexualOrientation | A | yes | CID-20: `1`–`6`,`8`–`12` |
| `race` | Race1–5 | A | yes | CID-15: `01`–`19`, 99900 (up to 5) |
| `ethnicity` | Ethnicity | A | yes | CID-16: `1`–`6`, 99900 |
| `veteran` | VeteranStatus | A | yes | CID-17: `1`/`0`/99900/99904 |
| `disability` | Disability1–7 | A | yes | CID-18: `1`–`8`, 99900/99904 (up to 7) |
| `zip_code` | ZipCodeAtAdmission | A | yes | CID-8: 5 digits, 00000, XXXXX or ZZZZZ |
| `education_grade` | HighestSchoolGradeCompleted | A | yes | EMP-5: 0–30, or 99900/99904 |
| `children_under_18` | NumberOfChildrenUnder18 | A | yes | SOC-5: 0–30, or 99904 |
| `children_cps` | ChildrenLivingWithOthersDueToCPS | A | yes | SOC-7: 0–30, or 99904 |
| `pregnant` | PregnantAtAdmission | A | yes | MED-5: `1`/`0`/`99901` |
| `consent` | ConsentForFutureContact | A | yes | CID-19: `1`/`0` (required element) |
| `primary_drug` | PrimaryDrug | A | yes | ADU-1a: `0`–`20`, 99901/99903 |
| `primary_route` | PrimaryDrugRoute | A | yes | ADU-3: `1`–`4`, 99902/99903 |
| `primary_age_first_use` | PrimaryDrugAgeOfFirstUse | A | yes | ADU-4: 5–105, or 99904 |
| `secondary_drug` | SecondaryDrug | A | yes | ADU-1a: `0`–`20`, 99901/99903 |
| `secondary_route` | SecondaryDrugRoute | A | conditional | ADU-3: `1`–`4`, 99902/99903 |
| `secondary_age_first_use` | SecondaryDrugAgeOfFirstUse | A | conditional | ADU-4: 5–105, or 99904 |
| `iv_use_12m` | NeedleUsePast12Months | A | yes | ADU-11: `1`/`0`/`99904` |
| `discharge_status` | DischargeStatus | D | yes | DIS-2: `1`–`8` |
| `last_service_date` | DateOfLastService | D | yes | date |
| `primary_days_used` | PrimaryDrugFrequency | A, D, U | standard | ADU-2: 0–30, or 99902 |
| `secondary_days_used` | SecondaryDrugFrequency | A, D, U | conditional | ADU-2: 0–30, or 99902 |
| `alcohol_days` | AlcoholUseDays | A, D, U | standard | 0–30, or 99902 |
| `iv_use_30` | NeedleUsePast30Days | A, D, U | standard | ADU-10: 0–30, or 99900/99904 |
| `employment_status` | CurrentEmploymentStatus | A, D, U | standard | EMP-1: `1`–`5` |
| `paid_work_days` | DaysPaidForWorkPast30 | A, D, U | standard | EMP-2: 0–30, or 99900/99904 |
| `school_enrolled` | EnrolledInSchool | A, D, U | standard | EMP-3: `1`/`0`/99900/99904 |
| `job_training` | EnrolledInJobTraining | A, D, U | standard | EMP-4: `1`/`0`/99900/99904 |
| `living_arrangement` | LivingArrangement | A, D, U | standard | SOC-2: `1`–`3` |
| `arrests_30` | ArrestsPast30Days | A, D, U | standard | LEG-3: 0–30, or 99904 |
| `jail_days_30` | JailDaysPast30 | A, D, U | standard | LEG-4: 0–30, or 99904 |
| `prison_days_30` | PrisonDaysPast30 | A, D, U | standard | LEG-5: 0–30, or 99904 |
| `er_visits_30` | EmergencyRoomVisitsPast30 | A, D, U | standard | MED-2: 0–99, or 99904 |
| `hospital_nights_30` | HospitalOvernightStaysPast30 | A, D, U | standard | MED-3: 0–30, or 99904 |
| `physical_health_days_30` | PhysicalHealthProblemDaysPast30 | A, D, U | standard | MED-4: 0–30, or 99904 |
| `mh_diagnosis` | DiagnosedMentalIllness | A, D, U | standard | MHD-1: `1`/`0`/99900/99904 |
| `mh_er_visits_30` | MentalHealthERVisitsPast30 | A, D, U | standard | MHD-2: 0–99, or 99904 |
| `psych_inpatient_days_30` | PsychiatricInpatientDaysPast30 | A, D, U | standard | MHD-3: 0–30, or 99904 |
| `psych_meds` | MentalHealthMedicationDaysPast30 | A, D, U | standard | MHD-4: 0–30, or 99904 |
| `family_conflict_days_30` | FamilyConflictDaysPast30 | A, D, U | standard | SOC-4: 0–30, or 99900/99904 |
| `social_support_days_30` | SocialSupportRecoveryDaysPast30 | A, D, U | standard | SOC-1: 0–30 |
| `lives_with_user` | LivesWithSubstanceUser | A, D, U | standard | SOC-3: 0–30, or 99900/99904 |

## Code sets

Every value below is the DHCS Data Dictionary v3.0 wording (see `server/caloms-spec.js` for the
per-set dictionary citations).

**ADMISSION_TRANSACTION**: `1` Initial Admission; `2` Transfer or Change in Service

**SERVICE_TYPES** (ADM-4): `1` Non-Residential; `2` Residential; `3` Non-Residential Detox; `4` Residential Detox; `5` Non-Residential Detox Observation; `6` Residential Detox Observation; `7` Narcotic Treatment Program

**REFERRAL_SOURCES** (ADM-5): `1` Individual, including self-referral; `2` Alcohol / Drug Abuse Program; `3` Other Health Care Provider; `4` School / Educational; `5` Employer / EAP; `6` 12 Step Mutual Aid; `7` Probation or Parole; `8` Post-Release Community Supervision (AB 109); `9` DUI / DWI; `10` Adult Felon Drug Court; `11` Dependency Drug Court; `12` Court / Criminal Justice; `13` Other Community Referral; `14` Child Protective Services

**DRUGS** (ADU-1a): `0` None; `1` Heroin; `2` Alcohol; `3` Barbiturates; `4` Other Sedatives or Hypnotics; `5` Methamphetamine; `6` Other Amphetamines; `7` Other Stimulants; `8` Cocaine / Crack; `9` Marijuana / Hashish; `10` PCP; `11` Other Hallucinogens; `12` Tranquilizers (Benzodiazepine); `13` Other Tranquilizers; `14` Non-Prescription Methadone; `15` OxyCodone / OxyContin; `16` Other Opiates or Synthetics; `17` Inhalants; `18` Over-the-Counter; `19` Ecstasy; `20` Other Club Drugs; `99901` Unknown / not sure / don't know (administrative discharges only); `99903` Other

**ROUTES** (ADU-3): `1` Oral; `2` Smoking; `3` Inhalation; `4` Injection (IV or intramuscular); `99902` None or not applicable; `99903` Other

**GENDER_IDENTITY** (CID-3): `1` Male; `2` Female; `3` Transgender (Trans Man); `4` Transgender (Trans Woman); `5` Gender Non-Conforming / Gender Queer; `6` Not Available; `99900` Client declined to state; `99903` Other

**SEXUAL_ORIENTATION** (CID-20): `1` Heterosexual / Straight; `2` Lesbian (female); `3` Gay (male); `4` Bisexual; `5` Unsure / Questioning; `6` Declined to state; `8` Pansexual; `9` Asexual; `10` Other; `11` Not Available; `12` Queer (value 7 retired 2024-09-24)

**RACES** (CID-15): `01` White / Caucasian; `02` Black / African-American; `03` American Indian; `04` Alaska Native; `05` Asian Indian; `06` Cambodian; `07` Chinese; `08` Filipino; `09` Guamanian; `10` Hawaiian; `11` Japanese; `12` Korean; `13` Laotian; `14` Samoan; `15` Vietnamese; `16` Other Asian; `17` Other Race; `18` Multi Racial; `19` Race Not Available; `99900` Client declined to state

**ETHNICITIES** (CID-16): `1` Not Hispanic; `2` Mexican / Mexican American; `3` Cuban; `4` Puerto Rican; `5` Other Hispanic / Latino; `6` Hispanic or Latino Origin Not Available; `99900` Client declined to state

**DISABILITIES** (CID-18): `1` None; `2` Visual; `3` Hearing; `4` Speech; `5` Mobility; `6` Mental; `7` Developmentally Disabled; `8` Other Disability (not SUD); `99900` Client declined to state; `99904` Client unable to answer

**CRIMINAL_JUSTICE** (LEG-1): `1` No criminal justice involvement; `2` Under parole supervision by CDCR; `3` On parole from any other jurisdiction; `4` Post-release Community Supervision (AB 109) or on probation; `5` Admitted under other diversion (CA Penal Code §1000); `6` Incarcerated; `7` Awaiting trial, charges or sentencing; `99904` Client unable to answer

**MEDICATIONS** (MED-7): `1` None; `2` Methadone; `3` LAAM; `4` Buprenorphine (Subutex); `5` Buprenorphine (Suboxone); `99903` Other

**CONSENT** (CID-19): `1` Yes; `0` No

**CALWORKS** (ADM-8) / **PREGNANT** (MED-5): `1` Yes; `0` No; `99901` Not sure / don't know

**IV_USE_12M** (ADU-11): `1` Yes; `0` No; `99904` Client unable to answer

**SCHOOL_ENROLLED** (EMP-3/EMP-4) / **VETERAN** (CID-17) / **MH_DIAGNOSIS** (MHD-1): `1` Yes; `0` No; `99900` Client declined to state; `99904` Client unable to answer

**EMPLOYMENT** (EMP-1): `1` Employed Full time (35 hours or more); `2` Employed Part time (less than 35 hrs.); `3` Unemployed, looking for work; `4` Unemployed, not in the labor force (not seeking); `5` Not in the labor force (Not seeking)

**LIVING** (SOC-2): `1` Homeless; `2` Dependent living; `3` Independent living

**DISCHARGE_STATUS** (DIS-2): `1` Completed Treatment Plan & Goals / Referred / Standard (all questions); `2` Completed Treatment Plan & Goals / Not Referred / Standard (all questions); `3` Left Before Completion w/ Satisfactory Progress / Referred / Standard (all questions); `4` Left Before Completion w/ Satisfactory Progress / Administrative (minimum questions); `5` Left Before Completion w/ Unsatisfactory Progress / Referred / Standard (all questions); `6` Left Before Completion w/ Unsatisfactory Progress / Administrative (minimum questions); `7` Death; `8` Incarceration

The 999xx alternative values on numeric elements: `99900` Client declined to state; `99901` Not sure / don't know; `99902` None or not applicable; `99904` Client unable to answer.


## Edit checks

**Fatal** errors block saving the record (except the two cross-record ones marked †, which only block the
extract) and always hold the record back from the extract. **Warnings** are listed but do not block.

| Code | Severity | Rule |
| --- | --- | --- |
| `required` | fatal | A required element is blank (per record type; conditional ones below) |
| `invalid_code` / `too_many_codes` / `duplicate_code` | fatal | Not in the code set; more than the element's maximum answers (race 5, disability 7); the same answer twice |
| `out_of_range` / `not_a_number` | fatal | Counts and days outside their range (or not a 999xx alternative the element allows) |
| `zip_invalid`, `date_invalid` | fatal | ZIP not 5 digits, 00000, XXXXX or ZZZZZ; a date that is not a real date |
| `provider_missing` / `provider_unknown` | fatal | No provider ID, or one not configured for the program |
| `date_future` | fatal | Record date after today |
| `dob_missing` | fatal | Admission for a client with no date of birth |
| `admission_before_birth` | fatal | Admission date before the date of birth |
| `age_out_of_range` | fatal | Age at admission over 110 |
| `age_under_12` | warning | Age at admission under 12 |
| `first_use_after_admission` | fatal | Age of first use (primary or secondary) above the age at admission |
| `veteran_under_17` | fatal | Veteran = Yes when the client is under 17 at admission (CID-17 rule 2) |
| `pregnant_not_possible` | fatal | Pregnant = Yes when gender is Male or Transgender (Trans Woman) (MED-6 rule 2) |
| `primary_drug_none` | fatal | Primary drug = None on an admission (ADU-1a rule 2) |
| `secondary_same_as_primary` | fatal | Secondary drug equals the primary |
| conditional `required` | fatal | Secondary route and age of first use when there is a secondary drug; days used for it on later records |
| `secondary_days_without_drug` | fatal | Days secondary drug used > 0 with no secondary drug |
| `needle_use_inconsistent` | fatal | Days of needle use in the past 30 but no needle use in the past 12 months |
| `cj_status_referral_conflict` | fatal | Criminal justice status "No involvement" with a criminal-justice referral source (LEG-1 rule 3) |
| `cj_status_ab109` | fatal | Post-Release Community Supervision (AB 109) referral without the AB 109 criminal justice status |
| `cj_unable_restricted` | fatal | Criminal justice status "unable to answer" outside a detox service or developmental disability (LEG-1 rule 2) |
| `children_cps_exceeds` | fatal | Children living with someone else by protective order > number of children |
| `exclusive_code_combined` | fatal | Disability None/declined/unable, or race Not Available/declined, combined with other answers |
| `jail_prison_over_30` | fatal | Jail + prison days in past 30 > 30 |
| `inpatient_over_30` | warning | Hospital nights + psychiatric inpatient days > 30 |
| `health_days_zero` | fatal | ER visits or hospital nights reported but 0 days with physical health problems (MED-4 rule 3) |
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

**Not validated**: DHCS's own cross-submission edits (duplicate admissions across providers, a discharge for
an admission DHCS never accepted, transaction sequencing — TRN-1 resubmission/deletion types 2, 3, 5, 6, 8, 9,
which SUDS does not produce), the place-of-birth and identifier elements SUDS does not collect, and the exact
submission deadlines.

## Validation report

**Reports → State reporting**: for the period, every record dated in it is checked, and every episode active
in it (opened on or after the start date) is checked for the records it should have. Each row gives severity,
client code, record, date, field and the problem — codes and field names only, never answers or names — and
can be downloaded as CSV. Anyone who can read episodes sees it for their own caseload (`GET /api/caloms/validation`).

## Preview, submission and how to submit

The files (in both the preview and the submission):

- `admissions.csv`, `discharges.csv`, `annual_updates.csv` — identifying columns (RecordType as the
  TRN-1 code — 1 admission, 4 discharge, 7 annual update — ProviderID, ProviderClientID = SUDS client code,
  ClientLastName, ClientFirstName, DateOfBirth, AdmissionDate), the record date, then the elements in the
  order of the mapping table above. Multi-answer elements are split into numbered columns (Race1–Race5,
  Disability1–Disability7). Dates are `YYYY-MM-DD`. Column names are SUDS's own (open item above).
- `provider_activity.csv` — ProviderID, ReportMonth (`YYYYMM`), counts, NoActivity (`Y` for a month with no
  admission, discharge or annual update, else `N`). This is SUDS's rendering of the provider activity /
  no-activity report (county process, step 3 below). The dictionary does not govern it: it has no
  provider-activity element, and its form types (TRN-1, p.104) are admission, discharge and annual update with
  their resubmissions and deletions only (docs/evidence/caloms-dictionary-verification.md). No document in this
  repository gives that report's format, so `Y`/`N` is kept rather than changed on a guess, and it is part of the
  unverified layout (the open item above): check it with the county's channel before the first submission.
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

## Monthly automation (1.17.0)

`server/caloms-schedule.js`; tests `test/caloms-automation.test.js`. **SUDS still does not submit anything to
DHCS**: there is no DHCS API, portal login or credential in SUDS. What it automates is the work around the upload.

**The monthly run** (State reporting → Settings → *Monthly run*: `caloms_schedule` `monthly`, `caloms_schedule_day`
1–28, administrators). Hourly housekeeping checks it; on or after that day of the month it runs once for the
previous calendar month: every record in the month is validated against every implemented edit check,
program-wide, and a **prepared** submission file is built for the records that pass — one file, or one per provider
ID when *One file per provider ID* is ticked (`caloms_split_by_provider`). *Check and prepare (not sent)* on the
page does the same for the period shown (`POST /api/caloms/schedule/run`, `export:identified`). The scheduled run is
idempotent per period and provider: a provider whose file it already made — still waiting to be produced, produced,
or discarded — is not prepared again, and a provider whose file could not be prepared (an error, logged) leaves the
month open, so the next hourly pass tries that provider again and only that one (engineering review of the 1.17.0
candidate, L2; since 1.17.1 a produced or discarded file counts too, M1). A discarded file counts on purpose: a
person decided against it, so the schedule does not silently make that month's file again; *Check and prepare*
makes a new one when it is wanted. The
run reads and checks the whole month on the server's main thread, once a month.

**Prepared is not produced.** A prepared file is built once and kept encrypted with its SHA-256, like a
submission, but nothing has left: nobody's accounting of disclosures changes and no record's `extracted_at` is
stamped. It cannot be downloaded. **Produce** (`POST /api/caloms/submissions/:id/produce`, `export:identified`) is
the disclosure, with exactly the semantics of a submission produced by hand: those bytes are accounted per client
under the state-reporting basis (`source_ref` `caloms:<id>`, the hash in *what*), the file's records are stamped
`extracted_at`, the mass-export check runs, and the file downloads. It is refused (409, with the count) when any
record in the file was changed or deleted after it was prepared, or has already been sent in another file (any
record with `extracted_at` set, since 1.17.1) — then **Discard** it
(`/discard`; the file is deleted, the row stays) and prepare again. Someone held to a caseload cannot prepare or
produce a program-wide file.

**The worklist** (`GET /api/caloms/worklist`, whoever reads episodes; *To fix before the next submission* on the
page): every validation problem, each assigned to the record's owner — whoever last saved the record, or for a
missing record the client's primary worker, else whoever opened the episode. A front-line worker sees *Mine*
first. Codes, field names and dates only, as the validation report.

**The submission log** (`caloms_submission_events`; *Log* on each submission, `GET /api/caloms/submissions/:id/events`):
prepared (by the schedule or a person), produced, each download, discarded, and **Record upload** — the date the
person uploaded it to DHCS and the confirmation or batch number the portal gave (`POST …/uploaded`; letters,
digits and `._/#-` only; the date may not be before the file was produced, as the log's *produced* entry dates it). The list of submissions shows status, origin, provider, downloads and the upload.

**County mode.** Each provider ID carries its legal name and NPI; `provider_id` on a submission, or the per-provider
monthly run, produces one provider's file (its records and its activity rows only; the README names the
provider). This is for one organisation reporting under several provider numbers. Several unrelated provider
organisations on one server is **not** supported — run one instance each; the design for more is
[docs/architecture/COUNTY-MULTI-TENANT.md](../architecture/COUNTY-MULTI-TENANT.md).

County process with the monthly run on:
1. On the configured day, the run prepares last month's file(s); the fatal errors are on each owner's worklist.
2. Owners fix their records. If any record in a prepared file changes, discard it and *Check and prepare* again.
3. Someone with `export:identified` produces each prepared file (the disclosure), and uploads the downloaded file
   to DHCS unchanged through the county's channel.
4. They record the upload with the portal's reference. The log then shows the whole chain.
