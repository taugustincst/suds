'use strict';
// SUDS as the Part 2 layer beside an EHR (1.17.0; docs/integration/EHR-PART2-LAYER.md): the part2_layer programme
// profile (EHR-like modules off, the FHIR API on), the Part 2 layer summary, FHIR R4 Provenance for each Consent the
// EHR may read, and patients and encounters imported from the EHR's FHIR export through the spreadsheet import's
// own preview and commit.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const H = require('./helpers');
const { encrypt } = require('../server/crypto');

let admin, nav, fin, adminId, base;
const RECIPIENT = 'Valley Health EHR';

before(async () => {
  base = await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  H.makeUser('pl_nav', 'navigator'); nav = H.client(); await nav.login('pl_nav', 'StaffPassw0rd!x');
  H.makeUser('pl_fin', 'finance'); fin = H.client(); await fin.login('pl_fin', 'StaffPassw0rd!x');
  adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
});
after(async () => { await H.stop(); });

test('the Part 2 compliance module profile: EHR-like modules off, the FHIR API on, every Part 2 control unchanged', async () => {
  assert.equal((await nav.put('/api/admin/settings', { programme_profile: 'part2_layer' })).status, 403);
  const r = await admin.put('/api/admin/settings', { programme_profile: 'part2_layer' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const me = (await nav.get('/api/auth/me')).data;
  assert.equal(me.programme.profile, 'part2_layer');
  assert.deepEqual(['careplan', 'assessments', 'caloms', 'fhir', 'handoff'].map(k => me.programme.modules[k]), [false, false, false, true, false]);
  const s = (await admin.get('/api/admin/settings')).data;
  assert.ok(s.programme.profiles.some(p => p.value === 'part2_layer' && /EHR/.test(p.label)));
  // A switched-off EHR-like module refuses new work, as in any profile.
  const c = (await nav.post('/api/clients', { first_name: 'Layer', last_name: 'Client', confirm_duplicate: true })).data.id;
  assert.equal((await nav.post(`/api/clients/${c}/problems`, { problem: 'x' })).status, 403);
  // An administrator can still switch one on.
  assert.equal((await admin.put('/api/admin/settings', { module_caloms: '1' })).status, 200);
  assert.equal((await nav.get('/api/auth/me')).data.programme.modules.caloms, true);
  await admin.put('/api/admin/settings', { module_caloms: '' });
});

test('the Part 2 layer summary: counts only, for who may read consents', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'Summary', last_name: 'Person', status: 'active', confirm_duplicate: true })).data.id;
  H.db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,signed_on_paper,redisclosure_notice_given,created_by,rule_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(), c, 'part2_disclosure', encrypt('Somewhere'), encrypt('Treatment'), encrypt('All'), '2026-01-01', new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), 1, 1, adminId, '2024');
  const r = await nav.get('/api/part2/layer');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.profile, 'part2_layer');
  assert.ok(r.data.consents.active >= 1 && r.data.consents.expiring_30d >= 1);
  assert.ok(r.data.notice.version && r.data.notice.short);
  assert.equal(r.data.incidents_open, null, 'a navigator does not hold the incident register: left out, not zero');
  assert.ok(r.data.patient_requests && typeof r.data.patient_requests.overdue === 'number');
  assert.ok(!JSON.stringify(r.data).includes('Summary'), 'no names');
  const a = await admin.get('/api/part2/layer');
  assert.equal(typeof a.data.incidents_open, 'number');
  assert.equal((await fin.get('/api/part2/layer')).status, 403);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='part2.layer'`));
});

test('FHIR Provenance: one per Consent the EHR may read, under the same consent coverage', async () => {
  const covered = (await admin.post('/api/clients', { first_name: 'Prov', last_name: 'Covered', confirm_duplicate: true })).data.id;
  const other = (await admin.post('/api/clients', { first_name: 'Prov', last_name: 'Other', confirm_duplicate: true })).data.id;
  const mk = (clientId, recipient) => { const id = randomUUID(); H.db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,signed_on_paper,redisclosure_notice_given,created_by,info_categories) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, clientId, 'part2_disclosure', encrypt(recipient), encrypt('Treatment and care coordination'), encrypt('All'), '2026-01-10', '2030-01-01', 1, 1, adminId, 'all'); return id; };
  const k1 = mk(covered, RECIPIENT); mk(other, 'Someone else entirely');
  const cl = await admin.post('/api/admin/fhir-clients', { name: 'Host EHR', recipient: RECIPIENT, purpose: 'TREAT', scopes: ['system/Consent.read', 'system/Provenance.read'] });
  assert.equal(cl.status, 201, JSON.stringify(cl.data));
  const tok = await (await fetch(base + '/fhir/R4/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=${cl.data.id}&client_secret=${encodeURIComponent(cl.data.key)}` })).json();
  const get = async (p) => { const r = await fetch(base + p, { headers: { Authorization: `Bearer ${tok.access_token}` } }); return { status: r.status, data: await r.json() }; };
  const cap = await (await fetch(base + '/fhir/R4/metadata')).json();
  assert.ok(JSON.stringify(cap).includes('"Provenance"'), 'the CapabilityStatement lists Provenance');
  const b = await get('/fhir/R4/Provenance');
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const provs = (b.data.entry || []).map(e => e.resource).filter(r => r.resourceType === 'Provenance');
  assert.deepEqual(provs.map(p => p.target[0].reference), [`Consent/${k1}`], 'only the consent that names this EHR');
  const p = provs[0];
  assert.equal(p.id, `consent-${k1}`); assert.ok(p.recorded);
  assert.ok(p.policy.some(u => /section-2\.32$/.test(u)), 'the §2.32 redisclosure rule governs it');
  assert.ok(p.meta.security && p.meta.security.length, 'labelled as Part 2');
  assert.equal((await get(`/fhir/R4/Provenance/consent-${k1}`)).status, 200);
  // Accounted like any FHIR disclosure.
  assert.ok(H.db.one(`SELECT 1 FROM disclosures WHERE client_id=? AND source='fhir'`, covered));
  assert.ok(!H.db.one(`SELECT 1 FROM disclosures WHERE client_id=? AND source='fhir'`, other));
});

const BUNDLE = {
  resourceType: 'Bundle', type: 'collection', entry: [
    { resource: { resourceType: 'Patient', id: 'ehr-p1', active: true, name: [{ use: 'official', family: 'Okafor', given: ['Adaeze'] }, { use: 'nickname', given: ['Ada'] }], birthDate: '1984-07-19', gender: 'female',
      telecom: [{ system: 'phone', value: '916-555-0177', use: 'mobile' }], address: [{ line: ['12 Elm St'], city: 'Sacramento', postalCode: '95814' }] } },
    { resource: { resourceType: 'Patient', id: 'ehr-p2', name: [{ family: 'Brennan', given: ['Liam'] }], birthDate: '1979-01-02', gender: 'male' } },
    { resource: { resourceType: 'Encounter', id: 'ehr-e1', status: 'finished', class: { code: 'AMB' }, type: [{ text: 'SUD intake assessment' }], subject: { reference: 'Patient/ehr-p1' }, period: { start: '2026-09-02T16:00:00Z', end: '2026-09-02T16:45:00Z' } } },
    { resource: { resourceType: 'Encounter', id: 'ehr-e2', status: 'finished', class: { code: 'VR' }, type: [{ text: 'Follow-up' }], subject: { reference: 'Patient/ehr-p2' }, period: { start: '2026-09-03T17:00:00Z' }, length: { value: 20, unit: 'min' } } },
    { resource: { resourceType: 'Encounter', id: 'ehr-e3', status: 'cancelled', subject: { reference: 'Patient/ehr-p2' }, period: { start: '2026-09-04T17:00:00Z' } } },
    { resource: { resourceType: 'Encounter', id: 'ehr-e4', status: 'finished', subject: { reference: 'Patient/not-in-file' }, period: { start: '2026-09-05T17:00:00Z' } } },
    { resource: { resourceType: 'Observation', id: 'ehr-o1', status: 'final' } },
  ] };

test('patients and encounters from the EHR\'s FHIR export go through the spreadsheet import\'s preview and commit', async () => {
  assert.equal((await fin.post('/api/imports/ehr/preview?entity=clients', { bundle: BUNDLE })).status, 403);
  assert.equal((await nav.post('/api/imports/ehr/preview?entity=notes', { bundle: BUNDLE })).status, 400);
  assert.equal((await nav.post('/api/imports/ehr/preview?entity=clients', { text: '{not json' })).status, 400);
  const pv = await nav.post('/api/imports/ehr/preview?entity=clients', { bundle: BUNDLE });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(pv.data.source, 'ehr_fhir'); assert.equal(pv.data.rows.length, 2); assert.equal(pv.data.valid, 2);
  const ada = pv.data.rows[0].record;
  assert.deepEqual([ada.first_name, ada.last_name, ada.preferred_name, ada.dob, ada.phone, ada.city, ada.zip], ['Adaeze', 'Okafor', 'Ada', '1984-07-19', '916-555-0177', 'Sacramento', '95814']);
  const commit = await nav.post('/api/imports/data/commit', { entity: 'clients', records: pv.data.rows.map(x => x.record), source: 'ehr_fhir' });
  assert.equal(commit.status, 200, JSON.stringify(commit.data)); assert.equal(commit.data.created, 2);
  assert.match(H.db.one(`SELECT details FROM audit_log WHERE action='import.data.commit' ORDER BY id DESC LIMIT 1`).details, /ehr_fhir/);
  // Encounters: the cancelled one did not happen; the one whose patient is not in the file cannot be matched.
  const ev = await nav.post('/api/imports/ehr/preview?entity=interventions', { text: BUNDLE.entry.map(e => JSON.stringify(e.resource)).join('\n') });
  assert.equal(ev.status, 200, JSON.stringify(ev.data));
  assert.equal(ev.data.rows.length, 3); assert.equal(ev.data.missing_patient, 1);
  const [e1, e2, e4] = ev.data.rows;
  assert.deepEqual(e1.errors, []); assert.equal(e1.record.type, 'intake'); assert.equal(e1.record.duration_minutes, 45);
  assert.deepEqual(e2.errors, []); assert.equal(e2.record.modality, 'video'); assert.equal(e2.record.duration_minutes, 20);
  assert.ok(e4.errors.length, 'no patient, no client');
  const ci = await nav.post('/api/imports/data/commit', { entity: 'interventions', records: [e1.record, e2.record], source: 'ehr_fhir' });
  assert.equal(ci.status, 200, JSON.stringify(ci.data)); assert.equal(ci.data.created, 2);
  // Importing the same export again doubles nothing.
  const again = await nav.post('/api/imports/data/commit', { entity: 'interventions', records: [e1.record, e2.record], source: 'ehr_fhir' });
  assert.equal(again.data.skipped_duplicates, 2);
  assert.ok((await nav.get('/api/part2/layer')).data.integration.last_ehr_import, 'the layer summary shows the last EHR import');
});
