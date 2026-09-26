'use strict';
// Front-line friction (1.11 hands-on review): signing with recent re-authentication instead of retyping the
// password every time, countersigning several notes at once, client names in the supervision queue for
// the roles that may open the client, the "no outcome recorded yet" list, and the consent a referral will
// rely on (pre-selected when exactly one live consent names the provider; a warning for a duplicate).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { totp } = require('../server/crypto');

const PW = 'StaffPassw0rd!x';
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary and MAT status', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
let admin, nav, sup, fin, trainee, navId, traineeId, clientId;
before(async () => {
  await H.start();
  navId = H.makeUser('flnav', 'navigator').id;
  H.makeUser('flsup', 'supervisor'); H.makeUser('flfin', 'finance');
  traineeId = H.makeUser('fltrainee', 'clinician').id;
  H.db.run(`UPDATE users SET requires_cosign=1 WHERE id=?`, traineeId);
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('flnav', PW);
  sup = H.client(); await sup.login('flsup', PW);
  fin = H.client(); await fin.login('flfin', PW);
  trainee = H.client(); await trainee.login('fltrainee', PW);
  clientId = (await nav.post('/api/clients', { first_name: 'Rosa', last_name: 'Frontline' })).data.id;
  await admin.post(`/api/clients/${clientId}/assignments`, { user_id: traineeId, role_on_case: 'clinician' });
});
after(H.stop);

const draft = async (c, extra = {}) => (await c.post('/api/notes', { client_id: clientId, kind: 'admin', title: 'Visit', content: 'Met at the drop-in centre.', occurred_at: new Date().toISOString(), ...extra })).data.id;
const sessionOf = (userId) => H.db.one(`SELECT * FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, userId);
const makeStale = (userId, minutes = 30) => H.db.run(`UPDATE sessions SET reauth_at=? WHERE user_id=? AND revoked_at IS NULL`, new Date(Date.now() - minutes * 60000).toISOString(), userId);

test('a sign-in records when the session last proved who it is', async () => {
  const s = sessionOf(navId);
  assert.ok(s.reauth_at, 'the password sign-in counts as a re-authentication');
  const st = (await nav.get('/api/auth/reauth')).data;
  assert.equal(st.recent, true); assert.equal(st.method, 'password'); assert.equal(st.window_minutes, 10);
});

test('signing just after signing in needs only the confirmation, and the audit says how identity was established', async () => {
  const id = await draft(nav);
  assert.equal((await nav.post(`/api/notes/${id}/sign`, {})).status, 400, 'neither a password nor a confirmation: refused');
  const r = await nav.post(`/api/notes/${id}/sign`, { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const n = H.db.one(`SELECT status, signature_hash FROM notes WHERE id=?`, id);
  assert.equal(n.status, 'signed'); assert.ok(n.signature_hash, 'the note is locked with its hash as before');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, id);
  assert.equal(JSON.parse(a.details).identity, 'recent_auth');
});

test('a stale session must give the password again; a right one refreshes the window, a wrong one is refused', async () => {
  makeStale(navId);
  assert.equal((await nav.get('/api/auth/reauth')).data.recent, false);
  const id = await draft(nav);
  const stale = await nav.post(`/api/notes/${id}/sign`, { confirm: true });
  assert.equal(stale.status, 403); assert.equal(stale.data.reauthRequired, true); assert.equal(stale.data.method, 'password');
  assert.equal(H.db.one(`SELECT status FROM notes WHERE id=?`, id).status, 'draft', 'nothing was signed');
  assert.equal((await nav.post(`/api/notes/${id}/sign`, { password: 'wrong' })).status, 403);
  const ok = await nav.post(`/api/notes/${id}/sign`, { password: PW });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, id).details).identity, 'password');
  assert.equal((await nav.get('/api/auth/reauth')).data.recent, true, 'the password just given opens the window again');
  const next = await draft(nav);
  assert.equal((await nav.post(`/api/notes/${next}/sign`, { confirm: true })).status, 200, 'so the next note needs only the confirmation');
});

test('the window is a setting; 0 asks for the password every time', async () => {
  assert.equal((await admin.put('/api/admin/settings', { sign_reauth_minutes: 0 })).status, 200);
  const id = await draft(nav);
  assert.equal((await nav.post(`/api/notes/${id}/sign`, { confirm: true })).data.reauthRequired, true);
  assert.equal((await admin.put('/api/admin/settings', { sign_reauth_minutes: 90 })).status, 400, 'no longer than an hour');
  assert.equal((await admin.put('/api/admin/settings', { sign_reauth_minutes: null })).status, 200);
  assert.equal((await nav.post(`/api/notes/${id}/sign`, { confirm: true })).status, 200, 'back to the default of 10 minutes');
});

test('with two-step verification on, a stale session re-authenticates with the authenticator code', async () => {
  const u = H.makeUser('flmfa', 'navigator');
  const c = H.client(); await c.login('flmfa', PW);
  const setup = await c.post('/api/auth/mfa/setup', {});
  assert.equal((await c.post('/api/auth/mfa/enable', { code: totp(setup.data.secret) })).status, 200);
  await admin.post(`/api/clients/${clientId}/assignments`, { user_id: u.id, role_on_case: 'secondary' });
  makeStale(u.id);
  const id = await draft(c);
  const r = await c.post(`/api/notes/${id}/sign`, { confirm: true });
  assert.equal(r.status, 403); assert.equal(r.data.method, 'totp', 'the form asks for the code, not the password');
  assert.equal((await c.post(`/api/notes/${id}/sign`, { code: '000000' })).status, 403);
  assert.equal((await c.post(`/api/notes/${id}/sign`, { code: totp(setup.data.secret) })).status, 200);
  assert.equal(JSON.parse(H.db.one(`SELECT details FROM audit_log WHERE action='note.sign' AND entity_id=?`, id).details).identity, 'totp');
  // The code a session's sign-in completed with counts as a re-authentication as well.
  const fresh = H.client(); await fresh.login('flmfa', PW);
  await fresh.post('/api/auth/mfa/verify', { code: totp(setup.data.secret) });
  assert.equal((await fresh.get('/api/auth/reauth')).data.recent, true);
});

test('a supervisor countersigns several notes at once: one re-authentication, each signature audited on its own', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) { const id = await draft(trainee, { title: `Trainee visit ${i}` }); assert.equal((await trainee.post(`/api/notes/${id}/sign`, { confirm: true })).status, 200); ids.push(id); }
  const own = await draft(sup); await sup.post(`/api/notes/${own}/sign`, { confirm: true });
  assert.equal((await nav.post('/api/notes/cosign-batch', { ids, confirm: true })).status, 403, 'a navigator cannot countersign');
  makeStale(sessionOf(H.db.one(`SELECT id FROM users WHERE username='flsup'`).id).user_id);
  const stale = await sup.post('/api/notes/cosign-batch', { ids, confirm: true });
  assert.equal(stale.status, 403); assert.equal(stale.data.reauthRequired, true);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM notes WHERE id IN (?,?,?) AND cosigned_at IS NOT NULL`, ...ids).n, 0, 'nothing countersigned without it');
  const comments = Object.fromEntries(ids.map((id, i) => [id, `Reviewed in supervision ${i}`]));
  const r = await sup.post('/api/notes/cosign-batch', { ids: [...ids, own, 'no-such-note'], password: PW, comments });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([...r.data.cosigned].sort(), [...ids].sort());
  assert.equal(r.data.skipped.length, 2, 'their own note and an unknown id are skipped, with a reason');
  assert.ok(r.data.skipped.every(s => s.reason && !/Reviewed/.test(s.reason)));
  for (const id of ids) {
    const n = H.db.one(`SELECT cosigned_at, cosignature_hash, cosign_note_enc FROM notes WHERE id=?`, id);
    assert.ok(n.cosigned_at && n.cosignature_hash && n.cosign_note_enc, 'each note carries its own countersignature');
    assert.equal((await sup.get(`/api/notes/${id}`)).data.note.cosign_note, comments[id], 'and its own comment, not another note\'s');
    const a = H.db.all(`SELECT details FROM audit_log WHERE action='note.cosign' AND entity_id=?`, id);
    assert.equal(a.length, 1); assert.equal(JSON.parse(a[0].details).batch, true);
    assert.ok(!/Reviewed in supervision/.test(a[0].details), 'the comment stays out of the audit entry');
  }
  assert.equal((await sup.get('/api/supervision/queue')).data.awaiting_cosignature.filter(x => ids.includes(x.id)).length, 0, 'they leave the queue');
});

test('a batch countersignature never copies one comment onto notes about different clients', async () => {
  const other = (await nav.post('/api/clients', { first_name: 'Ines', last_name: 'Otherclient' })).data.id;
  await admin.post(`/api/clients/${other}/assignments`, { user_id: traineeId, role_on_case: 'clinician' });
  const a = await draft(trainee, { title: 'Visit A' }); await trainee.post(`/api/notes/${a}/sign`, { confirm: true });
  const b = await draft(trainee, { title: 'Visit B', client_id: other }); await trainee.post(`/api/notes/${b}/sign`, { confirm: true });
  const shared = await sup.post('/api/notes/cosign-batch', { ids: [a, b], password: PW, note: 'Talked about the housing application' });
  assert.equal(shared.status, 400, 'one shared comment across two clients is refused');
  assert.match(shared.data.error, /different clients/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM notes WHERE id IN (?,?) AND cosigned_at IS NOT NULL`, a, b).n, 0, 'and nothing was countersigned');
  assert.equal((await sup.post('/api/notes/cosign-batch', { ids: [a, b], password: PW, comments: { 'not-in-batch': 'x' } })).status, 400, 'a comment for a note outside the batch is refused');
  assert.equal((await sup.post('/api/notes/cosign-batch', { ids: [a, b], password: PW, comments: ['x'] })).status, 400);
  const r = await sup.post('/api/notes/cosign-batch', { ids: [a, b], password: PW, comments: { [a]: 'Housing application discussed' } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.cosigned.length, 2);
  assert.equal((await sup.get(`/api/notes/${a}`)).data.note.cosign_note, 'Housing application discussed');
  assert.ok(!(await sup.get(`/api/notes/${b}`)).data.note.cosign_note, 'the other client\'s note has no comment');
});

test('the supervision queue names the client for roles that can open the client, and only for them', async () => {
  const id = await draft(trainee, { title: 'Needs review' }); await trainee.post(`/api/notes/${id}/sign`, { confirm: true });
  const q = (await sup.get('/api/supervision/queue')).data;
  const row = q.awaiting_cosignature.find(x => x.id === id);
  assert.equal(row.client_name, 'Frontline, Rosa'); assert.ok(row.client_code);
  const d = await draft(trainee, { title: 'Unfinished' });
  assert.equal(q.unsigned_notes.length >= 0, true);
  assert.equal((await sup.get('/api/supervision/queue')).data.unsigned_notes.find(x => x.id === d).client_name, 'Frontline, Rosa');
  // Finance approves time but cannot open a client: the queue gives it the code and nothing else.
  const t = await trainee.post('/api/time', { work_date: '2026-09-01', minutes: 30, category: 'direct_service', client_id: clientId });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  await trainee.post(`/api/time/${t.data.id}/submit`, {});
  const fq = (await fin.get('/api/supervision/queue')).data;
  const tr = fq.time_awaiting_approval.find(x => x.id === t.data.id);
  assert.ok(tr.client_code); assert.equal(tr.client_name, null);
  assert.ok(!JSON.stringify(fq).includes('Frontline'), 'no name anywhere in finance\'s queue');
  // A supervisor does see it on the time row.
  assert.equal((await sup.get('/api/supervision/queue')).data.time_awaiting_approval.find(x => x.id === t.data.id).client_name, 'Frontline, Rosa');
});

test('"No outcome recorded yet" leaves out referrals whose status already is the outcome', async () => {
  const res = (await sup.post('/api/resources', { name: 'Outcome Detox', category: 'detox_withdrawal_mgmt' })).data.id;
  await sup.post(`/api/clients/${clientId}/consents`, { type: 'part2_disclosure', recipient: 'Outcome Detox', purpose: 'Referral', ...ELEMENTS });
  const consent = H.db.one(`SELECT id FROM consents WHERE client_id=? ORDER BY created_at DESC LIMIT 1`, clientId).id;
  const mk = async (status) => { const r = await sup.post('/api/referrals', { client_id: clientId, resource_id: res, referred_at: new Date().toISOString(), status, consent_id: consent }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  const scheduled = await mk('scheduled'); const completed = await mk('completed'); const admitted = await mk('admitted'); const noShow = await mk('no_show');
  const open = (await sup.get('/api/supervision/queue')).data.referrals_awaiting_outcome.map(x => x.id);
  assert.ok(open.includes(scheduled), 'a scheduled referral is still waiting for its outcome');
  for (const id of [completed, admitted, noShow]) assert.ok(!open.includes(id), 'a completed, admitted or no-show referral is not');
  const row = (await sup.get('/api/supervision/queue')).data.referrals_awaiting_outcome.find(x => x.id === scheduled);
  assert.equal(row.client_name, 'Frontline, Rosa');
});

test('the consents list says which live consents name a given provider', async () => {
  const c2 = (await nav.post('/api/clients', { first_name: 'Cora', last_name: 'Consent' })).data.id;
  const res = (await nav.post('/api/resources', { name: 'Harbor OTP', organization: 'Harbor Health', category: 'mat_otp' })).data.id;
  const other = (await nav.post('/api/resources', { name: 'Elm Housing', category: 'housing' })).data.id;
  await nav.post(`/api/clients/${c2}/consents`, { type: 'part2_disclosure', recipient: 'Harbor Health', purpose: 'Referral', ...ELEMENTS });
  await nav.post(`/api/clients/${c2}/consents`, { type: 'part2_disclosure', recipient: 'Somewhere Else', purpose: 'Referral', ...ELEMENTS });
  const list = (await nav.get(`/api/clients/${c2}/consents?resource_id=${res}`)).data;
  assert.equal(list.consents.filter(c => c.names_resource).length, 1);
  assert.equal(list.consents.find(c => c.names_resource).recipient, 'Harbor Health', 'matched through the provider\'s organisation');
  assert.equal(list.suggested_consent_id, list.consents.find(c => c.names_resource).id, 'exactly one: it is the suggestion');
  assert.equal((await nav.get(`/api/clients/${c2}/consents?resource_id=${other}`)).data.suggested_consent_id, null);
  await nav.post(`/api/clients/${c2}/consents`, { type: 'part2_disclosure', recipient: 'Harbor OTP', purpose: 'Referral', ...ELEMENTS });
  const two = (await nav.get(`/api/clients/${c2}/consents?resource_id=${res}`)).data;
  assert.equal(two.consents.filter(c => c.names_resource).length, 2);
  assert.equal(two.suggested_consent_id, null, 'two consents name it: nothing is chosen for the worker');
  assert.equal((await nav.get(`/api/clients/${c2}/consents`)).data.suggested_consent_id, undefined, 'without a provider the list is as before');
});

test('recording a consent that duplicates a live one is warned about, not blocked', async () => {
  const c3 = (await nav.post('/api/clients', { first_name: 'Dee', last_name: 'Duplicate' })).data.id;
  const first = (await nav.post(`/api/clients/${c3}/consents`, { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'Referral', ...ELEMENTS })).data.id;
  const same = { type: 'part2_disclosure', recipient: '  county otp ', signed_at: '2026-09-10', expires_at: '2027-01-01' };
  const r = await nav.post(`/api/clients/${c3}/consents/duplicates`, same);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.duplicates.map(d => d.id), [first]);
  assert.equal((await nav.post(`/api/clients/${c3}/consents/duplicates`, { ...same, type: 'roi' })).data.duplicates.length, 0, 'another type is not a duplicate');
  assert.equal((await nav.post(`/api/clients/${c3}/consents/duplicates`, { ...same, recipient: 'Other OTP' })).data.duplicates.length, 0, 'nor another recipient');
  assert.equal((await nav.post(`/api/clients/${c3}/consents/duplicates`, { ...same, signed_at: '2099-10-01', expires_at: '2100-01-01' })).data.duplicates.length, 0, 'nor dates that do not overlap');
  const revoked = (await nav.post(`/api/clients/${c3}/consents`, { type: 'roi', recipient: 'Clinic', purpose: 'x', signed_at: '2026-09-01' })).data.id;
  await nav.post(`/api/consents/${revoked}/revoke`, {});
  assert.equal((await nav.post(`/api/clients/${c3}/consents/duplicates`, { type: 'roi', recipient: 'Clinic', signed_at: '2026-09-05' })).data.duplicates.length, 0, 'a revoked consent is not live');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='consent.duplicate_check' AND client_id=?`, c3), 'the check reads consents, so it is audited');
  // Not blocked: the worker may still record it.
  assert.equal((await nav.post(`/api/clients/${c3}/consents`, { ...ELEMENTS, ...same, purpose: 'Referral' })).status, 201);
  assert.equal((await fin.post(`/api/clients/${c3}/consents/duplicates`, same)).status, 403);
});

test('the programme\'s usual consent: a supervisor saves it, anyone recording consents can read it', async () => {
  assert.equal((await nav.get('/api/consent-template')).data.template, null, 'none to begin with');
  const t = { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'Referral for treatment', scope: 'Referral summary', expires_days: 365, info_categories: ['demographics', 'referrals'] };
  assert.equal((await nav.put('/api/consent-template', t)).status, 403, 'a navigator cannot set it');
  assert.equal((await fin.put('/api/consent-template', t)).status, 403);
  assert.equal((await sup.put('/api/consent-template', { ...t, info_categories: ['nonsense'] })).status, 400);
  assert.equal((await sup.put('/api/consent-template', { ...t, expires_days: 0 })).status, 400);
  const r = await sup.put('/api/consent-template', t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = (await nav.get('/api/consent-template')).data.template;
  assert.equal(got.recipient, 'County OTP'); assert.equal(got.expires_days, 365); assert.deepEqual(got.info_categories, ['demographics', 'referrals']);
  assert.equal((await fin.get('/api/consent-template')).status, 403, 'finance does not record consents');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='consent.template.save'`));
});
