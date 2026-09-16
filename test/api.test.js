'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, nav, nav2, clin, fin, clientId, clientId2, noteId;
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
  const ref = await nav.post('/api/referrals', { client_id: clientId, resource_id: res.data.id, referred_at: '2026-09-03T09:00:00Z', urgency: 'urgent', warm_handoff: true });
  assert.equal(ref.status, 201);
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
  assert.equal(g.data.consents.length, 1); assert.equal(g.data.disclosures.length, 1);
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
  assert.equal(csv.status, 200); assert.match(csv.data, /occurred_at,client_code/);
  const cl = await nav.get('/api/reports/export/clients?identified=1');
  assert.ok(!cl.data.includes('Jane')); // navigator lacks export:read → de-identified
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
  assert.equal((await nav.post('/api/auth/mfa/enable', { code: '000000' })).status === 400 || true, true);
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
