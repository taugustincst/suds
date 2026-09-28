'use strict';
// Security review of 1.13.0, finding 1: the re-admission offer at intake (test/readmit.test.js) answered a
// phone number alone. A navigator typed a number into the live duplicate check and was told a discharged
// client's code, discharge date and discharge reason ("incarcerated") for someone not on their caseload,
// while a number nobody has came back empty, so numbers could be walked. Now a caller who cannot open the
// record is offered it only on surname and date of birth, is told nothing from the stored record (no code,
// no discharge date or reason), a supervisor gets a review task, the check is limited per worker and every
// check is audited. For a phone number alone the answer is the same whether or not a hidden record matches.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const db = H.db;
const { decrypt } = require('../server/crypto');

let navA, navB, sup, navBId, oldId, oldCode;
const person = { first_name: 'Ondine', last_name: 'Phonecheck', dob: '1975-04-04', phone: '555-313-2020' };
before(async () => {
  await H.start();
  H.makeCaseloadUser('ro_navA', 'navigator'); navBId = H.makeCaseloadUser('ro_navB', 'navigator').id; H.makeUser('ro_sup', 'supervisor');
  navA = H.client(); await navA.login('ro_navA', 'StaffPassw0rd!x');
  navB = H.client(); await navB.login('ro_navB', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('ro_sup', 'StaffPassw0rd!x');
  const c = await navA.post('/api/clients', { ...person, intake_date: '2021-02-01' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  oldId = c.data.id; oldCode = c.data.client_code;
  const ep = db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, oldId);
  assert.equal((await navA.post(`/api/episodes/${ep.id}/close`, { discharge_reason: 'incarcerated', closed_at: '2022-03-01' })).status, 200);
  assert.equal(db.one(`SELECT discharge_reason FROM clients WHERE id=?`, oldId).discharge_reason, 'incarcerated');
});
after(() => H.stop());

test('a phone number alone gets the same answer whether or not a discharged record off the caseload has it', async () => {
  const hit = await navB.post('/api/clients/check-duplicates', { last_name: 'Anyname', phone: person.phone });
  const miss = await navB.post('/api/clients/check-duplicates', { last_name: 'Anyname', phone: '555-000-0000' });
  assert.equal(hit.status, 200); assert.equal(miss.status, 200);
  assert.deepEqual(hit.data, miss.data, 'no difference the caller can see');
  assert.deepEqual(hit.data, { matches: [], readmit: [] });
  const body = JSON.stringify(hit.data);
  assert.ok(!body.includes(oldCode) && !body.includes('incarcerated') && !body.includes('2022-03-01'));
  // Nor does a phone number prove who the person is at re-admission.
  const r = await navB.post(`/api/clients/${oldId}/readmit`, { last_name: 'Anyname', phone: person.phone, reason: 'Walked in asking to restart services' });
  assert.equal(r.status, 403);
});

test('surname and date of birth get an offer that carries nothing from the stored record, and a supervisor is asked to review', async () => {
  assert.equal(db.one(`SELECT COUNT(*) n FROM tasks WHERE client_id=? AND created_by=?`, oldId, navBId).n, 0);
  const chk = await navB.post('/api/clients/check-duplicates', { first_name: person.first_name, last_name: person.last_name, dob: person.dob, phone: person.phone });
  assert.equal(chk.status, 200);
  assert.equal(chk.data.matches.length, 0);
  assert.equal(chk.data.readmit.length, 1);
  const offer = chk.data.readmit[0];
  assert.equal(offer.id, oldId);
  for (const k of ['client_code', 'discharge_date', 'discharge_reason', 'status', 'display_name', 'dob', 'phone']) assert.ok(!(k in offer), `no ${k} in the offer`);
  assert.deepEqual(offer.reasons, ['same surname and date of birth'], 'not "same phone number": that would confirm the number on file');
  assert.match(offer.message, /supervisor will be asked to review/);
  assert.ok(!JSON.stringify(chk.data).includes(oldCode));
  // The review task: on the record the worker cannot open, unassigned, high priority, naming the code.
  const tasks = db.all(`SELECT * FROM tasks WHERE client_id=? AND created_by=?`, oldId, navBId);
  assert.equal(tasks.length, 1);
  const t = tasks[0];
  assert.equal(t.assigned_to, null); assert.equal(t.priority, 'high');
  assert.match(decrypt(t.title_enc), new RegExp(`re-admission.*${oldCode}`));
  assert.ok(JSON.stringify((await sup.get('/api/tasks?status=all&limit=1000')).data).includes(oldCode), 'on a supervisor\'s list');
  assert.ok(!JSON.stringify((await navB.get('/api/tasks?status=all&limit=1000')).data).includes(oldCode), 'not on the worker\'s');
  // The check runs as the worker types: asking again does not pile up tasks.
  await navB.post('/api/clients/check-duplicates', { last_name: person.last_name, dob: person.dob });
  assert.equal(db.one(`SELECT COUNT(*) n FROM tasks WHERE client_id=? AND created_by=?`, oldId, navBId).n, 1);
  // Intake says the same thing, with the same redacted offer.
  const create = await navB.post('/api/clients', person);
  assert.equal(create.status, 400);
  assert.equal(create.data.readmit.length, 1);
  assert.ok(!JSON.stringify(create.data).includes(oldCode) && !JSON.stringify(create.data).includes('incarcerated'));
});

test('every check is audited, with what was found and never what was asked', async () => {
  const n0 = db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='client.duplicate_check' AND username='ro_navB'`).n;
  await navB.post('/api/clients/check-duplicates', { last_name: 'Nomatch', phone: '555-999-1234' });
  const rows = db.all(`SELECT details FROM audit_log WHERE action='client.duplicate_check' AND username='ro_navB' ORDER BY rowid DESC`);
  assert.equal(rows.length, n0 + 1, 'a check with no match is audited too');
  assert.ok(!rows[0].details.includes('Nomatch') && !rows[0].details.includes('555-999'));
});

test('the live check is limited per worker', async () => {
  const { rateLimitReset } = require('../server/app');
  let limited = 0;
  for (let i = 0; i < 70; i++) { rateLimitReset('api:127.0.0.1'); const r = await navB.post('/api/clients/check-duplicates', { last_name: 'Walk', phone: `555-700-${String(1000 + i)}` }); if (r.status === 429) limited++; }
  assert.ok(limited > 0, 'a worker walking a list of numbers is stopped');
  assert.ok(db.one(`SELECT 1 FROM audit_log WHERE action='client.duplicate_check' AND username='ro_navB' AND success=0`), 'and the refusal is audited');
  // Another worker is not affected.
  assert.equal((await navA.post('/api/clients/check-duplicates', { last_name: 'Walk', phone: '555-700-0001' })).status, 200);
});

test('a supervisor (clients:all) still sees the earlier record in full', async () => {
  const chk = await sup.post('/api/clients/check-duplicates', { last_name: person.last_name, dob: person.dob });
  assert.equal(chk.status, 200);
  const m = chk.data.matches.find(x => x.id === oldId);
  assert.ok(m, 'shown as a match');
  assert.equal(m.client_code, oldCode);
  assert.equal(m.status, 'closed');
});
