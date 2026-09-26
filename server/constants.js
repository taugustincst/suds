'use strict';
const CL = require('./clinical');
// Race and ethnicity as reportable codes (OMB 1997 / CalOMS categories). The free-text race_ethnicity
// field stays for what a client says about themselves; race_codes is what a funder report can count.
// A person may select more than one, which is why this is a list and the column is comma separated.
const RACE_CODES = [
  { code: 'american_indian_alaska_native', label: 'American Indian or Alaska Native' },
  { code: 'asian', label: 'Asian' },
  { code: 'black_african_american', label: 'Black or African American' },
  { code: 'native_hawaiian_pacific_islander', label: 'Native Hawaiian or Other Pacific Islander' },
  { code: 'white', label: 'White' },
  { code: 'other', label: 'Other' },
  { code: 'declined', label: 'Declined to answer' },
  { code: 'unknown', label: 'Unknown' },
];
const ETHNICITY_CODES = [
  { code: 'hispanic_latino', label: 'Hispanic or Latino' },
  { code: 'not_hispanic_latino', label: 'Not Hispanic or Latino' },
  { code: 'declined', label: 'Declined to answer' },
  { code: 'unknown', label: 'Unknown' },
];

// Opioid settlement allowable uses, for the settlement expenditure report (server/harm-reduction-reports.js).
// NEEDS VERIFICATION against the current agreements before a programme relies on the wording or the codes:
//  * SETTLEMENT_USES follows Exhibit E, "List of Opioid Remediation Uses", of the national opioid settlement
//    agreements (Distributors / Janssen, 2021, and the later agreements that reuse it): Schedule A, Core
//    Strategies (A–I), and Schedule B, Approved Uses (A–L, grouped as Treatment, Prevention and Other
//    Strategies). Labels are abbreviated here; Exhibit E itself is the authority on what each covers.
//  * SETTLEMENT_HIAA is California's list of High Impact Abatement Activities from the California
//    State-Subdivision Agreement (as summarised by DHCS on its Opioid Settlements pages), toward which a
//    share of a participating subdivision's funds must go. The share and the list should be checked
//    against the agreement in force for the fund being reported.
// 'none' on either means "not one of these" (administrative cost, or not a High Impact Abatement Activity).
const SETTLEMENT_USES = [
  { code: 'core_a', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'A. Naloxone or other FDA-approved drug to reverse opioid overdoses' },
  { code: 'core_b', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'B. Medication for opioid use disorder (MOUD) distribution and other opioid-related treatment' },
  { code: 'core_c', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'C. Pregnant and postpartum women' },
  { code: 'core_d', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'D. Expanding treatment for neonatal abstinence syndrome (NAS)' },
  { code: 'core_e', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'E. Expansion of warm hand-off programs and recovery services' },
  { code: 'core_f', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'F. Treatment for incarcerated population' },
  { code: 'core_g', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'G. Prevention programs' },
  { code: 'core_h', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'H. Expanding syringe service programs' },
  { code: 'core_i', schedule: 'Exhibit E, Schedule A (Core Strategies)', label: 'I. Evidence-based data collection and research on abatement strategies' },
  { code: 'approved_a', schedule: 'Exhibit E, Schedule B (Approved Uses) — Treatment', label: 'A. Treat opioid use disorder (OUD)' },
  { code: 'approved_b', schedule: 'Exhibit E, Schedule B (Approved Uses) — Treatment', label: 'B. Support people in treatment and recovery' },
  { code: 'approved_c', schedule: 'Exhibit E, Schedule B (Approved Uses) — Treatment', label: 'C. Connect people who need help to the help they need (connections to care)' },
  { code: 'approved_d', schedule: 'Exhibit E, Schedule B (Approved Uses) — Treatment', label: 'D. Address the needs of criminal justice-involved persons' },
  { code: 'approved_e', schedule: 'Exhibit E, Schedule B (Approved Uses) — Treatment', label: 'E. Address the needs of pregnant or parenting women and their families, including babies with NAS' },
  { code: 'approved_f', schedule: 'Exhibit E, Schedule B (Approved Uses) — Prevention', label: 'F. Prevent over-prescribing and ensure appropriate prescribing and dispensing of opioids' },
  { code: 'approved_g', schedule: 'Exhibit E, Schedule B (Approved Uses) — Prevention', label: 'G. Prevent misuse of opioids' },
  { code: 'approved_h', schedule: 'Exhibit E, Schedule B (Approved Uses) — Prevention', label: 'H. Prevent overdose deaths and other harms (harm reduction)' },
  { code: 'approved_i', schedule: 'Exhibit E, Schedule B (Approved Uses) — Other strategies', label: 'I. First responders' },
  { code: 'approved_j', schedule: 'Exhibit E, Schedule B (Approved Uses) — Other strategies', label: 'J. Leadership, planning and coordination' },
  { code: 'approved_k', schedule: 'Exhibit E, Schedule B (Approved Uses) — Other strategies', label: 'K. Training' },
  { code: 'approved_l', schedule: 'Exhibit E, Schedule B (Approved Uses) — Other strategies', label: 'L. Research' },
  { code: 'none', schedule: 'Not an opioid remediation use', label: 'Not an opioid remediation use (for example, administrative cost)' },
];
const SETTLEMENT_HIAA = [
  { code: 'hiaa_1', label: '1. Matching funds or operating costs for SUD facilities with an approved Behavioral Health Continuum Infrastructure Program (BHCIP) project' },
  { code: 'hiaa_2', label: '2. Creating new or expanded substance use disorder (SUD) treatment infrastructure' },
  { code: 'hiaa_3', label: '3. Addressing the needs of communities of color and vulnerable populations (including sheltered and unsheltered homeless populations) disproportionately impacted by SUD' },
  { code: 'hiaa_4', label: '4. Diversion of people with SUD from the justice system into treatment, including training and resources for first and early responders, and outreach, diversion, deflection and harm reduction' },
  { code: 'hiaa_5', label: '5. Interventions to prevent drug addiction in vulnerable youth' },
  { code: 'hiaa_6', label: '6. The purchase of naloxone for distribution and efforts to expand access to naloxone for opioid overdose reversals' },
];

module.exports = {
  RACE_CODES, ETHNICITY_CODES, SETTLEMENT_USES, SETTLEMENT_HIAA,
  INTERVENTION_TYPES: ['outreach', 'screening_sbirt', 'assessment', 'intake', 'care_coordination', 'warm_handoff', 'referral', 'case_management', 'harm_reduction', 'naloxone_distribution', 'peer_support', 'crisis_response', 'post_overdose_follow_up', 'transport', 'housing_assistance', 'benefits_enrollment', 'employment_support', 'family_support', 'education', 'court_or_probation', 'hospital_or_ed_visit', 'jail_in_reach', 'recovery_check_in', 'discharge_planning', 'other'],
  // The services that can be recorded with no identified client: street outreach and community naloxone
  // distribution (a kit handed to a stranger). Every other type is work with a person on the caseload, and
  // needs the client (server/routes/interventions.js and the visit form enforce the same list).
  CLIENTLESS_INTERVENTION_TYPES: ['outreach', 'naloxone_distribution'],
  LOCATIONS: ['office', 'field', 'home', 'phone', 'telehealth', 'hospital', 'emergency_dept', 'jail', 'court', 'shelter', 'treatment_facility', 'community', 'other'],
  MODALITIES: ['in_person', 'phone', 'video', 'text', 'email', 'collateral'],
  OUTCOMES: ['completed', 'partial', 'client_declined', 'no_show', 'unable_to_locate', 'rescheduled', 'crisis_resolved', 'transported', 'admitted', 'other'],
  STAGES: ['precontemplation', 'contemplation', 'preparation', 'action', 'maintenance', 'relapse'],
  CALL_CONTACT_TYPES: ['client', 'family', 'provider', 'agency', 'hospital', 'law_enforcement', 'hotline', 'pharmacy', 'insurance', 'other'],
  CALL_OUTCOMES: ['reached', 'voicemail', 'no_answer', 'busy', 'wrong_number', 'disconnected', 'callback_scheduled', 'crisis_escalated'],
  // A contact logged under calls is either a phone call or a text message; a text has its own outcomes,
  // because "voicemail" and "busy" mean nothing to a text and "no reply" means nothing to a call.
  CONTACT_METHODS: ['phone', 'text'],
  TEXT_OUTCOMES: ['replied', 'sent', 'no_reply', 'undeliverable', 'wrong_number', 'opted_out'],
  TIME_CATEGORIES: ['direct_service', 'documentation', 'travel', 'care_coordination', 'outreach', 'meeting', 'training', 'supervision', 'admin', 'on_call'],
  RESOURCE_CATEGORIES: ['detox_withdrawal_mgmt', 'residential', 'inpatient', 'partial_hospitalization', 'intensive_outpatient', 'outpatient', 'mat_otp', 'mat_obot', 'sober_living', 'housing', 'shelter', 'mental_health', 'primary_care', 'harm_reduction', 'syringe_services', 'naloxone', 'crisis_line', 'transportation', 'employment', 'legal', 'food', 'benefits', 'peer_support', 'recovery_community', 'family_support', 'pregnancy_parenting', 'veterans', 'other'],
  REFERRAL_STATUSES: ['pending', 'contacted', 'accepted', 'waitlisted', 'scheduled', 'admitted', 'declined_by_client', 'declined_by_provider', 'no_show', 'completed', 'closed'],
  BUDGET_CATEGORIES: ['staffing', 'client_assistance', 'transportation', 'naloxone_supplies', 'harm_reduction_supplies', 'housing_assistance', 'treatment_fees', 'medication', 'phones_communication', 'food_basic_needs', 'ids_documents', 'training', 'outreach_materials', 'supplies', 'indirect', 'other'],
  FUNDING_TYPES: ['opioid_settlement', 'sor_grant', 'samhsa', 'state_block_grant', 'county_general', 'medicaid', 'foundation', 'other'],
  // 'handoff' is the shift hand-off note (what the next worker on needs to know), 'safety_plan' a structured
  // safety plan (see SECTIONS in public/views/notes.js); both are ordinary notes as far as access rules go.
  NOTE_FORMATS: ['narrative', 'SOAP', 'DAP', 'BIRP', 'GIRP', 'intake', 'progress', 'discharge', 'contact', 'collateral', 'crisis', 'supervision', 'handoff', 'safety_plan'],
  // part2_* are 42 CFR Part 2 consents (§2.31): every element is required of them. part2_tpo is the 2024
  // rule's single consent for all future treatment, payment and health care operations; part2_counseling_notes
  // is the separate consent SUD counseling notes need (§2.31(b)); part2_proceedings is the stand-alone consent
  // for use in a civil, criminal, administrative or legislative proceeding (§2.31(d)), which may not be
  // combined with any other. 'roi' is a general release, which Part 2 says is not sufficient on its own.
  CONSENT_TYPES: ['part2_disclosure', 'part2_tpo', 'part2_counseling_notes', 'part2_proceedings', 'roi', 'treatment', 'telehealth', 'contact_preferences', 'research', 'photo_media'],
  PART2_CONSENT_TYPES: ['part2_disclosure', 'part2_tpo', 'part2_counseling_notes', 'part2_proceedings'],
  // The categories of information a consent can cover, recorded as codes (consents.info_categories) beside
  // the free-text scope the signed form carries, so that an automated disclosure (the FHIR API) shares only
  // what the consent covers (server/disclosure.js CATEGORY_OF_FHIR_TYPE). 'all' covers every category.
  CONSENT_INFO_CATEGORIES: ['demographics', 'encounters', 'diagnoses_assessments', 'referrals', 'tasks', 'documents', 'risk_overdose', 'all'],
  CONSENT_INFO_CATEGORY_LABELS: {
    demographics: 'Identity and contact details (name, date of birth, address, phone, Medi-Cal ID)',
    encounters: 'Attendance and services (episodes of care, visits, calls)',
    diagnoses_assessments: 'SUD diagnosis and assessments (problems, ASAM, screening results)',
    referrals: 'Referrals and care coordination',
    tasks: 'Tasks and follow-ups',
    documents: 'Signed notes — titles and dates only, never their text',
    risk_overdose: 'Risk level and overdose events',
    all: 'All of the above',
  },
  CONSENT_SIGNERS: ['patient', 'parent_or_guardian', 'personal_representative', 'court_appointed_guardian'],
  COURT_ORDER_TYPES: ['noncriminal_2_64', 'criminal_patient_2_65', 'program_investigation_2_66', 'undercover_2_67'],
  PART2_NOTICE_METHODS: ['in_person_paper', 'electronic', 'mail', 'verbal_with_copy'],
  // 42 CFR §2.32(a)(1) as amended by the 2024 final rule (89 FR 12472): the notice that must accompany
  // every disclosure made with the patient's written consent. PART2_NOTICE_SHORT is §2.32(a)(2)'s
  // abbreviated form, used as the label on screens and printouts.
  PART2_NOTICE_VERSION: '2024',
  PART2_REDISCLOSURE_NOTICE: 'This record which has been disclosed to you is protected by Federal confidentiality rules (42 CFR part 2). These rules prohibit you from using or disclosing this record, or testimony that describes the information contained in this record, in any civil, criminal, administrative, or legislative proceedings by any Federal, State, or local authority, against the patient, unless authorized by the consent of the patient, except as provided at 42 CFR 2.12(c)(5) or as authorized by a court in accordance with 42 CFR 2.64 or 2.65. In addition, the Federal rules prohibit you from making any other use or disclosure of this record unless at least one of the following applies: (i) Further use or disclosure is expressly permitted by the written consent of the individual whose information is being disclosed in this record or as otherwise permitted by 42 CFR part 2. (ii) You are a covered entity or business associate and have received the record for treatment, payment, or health care operations, or (iii) You have received the record from a covered entity or business associate as permitted by 45 CFR part 164, subparts A and E. A general authorization for the release of medical or other information is NOT sufficient to meet the required elements of written consent to further use or redisclose the record (see 42 CFR 2.31).',
  PART2_NOTICE_SHORT: '42 CFR part 2 prohibits unauthorized use or disclosure of these records.',
  SUBSTANCES: ['opioids_fentanyl', 'opioids_heroin', 'opioids_rx', 'alcohol', 'methamphetamine', 'cocaine', 'benzodiazepines', 'cannabis', 'synthetic_cannabinoids', 'xylazine', 'nicotine', 'other', 'unknown'],
  SERVICE_TAGS: ['detox', 'residential', 'inpatient', 'partial_hospitalization', 'intensive_outpatient', 'outpatient', 'mat_buprenorphine', 'mat_methadone', 'mat_naltrexone', 'medication_management', 'individual_counseling', 'group_counseling', 'family_program', 'peer_support', 'case_management', 'mental_health', 'trauma_informed', 'co_occurring', 'medical_care', 'harm_reduction', 'naloxone', 'syringe_services', 'housing', 'sober_living', 'employment', 'legal_help', 'transportation', 'childcare', 'telehealth', 'walk_in', 'same_day_intake', 'crisis_24_7', 'aftercare', 'faith_based', 'spanish_speaking'],
  POPULATIONS: ['adults', 'adolescents', 'women', 'men', 'pregnant_parenting', 'families', 'veterans', 'lgbtq', 'justice_involved', 'unhoused', 'older_adults', 'native_american', 'spanish_speakers', 'deaf_hard_of_hearing'],
  FORM_CATEGORIES: ['consent_release', 'intake_screening', 'assessment', 'treatment_plan', 'referral', 'assistance_request', 'transportation', 'housing', 'benefits', 'discharge', 'incident', 'grievance', 'other'],
  DOCUMENT_CATEGORIES: ['policy', 'procedure', 'contract'],
  FORM_FIELD_TYPES: ['text', 'textarea', 'date', 'number', 'checkbox', 'select', 'signature', 'section', 'note'],
  FORM_AUTOFILL: ['client.full_name', 'client.first_name', 'client.last_name', 'client.preferred_name', 'client.dob', 'client.phone', 'client.email', 'client.address', 'client.city', 'client.zip', 'client.client_code', 'client.gender', 'client.pronouns', 'client.insurance', 'client.medicaid_id', 'client.emergency_contact', 'client.primary_substance', 'client.mat_status', 'client.intake_date', 'worker.name', 'worker.title', 'org.name', 'org.county', 'today'],
  // The overdose form's "What happened" and "Given by". The kinds are fixed by a CHECK constraint on
  // overdose_events.kind and each drives a count, so Settings → Lists can reword them but not add to them.
  OVERDOSE_KINDS: ['overdose', 'reversal', 'fatal'],
  ADMINISTERED_BY: ['bystander', 'first_responder', 'staff', 'self', 'family', 'unknown'],
  // Why an episode of care ended ('deceased' also marks the client deceased: server/routes/episodes.js).
  // Safety flags on a client (free text, comma separated; these are the codes a flag may also be stored
  // as, e.g. by an import or the sample data, shown with their label rather than the code).
  CLIENT_FLAGS: ['no_home_visits', 'visit_in_pairs', 'do_not_contact_family', 'no_voicemail', 'safety_plan'],
  DISCHARGE_REASONS: ['completed', 'transferred', 'incarcerated', 'moved', 'lost_contact', 'declined', 'deceased', 'administrative', 'other'],
  // A referral outcome's "If it did not happen, why" (stored encrypted in referrals.barrier_enc).
  REFERRAL_BARRIERS: ['none', 'transportation', 'insurance', 'waitlist', 'no_beds', 'client_declined', 'childcare', 'documentation', 'legal', 'phone_access', 'other'],
  ASAM: ['0.5', '1.0', '2.1', '2.5', '3.1', '3.3', '3.5', '3.7', '4.0', 'OTP', 'unknown'],
  // Problem list, care plan, ASAM dimensions and the screening instruments (server/clinical.js).
  Z_CODES: CL.Z_CODES, PROBLEM_STATUSES: CL.PROBLEM_STATUSES, PROBLEM_SOURCES: CL.PROBLEM_SOURCES, GOAL_STATUSES: CL.GOAL_STATUSES,
  STEP_OWNERS: CL.STEP_OWNERS, STEP_STATUSES: CL.STEP_STATUSES, ASAM_DIMENSIONS: CL.ASAM_DIMENSIONS, ASAM_RATINGS: CL.ASAM_RATINGS,
  ASAM_DISCREPANCY_REASONS: CL.ASAM_DISCREPANCY_REASONS, INSTRUMENTS: CL.INSTRUMENTS,
};
