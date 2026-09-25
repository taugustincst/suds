'use strict';
// Clinical documentation reference data and scoring: the CalAIM problem list's code checks and social
// determinant (Z) codes, the six ASAM dimensions, and the standardized screening instruments used as
// outcome measures. Pure data and pure functions, shared by the office server, the local kernel and (via
// GET /api/meta/constants) the browser, so a score shown while the form is filled in is the score saved.
//
// What is and is not here, and why:
// * ASAM: only the six dimension names (as in The ASAM Criteria, 3rd edition, which DHCS still cites) and a
//   generic 0-4 risk rating. The criteria text itself is copyrighted and is not reproduced.
// * PHQ-9 and GAD-7 (Spitzer, Kroenke, Williams et al.; Pfizer): free to reproduce, translate, display and
//   distribute; no permission required.
// * AUDIT-C (the first three AUDIT questions; WHO / US Department of Veterans Affairs): public domain.
// * DAST-10 (Skinner, 1982): copyright Harvey A. Skinner; may be reproduced for non-commercial clinical,
//   research and training use with credit, which is how a county programme uses it. The credit line is
//   shown with the form.
// * A single self-rated wellbeing item (0-10), written for SUDS, as a simple recovery-capital style check.
// * Deliberately NOT included: BAM, BARC-10, ARC, CAGE-AID and other instruments whose licensing for use in
//   software could not be confirmed. A programme that holds a licence can record them as county forms.

// ---- ICD-10-CM codes (format only; no code set is bundled) ----
// A letter, two characters, then optionally a dot and up to four more ("F11.20", "Z59.02", "U07.1").
const ICD10_RE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
/** Normalise a typed code ("f1120", " F11.20 ") to "F11.20", or return null when it is not ICD-10-CM shaped. */
function normalizeIcd10(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (!s.includes('.') && s.length > 3) s = `${s.slice(0, 3)}.${s.slice(3)}`;
  return ICD10_RE.test(s) ? s : null;
}
// Social determinants of health: ICD-10-CM Z55-Z65. A code in that range is accepted even if it is not on
// the short list below (the list is what the form offers, not a limit).
const Z_RANGE_RE = /^Z(5[5-9]|6[0-5])(\.[0-9A-Z]{1,4})?$/;
const isZCode = (code) => Z_RANGE_RE.test(code || '');
const Z_CODES = [
  { code: 'Z55.0', label: 'Illiteracy and low-level literacy' },
  { code: 'Z55.9', label: 'Problems related to education and literacy, unspecified' },
  { code: 'Z56.0', label: 'Unemployment, unspecified' },
  { code: 'Z56.9', label: 'Unspecified problems related to employment' },
  { code: 'Z59.00', label: 'Homelessness, unspecified' },
  { code: 'Z59.01', label: 'Sheltered homelessness' },
  { code: 'Z59.02', label: 'Unsheltered homelessness' },
  { code: 'Z59.1', label: 'Inadequate housing' },
  { code: 'Z59.41', label: 'Food insecurity' },
  { code: 'Z59.6', label: 'Low income' },
  { code: 'Z59.7', label: 'Insufficient social insurance and welfare support' },
  { code: 'Z59.811', label: 'Housing instability, housed, with risk of homelessness' },
  { code: 'Z59.82', label: 'Transportation insecurity' },
  { code: 'Z59.86', label: 'Financial insecurity' },
  { code: 'Z60.2', label: 'Problems related to living alone' },
  { code: 'Z60.4', label: 'Social exclusion and rejection' },
  { code: 'Z60.5', label: 'Target of (perceived) adverse discrimination and persecution' },
  { code: 'Z62.9', label: 'Problem related to upbringing, unspecified' },
  { code: 'Z63.0', label: 'Problems in relationship with spouse or partner' },
  { code: 'Z63.4', label: 'Disappearance and death of family member' },
  { code: 'Z63.72', label: 'Alcoholism and drug addiction in family' },
  { code: 'Z63.8', label: 'Other specified problems related to primary support group' },
  { code: 'Z64.4', label: 'Discord with counselors' },
  { code: 'Z65.1', label: 'Imprisonment and other incarceration' },
  { code: 'Z65.2', label: 'Problems related to release from prison' },
  { code: 'Z65.3', label: 'Problems related to other legal circumstances' },
  { code: 'Z65.4', label: 'Victim of crime and terrorism' },
  { code: 'Z65.8', label: 'Other specified problems related to psychosocial circumstances' },
];

const PROBLEM_STATUSES = ['active', 'resolved', 'inactive'];
const PROBLEM_SOURCES = ['self_report', 'assessment', 'referral', 'other'];
const GOAL_STATUSES = ['active', 'met', 'partially_met', 'not_met', 'discontinued'];
const STEP_OWNERS = ['client', 'staff', 'family_support', 'other_provider'];
const STEP_STATUSES = ['open', 'done', 'cancelled'];

// ---- ASAM ----
const ASAM_DIMENSIONS = [
  { key: 'd1', label: 'Dimension 1: Acute intoxication and/or withdrawal potential' },
  { key: 'd2', label: 'Dimension 2: Biomedical conditions and complications' },
  { key: 'd3', label: 'Dimension 3: Emotional, behavioral, or cognitive conditions and complications' },
  { key: 'd4', label: 'Dimension 4: Readiness to change' },
  { key: 'd5', label: 'Dimension 5: Relapse, continued use, or continued problem potential' },
  { key: 'd6', label: 'Dimension 6: Recovery/living environment' },
];
const ASAM_RATINGS = [
  { value: 0, label: '0 — No risk / no current problem' },
  { value: 1, label: '1 — Mild' },
  { value: 2, label: '2 — Moderate' },
  { value: 3, label: '3 — Significant' },
  { value: 4, label: '4 — Severe' },
];
// Why the level the person was referred to differs from the level recommended (the "discrepancy" DHCS asks
// counties to document).
const ASAM_DISCREPANCY_REASONS = ['client_preference', 'level_not_available', 'waitlist', 'geographic_accessibility', 'family_responsibilities', 'legal_issues', 'language_or_cultural', 'clinical_judgment', 'payment_or_coverage', 'other'];

// ---- Screening instruments ----
const FREQ4 = [{ value: 0, label: 'Not at all' }, { value: 1, label: 'Several days' }, { value: 2, label: 'More than half the days' }, { value: 3, label: 'Nearly every day' }];
const YES_NO = [{ value: 1, label: 'Yes' }, { value: 0, label: 'No' }];
const INSTRUMENTS = {
  phq9: {
    code: 'phq9', name: 'PHQ-9', title: 'Patient Health Questionnaire (depression)', better: 'lower', max: 27,
    stem: 'Over the last 2 weeks, how often have you been bothered by any of the following problems?',
    credit: 'PHQ-9 © Pfizer Inc. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues. No permission required to reproduce, translate, display or distribute.',
    items: [
      'Little interest or pleasure in doing things',
      'Feeling down, depressed, or hopeless',
      'Trouble falling or staying asleep, or sleeping too much',
      'Feeling tired or having little energy',
      'Poor appetite or overeating',
      'Feeling bad about yourself — or that you are a failure or have let yourself or your family down',
      'Trouble concentrating on things, such as reading the newspaper or watching television',
      'Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual',
      'Thoughts that you would be better off dead or of hurting yourself in some way',
    ].map(text => ({ text, options: FREQ4 })),
    bands: [[0, 4, 'Minimal'], [5, 9, 'Mild'], [10, 14, 'Moderate'], [15, 19, 'Moderately severe'], [20, 27, 'Severe']],
    positiveAt: 10,
    // Item 9 (index 8) above "Not at all" is a safety alert whatever the total.
    safetyItem: 8,
  },
  gad7: {
    code: 'gad7', name: 'GAD-7', title: 'Generalized Anxiety Disorder scale', better: 'lower', max: 21,
    stem: 'Over the last 2 weeks, how often have you been bothered by the following problems?',
    credit: 'GAD-7 © Pfizer Inc. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues. No permission required to reproduce, translate, display or distribute.',
    items: [
      'Feeling nervous, anxious, or on edge',
      'Not being able to stop or control worrying',
      'Worrying too much about different things',
      'Trouble relaxing',
      'Being so restless that it is hard to sit still',
      'Becoming easily annoyed or irritable',
      'Feeling afraid, as if something awful might happen',
    ].map(text => ({ text, options: FREQ4 })),
    bands: [[0, 4, 'Minimal'], [5, 9, 'Mild'], [10, 14, 'Moderate'], [15, 21, 'Severe']],
    positiveAt: 10,
  },
  auditc: {
    code: 'auditc', name: 'AUDIT-C', title: 'Alcohol Use Disorders Identification Test — consumption', better: 'lower', max: 12,
    stem: 'Think about your drinking over the past year.',
    credit: 'AUDIT-C: the first three questions of the AUDIT (World Health Organization); public domain.',
    items: [
      { text: 'How often do you have a drink containing alcohol?', options: [{ value: 0, label: 'Never' }, { value: 1, label: 'Monthly or less' }, { value: 2, label: '2–4 times a month' }, { value: 3, label: '2–3 times a week' }, { value: 4, label: '4 or more times a week' }] },
      { text: 'How many standard drinks containing alcohol do you have on a typical day?', options: [{ value: 0, label: '1 or 2' }, { value: 1, label: '3 or 4' }, { value: 2, label: '5 or 6' }, { value: 3, label: '7 to 9' }, { value: 4, label: '10 or more' }] },
      { text: 'How often do you have six or more drinks on one occasion?', options: [{ value: 0, label: 'Never' }, { value: 1, label: 'Less than monthly' }, { value: 2, label: 'Monthly' }, { value: 3, label: 'Weekly' }, { value: 4, label: 'Daily or almost daily' }] },
    ],
    // A positive screen is 4 or more for men and 3 or more for women. When the variant is not given the
    // lower cut-off is used, so nobody is screened negative by a missing answer.
    variants: [{ value: 'men', label: 'Cut-off for men (4 or more)', positiveAt: 4 }, { value: 'women', label: 'Cut-off for women (3 or more)', positiveAt: 3 }, { value: 'unspecified', label: 'Not specified (3 or more)', positiveAt: 3 }],
    positiveAt: 3,
  },
  dast10: {
    code: 'dast10', name: 'DAST-10', title: 'Drug Abuse Screening Test', better: 'lower', max: 10,
    stem: 'These questions refer to the past 12 months. "Drug use" means use of prescribed or over-the-counter drugs in excess of the directions, and any non-medical use of drugs. Do not include alcohol or tobacco.',
    credit: 'DAST-10 © 1982 Harvey A. Skinner, PhD. Reproduced for non-commercial clinical use with credit.',
    items: [
      { text: 'Have you used drugs other than those required for medical reasons?', options: YES_NO },
      { text: 'Do you abuse more than one drug at a time?', options: YES_NO },
      // Reverse scored: "No" is the answer that counts.
      { text: 'Are you always able to stop using drugs when you want to?', options: [{ value: 0, label: 'Yes' }, { value: 1, label: 'No' }] },
      { text: 'Have you had "blackouts" or "flashbacks" as a result of drug use?', options: YES_NO },
      { text: 'Do you ever feel bad or guilty about your drug use?', options: YES_NO },
      { text: 'Does your spouse (or parents) ever complain about your involvement with drugs?', options: YES_NO },
      { text: 'Have you neglected your family because of your use of drugs?', options: YES_NO },
      { text: 'Have you engaged in illegal activities in order to obtain drugs?', options: YES_NO },
      { text: 'Have you ever experienced withdrawal symptoms (felt sick) when you stopped taking drugs?', options: YES_NO },
      { text: 'Have you had medical problems as a result of your drug use (e.g., memory loss, hepatitis, convulsions, bleeding)?', options: YES_NO },
    ],
    bands: [[0, 0, 'No problems reported'], [1, 2, 'Low level'], [3, 5, 'Moderate level'], [6, 8, 'Substantial level'], [9, 10, 'Severe level']],
    positiveAt: 3,
  },
  wellbeing: {
    code: 'wellbeing', name: 'Wellbeing (0–10)', title: 'Self-rated wellbeing', better: 'higher', max: 10,
    stem: 'A single question, answered by the person in their own words and numbers.',
    credit: 'A single self-rating item written for SUDS; not a validated instrument.',
    items: [{ text: 'Overall, how are things going for you right now? (0 = the worst they could be, 10 = the best they could be)', options: Array.from({ length: 11 }, (_, i) => ({ value: i, label: String(i) })) }],
    bands: [[0, 3, 'Low'], [4, 6, 'Moderate'], [7, 10, 'Good']],
  },
};
const INSTRUMENT_CODES = Object.keys(INSTRUMENTS);

/**
 * Score one administration. `responses` is an array with one numeric answer per item, each one of the
 * values that item offers. Throws an Error with .fields for anything else (a missing, extra or impossible
 * answer), so a partial questionnaire is never stored with a misleadingly low total.
 */
function score(code, responses, { variant } = {}) {
  const ins = INSTRUMENTS[code];
  if (!ins) { const e = new Error(`Unknown instrument ${code}`); e.fields = { instrument: `must be one of ${INSTRUMENT_CODES.join(', ')}` }; throw e; }
  if (!Array.isArray(responses) || responses.length !== ins.items.length) { const e = new Error(`${ins.name} needs an answer to each of its ${ins.items.length} questions`); e.fields = { responses: `must have ${ins.items.length} answers` }; throw e; }
  const values = responses.map((raw, i) => {
    const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof v !== 'number' || !Number.isInteger(v) || !ins.items[i].options.some(o => o.value === v)) { const e = new Error(`${ins.name} question ${i + 1} has no valid answer`); e.fields = { responses: `question ${i + 1} is missing or out of range` }; throw e; }
    return v;
  });
  const total = values.reduce((a, b) => a + b, 0);
  let positiveAt = ins.positiveAt;
  let usedVariant = null;
  if (ins.variants) {
    const vv = ins.variants.find(x => x.value === variant) || ins.variants.find(x => x.value === 'unspecified');
    positiveAt = vv.positiveAt; usedVariant = vv.value;
  }
  let band;
  if (ins.bands) band = (ins.bands.find(([lo, hi]) => total >= lo && total <= hi) || [])[2] || null;
  else band = total >= positiveAt ? 'Positive screen' : 'Negative screen';
  const positive = positiveAt === undefined ? null : (total >= positiveAt ? 1 : 0);
  const safety = ins.safetyItem !== undefined && values[ins.safetyItem] > 0 ? 1 : 0;
  return { total, band, positive, safety_flag: safety, responses: values, variant: usedVariant };
}

/** Did a score move in the better direction? 1 better, -1 worse, 0 the same. */
function direction(code, baseline, latest) {
  const ins = INSTRUMENTS[code]; if (!ins || baseline === null || latest === null) return 0;
  if (latest === baseline) return 0;
  return (ins.better === 'higher' ? latest > baseline : latest < baseline) ? 1 : -1;
}

module.exports = {
  ICD10_RE, normalizeIcd10, isZCode, Z_CODES, PROBLEM_STATUSES, PROBLEM_SOURCES, GOAL_STATUSES, STEP_OWNERS, STEP_STATUSES,
  ASAM_DIMENSIONS, ASAM_RATINGS, ASAM_DISCREPANCY_REASONS, INSTRUMENTS, INSTRUMENT_CODES, score, direction,
};
