'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, nav, nav2, clin, fin, clientId, clientId2, noteId, referralConsentId;
before(async () => {
  await H.start();
  // These tests sync like a device does, which needs local mode on (it is off by default on a server).
  require('../server/config').localModeEnabled = true;
  H.makeUser('nav1', 'navigator'); H.makeUser('nav2', 'navigator'); H.makeUser('clin1', 'clinician'); H.makeUser('fin1', 'finance'); H.makeUser('sup1', 'supervisor');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('nav1', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('nav2', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('clin1', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('fin1', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('unauthenticated requests are rejected', async () => {
  const c = H.client();
  assert.equal((await c.get('/api/clients')).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
});
test('CSRF header required for cookie sessions', async () => {
  const r = await nav.post('/api/clients', { first_name: 'A', last_name: 'B' }, { 'X-Requested-With': '' });
  assert.equal(r.status, 403);
});
test('account lockout after repeated failures', async () => {
  H.makeUser('locky', 'navigator');
  const c = H.client();
  for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { username: 'locky', password: 'bad' });
  const r = await c.post('/api/auth/login', { username: 'locky', password: 'StaffPassw0rd!x' });
  assert.equal(r.status, 423);
});
test('password policy enforced', async () => {
  const r = await nav.post('/api/auth/password', { current_password: 'StaffPassw0rd!x', new_password: 'short' });
  assert.equal(r.status, 400);
});

test('navigator creates client (auto-assigned) with encrypted PHI', async () => {
  const r = await nav.post('/api/clients', { first_name: 'Jane', last_name: "O'Brien", dob: '1990-05-01', phone: '(555) 010-0100', primary_substance: 'opioids_fentanyl', risk_level: 'high' });
  assert.equal(r.status, 201); clientId = r.data.id;
  assert.match(r.data.client_code, /^C\d{2}-0001$/);
  const raw = H.db.one(`SELECT * FROM clients WHERE id=?`, clientId);
  assert.ok(raw.first_name_enc.startsWith('v1:')); assert.ok(!raw.first_name_enc.includes('Jane'));
  const g = await nav.get(`/api/clients/${clientId}`);
  assert.equal(g.status, 200); assert.equal(g.data.client.first_name, 'Jane'); assert.equal(g.data.client.assignments.length, 1);
});
test('referral and engagement dates compute time-to-engagement', async () => {
  const r = await nav.post('/api/clients', { first_name: 'Ray', last_name: 'Engaged', referral_date: '2026-01-01', engagement_date: '2026-01-11' });
  assert.equal(r.status, 201);
  const g = await nav.get(`/api/clients/${r.data.id}`);
  assert.equal(g.data.client.referral_date, '2026-01-01'); assert.equal(g.data.client.engagement_date, '2026-01-11');
  assert.equal(g.data.client.days_to_engagement, 10);
  const list = await nav.get('/api/clients?status=all&q=Engaged');
  assert.equal(list.data.clients[0].days_to_engagement, 10);
  // missing either date leaves it uncomputed rather than guessed
  const r2 = await nav.post('/api/clients', { first_name: 'Ray', last_name: 'Unreferred', referral_date: '2026-01-01' });
  const g2 = await nav.get(`/api/clients/${r2.data.id}`);
  assert.equal(g2.data.client.days_to_engagement, null);
});
test('dashboard consents-expiring badge only counts active clients, matching the deep-linked list', async () => {
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const active = await nav.post('/api/clients', { first_name: 'Cara', last_name: 'Active', status: 'active' });
  const closed = await nav.post('/api/clients', { first_name: 'Cara', last_name: 'Closed', status: 'closed' });
  await nav.post(`/api/clients/${active.data.id}/consents`, { type: 'roi', signed_at: '2026-01-01', expires_at: soon });
  await nav.post(`/api/clients/${closed.data.id}/consents`, { type: 'roi', signed_at: '2026-01-01', expires_at: soon });
  const d = await nav.get('/api/reports/dashboard');
  const ids = d.data.consents_expiring.map(c => c.client_id);
  assert.ok(ids.includes(active.data.id), 'the active client with an expiring consent is counted');
  assert.ok(!ids.includes(closed.data.id), 'a closed client is not — #/clients?consent_expiring=1 filters to active, so counting it would show 1 on the badge and 0 in the list');
});
test('blind-index search by last name, phone, dob, code', async () => {
  for (const q of ['obrien', "O'Brien", '555-010-0100', '1990-05-01', 'C26-0001', 'jane obrien', "O'Brien, Jane"]) {
    const r = await nav.get(`/api/clients?q=${encodeURIComponent(q.replace('C26', 'C' + String(new Date().getFullYear()).slice(2)))}`);
    assert.equal(r.data.clients.length, 1, `search ${q}`);
  }
  assert.equal((await nav.get('/api/clients?q=smith')).data.clients.length, 0);
  // The search box says "a name"; a first name on its own used to find nobody at all.
  assert.equal((await nav.get('/api/clients?q=jane')).data.clients.length, 1, 'first name alone');
  assert.equal((await nav.get('/api/clients?q=Jan')).data.clients.length, 1, 'partial first name');
});
test('caseload restriction hides unassigned clients from other navigators', async () => {
  assert.equal((await nav2.get(`/api/clients/${clientId}`)).status, 403);
  assert.equal((await nav2.get('/api/clients')).data.clients.length, 0);
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  assert.equal((await s.get(`/api/clients/${clientId}`)).status, 200);
  // supervisor assigns nav2 as secondary
  const a = await s.post(`/api/clients/${clientId}/assignments`, { user_id: H.db.one(`SELECT id FROM users WHERE username='nav2'`).id, role_on_case: 'secondary' });
  assert.equal(a.status, 201);
  assert.equal((await nav2.get(`/api/clients/${clientId}`)).status, 200);
});
test('finance sees de-identified client list only', async () => {
  const r = await fin.get('/api/clients');
  assert.equal(r.status, 200);
  assert.equal(r.data.clients[0].first_name, undefined);
  assert.equal(r.data.clients[0].display_name, r.data.clients[0].client_code);
  assert.equal((await fin.get(`/api/clients/${clientId}`)).status, 403);
});

test('interventions with auto time entry and follow-up task', async () => {
  const r = await nav.post('/api/interventions', { client_id: clientId, type: 'naloxone_distribution', occurred_at: '2026-09-01T14:00:00Z', duration_minutes: 30, naloxone_kits: 2, log_time: true, follow_up_due: '2026-09-08' });
  assert.equal(r.status, 201);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM time_entries WHERE intervention_id=?`, r.data.id).n, 1);
  assert.equal(H.db.one(`SELECT naloxone_provided FROM clients WHERE id=?`, clientId).naloxone_provided, 1);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM tasks WHERE client_id=?`, clientId).n, 1);
  assert.equal((await nav.post('/api/interventions', { client_id: clientId, type: 'bogus', occurred_at: 'x' })).status, 400);
  const list = await nav.get(`/api/interventions?client_id=${clientId}`);
  assert.equal(list.data.rows[0].worker, 'nav1');
});
test('calls encrypt summary and phone', async () => {
  const r = await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-02T10:00:00Z', duration_minutes: 12, phone: '555-0100', summary: 'Confirmed appointment', outcome: 'reached' });
  assert.equal(r.status, 201);
  const raw = H.db.one(`SELECT * FROM calls WHERE id=?`, r.data.id);
  assert.ok(raw.summary_enc.startsWith('v1:'));
  const g = await nav.get(`/api/calls/${r.data.id}`);
  assert.equal(g.data.row.summary, 'Confirmed appointment'); assert.equal(g.data.row.summary_enc, undefined);
});
test('a text message is logged as a contact in its own right', async () => {
  const sent = await nav.post('/api/calls', { client_id: clientId, method: 'text', direction: 'outbound', started_at: '2026-09-02T11:00:00Z', duration_minutes: 1, phone: '555-0100', purpose: 'Appointment reminder', summary: 'Reminded about tomorrow at 9.' });
  assert.equal(sent.status, 201);
  const raw = H.db.one(`SELECT * FROM calls WHERE id=?`, sent.data.id);
  assert.equal(raw.method, 'text');
  assert.equal(raw.outcome, 'sent', 'a text with no outcome was simply sent — not "reached", which is a call word');
  assert.ok(raw.summary_enc.startsWith('v1:'), 'what was said is encrypted like any other PHI');
  assert.ok(!/Reminded about tomorrow/.test(JSON.stringify(H.db.all(`SELECT details FROM audit_log ORDER BY id DESC LIMIT 5`))), 'and never lands in the audit trail');

  // The two outcome lists do not overlap, and neither one may be borrowed for the other.
  assert.equal((await nav.post('/api/calls', { client_id: clientId, method: 'text', direction: 'outbound', started_at: '2026-09-02T11:05:00Z', outcome: 'voicemail' })).status, 400);
  assert.equal((await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-02T11:06:00Z', outcome: 'no_reply' })).status, 400);
  assert.equal((await nav.put(`/api/calls/${sent.data.id}`, { outcome: 'busy' })).status, 400, 'editing cannot smuggle in a call outcome either');
  assert.equal((await nav.put(`/api/calls/${sent.data.id}`, { outcome: 'replied' })).status, 200);

  // Filtering separates the two, and a default post is still a phone call.
  const call = await nav.post('/api/calls', { client_id: clientId, direction: 'outbound', started_at: '2026-09-02T11:10:00Z', outcome: 'voicemail' });
  assert.equal(H.db.one(`SELECT method FROM calls WHERE id=?`, call.data.id).method, 'phone');
  const texts = (await nav.get('/api/calls?method=text&limit=100')).data.rows;
  assert.ok(texts.length >= 1 && texts.every(x => x.method === 'text'), 'the text filter returns only texts');
  assert.ok((await nav.get('/api/calls?method=phone&limit=100')).data.rows.every(x => x.method === 'phone'));

  // A reply counts as having reached the client, so the "no contact in 30 days" list does not accuse
  // a worker of neglecting someone they are texting.
  const fresh = (await nav.post('/api/clients', { first_name: 'Texty', last_name: 'Client' })).data.id;
  await nav.post('/api/calls', { client_id: fresh, method: 'text', direction: 'inbound', started_at: new Date().toISOString(), outcome: 'replied', summary: 'On my way.' });
  const row = (await nav.get('/api/clients?limit=100&status=all')).data.clients.find(c => c.id === fresh);
  assert.ok(row.last_contact, 'the reply shows as the last contact');
  // and a text that got no reply does not
  const quiet = (await nav.post('/api/clients', { first_name: 'Quiet', last_name: 'Client' })).data.id;
  await nav.post('/api/calls', { client_id: quiet, method: 'text', direction: 'outbound', started_at: new Date().toISOString(), outcome: 'no_reply' });
  assert.ok(!(await nav.get('/api/clients?limit=100&status=all')).data.clients.find(c => c.id === quiet).last_contact, 'an unanswered text is not contact');
});

test('resources and referrals', async () => {
  const res = await nav.post('/api/resources', { name: 'County OTP', category: 'mat_otp', phone: '555-0199', accepts_medicaid: true });
  assert.equal(res.status, 201);
  // A warm handoff names the client to the receiving agency, so it is refused until a consent covers it.
  const noConsent = await nav.post('/api/referrals', { client_id: clientId, resource_id: res.data.id, referred_at: '2026-09-03T09:00:00Z', urgency: 'urgent', warm_handoff: true });
  assert.equal(noConsent.status, 400, 'a warm handoff without consent must be refused');
  assert.match(noConsent.data.error, /consent/i);
  const consent = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT referral', signed_at: '2026-09-01', scope: 'Referral summary and MAT status', expires_at: '2027-09-01', signed_on_paper: true, redisclosure_notice_given: true });
  assert.equal(consent.status, 201); referralConsentId = consent.data.id;
  const ref = await nav.post('/api/referrals', { client_id: clientId, resource_id: res.data.id, referred_at: '2026-09-03T09:00:00Z', urgency: 'urgent', warm_handoff: true, consent_id: referralConsentId });
  assert.equal(ref.status, 201);
  // Sharing the information wrote the disclosure record that HIPAA §164.528 requires.
  const disc = H.db.one(`SELECT * FROM disclosures WHERE source='referral' AND source_ref=?`, ref.data.id);
  assert.ok(disc, 'a referral that shares information records a disclosure');
  assert.equal(disc.consent_id, referralConsentId);
  assert.match(disc.recipient_enc, /^v1:/, 'the recipient is stored encrypted');
  // Closing the loop: a follow-up task exists even though the worker set no follow-up date.
  assert.ok(H.db.all(`SELECT title_enc FROM tasks WHERE client_id=?`, clientId).some(t => require('../server/crypto').decrypt(t.title_enc).startsWith('Follow up on referral')));
  const up = await nav.put(`/api/referrals/${ref.data.id}`, { status: 'admitted' });
  assert.equal(up.status, 200);
  assert.ok(H.db.one(`SELECT admitted_at FROM referrals WHERE id=?`, ref.data.id).admitted_at);
  assert.equal((await nav.post('/api/referrals', { client_id: clientId, resource_id: 'nope', referred_at: '2026-09-03T09:00:00Z' })).status, 400);
});

test('clinical notes: navigator cannot author or read; clinician can; signing locks; admin break-glass audited', async () => {
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  const clinId = H.db.one(`SELECT id FROM users WHERE username='clin1'`).id;
  await s.post(`/api/clients/${clientId}/assignments`, { user_id: clinId, role_on_case: 'clinician' });
  assert.equal((await nav.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'x', occurred_at: '2026-09-03T10:00:00Z' })).status, 403);
  const n = await clin.post('/api/notes', { client_id: clientId, kind: 'clinical', format: 'SOAP', content: 'S: reports cravings. O: alert. A: OUD severe. P: MAT referral.', structured: { S: 'reports cravings', O: 'alert', A: 'OUD severe', P: 'MAT referral' }, occurred_at: '2026-09-03T10:00:00Z' });
  assert.equal(n.status, 201); noteId = n.data.id;
  assert.equal((await nav.get(`/api/notes/${noteId}`)).status, 403);
  assert.equal((await clin.get(`/api/notes/${noteId}`)).data.note.structured.P, 'MAT referral');
  // admin cannot read without break-glass
  assert.equal((await admin.get(`/api/notes/${noteId}`)).status, 403);
  const bg = await admin.get(`/api/notes/${noteId}`, { 'X-Break-Glass-Reason': 'Compliance audit #42' });
  assert.equal(bg.status, 200);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='note.view.breakglass' AND entity_id=?`, noteId));
  // sign requires password; then locked
  assert.equal((await clin.post(`/api/notes/${noteId}/sign`, { password: 'wrong' })).status, 403);
  assert.equal((await clin.post(`/api/notes/${noteId}/sign`, { password: 'StaffPassw0rd!x' })).status, 200);
  assert.equal((await clin.put(`/api/notes/${noteId}`, { content: 'edited' })).status, 400);
  assert.equal((await clin.del(`/api/notes/${noteId}`)).status, 400);
  assert.equal((await clin.post(`/api/notes/${noteId}/addenda`, { content: 'Late entry: client called back.', reason: 'late entry' })).status, 201);
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, noteId).status, 'amended');
  const v = await clin.get(`/api/notes/${noteId}/verify`);
  assert.equal(v.data.intact, true);
  // admin notes are visible to navigator
  const an = await nav.post('/api/notes', { client_id: clientId, kind: 'admin', format: 'contact', content: 'Left voicemail.', occurred_at: '2026-09-04T10:00:00Z' });
  assert.equal(an.status, 201);
  const list = await nav.get(`/api/notes?client_id=${clientId}`);
  assert.equal(list.data.rows.length, 1); // clinical hidden from navigator
  assert.equal((await clin.get(`/api/notes?client_id=${clientId}`)).data.rows.length, 2);
});

test('consents and disclosure accounting (42 CFR Part 2)', async () => {
  assert.equal((await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', signed_at: '2026-09-01' })).status, 400);
  // Recipient and purpose alone are not a Part 2 consent (§2.31): scope, an expiry, evidence of signature and
  // the redisclosure notice are required too.
  assert.equal((await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'Treatment coordination', signed_at: '2026-09-01', expires_at: '2027-09-01' })).status, 400);
  const c = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'Treatment coordination', signed_at: '2026-09-01', scope: 'Referral summary and MAT status', expires_at: '2027-09-01', signed_on_paper: true, redisclosure_notice_given: true });
  assert.equal(c.status, 201);
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, { disclosed_to: 'County OTP', purpose: 'coordination', info_disclosed: 'referral summary', disclosed_at: '2026-09-03T10:00:00Z' })).status, 400);
  assert.equal((await nav.post(`/api/clients/${clientId}/disclosures`, { consent_id: c.data.id, disclosed_to: 'County OTP', purpose: 'coordination', info_disclosed: 'referral summary', disclosed_at: '2026-09-03T10:00:00Z' })).status, 201);
  const g = await nav.get(`/api/clients/${clientId}/consents`);
  // The earlier referral test also recorded a consent and a disclosure for this client.
  assert.ok(g.data.consents.some(x => x.purpose === 'Treatment coordination'), 'consent text round-trips through encryption');
  assert.ok(g.data.disclosures.some(x => x.what === 'referral summary'), 'disclosure text round-trips through encryption');
  assert.ok(g.data.consents.every(x => x.recipient_enc === undefined), 'ciphertext never reaches the client');
  // Revoking flags the referrals that relied on the consent instead of leaving them silently unsupported.
  const rev = await nav.post(`/api/consents/${referralConsentId}/revoke`, { reason: 'client withdrew' });
  assert.equal(rev.status, 200);
  assert.equal(rev.data.dependent_referrals, 1, 'the open referral under that consent is flagged');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM referrals WHERE consent_revoked=1`).n, 1);
  assert.equal((await nav.post(`/api/consents/${referralConsentId}/revoke`, {})).status, 400, 'revoking twice is refused');
});

test('budget: funds, lines, expenditures, separation of duties', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'Opioid Settlement FY26', source_type: 'opioid_settlement', fiscal_year_start: '2026-07-01', fiscal_year_end: '2027-06-30', total_amount: 100000 });
  assert.equal(f.status, 201);
  const l = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', allocated_amount: 20000 });
  assert.equal(l.status, 201);
  const e = await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, budget_line_id: l.data.id, client_id: clientId, spent_at: '2026-09-05', amount: 125.5, category: 'client_assistance', vendor: 'Bus pass', description: 'Transit for appointments' });
  assert.equal(e.status, 201);
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  const ap = await s.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' });
  assert.equal(ap.status, 200);
  const funds = await fin.get('/api/budget/funds');
  assert.equal(funds.data.funds[0].spent, 125.5); assert.equal(funds.data.funds[0].lines[0].spent, 125.5);
  assert.equal((await nav.get(`/api/clients/${clientId}`)).data.client.counts.spent, 125.5);
  // nav cannot approve
  assert.equal((await nav.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' })).status, 403);
});

test('expenditure approval is a state machine: one approver, no re-approval, overspend needs a forced supervisor approval', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'State machine fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  const line = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', allocated_amount: 100 });
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  const mk = async (amount) => (await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, budget_line_id: line.data.id, spent_at: '2026-09-05', amount, category: 'client_assistance' })).data.id;
  const a = await mk(80); const b = await mk(30); const c = await mk(15);
  // pending -> approved
  assert.equal((await s.post(`/api/budget/expenditures/${a}/approve`, { status: 'approved' })).status, 200);
  const supId = H.db.one(`SELECT id FROM users WHERE username='sup1'`).id;
  const first = H.db.one(`SELECT approved_by, approved_at FROM expenditures WHERE id=?`, a);
  assert.equal(first.approved_by, supId);
  // approved -> approved again: refused, and the first approver stays on the record
  const again = await admin.post(`/api/budget/expenditures/${a}/approve`, { status: 'approved' });
  assert.equal(again.status, 409); assert.equal(again.data.current_status, 'approved');
  assert.deepEqual(H.db.one(`SELECT approved_by, approved_at FROM expenditures WHERE id=?`, a), first, 'the first approval is untouched');
  assert.equal((await s.post(`/api/budget/expenditures/${a}/approve`, { status: 'rejected', note: 'changed my mind' })).status, 409, 'approved cannot become rejected');
  // pending -> reimbursed is not a thing
  assert.equal((await s.post(`/api/budget/expenditures/${c}/approve`, { status: 'reimbursed' })).status, 409);
  // Overspend: 80 of 100 is committed, 30 would take the line to -10
  const over = await fin.post(`/api/budget/expenditures/${b}/approve`, { status: 'approved' });
  assert.equal(over.status, 409, 'refused'); assert.equal(over.data.overspend, true); assert.equal(over.data.available, 20); assert.equal(over.data.over, 10); assert.equal(over.data.force_allowed, false, 'finance cannot force it');
  assert.equal((await fin.post(`/api/budget/expenditures/${b}/approve`, { status: 'approved', force: true, note: 'grant amended' })).status, 409, 'finance cannot force it even with a note');
  assert.equal((await s.post(`/api/budget/expenditures/${b}/approve`, { status: 'approved', force: true })).status, 409, 'a supervisor needs a note to force it');
  const forced = await s.post(`/api/budget/expenditures/${b}/approve`, { status: 'approved', force: true, note: 'Award amendment #2 raises this line; paperwork in the shared drive' });
  assert.equal(forced.status, 200);
  assert.equal(H.db.one(`SELECT status FROM expenditures WHERE id=?`, b).status, 'approved');
  assert.match(H.db.one(`SELECT details FROM audit_log WHERE action='expenditure.approved' AND entity_id=?`, b).details, /"forced":true/);
  // 15 within the line's (now negative) available is refused without force too
  assert.equal((await s.post(`/api/budget/expenditures/${c}/approve`, { status: 'approved' })).status, 409);
  // approved -> reimbursed keeps the approver; reimbursed is final
  assert.equal((await fin.post(`/api/budget/expenditures/${a}/approve`, { status: 'reimbursed' })).status, 200);
  const re = H.db.one(`SELECT status, approved_by FROM expenditures WHERE id=?`, a);
  assert.equal(re.status, 'reimbursed'); assert.equal(re.approved_by, supId, 'the person who reimbursed did not replace the approver');
  assert.equal((await s.post(`/api/budget/expenditures/${a}/approve`, { status: 'approved' })).status, 409);
  // rejected is final
  assert.equal((await s.post(`/api/budget/expenditures/${c}/approve`, { status: 'rejected', note: 'no receipt' })).status, 200);
  assert.equal((await s.post(`/api/budget/expenditures/${c}/approve`, { status: 'approved' })).status, 409);
});

test('money is kept to cents: amounts are rounded on write and sums on read', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'Cents fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  const line = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', allocated_amount: 1000 });
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  const ids = [];
  for (const amount of [25.009999, 0.1, 0.2, 10.1, 20.2]) {
    const e = await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, budget_line_id: line.data.id, spent_at: '2026-09-05', amount, category: 'client_assistance' });
    assert.equal(e.status, 201); ids.push(e.data.id);
    assert.equal((await s.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' })).status, 200);
  }
  assert.equal(H.db.one(`SELECT amount FROM expenditures WHERE id=?`, ids[0]).amount, 25.01, 'rounded to cents on write');
  const fund = (await fin.get('/api/budget/funds')).data.funds.find(x => x.id === f.data.id);
  assert.equal(fund.spent, 55.61); assert.equal(fund.lines[0].spent, 55.61); assert.equal(fund.remaining, 944.39); assert.equal(fund.lines[0].available, 944.39);
  const sum = (await fin.get('/api/budget/summary')).data;
  const cat = sum.by_category.find(x => x.category === 'client_assistance').amount;
  assert.equal(cat, Math.round(cat * 100) / 100, `by_category=${cat}`);
  assert.equal(sum.totals.spent, Math.round(sum.totals.spent * 100) / 100, `totals.spent=${sum.totals.spent}`);
  const dash = (await fin.get('/api/reports/dashboard')).data;
  assert.equal(dash.budget.spent, Math.round(dash.budget.spent * 100) / 100, `dashboard spent=${dash.budget.spent}`);
  const csv = String((await fin.get('/api/reports/export/expenditures?from=2026-01-01&to=2026-12-31')).data);
  assert.ok(csv.includes(',25.01,') && !csv.includes('25.009999'));
  // A visit cost is rounded the same way
  const iv = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-05T10:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 3.14159 });
  assert.equal(iv.status, 201);
  assert.equal(H.db.one(`SELECT amount FROM expenditures WHERE intervention_id=?`, iv.data.id).amount, 3.14);
});

test('fiscal-period checks use the organisation\'s calendar, not UTC', async () => {
  const config = require('../server/config');
  const was = config.orgTimezone;
  const f = await admin.post('/api/budget/funds', { name: 'FY26 Pacific', source_type: 'other', fiscal_year_start: '2025-07-01', fiscal_year_end: '2026-06-30', total_amount: 1000 });
  const line = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', allocated_amount: 1000 });
  // 9pm on June 30th in Sacramento is 04:00 UTC on July 1st.
  const body = { client_id: clientId, type: 'case_management', occurred_at: '2026-07-01T04:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 5 };
  try {
    config.orgTimezone = 'UTC';
    const utc = await nav.post('/api/interventions', body);
    assert.equal(utc.status, 400, 'in UTC that instant is July 1st, outside the period'); assert.match(utc.data.error, /outside the period/);
    config.orgTimezone = 'America/Los_Angeles';
    const pt = await nav.post('/api/interventions', body);
    assert.equal(pt.status, 201, JSON.stringify(pt.data));
    const exp = H.db.one(`SELECT spent_at FROM expenditures WHERE intervention_id=?`, pt.data.id);
    assert.equal(exp.spent_at, '2026-06-30', 'charged to the day it happened on');
    // An explicit service date wins over the timezone conversion
    config.orgTimezone = 'UTC';
    const explicit = await nav.post('/api/interventions', { ...body, service_date: '2026-06-30', log_time: true, duration_minutes: 30 });
    assert.equal(explicit.status, 201, JSON.stringify(explicit.data));
    assert.equal(H.db.one(`SELECT spent_at FROM expenditures WHERE intervention_id=?`, explicit.data.id).spent_at, '2026-06-30');
    assert.equal(H.db.one(`SELECT work_date FROM time_entries WHERE intervention_id=?`, explicit.data.id).work_date, '2026-06-30', 'the time entry lands on the same day');
    assert.equal(H.db.one(`SELECT 1 FROM pragma_table_info('interventions') WHERE name='service_date'`), undefined, 'service_date is an input, not a column');
  } finally { config.orgTimezone = was; }
});

test('deleting a visit puts the kits and strips it drew down back on the shelf', async () => {
  const kit = await nav.post('/api/supplies', { item: 'Naloxone kit', quantity: 10 });
  assert.ok([200, 201].includes(kit.status));
  const strips = await nav.post('/api/supplies', { item: 'Fentanyl test strips', quantity: 40 });
  assert.ok([200, 201].includes(strips.status));
  const iv = await nav.post('/api/interventions', { client_id: clientId, type: 'naloxone_distribution', occurred_at: '2026-09-06T10:00:00Z', naloxone_kits: 3, fentanyl_strips: 5 });
  assert.equal(iv.status, 201);
  const qty = () => Object.fromEntries((H.db.all(`SELECT item, quantity FROM supply_stock`)).map(r => [r.item.toLowerCase(), r.quantity]));
  assert.equal(qty()['naloxone kit'], 7); assert.equal(qty()['fentanyl test strips'], 35);
  assert.equal((await nav.del(`/api/interventions/${iv.data.id}`)).status, 200);
  assert.equal(qty()['naloxone kit'], 10, 'kits restored'); assert.equal(qty()['fentanyl test strips'], 40, 'strips restored');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='supply.restore' AND details LIKE '%' || ? || '%'`, iv.data.id).n, 2);
});

test('a navigator records expenses but cannot restructure grants; a rejection needs a reason', async () => {
  // Regression: budget:write covered both "log a bus pass for my client" and "change the total award on the
  // county's opioid settlement grant". The second is grant administration, now behind budget:manage.
  const f = await admin.post('/api/budget/funds', { name: 'Structure check', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 5000 });
  assert.equal((await nav.post('/api/budget/funds', { name: 'Nav-made fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1 })).status, 403);
  assert.equal((await nav.put(`/api/budget/funds/${f.data.id}`, { total_amount: 999999 })).status, 403, 'nor change the award');
  assert.equal((await nav.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', allocated_amount: 10 })).status, 403, 'nor add lines');
  const line = await fin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'client_assistance', allocated_amount: 1000 });
  assert.equal(line.status, 201, 'finance manages the structure');
  const e = await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, budget_line_id: line.data.id, client_id: clientId, spent_at: '2026-09-05', amount: 40, category: 'client_assistance', vendor: 'Transit' });
  assert.equal(e.status, 201, 'but a navigator still records client assistance');
  assert.equal((await nav.get('/api/auth/me')).data.user.permissions.includes('budget:manage'), false);
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  assert.equal((await s.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'rejected' })).status, 400, 'a rejection with no reason is refused');
  assert.equal((await s.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'rejected', note: 'No receipt attached' })).status, 200);
  const row = (await nav.get(`/api/budget/expenditures?client_id=${clientId}&limit=50`)).data.rows.find(x => x.id === e.data.id);
  assert.equal(row.status, 'rejected'); assert.equal(row.approval_note, 'No receipt attached', 'the submitter can see why');
});

test('budget: nested allocations roll up, and cannot be re-parented into a cycle or another fund', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'SOR Grant FY26', source_type: 'sor_grant', fiscal_year_start: '2026-07-01', fiscal_year_end: '2027-06-30', total_amount: 50000 });
  const other = await admin.post('/api/budget/funds', { name: 'Unrelated fund', source_type: 'other', fiscal_year_start: '2026-10-01', fiscal_year_end: '2027-09-30', total_amount: 1000 });
  // A grant broken into a program-level allocation, broken into two line items under it.
  const program = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'outreach_materials', label: 'Outreach program', allocated_amount: 20000 });
  assert.equal(program.status, 201);
  const item1 = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'naloxone_supplies', label: 'Naloxone kits', allocated_amount: 8000, parent_id: program.data.id });
  const item2 = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'outreach_materials', label: 'Printed materials', allocated_amount: 5000, parent_id: program.data.id });
  assert.equal(item1.status, 201); assert.equal(item2.status, 201);
  const e = await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, budget_line_id: item1.data.id, spent_at: '2026-09-05', amount: 300, category: 'naloxone_supplies', vendor: 'Pharmacy' });
  const sfin = H.client(); await sfin.login('sup1', 'StaffPassw0rd!x');
  assert.equal((await sfin.post(`/api/budget/expenditures/${e.data.id}/approve`, { status: 'approved' })).status, 200);

  const funds = await fin.get('/api/budget/funds');
  const fund = funds.data.funds.find(x => x.id === f.data.id);
  const top = fund.lines.find(l => l.id === program.data.id);
  assert.equal(top.children.length, 2, 'the two line items nest under the program allocation, not as flat peers');
  assert.equal(top.allocated_amount, 20000, "a parent line's own allocated_amount is unchanged by nesting");
  assert.equal(top.child_allocated, 13000, 'sum of the two sub-allocations');
  assert.equal(top.unallocated, 7000, 'the program envelope still has room for more sub-allocations');
  assert.equal(top.subtree_spent, 300, 'a leaf expenditure rolls up through its parent, since it is real money out of the same envelope');
  assert.equal(top.subtree_remaining, 19700, "the parent's own allocation minus spend anywhere under it");
  // What can still be spent directly against the parent: its envelope less what it handed down, less its own
  // spend. The UI used to show the parent as "$20,000 left" while $13,000 of that was already committed below.
  assert.equal(top.available, 7000, 'available to spend directly on the parent excludes its sub-allocations');
  assert.equal(top.children.find(l => l.id === item1.data.id).available, 7700, 'a leaf: allocation less its own spend');
  assert.equal(fund.allocated, 20000, 'a sub-allocation is carved out of its parent, not an additional draw on the fund total');

  // A budget line cannot be its own parent.
  const selfParent = await admin.put(`/api/budget/lines/${program.data.id}`, { parent_id: program.data.id });
  assert.equal(selfParent.status, 400);
  // Nor can a parent be re-nested under its own child — that would be a cycle.
  const cycle = await admin.put(`/api/budget/lines/${program.data.id}`, { parent_id: item1.data.id });
  assert.equal(cycle.status, 400);
  // Nor can an allocation move to a line in a different fund.
  const otherLine = await admin.post(`/api/budget/funds/${other.data.id}/lines`, { category: 'other', allocated_amount: 500 });
  const crossFund = await admin.put(`/api/budget/lines/${item1.data.id}`, { parent_id: otherLine.data.id });
  assert.equal(crossFund.status, 400);
  // Deleting the parent cascades to its sub-allocations (ON DELETE CASCADE).
  assert.equal((await admin.del(`/api/budget/lines/${program.data.id}`)).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM budget_lines WHERE id IN (?,?)`, item1.data.id, item2.data.id).n, 0);
});

test('a service rendered with a direct cost auto-posts a pending expenditure against its budget line', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'Client Assistance Fund', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 5000 });
  const line = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'transportation', label: 'Bus passes', allocated_amount: 1000 });

  // a cost with no budget line is refused, so the deduction always has somewhere specific to come from
  const noLine = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-05T10:00:00Z', funding_source_id: f.data.id, cost: 5 });
  assert.equal(noLine.status, 400);

  const iv = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-05T10:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 5, summary: 'Bus pass provided' });
  assert.equal(iv.status, 201);
  const auto = H.db.one(`SELECT * FROM expenditures WHERE intervention_id=?`, iv.data.id);
  assert.ok(auto, 'recording the service posted an expenditure');
  assert.equal(auto.amount, 5); assert.equal(auto.status, 'pending'); assert.equal(auto.category, 'transportation');

  const funds1 = await fin.get('/api/budget/funds');
  const line1 = funds1.data.funds.find(x => x.id === f.data.id).lines.find(l => l.id === line.data.id);
  assert.equal(line1.pending, 5, 'the fund page reflects it immediately, before anyone approves it');
  assert.equal(line1.spent, 0, 'but it is not counted as spent until approved — the approval workflow still applies');

  // editing the cost while still pending updates the same expenditure rather than creating a second one
  await nav.put(`/api/interventions/${iv.data.id}`, { cost: 8 });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM expenditures WHERE intervention_id=?`, iv.data.id).n, 1);
  assert.equal(H.db.one(`SELECT amount FROM expenditures WHERE intervention_id=?`, iv.data.id).amount, 8);

  // once approved, it is real spend and an edit to the service record must not silently rewrite it
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  assert.equal((await s.post(`/api/budget/expenditures/${auto.id}/approve`, { status: 'approved' })).status, 200);
  await nav.put(`/api/interventions/${iv.data.id}`, { cost: 500 });
  assert.equal(H.db.one(`SELECT amount, status FROM expenditures WHERE intervention_id=?`, iv.data.id).amount, 8, 'the approved expenditure keeps the amount that was actually approved');

  // deleting a service whose cost is still only pending takes the phantom expenditure with it
  const iv2 = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-06T10:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 12 });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM expenditures WHERE intervention_id=?`, iv2.data.id).n, 1);
  assert.equal((await nav.del(`/api/interventions/${iv2.data.id}`)).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM expenditures WHERE intervention_id=?`, iv2.data.id).n, 0, 'the pending expenditure it created is cleaned up too');

  // clearing the cost back to zero while still pending removes the auto-created expenditure
  const iv3 = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-07T10:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 20 });
  await nav.put(`/api/interventions/${iv3.data.id}`, { cost: 0 });
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM expenditures WHERE intervention_id=?`, iv3.data.id).n, 0);
});

test('a supervisor leaving "Worker (defaults to you)" blank logs the intervention as themselves', async () => {
  // Regression: the Worker picker is a blank-by-default field (unlike every other user picker in the app,
  // which either defaults its value or is required), and validate() turns that blank into an explicit null
  // rather than leaving the key out entirely — crud.js's auto-assign-to-self only checked for undefined,
  // so this 500'd for any supervisor/admin who did not explicitly pick themselves from the dropdown.
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  const supId = H.db.one(`SELECT id FROM users WHERE username='sup1'`).id;
  const r = await s.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-08T10:00:00Z', user_id: '' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(H.db.one(`SELECT user_id FROM interventions WHERE id=?`, r.data.id).user_id, supId);
});

test('a role with no budget permission cannot attach a cost to an intervention', async () => {
  // Regression: interventions:write alone let the funding_source_id/budget_line_id/cost fields through the
  // same route (they were only hidden client-side, per can('budget:read') in the form) -- a clinician,
  // who holds interventions:* but no budget permission at all, could otherwise post a real pending
  // expenditure against a fund it cannot even list.
  const f = await admin.post('/api/budget/funds', { name: 'Clinician escalation check', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  const line = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', allocated_amount: 500 });
  const r = await clin.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-09T10:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 50 });
  assert.equal(r.status, 403);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM expenditures WHERE funding_source_id=?`, f.data.id).n, 0, 'no expenditure was posted');
  // an ordinary edit that does not touch cost/fund/line is unaffected
  const plain = await clin.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-09T10:00:00Z' });
  assert.equal(plain.status, 201);
  assert.equal((await clin.put(`/api/interventions/${plain.data.id}`, { outcome: 'completed' })).status, 200);
});

test('a manual expenditure post cannot link itself to someone else\'s intervention', async () => {
  // Regression: intervention_id used to be an ordinary writable field on POST /api/budget/expenditures,
  // so a second expenditure could be attached to an intervention that already auto-posted one -- double-
  // counting its cost. It is no longer accepted from a request at all (only the auto-linking code sets it).
  const f = await admin.post('/api/budget/funds', { name: 'Double-link check', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 1000 });
  const line = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', allocated_amount: 500 });
  const iv = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-09-09T10:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 40 });
  const e = await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, budget_line_id: line.data.id, spent_at: '2026-09-09', amount: 40, category: 'other', intervention_id: iv.data.id });
  assert.equal(e.status, 201);
  assert.equal(H.db.one(`SELECT intervention_id FROM expenditures WHERE id=?`, e.data.id).intervention_id, null, 'the field was silently ignored, not honored');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM expenditures WHERE intervention_id=?`, iv.data.id).n, 1, 'the intervention still has exactly its one auto-posted expenditure');
});

test('a worker cannot reassign their own time entry to someone else', async () => {
  // Regression: beforeInsert forced user_id back to the caller when they lack time:all, but there was no
  // equivalent beforeUpdate -- a worker who owns the row (canEdit only checks row.user_id === ctx.user.id)
  // could still overwrite user_id on an update, reattributing their hours to an arbitrary other employee.
  const t = await nav.post('/api/time', { work_date: '2026-09-05', minutes: 30, category: 'documentation' });
  assert.equal(t.status, 201);
  const navId = H.db.one(`SELECT id FROM users WHERE username='nav1'`).id;
  const clinId = H.db.one(`SELECT id FROM users WHERE username='clin1'`).id;
  const upd = await nav.put(`/api/time/${t.data.id}`, { user_id: clinId, minutes: 60 });
  assert.equal(upd.status, 200, 'the update itself succeeds -- only the ownership field is refused');
  const row = H.db.one(`SELECT user_id, minutes FROM time_entries WHERE id=?`, t.data.id);
  assert.equal(row.user_id, navId, 'user_id stayed the entry owner, not the attempted reassignment');
  assert.equal(row.minutes, 60, 'an ordinary field on the same request still went through');
});

test('deleting a budget line with sub-allocations tombstones and audit-logs every one of them', async () => {
  // Regression: budget_lines.parent_id is ON DELETE CASCADE, so SQLite silently deletes descendants when
  // the parent line is deleted -- no application code runs for them. Only the named line got a tombstone
  // (leaving other devices permanently showing the deleted children) and only one audit entry (undercounting
  // what was actually removed, however large the destroyed sub-tree).
  const f = await admin.post('/api/budget/funds', { name: 'Cascade delete check', source_type: 'other', fiscal_year_start: '2026-01-01', fiscal_year_end: '2026-12-31', total_amount: 5000 });
  const parent = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', allocated_amount: 1000 });
  const child = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', allocated_amount: 400, parent_id: parent.data.id });
  const grandchild = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', allocated_amount: 100, parent_id: child.data.id });
  const del = await admin.del(`/api/budget/lines/${parent.data.id}`);
  assert.equal(del.status, 200);
  for (const id of [parent.data.id, child.data.id, grandchild.data.id]) {
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM budget_lines WHERE id=?`, id).n, 0, 'row is actually gone');
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM tombstones WHERE table_name='budget_lines' AND id=?`, id).n, 1, 'each descendant got its own tombstone, not just the named line');
    assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='budget_line.delete' AND entity_id=?`, id).n, 1, 'each descendant got its own audit entry');
  }
});

test('a brand-new account can get as far as the change-password page', async () => {
  // Regression: an account that must change its password was refused /api/meta/constants and /api/me/prefs
  // too, so the app shell could not load and the person was bounced back to the sign-in form for ever.
  const u = await admin.post('/api/users', { username: 'newhire1', display_name: 'New Hire', role: 'navigator' });
  assert.equal(u.status, 201); assert.ok(u.data.temporary_password);
  const c = H.client(); await c.login('newhire1', u.data.temporary_password);
  assert.equal((await c.get('/api/auth/me')).data.user.must_change_password, true);
  assert.equal((await c.get('/api/meta/constants')).status, 200, 'reference data loads');
  assert.equal((await c.get('/api/me/prefs')).status, 200, 'preferences load');
  assert.equal((await c.get('/api/clients')).status, 403, 'but nothing else does');
  assert.equal((await c.post('/api/tasks', { title: 'x' })).status, 403);
  assert.equal((await c.post('/api/auth/password', { current_password: u.data.temporary_password, new_password: 'Brand-New-Passw0rd!' })).status, 200);
  assert.equal((await c.get('/api/clients')).status, 200, 'and everything opens once it is changed');
});

test('only failed sign-ins count against an address', async () => {
  // Regression: twenty successful sign-ins from one address (an office behind one router) locked everyone out.
  const config = require('../server/config'); const was = config.loginRateLimit; config.loginRateLimit = 3;
  require('../server/app').rateLimitReset('login:127.0.0.1'); // earlier tests in this file fail sign-ins on purpose
  try {
    for (let i = 0; i < 5; i++) assert.equal((await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' })).status, 200, `sign-in ${i + 1} is fine`);
    for (let i = 0; i < 3; i++) assert.equal((await H.client().post('/api/auth/login', { username: 'nav1', password: 'wrong-' + i })).status, 401);
    assert.equal((await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' })).status, 429, 'three failures and the address is limited');
  } finally { config.loginRateLimit = was; require('../server/app').rateLimitReset('login:127.0.0.1'); }
});

test('money and hours cannot be charged to a fund outside its period, or in the future', async () => {
  const f = await admin.post('/api/budget/funds', { name: 'FY27 period check', source_type: 'other', fiscal_year_start: '2026-07-01', fiscal_year_end: '2027-06-30', total_amount: 1000 });
  const line = await admin.post(`/api/budget/funds/${f.data.id}/lines`, { category: 'other', allocated_amount: 500 });
  const early = await nav.post('/api/time', { work_date: '2026-01-15', minutes: 60, category: 'documentation', funding_source_id: f.data.id });
  assert.equal(early.status, 400); assert.match(early.data.error, /outside the period/);
  const future = await nav.post('/api/time', { work_date: '2099-01-01', minutes: 60, category: 'documentation' });
  assert.equal(future.status, 400); assert.match(future.data.error, /future/);
  assert.equal((await nav.post('/api/time', { work_date: '2026-09-01', minutes: 60, category: 'documentation', funding_source_id: f.data.id })).status, 201, 'inside the period is fine');
  const e = await nav.post('/api/budget/expenditures', { funding_source_id: f.data.id, budget_line_id: line.data.id, spent_at: '2026-02-01', amount: 10, category: 'other' });
  assert.equal(e.status, 400); assert.match(e.data.error, /outside the period/);
  const iv = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: '2026-03-03T10:00:00Z', funding_source_id: f.data.id, budget_line_id: line.data.id, cost: 5 });
  assert.equal(iv.status, 400, 'a service with a cost is checked the same way');
});

test('an overdose event cannot be recorded with nothing on it', async () => {
  const r = await nav.post('/api/overdose-events', { occurred_at: '2026-09-01T10:00:00Z' });
  assert.equal(r.status, 400, 'an accidental empty save is not a countable reversal');
  assert.equal((await nav.post('/api/overdose-events', { occurred_at: '2026-09-01T10:00:00Z', kind: 'reversal' })).status, 201);
});

test('time entries scoped to own user unless manager', async () => {
  await nav.post('/api/time', { work_date: '2026-09-05', minutes: 45, category: 'documentation' });
  const own = await nav.get('/api/time'); assert.ok(own.data.rows.every(x => x.worker === 'nav1'));
  const mgr = await admin.get('/api/time'); assert.ok(mgr.data.total >= own.data.total);
  const sum = await nav.get('/api/time/summary?from=2026-09-01&to=2026-09-30');
  assert.ok(sum.data.by_category.length >= 1);
});

test('imports: pocket ai upload, suggestion, commit as note; onenote mht upload', async () => {
  const up = await nav.post('/api/imports/upload', { source: 'pocket_ai', filename: 'export.json', text: JSON.stringify([{ id: 'p1', title: "Check-in with O'Brien, Jane", transcript: 'Client stable, wants housing referral.', summary: 'Stable; housing.', created_at: '2026-09-06T15:00:00Z' }]) });
  assert.equal(up.status, 201);
  const view = await nav.get(`/api/imports/${up.data.id}`);
  assert.equal(view.data.items.length, 1);
  assert.equal(view.data.items[0].suggested_client_id, clientId);
  const commit = await nav.post(`/api/imports/items/${view.data.items[0].id}/commit`, { client_id: clientId, kind: 'admin', format: 'contact', create_intervention: true, intervention_type: 'recovery_check_in', duration_minutes: 15 });
  assert.equal(commit.status, 200);
  const note = await nav.get(`/api/notes/${commit.data.note_id}`);
  assert.equal(note.data.note.source, 'pocket_ai'); assert.match(note.data.note.content, /housing referral/);
  assert.ok(H.db.one(`SELECT 1 FROM interventions WHERE id=?`, commit.data.intervention_id));
  assert.equal((await nav.post(`/api/imports/items/${view.data.items[0].id}/commit`, { client_id: clientId, kind: 'admin' })).status, 400);
  // raw binary upload path
  const mht = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B1"\r\n\r\n--B1\r\nContent-Type: text/html\r\n\r\n<html><head><title>Field note</title></head><body>Client: C26-0001 seen at shelter</body></html>\r\n--B1--\r\n`;
  const raw = await nav.req('POST', '/api/imports/upload?source=onenote', mht, { 'Content-Type': 'application/octet-stream', 'X-Filename': 'notes.mht' });
  assert.equal(raw.status, 201); assert.equal(raw.data.count, 1);
  // navigator cannot commit clinical
  const v2 = await nav.get(`/api/imports/${raw.data.id}`);
  assert.equal((await nav.post(`/api/imports/items/${v2.data.items[0].id}/commit`, { client_id: clientId, kind: 'clinical' })).status, 403);
});

test('intake API with key stages notes', async () => {
  const k = await admin.post('/api/admin/api-keys', { name: 'Pocket AI phone' });
  assert.equal(k.status, 201);
  const c = H.client();
  const r = await c.post('/api/intake/notes', { title: 'Voice memo', transcript: 'Met with Doe, John about detox.', created_at: '2026-09-07T12:00:00Z' }, { Authorization: `Bearer ${k.data.key}`, 'X-Requested-With': '' });
  assert.equal(r.status, 202); assert.equal(r.data.staged, 1);
  assert.equal((await c.post('/api/intake/notes', {}, { Authorization: 'Bearer suds_bad' })).status, 401);
  await admin.del(`/api/admin/api-keys/${k.data.id}`);
  assert.equal((await c.get('/api/intake/ping', { Authorization: `Bearer ${k.data.key}` })).status, 401);
});

test('reports, exports, and audit chain', async () => {
  const d = await nav.get('/api/reports/dashboard?from=2026-08-01&to=2026-09-30');
  assert.equal(d.status, 200); assert.ok(d.data.interventions.total >= 1); assert.equal(d.data.interventions.naloxone_kits, 2);
  const m = await admin.get('/api/reports/monthly?months=3'); assert.equal(m.status, 200);
  // Exports need export:read; a navigator's is de-identified and caseload-scoped, finance and supervisors export too.
  assert.equal((await nav.get('/api/reports/export/interventions?from=2026-08-01&to=2026-09-30')).status, 200);
  const csv = await fin.get('/api/reports/export/interventions?from=2026-08-01&to=2026-09-30');
  assert.equal(csv.status, 200); assert.match(csv.data, /^\uFEFF?Occurred At,Client Code/, 'the header is row 1: no comment line');
  assert.match(csv.headers.get('x-suds-export'), /^De-identified \(HIPAA Safe Harbor\)/, 'the classification travels in a header');
  const cl = await fin.get('/api/reports/export/clients?identified=1');
  assert.ok(!cl.data.includes('Jane')); // finance lacks export:identified → de-identified
  // An identified export is a disclosure: it has to say to whom and why.
  assert.equal((await admin.get('/api/reports/export/clients?identified=1')).status, 400);
  const cl2 = await admin.get('/api/reports/export/clients?identified=1&recipient=County%20auditor&purpose=Annual%20audit'); assert.ok(cl2.data.includes('Jane'));
  const a = await admin.get('/api/admin/audit?action=note.'); assert.ok(a.data.total > 0);
  assert.equal((await nav.get('/api/admin/audit')).status, 403);
  const v = await admin.get('/api/admin/audit/verify'); assert.equal(v.data.ok, true);
  H.db.run(`UPDATE audit_log SET details='tampered' WHERE id=(SELECT MIN(id) FROM audit_log WHERE details IS NOT NULL)`);
  assert.equal((await admin.get('/api/admin/audit/verify')).data.ok, false);
});

test('MFA enrollment and verification flow', async () => {
  const c = require('../server/crypto');
  const setup = await nav.post('/api/auth/mfa/setup', {});
  assert.equal(setup.status, 200);
  // This was 'assert.equal(x === 400 || true, true)' — it asserted nothing at all.
  assert.equal((await nav.post('/api/auth/mfa/enable', { code: '000000' })).status, 400, 'a wrong code must not enable two-step verification');
  const en = await nav.post('/api/auth/mfa/enable', { code: c.totp(setup.data.secret) });
  assert.equal(en.status, 200);
  const fresh = H.client();
  const login = await fresh.login('nav1', 'StaffPassw0rd!x');
  assert.equal(login.mfaPending, true);
  assert.equal((await fresh.get('/api/clients')).status, 401);
  assert.equal((await fresh.post('/api/auth/mfa/verify', { code: c.totp(setup.data.secret) })).status, 200);
  assert.equal((await fresh.get('/api/clients')).status, 200);
});

test('user management and self-protection', async () => {
  const u = await admin.post('/api/users', { username: 'newnav', display_name: 'New Navigator', role: 'navigator' });
  assert.equal(u.status, 201); assert.ok(u.data.temporary_password);
  const me = H.db.one(`SELECT id FROM users WHERE username='admin'`).id;
  assert.equal((await admin.put(`/api/users/${me}`, { is_active: false })).status, 400);
  assert.equal((await nav.post('/api/users', { username: 'x', display_name: 'x', role: 'admin' })).status, 403);
  const fresh = H.client();
  const l = await fresh.login('newnav', u.data.temporary_password);
  assert.equal(l.user.must_change_password, true);
  assert.equal((await fresh.get('/api/clients')).status, 403);
});

test('an administrator can link and unlink a single sign-on identity on an existing account', async () => {
  assert.equal((await nav.put(`/api/users/${H.db.one(`SELECT id FROM users WHERE username='nav1'`).id}`, { oidc_subject: 'whatever' })).status, 403);
  const target = H.db.one(`SELECT id FROM users WHERE username='nav1'`).id;
  assert.equal((await admin.put(`/api/users/${target}`, { oidc_subject: 'idp-subject-123' })).status, 200);
  assert.equal(H.db.one(`SELECT oidc_subject FROM users WHERE id=?`, target).oidc_subject, 'idp-subject-123');
  // Already claimed by another account
  const other = H.db.one(`SELECT id FROM users WHERE username='nav2'`).id;
  const conflict = await admin.put(`/api/users/${other}`, { oidc_subject: 'idp-subject-123' });
  assert.equal(conflict.status, 400);
  assert.equal(H.db.one(`SELECT oidc_subject FROM users WHERE id=?`, other).oidc_subject, null);
  // Unlink by clearing the field
  assert.equal((await admin.put(`/api/users/${target}`, { oidc_subject: '' })).status, 200);
  assert.equal(H.db.one(`SELECT oidc_subject FROM users WHERE id=?`, target).oidc_subject, null);
  const list = await admin.get('/api/users');
  assert.ok('oidc_subject' in list.data.users[0], 'the full user listing (admin/supervisor) includes the linkage');
});

test('non-managers cannot record work under another worker', async () => {
  const otherId = H.db.one(`SELECT id FROM users WHERE username='nav2'`).id;
  const r = await nav.post('/api/interventions', { client_id: clientId, type: 'outreach', occurred_at: '2026-09-10T10:00:00Z', user_id: otherId });
  assert.equal(r.status, 201);
  assert.equal(H.db.one(`SELECT user_id FROM interventions WHERE id=?`, r.data.id).user_id, H.db.one(`SELECT id FROM users WHERE username='nav1'`).id);
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x');
  const r2 = await s.post('/api/interventions', { client_id: clientId, type: 'outreach', occurred_at: '2026-09-10T10:00:00Z', user_id: otherId });
  assert.equal(H.db.one(`SELECT user_id FROM interventions WHERE id=?`, r2.data.id).user_id, otherId);
});

test('audit retention purge keeps the chain verifiable', async () => {
  const audit = require('../server/audit');
  // make the earliest rows look old, then purge
  // re-date everything up to and including the row tampered in the earlier test; purge must remove them all
  H.db.run(`UPDATE audit_log SET at='2015-01-01T00:00:00.000Z' WHERE id <= (SELECT MAX(id) FROM audit_log WHERE details='tampered')`);
  const n = audit.purge(3650);
  assert.ok(n >= 3);
  const v = audit.verifyChain();
  assert.equal(v.ok, true);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='audit.purge'`));
});

test('security policy settings are validated and applied', async () => {
  assert.equal((await admin.put('/api/admin/settings', { session_idle_minutes: 120 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { session_idle_minutes: 'abc' })).status, 400);
  // 'bogus' is dropped; 'clinician' is a real role but not one of the acting clients here, because the
  // requirement is now enforced and would lock this test's own admin out mid-way.
  assert.equal((await admin.put('/api/admin/settings', { session_idle_minutes: 20, mfa_required_roles: 'clinician, bogus' })).status, 200);
  const s = await admin.get('/api/admin/settings');
  assert.equal(s.data.policy.idleMinutes, 20);
  assert.deepEqual(s.data.policy.mfaRequiredRoles, ['clinician']);
  assert.equal((await clin.get('/api/auth/me')).data.user.mfa_required, true);
  assert.equal((await nav.get('/api/auth/me')).data.user.mfa_required, false);
  await admin.put('/api/admin/settings', { session_idle_minutes: '', mfa_required_roles: '' });
  assert.equal((await admin.get('/api/setup/status')).data.needed, false);
  assert.equal(typeof (await admin.get('/api/setup/status')).data.keySource, 'string', 'an administrator sees the installation detail');
  // Once setup is done the listener's addresses, hostname and key source describe the office network:
  // a caller with no session learns only that setup is complete.
  const anon = await H.client().get('/api/setup/status');
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.data, { needed: false, setupComplete: true });
  assert.equal((await admin.post('/api/setup/complete', {})).status, 403);
  assert.equal((await nav.get('/api/admin/network')).status, 403);
  assert.equal((await admin.get('/api/admin/network')).status, 200);
});

test('a blank optional setting clears it instead of saving the word "null"', async () => {
  // The settings form reads an untouched number input as JS null, not ''. That used to reach the server as
  // the four-character string "null" (String(null)), which failed numeric validation outright and, for a
  // text setting, would have literally saved "null" as the value.
  assert.equal((await admin.put('/api/admin/settings', { session_idle_minutes: null, county_name: null })).status, 200);
  const s = await admin.get('/api/admin/settings');
  // A cleared setting is reported as null (unset), never '': the form takes '' as a value and would render
  // the policy field blank instead of showing its default.
  assert.equal(s.data.session_idle_minutes, null);
  assert.equal(s.data.county_name, null);
  assert.equal(H.db.getSetting('session_idle_minutes', 'gone'), 'gone', 'the row is removed rather than stored empty');
  assert.equal(s.data.policy.idleMinutes, 15, 'a cleared setting falls back to the default, not to the word "null"');
});

test('scheduled backup settings are validated, and an admin can trigger one on demand', async () => {
  const backupsDir = require('node:path').join(require('../server/config').dataDir, 'backups');
  try {
    assert.equal((await nav.post('/api/admin/backup/run-now', {})).status, 403);
    assert.equal((await admin.put('/api/admin/settings', { backup_schedule_hours: -1 })).status, 400);
    assert.equal((await admin.put('/api/admin/settings', { backup_schedule_hours: 24, backup_retain_count: 5 })).status, 200);
    const s = await admin.get('/api/admin/settings');
    assert.equal(s.data.backup_schedule_hours, '24');
    assert.equal(s.data.backup_retain_count, '5');
    const r = await admin.post('/api/admin/backup/run-now', {});
    assert.equal(r.status, 200);
    assert.ok(r.data.bytes > 1000);
    const stats = await admin.get('/api/admin/stats');
    assert.ok(stats.data.last_scheduled_backup_at);
    assert.equal(stats.data.last_scheduled_backup_status, 'ok (verified)');
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='backup.run_now'`));
    await admin.put('/api/admin/settings', { backup_schedule_hours: '', backup_retain_count: '' });
  } finally { require('node:fs').rmSync(backupsDir, { recursive: true, force: true }); }
});

test('the update check is off by default, and reports what a configured feed says', async () => {
  const config = require('../server/config');
  assert.equal((await nav.get('/api/admin/update/check')).status, 403);
  assert.equal((await admin.get('/api/admin/update/check')).data.configured, false, 'no UPDATE_FEED_URL is set in this test run');

  const http = require('node:http');
  const feed = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://example.test/r' })); });
  await new Promise((res) => feed.listen(0, '127.0.0.1', res));
  const prior = config.updateFeedUrl;
  config.updateFeedUrl = `http://127.0.0.1:${feed.address().port}`;
  try {
    const r = await admin.get('/api/admin/update/check');
    assert.equal(r.status, 200);
    assert.equal(r.data.configured, true);
    assert.equal(r.data.available, true);
    assert.equal(r.data.latest, '99.0.0');
    assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='update.check'`));
  } finally { config.updateFeedUrl = prior; await new Promise((res) => feed.close(res)); }
});

test('a syncing device is tracked, and an admin can revoke or remotely wipe it', async () => {
  const sync = { 'X-Sync-Client': '1', 'X-Device-Id': 'device-test-1' };
  const first = await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' }, sync);
  assert.equal(first.status, 200, 'a first-seen device syncs normally');

  const list1 = await admin.get('/api/admin/devices');
  assert.equal(list1.status, 200);
  const row = list1.data.devices.find(d => d.id === 'device-test-1');
  assert.ok(row, 'the device now appears in the admin list');
  assert.equal(row.username, 'nav1');
  assert.equal(row.sync_count, 1);

  // Someone else's device management is not this admin's to touch through a stray permission gap
  assert.equal((await nav.get('/api/admin/devices')).status, 403);
  assert.equal((await nav.post(`/api/admin/devices/${row.id}/revoke`, {})).status, 403);

  // Revoke: the device is blocked at login, before any session exists
  assert.equal((await admin.post(`/api/admin/devices/${row.id}/revoke`, {})).status, 200);
  const revokedLogin = await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' }, sync);
  assert.equal(revokedLogin.status, 403);
  assert.equal(revokedLogin.data.deviceRevoked, true);
  assert.ok(!revokedLogin.data.token);

  // Clear: the device can sync again
  assert.equal((await admin.post(`/api/admin/devices/${row.id}/clear`, {})).status, 200);
  assert.equal((await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' }, sync)).status, 200);

  // Wipe: delivered exactly once, at the next login attempt, and the device ends up revoked afterward
  assert.equal((await admin.post(`/api/admin/devices/${row.id}/wipe`, {})).status, 200);
  const wipedLogin = await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' }, sync);
  assert.equal(wipedLogin.status, 403);
  assert.equal(wipedLogin.data.deviceWipeRequired, true);
  const afterWipe = H.db.one(`SELECT * FROM devices WHERE id=?`, row.id);
  assert.ok(afterWipe.revoked_at, 'the device is revoked the instant the wipe is delivered, so it cannot loop into repeated wipes');
  assert.ok(afterWipe.wipe_requested_at, 'the record that a wipe was requested is kept on the revoked row');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.login.device_wiped'`));
  // A revoked device that was told to wipe is told again if it ever comes back, in case the erase never finished
  const again = await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' }, sync);
  assert.equal(again.status, 403); assert.equal(again.data.deviceRevoked, true); assert.equal(again.data.wipeRequested, true); assert.equal(again.data.deviceWipeRequired, true);

  // A browser login (no sync headers) is never subject to any of this
  const office = H.client();
  assert.equal((await office.login('nav1', 'StaffPassw0rd!x')).user.username, 'nav1');

  await admin.post(`/api/admin/devices/${row.id}/clear`, {});
});

test('a pending wipe is not consumed by whoever knows the device id; only credentials or the acknowledgement token consume it', async () => {
  const sync = { 'X-Sync-Client': '1', 'X-Device-Id': 'device-test-2' };
  assert.equal((await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' }, sync)).status, 200);
  const row = (await admin.get('/api/admin/devices')).data.devices.find(d => d.id === 'device-test-2');
  assert.equal((await admin.post(`/api/admin/devices/${row.id}/wipe`, {})).status, 200);
  const pending = H.db.one(`SELECT * FROM devices WHERE id=?`, row.id);

  // Anonymous / wrong-password request from the device id: the wipe instruction is answered, the row is untouched
  const anon = await H.client().post('/api/auth/login', { username: 'nobody-here', password: 'wrong' }, sync);
  assert.equal(anon.status, 403); assert.equal(anon.data.deviceWipeRequired, true);
  assert.ok(anon.data.wipeAckToken, 'the response carries a one-time acknowledgement token');
  let after = H.db.one(`SELECT * FROM devices WHERE id=?`, row.id);
  assert.equal(after.revoked_at, null, 'not revoked by a request that proved nothing');
  assert.equal(after.wipe_requested_at, pending.wipe_requested_at, 'the wipe is still pending');
  assert.equal(after.sync_count, pending.sync_count);

  // A bad token does not consume it either
  assert.equal((await H.client().post('/api/devices/wipe-ack', { device_id: row.id, token: 'not-the-token' })).status, 403);
  assert.equal((await H.client().post('/api/devices/wipe-ack', { device_id: 'unknown-device', token: anon.data.wipeAckToken })).status, 403);
  after = H.db.one(`SELECT * FROM devices WHERE id=?`, row.id);
  assert.equal(after.revoked_at, null);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='device.wipe.ack.rejected'`));

  // The token from the wipe response does: the device is marked wiped (revoked), once
  assert.equal((await H.client().post('/api/devices/wipe-ack', { device_id: row.id, token: anon.data.wipeAckToken })).status, 200);
  after = H.db.one(`SELECT * FROM devices WHERE id=?`, row.id);
  assert.ok(after.revoked_at, 'acknowledged wipes revoke the device');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='device.wipe.acknowledged' AND entity_id=?`, row.id));
  assert.equal((await H.client().post('/api/devices/wipe-ack', { device_id: row.id, token: anon.data.wipeAckToken })).status, 403, 'the token is one-time');

  // Credentialed login on the device consumes a pending wipe (the phone proved it is the one being wiped)
  await admin.post(`/api/admin/devices/${row.id}/clear`, {});
  assert.equal((await admin.post(`/api/admin/devices/${row.id}/wipe`, {})).status, 200);
  const cred = await H.client().post('/api/auth/login', { username: 'nav1', password: 'StaffPassw0rd!x' }, sync);
  assert.equal(cred.status, 403); assert.equal(cred.data.deviceWipeRequired, true);
  after = H.db.one(`SELECT * FROM devices WHERE id=?`, row.id);
  assert.ok(after.revoked_at, 'marked wiped after verified credentials');
  await admin.post(`/api/admin/devices/${row.id}/clear`, {});
});

test('an administrator password reset wipes synced devices by default, and wipe_devices:false keeps them', async () => {
  const sync = { 'X-Sync-Client': '1', 'X-Device-Id': 'device-test-3' };
  const u = H.makeUser('devowner', 'navigator');
  assert.equal((await H.client().post('/api/auth/login', { username: 'devowner', password: 'StaffPassw0rd!x' }, sync)).status, 200);
  const keep = await admin.put(`/api/users/${u.id}`, { password: 'AnotherPassw0rd!x', wipe_devices: false });
  assert.equal(keep.status, 200); assert.equal(keep.data.devices_wiped, 0);
  assert.equal(H.db.one(`SELECT wipe_requested_at w FROM devices WHERE id='device-test-3'`).w, null);
  const wipe = await admin.put(`/api/users/${u.id}`, { password: 'YetAnotherPassw0rd!x' });
  assert.equal(wipe.status, 200); assert.equal(wipe.data.devices_wiped, 1, 'the default is to wipe');
  assert.ok(H.db.one(`SELECT wipe_requested_at w FROM devices WHERE id='device-test-3'`).w);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='user.update' AND details LIKE '%"wipe_devices":false%'`));
});

test('the metrics endpoint is off by default, then bearer-token gated once configured', async () => {
  const config = require('../server/config');
  const anon = H.client();
  assert.equal((await anon.get('/api/metrics')).status, 404, 'no METRICS_TOKEN is set in this test run');

  const prior = config.metricsToken;
  config.metricsToken = 'test-metrics-token-123';
  try {
    assert.equal((await anon.get('/api/metrics')).status, 401, 'no token given');
    assert.equal((await anon.get('/api/metrics', { Authorization: 'Bearer wrong-token' })).status, 401);
    const r = await anon.get('/api/metrics', { Authorization: 'Bearer test-metrics-token-123' });
    assert.equal(r.status, 200);
    assert.match(r.data, /^suds_up 1$/m);
    assert.match(r.data, /^suds_uptime_seconds \d+$/m);
  } finally { config.metricsToken = prior; }
});

test('workspace preferences and continue endpoint follow the user', async () => {
  assert.equal((await nav.put('/api/me/prefs', { theme: 'dark', tour_done: true, 'bad key!': 1 })).status, 400);
  assert.equal((await nav.put('/api/me/prefs', { theme: 'dark', tour_done: true })).status, 200);
  const second = H.client(); await second.login('nav1', 'StaffPassw0rd!x');
  const c = require('../server/crypto'); const secret = c.decrypt(H.db.one(`SELECT mfa_secret_enc FROM users WHERE username='nav1'`).mfa_secret_enc);
  await second.post('/api/auth/mfa/verify', { code: c.totp(secret) });
  const p = await second.get('/api/me/prefs');
  assert.equal(p.data.prefs.theme, 'dark'); assert.equal(p.data.prefs.tour_done, true);
  const cont = await second.get('/api/me/continue');
  assert.equal(cont.status, 200);
  assert.ok(cont.data.recent.some(x => x.id === clientId));
  assert.ok(cont.data.other_device, 'other session should be visible');
  assert.equal((await nav.put('/api/me/prefs', { theme: null })).status, 200);
  assert.equal((await nav.get('/api/me/prefs')).data.prefs.theme, undefined);
});

test('app info: public answer is the programme name; APK distribution is gone', async () => {
  // Without a session the answer is the programme name and nothing about the network — unless the
  // server was started with PUBLIC_APP_INFO=1. The native apps were removed in 1.9.3 (docs/PLATFORM.md): no
  // `android` field, no APK download and no admin upload route remain, and the /app page uses
  // `local_mode` to decide whether to mention the offline copy at all.
  const config = require('../server/config');
  const anon = await H.client().get('/api/app/info');
  assert.equal(anon.status, 200); assert.equal(typeof anon.data.name, 'string');
  assert.equal(anon.data.public, false); assert.equal(anon.data.allow_static_sync, false);
  assert.equal(typeof anon.data.local_mode, 'boolean');
  assert.equal(anon.data.listener, undefined); assert.equal(anon.data.android, undefined); assert.equal(anon.data.version, undefined);
  config.publicAppInfo = true;
  try { const open = await H.client().get('/api/app/info'); assert.equal(open.data.public, true); assert.equal(open.data.version, config.version); assert.equal(open.data.service, '_suds._tcp'); assert.equal(open.data.android, undefined); }
  finally { config.publicAppInfo = false; }
  const info = await admin.get('/api/app/info');
  assert.equal(info.status, 200); assert.equal(info.data.service, '_suds._tcp'); assert.equal(info.data.android, undefined);
  assert.equal(info.data.local_mode, config.localModeEnabled);
  assert.equal((await H.client().get('/api/app/android.apk')).status, 404);
  assert.equal((await admin.req('POST', '/api/admin/app/android', Buffer.from('PK\x03\x04' + 'x'.repeat(2000)), { 'Content-Type': 'application/octet-stream' })).status, 404);
  assert.equal((await admin.del('/api/admin/app/android')).status, 404);
});

test('sync: bearer login, scoped pull, push with last-write-wins and tombstones', async () => {
  const c = H.client();
  const login = await c.post('/api/auth/login', { username: 'nav2', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' });
  assert.ok(login.data.token, 'sync clients receive a bearer token');
  const B = { Authorization: 'Bearer ' + login.data.token, Cookie: '' };
  const bare = H.client(); // no cookie, bearer only
  const pull = await bare.get('/api/sync/pull?since=1970-01-01T00:00:00.000Z', B);
  assert.equal(pull.status, 200);
  assert.ok(pull.data.tables.clients.some(x => x.id === clientId), 'nav2 is assigned to the client');
  assert.ok(pull.data.tables.clients.every(x => typeof x.first_name_enc === 'string' && !x.first_name_enc.startsWith('v1:')), 'PHI is decrypted for transport');
  assert.ok(pull.data.tables.users.find(u => u.username === 'nav1').password_hash.startsWith('scrypt$0$'), 'other users carry no credentials');
  assert.ok(pull.data.tables.users.find(u => u.username === 'nav2').password_hash.startsWith('scrypt$32768'), 'own credentials sync for offline login');
  // push a device-created client + note, then an older edit that must lose
  const devId = require('node:crypto').randomUUID(); const noteId = require('node:crypto').randomUUID(); const now = new Date().toISOString();
  const push = await bare.post('/api/sync/push', { tables: { clients: [{ id: devId, client_code: 'M26-0001', first_name_enc: 'Dev', last_name_enc: 'Client', status: 'active', intake_date: '2026-09-10', created_at: now, updated_at: now }], notes: [{ id: noteId, client_id: devId, author_id: H.db.one(`SELECT id FROM users WHERE username='nav2'`).id, kind: 'admin', format: 'contact', content_enc: 'Offline note', occurred_at: now, status: 'draft', created_at: now, updated_at: now }] }, audit: [{ at: now, action: 'client.create', entity: 'client', entity_id: devId, client_id: devId, success: 1 }] }, B);
  assert.equal(push.status, 200); assert.equal(push.data.applied.clients, 1); assert.equal(push.data.applied.notes, 1);
  const stored = H.db.one(`SELECT first_name_enc, last_name_idx FROM clients WHERE id=?`, devId);
  assert.ok(stored.first_name_enc.startsWith('v1:'), 're-encrypted on the server'); assert.ok(stored.last_name_idx, 'blind index recomputed');
  assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=(SELECT id FROM users WHERE username='nav2')`, devId), 'device client assigned to the syncing navigator');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='device.client.create' AND client_id=?`, devId));
  const stale = await bare.post('/api/sync/push', { tables: { clients: [{ id: devId, client_code: 'M26-0001', first_name_enc: 'Older', last_name_enc: 'Client', status: 'active', created_at: now, updated_at: '2020-01-01T00:00:00.000Z' }] } }, B);
  assert.equal(stale.data.applied.clients, 0, 'older device edit does not overwrite');
  // tombstones from a device delete own-caseload operational rows; notes are part of the legal record and are never hard-deleted via sync
  const ts = new Date(Date.now() + 1000).toISOString(); const ivId = require('node:crypto').randomUUID();
  await bare.post('/api/sync/push', { tables: { interventions: [{ id: ivId, client_id: devId, user_id: 'x', type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now }] } }, B);
  await bare.post('/api/sync/push', { tombstones: [{ table_name: 'interventions', id: ivId, deleted_at: ts }, { table_name: 'notes', id: noteId, deleted_at: ts }] }, B);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM interventions WHERE id=?`, ivId).n, 0);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM notes WHERE id=?`, noteId).n, 1);
  const pull2 = await bare.get(`/api/sync/pull?since=${encodeURIComponent(now)}`, B);
  assert.ok(pull2.data.tombstones.some(t => t.id === ivId));
  // caseload enforcement: nav2 cannot push a note for a client not on their caseload
  H.makeUser('outsider', 'navigator'); const o = H.client(); const ol = await o.post('/api/auth/login', { username: 'outsider', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' });
  const rej = await bare.post('/api/sync/push', { tables: { notes: [{ id: require('node:crypto').randomUUID(), client_id: clientId, author_id: 'x', kind: 'admin', content_enc: 'x', occurred_at: now, created_at: now, updated_at: now }] } }, { Authorization: 'Bearer ' + ol.data.token, Cookie: '' });
  assert.equal(rej.data.rejected.length, 1);
  assert.equal((await bare.get('/api/sync/pull', { Authorization: 'Bearer ' + ol.data.token, Cookie: '' })).data.tables.clients.length, 0, 'outsider pulls no clients');
  // finance cannot sync
  const f = H.client(); const fl = await f.post('/api/auth/login', { username: 'fin1', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' });
  assert.equal((await bare.get('/api/sync/pull', { Authorization: 'Bearer ' + fl.data.token, Cookie: '' })).status, 403);
});

test('spreadsheet import: template, preview mapping/validation, commit; Excel export', async () => {
  const S = require('../server/spreadsheet');
  const tpl = await nav.get('/api/imports/data/template/clients');
  assert.equal(tpl.status, 200); assert.ok(tpl.headers.get('content-type').includes('spreadsheetml'));
  const csv = 'First Name,Surname,DOB,Phone Number,Program Status,Substance,Risk\r\nAmy,Importer,5/2/1988,555-0300,active,fentanyl,high\r\nBad,Row,notadate,,,unknownsub,\r\n';
  const prev = await nav.req('POST', '/api/imports/data/preview?entity=clients', csv, { 'Content-Type': 'text/csv', 'X-Filename': 'clients.csv' });
  assert.equal(prev.status, 200);
  assert.equal(prev.data.mapping['Surname'], 'last_name'); assert.equal(prev.data.mapping['Program Status'], 'status'); assert.equal(prev.data.mapping['Risk'], 'risk_level');
  assert.equal(prev.data.valid, 1); assert.equal(prev.data.invalid, 1);
  assert.equal(prev.data.rows[0].record.dob, '1988-05-02'); assert.equal(prev.data.rows[0].record.primary_substance, 'opioids_fentanyl');
  assert.ok(prev.data.rows[1].errors.some(e => /Date of birth/.test(e)));
  const commit = await nav.post('/api/imports/data/commit', { entity: 'clients', records: prev.data.rows.filter(r => !r.errors.length).map(r => r.record) });
  assert.equal(commit.status, 200); assert.equal(commit.data.created, 1);
  const found = await nav.get('/api/clients?q=importer'); assert.equal(found.data.clients.length, 1); const impId = found.data.clients[0].id;
  // interventions via xlsx with client reference by name; unknown client fails preview validation
  const xlsx = S.writeWorkbook([{ name: 'Visits', columns: ['Client', 'Date of service', 'Service type', 'Minutes'], rows: [{ Client: 'Importer, Amy', 'Date of service': '2026-09-12 10:00', 'Service type': 'Outreach', Minutes: 20 }, { Client: 'Nobody, Here', 'Date of service': '2026-09-12', 'Service type': 'outreach', Minutes: 5 }] }]);
  const p2 = await nav.req('POST', '/api/imports/data/preview?entity=interventions', xlsx, { 'Content-Type': 'application/octet-stream', 'X-Filename': 'visits.xlsx' });
  assert.equal(p2.status, 200); assert.equal(p2.data.valid, 1); assert.equal(p2.data.rows[0].record.client_id, impId); assert.equal(p2.data.rows[0].record.type, 'outreach');
  assert.ok(p2.data.rows[1].errors[0].includes('not found'));
  const c2 = await nav.post('/api/imports/data/commit', { entity: 'interventions', records: p2.data.rows.map(r => r.record) });
  assert.equal(c2.status, 400, 'all-or-nothing when a row is invalid');
  const c3 = await nav.post('/api/imports/data/commit', { entity: 'interventions', records: p2.data.rows.map(r => r.record), partial: true });
  assert.equal(c3.data.created, 1); assert.equal(c3.data.errors.length, 1);
  // The same file again: nothing is doubled
  const visitsBefore = H.db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, impId).n;
  const c4 = await nav.post('/api/imports/data/commit', { entity: 'interventions', records: p2.data.rows.map(r => ({ ...r.record, _n: r.n })), partial: true });
  assert.equal(c4.status, 200); assert.equal(c4.data.created, 0); assert.equal(c4.data.skipped_duplicates, 1, JSON.stringify(c4.data));
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, impId).n, visitsBefore);
  const c5 = await nav.post('/api/imports/data/commit', { entity: 'interventions', records: p2.data.rows.map(r => r.record), partial: true });
  assert.equal(c5.data.created, 0, 'with or without the row numbers the preview attached');
  // Time and expenditures too, and two identical rows in one sheet are both real
  const timeRows = [{ work_date: '2026-09-12', minutes: 30, category: 'direct_service', _n: 2 }, { work_date: '2026-09-12', minutes: 30, category: 'direct_service', _n: 3 }];
  const t1 = await nav.post('/api/imports/data/commit', { entity: 'time_entries', records: timeRows });
  assert.equal(t1.data.created, 2, 'two identical rows in one file are two entries');
  const t2 = await nav.post('/api/imports/data/commit', { entity: 'time_entries', records: [...timeRows].reverse() });
  assert.equal(t2.data.created, 0); assert.equal(t2.data.skipped_duplicates, 2, 'a re-sorted copy of the same sheet is still the same sheet');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM time_entries WHERE work_date='2026-09-12' AND minutes=30`).n, 2);
  // A failed all-or-nothing commit records nothing, so a corrected re-run is not treated as a duplicate
  const bad = await nav.post('/api/imports/data/commit', { entity: 'time_entries', records: [{ work_date: '2026-09-13', minutes: 10, category: 'direct_service', _n: 2 }, { minutes: 5, _n: 3 }] });
  assert.equal(bad.status, 400);
  assert.equal((await nav.post('/api/imports/data/commit', { entity: 'time_entries', records: [{ work_date: '2026-09-13', minutes: 10, category: 'direct_service', _n: 2 }] })).data.created, 1);
  // finance cannot import clients; finance and a navigator can export a (de-identified) workbook
  assert.equal((await fin.req('POST', '/api/imports/data/preview?entity=clients', csv, { 'Content-Type': 'text/csv' })).status, 403);
  assert.equal((await nav.get('/api/reports/export/workbook')).status, 200);
  const wb = await fin.get('/api/reports/export/workbook');
  assert.equal(wb.status, 200);
  const x = await fin.get('/api/reports/export/clients?format=xlsx'); assert.equal(x.status, 200); assert.ok(x.headers.get('content-disposition').includes('.xlsx'));
});

test('sync hardening: caseload on existing clients, tombstone limits, ownership, approvals, clinical filtering', async () => {
  const uuid = () => require('node:crypto').randomUUID(); const now = new Date().toISOString(); const later = new Date(Date.now() + 5000).toISOString();
  const bare = H.client();
  H.makeUser('syncnav', 'navigator'); const l = await bare.post('/api/auth/login', { username: 'syncnav', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' }); const B = { Authorization: 'Bearer ' + l.data.token, Cookie: '' };
  // cannot overwrite a client not on caseload even with a newer timestamp
  const r1 = await bare.post('/api/sync/push', { tables: { clients: [{ id: clientId, client_code: 'C26-0001', first_name_enc: 'Hacked', last_name_enc: 'X', status: 'active', created_at: now, updated_at: later }] } }, B);
  assert.equal(r1.data.rejected.length, 1); assert.notEqual(require('../server/crypto').decrypt(H.db.one(`SELECT first_name_enc FROM clients WHERE id=?`, clientId).first_name_enc), 'Hacked');
  // cannot delete another caseload's intervention; clients/notes are never hard-deleted via sync
  const iv = H.db.one(`SELECT id FROM interventions WHERE client_id=? LIMIT 1`, clientId);
  const r2 = await bare.post('/api/sync/push', { tombstones: [{ table_name: 'interventions', id: iv.id, deleted_at: later }, { table_name: 'clients', id: clientId, deleted_at: later }] }, B);
  assert.ok(H.db.one(`SELECT 1 FROM interventions WHERE id=?`, iv.id)); assert.ok(H.db.one(`SELECT 1 FROM clients WHERE id=?`, clientId)); assert.equal(r2.data.rejected.length, 1);
  // a navigator's device cannot attribute work to someone else or self-approve spending
  const devClient = uuid(); const otherUser = H.db.one(`SELECT id FROM users WHERE username='nav1'`).id; const fund = H.db.one(`SELECT id FROM funding_sources LIMIT 1`).id; const expId = uuid(); const ivId = uuid();
  const r3 = await bare.post('/api/sync/push', { tables: { clients: [{ id: devClient, client_code: 'M26-0009', first_name_enc: 'Dev', last_name_enc: 'Own', status: 'active', created_at: now, updated_at: now }],
    interventions: [{ id: ivId, client_id: devClient, user_id: otherUser, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now }],
    expenditures: [{ id: expId, funding_source_id: fund, client_id: devClient, user_id: otherUser, spent_at: '2026-09-10', amount: 500, category: 'client_assistance', status: 'approved', approved_by: otherUser, approved_at: now, created_at: now, updated_at: now }] } }, B);
  const me = H.db.one(`SELECT id FROM users WHERE username='syncnav'`).id;
  // Work in another (real) worker's name is refused outright rather than quietly re-attributed to whoever pressed Sync.
  assert.ok(r3.data.rejected.some(x => x.id === ivId && /attributed/.test(x.reason)) && !H.db.one(`SELECT 1 FROM interventions WHERE id=?`, ivId));
  assert.ok(r3.data.rejected.some(x => x.id === expId && /attributed/.test(x.reason)) && !H.db.one(`SELECT 1 FROM expenditures WHERE id=?`, expId));
  await bare.post('/api/sync/push', { tables: { expenditures: [{ id: expId, funding_source_id: fund, client_id: devClient, user_id: me, spent_at: '2026-09-10', amount: 500, category: 'client_assistance', status: 'approved', approved_by: otherUser, approved_at: now, created_at: now, updated_at: now }] } }, B);
  const e = H.db.one(`SELECT status, approved_by, user_id FROM expenditures WHERE id=?`, expId); assert.equal(e.status, 'pending'); assert.equal(e.approved_by, null); assert.equal(e.user_id, me);
  // signed notes cannot be altered from a device; clinical notes are not pulled by navigators and cannot be pushed by them
  const signed = H.db.one(`SELECT id, content_enc FROM notes WHERE status IN ('signed','amended') LIMIT 1`);
  const clinCount = H.db.one(`SELECT COUNT(*) n FROM notes WHERE kind='clinical'`).n; assert.ok(clinCount > 0);
  const pull = await bare.get('/api/sync/pull', B); assert.ok(pull.data.tables.notes.every(n => n.kind !== 'clinical')); assert.ok(pull.data.tables.users.every(u => u.mfa_secret_enc === null));
  const r4 = await bare.post('/api/sync/push', { tables: { notes: [{ id: uuid(), client_id: devClient, author_id: me, kind: 'clinical', format: 'SOAP', content_enc: 'x', occurred_at: now, status: 'draft', created_at: now, updated_at: now }] } }, B);
  assert.equal(r4.data.rejected.length, 1);
  // supervisor pulls clinical notes
  const s = H.client(); const sl = await s.post('/api/auth/login', { username: 'sup1', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' });
  const sp = await bare.get('/api/sync/pull', { Authorization: 'Bearer ' + sl.data.token, Cookie: '' }); assert.ok(sp.data.tables.notes.some(n => n.kind === 'clinical'));
  if (signed) { const sc = H.db.one(`SELECT client_id FROM notes WHERE id=?`, signed.id).client_id; await bare.post('/api/sync/push', { tables: { notes: [{ id: signed.id, client_id: sc, author_id: me, kind: 'admin', content_enc: 'tampered', occurred_at: now, status: 'draft', created_at: now, updated_at: later }] } }, { Authorization: 'Bearer ' + sl.data.token, Cookie: '' }); assert.equal(H.db.one(`SELECT content_enc FROM notes WHERE id=?`, signed.id).content_enc, signed.content_enc); }
});

test('sync push maps unknown user references to the syncing user instead of failing', async () => {
  const bare = H.client(); const l = await bare.post('/api/auth/login', { username: 'nav2', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' }); const B = { Authorization: 'Bearer ' + l.data.token, Cookie: '' };
  const now = new Date().toISOString(); const id = require('node:crypto').randomUUID(); const ghost = require('node:crypto').randomUUID();
  const r = await bare.post('/api/sync/push', { tables: { clients: [{ id, client_code: 'M26-0077', first_name_enc: 'Ghost', last_name_enc: 'Owner', status: 'active', created_by: ghost, created_at: now, updated_at: now }], tasks: [{ id: require('node:crypto').randomUUID(), client_id: id, assigned_to: ghost, created_by: ghost, title_enc: 'from device', status: 'open', priority: 'normal', created_at: now, updated_at: now }] } }, B);
  assert.equal(r.status, 200); assert.equal(r.data.applied.clients, 1); assert.equal(r.data.applied.tasks, 1);
  const me = H.db.one(`SELECT id FROM users WHERE username='nav2'`).id;
  assert.equal(H.db.one(`SELECT created_by FROM clients WHERE id=?`, id).created_by, me);
  assert.equal(H.db.one(`SELECT assigned_to FROM tasks WHERE client_id=?`, id).assigned_to, me);
});

test('sync normalises device clock skew so a fast clock cannot win conflicts', async () => {
  const bare = H.client(); const l = await bare.post('/api/auth/login', { username: 'nav2', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' }); const B = { Authorization: 'Bearer ' + l.data.token, Cookie: '' };
  const id = require('node:crypto').randomUUID(); const now = Date.now();
  await bare.post('/api/sync/push', { device_now: new Date(now).toISOString(), tables: { clients: [{ id, client_code: 'M26-0500', first_name_enc: 'Clock', last_name_enc: 'Test', status: 'active', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }] } }, B);
  // office edits the client now
  const s = H.client(); await s.login('sup1', 'StaffPassw0rd!x'); await s.put(`/api/clients/${id}`, { goals: 'office' });
  // a device whose clock is 1 hour fast sends an edit it made *before* the office edit (device time = +1h, real time = earlier)
  const fast = 3600_000; const deviceEditReal = now - 10_000; // 10 s before the office edit
  const r = await bare.post('/api/sync/push', { device_now: new Date(Date.now() + fast).toISOString(), tables: { clients: [{ id, client_code: 'M26-0500', first_name_enc: 'Clock', last_name_enc: 'Test', status: 'active', goals_enc: 'phone-stale', created_at: new Date(now + fast).toISOString(), updated_at: new Date(deviceEditReal + fast).toISOString() }] } }, B);
  assert.ok(Math.abs(r.data.clock_offset_ms + fast) < 5000, 'offset measured');
  assert.equal(require('../server/crypto').decrypt(H.db.one(`SELECT goals_enc FROM clients WHERE id=?`, id).goals_enc), 'office', 'stale device edit does not win despite a fast clock');
});

test('a role that must use two-step verification cannot work until it is set up', async () => {
  // This was advisory: the login response said mfaSetupRequired and nothing enforced it.
  const u = H.makeUser('mfauser', 'supervisor');
  H.db.setSetting('mfa_required_roles', 'supervisor');
  // Enforcement is real but not instant: a new account has a grace period to enrol, or the very first
  // administrator the setup wizard creates would be locked out before they could. Age this one past it.
  H.db.run(`UPDATE users SET created_at=? WHERE id=?`, '2020-01-01T00:00:00.000Z', u.id);
  try {
    const c = H.client();
    const login = await c.post('/api/auth/login', { username: u.username, password: u.password });
    assert.equal(login.status, 200);
    assert.equal(login.data.mfaSetupRequired, true, 'the user is told to enrol');

    const blocked = await c.get('/api/clients');
    assert.equal(blocked.status, 403, 'and is actually stopped until they do');
    assert.equal(blocked.data.mfaSetupRequired, true);

    // Enrolment itself stays reachable, or the user could never comply.
    const setup = await c.post('/api/auth/mfa/setup', {});
    assert.equal(setup.status, 200);
    assert.ok(setup.data.secret);
    // A wrong code must not enable it.
    assert.equal((await c.post('/api/auth/mfa/enable', { code: '000000' })).status, 400);
    const code = require('../server/crypto').totp(setup.data.secret);
    assert.equal((await c.post('/api/auth/mfa/enable', { code })).status, 200);
    assert.equal((await c.get('/api/clients')).status, 200, 'once enrolled, work proceeds');

    // A brand-new account in the same role is warned, not blocked.
    const fresh = H.makeUser('mfafresh', 'supervisor');
    const f = H.client();
    const freshLogin = await f.post('/api/auth/login', { username: fresh.username, password: fresh.password });
    assert.equal(freshLogin.data.mfaSetupRequired, true, 'they are told to enrol');
    assert.ok(freshLogin.data.mfaSetupDeadline > new Date().toISOString(), 'and given a date by which to do it');
    assert.equal((await f.get('/api/clients')).status, 200, 'but can still work in the meantime');
  } finally { H.db.setSetting('mfa_required_roles', ''); }
});

test('a half-authenticated session cannot change the account password', async () => {
  // The password route checked only that a user was attached, which let a session still owing its second
  // factor change the password on the account.
  const u = H.makeUser('mfapw', 'navigator');
  const c = H.client();
  await c.login(u.username, u.password);
  const setup = await c.post('/api/auth/mfa/setup', {});
  await c.post('/api/auth/mfa/enable', { code: require('../server/crypto').totp(setup.data.secret) });
  const again = H.client();
  const login = await again.post('/api/auth/login', { username: u.username, password: u.password });
  assert.equal(login.data.mfaPending, true);
  const r = await again.post('/api/auth/password', { current_password: u.password, new_password: 'Brand-New-Passw0rd!' });
  assert.equal(r.status, 401, 'the password change is refused until the second factor is given');
  assert.equal(r.data.mfaRequired, true);
});

test('ending an assignment takes the client off that worker\'s caseload and out of their reach', async () => {
  const sup = H.client(); await sup.login('sup1', 'StaffPassw0rd!x');
  const worker = H.makeUser('navend', 'navigator');
  const w = H.client(); await w.login(worker.username, worker.password);
  // Their own client, so they can see it to begin with.
  const id = (await w.post('/api/clients', { first_name: 'Ends', last_name: 'Here' })).data.id;
  assert.equal((await w.get(`/api/clients/${id}`)).status, 200);
  assert.ok((await w.get('/api/caseload')).data.caseload.some(c => c.id === id), 'it is on their caseload');

  const a = H.db.one(`SELECT id FROM assignments WHERE client_id=? AND user_id=? AND end_date IS NULL`, id, worker.id);
  assert.equal((await w.post(`/api/assignments/${a.id}/end`, {})).status, 403, 'a navigator cannot end their own assignment');
  assert.equal((await sup.post(`/api/assignments/${a.id}/end`, {})).status, 200);

  assert.equal((await w.get(`/api/clients/${id}`)).status, 403, 'the record is out of reach at once — no new sign-in needed');
  assert.ok(!(await w.get('/api/caseload')).data.caseload.some(c => c.id === id), 'and off their caseload');
  assert.ok(!(await w.get('/api/clients')).data.clients.some(c => c.id === id), 'and out of the client list');
  // Writing to it is refused too, not just reading.
  assert.equal((await w.post('/api/interventions', { client_id: id, type: 'outreach', occurred_at: '2026-09-03T10:00:00Z' })).status, 403);
  // The supervisor still sees it: ending an assignment removes one worker's access, it does not hide the client.
  assert.equal((await sup.get(`/api/clients/${id}`)).status, 200);
});

test('revoking sessions ends them immediately, on this device and on the others', async () => {
  const u = H.makeUser('revoker', 'navigator');
  const phone = H.client(); await phone.login(u.username, u.password);
  const desk = H.client(); await desk.login(u.username, u.password);
  assert.equal((await phone.get('/api/clients')).status, 200);
  assert.equal((await desk.get('/api/clients')).status, 200);
  assert.equal((await desk.get('/api/auth/sessions')).data.sessions.length, 2, 'both are listed');

  // "Sign out everywhere else" from the desktop.
  assert.equal((await desk.post('/api/auth/sessions/revoke-others', {})).status, 200);
  assert.equal((await phone.get('/api/clients')).status, 401, 'the phone is signed out on its next request');
  assert.equal((await desk.get('/api/clients')).status, 200, 'the device that asked stays signed in');
  assert.equal((await desk.get('/api/auth/sessions')).data.sessions.length, 1);
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='auth.sessions.revoked_others' AND user_id=?`, u.id));

  // Signing out revokes this session too — the cookie is not reusable afterwards.
  const token = H.db.one(`SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL`, u.id).id;
  assert.equal((await desk.post('/api/auth/logout', {})).status, 200);
  assert.equal((await desk.get('/api/clients')).status, 401);
  assert.ok(H.db.one(`SELECT revoked_at FROM sessions WHERE id=?`, token).revoked_at, 'the row records when it ended');
});

test('deactivating an account ends its sessions', async () => {
  const u = H.makeUser('goner', 'navigator');
  const c = H.client(); await c.login(u.username, u.password);
  assert.equal((await c.get('/api/clients')).status, 200);
  assert.equal((await admin.put(`/api/users/${u.id}`, { is_active: false })).status, 200);
  assert.equal((await c.get('/api/clients')).status, 401, 'the session stops working the moment the account is disabled');
});

// ---- Offboarding order: a pending wipe reaches the phone whatever the account's state is ----
test('a remote wipe is delivered before the credentials are judged, so deactivating the account first cannot defeat it', async () => {
  const u = H.makeUser('leaver', 'navigator');
  const sync = { 'X-Sync-Client': '1', 'X-Device-Id': 'device-leaver-1' };
  assert.equal((await H.client().post('/api/auth/login', { username: u.username, password: u.password }, sync)).status, 200);
  // The office does it in the "wrong" order: wipe requested, then the account deactivated.
  assert.equal((await admin.post('/api/admin/devices/device-leaver-1/wipe', {})).status, 200);
  assert.equal((await admin.put(`/api/users/${u.id}`, { is_active: false })).status, 200);
  const r = await H.client().post('/api/auth/login', { username: u.username, password: u.password }, sync);
  assert.equal(r.status, 403);
  assert.equal(r.data.deviceWipeRequired, true, 'the inactive account is not what the device hears about; the wipe is');
  const row = H.db.one(`SELECT * FROM devices WHERE id='device-leaver-1'`);
  assert.ok(row.revoked_at, 'the right password on the deactivated account proves the phone is the one being wiped'); assert.ok(row.wipe_requested_at);

  // A wrong password, or a username that does not exist, on a device with a wipe pending still gets the wipe
  const u2 = H.makeUser('leaver2', 'navigator');
  const sync2 = { 'X-Sync-Client': '1', 'X-Device-Id': 'device-leaver-2' };
  assert.equal((await H.client().post('/api/auth/login', { username: u2.username, password: u2.password }, sync2)).status, 200);
  await admin.post('/api/admin/devices/device-leaver-2/wipe', {});
  const wrong = await H.client().post('/api/auth/login', { username: 'nobody-here', password: 'nope' }, sync2);
  assert.equal(wrong.status, 403); assert.equal(wrong.data.deviceWipeRequired, true);
  // ... and keeps getting it until the device proves it heard: a wrong password proves nothing
  const stillPending = await H.client().post('/api/auth/login', { username: u2.username, password: 'wrong-password' }, sync2);
  assert.equal(stillPending.status, 403); assert.equal(stillPending.data.deviceWipeRequired, true); assert.ok(stillPending.data.wipeAckToken);
  assert.equal(H.db.one(`SELECT revoked_at r FROM devices WHERE id='device-leaver-2'`).r, null);
  // The acknowledgement (what the phone sends after erasing itself) does; once revoked, a revoked answer — again regardless of the password
  assert.equal((await H.client().post('/api/devices/wipe-ack', { device_id: 'device-leaver-2', token: stillPending.data.wipeAckToken })).status, 200);
  const again = await H.client().post('/api/auth/login', { username: u2.username, password: 'wrong-password' }, sync2);
  assert.equal(again.status, 403); assert.equal(again.data.deviceRevoked, true); assert.equal(again.data.wipeRequested, true);
  // A device the server has never seen gets the ordinary answer: nothing about the account leaks through the device path
  const fresh = await H.client().post('/api/auth/login', { username: 'nobody-here', password: 'nope' }, { 'X-Sync-Client': '1', 'X-Device-Id': 'device-never-seen' });
  assert.equal(fresh.status, 401);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM devices WHERE id='device-never-seen'`).n, 0, 'an unknown device is only recorded once its holder has signed in');
});

test('deactivating an account, or resetting its password, queues a wipe for every device it syncs from', async () => {
  const u = H.makeUser('offboard', 'navigator');
  for (const id of ['device-offboard-1', 'device-offboard-2']) assert.equal((await H.client().post('/api/auth/login', { username: u.username, password: u.password }, { 'X-Sync-Client': '1', 'X-Device-Id': id })).status, 200);
  // One of them was already revoked (a delivered wipe leaves a device revoked): it is left alone.
  await admin.post('/api/admin/devices/device-offboard-2/revoke', {});
  const r = await admin.put(`/api/users/${u.id}`, { is_active: false });
  assert.equal(r.status, 200); assert.equal(r.data.devices_wiped, 1);
  assert.ok(H.db.one(`SELECT wipe_requested_at FROM devices WHERE id='device-offboard-1'`).wipe_requested_at);
  assert.equal(H.db.one(`SELECT wipe_requested_at FROM devices WHERE id='device-offboard-2'`).wipe_requested_at, null);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='device.wipe.requested' AND entity='user' AND entity_id=?`, u.id);
  assert.ok(a, 'audited'); assert.equal(JSON.parse(a.details).reason, 'deactivated');
  // The next sync from that phone is the wipe, even though the account is now inactive.
  const next = await H.client().post('/api/auth/login', { username: u.username, password: u.password }, { 'X-Sync-Client': '1', 'X-Device-Id': 'device-offboard-1' });
  assert.equal(next.data.deviceWipeRequired, true);

  // A password reset by an administrator does the same for a still-active account.
  const p = H.makeUser('reset-me', 'navigator');
  assert.equal((await H.client().post('/api/auth/login', { username: p.username, password: p.password }, { 'X-Sync-Client': '1', 'X-Device-Id': 'device-reset-1' })).status, 200);
  const pr = await admin.put(`/api/users/${p.id}`, { password: 'BrandNewPassw0rd!x' });
  assert.equal(pr.status, 200); assert.equal(pr.data.devices_wiped, 1);
  assert.equal(JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='device.wipe.requested' AND entity_id=?`, p.id).details).reason, 'password_reset');
  const old = await H.client().post('/api/auth/login', { username: p.username, password: p.password }, { 'X-Sync-Client': '1', 'X-Device-Id': 'device-reset-1' });
  assert.equal(old.data.deviceWipeRequired, true, 'delivered even though the phone still holds the old password');
});

// ---- Request body caps depend on the route and on whether there is a session ----
test('an unauthenticated request cannot make the server buffer a large body; file routes keep their cap behind a session', async () => {
  const big = JSON.stringify({ username: 'admin', password: 'x'.repeat(2 * 1024 * 1024) });
  const r = await H.client().post('/api/auth/login', big);
  assert.equal(r.status, 413, '2 MB to the sign-in route is refused before it is read');
  // 64 KB is still comfortably more than any sign-in or setup form: a 40 KB body is read in full and
  // answered by the route (validation rejects the absurd password; the point is that it was not a 413)
  assert.equal((await H.client().post('/api/auth/login', { username: 'admin', password: 'x'.repeat(40 * 1024) })).status, 400);
  // A signed-in JSON route gets 1 MB, not the 60 MB upload cap
  const over = await nav.post('/api/clients', JSON.stringify({ first_name: 'Big', last_name: 'x'.repeat(1024 * 1024 + 1024) }));
  assert.equal(over.status, 413);
  // The sync push still accepts a payload well over that (the phone sends up to 4 MB chunks)
  const login = await H.client().post('/api/auth/login', { username: 'nav2', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1', 'X-Device-Id': 'device-bodycap' });
  const B = { Authorization: 'Bearer ' + login.data.token, Cookie: '' };
  const push = await H.client().post('/api/sync/push', JSON.stringify({ tables: {}, note: 'y'.repeat(3 * 1024 * 1024) }), B);
  assert.equal(push.status, 200, 'a 3 MB sync push is read in full');
  // ...but not without the session that makes it a sync client
  assert.equal((await H.client().post('/api/sync/push', JSON.stringify({ tables: {}, note: 'y'.repeat(3 * 1024 * 1024) }))).status, 413);
});

// ---- Behind a proxy, the client address is the last X-Forwarded-For hop, the one the proxy added ----
test('TRUST_PROXY takes the rightmost X-Forwarded-For address, so a client cannot choose its own', async () => {
  const config = require('../server/config');
  const was = config.trustProxy; config.trustProxy = true;
  try {
    await H.client().post('/api/auth/login', { username: 'xff-probe', password: 'nope' }, { 'X-Forwarded-For': '9.9.9.9, 203.0.113.7' });
    const row = H.db.one(`SELECT ip FROM audit_log WHERE action='auth.login.failed' AND username LIKE 'unknown:xff-prob%' ORDER BY id DESC LIMIT 1`);
    assert.equal(row.ip, '203.0.113.7', 'the proxy appended the real address last; 9.9.9.9 is what the client claimed');
    config.trustProxy = false;
    await H.client().post('/api/auth/login', { username: 'xff-probe2', password: 'nope' }, { 'X-Forwarded-For': '9.9.9.9' });
    assert.equal(H.db.one(`SELECT ip FROM audit_log WHERE action='auth.login.failed' AND username LIKE 'unknown:xff-prob%' ORDER BY id DESC LIMIT 1`).ip, '127.0.0.1', 'without TRUST_PROXY the header is ignored');
  } finally { config.trustProxy = was; }
});

test('a failed sign-in for a username nobody has is audited in truncated, hashed form; a real account is named', async () => {
  const chosen = 'DROP TABLE clients; <script>alert(1)</script> ' + 'x'.repeat(40);
  await H.client().post('/api/auth/login', { username: chosen, password: 'nope' });
  const row = H.db.one(`SELECT username FROM audit_log WHERE action='auth.login.failed' ORDER BY id DESC LIMIT 1`);
  assert.ok(row.username.startsWith('unknown:DROP TAB'), row.username);
  assert.ok(row.username.length < 40, 'cut short');
  assert.ok(!row.username.includes('<script>'), 'the attacker-chosen text is not stored verbatim');
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM audit_log WHERE username=?`, chosen).n, 0);
  await H.client().post('/api/auth/login', { username: 'nav1', password: 'nope' });
  assert.equal(H.db.one(`SELECT username FROM audit_log WHERE action='auth.login.failed' ORDER BY id DESC LIMIT 1`).username, 'nav1', 'an existing account keeps its name');
});

// ---- The health endpoint keeps its status public and its inventory private ----
test('the health endpoint gives the version, schema and disk figures only to an administrator or the metrics token', async () => {
  const config = require('../server/config');
  const anon = await H.client().get('/api/health');
  assert.equal(anon.status, 200); assert.equal(anon.data.ok, true); assert.equal(anon.data.database, 'ok');
  for (const k of ['version', 'schema_version', 'database_bytes', 'disk_free_bytes']) assert.equal(anon.data[k], undefined, `${k} is not in the unauthenticated answer`);
  const mine = await admin.get('/api/health');
  assert.equal(mine.data.version, config.version); assert.ok(mine.data.schema_version >= 7); // (disk figures need a database on disk; the suite runs in memory)
  assert.equal((await nav.get('/api/health')).data.version, undefined, 'a navigator is not an administrator');
  const was = config.metricsToken; config.metricsToken = 'scrape-token-1234';
  try {
    assert.equal((await H.client().get('/api/health', { Authorization: 'Bearer scrape-token-1234' })).data.version, config.version);
    assert.equal((await H.client().get('/api/health', { Authorization: 'Bearer wrong-token-0000' })).data.version, undefined);
  } finally { config.metricsToken = was; }
});

// ---- The generated first-run password file is retired with the password ----
test('changing an administrator password deletes the first-admin password file', async () => {
  const fs = require('node:fs');
  const bootstrap = require('../server/bootstrap');
  fs.writeFileSync(bootstrap.passwordFilePath(), 'Temporary-Passw0rd!\n', { mode: 0o600 });
  try {
    const a2 = H.makeUser('admin2', 'admin', 'AdminTwoPassw0rd!x');
    const c = H.client(); await c.login(a2.username, a2.password);
    assert.ok(fs.existsSync(bootstrap.passwordFilePath()), 'still there before the change');
    // A navigator changing theirs does not count: the file is about the administrator's bootstrap password
    assert.equal((await nav.post('/api/auth/password', { current_password: 'StaffPassw0rd!x', new_password: 'StaffPassw0rd!y' })).status, 200);
    assert.ok(fs.existsSync(bootstrap.passwordFilePath()));
    await nav.post('/api/auth/password', { current_password: 'StaffPassw0rd!y', new_password: 'StaffPassw0rd!x' });
    assert.equal((await c.post('/api/auth/password', { current_password: a2.password, new_password: 'AdminTwoPassw0rd!y' })).status, 200);
    assert.ok(!fs.existsSync(bootstrap.passwordFilePath()), 'gone once an administrator has changed their password');
  } finally { try { fs.unlinkSync(bootstrap.passwordFilePath()); } catch {} }
});
