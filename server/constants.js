'use strict';
module.exports = {
  INTERVENTION_TYPES: ['outreach', 'screening_sbirt', 'assessment', 'intake', 'care_coordination', 'warm_handoff', 'referral', 'case_management', 'harm_reduction', 'naloxone_distribution', 'peer_support', 'crisis_response', 'post_overdose_follow_up', 'transport', 'housing_assistance', 'benefits_enrollment', 'employment_support', 'family_support', 'education', 'court_or_probation', 'hospital_or_ed_visit', 'jail_in_reach', 'recovery_check_in', 'discharge_planning', 'other'],
  LOCATIONS: ['office', 'field', 'home', 'phone', 'telehealth', 'hospital', 'emergency_dept', 'jail', 'court', 'shelter', 'treatment_facility', 'community', 'other'],
  MODALITIES: ['in_person', 'phone', 'video', 'text', 'email', 'collateral'],
  OUTCOMES: ['completed', 'partial', 'client_declined', 'no_show', 'unable_to_locate', 'rescheduled', 'crisis_resolved', 'transported', 'admitted', 'other'],
  STAGES: ['precontemplation', 'contemplation', 'preparation', 'action', 'maintenance', 'relapse'],
  CALL_CONTACT_TYPES: ['client', 'family', 'provider', 'agency', 'hospital', 'law_enforcement', 'hotline', 'pharmacy', 'insurance', 'other'],
  CALL_OUTCOMES: ['reached', 'voicemail', 'no_answer', 'busy', 'wrong_number', 'disconnected', 'callback_scheduled', 'crisis_escalated'],
  TIME_CATEGORIES: ['direct_service', 'documentation', 'travel', 'care_coordination', 'outreach', 'meeting', 'training', 'supervision', 'admin', 'on_call'],
  RESOURCE_CATEGORIES: ['detox_withdrawal_mgmt', 'residential', 'inpatient', 'partial_hospitalization', 'intensive_outpatient', 'outpatient', 'mat_otp', 'mat_obot', 'sober_living', 'housing', 'shelter', 'mental_health', 'primary_care', 'harm_reduction', 'syringe_services', 'naloxone', 'crisis_line', 'transportation', 'employment', 'legal', 'food', 'benefits', 'peer_support', 'recovery_community', 'family_support', 'pregnancy_parenting', 'veterans', 'other'],
  REFERRAL_STATUSES: ['pending', 'contacted', 'accepted', 'waitlisted', 'scheduled', 'admitted', 'declined_by_client', 'declined_by_provider', 'no_show', 'completed', 'closed'],
  BUDGET_CATEGORIES: ['staffing', 'client_assistance', 'transportation', 'naloxone_supplies', 'harm_reduction_supplies', 'housing_assistance', 'treatment_fees', 'medication', 'phones_communication', 'food_basic_needs', 'ids_documents', 'training', 'outreach_materials', 'supplies', 'indirect', 'other'],
  FUNDING_TYPES: ['opioid_settlement', 'sor_grant', 'samhsa', 'state_block_grant', 'county_general', 'medicaid', 'foundation', 'other'],
  NOTE_FORMATS: ['narrative', 'SOAP', 'DAP', 'BIRP', 'GIRP', 'intake', 'progress', 'discharge', 'contact', 'collateral', 'crisis', 'supervision'],
  CONSENT_TYPES: ['part2_disclosure', 'roi', 'treatment', 'telehealth', 'contact_preferences', 'research', 'photo_media'],
  SUBSTANCES: ['opioids_fentanyl', 'opioids_heroin', 'opioids_rx', 'alcohol', 'methamphetamine', 'cocaine', 'benzodiazepines', 'cannabis', 'synthetic_cannabinoids', 'xylazine', 'nicotine', 'other', 'unknown'],
  ASAM: ['0.5', '1.0', '2.1', '2.5', '3.1', '3.3', '3.5', '3.7', '4.0', 'OTP', 'unknown'],
};
