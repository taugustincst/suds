'use strict';
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

module.exports = {
  RACE_CODES, ETHNICITY_CODES,
  INTERVENTION_TYPES: ['outreach', 'screening_sbirt', 'assessment', 'intake', 'care_coordination', 'warm_handoff', 'referral', 'case_management', 'harm_reduction', 'naloxone_distribution', 'peer_support', 'crisis_response', 'post_overdose_follow_up', 'transport', 'housing_assistance', 'benefits_enrollment', 'employment_support', 'family_support', 'education', 'court_or_probation', 'hospital_or_ed_visit', 'jail_in_reach', 'recovery_check_in', 'discharge_planning', 'other'],
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
  CONSENT_TYPES: ['part2_disclosure', 'roi', 'treatment', 'telehealth', 'contact_preferences', 'research', 'photo_media'],
  SUBSTANCES: ['opioids_fentanyl', 'opioids_heroin', 'opioids_rx', 'alcohol', 'methamphetamine', 'cocaine', 'benzodiazepines', 'cannabis', 'synthetic_cannabinoids', 'xylazine', 'nicotine', 'other', 'unknown'],
  SERVICE_TAGS: ['detox', 'residential', 'inpatient', 'partial_hospitalization', 'intensive_outpatient', 'outpatient', 'mat_buprenorphine', 'mat_methadone', 'mat_naltrexone', 'medication_management', 'individual_counseling', 'group_counseling', 'family_program', 'peer_support', 'case_management', 'mental_health', 'trauma_informed', 'co_occurring', 'medical_care', 'harm_reduction', 'naloxone', 'syringe_services', 'housing', 'sober_living', 'employment', 'legal_help', 'transportation', 'childcare', 'telehealth', 'walk_in', 'same_day_intake', 'crisis_24_7', 'aftercare', 'faith_based', 'spanish_speaking'],
  POPULATIONS: ['adults', 'adolescents', 'women', 'men', 'pregnant_parenting', 'families', 'veterans', 'lgbtq', 'justice_involved', 'unhoused', 'older_adults', 'native_american', 'spanish_speakers', 'deaf_hard_of_hearing'],
  FORM_CATEGORIES: ['consent_release', 'intake_screening', 'assessment', 'treatment_plan', 'referral', 'assistance_request', 'transportation', 'housing', 'benefits', 'discharge', 'incident', 'grievance', 'other'],
  DOCUMENT_CATEGORIES: ['policy', 'procedure', 'contract'],
  FORM_FIELD_TYPES: ['text', 'textarea', 'date', 'number', 'checkbox', 'select', 'signature', 'section', 'note'],
  FORM_AUTOFILL: ['client.full_name', 'client.first_name', 'client.last_name', 'client.preferred_name', 'client.dob', 'client.phone', 'client.email', 'client.address', 'client.city', 'client.zip', 'client.client_code', 'client.gender', 'client.pronouns', 'client.insurance', 'client.medicaid_id', 'client.emergency_contact', 'client.primary_substance', 'client.mat_status', 'client.intake_date', 'worker.name', 'worker.title', 'org.name', 'org.county', 'today'],
  ASAM: ['0.5', '1.0', '2.1', '2.5', '3.1', '3.3', '3.5', '3.7', '4.0', 'OTP', 'unknown'],
};
