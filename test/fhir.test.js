'use strict';
// The read-only FHIR R4 API (server/routes/fhir.js, docs/integration/FHIR.md): resource shapes, search,
// paging, bulk export, scopes, and — above all — 42 CFR Part 2: a client's data leaves only under a live
// consent that names the FHIR client's organisation (a Part 2 consent or the 2024 single TPO consent; a
// general release only outside a Part 2 programme), never for a client with an agreed restriction, never
// SUD counseling notes; every such answer is labelled and carries the 2024 §2.32 notice, and each one is
// written to the accounting of disclosures.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');
const { encrypt } = require('../server/crypto');
const config = require('../server/config');

const RECIPIENT = 'County Behavioral Health';
let base, admin, nav, adminId;
let ehr, dirOnly; // { id, key }
const ids = {};
const iso = (ms) => new Date(ms).toISOString();

async function fhirGet(p, token, extra = {}) {
  const res = await fetch(base + p, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json', ...extra } });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, headers: res.headers, ct, data: ct.includes('json') && !ct.includes('ndjson') && text ? JSON.parse(text) : text };
}
const entriesOf = (b, type) => (b.entry || []).filter(e => !type || e.resource.resourceType === type).map(e => e.resource);
const outcomeOf = (b) => (b.entry || []).map(e => e.resource).find(r => r.resourceType === 'OperationOutcome');
function refsIn(o, out = []) {
  if (Array.isArray(o)) o.forEach(x => refsIn(x, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'reference' && typeof v === 'string') out.push(v); else refsIn(v, out); }
  return out;
}

async function newClient(first, last, extra = {}) {
  const r = await admin.post('/api/clients', { first_name: first, last_name: last, dob: '1985-06-15', city: 'Sacramento', zip: '95814', status: 'active', gender: 'female', race_codes: 'white,hispanic_latino', phone: '916-555-0101', confirm_duplicate: true, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
function consent(clientId, { type = 'part2_disclosure', recipient = RECIPIENT, purpose = 'Treatment and care coordination', signed = '2026-01-10', expires = '2030-01-01', revoked = null } = {}) {
  const id = randomUUID();
  H.db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,revoked_at,signed_on_paper,redisclosure_notice_given,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, clientId, type, encrypt(recipient), encrypt(purpose), encrypt('Navigation record'), signed, expires, revoked, 1, 1, adminId);
  return id;
}
function clinicalData(clientId, tag) {
  const now = iso(Date.now());
  const ep = randomUUID(); H.db.run(`INSERT INTO episodes(id,client_id,opened_at,opened_by,status) VALUES(?,?,?,?,?)`, ep, clientId, '2026-02-01', adminId, 'open');
  const iv = randomUUID(); H.db.run(`INSERT INTO interventions(id,client_id,user_id,type,occurred_at,duration_minutes,location,modality,outcome,summary_enc) VALUES(?,?,?,?,?,?,?,?,?,?)`, iv, clientId, adminId, 'care_coordination', '2026-03-05T17:00:00.000Z', 30, 'field', 'in_person', 'completed', encrypt(`Visit summary ${tag}`));
  const call = randomUUID(); H.db.run(`INSERT INTO calls(id,client_id,user_id,direction,method,started_at,duration_minutes,outcome,crisis) VALUES(?,?,?,?,?,?,?,?,?)`, call, clientId, adminId, 'outbound', 'phone', '2026-04-01T16:00:00.000Z', 10, 'reached', 1);
  const ref = randomUUID(); H.db.run(`INSERT INTO referrals(id,client_id,resource_id,user_id,referred_at,status,urgency,notes_enc) VALUES(?,?,?,?,?,?,?,?)`, ref, clientId, ids.resource, adminId, '2026-03-06', 'scheduled', 'urgent', encrypt(`Referral note ${tag}`));
  const task = randomUUID(); H.db.run(`INSERT INTO tasks(id,client_id,created_by,title_enc,due_at,priority,status,referral_id) VALUES(?,?,?,?,?,?,?,?)`, task, clientId, adminId, encrypt(`Confirm intake ${tag}`), '2026-03-10', 'high', 'open', ref);
  const od = randomUUID(); H.db.run(`INSERT INTO overdose_events(id,client_id,occurred_at,kind,naloxone_used,naloxone_doses,ems_called,survived,reported_by) VALUES(?,?,?,?,?,?,?,?,?)`, od, clientId, '2026-02-20T03:00:00.000Z', 'reversal', 1, 2, 1, 1, adminId);
  const note = randomUUID(); H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,title_enc,content_enc,occurred_at,status,signed_at,signed_by,intervention_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, note, clientId, adminId, 'clinical', 'SOAP', encrypt(`Title ${tag}`), encrypt(`SECRET COUNSELING CONTENT ${tag}`), '2026-03-05T17:00:00.000Z', 'signed', now, adminId, iv);
  const draft = randomUUID(); H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,content_enc,occurred_at,status) VALUES(?,?,?,?,?,?,?,?)`, draft, clientId, adminId, 'admin', 'contact', encrypt('draft'), now, 'draft');
  H.db.run(`UPDATE clients SET risk_level='high' WHERE id=?`, clientId);
  return { ep, iv, call, ref, task, od, note, draft };
}

before(async () => {
  base = await H.start();
  H.makeUser('fnav', 'navigator');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('fnav', 'StaffPassw0rd!x');
  adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  ids.resource = (await admin.post('/api/resources', { name: 'Riverbend OTP', category: 'mat_otp', organization: 'Riverbend Health', phone: '916-555-0199', city: 'Sacramento', service_tags: 'mat_methadone,walk_in', accepts_medicaid: true })).data.id;
  assert.ok(ids.resource);
  ids.consented = await newClient('Ada', 'Consented', { medicaid_id: 'MCD123' });
  ids.consentId = consent(ids.consented);
  ids.none = await newClient('Nora', 'Noconsent');
  ids.revoked = await newClient('Rhea', 'Revoked'); consent(ids.revoked, { revoked: iso(Date.now() - 86400000) });
  ids.expired = await newClient('Ezra', 'Expired'); consent(ids.expired, { signed: '2019-01-01', expires: '2020-01-01' });
  ids.otherOrg = await newClient('Otto', 'Otherorg'); consent(ids.otherOrg, { recipient: 'Probation Department' });
  // The 2024 single TPO consent: a recipient list/class that names the organisation covers every purpose of use.
  ids.tpo = await newClient('Tia', 'Tpo'); consent(ids.tpo, { type: 'part2_tpo', recipient: 'county behavioral health, and my other treating providers and health plans', purpose: 'My treatment, payment and health care operations' });
  // Withheld while this is a Part 2 programme: a general release is not a Part 2 consent (§2.31, §2.32).
  ids.roi = await newClient('Rory', 'Generalrelease'); consent(ids.roi, { type: 'roi', recipient: RECIPIENT, purpose: 'TPO' });
  // Withheld: a TPO consent whose class names no organisation cannot be matched by a machine.
  ids.tpoClass = await newClient('Cass', 'Classonly'); consent(ids.tpoClass, { type: 'part2_tpo', recipient: 'My treating providers', purpose: 'Treatment, payment and health care operations' });
  // Withheld: a counseling-notes-only consent never covers FHIR, even naming the organisation.
  ids.cnOnly = await newClient('Cleo', 'Notesonly'); consent(ids.cnOnly, { type: 'part2_counseling_notes', recipient: RECIPIENT, purpose: 'Treatment' });
  // Withheld: an agreed restriction (§2.26) needs a worker's confirmation, which an automated answer cannot give.
  ids.restricted = await newClient('Reese', 'Restricted'); consent(ids.restricted);
  H.db.run(`INSERT INTO patient_requests(id,client_id,kind,received_at,due_at,status,created_by,closed_at) VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), ids.restricted, 'restriction', '2026-01-05', '2026-02-04', 'fulfilled', adminId, '2026-01-06');
  ids.wrongPurpose = await newClient('Walt', 'Wrongpurpose'); consent(ids.wrongPurpose, { purpose: 'Research study enrolment' });
  ids.data = clinicalData(ids.consented, 'A');
  // A signed SUD counseling note (§2.11) for the consented client: never listed over FHIR, not even as metadata.
  ids.counselingNote = randomUUID();
  H.db.run(`INSERT INTO notes(id,client_id,author_id,kind,format,content_enc,occurred_at,status,signed_at,signed_by,counseling_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ids.counselingNote, ids.consented, adminId, 'clinical', 'SOAP', encrypt('COUNSELING NOTE ANALYSIS'), '2026-03-06T17:00:00.000Z', 'signed', iso(Date.now()), adminId, 1);
  ids.dataNone = clinicalData(ids.none, 'B');
  const c = await admin.post('/api/admin/fhir-clients', { name: 'County EHR', recipient: RECIPIENT, purpose: 'TREAT', scopes: ['system/*.read'], rate_limit: 5000 });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  ehr = c.data;
  dirOnly = (await admin.post('/api/admin/fhir-clients', { name: '211 directory', recipient: '211 Info', scopes: ['system/HealthcareService.read'] })).data;
});
after(async () => {
  // Exports the tests left running or complete would otherwise sit in the data directory until they expire.
  for (const id of require('../server/fhir/bulk')._jobs.keys()) fs.rmSync(path.join(config.dataDir, 'fhir-export', id), { recursive: true, force: true });
  await H.stop();
});

test('the CapabilityStatement is public, FHIR JSON, and says what is served', async () => {
  const r = await fetch(base + '/fhir/R4/metadata');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/fhir\+json/);
  const cs = await r.json();
  assert.equal(cs.resourceType, 'CapabilityStatement');
  assert.equal(cs.fhirVersion, '4.0.1');
  const types = cs.rest[0].resource.map(x => x.type);
  for (const t of ['Patient', 'EpisodeOfCare', 'Encounter', 'Consent', 'ServiceRequest', 'Task', 'Observation', 'DocumentReference', 'Organization', 'Location', 'HealthcareService']) assert.ok(types.includes(t), t);
  assert.ok(cs.rest[0].operation.some(o => o.name === 'export'));
  assert.match(JSON.stringify(cs.rest[0].security), /auth\/token/);
  assert.ok(!JSON.stringify(cs).includes('Consented'), 'no PHI');
  const smart = await (await fetch(base + '/fhir/R4/.well-known/smart-configuration')).json();
  assert.ok(smart.token_endpoint.endsWith('/fhir/R4/auth/token'));
});

test('no token, a bad token, an intake key: 401 as an OperationOutcome', async () => {
  const none = await fetch(base + '/fhir/R4/Patient');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /Bearer/);
  assert.equal((await none.json()).resourceType, 'OperationOutcome');
  assert.equal((await fhirGet('/fhir/R4/Patient', 'sudsfhir_nope')).status, 401);
  const intake = await admin.post('/api/admin/api-keys', { name: 'Pocket AI' });
  assert.equal((await fhirGet('/fhir/R4/Patient', intake.data.key)).status, 401, 'an intake key cannot read FHIR');
  // ...and a FHIR key cannot stage notes through intake.
  const c = H.client();
  assert.equal((await c.get('/api/intake/ping', { Authorization: `Bearer ${ehr.key}`, Cookie: '' })).status, 401);
  assert.equal((await c.get('/api/intake/ping', { Authorization: `Bearer ${intake.data.key}`, Cookie: '' })).status, 200, 'the intake key still works there');
  const unknown = await fhirGet('/fhir/R4/Nonsense', ehr.key);
  assert.equal(unknown.status, 404); assert.equal(unknown.data.resourceType, 'OperationOutcome');
  const nopath = await fhirGet('/fhir/R4/Patient/a/b/c', ehr.key);
  assert.equal(nopath.status, 404); assert.match(nopath.ct, /fhir\+json/); assert.equal(nopath.data.resourceType, 'OperationOutcome');
});

test('OAuth2 client credentials: a token, narrowed scopes, refusals', async () => {
  const post = (body, headers = {}) => fetch(base + '/fhir/R4/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body });
  let r = await post(`grant_type=client_credentials&client_id=${ehr.id}&client_secret=${encodeURIComponent(ehr.key)}`);
  assert.equal(r.status, 200);
  const tok = await r.json();
  assert.equal(tok.token_type, 'bearer'); assert.ok(tok.expires_in > 0); assert.equal(tok.scope, 'system/*.read');
  assert.equal((await fhirGet('/fhir/R4/Patient', tok.access_token)).status, 200);
  // Basic auth and a narrower scope.
  r = await post('grant_type=client_credentials&scope=system/Patient.read', { Authorization: 'Basic ' + Buffer.from(`${ehr.id}:${ehr.key}`).toString('base64') });
  const narrow = await r.json();
  assert.equal(narrow.scope, 'system/Patient.read');
  assert.equal((await fhirGet('/fhir/R4/Patient', narrow.access_token)).status, 200);
  const denied = await fhirGet('/fhir/R4/Encounter', narrow.access_token);
  assert.equal(denied.status, 403, 'a token narrowed to Patient cannot read Encounter');
  assert.equal(denied.data.resourceType, 'OperationOutcome');
  assert.equal((await post(`grant_type=client_credentials&client_id=${ehr.id}&client_secret=wrong`)).status, 401);
  assert.equal((await post(`grant_type=password&client_id=${ehr.id}&client_secret=${encodeURIComponent(ehr.key)}`)).status, 400);
  // A directory-only client cannot widen itself to Patient.
  const widen = await post(`grant_type=client_credentials&client_id=${dirOnly.id}&client_secret=${encodeURIComponent(dirOnly.key)}&scope=system/Patient.read`);
  assert.equal(widen.status, 400); assert.equal((await widen.json()).error, 'invalid_scope');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.token.issued' AND entity_id=?`, ehr.id));
});

test('scopes: a client without the scope gets 403 and the refusal is audited', async () => {
  const r = await fhirGet('/fhir/R4/Patient', dirOnly.key);
  assert.equal(r.status, 403);
  assert.equal(r.data.issue[0].code, 'forbidden');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.denied' AND entity='Patient'`));
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.consented}`, dirOnly.key)).status, 403);
  const hs = await fhirGet('/fhir/R4/HealthcareService', dirOnly.key);
  assert.equal(hs.status, 200);
  assert.equal(entriesOf(hs.data, 'HealthcareService')[0].name, 'Riverbend OTP');
});

test('Patient search returns only consented patients, labelled, with omissions counted and the §2.32 notice', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='fhir'`).n;
  const r = await fhirGet('/fhir/R4/Patient', ehr.key);
  assert.equal(r.status, 200);
  assert.match(r.ct, /application\/fhir\+json/);
  const b = r.data;
  assert.equal(b.resourceType, 'Bundle'); assert.equal(b.type, 'searchset');
  const got = entriesOf(b, 'Patient').map(p => p.id).sort();
  assert.deepEqual(got, [ids.consented, ids.tpo].sort(), 'only the patients whose consent names the recipient for treatment');
  const codes = b.meta.security.map(s => s.code);
  assert.ok(codes.includes('R') && codes.includes('42CFRPart2'), 'Bundle carries the Part 2 labels');
  const oo = outcomeOf(b);
  assert.ok(oo, 'an OperationOutcome entry');
  // The one §2.32 notice SUDS uses everywhere, in the 2024 final rule's wording.
  const notice = require('../server/constants').PART2_REDISCLOSURE_NOTICE;
  assert.ok(oo.issue.some(i => i.diagnostics === `42 CFR §2.32 notice: ${notice}`), 'the §2.32 notice');
  assert.ok(oo.issue.some(i => /prohibit you from making any other use or disclosure of this record unless at least one of the following applies/.test(i.diagnostics)), 'in the 2024 wording');
  const omitted = oo.issue.find(i => i.code === 'suppressed');
  assert.match(omitted.diagnostics, /^9 patient\(s\)/, 'none, revoked, expired, other org, wrong purpose, general release, unnamed TPO class, counseling-notes-only, restricted');
  for (const id of [ids.roi, ids.tpoClass, ids.cnOnly, ids.restricted]) assert.ok(!got.includes(id));
  const p = entriesOf(b, 'Patient').find(x => x.id === ids.consented);
  assert.ok(p.meta.security.some(s => s.code === '42CFRPart2'));
  assert.ok(p.meta.profile[0].endsWith('us-core-patient'));
  assert.equal(p.name[0].family, 'Consented'); assert.equal(p.birthDate, '1985-06-15'); assert.equal(p.gender, 'female');
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, ids.consented).client_code;
  assert.ok(p.identifier.some(i => i.system === 'urn:suds:client-code' && i.value === code));
  assert.ok(p.identifier.some(i => i.value === 'MCD123'));
  assert.ok(p.extension.some(e => e.url.endsWith('us-core-race')) && p.extension.some(e => e.url.endsWith('us-core-ethnicity')));
  assert.ok(!JSON.stringify(b).includes('Noconsent'), 'nothing about the patient without consent');
  // Accounting: one row per disclosed patient for this request, under the consent, to the recipient.
  const rows = H.db.all(`SELECT * FROM disclosures WHERE source='fhir' ORDER BY rowid DESC LIMIT 2`);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE source='fhir'`).n - before, 2);
  const mine = rows.find(x => x.client_id === ids.consented);
  assert.equal(mine.consent_id, ids.consentId); assert.equal(mine.basis, 'consent'); assert.equal(mine.method, 'FHIR API');
  assert.equal(mine.notice_version, '2024', 'the notice version that went with it'); assert.equal(mine.legal_proceeding, 0); assert.equal(mine.counseling_notes, 0);
  const d = require('../server/disclosure').present(mine);
  assert.equal(d.recipient, RECIPIENT); assert.match(d.what, /FHIR search Patient: 1 resource/); assert.match(d.purpose, /Treatment/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE client_id=?`, ids.none).n, 0, 'nothing is recorded (or sent) for the unconsented');
  // The audit trail has the request, with parameter names only.
  const a = H.db.one(`SELECT * FROM audit_log WHERE action='fhir.search' AND entity='Patient' ORDER BY id DESC LIMIT 1`);
  assert.equal(a.username, 'fhir:County EHR');
  assert.equal(JSON.parse(a.details).omitted_patients, 9);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='disclosure.record' AND client_id=?`, ids.consented));
});

test('a search that names one person never says whether they were withheld', async () => {
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, ids.none).client_code;
  const r = await fhirGet(`/fhir/R4/Patient?identifier=${encodeURIComponent('urn:suds:client-code|' + code)}`, ehr.key);
  assert.equal(entriesOf(r.data, 'Patient').length, 0);
  const text = JSON.stringify(outcomeOf(r.data));
  assert.ok(!/withheld|1 patient/.test(text), 'no count that would confirm the person is a client');
  const code2 = H.db.one(`SELECT client_code FROM clients WHERE id=?`, ids.consented).client_code;
  const r2 = await fhirGet(`/fhir/R4/Patient?identifier=${code2}`, ehr.key);
  assert.deepEqual(entriesOf(r2.data, 'Patient').map(p => p.id), [ids.consented]);
  assert.equal(JSON.stringify(outcomeOf(r2.data)).replace(/"id":"[^"]+"/, ''), text.replace(/"id":"[^"]+"/, ''), 'the same words either way');
  assert.deepEqual(entriesOf((await fhirGet('/fhir/R4/Patient?family=consented&birthdate=1985-06-15', ehr.key)).data, 'Patient').map(p => p.id), [ids.consented]);
  assert.deepEqual(entriesOf((await fhirGet('/fhir/R4/Patient?given=Ada', ehr.key)).data, 'Patient').map(p => p.id), [ids.consented]);
});

test('read: a consented patient is returned, anyone else is 404 exactly like a missing record', async () => {
  const ok = await fhirGet(`/fhir/R4/Patient/${ids.consented}`, ehr.key);
  assert.equal(ok.status, 200); assert.equal(ok.data.resourceType, 'Patient'); assert.equal(ok.data.id, ids.consented);
  const no = await fhirGet(`/fhir/R4/Patient/${ids.none}`, ehr.key);
  const missing = await fhirGet(`/fhir/R4/Patient/${randomUUID()}`, ehr.key);
  assert.equal(no.status, 404); assert.equal(missing.status, 404);
  assert.equal(no.data.issue[0].code, missing.data.issue[0].code);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.read.withheld' AND client_id=?`, ids.none), 'the refusal is audited internally');
  assert.equal((await fhirGet(`/fhir/R4/Encounter/iv-${ids.dataNone.iv}`, ehr.key)).status, 404);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.read' AND entity='Patient' AND client_id=?`, ids.consented));
});

test('every patient resource type: valid shape, labelled, only the consented patient, and every reference resolves', async () => {
  const types = ['EpisodeOfCare', 'Encounter', 'Consent', 'ServiceRequest', 'Task', 'Observation', 'DocumentReference'];
  const seen = {};
  for (const type of types) {
    const r = await fhirGet(`/fhir/R4/${type}`, ehr.key);
    assert.equal(r.status, 200, type);
    const list = entriesOf(r.data, type);
    assert.ok(list.length > 0, `${type} has results`);
    for (const res of list) {
      assert.equal(res.resourceType, type); assert.match(res.id, /^[A-Za-z0-9\-.]{1,64}$/);
      assert.ok(res.meta.security.some(s => s.code === 'R'), `${type} is labelled restricted`);
      const subject = res.subject || res.patient || res.for;
      assert.ok([`Patient/${ids.consented}`, `Patient/${ids.tpo}`].includes(subject.reference), `${type} is about a consented patient only`);
    }
    assert.match(outcomeOf(r.data).issue.find(i => i.code === 'suppressed')?.diagnostics || '', /withheld/, `${type}: the unconsented patient's ${type} are counted`);
    seen[type] = list;
  }
  const enc = seen.Encounter;
  assert.ok(enc.some(e => e.id === `iv-${ids.data.iv}` && e.class.code === 'FLD' && e.meta.profile[0].endsWith('us-core-encounter')));
  assert.ok(enc.some(e => e.id === `call-${ids.data.call}` && e.class.code === 'VR' && e.priority.coding[0].code === 'EM'), 'a call is a virtual encounter');
  const consentRes = seen.Consent.filter(c => c.patient.reference === `Patient/${ids.consented}`);
  assert.equal(consentRes.length, 1);
  assert.equal(consentRes[0].status, 'active');
  assert.equal(consentRes[0].policyRule.coding[0].code, '42CFRPart2');
  assert.equal(consentRes[0].provision.actor[0].reference.display, RECIPIENT);
  assert.ok(consentRes[0].provision.purpose.some(p => p.code === 'TREAT'));
  // The single TPO consent is a Part 2 consent covering all three purposes of use.
  const tpoRes = seen.Consent.find(c => c.patient.reference === `Patient/${ids.tpo}`);
  assert.equal(tpoRes.policyRule.coding[0].code, '42CFRPart2');
  assert.deepEqual(tpoRes.provision.purpose.map(p => p.code).sort(), ['HOPERAT', 'HPAYMT', 'TREAT']);
  const sr = seen.ServiceRequest[0];
  assert.equal(sr.status, 'active'); assert.equal(sr.intent, 'order'); assert.equal(sr.priority, 'urgent');
  assert.equal(sr.performer[0].reference, `Organization/${ids.resource}`);
  assert.equal(seen.Task[0].focus.reference, `ServiceRequest/${ids.data.ref}`);
  assert.equal(seen.Task[0].description, 'Confirm intake A');
  assert.ok(seen.Observation.some(o => o.id === `od-${ids.data.od}` && o.component.some(c => c.code.coding[0].code === 'naloxone-doses' && c.valueInteger === 2)));
  assert.ok(seen.Observation.some(o => o.id === `risk-${ids.consented}` && o.valueCodeableConcept.coding[0].code === 'high'));
  const docs = seen.DocumentReference;
  assert.deepEqual(docs.map(d => d.id), [ids.data.note], 'signed notes only, not drafts, and never a SUD counseling note');
  assert.equal((await fhirGet(`/fhir/R4/DocumentReference/${ids.counselingNote}`, ehr.key)).status, 404, 'a counseling note cannot be read by id either');
  assert.ok(!JSON.stringify(docs).includes('SECRET COUNSELING CONTENT'), 'never the note text');
  assert.ok(!JSON.stringify(docs).includes('Title A'));
  assert.ok(!docs[0].content[0].attachment.data && !docs[0].content[0].attachment.url);
  // Every reference in every resource resolves on this server.
  const refs = new Set(Object.values(seen).flat().flatMap(r => refsIn(r)));
  refs.add(`Patient/${ids.consented}`);
  for (const ref of refs) {
    const r = await fhirGet(`/fhir/R4/${ref}`, ehr.key);
    assert.equal(r.status, 200, `${ref} resolves`);
    assert.equal(`${r.data.resourceType}/${r.data.id}`, ref);
  }
});

test('the resource directory is not PHI: no consent needed, no Part 2 label, nothing in the accounting', async () => {
  const before = H.db.one(`SELECT COUNT(*) n FROM disclosures`).n;
  for (const type of ['Organization', 'Location', 'HealthcareService']) {
    const r = await fhirGet(`/fhir/R4/${type}`, ehr.key);
    assert.equal(r.status, 200);
    assert.ok(!r.data.meta.security, `${type} bundle is not labelled Part 2`);
    assert.ok(!outcomeOf(r.data));
    assert.ok(entriesOf(r.data, type).length >= 1);
  }
  const org = await fhirGet(`/fhir/R4/Organization/${ids.resource}`, ehr.key);
  assert.equal(org.data.name, 'Riverbend Health'); assert.ok(org.data.meta.profile[0].endsWith('us-core-organization'));
  assert.equal((await fhirGet('/fhir/R4/Organization/suds-program', ehr.key)).status, 200);
  const hs = await fhirGet(`/fhir/R4/HealthcareService?name=river`, ehr.key);
  assert.equal(entriesOf(hs.data)[0].providedBy.reference, `Organization/${ids.resource}`);
  assert.equal(entriesOf((await fhirGet(`/fhir/R4/HealthcareService?name:exact=Nope`, ehr.key)).data).length, 0);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures`).n, before);
});

test('search parameters: patient, dates, _lastUpdated, _id, status; unknown or malformed ones are refused', async () => {
  const q = async (p) => entriesOf((await fhirGet(p, ehr.key)).data).filter(r => r.resourceType !== 'OperationOutcome');
  assert.equal((await q(`/fhir/R4/Encounter?patient=Patient/${ids.consented}`)).length, 2);
  assert.equal((await q(`/fhir/R4/Encounter?patient=${ids.consented}&date=ge2026-04-01`)).length, 1, 'only the April call');
  assert.equal((await q(`/fhir/R4/Encounter?patient=${ids.consented}&date=2026-03`)).length, 1, 'a month is its whole range');
  assert.equal((await q(`/fhir/R4/Encounter?date=ge2026-01-01&date=lt2026-03-06`)).length, 1);
  assert.equal((await q(`/fhir/R4/Encounter?_id=iv-${ids.data.iv}`)).length, 1);
  assert.equal((await q(`/fhir/R4/Patient?_lastUpdated=gt2999-01-01`)).length, 0);
  assert.ok((await q(`/fhir/R4/Patient?_lastUpdated=ge2020-01-01`)).length >= 1);
  assert.equal((await q(`/fhir/R4/ServiceRequest?status=active`)).length, 1);
  assert.equal((await q(`/fhir/R4/ServiceRequest?status=completed`)).length, 0);
  assert.equal((await q(`/fhir/R4/ServiceRequest?authored=2026-03-06`)).length, 1);
  assert.equal((await q(`/fhir/R4/Task?status=requested&patient=${ids.consented}`)).length, 1);
  assert.equal((await q(`/fhir/R4/Observation?category=overdose-event`)).length, 1);
  const eps = await q(`/fhir/R4/EpisodeOfCare?status=active&patient=${ids.consented}`); assert.ok(eps.length >= 1 && eps.every(e => e.status === 'active'));
  assert.equal((await q(`/fhir/R4/EpisodeOfCare?status=finished`)).length, 0);
  const bad = await fhirGet('/fhir/R4/Patient?nickname=x', ehr.key);
  assert.equal(bad.status, 400); assert.equal(bad.data.issue[0].code, 'not-supported');
  assert.equal((await fhirGet('/fhir/R4/Encounter?date=yesterday', ehr.key)).status, 400);
  assert.equal((await fhirGet('/fhir/R4/Patient?birthdate=ge1980', ehr.key)).status, 400);
  assert.equal((await fhirGet('/fhir/R4/Patient?_count=-1', ehr.key)).status, 400);
});

test('paging: _count, next and previous links, and the cap', async () => {
  const first = await fhirGet('/fhir/R4/Encounter?_count=1', ehr.key);
  const self = first.data.link.find(l => l.relation === 'self'); const next = first.data.link.find(l => l.relation === 'next');
  assert.ok(self && next, 'self and next');
  assert.ok(entriesOf(first.data, 'Encounter').length <= 1, 'a page never holds more than _count (fewer when some were withheld)');
  const seen = new Set(entriesOf(first.data, 'Encounter').map(e => e.id));
  let url = next.url; let pages = 1;
  while (url && pages < 10) {
    const r = await fhirGet(url.replace(/^https?:\/\/[^/]+/, ''), ehr.key);
    assert.ok(r.data.link.some(l => l.relation === 'previous'));
    for (const e of entriesOf(r.data, 'Encounter')) seen.add(e.id);
    url = r.data.link.find(l => l.relation === 'next')?.url; pages++;
  }
  assert.equal(seen.size, 2, 'both encounters across the pages, the unconsented ones never');
  const capped = await fhirGet('/fhir/R4/Patient?_count=100000', ehr.key);
  assert.match(capped.data.link[0].url, /_count=200/);
});

test('a general release covers FHIR only outside a Part 2 programme, and lifting a restriction restores the flow', async () => {
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.roi}`, ehr.key)).status, 404, 'a general release is not a Part 2 consent');
  H.db.setSetting('part2_program', '0');
  try {
    assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.roi}`, ehr.key)).status, 200, 'outside Part 2 a release naming the organisation for TPO is enough');
    const c = entriesOf((await fhirGet(`/fhir/R4/Consent?patient=${ids.roi}`, ehr.key)).data, 'Consent');
    assert.equal(c.length, 1); assert.equal(c[0].policyRule.coding[0].code, 'hipaa-auth');
    const row = H.db.one(`SELECT * FROM disclosures WHERE client_id=? AND source='fhir' ORDER BY rowid DESC LIMIT 1`, ids.roi);
    assert.equal(row.notice_version, null, 'no §2.32 notice version outside a Part 2 programme');
    assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.cnOnly}`, ehr.key)).status, 404, 'a counseling-notes consent still does not cover FHIR');
  } finally { H.db.setSetting('part2_program', '1'); }
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.roi}`, ehr.key)).status, 404, 'and the setting takes effect on the next request');
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.restricted}`, ehr.key)).status, 404);
  H.db.run(`UPDATE patient_requests SET status='denied', updated_at=? WHERE client_id=?`, new Date().toISOString(), ids.restricted);
  try { assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.restricted}`, ehr.key)).status, 200, 'with no agreed restriction the consent covers the client again'); }
  finally { H.db.run(`UPDATE patient_requests SET status='fulfilled', updated_at=? WHERE client_id=?`, new Date().toISOString(), ids.restricted); }
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.restricted}`, ehr.key)).status, 404);
});

test('revoking the consent stops the flow at once', async () => {
  const other = await newClient('Vic', 'Victim');
  const cid = consent(other);
  assert.equal((await fhirGet(`/fhir/R4/Patient/${other}`, ehr.key)).status, 200);
  const rv = await admin.post(`/api/consents/${cid}/revoke`, { reason: 'Client withdrew' });
  assert.equal(rv.status, 200);
  assert.equal((await fhirGet(`/fhir/R4/Patient/${other}`, ehr.key)).status, 404);
  const s = await fhirGet('/fhir/R4/Patient', ehr.key);
  assert.ok(!entriesOf(s.data, 'Patient').some(p => p.id === other));
});

async function poll(loc, token) {
  for (let i = 0; i < 100; i++) {
    const r = await fhirGet(loc.replace(/^https?:\/\/[^/]+/, ''), token);
    if (r.status !== 202) return r;
    assert.ok(r.headers.get('x-progress'));
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error('export never finished');
}

test('bulk export: kick-off, status, NDJSON files encrypted at rest, consent filtering, accounting, delete', async () => {
  const noPrefer = await fhirGet('/fhir/R4/$export', ehr.key);
  assert.equal(noPrefer.status, 400);
  const bad = await fhirGet('/fhir/R4/Patient/$export?_type=Organization', ehr.key, { Prefer: 'respond-async' });
  assert.equal(bad.status, 400, 'the directory is not in the Patient compartment');
  assert.equal((await fhirGet('/fhir/R4/$export?_type=Patient', dirOnly.key, { Prefer: 'respond-async' })).status, 403, 'scopes apply to export too');
  const k = await fhirGet('/fhir/R4/$export?_type=Patient,Encounter,Organization&_outputFormat=application/fhir%2Bndjson', ehr.key, { Prefer: 'respond-async' });
  assert.equal(k.status, 202);
  const loc = k.headers.get('content-location');
  assert.match(loc, /\/fhir\/R4\/\$export-status\//);
  const jobId = loc.split('/').pop();
  assert.equal((await fhirGet(loc.replace(/^https?:\/\/[^/]+/, ''), dirOnly.key)).status, 404, 'another client cannot see this export');
  const done = await poll(loc, ehr.key);
  assert.equal(done.status, 200);
  const m = done.data;
  assert.equal(m.requiresAccessToken, true); assert.ok(m.transactionTime);
  assert.deepEqual(m.output.map(o => o.type).sort(), ['Encounter', 'Organization', 'Patient']);
  assert.equal(m.extension['urn:suds:part2'].security.find(s => s.code === '42CFRPart2').code, '42CFRPart2');
  // Encrypted at rest.
  const dir = path.join(config.dataDir, 'fhir-export', jobId);
  for (const f of fs.readdirSync(dir)) { const raw = fs.readFileSync(path.join(dir, f), 'utf8'); assert.match(raw, /^v1:/); assert.ok(!raw.includes('Consented')); }
  const patients = m.output.find(o => o.type === 'Patient');
  const unauth = await fetch(patients.url.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(unauth.status, 401, 'files need the token');
  const file = await fhirGet(patients.url.replace(/^https?:\/\/[^/]+/, ''), ehr.key);
  assert.equal(file.status, 200); assert.match(file.ct, /application\/fhir\+ndjson/);
  const lines = file.data.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(p => p.id).sort(), [ids.consented, ids.tpo].sort());
  assert.equal(patients.count, 2);
  const oo = await fhirGet(m.error[0].url.replace(/^https?:\/\/[^/]+/, ''), ehr.key);
  const issues = JSON.parse(oo.data.trim()).issue;
  assert.ok(issues.some(i => /42 CFR part 2/.test(i.diagnostics)));
  assert.ok(issues.some(i => /patient\(s\) were left out/.test(i.diagnostics)));
  // One accounting row per patient for the whole export.
  const rows = H.db.all(`SELECT client_id FROM disclosures WHERE source_ref=?`, `fhir-export:${jobId}`);
  assert.deepEqual(rows.map(r => r.client_id).sort(), [ids.consented, ids.tpo].sort());
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.export.complete' AND entity_id=?`, jobId));
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.export.download' AND entity_id=?`, jobId));
  // Delete.
  const del = await fetch(loc.replace(/^https?:\/\/[^/]+/, base), { method: 'DELETE', headers: { Authorization: `Bearer ${ehr.key}` } });
  assert.equal(del.status, 202);
  assert.ok(!fs.existsSync(dir), 'files removed');
  assert.equal((await fhirGet(loc.replace(/^https?:\/\/[^/]+/, ''), ehr.key)).status, 404);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir.export.delete' AND entity_id=?`, jobId));
});

test('bulk export at Patient level with _since exports only patient data changed since then', async () => {
  const k = await fhirGet(`/fhir/R4/Patient/$export?_since=${encodeURIComponent('2999-01-01T00:00:00Z')}`, ehr.key, { Prefer: 'respond-async' });
  assert.equal(k.status, 202);
  const done = await poll(k.headers.get('content-location'), ehr.key);
  assert.equal(done.status, 200);
  assert.deepEqual(done.data.output, [], 'nothing changed after 2999');
  const all = await fhirGet('/fhir/R4/Patient/$export', ehr.key, { Prefer: 'respond-async' });
  const m = (await poll(all.headers.get('content-location'), ehr.key)).data;
  assert.ok(!m.output.some(o => ['Organization', 'Location', 'HealthcareService'].includes(o.type)));
  assert.ok(m.output.some(o => o.type === 'DocumentReference'));
});

test('per-client rate limit answers 429 with Retry-After', async () => {
  const c = (await admin.post('/api/admin/fhir-clients', { name: 'Slow HIE', recipient: 'Slow HIE', scopes: ['system/Organization.read'], rate_limit: 2 })).data;
  assert.equal((await fhirGet('/fhir/R4/Organization', c.key)).status, 200);
  assert.equal((await fhirGet('/fhir/R4/Organization', c.key)).status, 200);
  const r = await fhirGet('/fhir/R4/Organization', c.key);
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60'); assert.equal(r.data.issue[0].code, 'throttled');
});

test('FHIR client administration: admins only, audited, keys shown once, revocation is immediate', async () => {
  assert.equal((await nav.get('/api/admin/fhir-clients')).status, 403);
  assert.equal((await nav.post('/api/admin/fhir-clients', { name: 'x', recipient: 'x', scopes: ['system/*.read'] })).status, 403);
  assert.equal((await nav.del(`/api/admin/fhir-clients/${ehr.id}`)).status, 403);
  const bad = await admin.post('/api/admin/fhir-clients', { name: 'x', recipient: 'x', scopes: ['system/Patient.write'] });
  assert.equal(bad.status, 400);
  assert.equal((await admin.post('/api/admin/fhir-clients', { name: 'x', recipient: 'x', scopes: [] })).status, 400);
  const c = await admin.post('/api/admin/fhir-clients', { name: 'HIE', recipient: 'Regional HIE', aliases: 'Regional Health Information Exchange', purpose: 'HOPERAT', scopes: ['system/Patient.read', 'system/Consent.read'] });
  assert.equal(c.status, 201);
  assert.match(c.data.key, /^sudsfhir_/);
  const list = await admin.get('/api/admin/fhir-clients');
  const row = list.data.clients.find(x => x.id === c.data.id);
  assert.deepEqual(row.scopes, ['system/Patient.read', 'system/Consent.read']);
  assert.equal(row.recipient, 'Regional HIE'); assert.equal(row.purpose, 'HOPERAT'); assert.deepEqual(row.aliases, ['Regional Health Information Exchange']);
  assert.ok(!JSON.stringify(list.data).includes(c.data.key), 'the key is never listed');
  assert.ok(!(await admin.get('/api/admin/api-keys')).data.keys.some(k => k.id === c.data.id), 'FHIR clients are not intake keys');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir_client.create' AND entity_id=?`, c.data.id));
  // An alias counts as the recipient; the purpose must match (operations here, and TPO covers it).
  const pid = await newClient('Hal', 'Alias'); consent(pid, { recipient: 'Regional Health Information Exchange', purpose: 'Health care operations' });
  assert.equal((await fhirGet(`/fhir/R4/Patient/${pid}`, c.data.key)).status, 200);
  assert.equal((await fhirGet(`/fhir/R4/Patient/${ids.consented}`, c.data.key)).status, 404, 'a consent naming another organisation does not cover this one');
  const tok = await (await fetch(base + '/fhir/R4/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=${c.data.id}&client_secret=${encodeURIComponent(c.data.key)}` })).json();
  assert.equal((await admin.del(`/api/admin/fhir-clients/${c.data.id}`)).status, 200);
  assert.equal((await fhirGet('/fhir/R4/Patient', c.data.key)).status, 401);
  assert.equal((await fhirGet('/fhir/R4/Patient', tok.access_token)).status, 401, 'tokens die with the client');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='fhir_client.revoke' AND entity_id=?`, c.data.id));
  assert.equal((await admin.del(`/api/admin/fhir-clients/${randomUUID()}`)).status, 404);
});

test('the local kernel leaves the FHIR API out', () => {
  const { ROUTE_MODULES, LOCAL_ROUTE_MODULES } = require('../server/app');
  assert.ok(ROUTE_MODULES.includes('fhir'));
  assert.ok(!LOCAL_ROUTE_MODULES.includes('fhir'));
});
