'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, nav, nav2, clin, fin, clientId, clientId2, noteId, referralConsentId;
before(async () => {
  await H.start();
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
test('blind-index search by last name, phone, dob, code', async () => {
  for (const q of ['obrien', "O'Brien", '555-010-0100', '1990-05-01', 'C26-0001', 'jane obrien', "O'Brien, Jane"]) {
    const r = await nav.get(`/api/clients?q=${encodeURIComponent(q.replace('C26', 'C' + String(new Date().getFullYear()).slice(2)))}`);
    assert.equal(r.data.clients.length, 1, `search ${q}`);
  }
  assert.equal((await nav.get('/api/clients?q=smith')).data.clients.length, 0);
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
test('resources and referrals', async () => {
  const res = await nav.post('/api/resources', { name: 'County OTP', category: 'mat_otp', phone: '555-0199', accepts_medicaid: true });
  assert.equal(res.status, 201);
  // A warm handoff names the client to the receiving agency, so it is refused until a consent covers it.
  const noConsent = await nav.post('/api/referrals', { client_id: clientId, resource_id: res.data.id, referred_at: '2026-09-03T09:00:00Z', urgency: 'urgent', warm_handoff: true });
  assert.equal(noConsent.status, 400, 'a warm handoff without consent must be refused');
  assert.match(noConsent.data.error, /consent/i);
  const consent = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT referral', signed_at: '2026-09-01' });
  assert.equal(consent.status, 201); referralConsentId = consent.data.id;
  const ref = await nav.post('/api/referrals', { client_id: clientId, resource_id: res.data.id, referred_at: '2026-09-03T09:00:00Z', urgency: 'urgent', warm_handoff: true, consent_id: referralConsentId });
  assert.equal(ref.status, 201);
  // Sharing the information wrote the disclosure record that HIPAA §164.528 requires.
  const disc = H.db.one(`SELECT * FROM disclosures WHERE source='referral' AND source_ref=?`, ref.data.id);
  assert.ok(disc, 'a referral that shares information records a disclosure');
  assert.equal(disc.consent_id, referralConsentId);
  assert.match(disc.recipient_enc, /^v1:/, 'the recipient is stored encrypted');
  // Closing the loop: a follow-up task exists even though the worker set no follow-up date.
  assert.ok(H.db.one(`SELECT 1 FROM tasks WHERE client_id=? AND title LIKE 'Follow up on referral%'`, clientId));
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
  const c = await nav.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'Treatment coordination', signed_at: '2026-09-01', expires_at: '2027-09-01' });
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
  const csv = await nav.get('/api/reports/export/interventions?from=2026-08-01&to=2026-09-30');
  assert.equal(csv.status, 200); assert.match(csv.data, /Occurred At,Client Code/);
  const cl = await nav.get('/api/reports/export/clients?identified=1');
  assert.ok(!cl.data.includes('Jane')); // navigator lacks export:identified → de-identified
  const cl2 = await admin.get('/api/reports/export/clients?identified=1'); assert.ok(cl2.data.includes('Jane'));
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
  assert.equal((await admin.post('/api/setup/complete', {})).status, 403);
  assert.equal((await nav.get('/api/admin/network')).status, 403);
  assert.equal((await admin.get('/api/admin/network')).status, 200);
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

test('native app distribution: public info, admin upload, download, remove', async () => {
  const info = await H.client().get('/api/app/info');
  assert.equal(info.status, 200); assert.equal(info.data.android.available, false); assert.equal(info.data.service, '_suds._tcp');
  assert.equal((await H.client().get('/api/app/android.apk')).status, 404);
  assert.equal((await nav.req('POST', '/api/admin/app/android', Buffer.from('PK' + 'x'.repeat(2000)), { 'Content-Type': 'application/octet-stream' })).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/app/android', Buffer.from('nope' + 'x'.repeat(2000)), { 'Content-Type': 'application/octet-stream' })).status, 400);
  const up = await admin.req('POST', '/api/admin/app/android?version=1.0.0', Buffer.from('PK\x03\x04' + 'x'.repeat(2000)), { 'Content-Type': 'application/octet-stream' });
  assert.equal(up.status, 200); assert.equal(up.data.available, true);
  const dl = await H.client().get('/api/app/android.apk');
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal((await admin.del('/api/admin/app/android')).status, 200);
  assert.equal((await H.client().get('/api/app/info')).data.android.available, false);
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
  // finance cannot import clients; navigator can export a workbook
  assert.equal((await fin.req('POST', '/api/imports/data/preview?entity=clients', csv, { 'Content-Type': 'text/csv' })).status, 403);
  const wb = await nav.get('/api/reports/export/workbook');
  assert.equal(wb.status, 200);
  const x = await nav.get('/api/reports/export/clients?format=xlsx'); assert.equal(x.status, 200); assert.ok(x.headers.get('content-disposition').includes('.xlsx'));
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
  await bare.post('/api/sync/push', { tables: { clients: [{ id: devClient, client_code: 'M26-0009', first_name_enc: 'Dev', last_name_enc: 'Own', status: 'active', created_at: now, updated_at: now }],
    interventions: [{ id: ivId, client_id: devClient, user_id: otherUser, type: 'outreach', occurred_at: now, duration_minutes: 5, created_at: now, updated_at: now }],
    expenditures: [{ id: expId, funding_source_id: fund, client_id: devClient, user_id: otherUser, spent_at: '2026-09-10', amount: 500, category: 'client_assistance', status: 'approved', approved_by: otherUser, approved_at: now, created_at: now, updated_at: now }] } }, B);
  const me = H.db.one(`SELECT id FROM users WHERE username='syncnav'`).id;
  assert.equal(H.db.one(`SELECT user_id FROM interventions WHERE id=?`, ivId).user_id, me);
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
  const r = await bare.post('/api/sync/push', { tables: { clients: [{ id, client_code: 'M26-0077', first_name_enc: 'Ghost', last_name_enc: 'Owner', status: 'active', created_by: ghost, created_at: now, updated_at: now }], tasks: [{ id: require('node:crypto').randomUUID(), client_id: id, assigned_to: ghost, created_by: ghost, title: 'from device', status: 'open', priority: 'normal', created_at: now, updated_at: now }] } }, B);
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
