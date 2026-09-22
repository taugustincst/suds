'use strict';
// The workflows the platform recorded data for but had no process around: countersignature, supervision,
// time approval, discharge, caseload transfer, duplicate handling and the funder report.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let admin, sup, nav, nav2, trainee;
let supId, navId, nav2Id, traineeId, clientId;

before(async () => {
  await H.start();
  H.makeUser('wsup', 'supervisor'); H.makeUser('wnav', 'navigator'); H.makeUser('wnav2', 'navigator'); H.makeUser('wtrainee', 'clinician');
  supId = H.db.one(`SELECT id FROM users WHERE username='wsup'`).id;
  navId = H.db.one(`SELECT id FROM users WHERE username='wnav'`).id;
  nav2Id = H.db.one(`SELECT id FROM users WHERE username='wnav2'`).id;
  traineeId = H.db.one(`SELECT id FROM users WHERE username='wtrainee'`).id;
  // The trainee is supervised and their notes need a countersignature.
  H.db.run(`UPDATE users SET requires_cosign=1, supervisor_id=? WHERE id=?`, supId, traineeId);
  H.db.run(`UPDATE users SET supervisor_id=? WHERE id IN (?,?)`, supId, navId, nav2Id);

  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  sup = H.client(); await sup.login('wsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('wnav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('wnav2', 'StaffPassw0rd!x');
  trainee = H.client(); await trainee.login('wtrainee', 'StaffPassw0rd!x');

  clientId = (await nav.post('/api/clients', { first_name: 'Work', last_name: 'Flow', dob: '1990-01-01' })).data.id;
  await sup.post(`/api/clients/${clientId}/assignments`, { user_id: traineeId, role_on_case: 'clinician' });
});
after(async () => { await H.stop(); });

test('a supervisor countersigns a note instead of becoming its signer', async () => {
  const n = await trainee.post('/api/notes', { client_id: clientId, kind: 'clinical', title: 'Session one', content: 'Discussed goals.', occurred_at: '2026-09-01T10:00:00Z' });
  assert.equal(n.status, 201);
  const id = n.data.id;
  assert.equal(H.db.one(`SELECT cosign_required FROM notes WHERE id=?`, id).cosign_required, 1, 'a supervised author needs a countersignature');

  // The supervisor cannot sign in the author's place — that used to make them the sole recorded signer.
  const stolen = await sup.post(`/api/notes/${id}/sign`, { password: 'StaffPassw0rd!x' });
  assert.equal(stolen.status, 403);
  assert.match(stolen.data.error, /author/i);

  const signed = await trainee.post(`/api/notes/${id}/sign`, { password: 'StaffPassw0rd!x' });
  assert.equal(signed.status, 200);
  assert.equal(signed.data.awaiting_cosign, true);

  // A clinician has no countersigning authority at all.
  assert.equal((await trainee.post(`/api/notes/${id}/cosign`, { password: 'StaffPassw0rd!x' })).status, 403);
  // A wrong password is not a signature.
  assert.equal((await sup.post(`/api/notes/${id}/cosign`, { password: 'wrong' })).status, 403);

  const co = await sup.post(`/api/notes/${id}/cosign`, { password: 'StaffPassw0rd!x', note: 'Reviewed, agree with plan.' });
  assert.equal(co.status, 200);

  const row = H.db.one(`SELECT * FROM notes WHERE id=?`, id);
  assert.equal(row.author_id, traineeId, 'the author is still the person who did the work');
  assert.equal(row.signed_by, traineeId);
  assert.equal(row.cosigned_by, supId, 'and the supervisor is recorded separately');
  // And nobody countersigns their own work, even with the authority to countersign others'.
  const ownNote = await sup.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Supervisor\'s own session.', occurred_at: '2026-09-01T12:00:00Z' });
  await sup.post(`/api/notes/${ownNote.data.id}/sign`, { password: 'StaffPassw0rd!x' });
  const self = await sup.post(`/api/notes/${ownNote.data.id}/cosign`, { password: 'StaffPassw0rd!x' });
  assert.equal(self.status, 400);
  assert.match(self.data.error, /own author/i);

  const v = await sup.get(`/api/notes/${id}/verify`);
  assert.equal(v.data.intact, true);
  assert.equal(v.data.cosignature_intact, true);
  assert.equal(v.data.awaiting_cosign, false);
  // Countersigning twice is refused.
  assert.equal((await sup.post(`/api/notes/${id}/cosign`, { password: 'StaffPassw0rd!x' })).status, 400);
});

test('staff time is submitted and approved by someone else', async () => {
  const t = await nav.post('/api/time', { work_date: '2026-09-02', minutes: 90, category: 'direct_service', client_id: clientId, billable: true });
  assert.equal(t.status, 201);
  const id = t.data.id;
  assert.equal(H.db.one(`SELECT status FROM time_entries WHERE id=?`, id).status, 'draft');

  assert.equal((await nav.post(`/api/time/${id}/approve`, { decision: 'approved' })).status, 403, 'a navigator cannot approve');
  assert.equal((await sup.post(`/api/time/${id}/approve`, { decision: 'approved' })).status, 400, 'nothing to approve until it is submitted');

  assert.equal((await nav.post(`/api/time/${id}/submit`, {})).status, 200);
  assert.equal(H.db.one(`SELECT status FROM time_entries WHERE id=?`, id).status, 'submitted');

  // It appears in the supervisor's queue.
  const q = await sup.get('/api/supervision/queue');
  assert.equal(q.status, 200);
  assert.ok(q.data.time_awaiting_approval.some(x => x.id === id), 'the entry is waiting on the supervisor');

  // Separation of duties: the supervisor's own time is not theirs to approve.
  const own = await sup.post('/api/time', { work_date: '2026-09-02', minutes: 30, category: 'supervision' });
  await sup.post(`/api/time/${own.data.id}/submit`, {});
  assert.equal((await sup.post(`/api/time/${own.data.id}/approve`, { decision: 'approved' })).status, 403);

  const ok = await sup.post(`/api/time/${id}/approve`, { decision: 'approved', note: 'Matches the visit note.' });
  assert.equal(ok.status, 200);
  const row = H.db.one(`SELECT * FROM time_entries WHERE id=?`, id);
  assert.equal(row.status, 'approved');
  assert.equal(row.approved_by, supId);
});

test('an administrator can put a worker under supervision without touching the database', async () => {
  // The requires_cosign/supervisor_id columns had no route or form: the countersignature workflow could
  // only be switched on with SQL, which is not an option for the office manager this app is for.
  assert.equal((await admin.put(`/api/users/${nav2Id}`, { requires_cosign: true, supervisor_id: supId })).status, 200);
  const row = H.db.one(`SELECT requires_cosign, supervisor_id FROM users WHERE id=?`, nav2Id);
  assert.equal(row.requires_cosign, 1); assert.equal(row.supervisor_id, supId);
  assert.ok((await admin.get('/api/users')).data.users.find(u => u.id === nav2Id).requires_cosign === 1, 'and the user list shows it');
  assert.equal((await admin.put(`/api/users/${nav2Id}`, { supervisor_id: navId })).status, 400, 'a navigator cannot be named as someone\'s supervisor');
  assert.equal((await nav.put(`/api/users/${nav2Id}`, { requires_cosign: false })).status, 403, 'nor can a navigator change it');
  assert.equal((await admin.put(`/api/users/${nav2Id}`, { requires_cosign: false, supervisor_id: '' })).status, 200);
  assert.equal(H.db.one(`SELECT requires_cosign FROM users WHERE id=?`, nav2Id).requires_cosign, 0);
});

test('an administrator can reach clinical notes only through break-glass, on the list too', async () => {
  const n = await trainee.post('/api/notes', { client_id: clientId, kind: 'clinical', title: 'Glass', content: 'Relapse discussed.', occurred_at: '2026-09-05T10:00:00Z' });
  assert.equal(n.status, 201);
  const plain = await admin.get(`/api/notes?client_id=${clientId}&kind=clinical`);
  assert.equal(plain.status, 200); assert.ok(!plain.data.rows.some(x => x.id === n.data.id), 'hidden without a reason');
  const glass = await admin.get(`/api/notes?client_id=${clientId}&kind=clinical`, { 'X-Break-Glass-Reason': 'Privacy officer request #12' });
  assert.ok(glass.data.rows.some(x => x.id === n.data.id), 'visible with a documented reason');
  const row = H.db.one(`SELECT details FROM audit_log WHERE action='note.list.breakglass' ORDER BY id DESC LIMIT 1`);
  assert.ok(row && /Privacy officer/.test(row.details), 'and the reason is in the audit log');
});

test('a supervisor can approve a batch of staff time from the queue', async () => {
  // Regression: the validator's array branch referenced an undefined variable, so every request through
  // /api/time/approve-batch -- the only endpoint the Supervision page calls, for single rows too -- was a
  // 500. No staff time could be approved through the UI at all.
  const a = await nav.post('/api/time', { work_date: '2026-09-03', minutes: 60, category: 'direct_service', client_id: clientId });
  const b = await nav.post('/api/time', { work_date: '2026-09-04', minutes: 45, category: 'documentation' });
  for (const t of [a, b]) assert.equal((await nav.post(`/api/time/${t.data.id}/submit`, {})).status, 200);
  const own = await sup.post('/api/time', { work_date: '2026-09-04', minutes: 30, category: 'supervision' });
  await sup.post(`/api/time/${own.data.id}/submit`, {});
  const r = await sup.post('/api/time/approve-batch', { ids: [a.data.id, b.data.id, own.data.id], decision: 'approved' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.approved, 2);
  assert.equal(r.data.skipped.length, 1, 'the supervisor\'s own entry is skipped, not approved');
  assert.equal(H.db.one(`SELECT status FROM time_entries WHERE id=?`, a.data.id).status, 'approved');
  const tooMany = await sup.post('/api/time/approve-batch', { ids: Array.from({ length: 501 }, (_, i) => `x${i}`), decision: 'approved' });
  assert.equal(tooMany.status, 400, 'the batch size limit is enforced rather than crashing');
});

test('a supervisor sees their team\'s unfinished work, not just their own', async () => {
  await trainee.post('/api/notes', { client_id: clientId, kind: 'clinical', content: 'Left as a draft.', occurred_at: '2026-09-03T10:00:00Z' });
  const q = await sup.get('/api/supervision/queue');
  assert.ok(q.data.unsigned_notes.length >= 1, 'the queue shows the team\'s drafts');
  // The dashboard alert for a supervisor counts the team's drafts too -- it used to count only their own,
  // which for a program manager who writes no routine notes meant it never showed anything.
  const dash = await sup.get('/api/reports/dashboard');
  assert.equal(dash.data.notes.team, true);
  assert.ok(dash.data.notes.unsigned >= 1, 'the dashboard alert sees the trainee\'s draft');
  const own = await trainee.get('/api/reports/dashboard');
  assert.equal(own.data.notes.team, false, 'a clinician\'s alert is still just their own drafts');
  assert.ok(q.data.unsigned_notes.every(n => n.author), 'each one names its author');
  // A navigator has no supervision queue at all.
  assert.equal((await nav.get('/api/supervision/queue')).status, 403);
});

test('discharge closes the episode, ends assignments and clears the open work', async () => {
  // Intake now opens an episode by itself (see the navigator-fixes tests); this test manages its own.
  const c = (await nav.post('/api/clients', { first_name: 'Dis', last_name: 'Charge', intake_date: '2026-01-10', no_episode: true })).data.id;
  const ep = await nav.post(`/api/clients/${c}/episodes`, { opened_at: '2026-01-10', referral_source: 'jail', presenting_problem: 'Opioid use, no housing' });
  assert.equal(ep.status, 201);
  assert.equal((await nav.post(`/api/clients/${c}/episodes`, {})).status, 400, 'only one episode open at a time');
  await nav.post('/api/tasks', { client_id: c, title: 'Book intake', due_at: '2026-02-01' });

  const close = await nav.post(`/api/episodes/${ep.data.id}/close`, { discharge_reason: 'completed', discharge_disposition: 'Outpatient, County OTP', discharge_summary: 'Completed the programme.' });
  assert.equal(close.status, 200);
  assert.ok(close.data.ended_assignments >= 1, 'assignments were ended');
  assert.ok(close.data.cancelled_tasks >= 1, 'open to-dos were cancelled rather than left overdue forever');

  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, c);
  assert.equal(row.status, 'closed');
  assert.equal(row.discharge_reason, 'completed');
  const e = H.db.one(`SELECT * FROM episodes WHERE id=?`, ep.data.id);
  assert.equal(e.status, 'closed');
  assert.match(e.discharge_summary_enc, /^v1:/, 'the discharge summary is encrypted');
  assert.equal((await nav.post(`/api/episodes/${ep.data.id}/close`, { discharge_reason: 'completed' })).status, 400, 'closing twice is refused');

  // Re-opening service brings the client back rather than leaving them closed forever.
  assert.equal((await nav.post(`/api/clients/${c}/episodes`, { opened_at: '2026-06-01' })).status, 201);
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, c).status, 'active');
});

test('opening an episode does not silently reactivate a client set inactive on purpose', async () => {
  const c = (await nav.post('/api/clients', { first_name: 'On', last_name: 'Hold', intake_date: '2026-01-10', no_episode: true })).data.id;
  await nav.put(`/api/clients/${c}`, { status: 'inactive' });
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, c).status, 'inactive');
  assert.equal((await nav.post(`/api/clients/${c}/episodes`, { opened_at: '2026-06-01' })).status, 201);
  assert.equal(H.db.one(`SELECT status FROM clients WHERE id=?`, c).status, 'inactive', 'inactive is a deliberate choice, unlike closed — an episode must not override it');
});

test('a whole caseload moves when a worker leaves', async () => {
  const a = (await nav.post('/api/clients', { first_name: 'Trans', last_name: 'Fer1' })).data.id;
  const b = (await nav.post('/api/clients', { first_name: 'Trans', last_name: 'Fer2' })).data.id;
  await nav.post('/api/tasks', { client_id: a, title: 'Follow up', due_at: '2026-10-01', assigned_to: navId });

  assert.equal((await nav.post('/api/caseload/transfer', { from_user_id: navId, to_user_id: nav2Id })).status, 403, 'a navigator cannot reassign caseloads');
  const r = await sup.post('/api/caseload/transfer', { from_user_id: navId, to_user_id: nav2Id, reason: 'left the programme', reassign_open_tasks: true });
  assert.equal(r.status, 200);
  assert.ok(r.data.transferred >= 2, 'every open assignment moved');

  for (const id of [a, b]) {
    assert.ok(H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND end_date IS NULL`, id, nav2Id), 'the receiving worker holds the client');
    assert.ok(!H.db.one(`SELECT 1 FROM assignments WHERE client_id=? AND user_id=? AND end_date IS NULL`, id, navId), 'the departing worker no longer does');
  }
  assert.equal((await nav.get(`/api/clients/${a}`)).status, 403, 'and cannot reach them any more');
  assert.equal((await nav2.get(`/api/clients/${a}`)).status, 200);
  assert.equal((await sup.post('/api/caseload/transfer', { from_user_id: navId, to_user_id: navId })).status, 400);
});

test('entering the same person twice is caught, and duplicates can be merged', async () => {
  const first = await nav2.post('/api/clients', { first_name: 'Maria', last_name: 'Sandoval', dob: '1985-04-04', phone: '555-0147' });
  assert.equal(first.status, 201);

  // Same surname and date of birth: refused until the worker looks at the match.
  const dup = await nav2.post('/api/clients', { first_name: 'Maria', last_name: 'Sandoval', dob: '1985-04-04' });
  assert.equal(dup.status, 400);
  assert.ok(dup.data.duplicates.length >= 1, 'the existing record is offered');
  assert.ok(dup.data.duplicates[0].reasons.includes('same surname and date of birth'));

  // A phone match alone is enough to warn on.
  const byPhone = await nav2.post('/api/clients/check-duplicates', { first_name: 'M', last_name: 'Sandovol', phone: '5550147' });
  assert.ok(byPhone.data.matches.length >= 1);

  // Confirming creates it anyway — sometimes two people really do share a name and birthday.
  const second = await nav2.post('/api/clients', { first_name: 'Maria', last_name: 'Sandoval', dob: '1985-04-04', confirm_duplicate: true });
  assert.equal(second.status, 201);

  await nav2.post('/api/interventions', { client_id: second.data.id, type: 'outreach', occurred_at: '2026-09-04T10:00:00Z', duration_minutes: 20 });
  assert.equal((await nav2.post(`/api/clients/${first.data.id}/merge`, { source_id: second.data.id })).status, 403, 'merging needs more than clients:write');

  const merged = await sup.post(`/api/clients/${first.data.id}/merge`, { source_id: second.data.id, reason: 'same person, entered twice' });
  assert.equal(merged.status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, first.data.id).n, 1, 'the service record moved to the kept client');
  assert.equal(H.db.one(`SELECT merged_into FROM clients WHERE id=?`, second.data.id).merged_into, first.data.id);
  const list = await nav2.get('/api/clients?limit=200');
  assert.ok(!list.data.clients.some(c => c.id === second.data.id), 'the merged-away record disappears from the list');
  assert.equal((await sup.post(`/api/clients/${first.data.id}/merge`, { source_id: second.data.id })).status, 400, 'merging it again is refused');
});

test('search survives a typo and a partial surname', async () => {
  await nav2.post('/api/clients', { first_name: 'Thanh', last_name: 'Nguyen', dob: '1992-02-02', confirm_duplicate: true });
  const exact = await nav2.get('/api/clients?q=Nguyen');
  assert.ok(exact.data.clients.length >= 1, 'exact surname still works');
  const typo = await nav2.get('/api/clients?q=Nguyan');
  assert.ok(typo.data.clients.length >= 1, 'a misspelling still finds them');
  const partial = await nav2.get('/api/clients?q=Ngu');
  assert.ok(partial.data.clients.length >= 1, 'the first few letters are enough');
  const unrelated = await nav2.get('/api/clients?q=Zzzzqqq');
  assert.equal(unrelated.data.clients.length, 0, 'and it does not match everything');
  // Nothing about the name reaches the audit trail.
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.list' ORDER BY id DESC LIMIT 1`);
  assert.ok(!String(a.details).includes('Nguyen'));
});

test('the funder report counts people once, and counts overdose events', async () => {
  const c = (await nav2.post('/api/clients', { first_name: 'Count', last_name: 'Once', intake_date: '2026-09-01', race_codes: 'white,other', confirm_duplicate: true })).data.id;
  await nav2.post(`/api/clients/${c}/episodes`, { opened_at: '2026-09-01' });
  for (const d of ['2026-09-05T10:00:00Z', '2026-09-06T10:00:00Z', '2026-09-07T10:00:00Z']) {
    await nav2.post('/api/interventions', { client_id: c, type: 'case_management', occurred_at: d, duration_minutes: 30 });
  }
  await nav2.post('/api/overdose-events', { client_id: c, occurred_at: '2026-09-08T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 2, administered_by: 'bystander', survived: true });
  // A community reversal with nobody identified — previously impossible to record.
  const community = await nav2.post('/api/overdose-events', { occurred_at: '2026-09-09T10:00:00Z', kind: 'reversal', naloxone_used: true, naloxone_doses: 1, administered_by: 'first_responder', city: 'Marysville' });
  assert.equal(community.status, 201);

  const rep = await admin.get('/api/reports/funder?from=2026-09-01&to=2026-09-30');
  assert.equal(rep.status, 200);
  assert.ok(rep.data.unduplicated.served >= 1);
  const services = H.db.one(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, c).n;
  assert.equal(services, 3, 'three services');
  // Three services, one person: the "served" count must not move with the number of visits.
  const servedBefore = rep.data.unduplicated.served;
  await nav2.post('/api/interventions', { client_id: c, type: 'case_management', occurred_at: '2026-09-11T10:00:00Z', duration_minutes: 30 });
  const again = await admin.get('/api/reports/funder?from=2026-09-01&to=2026-09-30');
  assert.equal(again.data.unduplicated.served, servedBefore, 'a fourth service does not make a fifth person');
  assert.equal(rep.data.overdose.reversals, 2);
  assert.equal(rep.data.overdose.community_reported, 1);
  assert.equal(rep.data.overdose.naloxone_doses, 3);
  assert.ok(rep.data.demographics.by_race_code.some(x => x.k === 'white'), 'race is countable, not free text');
  assert.ok(rep.data.demographics.by_race_code.some(x => x.k === 'other'), 'and a person may report more than one');
  assert.ok(Array.isArray(rep.data.by_funding_source));
  assert.ok(rep.data.episodes.admissions >= 1);
});

test('a client-less intervention records community naloxone distribution', async () => {
  const r = await nav2.post('/api/interventions', { type: 'naloxone_distribution', occurred_at: '2026-09-10T10:00:00Z', naloxone_kits: 40, duration_minutes: 120 });
  assert.equal(r.status, 201, 'no client is required for community distribution');
  const rep = await admin.get('/api/reports/funder?from=2026-09-01&to=2026-09-30');
  assert.ok(rep.data.naloxone_distribution.community_kits >= 40, 'and it is counted separately in the funder report');
});

test('a new installation can put a Part 2 consent form in the library', async () => {
  // Shipping with an empty form library meant a county had no consent form at all — and no substance use
  // record can lawfully be shared without one.
  const before = await admin.get('/api/forms/starters');
  assert.equal(before.status, 200);
  assert.ok(before.data.starters.some(s => s.key === 'part2_consent'), 'a 42 CFR Part 2 consent is offered');
  assert.ok(before.data.starters.every(s => !s.installed), 'nothing is installed until asked for');
  assert.equal((await nav.get('/api/forms/starters')).status, 403, 'only someone who manages forms can install them');

  const r = await admin.post('/api/forms/starters', { keys: ['part2_consent', 'naloxone_log'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.added.length, 2);

  const templates = (await admin.get('/api/forms/templates')).data.templates;
  const consent = templates.find(t => t.name.includes('42 CFR Part 2'));
  assert.ok(consent, 'the consent form is in the library');
  const full = (await admin.get(`/api/forms/templates/${consent.id}`)).data.template;
  const keys = full.fields.map(f => f.key);
  // The elements 42 CFR 2.31 actually requires.
  for (const required of ['recipient', 'purpose', 'info', 'expires', 'client_sig']) assert.ok(keys.includes(required), `the consent asks for ${required}`);
  assert.match(full.instructions, /redisclosure|Part 2/i, 'the redisclosure notice travels with it');

  // Installing twice does not duplicate anything.
  const again = await admin.post('/api/forms/starters', {});
  assert.ok(!again.data.added.some(a => a.key === 'part2_consent'), 'an already-installed form is not added twice');
  assert.equal((await admin.get('/api/forms/templates')).data.templates.filter(t => t.name.includes('42 CFR Part 2')).length, 1);

  // And it prints, which is what a client actually signs.
  const pdf = await admin.get(`/api/forms/templates/${consent.id}/blank.pdf`);
  assert.equal(pdf.status, 200);
});

test('the health endpoint reports on the database, not just the listener', async () => {
  // The Docker healthcheck used /api/meta/constants, which returns a static object: it proved the process
  // was up and nothing else.
  const c = H.client();
  const r = await c.get('/api/health');
  assert.equal(r.status, 200, 'it is reachable without signing in, for a monitor');
  assert.equal(r.data.ok, true);
  assert.equal(r.data.database, 'ok');
  assert.ok(r.data.schema_version >= 7);
  assert.ok(typeof r.data.uptime_seconds === 'number');
  // It must not leak anything about the installation.
  const body = JSON.stringify(r.data);
  assert.ok(!/password|key|secret|client/i.test(body.replace(/schema_version|database/gi, '')), 'it says nothing sensitive');
  // The quiet failures: a broken audit chain and a backup schedule that stopped running are both "not ok".
  H.db.setSetting('audit_verify_failed_at', '2026-09-01T00:00:00.000Z');
  H.db.setSetting('backup_schedule_hours', '24'); H.db.setSetting('last_scheduled_backup_at', '2026-01-01T00:00:00.000Z');
  const bad = await c.get('/api/health');
  assert.equal(bad.status, 503);
  assert.ok(bad.data.warnings.some(w => /audit log/.test(w)), 'names the audit failure');
  assert.ok(bad.data.warnings.some(w => /Scheduled backups/.test(w)), 'and the stale backup');
  H.db.run(`DELETE FROM settings WHERE key IN ('audit_verify_failed_at','backup_schedule_hours','last_scheduled_backup_at')`);
  assert.equal((await c.get('/api/health')).status, 200);
});

test('a server started with the wrong encryption key refuses the database instead of running blind', () => {
  // Regression: a data folder copied without its keys.json used to boot with freshly minted keys and look
  // healthy while every record had become unreadable.
  const config = require('../server/config');
  assert.equal(H.db.checkKeyFingerprint().first, true, 'the first check records this key');
  assert.equal(H.db.checkKeyFingerprint().first, false, 'and the same key passes');
  const real = config.encryptionKey;
  config.encryptionKey = Buffer.alloc(32, 7);
  try { assert.throws(() => H.db.checkKeyFingerprint(), /not the key this database was written with/); }
  finally { config.encryptionKey = real; H.db.run(`DELETE FROM settings WHERE key='key_fingerprint'`); }
});
