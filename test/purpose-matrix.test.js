'use strict';
// The consent purpose rule (server/disclosure.js "purposes"; pen test of 1.23.6, M1, and the review of the 1.24.0
// tree): one reading of a consent's purpose and a disclosure's, shared by every path a disclosure takes. The review
// found it refused everyday flows -- a referral to a housing provider on a housing consent, a TPO consent for a
// discharge plan or a follow-up appointment -- because a referral counted only as treatment and a TPO consent covered
// only the three words. The table below is the rule; the API tests after it are the same cases at the doors.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

const TPO_TEXT = 'For treatment, payment, and health care operations';
const HOUSING_REF = 'Referral for housing services'; // a referral to a provider in the housing category (referralPurpose)

// [consent type, consent purpose, disclosure purpose, covered for a person's disclosure]
const MATRIX = [
  // A referral's purpose comes from what it is for; a consent for that covers it.
  ['part2_disclosure', 'Housing assistance', HOUSING_REF, true],
  ['part2_disclosure', 'Linkage to housing and benefits', HOUSING_REF, true],
  ['part2_disclosure', 'Case management', HOUSING_REF, true],
  ['part2_disclosure', 'Coordinate services', HOUSING_REF, true],
  ['part2_disclosure', 'Care coordination', HOUSING_REF, true],
  ['part2_disclosure', 'Service linkage', 'Referral for employment services', true],
  ['part2_disclosure', 'Case management', 'Referral for outpatient treatment', true],
  ['part2_disclosure', 'Housing assistance', 'Referral for outpatient treatment', false],
  ['part2_disclosure', 'Employment services', HOUSING_REF, false],
  // ...but a coordination consent never stands for a court, research, marketing, payment or operations.
  ['part2_disclosure', 'Case management', 'Referral for legal services', false],
  ['part2_disclosure', 'Case management', 'Court report', false],
  ['part2_disclosure', 'Case management', 'Billing coordination', false],
  ['part2_disclosure', 'Coordinate with probation officer', 'Referral for outpatient treatment', false],
  ['part2_disclosure', 'Coordinate with probation officer', 'Probation update', true],
  // The TPO consent covers whatever is not plainly outside TPO.
  ['part2_tpo', TPO_TEXT, 'Coordinate care with primary care doctor', true],
  ['part2_tpo', TPO_TEXT, 'Discharge planning', true],
  ['part2_tpo', TPO_TEXT, 'Medication management with prescriber', true],
  ['part2_tpo', TPO_TEXT, 'Follow-up appointment', true],
  ['part2_tpo', TPO_TEXT, 'Referral for outpatient treatment', true],
  ['part2_tpo', TPO_TEXT, 'Referral for services', true],
  ['part2_tpo', TPO_TEXT, 'Billing', true],
  ['part2_disclosure', 'TPO', 'Discharge planning', true],
  ['part2_disclosure', 'Treatment, payment and operations', 'Follow-up appointment', true],
  // ...and nothing on the non-TPO list without a consent that names it.
  ['part2_tpo', TPO_TEXT, HOUSING_REF, false],
  ['part2_tpo', TPO_TEXT, 'Employment verification', false],
  ['part2_tpo', TPO_TEXT, 'Court report', false],
  ['part2_tpo', TPO_TEXT, 'Probation update', false],
  ['part2_tpo', TPO_TEXT, 'Law enforcement request', false],
  ['part2_tpo', TPO_TEXT, 'School attendance letter', false],
  ['part2_tpo', TPO_TEXT, 'Benefits eligibility', false],
  ['part2_tpo', TPO_TEXT, 'Research study', false],
  ['part2_tpo', TPO_TEXT, 'Marketing', false],
  ['part2_tpo', TPO_TEXT, 'Media interview', false],
  ['part2_tpo', TPO_TEXT, 'Update to family member', false],
  ['part2_tpo', `${TPO_TEXT}, and housing applications`, HOUSING_REF, true],
  ['part2_tpo', TPO_TEXT, 'Family medicine physician visit', true], // treatment, though it says "family"
  // Payment and operations are named, and needed, as before.
  ['part2_disclosure', 'Billing and payment processing only', 'Referral for outpatient treatment', false], // pen test M1
  ['part2_disclosure', 'Billing and payment processing only', 'Referral for services', false],
  ['part2_disclosure', 'Billing and payment processing only', 'Treatment services', false],
  ['part2_disclosure', 'Billing and payment processing only', 'Coordination of care', false],
  ['part2_disclosure', 'Billing and payment processing only', 'Billing for the April visits', true],
  ['part2_disclosure', 'Referral and care coordination', 'Payment', false],
  ['part2_disclosure', 'Health care operations', 'Treatment', false],
  // The widened treatment words.
  ['part2_disclosure', 'Treatment', 'Coordinate care with primary care doctor', true],
  ['part2_disclosure', 'Treatment', 'Medication management with prescriber', true],
  ['part2_disclosure', 'Treatment', 'Counseling', true],
  ['part2_disclosure', 'Treatment', 'Recovery services', true],
  ['part2_disclosure', 'Treatment', 'Benefits counseling', false], // outside TPO: "counseling" does not make it treatment
  ['part2_disclosure', 'Medication management', 'Discharge planning', true],
  ['part2_disclosure', 'Follow-up with my PCP', 'Therapy referral', true],
  // A purpose the lists do not know is covered by a consent that says it.
  ['part2_disclosure', 'ID card application', 'Apply for an ID card', true],
  ['part2_disclosure', 'ID card application', 'Car registration', false],
  ['part2_disclosure', 'Housing application', 'Housing applications', true],
  ['part2_disclosure', 'Housing application', 'Court report', false],
  // At the patient's request: a person's disclosure only.
  ['part2_disclosure', 'At the request of the patient', 'Court report', true],
];

// [consent type, consent purpose, FHIR purpose of use, covered for the FHIR API]
const FHIR = [
  ['part2_tpo', TPO_TEXT, 'TREAT', true], ['part2_tpo', TPO_TEXT, 'HPAYMT', true], ['part2_tpo', TPO_TEXT, 'HOPERAT', true],
  ['part2_disclosure', 'Referral and care coordination', 'TREAT', true],
  ['part2_disclosure', 'Medication management with prescriber', 'TREAT', true], // plainly treatment
  ['part2_disclosure', 'Primary care physician', 'TREAT', true],
  // Never wider for the automated feed: everyday coordination words, a coordination consent, a patient's request.
  ['part2_disclosure', 'Case management', 'TREAT', false],
  ['part2_disclosure', 'Coordinate services', 'TREAT', false],
  ['part2_disclosure', 'Follow-up appointment', 'TREAT', false],
  ['part2_disclosure', 'Counseling', 'TREAT', false],
  ['part2_disclosure', 'Discharge', 'TREAT', false],
  ['part2_disclosure', 'At the request of the patient', 'TREAT', false],
  ['part2_disclosure', 'Benefits counseling', 'TREAT', false],
  ['part2_disclosure', 'Doctor letter for the court', 'TREAT', false], // a clinical word in a purpose outside TPO
  ['part2_disclosure', 'Referral to housing', 'TREAT', false], // a referral for housing is a housing purpose
  ['part2_disclosure', 'Billing and payment processing only', 'TREAT', false],
  ['part2_disclosure', 'Billing and payment processing only', 'HPAYMT', true],
  ['part2_disclosure', 'Treatment and housing', 'TREAT', true], // as before: it says treatment
];

let nav, sup, navId;
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
const DISC = { info_disclosed: 'Referral summary', disclosed_at: '2026-09-05T10:00:00Z' };
const iso = (ms = Date.now()) => new Date(ms).toISOString();
async function newClient() { const r = await nav.post('/api/clients', { first_name: 'Matrix', last_name: `Purpose${Math.random().toString(36).slice(2, 7)}`, status: 'active', confirm_duplicate: true }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function resource(name, category) { const r = await nav.post('/api/resources', { name, category }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function addConsent(clientId, recipient, purpose, type = 'part2_disclosure') { const r = await nav.post(`/api/clients/${clientId}/consents`, { type, recipient, purpose, ...ELEMENTS }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  navId = H.makeUser('pm_nav', 'navigator').id; H.makeUser('pm_sup', 'supervisor');
  nav = H.client(); await nav.login('pm_nav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('pm_sup', 'StaffPassw0rd!x');
});
after(H.stop);

test('the purpose matrix: what a consent covers for a person\'s disclosure', () => {
  const D = require('../server/disclosure');
  const wrong = MATRIX.filter(([type, consent, purpose, want]) => D.consentCoversPurpose({ type, purpose: consent }, purpose) !== want)
    .map(([type, consent, purpose, want]) => `${type} "${consent}" for "${purpose}": expected ${want}`);
  assert.deepEqual(wrong, []);
});

test('the purpose matrix for the FHIR API: the same reading, never wider for an automated feed', () => {
  const D = require('../server/disclosure');
  const wrong = FHIR.filter(([type, purpose, code, want]) => D.consentCovers({ type, recipient: 'Org', purpose }, { recipients: ['Org'], purposeOfUse: code }) !== want)
    .map(([type, purpose, code, want]) => `${type} "${purpose}" for ${code}: expected ${want}`);
  assert.deepEqual(wrong, []);
  // Where the FHIR API covers a purpose of use, a person's disclosure for it is covered too (the human paths are never stricter).
  for (const [type, purpose, code, want] of FHIR) {
    if (want && !/request of the patient/.test(purpose)) assert.equal(D.consentCoversPurpose({ type, purpose }, D.FHIR_PURPOSES[code].display), true, `${purpose} / ${code}`);
  }
});

test('a referral\'s purpose is what its provider is for', () => {
  const D = require('../server/disclosure');
  assert.equal(D.referralPurpose({ category: 'housing' }), HOUSING_REF);
  assert.equal(D.referralPurpose({ category: 'outpatient' }), 'Referral for outpatient treatment');
  assert.equal(D.referralPurpose({ category: 'other' }), 'Referral for services');
  assert.equal(D.referralPurpose(null), D.REFERRAL_PURPOSE);
  for (const cat of require('../server/constants').RESOURCE_CATEGORIES) assert.match(D.referralPurpose({ category: cat }), /^Referral for /, cat);
});

test('at the doors: a referral to Hope Housing on a housing, linkage, case-management or coordination consent goes; on a TPO consent it does not', async () => {
  const hope = await resource('Hope Housing', 'housing');
  for (const purpose of ['Housing assistance', 'Linkage to housing and benefits', 'Case management', 'Coordinate services']) {
    const c = await newClient(); const k = await addConsent(c, 'Hope Housing', purpose);
    const list = (await nav.get(`/api/clients/${c}/consents?resource_id=${hope}`)).data;
    assert.equal(list.consents.find(x => x.id === k).covers_referral, true, `${purpose}: the form offers it`);
    assert.equal(list.suggested_consent_id, k);
    const r = await nav.post('/api/referrals', { client_id: c, resource_id: hope, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, consent_id: k });
    assert.equal(r.status, 201, `${purpose}: ${JSON.stringify(r.data)}`);
    const acct = (await nav.get(`/api/clients/${c}/disclosures/accounting`)).data.disclosures.find(d => d.source === 'referral');
    assert.equal(acct.purpose, HOUSING_REF, 'the accounting says what the referral was for');
  }
  const c = await newClient(); const tpo = await addConsent(c, 'Hope Housing and my other treating providers', TPO_TEXT, 'part2_tpo');
  const r = await nav.post('/api/referrals', { client_id: c, resource_id: hope, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, consent_id: tpo });
  assert.equal(r.status, 409, JSON.stringify(r.data)); assert.equal(r.data.purposeNotCovered, true);
  assert.match(r.data.error, /Referral for housing services/);
});

test('at the doors: a TPO consent covers everyday care coordination disclosures', async () => {
  const c = await newClient(); const tpo = await addConsent(c, 'Riverbend Clinic', TPO_TEXT, 'part2_tpo');
  for (const purpose of ['Coordinate care with primary care doctor', 'Discharge planning', 'Medication management with prescriber', 'Follow-up appointment']) {
    const r = await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Riverbend Clinic', purpose, consent_id: tpo });
    assert.equal(r.status, 201, `${purpose}: ${JSON.stringify(r.data)}`);
  }
  for (const purpose of ['Court report', 'Housing application', 'Research study']) {
    const r = await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Riverbend Clinic', purpose, consent_id: tpo });
    assert.equal(r.status, 409, purpose); assert.equal(r.data.purposeNotCovered, true);
  }
});

test('a secure link whose consent no longer covers the referral\'s purpose is withheld, says purpose, and is not grandfathered', async () => {
  H.db.setSetting('referral_links_enabled', '1');
  const c = await newClient(); const hope = await resource('Hope Housing Links', 'housing');
  const housing = await addConsent(c, 'Hope Housing Links', 'Housing assistance');
  const ref = (await nav.post('/api/referrals', { client_id: c, resource_id: hope, referred_at: '2026-09-03T09:00:00Z', status: 'pending', warm_handoff: false })).data.id;
  const made = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: housing });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal((await nav.get(`/api/referrals/${ref}/links`)).data.rows[0].withheld, undefined, 'covered: nothing withheld');
  // A link made before this release on the client's TPO consent (which then covered "Referral for services"): the
  // purpose is checked again when it is opened, against what the referral is for.
  const tpo = await addConsent(c, 'Hope Housing Links and my other treating providers', TPO_TEXT, 'part2_tpo');
  H.db.run(`UPDATE referral_links SET consent_id=? WHERE id=?`, tpo, made.data.id);
  const listed = (await nav.get(`/api/referrals/${ref}/links`)).data.rows[0];
  assert.equal(listed.withheld, 'purpose_not_covered', 'the worker is told why, before the provider calls');
  const anon = H.client();
  const o = await anon.post('/api/referral-links/open', { token: made.data.path.split('#')[1], code: made.data.code });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  assert.equal(o.data.withheld, true); assert.equal(o.data.packet, undefined);
  const audit = JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='referral_link.open' AND entity_id=? AND success=0 ORDER BY id DESC LIMIT 1`, made.data.id).details);
  assert.equal(audit.reason, 'purpose_not_covered', 'the refusal says purpose, not consent_not_valid');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE client_id=? AND source='referral_link'`, c).n, 0, 'nothing went');
  RLflush();
});
const RLflush = () => require('../server/referral-links').flushRefusals();

test('a device\'s manual disclosure for a purpose its consent does not state is kept and flagged, not lost', async () => {
  const c = await newClient(); const k = await addConsent(c, 'County Billing Unit', 'Billing and payment processing only');
  const id = randomUUID();
  const row = { id, client_id: c, consent_id: k, recipient_enc: 'County Billing Unit', purpose_enc: 'Treatment services', what_enc: 'Referral summary', method: 'fax', disclosed_at: iso(), disclosed_by: navId, basis: 'consent', source: 'manual', created_at: iso() };
  const r = await nav.post('/api/sync/push', { device_now: iso(), tables: { disclosures: [row] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(!r.data.rejected.some(x => x.id === id));
  assert.ok(r.data.warnings.some(w => w.id === id && w.flagged), JSON.stringify(r.data.warnings));
  assert.ok(H.db.one(`SELECT 1 FROM disclosures WHERE id=?`, id), 'the accounting row is kept');
});
