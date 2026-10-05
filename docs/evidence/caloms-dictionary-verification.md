# CalOMS Tx dictionary verification — SUDS code sets vs DHCS Data Dictionary

**Dictionary:** *CalOMS Tx Data Dictionary*, File Version 3.0, California Department of Health Care
Services, October 2024 (retrieved 2026-10-05 from the DHCS-published copy; local text extraction at
`/tmp/caloms-dict-2024.pdf` (1,624,464 bytes, PDF 1.6, SHA-256
`c726f8ab22d8d34ba14f6b77990632bc5d7462d6acb1f1f82a346ec229c8de12`).
**SUDS side:** `server/caloms-spec.js` (SETS object, 17 sets) plus `RECORD_CODE` and the FIELDS mapping.
**Scope:** code-value comparison only. Short factual data points with dictionary page numbers; no
dictionary passages reproduced.

**Headline: 4 of 17 sets match, 5 partially match, 8 are wrong (3 of them completely).**
The three completely wrong sets are SERVICE_TYPES, REFERRAL_SOURCES and ETHNICITIES; the systemic
finding is that the dictionary has no Y/N yes-no convention — every yes/no element is numeric
(1/0) with 999xx special values.

**Corrections to this report (2026-10-05, from the PDF re-check during the 1.25.0 fix):**
- MHD-4 (p.89) is a 0–30 day count with 99904 — not `1`/`0`/`99904` as written under YES_NO below.
- MHD-1 (p.86) is `1`/`0`/`99900`/`99904` — not `99901` as written under YES_NO_UNKNOWN below.
- MED-5 is on p.79 (not p.78).
- CID-15 race allows at most **5** codes (validation rule 2, p.53); only CID-18 disability allows 7.
- The EMPLOYMENT label drift noted under MATCH is corrected to the dictionary wording in the spec.

## MATCH (4)

- **ADMISSION_TRANSACTION** — dict ADM-2, p.11: `1` Initial Admission, `2` Transfer or Change in Service.
  Codes match. Label note only: SUDS adds "(same provider)", which the dictionary does not say.
- **EMPLOYMENT** — dict EMP-1, p.62: `1`–`5` match. Label drift on 4 (`Unemployed, not in the labor force
  (not seeking)`) and 5 (`Not in the labor force (Not seeking)`); SUDS labels are longer but equivalent.
- **LIVING** — dict SOC-2, p.92: `1` Homeless, `2` Dependent living, `3` Independent living. Match.
- **DISCHARGE_STATUS** — dict DIS-2, p.61: `1`–`8` match (completed/referred/standard; completed/not
  referred/standard; left satisfactory/referred/standard; left satisfactory/administrative; left
  unsatisfactory/referred/standard; left unsatisfactory/administrative; death; incarceration).

## PARTIAL — most codes match, specific deltas (5)

- **DRUGS** — dict ADU-1a p.21 / ADU-5a: codes `0`–`20` meanings match SUDS `00`–`20` (label variants only,
  e.g. dict `15` "OxyCodone / OxyContin", `19` "Ecstasy"). Deltas: SUDS `21` Fentanyl has **no dictionary
  code** — fentanyl must be reported as `99903` Other (specify in ADU-1b/5b); SUDS `99` Other → dict `99903`;
  SUDS missing `99901` Unknown (administrative discharges only). Format note: SUDS zero-pads (`00`–`21`);
  dictionary format is "N to NN or NNNNN" — whether padded codes are accepted in the submission file is
  unverified.
- **ROUTES** — dict ADU-3, p.25: `1` Oral, `2` Smoking, `3` Inhalation, `4` Injection (IV or intramuscular)
  match SUDS `1`–`4` (SUDS labels "Inhalation (nasal)" and "Injection" are narrower). Deltas: SUDS `5`
  Other → dict `99903`; SUDS missing `99902` None or not applicable (required when the drug is `0`/None,
  rule 4–5 p.25).
- **GENDER_IDENTITY** vs dict CID-3 Gender, p.40: SUDS `1`–`5` align (1 Male, 2 Female, 3 Transgender
  (Trans Man), 4 Transgender (Trans Woman), 5 Gender Non-Conforming / Gender Queer). Deltas: SUDS `6`
  "Another gender identity" vs dict `6` **Not Available**; SUDS `7` "Declined to state" vs dict `99900`
  Client declined to state; SUDS missing `99903` Other.
- **RACES** vs dict CID-15, pp.53–54: SUDS `01`–`16` meanings match (label variants: dict `01`
  "White / Caucasian", `02` "Black / African-American", `10` "Hawaiian"). Deltas: SUDS `17`
  "Other Pacific Islander" vs dict `17` **Other Race**; SUDS `18` "Other" vs dict `18` **Multi Racial**;
  SUDS `19` "Declined to state" vs dict `19` **Race Not Available**; SUDS missing `99900` Client declined
  to state. Also: dictionary allows up to **7** race codes (SUDS `MULTI_MAX` = 5), tilde-separated, p.53.
- **DISABILITIES** vs dict CID-18, p.57: SUDS `1`–`8` match (label variants: dict `7` "Developmentally
  Disabled", `8` "Other Disability (not SUD)"). Deltas: SUDS `9` "Declined to state" → dict `99900`;
  SUDS missing `99904` Client unable to answer (detox-only per rule 3, p.57). Also: dictionary allows up
  to **7** disability codes (SUDS allows 5).

## WRONG — systemic or complete (8)

- **SERVICE_TYPES** — dict ADM-4, p.13: allowable values are `1`–`7` only: `1` Nonresidential / Outpatient
  Treatment / Recovery; `2` Day Program intensive / IOT / Partial Hospitalization; `3` Outpatient
  Detoxification (non-medical); `4` Residential Detoxification (hospital / 24 hr); `5` Residential
  Detoxification (non-hospital); `6` Residential Treatment – short term (30 days or less); `7`
  Residential Treatment – long term (31 days or more). **None of SUDS's `01`–`13` ASAM-style codes exist
  in the dictionary.** Knock-on damage: the `FROM_SUDS.asam_level` mapping and every service-type-gated
  rule (e.g. detox = 3/4/5 references in CID-17 rule 3, CID-18 rule 3, ADU-11 rule 2) are built on the
  wrong codes.
- **REFERRAL_SOURCES** — dict ADM-5, p.14: `1` Individual, including self-referral; `2` Alcohol / Drug
  Abuse Program; `3` Other Health Care Provider; `4` School / Educational; `5` Employer / EAP; `6` 12 Step
  Mutual Aid; `7` Probation or Parole; `8` Post-Release Community Supervision (AB 109); `9` DUI / DWI;
  `10` Adult Felon Drug Court; `11` Dependency Drug Court; `12` Court / Criminal Justice; `13` Other
  Community Referral; `14` Child Protective Services. SUDS `01`–`16` match **neither** the current table
  **nor** the pre-October-2011 tables (pp.133–134): from `06` on the codes and meanings diverge
  (SUDS `06` = Other community referral vs dict `6` = 12 Step Mutual Aid; SUDS `08` = DUI/DWI vs dict
  `8` = AB 109; SUDS `12` = PC 1000 vs dict `12` = Court / Criminal Justice), and SUDS `15` (Mental
  health provider) and `16` (Hospital or emergency department) have no dictionary counterpart at all.
- **ETHNICITIES** — dict CID-16, p.55: `1` Not Hispanic; `2` Mexican / Mexican American; `3` Cuban;
  `4` Puerto Rican; `5` Other Hispanic / Latino; `6` Hispanic or Latino Origin Not Available; `99900`
  Client declined to state. Every SUDS code is shifted: SUDS `01` Mexican, `02` Puerto Rican, `03` Cuban,
  `04` Other Hispanic or Latino, `05` Not Hispanic or Latino, `06` Declined to state. SUDS `06` ≠ dict
  `6`; SUDS missing `99900`.
- **YES_NO** (`Y`/`N`) — used for mat_planned, calworks, pregnant, iv_use_12m, school_enrolled,
  job_training, psych_meds. The dictionary uses **no Y/N convention anywhere**: every yes/no element is
  numeric `1`/`0` with 999xx specials — ADM-8 p.17 (`1`/`0`/`99901`), MED-5 p.78 (`1`/`0`/`99901`),
  ADU-11 p.36 (`1`/`0`/`99904`), EMP-3 p.64 and EMP-4 p.65 (`1`/`0`/`99900`/`99904`), MHD-4 p.89
  (`1`/`0`/`99904`). Related: SUDS `mat_planned` maps to a column named "MedicationAssistedTreatmentPlanned";
  the dictionary's medication element is MED-7, p.80 (`1` None … `5` Buprenorphine (Suboxone), `99903`
  Other) — there is no such element name, and SUDS has no MED-7 field.
- **YES_NO_DECLINED** (`Y`/`N`/`D`) — used for veteran. Dict CID-17, p.56: `1` Yes, `0` No, `99900`
  Client declined to state, `99904` Client unable to answer.
- **YES_NO_UNKNOWN** (`Y`/`N`/`U`) — used for mh_diagnosis. Dict MHD-1, p.86: `1` Yes, `0` No, `99901`
  Not sure / don't know.
- **SEX_AT_BIRTH** (`M`/`F`/`X`/`D`) — **no such data element exists.** The dictionary's gender element is
  CID-3 (p.40, see GENDER_IDENTITY above). Both the element name "SexAtBirth" and the code set are
  invented; the `pregnant_not_female` edit check keys off a non-dictionary element.
- **RECORD_CODE** (`admission`→`A`, `discharge`→`D`, `annual_update`→`U`) — dict TRN-1 Type of Form, p.104:
  `1` Admission, `2` Resubmission of Admission, `3` Deletion of Admission, `4` Discharge, `5` Resubmission
  of Discharge, `6` Deletion of Discharge, `7` Annual Update, `8` Resubmission of Annual Update,
  `9` Deletion of Annual Update. No A/D/U convention; resubmission/deletion transaction types are not
  modeled in SUDS at all.

## Field-level (non-set) discrepancies

- **iv_use_30** uses YES_NO, but dict ADU-10 (p.35) is **0–30 days** of needle use + `99900`/`99904` —
  it is a days count, not yes/no.
- **lives_with_user** uses YES_NO, but dict SOC-3 Living With Someone (p.93) is **0–30 days** lived with
  someone who uses alcohol or drugs + `99900`/`99904`.
- **Numeric fields lack the 999xx special values** the dictionary allows: SUDS `days_waited` (0–999)
  vs ADM-6 p.15 (0–999 + `99901`/`99904`); `prior_episodes` (0–99) vs ADM-7 p.16 (0–99 +
  `99900`/`99901`/`99904`); `education_grade` (0–30) vs EMP-5 p.66 (0–30 + `99900`/`99904`);
  `primary_days_used`/`secondary_days_used` (0–30) vs ADU-2 p.24 (0–30 + `99902`); `paid_work_days`
  (0–30) vs EMP-2 p.63 (0–30 + `99900`/`99904`); `er_visits_30`/`mh_er_visits_30` (0–99) vs MED-2/MHD-2
  (0–99 + `99904`); `arrests_30`, `jail_days_30`, `prison_days_30`, `hospital_nights_30`,
  `physical_health_days_30`, `psych_inpatient_days_30`, `family_conflict_days_30`,
  `social_support_days_30` similarly lack the `99904` (unable to answer) / `99900` (declined) the
  dictionary permits. This is systemic: SUDS has no representation for declined/unable answers on any
  numeric element.
- **zip_code**: SUDS requires 5 digits with help text "00000 when homeless or unknown (to verify)". Dict
  CID-8, p.44: `00000` = homeless (or provider/location ZIP), `XXXXX` = client declines to state,
  `ZZZZZ` = client unable to answer. SUDS supports the homeless case but not XXXXX/ZZZZZ.
- **Column names are SUDS-invented.** The dictionary identifies elements by group-item number
  (ADM-2, CID-15, …); SUDS extract column names (SexAtBirth, GenderIdentity, CurrentEmploymentStatus,
  LivesWithSubstanceUser, DiagnosedMentalIllness, NeedleUsePast30Days, MedicationAssistedTreatmentPlanned,
  …) do not appear in the dictionary. Whether the county's upload channel expects these names, the
  group-item numbers, or a fixed-width layout must be checked against the channel, not this dictionary.
- **Elements SUDS does not collect** (coverage gaps, not code errors): LEG-1 Criminal Justice Status
  (p.67, `1`–`7` + `99904`); MED-7 Medication Prescribed as Part of Treatment (p.80); CID-19 Consent
  (p.58, required element, `1`/`0`); CID-20 Sexual Orientation (p.58); SSN/place-of-birth/mother's-name
  identifiers (already flagged in docs/compliance/CALOMS.md).

## Verification metadata

- Dictionary SHA (downloaded file): computed at verification time; extraction source
  `/tmp/caloms-dict-2024.pdf` (1,624,464 bytes, PDF 1.6).
- Pages cited are the dictionary's printed page numbers (footer "Page N"), File Version 3.0, Oct 2024.
- Report written 2026-10-05. No product code was changed.
