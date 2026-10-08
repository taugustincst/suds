'use strict';
// 1.25.2: the clinical, supervision and CalOMS findings of the role review of 1.25.1 (CS3, CS10-CS13, CS15, CS8) and
// the front-line tester's overdose finding (FL2), at the API and in the modules behind it. The browser halves are in
// scripts/ui/caloms.mjs and clinical-audit.mjs.
const LD = require('../server/local-date');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID: uuid } = require('node:crypto');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const U = {}; const C = {};
const today = () => LD.today();
const day = (n) => LD.addDays(LD.today(), n);
let enc;

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ encrypt: enc } = require('../server/crypto'));
  for (const [k, role] of [['sup', 'supervisor'], ['maria', 'navigator'], ['david', 'navigator'], ['clin', 'clinician']]) {
    const u = H.makeUser(`c1252_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
});
after(() => H.stop());

function client() {
  const id = uuid();
  H.db.run(`INSERT INTO clients(id,client_code,first_name_enc,last_name_enc,status,intake_date,created_by) VALUES(?,?,?,?,?,?,?)`, id, 'C1252-' + id.slice(0, 6), enc('Pat'), enc('Transfer'), 'active', day(-30), U.sup);
  return id;
}
function assign(clientId, who, role, { start = day(-30), endedToday = false } = {}) {
  const id = uuid();
  H.db.run(`INSERT INTO assignments(id,client_id,user_id,role_on_case,start_date,end_date,ended_at,created_by) VALUES(?,?,?,?,?,?,?,?)`, id, clientId, U[who], role, start,
    endedToday ? today() : null, endedToday ? new Date(Date.now() - 60000).toISOString() : null, U.sup);
  return id;
}
const active = (clientId, who) => H.db.all(`SELECT * FROM assignments WHERE client_id=? AND user_id=? AND (end_date IS NULL OR end_date >= ?) AND (ended_at IS NULL OR ended_at > ?)`, clientId, U[who], today(), new Date().toISOString());
const transfer = (clientId, extra = {}) => C.sup.post('/api/caseload/transfer', { from_user_id: U.maria, to_user_id: U.david, client_ids: [clientId], effective_date: today(), ...extra });

// ---- CS3: a caseload transfer never leaves a client with nobody ----
test('CS3: a receiving worker whose assignment was ended earlier today gets the client', async () => {
  const c = client(); const m = assign(c, 'maria', 'primary'); assign(c, 'david', 'secondary', { endedToday: true });
  const r = await transfer(c);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.transferred, 1, 'moved, not "already assigned"'); assert.deepEqual(r.data.skipped, []);
  const now = active(c, 'david');
  assert.equal(now.length, 1, 'David is on the care team'); assert.equal(now[0].role_on_case, 'primary');
  const old = H.db.one(`SELECT start_date, end_date FROM assignments WHERE id=?`, m);
  assert.ok(old.end_date >= old.start_date, `Maria's end date (${old.end_date}) is not before her start (${old.start_date})`);
});

test('CS3: a receiving worker who holds the client as secondary takes over as primary', async () => {
  const c = client(); assign(c, 'maria', 'primary'); const d = assign(c, 'david', 'secondary');
  const r = await transfer(c);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.transferred, 0); assert.equal(r.data.skipped.length, 1); assert.equal(r.data.skipped[0].promoted, true);
  assert.equal(H.db.one(`SELECT role_on_case FROM assignments WHERE id=?`, d).role_on_case, 'primary', 'the client keeps a primary worker');
  assert.equal(active(c, 'maria').length, 0, 'Maria is released');
});

test('CS3: an assignment that started on the effective date ends there and then, never the day before it began', async () => {
  const c = client(); const m = assign(c, 'maria', 'primary', { start: today() });
  const r = await transfer(c);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.transferred, 1);
  const old = H.db.one(`SELECT start_date, end_date, ended_at FROM assignments WHERE id=?`, m);
  assert.equal(old.end_date, old.start_date); assert.ok(old.ended_at, 'ended at once');
  assert.equal(active(c, 'maria').length, 0); assert.equal(active(c, 'david').length, 1);
});

// ---- CalOMS: CS10, CS11, CS12, CS13 ----
test('CS10: a transfer or a move suggests no CalOMS discharge status', () => {
  const S = require('../server/caloms-spec');
  assert.equal(S.FROM_SUDS.discharge_reason.transferred, undefined);
  assert.equal(S.FROM_SUDS.discharge_reason.moved, undefined);
  assert.equal(S.FROM_SUDS.discharge_reason.completed, '1', 'the others are unchanged');
});

test('CS11: a Narcotic Treatment Program admission with medication None is a warning, never a refusal', () => {
  const Cal = require('../server/caloms');
  const rec = (medication) => ({ record_type: 'admission', provider_id: '123456', record_date: today(), answers: { service_type: '7', medication } });
  const issues = Cal.check(rec('1'), { dob: '1990-01-01', providers: ['123456'], today: today() });
  const w = issues.find(i => i.code === 'ntp_medication_none');
  assert.ok(w && w.severity === 'warning' && w.field === 'medication', JSON.stringify(w));
  assert.ok(!Cal.check(rec('2'), { dob: '1990-01-01', providers: ['123456'], today: today() }).some(i => i.code === 'ntp_medication_none'), 'methadone: no warning');
});

test('CS12: employment status 4 and 5 are told apart by the help, the labels stay the dictionary\'s', () => {
  const S = require('../server/caloms-spec');
  assert.match(S.FIELD.employment_status.help, /4: out of work and not looking/);
  assert.match(S.FIELD.employment_status.help, /5: not in the labor force at all .*retired/);
  assert.equal(S.SETS.EMPLOYMENT.find(c => c.code === '5').label, 'Not in the labor force (Not seeking)');
});

test('CS13: a plain CSV has no byte-order mark and no formula guard; every other export keeps both', () => {
  const S = require('../server/spreadsheet');
  const cols = [{ key: 'n', label: 'ClientLastName' }];
  const plain = S.toCsv([{ n: '-Smith' }, { n: '@Home, Inc' }], cols, { plain: true });
  assert.equal(plain, 'ClientLastName\r\n-Smith\r\n"@Home, Inc"');
  const guarded = S.toCsv([{ n: '-Smith' }], cols);
  assert.ok(guarded.startsWith('﻿')); assert.match(guarded, /"'-Smith"/);
});

// ---- CS15: OneNote with no Microsoft Graph set up ----
test('CS15: the shared OneNote notebook answers 409 with what to do when Microsoft Graph is not set up', async () => {
  for (const [method, path, body] of [['get', '/api/imports/onenote/notebooks'], ['get', '/api/imports/onenote/sections/x/pages'], ['post', '/api/imports/onenote/fetch', { page_ids: ['p1'] }]]) {
    const r = await C.sup[method](path, body);
    assert.equal(r.status, 409, `${path}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, /not set up on this server.*Ask your administrator/);
  }
  assert.equal((await C.maria.get('/api/imports/onenote/notebooks')).status, 403, 'the shared notebook stays for supervisors and administrators');
});

// ---- CS8: a clinician reports a privacy concern through an existing route ----
test('CS8: a clinician, who may not open the incident register, can give a supervisor a to-do about a concern', async () => {
  assert.equal((await C.clin.post('/api/incidents', { title: 'x', discovered_at: today() })).status, 403);
  const r = await C.clin.post('/api/tasks', { title: 'Privacy concern reported: look into it and record it in the incident register', description: 'Fax sent to the wrong number.', assigned_to: U.sup, priority: 'high', due_at: today() });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = H.db.one(`SELECT * FROM tasks WHERE id=?`, r.data.id);
  assert.equal(t.assigned_to, U.sup); assert.equal(t.priority, 'high');
  assert.doesNotMatch(t.description_enc, /Fax/, 'the details are stored encrypted');
});

// ---- FL2: an overdose record cannot contradict itself ----
test('FL2: REST refuses an overdose "with no naloxone given" that gives naloxone; the kind decides a reversal and a death', async () => {
  const at = new Date().toISOString();
  for (const extra of [{ naloxone_used: true }, { naloxone_doses: 2 }]) {
    const r = await C.maria.post('/api/overdose-events', { occurred_at: at, kind: 'overdose', ...extra });
    assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, /Naloxone was given, so this is/);
  }
  assert.equal((await C.maria.post('/api/overdose-events', { occurred_at: at, kind: 'overdose', naloxone_used: false })).status, 201, 'an overdose with none is fine');
  const rev = await C.maria.post('/api/overdose-events', { occurred_at: at, kind: 'reversal', naloxone_used: false });
  assert.equal(rev.status, 201); assert.equal(H.db.one(`SELECT naloxone_used FROM overdose_events WHERE id=?`, rev.data.id).naloxone_used, 1);
  const fatal = await C.maria.post('/api/overdose-events', { occurred_at: at, kind: 'fatal', survived: true });
  assert.equal(fatal.status, 201); assert.equal(H.db.one(`SELECT survived FROM overdose_events WHERE id=?`, fatal.data.id).survived, 0);
  // An old record is not refused for an edit that leaves those answers alone.
  const old = uuid();
  H.db.run(`INSERT INTO overdose_events(id,occurred_at,kind,naloxone_used,reported_by) VALUES(?,?,?,?,?)`, old, at, 'overdose', 1, U.maria);
  assert.equal((await C.maria.put(`/api/overdose-events/${old}`, { city: 'Fresno' })).status, 200);
});

test('FL2: a device\'s push follows the same rule: the kind decides, and a contradiction lands flagged for review', async () => {
  const at = new Date().toISOString(); const ids = [uuid(), uuid(), uuid()];
  const row = (id, kind, extra) => ({ id, occurred_at: at, kind, reported_by: U.david, naloxone_used: 0, survived: 1, updated_at: at, ...extra });
  const r = await C.david.post('/api/sync/push', { device_now: at, tables: { overdose_events: [row(ids[0], 'reversal'), row(ids[1], 'fatal'), row(ids[2], 'overdose', { naloxone_used: 1 })] } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.rejected, []);
  assert.equal(H.db.one(`SELECT naloxone_used FROM overdose_events WHERE id=?`, ids[0]).naloxone_used, 1, 'a reversal gave naloxone');
  assert.equal(H.db.one(`SELECT survived FROM overdose_events WHERE id=?`, ids[1]).survived, 0, 'a fatal overdose was not survived');
  assert.ok(H.db.one(`SELECT 1 FROM overdose_events WHERE id=?`, ids[2]), 'the offline record is kept');
  const w = (r.data.warnings || []).find(x => x.id === ids[2]);
  assert.ok(w && w.flagged && /naloxone was given/.test(w.reason), `the device is told: ${JSON.stringify(r.data.warnings)}`);
});
