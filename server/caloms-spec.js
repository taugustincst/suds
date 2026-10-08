'use strict';
// CalOMS Tx (California Outcomes Measurement System, Treatment) — the record layout SUDS collects,
// validates and extracts. Everything a county might need to correct lives in this one file: the code sets,
// the data elements, which record types carry them and when they are required.
//
// SOURCE AND STATUS. Every code value below is taken from the DHCS "CalOMS Tx Data Dictionary"
// (File Version 3.0, October 2024); the dictionary group-item number and page are cited on each set and
// element. The record layout (which record types carry which elements, and the extract's column names)
// follows the DHCS Data Collection Guide structure as SUDS understands it and is NOT dictionary-verified:
// before the first submission the county must check the layout against the file specification DHCS issues.
// SPEC_VERSION is stamped into every extract so a file can always be traced to the table it was built from.
const SPEC_VERSION = 'SUDS CalOMS Tx layout 2026.2 (verified against DHCS CalOMS Tx Data Dictionary v3.0, Oct 2024)';
const SPEC_SOURCE = 'DHCS CalOMS Tx Data Dictionary, File Version 3.0, October 2024 (code values); record layout per the DHCS Data Collection Guide structure (not dictionary-verified — see docs/compliance/CALOMS.md)';

const set = (pairs) => pairs.map(([code, label]) => ({ code, label }));

const SETS = {
  ADMISSION_TRANSACTION: set([['1', 'Initial Admission'], ['2', 'Transfer or Change in Service']]),
  // ADM-4 Type of Service, dictionary p.13. A client in a Narcotic Treatment Program reports here; the
  // crosswalk on p.13 also lets an outpatient drug-free programme use code 1.
  SERVICE_TYPES: set([
    ['1', 'Non-Residential'], ['2', 'Residential'], ['3', 'Non-Residential Detox'], ['4', 'Residential Detox'],
    ['5', 'Non-Residential Detox Observation'], ['6', 'Residential Detox Observation'], ['7', 'Narcotic Treatment Program'],
  ]),
  // ADM-5 Source of Referral, dictionary p.14.
  REFERRAL_SOURCES: set([
    ['1', 'Individual, including self-referral'], ['2', 'Alcohol / Drug Abuse Program'],
    ['3', 'Other Health Care Provider'], ['4', 'School / Educational'], ['5', 'Employer / EAP'],
    ['6', '12 Step Mutual Aid'], ['7', 'Probation or Parole'], ['8', 'Post-Release Community Supervision (AB 109)'],
    ['9', 'DUI / DWI'], ['10', 'Adult Felon Drug Court'], ['11', 'Dependency Drug Court'],
    ['12', 'Court / Criminal Justice'], ['13', 'Other Community Referral'], ['14', 'Child Protective Services'],
  ]),
  // ADU-1a Primary Drug (Code), dictionary pp.21-22. Codes are NOT zero-padded. 99901 (unknown) is only
  // allowable for an administrative discharge; 99903 (other) is specified in ADU-1b. Fentanyl has no code
  // of its own and reports as 99903 Other.
  DRUGS: set([
    ['0', 'None'], ['1', 'Heroin'], ['2', 'Alcohol'], ['3', 'Barbiturates'], ['4', 'Other Sedatives or Hypnotics'],
    ['5', 'Methamphetamine'], ['6', 'Other Amphetamines'], ['7', 'Other Stimulants'], ['8', 'Cocaine / Crack'],
    ['9', 'Marijuana / Hashish'], ['10', 'PCP'], ['11', 'Other Hallucinogens'], ['12', 'Tranquilizers (Benzodiazepine)'],
    ['13', 'Other Tranquilizers'], ['14', 'Non-Prescription Methadone'], ['15', 'OxyCodone / OxyContin'],
    ['16', 'Other Opiates or Synthetics'], ['17', 'Inhalants'], ['18', 'Over-the-Counter'], ['19', 'Ecstasy'],
    ['20', 'Other Club Drugs'], ['99901', 'Unknown / not sure / don\u2019t know'], ['99903', 'Other'],
  ]),
  // ADU-3 Primary Drug Route of Administration, dictionary p.25.
  ROUTES: set([['1', 'Oral'], ['2', 'Smoking'], ['3', 'Inhalation'], ['4', 'Injection (IV or intramuscular)'],
    ['99902', 'None or not applicable'], ['99903', 'Other']]),
  // CID-3 Gender, dictionary p.40. There is no separate "sex at birth" element in the dictionary.
  GENDER_IDENTITY: set([['1', 'Male'], ['2', 'Female'], ['3', 'Transgender (Trans Man)'], ['4', 'Transgender (Trans Woman)'],
    ['5', 'Gender Non-Conforming / Gender Queer'], ['6', 'Not Available'],
    ['99900', 'Client declined to state'], ['99903', 'Other']]),
  // CID-20 Sexual Orientation, dictionary p.59. Value 7 ("Transgender") was retired 2024-09-24 and is skipped.
  SEXUAL_ORIENTATION: set([['1', 'Heterosexual / Straight'], ['2', 'Lesbian (female)'], ['3', 'Gay (male)'],
    ['4', 'Bisexual'], ['5', 'Unsure / Questioning'], ['6', 'Declined to state'], ['8', 'Pansexual'], ['9', 'Asexual'],
    ['10', 'Other'], ['11', 'Not Available'], ['12', 'Queer']]),
  // CID-15 Race, dictionary p.53. Codes ARE zero-padded; at most 5 may be indicated (validation rule 2).
  RACES: set([
    ['01', 'White / Caucasian'], ['02', 'Black / African-American'], ['03', 'American Indian'], ['04', 'Alaska Native'],
    ['05', 'Asian Indian'], ['06', 'Cambodian'], ['07', 'Chinese'], ['08', 'Filipino'], ['09', 'Guamanian'],
    ['10', 'Hawaiian'], ['11', 'Japanese'], ['12', 'Korean'], ['13', 'Laotian'], ['14', 'Samoan'], ['15', 'Vietnamese'],
    ['16', 'Other Asian'], ['17', 'Other Race'], ['18', 'Multi Racial'], ['19', 'Race Not Available'],
    ['99900', 'Client declined to state'],
  ]),
  // CID-16 Ethnicity, dictionary p.55.
  ETHNICITIES: set([['1', 'Not Hispanic'], ['2', 'Mexican / Mexican American'], ['3', 'Cuban'], ['4', 'Puerto Rican'],
    ['5', 'Other Hispanic / Latino'], ['6', 'Hispanic or Latino Origin Not Available'], ['99900', 'Client declined to state']]),
  // CID-18 Disability, dictionary p.57. Up to 7 codes, tilde-separated; 1, 99900 and 99904 are exclusive.
  DISABILITIES: set([['1', 'None'], ['2', 'Visual'], ['3', 'Hearing'], ['4', 'Speech'], ['5', 'Mobility'], ['6', 'Mental'],
    ['7', 'Developmentally Disabled'], ['8', 'Other Disability (not SUD)'],
    ['99900', 'Client declined to state'], ['99904', 'Client unable to answer']]),
  // LEG-1 Criminal Justice Status, dictionary p.66.
  CRIMINAL_JUSTICE: set([['1', 'No criminal justice involvement'],
    ['2', 'Under parole supervision by CDCR (California Department of Correction & Rehabilitation)'],
    ['3', 'On parole from any other jurisdiction'],
    ['4', 'Post-release Community Supervision (AB 109) or on probation from any federal, state, or local jurisdiction'],
    ['5', 'Admitted under other diversion from any court under CA Penal Code, Section 1000'],
    ['6', 'Incarcerated'], ['7', 'Awaiting trial, charges or sentencing'], ['99904', 'Client unable to answer']]),
  // MED-7 Medication Prescribed as a Part of Treatment, dictionary p.81. Required for NTP clients (p.13 note).
  MEDICATIONS: set([['1', 'None'], ['2', 'Methadone'], ['3', 'LAAM'], ['4', 'Buprenorphine (Subutex)'],
    ['5', 'Buprenorphine (Suboxone)'], ['99903', 'Other (only for medications prescribed for SUD treatment, e.g. Antabuse)']]),
  // CID-19 Consent, dictionary p.58: a required element, strictly 1/0.
  CONSENT: set([['1', 'Yes'], ['0', 'No']]),
  // Yes/no answers are numeric 1/0 in the dictionary, with per-element 999xx specials. There is no Y/N,
  // D or U anywhere.
  CALWORKS: set([['1', 'Yes'], ['0', 'No'], ['99901', 'Not sure / don\u2019t know']]),            // ADM-8, p.17
  PREGNANT: set([['1', 'Yes'], ['0', 'No'], ['99901', 'Not sure / don\u2019t know']]),            // MED-5, p.79
  IV_USE_12M: set([['1', 'Yes'], ['0', 'No'], ['99904', 'Client unable to answer']]),              // ADU-11, p.36
  SCHOOL_ENROLLED: set([['1', 'Yes'], ['0', 'No'], ['99900', 'Client declined to state'], ['99904', 'Client unable to answer']]), // EMP-3 p.64, EMP-4 p.65
  VETERAN: set([['1', 'Yes'], ['0', 'No'], ['99900', 'Client declined to state'], ['99904', 'Client unable to answer']]),         // CID-17, p.56
  MH_DIAGNOSIS: set([['1', 'Yes'], ['0', 'No'], ['99900', 'Client declined to state'], ['99904', 'Client unable to answer']]),    // MHD-1, p.86
  // EMP-1 Employment Status (labels as in the dictionary; SOC-2 Current Living Arrangements below it).
  EMPLOYMENT: set([['1', 'Employed Full time (35 hours or more)'], ['2', 'Employed Part time (less than 35 hrs.)'],
    ['3', 'Unemployed, looking for work'], ['4', 'Unemployed, not in the labor force (not seeking)'],
    ['5', 'Not in the labor force (Not seeking)']]),
  LIVING: set([['1', 'Homeless'], ['2', 'Dependent living'], ['3', 'Independent living']]),
  // DIS-2 Discharge Status (labels as in the dictionary). 1-3 and 5 are "standard" discharges (all
  // questions); 4, 6, 7 and 8 are "administrative" (minimum questions) — see ADMINISTRATIVE_DISCHARGE.
  DISCHARGE_STATUS: set([
    ['1', 'Completed Treatment Plan & Goals / Referred / Standard (all questions)'],
    ['2', 'Completed Treatment Plan & Goals / Not Referred / Standard (all questions)'],
    ['3', 'Left Before Completion w/ Satisfactory Progress / Referred / Standard (all questions)'],
    ['4', 'Left Before Completion w/ Satisfactory Progress / Administrative (minimum questions)'],
    ['5', 'Left Before Completion w/ Unsatisfactory Progress / Referred / Standard (all questions)'],
    ['6', 'Left Before Completion w/ Unsatisfactory Progress / Administrative (minimum questions)'],
    ['7', 'Death'], ['8', 'Incarceration'],
  ]),
};
// Labels for the 999xx "alternative values" a numeric element may carry instead of a number, shared across
// elements (the dictionary repeats them per element; the per-element lists are on FIELDS as `alt`).
const ALT_LABELS = {
  99900: 'Client declined to state',
  99901: 'Not sure / don\u2019t know',
  99902: 'None or not applicable',
  99904: 'Client unable to answer',
};
const ADMINISTRATIVE_DISCHARGE = ['4', '6', '7', '8'];
const RECORD_TYPES = ['admission', 'discharge', 'annual_update'];
// The multi-answer elements have different dictionary maxima (race: at most 5, CID-15 p.53; disability:
// at most 7, CID-18 p.57), so each multi field carries its own `multi_max`.
const MULTI_MAX = 7;

// Data elements. `in`: the record types that carry it. `req`: 'always' for every record type it is in,
// 'standard' for admissions, annual updates and standard (not administrative) discharges, or a function of
// (answers, context) for a conditional element. `name` is the column heading in the extract (CalOMS element
// name, to verify); `key` is what SUDS stores. `alt` lists the 999xx codes the element accepts instead of a
// number. Order here is extract column order. Dictionary citations are the group-item number and page.
const REP = ['admission', 'discharge', 'annual_update'];
const hasSecondary = (a, c) => { const s = c.record_type === 'admission' ? a.secondary_drug : (c.admission || {}).secondary_drug; return !!s && s !== '0'; };
const FIELDS = [
  // ---- admission: the episode ----
  { key: 'admission_transaction', name: 'AdmissionTransactionType', label: 'Admission type', set: 'ADMISSION_TRANSACTION', in: ['admission'], req: 'always', group: 'Admission' },
  { key: 'service_type', name: 'TypeOfService', label: 'Type of service', set: 'SERVICE_TYPES', in: ['admission'], req: 'always', group: 'Admission', dict: 'ADM-4 p.13' },
  { key: 'referral_source', name: 'ReferralSource', label: 'Referral source', set: 'REFERRAL_SOURCES', in: ['admission'], req: 'always', group: 'Admission', dict: 'ADM-5 p.14' },
  { key: 'days_waited', name: 'DaysWaitedToEnterTreatment', label: 'Days waited to enter treatment', type: 'int', min: 0, max: 999, alt: [99901, 99904], in: ['admission'], req: 'always', group: 'Admission', dict: 'ADM-6' },
  { key: 'prior_episodes', name: 'NumberOfPriorTreatmentEpisodes', label: 'Number of prior treatment episodes', type: 'int', min: 0, max: 99, alt: [99900, 99901, 99904], in: ['admission'], req: 'always', group: 'Admission', dict: 'ADM-7' },
  { key: 'medication', name: 'MedicationPrescribedAsPartOfTreatment', label: 'Medication prescribed as part of treatment', set: 'MEDICATIONS', in: ['admission'], req: 'always', group: 'Admission', dict: 'MED-7 p.81' },
  { key: 'calworks', name: 'CalWORKsRecipient', label: 'CalWORKs recipient', set: 'CALWORKS', in: ['admission'], req: 'always', group: 'Admission', dict: 'ADM-8 p.17' },
  { key: 'criminal_justice', name: 'CriminalJusticeStatus', label: 'Criminal justice status', set: 'CRIMINAL_JUSTICE', in: ['admission'], req: 'always', group: 'Admission', dict: 'LEG-1 p.66' },
  // ---- admission: about the client ----
  { key: 'gender_identity', name: 'GenderIdentity', label: 'Gender', set: 'GENDER_IDENTITY', in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-3 p.40' },
  { key: 'sexual_orientation', name: 'SexualOrientation', label: 'Sexual orientation', set: 'SEXUAL_ORIENTATION', in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-20 p.59' },
  { key: 'race', name: 'Race', label: 'Race (up to 5)', set: 'RACES', multi: true, multi_max: 5, in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-15 p.53' },
  { key: 'ethnicity', name: 'Ethnicity', label: 'Ethnicity', set: 'ETHNICITIES', in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-16 p.55' },
  { key: 'veteran', name: 'VeteranStatus', label: 'U.S. veteran', set: 'VETERAN', in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-17 p.56' },
  { key: 'disability', name: 'Disability', label: 'Disability (up to 7)', set: 'DISABILITIES', multi: true, multi_max: 7, in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-18 p.57' },
  { key: 'zip_code', name: 'ZipCodeAtAdmission', label: 'ZIP code of residence', type: 'zip', in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-8 p.44',
    help: '5 digits, or 00000 when homeless; XXXXX if the client declines to state, ZZZZZ if unable to answer.' },
  { key: 'education_grade', name: 'HighestSchoolGradeCompleted', label: 'Highest school grade completed (0-30)', type: 'int', min: 0, max: 30, alt: [99900, 99904], in: ['admission'], req: 'always', group: 'About the client', dict: 'EMP-5' },
  { key: 'children_under_18', name: 'NumberOfChildrenUnder18', label: 'Number of children', type: 'int', min: 0, max: 30, alt: [99904], in: ['admission'], req: 'always', group: 'About the client', dict: 'SOC-5' },
  { key: 'children_cps', name: 'ChildrenLivingWithOthersDueToCPS', label: 'Of those, living with someone else by child protective order', type: 'int', min: 0, max: 30, alt: [99904], in: ['admission'], req: 'always', group: 'About the client', dict: 'SOC-7' },
  { key: 'pregnant', name: 'PregnantAtAdmission', label: 'Pregnant at admission', set: 'PREGNANT', in: ['admission'], req: 'always', group: 'About the client', dict: 'MED-5 p.79' },
  { key: 'consent', name: 'ConsentForFutureContact', label: 'Consent form for future contact on file', set: 'CONSENT', in: ['admission'], req: 'always', group: 'About the client', dict: 'CID-19 p.58' },
  // ---- admission: substance use history ----
  { key: 'primary_drug', name: 'PrimaryDrug', label: 'Primary drug', set: 'DRUGS', in: ['admission'], req: 'always', group: 'Substance use', dict: 'ADU-1a pp.21-22' },
  { key: 'primary_route', name: 'PrimaryDrugRoute', label: 'Primary drug — usual route', set: 'ROUTES', in: ['admission'], req: 'always', group: 'Substance use', dict: 'ADU-3 p.25' },
  { key: 'primary_age_first_use', name: 'PrimaryDrugAgeOfFirstUse', label: 'Primary drug — age of first use', type: 'int', min: 5, max: 105, alt: [99904], in: ['admission'], req: 'always', group: 'Substance use', dict: 'ADU-4' },
  { key: 'secondary_drug', name: 'SecondaryDrug', label: 'Secondary drug (None if none)', set: 'DRUGS', in: ['admission'], req: 'always', group: 'Substance use', dict: 'ADU-1a pp.21-22' },
  { key: 'secondary_route', name: 'SecondaryDrugRoute', label: 'Secondary drug — usual route', set: 'ROUTES', in: ['admission'], req: hasSecondary, group: 'Substance use', dict: 'ADU-3 p.25' },
  { key: 'secondary_age_first_use', name: 'SecondaryDrugAgeOfFirstUse', label: 'Secondary drug — age of first use', type: 'int', min: 5, max: 105, alt: [99904], in: ['admission'], req: hasSecondary, group: 'Substance use', dict: 'ADU-4' },
  { key: 'iv_use_12m', name: 'NeedleUsePast12Months', label: 'Needle use in the past 12 months', set: 'IV_USE_12M', in: ['admission'], req: 'always', group: 'Substance use', dict: 'ADU-11 p.36' },
  // ---- discharge ----
  { key: 'discharge_status', name: 'DischargeStatus', label: 'CalOMS discharge status', set: 'DISCHARGE_STATUS', in: ['discharge'], req: 'always', group: 'Discharge' },
  { key: 'last_service_date', name: 'DateOfLastService', label: 'Date of last face-to-face service', type: 'date', in: ['discharge'], req: 'always', group: 'Discharge' },
  // ---- the 30-day repeated measures: admission, standard discharge, annual update ----
  { key: 'primary_days_used', name: 'PrimaryDrugFrequency', label: 'Days primary drug used, past 30', type: 'int', min: 0, max: 30, alt: [99902], in: REP, req: 'standard', group: 'Past 30 days', dict: 'ADU-2' },
  { key: 'secondary_days_used', name: 'SecondaryDrugFrequency', label: 'Days secondary drug used, past 30', type: 'int', min: 0, max: 30, alt: [99902], in: REP, req: (a, c) => c.standard && hasSecondary(a, c), group: 'Past 30 days', dict: 'ADU-2' },
  { key: 'alcohol_days', name: 'AlcoholUseDays', label: 'Days alcohol used, past 30', type: 'int', min: 0, max: 30, alt: [99902], in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'iv_use_30', name: 'NeedleUsePast30Days', label: 'Days of needle use, past 30', type: 'int', min: 0, max: 30, alt: [99900, 99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'ADU-10 p.35' },
  // The labels are the dictionary's (EMP-1 p.62); the help tells 4 from 5 in the words SUDS used before 1.25.0, which the
  // dictionary check (docs/evidence/caloms-dictionary-verification.md) found equivalent to them (1.25.2, CS12).
  { key: 'employment_status', name: 'CurrentEmploymentStatus', label: 'Employment status', set: 'EMPLOYMENT', in: REP, req: 'standard', group: 'Past 30 days',
    help: '4: out of work and not looking for work. 5: not in the labor force at all — a student, homemaker, retired, disabled, or incarcerated.' },
  { key: 'paid_work_days', name: 'DaysPaidForWorkPast30', label: 'Days paid for work, past 30', type: 'int', min: 0, max: 30, alt: [99900, 99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'EMP-2' },
  { key: 'school_enrolled', name: 'EnrolledInSchool', label: 'Enrolled in school', set: 'SCHOOL_ENROLLED', in: REP, req: 'standard', group: 'Past 30 days', dict: 'EMP-3 p.64' },
  { key: 'job_training', name: 'EnrolledInJobTraining', label: 'Enrolled in job training', set: 'SCHOOL_ENROLLED', in: REP, req: 'standard', group: 'Past 30 days', dict: 'EMP-4 p.65' },
  { key: 'living_arrangement', name: 'LivingArrangement', label: 'Living arrangement', set: 'LIVING', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'arrests_30', name: 'ArrestsPast30Days', label: 'Arrests, past 30 days', type: 'int', min: 0, max: 30, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'LEG-3' },
  { key: 'jail_days_30', name: 'JailDaysPast30', label: 'Days in jail, past 30', type: 'int', min: 0, max: 30, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'LEG-4' },
  { key: 'prison_days_30', name: 'PrisonDaysPast30', label: 'Days in prison, past 30', type: 'int', min: 0, max: 30, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'LEG-5' },
  { key: 'er_visits_30', name: 'EmergencyRoomVisitsPast30', label: 'Emergency room visits, past 30 days', type: 'int', min: 0, max: 99, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'MED-2' },
  { key: 'hospital_nights_30', name: 'HospitalOvernightStaysPast30', label: 'Nights in hospital, past 30', type: 'int', min: 0, max: 30, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'MED-3' },
  { key: 'physical_health_days_30', name: 'PhysicalHealthProblemDaysPast30', label: 'Days with physical health problems, past 30', type: 'int', min: 0, max: 30, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'MED-4 p.78' },
  { key: 'mh_diagnosis', name: 'DiagnosedMentalIllness', label: 'Ever diagnosed with a mental illness', set: 'MH_DIAGNOSIS', in: REP, req: 'standard', group: 'Past 30 days', dict: 'MHD-1 p.86' },
  { key: 'mh_er_visits_30', name: 'MentalHealthERVisitsPast30', label: 'Emergency visits for mental health, past 30 days', type: 'int', min: 0, max: 99, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'MHD-2' },
  { key: 'psych_inpatient_days_30', name: 'PsychiatricInpatientDaysPast30', label: 'Days in psychiatric inpatient care, past 30', type: 'int', min: 0, max: 30, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'MHD-3' },
  { key: 'psych_meds', name: 'MentalHealthMedicationDaysPast30', label: 'Days took prescribed mental-health medication, past 30', type: 'int', min: 0, max: 30, alt: [99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'MHD-4 p.89' },
  { key: 'family_conflict_days_30', name: 'FamilyConflictDaysPast30', label: 'Days of serious family conflict, past 30', type: 'int', min: 0, max: 30, alt: [99900, 99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'SOC-4' },
  { key: 'social_support_days_30', name: 'SocialSupportRecoveryDaysPast30', label: 'Days at social support recovery activities, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days', dict: 'SOC-1' },
  { key: 'lives_with_user', name: 'LivesWithSubstanceUser', label: 'Days lived with someone who uses alcohol or drugs, past 30', type: 'int', min: 0, max: 30, alt: [99900, 99904], in: REP, req: 'standard', group: 'Past 30 days', dict: 'SOC-3 p.93' },
];
const FIELD = Object.fromEntries(FIELDS.map(f => [f.key, f]));
const fieldsFor = (type) => FIELDS.filter(f => f.in.includes(type));

// Suggested starting values from what SUDS already records, so a worker is not asked twice. Only ever a
// default in the form: the worker confirms each answer.
//
// service type: the dictionary's ADM-4 (p.13) is a type-of-service code, not an ASAM level, so the mapping
// is approximate — ASAM outpatient levels suggest Non-Residential (1), ASAM residential/inpatient levels
// suggest Residential (2), and an OTP suggests Narcotic Treatment Program (7). A client in an NTP also
// needs MED-7 (medication) answered (dictionary p.13 note).
const FROM_SUDS = {
  asam_level: { '1.0': '1', '2.1': '1', '2.5': '1', '3.1': '2', '3.3': '2', '3.5': '2', '3.7': '2', '4.0': '2', OTP: '7' },
  substance: { opioids_fentanyl: '99903', opioids_heroin: '1', opioids_rx: '16', alcohol: '2', methamphetamine: '5', cocaine: '8', benzodiazepines: '12', cannabis: '9', synthetic_cannabinoids: '99903', xylazine: '99903', other: '99903' },
  // No suggestion for "transferred" or "moved" (1.25.2, CS10): DIS-2 (p.61) asks whether the client completed the
  // treatment plan and how they progressed, which neither reason says; 1 (completed) or 4 (satisfactory progress)
  // would be a claim the state counts. The worker chooses the status.
  discharge_reason: { completed: '1', incarcerated: '8', deceased: '7', lost_contact: '6', declined: '5' },
  veteran: { 1: '1', 0: '0' },
};

// Extract layout: the identifying columns that open every record, before the data elements.
const ID_COLUMNS = [
  { key: 'record_type', name: 'RecordType' }, { key: 'provider_id', name: 'ProviderID' }, { key: 'client_id', name: 'ProviderClientID' },
  { key: 'last_name', name: 'ClientLastName' }, { key: 'first_name', name: 'ClientFirstName' }, { key: 'dob', name: 'DateOfBirth' },
  { key: 'admission_date', name: 'AdmissionDate' },
];
// TRN-1 Type of Form, dictionary p.104. SUDS only writes new records: 1 admission, 4 discharge, 7 annual
// update. Codes 2, 3, 5, 6, 8 and 9 are resubmissions and deletions, which SUDS does not produce.
const RECORD_CODE = { admission: '1', discharge: '4', annual_update: '7' };

module.exports = { SPEC_VERSION, SPEC_SOURCE, SETS, ALT_LABELS, FIELDS, FIELD, RECORD_TYPES, RECORD_CODE, ADMINISTRATIVE_DISCHARGE, MULTI_MAX, fieldsFor, FROM_SUDS, ID_COLUMNS };
