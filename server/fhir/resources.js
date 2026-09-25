'use strict';
// SUDS records as FHIR R4 resources, and the search engine over them. Read-only.
//
// Each resource type is described by a `src` query that yields one row per FHIR resource with a fixed set of
// columns the search parameters work on (_fid: the FHIR id, _kind/_rid: which SUDS row it came from, _cid:
// the client it is about, _upd: last updated, _date: the date the `date` parameter searches, plus extras
// a type's own parameters use), a `load` that fetches that SUDS row, and a `map` that turns it into the
// resource. Whether a row may be returned at all (the client's consent) is decided by the caller, not here.
const db = require('../db');
const options = require('../options');
const disclosure = require('../disclosure');
const { decrypt, blindIndex } = require('../crypto');
const { SYS, PART2_SECURITY, FhirError, dateClause, refId } = require('./common');

const US_CORE = 'http://hl7.org/fhir/us/core/StructureDefinition/';
const PROGRAM_ORG = 'suds-program';
const programRef = () => ({ reference: `Organization/${PROGRAM_ORG}`, display: db.getSetting('org_name', 'SUDS program') || 'SUDS program' });
const patientRef = (id) => ({ reference: `Patient/${id}` });
const dec = (v) => { if (!v) return null; try { return decrypt(v); } catch { return null; } };
const dt = (v) => { if (!v) return undefined; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v; const t = Date.parse(v); return Number.isNaN(t) ? undefined : new Date(t).toISOString(); };
const instant = (v) => { const t = Date.parse(v || ''); return Number.isNaN(t) ? undefined : new Date(t).toISOString(); };
const label = (list, code) => code ? options.labelOf(list, code) : undefined;
const humanize = options.humanize;
function meta(updated, { profile, part2 = true } = {}) {
  const m = { lastUpdated: instant(updated) };
  if (profile) m.profile = [US_CORE + profile];
  if (part2) m.security = PART2_SECURITY;
  return m;
}
/** Drop undefined, null, empty strings and empty arrays so resources carry only what SUDS actually has. */
function prune(o) {
  if (Array.isArray(o)) return o.map(prune).filter(v => v !== undefined);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) { const p = prune(v); if (p === undefined || p === null || p === '' || (Array.isArray(p) && !p.length) || (typeof p === 'object' && !Array.isArray(p) && !Object.keys(p).length)) continue; out[k] = p; }
    return out;
  }
  return o;
}
const cc = (system, code, display, text) => code ? { coding: [{ system, code, display }], text: text || display } : undefined;
const telecom = (system, value, use) => value ? { system, value: String(value), use } : undefined;
const address = (line, city, zip) => (line || city || zip) ? { use: 'home', line: line ? [String(line)] : undefined, city: city || undefined, postalCode: zip || undefined, text: [line, city, zip].filter(Boolean).join(', ') } : undefined;

// ---- Patient ----
const OMB = 'urn:oid:2.16.840.1.113883.6.238';
const RACE = { american_indian_alaska_native: ['1002-5', 'American Indian or Alaska Native'], asian: ['2028-9', 'Asian'], black_african_american: ['2054-5', 'Black or African American'], native_hawaiian_pacific_islander: ['2076-8', 'Native Hawaiian or Other Pacific Islander'], white: ['2106-3', 'White'] };
const ETHNICITY = { hispanic_latino: ['2135-2', 'Hispanic or Latino'], not_hispanic_latino: ['2186-5', 'Not Hispanic or Latino'] };
const NULL_FLAVOR = 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor';
function raceEthnicity(codesText) {
  const codes = String(codesText || '').split(',').map(s => s.trim()).filter(Boolean);
  const ext = [];
  const race = codes.filter(c => RACE[c]); const eth = codes.filter(c => ETHNICITY[c]);
  const raceNull = !race.length && (codes.includes('declined') ? ['ASKU', 'Asked but no answer'] : codes.includes('unknown') ? ['UNK', 'Unknown'] : null);
  if (race.length || raceNull || codes.includes('other')) {
    const parts = race.map(c => ({ url: 'ombCategory', valueCoding: { system: OMB, code: RACE[c][0], display: RACE[c][1] } }));
    if (raceNull) parts.push({ url: 'ombCategory', valueCoding: { system: NULL_FLAVOR, code: raceNull[0], display: raceNull[1] } });
    parts.push({ url: 'text', valueString: [...race.map(c => RACE[c][1]), ...(codes.includes('other') ? ['Other'] : []), ...(raceNull ? [raceNull[1]] : [])].join(', ') });
    ext.push({ url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race', extension: parts });
  }
  if (eth.length) {
    ext.push({ url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity', extension: [
      ...eth.map(c => ({ url: 'ombCategory', valueCoding: { system: OMB, code: ETHNICITY[c][0], display: ETHNICITY[c][1] } })),
      { url: 'text', valueString: eth.map(c => ETHNICITY[c][1]).join(', ') }] });
  }
  return ext;
}
const GENDER = { female: 'female', male: 'male', transgender_female: 'female', transgender_male: 'male', non_binary: 'other', other: 'other' };
function mapPatient(c) {
  const first = dec(c.first_name_enc), last = dec(c.last_name_enc), preferred = dec(c.preferred_name_enc), dob = dec(c.dob_enc), medicaid = dec(c.medicaid_id_enc);
  return prune({
    resourceType: 'Patient', id: c.id, meta: meta(c.updated_at, { profile: 'us-core-patient' }),
    extension: raceEthnicity(c.race_codes),
    identifier: [
      { use: 'usual', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }], text: 'SUDS client code' }, system: SYS.clientCode, value: c.client_code },
      medicaid ? { use: 'secondary', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MA', display: 'Patient Medicaid number' }] }, system: SYS.medicaid, value: medicaid } : undefined,
    ],
    active: !['closed', 'inactive', 'deceased'].includes(c.status),
    name: [{ use: 'official', family: last || undefined, given: first ? [first] : undefined }, preferred ? { use: 'usual', given: [preferred] } : undefined],
    telecom: [telecom('phone', dec(c.phone_enc), 'mobile'), telecom('phone', dec(c.alt_phone_enc), 'home'), telecom('email', dec(c.email_enc), 'home')],
    gender: GENDER[c.gender] || 'unknown',
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(dob || '') ? dob : undefined,
    deceasedBoolean: c.status === 'deceased' ? true : undefined,
    address: [address(dec(c.address_enc), c.city, c.zip)],
    communication: c.preferred_language ? [{ language: { text: c.preferred_language }, preferred: true }] : undefined,
    managingOrganization: programRef(),
  });
}

// ---- EpisodeOfCare ----
function mapEpisode(e) {
  return prune({
    resourceType: 'EpisodeOfCare', id: e.id, meta: meta(e.updated_at),
    status: e.status === 'closed' ? 'finished' : 'active',
    type: [cc(SYS.episode, 'sud-navigation', 'SUD navigation services')],
    patient: patientRef(e.client_id), managingOrganization: programRef(),
    period: { start: dt(e.opened_at), end: dt(e.closed_at) },
  });
}

// ---- Encounter (visits and calls) ----
const V3 = SYS.actCode;
const VIRTUAL_MODALITIES = ['phone', 'video', 'text', 'email'];
const FIELD_LOCATIONS = ['field', 'community', 'shelter', 'jail', 'court', 'hospital', 'emergency_dept', 'treatment_facility'];
function encounterClass(modality, location) {
  if (VIRTUAL_MODALITIES.includes(modality) || location === 'telehealth' || location === 'phone') return { system: V3, code: 'VR', display: 'virtual' };
  if (location === 'home') return { system: V3, code: 'HH', display: 'home health' };
  if (FIELD_LOCATIONS.includes(location)) return { system: V3, code: 'FLD', display: 'field' };
  return { system: V3, code: 'AMB', display: 'ambulatory' };
}
const NOT_HELD = ['client_declined', 'no_show', 'unable_to_locate', 'rescheduled'];
function end(start, minutes) { const t = Date.parse(start || ''); return Number.isNaN(t) || !minutes ? undefined : new Date(t + minutes * 60000).toISOString(); }
function mapIntervention(i) {
  const typeLabel = label('INTERVENTION_TYPES', i.type);
  return prune({
    resourceType: 'Encounter', id: `iv-${i.id}`, meta: meta(i.updated_at, { profile: 'us-core-encounter' }),
    identifier: [{ system: 'urn:suds:intervention', value: i.id }],
    status: NOT_HELD.includes(i.outcome) ? 'cancelled' : 'finished',
    class: encounterClass(i.modality, i.location),
    type: [cc(SYS.interventionType, i.type, typeLabel)],
    serviceType: i.location ? { text: `Location: ${label('LOCATIONS', i.location)}` } : undefined,
    subject: patientRef(i.client_id),
    period: { start: dt(i.occurred_at), end: end(i.occurred_at, i.duration_minutes) },
    length: i.duration_minutes ? { value: i.duration_minutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } : undefined,
    serviceProvider: programRef(),
  });
}
const CALL_HELD = ['reached', 'callback_scheduled', 'crisis_escalated', 'replied', 'sent'];
function mapCall(c) {
  const text = c.method === 'text';
  return prune({
    resourceType: 'Encounter', id: `call-${c.id}`, meta: meta(c.updated_at, { profile: 'us-core-encounter' }),
    identifier: [{ system: 'urn:suds:call', value: c.id }],
    status: CALL_HELD.includes(c.outcome) ? 'finished' : 'cancelled',
    class: { system: V3, code: 'VR', display: 'virtual' },
    type: [cc(SYS.callPurpose, text ? 'text-message' : 'phone-call', text ? 'Text message' : 'Phone call')],
    serviceType: c.contact_type ? { text: `Contact: ${humanize(c.contact_type)} (${c.direction})` } : undefined,
    priority: c.crisis ? cc('http://terminology.hl7.org/CodeSystem/v3-ActPriority', 'EM', 'emergency') : undefined,
    subject: patientRef(c.client_id),
    period: { start: dt(c.started_at), end: end(c.started_at, c.duration_minutes) },
    length: c.duration_minutes ? { value: c.duration_minutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } : undefined,
    serviceProvider: programRef(),
  });
}

// ---- Consent ----
const today = () => new Date().toISOString().slice(0, 10);
function consentPurposes(type, purposeText) {
  return disclosure.consentPurposeCodes({ type, purpose: purposeText }).map(code => ({ system: SYS.actReason, code, display: disclosure.FHIR_PURPOSES[code].display }));
}
function mapConsent(k) {
  const recipient = dec(k.recipient_enc), purpose = dec(k.purpose_enc);
  const active = !k.revoked_at && (!k.expires_at || k.expires_at >= today());
  const part2 = k.type.startsWith('part2_');
  return prune({
    resourceType: 'Consent', id: k.id, meta: meta(k.updated_at),
    status: active ? 'active' : 'inactive',
    scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy', display: 'Privacy Consent' }] },
    category: [{ coding: [{ system: 'http://loinc.org', code: '59284-0', display: 'Patient Consent' }] }, cc(SYS.consentType, k.type, humanize(k.type))],
    patient: patientRef(k.client_id), dateTime: dt(k.signed_at), organization: [programRef()],
    policy: part2 ? [{ authority: 'https://www.ecfr.gov', uri: 'https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2' }] : undefined,
    policyRule: part2 ? cc(SYS.actCode, '42CFRPart2', '42 CFR Part2') : cc('http://terminology.hl7.org/CodeSystem/consentpolicycodes', 'hipaa-auth', 'HIPAA Authorization'),
    provision: {
      type: 'permit',
      period: { start: dt(k.signed_at), end: k.revoked_at ? dt(k.revoked_at) : dt(k.expires_at) },
      actor: recipient ? [{ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP', display: 'information recipient' }] }, reference: { display: recipient } }] : undefined,
      purpose: consentPurposes(k.type, purpose),
    },
  });
}

// ---- ServiceRequest (referrals) ----
const SR_STATUS = { pending: 'active', contacted: 'active', accepted: 'active', waitlisted: 'on-hold', scheduled: 'active', admitted: 'completed', completed: 'completed', declined_by_client: 'revoked', declined_by_provider: 'revoked', no_show: 'revoked', closed: 'completed' };
const SR_PRIORITY = { routine: 'routine', urgent: 'urgent', emergent: 'stat' };
function mapReferral(r) {
  const res = db.one(`SELECT name, category FROM resources WHERE id=?`, r.resource_id) || {};
  return prune({
    resourceType: 'ServiceRequest', id: r.id, meta: meta(r.updated_at),
    status: SR_STATUS[r.status] || 'unknown', intent: 'order',
    category: [{ coding: [{ system: 'http://snomed.info/sct', code: '3457005', display: 'Patient referral' }] }],
    priority: SR_PRIORITY[r.urgency] || undefined,
    code: { coding: res.category ? [{ system: SYS.resourceCategory, code: res.category, display: label('RESOURCE_CATEGORIES', res.category) }] : undefined, text: res.name ? `Referral to ${res.name}` : 'Referral' },
    subject: patientRef(r.client_id), authoredOn: dt(r.referred_at), occurrenceDateTime: dt(r.appointment_at),
    requester: programRef(),
    performer: [{ reference: `Organization/${r.resource_id}`, display: res.name }, { reference: `HealthcareService/${r.resource_id}`, display: res.name }],
  });
}

// ---- Task ----
const TASK_STATUS = { open: 'requested', in_progress: 'in-progress', done: 'completed', cancelled: 'cancelled' };
const TASK_PRIORITY = { low: 'routine', normal: 'routine', high: 'urgent', urgent: 'asap' };
function mapTask(t) {
  return prune({
    resourceType: 'Task', id: t.id, meta: meta(t.updated_at),
    status: TASK_STATUS[t.status] || 'requested', intent: 'order', priority: TASK_PRIORITY[t.priority],
    code: t.is_milestone ? { text: 'Milestone' } : undefined,
    description: dec(t.title_enc) || undefined,
    focus: t.referral_id ? { reference: `ServiceRequest/${t.referral_id}` } : undefined,
    for: patientRef(t.client_id), authoredOn: dt(t.created_at), lastModified: dt(t.updated_at),
    requester: programRef(),
    executionPeriod: t.completed_at ? { end: dt(t.completed_at) } : undefined,
    restriction: t.due_at ? { period: { end: dt(t.due_at) } } : undefined,
  });
}

// ---- Observation (risk level; overdose events) ----
function mapRisk(c) {
  return prune({
    resourceType: 'Observation', id: `risk-${c.id}`, meta: meta(c.updated_at),
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey', display: 'Survey' }] }],
    code: cc(SYS.observation, 'overdose-risk-level', 'Overdose risk level (navigator assessment)'),
    subject: patientRef(c.id), issued: instant(c.updated_at),
    valueCodeableConcept: cc(SYS.observation, c.risk_level, humanize(c.risk_level)),
  });
}
function mapOverdose(o) {
  const comp = (code, display, v) => ({ code: cc(SYS.observation, code, display), ...v });
  return prune({
    resourceType: 'Observation', id: `od-${o.id}`, meta: meta(o.updated_at),
    status: 'final',
    category: [cc(SYS.observation, 'overdose-event', 'Overdose event')],
    code: cc(SYS.observation, 'overdose-event', 'Overdose event'),
    subject: patientRef(o.client_id), effectiveDateTime: dt(o.occurred_at), issued: instant(o.created_at),
    valueCodeableConcept: cc(SYS.observation, o.kind, label('OVERDOSE_KINDS', o.kind)),
    component: [
      comp('naloxone-used', 'Naloxone used', { valueBoolean: !!o.naloxone_used }),
      o.naloxone_doses ? comp('naloxone-doses', 'Naloxone doses', { valueInteger: o.naloxone_doses }) : undefined,
      comp('ems-called', 'EMS called', { valueBoolean: !!o.ems_called }),
      comp('hospitalized', 'Hospitalized', { valueBoolean: !!o.hospitalized }),
      comp('survived', 'Survived', { valueBoolean: !!o.survived }),
    ],
  });
}

// ---- DocumentReference (signed notes: metadata only, never the text) ----
// SUD counseling notes (§2.11) are left out altogether, not even listed: they are disclosed only under a
// consent given for them alone, which never covers FHIR (server/disclosure.js).
const NOTE_LOINC = { discharge: ['18842-5', 'Discharge summary'] };
function mapNote(n) {
  const loinc = NOTE_LOINC[n.format] || ['11506-3', 'Progress note'];
  const encounter = n.intervention_id ? `Encounter/iv-${n.intervention_id}` : n.call_id ? `Encounter/call-${n.call_id}` : null;
  const encounterOk = encounter && (n.intervention_id ? db.one(`SELECT 1 FROM interventions WHERE id=? AND client_id=?`, n.intervention_id, n.client_id) : db.one(`SELECT 1 FROM calls WHERE id=? AND client_id=?`, n.call_id, n.client_id));
  return prune({
    resourceType: 'DocumentReference', id: n.id, meta: meta(n.updated_at),
    status: 'current', docStatus: n.status === 'amended' ? 'amended' : 'final',
    type: { coding: [{ system: 'http://loinc.org', code: loinc[0], display: loinc[1] }, { system: SYS.noteFormat, code: n.format, display: label('NOTE_FORMATS', n.format) }], text: label('NOTE_FORMATS', n.format) },
    category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }, cc(SYS.noteFormat, `kind-${n.kind}`, n.kind === 'clinical' ? 'Clinical note' : 'Case management note')],
    subject: patientRef(n.client_id), date: instant(n.signed_at || n.updated_at),
    securityLabel: PART2_SECURITY.map(s => ({ coding: [s] })),
    content: [{ attachment: { contentType: 'text/plain', title: 'Note text is not shared over FHIR (42 CFR Part 2). Request it from the program under a consent that covers it.' } }],
    context: { period: { start: dt(n.occurred_at) }, encounter: encounterOk ? [{ reference: encounter }] : undefined },
  });
}

// ---- Resource directory: Organization, Location, HealthcareService (not PHI) ----
function directoryTelecom(r) { return [telecom('phone', r.phone, 'work'), telecom('fax', r.fax, 'work'), telecom('email', r.email, 'work'), telecom('url', r.website, 'work')]; }
function mapOrganization(r) {
  if (r._program) {
    return prune({ resourceType: 'Organization', id: PROGRAM_ORG, meta: meta(r.updated_at, { profile: 'us-core-organization', part2: false }), active: true,
      type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'prov', display: 'Healthcare Provider' }] }],
      name: db.getSetting('org_name', 'SUDS program') || 'SUDS program',
      telecom: [telecom('phone', db.getSetting('program_contact', '') || undefined, 'work')] });
  }
  return prune({
    resourceType: 'Organization', id: r.id, meta: meta(r.updated_at, { profile: 'us-core-organization', part2: false }),
    active: !!r.is_active,
    type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'prov', display: 'Healthcare Provider' }] }],
    name: r.organization || r.name, alias: r.organization && r.organization !== r.name ? [r.name] : undefined,
    telecom: directoryTelecom(r), address: [address(r.address, r.city, r.zip) && { ...address(r.address, r.city, r.zip), use: 'work' }],
  });
}
function mapLocation(r) {
  return prune({
    resourceType: 'Location', id: r.id, meta: meta(r.updated_at, { profile: 'us-core-location', part2: false }),
    status: r.is_active ? 'active' : 'inactive', name: r.name,
    telecom: directoryTelecom(r), address: address(r.address, r.city, r.zip) && { ...address(r.address, r.city, r.zip), use: 'work' },
    managingOrganization: { reference: `Organization/${r.id}`, display: r.organization || r.name },
  });
}
const split = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
function mapHealthcareService(r) {
  return prune({
    resourceType: 'HealthcareService', id: r.id, meta: meta(r.updated_at, { part2: false }),
    active: !!r.is_active, providedBy: { reference: `Organization/${r.id}`, display: r.organization || r.name },
    category: [cc(SYS.resourceCategory, r.category, label('RESOURCE_CATEGORIES', r.category))],
    type: split(r.service_tags).map(t => cc(SYS.serviceTag, t, humanize(t))),
    location: [{ reference: `Location/${r.id}` }], name: r.name, comment: r.summary || undefined,
    extraDetails: [r.services, r.levels_of_care ? `Levels of care: ${r.levels_of_care}` : null, r.mat_offered ? `MAT offered: ${r.mat_offered}` : null, r.intake_process ? `Intake: ${r.intake_process}` : null, r.cost_notes ? `Cost: ${r.cost_notes}` : null].filter(Boolean).join('\n') || undefined,
    telecom: directoryTelecom(r),
    eligibility: r.eligibility || r.populations ? [{ code: r.populations ? { text: split(r.populations).map(humanize).join(', ') } : undefined, comment: r.eligibility || undefined }] : undefined,
    characteristic: [r.accepts_medicaid ? { text: 'Accepts Medicaid' } : undefined, r.accepts_uninsured ? { text: 'Accepts uninsured clients' } : undefined],
    communication: split(r.languages).map(l => ({ text: l })),
    availabilityExceptions: r.hours || undefined,
  });
}

// ---- search definitions ----
const LIVE_CLIENT = `c.deleted_at IS NULL AND c.merged_into IS NULL`;
const eqParam = (col, xform = v => v) => (values) => orClause(values, v => ({ sql: `${col} = ?`, params: [xform(v)] }));
function orClause(values, one) {
  const parts = []; const params = [];
  for (const raw of values) {
    const alts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    if (!alts.length) throw new FhirError(400, 'Empty search value', { code: 'invalid' });
    const sub = alts.map(one);
    parts.push(`(${sub.map(s => s.sql).join(' OR ')})`); for (const s of sub) params.push(...s.params);
  }
  return { sql: parts.join(' AND '), params };
}
const statusParam = (map) => (values) => orClause(values, v => {
  const raw = Object.entries(map).filter(([, f]) => f === v).map(([k]) => k);
  if (!raw.length) return { sql: '0', params: [] };
  return { sql: `_st IN (${raw.map(() => '?').join(',')})`, params: raw };
});
const nameParam = (values, mod) => orClause(values, v => mod === 'exact' ? { sql: `_name = ?`, params: [v] } : { sql: `LOWER(_name) LIKE ? ESCAPE '\\'`, params: [(mod === 'contains' ? '%' : '') + v.toLowerCase().replace(/[\\%_]/g, m => '\\' + m) + '%'] });

const DEFS = {
  Patient: {
    src: `SELECT c.id _fid, 'client' _kind, c.id _rid, c.id _cid, c.updated_at _upd, c.intake_date _date, c.status _st, c.client_code _code, c.dob_idx _dob, c.last_name_idx _fam, c.first_name_idx _giv FROM clients c WHERE ${LIVE_CLIENT}`,
    load: (kind, id) => db.one(`SELECT * FROM clients WHERE id=?`, id), map: mapPatient,
    params: {
      identifier: (values) => orClause(values, v => {
        const [sys, val] = v.includes('|') ? [v.slice(0, v.indexOf('|')), v.slice(v.indexOf('|') + 1)] : [null, v];
        if (sys && sys !== SYS.clientCode) return { sql: '0', params: [] }; // SUDS can only look up its own client code
        return { sql: `_code = ?`, params: [val] };
      }),
      family: (values) => orClause(values, v => ({ sql: `_fam = ?`, params: [blindIndex(v)] })),
      given: (values) => orClause(values, v => ({ sql: `_giv = ?`, params: [blindIndex(String(v).trim().toLowerCase())] })),
      birthdate: (values) => orClause(values, v => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new FhirError(400, 'birthdate is searchable by exact date (YYYY-MM-DD) only; dates of birth are stored encrypted', { code: 'invalid' }); return { sql: `_dob = ?`, params: [blindIndex(v)] }; }),
    },
    identifying: ['_id', 'identifier', 'family', 'given', 'birthdate'],
  },
  EpisodeOfCare: {
    src: `SELECT e.id _fid, 'episode' _kind, e.id _rid, e.client_id _cid, e.updated_at _upd, e.opened_at _date, e.status _st FROM episodes e JOIN clients c ON c.id=e.client_id WHERE ${LIVE_CLIENT}`,
    load: (kind, id) => db.one(`SELECT * FROM episodes WHERE id=?`, id), map: mapEpisode, date: true,
    params: { status: statusParam({ open: 'active', closed: 'finished' }) },
  },
  Encounter: {
    src: `SELECT 'iv-' || i.id _fid, 'intervention' _kind, i.id _rid, i.client_id _cid, i.updated_at _upd, i.occurred_at _date FROM interventions i JOIN clients c ON c.id=i.client_id WHERE ${LIVE_CLIENT}
      UNION ALL SELECT 'call-' || k.id, 'call', k.id, k.client_id, k.updated_at, k.started_at FROM calls k JOIN clients c ON c.id=k.client_id WHERE ${LIVE_CLIENT}`,
    load: (kind, id) => db.one(`SELECT * FROM ${kind === 'call' ? 'calls' : 'interventions'} WHERE id=?`, id), map: (row, kind) => kind === 'call' ? mapCall(row) : mapIntervention(row), date: true,
    params: {},
  },
  Consent: {
    src: `SELECT k.id _fid, 'consent' _kind, k.id _rid, k.client_id _cid, k.updated_at _upd, k.signed_at _date, CASE WHEN k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at >= date('now')) THEN 'active' ELSE 'inactive' END _st
      FROM consents k JOIN clients c ON c.id=k.client_id WHERE ${LIVE_CLIENT} AND k.type IN (${disclosure.FHIR_CONSENT_TYPES.map(t => `'${t}'`).join(',')})`,
    load: (kind, id) => db.one(`SELECT * FROM consents WHERE id=?`, id), map: mapConsent, date: true,
    params: { status: statusParam({ active: 'active', inactive: 'inactive' }) },
    // Only the consents that cover this recipient for this purpose, of a type that may cover it now (a
    // general release is listed only outside a Part 2 programme): which other organisations a client has
    // agreed to share with is none of this recipient's business.
    keep: (row, client) => disclosure.consentCovers({ type: row.type, recipient: dec(row.recipient_enc), purpose: dec(row.purpose_enc) }, { recipients: client.recipients, purposeOfUse: client.purpose }),
  },
  ServiceRequest: {
    src: `SELECT r.id _fid, 'referral' _kind, r.id _rid, r.client_id _cid, r.updated_at _upd, r.referred_at _date, r.status _st FROM referrals r JOIN clients c ON c.id=r.client_id WHERE ${LIVE_CLIENT}`,
    load: (kind, id) => db.one(`SELECT * FROM referrals WHERE id=?`, id), map: mapReferral, date: 'authored',
    params: { status: statusParam(SR_STATUS) },
  },
  Task: {
    src: `SELECT t.id _fid, 'task' _kind, t.id _rid, t.client_id _cid, t.updated_at _upd, t.created_at _date, t.status _st FROM tasks t JOIN clients c ON c.id=t.client_id WHERE ${LIVE_CLIENT}`,
    load: (kind, id) => db.one(`SELECT * FROM tasks WHERE id=?`, id), map: mapTask, date: 'authored-on',
    params: { status: statusParam(TASK_STATUS) },
  },
  Observation: {
    src: `SELECT 'risk-' || c.id _fid, 'risk' _kind, c.id _rid, c.id _cid, c.updated_at _upd, c.updated_at _date, 'survey' _cat FROM clients c WHERE ${LIVE_CLIENT} AND c.risk_level IS NOT NULL AND c.risk_level <> ''
      UNION ALL SELECT 'od-' || o.id, 'overdose', o.id, o.client_id, o.updated_at, o.occurred_at, 'overdose-event' FROM overdose_events o JOIN clients c ON c.id=o.client_id WHERE ${LIVE_CLIENT}`,
    load: (kind, id) => db.one(`SELECT * FROM ${kind === 'risk' ? 'clients' : 'overdose_events'} WHERE id=?`, id), map: (row, kind) => kind === 'risk' ? mapRisk(row) : mapOverdose(row), date: true,
    params: { category: (values) => orClause(values, v => ({ sql: `_cat = ?`, params: [v.includes('|') ? v.slice(v.indexOf('|') + 1) : v] })) },
  },
  DocumentReference: {
    src: `SELECT n.id _fid, 'note' _kind, n.id _rid, n.client_id _cid, n.updated_at _upd, COALESCE(n.signed_at, n.occurred_at) _date FROM notes n JOIN clients c ON c.id=n.client_id
      WHERE ${LIVE_CLIENT} AND n.deleted_at IS NULL AND n.status IN ('signed','amended') AND n.format <> 'supervision' AND n.counseling_note = 0`,
    load: (kind, id) => db.one(`SELECT * FROM notes WHERE id=?`, id), map: mapNote, date: true,
    params: {},
  },
  Organization: {
    directory: true,
    src: `SELECT '${PROGRAM_ORG}' _fid, 'program' _kind, '${PROGRAM_ORG}' _rid, NULL _cid, COALESCE((SELECT updated_at FROM settings WHERE key='org_name'), '2020-01-01T00:00:00.000Z') _upd, NULL _date, 1 _active, COALESCE((SELECT value FROM settings WHERE key='org_name'), 'SUDS program') _name
      UNION ALL SELECT r.id, 'resource', r.id, NULL, r.updated_at, NULL, r.is_active, COALESCE(NULLIF(r.organization, ''), r.name) FROM resources r`,
    load: (kind, id) => kind === 'program' ? { _program: true, updated_at: db.one(`SELECT updated_at FROM settings WHERE key='org_name'`)?.updated_at || '2020-01-01T00:00:00.000Z' } : db.one(`SELECT * FROM resources WHERE id=?`, id), map: mapOrganization,
    params: { name: nameParam, active: (values) => orClause(values, v => ({ sql: `_active = ?`, params: [v === 'true' ? 1 : 0] })) },
  },
  Location: {
    directory: true,
    src: `SELECT r.id _fid, 'resource' _kind, r.id _rid, NULL _cid, r.updated_at _upd, NULL _date, r.is_active _active, r.name _name, r.city _city, r.zip _zip FROM resources r`,
    load: (kind, id) => db.one(`SELECT * FROM resources WHERE id=?`, id), map: mapLocation,
    params: { name: nameParam, 'address-city': eqParam('_city'), 'address-postalcode': eqParam('_zip'), status: (values) => orClause(values, v => ({ sql: `_active = ?`, params: [v === 'active' ? 1 : 0] })) },
  },
  HealthcareService: {
    directory: true,
    src: `SELECT r.id _fid, 'resource' _kind, r.id _rid, NULL _cid, r.updated_at _upd, NULL _date, r.is_active _active, r.name _name, r.category _cat FROM resources r`,
    load: (kind, id) => db.one(`SELECT * FROM resources WHERE id=?`, id), map: mapHealthcareService,
    params: { name: nameParam, active: (values) => orClause(values, v => ({ sql: `_active = ?`, params: [v === 'true' ? 1 : 0] })), 'service-category': (values) => orClause(values, v => ({ sql: `_cat = ?`, params: [v.includes('|') ? v.slice(v.indexOf('|') + 1) : v] })) },
  },
};
for (const [type, d] of Object.entries(DEFS)) { d.type = type; d.phi = !d.directory; }

// Parameters that change the shape of the answer rather than filter it.
const CONTROL = ['_count', '_offset', '_format', '_pretty', '_summary', '_elements'];
const MAX_COUNT = 200; const DEFAULT_COUNT = 50;

/** Supported search parameters for a type (for the CapabilityStatement and for rejecting the rest). */
function searchParams(type) {
  const d = DEFS[type];
  const out = ['_id', '_lastUpdated'];
  if (d.phi && type !== 'Patient') out.push('patient');
  if (d.date) out.push(d.date === true ? 'date' : d.date);
  out.push(...Object.keys(d.params));
  if (d.params.name) out.push('name:contains', 'name:exact');
  return out;
}

/**
 * Turn a URLSearchParams into SQL over the type's src columns. Unknown parameters are refused (400) rather
 * than ignored: a misspelt filter that is silently dropped would widen what the caller receives.
 */
function where(type, query, { since } = {}) {
  const d = DEFS[type];
  const clauses = []; const params = [];
  const names = [...new Set([...query.keys()])];
  const allowed = searchParams(type);
  for (const name of names) {
    if (CONTROL.includes(name)) continue;
    if (!allowed.includes(name)) throw new FhirError(400, `Search parameter "${name}" is not supported for ${type}. Supported: ${allowed.join(', ')}`, { code: 'not-supported' });
    const values = query.getAll(name);
    const [base, mod] = name.split(':');
    let c;
    if (base === '_id') c = orClause(values, v => ({ sql: `_fid = ?`, params: [v] }));
    else if (base === '_lastUpdated') c = andDates('_upd', values);
    else if (base === 'patient') c = orClause(values, v => ({ sql: `_cid = ?`, params: [refId(v, 'Patient')] }));
    else if (d.date && base === (d.date === true ? 'date' : d.date)) c = andDates('_date', values);
    else c = d.params[base](values, mod);
    clauses.push(c.sql); params.push(...c.params);
  }
  if (since) { clauses.push('_upd > ?'); params.push(since); }
  return { sql: clauses.length ? clauses.join(' AND ') : '1=1', params };
}
function andDates(col, values) {
  const parts = values.map(v => dateClause(col, v));
  return { sql: parts.map(p => p.sql).join(' AND '), params: parts.flatMap(p => p.params) };
}

/** Rows (not yet mapped) for one page of a search. */
function page(type, filter, { count, offset }) {
  const d = DEFS[type];
  return db.all(`SELECT * FROM (${d.src}) s WHERE ${filter.sql} ORDER BY _upd, _fid LIMIT ? OFFSET ?`, ...filter.params, count, offset);
}
function toResource(type, row) {
  const d = DEFS[type];
  const full = d.load(row._kind, row._rid);
  if (!full) return null;
  return { full, resource: d.map(full, row._kind) };
}
/** Did this search name one person (so that saying "N were withheld" would itself say who is a client)? */
function identifying(type, query) {
  const d = DEFS[type];
  const keys = [...query.keys()].map(k => k.split(':')[0]);
  return keys.includes('patient') || keys.includes('_id') || (d.identifying || []).some(k => keys.includes(k));
}

module.exports = { DEFS, PROGRAM_ORG, MAX_COUNT, DEFAULT_COUNT, searchParams, where, page, toResource, identifying, US_CORE };
