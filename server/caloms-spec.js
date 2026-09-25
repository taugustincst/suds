'use strict';
// CalOMS Tx (California Outcomes Measurement System, Treatment) — the record layout SUDS collects,
// validates and extracts. Everything a county might need to correct lives in this one file: the code sets,
// the data elements, which record types carry them and when they are required.
//
// SOURCE AND STATUS. Built from the DHCS "CalOMS Tx Data Collection Guide" structure (admission, discharge,
// annual update and provider activity records; standard and administrative discharges; the 30-day
// repeated measures). The DHCS guide (Aug 2024, v3) and the CalOMS Tx data dictionary / file specification
// could not be retrieved when this was written, so EVERY code value and element name below is marked
// "to verify against the current DHCS data dictionary" (docs/compliance/CALOMS.md). A county must check
// the code tables here against the dictionary it is given before its first submission. SPEC_VERSION is
// stamped into every extract so a file can always be traced to the table it was built from.
const SPEC_VERSION = 'SUDS CalOMS Tx layout 2026.1 (unverified against the DHCS data dictionary)';
const SPEC_SOURCE = 'DHCS CalOMS Tx Data Collection Guide (Aug 2024, v3) — not retrieved; code values to verify against the current DHCS data dictionary';

const set = (pairs) => pairs.map(([code, label]) => ({ code, label }));

const SETS = {
  ADMISSION_TRANSACTION: set([['1', 'Initial admission'], ['2', 'Transfer or change in service (same provider)']]),
  SERVICE_TYPES: set([
    ['01', 'Outpatient (ASAM 1.0)'], ['02', 'Intensive outpatient (ASAM 2.1)'], ['03', 'Partial hospitalization (ASAM 2.5)'],
    ['04', 'Residential, clinically managed low intensity (ASAM 3.1)'], ['05', 'Residential, population-specific high intensity (ASAM 3.3)'],
    ['06', 'Residential, clinically managed high intensity (ASAM 3.5)'], ['07', 'Inpatient, medically monitored (ASAM 3.7)'],
    ['08', 'Withdrawal management, ambulatory (1-WM / 2-WM)'], ['09', 'Withdrawal management, residential (3.2-WM)'],
    ['10', 'Withdrawal management, inpatient (3.7-WM / 4-WM)'], ['11', 'Narcotic treatment program — maintenance'],
    ['12', 'Narcotic treatment program — detoxification'], ['13', 'Recovery services'],
  ]),
  REFERRAL_SOURCES: set([
    ['01', 'Individual (self)'], ['02', 'Alcohol or drug treatment provider'], ['03', 'Other health care provider'], ['04', 'School'],
    ['05', 'Employer / EAP'], ['06', 'Other community referral'], ['07', 'Court or criminal justice (not DUI)'], ['08', 'DUI / DWI'],
    ['09', 'Probation'], ['10', 'Parole'], ['11', 'Drug court'], ['12', 'PC 1000 (deferred entry of judgment)'],
    ['13', 'Dependency court / child welfare services'], ['14', 'CalWORKs / social services'], ['15', 'Mental health provider'],
    ['16', 'Hospital or emergency department'],
  ]),
  DRUGS: set([
    ['00', 'None'], ['01', 'Heroin'], ['02', 'Alcohol'], ['03', 'Barbiturates'], ['04', 'Other sedatives or hypnotics'], ['05', 'Methamphetamine'],
    ['06', 'Other amphetamines'], ['07', 'Other stimulants'], ['08', 'Cocaine / crack'], ['09', 'Marijuana / hashish'], ['10', 'PCP'],
    ['11', 'Other hallucinogens'], ['12', 'Tranquilizers (benzodiazepines)'], ['13', 'Other tranquilizers'], ['14', 'Non-prescription methadone'],
    ['15', 'Oxycodone / OxyContin'], ['16', 'Other opiates or synthetics'], ['17', 'Inhalants'], ['18', 'Over-the-counter'],
    ['19', 'Ecstasy (MDMA)'], ['20', 'Other club drugs'], ['21', 'Fentanyl'], ['99', 'Other'],
  ]),
  ROUTES: set([['1', 'Oral'], ['2', 'Smoking'], ['3', 'Inhalation (nasal)'], ['4', 'Injection'], ['5', 'Other']]),
  YES_NO: set([['Y', 'Yes'], ['N', 'No']]),
  YES_NO_DECLINED: set([['Y', 'Yes'], ['N', 'No'], ['D', 'Declined to state']]),
  YES_NO_UNKNOWN: set([['Y', 'Yes'], ['N', 'No'], ['U', 'Unknown']]),
  SEX_AT_BIRTH: set([['M', 'Male'], ['F', 'Female'], ['X', 'Intersex / another sex'], ['D', 'Declined to state']]),
  GENDER_IDENTITY: set([['1', 'Male'], ['2', 'Female'], ['3', 'Transgender man / trans masculine'], ['4', 'Transgender woman / trans feminine'],
    ['5', 'Genderqueer / non-binary'], ['6', 'Another gender identity'], ['7', 'Declined to state']]),
  RACES: set([
    ['01', 'White'], ['02', 'Black or African American'], ['03', 'American Indian'], ['04', 'Alaska Native'], ['05', 'Asian Indian'],
    ['06', 'Cambodian'], ['07', 'Chinese'], ['08', 'Filipino'], ['09', 'Guamanian'], ['10', 'Native Hawaiian'], ['11', 'Japanese'],
    ['12', 'Korean'], ['13', 'Laotian'], ['14', 'Samoan'], ['15', 'Vietnamese'], ['16', 'Other Asian'], ['17', 'Other Pacific Islander'],
    ['18', 'Other'], ['19', 'Declined to state'],
  ]),
  ETHNICITIES: set([['01', 'Mexican / Mexican American / Chicano'], ['02', 'Puerto Rican'], ['03', 'Cuban'], ['04', 'Other Hispanic or Latino'],
    ['05', 'Not Hispanic or Latino'], ['06', 'Declined to state']]),
  DISABILITIES: set([['1', 'None'], ['2', 'Visual'], ['3', 'Hearing'], ['4', 'Speech'], ['5', 'Mobility'], ['6', 'Mental'], ['7', 'Developmental'],
    ['8', 'Other'], ['9', 'Declined to state']]),
  EMPLOYMENT: set([['1', 'Employed full time (35+ hours a week)'], ['2', 'Employed part time'], ['3', 'Unemployed, looking for work'],
    ['4', 'Unemployed, not looking for work'], ['5', 'Not in the labor force (student, homemaker, retired, disabled, incarcerated)']]),
  LIVING: set([['1', 'Homeless'], ['2', 'Dependent living (supervised, or with family)'], ['3', 'Independent living']]),
  // 1-3 and 5 are "standard" discharges (the client answers the discharge questions); 4, 6, 7 and 8 are
  // "administrative" (the client is not there to ask), which carry only the discharge elements.
  DISCHARGE_STATUS: set([
    ['1', 'Completed treatment / recovery plan goals — referred'], ['2', 'Completed treatment / recovery plan goals — not referred'],
    ['3', 'Left before completion with satisfactory progress — standard questions'], ['4', 'Left before completion with satisfactory progress — administrative questions'],
    ['5', 'Left before completion with unsatisfactory progress — standard questions'], ['6', 'Left before completion with unsatisfactory progress — administrative questions'],
    ['7', 'Death'], ['8', 'Incarceration'],
  ]),
};
const ADMINISTRATIVE_DISCHARGE = ['4', '6', '7', '8'];
const RECORD_TYPES = ['admission', 'discharge', 'annual_update'];
const MULTI_MAX = 5;

// Data elements. `in`: the record types that carry it. `req`: 'always' for every record type it is in,
// 'standard' for admissions, annual updates and standard (not administrative) discharges, or a function of
// (answers, context) for a conditional element. `name` is the column heading in the extract (CalOMS element
// name, to verify); `key` is what SUDS stores. Order here is extract column order.
const REP = ['admission', 'discharge', 'annual_update'];
const hasSecondary = (a, c) => { const s = c.record_type === 'admission' ? a.secondary_drug : (c.admission || {}).secondary_drug; return !!s && s !== '00'; };
const FIELDS = [
  // ---- admission: the episode ----
  { key: 'admission_transaction', name: 'AdmissionTransactionType', label: 'Admission type', set: 'ADMISSION_TRANSACTION', in: ['admission'], req: 'always', group: 'Admission' },
  { key: 'service_type', name: 'TypeOfService', label: 'Type of service', set: 'SERVICE_TYPES', in: ['admission'], req: 'always', group: 'Admission' },
  { key: 'referral_source', name: 'ReferralSource', label: 'Referral source', set: 'REFERRAL_SOURCES', in: ['admission'], req: 'always', group: 'Admission' },
  { key: 'days_waited', name: 'DaysWaitedToEnterTreatment', label: 'Days waited to enter treatment', type: 'int', min: 0, max: 999, in: ['admission'], req: 'always', group: 'Admission' },
  { key: 'prior_episodes', name: 'NumberOfPriorTreatmentEpisodes', label: 'Number of prior treatment episodes', type: 'int', min: 0, max: 99, in: ['admission'], req: 'always', group: 'Admission' },
  { key: 'mat_planned', name: 'MedicationAssistedTreatmentPlanned', label: 'Medication-assisted treatment planned', set: 'YES_NO', in: ['admission'], req: 'always', group: 'Admission' },
  { key: 'calworks', name: 'CalWORKsRecipient', label: 'CalWORKs recipient', set: 'YES_NO', in: ['admission'], req: 'always', group: 'Admission' },
  // ---- admission: about the client ----
  { key: 'sex_at_birth', name: 'SexAtBirth', label: 'Sex at birth', set: 'SEX_AT_BIRTH', in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'gender_identity', name: 'GenderIdentity', label: 'Gender identity', set: 'GENDER_IDENTITY', in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'race', name: 'Race', label: `Race (up to ${MULTI_MAX})`, set: 'RACES', multi: true, in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'ethnicity', name: 'Ethnicity', label: 'Ethnicity', set: 'ETHNICITIES', in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'veteran', name: 'VeteranStatus', label: 'Veteran', set: 'YES_NO_DECLINED', in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'disability', name: 'Disability', label: `Disability (up to ${MULTI_MAX})`, set: 'DISABILITIES', multi: true, in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'zip_code', name: 'ZipCodeAtAdmission', label: 'ZIP code of residence', type: 'zip', in: ['admission'], req: 'always', group: 'About the client', help: '5 digits; 00000 when homeless or unknown (to verify).' },
  { key: 'education_grade', name: 'HighestSchoolGradeCompleted', label: 'Highest school grade completed (0-30)', type: 'int', min: 0, max: 30, in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'children_under_18', name: 'NumberOfChildrenUnder18', label: 'Number of children under 18', type: 'int', min: 0, max: 99, in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'children_cps', name: 'ChildrenLivingWithOthersDueToCPS', label: 'Of those, living with someone else by child protective order', type: 'int', min: 0, max: 99, in: ['admission'], req: 'always', group: 'About the client' },
  { key: 'pregnant', name: 'PregnantAtAdmission', label: 'Pregnant at admission', set: 'YES_NO', in: ['admission'], req: 'always', group: 'About the client' },
  // ---- admission: substance use history ----
  { key: 'primary_drug', name: 'PrimaryDrug', label: 'Primary drug', set: 'DRUGS', in: ['admission'], req: 'always', group: 'Substance use' },
  { key: 'primary_route', name: 'PrimaryDrugRoute', label: 'Primary drug — usual route', set: 'ROUTES', in: ['admission'], req: 'always', group: 'Substance use' },
  { key: 'primary_age_first_use', name: 'PrimaryDrugAgeOfFirstUse', label: 'Primary drug — age of first use', type: 'int', min: 0, max: 99, in: ['admission'], req: 'always', group: 'Substance use' },
  { key: 'secondary_drug', name: 'SecondaryDrug', label: 'Secondary drug (None if none)', set: 'DRUGS', in: ['admission'], req: 'always', group: 'Substance use' },
  { key: 'secondary_route', name: 'SecondaryDrugRoute', label: 'Secondary drug — usual route', set: 'ROUTES', in: ['admission'], req: hasSecondary, group: 'Substance use' },
  { key: 'secondary_age_first_use', name: 'SecondaryDrugAgeOfFirstUse', label: 'Secondary drug — age of first use', type: 'int', min: 0, max: 99, in: ['admission'], req: hasSecondary, group: 'Substance use' },
  { key: 'iv_use_12m', name: 'NeedleUsePast12Months', label: 'Needle use in the past 12 months', set: 'YES_NO', in: ['admission'], req: 'always', group: 'Substance use' },
  // ---- discharge ----
  { key: 'discharge_status', name: 'DischargeStatus', label: 'CalOMS discharge status', set: 'DISCHARGE_STATUS', in: ['discharge'], req: 'always', group: 'Discharge' },
  { key: 'last_service_date', name: 'DateOfLastService', label: 'Date of last face-to-face service', type: 'date', in: ['discharge'], req: 'always', group: 'Discharge' },
  // ---- the 30-day repeated measures: admission, standard discharge, annual update ----
  { key: 'primary_days_used', name: 'PrimaryDrugFrequency', label: 'Days primary drug used, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'secondary_days_used', name: 'SecondaryDrugFrequency', label: 'Days secondary drug used, past 30', type: 'int', min: 0, max: 30, in: REP, req: (a, c) => c.standard && hasSecondary(a, c), group: 'Past 30 days' },
  { key: 'alcohol_days', name: 'AlcoholUseDays', label: 'Days alcohol used, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'iv_use_30', name: 'NeedleUsePast30Days', label: 'Needle use, past 30 days', set: 'YES_NO', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'employment_status', name: 'CurrentEmploymentStatus', label: 'Employment status', set: 'EMPLOYMENT', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'paid_work_days', name: 'DaysPaidForWorkPast30', label: 'Days paid for work, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'school_enrolled', name: 'EnrolledInSchool', label: 'Enrolled in school', set: 'YES_NO', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'job_training', name: 'EnrolledInJobTraining', label: 'Enrolled in job training', set: 'YES_NO', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'living_arrangement', name: 'LivingArrangement', label: 'Living arrangement', set: 'LIVING', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'arrests_30', name: 'ArrestsPast30Days', label: 'Arrests, past 30 days', type: 'int', min: 0, max: 99, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'jail_days_30', name: 'JailDaysPast30', label: 'Days in jail, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'prison_days_30', name: 'PrisonDaysPast30', label: 'Days in prison, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'er_visits_30', name: 'EmergencyRoomVisitsPast30', label: 'Emergency room visits, past 30 days', type: 'int', min: 0, max: 99, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'hospital_nights_30', name: 'HospitalOvernightStaysPast30', label: 'Nights in hospital, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'physical_health_days_30', name: 'PhysicalHealthProblemDaysPast30', label: 'Days with physical health problems, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'mh_diagnosis', name: 'DiagnosedMentalIllness', label: 'Diagnosed with a mental illness', set: 'YES_NO_UNKNOWN', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'mh_er_visits_30', name: 'MentalHealthERVisitsPast30', label: 'Emergency visits for mental health, past 30 days', type: 'int', min: 0, max: 99, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'psych_inpatient_days_30', name: 'PsychiatricInpatientDaysPast30', label: 'Days in psychiatric inpatient care, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'psych_meds', name: 'PrescribedPsychiatricMedication', label: 'Prescribed psychiatric medication', set: 'YES_NO', in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'family_conflict_days_30', name: 'FamilyConflictDaysPast30', label: 'Days of serious family conflict, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'social_support_days_30', name: 'SocialSupportRecoveryDaysPast30', label: 'Days at social support recovery activities, past 30', type: 'int', min: 0, max: 30, in: REP, req: 'standard', group: 'Past 30 days' },
  { key: 'lives_with_user', name: 'LivesWithSubstanceUser', label: 'Lives with someone who uses alcohol or drugs', set: 'YES_NO', in: REP, req: 'standard', group: 'Past 30 days' },
];
const FIELD = Object.fromEntries(FIELDS.map(f => [f.key, f]));
const fieldsFor = (type) => FIELDS.filter(f => f.in.includes(type));

// Suggested starting values from what SUDS already records, so a worker is not asked twice. Only ever a
// default in the form: the worker confirms each answer.
const FROM_SUDS = {
  asam_level: { '1.0': '01', '2.1': '02', '2.5': '03', '3.1': '04', '3.3': '05', '3.5': '06', '3.7': '07', '4.0': '10', OTP: '11' },
  substance: { opioids_fentanyl: '21', opioids_heroin: '01', opioids_rx: '16', alcohol: '02', methamphetamine: '05', cocaine: '08', benzodiazepines: '12', cannabis: '09', synthetic_cannabinoids: '99', xylazine: '99', other: '99' },
  discharge_reason: { completed: '1', transferred: '1', incarcerated: '8', deceased: '7', lost_contact: '6', declined: '5', moved: '4' },
  veteran: { 1: 'Y', 0: 'N' },
};

// Extract layout: the identifying columns that open every record, before the data elements.
const ID_COLUMNS = [
  { key: 'record_type', name: 'RecordType' }, { key: 'provider_id', name: 'ProviderID' }, { key: 'client_id', name: 'ProviderClientID' },
  { key: 'last_name', name: 'ClientLastName' }, { key: 'first_name', name: 'ClientFirstName' }, { key: 'dob', name: 'DateOfBirth' },
  { key: 'admission_date', name: 'AdmissionDate' },
];
const RECORD_CODE = { admission: 'A', discharge: 'D', annual_update: 'U' };

module.exports = { SPEC_VERSION, SPEC_SOURCE, SETS, FIELDS, FIELD, RECORD_TYPES, RECORD_CODE, ADMINISTRATIVE_DISCHARGE, MULTI_MAX, fieldsFor, FROM_SUDS, ID_COLUMNS };
