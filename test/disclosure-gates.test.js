'use strict';
// The disclosure gate, closed where an independent review found it open (docs/compliance/PART2.md):
//   1. a consent covers only the recipient it names — for a referral, a manual disclosure, an identified
//      export and the county EHR hand-off, with the same name matching the FHIR API uses; a supervisor may
//      override with a written justification, which is audited and accounted;
//   2. the non-consent bases stand on something on file: a referral uses consent, a medical emergency, a
//      court order or "other"; a QSOA, research or audit/evaluation disclosure names a registered agreement
//      or approval whose organisation is the recipient; research, audit, crime-on-premises and child-abuse
//      disclosures are the supervisor's; an "internal" export stays inside the programme;
//   3. a consent that does not carry the §2.31 elements authorises nothing, however it arrived (a device's
//      push is refused; an incomplete or legacy row already in the database is re-checked at disclosure);
//   4. the incident register keeps its record of a purged client, its titles are encrypted, and switching
//      the Part 2 programme off is justified, audited, raised on Home and opens a draft incident.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { randomUUID } = require('node:crypto');

let admin, sup, nav, navId, supId, adminId;
const iso = (ms) => new Date(ms).toISOString();
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary and MAT status', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
const consent = (recipient, extra = {}) => ({ type: 'part2_disclosure', recipient, purpose: 'MAT intake', ...ELEMENTS, ...extra });
const DISC = { purpose: 'Referral', info_disclosed: 'Referral summary', disclosed_at: '2026-09-05T10:00:00Z' };
const JUST = 'The client asked in person on 2026-09-05; the signed request is scanned in the file.';
const audited = (action, entityId) => H.db.one(`SELECT details FROM audit_log WHERE action=? AND (entity_id=? OR ? IS NULL) ORDER BY id DESC LIMIT 1`, action, entityId || null, entityId || null)?.details;
async function newClient(extra = {}) { const r = await nav.post('/api/clients', { first_name: 'Gate', last_name: `Keeper${Math.random().toString(36).slice(2, 7)}`, status: 'active', ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function resource(name, organization) { const r = await nav.post('/api/resources', { name, category: 'outpatient', organization }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function addConsent(clientId, body) { const r = await nav.post(`/api/clients/${clientId}/consents`, body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
const referral = (clientId, resourceId, extra = {}) => ({ client_id: clientId, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, ...extra });

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  navId = H.makeUser('gnav', 'navigator').id; supId = H.makeUser('gsup', 'supervisor').id;
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('gsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('gnav', 'StaffPassw0rd!x');
  adminId = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
});
after(async () => { await H.stop(); });

// ---- 1. a consent is tied to its recipient ----
test('a referral under a consent must go to the recipient the consent names', async () => {
  const c = await newClient();
  const agencyA = await resource('Agency A'); const agencyB = await resource('Agency B');
  const k = await addConsent(c, consent('Agency A'));
  const wrong = await nav.post('/api/referrals', referral(c, agencyB, { consent_id: k }));
  assert.equal(wrong.status, 409, JSON.stringify(wrong.data));
  assert.match(wrong.data.error, /Agency A/, 'the refusal names the recipient the consent does cover');
  assert.equal(wrong.data.consentRecipient, 'Agency A');
  assert.ok(!H.db.one(`SELECT 1 FROM referrals WHERE client_id=? AND resource_id=?`, c, agencyB), 'nothing was saved');
  assert.equal((await nav.post('/api/referrals', referral(c, agencyA, { consent_id: k }))).status, 201, 'the named agency is fine');
  // The resource's organisation counts as its name (a clinic listed under its parent organisation).
  const clinic = await resource('Agency A — Eastside clinic', 'Agency A');
  assert.equal((await nav.post('/api/referrals', referral(c, clinic, { consent_id: k }))).status, 201);
  // A pending referral with no warm hand-off shares nothing, so the consent is not consulted yet — but
  // progressing it to the wrong agency is refused at that point.
  const pending = await nav.post('/api/referrals', referral(c, agencyB, { warm_handoff: false, status: 'pending', consent_id: k }));
  assert.equal(pending.status, 201);
  assert.equal((await nav.post(`/api/referrals/${pending.data.id}/outcome`, { status: 'admitted' })).status, 409);
});

test('a manual disclosure under a consent must name a recipient the consent covers', async () => {
  const c = await newClient();
  const k = await addConsent(c, consent('Agency A'));
  const r = await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Probation', consent_id: k });
  assert.equal(r.status, 409, JSON.stringify(r.data)); assert.match(r.data.error, /Agency A/);
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: '  agency   a ', consent_id: k })).status, 201, 'names are compared normalised');
  // "Agency A only" is not "Agency A": a named-recipient consent covers exactly the name it gives.
  const only = await addConsent(c, consent('Agency A only'));
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Agency B', consent_id: only })).status, 409);
  // A TPO consent covers an organisation it names, alone or within its class wording — never a bare class.
  const tpo = await addConsent(c, { type: 'part2_tpo', recipient: 'County Behavioral Health and my other treating providers', purpose: 'Treatment, payment and health care operations', ...ELEMENTS });
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'County Behavioral Health', consent_id: tpo })).status, 201);
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Probation', consent_id: tpo })).status, 409);
  const cls = await addConsent(c, { type: 'part2_tpo', recipient: 'My treating providers', purpose: 'Treatment, payment and health care operations', ...ELEMENTS });
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Riverbend OTP', consent_id: cls })).status, 409, 'a class with no name in it cannot be matched');
  // A registered alias of the organisation counts (the QSOA register's aliases, like a FHIR client's).
  await sup.post('/api/disclosure-agreements', { kind: 'qsoa', organisation: 'Regional Health Information Exchange', aliases: 'Regional HIE', services: 'Record exchange', agreement_date: '2026-01-01' });
  const hie = await addConsent(c, consent('Regional HIE'));
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Regional Health Information Exchange', consent_id: hie })).status, 201);
});

test('a supervisor may override the recipient check only with a written justification, audited and accounted', async () => {
  const c = await newClient();
  const k = await addConsent(c, consent('Agency A'));
  const body = { ...DISC, disclosed_to: 'Probation', consent_id: k, recipient_override: true };
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...body, justification: JUST })).status, 403, 'a navigator cannot override');
  assert.equal((await sup.post(`/api/clients/${c}/disclosures`, body)).status, 400, 'no justification');
  assert.equal((await sup.post(`/api/clients/${c}/disclosures`, { ...body, justification: 'short' })).status, 400, 'too short');
  const ok = await sup.post(`/api/clients/${c}/disclosures`, { ...body, justification: JUST });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const row = H.db.one(`SELECT * FROM disclosures WHERE id=?`, ok.data.id);
  assert.equal(row.consent_id, k); assert.match(row.justification_enc, /^v1:/);
  const acct = (await sup.get(`/api/clients/${c}/disclosures/accounting`)).data.disclosures.find(d => d.id === ok.data.id);
  assert.equal(acct.recipient, 'Probation'); assert.match(acct.justification, /Recipient override/); assert.match(acct.justification, /signed request/);
  assert.match(audited('disclosure.record', ok.data.id), /"recipient_override":true/);
  assert.doesNotMatch(audited('disclosure.record', ok.data.id), /Probation|signed request/, 'no recipient or justification text in the audit log');
  // The same for a referral.
  const agencyB = await resource('Agency B2');
  assert.equal((await nav.post('/api/referrals', referral(c, agencyB, { consent_id: k, _recipient_override: true, _disclosure_justification: JUST }))).status, 403);
  const ref = await sup.post('/api/referrals', referral(c, agencyB, { consent_id: k, _recipient_override: true, _disclosure_justification: JUST }));
  assert.equal(ref.status, 201, JSON.stringify(ref.data));
  assert.match(audited('disclosure.record', H.db.one(`SELECT id FROM disclosures WHERE source='referral' AND source_ref=?`, ref.data.id).id), /"recipient_override":true/);
});

test('an identified export under consent includes only clients whose consent names the stated recipient', async () => {
  const named = await newClient(); const other = await newClient(); const none = await newClient();
  for (const id of [named, other, none]) assert.equal((await nav.post('/api/interventions', { client_id: id, type: 'outreach', occurred_at: '2026-08-10T10:00:00Z', duration_minutes: 10 })).status, 201);
  await addConsent(named, consent('County auditor'));
  await addConsent(other, consent('Somebody else'));
  const code = (id) => H.db.one(`SELECT client_code FROM clients WHERE id=?`, id).client_code;
  const r = await sup.get('/api/reports/export/interventions?identified=1&basis=consent&recipient=County%20auditor&purpose=Audit&from=2026-08-01&to=2026-08-31');
  assert.equal(r.status, 200, String(r.data).slice(0, 300));
  const text = String(r.data);
  assert.ok(text.includes(code(named)), 'the covered client is in the file');
  assert.ok(!text.includes(code(other)) && !text.includes(code(none)), 'the others are left out');
  assert.deepEqual(r.headers.get('x-suds-export-excluded').split(',').sort(), [code(other), code(none)].sort(), 'and listed by code');
  assert.ok(H.db.one(`SELECT 1 FROM disclosures WHERE source='export' AND client_id=?`, named));
  assert.ok(!H.db.one(`SELECT 1 FROM disclosures WHERE source='export' AND client_id IN (?,?)`, other, none), 'only the included client is accounted');
});

test('the county EHR hand-off under consent leaves out clients whose consent names someone else', async () => {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const named = await newClient(); const other = await newClient();
  for (const id of [named, other]) assert.equal((await sup.post('/api/interventions', { client_id: id, type: 'case_management', occurred_at: `${day(-2)}T18:00:00.000Z`, duration_minutes: 30 })).status, 201);
  await addConsent(named, { type: 'part2_tpo', recipient: 'County EHR billing unit', purpose: 'Treatment, payment and health care operations', ...ELEMENTS, signed_at: day(-5) });
  await addConsent(other, { type: 'part2_tpo', recipient: 'Riverbend OTP', purpose: 'Treatment, payment and health care operations', ...ELEMENTS, signed_at: day(-5) });
  const code = (id) => H.db.one(`SELECT client_code FROM clients WHERE id=?`, id).client_code;
  const q = `from=${day(-7)}&to=${day(0)}`;
  const sum = await sup.get(`/api/handoff/summary?${q}&recipient=County%20EHR%20billing%20unit`);
  assert.ok(sum.data.without_consent.includes(code(other)) && !sum.data.without_consent.includes(code(named)), 'the summary checks the recipient too');
  const x = await sup.get(`/api/handoff/export?${q}&recipient=County%20EHR%20billing%20unit&purpose=Billing`);
  assert.equal(x.status, 200);
  assert.ok(x.headers.get('x-suds-handoff-excluded').split(',').includes(code(other)));
  assert.ok(!String(x.data).includes(code(other)) && String(x.data).includes(code(named)));
});

// ---- 2. the non-consent bases need something on file ----
test('a referral may rest only on consent, a medical emergency, a court order or "other"', async () => {
  const c = await newClient(); const res = await resource('Referral Basis Agency');
  for (const basis of ['research', 'qsoa', 'audit_evaluation', 'crime_on_premises', 'child_abuse_report']) {
    for (const who of [nav, sup]) {
      const r = await who.post('/api/referrals', referral(c, res, { _disclosure_basis: basis, _disclosure_justification: JUST }));
      assert.equal(r.status, 400, `${basis}: ${JSON.stringify(r.data)}`); assert.match(r.data.error, /referral/i);
    }
  }
  assert.equal((await nav.post('/api/referrals', referral(c, res, { _disclosure_basis: 'medical_emergency', _disclosure_justification: 'Overdose in the lobby; EMS took the client to Mercy ED.' }))).status, 201);
});

test('the QSOA / research / audit register: supervisors and administrators keep it, everyone who discloses reads it', async () => {
  const body = { kind: 'qsoa', organisation: 'Riverbend Lab Services', services: 'Toxicology testing', agreement_date: '2026-01-01', expires_at: '2099-01-01' };
  assert.equal((await nav.post('/api/disclosure-agreements', body)).status, 403);
  assert.equal((await sup.post('/api/disclosure-agreements', { ...body, organisation: '' })).status, 400);
  assert.equal((await sup.post('/api/disclosure-agreements', { ...body, expires_at: '2025-01-01' })).status, 400, 'cannot expire before it was made');
  assert.equal((await sup.post('/api/disclosure-agreements', { ...body, kind: 'research' })).status, 400, 'a research approval names the IRB or approving body');
  const r = await sup.post('/api/disclosure-agreements', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(audited('disclosure_agreement.create', r.data.id));
  const list = await nav.get('/api/disclosure-agreements');
  assert.equal(list.status, 200); assert.ok(list.data.rows.some(x => x.id === r.data.id && x.active));
  const ended = await sup.post('/api/disclosure-agreements', { ...body, organisation: 'Ended Lab' });
  assert.equal((await nav.post(`/api/disclosure-agreements/${ended.data.id}/end`, { reason: 'Contract ended' })).status, 403);
  assert.equal((await sup.post(`/api/disclosure-agreements/${ended.data.id}/end`, { reason: 'Contract ended' })).status, 200);
  assert.equal((await nav.get('/api/disclosure-agreements')).data.rows.find(x => x.id === ended.data.id).active, false);
});

test('a QSOA disclosure names a registered agreement whose organisation is the recipient', async () => {
  const c = await newClient();
  const qsoa = (await sup.post('/api/disclosure-agreements', { kind: 'qsoa', organisation: 'Valley Billing Services', aliases: 'VBS', services: 'Billing', agreement_date: '2026-01-01' })).data.id;
  const expired = (await sup.post('/api/disclosure-agreements', { kind: 'qsoa', organisation: 'Old Billing Co', services: 'Billing', agreement_date: '2024-01-01', expires_at: '2025-01-01' })).data.id;
  const research = (await sup.post('/api/disclosure-agreements', { kind: 'research', organisation: 'State University', services: 'Outcomes study', approving_body: 'State University IRB', reference: 'IRB-2026-14', agreement_date: '2026-01-01' })).data.id;
  const post = (who, b) => who.post(`/api/clients/${c}/disclosures`, { ...DISC, basis: 'qsoa', ...b });
  const none = await post(nav, { disclosed_to: 'Unregistered Billing Co' });
  assert.equal(none.status, 400, 'no agreement on file, no QSOA disclosure'); assert.match(none.data.error, /qualified service organi[sz]ation agreement/i);
  // With no agreement chosen, the live one with the recipient is found by name; an ended or expired one never is.
  const found = await post(nav, { disclosed_to: 'Valley Billing Services' });
  assert.equal(found.status, 201); assert.match(audited('disclosure.record', found.data.id), new RegExp(`"agreement_id":"${qsoa}"`));
  assert.equal((await post(nav, { disclosed_to: 'Old Billing Co' })).status, 400);
  assert.equal((await post(nav, { disclosed_to: 'Somebody Else', agreement_id: qsoa })).status, 409, 'the recipient must be the organisation the agreement is with');
  assert.equal((await post(nav, { disclosed_to: 'Old Billing Co', agreement_id: expired })).status, 400, 'an expired agreement');
  assert.equal((await post(nav, { disclosed_to: 'State University', agreement_id: research })).status, 400, 'a research approval is not a QSOA');
  const ok = await post(nav, { disclosed_to: 'VBS', agreement_id: qsoa });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.match(audited('disclosure.record', ok.data.id), new RegExp(`"agreement_id":"${qsoa}"`));
});

test('research and audit/evaluation disclosures need a registered approval and a supervisor; crime-on-premises and child-abuse reports need a supervisor and a justification', async () => {
  const c = await newClient();
  const irb = (await sup.post('/api/disclosure-agreements', { kind: 'research', organisation: 'State University', services: 'Outcomes study', approving_body: 'State University IRB', reference: 'IRB-2026-14', agreement_date: '2026-01-01', expires_at: '2099-01-01' })).data.id;
  const audit = (await sup.post('/api/disclosure-agreements', { kind: 'audit_evaluation', organisation: 'State auditor', services: 'SOR grant audit', approving_body: 'Department of Health Care Services', agreement_date: '2026-01-01' })).data.id;
  const post = (who, b) => who.post(`/api/clients/${c}/disclosures`, { ...DISC, ...b });
  assert.equal((await post(nav, { basis: 'research', disclosed_to: 'State University', agreement_id: irb })).status, 403, 'a navigator cannot disclose for research');
  assert.equal((await post(sup, { basis: 'research', disclosed_to: 'Private Research Firm' })).status, 400, 'no approval with this recipient on file');
  assert.equal((await post(sup, { basis: 'research', disclosed_to: 'State University', agreement_id: audit })).status, 400, 'an audit approval is not a research approval');
  assert.equal((await post(sup, { basis: 'research', disclosed_to: 'State University', agreement_id: irb })).status, 201);
  assert.equal((await post(nav, { basis: 'audit_evaluation', disclosed_to: 'State auditor', agreement_id: audit })).status, 403);
  assert.equal((await post(sup, { basis: 'audit_evaluation', disclosed_to: 'State auditor', agreement_id: audit })).status, 201);
  for (const basis of ['crime_on_premises', 'child_abuse_report']) {
    assert.equal((await post(nav, { basis, disclosed_to: 'Sheriff', justification: JUST })).status, 403, `${basis}: a navigator cannot`);
    assert.equal((await post(sup, { basis, disclosed_to: 'Sheriff' })).status, 400, `${basis}: needs a justification`);
    assert.equal((await post(sup, { basis, disclosed_to: 'Sheriff', justification: JUST })).status, 201, basis);
  }
});

test('identified exports: "internal" stays inside the programme; audit and research name their approval', async () => {
  const c = await newClient();
  await nav.post('/api/interventions', { client_id: c, type: 'outreach', occurred_at: '2026-07-10T10:00:00Z', duration_minutes: 10 });
  const q = 'identified=1&purpose=Review&from=2026-07-01&to=2026-07-31';
  const outside = await sup.get(`/api/reports/export/interventions?${q}&basis=internal&recipient=County%20auditor`);
  assert.equal(outside.status, 400, 'an outside recipient is not internal'); assert.match(outside.data.error, /internal/i);
  const org = H.db.getSetting('org_name');
  assert.equal((await sup.get(`/api/reports/export/interventions?${q}&basis=internal&recipient=${encodeURIComponent(org)}`)).status, 200, 'this programme');
  assert.equal((await sup.get(`/api/reports/export/interventions?${q}&basis=internal&recipient=gnav`)).status, 200, 'one of its staff');
  assert.equal((await sup.get(`/api/reports/export/interventions?${q}&basis=audit_evaluation&recipient=Export%20auditor`)).status, 400, 'no approval named');
  const a = (await sup.post('/api/disclosure-agreements', { kind: 'audit_evaluation', organisation: 'Export auditor', services: 'Audit', approving_body: 'County', agreement_date: '2026-01-01' })).data.id;
  assert.equal((await sup.get(`/api/reports/export/interventions?${q}&basis=audit_evaluation&recipient=Someone%20else&agreement_id=${a}`)).status, 409);
  assert.equal((await sup.get(`/api/reports/export/interventions?${q}&basis=audit_evaluation&recipient=Export%20auditor&agreement_id=${a}`)).status, 200);
  const q2 = (await sup.post('/api/disclosure-agreements', { kind: 'qsoa', organisation: 'Hand-off QSOA Org', services: 'Billing', agreement_date: '2026-01-01' })).data.id;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  assert.equal((await sup.get(`/api/handoff/export?from=${day(-7)}&to=${day(0)}&recipient=Unregistered%20Org&purpose=Billing&basis=qsoa`)).status, 400, 'a hand-off under a QSOA needs one with the recipient');
  assert.equal((await sup.get(`/api/handoff/export?from=${day(-7)}&to=${day(0)}&recipient=Hand-off%20QSOA%20Org&purpose=Billing&basis=qsoa&agreement_id=${q2}`)).status, 200);
});

// ---- 3. §2.31 elements, however the consent arrived ----
test('a pushed consent without the §2.31 elements is refused, and one already on file authorises nothing', async () => {
  const c = await newClient();
  const now = iso(Date.now());
  const bare = randomUUID();
  const r = await nav.post('/api/sync/push', { device_now: now, tables: { consents: [{ id: bare, client_id: c, type: 'part2_disclosure', recipient_enc: 'Anyone', signed_at: '2026-09-01', created_by: navId, rule_version: '2024', created_at: now, updated_at: now }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rej = r.data.rejected.find(x => x.id === bare);
  assert.ok(rej, 'the row is rejected'); assert.match(rej.reason, /is missing a required field/); assert.match(rej.reason, /purpose/); assert.equal(rej.permanent, true);
  assert.ok(!H.db.one(`SELECT 1 FROM consents WHERE id=?`, bare), 'and never lands');
  const full = randomUUID();
  const ok = await nav.post('/api/sync/push', { device_now: now, tables: { consents: [{ id: full, client_id: c, type: 'part2_disclosure', recipient_enc: 'Anyone', purpose_enc: 'Care', scope_enc: 'Summary', signed_at: '2026-09-01', expires_at: '2099-01-01', signed_on_paper: 1, discloser: 'This program', signer_relationship: 'patient', revocation_right_given: 1, redisclosure_notice_given: 1, refusal_consequences_given: 1, created_by: navId, rule_version: '2024', created_at: now, updated_at: now }] } });
  assert.equal(ok.data.applied.consents, 1, JSON.stringify(ok.data));
  // A treatment consent is not a Part 2 consent and needs none of it.
  const tx = randomUUID();
  assert.equal((await nav.post('/api/sync/push', { device_now: now, tables: { consents: [{ id: tx, client_id: c, type: 'treatment', signed_at: '2026-09-01', created_by: navId, created_at: now, updated_at: now }] } })).data.applied.consents, 1);
  // Rows that are already in the database (written before this check, or by hand) are re-checked when used.
  const insert = (cols) => { const id = randomUUID(); const row = { id, client_id: c, type: 'part2_disclosure', recipient_enc: require('../server/crypto').encrypt('Anyone'), purpose_enc: require('../server/crypto').encrypt('Care'), scope_enc: require('../server/crypto').encrypt('Summary'), signed_at: '2026-09-01', expires_at: '2099-01-01', signed_on_paper: 1, created_by: navId, ...cols }; const k = Object.keys(row); H.db.run(`INSERT INTO consents(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, ...k.map(x => row[x])); return id; };
  const disclose = (consentId) => nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Anyone', consent_id: consentId });
  const stamped = insert({ rule_version: '2024', discloser: 'This program', signer_relationship: 'patient' });
  const refused = await disclose(stamped);
  assert.equal(refused.status, 400, 'a 2024 consent missing the revocation, redisclosure and refusal statements'); assert.match(refused.data.error, /right to revoke/);
  assert.equal((await disclose(full)).status, 201, 'a complete consent still works');
  // Legacy (pre-2024 element list): allowed only with the pre-2024 elements, and only if signed before the
  // 2024 rule's compliance date (16 February 2026).
  assert.equal((await disclose(insert({ signed_at: '2025-06-01' }))).status, 201, 'a complete legacy consent');
  assert.equal((await disclose(insert({ signed_at: '2025-06-01', scope_enc: null }))).status, 400, 'a legacy consent with no scope');
  assert.equal((await disclose(insert({ signed_at: '2025-06-01', signed_on_paper: 0 }))).status, 400, 'a legacy consent with no evidence of signature');
  assert.equal((await disclose(insert({ signed_at: '2026-03-01' }))).status, 400, 'a consent signed after the compliance date must carry the 2024 elements');
});

test('the FHIR API applies the same element check: an incomplete consent covers nobody', async () => {
  const D = require('../server/disclosure'); const { encrypt } = require('../server/crypto');
  const c = await newClient();
  const id = randomUUID();
  H.db.run(`INSERT INTO consents(id,client_id,type,recipient_enc,purpose_enc,scope_enc,signed_at,expires_at,signed_on_paper,rule_version,discloser,signer_relationship,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, c, 'part2_disclosure', encrypt('Gate HIE'), encrypt('Treatment'), encrypt('Summary'), '2026-09-01', '2099-01-01', 1, '2024', 'This program', 'patient', navId);
  assert.ok(!D.fhirCoverage({ cacheKey: 'gate-a', recipients: ['Gate HIE'], purposeOfUse: 'TREAT' }).has(c), 'no revocation, redisclosure or refusal statements: not covered');
  H.db.run(`UPDATE consents SET revocation_right_given=1, redisclosure_notice_given=1, refusal_consequences_given=1, updated_at=? WHERE id=?`, new Date().toISOString(), id);
  assert.equal(D.fhirCoverage({ cacheKey: 'gate-a', recipients: ['Gate HIE'], purposeOfUse: 'TREAT' }).get(c), id, 'complete: covered');
});

test('a pushed court order is checked like one recorded at the office', async () => {
  const c = await newClient();
  const now = iso(Date.now());
  const row = (extra) => ({ id: randomUUID(), client_id: c, order_type: 'noncriminal_2_64', court_enc: 'Superior Court', issued_at: '2026-08-01', purpose_enc: 'Custody', scope_enc: 'Attendance', recorded_by: supId, created_at: now, updated_at: now, ...extra });
  const bad = [row({ purpose_enc: '' }), row({ scope_enc: null }), row({ court_enc: '' }), row({ expires_at: '2026-01-01' }), row({ order_type: 'subpoena' })];
  const good = row({});
  const r = await sup.post('/api/sync/push', { device_now: now, tables: { court_orders: [...bad, good] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const b of bad) assert.ok(r.data.rejected.some(x => x.id === b.id && x.permanent), `rejected: ${JSON.stringify(b)}`);
  assert.equal(r.data.applied.court_orders, 1);
});

// ---- 4. the incident register and the programme switch ----
test('the incident register keeps a purged client\'s link as a snapshot, and its titles are encrypted', async () => {
  const c = await newClient({ first_name: 'Purgeable', last_name: 'Person', status: 'closed' });
  const code = H.db.one(`SELECT client_code FROM clients WHERE id=?`, c);
  const inc = await sup.post('/api/incidents', { title: 'Misdirected fax', discovered_at: '2026-09-01' });
  assert.equal(inc.status, 201, JSON.stringify(inc.data));
  assert.equal((await sup.post(`/api/incidents/${inc.data.id}/clients`, { client_ids: [c] })).status, 200);
  const cols = H.db.all(`PRAGMA table_info(privacy_incidents)`).map(x => x.name);
  assert.ok(!cols.includes('title') && cols.includes('title_enc'), 'the title column is encrypted');
  assert.match(H.db.one(`SELECT title_enc FROM privacy_incidents WHERE id=?`, inc.data.id).title_enc, /^v1:/);
  assert.equal((await sup.get(`/api/incidents/${inc.data.id}`)).data.row.title, 'Misdirected fax');
  assert.ok((await sup.get('/api/incidents')).data.rows.some(x => x.title === 'Misdirected fax'));
  require('../server/retention').purgeClient({ id: c, client_code: code.client_code });
  assert.ok(!H.db.one(`SELECT 1 FROM clients WHERE id=?`, c), 'the client record is gone');
  const link = H.db.one(`SELECT * FROM privacy_incident_clients WHERE incident_id=?`, inc.data.id);
  assert.ok(link, 'the incident still records that a person was affected');
  assert.equal(link.client_id, null); assert.equal(link.client_code, code.client_code); assert.equal(require('../server/crypto').decrypt(link.client_name_enc), 'Purgeable Person', 'and whom it affected (encrypted)');
  assert.ok(link.client_purged_at, 'and when the record was purged');
  const view = (await sup.get(`/api/incidents/${inc.data.id}`)).data.row;
  assert.ok(view.clients.some(x => x.client_code === code.client_code && x.purged), 'the incident still lists them by code');
});

test('switching the Part 2 programme off needs a reason, is audited, raised on Home and opens a draft incident', async () => {
  const refused = await admin.put('/api/part2/settings', { part2_program: false });
  assert.equal(refused.status, 400); assert.match(refused.data.error, /reason/i);
  assert.equal((await admin.put('/api/part2/settings', { part2_program: false, part2_off_reason: 'short' })).status, 400);
  assert.equal(H.db.getSetting('part2_program', '1'), '1', 'still on');
  const off = await admin.put('/api/part2/settings', { part2_program: false, part2_off_reason: 'County counsel determined we are not a federally assisted Part 2 program (memo 2026-09-01).' });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.part2_program, false);
  assert.match(audited('part2.program.off'), /"reason_recorded":true/);
  const inc = H.db.one(`SELECT * FROM privacy_incidents WHERE source='part2_program_off' AND status='open'`);
  assert.ok(inc, 'a draft incident opened for review');
  assert.match(require('../server/crypto').decrypt(inc.description_enc), /County counsel determined/);
  const home = (await admin.get('/api/reports/dashboard')).data;
  assert.ok(home.part2_program_off && home.part2_program_off.since, 'administrators see it on Home');
  assert.equal((await nav.get('/api/reports/dashboard')).data.part2_program_off, null, 'others do not');
  assert.equal((await admin.put('/api/part2/settings', { part2_program: true })).status, 200, 'switching it back on needs no reason');
  assert.equal((await admin.get('/api/reports/dashboard')).data.part2_program_off, null);
});

test('a pushed result for a screening instrument the office has not enabled is refused (the DAST-10 until enabled)', async () => {
  // server/clinical.js lists optional instruments in OPTIONAL_INSTRUMENTS; a build that has none yet is given
  // the DAST-10's entry for this test, so the sync rule is exercised either way.
  const CL = require('../server/clinical');
  const had = CL.OPTIONAL_INSTRUMENTS;
  if (!had || !had.dast10) CL.OPTIONAL_INSTRUMENTS = { ...(had || {}), dast10: { setting: 'instrument_dast10_enabled' } };
  const setting = CL.OPTIONAL_INSTRUMENTS.dast10.setting;
  const before = H.db.getSetting(setting, null);
  try {
    H.db.setSetting(setting, '0');
    const c = await newClient();
    const now = iso(Date.now());
    const row = (instrument, n) => ({ id: randomUUID(), client_id: c, instrument, administered_at: '2026-09-10', administered_by: supId, responses_enc: JSON.stringify(Array(n).fill(0)), total_score: 0, created_at: now, updated_at: now });
    const dast = row('dast10', 10); const phq = row('phq9', 9);
    const r = await sup.post('/api/sync/push', { device_now: now, tables: { outcome_measures: [dast, phq] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const rej = r.data.rejected.find(x => x.id === dast.id);
    assert.ok(rej && rej.permanent, 'the DAST-10 result is refused for good, so the device shows it'); assert.match(rej.reason, /DAST-10 is not enabled/);
    assert.equal(r.data.applied.outcome_measures, 1, 'an instrument that needs no enabling still lands');
    H.db.setSetting(setting, '1');
    const again = await sup.post('/api/sync/push', { device_now: now, tables: { outcome_measures: [row('dast10', 10)] } });
    assert.equal(again.data.applied.outcome_measures, 1, 'once enabled, it is accepted');
  } finally {
    if (before === null) H.db.run(`DELETE FROM settings WHERE key=?`, setting); else H.db.setSetting(setting, before);
    CL.OPTIONAL_INSTRUMENTS = had;
  }
});
