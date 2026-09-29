'use strict';
// 1.16.1, the owner's decision: anyone who can see a client may update their record, and when the editor is not
// on the client's care team the primary worker is told -- a to-do (the bell) naming who changed which fields,
// field names only, never the values. A device's edit tells them the same way.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
const C = {}; const U = {};
let dec;
const notices = (clientId, to) => H.db.all(`SELECT * FROM tasks WHERE client_id=? AND assigned_to=? AND status='open'`, clientId, to)
  .map(t => ({ ...t, title: dec(t.title_enc), description: dec(t.description_enc) })).filter(t => t.description.includes('Reference: client record change'));

before(async () => {
  await H.start();
  require('../server/config').localModeEnabled = true;
  ({ decrypt: dec } = require('../server/crypto'));
  for (const [k, role] of [['primary', 'navigator'], ['other', 'navigator'], ['clin', 'clinician']]) {
    const u = H.makeUser(`ccn_${k}`, role); U[k] = u.id; C[k] = H.client(); await C[k].login(u.username, PW);
  }
});
after(() => H.stop());

test('an edit by someone off the care team tells the primary worker which fields, never the values', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Nova', last_name: 'Notice', phone: '916-555-0101' })).data.id;
  const r = await C.other.put(`/api/clients/${id}`, { phone: '916-555-0199', risk_level: 'high' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const n = notices(id, U.primary);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /ccn_other changed .*record \(Phone, Risk level\)/, 'the client form\'s labels');
  assert.ok(!n[0].title.includes('0199') && !n[0].description.includes('0199') && !n[0].description.includes('high'), 'no values');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(n[0].title + n[0].description), 'no user id in its text (1.16.2)');
  assert.equal(n[0].created_by, U.primary, 'the primary worker\'s own');
  // Not overdue work (1.16.2): no due date; the bell lists it as a notice, first, and nothing counts it as overdue.
  assert.equal(n[0].due_at, null);
  const bell = (await C.primary.get('/api/tasks/due?within=60')).data;
  assert.equal(bell.rows[0].id, n[0].id); assert.equal(bell.rows[0].notice, true); assert.equal(bell.rows[0].overdue, false);
  assert.equal(bell.overdue, 0); assert.equal(bell.notices, 1);
  assert.ok(!(await C.primary.get('/api/tasks?overdue=1')).data.rows.some(t => t.id === n[0].id));
  const listed = (await C.primary.get(`/api/tasks?client_id=${id}`)).data.rows.find(t => t.id === n[0].id);
  assert.equal(listed.notice, true, 'the UI can tell a notice (a read-only card)');
  const rec = (await C.primary.get(`/api/clients/${id}`)).data;
  assert.equal((rec.client || rec).counts.notices, 1);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='client.change_notice' AND entity_id=? ORDER BY id DESC`, id);
  assert.deepEqual(JSON.parse(a.details).fields, ['phone', 'risk_level']);
  // A second edit the same day adds to the same to-do.
  await C.other.put(`/api/clients/${id}`, { status: 'inactive' });
  const again = notices(id, U.primary);
  assert.equal(again.length, 1); assert.match(again[0].title, /Phone, Risk level, Status/);
  // A field with its own label on the form.
  await C.other.put(`/api/clients/${id}`, { asam_level: '1.0' });
  assert.match(notices(id, U.primary)[0].title, /ASAM level of care\)/);
});

test('the care team\'s own edits, and an edit that changes nothing, raise no notice', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Quiet', last_name: 'Notice' })).data.id;
  await C.primary.put(`/api/clients/${id}`, { phone: '916-555-0102' });
  assert.equal(notices(id, U.primary).length, 0);
  await C.other.put(`/api/clients/${id}`, { phone: '916-555-0102' });
  assert.equal(notices(id, U.primary).length, 0, 'the same value is no change');
});

test('a device\'s edit tells the primary worker the same way', async () => {
  const id = (await C.primary.post('/api/clients', { first_name: 'Sync', last_name: 'Notice', phone: '916-555-0103' })).data.id;
  const row = H.db.one(`SELECT * FROM clients WHERE id=?`, id);
  const res = await C.clin.post('/api/sync/push', { device_now: new Date().toISOString(), tables: { clients: [{ id, client_code: row.client_code, first_name_enc: 'Sync', last_name_enc: 'Notice', phone_enc: '916-555-0177', status: row.status, updated_at: new Date(Date.now() + 5000).toISOString() }] } });
  assert.deepEqual(res.data.rejected, []);
  const n = notices(id, U.primary);
  assert.equal(n.length, 1); assert.match(n[0].title, /ccn_clin changed .*\(Phone\)/);
});
