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
//
// Settings: programme_profile ('harm_reduction' | 'treatment') and module_<key> ('1' on, '0' off; absent
// means the profile's default). All are synchronised to device copies (server/sync-tables.js).
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
];
const MODULE_KEYS = MODULES.map(m => m.key);
const SETTING_KEYS = ['programme_profile', ...MODULE_KEYS.map(k => `module_${k}`)];

function profile() {
  const v = db.getSetting('programme_profile', null);
  return PROFILES[v] ? v : DEFAULT_PROFILE;
}
function moduleOn(key) {
  const v = db.getSetting(`module_${key}`, null);
  if (v === '1') return true;
  if (v === '0') return false;
  return profile() === 'treatment';
}
function modules() { return Object.fromEntries(MODULE_KEYS.map(k => [k, moduleOn(k)])); }
/** What the frontend needs: the profile, the module switches in force, and the labels for Settings. */
function describe() {
  return {
    profile: profile(), modules: modules(),
    overrides: Object.fromEntries(MODULE_KEYS.map(k => [k, db.getSetting(`module_${k}`, null)])),
    profiles: Object.entries(PROFILES).map(([value, p]) => ({ value, label: p.label, help: p.help })),
    module_list: MODULES,
  };
}
function moduleLabel(key) { return (MODULES.find(m => m.key === key) || { label: key }).label; }
function offMessage(key) { return `${moduleLabel(key)} is switched off for this programme. An administrator can switch it on in Settings › Programme › Modules.`; }
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

module.exports = { PROFILES, DEFAULT_PROFILE, MODULES, MODULE_KEYS, SETTING_KEYS, profile, moduleOn, modules, describe, requireModule, offMessage, defaultForExisting };
