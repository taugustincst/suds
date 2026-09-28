'use strict';
// 1.14.0 usability review of the forms: the API behind the lighter visit, time, supplies and re-admission forms.
//  * A visit can carry its note (POST /api/interventions { note }): one request, both saved or neither, the note
//    an ordinary draft linked to the visit and its client, under the Note form's permissions, encryption and audit.
//  * Time entries say where they came from (source: visit | call | manual), and the list filters on it, so the
//    time form can warn before visit-logged time is typed in again.
//  * The supplies catalog says whether the caller can add the standard items from the visit form (can_configure).
//  * A re-admission reason needs 8 characters (was 15, the break-glass minimum, which is a different act).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;

let nav, sup, clin, navUser, clientId;
const today = new Date().toISOString().slice(0, 10);
const count = (sql, ...p) => db.one(sql, ...p).n;
before(async () => {
  await H.start();
  navUser = H.makeCaseloadUser('uf_nav', 'navigator'); H.makeUser('uf_sup', 'supervisor'); H.makeUser('uf_clin', 'clinician');
  nav = H.client(); await nav.login('uf_nav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('uf_sup', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('uf_clin', 'StaffPassw0rd!x');
  const c = await nav.post('/api/clients', { first_name: 'Fern', last_name: 'Fieldnote', dob: '1988-03-04' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  clientId = c.data.id;
});
after(async () => { await H.stop(); });

test('a visit saved with its note: one request, a draft note linked to the visit, encrypted and audited', async () => {
  const text = 'Talked about moving into the shelter on 5th; wants a detox bed next week.';
  const r = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: new Date().toISOString(), duration_minutes: 20, summary: 'Check-in',
    note: { kind: 'admin', format: 'narrative', title: 'Housing', content: text, part2_protected: true } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.note_id, 'the response names the note');
  const n = db.one(`SELECT * FROM notes WHERE id=?`, r.data.note_id);
  assert.equal(n.intervention_id, r.data.id, 'linked to the visit');
  assert.equal(n.client_id, clientId, 'and to its client');
  assert.equal(n.status, 'draft', 'a draft, signed later from Notes');
  assert.equal(n.author_id, navUser.id);
  assert.equal(n.part2_protected, 1);
  assert.ok(n.content_enc && !n.content_enc.includes('shelter'), 'the text is stored encrypted');
  assert.equal(db.one(`SELECT occurred_at FROM interventions WHERE id=?`, r.data.id).occurred_at, n.occurred_at, 'on the visit\'s date');
  const a = db.one(`SELECT details FROM audit_log WHERE action='note.create' AND entity_id=?`, r.data.note_id);
  assert.ok(a, 'the note is audited as any note is');
  assert.match(a.details, /"with_visit":true/);
  assert.ok(!a.details.includes('shelter'), 'with no note text in the audit details');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='intervention.create' AND entity_id=?`, r.data.id), 'and the visit too');
  const got = await nav.get(`/api/notes/${r.data.note_id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.note.content, text, 'and reads back through the notes API');
});

test('a note the author may not write, or that is incomplete, leaves nothing saved', async () => {
  const visits = () => count(`SELECT COUNT(*) n FROM interventions WHERE client_id=?`, clientId);
  const notes = () => count(`SELECT COUNT(*) n FROM notes WHERE client_id=?`, clientId);
  const before = [visits(), notes()];
  const base = { client_id: clientId, type: 'case_management', occurred_at: new Date().toISOString() };
  // A navigator cannot author clinical notes: the whole save is refused, not the visit saved without its note.
  const clinical = await nav.post('/api/interventions', { ...base, note: { kind: 'clinical', content: 'Assessment of withdrawal symptoms.' } });
  assert.equal(clinical.status, 403, JSON.stringify(clinical.data));
  // A note with no text: named as the visit form names the field.
  const empty = await nav.post('/api/interventions', { ...base, note: { kind: 'admin', content: '' } });
  assert.equal(empty.status, 400);
  assert.ok(empty.data.fields && empty.data.fields.note_content, JSON.stringify(empty.data));
  // A note needs a client; anonymous outreach has no record to put it on.
  const anon = await nav.post('/api/interventions', { type: 'outreach', occurred_at: new Date().toISOString(), note: { kind: 'admin', content: 'Met someone by the river.' } });
  assert.equal(anon.status, 400);
  assert.ok(anon.data.fields && anon.data.fields.client_id);
  assert.equal(count(`SELECT COUNT(*) n FROM interventions WHERE client_id IS NULL AND type='outreach'`), 0, 'the anonymous visit was not saved either');
  // Not a JSON object.
  assert.equal((await nav.post('/api/interventions', { ...base, note: 'text' })).status, 400);
  assert.deepEqual([visits(), notes()], before, 'no visit and no note was written by any of these');
  // A clinician may write the clinical note with the visit, for a client of theirs.
  const own = await clin.post('/api/clients', { first_name: 'Cato', last_name: 'Clinicside', dob: '1970-01-02' });
  assert.equal(own.status, 201, JSON.stringify(own.data));
  const ok = await clin.post('/api/interventions', { ...base, client_id: own.data.id, note: { kind: 'clinical', content: 'Reports cravings easing on buprenorphine.' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(db.one(`SELECT kind FROM notes WHERE id=?`, ok.data.note_id).kind, 'clinical');
});

test('a note is added when the visit is recorded, not by editing one', async () => {
  const v = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: new Date().toISOString() });
  assert.equal(v.status, 201);
  const e = await nav.put(`/api/interventions/${v.data.id}`, { summary: 'Edited', note: { kind: 'admin', content: 'Later thought.' } });
  assert.equal(e.status, 400);
  assert.match(e.data.error, /\+ Note/);
});

test('time entries say where they came from, and the list filters on it', async () => {
  const v = await nav.post('/api/interventions', { client_id: clientId, type: 'case_management', occurred_at: new Date().toISOString(), duration_minutes: 25, log_time: true });
  assert.equal(v.status, 201);
  const manual = await nav.post('/api/time', { work_date: today, minutes: 15, category: 'documentation', client_id: clientId });
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  const all = (await nav.get(`/api/time?from=${today}&to=${today}`)).data.rows;
  const fromVisit = all.find(r => r.intervention_id === v.data.id);
  assert.equal(fromVisit.source, 'visit');
  assert.equal(all.find(r => r.id === manual.data.id).source, 'manual');
  const visitsOnly = (await nav.get(`/api/time?from=${today}&to=${today}&source=visit`)).data.rows;
  assert.ok(visitsOnly.length >= 1 && visitsOnly.every(r => r.source === 'visit'), 'source=visit lists only the visit-logged entries');
  const manualOnly = (await nav.get(`/api/time?from=${today}&to=${today}&source=manual`)).data.rows;
  assert.ok(manualOnly.some(r => r.id === manual.data.id) && manualOnly.every(r => r.source === 'manual'));
  // A manager narrows to one worker (the time form's check for a worker they log time for).
  const forNav = (await sup.get(`/api/time?from=${today}&to=${today}&source=visit&user_id=${navUser.id}`)).data.rows;
  assert.ok(forNav.length >= 1 && forNav.every(r => r.user_id === navUser.id));
  // A worker without time:all still sees only their own time, whatever user_id they ask for.
  const other = H.makeCaseloadUser('uf_nav2', 'navigator'); const nav2 = H.client(); await nav2.login('uf_nav2', 'StaffPassw0rd!x');
  assert.equal((await nav2.get(`/api/time?from=${today}&to=${today}&user_id=${navUser.id}`)).data.rows.length, 0);
  assert.ok(other.id);
});

test('the supplies catalog says whether the visit form may offer to add the standard items', async () => {
  const n = await nav.get('/api/supplies/catalog');
  assert.equal(n.status, 200);
  assert.equal(n.data.can_configure, false, 'a navigator is told to ask a supervisor');
  const s = await sup.get('/api/supplies/catalog');
  assert.equal(s.data.can_configure, true, 'a supervisor (supplies:manage) can add them');
});

test('a re-admission reason needs 8 characters, not 15', async () => {
  const person = { first_name: 'Ivo', last_name: 'Backagain', dob: '1975-11-12' };
  const a = H.makeCaseloadUser('uf_navA', 'navigator'); const navA = H.client(); await navA.login('uf_navA', 'StaffPassw0rd!x');
  const b = H.makeCaseloadUser('uf_navB', 'navigator'); const navB = H.client(); await navB.login('uf_navB', 'StaffPassw0rd!x');
  const c = await navA.post('/api/clients', { ...person, intake_date: '2021-02-01' });
  const ep = db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, c.data.id);
  assert.equal((await navA.post(`/api/episodes/${ep.id}/close`, { discharge_reason: 'lost_contact', closed_at: '2022-03-01' })).status, 200);
  const short = await navB.post(`/api/clients/${c.data.id}/readmit`, { ...person, reason: 'returns' });
  assert.equal(short.status, 400, 'seven characters is not a reason a supervisor can review');
  assert.match(short.data.error, /at least 8 characters/);
  const padded = await navB.post(`/api/clients/${c.data.id}/readmit`, { ...person, reason: '    ok      ' });
  assert.equal(padded.status, 400, 'spaces do not count');
  const r = await navB.post(`/api/clients/${c.data.id}/readmit`, { ...person, reason: 'walked in' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(db.one(`SELECT 1 FROM breakglass_events WHERE client_id=? AND kind='readmission'`, c.data.id), 'still queued for a supervisor\'s review');
  assert.ok(a.id && b.id);
});
