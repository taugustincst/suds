'use strict';
// The programme profile: what kind of programme this SUDS serves, and which of the clinical modules it uses.
//
// SUDS is built first for harm-reduction, outreach and prevention programmes: outreach and visits, supplies,
// calls, referrals and the grant report. The clinical modules — care plan and problem list, assessments
// (ASAM and scored screenings), CalOMS Tx, the FHIR API and the county EHR hand-off — are for
// treatment-adjacent programmes. The profile decides which of them a programme sees; each module can then be
// switched on (or off) on its own in Settings › Programme.
//
// This is presentation first. Permissions (server/auth.js) do not change with the profile: a role that may
// read care plans still may. What a switched-off module does refuse is new work in it — its write routes
// answer 403 with a message saying where to switch it on (requireModule below) — and the FHIR API, which is
// an outside system's way in, is closed while its module is off. Reads of records already made stay open,
// so nothing recorded before a module was switched off becomes unreachable.
// Records a device pushes through sync are accepted even while their module is off: the device may have
// recorded them offline while it was on, and refusing the push would lose that work without a trace.
//
// Settings: programme_profile ('harm_reduction' | 'treatment') and module_<key> ('1' on, '0' off; absent
// means the module's default). All are synchronised to device copies (server/sync-tables.js).
//
// Two modules are not clinical and do not follow the profile (1.14.0):
//  * suprt — SAMHSA's SUPRT-A client-level performance records for a State Opioid Response (SOR) grant
//    (server/suprt.js). On by default only for a programme that has a funding source of type "SOR grant";
//    a programme without SOR money never sees it.
//  * publication — publication releases of the funder report, the NDP log and the settlement report
//    (server/publication-release.js, docs/architecture/ADR-0009-publication-release.md). On by default, as
//    it always was; an administrator may switch releases off while the disclosure-control audit awaits an
//    outside statistical review. While it is off a publication run and its files are refused, with a message
//    (FR.countingMode); submission runs are unaffected.
const db = require('./db');
const { HttpError } = require('./http');

const PROFILES = {
  harm_reduction: { label: 'Harm reduction & outreach', help: 'Outreach, visits, supplies, calls, referrals and grant reporting. The clinical modules are hidden until you switch one on.' },
  treatment: { label: 'Treatment-adjacent', help: 'Everything above plus the clinical modules: care plan and problem list, assessments, CalOMS Tx, the FHIR API and the county EHR hand-off.' },
};
const DEFAULT_PROFILE = 'harm_reduction';
const MODULES = [
  { key: 'careplan', label: 'Care plan & problem list', help: 'The CalAIM problem list and care coordination plan on each client record.' },
  { key: 'assessments', label: 'Assessments', help: 'ASAM six-dimension assessments and scored screenings (PHQ-9, GAD-7, AUDIT-C, DAST-10), with the outcome measures report.' },
  { key: 'caloms', label: 'CalOMS Tx state reporting', help: 'Admission, discharge and annual update records for DHCS, their validation report and the extract.' },
  { key: 'fhir', label: 'FHIR API', help: 'Read access for outside systems (a county EHR or data warehouse) through registered FHIR clients.' },
  { key: 'handoff', label: 'County EHR hand-off', help: 'The encounter file a biller keys or imports into the county EHR. Not a claim.' },
  { key: 'suprt', label: 'SUPRT-A (SOR client-level reporting)', clinical: false, defaultWhy: 'on when the program has a SOR grant funding source',
    help: 'SAMHSA SUPRT-A records at baseline, reassessment, annual and closeout for clients served with State Opioid Response (SOR) money, the follow-ups due, and a file for entry into SPARS. Not SAMHSA-certified: check it against the current SUPRT handbook and codebook.' },
  { key: 'publication', label: 'Publication releases', clinical: false, defaultWhy: 'on',
    help: 'Publication releases of the funder report, the NDP log and the settlement report: the whole program for one ended period, small cells screened, to publish or share. Switched off, only submission runs (to your funder) can be made.' },
];
// The clinical modules: the ones the profile switches on and off together.
const CLINICAL_KEYS = MODULES.filter(m => m.clinical !== false).map(m => m.key);
const MODULE_KEYS = MODULES.map(m => m.key);
const SETTING_KEYS = ['programme_profile', ...MODULE_KEYS.map(k => `module_${k}`)];

function profile() {
  const v = db.getSetting('programme_profile', null);
  return PROFILES[v] ? v : DEFAULT_PROFILE;
}
/** A module's state when nobody has switched it: the profile's for a clinical module; see above for the rest. */
function moduleDefault(key) {
  if (key === 'publication') return true;
  if (key === 'suprt') { try { return !!db.one(`SELECT 1 FROM funding_sources WHERE source_type='sor_grant' LIMIT 1`); } catch { return false; } }
  return profile() === 'treatment';
}
function moduleOn(key) {
  const v = db.getSetting(`module_${key}`, null);
  if (v === '1') return true;
  if (v === '0') return false;
  return moduleDefault(key);
}
function modules() { return Object.fromEntries(MODULE_KEYS.map(k => [k, moduleOn(k)])); }
/** What the frontend needs: the profile, the module switches in force, and the labels for Settings. */
function describe() {
  return {
    profile: profile(), modules: modules(),
    overrides: Object.fromEntries(MODULE_KEYS.map(k => [k, db.getSetting(`module_${k}`, null)])),
    profiles: Object.entries(PROFILES).map(([value, p]) => ({ value, label: p.label, help: p.help })),
    module_list: MODULES.map(m => ({ ...m, clinical: m.clinical !== false, default_on: moduleDefault(m.key) })),
  };
}
function moduleLabel(key) { return (MODULES.find(m => m.key === key) || { label: key }).label; }
function offMessage(key) { return `${moduleLabel(key)} is switched off for this program. An administrator can switch it on in Settings › Program › Modules.`; }
/** Route guard for a module's write routes: 403, with the module named, while it is switched off. */
function requireModule(key) {
  return () => { if (!moduleOn(key)) throw new HttpError(403, offMessage(key), { module: key, module_off: true }); };
}

/**
 * The profile for a database that has none yet, decided once when it is opened (server/db.js initialise).
 * A new database is a harm-reduction programme. An existing one upgraded from before profiles existed keeps
 * everything it had: it is treatment-adjacent as soon as it holds any clinical record or has CalOMS or FHIR
 * set up, so nothing disappears on upgrade; otherwise it is harm reduction, which it already was in practice.
 * `d` is the raw node:sqlite handle (db.js calls this before its own helpers are ready).
 */
function defaultForExisting(d) {
  const has = (sql) => { try { return !!d.prepare(sql).get(); } catch { return false; } };
  const clinical = has(`SELECT 1 FROM problems LIMIT 1`) || has(`SELECT 1 FROM care_plan_goals LIMIT 1`) || has(`SELECT 1 FROM asam_assessments LIMIT 1`)
    || has(`SELECT 1 FROM outcome_measures LIMIT 1`) || has(`SELECT 1 FROM caloms_records LIMIT 1`) || has(`SELECT 1 FROM caloms_submissions LIMIT 1`)
    || has(`SELECT 1 FROM api_keys WHERE scopes LIKE 'fhir%' LIMIT 1`) || has(`SELECT 1 FROM disclosures WHERE source='ehr_handoff' LIMIT 1`)
    || has(`SELECT 1 FROM settings WHERE key='caloms_enabled' AND value='1'`);
  return clinical ? 'treatment' : 'harm_reduction';
}

/**
 * The Location a new visit (and the "Where" of a new overdose event) starts on: the street for a
 * harm-reduction program, whose work mostly happens there, the office for a treatment-adjacent one. A choice
 * the program has hidden under Settings › Lists is not offered, so then the first one it does offer.
 * `visible` is the list's codes in the program's order.
 */
function defaultLocation(visible = []) {
  const want = profile() === 'harm_reduction' ? 'street' : 'office';
  if (!visible.length || visible.includes(want)) return want;
  return visible.includes('office') ? 'office' : visible[0];
}

module.exports = { PROFILES, DEFAULT_PROFILE, MODULES, MODULE_KEYS, CLINICAL_KEYS, SETTING_KEYS, profile, moduleOn, moduleDefault, modules, describe, requireModule, offMessage, defaultForExisting, defaultLocation };
