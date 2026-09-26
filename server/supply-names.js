'use strict';
// The vocabulary of the supply model (docs/SUPPLIES.md): item categories, naloxone products, receiving
// sources, adjustment and disposal reasons, site kinds. Codes are what is stored; labels are what a person
// reads (UI strings, so American spelling). No database here: server/db.js reads it during migration 44.

const CATEGORIES = [
  { code: 'naloxone', label: 'Naloxone', unit: 'kit' },
  { code: 'fentanyl_test_strips', label: 'Fentanyl test strips', unit: 'strip' },
  { code: 'xylazine_test_strips', label: 'Xylazine test strips', unit: 'strip' },
  { code: 'syringes', label: 'Syringes', unit: 'syringe' },
  { code: 'sharps_container', label: 'Sharps containers', unit: 'container' },
  { code: 'cookers', label: 'Cookers', unit: 'each' },
  { code: 'cottons', label: 'Cottons', unit: 'each' },
  { code: 'alcohol_pads', label: 'Alcohol pads', unit: 'pad' },
  { code: 'safer_smoking', label: 'Pipes and safer-smoking kits', unit: 'kit' },
  { code: 'wound_care', label: 'Wound care', unit: 'kit' },
  { code: 'condoms', label: 'Condoms', unit: 'each' },
  { code: 'hygiene_kit', label: 'Hygiene kits', unit: 'kit' },
  { code: 'other', label: 'Other', unit: 'each' },
];
// The naloxone products the Naloxone Distribution Project and CDPH distribute. The NDP log carries the product
// of each kit where the visit recorded it.
const NALOXONE_PRODUCTS = [
  { code: 'nasal_4mg', label: 'Nasal spray 4 mg' },
  { code: 'nasal_8mg', label: 'Nasal spray 8 mg' },
  { code: 'nasal_3mg', label: 'Nasal spray 3 mg' },
  { code: 'im_vial', label: 'Injectable 0.4 mg/mL vial' },
  { code: 'im_ampule', label: 'Injectable 0.4 mg/mL ampule' },
  { code: 'im_prefilled', label: 'Injectable 0.4 mg prefilled syringe' },
  { code: 'other', label: 'Other naloxone product' },
];
const SOURCES = [
  { code: 'ndp', label: 'DHCS Naloxone Distribution Project (NDP)' },
  { code: 'cdph_clearinghouse', label: 'CDPH syringe services supply clearinghouse' },
  { code: 'purchase', label: 'Purchased (with a fund)' },
  { code: 'donation', label: 'Donation' },
  { code: 'other', label: 'Other' },
];
// Adjustment reasons a person chooses. 'shortfall' is written by SUDS itself, never chosen (see server/supplies.js).
const ADJUST_REASONS = [
  { code: 'count_correction', label: 'Count correction (after counting the shelf)' },
  { code: 'damaged', label: 'Damaged' },
  { code: 'expired', label: 'Expired' },
  { code: 'lost', label: 'Lost or stolen' },
  { code: 'other', label: 'Other' },
];
const DISPOSAL_REASONS = [
  { code: 'expired', label: 'Expired' },
  { code: 'damaged', label: 'Damaged' },
  { code: 'recalled', label: 'Recalled' },
];
const SITE_KINDS = [
  { code: 'office', label: 'Office' }, { code: 'van', label: 'Van or mobile unit' }, { code: 'drop_in', label: 'Drop-in center' },
  { code: 'partner', label: 'Partner site' }, { code: 'other', label: 'Other' },
];
const KIND_LABELS = {
  opening: 'Opening balance', received: 'Received', transfer_out: 'Transferred out', transfer_in: 'Transferred in', adjustment: 'Adjustment',
  disposal: 'Disposed of', distributed: 'Handed out on a visit', restored: 'Put back (visit corrected)',
};
// The two supply counts every report has always read from the visit itself (interventions.naloxone_kits,
// interventions.fentanyl_strips): each is the sum of the visit's items of one category.
const COUNTED = { naloxone_kits: 'naloxone', fentanyl_strips: 'fentanyl_test_strips' };

const codes = (list) => list.map((x) => x.code);

/** The category an item's name suggests: how the 1.13 cupboard's free-text items are classified. */
function categoryFromName(name) {
  const n = String(name || '').toLowerCase();
  if (/naloxone|narcan|kloxxado|zimhi/.test(n)) return 'naloxone';
  if (/xylazine/.test(n)) return 'xylazine_test_strips';
  if (/fentanyl|\bfts\b/.test(n)) return 'fentanyl_test_strips';
  if (/sharps|disposal container|biohazard/.test(n)) return 'sharps_container';
  if (/syringe|needle|\bcc\b|gauge/.test(n)) return 'syringes';
  if (/cooker/.test(n)) return 'cookers';
  if (/cotton/.test(n)) return 'cottons';
  if (/alcohol (pad|swab|prep)/.test(n)) return 'alcohol_pads';
  if (/pipe|smok|foil|straw/.test(n)) return 'safer_smoking';
  if (/wound|bandage|first aid/.test(n)) return 'wound_care';
  if (/condom/.test(n)) return 'condoms';
  if (/hygiene/.test(n)) return 'hygiene_kit';
  return 'other';
}
/** The unit an item of this category is counted in, unless its name says otherwise. */
function unitFor(category, name = '') {
  if (/\bkit\b/i.test(name)) return 'kit';
  return (CATEGORIES.find((c) => c.code === category) || { unit: 'each' }).unit;
}
const labelOf = (list, code) => (list.find((x) => x.code === code) || { label: code || '' }).label;

module.exports = { CATEGORIES, NALOXONE_PRODUCTS, SOURCES, ADJUST_REASONS, DISPOSAL_REASONS, SITE_KINDS, KIND_LABELS, COUNTED, codes, categoryFromName, unitFor, labelOf };
