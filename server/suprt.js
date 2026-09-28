'use strict';
// SUPRT-A: SAMHSA's client-level performance record for a State Opioid Response (SOR) grant
// (docs/compliance/SUPRT.md, which says what here is verified and what is not).
//
// Since 1 October 2025 SAMHSA's Unified Performance Reporting Tools (SUPRT) replace the CSAT GPRA tool for SOR
// client-level data. SUPRT has two parts: SUPRT-A ("Administrative"), completed by programme staff from the
// client's record, and SUPRT-C ("Client"), a questionnaire the client answers. SUDS records SUPRT-A. It does
// not reproduce SUPRT-C (SAMHSA's own wording is the instrument); it records whether it was completed,
// declined or not offered, because SUPRT-A's demographics are asked only when SUPRT-C was not completed.
//
// SUPRT-A's sections, as SAMHSA and the California SOR materials describe them: A. Record management,
// B. Behavioral health history, C. Behavioral health screenings, D. Behavioral health diagnoses, E. Services
// received (at reassessment, annual and closeout), F. Demographics. Its assessment points: baseline, a
// reassessment at 6 months (3 for some programmes), an annual assessment every 12 months, and closeout when
// the client stops receiving SOR-funded services. Each reassessment and annual assessment has a 60-day window,
// opening 30 days before the anniversary of the baseline and closing 30 days after; data are entered in SPARS
// within 30 days of collection, and a closeout within 30 days of the end of services.
//
// The items below are SUDS's reading of those public descriptions. SAMHSA's paper tool, question-by-question
// guide and SPARS codebook could not be read when this was built, so the item wording, the answer codes and
// the variable names here are SUDS's own: every file says to check it against the current SUPRT handbook and
// codebook before anything is entered in SPARS. SUDS makes no claim that SAMHSA or DHCS accepts it.
//
// Items SUDS already holds the answer to are pre-filled from the client record (`derive`); the rest are
// asked (the interview form). What the worker saves is what is kept, encrypted (answers_enc: it is PHI).
const db = require('./db');
const C = require('./constants');
const { decrypt } = require('./crypto');

const TYPES = ['baseline', 'reassessment', 'annual', 'closeout'];
const TYPE_LABEL = { baseline: 'Baseline', reassessment: 'Reassessment', annual: 'Annual assessment', closeout: 'Closeout' };
const WINDOW_DAYS = 30;          // a window opens 30 days before the anniversary and closes 30 days after
const ENTRY_DAYS = 30;           // a baseline and a closeout are due within 30 days
const SECTIONS = [
  { key: 'A', label: 'A. Record management' },
  { key: 'B', label: 'B. Behavioral health history' },
  { key: 'C', label: 'C. Behavioral health screenings' },
  { key: 'D', label: 'D. Behavioral health diagnoses' },
  { key: 'E', label: 'E. Services received since the last assessment' },
  { key: 'F', label: 'F. Demographics (only when the client questionnaire, SUPRT-C, was not completed)' },
];
const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'unknown', label: "Don't know / not recorded" }];
const SCREEN = [{ value: 'positive', label: 'Screened positive' }, { value: 'negative', label: 'Screened negative' }, { value: 'not_screened', label: 'Not screened' }];
const ALL = TYPES;
const NOT_CLOSEOUT = ['baseline', 'reassessment', 'annual'];
const FOLLOW = ['reassessment', 'annual', 'closeout'];
// SUDS's own service categories for section E, from its visit types. SUPRT-A's services list must be checked
// against the codebook: a category here may be split or named differently there.
const SERVICE_CATEGORIES = [
  ['case_management', 'Case management or care coordination', ['case_management', 'care_coordination', 'discharge_planning']],
  ['peer_recovery_support', 'Peer recovery support', ['peer_support', 'recovery_check_in']],
  ['harm_reduction', 'Harm reduction or outreach', ['harm_reduction', 'outreach']],
  ['naloxone', 'Naloxone (overdose reversal medication)', ['naloxone_distribution']],
  ['moud', 'Medication for opioid use disorder (MOUD), or a referral to it', []],
  ['treatment_referral', 'Referral or warm hand-off to treatment', ['referral', 'warm_handoff']],
  ['screening_assessment', 'Screening or assessment', ['screening_sbirt', 'assessment', 'intake']],
  ['crisis_services', 'Crisis services', ['crisis_response', 'post_overdose_follow_up']],
  ['housing_support', 'Housing support', ['housing_assistance']],
  ['employment_education', 'Employment or education support', ['employment_support', 'education']],
  ['benefits_enrollment', 'Benefits enrollment', ['benefits_enrollment']],
  ['transportation', 'Transportation', ['transport']],
  ['justice_services', 'Court, probation or jail in-reach', ['court_or_probation', 'jail_in_reach']],
  ['family_support', 'Family support', ['family_support']],
];
const CLOSEOUT_REASONS = [
  { value: 'services_completed', label: 'Completed services' }, { value: 'no_contact', label: 'No contact (lost to follow-up)' },
  { value: 'transferred', label: 'Transferred or referred elsewhere' }, { value: 'incarcerated', label: 'Incarcerated' },
  { value: 'moved', label: 'Moved away' }, { value: 'declined_services', label: 'Declined further services' },
  { value: 'deceased', label: 'Deceased' }, { value: 'other', label: 'Other' },
];
// Coded demographics (1.16.0): the client record's own codes, each with its label, so the form offers a list
// rather than a text box holding "doubled_up". SUPRT-A's own answer codes must still be checked against the
// codebook (docs/compliance/SUPRT.md): these are SUDS's.
const coded = (pairs) => pairs.map(([value, label]) => ({ value, label }));
const GENDER = coded([['female', 'Female'], ['male', 'Male'], ['non_binary', 'Non-binary'], ['transgender_female', 'Transgender female'], ['transgender_male', 'Transgender male'], ['other', 'Another gender'], ['declined', 'Declined to answer'], ['unknown', "Don't know / not recorded"]]);
const HOUSING = coded([['stable', 'Stable housing'], ['doubled_up', 'Staying with others (doubled up)'], ['shelter', 'Shelter'], ['unsheltered', 'Unsheltered (street, car, encampment)'], ['transitional', 'Transitional housing'], ['sober_living', 'Sober living / recovery residence'], ['incarcerated', 'Incarcerated'], ['treatment_facility', 'Treatment facility'], ['unknown', "Don't know / not recorded"]]);
const INSURANCE = coded([['medicaid', 'Medicaid (Medi-Cal)'], ['medicare', 'Medicare'], ['private', 'Private insurance'], ['uninsured', 'Uninsured'], ['va', 'VA / military'], ['pending', 'Application pending'], ['unknown', "Don't know / not recorded"]]);
const ROUTE = coded([['oral', 'Oral'], ['smoked', 'Smoked'], ['snorted', 'Snorted'], ['injected', 'Injected'], ['multiple', 'More than one route'], ['unknown', "Don't know / not recorded"]]);
const SUPRT_C = [{ value: 'completed', label: 'Completed' }, { value: 'declined', label: 'Offered and declined' }, { value: 'not_offered', label: 'Not offered or not able to complete' }];

// source: 'record' — pre-filled from the client record (editable); 'setting' — from Settings (the programme's
// grant and site IDs); 'assessment' — the assessment's own type and date; 'asked' — the interview form.
// required: the assessment cannot be marked complete without it. Every question in a section the assessment
// point asks (B-D at baseline, reassessment and annual; E at the follow-ups; F at a baseline without SUPRT-C) is
// required (1.16.0): a baseline could be saved "complete" with its screenings, diagnoses and crisis questions
// blank. Each such question has a "don't know / not recorded" or "not screened" answer, so an honest complete
// record is always possible. Free text (which medication, the ICD-10 codes, race and ethnicity, language) and
// the date of birth are not required. This is SUDS's reading of what the handbook requires: check it against
// the current SUPRT-A handbook.
const ITEMS = [
  { key: 'A_client_id', section: 'A', label: 'Client ID (the SUDS client code, not a name)', type: 'text', at: ALL, source: 'record', readonly: true, required: true },
  { key: 'A_grant_id', section: 'A', label: 'Grant ID', type: 'text', at: ALL, source: 'setting', readonly: true },
  { key: 'A_site_id', section: 'A', label: 'Site ID', type: 'text', at: ALL, source: 'setting', readonly: true },
  { key: 'A_assessment_type', section: 'A', label: 'Assessment', type: 'text', at: ALL, source: 'assessment', readonly: true, required: true },
  { key: 'A_assessment_date', section: 'A', label: 'Date of assessment', type: 'date', at: ALL, source: 'assessment', readonly: true, required: true },
  { key: 'A_first_service_date', section: 'A', label: 'Date of first service', type: 'date', at: ALL, source: 'record', required: true, help: 'The first visit recorded for this client (or the intake date).' },
  { key: 'A_suprt_c', section: 'A', label: 'Client questionnaire (SUPRT-C) at this assessment', type: 'choice', options: SUPRT_C, at: NOT_CLOSEOUT, source: 'asked', required: true, help: 'SUDS does not hold the questionnaire itself: it is completed with SAMHSA\'s own form. Demographics are asked here only when it was not completed.' },
  { key: 'A_closeout_reason', section: 'A', label: 'Reason for closeout', type: 'choice', options: CLOSEOUT_REASONS, at: ['closeout'], source: 'record', required: true, help: 'Pre-filled from the discharge reason, where one is recorded.' },
  { key: 'A_last_service_date', section: 'A', label: 'Date of last service', type: 'date', at: ['closeout'], source: 'record', required: true },
  { key: 'B_primary_substance', section: 'B', label: 'Primary substance', type: 'choice', options: C.SUBSTANCES.map(v => ({ value: v, label: v })), at: NOT_CLOSEOUT, source: 'record', required: true },
  { key: 'B_route_of_use', section: 'B', label: 'Usual route of use', type: 'choice', options: ROUTE, at: NOT_CLOSEOUT, source: 'record', required: true },
  { key: 'B_overdose_ever', section: 'B', label: 'Ever had an overdose', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'record', required: true },
  { key: 'B_overdose_since_last', section: 'B', label: 'Overdose since the last assessment (at baseline: in the 30 days before it)', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'record', required: true },
  { key: 'B_moud', section: 'B', label: 'Receiving medication for opioid use disorder (MOUD)', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'record', required: true },
  { key: 'B_moud_medication', section: 'B', label: 'Which medication', type: 'text', at: NOT_CLOSEOUT, source: 'record' },
  { key: 'B_co_occurring_mh', section: 'B', label: 'Co-occurring mental health condition', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'record', required: true },
  { key: 'B_crisis_since_last', section: 'B', label: 'Behavioral health crisis, or a crisis response requested, since the last assessment (at baseline: in the 30 days before it)', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'asked', required: true },
  { key: 'B_residential_tx_since_last', section: 'B', label: 'Residential substance use disorder treatment since the last assessment (at baseline: in the 30 days before it)', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'asked', required: true },
  { key: 'C_substance_use_screen', section: 'C', label: 'Substance use screening result', type: 'choice', options: SCREEN, at: NOT_CLOSEOUT, source: 'record', help: 'From the latest DAST-10 or AUDIT-C in SUDS, where one was given.', required: true },
  { key: 'C_mental_health_screen', section: 'C', label: 'Mental health screening result', type: 'choice', options: SCREEN, at: NOT_CLOSEOUT, source: 'record', help: 'From the latest PHQ-9 or GAD-7 in SUDS, where one was given.', required: true },
  { key: 'C_suicide_risk_screen', section: 'C', label: 'Suicide risk screening result', type: 'choice', options: SCREEN, at: NOT_CLOSEOUT, source: 'record', help: 'From PHQ-9 item 9, where a PHQ-9 was given; otherwise ask.', required: true },
  { key: 'C_trauma_screen', section: 'C', label: 'Trauma screening result', type: 'choice', options: SCREEN, at: NOT_CLOSEOUT, source: 'asked', required: true },
  { key: 'D_icd10_codes', section: 'D', label: 'Current diagnoses (ICD-10-CM codes, as made by a clinician)', type: 'text', at: NOT_CLOSEOUT, source: 'record', help: 'The ICD-10 codes on the client\'s active problem list.' },
  { key: 'D_oud', section: 'D', label: 'Opioid use disorder diagnosis (F11)', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'record', required: true },
  { key: 'D_stimulant_use_disorder', section: 'D', label: 'Stimulant use disorder diagnosis (F14, F15)', type: 'choice', options: YES_NO, at: NOT_CLOSEOUT, source: 'record', required: true },
  ...SERVICE_CATEGORIES.map(([k, label]) => ({ key: `E_${k}`, section: 'E', label, type: 'choice', options: YES_NO, at: FOLLOW, source: 'record', required: true })),
  { key: 'F_date_of_birth', section: 'F', label: 'Date of birth', type: 'date', at: ['baseline'], source: 'record', demographics: true },
  { key: 'F_gender', section: 'F', label: 'Gender', type: 'choice', options: GENDER, at: ['baseline'], source: 'record', demographics: true, required: true },
  { key: 'F_race', section: 'F', label: 'Race (codes)', type: 'text', at: ['baseline'], source: 'record', demographics: true },
  { key: 'F_ethnicity', section: 'F', label: 'Ethnicity', type: 'text', at: ['baseline'], source: 'record', demographics: true },
  { key: 'F_language', section: 'F', label: 'Preferred language', type: 'text', at: ['baseline'], source: 'record', demographics: true },
  { key: 'F_veteran', section: 'F', label: 'Veteran', type: 'choice', options: YES_NO, at: ['baseline'], source: 'record', demographics: true, required: true },
  { key: 'F_housing', section: 'F', label: 'Housing status', type: 'choice', options: HOUSING, at: ['baseline'], source: 'record', demographics: true, required: true },
  { key: 'F_insurance', section: 'F', label: 'Health insurance', type: 'choice', options: INSURANCE, at: ['baseline'], source: 'record', demographics: true, required: true },
];
const ITEM = Object.fromEntries(ITEMS.map(i => [i.key, i]));
/** The items asked at this assessment point (demographics only when SUPRT-C was not completed). */
function itemsFor(type, answers = {}) {
  return ITEMS.filter(i => i.at.includes(type) && !(i.demographics && answers.A_suprt_c === 'completed'));
}

// ---- dates ----
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const today = () => require('./routes/budget').localDate();
const dec = (v) => { if (!v) return null; try { return decrypt(v); } catch { return null; } };
/** Days to the reassessment: 180 (six months) unless the programme's SOR contract says 90 (setting). */
function reassessmentDays() { return db.getSetting('suprt_reassessment_months', '6') === '3' ? 90 : 180; }

/**
 * The assessments due in one client's SUPRT cycle, as a pure function of its dates (tested directly).
 *   baseline: the baseline's date; done: [{ type, date }] after it; closeout: the closeout's date, or null;
 *   discharge: the date the client stopped receiving services (discharged), or null; on: today;
 *   reassessDays: 90 or 180.
 * Returns [{ type, occurrence, due, opens, closes, status, overdue, done_date, in_window }] where status is
 * 'done', 'upcoming' (its window has not opened), 'open' (in its window; overdue once past the due date),
 * 'missed' (the window closed without it) or 'not_required' (the client closed out before it was due).
 */
function schedule({ baseline, done = [], closeout = null, discharge = null, on, reassessDays = 180 }) {
  if (!baseline || !DAY.test(baseline)) return [];
  const out = [];
  const byType = (t) => done.filter(d => d.type === t).map(d => d.date).sort();
  const entry = (type, occurrence, due, opens, closes, taken) => {
    const doneDate = taken.find(d => d >= opens && d <= closes) || null;
    let status;
    if (doneDate) status = 'done';
    else if (closeout && opens > closeout) return null;
    else if (closeout && closes >= closeout) status = 'not_required';
    else if (on < opens) status = 'upcoming';
    else if (on <= closes) status = 'open';
    else status = 'missed';
    return { type, occurrence, due, opens, closes, status, overdue: status === 'open' && on > due, done_date: doneDate, in_window: !!doneDate };
  };
  // The reassessment: one, at 90 or 180 days. A reassessment recorded outside its window still counts as
  // taken (late or early), and says so.
  const re = byType('reassessment');
  const reDue = addDays(baseline, reassessDays);
  const r = entry('reassessment', 1, reDue, addDays(reDue, -WINDOW_DAYS), addDays(reDue, WINDOW_DAYS), re);
  if (r) { if (r.status !== 'done' && re.length && r.status !== 'not_required') Object.assign(r, { status: 'done', done_date: re[0], in_window: false, overdue: false }); out.push(r); }
  // Annual assessments every 365 days, up to the next one that has not opened yet.
  const an = byType('annual');
  for (let k = 1; k <= 50; k++) {
    const due = addDays(baseline, 365 * k);
    const e = entry('annual', k, due, addDays(due, -WINDOW_DAYS), addDays(due, WINDOW_DAYS), an);
    if (!e) break;
    out.push(e);
    if (e.status === 'upcoming' || e.status === 'not_required') break;
  }
  // Closeout: once services have ended (a discharge) and no closeout is on file, due within 30 days.
  if (closeout) out.push({ type: 'closeout', occurrence: 1, due: closeout, opens: closeout, closes: closeout, status: 'done', overdue: false, done_date: closeout, in_window: true });
  else if (discharge && discharge >= baseline) {
    const due = addDays(discharge, ENTRY_DAYS);
    out.push({ type: 'closeout', occurrence: 1, due, opens: discharge, closes: due, status: on <= due ? 'open' : 'missed', overdue: false, done_date: null, in_window: false });
  }
  return out;
}

// ---- the client record: what SUDS already knows ----
/** Is the client's first date of service, and every SOR-funded date, on the books? */
function firstServiceDate(clientId) {
  const r = db.one(`SELECT MIN(substr(occurred_at,1,10)) d FROM interventions WHERE client_id=?`, clientId);
  const c = db.one(`SELECT intake_date FROM clients WHERE id=?`, clientId) || {};
  return [r && r.d, c.intake_date].filter(Boolean).sort()[0] || null;
}
const yn = (v) => (v === null || v === undefined ? null : v ? 'yes' : 'no');
// The discharge reasons SUDS records, as SUPRT closeout reasons.
const CLOSEOUT_FROM_DISCHARGE = { completed: 'services_completed', transferred: 'transferred', incarcerated: 'incarcerated', moved: 'moved', lost_contact: 'no_contact', declined: 'declined_services', deceased: 'deceased', other: 'other' };

/**
 * The answers SUDS can give from the client record for an assessment of `type` on `date`; `since` is the
 * previous assessment's date (the period section E and "since the last assessment" cover), or null at
 * baseline (the 30 days before it). Returns { answers, derived: [keys] }. Every answer is a suggestion the
 * worker can change; items the record cannot answer are left for the interview.
 */
function derive(clientId, { type, date, since = null }) {
  const c = db.one(`SELECT * FROM clients WHERE id=?`, clientId);
  if (!c) return { answers: {}, derived: [] };
  const from = since || addDays(date, -30);
  const a = {};
  a.A_client_id = c.client_code;
  a.A_grant_id = db.getSetting('suprt_grant_id', '') || null;
  a.A_site_id = db.getSetting('suprt_site_id', '') || null;
  a.A_assessment_type = type;
  a.A_assessment_date = date;
  a.A_first_service_date = firstServiceDate(clientId);
  if (type === 'closeout') {
    const ep = db.one(`SELECT discharge_reason FROM episodes WHERE client_id=? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1`, clientId);
    const reason = (ep && ep.discharge_reason) || c.discharge_reason;
    a.A_closeout_reason = CLOSEOUT_FROM_DISCHARGE[reason] || null;
    const last = db.one(`SELECT MAX(substr(occurred_at,1,10)) d FROM interventions WHERE client_id=? AND substr(occurred_at,1,10) <= ?`, clientId, date);
    a.A_last_service_date = (last && last.d) || null;
  }
  if (type !== 'closeout') {
    a.B_primary_substance = c.primary_substance || null;
    a.B_route_of_use = c.route_of_use && ITEM.B_route_of_use.options.some(o => o.value === c.route_of_use) ? c.route_of_use : null;
    const odEver = db.one(`SELECT COUNT(*) n FROM overdose_events WHERE client_id=? AND substr(occurred_at,1,10) <= ?`, clientId, date).n;
    // Only what the record says (1.16.0): an overdose on file is a yes; "no" only when someone recorded that
    // there has never been one. A question nobody asked (NULL) is left for the interview, not read as "no".
    const neverOd = c.overdose_history === 0 && !c.last_overdose_date;
    a.B_overdose_ever = c.overdose_history || odEver ? 'yes' : neverOd ? 'no' : null;
    const odSince = db.one(`SELECT COUNT(*) n FROM overdose_events WHERE client_id=? AND substr(occurred_at,1,10) > ? AND substr(occurred_at,1,10) <= ?`, clientId, from, date).n;
    const lastOd = c.last_overdose_date && c.last_overdose_date > from && c.last_overdose_date <= date;
    a.B_overdose_since_last = odSince || lastOd ? 'yes' : neverOd && !odEver ? 'no' : null;
    a.B_moud = c.mat_status ? (c.mat_status === 'active' ? 'yes' : 'no') : null;
    a.B_moud_medication = c.mat_status === 'active' ? c.mat_medication || null : null;
    a.B_co_occurring_mh = yn(c.co_occurring_mh);
    // Screenings: the latest instrument given up to the assessment date (a positive result is kept as the result).
    const latest = (instruments) => db.one(`SELECT instrument, positive, safety_flag FROM outcome_measures WHERE client_id=? AND instrument IN (${instruments.map(() => '?').join(',')}) AND substr(administered_at,1,10) <= ? ORDER BY administered_at DESC LIMIT 1`, clientId, ...instruments, date);
    const res = (m) => (!m || m.positive === null || m.positive === undefined ? null : m.positive ? 'positive' : 'negative');
    a.C_substance_use_screen = res(latest(['dast10', 'auditc']));
    a.C_mental_health_screen = res(latest(['phq9', 'gad7']));
    const phq = latest(['phq9']);
    a.C_suicide_risk_screen = phq ? (phq.safety_flag ? 'positive' : 'negative') : null;
    // Diagnoses: the ICD-10 codes on the active problem list.
    const codes = [...new Set(db.all(`SELECT icd10_code_enc FROM problems WHERE client_id=? AND status='active' AND icd10_code_enc IS NOT NULL`, clientId).map(p => String(dec(p.icd10_code_enc) || '').trim().toUpperCase()).filter(Boolean))].sort();
    a.D_icd10_codes = codes.length ? codes.join(', ') : null;
    a.D_oud = codes.length ? (codes.some(x => x.startsWith('F11')) ? 'yes' : 'no') : null;
    a.D_stimulant_use_disorder = codes.length ? (codes.some(x => x.startsWith('F14') || x.startsWith('F15')) ? 'yes' : 'no') : null;
  }
  if (type !== 'baseline') {
    // Services received since the last assessment, by SUDS's visit types.
    const types = new Set(db.all(`SELECT DISTINCT type FROM interventions WHERE client_id=? AND substr(occurred_at,1,10) > ? AND substr(occurred_at,1,10) <= ?`, clientId, from, date).map(x => x.type));
    const kits = db.one(`SELECT COALESCE(SUM(naloxone_kits),0) n FROM interventions WHERE client_id=? AND substr(occurred_at,1,10) > ? AND substr(occurred_at,1,10) <= ?`, clientId, from, date).n;
    const refs = db.all(`SELECT res.category FROM referrals r LEFT JOIN resources res ON res.id=r.resource_id WHERE r.client_id=? AND substr(r.referred_at,1,10) > ? AND substr(r.referred_at,1,10) <= ?`, clientId, from, date).map(x => x.category);
    for (const [k, , visitTypes] of SERVICE_CATEGORIES) a[`E_${k}`] = visitTypes.some(t => types.has(t)) ? 'yes' : 'no';
    if (kits > 0) a.E_naloxone = 'yes';
    if (refs.length) a.E_treatment_referral = 'yes';
    a.E_moud = c.mat_status === 'active' || refs.some(x => x === 'mat_otp' || x === 'mat_obot') ? 'yes' : 'no';
  }
  if (type === 'baseline') {
    a.F_date_of_birth = dec(c.dob_enc);
    const inList = (key, v) => (v && ITEM[key].options.some(o => o.value === v) ? v : null);
    a.F_gender = inList('F_gender', c.gender);
    a.F_race = c.race_codes || null;
    a.F_ethnicity = c.race_ethnicity || null;
    a.F_language = c.preferred_language || null;
    a.F_veteran = yn(c.veteran);
    a.F_housing = inList('F_housing', c.housing_status);
    a.F_insurance = inList('F_insurance', c.insurance);
  }
  const answers = {}; const derived = [];
  for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined && v !== '' && ITEM[k] && ITEM[k].at.includes(type)) { answers[k] = String(v); if (ITEM[k].source !== 'asked') derived.push(k); }
  return { answers, derived };
}

/**
 * Check a set of answers for an assessment: every key is an item of this assessment point, every value is text
 * of a sane length, a choice is one of its options and a date is a date. Returns { answers, missing } where
 * missing lists the required items not answered (an assessment cannot be marked complete with any).
 */
function cleanAnswers(type, input) {
  const out = {}; const errors = {};
  const allowed = new Set(ITEMS.filter(i => i.at.includes(type)).map(i => i.key));
  for (const [k, v] of Object.entries(input || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (!allowed.has(k)) { errors[k] = `is not asked at ${TYPE_LABEL[type] || type}`; continue; }
    const it = ITEM[k]; const s = String(v).trim();
    if (s.length > 500) { errors[k] = 'must be at most 500 characters'; continue; }
    if (it.type === 'choice' && !it.options.some(o => o.value === s)) { errors[k] = `must be one of ${it.options.map(o => o.value).join(', ')}`; continue; }
    if (it.type === 'date' && (!DAY.test(s) || !Number.isFinite(Date.parse(s)))) { errors[k] = 'must be a date (YYYY-MM-DD)'; continue; }
    out[k] = s;
  }
  const missing = itemsFor(type, out).filter(i => (i.required || (i.key === 'B_moud_medication' && out.B_moud === 'yes')) && !out[i.key]).map(i => i.key);
  return { answers: out, errors, missing };
}

/** The one-row-per-assessment layout of the SPARS entry file: SUDS's variable names, in section order. */
const EXPORT_COLUMNS = ITEMS.map(i => ({ key: i.key, label: i.key }));
const EXPORT_NOTE = 'For entry into SPARS - check against the current SUPRT handbook and SUPRT-A codebook. SUDS\'s own variable names and answer codes, in SUPRT-A section order (A record management, B history, C screenings, D diagnoses, E services, F demographics); not the SPARS batch upload template, and not certified or accepted by SAMHSA or DHCS.';
// The disclosure: a SPARS entry file names clients (the client ID, a date of birth, diagnoses), so it goes
// through the disclosure gate like the identified export. Its bases: each client's Part 2 consent naming
// the recipient, or an audit or evaluation approval on file with it (42 CFR §2.53).
const EXPORT_BASES = ['consent', 'audit_evaluation'];
const DEFAULT_RECIPIENT = 'SAMHSA';
const DEFAULT_PURPOSE = 'State Opioid Response (SOR) grant performance reporting to SAMHSA (SUPRT-A, entered in SPARS)';

module.exports = { TYPES, TYPE_LABEL, SECTIONS, ITEMS, ITEM, SERVICE_CATEGORIES, WINDOW_DAYS, ENTRY_DAYS, itemsFor, schedule, derive, cleanAnswers, reassessmentDays, addDays, today, firstServiceDate, EXPORT_COLUMNS, EXPORT_NOTE, EXPORT_BASES, DEFAULT_RECIPIENT, DEFAULT_PURPOSE };
