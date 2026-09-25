'use strict';
// US Core structural conformance for the four resource types SUDS labels with a US Core profile in
// meta.profile (Patient, Encounter, Organization, Location; server/fhir/resources.js). These are SUDS's own
// checks of the required elements, cardinalities and fixed structures of US Core 3.1.1 and 5.0.1 for the
// elements SUDS populates. They are not a substitute for the HL7 FHIR validator or Inferno, which also check
// terminology bindings and every invariant (docs/integration/FHIR.md, "Profiles and conformance").
//
// Set FHIR_SAMPLE_DIR to a directory to have this test write the resources it checked there, one JSON file
// each, for running the HL7 validator over them:
//   FHIR_SAMPLE_DIR=/tmp/suds-fhir node --test test/fhir-uscore.test.js
//   java -jar validator_cli.jar -version 4.0.1 -ig hl7.fhir.us.core#5.0.1 /tmp/suds-fhir/*.json
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');
const { encrypt } = require('../server/crypto');

const US_CORE = 'http://hl7.org/fhir/us/core/StructureDefinition/';
let base, admin, token, adminId;
const ids = {};
const samples = [];

async function get(p) {
  const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' } });
  assert.equal(r.status, 200, `${p}: ${r.status}`);
  return r.json();
}
const resources = (bundle, type) => (bundle.entry || []).map(e => e.resource).filter(r => r.resourceType === type);
function keep(r) { samples.push(r); return r; }

before(async () => {
  base = await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  H.db.setSetting('org_name', 'Sample County SUD Navigation');
  H.db.setSetting('program_contact', '916-555-0100');
  ids.resource = (await admin.post('/api/resources', { name: 'Riverbend OTP', category: 'mat_otp', organization: 'Riverbend Health', phone: '916-555-0199', address: '12 River Rd', city: 'Sacramento', zip: '95814', service_tags: 'mat_methadone', accepts_medicaid: true })).data.id;
  const mk = async (first, last, extra) => (await admin.post('/api/clients', { first_name: first, last_name: last, dob: '1985-06-15', city: 'Sacramento', zip: '95814', status: 'active', gender: 'female', phone: '916-555-0101', confirm_duplicate: true, ...extra })).data.id;
  ids.full = await mk('Ada', 'Sample', { race_codes: 'white,black_african_american,hispanic_latino', medicaid_id: 'MCD9', preferred_name: 'Addie', address: '1 Main St', email: 'ada@example.org', preferred_language: 'Spanish' });
  ids.declined = await mk('Bea', 'Declined', { race_codes: 'declined', gender: 'non_binary' });
  ids.sparse = await mk('Cy', 'Sparse', { race_codes: '', gender: '' });
  for (const cid of [ids.full, ids.declined, ids.sparse]) {
    H.db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,signed_on_paper,redisclosure_notice_given,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(), cid, 'part2_disclosure', encrypt('County Behavioral Health'), encrypt('Treatment'), encrypt('Navigation record'), '2026-01-10', '2030-01-01', 1, 1, adminId);
  }
  H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome) VALUES(?,?,?,?,?,?,?,?,?)`, randomUUID(), ids.full, adminId, 'care_coordination', '2026-03-05T17:00:00.000Z', 30, 'field', 'in_person', 'completed');
  H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,outcome) VALUES(?,?,?,?,?,?)`, randomUUID(), ids.declined, adminId, 'outreach', '2026-03-06T17:00:00.000Z', 'no_show');
  H.db.run(`INSERT INTO calls(id,client_id,user_id,direction,method,started_at,duration_minutes,outcome,crisis) VALUES(?,?,?,?,?,?,?,?,?)`, randomUUID(), ids.full, adminId, 'outbound', 'phone', '2026-04-01T16:00:00.000Z', 10, 'reached', 1);
  const c = await admin.post('/api/admin/fhir-clients', { name: 'Conformance', recipient: 'County Behavioral Health', scopes: ['system/*.read'] });
  const t = await fetch(base + '/fhir/R4/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=${c.data.id}&client_secret=${encodeURIComponent(c.data.key)}` });
  token = (await t.json()).access_token;
});
after(async () => {
  const out = process.env.FHIR_SAMPLE_DIR;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    for (const r of samples) fs.writeFileSync(path.join(out, `${r.resourceType}-${r.id}.json`), JSON.stringify(r, null, 2));
  }
  await H.stop();
});

// ---- small structural helpers ----
const isStr = (v) => typeof v === 'string' && v.trim() === v && v.length > 0;
function coding(c, where) {
  assert.ok(c && typeof c === 'object', `${where}: a Coding`);
  assert.ok(isStr(c.system) && /^(https?:|urn:)/.test(c.system), `${where}.system is a URI`);
  assert.ok(isStr(c.code) && !/\s{2,}|^\s|\s$/.test(c.code), `${where}.code is a FHIR code`);
}
function codeableConcept(cc, where) {
  assert.ok(cc && typeof cc === 'object' && (cc.coding?.length || isStr(cc.text)), `${where}: coding or text`);
  (cc.coding || []).forEach((c, i) => coding(c, `${where}.coding[${i}]`));
}
function reference(r, type, where) {
  assert.ok(r && isStr(r.reference), `${where}.reference`);
  assert.match(r.reference, new RegExp(`^${type}/[A-Za-z0-9\\-.]{1,64}$`), `${where} points at a ${type}`);
}
function profiled(r, profile) {
  assert.deepEqual(r.meta.profile, [US_CORE + profile], `${r.resourceType}/${r.id} declares ${profile}`);
}
/** Every primitive in FHIR JSON must be non-empty (no "", no null, no empty object or array). */
function noEmpty(o, where = '') {
  if (Array.isArray(o)) { assert.ok(o.length, `${where} is an empty array`); o.forEach((v, i) => noEmpty(v, `${where}[${i}]`)); return; }
  if (o && typeof o === 'object') { assert.ok(Object.keys(o).length, `${where} is an empty object`); for (const [k, v] of Object.entries(o)) noEmpty(v, `${where}.${k}`); return; }
  assert.ok(o !== null && o !== '', `${where} is empty`);
}
const OMB = 'urn:oid:2.16.840.1.113883.6.238';
function ombExtension(ext, url, allowedCodes) {
  assert.equal(ext.url, url);
  assert.ok(!('value' in ext) && !Object.keys(ext).some(k => k.startsWith('value')), `${url} is a complex extension (no value[x])`);
  const parts = ext.extension;
  assert.ok(Array.isArray(parts) && parts.length, `${url} has sub-extensions`);
  const text = parts.filter(p => p.url === 'text');
  assert.equal(text.length, 1, `${url}: text is 1..1`);
  assert.ok(isStr(text[0].valueString), `${url}: text is a string`);
  const omb = parts.filter(p => p.url === 'ombCategory');
  assert.ok(omb.length <= (url.endsWith('ethnicity') ? 1 : 6), `${url}: ombCategory cardinality`);
  for (const p of omb) { coding(p.valueCoding, `${url}.ombCategory`); assert.ok(allowedCodes.includes(`${p.valueCoding.system}|${p.valueCoding.code}`), `${url}: ${p.valueCoding.code} is in the OMB value set`); }
  for (const p of parts) assert.ok(['ombCategory', 'detailed', 'text'].includes(p.url), `${url}: unknown sub-extension ${p.url}`);
}
// The OMB categories only: US Core 3.1.1 to 5.0.1 bind ombCategory (required) to these, with no null flavors.
const RACE_CODES = ['1002-5', '2028-9', '2054-5', '2076-8', '2106-3'].map(c => `${OMB}|${c}`);
const ETH_CODES = ['2135-2', '2186-5'].map(c => `${OMB}|${c}`);

test('US Core Patient: identifier, name, gender and the race/ethnicity extensions have the required structure', async () => {
  const b = await get('/fhir/R4/Patient?_count=50');
  const pts = resources(b, 'Patient');
  assert.equal(pts.length, 3);
  for (const p of pts.map(keep)) {
    const w = `Patient/${p.id}`;
    noEmpty(p, w);
    profiled(p, 'us-core-patient');
    // identifier 1..*, each with system and value (US Core must support, 1..1 within an identifier).
    assert.ok(p.identifier?.length >= 1, `${w}: identifier 1..*`);
    for (const id of p.identifier) { assert.ok(isStr(id.system) && isStr(id.value), `${w}: identifier.system and .value`); if (id.type) codeableConcept(id.type, `${w}.identifier.type`); }
    // name 1..*, and us-core-6 (3.1.1: us-core-8): family or given (or a data-absent-reason) in each.
    assert.ok(p.name?.length >= 1, `${w}: name 1..*`);
    for (const n of p.name) assert.ok(isStr(n.family) || n.given?.every(isStr), `${w}: each name has family or given`);
    // gender 1..1 from administrative-gender (required binding).
    assert.ok(['male', 'female', 'other', 'unknown'].includes(p.gender), `${w}: gender`);
    if (p.birthDate) assert.match(p.birthDate, /^\d{4}(-\d{2}(-\d{2})?)?$/);
    for (const t of p.telecom || []) { assert.ok(['phone', 'fax', 'email', 'pager', 'url', 'sms', 'other'].includes(t.system) && isStr(t.value), `${w}: telecom system and value`); if (t.use) assert.ok(['home', 'work', 'temp', 'old', 'mobile'].includes(t.use)); }
    for (const a of p.address || []) { for (const l of a.line || []) assert.ok(isStr(l)); if (a.postalCode) assert.ok(isStr(a.postalCode)); }
    for (const c of p.communication || []) { codeableConcept(c.language, `${w}.communication.language`); for (const x of c.language.coding || []) { assert.equal(x.system, 'urn:ietf:bcp:47'); assert.match(x.code, /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/); } }
    for (const s of p.meta.security) assert.notEqual(s.code, 'NORDSLCD', 'a retired security label code is not used');
    for (const e of p.extension || []) {
      if (e.url === US_CORE + 'us-core-race') ombExtension(e, US_CORE + 'us-core-race', RACE_CODES);
      else if (e.url === US_CORE + 'us-core-ethnicity') ombExtension(e, US_CORE + 'us-core-ethnicity', ETH_CODES);
      else assert.fail(`${w}: unexpected extension ${e.url}`);
    }
    if (p.managingOrganization) reference(p.managingOrganization, 'Organization', `${w}.managingOrganization`);
  }
  const full = pts.find(p => p.id === ids.full);
  assert.ok(full.extension.some(e => e.url.endsWith('us-core-race')) && full.extension.some(e => e.url.endsWith('us-core-ethnicity')));
  const declined = pts.find(p => p.id === ids.declined).extension.find(e => e.url.endsWith('us-core-race'));
  assert.deepEqual(declined.extension, [{ url: 'text', valueString: 'Asked but no answer' }], 'declined race is said in text, not as an ombCategory (not in the OMB value set before US Core 6)');
  assert.deepEqual(full.communication[0].language.coding, [{ system: 'urn:ietf:bcp:47', code: 'es' }], 'a common language is coded (BCP-47)');
});

test('US Core Encounter: status, class, type, subject are present and well formed', async () => {
  const b = await get('/fhir/R4/Encounter?_count=50');
  const encs = resources(b, 'Encounter');
  assert.equal(encs.length, 3);
  for (const e of encs.map(keep)) {
    const w = `Encounter/${e.id}`;
    noEmpty(e, w);
    profiled(e, 'us-core-encounter');
    assert.ok(['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown'].includes(e.status), `${w}: status 1..1`);
    coding(e.class, `${w}.class`); // class 1..1 (a Coding in R4)
    assert.equal(e.class.system, 'http://terminology.hl7.org/CodeSystem/v3-ActCode');
    assert.ok(['AMB', 'VR', 'HH', 'FLD', 'EMER', 'IMP'].includes(e.class.code));
    assert.ok(e.type?.length >= 1, `${w}: type 1..*`); e.type.forEach((t, i) => codeableConcept(t, `${w}.type[${i}]`));
    reference(e.subject, 'Patient', `${w}.subject`); // subject 1..1
    for (const id of e.identifier || []) assert.ok(isStr(id.system) && isStr(id.value));
    if (e.period) { if (e.period.start) assert.ok(!Number.isNaN(Date.parse(e.period.start))); if (e.period.end) assert.ok(Date.parse(e.period.end) >= Date.parse(e.period.start)); }
    if (e.priority) codeableConcept(e.priority, `${w}.priority`);
    if (e.serviceProvider) reference(e.serviceProvider, 'Organization', `${w}.serviceProvider`);
    if (e.length) { assert.equal(e.length.system, 'http://unitsofmeasure.org'); assert.equal(e.length.code, 'min'); }
  }
});

test('US Core Organization and Location: name, active/status, telecom and address', async () => {
  const orgs = resources(await get('/fhir/R4/Organization?_count=50'), 'Organization');
  assert.ok(orgs.length >= 2, 'the programme and the directory entry');
  for (const o of orgs.map(keep)) {
    const w = `Organization/${o.id}`;
    noEmpty(o, w);
    profiled(o, 'us-core-organization');
    assert.equal(typeof o.active, 'boolean', `${w}: active 1..1`);
    assert.ok(isStr(o.name), `${w}: name 1..1`);
    for (const t of o.telecom || []) { assert.ok(isStr(t.system) && isStr(t.value)); assert.notEqual(t.use, 'home', `${w}: org-3, an organization's telecom is never home`); }
    for (const a of o.address || []) { assert.notEqual(a.use, 'home', `${w}: org-2, an organization's address is never home`); for (const l of a.line || []) assert.ok(isStr(l)); }
    (o.type || []).forEach((t, i) => codeableConcept(t, `${w}.type[${i}]`));
  }
  const locs = resources(await get('/fhir/R4/Location?_count=50'), 'Location');
  assert.ok(locs.length >= 1);
  for (const l of locs.map(keep)) {
    const w = `Location/${l.id}`;
    noEmpty(l, w);
    profiled(l, 'us-core-location');
    assert.ok(isStr(l.name), `${w}: name 1..1`);
    if (l.status) assert.ok(['active', 'suspended', 'inactive'].includes(l.status));
    for (const t of l.telecom || []) assert.ok(isStr(t.system) && isStr(t.value));
    if (l.address) for (const x of l.address.line || []) assert.ok(isStr(x));
    if (l.managingOrganization) reference(l.managingOrganization, 'Organization', `${w}.managingOrganization`);
  }
});

test('types without a US Core profile declare none', async () => {
  for (const type of ['EpisodeOfCare', 'Consent', 'Observation']) {
    const b = await get(`/fhir/R4/${type}?_count=5`);
    for (const r of resources(b, type)) { keep(r); assert.equal(r.meta.profile, undefined, `${type} is base R4`); }
  }
  const cs = await (await fetch(base + '/fhir/R4/metadata')).json();
  const profiled = cs.rest[0].resource.filter(r => r.supportedProfile).map(r => r.type).sort();
  assert.deepEqual(profiled, ['Encounter', 'Location', 'Organization', 'Patient'], 'the CapabilityStatement names the same four');
});
