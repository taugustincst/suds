'use strict';
// Which outcomes SUDS can show for money spent under each opioid settlement category (1.17.0,
// docs/compliance/HARM-REDUCTION-REPORTING.md "Settlement outcomes"). The one place the mapping lives: the
// Settlement outcomes page, its files and test/settlement-outcome-map.test.js read it from here.
//
// An indicator is something SUDS already records, counted for the work charged to a settlement fund in the
// period (a visit, an overdose event, an episode and a time entry each name the fund they are charged to;
// a referral counts for a fund when the person referred was served under it in the period). Nothing here is a
// new data item, and none is an official state measure: they are what the programme's own records show.
//
// kind says how a figure is protected (server/small-cells.js, as the funder report's are):
//   'count'  - not a count of people (kits, strips, syringes, contacts, hours): exact.
//   'event'  - one person's each, and each charged to exactly one fund (a reversal, an admission): small counts
//              hidden, and the funds' figures add up to the settlement total, so they are protected as a partition.
//   'person' - people, unduplicated (people served, linked, trained) or a person's own referrals: small counts
//              hidden; one person may count under two funds, so each fund's figure is a subset of the total.
// cost: whether "cost per" is a meaningful figure for it (spending under the category divided by it).

const INDICATORS = {
  contacts: { label: 'Contacts (visits and outreach contacts)', short: 'Contacts', kind: 'count', cost: true, unit: 'contact' },
  naloxone_kits: { label: 'Naloxone kits distributed', short: 'Naloxone kits', kind: 'count', cost: true, unit: 'kit' },
  reversals: { label: 'Overdose reversals reported (naloxone used, the person survived)', short: 'Reversals reported', kind: 'event', cost: true, unit: 'reversal reported' },
  fentanyl_strips: { label: 'Fentanyl test strips distributed', short: 'Test strips', kind: 'count', cost: false },
  syringes: { label: 'Syringes distributed', short: 'Syringes', kind: 'count', cost: false },
  people_served: { label: 'People served (unduplicated)', short: 'People served', kind: 'person', cost: true, unit: 'person served' },
  referrals_made: { label: 'Referrals made for the people served', short: 'Referrals made', kind: 'person', cost: false },
  people_linked: { label: 'People linked to care (a referral admitted or completed)', short: 'People linked to care', kind: 'person', cost: true, unit: 'person linked' },
  moud_linked: { label: 'People linked to medication for OUD (a MAT referral admitted or completed)', short: 'Linked to MOUD', kind: 'person', cost: true, unit: 'person linked to MOUD' },
  treatment_admissions: { label: 'Treatment admissions (episodes of care opened)', short: 'Admissions', kind: 'event', cost: true, unit: 'admission' },
  education_contacts: { label: 'Education and training sessions (visits recorded as Education)', short: 'Education sessions', kind: 'count', cost: true, unit: 'session' },
  people_trained: { label: 'People trained (unduplicated participants in education sessions)', short: 'People trained', kind: 'person', cost: true, unit: 'person trained' },
  staff_training_hours: { label: 'Staff training hours (approved time recorded as Training)', short: 'Staff training hours', kind: 'count', cost: false },
};

// The kinds of work a category pays for, and what shows for each (in order, the first being the headline).
const PROFILES = {
  naloxone: { label: 'Overdose reversal (naloxone)', indicators: ['naloxone_kits', 'reversals', 'contacts'] },
  harm_reduction: { label: 'Harm reduction and syringe services', indicators: ['contacts', 'naloxone_kits', 'fentanyl_strips', 'syringes', 'reversals', 'people_served'] },
  treatment: { label: 'Treatment', indicators: ['people_served', 'treatment_admissions', 'people_linked', 'moud_linked'] },
  connections: { label: 'Connections to care and recovery', indicators: ['people_served', 'referrals_made', 'people_linked', 'moud_linked'] },
  prevention: { label: 'Prevention', indicators: ['education_contacts', 'people_trained', 'contacts'] },
  training: { label: 'Training', indicators: ['people_trained', 'education_contacts', 'staff_training_hours'] },
  // Leadership, planning, research and data, and spending that is not a remediation use: nothing SUDS records
  // measures them, so only the spending is shown (with a sentence saying so).
  none: { label: 'No outcome SUDS records', indicators: [] },
};

// Exhibit E allowable use (constants.SETTLEMENT_USES) -> profile. Every code must be here
// (test/settlement-outcome-map.test.js).
const BY_USE = {
  core_a: 'naloxone', core_b: 'treatment', core_c: 'treatment', core_d: 'treatment', core_e: 'connections', core_f: 'treatment',
  core_g: 'prevention', core_h: 'harm_reduction', core_i: 'none',
  approved_a: 'treatment', approved_b: 'connections', approved_c: 'connections', approved_d: 'treatment', approved_e: 'treatment',
  approved_f: 'prevention', approved_g: 'prevention', approved_h: 'harm_reduction', approved_i: 'training', approved_j: 'none',
  approved_k: 'training', approved_l: 'none', none: 'none',
};
// A fund with no allowable use recorded but a California High Impact Abatement Activity: that says what it pays for.
const BY_HIAA = { hiaa_1: 'treatment', hiaa_2: 'treatment', hiaa_3: 'connections', hiaa_4: 'harm_reduction', hiaa_5: 'prevention', hiaa_6: 'naloxone', none: 'none' };

/** The profile key for a fund's category: its allowable use, else its HIAA, else none. */
function profileFor(use, hiaa) {
  if (use && BY_USE[use]) return BY_USE[use];
  if (hiaa && BY_HIAA[hiaa]) return BY_HIAA[hiaa];
  return 'none';
}
/** The indicator keys shown for a category. */
const indicatorsFor = (use, hiaa) => PROFILES[profileFor(use, hiaa)].indicators;

/**
 * Spending per outcome, to the cent, or null where it means nothing: no spending, a figure of 0, or a figure
 * that is not a number (hidden as "<11" or "suppressed": dividing exact money by it would give the count away).
 */
function costPer(amount, count) {
  if (typeof amount !== 'number' || !(amount > 0) || typeof count !== 'number' || !(count > 0)) return null;
  return Math.round((amount / count) * 100) / 100;
}

/** The "why nothing" sentence for a category with no indicator. */
const NO_OUTCOME_NOTE = 'SUDS records no outcome for this kind of spending (planning, leadership, research or administration): only the spending is shown. Describe what it achieved in the narrative of your report.';
const UNCATEGORISED_NOTE = 'This fund has no settlement category, so SUDS cannot say which outcomes its spending is for. Set its allowable use under Funding & spending.';

module.exports = { INDICATORS, PROFILES, BY_USE, BY_HIAA, profileFor, indicatorsFor, costPer, NO_OUTCOME_NOTE, UNCATEGORISED_NOTE };
