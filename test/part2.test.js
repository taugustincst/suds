'use strict';
// 42 CFR Part 2 (2024 final rule): every control docs/compliance/PART2.md claims, as an API test — the
// §2.31 consent elements, the TPO / counseling-notes / proceedings consents and what each may and may not
// authorise, subpart E court orders, §2.32 notices on what leaves the programme, agreed restrictions, the
// §2.22 patient notice, the §2.4 complaint log and the breach/incident register.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, sup, nav, clin, fin, ro, clientId, resourceId, supId;
const ELEMENTS = { signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true, scope: 'Referral summary and MAT status', expires_at: '2099-01-01' };
const consent = (type, extra = {}) => ({ type, recipient: 'Riverbend OTP', purpose: 'MAT intake', signed_at: '2026-09-01', ...ELEMENTS, ...extra });
const DISC = { disclosed_to: 'Riverbend OTP', purpose: 'MAT intake', info_disclosed: 'Referral summary', disclosed_at: '2026-09-10T10:00:00Z' };
const ORDER = { order_type: 'noncriminal_2_64', court: 'Superior Court, Dept 4', case_ref: '26-FL-0042', issued_at: '2026-09-01', purpose: 'Custody hearing', scope: 'Attendance dates only', findings_recorded: true, notice_requirement_met: true };
const audited = (action, clientId) => !!H.db.one(`SELECT 1 FROM audit_log WHERE action=? ${clientId ? 'AND client_id=?' : ''}`, action, ...(clientId ? [clientId] : []));
async function newClient(first = 'Pat', last = 'Part2') { const r = await nav.post('/api/clients', { first_name: first, last_name: `${last}${Math.random().toString(36).slice(2, 7)}`, status: 'active', confirm_duplicate: true }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }

before(async () => {
  await H.start();
  H.makeUser('p2nav', 'navigator'); H.makeUser('p2sup', 'supervisor'); H.makeUser('p2clin', 'clinician'); H.makeUser('p2fin', 'finance'); H.makeUser('p2ro', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('p2sup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('p2nav', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('p2clin', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('p2fin', 'StaffPassw0rd!x');
  ro = H.client(); await ro.login('p2ro', 'StaffPassw0rd!x');
  supId = H.db.one(`SELECT id FROM users WHERE username='p2sup'`).id;
  clientId = await newClient('Cora');
  // The clinician works this client too, for the counseling-note tests.
  await sup.post(`/api/clients/${clientId}/assignments`, { user_id: H.db.one(`SELECT id FROM users WHERE username='p2clin'`).id, role_on_case: 'clinician', start_date: '2026-01-01' });
  resourceId = (await nav.post('/api/resources', { name: 'Riverbend OTP', category: 'mat_otp' })).data.id;
});
after(async () => { await H.stop(); });

test('§2.31: a Part 2 consent records every element, including the 2024 additions', async () => {
  const post = (b) => nav.post(`/api/clients/${clientId}/consents`, b);
  for (const k of ['revocation_right_given', 'refusal_consequences_given', 'redisclosure_notice_given', 'scope', 'recipient', 'purpose']) {
    const b = consent('part2_tpo'); delete b[k];
    const r = await post(b);
    assert.equal(r.status, 400, `missing ${k} is refused`); assert.ok(Array.isArray(r.data.missing), 'and the response lists what is missing');
  }
  // Signed by someone other than the patient: that person's name is required, and stored encrypted.
  assert.equal((await post(consent('part2_disclosure', { signer_relationship: 'parent_or_guardian' }))).status, 400);
  const byParent = await post(consent('part2_disclosure', { signer_relationship: 'parent_or_guardian', signer_name: 'Rosa Compliance' }));
  assert.equal(byParent.status, 201);
  const row = H.db.one(`SELECT * FROM consents WHERE id=?`, byParent.data.id);
  assert.match(row.signer_name_enc, /^v1:/); assert.equal(row.rule_version, '2024');
  assert.equal(row.discloser, 'County SUD Navigation Program', 'who may disclose defaults to this programme');
  assert.equal((await post(consent('part2_tpo', { expires_at: '2020-01-01' }))).status, 400, 'cannot expire before it was signed');
  // A legacy consent (recorded before migration 29) is listed as such.
  H.db.run(`UPDATE consents SET rule_version=NULL WHERE id=?`, byParent.data.id);
  const listed = (await nav.get(`/api/clients/${clientId}/consents`)).data;
  const legacy = listed.consents.find(c => c.id === byParent.data.id);
  assert.equal(legacy.legacy_elements, true); assert.equal(legacy.signer_name, 'Rosa Compliance'); assert.equal(legacy.signer_name_enc, undefined);
  assert.equal(listed.part2_program, true); assert.match(listed.notice.text, /42 CFR part 2/);
  // The printable consent carries every element and the §2.32 statement; producing it is audited.
  const pdf = await nav.get(`/api/consents/${byParent.data.id}/pdf`);
  assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.ok(String(pdf.data).includes('right to revoke') && String(pdf.data).includes('42 CFR'), 'elements and notice are on the page');
  assert.ok(audited('consent.print', clientId));
  assert.equal((await ro.get(`/api/consents/${byParent.data.id}/pdf`)).status, 403);
});

test('a disclosure is refused without a valid consent: missing, expired, revoked, or a general release', async () => {
  const c = await newClient();
  const post = (b) => nav.post(`/api/clients/${c}/disclosures`, { ...DISC, ...b });
  assert.equal((await post({})).status, 400, 'no consent');
  const expired = (await nav.post(`/api/clients/${c}/consents`, consent('part2_disclosure', { signed_at: '2024-01-01', expires_at: '2025-01-01' }))).data.id;
  assert.equal((await post({ consent_id: expired })).status, 400, 'expired');
  const live = (await nav.post(`/api/clients/${c}/consents`, consent('part2_tpo'))).data.id;
  await nav.post(`/api/consents/${live}/revoke`, { reason: 'client withdrew' });
  assert.equal((await post({ consent_id: live })).status, 400, 'revoked');
  const roi = (await nav.post(`/api/clients/${c}/consents`, { type: 'roi', recipient: 'Mother', purpose: 'Family contact', signed_at: '2026-09-01' })).data.id;
  const r = await post({ consent_id: roi });
  assert.equal(r.status, 400, 'a general ROI is not a Part 2 consent'); assert.match(r.data.error, /general release/);
  // Outside a Part 2 programme an ROI does authorise it (and no §2.32 notice is attached).
  await admin.put('/api/part2/settings', { part2_program: false });
  const ok = await post({ consent_id: roi });
  assert.equal(ok.status, 201); assert.equal(ok.data.notice, null);
  assert.equal(H.db.one(`SELECT notice_version FROM disclosures WHERE id=?`, ok.data.id).notice_version, null);
  await admin.put('/api/part2/settings', { part2_program: true });
  // A live Part 2 consent: recorded, with the 2024 notice version, and the notice handed back to attach.
  const tpo = (await nav.post(`/api/clients/${c}/consents`, consent('part2_tpo'))).data.id;
  const good = await post({ consent_id: tpo });
  assert.equal(good.status, 201); assert.match(good.data.notice.text, /A general authorization for the release/);
  assert.equal(H.db.one(`SELECT notice_version FROM disclosures WHERE id=?`, good.data.id).notice_version, '2024');
});

test('SUD counseling notes: only clinical notes, and only under a consent for counseling notes alone', async () => {
  assert.equal((await nav.post('/api/notes', { client_id: clientId, kind: 'admin', content: 'x', occurred_at: '2026-09-10T10:00:00Z', counseling_note: true })).status, 400, 'an admin note cannot be a counseling note');
  const n = await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Session analysis', occurred_at: '2026-09-10T10:00:00Z', counseling_note: true });
  assert.equal(n.status, 201);
  assert.equal(H.db.one(`SELECT counseling_note FROM notes WHERE id=?`, n.data.id).counseling_note, 1);
  assert.ok((await clin.get(`/api/notes?client_id=${clientId}`)).data.rows.find(x => x.id === n.data.id).counseling_note, 'the list says so');

  const tpo = (await nav.post(`/api/clients/${clientId}/consents`, consent('part2_tpo'))).data.id;
  const notesConsent = (await nav.post(`/api/clients/${clientId}/consents`, consent('part2_counseling_notes'))).data.id;
  const r1 = await nav.post(`/api/clients/${clientId}/disclosures`, { ...DISC, consent_id: tpo, counseling_notes: true });
  assert.equal(r1.status, 400, 'a TPO consent does not cover counseling notes'); assert.match(r1.data.error, /counseling notes/);
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, { ...DISC, basis: 'medical_emergency', justification: 'Unresponsive; ED asked for current dose', counseling_notes: true })).status, 400, 'nor does an emergency');
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, { ...DISC, consent_id: notesConsent })).status, 400, 'a counseling-notes consent covers nothing else');
  const ok = await nav.post(`/api/clients/${clientId}/disclosures`, { ...DISC, consent_id: notesConsent, counseling_notes: true });
  assert.equal(ok.status, 201);
  assert.equal(H.db.one(`SELECT counseling_notes FROM disclosures WHERE id=?`, ok.data.id).counseling_notes, 1);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='disclosure.record' AND entity_id=? AND details LIKE '%counseling_notes%'`, ok.data.id));
});

test('subpart E: a court order must be recorded and qualify; legal proceedings need one (or a proceedings-only consent)', async () => {
  const c = await newClient('Dana');
  // Permissions: supervisors record orders; front-line staff can read them; finance cannot.
  assert.equal((await nav.post(`/api/clients/${c}/court-orders`, ORDER)).status, 403);
  assert.equal((await fin.get(`/api/clients/${c}/court-orders`)).status, 403);
  assert.equal((await sup.post(`/api/clients/${c}/court-orders`, { ...ORDER, scope: undefined })).status, 400, 'the scope is required');
  const weak = await sup.post(`/api/clients/${c}/court-orders`, { ...ORDER, findings_recorded: false });
  assert.equal(weak.status, 201); assert.ok(weak.data.problems.length, 'recorded, but it says why it cannot be relied on');
  const good = await sup.post(`/api/clients/${c}/court-orders`, ORDER);
  assert.equal(good.status, 201); assert.deepEqual(good.data.problems, []);
  assert.match(H.db.one(`SELECT court_enc FROM court_orders WHERE id=?`, good.data.id).court_enc, /^v1:/, 'the court and case are encrypted');
  const list = await nav.get(`/api/clients/${c}/court-orders`);
  assert.equal(list.status, 200); assert.equal(list.data.rows.length, 2); assert.ok(audited('court_order.list', c));
  const one = await nav.get(`/api/court-orders/${good.data.id}`);
  assert.equal(one.status, 200); assert.equal(one.data.row.case_ref, '26-FL-0042'); assert.ok(audited('court_order.view', c));
  assert.ok((await nav.get(`/api/clients/${c}/consents`)).data.court_orders.length === 2, 'offered on the Consents tab');

  const post = (b) => nav.post(`/api/clients/${c}/disclosures`, { ...DISC, disclosed_to: 'Family court', ...b });
  assert.equal((await post({ basis: 'court_order' })).status, 400, 'naming the basis is not enough');
  assert.equal((await post({ basis: 'court_order', court_order_id: weak.data.id })).status, 400, 'an order without the findings does not qualify');
  // Another client's order cannot be borrowed.
  const other = await newClient('Eli');
  assert.equal((await nav.post(`/api/clients/${other}/disclosures`, { ...DISC, basis: 'court_order', court_order_id: good.data.id })).status, 400);
  const legal = { legal_proceeding: true };
  const tpo = (await nav.post(`/api/clients/${c}/consents`, consent('part2_tpo'))).data.id;
  const r = await post({ ...legal, consent_id: tpo });
  assert.equal(r.status, 400, 'a TPO consent cannot be used in a proceeding against the patient'); assert.match(r.data.error, /proceeding/);
  assert.equal((await post({ ...legal, basis: 'qsoa' })).status, 400, 'nor any exception other than an order');
  assert.equal((await post({ ...legal, basis: 'court_order', court_order_id: good.data.id, counseling_notes: true })).status, 400, 'the order does not cover counseling notes');
  const ok = await post({ ...legal, basis: 'court_order', court_order_id: good.data.id });
  assert.equal(ok.status, 201);
  const d = H.db.one(`SELECT * FROM disclosures WHERE id=?`, ok.data.id);
  assert.equal(d.court_order_id, good.data.id); assert.equal(d.legal_proceeding, 1);
  // A proceedings-only consent (§2.31(d)) works for the proceeding — and for nothing else.
  const pc = (await nav.post(`/api/clients/${c}/consents`, consent('part2_proceedings', { recipient: 'Family court', purpose: 'Custody hearing' }))).data.id;
  assert.equal((await post({ ...legal, consent_id: pc })).status, 201);
  assert.equal((await post({ consent_id: pc })).status, 400, 'cannot be combined with another purpose');
  // Vacated and expired orders stop working.
  assert.equal((await nav.post(`/api/court-orders/${good.data.id}/vacate`, { reason: 'Appeal' })).status, 403);
  assert.equal((await sup.post(`/api/court-orders/${good.data.id}/vacate`, {})).status, 400, 'a reason is required');
  assert.equal((await sup.post(`/api/court-orders/${good.data.id}/vacate`, { reason: 'Reversed on appeal' })).status, 200);
  assert.equal((await sup.post(`/api/court-orders/${good.data.id}/vacate`, { reason: 'again' })).status, 400);
  assert.equal((await post({ ...legal, basis: 'court_order', court_order_id: good.data.id })).status, 400, 'vacated');
  const old = (await sup.post(`/api/clients/${c}/court-orders`, { ...ORDER, issued_at: '2024-01-01', expires_at: '2025-01-01' })).data.id;
  assert.equal((await post({ ...legal, basis: 'court_order', court_order_id: old })).status, 400, 'expired');
  // A referral relying on a court order has to name it too.
  assert.equal((await sup.post('/api/referrals', { client_id: c, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, _disclosure_basis: 'court_order' })).status, 400);
});

test('an agreed restriction (§2.26) has to be checked before information is shared', async () => {
  const c = await newClient('Rhea');
  const tpo = (await nav.post(`/api/clients/${c}/consents`, consent('part2_tpo'))).data.id;
  const req = await nav.post('/api/patient-requests', { client_id: c, kind: 'restriction', received_at: '2026-09-01', notes: 'Do not tell the health plan about July visits' });
  await nav.put(`/api/patient-requests/${req.data.id}`, { status: 'fulfilled' });
  const r = await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, consent_id: tpo });
  assert.equal(r.status, 400); assert.equal(r.data.restrictionReview, true, 'the form is told to ask the worker to check');
  assert.equal((await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, consent_id: tpo, restriction_reviewed: true })).status, 201);
  // The same gate on a referral.
  const ref = { client_id: c, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', warm_handoff: true, consent_id: tpo };
  assert.equal((await nav.post('/api/referrals', ref)).data.restrictionReview, true);
  assert.equal((await nav.post('/api/referrals', { ...ref, _restriction_reviewed: true })).status, 201);
  assert.equal((await nav.get(`/api/clients/${c}/consents`)).data.restrictions, 1);
});

test('identified exports state a lawful basis, carry the §2.32 notice, and are refused for proceedings', async () => {
  const q = 'from=2026-01-01&to=2026-12-31&recipient=State%20auditor&purpose=SOR%20audit';
  assert.equal((await sup.get(`/api/reports/export/clients?identified=1&${q}`)).status, 400, 'no basis');
  assert.equal((await sup.get(`/api/reports/export/clients?identified=1&basis=other&${q}`)).status, 400, 'not an export basis');
  assert.equal((await sup.get(`/api/reports/export/clients?identified=1&basis=audit_evaluation&legal_proceeding=1&${q}`)).status, 400, 'a proceeding is never a bulk export');
  const noConsent = await sup.get(`/api/reports/export/clients?identified=1&basis=consent&${q}`);
  assert.equal(noConsent.status, 400); assert.ok(noConsent.data.clientsWithoutConsent > 0, 'says how many clients lack a consent');
  assert.ok(audited('report.export.refused'));
  const needsReview = await sup.get(`/api/reports/export/clients?identified=1&basis=audit_evaluation&${q}`);
  assert.equal(needsReview.status, 400, 'a client in the file has an agreed restriction'); assert.equal(needsReview.data.restrictionReview, true);
  const csv = await sup.get(`/api/reports/export/clients?identified=1&basis=audit_evaluation&restriction_reviewed=1&${q}`);
  assert.equal(csv.status, 200);
  const text = String(csv.data).replace(/^﻿/, '');
  assert.ok(text.split(/\r?\n/).filter(Boolean).pop().includes('42 CFR part 2 prohibits unauthorized use or disclosure'), 'the last row is the Part 2 notice');
  assert.ok(text.includes('A general authorization for the release'), 'in its 2024 wording');
  assert.match(csv.headers.get('x-suds-export'), /Basis: audit_evaluation\. 42 CFR part 2 prohibits/);
  assert.equal(H.db.one(`SELECT basis FROM disclosures WHERE source='export' ORDER BY created_at DESC LIMIT 1`).basis, 'audit_evaluation');
  const bearer = (await H.client().post('/api/auth/login', { username: 'p2sup', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token;
  const wb = await fetch(`${await H.start()}/api/reports/export/workbook?identified=1&basis=internal&restriction_reviewed=1&${q}`, { headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(wb.status, 200);
  const about = require('../server/spreadsheet').readWorkbook(Buffer.from(await wb.arrayBuffer())).find(s => s.name === 'About');
  assert.ok(JSON.stringify(about.rows).includes('Notice to recipient (42 CFR §2.32)'), 'the About sheet carries the notice');
  // De-identified exports are not Part 2 records and carry no notice.
  assert.ok(!String((await fin.get('/api/reports/export/clients?from=2026-01-01&to=2026-12-31')).data).includes('42 CFR part 2 prohibits'));
});

test('an identified export past the threshold opens a draft incident for review', async () => {
  await admin.put('/api/part2/settings', { mass_export_threshold: 2 });
  const q = 'from=2026-01-01&to=2026-12-31&recipient=County%20IT&purpose=Migration&basis=internal&restriction_reviewed=1';
  assert.equal((await sup.get(`/api/reports/export/clients?identified=1&${q}`)).status, 200);
  const inc = H.db.one(`SELECT * FROM privacy_incidents WHERE source='mass_export' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(inc, 'a draft incident was opened'); assert.equal(inc.determination, 'pending'); assert.match(inc.description_enc, /^v1:/);
  // The same export again the same day does not open a second one.
  await sup.get(`/api/reports/export/clients?identified=1&${q}`);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM privacy_incidents WHERE source='mass_export'`).n, 1);
  await admin.put('/api/part2/settings', { mass_export_threshold: 500 });
});

test('§2.22 patient notice: an editable template, a record per client, and a reminder for those without one', async () => {
  const s = await nav.get('/api/part2/settings');
  assert.equal(s.status, 200); assert.equal(s.data.part2_program, true); assert.equal(s.data.notice_template.is_default, true);
  assert.match(s.data.notice_template.text, /Secretary/); assert.match(s.data.notice_template.text, /not retaliate/);
  const rendered = (await nav.get('/api/part2/notice')).data.rendered;
  assert.ok(rendered.includes('County SUD Navigation Program') && !rendered.includes('{org}'), 'placeholders are filled in');
  assert.equal((await sup.put('/api/part2/settings', { notice_text: 'x'.repeat(300) })).status, 403, 'only an administrator edits it');
  assert.equal((await admin.put('/api/part2/settings', { notice_text: 'too short' })).status, 400);
  const v0 = s.data.notice_template.version;
  const saved = await admin.put('/api/part2/settings', { notice_text: `NOTICE OF PRIVACY PRACTICES — {org}. ${'Our county wording. '.repeat(15)}`, notice_effective_date: '2026-02-16' });
  assert.equal(saved.status, 200); assert.equal(saved.data.notice_template.is_default, false); assert.equal(saved.data.notice_template.version, String(Number(v0) + 1));
  assert.ok(audited('part2.settings.update'));

  const c = await newClient('Nina');
  const dash = async () => (await nav.get('/api/reports/dashboard')).data.part2_notice_missing;
  const before = await dash();
  assert.ok(before >= 1);
  const missing = await nav.get('/api/part2/notices/missing');
  assert.ok(missing.data.rows.some(r => r.id === c), 'the client is on the list'); assert.ok(audited('part2_notice.missing'));
  assert.equal((await ro.get('/api/part2/notices/missing')).status, 403);
  assert.equal((await nav.post(`/api/clients/${c}/part2-notices`, { given_at: '2099-01-01', method: 'in_person_paper' })).status, 400, 'not in the future');
  assert.equal((await nav.post(`/api/clients/${c}/part2-notices`, { given_at: '2026-09-01', method: 'in_person_paper', acknowledged: true, ack_refused: true })).status, 400);
  assert.equal((await ro.post(`/api/clients/${c}/part2-notices`, { given_at: '2026-09-01', method: 'mail' })).status, 403);
  const n = await nav.post(`/api/clients/${c}/part2-notices`, { given_at: '2026-09-01', method: 'in_person_paper', acknowledged: true, notes: 'Went through it with her' });
  assert.equal(n.status, 201);
  const row = H.db.one(`SELECT * FROM part2_notices WHERE id=?`, n.data.id);
  assert.equal(row.notice_version, saved.data.notice_template.version, 'the version given is recorded'); assert.match(row.notes_enc, /^v1:/);
  assert.equal(await dash(), before - 1);
  const client = (await nav.get(`/api/clients/${c}`)).data.client;
  assert.equal(client.part2.program, true); assert.equal(client.part2.notice.method, 'in_person_paper'); assert.equal(client.part2.notice.notes, 'Went through it with her');
  const list = await nav.get(`/api/clients/${c}/part2-notices`);
  assert.equal(list.data.rows.length, 1); assert.ok(audited('part2_notice.list', c)); assert.ok(audited('part2_notice.create', c));
  assert.equal((await admin.put('/api/part2/settings', { reset_notice: true })).data.notice_template.is_default, true, 'the built-in wording can be restored');
});

test('§2.4 complaints: supervisors keep the log, anonymous or named, closed with a resolution, never deleted', async () => {
  assert.equal((await nav.get('/api/complaints')).status, 403, 'front-line staff do not hold the log');
  assert.equal((await nav.post('/api/complaints', { received_at: '2026-09-01', summary: 'x' })).status, 403);
  assert.equal((await sup.post('/api/complaints', { received_at: '2026-09-01', complainant: 'anonymous', client_id: clientId, summary: 'Staff discussed a client in the lobby' })).status, 400, 'anonymous means no client');
  const anon = await sup.post('/api/complaints', { received_at: '2026-09-01', channel: 'phone', complainant: 'anonymous', summary: 'Staff discussed a client in the lobby', hhs_referral_given: true });
  assert.equal(anon.status, 201);
  assert.match(H.db.one(`SELECT summary_enc FROM complaints WHERE id=?`, anon.data.id).summary_enc, /^v1:/);
  const named = await sup.post('/api/complaints', { client_id: clientId, received_at: '2026-09-05', channel: 'in_person', summary: 'My information went to my employer' });
  assert.equal(named.status, 201);
  assert.equal((await sup.put(`/api/complaints/${named.data.id}`, { status: 'resolved' })).status, 400, 'closing needs a resolution');
  assert.equal((await sup.put(`/api/complaints/${named.data.id}`, { status: 'resolved', resolution: 'Retrained front desk; apology letter sent', retaliation_reviewed: true })).status, 200);
  const got = await sup.get(`/api/complaints/${named.data.id}`);
  assert.equal(got.data.row.resolution, 'Retrained front desk; apology letter sent'); assert.ok(got.data.row.resolved_at); assert.equal(got.data.row.client_code.length > 0, true);
  assert.equal((await admin.del(`/api/complaints/${named.data.id}`)).status, 403, 'a complaint is never deleted');
  const list = await sup.get('/api/complaints?status=all');
  assert.equal(list.data.rows.length, 2);
  const rep = await sup.get('/api/complaints/report?from=2026-01-01&to=2026-12-31');
  assert.equal(rep.status, 200); assert.equal(rep.data.total, 2); assert.equal(rep.data.hhs_referral_given, 1); assert.equal(rep.data.open, 1); assert.equal(rep.data.retaliation_reviewed, 1);
  assert.equal((await nav.get('/api/complaints/report')).status, 403);
  for (const a of ['complaint.create', 'complaint.update', 'complaint.view', 'complaint.list', 'complaint.report']) assert.ok(audited(a), a);
  assert.equal((await sup.get('/api/reports/dashboard')).data.complaints_open, 1);
  assert.equal((await nav.get('/api/reports/dashboard')).data.complaints_open, null);
  const opts = await nav.get('/api/meta/compliance-options');
  assert.ok(opts.data.channels.includes('phone') && opts.data.determinations.includes('not_breach'));
});

test('breach register: the 60-day clock, the four-factor assessment, notices before closing', async () => {
  assert.equal((await nav.get('/api/incidents')).status, 403);
  assert.equal((await nav.post('/api/incidents', { title: 'x', discovered_at: '2026-09-01' })).status, 403);
  assert.equal((await sup.post('/api/incidents', { title: 'Future', discovered_at: '2099-01-01' })).status, 400);
  const disc = new Date(Date.now() - 50 * 86400000).toISOString().slice(0, 10);
  const i = await sup.post('/api/incidents', { title: 'Laptop stolen from car', discovered_at: disc, description: 'Unencrypted spreadsheet of 12 clients', affected_count: 12 });
  assert.equal(i.status, 201);
  assert.equal(i.data.obligations.deadline, new Date(Date.parse(disc) + 60 * 86400000).toISOString().slice(0, 10), 'due 60 days after discovery');
  assert.equal(i.data.obligations.attention, true, 'a determination is owed');
  const dash = (await sup.get('/api/reports/dashboard')).data.incidents;
  assert.ok(dash.attention >= 1 && dash.due_soon >= 1, 'Home warns: ten days left');
  // "Not a breach" needs all four factors.
  const nb = await sup.put(`/api/incidents/${i.data.id}`, { determination: 'not_breach', determination_reason: 'Device was encrypted after all, verified by IT' });
  assert.equal(nb.status, 400); assert.equal(nb.data.missing.length, 4);
  assert.equal((await sup.put(`/api/incidents/${i.data.id}`, { determination: 'breach', determination_reason: 'short' })).status, 400, 'a reason is required');
  assert.equal((await sup.put(`/api/incidents/${i.data.id}`, { status: 'closed' })).status, 400, 'not closed while pending');
  const b = await sup.put(`/api/incidents/${i.data.id}`, { determination: 'breach', determination_reason: 'Unencrypted PHI of 12 clients, device not recovered', affected_count: 600, max_in_one_state: 600 });
  assert.equal(b.status, 200);
  assert.equal(b.data.obligations.hhs_route, 'contemporaneous', '500 or more: HHS within the 60 days');
  assert.equal(b.data.obligations.media.required, true, 'more than 500 in one state: media too');
  assert.equal(b.data.obligations.individuals.required, true);
  const close = await sup.put(`/api/incidents/${i.data.id}`, { status: 'closed' });
  assert.equal(close.status, 400); assert.equal(close.data.owed.length, 3);
  // Link the affected clients; the count never drops below the linked number.
  const c2 = await newClient('Ian');
  assert.equal((await sup.post(`/api/incidents/${i.data.id}/clients`, { client_ids: [clientId, c2] })).data.added, 2);
  assert.equal((await sup.post(`/api/incidents/${i.data.id}/clients`, { client_ids: ['nope'] })).status, 400);
  assert.equal((await sup.put(`/api/incidents/${i.data.id}/clients/${c2}`, { notified_at: disc })).status, 200);
  assert.equal((await sup.del(`/api/incidents/${i.data.id}/clients/${c2}`)).status, 200);
  assert.equal((await sup.del(`/api/incidents/${i.data.id}/clients/${c2}`)).status, 404);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await sup.put(`/api/incidents/${i.data.id}`, { individuals_notified_at: today, hhs_notified_at: today, media_notified_at: today })).status, 200);
  assert.equal((await sup.put(`/api/incidents/${i.data.id}`, { status: 'closed' })).status, 200);
  const full = await sup.get(`/api/incidents/${i.data.id}`);
  assert.equal(full.data.row.description, 'Unencrypted spreadsheet of 12 clients'); assert.equal(full.data.row.clients.length, 1); assert.ok(full.data.row.closed_at);
  assert.match(H.db.one(`SELECT description_enc FROM privacy_incidents WHERE id=?`, i.data.id).description_enc, /^v1:/);
  // Fewer than 500: the annual log, due 60 days after the end of the year of discovery.
  const small = await sup.post('/api/incidents', { title: 'Misdirected fax', discovered_at: '2026-03-02', affected_count: 1 });
  const d = await sup.put(`/api/incidents/${small.data.id}`, { determination: 'breach', determination_reason: 'Fax went to the wrong clinic; recipient not a covered entity' });
  assert.equal(d.data.obligations.hhs_route, 'annual_log'); assert.equal(d.data.obligations.hhs.due, '2027-03-01'); assert.equal(d.data.obligations.media.required, false);
  // A documented four-factor assessment can conclude "not a breach".
  const lowrisk = await sup.post('/api/incidents', { title: 'Email to wrong staff member', discovered_at: today });
  const ok = await sup.put(`/api/incidents/${lowrisk.data.id}`, { determination: 'not_breach', determination_reason: 'Internal recipient, deleted unread, attested in writing',
    risk_nature: 'Name and appointment date', risk_recipient: 'Program staff bound by Part 2', risk_acquired: 'Not opened (mail log)', risk_mitigation: 'Deleted; written attestation' });
  assert.equal(ok.status, 200); assert.equal(ok.data.obligations.attention, false);
  // The edit form sends every field: a cleared count is zero and a cleared title keeps the old one.
  assert.equal((await sup.put(`/api/incidents/${lowrisk.data.id}`, { affected_count: '', title: '' })).status, 200);
  const kept = H.db.one(`SELECT title, affected_count FROM privacy_incidents WHERE id=?`, lowrisk.data.id);
  assert.equal(kept.title, 'Email to wrong staff member'); assert.equal(kept.affected_count, 0);
  assert.ok((await sup.get('/api/incidents')).data.rows.length >= 3);
  for (const a of ['incident.create', 'incident.update', 'incident.view', 'incident.list', 'incident.client.link', 'incident.client.notified', 'incident.client.unlink']) assert.ok(audited(a), a);
  assert.equal((await nav.get('/api/reports/dashboard')).data.incidents, null);
});

test('the summary counts what needs a privacy officer, for those who hold the registers', async () => {
  assert.equal((await nav.get('/api/part2/summary')).status, 403);
  const s = await sup.get('/api/part2/summary');
  assert.equal(s.status, 200);
  for (const k of ['clients_missing_notice', 'consents_legacy_active', 'court_orders_active', 'complaints_open', 'incidents_open', 'counseling_notes']) assert.equal(typeof s.data[k], 'number', k);
  assert.ok(s.data.counseling_notes >= 1);
});

test('retention purges the Part 2 records with the client and keeps the complaint, unlinked', async () => {
  const c = await newClient('Purge');
  await nav.post(`/api/clients/${c}/part2-notices`, { given_at: '2026-09-01', method: 'mail' });
  const o = (await sup.post(`/api/clients/${c}/court-orders`, ORDER)).data.id;
  await nav.post(`/api/clients/${c}/disclosures`, { ...DISC, legal_proceeding: true, basis: 'court_order', court_order_id: o });
  const comp = (await sup.post('/api/complaints', { client_id: c, received_at: '2026-09-01', summary: 'About my record' })).data.id;
  const inc = (await sup.post('/api/incidents', { title: 'Link test', discovered_at: '2026-09-01' })).data.id;
  await sup.post(`/api/incidents/${inc}/clients`, { client_ids: [c] });
  const counts = require('../server/retention').purgeClient({ id: c, client_code: 'X' });
  assert.equal(counts.court_orders, 1); assert.equal(counts.part2_notices, 1); assert.equal(counts.privacy_incident_clients, 1);
  assert.equal(H.db.one(`SELECT client_id FROM complaints WHERE id=?`, comp).client_id, null, 'the complaint stays, unlinked');
  assert.ok(H.db.one(`SELECT 1 FROM privacy_incidents WHERE id=?`, inc), 'the incident stays');
});

test('reviewing an emergency access as a concern, and a broken audit chain, each open a draft incident', async () => {
  // Break-glass flagged at review.
  const reason = 'Client unresponsive in lobby, EMS asking about meds';
  const bg = await admin.get(`/api/notes?client_id=${clientId}&kind=clinical`, { 'X-Break-Glass-Reason': reason });
  assert.equal(bg.status, 200);
  const ev = H.db.one(`SELECT id FROM breakglass_events ORDER BY at DESC LIMIT 1`).id;
  assert.equal((await sup.post(`/api/supervision/breakglass/${ev}/ack`, { concern: true, note: 'x' })).status, 400, 'say what is wrong');
  const ack = await sup.post(`/api/supervision/breakglass/${ev}/ack`, { concern: true, note: 'No emergency was logged that day; the admin was curious' });
  assert.equal(ack.status, 200); assert.ok(ack.data.incident);
  const inc = H.db.one(`SELECT * FROM privacy_incidents WHERE id=?`, ack.data.incident);
  assert.equal(inc.source, 'breakglass'); assert.equal(inc.source_ref, ev);
  assert.ok(H.db.one(`SELECT 1 FROM privacy_incident_clients WHERE incident_id=? AND client_id=?`, inc.id, clientId), 'with the client linked');
  // A tampered audit log: the administrator's check fails and a draft incident appears (once).
  H.db.run(`UPDATE audit_log SET details='{"tampered":true}' WHERE id=(SELECT MIN(id)+5 FROM audit_log)`);
  const v = await admin.get('/api/admin/audit/verify');
  assert.equal(v.data.ok, false);
  await admin.get('/api/admin/audit/verify');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM privacy_incidents WHERE source='audit_chain' AND status='open'`).n, 1);
});
