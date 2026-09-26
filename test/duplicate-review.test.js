'use strict';
// Security review of 1.12.4, 8(c): the intake duplicate check told a caseload-restricted worker how many
// records outside their caseload matched ("hidden_duplicates: 1") and refused the intake — a way to learn
// whether a named person with a given birth date is a client of the programme. The check is kept (two
// records for one person is a safety problem), but it no longer answers differently: a match the worker
// cannot see is sent to a supervisor as a review task on the existing record, and the worker's intake goes
// ahead exactly as it would with no match. (A visible match is still shown, and a discharged record is still
// offered for re-admission to someone who gives the person's name and date of birth — test/readmit.test.js.)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const { decrypt } = require('../server/crypto');

let nav, nav2, sup, navId, theirs;
before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  navId = H.makeUser('drnav', 'navigator').id; H.makeUser('drnav2', 'navigator'); H.makeUser('drsup', 'supervisor');
  nav = H.client(); await nav.login('drnav', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('drnav2', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('drsup', 'StaffPassw0rd!x');
  theirs = (await nav2.post('/api/clients', { first_name: 'Hidden', last_name: 'Match', dob: '1980-02-02' })).data.id;
});
after(() => H.stop());

const shape = (o) => JSON.stringify(Object.keys(o).sort());

test('the live check answers the same for a client on another caseload as for nobody', async () => {
  const hidden = await nav.post('/api/clients/check-duplicates', { first_name: 'Hidden', last_name: 'Match', dob: '1980-02-02' });
  const nobody = await nav.post('/api/clients/check-duplicates', { first_name: 'Nobody', last_name: 'Atall', dob: '1980-02-02' });
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.data, nobody.data);
  assert.ok(!('hidden_duplicates' in hidden.data));
});

test('intake of a person who is a client elsewhere goes ahead like any other, and a supervisor is asked to compare', async () => {
  const theirCode = H.db.one(`SELECT client_code FROM clients WHERE id=?`, theirs).client_code;
  const r = await nav.post('/api/clients', { first_name: 'Hidden', last_name: 'Match', dob: '1980-02-02' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const plain = await nav.post('/api/clients', { first_name: 'Plain', last_name: 'Newperson', dob: '1981-03-03' });
  assert.equal(shape(r.data), shape(plain.data), 'the same answer as an intake with no match');
  assert.ok(!JSON.stringify(r.data).includes(theirCode));
  // The review task sits on the existing record, which the worker cannot open, so they never see it.
  const task = H.db.one(`SELECT * FROM tasks WHERE client_id=? AND priority='high'`, theirs);
  assert.ok(task, 'a review task for a supervisor');
  assert.equal(task.assigned_to, null);
  const title = decrypt(task.title_enc);
  assert.match(title, /Possible duplicate record/); assert.ok(title.includes(theirCode) && title.includes(r.data.client_code));
  assert.ok(!JSON.stringify((await nav.get('/api/tasks?status=all&limit=1000')).data).includes(theirCode), 'the worker\'s task list does not show it');
  assert.ok(JSON.stringify((await sup.get('/api/tasks?status=all&limit=1000')).data).includes(theirCode), 'a supervisor\'s does');
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.possible_duplicate' AND entity_id=?`, r.data.id);
  assert.ok(a && JSON.parse(a.details).source === 'intake' && !a.details.includes('Hidden'), 'audited by code, never by name');
});

test('a visible match is still shown, and confirming it still flags any match the worker cannot see', async () => {
  const mine = (await nav.post('/api/clients', { first_name: 'Shown', last_name: 'Twin', dob: '1970-07-07' })).data.id;
  const r = await nav.post('/api/clients', { first_name: 'Shown', last_name: 'Twin', dob: '1970-07-07' });
  assert.equal(r.status, 400);
  assert.ok(r.data.duplicates.some(d => d.id === mine));
  assert.ok(!('hidden_duplicates' in r.data));
});

test('a device\'s new client that matches someone off the caseload is flagged without naming that record to the device', async () => {
  const theirCode = H.db.one(`SELECT client_code FROM clients WHERE id=?`, theirs).client_code;
  const id = require('node:crypto').randomUUID(); const now = new Date().toISOString();
  const r = await nav.post('/api/sync/push', { device_now: now, tables: { clients: [{ id, client_code: 'M26-0777', first_name_enc: 'Hidden', last_name_enc: 'Match', dob_enc: '1980-02-02', status: 'active', created_at: now, updated_at: now }] } });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data).includes(theirCode), 'the warning does not name a record the worker cannot open');
  assert.ok(H.db.one(`SELECT 1 FROM audit_log WHERE action='client.possible_duplicate' AND entity_id=?`, id));
});
